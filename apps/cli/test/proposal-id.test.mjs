// The id a proposal's waiting row prints, and whether the command it prints
// names one record (#304).
//
// Cells 1 to 8 asked this of a proposal folded from a pre-cutover
// `work.proposed` event, whose id is a ULID whose first eight characters are
// the millisecond it was written in — so every proposal from one burst
// answered to one prefix. #305 stopped folding that event, and what is left
// is the pair of cells that were always about the proposal today's verb makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoWorkspace, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = await demoWorkspace(box);
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

async function nativeProposal(outcome)
{
    return workIdIn((await must(box, demo, ["work", "propose", outcome, "--objective", objective,
        "--value", BRIEF.value, "--success", BRIEF.success[0], "--stop", BRIEF.stop[0],
        "--risk", BRIEF.risk, "--capacity", BRIEF.capacity, "--evidence-plan", BRIEF.evidencePlan,
        "--confidence", BRIEF.confidence, "--expires", BRIEF.expires])).out);
}

async function surface(name)
{
    return (await must(box, demo, ["context", name === "terminal" ? "--pretty" : "--plain"])).out;
}

// The accept command printed for one proposal, found by the outcome beside it
// rather than by the id — the id is the subject of the case, so keying on it
// would assume the answer. Read forward from the outcome to the command,
// because the two share a line in the fold and not in either context render,
// and stop at the next proposal so a missing command cannot borrow one.
function advertised(text, outcome)
{
    const lines = text.split("\n");
    const start = lines.findIndex((row) => row.includes(outcome));
    if (start === -1)
    {
        return undefined;
    }
    for (const row of lines.slice(start))
    {
        if (row.includes("self work accept"))
        {
            return row.match(/self work accept ([0-9a-z-]+)/)[1];
        }
        if (row !== lines[start] && row.includes("work proposal "))
        {
            return undefined;
        }
    }
    return undefined;
}

test("cell 9: a native proposal is advertised by its own short id", async () =>
{
    const outcome = "an outcome proposed by today's verb";
    const id = await nativeProposal(outcome);
    assert.match(id, /^w-[0-9a-z]{5}$/);
    assert.equal(advertised(await surface("terminal"), outcome), id);
    assert.equal((await selfIn(box, demo, ["work", "accept", id])).code, 0);
});

test("cell 10: a native proposal's row is the row it always was", async () =>
{
    const outcome = "an outcome nobody answers";
    const id = await nativeProposal(outcome);
    const shown = await surface("piped");
    assert.ok(shown.includes(`- work proposal ${id}: ${outcome}`), `the row's shape changed:\n${shown}`);
    assert.ok(shown.includes(`expires ${BRIEF.expires} — \`self work accept ${id}\``), "the accept line's shape changed");
});
