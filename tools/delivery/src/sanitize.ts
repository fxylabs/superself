import { homedir } from "node:os";

// Everything recorded here is quotable into a public issue comment, so the
// ledger is the boundary where credentials and machine paths stop. Redaction
// happens on the way in: a value that never entered the record cannot leak from
// a later render.
const SECRET_PATTERNS: RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bnpm_[A-Za-z0-9]{20,}/g,
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi,
    /\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi
];

// Long enough for a command result or a finding summary, short enough that a
// file dump or a workspace listing cannot ride along inside one.
const MAX_TEXT = 500;

export function sanitize(text: string): string
{
    let out = text;
    for (const pattern of SECRET_PATTERNS)
    {
        out = out.replace(pattern, "[redacted]");
    }
    out = maskHome(out).replace(/\s+/g, " ").trim();
    return out.length <= MAX_TEXT ? out : out.slice(0, MAX_TEXT - 1) + "…";
}

// A log reference is a pointer, never contents. The path still gets masked so
// the account name on this machine stays out of the record.
export function sanitizeReference(reference: string): string
{
    return sanitize(reference);
}

function maskHome(text: string): string
{
    const home = homedir();
    return home === "" || home === "/" ? text : text.split(home).join("~");
}
