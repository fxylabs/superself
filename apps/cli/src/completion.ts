import { SelfEvent } from "./types.js";

// Semantic completion, kept apart from physical completion.
//
// An attempt that passes its completion gate has produced a verified result and
// freed the work unit it held. That is the whole of what settlement says. It
// does not say the work is done: what a unit had to cover, who had to approve
// it, and what had to review it are statements about the outcome, and none of
// them can be read off an exit code, a published artifact, or an agent's prose.
//
// So `work.done` is its own event, admitted by one check that every caller
// reaches — `self work done` before it records, and the runner and the daemon
// where they settle, which is where a person finds out what the unit still
// owes. Nothing here is inferred from a transition.
//
// The requirement surface mirrors the milestone exit criterion it is the work
// layer's counterpart of: declare, revise, retire, `met --requirement --why`,
// and `recheck` for what a revision left stale. One vocabulary, two layers.

export interface Requirement
{
    id: string;
    text: string;
    // Bumped by every restatement. Coverage records the revision it judged, so
    // a requirement that changed reads as uncovered until it is judged again.
    revision: number;
    retired?: boolean;
}

// What a requirement was covered by, and the revision it was judged against.
// The evidence is named by reference — a commit, an artifact, or a report the
// work unit already carries — never copied.
export interface RequirementCoverage
{
    requirement: string;
    ts: string;
    why: string;
    revision: number;
    commits: string[];
    artifacts: string[];
    report?: string;
    recheck?: boolean;
}

// An approval is human only when the event carries the record of how the human
// was verified. `origin.confirmed` alone is a bit any process can set; the
// confirmation method is the typed input the gate actually read.
export interface WorkApproval
{
    id: string;
    ts: string;
    by: string;
    humanConfirmed: boolean;
    method?: string;
}

// What the implementation of this unit has to have been, beyond producing a
// result. Both halves are about who did the work rather than about what came
// out of it, which is why no gate over the output can enforce them.
export interface CompletionPolicy
{
    ts: string;
    // The model class an implementation attempt must have run under.
    model?: string;
    // Whether a review receipt from a session other than the implementing
    // attempt's has to exist before this unit may be closed.
    freshReview: boolean;
    why?: string;
}

// A review receipt that named this work unit. Ingested through
// `self review ingest` like every other receipt — this is the projection of it
// onto the work, not a second way to mint one.
export interface WorkReview
{
    receipt: string;
    ts: string;
    verdict: string;
    model: string;
    session?: string;
}

export interface CompletionState
{
    requirements: Requirement[];
    coverage: RequirementCoverage[];
    approvalRequired?: { ts: string; why?: string };
    approvals: WorkApproval[];
    policy?: CompletionPolicy;
    reviews: WorkReview[];
    // Derived below: live requirements that carry coverage, live requirements
    // that carry none, and coverage judged against a revision that has moved.
    covered: string[];
    open: string[];
    stale: RequirementCoverage[];
}

export function emptyCompletion(): CompletionState
{
    return { requirements: [], coverage: [], approvals: [], reviews: [], covered: [], open: [], stale: [] };
}

// What the completion check reads about a work unit. Kept structural rather
// than importing WorkState, so the check stays a function of the fold instead
// of a second consumer of the model's shape.
export interface Completable
{
    id: string;
    completion: CompletionState;
    attempts: { id: string; state: string; model?: string }[];
}

/* ── fold ──────────────────────────────────────────────────────────── */

const COMPLETION_EVENTS = [
    "work.required", "work.requirement-revised", "work.requirement-retired",
    "work.covered", "work.rechecked", "work.approval-required", "work.approved", "work.policy-declared"
];

export function isCompletionEvent(type: string): boolean
{
    return COMPLETION_EVENTS.includes(type);
}

export function applyCompletion(state: CompletionState, event: SelfEvent): void
{
    if (event.type === "work.required")
    {
        state.requirements.push({ id: String(event.payload.requirement), text: String(event.payload.text), revision: 1 });
        return;
    }
    if (event.type === "work.approval-required")
    {
        state.approvalRequired = { ts: event.ts, why: str(event.payload.why) };
        return;
    }
    if (event.type === "work.approved")
    {
        state.approvals.push(approvalOf(event));
        return;
    }
    if (event.type === "work.policy-declared")
    {
        state.policy = {
            ts: event.ts,
            model: str(event.payload.model),
            freshReview: event.payload.freshReview === true,
            why: str(event.payload.why)
        };
        return;
    }
    if (event.type === "work.covered" || event.type === "work.rechecked")
    {
        state.coverage.push(coverageOf(event));
        return;
    }
    const requirement = state.requirements.find((item) => item.id === event.payload.requirement);
    if (requirement === undefined)
    {
        return;
    }
    // A revision never rewrites what was said: it bumps the number coverage was
    // judged against, which is what makes an older judgment read as stale.
    if (event.type === "work.requirement-revised")
    {
        requirement.revision += 1;
        requirement.text = str(event.payload.text) ?? requirement.text;
        return;
    }
    requirement.retired = true;
}

function approvalOf(event: SelfEvent): WorkApproval
{
    const method = confirmationMethodOf(event.payload.confirmation);
    return {
        id: event.id,
        ts: event.ts,
        by: String(event.payload.by ?? (event.origin.confirmed ? "human" : "agent")),
        humanConfirmed: event.origin.confirmed && method !== undefined,
        method
    };
}

const VERIFIED_CONFIRMATION_METHODS = ["tty"];

function confirmationMethodOf(value: unknown): string | undefined
{
    if (value === null || typeof value !== "object")
    {
        return undefined;
    }
    const method = (value as Record<string, unknown>).method;
    return VERIFIED_CONFIRMATION_METHODS.includes(method as string) ? String(method) : undefined;
}

function coverageOf(event: SelfEvent): RequirementCoverage
{
    return {
        requirement: String(event.payload.requirement),
        ts: event.ts,
        why: String(event.payload.why),
        revision: Number(event.payload.requirementRevision),
        commits: event.refs?.commits ?? [],
        artifacts: event.refs?.artifacts ?? [],
        report: str(event.payload.report),
        recheck: event.type === "work.rechecked" ? true : undefined
    };
}

// A review receipt names the work unit it reviewed whenever the change set it
// was bound to carries one. That projection is all this needs: the receipt
// itself stays the integration lane's, minted only by `self review ingest`.
export function applyWorkReview(state: CompletionState, event: SelfEvent): void
{
    state.reviews.push({
        receipt: String(event.payload.receipt),
        ts: event.ts,
        verdict: String(event.payload.verdict),
        model: String(event.payload.model ?? ""),
        session: str(event.payload.session)
    });
}

export function deriveCompletion(state: CompletionState): void
{
    const live = state.requirements.filter((item) => item.retired !== true);
    const latest = latestCoverage(state);
    state.covered = live.filter((item) => latest.has(item.id)).map((item) => item.id);
    state.open = live.filter((item) => !latest.has(item.id)).map((item) => item.id);
    state.stale = live
        .map((item) => latest.get(item.id))
        .filter((item): item is RequirementCoverage => item !== undefined)
        .filter((item) => item.revision !== revisionOf(state, item.requirement));
}

// A requirement may be judged more than once, and only the newest judgment
// stands: an earlier entry stays on record as lineage without holding the unit
// uncovered for ever.
function latestCoverage(state: CompletionState): Map<string, RequirementCoverage>
{
    const latest = new Map<string, RequirementCoverage>();
    for (const item of state.coverage)
    {
        latest.set(item.requirement, item);
    }
    return latest;
}

function revisionOf(state: CompletionState, requirement: string): number
{
    return state.requirements.find((item) => item.id === requirement)?.revision ?? 1;
}

/* ── the completion check ──────────────────────────────────────────── */

// The one function that decides whether a work unit may be called done. Every
// caller reaches it: `self work done` before it records the event, and the
// runner and the daemon at the moment they settle an attempt — which is how a
// passing attempt reports what the unit still owes instead of closing it.
//
// Null means nothing stands in the way. A string is the whole refusal, in one
// line, naming what is missing rather than that something is.
export function completionRefusal(work: Completable): string | null
{
    return uncoveredRefusal(work)
        ?? approvalRefusal(work)
        ?? modelRefusal(work)
        ?? reviewRefusal(work);
}

// Open and stale are one answer: a requirement whose coverage was judged
// against a revision that has since moved is a requirement nobody has judged as
// it now reads, and the check may not tell the two apart.
function uncoveredRefusal(work: Completable): string | null
{
    const state = work.completion;
    const uncovered = [...state.open, ...state.stale.map((item) => item.requirement)];
    if (uncovered.length === 0)
    {
        return null;
    }
    const named = uncovered.map((id) => `${id} ${textOf(state, id)}`).join("; ");
    return `${work.id} has uncovered requirement(s) — ${named} — cover each with ` +
        `\`self work met ${work.id} --requirement <id> --why "<how the evidence covers it>"\``;
}

function approvalRefusal(work: Completable): string | null
{
    const state = work.completion;
    if (state.approvalRequired === undefined || state.approvals.some((item) => item.humanConfirmed))
    {
        return null;
    }
    return `${work.id} requires human approval before it can be done${state.approvalRequired.why === undefined ? "" : ` (${state.approvalRequired.why})`} — ` +
        `grant it from an interactive terminal with \`self work approve ${work.id}\``;
}

// A settled attempt is one that reached the completion gate. What it ran under
// is the model the generation it was admitted under pinned, recorded on its own
// run.started event: an attempt nobody dispatched from a work spec carries no
// model at all, and cannot satisfy a policy that names one.
function modelRefusal(work: Completable): string | null
{
    const wanted = work.completion.policy?.model;
    if (wanted === undefined)
    {
        return null;
    }
    const settled = implementers(work);
    if (settled.some((attempt) => matchesModel(attempt.model, wanted)))
    {
        return null;
    }
    const ran = settled.map((attempt) => `${attempt.id} ${attempt.model ?? "no model recorded"}`).join(", ");
    return `${work.id} declares a "${wanted}" completion policy and no settled attempt ran under it — ` +
        `settled: ${ran === "" ? "none" : ran}`;
}

export function implementers(work: Completable): { id: string; state: string; model?: string }[]
{
    return work.attempts.filter((attempt) => attempt.state === "completed");
}

// A class matches a model name when it is the whole name or one of the parts it
// is built from: "opus" answers for "claude-opus-5", and the exact identifier
// answers for itself. Nothing here guesses an ordering between model names —
// a policy states the class it means.
export function matchesModel(model: string | undefined, wanted: string): boolean
{
    if (model === undefined)
    {
        return false;
    }
    const name = model.toLowerCase();
    const want = wanted.toLowerCase();
    return name === want || name.split(/[^a-z0-9]+/).includes(want) || name.startsWith(`${want}-`);
}

// Fresh means somebody other than the run that did the work looked at it. The
// session an attempt records is its own id — the runner sets it on every child
// it starts — so a receipt whose reviewer session is one of this unit's own
// attempts is the implementer reviewing itself.
//
// The verdict is deliberately not read here: what may land on main is the
// integration lane's gate, and this policy is about who reviewed, not about
// what they concluded.
function reviewRefusal(work: Completable): string | null
{
    if (work.completion.policy?.freshReview !== true)
    {
        return null;
    }
    const own = new Set(work.attempts.map((attempt) => attempt.id));
    if (work.completion.reviews.some((review) => review.session !== undefined && !own.has(review.session)))
    {
        return null;
    }
    return `${work.id} declares a fresh-session review policy and carries no review receipt from a session other than its own attempts — ` +
        "ingest one with `self review ingest --file <envelope.json>`";
}

// What the daemon's wake path reads. An approval that has not been granted is
// the unit saying a person has to answer before anything may be dispatched at
// it, and a supervisor that dispatched it anyway would be answering for them.
export function approvalPending(work: Completable): boolean
{
    return work.completion.approvalRequired !== undefined
        && !work.completion.approvals.some((item) => item.humanConfirmed);
}

export function requirementOf(state: CompletionState, id: string): Requirement | undefined
{
    return state.requirements.find((item) => item.id === id && item.retired !== true);
}

export function liveRequirements(state: CompletionState): Requirement[]
{
    return state.requirements.filter((item) => item.retired !== true);
}

// Requirement ids are never reused: a retired r2 stays retired so coverage
// recorded against it keeps pointing at what it actually satisfied.
export function nextRequirementId(state: CompletionState): string
{
    const highest = state.requirements.reduce((max, item) => Math.max(max, Number(item.id.slice(1)) || 0), 0);
    return `r${highest + 1}`;
}

function textOf(state: CompletionState, id: string): string
{
    return state.requirements.find((item) => item.id === id)?.text ?? "";
}

function str(value: unknown): string | undefined
{
    return value === undefined || value === null ? undefined : String(value);
}
