// A report's evidence is the HEAD of the checkout the command ran in (#235).
//
// Every test below is one cell of the case table in
// docs/maintainers/case-tables/235-worktree-evidence.md, named by its cell id,
// and asserts that cell's stated outcome: which commit and branch the report
// stamped, and where resolution placed the project. The `.self` marker is
// git-excluded, so a worktree made inside a registered checkout carries none
// and resolution used to walk past it to the parent's marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutBetween } from "../dist/paths.js";
import { git, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

function gitOut(box, cwd, args)
{
    return execFileSync("git", args, { cwd, env: box.env, encoding: "utf8" }).trim();
}

function commit(box, dir, name)
{
    writeFileSync(join(dir, name), `${name}\n`);
    git(box, dir, ["add", "."]);
    git(box, dir, ["commit", "-q", "-m", name]);
}

const head = (box, dir) => gitOut(box, dir, ["rev-parse", "--short=12", "HEAD"]);
const branch = (box, dir) => gitOut(box, dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

function repository(box, dir)
{
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    commit(box, dir, "root");
    return realpathSync(dir);
}

// The floor state: a workspace at <root>/ws holding project `demo` registered
// at the root of the repository <ws>/demo, one commit on main.
async function registered()
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init", "--git"]);
    const repo = repository(box, join(ws, "demo"));
    await must(box, repo, ["project", "init", "--name", "demo", "--no-connect"]);
    return { box, ws, repo };
}

// A second working tree of the repository, made **inside** it, where the
// delegated implementation pipeline puts one. It carries no `.self`: the
// marker is git-excluded, so nothing copies it across.
function nested(box, repo, args = ["-b", "feature"])
{
    const at = join(repo, ".claude", "worktrees", "a1");
    git(box, repo, ["worktree", "add", "-q", ...args, at]);
    commit(box, at, "worktree-work");
    return realpathSync(at);
}

// A second working tree made beside the checkout — the shape that already
// recorded its own HEAD before this fix.
function beside(box, ws, repo)
{
    const at = join(ws, "a2");
    git(box, repo, ["worktree", "add", "-q", "-b", "feature2", at]);
    commit(box, at, "beside-work");
    return realpathSync(at);
}

function subdirectory(dir, name)
{
    const at = join(dir, name);
    mkdirSync(at, { recursive: true });
    return at;
}

async function work(box, cwd)
{
    return workIdIn((await mustPerson(box, cwd, ["work", "add", "ship it"])).out);
}

// What the last recorded report stamped. `refs.commits[0]` is the evidence
// commit `self report` attached on its own, `refs.branch` the branch stamped
// with it.
function reportedRefs(ws, slug = "demo")
{
    const log = readFileSync(join(ws, ".superself", "projects", slug, "log.jsonl"), "utf8");
    const events = log.trim().split("\n").map((line) => JSON.parse(line));
    const added = events.filter((event) => event.type === "report.added").pop();
    assert.ok(added !== undefined, "no report was recorded");
    return added.refs ?? {};
}

// Both halves of one cell's outcome: the commit the report attached and the
// branch it stamped are the checkout the command ran in.
function assertEvidence(box, ws, at, note)
{
    const refs = reportedRefs(ws);
    assert.deepEqual(refs.commits, [head(box, at)], note);
    assert.equal(refs.branch, branch(box, at), note);
}

// The ledger is append-only and a prune is a recorded entry, so #308's state
// is reproduced by writing the entry `pruneDeadLinks` would have written.
function pruneLinks(ws, slug, path)
{
    appendFileSync(join(ws, ".superself", "links.jsonl"),
        JSON.stringify({ slug, path, pruned: new Date().toISOString(), why: "path no longer exists" }) + "\n");
}

test("W1: a report from the registered checkout records its HEAD and branch", async () =>
{
    const { box, ws, repo } = await registered();
    await must(box, repo, ["report", await work(box, repo), "did the thing"]);
    assertEvidence(box, ws, repo, "the plain checkout stopped recording its own HEAD");
});

test("W2: a report from a subdirectory of the checkout records the same", async () =>
{
    const { box, ws, repo } = await registered();
    const id = await work(box, repo);
    await must(box, subdirectory(repo, "src"), ["report", id, "did the thing"]);
    assertEvidence(box, ws, repo, "a subdirectory answered for something other than its checkout");
});

test("W3: a report from a worktree nested inside the checkout records the worktree's HEAD", async () =>
{
    const { box, ws, repo } = await registered();
    const at = nested(box, repo);
    const id = await work(box, repo);
    await must(box, at, ["report", id, "did the thing"]);
    assert.notEqual(head(box, at), head(box, repo), "the fixture put both checkouts on one commit");
    assertEvidence(box, ws, at, "the report was evidenced by the parent checkout's commit (#235)");
});

test("W4: a report from a subdirectory of that worktree records the same", async () =>
{
    const { box, ws, repo } = await registered();
    const at = nested(box, repo);
    const id = await work(box, repo);
    await must(box, subdirectory(at, "src"), ["report", id, "did the thing"]);
    assertEvidence(box, ws, at, "a subdirectory of the worktree answered for the parent");
});

test("W5: a worktree beside the checkout keeps recording its own HEAD", async () =>
{
    const { box, ws, repo } = await registered();
    const at = beside(box, ws, repo);
    const id = await work(box, repo);
    await must(box, at, ["report", id, "did the thing"]);
    assertEvidence(box, ws, at, "the case that already worked regressed");
});

test("W6: a project registered at a subdirectory maps into the nested worktree", async () =>
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init", "--git"]);
    const repo = repository(box, join(ws, "demo"));
    const foo = subdirectory(repo, join("apps", "foo"));
    commit(box, repo, join("apps", "foo", "keep"));
    await must(box, foo, ["project", "init", "--name", "demo", "--no-connect"]);
    const at = nested(box, repo);
    const id = await work(box, foo);
    await must(box, join(at, "apps", "foo"), ["report", id, "did the thing"]);
    assertEvidence(box, ws, at, "a subdirectory registration stopped mapping into the worktree");
});

test("W7: a nested worktree without the registered subdirectory refuses instead of guessing", async () =>
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init", "--git"]);
    const repo = repository(box, join(ws, "demo"));
    const bare = gitOut(box, repo, ["rev-parse", "HEAD"]);
    const foo = subdirectory(repo, join("apps", "foo"));
    commit(box, repo, join("apps", "foo", "keep"));
    await must(box, foo, ["project", "init", "--name", "demo", "--no-connect"]);
    const at = join(repo, ".claude", "worktrees", "a1");
    git(box, repo, ["worktree", "add", "-q", "-b", "feature", at, bare]);
    assert.ok(!existsSync(join(at, "apps", "foo")), "the fixture put the registered directory on that branch after all");
    const refused = await selfIn(box, at, ["report", await work(box, foo), "did the thing"]);
    assert.notEqual(refused.code, 0, refused.out);
    assert.ok(refused.out.includes(join(at, "apps", "foo")), refused.out);
});

test("W8: a pruned link still resolves the nested worktree through its marker", async () =>
{
    const { box, ws, repo } = await registered();
    const at = nested(box, repo);
    const id = await work(box, repo);
    pruneLinks(ws, "demo", repo);
    await must(box, at, ["report", id, "did the thing"]);
    assertEvidence(box, ws, at, "a pruned ledger lost the worktree the command stood in");
});

test("W9: a nested unrelated repository still answers to the marker above it", async () =>
{
    const { box, ws, repo } = await registered();
    const vendor = repository(box, join(repo, "vendor", "lib"));
    const id = await work(box, repo);
    await must(box, vendor, ["report", id, "did the thing"]);
    assertEvidence(box, ws, repo, "an unrelated nested repository took the marker away");
});

test("W10: a submodule still answers to the marker above it", async () =>
{
    const { box, ws, repo } = await registered();
    const source = repository(box, join(box.root, "subsrc"));
    git(box, repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub"]);
    commit(box, repo, "added-submodule");
    const id = await work(box, repo);
    await must(box, join(repo, "sub"), ["report", id, "did the thing"]);
    assertEvidence(box, ws, repo, "a submodule took the marker away");
});

test("W11: a registered directory that is no repository records no commit", async () =>
{
    const box = machine();
    const ws = join(box.root, "ws");
    const plain = join(ws, "plain");
    mkdirSync(plain, { recursive: true });
    await must(box, ws, ["init", "--git"]);
    await must(box, plain, ["project", "init", "--name", "plain", "--no-connect"]);
    await must(box, plain, ["report", await work(box, plain), "did the thing"]);
    const refs = reportedRefs(ws, "plain");
    assert.equal(refs.commits, undefined, JSON.stringify(refs));
    assert.equal(refs.branch, undefined, JSON.stringify(refs));
});

test("W12: a detached HEAD in a nested worktree records the commit and no branch", async () =>
{
    const { box, ws, repo } = await registered();
    const at = nested(box, repo, ["--detach"]);
    const id = await work(box, repo);
    await must(box, at, ["report", id, "did the thing"]);
    const refs = reportedRefs(ws);
    assert.deepEqual(refs.commits, [head(box, at)], "the detached worktree's commit was not the evidence");
    assert.equal(refs.branch, undefined, "a detached HEAD stamped a branch");
});

test("W13: reads from a nested worktree answer for the same project", async () =>
{
    const { box, ws, repo } = await registered();
    const at = nested(box, repo);
    const id = await work(box, repo);
    assert.equal((await must(box, at, ["work", "--plain"])).out, (await must(box, repo, ["work", "--plain"])).out);
    assert.ok((await must(box, at, ["work", "show", id])).out.includes("ship it"));
    assert.ok((await must(box, at, ["status", "--plain"])).out.includes("demo"));
});

test("W14: project init inside a nested worktree is refused as another checkout", async () =>
{
    const { box, repo } = await registered();
    const at = nested(box, repo);
    const refused = await selfIn(box, at, ["project", "init", "--name", "demo2", "--no-connect"]);
    assert.notEqual(refused.code, 0, refused.out);
    assert.ok(refused.out.includes("demo"), refused.out);
});

test("W15: work show names the worktree's commit and branch", async () =>
{
    const { box, repo } = await registered();
    const at = nested(box, repo);
    const id = await work(box, repo);
    await must(box, at, ["report", id, "did the thing"]);
    const shown = (await must(box, repo, ["work", "show", id])).out;
    assert.ok(shown.includes(head(box, at)), shown);
    assert.ok(!shown.includes(head(box, repo)), shown);
    assert.ok(shown.includes("feature"), shown);
});

test("W16: a pruned link leaves the plain checkout untouched", async () =>
{
    const { box, ws, repo } = await registered();
    const id = await work(box, repo);
    pruneLinks(ws, "demo", repo);
    await must(box, repo, ["report", id, "did the thing"]);
    assertEvidence(box, ws, repo, "pruning the ledger moved where the plain checkout resolves");
});

test("W17: a worktree carrying its own marker answers to it", async () =>
{
    const { box, ws, repo } = await registered();
    const at = nested(box, repo);
    await must(box, at, ["project", "link", "demo", "--here"]);
    assert.ok(existsSync(join(at, ".self")), "the worktree got no marker of its own");
    const id = await work(box, repo);
    await must(box, at, ["report", id, "did the thing"]);
    assertEvidence(box, ws, at, "a worktree's own marker stopped governing it");
});

test("W18: work done accepts the evidence recorded from the worktree", async () =>
{
    const { box, ws, repo } = await registered();
    const at = nested(box, repo);
    const id = await work(box, repo);
    await must(box, at, ["work", "start", id]);
    await must(box, at, ["report", id, "did the thing"]);
    await must(box, at, ["work", "done", id]);
    assertEvidence(box, ws, at, "the gate closed on a commit that is not the worktree's");
});

test("W19: connect writes the managed block into the worktree it ran in", async () =>
{
    const { box, repo } = await registered();
    const at = nested(box, repo);
    await must(box, at, ["connect"]);
    assert.ok(existsSync(join(at, "AGENTS.md")), "the worktree got no managed block");
    assert.ok(!existsSync(join(repo, "AGENTS.md")), "the parent checkout was written to instead");
});

test("W20: setup explains the worktree it stands in, and the parent as before", async () =>
{
    const { box, repo } = await registered();
    const at = nested(box, repo);
    const inside = (await must(box, at, ["setup"])).out;
    assert.ok(inside.includes(`${at} (via this repository)`), inside);
    assert.ok(!inside.includes(`${repo} (via .self)`), inside);
    assert.ok((await must(box, repo, ["setup"])).out.includes(`${repo} (via .self)`));
});

test("checkoutBetween: a .git between here and the marker is the boundary, and nothing else is", async () =>
{
    const { box, ws, repo } = await registered();
    const at = nested(box, repo);
    assert.equal(checkoutBetween(subdirectory(repo, "src"), repo), null, "a plain subdirectory read as a boundary");
    assert.equal(checkoutBetween(repo, repo), null, "the marker's own directory read as a boundary");
    assert.equal(checkoutBetween(subdirectory(at, "src"), repo), at, "the nested worktree was not seen");
    assert.equal(checkoutBetween(subdirectory(at, "src"), at), null, "a worktree carrying the marker read as a boundary");
    assert.ok(existsSync(join(ws, ".superself")), "the fixture never built a workspace");
});
