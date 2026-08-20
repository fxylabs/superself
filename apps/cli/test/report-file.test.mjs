// What `report --file` accepts from a file a person wrote (#317). A design
// document about an auth system names credentials on every other line, and
// naming one is not carrying one; the refusal is asserted beside it, because
// the gate still has to hold for a file that really does carry a key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);
const log = join(ws, ".superself", "projects", "demo", "log.jsonl");

const DESIGN = [
    "# S1 rail design v0.1",
    "",
    "Credential — agent-scoped token: account_id, scopes[], expires_at",
    "- refresh token (30d, revocable)",
    "- api_key: rotated quarterly",
    "- idempotency_key: caller-supplied"
].join("\n");

let seq = 0;

function fileHolding(text)
{
    seq += 1;
    const path = join(box.root, `brief-${seq}.md`);
    writeFileSync(path, `${text}\n`);
    return path;
}

function freshUnit()
{
    seq += 1;
    return workIdIn(must(box, demo, ["work", "add", `outcome ${seq}`]).out);
}

function reportsOf(id)
{
    return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "report.added" && event.refs.work === id);
}

test("a design document describing a credential lifecycle attaches in full", () =>
{
    const id = freshUnit();
    const result = selfIn(box, demo, ["report", id, "--file", fileHolding(DESIGN)]);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(reportsOf(id).map((event) => event.payload.text), [DESIGN]);
});

test("a file carrying a credential is refused, and records nothing", () =>
{
    const id = freshUnit();
    const path = fileHolding(`# rollout\n\nrun it with api_key="abc123secretvalue" set`);
    const result = selfIn(box, demo, ["report", id, "--file", path]);
    assert.equal(result.code, 1);
    assert.match(result.out, /shaped like a credential \(rule secret-assignment/);
    assert.equal(reportsOf(id).length, 0);
});
