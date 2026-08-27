// Review before a record settles (#390 §2).
//
// Cells 66–78 of docs/maintainers/case-tables/390-undo-review-settle.md, named
// by cell number. Every mutating command's receipt prints the record it
// actually resolved and the exact line that takes it back; `--meant` adds the
// caller's own restatement beside it; settling is derived from the next append
// and recorded nowhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, git, idIn, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

function events(project = "demo")
{
    return readFileSync(join(ws, ".superself", "projects", project, "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
}

// A second session against the same workspace. The only thing that separates
// two sessions is what the environment says the session is (#230).
// Not `SUPERSELF_SESSION`: `human.ts` reads that one as a runner's attempt
// marker, so naming a session through it would also make this process an agent
// and refuse the person-gated verb these cells drive.
const OTHER_SESSION = { CLAUDE_CODE_SESSION_ID: "othersess" };

async function addUnit(outcome, extra = {})
{
    return workIdIn((await mustPerson(box, demo, ["work", "add", outcome], extra)).out);
}

test("cell 66: the receipt prints the resolved record and the line that takes it back", async () =>
{
    const printed = (await mustPerson(box, demo, ["work", "add", "cell 66: ship the retry backoff"])).out;
    const id = workIdIn(printed);
    const event = events().filter((item) => item.payload.entity === id).at(-1).id;
    assert.ok(printed.includes(`cell 66: ship the retry backoff`), printed);
    assert.ok(printed.includes(`self undo ${event}`), printed);
});

test("cell 67: --meant prints the caller's restatement beside the record and records it", async () =>
{
    const id = await addUnit("cell 67: pin the clock in the retry test");
    const printed = (await must(box, demo, ["work", "done", id, "--report", "cell 67: what happened",
        "--meant", "the retry-test clock unit"])).out;
    assert.ok(printed.includes("meant: the retry-test clock unit"), printed);
    assert.equal(events().filter((item) => item.type === "entity.done" && item.payload.entity === id).at(-1)
        .payload.meant, "the retry-test clock unit");
});

test("cell 68: a mismatched --meant records anyway and shows both texts side by side", async () =>
{
    const wanted = await addUnit("cell 68: the unit the caller meant");
    const typed = await addUnit("cell 68: the unit the caller typed");
    const printed = (await must(box, demo, ["work", "done", typed, "--report", "cell 68: what happened",
        "--meant", "the unit the caller meant"])).out;
    // No heuristic refusal: a fuzzy comparator would be a second thing to be
    // wrong about. Two independent statements, printed together, are the check.
    assert.ok(printed.includes("cell 68: the unit the caller typed"), printed);
    assert.ok(printed.includes("meant: the unit the caller meant"), printed);
    assert.match((await must(box, demo, ["work", "show", wanted])).out, /- Status: next/);
});

test("cell 69: the handed undo line, run verbatim, opens the wrong unit again", async () =>
{
    const typed = await addUnit("cell 69: the unit closed against the caller's intent");
    const printed = (await must(box, demo, ["work", "done", typed, "--report", "cell 69: what happened",
        "--meant", "some other unit"])).out;
    const line = printed.split("\n").find((row) => row.includes("self undo "));
    assert.notEqual(line, undefined, printed);
    const handed = line.slice(line.indexOf("self undo ") + "self undo ".length).trim();
    await must(box, demo, ["undo", handed]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", typed])).out, /- Status: done/);
});

// The design expected a `--json` receipt to skip the review line while still
// recording `payload.meant`. No record-writing verb declares `--json` today:
// the machine contract refuses the flag before anything resolves, so the review
// line can never reach a machine surface at all. The guard is in place for the
// day one of them does; what is reachable now is this refusal.
test("cell 70: a machine surface never sees the review line, because no write verb takes --json", async () =>
{
    const id = await addUnit("cell 70: a unit a machine caller tried to close");
    const before = events().length;
    const refused = await selfIn(box, demo, ["work", "done", id, "--json", "--meant", "the machine caller's unit"]);
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /json_unsupported/);
    assert.doesNotMatch(refused.out, /self undo/);
    assert.equal(events().length, before);
});

test("cell 71: an empty --meant is refused before anything resolves", async () =>
{
    const before = events().length;
    const refused = await selfIn(box, demo, ["decide", "cell 71: a decision nobody recorded", "--meant", ""]);
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /--meant/);
    assert.equal(events().length, before);
});

test("cell 72: a read-only command prints no receipt line and records nothing", async () =>
{
    const before = events().length;
    const printed = (await must(box, demo, ["context"])).out;
    assert.doesNotMatch(printed, /verify; wrong\?/);
    assert.equal(events().length, before);
});

test("cell 73: the next append settles the one before it, so the bare undo moves on", async () =>
{
    const first = await addUnit("cell 73: the outcome recorded first");
    const second = await addUnit("cell 73: the outcome recorded second");
    await must(box, demo, ["undo"]);
    assert.match((await must(box, demo, ["work", "show", second])).out, /- Status: undone/);
    assert.doesNotMatch((await must(box, demo, ["work", "show", first])).out, /- Status: undone/);
});

test("cell 74: a record this session just wrote raises no unreviewed line", async () =>
{
    await addUnit("cell 74: an outcome this session recorded and read back");
    assert.doesNotMatch((await must(box, demo, ["context"])).out, /the last record is unreviewed/);
});

test("cell 75: a record another session wrote raises one unreviewed line in Health", async () =>
{
    const id = await addUnit("cell 75: an outcome another session left behind", OTHER_SESSION);
    const seen = (await must(box, demo, ["context"])).out;
    assert.match(seen, /the last record is unreviewed/);
    assert.ok(seen.includes(id), seen);
    assert.match(seen, /`self undo` takes it back/);
});

test("cell 76: once it is undone the line is gone, and the annulment is not itself flagged", async () =>
{
    await addUnit("cell 76: an outcome another session left unreviewed", OTHER_SESSION);
    assert.match((await must(box, demo, ["context"])).out, /the last record is unreviewed/);
    await must(box, demo, ["undo"], OTHER_SESSION);
    assert.doesNotMatch((await must(box, demo, ["context"])).out, /the last record is unreviewed/);
});

test("cell 77: a command that records nothing does not close the review window", async () =>
{
    const id = await addUnit("cell 77: an outcome no read settles", OTHER_SESSION);
    await must(box, demo, ["work"]);
    await must(box, demo, ["search", "cell 77"]);
    assert.ok((await must(box, demo, ["context"])).out.includes(id));
});

test("cell 78: --meant on a command that writes into another project lands in that log", async () =>
{
    const other = join(ws, "cell78");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    await must(box, other, ["project", "init", "--name", "cell78", "--desc", "another project"]);
    const id = idIn((await must(box, other, ["decide", "cell 78: a decision recorded next door",
        "--meant", "the neighbouring project's decision"])).out);
    const recorded = events("cell78").find((item) => item.payload.entity === id);
    assert.equal(recorded.payload.meant, "the neighbouring project's decision");
    assert.equal(events().some((item) => item.payload.meant === "the neighbouring project's decision"), false);
});
