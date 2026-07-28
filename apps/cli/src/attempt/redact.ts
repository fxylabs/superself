import { homedir } from "node:os";

export const REDACTED = "«redacted»";

// Values the caller knows are secret — the environment variables the plan
// declared. A prompt-injected echo of one of them is caught by value even when
// it arrives in prose that matches no pattern.
export interface RedactionScope
{
    literals: string[];
}

// A name that says the value beside it is a credential, whatever the value
// happens to look like. Written once and used by both encodings below, so the
// two can never learn about a new name separately.
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*`;

// Ordered from most specific to least: a bearer header must be caught as a
// header before the generic high-entropy rule turns only its token into noise
// and leaves the scheme readable.
//
// No rule here spans a line break, and that is a property the raw spool relies
// on: it decides where a stream of chunks can safely be redacted without a
// credential straddling the cut. Separators are written [ \t] rather than \s
// for that reason — and a header whose value sits on the next line is not a
// header anyway.
const PATTERNS: [RegExp, string][] = [
    [/\b(bearer|basic|token)[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
    [/\b(set-cookie|cookie|authorization|proxy-authorization)[ \t]*:[ \t]*[^\r\n]+/gi, `$1: ${REDACTED}`],
    // JSON is the encoding the spool itself writes — the plan, the status, and
    // every structured line go through JSON.stringify — and the key's own
    // closing quote sits between the name and the colon, where a rule written
    // for `NAME=value` cannot reach it. The replacement stays a quoted string
    // because these files are read back with JSON.parse.
    [new RegExp(String.raw`("${SECRET_NAME}"[ \t]*:[ \t]*)"(?:[^"\\\r\n]|\\.)+"`, "gi"), `$1"${REDACTED}"`],
    [new RegExp(String.raw`\b(${SECRET_NAME})([ \t]*[:=][ \t]*"?)([^\s"',;]{4,})`, "gi"), `$1$2${REDACTED}`],
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

// Below this a declared literal is not redacted by value: taking two
// characters out of every word that happens to contain them would shred
// ordinary output. The floor is exported so a plan that declares a secret this
// short is told at launch rather than silently receiving no coverage.
export const MIN_LITERAL = 4;

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
        if (literal.length >= MIN_LITERAL)
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
        if (value !== undefined && value.trim() !== "" && value.length >= MIN_LITERAL)
        {
            literals.push(value);
        }
    }
    return { literals };
}

// The names — never the values — of declared secrets too short to be redacted
// by value. The plan author believes the declaration covers them, and the one
// honest moment to say otherwise is before the attempt starts.
export function unredactableSecrets(secretNames: string[]): string[]
{
    return secretNames.filter((name) =>
    {
        const value = process.env[name];
        return value !== undefined && value.trim() !== "" && value.length < MIN_LITERAL;
    });
}

// Raw provider output arrives in chunks whose boundaries fall wherever the
// pipe happened to break. A credential split across two of them matches
// nothing on either side and both halves reach the log, so a chunk is not
// redacted where it ends: it is redacted up to the last boundary no rule can
// match across, and the rest is held until the bytes that would complete it
// arrive.
//
// Every pattern above is confined to one line, so a line break is that
// boundary. A declared literal is not: a private key carries line breaks of
// its own, and a cut on one of them splits the literal into two halves that
// match nothing. So the boundary has to hold against a literal twice over —
// the cut stays the longest literal back from the end of the buffer, which
// keeps a literal whose tail has not arrived yet out of the flush, and it
// steps back past any literal that has arrived and would be split.
const MAX_HELD = 1_048_576;

export function safeCut(pending: string, scope: RedactionScope): number
{
    // Only the literals redaction actually covers: a shorter one is left alone
    // by redactSecrets, so holding output back for it would buy nothing.
    const literals = scope.literals.filter((literal) => literal.length >= MIN_LITERAL);
    const reserve = Math.max(0, ...literals.map((literal) => literal.length - 1));
    const limit = pending.length - reserve;
    let cut = limit <= 0 ? 0 : lineStartBefore(pending, limit);
    for (let split = straddleStart(pending, cut, literals); cut > 0 && split !== -1; split = straddleStart(pending, cut, literals))
    {
        cut = lineStartBefore(pending, split);
    }
    if (cut > 0)
    {
        return cut;
    }
    // A provider that emits no line break at all must not be buffered without
    // bound; past this much held output the tail is written as it stands — at
    // a position that still splits no declared literal, because that is the
    // one thing this hold-back exists to prevent.
    return pending.length > MAX_HELD ? clearOfLiterals(pending, Math.max(0, limit), literals) : 0;
}

// The start of the line the given position sits on, which is where a cut may
// land without any pattern rule straddling it.
function lineStartBefore(pending: string, at: number): number
{
    return at <= 0 ? 0 : pending.lastIndexOf("\n", at - 1) + 1;
}

// Where the earliest declared literal that this cut would split begins, or -1
// when the cut splits none. Only the last occurrence starting before the cut
// can reach past it, so one search per literal answers it.
function straddleStart(pending: string, cut: number, literals: string[]): number
{
    let earliest = -1;
    for (const literal of literals)
    {
        const start = pending.lastIndexOf(literal, cut - 1);
        if (start !== -1 && start + literal.length > cut && (earliest === -1 || start < earliest))
        {
            earliest = start;
        }
    }
    return earliest;
}

// The forced flush has already given up the line boundary, so it steps back
// only as far as a split literal requires.
function clearOfLiterals(pending: string, cut: number, literals: string[]): number
{
    for (let at = cut; at > 0; )
    {
        const split = straddleStart(pending, at, literals);
        if (split === -1)
        {
            return at;
        }
        at = split;
    }
    return 0;
}
