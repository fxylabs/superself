import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAttemptId } from "../ids.js";
import { runnerStateDir } from "../machine.js";
import { buildModel } from "../model.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { CliContext } from "../paths.js";
import { withLock, writeAtomic } from "./atomic.js";
import { boundaryCommand, identityOf } from "./boundary.js";
import { classify, FailureClass, FailureSignal, fromDeclaration, isTransient } from "./classify.js";
import { deliverDirectives, inboxPath } from "./directive.js";
import { alreadyCompleted, alreadyReported, attachReport, publishArtifacts, Published, ResultEnvelope, unpublish, validatePublished, verifyDeclarations } from "./gate.js";
import { CliError } from "../types.js";
import { AttemptPlan, policyDigest } from "./plan.js";
import { adapterOf, approvalRequest, boundaryDrift, PreflightCheck, PreflightReceipt, runPreflight } from "./preflight.js";
import { MIN_LITERAL, redact, scopeFor, unredactableSecrets } from "./redact.js";
import { admitAttempt, backoffFor, recordProviderFailure, recordProviderSuccess, sleep } from "./retry.js";
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
// from the one that owns the attempt — Spool.setStatus compares it, and
// recovery takes an attempt over by minting a newer one.
//
// Minting is read-modify-write, and running several attempts at once on one
// machine is the designed operating mode, so it is done under a lock: two
// runners reading the same value would mint the same fence and neither could
// then be told from the other.
export function nextFence(): number
{
    const file = join(runnerStateDir(), "fence.json");
    return withLock(file, () =>
    {
        const fence = currentFence(file) + 1;
        writeAtomic(file, JSON.stringify({ fence }) + "\n");
        return fence;
    });
}

function currentFence(file: string): number
{
    if (!existsSync(file))
    {
        return 0;
    }
    try
    {
        const held = Number(JSON.parse(readFileSync(file, "utf8")).fence);
        return Number.isFinite(held) ? held : 0;
    }
    catch
    {
        return 0;
    }
}

export async function runAttempt(ctx: ProjectContext, plan: AttemptPlan, options: RunOptions): Promise<AttemptResult>
{
    const id = runAttemptId();
    const scope = scopeFor(plan.capabilities.secrets);
    const spool = new Spool(createSpool(id), scope);
    const identity = identityOf(plan.boundary);
    const fence = nextFence();
    spool.claim(fence);
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
        pid: process.pid,
        provider: plan.capabilities.provider?.name,
        created: options.now.toISOString(),
        updated: options.now.toISOString()
    } satisfies AttemptStatus);
    warnUnredactable(spool, plan);

    // The liveness markers cover preflight too. A probe may legitimately take
    // as long as the preflight bound allows, and recovery reads a missing pid
    // or a missing heartbeat as a dead runner: without this, `self attempt
    // recover` run in that window declares a healthy attempt dead and writes a
    // run.failed it never suffered into the synced, append-only log.
    const heart = beat(spool, plan.heartbeatMs);
    let gated: AttemptResult | null;
    try
    {
        gated = await gateBeforeSpend(ctx, plan, spool, id, fence, identity, options);
    }
    finally
    {
        heart.stop();
    }
    if (gated !== null)
    {
        return gated;
    }
    return await driveRuns(ctx, plan, spool, id, options);
}

// A declared secret too short to be redacted by value is a coverage gap the
// plan author cannot see: the declaration was accepted and does nothing. Only
// the names are named — the values are what this exists to keep out of sight.
function warnUnredactable(spool: Spool, plan: AttemptPlan): void
{
    const names = unredactableSecrets(plan.capabilities.secrets);
    if (names.length === 0)
    {
        return;
    }
    spool.append("events.jsonl", { event: "redaction.uncovered", secrets: names });
    console.error(`declared secret ${names.join(", ")} is shorter than ${MIN_LITERAL} characters and is not redacted by value — only the named patterns cover it`);
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
    if (provider !== undefined && admitAttempt(provider, BREAKER_DEFAULT, options.now, id) === "open")
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
    declared?: boolean;
    timedOut?: boolean;
    backoffMs?: number;
    backoffCapMs?: number;
    backoffJitter?: number;
    resumed?: boolean;
}

// How many runs in a row may be retried on a transient class the agent
// declared and nothing the runner observed supports. One is a claim worth a
// second look; a run of them is the child choosing its own retry budget out of
// a policy that allows up to twenty.
const UNSUPPORTED_TRANSIENT_RUNS = 2;

async function driveRuns(ctx: ProjectContext, plan: AttemptPlan, spool: Spool, id: string, options: RunOptions): Promise<AttemptResult>
{
    const provider = plan.capabilities.provider?.name;
    recordAttemptEvent(ctx, plan, "run.started", id, { role: plan.role, provider, adapter: adapterOf(plan.boundary) });
    let last: { failure: FailureClass; detail: string; observed: boolean } = { failure: "unknown", detail: "no run was made", observed: true };
    let unsupported = 0;
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
        unsupported = outcome.declaredOnly && isTransient(outcome.failure) ? unsupported + 1 : 0;
        const exhausted = unsupported >= UNSUPPORTED_TRANSIENT_RUNS;
        last = {
            failure: outcome.failure,
            detail: exhausted
                ? `${outcome.detail} — the agent declared a transient failure ${unsupported} runs in a row and nothing the runner observed supports it`
                : outcome.detail,
            observed: !outcome.declaredOnly
        };
        const record: RunRecord = {
            run,
            started: outcome.started,
            ended: new Date().toISOString(),
            exit: outcome.exit,
            signal: outcome.signal,
            failure: outcome.failure,
            declared: outcome.declaredOnly,
            timedOut: outcome.timedOut,
            resumed: outcome.resumed
        };
        if (!isTransient(outcome.failure) || run === plan.retry.maxRuns || exhausted)
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
    return failAttempt(ctx, plan, spool, id, last.failure, last.detail, last.observed, options);
}

function failAttempt(ctx: ProjectContext, plan: AttemptPlan, spool: Spool, id: string, failure: FailureClass, detail: string, observed: boolean, options: RunOptions): AttemptResult
{
    const provider = plan.capabilities.provider?.name;
    // A failure only the agent called transient is not evidence about the
    // provider, and must not push a breaker that gates unrelated queued work.
    if (provider !== undefined && isTransient(failure) && observed)
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
    // The class came from the agent's own declaration rather than from
    // anything the runner observed.
    declaredOnly: boolean;
    timedOut: boolean;
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
    const stdout = `run-${run}.stdout.log`;
    const stderr = `run-${run}.stderr.log`;
    spool.setStatus({ state: "running", run, runs: run, pid: process.pid });
    spool.heartbeat();
    spool.append("events.jsonl", { event: "run.started", run, resumed: resumeFrom !== null });
    clearRunOutput(spool);
    const env = childEnv(spool, id, run, resumeFrom);
    const command = boundaryCommand(plan.boundary, plan.command, env);
    // Its own process group, so a bound that expires or a cancel that arrives
    // reaches everything the launcher started and not only the wrapper in
    // front of it.
    const child = spawn(command.argv[0], command.argv.slice(1), { ...command.options, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const control = watch(spool, child, plan);
    const bound = boundRun(child, plan.runTimeoutMs);
    child.stdout?.on("data", (chunk) => guard(() => spool.appendRaw(stdout, String(chunk))));
    child.stderr?.on("data", (chunk) => guard(() => spool.appendRaw(stderr, String(chunk))));
    const exit = await waitFor(child);
    control.stop();
    bound.stop();
    // The streams are closed, so nothing can extend a redaction match any
    // further: the tail each one held back is written before anything reads
    // the files.
    spool.flushRaw(stdout);
    spool.flushRaw(stderr);
    const envelope = readEnvelope(spool);
    spool.append("events.jsonl", { event: "run.ended", run, exit: exit.code, signal: exit.signal, cancelled: control.cancelled(), timedOut: bound.timedOut() });
    return {
        ...verdictOf(exit, envelope, control.cancelled(), bound.timedOut(), plan, spool, run),
        timedOut: bound.timedOut(),
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
    timedOut: boolean,
    plan: AttemptPlan,
    spool: Spool,
    run: number
): { failure: FailureClass | null; detail: string; declaredOnly: boolean }
{
    if (cancelled)
    {
        return { failure: "cancelled", detail: "a durable cancel directive stopped this attempt", declaredOnly: false };
    }
    // A run the runner killed on its own bound never finished, whatever the
    // envelope it left behind says.
    if (!timedOut && exit.code === 0 && envelope !== null && envelope.status === "completed")
    {
        return { failure: null, detail: "", declaredOnly: false };
    }
    const stderr = tail(spool.path(`run-${run}.stderr.log`));
    const signal: FailureSignal = {
        declared: envelope?.failure?.class,
        exitCode: exit.code,
        signal: exit.signal,
        stderr,
        timedOut,
        spawnCode: exit.spawnError?.code
    };
    const detail = timedOut
        ? `the provider did not finish within the ${plan.runTimeoutMs}ms this attempt allows`
        : envelope?.failure?.message ?? exit.spawnError?.message ?? stderr.trim().split("\n").pop() ?? `exit ${exit.code}`;
    return { failure: classify(signal), detail: redact(detail.slice(0, 400)), declaredOnly: fromDeclaration(signal) };
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

// A rerun must not inherit the previous run's output: a stale file would
// satisfy the completion gate for work this run never did. The result envelope
// is the half that matters most — a plan that declares no artifact is
// completed by the envelope alone, so a run that produced nothing would
// otherwise publish the previous run's summary as its own report.
function clearRunOutput(spool: Spool): void
{
    rmSync(spool.path("result.json"), { force: true });
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
    const timer = setInterval(() => guard(() =>
    {
        spool.heartbeat();
        for (const directive of deliverDirectives(spool))
        {
            spool.append("events.jsonl", { event: "directive.delivered", directive: directive.id, kind: directive.kind });
            if (directive.kind === "cancel")
            {
                cancelled = true;
                killTree(child, "SIGTERM");
            }
        }
    }), plan.heartbeatMs);
    return {
        stop: () => clearInterval(timer),
        cancelled: () => cancelled
    };
}

// The heartbeat on its own, for the stretch before a child exists to watch.
function beat(spool: Spool, everyMs: number): { stop: () => void }
{
    guard(() => spool.heartbeat());
    const timer = setInterval(() => guard(() => spool.heartbeat()), everyMs);
    return { stop: () => clearInterval(timer) };
}

// A throw inside a timer or a stream callback is an uncaught exception: it
// kills the runner outright, orphans the provider it started, and leaves the
// spool saying `running` for a process that no longer exists. The rest of the
// runner turns I/O trouble into a typed failure, and these paths must not be
// the ones that turn it into process death. Nothing is written about it,
// because the filesystem that just failed is the only place to write it.
function guard(work: () => void): void
{
    try
    {
        work();
    }
    catch
    {
        return;
    }
}

interface Bound
{
    stop: () => void;
    timedOut: () => boolean;
}

// How long a provider that ignored SIGTERM may take to close what it was
// writing before it is killed outright.
const TERM_GRACE_MS = 2_000;

// The bound the plan declares, actually applied. Without it a hung provider
// holds the runner for ever: the heartbeat keeps being written, so recovery
// never touches it either, and no retry, no typed failure, and no release of
// the attempt ever happen.
function boundRun(child: ReturnType<typeof spawn>, timeoutMs: number): Bound
{
    let timedOut = false;
    let hard: NodeJS.Timeout | undefined;
    const timer = setTimeout(() =>
    {
        timedOut = true;
        killTree(child, "SIGTERM");
        hard = setTimeout(() => killTree(child, "SIGKILL"), TERM_GRACE_MS);
    }, timeoutMs);
    return {
        stop: () =>
        {
            clearTimeout(timer);
            if (hard !== undefined)
            {
                clearTimeout(hard);
            }
        },
        timedOut: () => timedOut
    };
}

// The child leads its own process group, so signalling the negated pid reaches
// everything the launcher started. A wrapper that exec'd its payload is one
// process and the group signal still finds it; a wrapper that forked one is
// two, and only the group signal finds both.
function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void
{
    const pid = child.pid;
    if (pid === undefined)
    {
        return;
    }
    try
    {
        process.kill(-pid, signal);
    }
    catch
    {
        child.kill(signal);
    }
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
    // Publication and the report are the two things this attempt cannot take
    // back, so ownership is checked once more before either of them.
    spool.assertOwned();
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
    // The completion is exactly-once here, where the report's idempotency
    // already lives, rather than in whichever caller reaches settlement twice.
    if (!alreadyCompleted(ctx, id))
    {
        recordAttemptEvent(ctx, plan, "run.completed", id, {
            artifacts: published.map((item) => ({ name: item.name, sha256: item.sha256, bytes: item.bytes })),
            reported
        });
    }
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
