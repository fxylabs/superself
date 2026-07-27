// The launcher owns what a run may do. Nothing a worker says about itself —
// its registration flags, its completion envelope, its prose — can widen this
// table, because the table is what stands in for a human who is not awake to
// be asked.

// An allowlist, not a denylist. A denylist grants every capability nobody
// thought to name, which is exactly how "http-post" or "deploy" would have
// slipped through as an unrecognised, therefore permitted, action.
export const ALLOWED_ACTIONS = [
    "read",
    "write-workspace",
    "build",
    "test",
    "lint",
    "typecheck",
    "analyze",
    "search-local",
    "format",
    "commit-local"
];

// Named so a refusal can say which boundary it is holding rather than only
// that the action was unknown.
export const FORBIDDEN_ACTIONS = [
    "publish",
    "outreach",
    "payment",
    "purchase",
    "provision",
    "destructive",
    "policy-change",
    "credential-forward",
    "network"
];

export interface CapabilityDecision
{
    granted: string[];
    refused: string[];
    reason: string | null;
}

function normalizeAction(action: string): string
{
    return action.trim().toLowerCase();
}

export function forbiddenAction(actions: string[]): string | null
{
    return actions.map(normalizeAction).find((action) => FORBIDDEN_ACTIONS.includes(action)) ?? null;
}

// Returns what the launcher is willing to grant. An action that is neither
// allowed nor explicitly forbidden is still refused: the profile grants, it
// does not tolerate.
export function decideCapabilities(riskClass: string, requested: string[]): CapabilityDecision
{
    const asked = requested.map(normalizeAction).filter((action) => action !== "");
    const forbidden = asked.filter((action) => FORBIDDEN_ACTIONS.includes(action));
    if (forbidden.length > 0)
    {
        return {
            granted: [],
            refused: forbidden,
            reason: `"${forbidden[0]}" needs human approval and no overnight policy can grant it — never allowed: ${FORBIDDEN_ACTIONS.join(", ")}`
        };
    }
    const unknown = asked.filter((action) => !ALLOWED_ACTIONS.includes(action));
    if (unknown.length > 0)
    {
        return {
            granted: [],
            refused: unknown,
            reason: `"${unknown[0]}" is not a capability the launcher grants — allowed: ${ALLOWED_ACTIONS.join(", ")}`
        };
    }
    if (riskClass !== "internal")
    {
        return {
            granted: [],
            refused: asked,
            reason: `risk class "${riskClass}" carries no unattended capability profile — external-risk work waits for a person`
        };
    }
    return { granted: [...new Set(asked)], refused: [], reason: null };
}

// Anything the envelope claims beyond what was granted is a lie the supervisor
// must catch, not a request it may honour.
export function widenedCapabilities(granted: string[], claimed: string[]): string[]
{
    const held = new Set(granted.map(normalizeAction));
    return [...new Set(claimed.map(normalizeAction).filter((action) => action !== "" && !held.has(action)))];
}

// The variables a local build genuinely needs, and nothing else. A full
// inherited environment hands every launched command the machine's provider
// keys, cloud credentials, and NODE_OPTIONS, so the launcher builds the
// environment rather than filtering one.
const ENV_ALLOWLIST = [
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TERM",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME"
];

export function sanitizedEnv(extra: Record<string, string>): NodeJS.ProcessEnv
{
    const env: NodeJS.ProcessEnv = {};
    for (const name of ENV_ALLOWLIST)
    {
        const value = process.env[name];
        if (value !== undefined)
        {
            env[name] = value;
        }
    }
    return { ...env, ...extra };
}
