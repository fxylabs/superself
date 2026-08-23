// The trust document: which keys may sign a plugin release, and until when.
//
// v0.3 of this design compiled the release public keys into the CLI and ruled
// that a fetched key set is not a pin. That is true, and it is also why the
// model is inverted here: a compiled release key cannot be **withdrawn**. A
// leaked signing key would keep verifying plugins on every machine that never
// updates, for up to a year — and a leaked signing key is the one incident
// signing exists to stop.
//
// So the CLI pins **roots** (`rootkeys.ts`), and the release keys live in a
// short-lived JSON document the rail serves and a root signs. Adding a key,
// revoking one, or raising a version floor is a document a root signs, not a
// CLI release. The rail is trusted for delivery and for nothing else: it can
// serve a stale document, and it can serve none, but it cannot invent one.
//
// Two asymmetries here are deliberate and are the whole of the availability
// story:
//
//   - **Install is fail-closed.** New code entering the machine must be judged
//     against a document fetched now, or not enter.
//   - **Load is fail-open on a valid cache.** Refusing to run an already
//     installed plugin whenever the rail is unreachable would break every
//     offline machine and every rail incident — a worse outcome than a
//     revocation arriving one refresh later. The 24 h refresh bounds that delay
//     for any machine that is online at all.

import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { configDir, now as systemNow, replacePrivateFile, writePrivateFile } from "./credentials.js";
import { DEFAULT_API_BASE, readProfile } from "./credentials.js";
import { ROOT_KEYS, RootKey, SIGNATURE_ALG, findRootKey } from "./rootkeys.js";
import { RailSession, jcs, publicGet } from "./rail.js";
import { CliError, JsonValue, fail, pending } from "./types.js";

/* ── constants (design §10) ────────────────────────────────────────── */

// How old a cached document may be before a load tries to refresh it. One
// conditional GET; a 304 costs nothing.
export const TRUST_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;
// The cap on the served document, enforced while the body arrives and again
// before `JSON.parse` — so a hostile rail cannot make this process parse, or
// even hold, more than this.
export const TRUST_DOCUMENT_CAP_BYTES = 64 * 1024;
// The pace a `trust_unavailable` tells the caller to retry at.
export const TRUST_UNAVAILABLE_RETRY_S = 5;
// The route. Unauthenticated: public keys are public, and the document has to
// be fetchable before a credential exists.
export const TRUST_PATH = "/api/plugins/trust";

// The write lock is a real wait, so it is measured against the wall clock
// rather than the injectable one. It bounds a race, not a policy.
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;

/* ── the document ──────────────────────────────────────────────────── */

// The document format this CLI knows how to read. A document announcing any
// other version is refused rather than read leniently: a later format may mean
// something different by a field this one believes it understands, and a
// version number nobody checks is a version number nobody can change.
const TRUST_VERSION = 1;

type TrustKeyStatus = "active" | "revoked";

export interface TrustKey
{
    kid: string;
    alg: string;
    // Raw 32-byte ed25519 public key, base64 — the same encoding a pinned root
    // uses, so there is one shape to read and one to rebuild a key from.
    public_key: string;
    not_before: string;
    not_after: string;
    status: TrustKeyStatus;
    revoked_at?: string;
}

export interface TrustDocument
{
    trust_version: number;
    issued_at: string;
    expires_at: string;
    keys: TrustKey[];
    // The floor per plugin key, compared as SemVer. Raised when a release is
    // withdrawn for a security reason; lowered only by a later document a root
    // signs, never by a flag.
    min_plugin_versions?: Record<string, string>;
    min_cli_version?: string;
}

interface TrustSignature
{
    kid: string;
    alg: string;
    sig: string;
}

interface SignedTrust
{
    document: TrustDocument;
    signature: TrustSignature;
}

// What a caller holds: the document, who signed it, and when this machine last
// heard from the rail about it.
export interface TrustState
{
    document: TrustDocument;
    signature: TrustSignature;
    fetched_at: string;
    etag?: string;
}

/* ── reading the document ──────────────────────────────────────────── */

// A `kid` lookup among the document's own keys. A lookup, never a
// construction — the signature block cannot introduce a key any more than it
// can introduce a root.
//
// The first match is the only match, because a document carrying the same `kid`
// twice never gets this far: `signedTrustOf` refuses it. A kid has to name one
// key or the document does not say what it appears to say.
export function documentKey(trust: TrustDocument, kid: string): TrustKey | undefined
{
    return trust.keys.find((key) => key.kid === kid);
}

// The floor for one plugin key, or nothing. `hasOwnProperty` rather than a
// plain index: a plugin key may legally be `constructor`, and reading that off
// the prototype would hand the loader a function where it expects a version.
export function minimumVersion(trust: TrustDocument, key: string): string | undefined
{
    const floors = trust.min_plugin_versions;
    if (floors === undefined || !Object.prototype.hasOwnProperty.call(floors, key))
    {
        return undefined;
    }
    const floor = floors[key];
    return typeof floor === "string" ? floor : undefined;
}

// Stale, not hostile. An expired document still verifies installed plugins; it
// only refuses new installs.
export function trustExpired(state: TrustState, at: () => Date = systemNow): boolean
{
    return Date.parse(state.document.expires_at) <= at().getTime();
}

/* ── verification ──────────────────────────────────────────────────── */

// ed25519 raw public keys are 32 bytes; `createPublicKey` wants DER, and the
// SPKI header for ed25519 is a fixed 12-byte prefix.
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

// The bytes are a document's, so they are an attacker's: the wrong length, not
// base64, not a point on the curve. `createPublicKey` answers all three with a
// raw OpenSSL error, which is not a refusal this CLI has a name for — so the
// caller supplies the name, because a key the document could not describe and a
// key a release was signed by are two different refusals.
export function ed25519Key(publicKeyBase64: string, code: string): ReturnType<typeof createPublicKey>
{
    const der = Buffer.concat([SPKI_ED25519, Buffer.from(publicKeyBase64, "base64")]);
    try
    {
        return createPublicKey({ key: der, format: "der", type: "spki" });
    }
    catch
    {
        throw fail(code, "a public key this signature is checked against is not a valid ed25519 public key");
    }
}

// The whole of what makes a document acceptable, in the order that closes the
// algorithm-confusion surface by construction: `alg` is an equality check
// against a constant, `kid` is a lookup among the pinned roots, and only then
// does a byte reach the verifier. A `kid` naming a **release** key — one of the
// document's own — has no answer here and is refused before verification runs.
//
// `issued_at` is judged only against the signing root's window, never against
// this machine's idea of now. A document issued a few minutes in the future is
// an operator whose clock differs from ours, not an attack, and refusing it
// would make a clock skew look like a compromise. What bounds a stale document
// is `expires_at` and what bounds a replayed one is monotonicity — both of them
// statements the root signed, rather than a comparison with a local clock the
// same attacker could move.
//
// `verifierCalls` counts how many times a document signature was put in front
// of the ed25519 verifier. Nothing decides anything by it — it is incremented
// beside the call and read by no code path — and it exists because cell 169's
// claim is a **negative**: a document whose `alg` or `kid` is wrong is refused
// without the verifier ever being consulted, and "never consulted" is only
// assertable by counting.
let verifierCalls = 0;

export function trustVerifierCalls(): number
{
    return verifierCalls;
}

function verifyTrust(signed: SignedTrust, roots: readonly RootKey[]): RootKey
{
    if (signed.signature.alg !== SIGNATURE_ALG)
    {
        throw invalidTrust(`the trust document's signature algorithm "${String(signed.signature.alg)}" is not accepted`);
    }
    const root = findRootKey(signed.signature.kid, roots);
    if (root === undefined)
    {
        throw invalidTrust(`no pinned root key "${signed.signature.kid}" signs a trust document this CLI accepts`);
    }
    const issued = Date.parse(signed.document.issued_at);
    if (issued < Date.parse(root.notBefore) || issued >= Date.parse(root.notAfter))
    {
        throw invalidTrust(`root "${root.kid}" was not valid when this document was issued`);
    }
    const body = Buffer.from(jcs(signed.document as unknown as JsonValue));
    verifierCalls += 1;
    if (!verify(null, body, ed25519Key(root.publicKey, "trust_document_invalid"), Buffer.from(signed.signature.sig, "base64")))
    {
        throw invalidTrust("the trust document is not signed by a pinned root");
    }
    return root;
}

/* ── shape ─────────────────────────────────────────────────────────── */

function objectOf(value: unknown): Record<string, unknown> | null
{
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function isTimestamp(value: unknown): boolean
{
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isTrustKey(value: unknown): boolean
{
    const key = objectOf(value);
    return key !== null
        && typeof key.kid === "string" && typeof key.alg === "string" && typeof key.public_key === "string"
        && isTimestamp(key.not_before) && isTimestamp(key.not_after)
        && (key.status === "active" || key.status === "revoked");
}

function areFloors(value: unknown): boolean
{
    const floors = objectOf(value);
    return floors !== null && Object.values(floors).every((floor) => typeof floor === "string");
}

// One `kid`, one key. Two records sharing a kid would leave which of them is in
// force decided by the order the document happens to list them in — a revoked
// key beside an active copy of itself is not a statement, it is two, and the
// lookup would silently pick one. A document that ambiguous is refused whole.
function distinctKids(keys: readonly unknown[]): boolean
{
    const kids = keys.map((key) => String((key as TrustKey).kid));
    return new Set(kids).size === kids.length;
}

// The parsed document, checked into shape before anything reads a field off it.
// A document that fails here never reaches the verifier, so nothing downstream
// has to ask whether `keys` is an array — or whether the format it is reading is
// the format the document was written in.
export function signedTrustOf(value: unknown): SignedTrust | null
{
    const record = objectOf(value);
    const document = objectOf(record?.document);
    const signature = objectOf(record?.signature);
    if (document === null || signature === null || document.trust_version !== TRUST_VERSION)
    {
        return null;
    }
    if (!isTimestamp(document.issued_at) || !isTimestamp(document.expires_at))
    {
        return null;
    }
    if (!Array.isArray(document.keys) || !document.keys.every(isTrustKey) || !distinctKids(document.keys))
    {
        return null;
    }
    if (document.min_plugin_versions !== undefined && !areFloors(document.min_plugin_versions))
    {
        return null;
    }
    const signed = ["kid", "alg", "sig"].every((field) => typeof signature[field] === "string");
    return signed ? { document, signature } as unknown as SignedTrust : null;
}

/* ── the 0600 cache ────────────────────────────────────────────────── */

function trustCachePath(): string
{
    return join(configDir(), "trust.json");
}

function trustLockPath(): string
{
    return join(configDir(), "trust.lock");
}

// The cache lives beside the credential file and answers to the same rule: no
// other user may read or write it. A file that fails the rule is treated as
// absent rather than refused — it holds nothing secret, the document in it
// still has to satisfy the root signature to be used at all, and refusing
// outright would let anyone who can touch the config directory stop the CLI
// from loading a plugin it already trusts.
function privateEnough(path: string): boolean
{
    if (process.platform === "win32")
    {
        return true;
    }
    const stats = statSync(path);
    return (stats.mode & 0o077) === 0 && stats.uid === process.getuid?.();
}

// A tampered cache fails root verification and is treated as absent — never as
// unlocked. Every way of not having a usable document answers the same way, so
// there is one path for the caller to reason about.
function readTrustCache(roots: readonly RootKey[]): TrustState | null
{
    const path = trustCachePath();
    try
    {
        return existsSync(path) && privateEnough(path) ? verifiedRecord(readFileSync(path, "utf8"), roots) : null;
    }
    catch
    {
        return null;
    }
}

function verifiedRecord(text: string, roots: readonly RootKey[]): TrustState | null
{
    const record = objectOf(JSON.parse(text) as unknown);
    const signed = signedTrustOf(record?.trust);
    if (signed === null || !isTimestamp(record?.fetched_at))
    {
        return null;
    }
    verifyTrust(signed, roots);
    return {
        document: signed.document,
        signature: signed.signature,
        fetched_at: String(record?.fetched_at),
        ...(typeof record?.etag === "string" ? { etag: record.etag } : {})
    };
}

/* ── writing the cache, and the race two processes make ────────────── */

// The temp file is `O_EXCL` and the rename is atomic, so the file on disk is
// never torn. What the rename alone does not settle is *which* document wins:
// two processes refreshing at once can hold different documents, and a loser
// holding an older one must not overwrite a newer one. So the document on disk
// is re-read and re-verified inside a dedicated `trust.lock`, and the write
// happens only when what this process holds is at least as new.
//
// A lock this process cannot take is never a reason to fail. The fresh document
// is already in memory for this run, and the next run refreshes.
//
// What comes back is the document **this run is judged under**, which is not
// always the one that went in. When disk already holds a newer document, the
// write is skipped — and returning the older one anyway would let this process
// install or load under keys the newer document revoked, which is precisely the
// state monotonicity exists to make unreachable. So the newer document wins the
// comparison and the caller's answer both.
async function writeTrustCache(state: TrustState, roots: readonly RootKey[]): Promise<TrustState>
{
    let authoritative = state;
    await withTrustLock(() =>
    {
        const onDisk = readTrustCache(roots);
        if (onDisk !== null && Date.parse(state.document.issued_at) < Date.parse(onDisk.document.issued_at))
        {
            authoritative = onDisk;
            return;
        }
        const record = {
            version: 1,
            fetched_at: state.fetched_at,
            ...(state.etag === undefined ? {} : { etag: state.etag }),
            trust: { document: state.document, signature: state.signature }
        };
        replacePrivateFile(trustCachePath(), `${JSON.stringify(record, null, 2)}\n`);
    });
    return authoritative;
}

async function withTrustLock(work: () => void): Promise<void>
{
    const path = trustLockPath();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!takeTrustLock(path))
    {
        if (Date.now() > deadline)
        {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try
    {
        work();
    }
    finally
    {
        releaseTrustLock(path);
    }
}

function takeTrustLock(path: string): boolean
{
    try
    {
        writePrivateFile(path, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
        return true;
    }
    catch
    {
        breakStaleTrustLock(path);
        return false;
    }
}

// A lock left by a process that was killed. Age alone is enough here: unlike
// the credential lock, the worst a wrong break can cost is one cache write that
// the `issued_at` comparison inside the lock would have skipped anyway.
function breakStaleTrustLock(path: string): void
{
    try
    {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS)
        {
            unlinkSync(path);
        }
    }
    catch
    {
        // Already gone, which is the state a break wants.
    }
}

function releaseTrustLock(path: string): void
{
    try
    {
        unlinkSync(path);
    }
    catch
    {
        // Already gone, which is the state a release wants.
    }
}

/* ── fetching ──────────────────────────────────────────────────────── */

interface TrustAnswer
{
    status: number;
    etag?: string;
    text: string;
}

// Injected only by a test. Every CLI path uses the rail client below, and no
// environment variable, flag or file reaches this parameter.
type TrustFetch = (etag: string | undefined) => Promise<TrustAnswer>;

// The profile's rail when there is one, and the default rail when there is not.
// `self app trust` has to work before `self login` does.
function trustApiBase(profile: string): string
{
    try
    {
        return readProfile(profile).api_base;
    }
    catch
    {
        return process.env.SUPERSELF_API_BASE ?? DEFAULT_API_BASE;
    }
}

// Unauthenticated, and not retried. A retry loop would make an offline load
// wait through three backoffs before falling back to a cache it already holds;
// `trust_unavailable` carries the pace instead and the caller owns the schedule.
function railFetch(session: RailSession): TrustFetch
{
    return async (etag) =>
    {
        const answer = await publicGet(trustApiBase(session.profile), TRUST_PATH, session, {
            headers: etag === undefined ? {} : { "if-none-match": etag },
            cap: { bytes: TRUST_DOCUMENT_CAP_BYTES, code: "trust_document_too_large" }
        });
        return {
            status: answer.status,
            ...(typeof answer.headers.etag === "string" ? { etag: answer.headers.etag } : {}),
            text: answer.text
        };
    };
}

/* ── refusals ──────────────────────────────────────────────────────── */

function invalidTrust(message: string): CliError
{
    return fail("trust_document_invalid", message,
        { hint: "this CLI accepts a plugin key list only when a pinned root signed it" });
}

function unavailable(message: string, reason?: string): CliError
{
    return pending("trust_unavailable", message, {
        retry_after_s: TRUST_UNAVAILABLE_RETRY_S,
        ...(reason === undefined ? {} : { reason }),
        hint: "retry; if it persists run self app install <key> --force when online"
    });
}

function rollback(): CliError
{
    return fail("trust_document_rollback",
        "the rail served a plugin key list older than the one this machine already has",
        { hint: "a revocation this machine has already seen cannot be withdrawn by an older list" });
}

/* ── the entry point ───────────────────────────────────────────────── */

interface TrustOptions
{
    // Install fetches and refuses on anything less than a current, valid
    // document. Load falls back to a valid cache.
    mode: "install" | "load";
    session: RailSession;
    // `self app trust --refresh`: treat the cache as due whatever its age.
    refresh?: boolean;
    // Test injection. No CLI path passes either (cell 171).
    roots?: readonly RootKey[];
    fetch?: TrustFetch;
    now?: () => Date;
}

export async function loadTrustDocument(options: TrustOptions): Promise<TrustState>
{
    const roots = options.roots ?? ROOT_KEYS;
    const at = options.now ?? systemNow;
    const cached = readTrustCache(roots);
    return options.mode === "install"
        ? installDocument(options, roots, at, cached)
        : loadDocument(options, roots, at, cached);
}

// Fail-closed. Install always fetches — a cache, however fresh, is what the
// rail said last time, and new code entering the machine is judged against what
// it says now. Every refusal is terminal and nothing is written.
async function installDocument(options: TrustOptions, roots: readonly RootKey[],
    at: () => Date, cached: TrustState | null): Promise<TrustState>
{
    const fetched = await fetchTrust(options, roots, cached);
    const state = fetched ?? (cached as TrustState);
    if (fetched !== null && cached !== null && older(fetched, cached))
    {
        throw rollback();
    }
    assertCurrent(state, at);
    // The write may hand back a **newer** document another process cached while
    // this one was fetching, and that document — not the one in hand — is what
    // this install is judged under. It may revoke a key this one still calls
    // active, and it is checked for expiry on its own terms.
    const stored = await writeTrustCache({ ...state, fetched_at: at().toISOString() }, roots);
    assertCurrent(stored, at);
    return stored;
}

function assertCurrent(state: TrustState, at: () => Date): void
{
    if (trustExpired(state, at))
    {
        throw fail("trust_document_expired",
            `the plugin key list expired at ${state.document.expires_at}`,
            { hint: "the operator has not published a current key list — try again later" });
    }
}

// Fail-open on a valid cache. A plugin already on this machine keeps working
// offline; a revocation reaches it on the next refresh, which is at most 24 h
// away for a machine that is online at all.
async function loadDocument(options: TrustOptions, roots: readonly RootKey[],
    at: () => Date, cached: TrustState | null): Promise<TrustState>
{
    if (cached === null)
    {
        return firstDocument(options, roots, at);
    }
    if (options.refresh !== true && !dueForRefresh(cached, at))
    {
        return cached;
    }
    const outcome = await refreshOrKeep(options, roots, at, cached);
    // **Exactly one** note, decided here rather than at each site that could
    // produce one. A refresh that failed and a document that has expired are two
    // reasons to say something and one thing worth saying; two lines on stderr
    // for one load would read as two problems.
    const note = outcome.note ?? expiryNote(outcome.state, at);
    if (note !== undefined)
    {
        options.session.notice?.(note);
    }
    return outcome.state;
}

function expiryNote(state: TrustState, at: () => Date): string | undefined
{
    return trustExpired(state, at)
        ? `notice: the plugin key list expired at ${state.document.expires_at} — installed mini-apps still load, new installs do not`
        : undefined;
}

// Nothing to fall back on, so §1.3 step 0 applies without exception: a fetch
// that fails, or a document that does not verify, is exit 3 and no import. The
// underlying reason travels in `reason` so an operator is not left guessing.
async function firstDocument(options: TrustOptions, roots: readonly RootKey[], at: () => Date): Promise<TrustState>
{
    let fetched: TrustState | null;
    try
    {
        fetched = await fetchTrust(options, roots, null);
    }
    catch (error)
    {
        throw unavailable("this machine has no plugin key list and could not obtain one", codeOf(error));
    }
    return writeTrustCache({ ...(fetched as TrustState), fetched_at: at().toISOString() }, roots);
}

interface Refreshed
{
    state: TrustState;
    // What the caller should say about it, if anything. Returned rather than
    // printed so the one note per load is decided in one place.
    note?: string;
}

// A refresh that does not land is never fatal at load: the cache stands and the
// plugin runs. Nothing on stdout changes either, so a `--json` caller sees
// exactly the answer it would have seen.
async function refreshOrKeep(options: TrustOptions, roots: readonly RootKey[],
    at: () => Date, cached: TrustState): Promise<Refreshed>
{
    let fetched: TrustState | null;
    try
    {
        fetched = await fetchTrust(options, roots, cached);
    }
    catch (error)
    {
        return { state: cached, note: keptNote(codeOf(error)) };
    }
    if (fetched !== null && older(fetched, cached))
    {
        return { state: cached, note: keptNote("trust_document_rollback") };
    }
    // Again the write decides: a document another process cached in the meantime
    // is newer than this one and governs the load that follows it.
    return { state: await writeTrustCache({ ...(fetched ?? cached), fetched_at: at().toISOString() }, roots) };
}

function keptNote(code: string): string
{
    return `notice: keeping the cached plugin key list — ${code}`;
}

function older(fetched: TrustState, cached: TrustState): boolean
{
    return Date.parse(fetched.document.issued_at) < Date.parse(cached.document.issued_at);
}

// Older than the refresh age, or already expired. An expired document is
// refreshed on sight rather than at the next 24 h boundary, because the
// operator publishing a new one is exactly what a machine holding it is waiting
// for.
function dueForRefresh(cached: TrustState, at: () => Date): boolean
{
    return at().getTime() - Date.parse(cached.fetched_at) >= TRUST_REFRESH_AGE_MS || trustExpired(cached, at);
}

function codeOf(error: unknown): string
{
    return error instanceof CliError && error.code !== undefined ? error.code : "trust_unavailable";
}

// One conditional GET. `null` means 304 — the cache is current and only its
// `fetched_at` moves. `If-None-Match` is sent only when there is a cache to
// match, so a 304 without one is a rail misbehaving and is refused as invalid.
async function fetchTrust(options: TrustOptions, roots: readonly RootKey[],
    cached: TrustState | null): Promise<TrustState | null>
{
    const answer = await attemptFetch(options.fetch ?? railFetch(options.session), cached?.etag);
    if (answer.status === 304)
    {
        if (cached === null)
        {
            throw invalidTrust("the rail answered 304 to a request that carried no If-None-Match");
        }
        return null;
    }
    if (answer.status !== 200)
    {
        throw unavailable(`the rail answered ${answer.status} for the plugin key list`);
    }
    return checked(answer, roots);
}

// The cap is enforced twice: while the body arrives, so a hostile rail cannot
// make this process hold more than 64 KB, and here, before `JSON.parse` ever
// sees a byte.
function checked(answer: TrustAnswer, roots: readonly RootKey[]): TrustState
{
    if (Buffer.byteLength(answer.text) > TRUST_DOCUMENT_CAP_BYTES)
    {
        throw fail("trust_document_too_large",
            `the plugin key list is larger than ${TRUST_DOCUMENT_CAP_BYTES} bytes`);
    }
    const signed = signedTrustOf(parsed(answer.text));
    if (signed === null)
    {
        throw invalidTrust("the rail did not answer with a signed plugin key list");
    }
    // Over `jcs` of the **parsed** object, so nothing about how the bytes were
    // spelled can matter: duplicate keys, whitespace and member order are all
    // gone by now, and a document whose canonical form differs from the one the
    // root signed fails here.
    verifyTrust(signed, roots);
    return { document: signed.document, signature: signed.signature, fetched_at: "", ...etagOf(answer) };
}

function etagOf(answer: TrustAnswer): { etag?: string }
{
    return answer.etag === undefined ? {} : { etag: answer.etag };
}

function parsed(text: string): unknown
{
    try
    {
        return JSON.parse(text) as unknown;
    }
    catch
    {
        return null;
    }
}

async function attemptFetch(fetch: TrustFetch, etag: string | undefined): Promise<TrustAnswer>
{
    try
    {
        return await fetch(etag);
    }
    catch (error)
    {
        throw transportFailure(error);
    }
}

// A document over the cap is a statement about the document and keeps its own
// name; everything else about a fetch that did not answer is `trust_unavailable`.
function transportFailure(error: unknown): CliError
{
    if (error instanceof CliError && error.code === "trust_document_too_large")
    {
        return error;
    }
    return unavailable("the rail could not be reached for the plugin key list");
}
