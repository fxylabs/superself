// Evidence is judged across every repository a project is linked to (#331).
//
// Every test below is one cell of the case table in
// docs/maintainers/case-tables/331-multi-repo-evidence.md, named by its cell
// id, and asserts that cell's stated outcome: the verdict the fold stores for
// a hash, and the health line it raises or does not. Kinds: K1 one linked
// repository, K2 two, K3 a folder holding two, K4 nothing to ask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ulid } from "../dist/ids.js";
import { git, logFixture, machine, must, workIdIn } from "./harness.mjs";

const GONE1 = "no longer resolves in the project repo — history may have been rewritten";
const RESET = "was reset away on its branch";
const goneN = (names) => `no longer resolves in any linked repository (asked: ${names}) — ` +
    "history may have been rewritten, or the repository holding it is not linked on this machine";
// A hash no repository will ever hold.
const NOWHERE = "0123456789abcdef0123456789abcdef01234567";

function gitOut(box, cwd, args)
{
    return execFileSync("git", args, { cwd, env: box.env, encoding: "utf8" }).trim();
}

function commit(box, dir, name)
{
    writeFileSync(join(dir, name), `${name}\n`);
    git(box, dir, ["add", "."]);
    git(box, dir, ["commit", "-q", "-m", name]);
    return gitOut(box, dir, ["rev-parse", "HEAD"]);
}

// The root commit is named after the directory: two repositories created in
// the same second with the same author, message and tree would otherwise
// share a root commit, and the fold would rightly read them as one repository.
function repo(box, dir)
{
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    commit(box, dir, `${basename(dir)}-root`);
    return realpathSync(dir);
}

const identity = (box, dir) => gitOut(box, dir, ["rev-list", "--max-parents=0", "--first-parent", "HEAD"]);

// K1: a workspace holding project `demo` at repository A, and an unlinked
// repository B beside it.
async function oneLink()
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init"]);
    const a = repo(box, join(ws, "demo"));
    await must(box, a, ["project", "init", "--name", "demo", "--no-connect"]);
    const b = repo(box, join(ws, "other"));
    const work = workIdIn((await must(box, a, ["work", "add", "ship it"])).out);
    return { box, ws, a, b, work, store: join(ws, ".superself") };
}

// K2: K1 with B linked as a second repository of `demo`.
async function twoLinks()
{
    const t = await oneLink();
    // A second repository is the change `--force` exists for (#332).
    await must(t.box, t.ws, ["project", "link", "demo", t.b, "--force"]);
    return t;
}

// K3: project `proj` registered at a folder F that is not a repository and
// holds repositories `a` and `b` one level below.
async function folderLink()
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init"]);
    const f = join(ws, "proj");
    const a = repo(box, join(f, "a"));
    const b = repo(box, join(f, "b"));
    await must(box, f, ["project", "init", "--name", "proj", "--no-connect"]);
    const work = workIdIn((await must(box, a, ["work", "add", "ship it"])).out);
    return { box, ws, f, a, b, work, store: join(ws, ".superself"), slug: "proj" };
}

const stateDir = (t) => join(t.store, "projects", t.slug ?? "demo");
const verdicts = (t) => existsSync(join(stateDir(t), "evidence.json"))
    ? JSON.parse(readFileSync(join(stateDir(t), "evidence.json"), "utf8")) : {};
const health = (t) => readFileSync(join(stateDir(t), "state.md"), "utf8");
const head = (t) => JSON.parse(readFileSync(join(stateDir(t), ".evidence-head.json"), "utf8"));
const storeVerdicts = (t, stored) => writeFileSync(join(stateDir(t), "evidence.json"), JSON.stringify(stored, null, 2) + "\n");
const report = (t, cwd, ...hashes) =>
    must(t.box, cwd, ["report", t.work, "did", ...hashes.flatMap((hash) => ["--evidence", `commit:${hash}`])]);
const fold = (t, cwd) => must(t.box, cwd, ["fold"]);

function assertQuiet(t, ...texts)
{
    for (const text of [GONE1, RESET, "no longer resolves in any linked repository", ...texts])
    {
        assert.ok(!health(t).includes(text), `health carried "${text}":\n${health(t)}`);
    }
}

function branchCommit(box, dir, branch, name)
{
    git(box, dir, ["checkout", "-q", "-b", branch]);
    return commit(box, dir, name);
}

// ── K1: one linked repository, byte-identical to today ───────────────────

test("E1: a hash on the default branch is settled", async () =>
{
    const t = await oneLink();
    const hash = commit(t.box, t.a, "two");
    await report(t, t.a, hash);
    assert.equal(verdicts(t)[hash], "settled");
    assertQuiet(t);
});

test("E2: a hash on another ref is provisional", async () =>
{
    const t = await oneLink();
    const hash = branchCommit(t.box, t.a, "f", "two");
    await report(t, t.a, hash);
    git(t.box, t.a, ["checkout", "-q", "main"]);
    await fold(t, t.a);
    assert.equal(verdicts(t)[hash], "provisional");
    assertQuiet(t);
});

test("E3: a hash reset away while its branch stands is abandoned, and health says so", async () =>
{
    const t = await oneLink();
    const hash = branchCommit(t.box, t.a, "f", "two");
    await report(t, t.a, hash);
    git(t.box, t.a, ["reset", "-q", "--hard", "HEAD~1"]);
    await fold(t, t.a);
    assert.equal(verdicts(t)[hash], "abandoned");
    assert.ok(health(t).includes(`evidence ${hash} ${RESET}`), health(t));
});

test("E4: a dangling hash whose branch is gone is unknown", async () =>
{
    const t = await oneLink();
    const hash = branchCommit(t.box, t.a, "f", "two");
    await report(t, t.a, hash);
    git(t.box, t.a, ["reset", "-q", "--hard", "HEAD~1"]);
    git(t.box, t.a, ["checkout", "-q", "main"]);
    git(t.box, t.a, ["branch", "-q", "-D", "f"]);
    await fold(t, t.a);
    assert.equal(verdicts(t)[hash], "unknown");
    assertQuiet(t);
});

test("E5: a hash nowhere is unverifiable with today's line", async () =>
{
    const t = await oneLink();
    await report(t, t.a, NOWHERE);
    assert.equal(verdicts(t)[NOWHERE], "unverifiable");
    assert.ok(health(t).includes(`evidence ${NOWHERE} ${GONE1}`), health(t));
});

test("E6: a hash that lives only in a repository that is not linked is unverifiable", async () =>
{
    const t = await oneLink();
    const hash = commit(t.box, t.b, "two");
    await report(t, t.a, hash);
    assert.equal(verdicts(t)[hash], "unverifiable");
    assert.ok(health(t).includes(`evidence ${hash} ${GONE1}`), health(t));
});

test("E7: a stored provisional verdict becomes settled once the branch merges", async () =>
{
    const t = await oneLink();
    const hash = branchCommit(t.box, t.a, "f", "two");
    await report(t, t.a, hash);
    assert.equal(verdicts(t)[hash], "provisional");
    git(t.box, t.a, ["checkout", "-q", "main"]);
    git(t.box, t.a, ["merge", "-q", "f"]);
    await fold(t, t.a);
    assert.equal(verdicts(t)[hash], "settled");
});

test("E8 and E9: settled is final — it survives a refold and the object going away", async () =>
{
    const t = await oneLink();
    const hash = commit(t.box, t.a, "two");
    await report(t, t.a, hash);
    await fold(t, t.a);
    assert.equal(verdicts(t)[hash], "settled");
    git(t.box, t.a, ["reset", "-q", "--hard", "HEAD~1"]);
    git(t.box, t.a, ["reflog", "expire", "--expire=now", "--all"]);
    git(t.box, t.a, ["gc", "-q", "--prune=now"]);
    await fold(t, t.a);
    assert.equal(verdicts(t)[hash], "settled");
    assertQuiet(t);
});

test("E10: a stored unverifiable verdict is walked again once the object is here", async () =>
{
    const t = await oneLink();
    const hash = commit(t.box, t.a, "two");
    storeVerdicts(t, { [hash]: "unverifiable" });
    await report(t, t.a, hash);
    assert.equal(verdicts(t)[hash], "settled");
    assertQuiet(t);
});

// ── K2: two linked repositories ─────────────────────────────────────────

test("E11, E12, E13: hashes from either repository settle, from whichever checkout the fold runs", async () =>
{
    const t = await twoLinks();
    const hashA = commit(t.box, t.a, "two");
    const hashB = commit(t.box, t.b, "two");
    await report(t, t.a, hashA, hashB);
    const expected = { [hashA]: "settled", [hashB]: "settled" };
    assert.deepEqual(verdicts(t), expected);
    await fold(t, t.b);
    assert.deepEqual(verdicts(t), expected);
    // A no-op re-link from the workspace root folds from outside both.
    await must(t.box, t.ws, ["project", "link", "demo", t.a]);
    assert.deepEqual(verdicts(t), expected);
    assertQuiet(t);
});

test("E14: a hash on another ref of the second repository is provisional", async () =>
{
    const t = await twoLinks();
    const hash = branchCommit(t.box, t.b, "f", "two");
    await report(t, t.a, hash);
    assert.equal(verdicts(t)[hash], "provisional");
});

test("E15: a hash reset away on a branch of the second repository is abandoned", async () =>
{
    const t = await twoLinks();
    const hash = branchCommit(t.box, t.b, "f", "two");
    await report(t, t.b, hash);
    git(t.box, t.b, ["reset", "-q", "--hard", "HEAD~1"]);
    await fold(t, t.a);
    assert.equal(verdicts(t)[hash], "abandoned");
    assert.ok(health(t).includes(`evidence ${hash} ${RESET}`), health(t));
});

test("E16: a dangling hash of the second repository whose branch is gone is unknown", async () =>
{
    const t = await twoLinks();
    const hash = branchCommit(t.box, t.b, "f", "two");
    await report(t, t.b, hash);
    git(t.box, t.b, ["reset", "-q", "--hard", "HEAD~1"]);
    git(t.box, t.b, ["checkout", "-q", "main"]);
    git(t.box, t.b, ["branch", "-q", "-D", "f"]);
    await fold(t, t.a);
    assert.equal(verdicts(t)[hash], "unknown");
    assertQuiet(t);
});

test("E17: a hash no linked repository knows names the repositories asked", async () =>
{
    const t = await twoLinks();
    await report(t, t.a, NOWHERE);
    assert.equal(verdicts(t)[NOWHERE], "unverifiable");
    assert.ok(health(t).includes(`evidence ${NOWHERE} ${goneN("demo, other")}`), health(t));
    // The console surfaces reuse the stored verdicts without git and still
    // name the repositories the fold asked.
    assert.ok((await must(t.box, t.a, ["status"])).out.includes(goneN("demo, other")));
});

// A hash both repositories hold: on B's default branch, and fetched into A
// where nothing reaches it.
function shared(t)
{
    const hash = commit(t.box, t.b, "two");
    git(t.box, t.a, ["fetch", "-q", t.b, "main"]);
    return hash;
}

test("E18a: a hash two repositories hold is judged in the one the report named", async () =>
{
    const t = await twoLinks();
    const hash = shared(t);
    await report(t, t.b, hash);
    assert.equal(verdicts(t)[hash], "settled");
});

test("E18b: a legacy report naming no repository is judged in the first linked repository that knows the hash", async () =>
{
    const t = await twoLinks();
    const hash = shared(t);
    logFixture(t.ws, "demo", {
        id: ulid(),
        ts: new Date().toISOString(),
        type: "report.added",
        origin: { actor: "agent", confirmed: false },
        project: "demo",
        payload: { text: "did", evidenceTyped: true },
        refs: { work: t.work, commits: [hash], branch: "main" }
    });
    assert.equal(verdicts(t)[hash], "unknown");
});

test("E19: a hash judged unverifiable before its repository was linked settles once it is", async () =>
{
    const t = await oneLink();
    const hash = commit(t.box, t.b, "two");
    await report(t, t.a, hash);
    assert.equal(verdicts(t)[hash], "unverifiable");
    assert.ok(health(t).includes(GONE1));
    await must(t.box, t.ws, ["project", "link", "demo", t.b, "--force"]);
    assert.equal(verdicts(t)[hash], "settled");
    assertQuiet(t);
});

test("E20: the evidence head keeps one key per repository, and only the moved one changes", async () =>
{
    const t = await twoLinks();
    const hash = branchCommit(t.box, t.b, "f", "two");
    await report(t, t.a, hash);
    const before = head(t);
    assert.deepEqual(Object.keys(before.repositories).sort(), [identity(t.box, t.a), identity(t.box, t.b)].sort());
    assert.deepEqual(before.asked, ["demo", "other"]);
    commit(t.box, t.a, "three");
    await fold(t, t.a);
    const after = head(t);
    assert.notEqual(after.repositories[identity(t.box, t.a)], before.repositories[identity(t.box, t.a)]);
    assert.equal(after.repositories[identity(t.box, t.b)], before.repositories[identity(t.box, t.b)]);
    assert.equal(verdicts(t)[hash], "provisional");
});

test("E21: a linked repository missing from this machine demotes nothing", async () =>
{
    const t = await twoLinks();
    const hash = branchCommit(t.box, t.b, "f", "two");
    await report(t, t.a, hash);
    assert.equal(verdicts(t)[hash], "provisional");
    rmSync(t.b, { recursive: true, force: true });
    await report(t, t.a, NOWHERE);
    assert.equal(verdicts(t)[hash], "provisional");
    assert.equal(verdicts(t)[NOWHERE], undefined);
    assert.deepEqual(head(t).asked, ["demo"]);
    assertQuiet(t);
});

test("E22: once the dead link is pruned, only the repository left is asked", async () =>
{
    const t = await twoLinks();
    const hash = branchCommit(t.box, t.b, "f", "two");
    await report(t, t.a, hash);
    rmSync(t.b, { recursive: true, force: true });
    await fold(t, t.a);
    assert.equal(verdicts(t)[hash], "unverifiable");
    assert.ok(health(t).includes(`evidence ${hash} ${GONE1}`), health(t));
});

// ── K3: a folder holding the repositories ───────────────────────────────

test("E23: repositories one level below a linked folder are judged", async () =>
{
    const t = await folderLink();
    const hashA = commit(t.box, t.a, "two");
    const hashB = commit(t.box, t.b, "two");
    await report(t, t.a, hashA, hashB);
    assert.deepEqual(verdicts(t), { [hashA]: "settled", [hashB]: "settled" });
    assertQuiet(t);
});

test("E24: a plain folder and a repository two levels down are not asked", async () =>
{
    const t = await folderLink();
    mkdirSync(join(t.f, "notes"), { recursive: true });
    const deep = repo(t.box, join(t.f, "x", "deep"));
    const hash = commit(t.box, deep, "two");
    await report(t, t.a, hash);
    assert.equal(verdicts(t)[hash], "unverifiable");
    assert.ok(health(t).includes(`evidence ${hash} ${goneN("a, b")}`), health(t));
});

test("E25: a fold run from inside the folder judges the same", async () =>
{
    const t = await folderLink();
    const hashA = commit(t.box, t.a, "two");
    await report(t, t.a, hashA);
    await fold(t, t.f);
    assert.equal(verdicts(t)[hashA], "settled");
});

// ── K4: nothing to ask ──────────────────────────────────────────────────

test("E26: a folder link with no repository below leaves stored verdicts untouched", async () =>
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init"]);
    const f = join(ws, "empty");
    mkdirSync(f);
    await must(box, f, ["project", "init", "--name", "empty", "--no-connect"]);
    const work = workIdIn((await must(box, f, ["work", "add", "ship it"])).out);
    const t = { box, ws, work, store: join(ws, ".superself"), slug: "empty" };
    storeVerdicts(t, { [NOWHERE]: "provisional" });
    await report(t, f, NOWHERE);
    assert.deepEqual(verdicts(t), { [NOWHERE]: "provisional" });
    assert.ok(!existsSync(join(stateDir(t), ".evidence-head.json")), "a head was written with nothing asked");
    assertQuiet(t);
});

test("E27: no standing link and no registry path leaves stored verdicts untouched", async () =>
{
    const t = await oneLink();
    storeVerdicts(t, { [NOWHERE]: "unverifiable" });
    await report(t, t.a, NOWHERE);
    assert.ok(health(t).includes(GONE1));
    rmSync(t.a, { recursive: true, force: true });
    logFixture(t.ws, "demo", {
        id: ulid(),
        ts: new Date().toISOString(),
        type: "report.added",
        origin: { actor: "agent", confirmed: false },
        project: "demo",
        payload: { text: "later", evidenceTyped: true },
        refs: { work: t.work, commits: [NOWHERE] }
    });
    assert.deepEqual(verdicts(t), { [NOWHERE]: "unverifiable" });
    assert.ok(health(t).includes(`evidence ${NOWHERE} ${GONE1}`), health(t));
});

// ── the report records which repository it ran in ──────────────────────

const lastReport = (t) => readFileSync(join(stateDir(t), "log.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line)).filter((event) => event.type === "report.added").pop();

test("E28: a report records the identity of the repository it ran in, beside the branch", async () =>
{
    const t = await twoLinks();
    await report(t, t.a, commit(t.box, t.a, "two"));
    assert.equal(lastReport(t).refs.repository, identity(t.box, t.a));
    assert.equal(lastReport(t).refs.branch, "main");
    await report(t, t.b, commit(t.box, t.b, "two"));
    assert.equal(lastReport(t).refs.repository, identity(t.box, t.b));
});

test("E29: a repository with no commit records no repository", async () =>
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init"]);
    const dir = join(ws, "fresh");
    mkdirSync(dir);
    git(box, dir, ["init", "-q", "-b", "main"]);
    await must(box, dir, ["project", "init", "--name", "fresh", "--no-connect"]);
    const work = workIdIn((await must(box, dir, ["work", "add", "ship it"])).out);
    const t = { box, ws, work, store: join(ws, ".superself"), slug: "fresh" };
    await report(t, dir, NOWHERE);
    assert.deepEqual(lastReport(t).refs.commits, [NOWHERE]);
    assert.equal(lastReport(t).refs.repository, undefined);
});

test("E31: under a folder project a report reads HEAD, bare hashes, branch and identity from the checkout it ran in", async () =>
{
    const t = await folderLink();
    const head = commit(t.box, t.a, "two");
    await must(t.box, t.a, ["report", t.work, "head by default"]);
    assert.deepEqual(lastReport(t).refs.commits, [head.slice(0, 12)]);
    assert.equal(lastReport(t).refs.branch, "main");
    assert.equal(lastReport(t).refs.repository, identity(t.box, t.a));
    const bare = commit(t.box, t.b, "two");
    await must(t.box, t.b, ["report", t.work, "bare hash", "--evidence", bare]);
    assert.deepEqual(lastReport(t).refs.commits, [bare]);
    assert.equal(lastReport(t).refs.repository, identity(t.box, t.b));
    assert.deepEqual(verdicts(t), { [head.slice(0, 12)]: "settled", [bare]: "settled" });
});

test("E30: a fold from the workspace root, outside every repository, settles a second-repository hash", async () =>
{
    const t = await twoLinks();
    const hash = commit(t.box, t.b, "two");
    await report(t, t.a, hash);
    await must(t.box, t.ws, ["project", "link", "demo", t.a]);
    assert.equal(verdicts(t)[hash], "settled");
    assertQuiet(t);
});
