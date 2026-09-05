// The read-only direction check — #417, part (c).
//
// Every test below is one cell of docs/maintainers/case-tables/417-check.md,
// named by its cell number, and asserts that cell's stated outcome. The
// assertions read what the CLI prints and what its store holds; none of them
// calls the projection the implementation calls, so a projection that is wrong
// in the same way twice still fails here.
//
// Every shared fixture is built above the first `test()`. The driver runs the
// CLI in this process, so a top-level `await` between two registrations would
// let a test start while a fixture was still recording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../dist/main.js";
import { resolveCommand } from "../dist/contract.js";
import { commonProtocolLines } from "../dist/connect.js";
import { findTopic } from "../dist/guide.js";
import { buildModel } from "../dist/model.js";
import { checkDirection, FINDING_KINDS } from "../dist/check.js";
import { ulid } from "../dist/ids.js";
import { approvedIn, demoWorkspace, git, logFixture, machine, must, mustPerson, receiptIn } from "./harness.mjs";

const objectiveIdIn = (text) => text.match(/\bo-[0-9a-z]{5}\b/)[0];
const milestoneIdIn = (text) => text.match(/\bm-[0-9a-z]{5}\b/)[0];
const workIdIn = (text) => text.match(/\bw-[0-9a-z]{5}\b/)[0];

// One scratch machine holding one registered project, with the three ways this
// file drives it.
async function box()
{
    const machineBox = machine();
    const { ws, demo } = await demoWorkspace(machineBox);
    return {
        box: machineBox,
        ws,
        demo,
        run: async (args) => (await must(machineBox, demo, args)).out,
        person: async (args) => (await mustPerson(machineBox, demo, args)).out,
        approved: (args, answer) => approvedIn(machineBox, demo, args, answer),
        check: async () => (await must(machineBox, demo, ["objective", "check"])).out,
        json: async () => JSON.parse((await must(machineBox, demo, ["objective", "check", "--json"])).out)
    };
}

// The findings of one kind, as the JSON answer states them. Read off the
// machine shape rather than off the page, so a cell says which kind it means
// instead of matching a sentence that could move.
function kinds(report, kind)
{
    return report.findings.filter((finding) => finding.kind === kind);
}

/* ── the shared fixtures, all built before the first test ──────────── */

// An objective, a checkpoint, two units on it, and a successor checkpoint that
// carried nothing — which is what `milestone add --supersedes` leaves behind.
// Cells 1, 2, 6, 7, 8, 11, 37 and 38 read it.
async function stranded()
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome", "--target", "2099-06-01"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const first = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    const second = workIdIn(await F.person(["work", "add", "another bounded effort"]));
    await F.run(["work", "link", first, "--milestone", milestone]);
    await F.run(["work", "link", second, "--milestone", milestone]);
    const successor = milestoneIdIn(receiptIn((await F.approved(["milestone", "add", "the checkpoint, restated",
        "--objective", objective, "--exit", "the thing is true", "--supersedes", milestone], milestone)).printed));
    return { ...F, objective, milestone, successor, first, second };
}

const stray = await stranded();

// The same shape, with the successor reached instead of open: a lineage that
// ends closed offers no relink. Cell 6.
async function endsClosed()
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", work, "--milestone", milestone]);
    const successor = milestoneIdIn(receiptIn((await F.approved(["milestone", "add", "the checkpoint, restated",
        "--objective", objective, "--exit", "the thing is true", "--supersedes", milestone], milestone)).printed));
    await F.run(["milestone", "met", successor, "--criterion", "c1", "--why", "it landed"]);
    await F.run(["milestone", "reach", successor]);
    return { ...F, objective, milestone, successor, work };
}

const closedLineage = await endsClosed();

// A checkpoint an objective revision carried, whose coverage was judged under
// the former parent. Cells 17 and 18.
async function carried()
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the first half lands", "--exit", "the second half lands"]));
    await F.run(["milestone", "met", milestone, "--criterion", "c1", "--why", "the first half landed"]);
    await F.run(["milestone", "met", milestone, "--criterion", "c2", "--why", "the second half landed"]);
    const successor = objectiveIdIn(receiptIn((await F.approved(["objective", "revise", objective,
        "--why", "the wording settled", "--outcome", "the outcome, restated"], objective)).printed));
    return { ...F, objective, successor, milestone };
}

const moved = await carried();

// A checkpoint standing on a decision that was later replaced, beside one
// standing on a decision that was retracted with nothing replacing it.
// Cells 19 and 20.
async function assumptions()
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const replaced = (await F.run(["decide", "the first take"])).match(/\[([^\]]+)\]/)[1];
    const successor = (await F.approved(["decide", "the second take", "--supersedes", replaced], replaced))
        .printed.match(/\[([0-9a-z]{26})\]/g).map((found) => found.slice(1, -1)).at(-1);
    const withdrawn = (await F.run(["decide", "a take nobody replaced"])).match(/\[([^\]]+)\]/)[1];
    await F.approved(["decide", "retract", withdrawn, "--why", "it stopped holding"], withdrawn);
    const first = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true", "--decision", replaced]));
    const second = milestoneIdIn(await F.run(["milestone", "add", "another checkpoint",
        "--objective", objective, "--exit", "the other thing is true", "--decision", withdrawn]));
    return { ...F, objective, replaced, successor, withdrawn, first, second };
}

const assumed = await assumptions();

// A done unit with reported evidence under a checkpoint whose criteria are
// still open. Cells 21, 22 and 24.
async function candidates()
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    git(F.box, F.demo, ["commit", "--allow-empty", "-q", "-m", "the work"]);
    const done = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", done, "--milestone", milestone]);
    await F.run(["report", done, "the effort landed"]);
    await F.run(["work", "done", done]);
    return { ...F, objective, milestone, done };
}

const evidence = await candidates();

// The guard part (b) shipped refuses this at `milestone add`, so the state can
// only be reached by a store that already holds it: the checkpoint is dated
// under a later objective date, and the objective's own date then moves in.
async function datedPast(objectiveTarget, milestoneTarget, close)
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome", "--target", "2099-12-31"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true",
        ...(milestoneTarget === undefined ? [] : ["--target", milestoneTarget])]));
    const receipt = receiptIn((await F.approved(["objective", "revise", objective, "--why", "the date moved",
        ...(objectiveTarget === undefined ? ["--target", ""] : ["--target", objectiveTarget])], objective)).printed);
    const successor = objectiveIdIn(receipt);
    if (close === true)
    {
        await F.approved(["milestone", "drop", milestone, "--why", "it stopped mattering"], milestone);
    }
    return { ...F, objective: successor, milestone };
}

const late = await datedPast("2099-06-01", "2099-09-01");

/* ── 1: finding 1 — every contribution points at an outcome that is over ── */

test("1: a live unit whose only contribution is a superseded checkpoint is named, with the relink", async () =>
{
    const report = await stray.json();
    const found = kinds(report, "obsolete-contributions");
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((item) => item.record.id).sort(), [stray.first, stray.second].sort());
    assert.equal(found[0].class, "structural");
    assert.match(found[0].summary, new RegExp(`every outcome ${found[0].record.id} contributes to is over — ${stray.milestone} \\(closed\\)`));
    assert.ok(found[0].commands.includes(`self work link ${found[0].record.id} --milestone ${stray.successor}`));
    assert.ok(found[0].commands.includes(`self work unlink ${found[0].record.id} --milestone ${stray.milestone}`));
    assert.ok(found[0].commands.some((command) => command.startsWith(`self work retire ${found[0].record.id} `)));
});

test("2: one live contribution is enough — the check asks nothing about the rest", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const other = objectiveIdIn(await F.run(["objective", "add", "an unrelated outcome"]));
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", work, "--objective", objective]);
    await F.run(["work", "link", work, "--objective", other]);
    await F.approved(["objective", "close", objective, "--as", "dropped", "--why", "it stopped mattering"], objective);
    assert.deepEqual(kinds(await F.json(), "obsolete-contributions"), []);
});

test("3: a reached checkpoint is a closed outcome, exactly as the guard reads it", async () =>
{
    const report = await closedLineage.json();
    const found = kinds(report, "obsolete-contributions");
    assert.equal(found.length, 1);
    assert.equal(found[0].record.id, closedLineage.work);
});

test("4: a live checkpoint under a dropped objective is closed because its objective is", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", work, "--milestone", milestone]);
    await F.approved(["objective", "close", objective, "--as", "dropped", "--why", "it stopped mattering"], objective);
    const found = kinds(await F.json(), "obsolete-contributions");
    assert.equal(found.length, 1);
    assert.equal(found[0].record.id, work);
});

test("5: a done unit on a superseded checkpoint is history, not drift", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    git(F.box, F.demo, ["commit", "--allow-empty", "-q", "-m", "the work"]);
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", work, "--milestone", milestone]);
    await F.run(["report", work, "the effort landed"]);
    await F.run(["work", "done", work]);
    await F.approved(["milestone", "add", "the checkpoint, restated", "--objective", objective,
        "--exit", "the thing is true", "--supersedes", milestone], milestone);
    assert.deepEqual(kinds(await F.json(), "obsolete-contributions"), []);
});

test("6: a lineage that ends closed offers no relink, only the standalone and the retire", async () =>
{
    const found = kinds(await closedLineage.json(), "obsolete-contributions")[0];
    assert.ok(!found.commands.some((command) => /self work link .* --milestone/.test(command)),
        `a relink is offered into a closed lineage: ${found.commands.join(" | ")}`);
    assert.ok(found.commands.some((command) => /--standalone --why/.test(command)));
    assert.ok(found.commands.some((command) => command.startsWith("self work retire ")));
});

test("53: a unit contributing to two closed outcomes prints one unlink per target, and the printed route reconciles it", async () =>
{
    const F = await box();
    const droppedObjective = objectiveIdIn(await F.run(["objective", "add", "an outcome given up"]));
    const parent = objectiveIdIn(await F.run(["objective", "add", "another outcome"]));
    const droppedMilestone = milestoneIdIn(await F.run(["milestone", "add", "a checkpoint given up",
        "--objective", parent, "--exit", "the thing is true"]));
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", work, "--objective", droppedObjective]);
    await F.run(["work", "link", work, "--milestone", droppedMilestone]);
    await F.approved(["objective", "close", droppedObjective, "--as", "dropped", "--why", "it stopped mattering"], droppedObjective);
    await F.approved(["milestone", "drop", droppedMilestone, "--why", "it stopped mattering"], droppedMilestone);

    const found = kinds(await F.json(), "obsolete-contributions").find((item) => item.record.id === work);
    const unlinks = found.commands.filter((command) => command.startsWith(`self work unlink ${work}`));
    assert.deepEqual(unlinks, [
        `self work unlink ${work} --milestone ${droppedMilestone}`,
        `self work unlink ${work} --objective ${droppedObjective}`
    ], "the printed unlinks do not name both closed targets in the summary's stable order");

    for (const printed of unlinks)
    {
        await F.run(printed.split(" ").slice(1));
    }
    await F.run(["work", "link", work, "--standalone", "--why", "it moves no stated outcome"]);

    const report = await F.json();
    assert.deepEqual(kinds(report, "obsolete-contributions").filter((item) => item.record.id === work), []);
    assert.deepEqual(kinds(report, "no-disposition").filter((item) => item.record.id === work), []);
    const model = buildModel(join(F.ws, ".superself"), "demo", new Date("2020-01-01T00:00:00.000Z"));
    assert.notEqual(model.works.find((item) => item.id === work).status, "retired");
});

/* ── 2: finding 2 — an empty successor beside a live predecessor ───── */

test("7: an uncarried successor is named beside the units still on its predecessor", async () =>
{
    const found = kinds(await stray.json(), "empty-successor");
    assert.equal(found.length, 1);
    assert.equal(found[0].record.id, stray.successor);
    assert.equal(found[0].objective.id, stray.objective);
    assert.match(found[0].summary, new RegExp(`${stray.successor} succeeds ${stray.milestone} and has no live work`));
    for (const unit of [stray.first, stray.second])
    {
        assert.match(found[0].summary, new RegExp(unit));
    }
});

test("8: relinking both units clears the finding", async () =>
{
    const F = await stranded();
    for (const unit of [F.first, F.second])
    {
        await F.run(["work", "link", unit, "--milestone", F.successor]);
    }
    assert.deepEqual(kinds(await F.json(), "empty-successor"), []);
});

test("9: a revision's own carry leaves no finding — which is what `milestone revise` writes", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", work, "--milestone", milestone]);
    await F.approved(["milestone", "revise", milestone, "--why", "reworded",
        "--outcome", "the checkpoint, restated"], milestone);
    assert.deepEqual(kinds(await F.json(), "empty-successor"), []);
});

test("10: a predecessor holding only closed work strands nothing", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", work, "--milestone", milestone]);
    await F.approved(["work", "retire", work, "--why", "it moved elsewhere"], work);
    await F.approved(["milestone", "add", "the checkpoint, restated", "--objective", objective,
        "--exit", "the thing is true", "--supersedes", milestone], milestone);
    assert.deepEqual(kinds(await F.json(), "empty-successor"), []);
});

test("11: the finding offers the relink, a successor proposal and the drop — and no decision", async () =>
{
    const found = kinds(await stray.json(), "empty-successor")[0];
    assert.ok(found.commands.includes(`self work link ${stray.first} --milestone ${stray.successor}`));
    assert.ok(found.commands.some((command) => command.startsWith(`self work propose "<plan>" --milestone ${stray.successor}`)));
    assert.ok(found.commands.some((command) => command.startsWith(`self milestone drop ${stray.successor} --why`)));
    assert.ok(!found.commands.some((command) => command.startsWith("self decide")),
        `a prose decision is advertised as clearing a structural finding: ${found.commands.join(" | ")}`);
});

/* ── 3: finding 3 — a checkpoint dated past its objective ──────────── */

test("12: a checkpoint dated past its objective names both dates and both revisions", async () =>
{
    const found = kinds(await late.json(), "date-order");
    assert.equal(found.length, 1);
    assert.equal(found[0].class, "structural");
    assert.match(found[0].summary, new RegExp(`${late.milestone} is dated 2099-09-01, past ${late.objective}'s 2099-06-01`));
    assert.ok(found[0].commands.some((command) => command.startsWith(`self milestone revise ${late.milestone} --target `)));
    assert.ok(found[0].commands.some((command) => command.startsWith(`self objective revise ${late.objective} --target `)));
});

test("13: equal dates pass, exactly as they do at the guard", async () =>
{
    const F = await datedPast("2099-09-01", "2099-09-01");
    assert.deepEqual(kinds(await F.json(), "date-order"), []);
});

test("14: a missing date is not an ordering failure", async () =>
{
    const withoutObjective = await datedPast(undefined, "2099-09-01");
    assert.deepEqual(kinds(await withoutObjective.json(), "date-order"), []);
    const withoutMilestone = await datedPast("2099-06-01", undefined);
    assert.deepEqual(kinds(await withoutMilestone.json(), "date-order"), []);
});

test("15: revising the checkpoint's date clears the finding", async () =>
{
    const F = await datedPast("2099-06-01", "2099-09-01");
    await F.approved(["milestone", "revise", F.milestone, "--why", "the date moved back",
        "--target", "2099-05-01"], F.milestone);
    assert.deepEqual(kinds(await F.json(), "date-order"), []);
});

test("16: a dropped checkpoint dated past its objective is history, not drift", async () =>
{
    const F = await datedPast("2099-06-01", "2099-09-01", true);
    assert.deepEqual(kinds(await F.json(), "date-order"), []);
});

/* ── 4: finding 4 — a judgment or an assumption made somewhere else ── */

test("17: a carried judgment is one review finding per affected criterion, with the recheck", async () =>
{
    const found = kinds(await moved.json(), "judgment-review");
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((item) => item.detail), ["c1", "c2"]);
    assert.equal(found[0].class, "review");
    assert.equal(found[0].objective.id, moved.successor);
    assert.match(found[0].summary, new RegExp(`judged under ${moved.objective}`));
    assert.deepEqual(found[0].commands,
        [`self milestone recheck ${moved.milestone} --criterion c1 --why "<what you re-judged>"`]);
});

test("18: the recheck the finding printed clears that criterion and leaves the other", async () =>
{
    const F = await carried();
    await F.run(["milestone", "recheck", F.milestone, "--criterion", "c1", "--why", "still answered"]);
    const found = kinds(await F.json(), "judgment-review");
    assert.deepEqual(found.map((item) => item.detail), ["c2"]);
});

test("19: an assumption on a replaced decision offers the link then the unlink, in that order", async () =>
{
    const found = kinds(await assumed.json(), "judgment-review")
        .filter((item) => item.record.id === assumed.first);
    assert.equal(found.length, 1);
    assert.equal(found[0].class, "review");
    assert.match(found[0].summary, new RegExp(`${assumed.first} assumes ${assumed.replaced}, which is superseded`));
    assert.deepEqual(found[0].commands, [
        `self milestone link ${assumed.first} --decision ${assumed.successor}`,
        `self milestone unlink ${assumed.first} --decision ${assumed.replaced}`
    ]);
});

test("20: a retracted decision with no successor offers the unlink alone", async () =>
{
    const found = kinds(await assumed.json(), "judgment-review")
        .filter((item) => item.record.id === assumed.second);
    assert.equal(found.length, 1);
    assert.match(found[0].summary, new RegExp(`assumes ${assumed.withdrawn}, which is retracted`));
    assert.deepEqual(found[0].commands, [`self milestone unlink ${assumed.second} --decision ${assumed.withdrawn}`]);
});

/* ── 5: finding 5 — evidence candidates ────────────────────────────── */

test("21: a done unit with evidence under an uncovered checkpoint is a candidate, with a literal cN", async () =>
{
    const found = kinds(await evidence.json(), "evidence-candidate");
    assert.equal(found.length, 1);
    assert.equal(found[0].class, "candidate");
    assert.equal(found[0].record.id, evidence.milestone);
    assert.equal(found[0].detail, evidence.done);
    assert.deepEqual(found[0].commands,
        [`self milestone met ${evidence.milestone} --criterion cN --why "<how it covers it>" --work ${evidence.done}`]);
});

test("22: a unit a claim already cites is not offered again", async () =>
{
    const F = await candidates();
    await F.run(["milestone", "met", F.milestone, "--criterion", "c1", "--why", "the effort covered it", "--work", F.done]);
    assert.deepEqual(kinds(await F.json(), "evidence-candidate"), []);
});

test("23: a checkpoint with nothing open offers no candidate, whatever the unit's own criteria say", async () =>
{
    const F = await candidates();
    await F.run(["milestone", "met", F.milestone, "--criterion", "c1", "--why", "somebody else covered it"]);
    assert.deepEqual(kinds(await F.json(), "evidence-candidate"), []);
});

test("24: a done unit carrying no report at all is nothing to cite", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", work, "--milestone", milestone]);
    // The done gate refuses a bare claim, so a unit done with no evidence at
    // all is history a store already holds rather than something a command
    // writes. This is that history, appended the way the pipeline would have.
    logFixture(F.ws, "demo", {
        id: ulid(),
        ts: "2026-01-01T00:00:00.000Z",
        type: "entity.done",
        origin: { actor: "agent", confirmed: true },
        project: "demo",
        payload: { entity: work }
    });
    assert.deepEqual(kinds(await F.json(), "evidence-candidate"), []);
});

/* ── 6: finding 6 — no disposition; finding 7 — all operational ────── */

test("25: a unit that states nothing is named in the unassigned group", async () =>
{
    const F = await box();
    const work = workIdIn(await F.person(["work", "add", "an effort nobody spoke for"]));
    const found = kinds(await F.json(), "no-disposition");
    assert.equal(found.length, 1);
    assert.equal(found[0].record.id, work);
    assert.equal(found[0].objective, undefined);
    assert.match(await F.check(), /^unassigned$/m);
});

test("26: declaring standalone clears it", async () =>
{
    const F = await box();
    const work = workIdIn(await F.person(["work", "add", "an effort nobody spoke for"]));
    await F.run(["work", "link", work, "--standalone", "--why", "it moves no stated outcome"]);
    assert.deepEqual(kinds(await F.json(), "no-disposition"), []);
});

// A registered runbook, one instance of it, and the work unit the instance
// names. Cells 27, 29 and 30 read it.
async function operational(units)
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the rotation happened"]));
    const runbook = (await F.run(["runbook", "add", "key rotation", "--stage", "rotate the key"]))
        .match(/\be-[0-9a-z]{5}\b/)[0];
    const made = [];
    for (const [index, linked] of units.entries())
    {
        const work = workIdIn(await F.person(["work", "add", `occurrence ${index + 1}`]));
        await F.run(["work", "link", work, "--milestone", milestone]);
        if (linked)
        {
            await F.run(["runbook", "start", runbook, "--instance", `E00${index + 1}`]);
            await F.run(["runbook", "link", `E00${index + 1}`, "--work", work]);
        }
        made.push(work);
    }
    return { ...F, objective, milestone, runbook, works: made };
}

test("27: an inbound run link is a disposition, so no missing-contribution finding is emitted", async () =>
{
    const F = await box();
    const runbook = (await F.run(["runbook", "add", "key rotation", "--stage", "rotate the key"]))
        .match(/\be-[0-9a-z]{5}\b/)[0];
    const work = workIdIn(await F.person(["work", "add", "this month's rotation"]));
    await F.run(["runbook", "start", runbook, "--instance", "E001"]);
    await F.run(["runbook", "link", "E001", "--work", work]);
    assert.deepEqual(kinds(await F.json(), "no-disposition"), []);
});

test("28: the classification is the edge, never the wording", async () =>
{
    const F = await box();
    const work = workIdIn(await F.person(["work", "add", "the monthly signing-key rotation runbook occurrence"]));
    assert.equal(kinds(await F.json(), "no-disposition").length, 1,
        "a unit whose text reads as maintenance was classified out of its prose");
    assert.equal(kinds(await F.json(), "no-disposition")[0].record.id, work);
});

test("29: an objective whose whole live checkpoint workload is runbook occurrences asks the question", async () =>
{
    const F = await operational([true, true]);
    const found = kinds(await F.json(), "operational-objective");
    assert.equal(found.length, 1);
    assert.equal(found[0].class, "review");
    assert.equal(found[0].record.id, F.objective);
    assert.match(found[0].summary, /was this maintenance meant as a product checkpoint\?/);
    assert.deepEqual(found[0].commands, [`self objective show ${F.objective}`]);
});

test("30: one unit outside the runs and the set is not all operational", async () =>
{
    const F = await operational([true, false]);
    assert.deepEqual(kinds(await F.json(), "operational-objective"), []);
});

test("31: an empty set never triggers it", async () =>
{
    const F = await operational([]);
    assert.deepEqual(kinds(await F.json(), "operational-objective"), []);
});

/* ── 7: foreign targets, availability and determinism ──────────────── */

// A second registered project owning the objective this project's unit
// contributes to. Cells 32, 33, 34 and 35 read it.
async function twoProjects()
{
    const machineBox = machine();
    const { ws, demo } = await demoWorkspace(machineBox);
    const other = join(ws, "other");
    mkdirSync(other, { recursive: true });
    git(machineBox, other, ["init", "-q", "-b", "main"]);
    await must(machineBox, other, ["project", "init", "--name", "other", "--desc", "the target project"]);
    const objective = objectiveIdIn((await must(machineBox, other, ["objective", "add", "the far outcome"])).out);
    const work = workIdIn((await mustPerson(machineBox, demo, ["work", "add", "a bounded effort"])).out);
    await must(machineBox, demo, ["work", "link", work, "--objective", objective, "--objective-project", "other"]);
    return {
        box: machineBox,
        ws,
        demo,
        other,
        objective,
        work,
        run: async (args) => (await must(machineBox, demo, args)).out,
        json: async () => JSON.parse((await must(machineBox, demo, ["objective", "check", "--json"])).out)
    };
}

test("32: a closed foreign target is named qualified by its owning slug", async () =>
{
    const F = await twoProjects();
    await approvedIn(F.box, F.other, ["objective", "close", F.objective, "--as", "dropped",
        "--why", "it stopped mattering"], F.objective);
    const report = await F.json();
    const found = kinds(report, "obsolete-contributions");
    assert.equal(found.length, 1);
    assert.equal(found[0].objective.project, "other");
    assert.match(found[0].summary, new RegExp(`${F.objective} \\(other\\)`));
    assert.deepEqual(report.unchecked, []);
});

test("33, 35: a target project this machine never registered is a notice, not a finding and not an all-clear", async () =>
{
    const F = await box();
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    // A log this machine pulled from another clone names a project it never
    // registered. That is the case §7 is about, and no command here can write
    // it: `work link --objective-project` resolves the slug first.
    logFixture(F.ws, "demo", {
        id: ulid(),
        ts: "2026-01-01T00:00:00.000Z",
        type: "entity.linked",
        origin: { actor: "agent", confirmed: true },
        project: "demo",
        payload: { entity: work, link: { type: "member-of", target: "o-faraw", project: "faraway" } }
    });
    const report = await F.json();
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.unchecked, [{
        record: work,
        target: { id: "o-faraw", project: "faraway" },
        why: "faraway is not a project this machine can read"
    }]);
    assert.equal(report.summary.unchecked, 1);
    const page = (await F.check()).trimEnd();
    assert.ok(!page.startsWith("no findings"), `an unreadable target read as an all-clear:\n${page}`);
    assert.match(page, /1 contribution target not checked/);
    assert.match(page, /target state not checked/);
});

test("34: an archived target project is not reached past either", async () =>
{
    const F = await twoProjects();
    await approvedIn(F.box, F.demo, ["project", "archive", "other", "--why", "nobody is on it"], "other");
    const report = await F.json();
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.unchecked, 1);
});

test("36: the same events in a different order, on a second machine, answer identically", async () =>
{
    const first = await stranded();
    const events = readFileSync(join(first.ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
    const second = await box();
    // Reversed: a union merge orders lines by neither time nor dependency, and
    // the check's answer may not depend on which order this clone happens to
    // hold. The creation of the project itself is already in the second store,
    // so only the records this fixture wrote are replayed.
    for (const event of [...events].reverse().filter((item) => item.type !== "project.registered"))
    {
        logFixture(second.ws, "demo", event);
    }
    const left = await first.json();
    const right = await second.json();
    assert.deepEqual(right.findings, left.findings);
    assert.deepEqual(right.summary, left.summary);
});

// The determinism input the part (b) review named for part (c): the standing
// judgment on a criterion is the newest claim, and "newest" may not mean
// "lowest in the file". Two claims on one criterion — the original and the
// recheck that settled it — are exactly the pair a merge can reorder, and
// reading them by physical position would make the review prompt come back on
// one clone and stay gone on the other.
test("36 (carried judgments): a recheck stays settled however the log is merged", async () =>
{
    const F = await carried();
    await F.run(["milestone", "recheck", F.milestone, "--criterion", "c1", "--why", "still answered"]);
    await F.run(["milestone", "recheck", F.milestone, "--criterion", "c2", "--why", "still answered"]);
    const events = readFileSync(join(F.ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
    const second = await box();
    for (const event of [...events].reverse().filter((item) => item.type !== "project.registered"))
    {
        logFixture(second.ws, "demo", event);
    }
    assert.deepEqual(kinds(await second.json(), "judgment-review"), []);
    assert.deepEqual((await second.json()).findings, (await F.json()).findings);
});

test("37: two findings on one record order by the design's own numbering", async () =>
{
    const report = await stray.json();
    const order = report.findings.map((finding) => finding.kind);
    assert.deepEqual(order, ["empty-successor", "obsolete-contributions", "obsolete-contributions"],
        "the successor finding on the checkpoint sorts before the two on the units, by record then by kind");
});

test("38: every named objective's findings come before the explicit unassigned group", async () =>
{
    const F = await stranded();
    await F.person(["work", "add", "an effort nobody spoke for"]);
    const page = (await F.check()).split("\n");
    const named = page.indexOf(F.objective);
    const unassigned = page.indexOf("unassigned");
    assert.ok(named > 0 && unassigned > named,
        `the unassigned group is not last:\n${page.join("\n")}`);
    const report = await F.json();
    assert.equal(report.findings.at(-1).kind, "no-disposition");
});

test("39: the same store folded at two very different clocks answers identically", () =>
{
    // The CLI has no clock flag, so the two folds are built here: this is the
    // proof that the check reads none of the overlay's clock-derived state —
    // a rule reading `MilestoneState.state` would answer `missed` at the late
    // clock and `on-track` at the early one, and the two reports would differ.
    const store = join(stray.ws, ".superself");
    const early = buildModel(store, "demo", new Date("2020-01-01T00:00:00.000Z"));
    const late = buildModel(store, "demo", new Date("2099-01-01T00:00:00.000Z"));
    assert.deepEqual(checkDirection(late, []), checkDirection(early, []));
});

/* ── 8: the projection stays read-only ─────────────────────────────── */

function storeSnapshot(ws)
{
    const root = join(ws, ".superself");
    const walk = (dir) => readdirSync(dir).sort().flatMap((entry) =>
    {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : [`${path}\n${readFileSync(path, "utf8")}`];
    });
    return walk(root).join("\n");
}

test("40: the store is byte-identical after a run, plain and --json alike", async () =>
{
    const F = await stranded();
    const before = storeSnapshot(F.ws);
    await F.check();
    await F.json();
    assert.equal(storeSnapshot(F.ws), before);
});

test("41: the projection's own source reaches no machine", () =>
{
    const source = readFileSync(fileURLToPath(new URL("../src/check.ts", import.meta.url)), "utf8");
    const forbidden = [
        [/from "node:/, "imports a node builtin"],
        [/\bprocess\s*\./, "reads `process`"],
        [/\bDate\.now\s*\(/, "reads the clock"],
        [/\bnew Date\s*\(/, "reads the clock"],
        [/\bMath\.random\s*\(/, "is not a function of its arguments"]
    ];
    const found = source.split("\n").flatMap((line, at) => line.trimStart().startsWith("//") ? []
        : forbidden.filter(([pattern]) => pattern.test(line)).map(([, why]) => `src/check.ts:${at + 1} ${why}`));
    assert.deepEqual(found, []);
});

test("42: --json is one object and nothing else, stating the same findings", async () =>
{
    const printed = (await must(stray.box, stray.demo, ["objective", "check", "--json"])).out;
    assert.equal(printed.trimEnd().split("\n").length, 1);
    const report = JSON.parse(printed);
    assert.equal(report.project, "demo");
    assert.equal(report.summary.findings, report.findings.length);
    const page = await stray.check();
    for (const finding of report.findings)
    {
        assert.ok(page.includes(finding.summary), `the page omits a finding --json states: ${finding.summary}`);
    }
});

test("R4: seven finding kinds and no more — a kind is added by a design decision", () =>
{
    assert.equal(FINDING_KINDS.length, 7);
    assert.deepEqual([...FINDING_KINDS], ["obsolete-contributions", "empty-successor", "date-order",
        "judgment-review", "evidence-candidate", "no-disposition", "operational-objective"]);
});

test("43: a project with nothing to say answers `no findings`", async () =>
{
    const F = await box();
    assert.equal((await F.check()).trim(), "no findings");
});

/* ── 9: the health summary ─────────────────────────────────────────── */

test("44: `self status` states the count and the command", async () =>
{
    const status = await stray.run(["status"]);
    assert.match(status, /^direction: 3 findings \(3 structural, 0 to review, 0 candidates\) — self objective check --project /m);
    assert.match(status, /^objectives: /m);
});

test("45: `self context` carries the same line in its head", async () =>
{
    const context = await stray.run(["context"]);
    assert.match(context.split("\n").slice(0, 4).join("\n"),
        /^Direction: 3 findings \(3 structural, 0 to review, 0 candidates\) — self objective check --project /m);
});

test("46: nothing found but a target unread never reads as ok", async () =>
{
    const F = await box();
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    logFixture(F.ws, "demo", {
        id: ulid(),
        ts: "2026-01-01T00:00:00.000Z",
        type: "entity.linked",
        origin: { actor: "agent", confirmed: true },
        project: "demo",
        payload: { entity: work, link: { type: "member-of", target: "o-faraw", project: "faraway" } }
    });
    const status = await F.run(["status"]);
    assert.match(status, /^direction: 0 findings \(0 structural, 0 to review, 0 candidates\), 1 contribution target not checked — /m);
});

test("47: nothing found and nothing unread reads as ok", async () =>
{
    const F = await box();
    assert.match(await F.run(["status"]), /^direction: ok — self objective check --project /m);
});

/* ── 10: one guidance contract, part (c) ───────────────────────────── */

const pluginRoot = new URL("../../dsh-plugin/", import.meta.url);

function entryRoutes()
{
    const cliPages = [
        ...COMMANDS.filter((command) => ["work", "milestone", "objective"].includes(command.name))
            .flatMap((command) => [...command.usage.flatMap((line) => [line.syntax, ...line.description ?? []]), ...command.detail]),
        ...["work", "goals"].flatMap((name) => findTopic(name).body)
    ].join("\n");
    const plugin = readFileSync(new URL("src/tools.ts", pluginRoot), "utf8")
        + readFileSync(new URL("README.md", pluginRoot), "utf8");
    return { cli: cliPages, block: commonProtocolLines().join("\n"), plugin };
}

// What every route has to say in part (c), stated as the fact a reader must
// come away with rather than as one exact sentence: three routes writing one
// sentence three times would be a copy check, not a parity check.
const SHIPPED = [
    [/self objective check/, "the command itself"],
    [/changes nothing|never relinks|repairs, covers/, "that it changes nothing"],
    [/candidate/, "that a candidate is information rather than coverage"],
    [/not checked/, "that an unreadable target is reported rather than passed over"],
    [/run link|runbook link/, "that maintenance is read off the run link and not out of prose"]
];

test("49, 50, 51: each entry route states the five facts part (c) ships", () =>
{
    for (const [route, text] of Object.entries(entryRoutes()))
    {
        for (const [pattern, what] of SHIPPED)
        {
            assert.match(text, pattern, `the ${route} guidance never states ${what}`);
        }
    }
    assert.equal(SHIPPED.length, 5);
});

test("48: `self objective --help` declares the check, its flags and why it has no workspace form", () =>
{
    const objective = COMMANDS.find((command) => command.name === "objective");
    assert.ok(objective.usage.some((line) => line.syntax === "objective check [--project <slug>] [--json]"),
        "the objective usage never spells the check");
    const detail = objective.detail.join("\n");
    assert.match(detail, /^ {2}--json {2,}on check/m);
    assert.match(detail, /has no --workspace form/);
});

function dispatches(path)
{
    const words = path.split(" ");
    return words[0] === "help"
        ? words.length === 1 || findTopic(words[1]) !== undefined
        : resolveCommand(COMMANDS, words) !== null;
}

function offeredCommands(text)
{
    const prose = text.replace(/```[\s\S]*?```/g, "");
    const quoted = [...prose.matchAll(/`([^`]*)`/g)].map((found) => found[1]);
    const commandLines = text.split("\n").filter((line) => /^\s*self\s/.test(line));
    return [...quoted, ...commandLines]
        .flatMap((source) => [...source.matchAll(/\bself ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)*)/g)])
        .map((found) => found[1]);
}

test("52: every command the three routes name is one this branch dispatches", () =>
{
    const routes = entryRoutes();
    for (const [route, text] of Object.entries(routes))
    {
        for (const path of new Set(offeredCommands(text)))
        {
            assert.ok(dispatches(path),
                `the ${route} guidance offers \`self ${path}\`, which this branch does not dispatch`);
        }
    }
    assert.ok(Object.values(routes).every((text) => offeredCommands(text).includes("objective check")),
        "a route names the check in prose without offering it as a command");
});
