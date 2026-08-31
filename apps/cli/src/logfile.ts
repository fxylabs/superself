import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CRITERION_BLOCKED, CRITERION_DECLARED, CRITERION_UNBLOCKED } from "@superself/fold";
import { projectStateDir } from "./paths.js";
import { CliError, SelfEvent } from "./types.js";

const CRITERION_EVENTS = [CRITERION_DECLARED, CRITERION_BLOCKED, CRITERION_UNBLOCKED];

export function readEvents(storeDir: string, slug: string): SelfEvent[]
{
    const file = join(projectStateDir(storeDir, slug), "log.jsonl");
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
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
