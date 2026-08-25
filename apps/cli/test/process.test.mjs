// The process ledger: the synced log carries the transitions, the machine
// ledger carries the pid, and liveness is judged at read time by the OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = await demoWorkspace(box);

test("a started unit shows running while its process lives, stale after it dies", async () =>
{
    const work = workIdIn((await must(box, demo, ["work", "add", "runs under a live process"])).out);
    await must(box, demo, ["work", "start", work]);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try
    {
        await must(box, demo, ["work", "started", work, "--pid", String(child.pid)]);
        assert.match((await must(box, demo, ["status"])).out, new RegExp(`process ${work}: running \\(pid ${child.pid}\\)`));
    }
    finally
    {
        child.kill("SIGKILL");
    }
    await new Promise((resolve) => child.on("exit", resolve));
    assert.match((await must(box, demo, ["status"])).out, new RegExp(`process ${work}: stale`));
});

test("an exited unit reports its code, and the pid never reaches the synced log", async () =>
{
    const work = workIdIn((await must(box, demo, ["work", "add", "exits cleanly"])).out);
    await must(box, demo, ["work", "start", work]);
    await must(box, demo, ["work", "started", work, "--pid", String(process.pid)]);
    await must(box, demo, ["work", "exited", work, "--code", "0"]);
    assert.match((await must(box, demo, ["work", "show", work])).out, /Process: exited \(code 0\)/);
    const log = (await must(box, demo, ["log", "-n", "5"])).out;
    assert.ok(!log.includes(String(process.pid)), "the pid leaked into the synced event log");
});

test("started refuses a missing or malformed pid", async () =>
{
    const work = workIdIn((await must(box, demo, ["work", "add", "needs a pid"])).out);
    const bare = await selfIn(box, demo, ["work", "started", work]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /--pid/);
    const mangled = await selfIn(box, demo, ["work", "started", work, "--pid", "not-a-pid"]);
    assert.notEqual(mangled.code, 0);
});

test("a log holding retired-namespace events still folds", async () =>
{
    // What an old workspace looks like: governance events the CLI no longer
    // writes. Appended directly because no current verb can mint them.
    const log = join(box.root, "ws", ".superself", "projects", "demo", "log.jsonl");
    const legacy = [
        { id: "01hz0000000000000000000001", ts: "2025-01-01T00:00:00.000Z", type: "changeset.registered", project: "demo", payload: { changeset: "cs-old01", repository: "demo", base: "a", head: "b" }, refs: {}, origin: {} },
        { id: "01hz0000000000000000000002", ts: "2025-01-01T00:01:00.000Z", type: "lease.acquired", project: "demo", payload: { repository: "demo", holder: "x", fence: 1 }, refs: {}, origin: {} },
        { id: "01hz0000000000000000000003", ts: "2025-01-01T00:02:00.000Z", type: "review.received", project: "demo", payload: { receipt: "rr-old01", verdict: "approve" }, refs: {}, origin: {} },
        { id: "01hz0000000000000000000004", ts: "2025-01-01T00:03:00.000Z", type: "run.started", project: "demo", payload: { attempt: "at-old01", work: "w-old01" }, refs: {}, origin: {} },
        { id: "01hz0000000000000000000005", ts: "2025-01-01T00:04:00.000Z", type: "spec.applied", project: "demo", payload: { spec: "ws-old01" }, refs: {}, origin: {} }
    ];
    appendFileSync(log, legacy.map((event) => JSON.stringify(event) + "\n").join(""));
    assert.equal((await must(box, demo, ["fold"])).code, 0);
    assert.equal((await must(box, demo, ["context"])).code, 0);
    assert.equal((await must(box, demo, ["status"])).code, 0);
});
