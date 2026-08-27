// The piped half of stage 3's render-gate case table (w-5emx6): cells 1 to 12,
// 14, 15 and 16. Cell 13 is the terminal one and lives in
// render-gate-tty.test.mjs, which has to load with a styled stdout to mean
// anything. Stages 1 and 2 number their cells from one as well, so every name
// here says which stage it belongs to.
//
// What the cells assert is the deliberate change this stage makes: a piped
// listing prints the rows it always printed and then says how much there is.
// A listing with nothing in it is the case that must NOT have moved — its
// empty wording already states the size, and a `0` line under it would be the
// same fact twice.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, machine, must, mustPerson, retireFixture, selfIn, workIdIn } from "./harness.mjs";
import { printingModules } from "./structure.mjs";

const source = fileURLToPath(new URL("../src", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/golden/piped.txt", import.meta.url));

const box = machine();
const ws = join(box.root, "ws");
const demo = join(ws, "demo");
const other = join(ws, "other");

// The scenario every cell below reads: two registered projects, and in `demo`
// two objectives with a checkpoint under one of them, three work units in
// three states, an artifact and enough records for a search to find several.
mkdirSync(demo, { recursive: true });
mkdirSync(other, { recursive: true });
await must(box, ws, ["init"]);
git(box, demo, ["init", "-q", "-b", "main"]);
git(box, other, ["init", "-q", "-b", "main"]);
await must(box, demo, ["project", "init", "--name", "demo", "--desc", "the listing migration", "--no-connect"]);
await must(box, other, ["project", "init", "--name", "other", "--desc", "the second log", "--no-connect"]);

const objective = idOf((await must(box, demo, ["objective", "add", "every listing states its size"])).out, "o");
await must(box, demo, ["objective", "add", "the gate owns the size line"]);
const milestone = idOf((await must(box, demo, ["milestone", "add", "the listings answer with blocks",
    "--objective", objective, "--exit", "no listing prints for itself"])).out, "m");
const open = workIdIn((await mustPerson(box, demo, ["work", "add", "the listings move behind the gate"])).out);
await must(box, demo, ["work", "link", open, "--milestone", milestone]);
const second = workIdIn((await mustPerson(box, demo, ["work", "add", "the size line is written once"])).out);
const finished = workIdIn((await mustPerson(box, demo, ["work", "add", "the receipts moved in stage two"])).out);
await must(box, demo, ["work", "done", finished, "--report", "stage two shipped"]);
writeFileSync(join(demo, "evidence.md"), "a listing carries an artifact\n");
await must(box, demo, ["report", open, "the listing sweep", "--artifact", "evidence.md"]);
await mustPerson(box, other, ["work", "add", "the other project keeps its own log"]);

function idOf(text, prefix)
{
    const match = text.match(new RegExp(`\\b${prefix}-[0-9abcdefghjkmnpqrstvwxyz]{5}\\b`));
    if (match === null)
    {
        throw new Error(`no ${prefix}- id in: ${text}`);
    }
    return match[0];
}

function lines(answer)
{
    assert.equal(answer.code, 0, answer.out);
    return answer.out.replace(/\n$/, "").split("\n");
}

/* ── the empty listings, which did not move ────────────────────────── */

// Every stage-3 surface with nothing to answer with, asked of a project that
// has just been registered and a workspace that has nothing set aside. The
// wording is the one each surface has always printed, asserted whole: the point
// of the cell is that no line was added under it.
//
// Two surfaces have no empty form and are not here. `self log` lists the events
// registering a project wrote, so a readable project always has some; `self
// alias` renders a built-in table, so a workspace always has rows.
const EMPTY_IN_PROJECT = [
    [["project", "--archived"], "no archived projects — `self project` lists the ones this workspace is working on"],
    [["objective"], "no objectives — the long-term goal is separate; add one with `self objective add \"<outcome>\"`"],
    [["milestone"], "no milestones — add one with `self milestone add \"<outcome>\" --objective <id> --exit \"<criterion>\"`"],
    [["work"], "no open work"],
    [["artifact", "list"], "no artifacts — attach one with `self report <work-id> \"…\" --artifact <path>`"],
    [["artifact", "search", "nothing"], "no artifacts — attach one with `self report <work-id> \"…\" --artifact <path>`"],
    [["search", "nothing at all in this store"], "no matches"]
];

/* ── the fixture, and the tree the migration leaves ────────────────── */

// The committed sweep is what a reader of a piped run sees, recorded. Each
// surface named here is asked in it, and what the cell reads is the line the
// stage added: the section's last line is that surface's size.
const FIXTURE_SIZES = [
    ["$ self project   (in workspace, exit 0)", "2 projects"],
    ["$ self objective   (in project, exit 0)", "1 open objective"],
    ["$ self milestone   (in project, exit 0)", "1 milestone"],
    ["$ self work   (in project, exit 0)", "1 open work unit"],
    ["$ self artifact list   (in project, exit 0)", "1 artifact"],
    ["$ self log -n 5   (in project, exit 0)", "last 5 of 15 events · self log -n 15 --project 'demo'"]
];

/* ── scratch machines ──────────────────────────────────────────────── */

// A machine of its own, with `demo` registered and whatever else is named.
// Archiving and restoring move workspace state, so a cell that does either
// cannot share the scenario every other cell reads.
async function machineWithProjects(slugs)
{
    const own = machine();
    const root = join(own.root, "ws");
    const project = join(root, "demo");
    mkdirSync(project, { recursive: true });
    await must(own, root, ["init"]);
    git(own, project, ["init", "-q", "-b", "main"]);
    await must(own, project, ["project", "init", "--name", "demo", "--desc", "the scratch project", "--no-connect"]);
    for (const slug of slugs)
    {
        const dir = join(root, slug);
        mkdirSync(dir, { recursive: true });
        git(own, dir, ["init", "-q", "-b", "main"]);
        await must(own, dir, ["project", "init", "--name", slug, "--no-connect"]);
    }
    return { box: own, ws: root, demo: project, bare: own.root };
}

async function archivedWorkspace()
{
    const own = await machineWithProjects(["alpha", "beta"]);
    await must(own.box, own.ws, ["project", "archive", "alpha", "--why", "set aside for the quarter"]);
    await must(own.box, own.ws, ["project", "archive", "beta", "--why", "set aside as well"]);
    return own;
}

/* ── the complete listings: rows as today, then the size ───────────── */

test("stage 3 cell 1: a piped `self project` ends with the number of projects", async () =>
{
    const printed = lines(await selfIn(box, ws, ["project"]));
    assert.deepEqual(printed, [
        "demo — the listing migration",
        "other — the second log",
        "2 projects"
    ]);
});

test("stage 3 cell 2: a piped `self project --archived` counts the projects, not the ways back", async () =>
{
    const archiveBox = await archivedWorkspace();
    const printed = lines(await selfIn(archiveBox.box, archiveBox.ws, ["project", "--archived"]));
    // Two rows and a way back under each: the size is what was set aside.
    assert.equal(printed.length, 5);
    assert.equal(printed.at(-1), "2 archived projects");
    assert.match(printed[1], /^ {4}self project restore /);
});

test("stage 3 cell 3: a piped `self project archive` answers with its receipt, the listing, and the size", async () =>
{
    const archiveBox = await machineWithProjects(["alpha"]);
    const printed = lines(await selfIn(archiveBox.box, archiveBox.ws,
        ["project", "archive", "alpha", "--why", "nobody is working on it"]));
    // The append's own line, then the receipt, then the listing this verb no
    // longer writes for itself, then its size — in that order and no other.
    assert.match(printed[0], /^project\.archived recorded \[[0-9abcdefghjkmnpqrstvwxyz]{26}\]$/);
    assert.equal(printed[1], "project \"alpha\" is archived — 0 open work units went with it, unchanged; "
        + "run `self project restore alpha` to bring it back");
    assert.match(printed[2], /^alpha — archived \d{4}-\d{2}-\d{2}: nobody is working on it$/);
    assert.equal(printed[3], "    self project restore alpha [--why \"<why it should never have been archived>\"]");
    assert.equal(printed[4], "1 archived project");
    assert.equal(printed.length, 5);
});

test("stage 3 cell 3: a piped `self project restore` answers the same way, with what is still set aside", async () =>
{
    const archiveBox = await machineWithProjects(["alpha", "beta"]);
    await must(archiveBox.box, archiveBox.ws, ["project", "archive", "alpha", "--why", "set aside"]);
    await must(archiveBox.box, archiveBox.ws, ["project", "archive", "beta", "--why", "set aside too"]);
    const printed = lines(await selfIn(archiveBox.box, archiveBox.ws, ["project", "restore", "alpha"]));
    assert.equal(printed[1], "project \"alpha\" is back — 0 open work units came back with it, as it was left");
    assert.match(printed[2], /^beta — archived /);
    assert.equal(printed.at(-1), "1 archived project");
});

test("stage 3 cell 4: a piped `self objective` counts objectives, not the checkpoints under them", async () =>
{
    const printed = lines(await selfIn(box, demo, ["objective"]));
    // Two objectives and one checkpoint indented under the first of them.
    assert.equal(printed.length, 4);
    assert.match(printed[1], /^ {2}m-/);
    assert.equal(printed.at(-1), "2 open objectives");
});

test("stage 3 cell 5: a piped `self milestone` ends with the number of checkpoints", async () =>
{
    const printed = lines(await selfIn(box, demo, ["milestone"]));
    assert.equal(printed.length, 2);
    assert.equal(printed.at(-1), "1 milestone");
});

test("stage 3 cell 6: a piped `self work` counts the open units and keeps the hidden buckets", async () =>
{
    const printed = lines(await selfIn(box, demo, ["work"]));
    assert.equal(printed.length, 4);
    assert.ok(printed.slice(0, 2).some((row) => row.startsWith(`${open}  `)), printed.join("\n"));
    assert.ok(printed.slice(0, 2).some((row) => row.startsWith(`${second}  `)), printed.join("\n"));
    assert.equal(printed[2], "(1 done — see log)");
    assert.equal(printed.at(-1), "2 open work units");
});

test("stage 3 cell 6: a retired unit stays its own bucket line and is not counted as open", async () =>
{
    const retireBox = await machineWithProjects([]);
    const unit = workIdIn((await mustPerson(retireBox.box, retireBox.demo, ["work", "add", "an outcome that moved"])).out);
    await mustPerson(retireBox.box, retireBox.demo, ["work", "add", "the outcome it moved to"]);
    // Retiring a confirmed record needs a person at a terminal (#173), and the
    // cell is about the listing rather than about the gate that guards it.
    retireFixture(retireBox.box, retireBox.ws, "demo", "entity.retired", { entity: unit, why: "it moved" });
    const printed = lines(await selfIn(retireBox.box, retireBox.demo, ["work"]));
    assert.equal(printed.at(-2), "(1 retired — see log)");
    assert.equal(printed.at(-1), "1 open work unit");
});

test("stage 3 cell 9: a piped `self artifact list` ends with the number of artifacts", async () =>
{
    const printed = lines(await selfIn(box, demo, ["artifact", "list"]));
    assert.equal(printed.length, 2);
    assert.equal(printed.at(-1), "1 artifact");
});

test("stage 3 cell 9: `self artifact search` counts its hits the same way", async () =>
{
    const printed = lines(await selfIn(box, demo, ["artifact", "search", "evidence"]));
    assert.equal(printed.at(-1), "1 artifact");
});

test("stage 3 cell 10: a piped `self search` ends with the number of matches", async () =>
{
    const printed = lines(await selfIn(box, demo, ["search", "listing", "--all"]));
    const hits = printed.length - 1;
    assert.ok(hits >= 2, printed.join("\n"));
    assert.equal(printed.at(-1), `${hits} matches`);
});

test("stage 3 cell 10: one match is counted in the singular the noun actually takes", async () =>
{
    const printed = lines(await selfIn(box, demo, ["search", "the size line is written once", "--all"]));
    assert.equal(printed.length, 2);
    assert.equal(printed.at(-1), "1 match");
});

test("stage 3 cell 11: a piped `self alias` ends with the number of rows in the table", async () =>
{
    const printed = lines(await selfIn(box, demo, ["alias"]));
    assert.ok(printed.length > 2, printed.join("\n"));
    assert.equal(printed.at(-1), `${printed.length - 1} aliases`);
    // A verb added to the table is a row and a unit of the size, both.
    await must(box, demo, ["alias", "add", "note", "--label", "note", "--exposure", "search"]);
    const after = lines(await selfIn(box, demo, ["alias"]));
    assert.equal(after.at(-1), `${printed.length} aliases`);
});

/* ── the truncated listing: the only one that says what it is hiding ─ */

test("stage 3 cell 7: a piped `self log` past its limit says what it shows of what there is", async () =>
{
    const total = lines(await selfIn(box, demo, ["log", "-n", "500"])).length - 1;
    const printed = lines(await selfIn(box, demo, ["log", "-n", "3"]));
    assert.equal(printed.length, 4);
    assert.equal(printed.at(-1), `last 3 of ${total} events · self log -n ${total} --project 'demo'`);
});

test("stage 3 cell 7: a `self log` that shows the whole log states its size and points nowhere", async () =>
{
    const total = lines(await selfIn(box, demo, ["log", "-n", "500"])).length - 1;
    assert.equal(lines(await selfIn(box, demo, ["log", "-n", "500"])).at(-1), `${total} events`);
});

test("stage 3 cell 8: a piped `self log --workspace` points at the workspace, not at one project", async () =>
{
    const whole = lines(await selfIn(box, demo, ["log", "--workspace", "-n", "500"]));
    const total = whole.length - 1;
    const printed = lines(await selfIn(box, demo, ["log", "--workspace", "-n", "3"]));
    assert.equal(printed.length, 4);
    assert.equal(printed.at(-1), `last 3 of ${total} events · self log -n ${total} --workspace`);
    // The merged log is the two projects' together, which is what makes the
    // total wrong if it were counted from either one of them.
    assert.ok(whole.some((row) => row.startsWith("other  ")), whole.join("\n"));
    assert.ok(whole.some((row) => row.startsWith("demo  ")), whole.join("\n"));
});

test("stage 3 cell 8: the total is the merged log's, not the project's the command ran in", async () =>
{
    const merged = lines(await selfIn(box, demo, ["log", "--workspace", "-n", "500"])).length - 1;
    const here = lines(await selfIn(box, demo, ["log", "-n", "500"])).length - 1;
    assert.ok(merged > here, `${merged} merged vs ${here} local`);
    assert.equal(lines(await selfIn(box, demo, ["log", "--workspace", "-n", "1"])).at(-1),
        `last 1 of ${merged} events · self log -n ${merged} --workspace`);
});

test("stage 3 cell 12: an empty listing prints its own wording and nothing under it", async () =>
{
    const empty = await machineWithProjects([]);
    for (const [args, wording] of EMPTY_IN_PROJECT)
    {
        const answer = await selfIn(empty.box, empty.demo, args);
        assert.equal(answer.code, 0, answer.out);
        assert.equal(answer.out, `${wording}\n`, `self ${args.join(" ")}`);
    }
});

test("stage 3 cell 12: a workspace with no project registered answers as it always did", async () =>
{
    const bare = machine();
    await must(bare, bare.root, ["init"]);
    const answer = await selfIn(bare, bare.root, ["project"]);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.out, "no projects registered — run `self project init` inside a project directory\n");
});

test("stage 3 cell 12: a workspace whose every project is archived answers as it always did", async () =>
{
    const empty = await machineWithProjects([]);
    await must(empty.box, empty.ws, ["project", "archive", "demo", "--why", "set aside"]);
    const answer = await selfIn(empty.box, empty.ws, ["project"]);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.out, "every registered project is archived — run `self project --archived` to list them\n");
});

/* ── a listing read from outside the project it answers for ────────── */

test("stage 3 cell 14: from outside every checkout, the size line's pointer names the project asked about", async () =>
{
    const total = lines(await selfIn(box, demo, ["log", "-n", "500"])).length - 1;
    const printed = lines(await selfIn(box, box.root, ["log", "-n", "2", "--project", "demo"]));
    assert.equal(printed.at(-1), `last 2 of ${total} events · self log -n ${total} --project 'demo'`);
    // The pointer is a command, so it has to answer from where it was read.
    const followed = lines(await selfIn(box, box.root, ["log", "-n", String(total), "--project", "demo"]));
    assert.equal(followed.length, total + 1);
    assert.equal(followed.at(-1), `${total} events`);
});

test("stage 3 cell 14: a scoped listing with no window states the size of the project it was asked about", async () =>
{
    assert.equal(lines(await selfIn(box, box.root, ["objective", "--project", "demo"])).at(-1), "2 open objectives");
    assert.equal(lines(await selfIn(box, box.root, ["work", "--project", "other"])).at(-1), "1 open work unit");
});

test("stage 3 cell 15: every listing in the committed sweep ends with the size it states", () =>
{
    const sections = readFileSync(fixture, "utf8").split(/\n(?=\$ self )/);
    for (const [head, size] of FIXTURE_SIZES)
    {
        const last = sections.filter((section) => section.startsWith(`${head}\n`)).at(-1);
        assert.notEqual(last, undefined, `${head} is not in the sweep`);
        assert.equal(last.replace(/\n+$/, "").split("\n").at(-1), size, head);
    }
});

test("stage 3 cell 16: the modules this stage emptied are off the printing ratchet and print nothing", () =>
{
    const migrated = ["src/aliases.ts", "src/archive.ts", "src/artifact.ts", "src/search.ts"];
    assert.deepEqual(migrated.filter((path) => printingModules.includes(path)), []);
    assert.deepEqual(migrated.filter((path) =>
        /console\.log|process\.stdout\.write/.test(readFileSync(join(source, path.slice(4)), "utf8"))), []);
});
