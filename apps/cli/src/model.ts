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
import { looksLikeLegacyRevision } from "./gitutil.js";
import { applyIntegration, deriveIntegration, emptyIntegration, IntegrationState, isIntegrationEvent } from "./integration.js";
import { readEvents } from "./logfile.js";
import { applyMilestone, applyObjective, applyProposal, deriveGoals, emptyGoals, GoalState } from "./objectives.js";
import { readRegistry, readStoreConfig, readVerdicts, Verdict } from "./paths.js";
import { ArtifactMeta, SelfEvent } from "./types.js";

const PROPOSAL_EXPIRY_DAYS = 14;
const STALL_DAYS = 3;
// How long a failed attempt stays a health signal. Past this it is history
// that `self work show` still carries, not something the person can act on.
export const ATTEMPT_FAILURE_DAYS = 7;

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
    // The work units this decision gates, as `decide --blocks` stated them.
    // Empty for every decision recorded before the ref existed, which is what
    // keeps such a decision unclassified rather than falsely settled.
    blocks: string[];
    // The event this decision is sequenced behind.
    after?: string;
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

// One thing that waits on the human. `full` is the sentence shown while space
// allows; when the context budget forces the short form, `identity` still
// names the item and `recovery` is the command that prints its full state.
export interface WaitingItem
{
    full: string;
    identity: string;
    recovery: string;
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
    conventions: { id: string; ts: string; text: string }[];
    works: WorkState[];
    // The repository integration lane. Parallel work is recorded above; the
    // order it reaches main in is recorded here.
    integration: IntegrationState;
    openQuestions: string[];
    // The same items as openQuestions, with the identity and recovery command
    // each renderer needs when it cannot afford the full sentence. Derived at
    // one site so the two lists can never disagree.
    waiting: WaitingItem[];
    // The live proposals, ranked by what confirming each one would do. Derived
    // here rather than in a renderer, so every surface reads one grouping.
    attention: AttentionBand;
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
        integration: emptyIntegration(),
        openQuestions: [],
        waiting: [],
        attention: { unblocks: [], undecidable: [], inEffect: [] },
        health: []
    };
    for (const event of readEvents(storeDir, slug))
    {
        applyEvent(model, event);
    }
    deriveSignals(model, now);
    // Read once per fold, not once per row: the verdicts are a file, and a fold
    // runs on every event.
    deriveAttention(model, readVerdicts(storeDir, slug));
    return model;
}

function applyEvent(model: ProjectModel, event: SelfEvent): void
{
    if (isIntegrationEvent(event.type))
    {
        applyIntegration(model.integration, event);
        // A receipt bound to a change set that names a work unit is also a
        // statement about that unit, and the fresh-session policy is judged on
        // it. The receipt stays the lane's — this only projects it.
        const reviewed = event.type === "review.received" ? model.works.find((item) => item.id === event.refs?.work) : undefined;
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
        work: event.refs?.work,
        // Coerced, never trusted: these refs arrive from clones written by
        // versions that did not have them and by machines this one never saw.
        blocks: stringList(event.refs?.blocks),
        after: event.refs?.after === undefined ? undefined : String(event.refs.after)
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
    work.reports.push({ id: event.id, ts: event.ts, text: String(event.payload.text), commits, notes, artifacts, branch: event.refs?.branch });
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
    model.health.push(...deriveIntegration(model.integration, now));
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
        // Derived for every unit, including the ones already done: a unit
        // closed before a requirement was revised still says what it owes.
        work.owes = completionRefusal(work) ?? undefined;
        if (work.status !== "done" && work.status !== "retired" && approvalPending(work))
        {
            noteWaiting(model, {
                full: `${work.id} is waiting on human approval: ${work.completion.approvalRequired?.why ?? work.outcome}`,
                identity: `approval wait on ${work.id}`,
                recovery: `self work show ${work.id}`
            });
        }
        if (work.status === "blocked" && work.blockedOn === "decision")
        {
            noteWaiting(model, {
                full: `${work.id} is waiting on a decision: ${work.blockedWhy ?? work.outcome}`,
                identity: `blocked work ${work.id}`,
                recovery: `self work show ${work.id}`
            });
        }
        if (work.status === "active" && ageDays(work.lastEventTs, now) > STALL_DAYS)
        {
            const days = Math.floor(ageDays(work.lastEventTs, now));
            model.health.push(`${work.id} looks stalled — no events for ${days} days`);
        }
        deriveAttemptSignals(model, work, now);
    }
}

// A blocked attempt is a request for a grant, so it belongs where the person
// looks for what is waiting on them. A failed one is a health signal: nothing
// is asked of anybody, but the work did not advance.
//
// Only the newest attempt speaks, and only while the unit is still open. An
// attempt id is never reused, so a later attempt on the same unit is the
// answer to the earlier one — the grant was given, or the failure was retried
// — and nothing in an append-only log ever goes back to unblock a past
// attempt. Every other signal here is either current state or age-gated;
// without this these two would be the only ones that can only grow.
function deriveAttemptSignals(model: ProjectModel, work: WorkState, now: Date): void
{
    const latest = work.status === "done" || work.status === "retired" ? undefined : newestAttempt(work);
    if (latest === undefined)
    {
        return;
    }
    if (latest.state === "blocked")
    {
        noteWaiting(model, {
            full: `${work.id} attempt ${latest.id} is waiting on a capability grant: ${latest.detail ?? "see `self attempt show`"}`,
            identity: `blocked attempt ${latest.id} on ${work.id}`,
            recovery: `self attempt show ${latest.id}`
        });
    }
    if (latest.state === "failed" && ageDays(latest.ts, now) <= ATTEMPT_FAILURE_DAYS)
    {
        model.health.push(`${work.id} attempt ${latest.id} failed (${latest.failure ?? "unknown"})${latest.detail === undefined ? "" : ` — ${latest.detail}`}`);
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

// The single site that answers "what waits on a person": every renderer reads
// either list, so an item can never appear in one and be missing from the other.
function noteWaiting(model: ProjectModel, item: WaitingItem): void
{
    model.openQuestions.push(item.full);
    model.waiting.push(item);
}

function newestAttempt(work: WorkState): AttemptSummary | undefined
{
    return work.attempts.reduce<AttemptSummary | undefined>(
        (newest, attempt) => newest === undefined || attempt.ts >= newest.ts ? attempt : newest,
        undefined
    );
}

function ageDays(ts: string, now: Date): number
{
    return (now.getTime() - new Date(ts).getTime()) / 86_400_000;
}
