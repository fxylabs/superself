import { appendJournal, readJournal } from "./local.js";

export type AttemptState =
    | "registered"
    | "waiting-approval"
    | "waiting-capacity"
    | "running"
    | "exited"
    | "settled";

export type AttemptVerdict = "passed" | "failed" | "stale" | "cancelled" | "capacity";

// How the supervisor learned the process was over. Only a wrapper-written
// exit notice is a confirmed exit; a pid that simply disappeared, or a
// heartbeat that ran out, says nothing about what the run produced.
export type ExitSource = "confirmed" | "vanished" | "stale";

export interface AttemptRecord
{
    id: string;
    project: string;
    work: string;
    runtime: string;
    kind: string;
    model: string | null;
    riskClass: string;
    actions: string[];
    // Absolute paths on this machine — declared before launch, verified after.
    declared: string[];
    command: string | null;
    session: string | null;
    lease: string | null;
    dependsOn: string[];
    requireReport: boolean;
    completes: boolean;
    needsApproval: boolean;
    approved: boolean;
    budgetUsd: number | null;
    heartbeatSec: number;
    maxRetries: number;
    state: AttemptState;
    registeredAt: string;
    startedAt: string | null;
    lastBeat: string | null;
    exitAt: string | null;
    settledAt: string | null;
    pid: number | null;
    exitCode: number | null;
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
    reportEventId: string | null;
}

export interface CircuitState
{
    key: string;
    failures: number;
    open: boolean;
    lastFailureTs: string | null;
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
        declared: [],
        command: null,
        session: null,
        lease: null,
        dependsOn: [],
        requireReport: true,
        completes: false,
        needsApproval: false,
        approved: false,
        budgetUsd: null,
        heartbeatSec: 900,
        maxRetries: 0,
        state: "registered",
        registeredAt: ts,
        startedAt: null,
        lastBeat: null,
        exitAt: null,
        settledAt: null,
        pid: null,
        exitCode: null,
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
        reportEventId: null
    };
}

// State is the fold of the journal, so a daemon that died between two writes
// comes back to exactly what the last completed write said.
export function foldAttempts(storeDir: string): AttemptRecord[]
{
    const byId = new Map<string, AttemptRecord>();
    const resets: string[] = [];
    for (const entry of readJournal(storeDir))
    {
        if (entry.kind === "circuit.reset")
        {
            resets.push(String(entry.patch.key ?? ""));
            continue;
        }
        if (entry.kind === "register")
        {
            byId.set(entry.attempt, entry.patch as unknown as AttemptRecord);
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

export function patchAttempt(storeDir: string, attempt: AttemptRecord, kind: string, patch: Partial<AttemptRecord>, ts: string): void
{
    Object.assign(attempt, patch);
    appendJournal(storeDir, { ts, attempt: attempt.id, kind, patch: patch as Record<string, unknown> });
}

export function registerAttempt(storeDir: string, record: AttemptRecord): void
{
    appendJournal(storeDir, { ts: record.registeredAt, attempt: record.id, kind: "register", patch: record as unknown as Record<string, unknown> });
}

export function findAttempt(attempts: AttemptRecord[], id: string): AttemptRecord | undefined
{
    return attempts.find((attempt) => attempt.id === id || attempt.id.endsWith(id));
}

// A lease is held for exactly as long as its attempt runs. Deriving it from
// attempt state rather than recording a separate holder is what keeps a
// killed daemon from leaking the slot forever.
export function heldLeases(attempts: AttemptRecord[]): Map<string, string>
{
    const held = new Map<string, string>();
    for (const attempt of attempts)
    {
        if (attempt.state === "running" && attempt.lease !== null && !held.has(attempt.lease))
        {
            held.set(attempt.lease, attempt.id);
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
