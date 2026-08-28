// What `self undo` may take back, what one undo covers, and what stands in
// its way (#390). A mistaken record is erased rather than dressed up as a
// meaningful supersession, so the grammar here is undoable-by-default with a
// short list of named exceptions — each refusal naming the verb that does the
// job instead.
//
// Flat in `src/` because the CLI surface reads it and a core module may not
// import a subsystem. It reads events and composes events; it appends nothing.

import { isEntityCreation } from "./entities.js";
import { CliError, SelfEvent } from "./types.js";

// Refused by name, with the verb that does the job. Reaching one of these at
// all means someone looked for `undo` here, and a generic answer would send
// them away without the thing they actually wanted.
const REFUSED: ReadonlyArray<readonly [string, (event: SelfEvent) => string]> = [
    ["artifact.registered", (event) => `${event.id} registered artifact ${String(event.payload.artifact ?? "")} — bytes `
        + `entered the store, and they leave it by \`self artifact prune ${String(event.payload.artifact ?? "<id>")} --why w\` and nothing else`],
    ["artifact.pruned", (event) => `${event.id} removed bytes from the store — nothing takes back a deletion`],
    ["project.archived", (event) => `${event.id} archived project "${event.project}" — an archive is ended by `
        + `\`self project restore ${event.project}\`, which takes --why if it should never have been archived`],
    ["project.restored", (event) => `${event.id} restored project "${event.project}" — a project is set aside again by `
        + `\`self project archive ${event.project}\``],
    ["work.run-started", (event) => runTelemetryRefusal(event)],
    ["work.run-exited", (event) => runTelemetryRefusal(event)],
    ["entity.annulled", (event) => notUndoneTwice(event)],
    ["entity.restored", (event) => notUndoneTwice(event)]
];

function runTelemetryRefusal(event: SelfEvent): string
{
    return `${event.id} is a ${event.type} — a process really ran, and the log states the machine rather than a `
        + "judgement; there is nothing here a mistake could have made";
}

function notUndoneTwice(event: SelfEvent): string
{
    return `${event.id} is itself an undo — an undo is not undone; record the act forward instead `
        + "(`self work add`, `self work retire`, `self work link`, …), which is the honest record of what happened";
}

// Written by no command in this tree and read only for older logs. Annulling
// one would be a second fold to keep correct for a grammar nothing appends to.
const LEGACY_PREFIXES = ["decision.", "objective.", "milestone.", "run.", "work."];
const LEGACY_TYPES = ["goal.set", "entity.superseded", "review.received"];

// A design approval is the one event a unit's history turns on that names its
// unit nowhere in its payload — the approval lands on a report, and the unit is
// at `refs.work`. Named once, because both halves of undoing one read it: what
// may be taken back, and what a later event stood on.
const APPROVED_DESIGN = "report.confirmed";

// The types outside the `entity.*` families an undo takes back. A report filed
// against the wrong unit is the mistake class #390 names, and its friction
// feeds the sweep, so a wrong one propagates.
//
// `report.confirmed` joined them in #400. It was refused for being "a person's
// ruling", which stopped being a distinguishing fact the moment a session could
// record the same ruling — and a design approved against the wrong unit is the
// same mistake a wrong report is. What it admits is guarded instead: a unit
// dispatched on the approval makes taking it back a refusal with the list.
const UNDOABLE_REPORTS = ["report.added", APPROVED_DESIGN];

// Whether this event is a kind an undo takes back, or the refusal that names
// what does the job. Undoable-by-default over the `entity.*` grammar: with the
// exception list above, that reads correctly and a kind added later is
// undoable without anyone remembering to say so.
export function requireUndoable(event: SelfEvent): void
{
    const refusal = REFUSED.find(([type]) => type === event.type);
    if (refusal !== undefined)
    {
        throw new CliError(refusal[1](event));
    }
    if (UNDOABLE_REPORTS.includes(event.type) || (event.type.startsWith("entity.") && !isLegacyType(event.type)))
    {
        return;
    }
    throw new CliError(`${event.id} is a ${event.type} — it predates the record grammar this CLI writes, and no `
        + "verb here produces it, so there is nothing to take back");
}

function isLegacyType(type: string): boolean
{
    return LEGACY_TYPES.includes(type) || LEGACY_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/* ── one append is one thing to undo ───────────────────────────────── */

// The records an event is *about*. Two events of one append that share one of
// these are one state change: `work done --report` names the unit twice, and
// taking back half of it would leave a report claiming a completion that no
// longer happened.
//
// A link's target is deliberately absent. It is the far end of an edge, not
// the record the event speaks about, and several unrelated edges into one
// target are several state changes: `objective revise` writes one carry link
// per milestone into one successor, and undoing one carry must return that
// milestone alone.
function subjectIds(event: SelfEvent): string[]
{
    return [event.payload.entity, event.payload.successor, event.refs?.work, event.refs?.confirms, event.refs?.admits]
        .filter((value): value is string => typeof value === "string" && value !== "");
}

// Every record id an event names, edges included. Wider than `subjectIds`
// because a later event is built on this one whichever end of an edge it
// names.
function namedIds(event: SelfEvent): string[]
{
    const links = Array.isArray(event.payload.links) ? event.payload.links as { target?: unknown }[] : [];
    const link = event.payload.link as { target?: unknown } | undefined;
    return [
        event.payload.entity, event.payload.successor, link?.target, ...links.map((item) => item?.target),
        event.refs?.work, event.refs?.confirms, event.refs?.admits
    ].filter((value): value is string => typeof value === "string" && value !== "");
}

// The coupled component of the append the named event belongs to. Not the
// whole append: `self sweep --record` writes N independent proposals in one
// write, and undoing one swept proposal must not annul the other N−1.
export function coupledUnit(events: SelfEvent[], target: SelfEvent): SelfEvent[]
{
    const batch = target.refs?.batch;
    if (typeof batch !== "string" || batch === "")
    {
        return [target];
    }
    const members = events.filter((event) => event.refs?.batch === batch);
    const unit = [target];
    // Membership is by event id, never by object identity: the caller resolved
    // the target from its own read of the log, so the same line is a different
    // object here and a reference check would add it to the unit twice.
    const chosen = new Set([target.id]);
    const reached = new Set(subjectIds(target));
    let grew = true;
    while (grew)
    {
        const next = members.filter((event) => !chosen.has(event.id) && subjectIds(event).some((id) => reached.has(id)));
        next.forEach((event) => { chosen.add(event.id); unit.push(event); subjectIds(event).forEach((id) => reached.add(id)); });
        grew = next.length > 0;
    }
    return unit.sort(byOrder);
}

// `(ts, event id)` — the comparator the fold's own passes use, so two clones
// of one store compute one answer.
function byOrder(left: SelfEvent, right: SelfEvent): number
{
    return left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id);
}

/* ── what was built on top ─────────────────────────────────────────── */

// Every id an annulment took back. Read off `refs.annuls` whatever the event
// type says, exactly as the fold reads it, so an older log's `entity.restored`
// counts here too.
export function annulledIds(events: SelfEvent[]): Set<string>
{
    return new Set(events.map((event) => event.refs?.annuls)
        .filter((value): value is string => typeof value === "string" && value !== ""));
}

// The records this append created. A transition names a record it did not
// create, and the two are told apart here because a dependent of the first
// kind is anything attached to the record since.
function createdRecords(unit: SelfEvent[]): Set<string>
{
    return new Set(unit.filter(isEntityCreation).map((event) => String(event.payload.entity ?? "")).filter((id) => id !== ""));
}

// The refs by which a later event says it was built on an earlier one: an
// acceptance of a proposal, a decision sequenced behind one, a swept proposal
// citing a report's friction, a design gate citing a decision.
function citedEvents(event: SelfEvent): string[]
{
    const refs = event.refs;
    return [refs?.confirms, refs?.after, refs?.admits, refs?.annuls, ...refs?.friction ?? [], ...refs?.implements ?? []]
        .filter((value): value is string => typeof value === "string" && value !== "");
}

// The record ids a later event attaches itself to: any transition, report,
// link or artifact recorded against the record since.
function attachedRecords(event: SelfEvent): string[]
{
    return [...namedIds(event), ...event.refs?.blocks ?? []]
        .filter((value): value is string => typeof value === "string" && value !== "");
}

// Whether a later event was built on this append. Three clauses: it cites one
// of these events by id, it attaches itself to a record these events created,
// or it names a record whose ordered history these events are part of. The
// last one deliberately over-refuses a little — undoing a `block` that an
// unrelated report followed is refused — because the safe direction is the one
// that hands the agent a list rather than the one that silently annuls
// something.
function dependsOn(event: SelfEvent, unit: SelfEvent[], created: Set<string>, moved: Set<string>): boolean
{
    const ids = new Set(unit.map((item) => item.id));
    return citedEvents(event).some((id) => ids.has(id))
        || attachedRecords(event).some((id) => created.has(id))
        || attachedRecords(event).some((id) => moved.has(id));
}

// The events whose removal changes what a later event folded to. The
// working-state axis and the assertion axis are order-dependent — the fold's
// matrix refuses a start on a blocked record and a second done, and an
// acceptance binds the version that was current — so taking one back under a
// record that has moved on since is refused with the list.
//
// Links and coverage claims are deliberately absent: they accumulate, and
// removing one leaves every other exactly where it was, so undoing a link a
// later start followed is not a half-applied history.
const ORDERED_TRANSITIONS = ["entity.started", "entity.blocked", "entity.unblocked", "entity.done",
    "entity.retired", "entity.retracted", "entity.confirmed"];

// The records this append moved without creating them: undoing a start after a
// done, a block after an unblock, or a design approval a dispatch followed, is
// refused on this list.
function movedRecords(unit: SelfEvent[], created: Set<string>): Set<string>
{
    return new Set(unit.flatMap(movedBy).filter((id) => id !== "" && !created.has(id)));
}

// `design.ts`'s dispatch gate reads a design approval, so a `work start`
// recorded after one stood on it, and taking the approval back alone would
// leave a dispatched unit whose design nobody approved.
function movedBy(event: SelfEvent): string[]
{
    if (event.type === APPROVED_DESIGN)
    {
        return [String(event.refs?.work ?? "")];
    }
    return ORDERED_TRANSITIONS.includes(event.type) ? [String(event.payload.entity ?? "")] : [];
}

// Everything standing on this append, newest first. Empty is the answer that
// lets the undo run; anything else is refused with the list, never cascaded —
// a cascade writes annulments nobody named, and the store merges across
// machines, so one clone would compute a set another would not.
export function dependentsOf(events: SelfEvent[], unit: SelfEvent[]): SelfEvent[]
{
    const annulled = annulledIds(events);
    const ids = new Set(unit.map((item) => item.id));
    const created = createdRecords(unit);
    const moved = movedRecords(unit, created);
    const last = [...unit].sort(byOrder).at(-1) as SelfEvent;
    return events
        // An annulment is never a dependent: it asserts nothing, and it names
        // the record it took an event back on. Counting one would make the
        // first undo of a report permanently block the undo of the unit that
        // report was filed against.
        .filter((event) => event.refs?.annuls === undefined)
        .filter((event) => !ids.has(event.id) && !annulled.has(event.id) && byOrder(event, last) > 0)
        .filter((event) => dependsOn(event, unit, created, moved))
        .sort((left, right) => byOrder(right, left));
}

// The refusal, with the lines to run and the order to run them in. Exit 2 —
// the answer will not change, so an agent must never retry it.
export function dependentRefusal(target: SelfEvent, dependents: SelfEvent[]): string
{
    const rows = dependents.map((event) => `    ${event.id}  ${event.type.padEnd(16)} ${summaryOf(event)}`);
    return [
        `${target.id} was built on — ${dependents.length === 1 ? "1 event names" : `${dependents.length} events name`} it`,
        ...rows,
        "  take them back first, newest first:",
        ...dependents.map((event) => `    self undo ${event.id}`)
    ].join("\n");
}

function summaryOf(event: SelfEvent): string
{
    const record = String(event.payload.entity ?? event.refs?.work ?? "");
    const text = String(event.payload.text ?? event.payload.why ?? "");
    return `${record}${record !== "" && text !== "" ? " " : ""}${text}`.trim();
}
