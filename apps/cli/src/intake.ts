import { parseArgs } from "node:util";
import { captureId, workId } from "./ids.js";
import { buildModel, CaptureState, LinkKind, ProjectModel } from "./model.js";
import { ProjectContext } from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { bold, dim, styled } from "./style.js";
import { CliError, EventRefs, requireText, SelfEvent } from "./types.js";

// Kinds a directive can carry against work that already exists. "new" and
// "dropped" have their own verbs because neither takes a target.
const ATTACH_KINDS = ["addition", "supersession", "cancellation", "reprioritization", "status"];

const LINK_USAGE = 'capture link <capture-id> --new "<required outcome>"'
    + " | --work <work-id> --as addition|supersession|cancellation|reprioritization|status";

export function runCapture(ctx: ProjectContext, args: string[]): void
{
    if (args[0] === "list")
    {
        captureList(ctx, args.slice(1));
        return;
    }
    if (args[0] === "show")
    {
        captureShow(ctx, args.slice(1));
        return;
    }
    if (args[0] === "link")
    {
        captureLink(ctx, args.slice(1));
        return;
    }
    if (args[0] === "drop")
    {
        captureDrop(ctx, args.slice(1));
        return;
    }
    captureRecord(ctx, args);
}

// Intake is deliberately the cheapest verb in the CLI: one event, no reading
// of what the directive means. Deciding that is triage's job, and making the
// person wait for it is exactly the coupling this exists to remove.
function captureRecord(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { source: { type: "string" }, key: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const text = requireText(positionals[0], 'capture "<directive>" [--source s] [--key k]');
    const json = values.json === true;
    const repeat = values.key === undefined ? undefined : byKey(ctx, values.key);
    if (repeat !== undefined)
    {
        acknowledge(repeat.id, json, true);
        return;
    }
    const id = captureId();
    const payload: Record<string, unknown> = { capture: id, text };
    if (values.source !== undefined)
    {
        payload.source = values.source;
    }
    if (values.key !== undefined)
    {
        payload.key = values.key;
    }
    recordEvent(ctx, fromHuman(makeEvent(ctx.project, "capture.recorded", payload, undefined, true)), `${id} ${text}`, json);
    acknowledge(id, json, false);
}

// A retried submission must not become a second directive, so a client that
// can repeat itself hands in a key and gets the first id back unchanged.
function byKey(ctx: ProjectContext, key: string): CaptureState | undefined
{
    return model(ctx).captures.find((capture) => capture.key === key);
}

function acknowledge(id: string, json: boolean, duplicate: boolean): void
{
    console.log(json ? JSON.stringify({ capture: id, duplicate }) : id);
}

// The directive is the user's words, whoever typed the command for them.
function fromHuman(event: SelfEvent): SelfEvent
{
    event.origin.actor = "human";
    return event;
}

function captureList(ctx: ProjectContext, args: string[]): void
{
    const { values } = parseArgs({ args, options: { all: { type: "boolean" }, json: { type: "boolean" } } });
    const captures = model(ctx).captures.filter((capture) => values.all === true || capture.link === undefined);
    if (values.json === true)
    {
        console.log(JSON.stringify(captures));
        return;
    }
    if (captures.length === 0)
    {
        console.log(values.all === true ? "no captures" : "no unrouted captures");
        return;
    }
    for (const capture of captures)
    {
        console.log(`${styled ? dim(capture.id) : capture.id}  ${routing(capture)}${firstLine(capture.text)}`);
    }
}

function routing(capture: CaptureState): string
{
    if (capture.link === undefined)
    {
        return "";
    }
    const target = capture.link.work === undefined ? "" : ` ${capture.link.work}`;
    return `[${capture.link.kind}${target}] `;
}

function captureShow(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, allowPositionals: true });
    const capture = requireCapture(ctx, positionals[0]);
    if (values.json === true)
    {
        console.log(JSON.stringify(capture));
        return;
    }
    console.log(styled ? bold(`# ${capture.id}`) : `# ${capture.id}`);
    console.log(`- Captured: ${capture.ts}`);
    if (capture.source !== undefined)
    {
        console.log(`- Source: ${capture.source}`);
    }
    console.log(`- Routing: ${capture.link === undefined ? "not routed yet" : routed(capture)}`);
    console.log("");
    console.log(capture.text);
}

function routed(capture: CaptureState): string
{
    const link = capture.link;
    if (link === undefined)
    {
        return "not routed yet";
    }
    const target = link.work === undefined ? "" : ` → ${link.work}`;
    return `${link.kind}${target}${link.why === undefined ? "" : ` — ${link.why}`}`;
}

// Routing is recorded before its effect, so a run that dies between the two
// leaves a directive that reads as handled and an effect that plainly did not
// land. The reverse order would let a retry apply the same directive twice.
function captureLink(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: {
            new: { type: "string" },
            work: { type: "string" },
            as: { type: "string" },
            why: { type: "string" },
            outcome: { type: "string" },
            priority: { type: "string" },
            json: { type: "boolean" }
        },
        allowPositionals: true
    });
    const capture = requireUnrouted(ctx, positionals[0]);
    const json = values.json === true;
    if (values.new !== undefined)
    {
        linkAsNew(ctx, capture, values.new, json);
        return;
    }
    const work = requireOpenTarget(ctx, values.work);
    const kind = requireKind(values.as);
    const payload: Record<string, unknown> = { capture: capture.id, as: kind };
    if (values.why !== undefined)
    {
        payload.why = values.why;
    }
    recordEvent(ctx, makeEvent(ctx.project, "capture.linked", payload, { capture: capture.id, work }, true), `${capture.id} ${kind} ${work}`, json);
    applyKind(ctx, capture, work, kind, values, json);
    report({ capture: capture.id, as: kind, work }, json);
}

function linkAsNew(ctx: ProjectContext, capture: CaptureState, outcome: string, json: boolean): void
{
    if (outcome.trim() === "")
    {
        throw new CliError(`usage: self ${LINK_USAGE}`);
    }
    const id = workId();
    const linked = makeEvent(ctx.project, "capture.linked", { capture: capture.id, as: "new" }, { capture: capture.id, work: id }, true);
    recordEvent(ctx, linked, `${capture.id} new ${id}`, json);
    const created = makeEvent(ctx.project, "work.created", { work: id, outcome }, { capture: capture.id }, true);
    recordEvent(ctx, created, `${id} ${outcome}`, json);
    report({ capture: capture.id, as: "new", work: id }, json);
}

function applyKind(
    ctx: ProjectContext,
    capture: CaptureState,
    work: string,
    kind: string,
    values: Record<string, string | boolean | undefined>,
    json: boolean
): void
{
    const refs: EventRefs = { work, capture: capture.id };
    if (kind === "supersession")
    {
        const outcome = typeof values.outcome === "string" ? values.outcome : capture.text;
        recordEvent(ctx, makeEvent(ctx.project, "work.outcome.changed", { work, outcome }, refs, true), `${work} ${outcome}`, json);
    }
    if (kind === "cancellation")
    {
        const why = typeof values.why === "string" ? values.why : capture.text;
        recordEvent(ctx, makeEvent(ctx.project, "work.cancelled", { work, why }, refs, true), `${work} ${why}`, json);
    }
    if (kind === "reprioritization")
    {
        const priority = requirePriority(values.priority);
        recordEvent(ctx, makeEvent(ctx.project, "work.prioritized", { work, priority }, refs, true), `${work} priority ${priority}`, json);
    }
}

function captureDrop(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { why: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const capture = requireUnrouted(ctx, positionals[0]);
    const why = requireText(values.why, `capture drop <capture-id> --why "<reason>"`);
    const payload = { capture: capture.id, as: "dropped", why };
    recordEvent(ctx, makeEvent(ctx.project, "capture.linked", payload, { capture: capture.id }, true), `${capture.id} dropped`, values.json === true);
    report({ capture: capture.id, as: "dropped" }, values.json === true);
}

function report(result: Record<string, unknown>, json: boolean): void
{
    if (json)
    {
        console.log(JSON.stringify(result));
    }
}

function requireKind(kind: string | undefined): LinkKind
{
    if (kind === undefined || !ATTACH_KINDS.includes(kind))
    {
        throw new CliError(`usage: self ${LINK_USAGE}`);
    }
    return kind as LinkKind;
}

function requirePriority(value: string | boolean | undefined): number
{
    const priority = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
    if (Number.isNaN(priority))
    {
        throw new CliError("a reprioritization needs --priority <number> — lower runs sooner");
    }
    return priority;
}

function requireCapture(ctx: ProjectContext, id: string | undefined): CaptureState
{
    const wanted = requireText(id, "… <capture-id> — run `self capture list` to list ids");
    const capture = model(ctx).captures.find((item) => item.id === wanted);
    if (capture === undefined)
    {
        throw new CliError(`unknown capture id "${wanted}" — run \`self capture list --all\` to list ids`);
    }
    return capture;
}

// One directive is routed exactly once. A second reading of the same input is
// a new directive, not a rewrite of the first one's history.
function requireUnrouted(ctx: ProjectContext, id: string | undefined): CaptureState
{
    const capture = requireCapture(ctx, id);
    if (capture.link !== undefined)
    {
        throw new CliError(`${capture.id} is already routed as ${routed(capture)} — capture the correction as a new directive`);
    }
    return capture;
}

function requireOpenTarget(ctx: ProjectContext, id: string | undefined): string
{
    const wanted = requireText(id, `capture link <capture-id> --work <work-id> --as <kind>`);
    const work = model(ctx).works.find((item) => item.id === wanted);
    if (work === undefined)
    {
        throw new CliError(`unknown work id "${wanted}" — run \`self work\` to list ids`);
    }
    if (work.status === "done" || work.status === "cancelled")
    {
        throw new CliError(`${wanted} is already ${work.status} — route this directive to new work instead`);
    }
    return work.id;
}

function model(ctx: ProjectContext): ProjectModel
{
    return buildModel(ctx.storeDir, ctx.project, new Date());
}

function firstLine(text: string, max = 100): string
{
    const line = text.split("\n", 1)[0];
    return line.length <= max ? line : line.slice(0, max - 1) + "…";
}
