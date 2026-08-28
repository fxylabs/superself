// How a confirmed work record is written, and by whom. The person gate #389
// put on `work add` and `work accept` came off in #400: both write a record
// `self undo` takes straight back, so the gate only made a session print a line
// for a person to paste, and what it bought is bought better by the record
// saying who wrote it.
//
// Every test below is one cell of
// docs/maintainers/case-tables/400-agent-consent.md, named by its number. The
// cells that were #389's are kept and inverted — the subject is the same
// question, and the answer moved — rather than deleted, so what changed is
// legible beside what did not.
//
// Cells 1-8 are the entry itself, 9-13 the correction spelling, 21-24 what a
// reviewed set does with these verbs, 48-49 what the help says, and 51-55 the
// `work accept` → `work confirm` rename. The rest of the table lives in
// agent-consent.test.mjs and work-propose-supersedes.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    approvedIn,
    demoWorkspace,
    drive,
    machine,
    must,
    mustPerson,
    selfIn,
    spawnIn,
    workIdIn
} from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

// The whole log, so a cell can state exactly what an append added.
function events(project = "demo")
{
    const file = join(ws, ".superself", "projects", project, "log.jsonl");
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

// The events one call added, which is what every `by` assertion is about.
function since(before)
{
    return events().slice(before);
}

async function proposal(outcome)
{
    return workIdIn((await must(box, demo, ["work", "propose", outcome])).out);
}

/* ── A: the entry — caller × verb ──────────────────────────────────── */

test("cell 1: a person at a terminal records a confirmed unit in one command", async () =>
{
    const before = events().length;
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 1: the unit a person recorded"])).out);
    assert.match((await must(box, demo, ["work", "show", id])).out, /cell 1: the unit a person recorded/);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.confirmed"]);
    assert.deepEqual(written[0].payload.by, { kind: "person" });
});

// This cell read "an attempt marker refuses the write even with a keyboard
// behind it". The marker still says no person is behind the call — it decides
// what the record says, not whether there is one.
test("cell 2: a runner's child records, and the record names it an agent's write", async () =>
{
    const before = events().length;
    const recorded = await drive(box, demo, ["work", "add", "cell 2: recorded by a runner's child"],
        { person: true, extra: { SUPERSELF_ATTEMPT_ID: "the runner's own attempt", SUPERSELF_SESSION: "runner-1" } });
    assert.equal(recorded.code, 0, recorded.out);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.confirmed"]);
    assert.deepEqual(written[0].payload.by, { kind: "agent", session: "runner-1" });
});

// A really terminal-less process, which no driver can stand in for: the child
// runs with `stdio: ["ignore", "pipe", "pipe"]`, so fd 0 is not a keyboard and
// nothing in this file arranged that (#371, and the reason this cell spawns).
test("cell 3: a spawned child with no terminal at all records, and says an agent did", () =>
{
    const before = events().length;
    const recorded = spawnIn(box, demo, ["work", "add", "cell 3: recorded by a real child"]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.match(recorded.out, /\bw-[0-9a-z]{5}\b/);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.confirmed"]);
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
});

// The other half of cell 3, which a child cannot show: a process needs a pty
// to have a terminal on stdout alone, so this one is driven in-process. A
// screen is still not a keyboard, and the record says so.
test("cell 3b: a terminal on stdout alone is still nobody at the keyboard", async () =>
{
    const before = events().length;
    const recorded = await drive(box, demo, ["work", "add", "cell 3b: recorded with a screen and no keyboard"], { screen: true });
    assert.equal(recorded.code, 0, recorded.out);
    assert.deepEqual(since(before)[0].payload.by, { kind: "agent" });
});

test("cell 1b: a person whose output is piped is still a person", async () =>
{
    const before = events().length;
    const added = await mustPerson(box, demo, ["work", "add", "cell 1b: recorded with the output redirected"]);
    assert.match(added.out, /\bw-[0-9a-z]{5}\b/);
    assert.deepEqual(since(before)[0].payload.by, { kind: "person" });
});

test("cell 5: a person confirms an open plan in one command, with no prompt", async () =>
{
    const id = await proposal("cell 5: a plan a person confirmed");
    const before = events().length;
    const confirmed = await mustPerson(box, demo, ["work", "confirm", id]);
    assert.match(confirmed.out, new RegExp(id));
    assert.match((await must(box, demo, ["work"])).out, new RegExp(id));
    since(before).forEach((event) => assert.deepEqual(event.payload.by, { kind: "person" }, event.type));
});

test("cell 4: a session confirms the plan it proposed, and the record names the session", async () =>
{
    const id = await proposal("cell 4: a plan a session confirmed");
    const before = events().length;
    const confirmed = await selfIn(box, demo, ["work", "confirm", id], { SUPERSELF_SESSION: "sess-400" });
    assert.equal(confirmed.code, 0, confirmed.out);
    assert.match(confirmed.out, new RegExp(id));
    const written = since(before);
    assert.ok(written.length > 0, "the confirm appended nothing");
    written.forEach((event) => assert.deepEqual(event.payload.by, { kind: "agent", session: "sess-400" }, event.type));
});

test("cell 3c: a runner's child confirms a plan too — the marker names the writer, it does not refuse", async () =>
{
    const id = await proposal("cell 3c: a plan a runner's child confirmed");
    const before = events().length;
    const confirmed = await drive(box, demo, ["work", "confirm", id],
        { person: true, extra: { SUPERSELF_ATTEMPT_ID: "the runner's own attempt" } });
    assert.equal(confirmed.code, 0, confirmed.out);
    assert.deepEqual(since(before)[0].payload.by, { kind: "agent" });
});

test("cell 8: propose still records a proposal, and it too carries by", async () =>
{
    const before = events().length;
    const proposed = await must(box, demo, ["work", "propose", "cell 8: a plan a session proposed"]);
    assert.match(proposed.out, /\bw-[0-9a-z]{5}\b/);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.proposed"]);
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
});

test("cell 8b: decline records the withdrawal, and says who wrote it", async () =>
{
    const id = await proposal("cell 8b: a plan a session took back");
    const before = events().length;
    await must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.retracted"]);
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
});

test("cell 8c: revise is unchanged and ungated", async () =>
{
    const id = await proposal("cell 8c: a plan a session restated");
    await must(box, demo, ["work", "revise", id, "cell 8c: the plan as restated", "--why", "the first reading was wrong"]);
    assert.equal(events().at(-1).type, "entity.revised");
});

test("cell 6: a malformed add is refused for usage, and says nothing about a person", async () =>
{
    const refused = await selfIn(box, demo, ["work", "add"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /usage: self work add/);
    assert.ok(!refused.out.includes("is a person's call"), refused.out);
});

/* ── B: `work add --supersedes`, where the refusals used to be ─────── */

// The target of each correction cell, minted per cell so no case inherits
// another's state.
async function unit(outcome)
{
    return workIdIn((await mustPerson(box, demo, ["work", "add", outcome])).out);
}

test("cell 9b: a person corrects a started unit in one command, as before", async () =>
{
    const target = await unit("cell 9b: the outcome somebody picked up");
    await must(box, demo, ["work", "start", target]);
    const created = await approvedIn(box, demo, ["work", "add", "cell 9b: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"], target);
    assert.equal(created.code, 0, created.out);
    assert.deepEqual(created.printed.match(/entity\.\w+ recorded/g), ["entity.confirmed recorded", "entity.retired recorded"]);
    assert.match((await must(box, demo, ["work", "show", target])).out, /Status: retired/);
});

// This cell read "an agent's correction is refused with the propose spelling
// of it". The correction lands now, in one append, and both halves say who
// wrote it — which is the whole of what the refusal was protecting.
test("cell 9: a session's correction lands as one append, both halves carrying by", async () =>
{
    const target = await unit("cell 9: the outcome being replaced");
    const before = events().length;
    const recorded = await selfIn(box, demo, ["work", "add", "cell 9: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.ok(recorded.out.includes("cell 9: the outcome being replaced"), "the disclosure did not state what was retired");
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.confirmed", "entity.retired"]);
    written.forEach((event) => assert.deepEqual(event.payload.by, { kind: "agent" }, event.type));
    assert.match((await must(box, demo, ["work", "show", target])).out, /Status: retired/);
});

test("cell 10: a done target is refused for being done, and never for a person", async () =>
{
    const target = await unit("cell 10: the outcome that was reached");
    await must(box, demo, ["work", "start", target]);
    await must(box, demo, ["work", "done", target, "--report", "the outcome verifiably happened"]);
    const refused = await selfIn(box, demo, ["work", "add", "cell 10: a correction of a closed unit",
        "--supersedes", target, "--why", "the outcome moved"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is already done — retirement records an outcome that was given up/);
});

test("cell 11: a missing --why is refused for the missing --why", async () =>
{
    const target = await unit("cell 11: the outcome a correction forgot to explain");
    const refused = await selfIn(box, demo, ["work", "add", "cell 11: the corrected outcome", "--supersedes", target]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /--why/);
    assert.ok(!refused.out.includes("is a person's call"), refused.out);
});

/* ── D: `work confirm` × proposal state ────────────────────────────── */

test("cell 7: an already-confirmed plan is refused for that, and not for a person", async () =>
{
    const id = await proposal("cell 7: a plan confirmed once already");
    await mustPerson(box, demo, ["work", "confirm", id]);
    const refused = await selfIn(box, demo, ["work", "confirm", id]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is already accepted/);
    assert.ok(!refused.out.includes("is a person's call"), refused.out);
});

test("cell 7b: an unknown id is refused for the id", async () =>
{
    const refused = await selfIn(box, demo, ["work", "confirm", "w-zzzzz"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /w-zzzzz/);
    assert.ok(!refused.out.includes("is a person's call"), refused.out);
});

test("cell 4b: a caller outside every project confirms through the record", async () =>
{
    const id = await proposal("cell 4b: a plan confirmed from outside the checkout");
    const confirmed = await selfIn(box, box.root, ["work", "confirm", id]);
    assert.equal(confirmed.code, 0, confirmed.out);
    assert.match(confirmed.out, new RegExp(id));
});

test("cell 12: a session confirming a superseding plan writes both halves in one append", async () =>
{
    const target = await unit("cell 12: the outcome a plan proposes to replace");
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 12: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"])).out);
    const before = events().length;
    const confirmed = await selfIn(box, demo, ["work", "confirm", id]);
    assert.equal(confirmed.code, 0, confirmed.out);
    assert.ok(confirmed.out.includes("cell 12: the outcome a plan proposes to replace"),
        "the disclosure did not state what the confirm retired");
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.confirmed", "entity.retired"]);
    written.forEach((event) => assert.deepEqual(event.payload.by, { kind: "agent" }, event.type));
    assert.match((await must(box, demo, ["work", "show", target])).out, /Status: retired/);
});

test("cell 13: a target that went done since the propose refuses the confirm whole", async () =>
{
    const target = await unit("cell 13: the outcome that closed on its own");
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 13: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"])).out);
    await must(box, demo, ["work", "start", target]);
    await must(box, demo, ["work", "done", target, "--report", "it verifiably happened after all"]);
    const before = events().length;
    const refused = await selfIn(box, demo, ["work", "confirm", id]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is already done/);
    assert.equal(events().length, before, "a refused confirm still appended");
});

/* ── G: composition with a reviewed set and the sweep ──────────────── */

function plan(name, lines)
{
    const path = join(box.root, name);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
}

test("cell 21: a plan file's work add --supersedes lands in one append", async () =>
{
    const target = await unit("cell 21: the outcome a plan file replaces");
    const path = plan("cell21.txt", [`work add "cell 21: the corrected outcome" --supersedes ${target} --why "the outcome moved"`]);
    const applied = await approvedIn(box, demo, ["apply", path], target);
    assert.equal(applied.code, 0, applied.out);
    assert.match((await must(box, demo, ["work", "show", target])).out, /retired/);
});

// This cell read "the same file run by an agent is refused at the line". The
// file runs now, and the proof it keeps is that a session's plan is the same
// plan a person's is.
test("cell 21b: the same file run by a session records the same append", async () =>
{
    const target = await unit("cell 21b: the outcome a session's plan file replaces");
    const path = plan("cell21b.txt", [`work add "cell 21b: the corrected outcome" --supersedes ${target} --why "the outcome moved"`]);
    const before = events().length;
    const applied = await selfIn(box, demo, ["apply", path]);
    assert.equal(applied.code, 0, applied.out);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.confirmed", "entity.retired"]);
    written.forEach((event) => assert.deepEqual(event.payload.by, { kind: "agent" }, event.type));
});

test("cell 21c: a plan file confirms a superseding proposal inside the one append", async () =>
{
    const target = await unit("cell 21c: the outcome a plan file retires by confirming");
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 21c: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"])).out);
    const path = plan("cell21c.txt", [`work confirm ${id}`]);
    const applied = await approvedIn(box, demo, ["apply", path], target);
    assert.equal(applied.code, 0, applied.out);
    assert.match((await must(box, demo, ["work", "show", target])).out, /retired/);
});

test("cell 23: a plan file confirming a plan that destroys nothing is refused as an idle line", async () =>
{
    const id = await proposal("cell 23: a plan that replaces nothing");
    const path = plan("cell23.txt", [`work confirm ${id}`]);
    const refused = await approvedIn(box, demo, ["apply", path], id);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /one append covers only the calls that/);
});

test("cell 23b: a plan file with a bare work add is refused as an idle line", async () =>
{
    const path = plan("cell23b.txt", ['work add "cell 23b: a unit recorded inside a reviewed set"']);
    const refused = await approvedIn(box, demo, ["apply", path], "");
    assert.equal(refused.code, 1);
    assert.match(refused.out, /one append covers only the calls that/);
});

test("cell 8d: a session's sweep still records its proposals", async () =>
{
    const said = "the gate needed a keyboard the sweep does not have";
    for (const index of [1, 2, 3])
    {
        const seeded = await unit(`cell 8d: the outcome behind report ${index}`);
        await must(box, demo, ["report", seeded, `cell 8d: report ${index}`, "--friction", said]);
    }
    const recorded = await selfIn(box, demo, ["sweep", "--record"]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.equal(events().at(-1).type, "entity.proposed");
});

/* ── J: the rename (addendum) ──────────────────────────────────────── */

test("cell 52: `work accept` still dispatches, and records the identical event", async () =>
{
    const viaAccept = await proposal("cell 52: a plan answered by the old spelling");
    const before = events().length;
    const accepted = await selfIn(box, demo, ["work", "accept", viaAccept]);
    assert.equal(accepted.code, 0, accepted.out);
    const oldSpelling = since(before);

    const viaConfirm = await proposal("cell 52: a plan answered by the new spelling");
    const next = events().length;
    assert.equal((await selfIn(box, demo, ["work", "confirm", viaConfirm])).code, 0);
    const newSpelling = since(next);

    assert.deepEqual(oldSpelling.map((event) => event.type), newSpelling.map((event) => event.type));
    assert.deepEqual(oldSpelling.map((event) => event.payload.by), newSpelling.map((event) => event.payload.by));
    assert.deepEqual(oldSpelling[0].payload.entity, viaAccept);
});

/* ── I: what a reader is told ──────────────────────────────────────── */

test("cell 53: the work usage states confirm|decline, and never advertises accept", async () =>
{
    const page = (await must(box, demo, ["work", "--help"])).out;
    assert.match(page, /work confirm\|decline <proposal-id>/);
    assert.ok(!page.includes("work accept"), page);
    assert.match(page, /work propose "<plan>" \[--supersedes <work-id> --why w\]/);
    assert.match(page, /work add "<required outcome>" \[--supersedes <work-id> --why w\]/);
});

test("cell 54: the unknown-verb refusal lists confirm, not accept", async () =>
{
    const refused = await selfIn(box, demo, ["work", "bogus"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /propose\|revise\|confirm\|decline/);
});

test("cell 48: the work detail no longer claims a person's terminal for either verb", async () =>
{
    const page = (await must(box, demo, ["help", "work"])).out;
    assert.ok(!page.includes("a person's own command"), page);
    assert.ok(!page.includes("no person at its keyboard"), page);
    assert.match(page, /`work add` is the confirmed-at-once form/);
    assert.match(page, /`self undo` takes straight back/);
});

test("cell 49: the session-facing guide says a session records its own decisions, and undo is the way back", async () =>
{
    const agents = (await must(box, demo, ["help", "agents"])).out;
    assert.match(agents, /self work propose "<plan>"/);
    assert.match(agents, /`self undo` takes either back/);
    assert.ok(!/refused where no person is at the terminal/.test(agents), agents);
    // The same page states what proposing means now that it no longer means
    // "I am an agent" — `help work` renders the command page and this guide.
    const work = (await must(box, demo, ["help", "work"])).out;
    assert.match(work, /not "I am an/);
    assert.match(work, /self work confirm <id>/);
});

// The floor the file stands on: a scratch machine, not the real workspace.
test("the suite's own environment carries no attempt marker into these cells", () =>
{
    assert.equal(box.env.SUPERSELF_SESSION, undefined);
    assert.equal(box.env.SUPERSELF_ATTEMPT_ID, undefined);
    mkdirSync(join(box.root, "unused"), { recursive: true });
});
