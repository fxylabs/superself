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
import { SelfEvent } from "./types.js";

// Spelled once, for the verbs' refusals and the fold's own reading guards.
export const EXPOSURES = ["full", "index", "search"] as const;
export const LINK_TYPES = ["member-of", "supersedes", "relates"] as const;

export type Exposure = (typeof EXPOSURES)[number];
export type LinkType = (typeof LINK_TYPES)[number];
export type EntityStatus = "proposed" | "confirmed" | "superseded" | "retracted";
export type EntityScope = "project" | "workspace";

export interface EntityLink
{
    type: LinkType;
    target: string;
}

// Which preset record kind a legacy-derived entity is the reading of. Absent
// for an entity `self state add` recorded; the verbs refuse lifecycle
// transitions on a sourced one and point at the verb that owns its record.
export type EntitySource = "goal" | "decision" | "convention" | "objective" | "milestone";

export interface EntityState
{
    id: string;
    ts: string;
    text: string;
    labels: string[];
    links: EntityLink[];
    // Reserved metadata (#197 §2). The vocabulary is `target` and `criteria`
    // and grows only by design decision: the verb refuses anything else, and
    // the fold ignores unknown keys a hand-appended line might carry.
    target?: string;
    criteria: string[];
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
    supersededBy?: string;
    // Why the record was retracted, or what closed the legacy record it
    // reads. Absent on a supersession, which says why by naming its successor.
    closedWhy?: string;
    source?: EntitySource;
}

export function isLive(entity: EntityState): boolean
{
    return entity.status === "proposed" || entity.status === "confirmed";
}

export interface EntityFold
{
    entities: EntityState[];
    // Supersessions asserted by standalone `entity.superseded` events, applied
    // once every entity exists: a union-merged log orders lines by neither
    // time nor dependency, so a claim can precede either record it names.
    claims: { predecessor: string; successor: string }[];
}

export function emptyEntityFold(): EntityFold
{
    return { entities: [], claims: [] };
}

/* ── the single-pass fold ──────────────────────────────────────────── */

// Creation events, the goal chain, and the supersession claims fold here, in
// the same pass the rest of the model reads. The linking transitions run
// through `reconcileEntity`, from this pass and the reconcile pass alike.
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
function isEntityCreation(event: SelfEvent): boolean
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
    const confirmed = event.type === "entity.confirmed";
    fold.entities.push({
        id,
        ts: event.ts,
        text: String(event.payload.text ?? ""),
        labels: stringList(event.payload.labels),
        links: readLinks(event.payload.links),
        target: str(event.payload.target),
        criteria: stringList(event.payload.criteria),
        why: str(event.payload.why),
        scope: event.payload.scope === "workspace" ? "workspace" : "project",
        priority: readPriority(event.payload.priority),
        exposure: readExposure(event.payload.exposure),
        status: confirmed ? "confirmed" : "proposed",
        humanConfirmed: event.origin.confirmed === true,
        confirmedOnce: confirmed
    });
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

// The transitions that speak about a record another event created. Each is a
// no-op against a record already where the transition would put it, so the
// reconcile pass in `model.ts` can run them a second time: a merged log can
// put a retraction above the entity it withdraws.
export function reconcileEntity(fold: EntityFold, event: SelfEvent): void
{
    if (event.type === "entity.confirmed" && event.refs?.confirms !== undefined)
    {
        confirmEntity(fold, event);
        return;
    }
    if (event.type === "entity.retracted")
    {
        retractEntity(fold, event);
        return;
    }
    if (event.type === "entity.placed")
    {
        placeEntity(fold, event);
        return;
    }
    if (event.type === "entity.linked" || event.type === "entity.unlinked")
    {
        relinkEntity(fold, event);
    }
}

function confirmEntity(fold: EntityFold, event: SelfEvent): void
{
    const target = fold.entities.find((item) => item.id === event.refs?.confirms);
    if (target !== undefined && target.status === "proposed")
    {
        target.status = "confirmed";
        target.confirmedOnce = true;
        target.humanConfirmed = event.origin.confirmed === true;
        target.ts = event.ts;
    }
}

// Withdrawal is terminal and keeps the record: text, links and lineage stay
// resolvable, the status alone leaves the current set. The first withdrawal
// is the one that happened; a later event naming the record changes nothing.
function retractEntity(fold: EntityFold, event: SelfEvent): void
{
    const target = fold.entities.find((item) => item.id === event.payload.entity);
    if (target !== undefined && isLive(target))
    {
        target.status = "retracted";
        target.closedWhy = str(event.payload.why);
    }
}

// Placement moves by event (#197 §3). No verb writes this yet — the placement
// surface arrives with the context-renderer phase — but the family is one
// grammar, and a fold that ignored the event would strand the phase that
// starts writing it.
function placeEntity(fold: EntityFold, event: SelfEvent): void
{
    const target = fold.entities.find((item) => item.id === event.payload.entity);
    if (target === undefined || !isLive(target))
    {
        return;
    }
    const priority = readPriority(event.payload.priority);
    if (priority !== undefined)
    {
        target.priority = priority;
    }
    if ((EXPOSURES as readonly string[]).includes(String(event.payload.exposure)))
    {
        target.exposure = event.payload.exposure as Exposure;
    }
    if (event.payload.scope === "project" || event.payload.scope === "workspace")
    {
        target.scope = event.payload.scope;
    }
}

// A link is one edge in a set: adding it twice keeps one, removing it twice
// removes one — which is what lets the reconcile pass repeat either safely.
function relinkEntity(fold: EntityFold, event: SelfEvent): void
{
    const target = fold.entities.find((item) => item.id === event.payload.entity);
    const links = readLinks([event.payload.link]);
    if (target === undefined || links.length === 0)
    {
        return;
    }
    const link = links[0];
    if (event.type === "entity.unlinked")
    {
        target.links = target.links.filter((item) => item.type !== link.type || item.target !== link.target);
        return;
    }
    if (!target.links.some((item) => item.type === link.type && item.target === link.target))
    {
        target.links.push(link);
    }
}

/* ── the legacy interpretation (#197 §8) ───────────────────────────── */

// What the legacy readings need from the folded records. Declared
// structurally here rather than imported from `model.ts` — a domain module
// never imports the fold that calls it — and the fold's own record shapes
// satisfy these by construction.
export interface DecisionSource
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

export interface ConventionSource
{
    id: string;
    ts: string;
    text: string;
    status: "current" | "superseded" | "dropped";
    supersedes: string[];
    closedWhy?: string;
}

export interface LegacySources
{
    decisions: DecisionSource[];
    conventions: ConventionSource[];
    objectives: ObjectiveState[];
}

// The whole entity view: native records first, then the legacy readings, then
// supersession — applied once, over the complete set, because a successor can
// name a record from either half and a merged log can order a standalone
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
    applySupersessions(entities, fold);
    return entities;
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

function readExposure(value: unknown): Exposure
{
    return (EXPOSURES as readonly string[]).includes(String(value)) ? value as Exposure : "index";
}

function str(value: unknown): string | undefined
{
    return value === undefined || value === null ? undefined : String(value);
}

function stringList(value: unknown): string[]
{
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
}
