import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CRITERION_BLOCKED, CRITERION_DECLARED, CRITERION_UNBLOCKED } from "@superself/fold";
import { serverBacked } from "./mode.js";
import { projectStateDir } from "./paths.js";
import { pendingEvents } from "./pending.js";
import { CliError, SelfEvent } from "./types.js";

const CRITERION_EVENTS = [CRITERION_DECLARED, CRITERION_BLOCKED, CRITERION_UNBLOCKED];

// Every event this machine holds for a project, in the order a fold applies
// them. A git-backed store keeps them all in one file and this is a read of it.
//
// A server-backed store keeps them in two, and the join is here rather than in
// each reader: the stored log is the server's copy, and beside it is this
// machine's queue of appends the server has not taken. One place asks for both,
// so a surface added later cannot answer from half the log by forgetting the
// other half existed.
export function readEvents(storeDir: string, slug: string): SelfEvent[]
{
    const stored = readLog(storeDir, slug);
    return serverBacked(storeDir) ? withUnsent(stored, pendingEvents(storeDir, slug)) : stored;
}

// A damaged line stops the read and says which line, exactly as the queue file's
// reader does. The two files are one log between them, so a reader that stepped
// over half a line here would answer as though records the workspace has agreed
// on were never written — and a truncated line is likelier here than anywhere
// else, because this file is appended to by a network read that can be cut off
// mid-record.
function readLog(storeDir: string, slug: string): SelfEvent[]
{
    const file = join(projectStateDir(storeDir, slug), "log.jsonl");
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8").split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter((row) => row.line.trim() !== "")
        .map((row) => parseLogLine(row.line, file, row.number));
}

function parseLogLine(line: string, file: string, number: number): SelfEvent
{
    try
    {
        return JSON.parse(line) as SelfEvent;
    }
    catch
    {
        throw new CliError(`${file} line ${number} is not readable as JSON — it is this workspace's own log, so it `
            + "is repaired by hand rather than discarded: open the file, read that one line, and put back the "
            + "record it was meant to be or take the line out");
    }
}

// The server's copy first, in the order the server put it in, and this
// machine's unsent tail after it. That order is the fold's own semantics rather
// than a compromise: a record the workspace has already agreed on stands ahead
// of one only this machine has made, and an append made offline lands after
// everything that arrived while it was offline — which is what a person reading
// two machines' work in one log expects to see.
//
// An event is counted once wherever it turns up twice, and the first copy is the
// one kept — which makes the stored copy win, because it comes first. Between a
// push that succeeded and the pull that marks it sent, the same record is in the
// queue and in the server's answer; and a record resent after a crash between
// the append and the mark is in the queue twice over. Both are one act, and a
// fold applying either of them twice would read it as two.
//
// So the set accumulates across the whole joined sequence rather than being
// taken off the stored copy alone: a duplicate that never reached the server has
// no stored copy to be recognised by.
function withUnsent(stored: SelfEvent[], unsent: SelfEvent[]): SelfEvent[]
{
    const seen = new Set<string>();
    const joined: SelfEvent[] = [];
    for (const event of [...stored, ...unsent])
    {
        if (!seen.has(event.id))
        {
            seen.add(event.id);
            joined.push(event);
        }
    }
    return joined;
}

export function findEventByPrefix(storeDir: string, slug: string, prefix: string): SelfEvent
{
    const matches = readEvents(storeDir, slug).filter((event) => event.id.startsWith(prefix));
    if (matches.length === 0)
    {
        throw new CliError(`no event matches id prefix "${prefix}"`);
    }
    if (matches.length > 1)
    {
        throw new CliError(`id prefix "${prefix}" is ambiguous (${matches.length} matches)`);
    }
    return matches[0];
}

// Which record an event speaks about. Decided by the event's own type wherever
// its payload names more than one record, because a payload id alone answers
// the wrong question: `work.proposed` carries the objective and milestone the
// proposal serves, and a proposal is identified by the event that opened it,
// so reading the payload would attribute a declined proposal's events to its
// objective — or to nothing.
//
// The rest fall through to the payload, most specific first: a requirement
// event names its work unit too, and answering with the unit would file the
// requirement's own events under the unit. A decision and a convention are
// named by the event that opened them, which is why the event id is the last
// resort. Read here rather than in a renderer because per-entity history
// (#212 R3) is the one surface that asks it, and it is a fact about the log.
const PROPOSAL_TRANSITIONS = ["work.accepted", "work.declined"];

export function eventRecord(event: SelfEvent): string
{
    if (event.type === "work.proposed")
    {
        return event.id;
    }
    if (PROPOSAL_TRANSITIONS.includes(event.type))
    {
        return String(event.payload.proposal ?? event.id);
    }
    const named = event.payload.requirement ?? event.payload.milestone
        ?? event.payload.objective ?? event.payload.entity ?? event.payload.work;
    return named === undefined ? event.id : String(named);
}

// Every event id an annulment took back, read off `refs.annuls` whatever the
// event type says (#390) — an older log's `entity.restored` and this CLI's
// `entity.annulled` mean the same thing here. The log marks the rows it names,
// so a reader scanning history sees which half of a pair no longer holds.
export function annulledEvents(events: SelfEvent[]): Set<string>
{
    return new Set(events.map((event) => event.refs?.annuls)
        .filter((value): value is string => typeof value === "string" && value !== ""));
}

export function eventSummary(event: SelfEvent): string
{
    // An annulment says what it took back rather than repeating the record's
    // words, so a log row reads without resolving the event it names.
    if (event.type === "entity.annulled")
    {
        const why = event.payload.why === undefined ? "" : ` — ${String(event.payload.why)}`;
        return `undone ${String(event.payload.undid ?? "an event")} [${String(event.refs?.annuls ?? "")}]${why}`;
    }
    // The criterion axis names the record as well as the criterion (#408): a
    // criterion's text stands alone in a log row without saying whose it is,
    // and every one of these events is about one unit's own conditions.
    if (CRITERION_EVENTS.includes(event.type))
    {
        return criterionSummary(event);
    }
    return statedParts(event).filter((value) => value !== undefined).map((value) => String(value)).join(" ");
}

// What the rest of the vocabulary says about itself, most specific first.
function statedParts(event: SelfEvent): unknown[]
{
    const payload = event.payload;
    return [payload.work, payload.objective, payload.milestone, payload.proposal, payload.criterion,
        payload.attempt, payload.text ?? payload.outcome ?? payload.why ?? payload.as ?? payload.detail,
        // What differed from expectation, on the report's own line (#380).
        // The log is where a reader scans for it, and a friction sentence that
        // only the raw JSON carried would be typed capture nobody reads.
        frictionNote(payload.friction),
        // A revision states the new plan and why it changed, and the reason is
        // readable nowhere else: the record keeps only the text it now states
        // (#356), so the unit's own history is where that reason lives.
        event.type === "entity.revised" ? payload.why : undefined];
}

// A criterion row: the unit, the criterion in its own words, and what this
// event said about it. `cN` is deliberately absent — it is a read-time
// position in the current declared list, and a log row states what was
// recorded rather than what the list looks like now.
function criterionSummary(event: SelfEvent): string
{
    const named = `${String(event.payload.entity ?? "")} "${String(event.payload.criterion ?? "")}"`;
    if (event.type === CRITERION_BLOCKED)
    {
        const why = event.payload.why === undefined ? "" : `: ${String(event.payload.why)}`;
        return `${named} — blocked on ${String(event.payload.on ?? "external")}${why}`;
    }
    if (event.type === CRITERION_UNBLOCKED)
    {
        return `${named} — released`;
    }
    return `${named}${event.payload.verify === undefined ? "" : ` · verify: ${String(event.payload.verify)}`}`;
}

// Marked rather than run together with the summary text, so a scan can tell
// the report from the surprise it met. Read defensively: the log is a file
// other clones wrote, and a shape it did not promise is skipped, never thrown
// over — a malformed line must not take the whole listing down with it.
function frictionNote(value: unknown): string | undefined
{
    if (!Array.isArray(value) || value.length === 0)
    {
        return undefined;
    }
    return `(friction: ${value.map((sentence) => String(sentence)).join("; ")})`;
}
