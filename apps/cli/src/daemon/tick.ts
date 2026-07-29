import { listSpools } from "../attempt/spool.js";
import { AttemptPlan } from "../attempt/plan.js";
import { BREAKER_DEFAULT } from "../attempt/retry.js";
import { ProjectContext } from "../paths.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { noteCapacityRefusal } from "./circuits.js";
import { Disposition, Reconciled, reconcileProject } from "./reconcile.js";
import { emptyCounts, TickCounts } from "./state.js";
import { POLICY_OUTCOMES, WakeDecision, wakeReady } from "./wake.js";

export interface TickSummary extends TickCounts
{
    at: string;
    attempts: Reconciled[];
    wakes: WakeDecision[];
}

// The dispositions that end an attempt. Each one frees the work unit it was
// driving, and none of them can be re-entered: an attempt that reached one of
// these is terminal, which is what makes a second tick a no-op.
const TERMINAL: Disposition[] = ["settled", "gate-failed", "unreconciled"];

// One iteration, in the order the four steps depend on each other: nothing can
// be settled before liveness is decided, nothing is released before it is
// settled, and nothing is woken onto a work unit something else still holds.
//
// Every step is a function of state that is already durable, so a tick is
// safe to run at any moment and safe to run again immediately: the second run
// finds each attempt terminal and each generation materialized, and does
// nothing at all.
export async function runTick(ctx: ProjectContext, now: Date): Promise<TickSummary>
{
    const attempts = await reconcileProject(ctx, now);
    const finished = attempts.filter((item) => TERMINAL.includes(item.disposition));
    noteCapacity(ctx, now);
    for (const item of finished)
    {
        release(ctx, item);
    }
    const wakes = wakeReady(ctx, now);
    return { at: now.toISOString(), attempts, wakes, ...countOf(attempts, wakes) };
}

function countOf(attempts: Reconciled[], wakes: WakeDecision[]): TickCounts
{
    const counts = emptyCounts();
    for (const item of attempts)
    {
        counts.live += item.disposition === "live" ? 1 : 0;
        counts.settled += item.disposition === "settled" ? 1 : 0;
        counts.unreconciled += item.disposition === "unreconciled" || item.disposition === "gate-failed" ? 1 : 0;
        counts.held += item.disposition === "held" ? 1 : 0;
        counts.released += TERMINAL.includes(item.disposition) ? 1 : 0;
    }
    for (const wake of wakes)
    {
        counts.woken += wake.outcome === "woken" ? 1 : 0;
        // Deferred is "nothing was spent and nothing failed, and a later tick
        // decides again" — which is exactly what a provider reset and an
        // overnight policy each leave behind.
        counts.deferred += wake.outcome === "circuit-open" || wake.outcome === "waiting-reset" || POLICY_OUTCOMES.includes(wake.outcome) ? 1 : 0;
    }
    return counts;
}

// A work unit is held by a live attempt and by nothing else, so releasing one
// is not a write — it is what has already become true the moment its attempt
// stopped being live. What is recorded is that it happened and which attempt
// let go, because the next dispatch of that unit is otherwise unexplained.
function release(ctx: ProjectContext, item: Reconciled): void
{
    recordEvent(
        ctx,
        makeEvent(ctx.project, "run.released", { attempt: item.attempt, disposition: item.disposition }, { work: item.work, attempt: item.attempt }),
        `${item.work} released by ${item.attempt}`
    );
}

// The mark that this refusal has already bought its reset. It lives on the
// attempt rather than on the breaker: the breaker is one record shared by
// every attempt on the provider and an operator may reset it at any moment,
// and a refusal that re-armed itself after that reset would be an operator's
// "try it now" quietly overruled by a failure they had already answered.
const CAPACITY_FILE = "capacity.json";

// A provider that refused this machine on capacity buys one redispatch after
// its reset. The refusal is read off the attempts themselves rather than
// tracked as the tick runs: a run the supervisor never watched — one a person
// started, or one a wake handed to a detached runner — records exactly the
// same typed failure, and it has to buy the same reset.
function noteCapacity(ctx: ProjectContext, now: Date): void
{
    for (const spool of listSpools())
    {
        const status = spool.status();
        // A run that actually failed on the class, not one the open circuit
        // kept queued: `waiting-provider` carries the same class and spent
        // nothing, and the circuit it is waiting on is already the thing
        // holding its redispatch back.
        if (status === null || status.project !== ctx.project || status.state !== "failed" || status.failure !== "transient-provider")
        {
            continue;
        }
        // A refusal older than the reset it would arm is not news. Retention
        // keeps a spool for thirty days, and the first tick after an upgrade
        // finds every one of them without this mark — arming a fresh sixty
        // second hold on their providers for refusals an operator dealt with
        // days ago, against dispatches that have nothing to do with them.
        if (spool.readJson(CAPACITY_FILE) !== null || aged(status.updated, now))
        {
            continue;
        }
        const provider = status.provider ?? spool.readJson<AttemptPlan>("plan.json")?.capabilities.provider?.name;
        if (provider === undefined)
        {
            continue;
        }
        const retryAt = noteCapacityRefusal(provider, status.attempt, now);
        // Written after the reset is on the breaker, so a supervisor that dies
        // between the two arms it again rather than losing it.
        spool.writeJson(CAPACITY_FILE, { provider, retryAt, notedAt: now.toISOString() });
    }
}

// Whether a refusal is older than the hold arming it would put on the provider.
// The cooldown is the whole life of a reset, so a refusal that predates one has
// already outlived anything this could say about the provider now.
function aged(updated: string, now: Date): boolean
{
    const at = new Date(updated).getTime();
    return Number.isFinite(at) && now.getTime() - at > BREAKER_DEFAULT.cooldownMs;
}
