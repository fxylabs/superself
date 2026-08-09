// Cells 11 and 14 of the render-gate case table (w-5emx6 stage 1), and cell 11
// of stage 2's — the same test, over a sweep stage 2 widened to ask every write
// verb whose answer it moves behind the gate.
//
// The fixture in fixtures/golden/piped.txt is generated before each stage's
// source change and committed first. It is the answer a piped run gave then, so
// a diff against it now is a byte the move changed — in a migrated verb or,
// worse, in one nothing was supposed to touch.
import test from "node:test";
import assert from "node:assert/strict";
import { committedFixture, fixturePath, sweep } from "./golden.mjs";

const generated = sweep();

test("cell 11: a piped sweep of the scenario workspace prints the committed bytes", () =>
{
    const expected = committedFixture();
    if (generated.text !== expected)
    {
        assert.equal(generated.text, expected,
            `output moved against ${fixturePath}. If the move was the intended outcome, `
            + "regenerate with `node test/golden.mjs --write` and let the diff be the evidence.");
    }
});

test("cell 14: two generator runs over the same scenario normalize to the same bytes", () =>
{
    assert.equal(sweep().text, generated.text);
});
