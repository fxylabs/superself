// A project with no checkout linked on this machine says so, instead of
// reporting success over frozen verdicts (#308).
//
// Every test below is one cell of the case table in
// docs/maintainers/case-tables/308-frozen-verdicts.md, named by its cell id,
// and asserts that cell's stated outcome: what `self fold` answers, what
// health says, and that the stored verdicts do not move while nothing can
// judge them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, machine, must, workIdIn } from "./harness.mjs";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));

const frozenLine = (slug) =>
    `no checkout of "${slug}" is linked on this machine, so these unshipped rows are the last verdicts `
    + `this machine could compute — run \`self project link ${slug} --here\` in the checkout`;

const frozenReceipt = (slug) =>
    `folded ${slug}'s pages — evidence verdicts were not recomputed: no checkout of `
    + `"${slug}" is linked on this machine; run \`self project link ${slug} --here\` in it`;

const pruneNotice = (slug) =>
    `no checkout of "${slug}" there any more; until one is linked again its evidence verdicts stay frozen — `
    + `run \`self project link ${slug} --here\` wherever the checkout is now`;

// Both streams. `selfIn` reports only stdout on a successful run, and the two
// lines F12 and F13 turn on — the #115 warning and the archived note — are
// deliberately kept off stdout.
function streams(box, cwd, args)
{
    const run = spawnSync(process.execPath, [bin, ...args], { cwd, env: box.env, encoding: "utf8" });
    return { code: run.status, out: run.stdout, err: run.stderr };
}

function commit(box, dir, file, message)
{
    writeFileSync(join(dir, file), `${message}\n`);
    git(box, dir, ["add", "-A"]);
    git(box, dir, ["commit", "-q", "-m", message]);
}

// The 12 characters a verdict is keyed by.
function headHash(box, dir)
{
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: box.env, encoding: "utf8" }).trim().slice(0, 12);
}

async function workspace()
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init"]);
    return { box, ws };
}

// A registered project holding one open work unit. `banded` records a report
// against a branch commit, which is what puts a row in the unshipped band;
// without it the project has no evidence at all and the band is empty.
async function project(world, slug, banded)
{
    const dir = join(world.ws, slug);
    mkdirSync(dir, { recursive: true });
    git(world.box, dir, ["init", "-q", "-b", "main"]);
    commit(world.box, dir, "a.txt", `first ${slug}`);
    await must(world.box, dir, ["project", "init", "--name", slug, "--no-connect"]);
    const work = workIdIn((await must(world.box, dir, ["work", "add", `ship ${slug}`])).out);
    await must(world.box, dir, ["work", "start", work]);
    if (banded)
    {
        git(world.box, dir, ["checkout", "-q", "-b", "feature"]);
        commit(world.box, dir, "b.txt", "branch work");
        // The friction sentence is what keeps this fixture's subject the
        // frozen verdicts (#380): a project whose only report records none
        // earns a health line of its own, and these cells count the signals
        // an unjudgeable band raises, not that one.
        await must(world.box, dir, ["report", work, "did the branch work", "--friction", "예상대로"]);
    }
    return { dir, slug, work };
}

// The issue's reproduction: the checkout moves and nobody re-links it. The
// `.self` marker travels with the directory, so every command keeps working
// from the new path — which is exactly why the broken link goes unnoticed.
function moveAway(world, entry)
{
    const moved = join(world.box.root, `moved-${entry.slug}`);
    renameSync(entry.dir, moved);
    entry.dir = moved;
    return moved;
}

// The two files the #128 guarantee is asserted on, with the bytes and the
// mtime a frozen fold must leave exactly as it found them. Their existence is
// asserted here: `statSync` throws on a file that was never written, and an
// invariance that reads as a crash says nothing about the invariant.
function verdictFiles(world, slug)
{
    const dir = join(world.ws, ".superself", "projects", slug);
    return [join(dir, "evidence.json"), join(dir, ".evidence-head.json")].map((file) =>
    {
        assert.ok(existsSync(file), `${file} was never written, so its invariance would prove nothing`);
        return { file, text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs };
    });
}

function assertUnmoved(before, world, slug)
{
    const after = verdictFiles(world, slug);
    for (const [index, was] of before.entries())
    {
        assert.equal(after[index].text, was.text, `${was.file} changed while nothing could judge it`);
        assert.equal(after[index].mtime, was.mtime, `${was.file} was rewritten while nothing could judge it`);
    }
}

function verdictsOf(world, slug)
{
    return JSON.parse(readFileSync(join(world.ws, ".superself", "projects", slug, "evidence.json"), "utf8"));
}

// The worlds below are built once and read by several cells. `node --test`
// runs a file's tests one after another in declaration order, and the two
// cells that write — F13 archives, F14 records a report — are declared after
// every cell that reads the same world.
let banded = null;
let quiet = null;
let pair = null;

// demo, with a band, its link pruned by the fold captured as `pruneFold`.
async function frozenBanded()
{
    if (banded === null)
    {
        const world = await workspace();
        world.demo = await project(world, "demo", true);
        world.pruneFold = await must(world.box, moveAway(world, world.demo), ["fold"]);
        banded = world;
    }
    return banded;
}

// The same, with nothing unshipped: one open work unit and no evidence.
async function frozenQuiet()
{
    if (quiet === null)
    {
        const world = await workspace();
        world.hush = await project(world, "hush", false);
        world.pruneFold = await must(world.box, moveAway(world, world.hush), ["fold"]);
        quiet = world;
    }
    return quiet;
}

// Two banded projects, one of them moved away, and the fold that runs in the
// project still standing — so the prune it reports is another project's.
async function prunedNeighbour()
{
    if (pair === null)
    {
        const world = await workspace();
        world.demo = await project(world, "demo", true);
        world.other = await project(world, "other", true);
        moveAway(world, world.other);
        world.pruneFold = await must(world.box, world.demo.dir, ["fold"]);
        pair = world;
    }
    return pair;
}

/* ── a linked project answers exactly as it always did ─────────────── */

test("F1: a linked project recomputes and reports refolded", async () =>
{
    const world = await workspace();
    const demo = await project(world, "demo", true);
    const hash = headHash(world.box, demo.dir);
    const fold = await must(world.box, demo.dir, ["fold"]);
    assert.match(fold.out, /^refolded demo$/m, fold.out);
    assert.equal(verdictsOf(world, "demo")[hash], "provisional", "the branch commit was never judged");
    verdictFiles(world, "demo");
    const status = (await must(world.box, demo.dir, ["status"])).out;
    assert.ok(!status.includes(frozenLine("demo")), `a linked project raised the frozen line:\n${status}`);
});

test("F2: an empty band changes nothing about a linked fold", async () =>
{
    const world = await workspace();
    const hush = await project(world, "hush", false);
    const fold = await must(world.box, hush.dir, ["fold"]);
    assert.match(fold.out, /^refolded hush$/m, fold.out);
    assert.match((await must(world.box, hush.dir, ["status"])).out, /health: ok/);
});

/* ── the fold receipt stops claiming success ───────────────────────── */

test("F3: a pruned link leaves evidence.json and .evidence-head.json untouched and says so", async () =>
{
    const world = await frozenBanded();
    const before = verdictFiles(world, "demo");
    const fold = await must(world.box, world.demo.dir, ["fold"]);
    assert.ok(!fold.out.includes("refolded demo"), `the fold still claimed success:\n${fold.out}`);
    assert.ok(fold.out.includes(frozenReceipt("demo")), fold.out);
    assertUnmoved(before, world, "demo");
    const page = readFileSync(join(world.ws, ".superself", "projects", "demo", "state.md"), "utf8");
    assert.ok(page.includes(frozenLine("demo")), "the fold's own page does not carry the line");
});

test("F4: the receipt names the skip even when the band is empty", async () =>
{
    const world = await frozenQuiet();
    const fold = await must(world.box, world.hush.dir, ["fold"]);
    assert.ok(!fold.out.includes("refolded hush"), `the fold still claimed success:\n${fold.out}`);
    assert.ok(fold.out.includes(frozenReceipt("hush")), fold.out);
});

/* ── health says it wherever the band claims something ─────────────── */

test("F5: self status does not print health: ok while the band cannot be judged", async () =>
{
    const world = await frozenBanded();
    const status = (await must(world.box, world.demo.dir, ["status"])).out;
    assert.ok(!status.includes("health: ok"), `health read as ok over frozen verdicts:\n${status}`);
    assert.ok(status.includes(frozenLine("demo")), status);
});

test("F6: self context carries the same line", async () =>
{
    const world = await frozenBanded();
    const context = (await must(world.box, world.demo.dir, ["context"])).out;
    assert.ok(context.includes(frozenLine("demo")), context);
    assert.match(context, /## Health[\s\S]*no checkout of "demo" is linked on this machine/);
});

test("F7: an empty band on an unlinked project stays health: ok", async () =>
{
    const world = await frozenQuiet();
    const status = (await must(world.box, world.hush.dir, ["status"])).out;
    assert.match(status, /unshipped: nothing waiting to ship/);
    assert.match(status, /health: ok/, status);
});

test("F8: the workspace overview counts the signal for that project alone", async () =>
{
    const world = await prunedNeighbour();
    const rows = (await must(world.box, world.ws, ["status", "--workspace"])).out.split("\n");
    const row = (slug) => rows.find((line) => line.startsWith(`${slug} —`)) ?? "";
    assert.match(row("other"), /\[1 health signal\(s\)\]$/, rows.join("\n"));
    assert.ok(!row("demo").includes("health signal"), `the linked project was counted too:\n${rows.join("\n")}`);
});

/* ── pruning names the checkout that moved ─────────────────────────── */

test("F9: pruning another project's link names relinking wherever it is now", async () =>
{
    const fold = (await prunedNeighbour()).pruneFold;
    assert.ok(fold.out.includes(pruneNotice("other")), fold.out);
    assert.equal(fold.out.split("pruned the link to").length - 1, 1, `more than one prune reported:\n${fold.out}`);
    assert.match(fold.out, /^refolded demo$/m, fold.out);
});

test("F10: pruning the active project's own link prunes, freezes and says both", async () =>
{
    const world = await frozenBanded();
    const fold = world.pruneFold;
    assert.ok(fold.out.includes(pruneNotice("demo")), fold.out);
    assert.ok(fold.out.includes(frozenReceipt("demo")), fold.out);
    assert.ok(!fold.out.includes("refolded demo"), `the pruning fold claimed success:\n${fold.out}`);
    assert.ok((await must(world.box, world.demo.dir, ["status"])).out.includes(frozenLine("demo")));
});

/* ── the way out, and the two neighbours of the frozen state ───────── */

test("F11: relinking then folding moves a squash-merged commit to unknown and clears the band", async () =>
{
    const world = await workspace();
    const demo = await project(world, "demo", true);
    const branchHash = headHash(world.box, demo.dir);
    git(world.box, demo.dir, ["checkout", "-q", "main"]);
    commit(world.box, demo.dir, "b.txt", "squashed");
    git(world.box, demo.dir, ["branch", "-q", "-D", "feature"]);
    await must(world.box, moveAway(world, demo), ["fold"]);
    await must(world.box, demo.dir, ["report", demo.work, "the report made from the default branch"]);
    const mainHash = headHash(world.box, demo.dir);
    const before = verdictFiles(world, "demo");
    await must(world.box, demo.dir, ["project", "link", "demo", "--here"]);
    assert.match((await must(world.box, demo.dir, ["fold"])).out, /^refolded demo$/m);
    assert.equal(verdictsOf(world, "demo")[branchHash], "unknown", "the squash-merged commit was not rejudged");
    assert.equal(verdictsOf(world, "demo")[mainHash], "settled", "the report from the default branch was not judged");
    assert.notEqual(verdictFiles(world, "demo")[1].text, before[1].text, ".evidence-head.json was not rewritten");
    const status = (await must(world.box, demo.dir, ["status"])).out;
    assert.match(status, /unshipped: nothing waiting to ship/, status);
    assert.match(status, /health: ok/, status);
});

test("F12: a linked path that is no repository keeps the #115 warning and raises no new line", async () =>
{
    const world = await workspace();
    const broken = await project(world, "broken", true);
    const before = verdictFiles(world, "broken");
    rmSync(join(broken.dir, ".git"), { recursive: true, force: true });
    const fold = streams(world.box, broken.dir, ["fold"]);
    assert.equal(fold.code, 0, fold.err);
    assert.match(fold.err, /is no longer the repository linked there/, fold.err);
    assert.match(fold.out, /^refolded broken$/m, fold.out);
    assert.ok(!fold.out.includes("last verdicts"), `a standing link raised the frozen line:\n${fold.out}`);
    assert.match(streams(world.box, broken.dir, ["status"]).out, /health: ok/);
    assertUnmoved(before, world, "broken");
});

test("F13: an archived project still says its verdicts are frozen", async () =>
{
    const world = await prunedNeighbour();
    await must(world.box, world.ws, ["project", "archive", "other", "--why", "nobody is on it this quarter"]);
    const status = streams(world.box, world.ws, ["status", "--project", "other"]);
    assert.equal(status.code, 0, status.err);
    assert.match(status.err, /project "other" is archived/, status.err);
    assert.ok(status.out.includes(frozenLine("other")), status.out);
});

test("F14: an append on an unlinked project records the event and touches no verdict file", async () =>
{
    const world = await frozenBanded();
    const before = verdictFiles(world, "demo");
    const report = await must(world.box, world.demo.dir, ["report", world.demo.work, "recorded with nothing to judge it"]);
    assert.match(report.out, /report\.added recorded \[[0-9abcdefghjkmnpqrstvwxyz]{26}\]/, report.out);
    const log = readFileSync(join(world.ws, ".superself", "projects", "demo", "log.jsonl"), "utf8");
    assert.ok(log.includes("recorded with nothing to judge it"), "the event was not written");
    assertUnmoved(before, world, "demo");
});
