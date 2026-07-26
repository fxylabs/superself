// The observable states of an accepted issue on its way to a machine that runs
// the published build. `released` is reached only when every piece of evidence
// in EVIDENCE (see gates.ts) exists; `failed` preserves the state it fell from
// so a retry never restarts the implementation.
export type DeliveryState =
    | "implementing"
    | "pr_ready"
    | "reviewing"
    | "fixing"
    | "merging"
    | "releasing"
    | "local_updating"
    | "released"
    | "failed";

export const STATES: DeliveryState[] = [
    "implementing",
    "pr_ready",
    "reviewing",
    "fixing",
    "merging",
    "releasing",
    "local_updating",
    "released",
    "failed"
];

export type CheckStatus = "green" | "red" | "pending";

export interface DeliveryEvent
{
    seq: number;
    ts: string;
    type: string;
    payload: Record<string, unknown>;
}

export interface PullRequest
{
    number: number;
    head: string;
    signedOff: boolean;
}

export interface CheckResult
{
    head: string;
    name: string;
    status: CheckStatus;
}

// One fresh review session. `findings` stays null until that session reports,
// so an abandoned review can never be mistaken for a clean one.
export interface ReviewRound
{
    round: number;
    session: string;
    head: string;
    findings: number | null;
}

export interface Release
{
    tag: string;
    packageVersion: string;
    npmVersion: string;
    releaseUrl: string;
}

export interface SmokeCheck
{
    name: string;
    passed: boolean;
    detail: string;
}

export interface Failure
{
    reason: string;
    from: DeliveryState;
}

export interface Delivery
{
    issue: number;
    state: DeliveryState;
    maxReviewRounds: number;
    requiredChecks: string[];
    implementationSession: string;
    pr: PullRequest | null;
    checks: CheckResult[];
    reviews: ReviewRound[];
    mergeCommit: string | null;
    release: Release | null;
    localVersion: string | null;
    smoke: SmokeCheck[];
    logs: string[];
    failure: Failure | null;
}

export class DeliveryError extends Error
{
}
