// `self milestone show` reads progress across its linked work units (#406).
// Every test below is one cell of the case table in
// docs/maintainers/case-tables/406-milestone-progress.md, named by its cell
// number. There was no review round on this change, so the table is the review
// surface and a cell it lacks is a path nothing proves.
//
// The scope is decision 01m13k3x0r6k48zbv8t67t092e: CLI text only. Section A
// is the half that says so — the section is the console's alone, and the
// folded page a clone reads carries none of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);
const storeDir = join(ws, ".superself", "projects", "demo");

// The two pids `claim.test.mjs` reasons with, for the same reason: a number
// picked out of the air can belong to a live process on a busy runner.
const ALIVE = String(process.pid);
const GONE = String(spawnSync(process.execPath, ["-e", ""]).pid);

const asSession = (session, pid) => ({ SUPERSELF_SESSION: session, SUPERSELF_SESSION_PID: pid ?? "" });

let seq = 0;

function idOf(text, prefix)
{
    const match = text.match(new RegExp(`\\b${prefix}-[0-9a-z]{5}\\b`));
    if (match === null)
    {
        throw new Error(`no ${prefix}- id in: ${text}`);
    }
    return match[0];
}

const objective = idOf((await must(box, demo, ["objective", "add", "the milestone page answers where we are"])).out, "o");

async function freshMilestone(outcome)
{
    seq += 1;
    return idOf((await must(box, demo, ["milestone", "add", `${outcome} ${seq}`,
        "--objective", objective, "--exit", "one criterion"])).out, "m");
}

// A unit of the plain kind, linked to the checkpoint the cell is about.
async function linkedUnit(milestone, outcome)
{
    seq += 1;
    const id = workIdIn((await must(box, demo, ["work", "add", `${outcome} ${seq}`])).out);
    await must(box, demo, ["work", "link", id, "--milestone", milestone]);
    return id;
}

// A unit that declares criteria. `work add` writes `criteria: []`, so the
// declaring form is the entity grammar it is sugar over: an entity labelled
// `work` is a work unit, and `state cover` records the claims against it.
async function criteriaUnit(milestone, outcome, criteria)
{
    seq += 1;
    const args = ["state", "add", `${outcome} ${seq}`, "--label", "work"];
    criteria.forEach((text) => args.push("--criteria", text));
    const id = idOf((await must(box, demo, args)).out, "e");
    await must(box, demo, ["work", "link", id, "--milestone", milestone]);
    return id;
}

async function show(milestone, extra = {})
{
    return (await must(box, demo, ["milestone", "show", milestone], extra)).out;
}

// The one entry a cell is about, as the whole line it is: a substring match
// would let a clause land on the wrong unit and still pass.
function entry(printed, id)
{
    const line = printed.split("\n").find((text) => text.startsWith(`- **${id}**`));
    assert.ok(line !== undefined, `no entry for ${id} in:\n${printed}`);
    return line;
}

function reportLine(printed, id)
{
    const lines = printed.split("\n");
    const at = lines.findIndex((text) => text.startsWith(`- **${id}**`));
    assert.ok(at >= 0, `no entry for ${id} in:\n${printed}`);
    const next = lines[at + 1] ?? "";
    return next.startsWith("  - ") ? next : null;
}

/* ── A: the section itself ─────────────────────────────────────────── */

test("A1: a milestone with nothing linked grows no section, and still says none linked", async () =>
{
    const milestone = await freshMilestone("no work yet");
    const printed = await show(milestone);
    assert.ok(!printed.includes("## Linked work"), `an empty milestone rendered a section:\n${printed}`);
    assert.match(printed, /^- Work: none linked$/m);
});

// The order is `milestone.works`, which `deriveMilestone` reads off the fold's
// own unit order — so the unit recorded first leads even when it was linked
// second. The cell links them the other way round to hold that down.
test("A2: the section lists one entry per linked unit, after the criteria and before the coverage", async () =>
{
    const milestone = await freshMilestone("two units");
    seq += 1;
    const first = workIdIn((await must(box, demo, ["work", "add", `the earlier unit ${seq}`])).out);
    const second = await linkedUnit(milestone, "the later unit");
    await must(box, demo, ["work", "link", first, "--milestone", milestone]);
    await must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "it holds", "--work", first]);
    const printed = await show(milestone);
    assert.ok(printed.indexOf("## Exit criteria") < printed.indexOf("## Linked work"), "the section came before the criteria");
    assert.ok(printed.indexOf("## Linked work") < printed.indexOf("## Coverage"), "the section came after the coverage");
    assert.match(entry(printed, first), new RegExp(`^- \\*\\*${first}\\*\\* the earlier unit \\d+ — next$`));
    assert.match(entry(printed, second), / — next$/);
    assert.ok(printed.indexOf(`- **${first}**`) < printed.indexOf(`- **${second}**`), "the units are not in record order");
});

test("A3: the objective page embeds the milestone without the section, holder included", async () =>
{
    const milestone = await freshMilestone("read from the objective");
    const unit = await linkedUnit(milestone, "a held unit");
    await must(box, demo, ["work", "start", unit], asSession("a3-holder", ALIVE));
    assert.match(await show(milestone, asSession("a3-holder", ALIVE)), /held by this session/);
    const printed = (await must(box, demo, ["objective", "show", objective])).out;
    assert.ok(printed.includes(`## Milestone ${milestone}`), `the objective page lost the milestone:\n${printed}`);
    assert.ok(!printed.includes("## Linked work"), "the objective page grew the console-only section");
    assert.ok(!printed.includes("held by"), "the objective page grew a holder sentence");
});

test("A4: the folded objective file carries neither the section nor a holder", async () =>
{
    const folded = readFileSync(join(storeDir, "objective", `${objective}.md`), "utf8");
    assert.ok(folded.includes("# " + objective), "the folded page is not this objective's");
    assert.ok(!folded.includes("## Linked work"), "a synced page grew the console-only section");
    assert.ok(!folded.includes("held by"), "a synced page grew this machine's judgment of a session");
});

/* ── B: working state ──────────────────────────────────────────────── */

test("B1-B7: every working state reads in the vocabulary work show prints", async () =>
{
    const milestone = await freshMilestone("every state");
    const next = await linkedUnit(milestone, "an untouched unit");
    const active = await linkedUnit(milestone, "a started unit");
    const why = await linkedUnit(milestone, "a blocked unit with a reason");
    const bare = await linkedUnit(milestone, "a blocked unit without one");
    const done = await linkedUnit(milestone, "a finished unit");
    const retired = await linkedUnit(milestone, "a given-up unit");
    seq += 1;
    const review = workIdIn((await must(box, demo, ["work", "propose", `a plan nobody accepted ${seq}`])).out);
    await must(box, demo, ["work", "link", review, "--milestone", milestone]);

    await must(box, demo, ["work", "start", active]);
    await must(box, demo, ["work", "block", why, "--on", "decision", "--why", "nobody ruled"]);
    await must(box, demo, ["work", "block", bare, "--on", "external"]);
    await must(box, demo, ["work", "done", done, "--report", "the outcome was verified"]);
    await must(box, demo, ["work", "retire", retired, "--why", "the outcome moved"]);

    const printed = await show(milestone);
    assert.match(entry(printed, next), / — next$/, "B1");
    assert.match(entry(printed, active), / — active$/, "B2");
    assert.match(entry(printed, why), / — blocked on decision: nobody ruled$/, "B3");
    assert.match(entry(printed, bare), / — blocked on external$/, "B4");
    assert.match(entry(printed, done), / — done$/, "B5");
    assert.match(entry(printed, retired), / — retired$/, "B6");
    assert.match(entry(printed, review), / — review$/, "B7");
});

/* ── C: criteria declared × covered ────────────────────────────────── */

test("C1-C4: a unit states how much of what it declared is covered, and says nothing when it declared none", async () =>
{
    const milestone = await freshMilestone("declared criteria");
    const none = await linkedUnit(milestone, "a unit that declared nothing");
    const zero = await criteriaUnit(milestone, "declared, uncovered", ["suite green", "docs updated"]);
    const half = await criteriaUnit(milestone, "declared, half covered", ["suite green", "docs updated"]);
    const full = await criteriaUnit(milestone, "declared, fully covered", ["suite green", "docs updated"]);
    await must(box, demo, ["state", "cover", half, "--criterion", "suite green", "--why", "83 green"]);
    await must(box, demo, ["state", "cover", full, "--criterion", "suite green", "--why", "83 green"]);
    await must(box, demo, ["state", "cover", full, "--criterion", "docs updated", "--why", "the reference page states it"]);

    const printed = await show(milestone);
    assert.ok(!entry(printed, none).includes("criteria covered"), "C1: a unit that declared none counted anyway");
    assert.match(entry(printed, zero), /— next, 0 of 2 criteria covered$/, "C2");
    assert.match(entry(printed, half), /— next, 1 of 2 criteria covered$/, "C3");
    assert.match(entry(printed, full), /— next, 2 of 2 criteria covered$/, "C4");
});

/* ── D: the latest report ──────────────────────────────────────────── */

test("D1-D4: the newest report's first line hangs under the unit, and nothing else of it does", async () =>
{
    const milestone = await freshMilestone("reports");
    const silent = await linkedUnit(milestone, "a unit that reported nothing");
    const one = await linkedUnit(milestone, "a unit with one report");
    const two = await linkedUnit(milestone, "a unit with two reports");
    const many = await linkedUnit(milestone, "a unit with a long report");
    await must(box, demo, ["report", one, "the gate refuses a bare claim"]);
    await must(box, demo, ["report", two, "the older thing that happened"]);
    await must(box, demo, ["report", two, "the newer thing that happened"]);
    await must(box, demo, ["report", many, "the opening line\nthe second line\nthe third line"]);

    const printed = await show(milestone);
    assert.equal(reportLine(printed, silent), null, "D1");
    assert.match(reportLine(printed, one), /^ {2}- report \d{4}-\d{2}-\d{2}: the gate refuses a bare claim$/, "D2");
    assert.match(reportLine(printed, two), /: the newer thing that happened$/, "D3");
    assert.ok(!printed.includes("the older thing that happened"), "D3: the superseded report is still on the page");
    assert.match(reportLine(printed, many), /: the opening line$/, "D4");
    assert.ok(!printed.includes("the second line"), "D4: a report ran past its first line");
    assert.ok(!printed.includes("the third line"), "D4: a report ran past its first line");
});

/* ── E: who holds it ───────────────────────────────────────────────── */

test("E1-E3: the holder is disclosed in ledger.ts's sentence, and only when there is one", async () =>
{
    const milestone = await freshMilestone("holders");
    const free = await linkedUnit(milestone, "a unit nobody picked up");
    const mine = await linkedUnit(milestone, "a unit this session holds");
    const ended = await linkedUnit(milestone, "a unit a dead session held");
    await must(box, demo, ["work", "start", mine], asSession("e-reader", ALIVE));
    await must(box, demo, ["work", "start", ended], asSession("e-departed", GONE));

    const printed = await show(milestone, asSession("e-reader", ALIVE));
    assert.ok(!entry(printed, free).includes("held"), "E1: an unclaimed unit named a holder");
    assert.match(entry(printed, mine), /— active, held by this session$/, "E2");
    assert.match(entry(printed, ended), /— active, was held by another session, ended \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "E3");
});

/* ── F: the clauses together ───────────────────────────────────────── */

test("F1: standing, criteria and holder join in that order, with the report beneath", async () =>
{
    const milestone = await freshMilestone("all at once");
    const unit = await criteriaUnit(milestone, "the whole story", ["suite green", "docs updated"]);
    await must(box, demo, ["state", "cover", unit, "--criterion", "suite green", "--why", "83 green"]);
    await must(box, demo, ["report", unit, "the render landed\nand the rest of the prose"]);
    await must(box, demo, ["work", "start", unit], asSession("f1-holder", ALIVE));
    await must(box, demo, ["work", "block", unit, "--on", "decision", "--why", "nobody ruled"], asSession("f1-holder", ALIVE));

    const printed = await show(milestone, asSession("f1-holder", ALIVE));
    assert.equal(entry(printed, unit),
        `- **${unit}** the whole story ${seq} — blocked on decision: nobody ruled, 1 of 2 criteria covered, held by this session`);
    assert.match(reportLine(printed, unit), /^ {2}- report \d{4}-\d{2}-\d{2}: the render landed$/);
});

/* ── G1: what the help page says the verb does ─────────────────────── */

test("G1: the help page states that show reads the linked work", async () =>
{
    const printed = (await must(box, demo, ["help"])).out;
    assert.match(printed, /milestone show <id> \[--project <slug>\]/);
    assert.match(printed, /every linked work unit: its state, its criteria, its holder, its latest report/);
});
