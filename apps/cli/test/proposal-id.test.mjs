// The id a proposal's waiting row prints, and whether the command it prints
// names one record (#304). Every case here is a cell of the issue's table.
//
// The colliding ids are minted rather than raced for: eight characters of a
// ULID are the top forty bits of the millisecond it was written in, so records
// from the same quarter-second share them. Racing for that passes on a slow
// machine and fails on a fast one, which is how the collision was found in the
// first place — on a runner, by a suite that passed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, logFixture, machine, must, selfIn, workIdIn } from "./harness.mjs";
import { ulid } from "../dist/ids.js";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
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

// One millisecond, three records: the same ten timestamp characters, so the
// eight-character prefix the row used to print names all of them.
const millisecond = ulid().slice(0, 10);

function siblingId()
{
    let tail = "";
    for (const byte of randomBytes(16))
    {
        tail += CROCKFORD[byte % 32];
    }
    return millisecond + tail;
}

// A proposal from before the cutover, named by its own event id. The verb that
// wrote this shape no longer exists; every store that ran it still carries the
// line, and this is the only kind of proposal whose id is a ULID.
function legacyProposal(outcome)
{
    const id = siblingId();
    return logFixture(ws, "demo", {
        id,
        ts: new Date().toISOString(),
        type: "work.proposed",
        origin: { actor: "agent", confirmed: false },
        project: "demo",
        payload: { outcome, objective, ...BRIEF },
        refs: { branch: "main" }
    });
}

function nativeProposal(outcome)
{
    return workIdIn(must(box, demo, ["work", "propose", outcome, "--objective", objective,
        "--value", BRIEF.value, "--success", BRIEF.success[0], "--stop", BRIEF.stop[0],
        "--risk", BRIEF.risk, "--capacity", BRIEF.capacity, "--evidence-plan", BRIEF.evidencePlan,
        "--confidence", BRIEF.confidence, "--expires", BRIEF.expires]).out);
}

// Three of them, made before anything is read, so every cell below asks its
// question of a store where the prefix is genuinely shared.
const siblings = ["a first outcome from one burst", "a second outcome from one burst", "a third outcome from one burst"]
    .map((outcome) => ({ outcome, id: legacyProposal(outcome) }));

function surface(name)
{
    if (name === "terminal")
    {
        return must(box, demo, ["context", "--pretty"]).out;
    }
    if (name === "piped")
    {
        return must(box, demo, ["context", "--plain"]).out;
    }
    if (name === "fold")
    {
        return readFileSync(join(ws, ".superself", "projects", "demo", "state.md"), "utf8");
    }
    return readFileSync(join(ws, ".superself", "view", "demo.html"), "utf8");
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

test("cell 1: the terminal render advertises a command that accepts the proposal beside it", () =>
{
    const target = siblings[0];
    const id = advertised(surface("terminal"), target.outcome);
    assert.equal(id, target.id, "the terminal row named a different record than the one it described");
    const ran = selfIn(box, demo, ["work", "accept", id]);
    assert.equal(ran.code, 0, `the advertised command did not resolve:\n${ran.out}`);
    assert.ok(must(box, demo, ["work"]).out.includes(target.outcome), "a different proposal was accepted");
});

test("cell 2: the piped render advertises the same resolving command", () =>
{
    const target = siblings[1];
    const id = advertised(surface("piped"), target.outcome);
    assert.equal(id, target.id);
    assert.equal(selfIn(box, demo, ["work", "accept", id]).code, 0);
    assert.ok(must(box, demo, ["work"]).out.includes(target.outcome));
});

test("cell 3: the markdown fold advertises the same resolving command", () =>
{
    const target = siblings[2];
    const id = advertised(surface("fold"), target.outcome);
    assert.equal(id, target.id);
    assert.equal(selfIn(box, demo, ["work", "accept", id]).code, 0);
    assert.ok(must(box, demo, ["work"]).out.includes(target.outcome));
});

test("cell 5: a proposal with no sibling in its millisecond is advertised the same way", () =>
{
    const outcome = "an outcome written on its own";
    const id = logFixture(ws, "demo", {
        id: ulid(),
        ts: new Date().toISOString(),
        type: "work.proposed",
        origin: { actor: "agent", confirmed: false },
        project: "demo",
        payload: { outcome, objective, ...BRIEF },
        refs: { branch: "main" }
    });
    assert.equal(advertised(surface("terminal"), outcome), id);
    assert.equal(selfIn(box, demo, ["work", "accept", id]).code, 0);
});

test("cell 6: running the advertised command twice is refused, naming one proposal", () =>
{
    const outcome = "an outcome accepted and then accepted again";
    const id = legacyProposal(outcome);
    assert.equal(selfIn(box, demo, ["work", "accept", id]).code, 0);
    const again = selfIn(box, demo, ["work", "accept", id]);
    assert.equal(again.code, 1);
    assert.match(again.out, new RegExp(`proposal ${id} is already accepted`));
});

test("cell 7: the duplicate-outcome refusal names one proposal", () =>
{
    const outcome = "an outcome someone proposes twice";
    const id = legacyProposal(outcome);
    const clash = selfIn(box, demo, ["work", "propose", outcome, "--objective", objective,
        "--value", BRIEF.value, "--success", BRIEF.success[0], "--stop", BRIEF.stop[0],
        "--risk", BRIEF.risk, "--capacity", BRIEF.capacity, "--evidence-plan", BRIEF.evidencePlan,
        "--confidence", BRIEF.confidence, "--expires", BRIEF.expires]);
    assert.equal(clash.code, 1);
    assert.match(clash.out, new RegExp(`proposal ${id} already proposes this outcome`));
});

test("cell 8: the HTML row names one proposal", () =>
{
    const outcome = "an outcome read from the html view";
    const id = legacyProposal(outcome);
    const row = surface("html").split("\n").find((line) => line.includes(outcome));
    assert.notEqual(row, undefined, "the proposal never reached the html view");
    assert.ok(row.includes(id), `the html row named the proposal by a prefix rather than by its id:\n${row}`);
});

test("cell 9: a native proposal in the same burst is advertised by its own short id", () =>
{
    const outcome = "an outcome proposed by today's verb";
    const id = nativeProposal(outcome);
    assert.match(id, /^w-[0-9a-z]{5}$/);
    assert.equal(advertised(surface("terminal"), outcome), id);
    assert.equal(selfIn(box, demo, ["work", "accept", id]).code, 0);
});

test("cell 10: a native proposal's row is the row it always was", () =>
{
    const outcome = "an outcome nobody answers";
    const id = nativeProposal(outcome);
    const shown = surface("piped");
    assert.ok(shown.includes(`- work proposal ${id}: ${outcome}`), `the row's shape changed:\n${shown}`);
    assert.ok(shown.includes(`expires ${BRIEF.expires} — \`self work accept ${id}\``), "the accept line's shape changed");
});
