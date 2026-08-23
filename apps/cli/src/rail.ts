// The one way anything in this CLI reaches the network.
//
// A plugin never opens a socket. It hands a spec to `railRequest` and gets a
// normalized answer back, which is what puts every security-relevant transport
// behaviour — TLS policy, the bearer header, the refresh lock, retry
// classification, control-character stripping, the response cap — in the
// open-source repository rather than in a private client nobody outside can
// read.
//
// Three things here are easy to get wrong and are therefore written out rather
// than left to a convention:
//
//   - A refresh is never retried. A retry after an ambiguous response can
//     present an already-rotated token, and the server answers that by revoking
//     the whole grant chain and emailing the owner a theft alert.
//   - The server's `error.code` is discarded. It is always an exception class
//     name; the code an agent can branch on lives in three other places.
//   - The exit code is decided here, from a table, never read from the
//     response — `details.exitCode` is emitted by two mini-apps and omitted by
//     the third, so it cannot be read uniformly.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    LOCK_WAIT_MS, Profile, REFRESH_MARGIN_MS, credentialsPath, digest, ensurePrivateDir,
    guardMarker, now, readMarker, readProfile, removeMarker, removeProfile, replacePrivateFile,
    stateDir, withCredentialLock, writeMarker, writeProfile
} from "./credentials.js";
import { CliError, ErrorFields, JsonValue, fail, pending, refuse } from "./types.js";

/* ── constants (design §10) ────────────────────────────────────────── */

export const CONNECT_TIMEOUT_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const DEPLOY_TIMEOUT_MS = 120_000;
export const TRANSPORT_ATTEMPTS = 3;
// The whole response body a rail answer may occupy. A per-value cap would
// corrupt the data `--json` exists to deliver; this is the cap that actually
// answers "a hostile server sends a gigabyte".
export const RESPONSE_CAP_BYTES = 8 * 1024 * 1024;
// Human rendering only. Under `--json` a value is never shortened.
export const HUMAN_STRING_CAP = 2048;
export const CLOCK_SKEW_NOTICE_MS = 300_000;
export const CALL_JOURNAL_LINES = 1000;
export const CALL_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

// The outer bound on one command's own work. It is a ceiling over the
// per-request timeouts, never a competitor to them, and it excludes lock-wait
// and refresh time — waiting for another process's refresh, and performing
// one, are not this command's work.
export function commandDeadlineMs(requestTimeoutMs: number): number
{
    return Math.max(60_000, requestTimeoutMs + 15_000);
}

/* ── injectable waiting ────────────────────────────────────────────── */

// Backoff is real time, and a test that asserts "three attempts and stop"
// should not spend seven seconds proving it. Injectable rather than shortened
// by an environment variable, because an environment variable would be a
// production code path a caller could reach.
let backoff: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function useBackoff(next: (ms: number) => Promise<void>): (ms: number) => Promise<void>
{
    const previous = backoff;
    backoff = next;
    return previous;
}

/* ── the exit-code table (design §2.5) ─────────────────────────────── */

// Exit 3 — pending and retryable. The complete set: anything not named here is
// never exit 3. The number beside a code is the pace the CLI supplies when the
// server sends none.
export const EXIT_3_CODES: Record<string, number | undefined> = {
    recharging: 20,
    call_in_progress: 2,
    deploy_superseded: undefined,
    rate_limited: undefined,
    server_unavailable: undefined,
    network_unavailable: undefined,
    refresh_lock_timeout: 5,
    command_deadline_exceeded: 5,
    // The plugin key list could not be obtained and there was no valid cache to
    // fall back on (§1.4a). Retrying the identical command is exactly right —
    // the rail being reachable is the only thing that has to change.
    trust_unavailable: 5
};

// Exit 2 — refused by policy; the answer will not change. Grouped as the rail's
// own vocabulary is grouped, so a code added server-side has an obvious home.
export const EXIT_2_WALLET = [
    "insufficient_balance", "settlement_required", "auto_recharge_cap_exhausted", "quota_exceeded",
    "currency_locked", "currency_mismatch", "topup_amount_out_of_bounds", "topup_amount_unavailable",
    "topup_velocity_exceeded", "auto_recharge_incomplete", "auto_recharge_instrument_missing"
];

// Two producers, and only one of them is generated. `account_suspended`,
// `account_closing` and `account_closed` are `ACCOUNT_STATUSES` minus the
// credential-usable ones, interpolated by `authorize`. `account_paused` cannot
// come from that difference — `paused` is usable by construction — and arrives
// from the rail's admission gate instead. The contract test asserts the two
// halves separately for exactly that reason.
export const EXIT_2_ACCOUNT_AUTHORIZE = ["account_suspended", "account_closing", "account_closed"];
export const EXIT_2_ACCOUNT_GATE = ["account_paused"];

export const EXIT_2_EMAIL = [
    "purpose_required", "validation_refused", "recipient_cap_exceeded", "all_recipients_skipped",
    "free_tier_template_required", "domain_unverified", "domain_taken", "domain_limit_reached",
    "email_not_verified", "demo_recipient_not_allowed", "demo_quota_exceeded", "demo_sending_stopped",
    "invalid_request"
];

export const EXIT_2_LANDING = [
    "slug_invalid", "slug_reserved", "slug_too_similar", "slug_pattern_blocked", "slug_taken",
    "site_limit_reached", "site_taken_down", "bundle_not_static", "bundle_paths_mismatch",
    "validation_pending"
];

// `access_denied` is the owner refusing a device grant; `topup_is_human_gated`
// is the CLI's own refusal of a command no agent scope exists for.
export const EXIT_2_OTHER = ["access_denied", "topup_is_human_gated"];

export const EXIT_2_CODES = [
    ...EXIT_2_WALLET, ...EXIT_2_ACCOUNT_AUTHORIZE, ...EXIT_2_ACCOUNT_GATE,
    ...EXIT_2_EMAIL, ...EXIT_2_LANDING, ...EXIT_2_OTHER
];

// Declared server-side and never constructed, or existing only as a validation
// rule tag inside a `validation_refused` payload. A client must not branch on
// them, so the table above must not claim them — asserted by a contract test.
export const UNREACHABLE_CODES = [
    "reserve_not_found", "business_contact_required", "night_window_advertising",
    "ad_label_evasion", "slug_immutable"
];

export function exitFor(code: string): 1 | 2 | 3
{
    if (Object.prototype.hasOwnProperty.call(EXIT_3_CODES, code))
    {
        return 3;
    }
    return EXIT_2_CODES.includes(code) ? 2 : 1;
}

/* ── shaping what the server said ──────────────────────────────────── */

// Terminal escapes and C0/C1 control characters are stripped from every
// server-provided string before it is rendered, in **both** modes. This is
// mode-independent and never shortens a legitimate value; the 2 KB cap is a
// separate, human-only measure.
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
// C0 minus tab and newline, DEL, and C1. Tab and newline survive because a
// legitimate multi-line value — a DNS record set, an HTML body — is made of
// them, and stripping those would corrupt exactly the values `--json` exists
// to deliver intact.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function sanitizeText(value: string): string
{
    return value.replace(ANSI_ESCAPE, "").replace(CONTROL_CHARS, "");
}

function snakeKey(key: string): string
{
    return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

// Keys only. A string **value** is sanitized but never rewritten: an agent that
// reads a campaign id must get back the id the server sent.
export function toSnake(value: JsonValue): JsonValue
{
    if (typeof value === "string")
    {
        return sanitizeText(value);
    }
    if (Array.isArray(value))
    {
        return value.map(toSnake);
    }
    if (value !== null && typeof value === "object")
    {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [snakeKey(key), toSnake(item)]));
    }
    return value;
}

interface RawBody
{
    [key: string]: JsonValue | undefined;
}

function field(body: RawBody, name: string): string | undefined
{
    const value = body[name];
    return typeof value === "string" ? sanitizeText(value) : undefined;
}

function details(body: RawBody): RawBody
{
    const value = body.details;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RawBody : {};
}

// The app code, in the order the three producers put it. The framework's own
// `error.code` is discarded: it is always the exception class name
// (`ConflictError`, `AuthFlowError`) and carries nothing a client can branch on.
export function errorCode(body: RawBody): string
{
    return field(body, "code")
        ?? field(details(body), "code")
        ?? field(body, "__type")
        ?? "unknown_error";
}

function requestId(body: RawBody): string | undefined
{
    const wrapper = body.error;
    if (wrapper === null || typeof wrapper !== "object" || Array.isArray(wrapper))
    {
        return undefined;
    }
    return field(wrapper as RawBody, "requestId");
}

function numberField(body: RawBody, name: string): number | undefined
{
    const value = body[name];
    return typeof value === "number" ? value : undefined;
}

// Every normalized field of the one envelope, taken from wherever the shipped
// server happens to put it. `stack` is dropped always: it is present whenever
// the server is not in production and may name server filesystem paths.
export function normalizeError(body: RawBody): { code: string; message: string; fields: ErrorFields }
{
    const inner = details(body);
    const fields: ErrorFields = {};
    assign(fields, "hint", field(inner, "hint") ?? field(body, "hint"));
    assign(fields, "retry_after_s", numberField(inner, "retryAfterS"));
    assign(fields, "request_id", requestId(body));
    assign(fields, "review_id", field(inner, "reviewId") ?? field(body, "reviewId"));
    assign(fields, "min_version", field(inner, "minVersion") ?? field(body, "min_version"));
    assign(fields, "rule_hits", inner.ruleHits === undefined ? undefined : toSnake(inner.ruleHits));
    assign(fields, "refusals", inner.refusals === undefined ? undefined : toSnake(inner.refusals));
    return {
        code: errorCode(body),
        message: field(inner, "message") ?? field(body, "message") ?? "the rail refused the request",
        fields
    };
}

// Optional means omitted, never null — the one rule that makes the envelope a
// single schema rather than a shape with eleven nullable holes.
function assign<K extends keyof ErrorFields>(fields: ErrorFields, key: K, value: ErrorFields[K]): void
{
    if (value !== undefined)
    {
        fields[key] = value;
    }
}

/* ── the session a request runs in ─────────────────────────────────── */

export interface RailSession
{
    profile: string;
    // What `X-Superself-Client` says beyond the CLI's own version: the plugin
    // and contract a call was made on behalf of, or nothing for a host call.
    client: string;
    // Set by a command that wants its own deadline; otherwise derived.
    deadlineMs?: number;
    // Off under `--json` and on a non-TTY. A notice is stderr-only either way.
    notice?: (line: string) => void;
}

interface FormPart
{
    name: string;
    value: string | Uint8Array;
    filename?: string;
    contentType?: string;
}

export interface RailRequestSpec
{
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean>;
    body?: JsonValue;
    form?: FormPart[];
    // Checked locally against the stored grant before the call. An ergonomics
    // optimization, never a security control — the server is authoritative.
    scopes: string[];
    callKey?: string | "derive";
    timeoutMs?: number;
}

export interface RailResponse
{
    status: number;
    // Lowercased, so a caller never has to guess a header's spelling.
    headers: Record<string, string>;
    body: JsonValue;
    callKey?: string;
}

/* ── TLS and base-URL policy ───────────────────────────────────────── */

export function assertTlsPolicy(): void
{
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    {
        throw fail("tls_verification_disabled",
            "NODE_TLS_REJECT_UNAUTHORIZED=0 is set, so a rail call could be read by anything in the path",
            { hint: "unset NODE_TLS_REJECT_UNAUTHORIZED" });
    }
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function assertApiBase(base: string): string
{
    let url: URL;
    try
    {
        url = new URL(base);
    }
    catch
    {
        throw fail("invalid_api_base", `"${sanitizeText(base)}" is not a URL`);
    }
    if (url.protocol === "https:")
    {
        return base.replace(/\/$/, "");
    }
    if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname) && process.env.SUPERSELF_DEV === "1")
    {
        return base.replace(/\/$/, "");
    }
    throw fail("insecure_api_base", `${base} is not https — a credential is never sent in the clear`);
}

/* ── the call key (design §4.1) ────────────────────────────────────── */

// RFC 8785 canonical JSON, enough of it for the shapes a request body takes:
// keys sorted, no insignificant whitespace, strings NFC-normalized. It is what
// makes the derived key reproducible across machines and runs.
export function jcs(value: JsonValue): string
{
    if (typeof value === "string")
    {
        return JSON.stringify(value.normalize("NFC"));
    }
    if (Array.isArray(value))
    {
        return `[${value.map(jcs).join(",")}]`;
    }
    if (value !== null && typeof value === "object")
    {
        const pairs = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`);
        return `{${pairs.join(",")}}`;
    }
    return JSON.stringify(value);
}

// Deterministic by default, because the trap this exists to avoid is a fresh
// random key per invocation: that makes every retry a *new* call, and a new
// call is a second charge.
export function deriveCallKey(accountId: string, commandPath: string, request: JsonValue): string
{
    const material = ["superself.callkey.v1", accountId, commandPath, jcs(request)].join(" ");
    return `ck_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export function newCallKey(): string
{
    return `ck_${randomBytes(16).toString("hex")}`;
}

export function checkCallKey(key: string): string
{
    if (!CALL_KEY_PATTERN.test(key))
    {
        throw fail("invalid_call_key",
            "a call key is 8 to 128 characters of letters, digits, underscore, dot, colon or dash");
    }
    return key;
}

/* ── the local call journal ────────────────────────────────────────── */

export function journalPath(): string
{
    return join(stateDir(), "calls.jsonl");
}

// No request bodies, no recipients, no tokens. The call key is an irreversible
// hash, so the journal carries no PII — which is what lets it be the mechanism
// an agent that crashed mid-send recovers through.
interface JournalEntry
{
    profile: string;
    command: string;
    call_key?: string;
    exit: number;
    code?: string;
}

// Off by flag or by environment. The flag is a per-command request and the
// variable is an ambient preference, exactly as with `--json`; here they mean
// the same thing, because a journal is either wanted for this machine or not.
let journalOff = false;

export function suppressJournal(off: boolean): void
{
    journalOff = off;
}

export function journalCall(entry: JournalEntry): void
{
    if (journalOff || process.env.SUPERSELF_NO_JOURNAL === "1")
    {
        return;
    }
    try
    {
        writeJournalLine(entry);
    }
    catch
    {
        // A journal is how an agent recovers a call key after a crash — it is
        // not what makes the call correct. A read-only or full state directory
        // must not turn a send that the server accepted, and charged for, into
        // a failure the agent reads as "it did not happen".
    }
}

function writeJournalLine(entry: JournalEntry): void
{
    const path = journalPath();
    ensurePrivateDir(stateDir());
    const line = `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`;
    if (!existsSync(path))
    {
        replacePrivateFile(path, line);
        return;
    }
    appendFileSync(path, line);
    truncateJournal(path);
}

function truncateJournal(path: string): void
{
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
    if (lines.length > CALL_JOURNAL_LINES)
    {
        replacePrivateFile(path, `${lines.slice(lines.length - CALL_JOURNAL_LINES).join("\n")}\n`);
    }
}

/* ── refresh (design §4.4) ─────────────────────────────────────────── */

// The five 401 refusal codes, and nothing else. Each is a statement that the
// server did **not** rotate, which is the only kind of outcome that may remove
// the pending marker. Retention is the default for everything else.
const REFRESH_REFUSALS = ["refresh_invalid", "refresh_revoked", "refresh_expired",
    "refresh_reuse_detected", "account_unavailable"];

interface RefreshOutcome
{
    profile: Profile;
}

// The whole procedure, always under the profile's own lock.
//
// Step 2 is the one that prevents self-inflicted reuse detection, and it is the
// reason the lock exists at all: a process that lost a race re-reads a rotated
// credential and returns without calling. The lock makes the common case
// efficient; that check makes the uncommon case correct.
type RefreshTrigger = "expiring" | "rejected";

async function refreshUnderLock(session: RailSession, seen: Profile, trigger: RefreshTrigger): Promise<RefreshOutcome>
{
    return withCredentialLock(session.profile, { waitMs: LOCK_WAIT_MS }, async () =>
    {
        const current = readProfile(session.profile);
        if (alreadyDone(current, seen, trigger))
        {
            return { profile: current };
        }
        markPending(session.profile, current);
        return { profile: await rotate(session, current) };
    });
}

// Written before the request, atomically and durably — an un-fsynced marker is
// worthless precisely in the power-loss case it exists for. A failure here is
// a failure of the credential path itself, and it is named rather than left to
// surface as a filesystem stack trace: nothing has rotated yet, so the honest
// answer is that this machine cannot hold a credential right now.
function markPending(profile: string, current: Profile): void
{
    try
    {
        writeMarker(profile, {
            version: 1,
            profile,
            grant_id: current.grant_id,
            prior_refresh_sha256: digest(current.refresh_token),
            prior_access_sha256: digest(current.access_token),
            at: now().toISOString()
        });
    }
    catch
    {
        throw fail("credential_write_failed",
            `could not write beside ${credentialsPath()}, so a refresh cannot be made safe`,
            { hint: "check the permissions and free space on the config directory" });
    }
}

function fresh(profile: Profile): boolean
{
    return Date.parse(profile.access_expires_at) - now().getTime() > REFRESH_MARGIN_MS;
}

// Whether another process already did this refresh, judged differently by why
// this one was asked for.
//
// On the proactive path, a stored expiry now comfortably in the future is
// exactly the evidence wanted: somebody refreshed while this process waited for
// the lock. On the **reactive** path it is no evidence at all — the server has
// just rejected a credential the local clock still considers fresh, which is
// the whole reason a 401 `credential_expired` exists. Reading freshness there
// would return the rejected token and replay the request with it, so the only
// question that path may ask is whether the stored pair changed at all.
function alreadyDone(current: Profile, seen: Profile, trigger: RefreshTrigger): boolean
{
    if (current.refresh_token !== seen.refresh_token || current.access_token !== seen.access_token)
    {
        return true;
    }
    return trigger === "expiring" && fresh(current);
}

async function rotate(session: RailSession, current: Profile): Promise<Profile>
{
    const answer = await refreshRequest(session, current);
    // A `self login` may have replaced this profile while the request was in
    // flight. The login is the operator's newer intent, so the rotated pair is
    // discarded rather than written over it — always safe, because the
    // discarded pair belongs to a grant that has just been replaced.
    const after = readProfile(session.profile);
    if (after.grant_id !== current.grant_id)
    {
        removeMarker(session.profile);
        return after;
    }
    return commitRotation(session.profile, current, answer);
}

interface RefreshAnswer
{
    access_token: string;
    refresh_token: string;
    scopes: string[];
    expires_at: string;
}

function commitRotation(profile: string, current: Profile, answer: RefreshAnswer): Profile
{
    const next: Profile = {
        ...current,
        access_token: answer.access_token,
        refresh_token: answer.refresh_token,
        scopes: answer.scopes,
        access_expires_at: answer.expires_at
    };
    try
    {
        writeProfile(profile, next);
    }
    catch
    {
        // The server has already rotated, so the credential is lost. The marker
        // is **retained**: a rotation landed that was not persisted, which is
        // precisely what it is for.
        throw fail("credential_write_failed",
            `could not write ${credentialsPath()} — the rotated credential is lost`, { hint: "self login" });
    }
    removeMarker(profile);
    return next;
}

// Never retried, and therefore never exit 3. Every failed refresh is exit 1
// `login_required` with a `reason`, and the marker is retained unless the
// outcome proves no rotation occurred.
async function refreshRequest(session: RailSession, current: Profile): Promise<RefreshAnswer>
{
    const url = `${assertApiBase(current.api_base)}/api/auth/refresh`;
    let answer: HttpAnswer;
    try
    {
        answer = await httpOnce(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...clientHeaders(session) },
            body: JSON.stringify({ refresh_token: current.refresh_token }),
            timeoutMs: REQUEST_TIMEOUT_MS
        });
    }
    catch (error)
    {
        throw refreshTransportFailure(session.profile, error);
    }
    return refreshOutcome(session.profile, answer);
}

// The only transport outcomes that may remove the marker are the two that
// prove the request never reached the server. Everything else — a socket that
// closed after the request was written, a timeout after transmission — is
// unknown, and unknown retains.
const PRE_TRANSMISSION = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function refreshTransportFailure(profile: string, error: unknown): CliError
{
    // `fetch` reports a transport errno on `cause`, not on the error itself —
    // reading only the top level would classify every failure as ambiguous.
    // That direction is safe (a retained marker costs one forced re-login) but
    // it is not free, so the code is read where it actually is.
    const wrapped = error as { code?: string; cause?: { code?: string } };
    const code = wrapped?.code ?? wrapped?.cause?.code;
    if (code !== undefined && PRE_TRANSMISSION.has(code))
    {
        removeMarker(profile);
        return fail("login_required", "the rail could not be reached to refresh the credential",
            { reason: "refresh_unavailable", hint: "self login" });
    }
    return fail("login_required", "the credential refresh did not complete and may have rotated",
        { reason: "refresh_ambiguous", hint: "self login" });
}

function refreshOutcome(profile: string, answer: HttpAnswer): RefreshAnswer
{
    if (answer.status === 200)
    {
        return answer.body as unknown as RefreshAnswer;
    }
    const { code, message } = normalizeError(answer.body as RawBody);
    if (answer.status === 401 && REFRESH_REFUSALS.includes(code))
    {
        removeMarker(profile);
        removeProfile(profile);
        throw fail("login_required", message, { reason: reasonFor(code), hint: consequence(code) });
    }
    // Retained: a 5xx is a complete response from a server that may already
    // have rotated, a 429 says nothing about whether it did, and an
    // unclassified answer means unknown.
    throw fail("login_required", message, { reason: unclassifiedReason(answer.status), hint: "self login" });
}

// The sub-cause an agent branches on. Two codes are renamed rather than passed
// through: `refresh_reuse_detected` becomes `reuse_detected` because that is
// what the whole grant chain being revoked is *about*, and `credential_invalid`
// becomes `revoked` because a credential the server no longer honours is one
// the owner (or the reuse detector) took away.
function reasonFor(code: string): string
{
    const renamed: Record<string, string> = { refresh_reuse_detected: "reuse_detected", credential_invalid: "revoked" };
    return renamed[code] ?? code;
}

// What the server does not say, and an operator has to know: a reuse detection
// has already revoked every credential and every refresh token from this login
// and emailed the owner a theft alert. Stating it plainly is the difference
// between "log in again" and "someone may have your token".
function consequence(code: string): string
{
    return code === "refresh_reuse_detected"
        ? "this credential was already replaced once, so the whole grant was revoked and the owner has been emailed a theft alert — run `self login` to start a new one"
        : "self login";
}

function unclassifiedReason(status: number): string
{
    if (status >= 500)
    {
        return "refresh_unavailable";
    }
    return status === 429 ? "refresh_rate_limited" : "refresh_ambiguous";
}

/* ── HTTP ──────────────────────────────────────────────────────────── */

interface HttpAnswer
{
    status: number;
    headers: Record<string, string>;
    body: JsonValue;
    text: string;
}

// How many bytes a caller will accept, and what to call it when the answer is
// longer. Every ordinary call takes the default; the plugin trust document
// takes a far smaller one, because 64 KB is the whole of what it may ever be
// and a cap enforced at the caller's own size is a cap a hostile rail cannot
// walk past (§1.4a).
interface ResponseCap
{
    bytes: number;
    code: string;
}

const DEFAULT_CAP: ResponseCap = { bytes: RESPONSE_CAP_BYTES, code: "response_too_large" };

interface HttpOptions
{
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    timeoutMs: number;
    cap?: ResponseCap;
    // The caller's cancellation, distinct from this request's own timeout. A
    // SIGINT aborts it (§4.5); the fetch below is aborted when either fires.
    signal?: AbortSignal;
}

async function httpOnce(url: string, options: HttpOptions): Promise<HttpAnswer>
{
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), options.timeoutMs);
    const unlink = linkAbort(abort, options.signal);
    try
    {
        const response = await fetch(url, {
            method: options.method,
            headers: options.headers,
            body: options.body as BodyInit | undefined,
            signal: abort.signal
        });
        return await readAnswer(response, options.cap ?? DEFAULT_CAP);
    }
    finally
    {
        clearTimeout(timer);
        unlink();
    }
}

// The caller's cancellation and this request's own timeout share one controller:
// whichever fires aborts the fetch. An interrupt therefore actually stops the
// send rather than leaving it to complete in the background. Returns the
// listener cleanup, a no-op when there is nothing to cancel from outside.
function linkAbort(local: AbortController, external: AbortSignal | undefined): () => void
{
    if (external === undefined)
    {
        return () => undefined;
    }
    if (external.aborted)
    {
        local.abort();
        return () => undefined;
    }
    const relay = (): void => local.abort();
    external.addEventListener("abort", relay, { once: true });
    return () => external.removeEventListener("abort", relay);
}

async function readAnswer(response: Response, cap: ResponseCap): Promise<HttpAnswer>
{
    const text = await capped(response, cap);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    let body: JsonValue = null;
    try
    {
        body = text === "" ? null : JSON.parse(text) as JsonValue;
    }
    catch
    {
        body = { message: sanitizeText(text.slice(0, HUMAN_STRING_CAP)) };
    }
    return { status: response.status, headers, body, text };
}

// The answer to "a hostile server sends a gigabyte", and the only length limit
// the transport imposes.
//
// It is counted **while the body arrives**, not after. Buffering the whole
// response and then measuring it is the version of this check that a hostile
// server defeats simply by answering: the memory is already gone by the time
// the number is known. `content-length` is not consulted either, for the same
// reason — the server controls it.
async function capped(response: Response, cap: ResponseCap): Promise<string>
{
    const body = response.body;
    if (body === null)
    {
        return "";
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true)
    {
        const step = await reader.read();
        if (step.done)
        {
            break;
        }
        size += step.value.byteLength;
        if (size > cap.bytes)
        {
            await reader.cancel();
            throw fail(cap.code, `the rail answered with more than ${cap.bytes} bytes`);
        }
        chunks.push(step.value);
    }
    return new TextDecoder().decode(joinChunks(chunks, size));
}

function joinChunks(chunks: Uint8Array[], size: number): Uint8Array
{
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks)
    {
        out.set(chunk, at);
        at += chunk.byteLength;
    }
    return out;
}

const RETRYABLE_ERRNO = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_SOCKET"]);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function retryableError(error: unknown): boolean
{
    const named = error as { code?: string; name?: string; cause?: { code?: string } };
    return RETRYABLE_ERRNO.has(named?.code ?? "")
        || RETRYABLE_ERRNO.has(named?.cause?.code ?? "")
        || named?.name === "AbortError"
        || /socket hang up|fetch failed/i.test(String((error as Error)?.message ?? ""));
}

// 1 s / 2 s / 4 s with ±20 % jitter. Jitter is what keeps ten agents that all
// hit one 503 from retrying in lockstep.
function backoffMs(attempt: number): number
{
    const base = 1000 * 2 ** (attempt - 1);
    return Math.round(base * (0.8 + Math.random() * 0.4));
}

function retryAfterMs(headers: Record<string, string>): number | undefined
{
    const value = Number(headers["retry-after"]);
    return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
}

/* ── the request ───────────────────────────────────────────────────── */

function clientHeaders(session: RailSession): Record<string, string>
{
    return { "x-superself-client": session.client };
}

function queryString(query: Record<string, string | number | boolean> | undefined): string
{
    if (query === undefined)
    {
        return "";
    }
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => params.set(key, String(value)));
    const text = params.toString();
    return text === "" ? "" : `?${text}`;
}

// The scope pre-flight. Local, and never a security control: it saves a round
// trip and names the missing scope, and the server refuses independently.
function checkScopes(profile: Profile, wanted: string[]): void
{
    const missing = wanted.filter((scope) => !profile.scopes.includes(scope));
    if (missing.length > 0)
    {
        throw fail("insufficient_scope", `this credential does not carry ${missing.join(", ")}`,
            { hint: `self login --scopes ${[...profile.scopes, ...missing].join(",")}` });
    }
}

// A response `Date` far from the local clock is worth one notice, because a
// skewed clock is what makes a proactive refresh miss. It is never fatal: the
// 401 path catches what the margin missed.
function noticeSkew(session: RailSession, headers: Record<string, string>): void
{
    const sent = Date.parse(headers.date ?? "");
    if (!Number.isNaN(sent) && Math.abs(sent - now().getTime()) > CLOCK_SKEW_NOTICE_MS && session.notice !== undefined)
    {
        session.notice(`notice: this machine's clock differs from the rail's by more than ${CLOCK_SKEW_NOTICE_MS / 1000}s`);
    }
}

// The rail major, advertised on every response once the server ships the
// header. It is read here so any call refreshes it, not only an install.
export function railMajor(headers: Record<string, string>): string | undefined
{
    // A header that arrived blank answered nothing, and reads as absent. The
    // difference matters: an absent major refuses the load `rail_api_unknown`,
    // while a *present* one that does not match refuses `rail_api_incompatible`
    // — and answering the first case with the second name would point an
    // operator at a version problem they do not have.
    const value = headers["x-superself-api"]?.trim();
    return value === undefined || value === "" ? undefined : value;
}

interface RailCall
{
    session: RailSession;
    spec: RailRequestSpec;
    // What the call key is derived over when `callKey: "derive"` is asked for.
    // The command path and the normalized request together, never a timestamp.
    commandPath?: string;
}

// One rail call, start to finish: credential, marker guard, scope check,
// proactive refresh, the request, the 401 table, and one replay.
export async function railRequest(call: RailCall): Promise<RailResponse>
{
    assertTlsPolicy();
    const profile = await confirmMarker(call.session.profile, readProfile(call.session.profile));
    checkScopes(profile, call.spec.scopes);
    const usable = fresh(profile) ? profile : (await refreshUnderLock(call.session, profile, "expiring")).profile;
    return sendWithReplay(call, usable);
}

// A marker on disk means "a refresh may have rotated this token and not
// persisted it" — but it means that only once nobody is still performing that
// refresh. A live refresher writes the marker *before* its request and removes
// it after the rotation lands, so a sibling process that reads the marker in
// that window would otherwise refuse a credential that is about to be perfectly
// good, and ten parallel invocations would produce nine forced re-logins.
//
// The lock is what tells the two apart, and it is taken only when a marker is
// actually there: a live refresher holds it, so this waits and then re-reads a
// credential that has moved on; a crashed one left none, so this acquires
// immediately and finds the marker still matching, which is the interruption
// the marker exists to report.
async function confirmMarker(name: string, seen: Profile): Promise<Profile>
{
    if (readMarker(name) === null)
    {
        return seen;
    }
    return withCredentialLock(name, { waitMs: LOCK_WAIT_MS }, async () =>
    {
        const current = readProfile(name);
        guardMarker(name, current.refresh_token);
        return current;
    });
}

// The outer bound on one command's own work, started **here** — after the lock
// wait and after any refresh, which is precisely what excludes them. It is a
// ceiling over the per-request timeouts rather than a competitor to them: a
// command that waited 20 s for a lock and then refreshed still gets its full
// request budget afterwards.
//
// A hit is exit 3 because a deadline hit is by definition an unknown outcome,
// and the two commands that can spend real money are both retry-safe by
// construction — one carries the call key, and the other rests on the server's
// own `deploy_superseded`.
async function sendWithReplay(call: RailCall, profile: Profile): Promise<RailResponse>
{
    const callKey = resolveCallKey(call, profile);
    const budget = call.session.deadlineMs ?? commandDeadlineMs(call.spec.timeoutMs ?? REQUEST_TIMEOUT_MS);
    return Promise.race([attemptWithin(call, profile, callKey), deadline(budget, callKey)]);
}

function deadline(budget: number, callKey: string | undefined): Promise<never>
{
    return new Promise((resolve, reject) =>
    {
        const timer = setTimeout(() => reject(pending("command_deadline_exceeded",
            `this command passed its ${Math.round(budget / 1000)}s budget with no answer`,
            { retry_after_s: 5, ...(callKey === undefined ? {} : { idempotency_key: callKey }) })), budget);
        // Unref'd, so a command that finishes early is not held open by its own
        // deadline waiting to fire.
        timer.unref?.();
    });
}

async function attemptWithin(call: RailCall, profile: Profile, callKey: string | undefined): Promise<RailResponse>
{
    // A call interrupted by a signal has an unknown outcome, and `exit: -1` is
    // how the journal says so: the key is recorded, so the retry is the same
    // call rather than a second charge (§4.5).
    //
    // Three things have to be true together, and journaling alone was none of
    // them: the in-flight request is **aborted**, so the send cannot go on to
    // complete and write a contradictory `exit: 0` line behind the `exit: -1`
    // one; the `exit: -1` line is the **only** line written for the call; and
    // the process **terminates** with a non-zero code. This is the login path's
    // shape (login.ts) ported to a charged call — abort, reject, propagate — the
    // rejection being what carries the exit. `once` is what keeps a second
    // signal, or a SIGTERM, on Node's default termination: attaching a listener
    // that stays would be the very thing that swallows the next signal.
    const abort = new AbortController();
    const armed = armInterrupt(call, callKey, abort);
    try
    {
        return await Promise.race([sendAndReplay(call, profile, callKey, abort.signal), armed.interrupted]);
    }
    finally
    {
        armed.disarm();
    }
}

// The SIGINT arm for one rail call: on the signal it aborts the request, writes
// the single `exit: -1` line, and rejects so the interruption propagates as the
// process's non-zero exit. `disarm` removes the listener the moment the call
// settles, so nothing outlives the call it belongs to.
function armInterrupt(call: RailCall, callKey: string | undefined, abort: AbortController):
    { interrupted: Promise<RailResponse>; disarm: () => void }
{
    let onInterrupt = (): void => undefined;
    const interrupted = new Promise<RailResponse>((resolve, reject) =>
    {
        onInterrupt = (): void =>
        {
            abort.abort();
            journalCall(entryFor(call, callKey, -1, "interrupted"));
            reject(fail("interrupted", "the rail call was interrupted before it answered",
                { hint: "the call key is journaled; the same call retries without a second charge" }));
        };
        process.once("SIGINT", onInterrupt);
    });
    return { interrupted, disarm: (): void => { process.removeListener("SIGINT", onInterrupt); } };
}

async function sendAndReplay(call: RailCall, profile: Profile, callKey: string | undefined, signal?: AbortSignal): Promise<RailResponse>
{
    const first = await sendOnce(call, profile, callKey, signal);
    if (first.status !== 401)
    {
        return finish(call, first, callKey);
    }
    const code = errorCode(first.body as RawBody);
    // `credential_expired` is the only 401 that refreshes. The others are
    // terminal by their own statement, and refreshing on them would burn a
    // rotation on a credential the server has already disowned.
    if (code !== "credential_expired")
    {
        // A terminal 401 is still the outcome of a real attempt, so it earns a
        // journal line exactly as every other refusal does through `finish`.
        // Without it, an agent replaying the journal cannot see that the last
        // call was refused. The line carries the exit and the mapped code and
        // nothing else — no token, no message body (§4.1).
        const refusal = terminal401(call.session.profile, first, code);
        journalCall(entryFor(call, callKey, refusal.exit, refusal.code));
        throw refusal;
    }
    const refreshed = await refreshUnderLock(call.session, profile, "rejected");
    const second = await sendOnce(call, refreshed.profile, callKey, signal);
    return finish(call, second, callKey);
}

// Which 401 this is, told apart by what the body carries rather than by which
// route was asked for.
//
// The agent-credential path always names an app code — one of the credential or
// refresh refusals. A 401 carrying **no** app code at all did not come from
// that path: it is the owner web-session middleware rejecting a token that is
// not its own JWT, before any scope check ever runs. Saying `login_required`
// there would send an agent into a login loop it can never win, because no
// credential it can obtain is the kind that route accepts.
//
// A 401 that does name a code, but one outside the vocabulary above, is
// genuinely unclassified and says so.
function terminal401(profile: string, answer: HttpAnswer, code: string): CliError
{
    const { message } = normalizeError(answer.body as RawBody);
    if (code === "unknown_error" || /Error$/.test(code))
    {
        return fail("agent_credential_not_accepted",
            "this route accepts an owner web session, not an agent credential",
            { hint: "run it from the console; an agent credential cannot authenticate here" });
    }
    if (code === "credential_required" || code === "credential_invalid")
    {
        removeProfile(profile);
        return fail("login_required", message, { reason: reasonFor(code), hint: "self login" });
    }
    if (REFRESH_REFUSALS.includes(code))
    {
        removeProfile(profile);
        return fail("login_required", message, { reason: reasonFor(code), hint: consequence(code) });
    }
    return fail("login_required", message, { reason: "unclassified_401", hint: "self login" });
}

function resolveCallKey(call: RailCall, profile: Profile): string | undefined
{
    if (call.spec.callKey === undefined)
    {
        return undefined;
    }
    if (call.spec.callKey !== "derive")
    {
        return checkCallKey(call.spec.callKey);
    }
    const request: JsonValue = { path: call.spec.path, query: (call.spec.query ?? {}) as JsonValue, body: call.spec.body ?? null };
    return deriveCallKey(profile.account_id, call.commandPath ?? call.spec.path, request);
}

function finish(call: RailCall, answer: HttpAnswer, callKey: string | undefined): RailResponse
{
    noticeSkew(call.session, answer.headers);
    if (answer.status >= 400)
    {
        const refusal = railFailure(answer, callKey);
        journalCall(entryFor(call, callKey, refusal.exit, refusal.code));
        throw refusal;
    }
    journalCall(entryFor(call, callKey, 0));
    return {
        status: answer.status,
        headers: answer.headers,
        body: toSnake(answer.body),
        ...(callKey === undefined ? {} : { callKey })
    };
}

// The exit code comes from the table, never from `details.exitCode`. Where the
// server sends one and it disagrees, the table wins — and the disagreement is a
// contract-test failure rather than a runtime branch.
// One journal line per call, whatever the outcome. This is the mechanism an
// agent that crashed mid-send recovers through: it reads back the call key and
// retries the same call, which is idempotent by construction. Written after the
// answer is known rather than before it, so a line always carries a real
// outcome — a journal of intentions would be worse than none.
function entryFor(call: RailCall, callKey: string | undefined, exit: number, code?: string): JournalEntry
{
    return {
        profile: call.session.profile,
        command: call.commandPath ?? call.spec.path,
        ...(callKey === undefined ? {} : { call_key: callKey }),
        exit,
        ...(code === undefined ? {} : { code })
    };
}

function railFailure(answer: HttpAnswer, callKey: string | undefined): CliError
{
    const { code, message, fields } = normalizeError(answer.body as RawBody);
    const mapped = mapStatus(answer, code);
    const exit = exitFor(mapped);
    const withPace = { ...fields, ...paceFor(mapped, fields, answer.headers) };
    const complete = exit === 3 && callKey !== undefined ? { ...withPace, idempotency_key: callKey } : withPace;
    return new CliError(message, mapped, complete, exit);
}

// Statuses that carry no app code of their own still have to reach a code an
// agent can branch on.
function mapStatus(answer: HttpAnswer, code: string): string
{
    if (answer.status === 429)
    {
        return "rate_limited";
    }
    // §2.5 names 502, 503 and 504 — the statuses that mean "ask again shortly"
    // — and deliberately not 500. A 500 is this server failing on this request,
    // which retrying unchanged does not fix, and calling it exit 3 would tell an
    // agent to loop on it. It falls to `bad_request`'s exit-1 catch-all below.
    if (RETRYABLE_STATUS.has(answer.status) && answer.status !== 429)
    {
        return "server_unavailable";
    }
    // A 500 is this server failing on this request. Naming it `bad_request`
    // would blame the caller for a fault that is not theirs, and naming it
    // `server_unavailable` would put it in the exit-3 set and tell an agent to
    // retry something retrying does not fix.
    if (answer.status >= 500)
    {
        return "server_error";
    }
    if (code === "unknown_error" || /Error$/.test(code))
    {
        return answer.status === 404 ? "not_found" : "bad_request";
    }
    return code;
}

function paceFor(code: string, fields: ErrorFields, headers: Record<string, string>): ErrorFields
{
    if (fields.retry_after_s !== undefined)
    {
        return {};
    }
    const header = retryAfterMs(headers);
    if (header !== undefined)
    {
        return { retry_after_s: Math.round(header / 1000) };
    }
    const declared = EXIT_3_CODES[code];
    return declared === undefined ? {} : { retry_after_s: declared };
}

async function sendOnce(call: RailCall, profile: Profile, callKey: string | undefined, signal?: AbortSignal): Promise<HttpAnswer>
{
    const base = assertApiBase(profile.api_base);
    const url = `${base}${call.spec.path}${queryString(call.spec.query)}`;
    const timeoutMs = call.spec.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const headers: Record<string, string> = {
        authorization: `Bearer ${bearer(profile)}`,
        ...clientHeaders(call.session)
    };
    const options = call.spec.form === undefined
        ? jsonRequest(call, callKey, headers, timeoutMs)
        : multipartRequest(call.spec.form, headers, timeoutMs);
    return attempt(url, { ...options, signal });
}

// The bearer scheme is the literal `Bearer ` followed by a token that must
// start with `sa_`. Anything else is treated as absent rather than sent.
function bearer(profile: Profile): string
{
    if (!profile.access_token.startsWith("sa_"))
    {
        throw fail("login_required", "the stored access token is not an agent credential", { hint: "self login" });
    }
    return profile.access_token;
}

function jsonRequest(call: RailCall, callKey: string | undefined, headers: Record<string, string>, timeoutMs: number): HttpOptions
{
    const body = call.spec.body === undefined ? undefined
        // The key is a body field named `idempotencyKey`. There is no
        // `Idempotency-Key` header anywhere in the rail, and sending one would
        // be a header the server ignores while the call goes through unkeyed.
        : JSON.stringify(callKey === undefined ? call.spec.body : { ...(call.spec.body as object), idempotencyKey: callKey });
    return {
        method: call.spec.method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
        timeoutMs
    };
}

function multipartRequest(form: FormPart[], headers: Record<string, string>, timeoutMs: number): HttpOptions
{
    const boundary = `----superself${randomBytes(16).toString("hex")}`;
    return {
        method: "POST",
        headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
        body: encodeMultipart(form, boundary),
        timeoutMs
    };
}

function encodeMultipart(form: FormPart[], boundary: string): Uint8Array
{
    const chunks: Uint8Array[] = [];
    const push = (text: string): number => chunks.push(new TextEncoder().encode(text));
    for (const part of form)
    {
        const disposition = part.filename === undefined ? "" : `; filename="${part.filename}"`;
        push(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${disposition}\r\n`);
        push(`Content-Type: ${part.contentType ?? "text/plain"}\r\n\r\n`);
        chunks.push(typeof part.value === "string" ? new TextEncoder().encode(part.value) : part.value);
        push("\r\n");
    }
    push(`--${boundary}--\r\n`);
    return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array
{
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks)
    {
        out.set(chunk, at);
        at += chunk.byteLength;
    }
    return out;
}

// Three attempts, and then stop. A retry storm is worse than an honest exit 3:
// the agent owns the schedule, and the response says how long to wait.
async function attempt(url: string, options: HttpOptions): Promise<HttpAnswer>
{
    let last: unknown = null;
    for (let n = 1; n <= TRANSPORT_ATTEMPTS; n += 1)
    {
        try
        {
            const answer = await httpOnce(url, options);
            if (!RETRYABLE_STATUS.has(answer.status) || n === TRANSPORT_ATTEMPTS)
            {
                return answer;
            }
            await backoff(retryAfterMs(answer.headers) ?? backoffMs(n));
        }
        catch (error)
        {
            last = error;
            // A caller-aborted request is not a transport hiccup to retry: the
            // interrupt has already decided the outcome, so stop rather than
            // spin the backoff loop on a signal that will not change.
            if (options.signal?.aborted || !retryableError(error) || n === TRANSPORT_ATTEMPTS)
            {
                throw offline(error);
            }
            await backoff(backoffMs(n));
        }
    }
    throw offline(last);
}

// Offline, DNS failure and connect timeout are "retry this unchanged later",
// not "you did something wrong" — so exit 3, with a pace, rather than exit 1.
function offline(error: unknown): CliError
{
    if (error instanceof CliError)
    {
        return error;
    }
    return pending("network_unavailable", "the rail could not be reached", { retry_after_s: 5 });
}

/* ── the unauthenticated endpoints ─────────────────────────────────── */

export interface PublicAnswer
{
    status: number;
    headers: Record<string, string>;
    body: JsonValue;
    // The bytes as they arrived. The trust document's caller verifies a
    // signature over the **parsed** object, so it wants the text rather than
    // this module's normalization of it.
    text: string;
}

// An unauthenticated `GET`, for the one document that is public by
// construction: the plugin trust document (§1.4a). It shares this module's TLS
// policy, base-URL policy and `X-Superself-Client` header with every other
// call, and carries no credential — the keys in it are public, and it must be
// fetchable before one exists.
//
// Not retried. Its two callers each hold a better answer to a failure than a
// backoff loop does: a load falls back to its cache, and an install exits 3
// with a pace for the agent to retry at.
export async function publicGet(base: string, path: string, session: RailSession,
    options: { headers?: Record<string, string>; cap?: ResponseCap } = {}): Promise<PublicAnswer>
{
    assertTlsPolicy();
    const answer = await httpOnce(`${assertApiBase(base)}${path}`, {
        method: "GET",
        headers: { ...clientHeaders(session), ...(options.headers ?? {}) },
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...(options.cap === undefined ? {} : { cap: options.cap })
    });
    return { status: answer.status, headers: answer.headers, body: answer.body, text: answer.text };
}

// The device endpoints carry no credential, so they cannot go through
// `railRequest` — there is nothing to authenticate with until they succeed.
// `retry` is false for `POST /api/device/poll`: that endpoint is already a loop
// with server-declared pacing, and retrying inside its interval slot is the one
// behaviour that can permanently expire the grant.
export async function publicPost(base: string, path: string, body: JsonValue,
    session: RailSession, retry = true): Promise<PublicAnswer>
{
    assertTlsPolicy();
    const options: HttpOptions = {
        method: "POST",
        headers: { "content-type": "application/json", ...clientHeaders(session) },
        body: JSON.stringify(body),
        timeoutMs: REQUEST_TIMEOUT_MS
    };
    const url = `${assertApiBase(base)}${path}`;
    const answer = retry ? await attempt(url, options) : await httpOnce(url, options);
    return { status: answer.status, headers: answer.headers, body: answer.body, text: answer.text };
}
