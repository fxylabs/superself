// A session picking work up is told another session already holds it (#230).
// Every test below is one cell of the case table in that issue, as revised by
// decision 01kz8c83me299m37gk8rjjydw0 — the claim carries an opaque session
// token and never a machine or a person, so the original cells 3 and 4 became
// "this machine can judge the holder" and "it cannot".
//
// The assertions are the cells' stated outcomes: what was recorded, what was
// printed, and what was refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, machine, must, retireFixture, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);
const log = join(ws, ".superself", "projects", "demo", "log.jsonl");

// A pid this machine still has: the test runner itself. Signal 0 finds it, so
// a session recorded against it reads as running.
const ALIVE = String(process.pid);

// A pid this machine had and does not any more. Spawned and reaped here rather
// than guessed at, because a number picked out of the air can belong to a live
// process on a busy runner.
const GONE = String(spawnSync(process.execPath, ["-e", ""]).pid);

let seq = 0;

// Session names are unique per unit, not shared across the file. Liveness is
// answered from a ledger keyed by session alone, so a name reused by a later
// test would inherit the pid an earlier one recorded against it.
const asSession = (session, pid) => ({ SUPERSELF_SESSION: `${session}-${seq}`, SUPERSELF_SESSION_PID: pid ?? "" });

function freshUnit()
{
    seq += 1;
    return workIdIn(must(box, demo, ["work", "add", `outcome ${seq}`]).out);
}

function startsOf(id)
{
    return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "entity.started" && event.payload.entity === id);
}

/* ── cell 1: nothing holds the unit ────────────────────────────────── */

test("an unclaimed unit is claimed, and the brief comes back with it", () =>
{
    const id = freshUnit();
    const result = selfIn(box, demo, ["work", "start", id], asSession("alpha", ALIVE));
    assert.equal(result.code, 0);
    assert.match(result.out, new RegExp(`# ${id} — outcome`), "start prints the brief");
    assert.equal(startsOf(id).length, 1);
    assert.match(startsOf(id)[0].origin.session, /^alpha-\d+$/);
    assert.doesNotMatch(result.out, /held by/, "nothing held it, so nothing is disclosed");
});

/* ── cell 2: this session already holds it ─────────────────────────── */

test("the holding session gets the brief again and records no second claim", () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "start", id], asSession("alpha", ALIVE));
    const again = selfIn(box, demo, ["work", "start", id], asSession("alpha", ALIVE));
    assert.equal(again.code, 0);
    assert.match(again.out, new RegExp(`# ${id} — outcome`));
    assert.match(again.out, /held by this session/);
    assert.equal(startsOf(id).length, 1, "a second claim by the same session is not recorded");
});

/* ── cell 3: another session holds it, and it is running ───────────── */

test("a live holder is disclosed, the brief still comes back, and nothing is refused", () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "start", id], asSession("alpha", ALIVE));
    const other = selfIn(box, demo, ["work", "start", id], asSession("beta", ALIVE));
    assert.equal(other.code, 0, "a claim discloses; it never refuses");
    assert.match(other.out, /held by another session, running since \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(other.out, new RegExp(`# ${id} — outcome`));
    assert.equal(startsOf(id).length, 1, "a live holder keeps the claim");
});

/* ── cell 4: another session holds it, and this machine cannot judge ─ */

test("a holder this machine never recorded reads as last recorded, not as a place", () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "start", id], asSession("alpha"));
    const other = selfIn(box, demo, ["work", "start", id], asSession("beta", ALIVE));
    assert.equal(other.code, 0);
    assert.match(other.out, /held by another session, last recorded \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.equal(startsOf(id).length, 1, "an unjudgeable holder keeps the claim");
});

/* ── cell 5: the holder ended ──────────────────────────────────────── */

test("a holder whose process is gone reads as ended, and the claim moves", () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "start", id], asSession("alpha", GONE));
    const other = selfIn(box, demo, ["work", "start", id], asSession("beta", ALIVE));
    assert.equal(other.code, 0);
    assert.match(other.out, /was held by another session, ended \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    const starts = startsOf(id);
    assert.equal(starts.length, 2, "the claim moves to the session that picked it up");
    assert.match(starts[1].origin.session, /^beta-\d+$/);
});

/* ── cell 6: the unit is closed ────────────────────────────────────── */

test("a done unit is refused and records no claim", () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "done", id, "--report", "shipped in commit abc123"], asSession("alpha", ALIVE));
    const before = startsOf(id).length;
    const result = selfIn(box, demo, ["work", "start", id], asSession("beta", ALIVE));
    assert.equal(result.code, 1);
    assert.match(result.out, /already done/);
    assert.equal(startsOf(id).length, before, "a refused start records nothing");
});

/* ── cell 7: a non-holder reports, closes or retires ───────────────── */

test("a non-holder is told who holds the unit and is not refused", () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "start", id], asSession("alpha", ALIVE));
    const reported = selfIn(box, demo, ["report", id, "progress from another session"], asSession("beta", ALIVE));
    assert.equal(reported.code, 0, "a non-holder may report");
    assert.match(reported.out, /held by another session, running since/);
    const done = selfIn(box, demo, ["work", "done", id, "--report", "closed in commit def456"], asSession("beta", ALIVE));
    assert.equal(done.code, 0, "a non-holder may close the unit");
    assert.match(done.out, /held by another session/);
});

test("a person retiring a unit an agent session holds is told before the approval", async () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "start", id], asSession("alpha", ALIVE));
    // No session of its own: destroying a record needs a person at a terminal
    // (#173), and `human.ts` reads `SUPERSELF_SESSION` existing at all as the
    // mark of an agent's process. So this is the one caller of the disclosure
    // that is never itself a holder.
    const retired = await approvedIn(box, demo, ["work", "retire", id, "--why", "outcome was given up"], id);
    assert.equal(retired.code, 0, "the holder is disclosed, not refused");
    assert.match(retired.out, /held by another session, running since/);
});

/* ── cell 8: a unit started before sessions were stamped ───────────── */

test("a start with no session recorded reads as unclaimed, not as an anonymous holder", () =>
{
    const id = freshUnit();
    // The event a pre-#230 CLI wrote: an `entity.started` with nothing on
    // `origin.session`. The fixture writes it and refolds, as it does for
    // every event a verb of today cannot produce.
    retireFixture(box, ws, "demo", "entity.started", { entity: id });
    assert.equal(startsOf(id).length, 1);
    const result = selfIn(box, demo, ["work", "start", id], asSession("alpha", ALIVE));
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.out, /held by/, "no session on the event is no holder");
    assert.equal(startsOf(id).length, 2, "the claim is recorded over it");
});

/* ── the boundaries the design is held to ──────────────────────────── */

test("work show reads three times and records nothing", () =>
{
    const id = freshUnit();
    const before = readFileSync(log, "utf8").length;
    must(box, demo, ["work", "show", id], asSession("alpha", ALIVE));
    must(box, demo, ["work", "show", id], asSession("beta", ALIVE));
    must(box, demo, ["work", "show", id], asSession("beta", ALIVE));
    assert.equal(readFileSync(log, "utf8").length, before, "looking at a unit is never a claim");
});

test("work show renders the holder above the brief", () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "start", id], asSession("alpha", ALIVE));
    const shown = must(box, demo, ["work", "show", id], asSession("beta", ALIVE)).out;
    const holder = shown.indexOf("held by another session");
    const brief = shown.indexOf(`# ${id}`);
    assert.notEqual(holder, -1, "the holder is disclosed");
    assert.notEqual(brief, -1, "the brief is printed");
    assert.ok(holder < brief, "the holder reads before the brief");
});

test("the holder renders in context and in the work list", () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "start", id], asSession("alpha", ALIVE));
    assert.match(must(box, demo, ["context"], asSession("beta", ALIVE)).out, /held by another session, running since/);
    assert.match(must(box, demo, ["work"], asSession("beta", ALIVE)).out, /held by another session, running since/);
    assert.match(must(box, demo, ["work"], asSession("alpha", ALIVE)).out, /held by this session/);
});

/* ── state start answers the same way work start does (#231) ───────── */

// The nine cells of #231's table. `state start` writes the same
// `entity.started` as `work start`, so the claim judgment behind it is one
// implementation and these cells assert that both verbs reach it.

function entityIdIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no entity id in: ${text}`);
    }
    return match[0];
}

function freshEntity()
{
    seq += 1;
    return entityIdIn(must(box, demo, ["state", "add", `raw record ${seq}`]).out);
}

function entityStartsOf(id)
{
    return startsOf(id);
}

test("state start: cells 1 and 6 — an unclaimed record is claimed", () =>
{
    const open = freshEntity();
    const first = must(box, demo, ["state", "start", open], asSession("alpha", ALIVE));
    assert.doesNotMatch(first.out, /held by/, "cell 1: nothing held it");
    assert.equal(entityStartsOf(open).length, 1);

    const legacy = freshEntity();
    // Cell 6: in-progress from a start that carried no session, as every log
    // written before #230 did.
    retireFixture(box, ws, "demo", "entity.started", { entity: legacy });
    const taken = must(box, demo, ["state", "start", legacy], asSession("alpha", ALIVE));
    assert.doesNotMatch(taken.out, /held by/, "cell 6: no session on the event is no holder");
    assert.equal(entityStartsOf(legacy).length, 2, "the claim lands over it");
});

test("state start: cell 2 — the holding session is told, and records no second claim", () =>
{
    const id = freshEntity();
    must(box, demo, ["state", "start", id], asSession("alpha", ALIVE));
    const again = must(box, demo, ["state", "start", id], asSession("alpha", ALIVE));
    assert.match(again.out, /held by this session/);
    assert.equal(entityStartsOf(id).length, 1);
});

test("state start: cell 3 — a live holder is disclosed and not refused", () =>
{
    const id = freshEntity();
    must(box, demo, ["state", "start", id], asSession("alpha", ALIVE));
    const other = selfIn(box, demo, ["state", "start", id], asSession("beta", ALIVE));
    assert.equal(other.code, 0, "the refusal this issue removes");
    assert.match(other.out, /held by another session, running since/);
    assert.equal(entityStartsOf(id).length, 1, "a live holder keeps the claim");
});

test("state start: cell 4 — a holder this machine cannot judge reads as last recorded", () =>
{
    const id = freshEntity();
    must(box, demo, ["state", "start", id], asSession("alpha"));
    const other = selfIn(box, demo, ["state", "start", id], asSession("beta", ALIVE));
    assert.equal(other.code, 0);
    assert.match(other.out, /held by another session, last recorded/);
    assert.equal(entityStartsOf(id).length, 1);
});

test("state start: cell 5 — a holder whose process is gone hands the claim over", () =>
{
    const id = freshEntity();
    must(box, demo, ["state", "start", id], asSession("alpha", GONE));
    const other = must(box, demo, ["state", "start", id], asSession("beta", ALIVE));
    assert.match(other.out, /was held by another session, ended/);
    assert.equal(entityStartsOf(id).length, 2);
});

test("state start: cells 7 and 8 — the blocked and terminal refusals are untouched", async () =>
{
    const blocked = freshEntity();
    must(box, demo, ["state", "start", blocked], asSession("alpha", ALIVE));
    must(box, demo, ["state", "block", blocked, "--why", "waiting on upstream"], asSession("alpha", ALIVE));
    const onBlocked = selfIn(box, demo, ["state", "start", blocked], asSession("beta", ALIVE));
    assert.equal(onBlocked.code, 1, "cell 7");
    assert.match(onBlocked.out, /is blocked — unblock it first/);

    const done = freshEntity();
    must(box, demo, ["state", "done", done, "--report", "verified output landed"], asSession("alpha", ALIVE));
    const onDone = selfIn(box, demo, ["state", "start", done], asSession("beta", ALIVE));
    assert.equal(onDone.code, 1, "cell 8");
    assert.match(onDone.out, /terminal/);
});

// Cell 9 as filed read "on a non-work entity, cells 1-6 apply identically",
// which is what every cell above already drives. The cell worth asserting is
// the boundary underneath it: the two verbs never reach the same record, so
// what keeps them consistent is the shared judgment, not a shared target.
test("state start: cell 9 — a work record keeps its own verb, and the judgment is still shared", () =>
{
    const unit = freshUnit();
    must(box, demo, ["work", "start", unit], asSession("alpha", ALIVE));
    const viaState = selfIn(box, demo, ["state", "start", unit], asSession("beta", ALIVE));
    assert.equal(viaState.code, 1, "a preset record's lifecycle stays with its own verbs");
    assert.match(viaState.out, /is a work record/);
    assert.equal(startsOf(unit).length, 1, "and nothing was recorded on the way to the refusal");
});

test("no pid and no machine name reach the synced log", () =>
{
    const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.trim() !== "");
    for (const line of lines)
    {
        const event = JSON.parse(line);
        assert.equal(JSON.stringify(event).includes(`"pid"`), false, "a pid is machine-local");
        assert.ok(event.origin.session === undefined || /^[A-Za-z0-9-]+$/.test(event.origin.session),
            "a session is an opaque token, not a sentence naming a machine");
    }
});
