// The piped half of stage 4's render-gate case table (w-5emx6): cells 1, 2, 3,
// 5, 6, 7, 8, 9, 10, 11, 12, 14, 16 and 17, plus the pair contract every one of
// them rests on. Cells 4 and 13, and the terminal halves of 5 and 6, live in
// render-gate-tty.test.mjs, which has to load with a styled stdout to mean
// anything.
//
// What this stage moves is the pages — the context, the status roll-up, the
// `show` verbs, the setup diagnostics — behind the same gate the receipts and
// the listings already answer through. A page carries both of its renders as
// thunks and the gate calls one, so the cells below are about two things: the
// bytes did not move, and the render a run does not get is never composed.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, machine, must, selfIn, workIdIn } from "./harness.mjs";
import { diskTree, packageRoot, printSiteViolations } from "./structure.mjs";

const { renderOutput } = await import("../dist/output.js");
const { readScope, readScopes } = await import("../dist/paths.js");
const { contextOutput, statusOutput, workList } = await import("../dist/views.js");

const box = machine();
const ws = join(box.root, "ws");
const demo = join(ws, "demo");
const other = join(ws, "other");

// The scenario every cell reads: two registered projects, and in `demo` a goal,
// a proposal waiting on somebody, an objective with a checkpoint, three work
// units — one running under a process this machine can judge, one held by
// another session, one closed — and records at every exposure.
mkdirSync(demo, { recursive: true });
mkdirSync(other, { recursive: true });
await must(box, ws, ["init"]);
git(box, demo, ["init", "-q", "-b", "main"]);
git(box, other, ["init", "-q", "-b", "main"]);
await must(box, demo, ["project", "init", "--name", "demo", "--desc", "the document migration", "--no-connect"]);
await must(box, other, ["project", "init", "--name", "other", "--desc", "the second log", "--no-connect"]);

await must(box, demo, ["goal", "add", "every page answers through the gate"]);
await must(box, demo, ["convention", "add", "a handler never asks which render this run is"]);
await must(box, demo, ["decide", "the pages move in stage four", "--proposed"]);
await must(box, demo, ["state", "add", "a note the search surface finds", "--exposure", "search"]);
const objective = idOf((await must(box, demo, ["objective", "add", "the documents answer with blocks"])).out, "o");
const milestone = idOf((await must(box, demo, ["milestone", "add", "the pages carry both renders",
    "--objective", objective, "--exit", "no page prints for itself"])).out, "m");

const running = workIdIn((await must(box, demo, ["work", "add", "the context renders behind the gate"])).out);
await must(box, demo, ["work", "start", running]);
await must(box, demo, ["report", running, "the plain render runs the budget inside its own thunk"]);
await must(box, demo, ["work", "started", running, "--pid", String(process.pid)]);

const held = workIdIn((await must(box, demo, ["work", "add", "the show pages keep their lead lines"])).out);
await must(box, demo, ["work", "start", held], { SUPERSELF_SESSION: "another-session", SUPERSELF_SESSION_PID: String(process.pid) });
await must(box, demo, ["state", "place", held, "--scope", "other"]);

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

// A ruled render is the thing a piped run must never get, and every one of them
// is drawn out of these characters.
const RULED = /[┌┬┐├┼┤└┴┘│─]/;

/* ── the pair contract: exactly one render is composed ─────────────── */

// The probe the stage exists to make possible: a piped run may not so much as
// compose the terminal render. It measures the terminal, and there is nothing
// there to measure — which is the bug `resolveRender` was written against, and
// which a handler that resolved the mode itself could reintroduce one verb at
// a time. Each block's unwanted thunk is replaced with one that throws, so a
// gate that called both would fail here rather than in somebody's pipe.
const PAIRED = [
    ["self context", () => contextOutput(readScope(demo, {}))],
    ["self context from the workspace", () => contextOutput(readScope(ws, {}))],
    ["self status", () => statusOutput(readScope(demo, {}))],
    ["self status --workspace", () => statusOutput(readScope(box.root, { workspace: true }))],
    ["self work", () => workList(readScopes(demo, {})[0])]
];

function thrower(name)
{
    return () => { throw new Error(`${name} composed the render this run does not get`); };
}

/* ── scratch machines ──────────────────────────────────────────────── */

async function machineWithDemo()
{
    const own = machine();
    const root = join(own.root, "ws");
    const project = join(root, "demo");
    mkdirSync(project, { recursive: true });
    await must(own, root, ["init"]);
    git(own, project, ["init", "-q", "-b", "main"]);
    await must(own, project, ["project", "init", "--name", "demo", "--desc", "a scratch project", "--no-connect"]);
    return { box: own, ws: root, demo: project };
}

// Records that cannot all fit: three rules of 5,000 characters against a budget
// of 12,000, with the full-exposure cap raised so the adds are not what refuses.
async function budgetedWorkspace()
{
    const own = await machineWithDemo();
    const file = join(own.ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, fullTokens: 100_000, tokensPerCharacter: 0.25 }) + "\n");
    for (const name of ["one", "two", "three"])
    {
        await must(own.box, own.demo, ["convention", "add", `rule ${name} ${"x".repeat(5_000)}`]);
    }
    await must(own.box, own.demo, ["decide", "small enough to be omitted"]);
    return own;
}

async function archivedProject()
{
    const own = await machineWithDemo();
    await must(own.box, own.ws, ["project", "archive", "demo", "--why", "set aside for the quarter"]);
    return own;
}

// Twelve events on one record, which is two pages of ten. Placement is the
// transition a record can take again and again without leaving the live set.
async function pagedRecord()
{
    const own = await machineWithDemo();
    const id = idOf((await must(own.box, own.demo, ["state", "add", "a record placed again and again",
        "--exposure", "search"])).out, "e");
    for (let priority = 1; priority <= 11; priority++)
    {
        await must(own.box, own.demo, ["state", "place", id, "--priority", String(priority), "--exposure", "search"]);
    }
    return { ...own, id };
}

/* ── running the built modules against a scratch machine ───────────── */

// The block builders resolve their workspace from the environment, so a call
// made from this process has to stand where the scratch machine does. Same
// swap `approvedIn` makes, without the terminal: these cells are about which
// thunk runs, not about what a terminal looks like.
function inBox(cwd, run)
{
    const env = { ...process.env };
    const was = process.cwd();
    Object.assign(process.env, box.env);
    process.chdir(cwd);
    try
    {
        return run();
    }
    finally
    {
        process.chdir(was);
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, env);
    }
}

// What the gate said, and what it threw while saying it. A thunk that must not
// run throws, and the throw has to be reported rather than escaping through
// the interception and leaving `console.log` replaced.
function captured(run)
{
    const said = [];
    const thrown = [];
    const log = console.log;
    console.log = (...parts) => said.push(parts.join(" "));
    try
    {
        run();
    }
    catch (error)
    {
        thrown.push(error.message);
    }
    finally
    {
        console.log = log;
    }
    return { said, thrown };
}

/* ── the context page ──────────────────────────────────────────────── */

test("stage 4 cell 1: a piped `self context` is the markdown page, inside its budget", async () =>
{
    const printed = lines(await selfIn(box, demo, ["context"]));
    assert.equal(printed[0], "# demo");
    assert.ok(printed.includes("## Work in progress"), printed.join("\n"));
    assert.ok(printed.some((line) => line.startsWith(`- ${running} the context renders behind the gate`)));
    assert.ok(printed.includes("## Index"), "the index block did not render");
    assert.doesNotMatch(printed.join("\n"), RULED, "a piped context drew a table");
    // The budget the plain thunk spends: 3,000 tokens, which the shipped
    // estimate of a quarter token per character buys 12,000 characters of.
    assert.ok(Array.from(printed.join("\n")).length <= 12_000);
});

test("stage 4 cell 2: records past the budget leave counted omissions that name the way back", async () =>
{
    const own = await budgetedWorkspace();
    const printed = (await must(own.box, own.demo, ["context"])).out;
    assert.ok(Array.from(printed).length <= 12_000, `context ran past the budget: ${Array.from(printed).length}`);
    assert.match(printed, /- … \d+ full-exposure entit(y|ies) omitted; run `self state --project 'demo'`/);
    assert.match(printed, /- … 1 index row omitted; run `self state --project 'demo'`/);
});

test("stage 4 cell 3: an archived project says so first, then prints the page", async () =>
{
    const own = await archivedProject();
    const printed = lines(await must(own.box, own.demo, ["context"]));
    assert.match(printed[0], /^project "demo" is archived \(/);
    assert.equal(printed[1], "# demo");
});

test("stage 4 cell 5: a piped `self context` from the workspace is one line per project", async () =>
{
    const printed = lines(await selfIn(box, ws, ["context"]));
    assert.equal(printed.length, 2, printed.join("\n"));
    assert.match(printed[0], /^demo — every page answers through the gate \(\d+ active/);
    assert.match(printed[1], /^other — \(no goal\) \(/);
    assert.doesNotMatch(printed.join("\n"), RULED, "a piped workspace context drew a table");
});

/* ── the status roll-up ────────────────────────────────────────────── */

test("stage 4 cell 6: a piped `self status` keeps its roll-up lines and the processes under them", async () =>
{
    const printed = lines(await selfIn(box, demo, ["status"]));
    assert.equal(printed[0], "demo — goal: every page answers through the gate");
    assert.match(printed[1], /^work: \d+ active, /);
    assert.match(printed[2], /^objectives: /);
    assert.match(printed[3], /^waiting on you: [1-9]/);
    assert.match(printed[4], /^unshipped: /);
    assert.match(printed[5], /^decisions waiting: /);
    assert.match(printed[6], /^health: /);
    assert.equal(printed.at(-1), `process ${running}: running (pid ${process.pid})`);
});

test("stage 4 cell 7: `self status --workspace` from outside every project is the overview", async () =>
{
    const printed = lines(await selfIn(box, box.root, ["status", "--workspace"]));
    assert.equal(printed.length, 2, printed.join("\n"));
    assert.match(printed[0], /^demo — every page answers through the gate \(/);
    assert.match(printed[1], /^other — \(no goal\) \(/);
});

/* ── the show pages ────────────────────────────────────────────────── */

test("stage 4 cell 8: `self work show` prints the held and elsewhere lines before the body", async () =>
{
    const printed = lines(await selfIn(box, demo, ["work", "show", held]));
    assert.match(printed[0], /^held by another session, /);
    assert.equal(printed[1], `${held} renders in other; its record lives in demo`);
    assert.equal(printed[2], `# ${held} — the show pages keep their lead lines`);
});

test("stage 4 cell 9: a record past one page shows today's page and the pointer to the next", async () =>
{
    const own = await pagedRecord();
    const first = lines(await must(own.box, own.demo, ["state", "show", own.id, "--history"]));
    assert.equal(first[0], `${own.id}  live  12 events`);
    assert.equal(first.length, 12, first.join("\n"));
    assert.equal(first.at(-1),
        `… 2 more; run \`self state show ${own.id} --history --page 2 --project 'demo'\``);
    const second = lines(await must(own.box, own.demo, ["state", "show", own.id, "--history", "--page", "2"]));
    assert.equal(second.length, 3, second.join("\n"));
    // A page of events is a document, not a listing: the head already says how
    // many events there are, so nothing counts them again underneath.
    assert.doesNotMatch(second.at(-1), /^\d+ events?$/);
});

test("stage 4 cell 10: `objective show` and `milestone show` print their pages", async () =>
{
    const shown = lines(await selfIn(box, demo, ["objective", "show", objective]));
    assert.equal(shown[0], `# ${objective} — the documents answer with blocks`);
    assert.ok(shown.includes("## Exit criteria"), shown.join("\n"));
    const checkpoint = lines(await selfIn(box, demo, ["milestone", "show", milestone]));
    assert.equal(checkpoint[0], `# ${milestone} — the pages carry both renders`);
    assert.ok(checkpoint.includes(`- Objective: ${objective} the documents answer with blocks`), checkpoint.join("\n"));
});

/* ── the state listing, and the one line this stage adds ───────────── */

test("stage 4 cell 11: a piped `self state` prints its rows and then how many live records there are", async () =>
{
    const printed = lines(await selfIn(box, demo, ["state"]));
    const rows = printed.slice(0, -1);
    assert.ok(rows.length > 1, printed.join("\n"));
    assert.equal(printed.at(-1), `${rows.length} live entities`);
    assert.ok(rows.every((row) => /^\S+ {2}\S/.test(row)), rows.join("\n"));
});

test("stage 4 cell 11: one live record is counted in the singular", async () =>
{
    const own = await machineWithDemo();
    await must(own.box, own.demo, ["decide", "the only record here"]);
    assert.equal(lines(await must(own.box, own.demo, ["state"])).at(-1), "1 live entity");
});

test("stage 4 cell 12: a project with nothing live keeps its wording and gains no size line", async () =>
{
    const own = await machineWithDemo();
    assert.deepEqual(lines(await must(own.box, own.demo, ["state"])), ["no live entities"]);
});

/* ── the diagnostics that must work where nothing is set up ────────── */

test("stage 4 cell 14: `self setup` answers on a machine with no workspace at all", async () =>
{
    const bare = machine();
    assert.deepEqual(lines(await selfIn(bare, bare.root, ["setup"])), [
        "project    (none) — this directory is not registered; run `self project init`",
        "workspace  (none) — run `self init` or `self workspace <path>`"
    ]);
});

/* ── the refusal the flags owe ─────────────────────────────────────── */

test("stage 4 cell 17: `--pretty --plain` together is refused in the same words on every page", async () =>
{
    for (const args of [["context"], ["status"], ["work"]])
    {
        const refused = await selfIn(box, demo, [...args, "--pretty", "--plain"]);
        assert.notEqual(refused.code, 0, args.join(" "));
        assert.match(refused.out,
            /--pretty and --plain ask for different renders — pass one of them, or neither/, args.join(" "));
    }
});

test("the gate composes the plain render alone on a piped run", () =>
{
    for (const [name, build] of PAIRED)
    {
        const blocks = inBox(demo, build).map((block) => ({ ...block, pretty: thrower(name) }));
        assert.deepEqual(inBox(demo, () => captured(() => renderOutput(blocks, { plain: true }))).thrown, [], name);
    }
});

test("the gate composes the terminal render alone on a styled run, so the budget is never spent", () =>
{
    for (const [name, build] of PAIRED)
    {
        const blocks = inBox(demo, build).filter((block) => block.pretty !== undefined)
            .map((block) => ({ ...block, plain: thrower(name) }));
        assert.notEqual(blocks.length, 0, `${name} declares no terminal render`);
        assert.deepEqual(inBox(demo, () => captured(() => renderOutput(blocks, { pretty: true }))).thrown, [], name);
    }
});

/* ── the fixture, and the tree the migration leaves ────────────────── */

// The committed sweep is what a reader of a piped run sees, recorded. Every
// page this stage moved is asked in it and its bytes did not move; the one
// section that changed is the state listing, which now ends with its size.
test("stage 4 cell 15: the state listing in the committed sweep ends with the size it states", () =>
{
    const fixture = fileURLToPath(new URL("fixtures/golden/piped.txt", import.meta.url));
    const sections = readFileSync(fixture, "utf8").split(/\n(?=\$ self )/);
    const listing = sections.filter((section) => section.startsWith("$ self state   (in project, exit 0)\n")).at(-1);
    assert.notEqual(listing, undefined, "`self state` is not in the sweep");
    assert.match(listing.replace(/\n+$/, "").split("\n").at(-1), /^\d+ live entities$/);
});

// The cell as stage 4 left it read the ratchet's two remaining entries by
// name. Stage 5 took both off and emptied the list, so what survives of the
// cell is the half that was always the point: nothing in the tree prints
// outside the gate. The empty list itself is stage 5's cell 11.
test("stage 4 cell 16: nothing in the tree prints outside the gate", () =>
{
    assert.deepEqual(printSiteViolations(diskTree(packageRoot)), []);
});
