// Design §7.6 — concurrency and crash. Cells 93–100, 139–144, 153–156.
//
// This is the highest-risk client behaviour in the PR, because getting it wrong
// does not produce a broken command: it produces a `refresh_reuse_detected`,
// which revokes the whole grant chain and emails the owner a theft alert over
// what was really two parallel invocations or a power cut.
//
// Two shapes of test, chosen per cell. Where the property is about processes
// racing, real processes race. Where it is about a bound measured in minutes —
// the 10-minute absolute steal, the marker's 30-day TTL — the test runs
// in-process against the injected clock, because a suite that waits out a real
// ten minutes is a suite nobody runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { machine } from "./harness.mjs";
import {
    LOCK_ABSOLUTE_STEAL_MS, STALE_LOCK_MS, digest, ensurePrivateDir, processStart,
    replacePrivateFile, useClock, withCredentialLock, writeMarker, writePrivateFile
} from "../dist/credentials.js";
import { writePluginState } from "../dist/plugins.js";
import {
    configRoot, credentialsFile, installFixture, jsonOf, lockFile, markerPath, railEnv,
    railServer, selfAsync, writeCredential, writeMarkerFixture
} from "./pr7-lib.mjs";

function box()
{
    const created = machine();
    return { ...created, demo: created.root };
}

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
            return [host.output.payload(answer.body, () => ["sent"])];
        })
    }];
}
`;
}

function rotated(n = 1)
{
    return {
        status: 200,
        body: {
            status: "approved",
            access_token: `sa_rotated_${n}`,
            refresh_token: `sr_rotated_${n}`,
            scopes: ["email.send", "email.read", "email.domain.manage", "landing.deploy", "landing.read", "wallet.read"],
            expires_at: new Date(Date.now() + 3600_000).toISOString()
        }
    };
}

function expiring(rail)
{
    return { apiBase: rail.url, expiresAt: new Date(Date.now() + 10_000).toISOString() };
}

/* ── cells 93, 139: ten processes, one refresh ─────────────────────── */

test("cell 93: ten parallel invocations sharing an expiring credential produce exactly one refresh", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    let refreshes = 0;
    const rail = await railServer((call) =>
    {
        if (call.path !== "/api/auth/refresh")
        {
            return { status: 200, body: { ok: true } };
        }
        refreshes += 1;
        // The server's own reuse detection, standing in: presenting a token
        // that has already been rotated is what must never happen.
        return call.body.refresh_token === "sr_refresh_fixture"
            ? rotated()
            : { status: 401, body: { code: "refresh_reuse_detected", message: "already rotated" } };
    });
    try
    {
        writeCredential(it, expiring(rail));
        const runs = await Promise.all(Array.from({ length: 10 },
            () => selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail))));
        runs.forEach((run, index) => assert.equal(run.code, 0, `run ${index}: ${run.all}`));
        assert.equal(refreshes, 1, `${refreshes} refreshes for one expiring credential`);
        const detections = runs.filter((run) => run.all.includes("reuse_detected"));
        assert.equal(detections.length, 0, "a self-inflicted reuse detection");
        const sends = rail.calls.filter((call) => call.path === "/api/email/send");
        assert.equal(sends.length, 10);
        sends.forEach((call) => assert.equal(call.headers.authorization, "Bearer sa_rotated_1",
            "a process used a token other than the one refresh produced"));
    }
    finally
    {
        await rail.close();
    }
});

test("cell 139: two processes that both judge one lock stale produce exactly one refresh", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    let refreshes = 0;
    const rail = await railServer((call) =>
    {
        if (call.path !== "/api/auth/refresh")
        {
            return { status: 200, body: { ok: true } };
        }
        refreshes += 1;
        return call.body.refresh_token === "sr_refresh_fixture"
            ? rotated()
            : { status: 401, body: { code: "refresh_reuse_detected", message: "already rotated" } };
    });
    try
    {
        writeCredential(it, expiring(rail));
        // A lock left by a process that is provably gone, already past the
        // lease: both starters will judge it stealable at the same moment.
        writeFileSync(lockFile(it), JSON.stringify({
            pid: 999999, pid_start: "gone", nonce: "a".repeat(32),
            at: new Date(Date.now() - STALE_LOCK_MS - 5_000).toISOString()
        }), { mode: 0o600 });
        const runs = await Promise.all([
            selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail)),
            selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail))
        ]);
        runs.forEach((run) => assert.equal(run.code, 0, run.all));
        assert.equal(refreshes, 1, "both breakers refreshed");
        assert.equal(runs.filter((run) => run.all.includes("reuse_detected")).length, 0);
    }
    finally
    {
        await rail.close();
    }
});

/* ── cells 94–96: waiting, giving up, and stealing ─────────────────── */

test("cell 94/95: a lock held by a live process is waited for, then exit 3 refresh_lock_timeout", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, expiring(rail));
        // This test process is the live holder: its pid is alive and its start
        // time matches, so the lock is not stealable inside the lease.
        ensurePrivateDir(configRoot(it));
        writeFileSync(lockFile(it), JSON.stringify({
            pid: process.pid, pid_start: processStart(process.pid), nonce: "b".repeat(32),
            at: new Date().toISOString()
        }), { mode: 0o600 });
        const started = Date.now();
        const result = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
        const waited = Date.now() - started;
        assert.equal(result.code, 3, result.all);
        const error = jsonOf(result.out).error;
        assert.equal(error.code, "refresh_lock_timeout");
        assert.equal(error.retry_after_s, 5);
        assert.ok(waited >= 19_000, `gave up after ${waited}ms rather than waiting the 20s`);
        assert.equal(rail.calls.length, 0, "a call was made while another process held the credential");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 96: a lock past the lease whose owner is provably gone is stolen and the refresh proceeds", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const rail = await railServer((call) =>
        (call.path === "/api/auth/refresh" ? rotated() : { status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, expiring(rail));
        writeFileSync(lockFile(it), JSON.stringify({
            pid: 999999, pid_start: "gone", nonce: "c".repeat(32),
            at: new Date(Date.now() - STALE_LOCK_MS - 5_000).toISOString()
        }), { mode: 0o600 });
        const result = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        assert.equal(rail.calls.filter((call) => call.path === "/api/auth/refresh").length, 1);
        assert.equal(existsSync(lockFile(it)), false, "the stolen lock was not released");
    }
    finally
    {
        await rail.close();
    }
});

/* ── cells 97, 155: what an unfinished refresh leaves behind ───────── */

test("cell 97: an ambiguous refresh is not retried, and the marker is retained", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    let refreshes = 0;
    const rail = await railServer((call) =>
    {
        if (call.path !== "/api/auth/refresh")
        {
            return { status: 200, body: { ok: true } };
        }
        refreshes += 1;
        // The connection dies after the request was written: completion
        // unknown, so a rotation may already have happened.
        return { destroy: true };
    });
    try
    {
        writeCredential(it, { apiBase: rail.url, expiresAt: new Date(Date.now() - 60_000).toISOString() });
        const result = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
        assert.equal(result.code, 1, result.all);
        const error = jsonOf(result.out).error;
        assert.equal(error.code, "login_required");
        assert.equal(error.reason, "refresh_ambiguous");
        assert.equal(refreshes, 1, "the refresh was retried after an ambiguous response");
        assert.equal(existsSync(markerPath(it)), true, "the marker was removed on an outcome that proves nothing");
    }
    finally
    {
        await rail.close();
    }
});

for (const answer of [500, 502, 503, 504, 429])
{
    test(`cell 155: a refresh answered ${answer} retains the marker and is never retried`, async () =>
    {
        const it = box();
        installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
        let refreshes = 0;
        const rail = await railServer((call) =>
        {
            if (call.path !== "/api/auth/refresh")
            {
                return { status: 200, body: { ok: true } };
            }
            refreshes += 1;
            return { status: answer, body: { message: "not now" } };
        });
        try
        {
            writeCredential(it, { apiBase: rail.url, expiresAt: new Date(Date.now() - 60_000).toISOString() });
            const first = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
            assert.equal(first.code, 1, first.all);
            assert.equal(jsonOf(first.out).error.reason, answer === 429 ? "refresh_rate_limited" : "refresh_unavailable");
            assert.equal(existsSync(markerPath(it)), true, "a complete response from a server that may have rotated cleared the marker");

            // The next run re-evaluates the retained marker against the stored
            // token, and takes `refresh_interrupted` because it still matches.
            const second = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
            assert.equal(second.code, 1);
            assert.equal(jsonOf(second.out).error.reason, "refresh_interrupted");
            assert.equal(refreshes, 1, "the second run refreshed with a token that may already have rotated");
        }
        finally
        {
            await rail.close();
        }
    });
}

test("cell 140: each of the five 401 refusals removes the marker, and a login then works", async () =>
{
    for (const code of ["refresh_invalid", "refresh_revoked", "refresh_expired", "refresh_reuse_detected", "account_unavailable"])
    {
        const it = box();
        installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
        const rail = await railServer((call) => (call.path === "/api/auth/refresh"
            ? { status: 401, body: { code, message: "no" } }
            : { status: 200, body: { ok: true } }));
        try
        {
            writeCredential(it, { apiBase: rail.url, expiresAt: new Date(Date.now() - 60_000).toISOString() });
            const result = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
            assert.equal(result.code, 1, result.all);
            assert.equal(existsSync(markerPath(it)), false,
                `${code} left a marker, which wedges the CLI into permanent refresh_interrupted`);
        }
        finally
        {
            await rail.close();
        }
    }
});

/* ── cells 98, 141, 142, 153: the marker's own lifecycle ───────────── */

test("cell 98: a marker left by a crash after the response blocks and never presents the token", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, { apiBase: rail.url, refresh: "sr_pre_rotation" });
        writeMarkerFixture(it, { priorRefresh: "sr_pre_rotation" });
        const result = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
        assert.equal(result.code, 1);
        assert.equal(jsonOf(result.out).error.reason, "refresh_interrupted");
        assert.equal(rail.calls.length, 0, "the pre-rotation token was presented");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 141: a marker whose digest no longer matches is stale, deleted, and the command proceeds", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, { apiBase: rail.url, refresh: "sr_current" });
        writeMarkerFixture(it, { priorRefresh: "sr_the_one_before" });
        const result = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        assert.equal(existsSync(markerPath(it)), false, "the stale marker survived");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 142: a marker past its 30-day TTL is deleted and never wedges the CLI", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, { apiBase: rail.url, refresh: "sr_refresh_fixture" });
        writeMarkerFixture(it, {
            priorRefresh: "sr_refresh_fixture",
            at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
        });
        const result = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        assert.equal(existsSync(markerPath(it)), false);
    }
    finally
    {
        await rail.close();
    }
});

test("cell 153: an interrupted refresh on one profile survives every command on another", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true, account: "acct_01J8TEST" } }));
    try
    {
        writeCredential(it, { profile: "default", apiBase: rail.url, refresh: "sr_default" });
        writeCredential(it, { profile: "ci", apiBase: rail.url, refresh: "sr_ci" });
        writeMarkerFixture(it, { profile: "default", priorRefresh: "sr_default" });

        for (const args of [["whoami", "--verify", "--profile", "ci", "--json"], ["paid", "--json"]])
        {
            const run = await selfAsync(it, it.demo,
                args[0] === "paid" ? ["paid", "--json"] : args,
                { ...railEnv(rail), ...(args[0] === "paid" ? { SUPERSELF_PROFILE: "ci" } : {}) });
            assert.equal(run.code, 0, `${args.join(" ")}: ${run.all}`);
            assert.equal(existsSync(markerPath(it, "default")), true,
                "a command on ci deleted default's marker — the path to a false theft alert");
        }

        const blocked = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
        assert.equal(blocked.code, 1);
        assert.equal(jsonOf(blocked.out).error.reason, "refresh_interrupted");
        assert.equal(rail.calls.filter((call) => call.path === "/api/auth/refresh").length, 0,
            "a refresh happened on a blocked profile");
    }
    finally
    {
        await rail.close();
    }
});

/* ── cells 99–100, 143: modes, and a write that cannot land ────────── */

test("cell 99: a credential write that cannot land is credential_write_failed, with no refresh retry", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    let refreshes = 0;
    const rail = await railServer((call) =>
    {
        if (call.path !== "/api/auth/refresh")
        {
            return { status: 200, body: { ok: true } };
        }
        refreshes += 1;
        // Held open, so the directory can be closed while the request is in
        // flight — which is the moment a disk fills in the real case too.
        return new Promise((resolve) => setTimeout(() => resolve(rotated()), 400));
    });
    try
    {
        writeCredential(it, { apiBase: rail.url, expiresAt: new Date(Date.now() - 60_000).toISOString() });
        // The directory has to stay writable long enough for the lock and the
        // marker; only the credential write itself may fail. So it is closed
        // once the lock exists — 0500 is stricter than 0700, so the CLI's own
        // directory-mode enforcement leaves it alone (it only ever tightens).
        const closing = (async () =>
        {
            // Closed once the marker exists, so the write that fails is the
            // credential write *after* the server has already rotated — which
            // is the case this cell is about, and the one where the credential
            // is genuinely lost.
            while (!existsSync(markerPath(it)))
            {
                await new Promise((resolve) => setTimeout(resolve, 2));
            }
            chmodSync(configRoot(it), 0o500);
        })();
        const result = await selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
        await closing;
        chmodSync(configRoot(it), 0o700);
        assert.equal(result.code, 1, result.all);
        assert.match(result.all, /credential_write_failed|could not write/);
        assert.equal(refreshes, 1, "the refresh was retried after the server had already rotated");
    }
    finally
    {
        await rail.close();
    }
});

test("cells 100 and 143: every credential-path file is 0600 and its directory 0700, even at umask 000", () =>
{
    const it = box();
    const was = process.umask(0o000);
    const previousEnv = { ...process.env };
    Object.assign(process.env, it.env);
    const dir = configRoot(it);
    try
    {
        // `mode:` is masked by the umask and does nothing to a file that
        // already exists, so the modes are asserted on the writers themselves —
        // which is also the strongest form of the temp-file assertion, since
        // `replacePrivateFile`'s temp file is a file `writePrivateFile` made.
        ensurePrivateDir(dir);
        assert.equal(statSync(dir).mode & 0o077, 0, "the credential directory is readable by others");

        writePrivateFile(join(dir, "plain"), "x");
        assert.equal(statSync(join(dir, "plain")).mode & 0o077, 0);

        replacePrivateFile(join(dir, "credentials.json"), JSON.stringify({ version: 1, default: "d", profiles: {} }));
        assert.equal(statSync(credentialsFile(it)).mode & 0o077, 0);

        writeMarker("default", {
            version: 1, profile: "default", grant_id: "g",
            prior_refresh_sha256: digest("a"), prior_access_sha256: digest("b"), at: new Date().toISOString()
        });
        assert.equal(statSync(markerPath(it)).mode & 0o077, 0);

        writePluginState({ version: 1, plugins: {} });
        assert.equal(statSync(join(dir, "plugin-state.json")).mode & 0o077, 0);
    }
    finally
    {
        process.umask(was);
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, previousEnv);
    }
});

test("cell 100: the lock file is 0600 while it is held, at umask 000", async () =>
{
    const it = box();
    const was = process.umask(0o000);
    const previous = { ...process.env };
    try
    {
        Object.assign(process.env, it.env);
        await withCredentialLock("default", { waitMs: 1000 }, async () =>
        {
            assert.equal(statSync(lockFile(it)).mode & 0o077, 0, "the lock exposed the holder to other users");
        });
        assert.equal(existsSync(lockFile(it)), false, "the lock was not released");
    }
    finally
    {
        process.umask(was);
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, previous);
    }
});

/* ── cell 144: a process never unlinks a lock it does not own ──────── */

test("cell 144: a process that was stolen from releases nothing", async () =>
{
    const it = box();
    const previous = { ...process.env };
    try
    {
        Object.assign(process.env, it.env);
        ensurePrivateDir(configRoot(it));
        await withCredentialLock("default", { waitMs: 1000 }, async () =>
        {
            // The steal, as another process performs it: the inode is replaced
            // and the nonce on disk is now somebody else's.
            writeFileSync(lockFile(it), JSON.stringify({
                pid: process.pid, pid_start: processStart(process.pid), nonce: "d".repeat(32),
                at: new Date().toISOString()
            }), { mode: 0o600 });
        });
        assert.equal(existsSync(lockFile(it)), true,
            "the stolen-from process unlinked the lock its successor now holds");
        assert.equal(JSON.parse(readFileSync(lockFile(it), "utf8")).nonce, "d".repeat(32));
    }
    finally
    {
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, previous);
    }
});

/* ── cell 154: a live pid that is not the owner, and one that cannot be asked ── */

test("cell 154(a): a recycled pid is stolen from at the lease, on the start-time mismatch", async () =>
{
    const it = box();
    const previous = { ...process.env };
    try
    {
        Object.assign(process.env, it.env);
        ensurePrivateDir(configRoot(it));
        // Alive, and not the owner: this pid is running, but the start time
        // recorded belongs to a process that is gone.
        writeFileSync(lockFile(it), JSON.stringify({
            pid: process.pid, pid_start: "a start time from before the reboot", nonce: "e".repeat(32),
            at: new Date(Date.now() - STALE_LOCK_MS - 1000).toISOString()
        }), { mode: 0o600 });
        const started = Date.now();
        await withCredentialLock("default", { waitMs: 30_000 }, async () => undefined);
        assert.ok(Date.now() - started < 5_000, "a recycled pid was not stolen from at the lease");
    }
    finally
    {
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, previous);
    }
});

test("cell 154(b): a live, unstealable owner is waited out to the absolute bound and then stolen from", async () =>
{
    const it = box();
    const previous = { ...process.env };
    // The clock is injected rather than waited out: the bound is ten minutes,
    // and the property is that it exists and is finite, not that a suite can
    // sit through it.
    let at = Date.now();
    const restore = useClock(() => new Date(at));
    try
    {
        Object.assign(process.env, it.env);
        ensurePrivateDir(configRoot(it));
        writeFileSync(lockFile(it), JSON.stringify({
            // Alive, owned by this very process, so `kill(pid, 0)` succeeds and
            // the start time matches — the state that had no escape before the
            // absolute bound existed.
            pid: process.pid, pid_start: processStart(process.pid), nonce: "f".repeat(32),
            at: new Date(at - STALE_LOCK_MS - 1000).toISOString()
        }), { mode: 0o600 });
        const held = withCredentialLock("default", { waitMs: LOCK_ABSOLUTE_STEAL_MS + 60_000 }, async () => "stolen");
        // Advance past the absolute bound while the waiter polls.
        for (let step = 0; step < 40; step += 1)
        {
            at += 30_000;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(await held, "stolen", "a live, unstealable lock wedged refresh forever");
    }
    finally
    {
        restore(useClock(restore));
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, previous);
    }
});

/* ── cell 156: a login and a refresh writing the same profile ──────── */

test("cell 156(a): a login that lands during an in-flight refresh wins, and the rotated pair is discarded", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    let refreshing = null;
    const inFlight = new Promise((resolve) => { refreshing = resolve; });
    const rail = await railServer((call) =>
    {
        if (call.path !== "/api/auth/refresh")
        {
            return { status: 200, body: { ok: true } };
        }
        // The request is held open while the test plays the login's part, so
        // the rotation lands *after* the profile has been replaced.
        refreshing();
        return new Promise((resolve) => setTimeout(() => resolve(rotated()), 500));
    });
    try
    {
        writeCredential(it, { apiBase: rail.url, grant: "grant_old", expiresAt: new Date(Date.now() - 60_000).toISOString() });
        const command = selfAsync(it, it.demo, ["paid", "--json"], railEnv(rail));
        await inFlight;
        // What `self login` commits: a different grant, with its own pair.
        writeCredential(it, {
            apiBase: rail.url, grant: "grant_fresh_login",
            access: "sa_from_login", refresh: "sr_from_login"
        });
        await command;

        const stored = readFileSync(credentialsFile(it), "utf8");
        const profile = JSON.parse(stored).profiles.default;
        assert.equal(profile.grant_id, "grant_fresh_login", "the losing refresh clobbered a fresh login");
        assert.equal(profile.access_token, "sa_from_login");
        assert.equal(stored.includes("sr_rotated_1"), false, "the discarded rotated pair reached the file");
        assert.equal(existsSync(markerPath(it)), false, "the discarded refresh left its marker behind");
    }
    finally
    {
        await rail.close();
    }
});

test("a refresh whose connection was refused removes the marker — nothing was transmitted, so nothing rotated", async () =>
{
    const it = box();
    installFixture(it, { key: "paid", verbs: ["paid"], entry: keyedPlugin() });
    // A port that was listening and is not any more, so the connection is
    // genuinely refused rather than rejected as unusable before a socket was
    // ever opened. The distinction is the whole cell: a request that
    // demonstrably never reached the server cannot have rotated anything, so
    // holding the marker there forces a re-login for no reason at all.
    const closed = await railServer(() => ({ status: 200, body: {} }));
    await closed.close();
    writeCredential(it, { apiBase: closed.url, expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const result = await selfAsync(it, it.demo, ["paid", "--json"], { SUPERSELF_DEV: "1", SUPERSELF_NO_JOURNAL: "1" });
    assert.equal(result.code, 1, result.all);
    assert.equal(jsonOf(result.out).error.reason, "refresh_unavailable");
    assert.equal(existsSync(markerPath(it)), false, "a marker was kept for a request that never left the machine");
});

/* ── cell 156(b): a login against a live, unstealable lock ─────────── */

test("cell 156(b): a login waits out a live, unstealable owner and commits — the grant is never dropped", async () =>
{
    const it = box();
    const previous = { ...process.env };
    let at = Date.now();
    const restore = useClock(() => new Date(at));
    try
    {
        Object.assign(process.env, it.env);
        ensurePrivateDir(configRoot(it));
        // The state cell 154(b) names: past the lease, owned by a pid that is
        // alive and whose start time matches, so `kill(pid, 0)` proves nothing
        // and the ordinary steal rule refuses.
        writeFileSync(lockFile(it), JSON.stringify({
            pid: process.pid, pid_start: processStart(process.pid), nonce: "1".repeat(32),
            at: new Date(at - STALE_LOCK_MS - 1000).toISOString()
        }), { mode: 0o600 });

        let announced = 0;
        // The login's own options: no `waitMs` at all. That is the whole fix —
        // a login holds tokens a person just approved, and §1.5 permits exactly
        // one way for it to end without writing them, which is SIGINT.
        const committing = withCredentialLock("default", { onWait: () => { announced += 1; } },
            async () => "committed");
        for (let step = 0; step < 40 && at - Date.now() < LOCK_ABSOLUTE_STEAL_MS + 60_000; step += 1)
        {
            at += 30_000;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(await committing, "committed", "a login was blocked forever by a live, unstealable lock");
        assert.equal(announced, 1, "the wait was announced more or fewer than once");
    }
    finally
    {
        restore(useClock(restore));
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, previous);
    }
});

test("cell 156(b): lock churn cannot make a login give up — the regression the fix closes", async () =>
{
    const it = box();
    const previous = { ...process.env };
    let at = Date.now();
    const restore = useClock(() => new Date(at));
    try
    {
        Object.assign(process.env, it.env);
        ensurePrivateDir(configRoot(it));
        const write = (nonce) => writeFileSync(lockFile(it), JSON.stringify({
            pid: process.pid, pid_start: processStart(process.pid), nonce,
            at: new Date(at).toISOString()
        }), { mode: 0o600 });
        write("2".repeat(32));

        let refused = null;
        const committing = withCredentialLock("default", { onWait: () => undefined }, async () => "committed")
            .catch((error) => { refused = error; return "refused"; });

        // A succession of short-lived holders. Each writes a fresh `at`, so the
        // *lock's* age keeps restarting while the waiter's own elapsed time
        // keeps growing — which is exactly how a login measuring its own wait
        // reached the absolute bound and exited 3 with the tokens still in
        // hand. The waiter must not care how long it has personally waited.
        for (let step = 0; step < 60; step += 1)
        {
            at += 30_000;
            write(String(step % 10).repeat(32));
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        // Now let one lock actually age out, so the wait can end.
        for (let step = 0; step < 40; step += 1)
        {
            at += 30_000;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(await committing, "committed",
            `login gave up under lock churn: ${refused === null ? "" : refused.message}`);
        assert.equal(refused, null, "an approved grant was dropped by a timeout");
    }
    finally
    {
        restore(useClock(restore));
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, previous);
    }
});
