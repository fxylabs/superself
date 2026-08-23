// Shared fixtures for the PR7 suites: a rail that answers on loopback, a
// signer that produces the release documents the loader accepts, a plugin tree
// writer, and a credential writer.
//
// Two deliberate choices. The rail is a real HTTP server rather than a stubbed
// `fetch`, so the spawned binary exercises the transport it actually ships —
// timeouts, headers, status codes and all. And both signing keys are DEV
// keypairs whose private halves are in this repository: the release key
// `dev-2026a`, which the trust document names, and the root `dev-root-2026a`,
// which signs that document. Both are public by construction, which is why
// neither is pinned in `src/rootkeys.ts` and why `npm run release-keys` refuses
// to publish a tree that pins one.
import { createServer } from "node:http";
import { createPrivateKey, createPublicKey, createHash, sign } from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs } from "../dist/rail.js";
import { TRUST_PATH } from "../dist/trust.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/* ── signing ───────────────────────────────────────────────────────── */

// ⚠ DEVELOPMENT KEYS. The release key's public half is what the fixture trust
// document names; the root's public half is the record the test build below
// pins in place of the ceremony's. Both private halves are in this repository,
// so anything they sign is signed by a key everyone has. They exist so the
// loader can be driven end to end.
export const DEV_KID = "dev-2026a";
export const DEV_ROOT_KID = "dev-root-2026a";
export const DEV_RELEASE_PUBLIC = "y/tV2B9W5IhPHM89i6r0aosTvc/fS5jaHy0xB3aikIo=";

function devKey()
{
    return createPrivateKey(readFileSync(new URL("./fixtures/dev-signing-key.pem", import.meta.url)));
}

function devRootKey()
{
    return createPrivateKey(readFileSync(new URL("./fixtures/dev-root-key.pem", import.meta.url)));
}

// The fixture root as `rootkeys.ts` spells a record: the raw 32 bytes of the
// public half, derived from the private one here rather than copied, so the key
// and the record it is pinned as cannot drift apart. The window is the three
// years §10 fixes.
const DEV_ROOT_RECORD = {
    kid: DEV_ROOT_KID,
    publicKey: createPublicKey(devRootKey()).export({ type: "spki", format: "der" }).subarray(12).toString("base64"),
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: "2029-01-01T00:00:00Z"
};

/* ── the binary these cells spawn: a test build ────────────────────── */

// The shipped build pins the production roots, and refusing a document the
// fixture root signed is exactly what that pin is for. So the cells that drive
// a real process drive a **test build**: `dist/`, `bin/` and `package.json`
// copied once per test process into a scratch directory whose
// `dist/rootkeys.js` carries `dev-root-2026a` in place of the ceremony's
// records. One data module differs; every other byte is the product's own build
// output, and neither `dist/` nor the package is written to.
//
// Nothing selects this. The path is computed here, the product is never told it
// moved, and no environment variable, flag or file reaches the root list — cell
// 171 scans the sources for every variable the CLI reads and this adds none. A
// shipped CLI has no such build and no way to ask for one.
function testBuild()
{
    const root = mkdtempSync(join(tmpdir(), "self-test-build-"));
    for (const entry of ["dist", "bin", "package.json"])
    {
        cpSync(join(packageRoot, entry), join(root, entry), { recursive: true });
    }
    writeFileSync(join(root, "dist", "rootkeys.js"), fixtureRootModule());
    process.on("exit", () => rmSync(root, { recursive: true, force: true }));
    return join(root, "bin", "self.mjs");
}

// The built root module with its record list swapped for the fixture's. A
// substitution rather than a module written from scratch, so an export added to
// `rootkeys.ts` tomorrow reaches the test build too — and a shape this cannot
// find is an error here rather than a build that silently pins nothing.
function fixtureRootModule()
{
    const source = readFileSync(join(packageRoot, "dist", "rootkeys.js"), "utf8");
    const opens = source.indexOf("export const ROOT_KEYS = [");
    const closes = source.indexOf("];", opens);
    if (opens < 0 || closes < 0)
    {
        throw new Error("dist/rootkeys.js no longer declares ROOT_KEYS as an array literal");
    }
    return source.slice(0, opens)
        + `export const ROOT_KEYS = ${JSON.stringify([DEV_ROOT_RECORD], null, 4)}`
        + source.slice(closes + 1);
}

// Exported for the one cell that spawns its own child: a SIGINT has to reach a
// live process, which neither runner below can arrange.
export const SELF_BIN = testBuild();

export function signManifest(manifest, kid = DEV_KID)
{
    return { kid, alg: "ed25519", sig: sign(null, Buffer.from(jcs(manifest)), devKey()).toString("base64") };
}

/* ── the trust document (design §1.4a) ─────────────────────────────── */

// One active release key, no floors, issued an hour ago and good for 30 days —
// the state every cell that is not *about* the document wants.
export function trustBody(options = {})
{
    const at = options.at ?? Date.now();
    return {
        trust_version: 1,
        issued_at: options.issuedAt ?? new Date(at - 3600_000).toISOString(),
        expires_at: options.expiresAt ?? new Date(at + 30 * 86_400_000).toISOString(),
        keys: options.keys ?? [trustKey()],
        min_plugin_versions: options.floors ?? {},
        ...(options.minCli === undefined ? {} : { min_cli_version: options.minCli })
    };
}

export function trustKey(options = {})
{
    return {
        kid: options.kid ?? DEV_KID,
        alg: options.alg ?? "ed25519",
        public_key: options.publicKey ?? DEV_RELEASE_PUBLIC,
        not_before: options.notBefore ?? "2026-01-01T00:00:00Z",
        not_after: options.notAfter ?? "2027-01-01T00:00:00Z",
        status: options.status ?? "active",
        ...(options.revokedAt === undefined ? {} : { revoked_at: options.revokedAt })
    };
}

// `key` lets a cell sign with something that is not the pinned root; `sig`
// lets it keep a genuinely valid signature while corrupting the block around
// it, which is how "the verifier was never consulted" is proved.
export function signTrust(document, options = {})
{
    const key = options.key ?? devRootKey();
    return {
        kid: options.kid ?? DEV_ROOT_KID,
        alg: options.alg ?? "ed25519",
        sig: options.sig ?? sign(null, Buffer.from(jcs(document)), key).toString("base64")
    };
}

export function signedTrust(options = {})
{
    const document = options.document ?? trustBody(options);
    return { document, signature: signTrust(document, options.signature ?? {}) };
}

export function trustCacheFile(box)
{
    return join(configRoot(box), "trust.json");
}

// What a completed step 0 leaves behind: the signed document plus when this
// machine last heard about it, at 0600 beside the credential file.
export function writeTrustCache(box, options = {})
{
    mkdirSync(configRoot(box), { recursive: true, mode: 0o700 });
    const path = trustCacheFile(box);
    const record = {
        version: 1,
        fetched_at: options.fetchedAt ?? new Date().toISOString(),
        ...(options.etag === undefined ? {} : { etag: options.etag }),
        trust: options.trust ?? signedTrust(options)
    };
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return record;
}

// The minimal plugin that satisfies the contract: one root verb with one
// unnamed leaf that answers with a payload block.
export function pluginSource(verb, extra = "")
{
    return `export default function register(host)
{
    ${extra}
    return [{
        name: ${JSON.stringify(verb)},
        usage: [{ syntax: ${JSON.stringify(verb)} + " [--json]", description: ["fixture"], verbs: [""] }],
        detail: ["fixture plugin", "", "  --json                machine-readable output"],
        node: host.contract.leaf("", { json: { type: "boolean" } }, 0, () =>
            [host.output.payload({ ok: true, verb: ${JSON.stringify(verb)} }, () => ["ok"])])
    }];
}
`;
}

export function manifestFor(options)
{
    const entry = options.entry ?? pluginSource(options.verbs?.[0] ?? options.key);
    const bytes = Buffer.from(entry, "utf8");
    return {
        manifest: {
            manifest_version: 1,
            key: options.key,
            name: `Fixture ${options.key}`,
            version: options.version ?? "0.1.0",
            verbs: options.verbs ?? [options.key],
            ...(options.requires === undefined ? {} : { requires: options.requires }),
            contract: options.contract ?? 0,
            rail_api: options.railApi ?? "^1",
            cli: options.cli ?? ">=0.6.0 <2.0.0",
            scopes: options.scopes ?? [],
            entry_sha256: createHash("sha256").update(bytes).digest("hex"),
            entry_bytes: bytes.byteLength,
            released_at: options.releasedAt ?? "2026-08-01T00:00:00Z"
        },
        bytes
    };
}

// The signed JSON document of design §1.1, exactly as the rail serves it.
export function releaseDocument(options)
{
    const { manifest, bytes } = manifestFor(options);
    const signature = options.signature ?? signManifest(manifest, options.kid);
    return { manifest, signature, entry: bytes.toString("base64") };
}

/* ── the plugin tree on disk ───────────────────────────────────────── */

export function pluginsRoot(box)
{
    return join(box.root, "home", ".local", "share", "superself", "plugins");
}

export function configRoot(box)
{
    return join(box.root, "config", "superself");
}

export function statePath(box)
{
    return join(configRoot(box), "plugin-state.json");
}

// Writes what a completed install leaves: the version directory, `current`,
// the state entry that lives outside the tree, and the trust document cache
// step 0 consults. `overrides` lets a test produce the states an attacker
// produces — a manifest under the wrong directory name, a `current` pointing
// below the high-water mark.
//
// The cache is written unless a cell says `trustCache: null`, because a cell
// whose subject is the loader wants step 0 already satisfied, and a cell whose
// subject is step 0 says so.
export function installFixture(box, options)
{
    if (options.trustCache !== null)
    {
        writeTrustCache(box, options.trustCache ?? {});
    }
    const document = releaseDocument(options);
    const key = options.dirKey ?? options.key;
    const version = options.dirVersion ?? document.manifest.version;
    const dir = join(pluginsRoot(box), key, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(document.manifest));
    writeFileSync(join(dir, "signature.json"), JSON.stringify(document.signature));
    writeFileSync(join(dir, "index.js"), Buffer.from(document.entry, "base64"));
    writeFileSync(join(pluginsRoot(box), key, "current"), JSON.stringify({ version: options.current ?? version }));
    if (options.state !== null)
    {
        writeState(box, key, { highest: options.highest ?? version, rail_api_seen: options.railApiSeen ?? "1", installed_at: "2026-08-01T00:00:00Z" });
    }
    return { document, dir };
}

export function writeState(box, key, entry)
{
    mkdirSync(configRoot(box), { recursive: true, mode: 0o700 });
    const path = statePath(box);
    const state = existsJson(path) ?? { version: 1, plugins: {} };
    state.plugins[key] = entry;
    writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
}

export function readState(box)
{
    return existsJson(statePath(box)) ?? { version: 1, plugins: {} };
}

function existsJson(path)
{
    try
    {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch
    {
        return null;
    }
}

/* ── the credential on disk ────────────────────────────────────────── */

export function credentialsFile(box)
{
    return join(configRoot(box), "credentials.json");
}

export function writeCredential(box, options = {})
{
    const name = options.profile ?? "default";
    mkdirSync(configRoot(box), { recursive: true, mode: 0o700 });
    const path = credentialsFile(box);
    const file = existsJson(path) ?? { version: 1, default: name, profiles: {} };
    file.profiles[name] = {
        api_base: options.apiBase ?? "https://app.superselfs.com",
        account_id: options.account ?? "acct_01J8TEST",
        grant_id: options.grant ?? "grant_01J8TEST",
        scopes: options.scopes ?? ["email.send", "email.read", "email.domain.manage", "landing.deploy", "landing.read", "wallet.read"],
        console_base: options.consoleBase ?? "https://app.superselfs.com",
        access_token: options.access ?? "sa_access_fixture",
        access_expires_at: options.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
        refresh_token: options.refresh ?? "sr_refresh_fixture",
        grant_started_at: "2026-08-01T00:00:00Z",
        device_label: "fixture@test",
        obtained_at: "2026-08-01T00:00:00Z"
    };
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
}

export function markerPath(box, profile = "default")
{
    return join(configRoot(box), `credentials.${profile}.pending`);
}

export function lockFile(box, profile = "default")
{
    return join(configRoot(box), `credentials.${profile}.lock`);
}

export function writeMarkerFixture(box, options = {})
{
    const profile = options.profile ?? "default";
    const marker = {
        version: 1,
        profile,
        grant_id: options.grant ?? "grant_01J8TEST",
        prior_refresh_sha256: createHash("sha256").update(options.priorRefresh ?? "sr_refresh_fixture").digest("hex"),
        prior_access_sha256: createHash("sha256").update(options.priorAccess ?? "sa_access_fixture").digest("hex"),
        at: options.at ?? new Date().toISOString()
    };
    mkdirSync(configRoot(box), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath(box, profile), JSON.stringify(marker), { mode: 0o600 });
    chmodSync(markerPath(box, profile), 0o600);
    return marker;
}

/* ── a rail that answers on loopback ───────────────────────────────── */

// `handler(request)` returns `{status, body, headers}`. Every request is
// recorded, because most of these cells assert on what was *not* sent — a
// refresh that must not have happened, a plugin call that must not have been
// issued while the rail major was unknown.
//
// `GET /api/plugins/trust` is answered by this fixture rather than by the
// handler, and recorded in `trustCalls` rather than in `calls`. Step 0 now
// stands in front of every install, and a cell about the release route should
// not have to describe the key list to get there — nor should its "no other
// request was made" assertion have to know that step 0 exists. A cell whose
// subject *is* the document passes `trust: null` and answers it itself.
export async function railServer(handler, options = {})
{
    const calls = [];
    const trustCalls = [];
    const served = options.trust === undefined ? signedTrust() : options.trust;
    const server = createServer((request, response) =>
    {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () =>
        {
            const url = new URL(request.url, "http://127.0.0.1");
            const raw = Buffer.concat(chunks).toString("utf8");
            const call = {
                method: request.method,
                path: url.pathname,
                query: Object.fromEntries(url.searchParams),
                headers: request.headers,
                body: parse(raw),
                raw
            };
            if (url.pathname === TRUST_PATH && served !== null)
            {
                trustCalls.push(call);
                reply(response, { status: 200, body: served });
                return;
            }
            calls.push(call);
            Promise.resolve(handler(call, calls.length)).then((given) => reply(response, given));
        });
    });
    // A handler may answer asynchronously — a refresh held open while the test
    // does something else is how the login-versus-refresh race is staged.
    function reply(response, given)
    {
        {
            const answer = given ?? { status: 404, body: { message: "no fixture" } };
            if (answer.destroy === true)
            {
                // A real transport failure: the connection dies with no
                // response at all, which is what the client must treat as
                // "completion unknown" rather than as an answer.
                response.socket.destroy();
                return;
            }
            const headers = { "content-type": "application/json", "x-superself-api": "1", ...(answer.headers ?? {}) };
            response.writeHead(answer.status, headers);
            response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? null));
        }
    }
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    // `closeAllConnections` first: a cell that deliberately leaves a request
    // unanswered holds a socket open, and `close` alone waits for it forever.
    return {
        url,
        calls,
        trustCalls,
        close: () => new Promise((resolve) =>
        {
            server.closeAllConnections();
            server.close(resolve);
        })
    };
}

function parse(raw)
{
    try
    {
        return raw === "" ? null : JSON.parse(raw);
    }
    catch
    {
        return raw;
    }
}

/* ── running the binary ────────────────────────────────────────────── */

// The shipped harness merges stdout and stderr, which most assertions want.
// These cells need them apart: "the error object is on **stdout**, not stderr"
// is the single most easily-missed contract point in the PR, and a merged
// stream cannot tell it from the opposite.
export function selfSplit(box, cwd, args, extra = {})
{
    // `spawnSync` rather than `execFileSync`: the latter throws away stderr on
    // a successful exit, and several of these cells are about what a *successful*
    // run said on stderr — a development banner, a low-balance notice.
    const result = spawnSync(process.execPath, [SELF_BIN, ...args],
        { cwd, env: { ...box.env, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: result.status ?? 1, out: result.stdout ?? "", err: result.stderr ?? "", all: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// A box wired to a fixture rail: dev mode on (so an http base is allowed at
// all), the journal off unless a cell is about the journal, and the rail's own
// address as the base.
export function railEnv(rail, extra = {})
{
    return { SUPERSELF_DEV: "1", SUPERSELF_API_BASE: rail.url, SUPERSELF_NO_JOURNAL: "1", ...extra };
}

// The fixture rail lives in this process, so a **blocking** spawn would stop
// the event loop that has to answer it: `execFileSync` and a loopback server
// cannot both run here. Every cell that drives the rail uses this instead.
export function selfAsync(box, cwd, args, extra = {})
{
    const env = { ...box.env, ...extra };
    return new Promise((resolve) =>
    {
        execFile(process.execPath, [SELF_BIN, ...args], { cwd, env, encoding: "utf8" }, (error, out, err) =>
            // `all` is the merged stream the shipped harness reports, for the
            // assertions that only care what was said; `out` and `err` stay
            // apart for the cells whose subject is *which* stream said it.
            resolve({ code: error?.code ?? 0, out: out ?? "", err: err ?? "", all: `${out ?? ""}${err ?? ""}` }));
    });
}

export function jsonOf(text)
{
    return JSON.parse(text.trim().split("\n").filter((line) => line !== "").pop());
}

export function jsonLines(text)
{
    return text.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}
