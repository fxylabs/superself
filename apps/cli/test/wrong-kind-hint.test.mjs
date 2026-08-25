// A short id names its kind in its prefix, so a lookup given an id of the
// wrong kind answers with the command that resolves it, not a listing that
// could never contain it. An id whose prefix matches the surface keeps the
// unknown-id refusal it always had.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { git, machine, must, selfIn } from "./harness.mjs";

const box = machine();
const ws = join(box.root, "ws");
const demo = join(ws, "demo");
mkdirSync(demo, { recursive: true });
await must(box, ws, ["init"]);
git(box, demo, ["init", "-q", "-b", "main"]);
await must(box, demo, ["project", "init", "--name", "demo", "--desc", "wrong-kind hints", "--no-connect"]);

test("`work show` with an objective id names the objective surface", async () =>
{
    const answer = await selfIn(box, demo, ["work", "show", "o-gn3t3"]);
    assert.notEqual(answer.code, 0);
    assert.match(answer.out, /"o-gn3t3" is an objective id, not a work id — run `self objective show o-gn3t3`/);
});

test("`work show` with a milestone id names the milestone surface", async () =>
{
    const answer = await selfIn(box, demo, ["work", "show", "m-abcde"]);
    assert.notEqual(answer.code, 0);
    assert.match(answer.out, /"m-abcde" is a milestone id, not a work id — run `self milestone show m-abcde`/);
});

test("`objective show` with a work id names the work surface", async () =>
{
    const answer = await selfIn(box, demo, ["objective", "show", "w-abcde"]);
    assert.notEqual(answer.code, 0);
    assert.match(answer.out, /"w-abcde" is a work id, not an objective id — run `self work show w-abcde`/);
});

test("`milestone show` with a work id names the work surface", async () =>
{
    const answer = await selfIn(box, demo, ["milestone", "show", "w-abcde"]);
    assert.notEqual(answer.code, 0);
    assert.match(answer.out, /"w-abcde" is a work id, not a milestone id — run `self work show w-abcde`/);
});

test("`work show` with a missing work id keeps the unknown-id refusal", async () =>
{
    const answer = await selfIn(box, demo, ["work", "show", "w-zzzzz"]);
    assert.notEqual(answer.code, 0);
    assert.match(answer.out, /unknown work id "w-zzzzz"/);
});
