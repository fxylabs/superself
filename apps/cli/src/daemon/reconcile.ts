import { bootId } from "../attempt/boundary.js";
import { AttemptPlan } from "../attempt/plan.js";
import { scopeFor } from "../attempt/redact.js";
import { nextFence, recordAttemptEvent, settleConfirmedExit } from "../attempt/run.js";
import { BUSY, trySettling } from "../attempt/settlement.js";
import { AttemptStatus, deadVerdict, DeadVerdict, DRIVEN_STATES, listSpools, ownerOf, Spool } from "../attempt/spool.js";
import { treeAlive, treeContain } from "../attempt/tree.js";
import { ProjectContext } from "../paths.js";

// What one tick decided about one attempt. The disposition is the whole of the
// decision: an attempt is being driven, or it is not and this is what became
// of it. Nothing here infers success from an exit code or from what the agent
// wrote about itself — a run reaches `settled` only through the completion
// gate, and everything the gate cannot judge reaches a typed failure instead.
//
// `held` is the tick declining to act: the launch still holds a process that
// rode out containment, or another settler holds the attempt right now. Neither
// releases the work unit, and both are looked at again on the next tick.
export type Disposition = "live" | "settled" | "gate-failed" | "unreconciled" | "held";

export interface Reconciled
{
    attempt: string;
    work: string;
    disposition: Disposition;
    detail?: string;
}

// The attempts this project owns on this machine, judged against the process
// table rather than against the state each spool last managed to write. The
// pass is a function of what is observable: an attempt it settles or declares
// dead is terminal afterwards, so running it again finds nothing left to do.
export async function reconcileProject(ctx: ProjectContext, now: Date): Promise<Reconciled[]>
{
    const boot = bootId();
    const decided: Reconciled[] = [];
    for (const spool of listSpools())
    {
        const status = spool.status();
        // An attempt of another project settles in that project's own log,
        // from that project's own checkout: the branch an event is stamped
        // with is the checkout the command ran in, and this daemon holds one.
        if (status === null || status.project !== ctx.project || !DRIVEN_STATES.includes(status.state))
        {
            continue;
        }
        const verdict = deadVerdict(spool, status, boot, now.getTime());
        if (verdict === null)
        {
            decided.push({ attempt: status.attempt, work: status.work, disposition: "live" });
            continue;
        }
        decided.push(await disposeOf(ctx, spool, status, boot, now));
    }
    return decided;
}

// Nothing terminal is written except behind the attempt's settlement lock, and
// the tick never waits for it. A settlement in flight is invisible in
// everything the verdict above reads — a launcher inside the completion gate is
// not the process the status names, and the gate outlasts a supervision
// interval easily — so an attempt somebody is already settling is left to them
// and looked at again next tick. Two ticks racing each other resolve the same
// way: exactly one holds the lock, and the report that cannot be taken back is
// appended once.
async function disposeOf(ctx: ProjectContext, spool: Spool, status: AttemptStatus, boot: string, now: Date): Promise<Reconciled>
{
    const taken = await trySettling(status.attempt, async () => underLock(ctx, spool, status, boot, now));
    return taken === BUSY ? held(status, "another settlement of this attempt is already in flight") : taken;
}

// Judged again from what is on disk now. Between the pass that listed this
// spool and the lock this holds, the settler in front may have finished it: the
// verdict that reached here was read before anything was exclusive, and acting
// on it afterwards would be the check-then-act the lock exists to close.
async function underLock(ctx: ProjectContext, spool: Spool, status: AttemptStatus, boot: string, now: Date): Promise<Reconciled>
{
    const current = spool.status();
    if (current === null || !DRIVEN_STATES.includes(current.state))
    {
        return held(status, "another settler finished this attempt while this tick was reaching it");
    }
    const verdict = deadVerdict(spool, current, boot, now.getTime());
    if (verdict === null)
    {
        return { attempt: current.attempt, work: current.work, disposition: "live" };
    }
    return await takeOver(ctx, spool, current, verdict);
}

async function takeOver(ctx: ProjectContext, spool: Spool, status: AttemptStatus, verdict: DeadVerdict): Promise<Reconciled>
{
    // Before anything terminal is written. Releasing the work unit while the
    // group its launch created still holds a process would seat a second owner
    // beside the processes of the first, so whatever survived is contained
    // first and an attempt that rides out the containment stays held.
    const owner = ownerOf(spool);
    if (owner !== null && treeAlive(owner))
    {
        const survivors = await treeContain(owner);
        spool.append("events.jsonl", { event: "run.contained", contained: survivors.length === 0 });
        if (survivors.length > 0)
        {
            return held(status, `${survivors.length} process(es) this launch started survived containment`);
        }
    }
    // Taken over the way every owner takes an attempt over — by minting a
    // newer fence — so an owner that was wrongly declared dead, or one that
    // comes back mid-settlement, finds the attempt is no longer its to act on.
    const fence = nextFence();
    spool.claim(fence);
    const plan = spool.readJson<AttemptPlan>("plan.json");
    if (verdict.exitSource === "confirmed" && plan !== null)
    {
        return await settleConfirmed(ctx, spool, status, plan, fence);
    }
    return markUnreconciled(ctx, spool, status, verdict, plan, fence);
}

// A confirmed exit is the one exit anybody may draw a conclusion from, and the
// conclusion is still the gate's rather than this pass's. What the daemon adds
// is that nobody has to be at a terminal for it to be reached.
async function settleConfirmed(ctx: ProjectContext, spool: Spool, status: AttemptStatus, plan: AttemptPlan, fence: number): Promise<Reconciled>
{
    spool.setScope(scopeFor(plan.capabilities.secrets));
    spool.setStatus({ fence });
    // The report is idempotent inside the gate, keyed by the attempt id it
    // already carries, so a second observation of the same exit attaches
    // nothing. What only this call can do is the terminal write the
    // interrupted settlement never reached — without it the attempt is judged
    // dead again on every tick from here on.
    const result = await settleConfirmedExit(ctx, plan, spool, status.attempt);
    if (result === null)
    {
        const missing: DeadVerdict = { reason: "the exit was reported and the run left no result envelope", exitSource: "confirmed" };
        return markUnreconciled(ctx, spool, status, missing, plan, fence);
    }
    const published = spool.readJson<unknown[]>("published.json") ?? [];
    if (result.state !== "completed")
    {
        return { attempt: status.attempt, work: status.work, disposition: "gate-failed", detail: result.detail };
    }
    return { attempt: status.attempt, work: status.work, disposition: "settled", detail: `${published.length} artifact(s) published` };
}

// Neither an owner that disappeared nor one that went quiet said anything
// about what its run produced. The honest verdict is that the attempt exited
// without being reconciled, and the spool it wrote is kept exactly as it is:
// the raw output, the checkpoints and the receipt are the whole of what a
// person or a later run has to work from.
function markUnreconciled(ctx: ProjectContext, spool: Spool, status: AttemptStatus, verdict: DeadVerdict, plan: AttemptPlan | null, fence: number): Reconciled
{
    spool.setStatus({
        state: "exited-unreconciled",
        failure: "unknown",
        detail: verdict.reason,
        exitSource: verdict.exitSource,
        exitCode: verdict.exitSource === "confirmed" ? status.exitCode : undefined,
        fence
    });
    spool.append("events.jsonl", { event: "run.recovered", detail: verdict.reason, exitSource: verdict.exitSource });
    if (plan !== null)
    {
        recordAttemptEvent(ctx, plan, "run.failed", status.attempt, { failure: "unknown", detail: verdict.reason, exitSource: verdict.exitSource });
    }
    return { attempt: status.attempt, work: status.work, disposition: "unreconciled", detail: verdict.reason };
}

function held(status: AttemptStatus, detail: string): Reconciled
{
    return { attempt: status.attempt, work: status.work, disposition: "held", detail };
}
