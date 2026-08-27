// #286: an agent that creates a work unit was never told to attach it to
// anything, and the CLI never asked — so work created the ordinary way was
// unattached by construction. `self work add` now names this project's open
// objectives and checkpoints under the new id, with the `work link` command
// spelled out, and the managed block names `work link` beside `work add`.
//
// Neither half is a gate: the unit is already recorded when this renders, and
// nothing here refuses. One test per cell of the design's case table, plus the
// three combinations the review found unfilled.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_OBJECTIVE_HINT } from "../dist/goals.js";
import { approvedIn, demoWorkspace, git, machine, must, mustPerson, workIdIn } from "./harness.mjs";

// The byte every ANSI sequence opens with, built rather than typed so this
// file carries no control character of its own.
const ESC = String.fromCharCode(27);

async function project()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    return { box, ws, demo };
}

function shortId(text, kind)
{
    const match = text.match(new RegExp(`\\b${kind}-[0-9a-z]{5}\\b`));
    assert.ok(match !== null, `no ${kind}- id in: ${text}`);
    return match[0];
}

async function objectiveIn(box, demo, outcome)
{
    return shortId((await must(box, demo, ["objective", "add", outcome])).out, "o");
}

// What `work add` printed, with the announce line, its review line (#390) and
// the new id stripped off: the three lines above the offer are the receipt this
// cell is not about.
function offer(printed)
{
    const lines = printed.replace(/\n$/, "").split("\n");
    return lines.slice(3);
}

/* ── cell 1: one open objective ───────────────────────────────────── */

test("with one open objective, work add names it, its id and the exact link command", async () =>
{
    const { box, demo } = await project();
    const objective = await objectiveIn(box, demo, "reach preview");
    const added = await mustPerson(box, demo, ["work", "add", "the flow works"]);
    const work = workIdIn(added.out);
    assert.deepEqual(offer(added.out), [
        `${objective}  unstarted  reach preview`,
        `    self work link ${work} --objective ${objective}`,
        "1 open objective"
    ]);
});

/* ── cell 2: several open objectives ──────────────────────────────── */

test("every open objective is listed, each with its own link command", async () =>
{
    const { box, demo } = await project();
    const objectives = [];
    for (const outcome of ["reach preview", "reach launch", "reach profitability"])
    {
        objectives.push(await objectiveIn(box, demo, outcome));
    }
    const added = await mustPerson(box, demo, ["work", "add", "the flow works"]);
    const work = workIdIn(added.out);
    for (const objective of objectives)
    {
        assert.ok(added.out.includes(`\n${objective}  unstarted  `), `${objective} is not offered`);
        assert.ok(added.out.includes(`    self work link ${work} --objective ${objective}\n`),
            `${objective} carries no link command`);
    }
    assert.ok(added.out.endsWith("3 open objectives\n"), `the size line is wrong:\n${added.out}`);
});

/* ── cell 3: no objective at all ──────────────────────────────────── */

test("with no objective, work add prints the line work propose prints, and no size line", async () =>
{
    const { box, demo } = await project();
    const added = await mustPerson(box, demo, ["work", "add", "the flow works"]);
    assert.deepEqual(offer(added.out), [NO_OBJECTIVE_HINT]);
    // `printSize` says nothing at zero: the empty wording is the size statement.
    assert.ok(!/\d+ open objective/.test(added.out), `a size line was printed at zero:\n${added.out}`);
});

/* ── cell 4: only closed or dropped objectives ────────────────────── */

test("a closed objective is never offered as a link target", async () =>
{
    const { box, demo } = await project();
    const reached = await objectiveIn(box, demo, "reach preview");
    const dropped = await objectiveIn(box, demo, "reach a dead end");
    await must(box, demo, ["objective", "close", reached, "--as", "reached"]);
    const closed = await approvedIn(box, demo,
        ["objective", "close", dropped, "--as", "dropped", "--why", "descoped"], dropped);
    assert.equal(closed.code, 0, `the drop was refused:\n${closed.out}`);
    const added = await mustPerson(box, demo, ["work", "add", "the flow works"]);
    assert.deepEqual(offer(added.out), [NO_OBJECTIVE_HINT]);
    assert.ok(!added.out.includes(reached), "a reached objective was offered as a link target");
    assert.ok(!added.out.includes(dropped), "a dropped objective was offered as a link target");
});

/* ── cell 5, with the review's P4: checkpoints, and the size line ─── */

test("checkpoints are offered with --milestone, and several of them do not inflate the size", async () =>
{
    const { box, demo } = await project();
    const objective = await objectiveIn(box, demo, "reach preview");
    const first = shortId((await must(box, demo,
        ["milestone", "add", "suite green", "--objective", objective, "--exit", "tests pass"])).out, "m");
    const second = shortId((await must(box, demo,
        ["milestone", "add", "docs written", "--objective", objective, "--exit", "the page exists"])).out, "m");
    const added = await mustPerson(box, demo, ["work", "add", "the flow works"]);
    const work = workIdIn(added.out);
    assert.ok(added.out.includes(`      self work link ${work} --milestone ${first}\n`),
        `the first checkpoint carries no link command:\n${added.out}`);
    assert.ok(added.out.includes(`      self work link ${work} --milestone ${second}\n`),
        `the second checkpoint carries no link command:\n${added.out}`);
    // The size counts outcomes, not rows: two checkpoints under one objective
    // are still one open objective.
    assert.ok(added.out.endsWith("1 open objective\n"), `the size counted rows:\n${added.out}`);
});

/* ── cell 6: piped output is unstyled ─────────────────────────────── */

test("a piped work add prints the offer without a single escape sequence", async () =>
{
    const { box, demo } = await project();
    await objectiveIn(box, demo, "reach preview");
    const added = await mustPerson(box, demo, ["work", "add", "the flow works"]);
    assert.ok(!added.out.includes(ESC), `a piped run carried styling:\n${JSON.stringify(added.out)}`);
});

/* ── cell 7: at a terminal the offer is appended, not substituted ─── */

// `style.ts` decides once, when it is first imported, whether this run is
// styled — so the dim half of this cell can only be asserted in a file that
// says so before the built modules load. `render-gate-tty.test.mjs` is that
// file and holds it; what is asserted here is the rest: the offer is appended
// below the id rather than replacing anything, and the terminal render carries
// no size line.
test("at a terminal the offer is appended under the id, with no size line", async () =>
{
    const { box, demo } = await project();
    const objective = await objectiveIn(box, demo, "reach preview");
    const added = await approvedIn(box, demo, ["work", "add", "the flow works"], "");
    assert.equal(added.code, 0, added.out);
    const work = workIdIn(added.printed);
    const lines = added.printed.replace(/\n$/, "").split("\n");
    // The announce line, then its review line (#390), then the id.
    assert.equal(lines[2], work, "the id is no longer the line under the append's own two lines");
    // The terminal render frames its own rows, so the plain render's size line
    // is not printed here — `output.ts` prints one or the other, never both.
    assert.ok(!lines.some((line) => line.includes("open objective")), `a size line reached the terminal:\n${added.printed}`);
    assert.ok(added.printed.includes(objective), "the objective is missing from the terminal offer");
});

/* ── cell 8, with the review's P2: a correction names what it replaces ── */

test("--supersedes names the replaced unit's links, cross-project ones included", async () =>
{
    const { box, ws, demo } = await project();
    const other = join(ws, "other");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    await must(box, other, ["project", "init", "--name", "other", "--no-connect"]);
    const foreign = await objectiveIn(box, other, "the other project's outcome");
    const local = await objectiveIn(box, demo, "reach preview");
    const first = workIdIn((await mustPerson(box, demo, ["work", "add", "the first wording"])).out);
    await must(box, demo, ["work", "link", first, "--objective", local]);
    await must(box, demo, ["work", "link", first, "--objective", foreign, "--objective-project", "other"]);
    const added = await approvedIn(box, demo,
        ["work", "add", "the corrected wording", "--supersedes", first, "--why", "the outcome was restated"], first);
    assert.equal(added.code, 0, `the correction was refused:\n${added.out}`);
    const second = workIdIn(added.printed);
    assert.notEqual(second, first, "the receipt reported the retired unit's id");
    assert.ok(added.printed.includes(`${first} was attached to these`), `no carry-over line:\n${added.printed}`);
    assert.ok(added.printed.includes(`self work link ${second} --objective ${local}`),
        "the local link is not carried over by name");
    // `contributionsOf` resolves ids in this project's goal tree alone, so a
    // link to another project's objective has to be read from its own array —
    // reading only the first would report "attached to nothing".
    assert.ok(added.printed.includes(`${foreign} (other)`), `the cross-project link is unnamed:\n${added.printed}`);
    assert.ok(added.printed.includes(`self work link ${second} --objective ${foreign} --objective-project other`),
        "the cross-project link carries no command that restores it");
});

/* ── the review's P3: --supersedes with nothing attached ──────────── */

test("a correction of an unattached unit says nothing about carry-over", async () =>
{
    const { box, demo } = await project();
    await objectiveIn(box, demo, "reach preview");
    const first = workIdIn((await mustPerson(box, demo, ["work", "add", "the first wording"])).out);
    const added = await approvedIn(box, demo,
        ["work", "add", "the corrected wording", "--supersedes", first, "--why", "the outcome was restated"], first);
    assert.equal(added.code, 0, `the correction was refused:\n${added.out}`);
    assert.ok(!added.printed.includes("was attached to these"),
        `a carry-over line was printed for a unit with no links:\n${added.printed}`);
    assert.ok(!added.printed.includes(first), "the replaced unit's id is named where it has nothing to carry");
});

/* ── cell 9: an accepted proposal prints no offer ─────────────────── */

test("work accept prints no offer — propose already demanded the attachment", async () =>
{
    const { box, demo } = await project();
    const objective = await objectiveIn(box, demo, "reach preview");
    const proposal = workIdIn((await must(box, demo, ["work", "propose", "close the gap",
        "--value", "it unblocks preview", "--success", "the suite is green",
        "--stop", "the approach is wrong", "--risk", "the fix is deeper than it looks",
        "--capacity", "a day", "--evidence-plan", "the suite output",
        "--confidence", "medium", "--expires", "2099-01-01", "--objective", objective])).out);
    const accepted = await mustPerson(box, demo, ["work", "accept", proposal]);
    assert.ok(!accepted.out.includes("self work link"), `accept offered an attachment:\n${accepted.out}`);
    assert.ok(!accepted.out.includes("open objective"), `accept printed a size line:\n${accepted.out}`);
});

/* ── cell 10: another project's objectives do not leak ────────────── */

test("an objective that only another project has is not offered here", async () =>
{
    const { box, ws, demo } = await project();
    const other = join(ws, "other");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    await must(box, other, ["project", "init", "--name", "other", "--no-connect"]);
    const foreign = await objectiveIn(box, other, "the other project's outcome");
    const added = await mustPerson(box, demo, ["work", "add", "the flow works"]);
    assert.deepEqual(offer(added.out), [NO_OBJECTIVE_HINT]);
    assert.ok(!added.out.includes(foreign), "another project's objective was offered");
    assert.ok(!added.out.includes("the other project's outcome"), "another project's outcome text leaked");
});

/* ── cell 11: the recorded event did not move ─────────────────────── */

test("the event work add records is unchanged — this is an output-only change", async () =>
{
    const { box, ws, demo } = await project();
    await objectiveIn(box, demo, "reach preview");
    await mustPerson(box, demo, ["work", "add", "the flow works"]);
    const log = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trimEnd().split("\n");
    const event = JSON.parse(log[log.length - 1]);
    assert.equal(event.type, "entity.confirmed", "the last event is not the unit that was just recorded");
    assert.deepEqual(Object.keys(event.payload).sort(),
        ["criteria", "entity", "exposure", "labels", "links", "scope", "text"]);
    assert.equal(event.payload.text, "the flow works");
    assert.deepEqual(event.payload.labels, ["work"]);
    assert.deepEqual(event.payload.links, []);
    assert.deepEqual(event.payload.criteria, []);
    assert.equal(event.payload.scope, "project");
});

/* ── cell 12: the managed block names work link ───────────────────── */

test("the managed block names work link, in both instruction files", async () =>
{
    const { box, demo } = await project();
    await must(box, demo, ["connect"]);
    const blocks = ["AGENTS.md", "CLAUDE.md"].map((name) => readFileSync(join(demo, name), "utf8"));
    for (const block of blocks)
    {
        assert.ok(block.includes("`self work link <id> --objective <objective-id>`"),
            "the managed block does not name `work link`");
    }
    const begin = "<!-- superself:begin";
    const end = "<!-- superself:end -->";
    const bodies = blocks.map((content) => content.slice(content.indexOf(begin), content.indexOf(end) + end.length));
    assert.equal(bodies[0], bodies[1], "AGENTS.md and CLAUDE.md carry different managed blocks");
});
