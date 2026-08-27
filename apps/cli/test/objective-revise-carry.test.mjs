// Objective revise carries every live milestone to the successor (#333).
//
// Every test below is one cell of the case table in the 2026-08-23 comment on
// issue #333 (issuecomment-5381843866), named by its cell id, and asserts
// that cell's stated outcome. The mechanism: `objective revise` records the
// successor's `entity.confirmed` and, in the same write, one `entity.linked`
// `member-of <successor>` per live milestone — not dropped, not superseded;
// reached counts. No stored row moves and nothing is unlinked: the fold reads
// a milestone's newest member-of edge as its objective and every older one as
// where it was carried from, so the superseded objective lists the plan as
// carried rather than closed, and `self undo` of one link returns that one
// milestone to its predecessor.
//
// Variables: A — the milestone's state under the revised objective
// (unstarted, on-track, reached, dropped, superseded by a later revision);
// B — what the revise changes (outcome, target, success/stop, priority,
// several at once); C — work linked to the milestone (none, one unit, a unit
// also linked elsewhere); D — coverage (none, some, all). The carry decision
// reads only A; B is consumed by the successor's payload, C by the work fold,
// D by the coverage fold. So A is covered exhaustively against one shared
// revise (cells 1–8, C and D varied across them), B gets its own cells
// (25–28), and the rest are the reading, history and scope surfaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, logFixture, machine, must, selfIn, workIdIn } from "./harness.mjs";

const objectiveIdIn = (text) => text.match(/\bo-[0-9a-z]{5}\b/)[0];
const milestoneIdIn = (text) => text.match(/\bm-[0-9a-z]{5}\b/)[0];

function eventsOf(ws)
{
    const file = join(ws, ".superself", "projects", "demo", "log.jsonl");
    return readFileSync(file, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

function carryLinks(ws, successor)
{
    return eventsOf(ws).filter((event) => event.type === "entity.linked"
        && event.payload.link.type === "member-of" && event.payload.link.target === successor);
}

// One scratch machine holding the A × C × D fixture under one objective:
// m1 unstarted; m2 on-track with one unit; m3 on-track, one criterion of two
// covered, its unit also linked to another objective; m4 reached with one
// unit; m5 dropped; ma superseded by mb before the revise. Revised once.
async function fixture()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    const run = async (args) => (await must(box, demo, args)).out;
    const approved = (args, answer) => approvedIn(box, demo, args, answer);
    const old = objectiveIdIn(await run(["objective", "add", "plan v1", "--target", "2099-01-01", "--success", "s1", "--stop", "st1"]));
    const other = objectiveIdIn(await run(["objective", "add", "other objective"]));
    const m1 = milestoneIdIn(await run(["milestone", "add", "m1 unstarted", "--objective", old, "--exit", "a"]));
    const m2 = milestoneIdIn(await run(["milestone", "add", "m2 on-track", "--objective", old, "--exit", "b"]));
    const w1 = workIdIn(await run(["work", "add", "w1 for m2"]));
    await run(["work", "link", w1, "--milestone", m2]);
    const m3 = milestoneIdIn(await run(["milestone", "add", "m3 partial", "--objective", old, "--exit", "c", "--exit", "d"]));
    const w2 = workIdIn(await run(["work", "add", "w2 for m3 and other"]));
    await run(["work", "link", w2, "--milestone", m3, "--objective", other]);
    await run(["milestone", "met", m3, "--criterion", "c1", "--why", "first half", "--work", w2]);
    const m4 = milestoneIdIn(await run(["milestone", "add", "m4 reached", "--objective", old, "--exit", "e"]));
    const w3 = workIdIn(await run(["work", "add", "w3 for m4"]));
    await run(["work", "link", w3, "--milestone", m4]);
    await run(["milestone", "met", m4, "--criterion", "c1", "--why", "done", "--work", w3]);
    await run(["milestone", "reach", m4]);
    const m5 = milestoneIdIn(await run(["milestone", "add", "m5 dropped", "--objective", old, "--exit", "f"]));
    await approved(["milestone", "drop", m5, "--why", "not needed"], m5);
    const ma = milestoneIdIn(await run(["milestone", "add", "ma superseded", "--objective", old, "--exit", "g"]));
    const mb = milestoneIdIn((await approved(["milestone", "revise", ma, "--why", "widened", "--exit", "h"], ma)).printed);
    const pages = {};
    for (const id of [m1, m2, m3, m4, m5, ma, mb])
    {
        pages[id] = await run(["milestone", "show", id]);
    }
    const before = {
        pages,
        confirmed: eventsOf(ws).filter((event) => event.type === "entity.confirmed" && /^m-/.test(String(event.payload.entity)))
    };
    const receipt = (await approved(["objective", "revise", old, "--why", "wording after discussion", "--outcome", "plan v2"], old)).printed;
    const successor = objectiveIdIn(receipt);
    return { box, ws, demo, run, approved, old, other, successor, receipt, before, m1, m2, m3, m4, m5, ma, mb, w1, w2, w3 };
}

const F = await fixture();
const state = (page) => page.match(/^- State: (.*)$/m)[1];
const objectiveLine = (page) => page.match(/^- Objective: (.*)$/m)[1];
const afterPage = (id) => F.run(["milestone", "show", id]);

test("cell 1: an unstarted milestone with no work and no coverage carries unchanged", async () =>
{
    const page = await afterPage(F.m1);
    assert.match(objectiveLine(page), new RegExp(`^${F.successor} plan v2`));
    assert.equal(state(page), state(F.before.pages[F.m1]));
    assert.match(page, /unstarted — no work linked yet/);
    assert.match(page, /- Work: none linked/);
    assert.match(page, /c1 — a _\(open\)_/);
});

test("cell 2: an on-track milestone carries with its one linked unit and its target untouched", async () =>
{
    const page = await afterPage(F.m2);
    assert.match(objectiveLine(page), new RegExp(`^${F.successor} `));
    assert.equal(state(page), state(F.before.pages[F.m2]));
    assert.match(page, new RegExp(`- Work: ${F.w1}$`, "m"));
});

test("cell 3: partial coverage and a unit linked elsewhere both survive the carry", async () =>
{
    const page = await afterPage(F.m3);
    assert.match(objectiveLine(page), new RegExp(`^${F.successor} `));
    assert.match(page, /c1 — c _\(covered\)_/);
    assert.match(page, /c2 — d _\(open\)_/);
    assert.match(page, new RegExp(`- Work: ${F.w2}$`, "m"));
    assert.match(await F.run(["work", "show", F.w2]), new RegExp(`Contributes to: ${F.other} other objective \\(on-track\\); ${F.m3} m3 partial \\(on-track\\)`));
});

test("cell 4: a reached milestone carries with its reach, criteria and evidence intact", async () =>
{
    const page = await afterPage(F.m4);
    assert.match(objectiveLine(page), new RegExp(`^${F.successor} `));
    assert.equal(state(page), state(F.before.pages[F.m4]));
    assert.match(page, /^- State: reached — /m);
    assert.equal(page.match(/^- Reached: .*$/m)[0], F.before.pages[F.m4].match(/^- Reached: .*$/m)[0]);
    assert.match(page, new RegExp(`- Work: ${F.w3}$`, "m"));
});

test("cell 5: a dropped milestone stays under the predecessor and is not counted", async () =>
{
    const page = await afterPage(F.m5);
    assert.match(objectiveLine(page), new RegExp(`^${F.old} plan v1`));
    assert.match(page, /^- State: closed — dropped — not needed$/m);
    assert.ok(!(await F.run(["objective", "show", F.successor])).includes(`## Milestone ${F.m5}`), "the dropped milestone moved");
    assert.equal(carryLinks(F.ws, F.successor).some((event) => event.payload.entity === F.m5), false);
});

test("cell 6: a milestone already superseded stays behind and its successor carries", async () =>
{
    const stayed = await afterPage(F.ma);
    assert.match(objectiveLine(stayed), new RegExp(`^${F.old} `));
    assert.match(stayed, new RegExp(`^- State: closed — superseded by ${F.mb} — `, "m"));
    const moved = await afterPage(F.mb);
    assert.match(objectiveLine(moved), new RegExp(`^${F.successor} `));
    assert.match(moved, /^- State: unstarted — /m);
});

test("cell 7: the receipt counts the five carried, and the predecessor keeps only the dropped and the superseded one", async () =>
{
    assert.match(F.receipt, new RegExp(`^${F.successor} — carried 5 milestones from ${F.old}$`, "m"));
    const page = await F.run(["objective", "show", F.old]);
    assert.match(page, new RegExp(`^- Milestones carried to ${F.successor}: ${F.m1}, ${F.m2}, ${F.m3}, ${F.m4}, ${F.mb}$`, "m"));
    assert.deepEqual([...page.matchAll(/^## Milestone (m-[0-9a-z]{5})$/gm)].map((match) => match[1]), [F.m5, F.ma]);
});

test("cell 8: an objective with no milestones revises with a zero count and no link event", async () =>
{
    const bare = objectiveIdIn(await F.run(["objective", "add", "bare objective"]));
    const printed = (await F.approved(["objective", "revise", bare, "--why", "reworded", "--outcome", "bare, reworded"], bare)).printed;
    const successor = objectiveIdIn(printed);
    assert.match(printed, new RegExp(`^${successor} — carried 0 milestones from ${bare}$`, "m"));
    assert.equal(carryLinks(F.ws, successor).length, 0);
});

test("cell 9: the predecessor's page lists the carried milestones and never says its objective is closed", async () =>
{
    const page = await F.run(["objective", "show", F.old]);
    assert.match(page, /^- Status: superseded$/m);
    assert.match(page, new RegExp(`^- Superseded by: ${F.successor}$`, "m"));
    assert.match(page, new RegExp(`^- Milestones carried to ${F.successor}: `, "m"));
    assert.ok(!page.includes("its objective is closed"), page);
    assert.match(page, /^- State: closed — dropped — not needed$/m);
    assert.match(page, new RegExp(`^- State: closed — superseded by ${F.mb} — `, "m"));
});

test("cell 10: the successor's page carries the lineage, the progress of the carried milestones, and their states as they were", async () =>
{
    const page = await F.run(["objective", "show", F.successor]);
    assert.match(page, new RegExp(`^- Supersedes: ${F.old}$`, "m"));
    // 2 covered of 7 live criteria: a + b + c,d + e + g,h; the dropped f stays behind.
    assert.match(page, /^- Progress: 2 of 7 exit criteria covered$/m);
    for (const id of [F.m1, F.m2, F.m3, F.m4, F.mb])
    {
        assert.ok(page.includes(`## Milestone ${id}`), `${id} missing from the successor`);
        assert.ok(page.includes(`- State: ${state(F.before.pages[id])}`), `${id} changed state`);
    }
});

test("cell 11: a carried milestone's page names the successor as its objective and says where it came from", async () =>
{
    const page = await afterPage(F.m3);
    assert.match(page, new RegExp(`^- Objective: ${F.successor} plan v2$`, "m"));
    assert.match(page, new RegExp(`^- Carried from: ${F.old}$`, "m"));
    assert.equal(state(page), state(F.before.pages[F.m3]));
    assert.match(page, new RegExp(`^- Work: ${F.w2}$`, "m"));
    assert.ok(!F.before.pages[F.m3].includes("Carried from"), "a milestone never carried already claimed a source");
});

test("cell 12: self context lists the successor and no longer the superseded objective", async () =>
{
    const out = await F.run(["context"]);
    assert.match(out, /\[objective\] plan v2/);
    assert.ok(!out.includes("[objective] plan v1"), out);
});

test("cell 13: a unit linked only through a milestone keeps its contribution line", async () =>
{
    assert.match(await F.run(["work", "show", F.w1]), new RegExp(`^- Contributes to: ${F.m2} m2 on-track \\(on-track\\)$`, "m"));
});

test("cell 14: the objective listing shows the successor with its milestones and not the predecessor", async () =>
{
    const out = await F.run(["objective"]);
    assert.match(out, new RegExp(`^${F.successor}  on-track  plan v2`, "m"));
    for (const id of [F.m1, F.m2, F.m3, F.m4, F.mb])
    {
        assert.match(out, new RegExp(`^  ${id}  `, "m"));
    }
    assert.ok(!out.includes(F.old), out);
});

test("cell 15: the log holds one member-of link per carried milestone beside the successor's confirmation, and no row was rewritten", () =>
{
    const events = eventsOf(F.ws);
    const links = carryLinks(F.ws, F.successor);
    assert.deepEqual(links.map((event) => event.payload.entity), [F.m1, F.m2, F.m3, F.m4, F.mb]);
    assert.equal(events.some((event) => event.type === "entity.unlinked"), false);
    const confirmed = events.findIndex((event) => event.type === "entity.confirmed" && event.payload.entity === F.successor);
    assert.ok(confirmed !== -1);
    assert.deepEqual(events.slice(confirmed + 1, confirmed + 1 + links.length).map((event) => event.id), links.map((event) => event.id),
        "the carry links were not written in the successor's own append");
    const after = events.filter((event) => event.type === "entity.confirmed" && /^m-/.test(String(event.payload.entity)));
    assert.deepEqual(after, F.before.confirmed, "a milestone's own record changed");
});

test("cell 20: coverage recorded after the carry lands on the milestone and counts on the successor", async () =>
{
    await F.run(["milestone", "met", F.m1, "--criterion", "c1", "--why", "judged after the move"]);
    assert.match(await afterPage(F.m1), /c1 — a _\(covered\)_/);
    assert.match(await F.run(["objective", "show", F.successor]), /^- Progress: 3 of 7 exit criteria covered$/m);
});

test("cell 18: milestone drop is the explicit way a carried milestone leaves, and the carry stays on record", async () =>
{
    await F.approved(["milestone", "drop", F.m2, "--why", "no longer a checkpoint"], F.m2);
    const page = await afterPage(F.m2);
    assert.match(page, new RegExp(`^- Objective: ${F.successor} `, "m"));
    assert.match(page, /^- State: closed — dropped — no longer a checkpoint$/m);
    assert.match(await F.run(["objective", "show", F.old]), new RegExp(`^- Milestones carried to ${F.successor}: .*${F.m2}`, "m"));
});

test("cell 19: milestone revise after the carry creates the successor milestone under the successor objective only", async () =>
{
    const printed = (await F.approved(["milestone", "revise", F.m3, "--why", "widened", "--exit", "more"], F.m3)).printed;
    const next = milestoneIdIn(printed);
    const created = eventsOf(F.ws).find((event) => event.type === "entity.confirmed" && event.payload.entity === next);
    assert.deepEqual(created.payload.links, [{ type: "member-of", target: F.successor }, { type: "supersedes", target: F.m3 }]);
    assert.match(await afterPage(F.m3), new RegExp(`^- State: closed — superseded by ${next} — `, "m"));
    assert.match(await afterPage(next), new RegExp(`^- Objective: ${F.successor} `, "m"));
});

test("cell 21: objective revise from a directory outside every registered project is refused and records nothing", async () =>
{
    const size = eventsOf(F.ws).length;
    const result = await selfIn(F.box, F.box.root, ["objective", "revise", F.successor, "--why", "from nowhere", "--outcome", "x"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /not inside a registered project/);
    assert.equal(eventsOf(F.ws).length, size);
});

test("cell 22: objective show --project from the workspace root renders the carried line", async () =>
{
    const page = (await must(F.box, F.ws, ["objective", "show", F.old, "--project", "demo"])).out;
    assert.match(page, new RegExp(`^- Milestones carried to ${F.successor}: `, "m"));
    assert.ok(!page.includes("its objective is closed"), page);
});

test("cell 23: milestone show --project from the workspace root names the successor and the source", async () =>
{
    const page = (await must(F.box, F.ws, ["milestone", "show", F.m1, "--project", "demo"])).out;
    assert.match(page, new RegExp(`^- Objective: ${F.successor} `, "m"));
    assert.match(page, new RegExp(`^- Carried from: ${F.old}$`, "m"));
});

test("cell 24: a revise the supersede gate refuses writes neither the successor nor a single carry link", async () =>
{
    const gated = objectiveIdIn(await F.run(["objective", "add", "gated objective"]));
    await F.run(["milestone", "add", "gated checkpoint", "--objective", gated, "--exit", "one"]);
    const size = eventsOf(F.ws).length;
    const result = await selfIn(F.box, F.demo, ["objective", "revise", gated, "--why", "piped", "--outcome", "gated, reworded"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /nothing was recorded/);
    assert.equal(eventsOf(F.ws).length, size);
});

test("cell 16: undoing one carry link returns that milestone alone to the predecessor", async () =>
{
    const link = carryLinks(F.ws, F.successor).find((event) => event.payload.entity === F.m1);
    await F.run(["undo", link.id, "--why", "this one was never part of the revised plan"]);
    const page = await afterPage(F.m1);
    assert.match(page, new RegExp(`^- Objective: ${F.old} `, "m"));
    assert.match(page, /^- State: closed — its objective is closed — /m);
    assert.ok(!page.includes("Carried from"), page);
    assert.ok(!(await F.run(["objective", "show", F.successor])).includes(`## Milestone ${F.m1}`));
    assert.match(await F.run(["objective", "show", F.old]), new RegExp(`^- Milestones carried to ${F.successor}: ${F.m2}, ${F.m3}, ${F.m4}, ${F.mb}$`, "m"));
});

test("cell 17: a second revision carries the milestones again, one hop per page", async () =>
{
    const G = await fixture();
    const printed = (await G.approved(["objective", "revise", G.successor, "--why", "again", "--outcome", "plan v3"], G.successor)).printed;
    const newer = objectiveIdIn(printed);
    assert.match(printed, new RegExp(`carried 5 milestones from ${G.successor}$`, "m"));
    const ids = [G.m1, G.m2, G.m3, G.m4, G.mb];
    const newest = await G.run(["objective", "show", newer]);
    for (const id of ids)
    {
        assert.ok(newest.includes(`## Milestone ${id}`), `${id} did not reach the newest objective`);
    }
    assert.match(await G.run(["objective", "show", G.successor]), new RegExp(`^- Milestones carried to ${newer}: ${ids.join(", ")}$`, "m"));
    assert.match(await G.run(["objective", "show", G.old]), new RegExp(`^- Milestones carried to ${G.successor}: ${ids.join(", ")}$`, "m"));
    assert.match(await G.run(["milestone", "show", G.m1]), new RegExp(`^- Carried from: ${G.old}, ${G.successor}$`, "m"));
});

// B on its own: four objectives, one on-track milestone with one unit each,
// revised by a different field every time.
test("cells 25–28: whatever the revise changes, the milestone carries and the successor shows the change", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    const run = async (args) => (await must(box, demo, args)).out;
    const cells = [
        { cell: 25, flags: ["--target", "2099-12-31"], shows: [/^- Timebox: unset, target 2099-12-31$/m] },
        { cell: 26, flags: ["--success", "new success", "--stop", "new stop"], shows: [/^- new success$/m, /^- new stop$/m] },
        { cell: 27, flags: ["--priority", "3"], shows: [/^- Priority: 3$/m] },
        { cell: 28, flags: ["--outcome", "all at once", "--target", "2099-11-30", "--success", "s2", "--stop", "st2", "--priority", "4"],
            shows: [/^# o-[0-9a-z]{5} — all at once$/m, /target 2099-11-30/, /^- s2$/m, /^- st2$/m, /^- Priority: 4$/m] }
    ];
    for (const { cell, flags, shows } of cells)
    {
        const old = objectiveIdIn(await run(["objective", "add", `objective ${cell}`, "--target", "2099-01-01"]));
        const milestone = milestoneIdIn(await run(["milestone", "add", `checkpoint ${cell}`, "--objective", old, "--exit", "one"]));
        const work = workIdIn(await run(["work", "add", `unit ${cell}`]));
        await run(["work", "link", work, "--milestone", milestone]);
        const printed = (await approvedIn(box, demo, ["objective", "revise", old, "--why", `cell ${cell}`, ...flags], old)).printed;
        const successor = objectiveIdIn(printed);
        assert.match(printed, new RegExp(`carried 1 milestone from ${old}$`, "m"), `cell ${cell}`);
        const page = await run(["objective", "show", successor]);
        shows.forEach((pattern) => assert.match(page, pattern, `cell ${cell}: ${pattern}`));
        const shown = await run(["milestone", "show", milestone]);
        assert.match(shown, new RegExp(`^- Objective: ${successor} `, "m"), `cell ${cell}`);
        assert.match(shown, /^- State: on-track — 0 of 1 exit criteria covered across 1 work unit\(s\)$/m, `cell ${cell}`);
        assert.match(shown, new RegExp(`^- Work: ${work}$`, "m"), `cell ${cell}`);
        assert.equal(carryLinks(ws, successor).length, 1, `cell ${cell}`);
    }
});

// A live milestone in a derived state the table's "on-track" stands for:
// blocked, missed and at-risk are read off work and dates, and the carry
// decision reads none of them — only dropped and superseded stay behind.
test("cell 30: a blocked milestone is live and carries with its blocked state", async () =>
{
    const box = machine();
    const { demo } = await demoWorkspace(box);
    const run = async (args) => (await must(box, demo, args)).out;
    const old = objectiveIdIn(await run(["objective", "add", "blocked plan"]));
    const milestone = milestoneIdIn(await run(["milestone", "add", "blocked checkpoint", "--objective", old, "--exit", "one"]));
    const work = workIdIn(await run(["work", "add", "stuck unit"]));
    await run(["work", "link", work, "--milestone", milestone]);
    await run(["work", "block", work, "--on", "external", "--why", "vendor outage"]);
    assert.match(await run(["milestone", "show", milestone]), /^- State: blocked — /m);
    const printed = (await approvedIn(box, demo, ["objective", "revise", old, "--why", "reworded", "--outcome", "blocked plan v2"], old)).printed;
    const successor = objectiveIdIn(printed);
    assert.match(printed, new RegExp(`carried 1 milestone from ${old}$`, "m"));
    const page = await run(["milestone", "show", milestone]);
    assert.match(page, new RegExp(`^- Objective: ${successor} `, "m"));
    assert.match(page, new RegExp(`^- State: blocked — ${work} blocked with 0 of 1 exit criteria covered$`, "m"));
});

// A milestone folded from the pre-cutover `milestone.created` grammar, which
// the fold reads forever: the carry link lands on its derived entity and the
// record moves the same way.
test("cell 29: a legacy milestone carries to the successor like a native one", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    const run = async (args) => (await must(box, demo, args)).out;
    const at = (minute) => `2025-01-02T00:0${minute}:00.000Z`;
    logFixture(ws, "demo", { id: "01hz0000000000000000000o01", ts: at(1), type: "objective.created", project: "demo",
        payload: { objective: "o-lega1", outcome: "legacy plan", success: [], stop: [] }, refs: {}, origin: { actor: "agent", confirmed: true } });
    logFixture(ws, "demo", { id: "01hz0000000000000000000m01", ts: at(2), type: "milestone.created", project: "demo",
        payload: { objective: "o-lega1", milestone: "m-lega1", outcome: "legacy checkpoint", exit: [{ id: "c1", text: "one" }] }, refs: {}, origin: { actor: "agent", confirmed: true } });
    assert.match(await run(["milestone", "show", "m-lega1"]), /^- Objective: o-lega1 legacy plan$/m);
    const printed = (await approvedIn(box, demo, ["objective", "revise", "o-lega1", "--why", "reworded", "--outcome", "legacy plan v2"], "o-lega1")).printed;
    const successor = objectiveIdIn(printed);
    assert.match(printed, /carried 1 milestone from o-lega1$/m);
    const page = await run(["milestone", "show", "m-lega1"]);
    assert.match(page, new RegExp(`^- Objective: ${successor} legacy plan v2$`, "m"));
    assert.match(page, /^- Carried from: o-lega1$/m);
    assert.match(page, /^- State: unstarted — /m);
    assert.match(await run(["objective", "show", "o-lega1"]), new RegExp(`^- Milestones carried to ${successor}: m-lega1$`, "m"));
    assert.ok((await run(["objective", "show", successor])).includes("## Milestone m-lega1"));
});

// #287 cell A9. A revision keeps the predecessor's placement — `carriedPlacement`
// already carried scope, exposure and priority — so a workspace objective's
// successor is workspace-scoped with nothing deciding it a second time. The
// cell lives here because it is a property of revise, not of the new flag.
test("cell A9 (#287): revising a workspace objective carries workspace scope to the successor", async () =>
{
    const box = machine();
    const { demo } = await demoWorkspace(box);
    const run = async (args) => (await must(box, demo, args)).out;
    const objective = objectiveIdIn(await run(["objective", "add", "the company reaches a hundred teams", "--workspace"]));
    const printed = (await approvedIn(box, demo,
        ["objective", "revise", objective, "--why", "restated", "--outcome", "the company reaches two hundred teams"],
        objective)).printed;
    const successor = objectiveIdIn(printed);
    assert.notEqual(successor, objective);
    assert.match(await run(["state", "show", successor]), /placement: workspace · full · priority 10/);
});
