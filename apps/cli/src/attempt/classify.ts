// Why an attempt did not produce a verified result. The class decides what
// happens next, so it is recorded on every failure and is never inferred a
// second time from prose.
export type FailureClass =
    | "transient-provider"
    | "transient-network"
    | "capability"
    | "policy"
    | "task"
    | "validation"
    | "cancelled"
    | "unknown";

export function isTransient(failure: FailureClass): boolean
{
    return failure === "transient-provider" || failure === "transient-network";
}

const NETWORK_CODES = ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"];
const NETWORK_PHRASES = ["getaddrinfo", "dns lookup failed", "socket hang up", "network is unreachable", "connection reset"];
const PROVIDER_PHRASES = ["429", "500", "502", "503", "504", "529", "overloaded", "rate limit", "rate_limit", "internal server error", "service unavailable", "upstream connect error", "api error"];
const POLICY_PHRASES = ["not authorized", "permission denied by policy", "forbidden by policy", "requires approval", "policy denied"];

export interface FailureSignal
{
    // What the agent itself declared, when it declared anything. A structured
    // claim outranks pattern matching over its own output.
    declared?: string;
    exitCode: number | null;
    signal: string | null;
    stderr: string;
    timedOut: boolean;
    spawnCode?: string;
}

// Order matters. What the runner watched happen outranks what the child says
// about it — a run the runner killed on its own bound did not end the way the
// child claims, and a launcher that never started the child leaves nobody to
// claim anything. After that a declared class is authoritative, then the most
// specific evidence wins, and everything unrecognised stays `unknown` rather
// than being flattened into a retryable class the runner would then spend
// budget on.
export function classify(signal: FailureSignal): FailureClass
{
    if (signal.timedOut)
    {
        return "unknown";
    }
    if (signal.spawnCode === "ENOENT" || signal.spawnCode === "EACCES" || signal.spawnCode === "EPERM")
    {
        return "capability";
    }
    const declared = normalizeDeclared(signal.declared);
    if (declared !== null)
    {
        return declared;
    }
    const text = signal.stderr.toLowerCase();
    if (NETWORK_CODES.some((code) => text.includes(code.toLowerCase())) || NETWORK_PHRASES.some((phrase) => text.includes(phrase)))
    {
        return "transient-network";
    }
    if (PROVIDER_PHRASES.some((phrase) => text.includes(phrase)))
    {
        return "transient-provider";
    }
    if (POLICY_PHRASES.some((phrase) => text.includes(phrase)))
    {
        return "policy";
    }
    if (text.includes("eacces") || text.includes("eperm") || text.includes("erofs"))
    {
        return "capability";
    }
    if (signal.signal === "SIGKILL" || signal.signal === "SIGTERM")
    {
        return "unknown";
    }
    // A clean non-zero exit with nothing recognisable in it is the agent
    // saying the task failed, not the runtime saying it broke.
    return signal.exitCode !== null && signal.exitCode !== 0 ? "task" : "unknown";
}

// Whether the child's own declaration, rather than anything the runner
// observed, is what produced this class. The gate distrusts the child
// everywhere else, and a child that names its own failure transient can
// otherwise spend the whole retry budget and push the shared provider breaker
// toward opening for unrelated queued work.
export function fromDeclaration(signal: FailureSignal): boolean
{
    return normalizeDeclared(signal.declared) !== null && classify(signal) !== classify({ ...signal, declared: undefined });
}

const CLASSES: FailureClass[] = [
    "transient-provider",
    "transient-network",
    "capability",
    "policy",
    "task",
    "validation",
    "cancelled",
    "unknown"
];

export function normalizeDeclared(value: string | undefined): FailureClass | null
{
    if (value === undefined)
    {
        return null;
    }
    const wanted = value.trim().toLowerCase();
    return CLASSES.find((item) => item === wanted) ?? null;
}
