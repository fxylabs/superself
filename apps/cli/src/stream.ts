import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { eventSummary, readEvents } from "./logfile.js";
import { buildModel, CaptureState, ProjectModel, queueOrder, WorkState } from "./model.js";
import { ProjectContext } from "./paths.js";
import { loadVerdicts, verdictSignals } from "./reachability.js";
import { bold, dim, fit, styled, termWidth, yellow } from "./style.js";
import { CliError, SelfEvent } from "./types.js";

const CHANGED_WINDOW_HOURS = 24;
const POLL_MS = 300;

export interface StreamItem
{
    kind: string;
    ref: string;
    text: string;
    detail?: string;
}

export interface Stream
{
    needsYou: StreamItem[];
    changed: StreamItem[];
    running: StreamItem[];
    queued: StreamItem[];
    captured: StreamItem[];
}

const SECTIONS: [keyof Stream, string][] = [
    ["needsYou", "Needs you"],
    ["changed", "Changed"],
    ["running", "Running"],
    ["queued", "Queued"],
    ["captured", "Captured ideas"]
];

export async function runStream(ctx: ProjectContext, args: string[]): Promise<void>
{
    const { values } = parseArgs({
        args,
        options: {
            json: { type: "boolean" },
            follow: { type: "boolean" },
            since: { type: "string" },
            for: { type: "string" }
        }
    });
    if (values.follow === true)
    {
        await follow(ctx, values.since, values.for, values.json === true);
        return;
    }
    const stream = buildStream(current(ctx), since(values.since));
    if (values.json === true)
    {
        console.log(JSON.stringify(stream));
        return;
    }
    print(stream);
}

// The stream reuses the verdicts the last fold persisted, so what it reports
// about evidence agrees with canonical state without re-running git.
function current(ctx: ProjectContext): ProjectModel
{
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    model.health.push(...verdictSignals(model.works, loadVerdicts(ctx.storeDir, ctx.project)));
    return model;
}

// One board over every work unit and every unrouted directive, not one view
// per agent session. Sections are exclusive and read top-down: what stops on a
// person, what moved, what is running, what is next, what has not been read.
export function buildStream(model: ProjectModel, changedSince: Date): Stream
{
    const running = model.works.filter((work) => work.status === "active");
    const queued = queueOrder(model);
    const needsYou = needsYouItems(model);
    const placed = new Set([...running, ...queued].map((work) => work.id));
    const changed = model.works
        .filter((work) => !placed.has(work.id) && new Date(work.lastEventTs) >= changedSince)
        .sort((a, b) => b.lastEventTs.localeCompare(a.lastEventTs))
        .map(changedItem);
    return {
        needsYou,
        changed,
        running: running.map(runningItem),
        queued: queued.map(queuedItem),
        captured: model.captures.filter((capture) => capture.link === undefined).reverse().map(capturedItem)
    };
}

function needsYouItems(model: ProjectModel): StreamItem[]
{
    return [
        ...model.works.filter((work) => work.waiting === "approval").map((work) => ({
            kind: "approval",
            ref: work.id,
            text: work.outcome,
            detail: work.approval?.why
        })),
        ...model.works.filter((work) => work.status === "blocked").map((work) => ({
            kind: "blocked",
            ref: work.id,
            text: work.outcome,
            detail: `waiting on ${work.blockedOn}${work.blockedWhy === undefined ? "" : `: ${work.blockedWhy}`}`
        })),
        ...model.decisions.filter((decision) => decision.status === "proposed" && !decision.expired).map((decision) => ({
            kind: "proposal",
            ref: decision.id,
            text: decision.text,
            detail: `confirm with \`self decide confirm ${decision.id}\``
        })),
        ...model.openQuestions.map((question) => ({ kind: "question", ref: "", text: question })),
        ...model.health.map((signal) => ({ kind: "health", ref: "", text: signal }))
    ];
}

function runningItem(work: WorkState): StreamItem
{
    const lease = work.lease;
    const detail = lease === undefined
        ? "started, no lease"
        : `${work.leaseExpired ? "lease expired" : "leased"} by ${lease.worker} until ${lease.expires}`;
    return { kind: "running", ref: work.id, text: work.outcome, detail };
}

function queuedItem(work: WorkState): StreamItem
{
    return { kind: "queued", ref: work.id, text: work.outcome, detail: `priority ${work.priority}` };
}

function changedItem(work: WorkState): StreamItem
{
    const waiting = work.waiting === undefined ? work.status : `waiting on ${work.waiting}`;
    return { kind: waiting, ref: work.id, text: work.outcome, detail: work.lastEventTs };
}

function capturedItem(capture: CaptureState): StreamItem
{
    return { kind: "captured", ref: capture.id, text: firstLine(capture.text), detail: capture.ts };
}

// Every section prints, empty or not: the board answers "is anything waiting
// on me" by being read, and a section that disappears when it empties makes
// the reader check whether it is missing or simply clear.
function print(stream: Stream): void
{
    for (const [key, title] of SECTIONS)
    {
        printSection(title, stream[key]);
    }
}

function printSection(title: string, items: StreamItem[]): void
{
    const head = `${title} (${items.length})`;
    console.log(styled ? bold(head) : head);
    for (const item of items)
    {
        console.log(`  ${itemLine(item)}`);
    }
    if (items.length === 0)
    {
        console.log(styled ? `  ${dim("nothing here")}` : "  nothing here");
    }
    console.log("");
}

function itemLine(item: StreamItem): string
{
    const ref = item.ref === "" ? "" : `${item.ref}  `;
    const body = fit(`${item.text}${item.detail === undefined ? "" : ` — ${item.detail}`}`, Math.max(30, termWidth() - ref.length - 14));
    const kind = item.kind.padEnd(10);
    if (!styled)
    {
        return `${kind}  ${ref}${body}`;
    }
    const paint = item.kind === "health" || item.kind === "blocked" ? yellow : dim;
    return `${paint(kind)}  ${dim(ref)}${body}`;
}

// The subscription surface: a console tails this instead of keeping its own
// copy of state, so what it renders can never disagree with the log.
async function follow(ctx: ProjectContext, from: string | undefined, forSeconds: string | undefined, json: boolean): Promise<void>
{
    const deadline = forSeconds === undefined ? Number.POSITIVE_INFINITY : Date.now() + seconds(forSeconds) * 1000;
    let cursor = startCursor(ctx, from);
    while (Date.now() < deadline)
    {
        for (const event of newEvents(ctx, cursor))
        {
            console.log(json ? JSON.stringify(event) : `${event.ts}  ${event.type}  [${event.id}]  ${eventSummary(event)}`);
            cursor += 1;
        }
        await sleep(POLL_MS);
    }
}

// Without --since a subscriber wants what happens from now on; with one it
// wants everything it has not seen, which is how a console reconnects without
// replaying the whole log or missing the gap.
function startCursor(ctx: ProjectContext, from: string | undefined): number
{
    const events = readEvents(ctx.storeDir, ctx.project);
    if (from === undefined)
    {
        return events.length;
    }
    const index = events.findIndex((event) => event.id === from);
    if (index === -1)
    {
        throw new CliError(`no event with id "${from}" — pass the last id you saw, or omit --since to follow from now`);
    }
    return index + 1;
}

// A writer appending while this reads leaves a partial last line; treat that
// as "nothing new yet" and pick it up on the next poll.
function newEvents(ctx: ProjectContext, cursor: number): SelfEvent[]
{
    try
    {
        return readEvents(ctx.storeDir, ctx.project).slice(cursor);
    }
    catch
    {
        return [];
    }
}

function since(value: string | undefined): Date
{
    if (value === undefined)
    {
        return new Date(Date.now() - CHANGED_WINDOW_HOURS * 3_600_000);
    }
    const at = new Date(value);
    if (Number.isNaN(at.getTime()))
    {
        throw new CliError(`"${value}" is not a timestamp — pass an ISO date like 2026-07-26T09:00:00Z`);
    }
    return at;
}

function seconds(value: string): number
{
    const span = Number.parseInt(value, 10);
    if (Number.isNaN(span) || span <= 0)
    {
        throw new CliError("--for expects a positive number of seconds");
    }
    return span;
}

function firstLine(text: string, max = 100): string
{
    const line = text.split("\n", 1)[0];
    return line.length <= max ? line : line.slice(0, max - 1) + "…";
}
