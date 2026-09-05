// The entity fold of the company state engine (#197 §2, §5, §8). One record
// kind — text, free labels, typed links, reserved metadata, placement, and a
// shared lifecycle — is what every asserted statement folds to: the raw
// entities `self state` records, and the legacy record kinds read as entities
// without a stored event changing.
//
// This module owns the `entity.*` namespace: the event vocabulary, the fold
// that reads it, and the legacy interpretation. Domain layer — it imports the
// package's type and text leaves and its peer `objectives.ts` only, never the
// fold that calls it.

import { FoldError } from "./errors.js";
import { MilestoneState, ObjectiveState } from "./objectives.js";
import { countCharacters } from "./text.js";
import { SelfEvent } from "./types.js";

// Spelled once, for the verbs' refusals and the fold's own reading guards.
export const EXPOSURES = ["full", "index", "search"] as const;
// `standalone` and `assumes` join the three grouping types (#417 §2). Neither
// is a new event: both ride `entity.linked`/`entity.unlinked` like the rest,
// so a store written before this reads unchanged and a store written after it
// stays readable by the same two verbs.
export const LINK_TYPES = ["member-of", "supersedes", "relates", "standalone", "assumes"] as const;

export type Exposure = (typeof EXPOSURES)[number];
export type LinkType = (typeof LINK_TYPES)[number];
// `undone` is the record a mistake left behind (#390): its creation was
// annulled, so it never held, and it is neither a withdrawal nor a
// replacement. It leaves every live surface and stays resolvable by id, so a
// reader who followed the id out of a commit message is told it was a mistake
// rather than told the id is unknown.
type EntityStatus = "proposed" | "confirmed" | "superseded" | "retracted" | "undone";

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
    // The registered project that owns the target, written only when it is
    // another project (#244): a link inside one project stays byte-identical
    // to what it always was, and the fold that owns the target never has to be
    // read to know where the edge points. The edge's identity stays
    // (type, target) — the project is provenance, not a second key.
    project?: string;
    // Why the edge was stated, where the edge is a statement rather than a
    // grouping (#417 §2). A standalone declaration owes one: it says a unit
    // contributes to nothing on purpose, and a disposition with no reason is
    // indistinguishable from one nobody got round to recording. Provenance in
    // the same sense `project` is — the identity is still (type, target), so
    // restating an edge under a different reason is refused by the verb rather
    // than silently kept twice.
    why?: string;
    // When the edge was declared, stamped from the event that declared it. The
    // log already says who wrote it; this is what lets a render say since when
    // without reading the record's history back.
    declared?: string;
}

// The disposition a unit states when it contributes to nothing on purpose
// (#417 §1). The edge points at the record itself: an edge's identity in this
// fold is (type, target), and the record's own id is the one target that makes
// the edge a singleton by construction — there is no second one it could name,
// so a declaration and its withdrawal are the same edge and no reader has to
// key it. Minted here rather than spelled at each call site, because the verb
// that writes it and the projections that read it must agree exactly.
export function standaloneEdge(id: string, why?: string): EntityLink
{
    return why === undefined ? { type: "standalone", target: id } : { type: "standalone", target: id, why };
}

// The standalone edge a record carries, or nothing. Read by identity rather
// than by type alone, so an `assumes` edge and a hand-appended standalone edge
// naming some other record are both left where they are.
export function standaloneOf(record: { id: string; links: EntityLink[] }): EntityLink | undefined
{
    return record.links.find((link) => link.type === "standalone" && link.target === record.id);
}

// The decisions a record says it assumes, in the order the edges were stated
// (#417 §2). Additive: a checkpoint names as many as it depends on, and
// replacing one is linking the successor and unlinking the old one, never a
// silent rewrite of the set.
export function assumedDecisions(record: { links: EntityLink[] }): string[]
{
    return record.links.filter((link) => link.type === "assumes").map((link) => link.target);
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
    // The objective the judgment was made under (#417 §5), stamped by the one
    // coverage writer whenever the covered record is a checkpoint. Absent on
    // every claim written before this issue, and on a claim about a record
    // that hangs under no objective — which is why a reader treats absence as
    // "not recorded" rather than as "the current parent".
    objective?: string;
}

// One declared criterion, folded from its own ordered event stream (#408).
// Three states: open — declared, nothing since; blocked — the newest fact is a
// block; covered — a claim names it, and the claim ends any block, because the
// newest fact wins on this axis exactly as it does on the unit's own.
export interface CriterionState
{
    // c1..cN — its 1-based place in the declared list, computed here and never
    // written to the log. That is what lets an undo of a mid-list declaration
    // renumber the addressing without detaching a single claim.
    id: string;
    text: string;
    // How this criterion is checked. Recorded prose, never executed.
    verify?: string;
    // Whose task this criterion is (#413). `person` is the only value, and
    // absent means the session that records it — so an owner this CLI cannot
    // name is read as absent rather than carried, and no render ever calls a
    // criterion the reader's when the store said something else.
    owner?: "person";
    // The claim that covered it. Absent while open or blocked.
    covered?: CoverageClaim;
    // What it waits on, when the newest fact about it is a block.
    blocked?: { on: string; why?: string; ts: string };
}

export interface EntityState
{
    id: string;
    ts: string;
    text: string;
    labels: string[];
    links: EntityLink[];
    // Reserved metadata (#197 §2). The vocabulary is `target`, `criteria`,
    // `from` and `artifact`, and grows only by design decision: the verb
    // refuses anything else, and the fold ignores unknown keys a hand-appended
    // line might carry.
    target?: string;
    // Derived from `criterionStates` at the end of the fold and never
    // maintained beside it (#408): every shipped reader — `uncoveredCriteria`,
    // `resolveCriterion`, `state show`, the milestone exit projection, every
    // runbook stage reader — keeps reading this list, and the two cannot drift
    // because only one of them is ever written.
    criteria: string[];
    // The same list with each criterion's own state: its `cN` address, how it
    // is verified, the claim that covered it, and what it waits on.
    criterionStates: CriterionState[];
    // Which project this one came from, by slug (#75). A slug rather than a
    // record id, which is why it is reserved metadata and not an `EntityLink`,
    // and a machine-read value rather than a free label spelling, which is why
    // the verb can validate it. Decision `01kz96jysmppnk0npgz6gbr696` is the
    // design decision this key grows the vocabulary by.
    from?: string;
    // A registered artifact this record points at, by id (#238). One, never a
    // list: an entity holds the short statement and the artifact holds the
    // long document, and a list would make an entity an unbounded attachment
    // surface. Not an `EntityLink`, whose vocabulary is edges between records,
    // and not `target`, which is a deadline — a field that answered two
    // questions would make every reader ask which one it is holding.
    //
    // The id alone, never the artifact's name: what a retention cap charges
    // has to be the same number when the record is written and when it is
    // read, and an id is seven characters forever while a name is not.
    artifact?: string;
    // Whether the record may reach the repository's tracked instruction files
    // (#276). Absent means internal: the record lives in the store and the
    // managed block never carries it. Stated once, at birth — a placement
    // moves where a record renders and says nothing about whether it is
    // public, so promoting one is a new statement, not a move.
    visibility?: "public";
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
    // Whether the record was born as a proposal rather than asserted outright
    // (#356). Read where the current status cannot answer: an accepted
    // proposal and a record confirmed at birth are both `confirmed`, and only
    // the first is revisable. Absent on the legacy readings.
    bornProposed?: boolean;
    // The stated versions of a revisable record's text, and which of them an
    // acceptance bound (#356). Absent on every other record — nothing else
    // restates its text in place.
    plan?: PlanState;
    // The gap the newest revision that states one moved the plan to (#417 §4).
    // Absent while no revision has retargeted the plan, which is when the
    // creation payload's own gap is still the effective one.
    planTarget?: PlanTarget;
    // Set by the first `entity.started` and never cleared: a plan that has
    // been picked up is frozen, whatever the record's working state becomes
    // afterwards. `claim` answers who holds the unit, which is a different
    // question, so the freeze is not read off it.
    startedOnce?: boolean;
    // The coverage claims recorded against the declared criteria, in the
    // order they landed. done/reach is gated on every criterion carrying one.
    covered: CoverageClaim[];
    // Set on an entity an `entity.*` creation event minted, absent on the
    // legacy readings: the model projects native preset records back into the
    // legacy read shapes, and this is the mark it projects by.
    native?: boolean;
    supersededBy?: string;
    // When the creation was annulled, on an undone record alone (#390).
    undoneAt?: string;
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

// Which version of a record's plan is current, the id an acceptance of it
// names, and the newest version an acceptance has named. The current
// revision's id is the record's own id until the plan is first restated:
// every work confirm ever written names the record, so a log from before
// #356 already says which version it approved.
export interface PlanState
{
    current: number;
    event: string;
    accepted?: number;
}

// The gap a plan closes, as a revision states it (#417 §4). The pair is read
// and replaced whole: a revision that moves a plan onto a checkpoint states
// the checkpoint and no objective, so carrying the two fields separately
// would leave the objective the plan no longer names standing beside it.
export interface PlanTarget
{
    objective?: string;
    milestone?: string;
}

// The declared list in both shapes it is read in, minted together so no caller
// can state one without the other (#408 cell 74). `verify` and `owner` are the
// sparse maps a creation payload carries, keyed by the position they were
// declared at, and they are read off the creation payload here rather than by
// each caller; a key nothing is declared at simply never matches. The legacy
// projections pass their texts alone and get neither, which is correct — no
// pre-cutover record ever stated one.
function declaredCriteria(texts: string[], payload: Record<string, unknown> = {}): Pick<EntityState, "criteria" | "criterionStates">
{
    const verify = readKeyed(payload.verify, () => true);
    const owner = readKeyed(payload.owner, (value) => value === PERSON_OWNER);
    // Two criteria with one text are one criterion: the text is a criterion's
    // identity in the log — `entity.covered` and the whole criterion axis name
    // it that way — so a claim on the second could never be told from a claim
    // on the first. The verbs refuse minting one; a duplicate can still arrive
    // hand-appended or from a store written before that refusal, and it folds
    // to the one criterion it always meant rather than to a record gated
    // forever on a `cN` that resolves to the other. `verify` is read at the
    // position the payload declared, because that is what its author counted.
    const states = texts.flatMap((text, at) =>
        texts.indexOf(text) === at ? [criterionState(text, at, verify[`c${at + 1}`], owner[`c${at + 1}`])] : []);
    return { criteria: states.map((item) => item.text), criterionStates: renumbered(states) };
}

// `cN` is a position in the list a reader sees, so it is assigned after the
// duplicates have gone rather than from the payload's own indexes.
function renumbered(states: CriterionState[]): CriterionState[]
{
    return states.map((state, at) => ({ ...state, id: `c${at + 1}` }));
}

function criterionState(text: string, at: number, verify: string | undefined,
    owner: string | undefined): CriterionState
{
    return {
        id: `c${at + 1}`,
        text,
        ...(verify === undefined ? {} : { verify }),
        // Narrowed to the one value every reader of this field is written
        // against: the maps above already dropped anything else.
        ...(owner === PERSON_OWNER ? { owner: PERSON_OWNER } : {})
    };
}

export function isLive(entity: EntityState): boolean
{
    return entity.status === "proposed" || entity.status === "confirmed";
}

// Whether the plan a record currently states is one nobody has accepted — the
// state a person is being asked to answer. True both for a plan never
// accepted and for one revised past the acceptance that approved it (#356).
export function awaitsReview(entity: EntityState): boolean
{
    return isLive(entity) && entity.plan !== undefined && entity.plan.accepted !== entity.plan.current;
}

// A work record born as a proposal: the kind a person accepts, declines or
// revises, and the only kind whose text is restated in place (#356). A unit
// `work add` asserted is already approved, so it is corrected with a
// successor like every other confirmed record.
export function isWorkProposal(entity: EntityState): boolean
{
    return entity.native === true && entity.source === "work" && entity.bornProposed === true;
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

// How a record of one kind is corrected, with the id filled in. Read by the
// refusals that send a caller to the successor path, so the spelling they
// name cannot drift from the flag the add verb actually takes.
export function supersedeSpelling(kind: EntitySource | "entity", id: string): string
{
    return SUPERSEDE_SPELLING[kind].replace("<id>", id);
}

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
        throw new FoldError(`${entity.id} is ${article} ${found} record — replace it with ${SUPERSEDE_SPELLING[found]}`);
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

// One `entity.revised` line: a whole restated text, never a diff, the reason
// the plan changed, and — since #417 §4 — the gap the revision moves the plan
// to. Collected like every other transition, because the record it names can
// be created later in a union-merged log.
interface RevisionEvent
{
    event: string;
    ts: string;
    entity: string;
    text: string;
    why?: string;
    target?: PlanTarget;
}

const EXECUTION_EVENTS = ["entity.started", "entity.blocked", "entity.unblocked", "entity.done", "entity.retired"];

// The criterion axis (#408). Its own event types rather than `entity.blocked`
// with a `criterion` field, because the fold's answer is different: a 0.11.0
// CLI has no criterion branch in `collectExecution`, so it would read a
// criterion's block as the *unit's* — and, worse, read a criterion's unblock
// as clearing a unit-level block a person recorded. An unknown `entity.*` type
// costs nothing by comparison: `reconcileEntity` matches no collector and
// applies nothing, so the older CLI reads the criterion as open and its done
// gate is looser, never tighter.
// The only owner a criterion states (#413). Absent means the session that
// records it, and there is deliberately no second spelling of that default:
// two stores could then describe one criterion with different bytes. A name
// would be an identity this CLI does not hold — `by` records `person` or
// `agent` and never who — so a row saying it waits on somebody named would
// claim knowledge the store has none of.
export const PERSON_OWNER = "person";

export const CRITERION_DECLARED = "entity.criterion-declared";
export const CRITERION_BLOCKED = "entity.criterion-blocked";
export const CRITERION_UNBLOCKED = "entity.criterion-unblocked";

const CRITERION_EVENTS = [CRITERION_DECLARED, CRITERION_BLOCKED, CRITERION_UNBLOCKED];

// One line on the criterion axis. `criterion` is the criterion's text, never
// its `cN` — exactly as `entity.covered` already stores it, which is what lets
// an undo of a mid-list declaration renumber the addressing without detaching
// a single claim.
interface CriterionEvent
{
    event: string;
    ts: string;
    entity: string;
    type: string;
    criterion: string;
    verify?: string;
    owner?: string;
    on?: string;
    why?: string;
}

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
    // Every declaration, block and unblock on the criterion axis (#408),
    // collected like the rest so a union-merged log can order one above the
    // record it names.
    criteria: CriterionEvent[];
    // Every restatement of a record's text (#356). Accumulates rather than
    // settles: the newest one is the record's text, and the whole list is
    // what an acceptance binds a version number to.
    revisions: RevisionEvent[];
    // Every id an `entity.confirmed` named in `refs.confirms`. A placement
    // proposal applies only when its event id is in here, and collecting the
    // ids first is what lets a union merge order the confirm above the
    // proposal it answers.
    confirmations: Set<string>;
    // Every event an annulment took back, by id. An undo names the event it
    // reverses rather than asserting a new state, so the fold skips what was
    // annulled and every rule below keeps its shape: first-withdrawal-wins
    // still holds among the withdrawals that stand. Binding to an id rather
    // than to log order is also what keeps a merged log safe — two clones fold
    // the same lines to the same state whatever order the merge produced.
    annulled: Set<string>;
    // The annulments that take back only what a creation displaced, not the
    // record itself (#390 §1.4). `self undo --supersession` is the spelling,
    // and every older log's `entity.restored` is read as one: that type only
    // ever narrowed a creation this way, so a log written before #390 folds
    // byte-identically.
    narrowed: Set<string>;
    // When each annulment was recorded, by the id it took back. The undone
    // record's page states it: a reader who followed the id out of a commit
    // message is told when it stopped holding, not only that it did.
    annulledAt: Map<string, string>;
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
        criteria: [],
        revisions: [],
        confirmations: new Set(),
        annulled: new Set(),
        narrowed: new Set(),
        annulledAt: new Map()
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
        const annuls = event.refs?.annuls;
        if (typeof annuls !== "string" || annuls === "")
        {
            continue;
        }
        fold.annulled.add(annuls);
        fold.annulledAt.set(annuls, event.ts);
        // An older log's `entity.restored` is read as the narrow form for the
        // reason the type name states: it took a *restoration* back, and the
        // only creation it ever reached was one that had displaced something.
        if (event.type === "entity.restored" || event.payload.scope === "supersession")
        {
            fold.narrowed.add(annuls);
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

// A narrowly annulled creation keeps its record and loses only what it
// displaced: that accident is a supersedes link that should never have been
// attached, not the record it was attached to. A record annulled outright
// drops the links for the same reason it leaves the live set — a mistake
// displaced nothing.
function createdLinks(fold: EntityFold, event: SelfEvent): EntityLink[]
{
    const links = readLinks(event.payload.links).map((link) => ({ ...link, declared: event.ts }));
    return fold.annulled.has(event.id) ? links.filter((link) => link.type !== "supersedes") : links;
}

// Whether this creation's record itself was taken back (#390). The narrow
// form is the older behaviour and says nothing about the record; the default
// says the record was a mistake and never held.
function undoneCreation(fold: EntityFold, event: SelfEvent): boolean
{
    return fold.annulled.has(event.id) && !fold.narrowed.has(event.id);
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
        ...declaredCriteria(stringList(event.payload.criteria), event.payload),
        from: str(event.payload.from),
        artifact: str(event.payload.artifact),
        visibility: readVisibility(event.payload.visibility),
        why: str(event.payload.why),
        scope: readScopeValue(event.payload.scope),
        priority: readPriority(event.payload.priority),
        exposure: readExposure(event.payload.exposure),
        status: undoneCreation(fold, event) ? "undone" : confirmed ? "confirmed" : "proposed",
        undoneAt: fold.annulledAt.get(event.id),
        humanConfirmed: event.origin.confirmed === true,
        confirmedOnce: confirmed,
        bornProposed: !confirmed,
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
        ...declaredCriteria([]),
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
    [(event) => CRITERION_EVENTS.includes(event.type), collectCriterion],
    [(event) => event.type === "entity.revised", collectRevision],
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
    // An annulled acceptance is dropped here rather than at each of the three
    // places a confirm is read (#390): the status pass, the plan pass and the
    // placement parking all ask this list, and filtering in one of them was
    // what let an annulled placement confirm keep applying its placement.
    if (confirms === "" || fold.annulled.has(event.id) || fold.confirms.some((item) => item.event === event.id))
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
            commits: stringList(event.refs?.commits),
            objective: str(event.payload.objective)
        }
    });
}

// A criterion event names the criterion by its text, so an empty or
// non-string one says nothing this fold can attach: it is ignored, and the
// record declares what it declared. The event-id guard is what makes a
// declaration a merge carried in twice fold to one criterion.
function collectCriterion(fold: EntityFold, event: SelfEvent): void
{
    const entity = String(event.payload.entity ?? "");
    const criterion = typeof event.payload.criterion === "string" ? event.payload.criterion : "";
    if (entity === "" || criterion === "" || fold.criteria.some((item) => item.event === event.id))
    {
        return;
    }
    fold.criteria.push({
        event: event.id,
        ts: event.ts,
        entity,
        type: event.type,
        criterion,
        verify: str(event.payload.verify),
        // Bare here, because this event declares exactly one criterion and has
        // nothing to key by — and read to the one value for the same reason
        // the keyed map is (#413).
        owner: event.payload.owner === PERSON_OWNER ? PERSON_OWNER : undefined,
        on: str(event.payload.on),
        why: str(event.payload.why)
    });
}

// A revision restates the whole text (#356). Collected like the rest — the
// record it names can be legacy-derived or arrive later in a merged log — and
// the event-id guard is what lets the reconcile pass route the same line
// twice without counting it twice.
function collectRevision(fold: EntityFold, event: SelfEvent): void
{
    const entity = String(event.payload.entity ?? "");
    const text = String(event.payload.text ?? "");
    if (entity === "" || text === "" || fold.revisions.some((item) => item.event === event.id))
    {
        return;
    }
    fold.revisions.push({
        event: event.id, ts: event.ts, entity, text,
        why: str(event.payload.why),
        target: statedTarget(event.payload)
    });
}

// The gap a revision states, or nothing. A line naming neither reads as a
// plain restatement, and one whose id is not a string reads the same way: a
// retarget nobody can resolve must not empty the gap the plan already names.
function statedTarget(payload: Record<string, unknown>): PlanTarget | undefined
{
    const objective = str(payload.objective);
    const milestone = str(payload.milestone);
    if (objective === undefined && milestone === undefined)
    {
        return undefined;
    }
    return { objective, milestone };
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
    status: "proposed" | "confirmed" | "superseded" | "retracted" | "declined" | "undone";
    humanConfirmed: boolean;
    supersedes: string[];
    closedWhy?: string;
}

interface ConventionSource
{
    id: string;
    ts: string;
    text: string;
    status: "current" | "superseded" | "dropped" | "undone";
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
    const revisions = statedRevisions(fold);
    linkLineage(entities, legacy);
    applyConfirms(entities, fold, revisions);
    applyRetractions(entities, fold);
    applyLinks(entities, fold);
    applySupersessions(entities, fold);
    // Last of the lifecycle passes: a plan's review state is read off the
    // settled status, so a withdrawn or superseded record is past reviewing.
    applyPlans(entities, fold, revisions);
    applyPlacements(entities, fold);
    // Before the coverage pass, which reads `criteria`: a claim may name a
    // criterion a later declaration added, and it folds to nothing unless the
    // list already holds it.
    applyDeclarations(entities, fold);
    applyCoverage(entities, fold);
    settleCriteria(entities, fold);
    applyExecutions(entities, fold);
    return entities;
}

// Ordered as placements are — timestamp, event id — so two clones of one
// store settle one lifecycle. A confirm answers only a proposal; the first
// retraction is the one that happened, and it is applied before supersession
// so a withdrawal that already happened wins however the merged log ordered
// the two.
function applyConfirms(entities: EntityState[], fold: EntityFold, revisions: Map<string, RevisionEvent[]>): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    // A confirm names the exact revision it approves (#356), so an acceptance
    // of v2 onwards carries a revision event id. Existing confirms name the
    // record and resolve on the first term exactly as they always did.
    const owner = revisionOwners(revisions);
    for (const confirm of ordered(fold.confirms))
    {
        const target = byId.get(confirm.confirms) ?? byId.get(owner.get(confirm.confirms) ?? "");
        if (target !== undefined && target.status === "proposed")
        {
            target.status = "confirmed";
            target.confirmedOnce = true;
            target.humanConfirmed = confirm.humanConfirmed;
            target.ts = confirm.ts;
        }
    }
}

// Every record's restatements, oldest first. The creation is not among them:
// it is always v1 whatever its timestamp says — a revision pulled from a
// clock-skewed clone can carry an earlier one — so only the restatements are
// ordered, by `(ts, event id)` like every other collected event. An annulled
// revision is dropped here, which is what makes `undo` of one give back the
// version before it with no rule of its own.
function statedRevisions(fold: EntityFold): Map<string, RevisionEvent[]>
{
    const grouped = new Map<string, RevisionEvent[]>();
    for (const item of ordered(fold.revisions))
    {
        if (!fold.annulled.has(item.event))
        {
            grouped.set(item.entity, [...grouped.get(item.entity) ?? [], item]);
        }
    }
    return grouped;
}

function revisionOwners(revisions: Map<string, RevisionEvent[]>): Map<string, string>
{
    const owner = new Map<string, string>();
    for (const [entity, stated] of revisions)
    {
        for (const item of stated)
        {
            owner.set(item.event, entity);
        }
    }
    return owner;
}

// What a revisable record's plan currently says, and whether anyone accepted
// it. The newest revision is the record's text; a record whose current
// revision no confirm names goes back to proposed, because nobody approved
// the text that is current now. `confirmedOnce` deliberately stays: it is the
// flag supersession reads, and flipping it back would resurrect a record this
// work had already replaced.
function applyPlans(entities: EntityState[], fold: EntityFold, revisions: Map<string, RevisionEvent[]>): void
{
    const accepted = acceptedRevisions(fold);
    for (const entity of entities.filter((item) => isWorkProposal(item) && isLive(item)))
    {
        const stated = revisions.get(entity.id) ?? [];
        if (stated.length > 0)
        {
            entity.text = stated[stated.length - 1].text;
        }
        entity.plan = planOf(entity.id, stated, accepted);
        entity.planTarget = [...stated].reverse().find((item) => item.target !== undefined)?.target;
        if (entity.plan.accepted !== entity.plan.current && entity.status === "confirmed")
        {
            entity.status = "proposed";
            entity.humanConfirmed = false;
        }
    }
}

// Accepted iff some confirm names the current revision — not "the newest
// confirm names the newest revision": a lagging clone accepting v1 after v2
// was accepted must not send v2 back to review.
function planOf(id: string, stated: RevisionEvent[], accepted: Set<string>): PlanState
{
    const ids = [id, ...stated.map((item) => item.event)];
    const bound = ids.reduce<number | undefined>((last, event, index) => accepted.has(event) ? index + 1 : last, undefined);
    return { current: ids.length, event: ids[ids.length - 1], accepted: bound };
}

function acceptedRevisions(fold: EntityFold): Set<string>
{
    return new Set(fold.confirms.filter((item) => !fold.annulled.has(item.event)).map((item) => item.confirms));
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
        // An undo names the link event it takes back (#244 D5), the same way
        // it names a withdrawal: skipping it here is what removes the edge
        // from every surface at once.
        const target = fold.annulled.has(item.event) ? undefined : byId.get(item.entity);
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
            target.links.push({ ...item.link, declared: item.ts });
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
        // A claim taken back is a claim that was never made: the criterion
        // gates done and reach again, everywhere the claim list is read.
        const target = fold.annulled.has(item.event) ? undefined : byId.get(item.entity);
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

/* ── the criterion axis (#408) ─────────────────────────────────────── */

// Criteria declared after the record was created, appended in `(ts, event id)`
// order so two clones of one store address the same criterion as the same
// `cN`. Appended, never inserted: a declaration states one more condition, and
// a text the record already declares is the same criterion said twice.
// `criteria` is re-derived from the states at the end, so the list every
// shipped reader uses can never drift from the one this axis maintains.
function applyDeclarations(entities: EntityState[], fold: EntityFold): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    for (const item of ordered(fold.criteria.filter((event) => event.type === CRITERION_DECLARED)))
    {
        const target = fold.annulled.has(item.event) ? undefined : byId.get(item.entity);
        if (target !== undefined && !target.criterionStates.some((state) => state.text === item.criterion))
        {
            target.criterionStates.push(criterionState(item.criterion, target.criterionStates.length,
                item.verify, item.owner));
        }
    }
    for (const entity of entities)
    {
        entity.criteria = entity.criterionStates.map((state) => state.text);
    }
}

// What each criterion waits on and what covered it, replayed as one ordered
// stream: a coverage claim and a block are facts on the same axis, so covering
// a blocked criterion ends the block by being the newer fact rather than by an
// implicit second write — and taking the claim back gives the block straight
// back with it.
function settleCriteria(entities: EntityState[], fold: EntityFold): void
{
    const byId = new Map(entities.map((item) => [item.id, item]));
    for (const fact of ordered([...criterionFacts(fold), ...coverageFacts(fold)]))
    {
        // A fact naming a criterion the record never declared folds to nothing,
        // the same rule coverage claims already follow: a hand-appended line
        // cannot mint a criterion.
        const state = byId.get(fact.entity)?.criterionStates.find((item) => item.text === fact.criterion);
        if (state !== undefined)
        {
            settleCriterion(state, fact);
        }
    }
}

// One fact on one criterion, applied where the verbs could have reached it.
// The fold refuses no history: a line the verb matrix would have refused — a
// block on a covered criterion, an unblock on one that waits on nothing — is
// dropped rather than applied, exactly as `nextExecution` drops one.
function settleCriterion(state: CriterionState, fact: CriterionFact): void
{
    if (fact.claim !== undefined)
    {
        state.covered = fact.claim;
        state.blocked = undefined;
        return;
    }
    if (fact.blocked !== undefined)
    {
        state.blocked = state.covered === undefined && state.blocked === undefined ? fact.blocked : state.blocked;
        return;
    }
    state.blocked = undefined;
}

// One fact about one criterion: a claim that covered it, a block it waits on,
// or neither — the release of a block.
interface CriterionFact
{
    event: string;
    ts: string;
    entity: string;
    criterion: string;
    claim?: CoverageClaim;
    blocked?: { on: string; why?: string; ts: string };
}

function criterionFacts(fold: EntityFold): CriterionFact[]
{
    return fold.criteria
        .filter((item) => item.type !== CRITERION_DECLARED && !fold.annulled.has(item.event))
        .map((item) => ({
            ...item,
            // An `--on` a hand-append left off still names a wait; the verb's
            // own enum is what keeps a recorded one to the three words.
            ...(item.type === CRITERION_BLOCKED
                ? { blocked: { on: item.on ?? "external", why: item.why, ts: item.ts } }
                : {})
        }));
}

function coverageFacts(fold: EntityFold): CriterionFact[]
{
    return fold.coverage.filter((item) => !fold.annulled.has(item.event))
        .map((item) => ({ ...item, criterion: item.claim.criterion, claim: item.claim }));
}

// What a record's declared criteria have come to. Composed once, so `work
// show`, `self work`, `self context` and #406's milestone row cannot disagree
// about the same unit. Undefined where nothing was declared: a record that
// declares no criteria says nothing about them anywhere.
interface CriteriaProgress
{
    covered: number;
    total: number;
    // Each blocked criterion as `c3 blocked on decision`, in cN order — what
    // the listings name, so a reader deciding what to pick up is owed the
    // `--on` the block was recorded with.
    waiting: string[];
}

export function criteriaProgress(states: CriterionState[]): CriteriaProgress | undefined
{
    if (states.length === 0)
    {
        return undefined;
    }
    return {
        covered: states.filter((item) => item.covered !== undefined).length,
        total: states.length,
        waiting: states.filter((item) => item.blocked !== undefined)
            .map((item) => `${item.id} blocked on ${item.blocked?.on}`)
    };
}

// The sentence a listing row carries: how far the unit is, and what is
// standing still. One spelling for `self work`, `self context` and #406's
// milestone row, so no two of them describe the same unit differently.
// Undefined where nothing was declared, for `criteriaProgress`'s reason.
//
// It takes the states rather than the progress it counts from them (#413):
// what stands still is now two facts about one criterion — what it waits on,
// and whose task it is — and composing them here is what keeps them one entry.
export function criteriaNote(states: CriterionState[]): string | undefined
{
    const progress = criteriaProgress(states);
    return progress === undefined
        ? undefined
        : [`${progress.covered} of ${progress.total} criteria covered`, ...stalledMarks(states)].join(" · ");
}

// One entry per criterion that is not moving on its own, in cN order: what a
// blocked one waits on, and `(person)` where the task is the reader's rather
// than the session's. One entry rather than two lists, because a criterion
// standing still is one thing to say — a reader shown `c3 blocked on decision`
// and `c3 (person)` would look for two criteria.
function stalledMarks(states: CriterionState[]): string[]
{
    return states.flatMap((item) =>
    {
        if (item.blocked !== undefined)
        {
            return [`${item.id} blocked on ${item.blocked.on}${ownerMark(item)}`];
        }
        return personOwned(item) ? [`${item.id}${ownerMark(item)}`] : [];
    });
}

// The mark every criteria render carries where the task is a person's own
// rather than the session's (#413). Spelled once, so the unit's page, the
// listing note and the done refusal cannot come to name it three ways.
//
// Carried on a covered criterion too: it says what the unit *declared*, so a
// render that dropped it on the claim would disagree with the log about what
// was declared — and there it is what tells a reader the claim records
// somebody else's word.
export function ownerMark(criterion: CriterionState): string
{
    return criterion.owner === undefined ? "" : ` (${criterion.owner})`;
}

// A criterion a person owes and has not covered yet (#413) — what `self
// context` puts under Waiting on you and what the listings mark. Covered ends
// it, exactly as it ends a block: a judged criterion waits on nobody.
export function personOwned(criterion: CriterionState): boolean
{
    return criterion.owner === PERSON_OWNER && criterion.covered === undefined;
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

/* ── the supersedes chain a labelled record belongs to ─────────────── */

// Which records a chain walk may step through. Every kind that versions itself
// by supersession — a runbook edition (#171), a skill (#391) — walks the same
// links over its own label, so the predicate is the only difference between
// them and the walk is written once.
type KindPredicate = (entity: EntityState) => boolean;

// The whole chain an id belongs to, oldest first. Walked back along the
// supersedes links to the root and then forward along the `supersededBy` the
// fold filled in, so either end of a chain answers with the same list — the
// root's id is the stable id of the thing, whatever version is current.
export function supersedesChain(entities: EntityState[], id: string, isKind: KindPredicate): EntityState[]
{
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    const start = byId.get(id);
    if (start === undefined || !isKind(start))
    {
        return [];
    }
    return chainForward(byId, chainRoot(byId, start, isKind), isKind);
}

function chainRoot(byId: Map<string, EntityState>, start: EntityState, isKind: KindPredicate): EntityState
{
    const seen = new Set([start.id]);
    let at = start;
    let back = chainPredecessor(byId, at, isKind);
    while (back !== undefined && !seen.has(back.id))
    {
        seen.add(back.id);
        at = back;
        back = chainPredecessor(byId, at, isKind);
    }
    return at;
}

function chainForward(byId: Map<string, EntityState>, root: EntityState, isKind: KindPredicate): EntityState[]
{
    const chain = [root];
    let at = root;
    while (at.supersededBy !== undefined)
    {
        const next = byId.get(at.supersededBy);
        if (next === undefined || !isKind(next) || chain.some((item) => item.id === next.id))
        {
            break;
        }
        chain.push(next);
        at = next;
    }
    return chain;
}

// A proposed version carries the supersedes link but has displaced nothing
// yet, so it is reachable backward and not forward: an unconfirmed replacement
// leaves the chain exactly as it was until a person confirms it.
function chainPredecessor(byId: Map<string, EntityState>, entity: EntityState, isKind: KindPredicate): EntityState | undefined
{
    for (const link of entity.links)
    {
        const target = link.type === "supersedes" ? byId.get(link.target) : undefined;
        if (target !== undefined && isKind(target))
        {
            return target;
        }
    }
    return undefined;
}

// Which version this one is, counted from the root — v1, v2, v3. Zero for an
// id the chain does not hold, which no caller reaches: every caller resolved
// the id out of the chain it is asking about.
export function chainVersion(chain: EntityState[], id: string): number
{
    return chain.findIndex((item) => item.id === id) + 1;
}

// The version that holds now: the last confirmed one in the chain. A proposal
// waiting on a person is not it, which is why the head is read by status
// rather than by position.
export function chainHead(chain: EntityState[]): EntityState | undefined
{
    return [...chain].reverse().find((item) => item.status === "confirmed" && isLive(item));
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
        target.startedOnce = true;
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
        const target = fold.annulled.has(placement.event) ? undefined : byId.get(placement.entity);
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

// Priority order, then scope, then recency (#197 §6, #287). An absent priority
// sorts after every stated one. At equal priority a record the whole workspace
// holds sorts above one project's own, so the company's direction and rules
// read before the project's in every context. The id breaks the remaining tie
// so two clones of one store render one order. `state list` and the context
// projection both sort through here — a second comparator would let the two
// surfaces disagree.
export function orderEntities(entities: EntityState[]): EntityState[]
{
    return [...entities].sort((left, right) =>
        (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER)
        || scopeRank(left) - scopeRank(right)
        || right.ts.localeCompare(left.ts)
        || left.id.localeCompare(right.id));
}

// The scope value answers on its own, with no home slug to resolve against:
// the sentinel `project` never reads as workspace-wide, and no project can be
// named "workspace" — the slug is reserved precisely so `--scope workspace`
// cannot mean two things.
function scopeRank(entity: EntityState): number
{
    return entity.scope === "workspace" ? 0 : 1;
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
        .reduce((sum, item) => sum + entityCharacters(item), 0);
}

/* ── what a record costs a retention tier (#238) ───────────────────── */

// The fixed wording an artifact reference renders as, wrapped around the id.
// A reference costs a record the pointer and never the document: the cap
// answers "how much can context hold", and an artifact's bytes are not in the
// render — a session opens one deliberately, when the record it hangs off
// applies.
const POINTER_BEFORE = " — see `self artifact open ";
const POINTER_AFTER = "`";

// What a record's reference renders as, or nothing when it has none. Every
// surface that shows a record reads this, and so does the cost below, so the
// number a cap charges is the length of the string a reader actually sees.
export function artifactPointer(artifact: string | undefined): string
{
    return artifact === undefined ? "" : `${POINTER_BEFORE}${artifact}${POINTER_AFTER}`;
}

// What a record costs the tier it sits in, taken as a shape rather than as an
// `EntityState`: three of the ten sites that count this are weighing a record
// that does not exist yet, so there is no folded entity to hand over. An
// `EntityState` satisfies it structurally, so the other seven pass the record
// itself.
interface CostedEntity
{
    text: string;
    artifact?: string;
}

// The one window every cap sum goes through. Two answers to what a record
// costs would let a write pass a check the confirm then fails, or the reverse.
export function entityCharacters(costed: CostedEntity): number
{
    return countCharacters(costed.text) + countCharacters(artifactPointer(costed.artifact));
}

// The reference a payload carries, read back where the cost has to be counted
// before the record exists. The three add-time sites all have the composed
// payload in hand already, so none of them needs a wider signature.
export function payloadArtifact(payload: Record<string, unknown>): string | undefined
{
    return typeof payload.artifact === "string" && payload.artifact !== "" ? payload.artifact : undefined;
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
        ...declaredCriteria([]),
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
        ...declaredCriteria([]),
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
        ...declaredCriteria([]),
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
        ...declaredCriteria(milestone.exit.filter((item) => item.dropped !== true).map((item) => item.text)),
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
        const project = (item as { project?: unknown })?.project;
        const why = (item as { why?: unknown })?.why;
        return (LINK_TYPES as readonly string[]).includes(String(type)) && typeof target === "string" && target !== ""
            ? [{
                type: type as LinkType,
                target,
                ...(typeof project === "string" && project !== "" ? { project } : {}),
                ...(typeof why === "string" && why !== "" ? { why } : {})
            }]
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

// The leak-facing default is "no": exactly `"public"` opens the record to the
// tracked instruction files, and anything else — absent, a casing a
// hand-append left, a value from a newer writer — reads as internal.
function readVisibility(value: unknown): "public" | undefined
{
    return value === "public" ? "public" : undefined;
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

// One of the sparse maps a creation payload carries beside its criteria —
// `verify` (#408) and `owner` (#413) — keyed by the position it was declared
// at. Sparse and keyed rather than a parallel array, because most criteria
// carry neither and an array of holes is a shape every reader has to defend
// against. One reader for both, so a payload shape that defeats one cannot
// slip past the other, with `admits` for the flag whose values are an enum
// rather than prose.
//
// Read defensively like everything else from the log: a string, an array, a
// key naming a position nothing was declared at, or a value the flag does not
// admit reads as absent for whatever it cannot key — the criteria stand.
function readKeyed(value: unknown, admits: (text: string) => boolean): Record<string, string>
{
    if (typeof value !== "object" || value === null || Array.isArray(value))
    {
        return {};
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .flatMap(([key, text]) => /^c[1-9]\d*$/.test(key) && typeof text === "string" && text !== "" && admits(text)
            ? [[key, text] as [string, string]] : []));
}
