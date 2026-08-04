import {
    applyCompletion,
    applyWorkReview,
    approvalPending,
    completionRefusal,
    CompletionState,
    deriveCompletion,
    emptyCompletion,
    isCompletionEvent
} from "./completion.js";
import { DEFAULT_ZONE } from "./dates.js";
import { applyEntity, collectAnnulled, deriveEntities, emptyEntityFold, EntityFold, EntityState, isLive, reconcileEntity } from "./entities.js";
import { looksLikeLegacyRevision } from "./gitutil.js";
import { readEvents } from "./logfile.js";
import {
    applyMilestone,
    applyObjective,
    applyProposal,
    applySupersededObjectives,
    Coverage,
    deriveGoals,
    emptyGoals,
    findMilestone,
    GoalState,
    MilestoneState,
    ObjectiveState
} from "./objectives.js";
import { readRegistry, readStoreConfig, readVerdicts, Verdict } from "./paths.js";
import { ArtifactMeta, SelfEvent } from "./types.js";

const PROPOSAL_EXPIRY_DAYS = 14;
const STALL_DAYS = 3;

// Work proposals carry no `work` id of their own, so they are routed before
// the transition verbs that look one up.
const PROPOSAL_EVENTS = ["work.proposed", "work.accepted", "work.declined"];

export interface DecisionState
{
    id: string;
    text: string;
    why?: string;
    ts: string;
    // The lifecycle every statement-type record shares: a live record
    // (`proposed`/`confirmed`), one replaced by a linked successor
    // (`superseded`), one withdrawn with no successor (`retracted`), and a
    // proposal turned down (`declined`). Only the live ones render as current.
    status: "proposed" | "confirmed" | "superseded" | "retracted" | "declined";
    humanConfirmed: boolean;
    expired: boolean;
    supersedes: string[];
    // Why the record was retracted or declined. Absent on every other status:
    // a supersession says why by naming its successor.
    closedWhy?: string;
    // The work unit this decision came out of, when the command said so.
    // Never inferred: a decision recorded during one unit's session is not
    // thereby a decision about it.
    work?: string;
    // The work units this decision gates, as `decide --blocks` stated them.
    // Empty for every decision recorded before the ref existed, which is what
    // keeps such a decision unclassified rather than falsely settled.
    blocks: string[];
    // The event this decision is sequenced behind.
    after?: string;
}

// A convention carries the same lifecycle a decision does. `current` is the
// live status; `superseded` means a later convention was recorded as its
// replacement, and `dropped` means it was withdrawn with nothing taking its
// place — the withdraw verb this type has always had.
export interface ConventionState
{
    id: string;
    ts: string;
    text: string;
    status: "current" | "superseded" | "dropped";
    supersedes: string[];
    // Why the rule was dropped. Absent on a supersession, which says why by
    // naming the rule that replaced it.
    closedWhy?: string;
}

// The rules that hold now. One site answers it, so no two renderers can
// disagree about whether a superseded convention still counts.
export function currentConventions(conventions: ConventionState[]): ConventionState[]
{
    return conventions.filter((convention) => convention.status === "current");
}

export interface ReportEntry
{
    id: string;
    ts: string;
    text: string;
    commits: string[];
    // Evidence the report offered that is not a Git revision: a checksum, a
    // validation summary, a reviewer's name. Kept and shown, never resolved.
    notes: string[];
    artifacts: ArtifactMeta[];
    // The branch these commits were reported from — what lets the fold tell a
    // discarded branch from a squash-merged one.
    branch?: string;
}

// What a runner attempt left in the synced log: the state it reached, why it
// stopped, and the hashes of what it published. The raw output that produced
// them stays in the machine-local spool and never folds into project state.
export interface AttemptSummary
{
    id: string;
    state: "started" | "completed" | "failed" | "blocked" | "cancelled";
    ts: string;
    failure?: string;
    detail?: string;
    // The model the generation this attempt was admitted under pinned. Absent
    // for an attempt no work spec dispatched, which is what makes such an
    // attempt unable to satisfy a completion policy that names a model class.
    model?: string;
    artifacts: { name: string; sha256: string; bytes: number }[];
}

export interface WorkState
{
    id: string;
    outcome: string;
    ts: string;
    lastEventTs: string;
    status: "next" | "active" | "blocked" | "done" | "retired";
    blockedOn?: string;
    blockedWhy?: string;
    // Why this unit was retired without reaching its outcome, and where the
    // outcome went when a successor exists. Retirement is not completion: the
    // outcome was deliberately given up or moved, never achieved here.
    retiredWhy?: string;
    successor?: { work: string; project?: string };
    reports: ReportEntry[];
    evidence: string[];
    notes: string[];
    artifacts: ArtifactMeta[];
    // Every branch this unit was worked on, oldest first. Derived, never
    // asserted: one unit runs on several branches, and one branch carries
    // several units.
    branches: string[];
    attempts: AttemptSummary[];
    // The last-reported process transition for this unit, folded from the
    // synced `work.run-started`/`work.run-exited` events. The pid never syncs;
    // `ledger.ts` refines running into stale on the machine that recorded it.
    process?: { state: "running" | "exited"; code?: number; at: string };
    // What this unit has to cover, who has to approve it, and what its
    // implementation had to be — the semantic half of done, which no attempt
    // and no transition ever settles on its own.
    completion: CompletionState;
    // Why this unit may not be called done yet, or undefined when nothing
    // stands in the way. One check, derived here so every surface reads the
    // same answer the `work done` verb is refused by.
    owes?: string;
    next?: string;
    // The outcomes this unit contributes to. Stated by `self work link`, never
    // inferred: one unit may serve several objectives, and a milestone is
    // satisfied by evidence, not by a unit reaching done.
    objectives: string[];
    milestones: string[];
    // The live proposals that name this unit in `decide --blocks`, inverted
    // from the decisions. This is what lets a unit that was never started say
    // what stands in front of it — `work block --on decision` needs the unit to
    // be moving before it can say anything at all.
    gatedBy: string[];
}

// The commands a render is allowed to point at, spelled as types rather than
// tested at runtime. `pretty.ts` `scoped()` mints a `Pointer` from a
// `ScopableVerb` and appends the project; handed anything else it could only
// return the command unchanged, and a bare pointer that is nonetheless branded
// is the hole the brand exists to close (#165 review round 6).
export type ScopableVerb =
    | "self work"
    | "self objective"
    | "self milestone"
    | "self status"
    | "self context"
    | "self log"
    | "self state"
    | "self search --type decision"
    | "self search --type convention";

// What a render points at, when what it points at carries an id. A template
// member of the union above would admit any suffix, and `scoped()` appends the
// project to whatever it is handed — so `self search needle --type` came back
// as `self search needle --type --project 'slug'`, which the argument parser
// rejects, and an empty id produced a `self work show` with no positional
// (#165 review round 8). Naming the target instead of formatting the command
// leaves the caller nothing to malform: `pretty.ts` `pointerTo` writes it.
export type RecoveryTarget =
    | { verb: "work-show"; id: string }
    | { verb: "search"; id?: string; type?: string };

// One thing that waits on the human. `full` is the sentence shown while space
// allows; when the context budget forces the short form, `identity` still
// names the item and `recovery` is the command that prints its full state.
export interface WaitingItem
{
    full: string;
    identity: string;
    recovery: ScopableVerb | RecoveryTarget;
}

// What confirming a proposal would do, which is the only ranking a reader can
// act on. Three groups and no more: they answer what to do now, so a reason a
// row cannot be decided is a flag on the row rather than a fourth group.
//
// unblocks    — confirming it lets gated work move. A proposal that gates
//               nothing recorded lands here too: it is unclassified, and an
//               unclassified proposal still asks for a decision.
// undecidable — something else has to settle first; `flags` says what.
// inEffect    — the work it gated already landed, so it is a live rule and
//               confirming it only corrects the record.
export type AttentionGroup = "unblocks" | "undecidable" | "inEffect";

export interface AttentionRow
{
    decision: string;
    text: string;
    group: AttentionGroup;
    // The work units the proposal gates, as stated. Never filtered against the
    // known units: a ref this clone cannot resolve is still what was said.
    blocks: string[];
    after?: string;
    // Why this row cannot be decided yet, in the reader's terms. Empty is the
    // normal case, and never by itself a reason to promote a row.
    flags: string[];
}

export type AttentionBand = Record<AttentionGroup, AttentionRow[]>;

// What one unit reported from one branch, and how much of it no fold has been
// able to call settled.
export interface BranchWork
{
    work: string;
    status: WorkState["status"];
    evidence: number;
    unsettled: number;
}

// What a branch is still carrying that has not reached the default branch.
// Derived from what the store recorded — the branch each report was written
// from and the verdict each commit was given — never from asking git what
// exists now: a branch deleted after its merge is gone from the checkout and
// still has to say what was reported on it.
export interface BranchUnshipped
{
    // Absent where the store recorded no branch: a log written before events
    // carried one, or a report made from a detached HEAD. That evidence gets
    // its own line rather than being charged to a named branch.
    branch?: string;
    unshipped: BranchWork[];
}

// How a branch that was never recorded is named. Stated once because four
// surfaces print it, and two spellings of it would read as two branches.
const UNRECORDED_BRANCH = "(branch not recorded)";

export function branchLabel(branch: BranchUnshipped): string
{
    return branch.branch ?? UNRECORDED_BRANCH;
}

export function branchTotals(branch: BranchUnshipped): { units: number; evidence: number; unsettled: number }
{
    return {
        units: branch.unshipped.length,
        evidence: branch.unshipped.reduce((sum, item) => sum + item.evidence, 0),
        unsettled: branch.unshipped.reduce((sum, item) => sum + item.unsettled, 0)
    };
}

// Ranked, not merely listed: the reader takes the first group first. The order
// is stated here, beside the groups it orders, because every surface that
// shows the band shows it in this order — a second copy in a renderer would
// silently reorder one surface against another with nothing to catch it.
export const ATTENTION_ORDER: AttentionGroup[] = ["unblocks", "undecidable", "inEffect"];

export interface ProjectModel
{
    slug: string;
    description?: string;
    // The long-term goal. Objectives are time-boxed and live beside it: setting
    // one never overwrites the other.
    goal?: string;
    zone: string;
    goals: GoalState;
    decisions: DecisionState[];
    // Every convention ever recorded, current and historical alike, exactly as
    // `decisions` is kept. A renderer that means "the rules that hold now" says
    // so through `currentConventions`; history stays foldable for search.
    conventions: ConventionState[];
    works: WorkState[];
    // Removed subsystems' events (changeset.*, lease.*, review.*, spec.*)
    // still appear in old logs and fold to nothing here — see applyEvent.
    openQuestions: string[];
    // The same items as openQuestions, with the identity and recovery command
    // each renderer needs when it cannot afford the full sentence. Derived at
    // one site so the two lists can never disagree.
    waiting: WaitingItem[];
    // The live proposals, ranked by what confirming each one would do. Derived
    // here rather than in a renderer, so every surface reads one grouping.
    attention: AttentionBand;
    // What each branch is still carrying, branches with nothing unshipped
    // omitted. Derived here for the same reason the band is: a renderer that
    // decided it would answer differently from the next renderer.
    unshipped: BranchUnshipped[];
    // The entity view (#197): every asserted record — native `entity.*`
    // events and the legacy record kinds above read as entities — folded by
    // `entities.ts` into one shape. Derived after the signals, so the legacy
    // statuses it reads are the settled ones.
    entities: EntityState[];
    health: string[];
}

// ── the record lifecycle ─────────────────────────────────────────────
// The statement types, in code, once. A statement-type record is one a person
// asserts and can later take back, and ARCHITECTURE.md's record-lifecycle rule
// admits a new one only shipping the whole set of verbs below.
//
// This list is not documentation. `search.ts` builds its historical-status
// markers from `closed`, so a type missing from here silently stops saying
// which of its records still hold — and `test/lifecycle.test.mjs` reads this
// same list out of the built module rather than restating it, so a row can
// never drift from the verbs the CLI actually has.
export interface StatementType
{
    // The record, and the namespaces its events are written under. The proof
    // checks these against the namespaces the source actually creates records
    // in, so a new statement type cannot land without an entry here.
    type: string;
    namespaces: string[];
    // The command its lifecycle is spelled on, and the literal each transition
    // appears as in that command's help. `decline` is absent for a type with no
    // proposals — there is nothing to turn down.
    command: string;
    // Every type supersedes with `--supersedes` on its own add verb; only the
    // placeholder differs, because a convention is named by its event id and a
    // milestone by its sibling. A type spelling replacement any other way is
    // the asymmetry `test/supersede.test.mjs` fails on.
    supersede: string;
    withdraw: string;
    decline?: string;
    // The records that have left the current set, as id → status. Live records
    // are omitted: a search over what still holds reads as it always did.
    closed(model: ProjectModel): [string, string][];
}

export const STATEMENT_TYPES: StatementType[] = [
    {
        type: "decision",
        namespaces: ["decision"],
        command: "decide",
        supersede: "--supersedes <id>",
        withdraw: "decide retract",
        decline: "decide decline",
        closed: (model) => model.decisions
            .filter((item) => item.status !== "confirmed" && item.status !== "proposed")
            .map((item) => [item.id, item.status])
    },
    {
        type: "convention",
        namespaces: ["convention"],
        command: "convention",
        supersede: "--supersedes <event-id>",
        withdraw: "convention drop",
        closed: (model) => model.conventions
            .filter((item) => item.status !== "current")
            .map((item) => [item.id, item.status])
    },
    {
        type: "objective",
        namespaces: ["objective"],
        command: "objective",
        supersede: "--supersedes <id>",
        withdraw: "objective close",
        decline: "objective decline",
        closed: (model) => model.goals.objectives
            .filter((item) => item.status !== "active" && item.status !== "proposed")
            .map((item) => [item.id, item.status])
    },
    {
        type: "milestone",
        namespaces: ["milestone"],
        command: "milestone",
        supersede: "--supersedes m",
        withdraw: "milestone drop",
        closed: (model) => model.goals.objectives
            .flatMap((objective) => objective.milestones)
            .filter((item) => item.state === "closed" || item.state === "reached")
            .map((item) => [item.id, milestoneStatus(item)])
    },
    {
        type: "work",
        namespaces: ["work"],
        command: "work",
        supersede: "--supersedes <id>",
        withdraw: "work retire",
        decline: "work accept|decline",
        closed: (model) => [
            ...model.works
                .filter((item) => item.status === "done" || item.status === "retired")
                .map((item) => [item.id, item.status] as [string, string]),
            ...model.goals.proposals
                .filter((item) => item.status !== "open")
                .map((item) => [item.id, item.status] as [string, string])
        ]
    },
    {
        type: "entity",
        namespaces: ["entity"],
        command: "state",
        supersede: "--supersedes <id>",
        withdraw: "state retract",
        // `decline` is deliberately absent although entities have proposals:
        // the shared event grammar (#197 §5) carries one withdrawal event,
        // `entity.retracted`, so turning down a proposed entity is spelled
        // `state retract` — the same literal the withdraw row already checks.
        //
        // Only native entities are reported here. A legacy record folds into
        // the entity view too, but its own statement type above already
        // answers for it, and answering twice would overwrite a status such
        // as "declined" with this type's coarser "retracted".
        closed: (model) => model.entities
            .filter((item) => item.source === undefined && item.status !== "proposed" && item.status !== "confirmed")
            .map((item) => [item.id, item.status])
    },
];

// A milestone leaves the current set three ways, and a reader who searched for
// it needs to know which: given up on, replaced, or its evidence landed.
function milestoneStatus(milestone: { state: string; droppedWhy?: string; supersededBy?: string }): string
{
    if (milestone.droppedWhy !== undefined)
    {
        return "dropped";
    }
    return milestone.supersededBy === undefined ? milestone.state : "superseded";
}

// Every record that has left the current set, across every statement type, as
// id → status. One map because one search line asks one question.
export function closedRecords(model: ProjectModel): Map<string, string>
{
    const closed = new Map<string, string>();
    for (const statement of STATEMENT_TYPES)
    {
        for (const [id, status] of statement.closed(model))
        {
            closed.set(id, status);
        }
    }
    return closed;
}

export function buildModel(storeDir: string, slug: string, now: Date): ProjectModel
{
    const model = emptyModel(storeDir, slug);
    const events = readEvents(storeDir, slug);
    const entityFold = emptyEntityFold();
    // What an undo took back, read before the fold begins: a restoration is a
    // fact about the event it names, not a position in the log.
    collectAnnulled(entityFold, events);
    const creations = new Map<string, SelfEvent>();
    for (const event of events)
    {
        applyEvent(model, event);
        // The entity reading of the same pass: `entity.*` and the goal chain
        // fold here; the other legacy kinds derive from their folded records.
        applyEntity(entityFold, event);
        noteCreation(creations, event);
    }
    reconcileLifecycle(model, entityFold, events);
    // Objective supersessions settle before the entity view reads statuses;
    // deriveGoals runs the same idempotent pass again below.
    applySupersededObjectives(model.goals);
    model.entities = deriveEntities(entityFold, { decisions: model.decisions, conventions: model.conventions, objectives: model.goals.objectives });
    // The cutover joint (#207 B/E2), both directions. Entity events that moved
    // a legacy-derived record sync back onto it, so every legacy read surface
    // agrees with the entity view; native preset entities project into the
    // legacy read shapes, so those surfaces answer for post-cutover records.
    syncLegacyRecords(model);
    const nativeWorks = projectNativeRecords(model, creations);
    routeEntityWorkFacts(model, entityFold);
    replayDeferred(model, events, nativeWorks);
    deriveSignals(model, now);
    // Read once per fold, not once per row: the verdicts are a file, and a fold
    // runs on every event. Both derivations below read the same copy.
    const verdicts = readVerdicts(storeDir, slug);
    deriveAttention(model, verdicts);
    model.unshipped = unshippedBranches(model.works, verdicts);
    return model;
}

// The event that asserted each native entity, kept for the projection: the
// preset verbs record their extra fields — a decision's refs, an objective's
// horizon, a proposal's brief — on the creation event, and the entity schema
// deliberately does not carry them (#197 §2).
function noteCreation(creations: Map<string, SelfEvent>, event: SelfEvent): void
{
    const creates = event.type === "entity.proposed"
        || (event.type === "entity.confirmed" && event.refs?.confirms === undefined);
    const id = creates ? String(event.payload.entity ?? "") : "";
    if (id !== "" && !creations.has(id))
    {
        creations.set(id, event);
    }
}

function emptyModel(storeDir: string, slug: string): ProjectModel
{
    return {
        slug,
        description: readRegistry(storeDir).find((item) => item.slug === slug)?.description,
        zone: readStoreConfig(storeDir).timezone ?? DEFAULT_ZONE,
        goals: emptyGoals(),
        decisions: [],
        conventions: [],
        works: [],
        openQuestions: [],
        waiting: [],
        attention: { unblocks: [], undecidable: [], inEffect: [] },
        unshipped: [],
        entities: [],
        health: []
    };
}

function applyEvent(model: ProjectModel, event: SelfEvent): void
{
    // A receipt bound to a change set that named a work unit is still a
    // statement about that unit in an old log; the rest of the retired
    // namespaces (changeset.*, lease.*, merge.*, promotion.*, spec.*, …)
    // fold to nothing below by matching no branch.
    if (event.type === "review.received")
    {
        const reviewed = model.works.find((item) => item.id === event.refs?.work);
        if (reviewed !== undefined)
        {
            applyWorkReview(reviewed.completion, event);
        }
        return;
    }
    if (event.type === "goal.set")
    {
        model.goal = String(event.payload.text);
        return;
    }
    if (event.type.startsWith("decision."))
    {
        applyDecision(model, event);
        return;
    }
    if (event.type.startsWith("objective."))
    {
        applyObjective(model.goals, event);
        return;
    }
    if (event.type.startsWith("milestone."))
    {
        applyMilestone(model.goals, event);
        return;
    }
    if (PROPOSAL_EVENTS.includes(event.type))
    {
        applyProposal(model.goals, event);
        return;
    }
    if (event.type.startsWith("work."))
    {
        applyWork(model, event);
        return;
    }
    if (event.type === "report.added")
    {
        applyReport(model, event);
        return;
    }
    if (event.type.startsWith("run."))
    {
        applyAttempt(model, event);
        return;
    }
    if (event.type.startsWith("convention."))
    {
        applyConvention(model, event);
    }
}

// One correction is one event: the replacement is recorded and the conventions
// it names fold to `superseded` in the same pass, so the lineage the old
// drop-then-add lost is on the record itself.
function applyConvention(model: ProjectModel, event: SelfEvent): void
{
    if (event.type === "convention.added")
    {
        const supersedes = stringList(event.refs?.supersedes);
        model.conventions.push({ id: event.id, ts: event.ts, text: String(event.payload.text), status: "current", supersedes });
    }
    linkConvention(model, event);
}

// The half of a convention event that speaks about a record other than the one
// it created. Split out because it is the half that has to run again once every
// event has been read — see `reconcileLifecycle`.
function linkConvention(model: ProjectModel, event: SelfEvent): void
{
    const dropped = event.type === "convention.dropped";
    const why = dropped && event.payload.why !== undefined ? String(event.payload.why) : undefined;
    closeConventions(model, stringList(event.refs?.supersedes), dropped ? "dropped" : "superseded", why);
}

// A convention that already left the current set keeps the status it left
// under: the first withdrawal is the one that happened, and a later event
// naming it again never rewrites that.
function closeConventions(model: ProjectModel, ids: string[], status: "superseded" | "dropped", why?: string): void
{
    for (const id of ids)
    {
        const target = model.conventions.find((convention) => convention.id === id);
        if (target !== undefined && target.status === "current")
        {
            target.status = status;
            target.closedWhy = why;
        }
    }
}

// A proposal must not displace a confirmed decision: its supersedes refs are
// carried on the proposal and applied only at the moment it is confirmed.
function applyDecision(model: ProjectModel, event: SelfEvent): void
{
    if (event.type === "decision.proposed")
    {
        model.decisions.push(newDecision(event, "proposed", false));
        return;
    }
    if (event.type === "decision.confirmed" && event.refs?.confirms === undefined)
    {
        applySupersedes(model, event.refs?.supersedes ?? []);
        model.decisions.push(newDecision(event, "confirmed", event.origin.confirmed));
        return;
    }
    linkDecision(model, event);
}

// The half of a decision event that speaks about a record other than the one it
// created: a confirmation, a retraction, a decline. Every branch is a no-op
// against a record that is already where the branch would put it, which is what
// lets `reconcileLifecycle` run it a second time.
function linkDecision(model: ProjectModel, event: SelfEvent): void
{
    if (event.type === "decision.retracted" || event.type === "decision.declined")
    {
        withdrawDecision(model, event);
        return;
    }
    if (event.type !== "decision.confirmed")
    {
        return;
    }
    const target = model.decisions.find((decision) => decision.id === event.refs?.confirms);
    if (target !== undefined && target.status === "proposed")
    {
        applySupersedes(model, target.supersedes);
        target.status = "confirmed";
        target.humanConfirmed = event.origin.confirmed;
        target.ts = event.ts;
    }
}

// A lifecycle event names a record it did not create, and a union merge of two
// clones' logs orders lines by neither time nor dependency: a retraction can sit
// above the decision it withdraws. The first pass creates every record, so a
// second pass over the same events settles the ones whose target had not been
// read yet.
//
// Only the linking transitions run again, and each is written to be a no-op
// against a record already in its terminal state — so a record that folded
// correctly the first time is untouched, and one that could not is not left
// current forever. Revisions and coverage are deliberately absent: they
// accumulate rather than settle, and running one twice would count it twice.
function reconcileLifecycle(model: ProjectModel, entityFold: EntityFold, events: SelfEvent[]): void
{
    for (const event of events)
    {
        if (event.type.startsWith("decision."))
        {
            linkDecision(model, event);
        }
        else if (event.type.startsWith("convention."))
        {
            linkConvention(model, event);
        }
        else if (event.type === "objective.declined" || event.type === "objective.closed" || event.type === "objective.confirmed")
        {
            applyObjective(model.goals, event);
        }
        else if (event.type === "milestone.dropped")
        {
            applyMilestone(model.goals, event);
        }
        else if (event.type.startsWith("entity."))
        {
            reconcileEntity(entityFold, event);
        }
    }
}

/* ── the cutover joint (#207) ────────────────────────────────────────
//
// The preset verbs write `entity.*` events for every record kind, and the
// fold keeps reading legacy history forever (spec §8). These passes are the
// joint between the two: entity events that named a legacy-derived record
// settle onto its legacy state, native preset entities project into the
// legacy read shapes, and the work facts that still ride their own event
// types — reports, process transitions, completion history — replay onto
// work units the projection created. A store with no entity events reaches
// none of this, which is what keeps a pre-cutover store byte-identical (E1).
*/

// Entity lifecycle events can target a legacy-derived record — `decide
// confirm` on a legacy proposal, `objective close` on a legacy objective —
// and the entity view already settled them. Copy the settled statuses back
// onto the legacy records, so search markers, the attention band and every
// legacy render agree with the entity view (E2).
function syncLegacyRecords(model: ProjectModel): void
{
    for (const entity of model.entities)
    {
        if (entity.native === true || entity.source === undefined)
        {
            continue;
        }
        if (entity.source === "decision")
        {
            syncDecision(model, entity);
        }
        else if (entity.source === "convention")
        {
            syncConvention(model, entity);
        }
        else if (entity.source === "objective")
        {
            syncObjective(model, entity);
        }
        else if (entity.source === "milestone")
        {
            syncMilestone(model, entity);
        }
    }
}

function syncDecision(model: ProjectModel, entity: EntityState): void
{
    const record = model.decisions.find((item) => item.id === entity.id);
    if (record === undefined || (record.status !== "proposed" && record.status !== "confirmed"))
    {
        return;
    }
    if (entity.status === "confirmed" && record.status === "proposed")
    {
        record.status = "confirmed";
        record.humanConfirmed = entity.humanConfirmed;
        record.ts = entity.ts;
    }
    if (entity.status === "retracted")
    {
        record.status = record.status === "proposed" ? "declined" : "retracted";
        record.closedWhy = entity.closedWhy;
    }
    if (entity.status === "superseded")
    {
        record.status = "superseded";
    }
}

function syncConvention(model: ProjectModel, entity: EntityState): void
{
    const record = model.conventions.find((item) => item.id === entity.id);
    if (record === undefined || record.status !== "current")
    {
        return;
    }
    if (entity.status === "retracted")
    {
        record.status = "dropped";
        record.closedWhy = entity.closedWhy;
    }
    if (entity.status === "superseded")
    {
        record.status = "superseded";
    }
}

function syncObjective(model: ProjectModel, entity: EntityState): void
{
    const record = model.goals.objectives.find((item) => item.id === entity.id);
    if (record === undefined || (record.status !== "proposed" && record.status !== "active"))
    {
        return;
    }
    if (entity.status === "confirmed" && record.status === "proposed")
    {
        record.status = "active";
        record.humanConfirmed = entity.humanConfirmed;
    }
    if (entity.status === "retracted")
    {
        record.status = record.status === "proposed" ? "declined" : "dropped";
        record.closedWhy = entity.closedWhy;
    }
    if (entity.status === "superseded")
    {
        record.status = "superseded";
        record.supersededBy = entity.supersededBy;
    }
    if (entity.execution?.status === "done")
    {
        record.status = "reached";
        record.closedWhy = entity.execution.report;
    }
    if (entity.execution?.status === "retired")
    {
        record.status = "dropped";
        record.closedWhy = entity.execution.why;
    }
}

function syncMilestone(model: ProjectModel, entity: EntityState): void
{
    const found = findMilestone(model.goals, entity.id);
    if (found === null)
    {
        return;
    }
    const { objective, milestone } = found;
    if (entity.status === "superseded" && milestone.supersededBy === undefined)
    {
        milestone.supersededBy = entity.supersededBy;
    }
    syncCoverage(milestone, objective.revision, entity);
    if (entity.execution?.status === "retired")
    {
        milestone.droppedWhy = milestone.droppedWhy ?? (entity.execution.why ?? "retired");
    }
    if (entity.execution?.status === "done" && milestone.reached === undefined)
    {
        milestone.reached = reachedFromEntity(milestone, objective.revision, entity);
    }
}

// A claim names the criterion by text; the legacy record keys coverage by the
// criterion's id. Claims land at the record's current revisions — post-cutover
// nothing goes stale by revision, a revision is a supersession (#207 B12).
function syncCoverage(milestone: MilestoneState, objectiveRevision: number, entity: EntityState): void
{
    for (const claim of entity.covered)
    {
        const criterion = milestone.exit.find((item) => item.dropped !== true && item.text === claim.criterion);
        if (criterion !== undefined)
        {
            milestone.coverage.push({
                criterion: criterion.id,
                ts: claim.ts,
                why: claim.why,
                work: claim.work,
                commits: claim.commits,
                objectiveRevision,
                milestoneRevision: milestone.revision
            });
        }
    }
}

function reachedFromEntity(milestone: MilestoneState, objectiveRevision: number, entity: EntityState)
{
    return {
        ts: entity.execution?.ts ?? entity.ts,
        objectiveRevision,
        milestoneRevision: milestone.revision,
        criteria: [...new Set(milestone.coverage.map((item) => item.criterion))],
        evidence: [...new Set(milestone.coverage.flatMap((item) => item.commits))]
    };
}

/* ── the native projection (#207 B) ────────────────────────────────── */

// Native preset entities become the legacy read shapes, so `self objective`,
// `self work show`, the canonical files and the HTML views answer for
// post-cutover records without a renderer changing. Returns the native work
// ids, which the deferred replay attaches reports and process history to.
function projectNativeRecords(model: ProjectModel, creations: Map<string, SelfEvent>): Set<string>
{
    const natives = model.entities.filter((entity) => entity.native === true && entity.source !== undefined);
    for (const entity of natives.filter((item) => item.source !== "milestone" && item.source !== "work"))
    {
        projectNative(model, entity, creations.get(entity.id));
    }
    // Milestones after the objectives they hang under, and work last: a
    // unit's member-of links resolve against the projected outcome layer, and
    // a union-merged log can order any of the pairs backwards.
    for (const entity of natives.filter((item) => item.source === "milestone"))
    {
        projectMilestone(model, entity, creations.get(entity.id));
    }
    for (const entity of natives.filter((item) => item.source === "work"))
    {
        projectWork(model, entity, creations.get(entity.id));
    }
    projectGoal(model);
    return new Set(model.works.filter((work) => natives.some((entity) => entity.id === work.id)).map((work) => work.id));
}

function projectNative(model: ProjectModel, entity: EntityState, creation: SelfEvent | undefined): void
{
    if (entity.source === "decision")
    {
        model.decisions.push(projectDecision(entity, creation));
    }
    else if (entity.source === "convention")
    {
        model.conventions.push(projectConvention(entity));
    }
    else if (entity.source === "objective")
    {
        model.goals.objectives.push(projectObjective(entity, creation));
    }
}

// The newest live goal-labeled entity is the goal, exactly as the last
// `goal.set` always was. Only a store holding native goals reaches this;
// everywhere else the pass-1 reading stands untouched.
function projectGoal(model: ProjectModel): void
{
    const goals = model.entities.filter((entity) => entity.source === "goal" && isLive(entity));
    if (!goals.some((entity) => entity.native === true))
    {
        return;
    }
    const newest = [...goals].sort((left, right) => right.ts.localeCompare(left.ts) || right.id.localeCompare(left.id))[0];
    model.goal = newest?.text ?? model.goal;
}

function supersedesOf(entity: EntityState): string[]
{
    return entity.links.filter((link) => link.type === "supersedes").map((link) => link.target);
}

function projectDecision(entity: EntityState, creation: SelfEvent | undefined): DecisionState
{
    return {
        id: entity.id,
        text: entity.text,
        why: entity.why,
        ts: entity.ts,
        status: entity.status === "retracted" && !entity.confirmedOnce ? "declined" : entity.status,
        humanConfirmed: entity.humanConfirmed,
        expired: false,
        supersedes: supersedesOf(entity),
        closedWhy: entity.closedWhy,
        work: creation?.refs?.work,
        blocks: stringList(creation?.refs?.blocks),
        after: creation?.refs?.after === undefined ? undefined : String(creation.refs.after)
    };
}

function projectConvention(entity: EntityState): ConventionState
{
    return {
        id: entity.id,
        ts: entity.ts,
        text: entity.text,
        status: entity.status === "confirmed" || entity.status === "proposed" ? "current"
            : entity.status === "superseded" ? "superseded" : "dropped",
        supersedes: supersedesOf(entity),
        closedWhy: entity.closedWhy
    };
}

function projectObjective(entity: EntityState, creation: SelfEvent | undefined): ObjectiveState
{
    const payload = creation?.payload ?? {};
    return {
        id: entity.id,
        outcome: entity.text,
        ts: entity.ts,
        revision: 1,
        horizon: payload.horizon === undefined ? undefined : String(payload.horizon),
        target: entity.target,
        success: stringList(payload.success),
        stop: stringList(payload.stop),
        priority: typeof payload.rank === "number" ? payload.rank : undefined,
        status: objectiveStatusOf(entity),
        humanConfirmed: entity.humanConfirmed,
        supersedes: supersedesOf(entity),
        supersededBy: entity.supersededBy,
        closedWhy: objectiveClosedWhy(entity),
        history: [],
        milestones: [],
        state: "on-track",
        reason: "",
        met: 0,
        total: 0,
        works: []
    };
}

// Execution first: a reached or retired outcome outranks the assertion
// status, because completion and withdrawal say more than "still asserted".
function objectiveStatusOf(entity: EntityState): ObjectiveState["status"]
{
    if (entity.execution?.status === "done")
    {
        return "reached";
    }
    if (entity.execution?.status === "retired")
    {
        return "dropped";
    }
    if (entity.status === "proposed")
    {
        return "proposed";
    }
    if (entity.status === "confirmed")
    {
        return "active";
    }
    return entity.status === "superseded" ? "superseded" : entity.confirmedOnce ? "dropped" : "declined";
}

function objectiveClosedWhy(entity: EntityState): string | undefined
{
    if (entity.execution?.status === "done")
    {
        return entity.execution.report;
    }
    if (entity.execution?.status === "retired")
    {
        return entity.execution.why;
    }
    return entity.closedWhy;
}

function projectMilestone(model: ProjectModel, entity: EntityState, creation: SelfEvent | undefined): void
{
    const parent = entity.links.find((link) => link.type === "member-of");
    const objective = parent === undefined ? undefined
        : model.goals.objectives.find((item) => item.id === parent.target);
    if (objective === undefined)
    {
        return;
    }
    const milestone: MilestoneState = {
        id: entity.id,
        objective: objective.id,
        outcome: entity.text,
        ts: entity.ts,
        revision: 1,
        target: entity.target,
        exit: entity.criteria.map((text, index) => ({ id: `c${index + 1}`, text })),
        after: stringList(creation?.payload.after),
        coverage: [],
        supersededBy: entity.supersededBy,
        droppedWhy: milestoneDroppedWhy(entity),
        state: "on-track",
        reason: "",
        met: [],
        open: [],
        stale: [],
        works: [],
        blockedWorks: [],
        evidence: [],
        criticalPath: false
    };
    syncCoverage(milestone, objective.revision, entity);
    if (entity.execution?.status === "done")
    {
        milestone.reached = reachedFromEntity(milestone, objective.revision, entity);
    }
    objective.milestones.push(milestone);
}

function milestoneDroppedWhy(entity: EntityState): string | undefined
{
    if (entity.execution?.status === "retired")
    {
        return entity.execution.why ?? "retired";
    }
    return entity.status === "retracted" ? entity.closedWhy ?? "retracted" : undefined;
}

// A work entity whose creation carried the proposal brief is a proposal; it
// becomes a unit the moment it is confirmed — accept is confirm (#207 B13) —
// so one record carries the whole lifecycle under one id.
function projectWork(model: ProjectModel, entity: EntityState, creation: SelfEvent | undefined): void
{
    const brief = creation?.payload.value !== undefined;
    if (brief)
    {
        model.goals.proposals.push(projectProposal(entity, creation as SelfEvent));
    }
    if (!entity.confirmedOnce)
    {
        return;
    }
    const links = entity.links.filter((link) => link.type === "member-of").map((link) => link.target);
    model.works.push({
        id: entity.id,
        outcome: entity.text,
        ts: entity.ts,
        lastEventTs: entity.execution?.ts ?? entity.ts,
        status: workStatusOf(entity),
        blockedOn: entity.execution?.status === "blocked" ? entity.execution.on ?? "dependency" : undefined,
        blockedWhy: entity.execution?.status === "blocked" ? entity.execution.why : undefined,
        retiredWhy: entity.execution?.status === "retired" ? entity.execution.why ?? "retired" : undefined,
        successor: entity.execution?.successor === undefined ? undefined
            : { work: entity.execution.successor, project: entity.execution.successorProject },
        reports: [],
        evidence: [],
        notes: [],
        artifacts: [],
        branches: creation?.refs?.branch === undefined ? [] : [String(creation.refs.branch)],
        objectives: links.filter((id) => model.goals.objectives.some((item) => item.id === id)),
        milestones: links.filter((id) => findMilestone(model.goals, id) !== null),
        gatedBy: [],
        attempts: [],
        completion: emptyCompletion()
    });
}

function workStatusOf(entity: EntityState): WorkState["status"]
{
    const status = entity.execution?.status;
    if (status === "in-progress")
    {
        return "active";
    }
    if (status === "blocked" || status === "done" || status === "retired")
    {
        return status;
    }
    return "next";
}

function projectProposal(entity: EntityState, creation: SelfEvent)
{
    const payload = creation.payload;
    return {
        id: entity.id,
        ts: entity.ts,
        outcome: entity.text,
        objective: payload.objective === undefined ? undefined : String(payload.objective),
        milestone: payload.milestone === undefined ? undefined : String(payload.milestone),
        value: String(payload.value ?? ""),
        success: stringList(payload.success),
        stop: stringList(payload.stop),
        depends: stringList(payload.depends),
        risk: String(payload.risk ?? ""),
        capacity: String(payload.capacity ?? ""),
        evidencePlan: String(payload.evidencePlan ?? ""),
        confidence: String(payload.confidence ?? ""),
        expires: String(payload.expires ?? ""),
        status: entity.confirmedOnce ? "accepted" as const : entity.status === "retracted" ? "declined" as const : "open" as const,
        expired: false,
        work: entity.confirmedOnce ? entity.id : undefined,
        declinedWhy: entity.status === "retracted" ? entity.closedWhy : undefined
    };
}

/* ── entity work facts on legacy units, and the deferred replay ────── */

// Post-cutover, `work start` and its siblings record `entity.*` execution
// events whatever kind of unit they move. On a native unit the entity view
// already carries them; a legacy unit is not an entity, so its events route
// here, in the same timestamp order and with the same terminal guards the
// entity fold applies.
function routeEntityWorkFacts(model: ProjectModel, fold: EntityFold): void
{
    const entityIds = new Set(model.entities.map((entity) => entity.id));
    const works = new Map(model.works.map((work) => [work.id, work]));
    const executions = [...fold.executions].sort((left, right) =>
        left.ts.localeCompare(right.ts) || left.event.localeCompare(right.event));
    for (const event of executions)
    {
        const work = works.get(event.entity);
        if (!entityIds.has(event.entity) && work !== undefined)
        {
            applyExecutionToWork(work, event);
        }
    }
    const links = [...fold.links].sort((left, right) =>
        left.ts.localeCompare(right.ts) || left.event.localeCompare(right.event));
    for (const event of links)
    {
        const work = works.get(event.entity);
        if (!entityIds.has(event.entity) && work !== undefined && event.link.type === "member-of")
        {
            applyMemberOf(model, work, event.link.target, event.add);
        }
    }
}

function applyExecutionToWork(work: WorkState, event: { ts: string; type: string; on?: string; why?: string; successor?: string; successorProject?: string }): void
{
    if (work.status === "done" || work.status === "retired")
    {
        return;
    }
    work.lastEventTs = event.ts;
    if (event.type === "entity.started" && work.status !== "blocked")
    {
        work.status = "active";
    }
    if (event.type === "entity.unblocked" && work.status === "blocked")
    {
        work.status = "active";
        work.blockedOn = undefined;
        work.blockedWhy = undefined;
    }
    if (event.type === "entity.blocked" && work.status !== "blocked")
    {
        work.status = "blocked";
        work.blockedOn = event.on ?? "dependency";
        work.blockedWhy = event.why;
    }
    if (event.type === "entity.done")
    {
        work.status = "done";
    }
    if (event.type === "entity.retired")
    {
        work.status = "retired";
        work.blockedOn = undefined;
        work.blockedWhy = undefined;
        work.retiredWhy = event.why ?? "retired";
        work.successor = event.successor === undefined ? undefined
            : { work: event.successor, project: event.successorProject };
    }
}

function applyMemberOf(model: ProjectModel, work: WorkState, target: string, add: boolean): void
{
    const field = model.goals.objectives.some((item) => item.id === target) ? "objectives"
        : findMilestone(model.goals, target) !== null ? "milestones" : null;
    if (field === null)
    {
        return;
    }
    work[field] = add
        ? [...new Set([...work[field], target])]
        : work[field].filter((item) => item !== target);
}

// Reports, process transitions and completion history keep their own event
// types (#207 B14). In the first pass they attach to nothing when they name a
// unit the projection had not created yet, so the lines naming a native unit
// run once more here — everything else already attached, and runs zero times.
function replayDeferred(model: ProjectModel, events: SelfEvent[], nativeWorks: Set<string>): void
{
    if (nativeWorks.size === 0)
    {
        return;
    }
    for (const event of events)
    {
        const ref = attachedWorkOf(event);
        if (ref !== undefined && nativeWorks.has(ref))
        {
            applyEvent(model, event);
        }
    }
}

function attachedWorkOf(event: SelfEvent): string | undefined
{
    if (event.type === "report.added" || event.type === "review.received" || event.type.startsWith("run."))
    {
        return event.refs?.work === undefined ? undefined : String(event.refs.work);
    }
    if (event.type.startsWith("work.") && event.type !== "work.created" && !PROPOSAL_EVENTS.includes(event.type))
    {
        return typeof event.payload.work === "string" ? event.payload.work : undefined;
    }
    return undefined;
}

// Withdrawal with no successor. The record keeps its text, its reason and
// every ref pointing at it — what changes is that it stops being current, so
// `--after` and `--blocks` on other records still resolve against history.
function withdrawDecision(model: ProjectModel, event: SelfEvent): void
{
    const refs = event.refs;
    const retracted = event.type === "decision.retracted";
    const target = model.decisions.find((decision) => decision.id === (retracted ? refs?.retracts : refs?.declines));
    // Only a live record is withdrawn: the command refuses the rest, and a log
    // written by a version that did not would otherwise unsay a supersession.
    if (target === undefined || (target.status !== "confirmed" && target.status !== "proposed"))
    {
        return;
    }
    target.status = retracted ? "retracted" : "declined";
    target.closedWhy = event.payload.why === undefined ? undefined : String(event.payload.why);
}

// A withdrawn decision is not superseded by a later one: the person said it
// was taken back, and a successor arriving afterwards does not unsay that.
function applySupersedes(model: ProjectModel, ids: string[]): void
{
    for (const id of ids)
    {
        const target = model.decisions.find((decision) => decision.id === id);
        if (target !== undefined && target.status !== "retracted" && target.status !== "declined")
        {
            target.status = "superseded";
        }
    }
}

function newDecision(event: SelfEvent, status: "proposed" | "confirmed", humanConfirmed: boolean): DecisionState
{
    return {
        id: event.id,
        text: String(event.payload.text),
        why: event.payload.why === undefined ? undefined : String(event.payload.why),
        ts: event.ts,
        status,
        humanConfirmed,
        expired: false,
        supersedes: event.refs?.supersedes ?? [],
        work: event.refs?.work,
        // Coerced, never trusted: these refs arrive from clones written by
        // versions that did not have them and by machines this one never saw.
        blocks: stringList(event.refs?.blocks),
        after: event.refs?.after === undefined ? undefined : String(event.refs.after)
    };
}

// Events written before branches were recorded carry none; absence reads as
// unknown, so the whole log stays foldable. Anything that is not a non-empty
// string reads as absent too: the log is append-only and hand-appended lines
// exist, and `String(...)` would put "[object Object]" or "null" on four
// surfaces as the name of a branch to check out.
function branchRef(event: SelfEvent): string | undefined
{
    const branch = event.refs?.branch;
    return typeof branch === "string" && branch !== "" ? branch : undefined;
}

function branchOf(event: SelfEvent): string[]
{
    const branch = branchRef(event);
    return branch === undefined ? [] : [branch];
}

function noteBranch(work: WorkState, event: SelfEvent): void
{
    for (const branch of branchOf(event))
    {
        if (!work.branches.includes(branch))
        {
            work.branches.push(branch);
        }
    }
}

function applyWork(model: ProjectModel, event: SelfEvent): void
{
    if (event.type === "work.created")
    {
        model.works.push({
            id: String(event.payload.work),
            outcome: String(event.payload.outcome),
            ts: event.ts,
            lastEventTs: event.ts,
            status: "next",
            reports: [],
            evidence: [],
            notes: [],
            artifacts: [],
            branches: branchOf(event),
            objectives: [],
            milestones: [],
            gatedBy: [],
            attempts: [],
            completion: emptyCompletion()
        });
        return;
    }
    const work = model.works.find((item) => item.id === event.payload.work);
    if (work === undefined)
    {
        return;
    }
    work.lastEventTs = event.ts;
    noteBranch(work, event);
    if (isCompletionEvent(event.type))
    {
        applyCompletion(work.completion, event);
        return;
    }
    if (event.type === "work.linked" || event.type === "work.unlinked")
    {
        applyLink(work, event);
        return;
    }
    // Retirement is terminal, the way a retracted decision and a dropped
    // milestone are. `requireOpenWork` already refuses every transition on a
    // retired unit, so nothing this CLI wrote can reach here — what can is a
    // stale line merged from a clone that had not pulled the retirement yet.
    // Done is deliberately not terminal: reopening a finished unit is real
    // work, and only the withdrawal is the end of the record.
    if (work.status === "retired" && event.type !== "work.retired")
    {
        return;
    }
    if (event.type === "work.run-started")
    {
        work.process = { state: "running", at: event.ts };
        return;
    }
    if (event.type === "work.run-exited")
    {
        work.process = {
            state: "exited",
            code: typeof event.payload.code === "number" ? event.payload.code : undefined,
            at: event.ts
        };
        return;
    }
    if (event.type === "work.started" || event.type === "work.unblocked")
    {
        work.status = "active";
        work.blockedOn = undefined;
        work.blockedWhy = undefined;
    }
    if (event.type === "work.blocked")
    {
        work.status = "blocked";
        work.blockedOn = String(event.payload.on);
        work.blockedWhy = event.payload.why === undefined ? undefined : String(event.payload.why);
    }
    if (event.type === "work.done")
    {
        work.status = "done";
    }
    if (event.type === "work.retired")
    {
        work.status = "retired";
        work.blockedOn = undefined;
        work.blockedWhy = undefined;
        work.retiredWhy = String(event.payload.why);
        if (typeof event.payload.successor === "string")
        {
            work.successor = {
                work: event.payload.successor,
                project: typeof event.payload.successorProject === "string" ? event.payload.successorProject : undefined
            };
        }
    }
}

// One unit may contribute to more than one outcome, and one outcome may be
// supported by several units, so a link is added to a set rather than
// replacing what is there.
function applyLink(work: WorkState, event: SelfEvent): void
{
    const add = event.type === "work.linked";
    for (const field of ["objectives", "milestones"] as const)
    {
        const id = event.payload[field.slice(0, -1)];
        if (typeof id !== "string")
        {
            continue;
        }
        work[field] = add
            ? [...new Set([...work[field], id])]
            : work[field].filter((item) => item !== id);
    }
}

const ATTEMPT_STATES: Record<string, AttemptSummary["state"]> = {
    "run.started": "started",
    "run.completed": "completed",
    "run.failed": "failed",
    "run.blocked": "blocked",
    "run.cancelled": "cancelled"
};

// One record per attempt, moved forward by each of its events, so a work unit
// shows the state its last run actually reached rather than a count of lines.
function applyAttempt(model: ProjectModel, event: SelfEvent): void
{
    const state = ATTEMPT_STATES[event.type];
    const id = event.refs?.attempt ?? String(event.payload.attempt ?? "");
    const work = model.works.find((item) => item.id === event.refs?.work);
    if (state === undefined || id === "" || work === undefined)
    {
        return;
    }
    work.lastEventTs = event.ts;
    noteBranch(work, event);
    const existing = work.attempts.find((attempt) => attempt.id === id);
    const attempt = existing ?? { id, state, ts: event.ts, artifacts: [] };
    attempt.state = state;
    attempt.ts = event.ts;
    // Stated once, at the start, and kept: the later events of an attempt say
    // what became of it, never what it ran under.
    attempt.model = event.payload.model === undefined ? attempt.model : String(event.payload.model);
    attempt.failure = event.payload.failure === undefined ? undefined : String(event.payload.failure);
    attempt.detail = event.payload.detail === undefined ? undefined : String(event.payload.detail);
    if (Array.isArray(event.payload.artifacts))
    {
        attempt.artifacts = event.payload.artifacts as AttemptSummary["artifacts"];
    }
    if (existing === undefined)
    {
        work.attempts.push(attempt);
    }
}

function applyReport(model: ProjectModel, event: SelfEvent): void
{
    const work = model.works.find((item) => item.id === event.refs?.work);
    if (work === undefined)
    {
        return;
    }
    work.lastEventTs = event.ts;
    noteBranch(work, event);
    const { commits, notes } = splitEvidence(event);
    const artifacts = Array.isArray(event.payload.artifacts) ? event.payload.artifacts as ArtifactMeta[] : [];
    work.reports.push({ id: event.id, ts: event.ts, text: String(event.payload.text), commits, notes, artifacts, branch: branchRef(event) });
    work.evidence.push(...commits.filter((commit) => !work.evidence.includes(commit)));
    work.notes.push(...notes.filter((note) => !work.notes.includes(note)));
    work.artifacts.push(...artifacts);
    if (event.payload.next !== undefined)
    {
        work.next = String(event.payload.next);
    }
}

// A report that recorded its evidence as typed was split when it was written,
// by the repository that could answer whether each value resolved; the reader
// takes that verdict as given. Anything older is split again here on shape
// alone, so a store written before evidence carried its type folds correctly
// without a single historical event being rewritten.
function splitEvidence(event: SelfEvent): { commits: string[]; notes: string[] }
{
    const offered = stringList(event.refs?.commits);
    const declared = stringList(event.payload.notes);
    if (event.payload.evidenceTyped === true)
    {
        return { commits: offered, notes: declared };
    }
    return {
        commits: offered.filter(looksLikeLegacyRevision),
        notes: [...offered.filter((value) => !looksLikeLegacyRevision(value)), ...declared]
    };
}

// Nothing read out of the log is trusted to be the type it is declared as:
// events arrive from other machines, and a number where a string belongs would
// reach a renderer that calls string methods on it.
function stringList(value: unknown): string[]
{
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function deriveSignals(model: ProjectModel, now: Date): void
{
    model.health.push(...deriveGoals(model.goals, model.works, now, model.zone));
    for (const objective of model.goals.objectives.filter((item) => item.status === "proposed"))
    {
        noteWaiting(model, {
            full: `objective ${objective.id} is proposed and not confirmed: ${objective.outcome}`,
            identity: `proposed objective ${objective.id}`,
            recovery: "self objective"
        });
    }
    for (const decision of model.decisions)
    {
        if (decision.status === "proposed" && ageDays(decision.ts, now) > PROPOSAL_EXPIRY_DAYS)
        {
            decision.expired = true;
        }
    }
    for (const work of model.works)
    {
        deriveCompletion(work.completion);
        // Derived for open units only. A closed unit was judged — done through
        // the gate, or legacy history the fold never refuses (#205 table D) —
        // and re-deriving what it owes would mark every evidence-free legacy
        // done "not done yet" on a page that says it is.
        if (work.status !== "done" && work.status !== "retired")
        {
            work.owes = completionRefusal(work) ?? undefined;
        }
        if (work.status === "blocked" && work.blockedOn === "decision")
        {
            noteWaiting(model, {
                full: `${work.id} is waiting on a decision: ${work.blockedWhy ?? work.outcome}`,
                identity: `blocked work ${work.id}`,
                recovery: { verb: "work-show", id: work.id }
            });
        }
        if (work.status === "active" && ageDays(work.lastEventTs, now) > STALL_DAYS)
        {
            const days = Math.floor(ageDays(work.lastEventTs, now));
            model.health.push(`${work.id} looks stalled — no events for ${days} days`);
        }
    }
}

// The band, and the inversion that makes it possible, in one pass over the
// live proposals. Both sides are indexed first — units by id, superseded ids by
// the proposals claiming them — so the cost stays linear in decisions plus work
// rather than the product of the two.
function deriveAttention(model: ProjectModel, verdicts: Record<string, Verdict>): void
{
    const live = model.decisions
        .filter((decision) => decision.status === "proposed" && !decision.expired)
        .sort((left, right) => left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id));
    const band: BandIndex = {
        works: new Map(model.works.map((work) => [work.id, work])),
        verdicts,
        open: new Set(live.map((decision) => decision.id)),
        claimed: supersessionClaims(live)
    };
    for (const decision of live)
    {
        gate(band, decision);
        const row = attentionRow(decision, band);
        model.attention[row.group].push(row);
    }
}

// Everything one pass needs to place a row, indexed once. Built here rather
// than looked up per row: a decision asks about work, about the proposals still
// open, and about what they collide over, and each of those is a scan.
interface BandIndex
{
    works: Map<string, WorkState>;
    verdicts: Record<string, Verdict>;
    open: Set<string>;
    claimed: Map<string, string[]>;
}

function gate(band: BandIndex, decision: DecisionState): void
{
    for (const id of decision.blocks)
    {
        const gated = band.works.get(id);
        if (gated !== undefined && !gated.gatedBy.includes(decision.id))
        {
            gated.gatedBy.push(decision.id);
        }
    }
}

function attentionRow(decision: DecisionState, band: BandIndex): AttentionRow
{
    const flags = attentionFlags(decision, band);
    // A proposal that gates nothing can never be in effect: there is no landed
    // work to read the rule off, and silence is not evidence.
    const inEffect = decision.blocks.length > 0
        && decision.blocks.every((id) => landed(band.works.get(id), band.verdicts));
    return {
        decision: decision.id,
        text: decision.text,
        // Being already in force outranks a flag: what still stands between the
        // rule and the record does not change that the work ran under it.
        group: inEffect ? "inEffect" : flags.length > 0 ? "undecidable" : "unblocks",
        blocks: decision.blocks,
        after: decision.after,
        flags
    };
}

// An event id in the log names something that already happened, so only a
// proposal still open can hold another one back. Anything else `--after` names
// — a report, a merge, an event this clone has not pulled — is not a wait.
function attentionFlags(decision: DecisionState, band: BandIndex): string[]
{
    const flags: string[] = [];
    if (decision.after !== undefined && band.open.has(decision.after))
    {
        flags.push(`waiting on ${decision.after}`);
    }
    const rival = decision.supersedes
        .flatMap((id) => band.claimed.get(id) ?? [])
        .find((id) => id !== decision.id);
    if (rival !== undefined)
    {
        flags.push(`conflict with ${rival}`);
    }
    return flags;
}

// Two live proposals that retire the same decision cannot both be confirmed as
// written — confirming either one leaves the other describing a rule that is no
// longer there.
function supersessionClaims(live: DecisionState[]): Map<string, string[]>
{
    const claimed = new Map<string, string[]>();
    for (const decision of live)
    {
        for (const id of decision.supersedes)
        {
            claimed.set(id, [...claimed.get(id) ?? [], decision.id]);
        }
    }
    return claimed;
}

// A gated unit landed only when it is done and every commit it offered is
// settled — reachable from the default branch. Provisional, unknown and
// unverifiable each read as not landed, and so does a unit that offered no
// commits at all: calling a rule live on evidence nobody can reach would retire
// a decision the person never made.
function landed(work: WorkState | undefined, verdicts: Record<string, Verdict>): boolean
{
    return work !== undefined
        && work.status === "done"
        && work.evidence.length > 0
        && work.evidence.every((hash) => verdicts[hash] === "settled");
}

// The key an unrecorded branch is grouped under. No git branch can be named
// the empty string, so it can never collide with one that was recorded.
const NO_BRANCH = "";

// What a unit reported from each branch. Attribution follows the report that
// carried the commits, because only a report says which commits were produced;
// `WorkState.branches` is the union of the same ref across every event kind and
// cannot say which branch a given hash came from.
function evidenceByBranch(work: WorkState): Map<string, Set<string>>
{
    const perBranch = new Map<string, Set<string>>();
    for (const report of work.reports)
    {
        const key = report.branch ?? NO_BRANCH;
        // A set, not a list scanned per hash: one commit reported twice from
        // one branch is still one commit, and a fold runs on every event.
        const hashes = perBranch.get(key) ?? new Set<string>();
        report.commits.forEach((hash) => hashes.add(hash));
        perBranch.set(key, hashes);
    }
    return perBranch;
}

// Open work only, and every surface says so in the words it counts with.
// A closed unit's verdicts stop being recomputed — `evidenceOf` in
// `reachability.ts` leaves the archive alone so that recording state does not
// cost more the longer a project lives — so its commits keep whatever verdict
// they held the day it closed. Stating one here would mean a unit marked done
// while its branch was unmerged claims that branch as unshipped for good,
// including long after the merge, and no action a reader takes clears it. The
// statement is worth having only where it is checked on every fold, so it
// covers exactly the work that is: an omission under a stated scope is honest,
// a frozen claim is not. Retired work is excluded by the same filter and would
// be anyway, having already said it will not be delivered here.
//
// The other side — refreshing the archive so closed units could be stated — is
// the cost #128 exists to keep out: unsettled evidence never settles after a
// squash merge, so the recheck set would grow with the project and every event
// append would pay for it.
function stated(works: WorkState[]): WorkState[]
{
    return works.filter((work) => work.status !== "done" && work.status !== "retired");
}

// What has not shipped, per branch. A branch carries a unit when some commit
// the unit reported from it is not settled — the same conservatism `landed`
// applies one section up: provisional, unknown, abandoned and unverifiable all
// read as not shipped, and only settled means reachable from the default
// branch. A branch with nothing unsettled gets no line at all.
export function unshippedBranches(works: WorkState[], verdicts: Record<string, Verdict>): BranchUnshipped[]
{
    const branches = new Map<string, BranchUnshipped>();
    for (const work of stated(works))
    {
        for (const [key, hashes] of evidenceByBranch(work))
        {
            const unsettled = [...hashes].filter((hash) => verdicts[hash] !== "settled").length;
            if (unsettled === 0)
            {
                continue;
            }
            const state = branches.get(key) ?? { branch: key === NO_BRANCH ? undefined : key, unshipped: [] };
            state.unshipped.push({ work: work.id, status: work.status, evidence: hashes.size, unsettled });
            branches.set(key, state);
        }
    }
    // Sorted by id rather than left in log order: a union merge orders two
    // clones' lines differently, and the same store must render the same bytes
    // on either machine.
    for (const state of branches.values())
    {
        state.unshipped.sort((left, right) => compareBytes(left.work, right.work));
    }
    return [...branches.values()].sort(compareBranch);
}

// UTF-8 byte order, never `localeCompare`: the default collator is built from
// LC_ALL and LANG, so the same store folded on two machines — or by one
// machine whose environment changed between runs — would order these lines
// differently. A branch name is bytes the store recorded; comparing it by
// those bytes is the only comparison the environment cannot move.
function compareBytes(left: string, right: string): number
{
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

// Named branches first and in name order, the unrecorded line last: it is the
// one group a reader cannot act on by checking out.
function compareBranch(left: BranchUnshipped, right: BranchUnshipped): number
{
    if (left.branch === undefined || right.branch === undefined)
    {
        return (left.branch === undefined ? 1 : 0) - (right.branch === undefined ? 1 : 0);
    }
    return compareBytes(left.branch, right.branch);
}

// The single site that answers "what waits on a person": every renderer reads
// either list, so an item can never appear in one and be missing from the other.
function noteWaiting(model: ProjectModel, item: WaitingItem): void
{
    model.openQuestions.push(item.full);
    model.waiting.push(item);
}

function ageDays(ts: string, now: Date): number
{
    return (now.getTime() - new Date(ts).getTime()) / 86_400_000;
}
