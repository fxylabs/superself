import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { buildModel } from "../model.js";
import { CliContext, resolveProjectPath } from "../paths.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { EventRefs } from "../types.js";
import {
    AttemptRecord,
    circuitKey,
    circuitOpen,
    foldAttempts,
    heldLeases,
    patchAttempt
} from "./attempt.js";
import { decideCapabilities, forbiddenAction, sanitizedEnv } from "./capability.js";
import { advanceCursor, ensureSubscription, pendingSignals } from "./cursor.js";
import { generation, withStoreLock } from "./lock.js";
import { readRun, repairJournal, runDir, runFile, writeLocalFileDurable } from "./local.js";
import {
    DEFAULT_CIRCUIT_THRESHOLD,
    OvernightPolicy,
    loadPolicy,
    policyRefusal
} from "./policy.js";
import {
    beginSettlement,
    currentWork,
    runSettlement,
    usageOf,
    validate
} from "./settle.js";

const SCHEDULER = "scheduler";

export interface TickSummary
{
    reconciled: string[];
    settled: string[];
    dispatched: string[];
    skipped: string[];
    recovered: string[];
}

// Everything a tick does happens under the workspace's journal lock. Two
// daemons, or a daemon and a `self daemon tick` typed by hand, serialise here
// rather than both validating, reporting, releasing and dispatching the same
// attempt.
export function tick(ctx: CliContext, now: Date): TickSummary
{
    return withStoreLock(ctx.storeDir, () => lockedTick(ctx, now));
}

function lockedTick(ctx: CliContext, now: Date): TickSummary
{
    const summary: TickSummary = { reconciled: [], settled: [], dispatched: [], skipped: [], recovered: [] };
    const torn = repairJournal(ctx.storeDir);
    if (torn.length > 0)
    {
        summary.recovered.push(`quarantined ${torn.length} torn journal line(s) from an interrupted write`);
    }
    ensureSubscription(ctx.storeDir, SCHEDULER, now.toISOString());
    const attempts = foldAttempts(ctx.storeDir);
    for (const attempt of attempts)
    {
        const note = recoverLaunch(ctx, attempt, now);
        if (note !== null)
        {
            summary.recovered.push(note);
        }
    }
    // An interrupted settlement is finished before anything new is judged, so
    // a crashed transaction can never be overtaken by a second one.
    for (const attempt of attempts.filter((item) => item.settlement !== null && !item.settlementCommitted))
    {
        runSettlement(ctx, attempt, { record }, now.toISOString());
        summary.recovered.push(`resumed the settlement of ${attempt.id} (${attempt.verdict})`);
    }
    for (const attempt of attempts)
    {
        if (reconcile(ctx, attempt, now))
        {
            summary.reconciled.push(`${attempt.id} ${attempt.exitSource}`);
        }
    }
    for (const attempt of attempts.filter((item) => item.state === "exited"))
    {
        settle(ctx, attempt, now);
        summary.settled.push(`${attempt.id} ${attempt.verdict}`);
    }
    consumeSignals(ctx, attempts, now);
    for (const attempt of attempts)
    {
        const refusal = considerDispatch(ctx, attempts, attempt, now);
        if (refusal === null)
        {
            launch(ctx, attempt, now);
            summary.dispatched.push(attempt.id);
        }
        else if (refusal !== "")
        {
            summary.skipped.push(`${attempt.id} — ${refusal}`);
        }
    }
    return summary;
}

// The scheduler's place in the journal is durable, so a restart resumes where
// the previous generation stopped instead of relying on what a dead process
// happened to remember. Replaying a signal is harmless: the wake it produces
// is gated on work state that has already moved.
function consumeSignals(ctx: CliContext, attempts: AttemptRecord[], now: Date): void
{
    const signals = pendingSignals(ctx.storeDir, SCHEDULER);
    if (signals.length === 0)
    {
        return;
    }
    for (const signal of signals)
    {
        const attempt = attempts.find((item) => item.id === signal.attempt);
        if (attempt !== undefined && signal.kind === "settle.commit")
        {
            wakeDependents(ctx, attempts, attempt, now);
        }
    }
    advanceCursor(ctx.storeDir, SCHEDULER, signals[signals.length - 1].seq ?? -1, now.toISOString());
}

// A dependency finishing is what makes the next unit ready. Recording the
// wake keeps the reason visible instead of a unit that silently changed state
// overnight, and only approved, ready work is woken.
function wakeDependents(ctx: CliContext, attempts: AttemptRecord[], finished: AttemptRecord, now: Date): void
{
    if (finished.verdict !== "passed")
    {
        return;
    }
    const works = buildModel(ctx.storeDir, finished.project, now).works;
    for (const waiting of attempts.filter((item) => item.dependsOn.includes(finished.work)))
    {
        const work = works.find((item) => item.id === waiting.work);
        if (work?.status === "blocked" && work.blockedOn === "dependency")
        {
            record(ctx, waiting.project, "work.unblocked", { work: waiting.work }, undefined, `${waiting.work} dependency met`);
        }
    }
}

/* ── observation ───────────────────────────────────────────────────── */

export function alive(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

interface ExitNotice
{
    code: number | null;
    providerStatus: string | null;
    retryAt: string | null;
}

// The wrapper writes the exit notice by rename into the directory of the
// launch that produced it, so neither a half-written file nor a wrapper from
// a superseded launch can read as this run's confirmed exit.
function readExitNotice(ctx: CliContext, attempt: AttemptRecord): ExitNotice | null
{
    const raw = readRun(ctx.storeDir, attempt.id, attempt.fence, "exit");
    if (raw === null || raw.trim() === "")
    {
        return null;
    }
    const provider = readRun(ctx.storeDir, attempt.id, attempt.fence, "provider.json");
    const parsed = provider === null ? {} : safeJson(provider);
    return {
        code: Number.parseInt(raw.trim(), 10),
        providerStatus: typeof parsed.status === "string" ? parsed.status : null,
        retryAt: typeof parsed.retryAt === "string" ? parsed.retryAt : null
    };
}

function safeJson(text: string): Record<string, unknown>
{
    try
    {
        return JSON.parse(text) as Record<string, unknown>;
    }
    catch
    {
        return {};
    }
}

function beatDeadline(attempt: AttemptRecord): number
{
    const base = attempt.lastBeat ?? attempt.startedAt ?? attempt.registeredAt;
    return new Date(base).getTime() + attempt.heartbeatSec * 1000;
}

// The launch intent is journalled and fsynced before the process exists, so
// the two crash points either side of spawn are both recoverable: with no
// pid written by the wrapper nothing was ever started and the attempt goes
// back to the queue, and with one the process is adopted rather than left to
// run untracked.
function recoverLaunch(ctx: CliContext, attempt: AttemptRecord, now: Date): string | null
{
    if (attempt.state !== "running" || attempt.pid !== null)
    {
        return null;
    }
    const written = readRun(ctx.storeDir, attempt.id, attempt.fence, "pid");
    const pid = written === null ? Number.NaN : Number.parseInt(written.trim(), 10);
    if (Number.isFinite(pid))
    {
        patchAttempt(ctx.storeDir, attempt, "adopt", { pid, owner: generation() }, now.toISOString());
        return `adopted ${attempt.id} (pid recorded by its own wrapper after a crash mid-launch)`;
    }
    if (existsSync(runFile(ctx.storeDir, attempt.id, attempt.fence, "exit")))
    {
        return null;
    }
    patchAttempt(ctx.storeDir, attempt, "launch.abandoned", {
        state: "registered",
        startedAt: null,
        tries: Math.max(0, attempt.tries - 1),
        owner: null
    }, now.toISOString());
    return `${attempt.id} was journalled but never spawned — returned to the queue`;
}

// Exit detection needs no orchestrator: a confirmed notice, a pid that is
// gone, and a heartbeat that ran out are three different findings, and only
// the first says anything about what the run produced.
function reconcile(ctx: CliContext, attempt: AttemptRecord, now: Date): boolean
{
    if (attempt.state !== "running")
    {
        return false;
    }
    const notice = readExitNotice(ctx, attempt);
    if (notice !== null)
    {
        patchAttempt(ctx.storeDir, attempt, "exit", {
            state: "exited",
            exitAt: now.toISOString(),
            exitSource: "confirmed",
            exitCode: notice.code,
            providerStatus: notice.providerStatus,
            retryAt: notice.retryAt
        }, now.toISOString(), attempt.fence);
        return true;
    }
    if (attempt.pid !== null && !alive(attempt.pid))
    {
        patchAttempt(ctx.storeDir, attempt, "exit", {
            state: "exited",
            exitAt: now.toISOString(),
            exitSource: "vanished"
        }, now.toISOString(), attempt.fence);
        return true;
    }
    if (now.getTime() > beatDeadline(attempt))
    {
        // A lease lost to a dead heartbeat must not leave the process running
        // with it: containment comes before the verdict.
        terminate(attempt);
        patchAttempt(ctx.storeDir, attempt, "exit", {
            state: "exited",
            exitAt: now.toISOString(),
            exitSource: "stale"
        }, now.toISOString(), attempt.fence);
        return true;
    }
    return false;
}

// A worker whose lease or launch has been superseded is stopped rather than
// left to keep writing. Its spool stays: the evidence outlives the process.
export function terminate(attempt: AttemptRecord): void
{
    if (attempt.pid === null)
    {
        return;
    }
    try
    {
        process.kill(attempt.pid, "SIGTERM");
    }
    catch
    {
        // Already gone. The state change is what has to persist.
    }
}

/* ── settlement ────────────────────────────────────────────────────── */

export function settle(ctx: CliContext, attempt: AttemptRecord, now: Date): void
{
    const policy = loadPolicy(ctx.storeDir, attempt.project);
    const work = currentWork(ctx, attempt, now);
    const result = validate(ctx, attempt, work, policy);
    const cost = usageOf(ctx.storeDir, attempt);
    const ts = now.toISOString();
    if (result.verdict === "capacity")
    {
        const retryAt = attempt.retryAt ?? new Date(now.getTime() + 3_600_000).toISOString();
        patchAttempt(ctx.storeDir, attempt, "capacity", {
            state: "waiting-capacity",
            verdict: null,
            reasons: result.reasons,
            retryAt,
            exitSource: null,
            pid: null,
            ...cost
        }, ts, attempt.fence);
        syncEvent(ctx, attempt, "attempt.waiting", { text: `${attempt.id} waiting on provider capacity until ${retryAt}`, attempt: attempt.id, retryAt });
        return;
    }
    // What the run said about itself is recorded before the settlement opens,
    // so the envelope the plan was judged against is on record even if the
    // transaction is interrupted before it commits.
    patchAttempt(ctx.storeDir, attempt, "envelope", {
        envelope: result.envelope,
        requestedModel: result.envelope?.requestedModel ?? attempt.requestedModel,
        resolvedModel: result.envelope?.resolvedModel ?? null,
        modelResolution: result.envelope?.modelResolution ?? null
    }, ts, attempt.fence);
    beginSettlement(ctx, attempt, result, cost, policy, ts);
    runSettlement(ctx, attempt, { record }, ts);
    if (result.verdict === "failed" || result.verdict === "stale")
    {
        scheduleRetry(ctx, attempt, result, now);
    }
}

function scheduleRetry(ctx: CliContext, attempt: AttemptRecord, result: { verdict: string }, now: Date): void
{
    const deterministic = result.verdict === "failed" && attempt.exitSource === "confirmed" && attempt.exitCode === 0;
    if (deterministic || attempt.tries > attempt.maxRetries)
    {
        return;
    }
    patchAttempt(ctx.storeDir, attempt, "retry", {
        state: "registered",
        verdict: null,
        exitSource: null,
        exitCode: null,
        exitAt: null,
        settledAt: null,
        reportEventId: null,
        settlement: null,
        settlementSteps: [],
        settlementCommitted: false,
        envelope: null
    }, now.toISOString());
}

/* ── dispatch ──────────────────────────────────────────────────────── */

// Returns null when the attempt may launch, "" when it is simply not a
// candidate, and a sentence when something the user should see refused it.
export function considerDispatch(ctx: CliContext, attempts: AttemptRecord[], attempt: AttemptRecord, now: Date): string | null
{
    if (attempt.command === null || (attempt.state !== "registered" && attempt.state !== "waiting-capacity" && attempt.state !== "waiting-approval"))
    {
        return "";
    }
    const policy = loadPolicy(ctx.storeDir, attempt.project);
    const gate = dispatchRefusal(ctx, attempts, attempt, policy, now);
    if (gate !== null)
    {
        return gate;
    }
    const refusal = policyRefusal(policy, attempt.project, attempt.riskClass, attempt.kind, now);
    return refusal === null ? null : refusal.reason;
}

// The gates that hold whether or not a policy exists: capability, approval,
// dependencies, leases, capacity resets, the breaker, and the budget.
export function dispatchRefusal(
    ctx: CliContext,
    attempts: AttemptRecord[],
    attempt: AttemptRecord,
    policy: OvernightPolicy | null,
    now: Date
): string | null
{
    // A forbidden action is refused before anything else, because no later
    // gate — not approval, not the policy — could ever let it through.
    const forbidden = forbiddenAction(attempt.actions);
    if (forbidden !== null)
    {
        return `"${forbidden}" is never allowed without human approval`;
    }
    if (attempt.cancelRequested)
    {
        return "cancelled by the user";
    }
    if (attempt.needsApproval && !attempt.approved)
    {
        return "waiting on human approval";
    }
    // Re-decided here, not trusted from registration: an attempt whose actions
    // were widened mid-run meets the launcher's profile again, and approval
    // alone cannot conjure a capability the launcher does not grant.
    const decision = decideCapabilities(attempt.riskClass, attempt.actions);
    if (decision.reason !== null)
    {
        return decision.reason;
    }
    if (attempt.retryAt !== null && now.toISOString() < attempt.retryAt)
    {
        return `waiting on provider capacity until ${attempt.retryAt}`;
    }
    const pending = unmetDependency(ctx, attempt);
    if (pending !== null)
    {
        return `waiting on ${pending}`;
    }
    const held = heldLeases(attempts).get(attempt.lease ?? "");
    if (attempt.lease !== null && held !== undefined && held.attempt !== attempt.id)
    {
        return `lease "${attempt.lease}" is held by ${held.attempt} at fence ${held.fence}`;
    }
    const threshold = policy?.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD;
    if (circuitOpen(ctx.storeDir, circuitKey(attempt), threshold))
    {
        return `the circuit for ${circuitKey(attempt)} is open after ${threshold} failures`;
    }
    const running = attempts.filter((item) => item.project === attempt.project && item.state === "running").length;
    if (policy !== null && running >= policy.maxConcurrent)
    {
        return `already running ${running} of ${policy.maxConcurrent} allowed at once`;
    }
    return budgetRefusal(attempts, attempt, policy);
}

// A cost the provider never reported is not a cost of zero. Summing unknowns
// as zero would let a whole night of spending read as free and never trip the
// budget, so an attempt that declared a reservation is charged for it and one
// that declared nothing makes the budget unprovable.
function budgetRefusal(attempts: AttemptRecord[], attempt: AttemptRecord, policy: OvernightPolicy | null): string | null
{
    if (policy?.budgetUsd == null)
    {
        return null;
    }
    const settled = attempts.filter((item) => item.project === attempt.project && item.settledAt !== null);
    const spent = settled
        .filter((item) => item.costUsd !== null)
        .reduce((total, item) => total + (item.costUsd ?? 0), 0);
    const unknown = settled.filter((item) => item.costUsd === null);
    // An attempt whose provider said nothing is charged what its launch
    // reserved, and one that reserved nothing is counted rather than added:
    // either way it never contributes a zero that makes spending look free.
    const reserved = unknown.reduce((total, item) => total + (item.budgetUsd ?? 0), 0);
    const unpriced = unknown.filter((item) => item.budgetUsd === null).length;
    if (spent + reserved < policy.budgetUsd)
    {
        return null;
    }
    const note = unpriced === 0 ? "" : `, and ${unpriced} attempt(s) reported no cost at all`;
    return `the overnight budget of $${policy.budgetUsd} is spent (known $${spent.toFixed(2)}, reserved $${reserved.toFixed(2)}${note})`;
}

function unmetDependency(ctx: CliContext, attempt: AttemptRecord): string | null
{
    if (attempt.dependsOn.length === 0)
    {
        return null;
    }
    const works = buildModel(ctx.storeDir, attempt.project, new Date()).works;
    const pending = attempt.dependsOn.filter((id) => works.find((work) => work.id === id)?.status !== "done");
    return pending.length === 0 ? null : pending.join(", ");
}

// The wrapper, not the daemon, owns the exit notice: the run must be able to
// finish correctly even if the supervisor dies the moment after it starts.
export function launch(ctx: CliContext, attempt: AttemptRecord, now: Date): void
{
    const decision = decideCapabilities(attempt.riskClass, attempt.actions);
    if (decision.reason !== null)
    {
        throw new Error(decision.reason);
    }
    const ts = now.toISOString();
    const fence = attempt.fence + 1;
    // Journalled and fsynced before the process exists. Everything the
    // recovery path needs to find an orphan is durable at this point.
    patchAttempt(ctx.storeDir, attempt, "launch.intent", {
        state: "running",
        fence,
        owner: generation(),
        capabilities: decision.granted,
        pid: null,
        startedAt: ts,
        lastBeat: ts,
        tries: attempt.tries + 1,
        retryAt: null
    }, ts);
    const dir = runDir(ctx.storeDir, attempt.id, fence);
    writeLocalFileDurable(runFile(ctx.storeDir, attempt.id, fence, "fence"), String(fence) + "\n");
    const child = spawn("/bin/sh", ["-c", wrapper(ctx, attempt, fence)], {
        cwd: resolveProjectPath(ctx.storeDir, attempt.project) ?? ctx.workspaceDir,
        detached: true,
        stdio: "ignore",
        // A launched command gets the variables a local build needs and
        // nothing else: an inherited environment would hand every run this
        // machine's provider keys and cloud credentials.
        env: sanitizedEnv({
            SUPERSELF_ATTEMPT: attempt.id,
            SUPERSELF_WORK: attempt.work,
            SUPERSELF_FENCE: String(fence),
            SUPERSELF_SPOOL: dir,
            SUPERSELF_MODEL: attempt.requestedModel ?? "",
            SUPERSELF_REQUIREMENTS: attempt.requirements.join(","),
            SUPERSELF_WORK_REVISION: String(attempt.workRevision),
            SUPERSELF_DESIGN_REVISION: attempt.designRevision === null ? "" : String(attempt.designRevision),
            SUPERSELF_CAPABILITIES: decision.granted.join(",")
        })
    });
    child.unref();
    patchAttempt(ctx.storeDir, attempt, "launch.pid", { pid: child.pid ?? null }, new Date().toISOString(), fence);
    startWork(ctx, attempt, ts);
    syncEvent(ctx, attempt, "attempt.started", {
        text: `${attempt.work} attempt ${attempt.id} started on ${attempt.runtime}`,
        attempt: attempt.id,
        fence
    });
}

// The wrapper records its own pid before it runs anything, which is what lets
// a supervisor that died between spawn and its own bookkeeping still find the
// process it started.
function wrapper(ctx: CliContext, attempt: AttemptRecord, fence: number): string
{
    const at = (name: string): string => quote(runFile(ctx.storeDir, attempt.id, fence, name));
    return [
        `printf %s "$$" > ${at("pid.part")}`,
        `mv ${at("pid.part")} ${at("pid")}`,
        `( ${attempt.command} ) > ${at("stdout")} 2> ${at("stderr")}`,
        `printf %s "$?" > ${at("exit.part")}`,
        `mv ${at("exit.part")} ${at("exit")}`
    ].join("; ");
}

function startWork(ctx: CliContext, attempt: AttemptRecord, ts: string): void
{
    const work = buildModel(ctx.storeDir, attempt.project, new Date(ts)).works.find((item) => item.id === attempt.work);
    if (work?.status === "next")
    {
        record(ctx, attempt.project, "work.started", { work: attempt.work }, undefined, `${attempt.work} ${work.outcome}`);
    }
}

/* ── synced events ─────────────────────────────────────────────────── */

export function syncEvent(ctx: CliContext, attempt: AttemptRecord, type: string, payload: Record<string, unknown>): void
{
    record(ctx, attempt.project, type, payload, { work: attempt.work }, String(payload.text ?? attempt.id));
}

export function record(
    ctx: CliContext,
    slug: string,
    type: string,
    payload: Record<string, unknown>,
    refs: EventRefs | undefined,
    summary: string,
    id?: string
): string
{
    const projectDir = resolveProjectPath(ctx.storeDir, slug) ?? undefined;
    const event = makeEvent(slug, type, payload, refs, false, id);
    recordEvent({ ...ctx, project: slug, projectDir }, event, summary);
    return event.id;
}

function quote(path: string): string
{
    return `'${path.replace(/'/g, "'\\''")}'`;
}
