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
//   C  `restore` ends an archive that was right; `self undo` takes back one that
//      should never have been written, and the two are different acts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

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
function two()
{
    const box = machine();
    const ws = join(box.root, "ws");
    const alpha = join(ws, "alpha");
    const beta = join(ws, "beta");
    mkdirSync(alpha, { recursive: true });
    mkdirSync(beta, { recursive: true });
    must(box, ws, ["init"]);
    git(box, alpha, ["init", "-q", "-b", "main"]);
    git(box, beta, ["init", "-q", "-b", "main"]);
    must(box, alpha, ["project", "init", "--name", "alpha", "--no-connect"]);
    must(box, beta, ["project", "init", "--name", "beta", "--no-connect"]);
    return { box, ws, alpha, beta };
}

// One unit in each open state the fold can hold, so a round trip has something
// to give back wrongly.
function mixedWork(box, dir)
{
    const active = workIdIn(must(box, dir, ["work", "add", "the active outcome"]).out);
    must(box, dir, ["work", "start", active]);
    const blocked = workIdIn(must(box, dir, ["work", "add", "the blocked outcome"]).out);
    must(box, dir, ["work", "start", blocked]);
    must(box, dir, ["work", "block", blocked, "--on", "dependency", "--why", "waiting on the other one"]);
    const next = workIdIn(must(box, dir, ["work", "add", "the next outcome"]).out);
    return { active, blocked, next };
}

function statusOf(box, ws, id)
{
    const shown = must(box, ws, ["work", "show", id, "--project", "alpha"]).out;
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

test("1: archiving a project with no open work takes it out of the listing, context and aggregates", () =>
{
    const { box, ws } = two();
    archive(box, ws);
    const listed = must(box, ws, ["project"]).out;
    assert.doesNotMatch(listed, /^alpha/m, `alpha is still in the listing:\n${listed}`);
    assert.match(listed, /^beta/m);
    const context = must(box, ws, ["context"]).out;
    assert.doesNotMatch(context, /alpha/, `alpha is still in the workspace context:\n${context}`);
    const aggregate = must(box, ws, ["status", "--workspace"]).out;
    assert.doesNotMatch(aggregate, /^alpha/m, `alpha is still in the workspace status:\n${aggregate}`);
    assert.match(aggregate, /^beta/m);
});

test("2: archiving says how many open units went with it, and retires none of them", () =>
{
    const { box, ws, alpha } = two();
    const units = mixedWork(box, alpha);
    const done = archive(box, ws);
    assert.match(done.out, /3 open work units went with it/);
    assert.equal(statusOf(box, ws, units.active), "active");
    assert.equal(statusOf(box, ws, units.blocked), "blocked");
    assert.equal(statusOf(box, ws, units.next), "next");
    const open = must(box, ws, ["work", "--project", "alpha"]).out;
    assert.doesNotMatch(open, /retired/, `archiving retired a unit:\n${open}`);
});

test("3: archiving a project that is already archived is refused, naming restore", () =>
{
    const { box, ws } = two();
    archive(box, ws);
    const again = selfIn(box, ws, ["project", "archive", "alpha", "--why", "again"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already archived/);
    assert.match(again.out, /self project restore alpha/);
});

test("4: archiving without a reason is refused, and the reason is named as required", () =>
{
    const { box, ws } = two();
    const bare = selfIn(box, ws, ["project", "archive", "alpha"]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /--why/);
    assert.match(bare.out, /why the project is being set aside/);
    assert.match(must(box, ws, ["project"]).out, /^alpha/m, "the refused archive still took the project out of the listing");
});

test("5: archiving a slug this workspace does not have is refused as unknown", () =>
{
    const { box, ws } = two();
    const unknown = selfIn(box, ws, ["project", "archive", "gamma", "--why", "w"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /unknown project "gamma"/);
});

/* ── the way back ──────────────────────────────────────────────────── */

test("6: restoring brings the project back, with every work unit in the state it was left", () =>
{
    const { box, ws, alpha } = two();
    const units = mixedWork(box, alpha);
    const before = must(box, ws, ["work", "--project", "alpha"]).out;
    archive(box, ws);
    const back = must(box, ws, ["project", "restore", "alpha"]);
    assert.match(back.out, /project "alpha" is back/);
    assert.match(must(box, ws, ["project"]).out, /^alpha/m);
    assert.match(must(box, ws, ["context"]).out, /alpha/);
    assert.match(must(box, ws, ["status", "--workspace"]).out, /^alpha/m);
    assert.equal(must(box, ws, ["work", "--project", "alpha"]).out, before);
    assert.equal(statusOf(box, ws, units.active), "active");
    assert.equal(statusOf(box, ws, units.blocked), "blocked");
    assert.equal(statusOf(box, ws, units.next), "next");
});

test("7: restoring a project that is not archived is refused", () =>
{
    const { box, ws } = two();
    const nothing = selfIn(box, ws, ["project", "restore", "alpha"]);
    assert.notEqual(nothing.code, 0);
    assert.match(nothing.out, /not archived/);
    assert.match(nothing.out, /self project --archived/);
});

/* ── what still reads ──────────────────────────────────────────────── */

test("8: the default listing drops the archived slug and leaves the active ones alone", () =>
{
    const { box, ws, beta } = two();
    must(box, beta, ["goal", "add", "beta keeps its goal"]);
    archive(box, ws);
    const listed = must(box, ws, ["project"]).out;
    assert.doesNotMatch(listed, /^alpha/m);
    assert.match(listed, /^beta/m);
    assert.match(must(box, ws, ["status", "--project", "beta"]).out, /beta keeps its goal/);
});

test("9: --archived lists the archived slug with its reason and the day it was set aside", () =>
{
    const { box, ws } = two();
    const archived = idIn(archive(box, ws, "alpha", "picked back up next quarter").out);
    const listed = must(box, ws, ["project", "--archived"]).out;
    assert.match(listed, /^alpha —/m);
    assert.match(listed, /picked back up next quarter/);
    assert.match(listed, new RegExp(new Date().toISOString().slice(0, 10)));
    // Both ways back are on the row, the undo with the id it needs.
    assert.match(listed, /self project restore alpha/);
    assert.match(listed, new RegExp(`self undo ${archived}`));
    assert.doesNotMatch(listed, /^beta/m);
});

test("10: a --workspace read leaves the archived project's rows out of the aggregate", () =>
{
    const { box, ws, alpha, beta } = two();
    must(box, alpha, ["work", "add", "an outcome nobody is chasing"]);
    must(box, beta, ["work", "add", "an outcome someone is chasing"]);
    archive(box, ws);
    const merged = must(box, ws, ["log", "--workspace"]).out;
    assert.doesNotMatch(merged, /alpha/, `alpha is still in the merged log:\n${merged}`);
    assert.match(merged, /beta/);
    const summarized = must(box, ws, ["status", "--workspace"]).out;
    assert.doesNotMatch(summarized, /^alpha/m);
    assert.match(summarized, /^beta/m);
});

test("11: --project reads the archived project normally, with one line saying it is archived", () =>
{
    const { box, ws, alpha } = two();
    const unit = workIdIn(must(box, alpha, ["work", "add", "the outcome that was left standing"]).out);
    archive(box, ws);
    const read = streams(box, ws, ["work", "--project", "alpha"]);
    assert.equal(read.code, 0);
    assert.match(read.out, new RegExp(unit), "the unit stopped being readable through --project");
    assert.match(read.err, /is archived/);
    assert.match(read.err, /self project restore alpha/);
});

test("12: context inside an archived project's checkout renders, and says how it comes back", () =>
{
    const { box, ws, alpha } = two();
    must(box, alpha, ["goal", "add", "the goal alpha was left with"]);
    archive(box, ws);
    const context = must(box, alpha, ["context"]);
    assert.match(context.out, /the goal alpha was left with/, "the context stopped rendering");
    assert.match(context.out, /is archived/);
    assert.match(context.out, /self project restore alpha/);
});

/* ── what does not ─────────────────────────────────────────────────── */

test("13: every write inside an archived project's checkout is refused, naming restore", () =>
{
    const { box, ws, alpha } = two();
    const unit = workIdIn(must(box, alpha, ["work", "add", "the outcome that was left standing"]).out);
    archive(box, ws);
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
        const attempt = selfIn(box, alpha, args);
        assert.notEqual(attempt.code, 0, `\`self ${args.join(" ")}\` was allowed into an archived project`);
        assert.match(attempt.out, /self project restore alpha/, `\`self ${args.join(" ")}\` did not name restore`);
    }
    assert.equal(events(ws, "alpha").length, before, "a refused write still appended to the archived project");
});

test("14: project init inside an archived project's checkout is refused, naming restore", () =>
{
    const { box, ws, alpha } = two();
    archive(box, ws);
    const again = selfIn(box, alpha, ["project", "init"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /self project restore alpha/);
    assert.match(again.out, /split its state in two/);
});

test("15: an archived project cannot receive a retired outcome's successor", () =>
{
    const { box, ws, alpha, beta } = two();
    const successor = workIdIn(must(box, alpha, ["work", "add", "where the outcome would go"]).out);
    const source = workIdIn(must(box, beta, ["work", "add", "the outcome being moved"]).out);
    archive(box, ws);
    const moved = selfIn(box, beta, ["work", "retire", source, "--why", "moved", "--successor", successor,
        "--successor-project", "alpha"]);
    assert.notEqual(moved.code, 0);
    assert.match(moved.out, /cannot receive a successor/);
    assert.match(moved.out, /self project restore alpha/);
    assert.equal(statusOf(box, ws, successor), "next");
});

/* ── undo is not restore ───────────────────────────────────────────── */

test("16: undo takes the archive record back, which restore does not do", () =>
{
    const { box, ws, alpha } = two();
    const archived = idIn(archive(box, ws).out);
    const taken = must(box, alpha, ["undo", archived, "--why", "the wrong project was named"]);
    assert.match(taken.out, /archive record was taken back/);
    assert.match(must(box, ws, ["project"]).out, /^alpha/m);
    assert.match(must(box, ws, ["project", "--archived"]).out, /no archived projects/);
    // The distinction the table draws: an undo names the event it reverses, and
    // a restore names nothing — the archive it ends still stands as history.
    const undone = events(ws, "alpha").find((event) => event.refs?.annuls === archived);
    assert.equal(undone.type, "project.restored");
    archive(box, ws, "alpha", "set aside on purpose this time");
    must(box, ws, ["project", "restore", "alpha"]);
    const restored = events(ws, "alpha").filter((event) => event.type === "project.restored");
    assert.equal(restored[restored.length - 1].refs?.annuls, undefined);
});
