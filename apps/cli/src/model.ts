import { DEFAULT_ZONE } from "./dates.js";
import { readEvents } from "./logfile.js";
import { applyMilestone, applyObjective, applyProposal, deriveGoals, emptyGoals, GoalState } from "./objectives.js";
import { readRegistry, readStoreConfig } from "./paths.js";
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
    status: "proposed" | "confirmed" | "superseded";
    humanConfirmed: boolean;
    expired: boolean;
    supersedes: string[];
    // The work unit this decision came out of, when the command said so.
    // Never inferred: a decision recorded during one unit's session is not
    // thereby a decision about it.
    work?: string;
}

export interface ReportEntry
{
    ts: string;
    text: string;
    commits: string[];
    artifacts: ArtifactMeta[];
    // The branch these commits were reported from — what lets the fold tell a
    // discarded branch from a squash-merged one.
    branch?: string;
}

// The sanitized shadow of a machine-local attempt: enough for any clone to
// say what ran and how it ended, with nothing a machine must keep to itself.
export interface AttemptSummary
{
    id: string;
    ts: string;
    runtime: string;
    kind: string;
    phase: "registered" | "running" | "waiting" | "settled" | "cancelled" | "refused";
    verdict?: string;
    detail?: string;
    outputs: string[];
    needsApproval: boolean;
}

// An acceptance criterion a passing attempt has to have covered. Ids are
// stable across edits so an attempt registered yesterday can still say which
// criteria it set out to satisfy.
export interface Requirement
{
    id: string;
    text: string;
    // The work revision that introduced this criterion, so an attempt that
    // predates it can be told apart from one that ignored it.
    since: number;
}

export interface WorkState
{
    id: string;
    outcome: string;
    ts: string;
    lastEventTs: string;
    status: "next" | "active" | "blocked" | "done";
    blockedOn?: string;
    blockedWhy?: string;
    // Bumped whenever what the unit asks for changes. An attempt carries the
    // revision it was registered against; a mismatch at settlement means the
    // specification moved under the run and its coverage cannot be trusted.
    revision: number;
    requirements: Requirement[];
    designRevision: number | null;
    reports: ReportEntry[];
    evidence: string[];
    artifacts: ArtifactMeta[];
    // Every branch this unit was worked on, oldest first. Derived, never
    // asserted: one unit runs on several branches, and one branch carries
    // several units.
    branches: string[];
    attempts: AttemptSummary[];
    next?: string;
    // The outcomes this unit contributes to. Stated by `self work link`, never
    // inferred: one unit may serve several objectives, and a milestone is
    // satisfied by evidence, not by a unit reaching done.
    objectives: string[];
    milestones: string[];
}

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
    conventions: { id: string; ts: string; text: string }[];
    works: WorkState[];
    openQuestions: string[];
    health: string[];
}

export function buildModel(storeDir: string, slug: string, now: Date): ProjectModel
{
    const entry = readRegistry(storeDir).find((item) => item.slug === slug);
    const model: ProjectModel = {
        slug,
        description: entry?.description,
        zone: readStoreConfig(storeDir).timezone ?? DEFAULT_ZONE,
        goals: emptyGoals(),
        decisions: [],
        conventions: [],
        works: [],
        openQuestions: [],
        health: []
    };
    for (const event of readEvents(storeDir, slug))
    {
        applyEvent(model, event);
    }
    deriveSignals(model, now);
    return model;
}

function applyEvent(model: ProjectModel, event: SelfEvent): void
{
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
    if (event.type.startsWith("attempt."))
    {
        applyAttempt(model, event);
        return;
    }
    if (event.type === "convention.added")
    {
        model.conventions.push({ id: event.id, ts: event.ts, text: String(event.payload.text) });
        return;
    }
    if (event.type === "convention.dropped")
    {
        const dropped = event.refs?.supersedes ?? [];
        model.conventions = model.conventions.filter((convention) => !dropped.includes(convention.id));
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
    if (event.type !== "decision.confirmed")
    {
        return;
    }
    const confirms = event.refs?.confirms;
    if (confirms === undefined)
    {
        applySupersedes(model, event.refs?.supersedes ?? []);
        model.decisions.push(newDecision(event, "confirmed", event.origin.confirmed));
        return;
    }
    const target = model.decisions.find((decision) => decision.id === confirms);
    if (target !== undefined && target.status === "proposed")
    {
        applySupersedes(model, target.supersedes);
        target.status = "confirmed";
        target.humanConfirmed = event.origin.confirmed;
        target.ts = event.ts;
    }
}

function applySupersedes(model: ProjectModel, ids: string[]): void
{
    for (const id of ids)
    {
        const target = model.decisions.find((decision) => decision.id === id);
        if (target !== undefined)
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
        work: event.refs?.work
    };
}

// Events written before branches were recorded carry none; absence reads as
// unknown, so the whole log stays foldable.
function branchOf(event: SelfEvent): string[]
{
    return event.refs?.branch === undefined ? [] : [event.refs.branch];
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
            revision: 1,
            requirements: [],
            designRevision: null,
            reports: [],
            evidence: [],
            artifacts: [],
            branches: branchOf(event),
            objectives: [],
            milestones: [],
            attempts: []
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
    if (event.type === "work.linked" || event.type === "work.unlinked")
    {
        applyLink(work, event);
        return;
    }
    if (applyRequirement(work, event))
    {
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

// Changing what a unit asks for is a revision, and the revision is what an
// attempt's coverage claim is checked against. Approving a design is recorded
// the same way so a run cannot claim to implement a design nobody approved.
function applyRequirement(work: WorkState, event: SelfEvent): boolean
{
    if (event.type === "work.requirement.added")
    {
        work.revision += 1;
        work.requirements.push({
            id: String(event.payload.requirement),
            text: String(event.payload.text),
            since: work.revision
        });
        return true;
    }
    if (event.type === "work.requirement.dropped")
    {
        work.revision += 1;
        work.requirements = work.requirements.filter((item) => item.id !== String(event.payload.requirement));
        return true;
    }
    if (event.type === "work.design.approved")
    {
        work.designRevision = Number(event.payload.designRevision);
        return true;
    }
    return false;
}

const ATTEMPT_PHASES: Record<string, AttemptSummary["phase"]> = {
    "attempt.registered": "registered",
    "attempt.started": "running",
    "attempt.waiting": "waiting",
    "attempt.awaiting-review": "waiting",
    "attempt.approved": "registered",
    "attempt.settled": "settled",
    "attempt.cancelled": "cancelled",
    "attempt.refused": "refused"
};

// Attempt events are the physical half of the record: they say a process ran
// and how it ended, and never that the work is done. Only work.done says
// that, and only the supervisor's gates let it be written.
function applyAttempt(model: ProjectModel, event: SelfEvent): void
{
    const work = model.works.find((item) => item.id === event.refs?.work);
    const id = event.payload.attempt === undefined ? undefined : String(event.payload.attempt);
    const phase = ATTEMPT_PHASES[event.type];
    if (work === undefined || id === undefined || phase === undefined)
    {
        return;
    }
    work.lastEventTs = event.ts;
    noteBranch(work, event);
    const existing = work.attempts.find((attempt) => attempt.id === id);
    const summary: AttemptSummary = existing ?? {
        id,
        ts: event.ts,
        runtime: String(event.payload.runtime ?? "unknown"),
        kind: String(event.payload.kind ?? "implementation"),
        phase,
        outputs: [],
        needsApproval: false
    };
    summary.phase = phase;
    if (event.type === "attempt.registered")
    {
        summary.needsApproval = event.payload.needsApproval === true;
        summary.outputs = Array.isArray(event.payload.declared) ? event.payload.declared.map(String) : [];
    }
    if (event.type === "attempt.approved")
    {
        summary.needsApproval = false;
    }
    if (event.type === "attempt.settled")
    {
        summary.verdict = String(event.payload.verdict);
        summary.outputs = Object.keys((event.payload.hashes ?? {}) as Record<string, string>);
    }
    if (typeof event.payload.text === "string" && phase !== "registered")
    {
        summary.detail = event.payload.text;
    }
    if (existing === undefined)
    {
        work.attempts.push(summary);
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
    const commits = event.refs?.commits ?? [];
    const artifacts = Array.isArray(event.payload.artifacts) ? event.payload.artifacts as ArtifactMeta[] : [];
    work.reports.push({ ts: event.ts, text: String(event.payload.text), commits, artifacts, branch: event.refs?.branch });
    work.evidence.push(...commits.filter((commit) => !work.evidence.includes(commit)));
    work.artifacts.push(...artifacts);
    if (event.payload.next !== undefined)
    {
        work.next = String(event.payload.next);
    }
}

function deriveSignals(model: ProjectModel, now: Date): void
{
    model.health.push(...deriveGoals(model.goals, model.works, now, model.zone));
    for (const objective of model.goals.objectives.filter((item) => item.status === "proposed"))
    {
        model.openQuestions.push(`objective ${objective.id} is proposed and not confirmed: ${objective.outcome}`);
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
        if (work.status === "blocked" && work.blockedOn === "decision")
        {
            model.openQuestions.push(`${work.id} is waiting on a decision: ${work.blockedWhy ?? work.outcome}`);
        }
        if (work.status === "active" && ageDays(work.lastEventTs, now) > STALL_DAYS)
        {
            const days = Math.floor(ageDays(work.lastEventTs, now));
            model.health.push(`${work.id} looks stalled — no events for ${days} days`);
        }
        deriveAttemptSignals(model, work);
    }
}

// An attempt that ran while nobody was watching is only useful if what it is
// now waiting for reaches the next session that opens.
function deriveAttemptSignals(model: ProjectModel, work: WorkState): void
{
    for (const attempt of work.attempts)
    {
        if (attempt.needsApproval && attempt.phase !== "settled" && attempt.phase !== "cancelled")
        {
            model.openQuestions.push(`${work.id} attempt ${attempt.id} is waiting on your approval — \`self attempt approve ${attempt.id}\``);
        }
        if (attempt.phase === "waiting")
        {
            model.openQuestions.push(attempt.detail ?? `${work.id} attempt ${attempt.id} is waiting`);
        }
        if (attempt.phase === "refused")
        {
            model.openQuestions.push(attempt.detail ?? `${work.id} attempt ${attempt.id} proposed a refused action`);
        }
        if (attempt.verdict === "failed" || attempt.verdict === "stale")
        {
            model.health.push(attempt.detail ?? `${work.id} attempt ${attempt.id} ended ${attempt.verdict}`);
        }
    }
}

function ageDays(ts: string, now: Date): number
{
    return (now.getTime() - new Date(ts).getTime()) / 86_400_000;
}
