import { completionRefusal } from "./completion.js";
import { DEFAULT_ZONE } from "./dates.js";
import { applyEntity, awaitsReview, collectAnnulled, deriveEntities, emptyEntityFold, EntityFold, EntityLink, EntityScope, EntityState, HOME_SCOPE, isCurrent, isLive, PlanState, reconcileEntity, rendersIn } from "./entities.js";
import { looksLikeLegacyRevision } from "./gitutil.js";
import { readEvents } from "./logfile.js";
import {
    applyMilestone,
    applyObjective,
    applySupersededObjectives,
    Coverage,
    deriveGoals,
    emptyGoals,
    findMilestone,
    GoalState,
    MilestoneState,
    ObjectiveState,
    WorkProposal
} from "./objectives.js";
import { activeProjects, readRegistry, readStoreConfig, readVerdicts, Verdict } from "./paths.js";
import { plural } from "./style.js";
import { ArtifactMeta, SelfEvent } from "./types.js";

const PROPOSAL_EXPIRY_DAYS = 14;
const STALL_DAYS = 3;

// The two `work.*` types a current binary still writes: a run's process
// transitions. Everything else under that namespace is pre-cutover history,
// which #305 stopped folding to state.
const PROCESS_EVENTS = ["work.run-started", "work.run-exited"];

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
    // Whether the rule renders into the repository's tracked instruction
    // files (#276). Absent means internal, which is what every rule recorded
    // before the key existed reads as.
    visibility?: "public";
    // The registered artifact the rule points at, by id (#238). Carried here
    // because the terminal render reads this projection and not the entity —
    // dropping it here would render a rule without the guide it names.
    artifact?: string;
}

// The rules that hold now. One site answers it, so no two renderers can
// disagree about whether a superseded convention still counts.
export function currentConventions(conventions: ConventionState[]): ConventionState[]
{
    return conventions.filter((convention) => convention.status === "current");
}

export interface HandoffConvention
{
    id: string;
    ts: string;
    text: string;
    // The artifact the rule points at (#238), for the same reason
    // `ConventionState` carries it: the packet renders from this projection.
    artifact?: string;
}

// The packet's convention closure follows the same placement graph as context:
// live convention entities that render in the target, with one canonical row
// per id. The caller supplies the one captured model graph, including an
// explicitly named archived target when needed.
export function applicableConventions(target: string, models: ProjectModel[]): HandoffConvention[]
{
    const found = new Map<string, HandoffConvention>();
    for (const model of models)
    {
        for (const entity of model.entities.filter((item) => item.source === "convention" && item.status === "confirmed" && isCurrent(item)
            && rendersIn(item, model.slug, target)))
        {
            if (!found.has(entity.id))
            {
                found.set(entity.id, { id: entity.id, ts: entity.ts, text: entity.text, artifact: entity.artifact });
            }
        }
    }
    return [...found.values()].sort((left, right) => left.id.localeCompare(right.id));
}

// Reports are a projection, not an assumption about JSONL append order. A
// merged log can carry newer evidence earlier, so both work pages and the
// handoff consume this exact latest-first ordering.
export function reportProjection(reports: ReportEntry[]): ReportEntry[]
{
    return [...reports].sort((left, right) => right.ts.localeCompare(left.ts) || right.id.localeCompare(left.id));
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
    // What differed from expectation, one sentence per occurrence (#380). A
    // list rather than one string: a session hits more than one, and each has
    // to stay its own sentence for anything reading them later. Empty on every
    // report written before the flag existed, and on every one that omits it.
    friction: string[];
    // The branch these commits were reported from — what lets the fold tell a
    // discarded branch from a squash-merged one.
    branch?: string;
    // The repository they were reported from, by identity (#331). Absent on a
    // report written before it was recorded, or from a checkout with no commit.
    repository?: string;
    // A report submitted as a design or scope proposal (#316), and the
    // decisions it says it implements. The citation is a ref on the report
    // event rather than a record of its own: what a design implements is part
    // of the report, not a second thing that could outlive it.
    design?: boolean;
    implements: string[];
    // The person's ruling on it, and the artifact digest that ruling named —
    // which is what makes the approval about one exact design rather than
    // about a title. Absent until someone approves it.
    approval?: { ts: string; digest?: string };
}

// What a runner attempt left in the synced log: the state it reached, why it
// stopped, and the hashes of what it published. The raw output that produced
// them stays in the machine-local spool and never folds into project state.
interface AttemptSummary
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

// One cross-project contribution (#244): the objective's id and the slug of
// the registered project whose log owns it, as the link event stated them.
export interface ForeignObjectiveLink
{
    id: string;
    project: string;
}

export interface WorkState
{
    id: string;
    outcome: string;
    ts: string;
    lastEventTs: string;
    // `review` is the sixth (#356): a unit whose current plan nobody has
    // accepted. It is open work — it lists, it counts, it can carry a design
    // — and it is the one status `work start` refuses.
    status: "next" | "active" | "blocked" | "done" | "retired" | "review";
    // Which version of the plan is current and which one an acceptance bound,
    // for a unit that began as a proposal (#356). Absent on a `work add` unit
    // and on every unit folded from pre-cutover history.
    plan?: PlanState;
    blockedOn?: string;
    blockedWhy?: string;
    // Why this unit was retired without reaching its outcome, and where the
    // outcome went when a successor exists. Retirement is not completion: the
    // outcome was deliberately given up or moved, never achieved here.
    retiredWhy?: string;
    successor?: { work: string; project?: string };
    reports: ReportEntry[];
    // The `report.added` ids a swept proposal cited as its evidence (#381),
    // read off the creation event's `refs.friction`. Empty on every unit that
    // was not proposed by `self sweep --record`. Named apart from
    // `ReportEntry.friction`, which holds sentences: these are the ids of the
    // reports those sentences were written on.
    frictionEvidence: string[];
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
    // Which session picked this unit up, and when (#230). Derived from the
    // newest `entity.started`, never asserted by a verb of its own: the
    // command that hands over the brief is the one that records the claim, so
    // there is nothing else to fold. It discloses and never refuses — a second
    // session reads who holds the unit and decides for itself.
    claim?: { session?: string; ts: string };
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
    // The objectives other registered projects own that this unit contributes
    // to (#244), each qualified by the owning slug the link event carried.
    // Kept apart from `objectives` on purpose: those ids resolve in this
    // fold's own goal tree, and a foreign id mixed in would either be dropped
    // or resolved against the wrong project.
    foreignObjectives: ForeignObjectiveLink[];
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
    | "self runbook"
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
    | { verb: "runbook-show"; id: string }
    | { verb: "search"; id?: string; type?: string }
    | LogPage;

// The whole of a log a listing showed the last few lines of. `self log` is the
// one listing that takes a window — `-n` is how many lines it prints — so the
// command for the rest is the same verb carrying the count the window was cut
// from. It is a target of its own rather than a `ScopableVerb` because the
// number is part of the command, and a scopable verb is an exact string with
// the project appended to it.
export interface LogPage
{
    verb: "log";
    lines: number;
}

// One thing that waits on the human. `full` is the sentence shown while space
// allows; when the context budget forces the short form, `identity` still
// names the item and `recovery` is the command that prints its full state.
export interface WaitingItem
{
    full: string;
    identity: string;
    recovery: ScopableVerb | RecoveryTarget;
    // The command that rules on this item, where ruling on it is a command of
    // its own rather than a page to go read. A row that has none is answered
    // by its recovery pointer instead, so every row a person sees carries
    // something to run (#264).
    action?: string;
    // The same sentence with the command clause left off, for the render that
    // prints the command on a line of its own. Set only where `full` ends by
    // naming the command; elsewhere the two are the same text.
    lead?: string;
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

type AttentionBand = Record<AttentionGroup, AttentionRow[]>;

// What one unit reported from one branch, and how much of it no fold has been
// able to call settled.
interface BranchWork
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
interface StatementType
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
        type: "goal",
        namespaces: ["goal"],
        command: "goal",
        supersede: "--supersedes <id>",
        withdraw: "goal retract",
        // A goal has no proposal form, so `decline` is absent: the closest
        // preset kind, a convention, has none either, and nothing this type
        // ships depends on one existing.
        closed: (model) => model.entities
            .filter((item) => item.source === "goal" && item.status !== "confirmed")
            .map((item) => [item.id, item.status])
    },
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

// One pass over the log, read two ways at once. Answers the creation events
// the entity projection needs afterwards.
function foldLog(model: ProjectModel, entityFold: EntityFold, events: SelfEvent[]): Map<string, SelfEvent>
{
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
    return creations;
}

function reconcileEntityView(model: ProjectModel, entityFold: EntityFold, events: SelfEvent[], creations: Map<string, SelfEvent>): void
{
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
    carryLegacyMilestones(model);
    replayDeferred(model, events, nativeWorks);
}

function deriveVerdictReads(model: ProjectModel, storeDir: string, slug: string): void
{
    // Read once per fold, not once per row: the verdicts are a file, and a fold
    // runs on every event. Both derivations below read the same copy.
    const verdicts = readVerdicts(storeDir, slug);
    deriveAttention(model, verdicts);
    model.unshipped = unshippedBranches(model.works, verdicts);
}

export function buildModel(storeDir: string, slug: string, now: Date): ProjectModel
{
    const model = emptyModel(storeDir, slug);
    const events = readEvents(storeDir, slug);
    const entityFold = emptyEntityFold();
    const creations = foldLog(model, entityFold, events);
    reconcileEntityView(model, entityFold, events, creations);
    deriveSignals(model, now);
    deriveVerdictReads(model, storeDir, slug);
    return model;
}

// Which project a work unit renders in. The placement lives on the unit's
// entity (#181 D1). Since #305 every folded unit is projected from an entity,
// so the lookup does not fail; home stays the answer for a miss rather than a
// throw, because a render is not the place to discover a fold invariant.
export function workScope(model: ProjectModel, work: WorkState): EntityScope
{
    return model.entities.find((item) => item.id === work.id)?.scope ?? HOME_SCOPE;
}

// The cross-project half of a unit's toward line (#244), stated from this
// log alone: every render — including the fold's canonical pages, which must
// never read another project's log — can name the owning slug from it.
export function foreignToward(work: WorkState): string[]
{
    return work.foreignObjectives.map((link) => `${link.id} (${link.project})`);
}

// Every active project's fold, the named one first. A record renders where its
// scope points rather than where its log sits (#181 D1), so answering for one
// project — what it renders, what its tiers hold — reads every store. An
// archived project is not among them (#283): it is out of every workspace-wide
// answer until it is restored, and `--project <slug>` is how its own state is
// still read.
export function workspaceModels(storeDir: string, first?: string): ProjectModel[]
{
    const slugs = activeProjects(storeDir).map((entry) => entry.slug);
    const rest = slugs.filter((slug) => slug !== first);
    const now = new Date();
    return (first === undefined ? rest : [first, ...rest]).map((slug) => buildModel(storeDir, slug, now));
}

// Which registered projects hold the record a call names (#302). A confirm
// answers to a record that already exists and already has an owning project,
// so the project is never asked for — it is found, and the caller says what
// "holds it" means for the record kind it is about to act on.
//
// The directory's own project answers first and ends the search, so a call
// made from the right checkout costs exactly the one fold it always did. Only
// a call made from outside pays for the enumeration, which is the call that
// could not be made at all before.
//
// The archived projects are in it. Whether an archived project may be written
// into is the append gate's one rule (#283); leaving them out here would
// answer "no project holds this record" where the truth is "restore it first".
//
// The fold travels with the answer, because the caller is about to look the
// record up in exactly this model: handing back the slug alone would make
// every confirm read and fold its project's log twice.
type Holding = { project: string; model: ProjectModel };

export function projectsHolding(storeDir: string, holds: (model: ProjectModel) => boolean, first?: string): Holding[]
{
    const now = new Date();
    if (first !== undefined)
    {
        const model = buildModel(storeDir, first, now);
        if (holds(model))
        {
            return [{ project: first, model }];
        }
    }
    return readRegistry(storeDir)
        .map((entry) => entry.slug)
        .filter((slug) => slug !== first)
        .flatMap((project) => holding(storeDir, project, now, holds));
}

// Only the matches are kept: a workspace of thirty projects folds thirty logs
// to answer this, and holding every one of them for the one the caller wants
// is memory spent on projects the answer already ruled out.
function holding(storeDir: string, project: string, now: Date,
    holds: (model: ProjectModel) => boolean): Holding[]
{
    const model = buildModel(storeDir, project, now);
    return holds(model) ? [{ project, model }] : [];
}

// What a workspace-wide listing reads: every registered project that folds,
// and a line naming each one that does not (#75 T4.5). `self project` answers
// about the workspace as a whole — which slugs exist, and which project came
// from which — so one store nothing can read must not take the answer for
// every other project down with it. Every other surface still folds through
// `workspaceModels`, where an unreadable store is a failure worth stopping on.
//
// The active projects, and only those: `self project --archived` is the one
// listing an archived project belongs in, and it prints from the archive state
// rather than from a fold (#283).
export function readableModels(storeDir: string): { models: ProjectModel[]; unreadable: string[] }
{
    const now = new Date();
    const models: ProjectModel[] = [];
    const unreadable: string[] = [];
    for (const entry of activeProjects(storeDir))
    {
        try
        {
            models.push(buildModel(storeDir, entry.slug, now));
        }
        catch (error)
        {
            unreadable.push(`${entry.slug}: its state could not be read, so it is skipped here — ${(error as Error).message}`);
        }
    }
    return { models, unreadable };
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

type Reducer = (model: ProjectModel, event: SelfEvent) => void;

// Exact types first, then namespaces. An event matching neither folds to
// nothing, which is what the retired namespaces (changeset.*, lease.*, merge.*,
// promotion.*, spec.*, …) do — and, since #305, what every `work.*` type but
// the two process transitions does.
const EXACT_REDUCERS: ReadonlyArray<readonly [string, Reducer]> = [
    ["work.run-started", applyProcess],
    ["work.run-exited", applyProcess],
    ["goal.set", (model, event) => { model.goal = String(event.payload.text); }],
    ["report.added", applyReport],
    ["report.confirmed", applyReportConfirmed]
];

const NAMESPACE_REDUCERS: ReadonlyArray<readonly [string, Reducer]> = [
    ["decision.", applyDecision],
    ["objective.", (model, event) => applyObjective(model.goals, event)],
    ["milestone.", (model, event) => applyMilestone(model.goals, event)],
    ["run.", applyAttempt],
    ["convention.", applyConvention]
];

function applyEvent(model: ProjectModel, event: SelfEvent): void
{
    const exact = EXACT_REDUCERS.find(([type]) => type === event.type);
    if (exact !== undefined)
    {
        exact[1](model, event);
        return;
    }
    NAMESPACE_REDUCERS.find(([prefix]) => event.type.startsWith(prefix))?.[1](model, event);
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
    syncObjectiveExecution(record, entity);
}

function syncObjectiveExecution(record: ObjectiveState, entity: EntityState): void
{
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

// Every goal still standing, newest first. Several stand at once — `goal add`
// displaces nothing, and only a stated `--supersedes` retires one — so a
// surface with room renders them all and a one-line surface reads the first.
export function liveGoals(model: ProjectModel): EntityState[]
{
    return model.entities.filter((entity) => entity.source === "goal" && isLive(entity))
        .sort((left, right) => right.ts.localeCompare(left.ts) || right.id.localeCompare(left.id));
}

// What a surface with one line for the goal appends to it: how many others
// stand behind the one it printed. Empty where nothing does, so the common
// case reads exactly as it always has.
export function otherGoals(model: ProjectModel): string
{
    const rest = liveGoals(model).length - 1;
    return rest > 0 ? ` (+${rest} more)` : "";
}

// The goals this project holds for itself: the workspace-scoped ones (#287)
// are the whole workspace's, and the surface that states them once for the
// workspace reads them from here so a project's row does not say them again.
export function projectScopedGoals(model: ProjectModel): EntityState[]
{
    return liveGoals(model).filter((entity) => entity.scope !== "workspace");
}

// The same one-line pair as `model.goal` + `otherGoals`, over one project's
// own goals: the first, and how many of its own stand behind it.
export function projectGoalLine(model: ProjectModel): string
{
    const goals = projectScopedGoals(model);
    return (goals[0]?.text ?? "(no goal)") + (goals.length > 1 ? ` (+${goals.length - 1} more)` : "");
}

// `model.goal` is one string that predates goals being ordinary records, and
// the surfaces with a single slot for it still read it. The newest live goal
// answers there; `liveGoals` answers everywhere with room for the rest.
function projectGoal(model: ProjectModel): void
{
    // A store that recorded no goal at all keeps the pass-1 reading; one that
    // did lets the entity view answer, including when the last standing goal
    // was withdrawn and the slot is empty again.
    if (!model.entities.some((entity) => entity.source === "goal"))
    {
        return;
    }
    model.goal = liveGoals(model)[0]?.text;
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
        closedWhy: entity.closedWhy,
        visibility: entity.visibility,
        artifact: entity.artifact
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
        carried: [],
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

function newMilestone(entity: EntityState, objective: ObjectiveState, creation: SelfEvent | undefined): MilestoneState
{
    return {
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
        carriedFrom: [],
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
}

function projectMilestone(model: ProjectModel, entity: EntityState, creation: SelfEvent | undefined): void
{
    const parents = memberObjectives(model, entity);
    const objective = parents[parents.length - 1];
    if (objective === undefined)
    {
        return;
    }
    const milestone = newMilestone(entity, objective, creation);
    syncCoverage(milestone, objective.revision, entity);
    if (entity.execution?.status === "done")
    {
        milestone.reached = reachedFromEntity(milestone, objective.revision, entity);
    }
    objective.milestones.push(milestone);
    noteCarry(milestone, parents);
}

// Every edge but the newest is an objective a revision carried the milestone
// away from (#333): that objective's page lists it as carried, and the
// milestone's own page says where it came from. One hop per page — a second
// revision writes a second edge, and each superseded objective names only its
// own successor.
function noteCarry(milestone: MilestoneState, parents: ObjectiveState[]): void
{
    for (let index = 0; index < parents.length - 1; index += 1)
    {
        milestone.carriedFrom.push(parents[index].id);
        parents[index].carried.push({ milestone: milestone.id, to: parents[index + 1].id });
    }
}

// A legacy milestone — folded from `milestone.created` rather than projected
// from an entity — sits under the objective its creation named. A revision
// carries it exactly as it carries a native one: the link lands on its derived
// entity, and this pass moves the record to the newest objective the edges
// name. It runs after the native records project, because the successor is
// native and has to exist before the edge to it can resolve.
function carryLegacyMilestones(model: ProjectModel): void
{
    for (const entity of model.entities)
    {
        if (entity.native === true || entity.source !== "milestone")
        {
            continue;
        }
        const found = findMilestone(model.goals, entity.id);
        const parents = memberObjectives(model, entity);
        const target = parents[parents.length - 1];
        if (found === null || target === undefined || target === found.objective)
        {
            continue;
        }
        found.objective.milestones = found.objective.milestones.filter((item) => item.id !== entity.id);
        found.milestone.objective = target.id;
        target.milestones.push(found.milestone);
        noteCarry(found.milestone, parents);
    }
}

// The objectives a milestone's member-of edges resolve to, in edge order. The
// newest edge is the objective it hangs under now: `objective revise` carries
// a milestone by appending an edge to the successor, never by removing the one
// to the predecessor, so undoing that one link returns the milestone to where
// it was rather than leaving it under nothing.
function memberObjectives(model: ProjectModel, entity: EntityState): ObjectiveState[]
{
    return entity.links.filter((link) => link.type === "member-of")
        .map((link) => model.goals.objectives.find((item) => item.id === link.target))
        .filter((item): item is ObjectiveState => item !== undefined);
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
    // The brief, not the proposed status, is what makes a proposal a gap
    // proposal: a standalone plan (#356) is born proposed and carries none.
    if (creation?.payload.value !== undefined)
    {
        model.goals.proposals.push(projectProposal(entity, creation as SelfEvent));
    }
    // A plan awaiting review is a unit too, in the `review` status: the
    // dispatch gate has to see it to refuse a start by name, and a filter
    // restated in six renderers is what a sixth status exists instead of.
    if (!entity.confirmedOnce && !awaitsReview(entity))
    {
        return;
    }
    model.works.push(workFromEntity(model, entity, creation));
}

// The member-of edges, split by where they resolve (#244): an unqualified id
// resolves against this fold's own goal tree, as it always did; a qualified
// one names another project's objective and is carried as stated, because
// this fold can never look it up.
function memberLinks(model: ProjectModel, entity: EntityState): Pick<WorkState, "objectives" | "milestones" | "foreignObjectives">
{
    const members = entity.links.filter((link) => link.type === "member-of");
    const local = members.filter((link) => link.project === undefined).map((link) => link.target);
    return {
        objectives: local.filter((id) => model.goals.objectives.some((item) => item.id === id)),
        milestones: local.filter((id) => findMilestone(model.goals, id) !== null),
        foreignObjectives: members.filter((link) => link.project !== undefined)
            .map((link) => ({ id: link.target, project: link.project as string }))
    };
}

function workFromEntity(model: ProjectModel, entity: EntityState, creation: SelfEvent | undefined): WorkState
{
    return {
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
        claim: entity.claim,
        plan: entity.plan,
        reports: [],
        frictionEvidence: stringList(creation?.refs?.friction),
        evidence: [],
        notes: [],
        artifacts: [],
        branches: creation?.refs?.branch === undefined ? [] : [String(creation.refs.branch)],
        ...memberLinks(model, entity),
        gatedBy: [],
        attempts: []
    };
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
    return awaitsReview(entity) ? "review" : "next";
}

// Why a unit awaiting review may not be picked up, or null when nothing stands
// in the way. A plan nobody accepted and one revised past the acceptance that
// approved it are the same refusal: the same person runs the same command.
export function reviewRefusal(work: WorkState): string | null
{
    if (work.status !== "review")
    {
        return null;
    }
    const plan = work.plan;
    const stated = plan?.accepted === undefined
        ? `its plan (v${plan?.current ?? 1}) has not been accepted`
        : `v${plan.accepted} was accepted and v${plan.current} is the current plan`;
    return `${work.id} is waiting on review — ${stated}; a person runs \`self work accept ${work.id}\``;
}

// The units a person is being asked to review that no gap proposal already
// speaks for (#356). Gap proposals keep their own brief rows, so a surface
// that shows both reads this beside `openProposals` and counts each once.
export function reviewWork(model: ProjectModel): WorkState[]
{
    return model.works.filter((work) => work.status === "review"
        && !model.goals.proposals.some((item) => item.id === work.id));
}

// How a plan under review reads wherever it is named, so the listing, the
// waiting row, the unit's page and the HTML panel say it the same way.
export function planNote(work: WorkState): string
{
    const plan = work.plan;
    if (plan === undefined)
    {
        return "not yet accepted";
    }
    return plan.accepted === undefined
        ? `v${plan.current} — not yet accepted`
        : `v${plan.current} (current) · v${plan.accepted} accepted`;
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
        // A revised acceptance reads open again (#356): the brief still stands,
        // and the plan under it is waiting on the same person a second time.
        status: awaitsReview(entity) ? "open" as const
            : entity.confirmedOnce ? "accepted" as const
                : entity.status === "retracted" ? "declined" as const : "open" as const,
        expired: false,
        work: entity.confirmedOnce && !awaitsReview(entity) ? entity.id : undefined,
        declinedWhy: entity.status === "retracted" ? entity.closedWhy : undefined
    };
}

/* ── the deferred replay ───────────────────────────────────────────── */

// Reports and process transitions keep their own event types (#207 B14). In
// the first pass they attach to nothing when they name a unit the projection
// had not created yet, so the lines naming a native unit run once more here —
// everything else already attached, and runs zero times.
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
    if (event.type.startsWith("report.") || event.type.startsWith("run."))
    {
        return event.refs?.work === undefined ? undefined : String(event.refs.work);
    }
    if (PROCESS_EVENTS.includes(event.type))
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

function repositoryRef(event: SelfEvent): string | undefined
{
    const repository = event.refs?.repository;
    return typeof repository === "string" && repository !== "" ? repository : undefined;
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

// A run event says where the unit's process is, which is machine state rather
// than a position in the lifecycle, so it never touches status. The two
// `work.run-*` types are the only ones under that namespace a current binary
// writes, and #305 left them their own reducer when the legacy `work.*` fold
// went: routed through it they kept two side effects the projection needs.
//
// `lastEventTs` moves because a run is the unit saying it just moved, and the
// stall signal reads that timestamp. `noteBranch` runs because the branch a
// run carried belongs in the same union of refs every other event feeds — the
// unit page's `- Branches:` line and the HTML chip read it.
//
// A retirement guard is deliberately absent: it stopped status transitions,
// and a process fact about a retired unit is still a fact.
function applyProcess(model: ProjectModel, event: SelfEvent): void
{
    const work = model.works.find((item) => item.id === event.payload.work);
    if (work === undefined)
    {
        return;
    }
    work.lastEventTs = event.ts;
    noteBranch(work, event);
    work.process = event.type === "work.run-started"
        ? { state: "running", at: event.ts }
        : { state: "exited", code: typeof event.payload.code === "number" ? event.payload.code : undefined, at: event.ts };
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
    work.reports.push({
        id: event.id, ts: event.ts, text: String(event.payload.text), commits, notes, artifacts,
        friction: stringList(event.payload.friction),
        branch: branchRef(event), repository: repositoryRef(event),
        design: event.payload.design === true, implements: stringList(event.refs?.implements)
    });
    work.evidence.push(...commits.filter((commit) => !work.evidence.includes(commit)));
    work.notes.push(...notes.filter((note) => !work.notes.includes(note)));
    work.artifacts.push(...artifacts);
    if (event.payload.next !== undefined)
    {
        work.next = String(event.payload.next);
    }
}

// A person's ruling on a design report (#316). It lands on the report rather
// than becoming a record of its own: reports are the append-only exception in
// the record lifecycle, and an approval bound to an immutable artifact digest
// is the same kind of fact — never withdrawn, only outlived, which is what
// happens the moment the decision it stood under is superseded.
function applyReportConfirmed(model: ProjectModel, event: SelfEvent): void
{
    const work = model.works.find((item) => item.id === event.refs?.work);
    const report = work?.reports.find((item) => item.id === event.refs?.confirms);
    if (work === undefined || report === undefined)
    {
        return;
    }
    work.lastEventTs = event.ts;
    const digest = event.payload.digest;
    report.approval = { ts: event.ts, digest: typeof digest === "string" ? digest : undefined };
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

function noteProposedObjectives(model: ProjectModel): void
{
    for (const objective of model.goals.objectives.filter((item) => item.status === "proposed"))
    {
        noteWaiting(model, {
            full: `objective ${objective.id} is proposed and not confirmed: ${objective.outcome}`,
            identity: `proposed objective ${objective.id}`,
            recovery: "self objective"
        });
    }
}

function expireProposedDecisions(model: ProjectModel, now: Date): void
{
    for (const decision of model.decisions)
    {
        if (decision.status === "proposed" && ageDays(decision.ts, now) > PROPOSAL_EXPIRY_DAYS)
        {
            decision.expired = true;
        }
    }
}

function deriveWorkSignals(model: ProjectModel, work: WorkState, now: Date): void
{
    // Derived for open units only. A closed unit was already judged by the
    // gate when it was closed, and asking again on a page that says it is done
    // would answer a question nobody can act on.
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

// The pair of the ruling that friction stays optional (#380 R3). Nothing is
// refused at capture, so the only place a project can learn it has stopped
// saying what differed is here — one line, and only once the silent reports
// outnumber the ones that spoke.
//
// Deliberately worded "this project's": it counts one project's reports, while
// the sweep that reads the same field counts a whole workspace's. Both say
// "last 30 days", and a reader who took one number for the other would draw
// the wrong conclusion from either.
const FRICTION_WINDOW_DAYS = 30;

function frictionSignals(model: ProjectModel, now: Date): string[]
{
    const recent = model.works.flatMap((work) => work.reports)
        .filter((report) => ageDays(report.ts, now) <= FRICTION_WINDOW_DAYS);
    const silent = recent.filter((report) => report.friction.length === 0).length;
    if (silent * 2 <= recent.length)
    {
        return [];
    }
    return [`no friction on ${silent} of this project's ${plural(recent.length, "report")}`
        + ` in the last ${FRICTION_WINDOW_DAYS} days — self report … --friction "<what differed>"`];
}

function deriveSignals(model: ProjectModel, now: Date): void
{
    model.health.push(...deriveGoals(model.goals, model.works, now, model.zone));
    model.health.push(...frictionSignals(model, now));
    noteProposedObjectives(model);
    expireProposedDecisions(model, now);
    for (const work of model.works)
    {
        deriveWorkSignals(model, work, now);
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

// A verdict that cannot locate the commit cannot say whether it shipped.
// `unknown` is the fold admitting it can tell neither a merge from a discard;
// `unverifiable` is the object being gone from the database. Neither is a
// weaker `provisional` — `provisional` asserts the work has not landed, and
// these assert nothing at all — so neither carries a branch here.
//
// `landed` one section up counts them as not-landed, and that is right there
// for a reason that reverses here. It gates a decision on completed work, so
// the expensive mistake is a false yes: calling a rule live on evidence nobody
// can reach retires a decision the person never made. This section makes the
// opposite claim, that work has NOT shipped, so the expensive mistake is the
// false yes in the other direction — and it is the one squash and rebase merges
// produce every time, since both rewrite the hash and delete the branch.
//
// `stated` above already refuses to make a claim that no action can clear, in
// the words "an omission under a stated scope is honest, a frozen claim is
// not". This is the same frozen claim on a unit that happens to still be open:
// by that comment's own account unsettled evidence never settles after a squash
// merge, so nothing a reader does will ever retire the line.
const CANNOT_LOCATE: ReadonlySet<Verdict> = new Set<Verdict>(["unknown", "unverifiable"]);

// What has not shipped, per branch. A branch carries a unit when some commit
// the unit reported from it is positively not settled: `provisional`,
// `abandoned`, or not yet judged — an unjudged hash must not drop out before
// the first fold reaches it. A branch with nothing unsettled gets no line.
export function unshippedBranches(works: WorkState[], verdicts: Record<string, Verdict>): BranchUnshipped[]
{
    const branches = new Map<string, BranchUnshipped>();
    for (const work of stated(works))
    {
        for (const [key, hashes] of evidenceByBranch(work))
        {
            const unsettled = [...hashes]
                .filter((hash) => verdicts[hash] !== "settled" && !CANNOT_LOCATE.has(verdicts[hash])).length;
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
