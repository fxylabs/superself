import { homedir } from "node:os";
import { isEventId } from "./ids.js";

const REDACTED = "«redacted»";

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
// `device[_-]?code` joins the list for PR7: a device code is a 256-bit secret
// that lives only in process memory for the length of a login, and by
// construction nothing writes it anywhere this module reads. It is here as
// defence in depth, alongside the `token` rule that already covers
// `access_token` and `refresh_token` — a name that says the value beside it is
// a credential is exactly what this list is for, whether or not any code path
// currently produces it.
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|device[_-]?code|credential)[A-Za-z0-9_.-]*`;

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
//
// The name is what a refusal says matched. It is the one part of a refusal an
// operator can act on — the value cannot be printed — so it stays short,
// stable, and about the encoding rather than the vendor's marketing name.
// `lead` is the part of a match the pattern itself fixed — a vendor prefix, an
// armour line — as opposed to the part the value chose. A rule that blanks its
// whole span has nothing left to show a refusal, and this is the only piece of
// the span that can be shown: every character outside it came from the secret.
interface Rule
{
    name: string;
    pattern: RegExp;
    replacement: string;
    eager?: boolean;
    lead?: RegExp;
}

const PATTERNS: Rule[] = [
    { name: "auth-scheme", pattern: /\b(bearer|basic|token)[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}`, eager: true },
    { name: "auth-header", pattern: /\b(set-cookie|cookie|authorization|proxy-authorization)[ \t]*:[ \t]*[^\r\n]+/gi, replacement: `$1: ${REDACTED}` },
    // JSON is the encoding the spool itself writes — the plan, the status, and
    // every structured line go through JSON.stringify — and the key's own
    // closing quote sits between the name and the colon, where a rule written
    // for `NAME=value` cannot reach it. The replacement stays a quoted string
    // because these files are read back with JSON.parse.
    { name: "secret-json-field", pattern: new RegExp(String.raw`("${SECRET_NAME}"[ \t]*:[ \t]*)"(?:[^"\\\r\n]|\\.)+"`, "gi"), replacement: `$1"${REDACTED}"` },
    { name: "secret-assignment", pattern: new RegExp(String.raw`\b(${SECRET_NAME})([ \t]*[:=][ \t]*"?)([^\s"',;]{4,})`, "gi"), replacement: `$1$2${REDACTED}` },
    { name: "provider-key", pattern: /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, replacement: REDACTED, lead: /^(?:sk|rk|pk)-/ },
    { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: REDACTED, lead: /^gh[pousr]_/ },
    { name: "aws-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED, lead: /^AKIA/ },
    { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED, lead: /^xox[abposr]-/ },
    { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: REDACTED, lead: /^eyJ/ },
    // The armour line names the block a key travels in, so refusing does not
    // wait on the body's entropy: a private key is refused at its header even
    // when every base64 line of it reads like ordinary output. Both armour
    // lines match, so a redacted block cannot read as sanitized while its body
    // rides along beneath the blanked header. The body itself is left to the
    // backstops below, which is the only place it can be left — a rule reaching
    // from one armour line to the other would cross the line boundary the raw
    // spool cuts on.
    { name: "pem-key", pattern: /-----(?:BEGIN|END)[ \t]+[A-Z0-9 ]*PRIVATE[ \t]+KEY-----/g, replacement: REDACTED, lead: /^-----(?:BEGIN|END)[ \t]+[A-Z0-9 ]*PRIVATE[ \t]+KEY-----$/ }
];

// The backstop for a credential no named pattern knows: long, and varied the
// way a generated key is varied. Length alone is not the test — this module
// runs over every byte of provider output the spool keeps, and a rule that
// takes a long run of ordinary output with it would truncate exactly the
// results the spool exists to preserve.
const DENSE = /\b(?![0-9a-f]{32,}\b)[A-Za-z0-9_-]{40,}\b/g;

// A line that is nothing but base64 is the encoding a key body travels in, and
// '+' and '/' break such a line into pieces the span above never sees as one
// token. So the span is a whole line rather than a wider character class: '/'
// also joins a path and a URL, and adding it above would make a commit sha
// inside a link arm the backstop on every link anyone records. A digest is
// excluded for the same reason it is excluded above — a sha is a name of
// state, not a secret.
const BASE64_LINE = /^(?![0-9a-f]{32,}={0,2}(?:\r?$))[A-Za-z0-9+/]{40,}={0,2}(?=\r?$)/gm;

// Both spans are judged rather than replaced outright, and by the same reading,
// so what the redaction pass blanks is exactly what a refusal refuses.
const BACKSTOPS: Rule[] = [
    { name: "high-entropy", pattern: DENSE, replacement: REDACTED },
    { name: "base64-body", pattern: BASE64_LINE, replacement: REDACTED }
];

const MIN_DISTINCT = 12;

// Below this a declared literal is not redacted by value: taking two
// characters out of every word that happens to contain them would shred
// ordinary output. The floor is exported so a plan that declares a secret this
// short is told at launch rather than silently receiving no coverage.
const MIN_LITERAL = 4;

// A generated key is one unbroken run of mixed characters; a name a person
// assembled is short words joined by separators. Judging the whole token
// confuses the two — `2026-07-28-superself-pr68-fresh-review-14adc0c` is long
// and varied as a token, but every unbroken run inside it is a date fragment
// or a word. So the judgment is per run: only a stretch no separator breaks,
// long enough and varied enough, says the token was generated.
//
// A separator inside the key itself is the other half of the question. base64url
// puts '-' and '_' wherever the bytes fall, so a generated token whose
// separators happen to land close together has no long run at all. A second
// reading catches those: several runs the length of a word, each mixing digits
// into it the way no word does, is a token that was generated too. The dated
// name above fails both readings — its runs are a pure-digit date, pure-alpha
// words, and fragments too short to count.
//
// Both readings are accident-grade, and that is all they claim: they catch a
// credential that arrived verbatim in output nobody meant to write. A writer
// intent on encoding one past them can break the runs by hand, as cheaply as a
// single inserted space defeated the whole-token judgment that came before, and
// no test made at record time can close that.
const MIN_RUN = 16;

// A run this long that mixes digits into letters is not a word. Two of them in
// one token is the reading that survives separators; one alone is an ordinary
// short sha or a versioned word, which names carry all the time.
const MIN_MIXED_RUN = 8;
const MIN_MIXED_RUNS = 2;

// An id this store minted is dropped before either reading runs, because it is
// generated and is supposed to be: a note naming two decisions by their event
// ids reads exactly like a key to both readings, and the store is the one place
// those ids belong (#133). Only the id itself is exempt — every other run in
// the token is judged as before, so a credential travelling beside an id is
// still refused, and a token that is nothing but ids is what this frees.
function looksGenerated(token: string): boolean
{
    const runs = (token.match(/[A-Za-z0-9]+/g) ?? []).filter((run) => !isEventId(run));
    return runs.some(generatedRun) || runs.filter(mixedRun).length >= MIN_MIXED_RUNS;
}

function generatedRun(run: string): boolean
{
    return run.length >= MIN_RUN && mixedRun(run) && new Set(run).size >= MIN_DISTINCT;
}

function mixedRun(run: string): boolean
{
    return run.length >= MIN_MIXED_RUN && /[0-9]/.test(run) && /[A-Za-z]/.test(run);
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
// `declared` is the environment the plan itself supplies — a value it wrote
// down rather than one it named. A declared secret can arrive either way and
// both are covered, because the child receives the merged environment and the
// runner's own has no reason to hold a literal somebody put in a plan file.
export function scopeFor(secretNames: string[], declared: Record<string, string> = {}): RedactionScope
{
    const literals: string[] = [];
    for (const name of secretNames)
    {
        for (const value of [declared[name], process.env[name]])
        {
            if (value !== undefined && value.trim() !== "" && value.length >= MIN_LITERAL)
            {
                literals.push(value);
            }
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

// What a refusal is allowed to say about the match: the rule that fired, and
// the span as redaction would leave it. Together they let an operator rephrase
// without guessing, which a bare "shaped like a credential" never did.
interface CredentialMatch
{
    rule: string;
    preview: string;
}

export function findCredential(text: string): CredentialMatch | null
{
    for (const rule of PATTERNS)
    {
        for (const [span] of text.matchAll(rule.pattern))
        {
            if (rule.eager !== true || carriesKeyMaterial(span))
            {
                return { rule: rule.name, preview: preview(span, rule) };
            }
        }
    }
    // The backstops are eager by construction, and hold themselves back the
    // same way the redaction pass does.
    for (const rule of BACKSTOPS)
    {
        for (const [span] of text.matchAll(rule.pattern))
        {
            if (looksGenerated(span))
            {
                return { rule: rule.name, preview: preview(span, rule) };
            }
        }
    }
    return null;
}

// The matched span with its value blanked the way redaction would blank it, so
// the shape shows and the secret never does.
//
// A rule that blanks its whole span leaves nothing to locate the match by, and
// the head of the span is not available to fill the gap: for the backstop the
// head is the secret's own first characters, and behind a vendor prefix it is
// the secret's first characters too. So what is kept is what the pattern
// itself fixed — `sk-`, `ghp_`, an armour line — and the rest is a count of
// how long the value was, which the message already implied by refusing it.
function preview(span: string, rule: Rule): string
{
    const redacted = span.replace(rule.pattern, rule.replacement);
    if (redacted !== REDACTED)
    {
        return redacted;
    }
    const lead = rule.lead === undefined ? "" : span.match(rule.lead)?.[0] ?? "";
    return lead === span ? span : `${lead}${REDACTED} (${span.length} chars)`;
}

// The shape an opaque bearer token takes when it is not a vendor's: a UUID is
// hex fragments no reading above counts as generated, and `bearer <uuid>` is a
// credential however its runs measure.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

// Whether a matched span carries a run of characters that looks like generated
// key material rather than like a word someone wrote. The UUID shape is asked
// only here, inside a span an eager rule already matched: a UUID standing on
// its own in prose is an identifier, and this product writes them.
function carriesKeyMaterial(text: string): boolean
{
    return UUID.test(text) || (text.match(/[A-Za-z0-9_-]+/g) ?? []).some(looksGenerated);
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
