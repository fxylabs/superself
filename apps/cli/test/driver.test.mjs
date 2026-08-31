// The in-process CLI driver's own contract (#371). Everywhere else in the
// suite the driver is how a case reaches the CLI; here it is the subject.
//
// The standard it is held to is one sentence: it produces what a child process
// produced. The child was `execFileSync(node, [self.mjs, ...args], { cwd, env,
// stdio: ["ignore", "pipe", "pipe"] })`, so cwd, a complete environment and a
// stream that is not a terminal are what the cells below check, together with
// everything a command can leave behind in a process that is going to run the
// next one.
//
// Every case calls `drive` directly rather than `selfIn`, so this file asserts
// the in-process driver whichever driver the rest of the suite is running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drive, git, machine, workIdIn } from "./harness.mjs";
import { holdAppends } from "../dist/pipeline.js";
import { railEnv, railServer, selfAsync, writeCredential } from "./pr7-lib.mjs";

// The floor state, built the way `demoWorkspace` builds it and for the same
// reason: this order — a directory, a command, `git init`, another command —
// is cell 12's subject, so the fixture and the case are one thing.
async function scratch()
{
    const box = machine();
    const ws = join(box.root, "ws");
    const demo = join(ws, "demo");
    mkdirSync(demo, { recursive: true });
    await ok(box, ws, ["init"]);
    git(box, demo, ["init", "-q", "-b", "main"]);
    await ok(box, demo, ["project", "init", "--name", "demo", "--desc", "driver cells"]);
    return { box, ws, demo };
}

async function ok(box, cwd, args, options)
{
    const result = await drive(box, cwd, args, options);
    assert.equal(result.code, 0, result.out);
    return result;
}

/* ── cells 1–11: the driver path, command kind by command kind ─────── */

test("cell 1: a successful write answers 0 and reports the event it recorded", async () =>
{
    const { box, demo } = await scratch();
    const added = await ok(box, demo, ["work", "add", "ship phase 2"], { person: true });
    assert.match(added.out, /entity\.confirmed recorded \[[0-9a-z]+\]/);
    assert.match(added.out, /\bw-[0-9a-z]{5}\b/);
});

test("cell 2: a successful read answers 0 with the body it was asked for", async () =>
{
    const { box, demo } = await scratch();
    const work = workIdIn((await ok(box, demo, ["work", "add", "ship phase 2"], { person: true })).out);
    const shown = await ok(box, demo, ["work", "show", work]);
    assert.match(shown.out, /ship phase 2/);
});

test("cell 3: a refusal the CLI has a sentence for is exit 1 and says why", async () =>
{
    const { box, demo } = await scratch();
    const refused = await drive(box, demo, ["work", "show", "w-nope"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /unknown work id "w-nope"/);
});

// The two exit codes that need a rail to answer for them. Each runs the same
// command under whichever driver it is handed, so cells 4, 5 and 21 assert the
// same commands and cannot drift apart.
async function denied(it, run)
{
    const rail = await railServer((call) => (call.path === "/api/device/start"
        ? { status: 200, body: { device_code: "dc_x", user_code: "K7QF-2M9X", verification_url: "https://console.example/d", expires_in: 60, interval: 1 } }
        : { status: 400, body: { code: "access_denied", message: "the owner denied this device" } }));
    try
    {
        return await run(it, ["login", "--json", "--no-open"], { ...railEnv(rail), SUPERSELF_API_BASE: rail.url });
    }
    finally
    {
        await rail.close();
    }
}

async function unreachable(it, run)
{
    const rail = await railServer((call) => (call.path === "/api/plugins/trust" ? { destroy: true } : { status: 500, body: {} }), { trust: null });
    try
    {
        writeCredential(it.box, { apiBase: rail.url });
        return await run(it, ["app", "install", "email", "--json"], railEnv(rail));
    }
    finally
    {
        await rail.close();
    }
}

const driven = (it, args, extra) => drive(it.box, it.demo, args, { extra });

test("cell 4: a refusal by policy is exit 2", async () =>
{
    const refused = await denied(await scratch(), driven);
    assert.equal(refused.code, 2, refused.out);
    assert.equal(errorIn(refused.out).code, "access_denied");
});

test("cell 5: an unfinished call that is worth retrying is exit 3 and paces the retry", async () =>
{
    const held = await unreachable(await scratch(), driven);
    assert.equal(held.code, 3, held.out);
    assert.equal(errorIn(held.out).retry_after_s, 5);
});

test("cell 6: --json on a command that promises it answers parseable JSON", async () =>
{
    const { box, ws } = await scratch();
    const sized = await ok(box, ws, ["store", "size", "--json"]);
    assert.equal(typeof JSON.parse(sized.out).worktreeBytes, "number");
});

test("cell 7: a --json failure puts its envelope on stdout, not on stderr", async () =>
{
    const { box, ws } = await scratch();
    const refused = await drive(box, ws, ["whoami", "--json"]);
    assert.equal(refused.code, 1);
    assert.equal(errorIn(refused.out).code, "login_required");
});

// The fixture is the project marker rather than a damaged `log.jsonl`, which is
// what it used to be. A log line that will not parse now has a sentence of its
// own — it names the file and the line, because the log is a file a pull appends
// to and a truncated line is an ordinary thing to meet. What this cell is about
// is the driver's last resort, so it needs an error nothing has words for, and
// an unparseable `.self` is one.
test("cell 8: an error the CLI has no sentence for is exit 1 with the stack, as node would have printed it", async () =>
{
    const { box, demo } = await scratch();
    writeFileSync(join(demo, ".self"), "{not json\n");
    const crashed = await drive(box, demo, ["log"]);
    assert.equal(crashed.code, 1);
    assert.match(crashed.out, /SyntaxError/);
    assert.match(crashed.out, /at JSON\.parse/);
});

test("cell 9: a command that needs no workspace answers from anywhere", async () =>
{
    const box = machine();
    const version = await ok(box, box.root, ["--version"]);
    assert.match(version.out, /^\d+\.\d+\.\d+/);
});

test("cell 10: an unknown command is exit 1 and names the syntax", async () =>
{
    const { box, demo } = await scratch();
    const unknown = await drive(box, demo, ["flurb"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /unknown command 'flurb'/);
});

test("cell 11: a write from outside a registered project is refused with the remedy", async () =>
{
    const { box } = await scratch();
    const outside = join(box.root, "outside");
    mkdirSync(outside, { recursive: true });
    const refused = await drive(box, outside, ["work", "add", "nowhere"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /not inside a registered project/);
});

/* ── cells 12–19: what one command must not leave for the next ─────── */

test("cell 12: a git probe taken before a repository existed is not answered from again", async () =>
{
    const box = machine();
    const ws = join(box.root, "ws");
    const demo = join(ws, "demo");
    mkdirSync(demo, { recursive: true });
    // Asked while `demo` is a plain directory: the probe answers "no checkout
    // here" and would keep answering it for the life of the process.
    assert.equal((await drive(box, demo, ["project", "init", "--name", "demo", "--desc", "too early"])).code, 1);
    await ok(box, ws, ["init"]);
    git(box, demo, ["init", "-q", "-b", "main"]);
    await ok(box, demo, ["project", "init", "--name", "demo", "--desc", "driver cells"]);
});

test("cell 13: a record written by one call is read by the next", async () =>
{
    const { box, demo } = await scratch();
    const work = workIdIn((await ok(box, demo, ["work", "add", "written then read"], { person: true })).out);
    assert.match((await ok(box, demo, ["work", "show", work])).out, /written then read/);
});

test("cell 14: the home directory a refusal is judged against is the box making the call", async () =>
{
    const first = await scratch();
    const second = await scratch();
    // Refused because the text names a path under *that* box's home. If the
    // rule stayed on the first box's home, the second box's path reads as
    // recordable and the refusal is lost.
    const homePath = (it) => join(it.box.root, "home", "notes.txt");
    assert.match((await drive(first.box, first.demo, ["work", "add", homePath(first)], { person: true })).out, /absolute path under this machine's home/);
    assert.match((await drive(second.box, second.demo, ["work", "add", homePath(second)], { person: true })).out, /absolute path under this machine's home/);
});

test("cell 15: a --json call does not leave the next one in machine mode", async () =>
{
    const { box, ws } = await scratch();
    await ok(box, ws, ["store", "size", "--json"]);
    const human = await ok(box, ws, ["store", "size"]);
    assert.match(human.out, /^store /);
});

test("cell 16: an append hold left open by one command does not refuse the next one's write", async () =>
{
    const { box, demo } = await scratch();
    // Set directly rather than through a command that throws mid-collection:
    // the subject is the reset, and a fixture that depends on where an
    // exception happened to land would assert the exception instead.
    holdAppends(true);
    try
    {
        await ok(box, demo, ["work", "add", "recorded after a hold was left open"], { person: true });
    }
    finally
    {
        holdAppends(false);
    }
});

test("cell 17: the working directory is where it was before the call", async () =>
{
    const { box, demo } = await scratch();
    const was = process.cwd();
    await ok(box, demo, ["work", "add", "moves the process"], { person: true });
    assert.equal(process.cwd(), was);
});

test("cell 18: the environment is what it was before the call", async () =>
{
    const { box, demo } = await scratch();
    const was = { ...process.env };
    await ok(box, demo, ["work", "add", "replaces the environment"], { person: true });
    assert.deepEqual({ ...process.env }, was);
});

test("cell 19: a failed command does not leave this process exiting non-zero", async () =>
{
    const { box, demo } = await scratch();
    assert.equal((await drive(box, demo, ["work", "show", "w-nope"])).code, 1);
    assert.equal(process.exitCode ?? 0, 0);
});

/* ── cell 21: the number a real process leaves behind ──────────────── */

// The driver reads `process.exitCode` after the command sets it. A child turns
// that same field into the process's exit status, and nothing else in the
// suite watches the conversion once the cases stop spawning. Every code in the
// vocabulary is checked, under both drivers, against the same command.
test("cell 21: each exit code the driver reports is the status a real process exits with", async () =>
{
    const it = await scratch();
    const spawned = (that, args, extra) => selfAsync(that.box, that.demo, args, extra);
    const pairs = [
        ["0", await drive(it.box, it.demo, ["--version"]), await selfAsync(it.box, it.demo, ["--version"], {})],
        ["1", await drive(it.box, it.demo, ["flurb"]), await selfAsync(it.box, it.demo, ["flurb"], {})],
        ["2", await denied(it, driven), await denied(it, spawned)],
        ["3", await unreachable(it, driven), await unreachable(it, spawned)]
    ];
    assert.deepEqual(pairs.map(([, here]) => String(here.code)), ["0", "1", "2", "3"]);
    pairs.forEach(([expected, here, there]) => assert.equal(String(there.code), expected,
        `a child exited ${there.code} where the driver reported ${here.code}: ${there.all ?? there.out}`));
});

/* ── cell 27: two writes in one process ────────────────────────────── */

test("cell 27: two writes run back to back in one process, and neither waits on the other", async () =>
{
    const { box, demo } = await scratch();
    await ok(box, demo, ["work", "add", "first write"], { person: true });
    await ok(box, demo, ["work", "add", "second write"], { person: true });
});

/* ── cells 28–33: the environment and the terminal ─────────────────── */

// The retirement gate reads both axes at once: it refuses unless there is a
// terminal *and* no agent-session marker in the environment. That makes it the
// one command whose answer states what the driver handed it.
// The retirement the attempt wrote, read back off the project's own log.
function retirementIn(it)
{
    const file = join(it.ws, ".superself", "projects", "demo", "log.jsonl");
    return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .findLast((event) => event.type === "entity.retired");
}

async function retireAttempt(it, options)
{
    const work = workIdIn((await ok(it.box, it.demo, ["work", "add", "the gate's subject"], { person: true })).out);
    return drive(it.box, it.demo, ["work", "retire", work, "--why", "the outcome moved elsewhere"],
        { ...options, answer: options?.tty === true ? work : undefined });
}

test("cell 28: a session variable in the runner's own environment does not reach the command", async () =>
{
    const it = await scratch();
    process.env.SUPERSELF_SESSION = "the runner's own session";
    try
    {
        const retired = await retireAttempt(it, { tty: true });
        assert.equal(retired.code, 0, retired.out);
    }
    finally
    {
        delete process.env.SUPERSELF_SESSION;
    }
});

// The named session used to be read as "refuse this": the marker said nobody
// was behind the call. Since #400 it is read as "say who wrote this", which is
// the same fact reaching the same place by a shorter route.
test("cell 29: a session the caller names is one the command sees", async () =>
{
    const it = await scratch();
    const retired = await retireAttempt(it, { tty: true, extra: { SUPERSELF_SESSION: "sess-01" } });
    assert.equal(retired.code, 0, retired.out);
    assert.deepEqual(retirementIn(it).payload.by, { kind: "agent", session: "sess-01" });
});

test("cell 30: a key only the previous call's box carried is gone by the next call", async () =>
{
    const machined = await scratch();
    const plain = await scratch();
    machined.box.env.SUPERSELF_JSON = "1";
    assert.equal(typeof JSON.parse((await ok(machined.box, machined.ws, ["store", "size"])).out), "object");
    assert.match((await ok(plain.box, plain.ws, ["store", "size"])).out, /^store /);
});

test("cell 31: SUPERSELF_JSON=1 selects machine mode without a flag", async () =>
{
    const { box, ws } = await scratch();
    const machined = await ok(box, ws, ["store", "size"], { extra: { SUPERSELF_JSON: "1" } });
    assert.equal(typeof JSON.parse(machined.out).worktreeBytes, "number");
});

test("cell 32: a runner that has a terminal does not lend it to the command", async () =>
{
    const it = await scratch();
    const inWas = process.stdin.isTTY;
    const outWas = process.stdout.isTTY;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    try
    {
        const retired = await retireAttempt(it, {});
        assert.equal(retired.code, 0, retired.out);
        assert.deepEqual(retirementIn(it).payload.by, { kind: "agent" });
        assert.ok(!retired.out.includes("["), "the command's output carries terminal styling");
        assert.equal(process.stdin.isTTY, true, "the runner's own stdin was not put back");
        assert.equal(process.stdout.isTTY, true, "the runner's own stdout was not put back");
    }
    finally
    {
        process.stdin.isTTY = inWas;
        process.stdout.isTTY = outWas;
    }
});

test("cell 33: a caller that asks for a terminal gets one, and gives it back", async () =>
{
    const it = await scratch();
    const inWas = process.stdin.isTTY;
    const retired = await retireAttempt(it, { tty: true });
    assert.equal(retired.code, 0, retired.out);
    assert.match(retired.out, /entity\.retired recorded/);
    assert.equal(process.stdin.isTTY, inWas);
});

/* ── cell 34: the runtime half of the missing-await defence ────────── */

test("cell 34: a second command started on top of an unawaited one refuses, naming both", async () =>
{
    const { box, demo } = await scratch();
    const first = drive(box, demo, ["work", "add", "started and not awaited"]);
    await assert.rejects(() => drive(box, demo, ["status"]), (error) =>
    {
        assert.match(error.message, /was not awaited/);
        assert.match(error.message, /work add started and not awaited/);
        assert.match(error.message, /self status/);
        return true;
    });
    await first;
});

// The envelope a machine surface answers with, taken from the last line that
// is one: a run can say other things first, and the error object is the answer.
function errorIn(text)
{
    const line = text.trim().split("\n").filter((one) => one.startsWith("{")).pop();
    assert.ok(line !== undefined, `no JSON envelope in: ${text}`);
    return JSON.parse(line).error;
}
