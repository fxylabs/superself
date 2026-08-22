import { dayIn, daysBetween } from "./dates.js";
import { SelfEvent } from "./types.js";

// A target is called at-risk this many days before it falls due, and only
// while exit criteria are still open. Reached work never becomes at-risk.
const AT_RISK_DAYS = 3;

// The outcome layer above work. An objective is not a task and a milestone is
// not a task: a milestone is an outcome checkpoint that several work units may
// satisfy, and no work transition ever reaches one on its own.
type TargetState = "reached" | "missed" | "blocked" | "at-risk" | "unstarted" | "on-track" | "closed";

// The lifecycle every statement-type record shares, in this type's words:
// live (`proposed`/`active`), replaced by a linked successor
// (`superseded`), withdrawn with no successor (`dropped`), turned down
// as a proposal (`declined`), or finished (`reached`).
type ObjectiveStatus = "proposed" | "active" | "reached" | "dropped" | "superseded" | "declined";

interface Criterion
{
    id: string;
    text: string;
    dropped?: boolean;
}

// What an exit criterion was satisfied by, and the revisions it was judged
// against — the pair is what lets a later revision expose stale coverage.
export interface Coverage
{
    criterion: string;
    ts: string;
    why: string;
    work?: string;
    commits: string[];
    objectiveRevision: number;
    milestoneRevision: number;
    recheck?: boolean;
}

export interface Reached
{
    ts: string;
    objectiveRevision: number;
    milestoneRevision: number;
    criteria: string[];
    evidence: string[];
}

interface CarriedMilestone
{
    milestone: string;
    to: string;
}

export interface MilestoneState
{
    id: string;
    objective: string;
    outcome: string;
    ts: string;
    revision: number;
    target?: string;
    exit: Criterion[];
    after: string[];
    coverage: Coverage[];
    reached?: Reached;
    reaffirmed?: Reached;
    supersededBy?: string;
    // Why this checkpoint was given up on. Set only by `milestone drop`: the
    // withdrawal every other statement type had and this one did not.
    droppedWhy?: string;
    // The objectives this checkpoint hung under before a revision carried it
    // to its current one (#333), oldest first. Read off the milestone's own
    // member-of edges, so the page it renders on can say where it came from.
    carriedFrom: string[];
    state: TargetState;
    reason: string;
    met: string[];
    open: string[];
    stale: Coverage[];
    works: string[];
    blockedWorks: string[];
    evidence: string[];
    criticalPath: boolean;
}

interface ObjectiveRevision
{
    ts: string;
    revision: number;
    why: string;
}

export interface ObjectiveState
{
    id: string;
    outcome: string;
    ts: string;
    revision: number;
    horizon?: string;
    target?: string;
    success: string[];
    stop: string[];
    priority?: number;
    status: ObjectiveStatus;
    humanConfirmed: boolean;
    supersedes: string[];
    supersededBy?: string;
    closedWhy?: string;
    history: ObjectiveRevision[];
    milestones: MilestoneState[];
    // Milestones a revision carried away from this objective (#333): each still
    // names this objective on an older member-of edge and now hangs under `to`.
    // They are not in `milestones` — they are the successor's — but the page of
    // a superseded objective lists them, so a reader sees the plan moved rather
    // than closed.
    carried: CarriedMilestone[];
    state: TargetState;
    reason: string;
    met: number;
    total: number;
    works: string[];
}

// A proposal born from the gap between an objective and current state. Every
// field is required at the command, so a proposal can never reach the log
// without saying what it buys, what stops it, and when it goes stale.
export interface WorkProposal
{
    id: string;
    ts: string;
    outcome: string;
    objective?: string;
    milestone?: string;
    value: string;
    success: string[];
    stop: string[];
    depends: string[];
    risk: string;
    capacity: string;
    evidencePlan: string;
    confidence: string;
    expires: string;
    status: "open" | "accepted" | "declined";
    expired: boolean;
    work?: string;
    declinedWhy?: string;
}

interface LinkedWork
{
    id: string;
    status: string;
    blockedOn?: string;
    blockedWhy?: string;
    objectives: string[];
    milestones: string[];
    evidence: string[];
}

export interface GoalState
{
    objectives: ObjectiveState[];
    proposals: WorkProposal[];
}

export function emptyGoals(): GoalState
{
    return { objectives: [], proposals: [] };
}

/* ── fold ──────────────────────────────────────────────────────────── */

// Confirming and declining both answer a proposal, and only a proposal. An
// objective already active was confirmed once, and saying so again changes
// nothing.
function answerProposal(objective: ObjectiveState, event: SelfEvent): void
{
    if (objective.status !== "proposed")
    {
        return;
    }
    if (event.type === "objective.confirmed")
    {
        objective.status = "active";
        objective.humanConfirmed = event.origin.confirmed;
        return;
    }
    objective.status = "declined";
    objective.closedWhy = str(event.payload.why);
}

export function applyObjective(goals: GoalState, event: SelfEvent): void
{
    if (event.type === "objective.created")
    {
        goals.objectives.push(newObjective(event));
        return;
    }
    const objective = goals.objectives.find((item) => item.id === event.payload.objective);
    if (objective === undefined)
    {
        return;
    }
    // A terminal objective is finished with. Every transition below is refused
    // against one, because the fold reads a log it cannot trust the order of:
    // a union merge puts a stale confirmation after the decline that answered
    // it, and `reconcileLifecycle` reads every one of these events a second
    // time. Without this the later line wins and a withdrawn objective comes
    // back active.
    if (isTerminalObjective(objective))
    {
        return;
    }
    applyToObjective(objective, event);
}

function applyToObjective(objective: ObjectiveState, event: SelfEvent): void
{
    if (event.type === "objective.confirmed" || event.type === "objective.declined")
    {
        answerProposal(objective, event);
        return;
    }
    if (event.type === "objective.revised")
    {
        reviseObjective(objective, event);
        return;
    }
    if (event.type === "objective.closed")
    {
        objective.status = event.payload.as === "reached" ? "reached" : "dropped";
        objective.closedWhy = str(event.payload.why);
    }
}

// The statuses an objective does not leave. `superseded` is applied after the
// fold by `applySupersededObjectives`, so it cannot be read here — that pass
// has its own guard for the same reason this one exists.
export function isTerminalObjective(objective: ObjectiveState): boolean
{
    return objective.status === "reached" || objective.status === "dropped" || objective.status === "declined";
}

function newObjective(event: SelfEvent): ObjectiveState
{
    const id = String(event.payload.objective);
    return {
        id,
        outcome: String(event.payload.outcome),
        ts: event.ts,
        revision: 1,
        horizon: str(event.payload.horizon),
        target: str(event.payload.target),
        success: list(event.payload.success),
        stop: list(event.payload.stop),
        priority: event.payload.priority === undefined ? undefined : Number(event.payload.priority),
        status: event.type === "objective.created" && event.payload.proposed === true ? "proposed" : "active",
        humanConfirmed: event.origin.confirmed,
        supersedes: event.refs?.supersedes ?? [],
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

// A revision never rewrites history: it bumps the number that coverage was
// judged against, which is what makes older coverage read as stale.
function reviseObjective(objective: ObjectiveState, event: SelfEvent): void
{
    const payload = event.payload;
    objective.revision += 1;
    objective.history.push({ ts: event.ts, revision: objective.revision, why: String(payload.why) });
    objective.outcome = str(payload.outcome) ?? objective.outcome;
    objective.horizon = revised(payload.horizon, objective.horizon);
    objective.target = revised(payload.target, objective.target);
    objective.priority = payload.priority === null ? undefined
        : payload.priority === undefined ? objective.priority : Number(payload.priority);
    if (payload.success !== undefined)
    {
        objective.success = list(payload.success);
    }
    if (payload.stop !== undefined)
    {
        objective.stop = list(payload.stop);
    }
}

// Lineage, not replacement: the superseded objective keeps its own record and
// gains a pointer, so a duplicate never leaves two conflicting current states.
//
// An objective that was already closed as reached keeps that status. Its
// outcome was verified and rolled up; a successor picking the work back up is
// lineage, not a reason to unsay what landed.
export function applySupersededObjectives(goals: GoalState): void
{
    for (const objective of goals.objectives)
    {
        for (const id of objective.supersedes)
        {
            const target = goals.objectives.find((item) => item.id === id);
            if (target === undefined || objective.status === "proposed")
            {
                continue;
            }
            target.supersededBy = objective.id;
            // A declined proposal never held, so nothing can replace it: the
            // lineage pointer is worth keeping, the status is not.
            if (target.status !== "reached" && target.status !== "declined")
            {
                target.status = "superseded";
            }
        }
    }
}

function createMilestone(goals: GoalState, event: SelfEvent): void
{
    const objective = goals.objectives.find((item) => item.id === event.payload.objective);
    objective?.milestones.push(newMilestone(event));
    const replaced = findMilestone(goals, String(event.payload.supersedes ?? ""));
    if (replaced !== null)
    {
        replaced.milestone.supersededBy = String(event.payload.milestone);
    }
}

// A recheck is a fresh judgment against the revisions current when it was made.
// Coverage gains an entry rather than losing one, and a re-judged reach sits
// beside the reach it re-affirms — the day the milestone was first reached
// stays exactly where it was.
function recheckMilestone(milestone: MilestoneState, event: SelfEvent): void
{
    if (event.payload.criterion === undefined)
    {
        milestone.reaffirmed = newReached(event);
        return;
    }
    milestone.coverage.push(newCoverage(event));
}

export function applyMilestone(goals: GoalState, event: SelfEvent): void
{
    if (event.type === "milestone.created")
    {
        createMilestone(goals, event);
        return;
    }
    const found = findMilestone(goals, String(event.payload.milestone));
    if (found === null)
    {
        return;
    }
    // Dropping and supersession are terminal, and for the same reason an
    // objective's terminal statuses are: revising a withdrawn checkpoint,
    // covering a criterion on it, or reaching it would put it back into the
    // current renders, and the fold cannot trust the order of a merged log.
    // Reaching is deliberately not terminal — `milestone recheck` exists to
    // re-judge a reach a revision left stale.
    if (isTerminalMilestone(found.milestone) && event.type !== "milestone.dropped")
    {
        return;
    }
    applyToMilestone(found.milestone, event);
}

function applyToMilestone(milestone: MilestoneState, event: SelfEvent): void
{
    if (event.type === "milestone.revised")
    {
        reviseMilestone(milestone, event);
        return;
    }
    // The first withdrawal is the one that happened; a second event naming the
    // same milestone never rewrites the reason recorded with it.
    if (event.type === "milestone.dropped")
    {
        milestone.droppedWhy = milestone.droppedWhy ?? String(event.payload.why);
        return;
    }
    if (event.type === "milestone.covered")
    {
        milestone.coverage.push(newCoverage(event));
        return;
    }
    if (event.type === "milestone.rechecked")
    {
        recheckMilestone(milestone, event);
        return;
    }
    if (event.type === "milestone.reached")
    {
        milestone.reached = newReached(event);
    }
}

function newReached(event: SelfEvent): Reached
{
    return {
        ts: event.ts,
        objectiveRevision: Number(event.payload.objectiveRevision),
        milestoneRevision: Number(event.payload.milestoneRevision),
        criteria: list(event.payload.criteria),
        evidence: list(event.payload.evidence)
    };
}

// Given up on, or replaced by a successor. A reached milestone is absent on
// purpose: `milestone recheck` re-judges a reach, so reaching is a verdict that
// can be revisited rather than a state the record never leaves.
function isTerminalMilestone(milestone: MilestoneState): boolean
{
    return milestone.droppedWhy !== undefined || milestone.supersededBy !== undefined;
}

function newMilestone(event: SelfEvent): MilestoneState
{
    return {
        id: String(event.payload.milestone),
        objective: String(event.payload.objective),
        outcome: String(event.payload.outcome),
        ts: event.ts,
        revision: 1,
        target: str(event.payload.target),
        exit: criteria(event.payload.exit),
        after: list(event.payload.after),
        coverage: [],
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

function reviseMilestone(milestone: MilestoneState, event: SelfEvent): void
{
    milestone.revision += 1;
    milestone.outcome = str(event.payload.outcome) ?? milestone.outcome;
    milestone.target = revised(event.payload.target, milestone.target);
    for (const id of list(event.payload.dropExit))
    {
        const criterion = milestone.exit.find((item) => item.id === id);
        if (criterion !== undefined)
        {
            criterion.dropped = true;
        }
    }
    milestone.exit.push(...criteria(event.payload.addExit));
}

function newCoverage(event: SelfEvent): Coverage
{
    return {
        criterion: String(event.payload.criterion),
        ts: event.ts,
        why: String(event.payload.why),
        work: event.refs?.work,
        commits: event.refs?.commits ?? [],
        objectiveRevision: Number(event.payload.objectiveRevision),
        milestoneRevision: Number(event.payload.milestoneRevision),
        recheck: event.type === "milestone.rechecked" ? true : undefined
    };
}

export function applyProposal(goals: GoalState, event: SelfEvent): void
{
    if (event.type === "work.proposed")
    {
        goals.proposals.push(newProposal(event));
        return;
    }
    const proposal = goals.proposals.find((item) => item.id === event.payload.proposal);
    if (proposal === undefined)
    {
        return;
    }
    // Answered once. A proposal that was accepted and then reaches a stale
    // decline from another clone's log keeps the answer that was given.
    if (proposal.status !== "open")
    {
        return;
    }
    if (event.type === "work.accepted")
    {
        proposal.status = "accepted";
        proposal.work = String(event.payload.work);
        return;
    }
    proposal.status = "declined";
    proposal.declinedWhy = str(event.payload.why);
}

function newProposal(event: SelfEvent): WorkProposal
{
    const payload = event.payload;
    return {
        id: event.id,
        ts: event.ts,
        outcome: String(payload.outcome),
        objective: str(payload.objective),
        milestone: str(payload.milestone),
        value: String(payload.value),
        success: list(payload.success),
        stop: list(payload.stop),
        depends: list(payload.depends),
        risk: String(payload.risk),
        capacity: String(payload.capacity),
        evidencePlan: String(payload.evidencePlan),
        confidence: String(payload.confidence),
        expires: String(payload.expires),
        status: "open",
        expired: false
    };
}

/* ── derivation ────────────────────────────────────────────────────── */

export function deriveGoals(goals: GoalState, works: LinkedWork[], now: Date, zone: string): string[]
{
    applySupersededObjectives(goals);
    const today = dayIn(now, zone);
    const signals: string[] = [];
    for (const objective of goals.objectives)
    {
        for (const milestone of objective.milestones)
        {
            deriveMilestone(milestone, objective, works, today);
        }
        markCriticalPath(objective.milestones);
        deriveObjective(objective, works, today);
        signals.push(...objectiveSignals(objective));
    }
    for (const proposal of goals.proposals)
    {
        proposal.expired = proposal.status === "open" && daysBetween(today, proposal.expires) < 0;
    }
    return signals;
}

function deriveMilestone(milestone: MilestoneState, objective: ObjectiveState, works: LinkedWork[], today: string): void
{
    const live = milestone.exit.filter((criterion) => criterion.dropped !== true);
    const covered = new Set(milestone.coverage.map((item) => item.criterion));
    milestone.met = live.filter((criterion) => covered.has(criterion.id)).map((criterion) => criterion.id);
    milestone.open = live.filter((criterion) => !covered.has(criterion.id)).map((criterion) => criterion.id);
    milestone.stale = staleCoverage(milestone, objective, new Set(live.map((criterion) => criterion.id)));
    const linked = works.filter((work) => work.milestones.includes(milestone.id));
    milestone.works = linked.map((work) => work.id);
    milestone.blockedWorks = linked.filter((work) => work.status === "blocked").map((work) => work.id);
    milestone.evidence = evidenceOf(milestone, linked);
    milestone.state = milestoneState(milestone, objective, today);
    milestone.reason = milestoneReason(milestone, live.length, today);
}

// A criterion may be judged more than once, and only the newest judgment is
// the one standing: an earlier entry stays on record as lineage without
// holding the milestone stale for ever. Coverage of a criterion the milestone
// has since dropped is history too — there is nothing left to re-judge.
function staleCoverage(milestone: MilestoneState, objective: ObjectiveState, live: Set<string>): Coverage[]
{
    const latest = new Map<string, Coverage>();
    for (const item of milestone.coverage)
    {
        latest.set(item.criterion, item);
    }
    return [...latest.values()].filter((item) => live.has(item.criterion)
        && (item.objectiveRevision !== objective.revision || item.milestoneRevision !== milestone.revision));
}

// Evidence rolls up by reference: two milestones covered by the same report
// name the same commits, and neither copies the report or the artifact.
function evidenceOf(milestone: MilestoneState, linked: LinkedWork[]): string[]
{
    const hashes = [...milestone.coverage.flatMap((item) => item.commits), ...linked.flatMap((work) => work.evidence)];
    return [...new Set(hashes)];
}

function milestoneState(milestone: MilestoneState, objective: ObjectiveState, today: string): TargetState
{
    if (milestone.reached !== undefined)
    {
        return "reached";
    }
    if (objective.status === "dropped" || objective.status === "superseded"
        || milestone.supersededBy !== undefined || milestone.droppedWhy !== undefined)
    {
        return "closed";
    }
    // Reached is checked above: a milestone whose evidence landed before anyone
    // dropped it keeps that verdict, and the drop verb refuses it anyway.
    if (milestone.target !== undefined && daysBetween(today, milestone.target) < 0)
    {
        return "missed";
    }
    if (milestone.blockedWorks.length > 0)
    {
        return "blocked";
    }
    if (milestone.target !== undefined && milestone.open.length > 0 && daysBetween(today, milestone.target) <= AT_RISK_DAYS)
    {
        return "at-risk";
    }
    return milestone.works.length === 0 ? "unstarted" : "on-track";
}

// Three ways a milestone ends without being reached, and the reader needs to
// know which one this was.
function closedMilestoneReason(milestone: MilestoneState, covered: string): string
{
    if (milestone.droppedWhy !== undefined)
    {
        return `dropped — ${milestone.droppedWhy}`;
    }
    return milestone.supersededBy === undefined
        ? `its objective is closed — ${covered}`
        : `superseded by ${milestone.supersededBy} — ${covered}`;
}

function milestoneReason(milestone: MilestoneState, total: number, today: string): string
{
    const covered = `${milestone.met.length} of ${total} exit criteria covered`;
    if (milestone.state === "reached")
    {
        return `reached ${milestone.reached?.ts.slice(0, 10)} on ${covered.replace(" covered", "")}, evidence ${milestone.evidence.length}`;
    }
    if (milestone.state === "closed")
    {
        return closedMilestoneReason(milestone, covered);
    }
    if (milestone.state === "missed")
    {
        return `target ${milestone.target} passed ${-daysBetween(today, milestone.target ?? today)} days ago with ${covered}`;
    }
    if (milestone.state === "blocked")
    {
        return `${milestone.blockedWorks.join(", ")} blocked with ${covered}`;
    }
    if (milestone.state === "at-risk")
    {
        return `${milestone.open.length} exit criteria still open ${daysBetween(today, milestone.target ?? today)} days before ${milestone.target}`;
    }
    return milestone.state === "unstarted" ? "no work linked yet" : `${covered} across ${milestone.works.length} work unit(s)`;
}

// A milestone is on the critical path when an unreached milestone waits on it,
// directly or through the chain — that is what makes a blocked work unit on it
// different from a blocked work unit anywhere else. A superseded milestone
// waits on nothing: its successor carries the order it used to hold.
function markCriticalPath(milestones: MilestoneState[]): void
{
    const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]));
    const waiting = (milestone: MilestoneState): boolean =>
        milestone.reached === undefined && milestone.supersededBy === undefined;
    const pending = milestones.filter(waiting).flatMap((milestone) => milestone.after);
    const seen = new Set<string>();
    while (pending.length > 0)
    {
        const id = pending.pop() as string;
        const milestone = byId.get(id);
        if (milestone === undefined || seen.has(id))
        {
            continue;
        }
        seen.add(id);
        milestone.criticalPath = waiting(milestone);
        pending.push(...milestone.after);
    }
}

function deriveObjective(objective: ObjectiveState, works: LinkedWork[], today: string): void
{
    const live = objective.milestones.filter((milestone) => milestone.supersededBy === undefined);
    objective.met = live.reduce((sum, milestone) => sum + milestone.met.length, 0);
    objective.total = live.reduce((sum, milestone) => sum + milestone.met.length + milestone.open.length, 0);
    objective.works = [...new Set([
        ...works.filter((work) => work.objectives.includes(objective.id)).map((work) => work.id),
        ...live.flatMap((milestone) => milestone.works)
    ])];
    objective.state = objectiveState(objective, live, today);
    objective.reason = objectiveReason(objective, live, today);
}

function closedObjectiveState(objective: ObjectiveState): TargetState | undefined
{
    if (objective.status === "reached")
    {
        return "reached";
    }
    return objective.status === "dropped" || objective.status === "superseded" ? "closed" : undefined;
}

function objectiveState(objective: ObjectiveState, live: MilestoneState[], today: string): TargetState
{
    const closed = closedObjectiveState(objective);
    if (closed !== undefined)
    {
        return closed;
    }
    const has = (state: TargetState): boolean => live.some((milestone) => milestone.state === state);
    // Every checkpoint landed, so a date that has since passed missed nothing —
    // the objective is waiting to be closed, not late.
    const landed = live.length > 0 && live.every((milestone) => milestone.state === "reached");
    const late = objective.target !== undefined && daysBetween(today, objective.target) < 0;
    if (!landed && (late || has("missed")))
    {
        return "missed";
    }
    if (has("blocked"))
    {
        return "blocked";
    }
    const near = objective.target !== undefined && daysBetween(today, objective.target) <= AT_RISK_DAYS;
    if (has("at-risk") || (near && objective.met < objective.total))
    {
        return "at-risk";
    }
    // Unstarted means nothing has happened yet. Coverage cited without a work
    // unit, or a milestone already reached, is progress and must not read empty.
    const moved = objective.works.length > 0 || objective.met > 0 || has("reached");
    return moved ? "on-track" : "unstarted";
}

function objectiveReason(objective: ObjectiveState, live: MilestoneState[], today: string): string
{
    const reached = live.filter((milestone) => milestone.state === "reached").length;
    const covered = `${reached} of ${live.length} milestones reached, ${objective.met} of ${objective.total} exit criteria covered`;
    if (objective.state === "closed")
    {
        return `${objective.status}${objective.closedWhy === undefined ? "" : ` — ${objective.closedWhy}`}`;
    }
    if (objective.state === "reached")
    {
        return `reached — ${covered}`;
    }
    if (objective.state === "missed" && objective.target !== undefined && daysBetween(today, objective.target) < 0)
    {
        return `target ${objective.target} passed with ${covered}`;
    }
    const worst = live.find((milestone) => milestone.state === objective.state);
    return worst === undefined ? covered : `${worst.id}: ${worst.reason}`;
}

// A judgment is made against the revisions current when it was made, so a later
// revision can widen what the milestone asks for. Saying the judgment is stale
// beats letting a settled "covered" or "reached" stand for criteria it never
// saw. A re-judgment recorded since is the one that counts.
function staleJudgmentSignals(objective: ObjectiveState, milestone: MilestoneState): string[]
{
    const signals = milestone.stale.map((stale) =>
        `${milestone.id} coverage of ${stale.criterion} was judged against ${objective.id} revision ` +
        `${stale.objectiveRevision}/${stale.milestoneRevision}, now ${objective.revision}/${milestone.revision} — ` +
        `recheck it with \`self milestone recheck ${milestone.id} --criterion ${stale.criterion} --why "<what you re-judged>"\``);
    const reached = milestone.reaffirmed ?? milestone.reached;
    if (reached !== undefined
        && (reached.objectiveRevision !== objective.revision || reached.milestoneRevision !== milestone.revision))
    {
        signals.push(`${milestone.id} was reached against ${objective.id} revision ` +
            `${reached.objectiveRevision}/${reached.milestoneRevision}, now ${objective.revision}/${milestone.revision} — ` +
            `recheck it with \`self milestone recheck ${milestone.id} --why "<what you re-judged>"\``);
    }
    return signals;
}

function milestoneStateSignals(milestone: MilestoneState): string[]
{
    if (milestone.state === "missed")
    {
        return [`${milestone.id} missed its target — ${milestone.reason}`];
    }
    if (milestone.state === "at-risk")
    {
        return [`${milestone.id} is at risk — ${milestone.reason}`];
    }
    return milestone.state === "blocked" && milestone.criticalPath
        ? [`${milestone.id} is on the critical path and ${milestone.reason}`]
        : [];
}

function objectiveSignals(objective: ObjectiveState): string[]
{
    if (objective.status !== "active")
    {
        return [];
    }
    // A superseded milestone asks nothing of anyone: its successor carries
    // whatever is still owed, so neither its coverage nor its reach is work the
    // reader can act on.
    return objective.milestones
        .filter((milestone) => milestone.supersededBy === undefined)
        .flatMap((milestone) => [
            ...staleJudgmentSignals(objective, milestone),
            ...milestoneStateSignals(milestone)
        ]);
}

/* ── lookup ────────────────────────────────────────────────────────── */

export function findMilestone(goals: GoalState, id: string): { objective: ObjectiveState; milestone: MilestoneState } | null
{
    for (const objective of goals.objectives)
    {
        const milestone = objective.milestones.find((item) => item.id === id);
        if (milestone !== undefined)
        {
            return { objective, milestone };
        }
    }
    return null;
}

export function allMilestones(goals: GoalState): MilestoneState[]
{
    return goals.objectives.flatMap((objective) => objective.milestones);
}

export function openObjectives(goals: GoalState): ObjectiveState[]
{
    return goals.objectives.filter((objective) => objective.status === "active" || objective.status === "proposed");
}

export function openProposals(goals: GoalState): WorkProposal[]
{
    return goals.proposals.filter((proposal) => proposal.status === "open" && !proposal.expired);
}

interface Contribution
{
    kind: "objective" | "milestone";
    id: string;
    outcome: string;
    state: TargetState;
    criticalPath: boolean;
}

// What a work unit contributes to, resolved to names so every surface can
// show the relationship without re-walking the goal tree.
export function contributionsOf(goals: GoalState, work: { objectives: string[]; milestones: string[] }): Contribution[]
{
    const objectives = work.objectives
        .map((id) => goals.objectives.find((item) => item.id === id))
        .filter((item): item is ObjectiveState => item !== undefined)
        .map((item) => ({ kind: "objective" as const, id: item.id, outcome: item.outcome, state: item.state, criticalPath: false }));
    const milestones = work.milestones
        .map((id) => findMilestone(goals, id)?.milestone)
        .filter((item): item is MilestoneState => item !== undefined)
        .map((item) => ({ kind: "milestone" as const, id: item.id, outcome: item.outcome, state: item.state, criticalPath: item.criticalPath }));
    return [...objectives, ...milestones];
}

/* ── payload helpers ───────────────────────────────────────────────── */

function str(value: unknown): string | undefined
{
    return value === undefined || value === null ? undefined : String(value);
}

// A revision distinguishes three things a payload can say about a field: an
// absent key leaves it alone, a value replaces it, and an explicit null
// withdraws it — which is how a target date or a horizon is taken back.
function revised(value: unknown, current: string | undefined): string | undefined
{
    return value === null ? undefined : str(value) ?? current;
}

function list(value: unknown): string[]
{
    return Array.isArray(value) ? value.map(String) : [];
}

function criteria(value: unknown): Criterion[]
{
    return Array.isArray(value) ? value.map((item) => ({ id: String(item.id), text: String(item.text) })) : [];
}
