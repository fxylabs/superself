import { sha256 } from "./repo.js";
import { SelfEvent } from "./types.js";

// The identity of one integration edit: the bytes it started from and the
// bytes it produced. Both ends are digests of real diffs, so this cannot be
// steered by whoever performed the edit.
export function transitionDigest(from: string, to: string): string
{
    return sha256(`${from}\n${to}`);
}

// The repository integration controller. Parallel implementation is free;
// a repository's rebase, conflict resolution and merge are one serialized
// lane, and nothing enters that lane except by the order derived here.
//
// Every record below is folded from the log. No surface may assert a phase,
// a receipt or a merge: a phase is what the events add up to.

export type Phase =
    | "implementation"
    | "change_review"
    | "waiting_predecessor"
    | "integration"
    | "delta_review"
    | "merge_ready"
    | "merged"
    | "blocked_policy"
    | "closed";

export type ReviewScope = "change" | "integration_delta" | "release";

export type ReviewVerdict = "approve" | "reject" | "changes_requested";

export const REVIEW_SCOPES: ReviewScope[] = ["change", "integration_delta", "release"];
export const REVIEW_VERDICTS: ReviewVerdict[] = ["approve", "reject", "changes_requested"];

// A semantic domain is declared, never guessed. Two change sets that both
// touch "supervisor.process-ownership" collide even when they share no path,
// and no path heuristic can see that.
export interface SemanticDomain
{
    name: string;
    version: number;
}

export interface TestResult
{
    name: string;
    status: string;
}

export interface ReceiptArtifact
{
    id: string;
    name: string;
    path: string;
    sha256: string;
}

export interface ReviewReceipt
{
    id: string;
    changeSet: string;
    scope: ReviewScope;
    base: string;
    head: string;
    // The bytes this verdict is about: a feature diff digest, an integration
    // delta digest, or the release-delta digest a promotion pinned.
    digest: string;
    verdict: ReviewVerdict;
    findings: string[];
    tests: TestResult[];
    artifact?: ReceiptArtifact;
    envelopeDigest: string;
    reviewer: string;
    model: string;
    session?: string;
    ts: string;
}

export interface IntegrationDelta
{
    id: string;
    fromDigest: string;
    digest: string;
    resultDigest: string;
    paths: string[];
    intersections: string[];
    attempt: string;
    ts: string;
}

export type AttemptStatus = "running" | "completed" | "conflict" | "failed" | "cancelled";

export interface AttemptCommand
{
    command: string;
    exit: number;
}

export interface IntegrationAttempt
{
    id: string;
    changeSet: string;
    repository: string;
    fence: number;
    action: "rebase" | "resolve" | "merge";
    predecessor?: string;
    oldHead: string;
    newHead?: string;
    mainAt?: string;
    status: AttemptStatus;
    conflictPaths: string[];
    intersections: string[];
    commands: AttemptCommand[];
    reason?: string;
    ts: string;
    endedAt?: string;
}

export interface MergeApproval
{
    id: string;
    changeSet: string;
    head: string;
    by: string;
    humanConfirmed: boolean;
    // How the human was verified. Only a recognized method makes an approval
    // count: an event asserting `confirmed` with no verified method behind it
    // is an agent's claim, and the gate does not read claims.
    method?: string;
    ts: string;
}

export interface CiObservation
{
    repository: string;
    head: string;
    check: string;
    conclusion: string;
    observedAt: string;
    url?: string;
}

export interface MergeReceipt
{
    id: string;
    changeSet: string;
    head: string;
    fence: number;
    mergeCommit: string;
    mainBefore: string;
    mainAfter: string;
    // The branch this merge landed on: the configured integration branch, or
    // main when the repository merges directly. An integration-target merge
    // carries no approval — the human gate belongs to promotion into main.
    target?: string;
    approval?: string;
    ci: CiObservation[];
    ts: string;
}

// One bid to promote the integration branch into main. The candidate is an
// exact commit, and the digest is the exact release-candidate bytes —
// sha256(git diff base...candidate) — so the release review and the human
// approval are both bound to precisely what promotion will land on main.
export interface Promotion
{
    id: string;
    repository: string;
    candidate: string;
    base: string;
    digest: string;
    digestSource: "computed" | "declared";
    ts: string;
    receipts: ReviewReceipt[];
    approvals: MergeApproval[];
    recorded?: {
        mainBefore: string;
        mainAfter: string;
        mergeCommit?: string;
        approval: string;
        receipt: string;
        ts: string;
    };
}

export interface Blocker
{
    code: string;
    detail: string;
    next: string;
}

export interface Overlap
{
    changeSet: string;
    paths: string[];
    domains: string[];
}

export interface ChangeSet
{
    id: string;
    repository: string;
    work?: string;
    pr?: string;
    base: string;
    head: string;
    featureDigest: string;
    digestSource: "computed" | "declared";
    paths: string[];
    domains: SemanticDomain[];
    depends: string[];
    supersedes: string[];
    consolidates: string[];
    checks: string[];
    risk: string;
    rank: number;
    ts: string;
    lastEventTs: string;
    receipts: ReviewReceipt[];
    requests: { scope: ReviewScope; digest: string; ts: string }[];
    deltas: IntegrationDelta[];
    attempts: IntegrationAttempt[];
    approvals: MergeApproval[];
    merge?: MergeReceipt;
    closed?: "superseded" | "abandoned";
    /* derived below this line */
    phase: Phase;
    reason: string;
    blockers: Blocker[];
    next: string;
    order: number;
    predecessors: string[];
    pathOverlaps: Overlap[];
    semanticOverlaps: Overlap[];
    anchor?: string;
    chain: IntegrationDelta[];
    uncoveredDeltas: string[];
    ci: CiObservation[];
}

export interface RepositoryLease
{
    repository: string;
    holder: string;
    fence: number;
    acquiredAt: string;
    expiresAt: string;
    released: boolean;
    expired: boolean;
    live: boolean;
}

export interface Repository
{
    name: string;
    fence: number;
    lease?: RepositoryLease;
    mainHead?: string;
    mainObservedAt?: string;
    // The configured integration branch, when the train merges somewhere
    // before main. Its head is observed exactly as main's is.
    integrationBranch?: string;
    targetHead?: string;
    targetObservedAt?: string;
    train: string[];
}

// Where this repository's change-set merges land. With a configured
// integration branch the lane is autonomous; without one, every merge is
// itself a promotion into main and takes the human gate with it.
export function mergeTargetOf(repository: Repository): { branch: string; head?: string; promotion: boolean }
{
    if (repository.integrationBranch !== undefined)
    {
        return { branch: repository.integrationBranch, head: repository.targetHead, promotion: false };
    }
    return { branch: "main", head: repository.mainHead, promotion: true };
}

export interface IntegrationState
{
    changeSets: ChangeSet[];
    repositories: Repository[];
    promotions: Promotion[];
    ci: CiObservation[];
    // Every projected observation carries a key. A webhook delivered twice is
    // one observation, and the second delivery must add nothing.
    seen: string[];
}

export function emptyIntegration(): IntegrationState
{
    return { changeSets: [], repositories: [], promotions: [], ci: [], seen: [] };
}

export const INTEGRATION_PREFIXES = ["changeset.", "review.", "lease.", "attempt.", "merge.", "ci.", "main.", "repo.", "target.", "promotion."];

export function isIntegrationEvent(type: string): boolean
{
    return INTEGRATION_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/* ── fold ──────────────────────────────────────────────────────────── */

export function applyIntegration(state: IntegrationState, event: SelfEvent): void
{
    if (event.type.startsWith("changeset."))
    {
        applyChangeSet(state, event);
        return;
    }
    if (event.type === "review.requested" || event.type === "review.received")
    {
        applyReview(state, event);
        return;
    }
    if (event.type.startsWith("lease."))
    {
        applyLease(state, event);
        return;
    }
    if (event.type.startsWith("attempt."))
    {
        applyAttempt(state, event);
        return;
    }
    if (event.type === "merge.approved" || event.type === "merge.recorded")
    {
        applyMerge(state, event);
        return;
    }
    if (event.type === "repo.target_set")
    {
        repositoryOf(state, String(event.payload.repository)).integrationBranch = str(event.payload.branch);
        return;
    }
    if (event.type.startsWith("promotion."))
    {
        applyPromotion(state, event);
        return;
    }
    if (event.type === "ci.observed" || event.type === "main.observed" || event.type === "target.observed")
    {
        applyObservation(state, event);
    }
}

function applyChangeSet(state: IntegrationState, event: SelfEvent): void
{
    if (event.type === "changeset.registered")
    {
        registerChangeSet(state, event);
        return;
    }
    const changeSet = findChangeSet(state, str(event.payload.changeSet));
    if (changeSet === undefined)
    {
        return;
    }
    changeSet.lastEventTs = event.ts;
    if (event.type === "changeset.redeclared")
    {
        redeclare(changeSet, event);
        return;
    }
    if (event.type === "changeset.head_moved")
    {
        moveHead(changeSet, event);
        return;
    }
    if (event.type === "changeset.closed")
    {
        changeSet.closed = event.payload.as === "superseded" ? "superseded" : "abandoned";
    }
}

function registerChangeSet(state: IntegrationState, event: SelfEvent): void
{
    const id = str(event.payload.changeSet) ?? event.id;
    if (findChangeSet(state, id) !== undefined)
    {
        return;
    }
    const repository = String(event.payload.repository);
    repositoryOf(state, repository);
    state.changeSets.push({
        id,
        repository,
        work: event.refs?.work,
        pr: str(event.payload.pr),
        base: String(event.payload.base),
        head: String(event.payload.head),
        featureDigest: String(event.payload.digest),
        digestSource: event.payload.digestSource === "computed" ? "computed" : "declared",
        paths: list(event.payload.paths),
        domains: domains(event.payload.domains),
        depends: list(event.payload.depends),
        supersedes: list(event.payload.supersedes),
        consolidates: list(event.payload.consolidates),
        checks: list(event.payload.checks),
        risk: str(event.payload.risk) ?? "unstated",
        rank: Number(event.payload.rank ?? 0),
        ts: event.ts,
        lastEventTs: event.ts,
        receipts: [],
        requests: [],
        deltas: [],
        attempts: [],
        approvals: [],
        phase: "implementation",
        reason: "",
        blockers: [],
        next: "",
        order: 0,
        predecessors: [],
        pathOverlaps: [],
        semanticOverlaps: [],
        chain: [],
        uncoveredDeltas: [],
        ci: []
    });
}

// A redeclaration states what the change set is, never where its bytes are:
// domains, dependencies, consolidation and rank are judgments, and moving them
// must not silently revalidate a review bound to bytes.
function redeclare(changeSet: ChangeSet, event: SelfEvent): void
{
    const payload = event.payload;
    if (payload.domains !== undefined)
    {
        changeSet.domains = domains(payload.domains);
    }
    for (const field of ["depends", "supersedes", "consolidates", "checks"] as const)
    {
        if (payload[field] !== undefined)
        {
            changeSet[field] = list(payload[field]);
        }
    }
    changeSet.risk = str(payload.risk) ?? changeSet.risk;
    changeSet.rank = payload.rank === undefined ? changeSet.rank : Number(payload.rank);
}

function moveHead(changeSet: ChangeSet, event: SelfEvent): void
{
    changeSet.base = str(event.payload.base) ?? changeSet.base;
    changeSet.head = String(event.payload.head);
    changeSet.featureDigest = String(event.payload.digest);
    changeSet.digestSource = event.payload.digestSource === "computed" ? "computed" : "declared";
    if (event.payload.paths !== undefined)
    {
        changeSet.paths = list(event.payload.paths);
    }
}

function applyReview(state: IntegrationState, event: SelfEvent): void
{
    if (event.payload.promotion !== undefined)
    {
        applyReleaseReview(state, event);
        return;
    }
    const changeSet = findChangeSet(state, str(event.payload.changeSet));
    if (changeSet === undefined)
    {
        return;
    }
    changeSet.lastEventTs = event.ts;
    if (event.type === "review.requested")
    {
        changeSet.requests.push({ scope: scopeOf(event.payload.scope), digest: String(event.payload.digest), ts: event.ts });
        return;
    }
    const id = str(event.payload.receipt) ?? event.id;
    if (changeSet.receipts.some((receipt) => receipt.id === id))
    {
        return;
    }
    changeSet.receipts.push(newReceipt(id, changeSet.id, event));
}

function newReceipt(id: string, changeSet: string, event: SelfEvent): ReviewReceipt
{
    const payload = event.payload;
    return {
        id,
        changeSet,
        scope: scopeOf(payload.scope),
        base: String(payload.base),
        head: String(payload.head),
        digest: String(payload.digest),
        verdict: verdictOf(payload.verdict),
        findings: list(payload.findings),
        tests: tests(payload.tests),
        artifact: artifactOf(payload.artifact),
        envelopeDigest: String(payload.envelopeDigest),
        reviewer: String(payload.reviewer ?? "unstated"),
        model: String(payload.model ?? "unstated"),
        session: str(payload.session),
        ts: event.ts
    };
}

function applyLease(state: IntegrationState, event: SelfEvent): void
{
    const repository = repositoryOf(state, String(event.payload.repository));
    const fence = Number(event.payload.fence);
    if (event.type === "lease.acquired")
    {
        repository.fence = Math.max(repository.fence, fence);
        repository.lease = {
            repository: repository.name,
            holder: String(event.payload.holder),
            fence,
            acquiredAt: event.ts,
            expiresAt: String(event.payload.expiresAt),
            released: false,
            expired: false,
            live: true
        };
        return;
    }
    if (repository.lease !== undefined && repository.lease.fence === fence)
    {
        repository.lease.released = event.type === "lease.released";
        repository.lease.expired = event.type === "lease.expired";
        repository.lease.live = false;
    }
}

function applyAttempt(state: IntegrationState, event: SelfEvent): void
{
    if (event.type === "attempt.started")
    {
        startAttempt(state, event);
        return;
    }
    const attempt = findAttempt(state, str(event.payload.attempt));
    if (attempt === undefined || attempt.status !== "running")
    {
        return;
    }
    const changeSet = findChangeSet(state, attempt.changeSet);
    attempt.endedAt = event.ts;
    attempt.reason = str(event.payload.reason) ?? str(event.payload.why);
    if (event.type === "attempt.cancelled")
    {
        attempt.status = "cancelled";
        return;
    }
    finishAttempt(attempt, changeSet, event);
}

function startAttempt(state: IntegrationState, event: SelfEvent): void
{
    const id = str(event.payload.attempt) ?? event.id;
    if (findAttempt(state, id) !== undefined)
    {
        return;
    }
    const changeSet = findChangeSet(state, str(event.payload.changeSet));
    if (changeSet === undefined)
    {
        return;
    }
    changeSet.lastEventTs = event.ts;
    changeSet.attempts.push({
        id,
        changeSet: changeSet.id,
        repository: changeSet.repository,
        fence: Number(event.payload.fence),
        action: actionOf(event.payload.action),
        predecessor: str(event.payload.predecessor),
        oldHead: String(event.payload.oldHead),
        mainAt: str(event.payload.mainAt),
        status: "running",
        conflictPaths: [],
        intersections: [],
        commands: [],
        ts: event.ts
    });
}

function finishAttempt(attempt: IntegrationAttempt, changeSet: ChangeSet | undefined, event: SelfEvent): void
{
    const payload = event.payload;
    attempt.status = outcomeOf(payload.outcome);
    attempt.conflictPaths = list(payload.conflictPaths);
    attempt.intersections = list(payload.intersections);
    attempt.commands = commands(payload.commands);
    attempt.newHead = str(payload.head);
    if (changeSet === undefined)
    {
        return;
    }
    changeSet.lastEventTs = event.ts;
    if (payload.head === undefined || payload.digest === undefined)
    {
        return;
    }
    recordDelta(changeSet, attempt, event);
    changeSet.base = str(payload.base) ?? changeSet.base;
    changeSet.head = String(payload.head);
    changeSet.featureDigest = String(payload.digest);
    if (payload.paths !== undefined)
    {
        changeSet.paths = list(payload.paths);
    }
}

// An integration edit is never folded into the reviewed bytes: it becomes a
// delta of its own, with the digest it started from and the digest it produced,
// so the chain from a review to the current head is checkable byte by byte.
//
// The delta's own digest is that transition, derived from both ends rather
// than declared: nobody gets to name the thing their review will be bound to.
function recordDelta(changeSet: ChangeSet, attempt: IntegrationAttempt, event: SelfEvent): void
{
    const resultDigest = String(event.payload.digest);
    if (resultDigest === changeSet.featureDigest)
    {
        return;
    }
    changeSet.deltas.push({
        id: `d${changeSet.deltas.length + 1}`,
        fromDigest: changeSet.featureDigest,
        digest: transitionDigest(changeSet.featureDigest, resultDigest),
        resultDigest,
        paths: list(event.payload.conflictPaths),
        intersections: list(event.payload.intersections),
        attempt: attempt.id,
        ts: event.ts
    });
}

function applyMerge(state: IntegrationState, event: SelfEvent): void
{
    const changeSet = findChangeSet(state, str(event.payload.changeSet));
    if (changeSet === undefined)
    {
        return;
    }
    changeSet.lastEventTs = event.ts;
    if (event.type === "merge.approved")
    {
        changeSet.approvals.push(approvalOf(event, changeSet.id, str(event.payload.head)));
        return;
    }
    if (changeSet.merge !== undefined)
    {
        return;
    }
    changeSet.merge = newMergeReceipt(changeSet, event);
}

// An approval is human only when the event carries the record of how the
// human was verified. `origin.confirmed` alone is a bit any process can set;
// the confirmation method is the typed input the gate actually reads.
function approvalOf(event: SelfEvent, subject: string, head: string | undefined): MergeApproval
{
    const method = confirmationMethodOf(event.payload.confirmation);
    return {
        id: event.id,
        changeSet: subject,
        head: head ?? "",
        by: String(event.payload.by ?? (event.origin.confirmed ? "human" : "agent")),
        humanConfirmed: event.origin.confirmed && method !== undefined,
        method,
        ts: event.ts
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

function newMergeReceipt(changeSet: ChangeSet, event: SelfEvent): MergeReceipt
{
    const payload = event.payload;
    return {
        id: str(payload.merge) ?? event.id,
        changeSet: changeSet.id,
        head: String(payload.head),
        fence: Number(payload.fence),
        mergeCommit: String(payload.mergeCommit),
        mainBefore: String(payload.mainBefore),
        mainAfter: String(payload.mainAfter),
        target: str(payload.target),
        approval: str(payload.approval),
        ci: Array.isArray(payload.ci) ? (payload.ci as CiObservation[]) : [],
        ts: event.ts
    };
}

function applyReleaseReview(state: IntegrationState, event: SelfEvent): void
{
    const promotion = findPromotion(state, str(event.payload.promotion));
    if (promotion === undefined || event.type !== "review.received")
    {
        return;
    }
    const id = str(event.payload.receipt) ?? event.id;
    if (promotion.receipts.some((receipt) => receipt.id === id))
    {
        return;
    }
    promotion.receipts.push(newReceipt(id, promotion.id, event));
}

function applyPromotion(state: IntegrationState, event: SelfEvent): void
{
    if (event.type === "promotion.requested")
    {
        registerPromotion(state, event);
        return;
    }
    const promotion = findPromotion(state, str(event.payload.promotion));
    if (promotion === undefined)
    {
        return;
    }
    if (event.type === "promotion.approved")
    {
        promotion.approvals.push(approvalOf(event, promotion.id, str(event.payload.candidate)));
        return;
    }
    if (event.type !== "promotion.recorded" || promotion.recorded !== undefined)
    {
        return;
    }
    promotion.recorded = {
        mainBefore: String(event.payload.mainBefore),
        mainAfter: String(event.payload.mainAfter),
        mergeCommit: str(event.payload.mergeCommit),
        approval: String(event.payload.approval),
        receipt: String(event.payload.receipt),
        ts: event.ts
    };
}

function registerPromotion(state: IntegrationState, event: SelfEvent): void
{
    const id = str(event.payload.promotion) ?? event.id;
    if (findPromotion(state, id) !== undefined)
    {
        return;
    }
    const repository = String(event.payload.repository);
    repositoryOf(state, repository);
    state.promotions.push({
        id,
        repository,
        candidate: String(event.payload.candidate),
        base: String(event.payload.base),
        digest: String(event.payload.digest),
        digestSource: event.payload.digestSource === "computed" ? "computed" : "declared",
        ts: event.ts,
        receipts: [],
        approvals: []
    });
}

// Projections converge whatever order they arrive in: a key that was already
// seen adds nothing, and an observation is only believed over another when it
// was observed later — not when it happened to be appended later.
function applyObservation(state: IntegrationState, event: SelfEvent): void
{
    const key = str(event.payload.dedupe);
    if (key !== undefined && state.seen.includes(key))
    {
        return;
    }
    if (key !== undefined)
    {
        state.seen.push(key);
    }
    const repository = repositoryOf(state, String(event.payload.repository));
    const observedAt = str(event.payload.observedAt) ?? event.ts;
    if (event.type === "main.observed")
    {
        observeMain(repository, String(event.payload.head), observedAt);
        return;
    }
    if (event.type === "target.observed")
    {
        observeTarget(repository, String(event.payload.head), observedAt);
        return;
    }
    observeCi(state, repository.name, event, observedAt);
}

function observeMain(repository: Repository, head: string, observedAt: string): void
{
    if (repository.mainObservedAt !== undefined && repository.mainObservedAt > observedAt)
    {
        return;
    }
    repository.mainHead = head;
    repository.mainObservedAt = observedAt;
}

function observeTarget(repository: Repository, head: string, observedAt: string): void
{
    if (repository.targetObservedAt !== undefined && repository.targetObservedAt > observedAt)
    {
        return;
    }
    repository.targetHead = head;
    repository.targetObservedAt = observedAt;
}

function observeCi(state: IntegrationState, repository: string, event: SelfEvent, observedAt: string): void
{
    const head = String(event.payload.head);
    const check = String(event.payload.check);
    const current = state.ci.find((item) =>
        item.repository === repository && item.head === head && item.check === check);
    if (current !== undefined && current.observedAt > observedAt)
    {
        return;
    }
    const observation: CiObservation = {
        repository,
        head,
        check,
        conclusion: String(event.payload.conclusion),
        observedAt,
        url: str(event.payload.url)
    };
    if (current === undefined)
    {
        state.ci.push(observation);
        return;
    }
    Object.assign(current, observation);
}

/* ── derivation ────────────────────────────────────────────────────── */

export function deriveIntegration(state: IntegrationState, now: Date): string[]
{
    const signals: string[] = [];
    for (const repository of state.repositories)
    {
        expireLease(repository, now);
        deriveTrain(state, repository);
    }
    for (const changeSet of state.changeSets)
    {
        signals.push(...changeSetSignals(changeSet));
    }
    for (const promotion of state.promotions)
    {
        if (promotion.digestSource === "declared" && promotion.recorded === undefined)
        {
            signals.push(`${promotion.id} carries a declared release digest — no checkout was reachable to compute it`);
        }
    }
    return signals;
}

function expireLease(repository: Repository, now: Date): void
{
    const lease = repository.lease;
    if (lease === undefined || lease.released)
    {
        return;
    }
    lease.expired = lease.expired || new Date(lease.expiresAt).getTime() <= now.getTime();
    lease.live = !lease.expired;
}

// The train is a total order, and it must not depend on the order events were
// appended in: declared rank first, then registration time, then id. A
// dependency then pulls its dependents behind it without disturbing the rest.
function deriveTrain(state: IntegrationState, repository: Repository): void
{
    const members = state.changeSets
        .filter((item) => item.repository === repository.name)
        .sort((a, b) => a.rank - b.rank || a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
    const ordered = topological(members);
    repository.train = ordered.map((item) => item.id);
    ordered.forEach((changeSet, index) =>
    {
        changeSet.order = index;
        deriveOverlaps(changeSet, ordered);
    });
    for (const changeSet of ordered)
    {
        deriveChangeSet(changeSet, state, repository, ordered);
    }
}

// Kahn's algorithm over the deterministic base order: the first ready member
// in that order is always the one taken, so the same log yields the same
// train. A cycle leaves members unplaced; they are appended in base order and
// reported as a policy block rather than silently ordered.
function topological(members: ChangeSet[]): ChangeSet[]
{
    const ids = new Set(members.map((item) => item.id));
    const placed = new Set<string>();
    const ordered: ChangeSet[] = [];
    let moved = true;
    while (moved)
    {
        moved = false;
        for (const member of members)
        {
            const ready = member.depends.every((id) => !ids.has(id) || placed.has(id));
            if (!placed.has(member.id) && ready)
            {
                placed.add(member.id);
                ordered.push(member);
                moved = true;
            }
        }
    }
    return [...ordered, ...members.filter((member) => !placed.has(member.id))];
}

function deriveOverlaps(changeSet: ChangeSet, train: ChangeSet[]): void
{
    changeSet.pathOverlaps = [];
    changeSet.semanticOverlaps = [];
    for (const other of train)
    {
        if (other.id === changeSet.id || isClosed(other))
        {
            continue;
        }
        const paths = changeSet.paths.filter((path) => other.paths.includes(path));
        const shared = sharedDomains(changeSet, other);
        if (paths.length > 0)
        {
            changeSet.pathOverlaps.push({ changeSet: other.id, paths, domains: [] });
        }
        if (shared.length > 0)
        {
            changeSet.semanticOverlaps.push({ changeSet: other.id, paths: [], domains: shared });
        }
    }
}

// Two declarations of one domain at different versions are still the same
// domain: the version says which contract was declared, not which subject.
function sharedDomains(one: ChangeSet, other: ChangeSet): string[]
{
    const names = new Set(other.domains.map((domain) => domain.name));
    return one.domains
        .filter((domain) => names.has(domain.name))
        .map((domain) => `${domain.name}@${domain.version}`);
}

function isClosed(changeSet: ChangeSet): boolean
{
    return changeSet.merge !== undefined || changeSet.closed !== undefined;
}

function deriveChangeSet(changeSet: ChangeSet, state: IntegrationState, repository: Repository, train: ChangeSet[]): void
{
    changeSet.ci = state.ci.filter((item) => item.repository === repository.name && item.head === changeSet.head);
    changeSet.predecessors = predecessorsOf(changeSet, train);
    const cover = coverage(changeSet);
    changeSet.anchor = cover.anchor?.id;
    changeSet.chain = cover.chain;
    changeSet.uncoveredDeltas = cover.uncovered.map((delta) => delta.id);
    changeSet.blockers = blockersOf(changeSet, repository, train, cover);
    changeSet.phase = phaseOf(changeSet);
    changeSet.reason = reasonOf(changeSet, cover);
    changeSet.next = changeSet.blockers[0]?.next ?? nextActionOf(changeSet);
}

// A predecessor is an open earlier train member this one is actually tied to:
// a stated dependency, a shared path, or a shared semantic domain. Unrelated
// work in the same repository is not made to wait — the lease already keeps
// the lane single-file.
function predecessorsOf(changeSet: ChangeSet, train: ChangeSet[]): string[]
{
    const tied = new Set([...changeSet.depends, ...changeSet.pathOverlaps.map((item) => item.changeSet),
        ...changeSet.semanticOverlaps.map((item) => item.changeSet)]);
    return train
        .filter((other) => other.id !== changeSet.id && tied.has(other.id) && other.order < changeSet.order)
        .filter((other) => !isClosed(other))
        .map((other) => other.id);
}

export interface Coverage
{
    anchor?: ReviewReceipt;
    chain: IntegrationDelta[];
    uncovered: IntegrationDelta[];
    reaches: boolean;
    latest?: ReviewReceipt;
}

// What the current head bytes are covered by. A change review anchors at the
// digest it read; every integration delta since must carry its own approved
// receipt, and the chain must land exactly on the current feature digest.
export function coverage(changeSet: ChangeSet): Coverage
{
    const changeReceipts = changeSet.receipts.filter((receipt) => receipt.scope === "change");
    const latest = changeReceipts[changeReceipts.length - 1];
    const approvals = changeReceipts.filter((receipt) => isStanding(changeSet, receipt)).reverse();
    for (const anchor of approvals)
    {
        const walk = walkDeltas(changeSet, anchor.digest);
        if (walk.reaches)
        {
            return { anchor, chain: walk.chain, uncovered: uncoveredDeltas(changeSet, walk.chain), reaches: true, latest };
        }
    }
    return { chain: [], uncovered: [], reaches: false, latest };
}

function walkDeltas(changeSet: ChangeSet, from: string): { chain: IntegrationDelta[]; reaches: boolean }
{
    const chain: IntegrationDelta[] = [];
    let digest = from;
    while (digest !== changeSet.featureDigest)
    {
        const delta = changeSet.deltas.find((item) => item.fromDigest === digest && !chain.includes(item));
        if (delta === undefined)
        {
            return { chain, reaches: false };
        }
        chain.push(delta);
        digest = delta.resultDigest;
    }
    return { chain, reaches: true };
}

function uncoveredDeltas(changeSet: ChangeSet, chain: IntegrationDelta[]): IntegrationDelta[]
{
    return chain.filter((delta) => !changeSet.receipts.some((receipt) =>
        receipt.scope === "integration_delta" && receipt.digest === delta.digest && isStanding(changeSet, receipt)));
}

// A verdict counts only while it is the last word on those exact bytes. A
// rejection ingested after an approval of the same digest is the answer, and
// a re-review after a fix is how the approval comes back.
function isStanding(changeSet: ChangeSet, receipt: ReviewReceipt): boolean
{
    const sameBytes = changeSet.receipts.filter((item) =>
        item.scope === receipt.scope && item.digest === receipt.digest);
    return sameBytes[sameBytes.length - 1].id === receipt.id && receipt.verdict === "approve";
}

/* ── gates ─────────────────────────────────────────────────────────── */

// The merge gate, stated once. Every surface — status, plan, the merge command
// itself — reads these, so no prose and no exit code can add a way through.
function blockersOf(changeSet: ChangeSet, repository: Repository, train: ChangeSet[], cover: Coverage): Blocker[]
{
    if (isClosed(changeSet))
    {
        return [];
    }
    return [
        ...policyBlockers(changeSet, train),
        ...reviewBlockers(changeSet, cover),
        ...laneBlockers(changeSet, repository),
        ...evidenceBlockers(changeSet, repository)
    ];
}

function policyBlockers(changeSet: ChangeSet, train: ChangeSet[]): Blocker[]
{
    const blockers: Blocker[] = [];
    const missing = changeSet.depends.filter((id) => !train.some((item) => item.id === id));
    if (missing.length > 0)
    {
        blockers.push({
            code: "dependency_unknown",
            detail: `depends on ${missing.join(", ")}, which this repository's train does not hold`,
            next: `self integration register --repo ${changeSet.repository} … for ${missing.join(", ")}`
        });
    }
    if (inCycle(changeSet, train))
    {
        blockers.push({
            code: "dependency_cycle",
            detail: `${changeSet.id} sits in a dependency cycle, so no order exists`,
            next: `self integration declare ${changeSet.id} --depends <id> to break the cycle`
        });
    }
    blockers.push(...semanticBlockers(changeSet, train));
    return blockers;
}

function inCycle(changeSet: ChangeSet, train: ChangeSet[]): boolean
{
    const byId = new Map(train.map((item) => [item.id, item]));
    const pending = [...changeSet.depends];
    const seen = new Set<string>();
    while (pending.length > 0)
    {
        const id = pending.pop() as string;
        if (id === changeSet.id)
        {
            return true;
        }
        if (seen.has(id))
        {
            continue;
        }
        seen.add(id);
        pending.push(...(byId.get(id)?.depends ?? []));
    }
    return false;
}

// Two change sets that both claim an architecture domain are not an ordering
// problem. Until someone states which one owns it, rebasing either one just
// moves the collision, so the train stops here and says so.
function semanticBlockers(changeSet: ChangeSet, train: ChangeSet[]): Blocker[]
{
    return changeSet.semanticOverlaps
        .filter((overlap) => !isResolvedOverlap(changeSet, overlap.changeSet, train))
        .map((overlap) => ({
            code: "unconsolidated_semantic_overlap",
            detail: `${changeSet.id} and ${overlap.changeSet} both declare ${overlap.domains.join(", ")} ` +
                "with no dependency, supersede or consolidation between them",
            next: `self integration declare ${changeSet.id} --consolidates ${overlap.changeSet} --why "<who owns the contract>" ` +
                `(or --depends ${overlap.changeSet})`
        }));
}

function isResolvedOverlap(changeSet: ChangeSet, other: string, train: ChangeSet[]): boolean
{
    const counterpart = train.find((item) => item.id === other);
    const stated = (item: ChangeSet | undefined, target: string): boolean =>
        item !== undefined && [...item.depends, ...item.supersedes, ...item.consolidates].includes(target);
    return stated(changeSet, other) || stated(counterpart, changeSet.id);
}

function reviewBlockers(changeSet: ChangeSet, cover: Coverage): Blocker[]
{
    if (!cover.reaches)
    {
        return [{
            code: "change_receipt_missing",
            detail: changeSet.receipts.length === 0
                ? `no review receipt is bound to feature digest ${short(changeSet.featureDigest)}`
                : `no approved change receipt is bound to the current feature digest ${short(changeSet.featureDigest)}`,
            next: `self review request ${changeSet.id} --scope change, then \`self review ingest --file <envelope.json>\``
        }];
    }
    return cover.uncovered.map((delta) => ({
        code: "delta_review_missing",
        detail: `integration delta ${delta.id} (${short(delta.digest)}) has no approved bounded review`,
        next: `self review request ${changeSet.id} --scope integration_delta, then ingest the envelope for ${short(delta.digest)}`
    }));
}

function laneBlockers(changeSet: ChangeSet, repository: Repository): Blocker[]
{
    const blockers: Blocker[] = [];
    if (changeSet.predecessors.length > 0)
    {
        blockers.push({
            code: "predecessor_open",
            detail: `${changeSet.predecessors.join(", ")} sit earlier in the train and are not merged`,
            next: `merge ${changeSet.predecessors[0]} first — \`self integration plan --repo ${changeSet.repository}\``
        });
    }
    const lease = repository.lease;
    if (lease === undefined || !lease.live)
    {
        blockers.push({
            code: "lease_not_current",
            detail: lease === undefined
                ? `no integration lease is held on ${repository.name}`
                : `the ${repository.name} lease (fence ${lease.fence}) is ${lease.released ? "released" : "expired"}`,
            next: `self integration lease acquire --repo ${repository.name} --holder <id>`
        });
    }
    return blockers;
}

// The human approval belongs to exactly one thing: promotion into main. A
// repository with a configured integration branch merges its train there on
// receipts, fence, CI and order alone; only a repository whose merges land
// directly on main takes the human gate on each merge.
function evidenceBlockers(changeSet: ChangeSet, repository: Repository): Blocker[]
{
    const blockers: Blocker[] = [];
    blockers.push(...ciBlockers(changeSet));
    if (!mergeTargetOf(repository).promotion)
    {
        return blockers;
    }
    const approval = currentApproval(changeSet);
    if (approval === undefined)
    {
        blockers.push({
            code: "approval_missing",
            detail: `no human merge approval names head ${short(changeSet.head)}, and this merge lands on main`,
            next: `a maintainer runs \`self integration approve ${changeSet.id} --head ${changeSet.head}\` in their own terminal`
        });
    }
    return blockers;
}

function ciBlockers(changeSet: ChangeSet): Blocker[]
{
    if (changeSet.checks.length === 0)
    {
        return [{
            code: "ci_checks_undeclared",
            detail: `${changeSet.id} declares no required checks, so no CI result can satisfy the gate`,
            next: `self integration declare ${changeSet.id} --check <name>`
        }];
    }
    return changeSet.checks
        .map((check) => ({ check, observation: changeSet.ci.find((item) => item.check === check) }))
        .filter((item) => item.observation?.conclusion !== "success")
        .map((item) => ({
            code: "ci_not_green",
            detail: item.observation === undefined
                ? `no ${item.check} result observed for exact head ${short(changeSet.head)}`
                : `${item.check} on ${short(changeSet.head)} is ${item.observation.conclusion}`,
            next: `self integration observe ci --repo ${changeSet.repository} --head ${changeSet.head} ` +
                `--check ${item.check} --conclusion success --at <iso>`
        }));
}

export function currentApproval(changeSet: ChangeSet): MergeApproval | undefined
{
    return [...changeSet.approvals].reverse()
        .find((approval) => approval.head === changeSet.head && approval.humanConfirmed);
}

export function promotionApproval(promotion: Promotion): MergeApproval | undefined
{
    return [...promotion.approvals].reverse()
        .find((approval) => approval.head === promotion.candidate && approval.humanConfirmed);
}

// The standing release verdict on exactly the release-candidate bytes this
// promotion pinned. Same rule as every other receipt: the last word on those
// bytes decides, and only an approval opens the gate.
export function standingRelease(promotion: Promotion): ReviewReceipt | undefined
{
    const receipts = promotion.receipts.filter((receipt) =>
        receipt.scope === "release" && receipt.digest === promotion.digest);
    const last = receipts[receipts.length - 1];
    return last !== undefined && last.verdict === "approve" ? last : undefined;
}

export function runningAttempt(changeSet: ChangeSet): IntegrationAttempt | undefined
{
    return changeSet.attempts.find((attempt) => attempt.status === "running");
}

/* ── phase ─────────────────────────────────────────────────────────── */

function phaseOf(changeSet: ChangeSet): Phase
{
    if (changeSet.merge !== undefined)
    {
        return "merged";
    }
    if (changeSet.closed !== undefined)
    {
        return "closed";
    }
    const codes = changeSet.blockers.map((blocker) => blocker.code);
    if (codes.some((code) => POLICY_CODES.includes(code)))
    {
        return "blocked_policy";
    }
    // A pass at the repository is in flight, so this item is in the lane and
    // nowhere else: the bytes everything below reads may be about to move.
    if (runningAttempt(changeSet) !== undefined)
    {
        return "integration";
    }
    if (codes.includes("delta_review_missing"))
    {
        return "delta_review";
    }
    if (codes.includes("change_receipt_missing"))
    {
        return openRequest(changeSet) === undefined ? "implementation" : "change_review";
    }
    if (codes.includes("predecessor_open"))
    {
        return "waiting_predecessor";
    }
    return changeSet.blockers.length === 0 ? "merge_ready" : "integration";
}

const POLICY_CODES = ["dependency_cycle", "dependency_unknown", "unconsolidated_semantic_overlap"];

function openRequest(changeSet: ChangeSet): { scope: ReviewScope; digest: string } | undefined
{
    return [...changeSet.requests].reverse().find((request) =>
        request.digest === changeSet.featureDigest
        && !changeSet.receipts.some((receipt) => receipt.scope === request.scope && receipt.digest === request.digest));
}

function reasonOf(changeSet: ChangeSet, cover: Coverage): string
{
    if (changeSet.merge !== undefined)
    {
        return `merged as ${short(changeSet.merge.mergeCommit)} from reviewed head ${short(changeSet.merge.head)}`;
    }
    if (changeSet.closed !== undefined)
    {
        return changeSet.closed;
    }
    if (cover.latest !== undefined && cover.latest.verdict !== "approve" && !cover.reaches)
    {
        return `change review ${cover.latest.verdict} with ${cover.latest.findings.length} finding(s) — ${cover.latest.id}`;
    }
    return changeSet.blockers[0]?.detail ?? "every merge prerequisite is satisfied";
}

function nextActionOf(changeSet: ChangeSet): string
{
    if (changeSet.merge !== undefined || changeSet.closed !== undefined)
    {
        return "nothing — this change set is closed";
    }
    return `self integration merge ${changeSet.id} --fence <current> --merge-commit <sha> --main-before <sha> --main-after <sha>`;
}

function changeSetSignals(changeSet: ChangeSet): string[]
{
    const signals: string[] = [];
    if (changeSet.phase === "blocked_policy")
    {
        signals.push(`${changeSet.id} is blocked by policy — ${changeSet.reason}`);
    }
    for (const attempt of changeSet.attempts.filter((item) => item.status === "cancelled"))
    {
        signals.push(`${changeSet.id} attempt ${attempt.id} was cancelled — ${attempt.reason ?? "no reason recorded"}`);
    }
    if (changeSet.digestSource === "declared" && changeSet.merge === undefined)
    {
        signals.push(`${changeSet.id} carries a declared feature digest — no checkout was reachable to compute it`);
    }
    return signals;
}

/* ── lookup ────────────────────────────────────────────────────────── */

export function findChangeSet(state: IntegrationState, id: string | undefined): ChangeSet | undefined
{
    return id === undefined ? undefined : state.changeSets.find((item) => item.id === id);
}

export function findAttempt(state: IntegrationState, id: string | undefined): IntegrationAttempt | undefined
{
    return id === undefined ? undefined : state.changeSets.flatMap((item) => item.attempts).find((item) => item.id === id);
}

export function findPromotion(state: IntegrationState, id: string | undefined): Promotion | undefined
{
    return id === undefined ? undefined : state.promotions.find((item) => item.id === id);
}

export function repositoryOf(state: IntegrationState, name: string): Repository
{
    const found = state.repositories.find((item) => item.name === name);
    if (found !== undefined)
    {
        return found;
    }
    const repository: Repository = { name, fence: 0, train: [] };
    state.repositories.push(repository);
    return repository;
}

export function openChangeSets(state: IntegrationState): ChangeSet[]
{
    return state.changeSets.filter((item) => item.merge === undefined && item.closed === undefined);
}

export function short(digest: string): string
{
    return digest.length <= 12 ? digest : digest.slice(0, 12);
}

/* ── payload helpers ───────────────────────────────────────────────── */

function str(value: unknown): string | undefined
{
    return value === undefined || value === null ? undefined : String(value);
}

function list(value: unknown): string[]
{
    return Array.isArray(value) ? value.map(String) : [];
}

function domains(value: unknown): SemanticDomain[]
{
    if (!Array.isArray(value))
    {
        return [];
    }
    return value.map((item) => ({ name: String(item.name), version: Number(item.version ?? 1) }));
}

function tests(value: unknown): TestResult[]
{
    if (!Array.isArray(value))
    {
        return [];
    }
    return value.map((item) => ({ name: String(item.name), status: String(item.status) }));
}

function commands(value: unknown): AttemptCommand[]
{
    if (!Array.isArray(value))
    {
        return [];
    }
    return value.map((item) => ({ command: String(item.command), exit: Number(item.exit) }));
}

function artifactOf(value: unknown): ReceiptArtifact | undefined
{
    if (value === undefined || value === null || typeof value !== "object")
    {
        return undefined;
    }
    const item = value as Record<string, unknown>;
    return { id: String(item.id), name: String(item.name), path: String(item.path), sha256: String(item.sha256) };
}

function scopeOf(value: unknown): ReviewScope
{
    return REVIEW_SCOPES.includes(value as ReviewScope) ? value as ReviewScope : "change";
}

function verdictOf(value: unknown): ReviewVerdict
{
    return REVIEW_VERDICTS.includes(value as ReviewVerdict) ? value as ReviewVerdict : "reject";
}

function actionOf(value: unknown): "rebase" | "resolve" | "merge"
{
    return value === "resolve" || value === "merge" ? value : "rebase";
}

function outcomeOf(value: unknown): AttemptStatus
{
    return value === "conflict" || value === "failed" || value === "cancelled" ? value : "completed";
}
