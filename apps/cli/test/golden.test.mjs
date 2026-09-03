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

// Cell G3 of docs/maintainers/case-tables/440-instructions.md. A new top-level
// verb reaches this fixture through one section and one only: the root usage
// listing `self --help` prints, which the sweep captures. Everything else the
// sweep runs is a verb that predates the change, so the verb's name may appear
// nowhere else in these bytes.
test("G3: the fixture's only `instruction` lines are the root usage listing's", () =>
{
    const fixture = committedFixture();
    // The root usage listing is what the bare `self` section of the sweep
    // holds; every section runs to the next `$ self` command line.
    const from = fixture.indexOf("\n$ self    (in ");
    assert.notEqual(from, -1, "the sweep no longer runs the bare verb");
    const rest = fixture.slice(from + 1);
    const listing = rest.slice(0, rest.indexOf("\n$ self ", 1));
    const naming = fixture.split("\n").filter((line) => line.includes("instruction"));
    assert.ok(naming.length > 0, "the fixture names no instruction verb at all");
    for (const line of naming)
    {
        assert.ok(listing.includes(line) || line.includes("agent instruction files"),
            `\`instruction\` reached the fixture outside the root usage listing: ${line}`);
    }
    assert.ok(listing.includes('  instruction add "<text>" --kind rule|tool|procedure'), listing);
    assert.ok(listing.includes("  instruction render [--project <slug>] [--json]"), listing);
});
