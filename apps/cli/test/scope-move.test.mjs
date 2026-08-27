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
import { approvedIn, git, machine, must, mustPerson, retireFixture, selfIn, workIdIn } from "./harness.mjs";

// Three projects, because a move needs a source, a destination, and a third
// project that must never see the record. Named rather than reusing the
// harness's demo workspace: every assertion below reads a slug.
async function trio()
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init"]);
    const dirs = {};
    for (const slug of ["alpha", "beta", "gamma"])
    {
        const dir = join(ws, slug);
        mkdirSync(dir, { recursive: true });
        git(box, dir, ["init", "-q", "-b", "main"]);
        await must(box, dir, ["project", "init", "--name", slug, "--no-connect"]);
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

const t1 = await trio();

/* ── T2 — the move, by lifecycle × record kind ─────────────────────── */

const t2 = await trio();

// `state place <id> --scope beta --why "<reason>"`, run in the project the
// record currently renders in.
function moveToBeta(id, why = "belongs to beta")
{
    return must(t2.box, t2.alpha, ["state", "place", id, "--scope", "beta", "--why", why]);
}

async function placementOf(dir, id)
{
    return (await must(t2.box, dir, ["state", "show", id])).out.match(/placement: .*/)[0];
}

/* ── T3 — what renders after a move ────────────────────────────────── */

// Record R lives in alpha's log, scoped to beta.
const t3 = await trio();

const t3Entity = entityIn((await must(t3.box, t3.alpha, ["state", "add", "t3 the moved note", "--priority", "5"])).out);

const t3Work = workIdIn((await mustPerson(t3.box, t3.alpha, ["work", "add", "t3 the moved outcome"])).out);

await must(t3.box, t3.alpha, ["state", "place", t3Entity, "--scope", "beta", "--why", "belongs to beta"]);

await must(t3.box, t3.alpha, ["state", "place", t3Work, "--scope", "beta", "--why", "belongs to beta"]);

/* ── T4 — writes after a move ──────────────────────────────────────── */

// Work unit W lives in alpha's log, scoped to beta.
const t4 = await trio();

async function movedUnit(outcome)
{
    const work = workIdIn((await mustPerson(t4.box, t4.alpha, ["work", "add", outcome])).out);
    await must(t4.box, t4.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    return work;
}

/* ── T5 — caps at the destination ──────────────────────────────────── */

// One workspace per cell: each cell states a tier's exact fill, and sharing a
// store between them would make the numbers depend on test order.
const SEAT = "beta holds this seat";

const MOVER = "a mover";

// The records first, under a cap wide enough to admit them, then the cap
// lowered onto the destination tier — so the tier's fill is exactly the text
// this cell put there rather than an arithmetic guess.
async function capped(seats, caps)
{
    const t = await trio();
    setCaps(t.ws, { indexTokens: 4000, fullTokens: 4000 });
    const mover = entityIn((await must(t.box, t.alpha, ["state", "add", MOVER])).out);
    const held = [];
    for (let index = 0; index < seats; index += 1)
    {
        held.push(entityIn((await must(t.box, t.beta, ["state", "add", `${SEAT}${"!".repeat(index)}`,
            ...(caps.fullTokens === undefined ? [] : ["--exposure", "full"])])).out));
    }
    setCaps(t.ws, caps);
    return { ...t, mover, seats: held };
}

/* ── T6 — relationships across the move ────────────────────────────── */

const t6 = await trio();

/* ── T7 — an objective already recorded, moved to workspace scope (#287) ── */

// The migration path for direction filed one level too low: an objective
// recorded before `--workspace` existed is raised by the placement verb that
// already moves every other record. No new verb, and no new code — these cells
// exist because that promise is what let #287 ship without a migration.
const t7 = await trio();

test("T1.1: the flag omitted places the record in the project the directory resolves to", async () =>
{
    const id = entityIn((await must(t1.box, t1.alpha, ["state", "add", "t1-1 local note"])).out);
    assert.match((await must(t1.box, t1.alpha, ["state", "show", id])).out, /placement: project · index/);
    assert.ok((await must(t1.box, t1.alpha, ["context"])).out.includes("t1-1 local note"));
    assert.ok(!(await must(t1.box, t1.beta, ["context"])).out.includes("t1-1 local note"));
});

test("T1.2: --scope workspace renders the record in every project's context", async () =>
{
    await must(t1.box, t1.alpha, ["state", "add", "t1-2 shared note", "--scope", "workspace"]);
    for (const dir of [t1.alpha, t1.beta, t1.gamma])
    {
        assert.ok((await must(t1.box, dir, ["context"])).out.includes("t1-2 shared note"));
    }
});

test("T1.3: --scope naming this project's own slug is recorded, not refused, and reads as the omission", async () =>
{
    const id = entityIn((await must(t1.box, t1.alpha, ["state", "add", "t1-3 named home", "--scope", "alpha"])).out);
    assert.match((await must(t1.box, t1.alpha, ["state", "show", id])).out, /placement: project · index/);
    assert.ok((await must(t1.box, t1.alpha, ["context"])).out.includes("t1-3 named home"));
    assert.ok(!(await must(t1.box, t1.beta, ["context"])).out.includes("t1-3 named home"));
});

test("T1.4: --scope naming another registered slug renders the record in that project only", async () =>
{
    await must(t1.box, t1.alpha, ["state", "add", "t1-4 destined note", "--scope", "beta"]);
    assert.ok((await must(t1.box, t1.beta, ["context"])).out.includes("t1-4 destined note"));
    assert.ok(!(await must(t1.box, t1.alpha, ["context"])).out.includes("t1-4 destined note"));
    assert.ok(!(await must(t1.box, t1.gamma, ["context"])).out.includes("t1-4 destined note"));
});

test("T1.5: --scope project is refused by name, and the refusal states the replacement", async () =>
{
    const refused = await selfIn(t1.box, t1.alpha, ["state", "add", "t1-5", "--scope", "project"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--scope project was retired/);
    assert.match(refused.out, /omit --scope/);
});

test("T1.6: --scope Project and --scope PROJECT are refused with the same message — no case-insensitive rescue", async () =>
{
    const expected = (await selfIn(t1.box, t1.alpha, ["state", "add", "t1-6", "--scope", "project"])).out;
    for (const spelling of ["Project", "PROJECT"])
    {
        const refused = await selfIn(t1.box, t1.alpha, ["state", "add", "t1-6", "--scope", spelling]);
        assert.notEqual(refused.code, 0);
        assert.equal(refused.out, expected);
    }
});

test("T1.7: an unregistered slug is refused, naming self project as the way to list the registered ones", async () =>
{
    const refused = await selfIn(t1.box, t1.alpha, ["state", "add", "t1-7", "--scope", "delta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"delta" is not a registered project/);
    assert.match(refused.out, /self project/);
});

test("T1.8: --scope workspace=<anything> is refused — workspace takes no value", async () =>
{
    const refused = await selfIn(t1.box, t1.alpha, ["state", "add", "t1-8", "--scope", "workspace=beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--scope workspace takes no value/);
});

test("T1.9: an empty --scope is refused as empty, never read as the omission", async () =>
{
    const refused = await selfIn(t1.box, t1.alpha, ["state", "add", "t1-9", "--scope", ""]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /it cannot be empty/);
});

test("T1.10: self project init refuses the slug workspace as reserved", async () =>
{
    const dir = join(t1.ws, "reserved");
    mkdirSync(dir, { recursive: true });
    git(t1.box, dir, ["init", "-q", "-b", "main"]);
    const refused = await selfIn(t1.box, dir, ["project", "init", "--name", "workspace", "--no-connect"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"workspace" is reserved/);
});

test("T2.1: a confirmed decision moves, and the entity.placed event carries the scope and the why", async () =>
{
    const id = entityIn((await must(t2.box, t2.alpha, ["decide", "t2-1 a settled call", "--why", "recorded"])).out);
    await moveToBeta(id, "the call belongs to beta");
    assert.equal(await placementOf(t2.beta, id), "placement: beta · index · priority 40");
    const placed = eventsOf(t2.ws, "alpha").filter((event) => event.type === "entity.placed" && event.payload.entity === id);
    assert.equal(placed.length, 1);
    assert.equal(placed[0].payload.scope, "beta");
    assert.equal(placed[0].payload.why, "the call belongs to beta");
});

test("T2.2: a confirmed objective moves, and its milestones and linked work keep pointing at it", async () =>
{
    const objective = entityIn((await must(t2.box, t2.alpha, ["objective", "add", "t2-2 an outcome"])).out);
    const milestone = entityIn((await must(t2.box, t2.alpha, ["milestone", "add", "t2-2 a checkpoint", "--objective", objective, "--exit", "the checkpoint holds"])).out);
    const work = workIdIn((await mustPerson(t2.box, t2.alpha, ["work", "add", "t2-2 the doing"])).out);
    await must(t2.box, t2.alpha, ["work", "link", work, "--objective", objective]);
    await moveToBeta(objective);
    assert.match(await placementOf(t2.beta, objective), /placement: beta/);
    assert.ok((await must(t2.box, t2.alpha, ["state", "show", milestone])).out.includes(`member-of ${objective}`));
    assert.ok((await must(t2.box, t2.alpha, ["work", "show", work])).out.includes(objective));
});

test("T2.3: a confirmed milestone moves; its objective is unmoved and the link still resolves", async () =>
{
    const objective = entityIn((await must(t2.box, t2.alpha, ["objective", "add", "t2-3 an outcome"])).out);
    const milestone = entityIn((await must(t2.box, t2.alpha, ["milestone", "add", "t2-3 a checkpoint", "--objective", objective, "--exit", "the checkpoint holds"])).out);
    await moveToBeta(milestone);
    assert.match(await placementOf(t2.beta, milestone), /placement: beta/);
    assert.match(await placementOf(t2.alpha, objective), /placement: project/);
    assert.ok((await must(t2.box, t2.beta, ["state", "show", milestone])).out.includes(`member-of ${objective}`));
});

test("T2.4: a confirmed convention moves, and stops rendering in the source's convention list", async () =>
{
    const id = entityIn((await must(t2.box, t2.alpha, ["convention", "add", "t2-4 one shared rule"])).out);
    assert.ok((await must(t2.box, t2.alpha, ["context"])).out.includes("t2-4 one shared rule"));
    await moveToBeta(id);
    assert.ok(!(await must(t2.box, t2.alpha, ["context"])).out.includes("t2-4 one shared rule"));
    assert.ok((await must(t2.box, t2.beta, ["context"])).out.includes("t2-4 one shared rule"));
});

test("T2.5: a confirmed goal moves", async () =>
{
    const id = entityIn((await must(t2.box, t2.alpha, ["goal", "add", "t2-5 the long direction"])).out);
    await moveToBeta(id);
    assert.match(await placementOf(t2.beta, id), /placement: beta/);
    assert.ok((await must(t2.box, t2.beta, ["context"])).out.includes("t2-5 the long direction"));
});

test("T2.6: an open work unit moves, and its brief, reports and evidence render at the destination", async () =>
{
    const work = workIdIn((await mustPerson(t2.box, t2.alpha, ["work", "add", "t2-6 an open outcome"])).out);
    commit(t2.box, t2.alpha, "t2-6 evidence");
    await must(t2.box, t2.alpha, ["report", work, "t2-6 the first report"]);
    await moveToBeta(work);
    const shown = (await must(t2.box, t2.beta, ["work", "show", work])).out;
    assert.ok(shown.includes("t2-6 an open outcome"), "the brief did not render at the destination");
    assert.ok(shown.includes("t2-6 the first report"), "the report did not render at the destination");
    assert.match(shown, /- Evidence: [0-9a-f]{7}/, "the evidence did not render at the destination");
    assert.ok((await must(t2.box, t2.beta, ["work"])).out.includes(work));
});

test("T2.7: a started unit moves, and the holder note travels with it", async () =>
{
    const work = workIdIn((await mustPerson(t2.box, t2.alpha, ["work", "add", "t2-7 a held outcome"])).out);
    await must(t2.box, t2.alpha, ["work", "start", work], { SUPERSELF_SESSION: "t2-7-holder" });
    await moveToBeta(work);
    const shown = (await must(t2.box, t2.beta, ["work", "show", work], { SUPERSELF_SESSION: "t2-7-other" })).out;
    assert.match(shown, /held by/);
});

test("T2.8: a blocked unit moves, and its block reason and --on are unchanged", async () =>
{
    const work = workIdIn((await mustPerson(t2.box, t2.alpha, ["work", "add", "t2-8 a parked outcome"])).out);
    await must(t2.box, t2.alpha, ["work", "block", work, "--on", "dependency", "--why", "t2-8 waiting on the other half"]);
    await moveToBeta(work);
    const shown = (await must(t2.box, t2.beta, ["work", "show", work])).out;
    assert.ok(shown.includes("dependency"));
    assert.ok(shown.includes("t2-8 waiting on the other half"));
});

test("T2.9: a done unit moves — a finished unit in the wrong project still misfiles its artifacts", async () =>
{
    const work = workIdIn((await mustPerson(t2.box, t2.alpha, ["work", "add", "t2-9 a finished outcome"])).out);
    commit(t2.box, t2.alpha, "t2-9 evidence");
    await must(t2.box, t2.alpha, ["report", work, "t2-9 what happened"]);
    await must(t2.box, t2.alpha, ["work", "done", work]);
    await moveToBeta(work);
    assert.match(await placementOf(t2.beta, work), /placement: beta/);
    assert.ok((await must(t2.box, t2.beta, ["work", "show", work])).out.includes("t2-9 a finished outcome"));
});

test("T2.10: a retired unit moves, and its successor pointer is unchanged", async () =>
{
    const work = workIdIn((await mustPerson(t2.box, t2.alpha, ["work", "add", "t2-10 a given-up outcome"])).out);
    const successor = workIdIn((await mustPerson(t2.box, t2.alpha, ["work", "add", "t2-10 the outcome now"])).out);
    retireFixture(t2.box, t2.ws, "alpha", "entity.retired",
        { entity: work, why: "t2-10 moved on", successor, successorProject: "alpha" });
    await moveToBeta(work);
    assert.match(await placementOf(t2.beta, work), /placement: beta/);
    assert.ok((await must(t2.box, t2.beta, ["work", "show", work])).out.includes(successor));
});

test("T2.11: a proposed record is refused — placement moves confirmed records", async () =>
{
    const id = entityIn((await must(t2.box, t2.alpha, ["state", "add", "t2-11 a proposal", "--proposed"])).out);
    const refused = await selfIn(t2.box, t2.alpha, ["state", "place", id, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is still proposed — placement moves confirmed records/);
});

test("T2.12: a retracted record is refused — a withdrawn record has no placement", async () =>
{
    const id = entityIn((await must(t2.box, t2.alpha, ["state", "add", "t2-12 a withdrawn note"])).out);
    retireFixture(t2.box, t2.ws, "alpha", "entity.retracted", { entity: id, why: "t2-12 taken back" }, { retracts: id });
    const refused = await selfIn(t2.box, t2.alpha, ["state", "place", id, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /was retracted — a withdrawn record no longer renders/);
});

test("T2.13: a superseded record is refused, naming the successor to place instead", async () =>
{
    const older = entityIn((await must(t2.box, t2.alpha, ["state", "add", "t2-13 the earlier wording"])).out);
    const newer = entityIn((await must(t2.box, t2.alpha, ["state", "add", "t2-13 the later wording"])).out);
    retireFixture(t2.box, t2.ws, "alpha", "entity.superseded", { entity: older, successor: newer });
    const refused = await selfIn(t2.box, t2.alpha, ["state", "place", older, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`was superseded by ${newer} — place the successor instead`));
});

test("T2.14: a report is refused — it is not independently placed, it moves with its work unit", async () =>
{
    const work = workIdIn((await mustPerson(t2.box, t2.alpha, ["work", "add", "t2-14 a reported outcome"])).out);
    commit(t2.box, t2.alpha, "t2-14 evidence");
    await must(t2.box, t2.alpha, ["report", work, "t2-14 the report body"]);
    const report = eventsOf(t2.ws, "alpha").find((event) => event.type === "report.added" && event.refs?.work === work).id;
    const refused = await selfIn(t2.box, t2.alpha, ["state", "place", report, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is a report of/);
    assert.match(refused.out, /it moves with its work unit/);
});

test("T2.15: an artifact is refused for the same reason", async () =>
{
    const work = workIdIn((await mustPerson(t2.box, t2.alpha, ["work", "add", "t2-15 an attaching outcome"])).out);
    const file = join(t2.alpha, "t2-15-artifact.txt");
    writeFileSync(file, "t2-15 bytes\n");
    commit(t2.box, t2.alpha, "t2-15 evidence");
    await must(t2.box, t2.alpha, ["report", work, "t2-15 with an artifact", "--artifact", file]);
    const artifact = (await must(t2.box, t2.alpha, ["work", "show", work])).out.match(/\ba-[0-9a-z]{5}\b/)[0];
    const refused = await selfIn(t2.box, t2.alpha, ["state", "place", artifact, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is an artifact of/);
    assert.match(refused.out, /it moves with its work unit/);
});

test("T2.16: placing a record at its current scope is refused as no change", async () =>
{
    const id = entityIn((await must(t2.box, t2.alpha, ["state", "add", "t2-16 a settled placement"])).out);
    const home = await selfIn(t2.box, t2.alpha, ["state", "place", id, "--scope", "alpha"]);
    assert.notEqual(home.code, 0);
    assert.match(home.out, /already sits at that placement — nothing changes/);
    await moveToBeta(id);
    const away = await selfIn(t2.box, t2.beta, ["state", "place", id, "--scope", "beta"]);
    assert.notEqual(away.code, 0);
    assert.match(away.out, /already sits at that placement — nothing changes/);
});

test("T2.17: a cross-project move with --why omitted is recorded without why", async () =>
{
    const id = entityIn((await must(t2.box, t2.alpha, ["state", "add", "t2-17 a reasonless move"])).out);
    await must(t2.box, t2.alpha, ["state", "place", id, "--scope", "beta"]);
    assert.match(await placementOf(t2.beta, id), /placement: beta/);
    const placed = eventsOf(t2.ws, "alpha").filter((event) => event.type === "entity.placed" && event.payload.entity === id);
    assert.equal(placed.length, 1);
    assert.equal(placed[0].payload.why, undefined);
});

test("T2.18: a done unit moves back to its home project — D5 makes it resolvable from the destination", async () =>
{
    const work = workIdIn((await mustPerson(t2.box, t2.alpha, ["work", "add", "t2-18 a returning outcome"])).out);
    commit(t2.box, t2.alpha, "t2-18 evidence");
    await must(t2.box, t2.alpha, ["report", work, "t2-18 what happened"]);
    await must(t2.box, t2.alpha, ["work", "done", work]);
    await moveToBeta(work);
    await must(t2.box, t2.beta, ["state", "place", work, "--scope", "alpha", "--why", "filed here after all"]);
    assert.match(await placementOf(t2.alpha, work), /placement: project/);
    assert.ok(!(await must(t2.box, t2.beta, ["work"])).out.includes(work));
});

test("T3.1: self context in the destination renders R at its priority, among the destination's own records", async () =>
{
    await must(t3.box, t3.beta, ["state", "add", "t3 a beta note", "--priority", "9"]);
    const out = (await must(t3.box, t3.beta, ["context"])).out;
    assert.ok(out.includes("t3 the moved note"));
    assert.ok(out.indexOf("t3 the moved note") < out.indexOf("t3 a beta note"), "priority 5 did not render ahead of priority 9");
});

test("T3.2: self context in the source is absent of R", async () =>
{
    const out = (await must(t3.box, t3.alpha, ["context"])).out;
    assert.ok(!out.includes("t3 the moved note"));
    assert.ok(!out.includes("t3 the moved outcome"));
});

test("T3.3: self context in a third project is absent of R", async () =>
{
    const out = (await must(t3.box, t3.gamma, ["context"])).out;
    assert.ok(!out.includes("t3 the moved note"));
    assert.ok(!out.includes("t3 the moved outcome"));
});

test("T3.4: the workspace-wide context renders R once, attributed to the destination", async () =>
{
    // `self context` outside a project is the workspace form; there is no
    // --workspace flag on the verb. One line per project, so R is counted in
    // beta's line and in no other.
    const lines = (await must(t3.box, t3.ws, ["context"])).out.split("\n").filter((line) => line.trim() !== "");
    const of = (slug) => lines.find((line) => line.startsWith(`${slug} —`));
    assert.match(of("beta"), /1 next/);
    assert.match(of("alpha"), /0 next/);
    assert.match(of("gamma"), /0 next/);
});

test("T3.5: self work in the destination lists the moved unit", async () =>
{
    assert.ok((await must(t3.box, t3.beta, ["work"])).out.includes(t3Work));
});

test("T3.6: self work in the source does not list it", async () =>
{
    assert.ok(!(await must(t3.box, t3.alpha, ["work"])).out.includes(t3Work));
});

test("T3.7: self work show in the source resolves and states the record now renders in the destination", async () =>
{
    const out = (await must(t3.box, t3.alpha, ["work", "show", t3Work])).out;
    assert.ok(out.includes("t3 the moved outcome"));
    assert.match(out, new RegExp(`${t3Work} renders in beta; its record lives in alpha`));
});

test("T3.8: self search from the source finds R, with its current scope named", async () =>
{
    // `--all` because search answers over live records now (#212) and its
    // default leaves out what a context render shows: this record renders in
    // beta's context, and what this cell is about is that the row still names
    // where it went.
    const out = (await must(t3.box, t3.alpha, ["search", "t3 the moved note", "--type", "entity", "--all"])).out;
    assert.ok(out.includes("t3 the moved note"));
    assert.match(out, /\[renders in beta\]/);
});

test("T3.9: a record scoped to workspace still renders in every project", async () =>
{
    await must(t3.box, t3.alpha, ["state", "place", t3Entity, "--scope", "workspace"]);
    for (const dir of [t3.alpha, t3.beta, t3.gamma])
    {
        assert.ok((await must(t3.box, dir, ["context"])).out.includes("t3 the moved note"), "a workspace record missed a project");
    }
    await must(t3.box, t3.alpha, ["state", "place", t3Entity, "--scope", "beta"]);
});

test("T3.11: the synced work file for a moved unit stays under its home store, never duplicated at the destination", () =>
{
    assert.ok(existsSync(join(t3.ws, ".superself", "projects", "alpha", "work", `${t3Work}.md`)));
    assert.ok(!existsSync(join(t3.ws, ".superself", "projects", "beta", "work", `${t3Work}.md`)));
});

// Unregistering is the last of this block, because it takes the destination
// out of the workspace for every test after it.
test("T3.10: with the destination unregistered, R renders nowhere and self project names the dangling scope", async () =>
{
    const registry = join(t3.ws, ".superself", "registry.jsonl");
    const kept = readFileSync(registry, "utf8").split("\n")
        .filter((line) => line.trim() !== "" && JSON.parse(line).slug !== "beta");
    writeFileSync(registry, kept.map((line) => line + "\n").join(""));
    for (const dir of [t3.alpha, t3.gamma])
    {
        assert.ok(!(await must(t3.box, dir, ["context"])).out.includes("t3 the moved note"));
    }
    const listed = (await must(t3.box, t3.alpha, ["project"])).out;
    assert.match(listed, new RegExp(`dangling scope: ${t3Entity} in alpha renders in "beta"`));
});

/* ── the listing verb the refusals point at ────────────────────────── */

// Not a table cell: `self project` is a verb this change ships, and
// CONTRIBUTING asks a new verb for coverage of what it adds and of its
// refusal path. The diagnostic it also carries is T3.10 above.

test("self project lists the registered slugs and marks the one this directory resolves to", async () =>
{
    const t = await trio();
    const listed = (await must(t.box, t.beta, ["project"])).out;
    for (const slug of ["alpha", "beta", "gamma"])
    {
        assert.match(listed, new RegExp(`^${slug}`, "m"));
    }
    assert.match(listed, /^beta.*\(this directory\)/m);
    assert.doesNotMatch(listed, /^alpha.*\(this directory\)/m);
});

test("self project refuses a subcommand it does not have, with the usage it does", async () =>
{
    const t = await trio();
    const refused = await selfIn(t.box, t.alpha, ["project", "remove", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /usage: self project \| init \[--name <slug>\]/);
    assert.match(refused.out, /link \[slug\] \[path\|--here\] \[--force\]/);
});

test("T4.1: work start in the destination prints the brief and records the claim into the home log", async () =>
{
    const work = await movedUnit("t4-1 a startable outcome");
    const before = eventsOf(t4.ws, "beta").length;
    const out = (await must(t4.box, t4.beta, ["work", "start", work], { SUPERSELF_SESSION_PID: "777001" })).out;
    assert.ok(out.includes("t4-1 a startable outcome"), "the brief was not printed");
    const started = eventsOf(t4.ws, "alpha").filter((event) => event.type === "entity.started" && event.payload.entity === work);
    assert.equal(started.length, 1);
    assert.equal(eventsOf(t4.ws, "beta").length, before, "a write about a scoped-in record reached the destination's log");
});

test("T4.2: report in the destination records into the home log, with evidence from the destination's checkout HEAD", async () =>
{
    const work = await movedUnit("t4-2 a reportable outcome");
    commit(t4.box, t4.beta, "t4-2 beta head");
    await must(t4.box, t4.beta, ["report", work, "t4-2 the report body"]);
    const reports = eventsOf(t4.ws, "alpha").filter((event) => event.type === "report.added" && event.refs?.work === work);
    assert.equal(reports.length, 1);
    const head = (await must(t4.box, t4.beta, ["work", "show", work])).out;
    assert.ok(head.includes("t4-2 the report body"));
    assert.ok(reports[0].refs.commits.length > 0, "no evidence was attached from the checkout the command ran in");
});

test("T4.3: work done in the destination closes the unit, with the evidence rule unchanged", async () =>
{
    const work = await movedUnit("t4-3 a closable outcome");
    const bare = await selfIn(t4.box, t4.beta, ["work", "done", work]);
    assert.notEqual(bare.code, 0, "done without evidence was admitted");
    await must(t4.box, t4.beta, ["work", "done", work, "--report", "t4-3 what verifiably happened"]);
    assert.ok(!(await must(t4.box, t4.beta, ["work"])).out.includes(work));
    assert.equal(eventsOf(t4.ws, "alpha").filter((event) => event.type === "entity.done" && event.payload.entity === work).length, 1);
});

test("T4.4: work block in the destination blocks the unit", async () =>
{
    const work = await movedUnit("t4-4 a blockable outcome");
    await must(t4.box, t4.beta, ["work", "block", work, "--on", "decision", "--why", "t4-4 waiting on a call"]);
    assert.equal(eventsOf(t4.ws, "alpha").filter((event) => event.type === "entity.blocked" && event.payload.entity === work).length, 1);
    assert.ok((await must(t4.box, t4.beta, ["work", "show", work])).out.includes("t4-4 waiting on a call"));
});

test("T4.5: the same writes run in the source resolve and succeed — the home log always answers for its own record", async () =>
{
    const work = await movedUnit("t4-5 an outcome written from home");
    await must(t4.box, t4.alpha, ["work", "start", work], { SUPERSELF_SESSION_PID: "777005" });
    commit(t4.box, t4.alpha, "t4-5 alpha head");
    await must(t4.box, t4.alpha, ["report", work, "t4-5 reported from home"]);
    await must(t4.box, t4.alpha, ["work", "block", work, "--on", "external", "--why", "t4-5 parked from home"]);
    await must(t4.box, t4.alpha, ["work", "done", work, "--report", "t4-5 finished from home"]);
    assert.equal(eventsOf(t4.ws, "alpha").filter((event) => event.type === "entity.done" && event.payload.entity === work).length, 1);
});

test("T4.6: the same writes run in a third project are refused as an unknown id", async () =>
{
    const work = await movedUnit("t4-6 an outcome invisible to gamma");
    for (const args of [["work", "start", work], ["report", work, "x"], ["work", "done", work, "--report", "x"],
        ["work", "block", work, "--on", "decision", "--why", "x"]])
    {
        const refused = await selfIn(t4.box, t4.gamma, args);
        assert.notEqual(refused.code, 0, `${args.join(" ")} was not refused in a project the unit does not render in`);
        assert.match(refused.out, new RegExp(`unknown work id "${work}"`));
    }
});

test("T4.7: work add in the destination is born there — D3 does not change where an add lands", async () =>
{
    const work = workIdIn((await mustPerson(t4.box, t4.beta, ["work", "add", "t4-7 a native beta outcome"])).out);
    assert.ok(logOf(t4.ws, "beta").includes(work));
    assert.ok(!logOf(t4.ws, "alpha").includes(work));
    assert.ok((await must(t4.box, t4.beta, ["work"])).out.includes(work));
});

test("T4.8: two sessions, one in each project, both append to the home log with no coordination added", async () =>
{
    const work = await movedUnit("t4-8 a contested outcome");
    commit(t4.box, t4.alpha, "t4-8 alpha head");
    commit(t4.box, t4.beta, "t4-8 beta head");
    await must(t4.box, t4.alpha, ["report", work, "t4-8 from the source"], { SUPERSELF_SESSION_PID: "777081" });
    await must(t4.box, t4.beta, ["report", work, "t4-8 from the destination"], { SUPERSELF_SESSION_PID: "777082" });
    const reports = eventsOf(t4.ws, "alpha").filter((event) => event.type === "report.added" && event.refs?.work === work);
    assert.equal(reports.length, 2);
    assert.equal(eventsOf(t4.ws, "beta").filter((event) => event.refs?.work === work).length, 0);
});

test("T4.9: state place in the destination moves the unit on again, with the home log still owning it", async () =>
{
    const work = await movedUnit("t4-9 a twice-moved outcome");
    await must(t4.box, t4.beta, ["state", "place", work, "--scope", "gamma", "--why", "gamma after all"]);
    assert.ok((await must(t4.box, t4.gamma, ["work"])).out.includes(work));
    assert.ok(!(await must(t4.box, t4.beta, ["work"])).out.includes(work));
    assert.equal(eventsOf(t4.ws, "beta").filter((event) => event.payload.entity === work).length, 0);
    assert.equal(eventsOf(t4.ws, "alpha").filter((event) =>
        event.type === "entity.placed" && event.payload.entity === work && event.payload.scope === "gamma").length, 1);
});

test("T5.1: with room available, a move in is accepted", async () =>
{
    const t = await capped(1, { indexTokens: SEAT.length + MOVER.length });
    await must(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta"]);
    assert.match((await must(t.box, t.beta, ["state", "show", t.mover])).out, /placement: beta · index/);
});

test("T5.2: at the destination's cap, a move in is refused, naming the cap and the destination", async () =>
{
    const t = await capped(1, { indexTokens: SEAT.length });
    const refused = await selfIn(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`the beta index tier holds ${SEAT.length} of ${SEAT.length} tokens`));
});

test("T5.3: at the cap, --demote naming one of the destination's records is accepted", async () =>
{
    const t = await capped(1, { indexTokens: SEAT.length });
    await must(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta", "--demote", t.seats[0]]);
    assert.match((await must(t.box, t.beta, ["state", "show", t.mover])).out, /placement: beta · index/);
    assert.match((await must(t.box, t.beta, ["state", "show", t.seats[0]])).out, /placement: project · search/);
});

test("T5.4: at the cap, --demote naming a source-project record is refused — a demotion frees a seat in the tier being entered", async () =>
{
    const t = await capped(1, { indexTokens: SEAT.length });
    const local = entityIn((await must(t.box, t.alpha, ["state", "add", "a home seat"])).out);
    const refused = await selfIn(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta", "--demote", local]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is project-scoped — the beta index cap frees only by demoting beta-scoped records/);
});

test("T5.5: with the destination already over its cap, a move in is refused", async () =>
{
    const t = await capped(2, { indexTokens: SEAT.length });
    const refused = await selfIn(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`the beta index tier holds \\d+ of ${SEAT.length} tokens`));
});

test("T5.6: with the source tier at its cap and the destination free, the move out is accepted and frees the source", async () =>
{
    const t = await trio();
    setCaps(t.ws, { indexTokens: 4000 });
    const seat = entityIn((await must(t.box, t.alpha, ["state", "add", SEAT])).out);
    setCaps(t.ws, { indexTokens: SEAT.length });
    const blocked = await selfIn(t.box, t.alpha, ["state", "add", MOVER]);
    assert.notEqual(blocked.code, 0, "the source tier was not actually at its cap");
    await must(t.box, t.alpha, ["state", "place", seat, "--scope", "beta"]);
    await must(t.box, t.alpha, ["state", "add", MOVER]);
});

test("T5.7: a move into search exposure is accepted regardless of the cap — the search tier is uncapped", async () =>
{
    const t = await capped(1, { indexTokens: SEAT.length });
    await must(t.box, t.alpha, ["state", "place", t.mover, "--scope", "beta", "--exposure", "search",
        "--why", "found by search only"]);
    assert.match((await must(t.box, t.beta, ["state", "show", t.mover])).out, /placement: beta · search/);
});

test("T5.8: a move plus --exposure full in one call applies both, charged against the destination's full tier", async () =>
{
    const tight = await capped(1, { fullTokens: SEAT.length, indexTokens: 4000 });
    const refused = await selfIn(tight.box, tight.alpha, ["state", "place", tight.mover, "--scope", "beta", "--exposure", "full"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`the beta full tier holds ${SEAT.length} of ${SEAT.length} tokens`));
    const roomy = await capped(1, { fullTokens: SEAT.length + MOVER.length, indexTokens: 4000 });
    await must(roomy.box, roomy.alpha, ["state", "place", roomy.mover, "--scope", "beta", "--exposure", "full"]);
    assert.match((await must(roomy.box, roomy.beta, ["state", "show", roomy.mover])).out, /placement: beta · full/);
});

test("T6.1: a unit blocked on the moved one keeps its blocker, and the dependency names it at its new scope", async () =>
{
    const moved = workIdIn((await mustPerson(t6.box, t6.alpha, ["work", "add", "t6-1 the blocking outcome"])).out);
    const dependent = workIdIn((await mustPerson(t6.box, t6.alpha, ["work", "add", "t6-1 the waiting outcome"])).out);
    await must(t6.box, t6.alpha, ["work", "block", dependent, "--on", "dependency", "--why", `waits on ${moved}`]);
    await must(t6.box, t6.alpha, ["state", "place", moved, "--scope", "beta", "--why", "belongs to beta"]);
    const shown = (await must(t6.box, t6.alpha, ["work", "show", dependent])).out;
    assert.ok(shown.includes(`waits on ${moved}`), "the dependent lost its blocker");
    assert.match((await must(t6.box, t6.alpha, ["work", "show", moved])).out, new RegExp(`${moved} renders in beta`));
});

test("T6.2: evidence commits produced in the source repository are not re-resolved against the destination", async () =>
{
    const work = workIdIn((await mustPerson(t6.box, t6.alpha, ["work", "add", "t6-2 an evidenced outcome"])).out);
    commit(t6.box, t6.alpha, "t6-2 alpha evidence");
    await must(t6.box, t6.alpha, ["report", work, "t6-2 the report"]);
    const before = eventsOf(t6.ws, "alpha").find((event) => event.type === "report.added" && event.refs?.work === work).refs.commits;
    await must(t6.box, t6.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    const after = eventsOf(t6.ws, "alpha").find((event) => event.type === "report.added" && event.refs?.work === work).refs.commits;
    assert.deepEqual(after, before, "the move rewrote the evidence the source repository produced");
    assert.ok((await must(t6.box, t6.beta, ["work", "show", work])).out.includes(before[0].slice(0, 7)));
});

test("T6.3: evidence that no longer resolves stays visible as unresolved rather than dropped", async () =>
{
    const work = workIdIn((await mustPerson(t6.box, t6.alpha, ["work", "add", "t6-3 an unresolvable outcome"])).out);
    const dangling = "0".repeat(40);
    await must(t6.box, t6.alpha, ["report", work, "t6-3 the report", "--evidence", dangling]);
    await must(t6.box, t6.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    const shown = (await must(t6.box, t6.beta, ["work", "show", work])).out;
    assert.ok(shown.includes(dangling.slice(0, 7)), "unresolvable evidence disappeared from the page");
});

test("T6.4: the moved unit's artifacts resolve at the destination with their recorded declaration unchanged", async () =>
{
    const work = workIdIn((await mustPerson(t6.box, t6.alpha, ["work", "add", "t6-4 an attaching outcome"])).out);
    const file = join(t6.alpha, "t6-4-artifact.txt");
    writeFileSync(file, "t6-4 bytes\n");
    commit(t6.box, t6.alpha, "t6-4 evidence");
    await must(t6.box, t6.alpha, ["report", work, "t6-4 with an artifact", "--artifact", file]);
    const declared = eventsOf(t6.ws, "alpha")
        .find((event) => event.type === "report.added" && event.refs?.work === work).payload.artifacts;
    await must(t6.box, t6.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    const after = eventsOf(t6.ws, "alpha")
        .find((event) => event.type === "report.added" && event.refs?.work === work).payload.artifacts;
    assert.deepEqual(after, declared);
    assert.ok((await must(t6.box, t6.beta, ["work", "show", work])).out.includes(declared[0].name));
    assert.ok((await must(t6.box, t6.beta, ["artifact", "list", "--work", work, "--project", "alpha"])).out.includes(declared[0].id));
});

test("T6.5: the moved unit's reports render at the destination with their original timestamps", async () =>
{
    const work = workIdIn((await mustPerson(t6.box, t6.alpha, ["work", "add", "t6-5 a reported outcome"])).out);
    commit(t6.box, t6.alpha, "t6-5 evidence");
    await must(t6.box, t6.alpha, ["report", work, "t6-5 the earlier report"]);
    const stamped = eventsOf(t6.ws, "alpha").find((event) => event.type === "report.added" && event.refs?.work === work).ts;
    await must(t6.box, t6.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    const shown = (await must(t6.box, t6.beta, ["work", "show", work])).out;
    assert.ok(shown.includes("t6-5 the earlier report"));
    assert.ok(shown.includes(stamped.slice(0, 10)), "the report lost its original date at the destination");
});

test("T6.6: a record superseding a moved record resolves its lineage across the scope change", async () =>
{
    const older = entityIn((await must(t6.box, t6.alpha, ["state", "add", "t6-6 the earlier wording"])).out);
    await must(t6.box, t6.alpha, ["state", "place", older, "--scope", "beta", "--why", "belongs to beta"]);
    const newer = entityIn((await must(t6.box, t6.alpha, ["state", "add", "t6-6 the later wording"])).out);
    retireFixture(t6.box, t6.ws, "alpha", "entity.superseded", { entity: older, successor: newer });
    const shown = (await must(t6.box, t6.alpha, ["state", "show", older])).out;
    assert.match(shown, /superseded/);
    assert.ok(shown.includes(newer), "the lineage did not resolve across the scope change");
});

test("T6.7: an id that exists in both projects keeps the ambiguity error, and --project disambiguates", async () =>
{
    const work = workIdIn((await mustPerson(t6.box, t6.alpha, ["work", "add", "t6-7 the alpha outcome"])).out);
    // The same id in beta's log: two clones minting the same short id is the
    // collision the ambiguity error exists for.
    retireFixture(t6.box, t6.ws, "beta", "entity.confirmed",
        { entity: work, text: "t6-7 the beta outcome", labels: ["work"], links: [], criteria: [], exposure: "search", scope: "project" });
    const ambiguous = await selfIn(t6.box, t6.gamma, ["work", "show", work]);
    assert.notEqual(ambiguous.code, 0);
    assert.match(ambiguous.out, /exists in more than one project \(alpha, beta\)/);
    assert.ok((await must(t6.box, t6.gamma, ["work", "show", work, "--project", "beta"])).out.includes("t6-7 the beta outcome"));
});

test("T6.8: a moved unit linked to an objective in the source keeps the link, and the objective does not move", async () =>
{
    const objective = entityIn((await must(t6.box, t6.alpha, ["objective", "add", "t6-8 an outcome that stays"])).out);
    const work = workIdIn((await mustPerson(t6.box, t6.alpha, ["work", "add", "t6-8 the moving doing"])).out);
    await must(t6.box, t6.alpha, ["work", "link", work, "--objective", objective]);
    await must(t6.box, t6.alpha, ["state", "place", work, "--scope", "beta", "--why", "belongs to beta"]);
    assert.ok((await must(t6.box, t6.beta, ["work", "show", work])).out.includes(objective));
    assert.match((await must(t6.box, t6.alpha, ["state", "show", objective])).out, /placement: project/);
    assert.ok((await must(t6.box, t6.alpha, ["objective"])).out.includes("t6-8 an outcome that stays"));
});

test("T6.9: a moved objective keeps the links from work in the source, and that work does not move with it", async () =>
{
    const objective = entityIn((await must(t6.box, t6.alpha, ["objective", "add", "t6-9 the moving outcome"])).out);
    const work = workIdIn((await mustPerson(t6.box, t6.alpha, ["work", "add", "t6-9 the doing that stays"])).out);
    await must(t6.box, t6.alpha, ["work", "link", work, "--objective", objective]);
    await must(t6.box, t6.alpha, ["state", "place", objective, "--scope", "beta", "--why", "belongs to beta"]);
    assert.match((await must(t6.box, t6.beta, ["state", "show", objective])).out, /placement: beta/);
    assert.ok((await must(t6.box, t6.alpha, ["work"])).out.includes(work));
    assert.ok((await must(t6.box, t6.alpha, ["work", "show", work])).out.includes(objective));
});

test("D1: state place --scope workspace raises a recorded objective to workspace scope", async () =>
{
    const objective = entityIn((await must(t7.box, t7.alpha, ["objective", "add", "d1 the company's real aim"])).out);
    assert.ok(!(await must(t7.box, t7.beta, ["context"])).out.includes("d1 the company's real aim"));
    await must(t7.box, t7.alpha, ["state", "place", objective, "--scope", "workspace", "--why", "it is the company's, not alpha's"]);
    assert.match((await must(t7.box, t7.alpha, ["state", "show", objective])).out, /placement: workspace · full · priority 10/);
    // D2: and it reaches every other project's context from there.
    assert.ok((await must(t7.box, t7.beta, ["context"])).out.includes("d1 the company's real aim"));
    // D3: the same verb puts it back under one project alone.
    await must(t7.box, t7.alpha, ["state", "place", objective, "--scope", "alpha", "--why", "alpha's after all"]);
    assert.ok(!(await must(t7.box, t7.beta, ["context"])).out.includes("d1 the company's real aim"));
    assert.ok((await must(t7.box, t7.alpha, ["context"])).out.includes("d1 the company's real aim"));
});

test("D4: revising a raised objective carries the workspace placement to the successor", async () =>
{
    const objective = entityIn((await must(t7.box, t7.alpha, ["objective", "add", "d4 the company's stated aim"])).out);
    await must(t7.box, t7.alpha, ["state", "place", objective, "--scope", "workspace", "--why", "the company's"]);
    const printed = (await approvedIn(t7.box, t7.alpha,
        ["objective", "revise", objective, "--why", "restated", "--outcome", "d4 the company's clearer aim"],
        objective)).printed;
    const successor = printed.match(/\bo-[0-9a-z]{5}\b/)[0];
    assert.notEqual(successor, objective);
    assert.match((await must(t7.box, t7.alpha, ["state", "show", successor])).out, /placement: workspace · full/);
    assert.ok((await must(t7.box, t7.beta, ["context"])).out.includes("d4 the company's clearer aim"));
});
