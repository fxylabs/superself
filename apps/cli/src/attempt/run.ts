import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAttemptId } from "../ids.js";
import { runnerStateDir } from "../machine.js";
import { buildModel } from "../model.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { CliContext } from "../paths.js";
import { boundaryCommand, identityOf } from "./boundary.js";
import { classify, FailureClass, isTransient } from "./classify.js";
import { deliverDirectives, inboxPath } from "./directive.js";
import { alreadyReported, attachReport, publishArtifacts, Published, ResultEnvelope, unpublish, validatePublished, verifyDeclarations } from "./gate.js";
import { CliError } from "../types.js";
import { AttemptPlan, policyDigest } from "./plan.js";
import { adapterOf, approvalRequest, boundaryDrift, PreflightCheck, PreflightReceipt, runPreflight } from "./preflight.js";
import { redact, scopeFor } from "./redact.js";
import { backoffFor, breakerVerdict, recordProviderFailure, recordProviderSuccess, sleep } from "./retry.js";
import { AttemptStatus, createSpool, Spool } from "./spool.js";

type ProjectContext = CliContext & { project: string; projectDir: string };

export interface RunOptions
{
    now: Date;
}

export interface AttemptResult
{
    attempt: string;
    state: AttemptStatus["state"];
    failure?: FailureClass;
    detail?: string;
}

const BREAKER_DEFAULT = { threshold: 3, cooldownMs: 60_000 };

// A monotonic per-machine counter. It rides on every receipt and status so a
// stale runner that wakes up after a newer one took over can be told apart
// from the one that owns the attempt.
function nextFence(): number
{
    const file = join(runnerStateDir(), "fence.json");
    mkdirSync(runnerStateDir(), { recursive: true });
    const current = existsSync(file) ? Number(JSON.parse(readFileSync(file, "utf8")).fence) : 0;
    const fence = (Number.isFinite(current) ? current : 0) + 1;
    writeFileSync(file + ".tmp", JSON.stringify({ fence }) + "\n");
    renameSync(file + ".tmp", file);
    return fence;
}

export async function runAttempt(ctx: ProjectContext, plan: AttemptPlan, options: RunOptions): Promise<AttemptResult>
{
    const id = runAttemptId();
    const scope = scopeFor(plan.capabilities.secrets);
    const spool = new Spool(createSpool(id), scope);
    const identity = identityOf(plan.boundary);
    const fence = nextFence();
    writeBrief(spool, plan, id);
    // The normalized plan, kept beside the attempt so settlement after a crash
    // works from what this attempt was actually launched with rather than from
    // a plan file that may since have been edited.
    spool.writeJson("plan.json", plan);
    spool.writeJson("attempt.json", {
        attempt: id,
        work: plan.work,
        project: ctx.project,
        role: plan.role,
        adapter: adapterOf(plan.boundary),
        boundaryDigest: identity.digest,
        policyDigest: policyDigest(plan),
        command: plan.command,
        capabilities: plan.capabilities,
        artifacts: plan.artifacts,
        retry: plan.retry,
        created: options.now.toISOString()
    });
    spool.writeJson("status.json", {
        attempt: id,
        work: plan.work,
        project: ctx.project,
        role: plan.role,
        state: "preflight",
        run: 0,
        runs: 0,
        fence,
        nodeId: identity.nodeId,
        bootId: identity.bootId,
        provider: plan.capabilities.provider?.name,
        created: options.now.toISOString(),
        updated: options.now.toISOString()
    } satisfies AttemptStatus);

    const gated = await gateBeforeSpend(ctx, plan, spool, id, fence, identity, options);
    if (gated !== null)
    {
        return gated;
    }
    return await driveRuns(ctx, plan, spool, id, options);
}

// Everything that must be true before a single token is spent. Each exit from
// here leaves the work recoverable and the attempt count untouched.
async function gateBeforeSpend(
    ctx: ProjectContext,
    plan: AttemptPlan,
    spool: Spool,
    id: string,
    fence: number,
    identity: ReturnType<typeof identityOf>,
    options: RunOptions
): Promise<AttemptResult | null>
{
    const provider = plan.capabilities.provider?.name;
    if (provider !== undefined && breakerVerdict(provider, BREAKER_DEFAULT, options.now) === "open")
    {
        const detail = `the circuit breaker for provider "${provider}" is open — this work stays queued and no attempt was spent`;
        spool.setStatus({ state: "waiting-provider", failure: "transient-provider", detail });
        spool.append("events.jsonl", { event: "breaker.open", provider });
        console.log(detail);
        return { attempt: id, state: "waiting-provider", failure: "transient-provider", detail };
    }
    const receipt = await runPreflight(plan, id, fence, identity, localChecks(ctx, plan));
    spool.writeJson("preflight.json", receipt);
    if (!receipt.ok)
    {
        return blockOnCapability(ctx, plan, spool, id, receipt);
    }
    const drift = boundaryDrift(plan, receipt);
    if (drift === null)
    {
        return null;
    }
    spool.setStatus({ state: "preflight-failed", failure: "capability", detail: drift });
    spool.append("events.jsonl", { event: "boundary.drift", detail: drift });
    recordAttemptEvent(ctx, plan, "run.blocked", id, { failure: "capability", detail: drift });
    console.error(drift);
    return { attempt: id, state: "preflight-failed", failure: "capability", detail: drift };
}

function blockOnCapability(ctx: ProjectContext, plan: AttemptPlan, spool: Spool, id: string, receipt: PreflightReceipt): AttemptResult
{
    const request = approvalRequest(receipt);
    const missing = receipt.checks.filter((check) => !check.ok).map((check) => `${check.capability}:${check.target}`);
    spool.setStatus({ state: "preflight-failed", failure: "capability", detail: missing.join(", ") });
    spool.append("events.jsonl", { event: "preflight.failed", missing });
    writeFileSync(spool.path("approval-request.txt"), request + "\n");
    recordAttemptEvent(ctx, plan, "run.blocked", id, { failure: "capability", missing, request: redact(request) });
    console.log(request);
    return { attempt: id, state: "preflight-failed", failure: "capability", detail: missing.join(", ") };
}

// The checks that are about this workspace rather than about the boundary: no
// probe inside a sandbox can tell whether the work unit this attempt names
// exists, or whether anyone granted it a budget.
function localChecks(ctx: ProjectContext, plan: AttemptPlan): PreflightCheck[]
{
    const checks: PreflightCheck[] = [];
    if (plan.capabilities.context)
    {
        const work = buildModel(ctx.storeDir, ctx.project, new Date()).works.find((item) => item.id === plan.work);
        const ok = work !== undefined && work.status !== "done";
        checks.push({
            capability: "context",
            target: plan.work,
            ok,
            detail: work === undefined ? `no work unit "${plan.work}" in project ${ctx.project}` : work.status === "done" ? "already done" : work.outcome
        });
    }
    const budget = plan.capabilities.budgetUsd;
    if (budget !== undefined)
    {
        checks.push({ capability: "budget", target: `${budget} USD`, ok: budget > 0, detail: budget > 0 ? "granted" : "no budget granted" });
    }
    return checks;
}

// The immutable brief. Every run of this attempt — the first and every
// replacement — is handed this same file, so a retry is a new run against an
// unchanged contract rather than a quietly reworded second task.
function writeBrief(spool: Spool, plan: AttemptPlan, id: string): void
{
    const lines = [
        `# ${plan.work} — ${plan.role}`,
        "",
        plan.summary === "" ? "_no summary supplied_" : plan.summary,
        "",
        "## Declared artifacts",
        ""
    ];
    for (const artifact of plan.artifacts)
    {
        lines.push(`- ${artifact.name} → ${artifact.dest}`);
    }
    lines.push("", `Attempt: ${id}`, "");
    writeFileSync(spool.path("brief.md"), redact(lines.join("\n")));
}

interface RunRecord
{
    run: number;
    started: string;
    ended: string;
    exit: number | null;
    signal: string | null;
    failure?: FailureClass;
    backoffMs?: number;
    backoffCapMs?: number;
    backoffJitter?: number;
    resumed?: boolean;
}

async function driveRuns(ctx: ProjectContext, plan: AttemptPlan, spool: Spool, id: string, options: RunOptions): Promise<AttemptResult>
{
    const provider = plan.capabilities.provider?.name;
    recordAttemptEvent(ctx, plan, "run.started", id, { role: plan.role, provider, adapter: adapterOf(plan.boundary) });
    let last: { failure: FailureClass; detail: string } = { failure: "unknown", detail: "no run was made" };
    for (let run = 1; run <= plan.retry.maxRuns; run++)
    {
        const outcome = await executeRun(plan, spool, id, run);
        if (outcome.failure === null)
        {
            if (provider !== undefined)
            {
                recordProviderSuccess(provider);
            }
            return await completeAttempt(ctx, plan, spool, id, outcome.envelope);
        }
        last = { failure: outcome.failure, detail: outcome.detail };
        const record: RunRecord = {
            run,
            started: outcome.started,
            ended: new Date().toISOString(),
            exit: outcome.exit,
            signal: outcome.signal,
            failure: outcome.failure,
            resumed: outcome.resumed
        };
        if (!isTransient(outcome.failure) || run === plan.retry.maxRuns)
        {
            spool.append("runs.jsonl", record as unknown as Record<string, unknown>);
            break;
        }
        const backoff = backoffFor(run, plan.retry);
        Object.assign(record, { backoffMs: backoff.delayMs, backoffCapMs: backoff.capMs, backoffJitter: backoff.jitter });
        spool.append("runs.jsonl", record as unknown as Record<string, unknown>);
        spool.setStatus({ state: "retrying", run, runs: run, failure: outcome.failure, detail: outcome.detail });
        spool.append("events.jsonl", { event: "retry.scheduled", run, failure: outcome.failure, delayMs: backoff.delayMs, capMs: backoff.capMs });
        await sleep(backoff.delayMs);
    }
    return failAttempt(ctx, plan, spool, id, last.failure, last.detail, options);
}

function failAttempt(ctx: ProjectContext, plan: AttemptPlan, spool: Spool, id: string, failure: FailureClass, detail: string, options: RunOptions): AttemptResult
{
    const provider = plan.capabilities.provider?.name;
    if (provider !== undefined && isTransient(failure))
    {
        const record = recordProviderFailure(provider, BREAKER_DEFAULT, options.now);
        spool.append("events.jsonl", { event: "breaker.failure", provider, failures: record.failures, state: record.state });
    }
    const state = failure === "cancelled" ? "cancelled" : "failed";
    spool.setStatus({ state, failure, detail });
    recordAttemptEvent(ctx, plan, failure === "cancelled" ? "run.cancelled" : "run.failed", id, { failure, detail: redact(detail) });
    console.error(`attempt ${id} ${state}: ${failure} — ${detail}`);
    return { attempt: id, state, failure, detail };
}

interface RunOutcome
{
    failure: FailureClass | null;
    detail: string;
    exit: number | null;
    signal: string | null;
    started: string;
    resumed: boolean;
    envelope: ResultEnvelope | null;
}

// One provider invocation. Everything it emits is spooled as it arrives, so a
// result larger than any terminal will hold, or one cut off when the terminal
// went away, is still complete on disk.
async function executeRun(plan: AttemptPlan, spool: Spool, id: string, run: number): Promise<RunOutcome>
{
    const started = new Date().toISOString();
    const resumeFrom = plan.resume ? lastCheckpoint(spool) : null;
    spool.setStatus({ state: "running", run, runs: run, pid: process.pid });
    spool.heartbeat();
    spool.append("events.jsonl", { event: "run.started", run, resumed: resumeFrom !== null });
    // A rerun must not inherit the previous run's staged output: a stale file
    // would satisfy the completion gate for work this run never did.
    clearStaged(spool);
    const env = childEnv(spool, id, run, resumeFrom);
    const command = boundaryCommand(plan.boundary, plan.command, env);
    const child = spawn(command.argv[0], command.argv.slice(1), { ...command.options, stdio: ["ignore", "pipe", "pipe"] });
    const control = watch(spool, child, plan);
    child.stdout?.on("data", (chunk) => spool.appendRaw(`run-${run}.stdout.log`, String(chunk)));
    child.stderr?.on("data", (chunk) => spool.appendRaw(`run-${run}.stderr.log`, String(chunk)));
    const exit = await waitFor(child);
    control.stop();
    const envelope = readEnvelope(spool);
    spool.append("events.jsonl", { event: "run.ended", run, exit: exit.code, signal: exit.signal, cancelled: control.cancelled() });
    return {
        ...verdictOf(exit, envelope, control.cancelled(), spool, run),
        exit: exit.code,
        signal: exit.signal,
        started,
        resumed: resumeFrom !== null,
        envelope
    };
}

function verdictOf(
    exit: { code: number | null; signal: NodeJS.Signals | null; spawnError?: NodeJS.ErrnoException },
    envelope: ResultEnvelope | null,
    cancelled: boolean,
    spool: Spool,
    run: number
): { failure: FailureClass | null; detail: string }
{
    if (cancelled)
    {
        return { failure: "cancelled", detail: "a durable cancel directive stopped this attempt" };
    }
    if (exit.code === 0 && envelope !== null && envelope.status === "completed")
    {
        return { failure: null, detail: "" };
    }
    const stderr = tail(spool.path(`run-${run}.stderr.log`));
    const failure = classify({
        declared: envelope?.failure?.class,
        exitCode: exit.code,
        signal: exit.signal,
        stderr,
        timedOut: false,
        spawnCode: exit.spawnError?.code
    });
    const detail = envelope?.failure?.message ?? exit.spawnError?.message ?? stderr.trim().split("\n").pop() ?? `exit ${exit.code}`;
    return { failure, detail: redact(detail.slice(0, 400)) };
}

function childEnv(spool: Spool, id: string, run: number, resumeFrom: string | null): Record<string, string>
{
    const env: Record<string, string> = {
        SUPERSELF_ATTEMPT_ID: id,
        SUPERSELF_ATTEMPT_RUN: String(run),
        SUPERSELF_ATTEMPT_DIR: spool.dir,
        SUPERSELF_ATTEMPT_BRIEF: spool.path("brief.md"),
        SUPERSELF_ATTEMPT_OUT: spool.path("out"),
        SUPERSELF_ATTEMPT_RESULT: spool.path("result.json"),
        SUPERSELF_ATTEMPT_INBOX: inboxPath(spool),
        SUPERSELF_ATTEMPT_CHECKPOINTS: spool.path("checkpoints.jsonl"),
        SUPERSELF_ATTEMPT_TOOLS: spool.path("tools.jsonl"),
        SUPERSELF_ATTEMPT_EVIDENCE: spool.path("evidence.json")
    };
    if (resumeFrom !== null)
    {
        env.SUPERSELF_ATTEMPT_RESUME = resumeFrom;
    }
    return env;
}

// Where a replacement run picks up. When the provider left a checkpoint and
// the plan allows resuming, the run continues from it; otherwise it starts
// clean against the same brief, with the sanitized evidence earlier runs
// accumulated still in the spool beside it.
function lastCheckpoint(spool: Spool): string | null
{
    const checkpoints = spool.readLines<Record<string, unknown>>("checkpoints.jsonl");
    if (checkpoints.length === 0)
    {
        return null;
    }
    spool.writeJson("resume.json", checkpoints[checkpoints.length - 1]);
    return spool.path("resume.json");
}

function clearStaged(spool: Spool): void
{
    const out = spool.path("out");
    for (const entry of existsSync(out) ? readdirSync(out) : [])
    {
        rmSync(join(out, entry), { recursive: true, force: true });
    }
}

interface Control
{
    stop: () => void;
    cancelled: () => boolean;
}

// The runner's own heartbeat, and the only delivery path for directives.
// Because the runner writes the heartbeat, a runner that dies leaves it stale,
// which is exactly what recovery needs to see.
function watch(spool: Spool, child: ReturnType<typeof spawn>, plan: AttemptPlan): Control
{
    let cancelled = false;
    const timer = setInterval(() =>
    {
        spool.heartbeat();
        for (const directive of deliverDirectives(spool))
        {
            spool.append("events.jsonl", { event: "directive.delivered", directive: directive.id, kind: directive.kind });
            if (directive.kind === "cancel")
            {
                cancelled = true;
                child.kill("SIGTERM");
            }
        }
    }, plan.heartbeatMs);
    return {
        stop: () => clearInterval(timer),
        cancelled: () => cancelled
    };
}

function waitFor(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: NodeJS.ErrnoException }>
{
    return new Promise((resolve) =>
    {
        child.on("error", (error) => resolve({ code: null, signal: null, spawnError: error as NodeJS.ErrnoException }));
        child.on("close", (code, signal) => resolve({ code, signal }));
    });
}

function readEnvelope(spool: Spool): ResultEnvelope | null
{
    return spool.readJson<ResultEnvelope>("result.json");
}

function tail(file: string, limit = 4_000): string
{
    if (!existsSync(file))
    {
        return "";
    }
    const text = readFileSync(file, "utf8");
    return text.length <= limit ? text : text.slice(-limit);
}

// The last gate. Publication, verification, and the record all have to hold
// before this attempt is allowed to say it produced anything.
async function completeAttempt(ctx: ProjectContext, plan: AttemptPlan, spool: Spool, id: string, envelope: ResultEnvelope | null): Promise<AttemptResult>
{
    const declared = verifyDeclarations(plan, spool, envelope);
    if (declared !== null)
    {
        return gateFailed(ctx, plan, spool, id, declared.reason);
    }
    const { published, failure } = publishArtifacts(plan, spool, id);
    if (failure !== null)
    {
        unpublish(published);
        return gateFailed(ctx, plan, spool, id, failure.reason);
    }
    const invalid = await validatePublished(plan, published);
    if (invalid !== null)
    {
        unpublish(published);
        return gateFailed(ctx, plan, spool, id, invalid.reason);
    }
    return recordCompletion(ctx, plan, spool, id, envelope as ResultEnvelope, published);
}

function recordCompletion(ctx: ProjectContext, plan: AttemptPlan, spool: Spool, id: string, envelope: ResultEnvelope, published: Published[]): AttemptResult
{
    let reported: boolean;
    try
    {
        reported = attachReport(ctx, plan, id, envelope, published);
    }
    catch (error)
    {
        unpublish(published);
        return gateFailed(ctx, plan, spool, id, `the result could not be attached to self: ${(error as Error).message}`);
    }
    spool.writeJson("published.json", published);
    spool.setStatus({ state: "completed", failure: undefined, detail: undefined });
    spool.append("events.jsonl", { event: "run.completed", published: published.map((item) => item.name), reported });
    recordAttemptEvent(ctx, plan, "run.completed", id, {
        artifacts: published.map((item) => ({ name: item.name, sha256: item.sha256, bytes: item.bytes })),
        reported
    });
    console.log(`attempt ${id} completed — ${published.length} artifact(s) published, report ${reported ? "attached" : "already attached"}`);
    return { attempt: id, state: "completed" };
}

function gateFailed(ctx: ProjectContext, plan: AttemptPlan, spool: Spool, id: string, reason: string): AttemptResult
{
    const detail = redact(reason);
    spool.setStatus({ state: "failed", failure: "validation", detail });
    spool.append("events.jsonl", { event: "gate.failed", detail });
    recordAttemptEvent(ctx, plan, "run.failed", id, { failure: "validation", detail });
    console.error(`attempt ${id} failed the completion gate: ${detail}`);
    return { attempt: id, state: "failed", failure: "validation", detail };
}

// A crash between publishing an artifact and recording the report leaves a
// verified result nobody knows about. Settlement finishes that attempt from
// its own spool, and finds its own report already in the log when it was in
// fact recorded — so running it twice records nothing twice.
export function settleAttempt(ctx: ProjectContext, spool: Spool): AttemptResult
{
    const status = spool.status();
    const plan = spool.readJson<AttemptPlan>("plan.json");
    const envelope = spool.readJson<ResultEnvelope>("result.json");
    const published = spool.readJson<Published[]>("published.json");
    if (status === null || plan === null || envelope === null || published === null)
    {
        throw new CliError("this attempt has no verified result to settle — only an attempt that published and verified its artifacts can be settled");
    }
    if (alreadyReported(ctx, status.attempt))
    {
        console.log(`attempt ${status.attempt} is already attached to ${plan.work} — nothing to record`);
        return { attempt: status.attempt, state: "completed" };
    }
    return recordCompletion(ctx, plan, spool, status.attempt, envelope, published);
}

// Only state transitions, hashes, failure classes and sanitized summaries
// travel into the synced log. The raw output that produced them stays in the
// machine-local spool.
export function recordAttemptEvent(ctx: ProjectContext, plan: AttemptPlan, type: string, id: string, payload: Record<string, unknown>): void
{
    recordEvent(
        ctx,
        makeEvent(ctx.project, type, { attempt: id, ...payload }, { work: plan.work, attempt: id }),
        `${plan.work} ${type.replace("run.", "")}`
    );
}
