// #408, sections C, D and E of `docs/maintainers/case-tables/408-work-criteria.md`:
// covering a declared criterion, blocking one on its own, and the done gate
// that reads them. One test per cell, named by its cell number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, git, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

const C1 = "the fixture regenerates clean";
const C2 = "the release note names the flag";
const C3 = "the vendor quota is raised";

writeFileSync(join(demo, "seed.txt"), "the change\n");
git(box, demo, ["add", "."]);
git(box, demo, ["commit", "-q", "-m", "the change"]);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: demo, env: box.env, encoding: "utf8" }).trim();

function events()
{
    return readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
}

function newest(type)
{
    return events().filter((event) => event.type === type).at(-1);
}

// `U`: a confirmed, started unit declaring three criteria.
async function startedUnit(outcome)
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", outcome,
        "--criteria", C1, "--criteria", C2, "--criteria", C3])).out);
    await must(box, demo, ["work", "start", id]);
    return id;
}

// A unit that satisfies the evidence half of the gate, so a refusal is about
// the criteria and nothing else.
async function evidenced(id)
{
    await must(box, demo, ["report", id, "what happened so far", "--evidence", head]);
    return id;
}

async function reviewPlan(outcome)
{
    return workIdIn((await must(box, demo, ["work", "propose", outcome, "--criteria", C1])).out);
}

/* ── C. covering ───────────────────────────────────────────────────── */

test("cell 23: work cover writes the same entity.covered state cover writes, plus the shared `by`", async () =>
{
    const viaWork = await startedUnit("cell 23 work");
    await must(box, demo, ["work", "cover", viaWork, "--criterion", "c2", "--why", C1, "--evidence", head]);
    const first = newest("entity.covered");
    const viaState = await startedUnit("cell 23 state");
    await must(box, demo, ["state", "cover", viaState, "--criterion", "c2", "--why", C1, "--evidence", head]);
    const second = newest("entity.covered");
    assert.deepEqual({ ...first.payload, entity: null }, { ...second.payload, entity: null });
    assert.deepEqual(first.refs.commits, [head]);
    assert.deepEqual(first.refs, second.refs);
    assert.equal(first.payload.criterion, C2, "the event stores the criterion's text, never its cN");
});

test("cell 24: a plan still in review is refused by the shipped requireCoverable", async () =>
{
    const plan = await reviewPlan("cell 24");
    const result = await selfIn(box, demo, ["work", "cover", plan, "--criterion", "c1", "--why", "w"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is still proposed — coverage lands on a record that holds; confirm it first/);
});

test("cell 25: a criterion no longer needed is covered with a reason and no evidence", async () =>
{
    const id = await startedUnit("cell 25");
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "no longer needed: the API was withdrawn"]);
    const covered = newest("entity.covered");
    assert.equal(covered.refs?.commits, undefined);
    assert.equal(covered.refs?.work, undefined);
    assert.match((await must(box, demo, ["work", "show", id])).out,
        /c2 covered — no longer needed: the API was withdrawn \(agent \d{4}-\d{2}-\d{2}\)/);
});

test("cell 26: a criterion is judged once per record", async () =>
{
    const id = await startedUnit("cell 26");
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    const again = await selfIn(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed again"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /is already covered — a criterion is judged once per record/);
});

test("cell 27: an out-of-range cN is refused with every declaration listed", async () =>
{
    const id = await startedUnit("cell 27");
    const result = await selfIn(box, demo, ["work", "cover", id, "--criterion", "c9", "--why", "w"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`c1 "${C1}"; c2 "${C2}"; c3 "${C3}"`));
});

test("cell 28: addressing a criterion by its text records the same event", async () =>
{
    const id = await startedUnit("cell 28");
    await must(box, demo, ["work", "cover", id, "--criterion", C1, "--why", "landed"]);
    assert.equal(newest("entity.covered").payload.criterion, C1);
});

test("cell 29: covering a blocked criterion records, and the claim ends the block", async () =>
{
    const id = await startedUnit("cell 29");
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"]);
    const before = events().length;
    await must(box, demo, ["work", "cover", id, "--criterion", "c3", "--why", "the vendor confirmed by mail"]);
    assert.equal(events().length, before + 1, "covering a blocked criterion wrote a second event");
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.match(shown, /c3 covered — the vendor confirmed by mail/);
    assert.doesNotMatch(shown, /c3 blocked/);
    assert.match(shown, /- Criteria: 1 of 3 covered$/m, "the block outlived the claim that covered it");
});

test("cell 30: state cover still answers for a work id and is not deprecated", async () =>
{
    const id = await startedUnit("cell 30");
    await must(box, demo, ["state", "cover", id, "--criterion", "c2", "--why", "landed"]);
    assert.equal(newest("entity.covered").payload.criterion, C2);
});

test("cell 31: --work rides the claim as refs.work, unchanged from state cover", async () =>
{
    const other = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 31 other"])).out);
    const id = await startedUnit("cell 31");
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed", "--work", other]);
    assert.equal(newest("entity.covered").refs.work, other);
});

/* ── D. blocking one criterion ─────────────────────────────────────── */

test("cell 32: a criterion's block leaves the unit's own status alone", async () =>
{
    const id = await startedUnit("cell 32");
    const before = events().filter((event) => event.type === "entity.blocked").length;
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"]);
    assert.equal(newest("entity.criterion-blocked").payload.entity, id);
    assert.equal(events().filter((event) => event.type === "entity.blocked").length, before,
        "a criterion's block wrote the unit's own entity.blocked");
    assert.match((await must(box, demo, ["work"])).out, new RegExp(`${id} {2}active`));
});

test("cell 33: work block with no --criterion is the shipped unit-level block", async () =>
{
    const id = await startedUnit("cell 33");
    await must(box, demo, ["work", "block", id, "--on", "external", "--why", "the whole unit waits"]);
    assert.equal(newest("entity.blocked").payload.entity, id);
    assert.match((await must(box, demo, ["work"])).out, new RegExp(`${id} {2}blocked \\(on external\\)`));
});

test("cell 34: work unblock --criterion releases the wait", async () =>
{
    const id = await startedUnit("cell 34");
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"]);
    await must(box, demo, ["work", "unblock", id, "--criterion", "c3"]);
    assert.equal(newest("entity.criterion-unblocked").payload.criterion, C3);
    assert.match((await must(box, demo, ["work", "show", id])).out, /c3 open — the vendor quota is raised/);
});

test("cell 35: the two axes never move each other", async () =>
{
    const id = await startedUnit("cell 35");
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"]);
    await must(box, demo, ["work", "block", id, "--on", "decision", "--why", "pricing undecided"]);
    await must(box, demo, ["work", "unblock", id]);
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.match(shown, /- Status: active/);
    assert.match(shown, /c3 blocked on external — the vendor is silent/);
});

test("cell 36: unblocking a criterion nothing is standing in front of is refused", async () =>
{
    const id = await startedUnit("cell 36");
    const result = await selfIn(box, demo, ["work", "unblock", id, "--criterion", "c3"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${id} c3 is not blocked — there is nothing to release`));
});

test("cell 37: a second block on a criterion already blocked names what it waits on", async () =>
{
    const id = await startedUnit("cell 37");
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor has not confirmed the quota"]);
    const again = await selfIn(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "dependency", "--why", "w"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, new RegExp(`${id} c3 is already blocked on external — the vendor has not confirmed the quota`));
});

test("cell 38: a covered criterion waits on nothing", async () =>
{
    const id = await startedUnit("cell 38");
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    const result = await selfIn(box, demo, ["work", "block", id, "--criterion", "c2", "--on", "external", "--why", "w"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${id} c2 is already covered — a covered criterion waits on nothing`));
});

test("cell 39: the --on enum is judged before the criterion is resolved", async () =>
{
    const id = await startedUnit("cell 39");
    const result = await selfIn(box, demo, ["work", "block", id, "--criterion", "c9", "--on", "paperwork", "--why", "w"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /work block --on must be decision, dependency or external — "paperwork" is none of them/);
});

test("cell 40: an out-of-range cN on a block is refused the way cover refuses one", async () =>
{
    const id = await startedUnit("cell 40");
    const result = await selfIn(box, demo, ["work", "block", id, "--criterion", "c9", "--on", "external", "--why", "w"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`c1 "${C1}"; c2 "${C2}"; c3 "${C3}"`));
});

test("cell 41: a plan nobody confirmed has no working state to move, one level down", async () =>
{
    const plan = await reviewPlan("cell 41");
    const result = await selfIn(box, demo, ["work", "block", plan, "--criterion", "c1", "--on", "external", "--why", "w"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${plan} is a plan still awaiting review — a criterion's block records a fact `
        + `about work that holds; confirm it first with \`self work confirm ${plan}\``));
});

/* ── E. done, and what it names ────────────────────────────────────── */

test("cell 42: a unit that satisfies both halves is done", async () =>
{
    const id = await evidenced(await startedUnit("cell 42"));
    for (const at of ["c1", "c2", "c3"])
    {
        await must(box, demo, ["work", "cover", id, "--criterion", at, "--why", `${at} landed`]);
    }
    assert.equal((await selfIn(box, demo, ["work", "done", id])).code, 0);
});

test("cell 43: the shipped path is unchanged for a unit that declares nothing", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 43"])).out);
    await must(box, demo, ["work", "start", id]);
    assert.equal((await selfIn(box, demo, ["work", "done", id, "--report", "it verifiably happened"])).code, 0);
});

test("cell 44: an open criterion refuses done by id and by text, and appends nothing", async () =>
{
    const id = await evidenced(await startedUnit("cell 44"));
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c3", "--why", "landed"]);
    const before = events().length;
    const result = await selfIn(box, demo, ["work", "done", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`c2 {2}open — ${C2}`));
    assert.match(result.out, new RegExp(`cover each with \`self work cover ${id} --criterion c2 --why "<how>"\``));
    assert.equal(events().length, before, "the refused done appended something");
});

test("cell 45: a blocked criterion is named with its --on and its reason", async () =>
{
    const id = await evidenced(await startedUnit("cell 45"));
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"]);
    const result = await selfIn(box, demo, ["work", "done", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /c3 {2}blocked on external — the vendor is silent/);
    assert.match(result.out, /a covered criterion's block ends with it/);
});

test("cell 46: one refusal lists both, in cN order, blocked rows carrying --on and --why", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 46",
        "--criteria", C1, "--criteria", C2, "--criteria", C3, "--criteria", "the changelog names it"])).out);
    await must(box, demo, ["work", "start", id]);
    await evidenced(id);
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"]);
    const result = await selfIn(box, demo, ["work", "done", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${id} declares 4 criteria and 2 are not covered:\\n`
        + "    c3  blocked on external — the vendor is silent\\n"
        + "    c4  open — the changelog names it\\n"));
});

test("cell 47: the criteria clause is judged before the evidence clause", async () =>
{
    const id = await startedUnit("cell 47");
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c3", "--why", "landed"]);
    const first = await selfIn(box, demo, ["work", "done", id]);
    assert.notEqual(first.code, 0);
    assert.match(first.out, new RegExp(`c2 {2}open — ${C2}`));
    assert.doesNotMatch(first.out, /no evidence for done/);
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    const second = await selfIn(box, demo, ["work", "done", id]);
    assert.notEqual(second.code, 0);
    assert.match(second.out, /has no evidence for done/);
});

test("cell 48: with every criterion covered the shipped evidence gate answers, unchanged", async () =>
{
    const id = await startedUnit("cell 48");
    for (const at of ["c1", "c2", "c3"])
    {
        await must(box, demo, ["work", "cover", id, "--criterion", at, "--why", "landed"]);
    }
    const result = await selfIn(box, demo, ["work", "done", id]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${id} has no evidence for done — attach a report first`));
});

test("cell 49: `work show` carries the identical sentence the done refusal gives", async () =>
{
    const id = await evidenced(await startedUnit("cell 49"));
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c3", "--why", "landed"]);
    const refusal = (await selfIn(box, demo, ["work", "done", id])).out.replace(/^error: /, "").trimEnd();
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.ok(shown.includes(`- Not done yet: ${refusal}`), `work show did not carry the refusal:\n${shown}`);
});

test("cell 50: done is still allowed while the unit is blocked; only the criterion stops it", async () =>
{
    const id = await evidenced(await startedUnit("cell 50"));
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c3", "--why", "landed"]);
    await must(box, demo, ["work", "block", id, "--on", "decision", "--why", "pricing undecided"]);
    const refused = await selfIn(box, demo, ["work", "done", id]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`c2 {2}open — ${C2}`));
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    assert.equal((await selfIn(box, demo, ["work", "done", id])).code, 0, "done was refused for the unit's own block");
});

test("cell 51: the raw path keeps its own spelling of the shared gate", async () =>
{
    const raw = (await must(box, demo, ["state", "add", "cell 51", "--criteria", C1])).out.match(/\be-[0-9a-z]{5}\b/)[0];
    const result = await selfIn(box, demo, ["state", "done", raw, "--report", "it happened"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`cover each with \`self state cover ${raw} --criterion c1 --why "<how>"\``));
    assert.match(result.out, /or retire the entity if the outcome was given up/);
    assert.doesNotMatch(result.out, /self work cover/);
});
