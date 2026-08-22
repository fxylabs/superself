// Design §7.3 — credential state × any authenticated command. Cells 36–49,
// 137 and 138.
//
// Most of these assert on what was **not** sent: a refresh that must not have
// happened, a request that must not have been replayed, a network call that
// must not have been made at all. The fixture rail records every call, so those
// are assertions rather than hopes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { machine } from "./harness.mjs";
import {
    credentialsFile, installFixture, jsonOf, markerPath, railEnv, railServer, selfAsync,
    writeCredential, writeMarkerFixture
} from "./pr7-lib.mjs";

function box()
{
    const created = machine();
    return { ...created, demo: created.root };
}

// A fixture plugin that carries a call key, which is the shape every paid
// command has.
function keyedPlugin()
{
    return `export default function register(host)
{
    return [{
        name: "paid",
        usage: [{ syntax: "paid [--json]", description: ["fixture"], verbs: [""] }],
        detail: ["fixture", "", "  --json                machine-readable output"],
        node: host.contract.leaf("", { json: { type: "boolean" } }, 0, async () =>
        {
            const answer = await host.rail.request({
                method: "POST", path: "/api/email/send", body: { campaignName: "c" },
                scopes: ["email.send"], callKey: "derive"
            });
            return [host.output.payload({ ...answer.body, idempotency_key: answer.callKey }, () => ["sent"])];
        })
    }];
}
`;
}

// A fixture plugin with no call key and a multipart body — the `landing deploy`
// shape, whose replay safety rests on the server rather than on a key.
function deployPlugin()
{
    return `export default function register(host)
{
    return [{
        name: "deploy",
        usage: [{ syntax: "deploy [--json]", description: ["fixture"], verbs: [""] }],
        detail: ["fixture", "", "  --json                machine-readable output"],
        node: host.contract.leaf("", { json: { type: "boolean" } }, 0, async () =>
        {
            const answer = await host.rail.request({
                method: "POST", path: "/api/landing/deploy",
                form: [{ name: "slug", value: "demo" }, { name: "files", value: "<html></html>", filename: "index.html" }],
                scopes: ["landing.deploy"]
            });
            return [host.output.payload(answer.body, () => ["deployed"])];
        })
    }];
}
`;
}

async function run(it, args, handler, extra = {})
{
    const rail = await railServer(handler);
    try
    {
        writeCredential(it, { apiBase: rail.url, ...extra });
        const result = await selfAsync(it, it.demo, args, railEnv(rail));
        return { ...result, calls: rail.calls };
    }
    finally
    {
        await rail.close();
    }
}

function rotated(extra = {})
{
    return {
        status: 200,
        body: {
            status: "approved",
            access_token: "sa_rotated",
            refresh_token: "sr_rotated",
            scopes: ["email.send", "email.read", "email.domain.manage", "landing.deploy", "landing.read", "wallet.read"],
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            ...extra
        }
    };
}

/* ── cells 36–38: the file itself ──────────────────────────────────── */

test("cell 36: no credential is exit 1 login_required, hinting self login", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: {} }));
    try
    {
        const result = await selfAsync(it, it.demo, ["paid"], railEnv(rail));
        assert.equal(result.code, 1);
        assert.match(result.all, /no credential on this machine/);
        assert.match(result.all, /self login/);
        assert.equal(rail.calls.length, 0, "a call was made with no credential");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 37: a credential other users can read is refused with no network call", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: {} }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        chmodSync(credentialsFile(it), 0o644);
        const result = await selfAsync(it, it.demo, ["paid"], railEnv(rail));
        assert.equal(result.code, 1);
        assert.match(result.all, /readable by other users/);
        assert.match(result.all, /chmod 600/);
        assert.equal(rail.calls.length, 0, "a credential at the wrong mode was still sent");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 38: an unparseable credential file is credentials_unreadable", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: {} }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        writeFileSync(credentialsFile(it), "{ truncated", { mode: 0o600 });
        const result = await selfAsync(it, it.demo, ["paid"], railEnv(rail));
        assert.equal(result.code, 1);
        assert.match(result.all, /not readable as a credential file/);
        assert.equal(rail.calls.length, 0);
    }
    finally
    {
        await rail.close();
    }
});

/* ── cells 39–41: when a refresh happens, and when it does not ─────── */

test("cell 39: a credential comfortably inside its lifetime is used without a refresh", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const result = await run(it, ["paid"], () => ({ status: 200, body: { ok: true } }),
        { expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(result.code, 0, result.all);
    assert.equal(result.calls.filter((call) => call.path === "/api/auth/refresh").length, 0);
});

test("cell 40: a credential inside the 60s margin is refreshed before the call", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const result = await run(it, ["paid"],
        (call) => (call.path === "/api/auth/refresh" ? rotated() : { status: 200, body: { ok: true } }),
        { expiresAt: new Date(Date.now() + 30_000).toISOString() });
    assert.equal(result.code, 0, result.all);
    assert.equal(result.calls[0].path, "/api/auth/refresh", "the refresh did not precede the call");
    assert.equal(result.calls[1].path, "/api/email/send");
    assert.equal(result.calls[1].headers.authorization, "Bearer sa_rotated");
    assert.equal(JSON.parse(readFileSync(credentialsFile(it), "utf8")).profiles.default.refresh_token, "sr_rotated");
});

test("cell 41: an expired access token with a valid refresh refreshes, then calls", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const result = await run(it, ["paid"],
        (call) => (call.path === "/api/auth/refresh" ? rotated() : { status: 200, body: { ok: true } }),
        { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(result.code, 0, result.all);
    assert.equal(result.calls.filter((call) => call.path === "/api/auth/refresh").length, 1);
});

/* ── cells 42, 137, 138: the 401 table ─────────────────────────────── */

test("cell 42: 401 credential_expired refreshes once and replays once with the same call key", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    let sends = 0;
    const result = await run(it, ["paid", "--json"], (call) =>
    {
        if (call.path === "/api/auth/refresh")
        {
            return rotated();
        }
        sends += 1;
        // The replay is refused the same way, which is where "then give up"
        // has to hold: a second refresh would be a loop.
        return { status: 401, body: { code: "credential_expired", message: "expired" } };
    });
    assert.equal(result.code, 1);
    assert.equal(sends, 2, "the request was not replayed exactly once");
    assert.equal(result.calls.filter((call) => call.path === "/api/auth/refresh").length, 1, "more than one refresh");
    const keys = result.calls.filter((call) => call.path === "/api/email/send").map((call) => call.body.idempotencyKey);
    assert.equal(keys[0], keys[1], "the replay used a different call key, which would be a second charge");
});

for (const code of ["credential_invalid", "credential_required"])
{
    test(`cell 137: 401 ${code} is terminal — no refresh, no replay, the profile deleted`, async () =>
    {
        const it = box();
        installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
        const result = await run(it, ["paid", "--json"], (call) => (call.path === "/api/email/send"
            ? { status: 401, body: { code, message: "unknown credential" } }
            : { status: 200, body: {} }));
        assert.equal(result.code, 1);
        assert.equal(result.calls.filter((call) => call.path === "/api/auth/refresh").length, 0,
            "a refresh was burned on a credential the server has disowned");
        assert.equal(result.calls.filter((call) => call.path === "/api/email/send").length, 1,
            "the request was replayed");
        assert.equal(JSON.parse(readFileSync(credentialsFile(it), "utf8")).profiles.default, undefined,
            "the terminal profile was left on disk");
        assert.equal(jsonOf(result.out).error.code, "login_required");
    });
}

test("cell 138: a 401 during a keyless multipart deploy replays exactly once", async () =>
{
    const it = box();
    installFixture(it, { key: "deploy", verbs: ["deploy"], entry: deployPlugin() });
    let uploads = 0;
    const result = await run(it, ["deploy", "--json"], (call) =>
    {
        if (call.path === "/api/auth/refresh")
        {
            return rotated();
        }
        uploads += 1;
        return uploads === 1
            ? { status: 401, body: { code: "credential_expired", message: "expired" } }
            // The second answer is the server's own replay guard, which is what
            // deploy rests on instead of a call key. Exit 3, not a third upload.
            : { status: 409, body: { details: { code: "deploy_superseded", message: "a newer deploy won" } } };
    });
    assert.equal(result.code, 3, result.all);
    assert.equal(uploads, 2, "the upload was attempted more or fewer than twice");
    const error = jsonOf(result.out).error;
    assert.equal(error.code, "deploy_superseded");
    assert.equal(error.idempotency_key, undefined, "deploy sends no call key, so it must echo none");
});

/* ── cells 43–45: the terminal refresh outcomes ────────────────────── */

const TERMINAL = [
    { code: "refresh_expired", reason: "refresh_expired", cell: 43 },
    { code: "refresh_reuse_detected", reason: "reuse_detected", cell: 44 },
    { code: "refresh_revoked", reason: "refresh_revoked", cell: 45 }
];

for (const outcome of TERMINAL)
{
    test(`cell ${outcome.cell}: refresh ${outcome.code} is login_required reason ${outcome.reason}, profile deleted`, async () =>
    {
        const it = box();
        installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
        const result = await run(it, ["paid", "--json"],
            (call) => (call.path === "/api/auth/refresh"
                ? { status: 401, body: { code: outcome.code, message: "the refresh token is not usable" } }
                : { status: 200, body: {} }),
            { expiresAt: new Date(Date.now() - 60_000).toISOString() });
        assert.equal(result.code, 1);
        const error = jsonOf(result.out).error;
        assert.equal(error.code, "login_required");
        assert.equal(error.reason, outcome.reason);
        assert.equal(JSON.parse(readFileSync(credentialsFile(it), "utf8")).profiles.default, undefined,
            "the profile survived a terminal refresh refusal");
        assert.equal(existsSync(markerPath(it)), false, "a proven no-rotation outcome left the marker behind");
    });
}

test("cell 44: a reuse detection says what already happened, not just what to do", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const result = await run(it, ["paid", "--json"],
        (call) => (call.path === "/api/auth/refresh"
            ? { status: 401, body: { code: "refresh_reuse_detected", message: "this token was already used" } }
            : { status: 200, body: {} }),
        { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    assert.match(jsonOf(result.out).error.hint, /revoked/);
    assert.match(jsonOf(result.out).error.hint, /emailed/);
});

/* ── cells 46–47: scope ────────────────────────────────────────────── */

test("cell 46: a scope the credential does not carry is refused before any call", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const result = await run(it, ["paid", "--json"], () => ({ status: 200, body: {} }),
        { scopes: ["email.read"] });
    assert.equal(result.code, 1);
    const error = jsonOf(result.out).error;
    assert.equal(error.code, "insufficient_scope");
    assert.match(error.message, /email\.send/);
    assert.equal(result.calls.length, 0, "a call was made without the scope it needs");
});

test("cell 47: a server 403 scope_not_granted is insufficient_scope", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const result = await run(it, ["paid", "--json"],
        (call) => (call.path === "/api/email/send"
            ? { status: 403, body: { code: "scope_not_granted", message: "email.send is not granted" } }
            : { status: 200, body: {} }));
    assert.equal(result.code, 1);
    assert.equal(jsonOf(result.out).error.code, "scope_not_granted");
});

/* ── cells 48–49: the marker, and a profile that is not there ──────── */

test("cell 48: a matching pending marker blocks before any request is issued", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: {} }));
    try
    {
        writeCredential(it, { apiBase: rail.url, refresh: "sr_refresh_fixture" });
        writeMarkerFixture(it, { priorRefresh: "sr_refresh_fixture" });
        const result = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
        assert.equal(result.code, 1);
        const error = jsonOf(result.out).error;
        assert.equal(error.code, "login_required");
        assert.equal(error.reason, "refresh_interrupted");
        assert.equal(rail.calls.length, 0, "the possibly-rotated token was presented");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 49: --profile naming a profile that does not exist lists the ones that do", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    writeCredential(it, { profile: "default" });
    writeCredential(it, { profile: "ci" });
    const result = await selfAsync(it, it.demo, ["whoami", "--profile", "staging", "--json"], { SUPERSELF_DEV: "1" });
    assert.equal(result.code, 1);
    const error = jsonOf(result.out).error;
    assert.equal(error.code, "profile_not_found");
    assert.match(error.message, /default/);
    assert.match(error.message, /ci/);
});
