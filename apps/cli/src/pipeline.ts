import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { foldProject } from "./fold.js";
import { commitAll, currentBranch } from "./gitutil.js";
import { ulid } from "./ids.js";
import { CliContext, ensureDir, invalidateResolution, projectStateDir } from "./paths.js";
import { assertSanitized } from "./sanitize.js";
import { bold, dim, green, styled } from "./style.js";
import { EventRefs, SelfEvent } from "./types.js";

// A machine surface owns its stdout. The human confirmation line below is
// written for a person watching a terminal; a caller that asked for JSON gets
// the JSON and nothing else to parse around.
let machineMode = false;

export function setMachineMode(on: boolean): void
{
    machineMode = on;
}

export function makeEvent(
    project: string,
    type: string,
    payload: Record<string, unknown>,
    refs?: EventRefs,
    humanConfirmed = false
): SelfEvent
{
    const event: SelfEvent = {
        id: ulid(),
        ts: new Date().toISOString(),
        type,
        origin: { actor: "agent", session: process.env.SUPERSELF_SESSION, confirmed: humanConfirmed },
        project,
        payload
    };
    if (refs !== undefined)
    {
        event.refs = refs;
    }
    return event;
}

// The branch is stamped here, not by each verb: every event is made from one
// checkout, and that is the only place holding it.
//
// `onRecorded` fires the moment the event is durable, before any derived work:
// a caller holding bytes for this event learns there that they now belong to
// the store, whatever the rest of this function does.
export function recordEvent(ctx: CliContext, event: SelfEvent, summary: string, onRecorded?: () => void): void
{
    recordEvents(ctx, [event], summary, onRecorded);
}

// Events that are one state change are appended in one write, so a reader can
// never find half of it: a work unit created by an accepted proposal without
// the link and the acceptance that explain it would be a unit nothing points
// at, and a re-run of `work accept` would create a second one.
export function recordEvents(ctx: CliContext, events: SelfEvent[], summary: string, onRecorded?: () => void): void
{
    // First, before the branch stamp and before a byte reaches the log: what an
    // event carries is checked while refusing it still costs only this command.
    events.forEach((event) => assertSanitized(event));
    const branch = ctx.projectDir === undefined ? null : currentBranch(ctx.projectDir);
    if (branch !== null)
    {
        events.forEach((event) => { event.refs = { ...event.refs, branch }; });
    }
    const project = events[0].project;
    const dir = ensureDir(projectStateDir(ctx.storeDir, project));
    appendFileSync(join(dir, "log.jsonl"), events.map((event) => JSON.stringify(event) + "\n").join(""));
    // The store has changed, so nothing derived from it that this process
    // worked out before the write may be reused after it. Resolution is cached
    // for the length of one command; this is the line that makes a read after a
    // write in the same command impossible to answer from what came before it.
    invalidateResolution();
    // The appended lines are the state change. Everything below them is derived
    // from the log and is redone by the next fold, so a failure there costs a
    // refold — never the events, and never what they name.
    onRecorded?.();
    foldProject(ctx.storeDir, project);
    commitAll(ctx.storeDir, `${events.map((event) => event.type).join(" ")} ${project}: ${truncate(summary, 60)}`);
    for (const event of machineMode ? [] : events)
    {
        console.log(styled
            ? `${green("✓")} ${bold(event.type)}  ${dim(truncate(summary, 80))}  ${dim(`[${event.id}]`)}`
            : `${event.type} recorded [${event.id}]`);
    }
}

function truncate(text: string, max: number): string
{
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
