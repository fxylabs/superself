import { CliError } from "../types.js";

// A synced event may carry what happened, never what the run saw. Keys are
// checked rather than values alone, so a leak is refused at the boundary
// instead of being noticed later in someone else's clone.
const FORBIDDEN_KEYS = [
    "prompt", "prompts", "env", "environ", "environment", "stdout", "stderr", "output", "outputs",
    "cookie", "cookies", "authorization", "auth", "pid", "processid", "command", "cmd", "argv",
    "cwd", "homedir", "spool", "pii", "email", "phone", "handle"
];

const FORBIDDEN_FRAGMENTS = ["secret", "password", "passwd", "token", "apikey", "credential", "private"];

const SECRET_PATTERNS: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\bghp_[A-Za-z0-9]{16,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
    /\b(?:api[_-]?key|secret|token|password)\s*[=:]\s*\S+/gi
];

function normalize(key: string): string
{
    return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function forbiddenKey(key: string): boolean
{
    const name = normalize(key);
    return FORBIDDEN_KEYS.includes(name) || FORBIDDEN_FRAGMENTS.some((fragment) => name.includes(fragment));
}

// Values are redacted rather than refused: a report written by a person is
// legitimate prose that must survive, minus anything shaped like a credential.
export function redact(text: string): string
{
    let out = text;
    for (const pattern of SECRET_PATTERNS)
    {
        out = out.replace(pattern, "[redacted]");
    }
    return out;
}

export function assertSanitized(payload: Record<string, unknown>): void
{
    walk(payload, "");
}

function walk(value: unknown, path: string): void
{
    if (Array.isArray(value))
    {
        value.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
    }
    if (value === null || typeof value !== "object")
    {
        return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
    {
        if (forbiddenKey(key))
        {
            throw new CliError(`refusing to sync "${path === "" ? key : `${path}.${key}`}" — process handles, raw output, and credentials stay machine-local`);
        }
        walk(child, path === "" ? key : `${path}.${key}`);
    }
}

// Redacts every string in a payload in place of the caller having to remember
// which field came from a machine.
export function redactPayload(payload: Record<string, unknown>): Record<string, unknown>
{
    return mapStrings(payload) as Record<string, unknown>;
}

function mapStrings(value: unknown): unknown
{
    if (typeof value === "string")
    {
        return redact(value);
    }
    if (Array.isArray(value))
    {
        return value.map(mapStrings);
    }
    if (value === null || typeof value !== "object")
    {
        return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
    {
        out[key] = mapStrings(child);
    }
    return out;
}
