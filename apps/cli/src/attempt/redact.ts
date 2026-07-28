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
// A rule is eager when ordinary prose can match it: the first blanks whatever
// word follows "token", which costs nothing in provider output and is not a
// credential in a sentence. Redaction runs every rule the same way, but a
// caller that refuses a payload instead of rewriting it has to tell the two
// kinds apart — the rest of these are encodings nothing but a credential
// produces, at whatever entropy the value happens to have.
interface Rule
{
    pattern: RegExp;
    replacement: string;
    eager?: boolean;
}

const PATTERNS: Rule[] = [
    { pattern: /\b(bearer|basic|token)[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}`, eager: true },
    { pattern: /\b(set-cookie|cookie|authorization|proxy-authorization)[ \t]*:[ \t]*[^\r\n]+/gi, replacement: `$1: ${REDACTED}` },
    // JSON is the encoding the spool itself writes — the plan, the status, and
    // every structured line go through JSON.stringify — and the key's own
    // closing quote sits between the name and the colon, where a rule written
    // for `NAME=value` cannot reach it. The replacement stays a quoted string
    // because these files are read back with JSON.parse.
    { pattern: new RegExp(String.raw`("${SECRET_NAME}"[ \t]*:[ \t]*)"(?:[^"\\\r\n]|\\.)+"`, "gi"), replacement: `$1"${REDACTED}"` },
    { pattern: new RegExp(String.raw`\b(${SECRET_NAME})([ \t]*[:=][ \t]*"?)([^\s"',;]{4,})`, "gi"), replacement: `$1$2${REDACTED}` },
    { pattern: /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, replacement: REDACTED },
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: REDACTED },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
    { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED },
    { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: REDACTED }
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
    let out = redactLiterals(text, scope);
    for (const { pattern, replacement } of PATTERNS)
    {
        out = out.replace(pattern, replacement);
    }
    return out.replace(DENSE, (token) => looksGenerated(token) ? REDACTED : token);
}

// The declared half of redaction on its own. A caller that has to tell a leaked
// declared value from a value that merely looks like a credential cannot get
// that from the combined pass: the patterns rewrite the same span either way.
export function redactLiterals(text: string, scope: RedactionScope): string
{
    let out = text;
    for (const literal of scope.literals)
    {
        if (literal.length >= MIN_LITERAL)
        {
            out = out.split(literal).join(REDACTED);
        }
    }
    return out;
}

export function redact(text: string, scope: RedactionScope = { literals: [] }): string
{
    return redactHome(redactSecrets(text, scope));
}

// A spool is machine-local, but its sanitized summaries travel into synced
// events, and a home directory names the person who ran the attempt.
//
// One directory can be written more than one way and still open the same file:
// macOS and Windows resolve a path without regard to case, and a home
// directory holding a non-ASCII character arrives composed from one program
// and decomposed from another. A byte-exact split lets those spellings through
// while they still name the person, so every spelling that resolves here is
// folded together.
//
// The pattern is built once per home directory, because this runs over every
// byte a spool keeps.
let homeRule: { home: string, pattern: RegExp } | null = null;

export function redactHome(text: string): string
{
    const home = homedir();
    if (home === "" || home === "/")
    {
        return text;
    }
    if (homeRule === null || homeRule.home !== home)
    {
        homeRule = { home, pattern: homePattern(home) };
    }
    return text.replace(homeRule.pattern, "~");
}

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

function homePattern(home: string): RegExp
{
    const spellings = [...new Set([home, home.normalize("NFC"), home.normalize("NFD")])];
    const escaped = spellings.map((spelling) => spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(escaped.join("|"), CASE_INSENSITIVE_FS ? "gi" : "g");
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

// Whether a name says the value beside it is a credential — of an environment
// variable, or of a field in a record. The rule is the one the patterns above
// are built from, so a name learned there is known to every caller without a
// second list to keep in step.
const SECRET_NAMED = new RegExp(`^${SECRET_NAME}$`, "i");

export function namesSecret(name: string): boolean
{
    return SECRET_NAMED.test(name);
}

export function secretEnvNames(): string[]
{
    return Object.keys(process.env).filter(namesSecret);
}

// Whether the text carries something only a credential produces — the question
// a caller that refuses outright has to answer, where redaction only has to
// decide which bytes to blank.
//
// Each rule is judged where it matched, never over the string around it. An
// eager rule is held to key material inside its own span, so "reduced token
// counting overhead" stays recordable while `Bearer <key>` does not; the
// explicit encodings are a leak whatever their entropy, which is the case a
// pasted config snippet and a human-chosen password fall into. Judging the
// whole string instead would let a commit sha or a branch slug anywhere in a
// sentence arm the eager rules, and would disarm the explicit ones for exactly
// the short secrets that most need refusing.
export function carriesCredential(text: string): boolean
{
    for (const { pattern, eager } of PATTERNS)
    {
        for (const [span] of text.matchAll(pattern))
        {
            if (eager !== true || carriesKeyMaterial(span))
            {
                return true;
            }
        }
    }
    // The backstop is eager by construction, and holds itself back the same way
    // the redaction pass does.
    for (const [span] of text.matchAll(DENSE))
    {
        if (looksGenerated(span))
        {
            return true;
        }
    }
    return false;
}

// Whether a matched span carries a run of characters that looks like generated
// key material rather than like a word someone wrote.
function carriesKeyMaterial(text: string): boolean
{
    return (text.match(/[A-Za-z0-9_-]+/g) ?? []).some(looksGenerated);
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
