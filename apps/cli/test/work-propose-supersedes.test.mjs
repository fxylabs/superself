// `work propose --supersedes <id> --why w` (#389): a correction an agent can
// record, which retires the unit it replaces only when a person accepts it.
// Every test below is one cell of
// docs/maintainers/case-tables/389-propose-first-gating.md, named by its
// number.
//
// Cells 23-32 are propose time, 42-50 acceptance and the drift a target can
// have gone through in between, 51-55 the verbs that confirm nothing, 62-67
// the fold, and 68-69, 73 what a reader sees. The gate itself is asserted in
// work-entry-gate.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../dist/ids.js";
import { approvedIn, demoWorkspace, git, idIn, logFixture, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

const BRIEF = ["--value", "the gap closes", "--success", "the proof passes", "--stop", "the gap moves",
    "--risk", "the plan is wrong", "--capacity", "one stage", "--evidence-plan", "the suite",
    "--confidence", "medium", "--expires", "2099-01-01"];

function events(project = "demo")
{
    const file = join(ws, ".superself", "projects", project, "log.jsonl");
    return readFileSync(file, "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

function creationOf(id)
{
    return events().find((event) => event.type === "entity.proposed" && event.payload.entity === id);
}

function retirementOf(id)
{
    return events().filter((event) => event.type === "entity.retired" && event.payload.entity === id).pop();
}

// A confirmed unit, recorded the way a person records one.
async function unit(outcome)
{
    return workIdIn((await mustPerson(box, demo, ["work", "add", outcome])).out);
}

async function correction(outcome, target, why = "the outcome moved to the new unit")
{
    return workIdIn((await must(box, demo, ["work", "propose", outcome, "--supersedes", target, "--why", why])).out);
}

/* ── C: what `work propose --supersedes` resolves ──────────────────── */

test("cell 23: an open target is carried on the creation event and left untouched", async () =>
{
    const target = await unit("cell 23: the outcome being replaced");
    const id = await correction("cell 23: the corrected outcome", target);
    assert.deepEqual(creationOf(id).payload.supersedes,
        { entity: target, why: "the outcome moved to the new unit" });
    assert.equal(retirementOf(target), undefined, "the target was retired at propose time");
    assert.match((await must(box, demo, ["work"])).out, new RegExp(target));
    assert.match((await must(box, demo, ["work", "show", target])).out, /cell 23: the outcome being replaced/);
});

test("cell 24: a started target is a target — this is the case the correction exists for", async () =>
{
    const target = await unit("cell 24: the outcome somebody started");
    await must(box, demo, ["work", "start", target]);
    const id = await correction("cell 24: the corrected outcome", target);
    assert.equal(creationOf(id).payload.supersedes.entity, target);
    assert.equal(retirementOf(target), undefined);
});

test("cell 25: a done target is refused", async () =>
{
    const target = await unit("cell 25: the outcome that was reached");
    await must(box, demo, ["work", "start", target]);
    await must(box, demo, ["work", "done", target, "--report", "the outcome verifiably happened"]);
    const refused = await selfIn(box, demo, ["work", "propose", "cell 25: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is already done — retirement records an outcome that was given up/);
});

test("cell 26: a retired target is refused with its own reason", async () =>
{
    const target = await unit("cell 26: the outcome that was given up");
    await approvedIn(box, demo, ["work", "retire", target, "--why", "it moved to another project"], target);
    const refused = await selfIn(box, demo, ["work", "propose", "cell 26: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is already retired — it moved to another project/);
});

test("cell 27: --supersedes without --why is refused, naming both flags", async () =>
{
    const target = await unit("cell 27: the outcome a correction forgot to explain");
    const refused = await selfIn(box, demo, ["work", "propose", "cell 27: the corrected outcome", "--supersedes", target]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`--supersedes ${target} --why`));
});

test("cell 28: --why without --supersedes is refused, naming --supersedes", async () =>
{
    const refused = await selfIn(box, demo, ["work", "propose", "cell 28: a plan with a spare reason",
        "--why", "a reason for nothing"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /pass --supersedes <work-id> too/);
});

test("cell 29: a decision id is refused by kind", async () =>
{
    const decision = idIn((await must(box, demo, ["decide", "cell 29: a ruling that is not a unit"])).out);
    const refused = await selfIn(box, demo, ["work", "propose", "cell 29: the corrected outcome",
        "--supersedes", decision, "--why", "the outcome moved"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is a decision record — replace it with/);
});

// The design left this allowed and the maintainer ruled it refused: a plan
// nobody accepted is corrected by restating it under its own id (#356), and
// superseding it would mint a second id for a plan never approved.
test("cell 30: a target that is itself a plan awaiting review is refused, naming work revise", async () =>
{
    const plan = workIdIn((await must(box, demo, ["work", "propose", "cell 30: a plan awaiting review"])).out);
    const refused = await selfIn(box, demo, ["work", "propose", "cell 30: the corrected plan",
        "--supersedes", plan, "--why", "the plan moved"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is a plan still awaiting review — restate it instead/);
    assert.match(refused.out, new RegExp(`self work revise ${plan}`));
});

test("cell 31: a correction whose text repeats an open plan is refused as a duplicate", async () =>
{
    const target = await unit("cell 31: the outcome being replaced");
    const text = "cell 31: a plan proposed twice";
    await must(box, demo, ["work", "propose", text]);
    const refused = await selfIn(box, demo, ["work", "propose", text, "--supersedes", target, "--why", "the outcome moved"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /already proposes this plan/);
});

test("cell 32: --supersedes composes with a gap brief and is not a brief flag", async () =>
{
    const objective = (await must(box, demo, ["objective", "add", "cell 32: an outcome with a gap"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const target = await unit("cell 32: the outcome being replaced");
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 32: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved", "--objective", objective, ...BRIEF])).out);
    const payload = creationOf(id).payload;
    assert.equal(payload.supersedes.entity, target);
    assert.equal(payload.objective, objective);
    assert.equal(payload.confidence, "medium");
});

// Surfaced by the implementation, not by the design: a correction is recorded
// in the log that holds the unit, and calling another project's id unknown
// sends the reader looking for a typo instead of a checkout.
test("cell 75: a target another registered project owns is refused by naming that project", async () =>
{
    const second = join(ws, "second");
    mkdirSync(second, { recursive: true });
    git(box, second, ["init", "-q", "-b", "main"]);
    await must(box, second, ["project", "init", "--name", "second", "--desc", "the other checkout", "--no-connect"]);
    const target = await unit("cell 75: the outcome demo owns");
    const refused = await selfIn(box, second, ["work", "propose", "cell 75: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`${target} is demo's unit`));
    assert.match(refused.out, /run this in demo's checkout/);
});

test("cell 73: the receipt says the target is untouched until a person accepts", async () =>
{
    const target = await unit("cell 73: the outcome a receipt names");
    const proposed = await must(box, demo, ["work", "propose", "cell 73: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved"]);
    const id = workIdIn(proposed.out);
    assert.match(proposed.out, new RegExp(`replaces ${target} on acceptance`));
    assert.match(proposed.out, new RegExp(`self work accept ${id}`));
});

/* ── E: acceptance, and the drift a target can have gone through ───── */

test("cell 42: a person's acceptance records the confirm and the retirement in one append", async () =>
{
    const target = await unit("cell 42: the outcome being replaced");
    const id = await correction("cell 42: the corrected outcome", target);
    const before = events().length;
    const accepted = await approvedIn(box, demo, ["work", "accept", id], target);
    assert.equal(accepted.code, 0, accepted.out);
    assert.match(accepted.out, new RegExp(id));
    const written = events().slice(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.confirmed", "entity.retired"]);
    const retired = written[1];
    assert.deepEqual(
        { ...retired.payload, confirmation: retired.payload.confirmation.method },
        {
            entity: target,
            why: "the outcome moved to the new unit",
            successor: id,
            successorProject: "demo",
            confirmation: "tty"
        });
    // The gate's passing is provable from the log: the acceptance carries what
    // was typed, not only a bit any process can set.
    assert.equal(written[0].payload.confirmation.challenge, target);
    assert.equal(written[0].refs.confirms, id);
});

test("cell 43: a wrong challenge writes neither half, and the plan stays open", async () =>
{
    const target = await unit("cell 43: the outcome a mistyped answer left alone");
    const id = await correction("cell 43: the corrected outcome", target);
    const before = events().length;
    const refused = await approvedIn(box, demo, ["work", "accept", id], "not the challenge");
    assert.equal(refused.code, 1);
    assert.equal(events().length, before, "a refused acceptance still appended");
    assert.match((await must(box, demo, ["work", "show", id])).out, /review/);
});

test("cell 44: a target started since the proposal still retires", async () =>
{
    const target = await unit("cell 44: the outcome somebody picked up");
    const id = await correction("cell 44: the corrected outcome", target);
    await must(box, demo, ["work", "start", target]);
    const accepted = await approvedIn(box, demo, ["work", "accept", id], target);
    assert.equal(accepted.code, 0, accepted.out);
    assert.equal(retirementOf(target).payload.successor, id);
});

test("cell 45: a target that went done refuses the acceptance and records nothing", async () =>
{
    const target = await unit("cell 45: the outcome that closed on its own");
    const id = await correction("cell 45: the corrected outcome", target);
    await must(box, demo, ["work", "start", target]);
    await must(box, demo, ["work", "done", target, "--report", "the outcome verifiably happened"]);
    const before = events().length;
    const refused = await approvedIn(box, demo, ["work", "accept", id], target);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`${id} proposes to replace ${target}, and ${target} is already done`));
    assert.match(refused.out, new RegExp(`self work revise ${id}`));
    assert.match(refused.out, new RegExp(`self work decline ${id}`));
    assert.equal(events().length, before);
    assert.match((await must(box, demo, ["work", "show", id])).out, /review/);
});

test("cell 46: a target retired in the meantime refuses, naming its own reason", async () =>
{
    const target = await unit("cell 46: the outcome given up by somebody else");
    const id = await correction("cell 46: the corrected outcome", target);
    await approvedIn(box, demo, ["work", "retire", target, "--why", "it was dropped from the release"], target);
    const before = events().length;
    const refused = await approvedIn(box, demo, ["work", "accept", id], target);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is already retired — it was dropped from the release/);
    assert.equal(events().length, before);
});

test("cell 47: a carried target this store never saw refuses the acceptance", async () =>
{
    const id = proposalFixture("cell 47: a plan naming a unit nothing answers to", { entity: "w-zzzzz", why: "the outcome moved" });
    const before = events().length;
    const refused = await approvedIn(box, demo, ["work", "accept", id], "w-zzzzz");
    assert.equal(refused.code, 1);
    assert.match(refused.out, /no record here answers to w-zzzzz/);
    assert.equal(events().length, before);
});

test("cell 49: a revision leaves the carried supersession alone", async () =>
{
    const target = await unit("cell 49: the outcome a revised plan replaces");
    const id = await correction("cell 49: the corrected outcome", target);
    await must(box, demo, ["work", "revise", id, "cell 49: the corrected outcome, restated", "--why", "the wording was wrong"]);
    assert.equal(creationOf(id).payload.supersedes.entity, target);
    const accepted = await approvedIn(box, demo, ["work", "accept", id], target);
    assert.equal(accepted.code, 0, accepted.out);
    assert.equal(retirementOf(target).payload.successor, id);
});

test("cell 50: a supersession and a gap target land as three events in one append", async () =>
{
    const objective = (await must(box, demo, ["objective", "add", "cell 50: an outcome with a gap"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const target = await unit("cell 50: the outcome being replaced");
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 50: the corrected outcome",
        "--supersedes", target, "--why", "the outcome moved", "--objective", objective, ...BRIEF])).out);
    const before = events().length;
    const accepted = await approvedIn(box, demo, ["work", "accept", id], target);
    assert.equal(accepted.code, 0, accepted.out);
    assert.deepEqual(events().slice(before).map((event) => event.type),
        ["entity.confirmed", "entity.linked", "entity.retired"]);
});

/* ── F: the verbs that confirm nothing ─────────────────────────────── */

test("cell 51: declining a correction retracts the plan and leaves the target open", async () =>
{
    const target = await unit("cell 51: the outcome a declined correction named");
    const id = await correction("cell 51: the corrected outcome", target);
    const before = events().length;
    await must(box, demo, ["work", "decline", id, "--why", "the correction was wrong"]);
    assert.deepEqual(events().slice(before).map((event) => event.type), ["entity.retracted"]);
    assert.equal(retirementOf(target), undefined);
    assert.match((await must(box, demo, ["work", "show", target])).out, /cell 51: the outcome a declined correction named/);
});

test("cell 52: revising a correction records one revision and nothing else", async () =>
{
    const target = await unit("cell 52: the outcome a revised correction names");
    const id = await correction("cell 52: the corrected outcome", target);
    const before = events().length;
    await must(box, demo, ["work", "revise", id, "cell 52: the corrected outcome, again", "--why", "the wording moved"]);
    assert.deepEqual(events().slice(before).map((event) => event.type), ["entity.revised"]);
    assert.match((await must(box, demo, ["work", "show", id])).out, /review/);
});

test("cell 53: a declined correction left no trace on the unit it named", async () =>
{
    const target = await unit("cell 53: the outcome a declined correction left alone");
    const before = (await must(box, demo, ["work", "show", target])).out;
    const id = await correction("cell 53: the corrected outcome", target);
    await must(box, demo, ["work", "decline", id, "--why", "the correction was wrong"]);
    assert.equal((await must(box, demo, ["work", "show", target])).out, before);
});

// #356's refusal, asserted unchanged: rewriting it is #390's, not this issue's.
test("cell 54: revise on a work add unit still names the work add spelling", async () =>
{
    const target = await unit("cell 54: an outcome recorded by a person");
    const refused = await selfIn(box, demo, ["work", "revise", target, "cell 54: a restatement", "--why", "the plan changed"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /was recorded with `work add`, which is the already-approved path/);
    assert.match(refused.out, new RegExp(`self work add "<outcome>" --supersedes ${target} --why w`));
});

test("cell 55: declining never reads the target, even one somebody else retired", async () =>
{
    const target = await unit("cell 55: the outcome retired under a live correction");
    const id = await correction("cell 55: the corrected outcome", target);
    await approvedIn(box, demo, ["work", "retire", target, "--why", "it was dropped"], target);
    const declined = await must(box, demo, ["work", "decline", id, "--why", "the correction has nothing left to do"]);
    assert.equal(declined.code, 0);
});

/* ── H: the fold ───────────────────────────────────────────────────── */

// A proposal written straight into the log, so a payload shape the CLI would
// never write can still be folded and answered — nothing read out of the log
// is trusted to be its declared shape.
function proposalFixture(text, supersedes)
{
    const id = `w-${ulid().slice(-5).toLowerCase()}`;
    logFixture(ws, "demo", {
        id: ulid(),
        ts: new Date().toISOString(),
        type: "entity.proposed",
        origin: { actor: "agent", confirmed: false },
        project: "demo",
        payload: { entity: id, text, labels: ["work"], links: [], criteria: [], exposure: "index", scope: "project", supersedes }
    });
    return id;
}

test("cell 62: a carried supersession displaces nothing until it is accepted", async () =>
{
    const target = await unit("cell 62: the outcome a folded proposal names");
    await correction("cell 62: the corrected outcome", target);
    const shown = (await must(box, demo, ["work", "show", target])).out;
    assert.ok(!/retired/.test(shown), shown);
    assert.ok(!/superseded/.test(shown), shown);
});

test("cell 63: a second retirement of the same target does not displace the first", async () =>
{
    const target = await unit("cell 63: the outcome two clones both closed");
    const id = await correction("cell 63: the corrected outcome", target);
    await approvedIn(box, demo, ["work", "accept", id], target);
    logFixture(ws, "demo", {
        id: ulid(),
        ts: new Date(Date.now() + 60_000).toISOString(),
        type: "entity.retired",
        origin: { actor: "agent", confirmed: true },
        project: "demo",
        payload: { entity: target, why: "the other clone gave it up too" }
    });
    const shown = (await must(box, demo, ["work", "show", target])).out;
    assert.match(shown, /the outcome moved to the new unit/);
    assert.ok(!/the other clone gave it up too/.test(shown), shown);
});

test("cell 64: a supersedes that is not an object reads as absent", async () =>
{
    for (const shape of ["a string", 7, {}, { entity: "" }])
    {
        const id = proposalFixture(`cell 64: a plan carrying ${JSON.stringify(shape)}`, shape);
        const accepted = await mustPerson(box, demo, ["work", "accept", id]);
        assert.match(accepted.out, new RegExp(id));
        assert.equal(events().filter((event) => event.type === "entity.retired"
            && event.payload.successor === id).length, 0);
    }
});

test("cell 65: a carried target this store never saw leaves the fold alone", async () =>
{
    const id = proposalFixture("cell 65: a plan naming a unit from another store", { entity: "w-yyyyy", why: "the outcome moved" });
    assert.match((await must(box, demo, ["work"])).out, new RegExp(id));
    assert.match((await must(box, demo, ["work", "show", id])).out, /cell 65: a plan naming a unit from another store/);
});

test("cell 66: the same retirement merged in twice folds once", async () =>
{
    const target = await unit("cell 66: the outcome a duplicated event names");
    const id = await correction("cell 66: the corrected outcome", target);
    await approvedIn(box, demo, ["work", "accept", id], target);
    const written = retirementOf(target);
    logFixture(ws, "demo", { ...written, id: ulid() });
    const shown = (await must(box, demo, ["work", "show", target])).out;
    assert.match(shown, /retired/);
    assert.match(shown, new RegExp(id));
});

test("cell 67: the pair reads back the way work add --supersedes reads", async () =>
{
    const target = await unit("cell 67: the outcome the history names");
    const id = await correction("cell 67: the corrected outcome", target);
    await approvedIn(box, demo, ["work", "accept", id], target);
    const history = (await must(box, demo, ["work", "show", id, "--history"])).out;
    assert.match(history, /entity\.proposed/);
    assert.match(history, /entity\.confirmed/);
    const old = (await must(box, demo, ["work", "show", target])).out;
    assert.match(old, /retired/);
    assert.match(old, new RegExp(id));
});

/* ── I: what a reader sees ─────────────────────────────────────────── */

test("cell 68: an open correction is one row a person is waiting on", async () =>
{
    const target = await unit("cell 68: the outcome a waiting row names");
    const id = await correction("cell 68: the corrected outcome", target);
    const context = (await must(box, demo, ["context"])).out;
    assert.match(context, new RegExp(`self work accept ${id}`));
    assert.equal(context.split("\n").filter((line) => line.includes(id)).length, 1, context);
});

test("cell 69: the listing carries the plan and the target, each counted once", async () =>
{
    const target = await unit("cell 69: the outcome still open under a correction");
    const id = await correction("cell 69: the corrected outcome", target);
    const listing = (await must(box, demo, ["work"])).out;
    assert.equal(listing.split("\n").filter((line) => line.includes(id)).length, 1, listing);
    assert.equal(listing.split("\n").filter((line) => line.includes(target)).length, 1, listing);
});
