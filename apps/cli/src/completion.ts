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
// layer's counterpart of: declare, revise, drop, `met --requirement --why`,
// and `recheck` for what a revision left stale. One vocabulary, two layers.

export interface Requirement
{
    id: string;
    text: string;
    // Bumped by every restatement. Coverage records the revision it judged, so
    // a requirement that changed reads as uncovered until it is judged again.
    revision: number;
    retired?: boolean;
    // The registration this requirement was folded from. A session that just
    // recorded one reads its own id back through this rather than trusting the
    // value it guessed before the append.
    event: string;
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

// The id a registration folds to, fixed the moment its line lands in the log.
//
// Stored `work.covered`, `work.rechecked`, `work.requirement-revised` and
// `work.requirement-retired` events name a requirement by the value its
// registering session was told, so re-deriving that value from the fold's
// order re-points every one of them: a retirement written against `r2`
// attached to a different statement, silently retiring a live requirement the
// author never dropped and letting `work done` pass against the wrong set. So
// the declared value is kept whenever it is free.
//
// Two sessions racing `work require` against one unit both read the same next
// value and both write it (#110). Only the colliding registration is renamed,
// and only against the registrations already ahead of it in an append-only
// log, so its id cannot move afterwards either. The suffixed form is outside
// the `r<n>` sequence `nextRequirementId` draws from, so no later registration
// can claim an id that is already spoken for.
function mintRequirementId(state: CompletionState, event: SelfEvent): string
{
    const declared = str(event.payload.requirement) ?? `r${state.requirements.length + 1}`;
    let id = declared;
    let attempt = 1;
    while (state.requirements.some((item) => item.id === id))
    {
        attempt += 1;
        id = `${declared}-${attempt}`;
    }
    return id;
}

export function applyCompletion(state: CompletionState, event: SelfEvent): void
{
    if (event.type === "work.required")
    {
        state.requirements.push({
            id: mintRequirementId(state, event),
            text: String(event.payload.text),
            revision: 1,
            event: event.id
        });
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
// runner and the daemon at the moment they settle an attempt.
//
// Done is a judgment, not a checklist: the requirement-coverage, approval,
// model-policy and fresh-review conditions were removed with the governance
// layer (decision 01kz2nczhtde554qx5tqpqzrt3). The gate stays so every caller
// keeps one answer, and so a refusal can return here without a second path if
// one is ever owed again. Requirement and policy records from older logs still
// fold and render; they no longer hold a unit open.
export function completionRefusal(work: Completable): string | null
{
    void work;
    return null;
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

function str(value: unknown): string | undefined
{
    return value === undefined || value === null ? undefined : String(value);
}
