import { findCredential, namesSecret, redactHome, redactLiterals, RedactionScope, scopeFor, secretEnvNames } from "./redact.js";
import { CliError, SelfEvent } from "./types.js";

// An event is committed, pushed, pulled, and read on machines that were never
// near the one that wrote it. So a payload may carry what happened — never
// what the process that recorded it could see.
//
// This refuses rather than rewrites, which is the opposite of what redaction
// does to provider output, and for the opposite reason: output nobody wrote is
// cheap to blank, while a payload is what a person or a runner meant to say
// and quietly changing it would make the log a worse record than no log. The
// refusal is also the only correction that still works — the log is
// append-only and other clones have it seconds after the commit, so an event
// noticed later cannot be taken back.
//
// A refusal names the key path and never the value: an error message is
// printed, logged by whatever wrapped the command, and read over a shoulder.
// Where a pattern matched, the refusal may add the rule and the part of the
// span the pattern itself fixed — a field name, a vendor prefix, an armour
// line, never a head taken off the value — so the writer can rephrase instead
// of guessing.

// Names that say the value beside them came off a machine rather than out of a
// decision. These are judged by name alone, because the field existing at all
// is the leak — there is no sanitized way to sync a pid or a prompt.
//
// A name only belongs here when it has no legitimate synced meaning in this
// product. `command` is the counter-example that sets the bar: a report may
// name the command a run executed on purpose, so a command line is judged by
// what it says, not refused for what it is called.
//
// What is listed is the concept, and it is matched against the whole name and
// against each word inside it: `env`, `envVars` and `environmentVariables` are
// one field, as are `pid` and `PIDs`, `cwd` and `workingDirectory`. A list of
// exact spellings goes stale the moment a payload shape is added — and it goes
// stale silently, which is the failure this list cannot afford.
const FORBIDDEN_KEYS = [
    "prompt", "stdout", "stderr", "output", "env", "environ", "environment",
    "cookie", "authorization", "auth", "pid", "processid",
    "cwd", "homedir", "home", "directory", "spool", "pii", "email", "phone"
];

// A secret this environment declares, kept next to the name that declared it,
// so a refusal can say which variable leaked without printing what it holds.
interface DeclaredSecret
{
    name: string;
    scope: RedactionScope;
}

// The boundary every synced event crosses. Called before anything is written,
// so a refused event leaves the log, the fold, and the store commit untouched.
export function assertSanitized(event: SelfEvent): void
{
    const declared = secretEnvNames().map((name) => ({ name, scope: scopeFor([name]) }));
    // Not the payload alone. The whole line is what gets appended, committed
    // and pulled: `refs.commits` is whatever `--evidence` was handed, and
    // `origin.session` is an environment variable, so a home path or a
    // credential reaches the synced log through either without passing another
    // check. `refs.branch` is the one field this cannot cover, and does not
    // need to — the pipeline stamps it from the checkout after this runs.
    walk(event.payload, "payload", declared);
    walk(event.refs, "refs", declared);
    walk(event.origin, "origin", declared);
}

function walk(value: unknown, at: string, declared: DeclaredSecret[]): void
{
    if (typeof value === "string")
    {
        assertValue(value, at, declared);
        return;
    }
    if (Array.isArray(value))
    {
        value.forEach((item, index) => walk(item, `${at}[${index}]`, declared));
        return;
    }
    if (value === null || typeof value !== "object")
    {
        return;
    }
    let index = 0;
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
    {
        assertKey(key, at, index, declared);
        walk(child, `${at}.${key}`, declared);
        index += 1;
    }
}

// A key is data too — a review envelope and an attempt payload carry objects
// their caller built — and it is the one string a refusal cannot name, since
// printing it is the leak. So a key that fails is located by where it sits
// rather than by what it says.
function assertKey(key: string, at: string, index: number, declared: DeclaredSecret[]): void
{
    assertValue(key, `${at} key #${index}`, declared);
    if (forbiddenKey(key))
    {
        throw new CliError(`refusing to record ${at}.${key} — process handles, raw output, and credentials stay on the machine that produced them`);
    }
}

// Each test is decided by the canonical redactor, so the guard cannot fall
// behind the patterns: what redaction would rewrite is what must not be
// recorded.
function assertValue(text: string, at: string, declared: DeclaredSecret[]): void
{
    assertNoControlBytes(text, at);
    if (redactHome(text) !== text)
    {
        throw new CliError(`refusing to record ${at} — it holds an absolute path under this machine's home directory, which names the person holding the clone and resolves to nothing in another one`);
    }
    for (const { name, scope } of declared)
    {
        if (redactLiterals(text, scope) !== text)
        {
            throw new CliError(`refusing to record ${at} — it repeats the value the environment variable ${name} holds`);
        }
    }
    // Held back where redaction is eager, and only there. `findCredential`
    // judges each rule at the span it matched: an explicit encoding —
    // `api_key="abc123secret"`, a header, a vendor-prefixed literal — is
    // refused however short and however ordinary the value reads, while the
    // rules a sentence can trip have to find key material inside their own
    // match. That is what keeps "reduced token counting overhead" recordable
    // in the one log that exists to keep it, without the branch slug in the
    // same sentence deciding anything. The refusal carries the rule and the
    // redacted span, because "rephrase and retry" is the only recourse a
    // refused writer has, and both are already safe to print.
    const found = findCredential(text);
    if (found !== null)
    {
        throw new CliError(`refusing to record ${at} — its value is shaped like a credential (rule ${found.rule}, matched ${found.preview})`);
    }
}

// Tab, newline and carriage return are the three a recorded text legitimately
// carries — a report written from a file arrives with all of them — and every
// renderer already folds them. The rest of C0, DEL, and C1 are terminal
// control, and an ESC among them moves the cursor of whatever draws the value
// while the width table charges it nothing, which is a cell boundary in every
// table under it (#138).
//
// Judged by code point rather than written as a character class: a control
// byte typed into a source file is invisible to every editor that would have
// to review the rule it defines.
const ALLOWED_CONTROL = [0x09, 0x0a, 0x0d];

function isControl(point: number): boolean
{
    return (point < 0x20 && !ALLOWED_CONTROL.includes(point)) || point === 0x7f || (point >= 0x80 && point <= 0x9f);
}

// Refused rather than stripped, like everything else this gate judges: a
// control byte in recorded text is either an accident whose author wants to
// know, or an attempt to draw with somebody else's terminal, and silently
// rewriting the value would hide both. The refusal names the code point,
// which is what the writer has to go and remove — never the value.
function assertNoControlBytes(text: string, at: string): void
{
    for (let index = 0; index < text.length; index += 1)
    {
        const point = text.charCodeAt(index);
        if (isControl(point))
        {
            throw new CliError(`refusing to record ${at} — it holds the terminal control character ` +
                `U+${point.toString(16).toUpperCase().padStart(4, "0")} at offset ${index}, ` +
                `which every surface that renders this value would obey instead of showing`);
        }
    }
}

// A field the list above names, however it is spelled, or one the canonical
// credential-name rule recognises — `githubToken` and `Access-Key` are the way
// such a field actually arrives, never the bare word.
function forbiddenKey(key: string): boolean
{
    return namesSecret(key) || forbiddenWord(key.replace(/[^A-Za-z0-9]/g, "")) || keyWords(key).some(forbiddenWord);
}

// The words a field name is built from, however it was cased or separated:
// `envVars`, `env_vars` and `Env-Vars` all arrive as two.
function keyWords(key: string): string[]
{
    return key.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/);
}

// Matched as a word rather than as a substring, so `envelope` and `author` are
// their own fields. A plural is the same word: `PIDs` is a list of pids.
function forbiddenWord(word: string): boolean
{
    const lower = word.toLowerCase();
    return FORBIDDEN_KEYS.includes(lower) || FORBIDDEN_KEYS.includes(lower.replace(/s$/, ""));
}
