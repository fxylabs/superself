// What a verb cannot run without is one declaration: the parse gate refuses
// every missing option in a single answer, the help page states the same set,
// and the contract checks refuse a declaration nothing could satisfy (#106).
// The cases here are the table the design settled before implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { requireOptions } from "../dist/args.js";
import { branch, checkContract, leaf } from "../dist/contract.js";
import { commandUsage } from "../dist/help.js";
import { demoWorkspace, machine, must, selfIn } from "./harness.mjs";

/* ── the gate ──────────────────────────────────────────────────────── */

const WHY = { flags: ["why"], hint: "why it no longer holds" };
const TARGET = { flags: ["objective", "milestone"], value: "<id>", hint: "the gap it closes" };

function refusal(values, requires)
{
    try
    {
        requireOptions("demo do", values, requires);
        return null;
    }
    catch (error)
    {
        return error.message;
    }
}

test("an option that was given, in any of its shapes, is not asked for again", () =>
{
    assert.equal(refusal({ why: "because" }, [WHY]), null);
    assert.equal(refusal({ exit: ["c1"] }, [{ flags: ["exit"], hint: "criteria" }]), null);
    assert.equal(refusal({ objective: "o-1" }, [TARGET]), null);
    assert.equal(refusal({ milestone: "m-1" }, [TARGET]), null);
    // Both sides of a group is the handler's judgment, not the gate's.
    assert.equal(refusal({ objective: "o-1", milestone: "m-1" }, [TARGET]), null);
    assert.equal(refusal({ why: "because" }, []), null);
});

test("an option carrying no text is an option that was not given", () =>
{
    assert.equal(refusal({ why: "" }, [WHY]), "self demo do needs --why: why it no longer holds");
    assert.equal(refusal({ why: "   " }, [WHY]), "self demo do needs --why: why it no longer holds");
    assert.equal(refusal({ exit: ["", " "] }, [{ flags: ["exit"], hint: "criteria" }]),
        "self demo do needs --exit: criteria");
});

test("one missing option is one line, and a group names both spellings", () =>
{
    assert.equal(refusal({}, [WHY]), "self demo do needs --why: why it no longer holds");
    assert.equal(refusal({}, [TARGET]), "self demo do needs --objective|--milestone: the gap it closes");
});

test("several missing options are one refusal, in declaration order, with the help hint", () =>
{
    const said = refusal({ risk: "none" }, [
        { flags: ["value"], hint: "what it buys" },
        { flags: ["risk"], hint: "what could go wrong" },
        { flags: ["expires"], value: "<date>", hint: "when it goes stale" },
        WHY
    ]);
    assert.equal(said, [
        "self demo do needs 3 more options:",
        "  --value <text>    what it buys",
        "  --expires <date>  when it goes stale",
        "  --why <text>      why it no longer holds",
        "run `self demo --help` for the syntax"
    ].join("\n"));
});

test("a requirement whose precondition lives on another verb names that verb", () =>
{
    const said = refusal({}, [{ ...TARGET, unblock: "no objective yet? `self objective add \"<o>\" --proposed`" }]);
    assert.equal(said, 'self demo do needs --objective|--milestone: the gap it closes\n'
        + 'no objective yet? `self objective add "<o>" --proposed`');
});

/* ── the declaration cannot state what nothing could satisfy ───────── */

function declared(options, requires)
{
    return [{
        name: "demo",
        usage: [{ syntax: "demo do", verbs: ["do"] }],
        detail: ["  --why <text>          a reason", "  --flag                a switch"],
        node: branch({
            name: "demo",
            unnamed: "refuse",
            refusal: "usage: self demo do",
            children: [leaf("do", options, 0, () => {}, { requires })]
        })
    }];
}

const OPTIONS = { why: { type: "string" }, flag: { type: "boolean" } };

test("a well-formed requirement is no problem, and each malformed one is named", () =>
{
    assert.deepEqual(checkContract(declared(OPTIONS, [WHY])), []);
    assert.deepEqual(checkContract(declared(OPTIONS, [{ flags: ["nope"], hint: "unreachable" }])),
        ['demo: "demo do" requires --nope, which it does not declare as an option']);
    assert.deepEqual(checkContract(declared(OPTIONS, [{ flags: ["flag"], hint: "a switch" }])),
        ['demo: "demo do" requires --flag, a boolean — a flag with no value states nothing']);
    assert.deepEqual(checkContract(declared(OPTIONS, [{ flags: [], hint: "nothing" }])),
        ['demo: "demo do" declares a requirement naming no flag']);
});

test("an unblocking path is checked against what the CLI actually dispatches", () =>
{
    assert.deepEqual(checkContract(declared(OPTIONS, [{ ...WHY, unblock: "run `self demo do` first" }])), []);
    assert.deepEqual(checkContract(declared(OPTIONS, [{ ...WHY, unblock: "run `self demo undo` first" }])),
        ['demo: "demo do" points at `self demo undo`, which no command dispatches']);
});

/* ── the page states what the gate refuses ─────────────────────────── */

test("scoped help lists the required options, and says nothing when there are none", () =>
{
    const page = commandUsage(declared(OPTIONS, [WHY, TARGET])[0]);
    assert.match(page, /required, and refused in one pass when missing:/);
    assert.match(page, /demo do {4}--why --objective\|--milestone/);
    assert.doesNotMatch(commandUsage(declared(OPTIONS, [])[0]), /required, and refused in one pass/);
});

/* ── the CLI answers for it ────────────────────────────────────────── */

const box = machine();
const { demo } = demoWorkspace(box);

test("a proposal reveals its whole contract in one refusal, and names the path that unblocks it", () =>
{
    const refused = selfIn(box, demo, ["work", "propose", "a gap worth closing"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /work propose needs 9 more options:/);
    for (const flag of ["--value", "--success", "--stop", "--risk", "--capacity",
        "--evidence-plan", "--confidence", "--expires", "--objective|--milestone"])
    {
        assert.ok(refused.out.includes(flag), `${flag} is missing from the refusal:\n${refused.out}`);
    }
    assert.match(refused.out, /self objective add "<outcome>" --proposed/);
    assert.match(refused.out, /self objective confirm <id>/);
});

test("what the refusal asked for is enough to make the call succeed", () =>
{
    const objective = must(box, demo, ["objective", "add", "ship the surface"]).out.match(/o-[0-9a-z]{5}/)[0];
    const proposed = must(box, demo, ["work", "propose", "close the last gap",
        "--objective", objective, "--value", "it unblocks the release", "--success", "the suite passes",
        "--stop", "the release slips", "--risk", "the fold changes shape", "--capacity", "one session",
        "--evidence-plan", "a green run on CI", "--confidence", "high", "--expires", "2027-01-01"]);
    assert.match(proposed.out, /w-[0-9a-z]{5}/);
});

test("a stray argument and an unknown flag are still answered before the requirements", () =>
{
    assert.match(selfIn(box, demo, ["work", "retire", "w-11111", "extra"]).out, /unexpected argument 'extra'/);
    assert.match(selfIn(box, demo, ["work", "retire", "w-11111", "--nope", "x"]).out, /unknown option '--nope'/);
});

test("help is answered, not refused, when the required options are absent", () =>
{
    const asked = selfIn(box, demo, ["work", "propose", "--help"]);
    assert.equal(asked.code, 0);
    assert.match(asked.out, /work propose {4}--value/);
});

test("the contract is answered before the state: a bad id does not hide a missing option", () =>
{
    const refused = selfIn(box, demo, ["work", "retire", "w-11111"]);
    assert.equal(refused.code, 1);
    assert.equal(refused.out.trim(), "error: self work retire needs --why: why the outcome was given up or moved");
});
