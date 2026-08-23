// Plugin discovery, verification and loading — the first dynamic import in
// this codebase, and the only one.
//
// The order of the load sequence is the design. Step 0 is the trust document
// (`trust.ts`) — the signed, expiring list of which keys may have signed a
// release, and which have been revoked since. Every step after it and before
// the import is a cheap local check, and the import — the first moment plugin
// code can run — is deliberately last, so a plugin that fails any check never
// executes a byte.
// Two of those checks exist because a signature alone is not enough: everything
// we have ever published is correctly signed forever, so a signed release of
// one plugin, or a signed older release of this one, verifies happily in the
// wrong place unless the manifest's own `key` and `version` are compared with
// the directory names they were installed under.
//
// What this does not buy is isolation. A loaded plugin runs in this process
// with full Node privileges and can read the credential file directly whatever
// the host API says. The mitigation for a malicious plugin is provenance, not
// confinement, and saying so plainly is part of the design rather than an
// omission from it.

import { verify } from "node:crypto";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, branch, checkContract, leaf } from "./contract.js";
import { ensurePrivateDir, now, readProfile, replacePrivateFile, stateDir } from "./credentials.js";
import { SIGNATURE_ALG } from "./rootkeys.js";
import { TrustDocument, TrustKey, documentKey, ed25519Key, minimumVersion } from "./trust.js";
import {
    RailRequestSpec, RailResponse, RailSession, jcs, railMajor, railRequest, sanitizeText
} from "./rail.js";
import { JsonValue, OutputBlock, PayloadBlock, fail, pending, refuse } from "./types.js";

/* ── constants (design §1.1, §10) ──────────────────────────────────── */

export const PLUGIN_ENTRY_CAP_BYTES = 4 * 1024 * 1024;
// The mini-app contract versions this host implements. A manifest naming
// anything else is refused rather than loaded and hoped for.
export const SUPPORTED_CONTRACTS = [0];
export const PLUGIN_KEY_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
// SemVer 2.0, with the prerelease and build parts anchored to the characters
// SemVer actually allows. `(?:[-+].*)?` was wrong in a way that mattered: a
// version is a **directory name** here, and `.*` accepts `/` and `..`, so a
// release document — or an attacker-writable `current` file — carrying
// `1.0.0-../../../../tmp/x` reached `mkdirSync` and `writeFileSync` outside the
// plugin tree. A signature check gates execution; it does not gate the path a
// verified document is written to.
// The prerelease part is captured because precedence depends on it: `0.1.2-alpha`
// is **below** `0.1.2`, and a comparison that read the core alone would let a
// prerelease pass a floor the released version of itself sits exactly on.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

// The same statement a second way. The regex is one reading of what a version
// may contain; this is an explicit reading of what a path segment may never
// contain, and a value that reaches the filesystem is worth both.
const PATH_ESCAPE = /[/\\]|\.\./;
// A private copy older than this belonged to a process that was killed before
// it could clean up. Reaped by age on the next load.
const LOADED_REAP_MS = 60 * 60 * 1000;

/* ── where a plugin lives ──────────────────────────────────────────── */

export function pluginsDir(): string
{
    return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "superself", "plugins");
}

export function pluginStatePath(): string
{
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "superself", "plugin-state.json");
}

export function pluginKey(key: string): string
{
    if (!PLUGIN_KEY_PATTERN.test(key) || PATH_ESCAPE.test(key))
    {
        throw fail("invalid_plugin_key", `"${sanitizeText(key)}" is not a plugin key`);
    }
    return key;
}

// A version reaches the filesystem as a directory name, so it is a SemVer
// before it is a path.
export function pluginVersion(version: string): string
{
    if (!SEMVER.test(version) || PATH_ESCAPE.test(version))
    {
        throw fail("invalid_plugin_version", `"${sanitizeText(version)}" is not a semantic version`);
    }
    return version;
}

/* ── plugin-state.json — outside the plugin tree, at 0600 ──────────── */

interface PluginStateEntry
{
    // The highest version ever installed for this key. It lives here rather
    // than in the plugin tree because the tree is writable by exactly the
    // attacker the high-water mark defends against, and a guard inside what it
    // guards is not a guard.
    highest: string;
    rail_api_seen?: string;
    installed_at: string;
}

interface PluginState
{
    version: 1;
    plugins: Record<string, PluginStateEntry>;
}

export function readPluginState(): PluginState
{
    const path = pluginStatePath();
    if (!existsSync(path))
    {
        return { version: 1, plugins: {} };
    }
    try
    {
        return JSON.parse(readFileSync(path, "utf8")) as PluginState;
    }
    catch
    {
        throw fail("plugin_state_unreadable", `${path} is not readable`, { hint: "self app install <key> --force" });
    }
}

export function writePluginState(state: PluginState): void
{
    replacePrivateFile(pluginStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function setPluginState(key: string, entry: PluginStateEntry): void
{
    const state = readPluginState();
    writePluginState({ version: 1, plugins: { ...state.plugins, [key]: entry } });
}

/* ── SemVer, only as much as a manifest needs ──────────────────────── */

export function compareVersions(left: string, right: string): number
{
    const a = SEMVER.exec(left);
    const b = SEMVER.exec(right);
    if (a === null || b === null)
    {
        return left === right ? 0 : left.localeCompare(right);
    }
    for (let n = 1; n <= 3; n += 1)
    {
        const diff = Number(a[n]) - Number(b[n]);
        if (diff !== 0)
        {
            return diff < 0 ? -1 : 1;
        }
    }
    return comparePrerelease(a[4], b[4]);
}

// SemVer 2.0 §11, and the reason the floor needs it: a version carrying a
// prerelease is **lower** than the same core without one, so `0.1.2-alpha` is
// below the floor `0.1.2` rather than equal to it. Build metadata (`+…`) is
// captured by nothing above, because §10 says it never affects precedence.
function comparePrerelease(left: string | undefined, right: string | undefined): number
{
    if (left === undefined && right === undefined)
    {
        return 0;
    }
    if (left === undefined || right === undefined)
    {
        // The released version outranks the prerelease of itself.
        return left === undefined ? 1 : -1;
    }
    const a = left.split(".");
    const b = right.split(".");
    for (let n = 0; n < Math.max(a.length, b.length); n += 1)
    {
        const diff = compareIdentifier(a[n], b[n]);
        if (diff !== 0)
        {
            return diff;
        }
    }
    return 0;
}

const NUMERIC_IDENTIFIER = /^\d+$/;

// A prerelease that runs out of identifiers first is the lower one
// (`alpha` < `alpha.1`); numeric identifiers compare as numbers and rank below
// alphanumeric ones; everything else compares by ASCII, which is what `<` is
// over the characters SemVer allows here.
function compareIdentifier(left: string | undefined, right: string | undefined): number
{
    if (left === undefined || right === undefined)
    {
        return left === undefined ? -1 : 1;
    }
    const leftIsNumber = NUMERIC_IDENTIFIER.test(left);
    const rightIsNumber = NUMERIC_IDENTIFIER.test(right);
    if (leftIsNumber && rightIsNumber)
    {
        return sign(Number(left) - Number(right));
    }
    if (leftIsNumber !== rightIsNumber)
    {
        return leftIsNumber ? -1 : 1;
    }
    // `<` over these characters is code-unit order, which is the ASCII order
    // SemVer §11 names — `localeCompare` is not, because it folds case.
    if (left === right)
    {
        return 0;
    }
    return left < right ? -1 : 1;
}

function sign(diff: number): number
{
    if (diff === 0)
    {
        return 0;
    }
    return diff < 0 ? -1 : 1;
}

// The range forms a manifest actually uses: `*`, `^1`, `^1.2.3`, `>=1.2.3`,
// and a space-separated conjunction of comparators. Anything richer is refused
// rather than approximated, because a range this cannot read must not silently
// pass.
export function satisfies(version: string, range: string): boolean
{
    const trimmed = range.trim();
    if (trimmed === "" || trimmed === "*")
    {
        return true;
    }
    return trimmed.split(/\s+/).every((part) => satisfiesOne(version, part));
}

function satisfiesOne(version: string, comparator: string): boolean
{
    const caret = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
    if (caret !== null)
    {
        const lower = `${caret[1]}.${caret[2] ?? 0}.${caret[3] ?? 0}`;
        return compareVersions(version, lower) >= 0 && compareVersions(version, `${Number(caret[1]) + 1}.0.0`) < 0;
    }
    const bound = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(comparator);
    if (bound === null)
    {
        return false;
    }
    return compares(compareVersions(version, bound[2]), bound[1] ?? "=");
}

function compares(order: number, operator: string): boolean
{
    const table: Record<string, boolean> = {
        ">=": order >= 0, "<=": order <= 0, ">": order > 0, "<": order < 0, "=": order === 0
    };
    return table[operator] === true;
}

/* ── the manifest ──────────────────────────────────────────────────── */

export interface PluginManifest
{
    manifest_version: number;
    key: string;
    name: string;
    version: string;
    verbs: string[];
    requires?: string[];
    contract: number;
    rail_api: string;
    cli: string;
    scopes: string[];
    entry_sha256: string;
    entry_bytes: number;
    released_at: string;
}

interface PluginSignature
{
    kid: string;
    alg: string;
    sig: string;
}

// Step 3 of the load sequence, and the whole of what `signature` is allowed to
// decide: nothing. `alg` is an equality check against a constant, `kid` is a
// lookup among the **cached trust document's** keys, and a kid the document
// marks `revoked` is refused by name rather than quietly failing verification.
// Neither field can introduce a key — only a document a pinned root signed can
// do that (§1.1, §1.4).
export function releaseKeyOf(trust: TrustDocument, signature: PluginSignature): TrustKey
{
    if (signature.alg !== SIGNATURE_ALG)
    {
        throw fail("plugin_signature_invalid", `signature algorithm "${String(signature.alg)}" is not accepted`);
    }
    const key = documentKey(trust, String(signature.kid));
    if (key === undefined)
    {
        throw fail("plugin_signature_invalid", `the trust document names no release key "${sanitizeText(String(signature.kid))}"`);
    }
    if (key.status === "revoked")
    {
        throw fail("plugin_key_revoked", `release key "${key.kid}" has been revoked`,
            { hint: "self app install <key> --force" });
    }
    return key;
}

// Step 4. The verifier is hard-wired to ed25519 and takes the key **record**,
// not a table to look one up in — the resolution already happened, and a
// function that could resolve a kid twice is a function that could resolve it
// differently the second time.
export function verifyManifest(manifest: PluginManifest, signature: PluginSignature, key: TrustKey): void
{
    if (key.alg !== SIGNATURE_ALG)
    {
        throw fail("plugin_signature_invalid", `release key "${key.kid}" declares an algorithm this CLI does not verify`);
    }
    assertWindow(key.not_before, key.not_after, manifest.released_at);
    const keyObject = ed25519Key(key.public_key, "plugin_signature_invalid");
    if (!verify(null, Buffer.from(jcs(manifest as unknown as JsonValue)), keyObject, Buffer.from(signature.sig, "base64")))
    {
        throw fail("plugin_signature_invalid", `the release document for "${manifest.key}" is not signed by a pinned key`);
    }
}

function assertWindow(notBefore: string, notAfter: string, releasedAt: string): void
{
    const at = Date.parse(releasedAt);
    if (Number.isNaN(at) || at < Date.parse(notBefore) || at >= Date.parse(notAfter))
    {
        throw fail("plugin_signature_invalid", "the signing key's validity window does not cover this release");
    }
}

// Step 1a. A rail-independent floor: the document says the lowest version of a
// plugin this CLI may run, and it is enforced at install and at load alike.
// `--allow-downgrade` moves the *local* high-water mark and has nothing to say
// here — the floor is published, and only a later document a root signs lowers
// it.
//
// A floor naming a plugin that is not installed says nothing about anything, so
// it is ignored rather than reported.
export function assertVersionFloor(trust: TrustDocument, key: string, version: string): void
{
    const floor = minimumVersion(trust, key);
    if (floor !== undefined && compareVersions(version, floor) < 0)
    {
        throw fail("plugin_version_below_minimum",
            `"${key}" ${version} is below ${floor}, the lowest version the published key list allows`,
            { hint: `self app update ${key}` });
    }
}

// What `self app install <key>` owes a plugin it finds already at the asked-for
// version. Reporting success there is a claim that the key list allows this
// plugin to run, so the two statements the list can have changed since the
// install are re-read: the floor it may have raised and the key it may have
// revoked. In the design's order — floor first (§1.3 step 1a), then the key.
//
// The signature is not re-verified. The bytes on disk were verified when they
// were written and the load path verifies them again before importing them;
// what a new document can change is which keys and versions are allowed, not
// whether these bytes were signed.
export function assertInstalledTrusted(plugin: InstalledPlugin, trust: TrustDocument): void
{
    assertVersionFloor(trust, plugin.key, plugin.version);
    releaseKeyOf(trust, installedSignature(plugin));
}

function installedSignature(plugin: InstalledPlugin): PluginSignature
{
    return readJson<PluginSignature>(join(plugin.dir, "signature.json"),
        "plugin_signature_invalid", `${plugin.dir}/signature.json is unreadable`);
}

/* ── the host handed to a plugin ───────────────────────────────────── */

interface HostFile
{
    bytes: Uint8Array;
    name: string;
    sha256: string;
}

// Everything a plugin is given, and nothing more (design §1.2). The dependency
// is inverted on purpose: the plugin imports nothing, so there is no package to
// publish, no version to keep in step, no `peerDependency`, and no import that
// can fail to resolve from a CLI installed globally.
//
// Every security-relevant behaviour a plugin needs sits behind one of these
// members and is implemented in the open-source repository — credential read,
// scope check, refresh locking, atomic write, TLS policy, retry
// classification, control-character stripping. The paid half is a thin client
// on top, which is an assurance property worth stating rather than a side
// effect.
interface PluginHost
{
    api: 0;
    contract: { leaf: typeof leaf; branch: typeof branch; command: (spec: Command) => Command };
    output: {
        payload: (data: JsonValue, plain: () => string[], pretty?: () => string[]) => PayloadBlock;
        receipt: (text: string) => OutputBlock;
        listing: (rows: string[], total: number, noun: string, nouns?: string) => OutputBlock;
        document: (plain: () => string[], pretty?: () => string[]) => OutputBlock;
    };
    // Exit 1 / 2 / 3. A plugin never decides an exit code numerically; it names
    // which kind of answer it is giving and the one table decides.
    errors: { fail: typeof fail; refuse: typeof refuse; pending: typeof pending };
    rail: { request: (spec: RailRequestSpec) => Promise<RailResponse> };
    file: { read: (path: string) => HostFile };
    // The profile's console base, or nothing when login could not derive one.
    //
    // The core knows the base — it is stored in the profile — and deliberately
    // does not know the *paths* under it: which page tops up a wallet, and
    // which lists credentials, are commerce knowledge, and design §13.3
    // invariant (4) keeps that out of the open-source repository. So the base
    // is handed over and the plugin builds the URL, which is exactly the split
    // §2.7 and ruling Q7 describe.
    consoleBase: () => string | undefined;
    now: () => Date;
    log: { debug: (message: string) => void };
}

// The cap on a user-named input file. It is the host's rather than a plugin's
// so that no plugin can raise it, and it is the same number as the plugin entry
// cap because both answer the same question: how much attacker-influenced or
// mistake-sized data one command may pull into memory at once.
export const HOST_FILE_CAP_BYTES = 4 * 1024 * 1024;

function profileConsoleBase(profile: string): string | undefined
{
    try
    {
        return readProfile(profile).console_base;
    }
    catch
    {
        // No credential, or a profile that is not there: the plugin omits the
        // URL rather than guessing one, which is the same answer login gives
        // when the verification URL carried no suffix to strip.
        return undefined;
    }
}

function hostFile(path: string): HostFile
{
    const stats = statSync(path);
    if (stats.size > HOST_FILE_CAP_BYTES)
    {
        throw fail("file_too_large", `${path} is ${stats.size} bytes, over the ${HOST_FILE_CAP_BYTES}-byte limit`);
    }
    const bytes = readFileSync(path);
    return { bytes, name: basename(path), sha256: createHash("sha256").update(bytes).digest("hex") };
}

// A development plugin is unsigned, so every machine-readable answer it
// produces says so. Injected here rather than post-processed by the render
// gate: a plugin builds its payload through this member, so there is one place
// the mark can be added and no path around it.
export function pluginHost(session: RailSession, commandPath: () => string, development = false): PluginHost
{
    const mark = (data: JsonValue): JsonValue => (development && data !== null && typeof data === "object" && !Array.isArray(data)
        ? { ...data, plugin_source: "dev" }
        : data);
    return {
        api: 0,
        contract: { leaf, branch, command: (spec) => spec },
        output: {
            payload: (data, plain, pretty) => ({ kind: "payload", data: mark(data), plain, ...(pretty === undefined ? {} : { pretty }) }),
            receipt: (text) => ({ kind: "receipt", text }),
            listing: (rows, total, noun, nouns) => ({ kind: "listing", rows, total, noun, ...(nouns === undefined ? {} : { nouns }) }),
            document: (plain, pretty) => ({ kind: "document", plain, ...(pretty === undefined ? {} : { pretty }) })
        },
        errors: { fail, refuse, pending },
        rail: { request: (spec) => railRequest({ session, spec, commandPath: commandPath() }) },
        file: { read: hostFile },
        consoleBase: () => profileConsoleBase(session.profile),
        now,
        log: {
            debug: (message) =>
            {
                if (process.env.SUPERSELF_DEBUG === "1")
                {
                    process.stderr.write(`${sanitizeText(message)}\n`);
                }
            }
        }
    };
}

/* ── the verb index ────────────────────────────────────────────────── */

export interface InstalledPlugin
{
    key: string;
    version: string;
    dir: string;
    manifest: PluginManifest;
}

function readJson<T>(path: string, code: string, message: string): T
{
    try
    {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    }
    catch
    {
        throw fail(code, message, { hint: "self app install <key> --force" });
    }
}

function selectedVersion(key: string): string | null
{
    const current = join(pluginsDir(), key, "current");
    if (!existsSync(current))
    {
        return null;
    }
    return pluginVersion(readJson<{ version: string }>(current, "plugin_not_installed", `${current} is unreadable`).version);
}

// Metadata only: a `readdir` plus one manifest read per key. No signature
// check, no hash, no import — this is what `self --help` and `self alias add`
// consult, and what a first token that is not a built-in resolves against.
export function installedPlugins(): InstalledPlugin[]
{
    const root = pluginsDir();
    if (!existsSync(root))
    {
        return [];
    }
    return readdirSync(root).filter((key) => PLUGIN_KEY_PATTERN.test(key)).flatMap((key) => describe(key));
}

function describe(key: string): InstalledPlugin[]
{
    const version = selectedVersion(key);
    if (version === null)
    {
        return [];
    }
    const dir = join(pluginsDir(), key, version);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath))
    {
        return [];
    }
    return [{ key, version, dir, manifest: readJson<PluginManifest>(manifestPath, "plugin_not_installed", `${manifestPath} is unreadable`) }];
}

export function pluginVerbs(): Map<string, InstalledPlugin>
{
    const index = new Map<string, InstalledPlugin>();
    for (const plugin of installedPlugins())
    {
        for (const verb of plugin.manifest.verbs)
        {
            index.set(verb, plugin);
        }
    }
    return index;
}

/* ── the load sequence (design §1.3) ───────────────────────────────── */

// Steps 1 and 5: what the plugin tree claims, checked against the state file
// that lives outside it and against the directory names themselves.
function checkSelection(key: string, version: string, manifest: PluginManifest): void
{
    const entry = readPluginState().plugins[key];
    if (entry === undefined)
    {
        throw fail("plugin_state_missing", `"${key}" has no install record`, { hint: `self app install ${key} --force` });
    }
    if (compareVersions(version, entry.highest) < 0)
    {
        throw fail("plugin_rollback_blocked",
            `"${key}" ${version} is below the highest version ever installed (${entry.highest})`,
            { hint: `self app install ${key}@${version} --allow-downgrade` });
    }
    if (manifest.key !== key || manifest.version !== version)
    {
        throw fail("plugin_identity_mismatch",
            `the manifest names ${manifest.key}@${manifest.version}, installed as ${key}@${version}`);
    }
}

// Steps 6, 7 and 8: three independent compatibility questions, each with its
// own named failure, all of them before the import.
function checkCompatibility(manifest: PluginManifest, cliVersion: string, railApi: string | undefined): void
{
    if (!satisfies(cliVersion, manifest.cli))
    {
        throw fail("plugin_requires_newer_cli", `"${manifest.key}" needs a CLI matching ${manifest.cli}, and this is ${cliVersion}`);
    }
    if (!SUPPORTED_CONTRACTS.includes(manifest.contract))
    {
        throw fail("plugin_contract_unsupported", `"${manifest.key}" declares mini-app contract ${manifest.contract}`);
    }
    if (railApi === undefined)
    {
        throw fail("rail_api_unknown", "the rail's API major is unknown, so plugin compatibility cannot be judged",
            { hint: `self app update ${manifest.key}` });
    }
    if (!satisfies(`${railApi}.0.0`, manifest.rail_api))
    {
        throw fail("rail_api_incompatible", `"${manifest.key}" needs rail API ${manifest.rail_api}, and this rail is ${railApi}`);
    }
}

// Steps 9 and 10, and the only reason they are one function: the bytes hashed
// and the bytes imported must be the same bytes. `index.js` is read exactly
// once, the digest is computed over that buffer, and the buffer — not the path
// — is what gets imported, through a private copy. Re-opening the path after
// hashing it is the whole of the swap window, and there is no window here to
// close because the path is never opened again.
async function importVerified(dir: string, manifest: PluginManifest): Promise<PluginRegister>
{
    const bytes = readFileSync(join(dir, "index.js"));
    if (bytes.byteLength > PLUGIN_ENTRY_CAP_BYTES)
    {
        throw fail("plugin_too_large", `the entry of "${manifest.key}" is ${bytes.byteLength} bytes`);
    }
    // The digest is the statement, and the declared size is a cheaper form of
    // the same statement — so both answer with the same name. Reporting a size
    // mismatch as its own failure would give one tampering two vocabularies,
    // and a mutated byte usually changes both.
    if (bytes.byteLength !== manifest.entry_bytes
        || createHash("sha256").update(bytes).digest("hex") !== manifest.entry_sha256)
    {
        throw fail("plugin_integrity_failed", `the entry of "${manifest.key}" does not match its signed digest`,
            { hint: `self app install ${manifest.key} --force` });
    }
    return importPrivateCopy(bytes);
}

type PluginRegister = (host: PluginHost) => Command[];

async function importPrivateCopy(bytes: Buffer): Promise<PluginRegister>
{
    reapLoaded();
    const dir = join(stateDir(), "loaded", randomBytes(64).toString("hex"));
    const copy = stageVerifiedCopy(dir, bytes);
    try
    {
        const module = await import(pathToFileURL(copy).href) as { default?: PluginRegister };
        if (typeof module.default !== "function")
        {
            throw fail("plugin_contract_invalid", "the plugin entry does not default-export a register function");
        }
        return module.default;
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
}

// Housekeeping, and never a reason to fail a load: a leftover copy from a
// killed process costs disk, and refusing to run because one could not be
// removed would turn a full or read-only state directory into a CLI that
// cannot dispatch a plugin at all.
// The verified copy is load-bearing — the whole point of it is that the bytes
// imported are the bytes whose digest was checked — so a failure here cannot be
// skipped. It can at least say what went wrong by name instead of surfacing a
// filesystem stack trace.
function stageVerifiedCopy(dir: string, bytes: Buffer): string
{
    const copy = join(dir, "index.mjs");
    try
    {
        ensurePrivateDir(join(dir, ".."));
        // `recursive: false` is the O_EXCL of directories: a name that already
        // exists throws rather than being adopted.
        mkdirSync(dir, { recursive: false, mode: 0o700 });
        writeFileSync(copy, bytes, { mode: 0o600 });
    }
    catch
    {
        throw fail("plugin_load_failed", `could not stage the verified copy of a plugin under ${stateDir()}`,
            { hint: "check the permissions and free space on the state directory" });
    }
    return copy;
}

function reapLoaded(): void
{
    try
    {
        reapLoadedCopies();
    }
    catch
    {
        // Nothing here is load-bearing; the import below reports its own
        // failure by name if the directory is genuinely unusable.
    }
}

function reapLoadedCopies(): void
{
    const root = join(stateDir(), "loaded");
    ensurePrivateDir(root);
    for (const name of readdirSync(root))
    {
        const path = join(root, name);
        try
        {
            if (now().getTime() - statSync(path).mtimeMs > LOADED_REAP_MS)
            {
                rmSync(path, { recursive: true, force: true });
            }
        }
        catch
        {
            // A copy another process is reaping at the same moment. Its removal
            // is the outcome this wanted anyway.
        }
    }
}

// Steps 11 and 12: what came back has to be what the signed manifest promised,
// and it has to satisfy the same contract every built-in command satisfies —
// otherwise a malformed plugin surfaces as a confusing `parseArgs` failure
// instead of a named refusal.
function checkCommands(manifest: PluginManifest, commands: Command[]): Command[]
{
    const verbs = commands.map((command) => command.name);
    if (jcs([...verbs].sort() as unknown as JsonValue) !== jcs([...manifest.verbs].sort() as unknown as JsonValue))
    {
        throw fail("plugin_verb_mismatch",
            `"${manifest.key}" registered ${verbs.join(", ")}, and its manifest declares ${manifest.verbs.join(", ")}`);
    }
    const problems = checkContract(commands);
    if (problems.length > 0)
    {
        throw fail("plugin_contract_invalid", `"${manifest.key}" declares an invalid command contract: ${problems.join("; ")}`);
    }
    return commands;
}

export interface LoadContext
{
    cliVersion: string;
    session: RailSession;
    // Resolved before the import, never deferred to the plugin's own first
    // call: an incompatible plugin must not get to issue one live, chargeable
    // request before the check that exists to stop it has run.
    railApi: string | undefined;
    commandPath: () => string;
}

// `trust` is a separate parameter rather than a field of the context because
// the development path below has none and must not be given a shape that
// implies it could. Step 0 — obtaining the document — happened before this
// function was called; everything here reads it.
//
// The floor comes before the signature because §1.3 numbers it 1a and step 3
// after it. The order is visible in what a plugin that fails both is told: a
// withdrawn version signed by a revoked key is a version to update, and naming
// the revocation instead would send its operator after the wrong thing.
export async function loadPlugin(plugin: InstalledPlugin, context: LoadContext,
    trust: TrustDocument): Promise<Command[]>
{
    assertVersionFloor(trust, plugin.key, plugin.version);
    const signature = installedSignature(plugin);
    verifyManifest(plugin.manifest, signature, releaseKeyOf(trust, signature));
    checkSelection(plugin.key, plugin.version, plugin.manifest);
    checkCompatibility(plugin.manifest, context.cliVersion, context.railApi);
    const register = await importVerified(plugin.dir, plugin.manifest);
    return checkCommands(plugin.manifest, register(pluginHost(context.session, context.commandPath)));
}

/* ── the development path ──────────────────────────────────────────── */

// Unsigned, and guarded three ways: refused unless `SUPERSELF_DEV=1`, a loud
// stderr banner on every invocation, and `"plugin_source":"dev"` in every
// `--json` response from it. It announces itself in machine output, so it
// cannot be used quietly against a customer.
// Two halves, deliberately. The refusal is env-only, so it can run on **any**
// invocation without reading the plugin directory — which is what keeps the
// "a built-in verb touches nothing" property true. The banner belongs to the
// invocation that actually loads the unsigned plugin, so an unrelated command
// is not made noisy by a development setting.
export function assertDevPluginMode(): void
{
    const dir = process.env.SUPERSELF_PLUGIN_DEV;
    if (dir !== undefined && dir !== "" && process.env.SUPERSELF_DEV !== "1")
    {
        throw fail("dev_plugin_requires_dev_mode", "SUPERSELF_PLUGIN_DEV needs SUPERSELF_DEV=1",
            { hint: "unset SUPERSELF_PLUGIN_DEV, or set SUPERSELF_DEV=1 deliberately" });
    }
}

export function devPluginDir(): string | null
{
    const dir = process.env.SUPERSELF_PLUGIN_DEV;
    if (dir === undefined || dir === "" || process.env.SUPERSELF_DEV !== "1")
    {
        return null;
    }
    process.stderr.write(`warning: loading an UNSIGNED development plugin from ${dir}\n`);
    return dir;
}

export async function loadDevPlugin(dir: string, context: LoadContext): Promise<Command[]>
{
    const manifest = readJson<PluginManifest>(join(dir, "manifest.json"), "plugin_not_installed", `${dir}/manifest.json is unreadable`);
    checkCompatibility(manifest, context.cliVersion, context.railApi ?? "1");
    const module = await import(pathToFileURL(join(dir, "index.js")).href) as { default: PluginRegister };
    return checkCommands(manifest, module.default(pluginHost(context.session, context.commandPath, true)));
}

/* ── what an install writes ────────────────────────────────────────── */

export interface ReleaseDocument
{
    manifest: PluginManifest;
    signature: PluginSignature;
    entry: string;
}

// The ordering is stated per direction, and the two directions are genuinely
// different rules. On an upgrade `current` moves first and `highest` rises
// after, so a crash between them leaves `selected > highest`. On a downgrade
// the mark is lowered **first**: the upgrade order there would leave `current`
// at the older version while `highest` still named the newer one, which is
// `selected < highest` — a key bricked with no command that clears it.
// Everything the served answer has to satisfy before a byte of it is written.
//
// The key compared is the one the **operator** asked for, not the one the
// answer claims. Deriving it from the document instead would let a rail
// answering `GET /api/plugins/email/release` install something else entirely —
// under another key's directory, over another key's high-water mark — while the
// operator's command line said `email`. The signature proves we published the
// document; it says nothing about which request it was an answer to.
//
// The published floor comes last and before any state write. `--allow-downgrade`
// moves the *local* mark and does not reach it: a version the key list withdrew
// does not become installable because the operator asked twice.
function assertServedRelease(document: ReleaseDocument, key: string, version: string, trust: TrustDocument): void
{
    if (document.manifest.key !== key)
    {
        throw fail("plugin_identity_mismatch",
            `asked for "${key}" and the rail answered with a release for "${sanitizeText(String(document.manifest.key))}"`);
    }
    verifyManifest(document.manifest, document.signature, releaseKeyOf(trust, document.signature));
    assertVersionFloor(trust, key, version);
}

export function installRelease(document: ReleaseDocument, requested: string,
    allowDowngrade: boolean, trust: TrustDocument, railApi?: string): void
{
    const key = pluginKey(requested);
    const version = pluginVersion(document.manifest.version);
    assertServedRelease(document, key, version, trust);
    const entry = readPluginState().plugins[key];
    const lower = entry !== undefined && compareVersions(version, entry.highest) < 0;
    if (lower && !allowDowngrade)
    {
        throw fail("downgrade_blocked",
            `"${key}" ${version} is below ${entry.highest}, the highest version ever installed`,
            { hint: `self app install ${key}@${version} --allow-downgrade` });
    }
    writeVersionDir(key, version, document);
    commitSelection(key, version, entry, lower, railApi);
}

// The two orderings, and why they are two rules rather than one. Upgrade:
// `current` first, `highest` after — a crash between them leaves `selected >
// highest`, which loads. Downgrade: `highest` **first** — the upgrade order
// would leave `current` at the older version while `highest` still named the
// newer one, and every subsequent load would exit 1 `plugin_rollback_blocked`
// with no command able to clear it.
function commitSelection(key: string, version: string, entry: PluginStateEntry | undefined,
    lower: boolean, railApi: string | undefined): void
{
    const seen = railApi ?? entry?.rail_api_seen;
    const carried = seen === undefined ? {} : { rail_api_seen: seen };
    if (lower)
    {
        setPluginState(key, { highest: version, ...carried, installed_at: now().toISOString() });
        writeCurrent(key, version);
        return;
    }
    writeCurrent(key, version);
    const highest = entry === undefined || compareVersions(version, entry.highest) > 0 ? version : entry.highest;
    setPluginState(key, { highest, ...carried, installed_at: now().toISOString() });
}

function writeVersionDir(key: string, version: string, document: ReleaseDocument): void
{
    const bytes = Buffer.from(document.entry, "base64");
    if (bytes.byteLength > PLUGIN_ENTRY_CAP_BYTES)
    {
        throw fail("plugin_too_large", `the entry of "${key}" is ${bytes.byteLength} bytes`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== document.manifest.entry_sha256)
    {
        throw fail("plugin_integrity_failed", `the served entry of "${key}" does not match its signed digest`);
    }
    // The version directory is written complete before anything selects it, so
    // a partial directory from a killed install is never the one that loads.
    const dir = join(pluginsDir(), key, version);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(document.manifest));
    writeFileSync(join(dir, "signature.json"), JSON.stringify(document.signature));
    writeFileSync(join(dir, "index.js"), bytes);
}

function writeCurrent(key: string, version: string): void
{
    // A small JSON file, not a symlink: symlinks behave differently on Windows
    // and are a needless attack surface for a one-field selection.
    const dir = join(pluginsDir(), key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "current"), `${JSON.stringify({ version })}\n`);
}

// `remove` deletes the key's directory and leaves its state entry, including
// `highest`, intact. Rollback history is a property of the key, not of the
// current installation — clearing it here would make `remove` a one-command
// bypass of the guard.
export function removePlugin(key: string): void
{
    rmSync(join(pluginsDir(), pluginKey(key)), { recursive: true, force: true });
}


/* ── resolving the rail major before anything loads ────────────────── */

// The rail advertises its API major on every response. Until that header
// ships, `rail_api_seen` is absent on **every** install, so deferring the check
// "to the first response of this run" would defer it to the plugin's own first
// call — letting an incompatible plugin issue one live, chargeable request
// before the check that exists to stop it has run.
//
// So it is resolved here instead, by the host, with the one cheap unmetered
// request that already exists: `GET /api/agent/session`, which bills nothing.
// A probe that cannot answer leaves the major unknown and the loader refuses
// the load. No plugin rail call is ever issued while the major is unknown.
export async function resolveRailMajor(key: string, session: RailSession): Promise<string | undefined>
{
    const entry = readPluginState().plugins[key];
    if (entry?.rail_api_seen !== undefined)
    {
        return entry.rail_api_seen;
    }
    const major = await probeRailMajor(session);
    if (major !== undefined && entry !== undefined)
    {
        setPluginState(key, { ...entry, rail_api_seen: major });
    }
    return major;
}

async function probeRailMajor(session: RailSession): Promise<string | undefined>
{
    try
    {
        const answer = await railRequest({
            session,
            spec: { method: "GET", path: "/api/agent/session", scopes: ["wallet.read"] },
            commandPath: "app probe"
        });
        return railMajor(answer.headers);
    }
    catch
    {
        // A probe that fails answers nothing, and nothing is what the loader
        // refuses on. Turning a probe failure into a different error here would
        // hide which check actually stopped the load.
        return undefined;
    }
}
