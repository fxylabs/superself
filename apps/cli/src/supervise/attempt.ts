import { CliError } from "../types.js";
import { appendJournal, readJournal } from "./local.js";
import { OwnedTree, ProcessRef } from "./process.js";

export type AttemptState =
    | "registered"
    | "waiting-approval"
    | "waiting-capacity"
    | "running"
    | "exited"
    | "settled";

export type AttemptVerdict =
    | "passed"
    | "failed"
    | "stale"
    | "cancelled"
    | "capacity"
    | "revision_required"
    | "refused";

// How the supervisor learned the process was over. Only a wrapper-written
// exit notice is a confirmed exit; a pid that simply disappeared, or a
// heartbeat that ran out, says nothing about what the run produced.
export type ExitSource = "confirmed" | "vanished" | "stale";

export type ModelResolution = "exact" | "unknown" | "refused";

// What the run declared about itself when it finished. Recorded verbatim and
// then judged: none of it is believed on its own.
export interface EnvelopeSummary
{
    completionId: string;
    requestedModel: string | null;
    resolvedModel: string | null;
    modelResolution: ModelResolution;
    providerHandle: string | null;
    workRevision: number | null;
    designRevision: number | null;
    requirements: string[];
    claimedActions: string[];
    validations: { name: string; status: string; detail?: string }[];
    outputs: string[];
}

// A settlement touches several places at once — artifacts, a report, a work
// transition, a lease, a wake. The plan is written to the journal before any
// of it happens and every id it will use is fixed in advance, so a replay
// after a crash re-runs the same effects onto the same ids instead of making
// a second set.
export interface SettlementPlan
{
    key: string;
    verdict: AttemptVerdict;
    reasons: string[];
    hashes: Record<string, string>;
    staged: { label: string; name: string; artifactId: string }[];
    reportEventId: string;
    settledEventId: string;
    workEventId: string;
    workEventType: string | null;
    costUsd: number | null;
    usage: number | null;
    // The generation that opened the settlement, so a resumed transaction is
    // attributable rather than anonymous.
    owner: string;
}

export interface AttemptRecord
{
    id: string;
    project: string;
    work: string;
    runtime: string;
    kind: string;
    model: string | null;
    riskClass: string;
    // What the launch asked for. A request, never a grant.
    actions: string[];
    // What the launcher was willing to give it.
    capabilities: string[];
    // Absolute paths on this machine — declared before launch, verified after.
    declared: string[];
    command: string | null;
    session: string | null;
    lease: string | null;
    dependsOn: string[];
    requirements: string[];
    workRevision: number;
    designRevision: number | null;
    requireReport: boolean;
    completes: boolean;
    needsApproval: boolean;
    approved: boolean;
    budgetUsd: number | null;
    heartbeatSec: number;
    maxRetries: number;
    state: AttemptState;
    // Monotonic. Every launch mints a new one, so a wrapper or worker from a
    // previous generation carries a token that no longer matches and cannot
    // settle, heartbeat, or mutate what is running now.
    fence: number;
    owner: string | null;
    registeredAt: string;
    startedAt: string | null;
    lastBeat: string | null;
    exitAt: string | null;
    settledAt: string | null;
    // A machine-local diagnostic only. The identities that decide anything are
    // the reference and the group below; this mirrors the wrapper's number so
    // a person reading `attempt show` can find it in `ps`.
    pid: number | null;
    // The local process this machine started, and the process group the launch
    // owns. The wrapper answers "did the launch finish"; the group answers
    // "did everything it started finish", which is a different question and
    // the only one that may end an attempt.
    wrapper: ProcessRef | null;
    tree: OwnedTree | null;
    // When the owned group was first observed with nothing left in it. Until
    // it is set the attempt cannot become terminal, whoever says the run is
    // over; once it is set the group is never probed again, so a group id
    // handed to somebody else afterwards can never read back as this launch's.
    treeClosedAt: string | null;
    // When containment was first signalled to a group that outlived its
    // launch, which is what the escalation to SIGKILL is timed from.
    treeSignalledAt: string | null;
    // The provider's own name for the job this launch claimed. A provider
    // handle outlives every local process and is the only identity that
    // survives this machine going away.
    providerHandle: string | null;
    // Whether that claim is still open, folded onto the attempt rather than
    // left in the spool file alone. A provider job is a live owner exactly as
    // a running process is, and what a lease and a concurrency slot are held
    // for has to be answerable from the journal — durably, and without going
    // to disk for a file a restart may not have reached yet.
    providerClaimOpen: boolean;
    exitCode: number | null;
    // The pid that signed the exit notice, when the wrapper signed it. An exit
    // recorded by hand carries none, and then no process is excused from the
    // liveness check the verdict waits on.
    exitWriter: number | null;
    exitSource: ExitSource | null;
    providerStatus: string | null;
    retryAt: string | null;
    tries: number;
    cancelRequested: boolean;
    verdict: AttemptVerdict | null;
    reasons: string[];
    hashes: Record<string, string>;
    costUsd: number | null;
    usage: number | null;
    envelope: EnvelopeSummary | null;
    requestedModel: string | null;
    resolvedModel: string | null;
    modelResolution: ModelResolution | null;
    reportEventId: string | null;
    settlement: SettlementPlan | null;
    settlementSteps: string[];
    settlementCommitted: boolean;
}

export interface CircuitState
{
    key: string;
    failures: number;
    open: boolean;
    lastFailureTs: string | null;
}

export class FenceError extends CliError
{
}

export function newAttempt(id: string, project: string, work: string, ts: string): AttemptRecord
{
    return {
        id,
        project,
        work,
        runtime: "unknown",
        kind: "implementation",
        model: null,
        riskClass: "internal",
        actions: [],
        capabilities: [],
        declared: [],
        command: null,
        session: null,
        lease: null,
        dependsOn: [],
        requirements: [],
        workRevision: 0,
        designRevision: null,
        requireReport: true,
        completes: false,
        needsApproval: false,
        approved: false,
        budgetUsd: null,
        heartbeatSec: 900,
        maxRetries: 0,
        state: "registered",
        fence: 0,
        owner: null,
        registeredAt: ts,
        startedAt: null,
        lastBeat: null,
        exitAt: null,
        settledAt: null,
        pid: null,
        wrapper: null,
        tree: null,
        treeClosedAt: null,
        treeSignalledAt: null,
        providerHandle: null,
        providerClaimOpen: false,
        exitCode: null,
        exitWriter: null,
        exitSource: null,
        providerStatus: null,
        retryAt: null,
        tries: 0,
        cancelRequested: false,
        verdict: null,
        reasons: [],
        hashes: {},
        costUsd: null,
        usage: null,
        envelope: null,
        requestedModel: null,
        resolvedModel: null,
        modelResolution: null,
        reportEventId: null,
        settlement: null,
        settlementSteps: [],
        settlementCommitted: false
    };
}

// State is the fold of the journal, so a daemon that died between two writes
// comes back to exactly what the last completed write said. A journal whose
// final line was torn in half by that death folds to the same place: the torn
// bytes are not entries and never became state.
export function foldAttempts(storeDir: string): AttemptRecord[]
{
    const byId = new Map<string, AttemptRecord>();
    for (const entry of readJournal(storeDir))
    {
        if (entry.kind === "circuit.reset")
        {
            continue;
        }
        if (entry.kind === "register")
        {
            byId.set(entry.attempt, { ...newAttempt(entry.attempt, "", "", entry.ts), ...entry.patch } as AttemptRecord);
            continue;
        }
        const record = byId.get(entry.attempt);
        if (record !== undefined)
        {
            Object.assign(record, entry.patch);
        }
    }
    return [...byId.values()];
}

export function reloadAttempt(storeDir: string, id: string): AttemptRecord | undefined
{
    return foldAttempts(storeDir).find((attempt) => attempt.id === id);
}

// The compare-and-set the whole supervisor rests on. Callers hold the store
// lock, so the fold they read is the durable truth; the fence check then
// refuses any writer working from a generation that has been superseded.
export function patchAttempt(
    storeDir: string,
    attempt: AttemptRecord,
    kind: string,
    patch: Partial<AttemptRecord>,
    ts: string,
    expectFence?: number
): void
{
    if (expectFence !== undefined && attempt.fence !== expectFence)
    {
        throw new FenceError(`${attempt.id} moved on — fence ${expectFence} is stale, the attempt is at ${attempt.fence}`);
    }
    Object.assign(attempt, patch);
    appendJournal(storeDir, { ts, attempt: attempt.id, kind, patch: patch as Record<string, unknown> });
}

export function registerAttempt(storeDir: string, record: AttemptRecord): void
{
    appendJournal(storeDir, { ts: record.registeredAt, attempt: record.id, kind: "register", patch: record as unknown as Record<string, unknown> });
}

export function findAttempt(attempts: AttemptRecord[], id: string): AttemptRecord | undefined
{
    return attempts.find((attempt) => attempt.id === id) ?? attempts.find((attempt) => attempt.id.endsWith(id));
}

// A worker's token has to match the launch that is current. An exit notice or
// heartbeat carrying an older fence is a process from a superseded generation
// and is refused rather than allowed to write over a live run.
export function requireFence(attempt: AttemptRecord, presented: number | null): void
{
    if (presented === null)
    {
        return;
    }
    if (presented !== attempt.fence)
    {
        throw new FenceError(`${attempt.id} is at fence ${attempt.fence}; this process holds ${presented} and no longer owns the attempt`);
    }
}

// A lease is held for exactly as long as its attempt runs, and the fence that
// launched it rides along: deriving both from attempt state rather than
// recording a separate holder is what keeps a killed daemon from leaking the
// slot, and what lets a stale holder be recognised instead of believed.
export interface LeaseHold
{
    attempt: string;
    fence: number;
}

// What a launch still occupies. An exit notice is not the moment to hand the
// slot on: the notice says the launch finished, and the processes it started
// can outlive it, so the hold lasts until the owned group is observed empty.
//
// The group is not the only owner an attempt can have. Work claimed at a
// provider outlives every local process, and the attempt is held out of
// settlement for it — so it has to be held out of releasing what it reserved
// for it too. Otherwise the second attempt in the queue dispatches into a slot
// the first one is still using, which is exactly the failure the process case
// exists to prevent, only relocated.
export function holdsResources(attempt: AttemptRecord): boolean
{
    if (attempt.state === "running")
    {
        return true;
    }
    return attempt.state === "exited" && (attempt.treeClosedAt === null || attempt.providerClaimOpen);
}

export function heldLeases(attempts: AttemptRecord[]): Map<string, LeaseHold>
{
    const held = new Map<string, LeaseHold>();
    for (const attempt of attempts)
    {
        if (holdsResources(attempt) && attempt.lease !== null)
        {
            const current = held.get(attempt.lease);
            if (current === undefined || attempt.fence > current.fence)
            {
                held.set(attempt.lease, { attempt: attempt.id, fence: attempt.fence });
            }
        }
    }
    return held;
}

export function circuitKey(attempt: AttemptRecord): string
{
    return `${attempt.project}/${attempt.runtime}`;
}

// Consecutive transient failures, newest first, per project and runtime.
// A validation failure is deterministic, so it neither trips nor clears the
// breaker: re-running the same output would fail the same way.
export function circuits(storeDir: string, threshold: number): CircuitState[]
{
    const settled = foldAttempts(storeDir)
        .filter((attempt) => attempt.settledAt !== null)
        .sort((a, b) => String(a.settledAt).localeCompare(String(b.settledAt)));
    const resets = readJournal(storeDir).filter((entry) => entry.kind === "circuit.reset");
    const counters = new Map<string, CircuitState>();
    for (const attempt of settled)
    {
        const key = circuitKey(attempt);
        const state = counters.get(key) ?? { key, failures: 0, open: false, lastFailureTs: null };
        if (attempt.verdict === "passed")
        {
            state.failures = 0;
        }
        if (attempt.verdict === "failed" || attempt.verdict === "stale")
        {
            state.failures += 1;
            state.lastFailureTs = attempt.settledAt;
        }
        counters.set(key, state);
    }
    for (const reset of resets)
    {
        const state = counters.get(String(reset.patch.key ?? ""));
        if (state !== undefined && (state.lastFailureTs === null || reset.ts > state.lastFailureTs))
        {
            state.failures = 0;
            state.lastFailureTs = null;
        }
    }
    return [...counters.values()].map((state) => ({ ...state, open: state.failures >= threshold }));
}

export function circuitOpen(storeDir: string, key: string, threshold: number): boolean
{
    return circuits(storeDir, threshold).some((state) => state.key === key && state.open);
}
