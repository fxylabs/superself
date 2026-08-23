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
// A rule carries `refuseWhen` when ordinary prose can match it: the first
// blanks whatever word follows "token", which costs nothing in provider output
// and is not a credential in a sentence. Redaction runs every rule the same
// way, but a caller that refuses a payload instead of rewriting it has to tell
// the two kinds apart — the rules left unmarked are encodings nothing but a
// credential produces, at whatever entropy the value happens to have, and the
// rest name the second reading their own span has to pass before a refusal.
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
    refuseWhen?: (span: string) => boolean;
    lead?: RegExp;
}

const PATTERNS: Rule[] = [
    // A cookie header is the half of the old header rule that stays eager. Its
    // value is a session credential and nothing else: there is no documented
    // placeholder grammar for a `Set-Cookie` line, and a document that quotes
    // one is quoting a session. It goes first so a cookie line's refusal always
    // names the rule that actually decided it.
    { name: "cookie-header", pattern: /\b(set-cookie|cookie)[ \t]*:[ \t]*[^\r\n]+/gi, replacement: `$1: ${REDACTED}` },
    // A scheme word with no header in front of it. The value after it is read
    // exactly as the header rule below reads its own — the token measured whole
    // over the base64url alphabet, a `basic` value decoded — because a
    // credential written this way is the same credential (#347). Reading it as
    // prose instead is what recorded a sixteen-character base64url token four
    // times in ten: that alphabet puts '-' and '_' wherever the bytes fall, and
    // every prose reading here splits runs on both.
    //
    // What keeps the harder reading safe without a header name to license it is
    // the span. `bearer`, `basic` and `token` are English words as often as
    // scheme names, so the match is the scheme word and the one token after it
    // and never a character more: the rest of the sentence is not read, and
    // `the bearer token-refresh-window is 30 days` puts `token-refresh-window`
    // up for judgment and nothing else. The value's own alphabet is wide enough
    // to hold the shapes a document substitutes — `<token>`, `${API_TOKEN}`,
    // `$TOKEN` — because a bracket must not be the thing that excuses a value:
    // what excuses it is the name inside reading as a name.
    //
    // The residual, stated because it is real: an unbroken sixteen-character
    // run in that alphabet, written as the single token after one of the three
    // words, is refused whether it is a key or a note. `basic
    // auth/token-exchange-flow` and `token 2026-08-23-review-note` go with the
    // keys — a slash and a leading date are both outside what a name reads as.
    // It is a rephrase away, and the refusal names the rule and shows the span.
    // Nothing else that recorded as prose changes: a single-case hyphenated
    // phrase reads as a name at any length, and prose past the first token is
    // outside the match.
    { name: "auth-scheme", pattern: /\b(bearer|basic|token)[ \t]+[A-Za-z0-9._~+/=<>${}-]{8,}/gi, replacement: `$1 ${REDACTED}`, refuseWhen: carriesAuthCredential },
    // The other half, and the one an API document writes on purpose. An
    // `Authorization` header is the only header here whose value has a
    // published grammar — a scheme name, then the credential — and the scheme
    // is the part a document exists to show. `Authorization: Bearer <token>`
    // is that document, not a credential, and blanking the value on sight
    // refused every design artifact with an HTTP example in it (#319).
    //
    // So the value is judged by the reading the scheme rule above already
    // uses, on the wider span: the whole rest of the line, which is a superset
    // of what `auth-scheme` matched, so a credential behind a scheme name that
    // rule does not know — `SharedKey`, `Hawk` — is still caught here. What
    // stays refused is what a generator produces — an unbroken run at the key
    // bar in any alphabet, a JWT, a UUID, a decodable `basic` pair.
    { name: "auth-header", pattern: /\b(authorization|proxy-authorization)[ \t]*:[ \t]*[^\r\n]+/gi, replacement: `$1: ${REDACTED}`, refuseWhen: carriesAuthCredential },
    // JSON is the encoding the spool itself writes — the plan, the status, and
    // every structured line go through JSON.stringify — and the key's own
    // closing quote sits between the name and the colon, where a rule written
    // for `NAME=value` cannot reach it. The replacement stays a quoted string
    // because these files are read back with JSON.parse.
    { name: "secret-json-field", pattern: new RegExp(String.raw`("${SECRET_NAME}"[ \t]*:[ \t]*)"(?:[^"\\\r\n]|\\.)+"`, "gi"), replacement: `$1"${REDACTED}"` },
    // Two halves of what was one rule, split by what the separator says. An
    // `=`, or a quoted value after either separator, is what a config file, an
    // export line or a pasted snippet writes and what no sentence writes, so
    // it stays refused at whatever entropy the value happens to have. That is
    // where a hand-chosen `api_key=hunter2` lives.
    { name: "secret-assignment", pattern: new RegExp(String.raw`\b(${SECRET_NAME})([ \t]*(?:=[ \t]*"?|:[ \t]*"))([^\s"',;]{4,})`, "gi"), replacement: `$1$2${REDACTED}` },
    // A bare colon is the other half, and it splits again by how much of the
    // line the value takes.
    //
    // The value running to the end of the line, with no space in it, is the
    // shape a Kubernetes manifest, a compose file and a CI variable write a
    // real secret in. So it is judged on shape rather than on what the value
    // looks like: what records is a short note that reads as words, and
    // everything else is refused. Reading the value instead is what let a
    // letters-only password, a digits-only device code and a base64 secret
    // access key through this rule at every length — no alphabet test can
    // separate `correcthorsebatterystaple` from a sentence, and length can.
    { name: "secret-line", pattern: new RegExp(String.raw`\b(${SECRET_NAME})([ \t]*:[ \t]*)([^\s"',;]{4,})[ \t]*(?=\r?\n|$)`, "gi"), replacement: `$1$2${REDACTED}`, refuseWhen: (span) => !readsAsWords(span) },
    // When something follows the value on the line instead — another word, a
    // comma, a parenthesised note — the line is a sentence, and a sentence
    // about an auth system labels credential fields on every other line:
    // `agent-scoped token: account_id, scopes[], expires_at` is a schema line
    // in a design document, not an assignment. Documents about auth systems
    // are exactly the artifacts a report attaches (#317), so this shape
    // refuses only where its own match carries key material.
    //
    // The gap both shapes leave, stated plainly because it is real: a value
    // under sixteen characters records unless it carries key material of its
    // own. `client_secret: s3cr3t` is caught, because a digit inside a word is
    // not prose; `password: hunter` is not. Nothing a generator produced is
    // that short, and a person who writes a fifteen-character password into a
    // design document is past what a record-time test can see.
    { name: "secret-label", pattern: new RegExp(String.raw`\b(${SECRET_NAME})([ \t]*:[ \t]*)([^\s"',;]{4,})`, "gi"), replacement: `$1$2${REDACTED}`, refuseWhen: carriesKeyMaterial },
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
            if (rule.refuseWhen === undefined || rule.refuseWhen(span))
            {
                return { rule: rule.name, preview: preview(span, rule) };
            }
        }
    }
    // The backstops match ordinary output by construction — they are nothing
    // but length and alphabet — so both hold back on the same reading the
    // redaction pass uses.
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

// The value a `name: value` line carries, which is everything after the
// separator. The name cannot hold a colon, so the first one is the separator;
// the value can hold one, because a URL does. Sentence punctuation at the end
// belongs to the sentence rather than to the value — a document writes
// `api_key: quarterly.` and the period is not part of the word.
function valueOf(span: string): string
{
    return span.slice(span.indexOf(":") + 1).trim().replace(/[.!?)\]}]+$/, "");
}

// The length at which an unbroken stretch of characters stops reading as
// something a person typed. It is the one bar no alphabet escapes: a generated
// key is long whether it is all letters, all digits or base64, and requiring a
// mix of the two instead is what let an all-letters password and an all-digits
// device code past every reading here at any length. Both places below measure
// against it, because they are asking the same question of the same kind of
// text — a value the name beside it already called a credential.
//
// The cost of the bar sitting here: a hyphenated note this long, written as the
// whole value of a `name:` line, is refused with the keys. That is a rephrase
// away, and the refusal names the rule and shows the span.
const MIN_KEY_RUN = 16;

// Whether a `name: value` line's value is a note somebody wrote rather than a
// value a machine produced: short, and made of letters joined by the
// separators a phrase uses. Both have to hold. Length alone would record
// `client_secret: s3cr3t`, and a digit inside a word is not how people write
// prose and is how people write passwords; the word shape alone would record
// `password: correcthorsebatterystaple`.
const WORDS = /^[A-Za-z]+(?:[._-][A-Za-z]+)*$/;

function readsAsWords(span: string): boolean
{
    const value = valueOf(span);
    return value.length < MIN_KEY_RUN && WORDS.test(value);
}

// The alphabet a key body is written in, split only where a key body never
// breaks. '+' and '/' are base64's last two characters, and splitting a value
// on them is what turned a forty-character secret access key into four short
// words that no reading here counted. '_' and '-' still split, because a person
// writes those into names and phrases — `idempotency_key`, `caller-supplied` —
// so a base64url value leaning on them can still slip this reading; the
// `secret-line` shape catches it on length, and in a sentence it is what the
// mixed-run reading was already for.
const KEY_RUN = /[A-Za-z0-9+/=]+/g;

// Whether a matched span carries a run of characters that looks like generated
// key material rather than like a word someone wrote. The UUID shape is asked
// only here, inside a span a prose-matching rule already matched: a UUID
// standing on its own in prose is an identifier, and this product writes them.
// An id this store minted is exempt for the same reason it is exempt from
// `looksGenerated` (#133).
function carriesKeyMaterial(text: string): boolean
{
    return UUID.test(text)
        || (text.match(/[A-Za-z0-9_-]+/g) ?? []).some(looksGenerated)
        || (text.match(KEY_RUN) ?? []).some(unbrokenKeyRun);
}

function unbrokenKeyRun(run: string): boolean
{
    return run.length >= MIN_KEY_RUN && !isEventId(run);
}

// What an auth span has to carry before it is refused. One reading for both
// rules above, because a credential does not change shape when the header name
// in front of it is dropped (#347) — what changes is how much text the rule
// reads, and each rule's own pattern settles that.
//
// Three readings together. The first is the one every prose-matching rule uses.
// The second measures the credential token whole, which is the reading the
// prose one cannot give: the prose reading has to split runs on '-' and '_',
// because a person writes those into names and phrases, and base64url puts both
// wherever the bytes fall. The third is `basic`, which adds the single thing
// neither can see — a Basic credential is often shorter than the run bar,
// because it is base64 of `user:password` and a short pair encodes short:
// `dXNlcjpwYXNz` is twelve characters and reads `user:pass`.
function carriesAuthCredential(span: string): boolean
{
    return carriesKeyMaterial(span) || carriesBasicCredential(span) || generatedAuthValue(span);
}

// An elision says the rest of the value was cut, and carries no name at all,
// so it always drops. What is left of the value is still measured, which is
// the whole point of dropping rather than allowlisting: `Bearer eyJ…` records
// and `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…` does not.
const ELISION = /\.{3}|…/g;

// The three ways a document brackets a name the reader is to substitute. The
// brackets alone decide nothing: what is inside them has to read as a name
// first, or wrapping a real token in angle brackets would be a way of writing
// it into a record, and the very punctuation a document uses would be the tool
// that let it through.
const BRACKETED_NAME = /<([^<>]*)>|\$\{([^{}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

// A name a person wrote, as opposed to a value a generator produced: one case
// throughout, and words joined by the separators a phrase uses. The single-case
// reading is the load-bearing half — base64url draws from both cases at every
// position, so a generated value that is all letters is almost never all one
// case, while every way a document spells a substitution is:
// `your-api-token-here`, `ACCESS_TOKEN`.
//
// A piece between two separators is a word or a number and never a mix of the
// two, which is the same distinction `readsAsWords` draws one screen up: a digit
// inside a word is not how people write prose and is how a generator writes
// everything. Letting a piece mix them is what still recorded a generated
// base64url value one time in twenty thousand — `o-0yjr9xyknif2p4` read as a
// lowercase name, and `YOUR_ACCESS_TOKEN_HERE` does not need it to (#347).
const LOWER_NAME = /^[a-z]+(?:[._-](?:[a-z]+|[0-9]+))*$/;
const UPPER_NAME = /^[A-Z]+(?:[._-](?:[A-Z]+|[0-9]+))*$/;

function readsAsName(name: string): boolean
{
    return LOWER_NAME.test(name) || UPPER_NAME.test(name);
}

// base64url is the alphabet an opaque token is written in, and it puts '-' and
// '_' wherever the bytes fall. So a credential token is measured over the
// whole of that alphabet: splitting on '-' and '_' the way the prose reading
// does is what let a sixteen-character base64url token past this rule four
// times in ten. Prose is not measured this way and does not have to be — the
// one token is all this reads.
const TOKEN_RUN = /[A-Za-z0-9+/=_-]+/g;

// A bare value — no brackets, no sigil — is read as a name only when it also
// carries a separator. `YOUR_ACCESS_TOKEN_HERE` and `your-token-goes-here` are
// how API documents spell a substitution without brackets, and a generated run
// has no separator to spell it with. Without that second half the reading
// would record `password: correcthorsebatterystaple`'s cousin here, a
// twenty-letter lowercase token, which is the leak #318 closed.
const SEPARATED = /[._-]/;

function generatedAuthValue(span: string): boolean
{
    return credentialTokens(span).map(withoutPlaceholders).some(generatedValue);
}

function generatedValue(value: string): boolean
{
    if (SEPARATED.test(value) && readsAsName(value))
    {
        return false;
    }
    return (value.match(TOKEN_RUN) ?? []).some(unbrokenKeyRun);
}

function withoutPlaceholders(value: string): string
{
    return value
        .replace(ELISION, " ")
        .replace(BRACKETED_NAME, (span, angle, braced, bare) => readsAsName(angle ?? braced ?? bare ?? "") ? " " : span);
}

// The credential inside an auth span. An HTTP credential is one token, and it
// is either the first token after the colon or the second, since a scheme name
// may stand in front of it. Both are read, and nothing past them is: what
// follows is prose about the header, and reading that too is what would refuse
// `Authorization: Bearer <token> — see docs/key-rotation-policy.md` over a
// hyphenated filename that is nobody's key.
//
// A bare scheme span carries no colon, so the whole span is the value and the
// same two tokens are the scheme word and the credential after it. That the
// scheme word is measured alongside costs nothing — `bearer`, `basic` and
// `token` are all shorter than the run bar.
//
// Reading both rather than deciding which one is the scheme is deliberate. A
// scheme name is not a closed set — `SharedKey`, `AWS4-HMAC-SHA256` and `Hawk`
// are all real — so any test for "is this the scheme" is a test a value can be
// shaped to pass, and the one that stood here could be passed by a hyphenated
// token with prose behind it.
function credentialTokens(span: string): string[]
{
    return span.slice(span.indexOf(":") + 1).trim().split(/[ \t]+/).slice(0, 2);
}

// The `basic` scheme names its own encoding, so its value can be decoded
// rather than measured, and no placeholder survives the decode: `<base64>` and
// `$CREDS` are not the base64 alphabet, a word of the wrong length is not a
// whole number of bytes, and a word that is decodes to bytes with no colon
// among them. What is left — two printable halves with a colon between them —
// is a username and a password at any length.
//
// Read as latin1 rather than utf8 so every byte maps to one character: a byte
// outside printable ASCII then fails the class instead of arriving as a
// replacement character that would pass it.
const BASIC_VALUE = /\bbasic[ \t]+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/i;
const PRINTABLE_PAIR = /^[\x20-\x7e]+:[\x20-\x7e]+$/;

function carriesBasicCredential(span: string): boolean
{
    const encoded = span.match(BASIC_VALUE)?.[1] ?? "";
    if (encoded.length < 4 || encoded.length % 4 !== 0)
    {
        return false;
    }
    return PRINTABLE_PAIR.test(Buffer.from(encoded, "base64").toString("latin1"));
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
