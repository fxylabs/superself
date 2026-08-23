import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { foldProject } from "./fold.js";
import { commitAll, currentBranch, topOf } from "./gitutil.js";
import { ulid } from "./ids.js";
import { sessionToken } from "./machine.js";
import { notice } from "./output.js";
import { CliContext, ensureDir, invalidateResolution, projectStateDir, refuseArchived } from "./paths.js";
import { assertSanitized } from "./sanitize.js";
import { bold, dim, green, styled } from "./style.js";
import { EventRefs, SelfEvent } from "./types.js";

// A machine surface owns its stdout. The human confirmation line below is
// written for a person watching a terminal; a caller that asked for JSON gets
// the JSON and nothing else to parse around.
let machineMode = false;

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
        origin: { actor: "agent", session: sessionToken(), confirmed: humanConfirmed },
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
    requireWritable(ctx, events);
    stampBranch(ctx, events);
    // Grouped by the project each event names, because a placement that moves a
    // record between projects writes into the log that owns the record and into
    // the log that owns the seat it frees (#181 D3). Each group is one append,
    // so a reader of any one log still never finds half a state change.
    const projects = appendGrouped(ctx, events);
    // The store has changed, so nothing derived from it that this process
    // worked out before the write may be reused after it. Resolution is cached
    // in memory until something clears it, and a daemon tick appends through
    // here too; this is the line that makes a read after a write impossible to
    // answer from what came before it, in a one-shot command and in a tick
    // alike.
    invalidateResolution();
    // The appended lines are the state change. Everything below them is derived
    // from the log and is redone by the next fold, so a failure there costs a
    // refold — never the events, and never what they name.
    onRecorded?.();
    projects.forEach((project) => foldProject(ctx.storeDir, project));
    commitAll(ctx.storeDir, `${events.map((event) => event.type).join(" ")} ${projects.join(" ")}: ${truncate(summary, 60)}`);
    announce(events, summary);
}

// The branch every event was composed on, stamped once for the batch: history
// ("this happened here"), never a live pointer. Read off the project directory
// where that is a repository, else off the checkout the command stands in — a
// project registered at the folder holding its repositories has no branch of
// its own, and the command ran on one of theirs (#331).
function stampBranch(ctx: CliContext, events: SelfEvent[]): void
{
    const branch = ctx.projectDir === undefined ? null
        : currentBranch(topOf(ctx.projectDir) === null ? process.cwd() : ctx.projectDir);
    if (branch !== null)
    {
        events.forEach((event) => { event.refs = { ...event.refs, branch }; });
    }
}

// Recording into an archived project is what "it is being worked on again"
// means, so it is refused and `restore` is named (#283). The refusal sits on
// the append rather than on each verb: every write the CLI has goes through
// here, and every write it grows will too, which is the only way the rule
// cannot be missed by a verb added later.
//
// The way back is the one exception. `project restore` and the `self undo` that
// takes an archive record back both write this event into the archived project,
// and neither is work resuming under another name.
const ARCHIVE_EXIT = "project.restored";

function requireWritable(ctx: CliContext, events: SelfEvent[]): void
{
    const projects = new Set(events.filter((event) => event.type !== ARCHIVE_EXIT).map((event) => event.project));
    for (const project of projects)
    {
        refuseArchived(ctx.storeDir, project, "nothing more is recorded into it");
    }
}

// One append per log, in the order the events were composed, and the projects
// written back so the caller refolds exactly those.
function appendGrouped(ctx: CliContext, events: SelfEvent[]): string[]
{
    const projects = [...new Set(events.map((event) => event.project))];
    for (const project of projects)
    {
        const dir = ensureDir(projectStateDir(ctx.storeDir, project));
        appendFileSync(join(dir, "log.jsonl"), events.filter((event) => event.project === project)
            .map((event) => JSON.stringify(event) + "\n").join(""));
    }
    return projects;
}

// Whether an append says anything is decided here, where what the run is for
// is known; the line itself is printed by the render gate's notice, which
// decides nothing. Moving the decision into the gate would put "is this a
// machine surface" in a module that cannot see the caller.
function announce(events: SelfEvent[], summary: string): void
{
    for (const event of machineMode ? [] : events)
    {
        notice(styled
            ? `${green("✓")} ${bold(event.type)}  ${dim(truncate(summary, 80))}  ${dim(`[${event.id}]`)}`
            : `${event.type} recorded [${event.id}]`);
    }
}

function truncate(text: string, max: number): string
{
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
