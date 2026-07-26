import { readEvents } from "./logfile.js";
import { readRegistry } from "./paths.js";
import { ArtifactMeta, SelfEvent } from "./types.js";

const PROPOSAL_EXPIRY_DAYS = 14;
const STALL_DAYS = 3;

// Priority orders the queue; lower runs sooner. Everything starts level so
// that reprioritizing one directive never silently reorders the rest.
export const DEFAULT_PRIORITY = 100;

// How a captured directive relates to the work it was routed to. "new" mints a
// unit; the rest attach to one that already exists; "dropped" routes it to
// nothing on purpose, which is still a routing decision and still recorded.
export type LinkKind =
    | "new"
    | "addition"
    | "supersession"
    | "cancellation"
    | "reprioritization"
    | "status"
    | "dropped";

export interface CaptureLink
{
    kind: LinkKind;
    ts: string;
    work?: string;
    why?: string;
}

// The immutable directive as the user submitted it. Interpretation lives in
// `link`, which is folded from a separate event, so re-reading the raw input
// is always possible however often the reading of it changes.
export interface CaptureState
{
    id: string;
    text: string;
    ts: string;
    source?: string;
    key?: string;
    link?: CaptureLink;
}

export interface Lease
{
    id: string;
    worker: string;
    ts: string;
    expires: string;
}

export interface CaptureNote
{
    ts: string;
    capture: string;
    text: string;
}

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

export interface WorkState
{
    id: string;
    outcome: string;
    ts: string;
    lastEventTs: string;
    status: "next" | "active" | "blocked" | "done" | "cancelled";
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
    priority: number;
    // Work units that must be done before this one may be leased.
    dependsOn: string[];
    approval?: { why: string; granted: boolean };
    lease?: Lease;
    // Later directives that widened this unit, and requests for its status,
    // each pointing back at the capture that carried them.
    additions: CaptureNote[];
    statusRequests: CaptureNote[];
    // Derived below from dependencies, approval, and the clock: never stored,
    // so a dependency finishing wakes its dependents with no extra event and a
    // restart re-reads the same answer.
    waiting?: "dependency" | "approval";
    ready: boolean;
    leaseExpired: boolean;
}

// Work that no longer belongs to any queue: finished, or cancelled by a
// directive that overtook it.
export function isClosed(work: WorkState): boolean
{
    return work.status === "done" || work.status === "cancelled";
}

// Ready work, most urgent first: priority decides, and among equals the
// directive that arrived first runs first, so a busy queue stays fair.
export function queueOrder(model: ProjectModel): WorkState[]
{
    return model.works
        .filter((work) => work.ready)
        .sort((a, b) => a.priority - b.priority || a.ts.localeCompare(b.ts));
}

export interface ProjectModel
{
    slug: string;
    description?: string;
    goal?: string;
    decisions: DecisionState[];
    conventions: { id: string; ts: string; text: string }[];
    works: WorkState[];
    captures: CaptureState[];
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
        captures: [],
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
    if (event.type.startsWith("capture."))
    {
        applyCapture(model, event);
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
        model.works.push(newWork(event));
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
        work.lease = undefined;
    }
    applySchedule(work, event);
}

function newWork(event: SelfEvent): WorkState
{
    return {
        id: String(event.payload.work),
        outcome: String(event.payload.outcome),
        ts: event.ts,
        lastEventTs: event.ts,
        status: "next",
        reports: [],
        evidence: [],
        artifacts: [],
        branches: branchOf(event),
        priority: DEFAULT_PRIORITY,
        dependsOn: [],
        additions: [],
        statusRequests: [],
        ready: false,
        leaseExpired: false
    };
}

// The scheduling half of a work unit's life: who holds it, what it waits on,
// and where it sits in the queue.
function applySchedule(work: WorkState, event: SelfEvent): void
{
    if (event.type === "work.leased")
    {
        work.status = "active";
        work.lease = {
            id: String(event.payload.lease),
            worker: String(event.payload.worker),
            ts: event.ts,
            expires: String(event.payload.expires)
        };
    }
    if (event.type === "work.heartbeat" && work.lease !== undefined)
    {
        work.lease.expires = String(event.payload.expires);
    }
    if (event.type === "work.released")
    {
        work.status = "next";
        work.lease = undefined;
    }
    if (event.type === "work.cancelled")
    {
        work.status = "cancelled";
        work.lease = undefined;
    }
    applyWaits(work, event);
}

function applyWaits(work: WorkState, event: SelfEvent): void
{
    if (event.type === "work.prioritized")
    {
        work.priority = Number(event.payload.priority);
    }
    if (event.type === "work.depends")
    {
        const on = Array.isArray(event.payload.on) ? event.payload.on.map(String) : [];
        work.dependsOn.push(...on.filter((id) => !work.dependsOn.includes(id)));
    }
    if (event.type === "work.approval.required")
    {
        work.approval = { why: String(event.payload.why), granted: false };
    }
    if (event.type === "work.approved" && work.approval !== undefined)
    {
        work.approval.granted = true;
    }
    if (event.type === "work.outcome.changed")
    {
        work.outcome = String(event.payload.outcome);
    }
}

function applyCapture(model: ProjectModel, event: SelfEvent): void
{
    if (event.type === "capture.recorded")
    {
        model.captures.push({
            id: String(event.payload.capture),
            text: String(event.payload.text),
            ts: event.ts,
            source: event.payload.source === undefined ? undefined : String(event.payload.source),
            key: event.payload.key === undefined ? undefined : String(event.payload.key)
        });
        return;
    }
    const capture = model.captures.find((item) => item.id === event.payload.capture);
    if (capture === undefined || event.type !== "capture.linked")
    {
        return;
    }
    const link: CaptureLink = {
        kind: event.payload.as as LinkKind,
        ts: event.ts,
        work: event.refs?.work,
        why: event.payload.why === undefined ? undefined : String(event.payload.why)
    };
    capture.link = link;
    noteOnWork(model, capture, link);
}

// An addition and a status request change nothing about the unit's lifecycle;
// they are the relation itself, so the fold reads them off the capture rather
// than duplicating the text into another event.
function noteOnWork(model: ProjectModel, capture: CaptureState, link: CaptureLink): void
{
    const work = model.works.find((item) => item.id === link.work);
    if (work === undefined)
    {
        return;
    }
    const note: CaptureNote = { ts: link.ts, capture: capture.id, text: capture.text };
    if (link.kind === "addition")
    {
        work.additions.push(note);
    }
    if (link.kind === "status")
    {
        work.statusRequests.push(note);
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
    deriveQueue(model, now);
    for (const work of model.works)
    {
        if (work.status === "blocked" && work.blockedOn === "decision")
        {
            model.openQuestions.push(`${work.id} is waiting on a decision: ${work.blockedWhy ?? work.outcome}`);
        }
        if (work.status === "active" && !work.leaseExpired && ageDays(work.lastEventTs, now) > STALL_DAYS)
        {
            const days = Math.floor(ageDays(work.lastEventTs, now));
            model.health.push(`${work.id} looks stalled — no events for ${days} days`);
        }
        askedOf(work, model);
    }
}

// Eligibility is recomputed from the log and the clock on every read, so a
// dependency reaching done wakes its dependents without an event of their own
// and a restarted process reaches the same answer as the one that died.
function deriveQueue(model: ProjectModel, now: Date): void
{
    const done = new Set(model.works.filter((work) => work.status === "done").map((work) => work.id));
    for (const work of model.works)
    {
        work.leaseExpired = work.status === "active"
            && work.lease !== undefined
            && new Date(work.lease.expires).getTime() <= now.getTime();
        work.waiting = waitingReason(work, done);
        work.ready = work.status === "next" && work.waiting === undefined;
        if (work.leaseExpired && work.lease !== undefined)
        {
            model.health.push(`${work.id} lease held by ${work.lease.worker} expired — run \`self work recover\` to requeue it`);
        }
        if (work.waiting === "approval" && work.approval !== undefined)
        {
            model.openQuestions.push(`${work.id} needs your approval: ${work.approval.why}`);
        }
    }
}

function waitingReason(work: WorkState, done: Set<string>): "dependency" | "approval" | undefined
{
    if (work.approval !== undefined && !work.approval.granted)
    {
        return "approval";
    }
    return work.dependsOn.some((id) => !done.has(id)) ? "dependency" : undefined;
}

// A status request stays open until a report lands after it was asked: the
// answer to "where is this" is a report, not an acknowledgement.
function askedOf(work: WorkState, model: ProjectModel): void
{
    for (const request of work.statusRequests)
    {
        if (!work.reports.some((report) => report.ts > request.ts))
        {
            model.openQuestions.push(`${work.id} was asked for status: ${firstLine(request.text)}`);
        }
    }
}

function firstLine(text: string): string
{
    const line = text.split("\n", 1)[0];
    return line.length <= 120 ? line : line.slice(0, 119) + "…";
}

function ageDays(ts: string, now: Date): number
{
    return (now.getTime() - new Date(ts).getTime()) / 86_400_000;
}
