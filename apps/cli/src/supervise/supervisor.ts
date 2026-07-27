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
    holdsResources,
    patchAttempt
} from "./attempt.js";
import { decideCapabilities, forbiddenAction, sanitizedEnv } from "./capability.js";
import { advanceCursor, ensureSubscription, pendingSignals } from "./cursor.js";
import { readClaim } from "./envelope.js";
import { generation, withStoreLock } from "./lock.js";
import { readRun, repairJournal, runDir, runFile, writeLocalFileDurable } from "./local.js";
import {
    groupByCommand,
    ownedTree,
    processRef,
    refAlive,
    refTerminate,
    treeAlive,
    treeMembers,
    treeTerminate
} from "./process.js";
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
    // Nothing is judged until nothing it started is still running. A held
    // attempt stays "exited", keeps its lease, and is looked at again next
    // pass rather than being closed on the strength of an exit notice.
    for (const attempt of attempts.filter((item) => item.state === "exited"))
    {
        const hold = physicalHold(ctx, attempt, now);
        if (hold !== null)
        {
            summary.skipped.push(`${attempt.id} — ${hold}`);
            continue;
        }
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
    // The pid that wrote the notice. The wrapper signs its own, so the shell
    // that is in the act of finishing can be told apart from the rest of the
    // group. A notice recorded by hand or by an external caller is unsigned,
    // and then no process is excused from being counted.
    writtenBy: number | null;
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
    const fields = raw.trim().split(/\s+/);
    const writer = fields.length < 2 ? Number.NaN : Number.parseInt(fields[1], 10);
    return {
        code: Number.parseInt(fields[0], 10),
        writtenBy: Number.isFinite(writer) ? writer : null,
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

// How long a journalled launch is given to show that it spawned, before it is
// treated as one that never happened. The wrapper's first statement writes its
// pid, so this covers scheduling, not work.
const LAUNCH_PROOF_MS = 30_000;

// The launch intent is journalled and fsynced before the process exists, so
// every crash point around spawn is recoverable. The wrapper's pid file
// answers first; where the crash landed before the wrapper reached its own
// first write, the process table is asked for the group whose command line
// carries this launch's marker. Only when neither answers, and the launch has
// had long enough to leave one of the two traces, is it returned to the queue
// — because requeueing a launch whose tree is still alive dispatches a second
// one into the lease the first is still holding.
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
        adopt(ctx, attempt, pid, now);
        return `adopted ${attempt.id} (pid recorded by its own wrapper after a crash mid-launch)`;
    }
    const spawned = groupByCommand(launchMark(attempt.id, attempt.fence));
    if (spawned !== null)
    {
        adopt(ctx, attempt, spawned, now);
        return `adopted ${attempt.id} (its group was still in the process table before any pid was written)`;
    }
    if (existsSync(runFile(ctx.storeDir, attempt.id, attempt.fence, "exit")))
    {
        return null;
    }
    if (withinProof(attempt, now))
    {
        return `${attempt.id} has not reported a pid yet — held rather than requeued while its spawn may still be live`;
    }
    patchAttempt(ctx.storeDir, attempt, "launch.abandoned", {
        state: "registered",
        startedAt: null,
        tries: Math.max(0, attempt.tries - 1),
        owner: null
    }, now.toISOString());
    return `${attempt.id} was journalled but never spawned — returned to the queue`;
}

// The pid came out of this launch's own fence spool, and this supervisor only
// ever spawns detached, so the wrapper leads its own session and its pid is
// the group id by construction. Asking the kernel to confirm that would lose
// the group in exactly the case that matters — a wrapper that has already
// exited, leaving behind the descendants it started. The launch instant rides
// along instead, and it is what keeps a recycled group id from being mistaken
// for this one's.
function adopt(ctx: CliContext, attempt: AttemptRecord, pid: number, now: Date): void
{
    patchAttempt(ctx.storeDir, attempt, "adopt", {
        pid,
        wrapper: processRef(ctx.storeDir, pid),
        tree: ownedTree(ctx.storeDir, attempt.id, attempt.fence, pid, attempt.startedAt),
        owner: generation()
    }, now.toISOString());
}

// A spawn that has only just happened has not necessarily reached the
// wrapper's first statement yet, and "no trace" during that window is not
// evidence that nothing started.
function withinProof(attempt: AttemptRecord, now: Date): boolean
{
    return attempt.startedAt !== null && now.getTime() - Date.parse(attempt.startedAt) < LAUNCH_PROOF_MS;
}

// Exit detection needs no orchestrator: a confirmed notice, a pid that is
// gone, and a heartbeat that ran out are three different findings, and only
// the first says anything about what the run produced. None of the three ends
// the attempt on its own — they end the launch, and what the launch started is
// asked about separately.
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
            exitWriter: notice.writtenBy,
            providerStatus: notice.providerStatus,
            retryAt: notice.retryAt
        }, now.toISOString(), attempt.fence);
        return true;
    }
    if (attempt.wrapper !== null && !refAlive(ctx.storeDir, attempt.wrapper))
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
        terminate(ctx.storeDir, attempt);
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
// The whole group goes, not the wrapper alone — and where the supervisor never
// started the process it only has a reference, which is signalled only if it
// still resolves to the same process, so a recycled pid is never mistaken for
// the attempt and never receives its cancellation.
export function terminate(storeDir: string, attempt: AttemptRecord, signal: NodeJS.Signals = "SIGTERM"): void
{
    if (!treeTerminate(storeDir, attempt.tree, signal))
    {
        refTerminate(storeDir, attempt.wrapper, signal);
    }
}

/* ── physical terminality ──────────────────────────────────────────── */

// How long a group that outlived its launch is given to end itself after the
// first SIGTERM, before the supervisor stops asking.
const CONTAIN_GRACE_MS = 10_000;

// Semantic terminality is a conclusion about a run; physical terminality is an
// observation about what the run started, and the second gates the first. An
// exit notice can be written by anything holding the fence — the run itself, a
// person, an external script — but a process group answers to the kernel, so
// an attempt whose own processes are still running is never settled on
// anybody's word. Returns null when nothing owned by the launch is left.
function physicalHold(ctx: CliContext, attempt: AttemptRecord, now: Date): string | null
{
    const claim = claimHold(ctx, attempt);
    const ts = now.toISOString();
    if (attempt.treeClosedAt === null)
    {
        const running = stillRunning(ctx, attempt);
        if (running > 0)
        {
            return contain(ctx, attempt, running, now);
        }
        // The empty group and what the claim says go into one entry. Two would
        // leave a window in which the attempt has given up its process hold
        // without yet having recorded the provider hold that replaces it, and
        // a crash inside that window would free its lease.
        patchAttempt(ctx.storeDir, attempt, "tree.closed", { treeClosedAt: ts, ...claim.patch }, ts, attempt.fence);
    }
    else if (Object.keys(claim.patch).length > 0)
    {
        patchAttempt(ctx.storeDir, attempt, "handle", claim.patch, ts, attempt.fence);
    }
    return claim.open
        ? `the provider job it claimed is still open — release it with \`self attempt handle ${attempt.id} --close\``
        : null;
}

// What of the launch is still running. The wrapper is left out once it has
// signed its own exit notice: a shell in the act of finishing is not a run
// that is still going, and counting it would hold every attempt for one extra
// pass. Only the wrapper the launch recorded can be excused this way, so an
// exit notice written by anything else excuses nothing. Where the launch was
// never spawned here there is no group to read, and the pid the supervisor was
// handed is the whole of what it owns.
function stillRunning(ctx: CliContext, attempt: AttemptRecord): number
{
    if (attempt.tree === null)
    {
        return refAlive(ctx.storeDir, attempt.wrapper) ? 1 : 0;
    }
    const finishing = attempt.exitWriter === attempt.wrapper?.pid ? attempt.exitWriter : -1;
    const members = treeMembers(ctx.storeDir, attempt.tree);
    if (members !== null)
    {
        return members.filter((pid) => pid !== finishing).length;
    }
    // The process table could not be read at all. A group that still answers a
    // signal probe is held rather than assumed finished.
    return treeAlive(ctx.storeDir, attempt.tree) ? 1 : 0;
}

// A tree that outlived its launch is not left running: the launch owns it, so
// ending it is the supervisor's job. SIGTERM first, so a process can finish
// its own writes, then SIGKILL once the grace period is over — and no verdict
// until the group is actually empty.
function contain(ctx: CliContext, attempt: AttemptRecord, running: number, now: Date): string
{
    const signalled = attempt.treeSignalledAt;
    const expired = signalled !== null && now.getTime() - Date.parse(signalled) > CONTAIN_GRACE_MS;
    terminate(ctx.storeDir, attempt, expired ? "SIGKILL" : "SIGTERM");
    if (signalled === null)
    {
        patchAttempt(ctx.storeDir, attempt, "tree.contain", {
            treeSignalledAt: now.toISOString()
        }, now.toISOString(), attempt.fence);
    }
    return `${running} process(es) the launch started are still running — settling waits for them`;
}

// A provider job runs where this machine cannot watch it. The run says it owns
// one by claiming it, and until something releases that claim the attempt has
// a live owner no local observation can speak for. What the spool says is
// folded back onto the attempt, because a lease is granted from the journal
// and an owner that only exists in a file is an owner the next dispatch cannot
// see.
function claimHold(ctx: CliContext, attempt: AttemptRecord): { open: boolean; patch: Partial<AttemptRecord> }
{
    const claim = readClaim(ctx.storeDir, attempt);
    const open = claim !== null && claim.state === "open";
    const patch: Partial<AttemptRecord> = {};
    if (claim !== null && claim.handle !== attempt.providerHandle)
    {
        patch.providerHandle = claim.handle;
    }
    if (open !== attempt.providerClaimOpen)
    {
        patch.providerClaimOpen = open;
    }
    return { open, patch };
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
            ...forgetLaunch(),
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
        modelResolution: result.envelope?.modelResolution ?? null,
        providerHandle: result.envelope?.providerHandle ?? attempt.providerHandle
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
        envelope: null,
        ...forgetLaunch()
    }, now.toISOString());
}

// A launch that is going to happen again drops what the previous one owned.
// The group was observed empty before either path could be reached, so what
// is dropped is a finished record and never a live process left untracked.
function forgetLaunch(): Partial<AttemptRecord>
{
    return {
        pid: null,
        wrapper: null,
        tree: null,
        treeClosedAt: null,
        treeSignalledAt: null,
        exitWriter: null,
        // A new fence spools somewhere else, so whatever the previous launch
        // claimed is not this one's claim and must not go on holding its
        // lease. The claim was released before either path could be reached.
        providerClaimOpen: false
    };
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
    const running = attempts.filter((item) => item.project === attempt.project && holdsResources(item)).length;
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
        wrapper: null,
        tree: null,
        treeClosedAt: null,
        treeSignalledAt: null,
        exitWriter: null,
        providerClaimOpen: false,
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
    // Detached means the wrapper leads a new session, so its pid is also the
    // id of the group every descendant inherits. That group, not the wrapper,
    // is what the attempt owns from here on.
    patchAttempt(ctx.storeDir, attempt, "launch.pid", {
        pid: child.pid ?? null,
        wrapper: child.pid === undefined ? null : processRef(ctx.storeDir, child.pid),
        tree: child.pid === undefined ? null : ownedTree(ctx.storeDir, attempt.id, fence, child.pid, ts)
    }, new Date().toISOString(), fence);
    startWork(ctx, attempt, ts);
    syncEvent(ctx, attempt, "attempt.started", {
        text: `${attempt.work} attempt ${attempt.id} started on ${attempt.runtime}`,
        attempt: attempt.id,
        fence
    });
}

// The wrapper records its own pid before it runs anything, which is what lets
// a supervisor that died between spawn and its own bookkeeping still find the
// process it started — and, because that pid also names the session it leads,
// everything the run goes on to start.
function wrapper(ctx: CliContext, attempt: AttemptRecord, fence: number): string
{
    const at = (name: string): string => quote(runFile(ctx.storeDir, attempt.id, fence, name));
    return [
        // Inert to the shell and the whole point of the string to the
        // supervisor: the launch names itself in its own command line, so its
        // group can be recognised in the process table before the statement
        // below has had a chance to run. It leads, because a command line is
        // long and what a process table will show of one is not guaranteed.
        `: ${launchMark(attempt.id, fence)}`,
        `printf %s "$$" > ${at("pid.part")}`,
        `mv ${at("pid.part")} ${at("pid")}`,
        `( ${attempt.command} ) > ${at("stdout")} 2> ${at("stderr")}`,
        // Signed with the wrapper's own pid, so the supervisor can tell an
        // exit the wrapper reported from one somebody else wrote for it.
        `printf '%s %s' "$?" "$$" > ${at("exit.part")}`,
        `mv ${at("exit.part")} ${at("exit")}`
    ].join("; ");
}

// A launch says which attempt and which generation it is. Recovery matches on
// this rather than on the spool path, so it never turns on how a directory
// happens to be spelled.
function launchMark(attempt: string, fence: number): string
{
    return `superself-launch:${attempt}:${fence}`;
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
