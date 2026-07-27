import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runnerStateDir } from "../machine.js";
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

export interface BreakerRecord
{
    provider: string;
    failures: number;
    state: "closed" | "open";
    openedAt?: string;
    lastFailure?: string;
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

function writeBreaker(record: BreakerRecord): void
{
    const file = breakerFile(record.provider);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file + ".tmp", JSON.stringify(record, null, 2) + "\n");
    renameSync(file + ".tmp", file);
}

// An open breaker that has cooled down lets exactly one attempt through. That
// trial either closes it or opens it again; it never half-opens for a queue.
export function breakerVerdict(provider: string, policy: BreakerPolicy, now: Date): BreakerVerdict
{
    const record = readBreaker(provider);
    if (record.state !== "open" || record.openedAt === undefined)
    {
        return "closed";
    }
    return now.getTime() - new Date(record.openedAt).getTime() >= policy.cooldownMs ? "half-open" : "open";
}

export function recordProviderFailure(provider: string, policy: BreakerPolicy, now: Date): BreakerRecord
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
        // Each further failure restarts the cooldown: a provider that is still
        // down must not be re-tried on the schedule of the first outage.
        next.openedAt = now.toISOString();
    }
    writeBreaker(next);
    return next;
}

export function recordProviderSuccess(provider: string): void
{
    writeBreaker({ provider, failures: 0, state: "closed" });
}

export function resetBreaker(provider: string): void
{
    recordProviderSuccess(provider);
}
