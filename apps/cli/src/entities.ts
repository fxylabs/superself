// The entity fold of the company state engine (#197 §2, §5, §8). One record
// kind — text, free labels, typed links, reserved metadata, placement, and a
// shared lifecycle — is what every asserted statement folds to: the raw
// entities `self state` records, and the legacy record kinds read as entities
// without a stored event changing.
//
// This module owns the `entity.*` namespace: the event vocabulary, the fold
// that reads it, and the legacy interpretation. Domain layer — it imports
// `types.ts` and its peer `objectives.ts` only, never the fold that calls it.

import { MilestoneState, ObjectiveState } from "./objectives.js";
import { countCharacters } from "./style.js";
import { CliError, SelfEvent } from "./types.js";

// Spelled once, for the verbs' refusals and the fold's own reading guards.
export const EXPOSURES = ["full", "index", "search"] as const;
export const LINK_TYPES = ["member-of", "supersedes", "relates"] as const;

export type Exposure = (typeof EXPOSURES)[number];
export type LinkType = (typeof LINK_TYPES)[number];
type EntityStatus = "proposed" | "confirmed" | "superseded" | "retracted";

// Where a record renders, never where it is stored (#181 D1). Three forms:
// `project` — the project whose log holds it, the default and what every event
// written before #181 carries; `workspace` — every registered project; any
// other value — that registered project's slug. A record that names another
// project renders there and stops rendering at home (D2), and not one event
// moves: this is the mechanism `workspace` already used, generalized from one
// destination to any of them.
export type EntityScope = string;

// The sentinel that means "the project this record's log belongs to". Written
// by every add, and by a placement back home.
export const HOME_SCOPE = "project";

// The project a record renders in, named absolutely: its home slug where the
// scope is the sentinel, and the scope itself otherwise.
export function scopeTarget(placed: { scope: EntityScope }, home: string): string
{
    return placed.scope === HOME_SCOPE ? home : placed.scope;
}

// Whether a record whose log belongs to `home` renders in `viewer`'s context.
// A workspace record renders everywhere including home; every other record
// renders in exactly one project, which stops being home the moment it moves.
export function rendersIn(placed: { scope: EntityScope }, home: string, viewer: string): boolean
{
    const target = scopeTarget(placed, home);
    return target === "workspace" || target === viewer;
}

export interface EntityLink
{
    type: LinkType;
    target: string;
}

// A placement proposal waiting on a person (#197 §5, ruling 4): recorded by
// `state place --proposed`, applied only once an `entity.confirmed` names the
// placement event in `refs.confirms` — the same propose/confirm grammar the
// entity itself uses. Until then the entity keeps its current placement and
// carries the proposal, so a render can say what waits.
interface PendingPlacement
{
    event: string;
    priority?: number;
    exposure?: Exposure;
    scope?: EntityScope;
    why?: string;
    // The record this demotion makes room for, when the placement is the
    // demotion half of a cap-driven pair: the confirm surface applies the
    // whole pair as one unit through this reference.
    admits?: string;
}

// Which preset record kind an entity is a record of. A legacy-derived entity
// carries the kind it was read from; a native entity carries the preset label
// it was recorded under (#207): the preset verbs own its lifecycle either way,
// and the raw verbs refuse it toward them. Absent for a free-labeled entity
// `self state add` recorded.
export type EntitySource = "goal" | "decision" | "convention" | "objective" | "milestone" | "work";

// The labels that make a native entity a preset record. One list, read by the
// fold, so `decide` and `state add --label decision` mint the same record kind
// — presets are sugar over the entity, never a parallel type (#197 §7).
const SOURCE_LABELS: EntitySource[] = ["goal", "decision", "convention", "objective", "milestone", "work"];

function sourceOf(labels: string[]): EntitySource | undefined
{
    return SOURCE_LABELS.find((label) => labels.includes(label));
}

// The working state the execution events (#197 §5, #205) fold to. Facts about
// doing, never assertions: no propose/confirm timing exists on this axis, and
// an entity that no execution event ever touched is simply open.
type ExecutionStatus = "in-progress" | "blocked" | "done" | "retired";

interface EntityExecution
{
    status: ExecutionStatus;
    ts: string;
    // What a blocked entity waits on, and the reason recorded with a block or
    // a retirement — free text by design: the blocked-reason enum was removed
    // as structure and kept as optional metadata (#197 §7).
    on?: string;
    why?: string;
    // The done-time text report: the evidence the done claim carried.
    report?: string;
    // Where a retired outcome went, when the retirement named a successor.
    successor?: string;
    // The successor's project, when the retirement moved the outcome across
    // projects. Carried for the work reading; renders that print a successor
    // without it mean the same project.
    successorProject?: string;
}

// One coverage claim (#207 C): a criterion the entity declared, judged covered
// with a reason, by a recorded actor, optionally citing the work unit and the
// commits the evidence lives in. Claims bind to the entity id — a superseding
// revision starts uncovered by construction.
interface CoverageClaim
{
    criterion: string;
    ts: string;
    why: string;
    actor: string;
    work?: string;
    commits: string[];
}

export interface EntityState
{
    id: string;
    ts: string;
    text: string;
    labels: string[];
    links: EntityLink[];
    // Reserved metadata (#197 §2). The vocabulary is `target`, `criteria` and
    // `from`, and grows only by design decision: the verb refuses anything
    // else, and the fold ignores unknown keys a hand-appended line might carry.
    target?: string;
    criteria: string[];
    // Which project this one came from, by slug (#75). A slug rather than a
    // record id, which is why it is reserved metadata and not an `EntityLink`,
    // and a machine-read value rather than a free label spelling, which is why
    // the verb can validate it. Decision `01kz96jysmppnk0npgz6gbr696` is the
    // design decision this key grows the vocabulary by.
    from?: string;
    why?: string;
    scope: EntityScope;
    priority?: number;
    exposure: Exposure;
    status: EntityStatus;
    humanConfirmed: boolean;
    // Set once the entity was ever confirmed. Only such an entity's
    // supersedes links displace their targets — a proposal must not, and a
    // proposal retracted before confirmation never did.
    confirmedOnce: boolean;
    // The coverage claims recorded against the declared criteria, in the
    // order they landed. done/reach is gated on every criterion carrying one.
    covered: CoverageClaim[];
    // Set on an entity an `entity.*` creation event minted, absent on the
    // legacy readings: the model projects native preset records back into the
    // legacy read shapes, and this is the mark it projects by.
    native?: boolean;
    supersededBy?: string;
    // Why the record was retracted, or what closed the legacy record it
    // reads. Absent on a supersession, which says why by naming its successor.
    closedWhy?: string;
    source?: EntitySource;
    pending?: PendingPlacement;
    // Absent until an execution event names the entity: open is the default
    // working state, not a recorded one.
    execution?: EntityExecution;
    // Which session last picked the record up, and when (#230). Kept beside
    // the working state rather than inside it, because a block or an unblock
    // replaces the working state and says nothing about who is on the work.
    claim?: { session?: string; ts: string };
}

export function isLive(entity: EntityState): boolean
{
    return entity.status === "proposed" || entity.status === "confirmed";
}

// The label that makes a record the derivation of a project (#75). Spelled
// once, so the verb that records the relation and every surface that resolves
// it read the same word.
export const DERIVATION_LABEL = "derivation";

// Which project the records of one log say their project came from: the live
// derivation record, or nothing. A withdrawn or superseded one is not an
// answer, which is what makes a correction and a retraction work with no
// second mechanism. `self project from` refuses a second live one, but a log
// merged from another clone can still carry two, so the newest wins with the
// id breaking the tie — two clones of one store answer the same.
export function derivationOf(entities: EntityState[]): EntityState | undefined
{
    return entities
        .filter((item) => isLive(item) && (item.from ?? "") !== "" && item.labels.includes(DERIVATION_LABEL))
        .sort((left, right) => right.ts.localeCompare(left.ts) || left.id.localeCompare(right.id))[0];
}

/* ── correcting a record ───────────────────────────────────────────── */

// The record kind an id answers as: its preset source, or the free-labeled
// entity the raw verb records.
type EntityKind = EntitySource | "entity";

// Correcting a record reads the same on every add verb — `--supersedes <id>`
// restates the text and carries the lineage — so the only thing left to say
// about a target of another kind is which add verb owns it. One table over the
// record kinds, read by every surface that takes the flag, instead of a
// spelling per surface.
const SUPERSEDE_SPELLING: Record<EntityKind, string> = {
    goal: '`self goal add "<text>" --supersedes <id>`',
    decision: '`self decide "<text>" --supersedes <id>`',
    convention: '`self convention add "<text>" --supersedes <id>`',
    objective: '`self objective add "<outcome>" --supersedes <id>`',
    milestone: "`self milestone add … --supersedes <id>`",
    work: '`self work add "<outcome>" --supersedes <id> --why w`',
    entity: '`self state add "<text>" --supersedes <id>`'
};

// Refuses a `--supersedes` target that is another kind of record, naming the
// add verb that corrects that kind. An id no record answers to is left to the
// caller's own resolver, which can say how to list the ids it accepts.
export function requireSupersedeKind(entities: EntityState[], wanted: string, kind: EntityKind): void
{
    const entity = supersedeTarget(entities, wanted);
    if (entity === undefined)
    {
        return;
    }
    const found = entity.source ?? "entity";
    if (found !== kind)
    {
        const article = /^[aeiou]/.test(found) ? "an" : "a";
        throw new CliError(`${entity.id} is ${article} ${found} record — replace it with ${SUPERSEDE_SPELLING[found]}`);
    }
}

// Exact id first, then a unique prefix — the preset kinds take a prefix of a
// 26-character event id, and a prefix more than one record answers to says
// nothing about kind.
function supersedeTarget(entities: EntityState[], wanted: string): EntityState | undefined
{
    const exact = entities.find((item) => item.id === wanted);
    if (exact !== undefined)
    {
        return exact;
    }
    const matches = entities.filter((item) => item.id.startsWith(wanted));
    return matches.length === 1 ? matches[0] : undefined;
}

// One `entity.placed` line, collected rather than applied in the pass: a
// placement can name a legacy-derived entity that exists only after the
// derive step composes it, so every placement waits and lands there — one
// application path for native and legacy records alike.
interface PlacementEvent
{
    event: string;
    ts: string;
    entity: string;
    priority?: number;
    exposure?: Exposure;
    scope?: EntityScope;
    why?: string;
    admits?: string;
    proposed: boolean;
}

// One execution event, collected rather than applied in the pass for the same
// reason a placement is: the entity it names can be created later in a
// union-merged log, and the event-id guard lets the reconcile pass route the
// same line twice without applying it twice.
interface ExecutionEvent
{
    event: string;
    ts: string;
    entity: string;
    type: string;
    on?: string;
    why?: string;
    report?: string;
    successor?: string;
    successorProject?: string;
    // Which session recorded the transition, carried off `origin` rather than
    // the payload because every event has it. A start is what claims a unit
    // (#230), and an event written before sessions were stamped simply has
    // none — which reads as unclaimed, never as an anonymous holder.
    session?: string;
}

// A confirm, a retraction, a link edge, and a coverage claim collect exactly
// as placements and executions do: applied over the complete entity set in
// `deriveEntities`, because each can name a legacy-derived record that exists
// only after the derive step composes it (#207 E2), and the event-id guard
// lets the reconcile pass route the same line twice.
interface ConfirmEvent
{
    event: string;
    ts: string;
    confirms: string;
    humanConfirmed: boolean;
}

interface RetractEvent
{
    event: string;
    ts: string;
    entity: string;
    why?: string;
}

interface LinkEvent
{
    event: string;
    ts: string;
    entity: string;
    add: boolean;
    link: EntityLink;
}

interface CoverageEvent
{
    event: string;
    ts: string;
    entity: string;
    claim: CoverageClaim;
}

const EXECUTION_EVENTS = ["entity.started", "entity.blocked", "entity.unblocked", "entity.done", "entity.retired"];

export interface EntityFold
{
    entities: EntityState[];
    // Supersessions asserted by standalone `entity.superseded` events, applied
    // once every entity exists: a union-merged log orders lines by neither
    // time nor dependency, so a claim can precede either record it names.
    claims: { predecessor: string; successor: string }[];
    placements: PlacementEvent[];
    executions: ExecutionEvent[];
    confirms: ConfirmEvent[];
    retractions: RetractEvent[];
    links: LinkEvent[];
    coverage: CoverageEvent[];
    // Every id an `entity.confirmed` named in `refs.confirms`. A placement
    // proposal applies only when its event id is in here, and collecting the
    // ids first is what lets a union merge order the confirm above the
    // proposal it answers.
    confirmations: Set<string>;
    // Every destructive event an `entity.restored` took back, by id. An undo
    // names the event it reverses rather than asserting a new state, so the
    // fold skips what was annulled and every rule below keeps its shape:
    // first-withdrawal-wins still holds among the withdrawals that stand.
    // Binding to an id rather than to log order is also what keeps a merged
    // log safe — two clones fold the same lines to the same state whatever
    // order the merge produced.
    annulled: Set<string>;
}

export function emptyEntityFold(): EntityFold
{
    return {
        entities: [],
        claims: [],
        placements: [],
        executions: [],
        confirms: [],
        retractions: [],
        links: [],
        coverage: [],
        confirmations: new Set(),
        annulled: new Set()
    };
}

/* ── the single-pass fold ──────────────────────────────────────────── */

// Creation events, the goal chain, and the supersession claims fold here, in
// the same pass the rest of the model reads. The linking transitions run
// through `reconcileEntity`, from this pass and the reconcile pass alike.
// The annulments, read before anything else folds. A restoration can sit
// below the event it reverses in a merged log, so the set is complete before
// the first creation is read rather than accumulating alongside it.
export function collectAnnulled(fold: EntityFold, events: SelfEvent[]): void
{
    for (const event of events)
    {
        const annuls = event.type === "entity.restored" ? event.refs?.annuls : undefined;
        if (typeof annuls === "string" && annuls !== "")
        {
            fold.annulled.add(annuls);
        }
    }
}

export function applyEntity(fold: EntityFold, event: SelfEvent): void
{
    if (event.type === "goal.set")
    {
        applyGoal(fold, event);
        return;
    }
    if (!event.type.startsWith("entity."))
    {
        return;
    }
    if (isEntityCreation(event))
    {
        createEntity(fold, event);
        return;
    }
    if (event.type === "entity.superseded")
    {
        const predecessor = String(event.payload.entity ?? "");
        const successor = String(event.payload.successor ?? "");
        // A claim missing either side names no replacement; recording it would
        // mark a record superseded by nothing anyone can follow.
        if (predecessor !== "" && successor !== "")
        {
            fold.claims.push({ predecessor, successor });
        }
        return;
    }
    reconcileEntity(fold, event);
}

// An `entity.confirmed` that names no proposal asserts a new record directly,
// exactly as `decision.confirmed` does; with `refs.confirms` it is the
// transition that answers one.
export function isEntityCreation(event: SelfEvent): boolean
{
    return event.type === "entity.proposed"
        || (event.type === "entity.confirmed" && event.refs?.confirms === undefined);
}

function createEntity(fold: EntityFold, event: SelfEvent): void
{
    const id = String(event.payload.entity ?? "");
    // A union merge can carry the same creation line twice; the first one
    // read is the record.
    if (id === "" || fold.entities.some((item) => item.id === id))
    {
        return;
    }
    fold.entities.push(newEntity(fold, event, id));
}

// An annulled creation keeps its record and loses only what it displaced: the
// accident an undo answers is a supersedes link that should never have been
// attached, not the record it was attached to.
function createdLinks(fold: EntityFold, event: SelfEvent): EntityLink[]
{
    const links = readLinks(event.payload.links);
    return fold.annulled.has(event.id) ? links.filter((link) => link.type !== "supersedes") : links;
}

function newEntity(fold: EntityFold, event: SelfEvent, id: string): EntityState
{
    const confirmed = event.type === "entity.confirmed";
    const labels = stringList(event.payload.labels);
    return {
        id,
        ts: event.ts,
        text: String(event.payload.text ?? ""),
        labels,
        links: createdLinks(fold, event),
        target: str(event.payload.target),
        criteria: stringList(event.payload.criteria),
        from: str(event.payload.from),
        why: str(event.payload.why),
        scope: readScopeValue(event.payload.scope),
        priority: readPriority(event.payload.priority),
        exposure: readExposure(event.payload.exposure),
        status: confirmed ? "confirmed" : "proposed",
        humanConfirmed: event.origin.confirmed === true,
        confirmedOnce: confirmed,
        covered: [],
        native: true,
        source: sourceOf(labels)
    };
}

// Every `goal.set` is an entity: label goal, top of context, full text. The
// newest one is the goal — the "latest wins" the verb has always had — and
// each new statement supersedes the live ones before it, which gives the
// chain its lineage without touching a stored event.
function applyGoal(fold: EntityFold, event: SelfEvent): void
{
    const live = fold.entities.filter((item) => item.source === "goal" && isLive(item));
    fold.entities.push({
        id: event.id,
        ts: event.ts,
        text: String(event.payload.text ?? ""),
        labels: ["goal"],
        links: live.map((item) => ({ type: "supersedes" as const, target: item.id })),
        criteria: [],
        covered: [],
        scope: "project",
        priority: 0,
        exposure: "full",
        status: "confirmed",
        humanConfirmed: event.origin.confirmed === true,
        confirmedOnce: true,
        source: "goal"
    });
    for (const item of live)
    {
        item.status = "superseded";
        item.supersededBy = event.id;
    }
}

/* ── the linking transitions ───────────────────────────────────────── */

// The transitions that speak about a record another event created. Every one
// collects rather than applies (#207 E2): the record it names can be a
// legacy-derived one that exists only after the derive step composes it, and
// the event-id guards let the reconcile pass in `model.ts` route the same
// line twice without applying it twice.
type Collector = (fold: EntityFold, event: SelfEvent) => void;

const COLLECTORS: ReadonlyArray<readonly [(event: SelfEvent) => boolean, Collector]> = [
    [(event) => event.type === "entity.confirmed" && event.refs?.confirms !== undefined, collectConfirm],
    [(event) => event.type === "entity.retracted", collectRetraction],
    [(event) => event.type === "entity.placed", collectPlacement],
    [(event) => event.type === "entity.linked" || event.type === "entity.unlinked", collectLink],
    [(event) => event.type === "entity.covered", collectCoverage],
    [(event) => EXECUTION_EVENTS.includes(event.type), collectExecution]
];

export function reconcileEntity(fold: EntityFold, event: SelfEvent): void
{
    COLLECTORS.find(([matches]) => matches(event))?.[1](fold, event);
}

// Execution events collect like placements: applied over the complete entity
// set in `deriveEntities`, in timestamp order, so a union-merged log folds one
// working-state history on every clone. The event-id guard is what lets the
// reconcile pass in `model.ts` route the same line twice.
function collectExecution(fold: EntityFold, event: SelfEvent): void
{
    const entity = String(event.payload.entity ?? "");
    if (entity === "" || fold.executions.some((item) => item.event === event.id))
    {
        return;
    }
    fold.executions.push({
        event: event.id,
        ts: event.ts,
        entity,
        type: event.type,
        on: str(event.payload.on),
        why: str(event.payload.why),
        report: str(event.payload.report),
        successor: str(event.payload.successor),
        successorProject: str(event.payload.successorProject),
        session: event.origin.session
    });
}

function collectConfirm(fold: EntityFold, event: SelfEvent): void
{
    const confirms = String(event.refs?.confirms ?? "");
    if (confirms === "" || fold.confirms.some((item) => item.event === event.id))
    {
        return;
    }
    // Recorded whatever it names: a placement proposal's confirm carries the
    // placement's event id, which no entity ever matches at apply time.
    fold.confirmations.add(confirms);
    fold.confirms.push({ event: event.id, ts: event.ts, confirms, humanConfirmed: event.origin.confirmed === true });
}

function collectRetraction(fold: EntityFold, event: SelfEvent): void
{
    const entity = String(event.payload.entity ?? "");
    if (entity === "" || fold.retractions.some((item) => item.event === event.id))
    {
        return;
    }
    fold.retractions.push({ event: event.id, ts: event.ts, entity, why: str(event.payload.why) });
}

function collectCoverage(fold: EntityFold, event: SelfEvent): void
{
    const entity = String(event.payload.entity ?? "");
    const criterion = String(event.payload.criterion ?? "");
    if (entity === "" || criterion === "" || fold.coverage.some((item) => item.event === event.id))
    {
        return;
    }
    fold.coverage.push({
        event: event.id,
        ts: event.ts,
        entity,
        claim: {
            criterion,
            ts: event.ts,
            why: String(event.payload.why ?? ""),
            actor: String(event.origin.actor ?? "agent"),
            work: str(event.refs?.work),
            commits: stringList(event.refs?.commits)
        }
    });
}

// Placement moves by event (#197 §3), collected here and applied over the
// complete entity set in `deriveEntities`: the target can be a legacy-derived
// record that does not exist in this pass. The event-id guard is what lets
// the reconcile pass in `model.ts` route the same line twice.
function collectPlacement(fold: EntityFold, event: SelfEvent): void
{
    const entity = String(event.payload.entity ?? "");
    if (entity === "" || fold.placements.some((item) => item.event === event.id))
    {
        return;
    }
    fold.placements.push({
        event: event.id,
        ts: event.ts,
        entity,
        priority: readPriority(event.payload.priority),
        exposure: readExposureOptional(event.payload.exposure),
        scope: readScopeOptional(event.payload.scope),
        why: str(event.payload.why),
        admits: str(event.refs?.admits),
        proposed: event.payload.proposed === true
    });
}

function collectLink(fold: EntityFold, event: SelfEvent): void
{
    const entity = String(event.payload.entity ?? "");
    const links = readLinks([event.payload.link]);
    if (entity === "" || links.length === 0 || fold.links.some((item) => item.event === event.id))
    {
        return;
    }
    fold.links.push({ event: event.id, ts: event.ts, entity, add: event.type === "entity.linked", link: links[0] });
}

/* ── the legacy interpretation (#197 §8) ───────────────────────────── */

// What the legacy readings need from the folded records. Declared
// structurally here rather than imported from `model.ts` — a domain module
// never imports the fold that calls it — and the fold's own record shapes
// satisfy these by construction.
interface DecisionSource
{
    id: string;
    ts: string;
    text: string;
    why?: string;
    status: "proposed" | "confirmed" | "superseded" | "retracted" | "declined";
    humanConfirmed: boolean;
    supersedes: string[];
    closedWhy?: string;
}

interface ConventionSource
{
    id: string;
    ts: string;
    text: string;
    status: "current" | "superseded" | "dropped";
    supersedes: string[];
    closedWhy?: string;
}

interface LegacySources
{
    decisions: DecisionSource[];
    conventions: ConventionSource[];
    objectives: ObjectiveState[];
}

// The whole entity view: native records first, then the legacy readings, then
// every collected transition — each applied once, over the complete set,
// because a confirm, a retraction, a link, a claim or a placement can name a
// record from either half (#207 E2), and a merged log can order a standalone
// claim before its target.
export function deriveEntities(fold: EntityFold, legacy: LegacySources): EntityState[]
{
    const entities = [
        ...fold.entities,
        ...legacy.decisions.map(decisionEntity),
        ...legacy.conventions.map(conventionEntity),
        ...legacy.objectives.map(objectiveEntity),
        ...legacy.objectives.flatMap((objective) => objective.milestones.map(milestoneEntity))
    ];
    linkLineage(entities, legacy);
    applyConfirms(entities, fold);
    applyRetractions(entities, fold);
    applyLinks(entities, fold);
    applySupersessions(entities, fold);
    applyPlacements(entities, fold);
    applyCoverage(entities, fold);
    applyExecutions(entities, fold);
    return entities;
}

// Ordered as placements are — timestamp, event id — so two clones of one
// store settle one lifecycle. A confirm answers only a proposal; the first
// retraction is the one that happened, and it is applied before supersession
// so a withdrawal that already happened wins however the merged log ordered
// the two.
function applyConfirms(entities: EntityState[], fold: EntityFold): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    for (const confirm of ordered(fold.confirms))
    {
        const target = byId.get(confirm.confirms);
        if (target !== undefined && target.status === "proposed")
        {
            target.status = "confirmed";
            target.confirmedOnce = true;
            target.humanConfirmed = confirm.humanConfirmed;
            target.ts = confirm.ts;
        }
    }
}

// Withdrawal is terminal and keeps the record: text, links and lineage stay
// resolvable, the status alone leaves the current set. The first withdrawal
// is the one that happened; a later event naming the record changes nothing.
function applyRetractions(entities: EntityState[], fold: EntityFold): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    for (const retraction of ordered(fold.retractions))
    {
        if (fold.annulled.has(retraction.event))
        {
            continue;
        }
        const target = byId.get(retraction.entity);
        if (target !== undefined && isLive(target))
        {
            target.status = "retracted";
            target.closedWhy = retraction.why;
        }
    }
}

// A link is one edge in a set: adding it twice keeps one, removing it twice
// removes one. An event naming a record this set does not carry — a work unit
// still folded from legacy `work.*` history — is left for the model, which
// reads the same list and routes it onto the legacy record.
function applyLinks(entities: EntityState[], fold: EntityFold): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    for (const item of ordered(fold.links))
    {
        const target = byId.get(item.entity);
        if (target === undefined)
        {
            continue;
        }
        if (!item.add)
        {
            target.links = target.links.filter((link) => link.type !== item.link.type || link.target !== item.link.target);
        }
        else if (!target.links.some((link) => link.type === item.link.type && link.target === item.link.target))
        {
            target.links.push(item.link);
        }
    }
}

// Claims accumulate: a criterion may be judged more than once and every
// judgment stays on record. A claim naming a criterion the entity never
// declared folds to nothing — the verb refuses it, so such a line can only
// arrive hand-appended or from a revision that dropped the criterion.
function applyCoverage(entities: EntityState[], fold: EntityFold): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    for (const item of ordered(fold.coverage))
    {
        const target = byId.get(item.entity);
        if (target !== undefined && target.criteria.includes(item.claim.criterion))
        {
            target.covered.push(item.claim);
        }
    }
}

function ordered<T extends { ts: string; event: string }>(items: T[]): T[]
{
    return [...items].sort((left, right) => left.ts.localeCompare(right.ts) || left.event.localeCompare(right.event));
}

// The criteria no claim covers yet — what still gates a done or a reach.
export function uncoveredCriteria(entity: EntityState): string[]
{
    const covered = new Set(entity.covered.map((claim) => claim.criterion));
    return entity.criteria.filter((criterion) => !covered.has(criterion));
}

// What still renders as current state: a live record whose working state is
// not terminal. A done or retired outcome left the direction the context
// carries — the live-state sections and search still answer for it.
export function isCurrent(entity: EntityState): boolean
{
    return isLive(entity) && entity.execution?.status !== "done" && entity.execution?.status !== "retired";
}

// Working state lands in timestamp order, event id breaking ties — the same
// determinism rule placements follow. The fold never refuses history (#205
// table D): a line the transition matrix would have refused at the verb —
// a start on a blocked record, a second done — is dropped rather than
// applied, and a line naming an entity this store never saw folds to nothing.
function applyExecutions(entities: EntityState[], fold: EntityFold): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    const ordered = [...fold.executions].sort((left, right) =>
        left.ts.localeCompare(right.ts) || left.event.localeCompare(right.event));
    for (const event of ordered)
    {
        if (fold.annulled.has(event.event))
        {
            continue;
        }
        const target = byId.get(event.entity);
        if (target !== undefined)
        {
            applyExecution(target, event);
        }
    }
}

// Done and retired are terminal for the working state: a stale line merged
// from a clone that had not pulled the completion cannot reopen it. The
// remaining guards mirror the verb matrix, so a hand-appended or merge-
// reordered line folds to the state the verbs could actually have reached.
function applyExecution(target: EntityState, event: ExecutionEvent): void
{
    const status = target.execution?.status;
    if (status === "done" || status === "retired")
    {
        return;
    }
    // The claim lands whatever the start does to the working state: a start
    // against a blocked record changes no status and still says a session
    // picked the work up, which is the fact a second session reads (#230).
    if (event.type === "entity.started")
    {
        target.claim = { session: event.session, ts: event.ts };
    }
    const next = nextExecution(status, event);
    if (next !== null)
    {
        target.execution = next;
    }
}

// The working state a transition moves to, or null where the verb matrix
// would have refused it: a start on a blocked record, an unblock on one that
// is not blocked.
function nextExecution(status: ExecutionStatus | undefined, event: ExecutionEvent): EntityExecution | null
{
    if (event.type === "entity.started" && status !== "blocked")
    {
        return { status: "in-progress", ts: event.ts };
    }
    if (event.type === "entity.blocked" && status !== "blocked")
    {
        return { status: "blocked", ts: event.ts, on: event.on, why: event.why };
    }
    if (event.type === "entity.unblocked" && status === "blocked")
    {
        return { status: "in-progress", ts: event.ts };
    }
    if (event.type === "entity.done")
    {
        return { status: "done", ts: event.ts, report: event.report };
    }
    if (event.type === "entity.retired")
    {
        return { status: "retired", ts: event.ts, why: event.why, successor: event.successor, successorProject: event.successorProject };
    }
    return null;
}

// How a working state reads on a page: `state show` prints it, and a second
// spelling elsewhere would let two surfaces disagree about the same record.
export function executionSummary(execution: EntityExecution): string
{
    if (execution.status === "blocked")
    {
        return `blocked${execution.on === undefined ? "" : ` on ${execution.on}`}${execution.why === undefined ? "" : ` — ${execution.why}`}`;
    }
    if (execution.status === "done")
    {
        return `done${execution.report === undefined ? "" : ` — ${execution.report}`}`;
    }
    if (execution.status === "retired")
    {
        return `retired${execution.why === undefined ? "" : ` — ${execution.why}`}${execution.successor === undefined ? "" : ` (successor ${execution.successor})`}`;
    }
    return "in-progress";
}

// Placements land in timestamp order, event id breaking ties — never in log
// order, which a union merge does not preserve, so two clones of one store
// fold one placement history. A proposal that no confirm has answered pends
// on its entity instead of moving it; a withdrawn or superseded record is
// past placing either way.
function applyPlacements(entities: EntityState[], fold: EntityFold): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    const ordered = [...fold.placements].sort((left, right) =>
        left.ts.localeCompare(right.ts) || left.event.localeCompare(right.event));
    for (const placement of ordered)
    {
        const target = byId.get(placement.entity);
        if (target === undefined || !isLive(target))
        {
            continue;
        }
        if (placement.proposed && !fold.confirmations.has(placement.event))
        {
            target.pending = {
                event: placement.event,
                priority: placement.priority,
                exposure: placement.exposure,
                scope: placement.scope,
                why: placement.why,
                admits: placement.admits
            };
            continue;
        }
        applyPlacement(target, placement);
    }
}

function applyPlacement(target: EntityState, placement: PlacementEvent): void
{
    if (placement.priority !== undefined)
    {
        target.priority = placement.priority;
    }
    if (placement.exposure !== undefined)
    {
        target.exposure = placement.exposure;
    }
    if (placement.scope !== undefined)
    {
        target.scope = placement.scope;
    }
}

/* ── placement order and the retention-cap usage ───────────────────── */

// Priority order, ties by recency (#197 §6). An absent priority sorts after
// every stated one, and the id breaks the remaining tie so two clones of one
// store render one order. `state list` and the context projection both sort
// through here — a second comparator would let the two surfaces disagree.
export function orderEntities(entities: EntityState[]): EntityState[]
{
    return [...entities].sort((left, right) =>
        (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER)
        || right.ts.localeCompare(left.ts)
        || left.id.localeCompare(right.id));
}

// What currently occupies a retention tier (#197 §4): confirmed live records
// at the scope, because a proposal takes its place only when a person
// confirms it and a withdrawn record has already left. A done or retired
// outcome left the rendered set too, so it holds no seat. Full is measured in
// characters of entity text — the same code-point count the context budget
// charges — and index in entities.
// A tier belongs to the project a record renders in, not to the store that
// holds it (#181 D4), so occupancy is judged against the absolute target.
export function occupiesTier(entity: EntityState, home: string, target: string, exposure: Exposure): boolean
{
    return entity.status === "confirmed" && isCurrent(entity)
        && scopeTarget(entity, home) === target && entity.exposure === exposure;
}

// Both capped tiers are measured the same way since #213 — the characters the
// tier holds. The conversion into tokens happens once, where the cap is
// compared, so a tier summed across stores rounds a single time.
export function tierCharacters(entities: EntityState[], home: string, target: string, exposure: Exposure): number
{
    return entities.filter((item) => occupiesTier(item, home, target, exposure))
        .reduce((sum, item) => sum + countCharacters(item.text), 0);
}

// Which transitions are demotions: exposure moving toward less-rendered —
// full → index, full → search, index → search. A priority change alone is
// never one: it reorders a record inside its tier without reducing how it
// renders, so it needs no --why and no proposal.
const EXPOSURE_RANK: Record<Exposure, number> = { full: 0, index: 1, search: 2 };

export function isDemotion(from: Exposure, to: Exposure): boolean
{
    return EXPOSURE_RANK[to] > EXPOSURE_RANK[from];
}

// Where a record named by --demote goes: one tier less rendered than the one
// it frees. Search has nothing below it, which is why nothing demotes out of
// search and an entry into search is never capped.
export const DEMOTION_TARGET: Record<"full" | "index", Exposure> = { full: "index", index: "search" };

// What a waiting placement proposal asks to change, in the words the person
// judges it by. `state show` and the context projection print the same
// sentence, so the row a person confirms from reads the same everywhere.
export function pendingSummary(pending: PendingPlacement): string
{
    const parts: string[] = [];
    if (pending.exposure !== undefined)
    {
        parts.push(`exposure ${pending.exposure}`);
    }
    if (pending.priority !== undefined)
    {
        parts.push(`priority ${pending.priority}`);
    }
    if (pending.scope !== undefined)
    {
        parts.push(`scope ${pending.scope}`);
    }
    const why = pending.why === undefined ? "" : ` (${pending.why})`;
    return `${parts.join(", ") || "no change"}${why}`;
}

// A decision is an entity labeled decision, one line in context. A declined
// proposal reads as retracted here: the shared grammar has one withdrawal
// status, and the decision's own record keeps saying "declined".
function decisionEntity(decision: DecisionSource): EntityState
{
    return {
        id: decision.id,
        ts: decision.ts,
        text: decision.text,
        labels: ["decision"],
        links: decision.supersedes.map((target) => ({ type: "supersedes" as const, target })),
        criteria: [],
        covered: [],
        why: decision.why,
        scope: "project",
        priority: 40,
        exposure: "index",
        status: decision.status === "proposed" || decision.status === "confirmed" || decision.status === "superseded"
            ? decision.status
            : "retracted",
        humanConfirmed: decision.humanConfirmed,
        confirmedOnce: decision.status !== "proposed" && decision.status !== "declined",
        closedWhy: decision.closedWhy,
        source: "decision"
    };
}

function conventionEntity(convention: ConventionSource): EntityState
{
    return {
        id: convention.id,
        ts: convention.ts,
        text: convention.text,
        labels: ["convention"],
        links: convention.supersedes.map((target) => ({ type: "supersedes" as const, target })),
        criteria: [],
        covered: [],
        scope: "project",
        priority: 30,
        exposure: "full",
        status: convention.status === "current" ? "confirmed"
            : convention.status === "superseded" ? "superseded" : "retracted",
        humanConfirmed: true,
        confirmedOnce: true,
        closedWhy: convention.closedWhy,
        source: "convention"
    };
}

// An objective closed as reached leaves the live set the way a withdrawal
// does, with "reached" recorded as the reason: the shared lifecycle carries
// no completion status yet — the evidenced execution layer is a later phase —
// and a reached objective must not read as live direction.
function objectiveEntity(objective: ObjectiveState): EntityState
{
    return {
        id: objective.id,
        ts: objective.ts,
        text: objective.outcome,
        labels: ["objective"],
        links: objective.supersedes.map((target) => ({ type: "supersedes" as const, target })),
        target: objective.target,
        criteria: [],
        covered: [],
        scope: "project",
        priority: 10,
        exposure: "full",
        status: objectiveStatus(objective),
        humanConfirmed: objective.humanConfirmed,
        confirmedOnce: objective.status !== "proposed" && objective.status !== "declined",
        supersededBy: objective.supersededBy,
        closedWhy: objective.status === "reached" ? objective.closedWhy ?? "reached" : objective.closedWhy,
        source: "objective"
    };
}

function objectiveStatus(objective: ObjectiveState): EntityStatus
{
    if (objective.status === "proposed")
    {
        return "proposed";
    }
    if (objective.status === "active")
    {
        return "confirmed";
    }
    return objective.status === "superseded" ? "superseded" : "retracted";
}

function milestoneEntity(milestone: MilestoneState): EntityState
{
    return {
        id: milestone.id,
        ts: milestone.ts,
        text: milestone.outcome,
        labels: ["milestone"],
        links: [{ type: "member-of" as const, target: milestone.objective }],
        target: milestone.target,
        // The live exit criteria are what still gates a reach; dropped ones
        // are revision history the milestone's own page keeps.
        criteria: milestone.exit.filter((item) => item.dropped !== true).map((item) => item.text),
        covered: [],
        scope: "project",
        priority: 20,
        exposure: "index",
        status: milestoneEntityStatus(milestone),
        humanConfirmed: true,
        confirmedOnce: true,
        supersededBy: milestone.supersededBy,
        closedWhy: milestone.droppedWhy ?? (milestone.reached !== undefined ? "reached" : undefined),
        source: "milestone"
    };
}

// Dropped first — `milestoneStatus` in model.ts makes the same call — then
// supersession, then a reach; a live checkpoint reads confirmed.
function milestoneEntityStatus(milestone: MilestoneState): EntityStatus
{
    if (milestone.droppedWhy !== undefined)
    {
        return "retracted";
    }
    if (milestone.supersededBy !== undefined)
    {
        return "superseded";
    }
    return milestone.reached !== undefined ? "retracted" : "confirmed";
}

// The one direction the folded records do not carry. A decision and a
// convention store the forward link on the successor, so the predecessor's
// supersededBy is filled from it; a milestone stores only the backward
// pointer, so its successor's supersedes link is inverted from it.
function linkLineage(entities: EntityState[], legacy: LegacySources): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    for (const source of [...legacy.decisions, ...legacy.conventions])
    {
        for (const target of source.supersedes)
        {
            const entity = byId.get(target);
            if (entity !== undefined && entity.status === "superseded" && entity.supersededBy === undefined)
            {
                entity.supersededBy = source.id;
            }
        }
    }
    for (const milestone of legacy.objectives.flatMap((objective) => objective.milestones))
    {
        const successor = milestone.supersededBy === undefined ? undefined : byId.get(milestone.supersededBy);
        if (successor !== undefined && !successor.links.some((link) => link.type === "supersedes" && link.target === milestone.id))
        {
            successor.links.push({ type: "supersedes", target: milestone.id });
        }
    }
}

// Replacement applies only from a record that was confirmed at some point —
// a proposal must not displace anything — and only onto a live one: a
// withdrawal that already happened wins over a supersession however the
// merged log ordered them. Single-step, never a chain walk, so a cycle a
// foreign writer appended cannot loop the fold.
function applySupersessions(entities: EntityState[], fold: EntityFold): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    for (const entity of entities)
    {
        if (!entity.confirmedOnce)
        {
            continue;
        }
        for (const link of entity.links)
        {
            if (link.type === "supersedes")
            {
                supersede(byId.get(link.target), entity.id);
            }
        }
    }
    for (const claim of fold.claims)
    {
        // A standalone claim answers to the same rule the links path does: it
        // settles only when the successor it names exists here and was
        // confirmed at some point. A proposal, or an id this store never saw,
        // replaces nothing.
        const successor = byId.get(claim.successor);
        if (successor !== undefined && successor.confirmedOnce)
        {
            supersede(byId.get(claim.predecessor), claim.successor);
        }
    }
}

function supersede(target: EntityState | undefined, successor: string): void
{
    if (target !== undefined && isLive(target))
    {
        target.status = "superseded";
        target.supersededBy = successor;
    }
}

/* ── payload helpers ───────────────────────────────────────────────── */

// Nothing read out of the log is trusted to be its declared shape: events
// arrive from other machines, and a malformed value reads as absent rather
// than crashing every fold that follows.
function readLinks(value: unknown): EntityLink[]
{
    if (!Array.isArray(value))
    {
        return [];
    }
    return value.flatMap((item) =>
    {
        const type = (item as { type?: unknown })?.type;
        const target = (item as { target?: unknown })?.target;
        return (LINK_TYPES as readonly string[]).includes(String(type)) && typeof target === "string" && target !== ""
            ? [{ type: type as LinkType, target }]
            : [];
    });
}

// Safe integers only, matching the verb's own refusal: a hand-appended
// priority the float type cannot hold exactly reads as absent rather than as
// a silently different number.
function readPriority(value: unknown): number | undefined
{
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// A scope arrives from the log as free text since #181, so the fold reads any
// non-empty string and lets the render decide whether a project answers to it.
// Anything else — absent, a number a hand-append left — reads as home.
function readScopeValue(value: unknown): EntityScope
{
    return readScopeOptional(value) ?? HOME_SCOPE;
}

// A placement's scope has no default: absent means "leave it where it renders".
function readScopeOptional(value: unknown): EntityScope | undefined
{
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readExposure(value: unknown): Exposure
{
    return readExposureOptional(value) ?? "index";
}

// A placement's exposure has no default: absent means "leave it", where a
// creation's absent exposure means index.
function readExposureOptional(value: unknown): Exposure | undefined
{
    return (EXPOSURES as readonly string[]).includes(String(value)) ? value as Exposure : undefined;
}

function str(value: unknown): string | undefined
{
    return value === undefined || value === null ? undefined : String(value);
}

function stringList(value: unknown): string[]
{
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
}
