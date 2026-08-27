// What answering a work proposal changes for the person who answered it
// (#301). Every case here is a cell of the issue's table.
//
// The table was first drawn over two kinds of proposal, one made by today's
// verb and one folded from a legacy `work.proposed` event, because the legacy
// kind answered nothing at all. #305 stopped folding that event, so there is
// one kind left and the loop below runs it alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoWorkspace, machine, must, mustPerson, personIn, retireFixture, selfIn, workIdIn } from "./harness.mjs";

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

// The proposal the verb makes today: one `entity.proposed` event, answered
// through the entity view.
async function native(cwd, outcome, target)
{
    return workIdIn((await must(box, cwd, ["work", "propose", outcome, "--objective", target,
        "--value", BRIEF.value, "--success", BRIEF.success[0], "--stop", BRIEF.stop[0],
        "--risk", BRIEF.risk, "--capacity", BRIEF.capacity, "--evidence-plan", BRIEF.evidencePlan,
        "--confidence", BRIEF.confidence, "--expires", BRIEF.expires])).out);
}

// The line the log would carry if the answer had been given by an older clone
// and pulled in — the replay reading, with no verb of this version involved.
function retractionFixture(id, why)
{
    return retireFixture(box, ws, "demo", "entity.retracted", { entity: id, why }, { declines: id });
}

const KINDS = [{ name: "native", make: (cwd, outcome, target) => native(cwd, outcome, target) }];

async function context(cwd = demo)
{
    return (await must(box, cwd, ["context"])).out;
}

async function waitingCount()
{
    return Number((await must(box, demo, ["status"])).out.match(/waiting on you: (\d+)/)[1]);
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
    test(`${kind.name} cell 1: a declined proposal leaves the waiting band`, async () =>
    {
        const outcome = `${kind.name}: an outcome turned down`;
        const id = await kind.make(demo, outcome, objective);
        assert.notEqual(waitingBlock(await context(), outcome), undefined, "the proposal never reached the waiting band");
        await must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        assert.equal(waitingBlock(await context(), outcome), undefined,
            `the declined proposal is still waiting on the person who declined it:\n${await context()}`);
    });

    test(`${kind.name} cell 2: declining drops the waiting count by one`, async () =>
    {
        const id = await kind.make(demo, `${kind.name}: an outcome counted then turned down`, objective);
        const before = await waitingCount();
        await must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        assert.equal(await waitingCount(), before - 1);
    });

    test(`${kind.name} cell 3: an accepted proposal leaves the band and becomes a unit`, async () =>
    {
        const outcome = `${kind.name}: an outcome taken up`;
        const id = await kind.make(demo, outcome, objective);
        await mustPerson(box, demo, ["work", "accept", id]);
        assert.equal(waitingBlock(await context(), outcome), undefined, "the accepted proposal is still waiting");
        const listed = (await must(box, demo, ["work"])).out;
        assert.ok(listed.includes(outcome), `the accepted proposal never became a unit:\n${listed}`);
        assert.ok(listed.includes(objective), "the unit does not carry the outcome the proposal named");
    });

    test(`${kind.name} cell 4: a second decline is refused, naming the answer already given`, async () =>
    {
        const id = await kind.make(demo, `${kind.name}: an outcome turned down twice`, objective);
        await must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        const again = await selfIn(box, demo, ["work", "decline", id, "--why", "removed again"]);
        assert.equal(again.code, 1);
        assert.match(again.out, /is already declined/);
    });

    test(`${kind.name} cell 5: accepting a declined proposal is refused`, async () =>
    {
        const id = await kind.make(demo, `${kind.name}: an outcome turned down then taken up`, objective);
        await must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
        const accepted = await personIn(box, demo, ["work", "accept", id]);
        assert.equal(accepted.code, 1);
        assert.match(accepted.out, /is already declined/);
    });

    test(`${kind.name} cell 6: a proposal nobody answered renders exactly as it did`, async () =>
    {
        const untouched = `${kind.name}: an outcome nobody answered`;
        await kind.make(demo, untouched, objective);
        const before = waitingBlock(await context(), untouched);
        const answered = await kind.make(demo, `${kind.name}: an outcome answered beside it`, objective);
        await must(box, demo, ["work", "decline", answered, "--why", "its premises were removed"]);
        assert.equal(waitingBlock(await context(), untouched), before);
    });

    test(`${kind.name} cell 7: a retraction already in the log reads as declined on replay`, async () =>
    {
        const outcome = `${kind.name}: an outcome answered by an older clone`;
        const id = await kind.make(demo, outcome, objective);
        retractionFixture(id, "answered before this version could ask");
        assert.equal(waitingBlock(await context(), outcome), undefined,
            `the replayed retraction left the proposal open:\n${await context()}`);
        assert.match((await personIn(box, demo, ["work", "accept", id])).out, /is already declined/);
    });
}

// Cell 8 was isolated in a project of its own while the waiting row printed a
// legacy proposal's id cut to eight characters (#304). It runs where the
// others do now.
for (const kind of KINDS)
{
    test(`${kind.name} cell 8: the accept line context prints resolves where context was read`, async () =>
    {
        const outcome = `${kind.name}: an outcome accepted as advertised`;
        await kind.make(demo, outcome, objective);
        const block = waitingBlock(await context(), outcome);
        const printed = block?.match(/`self (work accept [^`]+)`/);
        assert.notEqual(printed ?? null, null, `context advertised no accept command:\n${await context()}`);
        // Driven with a keyboard: the advertised line is one a person runs, and
        // accepting a plan is a person's call (#389).
        const ran = await personIn(box, demo, printed[1].split(" "));
        assert.equal(ran.code, 0, `the advertised command failed where the context was read:\n${ran.out}`);
    });
}
