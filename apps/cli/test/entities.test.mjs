// The legacy interpretation (#197 §8): the fold reads goal.set, decision.*,
// convention.*, objective.* and milestone.* events as entities — mapped
// labels, default placements, the shared lifecycle — without a stored event
// changing. Asserted against real logs the current verbs write, plus the
// hand-appended edges no current verb can mint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, idIn, machine, must } from "./harness.mjs";

const box = machine();
const { demo } = demoWorkspace(box);

// The record ids the goal verbs print on their own line: o-xxxxx, m-xxxxx.
function shortIdIn(text, prefix)
{
    const match = text.match(new RegExp(`\\b${prefix}-[0-9a-z]{5}\\b`));
    if (match === null)
    {
        throw new Error(`no ${prefix}- id in: ${text}`);
    }
    return match[0];
}

test("a goal.set chain folds to exactly one live goal entity with supersede lineage", () =>
{
    const first = idIn(must(box, demo, ["goal", "set", "first direction"]).out);
    const second = idIn(must(box, demo, ["goal", "set", "second direction"]).out);
    const list = must(box, demo, ["state", "list"]).out;
    const goals = list.split("\n").filter((line) => /\bgoal\b/.test(line));
    assert.equal(goals.length, 1, `expected one live goal entity:\n${list}`);
    assert.ok(goals[0].includes("second direction"));
    assert.ok(goals[0].includes("full p0"), "the goal entity lost its default placement");
    const replaced = must(box, demo, ["state", "show", first]).out;
    assert.ok(replaced.includes("superseded"));
    assert.ok(replaced.includes(`superseded by: ${second}`));
    assert.ok(must(box, demo, ["state", "show", second]).out.includes(`link: supersedes ${first}`));
});

test("decision lifecycles read as decision-labeled index entities", () =>
{
    const declined = idIn(must(box, demo, ["decide", "try direction a", "--proposed"]).out);
    must(box, demo, ["decide", "decline", declined, "--why", "not now"]);
    const retracted = idIn(must(box, demo, ["decide", "hold direction b"]).out);
    must(box, demo, ["decide", "retract", retracted, "--why", "walked back"]);
    const replaced = idIn(must(box, demo, ["decide", "ship weekly"]).out);
    const successor = idIn(must(box, demo, ["decide", "ship daily", "--supersedes", replaced]).out);
    const live = must(box, demo, ["state", "show", successor]).out;
    assert.ok(live.includes("confirmed  (from decision)"));
    assert.ok(live.includes("labels: decision"));
    assert.ok(live.includes("placement: project · index · priority 40"));
    assert.ok(live.includes(`link: supersedes ${replaced}`));
    assert.ok(must(box, demo, ["state", "show", replaced]).out.includes(`superseded by: ${successor}`));
    const down = must(box, demo, ["state", "show", declined]).out;
    assert.ok(down.includes("retracted"), "a declined proposal still reads live in the entity view");
    assert.ok(down.includes("closed: not now"));
    assert.ok(must(box, demo, ["state", "show", retracted]).out.includes("closed: walked back"));
    const list = must(box, demo, ["state", "list"]).out;
    for (const gone of ["try direction a", "hold direction b", "ship weekly"])
    {
        assert.ok(!list.includes(gone), `"${gone}" still lists as live`);
    }
    assert.ok(list.includes("ship daily"));
});

test("a dropped convention reads retracted with its why; a correction supersedes", () =>
{
    const dropped = idIn(must(box, demo, ["convention", "add", "tabs everywhere"]).out);
    must(box, demo, ["convention", "drop", dropped, "--why", "spaces won"]);
    const shown = must(box, demo, ["state", "show", dropped]).out;
    assert.ok(shown.includes("retracted"));
    assert.ok(shown.includes("closed: spaces won"));
    assert.ok(shown.includes("labels: convention"));
    const old = idIn(must(box, demo, ["convention", "add", "four space indent"]).out);
    const corrected = idIn(must(box, demo, ["convention", "add", "four space indent, semicolons", "--supersedes", old]).out);
    assert.ok(must(box, demo, ["state", "show", old]).out.includes(`superseded by: ${corrected}`));
    assert.ok(must(box, demo, ["state", "show", corrected]).out.includes("placement: project · full · priority 30"));
});

test("objective create, revise and close fold to one full-exposure objective entity", () =>
{
    const objective = shortIdIn(must(box, demo, ["objective", "add", "reach preview", "--target", "2030-01-01"]).out, "o");
    let shown = must(box, demo, ["state", "show", objective]).out;
    assert.ok(shown.includes("labels: objective"));
    assert.ok(shown.includes("placement: project · full · priority 10"));
    assert.ok(shown.includes("target: 2030-01-01"));
    must(box, demo, ["objective", "revise", objective, "--why", "slipped", "--target", "2030-06-30"]);
    assert.ok(must(box, demo, ["state", "show", objective]).out.includes("target: 2030-06-30"),
        "a revision's target did not reach the entity view");
    must(box, demo, ["objective", "close", objective, "--as", "dropped", "--why", "descoped"]);
    shown = must(box, demo, ["state", "show", objective]).out;
    assert.ok(shown.includes("retracted"));
    assert.ok(shown.includes("closed: descoped"));
    assert.ok(!must(box, demo, ["state", "list"]).out.includes("reach preview"));
});

test("a reached objective and a declined proposal both leave the live entity set", () =>
{
    const reached = shortIdIn(must(box, demo, ["objective", "add", "land the tier"]).out, "o");
    must(box, demo, ["objective", "close", reached, "--as", "reached"]);
    const closed = must(box, demo, ["state", "show", reached]).out;
    assert.ok(closed.includes("retracted"));
    assert.ok(closed.includes("closed: reached"));
    const proposed = shortIdIn(must(box, demo, ["objective", "add", "maybe someday", "--proposed"]).out, "o");
    assert.ok(must(box, demo, ["state", "list"]).out.includes("maybe someday"), "a proposed objective is a live entity");
    must(box, demo, ["objective", "decline", proposed, "--why", "off goal"]);
    assert.ok(!must(box, demo, ["state", "list"]).out.includes("maybe someday"));
    assert.ok(must(box, demo, ["state", "show", proposed]).out.includes("closed: off goal"));
});

test("a milestone folds to an index entity with criteria and its objective grouping", () =>
{
    const objective = shortIdIn(must(box, demo, ["objective", "add", "preview quality"]).out, "o");
    const milestone = shortIdIn(must(box, demo, ["milestone", "add", "suite green", "--objective", objective,
        "--exit", "all tests pass", "--exit", "docs updated"]).out, "m");
    const shown = must(box, demo, ["state", "show", milestone]).out;
    assert.ok(shown.includes("labels: milestone"));
    assert.ok(shown.includes("placement: project · index · priority 20"));
    assert.ok(shown.includes("criterion: all tests pass"));
    assert.ok(shown.includes("criterion: docs updated"));
    assert.ok(shown.includes(`link: member-of ${objective}`));
    const successor = shortIdIn(must(box, demo, ["milestone", "add", "suite green on ci", "--objective", objective,
        "--exit", "ci green", "--supersedes", milestone]).out, "m");
    assert.ok(must(box, demo, ["state", "show", milestone]).out.includes(`superseded by: ${successor}`));
    assert.ok(must(box, demo, ["state", "show", successor]).out.includes(`link: supersedes ${milestone}`));
    must(box, demo, ["milestone", "drop", successor, "--why", "checkpoint removed"]);
    const droppedShown = must(box, demo, ["state", "show", successor]).out;
    assert.ok(droppedShown.includes("retracted"));
    assert.ok(droppedShown.includes("closed: checkpoint removed"));
});

test("an orphan milestone folds to nothing, and merge-ordered entity lines still settle", () =>
{
    const log = join(box.root, "ws", ".superself", "projects", "demo", "log.jsonl");
    const lines = [
        // A milestone whose objective this store never saw: the fold drops it.
        { id: "01hz000000000000000000000a", ts: "2025-01-01T00:00:00.000Z", type: "milestone.created", project: "demo", payload: { milestone: "m-orphn", objective: "o-none0", outcome: "orphan checkpoint", exit: [{ id: "c1", text: "x" }] }, refs: {}, origin: {} },
        // A retraction above the creation it withdraws, as a union merge can order them.
        { id: "01hz000000000000000000000b", ts: "2025-01-01T00:01:00.000Z", type: "entity.retracted", project: "demo", payload: { entity: "e-mrgd1", why: "withdrawn elsewhere" }, refs: {}, origin: {} },
        { id: "01hz000000000000000000000c", ts: "2025-01-01T00:02:00.000Z", type: "entity.confirmed", project: "demo", payload: { entity: "e-mrgd1", text: "merged entity", labels: ["note"], links: [], criteria: [], exposure: "index", scope: "project" }, refs: {}, origin: {} },
        // A standalone supersession claim ahead of both records it names.
        { id: "01hz000000000000000000000d", ts: "2025-01-01T00:03:00.000Z", type: "entity.superseded", project: "demo", payload: { entity: "e-mrgd2", successor: "e-mrgd3" }, refs: {}, origin: {} },
        { id: "01hz000000000000000000000e", ts: "2025-01-01T00:04:00.000Z", type: "entity.confirmed", project: "demo", payload: { entity: "e-mrgd2", text: "older statement", labels: [], links: [], criteria: [], exposure: "index", scope: "project" }, refs: {}, origin: {} },
        { id: "01hz000000000000000000000f", ts: "2025-01-01T00:05:00.000Z", type: "entity.confirmed", project: "demo", payload: { entity: "e-mrgd3", text: "newer statement", labels: [], links: [], criteria: [], exposure: "index", scope: "project" }, refs: {}, origin: {} }
    ];
    appendFileSync(log, lines.map((line) => JSON.stringify(line) + "\n").join(""));
    must(box, demo, ["fold"]);
    const list = must(box, demo, ["state", "list"]).out;
    assert.ok(!list.includes("orphan checkpoint"), "an orphan milestone reached the entity view");
    assert.ok(!list.includes("merged entity"), "a retraction ordered before its record did not settle");
    const merged = must(box, demo, ["state", "show", "e-mrgd1"]).out;
    assert.ok(merged.includes("retracted"));
    assert.ok(merged.includes("closed: withdrawn elsewhere"));
    assert.ok(must(box, demo, ["state", "show", "e-mrgd2"]).out.includes("superseded by: e-mrgd3"));
    assert.ok(list.includes("newer statement"));
});
