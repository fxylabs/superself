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
import {
    appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compactedPending } from "../dist/pending.js";
import { SYNC_LEASE_MS, SYNC_LOCK_FILE, acquireSyncLock, publishRewrite, releaseSyncLock } from "../dist/synclock.js";
import { PULLER_LEASE_MS, pullEverySlug } from "../dist/puller.js";
import { invalidateResolution } from "../dist/paths.js";
import { PUSHER_LEASE_MS } from "../dist/pusher.js";
import { REQUEST_TIMEOUT_MS, RETRY_AFTER_CAP_MS } from "../dist/transport.js";
import { must, mustPerson, workIdIn } from "./harness.mjs";
import {
    ACCOUNT, connectedMachine, detachedEnv, event, eventually, logRows, queueAppend, storeDir, syncEnv, unsent
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

// The holder's own record, aged where it lies. Not a second holder and not a
// forged nonce: this is the wall clock stepping forward under a process that is
// still working, which `synclock.ts` documents above `stale` and which is the
// one way a live holder's lock reads as stale.
function theClockStepsPast(store)
{
    const record = JSON.parse(readFileSync(lockFile(store), "utf8"));
    writeFileSync(lockFile(store), JSON.stringify({
        ...record,
        at: new Date(Date.now() - SYNC_LEASE_MS - 60_000).toISOString()
    }));
}

// A file dated back the same way, for the cases about what a sweep may remove.
function agedTo(path, ageMs)
{
    utimesSync(path, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
}

// The lock a piece of work takes for itself, released whatever the work did.
// Both real holders do this inline because the work they do has an `await` in
// it and a `finally` around a promise releases before the promise settles.
function underTheLock(store, work)
{
    const nonce = acquireSyncLock(store);
    if (nonce === null)
    {
        return null;
    }
    try
    {
        return work(nonce);
    }
    finally
    {
        releaseSyncLock(store, nonce);
    }
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
    assert.throws(() => underTheLock(store, () => { throw new Error("the work failed"); }), /the work failed/);
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
//
// `noted` is how the cell says which side of the publish it was on rather than
// trusting the paragraph above. At the moment the append lands, no temp file
// exists yet — the publish has not written one — so a refactor that wrote the
// replacement out first and joined the tail afterwards would stop entering this
// window and would say so here instead of passing quietly. It is a minimum: it
// pins "before the temp was written" and not "after the second read", which
// nothing observable from inside the callback can distinguish.
function appendsWhileItIsRead(file, line, text, noted = {})
{
    return { toString: () =>
    {
        noted.tempWasThere = readdirSync(dirname(file)).some((name) => name.includes(".tmp-"));
        appendFileSync(file, line);
        return text;
    } };
}

test("rewrite carries late tail: an append that lands after the last read and before the rename is kept", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "one\ntwo\n");
    const nonce = acquireSyncLock(store);
    const noted = {};
    assert.ok(publishRewrite(store, file, nonce, () => appendsWhileItIsRead(file, "late\n", "kept\n", noted)));
    assert.equal(noted.tempWasThere, false, "the append has to land before the replacement is written out or this "
        + "cell is asserting the window it already has a case for");
    assert.deepEqual(readFileSync(file, "utf8").split("\n").filter((line) => line !== "").sort(),
        ["kept", "late"],
        "the record was written to a file the rename was about to unlink, and it is still a record");
    rmSync(store, { recursive: true, force: true });
});

test("rewrite carries late tail: half a line left on the old inode is not fused onto the next one", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "one\n");
    const nonce = acquireSyncLock(store);
    // A large append is the one an appender can be observed part-way through
    // (`synclock.ts`, the fifth property): what the tail read finds is whole
    // lines and then the beginning of one more.
    assert.ok(publishRewrite(store, file, nonce, () => appendsWhileItIsRead(file, "late\nhalf-a-l", "kept\n")));
    assert.equal(readFileSync(file, "utf8"), "kept\nlate\n",
        "a queue with one damaged line in it is a file its reader tells a person to repair by hand");
    rmSync(store, { recursive: true, force: true });
});

test("rewrite refuses a torn read: a file that does not end at a line ending is left alone", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "one\ntwo");
    const nonce = acquireSyncLock(store);
    assert.equal(publishRewrite(store, file, nonce, () => "kept\n"), false,
        "a read that stops inside a line is a read with records past its end, and the rename would drop them");
    assert.equal(readFileSync(file, "utf8"), "one\ntwo", "the original stands, which is what makes this a pass lost "
        + "and not a record");
    // And the refusal is a pass rather than a state: the next read of a file
    // that ends where a line ends publishes.
    appendFileSync(file, "\n");
    assert.ok(publishRewrite(store, file, nonce, () => "kept\n"));
    assert.equal(readFileSync(file, "utf8"), "kept\n");
    rmSync(store, { recursive: true, force: true });
});

test("rewrite refuses: a file created while the rewrite ran is not written over", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    const nonce = acquireSyncLock(store);
    // Nothing was there to open, so both reads are empty and the comparison the
    // publish makes proves nothing about the file that exists by the end.
    const published = publishRewrite(store, file, nonce, () =>
    {
        writeFileSync(file, "a record made while the rewrite ran\n");
        return "rewritten\n";
    });
    assert.equal(published, false);
    assert.equal(readFileSync(file, "utf8"), "a record made while the rewrite ran\n",
        "an empty read is not permission to write over whatever turned up");
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
    // As old as the lock of a holder nobody would wait for any longer, which is
    // the whole of what says these belong to nobody.
    orphans.forEach((path) => agedTo(path, SYNC_LEASE_MS + 60_000));
    writeFileSync(kept, "a record\n");
    const nonce = acquireSyncLock(store);
    assert.ok(nonce !== null);
    assert.deepEqual(orphans.filter((path) => existsSync(path)), [],
        "nothing ever reads a file named after a nonce nobody will draw again, so nothing but this removes it");
    assert.equal(readFileSync(kept, "utf8"), "a record\n", "and the files the store is made of are untouched");
    releaseSyncLock(store, nonce);
    rmSync(store, { recursive: true, force: true });
});

test("lock sweeps: a file a person put in the store is not swept for looking like a nonce", () =>
{
    const store = scratch();
    // Every one of these is aged past the threshold, so age is not what saves
    // them: the name is. The first two carry a 32-hex tail after a `.tmp-`
    // that is not the whole of what follows it; the third is a nonce of the
    // wrong length; the fourth is a stolen lock's name with something in front
    // of it.
    const mine = [
        join(store, `notes.tmp-backup-${"a".repeat(32)}`),
        join(store, `queue.tmp-2026-08-${"b".repeat(32)}`),
        join(store, `draft.tmp-${"c".repeat(16)}`),
        join(store, `old-${SYNC_LOCK_FILE}.dead-${"d".repeat(32)}`)
    ];
    mine.forEach((path) => writeFileSync(path, "a person's own file, in a directory they opened"));
    mine.forEach((path) => agedTo(path, SYNC_LEASE_MS + 60_000));
    const nonce = acquireSyncLock(store);
    assert.ok(nonce !== null);
    assert.deepEqual(mine.filter((path) => !existsSync(path)), [],
        "the store is a directory a person keeps files in, and this sweep deletes files");
    releaseSyncLock(store, nonce);
    rmSync(store, { recursive: true, force: true });
});

test("lock sweeps: a live holder's temp survives the holder that took its lock, and that holder's publish refuses", () =>
{
    const store = scratch();
    const file = join(store, "queue.jsonl");
    writeFileSync(file, "the original\n");
    const first = acquireSyncLock(store);
    // The state a publish is in between writing its temp and renaming it.
    const mine = join(store, `queue.jsonl.tmp-${first}`);
    writeFileSync(mine, "a replacement being written right now");
    // The wall clock steps forward. The first holder is still working and its
    // own lock now reads as stale, which `synclock.ts` documents and which is
    // the case that makes "one holder at a time" false for a sweep.
    theClockStepsPast(store);
    const second = acquireSyncLock(store);
    assert.ok(second !== null, "a lock older than the threshold is taken, whether or not its holder has stopped");
    assert.ok(existsSync(mine),
        "a temp file younger than that same threshold may be one somebody is part-way through writing");

    // And the first holder, resuming, is told no rather than raising: a
    // catch-up stands in front of somebody's command and every row of the pull
    // table ends in that command running.
    assert.equal(publishRewrite(store, file, first, () => "rewritten\n"), false);
    assert.equal(readFileSync(file, "utf8"), "the original\n", "nothing was published over the holder that follows");
    releaseSyncLock(store, second);
    rmSync(store, { recursive: true, force: true });
});

test("lock sweeps: a holder that finished leaves nothing for the next one to work around", () =>
{
    const store = scratch();
    const first = acquireSyncLock(store);
    const mine = join(store, `registry.jsonl.tmp-${first}`);
    writeFileSync(mine, "a replacement being written right now");
    assert.equal(acquireSyncLock(store), null, "and no second holder arrives while the first is working");
    assert.ok(existsSync(mine));
    releaseSyncLock(store, first);
    // Aged, because that is what the sweep asks of a file and not a detail of
    // this cell: the holder that wrote it has been gone at least as long as the
    // lease by the time anything here is safe to remove.
    agedTo(mine, SYNC_LEASE_MS + 60_000);
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
        underTheLock(store, (nonce) => publishRewrite(store,
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
    await pullEverySlug(store, session, held, Date.now() - 1);
    assert.equal(deltas(), 0, "past its lease a catch-up leaves the projects it has not reached where they are");

    await pullEverySlug(store, session, held, Date.now() + PULLER_LEASE_MS);
    assert.equal(deltas(), 1, "and the next pass, which is the next command's, reaches them");
    releaseSyncLock(store, held);
});

test("pull lease-bound: a pass cut short converges on the next one, record for record", async (t) =>
{
    const { box, ws, demo, server } = await connectedMachine({ projects: [{ slug: "demo" }] });
    t.after(() => server.close());
    // A record another machine made, and a record this one has queued: the two
    // halves a catch-up settles between them.
    await fetch(`${server.url}/api/workspaces/${server.wsId}/projects/demo/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Superself-Api": "1" },
        body: JSON.stringify({ events: [{ ...event({ id: "evt_elsewhere" }), event_id: "evt_elsewhere",
            append_id: "apx_elsewhere", actor_account: ACCOUNT, actor_agent: null }] })
    });
    queueAppend(ws, { appendId: "apx_mine" });
    const store = storeDir(ws);
    const session = { base: server.url, wsId: server.wsId, account: ACCOUNT, token: "a token the mock does not read" };

    const held = acquireSyncLock(store);
    await pullEverySlug(store, session, held, Date.now() - 1);      // the pass that was cut short
    releaseSyncLock(store, held);
    assert.deepEqual(logRows(ws).map((row) => row.id), [], "it wrote nothing, which is what makes it resumable");

    await must(box, demo, ["project", "list"], syncEnv());          // the next command, whole
    assert.deepEqual(logRows(ws).map((row) => row.id), ["evt_elsewhere"], "the delta it skipped lands");
    assert.equal(server.eventsIn("demo").length, 2, "and the append it was holding goes");
});

// Several registered projects, listed here and known to the workspace, so that a
// pass has somewhere to get to and somewhere to be stopped short of.
function registerLocally(ws, slugs)
{
    writeFileSync(join(storeDir(ws), "registry.jsonl"),
        slugs.map((slug) => JSON.stringify({ slug, added: "2026-08-31T00:00:00.000Z" }) + "\n").join(""));
    invalidateResolution();
}

function deltasFor(server)
{
    return server.calls.filter((call) => call.method === "GET" && call.path.endsWith("/events"))
        .map((call) => call.path.split("/").at(-2));
}

test("pull unreachable: a workspace this pass could not reach ends the pass rather than being asked once per project",
    async (t) =>
{
    // Three projects and a workspace that drops the connection. Before this, a
    // pass asked every registered project in turn and waited out a request
    // timeout on each — one lease spent, and the same sentence said once per
    // project, in front of somebody holding a command.
    const { ws, server } = await connectedMachine({
        projects: [{ slug: "one" }, { slug: "two" }, { slug: "three" }],
        answer: (call) => call.path.endsWith("/events") ? { destroy: true } : undefined
    });
    t.after(() => server.close());
    registerLocally(ws, ["one", "two", "three"]);
    const store = storeDir(ws);
    const session = { base: server.url, wsId: server.wsId, account: ACCOUNT, token: "a token the mock does not read" };

    const held = acquireSyncLock(store);
    await pullEverySlug(store, session, held, Date.now() + PULLER_LEASE_MS);
    releaseSyncLock(store, held);
    assert.deepEqual(deltasFor(server), ["one"],
        "that the workspace did not answer is a fact about the workspace and not about one project");
});

test("pull in turn: a pass cut short by its lease starts the next one where it stopped", async (t) =>
{
    // The starvation this is about: with a fixed starting point, the projects a
    // short lease never reaches are never reached at all — their appends are
    // never settled, their queues never compacted, and the queue files grow
    // without end while the projects in front of them are pulled on every
    // command.
    let deadline = 0;
    const { ws, server } = await connectedMachine({
        projects: [{ slug: "one" }, { slug: "two" }, { slug: "three" }],
        // A lease spent inside the first project, decided rather than raced: the
        // delta is held until the deadline the pass was given has gone by, so
        // the check before the second project is past it every time.
        answer: (call) => { while (call.path.endsWith("/events") && Date.now() <= deadline) { /* held */ } }
    });
    t.after(() => server.close());
    registerLocally(ws, ["one", "two", "three"]);
    const store = storeDir(ws);
    const session = { base: server.url, wsId: server.wsId, account: ACCOUNT, token: "a token the mock does not read" };

    for (let pass = 0; pass < 3; pass += 1)
    {
        const held = acquireSyncLock(store);
        deadline = Date.now() + 200;
        await pullEverySlug(store, session, held, deadline);
        releaseSyncLock(store, held);
    }
    assert.deepEqual(deltasFor(server), ["one", "two", "three"],
        "every project is reached eventually, which is the whole of what a lease may cost");
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
