// What answering a work proposal changes for the person who answered it
// (#301). Every case here is a cell of the issue's table, run against both
// kinds of proposal — one made after the preset write cutover (#207 B13), one
// folded from a legacy `work.proposed` event — because that is the state
// variable the table first left out: `work accept` and `work decline` record
// `entity.*` events, a legacy proposal is not an entity, and every cell passed
// on the native kind while the legacy kind answered nothing at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoWorkspace, machine, must, retireFixture, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);
must(box, demo, ["goal", "add", "a direction"]);
const objective = must(box, demo, ["objective", "add", "a measurable outcome", "--target", "2099-01-01"])
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

// The proposal the verb makes today: one `entity.proposed` event, answered
// through the entity view.
function native(outcome)
{
    return workIdIn(must(box, demo, ["work", "propose", outcome, "--objective", objective,
        "--value", BRIEF.value, "--success", BRIEF.success[0], "--stop", BRIEF.stop[0],
        "--risk", BRIEF.risk, "--capacity", BRIEF.capacity, "--evidence-plan", BRIEF.evidencePlan,
        "--confidence", BRIEF.confidence, "--expires", BRIEF.expires]).out);
}

// The proposal a store made before the cutover, written as the log line that
// version appended. A fixture, not a way past a gate: the verb that wrote this
// shape no longer exists, and every store that ran it still carries the line.
function legacy(outcome)
{
    return retireFixture(box, ws, "demo", "work.proposed", { outcome, objective, ...BRIEF }, { branch: "main" });
}

// The line the log would carry if the answer had been given by an older clone
// and pulled in — the replay reading, with no verb of this version involved.
function retractionFixture(id, why)
{
    return retireFixture(box, ws, "demo", "entity.retracted", { entity: id, why }, { declines: id });
}

const KINDS = [{ name: "native", make: native }, { name: "legacy", make: legacy }];

function context()
{
    return must(box, demo, ["context"]).out;
}

function waitingCount()
{
    return Number(must(box, demo, ["status"]).out.match(/waiting on you: (\d+)/)[1]);
}

function waitingRows(text)
{
    return text.split("\n").filter((line) => line.startsWith("- work proposal "));
}

for (const kind of KINDS)
{
    test(`${kind.name} cell 1: a declined proposal leaves the waiting band`, () =>
    {
        const id = kind.make(`${kind.name}: an outcome turned down`);
        assert.ok(context().includes(`work proposal ${id.slice(0, 8)}`), "the proposal never reached the waiting band");
        must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        assert.ok(!context().includes(`work proposal ${id.slice(0, 8)}`),
            `the declined proposal is still waiting on the person who declined it:\n${context()}`);
    });

    test(`${kind.name} cell 2: declining drops the waiting count by one`, () =>
    {
        const id = kind.make(`${kind.name}: an outcome counted then turned down`);
        const before = waitingCount();
        must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        assert.equal(waitingCount(), before - 1);
    });

    test(`${kind.name} cell 3: an accepted proposal leaves the band and becomes a unit`, () =>
    {
        const id = kind.make(`${kind.name}: an outcome taken up`);
        must(box, demo, ["work", "accept", id]);
        assert.ok(!context().includes(`work proposal ${id.slice(0, 8)}`), "the accepted proposal is still waiting");
        const listed = must(box, demo, ["work"]).out;
        assert.ok(listed.includes(`${kind.name}: an outcome taken up`), `the accepted proposal never became a unit:\n${listed}`);
        assert.ok(listed.includes(objective), "the unit does not carry the outcome the proposal named");
    });

    test(`${kind.name} cell 4: a second decline is refused, naming the answer already given`, () =>
    {
        const id = kind.make(`${kind.name}: an outcome turned down twice`);
        must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        const again = selfIn(box, demo, ["work", "decline", id, "--why", "removed again"]);
        assert.equal(again.code, 1);
        assert.match(again.out, /is already declined/);
    });

    test(`${kind.name} cell 5: accepting a declined proposal is refused`, () =>
    {
        const id = kind.make(`${kind.name}: an outcome turned down then taken up`);
        must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        const accepted = selfIn(box, demo, ["work", "accept", id]);
        assert.equal(accepted.code, 1);
        assert.match(accepted.out, /is already declined/);
    });

    test(`${kind.name} cell 6: a proposal nobody answered renders exactly as it did`, () =>
    {
        const untouched = kind.make(`${kind.name}: an outcome nobody answered`);
        const row = waitingRows(context()).find((line) => line.includes(untouched.slice(0, 8)));
        const answered = kind.make(`${kind.name}: an outcome answered beside it`);
        must(box, demo, ["work", "decline", answered, "--why", "its premises were removed"]);
        assert.equal(waitingRows(context()).find((line) => line.includes(untouched.slice(0, 8))), row);
    });

    test(`${kind.name} cell 7: a retraction already in the log reads as declined on replay`, () =>
    {
        const id = kind.make(`${kind.name}: an outcome answered by an older clone`);
        retractionFixture(id, "answered before this version could ask");
        assert.ok(!context().includes(`work proposal ${id.slice(0, 8)}`),
            `the replayed retraction left the proposal open:\n${context()}`);
        assert.match(selfIn(box, demo, ["work", "accept", id]).out, /is already declined/);
    });

    test(`${kind.name} cell 8: the accept line context prints resolves where context was read`, () =>
    {
        const id = kind.make(`${kind.name}: an outcome accepted as advertised`);
        const shown = context();
        const printed = shown.match(new RegExp("`self (work accept " + id.slice(0, 8) + "[^`]*)`"));
        assert.notEqual(printed, null, `context advertised no accept command for the proposal:\n${shown}`);
        const ran = selfIn(box, demo, printed[1].split(" "));
        assert.equal(ran.code, 0, `the advertised command failed where the context was read:\n${ran.out}`);
    });
}
