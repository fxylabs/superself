// The preset write cutover (#207 B): every preset verb records shared-grammar
// `entity.*` events — asserted against the log lines the verbs actually
// append, the folded placement, and the printed output (ruling ②). Each test
// derives from its B cell; B14's regression net is the phase 3 suite, cited
// at the bottom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = demoWorkspace(box);
const log = join(box.root, "ws", ".superself", "projects", "demo", "log.jsonl");
const self = (args) => selfIn(box, demo, args);

function events()
{
    return readFileSync(log, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

function eventFor(id, type)
{
    return events().find((event) => event.type === type && event.payload.entity === id);
}

function shown(id)
{
    return must(box, demo, ["state", "show", id]).out;
}

test("B1: goal set records entity.confirmed at goal placement and supersedes the previous goal", () =>
{
    const first = idIn(must(box, demo, ["goal", "set", "first direction"]).out);
    const printed = must(box, demo, ["goal", "set", "second direction"]).out;
    assert.match(printed, /entity\.confirmed recorded/);
    const second = idIn(printed);
    const recorded = eventFor(second, "entity.confirmed");
    assert.deepEqual(recorded.payload.labels, ["goal"]);
    assert.equal(recorded.payload.priority, 0);
    assert.equal(recorded.payload.exposure, "full");
    assert.ok(shown(first).includes(`superseded by: ${second}`));
    assert.match(must(box, demo, ["status"]).out, /goal: second direction/);
});

test("B2: decide records entity.confirmed labeled decision at index p40", () =>
{
    const id = idIn(must(box, demo, ["decide", "keep sqlite", "--why", "simple"]).out);
    const recorded = eventFor(id, "entity.confirmed");
    assert.deepEqual(recorded.payload.labels, ["decision"]);
    assert.equal(recorded.payload.priority, 40);
    assert.equal(recorded.payload.exposure, "index");
    assert.equal(recorded.payload.why, "simple");
});

test("B3: decide --proposed records entity.proposed, and decide confirm answers it", () =>
{
    const id = idIn(must(box, demo, ["decide", "adopt turso", "--proposed"]).out);
    assert.notEqual(eventFor(id, "entity.proposed"), undefined);
    const confirmed = must(box, demo, ["decide", "confirm", id]);
    assert.match(confirmed.out, /entity\.confirmed recorded/);
    const answer = events().find((event) => event.type === "entity.confirmed" && event.refs?.confirms === id);
    assert.notEqual(answer, undefined, "the confirm did not reference the proposal");
    assert.ok(shown(id).includes("confirmed"));
});

test("B4: decline and retract record entity.retracted, and the declined proposal keeps its marker", () =>
{
    const declined = idIn(must(box, demo, ["decide", "maybe queue", "--proposed"]).out);
    must(box, demo, ["decide", "decline", declined, "--why", "not now"]);
    assert.equal(eventFor(declined, "entity.retracted").payload.why, "not now");
    assert.match(must(box, demo, ["search", "maybe queue", "--type", "entity"]).out, /\[declined\]/);
    const retracted = idIn(must(box, demo, ["decide", "temp rule"]).out);
    must(box, demo, ["decide", "retract", retracted, "--why", "walked back"]);
    assert.match(must(box, demo, ["search", "temp rule", "--type", "entity"]).out, /\[retracted\]/);
});

test("B5: convention add records entity.confirmed at p30 full, with scope and supersedes carried", () =>
{
    const old = idIn(must(box, demo, ["convention", "add", "four spaces"]).out);
    const corrected = idIn(must(box, demo, ["convention", "add", "four spaces, semicolons", "--supersedes", old]).out);
    const recorded = eventFor(corrected, "entity.confirmed");
    assert.deepEqual(recorded.payload.labels, ["convention"]);
    assert.equal(recorded.payload.priority, 30);
    assert.equal(recorded.payload.exposure, "full");
    assert.deepEqual(recorded.payload.links, [{ type: "supersedes", target: old }]);
    assert.ok(shown(old).includes(`superseded by: ${corrected}`));
    const scoped = idIn(must(box, demo, ["convention", "add", "shared rule", "--workspace"]).out);
    assert.equal(eventFor(scoped, "entity.confirmed").payload.scope, "workspace");
});

test("B6: convention drop records entity.retracted and the rule leaves the render", () =>
{
    const id = idIn(must(box, demo, ["convention", "add", "tabs everywhere"]).out);
    const printed = must(box, demo, ["convention", "drop", id, "--why", "spaces won"]);
    assert.match(printed.out, /entity\.retracted recorded/);
    assert.equal(eventFor(id, "entity.retracted").payload.why, "spaces won");
    assert.ok(!must(box, demo, ["context"]).out.includes("tabs everywhere"));
});

test("B7: objective add records entity.confirmed with target metadata and unvalidated legacy fields", () =>
{
    const printed = must(box, demo, ["objective", "add", "reach preview",
        "--horizon", "fortnight", "--target", "2099-01-01", "--success", "it ships", "--stop", "if superseded"]).out;
    const id = printed.match(/\bo-[0-9a-z]{5}\b/)[0];
    const recorded = eventFor(id, "entity.confirmed");
    assert.deepEqual(recorded.payload.labels, ["objective"]);
    assert.equal(recorded.payload.priority, 10);
    assert.equal(recorded.payload.exposure, "full");
    assert.equal(recorded.payload.target, "2099-01-01");
    // The horizon enum is gone: whatever span the caller states is recorded.
    assert.equal(recorded.payload.horizon, "fortnight");
    assert.match(must(box, demo, ["objective", "show", id]).out, /fortnight/);
});

test("B8: objective confirm and decline answer a proposal with entity events", () =>
{
    const confirmedId = must(box, demo, ["objective", "add", "confirm me", "--proposed"]).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    assert.notEqual(eventFor(confirmedId, "entity.proposed"), undefined);
    must(box, demo, ["objective", "confirm", confirmedId]);
    assert.ok(shown(confirmedId).includes("confirmed"));
    const declinedId = must(box, demo, ["objective", "add", "decline me", "--proposed"]).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    must(box, demo, ["objective", "decline", declinedId, "--why", "off goal"]);
    assert.equal(eventFor(declinedId, "entity.retracted").payload.why, "off goal");
    assert.ok(!must(box, demo, ["objective"]).out.includes("decline me"));
});

let preview;

test("B9: objective revise supersedes with a new id carrying the links and target", () =>
{
    preview = must(box, demo, ["objective", "add", "old target", "--target", "2099-03-01"]).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const printed = must(box, demo, ["objective", "revise", preview, "--why", "slipped", "--target", "2099-06-30"]).out;
    const successor = printed.match(/\bo-[0-9a-z]{5}\b/)[0];
    assert.notEqual(successor, preview, "a revision kept the record id");
    assert.ok(shown(preview).includes(`superseded by: ${successor}`));
    const page = shown(successor);
    assert.ok(page.includes("target: 2099-06-30"));
    assert.ok(page.includes(`link: supersedes ${preview}`));
    assert.ok(page.includes("placement: project · full · priority 10"));
    preview = successor;
});

test("B10: objective close maps reached to entity.done and dropped to entity.retired", () =>
{
    const reached = must(box, demo, ["objective", "add", "land the tier"]).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const printed = must(box, demo, ["objective", "close", reached, "--as", "reached"]);
    assert.match(printed.out, /entity\.done recorded/);
    assert.ok(!must(box, demo, ["objective"]).out.includes("land the tier"), "a reached objective still lists as open");
    const dropped = must(box, demo, ["objective", "add", "dead end"]).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    must(box, demo, ["objective", "close", dropped, "--as", "dropped", "--why", "descoped"]);
    assert.equal(eventFor(dropped, "entity.retired").payload.why, "descoped");
});

let milestone;

test("B11: milestone add records entity.confirmed with criteria and its member-of grouping", () =>
{
    milestone = must(box, demo, ["milestone", "add", "suite green", "--objective", preview,
        "--exit", "tests pass", "--exit", "docs updated"]).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    const recorded = eventFor(milestone, "entity.confirmed");
    assert.deepEqual(recorded.payload.labels, ["milestone"]);
    assert.equal(recorded.payload.priority, 20);
    assert.equal(recorded.payload.exposure, "index");
    assert.deepEqual(recorded.payload.criteria, ["tests pass", "docs updated"]);
    assert.deepEqual(recorded.payload.links, [{ type: "member-of", target: preview }]);
});

test("B12: met covers, reach is the gated done, revise supersedes, drop retires", () =>
{
    assert.match(must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "ran green"]).out,
        /entity\.covered recorded/);
    const early = self(["milestone", "reach", milestone]);
    assert.notEqual(early.code, 0);
    assert.match(early.out, /uncovered exit criteria/);
    must(box, demo, ["milestone", "met", milestone, "--criterion", "c2", "--why", "docs regenerated"]);
    assert.match(must(box, demo, ["milestone", "reach", milestone]).out, /entity\.done recorded/);
    const revised = must(box, demo, ["milestone", "add", "next checkpoint", "--objective", preview, "--exit", "one thing"]).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    const successor = must(box, demo, ["milestone", "revise", revised, "--why", "widened", "--exit", "another thing"]).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    assert.notEqual(successor, revised, "a revision kept the milestone id");
    assert.ok(shown(revised).includes(`superseded by: ${successor}`));
    assert.match(must(box, demo, ["milestone", "drop", successor, "--why", "checkpoint removed"]).out, /entity\.retired recorded/);
    assert.equal(eventFor(successor, "entity.retired").payload.why, "checkpoint removed");
});

test("B13: the work verbs record the entity lifecycle — add, propose, accept, decline, link, retire", () =>
{
    const work = workIdIn(must(box, demo, ["work", "add", "ship the cutover"]).out);
    assert.deepEqual(eventFor(work, "entity.confirmed").payload.labels, ["work"]);
    assert.equal(eventFor(work, "entity.confirmed").payload.exposure, "search");
    must(box, demo, ["work", "link", work, "--objective", preview]);
    assert.deepEqual(eventFor(work, "entity.linked").payload.link, { type: "member-of", target: preview });
    assert.match(must(box, demo, ["work", "show", work]).out, new RegExp(`Contributes to: ${preview}`));
    const proposal = workIdIn(must(box, demo, ["work", "propose", "a proposed direction", "--objective", preview,
        "--value", "closes the gap", "--success", "it ships", "--stop", "if superseded",
        "--risk", "low", "--capacity", "one round", "--evidence-plan", "a recorded run",
        "--confidence", "high", "--expires", "2099-01-01"]).out);
    const brief = eventFor(proposal, "entity.proposed");
    assert.equal(brief.payload.value, "closes the gap");
    assert.equal(brief.payload.expires, "2099-01-01");
    must(box, demo, ["work", "accept", proposal]);
    assert.notEqual(events().find((event) => event.type === "entity.confirmed" && event.refs?.confirms === proposal), undefined);
    assert.ok(must(box, demo, ["work"]).out.includes("a proposed direction"), "an accepted proposal did not become an open unit");
    const declined = workIdIn(must(box, demo, ["work", "propose", "a declined direction", "--objective", preview,
        "--value", "little", "--success", "s", "--stop", "s",
        "--risk", "low", "--capacity", "one round", "--evidence-plan", "a run",
        "--confidence", "low", "--expires", "2099-01-01"]).out);
    must(box, demo, ["work", "decline", declined, "--why", "not worth it"]);
    assert.equal(eventFor(declined, "entity.retracted").payload.why, "not worth it");
    must(box, demo, ["work", "retire", work, "--why", "moved", "--successor", proposal]);
    const retired = eventFor(work, "entity.retired");
    assert.equal(retired.payload.successor, proposal);
    assert.match(must(box, demo, ["work", "show", work]).out, /Retired: moved — successor/);
});

test("B14: work start/block/unblock/done record the phase 3 execution events through the shared gate", () =>
{
    // The regression net for the gate itself is the unchanged phase 3 suite:
    // test/execution.test.mjs section B ("B: no reports and no done-time text
    // refuses…" through "B: a report carrying commit evidence satisfies
    // done") and test/lifecycle.test.mjs "the work spine: add, start, report,
    // evidenced done as a judgment". Here: the recorded event types.
    const work = workIdIn(must(box, demo, ["work", "add", "exercise the spine"]).out);
    must(box, demo, ["work", "start", work]);
    assert.notEqual(eventFor(work, "entity.started"), undefined);
    must(box, demo, ["work", "block", work, "--on", "external", "--why", "vendor wait"]);
    assert.equal(eventFor(work, "entity.blocked").payload.on, "external");
    must(box, demo, ["work", "unblock", work]);
    assert.notEqual(eventFor(work, "entity.unblocked"), undefined);
    must(box, demo, ["work", "done", work, "--report", "landed and verified"]);
    assert.notEqual(eventFor(work, "entity.done"), undefined);
    const report = events().find((event) => event.type === "report.added" && event.refs?.work === work);
    assert.notEqual(report, undefined, "the done-time report did not land as report.added");
    assert.ok(!must(box, demo, ["work"]).out.includes("exercise the spine"), "a done unit still lists as open");
});
