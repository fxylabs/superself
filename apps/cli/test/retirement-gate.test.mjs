import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, idIn, machine, must, selfIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);

test("the gate refuses a supersede from a process with no terminal, and records nothing", () =>
{
    const first = idIn(must(box, demo, ["decide", "the first policy"]).out);
    const before = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trim().split("\n").length;
    const refused = selfIn(box, demo, ["decide", "a pointer", "--supersedes", first]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /nothing was recorded/);
    assert.match(refused.out, /the first policy/);
    assert.match(refused.out, /a person runs this in their own terminal/);
    const after = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trim().split("\n").length;
    assert.equal(after, before);
});

test("the approved path records the supersession and the confirmation it was typed at", async () =>
{
    const first = idIn(must(box, demo, ["decide", "the second policy"]).out);
    const approved = await approvedIn(box, demo, ["decide", "replaces it", "--supersedes", first], first);
    assert.equal(approved.code, 0, approved.out);
    const events = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
    const written = events.at(-1);
    assert.equal(written.type, "entity.confirmed");
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: first }]);
    assert.equal(written.payload.confirmation.method, "tty");
    assert.equal(written.payload.confirmation.challenge, first);
});

test("a wrong answer at the terminal records nothing", async () =>
{
    const first = idIn(must(box, demo, ["decide", "the third policy"]).out);
    const before = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trim().split("\n").length;
    const wrong = await approvedIn(box, demo, ["decide", "replaces it", "--supersedes", first], "not-the-id");
    assert.equal(wrong.code, 1);
    const after = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trim().split("\n").length;
    assert.equal(after, before);
});
