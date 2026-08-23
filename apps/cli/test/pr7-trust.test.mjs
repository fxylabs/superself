// Design v0.4 §7.1a — the trust cells, 158 to 172. One test per cell, with the
// cell's own stated outcome as the assertion.
//
// Two ways of driving them, and the split is the design's own. Most cells run
// the shipped binary against a loopback rail, because their subject is an
// ordering — the document is fetched before the release, the module is never
// imported, exactly one note reaches stderr — and only a real process can be
// asked what it did not do. The cells whose subject is the **root pin** (167,
// 168, 169) run in this process against `loadTrustDocument`, because a fixture
// root must never be pinned in a shipped build and the only way it reaches the
// code is the `roots` parameter, which no CLI path passes. Cell 171 is the
// statement of that: every environment variable the CLI reads, set to a fixture
// root, changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { machine } from "./harness.mjs";
import {
    DEV_KID, configRoot, installFixture, jsonOf, pluginSource, pluginsRoot, railEnv, railServer,
    releaseDocument, selfAsync, signedTrust, trustBody, trustCacheFile, trustKey,
    writeCredential, writeTrustCache
} from "./pr7-lib.mjs";
import { jcs } from "../dist/rail.js";
import { compareVersions } from "../dist/plugins.js";
import { TRUST_PATH, loadTrustDocument, trustVerifierCalls } from "../dist/trust.js";

function box()
{
    const created = machine();
    return { ...created, demo: created.root };
}

const HOUR_MS = 3600_000;

/* ── fixture roots, generated here and pinned nowhere ──────────────── */

// A root that exists for the length of one test. It reaches the code only
// through `loadTrustDocument({ roots })`, so nothing about it can be true of a
// shipped build.
function fixtureRoot(kid, window = {})
{
    const pair = generateKeyPairSync("ed25519");
    return {
        kid,
        privateKey: pair.privateKey,
        record: {
            kid,
            publicKey: pair.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64"),
            notBefore: window.notBefore ?? "2026-01-01T00:00:00Z",
            notAfter: window.notAfter ?? "2029-01-01T00:00:00Z"
        }
    };
}

// A document signed by a fixture root, with the signature block optionally
// corrupted *after* signing — which is how "the verifier was never consulted"
// is proved: the signature is genuinely valid, so an implementation that ran
// the verifier and honoured its answer would have accepted.
// `document` hands a cell the whole body, for the ones whose subject is a field
// `trustBody` has no opinion about — a format version, a repeated key.
function fixtureDocument(root, options = {})
{
    const document = options.document ?? trustBody(options);
    const sig = sign(null, Buffer.from(jcs(document)), root.privateKey).toString("base64");
    return { document, signature: { kid: root.kid, alg: "ed25519", sig, ...(options.block ?? {}) } };
}

// An injected fetch: no socket, no rail, one answer. The parameter exists so a
// cell about verification does not have to stand up a server to reach it.
function servesDocument(signed)
{
    return async () => ({ status: 200, text: JSON.stringify(signed) });
}

const SESSION = { profile: "default", client: "self/test", notice: () => undefined };

// Human mode prints the message and the hint; the **code** an agent branches on
// lives in the `--json` envelope. Every cell that names a code therefore asks
// for one, which is also the shape the design's own table is written in.
function errorOf(result)
{
    return jsonOf(result.out).error;
}

// A plugin entry that leaves a trace the moment it is imported. The side effect
// is at module top level, before the default export runs, so "never imported"
// and "imported but not dispatched" cannot be confused.
function witnessed(path, verb)
{
    return `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(path)}, "x");\n${pluginSource(verb)}`;
}

// Every file under `dir`, by package-relative name, with its content hashed. A
// refusal that "writes nothing" is a statement about the whole directory — a
// half-written temp file and a bumped `fetched_at` are both writes — so the
// assertion compares trees rather than checking a handful of paths.
function fileTree(dir, prefix = "")
{
    const found = {};
    if (!existsSync(dir))
    {
        return found;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true }))
    {
        const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory())
        {
            Object.assign(found, fileTree(join(dir, entry.name), name));
            continue;
        }
        found[name] = createHash("sha256").update(readFileSync(join(dir, entry.name))).digest("hex");
    }
    return found;
}

// The two trees an install can touch: the config directory that holds the
// document cache and the plugin state, and the plugin tree itself.
function machineFiles(it)
{
    return { config: fileTree(configRoot(it)), plugins: fileTree(pluginsRoot(it)) };
}

// The lock another process would be holding: a live pid and an mtime from a
// moment ago, so the 30 s staleness rule does not fire and the CLI genuinely
// waits its bounded wait out and gives up.
function holdTrustLock(it)
{
    mkdirSync(configRoot(it), { recursive: true, mode: 0o700 });
    const path = join(configRoot(it), "trust.lock");
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    return path;
}

/* ── in-process cells run against a scratch machine ────────────────── */

const SCOPED = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"];

async function inScratch(work)
{
    const it = box();
    const had = Object.fromEntries(SCOPED.map((name) => [name, process.env[name]]));
    SCOPED.forEach((name) => { process.env[name] = it.env[name] ?? join(it.root, name); });
    try
    {
        return await work(it);
    }
    finally
    {
        SCOPED.forEach((name) =>
        {
            if (had[name] === undefined)
            {
                delete process.env[name];
                return;
            }
            process.env[name] = had[name];
        });
    }
}

async function refusal(work)
{
    try
    {
        await work();
    }
    catch (error)
    {
        return error;
    }
    return null;
}

// A refusal, and what it cost the ed25519 verifier. `trustVerifierCalls` counts
// every document signature this process put in front of the verifier, which is
// the only way to assert the negative cell 169 states: the verifier was never
// consulted about the bad document at all.
async function measured(work)
{
    const before = trustVerifierCalls();
    const error = await refusal(work);
    return { error, calls: trustVerifierCalls() - before };
}

/* ── 158–159: nothing to fall back on ──────────────────────────────── */

test("cell 158: no cached document and an unreachable rail refuses the install before any release request", async () =>
{
    const it = box();
    // Every request is recorded and the trust request dies with no answer at
    // all — a transport failure, not a refusal the client could read.
    const rail = await railServer((call) => (call.path === TRUST_PATH ? { destroy: true } : { status: 500, body: {} }),
        { trust: null });
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(result.code, 3, result.all);
        assert.equal(errorOf(result).code, "trust_unavailable");
        assert.equal(errorOf(result).retry_after_s, 5);
        assert.deepEqual(rail.calls.map((call) => call.path), [TRUST_PATH], "a release was requested anyway");
        assert.equal(existsSync(trustCacheFile(it)), false, "a cache was written");
        assert.equal(existsSync(pluginsRoot(it)), false, "a plugin tree was written");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 159: a document signed by a key that is not a pinned root is trust_document_invalid", async () =>
{
    const it = box();
    const stranger = fixtureRoot("dev-root-2026a");
    // The kid names a root this CLI does pin; the key that signed it is not
    // that root's. Neither half of the signature block can introduce a key.
    const rail = await railServer((call) => (call.path === TRUST_PATH
        ? { status: 200, body: fixtureDocument(stranger) }
        : { status: 500, body: {} }), { trust: null });
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(result.code, 1, result.all);
        assert.equal(errorOf(result).code, "trust_document_invalid");
        assert.deepEqual(rail.calls.map((call) => call.path), [TRUST_PATH], "the release route was called");
        assert.equal(existsSync(trustCacheFile(it)), false, "an unverified document was cached");
    }
    finally
    {
        await rail.close();
    }
});

/* ── 160–161: expiry and monotonicity ──────────────────────────────── */

test("cell 160: an expired document refuses an install and still loads an installed plugin", async () =>
{
    const it = box();
    const expired = signedTrust({ at: Date.now() - 40 * 24 * HOUR_MS });
    const rail = await railServer(() => ({ status: 500, body: {} }), { trust: expired });
    try
    {
        installFixture(it, { key: "email", trustCache: { trust: expired } });
        writeCredential(it, { apiBase: rail.url });
        // Everything the install could have touched, hashed before it runs. A
        // refusal that is terminal leaves the machine byte-for-byte as it was.
        const before = machineFiles(it);
        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(install.code, 1, install.all);
        assert.equal(errorOf(install).code, "trust_document_expired");
        assert.equal(rail.calls.length, 0, "a release was fetched against an expired key list");
        assert.deepEqual(machineFiles(it), before, "the refused install wrote to the config directory or the plugin tree");

        const load = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(load.code, 0, load.all);
        assert.equal(load.err.match(/notice:/g)?.length, 1, load.err);
        assert.match(load.err, /expired/);
    }
    finally
    {
        await rail.close();
    }
});

test("cell 161: a document older than the cached one is trust_document_rollback and the cache stands", async () =>
{
    const it = box();
    // The older document revokes the key the installed release is signed by,
    // so a client that accepted it would refuse the load. The load succeeding
    // is what proves the newer cached document is still the one in force.
    const older = signedTrust({
        at: Date.now() - 10 * 24 * HOUR_MS,
        keys: [trustKey({ status: "revoked", revokedAt: "2026-08-10T00:00:00Z" })]
    });
    const rail = await railServer(() => ({ status: 500, body: {} }), { trust: older });
    try
    {
        installFixture(it, { key: "email", trustCache: { fetchedAt: new Date(Date.now() - 25 * HOUR_MS).toISOString() } });
        writeCredential(it, { apiBase: rail.url });
        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(install.code, 1, install.all);
        assert.equal(errorOf(install).code, "trust_document_rollback");

        const load = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(load.code, 0, load.all);
        assert.match(load.err, /trust_document_rollback/);
        const cached = JSON.parse(readFileSync(trustCacheFile(it), "utf8"));
        assert.equal(cached.trust.document.keys[0].status, "active", "the older document replaced the cache");
    }
    finally
    {
        await rail.close();
    }
});

// The same statement one layer down, where the comparison actually happens. A
// second process caches T2 while this run is fetching, and the rail's answer is
// T1 — newer than the T0 this run started from, so nothing is a rollback, and
// older than T2, so the cache write is skipped. What the run is judged under
// must be T2 all the same: a revocation this machine has already recorded is
// not undone by a slower fetch finishing after it.
function racingRail(box, older, newer)
{
    return (call) =>
    {
        if (call.path !== TRUST_PATH)
        {
            return { status: 200, body: releaseDocument({ key: "email" }) };
        }
        writeTrustCache(box, { trust: newer });
        return { status: 200, body: older };
    };
}

function seededCache(fetchedHoursAgo)
{
    return { at: Date.now() - 96 * HOUR_MS, fetchedAt: new Date(Date.now() - fetchedHoursAgo * HOUR_MS).toISOString() };
}

test("cell 161: a newer document cached mid-run governs the install, and the older answer never does", async () =>
{
    const it = box();
    const newer = signedTrust({ keys: [trustKey({ status: "revoked", revokedAt: "2026-08-22T00:00:00Z" })] });
    const older = signedTrust({ at: Date.now() - 48 * HOUR_MS });
    const rail = await railServer(racingRail(it, older, newer), { trust: null });
    try
    {
        installFixture(it, { key: "email", trustCache: seededCache(1) });
        writeCredential(it, { apiBase: rail.url });
        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(install.code, 1, install.all);
        assert.equal(errorOf(install).code, "plugin_key_revoked");
        const cached = JSON.parse(readFileSync(trustCacheFile(it), "utf8"));
        assert.equal(cached.trust.document.issued_at, newer.document.issued_at, "the older answer replaced the newer cache");
        assert.equal(cached.trust.document.keys[0].status, "revoked");
        assert.deepEqual(rail.calls.map((call) => call.path), [TRUST_PATH], "a release was fetched for a revoked key");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 161: a newer document cached mid-run governs the load that follows it", async () =>
{
    const it = box();
    const witness = join(it.root, "imported");
    const newer = signedTrust({ keys: [trustKey({ status: "revoked", revokedAt: "2026-08-22T00:00:00Z" })] });
    const older = signedTrust({ at: Date.now() - 48 * HOUR_MS });
    const rail = await railServer(racingRail(it, older, newer), { trust: null });
    try
    {
        // 25 h old, so the load refreshes — which is the moment the race is run.
        installFixture(it, { key: "email", entry: witnessed(witness, "email"), trustCache: seededCache(25) });
        writeCredential(it, { apiBase: rail.url });
        const load = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(load.code, 1, load.all);
        assert.match(load.all, /release key "dev-2026a" has been revoked/);
        assert.equal(existsSync(witness), false, "the revoked plugin's module was imported");
        const cached = JSON.parse(readFileSync(trustCacheFile(it), "utf8"));
        assert.equal(cached.trust.document.issued_at, newer.document.issued_at, "the older answer replaced the newer cache");
    }
    finally
    {
        await rail.close();
    }
});

// The same race with the lock **held**, which is the case the comparison above
// never runs in: the write times out, so nothing inside the lock decides
// anything. What must not follow is this run proceeding under T1 while T2 — the
// document that revokes the key — sits on disk. Re-reading the cache after the
// timeout is the whole of the fix, and the revocation is how it is visible.
test("cell 161: a write that cannot take the lock still answers with the newer document on disk (install)", async () =>
{
    const it = box();
    const newer = signedTrust({ keys: [trustKey({ status: "revoked", revokedAt: "2026-08-22T00:00:00Z" })] });
    const older = signedTrust({ at: Date.now() - 48 * HOUR_MS });
    const rail = await railServer(racingRail(it, older, newer), { trust: null });
    try
    {
        installFixture(it, { key: "email", trustCache: seededCache(1) });
        writeCredential(it, { apiBase: rail.url });
        holdTrustLock(it);
        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(install.code, 1, install.all);
        assert.equal(errorOf(install).code, "plugin_key_revoked", "T1 governed an install the lock stopped serializing");
        const cached = JSON.parse(readFileSync(trustCacheFile(it), "utf8"));
        assert.equal(cached.trust.document.issued_at, newer.document.issued_at, "the write went ahead without the lock");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 161: a write that cannot take the lock still answers with the newer document on disk (load)", async () =>
{
    const it = box();
    const witness = join(it.root, "imported");
    const newer = signedTrust({ keys: [trustKey({ status: "revoked", revokedAt: "2026-08-22T00:00:00Z" })] });
    const older = signedTrust({ at: Date.now() - 48 * HOUR_MS });
    const rail = await railServer(racingRail(it, older, newer), { trust: null });
    try
    {
        installFixture(it, { key: "email", entry: witnessed(witness, "email"), trustCache: seededCache(25) });
        writeCredential(it, { apiBase: rail.url });
        holdTrustLock(it);
        const load = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(load.code, 1, load.all);
        assert.match(load.all, /release key "dev-2026a" has been revoked/);
        assert.equal(existsSync(witness), false, "the revoked plugin's module was imported");
    }
    finally
    {
        await rail.close();
    }
});

// Neither half of the guarantee is available: the lock is held, so the
// comparison cannot happen, and there is no cache to fall back on, so it cannot
// be re-established from disk either. Install is fail-closed, so it says so —
// exit 3, retryable — rather than judging new code under a document it cannot
// place in order against what another process is writing right now.
test("cell 161: an install that can neither serialize nor read a document is trust_unavailable", async () =>
{
    const it = box();
    const rail = await railServer(() => ({ status: 500, body: {} }), { trust: signedTrust() });
    try
    {
        writeCredential(it, { apiBase: rail.url });
        holdTrustLock(it);
        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(install.code, 3, install.all);
        assert.equal(errorOf(install).code, "trust_unavailable");
        assert.equal(errorOf(install).retry_after_s, 5);
        assert.equal(existsSync(trustCacheFile(it)), false, "a document was cached outside the lock");
        assert.equal(rail.calls.length, 0, "a release was requested anyway");
        assert.equal(existsSync(pluginsRoot(it)), false, "a plugin tree was written");
    }
    finally
    {
        await rail.close();
    }
});

// T1 and T2 name the **same kid** and carry different key material, so which
// document governed is not readable from a policy field at all — only from
// whether the release verifies. T1 keeps the dev release key; T2 replaces it.
function rekeyed(publicKey)
{
    return {
        older: signedTrust({ at: Date.now() - 48 * HOUR_MS }),
        newer: signedTrust({ keys: [trustKey({ publicKey })] })
    };
}

// One load under the race: T2 is cached while the run is fetching, and the rail
// answers T1.
async function racedLoad(it, documents, options)
{
    const rail = await railServer(racingRail(it, documents.older, documents.newer), { trust: null });
    try
    {
        installFixture(it, { ...options, trustCache: seededCache(25) });
        writeCredential(it, { apiBase: rail.url });
        return await selfAsync(it, it.demo, ["email"], railEnv(rail));
    }
    finally
    {
        await rail.close();
    }
}

test("cell 161: the newer document's key material verifies the release, not only its policy", async () =>
{
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
    const documents = rekeyed(publicKey);

    // Signed by T2's key alone: under T1's record for the same kid it does not
    // verify, so a load that succeeds succeeded on T2's key bytes.
    const accepted = box();
    const witness = join(accepted.root, "imported");
    const entry = witnessed(witness, "email");
    const manifest = releaseDocument({ key: "email", entry }).manifest;
    const signature = {
        kid: DEV_KID,
        alg: "ed25519",
        sig: sign(null, Buffer.from(jcs(manifest)), pair.privateKey).toString("base64")
    };
    const load = await racedLoad(accepted, documents, { key: "email", entry, signature });
    assert.equal(load.code, 0, load.all);
    assert.equal(existsSync(witness), true, "the release only T2's key verifies was refused");

    // And the mirror: the same race over a release signed by T1's key, which T2
    // no longer names. Policy is identical in both runs — only the key differs.
    const refusedBox = box();
    const other = join(refusedBox.root, "imported");
    const refused = await racedLoad(refusedBox, documents, { key: "email", entry: witnessed(other, "email") });
    assert.equal(refused.code, 1, refused.all);
    assert.match(refused.all, /is not signed by a pinned key/);
    assert.equal(existsSync(other), false, "a release only T1's key verifies was loaded under T2");
});

/* ── 162: revocation reaches an installed plugin ───────────────────── */

test("cell 162: a refreshed document that revokes the signing key refuses the load and the install", async () =>
{
    const it = box();
    const revoked = signedTrust({ keys: [trustKey({ status: "revoked", revokedAt: "2026-08-20T00:00:00Z" })] });
    const witness = join(it.root, "imported");
    const rail = await railServer((call) => (call.path.endsWith("/release")
        ? { status: 200, body: releaseDocument({ key: "email" }) }
        : { status: 404, body: {} }), { trust: revoked });
    try
    {
        installFixture(it, {
            key: "email",
            entry: witnessed(witness, "email"),
            trustCache: { at: Date.now() - 6 * HOUR_MS, fetchedAt: new Date(Date.now() - 25 * HOUR_MS).toISOString() }
        });
        writeCredential(it, { apiBase: rail.url });
        // The refusal happens while the plugin is being loaded, before a leaf
        // is resolved and therefore before machine mode is selected — so this
        // half reads the human refusal and its hint rather than the envelope,
        // exactly as every other loader cell does.
        const load = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(load.code, 1, load.all);
        assert.match(load.all, /release key "dev-2026a" has been revoked/);
        assert.match(load.all, /self app install <key> --force/);
        assert.equal(existsSync(witness), false, "the revoked plugin's module was imported");

        // The bare command, with no `--force`: `email` is already installed at
        // the version being asked for, so this is the short-circuit that used
        // to answer "installed" without consulting the document at all.
        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(install.code, 1, install.all);
        assert.equal(errorOf(install).code, "plugin_key_revoked");
        assert.equal(readdirSync(join(pluginsRoot(it), "email")).sort().join(","), "0.1.0,current",
            "the refused install wrote into the plugin tree");
        assert.equal(rail.calls.length, 0, "a release was fetched for a revoked key");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 162: a fresh install of a release the served document revokes writes nothing", async () =>
{
    const it = box();
    // Nothing is installed, so the release route is genuinely reached and its
    // answer is genuinely verified — the half the already-installed cell above
    // short-circuits past.
    const revoked = signedTrust({ keys: [trustKey({ status: "revoked", revokedAt: "2026-08-20T00:00:00Z" })] });
    const rail = await railServer((call) => (call.path.endsWith("/release")
        ? { status: 200, body: releaseDocument({ key: "email" }) }
        : { status: 404, body: {} }), { trust: revoked });
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(install.code, 1, install.all);
        assert.equal(errorOf(install).code, "plugin_key_revoked");
        assert.deepEqual(rail.calls.map((call) => call.path), ["/api/plugins/email/release"],
            "the release route was not the path under test");
        assert.equal(existsSync(pluginsRoot(it)), false, "a refused install wrote into the plugin tree");
    }
    finally
    {
        await rail.close();
    }
});

/* ── 163: which key of the document the kid selects ────────────────── */

test("cell 163: a release signed by the document's second active key verifies against that record", async () =>
{
    const it = box();
    const second = generateKeyPairSync("ed25519");
    const publicKey = second.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64");
    const built = releaseDocument({ key: "email" });
    // The two records carry different public keys, so a signature that
    // verifies at all verifies only under the one the kid names.
    const signature = {
        kid: "dev-2026b",
        alg: "ed25519",
        sig: sign(null, Buffer.from(jcs(built.manifest)), second.privateKey).toString("base64")
    };
    installFixture(it, {
        key: "email",
        signature,
        trustCache: { keys: [trustKey(), trustKey({ kid: "dev-2026b", publicKey })] }
    });
    const result = await selfAsync(it, it.demo, ["email"], {});
    assert.equal(result.code, 0, result.all);
    assert.match(result.out, /^ok$/m);
});

// The second key, and a release signed with it. The two records carry
// different public halves, so a signature that verifies at all verifies only
// under the record the kid names.
function secondKeyRelease()
{
    const pair = generateKeyPairSync("ed25519");
    const built = releaseDocument({ key: "email" });
    return {
        publicKey: pair.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64"),
        document: {
            ...built,
            signature: {
                kid: "dev-2026b",
                alg: "ed25519",
                sig: sign(null, Buffer.from(jcs(built.manifest)), pair.privateKey).toString("base64")
            }
        }
    };
}

test("cell 163: a fresh install verifies the served release against the document's second active key", async () =>
{
    const it = box();
    const second = secondKeyRelease();
    const trust = signedTrust({ keys: [trustKey(), trustKey({ kid: "dev-2026b", publicKey: second.publicKey })] });
    const rail = await railServer((call) => (call.path.endsWith("/release")
        ? { status: 200, body: second.document }
        : { status: 404, body: {} }), { trust });
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(install.code, 0, install.all);
        const written = JSON.parse(readFileSync(join(pluginsRoot(it), "email", "0.1.0", "signature.json"), "utf8"));
        assert.equal(written.kid, "dev-2026b", "the installed release was verified against another record");

        // And the plugin loads on the document the install cached, which is the
        // same lookup a second time.
        const load = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(load.code, 0, load.all);
        assert.match(load.out, /^ok$/m);
    }
    finally
    {
        await rail.close();
    }
});

/* ── 164: the published floor ──────────────────────────────────────── */

test("cell 164: a version below min_plugin_versions refuses the load and every install of it", async () =>
{
    const it = box();
    const witness = join(it.root, "imported");
    const rail = await railServer((call) => (call.path.endsWith("/release")
        ? { status: 200, body: releaseDocument({ key: "email", version: "0.1.1" }) }
        : { status: 404, body: {} }), { trust: signedTrust({ floors: { email: "0.1.2" } }) });
    try
    {
        installFixture(it, {
            key: "email",
            version: "0.1.1",
            entry: witnessed(witness, "email"),
            trustCache: { at: Date.now() - 6 * HOUR_MS, floors: { email: "0.1.2" } }
        });
        writeCredential(it, { apiBase: rail.url });
        // Human shape for the same reason as cell 162: nothing has resolved a
        // leaf yet, so there is no machine mode to render into.
        const load = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(load.code, 1, load.all);
        assert.match(load.all, /"email" 0\.1\.1 is below 0\.1\.2/);
        assert.match(load.all, /self app update email/);
        assert.equal(existsSync(witness), false, "a plugin below the floor was imported");

        // Bare, so the already-installed short-circuit is what the floor is
        // being asked to gate — `0.1.1` is exactly what is on disk.
        for (const extra of [[], ["--allow-downgrade"]])
        {
            const install = await selfAsync(it, it.demo,
                ["app", "install", "email@0.1.1", "--json", ...extra], railEnv(rail));
            assert.equal(install.code, 1, install.all);
            assert.equal(errorOf(install).code, "plugin_version_below_minimum",
                "--allow-downgrade moved the published floor, not just the local mark");
        }
    }
    finally
    {
        await rail.close();
    }
});

test("cell 164: below the floor and signed by a revoked key is refused by the floor, which §1.3 numbers first", async () =>
{
    const it = box();
    // Both refusals are live at once, so which one is reported is the whole of
    // what this asserts: step 1a runs before step 3, and the operator is sent
    // to `self app update` rather than after a revocation they cannot act on.
    installFixture(it, {
        key: "email",
        version: "0.1.1",
        trustCache: {
            floors: { email: "0.1.2" },
            keys: [trustKey({ status: "revoked", revokedAt: "2026-08-20T00:00:00Z" })]
        }
    });
    const load = await selfAsync(it, it.demo, ["email"], {});
    assert.equal(load.code, 1, load.all);
    assert.match(load.all, /"email" 0\.1\.1 is below 0\.1\.2/);
    assert.doesNotMatch(load.all, /revoked/, "the revocation was reported ahead of the floor");
});

// A rail whose release route serves one version, under a document that floors
// the plugin at another.
async function floorRail(version, floor)
{
    return railServer((call) => (call.path.endsWith("/release")
        ? { status: 200, body: releaseDocument({ key: "email", version }) }
        : { status: 404, body: {} }), { trust: signedTrust({ floors: { email: floor } }) });
}

test("cell 164: a served release below the floor is refused before anything is written", async () =>
{
    const it = box();
    const rail = await floorRail("0.1.1", "0.1.2");
    try
    {
        writeCredential(it, { apiBase: rail.url });
        // Nothing is installed, so this is the fresh path: the release is
        // fetched, verified, and then refused by the floor with nothing on disk
        // to show for it. `--allow-downgrade` moves the local mark and has
        // nothing to say about a published floor.
        for (const extra of [[], ["--allow-downgrade"]])
        {
            const install = await selfAsync(it, it.demo,
                ["app", "install", "email@0.1.1", "--json", ...extra], railEnv(rail));
            assert.equal(install.code, 1, install.all);
            assert.equal(errorOf(install).code, "plugin_version_below_minimum",
                "--allow-downgrade moved the published floor, not just the local mark");
            assert.equal(existsSync(pluginsRoot(it)), false, "a release below the floor was written");
        }
    }
    finally
    {
        await rail.close();
    }
});

test("cell 164: a prerelease is below the release it precedes, so it cannot pass that floor", () =>
{
    // SemVer 2.0 §11. Without the prerelease half, `0.1.2-alpha` compares
    // **equal** to `0.1.2` and a withdrawn version walks back in under the
    // floor that withdrew it.
    assert.equal(compareVersions("0.1.2-alpha", "0.1.2"), -1);
    assert.equal(compareVersions("0.1.2", "0.1.2-alpha"), 1);
    assert.equal(compareVersions("0.1.2-alpha.1", "0.1.2-alpha.2"), -1);
    assert.equal(compareVersions("0.1.2-alpha", "0.1.2-beta"), -1);
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    // A prerelease that runs out of identifiers first is the lower one, a
    // numeric identifier ranks below an alphanumeric one, and build metadata
    // decides nothing.
    assert.equal(compareVersions("0.1.2-alpha", "0.1.2-alpha.1"), -1);
    assert.equal(compareVersions("0.1.2-1", "0.1.2-alpha"), -1);
    assert.equal(compareVersions("0.1.2-alpha", "0.1.2-alpha"), 0);
    assert.equal(compareVersions("0.1.2+build.9", "0.1.2"), 0);
});

// 2^53 + 1 and 2^53, which are the same IEEE double. A comparison that reads a
// numeric identifier as a JavaScript number calls them equal, and "equal to the
// floor" is "at the floor" — so the version the floor withdrew passes it.
const BIG = "9007199254740993";
const BIG_BELOW = "9007199254740992";

test("cell 164: numeric identifiers above 2^53 keep their order", () =>
{
    assert.equal(compareVersions(`1.0.0-${BIG}`, `1.0.0-${BIG_BELOW}`), 1);
    assert.equal(compareVersions(`1.0.0-${BIG_BELOW}`, `1.0.0-${BIG}`), -1);
    assert.equal(compareVersions(`1.0.0-alpha.${BIG}`, `1.0.0-alpha.${BIG_BELOW}`), 1);
    assert.equal(compareVersions(`1.0.0-alpha.${BIG_BELOW}`, `1.0.0-alpha.${BIG}`), -1);
    assert.equal(compareVersions(`1.0.0-${BIG}`, `1.0.0-${BIG}`), 0);
    // The core parts read the same way, and a longer decimal string is the
    // larger number whatever a double would have said about it.
    assert.equal(compareVersions(`${BIG}.0.0`, `${BIG_BELOW}.0.0`), 1);
    assert.equal(compareVersions(`1.${BIG}.0`, `1.${BIG_BELOW}.0`), 1);
    assert.equal(compareVersions(`1.0.${BIG}`, `1.0.${BIG_BELOW}`), 1);
    assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
    // SemVer §9 forbids a leading zero in a numeric identifier, so `01` is
    // alphanumeric and outranks any number; the looser core still orders.
    assert.equal(compareVersions("1.0.0-01", "1.0.0-2"), 1);
    assert.equal(compareVersions("01.0.0", "2.0.0"), -1);
});

test("cell 164: a floor with a numeric identifier above 2^53 is refused at load and at install", async () =>
{
    const it = box();
    const version = `1.0.0-${BIG_BELOW}`;
    const witness = join(it.root, "imported");
    const rail = await floorRail(version, `1.0.0-${BIG}`);
    try
    {
        installFixture(it, {
            key: "email",
            version,
            entry: witnessed(witness, "email"),
            trustCache: { at: Date.now() - 6 * HOUR_MS, floors: { email: `1.0.0-${BIG}` } }
        });
        writeCredential(it, { apiBase: rail.url });
        const load = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(load.code, 1, load.all);
        assert.match(load.all, new RegExp(`"email" 1\\.0\\.0-${BIG_BELOW} is below 1\\.0\\.0-${BIG}`));
        assert.equal(existsSync(witness), false, "a version below a floor a double cannot tell apart was imported");

        const install = await selfAsync(it, it.demo, ["app", "install", `email@${version}`, "--json"], railEnv(rail));
        assert.equal(install.code, 1, install.all);
        assert.equal(errorOf(install).code, "plugin_version_below_minimum");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 164: a prerelease of the floor's own version is refused at load and at install", async () =>
{
    const it = box();
    const witness = join(it.root, "imported");
    const rail = await floorRail("0.1.2-alpha", "0.1.2");
    try
    {
        installFixture(it, {
            key: "email",
            version: "0.1.2-alpha",
            entry: witnessed(witness, "email"),
            trustCache: { at: Date.now() - 6 * HOUR_MS, floors: { email: "0.1.2" } }
        });
        writeCredential(it, { apiBase: rail.url });
        const load = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(load.code, 1, load.all);
        assert.match(load.all, /"email" 0\.1\.2-alpha is below 0\.1\.2/);
        assert.equal(existsSync(witness), false, "a prerelease below the floor was imported");

        const install = await selfAsync(it, it.demo,
            ["app", "install", "email@0.1.2-alpha", "--json"], railEnv(rail));
        assert.equal(install.code, 1, install.all);
        assert.equal(errorOf(install).code, "plugin_version_below_minimum");
    }
    finally
    {
        await rail.close();
    }
});

/* ── 165–166: what a load costs, online and off ────────────────────── */

test("cell 165: a cache younger than the refresh age makes no trust request at all", async () =>
{
    const it = box();
    const rail = await railServer((call) => { assert.fail(`an unexpected request reached the rail: ${call.path}`); },
        { trust: null });
    try
    {
        installFixture(it, { key: "email" });
        const result = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        assert.equal(rail.calls.length, 0, "a fresh cache still went to the rail");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 166: a stale cache and an unreachable rail load the plugin with exactly one note", async () =>
{
    const it = box();
    const rail = await railServer(() => ({ destroy: true }), { trust: null });
    try
    {
        installFixture(it, { key: "email", trustCache: { fetchedAt: new Date(Date.now() - 25 * HOUR_MS).toISOString() } });
        const result = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        assert.equal(rail.calls.length, 1, "the refresh was not attempted exactly once");
        assert.equal(result.err.match(/notice:/g)?.length, 1, result.err);

        const machineReadable = await selfAsync(it, it.demo, ["email", "--json"], railEnv(rail));
        assert.equal(machineReadable.code, 0, machineReadable.all);
        assert.deepEqual(jsonOf(machineReadable.out), { ok: true, verb: "email" }, "the note reached stdout");
    }
    finally
    {
        await rail.close();
    }
});

/* ── 167–169: the root pin, driven through the injected parameter ──── */

test("cell 167: with two roots pinned, a document signed by either is accepted (1-of-N)", async () =>
{
    await inScratch(async () =>
    {
        const rootA = fixtureRoot("fixture-root-a");
        const rootB = fixtureRoot("fixture-root-b");
        const roots = [rootA.record, rootB.record];
        const fetch = servesDocument(fixtureDocument(rootB));
        for (const mode of ["install", "load"])
        {
            const state = await loadTrustDocument({ mode, session: SESSION, roots, fetch });
            assert.equal(state.signature.kid, "fixture-root-b", `${mode} accepted the wrong root`);
        }
    });
});

test("cell 168: a root whose pinned window excludes issued_at cannot sign this document", async () =>
{
    await inScratch(async () =>
    {
        const root = fixtureRoot("fixture-root-a", { notBefore: "2020-01-01T00:00:00Z", notAfter: "2021-01-01T00:00:00Z" });
        // The signature is genuinely valid. Refusal therefore proves the window
        // is judged before the verifier's answer is used — had it been used, the
        // document would have been accepted, and the release would have been
        // verified against the key this document names.
        const fetch = servesDocument(fixtureDocument(root));
        const error = await refusal(() => loadTrustDocument({ mode: "install", session: SESSION, roots: [root.record], fetch }));
        assert.equal(error?.code, "trust_document_invalid");
        assert.equal(error?.exit, 1);
        assert.equal(existsSync(trustCacheFile({ root: process.env.XDG_CONFIG_HOME })), false);
    });
});

test("cell 168: the release verifier is never reached for a document signed outside a root's window", async () =>
{
    const it = box();
    const witness = join(it.root, "imported");
    // The same refusal as above, driven through the shipped binary against the
    // **pinned** root — so "the verifier was never called for the release" can
    // be asserted rather than argued: the release route is the only way a
    // release reaches the verifier, and the run never asks it for one.
    const early = signedTrust({ issuedAt: "2025-06-01T00:00:00Z" });
    const rail = await railServer((call) => (call.path === TRUST_PATH
        ? { status: 200, body: early }
        : { status: 200, body: releaseDocument({ key: "email" }) }), { trust: null });
    try
    {
        installFixture(it, { key: "email", entry: witnessed(witness, "email"), trustCache: null });
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(result.code, 1, result.all);
        assert.equal(errorOf(result).code, "trust_document_invalid");
        assert.deepEqual(rail.calls.map((call) => call.path), [TRUST_PATH],
            "a release was fetched, so the release verifier was reachable");
        assert.equal(existsSync(witness), false, "the plugin's module was imported");
        assert.equal(existsSync(trustCacheFile(it)), false, "a document signed outside the window was cached");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 169: alg equality and root lookup are decided before the verifier is consulted", async () =>
{
    await inScratch(async () =>
    {
        const root = fixtureRoot("fixture-root-a");
        // A document this machine already holds, so the load half is a refusal
        // to **adopt** the bad one rather than a machine with nothing at all —
        // which is the half of the load path a bare scratch never reaches.
        const held = await loadTrustDocument({
            mode: "install", session: SESSION, roots: [root.record], fetch: servesDocument(fixtureDocument(root))
        });
        // What a refusal that provably never reaches the verifier costs: a body
        // that is not a signed document at all. The one call it spends is the
        // cache this run re-verifies on the way in, and every block below must
        // cost exactly that and no more — which is "the verifier was called zero
        // times for the served document", counted rather than argued.
        const floor = await measured(() => loadTrustDocument({
            mode: "install", session: SESSION, roots: [root.record], fetch: async () => ({ status: 200, text: "{}" })
        }));
        assert.equal(floor.error?.code, "trust_document_invalid");
        // Each block below carries a signature that verifies. Every one of them
        // must still be refused, which is only possible if `alg` and `kid` were
        // judged first and the verifier's answer was never reached for.
        const blocks = [{ alg: "none" }, { alg: "hs256" }, { alg: undefined }, { kid: DEV_KID }];
        for (const block of blocks)
        {
            const fetch = servesDocument(fixtureDocument(root, { block }));
            const install = await measured(() => loadTrustDocument({ mode: "install", session: SESSION, roots: [root.record], fetch }));
            assert.equal(install.error?.code, "trust_document_invalid", `install accepted ${JSON.stringify(block)}`);
            assert.equal(install.calls, floor.calls, `the verifier was consulted about ${JSON.stringify(block)}`);
            const before = trustVerifierCalls();
            const kept = await loadTrustDocument({
                mode: "load", session: SESSION, roots: [root.record], fetch, refresh: true
            });
            assert.equal(kept.signature.sig, held.signature.sig, `load adopted ${JSON.stringify(block)}`);
            assert.equal(trustVerifierCalls() - before, floor.calls,
                `the verifier was consulted about ${JSON.stringify(block)} at load`);
        }
    });
});

test("D11: a repeated kid, or a trust_version this CLI does not read, is refused before any field is trusted", async () =>
{
    await inScratch(async () =>
    {
        const root = fixtureRoot("fixture-root-a");
        const other = generateKeyPairSync("ed25519").publicKey
            .export({ type: "spki", format: "der" }).subarray(12).toString("base64");
        // Two records under one kid: the lookup takes the first, so which key is
        // in force would be decided by the order the document lists them in.
        // And a version this CLI has never read: a later format may mean
        // something else by a field this one believes it understands.
        const bodies = [
            { ...trustBody(), keys: [trustKey(), trustKey({ publicKey: other })] },
            { ...trustBody(), trust_version: 2 }
        ];
        for (const document of bodies)
        {
            const fetch = servesDocument(fixtureDocument(root, { document }));
            const error = await refusal(() => loadTrustDocument({ mode: "install", session: SESSION, roots: [root.record], fetch }));
            assert.equal(error?.code, "trust_document_invalid", `accepted ${JSON.stringify(document.trust_version)}`);
        }
    });
});

test("D12: a public key that is not an ed25519 key is a named refusal, not a raw crypto error", async () =>
{
    await inScratch(async () =>
    {
        // The root's half, where the bytes belong to the document's own
        // verification: `trust_document_invalid`, and nothing is cached.
        const root = fixtureRoot("fixture-root-a");
        const fetch = servesDocument(fixtureDocument(root));
        const broken = { ...root.record, publicKey: "not-a-key" };
        const error = await refusal(() => loadTrustDocument({ mode: "install", session: SESSION, roots: [broken], fetch }));
        assert.equal(error?.code, "trust_document_invalid");
    });
    // And the release half, where the bytes are a **release** key the document
    // names — the one an attacker who can get a document published chooses.
    const it = box();
    installFixture(it, { key: "email", trustCache: { keys: [trustKey({ publicKey: "not-a-key" })] } });
    const load = await selfAsync(it, it.demo, ["email"], {});
    assert.equal(load.code, 1, load.all);
    assert.match(load.all, /not a valid ed25519 public key/);
});

test("D13: the publish gate refuses a development root, and no environment variable turns it off", () =>
{
    // The gate is the last thing between `npm publish` and a CLI that trusts a
    // root whose private half is committed here. A skip switch would be read in
    // the same shell that runs the publish, so there is none — asserted twice:
    // the gate refuses this tree with the variable that used to disarm it set,
    // and neither file on the publish path reads the environment at all.
    const gate = fileURLToPath(new URL("./release-keys.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [gate],
        { env: { ...process.env, SUPERSELF_DEV_KEYS: "1" }, encoding: "utf8" });
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /development-trust-anchor/);

    const structure = readFileSync(fileURLToPath(new URL("./structure.mjs", import.meta.url)), "utf8");
    const decides = structure.slice(structure.indexOf("export function rootKeyViolations"),
        structure.indexOf("function violation("));
    assert.doesNotMatch(readFileSync(gate, "utf8") + decides, /process\.env/,
        "the publish gate reads an environment variable");
});

test("D10: a build with no pinned root accepts no document at all", async () =>
{
    await inScratch(async () =>
    {
        // The pre-ceremony state of `rootkeys.ts`, and the reason the publish
        // gate refuses it: nothing can be verified, so nothing can be installed.
        const root = fixtureRoot("fixture-root-a");
        const fetch = servesDocument(fixtureDocument(root));
        const error = await refusal(() => loadTrustDocument({ mode: "install", session: SESSION, roots: [], fetch }));
        assert.equal(error?.code, "trust_document_invalid");
    });
});

/* ── 170: the size cap ─────────────────────────────────────────────── */

test("cell 170: a document one byte over the cap is refused before it is parsed", async () =>
{
    const it = box();
    // Valid JSON, correctly signed, and 64 KB + 1 byte long. Size is the only
    // thing wrong with it, so a refusal can only be the cap.
    const body = JSON.stringify(signedTrust());
    const padded = body + " ".repeat(64 * 1024 + 1 - Buffer.byteLength(body));
    const rail = await railServer((call) => (call.path === TRUST_PATH
        ? { status: 200, body: padded }
        : { status: 500, body: {} }), { trust: null });
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], railEnv(rail));
        assert.equal(result.code, 1, result.all);
        assert.equal(errorOf(result).code, "trust_document_too_large");
        assert.equal(existsSync(trustCacheFile(it)), false, "an oversized document was cached");
        assert.equal(existsSync(pluginsRoot(it)), false, "a plugin tree was written");
        assert.equal(existsSync(join(configRoot(it), "plugin-state.json")), false, "an install record was written");
        assert.deepEqual(rail.calls.map((call) => call.path), [TRUST_PATH], "a release was requested anyway");
    }
    finally
    {
        await rail.close();
    }
});

/* ── 171: no environment variable can add a key ────────────────────── */

// Read from the sources rather than kept as a list here, so a variable added
// tomorrow joins this cell instead of quietly escaping it.
//
// Two forms are read, because the CLI writes both. `process.env.NAME` names the
// variable where it is read; `process.env[name]` reads a name the module holds
// in a declared list — which is how `machine.ts` finds the agent harness's
// session id and `human.ts` finds an attempt marker. A scan that saw only the
// first form would call this cell exhaustive while three variables walked past
// it.
function environmentNames()
{
    const names = sourceFiles().flatMap(([, text]) => [...directNames(text), ...listedNames(text)]);
    return [...new Set(names)].sort();
}

function sourceFiles()
{
    const src = fileURLToPath(new URL("../src", import.meta.url));
    return readdirSync(src).map((file) => [file, readFileSync(join(src, file), "utf8")]);
}

function directNames(text)
{
    return [...text.matchAll(/process\.env\.([A-Za-z_0-9]+)/g)].map((found) => found[1]);
}

// The declared name lists of a module that indexes `process.env` with one.
// Only such a module is read this way, so an unrelated constant array elsewhere
// in the tree does not become an environment variable.
function listedNames(text)
{
    if (!/process\.env\[/.test(text))
    {
        return [];
    }
    return [...text.matchAll(/const\s+[A-Z][A-Z0-9_]*\s*=\s*\[([^\]]*)\]/g)]
        .flatMap((found) => [...found[1].matchAll(/"([A-Za-z_][A-Za-z_0-9]*)"/g)].map((name) => name[1]));
}

function indirectReaders()
{
    return sourceFiles().filter(([, text]) => /process\.env\[/.test(text)).map(([file]) => file);
}

test("cell 171: every environment variable the CLI reads, set to a fixture root, adds nothing", async () =>
{
    const it = box();
    const stranger = fixtureRoot("fixture-root-a");
    const material = Buffer.from(JSON.stringify(stranger.record)).toString("base64");
    const rootFile = join(it.root, "fixture-root.json");
    writeFileSync(rootFile, JSON.stringify([stranger.record]));
    const rail = await railServer((call) => (call.path === TRUST_PATH
        ? { status: 200, body: fixtureDocument(stranger) }
        : { status: 500, body: {} }), { trust: null });
    try
    {
        // The complete set, asserted rather than assumed. `SUPERSELF_API_BASE`
        // and the XDG paths keep their real values — pointing them at a fixture
        // root is what the rest of the variables are being tested for.
        const names = environmentNames();
        assert.deepEqual(names, [
            "CI", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "NODE_TLS_REJECT_UNAUTHORIZED", "NO_COLOR",
            "SUPERSELF_API_BASE", "SUPERSELF_ATTEMPT_ID", "SUPERSELF_DEBUG", "SUPERSELF_DEV",
            "SUPERSELF_JSON", "SUPERSELF_NO_JOURNAL", "SUPERSELF_PLUGIN_DEV", "SUPERSELF_PROFILE",
            "SUPERSELF_SESSION", "SUPERSELF_SESSION_PID", "TERM",
            "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"
        ], "a new environment variable joined the CLI without joining this cell");
        // A module that indexes `process.env` with something other than a
        // declared list reads names the scan above cannot enumerate, so which
        // modules do it at all is asserted rather than assumed. `redact.ts` is
        // the one that reads by pattern — it turns a value into a redaction
        // literal and names no key material.
        assert.deepEqual(indirectReaders(), ["human.ts", "machine.ts", "redact.ts"],
            "a module started reading process.env indirectly without joining this cell");
        // Four keep their real values, and none of them is about a key.
        // `SUPERSELF_API_BASE` and the XDG paths say which rail and which
        // machine — point them elsewhere and the run never reaches the document
        // at all, which would prove nothing. Every other variable is set to a
        // fixture root, as a path and as base64, at once.
        const kept = ["SUPERSELF_API_BASE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
            "SUPERSELF_DEV", "SUPERSELF_PROFILE"];
        const hostile = Object.fromEntries(names
            .filter((name) => !kept.includes(name))
            .map((name) => [name, `${rootFile}:${material}`]));
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email", "--json"], { ...railEnv(rail), ...hostile });
        assert.equal(result.code, 1, result.all);
        assert.equal(errorOf(result).code, "trust_document_invalid");
        assert.equal(existsSync(pluginsRoot(it)), false, "an environment variable installed a plugin");

        // And with the last five hostile as well. `SUPERSELF_PROFILE` names a
        // credential profile and a path is not one, so this run refuses even
        // earlier — which is the same answer for the purpose of this cell:
        // nothing an environment variable says installs a plugin.
        const everything = Object.fromEntries(names.map((name) => [name, `${rootFile}:${material}`]));
        const all = await selfAsync(it, it.demo, ["app", "install", "email"], { ...railEnv(rail), ...everything });
        assert.notEqual(all.code, 0, all.all);
        assert.equal(existsSync(pluginsRoot(it)), false, "an environment variable installed a plugin");
    }
    finally
    {
        await rail.close();
    }
});

/* ── 172: a tampered cache is absent, never unlocked ───────────────── */

test("cell 172: one changed byte in the cache makes it absent — a fetch happens, or the load refuses", async () =>
{
    const it = box();
    const rail = await railServer(() => ({ status: 404, body: {} }));
    try
    {
        installFixture(it, { key: "email" });
        const path = trustCacheFile(it);
        const cached = JSON.parse(readFileSync(path, "utf8"));
        cached.trust.document.issued_at = new Date(Date.parse(cached.trust.document.issued_at) + 1000).toISOString();
        writeFileSync(path, JSON.stringify(cached, null, 2), { mode: 0o600 });

        const online = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(online.code, 0, online.all);
        assert.equal(rail.trustCalls.length, 1, "a tampered cache was used as-is");
        assert.notEqual(JSON.parse(readFileSync(path, "utf8")).trust.document.issued_at,
            cached.trust.document.issued_at, "the tampered document survived the refetch");
    }
    finally
    {
        await rail.close();
    }
    const offline = box();
    const dead = await railServer(() => ({ destroy: true }), { trust: null });
    try
    {
        installFixture(offline, { key: "email" });
        writeFileSync(trustCacheFile(offline), "{ not json", { mode: 0o600 });
        const result = await selfAsync(offline, offline.demo, ["email"], railEnv(dead));
        assert.equal(result.code, 3, result.all);
        assert.match(result.all, /has no plugin key list and could not obtain one/);
        // The load refusal happens before a leaf resolves, so there is no
        // machine mode to render the code into. `app trust` is a leaf and reads
        // the same state through the same step 0, so the code the run is
        // refusing with is read from there.
        const named = await selfAsync(offline, offline.demo, ["app", "trust", "--json"], railEnv(dead));
        assert.equal(named.code, 3, named.all);
        assert.equal(errorOf(named).code, "trust_unavailable");
        assert.equal(errorOf(named).retry_after_s, 5);
    }
    finally
    {
        await dead.close();
    }
});

/* ── the leaf that shows what the CLI is acting on (Q22) ───────────── */

test("self app trust prints the cached list, and exits 3 when there is none and no rail (D6)", async () =>
{
    const it = box();
    const rail = await railServer(() => ({ status: 404, body: {} }));
    try
    {
        writeTrustCache(it, {});
        const shown = await selfAsync(it, it.demo, ["app", "trust", "--json"], railEnv(rail));
        assert.equal(shown.code, 0, shown.all);
        const payload = jsonOf(shown.out);
        assert.equal(payload.signed_by, "dev-root-2026a");
        assert.equal(payload.expired, false);
        assert.deepEqual(payload.keys.map((key) => [key.kid, key.status]), [[DEV_KID, "active"]]);
        assert.equal(rail.trustCalls.length, 0, "a fresh cache still went to the rail");

        const refreshed = await selfAsync(it, it.demo, ["app", "trust", "--refresh", "--json"], railEnv(rail));
        assert.equal(refreshed.code, 0, refreshed.all);
        assert.equal(rail.trustCalls.length, 1, "--refresh did not fetch");
    }
    finally
    {
        await rail.close();
    }
    const bare = box();
    const dead = await railServer(() => ({ destroy: true }), { trust: null });
    try
    {
        const result = await selfAsync(bare, bare.demo, ["app", "trust", "--json"], railEnv(dead));
        assert.equal(result.code, 3, result.all);
        assert.equal(errorOf(result).code, "trust_unavailable");
    }
    finally
    {
        await dead.close();
    }
});

/* ── D9: the conditional GET, and what it does not send ────────────── */

test("D9: If-None-Match is sent only when there is a cache to match, and a 304 keeps it", async () =>
{
    const it = box();
    const served = signedTrust();
    const rail = await railServer((call) => (call.path === TRUST_PATH
        ? etagAnswer(call, served)
        : { status: 404, body: {} }), { trust: null });
    try
    {
        const first = await selfAsync(it, it.demo, ["app", "trust", "--json"], railEnv(rail));
        assert.equal(first.code, 0, first.all);
        assert.equal(rail.calls[0].headers["if-none-match"], undefined, "a conditional GET with nothing to match");

        const second = await selfAsync(it, it.demo, ["app", "trust", "--refresh", "--json"], railEnv(rail));
        assert.equal(second.code, 0, second.all);
        assert.equal(rail.calls[1].headers["if-none-match"], '"fixture"');
        assert.equal(rail.calls[1].method, "GET");
        assert.equal(jsonOf(second.out).issued_at, served.document.issued_at, "the 304 lost the cached document");
        assert.equal(rail.calls[1].headers.authorization, undefined, "the trust fetch carried a credential");
    }
    finally
    {
        await rail.close();
    }
});

function etagAnswer(call, served)
{
    if (call.headers["if-none-match"] === '"fixture"')
    {
        return { status: 304, body: "", headers: { etag: '"fixture"' } };
    }
    return { status: 200, body: served, headers: { etag: '"fixture"' } };
}

/* ── D7: what the signature is over, and what it therefore ignores ─── */

test("D7: verification is over jcs of the parsed document, so how the bytes were spelled cannot matter", async () =>
{
    await inScratch(async () =>
    {
        const root = fixtureRoot("fixture-root-a");
        const signed = fixtureDocument(root);
        // The same document, re-spelled: members in another order, indented,
        // and carrying a duplicate the parser collapses onto the value the root
        // signed. None of it survives `JSON.parse`, so none of it can matter.
        const respelled = `{\n "signature": ${JSON.stringify(signed.signature)},\n`
            + ` "document": ${JSON.stringify(signed.document, null, 4)},\n`
            + ` "document": ${JSON.stringify(signed.document)}\n}`;
        const state = await loadTrustDocument({
            mode: "install", session: SESSION, roots: [root.record],
            fetch: async () => ({ status: 200, text: respelled })
        });
        assert.equal(state.document.issued_at, signed.document.issued_at);

        // And a document whose canonical form differs by one value is refused,
        // however well-formed the bytes around it are.
        const tampered = { ...signed, document: { ...signed.document, min_cli_version: "9.9.9" } };
        const error = await refusal(() => loadTrustDocument({
            mode: "install", session: SESSION, roots: [root.record], fetch: servesDocument(tampered)
        }));
        assert.equal(error?.code, "trust_document_invalid");
    });
});

/* ── D1: the cache answers to the credential directory's rule ──────── */

test("D1: a cache readable by other users is treated as absent and rewritten at 0600", async () =>
{
    const it = box();
    const rail = await railServer(() => ({ status: 404, body: {} }));
    try
    {
        installFixture(it, { key: "email" });
        const path = trustCacheFile(it);
        writeFileSync(path, readFileSync(path), { mode: 0o644 });
        const { chmodSync, statSync } = await import("node:fs");
        chmodSync(path, 0o644);
        const result = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        assert.equal(rail.trustCalls.length, 1, "a world-readable cache was used as-is");
        assert.equal(statSync(path).mode & 0o777, 0o600, "the rewritten cache is not private");
        assert.ok(existsSync(join(configRoot(it), "trust.json")));
    }
    finally
    {
        await rail.close();
    }
});
