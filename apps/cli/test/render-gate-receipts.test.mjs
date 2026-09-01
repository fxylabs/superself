// The piped half of stage 2's render-gate case table (w-5emx6): cells 1, 3, 4,
// 5, 6, 7, 8 and 9. Stage 1's own table lives in render-gate.test.mjs and
// numbers its cells from one as well, so every name here says which stage it
// belongs to.
//
// What every cell asserts is the same thing: a write verb whose answer is a
// receipt now returns it and `output.ts` prints it, and the reader sees exactly
// the bytes they saw before the move — the announce line included, in the
// position it always held.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NO_OBJECTIVE_HINT } from "../dist/goals.js";
import { git, machine, must, personIn, selfIn } from "./harness.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const source = fileURLToPath(new URL("../src", import.meta.url));

const box = machine();
const ws = join(box.root, "ws");
const demo = join(ws, "demo");
mkdirSync(demo, { recursive: true });
await must(box, ws, ["init", "--git"]);
git(box, demo, ["init", "-q", "-b", "main"]);
await must(box, demo, ["project", "init", "--name", "demo", "--desc", "the receipt migration", "--no-connect"]);

// Since #286 the id is followed by what the unit could attach to. This project
// has no objective, so that is the one line `work propose` prints in the same
// situation — and the receipt itself is still the bare id on its own line,
// directly under the announce line, which is what this cell has always been
// about.
test("stage 2 cell 1: a piped `self work add` answers with the bare id, under the announce line", async () =>
{
    const answer = await personIn(box, demo, ["work", "add", "the receipts answer through the gate"]);
    assert.equal(answer.code, 0, answer.out);
    // The append prints two lines since #390 — the recorded line and the review
    // line under it — and the receipt is still the bare id directly under them.
    assert.match(answer.out,
        new RegExp(`^entity\\.confirmed recorded \\[[0-9abcdefghjkmnpqrstvwxyz]{26}\\]`
            + `\\n {2}w-[0-9abcdefghjkmnpqrstvwxyz]{5} the receipts answer through the gate`
            + ` — verify; wrong\\? self undo [0-9abcdefghjkmnpqrstvwxyz]{26}`
            + `\\nw-[0-9abcdefghjkmnpqrstvwxyz]{5}\\n${escaped(NO_OBJECTIVE_HINT)}\\n$`));
});

function escaped(text)
{
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The table calls this one `self project add`, which is the verb #251 removed;
// `self project init` is the registration it was replaced by, and it is the
// sentence receipt this stage moves.
test("stage 2 cell 3: a piped `self project init` answers with the sentence it always printed", async () =>
{
    const other = join(ws, "sentence");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    const answer = await selfIn(box, other, ["project", "init", "--name", "sentence", "--no-connect"]);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.out, "project \"sentence\" registered\n");
});

// A workspace store is a git repository, so it is a url `clone` can be given.
// The machine this runs on ends up pointing at the clone, which is why the cell
// gets a machine of its own.
test("stage 2 cell 4: a piped `self clone` answers with its three lines, in order", async () =>
{
    const cloneBox = machine();
    const store = join(cloneBox.root, "origin");
    const project = join(store, "app");
    mkdirSync(project, { recursive: true });
    await must(cloneBox, store, ["init", "--git"]);
    git(cloneBox, project, ["init", "-q", "-b", "main"]);
    await must(cloneBox, project, ["project", "init", "--name", "app", "--no-connect"]);
    const target = join(cloneBox.root, "copy");
    const answer = await selfIn(cloneBox, cloneBox.root, ["clone", join(store, ".superself"), target]);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.out, `workspace cloned into ${target}\n`
        + "registered projects: app\n"
        + "run `self project link <slug> --here` from each project to reconnect it — once per repository, not once per checkout\n");
});

// The disclosure is read and printed before the link is replaced; the recorded
// line is the answer that follows it. A link only discloses a replacement when
// the repository it recorded is gone, so the checkout is re-created under a
// different root commit — a different message, because two empty commits made
// in the same second under the same message are the same commit.
test("stage 2 cell 5: a piped `self project link` prints its disclosure before the recorded line", async () =>
{
    const moved = join(ws, "moved");
    mkdirSync(moved, { recursive: true });
    rootedRepository(moved, "the repository that was linked");
    await must(box, moved, ["project", "init", "--name", "moved", "--no-connect"]);
    rootedRepository(moved, "the repository standing there now");
    const answer = await selfIn(box, moved, ["project", "link", "moved", "--here"]);
    assert.equal(answer.code, 0, answer.out);
    // The CLI answers about the directory it resolved, so the expectation is
    // the resolved path: a scratch root on macOS is reached through a symlink.
    const at = realpathSync(moved);
    assert.equal(answer.out, `replacing the repository previously linked at ${at}\n`
        + `project "moved" linked to ${at}\n`);
});

function rootedRepository(dir, message)
{
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    git(box, dir, ["commit", "-q", "--allow-empty", "-m", message]);
}

// The receipt shape carries an optional next command, and this stage's verbs
// name none: the equality is what says the gate added no indented line under
// a receipt that never had one.
test("stage 2 cell 6: a piped `self connect` answers with one line and nothing under it", async () =>
{
    const answer = await selfIn(box, demo, ["connect"]);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.out,
        "managed block rendered into AGENTS.md, CLAUDE.md — commit them so every agent tool loads it\n");
});

test("stage 2 cell 7: on a machine with no workspace, `self init` answers with today's receipt", async () =>
{
    const bare = machine();
    const store = join(realpathSync(bare.root), ".superself");
    const answer = await selfIn(bare, bare.root, ["init", "--git"]);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.out, `workspace initialized at ${store} (views in "en")\n`);
    const again = await selfIn(bare, bare.root, ["init", "--git"]);
    assert.equal(again.out, `workspace already initialized at ${store}\n`);
});

// A refusal is composed before a handler has anything to answer with, so it
// never reaches the gate. Standing outside every checkout is where a migrated
// write verb has to prove that.
test("stage 2 cell 8: outside the project checkout, a migrated write verb refuses as it did", async () =>
{
    const outside = await personIn(box, box.root, ["work", "add", "a unit recorded from nowhere"]);
    assert.equal(outside.code, 1, outside.out);
    assert.equal(outside.out, "error: not inside a registered project — run `self project init` here to register it, "
        + "or `self project link <slug> --here` if it is a checkout of a project registered on another machine\n");
});

/* ── cell 9: the CLI surface stopped reaching into the render layer ── */

const RENDER_LAYER = ["output.ts", "pretty.ts", "reachability.ts", "view.ts", "views.ts"];

// Every module `contract.ts` reaches, at any depth and through any kind of
// import — a type-only one included, because the claim is that the declaration
// it names now lives below it rather than above.
function importClosure(entry)
{
    const seen = new Set();
    const pending = [entry];
    while (pending.length > 0)
    {
        const file = pending.pop();
        if (seen.has(file))
        {
            continue;
        }
        seen.add(file);
        for (const match of readFileSync(join(source, file), "utf8").matchAll(/from "\.\/([\w-]+)\.js"/g))
        {
            pending.push(`${match[1]}.ts`);
        }
    }
    return seen;
}

test("stage 2 cell 9: contract.ts reaches no module of the render layer", () =>
{
    const reached = importClosure("contract.ts");
    assert.deepEqual(RENDER_LAYER.filter((module) => reached.has(module)), []);
});

test("stage 2 cell 9: ARCHITECTURE.md no longer excuses the CLI surface with a type-only edge", () =>
{
    const architecture = readFileSync(join(repo, "ARCHITECTURE.md"), "utf8");
    assert.equal(architecture.includes("type-only"), false,
        "the exception the layering table carried for contract.ts is still written there");
});
