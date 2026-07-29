import { runAttemptId } from "../ids.js";
import { CliContext } from "../paths.js";
import { identityOf } from "./boundary.js";
import { classify } from "./classify.js";
import { NO_ENVELOPE, ResultEnvelope } from "./gate.js";
import { AttemptPlan } from "./plan.js";
import { adapterOf, runPreflight } from "./preflight.js";
import { redact, scopeFor } from "./redact.js";
import { AttemptResult, blockOnCapability, childEnv, claimWorkUnit, completeAttempt, failAttempt, localChecks, nextFence, prepareSpool, recordAttemptEvent, RunOptions } from "./run.js";
import { AttemptStatus, openSpool, ownerOf, OWNER_FILE, Spool } from "./spool.js";
import { alive, OwnedTree, ownedTree, processGroup, processStartTime, treeAlive, treeContain } from "./tree.js";
import { CliError } from "../types.js";

type ProjectContext = CliContext & { project: string; projectDir: string };

// The environment the launcher must give the process it starts. The runner
// hands its own child exactly this, so a process somebody else launched writes
// its result, its checkpoints and its evidence to the same places the runner
// would have read them from.
export const ENV_FILE = "env.json";

// A spool and a proven capability receipt, and no process at all. Everything
// `self attempt run` does before it spawns anything, stopped one step short of
// the spawn — so the launch itself can be a scheduler, a wrapper script, or a
// person, and the attempt is still the same durable object.
export async function registerAttempt(ctx: ProjectContext, plan: AttemptPlan, options: RunOptions): Promise<AttemptResult>
{
    const id = runAttemptId();
    const fence = nextFence();
    // No claim of the work unit here. A registered attempt owns no process,
    // and a work unit is held against a live owner rather than against a plan
    // somebody wrote down — a scheduler that registers ahead of time must not
    // be the reason the attempt actually driving the unit cannot be claimed.
    const spool = prepareSpool(ctx, plan, id, fence, "registered", options);
    const receipt = await runPreflight(plan, id, fence, identityOf(plan.boundary), localChecks(ctx, plan));
    spool.writeJson("preflight.json", receipt);
    if (!receipt.ok)
    {
        return blockOnCapability(ctx, plan, spool, id, receipt);
    }
    // Run 1 by construction: a registered attempt is launched once by whoever
    // registered it, and a replacement run is a launch of its own.
    spool.writeJson(ENV_FILE, childEnv(spool, id, 1, null));
    spool.append("events.jsonl", { event: "run.registered" });
    console.log(id);
    return { attempt: id, state: "registered" };
}

// The launcher naming the process it started. Ownership is claimed the way
// every other owner claims it — by minting a newer fence — so a stale claim
// arriving after a takeover is refused by the same discipline that refuses a
// stale runner's status write.
export function claimStarted(ctx: ProjectContext, id: string, pid: number): AttemptStatus
{
    const spool = openSpool(id);
    const status = requireStatus(spool, id);
    const plan = requirePlan(spool, id);
    spool.setScope(scopeFor(plan.capabilities.secrets));
    requireOwningProject(ctx, status);
    if (status.state !== "registered")
    {
        throw new CliError(`attempt ${id} is ${status.state} — only an attempt registered with \`self attempt register\` can be claimed by a launcher`);
    }
    if (!alive(pid))
    {
        throw new CliError(`no process ${pid} is running — an attempt is claimed by the launcher that started it, while it is still there to claim`);
    }
    // The pid leads its own group when the launcher started it detached, and
    // is a member of somebody else's when it did not. Either way the group is
    // read from the kernel rather than assumed, and the launch instant is
    // read with it — and the reads race the process. A pid that died between
    // the liveness check and these reads answers nothing, and a claim
    // recorded without its launch instant has no recycled-group guard for
    // the rest of its life, so a claim the table cannot time is refused
    // rather than taken blind.
    const pgid = processGroup(pid);
    const startedAt = processStartTime(pid);
    if (pgid === null || startedAt === null || !alive(pid))
    {
        throw new CliError(`the process table could not time process ${pid} — an attempt is claimed while its process is there to be read, so start it again and claim it then`);
    }
    // The launch instant of whoever leads the group, beside the payload's
    // own: a recycled group id arrives with a new leader wearing the same
    // number, and the leader's start is the identity that refuses it. Where
    // the payload leads its own group the two instants are one.
    const leaderStartedAt = pgid === pid ? startedAt : processStartTime(pgid);
    // The same per-work claim the runner takes for its own child: admission
    // and the writes that make this claim observable happen under the one
    // lock every claim of the unit serializes on.
    return claimWorkUnit(status.work, () =>
    {
        const fence = nextFence();
        spool.claim(fence);
        const tree = ownedTree(id, fence, pid, pgid, startedAt, leaderStartedAt);
        spool.writeJson(OWNER_FILE, tree);
        spool.heartbeat(pid);
        const next = spool.setStatus({ state: "running", run: 1, runs: 1, fence, pid });
        spool.append("events.jsonl", { event: "run.started", run: 1, external: true });
        recordAttemptEvent(ctx, plan, "run.started", id, { role: plan.role, provider: plan.capabilities.provider?.name, adapter: adapterOf(plan.boundary) });
        return next;
    });
}

// The liveness mark, written by whoever is watching the process rather than by
// the process itself. It goes through the fence like every other write: a
// launcher whose attempt was taken over stops here rather than keeping a
// replaced attempt looking alive.
export function externalHeartbeat(id: string): void
{
    const spool = openSpool(id);
    const status = requireStatus(spool, id);
    const owner = requireOwner(spool, id);
    if (status.state !== "running")
    {
        throw new CliError(`attempt ${id} is ${status.state} — only a running attempt takes a heartbeat`);
    }
    spool.claim(owner.fence);
    spool.assertOwned();
    spool.heartbeat(status.pid ?? process.pid);
}

// The exit the launcher watched happen, which is the one exit anybody may draw
// a conclusion from. Everything after it is the runner's ordinary settlement:
// the completion gate on a clean exit with a completed envelope, a typed
// failure otherwise.
export async function externalExited(ctx: ProjectContext, id: string, code: number, options: RunOptions): Promise<AttemptResult>
{
    const spool = openSpool(id);
    const status = requireStatus(spool, id);
    const plan = requirePlan(spool, id);
    spool.setScope(scopeFor(plan.capabilities.secrets));
    const owner = requireOwner(spool, id);
    requireOwningProject(ctx, status);
    if (status.state !== "running")
    {
        throw new CliError(`attempt ${id} is ${status.state} — only a running attempt has an exit to report`);
    }
    spool.claim(owner.fence);
    spool.setStatus({ exitSource: "confirmed", exitCode: code });
    spool.append("events.jsonl", { event: "run.ended", run: status.run, exit: code, external: true });
    // The exit the launcher watched was its process's, not the whole
    // launch's: a child the payload left in its group is still running right
    // now, and settlement below ends in a terminal write that releases the
    // work unit. Whatever survived is contained first, and settlement is
    // refused while anything rides out the containment — the confirmed exit
    // above keeps, and reporting again once the group is gone finishes it.
    if (treeAlive(owner))
    {
        const survivors = await treeContain(owner);
        spool.append("events.jsonl", { event: "run.contained", contained: survivors.length === 0 });
        if (survivors.length > 0)
        {
            throw new CliError(`attempt ${id} still has ${survivors.length} process(es) its launch started (pid ${survivors.join(", ")}) — they survived containment, so report the exit again once they are gone`);
        }
    }
    const envelope = spool.readJson<ResultEnvelope>("result.json");
    if (code === 0 && envelope !== null && envelope.status === "completed")
    {
        return await completeAttempt(ctx, plan, spool, id, envelope);
    }
    const failure = classify({ declared: envelope?.failure?.class, exitCode: code, signal: null, stderr: "", timedOut: false });
    const detail = redact((envelope?.failure?.message ?? (envelope === null ? NO_ENVELOPE : `exit ${code}`)).slice(0, 400));
    spool.append("runs.jsonl", { run: status.run, exit: code, failure, external: true });
    return failAttempt(ctx, plan, spool, id, failure, detail, true, options);
}

function requireStatus(spool: Spool, id: string): AttemptStatus
{
    const status = spool.status();
    if (status === null)
    {
        throw new CliError(`attempt "${id}" has no status record`);
    }
    return status;
}

function requirePlan(spool: Spool, id: string): AttemptPlan
{
    const plan = spool.readJson<AttemptPlan>("plan.json");
    if (plan === null)
    {
        throw new CliError(`attempt "${id}" has no plan record — it cannot be driven from outside`);
    }
    return plan;
}

// Reporting an exit is the one thing a launcher does after its process is
// already gone, so nothing here asks whether the group is still alive. What
// the record has to carry is which claim this is — the fence — and that is
// what the writes below are checked against.
function requireOwner(spool: Spool, id: string): OwnedTree
{
    const owner = ownerOf(spool);
    if (owner === null)
    {
        throw new CliError(`attempt ${id} was not claimed by a launcher — \`self attempt started ${id} --pid <pid>\` claims it first`);
    }
    return owner;
}

// The report and the events belong to the project the attempt was registered
// in, and the checkout an event is stamped with is the one the command ran in.
// A launcher run somewhere else would attach this attempt's result to the
// wrong project's log.
function requireOwningProject(ctx: ProjectContext, status: AttemptStatus): void
{
    if (status.project !== ctx.project)
    {
        throw new CliError(`attempt ${status.attempt} belongs to project ${status.project} — run this from that project's checkout, so its result is recorded in its own log`);
    }
}
