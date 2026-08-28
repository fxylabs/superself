// The coverage grammar (#207 C): `state cover` records entity.covered on any
// record carrying criteria, `milestone met` is sugar over it, and done/reach
// are gated on full coverage. Claims bind to the entity id, so a superseding
// revision starts uncovered and recheck covers the successor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, machine, must, mustPerson, receiptIn, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = await demoWorkspace(box);
const log = join(box.root, "ws", ".superself", "projects", "demo", "log.jsonl");
const self = (args) => selfIn(box, demo, args);

function entityIn(text)
{
    return text.match(/\be-[0-9a-z]{5}\b/)[0];
}

function events()
{
    return readFileSync(log, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

test("C1: state cover records entity.covered with its actor, and state show carries the claim", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "gated outcome", "--criteria", "suite green", "--criteria", "docs updated"])).out);
    const printed = await must(box, demo, ["state", "cover", id, "--criterion", "suite green", "--why", "83 tests green"]);
    assert.match(printed.out, /entity\.covered recorded/);
    const recorded = events().find((event) => event.type === "entity.covered" && event.payload.entity === id);
    assert.equal(recorded.payload.criterion, "suite green");
    assert.ok(typeof recorded.origin.actor === "string" && recorded.origin.actor !== "", "the claim recorded no actor");
    assert.match((await must(box, demo, ["state", "show", id])).out, /covered: suite green — 83 tests green/);
});

test("C2: covering an undeclared criterion refuses, naming the declared ones", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "narrow gate", "--criteria", "one thing"])).out);
    const result = await self(["state", "cover", id, "--criterion", "another thing", "--why", "x"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is not a declared criterion/);
    assert.match(result.out, /c1 "one thing"/);
    const bare = await self(["state", "cover", id, "--criterion", "x", "--why", ""]);
    assert.notEqual(bare.code, 0);
});

test("C3: a raw entity with every criterion covered passes done", async () =>
{
    // The refusal counterpart is phase 3's "B: uncovered criteria refuse done
    // with the uncovered ones named" (test/execution.test.mjs), which held the
    // claim open before coverage shipped and now names the uncovered set.
    const id = entityIn((await must(box, demo, ["state", "add", "coverable outcome", "--criteria", "a", "--criteria", "b"])).out);
    await must(box, demo, ["state", "cover", id, "--criterion", "c1", "--why", "a landed"]);
    await must(box, demo, ["state", "cover", id, "--criterion", "c2", "--why", "b landed"]);
    const done = await must(box, demo, ["state", "done", id, "--report", "everything verified"]);
    assert.match(done.out, /entity\.done recorded/);
});

test("C4: done with uncovered criteria refuses naming exactly the uncovered ones", async () =>
{
    // Cited: phase 3's B6 tests assert the refusal over a wholly uncovered
    // set; this pins that a covered criterion leaves the refusal.
    const id = entityIn((await must(box, demo, ["state", "add", "half covered", "--criteria", "left", "--criteria", "right"])).out);
    await must(box, demo, ["state", "cover", id, "--criterion", "left", "--why", "landed"]);
    const result = await self(["state", "done", id, "--report", "feels done"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /c2 {2}open — right/);
    assert.ok(!result.out.includes("left"), "a covered criterion was named as uncovered");
    assert.match(result.out, /state cover/);
});

test("C5: milestone met records the same entity.covered, carrying the work and evidence refs", async () =>
{
    writeFileSync(join(demo, "change.txt"), "the change\n");
    execFileSync("git", ["add", "."], { cwd: demo, env: box.env, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "the change"], { cwd: demo, env: box.env, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: demo, env: box.env, encoding: "utf8" }).trim();
    const objective = (await must(box, demo, ["objective", "add", "reach preview"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const milestone = (await must(box, demo, ["milestone", "add", "suite green", "--objective", objective, "--exit", "tests pass"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "make it green"])).out);
    await must(box, demo, ["work", "link", work, "--milestone", milestone]);
    const unlinked = workIdIn((await mustPerson(box, demo, ["work", "add", "unrelated"])).out);
    const refused = await self(["milestone", "met", milestone, "--criterion", "c1", "--why", "x", "--work", unlinked]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /does not contribute to/);
    await must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "ran green", "--work", work, "--evidence", head]);
    const recorded = events().find((event) => event.type === "entity.covered" && event.payload.entity === milestone);
    assert.equal(recorded.payload.criterion, "tests pass");
    assert.equal(recorded.refs.work, work);
    assert.deepEqual(recorded.refs.commits, [head]);
    assert.match((await must(box, demo, ["milestone", "show", milestone])).out, /c1 — tests pass _\(covered/);
});

test("C6: coverage binds to the entity id — a revision starts uncovered and recheck covers the successor", async () =>
{
    const objective = (await must(box, demo, ["objective", "add", "quality bar"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const milestone = (await must(box, demo, ["milestone", "add", "checkpoint", "--objective", objective, "--exit", "the proof"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    await must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "first judgment"]);
    const successor = receiptIn((await approvedIn(box, demo, ["milestone", "revise", milestone, "--why", "widened", "--outcome", "checkpoint, widened"], milestone)).printed).match(/\bm-[0-9a-z]{5}\b/)[0];
    const early = await self(["milestone", "reach", successor]);
    assert.notEqual(early.code, 0, "a successor inherited its predecessor's coverage");
    assert.match(early.out, /uncovered exit criteria/);
    // Recheck lands on the current record even when the predecessor is named.
    await must(box, demo, ["milestone", "recheck", milestone, "--criterion", "c1", "--why", "re-judged on the successor"]);
    const claims = events().filter((event) => event.type === "entity.covered" && event.payload.entity === successor);
    assert.equal(claims.length, 1, "the recheck did not cover the successor");
    assert.match((await must(box, demo, ["milestone", "reach", successor])).out, /entity\.done recorded/);
    const again = await self(["milestone", "recheck", successor, "--criterion", "c1", "--why", "twice"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already covered at the current record/);
    const bare = await self(["milestone", "recheck", successor, "--why", "no criterion"]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /needs --criterion/);
    assert.match(bare.out, /successor starts uncovered/);
});
