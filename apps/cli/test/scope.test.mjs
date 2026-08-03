// The read-scope contract the shell suite proved: one resolver behind every
// read verb — current project by default, --project for another, --workspace
// where aggregation is meaningful — and writes take no scope flag at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoWorkspace, machine, must, selfIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);
const self = (cwd, args) => selfIn(box, cwd, args);

must(box, demo, ["work", "add", "scoped outcome"]);

test("a read answers for the named project from anywhere in the workspace", () =>
{
    assert.ok(must(box, ws, ["work", "--project", "demo"]).out.includes("scoped outcome"));
});

test("an unknown project is refused with the registered slugs", () =>
{
    const result = self(ws, ["work", "--project", "nope"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown project "nope"/);
    assert.match(result.out, /demo/);
});

test("naming a project and the workspace at once is two different asks", () =>
{
    const result = self(demo, ["status", "--project", "demo", "--workspace"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /pass one of them/);
});

test("a write declares no scope flag, so --project on it is named as a mistake", () =>
{
    const result = self(demo, ["work", "add", "elsewhere", "--project", "demo"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown option '--project'/);
});

test("context outside a project answers for the workspace instead of refusing", () =>
{
    const result = must(box, ws, ["context"]);
    assert.ok(result.out.length > 0);
});

test("the workspace-wide form answers for every registered project", () =>
{
    assert.ok(must(box, ws, ["status", "--workspace"]).out.includes("demo"));
});
