// The appends a server-backed store has written and the server has not taken
// yet — `projects/<slug>/pending.jsonl`.
//
// Every change to this file is a line added. An append is a line; the mark
// saying one reached the server is a line; the mark saying one may not be
// retried is a line. Nothing is ever rewritten, so no crash between two writes
// can lose a record, and a reader that arrives mid-write finds a shorter file
// rather than a damaged one.
//
// That last clause has a measured limit and it is worth stating where the
// limits below are. A buffered append publishes its new size a page at a time,
// so a reader landing inside a *large* one — the 256KB a single event payload
// may carry, or the megabyte a whole append may — does see a torn last line, at
// a few percent of reads. Line-sized appends are never observed torn. The one
// reader that acts on what it saw rather than only reporting it is the sync's
// rewrite, and it checks: `synclock.ts` refuses to publish a replacement built
// on a read that does not end at a line ending, and carries only whole lines.
// Every other reader here refuses the file and names the line, which is the
// same answer a genuinely damaged file gets and the right one either way.
//
// An append lands here and nowhere else. `log.jsonl` beside it is the server's
// own copy, written only by what comes back from the server, which is what
// makes every event the property of exactly one of the two files: the queue
// owns it until the server has it, and the copy owns it afterwards. There is no
// moment where a machine has written half of a record.
//
// Three row shapes, and the reader below is the one place that tells them
// apart:
//
//   { append_id, events }                 one append, exactly as it was made
//   { sent: append_id }                   the server has given it back
//   { blocked: append_id, code, at }      it will not be retried
//
// This module writes the first shape and reads all three. What writes the other
// two is the transport that sends an append and records what came back — and a
// reader has to understand a mark before anything writes one, or the first mark
// written would be a row the CLI reads as an append.
//
// `sent` is the pull's mark and never the push's. A push answering 200 says the
// server accepted the append, which is not yet the same fact: the mark takes
// those events out of every read below, and until the server's copy holds them
// the queue is the only place they exist on this machine. So the rule is the
// narrow one — the mark goes down only after a pull has seen every one of that
// append's event ids arrive in `log.jsonl`. Written off the push, a 200 whose
// records the server then lost would leave a record no read can reach and no
// command can resend.
//
// A meaning added later is a new field on one of these three shapes, never a
// fourth shape. The reader tells rows apart by the keys it knows, so a row that
// is neither an append nor a mark is silently nothing to it — which is the
// right answer for a CLI meeting a newer store, and the wrong one for a fourth
// shape that meant "this append is settled": that append would read on an older
// machine as one still waiting to go, and it would be folded twice. A new field
// on `{sent}` is ignored by that same older reader, which still gets the
// settlement itself right.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "./ids.js";
import { ensureDir, projectStateDir } from "./paths.js";
import { CliError, SelfEvent } from "./types.js";

export const PENDING_FILE = "pending.jsonl";

// One append, as it was made. `append_id` groups its events so the whole of it
// travels as one transaction: an append is not divisible after the fact, which
// is why the limits below refuse an oversized one where it is made rather than
// letting it into a file it could never leave.
interface PendingAppend
{
    append_id: string;
    events: SelfEvent[];
}

// The append is in `log.jsonl` beside this file — the server took it and a pull
// has read it back. Not "the push succeeded": the two are one fact only once
// the server's copy holds it, and the reader below trusts this mark that far.
interface PendingSent
{
    sent: string;
}

// The whole shape rather than the one field read here. The file format
// is declared here or it is declared in two places: a transport that writes a
// row this module has never named would be free to spell it differently, and
// the reader below is what decides whether an append is still going anywhere.
interface PendingBlocked
{
    blocked: string;
    // Why the server refused it, and when, so the next interactive command can
    // say something more useful than "one of your records did not go".
    code: string;
    at: string;
    detail?: string;
    // That a person has been told. A background push has no output channel, so
    // the telling is done by the next command that has one, and this is what
    // stops it being done again by the one after that.
    //
    // A field on the blocked row rather than a fourth row shape, which is the
    // rule this file's header states: an older CLI reading this row sees a
    // blocked mark and gets the settlement itself right — the append is not
    // going anywhere — and ignores the field, which is exactly the right
    // amount of wrong. A fourth shape would have read to that CLI as neither
    // an append nor a mark, and the append it settled would have been folded
    // as one still waiting to go.
    surfaced?: string;
}

type PendingRow = PendingAppend | PendingSent | PendingBlocked;

/* ── what one append may carry ─────────────────────────────────────── */

// A single event's payload, and a whole append's size and count. The numbers
// are the server's, checked here because an append is made once and sent many
// times: refusing at the moment it is made costs the caller one command, and
// refusing at the moment it is sent costs them a record stuck in a queue with
// no command that can take it back out.
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_APPEND_EVENTS = 1000;
const MAX_APPEND_BYTES = 1024 * 1024;

// Every refusal here names splitting as the way through, because it is the only
// one: an append cannot be divided after it is made, so the caller has to make
// smaller ones.
export function refuseOversizedAppend(events: SelfEvent[]): void
{
    events.forEach(refuseOversizedPayload);
    if (events.length > MAX_APPEND_EVENTS)
    {
        throw new CliError(`this records ${events.length} events in one append and an append may carry `
            + `${MAX_APPEND_EVENTS} — record them as several smaller commands, since an append cannot be `
            + "split after it is made");
    }
    const bytes = Buffer.byteLength(JSON.stringify(events));
    if (bytes > MAX_APPEND_BYTES)
    {
        throw new CliError(`this append is ${kb(bytes)} and an append may carry ${kb(MAX_APPEND_BYTES)} — `
            + "record it as several smaller commands, since an append cannot be split after it is made");
    }
}

function refuseOversizedPayload(event: SelfEvent): void
{
    const bytes = Buffer.byteLength(JSON.stringify(event.payload));
    if (bytes > MAX_PAYLOAD_BYTES)
    {
        throw new CliError(`this ${event.type} carries ${kb(bytes)} and one event may carry `
            + `${kb(MAX_PAYLOAD_BYTES)} — record the bulk of it as an artifact with \`self artifact add\`, `
            + "or record it in smaller pieces");
    }
}

// Powers of 1024 under the shorter name, as `self store size` already reports
// them: a person comparing two of this CLI's numbers must not have to ask which
// base each one is in.
function kb(bytes: number): string
{
    return `${Math.ceil(bytes / 1024)}KB`;
}

/* ── the queue ─────────────────────────────────────────────────────── */

// One append, written as one line. No lock: a single append to a file is safe
// against another process doing the same, and this is the whole of what the
// foreground write does.
export function appendPending(storeDir: string, slug: string, events: SelfEvent[]): void
{
    const dir = ensureDir(projectStateDir(storeDir, slug));
    const row: PendingAppend = { append_id: ulid(), events };
    appendFileSync(join(dir, PENDING_FILE), JSON.stringify(row) + "\n");
}

// The events this machine holds that the server does not: every append with
// neither mark against it, in the order it was made.
//
// A blocked append is left out along with a sent one, and for the same reason
// in reverse. It is not going to the server, so its events are not going to
// come back in the server's copy of the log — but the mark is put there by a
// server that has refused them, which means the state they claim is a state the
// workspace does not hold. Reading them would show one machine a record every
// other machine will never see.
export function pendingEvents(storeDir: string, slug: string): SelfEvent[]
{
    const rows = readPending(storeDir, slug);
    const settled = new Set(rows.flatMap(settledAppend));
    return rows.filter(isAppend).filter((row) => !settled.has(row.append_id)).flatMap((row) => row.events);
}

function isAppend(row: PendingRow): row is PendingAppend
{
    return Array.isArray((row as PendingAppend).events);
}

function settledAppend(row: PendingRow): string[]
{
    const settled = (row as PendingSent).sent ?? (row as PendingBlocked).blocked;
    return typeof settled === "string" ? [settled] : [];
}

// No file is the ordinary state of a store that has just been connected, and of
// one whose queue has been compacted down to nothing. It reads as an empty
// queue, never as an error.
//
// A line that will not parse does stop the read, and says which line: this file
// is the only copy of every record in it, so a reader that skipped a damaged
// line would answer as though the records it holds were never written. The
// refusal names the file so the line can be found.
function readPending(storeDir: string, slug: string): PendingRow[]
{
    const file = join(projectStateDir(storeDir, slug), PENDING_FILE);
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8").split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter((row) => row.line.trim() !== "")
        .map((row) => parseRow(row.line, file, row.number));
}

function parseRow(line: string, file: string, number: number): PendingRow
{
    try
    {
        return JSON.parse(line) as PendingRow;
    }
    catch
    {
        throw new CliError(`${file} line ${number} is not readable as JSON — it holds records this machine has `
            + "not sent yet, so it is repaired by hand rather than discarded: open the file, read that one line, "
            + "and put back the record it was meant to be or take the line out");
    }
}

/* ── the marks the transport writes ────────────────────────────────── */

// The appends the server has not taken, whole, in the order they were made.
// The transport sends these; `pendingEvents` above reads the same rows for the
// fold, which is why both answer off one filter — an append the fold has
// dropped and the transport still sends would be a record on one machine and
// nowhere else.
export function unsentAppends(storeDir: string, slug: string): PendingAppend[]
{
    const rows = readPending(storeDir, slug);
    const settled = new Set(rows.flatMap(settledAppend));
    return rows.filter(isAppend).filter((row) => !settled.has(row.append_id));
}

// The server has given an append back: a pull has read every one of its event
// ids out of `log.jsonl`. Never written off a push — the file's header says
// why, and the rule is the whole reason this mark is the pull's.
export function markSent(storeDir: string, slug: string, appendIds: string[]): void
{
    appendRows(storeDir, slug, appendIds.map((append_id): PendingSent => ({ sent: append_id })));
}

// The server refused it in a way no retry can fix. What a person is told, and
// when they are told it, is decided by the next command that has somewhere to
// print — this only records the fact and the reason for it.
export function markBlocked(storeDir: string, slug: string, appendId: string, code: string, detail: string): void
{
    appendRows(storeDir, slug, [{ blocked: appendId, code, at: new Date().toISOString(), detail }]);
}

// The blocked appends nobody has been told about yet, one row each and the
// first mark for an append winning: a re-statement carrying `surfaced` names
// the same append and the same refusal, so a reader wanting the reason wants
// the original.
export function unsurfacedBlocks(storeDir: string, slug: string): PendingBlocked[]
{
    const blocks = readPending(storeDir, slug).filter(isBlocked);
    const told = new Set(blocks.filter((row) => row.surfaced !== undefined).map((row) => row.blocked));
    const first = new Map<string, PendingBlocked>();
    blocks.filter((row) => !told.has(row.blocked)).forEach((row) => first.set(row.blocked, first.get(row.blocked) ?? row));
    return [...first.values()];
}

// Said once, recorded as the same mark said again with the day it was said on.
// A row rather than a rewrite, because every change to this file is a row.
export function markSurfaced(storeDir: string, slug: string, blocks: PendingBlocked[]): void
{
    appendRows(storeDir, slug, blocks.map((row) => ({ ...row, surfaced: new Date().toISOString() })));
}

function isBlocked(row: PendingRow): row is PendingBlocked
{
    return typeof (row as PendingBlocked).blocked === "string";
}

function appendRows(storeDir: string, slug: string, rows: PendingRow[]): void
{
    if (rows.length > 0)
    {
        const dir = ensureDir(projectStateDir(storeDir, slug));
        appendFileSync(join(dir, PENDING_FILE), rows.map((row) => JSON.stringify(row) + "\n").join(""));
    }
}

/* ── tidying the queue ─────────────────────────────────────────────── */

// What the queue would say with its settled history dropped: every append the
// server has taken, and every mark about one, gone. What is left is the
// unsent appends and the blocked ones a person has yet to be told about.
//
// Text in and text out, and no filesystem: the caller holds the sync lock and
// publishes this through the rewrite that carries a concurrent append's bytes
// onto the end. A crash anywhere before that rename leaves the original whole,
// so nothing here can lose a record and nothing can apply twice — the worst it
// costs is a queue file that is longer than it needed to be.
//
// A line this reader cannot parse stops the compaction rather than being
// dropped, for the same reason it stops every other read of this file.
export function compactedPending(text: string): string
{
    const rows = text.split("\n").filter((line) => line.trim() !== "")
        .map((line, index) => parseRow(line, PENDING_FILE, index + 1));
    const sent = new Set(rows.flatMap((row) => typeof (row as PendingSent).sent === "string" ? [(row as PendingSent).sent] : []));
    return rows.filter((row) => !sent.has(appendOf(row))).map((row) => JSON.stringify(row) + "\n").join("");
}

// Which append a row is about, whichever of the three shapes it is. A row that
// is none of them belongs to a newer CLI and is about no append this one knows,
// so it is kept: dropping a row because its meaning is unfamiliar is how a
// store gets quietly downgraded by the older machine that touched it last.
function appendOf(row: PendingRow): string
{
    return (row as PendingAppend).append_id ?? (row as PendingSent).sent ?? (row as PendingBlocked).blocked ?? "";
}
