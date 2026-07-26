import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { leaseId } from "./ids.js";
import { buildModel, isClosed, ProjectModel, queueOrder, WorkState } from "./model.js";
import { ProjectContext } from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { dim, styled } from "./style.js";
import { CliError, requireText } from "./types.js";

const DEFAULT_LEASE_SECONDS = 900;

// A lease hands one ready unit to one worker for a bounded time. Re-claiming
// under a live lease returns the same unit instead of taking a second one, so
// a worker that restarts mid-run picks up where it was rather than doubling up.
export function claimWork(ctx: ProjectContext, args: string[]): void
{
    const { values } = parseArgs({
        args,
        options: { worker: { type: "string" }, lease: { type: "string" }, json: { type: "boolean" } }
    });
    const worker = workerName(values.worker);
    const json = values.json === true;
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const held = model.works.find((work) => work.lease?.worker === worker && !work.leaseExpired && work.status === "active");
    if (held !== undefined)
    {
        announce(held, held.lease?.id, json, `${worker} already holds`);
        return;
    }
    const next = queueOrder(model)[0];
    if (next === undefined)
    {
        console.log(json ? JSON.stringify({ work: null, reason: "queue is empty" }) : "nothing ready to lease");
        return;
    }
    const lease = leaseId();
    const expires = expiryFrom(values.lease);
    const payload = { work: next.id, worker, lease, expires };
    recordEvent(ctx, makeEvent(ctx.project, "work.leased", payload, { work: next.id }), `${next.id} ${worker}`, json);
    announce(next, lease, json, `${worker} leased`);
}

function announce(work: WorkState, lease: string | undefined, json: boolean, what: string): void
{
    if (json)
    {
        console.log(JSON.stringify({ work: work.id, outcome: work.outcome, lease, worker: work.lease?.worker }));
        return;
    }
    console.log(`${what} ${work.id}  ${work.outcome}`);
}

export function heartbeatWork(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { lease: { type: "string" }, worker: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const work = requireLeased(ctx, positionals[0], values.worker);
    const expires = expiryFrom(values.lease);
    const payload = { work: work.id, lease: work.lease?.id, expires };
    recordEvent(ctx, makeEvent(ctx.project, "work.heartbeat", payload, { work: work.id }), `${work.id} until ${expires}`, values.json === true);
    if (values.json === true)
    {
        console.log(JSON.stringify({ work: work.id, lease: work.lease?.id, expires }));
    }
}

export function releaseWork(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { why: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const work = requireLeased(ctx, positionals[0], undefined);
    release(ctx, work, values.why ?? "released by its worker", values.json === true);
    if (values.json === true)
    {
        console.log(JSON.stringify({ work: work.id, released: true }));
    }
}

// Recovery is the startup verb: a process that died holding leases left units
// that no one is working and no one else may take. Requeueing them is safe
// because a lease grants time, never a side effect — the work itself is
// guarded by its own report and evidence.
export function recoverWork(ctx: ProjectContext, args: string[]): void
{
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
    const json = values.json === true;
    const expired = buildModel(ctx.storeDir, ctx.project, new Date()).works.filter((work) => work.leaseExpired);
    for (const work of expired)
    {
        release(ctx, work, `lease held by ${work.lease?.worker} expired`, json);
    }
    if (json)
    {
        console.log(JSON.stringify({ recovered: expired.map((work) => work.id) }));
        return;
    }
    console.log(expired.length === 0
        ? "no expired leases — nothing to recover"
        : `requeued ${expired.length} work unit${expired.length === 1 ? "" : "s"}: ${expired.map((work) => work.id).join(", ")}`);
}

function release(ctx: ProjectContext, work: WorkState, why: string, json: boolean): void
{
    const payload = { work: work.id, lease: work.lease?.id, why };
    recordEvent(ctx, makeEvent(ctx.project, "work.released", payload, { work: work.id }), `${work.id} ${why}`, json);
}

export function cancelWork(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { why: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const work = requireLiveWork(ctx, positionals[0]);
    const why = requireText(values.why, `work cancel <work-id> --why "<reason>"`);
    recordEvent(ctx, makeEvent(ctx.project, "work.cancelled", { work: work.id, why }, { work: work.id }, true), `${work.id} ${why}`, values.json === true);
    if (values.json === true)
    {
        console.log(JSON.stringify({ work: work.id, status: "cancelled" }));
    }
}

export function prioritizeWork(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, allowPositionals: true });
    const work = requireLiveWork(ctx, positionals[0]);
    const priority = Number.parseInt(requireText(positionals[1], "work priority <work-id> <number>"), 10);
    if (Number.isNaN(priority))
    {
        throw new CliError("work priority expects a number — lower runs sooner");
    }
    recordEvent(ctx, makeEvent(ctx.project, "work.prioritized", { work: work.id, priority }, { work: work.id }, true), `${work.id} priority ${priority}`, values.json === true);
    if (values.json === true)
    {
        console.log(JSON.stringify({ work: work.id, priority }));
    }
}

export function dependWork(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { on: { type: "string", multiple: true }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireLiveWork(ctx, positionals[0]);
    const on = (values.on ?? []).map((id) => requireDependency(model, work, id));
    if (on.length === 0)
    {
        throw new CliError("usage: self work depend <work-id> --on <work-id> [--on <work-id>]");
    }
    recordEvent(ctx, makeEvent(ctx.project, "work.depends", { work: work.id, on }, { work: work.id }, true), `${work.id} on ${on.join(", ")}`, values.json === true);
    if (values.json === true)
    {
        console.log(JSON.stringify({ work: work.id, dependsOn: on }));
    }
}

// A cycle would leave both units permanently unready with nothing to point at,
// so the edge that would close one is refused at the moment it is asserted.
function requireDependency(model: ProjectModel, work: WorkState, id: string): string
{
    if (id === work.id)
    {
        throw new CliError(`${work.id} cannot depend on itself`);
    }
    const target = model.works.find((item) => item.id === id);
    if (target === undefined)
    {
        throw new CliError(`unknown work id "${id}" — run \`self work\` to list ids`);
    }
    if (reaches(model, target, work.id))
    {
        throw new CliError(`${id} already waits on ${work.id} — that dependency would deadlock both units`);
    }
    return id;
}

function reaches(model: ProjectModel, from: WorkState, target: string): boolean
{
    const seen = new Set<string>();
    const queue = [...from.dependsOn];
    while (queue.length > 0)
    {
        const id = queue.shift() as string;
        if (id === target)
        {
            return true;
        }
        if (seen.has(id))
        {
            continue;
        }
        seen.add(id);
        queue.push(...(model.works.find((item) => item.id === id)?.dependsOn ?? []));
    }
    return false;
}

// The approval boundary: a unit that needs a person's yes stops being ready
// until they give it, and no worker can lease its way past that.
export function requireApproval(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { why: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const work = requireLiveWork(ctx, positionals[0]);
    const why = requireText(values.why, `work approval <work-id> --why "<what needs approving>"`);
    recordEvent(ctx, makeEvent(ctx.project, "work.approval.required", { work: work.id, why }, { work: work.id }), `${work.id} ${why}`, values.json === true);
    if (values.json === true)
    {
        console.log(JSON.stringify({ work: work.id, waiting: "approval", why }));
    }
}

export function approveWork(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, allowPositionals: true });
    const work = requireLiveWork(ctx, positionals[0]);
    if (work.approval === undefined)
    {
        throw new CliError(`${work.id} is not waiting on approval`);
    }
    recordEvent(ctx, makeEvent(ctx.project, "work.approved", { work: work.id }, { work: work.id }, true), `${work.id} ${work.approval.why}`, values.json === true);
    if (values.json === true)
    {
        console.log(JSON.stringify({ work: work.id, approved: true }));
    }
}

export function printQueue(ctx: ProjectContext, args: string[]): void
{
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const ready = queueOrder(model);
    if (values.json === true)
    {
        console.log(JSON.stringify(ready.map((work) => ({ work: work.id, outcome: work.outcome, priority: work.priority }))));
        return;
    }
    if (ready.length === 0)
    {
        console.log("nothing ready to lease");
        return;
    }
    for (const work of ready)
    {
        const priority = `p${work.priority}`;
        console.log(`${styled ? dim(work.id) : work.id}  ${styled ? dim(priority) : priority}  ${work.outcome}`);
    }
}

function requireLiveWork(ctx: ProjectContext, id: string | undefined): WorkState
{
    const wanted = requireText(id, "… <work-id> — run `self work` to list ids");
    const work = buildModel(ctx.storeDir, ctx.project, new Date()).works.find((item) => item.id === wanted);
    if (work === undefined)
    {
        throw new CliError(`unknown work id "${wanted}" — run \`self work\` to list ids`);
    }
    if (isClosed(work))
    {
        throw new CliError(`${wanted} is already ${work.status}`);
    }
    return work;
}

function requireLeased(ctx: ProjectContext, id: string | undefined, worker: string | undefined): WorkState
{
    const work = requireLiveWork(ctx, id);
    if (work.lease === undefined)
    {
        throw new CliError(`${work.id} holds no lease — claim it with \`self work claim\` first`);
    }
    if (work.leaseExpired)
    {
        throw new CliError(`${work.id}'s lease expired — run \`self work recover\` and claim it again`);
    }
    if (worker !== undefined && worker !== work.lease.worker)
    {
        throw new CliError(`${work.id} is leased by ${work.lease.worker}, not ${worker}`);
    }
    return work;
}

function workerName(name: string | undefined): string
{
    const worker = name ?? process.env.SUPERSELF_WORKER ?? `${hostname()}-${process.pid}`;
    if (worker.trim() === "")
    {
        throw new CliError("a lease needs a worker name — pass --worker <name> or set SUPERSELF_WORKER");
    }
    return worker;
}

function expiryFrom(seconds: string | undefined): string
{
    const span = seconds === undefined ? DEFAULT_LEASE_SECONDS : Number.parseInt(seconds, 10);
    if (Number.isNaN(span) || span <= 0)
    {
        throw new CliError("--lease expects a positive number of seconds");
    }
    return new Date(Date.now() + span * 1000).toISOString();
}
