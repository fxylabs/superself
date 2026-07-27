import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { foldProject } from "./fold.js";
import { commitAll, currentBranch } from "./gitutil.js";
import { ulid } from "./ids.js";
import { CliContext, ensureDir, projectStateDir } from "./paths.js";
import { bold, dim, green, styled } from "./style.js";
import { assertSanitized, redactPayload } from "./supervise/sanitize.js";
import { EventRefs, SelfEvent } from "./types.js";

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
//
// The store syncs, so this is also the boundary where a machine's private
// detail would leave it. Forbidden keys are refused outright and
// credential-shaped values are redacted, before the event reaches the log
// every clone reads.
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
    for (const event of events)
    {
        assertSanitized(event.payload);
        event.payload = redactPayload(event.payload);
    }
    const branch = ctx.projectDir === undefined ? null : currentBranch(ctx.projectDir);
    if (branch !== null)
    {
        events.forEach((event) => { event.refs = { ...event.refs, branch }; });
    }
    const project = events[0].project;
    const dir = ensureDir(projectStateDir(ctx.storeDir, project));
    appendFileSync(join(dir, "log.jsonl"), events.map((event) => JSON.stringify(event) + "\n").join(""));
    // The appended lines are the state change. Everything below them is derived
    // from the log and is redone by the next fold, so a failure there costs a
    // refold — never the events, and never what they name.
    onRecorded?.();
    foldProject(ctx.storeDir, project);
    commitAll(ctx.storeDir, `${events.map((event) => event.type).join(" ")} ${project}: ${truncate(summary, 60)}`);
    for (const event of events)
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
