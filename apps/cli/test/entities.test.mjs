// The legacy interpretation (#197 §8): the fold reads goal.set, decision.*,
// convention.*, objective.* and milestone.* events as entities — mapped
// labels, default placements, the shared lifecycle — without a stored event
// changing. Asserted against real logs the current verbs write, plus the
// hand-appended edges no current verb can mint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, idIn, machine, must } from "./harness.mjs";

const box = machine();
const { demo } = demoWorkspace(box);

// Destroying a record needs a person at a terminal (#173): the command line
// runs in full and only the typed answer is stood in for.
const approved = (args, answer) => approvedIn(box, demo, args, answer);

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

// `goal set` is gone (w-1r025) and a new goal displaces nothing, so the
// implicit chain only exists in logs written before that — which is where it
// is asserted, on the interpretation the fold keeps reading forever.
const LEGACY_GOALS = ["01hz00000000000000000g0001", "01hz00000000000000000g0002"];

test("a legacy goal.set chain folds to exactly one live goal entity with supersede lineage", () =>
{
    const [first, second] = LEGACY_GOALS;
    appendLegacy([
        { id: first, ts: "2025-01-02T00:00:00.000Z", type: "goal.set", project: "demo", payload: { text: "first direction" }, refs: {}, origin: {} },
        { id: second, ts: "2025-01-02T00:01:00.000Z", type: "goal.set", project: "demo", payload: { text: "second direction" }, refs: {}, origin: {} }
    ]);
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

test("decision lifecycles read as decision-labeled index entities", async () =>
{
    const declined = idIn(must(box, demo, ["decide", "try direction a", "--proposed"]).out);
    must(box, demo, ["decide", "decline", declined, "--why", "not now"]);
    const retracted = idIn(must(box, demo, ["decide", "hold direction b"]).out);
    await approved(["decide", "retract", retracted, "--why", "walked back"], retracted);
    const replaced = idIn(must(box, demo, ["decide", "ship weekly"]).out);
    const successor = idIn((await approved(["decide", "ship daily", "--supersedes", replaced], replaced)).printed);
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

test("a dropped convention reads retracted with its why; a correction supersedes", async () =>
{
    const dropped = idIn(must(box, demo, ["convention", "add", "tabs everywhere"]).out);
    await approved(["convention", "drop", dropped, "--why", "spaces won"], dropped);
    const shown = must(box, demo, ["state", "show", dropped]).out;
    assert.ok(shown.includes("retracted"));
    assert.ok(shown.includes("closed: spaces won"));
    assert.ok(shown.includes("labels: convention"));
    const old = idIn(must(box, demo, ["convention", "add", "four space indent"]).out);
    const corrected = idIn((await approved(["convention", "add", "four space indent, semicolons", "--supersedes", old], old)).printed);
    assert.ok(must(box, demo, ["state", "show", old]).out.includes(`superseded by: ${corrected}`));
    assert.ok(must(box, demo, ["state", "show", corrected]).out.includes("placement: project · full · priority 30"));
});

// The objective and milestone legacy interpretations are asserted over
// hand-appended `objective.*`/`milestone.*` lines: the verbs write the shared
// entity grammar since the cutover (#207 B), and only a pre-cutover log
// carries these event types — which the fold keeps reading forever (spec §8).
function appendLegacy(lines)
{
    const log = join(box.root, "ws", ".superself", "projects", "demo", "log.jsonl");
    appendFileSync(log, lines.map((line) => JSON.stringify(line) + "\n").join(""));
    must(box, demo, ["fold"]);
}

test("legacy objective create, revise and close fold to one full-exposure objective entity", () =>
{
    appendLegacy([
        { id: "01hz0000000000000000000o01", ts: "2025-01-02T00:00:00.000Z", type: "objective.created", project: "demo", payload: { objective: "o-lega1", outcome: "reach preview", target: "2030-01-01", success: [], stop: [] }, refs: {}, origin: {} }
    ]);
    let shown = must(box, demo, ["state", "show", "o-lega1"]).out;
    assert.ok(shown.includes("labels: objective"));
    assert.ok(shown.includes("placement: project · full · priority 10"));
    assert.ok(shown.includes("target: 2030-01-01"));
    appendLegacy([
        { id: "01hz0000000000000000000o02", ts: "2025-01-02T00:01:00.000Z", type: "objective.revised", project: "demo", payload: { objective: "o-lega1", why: "slipped", target: "2030-06-30" }, refs: {}, origin: {} }
    ]);
    assert.ok(must(box, demo, ["state", "show", "o-lega1"]).out.includes("target: 2030-06-30"),
        "a revision's target did not reach the entity view");
    appendLegacy([
        { id: "01hz0000000000000000000o03", ts: "2025-01-02T00:02:00.000Z", type: "objective.closed", project: "demo", payload: { objective: "o-lega1", as: "dropped", why: "descoped" }, refs: {}, origin: {} }
    ]);
    shown = must(box, demo, ["state", "show", "o-lega1"]).out;
    assert.ok(shown.includes("retracted"));
    assert.ok(shown.includes("closed: descoped"));
    assert.ok(!must(box, demo, ["state", "list"]).out.includes("reach preview"));
});

test("a reached legacy objective and a declined legacy proposal both leave the live entity set", () =>
{
    appendLegacy([
        { id: "01hz0000000000000000000o04", ts: "2025-01-02T00:03:00.000Z", type: "objective.created", project: "demo", payload: { objective: "o-lega2", outcome: "land the tier", success: [], stop: [] }, refs: {}, origin: {} },
        { id: "01hz0000000000000000000o05", ts: "2025-01-02T00:04:00.000Z", type: "objective.closed", project: "demo", payload: { objective: "o-lega2", as: "reached" }, refs: {}, origin: {} }
    ]);
    const closed = must(box, demo, ["state", "show", "o-lega2"]).out;
    assert.ok(closed.includes("retracted"));
    assert.ok(closed.includes("closed: reached"));
    appendLegacy([
        { id: "01hz0000000000000000000o06", ts: "2025-01-02T00:05:00.000Z", type: "objective.created", project: "demo", payload: { objective: "o-lega3", outcome: "maybe someday", proposed: true, success: [], stop: [] }, refs: {}, origin: {} }
    ]);
    assert.ok(must(box, demo, ["state", "list"]).out.includes("maybe someday"), "a proposed objective is a live entity");
    appendLegacy([
        { id: "01hz0000000000000000000o07", ts: "2025-01-02T00:06:00.000Z", type: "objective.declined", project: "demo", payload: { objective: "o-lega3", why: "off goal" }, refs: {}, origin: {} }
    ]);
    assert.ok(!must(box, demo, ["state", "list"]).out.includes("maybe someday"));
    assert.ok(must(box, demo, ["state", "show", "o-lega3"]).out.includes("closed: off goal"));
});

test("a legacy milestone folds to an index entity with criteria and its objective grouping", () =>
{
    appendLegacy([
        { id: "01hz0000000000000000000o08", ts: "2025-01-02T00:07:00.000Z", type: "objective.created", project: "demo", payload: { objective: "o-lega4", outcome: "preview quality", success: [], stop: [] }, refs: {}, origin: {} },
        { id: "01hz0000000000000000000m01", ts: "2025-01-02T00:08:00.000Z", type: "milestone.created", project: "demo", payload: { objective: "o-lega4", milestone: "m-lega1", outcome: "suite green", exit: [{ id: "c1", text: "all tests pass" }, { id: "c2", text: "docs updated" }] }, refs: {}, origin: {} }
    ]);
    const shown = must(box, demo, ["state", "show", "m-lega1"]).out;
    assert.ok(shown.includes("labels: milestone"));
    assert.ok(shown.includes("placement: project · index · priority 20"));
    assert.ok(shown.includes("criterion: all tests pass"));
    assert.ok(shown.includes("criterion: docs updated"));
    assert.ok(shown.includes("link: member-of o-lega4"));
    appendLegacy([
        { id: "01hz0000000000000000000m02", ts: "2025-01-02T00:09:00.000Z", type: "milestone.created", project: "demo", payload: { objective: "o-lega4", milestone: "m-lega2", outcome: "suite green on ci", exit: [{ id: "c1", text: "ci green" }], supersedes: "m-lega1" }, refs: {}, origin: {} }
    ]);
    assert.ok(must(box, demo, ["state", "show", "m-lega1"]).out.includes("superseded by: m-lega2"));
    assert.ok(must(box, demo, ["state", "show", "m-lega2"]).out.includes("link: supersedes m-lega1"));
    appendLegacy([
        { id: "01hz0000000000000000000m03", ts: "2025-01-02T00:10:00.000Z", type: "milestone.dropped", project: "demo", payload: { milestone: "m-lega2", why: "checkpoint removed" }, refs: {}, origin: {} }
    ]);
    const droppedShown = must(box, demo, ["state", "show", "m-lega2"]).out;
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

test("a standalone supersession claim settles only when its successor exists and was confirmed", () =>
{
    const log = join(box.root, "ws", ".superself", "projects", "demo", "log.jsonl");
    const lines = [
        { id: "01hz0000000000000000000010", ts: "2025-02-01T00:00:00.000Z", type: "entity.confirmed", project: "demo", payload: { entity: "e-supa1", text: "standing rule a", labels: [], links: [], criteria: [], exposure: "index", scope: "project" }, refs: {}, origin: {} },
        // A proposal that was never confirmed must displace nothing, however
        // the displacement is spelled — links or a standalone claim.
        { id: "01hz0000000000000000000011", ts: "2025-02-01T00:01:00.000Z", type: "entity.proposed", project: "demo", payload: { entity: "e-supb1", text: "unconfirmed proposal b", labels: [], links: [], criteria: [], exposure: "index", scope: "project" }, refs: {}, origin: {} },
        { id: "01hz0000000000000000000012", ts: "2025-02-01T00:02:00.000Z", type: "entity.superseded", project: "demo", payload: { entity: "e-supa1", successor: "e-supb1" }, refs: {}, origin: {} },
        // A successor this store never saw is no replacement either.
        { id: "01hz0000000000000000000013", ts: "2025-02-01T00:03:00.000Z", type: "entity.confirmed", project: "demo", payload: { entity: "e-supc1", text: "standing rule c", labels: [], links: [], criteria: [], exposure: "index", scope: "project" }, refs: {}, origin: {} },
        { id: "01hz0000000000000000000014", ts: "2025-02-01T00:04:00.000Z", type: "entity.superseded", project: "demo", payload: { entity: "e-supc1", successor: "e-nope99" }, refs: {}, origin: {} }
    ];
    appendFileSync(log, lines.map((line) => JSON.stringify(line) + "\n").join(""));
    must(box, demo, ["fold"]);
    const list = must(box, demo, ["state", "list"]).out;
    assert.ok(list.includes("standing rule a"), "an unconfirmed proposal displaced a confirmed entity through a standalone claim");
    assert.ok(list.includes("standing rule c"), "a nonexistent successor displaced a confirmed entity");
    assert.ok(must(box, demo, ["state", "show", "e-supa1"]).out.includes("confirmed"));
});

// The revision fold (#356). Asserted on hand-appended lines, because what
// makes the numbering worth stating is exactly what no local run produces: a
// clock-skewed revision from another clone, and an acceptance that names a
// version rather than the record.
function appendEntity(lines)
{
    const log = join(box.root, "ws", ".superself", "projects", "demo", "log.jsonl");
    appendFileSync(log, lines.map((line) => JSON.stringify(line) + "\n").join(""));
    must(box, demo, ["fold"]);
}

function revisionLine(id, event, ts, text)
{
    return { id: event, ts, type: "entity.revised", project: "demo", refs: {},
        origin: { actor: "agent", confirmed: false }, payload: { entity: id, text, why: "a clone said so" } };
}

test("the creation is v1 however late its timestamp reads, and the rest sort by (ts, event id)", () =>
{
    const id = "w-revn1";
    appendEntity([
        // Written last, timestamped first: a revision pulled from a clock-skewed
        // clone must not turn the creation into a later version of itself.
        { id: "01hz00000000000000000rev01", ts: "2025-06-01T00:00:00.000Z", type: "entity.proposed", project: "demo", refs: {}, origin: { actor: "agent", confirmed: false }, payload: { entity: id, text: "the first plan", labels: ["work"], links: [], criteria: [], exposure: "search", scope: "project" } },
        revisionLine(id, "01hz00000000000000000rev02", "2025-01-01T00:00:00.000Z", "the skewed second plan"),
        revisionLine(id, "01hz00000000000000000rev03", "2025-01-01T00:00:00.000Z", "the skewed third plan")
    ]);
    const page = must(box, demo, ["work", "show", id]).out;
    assert.ok(page.includes("the skewed third plan"), `the id did not break the timestamp tie:\n${page}`);
    assert.ok(page.includes("- Plan: v3 — not yet accepted"), `the creation was not counted as v1:\n${page}`);
});

test("an acceptance naming a revision event confirms the record it belongs to", () =>
{
    const id = "w-revn2";
    appendEntity([
        { id: "01hz00000000000000000rev10", ts: "2025-06-01T00:00:00.000Z", type: "entity.proposed", project: "demo", refs: {}, origin: { actor: "agent", confirmed: false }, payload: { entity: id, text: "the first plan", labels: ["work"], links: [], criteria: [], exposure: "search", scope: "project" } },
        revisionLine(id, "01hz00000000000000000rev11", "2025-06-02T00:00:00.000Z", "the second plan"),
        { id: "01hz00000000000000000rev12", ts: "2025-06-03T00:00:00.000Z", type: "entity.confirmed", project: "demo", refs: { confirms: "01hz00000000000000000rev11" }, origin: { actor: "agent", confirmed: true }, payload: { entity: id } }
    ]);
    const page = must(box, demo, ["work", "show", id]).out;
    assert.ok(page.includes("- Status: next"), `a confirm naming the revision did not confirm the record:\n${page}`);
    assert.ok(!page.includes("- Plan:"), "an accepted current plan still reads as waiting");
    // And a third version leaves that acceptance behind, without unmaking it.
    appendEntity([revisionLine(id, "01hz00000000000000000rev13", "2025-06-04T00:00:00.000Z", "the third plan")]);
    const again = must(box, demo, ["work", "show", id]).out;
    assert.ok(again.includes("- Plan: v3 (current) · v2 accepted"), `the stale acceptance is not stated:\n${again}`);
    assert.ok(again.includes("- Status: review"));
});
