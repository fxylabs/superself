// Two kinds of workspace store, one CLI.
//
// A store keeps its records in a git repository this machine commits, or on a
// workspace server this machine is logged in to. `.superself/workspace.json`
// says which, and the cells below are in two halves: what a server-backed store
// does differently, and what a git-backed one goes on doing exactly as it did.
//
// The second half is the load-bearing one. Every existing store in the world is
// git-backed and holds no `workspace.json`, so a mode read off anything looser
// than that file's presence would quietly reroute their appends into a queue no
// commit covers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "../dist/logfile.js";
import { WORKSPACE_FILE } from "../dist/mode.js";
import { PENDING_FILE, refuseOversizedAppend } from "../dist/pending.js";
import { demoWorkspace, git, machine, must, selfIn } from "./harness.mjs";
import { writeCredential } from "./pr7-lib.mjs";

const ACCOUNT = "acct_01J8STOREMODE";

// What `self goal add` writes. Named once so a cell asserting the queue holds
// the record reads about the record rather than about the vocabulary.
const GOAL_EVENT = "entity.confirmed";

// A workspace whose store is marked server-backed. The marker is written by
// hand because the flow that writes it is the connect flow, and what is under
// test here is every command's behaviour once it exists — not how it got there.
async function serverBackedWorkspace(box, options = {})
{
    const { ws, demo } = await demoWorkspace(box);
    if (options.account !== undefined)
    {
        writeCredential(box, { account: options.account });
    }
    writeFileSync(join(ws, ".superself", WORKSPACE_FILE),
        JSON.stringify({ base: "https://app.superselfs.com", wsId: "ws_01J8TEST", mode: "api" }) + "\n");
    return { ws, demo };
}

function storeDir(ws)
{
    return join(ws, ".superself");
}

function projectDir(ws, slug = "demo")
{
    return join(storeDir(ws), "projects", slug);
}

function pendingRows(ws, slug = "demo")
{
    const file = join(projectDir(ws, slug), PENDING_FILE);
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

function logRows(ws, slug = "demo")
{
    const file = join(projectDir(ws, slug), "log.jsonl");
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

function appendPendingLine(ws, row, slug = "demo")
{
    const file = join(projectDir(ws, slug), PENDING_FILE);
    writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + JSON.stringify(row) + "\n");
}

// A row of the server's own copy, written as a pull would leave it.
function appendLogLine(ws, event, slug = "demo")
{
    const file = join(projectDir(ws, slug), "log.jsonl");
    writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + JSON.stringify(event) + "\n");
}

// A second registered project in the same workspace, so a cell can say what one
// project's damage does to the answer about another.
async function secondProject(box, ws, slug)
{
    const dir = join(ws, slug);
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    await must(box, dir, ["project", "init", "--name", slug, "--desc", "the other project"]);
    return dir;
}

// Half a line, as a crash between two writes or a network read cut off mid
// record leaves one. Appended, because what is under test is a file that holds
// good records as well as this one.
function damage(file)
{
    writeFileSync(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + "{not json\n");
}

function storedEvent(id, type, payload)
{
    return { id, ts: "2026-08-30T00:00:00.000Z", type, origin: { actor: "agent", confirmed: false }, project: "demo", payload };
}

function commitCount(ws)
{
    return execFileSync("git", ["-C", storeDir(ws), "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
}

/* ── M. which mode a store is in ───────────────────────────────────── */

test("M1: a git-backed store writes its own log and opens no queue", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    const before = logRows(ws).length;
    await must(box, demo, ["goal", "add", "ship the thing"]);

    assert.equal(pendingRows(ws).length, 0, "a git-backed store must not queue an append");
    assert.equal(logRows(ws).length, before + 1, "the record belongs in the log itself");
});

test("M2: `workspace.json` in the store makes it server-backed — the append queues and the log is untouched", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    const before = logRows(ws).length;
    await must(box, demo, ["goal", "add", "ship the thing"]);

    assert.equal(logRows(ws).length, before, "the log is the server's copy and this machine does not write it");
    assert.equal(pendingRows(ws).length, 1, "the append is one queued row");
});

// The misreading this file exists to prevent. `workspace.json` decides the mode
// only where the store keeps it; the same name anywhere else is somebody's
// file, and a store that has never seen the connect flow is git-backed.
for (const [cell, where] of [["M3", (ws) => join(ws, WORKSPACE_FILE)],
    ["M4", (ws) => join(projectDir(ws), WORKSPACE_FILE)],
    ["M5", (ws) => join(storeDir(ws), "projects", WORKSPACE_FILE)]])
{
    test(`${cell}: a workspace.json outside the store root leaves the store git-backed`, async () =>
    {
        const box = machine();
        const { ws, demo } = await demoWorkspace(box);
        writeFileSync(where(ws), "{}\n");
        const before = logRows(ws).length;
        await must(box, demo, ["goal", "add", "ship the thing"]);

        assert.equal(pendingRows(ws).length, 0, "this store has no server behind it");
        assert.equal(logRows(ws).length, before + 1);
    });
}

test("M6: a store holding registry.jsonl and nothing new stays git-backed under every read verb", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    assert.ok(!existsSync(join(storeDir(ws), WORKSPACE_FILE)), "`self init` writes no marker");
    await must(box, demo, ["goal", "add", "ship the thing"]);

    for (const args of [["log"], ["context"], ["status"], ["project"], ["store", "size"]])
    {
        assert.equal((await selfIn(box, demo, args)).code, 0, `self ${args.join(" ")} answers in a git-backed store`);
    }
});

// `self setup` is the verb a person runs when they are not sure what this
// machine is pointed at, so describing a server-backed store in git's words —
// "0 commits, no remote" — reported a healthy store as a broken one.
test("M7: `self setup` names which kind of store this is", async () =>
{
    const box = machine();
    const { demo } = await demoWorkspace(box);
    const gitBacked = await must(box, demo, ["setup"]);
    assert.match(gitBacked.out, /store .*\(git-backed, \d+ commits/);

    const other = machine();
    const server = await serverBackedWorkspace(other);
    const serverBacked = await must(other, server.demo, ["setup"]);
    assert.match(serverBacked.out, /store .*\(server-backed\)/);
    assert.doesNotMatch(serverBacked.out, /commits/, "a store with no git history is not described by one");
});

/* ── A. the queue, and the log read back off it ────────────────────── */

test("A1: one append is one queued row carrying its own id and its events", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await must(box, demo, ["goal", "add", "ship the thing"]);

    const [row] = pendingRows(ws);
    assert.equal(typeof row.append_id, "string");
    assert.ok(row.append_id.length > 0, "the row names the append it is");
    assert.equal(row.events.length, 1);
    assert.equal(row.events[0].type, GOAL_EVENT);
});

test("A2: a record written into a server-backed store is read back by the log", async () =>
{
    const box = machine();
    const { demo } = await serverBackedWorkspace(box);
    await must(box, demo, ["goal", "add", "ship the thing"]);

    assert.match((await must(box, demo, ["log"])).out, new RegExp(GOAL_EVENT));
});

test("A3: the server's copy and the unsent tail read as one log, the server's copy first", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    appendLogLine(ws, storedEvent("01SERVERONE", "goal.set", { text: "from the server" }));
    await must(box, demo, ["goal", "add", "from this machine"]);

    const read = readEvents(storeDir(ws), "demo").map((event) => event.id);
    assert.equal(read[0], "01SERVERONE", "what the workspace already agreed on stands first");
    assert.equal(read.length, 2);
    assert.notEqual(read[1], "01SERVERONE");
});

test("A4: an append the server has taken is read off the log rather than the queue", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await must(box, demo, ["goal", "add", "ship the thing"]);
    const [row] = pendingRows(ws);
    appendPendingLine(ws, { sent: row.append_id });

    assert.deepEqual(readEvents(storeDir(ws), "demo"), [], "the queue no longer answers for it");
});

test("A5: an append the server refused for good is out of the read", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await must(box, demo, ["goal", "add", "ship the thing"]);
    const [row] = pendingRows(ws);
    appendPendingLine(ws, { blocked: row.append_id, code: "actor_mismatch", at: "2026-08-31T00:00:00.000Z" });

    assert.deepEqual(readEvents(storeDir(ws), "demo"), [],
        "a record the workspace will never hold must not be read as one it does");
});

test("A6: an event in the queue and in the server's copy is read once", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await must(box, demo, ["goal", "add", "ship the thing"]);
    const [row] = pendingRows(ws);
    appendLogLine(ws, row.events[0]);

    const read = readEvents(storeDir(ws), "demo");
    assert.equal(read.length, 1, "one act is one record however many files hold it");
});

test("A7: a server-backed store with no queue file yet answers every read", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    assert.ok(!existsSync(join(projectDir(ws), PENDING_FILE)), "a store just connected has queued nothing");

    for (const args of [["log"], ["context"], ["status"], ["project"], ["state"], ["work"]])
    {
        assert.equal((await selfIn(box, demo, args)).code, 0, `self ${args.join(" ")} answers with no queue file`);
    }
});

test("A8: events written as one state change queue as one row", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    const first = await must(box, demo, ["goal", "add", "the first plan"]);
    const id = first.out.match(/\[([^\]]+)\]/)[1];
    await must(box, demo, ["goal", "add", "the plan that corrects it", "--supersedes", id]);

    const rows = pendingRows(ws);
    assert.equal(rows.length, 2, "two appends, two rows — and never one append split across two");
    assert.ok(rows.every((row) => row.events.length >= 1));
});

// The duplicate lives in the queue alone, which is the case a set taken off the
// server's copy cannot see: a machine that crashed between sending an append and
// marking it sent resends it, and both rows are unsent as far as this file says.
test("A9: one event id in two queued appends is read once", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await must(box, demo, ["goal", "add", "ship the thing"]);
    const [row] = pendingRows(ws);
    appendPendingLine(ws, { append_id: `${row.append_id}X`, events: row.events });

    assert.equal(pendingRows(ws).length, 2, "the fixture is two appends carrying one event id");
    assert.equal(readEvents(storeDir(ws), "demo").length, 1, "one act is one record however many rows carry it");
});

/* ── C. what a commit covers ───────────────────────────────────────── */

test("C1: an append into a server-backed store adds no commit", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    const before = commitCount(ws);
    await must(box, demo, ["goal", "add", "ship the thing"]);
    await must(box, demo, ["fold"]);
    await must(box, demo, ["alias", "add", "risk"]);

    assert.equal(commitCount(ws), before, "the queue is what records the change, not a commit");
});

test("C2: an append into a git-backed store still commits", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    const before = Number(commitCount(ws));
    await must(box, demo, ["goal", "add", "ship the thing"]);

    assert.ok(Number(commitCount(ws)) > before, "a git-backed store records the change as a commit");
});

/* ── L. what one append may carry ──────────────────────────────────── */

const OVERSIZED_TEXT = "x".repeat(300 * 1024);

// The context tier a long record would otherwise overflow, measured out of the
// way. What a tier holds is a separate limit with a separate refusal, and a
// cell about the size of an append has to reach the append to say anything.
async function unbudgetedText(box, cwd)
{
    await must(box, cwd, ["tokens", "1", "1000000"]);
}

test("L1: an event whose payload is over the limit is refused, and the refusal says how to get through", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await unbudgetedText(box, demo);
    const refused = await selfIn(box, demo, ["goal", "add", OVERSIZED_TEXT]);

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /one event may carry 256KB/);
    assert.match(refused.out, /self artifact add/);
    assert.match(refused.out, /smaller pieces/);
    assert.equal(pendingRows(ws).length, 0, "a refused append is not queued");
});

test("L2: an append of more than a thousand events is refused, and names splitting as the way through", () =>
{
    const events = Array.from({ length: 1001 }, (ignored, index) => storedEvent(`01EVENT${index}`, "goal.set", { text: "x" }));
    assert.throws(() => refuseOversizedAppend(events), /1001 events .*may carry 1000/s);
    assert.throws(() => refuseOversizedAppend(events), /several smaller commands/);
});

test("L3: an append over a megabyte is refused even where no single event is", () =>
{
    // Eight events of 200KB each: every payload is inside the per-event limit
    // and the append is not.
    const events = Array.from({ length: 8 },
        (ignored, index) => storedEvent(`01BULK${index}`, "goal.set", { text: "x".repeat(200 * 1024) }));
    events.forEach((event) => assert.ok(JSON.stringify(event.payload).length < 256 * 1024));
    assert.throws(() => refuseOversizedAppend(events), /this append is \d+KB and an append may carry 1024KB/);
});

test("L4: a thousand events exactly is not over the limit", () =>
{
    const events = Array.from({ length: 1000 }, (ignored, index) => storedEvent(`01EVENT${index}`, "goal.set", { text: "x" }));
    assert.doesNotThrow(() => refuseOversizedAppend(events));
});

test("L5: a git-backed store applies no such limit — its records are bounded by nothing but git", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    await unbudgetedText(box, demo);
    const before = logRows(ws).length;
    assert.equal((await selfIn(box, demo, ["goal", "add", OVERSIZED_TEXT])).code, 0);
    assert.equal(logRows(ws).length, before + 1);
});

/* ── G. the verbs that only mean something against git ─────────────── */

const GIT_ONLY = [
    ["G1", ["remote", "add", "https://example.invalid/store.git"], /remote add/],
    ["G2", ["sync"], /self sync/],
    ["G3", ["store", "size"], /store size/],
    ["G4", ["store", "compact"], /store compact/],
    ["G5", ["clone", "https://example.invalid/store.git", "elsewhere"], /self clone/]
];

for (const [cell, args, names] of GIT_ONLY)
{
    test(`${cell}: \`self ${args.slice(0, 2).join(" ")}\` is refused in a server-backed store, and says why`, async () =>
    {
        const box = machine();
        const { demo } = await serverBackedWorkspace(box);
        const refused = await selfIn(box, demo, args);

        assert.notEqual(refused.code, 0, `self ${args.join(" ")} must not run against a server-backed store`);
        assert.match(refused.out, names, "the refusal names the verb the caller ran");
        assert.match(refused.out, /server-backed and has none/);
    });
}

test("G6: `self init` in a server-backed store is refused rather than answered as a no-op", async () =>
{
    const box = machine();
    const { ws } = await serverBackedWorkspace(box);
    const refused = await selfIn(box, ws, ["init"]);

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /server-backed workspace store/);
    assert.match(refused.out, /one store is one or the other/);
});

test("G7: every one of them still works in a git-backed store", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);

    assert.equal((await selfIn(box, demo, ["store", "size"])).code, 0);
    assert.equal((await selfIn(box, demo, ["store", "compact"])).code, 0);
    assert.equal((await selfIn(box, demo, ["remote", "add", "https://example.invalid/store.git"])).code, 0);
    assert.match((await must(box, ws, ["init"])).out, /already initialized/);
});

/* ── W. who the log says wrote it ──────────────────────────────────── */

test("W1: a record written into a server-backed store names the account that wrote it", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box, { account: ACCOUNT });
    await must(box, demo, ["goal", "add", "ship the thing"]);

    assert.deepEqual(pendingRows(ws)[0].events[0].actor, { account: ACCOUNT });
});

test("W2: a git-backed store's log bytes are what they always were — no account reaches them", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    writeCredential(box, { account: ACCOUNT });
    await must(box, demo, ["goal", "add", "ship the thing"]);

    assert.ok(logRows(ws).every((event) => event.actor === undefined),
        "an account this machine is logged in to says nothing about a store git alone carries");
});

test("W3: a machine logged in to nothing still records — the author is absent, the work is not refused", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await must(box, demo, ["goal", "add", "ship the thing"]);

    assert.equal(pendingRows(ws)[0].events[0].actor, undefined);
});

test("W4: the account survives a scope that drops the directory's own project", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box, { account: ACCOUNT });
    await must(box, demo, ["goal", "add", "the whole workspace's direction", "--workspace"]);

    const written = pendingRows(ws).flatMap((row) => row.events);
    assert.ok(written.length > 0, "the workspace scope wrote into a project's queue");
    assert.ok(written.every((event) => event.actor?.account === ACCOUNT));
});

test("W5: the account is read once at the entry point, so a second command reads it again", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await must(box, demo, ["goal", "add", "written before logging in"]);
    writeCredential(box, { account: ACCOUNT });
    await must(box, demo, ["goal", "add", "written after logging in"]);

    const written = pendingRows(ws).flatMap((row) => row.events);
    assert.equal(written[0].actor, undefined);
    assert.deepEqual(written[1].actor, { account: ACCOUNT });
});

// The archive path builds its own narrowed context, because the event belongs to
// the named project's log while the branch stamp belongs to this directory. It
// has to drop the same two fields every other narrowing drops and no more: an
// archive recorded from the wrong checkout still has somebody who recorded it.
test("W6: archiving a project from another project's checkout still names the account", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box, { account: ACCOUNT });
    await secondProject(box, ws, "other");
    await must(box, demo, ["project", "archive", "other", "--why", "not this quarter"]);

    const written = pendingRows(ws, "other").flatMap((row) => row.events);
    assert.ok(written.some((event) => event.type === "project.archived"), "the archive landed in the named project's queue");
    assert.ok(written.every((event) => event.actor?.account === ACCOUNT));
});

/* ── the queue file itself ─────────────────────────────────────────── */

test("Q1: a queue line that will not parse stops the read and names the file", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await must(box, demo, ["goal", "add", "ship the thing"]);
    appendPendingLine(ws, "not json");
    writeFileSync(join(projectDir(ws), PENDING_FILE),
        readFileSync(join(projectDir(ws), PENDING_FILE), "utf8").replace('"not json"', "{not json"));

    const refused = await selfIn(box, demo, ["log"]);
    assert.notEqual(refused.code, 0, "records nobody has sent yet are not silently skipped");
    assert.match(refused.out, /pending\.jsonl line 2 is not readable as JSON/);
});

test("Q2: the store directory is made where it is missing, so the first append has somewhere to queue", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    mkdirSync(join(storeDir(ws), "projects", "spare"), { recursive: true });
    await must(box, demo, ["goal", "add", "ship the thing"]);

    assert.ok(existsSync(join(projectDir(ws), PENDING_FILE)));
});

// A workspace-wide answer folds every project's log. One project's queue nobody
// has looked at in a month must not be the reason the other four cannot be read
// — and the line that says so has to be actionable, since there is no repair
// command to point at.
test("Q3: one project's damaged queue leaves the rest of the workspace readable", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await secondProject(box, ws, "other");
    await must(box, demo, ["goal", "add", "ship the thing"]);
    damage(join(projectDir(ws, "other"), PENDING_FILE));

    const answered = await selfIn(box, demo, ["status"]);
    assert.equal(answered.code, 0, "the project that reads is still answered for");
    assert.match(answered.out, /project "other" is left out of this answer/);
    assert.match(answered.out, /pending\.jsonl line 1 is not readable as JSON/);
    assert.match(answered.out, /take the line out/, "the sentence says what to do, since no command repairs it");
});

// The other half of the same rule, and the one that keeps it honest. A command
// about a project reads that project's own log, so damage there is the loud
// refusal it has always been — answering out of a log that would not read is
// exactly the quiet wrong answer the isolation above must not buy.
test("Q4: the same damage under a command about that project itself is still refused", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    await must(box, demo, ["goal", "add", "ship the thing"]);
    damage(join(projectDir(ws), PENDING_FILE));

    for (const args of [["work"], ["status"], ["log"], ["context"]])
    {
        const refused = await selfIn(box, demo, args);
        assert.notEqual(refused.code, 0, `self ${args.join(" ")} must not answer out of a log it could not read`);
        assert.match(refused.out, /pending\.jsonl line 2 is not readable as JSON/);
    }
});

// The server's copy gets the queue file's treatment, and needs it more: this is
// the file a pull appends to, so a read cut off mid-record leaves exactly this.
test("Q5: a damaged line in the server's copy stops the read and names the file and line", async () =>
{
    const box = machine();
    const { ws, demo } = await serverBackedWorkspace(box);
    appendLogLine(ws, storedEvent("01SERVERONE", "goal.set", { text: "from the server" }));
    damage(join(projectDir(ws), "log.jsonl"));

    const refused = await selfIn(box, demo, ["log"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /log\.jsonl line 2 is not readable as JSON/);
    assert.match(refused.out, /take the line out/);
});

/* ── E. the entry point ────────────────────────────────────────────── */

// Who this machine is logged in as is read on the way into a command, which
// means it is read on the way into `--version` unless it is placed after the
// two questions that are about the binary rather than about a workspace.
test("E1: `--version` answers on a machine whose pointer will not parse", async () =>
{
    const box = machine();
    await demoWorkspace(box);
    writeFileSync(join(box.env.XDG_CONFIG_HOME, "superself", "machine.json"), "{not json\n");

    const answered = await selfIn(box, box.root, ["--version"]);
    assert.equal(answered.code, 0, "a question about the binary needs no readable pointer");
    assert.match(answered.out, /^\d+\.\d+\.\d+/);
});

test("E2: a command that needs the pointer refuses in a sentence rather than a stack", async () =>
{
    const box = machine();
    await demoWorkspace(box);
    writeFileSync(join(box.env.XDG_CONFIG_HOME, "superself", "machine.json"), "{not json\n");

    const refused = await selfIn(box, box.root, ["status"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /machine\.json is not readable as JSON/);
    assert.match(refused.out, /self workspace/, "the sentence names the way back");
    assert.doesNotMatch(refused.out, /SyntaxError/);
});

// A caller who named a profile stated an intention about whose records these
// are. Recording them under nobody without a word is the failure they would
// find out about last.
test("E3: a named profile that does not resolve says so, once", async () =>
{
    const box = machine();
    const { demo } = await serverBackedWorkspace(box, { account: ACCOUNT });

    const answered = await selfIn(box, demo, ["goal", "add", "ship the thing"], { SUPERSELF_PROFILE: "nobody" });
    assert.equal(answered.code, 0, "a missing account is never a reason to refuse the work");
    assert.equal(answered.out.match(/records no account/g).length, 1, "one line, not one per read");
    assert.match(answered.out, /profile "nobody"/);
});

test("E4: a machine logged in to nothing says nothing about it", async () =>
{
    const box = machine();
    const { demo } = await serverBackedWorkspace(box);

    const answered = await selfIn(box, demo, ["goal", "add", "ship the thing"]);
    assert.equal(answered.code, 0);
    assert.doesNotMatch(answered.out, /records no account/,
        "not being logged in is the ordinary state of a machine, not news");
});

/* ── N. a store with no git repository at all ──────────────────────── */

// The shape a real connected store has. Everything above works on a store that
// was made git-backed and then marked, which is the fixture that proves the
// mode gate — and it leaves a `.git` sitting there for anything that forgot to
// ask. These cells take it away.
async function noGitWorkspace(box, options = {})
{
    const made = await serverBackedWorkspace(box, options);
    rmSync(join(storeDir(made.ws), ".git"), { recursive: true, force: true });
    return made;
}

test("N1: a server-backed store with no git repository records and reads", async () =>
{
    const box = machine();
    const { ws, demo } = await noGitWorkspace(box, { account: ACCOUNT });
    await must(box, demo, ["goal", "add", "ship the thing"]);

    assert.deepEqual(pendingRows(ws)[0].events[0].actor, { account: ACCOUNT });
    for (const args of [["log"], ["context"], ["status"], ["project"], ["state"], ["work"], ["fold"]])
    {
        assert.equal((await selfIn(box, demo, args)).code, 0, `self ${args.join(" ")} answers with no git repository`);
    }
});

test("N2: a record written into a store with no git repository is undone there", async () =>
{
    const box = machine();
    const { ws, demo } = await noGitWorkspace(box);
    const written = await must(box, demo, ["goal", "add", "ship the thing"]);
    const id = written.out.match(/\[([^\]]+)\]/)[1];
    await must(box, demo, ["undo", id, "--why", "recorded against the wrong plan"]);

    const events = readEvents(storeDir(ws), "demo");
    assert.ok(events.some((event) => event.refs?.annuls === id), "the undo is a record like any other");
});

test("N3: a project is registered in a store with no git repository", async () =>
{
    const box = machine();
    const { ws } = await noGitWorkspace(box);
    const second = join(ws, "second");
    mkdirSync(second, { recursive: true });
    await must(box, second, ["project", "init", "--name", "second"]);

    assert.match((await must(box, second, ["project"])).out, /second/);
});
