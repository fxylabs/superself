import { homedir } from "node:os";

export const REDACTED = "«redacted»";

// Values the caller knows are secret — the environment variables the plan
// declared. A prompt-injected echo of one of them is caught by value even when
// it arrives in prose that matches no pattern.
export interface RedactionScope
{
    literals: string[];
}

// Ordered from most specific to least: a bearer header must be caught as a
// header before the generic high-entropy rule turns only its token into noise
// and leaves the scheme readable.
const PATTERNS: [RegExp, string][] = [
    [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
    [/\b(set-cookie|cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`],
    [/\b([A-Za-z0-9_.-]*(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*"?)([^\s"',;]{4,})/gi, `$1$2${REDACTED}`],
    [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
    [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
    [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED]
];

// The backstop for a credential no named pattern knows: long, and varied the
// way a generated key is varied. Length alone is not the test — this module
// runs over every byte of provider output the spool keeps, and a rule that
// takes a long run of ordinary output with it would truncate exactly the
// results the spool exists to preserve.
const DENSE = /\b(?![0-9a-f]{32,}\b)[A-Za-z0-9_-]{40,}\b/g;

const MIN_DISTINCT = 12;

function looksGenerated(token: string): boolean
{
    return /[0-9]/.test(token) && /[A-Za-z]/.test(token) && new Set(token).size >= MIN_DISTINCT;
}

// Everything a spool keeps goes through at least this. A private path is not
// a secret to the machine that owns the spool, so the home rewrite is a
// separate step: applied to raw provider output and to anything crossing into
// the synced log, withheld where the machine's own records need real paths.
export function redactSecrets(text: string, scope: RedactionScope = { literals: [] }): string
{
    let out = text;
    for (const literal of scope.literals)
    {
        if (literal.length >= 4)
        {
            out = out.split(literal).join(REDACTED);
        }
    }
    for (const [pattern, replacement] of PATTERNS)
    {
        out = out.replace(pattern, replacement);
    }
    return out.replace(DENSE, (token) => looksGenerated(token) ? REDACTED : token);
}

export function redact(text: string, scope: RedactionScope = { literals: [] }): string
{
    return redactHome(redactSecrets(text, scope));
}

// A spool is machine-local, but its sanitized summaries travel into synced
// events, and a home directory names the person who ran the attempt.
export function redactHome(text: string): string
{
    const home = homedir();
    return home === "" || home === "/" ? text : text.split(home).join("~");
}

// Environment values are never written anywhere, so a declared secret enters
// redaction by value without the plan ever carrying it.
export function scopeFor(secretNames: string[]): RedactionScope
{
    const literals: string[] = [];
    for (const name of secretNames)
    {
        const value = process.env[name];
        if (value !== undefined && value.trim() !== "")
        {
            literals.push(value);
        }
    }
    return { literals };
}
