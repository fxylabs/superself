// The sync lock, the one rewrite it guards, and what happens when they meet a
// foreground append (#424).
//
// The append path is deliberately outside this lock and stays outside it: one
// line added to a queue file is safe against another process doing the same,
// and recording work must never queue behind a network read. Everything below
// is about the consequence of that decision — a rewrite that has to be correct
// while somebody else is appending to the file it is replacing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactedPending } from "../dist/pending.js";
import { SYNC_LEASE_MS, SYNC_LOCK_FILE, acquireSyncLock, publishRewrite, releaseSyncLock, withSyncLock } from "../dist/synclock.js";
import { PULLER_LEASE_MS, pullEverySlug } from "../dist/puller.js";
import { PUSHER_LEASE_MS } from "../dist/pusher.js";
import { REQUEST_TIMEOUT_MS, RETRY_AFTER_CAP_MS } from "../dist/transport.js";
import { must, mustPerson, workIdIn } from "./harness.mjs";
import {
    ACCOUNT, connectedMachine, detachedEnv, eventually, queueAppend, storeDir, syncEnv, unsent
} from "./transport-lib.mjs";

function scratch()
{
    return mkdtempSync(join(tmpdir(), "self-sync-lock-"));
}

function lockFile(store)
{
    return join(store, SYNC_LOCK_FILE);
}

function heldSince(store, ageMs)
{
    writeFileSync(lockFile(store), JSON.stringify({
        pid: 999999,
        nonce: "a-holder-that-is-not-this-one",
        at: new Date(Date.now() - ageMs).toISOString()
    }));
}

/* ── one at a time ─────────────────────────────────────────────────── */

test("lock single-flight: a second taker gets nothing rather than waiting", () =>
{
    const store = scratch();
    const held = acquireSyncLock(store);
    assert.ok(held !== null);
    assert.equal(acquireSyncLock(store), null, "a person's command must not sit behind another process's network read");
    releaseSyncLock(store, held);
    assert.ok(acquireSyncLock(store) !== null, "and it is free again once the holder is done");
    rmSync(store, { recursive: true, force: true });
});

test("lock released: the file is gone after the work, whatever the work did", () =>
{
    const store = scratch();
    assert.throws(() => withSyncLock(store, () => { throw new Error("the work failed"); }), /the work failed/);
    assert.ok(!existsSync(lockFile(store)), "a failure inside the lock is not a lock nobody can take");
    rmSync(store, { recursive: true, force: true });
});

test("lock not-stolen: a holder younger than the lease keeps it", () =>
{
    const store = scratch();
    heldSince(store, SYNC_LEASE_MS / 2);
    assert.equal(acquireSyncLock(store), null);
    rmSync(store, { recursive: true, force: true });
});

test("lock stale: a holder past the lease is taken over", () =>
{
    const store = scratch();
    heldSince(store, SYNC_LEASE_MS + 60_000);
    assert.ok(acquireSyncLock(store) !== null, "a lock older than the longest a holder may live belongs to nobody");
    rmSync(store, { recursive: true, force: true });
});

test("lock lease-bound: the longest a sender may live is under the threshold that takes its lock", () =>
{
    // Not a number this cell chose — it is the reason "stale" is a fact rather
    // than an opinion. A sender enforces its own bound and stops; a lock older
    // than the threshold therefore belongs to a process that has already
    // stopped, and no heartbeat is needed to say so.
    assert.ok(PUSHER_LEASE_MS < SYNC_LEASE_MS,
        "a live sender could reach the age at which its lock is taken from it");
    // The catch-up is the other holder, and the claim is about every holder or
    // it is about none of them: a catch-up is one request per registered
    // project, so a store with enough projects is a live holder walking past
    // the age at which its lock is taken.
    assert.ok(PULLER_LEASE_MS < SYNC_LEASE_MS,
        "a live catch-up could reach the age at which its lock is taken from it");
});

test("lock bounded-by-its-parts: a sender cannot outlive its own lease by waiting on the network", () =>
{
    // The lease is a promise a sender keeps, so every wait it can be made to do
    // has to fit inside it. A `Retry-After` the server names is capped, and a
    // request that answers nothing is cut off — without both, a workspace could
    // hold a lock open past the age at which another process takes it.
    assert.ok(REQUEST_TIMEOUT_MS < PUSHER_LEASE_MS, "one request could outlast the whole run");
    assert.ok(RETRY_AFTER_CAP_MS + REQUEST_TIMEOUT_MS * 2 < PUSHER_LEASE_MS,
        "a wait the server asked for, plus the requests either side of it, could outlast the run");
});

test("lock unreadable: a lock file that names no holder is judged by its age", () =>
{
    const store = scratch();
    writeFileSync(lockFile(store), "half a record, as a crash mid-create leaves one");
    assert.equal(acquireSyncLock(store), null, "a lock written a moment ago is a lock somebody is holding");
    rmSync(store, { recursive: true, force: true });
});

/* ── the rewrite ───────────────────────────────────────────────────── */

test("rewrite carries: a line appended while the rewrite was deciding is kept", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "one\ntwo\n");
    const nonce = acquireSyncLock(store);
    // The foreground appends between the two reads, which is exactly the window
    // that has no lock in front of it.
    publishRewrite(store, file, nonce, (text) =>
    {
        writeFileSync(file, text + "three\n");
        return "kept\n";
    });
    assert.equal(readFileSync(file, "utf8"), "kept\nthree\n",
        "the replacement, and then whatever arrived while it was being worked out");
    rmSync(store, { recursive: true, force: true });
});

// The second window, and the one with no callback in it.
//
// `rewrite carries` above appends from the `rewrite` callback, which runs
// between the publish's two reads. The window this cell is about opens after
// the second read and closes when the rename lands, and everything between the
// two is one straight line of code — so racing an appender against it would be
// a case that passes whenever the race does not happen, which is a case that
// says nothing.
//
// What is in that straight line is the replacement being joined to the carried
// tail. A replacement that is an object rather than a string is asked for its
// text exactly there, once, after the second read and before the rename: the
// append made while it answers is in no read the publish has done, is not in
// the file it is about to write out, and is on the inode the rename is about to
// unlink. That is the whole of the window, entered on purpose and at a fixed
// point rather than by luck.
function appendsWhileItIsRead(file, line, text)
{
    return { toString: () => { appendFileSync(file, line); return text; } };
}

test("rewrite carries late tail: an append that lands after the last read and before the rename is kept", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "one\ntwo\n");
    const nonce = acquireSyncLock(store);
    assert.ok(publishRewrite(store, file, nonce, () => appendsWhileItIsRead(file, "late\n", "kept\n")));
    assert.deepEqual(readFileSync(file, "utf8").split("\n").filter((line) => line !== "").sort(),
        ["kept", "late"],
        "the record was written to a file the rename was about to unlink, and it is still a record");
    rmSync(store, { recursive: true, force: true });
});

test("rewrite carries late tail: every one of them, in a window as wide as writing the replacement out", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "history\n");
    const nonce = acquireSyncLock(store);
    const late = Array.from({ length: 200 }, (unused, index) => `late-${index}`);
    publishRewrite(store, file, nonce, () =>
        appendsWhileItIsRead(file, late.map((line) => `${line}\n`).join(""), "kept\n"));
    const kept = new Set(readFileSync(file, "utf8").split("\n"));
    assert.deepEqual(late.filter((line) => !kept.has(line)), [],
        "the loss this covers was always a run off the end of the file, never one line");
    rmSync(store, { recursive: true, force: true });
});

test("rewrite carries late tail: nothing is carried onto a publish that refused", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "the original\n");
    const nonce = acquireSyncLock(store);
    const published = publishRewrite(store, file, nonce, () =>
    {
        heldSince(store, 0);            // the lease ran out and somebody took it
        return appendsWhileItIsRead(file, "late\n", "rewritten\n");
    });
    assert.equal(published, false);
    assert.equal(readFileSync(file, "utf8"), "the original\nlate\n",
        "no rename happened, so the append is where it was written and is not there twice");
    rmSync(store, { recursive: true, force: true });
});

test("rewrite refuses: a file rewritten under the rewrite is left alone", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "one\ntwo\n");
    const nonce = acquireSyncLock(store);
    const published = publishRewrite(store, file, nonce, () =>
    {
        writeFileSync(file, "something else entirely\n");
        return "kept\n";
    });
    assert.equal(published, false);
    assert.equal(readFileSync(file, "utf8"), "something else entirely\n",
        "nothing is safe to publish over a file that is no longer the one that was read");
    rmSync(store, { recursive: true, force: true });
});

test("rewrite stolen: a holder whose lock was taken publishes nothing", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "the original\n");
    const nonce = acquireSyncLock(store);
    const published = publishRewrite(store, file, nonce, (text) =>
    {
        // The lease ran out and somebody else took it, which is the one case a
        // rename would be a writer acting on an authority it no longer has.
        heldSince(store, 0);
        return `rewritten from ${text}`;
    });
    assert.equal(published, false);
    assert.equal(readFileSync(file, "utf8"), "the original\n");
    assert.equal(readdirSync(store).filter((name) => name.includes(".tmp-")).length, 0,
        "and the half-written replacement is cleaned up rather than left to be found");
    rmSync(store, { recursive: true, force: true });
});

test("rewrite crash-safe: the original stands until the rename, so a crash costs nothing", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "the original\n");
    const nonce = acquireSyncLock(store);
    // A temp file left behind by a process that died before its rename, planted
    // after this holder took the lock so that the sweep below cannot be what
    // this cell is about. The publish writes its own, named by its own nonce,
    // and never reads this one.
    writeFileSync(`${file}.tmp-${"a".repeat(32)}`, "half a replacement");
    assert.equal(readFileSync(file, "utf8"), "the original\n");
    assert.ok(publishRewrite(store, file, nonce, () => "the replacement\n"));
    assert.equal(readFileSync(file, "utf8"), "the replacement\n");
    rmSync(store, { recursive: true, force: true });
});

test("lock sweeps: what a holder that died mid-publish left behind is gone at the next acquire", () =>
{
    const store = scratch();
    mkdirSync(join(store, "projects", "demo"), { recursive: true });
    // One of each: the temp a publish writes in the store root, the temp it
    // writes beside a project's queue, and the inode a steal renamed aside.
    const orphans = [
        join(store, `registry.jsonl.tmp-${"a".repeat(32)}`),
        join(store, "projects", "demo", `pending.jsonl.tmp-${"b".repeat(32)}`),
        join(store, `${SYNC_LOCK_FILE}.dead-${"c".repeat(32)}`)
    ];
    const kept = join(store, "projects", "demo", "pending.jsonl");
    orphans.forEach((path) => writeFileSync(path, "half a replacement"));
    writeFileSync(kept, "a record\n");
    const nonce = acquireSyncLock(store);
    assert.ok(nonce !== null);
    assert.deepEqual(orphans.filter((path) => existsSync(path)), [],
        "nothing ever reads a file named after a nonce nobody will draw again, so nothing but this removes it");
    assert.equal(readFileSync(kept, "utf8"), "a record\n", "and the files the store is made of are untouched");
    releaseSyncLock(store, nonce);
    rmSync(store, { recursive: true, force: true });
});

test("lock sweeps: a holder still working is not swept up by the holder that follows it", () =>
{
    const store = scratch();
    const first = acquireSyncLock(store);
    const mine = join(store, `registry.jsonl.tmp-${first}`);
    writeFileSync(mine, "a replacement being written right now");
    // The sweep runs inside the lock, at the moment a process becomes the
    // holder, and there is one holder at a time — so a second acquire while the
    // first is still working does not happen, and the file it is part-way
    // through writing cannot be swept out from under it.
    assert.equal(acquireSyncLock(store), null);
    assert.ok(existsSync(mine));
    releaseSyncLock(store, first);
    assert.ok(acquireSyncLock(store) !== null, "and the holder that follows a finished one does sweep it");
    assert.equal(existsSync(mine), false);
    rmSync(store, { recursive: true, force: true });
});

/* ── compaction ────────────────────────────────────────────────────── */

const APPEND = { append_id: "apx_gone", events: [{ id: "evt_gone" }] };
const STILL = { append_id: "apx_here", events: [{ id: "evt_here" }] };
const BLOCKED = { blocked: "apx_stuck", code: "actor_mismatch", at: "2026-08-31T00:00:00.000Z", detail: "another account" };

function queue(...rows)
{
    return rows.map((row) => JSON.stringify(row) + "\n").join("");
}

test("compaction drops: an append the workspace took, and the mark saying so, both go", () =>
{
    const compacted = compactedPending(queue(APPEND, { sent: "apx_gone" }, STILL));
    assert.deepEqual(compacted.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)), [STILL]);
});

test("compaction keeps: an unsent append and a refusal nobody has been told about stay", () =>
{
    const compacted = compactedPending(queue(APPEND, { sent: "apx_gone" }, STILL, BLOCKED));
    assert.deepEqual(compacted.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)), [STILL, BLOCKED]);
});

test("compaction settles: compacting twice is compacting once", () =>
{
    const text = queue(APPEND, { sent: "apx_gone" }, STILL, BLOCKED);
    assert.equal(compactedPending(compactedPending(text)), compactedPending(text));
});

test("compaction keeps unknown rows: a row a newer CLI wrote is not dropped by an older one", () =>
{
    const strange = { settlement: "apx_from_the_future" };
    const compacted = compactedPending(queue(STILL, strange));
    assert.match(compacted, /apx_from_the_future/,
        "dropping a row because its meaning is unfamiliar is how an older machine quietly downgrades a store");
});

/* ── V4: a sync and the foreground at the same time ────────────────── */

test("concurrent: records made while a sync is rewriting the queue are all still there", async (t) =>
{
    const { box, ws, demo, server } = await connectedMachine({ projects: [{ slug: "demo" }] });
    t.after(() => server.close());
    const store = storeDir(ws);
    // Twelve records made with the queue being compacted under them. The
    // compaction takes the lock, which the appends never ask for.
    const made = [];
    for (let round = 0; round < 12; round += 1)
    {
        made.push(workIdIn((await mustPerson(box, demo, ["work", "add", `unit ${round}`],
            { SUPERSELF_DEV: "1", SUPERSELF_SYNC: "off" })).out));
        withSyncLock(store, (nonce) => publishRewrite(store,
            join(store, "projects", "demo", "pending.jsonl"), nonce, compactedPending));
    }
    const queued = unsent(ws).flatMap((row) => row.events).map((one) => one.payload.text ?? one.payload.outcome);
    made.forEach((unused, round) => assert.ok(queued.some((text) => String(text).includes(`unit ${round}`)),
        `unit ${round} was made and is not in the queue`));
    assert.equal((await must(box, demo, ["work"], { SUPERSELF_SYNC: "off" })).out.match(/unit \d+/g)?.length, 12,
        "and the fold reads all twelve");
});

test("concurrent send: an append made while the queue is going out is sent by the next command", async (t) =>
{
    const { box, ws, demo, server } = await connectedMachine({ projects: [{ slug: "demo" }] });
    t.after(() => server.close());
    queueAppend(ws, { appendId: "apx_first" });
    await must(box, demo, ["project", "list"], syncEnv());
    queueAppend(ws, { appendId: "apx_second" });
    await must(box, demo, ["project", "list"], syncEnv());
    assert.equal(server.eventsIn("demo").length, 2, "neither append was lost to the other's round trip");
});

/* ── a holder stops where its lease does ───────────────────────────── */

test("pull lease-bound: a catch-up past its lease leaves the rest of the projects to the next command", async (t) =>
{
    const { ws, server } = await connectedMachine({ projects: [{ slug: "demo" }] });
    t.after(() => server.close());
    const store = storeDir(ws);
    // Built here rather than opened: `openSession` reads a credential out of
    // this process's own home, and what this cell is about is the loop, not
    // where its token came from.
    const session = { base: server.url, wsId: server.wsId, account: ACCOUNT, token: "a token the mock does not read" };
    const deltas = () => server.calls.filter((call) => call.method === "GET" && call.path.endsWith("/events")).length;

    const held = acquireSyncLock(store);
    await pullEverySlug(store, session, held, Date.now() + PULLER_LEASE_MS);
    assert.equal(deltas(), 1, "inside its lease a catch-up pulls the projects the registry lists");

    await pullEverySlug(store, session, held, Date.now() - 1);
    assert.equal(deltas(), 1, "and past it the projects it has not reached are left where they are");
    releaseSyncLock(store, held);
});

/* ── the background push cannot reach the caller ───────────────────── */

test("spawn refused: a sender that cannot be started does not take the command down with it", async (t) =>
{
    const { box, ws, demo, server } = await connectedMachine({ projects: [{ slug: "demo" }] });
    t.after(() => server.close());
    queueAppend(ws);
    // The sender is started with this process's own executable, so an
    // executable that is not there is a spawn that raises `error` rather than a
    // child that exits — EAGAIN and EMFILE arrive the same way, and are what
    // this is really about. The command has already printed its answer by then.
    const real = process.execPath;
    t.after(() => { process.execPath = real; });
    process.execPath = join(real, "..", "an-executable-that-is-not-there");

    const answer = await must(box, demo, ["project", "list"], detachedEnv());
    assert.equal(answer.code, 0, "a background push cannot change what the caller was told");
    assert.match(answer.out, /demo/, "and the answer itself is whole");
    // The event is raised on a later turn, so the failure this is about lands
    // here rather than after the case has ended. Unhandled, it is an uncaught
    // exception and this file does not finish.
    await new Promise((settled) => setImmediate(settled));
    await new Promise((settled) => setImmediate(settled));
});

/* ── the sender leaves nothing behind ──────────────────────────────── */

test("detached tidy: the process a command leaves behind releases the lock and ends", async (t) =>
{
    const { box, ws, demo, server } = await connectedMachine({ projects: [{ slug: "demo" }] });
    t.after(() => server.close());
    queueAppend(ws);
    await must(box, demo, ["project", "list"], { SUPERSELF_DEV: "1", SUPERSELF_SYNC: "on" });
    await eventually(() => server.eventsIn("demo").length === 1, "the queue went");
    await eventually(() => !existsSync(lockFile(storeDir(ws))),
        "the sender released the lock, which is how a run says it finished rather than being killed");
});
