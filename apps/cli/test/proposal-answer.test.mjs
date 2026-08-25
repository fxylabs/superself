// What answering a work proposal changes for the person who answered it
// (#301). Every case here is a cell of the issue's table.
//
// The table was first drawn over two kinds of proposal, one made by today's
// verb and one folded from a legacy `work.proposed` event, because the legacy
// kind answered nothing at all. #305 stopped folding that event, so there is
// one kind left and the loop below runs it alone.
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
function native(cwd, outcome, target)
{
    return workIdIn(must(box, cwd, ["work", "propose", outcome, "--objective", target,
        "--value", BRIEF.value, "--success", BRIEF.success[0], "--stop", BRIEF.stop[0],
        "--risk", BRIEF.risk, "--capacity", BRIEF.capacity, "--evidence-plan", BRIEF.evidencePlan,
        "--confidence", BRIEF.confidence, "--expires", BRIEF.expires]).out);
}

// The line the log would carry if the answer had been given by an older clone
// and pulled in — the replay reading, with no verb of this version involved.
function retractionFixture(id, why)
{
    return retireFixture(box, ws, "demo", "entity.retracted", { entity: id, why }, { declines: id });
}

const KINDS = [{ name: "native", make: native }];

function context(cwd = demo)
{
    return must(box, cwd, ["context"]).out;
}

function waitingCount()
{
    return Number(must(box, demo, ["status"]).out.match(/waiting on you: (\d+)/)[1]);
}

// Keyed on the outcome, never on the id, so a case never depends on how the
// row spells the record it describes.
function waitingBlock(text, outcome)
{
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.startsWith("- work proposal ") && line.endsWith(`: ${outcome}`));
    if (start === -1)
    {
        return undefined;
    }
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => !line.startsWith("  "));
    return lines.slice(start, end === -1 ? undefined : start + 1 + end).join("\n");
}

for (const kind of KINDS)
{
    test(`${kind.name} cell 1: a declined proposal leaves the waiting band`, () =>
    {
        const outcome = `${kind.name}: an outcome turned down`;
        const id = kind.make(demo, outcome, objective);
        assert.notEqual(waitingBlock(context(), outcome), undefined, "the proposal never reached the waiting band");
        must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        assert.equal(waitingBlock(context(), outcome), undefined,
            `the declined proposal is still waiting on the person who declined it:\n${context()}`);
    });

    test(`${kind.name} cell 2: declining drops the waiting count by one`, () =>
    {
        const id = kind.make(demo, `${kind.name}: an outcome counted then turned down`, objective);
        const before = waitingCount();
        must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        assert.equal(waitingCount(), before - 1);
    });

    test(`${kind.name} cell 3: an accepted proposal leaves the band and becomes a unit`, () =>
    {
        const outcome = `${kind.name}: an outcome taken up`;
        const id = kind.make(demo, outcome, objective);
        must(box, demo, ["work", "accept", id]);
        assert.equal(waitingBlock(context(), outcome), undefined, "the accepted proposal is still waiting");
        const listed = must(box, demo, ["work"]).out;
        assert.ok(listed.includes(outcome), `the accepted proposal never became a unit:\n${listed}`);
        assert.ok(listed.includes(objective), "the unit does not carry the outcome the proposal named");
    });

    test(`${kind.name} cell 4: a second decline is refused, naming the answer already given`, () =>
    {
        const id = kind.make(demo, `${kind.name}: an outcome turned down twice`, objective);
        must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        const again = selfIn(box, demo, ["work", "decline", id, "--why", "removed again"]);
        assert.equal(again.code, 1);
        assert.match(again.out, /is already declined/);
    });

    test(`${kind.name} cell 5: accepting a declined proposal is refused`, () =>
    {
        const id = kind.make(demo, `${kind.name}: an outcome turned down then taken up`, objective);
        must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        const accepted = selfIn(box, demo, ["work", "accept", id]);
        assert.equal(accepted.code, 1);
        assert.match(accepted.out, /is already declined/);
    });

    test(`${kind.name} cell 6: a proposal nobody answered renders exactly as it did`, () =>
    {
        const untouched = `${kind.name}: an outcome nobody answered`;
        kind.make(demo, untouched, objective);
        const before = waitingBlock(context(), untouched);
        const answered = kind.make(demo, `${kind.name}: an outcome answered beside it`, objective);
        must(box, demo, ["work", "decline", answered, "--why", "its premises were removed"]);
        assert.equal(waitingBlock(context(), untouched), before);
    });

    test(`${kind.name} cell 7: a retraction already in the log reads as declined on replay`, () =>
    {
        const outcome = `${kind.name}: an outcome answered by an older clone`;
        const id = kind.make(demo, outcome, objective);
        retractionFixture(id, "answered before this version could ask");
        assert.equal(waitingBlock(context(), outcome), undefined,
            `the replayed retraction left the proposal open:\n${context()}`);
        assert.match(selfIn(box, demo, ["work", "accept", id]).out, /is already declined/);
    });
}

// Cell 8 was isolated in a project of its own while the waiting row printed a
// legacy proposal's id cut to eight characters (#304). It runs where the
// others do now.
for (const kind of KINDS)
{
    test(`${kind.name} cell 8: the accept line context prints resolves where context was read`, () =>
    {
        const outcome = `${kind.name}: an outcome accepted as advertised`;
        kind.make(demo, outcome, objective);
        const block = waitingBlock(context(), outcome);
        const printed = block?.match(/`self (work accept [^`]+)`/);
        assert.notEqual(printed ?? null, null, `context advertised no accept command:\n${context()}`);
        const ran = selfIn(box, demo, printed[1].split(" "));
        assert.equal(ran.code, 0, `the advertised command failed where the context was read:\n${ran.out}`);
    });
}
