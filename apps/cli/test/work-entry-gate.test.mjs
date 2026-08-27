// The person gate on the two verbs that write a confirmed work record (#389):
// `work add` and `work accept`. Every test below is one cell of
// docs/maintainers/case-tables/389-propose-first-gating.md, named by its
// number, and asserts that cell's stated outcome.
//
// Cells 1-12 are the gate itself, 20-22 the correction spelling `work add`
// already had, 38-41 acceptance, 48 an agent accepting a superseding plan,
// 56-61 what a reviewed set does with these verbs, and 70-72 what the help
// says. The rest of the table lives in work-propose-supersedes.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    approvedIn,
    demoWorkspace,
    drive,
    machine,
    must,
    mustPerson,
    personIn,
    selfIn,
    spawnIn,
    workIdIn
} from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

// The whole log, so a cell can state that nothing was appended. Length is the
// assertion that matters: a refused write is a write that never happened.
function events(project = "demo")
{
    const file = join(ws, ".superself", "projects", project, "log.jsonl");
    return readFileSync(file, "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

async function proposal(outcome)
{
    return workIdIn((await must(box, demo, ["work", "propose", outcome])).out);
}

/* ── A: the gate itself — invoker × verb ───────────────────────────── */

test("cell 1: a person at a terminal records a confirmed unit in one command", async () =>
{
    const added = await mustPerson(box, demo, ["work", "add", "cell 1: the unit a person recorded"]);
    const id = workIdIn(added.out);
    assert.match((await must(box, demo, ["work", "show", id])).out, /cell 1: the unit a person recorded/);
    assert.equal(events().filter((event) => event.payload.entity === id && event.type === "entity.confirmed").length, 1);
});

test("cell 2: an attempt marker refuses the write even with a keyboard behind it", async () =>
{
    const before = events().length;
    const refused = await drive(box, demo, ["work", "add", "cell 2: recorded by a runner's child"],
        { person: true, extra: { SUPERSELF_ATTEMPT_ID: "the runner's own attempt" } });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /recording confirmed work is a person's call/);
    assert.equal(events().length, before, "a refused add still appended");
});

// A really terminal-less process, which no driver can stand in for: the child
// runs with `stdio: ["ignore", "pipe", "pipe"]`, so fd 0 is not a keyboard and
// nothing in this file arranged that (#371, and the reason this cell spawns).
test("cell 3: a spawned child with no terminal at all is refused, and told what to run", () =>
{
    const before = events().length;
    const refused = spawnIn(box, demo, ["work", "add", "cell 3: recorded by a real child"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /recording confirmed work is a person's call/);
    assert.match(refused.out, /self work propose "cell 3: recorded by a real child"/);
    assert.equal(events().length, before, "a refused add still appended");
});

// The other half of cell 3, which a child cannot show: a process needs a pty
// to have a terminal on stdout alone, so this one is driven in-process.
test("cell 4: a terminal on stdout alone is still nobody at the keyboard", async () =>
{
    const refused = await drive(box, demo, ["work", "add", "cell 4: recorded with a screen and no keyboard"], { screen: true });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /recording confirmed work is a person's call/);
});

test("cell 5: a person whose output is piped is still a person", async () =>
{
    const added = await mustPerson(box, demo, ["work", "add", "cell 5: recorded with the output redirected"]);
    assert.match(added.out, /\bw-[0-9a-z]{5}\b/);
});

test("cell 6: a person accepts an open plan in one command, with no prompt", async () =>
{
    const id = await proposal("cell 6: a plan a person accepted");
    const accepted = await mustPerson(box, demo, ["work", "accept", id]);
    assert.match(accepted.out, new RegExp(id));
    assert.match((await must(box, demo, ["work"])).out, new RegExp(id));
});

test("cell 7: an attempt marker refuses the acceptance", async () =>
{
    const id = await proposal("cell 7: a plan a runner's child tried to accept");
    const before = events().length;
    const refused = await drive(box, demo, ["work", "accept", id],
        { person: true, extra: { SUPERSELF_ATTEMPT_ID: "the runner's own attempt" } });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /accepting a plan is a person's call/);
    assert.equal(events().length, before, "a refused acceptance still appended");
});

test("cell 8: no terminal refuses the acceptance, and the refusal names the owning project", async () =>
{
    const id = await proposal("cell 8: a plan an agent tried to accept");
    const before = events().length;
    const refused = await selfIn(box, demo, ["work", "accept", id]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /accepting a plan is a person's call/);
    assert.match(refused.out, /cell 8: a plan an agent tried to accept/);
    assert.match(refused.out, new RegExp(`${id} is demo's plan`));
    assert.match(refused.out, new RegExp(`self work accept ${id}`));
    assert.equal(events().length, before, "a refused acceptance still appended");
});

test("cell 9: propose is ungated", async () =>
{
    const proposed = await must(box, demo, ["work", "propose", "cell 9: a plan an agent proposed"]);
    assert.equal(events().at(-1).type, "entity.proposed");
    assert.match(proposed.out, /\bw-[0-9a-z]{5}\b/);
});

test("cell 10: decline is ungated", async () =>
{
    const id = await proposal("cell 10: a plan an agent took back");
    await must(box, demo, ["work", "decline", id, "--why", "its premises were removed"]);
    assert.equal(events().at(-1).type, "entity.retracted");
});

test("cell 11: revise is ungated", async () =>
{
    const id = await proposal("cell 11: a plan an agent restated");
    await must(box, demo, ["work", "revise", id, "cell 11: the plan as restated", "--why", "the first reading was wrong"]);
    assert.equal(events().at(-1).type, "entity.revised");
});

test("cell 12: a malformed add is refused as malformed, not for the person gate", async () =>
{
    const refused = await selfIn(box, demo, ["work", "add"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /usage: self work add/);
    assert.ok(!refused.out.includes("is a person's call"), refused.out);
});

/* ── B: `work add --supersedes`, where the refusals already were ───── */

// The target of each correction cell, minted per cell so no case inherits
// another's terminal state.
async function unit(outcome)
{
    return workIdIn((await mustPerson(box, demo, ["work", "add", outcome])).out);
}

test("cell 14: a person corrects a started unit in one command, as before", async () =>
{
    const target = await unit("cell 14: the outcome somebody picked up");
    await must(box, demo, ["work", "start", target]);
    const created = await approvedIn(box, demo, ["work", "add", "cell 14: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"], target);
    assert.equal(created.code, 0, created.out);
    assert.deepEqual(created.printed.match(/entity\.\w+ recorded/g), ["entity.confirmed recorded", "entity.retired recorded"]);
    assert.match((await must(box, demo, ["work", "show", target])).out, /Status: retired/);
});

test("cell 20: an agent's correction is refused with the propose spelling of it", async () =>
{
    const target = await unit("cell 20: the outcome being replaced");
    const before = events().length;
    const refused = await selfIn(box, demo, ["work", "add", "cell 20: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /recording confirmed work is a person's call/);
    assert.match(refused.out, new RegExp(`replaces ${target}  cell 20: the outcome being replaced`));
    assert.match(refused.out,
        new RegExp(`self work propose "cell 20: the corrected outcome" --supersedes ${target} --why "the outcome moved"`));
    assert.equal(events().length, before, "the retirement gate ran, or something was appended");
});

test("cell 21: a done target is refused for being done, before the person gate", async () =>
{
    const target = await unit("cell 21: the outcome that was reached");
    await must(box, demo, ["work", "start", target]);
    await must(box, demo, ["work", "done", target, "--report", "the outcome verifiably happened"]);
    const refused = await selfIn(box, demo, ["work", "add", "cell 21: a correction of a closed unit",
        "--supersedes", target, "--why", "the outcome moved"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is already done — retirement records an outcome that was given up/);
});

test("cell 22: a missing --why is refused for the missing --why, before the person gate", async () =>
{
    const target = await unit("cell 22: the outcome a correction forgot to explain");
    const refused = await selfIn(box, demo, ["work", "add", "cell 22: the corrected outcome", "--supersedes", target]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /--why/);
    assert.ok(!refused.out.includes("is a person's call"), refused.out);
});

/* ── D: `work accept` × proposal state ─────────────────────────────── */

test("cell 38: an agent accepting an open plan is refused and nothing is appended", async () =>
{
    const id = await proposal("cell 38: a plan an agent wanted to approve itself");
    const before = events().length;
    assert.equal((await selfIn(box, demo, ["work", "accept", id])).code, 1);
    assert.equal(events().length, before);
    assert.match((await must(box, demo, ["work", "show", id])).out, /review/);
});

test("cell 39: an already-accepted plan is refused for that, not for the person gate", async () =>
{
    const id = await proposal("cell 39: a plan accepted once already");
    await mustPerson(box, demo, ["work", "accept", id]);
    const refused = await selfIn(box, demo, ["work", "accept", id]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is already accepted/);
    assert.ok(!refused.out.includes("is a person's call"), refused.out);
});

test("cell 40: an unknown id is refused for the id, not for the person gate", async () =>
{
    const refused = await selfIn(box, demo, ["work", "accept", "w-zzzzz"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /w-zzzzz/);
    assert.ok(!refused.out.includes("is a person's call"), refused.out);
});

test("cell 41: a person outside every project accepts through the record", async () =>
{
    const id = await proposal("cell 41: a plan accepted from outside the checkout");
    const accepted = await mustPerson(box, box.root, ["work", "accept", id]);
    assert.match(accepted.out, new RegExp(id));
});

test("cell 48: an agent accepting a superseding plan is refused before the retirement gate", async () =>
{
    const target = await unit("cell 48: the outcome a plan proposes to replace");
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 48: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"])).out);
    const before = events().length;
    const refused = await selfIn(box, demo, ["work", "accept", id]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /accepting a plan is a person's call/);
    assert.equal(events().length, before, "the retirement gate ran, or something was appended");
    assert.match((await must(box, demo, ["work", "show", target])).out, /cell 48: the outcome a plan proposes to replace/);
});

/* ── G: composition with a reviewed set and the sweep ──────────────── */

function plan(name, lines)
{
    const path = join(box.root, name);
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
}

test("cell 56: a person's plan file still runs work add --supersedes under one confirmation", async () =>
{
    const target = await unit("cell 56: the outcome a plan file replaces");
    const path = plan("cell56.txt", [`work add "cell 56: the corrected outcome" --supersedes ${target} --why "the outcome moved"`]);
    const applied = await approvedIn(box, demo, ["apply", path], target);
    assert.equal(applied.code, 0, applied.out);
    assert.match((await must(box, demo, ["work", "show", target])).out, /retired/);
});

test("cell 57: the same file run by an agent is refused at the line, and nothing is recorded", async () =>
{
    const target = await unit("cell 57: the outcome an agent's plan file wanted to replace");
    const path = plan("cell57.txt", [`work add "cell 57: the corrected outcome" --supersedes ${target} --why "the outcome moved"`]);
    const before = events().length;
    const refused = await selfIn(box, demo, ["apply", path]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /line 1 was refused, and nothing in this file was recorded/);
    assert.match(refused.out, /recording confirmed work is a person's call/);
    assert.equal(events().length, before);
});

test("cell 58: a plan file accepts a superseding proposal under the one confirmation", async () =>
{
    const target = await unit("cell 58: the outcome a plan file retires by accepting");
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 58: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"])).out);
    const path = plan("cell58.txt", [`work accept ${id}`]);
    const applied = await approvedIn(box, demo, ["apply", path], target);
    assert.equal(applied.code, 0, applied.out);
    assert.match((await must(box, demo, ["work", "show", target])).out, /retired/);
});

test("cell 59: a plan file accepting a plan that destroys nothing is refused as an idle line", async () =>
{
    const id = await proposal("cell 59: a plan that replaces nothing");
    const path = plan("cell59.txt", [`work accept ${id}`]);
    const refused = await approvedIn(box, demo, ["apply", path], id);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /one confirmation covers only the calls that/);
});

test("cell 60: a plan file with a bare work add is refused as an idle line", async () =>
{
    const path = plan("cell60.txt", ['work add "cell 60: a unit recorded inside a reviewed set"']);
    const refused = await approvedIn(box, demo, ["apply", path], "");
    assert.equal(refused.code, 1);
    assert.match(refused.out, /one confirmation covers only the calls that/);
});

test("cell 61: an agent's sweep still records its proposals", async () =>
{
    const said = "the gate needed a keyboard the sweep does not have";
    for (const index of [1, 2, 3])
    {
        const seeded = await unit(`cell 61: the outcome behind report ${index}`);
        await must(box, demo, ["report", seeded, `cell 61: report ${index}`, "--friction", said]);
    }
    const recorded = await selfIn(box, demo, ["sweep", "--record"]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.equal(events().at(-1).type, "entity.proposed");
});

/* ── I: what a reader is told ──────────────────────────────────────── */

test("cell 70: the work usage states the propose spelling of a correction", async () =>
{
    const page = (await must(box, demo, ["work", "--help"])).out;
    assert.match(page, /work propose "<plan>" \[--supersedes <work-id> --why w\]/);
    assert.match(page, /work add "<required outcome>" \[--supersedes <work-id> --why w\]/);
    assert.match(page, /on `work propose`, the retirement waits for the acceptance/);
});

test("cell 71: the work detail states who records a confirmed unit", async () =>
{
    const page = (await must(box, demo, ["help", "work"])).out;
    assert.match(page, /a person's own commands/);
    assert.match(page, /handed the `work propose` line to run instead/);
});

test("cell 72: the session-facing guide no longer opens with work add", async () =>
{
    const page = (await must(box, demo, ["help", "agents"])).out;
    assert.match(page, /self work propose "<plan>"/);
    assert.ok(!/self work add "<required outcome>"/.test(page), page);
    const work = (await must(box, demo, ["help", "work"])).out;
    assert.match(work, /self work propose "<corrected plan>" --supersedes <id> --why w/);
});

// The floor the file stands on: a scratch machine, not the real workspace.
test("the suite's own environment carries no attempt marker into these cells", () =>
{
    assert.equal(box.env.SUPERSELF_SESSION, undefined);
    assert.equal(box.env.SUPERSELF_ATTEMPT_ID, undefined);
    mkdirSync(join(box.root, "unused"), { recursive: true });
});
