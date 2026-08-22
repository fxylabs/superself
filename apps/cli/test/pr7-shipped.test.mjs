// Design §7.9 — the cells that exist only because of the route audit — plus
// §1.3's instrumented load budget.
//
// These are the places where the shipped rail is not what a reading of the
// approved contract would predict: a poll that reports "pending" with HTTP 200,
// a rate limiter that sends no code, five routes that reject an agent
// credential outright, and a console URL nobody populates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { machine } from "./harness.mjs";
import { consoleBaseOf } from "../dist/login.js";
import { localTimestamp } from "../dist/pretty.js";
import { runStructure } from "./structure.mjs";
import { installedPlugins, loadPlugin } from "../dist/plugins.js";
import {
    credentialsFile, installFixture, jsonLines, jsonOf, railEnv, railServer, selfAsync, writeCredential
} from "./pr7-lib.mjs";

function box()
{
    const created = machine();
    return { ...created, demo: created.root };
}

function railPlugin(path)
{
    return `export default function register(host)
{
    return [{
        name: "probe",
        usage: [{ syntax: "probe [--json]", description: ["fixture"], verbs: [""] }],
        detail: ["fixture", "", "  --json                machine-readable output"],
        node: host.contract.leaf("", { json: { type: "boolean" } }, 0, async () =>
        {
            const answer = await host.rail.request({
                method: "GET", path: ${JSON.stringify(path)}, scopes: ["wallet.read"]
            });
            return [host.output.payload(answer.body, () => ["ok"])];
        })
    }];
}
`;
}

/* ── cells 119–121: the poll shape the audit found ─────────────────── */

test("cell 119: authorization_pending arrives as HTTP 200 and is neither a success nor an error", async () =>
{
    const it = box();
    let polls = 0;
    const rail = await railServer((call) =>
    {
        if (call.path === "/api/device/start")
        {
            return {
                status: 200,
                body: {
                    device_code: "dc_x", user_code: "AAAA-BBBB",
                    verification_url: "https://console.example/device/approve",
                    expires_in: 30, interval: 1
                }
            };
        }
        polls += 1;
        // HTTP 200 with a `status` field. A client that reads 200 as "done"
        // finishes with no credential; one that reads it as an error gives up.
        return polls < 2
            ? { status: 200, body: { status: "authorization_pending" } }
            : {
                status: 200,
                body: {
                    status: "approved", account: "acct_01J8TEST", grant_id: "g",
                    access_token: "sa_a", refresh_token: "sr_a", scopes: ["wallet.read"],
                    expires_at: new Date(Date.now() + 3600_000).toISOString()
                }
            };
    });
    try
    {
        const result = await selfAsync(it, it.demo, ["login", "--json", "--no-open", "--api-base", rail.url], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        assert.equal(polls, 2);
        const lines = jsonLines(result.out);
        assert.equal(lines[0].status, "pending", "a 200 pending was reported as something else");
        assert.equal(lines[1].status, "approved");
    }
    finally
    {
        await rail.close();
    }
});

test("cells 120–121: the pacing comes only from the interval /start returned, and is never exceeded", async () =>
{
    const it = box();
    const at = [];
    const rail = await railServer((call) =>
    {
        if (call.path === "/api/device/start")
        {
            return {
                status: 200,
                body: {
                    device_code: "dc_x", user_code: "AAAA-BBBB",
                    verification_url: "https://console.example/device/approve",
                    // There is no `retry_after` on poll anywhere in the rail, so
                    // this number is the client's only source of pacing — and
                    // exceeding it five times permanently expires the grant.
                    expires_in: 30, interval: 2
                }
            };
        }
        at.push(Date.now());
        return at.length < 4
            ? { status: 200, body: { status: "authorization_pending" } }
            : {
                status: 200,
                body: {
                    status: "approved", account: "acct_01J8TEST", grant_id: "g",
                    access_token: "sa_a", refresh_token: "sr_a", scopes: ["wallet.read"],
                    expires_at: new Date(Date.now() + 3600_000).toISOString()
                }
            };
    });
    try
    {
        const result = await selfAsync(it, it.demo, ["login", "--json", "--no-open", "--api-base", rail.url], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        // Four polls inside a 30-second grant: the client paced itself by the
        // declared interval, and never spent one of the five violations that
        // would have destroyed the grant.
        assert.equal(at.length, 4);
        at.slice(1).forEach((moment, index) => assert.ok(moment - at[index] >= 1900,
            `polled ${moment - at[index]}ms apart, inside the 2s the server declared`));
    }
    finally
    {
        await rail.close();
    }
});

/* ── cell 126: five routes an agent credential cannot authenticate to ── */

for (const path of ["/api/wallet", "/api/landing/sites"])
{
    test(`cell 126: a 401 from the owner-session middleware on ${path} is not a login problem`, async () =>
    {
        const it = box();
        installFixture(it, { key: "probe", verbs: ["probe"], entry: railPlugin(path) });
        const rail = await railServer(() => ({
            status: 401,
            // What `@spfn/auth` actually answers: its own class name, no app
            // code, and a message about the token's shape — thrown before any
            // scope check runs.
            body: { error: { code: "UnauthorizedError", message: "Invalid token: missing keyId", requestId: "req_1" } }
        }));
        try
        {
            writeCredential(it, { apiBase: rail.url });
            const result = await selfAsync(it, it.demo, ["probe", "--json"], railEnv(rail));
            assert.equal(result.code, 1, result.all);
            const error = jsonOf(result.out).error;
            assert.equal(error.code, "agent_credential_not_accepted",
                "an agent was told to log in again for a route no credential it can obtain will ever open");
            assert.notEqual(error.code, "login_required");
            // The profile survives: nothing about it is wrong.
            assert.notEqual(JSON.parse(readFileSync(credentialsFile(it), "utf8")).profiles.default, undefined);
        }
        finally
        {
            await rail.close();
        }
    });
}

test("a 401 that names a code outside the credential vocabulary is unclassified, not mistaken for a session refusal", async () =>
{
    const it = box();
    installFixture(it, { key: "probe", verbs: ["probe"], entry: railPlugin("/api/agent/session") });
    const rail = await railServer(() => ({ status: 401, body: { code: "something_new", message: "unknown" } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["probe", "--json"], railEnv(rail));
        assert.equal(result.code, 1);
        assert.equal(jsonOf(result.out).error.reason, "unclassified_401");
    }
    finally
    {
        await rail.close();
    }
});

/* ── cell 127: the one cheap identity probe ────────────────────────── */

test("cell 127: whoami --verify spends exactly one GET /api/agent/session and checks the account", async () =>
{
    const it = box();
    const rail = await railServer(() => ({ status: 200, body: { account: "acct_01J8TEST", credential_id: "cred_1", scopes: [] } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["whoami", "--verify", "--json"], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        assert.equal(rail.calls.length, 1);
        assert.equal(rail.calls[0].path, "/api/agent/session");
        assert.equal(rail.calls[0].method, "GET");
        assert.equal(jsonOf(result.out).account, "acct_01J8TEST");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 127: a rail reporting a different account than the profile stores is a mismatch, not a silent pass", async () =>
{
    const it = box();
    const rail = await railServer(() => ({ status: 200, body: { account: "acct_somebody_else", scopes: [] } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["whoami", "--verify", "--json"], railEnv(rail));
        assert.equal(result.code, 1, result.all);
        assert.equal(jsonOf(result.out).error.code, "identity_mismatch");
    }
    finally
    {
        await rail.close();
    }
});

test("whoami is local, free and offline by default", async () =>
{
    const it = box();
    const rail = await railServer(() => ({ status: 500, body: {} }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["whoami", "--json"], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        assert.equal(rail.calls.length, 0, "the default whoami made a network call");
        const answer = jsonOf(result.out);
        assert.equal(answer.account, "acct_01J8TEST");
        assert.equal(answer.refresh_expires_at, undefined,
            "the CLI reported a refresh expiry the server never transmits");
    }
    finally
    {
        await rail.close();
    }
});

/* ── cell 128: the console base is derived, never guessed ──────────── */

test("cell 128: the console base is the verification URL minus /device/approve, and is omitted otherwise", () =>
{
    assert.equal(consoleBaseOf("https://app.superselfs.com/device/approve"), "https://app.superselfs.com");
    assert.equal(consoleBaseOf("https://console.example/device/approve"), "https://console.example");
    // A future server change that stops sending the suffix leaves the base
    // unset, and every synthesized console URL simply omitted.
    assert.equal(consoleBaseOf("https://app.superselfs.com/approve"), undefined);
    assert.equal(consoleBaseOf(""), undefined);
});

test("cell 128: a login stores the derived console base, and stores none when there is nothing to derive", async () =>
{
    for (const verification of ["https://console.example/device/approve", "https://console.example/verify"])
    {
        const it = box();
        const rail = await railServer((call) => (call.path === "/api/device/start"
            ? {
                status: 200,
                body: {
                    device_code: "dc_x", user_code: "AAAA-BBBB", verification_url: verification,
                    expires_in: 30, interval: 1
                }
            }
            : {
                status: 200,
                body: {
                    status: "approved", account: "acct_01J8TEST", grant_id: "g",
                    access_token: "sa_a", refresh_token: "sr_a", scopes: ["wallet.read"],
                    expires_at: new Date(Date.now() + 3600_000).toISOString()
                }
            }));
        try
        {
            const result = await selfAsync(it, it.demo, ["login", "--json", "--no-open", "--api-base", rail.url], railEnv(rail));
            assert.equal(result.code, 0, result.all);
            const profile = JSON.parse(readFileSync(credentialsFile(it), "utf8")).profiles.default;
            assert.equal(profile.console_base,
                verification.endsWith("/device/approve") ? "https://console.example" : undefined);
        }
        finally
        {
            await rail.close();
        }
    }
});

/* ── §1.3: the load budget, asserted rather than eyeballed ─────────── */

test("§1.3 budget: loading one plugin — signature, hash and import — stays under 50 ms at p95", async () =>
{
    const it = box();
    installFixture(it, { key: "probe", verbs: ["probe"], entry: railPlugin("/api/agent/session") });
    const previous = { ...process.env };
    Object.assign(process.env, it.env);
    try
    {
        const plugin = installedPlugins()[0];
        const context = {
            cliVersion: "0.7.0",
            session: { profile: "default", client: "self/0.7.0 contract/0" },
            railApi: "1",
            commandPath: () => "probe"
        };
        const samples = [];
        for (let round = 0; round < 40; round += 1)
        {
            const started = process.hrtime.bigint();
            await loadPlugin(plugin, context);
            samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        }
        samples.sort((left, right) => left - right);
        const p95 = samples[Math.floor(samples.length * 0.95)];
        assert.ok(p95 <= 50, `plugin load p95 is ${p95.toFixed(1)}ms, over the 50ms budget`);
    }
    finally
    {
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, previous);
    }
});

/* ── cell 110 and §7.10 N2: what a timestamp says, to whom ─────────── */

test("cell 110: every timestamp under --json is ISO 8601 UTC ending Z, unconditionally", async () =>
{
    const it = box();
    const expires = "2026-08-22T04:11:09.000Z";
    writeCredential(it, { expiresAt: expires });
    // Driven under a zone that is not UTC, because "unconditionally" is the
    // whole claim: the machine contract does not move with the machine.
    const result = await selfAsync(it, it.demo, ["whoami", "--json"], { SUPERSELF_DEV: "1", TZ: "Asia/Seoul" });
    assert.equal(result.code, 0, result.all);
    const answer = jsonOf(result.out);
    assert.equal(answer.access_expires_at, expires);
    assert.match(answer.access_expires_at, /Z$/);
    assert.equal(new Date(answer.access_expires_at).toISOString(), expires);
});

test("§7.10 N2 (ruling Q18): human mode localizes, with the offset spelled out", () =>
{
    // The half of decision `01m0j3ch` that exists for people is the half a bare
    // `…Z` drops. An offset is not decoration: a local time without one is
    // ambiguous the moment it is copied anywhere.
    const rendered = localTimestamp("2026-08-22T04:11:09Z");
    assert.match(rendered, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \([+-]\d{2}:\d{2}\)$/);
    assert.doesNotMatch(rendered, /Z$/);
    // A value that is not a timestamp is passed through rather than invented.
    assert.equal(localTimestamp("not a time"), "not a time");
});

test("cell 110: a human render shows the local time while --json shows UTC, for the same instant", async () =>
{
    const it = box();
    writeCredential(it, { expiresAt: "2026-08-22T04:11:09.000Z" });
    const human = await selfAsync(it, it.demo, ["whoami"], { SUPERSELF_DEV: "1", TZ: "Asia/Seoul" });
    assert.equal(human.code, 0, human.all);
    assert.match(human.out, /access expires 2026-08-22 13:11:09 \(\+09:00\)/);
    assert.doesNotMatch(human.out, /04:11:09Z/);
});

/* ── cell 115: the structure gate itself ───────────────────────────── */

test("cell 115: the tree passes every structure rule, and no export lost its importer", () =>
{
    const result = runStructure();
    assert.deepEqual(result.violations, [],
        result.violations.map((violation) => `${violation.file}:${violation.line} ${violation.rule} — ${violation.detail}`).join("\n"));
    assert.ok(result.deadGrowth <= 0, `${result.deadGrowth} exports gained no importer`);
});
