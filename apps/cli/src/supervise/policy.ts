import { readEvents } from "../logfile.js";
import { CliError } from "../types.js";

// Actions no overnight policy can grant. They are constants rather than
// settings because the boundary they guard is human approval itself: a
// policy that could widen them would be a policy that approves on the
// human's behalf.
export const FORBIDDEN_ACTIONS = [
    "publish",
    "outreach",
    "payment",
    "purchase",
    "provision",
    "destructive",
    "policy-change"
];

export interface OvernightPolicy
{
    version: number;
    setAt: string;
    from: string;
    to: string;
    wake: string;
    projects: string[];
    riskClasses: string[];
    kinds: string[];
    maxConcurrent: number;
    budgetUsd: number | null;
    maxRetries: number;
    circuitThreshold: number;
    autoDispatch: boolean;
    requireHardModel: string | null;
    requireFreshReview: boolean;
}

export const DEFAULT_CIRCUIT_THRESHOLD = 3;

export function validTime(value: string, flag: string): string
{
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    {
        throw new CliError(`${flag} expects a 24-hour time like 22:00, not "${value}"`);
    }
    return value;
}

export function forbiddenAction(actions: string[]): string | null
{
    return actions.find((action) => FORBIDDEN_ACTIONS.includes(action.toLowerCase())) ?? null;
}

// The policy is asserted state, so it folds out of the synced log like every
// other decision: the newest set wins, and a revocation leaves none.
export function loadPolicy(storeDir: string, slug: string): OvernightPolicy | null
{
    let policy: OvernightPolicy | null = null;
    for (const event of readEvents(storeDir, slug))
    {
        if (event.type === "overnight.policy.set")
        {
            policy = event.payload.policy as unknown as OvernightPolicy;
        }
        if (event.type === "overnight.policy.revoked")
        {
            policy = null;
        }
    }
    return policy;
}

export function policyVersion(storeDir: string, slug: string): number
{
    let version = 0;
    for (const event of readEvents(storeDir, slug))
    {
        if (event.type === "overnight.policy.set")
        {
            version = Number((event.payload.policy as { version?: number }).version ?? version);
        }
    }
    return version;
}

function minutes(time: string): number
{
    const [hour, minute] = time.split(":").map((part) => Number.parseInt(part, 10));
    return hour * 60 + minute;
}

function localMinutes(now: Date): number
{
    return now.getHours() * 60 + now.getMinutes();
}

// A window that starts at 22:00 and ends at 07:00 crosses midnight, so the
// comparison flips rather than the times being sorted.
export function inWindow(policy: OvernightPolicy, now: Date): boolean
{
    const start = minutes(policy.from);
    const end = minutes(policy.to);
    if (start === end)
    {
        return true;
    }
    const at = localMinutes(now);
    return start < end ? at >= start && at < end : at >= start || at < end;
}

export function pastWake(policy: OvernightPolicy, now: Date): boolean
{
    return localMinutes(now) >= minutes(policy.wake) && !inWindow(policy, now);
}

export interface PolicyRefusal
{
    reason: string;
}

// Every gate the policy owns, in one place, so the daemon and a manual run
// answer the question the same way.
export function policyRefusal(
    policy: OvernightPolicy | null,
    project: string,
    riskClass: string,
    kind: string,
    now: Date
): PolicyRefusal | null
{
    if (policy === null)
    {
        return { reason: "no overnight policy is in force" };
    }
    if (!policy.autoDispatch)
    {
        return { reason: "the overnight policy does not allow dependencies to auto-dispatch" };
    }
    if (!inWindow(policy, now))
    {
        return { reason: `outside the overnight window ${policy.from}–${policy.to}` };
    }
    if (!policy.projects.includes(project))
    {
        return { reason: `project "${project}" is not in the overnight policy` };
    }
    if (!policy.riskClasses.includes(riskClass))
    {
        return { reason: `risk class "${riskClass}" is not allowed overnight` };
    }
    if (!policy.kinds.includes(kind))
    {
        return { reason: `work kind "${kind}" is not allowed overnight` };
    }
    return null;
}

export function describePolicy(policy: OvernightPolicy): string[]
{
    return [
        `window        ${policy.from}–${policy.to} (wake ${policy.wake})`,
        `version       ${policy.version}, set ${policy.setAt.slice(0, 16).replace("T", " ")}`,
        `projects      ${policy.projects.join(", ")}`,
        `risk classes  ${policy.riskClasses.join(", ")}`,
        `work kinds    ${policy.kinds.join(", ")}`,
        `concurrency   ${policy.maxConcurrent}`,
        `budget        ${policy.budgetUsd === null ? "unlimited" : `$${policy.budgetUsd}`}`,
        `retries       ${policy.maxRetries} per attempt, circuit opens at ${policy.circuitThreshold}`,
        `auto-dispatch ${policy.autoDispatch ? "on" : "off"}`,
        `hard model    ${policy.requireHardModel ?? "not required"}`,
        `fresh review  ${policy.requireFreshReview ? "required before any work is done" : "not required"}`,
        `never allowed ${FORBIDDEN_ACTIONS.join(", ")}`
    ];
}
