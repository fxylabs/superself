// Linking completes a half-finished registration (#257).
//
// `self project link` is the completion path the init duplicate-slug refusal
// names (#251 T1.7), and the shape it must complete is a registry row with no
// state directory behind it — what a crashed registration leaves. Every test
// below is one cell of the case table on issue #257, named by its cell id,
// and asserts that cell's stated outcome: the link succeeds whether or not
// the state directory or the `.self` marker already exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, machine, must } from "./harness.mjs";

// A machine holding an initialized workspace and nothing registered in it.
function workspace()
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    must(box, ws, ["init"]);
    return { box, ws };
}

// A git repository under the workspace directory, unregistered. The real path
// is what comes back: the CLI records the directory it ran in, and a temp
// root reached through a symlink is a different string for the same folder.
function folder(box, ws, name)
{
    const dir = join(ws, name);
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    return realpathSync(dir);
}

// The shape the defect arose from: a registry row exists, the store's
// projects/<slug> directory does not. Written through the store's own files,
// as T1.7 of the init suite builds it, because no verb leaves this shape on
// purpose — a crashed registration does.
function halfRegister(ws, slug)
{
    appendFileSync(join(ws, ".superself", "registry.jsonl"),
        JSON.stringify({ slug, added: new Date().toISOString() }) + "\n");
}

// What every cell's outcome is: the links row names the directory, the marker
// names the slug, and the fold completed — the state directory the fold
// writes into exists, and a read command answers from the linked checkout.
function assertLinked(box, ws, dir, slug, done)
{
    assert.match(done.out, new RegExp(`project "${slug}" linked to `));
    assert.ok(readFileSync(join(ws, ".superself", "links.jsonl"), "utf8").includes(dir), `no links row for ${dir}`);
    assert.equal(JSON.parse(readFileSync(join(dir, ".self"), "utf8")).project, slug);
    assert.ok(existsSync(join(ws, ".superself", "projects", slug)), "the fold left no state directory");
    assert.match(must(box, dir, ["status"]).out, new RegExp(`^${slug} `));
}

test("L1: link with no state directory and no marker links cleanly", () =>
{
    const { box, ws } = workspace();
    const dir = folder(box, ws, "ghost");
    halfRegister(ws, "ghost");
    const done = must(box, dir, ["project", "link", "ghost"]);
    assertLinked(box, ws, dir, "ghost", done);
});

test("L2: link with no state directory but a marker present relinks after a prior crash", () =>
{
    const { box, ws } = workspace();
    const dir = folder(box, ws, "ghost");
    halfRegister(ws, "ghost");
    // What the crashing link left behind (#257): the marker landed before the
    // fold died, so the retry starts from a directory already claiming the slug.
    writeFileSync(join(dir, ".self"), JSON.stringify({ project: "ghost" }) + "\n");
    const done = must(box, dir, ["project", "link", "ghost"]);
    assertLinked(box, ws, dir, "ghost", done);
});

test("L3: link with the state directory present and no marker links cleanly, as today", () =>
{
    const { box, ws } = workspace();
    const registered = folder(box, ws, "alpha");
    must(box, registered, ["project", "init", "--no-connect"]);
    const dir = folder(box, ws, join("elsewhere", "alpha"));
    const done = must(box, dir, ["project", "link", "alpha"]);
    assertLinked(box, ws, dir, "alpha", done);
});

test("L4: link with both present replaces the prior link when the repository differs, as today", () =>
{
    const { box, ws } = workspace();
    const dir = folder(box, ws, "alpha");
    // An identity to differ from: the link records the repository's root
    // commit, and a repository with no commits claims none.
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(box, dir, ["add", "."]);
    git(box, dir, ["commit", "-q", "-m", "one"]);
    must(box, dir, ["project", "init", "--no-connect"]);
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "b.txt"), "two\n");
    git(box, dir, ["add", "."]);
    git(box, dir, ["commit", "-q", "-m", "two"]);
    const done = must(box, dir, ["project", "link", "alpha"]);
    assert.ok(done.out.includes(`replacing the repository previously linked at ${dir}`),
        `the replacement line did not name ${dir}:\n${done.out}`);
    assertLinked(box, ws, dir, "alpha", done);
});
