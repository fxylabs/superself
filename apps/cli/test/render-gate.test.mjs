// The piped half of the render-gate case table (w-5emx6 stage 1): cells 1, 3,
// 4, 6, 7, 9 and 10. A command handler now returns what it has to say and
// `output.ts` prints it, so what these assert is that the reader sees exactly
// the bytes they saw before the move — including the refusals, which never
// reach the gate at all.
//
// The terminal half of the table lives in render-gate-tty.test.mjs, which has
// to load with a styled stdout for its cells to mean anything.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { git, machine, must, selfIn } from "./harness.mjs";
import { notice } from "../dist/output.js";

const box = machine();
const ws = join(box.root, "ws");
const demo = join(ws, "demo");
mkdirSync(demo, { recursive: true });
must(box, ws, ["init"]);
git(box, demo, ["init", "-q", "-b", "main"]);
must(box, demo, ["project", "init", "--name", "demo", "--desc", "the render gate", "--no-connect"]);

// The three lang cells run in the order a person would: the language is unset,
// then it is set, then it is read back.
test("cell 3: with no language set, a piped `self lang` answers en", () =>
{
    const answer = selfIn(box, demo, ["lang"]);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.out, "en\n");
});

test("cell 4: a piped `self lang ko` prints the confirmation line it always printed", () =>
{
    const answer = selfIn(box, demo, ["lang", "ko"]);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.out, "views now render in \"ko\"\n");
});

test("cell 1: with the language set, a piped `self lang` answers ko", () =>
{
    const answer = selfIn(box, demo, ["lang"]);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.out, "ko\n");
});

test("cell 6: `self lang --plain` is still the unknown-option refusal — the gate adds no flags", () =>
{
    const answer = selfIn(box, demo, ["lang", "--plain"]);
    assert.equal(answer.code, 1);
    assert.equal(answer.out, "error: unknown option '--plain' — run `self lang --help` for the syntax\n");
});

// A machine that has never run `self init`: the workspace pointer this one
// remembers is what makes `self lang` answer from any directory, so the cell
// needs a machine with no workspace at all rather than a directory outside one.
test("cell 7: with no workspace to resolve, `self lang` refuses exactly as it did", () =>
{
    const bare = machine();
    const outside = selfIn(bare, bare.root, ["lang"]);
    const reference = selfIn(bare, bare.root, ["theme"]);
    assert.equal(outside.code, 1, outside.out);
    // The refusal is the workspace resolver's and never reaches the gate: the
    // unmigrated sibling verb is refused with the same sentence.
    assert.equal(outside.out, reference.out);
    assert.match(outside.out, /^error: /);
});

test("cell 9: a piped event verb prints the recorded line the append always printed", () =>
{
    const answer = selfIn(box, demo, ["decide", "the gate prints once", "--proposed"]);
    assert.equal(answer.code, 0, answer.out);
    assert.match(answer.out, /^entity\.proposed recorded \[[0-9abcdefghjkmnpqrstvwxyz]{26}\]\n$/);
});

// Machine mode is `pipeline.ts`'s judgment about a run, and stage 1 left it
// there: the notice the gate exports prints whatever it is handed and answers
// nothing about the run, so an append is silent only where the append says so.
test("cell 10: notice prints what it is handed and suppresses nothing itself", () =>
{
    const said = [];
    const log = console.log;
    const wasTTY = process.stdout.isTTY;
    console.log = (...parts) => said.push(parts.join(" "));
    try
    {
        process.stdout.isTTY = false;
        notice("entity.confirmed recorded [x]");
        process.stdout.isTTY = true;
        notice("entity.confirmed recorded [x]");
    }
    finally
    {
        console.log = log;
        process.stdout.isTTY = wasTTY;
    }
    assert.deepEqual(said, ["entity.confirmed recorded [x]", "entity.confirmed recorded [x]"]);
});
