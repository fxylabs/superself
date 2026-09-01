// A project is set aside and picked back up (#283).
//
// Every test below is one cell of the case table on issue #283, named by its
// cell number, and asserts that cell's stated outcome. The rulings the table
// stands on:
//
//   A  archiving is not retirement — open work neither blocks it nor is retired
//      by it, and restore gives every unit back in the state it was left
//   B  an archived project leaves the default listing, `self context` and every
//      workspace aggregate, and stays readable through `--archived` and an
//      explicit `--project <slug>`
//   C  `restore` is the only way out of an archive, and its optional `--why` is
//      how one that should never have been written is stated; `self undo` does
//      not reach an archive, because both verbs here run from anywhere in the
//      workspace and `undo` needs the project's own checkout
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, idIn, machine, must, mustPerson, personIn, selfIn, workIdIn } from "./harness.mjs";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));

// Both streams, which `selfIn` does not report on a successful run. A read of an
// archived project answers on stdout exactly as it always did, and says the
// project is archived on stderr — so a test of that line has to read the stream
// it was deliberately kept off stdout for.
function streams(box, cwd, args)
{
    const run = spawnSync(process.execPath, [bin, ...args], { cwd, env: box.env, encoding: "utf8" });
    return { code: run.status, out: run.stdout, err: run.stderr };
}

// Two registered projects, so an aggregate has something to keep as well as
// something to drop.
async function two()
{
    const box = machine();
    const ws = join(box.root, "ws");
    const alpha = join(ws, "alpha");
    const beta = join(ws, "beta");
    mkdirSync(alpha, { recursive: true });
    mkdirSync(beta, { recursive: true });
    await must(box, ws, ["init", "--git"]);
    git(box, alpha, ["init", "-q", "-b", "main"]);
    git(box, beta, ["init", "-q", "-b", "main"]);
    await must(box, alpha, ["project", "init", "--name", "alpha", "--no-connect"]);
    await must(box, beta, ["project", "init", "--name", "beta", "--no-connect"]);
    return { box, ws, alpha, beta };
}

// One unit in each open state the fold can hold, so a round trip has something
// to give back wrongly.
async function mixedWork(box, dir)
{
    const active = workIdIn((await mustPerson(box, dir, ["work", "add", "the active outcome"])).out);
    await must(box, dir, ["work", "start", active]);
    const blocked = workIdIn((await mustPerson(box, dir, ["work", "add", "the blocked outcome"])).out);
    await must(box, dir, ["work", "start", blocked]);
    await must(box, dir, ["work", "block", blocked, "--on", "dependency", "--why", "waiting on the other one"]);
    const next = workIdIn((await mustPerson(box, dir, ["work", "add", "the next outcome"])).out);
    return { active, blocked, next };
}

async function statusOf(box, ws, id)
{
    const shown = (await must(box, ws, ["work", "show", id, "--project", "alpha"])).out;
    return shown.match(/- Status: (\w+)/)[1];
}

function archive(box, cwd, slug = "alpha", why = "nobody is working on it this quarter")
{
    return must(box, cwd, ["project", "archive", slug, "--why", why]);
}

function events(ws, slug)
{
    return readFileSync(join(ws, ".superself", "projects", slug, "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
}

/* ── the archive verb ──────────────────────────────────────────────── */

test("1: archiving a project with no open work takes it out of the listing, context and aggregates", async () =>
{
    const { box, ws } = await two();
    await archive(box, ws);
    const listed = (await must(box, ws, ["project"])).out;
    assert.doesNotMatch(listed, /^alpha/m, `alpha is still in the listing:\n${listed}`);
    assert.match(listed, /^beta/m);
    const context = (await must(box, ws, ["context"])).out;
    assert.doesNotMatch(context, /alpha/, `alpha is still in the workspace context:\n${context}`);
    const aggregate = (await must(box, ws, ["status", "--workspace"])).out;
    assert.doesNotMatch(aggregate, /^alpha/m, `alpha is still in the workspace status:\n${aggregate}`);
    assert.match(aggregate, /^beta/m);
});

test("2: archiving says how many open units went with it, and retires none of them", async () =>
{
    const { box, ws, alpha } = await two();
    const units = await mixedWork(box, alpha);
    const done = await archive(box, ws);
    assert.match(done.out, /3 open work units went with it/);
    assert.equal(await statusOf(box, ws, units.active), "active");
    assert.equal(await statusOf(box, ws, units.blocked), "blocked");
    assert.equal(await statusOf(box, ws, units.next), "next");
    const open = (await must(box, ws, ["work", "--project", "alpha"])).out;
    assert.doesNotMatch(open, /retired/, `archiving retired a unit:\n${open}`);
});

test("3: archiving a project that is already archived is refused, naming restore", async () =>
{
    const { box, ws } = await two();
    await archive(box, ws);
    const again = await selfIn(box, ws, ["project", "archive", "alpha", "--why", "again"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already archived/);
    assert.match(again.out, /self project restore alpha/);
});

test("4: archiving without a reason is refused, and the reason is named as required", async () =>
{
    const { box, ws } = await two();
    const bare = await selfIn(box, ws, ["project", "archive", "alpha"]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /--why/);
    assert.match(bare.out, /why the project is being set aside/);
    assert.match((await must(box, ws, ["project"])).out, /^alpha/m, "the refused archive still took the project out of the listing");
});

test("5: archiving a slug this workspace does not have is refused as unknown", async () =>
{
    const { box, ws } = await two();
    const unknown = await selfIn(box, ws, ["project", "archive", "gamma", "--why", "w"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /unknown project "gamma"/);
});

/* ── the way back ──────────────────────────────────────────────────── */

test("6: restoring with no reason brings the project back, with every work unit in the state it was left", async () =>
{
    const { box, ws, alpha } = await two();
    const units = await mixedWork(box, alpha);
    const before = (await must(box, ws, ["work", "--project", "alpha"])).out;
    await archive(box, ws);
    const back = await must(box, ws, ["project", "restore", "alpha"]);
    assert.match(back.out, /project "alpha" is back/);
    assert.match((await must(box, ws, ["project"])).out, /^alpha/m);
    assert.match((await must(box, ws, ["context"])).out, /alpha/);
    assert.match((await must(box, ws, ["status", "--workspace"])).out, /^alpha/m);
    assert.equal((await must(box, ws, ["work", "--project", "alpha"])).out, before);
    assert.equal(await statusOf(box, ws, units.active), "active");
    assert.equal(await statusOf(box, ws, units.blocked), "blocked");
    assert.equal(await statusOf(box, ws, units.next), "next");
});

test("7: restoring a project that is not archived is refused", async () =>
{
    const { box, ws } = await two();
    const nothing = await selfIn(box, ws, ["project", "restore", "alpha"]);
    assert.notEqual(nothing.code, 0);
    assert.match(nothing.out, /not archived/);
    assert.match(nothing.out, /self project --archived/);
});

/* ── what still reads ──────────────────────────────────────────────── */

test("8: the default listing drops the archived slug and leaves the active ones alone", async () =>
{
    const { box, ws, beta } = await two();
    await must(box, beta, ["goal", "add", "beta keeps its goal"]);
    await archive(box, ws);
    const listed = (await must(box, ws, ["project"])).out;
    assert.doesNotMatch(listed, /^alpha/m);
    assert.match(listed, /^beta/m);
    assert.match((await must(box, ws, ["status", "--project", "beta"])).out, /beta keeps its goal/);
});

test("9: --archived lists the archived slug with its reason and the day it was set aside", async () =>
{
    const { box, ws } = await two();
    await archive(box, ws, "alpha", "picked back up next quarter");
    const listed = (await must(box, ws, ["project", "--archived"])).out;
    assert.match(listed, /^alpha —/m);
    assert.match(listed, /picked back up next quarter/);
    assert.match(listed, new RegExp(new Date().toISOString().slice(0, 10)));
    // The one way back is on the row, and it is one that runs from here.
    assert.match(listed, /self project restore alpha/);
    assert.doesNotMatch(listed, /self undo/, `the listing still points at undo:\n${listed}`);
    assert.doesNotMatch(listed, /^beta/m);
});

test("10: a --workspace read leaves the archived project's rows out of the aggregate", async () =>
{
    const { box, ws, alpha, beta } = await two();
    await mustPerson(box, alpha, ["work", "add", "an outcome nobody is chasing"]);
    await mustPerson(box, beta, ["work", "add", "an outcome someone is chasing"]);
    await archive(box, ws);
    const merged = (await must(box, ws, ["log", "--workspace"])).out;
    assert.doesNotMatch(merged, /alpha/, `alpha is still in the merged log:\n${merged}`);
    assert.match(merged, /beta/);
    const summarized = (await must(box, ws, ["status", "--workspace"])).out;
    assert.doesNotMatch(summarized, /^alpha/m);
    assert.match(summarized, /^beta/m);
});

test("11: --project reads the archived project normally, with one line saying it is archived", async () =>
{
    const { box, ws, alpha } = await two();
    const unit = workIdIn((await mustPerson(box, alpha, ["work", "add", "the outcome that was left standing"])).out);
    await archive(box, ws);
    const read = streams(box, ws, ["work", "--project", "alpha"]);
    assert.equal(read.code, 0);
    assert.match(read.out, new RegExp(unit), "the unit stopped being readable through --project");
    assert.match(read.err, /is archived/);
    assert.match(read.err, /self project restore alpha/);
});

test("12: context inside an archived project's checkout renders, and says how it comes back", async () =>
{
    const { box, ws, alpha } = await two();
    await must(box, alpha, ["goal", "add", "the goal alpha was left with"]);
    await archive(box, ws);
    const context = await must(box, alpha, ["context"]);
    assert.match(context.out, /the goal alpha was left with/, "the context stopped rendering");
    assert.match(context.out, /is archived/);
    assert.match(context.out, /self project restore alpha/);
});

/* ── what does not ─────────────────────────────────────────────────── */

test("13: every write inside an archived project's checkout is refused, naming restore", async () =>
{
    const { box, ws, alpha } = await two();
    const unit = workIdIn((await mustPerson(box, alpha, ["work", "add", "the outcome that was left standing"])).out);
    await archive(box, ws);
    const before = events(ws, "alpha").length;
    const refused = [
        ["work", "add", "a new outcome"],
        ["report", unit, "still going"],
        ["decide", "a call made after the archive"],
        ["goal", "add", "a direction set after the archive"],
        ["state", "add", "a note taken after the archive"],
        ["work", "start", unit]
    ];
    for (const args of refused)
    {
        // Driven as a person, so the archive gate is what answers `work add`
        // rather than the person gate in front of it (#389).
        const attempt = await personIn(box, alpha, args);
        assert.notEqual(attempt.code, 0, `\`self ${args.join(" ")}\` was allowed into an archived project`);
        assert.match(attempt.out, /self project restore alpha/, `\`self ${args.join(" ")}\` did not name restore`);
    }
    assert.equal(events(ws, "alpha").length, before, "a refused write still appended to the archived project");
});

test("14: project init inside an archived project's checkout is refused, naming restore", async () =>
{
    const { box, ws, alpha } = await two();
    await archive(box, ws);
    const again = await selfIn(box, alpha, ["project", "init"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /self project restore alpha/);
    assert.match(again.out, /split its state in two/);
});

test("15: an archived project cannot receive a retired outcome's successor", async () =>
{
    const { box, ws, alpha, beta } = await two();
    const successor = workIdIn((await mustPerson(box, alpha, ["work", "add", "where the outcome would go"])).out);
    const source = workIdIn((await mustPerson(box, beta, ["work", "add", "the outcome being moved"])).out);
    await archive(box, ws);
    const moved = await selfIn(box, beta, ["work", "retire", source, "--why", "moved", "--successor", successor,
        "--successor-project", "alpha"]);
    assert.notEqual(moved.code, 0);
    assert.match(moved.out, /cannot receive a successor/);
    assert.match(moved.out, /self project restore alpha/);
    assert.equal(await statusOf(box, ws, successor), "next");
});

/* ── restore is the only way back ──────────────────────────────────── */

test("16: undo refuses an archive event and names restore instead", async () =>
{
    const { box, ws, alpha } = await two();
    const archived = idIn((await archive(box, ws)).out);
    const refused = await selfIn(box, alpha, ["undo", archived, "--why", "the wrong project was named"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /an archive is ended by/);
    assert.match(refused.out, /self project restore alpha/);
    // Refused means refused: the archive is untouched and nothing was appended.
    assert.match((await must(box, ws, ["project", "--archived"])).out, /^alpha —/m);
    assert.doesNotMatch((await must(box, ws, ["project"])).out, /^alpha/m);
    assert.equal(events(ws, "alpha").filter((event) => event.type === "project.restored").length, 0);
});

test("17: restoring with a reason carries it on the restoration event", async () =>
{
    const { box, ws } = await two();
    await archive(box, ws);
    await must(box, ws, ["project", "restore", "alpha", "--why", "the wrong project was named"]);
    assert.match((await must(box, ws, ["project"])).out, /^alpha/m);
    assert.match((await must(box, ws, ["project", "--archived"])).out, /no archived projects/);
    const restored = events(ws, "alpha").filter((event) => event.type === "project.restored");
    assert.equal(restored.length, 1);
    assert.equal(restored[0].payload.why, "the wrong project was named");
    assert.match((await must(box, ws, ["log", "--project", "alpha"])).out, /the wrong project was named/);
    // A restore with no reason is a different record, and says nothing.
    await archive(box, ws, "alpha", "set aside on purpose this time");
    await must(box, ws, ["project", "restore", "alpha"]);
    const plain = events(ws, "alpha").filter((event) => event.type === "project.restored").at(-1);
    assert.equal(plain.payload.why, undefined);
    // A blank reason is that same record, not a third one claiming nothing.
    await archive(box, ws, "alpha", "set aside a third time");
    await must(box, ws, ["project", "restore", "alpha", "--why", "   "]);
    const blank = events(ws, "alpha").filter((event) => event.type === "project.restored").at(-1);
    assert.equal(blank.payload.why, undefined);
});

test("18: archive, restore and the listing all answer without the project's checkout", async () =>
{
    const { box, ws, alpha } = await two();
    await mustPerson(box, alpha, ["work", "add", "the outcome left behind on the other machine"]);
    // The store knows the project; this machine no longer holds its checkout,
    // which is the ordinary case for a project being set aside.
    rmSync(alpha, { recursive: true, force: true });
    await archive(box, ws, "alpha", "its checkout lives on another machine");
    assert.match((await must(box, ws, ["project", "--archived"])).out, /^alpha —/m);
    assert.doesNotMatch((await must(box, ws, ["project"])).out, /^alpha/m);
    const back = await must(box, ws, ["project", "restore", "alpha", "--why", "it was never meant to be archived"]);
    assert.match(back.out, /project "alpha" is back/);
    assert.match((await must(box, ws, ["project"])).out, /^alpha/m);
});

// #287 cell B19. A project holding live workspace-scoped direction cannot be
// archived, because archiving it would take that direction out of every
// project's context at once. A *proposal* is not direction the company has
// taken — it occupies no tier until someone confirms it (#240 R3) — so the
// gate reads confirmed records only, and this archive goes through.
test("cell B19 (#287): a proposed workspace objective does not hold the archive", async () =>
{
    const { box, ws, alpha } = await two();
    await must(box, alpha, ["objective", "add", "the company might reach a hundred teams", "--workspace", "--proposed"]);
    const archived = await archive(box, ws, "alpha", "nobody is working on it this quarter");
    assert.match(archived.out, /project "alpha" is archived/);
});
