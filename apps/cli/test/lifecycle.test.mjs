// The record lifecycle the shell suite proved, on the surface that survives:
// every statement type ships its supersede and withdraw verbs, a withdrawn
// record leaves the current render, and the work spine closes on a judgment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STATEMENT_TYPES } from "../dist/model.js";
import { approvedIn, demoWorkspace, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = demoWorkspace(box);
const self = (args, cwd = demo) => selfIn(box, cwd, args);
// Destroying a record needs a person at a terminal (#173): the command line
// runs in full and only the typed answer is stood in for.
const approved = (args, answer) => approvedIn(box, demo, args, answer);

test("every statement type ships its lifecycle verbs in its own help", () =>
{
    assert.ok(STATEMENT_TYPES.length >= 5, "the statement-type registry shrank unexpectedly");
    for (const statement of STATEMENT_TYPES)
    {
        const help = must(box, demo, [statement.command, "--help"]).out;
        assert.ok(help.includes(statement.supersede), `${statement.type} help lost its supersede verb "${statement.supersede}"`);
        assert.ok(help.includes(statement.withdraw), `${statement.type} help lost its withdraw verb "${statement.withdraw}"`);
        if (statement.decline !== undefined)
        {
            assert.ok(help.includes(statement.decline), `${statement.type} help lost its decline verb "${statement.decline}"`);
        }
    }
});

test("a proposed decision confirms, and a superseded one leaves the render", async () =>
{
    const proposed = idIn(must(box, demo, ["decide", "first direction", "--proposed"]).out);
    must(box, demo, ["decide", "confirm", proposed]);
    const successor = await approved(["decide", "second direction", "--why", "replaces the first", "--supersedes", proposed], proposed);
    assert.equal(successor.code, 0);
    const context = must(box, demo, ["context"]).out;
    assert.ok(context.includes("second direction"));
    assert.ok(!context.includes("first direction"), "a superseded decision still renders as current");
});

test("a dropped convention leaves the render and stays in search", async () =>
{
    const id = idIn(must(box, demo, ["convention", "add", "state changes go through events"]).out);
    assert.ok(must(box, demo, ["context"]).out.includes("state changes go through events"));
    await approved(["convention", "drop", id, "--why", "replaced by the event gate"], id);
    assert.ok(!must(box, demo, ["context"]).out.includes("state changes go through events"));
    assert.ok(must(box, demo, ["search", "state changes go through"]).out.includes("state changes"), "a dropped convention vanished from history");
});

test("the work spine: add, start, report, evidenced done as a judgment", () =>
{
    const work = workIdIn(must(box, demo, ["work", "add", "ship the fast tier"]).out);
    must(box, demo, ["work", "start", work]);
    must(box, demo, ["report", work, "tier landed, suite green"]);
    // The scratch repo has no commits, so the report is a bare summary and the
    // done claim owes its evidence at done time (#205, ruling ②).
    const bare = self(["work", "done", work]);
    assert.notEqual(bare.code, 0, "a bare-summary report satisfied the done evidence gate");
    const done = self(["work", "done", work, "--report", "fast tier merged, 83 tests green"]);
    assert.equal(done.code, 0, done.out);
    assert.ok(!must(box, demo, ["work"]).out.includes("ship the fast tier"), "a done unit still lists as open");
    assert.ok(must(box, demo, ["work", "show", work]).out.includes("tier landed"), "the report history left the record");
});

test("a retired unit stops counting as open and keeps its why", async () =>
{
    const work = workIdIn(must(box, demo, ["work", "add", "a direction given up"]).out);
    await approved(["work", "retire", work, "--why", "superseded by the fast tier"], work);
    assert.ok(!must(box, demo, ["work"]).out.includes("a direction given up"));
    assert.ok(must(box, demo, ["work", "show", work]).out.includes("superseded by the fast tier"));
});

test("a work verb on an unknown id refuses with the remedy", () =>
{
    const done = self(["work", "done", "w-zzzzz"]);
    assert.notEqual(done.code, 0);
    assert.match(done.out, /unknown work id/);
});
