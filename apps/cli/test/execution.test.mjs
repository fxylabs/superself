// The work execution layer (#205): every test below derives from a cell of
// the issue's case table, asserting that cell's stated outcome — a recorded
// transition, a named refusal, or a render form. Section A drives the entity
// execution verbs through the full state × verb matrix; B the done evidence
// gate; C the context live-state render; D legacy-history tolerance; E the
// integrity assertions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = demoWorkspace(box);
const log = join(box.root, "ws", ".superself", "projects", "demo", "log.jsonl");

let seq = 0;

function entityIdIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no entity id in: ${text}`);
    }
    return match[0];
}

// One fresh entity driven to the row's working state, so every cell starts
// from exactly the state its row names.
function entityAt(state)
{
    seq += 1;
    const id = entityIdIn(must(box, demo, ["state", "add", `unit ${seq}`]).out);
    if (state === "in-progress")
    {
        must(box, demo, ["state", "start", id]);
    }
    if (state === "blocked")
    {
        must(box, demo, ["state", "block", id, "--why", "waiting on upstream"]);
    }
    if (state === "done")
    {
        must(box, demo, ["state", "done", id, "--report", "verified output landed"]);
    }
    if (state === "retired")
    {
        must(box, demo, ["state", "retire", id, "--why", "outcome given up"]);
    }
    return id;
}

function working(id)
{
    const shown = must(box, demo, ["state", "show", id]).out;
    const line = shown.split("\n").find((item) => item.startsWith("working:"));
    return line ?? "(no working line)";
}

/* ── A. state transitions: 5 states × 5 verbs ──────────────────────── */

test("A: open + start records in-progress", () =>
{
    const id = entityAt("open");
    must(box, demo, ["state", "start", id]);
    assert.equal(working(id), "working: in-progress");
});

test("A: open + block records blocked", () =>
{
    const id = entityAt("open");
    must(box, demo, ["state", "block", id, "--on", "review", "--why", "queue full"]);
    assert.equal(working(id), "working: blocked on review — queue full");
});

test("A: open + unblock refuses as not blocked", () =>
{
    const id = entityAt("open");
    const result = selfIn(box, demo, ["state", "unblock", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is not blocked/);
});

test("A: open + done passes through the evidence gate", () =>
{
    const id = entityAt("open");
    const bare = selfIn(box, demo, ["state", "done", id]);
    assert.notEqual(bare.code, 0, "a done claim with no evidence was recorded");
    assert.match(bare.out, /done must carry evidence/);
    must(box, demo, ["state", "done", id, "--report", "shipped and verified"]);
    assert.equal(working(id), "working: done — shipped and verified");
});

test("A: open + retire records retired", () =>
{
    const id = entityAt("open");
    must(box, demo, ["state", "retire", id, "--why", "direction changed"]);
    assert.equal(working(id), "working: retired — direction changed");
});

test("A: in-progress + start refuses as already started", () =>
{
    const id = entityAt("in-progress");
    const result = selfIn(box, demo, ["state", "start", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already started/);
});

test("A: in-progress + block records blocked", () =>
{
    const id = entityAt("in-progress");
    must(box, demo, ["state", "block", id, "--why", "external wait"]);
    assert.equal(working(id), "working: blocked — external wait");
});

test("A: in-progress + unblock refuses as not blocked", () =>
{
    const id = entityAt("in-progress");
    const result = selfIn(box, demo, ["state", "unblock", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is not blocked/);
});

test("A: in-progress + done passes through the evidence gate", () =>
{
    const id = entityAt("in-progress");
    const bare = selfIn(box, demo, ["state", "done", id]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /done must carry evidence/);
    must(box, demo, ["state", "done", id, "--report", "finished with proof"]);
    assert.equal(working(id), "working: done — finished with proof");
});

test("A: in-progress + retire records retired", () =>
{
    const id = entityAt("in-progress");
    must(box, demo, ["state", "retire", id, "--why", "moved elsewhere"]);
    assert.equal(working(id), "working: retired — moved elsewhere");
});

test("A: blocked + start refuses toward unblock first", () =>
{
    const id = entityAt("blocked");
    const result = selfIn(box, demo, ["state", "start", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unblock it first/);
});

test("A: blocked + block refuses as already blocked", () =>
{
    const id = entityAt("blocked");
    const result = selfIn(box, demo, ["state", "block", id, "--why", "again"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already blocked/);
});

test("A: blocked + unblock records in-progress", () =>
{
    const id = entityAt("blocked");
    must(box, demo, ["state", "unblock", id]);
    assert.equal(working(id), "working: in-progress");
});

test("A: blocked + done is allowed while blocked (ruling 1)", () =>
{
    const id = entityAt("blocked");
    must(box, demo, ["state", "done", id, "--report", "outcome verified despite the block"]);
    assert.equal(working(id), "working: done — outcome verified despite the block");
});

test("A: blocked + retire records retired", () =>
{
    const id = entityAt("blocked");
    must(box, demo, ["state", "retire", id, "--why", "the block never lifted"]);
    assert.equal(working(id), "working: retired — the block never lifted");
});

// The done row shares one record: a refusal moves nothing, so every cell of
// the row still speaks about the state its row names.
const doneEntity = entityAt("done");

test("A: done + start refuses as terminal", () =>
{
    const result = selfIn(box, demo, ["state", "start", doneEntity]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already done — its working state is terminal/);
});

test("A: done + block refuses as terminal", () =>
{
    const result = selfIn(box, demo, ["state", "block", doneEntity, "--why", "late"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already done — its working state is terminal/);
});

test("A: done + unblock refuses as terminal", () =>
{
    const result = selfIn(box, demo, ["state", "unblock", doneEntity]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already done — its working state is terminal/);
});

test("A: done + done refuses as already done", () =>
{
    const result = selfIn(box, demo, ["state", "done", doneEntity, "--report", "again"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is already done/);
});

test("A: done + retire refuses as terminal", () =>
{
    const result = selfIn(box, demo, ["state", "retire", doneEntity, "--why", "late"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already done — its working state is terminal/);
});

const retiredEntity = entityAt("retired");

test("A: retired + start refuses as terminal", () =>
{
    const result = selfIn(box, demo, ["state", "start", retiredEntity]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /was retired — its working state is terminal/);
});

test("A: retired + block refuses as terminal", () =>
{
    const result = selfIn(box, demo, ["state", "block", retiredEntity, "--why", "late"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /was retired — its working state is terminal/);
});

test("A: retired + unblock refuses as terminal", () =>
{
    const result = selfIn(box, demo, ["state", "unblock", retiredEntity]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /was retired — its working state is terminal/);
});

test("A: retired + done refuses as terminal", () =>
{
    const result = selfIn(box, demo, ["state", "done", retiredEntity, "--report", "late"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /was retired — its working state is terminal/);
});

test("A: retired + retire refuses as already retired", () =>
{
    const result = selfIn(box, demo, ["state", "retire", retiredEntity, "--why", "again"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is already retired/);
});

/* ── off the table: execution facts land only on records that hold ── */

test("execution on a proposed entity refuses toward confirm", () =>
{
    const proposed = entityIdIn(must(box, demo, ["state", "add", "not yet held", "--proposed"]).out);
    const result = selfIn(box, demo, ["state", "start", proposed]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /still proposed/);
});

test("execution on a retracted entity refuses as withdrawn", () =>
{
    const retracted = entityIdIn(must(box, demo, ["state", "add", "soon withdrawn"]).out);
    must(box, demo, ["state", "retract", retracted, "--why", "never held"]);
    const result = selfIn(box, demo, ["state", "start", retracted]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /was retracted/);
});

test("execution on a preset record refuses toward its own verbs", () =>
{
    const decision = must(box, demo, ["decide", "keep the queue"]).out.match(/\[([^\]]+)\]/)[1];
    const result = selfIn(box, demo, ["state", "start", decision]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is a decision record/);
});

/* ── B. the done evidence gate on the work layer ───────────────────── */

// A separate machine so the scratch repository's commit history is under the
// section's control: no commits until the commit-evidence cell needs one.
const boxB = machine();
const demoB = demoWorkspace(boxB).demo;

test("B: no reports and no done-time text refuses, naming the evidence commands", () =>
{
    const work = workIdIn(must(boxB, demoB, ["work", "add", "close with nothing"]).out);
    const result = selfIn(boxB, demoB, ["work", "done", work]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /has no evidence for done/);
    assert.match(result.out, /self report/);
    assert.match(result.out, /--report/);
});

test("B: bare-summary reports do not satisfy done (ruling 2)", () =>
{
    const work = workIdIn(must(boxB, demoB, ["work", "add", "close on prose"]).out);
    // No HEAD exists yet, so the report carries neither commit nor artifact.
    must(boxB, demoB, ["report", work, "went well, feels finished"]);
    const result = selfIn(boxB, demoB, ["work", "done", work]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /bare summary never satisfies done/);
    assert.match(result.out, /--report/);
});

test("B: a done-time text report satisfies the gate and is recorded", () =>
{
    const work = workIdIn(must(boxB, demoB, ["work", "add", "trivial but real"]).out);
    must(boxB, demoB, ["work", "done", work, "--report", "renamed the flag, help page regenerated"]);
    const shown = must(boxB, demoB, ["work", "show", work]).out;
    assert.ok(shown.includes("- Status: done"), shown);
    assert.ok(shown.includes("renamed the flag, help page regenerated"), "the done-time report left no record");
    const recorded = readFileSync(join(boxB.root, "ws", ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line))
        .some((event) => event.type === "report.added" && event.refs?.work === work);
    assert.ok(recorded, "the done-time text landed as no report event");
});

test("B: a report carrying an artifact satisfies done", () =>
{
    const work = workIdIn(must(boxB, demoB, ["work", "add", "close on an artifact"]).out);
    const artifact = join(boxB.root, "output.txt");
    writeFileSync(artifact, "rendered result\n");
    must(boxB, demoB, ["report", work, "result attached", "--artifact", artifact]);
    const done = selfIn(boxB, demoB, ["work", "done", work]);
    assert.equal(done.code, 0, done.out);
});

test("B: a report carrying commit evidence satisfies done", () =>
{
    writeFileSync(join(demoB, "change.txt"), "the change\n");
    execFileSync("git", ["add", "."], { cwd: demoB, env: boxB.env, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "the change"], { cwd: demoB, env: boxB.env, stdio: "ignore" });
    const work = workIdIn(must(boxB, demoB, ["work", "add", "close on a commit"]).out);
    must(boxB, demoB, ["report", work, "landed on main"]);
    const done = selfIn(boxB, demoB, ["work", "done", work]);
    assert.equal(done.code, 0, done.out);
});

test("B: uncovered criteria refuse done with the uncovered ones named", () =>
{
    const id = entityIdIn(must(box, demo, ["state", "add", "gated outcome", "--criteria", "suite green", "--criteria", "docs updated"]).out);
    const result = selfIn(box, demo, ["state", "done", id, "--report", "feels done"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /"suite green"/);
    assert.match(result.out, /"docs updated"/);
});

test("B: criteria all covered with evidence present allows done", () =>
{
    // The criteria surface of the work layer arrives folded from history —
    // no current verb declares one — so the covered pair is appended as a
    // legacy log would carry it, and the gate reads the fold.
    const work = workIdIn(must(boxB, demoB, ["work", "add", "criteria covered"]).out);
    const lines = [
        { id: "01hz00000000000000000000b1", ts: "2025-03-01T00:00:00.000Z", type: "work.required", project: "demo", payload: { work, requirement: "r1", text: "proof case exists" }, refs: {}, origin: {} },
        { id: "01hz00000000000000000000b2", ts: "2025-03-01T00:01:00.000Z", type: "work.covered", project: "demo", payload: { work, requirement: "r1", why: "proof case landed", requirementRevision: 1 }, refs: {}, origin: {} }
    ];
    appendFileSync(join(boxB.root, "ws", ".superself", "projects", "demo", "log.jsonl"),
        lines.map((line) => JSON.stringify(line) + "\n").join(""));
    const done = selfIn(boxB, demoB, ["work", "done", work, "--report", "criterion covered and verified"]);
    assert.equal(done.code, 0, done.out);
});

test("extra: an uncovered work criterion from history refuses done by name", () =>
{
    const work = workIdIn(must(boxB, demoB, ["work", "add", "criteria open"]).out);
    const line = { id: "01hz00000000000000000000b3", ts: "2025-03-01T00:02:00.000Z", type: "work.required", project: "demo", payload: { work, requirement: "r1", text: "second proof case" }, refs: {}, origin: {} };
    appendFileSync(join(boxB.root, "ws", ".superself", "projects", "demo", "log.jsonl"), JSON.stringify(line) + "\n");
    const result = selfIn(boxB, demoB, ["work", "done", work, "--report", "done anyway"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /uncovered criteria/);
    assert.match(result.out, /r1 second proof case/);
});

/* ── C. the context live-state render ──────────────────────────────── */

// A separate machine so the open-work counts are exactly the units this
// section creates. C's in-progress full row is already asserted by
// test/context.test.mjs ("a fresh store renders no empty section headers, and
// live state renders without entities"), so it is cited, not repeated.
const boxC = machine();
const demoC = demoWorkspace(boxC).demo;
const rows = {};

function contextC()
{
    return must(boxC, demoC, ["context"]).out;
}

test("C: blocked on a decision renders as a full waiting row", () =>
{
    rows.decision = workIdIn(must(boxC, demoC, ["work", "add", "needs a ruling"]).out);
    must(boxC, demoC, ["work", "block", rows.decision, "--on", "decision", "--why", "pricing undecided"]);
    const out = contextC();
    assert.ok(out.includes("## Waiting on you"), out);
    assert.match(out, /waiting on a decision: pricing undecided/);
});

test("C: a pending proposal renders as a waiting row", () =>
{
    const objective = must(boxC, demoC, ["objective", "add", "reach the preview"]).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    must(boxC, demoC, ["work", "propose", "a proposed direction", "--objective", objective,
        "--value", "closes the gap", "--success", "it ships", "--stop", "if superseded",
        "--risk", "low", "--capacity", "one round", "--evidence-plan", "a recorded run",
        "--confidence", "high", "--expires", "2030-01-01"]);
    const out = contextC();
    assert.match(out, /work proposal [0-9a-z]+: a proposed direction/);
});

test("C: blocked on dependency or external renders as a count, not a row", () =>
{
    rows.dependency = workIdIn(must(boxC, demoC, ["work", "add", "parked on upstream api"]).out);
    must(boxC, demoC, ["work", "start", rows.dependency]);
    must(boxC, demoC, ["work", "block", rows.dependency, "--on", "dependency", "--why", "upstream api missing"]);
    rows.external = workIdIn(must(boxC, demoC, ["work", "add", "parked on a vendor"]).out);
    must(boxC, demoC, ["work", "block", rows.external, "--on", "external"]);
    const out = contextC();
    assert.ok(!out.includes("parked on upstream api"), `a dependency-blocked unit rendered as a row:\n${out}`);
    assert.ok(!out.includes("parked on a vendor"), "an external-blocked unit rendered as a row");
    assert.match(out, /- 2 more open work items; run `self work --project 'demo'`/);
});

test("C: open, unstarted work renders as a count, not a row", () =>
{
    rows.open = workIdIn(must(boxC, demoC, ["work", "add", "not yet picked up"]).out);
    const out = contextC();
    assert.ok(!out.includes("not yet picked up"), "an unstarted unit rendered as a row");
    assert.match(out, /- 3 more open work items; run `self work --project 'demo'`/);
});

test("C: done and retired work render nowhere, not even in the count", () =>
{
    const done = workIdIn(must(boxC, demoC, ["work", "add", "already delivered"]).out);
    must(boxC, demoC, ["work", "done", done, "--report", "delivered and verified"]);
    const retired = workIdIn(must(boxC, demoC, ["work", "add", "already given up"]).out);
    must(boxC, demoC, ["work", "retire", retired, "--why", "superseded"]);
    const out = contextC();
    assert.ok(!out.includes("already delivered"), "a done unit rendered in context");
    assert.ok(!out.includes("already given up"), "a retired unit rendered in context");
    assert.match(out, /- 3 more open work items/, "a closed unit moved the open-work count");
});

/* ── D. legacy history is never refused ────────────────────────────── */

test("D: a legacy evidence-free work.done keeps folding as done", () =>
{
    const work = workIdIn(must(box, demo, ["work", "add", "closed by an older binary"]).out);
    const line = { id: "01hz00000000000000000000d1", ts: "2025-03-02T00:00:00.000Z", type: "work.done", project: "demo", payload: { work }, refs: {}, origin: {} };
    appendFileSync(log, JSON.stringify(line) + "\n");
    must(box, demo, ["fold"]);
    const shown = must(box, demo, ["work", "show", work]).out;
    assert.ok(shown.includes("- Status: done"), `the fold refused a legacy done:\n${shown}`);
    assert.ok(!shown.includes("Not done yet"), "a legacy done unit reads as still owing evidence");
});

test("D: malformed and out-of-order execution lines fold without refusal", () =>
{
    const lines = [
        // Done ordered above the start that preceded it in time, an execution
        // fact on an entity this store never saw, and a payload whose entity
        // is not even a string: the fold reads what it can and drops the rest.
        { id: "01hz00000000000000000000d3", ts: "2025-03-03T00:02:00.000Z", type: "entity.done", project: "demo", payload: { entity: "e-mrgex", report: "landed elsewhere" }, refs: {}, origin: {} },
        { id: "01hz00000000000000000000d2", ts: "2025-03-03T00:01:00.000Z", type: "entity.started", project: "demo", payload: { entity: "e-mrgex" }, refs: {}, origin: {} },
        { id: "01hz00000000000000000000d4", ts: "2025-03-03T00:03:00.000Z", type: "entity.started", project: "demo", payload: { entity: "e-nope1" }, refs: {}, origin: {} },
        { id: "01hz00000000000000000000d5", ts: "2025-03-03T00:04:00.000Z", type: "entity.blocked", project: "demo", payload: { entity: 42 }, refs: {}, origin: {} },
        { id: "01hz00000000000000000000d6", ts: "2025-03-03T00:05:00.000Z", type: "entity.confirmed", project: "demo", payload: { entity: "e-mrgex", text: "merge-ordered execution", labels: [], links: [], criteria: [], exposure: "index", scope: "project" }, refs: {}, origin: {} }
    ];
    appendFileSync(log, lines.map((line) => JSON.stringify(line) + "\n").join(""));
    must(box, demo, ["fold"]);
    // Applied in timestamp order over the complete set: started first, then
    // done — and done is terminal, whatever order the log carried the lines in.
    assert.equal(working("e-mrgex"), "working: done — landed elsewhere");
});

test("D: two folds render the same execution state", () =>
{
    const before = must(box, demo, ["context"]).out;
    const shown = working("e-mrgex");
    must(box, demo, ["fold"]);
    assert.equal(must(box, demo, ["context"]).out, before, "a refold changed the rendered context");
    assert.equal(working("e-mrgex"), shown, "a refold changed a folded working state");
});

/* ── E. integrity ──────────────────────────────────────────────────── */

test("E: every execution event records its actor", () =>
{
    const id = entityAt("open");
    must(box, demo, ["state", "start", id]);
    must(box, demo, ["state", "done", id, "--report", "actor check"]);
    const events = readFileSync(log, "utf8").split("\n").filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .filter((event) => ["entity.started", "entity.done"].includes(event.type) && event.payload.entity === id);
    assert.equal(events.length, 2, "the transitions did not reach the log");
    for (const event of events)
    {
        assert.ok(typeof event.origin.actor === "string" && event.origin.actor !== "",
            `${event.type} recorded no actor`);
    }
});

test("E: a second done is refused and the log carries exactly one", () =>
{
    const id = entityAt("done");
    const again = selfIn(box, demo, ["state", "done", id, "--report", "twice"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /is already done/);
    const dones = readFileSync(log, "utf8").split("\n").filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "entity.done" && event.payload.entity === id);
    assert.equal(dones.length, 1);
});

test("E: retire --successor records the link and shows it", () =>
{
    const gone = entityAt("open");
    const carrier = entityAt("open");
    must(box, demo, ["state", "retire", gone, "--why", "moved", "--successor", carrier]);
    assert.equal(working(gone), `working: retired — moved (successor ${carrier})`);
    const retired = readFileSync(log, "utf8").split("\n").filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .find((event) => event.type === "entity.retired" && event.payload.entity === gone);
    assert.equal(retired?.payload.successor, carrier);
});

test("E: a report still auto-attaches HEAD as evidence", () =>
{
    // demoB's repository gained a commit in section B; the report offers no
    // --evidence, and the recorded commit is the checkout's HEAD.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: demoB, env: boxB.env, encoding: "utf8" }).trim();
    const work = workIdIn(must(boxB, demoB, ["work", "add", "head evidence check"]).out);
    must(boxB, demoB, ["report", work, "auto evidence"]);
    const shown = must(boxB, demoB, ["work", "show", work]).out;
    assert.ok(shown.includes(head.slice(0, 7)), `the report did not attach HEAD:\n${shown}`);
});
