// Two sessions writing into one git-backed store (#444). Git's index takes one
// writer at a time, and the loser used to be told, in git's words, to remove a
// lock file a live process is holding — advice that would destroy the
// neighbour's commit, printed after this command's own receipt.
//
// The append is never what is at stake here: it is in `log.jsonl` before
// `commitAll` is reached, and whichever session commits next sweeps it in.
// Several events per commit is what decision 01kz57aqsxym2g2g8wasp6vv7j
// accepts, so the cells below are about the words and the exit status alone.
//
// The lock is a file this suite creates and holds rather than a second git
// racing this one: a real race answers differently on every machine, and what
// the table states is the outcome under a held lock. `store size`'s cell 27
// stages the same state the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_FILE } from "../dist/mode.js";
import { PENDING_FILE } from "../dist/pending.js";
import { demoWorkspace, idIn, machine, selfIn } from "./harness.mjs";

// The sentence the CLI says instead of git's. Written out here rather than
// imported, because what the cells are for is that this exact text reaches the
// reader — a constant shared with the implementation would assert nothing.
const HELD = "the store is being written by another session; this event is recorded "
    + "and will be committed with the next write";

// The retry is 300 ms, so a lock let go at 150 ms is gone before the second
// attempt and still standing at the first.
const RELEASE_MS = 150;

// A machine of its own per cell: a lock one cell holds is in the same store
// every later command would commit into.
async function scratch()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    return { box, ws, demo, lock: join(ws, ".superself", ".git", "index.lock") };
}

function storeDir(ws)
{
    return join(ws, ".superself");
}

function commitCount(ws)
{
    return execFileSync("git", ["-C", storeDir(ws), "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
}

function subject(ws)
{
    return execFileSync("git", ["-C", storeDir(ws), "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
}

function porcelain(ws)
{
    return execFileSync("git", ["-C", storeDir(ws), "status", "--porcelain"], { encoding: "utf8" }).trim();
}

function logText(ws, slug = "demo")
{
    return readFileSync(join(storeDir(ws), "projects", slug, "log.jsonl"), "utf8");
}

function saidTimes(out, line)
{
    return out.split("\n").filter((said) => said.includes(line)).length;
}

// The lock let go from outside this process. It has to be outside: the retry
// is a synchronous pause and git itself is `spawnSync`, so no timer of this
// runner's would fire while the command is in flight. The child announces
// itself before it starts counting, so the 150 ms is measured from a shell
// that is really running rather than from one still being started on a busy
// machine.
function releaseAfter(lock, ms)
{
    const child = spawn("sh", ["-c", `echo ready; sleep ${ms / 1000}; rm -f "$1"`, "sh", lock],
        { stdio: ["ignore", "pipe", "ignore"] });
    child.unref();
    return new Promise((ready) => child.stdout.once("data", () => ready()));
}

/* ── the cells ─────────────────────────────────────────────────────── */

test("1: a lock held for the whole run costs the commit and nothing else", async () =>
{
    const { box, ws, demo, lock } = await scratch();
    writeFileSync(lock, "");
    const before = commitCount(ws);
    const result = await selfIn(box, demo, ["state", "add", "written while the index was held"]);
    assert.equal(result.code, 0);
    assert.match(result.out, /entity\.confirmed recorded \[/);
    assert.equal(saidTimes(result.out, HELD), 1);
    assert.doesNotMatch(result.out, /index\.lock|manually/);
    // The lock is still standing, so nothing in this path removed it — which is
    // the whole of what git's advice would have had the reader do.
    assert.ok(existsSync(lock));
    assert.match(logText(ws), /written while the index was held/);
    assert.match(porcelain(ws), /log\.jsonl/);
    assert.equal(commitCount(ws), before);
    rmSync(lock);
});

test("2: a lock let go inside the retry window lands the event's own commit", async () =>
{
    const { box, ws, demo, lock } = await scratch();
    writeFileSync(lock, "");
    const before = Number(commitCount(ws));
    await releaseAfter(lock, RELEASE_MS);
    const result = await selfIn(box, demo, ["state", "add", "written while the index was let go"]);
    assert.equal(result.code, 0);
    assert.equal(saidTimes(result.out, HELD), 0);
    assert.equal(Number(commitCount(ws)), before + 1);
    assert.match(subject(ws), /^entity\.confirmed demo:/);
    assert.equal(porcelain(ws), "");
});

test("3: with no lock the run prints what it always printed", async () =>
{
    const { box, ws, demo } = await scratch();
    const before = Number(commitCount(ws));
    const result = await selfIn(box, demo, ["state", "add", "nothing is holding the index"]);
    assert.equal(result.code, 0);
    const id = idIn(result.printed);
    const entity = result.printed.trimEnd().split("\n").at(-1);
    assert.equal(result.printed,
        `entity.confirmed recorded [${id}]\n`
        + `  ${entity} nothing is holding the index — verify; wrong? self undo ${id}\n`
        + `${entity}\n`);
    assert.equal(Number(commitCount(ws)), before + 1);
    assert.equal(porcelain(ws), "");
});

test("4: a server-backed store queues the append and reads no lock at all", async () =>
{
    const { box, ws, demo, lock } = await scratch();
    const before = commitCount(ws);
    writeFileSync(join(storeDir(ws), WORKSPACE_FILE),
        JSON.stringify({ base: "https://app.superselfs.com", wsId: "ws_01J8LOCK", mode: "api" }) + "\n");
    writeFileSync(lock, "");
    const result = await selfIn(box, demo, ["state", "add", "queued while a stale lock lay in the store"]);
    assert.equal(result.code, 0);
    assert.equal(saidTimes(result.out, HELD), 0);
    assert.doesNotMatch(result.out, /index\.lock|manually/);
    assert.match(readFileSync(join(storeDir(ws), "projects", "demo", PENDING_FILE), "utf8"),
        /queued while a stale lock lay in the store/);
    assert.equal(commitCount(ws), before);
    rmSync(lock);
});

test("5: the lock is recognised in a locale whose git speaks another language", async () =>
{
    const { box, ws, demo, lock } = await scratch();
    writeFileSync(lock, "");
    const before = commitCount(ws);
    const result = await selfIn(box, demo, ["state", "add", "written under another locale"],
        { LC_ALL: "fr_FR.UTF-8", LANGUAGE: "fr", LANG: "fr_FR.UTF-8" });
    assert.equal(result.code, 0);
    assert.equal(saidTimes(result.out, HELD), 1);
    assert.doesNotMatch(result.out, /index\.lock|manually/);
    assert.equal(commitCount(ws), before);
    assert.match(logText(ws), /written under another locale/);
    rmSync(lock);
});
