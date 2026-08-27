// The read-scope contract the shell suite proved: one resolver behind every
// read verb — current project by default, --project for another, --workspace
// where aggregation is meaningful — and a write verb takes no *read* scope
// flag: it records into the project it runs in, and `--project` on a write is
// refused by name.
//
// `--workspace` on a write is a different flag with the same spelling, and has
// been since #207 D6: on `convention add`, `goal add` and `objective add` it
// states a placement — where the new record renders — while the record itself
// still lands in this project's store. The cells below are about the read
// resolver; the placement flag's own cells are in workspace-direction.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoWorkspace, machine, must, mustPerson, selfIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);
const self = (cwd, args) => selfIn(box, cwd, args);

await mustPerson(box, demo, ["work", "add", "scoped outcome"]);

test("a read answers for the named project from anywhere in the workspace", async () =>
{
    assert.ok((await must(box, ws, ["work", "--project", "demo"])).out.includes("scoped outcome"));
});

test("an unknown project is refused with the registered slugs", async () =>
{
    const result = await self(ws, ["work", "--project", "nope"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown project "nope"/);
    assert.match(result.out, /demo/);
});

test("naming a project and the workspace at once is two different asks", async () =>
{
    const result = await self(demo, ["status", "--project", "demo", "--workspace"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /pass one of them/);
});

test("a write declares no read scope flag, so --project on it is named as a mistake", async () =>
{
    const result = await self(demo, ["work", "add", "elsewhere", "--project", "demo"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown option '--project'/);
    // The same holds for a write that does declare `--workspace`: that flag
    // states where the record renders, and it buys no read scope with it.
    const placed = await self(demo, ["objective", "add", "elsewhere", "--workspace", "--project", "demo"]);
    assert.notEqual(placed.code, 0);
    assert.match(placed.out, /unknown option '--project'/);
});

test("context outside a project answers for the workspace instead of refusing", async () =>
{
    const result = await must(box, ws, ["context"]);
    assert.ok(result.out.length > 0);
});

test("the workspace-wide form answers for every registered project", async () =>
{
    assert.ok((await must(box, ws, ["status", "--workspace"])).out.includes("demo"));
});
