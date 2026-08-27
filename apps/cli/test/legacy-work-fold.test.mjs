// The fold stops reading legacy `work.*` events (#305). Every test below is
// one cell of docs/maintainers/case-tables/305-legacy-work-fold.md, named by
// its cell number and asserting that cell's stated outcome.
//
// Groups D and G live where the surfaces they question already are: D beside
// the done evidence gate in execution.test.mjs, G beside the pre-cutover store
// in integrity.test.mjs. A to C, E, F and R are here.
//
// The legacy lines are fixtures, not a way past a gate: the verbs that wrote
// them no longer exist, and every store that ran them still carries the lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, git, logFixture, machine, must, mustPerson, personIn, retireFixture, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);
await must(box, demo, ["goal", "add", "a direction"]);
const objective = (await must(box, demo, ["objective", "add", "a measurable outcome", "--target", "2099-01-01"]))
    .out.match(/\bo-[0-9a-z]{5}\b/)[0];

const BRIEF = {
    value: "closes the gap",
    success: ["it ships"],
    stop: ["if superseded"],
    depends: [],
    risk: "low",
    capacity: "one round",
    evidencePlan: "a recorded run",
    confidence: "high",
    expires: "2099-01-01"
};

let seq = 0;

// One pre-cutover unit: the `work.created` line an old binary appended, and
// nothing else. Answers the id it named.
function legacyUnit(outcome, extra = {})
{
    seq += 1;
    const work = `w-leg${String(seq).padStart(2, "0")}`;
    retireFixture(box, ws, "demo", "work.created", { work, outcome, ...extra });
    return work;
}

function legacyLine(type, payload, refs)
{
    return retireFixture(box, ws, "demo", type, payload, refs);
}

async function nativeProposal(outcome)
{
    return workIdIn((await must(box, demo, ["work", "propose", outcome, "--objective", objective,
        "--value", BRIEF.value, "--success", BRIEF.success[0], "--stop", BRIEF.stop[0],
        "--risk", BRIEF.risk, "--capacity", BRIEF.capacity, "--evidence-plan", BRIEF.evidencePlan,
        "--confidence", BRIEF.confidence, "--expires", BRIEF.expires])).out);
}

async function context()
{
    return (await must(box, demo, ["context"])).out;
}

async function statusLine()
{
    return (await must(box, demo, ["status"])).out;
}

async function log()
{
    return (await must(box, demo, ["log", "-n", "500"])).out;
}

/* ── R. the process events, which are current and stay ─────────────── */

const runBox = machine();

const { ws: runWs, demo: runDemo } = await demoWorkspace(runBox);

/* ── A. the creation event × the fold ──────────────────────────────── */

test("A1: a store whose only unit is a `work.created` one lists no open work", async () =>
{
    legacyUnit("A1: an outcome from before entities");
    assert.equal((await must(box, demo, ["work"])).out.trim(), "no open work");
});

test("A2: `context` on the same store folds, with no work section", async () =>
{
    const shown = await context();
    assert.ok(!shown.includes("A1: an outcome from before entities"), `a legacy unit reached context:\n${shown}`);
    assert.ok(!shown.includes("## Work in progress"), `an empty work section was rendered:\n${shown}`);
});

test("A3: a unit whose creation event is `entity.confirmed` lists as it always did", async () =>
{
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "A3: an outcome recorded today"])).out);
    assert.ok((await must(box, demo, ["work"])).out.includes(work));
});

test("A4: a legacy unit beside a native one leaves only the native one", async () =>
{
    const legacy = legacyUnit("A4: the outcome from before");
    const native = workIdIn((await mustPerson(box, demo, ["work", "add", "A4: the outcome from today"])).out);
    const listed = (await must(box, demo, ["work"])).out;
    assert.ok(listed.includes(native), `the native unit is missing:\n${listed}`);
    assert.ok(!listed.includes(legacy), `the legacy unit is still listed:\n${listed}`);
});

test("A5: `work show` on a legacy id refuses as an unknown id, pointing at search", async () =>
{
    const legacy = legacyUnit("A5: an outcome nobody can show");
    const refused = await selfIn(box, demo, ["work", "show", legacy]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`unknown work id "${legacy}"`));
    assert.match(refused.out, /self search/);
});

test("A6: a project whose work history is entirely legacy folds without an exception", async () =>
{
    const only = join(ws, "only");
    mkdirSync(only, { recursive: true });
    git(box, only, ["init", "-q", "-b", "main"]);
    await must(box, only, ["project", "init", "--name", "only", "--desc", "legacy only"]);
    for (const [index, type] of ["work.created", "work.started", "work.blocked", "work.done", "work.retired",
        "work.linked", "work.required", "work.covered", "work.proposed"].entries())
    {
        retireFixture(box, ws, "only", type, { work: "w-only1", outcome: "A6: the only outcome", on: "dependency", why: `line ${index}` });
    }
    const shown = await must(box, demo, ["context", "--project", "only"]);
    assert.equal(shown.code, 0);
    assert.ok(!shown.out.includes("A6: the only outcome"), `a legacy unit reached the render:\n${shown.out}`);
});

test("A7: a proposal recorded as `entity.proposed` still becomes a unit on accept", async () =>
{
    const id = await nativeProposal("A7: an outcome proposed by today's verb");
    await mustPerson(box, demo, ["work", "accept", id]);
    assert.ok((await must(box, demo, ["work"])).out.includes(id));
});

/* ── B. legacy proposals × answering them ──────────────────────────── */

test("B1: a `work.proposed` line is in no proposal list and no waiting count", async () =>
{
    const before = Number((await statusLine()).match(/waiting on you: (\d+)/)[1]);
    legacyLine("work.proposed", { outcome: "B1: an outcome proposed before the cutover", objective, ...BRIEF });
    assert.ok(!(await context()).includes("B1: an outcome proposed before the cutover"));
    assert.equal(Number((await statusLine()).match(/waiting on you: (\d+)/)[1]), before);
});

test("B2: accepting a legacy proposal by its event id is refused as no proposal", async () =>
{
    const id = legacyLine("work.proposed", { outcome: "B2: an outcome nobody can accept", objective, ...BRIEF });
    const refused = await personIn(box, demo, ["work", "accept", id]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`no work proposal matches "${id}"`));
});

test("B3: declining a legacy proposal by its event id is refused the same way", async () =>
{
    const id = legacyLine("work.proposed", { outcome: "B3: an outcome nobody can decline", objective, ...BRIEF });
    const refused = await selfIn(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`no work proposal matches "${id}"`));
});

test("B4: a legacy proposal an `entity.confirmed` line answered still becomes no unit", async () =>
{
    const id = legacyLine("work.proposed", { outcome: "B4: an outcome accepted by an older clone", objective, ...BRIEF });
    legacyLine("entity.confirmed", { entity: id }, { confirms: id });
    const listed = (await must(box, demo, ["work"])).out;
    assert.ok(!listed.includes("B4: an outcome accepted by an older clone"), `the accepted legacy proposal became a unit:\n${listed}`);
    assert.ok(!listed.includes(id), `the accepted legacy proposal became a unit:\n${listed}`);
});

test("B5: a proposal recorded today keeps its short-id waiting row", async () =>
{
    const id = await nativeProposal("B5: an outcome waiting on a person");
    assert.match(id, /^w-[0-9a-z]{5}$/);
    assert.ok((await context()).includes(`- work proposal ${id}: B5: an outcome waiting on a person`), await context());
});

test("B6: two legacy proposals written in one millisecond leave no prefix to collide", async () =>
{
    const millisecond = "01hz000000";
    const ts = new Date().toISOString();
    for (const tail of ["b6aaaaaaaaaaaaaa", "b6bbbbbbbbbbbbbb"])
    {
        logFixture(ws, "demo", {
            id: millisecond + tail, ts, type: "work.proposed", project: "demo",
            origin: { actor: "agent", confirmed: false },
            payload: { outcome: `B6: one of a burst (${tail})`, objective, ...BRIEF }, refs: {}
        });
    }
    const shown = await context();
    assert.ok(!shown.includes("B6: one of a burst"), `a legacy proposal from the burst reached the waiting band:\n${shown}`);
    assert.equal((await personIn(box, demo, ["work", "accept", millisecond])).code, 1);
});

test("B7: a legacy proposal's text is found by no search", async () =>
{
    legacyLine("work.proposed", { outcome: "B7: an outcome no search finds", objective, ...BRIEF });
    assert.equal((await must(box, demo, ["search", "B7: an outcome no search finds"])).out.trim(), "no matches");
});

/* ── C. legacy execution transitions × the fold ────────────────────── */

test("C1: `work.created` followed by `work.started` folds to no unit", async () =>
{
    const work = legacyUnit("C1: an outcome someone picked up");
    legacyLine("work.started", { work });
    assert.ok(!(await must(box, demo, ["work"])).out.includes(work));
});

test("C2: `work.blocked` on a legacy unit raises no waiting row", async () =>
{
    const work = legacyUnit("C2: an outcome parked on a ruling");
    legacyLine("work.blocked", { work, on: "decision", why: "C2: pricing undecided" });
    assert.ok(!(await context()).includes("C2: pricing undecided"), await context());
});

test("C3: `work.done` on a legacy unit closes nothing, because there is nothing to close", async () =>
{
    const work = legacyUnit("C3: an outcome an older binary closed");
    legacyLine("work.done", { work });
    assert.match(await statusLine(), /work: [^\n]*\b0 done\b/);
});

test("C4: `work.retired` on a legacy unit leaves no retired unit", async () =>
{
    const work = legacyUnit("C4: an outcome given up before the cutover");
    legacyLine("work.retired", { work, why: "C4: superseded" });
    assert.ok(!(await must(box, demo, ["work"])).out.includes(work));
    assert.ok(!(await context()).includes("C4: superseded"));
});

test("C5: `work.linked` from a legacy unit contributes to no objective", async () =>
{
    const work = legacyUnit("C5: an outcome linked before the cutover");
    legacyLine("work.linked", { work, objective });
    const shown = (await must(box, demo, ["objective", "show", objective])).out;
    assert.ok(!shown.includes(work), `a legacy unit is still cited as a contribution:\n${shown}`);
});

test("C6: an entity unit moved by `entity.started` reads in-progress as it always did", async () =>
{
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "C6: an outcome moved today"])).out);
    await must(box, demo, ["work", "start", work]);
    assert.match((await must(box, demo, ["work", "show", work])).out, /- Status: active/);
});

test("C7: a `work.blocked` line merged onto a native unit is ignored rather than refused", async () =>
{
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "C7: an outcome an old clone blocked"])).out);
    legacyLine("work.blocked", { work, on: "dependency", why: "C7: the upstream fix" });
    const shown = await must(box, demo, ["work", "show", work]);
    assert.equal(shown.code, 0);
    assert.match(shown.out, /- Status: next/);
    assert.ok(!shown.out.includes("C7: the upstream fix"), shown.out);
});

test("C8: a live milestone linked only to legacy units renders no work, and its criteria do not move", async () =>
{
    const milestone = (await must(box, demo, ["milestone", "add", "C8: suite green", "--objective", objective, "--exit", "C8: tests pass"]))
        .out.match(/\bm-[0-9a-z]{5}\b/)[0];
    const before = (await must(box, demo, ["milestone", "show", milestone])).out;
    const work = legacyUnit("C8: an outcome the milestone counted");
    legacyLine("work.linked", { work, milestone });
    const after = (await must(box, demo, ["milestone", "show", milestone])).out;
    assert.equal(after, before, `linking a legacy unit changed the milestone page:\n${after}`);
    assert.ok(after.includes("- Work: none linked"), after);
    assert.ok(after.includes("- c1 — C8: tests pass _(open)_"), after);
    assert.ok((await must(box, demo, ["milestone"])).out.includes(`${milestone}  unstarted  C8: suite green — no work linked yet [no work linked]`),
        (await must(box, demo, ["milestone"])).out);
});

/* ── E. reports and receipts that name a dropped unit ──────────────── */

test("E1: a report naming a legacy unit attaches to nothing, as a report naming an unknown unit does", async () =>
{
    const work = legacyUnit("E1: an outcome someone reported on");
    legacyLine("report.added", { text: "E1: the report from before" }, { work });
    const shown = await context();
    assert.ok(!(await must(box, demo, ["work"])).out.includes(work), "the reported-on legacy unit is listed");
    assert.ok(!shown.includes("E1: the report from before"), shown);
});

test("E2: the same report event still prints on `self log`", async () =>
{
    assert.match(await log(), /E1: the report from before/);
});

test("E3: a report naming a native unit attaches as it always did", async () =>
{
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "E3: an outcome reported on today"])).out);
    await must(box, demo, ["report", work, "E3: the report from today"]);
    assert.match((await must(box, demo, ["work", "show", work])).out, /E3: the report from today/);
});

test("E4: a review receipt naming a legacy unit folds to nothing without an exception", async () =>
{
    const work = legacyUnit("E4: an outcome someone reviewed");
    legacyLine("review.received", { receipt: "rc-e4", verdict: "pass", model: "a model" }, { work });
    assert.equal((await selfIn(box, demo, ["fold"])).code, 0);
    assert.equal((await selfIn(box, demo, ["context"])).code, 0);
    assert.ok(!(await must(box, demo, ["work"])).out.includes(work), "the reviewed legacy unit is listed");
});

/* ── F. `self log`, the surface the dropped records stay readable on ── */

test("F1: a `work.created` line prints as a human-readable row", async () =>
{
    const work = legacyUnit("F1: an outcome only the log remembers");
    const row = (await log()).split("\n").find((line) => line.includes("F1: an outcome only the log remembers"));
    assert.notEqual(row, undefined, "the creation event never printed");
    assert.ok(row.includes("work.created"), row);
    assert.ok(row.includes(work), row);
    assert.doesNotMatch(row, /"type":|"payload":|"origin":/, `a raw event object reached the answer: ${row}`);
});

test("F2: `work.proposed`, `work.required` and `work.covered` all print, none of them raw", async () =>
{
    const work = legacyUnit("F2: an outcome with criteria");
    legacyLine("work.required", { work, requirement: "r1", text: "F2: the criterion" });
    legacyLine("work.covered", { work, requirement: "r1", why: "F2: the judgment", requirementRevision: 1 });
    legacyLine("work.proposed", { outcome: "F2: an outcome proposed", objective, ...BRIEF });
    const printed = (await log()).split("\n");
    for (const type of ["work.required", "work.covered", "work.proposed"])
    {
        const row = printed.find((line) => line.includes(type));
        assert.notEqual(row, undefined, `${type} never printed`);
        assert.doesNotMatch(row, /"type":|"payload":|"origin":/, `a raw event object reached the answer: ${row}`);
    }
});

test("F3: an evidence-free `work.done` prints, and closes no unit", async () =>
{
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "F3: an outcome an older binary closed"])).out);
    legacyLine("work.done", { work });
    const shown = (await must(box, demo, ["work", "show", work])).out;
    assert.match(shown, /- Status: next/, `the fold read a legacy done:\n${shown}`);
    assert.match(shown, /- Not done yet:/, shown);
    assert.ok((await log()).split("\n").some((line) => line.includes("work.done") && line.includes(work)), "the done event never printed");
});

test("F4: legacy and native lines print together, in the order they were written", async () =>
{
    const rows = (await log()).split("\n").filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line));
    const stamps = rows.map((line) => line.slice(0, 24));
    assert.deepEqual(stamps, [...stamps].sort(), "the log did not print in timestamp order");
    assert.ok(rows.some((line) => line.includes("work.created")), "no legacy line printed");
    assert.ok(rows.some((line) => line.includes("entity.confirmed")), "no native line printed");
});

test("F5: a legacy id resolves to no record, and refuses rather than throwing", async () =>
{
    const work = legacyUnit("F5: an outcome with a history nobody can read");
    const refused = await selfIn(box, demo, ["state", "show", work, "--history"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`unknown entity "${work}"`));
    assert.equal((await must(box, demo, ["search", "F5: an outcome with a history nobody can read"])).out.trim(), "no matches");
});

test("R1: `work.run-started` puts a native unit's process at running", async () =>
{
    const work = workIdIn((await mustPerson(runBox, runDemo, ["work", "add", "R1: an outcome with a run"])).out);
    retireFixture(runBox, runWs, "demo", "work.run-started", { work });
    assert.match((await must(runBox, runDemo, ["work", "show", work])).out, /- Process: running at /);
});

test("R2: `work.run-exited` puts it at exited, with the code it carried", async () =>
{
    const work = workIdIn((await mustPerson(runBox, runDemo, ["work", "add", "R2: an outcome whose run ended"])).out);
    retireFixture(runBox, runWs, "demo", "work.run-started", { work });
    retireFixture(runBox, runWs, "demo", "work.run-exited", { work, code: 0 });
    assert.match((await must(runBox, runDemo, ["work", "show", work])).out, /- Process: exited \(code 0\) at /);
});

test("R3: a run event naming a legacy unit attaches to nothing, and is no error", async () =>
{
    retireFixture(runBox, runWs, "demo", "work.created", { work: "w-legr3", outcome: "R3: an outcome from before" });
    retireFixture(runBox, runWs, "demo", "work.run-started", { work: "w-legr3" }, { branch: "run/r3" });
    assert.equal((await selfIn(runBox, runDemo, ["fold"])).code, 0);
    assert.equal((await selfIn(runBox, runDemo, ["work", "show", "w-legr3"])).code, 1);
    assert.ok(!(await must(runBox, runDemo, ["work"])).out.includes("w-legr3"), "a run event revived a dropped unit");
});

test("R4: a run event naming a unit nothing knows is ignored, and is no error", async () =>
{
    retireFixture(runBox, runWs, "demo", "work.run-exited", { work: "w-nobod", code: 1 });
    assert.equal((await selfIn(runBox, runDemo, ["context"])).code, 0);
    assert.equal((await selfIn(runBox, runDemo, ["status"])).code, 0);
});

test("R5: a run event moves the unit's last-event time, so a running unit is not stalled", async () =>
{
    const work = workIdIn((await mustPerson(runBox, runDemo, ["work", "add", "R5: an outcome running for a while"])).out);
    logFixture(runWs, "demo", {
        id: "01hz0000000000000000000r51", ts: "2025-01-01T00:00:00.000Z", type: "entity.started", project: "demo",
        payload: { entity: work }, refs: {}, origin: {}
    });
    assert.match((await must(runBox, runDemo, ["status"])).out, new RegExp(`${work} looks stalled`));
    retireFixture(runBox, runWs, "demo", "work.run-started", { work });
    assert.doesNotMatch((await must(runBox, runDemo, ["status"])).out, new RegExp(`${work} looks stalled`),
        "a unit whose run just started still reads as stalled");
});

test("R6: a run event's branch reaches the unit's page", async () =>
{
    const work = workIdIn((await mustPerson(runBox, runDemo, ["work", "add", "R6: an outcome run on a branch"])).out);
    retireFixture(runBox, runWs, "demo", "work.run-started", { work }, { branch: "run/r6" });
    const page = readFileSync(join(runWs, ".superself", "projects", "demo", "work", `${work}.md`), "utf8");
    assert.match(page, /- Branches: run\/r6/);
});
