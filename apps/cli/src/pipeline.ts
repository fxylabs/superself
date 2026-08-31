import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { foldProject } from "./fold.js";
import { commitAll, currentBranch, topOf } from "./gitutil.js";
import { ulid } from "./ids.js";
import { sessionToken } from "./machine.js";
import { serverBacked } from "./mode.js";
import { jsonMode, notice } from "./output.js";
import { CliContext, ensureDir, invalidateResolution, projectStateDir, refuseArchived } from "./paths.js";
import { appendPending, refuseOversizedAppend } from "./pending.js";
import { assertSanitized } from "./sanitize.js";
import { bold, dim, green, styled } from "./style.js";
import { CliError, EventRefs, SelfEvent } from "./types.js";

// A machine surface owns its stdout. The human confirmation line below is
// written for a person watching a terminal; a caller that asked for JSON gets
// the JSON and nothing else to parse around.
let machineMode = false;

// While a reviewed set is being collected, nothing may reach the log (#312).
// `retirement.ts` opens the hold, queues each destroying call it collects, and
// releases it before writing them as one append — so a call that records
// rather than destroys cannot ride into the batch beside the ones that do.
let heldForSet = false;

// What the caller said it meant by this call (#390), from the `--meant` host
// flag. Recorded beside what the command actually resolved, so the receipt can
// print two independent statements of the same thing side by side — which is
// the cross-check. Never judged: a fuzzy comparator would be a second thing to
// be wrong about.
let statedIntent: string | undefined = undefined;

export function holdAppends(on: boolean): void
{
    heldForSet = on;
}

export function stateIntent(text: string | undefined): void
{
    statedIntent = text;
}

// A hold is closed by the collector that opened it, and an exception thrown
// between the two leaves it open. Inside one process that was the end of the
// run and nothing noticed; across two invocations it is a log that refuses
// every append the next command makes. Cleared on entry to `runCli` for the
// same reason the caches are: a hold belongs to one invocation.
export function resetPipeline(): void
{
    machineMode = false;
    heldForSet = false;
    statedIntent = undefined;
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
// at, and a re-run of `work confirm` would create a second one.
export function recordEvents(ctx: CliContext, events: SelfEvent[], summary: string, onRecorded?: () => void): void
{
    refuseHeld();
    // The stated intent is stamped before the sanitizer runs, not after: it is
    // free text off the command line and owes the same check every other
    // free-text payload owes.
    stampIntent(events);
    stampBatch(events);
    // Then, before the branch stamp and before a byte reaches the log: what an
    // event carries is checked while refusing it still costs only this command.
    events.forEach((event) => assertSanitized(event));
    requireWritable(ctx, events);
    stampBranch(ctx, events);
    stampActor(ctx, events);
    writeThrough(ctx.storeDir, events, events.map((event) => event.type).join(" "), summary, onRecorded);
    announce(events, summary);
}

// One state change several verbs composed, written once (#312). A reviewed set
// lands as one write: checking and appending each call in turn would let a call
// the sanitizer or the archive gate refuses stop the set *after* the calls
// before it were already appended, folded and committed — records destroyed
// under a disclosure whose set never happened, and an exit code saying nothing
// was.
//
// Everything the whole set owes is therefore checked before any of it is
// written, and then the events go through the same single writer one call's do.
interface RecordedCall
{
    ctx: CliContext;
    events: SelfEvent[];
    summary: string;
}

export function recordCalls(calls: RecordedCall[], summary: string): void
{
    refuseHeld();
    if (calls.length === 0)
    {
        return;
    }
    const events = calls.flatMap((call) => call.events);
    stampIntent(events);
    stampBatch(events);
    events.forEach((event) => assertSanitized(event));
    calls.forEach((call) => requireWritable(call.ctx, call.events));
    calls.forEach((call) => stampBranch(call.ctx, call.events));
    calls.forEach((call) => stampActor(call.ctx, call.events));
    // The type list is deduplicated here and not in `recordEvents`: a set of
    // twenty withdrawals would otherwise name its one event type twenty times
    // in the commit subject.
    writeThrough(oneStore(calls), events, [...new Set(events.map((event) => event.type))].join(" "), summary);
    calls.forEach((call) => announce(call.events, call.summary));
}

// A workspace holds one store and a reviewed set is read in one workspace, so
// this is a statement rather than a guess: half a set in one store and half in
// another is exactly the split write the single call exists to prevent.
function oneStore(calls: RecordedCall[]): string
{
    if (new Set(calls.map((call) => call.ctx.storeDir)).size > 1)
    {
        throw new CliError("these calls write into more than one store, and one append covers one store");
    }
    return calls[0].ctx.storeDir;
}

// The write itself, once everything that could refuse it has run.
function writeThrough(storeDir: string, events: SelfEvent[], types: string, summary: string, onRecorded?: () => void): void
{
    // Grouped by the project each event names, because a placement that moves a
    // record between projects writes into the log that owns the record and into
    // the log that owns the seat it frees (#181 D3). Each group is one append,
    // so a reader of any one log still never finds half a state change.
    const projects = appendGrouped(storeDir, events);
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
    projects.forEach((project) => foldProject(storeDir, project));
    commitAll(storeDir, `${types} ${projects.join(" ")}: ${truncate(summary, 60)}`);
}

// What `self apply` covers, refused where a line asks for something else. A
// reviewed set is a set of records being destroyed, so a verb that records
// something instead has nothing for that append to cover — and letting it write
// here would put state in the log outside the set that was reviewed.
function refuseHeld(): void
{
    if (heldForSet)
    {
        throw new CliError("this records something rather than destroying a record, and one append covers "
            + "only the calls that do");
    }
}

// The append boundary, stamped only where the append holds more than one
// event (#390). An undo takes back everything one state change wrote, and log
// adjacency cannot say what one state change was: a union merge of two clones'
// logs interleaves their lines. Absent on every event written before this, so
// each of those is a unit of one and no log is migrated.
function stampBatch(events: SelfEvent[]): void
{
    if (events.length < 2)
    {
        return;
    }
    const batch = ulid();
    events.forEach((event) => { event.refs = { ...event.refs, batch }; });
}

function stampIntent(events: SelfEvent[]): void
{
    if (statedIntent !== undefined)
    {
        events.forEach((event) => { event.payload = { ...event.payload, meant: statedIntent }; });
    }
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

// Which account these events are the work of, from the value the entry point
// read once and put on the context. A value and never a reader: a state writer
// must have no import path to a credential, so `runCli` asks who this machine
// is logged in as and this module is handed the answer.
//
// Stamped only where the store is server-backed, which is where authorship has
// to travel with the record: a git-backed store's log is committed by a machine
// git already names, and stamping there would change bytes that every existing
// clone of that log agrees on. Silent where the machine is logged in to
// nothing — an append is always allowed to succeed, and a record whose author
// is unstated is a gap in an audit trail rather than a reason to refuse work.
function stampActor(ctx: CliContext, events: SelfEvent[]): void
{
    const account = ctx.account;
    if (account === undefined || !serverBacked(ctx.storeDir))
    {
        return;
    }
    events.forEach((event) => { event.actor = { account }; });
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
//
// Which file an append lands in is the whole of what the store's mode changes
// here. A git-backed store writes the log itself and the commit that follows
// covers it; a server-backed store writes the queue, and the log beside it is
// the server's to write. Both are one append per project either way, so a
// reader of any one project still never finds half a state change.
function appendGrouped(storeDir: string, events: SelfEvent[]): string[]
{
    const groups = groupByProject(events);
    if (serverBacked(storeDir))
    {
        // Every group is checked before any of them is written. A placement
        // that writes into two projects makes two appends, and refusing the
        // second for its size after the first is already queued would leave
        // exactly the half-written state one append per log exists to prevent.
        groups.forEach((group) => refuseOversizedAppend(group.events));
        groups.forEach((group) => appendPending(storeDir, group.project, group.events));
        return groups.map((group) => group.project);
    }
    groups.forEach((group) => appendLog(storeDir, group.project, group.events));
    return groups.map((group) => group.project);
}

interface ProjectAppend
{
    project: string;
    events: SelfEvent[];
}

function groupByProject(events: SelfEvent[]): ProjectAppend[]
{
    return [...new Set(events.map((event) => event.project))]
        .map((project) => ({ project, events: events.filter((event) => event.project === project) }));
}

function appendLog(storeDir: string, project: string, events: SelfEvent[]): void
{
    const dir = ensureDir(projectStateDir(storeDir, project));
    appendFileSync(join(dir, "log.jsonl"), events.map((event) => JSON.stringify(event) + "\n").join(""));
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
        const review = reviewLine(event, summary);
        if (review !== null)
        {
            notice(styled ? dim(review) : review);
        }
    }
}

// The review a record gets before anything is built on it (#390 §2). What
// catches the mistakes an undo exists for is the *resolved* record printed
// back: an agent that typed one id and meant its neighbour finds out here,
// because the outcome text it reads is the one it actually wrote against. The
// line is built at this one seam because every mutating command passes through
// it, including every command added after this line was written.
//
// An annulment is exempt: an undo is not undone, so handing back a line that
// would be refused would teach the wrong grammar.
function reviewLine(event: SelfEvent, summary: string): string | null
{
    // A machine surface owns its stdout: a caller that asked for JSON gets the
    // JSON and nothing else to parse around, the review line included.
    if (jsonMode() || event.type === "entity.annulled" || event.type === "entity.restored")
    {
        return null;
    }
    const meant = statedIntent === undefined ? "" : `  ·  meant: ${truncate(statedIntent, 60)}`;
    return `  ${truncate(summary, 80)}${meant} — verify; wrong? self undo ${event.id}`;
}

function truncate(text: string, max: number): string
{
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
