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
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { machine } from "./harness.mjs";
import {
    DEV_KID, configRoot, installFixture, jsonOf, pluginSource, pluginsRoot, railEnv, railServer,
    releaseDocument, selfAsync, signedTrust, trustBody, trustCacheFile, trustKey,
    writeCredential, writeTrustCache
} from "./pr7-lib.mjs";
import { jcs } from "../dist/rail.js";
import { TRUST_PATH, loadTrustDocument } from "../dist/trust.js";

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
function fixtureDocument(root, options = {})
{
    const document = trustBody(options);
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
        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--force", "--json"], railEnv(rail));
        assert.equal(install.code, 1, install.all);
        assert.equal(errorOf(install).code, "trust_document_expired");
        assert.equal(rail.calls.length, 0, "a release was fetched against an expired key list");

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
        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--force", "--json"], railEnv(rail));
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

        const install = await selfAsync(it, it.demo, ["app", "install", "email", "--force", "--json"], railEnv(rail));
        assert.equal(install.code, 1, install.all);
        assert.equal(errorOf(install).code, "plugin_key_revoked");
        assert.equal(readdirSync(join(pluginsRoot(it), "email")).sort().join(","), "0.1.0,current",
            "the refused install wrote into the plugin tree");
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

        for (const extra of [[], ["--allow-downgrade"]])
        {
            const install = await selfAsync(it, it.demo,
                ["app", "install", "email@0.1.1", "--force", "--json", ...extra], railEnv(rail));
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

test("cell 169: alg equality and root lookup are decided before the verifier is consulted", async () =>
{
    await inScratch(async () =>
    {
        const root = fixtureRoot("fixture-root-a");
        // Each block below carries a signature that verifies. Every one of them
        // must still be refused, which is only possible if `alg` and `kid` were
        // judged first and the verifier's answer was never reached for.
        const blocks = [{ alg: "none" }, { alg: "hs256" }, { alg: undefined }, { kid: DEV_KID }];
        for (const block of blocks)
        {
            const fetch = servesDocument(fixtureDocument(root, { block }));
            const error = await refusal(() => loadTrustDocument({ mode: "install", session: SESSION, roots: [root.record], fetch }));
            assert.equal(error?.code, "trust_document_invalid", `accepted ${JSON.stringify(block)}`);
        }
    });
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
    }
    finally
    {
        await rail.close();
    }
});

/* ── 171: no environment variable can add a key ────────────────────── */

// Read from the sources rather than kept as a list here, so a variable added
// tomorrow joins this cell instead of quietly escaping it.
function environmentNames()
{
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const names = readdirSync(src).flatMap((file) =>
        [...readFileSync(join(src, file), "utf8").matchAll(/process\.env\.([A-Za-z_0-9]+)/g)].map((found) => found[1]));
    return [...new Set(names)].sort();
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
            "CI", "NODE_TLS_REJECT_UNAUTHORIZED", "NO_COLOR", "SUPERSELF_API_BASE", "SUPERSELF_ATTEMPT_ID",
            "SUPERSELF_DEBUG", "SUPERSELF_DEV", "SUPERSELF_JSON", "SUPERSELF_NO_JOURNAL",
            "SUPERSELF_PLUGIN_DEV", "SUPERSELF_PROFILE", "SUPERSELF_SESSION", "TERM",
            "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"
        ], "a new environment variable joined the CLI without joining this cell");
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
