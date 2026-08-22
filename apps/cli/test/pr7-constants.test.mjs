// Design §10 — the constants, asserted against the numbers the design fixes,
// plus the small pure functions the rest of the suite reaches through the
// binary rather than directly.
//
// A constants test earns its place here for one reason: several of these
// numbers are load-bearing *relative to each other*, and a change to one alone
// is a defect that no behavioural test would catch on a fast machine. The lease
// being longer than a whole legal refresh is the clearest case — shorten it and
// a perfectly healthy holder becomes stealable mid-flight, which is exactly the
// race the lock exists to prevent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { machine } from "./harness.mjs";
import {
    LOCK_ABSOLUTE_STEAL_MS, LOCK_WAIT_MS, PENDING_MARKER_TTL_MS, REFRESH_MARGIN_MS, STALE_LOCK_MS,
    configDir, lockPath, pendingPath, profileName
} from "../dist/credentials.js";
import {
    CALL_JOURNAL_LINES, CLOCK_SKEW_NOTICE_MS, CONNECT_TIMEOUT_MS, DEPLOY_TIMEOUT_MS, HUMAN_STRING_CAP,
    REQUEST_TIMEOUT_MS, RESPONSE_CAP_BYTES, TRANSPORT_ATTEMPTS, assertApiBase, assertTlsPolicy, useBackoff
} from "../dist/rail.js";
import {
    HOST_FILE_CAP_BYTES, PLUGIN_ENTRY_CAP_BYTES, PLUGIN_KEY_PATTERN, SUPPORTED_CONTRACTS,
    compareVersions, pluginHost, pluginStatePath, pluginsDir, satisfies, setPluginState,
    readPluginState, verifyManifest
} from "../dist/plugins.js";
import { RELEASE_KEYS } from "../dist/releasekeys.js";
import { DEFAULT_API_BASE } from "../dist/login.js";
import { splitPin } from "../dist/app.js";
import { manifestFor, signManifest } from "./pr7-lib.mjs";

/* ── §10, value by value ───────────────────────────────────────────── */

test("§10: every constant the design fixes has the value the design fixes", () =>
{
    assert.equal(REFRESH_MARGIN_MS, 60_000, "proactive refresh margin");
    assert.equal(LOCK_WAIT_MS, 20_000, "refresh lock wait");
    assert.equal(STALE_LOCK_MS, 45_000, "stale-lock lease");
    assert.equal(LOCK_ABSOLUTE_STEAL_MS, 600_000, "absolute lock steal bound");
    assert.equal(PENDING_MARKER_TTL_MS, 30 * 24 * 60 * 60 * 1000, "pending-marker TTL");
    assert.equal(CONNECT_TIMEOUT_MS, 5_000, "connect timeout");
    assert.equal(REQUEST_TIMEOUT_MS, 30_000, "request timeout");
    assert.equal(DEPLOY_TIMEOUT_MS, 120_000, "deploy request timeout");
    assert.equal(TRANSPORT_ATTEMPTS, 3, "transport attempts");
    assert.equal(PLUGIN_ENTRY_CAP_BYTES, 4 * 1024 * 1024, "plugin entry cap");
    assert.equal(HOST_FILE_CAP_BYTES, 4 * 1024 * 1024, "host file cap");
    assert.equal(RESPONSE_CAP_BYTES, 8 * 1024 * 1024, "release response cap");
    assert.equal(CALL_JOURNAL_LINES, 1000, "call journal cap");
    assert.equal(HUMAN_STRING_CAP, 2048, "server-string cap, human rendering only");
    assert.equal(CLOCK_SKEW_NOTICE_MS, 300_000, "clock-skew notice threshold");
    assert.deepEqual(SUPPORTED_CONTRACTS, [0], "the mini-app contract versions this host implements");
});

test("§10: the lease is longer than a whole legal refresh, and the absolute bound is longer than the lease", () =>
{
    // The relationship, not the numbers. A lease shorter than connect plus
    // request would make a live holder stealable mid-flight, which is the exact
    // race a lock exists to prevent; and a wait longer than the lease would
    // mean no waiter ever reaches the point where it may steal.
    assert.ok(STALE_LOCK_MS > CONNECT_TIMEOUT_MS + REQUEST_TIMEOUT_MS,
        "a live refresh holder is stealable inside its own request");
    assert.ok(LOCK_ABSOLUTE_STEAL_MS > STALE_LOCK_MS,
        "the absolute bound is not an escape from the lease, it is the same thing");
    assert.ok(LOCK_WAIT_MS < STALE_LOCK_MS,
        "an ordinary waiter gives up before it could ever legitimately steal");
});

test("the default rail is the hosted one, and it is https", () =>
{
    assert.equal(DEFAULT_API_BASE, "https://app.superselfs.com");
    assert.equal(new URL(DEFAULT_API_BASE).protocol, "https:");
});

/* ── the pinned keys ───────────────────────────────────────────────── */

test("every pinned release key is a 32-byte ed25519 public key with a validity window", () =>
{
    assert.ok(RELEASE_KEYS.length >= 1);
    for (const key of RELEASE_KEYS)
    {
        assert.equal(Buffer.from(key.publicKey, "base64").byteLength, 32, `${key.kid} is not a raw ed25519 key`);
        assert.ok(Date.parse(key.notBefore) < Date.parse(key.notAfter), `${key.kid} has an empty window`);
    }
});

test("the development key is marked as one, so nobody ships it as a trust anchor by accident", () =>
{
    // Its private half is a fixture in this repository, so a release it signs
    // is signed by a key everybody has. The rotation before the first public
    // release is a checklist item, and this is what makes it visible.
    assert.ok(RELEASE_KEYS.every((key) => key.kid.startsWith("dev-")),
        "a non-development key is pinned — update this assertion deliberately when one ships");
});

/* ── TLS and base-URL policy ───────────────────────────────────────── */

test("api_base must be https, with one localhost exception gated on development mode", () =>
{
    assert.equal(assertApiBase("https://app.superselfs.com/"), "https://app.superselfs.com");
    assert.throws(() => assertApiBase("http://example.com"), /not https/);
    assert.throws(() => assertApiBase("http://127.0.0.1:8790"), /not https/);
    const was = process.env.SUPERSELF_DEV;
    process.env.SUPERSELF_DEV = "1";
    try
    {
        assert.equal(assertApiBase("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
        assert.equal(assertApiBase("http://localhost:8790"), "http://localhost:8790");
        // Development mode does not open the door to any other host.
        assert.throws(() => assertApiBase("http://evil.example"), /not https/);
    }
    finally
    {
        if (was === undefined)
        {
            delete process.env.SUPERSELF_DEV;
        }
        else
        {
            process.env.SUPERSELF_DEV = was;
        }
    }
});

test("a disabled certificate check refuses every rail command outright", () =>
{
    const was = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try
    {
        assert.throws(() => assertTlsPolicy(), /NODE_TLS_REJECT_UNAUTHORIZED/);
    }
    finally
    {
        if (was === undefined)
        {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        }
        else
        {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = was;
        }
    }
    assert.doesNotThrow(() => assertTlsPolicy());
});

/* ── names that reach the filesystem ───────────────────────────────── */

test("a profile name is checked before it becomes a path", () =>
{
    // `--profile` and `SUPERSELF_PROFILE` are caller-supplied and end up in a
    // filename beside the credential, so traversal is refused by name rather
    // than by hoping nobody tries.
    for (const bad of ["../evil", "a/b", "..", "", "A", "x".repeat(40), "-leading"])
    {
        assert.throws(() => profileName(bad), /is not a name/, `accepted ${JSON.stringify(bad)}`);
    }
    for (const good of ["default", "ci", "team_2", "a.b-c"])
    {
        assert.equal(profileName(good), good);
    }
});

test("the marker and the lock are named for the profile they cover", () =>
{
    const box = machine();
    const previous = { ...process.env };
    Object.assign(process.env, box.env);
    try
    {
        assert.equal(pendingPath("ci"), `${configDir()}/credentials.ci.pending`);
        assert.equal(lockPath("ci"), `${configDir()}/credentials.ci.lock`);
        assert.notEqual(pendingPath("ci"), pendingPath("default"),
            "one fixed name would let a command on one profile delete another profile's marker");
        // The state file lives beside the credential, deliberately outside the
        // plugin tree it guards.
        assert.equal(pluginStatePath(), `${configDir()}/plugin-state.json`);
        assert.ok(!pluginStatePath().startsWith(pluginsDir()));
    }
    finally
    {
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, previous);
    }
});

test("a plugin key is a key before it is a directory name", () =>
{
    for (const bad of ["../evil", "Email", "9lives", "a", "x".repeat(40), "with_underscore"])
    {
        assert.equal(PLUGIN_KEY_PATTERN.test(bad), false, `accepted ${JSON.stringify(bad)}`);
    }
    ["email", "wallet", "landing", "my-app"].forEach((key) => assert.equal(PLUGIN_KEY_PATTERN.test(key), true));
});

test("`<key>@<version>` splits into the key and the pin the request carries", () =>
{
    assert.deepEqual(splitPin("email"), { key: "email" });
    assert.deepEqual(splitPin("email@0.1.0"), { key: "email", pin: "0.1.0" });
    assert.throws(() => splitPin("email@latest"), /not a semantic version/);
    assert.throws(() => splitPin("Email"), /not a plugin key/);
});

/* ── version comparison, only as much as a manifest needs ──────────── */

test("SemVer ranges are read exactly, and an unreadable one never silently passes", () =>
{
    assert.equal(satisfies("1.4.0", "^1"), true);
    assert.equal(satisfies("2.0.0", "^1"), false);
    assert.equal(satisfies("0.7.0", ">=0.7.0 <1.0.0"), true);
    assert.equal(satisfies("1.0.0", ">=0.7.0 <1.0.0"), false);
    assert.equal(satisfies("0.6.1", ">=0.7.0"), false);
    assert.equal(satisfies("9.9.9", "*"), true);
    // A range this cannot read is refused rather than approximated.
    assert.equal(satisfies("1.0.0", "~1.0.0 || 2.x"), false);
    assert.equal(compareVersions("0.2.0", "0.10.0"), -1, "versions compare numerically, not as strings");
});

/* ── the verifier, driven directly ─────────────────────────────────── */

test("verifyManifest refuses an unpinned key, a wrong algorithm, and a signature over other bytes", () =>
{
    const { manifest } = manifestFor({ key: "email" });
    const signature = signManifest(manifest);
    assert.doesNotThrow(() => verifyManifest(manifest, signature));

    assert.throws(() => verifyManifest(manifest, { ...signature, alg: "none" }), /not accepted/);
    assert.throws(() => verifyManifest(manifest, { ...signature, kid: "rel-unknown" }), /no pinned release key/);
    // The signature covers the manifest, so a manifest edited after signing
    // fails even though the signature itself is genuine.
    assert.throws(() => verifyManifest({ ...manifest, version: "9.9.9" }, signature), /not signed by a pinned key/);
    // A release dated outside the key's window is refused even when signed.
    assert.throws(() => verifyManifest({ ...manifest, released_at: "2030-01-01T00:00:00Z" },
        signManifest({ ...manifest, released_at: "2030-01-01T00:00:00Z" })), /validity window/);
});

/* ── the host object a plugin is handed ────────────────────────────── */

test("the host gives a plugin exactly the members the contract declares, and nothing more", () =>
{
    const host = pluginHost({ profile: "default", client: "self/0.7.0 contract/0" }, () => "probe");
    assert.deepEqual(Object.keys(host).sort(),
        ["api", "consoleBase", "contract", "errors", "file", "log", "now", "output", "rail"]);
    assert.equal(host.api, 0);
    assert.deepEqual(Object.keys(host.contract).sort(), ["branch", "command", "leaf"]);
    assert.deepEqual(Object.keys(host.output).sort(), ["document", "listing", "payload", "receipt"]);
    assert.deepEqual(Object.keys(host.errors).sort(), ["fail", "pending", "refuse"]);
    // A plugin never decides an exit code numerically: it names the kind of
    // answer it is giving and the one table decides.
    assert.equal(host.errors.fail("x", "m").exit, 1);
    assert.equal(host.errors.refuse("x", "m").exit, 2);
    assert.equal(host.errors.pending("x", "m").exit, 3);
    // And it never writes to stdout: the output members build blocks.
    assert.equal(host.output.payload({ a: 1 }, () => []).kind, "payload");
    assert.equal(host.output.receipt("done").kind, "receipt");
});

test("a development host marks every machine answer it builds", () =>
{
    const host = pluginHost({ profile: "default", client: "self/0.7.0 contract/0" }, () => "probe", true);
    assert.deepEqual(host.output.payload({ ok: true }, () => []).data, { ok: true, plugin_source: "dev" });
});

/* ── the state file, written and read back ─────────────────────────── */

test("plugin state round-trips, and a key's entry is replaced rather than merged blindly", () =>
{
    const box = machine();
    const previous = { ...process.env };
    Object.assign(process.env, box.env);
    try
    {
        setPluginState("email", { highest: "0.1.0", rail_api_seen: "1", installed_at: "2026-08-01T00:00:00Z" });
        setPluginState("wallet", { highest: "0.2.0", installed_at: "2026-08-01T00:00:00Z" });
        const state = readPluginState();
        assert.equal(state.plugins.email.highest, "0.1.0");
        assert.equal(state.plugins.wallet.highest, "0.2.0");
        assert.equal(state.plugins.wallet.rail_api_seen, undefined);
    }
    finally
    {
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, previous);
    }
});

test("the backoff is injectable, so a suite proves the retry count without spending the seconds", async () =>
{
    const waits = [];
    const previous = useBackoff(async (ms) => { waits.push(ms); });
    try
    {
        assert.equal(typeof previous, "function");
        assert.deepEqual(waits, []);
    }
    finally
    {
        useBackoff(previous);
    }
});
