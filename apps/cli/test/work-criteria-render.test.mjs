// #408, section I of `docs/maintainers/case-tables/408-work-criteria.md`: what
// the declared criteria look like on every surface that shows them — the unit's
// page, the synced file, both renders of `self work`, the raw record's page and
// the log. `self context` is cells 81, 81a and 82 in `context.test.mjs`, and
// the golden fixture is cell 86.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { criteriaNote, criteriaProgress } from "../dist/entities.js";
import { buildModel } from "../dist/model.js";
import { renderWorkList } from "../dist/pretty.js";
import { fixturePath } from "./golden.mjs";
import { demoWorkspace, git, machine, must, mustPerson, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);
const storeDir = join(ws, ".superself");

const C1 = "the fixture regenerates clean";
const C2 = "the release note names the flag";
const C3 = "the vendor quota is raised";

writeFileSync(join(demo, "seed.txt"), "the change\n");
git(box, demo, ["add", "."]);
git(box, demo, ["commit", "-q", "-m", "the change"]);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: demo, env: box.env, encoding: "utf8" }).trim();

// Cell 75's unit: c1 covered with evidence, c2 blocked, c3 open with a verify
// text. Seeded on first use — the driver runs one command at a time, so a
// top-level await here would overlap the first cell.
let seeded = null;

function shownUnit()
{
    seeded ??= (async () =>
    {
        const id = workIdIn((await mustPerson(box, demo, ["work", "add", "the criteria render",
            "--criteria", C1, "--criteria", C2, "--criteria", C3,
            "--verify", "c3 the quota page shows 10k"])).out);
        await must(box, demo, ["work", "start", id]);
        await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "the fixture came back clean", "--evidence", head]);
        await must(box, demo, ["work", "block", id, "--criterion", "c2", "--on", "external", "--why", "the vendor is silent"]);
        return id;
    })();
    return seeded;
}

let bare = null;

function bareUnit()
{
    bare ??= (async () =>
    {
        const id = workIdIn((await mustPerson(box, demo, ["work", "add", "the unit that declares nothing"])).out);
        await must(box, demo, ["work", "start", id]);
        return id;
    })();
    return bare;
}

function criteriaBlock(text)
{
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line.startsWith("- Criteria:"));
    if (at === -1)
    {
        return [];
    }
    const rest = lines.slice(at + 1).findIndex((line) => !line.startsWith("  - "));
    return lines.slice(at, rest === -1 ? undefined : at + 1 + rest);
}

const CRITERIA_BLOCK = (date) => [
    "- Criteria: 1 of 3 covered (1 blocked)",
    `  - c1 covered — the fixture came back clean (agent ${date}, ${head})`,
    "  - c2 blocked on external — the vendor is silent",
    `  - c3 open — ${C3} · verify: the quota page shows 10k`
];

const today = new Date().toISOString().slice(0, 10);

test("cell 75: work show carries the criteria block, k of n and one bullet per criterion in cN order", async () =>
{
    const id = await shownUnit();
    assert.deepEqual(criteriaBlock((await must(box, demo, ["work", "show", id])).out), CRITERIA_BLOCK(today));
});

test("cell 76: work show on a unit declaring none is byte-identical to what it was", async () =>
{
    const id = await bareUnit();
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.doesNotMatch(shown, /Criteria/);
    assert.deepEqual(shown.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.split(":")[0]),
        ["- Status", "- Branches", "- Not done yet"], `the page of a unit declaring nothing changed shape:\n${shown}`);
});

test("cell 77: the synced work/<id>.md carries the same block, and every value in it is folded", async () =>
{
    const id = await shownUnit();
    await must(box, demo, ["fold"]);
    const page = readFileSync(join(storeDir, "projects", "demo", "work", `${id}.md`), "utf8");
    assert.deepEqual(criteriaBlock(page), CRITERIA_BLOCK(today));
});

test("cell 78: a piped `self work` row gains one bracketed segment", async () =>
{
    const id = await shownUnit();
    const row = (await must(box, demo, ["work"])).out.split("\n").find((line) => line.startsWith(id));
    assert.match(row, /\[1 of 3 criteria covered\]/);
    assert.ok(row.indexOf("[1 of 3 criteria covered]") < row.indexOf("report(s)") || !row.includes("report(s)"));
});

test("cell 79: at a terminal the progress is a note under the row, not a fifth column", async () =>
{
    await shownUnit();
    const model = buildModel(storeDir, "demo", new Date());
    const lines = renderWorkList(model);
    const header = lines.find((line) => line.includes("OUTCOME"));
    assert.match(header, /ID.*STATE.*OUTCOME.*REPORTS/);
    assert.equal(header.split("│").length - 1, 5, "the table grew a fifth column");
    assert.ok(lines.some((line) => line.includes("↳ 1 of 3 criteria covered")),
        `no criteria note under the row:\n${lines.join("\n")}`);
});

test("cell 79a: the note names each blocked criterion with its --on, in cN order", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 79a",
        "--criteria", "a", "--criteria", "b", "--criteria", "c", "--criteria", "d", "--criteria", "e"])).out);
    await must(box, demo, ["work", "start", id]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    // Blocked out of cN order, so the render's own order is what is asserted.
    await must(box, demo, ["work", "block", id, "--criterion", "c5", "--on", "dependency", "--why", "waits on the library"]);
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "decision", "--why", "pricing undecided"]);
    const model = buildModel(storeDir, "demo", new Date());
    // The one sentence, composed once: the note under the row is this string,
    // fitted to the flex column by `noteLine` like every other note.
    const work = model.works.find((item) => item.id === id);
    assert.equal(criteriaNote(work.criteria),
        "2 of 5 criteria covered · c3 blocked on decision · c5 blocked on dependency");
    const lines = renderWorkList(model);
    const note = lines.find((line) => line.includes("2 of 5 criteria covered · c3 blocked on decision"));
    assert.ok(note !== undefined, `the note did not name the blocked criteria in cN order:\n${lines.join("\n")}`);
    // Notes never widen a column: the note's line is exactly as wide as the
    // table's own rules, however long the sentence is.
    const rule = lines.find((line) => line.startsWith("┌"));
    assert.equal(note.length, rule.length, "the criteria note widened the table");
});

test("cell 80: a unit declaring none is unchanged in both renders", async () =>
{
    const id = await bareUnit();
    const row = (await must(box, demo, ["work"])).out.split("\n").find((line) => line.startsWith(id));
    assert.doesNotMatch(row, /criteria covered/);
    const model = buildModel(storeDir, "demo", new Date());
    const work = model.works.find((item) => item.id === id);
    assert.deepEqual(work.criteria, []);
    assert.equal(criteriaProgress(work.criteria), undefined);
    const table = renderWorkList(model);
    const at = table.findIndex((line) => line.includes(id));
    assert.doesNotMatch(table[at + 1] ?? "", new RegExp(`↳.*criteria covered`));
});

test("cell 83: state show renders criterion: cN <text> with verify and blocked beneath", async () =>
{
    const id = await shownUnit();
    const shown = (await must(box, demo, ["state", "show", id])).out;
    const block = shown.split("\n").filter((line) => line.startsWith("criterion: ") || line.startsWith("  "));
    assert.deepEqual(block, [
        `criterion: c1 ${C1}`,
        `criterion: c2 ${C2}`,
        "  blocked: on external — the vendor is silent",
        `criterion: c3 ${C3}`,
        "  verify: the quota page shows 10k"
    ]);
    assert.match(shown, new RegExp(`covered: ${C1} — the fixture came back clean \\(agent ${today}\\)`));
});

test("cell 84: each new type prints a log row naming the unit and the criterion", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 84", "--criteria", "a"])).out);
    await must(box, demo, ["work", "start", id]);
    await must(box, demo, ["work", "criteria", "add", id, "b", "--verify", "the file has the line"]);
    await must(box, demo, ["work", "block", id, "--criterion", "c2", "--on", "external", "--why", "the vendor is silent"]);
    await must(box, demo, ["work", "unblock", id, "--criterion", "c2"]);
    const rows = (await must(box, demo, ["log", "-n", "3"])).out.split("\n");
    assert.match(rows[0], new RegExp(`entity\\.criterion-declared.*${id} "b" · verify: the file has the line`));
    assert.match(rows[1], new RegExp(`entity\\.criterion-blocked.*${id} "b" — blocked on external: the vendor is silent`));
    assert.match(rows[2], new RegExp(`entity\\.criterion-unblocked.*${id} "b" — released`));
    assert.doesNotMatch(rows.join("\n"), /\[object Object\]/);
});

test("cell 85: #408 delivers WorkState.criteria and criteriaProgress; the milestone row is #406's", async () =>
{
    const id = await shownUnit();
    const objective = (await must(box, demo, ["objective", "add", "cell 85 objective"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const milestone = (await must(box, demo, ["milestone", "add", "cell 85 checkpoint",
        "--objective", objective, "--exit", "the exit criterion"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    await must(box, demo, ["work", "link", id, "--milestone", milestone]);
    const model = buildModel(storeDir, "demo", new Date());
    const work = model.works.find((item) => item.id === id);
    assert.deepEqual(work.criteria.map((item) => item.id), ["c1", "c2", "c3"]);
    assert.deepEqual(criteriaProgress(work.criteria), { covered: 1, total: 3, waiting: ["c2 blocked on external"] });
    // A milestone's own exit criteria are unchanged: `milestone met` writes the
    // same claim, and no verb here blocks one.
    const before = readFileSync(join(storeDir, "projects", "demo", "log.jsonl"), "utf8").trim().split("\n").length;
    await must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "the exit criterion was met"]);
    const written = readFileSync(join(storeDir, "projects", "demo", "log.jsonl"), "utf8").trim().split("\n")
        .slice(before).map((line) => JSON.parse(line));
    assert.deepEqual(written.map((event) => event.type), ["entity.covered"]);
    assert.equal(written[0].payload.criterion, "the exit criterion");
    // The row and the layout are #406's; the sentence inside it is this
    // issue's, printed verbatim — so the milestone page cannot describe a unit
    // differently from `work show`, `self work` and `self context`.
    assert.match((await must(box, demo, ["milestone", "show", milestone])).out,
        new RegExp(`^- \\*\\*${id}\\*\\* the criteria render — active, `
            + "1 of 3 criteria covered · c2 blocked on external$", "m"));
});

test("cell 86: the golden fixture's unit declares criteria, so the four renders are pinned in bytes", () =>
{
    const sections = readFileSync(fixturePath, "utf8").split(/\n(?=\$ self )/);
    // The first answer, not the last: the sweep asks every read surface while
    // the unit is open, and closes it in the receipt half that follows.
    const answer = (head) => sections.find((section) => section.startsWith(`${head}\n`));
    // `work show`, both renders of `self work` — the piped row here, the note
    // under it in cell 79 — and the work-in-progress row of `self context`.
    // The fixture's c2 is a person's own task since #413, so the bullet and the
    // context row carry its `(person)` mark. What this cell pins is unchanged:
    // the block, the count, and the same sentence on every surface.
    assert.match(answer("$ self work show <w-id>   (in project, exit 0)"),
        /- Criteria: 1 of 2 covered\n {2}- c1 covered — the fixture regenerated clean \(agent <date>\)\n {2}- c2 open — the release note names the flag · verify: the note carries the line \(person\)/);
    assert.match(answer("$ self work   (in project, exit 0)"), /\[1 of 2 criteria covered\]/);
    assert.match(answer("$ self context   (in project, exit 0)"),
        /^- <w-id> stage 1 lands the render gate and its pilot — 1 of 2 criteria covered · c2 \(person\) — latest report/m);
    // The refusal the criteria clause gives, and the covering line it names.
    assert.match(answer("$ self work show <w-id>   (in project, exit 0)"),
        /- Not done yet: <w-id> declares 2 criteria and 1 is not covered:\n {4}c2 {2}open — the release note names the flag \(person\)\n {2}cover each with `self work cover <w-id> --criterion c2 --why "<how>"`/);
    // And every documented line still runs: `docs.test.mjs` proof 1 drives
    // them, and proof 3 reads the three new event types back off a log the
    // verbs wrote rather than off a list.
    assert.match(readFileSync(fixturePath, "utf8"), /self work cover <w-id> --criterion c1/);
});
