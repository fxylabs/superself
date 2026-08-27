// A standalone work proposal is revisable until its first start (#356).
//
// Every test here is one cell of docs/maintainers/case-tables/356-revisable-proposals.md,
// named by its cell number. The table is the review surface; a cell it lacks is
// a path nothing proves. The vocabulary: a *revision* is one stated version of
// a work record's plan text — the creation is v1, `work revise` states v2, v3 …
// under the same `w-` id.
//
// | #  | State                                   | Operation           | Expected |
// |----|-----------------------------------------|---------------------|----------|
// | 1  | no objective or milestone               | `work propose`      | one proposed work id, rendered for review |
// | 2  | objective and full brief                | `work propose`      | unchanged; missing brief flags refused in one gate refusal |
// | 3  | open v1, never started                  | `revise`            | same id; v2 current; v1 and the reason stay in history |
// | 4  | open v2                                 | `accept`            | same id confirmed; the confirm names the v2 event |
// | 5  | accepted v2, never started              | `revise`            | back to review; v3 current, v2 accepted |
// | 6  | proposed, or a stale acceptance         | `work start`        | refused, naming the accept command |
// | 7  | accepted revision is current            | `work start`        | starts, records the claim |
// | 8  | the id has ever started                 | `revise`            | refused, naming the successor spelling |
// | 9  | two clones, both merge orders           | fold                | v2 current, v1 accepted, byte-identical pages |
// | 10 | a `work add` unit                       | add/start/revise    | unchanged; revise refused |
// | 11 | a terminal render and a pipe            | listing             | review state and version in both |
// | 12 | read outside the checkout               | `accept`            | resolves through the record |
// | 13 | cwd inside the project                  | `revise`            | records into the owning log |
// | 14 | cwd is the workspace root               | `revise`            | refused: no project answers here |
// | 15 | cwd is the workspace root, `--project`  | `work show`         | answers, with review state and revisions |
// | 16 | cwd is outside any project              | `revise`            | refused by the project resolver |
// | 17 | cwd is outside any project              | `accept`            | resolves through the record |
// | 18 | v3 current, v2 accepted                 | `undo <v3>`         | v2 current and accepted again |
// | 19 | v2 accepted                             | `undo <accept>`     | refused by name; names `work revise` |
// | 20 | a gap proposal, never started           | `revise` + `accept` | the member-of edge is untouched |
// | 21 | v2 current                              | `revise` same text  | refused; nothing recorded |
// | 22 | a done unit                             | `revise`            | refused: already done |
// | 23 | a retired unit                          | `revise`            | refused with the retirement's reason |
// | 25 | a declined proposal                     | `revise`            | refused: already declined |
// | 26 | accepted, started, then blocked         | `revise`            | refused — the freeze is not the status |
// | 27 | v3 awaiting review                      | listing and count   | one row, counted once |
// | 28 | v3 awaiting review                      | `search`            | finds it |
// | 29 | two revisions in the same millisecond   | fold                | one order on every clone |
// | 30 | a revision naming a withdrawn record    | fold                | folds to nothing |
// | 31 | v2 accepted, a confirm naming v1 merged | fold                | still accepted |
// | 32 | a unit awaiting review                  | `report --design`   | allowed |
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, idIn, logFixture, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

function events(root = ws, project = "demo")
{
    return readFileSync(join(root, ".superself", "projects", project, "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
}

// The proposal's own creation line, which a second clone is seeded from.
function creationOf(id, root = ws)
{
    const found = events(root).find((event) => event.type === "entity.proposed" && event.payload.entity === id);
    assert.notEqual(found, undefined, `no entity.proposed for ${id}`);
    return found;
}

function eventOf(id, type, root = ws)
{
    return events(root).filter((event) => event.type === type && event.payload.entity === id).at(-1);
}

// One standalone plan, proposed. Every cell that needs a plan under review
// starts here, so the ordinary path is exercised by every one of them.
async function propose(plan, cwd = demo)
{
    return workIdIn((await must(box, cwd, ["work", "propose", plan])).out);
}

function revise(id, plan, why, cwd = demo)
{
    return must(box, cwd, ["work", "revise", id, plan, "--why", why]);
}

async function show(id, cwd = demo)
{
    return (await must(box, cwd, ["work", "show", id])).out;
}

const BRIEF = ["--value", "closes the gap", "--success", "it ships", "--stop", "if superseded",
    "--risk", "low", "--capacity", "one round", "--evidence-plan", "a recorded run",
    "--confidence", "high", "--expires", "2099-01-01"];

test("1: a plan proposed with no objective or milestone is recorded and rendered for review", async () =>
{
    const plan = "1: read the loader and cut its timeout to 5s";
    const id = await propose(plan);
    const created = events().filter((event) => event.type === "entity.proposed" && event.payload.entity === id);
    assert.equal(created.length, 1, "a standalone proposal is one entity.proposed and nothing else");
    assert.deepEqual(created[0].payload.labels, ["work"]);
    assert.equal(created[0].payload.value, undefined, "a standalone proposal carries no gap brief");
    const context = (await must(box, demo, ["context"])).out;
    assert.ok(context.includes(`work proposal ${id} (v1 — not yet accepted): ${plan} — \`self work accept ${id}\``),
        `the standalone proposal is not in the waiting band:\n${context}`);
    assert.ok(context.includes(`self work accept ${id}`), `context advertised no accept command:\n${context}`);
});

test("2: a gap proposal still owes its full brief, and one refusal names every missing flag", async () =>
{
    const objective = (await must(box, demo, ["objective", "add", "2: a measurable outcome", "--target", "2099-01-01"]))
        .out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const short = await selfIn(box, demo, ["work", "propose", "2: half a brief", "--objective", objective, "--value", "some"]);
    assert.equal(short.code, 1);
    assert.match(short.out, /needs \d+ more options/);
    assert.match(short.out, /--success/);
    assert.match(short.out, /--expires/);
    const id = workIdIn((await must(box, demo, ["work", "propose", "2: a whole brief", "--objective", objective, ...BRIEF])).out);
    assert.equal(creationOf(id).payload.value, "closes the gap");
    const stray = await selfIn(box, demo, ["work", "propose", "2: a brief with no gap", "--value", "some"]);
    assert.equal(stray.code, 1);
    assert.match(stray.out, /--value belongs to a gap proposal/);
});

test("3: revising an open plan keeps the id, and history keeps the version it replaced", async () =>
{
    const id = await propose("3: cut the timeout to 5s");
    const receipt = (await revise(id, "3: cut the timeout to 3s and add one retry", "5s still times out in CI")).out;
    assert.match(receipt, new RegExp(`${id} — v2; a person runs .self work accept ${id}.`));
    assert.match(await show(id), /- Plan: v2 — not yet accepted/);
    assert.ok((await show(id)).includes("3: cut the timeout to 3s and add one retry"), "the current plan is not the revision");
    const history = (await must(box, demo, ["work", "show", id, "--history"])).out;
    assert.ok(history.includes("3: cut the timeout to 5s"), `v1 left the unit's history:\n${history}`);
    assert.ok(history.includes("5s still times out in CI"), `the reason left the unit's history:\n${history}`);
});

test("4: accepting binds the exact revision, and the same id becomes ordinary next work", async () =>
{
    const id = await propose("4: cut the timeout to 5s");
    const revised = idIn((await revise(id, "4: cut the timeout to 3s", "5s still times out in CI")).out);
    await mustPerson(box, demo, ["work", "accept", id]);
    assert.equal(eventOf(id, "entity.confirmed").refs.confirms, revised,
        "the acceptance names the record rather than the revision it read");
    assert.match(await show(id), /- Status: next/);
    assert.ok(!(await show(id)).includes("- Plan:"), "an accepted current plan still says it is waiting");
});

test("5: revising an accepted plan that never started returns it to review under the same id", async () =>
{
    const id = await propose("5: cut the timeout to 5s");
    await revise(id, "5: cut the timeout to 3s", "5s still times out in CI");
    await mustPerson(box, demo, ["work", "accept", id]);
    await revise(id, "5: cut the timeout to 3s and pin the clock", "the retry needs a stable clock");
    const page = await show(id);
    assert.match(page, /- Status: review/);
    assert.match(page, /- Plan: v3 \(current\) · v2 accepted/);
    assert.match(page, new RegExp(`- A person accepts it: self work accept ${id}`));
});

test("6: start is refused while the current plan is unaccepted, and again while it is stale", async () =>
{
    const id = await propose("6: cut the timeout to 5s");
    const never = await selfIn(box, demo, ["work", "start", id]);
    assert.equal(never.code, 1);
    assert.match(never.out, new RegExp(`${id} is waiting on review — its plan \\(v1\\) has not been accepted; a person runs .self work accept ${id}.`));
    await mustPerson(box, demo, ["work", "accept", id]);
    await revise(id, "6: cut the timeout to 3s", "5s still times out in CI");
    const stale = await selfIn(box, demo, ["work", "start", id]);
    assert.equal(stale.code, 1);
    assert.match(stale.out, new RegExp(`${id} is waiting on review — v1 was accepted and v2 is the current plan; a person runs .self work accept ${id}.`));
});

test("7: an accepted current plan starts, prints the brief and records the claim", async () =>
{
    const id = await propose("7: cut the timeout to 5s");
    await revise(id, "7: cut the timeout to 3s", "5s still times out in CI");
    await mustPerson(box, demo, ["work", "accept", id]);
    const started = await must(box, demo, ["work", "start", id], { SUPERSELF_SESSION: "s-seven" });
    assert.ok(started.out.includes("7: cut the timeout to 3s"), `the brief was not handed over:\n${started.out}`);
    assert.notEqual(eventOf(id, "entity.started"), undefined, "no claim was recorded");
    assert.match(await show(id), /- Status: active/);
});

test("8: once a unit has started, its plan is frozen and the refusal names the successor path", async () =>
{
    const id = await propose("8: cut the timeout to 5s");
    await mustPerson(box, demo, ["work", "accept", id]);
    await must(box, demo, ["work", "start", id], { SUPERSELF_SESSION: "s-eight" });
    const refused = await selfIn(box, demo, ["work", "revise", id, "8: cut it to 3s", "--why", "too late"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`${id} has already been picked up`));
    assert.match(refused.out, new RegExp(`self work add "<outcome>" --supersedes ${id} --why w`));
    assert.equal(eventOf(id, "entity.revised"), undefined, "the refused revision was recorded anyway");
});

// The union merge, both ways round. Two clones hold the same proposal; one
// accepts v1 offline and the other states v2 offline, and each pulls the
// other's line. Neither clone may read the v1 acceptance as authorizing v2.
test("9: an acceptance of v1 and a revision to v2 fold the same way in either merge order", async () =>
{
    const other = machine();
    const there = await demoWorkspace(other);
    const id = await propose("9: cut the timeout to 5s");
    // Clone B is seeded with the proposal alone, and neither clone sees the
    // other's answer until the merge below.
    logFixture(there.ws, "demo", creationOf(id));
    await mustPerson(box, demo, ["work", "accept", id]);
    const accepted = eventOf(id, "entity.confirmed");
    await must(other, there.demo, ["work", "revise", id, "9: cut the timeout to 3s", "--why", "5s times out"]);
    const revision = eventOf(id, "entity.revised", there.ws);
    // Opposite orders: here the revision lands after the acceptance, there the
    // acceptance lands after the revision.
    logFixture(ws, "demo", revision);
    logFixture(there.ws, "demo", accepted);
    const here = await show(id);
    const away = (await must(other, there.demo, ["work", "show", id])).out;
    assert.match(here, /- Plan: v2 \(current\) · v1 accepted/);
    assert.equal(here, away, "the two clones fold one plan history to different pages");
    for (const [where, at] of [[box, demo], [other, there.demo]])
    {
        const refused = await selfIn(where, at, ["work", "start", id]);
        assert.equal(refused.code, 1);
        assert.match(refused.out, /waiting on review — v1 was accepted and v2 is the current plan/);
    }
});

test("10: a work add unit behaves exactly as it did, and refuses a revision by name", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "10: the already-approved outcome"])).out);
    assert.match(await show(id), /- Status: next/);
    const refused = await selfIn(box, demo, ["work", "revise", id, "10: something else", "--why", "a correction"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /which is the already-approved path/);
    assert.match(refused.out, new RegExp(`--supersedes ${id} --why w`));
    await must(box, demo, ["work", "start", id], { SUPERSELF_SESSION: "s-ten" });
    await must(box, demo, ["report", id, "10: it happened"]);
    await must(box, demo, ["work", "done", id, "--report", "10: the outcome verifiably landed"]);
    assert.match(await show(id), /- Status: done/);
});

test("11: the review state and the version read the same in the ruled render and in a pipe", async () =>
{
    const id = await propose("11: cut the timeout to 5s");
    await revise(id, "11: cut the timeout to 3s", "5s still times out in CI");
    const piped = (await must(box, demo, ["work", "--plain"])).out;
    const ruled = (await must(box, demo, ["work", "--pretty"])).out;
    for (const render of [piped, ruled])
    {
        assert.ok(render.includes(id), `the unit left one render:\n${render}`);
        assert.ok(render.includes("review"), `the review state left one render:\n${render}`);
    }
    const context = (await must(box, demo, ["context"])).out;
    assert.ok(context.includes(`work proposal ${id} (v2 — not yet accepted)`), `context lost the version:\n${context}`);
    assert.ok(context.includes(`self work accept ${id}`), `context advertised no accept command:\n${context}`);
});

test("12: a standalone proposal is accepted from outside its checkout, through the record", async () =>
{
    const id = await propose("12: cut the timeout to 5s");
    const accepted = await mustPerson(box, ws, ["work", "accept", id]);
    assert.ok(accepted.out.includes(id));
    assert.match(await show(id), /- Status: next/);
});

test("13: a revision run inside the project records into the log that owns the record", async () =>
{
    const id = await propose("13: cut the timeout to 5s");
    await revise(id, "13: cut the timeout to 3s", "5s still times out in CI");
    const revision = eventOf(id, "entity.revised");
    assert.notEqual(revision, undefined, "the revision reached no log");
    assert.equal(revision.project, "demo");
    assert.equal(revision.payload.why, "5s still times out in CI");
});

test("14: a revision run at the workspace root is refused: no registered project answers there", async () =>
{
    const id = await propose("14: cut the timeout to 5s");
    const refused = await selfIn(box, ws, ["work", "revise", id, "14: cut it to 3s", "--why", "it times out"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /project/i);
    assert.equal(eventOf(id, "entity.revised"), undefined, "the refused revision was recorded anyway");
});

test("15: work show from the workspace root with --project answers with the review state", async () =>
{
    const id = await propose("15: cut the timeout to 5s");
    await revise(id, "15: cut the timeout to 3s", "5s still times out in CI");
    const page = (await must(box, ws, ["work", "show", id, "--project", "demo"])).out;
    assert.match(page, /- Status: review/);
    assert.match(page, /- Plan: v2 — not yet accepted/);
    const history = (await must(box, ws, ["work", "show", id, "--history", "--project", "demo"])).out;
    assert.ok(history.includes("15: cut the timeout to 5s"), `v1 left the history read from outside:\n${history}`);
});

test("16: a revision run outside every project is refused by the project resolver", async () =>
{
    const id = await propose("16: cut the timeout to 5s");
    const refused = await selfIn(box, box.root, ["work", "revise", id, "16: cut it to 3s", "--why", "it times out"]);
    assert.equal(refused.code, 1);
    assert.equal(eventOf(id, "entity.revised"), undefined, "the refused revision was recorded anyway");
});

test("17: a standalone proposal is accepted from outside every project", async () =>
{
    const id = await propose("17: cut the timeout to 5s");
    const accepted = await mustPerson(box, box.root, ["work", "accept", id]);
    assert.ok(accepted.out.includes(id));
    assert.match(await show(id), /- Status: next/);
});

test("18: undoing a revision makes the version before it current, and accepted again", async () =>
{
    const id = await propose("18: cut the timeout to 5s");
    await revise(id, "18: cut the timeout to 3s", "5s still times out in CI");
    await mustPerson(box, demo, ["work", "accept", id]);
    const third = idIn((await revise(id, "18: cut it to 3s and pin the clock", "the retry needs a stable clock")).out);
    assert.match(await show(id), /- Status: review/);
    const undone = await must(box, demo, ["undo", third, "--why", "the clock was already pinned"]);
    assert.match(undone.out, /states its previous plan again/);
    const page = await show(id);
    assert.match(page, /- Status: next/);
    assert.ok(page.includes("18: cut the timeout to 3s"), `the version before the revision is not current:\n${page}`);
});

test("19: undoing an acceptance is refused by name, and the answer is a revision", async () =>
{
    const id = await propose("19: cut the timeout to 5s");
    const accepted = idIn((await mustPerson(box, demo, ["work", "accept", id])).out);
    const refused = await selfIn(box, demo, ["undo", accepted, "--why", "it should not have been accepted"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /an acceptance is not taken back/);
    assert.match(refused.out, new RegExp(`self work revise ${id}`));
});

test("20: revising a gap proposal keeps its member-of edge, and re-accepting states it once", async () =>
{
    const objective = (await must(box, demo, ["objective", "add", "20: a measurable outcome", "--target", "2099-01-01"]))
        .out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const id = workIdIn((await must(box, demo, ["work", "propose", "20: close the gap", "--objective", objective, ...BRIEF])).out);
    await mustPerson(box, demo, ["work", "accept", id]);
    await revise(id, "20: close the gap another way", "the first way needed a service nobody runs");
    assert.match(await show(id), /- Status: review/);
    await mustPerson(box, demo, ["work", "accept", id]);
    assert.match(await show(id), new RegExp(`Contributes to: ${objective}`));
    const links = events().filter((event) => event.type === "entity.linked" && event.payload.entity === id);
    assert.equal(links.length, 1, "the re-acceptance stated the same edge a second time");
});

test("21: a revision that changes nothing is refused, and records nothing", async () =>
{
    const id = await propose("21: cut the timeout to 5s");
    await revise(id, "21: cut the timeout to 3s", "5s still times out in CI");
    const refused = await selfIn(box, demo, ["work", "revise", id, "21: cut the timeout to 3s", "--why", "again"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /already states this plan/);
    assert.equal(events().filter((event) => event.type === "entity.revised" && event.payload.entity === id).length, 1);
});

test("22: a done unit refuses a revision, saying it is done", async () =>
{
    const id = await propose("22: cut the timeout to 5s");
    await mustPerson(box, demo, ["work", "accept", id]);
    await must(box, demo, ["work", "done", id, "--report", "22: the timeout verifiably fell"]);
    const refused = await selfIn(box, demo, ["work", "revise", id, "22: cut it to 3s", "--why", "too late"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`${id} is already done`));
});

test("23: a retired unit refuses a revision with the reason it was retired for", async () =>
{
    const id = await propose("23: cut the timeout to 5s");
    await mustPerson(box, demo, ["work", "accept", id]);
    await approvedIn(box, demo, ["work", "retire", id, "--why", "the loader was deleted"], id);
    const refused = await selfIn(box, demo, ["work", "revise", id, "23: cut it to 3s", "--why", "too late"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is retired — the loader was deleted/);
    assert.match(refused.out, new RegExp(`self work show ${id}`));
});

test("25: a declined proposal refuses a revision, saying it is declined", async () =>
{
    const id = await propose("25: cut the timeout to 5s");
    await must(box, demo, ["work", "decline", id, "--why", "the loader is being replaced"]);
    const refused = await selfIn(box, demo, ["work", "revise", id, "25: cut it to 3s", "--why", "reviving it"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`${id} is already declined`));
});

test("26: the freeze is the first start, not the current status — a blocked unit is still frozen", async () =>
{
    const id = await propose("26: cut the timeout to 5s");
    await mustPerson(box, demo, ["work", "accept", id]);
    await must(box, demo, ["work", "start", id], { SUPERSELF_SESSION: "s-twentysix" });
    await must(box, demo, ["work", "block", id, "--on", "dependency", "--why", "the loader is being rewritten"]);
    assert.match(await show(id), /- Status: blocked/);
    const refused = await selfIn(box, demo, ["work", "revise", id, "26: cut it to 3s", "--why", "while it waits"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /has already been picked up/);
});

test("27: a plan awaiting review is one row in the listing and one item in the waiting count", async () =>
{
    const before = Number((await must(box, demo, ["status"])).out.match(/waiting on you: (\d+)/)[1]);
    const id = await propose("27: cut the timeout to 5s");
    await revise(id, "27: cut the timeout to 3s", "5s still times out in CI");
    const listed = (await must(box, demo, ["work"])).out.split("\n").filter((line) => line.startsWith(id));
    assert.equal(listed.length, 1, `the unit is listed more than once:\n${listed.join("\n")}`);
    assert.match(listed[0], /\breview\b/);
    const after = Number((await must(box, demo, ["status"])).out.match(/waiting on you: (\d+)/)[1]);
    assert.equal(after, before + 1, "one plan awaiting review counted as more than one thing to answer");
});

test("28: a plan awaiting review is a live record, so search finds it", async () =>
{
    const id = await propose("28: rewrite the loader's retry ladder");
    await revise(id, "28: rewrite the loader's retry ladder and its clock", "the ladder needs a stable clock");
    const found = (await must(box, demo, ["search", "retry ladder"])).out;
    assert.ok(found.includes(id), `search does not find a plan awaiting review:\n${found}`);
});

test("29: two revisions written in the same millisecond settle in one order on every clone", async () =>
{
    const id = await propose("29: cut the timeout to 5s");
    const ts = "2099-01-01T00:00:00.000Z";
    const same = (event, text) => ({
        id: event, ts, type: "entity.revised", project: "demo",
        origin: { actor: "agent", confirmed: false },
        payload: { entity: id, text, why: "two clones wrote at once" }
    });
    // Appended newest-id first, so log order and the settled order disagree.
    logFixture(ws, "demo", same("01hz0000000000000000029zz2", "29: the later revision by id"));
    logFixture(ws, "demo", same("01hz0000000000000000029zz1", "29: the earlier revision by id"));
    const page = await show(id);
    assert.ok(page.includes("29: the later revision by id"), `the id did not break the timestamp tie:\n${page}`);
    assert.match(page, /- Plan: v3 — not yet accepted/);
});

test("30: a revision naming a withdrawn record folds to nothing", async () =>
{
    const id = await propose("30: cut the timeout to 5s");
    await must(box, demo, ["work", "decline", id, "--why", "the loader is being replaced"]);
    logFixture(ws, "demo", {
        id: "01hz0000000000000000030zz1", ts: "2099-01-01T00:00:00.000Z", type: "entity.revised", project: "demo",
        origin: { actor: "agent", confirmed: false },
        payload: { entity: id, text: "30: a plan written in ignorance of the decline", why: "pulled from another clone" }
    });
    const page = (await must(box, demo, ["state", "show", id])).out;
    assert.ok(page.includes("30: cut the timeout to 5s"), `the withdrawn record took the revision:\n${page}`);
    assert.ok(!page.includes("in ignorance of the decline"), `the withdrawal was not terminal:\n${page}`);
    assert.ok(!(await must(box, demo, ["work"])).out.includes(id), "a declined proposal came back as open work");
});

test("31: a confirm naming v1 that arrives after v2 was accepted leaves v2 accepted", async () =>
{
    const id = await propose("31: cut the timeout to 5s");
    await revise(id, "31: cut the timeout to 3s", "5s still times out in CI");
    await mustPerson(box, demo, ["work", "accept", id]);
    assert.match(await show(id), /- Status: next/);
    logFixture(ws, "demo", {
        id: "01hz0000000000000000031zz1", ts: "2099-01-01T00:00:00.000Z", type: "entity.confirmed", project: "demo",
        origin: { actor: "agent", confirmed: true },
        payload: { entity: id }, refs: { confirms: id }
    });
    assert.match(await show(id), /- Status: next/, "a lagging clone's acceptance of v1 sent the accepted v2 back to review");
});

test("32: a design report is admitted on a unit awaiting review — a design precedes the start", async () =>
{
    const decision = idIn((await must(box, demo, ["decide", "32: the loader owns its own timeout"])).out);
    const id = await propose("32: cut the timeout to 5s");
    const reported = await must(box, demo, ["report", id, "32: the design for the timeout", "--design", "--implements", decision]);
    assert.match(reported.out, /design report/);
    assert.ok(reported.out.includes(decision), `the receipt did not echo the cited decision:\n${reported.out}`);
});
