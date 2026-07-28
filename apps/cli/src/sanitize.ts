import { carriesKeyMaterial, namesSecret, redactHome, redactLiterals, redactSecrets, RedactionScope, scopeFor, secretEnvNames } from "./attempt/redact.js";
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

// Names that say the value beside them came off a machine rather than out of a
// decision. These are judged by name alone, because the field existing at all
// is the leak — there is no sanitized way to sync a pid or a prompt.
//
// A name only belongs here when it has no legitimate synced meaning in this
// product. `command` is the counter-example that sets the bar: the integration
// train records the commands an attempt ran on purpose, so a command line is
// judged by what it says, not refused for what it is called.
const FORBIDDEN_KEYS = [
    "prompt", "prompts", "stdout", "stderr", "output", "outputs", "env", "environ", "environment",
    "cookie", "cookies", "authorization", "auth", "pid", "processid",
    "cwd", "homedir", "spool", "pii", "email", "phone"
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
    walk(event.payload, "payload", secretEnvNames().map((name) => ({ name, scope: scopeFor([name]) })));
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
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
    {
        if (forbiddenKey(key))
        {
            throw new CliError(`refusing to record ${at}.${key} — process handles, raw output, and credentials stay on the machine that produced them`);
        }
        walk(child, `${at}.${key}`, declared);
    }
}

// Each test is decided by the canonical redactor, so the guard cannot fall
// behind the patterns: what redaction would rewrite is what must not be
// recorded.
function assertValue(text: string, at: string, declared: DeclaredSecret[]): void
{
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
    // The shape test is held to values that also carry generated key material.
    // Redaction alone is too eager to refuse on: it blanks the word after
    // "token" or "basic", which costs nothing in provider output and would
    // cost this a sentence like "reduced token counting overhead" — ordinary
    // prose in the one log that exists to keep it. The trade is deliberate: a
    // short low-entropy secret written into prose reads exactly like prose and
    // is left to the key rule above, which is where such a value belongs.
    if (redactSecrets(text) !== text && carriesKeyMaterial(text))
    {
        throw new CliError(`refusing to record ${at} — its value is shaped like a credential`);
    }
}

// A field the list above names, however it is spelled, or one the canonical
// credential-name rule recognises — `githubToken` and `Access-Key` are the way
// such a field actually arrives, never the bare word.
function forbiddenKey(key: string): boolean
{
    return FORBIDDEN_KEYS.includes(key.toLowerCase().replace(/[^a-z0-9]/g, "")) || namesSecret(key);
}
