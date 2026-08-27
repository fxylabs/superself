// `self project unlink` detaches a registered checkout path from this machine
// (#263). Every test below is one cell of
// docs/maintainers/case-tables/263-project-unlink.md, named by its cell id and
// asserting that cell's stated outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, machine, must, selfIn, workIdIn } from "./harness.mjs";

const STORE = (ws) => join(ws, ".superself");
const LINKS = (ws) => join(STORE(ws), "links.jsonl");
const linksText = (ws) => existsSync(LINKS(ws)) ? readFileSync(LINKS(ws), "utf8") : "";
const marker = (dir) => join(dir, ".self");
const headFile = (ws, slug) => join(STORE(ws), "projects", slug, ".evidence-head.json");
const headStamp = (ws, slug) => existsSync(headFile(ws, slug)) ? statSync(headFile(ws, slug)).mtimeMs : null;
const verdicts = (ws, slug) => JSON.parse(readFileSync(join(STORE(ws), "projects", slug, "evidence.json"), "utf8"));
const stateText = (ws, slug) => readFileSync(join(STORE(ws), "projects", slug, "state.md"), "utf8");
const GONE = "history may have been rewritten";

async function workspace()
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init"]);
    return { box, ws };
}

// A git repository under `at`, unregistered, with one commit named apart from
// its neighbours: two repositories made in the same second with the same
// author, message and tree would share a root commit and read as one.
function folder(box, at, name)
{
    const dir = join(at, name);
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    const real = realpathSync(dir);
    commit(box, real, `${name.replace(/[\\/]/g, "-")}-root`);
    return real;
}

function commit(box, dir, name)
{
    writeFileSync(join(dir, name), `${name}\n`);
    git(box, dir, ["add", "."]);
    git(box, dir, ["commit", "-q", "-m", name]);
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: box.env, encoding: "utf8" }).trim();
}

// The shape a crashed registration leaves: a registry row with no state
// directory behind it. The only way to have a registered slug with nothing
// linked to it.
function halfRegister(ws, slug)
{
    appendFileSync(join(STORE(ws), "registry.jsonl"),
        JSON.stringify({ slug, added: new Date().toISOString() }) + "\n");
}

// `alpha` registered at repository A, with a second repository B linked to it
// as well — the two-path state most cells start from.
async function twoLinked()
{
    const { box, ws } = await workspace();
    const a = folder(box, ws, "alpha");
    await must(box, a, ["project", "init", "--name", "alpha", "--no-connect"]);
    const b = folder(box, ws, "beta");
    await must(box, ws, ["project", "link", "alpha", b, "--force"]);
    return { box, ws, a, b };
}

// `alpha` registered at A and nothing else linked to it.
async function oneLinked()
{
    const { box, ws } = await workspace();
    const a = folder(box, ws, "alpha");
    await must(box, a, ["project", "init", "--name", "alpha", "--no-connect"]);
    return { box, ws, a };
}

// A second working tree of `dir`'s repository, which nothing has linked.
function worktreeOf(box, dir, name)
{
    const at = join(dir, "..", name);
    git(box, dir, ["worktree", "add", "-q", at]);
    return realpathSync(at);
}

const snapshot = (ws, slug) => ({ links: linksText(ws), head: headStamp(ws, slug) });

function assertUnchanged(ws, slug, before)
{
    const after = snapshot(ws, slug);
    assert.equal(after.links, before.links, "the ledger changed");
    assert.equal(after.head, before.head, "the project was refolded");
}

// What a detachment leaves in the ledger: a prune entry naming the path and
// why it went, appended rather than written over the line that linked it.
function assertPruned(ws, slug, path)
{
    const rows = linksText(ws).trim().split("\n").map((line) => JSON.parse(line));
    const last = rows[rows.length - 1];
    assert.deepEqual({ slug: last.slug, path: last.path, why: last.why }, { slug, path, why: "unlinked" });
    assert.ok(rows.some((row) => row.path === path && row.pruned === undefined), "the line that linked it was rewritten");
}

test("U1: an explicit path is detached, the marker goes with it, and the listing says what is left", async () =>
{
    const { box, ws, a, b } = await twoLinked();
    const done = await must(box, ws, ["project", "unlink", "alpha", b]);
    assert.ok(done.out.includes(`project "alpha" unlinked from ${b} — its .self marker there is gone too`), done.out);
    assert.ok(done.out.includes(`  ${a}\n`), done.out);
    assert.ok(!done.out.includes(`  ${b}\n`), done.out);
    assert.ok(done.out.includes("1 linked path"), done.out);
    assertPruned(ws, "alpha", b);
    assert.ok(!existsSync(marker(b)), "the marker stayed");
    assert.match((await must(box, ws, ["project", "link", "alpha"])).out, /1 linked path/);
});

test("U2: --here detaches the checkout it runs in, and the listing says this directory is not linked", async () =>
{
    const { box, ws, a, b } = await twoLinked();
    const done = await must(box, b, ["project", "unlink", "alpha", "--here"]);
    assert.ok(done.out.includes(`project "alpha" unlinked from ${b}`), done.out);
    assert.ok(done.out.includes(`  ${a}\n`), done.out);
    assert.ok(done.out.includes("this directory is not linked — run `self project link alpha --here` to link it"), done.out);
    assertPruned(ws, "alpha", b);
});

test("U3: run from another checkout of the same project, the listing marks that one as this directory", async () =>
{
    const { box, ws, a, b } = await twoLinked();
    const done = await must(box, a, ["project", "unlink", "alpha", b]);
    assert.ok(done.out.includes(`${a}  (this directory)`), done.out);
    assertPruned(ws, "alpha", b);
});

test("U4: the last standing path is refused without --force, and nothing is written", async () =>
{
    const { box, ws, a } = await oneLinked();
    const before = snapshot(ws, "alpha");
    const refused = await selfIn(box, ws, ["project", "unlink", "alpha", a]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes(`"${a}" is the only checkout of "alpha" on this machine`), refused.out);
    assert.ok(refused.out.includes("pass --force to detach it anyway"), refused.out);
    assert.ok(existsSync(marker(a)), "the marker was removed by a refused command");
    assertUnchanged(ws, "alpha", before);
});

test("U5: --force detaches the last standing path, says so first, and leaves the project registered", async () =>
{
    const { box, ws, a } = await oneLinked();
    const done = await must(box, ws, ["project", "unlink", "alpha", a, "--force"]);
    assert.ok(done.out.includes(`project "alpha" had one checkout on this machine (${a}); after this it has none`), done.out);
    assert.ok(done.out.includes('project "alpha" has no linked path on this machine — run `self project link alpha --here` from its checkout'), done.out);
    assertPruned(ws, "alpha", a);
    // The project record stands: the slug is still registered and still reads
    // through the workspace. What is gone is the checkout answering for it —
    // a write in A no longer finds the project it used to record into.
    assert.match((await must(box, ws, ["project"])).out, /^alpha/m);
    assert.match((await must(box, a, ["status"])).out, /alpha/);
    const orphan = await selfIn(box, a, ["work", "add", "something"]);
    assert.notEqual(orphan.code, 0);
    assert.ok(orphan.out.includes("not inside a registered project"), orphan.out);
});

test("U6: a path whose checkout is gone is detached, with no --force and no marker to remove", async () =>
{
    const { box, ws } = await workspace();
    const b = folder(box, ws, "beta");
    await must(box, b, ["project", "init", "--name", "alpha", "--no-connect"]);
    rmSync(b, { recursive: true, force: true });
    const done = await must(box, ws, ["project", "unlink", "alpha", b]);
    assert.ok(done.out.includes(`project "alpha" unlinked from ${b}`), done.out);
    assert.ok(!done.out.includes("marker there is gone"), done.out);
    assert.ok(!done.out.includes("--force"), done.out);
    assert.ok(done.out.includes('project "alpha" has no linked path on this machine'), done.out);
    assertPruned(ws, "alpha", b);
});

test("U7: a path no project links is refused, naming what the slug does hold", async () =>
{
    const { box, ws, a } = await oneLinked();
    const c = folder(box, ws, "gamma");
    const before = snapshot(ws, "alpha");
    const refused = await selfIn(box, ws, ["project", "unlink", "alpha", c]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes(`"${c}" is not a linked path of project "alpha", which is linked to ${a}`), refused.out);
    assertUnchanged(ws, "alpha", before);
});

test("U8: a path linked to another project is refused, naming that project and the command that detaches it", async () =>
{
    const { box, ws } = await workspace();
    const a = folder(box, ws, "alpha");
    await must(box, a, ["project", "init", "--name", "alpha", "--no-connect"]);
    const b = folder(box, ws, "beta");
    await must(box, b, ["project", "init", "--name", "beta", "--no-connect"]);
    const before = snapshot(ws, "alpha");
    const refused = await selfIn(box, ws, ["project", "unlink", "alpha", b]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes(`"${b}" is linked to project "beta", not "alpha" — run \`self project unlink beta ${b}\``), refused.out);
    assert.ok(existsSync(marker(b)), "beta's marker was removed");
    assertUnchanged(ws, "alpha", before);
    // The refusal it printed is the command that works.
    const done = await must(box, ws, ["project", "unlink", "beta", b, "--force"]);
    assert.ok(done.out.includes(`project "beta" unlinked from ${b}`), done.out);
});

test("U9: neither a path nor --here is refused, and names the listing that answers what may be detached", async () =>
{
    const { box, ws, a } = await oneLinked();
    const before = snapshot(ws, "alpha");
    const refused = await selfIn(box, ws, ["project", "unlink", "alpha"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes("project unlink takes the path to detach — name it, or pass --here to detach this directory"), refused.out);
    const advertised = refused.out.match(/`self (project link alpha)`/);
    assert.ok(advertised !== null, refused.out);
    assert.ok((await must(box, ws, advertised[1].split(" "))).out.includes(`  ${a}\n`), "the advertised listing did not answer");
    assertUnchanged(ws, "alpha", before);
});

test("U10: --force with no path and no --here falls into the same refusal", async () =>
{
    const { box, ws } = await oneLinked();
    const before = snapshot(ws, "alpha");
    const refused = await selfIn(box, ws, ["project", "unlink", "alpha", "--force"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes("project unlink takes the path to detach"), refused.out);
    assertUnchanged(ws, "alpha", before);
});

test("U11: a path and --here together are refused", async () =>
{
    const { box, ws, a } = await oneLinked();
    const before = snapshot(ws, "alpha");
    const refused = await selfIn(box, ws, ["project", "unlink", "alpha", a, "--here"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes("project unlink takes one of <path> or --here"), refused.out);
    assertUnchanged(ws, "alpha", before);
});

test("U12: with no slug, --here infers it the way every read verb does", async () =>
{
    const { box, ws, a, b } = await twoLinked();
    const done = await must(box, b, ["project", "unlink", "--here"]);
    assert.ok(done.out.includes(`project "alpha" unlinked from ${b}`), done.out);
    assert.ok(done.out.includes(`  ${a}\n`), done.out);
    assertPruned(ws, "alpha", b);
});

test("U13: with no slug, outside any project, the inference is refused", async () =>
{
    const { box, ws } = await oneLinked();
    const out = join(box.root, "out");
    mkdirSync(out, { recursive: true });
    const before = snapshot(ws, "alpha");
    const refused = await selfIn(box, out, ["project", "unlink", "--here"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes("not inside a registered project"), refused.out);
    assertUnchanged(ws, "alpha", before);
});

test("U14: --here where no linked path contains this directory is refused, naming the linked paths", async () =>
{
    const { box, ws, a } = await oneLinked();
    const before = snapshot(ws, "alpha");
    const refused = await selfIn(box, ws, ["project", "unlink", "alpha", "--here"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes(`this directory is not a linked path of "alpha" — it is linked to ${a}; name the path to detach`), refused.out);
    assertUnchanged(ws, "alpha", before);
});

test("U15: a registered slug with nothing linked to it says so", async () =>
{
    const { box, ws, a } = await oneLinked();
    halfRegister(ws, "ghost");
    const refused = await selfIn(box, ws, ["project", "unlink", "ghost", a]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes(`"${a}" is linked to project "alpha", not "ghost"`), refused.out);
    const elsewhere = await selfIn(box, ws, ["project", "unlink", "ghost", ws]);
    assert.notEqual(elsewhere.code, 0);
    assert.ok(elsewhere.out.includes(`"${realpathSync(ws)}" is not a linked path of project "ghost" — it has no linked path on this machine`), elsewhere.out);
});

test("U15b: an unregistered slug is refused before anything is read", async () =>
{
    const { box, ws, a } = await oneLinked();
    const before = snapshot(ws, "alpha");
    const refused = await selfIn(box, ws, ["project", "unlink", "nosuch", a]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes('unknown project "nosuch"'), refused.out);
    assertUnchanged(ws, "alpha", before);
});

test("U16: the verdicts are refolded — the detached repository stops being one of the repositories asked", async () =>
{
    const { box, ws, a, b } = await twoLinked();
    // A real commit that lives in neither linked repository, so its verdict
    // stays open and its health line names whatever was asked for it.
    const elsewhere = folder(box, ws, "elsewhere");
    const hash = commit(box, elsewhere, "unreachable");
    const work = workIdIn((await must(box, a, ["work", "add", "ship it"])).out);
    await must(box, a, ["report", work, "done somewhere else", "--evidence", `commit:${hash}`]);
    assert.equal(verdicts(ws, "alpha")[hash], "unverifiable");
    // The repositories are named by label, not by path, in both places.
    assert.ok(stateText(ws, "alpha").includes("no longer resolves in any linked repository (asked: alpha, beta)"), stateText(ws, "alpha"));
    assert.deepEqual(JSON.parse(readFileSync(headFile(ws, "alpha"), "utf8")).asked, ["alpha", "beta"]);
    await must(box, ws, ["project", "unlink", "alpha", b]);
    // The head the previous fold left claimed the verdicts were judged across
    // both; dropping it is what makes this fold walk again and say so.
    assert.deepEqual(JSON.parse(readFileSync(headFile(ws, "alpha"), "utf8")).asked, ["alpha"]);
    assert.ok(stateText(ws, "alpha").includes("no longer resolves in the project repo"), stateText(ws, "alpha"));
    assert.ok(!stateText(ws, "alpha").includes("asked:"), stateText(ws, "alpha"));
});

test("U16b: a hash already settled stays settled — detaching a repository never unsettles a verified verdict", async () =>
{
    const { box, ws, a, b } = await twoLinked();
    const work = workIdIn((await must(box, a, ["work", "add", "ship it"])).out);
    const hash = commit(box, b, "two");
    await must(box, a, ["report", work, "done in beta", "--evidence", `commit:${hash}`]);
    assert.equal(verdicts(ws, "alpha")[hash], "settled");
    await must(box, ws, ["project", "unlink", "alpha", b]);
    assert.equal(verdicts(ws, "alpha")[hash], "settled");
    assert.ok(!stateText(ws, "alpha").includes(GONE), stateText(ws, "alpha"));
});

test("U17: the listing's advertised link command puts the detached checkout back", async () =>
{
    const { box, ws, a } = await oneLinked();
    const a2 = worktreeOf(box, a, "alpha2");
    await must(box, ws, ["project", "link", "alpha", a2]);
    const done = await must(box, a2, ["project", "unlink", "alpha", "--here"]);
    const advertised = done.out.match(/`self (project link alpha --here)`/);
    assert.ok(advertised !== null, done.out);
    const back = await must(box, a2, advertised[1].split(" "));
    assert.ok(back.out.includes(`project "alpha" linked to ${a2}`), back.out);
    assert.equal(JSON.parse(readFileSync(marker(a2), "utf8")).project, "alpha");
    assert.ok((await must(box, ws, ["project", "link", "alpha"])).out.includes("2 linked paths"), "the round trip did not restore the link");
});

test("U17b: a detached second repository re-links through the --force the link refusal names", async () =>
{
    const { box, ws, b } = await twoLinked();
    const done = await must(box, b, ["project", "unlink", "alpha", "--here"]);
    const advertised = done.out.match(/`self (project link alpha --here)`/);
    assert.ok(advertised !== null, done.out);
    // Adding a repository back is adding a repository: the #332 guard fires
    // exactly as it did the first time, and its refusal names what to add.
    const guarded = await selfIn(box, b, advertised[1].split(" "));
    assert.notEqual(guarded.code, 0);
    assert.ok(guarded.out.includes("pass --force to link it as well"), guarded.out);
    const back = await must(box, b, [...advertised[1].split(" "), "--force"]);
    assert.ok(back.out.includes(`project "alpha" linked to ${b}`), back.out);
    assert.ok((await must(box, ws, ["project", "link", "alpha"])).out.includes("2 linked paths"), "the round trip did not restore the link");
});

test("U18: a sibling worktree of the same repository keeps answering, and the command says so", async () =>
{
    const { box, ws, a } = await oneLinked();
    const a2 = worktreeOf(box, a, "alpha2");
    await must(box, ws, ["project", "link", "alpha", a2]);
    const done = await must(box, ws, ["project", "unlink", "alpha", a]);
    assert.ok(done.out.includes(`${a} still answers for "alpha" — another checkout of its repository is linked (${a2})`), done.out);
    assert.ok(done.out.includes(`  ${a2}\n`), done.out);
    assertPruned(ws, "alpha", a);
    assert.match((await must(box, a, ["status"])).out, /^alpha /);
});

test("U19: a marker naming another project is left where it is", async () =>
{
    const { box, ws } = await workspace();
    const a = folder(box, ws, "alpha");
    await must(box, a, ["project", "init", "--name", "alpha", "--no-connect"]);
    const home = folder(box, ws, "beta");
    await must(box, home, ["project", "init", "--name", "beta", "--no-connect"]);
    // One path, two slugs: linking it to a second project never took it from
    // the first, and the marker is whatever the last link wrote.
    const shared = folder(box, ws, "shared");
    await must(box, ws, ["project", "link", "alpha", shared, "--force"]);
    await must(box, ws, ["project", "link", "beta", shared, "--force"]);
    assert.equal(JSON.parse(readFileSync(marker(shared), "utf8")).project, "beta");
    const done = await must(box, ws, ["project", "unlink", "alpha", shared]);
    assert.ok(done.out.includes(`project "alpha" unlinked from ${shared}`), done.out);
    assert.ok(!done.out.includes("marker there is gone"), done.out);
    assert.equal(JSON.parse(readFileSync(marker(shared), "utf8")).project, "beta");
});

test("U22: --here where a folder link and a checkout inside it both contain this directory takes the nearer one", async () =>
{
    const { box, ws, a } = await oneLinked();
    // The folder-of-checkouts shape (#332 L16): F is linked, and so is the
    // repository F/y inside it. Standing in F/y, both links contain cwd.
    const f = join(ws, "proj");
    const y = folder(box, ws, join("proj", "y"));
    await must(box, ws, ["project", "link", "alpha", f, "--force"]);
    await must(box, ws, ["project", "link", "alpha", y]);
    const done = await must(box, y, ["project", "unlink", "--here"]);
    assert.ok(done.out.includes(`project "alpha" unlinked from ${y}`), done.out);
    // The folder still contains this directory, so the listing marks it — which
    // is also the proof it survived: the nearer link went, not this one.
    assert.ok(done.out.includes(`  ${realpathSync(f)}  (this directory)`), "the folder link went instead of the nearer one");
    assert.ok(done.out.includes(`  ${a}\n`), done.out);
    assertPruned(ws, "alpha", y);
});

test("U20: a named slug and a named path work from outside every project", async () =>
{
    const { box, ws, a, b } = await twoLinked();
    const out = join(box.root, "out");
    mkdirSync(out, { recursive: true });
    const done = await must(box, out, ["project", "unlink", "alpha", b]);
    assert.ok(done.out.includes(`project "alpha" unlinked from ${b}`), done.out);
    assert.ok(done.out.includes(`  ${a}\n`), done.out);
    assertPruned(ws, "alpha", b);
});

test("U21: the project's own record is untouched — no event, and the registry byte-identical", async () =>
{
    const { box, ws, a, b } = await twoLinked();
    await must(box, a, ["work", "add", "something to log"]);
    const log = join(STORE(ws), "projects", "alpha", "log.jsonl");
    const events = readFileSync(log, "utf8");
    const registry = readFileSync(join(STORE(ws), "registry.jsonl"), "utf8");
    await must(box, ws, ["project", "unlink", "alpha", b]);
    assert.equal(readFileSync(log, "utf8"), events, "the project log gained an event");
    assert.equal(readFileSync(join(STORE(ws), "registry.jsonl"), "utf8"), registry, "the registry row moved");
    // The ledger the change did land in is git-excluded from the store, so a
    // machine's paths never reach a synced commit.
    const excluded = readFileSync(join(STORE(ws), ".git", "info", "exclude"), "utf8");
    assert.ok(excluded.includes("links.jsonl"), excluded);
});
