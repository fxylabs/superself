import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runnerStateDir } from "../machine.js";
import { withLock, writeAtomic } from "./atomic.js";
import { RetryPlan } from "./plan.js";

export interface Backoff
{
    capMs: number;
    jitter: number;
    delayMs: number;
}

// Exponential with a cap, then jitter across the lower half of the window.
// Two attempts that failed on the same provider outage must not come back at
// the same instant and repeat it.
export function backoffFor(run: number, retry: RetryPlan, random: () => number = jitterSource): Backoff
{
    const capMs = Math.min(retry.maxMs, retry.baseMs * Math.pow(2, Math.max(0, run - 1)));
    const jitter = clamp(random());
    return { capMs, jitter, delayMs: Math.round(capMs / 2 + capMs / 2 * jitter) };
}

// Tests need a reproducible schedule without giving up the jitter itself, so
// the source of randomness is the one thing they may pin.
function jitterSource(): number
{
    const pinned = process.env.SUPERSELF_RETRY_JITTER;
    return pinned === undefined ? Math.random() : Number(pinned);
}

function clamp(value: number): number
{
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BreakerPolicy
{
    threshold: number;
    cooldownMs: number;
}

// How many failures in a row open a provider's circuit, and how long it stays
// open. One policy, so the runner that pushes the breaker and the supervisor
// that reads it are never judging the same record by different numbers.
export const BREAKER_DEFAULT: BreakerPolicy = { threshold: 3, cooldownMs: 60_000 };

export interface BreakerRecord
{
    provider: string;
    failures: number;
    state: "closed" | "open";
    openedAt?: string;
    lastFailure?: string;
    // When the cooled-down trial was taken, and by which attempt. Without it
    // every attempt that arrives after the cooldown reads "cooled down" and
    // they all go at once — the herd the breaker exists to prevent.
    trialAt?: string;
    trialBy?: string;
    // The instant a provider that refused this machine on capacity may be
    // asked again, and the attempt whose refusal set it. A capacity refusal is
    // not an outage — the provider answered, and it answered "not now" — so it
    // buys one redispatch after the reset rather than a place in the retry
    // schedule of a run that already ended. The attempt is kept beside it so
    // one refusal sets one reset however many times the record is read.
    retryAt?: string;
    retryFor?: string;
}

export type BreakerVerdict = "closed" | "half-open" | "open";

// One outage must not be re-learned by every queued attempt in turn. The
// breaker is machine-local and keyed by provider, so the second attempt in a
// queue reads the first one's evidence instead of paying for it again.
export function breakerFile(provider: string): string
{
    const key = createHash("sha256").update(provider).digest("hex").slice(0, 16);
    return join(runnerStateDir(), "breakers", `${key}.json`);
}

export function readBreaker(provider: string): BreakerRecord
{
    const file = breakerFile(provider);
    if (!existsSync(file))
    {
        return { provider, failures: 0, state: "closed" };
    }
    try
    {
        return JSON.parse(readFileSync(file, "utf8")) as BreakerRecord;
    }
    catch
    {
        return { provider, failures: 0, state: "closed" };
    }
}

export function writeBreaker(record: BreakerRecord): void
{
    writeAtomic(breakerFile(record.provider), JSON.stringify(record, null, 2) + "\n");
}

// What the record says right now, without taking anything. `self attempt
// breaker` and any other reader wants this; a runner about to spend an attempt
// wants admitAttempt(), which decides and leases in one step.
export function breakerVerdict(provider: string, policy: BreakerPolicy, now: Date): BreakerVerdict
{
    const record = readBreaker(provider);
    if (record.state !== "open" || record.openedAt === undefined)
    {
        return "closed";
    }
    if (now.getTime() - new Date(record.openedAt).getTime() < policy.cooldownMs)
    {
        return "open";
    }
    return trialInFlight(record, policy, now) ? "open" : "half-open";
}

// An open breaker that has cooled down lets exactly one attempt through. The
// trial is leased in the record under the lock that writes it, so the attempts
// queued behind one outage cannot all read "cooled down" and arrive together.
// That trial either closes the breaker or opens it again; it never half-opens
// for a queue.
export function admitAttempt(provider: string, policy: BreakerPolicy, now: Date, attemptId: string): BreakerVerdict
{
    return withLock(breakerFile(provider), () =>
    {
        const verdict = breakerVerdict(provider, policy, now);
        if (verdict === "half-open")
        {
            writeBreaker({ ...readBreaker(provider), trialAt: now.toISOString(), trialBy: attemptId });
        }
        return verdict;
    });
}

// A trial that never answered must not hold the breaker shut for ever: after
// one further cooldown the next attempt may take it instead.
function trialInFlight(record: BreakerRecord, policy: BreakerPolicy, now: Date): boolean
{
    return record.trialAt !== undefined && now.getTime() - new Date(record.trialAt).getTime() < policy.cooldownMs;
}

export function recordProviderFailure(provider: string, policy: BreakerPolicy, now: Date): BreakerRecord
{
    return withLock(breakerFile(provider), () =>
    {
        const record = readBreaker(provider);
        const failures = record.failures + 1;
        const next: BreakerRecord = {
            provider,
            failures,
            state: failures >= policy.threshold ? "open" : "closed",
            lastFailure: now.toISOString()
        };
        if (next.state === "open")
        {
            // Each further failure restarts the cooldown: a provider that is
            // still down must not be re-tried on the schedule of the first
            // outage. The answered trial is dropped with it.
            next.openedAt = now.toISOString();
        }
        writeBreaker(next);
        return next;
    });
}

export function recordProviderSuccess(provider: string): void
{
    withLock(breakerFile(provider), () => writeBreaker({ provider, failures: 0, state: "closed" }));
}

export function resetBreaker(provider: string): void
{
    recordProviderSuccess(provider);
}
