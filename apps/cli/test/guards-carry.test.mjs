// Carry, mutation guards, proposal retarget, date ordering and the parent a
// coverage judgment was made under — #417, part (b).
//
// Every test below is one cell of
// docs/maintainers/case-tables/417-guards-carry.md, named by its cell number,
// and asserts that cell's stated outcome. The assertions read what the CLI
// prints and what its log holds; none of them calls the helper the
// implementation calls, so a helper that is wrong in the same way twice still
// fails here.
//
// Every shared fixture is built above the first `test()`. The driver runs the
// CLI in this process, so a top-level `await` between two registrations would
// let a test start while a fixture was still recording — one overlapping call
// and the whole file reports on a store nobody built.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../dist/main.js";
import { resolveCommand } from "../dist/contract.js";
import { commonProtocolLines } from "../dist/connect.js";
import { findTopic } from "../dist/guide.js";
import { approvedIn, demoWorkspace, git, idIn, logFixture, machine, must, mustPerson, receiptIn, selfIn, workIdIn } from "./harness.mjs";

const objectiveIdIn = (text) => text.match(/\bo-[0-9a-z]{5}\b/)[0];
const milestoneIdIn = (text) => text.match(/\bm-[0-9a-z]{5}\b/)[0];

function eventsOf(ws, slug = "demo")
{
    const file = join(ws, ".superself", "projects", slug, "log.jsonl");
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

function linkEventsOf(ws, entity, type = "entity.linked")
{
    return eventsOf(ws).filter((event) => event.type === type && event.payload.entity === entity)
        .map((event) => event.payload.link);
}

function contributesLine(page)
{
    const found = page.match(/^- Contributes to: (.*)$/m);
    return found === null ? "" : found[1];
}

// One scratch machine holding one registered project, with the four ways this
// file drives it: as a session, as a person, through the retirement
// disclosure, and as a call that is expected to refuse.
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
        attempt: (args) => selfIn(machineBox, demo, args)
    };
}

const BRIEF = ["--value", "it moves the outcome", "--success", "the thing is true",
    "--stop", "it turns out not to be needed", "--risk", "it takes longer than planned",
    "--capacity", "a day", "--evidence-plan", "a commit", "--confidence", "high",
    "--expires", "2099-01-01"];

const proposalIdIn = (printed) => printed.split("\n").map((line) => line.trim())
    .filter((line) => /^w-[0-9a-z]{5}$/.test(line))[0];

/* ── the shared fixtures, all built before the first test ──────────── */

// One objective revised, with a unit linked to it and to an untouched second
// objective. Cells 1, 2, 3 and 13 read it.
async function revisedObjective()
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "the outcome"]));
    const other = objectiveIdIn(await F.run(["objective", "add", "an unrelated outcome"]));
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", work, "--objective", objective]);
    await F.run(["work", "link", work, "--objective", other]);
    const receipt = receiptIn((await F.approved(["objective", "revise", objective,
        "--why", "the wording settled", "--outcome", "the outcome, restated"], objective)).printed);
    return { ...F, objective, other, work, receipt, successor: objectiveIdIn(receipt) };
}

// A gap proposal whose checkpoint was superseded before anyone answered it.
// Cells 21, 22 and 23 walk the recovery it prints, in that order.
async function driftedProposal()
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const proposal = proposalIdIn(await F.run(["work", "propose", "close the gap",
        "--milestone", milestone, ...BRIEF]));
    const successor = milestoneIdIn(receiptIn((await F.approved(["milestone", "revise", milestone,
        "--why", "the criterion widened", "--exit", "the other thing is true"], milestone)).printed));
    return { ...F, objective, milestone, proposal, successor };
}

// A plan accepted once, contributing to an unrelated objective as well, then
// moved to another gap before it was ever started. Cells 25 and 26 read it.
async function retargetedAfterAcceptance()
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome"]));
    const other = objectiveIdIn(await F.run(["objective", "add", "another outcome"]));
    const unrelated = objectiveIdIn(await F.run(["objective", "add", "an outcome nobody touches"]));
    const proposal = proposalIdIn(await F.run(["work", "propose", "one bounded plan",
        "--objective", objective, ...BRIEF]));
    await F.run(["work", "confirm", proposal]);
    await F.run(["work", "link", proposal, "--objective", unrelated]);
    await F.run(["work", "revise", proposal, "one bounded plan", "--why", "the gap moved", "--objective", other]);
    return { ...F, objective, other, unrelated, proposal };
}

// A checkpoint with two criteria, both judged under the objective it was born
// under. Cells 38, 42 and 45 read it as it stands.
async function judged()
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the first thing is true", "--exit", "the second thing is true"]));
    await F.run(["milestone", "met", milestone, "--criterion", "c1", "--why", "the first half landed"]);
    await F.run(["milestone", "met", milestone, "--criterion", "c2", "--why", "the second half landed"]);
    return { ...F, objective, milestone };
}

// The same checkpoint, carried to a successor objective. Cells 39, 40 and 41
// walk it in that order: the page states the condition, the recheck the page
// printed clears one criterion, and the other one stays.
async function carriedJudgment()
{
    const F = await judged();
    const successor = objectiveIdIn(receiptIn((await F.approved(["objective", "revise", F.objective,
        "--why", "reworded", "--outcome", "restated"], F.objective)).printed));
    return { ...F, successor };
}

const revised = await revisedObjective();
const drifted = await driftedProposal();
const moved = await retargetedAfterAcceptance();
const settled = await judged();
const carried = await carriedJudgment();

/* ── 1: lineage-local membership across an explicit revision ───────── */

test("1: the revision carries the directly linked unit and counts it in the receipt", () =>
{
    const links = linkEventsOf(revised.ws, revised.work)
        .filter((link) => link.type === "member-of" && link.target === revised.successor);
    assert.equal(links.length, 1, "the unit was not carried to the successor");
    assert.match(revised.receipt, new RegExp(`carried 0 milestones and 1 work unit from ${revised.objective}$`));
});

test("2: the carried unit reads current under the successor and not under the predecessor", async () =>
{
    const line = contributesLine(await revised.run(["work", "show", revised.work]));
    assert.ok(line.includes(revised.successor), `the successor is missing from: ${line}`);
    assert.ok(!line.includes(revised.objective), `the predecessor is still current in: ${line}`);
});

test("3: an unrelated contribution is neither carried nor withdrawn", async () =>
{
    const line = contributesLine(await revised.run(["work", "show", revised.work]));
    assert.ok(line.includes(revised.other), `the unrelated objective left the unit: ${line}`);
    assert.equal(linkEventsOf(revised.ws, revised.work, "entity.unlinked").length, 0,
        "a carry withdrew an edge");
});

test("13: the roll-up counts the carried unit under the successor alone", async () =>
{
    assert.match(await revised.run(["objective", "show", revised.successor]), new RegExp(`\\b${revised.work}\\b`));
    assert.ok(!(await revised.run(["objective", "show", revised.objective])).includes(revised.work),
        "the predecessor still counts the carried unit");
});

test("4: a foreign contribution is untouched, and the other project's log is not written", async () =>
{
    const F = await box();
    const away = join(F.ws, "away");
    mkdirSync(away, { recursive: true });
    git(F.box, away, ["init", "-q", "-b", "main"]);
    await must(F.box, away, ["project", "init", "--name", "away", "--desc", "the other project"]);
    const foreign = objectiveIdIn((await must(F.box, away, ["objective", "add", "their outcome"])).out);
    const objective = objectiveIdIn(await F.run(["objective", "add", "our outcome"]));
    const work = workIdIn(await F.person(["work", "add", "a unit that serves both"]));
    await F.run(["work", "link", work, "--objective", objective]);
    await F.run(["work", "link", work, "--objective", foreign, "--objective-project", "away"]);
    const before = eventsOf(F.ws, "away").length;
    await F.approved(["objective", "revise", objective, "--why", "reworded", "--outcome", "our outcome, restated"], objective);
    assert.equal(eventsOf(F.ws, "away").length, before, "the revision wrote into the other project's log");
    assert.match(await F.run(["work", "show", work]), new RegExp(`\\b${foreign}\\b`));
});

test("5: a retired unit is not carried", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome with a retired unit"]));
    const work = workIdIn(await F.person(["work", "add", "a unit that was given up"]));
    await F.run(["work", "link", work, "--objective", objective]);
    await F.approved(["work", "retire", work, "--why", "the outcome moved elsewhere"], work);
    const receipt = receiptIn((await F.approved(["objective", "revise", objective,
        "--why", "reworded", "--outcome", "restated"], objective)).printed);
    assert.match(receipt, /carried 0 milestones from /);
    assert.equal(linkEventsOf(F.ws, work).filter((link) => link.target === objectiveIdIn(receipt)).length, 0);
});

test("6: a done unit carries as a membership and covers nothing", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome with finished work"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const work = workIdIn(await F.person(["work", "add", "a finished effort"]));
    await F.run(["work", "link", work, "--objective", objective]);
    await F.run(["work", "done", work, "--report", "landed, and the evidence is the commit"]);
    const successor = objectiveIdIn(receiptIn((await F.approved(["objective", "revise", objective,
        "--why", "reworded", "--outcome", "restated"], objective)).printed));
    assert.ok(contributesLine(await F.run(["work", "show", work])).includes(successor),
        "a done unit was not carried");
    assert.match(await F.run(["milestone", "show", milestone]), /c1 — the thing is true _\(open\)_/);
});

test("7: a unit linked only through a milestone gets no edge of its own", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome reached through a checkpoint"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const work = workIdIn(await F.person(["work", "add", "an effort under the checkpoint"]));
    await F.run(["work", "link", work, "--milestone", milestone]);
    const receipt = receiptIn((await F.approved(["objective", "revise", objective,
        "--why", "reworded", "--outcome", "restated"], objective)).printed);
    assert.match(receipt, /carried 1 milestone from /);
    assert.equal(linkEventsOf(F.ws, work).length, 1, "the unit was carried as well as its checkpoint");
    assert.ok(contributesLine(await F.run(["work", "show", work])).includes(milestone));
});

test("8: undo of one carried work link returns that unit alone", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome with two units"]));
    const first = workIdIn(await F.person(["work", "add", "the first effort"]));
    const second = workIdIn(await F.person(["work", "add", "the second effort"]));
    await F.run(["work", "link", first, "--objective", objective]);
    await F.run(["work", "link", second, "--objective", objective]);
    const successor = objectiveIdIn(receiptIn((await F.approved(["objective", "revise", objective,
        "--why", "reworded", "--outcome", "restated"], objective)).printed));
    const carry = eventsOf(F.ws).find((event) => event.type === "entity.linked"
        && event.payload.entity === first && event.payload.link.target === successor);
    await F.approved(["undo", carry.id], carry.id);
    assert.ok(contributesLine(await F.run(["work", "show", first])).includes(objective),
        "the undone unit did not return to the predecessor");
    assert.ok(contributesLine(await F.run(["work", "show", second])).includes(successor),
        "the other unit moved with it");
});

test("9: a milestone revision carries its linked work", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const work = workIdIn(await F.person(["work", "add", "an effort under the checkpoint"]));
    await F.run(["work", "link", work, "--milestone", milestone]);
    const receipt = receiptIn((await F.approved(["milestone", "revise", milestone,
        "--why", "the criterion widened", "--exit", "the other thing is true"], milestone)).printed);
    const successor = milestoneIdIn(receipt);
    assert.match(receipt, new RegExp(`carried 1 work unit from ${milestone}$`));
    const line = contributesLine(await F.run(["work", "show", work]));
    assert.ok(line.includes(successor), `the successor is missing from: ${line}`);
    assert.ok(!line.includes(milestone), `the predecessor is still current in: ${line}`);
});

async function assumingCheckpoint()
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome"]));
    const first = idIn(await F.run(["decide", "the store is append-only"]));
    const second = idIn(await F.run(["decide", "the fold reads one log"]));
    const third = idIn(await F.run(["decide", "a claim names its criterion by text"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    return { ...F, objective, milestone, first, second, third };
}

test("10: a revision carries every assumption the predecessor stated, in order", async () =>
{
    const F = await assumingCheckpoint();
    await F.run(["milestone", "link", F.milestone, "--decision", F.first]);
    await F.run(["milestone", "link", F.milestone, "--decision", F.second]);
    const successor = milestoneIdIn(receiptIn((await F.approved(["milestone", "revise", F.milestone,
        "--why", "the criterion widened", "--exit", "another thing is true"], F.milestone)).printed));
    assert.match(await F.run(["milestone", "show", successor]),
        new RegExp(`^- Assumes: ${F.first}, ${F.second}$`, "m"));
});

test("11: --decision on a revision adds to the carried set", async () =>
{
    const F = await assumingCheckpoint();
    await F.run(["milestone", "link", F.milestone, "--decision", F.first]);
    const successor = milestoneIdIn(receiptIn((await F.approved(["milestone", "revise", F.milestone,
        "--why", "the ground moved", "--decision", F.third], F.milestone)).printed));
    assert.match(await F.run(["milestone", "show", successor]),
        new RegExp(`^- Assumes: ${F.first}, ${F.third}$`, "m"));
});

test("12: a decision the checkpoint already assumes is carried once", async () =>
{
    const F = await assumingCheckpoint();
    await F.run(["milestone", "link", F.milestone, "--decision", F.first]);
    const successor = milestoneIdIn(receiptIn((await F.approved(["milestone", "revise", F.milestone,
        "--why", "restated", "--decision", F.first], F.milestone)).printed));
    assert.match(await F.run(["milestone", "show", successor]), new RegExp(`^- Assumes: ${F.first}$`, "m"));
});

/* ── 2: the target-open guard ──────────────────────────────────────── */

test("14: linking to a reached objective is refused and records nothing", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome already reached"]));
    await F.approved(["objective", "close", objective, "--as", "reached"], objective);
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    const before = eventsOf(F.ws).length;
    const result = await F.attempt(["work", "link", work, "--objective", objective]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${objective} is reached`));
    assert.match(result.out, /a contribution names an outcome that is still open/);
    assert.equal(eventsOf(F.ws).length, before, "the refusal wrote an event");
});

test("15: linking to a dropped milestone is refused and records nothing", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "a live outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "a checkpoint given up",
        "--objective", objective, "--exit", "the thing is true"]));
    await F.approved(["milestone", "drop", milestone, "--why", "nobody is going to reach it"], milestone);
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    const before = eventsOf(F.ws).length;
    const result = await F.attempt(["work", "link", work, "--milestone", milestone]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${milestone} is closed`));
    assert.equal(eventsOf(F.ws).length, before);
});

test("16: a live checkpoint under a dropped objective is closed too", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome about to be given up"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "a checkpoint nobody dropped",
        "--objective", objective, "--exit", "the thing is true"]));
    await F.approved(["objective", "close", objective, "--as", "dropped", "--why", "the plan changed"], objective);
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    const result = await F.attempt(["work", "link", work, "--milestone", milestone]);
    assert.notEqual(result.code, 0, "a checkpoint under a closed objective accepted a contribution");
    assert.match(result.out, new RegExp(`${milestone} is closed`));
});

test("17: a twice-superseded objective names its terminal successor, and that command runs", async () =>
{
    const F = await box();
    const first = objectiveIdIn(await F.run(["objective", "add", "the first wording"]));
    const second = objectiveIdIn(receiptIn((await F.approved(["objective", "revise", first,
        "--why", "reworded once", "--outcome", "the second wording"], first)).printed));
    const third = objectiveIdIn(receiptIn((await F.approved(["objective", "revise", second,
        "--why", "reworded twice", "--outcome", "the third wording"], second)).printed));
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    const result = await F.attempt(["work", "link", work, "--objective", first]);
    assert.notEqual(result.code, 0);
    const offered = result.out.match(/^\s+(self work link .+)$/m)[1];
    assert.ok(offered.includes(third), `the refusal offered ${offered}, not the terminal ${third}`);
    assert.ok(!offered.includes(second), "the refusal offered a superseded record as the repair");
    await must(F.box, F.demo, offered.split(" ").slice(1));
    assert.ok(contributesLine(await F.run(["work", "show", work])).includes(third));
});

test("18: a lineage that ends closed offers the standalone declaration, and it runs", async () =>
{
    const F = await box();
    const first = objectiveIdIn(await F.run(["objective", "add", "the first wording"]));
    const second = objectiveIdIn(receiptIn((await F.approved(["objective", "revise", first,
        "--why", "reworded", "--outcome", "the second wording"], first)).printed));
    await F.approved(["objective", "close", second, "--as", "reached"], second);
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    const result = await F.attempt(["work", "link", work, "--objective", first]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /nothing open succeeds it/);
    assert.ok(!result.out.includes(`--objective ${second}`), "a closed successor was offered as the repair");
    await must(F.box, F.demo, ["work", "link", work, "--standalone", "--why", "no current outcome needs it"]);
    assert.match(await F.run(["work", "show", work]), /^- Standalone: no current outcome needs it/m);
});

test("19: unlinking from a closed outcome is allowed", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome soon reached"]));
    const work = workIdIn(await F.person(["work", "add", "a bounded effort"]));
    await F.run(["work", "link", work, "--objective", objective]);
    await F.approved(["objective", "close", objective, "--as", "reached"], objective);
    await must(F.box, F.demo, ["work", "unlink", work, "--objective", objective]);
    assert.equal(contributesLine(await F.run(["work", "show", work])), "");
});

test("20: proposing into a dropped gap is refused before the proposal is minted", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "a live outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "a checkpoint given up",
        "--objective", objective, "--exit", "the thing is true"]));
    await F.approved(["milestone", "drop", milestone, "--why", "nobody is going to reach it"], milestone);
    const before = eventsOf(F.ws).filter((event) => event.type === "entity.proposed").length;
    const result = await F.attempt(["work", "propose", "close the gap", "--milestone", milestone, ...BRIEF]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /a contribution names an outcome that is still open/);
    assert.equal(eventsOf(F.ws).filter((event) => event.type === "entity.proposed").length, before);
});

/* ── 3: confirming against a target that moved ─────────────────────── */

test("21: confirming a proposal whose gap closed is refused, with both routes named", async () =>
{
    const result = await drifted.attempt(["work", "confirm", drifted.proposal]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${drifted.proposal} contributes to ${drifted.milestone}`));
    assert.match(result.out, new RegExp(`self work revise ${drifted.proposal} .*--milestone ${drifted.successor}`));
    assert.match(result.out, new RegExp(`self work confirm ${drifted.proposal}`));
    assert.match(result.out, new RegExp(`self work decline ${drifted.proposal} --why`));
});

test("22: the retarget the refusal printed is recorded and moves the plan", async () =>
{
    await must(drifted.box, drifted.demo, ["work", "revise", drifted.proposal, "close the gap",
        "--why", `${drifted.milestone} closed before this was accepted`, "--milestone", drifted.successor]);
    const revision = eventsOf(drifted.ws).find((event) => event.type === "entity.revised"
        && event.payload.entity === drifted.proposal);
    assert.equal(revision.payload.milestone, drifted.successor);
});

test("23: the plan confirms after the retarget, toward the new gap alone", async () =>
{
    await must(drifted.box, drifted.demo, ["work", "confirm", drifted.proposal]);
    const line = contributesLine(await drifted.run(["work", "show", drifted.proposal]));
    assert.ok(line.includes(drifted.successor), `the new gap is missing from: ${line}`);
    assert.ok(!line.includes(drifted.milestone), `the closed gap is still current in: ${line}`);
});

test("24: a retarget with the plan text unchanged is still a revision", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome"]));
    const other = objectiveIdIn(await F.run(["objective", "add", "another outcome"]));
    const proposal = proposalIdIn(await F.run(["work", "propose", "one bounded plan",
        "--objective", objective, ...BRIEF]));
    const printed = await F.run(["work", "revise", proposal, "one bounded plan",
        "--why", "the gap moved", "--objective", other]);
    assert.match(printed, /v2/);
    assert.match(printed, new RegExp(`now toward ${other}`));
});

test("25: a retarget invalidates the acceptance and withdraws the edge it wrote", async () =>
{
    const start = await moved.attempt(["work", "start", moved.proposal]);
    assert.notEqual(start.code, 0, "a retargeted plan started without a fresh acceptance");
    assert.deepEqual(linkEventsOf(moved.ws, moved.proposal, "entity.unlinked"),
        [{ type: "member-of", target: moved.objective }]);
});

test("26: the unrelated contribution survives the retarget", async () =>
{
    assert.ok(contributesLine(await moved.run(["work", "show", moved.proposal])).includes(moved.unrelated));
});

test("27: retargeting onto a closed gap is refused by the same guard", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome"]));
    const shut = objectiveIdIn(await F.run(["objective", "add", "an outcome about to close"]));
    await F.approved(["objective", "close", shut, "--as", "reached"], shut);
    const proposal = proposalIdIn(await F.run(["work", "propose", "one bounded plan",
        "--objective", objective, ...BRIEF]));
    const result = await F.attempt(["work", "revise", proposal, "a restated plan",
        "--why", "the gap moved", "--objective", shut]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /a contribution names an outcome that is still open/);
});

test("28: a standalone plan has no gap to move", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome"]));
    const proposal = proposalIdIn(await F.run(["work", "propose", "a plan that closes no gap",
        "--standalone", "--why", "nothing stated needs it"]));
    const result = await F.attempt(["work", "revise", proposal, "a restated plan",
        "--why", "moving it", "--objective", objective]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /names no gap/);
    assert.match(result.out, new RegExp(`self work link ${proposal} --objective`));
});

test("29: a revision that changes neither text nor gap is still refused", async () =>
{
    const F = await box();
    const proposal = proposalIdIn(await F.run(["work", "propose", "a plan that closes no gap",
        "--standalone", "--why", "nothing stated needs it"]));
    const result = await F.attempt(["work", "revise", proposal, "a plan that closes no gap", "--why", "again"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /changes nothing/);
});

test("30: declining is the second route the drift refusal offers", async () =>
{
    const F = await driftedProposal();
    await must(F.box, F.demo, ["work", "decline", F.proposal, "--why", "the checkpoint it served is gone"]);
    assert.match((await F.attempt(["work", "confirm", F.proposal])).out, /already declined/);
});

/* ── 4: the two dates ──────────────────────────────────────────────── */

async function dated(target)
{
    const F = await box();
    const args = ["objective", "add", "a time-boxed outcome"];
    return { ...F, objective: objectiveIdIn(await F.run(target === undefined ? args : [...args, "--target", target])) };
}

test("31: a checkpoint dated after its objective is refused", async () =>
{
    const F = await dated("2099-06-30");
    const before = eventsOf(F.ws).length;
    const result = await F.attempt(["milestone", "add", "a late checkpoint", "--objective", F.objective,
        "--exit", "the thing is true", "--target", "2099-07-01"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /2099-07-01 falls after/);
    assert.match(result.out, /2099-06-30/);
    assert.equal(eventsOf(F.ws).length, before);
});

test("32: a checkpoint dated on its objective's own date passes", async () =>
{
    const F = await dated("2099-06-30");
    await must(F.box, F.demo, ["milestone", "add", "a checkpoint on the last day", "--objective", F.objective,
        "--exit", "the thing is true", "--target", "2099-06-30"]);
});

test("33: an objective with no date makes no ordering claim", async () =>
{
    const F = await dated(undefined);
    await must(F.box, F.demo, ["milestone", "add", "a dated checkpoint", "--objective", F.objective,
        "--exit", "the thing is true", "--target", "2099-07-01"]);
});

test("34: a revision that states a later date is refused", async () =>
{
    const F = await dated("2099-06-30");
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "a checkpoint", "--objective", F.objective,
        "--exit", "the thing is true", "--target", "2099-06-01"]));
    const result = await F.attempt(["milestone", "revise", milestone, "--why", "it slipped", "--target", "2099-07-15"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /2099-07-15 falls after/);
});

test("35: a revision is judged on the date it inherits", async () =>
{
    const F = await dated("2099-06-30");
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "a checkpoint", "--objective", F.objective,
        "--exit", "the thing is true", "--target", "2099-06-29"]));
    const successor = objectiveIdIn(receiptIn((await F.approved(["objective", "revise", F.objective,
        "--why", "the outcome is wanted sooner", "--target", "2099-06-01"], F.objective)).printed));
    const result = await F.attempt(["milestone", "revise", milestone, "--why", "the criterion widened",
        "--exit", "another thing is true"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`2099-06-29 falls after ${successor}`));
});

test("36: moving an objective's date earlier warns and names the checkpoints beyond it", async () =>
{
    const F = await dated("2099-06-30");
    const late = milestoneIdIn(await F.run(["milestone", "add", "a checkpoint late in the plan",
        "--objective", F.objective, "--exit", "the thing is true", "--target", "2099-06-29"]));
    const printed = (await F.approved(["objective", "revise", F.objective,
        "--why", "the outcome is wanted sooner", "--target", "2099-06-01"], F.objective)).printed;
    assert.match(printed, new RegExp(`warning: .*${late} \\(2099-06-29\\)`));
});

test("37: a dropped checkpoint beyond the new date raises no warning", async () =>
{
    const F = await dated("2099-06-30");
    const late = milestoneIdIn(await F.run(["milestone", "add", "a checkpoint given up",
        "--objective", F.objective, "--exit", "the thing is true", "--target", "2099-06-29"]));
    await F.approved(["milestone", "drop", late, "--why", "nobody is going to reach it"], late);
    const printed = (await F.approved(["objective", "revise", F.objective,
        "--why", "the outcome is wanted sooner", "--target", "2099-06-01"], F.objective)).printed;
    assert.ok(!printed.includes("warning:"), printed);
});

/* ── 5: the parent a judgment was made under ───────────────────────── */

test("38: a coverage claim records the objective it was judged under", () =>
{
    const claim = eventsOf(settled.ws).find((event) => event.type === "entity.covered"
        && event.payload.entity === settled.milestone);
    assert.equal(claim.payload.objective, settled.objective);
});

test("42: a checkpoint that was never carried states no judgment condition", async () =>
{
    assert.ok(!(await settled.run(["milestone", "show", settled.milestone])).includes("Judgment to review"));
});

test("45: a criterion covered at the current record with no condition still refuses a recheck", async () =>
{
    const result = await settled.attempt(["milestone", "recheck", settled.milestone,
        "--criterion", "c1", "--why", "looking again"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /nothing to recheck/);
});

test("39: a carried checkpoint names the criteria judged under the former parent", async () =>
{
    const page = await carried.run(["milestone", "show", carried.milestone]);
    assert.match(page, /^## Judgment to review$/m);
    assert.match(page, new RegExp(`^- c1 — judged under ${carried.objective}, `
        + `and ${carried.milestone} now hangs under ${carried.successor}`, "m"));
    assert.match(page, new RegExp(`self milestone recheck ${carried.milestone} --criterion c1 --why`));
});

test("40: the recheck the page printed clears that one criterion", async () =>
{
    await must(carried.box, carried.demo, ["milestone", "recheck", carried.milestone,
        "--criterion", "c1", "--why", "the evidence still answers the new wording"]);
    const page = await carried.run(["milestone", "show", carried.milestone]);
    assert.ok(!/^- c1 — judged under/m.test(page), page);
    assert.match(page, /c1 — the first thing is true _\(covered\)_/);
});

test("41: a criterion nobody rechecked is still listed", async () =>
{
    assert.match(await carried.run(["milestone", "show", carried.milestone]),
        new RegExp(`^- c2 — judged under ${carried.objective}, `, "m"));
});

test("43: a carried checkpoint whose claim predates provenance says the context is unknown", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    // A claim written before this branch carried no parent. It is appended as
    // an older CLI wrote one, which is the only way such a line reaches a
    // store now.
    logFixture(F.ws, "demo", {
        id: "01legacycoverage00000claim",
        ts: "2026-01-01T00:00:00.000Z",
        type: "entity.covered",
        project: "demo",
        origin: { actor: "agent", confirmed: false },
        payload: { entity: milestone, criterion: "the thing is true", why: "it landed" }
    });
    const successor = objectiveIdIn(receiptIn((await F.approved(["objective", "revise", objective,
        "--why", "reworded", "--outcome", "restated"], objective)).printed));
    const page = await F.run(["milestone", "show", milestone]);
    assert.match(page, new RegExp(`^- c1 — judged under a parent this record does not establish, `
        + `and ${milestone} now hangs under ${successor}`, "m"));
    assert.ok(!page.includes("stale"), page);
});

test("44: legacy stale coverage still renders", async () =>
{
    const F = await box();
    // A pre-cutover objective and checkpoint, and a claim judged at revision
    // 1/1 that a legacy `objective.revised` then leaves behind. Native records
    // cannot reach this state — a native revision is a supersession — so the
    // condition this branch adds sits beside it rather than replacing it.
    const common = { project: "demo", origin: { actor: "agent", confirmed: false } };
    logFixture(F.ws, "demo", {
        ...common, id: "01legacyobjective00000crea", ts: "2026-01-01T00:00:00.000Z",
        type: "objective.created", payload: { objective: "obj-legacy", outcome: "a legacy outcome" }
    });
    logFixture(F.ws, "demo", {
        ...common, id: "01legacymilestone00000crea", ts: "2026-01-01T00:01:00.000Z",
        type: "milestone.created",
        payload: {
            milestone: "ms-legacy", objective: "obj-legacy", outcome: "a legacy checkpoint",
            exit: [{ id: "c1", text: "the thing is true" }]
        }
    });
    logFixture(F.ws, "demo", {
        ...common, id: "01legacycovered000000claim", ts: "2026-01-01T00:02:00.000Z",
        type: "milestone.covered",
        payload: {
            milestone: "ms-legacy", criterion: "c1", why: "it landed",
            objectiveRevision: 1, milestoneRevision: 1
        }
    });
    logFixture(F.ws, "demo", {
        ...common, id: "01legacyobjective00000revi", ts: "2026-01-01T00:03:00.000Z",
        type: "objective.revised", payload: { objective: "obj-legacy", why: "the wording moved" }
    });
    const health = await F.run(["context"]);
    assert.match(health, /ms-legacy coverage of c1 was judged against obj-legacy revision 1\/1, now 2\/1/);
    assert.match(health, /self milestone recheck ms-legacy --criterion c1/);
});

test("46: coverage recorded after the carry names the parent it was made under", async () =>
{
    const F = await box();
    const objective = objectiveIdIn(await F.run(["objective", "add", "an outcome"]));
    const milestone = milestoneIdIn(await F.run(["milestone", "add", "the checkpoint",
        "--objective", objective, "--exit", "the thing is true"]));
    const successor = objectiveIdIn(receiptIn((await F.approved(["objective", "revise", objective,
        "--why", "reworded", "--outcome", "restated"], objective)).printed));
    await F.run(["milestone", "met", milestone, "--criterion", "c1", "--why", "it landed"]);
    const claim = eventsOf(F.ws).find((event) => event.type === "entity.covered");
    assert.equal(claim.payload.objective, successor);
    assert.ok(!(await F.run(["milestone", "show", milestone])).includes("Judgment to review"));
});

test("47: undoing the recheck brings the condition back", async () =>
{
    const F = await carriedJudgment();
    await F.run(["milestone", "recheck", F.milestone, "--criterion", "c1", "--why", "still answered"]);
    const recheck = eventsOf(F.ws).find((event) => event.type === "entity.covered"
        && event.payload.objective === F.successor);
    await F.approved(["undo", recheck.id], recheck.id);
    assert.match(await F.run(["milestone", "show", F.milestone]),
        new RegExp(`^- c1 — judged under ${F.objective}, `, "m"));
});

/* ── 6: one guidance contract, part (b) ────────────────────────────── */

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

// What every route has to say in part (b), stated as the fact a reader must
// come away with rather than as one exact sentence: three routes writing one
// sentence three times would be a copy check, not a parity check.
const SHIPPED = [
    [/still open/, "that a contribution names a target that is still open"],
    [/work revise [^\n]*--(objective|milestone)/, "the pre-start retarget"],
    [/carr(y|ies|ied)/, "what a revision carries"],
    [/milestone recheck [^\n]*--criterion/, "the recheck of a judgment made elsewhere"],
    [/never (follow|after) it|refuse a later one/, "the date ordering rule"]
];

test("50, 51, 52: each entry route states the five facts part (b) ships", () =>
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

test("48: `self work --help` declares the retarget flags it offers", () =>
{
    const work = COMMANDS.find((command) => command.name === "work");
    assert.ok(work.usage.some((line) => /work revise .*--objective <id>\|--milestone <id>/.test(line.syntax)),
        "the work usage never spells the retarget");
    assert.ok(work.detail.some((line) => /^ {2}--objective <id>/.test(line))
        && work.detail.some((line) => /^ {2}--milestone <id>/.test(line)),
        "the retarget flags are offered without being glossed");
});

test("49: the objective and milestone pages state the carry and the date rule", () =>
{
    const objective = COMMANDS.find((command) => command.name === "objective").detail.join("\n");
    const milestone = COMMANDS.find((command) => command.name === "milestone").detail.join("\n");
    assert.match(objective, /lineage-local/);
    assert.match(objective, /never follow it/);
    assert.match(milestone, /never follow it/);
    assert.match(milestone, /predecessor assumed/);
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

test("53: every command the three routes name is one this branch dispatches", () =>
{
    for (const [route, text] of Object.entries(entryRoutes()))
    {
        for (const path of new Set(offeredCommands(text)))
        {
            assert.ok(dispatches(path),
                `the ${route} guidance offers \`self ${path}\`, which this branch does not dispatch`);
        }
    }
});

test("54: no entry route advertises the check part (c) has not shipped", () =>
{
    for (const [route, text] of Object.entries(entryRoutes()))
    {
        assert.ok(!/objective check/.test(text), `the ${route} guidance advertises \`self objective check\``);
    }
});
