// One placement verb moves any entity to another scope (#181, w-kkbw8).
//
// Every test below is one cell of the case table in the 2026-08-05 comment on
// issue #181, named by its cell id, and asserts that cell's stated outcome.
// The rulings the table stands on:
//
//   D1  scope is a render target, not a storage location — the events stay in
//       the log that already holds them
//   D2  a record scoped to another project stops rendering at home
//   D3  an entity write appends to the log that owns the entity
//   D4  the destination's caps are charged at move time; the source is freed
//   D5  `state place` resolves any record that renders in this project
//   D6  `--scope project` is refused by name, not aliased to omission
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, machine, must, retireFixture, selfIn, workIdIn } from "./harness.mjs";

// Three projects, because a move needs a source, a destination, and a third
// project that must never see the record. Named rather than reusing the
// harness's demo workspace: every assertion below reads a slug.
function trio()
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    must(box, ws, ["init"]);
    const dirs = {};
    for (const slug of ["alpha", "beta", "gamma"])
    {
        const dir = join(ws, slug);
        mkdirSync(dir, { recursive: true });
        git(box, dir, ["init", "-q", "-b", "main"]);
        must(box, dir, ["project", "add", "--name", slug, "--no-connect"]);
        dirs[slug] = dir;
    }
    return { box, ws, ...dirs };
}

// A raw entity prints its own short id; a preset record is named by the event
// that asserted it, which arrives inside [brackets] on the confirmation line.
function entityIn(text)
{
    const short = text.match(/\b[eomw]-[0-9a-z]{5}\b/);
    if (short !== null)
    {
        return short[0];
    }
    const event = text.match(/\[([^\]]+)\]/);
    assert.ok(event !== null, `no entity id in: ${text}`);
    return event[1];
}

function logOf(ws, slug)
{
    const file = join(ws, ".superself", "projects", slug, "log.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function eventsOf(ws, slug)
{
    return logOf(ws, slug).split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

// A commit in the checkout, so `self report` has a HEAD to attach.
function commit(box, dir, message)
{
    writeFileSync(join(dir, `${message.replace(/\W+/g, "-")}.txt`), `${message}\n`);
    git(box, dir, ["add", "-A"]);
    git(box, dir, ["commit", "-q", "-m", message]);
}

function setCaps(ws, caps)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    // One token per character, so a cap below is the character count of the
    // text it gates (#213).
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

/* ── T1 — scope argument parsing ───────────────────────────────────── */

const t1 = trio();

test("T1.1: the flag omitted places the record in the project the directory resolves to", () =>
{
    const id = entityIn(must(t1.box, t1.alpha, ["state", "add", "t1-1 local note"]).out);
    assert.match(must(t1.box, t1.alpha, ["state", "show", id]).out, /placement: project · index/);
    assert.ok(must(t1.box, t1.alpha, ["context"]).out.includes("t1-1 local note"));
    assert.ok(!must(t1.box, t1.beta, ["context"]).out.includes("t1-1 local note"));
});

test("T1.2: --scope workspace renders the record in every project's context", () =>
{
    must(t1.box, t1.alpha, ["state", "add", "t1-2 shared note", "--scope", "workspace"]);
    for (const dir of [t1.alpha, t1.beta, t1.gamma])
    {
        assert.ok(must(t1.box, dir, ["context"]).out.includes("t1-2 shared note"));
    }
});

test("T1.3: --scope naming this project's own slug is recorded, not refused, and reads as the omission", () =>
{
    const id = entityIn(must(t1.box, t1.alpha, ["state", "add", "t1-3 named home", "--scope", "alpha"]).out);
    assert.match(must(t1.box, t1.alpha, ["state", "show", id]).out, /placement: project · index/);
    assert.ok(must(t1.box, t1.alpha, ["context"]).out.includes("t1-3 named home"));
    assert.ok(!must(t1.box, t1.beta, ["context"]).out.includes("t1-3 named home"));
});

test("T1.4: --scope naming another registered slug renders the record in that project only", () =>
{
    must(t1.box, t1.alpha, ["state", "add", "t1-4 destined note", "--scope", "beta"]);
    assert.ok(must(t1.box, t1.beta, ["context"]).out.includes("t1-4 destined note"));
    assert.ok(!must(t1.box, t1.alpha, ["context"]).out.includes("t1-4 destined note"));
    assert.ok(!must(t1.box, t1.gamma, ["context"]).out.includes("t1-4 destined note"));
});

test("T1.5: --scope project is refused by name, and the refusal states the replacement", () =>
{
    const refused = selfIn(t1.box, t1.alpha, ["state", "add", "t1-5", "--scope", "project"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--scope project was retired/);
    assert.match(refused.out, /omit --scope/);
});

test("T1.6: --scope Project and --scope PROJECT are refused with the same message — no case-insensitive rescue", () =>
{
    const expected = selfIn(t1.box, t1.alpha, ["state", "add", "t1-6", "--scope", "project"]).out;
    for (const spelling of ["Project", "PROJECT"])
    {
        const refused = selfIn(t1.box, t1.alpha, ["state", "add", "t1-6", "--scope", spelling]);
        assert.notEqual(refused.code, 0);
        assert.equal(refused.out, expected);
    }
});

test("T1.7: an unregistered slug is refused, naming self project as the way to list the registered ones", () =>
{
    const refused = selfIn(t1.box, t1.alpha, ["state", "add", "t1-7", "--scope", "delta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"delta" is not a registered project/);
    assert.match(refused.out, /self project/);
});

test("T1.8: --scope workspace=<anything> is refused — workspace takes no value", () =>
{
    const refused = selfIn(t1.box, t1.alpha, ["state", "add", "t1-8", "--scope", "workspace=beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--scope workspace takes no value/);
});

test("T1.9: an empty --scope is refused as empty, never read as the omission", () =>
{
    const refused = selfIn(t1.box, t1.alpha, ["state", "add", "t1-9", "--scope", ""]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /it cannot be empty/);
});

test("T1.10: self project add refuses the slug workspace as reserved", () =>
{
    const dir = join(t1.ws, "reserved");
    mkdirSync(dir, { recursive: true });
    git(t1.box, dir, ["init", "-q", "-b", "main"]);
    const refused = selfIn(t1.box, dir, ["project", "add", "--name", "workspace", "--no-connect"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"workspace" is reserved/);
});

/* ── T2 — the move, by lifecycle × record kind ─────────────────────── */

const t2 = trio();

// `state place <id> --scope beta --why "<reason>"`, run in the project the
// record currently renders in.
function moveToBeta(id, why = "belongs to beta")
{
    return must(t2.box, t2.alpha, ["state", "place", id, "--scope", "beta", "--why", why]);
}

function placementOf(dir, id)
{
    return must(t2.box, dir, ["state", "show", id]).out.match(/placement: .*/)[0];
}

test("T2.1: a confirmed decision moves, and the entity.placed event carries the scope and the why", () =>
{
    const id = entityIn(must(t2.box, t2.alpha, ["decide", "t2-1 a settled call", "--why", "recorded"]).out);
    moveToBeta(id, "the call belongs to beta");
    assert.equal(placementOf(t2.beta, id), "placement: beta · index · priority 40");
    const placed = eventsOf(t2.ws, "alpha").filter((event) => event.type === "entity.placed" && event.payload.entity === id);
    assert.equal(placed.length, 1);
    assert.equal(placed[0].payload.scope, "beta");
    assert.equal(placed[0].payload.why, "the call belongs to beta");
});

test("T2.2: a confirmed objective moves, and its milestones and linked work keep pointing at it", () =>
{
    const objective = entityIn(must(t2.box, t2.alpha, ["objective", "add", "t2-2 an outcome"]).out);
    const milestone = entityIn(must(t2.box, t2.alpha, ["milestone", "add", "t2-2 a checkpoint", "--objective", objective, "--exit", "the checkpoint holds"]).out);
    const work = workIdIn(must(t2.box, t2.alpha, ["work", "add", "t2-2 the doing"]).out);
    must(t2.box, t2.alpha, ["work", "link", work, "--objective", objective]);
    moveToBeta(objective);
    assert.match(placementOf(t2.beta, objective), /placement: beta/);
    assert.ok(must(t2.box, t2.alpha, ["state", "show", milestone]).out.includes(`member-of ${objective}`));
    assert.ok(must(t2.box, t2.alpha, ["work", "show", work]).out.includes(objective));
});

test("T2.3: a confirmed milestone moves; its objective is unmoved and the link still resolves", () =>
{
    const objective = entityIn(must(t2.box, t2.alpha, ["objective", "add", "t2-3 an outcome"]).out);
    const milestone = entityIn(must(t2.box, t2.alpha, ["milestone", "add", "t2-3 a checkpoint", "--objective", objective, "--exit", "the checkpoint holds"]).out);
    moveToBeta(milestone);
    assert.match(placementOf(t2.beta, milestone), /placement: beta/);
    assert.match(placementOf(t2.alpha, objective), /placement: project/);
    assert.ok(must(t2.box, t2.beta, ["state", "show", milestone]).out.includes(`member-of ${objective}`));
});

test("T2.4: a confirmed convention moves, and stops rendering in the source's convention list", () =>
{
    const id = entityIn(must(t2.box, t2.alpha, ["convention", "add", "t2-4 one shared rule"]).out);
    assert.ok(must(t2.box, t2.alpha, ["context"]).out.includes("t2-4 one shared rule"));
    moveToBeta(id);
    assert.ok(!must(t2.box, t2.alpha, ["context"]).out.includes("t2-4 one shared rule"));
    assert.ok(must(t2.box, t2.beta, ["context"]).out.includes("t2-4 one shared rule"));
});

test("T2.5: a confirmed goal moves", () =>
{
    const id = entityIn(must(t2.box, t2.alpha, ["goal", "add", "t2-5 the long direction"]).out);
    moveToBeta(id);
    assert.match(placementOf(t2.beta, id), /placement: beta/);
    assert.ok(must(t2.box, t2.beta, ["context"]).out.includes("t2-5 the long direction"));
});

test("T2.6: an open work unit moves, and its brief, reports and evidence render at the destination", () =>
{
    const work = workIdIn(must(t2.box, t2.alpha, ["work", "add", "t2-6 an open outcome"]).out);
    commit(t2.box, t2.alpha, "t2-6 evidence");
    must(t2.box, t2.alpha, ["report", work, "t2-6 the first report"]);
    moveToBeta(work);
    const shown = must(t2.box, t2.beta, ["work", "show", work]).out;
    assert.ok(shown.includes("t2-6 an open outcome"), "the brief did not render at the destination");
    assert.ok(shown.includes("t2-6 the first report"), "the report did not render at the destination");
    assert.match(shown, /- Evidence: [0-9a-f]{7}/, "the evidence did not render at the destination");
    assert.ok(must(t2.box, t2.beta, ["work"]).out.includes(work));
});

test("T2.7: a started unit moves, and the holder note travels with it", () =>
{
    const work = workIdIn(must(t2.box, t2.alpha, ["work", "add", "t2-7 a held outcome"]).out);
    must(t2.box, t2.alpha, ["work", "start", work], { SUPERSELF_SESSION: "t2-7-holder" });
    moveToBeta(work);
    const shown = must(t2.box, t2.beta, ["work", "show", work], { SUPERSELF_SESSION: "t2-7-other" }).out;
    assert.match(shown, /held by/);
});

test("T2.8: a blocked unit moves, and its block reason and --on are unchanged", () =>
{
    const work = workIdIn(must(t2.box, t2.alpha, ["work", "add", "t2-8 a parked outcome"]).out);
    must(t2.box, t2.alpha, ["work", "block", work, "--on", "dependency", "--why", "t2-8 waiting on the other half"]);
    moveToBeta(work);
    const shown = must(t2.box, t2.beta, ["work", "show", work]).out;
    assert.ok(shown.includes("dependency"));
    assert.ok(shown.includes("t2-8 waiting on the other half"));
});

test("T2.9: a done unit moves — a finished unit in the wrong project still misfiles its artifacts", () =>
{
    const work = workIdIn(must(t2.box, t2.alpha, ["work", "add", "t2-9 a finished outcome"]).out);
    commit(t2.box, t2.alpha, "t2-9 evidence");
    must(t2.box, t2.alpha, ["report", work, "t2-9 what happened"]);
    must(t2.box, t2.alpha, ["work", "done", work]);
    moveToBeta(work);
    assert.match(placementOf(t2.beta, work), /placement: beta/);
    assert.ok(must(t2.box, t2.beta, ["work", "show", work]).out.includes("t2-9 a finished outcome"));
});

test("T2.10: a retired unit moves, and its successor pointer is unchanged", () =>
{
    const work = workIdIn(must(t2.box, t2.alpha, ["work", "add", "t2-10 a given-up outcome"]).out);
    const successor = workIdIn(must(t2.box, t2.alpha, ["work", "add", "t2-10 the outcome now"]).out);
    retireFixture(t2.box, t2.ws, "alpha", "entity.retired",
        { entity: work, why: "t2-10 moved on", successor, successorProject: "alpha" });
    moveToBeta(work);
    assert.match(placementOf(t2.beta, work), /placement: beta/);
    assert.ok(must(t2.box, t2.beta, ["work", "show", work]).out.includes(successor));
});

test("T2.11: a proposed record is refused — placement moves confirmed records", () =>
{
    const id = entityIn(must(t2.box, t2.alpha, ["state", "add", "t2-11 a proposal", "--proposed"]).out);
    const refused = selfIn(t2.box, t2.alpha, ["state", "place", id, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is still proposed — placement moves confirmed records/);
});

test("T2.12: a retracted record is refused — a withdrawn record has no placement", () =>
{
    const id = entityIn(must(t2.box, t2.alpha, ["state", "add", "t2-12 a withdrawn note"]).out);
    retireFixture(t2.box, t2.ws, "alpha", "entity.retracted", { entity: id, why: "t2-12 taken back" }, { retracts: id });
    const refused = selfIn(t2.box, t2.alpha, ["state", "place", id, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /was retracted — a withdrawn record no longer renders/);
});

test("T2.13: a superseded record is refused, naming the successor to place instead", () =>
{
    const older = entityIn(must(t2.box, t2.alpha, ["state", "add", "t2-13 the earlier wording"]).out);
    const newer = entityIn(must(t2.box, t2.alpha, ["state", "add", "t2-13 the later wording"]).out);
    retireFixture(t2.box, t2.ws, "alpha", "entity.superseded", { entity: older, successor: newer });
    const refused = selfIn(t2.box, t2.alpha, ["state", "place", older, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`was superseded by ${newer} — place the successor instead`));
});

test("T2.14: a report is refused — it is not independently placed, it moves with its work unit", () =>
{
    const work = workIdIn(must(t2.box, t2.alpha, ["work", "add", "t2-14 a reported outcome"]).out);
    commit(t2.box, t2.alpha, "t2-14 evidence");
    must(t2.box, t2.alpha, ["report", work, "t2-14 the report body"]);
    const report = eventsOf(t2.ws, "alpha").find((event) => event.type === "report.added" && event.refs?.work === work).id;
    const refused = selfIn(t2.box, t2.alpha, ["state", "place", report, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is a report of/);
    assert.match(refused.out, /it moves with its work unit/);
});

test("T2.15: an artifact is refused for the same reason", () =>
{
    const work = workIdIn(must(t2.box, t2.alpha, ["work", "add", "t2-15 an attaching outcome"]).out);
    const file = join(t2.alpha, "t2-15-artifact.txt");
    writeFileSync(file, "t2-15 bytes\n");
    commit(t2.box, t2.alpha, "t2-15 evidence");
    must(t2.box, t2.alpha, ["report", work, "t2-15 with an artifact", "--artifact", file]);
    const artifact = must(t2.box, t2.alpha, ["work", "show", work]).out.match(/\ba-[0-9a-z]{5}\b/)[0];
    const refused = selfIn(t2.box, t2.alpha, ["state", "place", artifact, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is an artifact of/);
    assert.match(refused.out, /it moves with its work unit/);
});

test("T2.16: placing a record at its current scope is refused as no change", () =>
{
    const id = entityIn(must(t2.box, t2.alpha, ["state", "add", "t2-16 a settled placement"]).out);
    const home = selfIn(t2.box, t2.alpha, ["state", "place", id, "--scope", "alpha"]);
    assert.notEqual(home.code, 0);
    assert.match(home.out, /already sits at that placement — nothing changes/);
    moveToBeta(id);
    const away = selfIn(t2.box, t2.beta, ["state", "place", id, "--scope", "beta"]);
    assert.notEqual(away.code, 0);
    assert.match(away.out, /already sits at that placement — nothing changes/);
});

test("T2.17: a cross-project move with --why omitted is recorded without why", () =>
{
    const id = entityIn(must(t2.box, t2.alpha, ["state", "add", "t2-17 a reasonless move"]).out);
    must(t2.box, t2.alpha, ["state", "place", id, "--scope", "beta"]);
    assert.match(placementOf(t2.beta, id), /placement: beta/);
    const placed = eventsOf(t2.ws, "alpha").filter((event) => event.type === "entity.placed" && event.payload.entity === id);
    assert.equal(placed.length, 1);
    assert.equal(placed[0].payload.why, undefined);
});

test("T2.18: a done unit moves back to its home project — D5 makes it resolvable from the destination", () =>
{
    const work = workIdIn(must(t2.box, t2.alpha, ["work", "add", "t2-18 a returning outcome"]).out);
    commit(t2.box, t2.alpha, "t2-18 evidence");
    must(t2.box, t2.alpha, ["report", work, "t2-18 what happened"]);
    must(t2.box, t2.alpha, ["work", "done", work]);
    moveToBeta(work);
    must(t2.box, t2.beta, ["state", "place", work, "--scope", "alpha", "--why", "filed here after all"]);
    assert.match(placementOf(t2.alpha, work), /placement: project/);
    assert.ok(!must(t2.box, t2.beta, ["work"]).out.includes(work));
});

/* ── T3 — what renders after a move ────────────────────────────────── */

// Record R lives in alpha's log, scoped to beta.
const t3 = trio();
const t3Entity = entityIn(must(t3.box, t3.alpha, ["state", "add", "t3 the moved note", "--priority", "5"]).out);
const t3Work = workIdIn(must(t3.box, t3.alpha, ["work", "add", "t3 the moved outcome"]).out);
must(t3.box, t3.alpha, ["state", "place", t3Entity, "--scope", "beta", "--why", "belongs to beta"]);
must(t3.box, t3.alpha, ["state", "place", t3Work, "--scope", "beta", "--why", "belongs to beta"]);

test("T3.1: self context in the destination renders R at its priority, among the destination's own records", () =>
{
    must(t3.box, t3.beta, ["state", "add", "t3 a beta note", "--priority", "9"]);
    const out = must(t3.box, t3.beta, ["context"]).out;
    assert.ok(out.includes("t3 the moved note"));
    assert.ok(out.indexOf("t3 the moved note") < out.indexOf("t3 a beta note"), "priority 5 did not render ahead of priority 9");
});

test("T3.2: self context in the source is absent of R", () =>
{
    const out = must(t3.box, t3.alpha, ["context"]).out;
    assert.ok(!out.includes("t3 the moved note"));
    assert.ok(!out.includes("t3 the moved outcome"));
});

test("T3.3: self context in a third project is absent of R", () =>
{
    const out = must(t3.box, t3.gamma, ["context"]).out;
    assert.ok(!out.includes("t3 the moved note"));
    assert.ok(!out.includes("t3 the moved outcome"));
});

test("T3.4: the workspace-wide context renders R once, attributed to the destination", () =>
{
    // `self context` outside a project is the workspace form; there is no
    // --workspace flag on the verb. One line per project, so R is counted in
    // beta's line and in no other.
    const lines = must(t3.box, t3.ws, ["context"]).out.split("\n").filter((line) => line.trim() !== "");
    const of = (slug) => lines.find((line) => line.startsWith(`${slug} —`));
    assert.match(of("beta"), /1 next/);
    assert.match(of("alpha"), /0 next/);
    assert.match(of("gamma"), /0 next/);
});

test("T3.5: self work in the destination lists the moved unit", () =>
{
    assert.ok(must(t3.box, t3.beta, ["work"]).out.includes(t3Work));
});

test("T3.6: self work in the source does not list it", () =>
{
    assert.ok(!must(t3.box, t3.alpha, ["work"]).out.includes(t3Work));
});

test("T3.7: self work show in the source resolves and states the record now renders in the destination", () =>
{
    const out = must(t3.box, t3.alpha, ["work", "show", t3Work]).out;
    assert.ok(out.includes("t3 the moved outcome"));
    assert.match(out, new RegExp(`${t3Work} renders in beta; its record lives in alpha`));
});

test("T3.8: self search from the source finds R, with its current scope named", () =>
{
    const out = must(t3.box, t3.alpha, ["search", "t3 the moved note", "--type", "entity"]).out;
    assert.ok(out.includes("t3 the moved note"));
    assert.match(out, /\[renders in beta\]/);
});

test("T3.9: a record scoped to workspace still renders in every project", () =>
{
    must(t3.box, t3.alpha, ["state", "place", t3Entity, "--scope", "workspace"]);
    for (const dir of [t3.alpha, t3.beta, t3.gamma])
    {
        assert.ok(must(t3.box, dir, ["context"]).out.includes("t3 the moved note"), "a workspace record missed a project");
    }
    must(t3.box, t3.alpha, ["state", "place", t3Entity, "--scope", "beta"]);
});

test("T3.11: the synced work file for a moved unit stays under its home store, never duplicated at the destination", () =>
{
    assert.ok(existsSync(join(t3.ws, ".superself", "projects", "alpha", "work", `${t3Work}.md`)));
    assert.ok(!existsSync(join(t3.ws, ".superself", "projects", "beta", "work", `${t3Work}.md`)));
});

// Unregistering is the last of this block, because it takes the destination
// out of the workspace for every test after it.
test("T3.10: with the destination unregistered, R renders nowhere and self project names the dangling scope", () =>
{
    const registry = join(t3.ws, ".superself", "registry.jsonl");
    const kept = readFileSync(registry, "utf8").split("\n")
        .filter((line) => line.trim() !== "" && JSON.parse(line).slug !== "beta");
    writeFileSync(registry, kept.map((line) => line + "\n").join(""));
    for (const dir of [t3.alpha, t3.gamma])
    {
        assert.ok(!must(t3.box, dir, ["context"]).out.includes("t3 the moved note"));
    }
    const listed = must(t3.box, t3.alpha, ["project"]).out;
    assert.match(listed, new RegExp(`dangling scope: ${t3Entity} in alpha renders in "beta"`));
});

/* ── the listing verb the refusals point at ────────────────────────── */

// Not a table cell: `self project` is a verb this change ships, and
// CONTRIBUTING asks a new verb for coverage of what it adds and of its
// refusal path. The diagnostic it also carries is T3.10 above.

test("self project lists the registered slugs and marks the one this directory resolves to", () =>
{
    const t = trio();
    const listed = must(t.box, t.beta, ["project"]).out;
    for (const slug of ["alpha", "beta", "gamma"])
    {
        assert.match(listed, new RegExp(`^${slug}`, "m"));
    }
    assert.match(listed, /^beta.*\(this directory\)/m);
    assert.doesNotMatch(listed, /^alpha.*\(this directory\)/m);
});

test("self project refuses a subcommand it does not have, with the usage it does", () =>
{
    const t = trio();
    const refused = selfIn(t.box, t.alpha, ["project", "remove", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /usage: self project \| add \[path\]/);
    assert.match(refused.out, /link \[slug\] \[path\]/);
});

/* ── T4 — writes after a move ──────────────────────────────────────── */

// Work unit W lives in alpha's log, scoped to beta.
const t4 = trio();

function movedUnit(outcome)
{
    const work = workIdIn(must(t4.box, t4.alpha, ["work", "add", outcome]).out);
    must(t4.box, t4.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    return work;
}

test("T4.1: work start in the destination prints the brief and records the claim into the home log", () =>
{
    const work = movedUnit("t4-1 a startable outcome");
    const before = eventsOf(t4.ws, "beta").length;
    const out = must(t4.box, t4.beta, ["work", "start", work], { SUPERSELF_SESSION_PID: "777001" }).out;
    assert.ok(out.includes("t4-1 a startable outcome"), "the brief was not printed");
    const started = eventsOf(t4.ws, "alpha").filter((event) => event.type === "entity.started" && event.payload.entity === work);
    assert.equal(started.length, 1);
    assert.equal(eventsOf(t4.ws, "beta").length, before, "a write about a scoped-in record reached the destination's log");
});

test("T4.2: report in the destination records into the home log, with evidence from the destination's checkout HEAD", () =>
{
    const work = movedUnit("t4-2 a reportable outcome");
    commit(t4.box, t4.beta, "t4-2 beta head");
    must(t4.box, t4.beta, ["report", work, "t4-2 the report body"]);
    const reports = eventsOf(t4.ws, "alpha").filter((event) => event.type === "report.added" && event.refs?.work === work);
    assert.equal(reports.length, 1);
    const head = must(t4.box, t4.beta, ["work", "show", work]).out;
    assert.ok(head.includes("t4-2 the report body"));
    assert.ok(reports[0].refs.commits.length > 0, "no evidence was attached from the checkout the command ran in");
});

test("T4.3: work done in the destination closes the unit, with the evidence rule unchanged", () =>
{
    const work = movedUnit("t4-3 a closable outcome");
    const bare = selfIn(t4.box, t4.beta, ["work", "done", work]);
    assert.notEqual(bare.code, 0, "done without evidence was admitted");
    must(t4.box, t4.beta, ["work", "done", work, "--report", "t4-3 what verifiably happened"]);
    assert.ok(!must(t4.box, t4.beta, ["work"]).out.includes(work));
    assert.equal(eventsOf(t4.ws, "alpha").filter((event) => event.type === "entity.done" && event.payload.entity === work).length, 1);
});

test("T4.4: work block in the destination blocks the unit", () =>
{
    const work = movedUnit("t4-4 a blockable outcome");
    must(t4.box, t4.beta, ["work", "block", work, "--on", "decision", "--why", "t4-4 waiting on a call"]);
    assert.equal(eventsOf(t4.ws, "alpha").filter((event) => event.type === "entity.blocked" && event.payload.entity === work).length, 1);
    assert.ok(must(t4.box, t4.beta, ["work", "show", work]).out.includes("t4-4 waiting on a call"));
});

test("T4.5: the same writes run in the source resolve and succeed — the home log always answers for its own record", () =>
{
    const work = movedUnit("t4-5 an outcome written from home");
    must(t4.box, t4.alpha, ["work", "start", work], { SUPERSELF_SESSION_PID: "777005" });
    commit(t4.box, t4.alpha, "t4-5 alpha head");
    must(t4.box, t4.alpha, ["report", work, "t4-5 reported from home"]);
    must(t4.box, t4.alpha, ["work", "block", work, "--on", "external", "--why", "t4-5 parked from home"]);
    must(t4.box, t4.alpha, ["work", "done", work, "--report", "t4-5 finished from home"]);
    assert.equal(eventsOf(t4.ws, "alpha").filter((event) => event.type === "entity.done" && event.payload.entity === work).length, 1);
});

test("T4.6: the same writes run in a third project are refused as an unknown id", () =>
{
    const work = movedUnit("t4-6 an outcome invisible to gamma");
    for (const args of [["work", "start", work], ["report", work, "x"], ["work", "done", work, "--report", "x"],
        ["work", "block", work, "--on", "decision", "--why", "x"]])
    {
        const refused = selfIn(t4.box, t4.gamma, args);
        assert.notEqual(refused.code, 0, `${args.join(" ")} was not refused in a project the unit does not render in`);
        assert.match(refused.out, new RegExp(`unknown work id "${work}"`));
    }
});

test("T4.7: work add in the destination is born there — D3 does not change where an add lands", () =>
{
    const work = workIdIn(must(t4.box, t4.beta, ["work", "add", "t4-7 a native beta outcome"]).out);
    assert.ok(logOf(t4.ws, "beta").includes(work));
    assert.ok(!logOf(t4.ws, "alpha").includes(work));
    assert.ok(must(t4.box, t4.beta, ["work"]).out.includes(work));
});

test("T4.8: two sessions, one in each project, both append to the home log with no coordination added", () =>
{
    const work = movedUnit("t4-8 a contested outcome");
    commit(t4.box, t4.alpha, "t4-8 alpha head");
    commit(t4.box, t4.beta, "t4-8 beta head");
    must(t4.box, t4.alpha, ["report", work, "t4-8 from the source"], { SUPERSELF_SESSION_PID: "777081" });
    must(t4.box, t4.beta, ["report", work, "t4-8 from the destination"], { SUPERSELF_SESSION_PID: "777082" });
    const reports = eventsOf(t4.ws, "alpha").filter((event) => event.type === "report.added" && event.refs?.work === work);
    assert.equal(reports.length, 2);
    assert.equal(eventsOf(t4.ws, "beta").filter((event) => event.refs?.work === work).length, 0);
});

test("T4.9: state place in the destination moves the unit on again, with the home log still owning it", () =>
{
    const work = movedUnit("t4-9 a twice-moved outcome");
    must(t4.box, t4.beta, ["state", "place", work, "--scope", "gamma", "--why", "gamma after all"]);
    assert.ok(must(t4.box, t4.gamma, ["work"]).out.includes(work));
    assert.ok(!must(t4.box, t4.beta, ["work"]).out.includes(work));
    assert.equal(eventsOf(t4.ws, "beta").filter((event) => event.payload.entity === work).length, 0);
    assert.equal(eventsOf(t4.ws, "alpha").filter((event) =>
        event.type === "entity.placed" && event.payload.entity === work && event.payload.scope === "gamma").length, 1);
});

/* ── T5 — caps at the destination ──────────────────────────────────── */

// One workspace per cell: each cell states a tier's exact fill, and sharing a
// store between them would make the numbers depend on test order.
const SEAT = "beta holds this seat";
const MOVER = "a mover";

// The records first, under a cap wide enough to admit them, then the cap
// lowered onto the destination tier — so the tier's fill is exactly the text
// this cell put there rather than an arithmetic guess.
function capped(seats, caps)
{
    const t = trio();
    setCaps(t.ws, { indexTokens: 4000, fullTokens: 4000 });
    const mover = entityIn(must(t.box, t.alpha, ["state", "add", MOVER]).out);
    const held = [];
    for (let index = 0; index < seats; index += 1)
    {
        held.push(entityIn(must(t.box, t.beta, ["state", "add", `${SEAT}${"!".repeat(index)}`,
            ...(caps.fullTokens === undefined ? [] : ["--exposure", "full"])]).out));
    }
    setCaps(t.ws, caps);
    return { ...t, mover, seats: held };
}

test("T5.1: with room available, a move in is accepted", () =>
{
    const t = capped(1, { indexTokens: SEAT.length + MOVER.length });
    must(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta"]);
    assert.match(must(t.box, t.beta, ["state", "show", t.mover]).out, /placement: beta · index/);
});

test("T5.2: at the destination's cap, a move in is refused, naming the cap and the destination", () =>
{
    const t = capped(1, { indexTokens: SEAT.length });
    const refused = selfIn(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`the beta index tier holds ${SEAT.length} of ${SEAT.length} tokens`));
});

test("T5.3: at the cap, --demote naming one of the destination's records is accepted", () =>
{
    const t = capped(1, { indexTokens: SEAT.length });
    must(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta", "--demote", t.seats[0]]);
    assert.match(must(t.box, t.beta, ["state", "show", t.mover]).out, /placement: beta · index/);
    assert.match(must(t.box, t.beta, ["state", "show", t.seats[0]]).out, /placement: project · search/);
});

test("T5.4: at the cap, --demote naming a source-project record is refused — a demotion frees a seat in the tier being entered", () =>
{
    const t = capped(1, { indexTokens: SEAT.length });
    const local = entityIn(must(t.box, t.alpha, ["state", "add", "a home seat"]).out);
    const refused = selfIn(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta", "--demote", local]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is project-scoped — the beta index cap frees only by demoting beta-scoped records/);
});

test("T5.5: with the destination already over its cap, a move in is refused", () =>
{
    const t = capped(2, { indexTokens: SEAT.length });
    const refused = selfIn(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`the beta index tier holds \\d+ of ${SEAT.length} tokens`));
});

test("T5.6: with the source tier at its cap and the destination free, the move out is accepted and frees the source", () =>
{
    const t = trio();
    setCaps(t.ws, { indexTokens: 4000 });
    const seat = entityIn(must(t.box, t.alpha, ["state", "add", SEAT]).out);
    setCaps(t.ws, { indexTokens: SEAT.length });
    const blocked = selfIn(t.box, t.alpha, ["state", "add", MOVER]);
    assert.notEqual(blocked.code, 0, "the source tier was not actually at its cap");
    must(t.box, t.alpha, ["state", "place", seat, "--scope", "beta"]);
    must(t.box, t.alpha, ["state", "add", MOVER]);
});

test("T5.7: a move into search exposure is accepted regardless of the cap — the search tier is uncapped", () =>
{
    const t = capped(1, { indexTokens: SEAT.length });
    must(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta", "--exposure", "search",
        "--why", "found by search only"]);
    assert.match(must(t.box, t.beta, ["state", "show", t.mover]).out, /placement: beta · search/);
});

test("T5.8: a move plus --exposure full in one call applies both, charged against the destination's full tier", () =>
{
    const tight = capped(1, { fullTokens: SEAT.length, indexTokens: 4000 });
    const refused = selfIn(tight.box, tight.alpha, ["state", "place", tight.mover, "--scope", "beta", "--exposure", "full"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`the beta full tier holds ${SEAT.length} of ${SEAT.length} tokens`));
    const roomy = capped(1, { fullTokens: SEAT.length + MOVER.length, indexTokens: 4000 });
    must(roomy.box, roomy.alpha, ["state", "place", roomy.mover, "--scope", "beta", "--exposure", "full"]);
    assert.match(must(roomy.box, roomy.beta, ["state", "show", roomy.mover]).out, /placement: beta · full/);
});

/* ── T6 — relationships across the move ────────────────────────────── */

const t6 = trio();

test("T6.1: a unit blocked on the moved one keeps its blocker, and the dependency names it at its new scope", () =>
{
    const moved = workIdIn(must(t6.box, t6.alpha, ["work", "add", "t6-1 the blocking outcome"]).out);
    const dependent = workIdIn(must(t6.box, t6.alpha, ["work", "add", "t6-1 the waiting outcome"]).out);
    must(t6.box, t6.alpha, ["work", "block", dependent, "--on", "dependency", "--why", `waits on ${moved}`]);
    must(t6.box, t6.alpha, ["state", "place", moved, "--scope", "beta", "--why", "belongs to beta"]);
    const shown = must(t6.box, t6.alpha, ["work", "show", dependent]).out;
    assert.ok(shown.includes(`waits on ${moved}`), "the dependent lost its blocker");
    assert.match(must(t6.box, t6.alpha, ["work", "show", moved]).out, new RegExp(`${moved} renders in beta`));
});

test("T6.2: evidence commits produced in the source repository are not re-resolved against the destination", () =>
{
    const work = workIdIn(must(t6.box, t6.alpha, ["work", "add", "t6-2 an evidenced outcome"]).out);
    commit(t6.box, t6.alpha, "t6-2 alpha evidence");
    must(t6.box, t6.alpha, ["report", work, "t6-2 the report"]);
    const before = eventsOf(t6.ws, "alpha").find((event) => event.type === "report.added" && event.refs?.work === work).refs.commits;
    must(t6.box, t6.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    const after = eventsOf(t6.ws, "alpha").find((event) => event.type === "report.added" && event.refs?.work === work).refs.commits;
    assert.deepEqual(after, before, "the move rewrote the evidence the source repository produced");
    assert.ok(must(t6.box, t6.beta, ["work", "show", work]).out.includes(before[0].slice(0, 7)));
});

test("T6.3: evidence that no longer resolves stays visible as unresolved rather than dropped", () =>
{
    const work = workIdIn(must(t6.box, t6.alpha, ["work", "add", "t6-3 an unresolvable outcome"]).out);
    const dangling = "0".repeat(40);
    must(t6.box, t6.alpha, ["report", work, "t6-3 the report", "--evidence", dangling]);
    must(t6.box, t6.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    const shown = must(t6.box, t6.beta, ["work", "show", work]).out;
    assert.ok(shown.includes(dangling.slice(0, 7)), "unresolvable evidence disappeared from the page");
});

test("T6.4: the moved unit's artifacts resolve at the destination with their recorded declaration unchanged", () =>
{
    const work = workIdIn(must(t6.box, t6.alpha, ["work", "add", "t6-4 an attaching outcome"]).out);
    const file = join(t6.alpha, "t6-4-artifact.txt");
    writeFileSync(file, "t6-4 bytes\n");
    commit(t6.box, t6.alpha, "t6-4 evidence");
    must(t6.box, t6.alpha, ["report", work, "t6-4 with an artifact", "--artifact", file]);
    const declared = eventsOf(t6.ws, "alpha")
        .find((event) => event.type === "report.added" && event.refs?.work === work).payload.artifacts;
    must(t6.box, t6.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    const after = eventsOf(t6.ws, "alpha")
        .find((event) => event.type === "report.added" && event.refs?.work === work).payload.artifacts;
    assert.deepEqual(after, declared);
    assert.ok(must(t6.box, t6.beta, ["work", "show", work]).out.includes(declared[0].name));
    assert.ok(must(t6.box, t6.beta, ["artifact", "list", "--work", work, "--project", "alpha"]).out.includes(declared[0].id));
});

test("T6.5: the moved unit's reports render at the destination with their original timestamps", () =>
{
    const work = workIdIn(must(t6.box, t6.alpha, ["work", "add", "t6-5 a reported outcome"]).out);
    commit(t6.box, t6.alpha, "t6-5 evidence");
    must(t6.box, t6.alpha, ["report", work, "t6-5 the earlier report"]);
    const stamped = eventsOf(t6.ws, "alpha").find((event) => event.type === "report.added" && event.refs?.work === work).ts;
    must(t6.box, t6.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    const shown = must(t6.box, t6.beta, ["work", "show", work]).out;
    assert.ok(shown.includes("t6-5 the earlier report"));
    assert.ok(shown.includes(stamped.slice(0, 10)), "the report lost its original date at the destination");
});

test("T6.6: a record superseding a moved record resolves its lineage across the scope change", () =>
{
    const older = entityIn(must(t6.box, t6.alpha, ["state", "add", "t6-6 the earlier wording"]).out);
    must(t6.box, t6.alpha, ["state", "place", older, "--scope", "beta", "--why", "belongs to beta"]);
    const newer = entityIn(must(t6.box, t6.alpha, ["state", "add", "t6-6 the later wording"]).out);
    retireFixture(t6.box, t6.ws, "alpha", "entity.superseded", { entity: older, successor: newer });
    const shown = must(t6.box, t6.alpha, ["state", "show", older]).out;
    assert.match(shown, /superseded/);
    assert.ok(shown.includes(newer), "the lineage did not resolve across the scope change");
});

test("T6.7: an id that exists in both projects keeps the ambiguity error, and --project disambiguates", () =>
{
    const work = workIdIn(must(t6.box, t6.alpha, ["work", "add", "t6-7 the alpha outcome"]).out);
    // The same id in beta's log: two clones minting the same short id is the
    // collision the ambiguity error exists for.
    retireFixture(t6.box, t6.ws, "beta", "entity.confirmed",
        { entity: work, text: "t6-7 the beta outcome", labels: ["work"], links: [], criteria: [], exposure: "search", scope: "project" });
    const ambiguous = selfIn(t6.box, t6.gamma, ["work", "show", work]);
    assert.notEqual(ambiguous.code, 0);
    assert.match(ambiguous.out, /exists in more than one project \(alpha, beta\)/);
    assert.ok(must(t6.box, t6.gamma, ["work", "show", work, "--project", "beta"]).out.includes("t6-7 the beta outcome"));
});

test("T6.8: a moved unit linked to an objective in the source keeps the link, and the objective does not move", () =>
{
    const objective = entityIn(must(t6.box, t6.alpha, ["objective", "add", "t6-8 an outcome that stays"]).out);
    const work = workIdIn(must(t6.box, t6.alpha, ["work", "add", "t6-8 the moving doing"]).out);
    must(t6.box, t6.alpha, ["work", "link", work, "--objective", objective]);
    must(t6.box, t6.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    assert.ok(must(t6.box, t6.beta, ["work", "show", work]).out.includes(objective));
    assert.match(must(t6.box, t6.alpha, ["state", "show", objective]).out, /placement: project/);
    assert.ok(must(t6.box, t6.alpha, ["objective"]).out.includes("t6-8 an outcome that stays"));
});

test("T6.9: a moved objective keeps the links from work in the source, and that work does not move with it", () =>
{
    const objective = entityIn(must(t6.box, t6.alpha, ["objective", "add", "t6-9 the moving outcome"]).out);
    const work = workIdIn(must(t6.box, t6.alpha, ["work", "add", "t6-9 the doing that stays"]).out);
    must(t6.box, t6.alpha, ["work", "link", work, "--objective", objective]);
    must(t6.box, t6.alpha, ["state", "place", objective, "--scope", "beta", "--why", "belongs to beta"]);
    assert.match(must(t6.box, t6.beta, ["state", "show", objective]).out, /placement: beta/);
    assert.ok(must(t6.box, t6.alpha, ["work"]).out.includes(work));
    assert.ok(must(t6.box, t6.alpha, ["work", "show", work]).out.includes(objective));
});
