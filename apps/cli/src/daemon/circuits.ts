import { withLock } from "../attempt/atomic.js";
import { breakerFile, breakerVerdict, BREAKER_DEFAULT, BreakerRecord, BreakerVerdict, readBreaker, writeBreaker } from "../attempt/retry.js";

// What the supervisor sees when it asks whether a provider may be fanned out
// to. The verdict is the breaker's own — three consecutive transient failures
// open it and the next success after the cooldown closes it — and the reset is
// the capacity refusal layered over it.
export interface Circuit
{
    provider: string;
    verdict: BreakerVerdict;
    failures: number;
    openedAt?: string;
    retryAt?: string;
}

export function circuitOf(provider: string, now: Date): Circuit
{
    const record = readBreaker(provider);
    const circuit: Circuit = { provider, verdict: breakerVerdict(provider, BREAKER_DEFAULT, now), failures: record.failures };
    if (record.openedAt !== undefined)
    {
        circuit.openedAt = record.openedAt;
    }
    if (record.retryAt !== undefined)
    {
        circuit.retryAt = record.retryAt;
    }
    return circuit;
}

// A provider that answered "not now". The reset is written once per refusal —
// the attempt that suffered it is kept beside the instant — so a record read
// on every tick never pushes its own reset further out, which would be a
// provider this machine never asks again.
export function noteCapacityRefusal(provider: string, attempt: string, now: Date): string | null
{
    return withLock(breakerFile(provider), () =>
    {
        const record = readBreaker(provider);
        if (record.retryFor === attempt)
        {
            return null;
        }
        const retryAt = new Date(now.getTime() + BREAKER_DEFAULT.cooldownMs).toISOString();
        writeBreaker({ ...record, retryAt, retryFor: attempt });
        return retryAt;
    });
}

export type Admission = "admitted" | "circuit-open" | "waiting-reset";

// Whether one dispatch may go to this provider now, decided and consumed in
// one step. An open circuit stops fan-out outright. A reset that has arrived
// is spent here rather than merely read: it buys exactly one redispatch, and a
// tick that runs again a second later must not buy a second one from the same
// refusal.
export function admitDispatch(provider: string | undefined, now: Date): Admission
{
    if (provider === undefined)
    {
        return "admitted";
    }
    return withLock(breakerFile(provider), () =>
    {
        if (breakerVerdict(provider, BREAKER_DEFAULT, now) === "open")
        {
            return "circuit-open";
        }
        const record: BreakerRecord = readBreaker(provider);
        if (record.retryAt === undefined)
        {
            return "admitted";
        }
        if (now.getTime() < new Date(record.retryAt).getTime())
        {
            return "waiting-reset";
        }
        writeBreaker({ ...record, retryAt: undefined });
        return "admitted";
    });
}
