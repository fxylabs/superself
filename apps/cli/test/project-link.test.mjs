// Linking completes a half-finished registration (#257), and reads unless
// told where to write (#332).
//
// `self project link <slug> --here` is the completion path the init
// duplicate-slug refusal names (#251 T1.7), and the shape it must complete is
// a registry row with no state directory behind it — what a crashed
// registration leaves. L1–L4 are the cells of the case table on issue #257;
// L5 onwards are the cells of docs/maintainers/case-tables/332-project-link.md,
// each named by its cell id and asserting that cell's stated outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, machine, must, selfIn, workIdIn } from "./harness.mjs";

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
    const done = must(box, dir, ["project", "link", "ghost", "--here"]);
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
    const done = must(box, dir, ["project", "link", "ghost", "--here"]);
    assertLinked(box, ws, dir, "ghost", done);
});

test("L3: link with the state directory present and no marker links cleanly, as today", () =>
{
    const { box, ws } = workspace();
    const registered = folder(box, ws, "alpha");
    must(box, registered, ["project", "init", "--no-connect"]);
    const dir = folder(box, ws, join("elsewhere", "alpha"));
    const done = must(box, dir, ["project", "link", "alpha", "--here"]);
    assertLinked(box, ws, dir, "alpha", done);
});

test("L4 (and L18): link with both present replaces the prior link when the repository differs, as today — no --force", () =>
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
    const done = must(box, dir, ["project", "link", "alpha", "--here"]);
    assert.ok(done.out.includes(`replacing the repository previously linked at ${dir}`),
        `the replacement line did not name ${dir}:\n${done.out}`);
    assertLinked(box, ws, dir, "alpha", done);
});

// ── #332: the read form, and the guarded write ─────────────────────────

const LINKS = (ws) => join(ws, ".superself", "links.jsonl");
const linksText = (ws) => existsSync(LINKS(ws)) ? readFileSync(LINKS(ws), "utf8") : "";
const headFile = (ws, slug) => join(ws, ".superself", "projects", slug, ".evidence-head.json");
const headStamp = (ws, slug) => existsSync(headFile(ws, slug)) ? statSync(headFile(ws, slug)).mtimeMs : null;
const verdicts = (ws, slug) => JSON.parse(readFileSync(join(ws, ".superself", "projects", slug, "evidence.json"), "utf8"));
const stateText = (ws, slug) => readFileSync(join(ws, ".superself", "projects", slug, "state.md"), "utf8");
const GONE = "history may have been rewritten";

function commit(box, dir, name)
{
    writeFileSync(join(dir, name), `${name}\n`);
    git(box, dir, ["add", "."]);
    git(box, dir, ["commit", "-q", "-m", name]);
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: box.env, encoding: "utf8" }).trim();
}

// A registered project `alpha` at a repository with one commit, plus a
// second, unrelated repository `beta` beside it that is not linked.
function registered()
{
    const { box, ws } = workspace();
    // Root commits named apart: two repositories made in the same second with
    // the same author, message and tree would share one, and read as one.
    const a = folder(box, ws, "alpha");
    commit(box, a, "alpha-root");
    must(box, a, ["project", "init", "--name", "alpha", "--no-connect"]);
    const b = folder(box, ws, "beta");
    commit(box, b, "beta-root");
    return { box, ws, a, b };
}

// A second working tree of `dir`'s repository, which nothing has linked.
function worktreeOf(box, dir, name)
{
    const at = join(dir, "..", name);
    git(box, dir, ["worktree", "add", "-q", at]);
    return realpathSync(at);
}

function assertUnchanged(ws, slug, before, after)
{
    assert.equal(after.links, before.links, "the ledger changed");
    assert.equal(after.head, before.head, "the project was refolded");
}

const snapshot = (ws, slug) => ({ links: linksText(ws), head: headStamp(ws, slug) });

test("L5: no arguments inside a linked checkout reads: slug, the path, marked as this directory, nothing written", () =>
{
    const { box, ws, a } = registered();
    const before = snapshot(ws, "alpha");
    const read = must(box, a, ["project", "link"]);
    assert.ok(read.out.includes('project "alpha" is linked on this machine to:'), read.out);
    assert.ok(read.out.includes(`${a}  (this directory)`), read.out);
    assert.ok(read.out.includes("1 linked path"), read.out);
    assertUnchanged(ws, "alpha", before, snapshot(ws, "alpha"));
});

test("L6: no arguments inside an unlinked worktree of the repository reads, and says this directory is not linked", () =>
{
    const { box, ws, a } = registered();
    const a2 = worktreeOf(box, a, "alpha2");
    const before = snapshot(ws, "alpha");
    const read = must(box, a2, ["project", "link"]);
    assert.ok(read.out.includes(`  ${a}\n`), read.out);
    assert.ok(read.out.includes("this directory is not linked — run `self project link alpha --here` to link it"), read.out);
    assertUnchanged(ws, "alpha", before, snapshot(ws, "alpha"));
});

test("L7: no arguments inside a different repository carrying the slug's marker reads and moves nothing (the incident)", () =>
{
    const { box, ws, a, b } = registered();
    writeFileSync(join(b, ".self"), JSON.stringify({ project: "alpha" }) + "\n");
    const before = snapshot(ws, "alpha");
    const read = must(box, b, ["project", "link"]);
    assert.ok(read.out.includes('project "alpha" is linked on this machine to:'), read.out);
    assert.ok(read.out.includes(`  ${a}\n`), read.out);
    assert.ok(read.out.includes("this directory is not linked"), read.out);
    assert.ok(!linksText(ws).includes(b), "the incident repeated: the ledger gained the directory it was read from");
    assertUnchanged(ws, "alpha", before, snapshot(ws, "alpha"));
});

test("L8: no arguments outside any project is refused, nothing written", () =>
{
    const { box, ws } = registered();
    const plain = join(ws, "plain");
    mkdirSync(plain);
    const before = linksText(ws);
    const read = selfIn(box, plain, ["project", "link"]);
    assert.notEqual(read.code, 0);
    assert.ok(read.out.includes("not inside a registered project"), read.out);
    assert.equal(linksText(ws), before);
});

test("L9: a slug with no linked path on this machine reads as such and names the write", () =>
{
    const { box, ws } = registered();
    halfRegister(ws, "ghost");
    const before = linksText(ws);
    const read = must(box, ws, ["project", "link", "ghost"]);
    assert.ok(read.out.includes('project "ghost" has no linked path on this machine — run `self project link ghost --here` from its checkout'), read.out);
    assert.equal(linksText(ws), before);
});

// L10 is L1: the write form with --here, from an unregistered checkout.

test("L11: a path already linked is a no-op write with the same receipt", () =>
{
    const { box, ws, a } = registered();
    const before = linksText(ws);
    const done = must(box, ws, ["project", "link", "alpha", a]);
    assert.ok(done.out.includes(`project "alpha" linked to ${a}`), done.out);
    assert.equal(linksText(ws), before);
});

test("L12: another worktree of a linked repository links without --force", () =>
{
    const { box, ws, a } = registered();
    const a2 = worktreeOf(box, a, "alpha2");
    const done = must(box, ws, ["project", "link", "alpha", a2]);
    assert.ok(done.out.includes(`project "alpha" linked to ${a2}`), done.out);
    assert.ok(!done.out.includes("was linked to"), done.out);
    assert.ok(linksText(ws).includes(a2));
});

test("L13: a different repository is refused without --force, nothing written", () =>
{
    const { box, ws, a, b } = registered();
    const before = snapshot(ws, "alpha");
    const refused = selfIn(box, ws, ["project", "link", "alpha", b]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes(`project "alpha" is linked to ${a}; "${b}" is a different repository — pass --force to link it as well`), refused.out);
    assert.ok(!existsSync(join(b, ".self")), "the marker landed in the refused directory");
    assertUnchanged(ws, "alpha", before, snapshot(ws, "alpha"));
});

test("L14: --force links the second repository, says old and new, and refolds the verdicts across both", () =>
{
    const { box, ws, a, b } = registered();
    const work = workIdIn(must(box, a, ["work", "add", "ship it"]).out);
    const hash = commit(box, b, "two");
    must(box, a, ["report", work, "done in beta", "--evidence", `commit:${hash}`]);
    assert.equal(verdicts(ws, "alpha")[hash], "unverifiable");
    assert.ok(stateText(ws, "alpha").includes(GONE));
    const done = must(box, ws, ["project", "link", "alpha", b, "--force"]);
    assert.ok(done.out.includes(`project "alpha" was linked to ${a}; now linked to ${a}, ${b}`), done.out);
    assert.ok(done.out.includes(`project "alpha" linked to ${b}`), done.out);
    assert.equal(verdicts(ws, "alpha")[hash], "settled");
    assert.ok(!stateText(ws, "alpha").includes(GONE), stateText(ws, "alpha"));
});

test("L15: with no link standing, a path links without --force", () =>
{
    const { box, ws, b } = registered();
    halfRegister(ws, "ghost");
    const done = must(box, ws, ["project", "link", "ghost", b]);
    assert.ok(done.out.includes(`project "ghost" linked to ${b}`), done.out);
    assert.ok(!done.out.includes("was linked to"), done.out);
});

test("L16: a folder holding repositories links with --force, and the fold judges through its children", () =>
{
    const { box, ws, a } = registered();
    const f = join(ws, "proj");
    const y = folder(box, ws, join("proj", "y"));
    const hash = commit(box, y, "y-root");
    const work = workIdIn(must(box, a, ["work", "add", "ship it"]).out);
    must(box, a, ["report", work, "done in y", "--evidence", `commit:${hash}`]);
    assert.equal(verdicts(ws, "alpha")[hash], "unverifiable");
    const refused = selfIn(box, ws, ["project", "link", "alpha", f]);
    assert.notEqual(refused.code, 0);
    const done = must(box, ws, ["project", "link", "alpha", f, "--force"]);
    assert.ok(done.out.includes(`now linked to ${a}, ${realpathSync(f)}`), done.out);
    assert.equal(verdicts(ws, "alpha")[hash], "settled");
});

test("L17: --force where nothing needs it is accepted with the same receipt", () =>
{
    const { box, ws, a, b } = registered();
    halfRegister(ws, "ghost");
    const fresh = must(box, ws, ["project", "link", "ghost", b, "--force"]);
    assert.ok(fresh.out.includes(`project "ghost" linked to ${b}`), fresh.out);
    const a2 = worktreeOf(box, a, "alpha2");
    const same = must(box, ws, ["project", "link", "alpha", a2, "--force"]);
    assert.ok(same.out.includes(`project "alpha" linked to ${a2}`), same.out);
    assert.ok(!same.out.includes("was linked to"), same.out);
});

test("L19: --force with nowhere to write is refused", () =>
{
    const { box, ws, a } = registered();
    const before = linksText(ws);
    const refused = selfIn(box, a, ["project", "link", "--force"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes("--force applies to a write — name the path to link, or pass --here"), refused.out);
    assert.equal(linksText(ws), before);
});

test("L20: a path and --here together are refused", () =>
{
    const { box, ws, a, b } = registered();
    const before = linksText(ws);
    const refused = selfIn(box, a, ["project", "link", "alpha", b, "--here"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes("project link takes one of <path> or --here"), refused.out);
    assert.equal(linksText(ws), before);
});

test("L21: the remedy the duplicate-init refusal prints links the checkout it is run in", () =>
{
    const { box, ws, a } = registered();
    const a2 = worktreeOf(box, a, "alpha2");
    const refused = selfIn(box, a2, ["project", "init", "--no-connect"]);
    assert.notEqual(refused.code, 0);
    const advertised = refused.out.match(/`self (project link alpha --here)`/);
    assert.ok(advertised !== null, refused.out);
    const done = must(box, a2, advertised[1].split(" "));
    assertLinked(box, ws, a2, "alpha", done);
});
