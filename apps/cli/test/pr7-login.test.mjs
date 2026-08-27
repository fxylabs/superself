// Design §7.2 — the device-flow client. Cells 22–35, 136 and 173–178.
//
// The rail here is a real loopback server, so the poll pacing these cells are
// about is the pacing the shipped transport actually produces. The interval is
// declared as one second rather than the production five, because the property
// under test is "never sooner than the interval the server declared", not the
// number itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoWorkspace, machine } from "./harness.mjs";
import {
    configRoot, credentialsFile, jsonLines, lockFile, markerPath, railEnv, railServer,
    selfAsync, writeCredential, writeMarkerFixture
} from "./pr7-lib.mjs";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));
const DEVICE_CODE = "dc_secret_device_code_value";

function box()
{
    const created = machine();
    return { ...created, demo: created.root };
}

// Every path under the store with its content digest. A credential is machine
// state, like `machine.json`, and none of it belongs in a synced record.
function storeSnapshot(workspace)
{
    const root = join(workspace, ".superself");
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path) : [`${path}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`];
    });
    return walk(root).sort();
}

// One scripted device flow: `n` pending polls, then whatever `then` says.
function deviceRail(script)
{
    const state = { polls: 0, at: [] };
    return {
        state,
        handler: (call) =>
        {
            if (call.path === "/api/device/start")
            {
                state.start = call;
                return {
                    status: 200,
                    body: {
                        device_code: DEVICE_CODE,
                        user_code: "K7QF-2M9X",
                        verification_url: "https://console.example/device/approve",
                        expires_in: script.expiresIn ?? 60,
                        interval: script.interval ?? 1
                    }
                };
            }
            if (call.path === "/api/device/poll")
            {
                state.polls += 1;
                state.at.push(Date.now());
                return script.poll(state.polls, call);
            }
            return { status: 404, body: {} };
        }
    };
}

function approved(extra = {})
{
    return {
        status: 200,
        body: {
            status: "approved",
            account: "acct_01J8TEST",
            grant_id: "grant_01J8TEST",
            access_token: "sa_new_access",
            refresh_token: "sr_new_refresh",
            scopes: ["email.send", "email.read", "email.domain.manage", "landing.deploy", "landing.read", "wallet.read"],
            expires_at: "2026-08-22T04:11:09Z",
            ...extra
        }
    };
}

async function login(it, args, script, extra = {})
{
    const device = deviceRail(script);
    const rail = await railServer(device.handler);
    try
    {
        const result = await selfAsync(it, it.demo, ["login", ...args],
            { ...railEnv(rail), SUPERSELF_API_BASE: rail.url });
        return { ...result, rail, device: device.state };
    }
    finally
    {
        await rail.close();
    }
}

// `--api-base` is what a login reads; the environment variable is its twin.
function base(rail)
{
    return ["--api-base", rail.url];
}

/* ── cells 22–23: pacing ───────────────────────────────────────────── */

test("cell 22: authorization_pending keeps polling at the declared interval", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open"], {
        interval: 1,
        poll: (n) => (n < 3 ? { status: 200, body: { status: "authorization_pending" } } : approved())
    });
    assert.equal(result.code, 0, result.all);
    assert.equal(result.device.polls, 3);
    const gaps = result.device.at.slice(1).map((at, index) => at - result.device.at[index]);
    gaps.forEach((gap) => assert.ok(gap >= 950, `polled after ${gap}ms, faster than the declared 1000ms`));
    // No output churn: one line per state, not one per poll.
    assert.equal(jsonLines(result.out).length, 2);
});

test("cell 23: slow_down raises the interval by 5s and the client never polls faster", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open", "--timeout", "20"], {
        interval: 1,
        poll: (n) => (n === 1 ? { status: 200, body: { status: "slow_down" } } : approved())
    });
    assert.equal(result.code, 0, result.all);
    const gap = result.device.at[1] - result.device.at[0];
    assert.ok(gap >= 5900, `polled ${gap}ms after a slow_down, inside the raised 6s interval`);
});

/* ── cells 24, 32–35: what a successful login writes ───────────────── */

test("cell 24: an approved login writes a 0600 credential in a 0700 directory, and appends no event", async () =>
{
    const created = machine();
    const it = { ...created, ...await demoWorkspace(created) };
    // The whole store, not one file: the project log does not exist until an
    // event is written, and "login writes no event" has to hold for the file
    // being created as much as for it growing.
    const before = storeSnapshot(it.ws);
    const result = await login(it, ["--no-open"], { poll: () => approved() });
    assert.equal(result.code, 0, result.all);
    assert.equal(statSync(credentialsFile(it)).mode & 0o077, 0);
    assert.equal(statSync(configRoot(it)).mode & 0o077, 0);
    assert.deepEqual(storeSnapshot(it.ws), before, "login wrote into the superself store");
});

test("cell 32: the device code is never printed, never written and never logged", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open"], { poll: () => approved() });
    assert.equal(result.code, 0, result.all);
    assert.equal(result.all.includes(DEVICE_CODE), false, "the device code reached the output");
    const stored = readFileSync(credentialsFile(it), "utf8");
    assert.equal(stored.includes(DEVICE_CODE), false, "the device code reached the credential file");
});

test("cell 33: --scopes narrows what is requested and what is stored", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open", "--scopes", "email.read"], {
        poll: () => approved({ scopes: ["email.read"] })
    });
    assert.equal(result.code, 0, result.all);
    assert.deepEqual(result.device.start.body.scopes, ["email.read"]);
    const file = JSON.parse(readFileSync(credentialsFile(it), "utf8"));
    assert.deepEqual(file.profiles.default.scopes, ["email.read"]);
});

test("cell 34: --profile writes that profile and never repoints an existing default", async () =>
{
    const it = box();
    writeCredential(it, { profile: "default", account: "acct_first" });
    const result = await login(it, ["--json", "--no-open", "--profile", "ci"], { poll: () => approved() });
    assert.equal(result.code, 0, result.all);
    const file = JSON.parse(readFileSync(credentialsFile(it), "utf8"));
    assert.equal(file.default, "default", "an agent's ambient identity was repointed by a second login");
    assert.equal(file.profiles.ci.account_id, "acct_01J8TEST");
    assert.equal(file.profiles.default.account_id, "acct_first");
});

test("cell 34: a login on a machine with no default sets one", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open", "--profile", "ci"], { poll: () => approved() });
    assert.equal(result.code, 0, result.all);
    assert.equal(JSON.parse(readFileSync(credentialsFile(it), "utf8")).default, "ci");
});

test("cell 35: login into an existing profile replaces it and clears only that profile's marker", async () =>
{
    const it = box();
    writeCredential(it, { profile: "default", access: "sa_old" });
    writeCredential(it, { profile: "ci", access: "sa_ci" });
    writeMarkerFixture(it, { profile: "default" });
    writeMarkerFixture(it, { profile: "ci" });
    const result = await login(it, ["--json", "--no-open"], { poll: () => approved() });
    assert.equal(result.code, 0, result.all);
    const file = JSON.parse(readFileSync(credentialsFile(it), "utf8"));
    assert.equal(file.profiles.default.access_token, "sa_new_access");
    assert.equal(file.profiles.ci.access_token, "sa_ci", "another profile was rewritten");
    assert.equal(existsSync(markerPath(it, "default")), false, "the profile's own marker survived its login");
    assert.equal(existsSync(markerPath(it, "ci")), true, "another profile's marker was deleted");
    assert.equal(existsSync(lockFile(it, "default")), false, "the lock was not released");
});

/* ── cells 25–27: the refusals ─────────────────────────────────────── */

test("cell 25: access_denied is exit 2 — the owner refused, and a retry never changes that", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open"], {
        poll: () => ({ status: 400, body: { code: "access_denied", message: "the owner denied this device" } })
    });
    assert.equal(result.code, 2);
    assert.equal(existsSync(credentialsFile(it)), false);
});

test("cell 26: expired_token is exit 1 device_code_expired", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open"], {
        poll: () => ({ status: 400, body: { code: "expired_token", message: "the device code expired" } })
    });
    assert.equal(result.code, 1);
    assert.match(result.all, /device_code_expired|expired/);
});

test("cell 27: the client --timeout gives up with login_timeout", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open", "--timeout", "2"], {
        interval: 1,
        expiresIn: 600,
        poll: () => ({ status: 200, body: { status: "authorization_pending" } })
    });
    assert.equal(result.code, 1);
    assert.match(result.all, /login_timeout|did not arrive in time/);
    assert.equal(existsSync(credentialsFile(it)), false);
});

/* ── cell 28: ctrl-c writes nothing ────────────────────────────────── */

test("cell 28: SIGINT while polling exits 1 login_cancelled and writes no file", async () =>
{
    const it = box();
    const device = deviceRail({ interval: 1, expiresIn: 600, poll: () => ({ status: 200, body: { status: "authorization_pending" } }) });
    const rail = await railServer(device.handler);
    try
    {
        const child = spawn(process.execPath, [bin, "login", "--json", "--no-open", ...base(rail)],
            { cwd: it.demo, env: { ...it.env, ...railEnv(rail) }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { err += chunk; });
        // Interrupt once the flow is genuinely in its polling loop, judged by
        // the rail having been polled rather than by a sleep — under a loaded
        // runner a fixed wait can land before the child has started.
        while (device.state.polls < 1)
        {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        child.kill("SIGINT");
        const code = await new Promise((resolve) => child.on("close", resolve));
        assert.equal(code, 1, `${out}${err}`);
        assert.match(`${out}${err}`, /login_cancelled|cancelled/);
        assert.equal(existsSync(credentialsFile(it)), false, "a cancelled login wrote a credential");
    }
    finally
    {
        await rail.close();
    }
});

/* ── cells 29–31: the output shape and the browser ─────────────────── */

test("cell 29: --json emits exactly two JSON lines, pending then approved", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open"], {
        poll: (n) => (n === 1 ? { status: 200, body: { status: "authorization_pending" } } : approved())
    });
    assert.equal(result.code, 0, result.all);
    const lines = jsonLines(result.out);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].status, "pending");
    assert.equal(lines[0].verification_url, "https://console.example/device/approve",
        "the verification URL was not echoed verbatim as the server sent it");
    assert.equal(lines[0].user_code, "K7QF-2M9X");
    assert.equal(lines[1].status, "approved");
    assert.equal(lines[1].account, "acct_01J8TEST");
});

// A fake browser opener on PATH, so "was a browser attempted" is answered by
// what actually ran rather than by a test-only branch in the product.
function fakeOpener(it)
{
    const dir = join(it.root, "fakebin");
    const witness = join(it.root, "opened");
    mkdirSync(dir, { recursive: true });
    for (const name of ["open", "xdg-open", "start"])
    {
        writeFileSync(join(dir, name), `#!/bin/sh\necho "$1" > ${JSON.stringify(witness)}\n`);
        chmodSync(join(dir, name), 0o755);
    }
    return { dir, witness };
}

test("cell 30: a person at a terminal gets a browser attempt", async () =>
{
    const it = box();
    const opener = fakeOpener(it);
    const device = deviceRail({ poll: () => approved() });
    const rail = await railServer(device.handler);
    const was = { tty: process.stdout.isTTY, env: { ...process.env } };
    try
    {
        // In-process, because "is stdout a terminal" is the whole condition and
        // a spawned child has no terminal to be.
        Object.assign(process.env, it.env, railEnv(rail), { PATH: `${opener.dir}:${process.env.PATH}` });
        process.stdout.isTTY = true;
        const { runCli } = await import("../dist/main.js");
        await runCli(["login", ...base(rail)]);
        assert.equal(existsSync(opener.witness), true, "no browser was attempted for a person at a terminal");
        assert.equal(readFileSync(opener.witness, "utf8").trim(), "https://console.example/device/approve");
    }
    finally
    {
        process.stdout.isTTY = was.tty;
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, was.env);
        process.exitCode = 0;
        await rail.close();
    }
});

test("cell 31: --json and a non-TTY never attempt a browser", async () =>
{
    const it = box();
    const opener = fakeOpener(it);
    const device = deviceRail({ poll: () => approved() });
    const rail = await railServer(device.handler);
    try
    {
        // Spawned, so stdout is a pipe: the non-TTY half. `--json` is asked for
        // as well, which is the other half of the same rule.
        const result = await selfAsync(it, it.demo, ["login", "--json", ...base(rail)],
            { ...railEnv(rail), PATH: `${opener.dir}:${process.env.PATH}` });
        assert.equal(result.code, 0, result.all);
        assert.equal(existsSync(opener.witness), false, "a browser was launched for a machine");
    }
    finally
    {
        await rail.close();
    }
});

/* ── cell 136: a failed poll is still a poll ───────────────────────── */

test("cell 136: a transport failure consumes its slot, never resets the timer, and notices once", async () =>
{
    const it = box();
    const device = deviceRail({
        interval: 2,
        poll: (n) => (n === 1 ? { status: 200, body: { status: "authorization_pending" } } : approved())
    });
    let dropped = 0;
    const rail = await railServer((call, index) =>
    {
        // The second poll's connection is destroyed rather than answered.
        if (call.path === "/api/device/poll" && device.state.polls === 2 && dropped === 0)
        {
            dropped += 1;
            return { status: 500, body: { fail: true }, destroy: true };
        }
        return device.handler(call, index);
    });
    try
    {
        const result = await selfAsync(it, it.demo, ["login", "--json", "--no-open", ...base(rail)], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        const gaps = device.state.at.slice(1).map((at, index) => at - device.state.at[index]);
        gaps.forEach((gap) => assert.ok(gap >= 1900,
            `polled ${gap}ms after the previous slot started — a failure shortened the timer`));
        assert.equal(jsonLines(result.out).length, 2, "a poll failure reached stdout");
    }
    finally
    {
        await rail.close();
    }
});

/* ── cells 173–178: the device-start body on the wire (#366) ───────── */

// A rail that refuses the device-start whenever `veto` says its body is wrong.
// Cells 176 and 177 each pass one condition, so a failure names which half of
// the contract broke rather than lighting up both.
async function pickyLogin(it, veto)
{
    const device = deviceRail({ poll: () => approved() });
    const rail = await railServer((call, index) =>
    {
        if (call.path === "/api/device/start" && veto(call.body ?? {}))
        {
            return { status: 400, body: { code: "invalid_request", message: "the device-start body is not the contract's" } };
        }
        return device.handler(call, index);
    });
    try
    {
        return await selfAsync(it, it.demo, ["login", "--json", "--no-open", ...base(rail)], railEnv(rail));
    }
    finally
    {
        await rail.close();
    }
}

test("cell 173: the device-start body is exactly { device_label, scopes }", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open"], { poll: () => approved() });
    assert.equal(result.code, 0, result.all);
    const body = result.device.start.body;
    assert.deepEqual(Object.keys(body).sort(), ["device_label", "scopes"], "the device-start body is not the two contract keys");
    assert.equal("label" in body, false, "the retired short key is still on the wire");
    assert.equal(typeof body.device_label, "string");
    assert.ok(body.device_label.endsWith(`@${hostname()}`), "the default label is not user@host");
});

test("cell 174: --label travels as device_label", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open", "--label", "my box"], { poll: () => approved() });
    assert.equal(result.code, 0, result.all);
    assert.equal(result.device.start.body.device_label, "my box");
    assert.equal("label" in result.device.start.body, false, "the retired short key is still on the wire");
});

test("cell 175: --scopes narrows the scopes and leaves device_label in place", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open", "--scopes", "email.send"], {
        poll: () => approved({ scopes: ["email.send"] })
    });
    assert.equal(result.code, 0, result.all);
    assert.deepEqual(result.device.start.body.scopes, ["email.send"]);
    assert.ok(result.device.start.body.device_label.length > 0, "narrowing the scopes dropped the label");
});

test("cell 176: a rail that requires device_label completes the login", async () =>
{
    const it = box();
    const result = await pickyLogin(it, (body) => typeof body.device_label !== "string");
    assert.equal(result.code, 0, result.all);
    assert.equal(existsSync(credentialsFile(it)), true, "a contract rail refused the login");
});

test("cell 177: a rail that refuses a bare label completes the login", async () =>
{
    const it = box();
    const result = await pickyLogin(it, (body) => "label" in body);
    assert.equal(result.code, 0, result.all);
    assert.equal(existsSync(credentialsFile(it)), true, "a rail that rejects the old key refused the login");
});

test("cell 178: the label sent and the label stored are one value", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open", "--label", "my box"], { poll: () => approved() });
    assert.equal(result.code, 0, result.all);
    const file = JSON.parse(readFileSync(credentialsFile(it), "utf8"));
    assert.equal(file.profiles.default.device_label, "my box");
    assert.equal(file.profiles.default.device_label, result.device.start.body.device_label);
});

test("a login with no --profile writes `default`, whatever the file's own default points at", async () =>
{
    const it = box();
    // A machine whose ambient identity is a named profile: a login with no flag
    // must still write `default`, not overwrite whichever account that pointer
    // happens to name.
    writeCredential(it, { profile: "ci", account: "acct_ci" });
    const result = await login(it, ["--json", "--no-open"], { poll: () => approved() });
    assert.equal(result.code, 0, result.all);
    const file = JSON.parse(readFileSync(credentialsFile(it), "utf8"));
    assert.equal(file.profiles.default.account_id, "acct_01J8TEST");
    assert.equal(file.profiles.ci.account_id, "acct_ci", "an unrelated profile was overwritten");
});

test("SUPERSELF_PROFILE selects the profile a login writes", async () =>
{
    const it = box();
    const device = deviceRail({ poll: () => approved() });
    const rail = await railServer(device.handler);
    try
    {
        const result = await selfAsync(it, it.demo, ["login", "--json", "--no-open", ...base(rail)],
            { ...railEnv(rail), SUPERSELF_PROFILE: "team_a" });
        assert.equal(result.code, 0, result.all);
        assert.equal(JSON.parse(readFileSync(credentialsFile(it), "utf8")).profiles.team_a.account_id, "acct_01J8TEST");
    }
    finally
    {
        await rail.close();
    }
});

test("a profile name that would escape the credential directory is refused before anything is written", async () =>
{
    const it = box();
    const device = deviceRail({ poll: () => approved() });
    const rail = await railServer(device.handler);
    try
    {
        const result = await selfAsync(it, it.demo, ["login", "--json", "--no-open", "--profile", "../escape", ...base(rail)],
            railEnv(rail));
        assert.equal(result.code, 1);
        assert.match(result.all, /is not a name/);
        assert.equal(device.state.polls, 0, "a device grant was spent on a name that could never be stored");
    }
    finally
    {
        await rail.close();
    }
});

test("--timeout takes seconds, and says so rather than waiting forever on nonsense", async () =>
{
    const it = box();
    const device = deviceRail({ poll: () => approved() });
    const rail = await railServer(device.handler);
    try
    {
        const result = await selfAsync(it, it.demo, ["login", "--json", "--no-open", "--timeout", "soon", ...base(rail)],
            railEnv(rail));
        assert.equal(result.code, 1);
        assert.match(result.all, /--timeout takes a number of seconds/);
    }
    finally
    {
        await rail.close();
    }
});

test("a 429 on poll is the IP limiter, not a refusal — the login backs off and keeps waiting", async () =>
{
    const it = box();
    const result = await login(it, ["--json", "--no-open", "--timeout", "40"], {
        interval: 1,
        // The rate limiter answers with no `code` at all. Terminating here
        // throws away a grant a person may be about to approve, over a limit
        // that clears on its own.
        poll: (n) => (n < 3 ? { status: 429, body: {} } : approved())
    });
    assert.equal(result.code, 0, result.all);
    assert.equal(result.device.polls, 3, "the login gave up instead of backing off");
    // Each 429 widens the interval by the same increment `slow_down` uses, so
    // the client never answers a rate limit by polling harder.
    const gaps = result.device.at.slice(1).map((at, index) => at - result.device.at[index]);
    gaps.forEach((gap) => assert.ok(gap >= 5900, `polled again after ${gap}ms, without widening`));
    assert.equal(jsonLines(result.out).length, 2, "the rate limit reached stdout");
    assert.match(result.err, /rate-limiting/);
});
