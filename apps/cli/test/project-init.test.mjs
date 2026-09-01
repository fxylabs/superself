// Registering a project is one act, run where the project is (#251).
//
// Every test below is one cell of the case table on issue #251, named by its
// cell id, and asserts that cell's stated outcome. The rulings the table
// stands on:
//
//   A  `project init` registers the directory it runs in — no path positional
//      exists, so the name-vs-path mistake is unrepresentable
//   B  every validation runs before the first byte is written, so a refused
//      registration leaves the workspace exactly as it stood
//   C  `project add` is gone, and its one-pass refusal names both verbs that
//      replaced it
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { git, machine, must, selfIn } from "./harness.mjs";

// A machine holding an initialized workspace and nothing registered in it.
async function workspace()
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init", "--git"]);
    return { box, ws };
}

// A git repository under the workspace directory, unregistered. Registration
// identifies a project by its repository, so a scratch project that is not one
// answers questions no real project asks. The real path is what comes back:
// the CLI records the directory it ran in, and a temp root reached through a
// symlink is a different string for the same folder.
function folder(box, ws, name)
{
    const dir = join(ws, name);
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    return realpathSync(dir);
}

function storeFile(ws, name)
{
    const file = join(ws, ".superself", name);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// What a refused registration must leave untouched: the two files the crashing
// verb wrote before it validated anything.
function registration(ws)
{
    return { registry: storeFile(ws, "registry.jsonl"), links: storeFile(ws, "links.jsonl") };
}

function markerIn(dir)
{
    return JSON.parse(readFileSync(join(dir, ".self"), "utf8")).project;
}

/* ── T1 — self project init ────────────────────────────────────────── */

test("T1.1: init in an unregistered folder registers it and renders its block", async () =>
{
    const { box, ws } = await workspace();
    const dir = folder(box, ws, "alpha");
    const done = await must(box, dir, ["project", "init"]);
    assert.match(done.out, /project "alpha" registered/);
    assert.match(storeFile(ws, "registry.jsonl"), /"slug":"alpha"/);
    assert.ok(storeFile(ws, "links.jsonl").includes(dir), `no links row for ${dir}`);
    assert.equal(markerIn(dir), "alpha");
    assert.match(done.out, /managed block rendered into/);
    assert.ok(existsSync(join(dir, "AGENTS.md")), "AGENTS.md was not written");
    assert.ok(existsSync(join(dir, "CLAUDE.md")), "CLAUDE.md was not written");
});

test("T1.2: init in a folder already registered is refused with its slug", async () =>
{
    const { box, ws } = await workspace();
    const dir = folder(box, ws, "alpha");
    await must(box, dir, ["project", "init", "--no-connect"]);
    const before = registration(ws);
    const refused = await selfIn(box, dir, ["project", "init"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /already registered as project "alpha"/);
    assert.deepEqual(registration(ws), before);
});

test("T1.3: init with no workspace on the machine is refused, pointing at self init", async () =>
{
    const box = machine();
    const dir = join(box.root, "loose");
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    const refused = await selfIn(box, dir, ["project", "init"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /run `self init`/);
    assert.ok(!existsSync(join(dir, ".self")), "a machine with no workspace still wrote a marker");
});

test("T1.4: a slug held by another directory is refused, naming the holder and --name", async () =>
{
    const { box, ws } = await workspace();
    const held = folder(box, ws, join("held", "alpha"));
    await must(box, held, ["project", "init", "--no-connect"]);
    const dir = folder(box, ws, join("here", "alpha"));
    const before = registration(ws);
    const refused = await selfIn(box, dir, ["project", "init"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes(`project "alpha" is already registered at ${held}`),
        `the refusal did not name the holder ${held}:\n${refused.out}`);
    assert.match(refused.out, /self project init --name <slug>/);
    assert.deepEqual(registration(ws), before);
});

test("T1.5: --name registers the folder under that slug", async () =>
{
    const { box, ws } = await workspace();
    const dir = folder(box, ws, "beta");
    const done = await must(box, dir, ["project", "init", "--name", "other", "--no-connect"]);
    assert.match(done.out, /project "other" registered/);
    assert.match(storeFile(ws, "registry.jsonl"), /"slug":"other"/);
    assert.doesNotMatch(storeFile(ws, "registry.jsonl"), /"slug":"beta"/);
    assert.equal(markerIn(dir), "other");
});

test("T1.6: --no-connect registers the folder and writes no agent files", async () =>
{
    const { box, ws } = await workspace();
    const dir = folder(box, ws, "gamma");
    await must(box, dir, ["project", "init", "--no-connect"]);
    assert.match(storeFile(ws, "registry.jsonl"), /"slug":"gamma"/);
    assert.ok(!existsSync(join(dir, "AGENTS.md")), "--no-connect wrote AGENTS.md");
    assert.ok(!existsSync(join(dir, "CLAUDE.md")), "--no-connect wrote CLAUDE.md");
});

test("T1.7: a registry row whose marker was never written is refused, naming project link", async () =>
{
    const { box, ws } = await workspace();
    appendFileSync(join(ws, ".superself", "registry.jsonl"),
        JSON.stringify({ slug: "ghost", added: new Date().toISOString() }) + "\n");
    const dir = folder(box, ws, "ghost");
    const before = registration(ws);
    const refused = await selfIn(box, dir, ["project", "init"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /project "ghost" is already registered/);
    assert.match(refused.out, /self project link ghost/);
    assert.deepEqual(registration(ws), before);
});

test("T1.8: a path given to init is refused, and the folder is where it runs", async () =>
{
    const { box, ws } = await workspace();
    const dir = folder(box, ws, "delta");
    const before = registration(ws);
    const refused = await selfIn(box, dir, ["project", "init", "somepath"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /takes no path/);
    assert.match(refused.out, /run it inside "somepath"/);
    assert.deepEqual(registration(ws), before);
    assert.ok(!existsSync(join(dir, "somepath")), "the refused path was created");
});

/* ── T2 — project add removal ──────────────────────────────────────── */

test("T2.1: project add is refused in one pass naming init and link", async () =>
{
    const { box, ws } = await workspace();
    const dir = folder(box, ws, "epsilon");
    const before = registration(ws);
    for (const args of [["project", "add"], ["project", "add", "epsilon", "--name", "epsilon"]])
    {
        const refused = await selfIn(box, dir, args);
        assert.notEqual(refused.code, 0, `\`self ${args.join(" ")}\` was not refused`);
        assert.match(refused.out, /`self project add` is gone/);
        assert.match(refused.out, /self project init/);
        assert.match(refused.out, /self project link <slug>/);
    }
    assert.deepEqual(registration(ws), before);
    assert.ok(!existsSync(join(dir, ".self")), "a refused `project add` wrote a marker");
});

/* ── T3 — no write before validation ───────────────────────────────── */

test("T3.1: every refused init leaves registry.jsonl and links.jsonl byte-identical", async () =>
{
    const { box, ws } = await workspace();
    const registered = folder(box, ws, "zeta");
    await must(box, registered, ["project", "init", "--no-connect"]);
    appendFileSync(join(ws, ".superself", "registry.jsonl"),
        JSON.stringify({ slug: "ghost", added: new Date().toISOString() }) + "\n");
    const taken = folder(box, ws, join("elsewhere", "zeta"));
    const fresh = folder(box, ws, "eta");
    const refusals = [
        [registered, ["project", "init"]],
        [taken, ["project", "init"]],
        [fresh, ["project", "init", "--name", "ghost"]],
        [fresh, ["project", "init", "--name", "workspace"]],
        [fresh, ["project", "init", "somepath"]]
    ];
    const before = registration(ws);
    for (const [dir, args] of refusals)
    {
        const refused = await selfIn(box, dir, args);
        assert.notEqual(refused.code, 0, `\`self ${args.join(" ")}\` was not refused`);
        assert.deepEqual(registration(ws), before, `\`self ${args.join(" ")}\` changed the registration files`);
    }
});

/* ── T4 — guidance surfaces ────────────────────────────────────────── */

test("T4.1: connect in an unregistered folder names self project init", async () =>
{
    const { box, ws } = await workspace();
    const dir = folder(box, ws, "theta");
    const refused = await selfIn(box, dir, ["connect"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /run `self project init` here to register it/);
});

test("T4.2: the project help page documents the no-positional contract", async () =>
{
    const { box, ws } = await workspace();
    for (const args of [["project", "init", "--help"], ["project", "--help"]])
    {
        const page = (await must(box, ws, args)).out;
        assert.match(page, /project init \[--name s\] \[--desc d\] \[--no-connect\]/);
        assert.match(page, /`init` takes no path/);
        assert.doesNotMatch(page, /project add/);
    }
});
