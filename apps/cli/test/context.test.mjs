// The placement projection (#202, #197 §6): `self context` renders entities
// by priority and exposure — full text, one line, absent-with-pointer — with
// the derived live state anchored between the full block and the index lines,
// under the render budget, which is 3,000 context tokens (#213).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../dist/ids.js";
import { demoWorkspace, git, logFixture, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = await demoWorkspace(box);

function shortIdIn(text, prefix)
{
    const match = text.match(new RegExp(`\\b${prefix}-[0-9a-z]{5}\\b`));
    if (match === null)
    {
        throw new Error(`no ${prefix}- id in: ${text}`);
    }
    return match[0];
}

function setCaps(activeBox, caps)
{
    const file = join(activeBox.root, "ws", ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    // One token per character, so every cap number below is the character
    // count of the text it gates (#213).
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

let decision;
let objective;

// A fresh machine for the empty store and the budget, where the content sizes
// stay under the test's control.
const freshBox = machine();

const freshDemo = (await demoWorkspace(freshBox)).demo;

// A machine whose records stand past a cap, as a store whose caps were later
// tightened does: rendering never refuses, the entity verbs are what the cap
// gates, and repeatable --demote is how a deep overrun names enough. The
// over-cap state is built by lowering the cap after the records landed —
// preset adds gate on the caps too (#240), so writing past one is no longer a
// way to get here.
const legacyBox = machine();

const legacyDemo = (await demoWorkspace(legacyBox)).demo;

const legacySelf = (args) => selfIn(legacyBox, legacyDemo, args);

/* ── group D of the #124 case table, implemented by #380 ───────────── */

// Friction is optional at capture, so the only place a project can be told it
// has stopped recording what differed is `## Health`. These six cells fix when
// that line appears, when it stays away, and whose reports it counts.
//
// The reports are written as log fixtures rather than through `self report`:
// what each cell varies is the ratio of silent reports to speaking ones, and
// driving four verbs per cell would spend a minute proving the flag again
// instead of the derivation it is here to prove.

const nudgeBox = machine();

const nudgeWs = join(nudgeBox.root, "ws");

// One `report.added` as the pipeline would have written it: `null` for a
// report that recorded no friction, a sentence for one that did.
function reportFixture(activeWs, project, work, index, said)
{
    logFixture(activeWs, project, {
        id: ulid(),
        ts: new Date().toISOString(),
        type: "report.added",
        origin: { actor: "agent" },
        project,
        payload: { text: `report ${index}`, ...(said === null ? {} : { friction: [said] }) },
        refs: { work }
    });
}

async function registerProject(activeBox, activeWs, name)
{
    const dir = join(activeWs, name);
    mkdirSync(dir, { recursive: true });
    git(activeBox, dir, ["init", "-q", "-b", "main"]);
    await must(activeBox, dir, ["project", "init", "--name", name, "--desc", "friction nudge cell"]);
    return dir;
}

async function nudgeProject(name, pattern)
{
    const dir = await registerProject(nudgeBox, nudgeWs, name);
    if (pattern.length > 0)
    {
        const work = workIdIn((await mustPerson(nudgeBox, dir, ["work", "add", `${name} outcome`])).out);
        pattern.forEach((said, index) => reportFixture(nudgeWs, name, work, index, said));
    }
    return dir;
}

const NUDGE = /no friction on \d+ of this project's \d+ reports? in the last 30 days/;

mkdirSync(nudgeWs, { recursive: true });

await must(nudgeBox, nudgeWs, ["init", "--git"]);

// D5 has a machine of its own: the tightened budget below is written into the
// workspace config, and every cell above renders under the shipped one.
const cutBox = machine();

const cutWs = join(cutBox.root, "ws");

test("context renders by placement: full block, anchored live state, index lines, search pointer", async () =>
{
    await must(box, demo, ["goal", "add", "own the niche"]);
    objective = shortIdIn((await must(box, demo, ["objective", "add", "reach preview", "--target", "2030-01-01"])).out, "o");
    await must(box, demo, ["convention", "add", "events only, no hand edits"]);
    decision = (await must(box, demo, ["decide", "keep sqlite", "--why", "simple"])).out.match(/\[([^\]]+)\]/)[1];
    await must(box, demo, ["milestone", "add", "suite green", "--objective", objective, "--exit", "tests pass"]);
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "ship phase 2"])).out);
    await must(box, demo, ["work", "start", work]);
    await must(box, demo, ["state", "add", "raw searchable note", "--exposure", "search"]);

    const out = (await must(box, demo, ["context"])).out;
    const at = (needle) =>
    {
        const index = out.indexOf(needle);
        assert.notEqual(index, -1, `context is missing "${needle}":\n${out}`);
        return index;
    };
    // The full block in priority order: goal 0, objective 10, convention 30.
    assert.ok(at("- [goal] own the niche") < at("- [objective] reach preview (target 2030-01-01)"));
    assert.ok(at("- [objective] reach preview") < at("- [convention] events only, no hand edits"));
    // Live state anchors after the full block, before the index lines.
    assert.ok(at("- [convention] events only, no hand edits") < at("## Work in progress"));
    assert.ok(at(`- ${work} ship phase 2`) < at("## Index"));
    assert.ok(at("## Deadlines") < at("- 2030-01-01: [objective] reach preview"));
    // Index: one line each, priority order — milestone 20 before decision 40.
    assert.ok(at("- [milestone] suite green") < at("- [decision] keep sqlite — simple"));
    // Search exposure is absent with a pointer.
    assert.ok(!out.includes("raw searchable note"), "a search-exposure entity rendered in context");
    at("- 1 entity at search exposure; run `self state --project 'demo'`");
    // The replaced ladder's fixed sections are gone.
    assert.ok(!out.includes("Goal:"), "the hardcoded Goal: line survived the placement projection");
});

test("a placement event reorders the projection for a preset record", async () =>
{
    await must(box, demo, ["state", "place", decision, "--exposure", "full", "--priority", "5"]);
    const out = (await must(box, demo, ["context"])).out;
    const goal = out.indexOf("- [goal] own the niche");
    const moved = out.indexOf("- [decision] keep sqlite — simple");
    const objectiveRow = out.indexOf("- [objective] reach preview");
    assert.ok(goal !== -1 && moved !== -1 && objectiveRow !== -1, out);
    assert.ok(goal < moved && moved < objectiveRow, "priority 5 did not order the promoted decision between 0 and 10");
});

test("equal priorities tie by recency, absent priority sorts last, and refolds keep one order", async () =>
{
    await must(box, demo, ["state", "add", "alpha row", "--priority", "1"]);
    await must(box, demo, ["state", "add", "beta row", "--priority", "1"]);
    await must(box, demo, ["state", "add", "gamma row"]);
    const out = (await must(box, demo, ["context"])).out;
    const beta = out.indexOf("- beta row");
    const alpha = out.indexOf("- alpha row");
    const milestone = out.indexOf("- [milestone] suite green");
    const gamma = out.indexOf("- gamma row");
    assert.ok(beta !== -1 && alpha !== -1 && milestone !== -1 && gamma !== -1, out);
    assert.ok(beta < alpha, "the newer of two equal priorities did not render first");
    assert.ok(alpha < milestone && milestone < gamma, "an absent priority did not sort last");
    await must(box, demo, ["fold"]);
    const refolded = (await must(box, demo, ["context"])).out;
    assert.equal(refolded, out, "a refold changed the rendered order");
});

test("a fresh store renders no empty section headers, and live state renders without entities", async () =>
{
    const empty = (await must(freshBox, freshDemo, ["context"])).out;
    assert.ok(!empty.includes("##"), `an empty store rendered a section header:\n${empty}`);
    assert.ok(empty.includes("# demo"));
    const work = workIdIn((await mustPerson(freshBox, freshDemo, ["work", "add", "only moving part"])).out);
    await must(freshBox, freshDemo, ["work", "start", work]);
    const out = (await must(freshBox, freshDemo, ["context"])).out;
    assert.ok(out.includes("## Work in progress"), "live state did not render with an empty full block");
    assert.ok(out.includes(`- ${work} only moving part`));
    assert.ok(!out.includes("## Index"), "an empty index block rendered its header");
});

test("budget exhaustion mid-block leaves pointer rows that name the recovery command", async () =>
{
    // Preset conventions gate on the retention caps (#240), so a user-raised
    // full cap is what lets the tier exceed the whole render budget: three
    // rules of 5,000 characters, against 3,000 tokens which the shipped
    // estimate buys 12,000 characters of.
    setCaps(freshBox, { fullTokens: 100_000, tokensPerCharacter: 0.25 });
    for (const name of ["one", "two", "three"])
    {
        await must(freshBox, freshDemo, ["convention", "add", `rule ${name} ${"x".repeat(5_000)}`]);
    }
    await must(freshBox, freshDemo, ["decide", "small enough to omit"]);
    const out = (await must(freshBox, freshDemo, ["context"])).out;
    assert.ok(Array.from(out).length <= 12_000, `context ran past the budget: ${Array.from(out).length}`);
    assert.match(out, /- … \d+ full-exposure entit(y|ies) omitted; run `self state --project 'demo'`/);
    assert.match(out, /- … 1 index row omitted; run `self state --project 'demo'`/);
    assert.match(out, /- … 1 work item omitted; run `self work --project 'demo'`/);
});

test("a store over a cap renders in full while state add stays gated", async () =>
{
    setCaps(legacyBox, {});
    const first = (await must(legacyBox, legacyDemo, ["decide", "legacy ruling one"])).out.match(/\[([^\]]+)\]/)[1];
    const second = (await must(legacyBox, legacyDemo, ["decide", "legacy ruling two"])).out.match(/\[([^\]]+)\]/)[1];
    setCaps(legacyBox, { indexTokens: 20 });
    const out = (await must(legacyBox, legacyDemo, ["context"])).out;
    assert.ok(out.includes("- [decision] legacy ruling one"));
    assert.ok(out.includes("- [decision] legacy ruling two"));
    const refused = await legacySelf(["state", "add", "a third index row"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project index tier holds 34 of 20 tokens/);
    const short = await legacySelf(["state", "add", "a third index row", "--demote", first]);
    assert.notEqual(short.code, 0);
    assert.match(short.out, /still 14 tokens over the 20-token index cap after the named demotion/);
    await must(legacyBox, legacyDemo, ["state", "add", "a third index row", "--demote", first, "--demote", second]);
    assert.ok((await must(legacyBox, legacyDemo, ["state", "show", first])).out.includes("placement: project · search"));
    assert.ok((await must(legacyBox, legacyDemo, ["state", "show", second])).out.includes("placement: project · search"));
});

test("D1: a project with no reports in the window gets no nudge", async () =>
{
    const out = (await must(nudgeBox, await nudgeProject("d1", []), ["context"])).out;
    assert.ok(!NUDGE.test(out), `a project with no reports was nudged:\n${out}`);
});

test("D2: four reports all carrying friction get no nudge", async () =>
{
    const out = (await must(nudgeBox, await nudgeProject("d2", ["a", "b", "c", "d"]), ["context"])).out;
    assert.ok(!NUDGE.test(out), `a project recording friction was nudged:\n${out}`);
});

test("D3: four reports with three silent get one nudge line under ## Health", async () =>
{
    const out = (await must(nudgeBox, await nudgeProject("d3", [null, null, null, "d"]), ["context"])).out;
    const lines = out.split("\n");
    const at = lines.findIndex((line) => NUDGE.test(line));
    assert.notEqual(at, -1, `no nudge in:\n${out}`);
    assert.equal(lines.filter((line) => NUDGE.test(line)).length, 1, "the nudge rendered more than once");
    assert.ok(lines.lastIndexOf("## Health") < at, `the nudge landed outside ## Health:\n${out}`);
    assert.match(lines[at], /no friction on 3 of this project's 4 reports in the last 30 days/);
    assert.match(lines[at], /self report … --friction "<what differed>"/);
});

test("D4: four reports with two silent are not more than half, so no nudge", async () =>
{
    const out = (await must(nudgeBox, await nudgeProject("d4", [null, null, "c", "d"]), ["context"])).out;
    assert.ok(!NUDGE.test(out), `an even split was nudged:\n${out}`);
});

test("D6: the nudge counts this project's reports, not the workspace's", async () =>
{
    const silent = await nudgeProject("d6y", [null, null]);
    const speaking = (await must(nudgeBox, join(nudgeWs, "d2"), ["context"])).out;
    const out = (await must(nudgeBox, silent, ["context"])).out;
    assert.ok(!NUDGE.test(speaking), "a project at full friction was nudged for its neighbour's silence");
    assert.match(out, /no friction on 2 of this project's 2 reports in the last 30 days/);
    // The sweep that reads the same field counts a whole workspace, and both
    // say "last 30 days" — so the nudge has to say whose reports these are.
    assert.ok(!/workspace/.test(out.split("\n").find((line) => NUDGE.test(line))),
        "the nudge wording reads as a workspace number");
});

test("D5: the nudge fits the budget, and a cut one leaves the stated elision", async () =>
{
    mkdirSync(cutWs, { recursive: true });
    await must(cutBox, cutWs, ["init", "--git"]);
    const dir = await registerProject(cutBox, cutWs, "d5");
    const work = workIdIn((await mustPerson(cutBox, dir, ["work", "add", "d5 outcome"])).out);
    [null, null, null, "d"].forEach((said, index) => reportFixture(cutWs, "d5", work, index, said));
    assert.match((await must(cutBox, dir, ["context"])).out, NUDGE);
    // The same overrun the budget cell above uses: three rules of 5,000
    // characters against a budget of 12,000, so the render runs out of room
    // before ## Health rather than at it.
    setCaps(cutBox, { fullTokens: 100_000, tokensPerCharacter: 0.25 });
    for (const name of ["one", "two", "three"])
    {
        await must(cutBox, dir, ["convention", "add", `rule ${name} ${"x".repeat(5_000)}`]);
    }
    const cut = (await must(cutBox, dir, ["context"])).out;
    assert.ok(!NUDGE.test(cut), `the nudge rendered past the budget:\n${cut.slice(-400)}`);
    assert.match(cut, /- … 1 health signal omitted; run `self status --project 'd5'`/);
});

/* ── #408 I: the criteria progress on the work-in-progress row ─────── */

// Cells 81, 81a and 82 of `docs/maintainers/case-tables/408-work-criteria.md`.
// A separate machine, so the rows below are the only work in progress and the
// section can be read whole.
const criteriaBox = machine();
let criteriaDemo = null;

async function criteriaProject()
{
    criteriaDemo ??= (async () => (await demoWorkspace(criteriaBox)).demo)();
    return criteriaDemo;
}

async function unitDeclaring(outcome, criteria)
{
    const dir = await criteriaProject();
    const id = workIdIn((await mustPerson(criteriaBox, dir, ["work", "add", outcome,
        ...criteria.flatMap((text) => ["--criteria", text])])).out);
    await must(criteriaBox, dir, ["work", "start", id]);
    return id;
}

function workRow(context, id)
{
    return context.split("\n").find((line) => line.startsWith(`- ${id} `));
}

test("cell 81: the work-in-progress row carries the progress, after [toward …] and before the held note", async () =>
{
    const dir = await criteriaProject();
    const id = await unitDeclaring("cell 81", ["a", "b", "c", "d", "e"]);
    const objective = shortIdIn((await must(criteriaBox, dir, ["objective", "add", "cell 81 objective"])).out, "o");
    await must(criteriaBox, dir, ["work", "link", id, "--objective", objective]);
    await must(criteriaBox, dir, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(criteriaBox, dir, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    // Another session holds it, so the held note is there to be placed after.
    await must(criteriaBox, dir, ["work", "start", id], { SUPERSELF_SESSION: "s-other" });
    const row = workRow((await must(criteriaBox, dir, ["context"])).out, id);
    assert.match(row, new RegExp(`^- ${id} cell 81 \\[toward ${objective}\\] — 2 of 5 criteria covered  \\[`));
});

test("cell 81a: a blocked criterion is named on the row with its --on, in cN order", async () =>
{
    const dir = await criteriaProject();
    const id = await unitDeclaring("cell 81a", ["a", "b", "c", "d", "e"]);
    await must(criteriaBox, dir, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(criteriaBox, dir, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    await must(criteriaBox, dir, ["work", "block", id, "--criterion", "c5", "--on", "external", "--why", "the vendor is silent"]);
    await must(criteriaBox, dir, ["work", "block", id, "--criterion", "c3", "--on", "decision", "--why", "pricing undecided"]);
    const row = workRow((await must(criteriaBox, dir, ["context"])).out, id);
    assert.match(row, / — 2 of 5 criteria covered · c3 blocked on decision · c5 blocked on external/);
});

test("cell 82: a criterion's block adds no waiting row, and the unit is not counted among blocked ones", async () =>
{
    const dir = await criteriaProject();
    const id = await unitDeclaring("cell 82", ["a", "b", "c"]);
    await must(criteriaBox, dir, ["work", "block", id, "--criterion", "c3", "--on", "decision", "--why", "pricing undecided"]);
    const context = (await must(criteriaBox, dir, ["context"])).out;
    const waiting = context.split("## ").find((section) => section.startsWith("Waiting on you"));
    assert.ok(waiting === undefined || !waiting.includes(id), `a criterion's block grew a waiting row:\n${waiting}`);
    assert.ok(workRow(context, id) !== undefined, "the unit left the work-in-progress block");
    const status = (await must(criteriaBox, dir, ["status"])).out;
    const counts = status.split("\n").find((line) => line.startsWith("work: "));
    assert.match(counts, /0 blocked/);
});
