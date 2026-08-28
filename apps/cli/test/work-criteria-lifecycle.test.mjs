// #408, sections F and G of `docs/maintainers/case-tables/408-work-criteria.md`:
// what a revision, a supersession, a confirm, a decline and a retirement do to
// a unit's declared criteria, and what `self undo` gives back on the criterion
// axis. One test per cell, named by its cell number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

const C1 = "the fixture regenerates clean";
const C2 = "the release note names the flag";
const C3 = "the vendor quota is raised";

function events()
{
    return readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
}

function newest(type)
{
    const found = events().filter((event) => event.type === type).at(-1);
    assert.ok(found !== undefined, `no ${type} in the log`);
    return found;
}

function criteriaOf(shown)
{
    return shown.split("\n").filter((line) => line.startsWith("criterion: ")).map((line) => line.slice("criterion: ".length));
}

// A correction prints the predecessor's id first — the append discloses what
// it destroys before it writes — so the new unit is the id the receipt puts on
// a line of its own, not the first one in the output.
function receiptId(printed)
{
    const line = printed.split("\n").map((text) => text.trim()).find((text) => /^w-[0-9a-z]{5}$/.test(text));
    assert.ok(line !== undefined, `no receipt id in: ${printed}`);
    return line;
}

async function startedUnit(outcome)
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", outcome,
        "--criteria", C1, "--criteria", C2, "--criteria", C3])).out);
    await must(box, demo, ["work", "start", id]);
    return id;
}

/* ── F. lifecycle ──────────────────────────────────────────────────── */

test("cell 52: a revision restates the plan text and carries the criteria", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 52", "--criteria", "a", "--criteria", "b"])).out);
    await must(box, demo, ["work", "revise", id, "cell 52 revised", "--why", "the first plan skipped a step"]);
    const revised = newest("entity.revised");
    assert.equal(revised.payload.entity, id);
    assert.equal(revised.payload.text, "cell 52 revised");
    assert.deepEqual(criteriaOf((await must(box, demo, ["state", "show", id])).out), ["c1 a", "c2 b"]);
});

test("cell 53: work revise --criteria is refused, naming the verb that appends one", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 53", "--criteria", "a"])).out);
    const result = await selfIn(box, demo, ["work", "revise", id, "cell 53 revised", "--why", "w", "--criteria", "c"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`work revise restates the plan text — declare a criterion with `
        + `\`self work criteria add ${id} "<text>"\`, which appends it to the ones already declared`));
});

test("cell 54: a declaration lands whether it is made before or after the confirm", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 54", "--criteria", "a", "--criteria", "b"])).out);
    await must(box, demo, ["work", "revise", id, "cell 54 revised", "--why", "the first plan skipped a step"]);
    await must(box, demo, ["work", "criteria", "add", id, "c"]);
    await mustPerson(box, demo, ["work", "confirm", id]);
    assert.deepEqual(criteriaOf((await must(box, demo, ["state", "show", id])).out), ["c1 a", "c2 b", "c3 c"]);
    await must(box, demo, ["work", "criteria", "add", id, "d"]);
    assert.deepEqual(criteriaOf((await must(box, demo, ["state", "show", id])).out), ["c1 a", "c2 b", "c3 c", "c4 d"]);
});

test("cell 55: nothing edits or removes a birth criterion — both refusals say so", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 55", "--criteria", "a"])).out);
    const revised = await selfIn(box, demo, ["work", "revise", id, "cell 55 revised", "--why", "w", "--criteria", "b"]);
    assert.match(revised.out, /work revise restates the plan text — declare a criterion with/);
    const twice = await selfIn(box, demo, ["work", "criteria", "add", id, "a"]);
    assert.match(twice.out, /already declares c1 "a" — a criterion is judged once/);
    // The one path that removes a birth criterion is undoing the plan itself.
    const creation = events().findLast((event) => event.type === "entity.proposed" && event.payload.entity === id);
    await must(box, demo, ["undo", creation.id, "--why", "the criteria were wrong"]);
    assert.match((await must(box, demo, ["work", "show", id])).out, /Status: undone/);
});

test("cell 56: a successor inherits nothing", async () =>
{
    const predecessor = await startedUnit("cell 56");
    const successor = receiptId((await mustPerson(box, demo, ["work", "add", "cell 56 successor",
        "--supersedes", predecessor, "--why", "the outcome moved", "--criteria", C1])).printed);
    assert.deepEqual(criteriaOf((await must(box, demo, ["state", "show", successor])).out), [`c1 ${C1}`]);
    const before = (await must(box, demo, ["state", "show", predecessor])).out;
    assert.deepEqual(criteriaOf(before), [`c1 ${C1}`, `c2 ${C2}`, `c3 ${C3}`]);
    assert.match(before, /working: retired/);
});

test("cell 57: a successor declaring nothing is gated on nothing", async () =>
{
    const predecessor = await startedUnit("cell 57");
    const successor = receiptId((await mustPerson(box, demo, ["work", "add", "cell 57 successor",
        "--supersedes", predecessor, "--why", "the outcome moved"])).printed);
    assert.deepEqual(criteriaOf((await must(box, demo, ["state", "show", successor])).out), []);
    assert.match((await must(box, demo, ["work", "show", predecessor])).out, /- Retired: the outcome moved/);
});

test("cell 58: confirming a plan that carries --supersedes lands one append and the declared list", async () =>
{
    const predecessor = await startedUnit("cell 58");
    const plan = workIdIn((await must(box, demo, ["work", "propose", "cell 58 plan", "--criteria", "a", "--criteria", "b",
        "--supersedes", predecessor, "--why", "the outcome moved"])).out);
    const before = events().length;
    await mustPerson(box, demo, ["work", "confirm", plan]);
    const appended = events().slice(before);
    assert.deepEqual(appended.map((event) => event.type), ["entity.confirmed", "entity.retired"]);
    assert.deepEqual(criteriaOf((await must(box, demo, ["state", "show", plan])).out), ["c1 a", "c2 b"]);
});

test("cell 59: declining a plan records entity.retracted alone", async () =>
{
    const plan = workIdIn((await must(box, demo, ["work", "propose", "cell 59", "--criteria", "a"])).out);
    const before = events().length;
    await must(box, demo, ["work", "decline", plan, "--why", "the plan is not wanted"]);
    const appended = events().slice(before);
    assert.deepEqual(appended.map((event) => event.type), ["entity.retracted"]);
    assert.doesNotMatch((await must(box, demo, ["work"])).out, new RegExp(plan));
});

test("cell 60: retirement is never gated on criteria", async () =>
{
    const id = await startedUnit("cell 60");
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    const retired = await approvedIn(box, demo, ["work", "retire", id, "--why", "the outcome was given up"], id);
    assert.equal(retired.code, 0, retired.out);
    assert.match((await must(box, demo, ["work", "show", id])).out, /- Retired: the outcome was given up/);
});

/* ── G. `self undo` ────────────────────────────────────────────────── */

test("cell 61: undoing a claim opens the criterion and gates done again", async () =>
{
    const id = await startedUnit("cell 61");
    const claim = (await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed"])).out;
    const receipt = (await must(box, demo, ["undo", claim.match(/\[([0-9a-z]{26})\]/)[1], "--why", "judged too early"])).printed;
    assert.match(receipt, new RegExp(`${id} has that criterion open again — the coverage claim was taken back`));
    assert.match((await must(box, demo, ["work", "show", id])).out, new RegExp(`c2 open — ${C2}`));
});

test("cell 62: undoing a claim over a blocked criterion gives the block back, through the fold", async () =>
{
    const id = await startedUnit("cell 62");
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"]);
    const claim = (await must(box, demo, ["work", "cover", id, "--criterion", "c3", "--why", "the vendor confirmed by mail"])).out;
    assert.match((await must(box, demo, ["work", "show", id])).out, /c3 covered/);
    const before = events().length;
    await must(box, demo, ["undo", claim.match(/\[([0-9a-z]{26})\]/)[1], "--why", "the mail was about something else"]);
    assert.equal(events().length, before + 1, "restoring the block took a second event");
    assert.match((await must(box, demo, ["work", "show", id])).out, /c3 blocked on external — the vendor is silent/);
});

test("cell 63: undoing a criterion block opens it again, with a row of its own", async () =>
{
    const id = await startedUnit("cell 63");
    const blocked = (await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"])).out;
    const receipt = (await must(box, demo, ["undo", blocked.match(/\[([0-9a-z]{26})\]/)[1], "--why", "the block was recorded in error"])).printed;
    assert.match(receipt, new RegExp(`${id} c3 is open again — the block was taken back`));
    assert.match((await must(box, demo, ["work", "show", id])).out, new RegExp(`c3 open — ${C3}`));
});

test("cell 64: undoing a declaration removes it and renumbers what follows", async () =>
{
    const id = await startedUnit("cell 64");
    const declared = (await must(box, demo, ["work", "criteria", "add", id, "d"])).out;
    const receipt = (await must(box, demo, ["undo", declared.match(/\[([0-9a-z]{26})\]/)[1], "--why", "declared on the wrong unit"])).printed;
    assert.match(receipt, new RegExp(`${id} no longer declares "d" — the declaration was taken back; the criteria after it renumber`));
    assert.deepEqual(criteriaOf((await must(box, demo, ["state", "show", id])).out), [`c1 ${C1}`, `c2 ${C2}`, `c3 ${C3}`]);
});

test("cell 65: a covered criterion's declaration is still undoable, and the claim folds to nothing", async () =>
{
    const id = await startedUnit("cell 65");
    const declared = (await must(box, demo, ["work", "criteria", "add", id, "d"])).out;
    await must(box, demo, ["work", "cover", id, "--criterion", "c4", "--why", "landed"]);
    const undone = await selfIn(box, demo, ["undo", declared.match(/\[([0-9a-z]{26})\]/)[1], "--why", "declared on the wrong unit"]);
    assert.equal(undone.code, 0, undone.out);
    const shown = (await must(box, demo, ["state", "show", id])).out;
    assert.deepEqual(criteriaOf(shown), [`c1 ${C1}`, `c2 ${C2}`, `c3 ${C3}`]);
    assert.doesNotMatch(shown, /covered: /, "a claim on an undeclared criterion still folded");
});

test("cell 66: only the undone criterion leaves; every other keeps its place and its claim", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 66", "--criteria", C1])).out);
    await must(box, demo, ["work", "start", id]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed first"]);
    const declared = (await must(box, demo, ["work", "criteria", "add", id, "d"])).out;
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed second"]);
    await must(box, demo, ["undo", declared.match(/\[([0-9a-z]{26})\]/)[1], "--why", "declared on the wrong unit"]);
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.match(shown, /- Criteria: 1 of 1 covered/);
    assert.match(shown, /c1 covered — landed first/);
});

test("cell 67: undoing a release puts the block back, naming its --on and --why", async () =>
{
    const id = await startedUnit("cell 67");
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"]);
    const released = (await must(box, demo, ["work", "unblock", id, "--criterion", "c3"])).out;
    const receipt = (await must(box, demo, ["undo", released.match(/\[([0-9a-z]{26})\]/)[1], "--why", "released too early"])).printed;
    assert.match(receipt, new RegExp(`${id} c3 waits on external: the vendor is silent again — the release was taken back`));
    assert.match((await must(box, demo, ["work", "show", id])).out, /c3 blocked on external — the vendor is silent/);
});

test("cell 68: undoing a creation takes the whole unit, criteria included", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 68",
        "--criteria", C1, "--criteria", C2])).out);
    const creation = events().findLast((event) => event.type === "entity.confirmed" && event.payload.entity === id);
    const undone = await selfIn(box, demo, ["undo", creation.id, "--why", "recorded by mistake"]);
    assert.equal(undone.code, 0, undone.out);
    assert.match(undone.out, new RegExp(`${id} was recorded by mistake and is undone`));
    assert.match((await must(box, demo, ["work", "show", id])).out, /Status: undone/);
});
