// A goal is an ordinary record (w-1r025). These cases are the approved case
// table for that unit, one test per cell: `goal add` displaces nothing,
// replacing a goal is stated with --supersedes and reaches the #173 gate like
// every other correction, `goal retract` withdraws one, and `goal set` refuses
// while naming its replacement instead of quietly doing the work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, git, idIn, machine, must, selfIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

// Goals accumulate, and half these cells count them, so each one that cares
// about the count gets a project of its own rather than inheriting whatever
// the case above it recorded.
async function project(name)
{
    const dir = join(ws, name);
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    await must(box, dir, ["project", "init", "--name", name, "--desc", `${name} project`]);
    return dir;
}

async function addGoal(dir, text)
{
    return idIn((await must(box, dir, ["goal", "add", text])).out);
}

// A project that has recorded nothing has no log at all, which is the
// strongest form of "nothing was recorded" a refusal can leave behind.
function logLines(slug)
{
    const path = join(ws, ".superself", "projects", slug, "log.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

async function stateFile(slug)
{
    await must(box, join(ws, slug), ["context"]);
    return readFileSync(join(ws, ".superself", "projects", slug, "state.md"), "utf8");
}

/* ── A: goal add displaces nothing ─────────────────────────────────── */

test("A1: the first goal records with no gate in the way", async () =>
{
    const dir = await project("a1");
    const added = await selfIn(box, dir, ["goal", "add", "A1 the first direction"]);
    assert.equal(added.code, 0, added.out);
    assert.match(added.out, /entity\.confirmed recorded/);
    assert.match((await must(box, dir, ["context"])).out, /A1 the first direction/);
});

test("A2: a second goal stands beside the first, which is left untouched", async () =>
{
    const dir = await project("a2");
    const first = await addGoal(dir, "A2 the first direction");
    const added = await selfIn(box, dir, ["goal", "add", "A2 the second direction"]);
    assert.equal(added.code, 0, added.out);
    assert.match((await must(box, dir, ["state", "show", first])).out, /confirmed/);
    const context = (await must(box, dir, ["context"])).out;
    assert.match(context, /A2 the first direction/);
    assert.match(context, /A2 the second direction/);
});

test("A3: a third goal is recorded and all three stand", async () =>
{
    const dir = await project("a3");
    for (const text of ["A3 one", "A3 two"])
    {
        await addGoal(dir, text);
    }
    assert.equal((await selfIn(box, dir, ["goal", "add", "A3 three"])).code, 0);
    const context = (await must(box, dir, ["context"])).out;
    ["A3 one", "A3 two", "A3 three"].forEach((text) => assert.match(context, new RegExp(text)));
});

/* ── B: replacing a goal is stated, and reaches the gate ───────────── */

test("B1: an approved supersession records the add and the lineage as one event", async () =>
{
    const dir = await project("b1");
    const first = await addGoal(dir, "B1 the first direction");
    const replacing = await approvedIn(box, dir, ["goal", "add", "B1 the corrected direction", "--supersedes", first], first);
    assert.equal(replacing.code, 0, replacing.out);
    const written = JSON.parse(logLines("b1").at(-1));
    assert.equal(written.type, "entity.confirmed");
    assert.deepEqual(written.payload.labels, ["goal"]);
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: first }]);
    assert.equal(written.payload.confirmation.method, "tty");
    assert.match((await must(box, dir, ["state", "show", first])).out, /superseded/);
});

test("B2: a supersession from a process with no terminal refuses and records nothing", async () =>
{
    const dir = await project("b2");
    const first = await addGoal(dir, "B2 the standing direction");
    const before = logLines("b2").length;
    const refused = await selfIn(box, dir, ["goal", "add", "B2 a replacement", "--supersedes", first]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /nothing was recorded/);
    assert.match(refused.out, /B2 the standing direction/);
    assert.equal(logLines("b2").length, before);
});

test("B3: a wrong answer at the terminal records nothing", async () =>
{
    const dir = await project("b3");
    const first = await addGoal(dir, "B3 the standing direction");
    const before = logLines("b3").length;
    const wrong = await approvedIn(box, dir, ["goal", "add", "B3 a replacement", "--supersedes", first], "not-the-id");
    assert.equal(wrong.code, 1);
    assert.equal(logLines("b3").length, before);
});

test("B4: superseding two of three goals leaves the third standing", async () =>
{
    const dir = await project("b4");
    const first = await addGoal(dir, "B4 one");
    const second = await addGoal(dir, "B4 two");
    const third = await addGoal(dir, "B4 three");
    const replacing = await approvedIn(box, dir,
        ["goal", "add", "B4 the merged direction", "--supersedes", first, "--supersedes", second], `${first} ${second}`);
    assert.equal(replacing.code, 0, replacing.out);
    assert.match((await must(box, dir, ["state", "show", first])).out, /superseded/);
    assert.match((await must(box, dir, ["state", "show", second])).out, /superseded/);
    assert.match((await must(box, dir, ["state", "show", third])).out, /confirmed/);
    const context = (await must(box, dir, ["context"])).out;
    assert.match(context, /B4 three/);
    assert.match(context, /B4 the merged direction/);
});

test("B5: --supersedes naming another record kind refuses with that kind's add verb", async () =>
{
    const dir = await project("b5");
    const decision = idIn((await must(box, dir, ["decide", "B5 a decision, not a goal"])).out);
    const refused = await selfIn(box, dir, ["goal", "add", "B5 a goal", "--supersedes", decision]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /self decide/);
});

test("B6: --supersedes naming no record at all refuses", async () =>
{
    const dir = await project("b6");
    const refused = await selfIn(box, dir, ["goal", "add", "B6 a goal", "--supersedes", "01zzzzzzzzzzzzzzzzzzzzzzzz"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is not a goal/);
});

test("B7: superseding an already superseded goal destroys nothing, so no gate stands in the way", async () =>
{
    const dir = await project("b7");
    const first = await addGoal(dir, "B7 the first direction");
    assert.equal((await approvedIn(box, dir, ["goal", "add", "B7 the second direction", "--supersedes", first], first)).code, 0);
    const again = await selfIn(box, dir, ["goal", "add", "B7 a third direction", "--supersedes", first]);
    assert.equal(again.code, 0, again.out);
    assert.match((await must(box, dir, ["context"])).out, /B7 a third direction/);
});

test("B8: undo gives a superseded goal back and leaves the successor standing", async () =>
{
    const dir = await project("b8");
    const first = await addGoal(dir, "B8 the first direction");
    const replacing = await approvedIn(box, dir, ["goal", "add", "B8 the second direction", "--supersedes", first], first);
    const undone = await selfIn(box, dir, ["undo", idIn(replacing.printed), "--why", "it stands beside the first, it does not replace it"]);
    assert.equal(undone.code, 0, undone.out);
    assert.match((await must(box, dir, ["state", "show", first])).out, /confirmed/);
    const context = (await must(box, dir, ["context"])).out;
    assert.match(context, /B8 the first direction/);
    assert.match(context, /B8 the second direction/);
});

test("B9: goal add takes no --why, and says what --why is for", async () =>
{
    const dir = await project("b9");
    const refused = await selfIn(box, dir, ["goal", "add", "B9 a goal", "--why", "a reason"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /goal add takes no --why/);
});

/* ── C: goal set refuses and names its replacement ─────────────────── */

test("C1: goal set refuses, names goal add, and records nothing", async () =>
{
    const dir = await project("c1");
    const before = logLines("c1").length;
    const refused = await selfIn(box, dir, ["goal", "set", "C1 a direction"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /goal add/);
    assert.equal(logLines("c1").length, before);
    assert.doesNotMatch((await must(box, dir, ["context"])).out, /C1 a direction/);
});

test("C2: goal set refuses with a goal standing, and the standing goal is untouched", async () =>
{
    const dir = await project("c2");
    const first = await addGoal(dir, "C2 the standing direction");
    assert.equal((await selfIn(box, dir, ["goal", "set", "C2 a replacement"])).code, 1);
    assert.match((await must(box, dir, ["state", "show", first])).out, /confirmed/);
});

/* ── D: goal retract ───────────────────────────────────────────────── */

test("D1: retracting one goal leaves the others standing", async () =>
{
    const dir = await project("d1");
    const first = await addGoal(dir, "D1 the abandoned direction");
    await addGoal(dir, "D1 the kept direction");
    const retracted = await approvedIn(box, dir, ["goal", "retract", first, "--why", "the market moved"], first);
    assert.equal(retracted.code, 0, retracted.out);
    const context = (await must(box, dir, ["context"])).out;
    assert.doesNotMatch(context, /D1 the abandoned direction/);
    assert.match(context, /D1 the kept direction/);
});

test("D2: retracting the last goal leaves the one-line surfaces reading not set", async () =>
{
    const dir = await project("d2");
    const only = await addGoal(dir, "D2 the only direction");
    assert.equal((await approvedIn(box, dir, ["goal", "retract", only, "--why", "it was never this project's"], only)).code, 0);
    assert.doesNotMatch((await must(box, dir, ["context"])).out, /D2 the only direction/);
    assert.match((await must(box, dir, ["status"])).out, /not set/);
});

test("D3: a retraction from a process with no terminal refuses and records nothing", async () =>
{
    const dir = await project("d3");
    const only = await addGoal(dir, "D3 the standing direction");
    const before = logLines("d3").length;
    const refused = await selfIn(box, dir, ["goal", "retract", only, "--why", "no longer holds"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /nothing was recorded/);
    assert.equal(logLines("d3").length, before);
});

test("D4: goal retract without --why is refused before anything is disclosed", async () =>
{
    const dir = await project("d4");
    const only = await addGoal(dir, "D4 the standing direction");
    const refused = await selfIn(box, dir, ["goal", "retract", only]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /--why/);
});

test("D5: retracting an already withdrawn goal refuses", async () =>
{
    const dir = await project("d5");
    const only = await addGoal(dir, "D5 the standing direction");
    assert.equal((await approvedIn(box, dir, ["goal", "retract", only, "--why", "it no longer holds"], only)).code, 0);
    const again = await selfIn(box, dir, ["goal", "retract", only, "--why", "again"]);
    assert.equal(again.code, 1);
    assert.match(again.out, /already retracted/);
});

test("D6: goal retract on another record kind refuses", async () =>
{
    const dir = await project("d6");
    const decision = idIn((await must(box, dir, ["decide", "D6 a decision, not a goal"])).out);
    const refused = await selfIn(box, dir, ["goal", "retract", decision, "--why", "wrong verb"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is not a goal/);
});

test("D7: goal retract takes no --supersedes, and says which verb replaces a goal", async () =>
{
    const dir = await project("d7");
    const only = await addGoal(dir, "D7 the standing direction");
    const refused = await selfIn(box, dir, ["goal", "retract", only, "--why", "w", "--supersedes", only]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /goal add/);
});

test("D8: a retracted goal leaves the render and stays reachable by naming it", async () =>
{
    const dir = await project("d8");
    const only = await addGoal(dir, "D8 the withdrawn direction");
    assert.equal((await approvedIn(box, dir, ["goal", "retract", only, "--why", "it no longer holds"], only)).code, 0);
    assert.doesNotMatch((await must(box, dir, ["context"])).out, /D8 the withdrawn direction/);
    // Search answers over live records (#212); the withdrawn goal's own text
    // and history are reached by naming it, which is what keeps nothing
    // unreachable.
    assert.equal((await must(box, dir, ["search", "D8 the withdrawn"])).out.trim(), "no matches");
    assert.match((await must(box, dir, ["state", "show", only, "--history"])).out, /D8 the withdrawn direction/);
});

/* ── E: the bare verb ──────────────────────────────────────────────── */

test("E1: bare goal refuses with both verbs in the usage line", async () =>
{
    const refused = await selfIn(box, demo, ["goal"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /goal add/);
    assert.match(refused.out, /retract/);
});

/* ── F: what the render surfaces answer ────────────────────────────── */

test("F1: with no goal, the file says not set and the one-line surfaces agree", async () =>
{
    const dir = await project("f1");
    assert.match(await stateFile("f1"), /## Goal\n\n_not set_/);
    assert.match((await must(box, dir, ["status"])).out, /not set/);
});

test("F2: one goal renders as itself, with nothing counted behind it", async () =>
{
    const dir = await project("f2");
    await addGoal(dir, "F2 the only direction");
    assert.match(await stateFile("f2"), /## Goal\n\nF2 the only direction/);
    const status = (await must(box, dir, ["status"])).out;
    assert.match(status, /F2 the only direction/);
    assert.doesNotMatch(status, /\+\d+ more/);
});

test("F3: three goals all render in the file, and the one-line surfaces count the rest", async () =>
{
    const dir = await project("f3");
    for (const text of ["F3 one", "F3 two", "F3 three"])
    {
        await addGoal(dir, text);
    }
    const file = await stateFile("f3");
    ["F3 one", "F3 two", "F3 three"].forEach((text) => assert.match(file, new RegExp(text)));
    assert.match((await must(box, dir, ["status"])).out, /\(\+2 more\)/);
    const context = (await must(box, dir, ["context"])).out;
    ["F3 one", "F3 two", "F3 three"].forEach((text) => assert.match(context, new RegExp(text)));
});
