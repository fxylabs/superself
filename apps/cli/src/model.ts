import { readEvents } from "./logfile.js";
import { readRegistry } from "./paths.js";
import { ArtifactMeta, SelfEvent } from "./types.js";

const PROPOSAL_EXPIRY_DAYS = 14;
const STALL_DAYS = 3;

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

export interface WorkState
{
    id: string;
    outcome: string;
    ts: string;
    lastEventTs: string;
    status: "next" | "active" | "blocked" | "done";
    blockedOn?: string;
    blockedWhy?: string;
    reports: ReportEntry[];
    evidence: string[];
    artifacts: ArtifactMeta[];
    // Every branch this unit was worked on, oldest first. Derived, never
    // asserted: one unit runs on several branches, and one branch carries
    // several units.
    branches: string[];
    next?: string;
}

export interface ProjectModel
{
    slug: string;
    description?: string;
    goal?: string;
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
        supersedes: event.refs?.supersedes ?? []
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
            reports: [],
            evidence: [],
            artifacts: [],
            branches: branchOf(event)
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
    }
}

function ageDays(ts: string, now: Date): number
{
    return (now.getTime() - new Date(ts).getTime()) / 86_400_000;
}
