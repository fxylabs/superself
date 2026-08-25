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
import { approvedIn, demoWorkspace, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = await demoWorkspace(box);
const log = join(box.root, "ws", ".superself", "projects", "demo", "log.jsonl");

// Destroying a record needs a person at a terminal (#173): the command line
// runs in full and only the typed answer is stood in for.
const approved = (args, answer) => approvedIn(box, demo, args, answer);

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
async function entityAt(state)
{
    seq += 1;
    const id = entityIdIn((await must(box, demo, ["state", "add", `unit ${seq}`])).out);
    if (state === "in-progress")
    {
        await must(box, demo, ["state", "start", id]);
    }
    if (state === "blocked")
    {
        await must(box, demo, ["state", "block", id, "--why", "waiting on upstream"]);
    }
    if (state === "done")
    {
        await must(box, demo, ["state", "done", id, "--report", "verified output landed"]);
    }
    if (state === "retired")
    {
        await approved(["state", "retire", id, "--why", "outcome given up"], id);
    }
    return id;
}

async function working(id)
{
    const shown = (await must(box, demo, ["state", "show", id])).out;
    const line = shown.split("\n").find((item) => item.startsWith("working:"));
    return line ?? "(no working line)";
}

// The done row shares one record: a refusal moves nothing, so every cell of
// the row still speaks about the state its row names.
const doneEntity = await entityAt("done");

const retiredEntity = await entityAt("retired");

/* ── B. the done evidence gate on the work layer ───────────────────── */

// This section is also group D of #305's case table
// (docs/maintainers/case-tables/305-legacy-work-fold.md), which asks what the
// gate answers once the fold has stopped reading `work.*`. Its cells D1 to D5
// are the five evidence cells below, unchanged: they were the regression net
// the removal had to leave passing, so they are cited rather than restated —
// D1 no reports and no done-time text, D2 bare summary, D3 commit evidence,
// D4 an artifact, D5 a done-time report. D6 and D7 are new, and follow the
// entity-criteria cell.
//
// A separate machine so the scratch repository's commit history is under the
// section's control: no commits until the commit-evidence cell needs one.
const boxB = machine();

const demoB = (await demoWorkspace(boxB)).demo;

/* ── C. the context live-state render ──────────────────────────────── */

// A separate machine so the open-work counts are exactly the units this
// section creates. C's in-progress full row is already asserted by
// test/context.test.mjs ("a fresh store renders no empty section headers, and
// live state renders without entities"), so it is cited, not repeated.
const boxC = machine();

const demoC = (await demoWorkspace(boxC)).demo;

const rows = {};

async function contextC()
{
    return (await must(boxC, demoC, ["context"])).out;
}

/* ── A. state transitions: 5 states × 5 verbs ──────────────────────── */

test("A: open + start records in-progress", async () =>
{
    const id = await entityAt("open");
    await must(box, demo, ["state", "start", id]);
    assert.equal(await working(id), "working: in-progress");
});

test("A: open + block records blocked", async () =>
{
    const id = await entityAt("open");
    await must(box, demo, ["state", "block", id, "--on", "review", "--why", "queue full"]);
    assert.equal(await working(id), "working: blocked on review — queue full");
});

test("A: open + unblock refuses as not blocked", async () =>
{
    const id = await entityAt("open");
    const result = await selfIn(box, demo, ["state", "unblock", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is not blocked/);
});

test("A: open + done passes through the evidence gate", async () =>
{
    const id = await entityAt("open");
    const bare = await selfIn(box, demo, ["state", "done", id]);
    assert.notEqual(bare.code, 0, "a done claim with no evidence was recorded");
    assert.match(bare.out, /done must carry evidence/);
    await must(box, demo, ["state", "done", id, "--report", "shipped and verified"]);
    assert.equal(await working(id), "working: done — shipped and verified");
});

test("A: open + retire records retired", async () =>
{
    const id = await entityAt("open");
    await approved(["state", "retire", id, "--why", "direction changed"], id);
    assert.equal(await working(id), "working: retired — direction changed");
});

// Replaces the "already started" refusal this cell asserted before #231: a
// start on a record another session is on is disclosed, never refused. The
// working state is what this table is about, and it is unchanged — a second
// start leaves the record in-progress. Who holds it, and what a second session
// is told, is the subject of claim.test.mjs.
test("A: in-progress + start stays in-progress and is not refused", async () =>
{
    const id = await entityAt("in-progress");
    const result = await selfIn(box, demo, ["state", "start", id]);
    assert.equal(result.code, 0);
    assert.equal(await working(id), "working: in-progress");
});

test("A: in-progress + block records blocked", async () =>
{
    const id = await entityAt("in-progress");
    await must(box, demo, ["state", "block", id, "--why", "external wait"]);
    assert.equal(await working(id), "working: blocked — external wait");
});

test("A: in-progress + unblock refuses as not blocked", async () =>
{
    const id = await entityAt("in-progress");
    const result = await selfIn(box, demo, ["state", "unblock", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is not blocked/);
});

test("A: in-progress + done passes through the evidence gate", async () =>
{
    const id = await entityAt("in-progress");
    const bare = await selfIn(box, demo, ["state", "done", id]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /done must carry evidence/);
    await must(box, demo, ["state", "done", id, "--report", "finished with proof"]);
    assert.equal(await working(id), "working: done — finished with proof");
});

test("A: in-progress + retire records retired", async () =>
{
    const id = await entityAt("in-progress");
    await approved(["state", "retire", id, "--why", "moved elsewhere"], id);
    assert.equal(await working(id), "working: retired — moved elsewhere");
});

test("A: blocked + start refuses toward unblock first", async () =>
{
    const id = await entityAt("blocked");
    const result = await selfIn(box, demo, ["state", "start", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unblock it first/);
});

test("A: blocked + block refuses as already blocked", async () =>
{
    const id = await entityAt("blocked");
    const result = await selfIn(box, demo, ["state", "block", id, "--why", "again"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already blocked/);
});

test("A: blocked + unblock records in-progress", async () =>
{
    const id = await entityAt("blocked");
    await must(box, demo, ["state", "unblock", id]);
    assert.equal(await working(id), "working: in-progress");
});

test("A: blocked + done is allowed while blocked (ruling 1)", async () =>
{
    const id = await entityAt("blocked");
    await must(box, demo, ["state", "done", id, "--report", "outcome verified despite the block"]);
    assert.equal(await working(id), "working: done — outcome verified despite the block");
});

test("A: blocked + retire records retired", async () =>
{
    const id = await entityAt("blocked");
    await approved(["state", "retire", id, "--why", "the block never lifted"], id);
    assert.equal(await working(id), "working: retired — the block never lifted");
});

test("A: done + start refuses as terminal", async () =>
{
    const result = await selfIn(box, demo, ["state", "start", doneEntity]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already done — its working state is terminal/);
});

test("A: done + block refuses as terminal", async () =>
{
    const result = await selfIn(box, demo, ["state", "block", doneEntity, "--why", "late"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already done — its working state is terminal/);
});

test("A: done + unblock refuses as terminal", async () =>
{
    const result = await selfIn(box, demo, ["state", "unblock", doneEntity]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already done — its working state is terminal/);
});

test("A: done + done refuses as already done", async () =>
{
    const result = await selfIn(box, demo, ["state", "done", doneEntity, "--report", "again"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is already done/);
});

test("A: done + retire refuses as terminal", async () =>
{
    const result = await selfIn(box, demo, ["state", "retire", doneEntity, "--why", "late"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /already done — its working state is terminal/);
});

test("A: retired + start refuses as terminal", async () =>
{
    const result = await selfIn(box, demo, ["state", "start", retiredEntity]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /was retired — its working state is terminal/);
});

test("A: retired + block refuses as terminal", async () =>
{
    const result = await selfIn(box, demo, ["state", "block", retiredEntity, "--why", "late"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /was retired — its working state is terminal/);
});

test("A: retired + unblock refuses as terminal", async () =>
{
    const result = await selfIn(box, demo, ["state", "unblock", retiredEntity]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /was retired — its working state is terminal/);
});

test("A: retired + done refuses as terminal", async () =>
{
    const result = await selfIn(box, demo, ["state", "done", retiredEntity, "--report", "late"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /was retired — its working state is terminal/);
});

test("A: retired + retire refuses as already retired", async () =>
{
    const result = await selfIn(box, demo, ["state", "retire", retiredEntity, "--why", "again"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is already retired/);
});

/* ── off the table: execution facts land only on records that hold ── */

test("execution on a proposed entity refuses toward confirm", async () =>
{
    const proposed = entityIdIn((await must(box, demo, ["state", "add", "not yet held", "--proposed"])).out);
    const result = await selfIn(box, demo, ["state", "start", proposed]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /still proposed/);
});

test("execution on a retracted entity refuses as withdrawn", async () =>
{
    const retracted = entityIdIn((await must(box, demo, ["state", "add", "soon withdrawn"])).out);
    await approved(["state", "retract", retracted, "--why", "never held"], retracted);
    const result = await selfIn(box, demo, ["state", "start", retracted]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /was retracted/);
});

test("execution on a preset record refuses toward its own verbs", async () =>
{
    const decision = (await must(box, demo, ["decide", "keep the queue"])).out.match(/\[([^\]]+)\]/)[1];
    const result = await selfIn(box, demo, ["state", "start", decision]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is a decision record/);
});

test("B: no reports and no done-time text refuses, naming the evidence commands", async () =>
{
    const work = workIdIn((await must(boxB, demoB, ["work", "add", "close with nothing"])).out);
    const result = await selfIn(boxB, demoB, ["work", "done", work]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /has no evidence for done/);
    assert.match(result.out, /self report/);
    assert.match(result.out, /--report/);
});

test("B: bare-summary reports do not satisfy done (ruling 2)", async () =>
{
    const work = workIdIn((await must(boxB, demoB, ["work", "add", "close on prose"])).out);
    // No HEAD exists yet, so the report carries neither commit nor artifact.
    await must(boxB, demoB, ["report", work, "went well, feels finished"]);
    const result = await selfIn(boxB, demoB, ["work", "done", work]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /bare summary never satisfies done/);
    assert.match(result.out, /--report/);
});

test("B: a done-time text report satisfies the gate and is recorded", async () =>
{
    const work = workIdIn((await must(boxB, demoB, ["work", "add", "trivial but real"])).out);
    await must(boxB, demoB, ["work", "done", work, "--report", "renamed the flag, help page regenerated"]);
    const shown = (await must(boxB, demoB, ["work", "show", work])).out;
    assert.ok(shown.includes("- Status: done"), shown);
    assert.ok(shown.includes("renamed the flag, help page regenerated"), "the done-time report left no record");
    const recorded = readFileSync(join(boxB.root, "ws", ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line))
        .some((event) => event.type === "report.added" && event.refs?.work === work);
    assert.ok(recorded, "the done-time text landed as no report event");
});

test("B: a report carrying an artifact satisfies done", async () =>
{
    const work = workIdIn((await must(boxB, demoB, ["work", "add", "close on an artifact"])).out);
    const artifact = join(boxB.root, "output.txt");
    writeFileSync(artifact, "rendered result\n");
    await must(boxB, demoB, ["report", work, "result attached", "--artifact", artifact]);
    const done = await selfIn(boxB, demoB, ["work", "done", work]);
    assert.equal(done.code, 0, done.out);
});

test("B: a report carrying commit evidence satisfies done", async () =>
{
    writeFileSync(join(demoB, "change.txt"), "the change\n");
    execFileSync("git", ["add", "."], { cwd: demoB, env: boxB.env, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "the change"], { cwd: demoB, env: boxB.env, stdio: "ignore" });
    const work = workIdIn((await must(boxB, demoB, ["work", "add", "close on a commit"])).out);
    await must(boxB, demoB, ["report", work, "landed on main"]);
    const done = await selfIn(boxB, demoB, ["work", "done", work]);
    assert.equal(done.code, 0, done.out);
});

test("B: uncovered criteria refuse done with the uncovered ones named", async () =>
{
    const id = entityIdIn((await must(box, demo, ["state", "add", "gated outcome", "--criteria", "suite green", "--criteria", "docs updated"])).out);
    const result = await selfIn(box, demo, ["state", "done", id, "--report", "feels done"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /"suite green"/);
    assert.match(result.out, /"docs updated"/);
});

// #305 D6. `work.required` declared a criterion in the pre-cutover grammar and
// no verb writes one today. The line stays in the log and the gate no longer
// reads it, so the evidence rule is the whole rule.
test("B: a `work.required` line in the log does not gate a unit recorded today", async () =>
{
    const work = workIdIn((await must(boxB, demoB, ["work", "add", "close beside a legacy criterion"])).out);
    const line = { id: "01hz00000000000000000000d6", ts: "2025-03-01T00:00:00.000Z", type: "work.required", project: "demo", payload: { work, requirement: "r1", text: "a criterion nobody covered" }, refs: {}, origin: {} };
    appendFileSync(join(boxB.root, "ws", ".superself", "projects", "demo", "log.jsonl"), JSON.stringify(line) + "\n");
    const done = await selfIn(boxB, demoB, ["work", "done", work, "--report", "closed on a stated fact"]);
    assert.equal(done.code, 0, done.out);
});

// #305 D7. The entity criteria gate is `self state done`'s — the cell above
// this pair is its coverage. `self work done` reaches the evidence gate alone,
// so a work unit carrying uncovered entity criteria closes on evidence.
test("B: uncovered entity criteria do not gate `work done`, which reaches the evidence gate alone", async () =>
{
    const path = join(boxB.root, "ws", ".superself", "projects", "demo", "log.jsonl");
    const seed = workIdIn((await must(boxB, demoB, ["work", "add", "the shape a work entity is recorded in"])).out);
    const template = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .findLast((event) => event.type === "entity.confirmed" && event.payload.entity === seed);
    const work = "w-d7cr1";
    appendFileSync(path, JSON.stringify({
        ...template, id: "01hz00000000000000000000d7", ts: "2025-03-01T00:01:00.000Z",
        payload: { ...template.payload, entity: work, text: "close with a criterion nobody covered", criteria: ["a criterion nobody covered"] }
    }) + "\n");
    await must(boxB, demoB, ["fold"]);
    assert.match((await must(boxB, demoB, ["state", "show", work])).out, /a criterion nobody covered/);
    const done = await selfIn(boxB, demoB, ["work", "done", work, "--report", "closed on a stated fact"]);
    assert.equal(done.code, 0, done.out);
});

test("C: blocked on a decision renders as a full waiting row", async () =>
{
    rows.decision = workIdIn((await must(boxC, demoC, ["work", "add", "needs a ruling"])).out);
    await must(boxC, demoC, ["work", "block", rows.decision, "--on", "decision", "--why", "pricing undecided"]);
    const out = await contextC();
    assert.ok(out.includes("## Waiting on you"), out);
    assert.match(out, /waiting on a decision: pricing undecided/);
});

test("C: a pending proposal renders as a waiting row", async () =>
{
    const objective = (await must(boxC, demoC, ["objective", "add", "reach the preview"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    await must(boxC, demoC, ["work", "propose", "a proposed direction", "--objective", objective,
        "--value", "closes the gap", "--success", "it ships", "--stop", "if superseded",
        "--risk", "low", "--capacity", "one round", "--evidence-plan", "a recorded run",
        "--confidence", "high", "--expires", "2030-01-01"]);
    const out = await contextC();
    // The proposal is a proposed work entity now (#207 B13), so its id is a
    // unit id — the row shape is otherwise the phase 3 one.
    assert.match(out, /work proposal [\w-]+: a proposed direction/);
});

test("C: blocked on dependency or external renders as a count, not a row", async () =>
{
    rows.dependency = workIdIn((await must(boxC, demoC, ["work", "add", "parked on upstream api"])).out);
    await must(boxC, demoC, ["work", "start", rows.dependency]);
    await must(boxC, demoC, ["work", "block", rows.dependency, "--on", "dependency", "--why", "upstream api missing"]);
    rows.external = workIdIn((await must(boxC, demoC, ["work", "add", "parked on a vendor"])).out);
    await must(boxC, demoC, ["work", "block", rows.external, "--on", "external"]);
    const out = await contextC();
    assert.ok(!out.includes("parked on upstream api"), `a dependency-blocked unit rendered as a row:\n${out}`);
    assert.ok(!out.includes("parked on a vendor"), "an external-blocked unit rendered as a row");
    assert.match(out, /- 2 more open work items; run `self work --project 'demo'`/);
});

test("C: open, unstarted work renders as a count, not a row", async () =>
{
    rows.open = workIdIn((await must(boxC, demoC, ["work", "add", "not yet picked up"])).out);
    const out = await contextC();
    assert.ok(!out.includes("not yet picked up"), "an unstarted unit rendered as a row");
    assert.match(out, /- 3 more open work items; run `self work --project 'demo'`/);
});

test("C: done and retired work render nowhere, not even in the count", async () =>
{
    const done = workIdIn((await must(boxC, demoC, ["work", "add", "already delivered"])).out);
    await must(boxC, demoC, ["work", "done", done, "--report", "delivered and verified"]);
    const retired = workIdIn((await must(boxC, demoC, ["work", "add", "already given up"])).out);
    await approvedIn(boxC, demoC, ["work", "retire", retired, "--why", "superseded"], retired);
    const out = await contextC();
    assert.ok(!out.includes("already delivered"), "a done unit rendered in context");
    assert.ok(!out.includes("already given up"), "a retired unit rendered in context");
    assert.match(out, /- 3 more open work items/, "a closed unit moved the open-work count");
});

/* ── D. legacy history is never refused ────────────────────────────── */

test("D: malformed and out-of-order execution lines fold without refusal", async () =>
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
    await must(box, demo, ["fold"]);
    // Applied in timestamp order over the complete set: started first, then
    // done — and done is terminal, whatever order the log carried the lines in.
    assert.equal(await working("e-mrgex"), "working: done — landed elsewhere");
});

test("D: two folds render the same execution state", async () =>
{
    const before = (await must(box, demo, ["context"])).out;
    const shown = await working("e-mrgex");
    await must(box, demo, ["fold"]);
    assert.equal((await must(box, demo, ["context"])).out, before, "a refold changed the rendered context");
    assert.equal(await working("e-mrgex"), shown, "a refold changed a folded working state");
});

/* ── E. integrity ──────────────────────────────────────────────────── */

test("E: every execution event records its actor", async () =>
{
    const id = await entityAt("open");
    await must(box, demo, ["state", "start", id]);
    await must(box, demo, ["state", "done", id, "--report", "actor check"]);
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

test("E: a second done is refused and the log carries exactly one", async () =>
{
    const id = await entityAt("done");
    const again = await selfIn(box, demo, ["state", "done", id, "--report", "twice"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /is already done/);
    const dones = readFileSync(log, "utf8").split("\n").filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "entity.done" && event.payload.entity === id);
    assert.equal(dones.length, 1);
});

test("E: retire --successor records the link and shows it", async () =>
{
    const gone = await entityAt("open");
    const carrier = await entityAt("open");
    await approved(["state", "retire", gone, "--why", "moved", "--successor", carrier], gone);
    assert.equal(await working(gone), `working: retired — moved (successor ${carrier})`);
    const retired = readFileSync(log, "utf8").split("\n").filter((line) => line !== "")
        .map((line) => JSON.parse(line))
        .find((event) => event.type === "entity.retired" && event.payload.entity === gone);
    assert.equal(retired?.payload.successor, carrier);
});

test("E: a report still auto-attaches HEAD as evidence", async () =>
{
    // demoB's repository gained a commit in section B; the report offers no
    // --evidence, and the recorded commit is the checkout's HEAD.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: demoB, env: boxB.env, encoding: "utf8" }).trim();
    const work = workIdIn((await must(boxB, demoB, ["work", "add", "head evidence check"])).out);
    await must(boxB, demoB, ["report", work, "auto evidence"]);
    const shown = (await must(boxB, demoB, ["work", "show", work])).out;
    assert.ok(shown.includes(head.slice(0, 7)), `the report did not attach HEAD:\n${shown}`);
});
