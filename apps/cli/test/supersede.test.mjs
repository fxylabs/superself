// Correcting a record reads the same everywhere: `--supersedes <id>` on every
// add verb, with each kind's older spelling still accepted. The cases below are
// the design's case table — record kind × form × target state — one test per
// cell, asserting the outcome the table states.
//
//   kind        add --supersedes        legacy form              wrong-kind id
//   decision    K1                      K1 (same spelling)       K7
//   objective   K2                      K2 (same spelling)       K8
//   milestone   K3                      K3 (same spelling)       K9
//   convention  K4                      K4 (same spelling)       K10
//   work        K5                      K5-legacy                K11
//   entity      K6                      K6-legacy                K12 / B6
//
//   B1 target done   B2 target retired   B3 unknown id
//   B4 work supersede without --why      B5 both spellings, one target
//   B6 free entity superseding a unit    B7 --why with nothing superseded
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATEMENT_TYPES } from "../dist/model.js";
import { approvedIn, demoWorkspace, idIn, machine, must, mustPerson, receiptIn, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);
const self = (args) => selfIn(box, demo, args);
// Destroying a record needs a person at a terminal (#173): where a case is
// about what the destruction records, the command line runs in full and only
// the typed answer is stood in for.
const approved = (args, answer) => approvedIn(box, demo, args, answer);

function entityIn(text)
{
    const match = text.match(/\b[eom]-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no entity id in: ${text}`);
    return match[0];
}

function events()
{
    const log = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8");
    return log.trim().split("\n").map((line) => JSON.parse(line));
}

function retirementOf(id)
{
    return events().filter((event) => event.type === "entity.retired" && event.payload.entity === id).pop();
}

// A live unit of each kind, minted per test so no case inherits another's
// terminal state.
async function work(outcome)
{
    return workIdIn((await mustPerson(box, demo, ["work", "add", outcome])).out);
}

async function objective(outcome)
{
    return entityIn((await must(box, demo, ["objective", "add", outcome])).out);
}

async function entity(text)
{
    return (await must(box, demo, ["state", "add", text])).out.match(/\be-[0-9a-z]{5}\b/)[0];
}

/* ── the one spelling ──────────────────────────────────────────────── */

test("every statement type supersedes with --supersedes, spelled the same way", () =>
{
    for (const statement of STATEMENT_TYPES)
    {
        assert.ok(statement.supersede.startsWith("--supersedes"),
            `${statement.type} corrects a record with "${statement.supersede}" instead of --supersedes`);
    }
});

/* ── K1-K6: --supersedes on every add verb ─────────────────────────── */

test("K1: decide --supersedes replaces the decision, and the predecessor leaves the render", async () =>
{
    const first = idIn((await must(box, demo, ["decide", "K1 first wording"])).out);
    assert.equal((await approved(["decide", "K1 corrected wording", "--supersedes", first], first)).code, 0);
    const context = (await must(box, demo, ["context"])).out;
    assert.ok(context.includes("K1 corrected wording"));
    assert.ok(!context.includes("K1 first wording"), "a superseded decision still renders as current");
});

test("K2: objective add --supersedes replaces the objective", async () =>
{
    const first = await objective("K2 first outcome");
    const replacing = await approved(["objective", "add", "K2 corrected outcome", "--supersedes", first], first);
    assert.equal(replacing.code, 0, replacing.out);
    assert.match((await must(box, demo, ["state", "show", first])).out, /superseded/);
    assert.match((await must(box, demo, ["state", "show", entityIn(receiptIn(replacing.printed))])).out, /confirmed/);
});

test("K3: milestone add --supersedes replaces the checkpoint under its objective", async () =>
{
    const parent = await objective("K3 objective");
    const first = entityIn((await must(box, demo, ["milestone", "add", "K3 first checkpoint", "--objective", parent, "--exit", "the proof passes"])).out);
    const replacing = await approved(["milestone", "add", "K3 corrected checkpoint", "--objective", parent, "--exit", "the proof passes", "--supersedes", first], first);
    assert.equal(replacing.code, 0, replacing.out);
    assert.match((await must(box, demo, ["state", "show", first])).out, /superseded/);
});

test("K4: convention add --supersedes replaces the rule in one event", async () =>
{
    const first = idIn((await must(box, demo, ["convention", "add", "K4 first rule"])).out);
    assert.equal((await approved(["convention", "add", "K4 corrected rule", "--supersedes", first], first)).code, 0);
    const context = (await must(box, demo, ["context"])).out;
    assert.ok(context.includes("K4 corrected rule"));
    assert.ok(!context.includes("K4 first rule"), "a superseded convention still renders as current");
});

test("K5: work add --supersedes creates the unit and retires the one it replaces, as its successor", async () =>
{
    const first = await work("K5 first outcome");
    const created = await approved(["work", "add", "K5 corrected outcome", "--supersedes", first, "--why", "the outcome was restated"], first);
    assert.equal(created.code, 0, created.out);
    const successor = workIdIn(created.printed);
    // One state change, one append: the new unit and the retirement it causes.
    assert.deepEqual(created.printed.match(/entity\.\w+ recorded/g), ["entity.confirmed recorded", "entity.retired recorded"]);
    const shown = (await must(box, demo, ["work", "show", first])).out;
    assert.match(shown, /Status: retired/);
    assert.match(shown, /the outcome was restated/);
    assert.ok(shown.includes(successor), "the retired unit does not name its successor");
    assert.ok(!(await must(box, demo, ["work"])).out.includes("K5 first outcome"), "a superseded unit still lists as open");
});

test("K5: the events a work supersession records are the events retire --successor records", async () =>
{
    const spelled = await work("K5 oracle: the unit retire --successor moves");
    const successor = await work("K5 oracle: the unit that carries it now");
    await approved(["work", "retire", spelled, "--why", "moved to the successor", "--successor", successor], spelled);
    const superseded = await work("K5 oracle: the unit --supersedes moves");
    const created = workIdIn(receiptIn((await approved(["work", "add", "K5 oracle: the unit that carries it now, too",
        "--supersedes", superseded, "--why", "moved to the successor"], superseded)).printed));
    const byRetire = retirementOf(spelled);
    const bySupersede = retirementOf(superseded);
    assert.deepEqual(Object.keys(bySupersede.payload).sort(), Object.keys(byRetire.payload).sort());
    assert.deepEqual(bySupersede.payload, {
        entity: superseded, why: "moved to the successor", successor: created, successorProject: "demo",
        by: { kind: "person" }
    });
    assert.equal(bySupersede.type, byRetire.type);
    assert.equal(bySupersede.origin.confirmed, byRetire.origin.confirmed);
});

test("K5-legacy: work retire --successor keeps working unchanged", async () =>
{
    const retired = await work("K5 legacy outcome");
    const successor = await work("K5 legacy successor");
    assert.equal((await approved(["work", "retire", retired, "--why", "moved to the successor", "--successor", successor], retired)).code, 0);
    const shown = (await must(box, demo, ["work", "show", retired])).out;
    assert.match(shown, /Status: retired/);
    assert.ok(shown.includes(successor));
});

test("K6: state add --supersedes replaces the entity, exactly as the link form does", async () =>
{
    const byFlag = await entity("K6 first text");
    const byLink = await entity("K6 first text, other copy");
    const flagged = receiptIn((await approved(["state", "add", "K6 corrected text", "--supersedes", byFlag], byFlag)).printed);
    const linked = receiptIn((await approved(["state", "add", "K6 corrected text, other copy", "--link", `supersedes:${byLink}`], byLink)).printed);
    const flaggedLinks = events().find((event) => event.payload.entity === flagged.match(/\be-[0-9a-z]{5}\b/)[0]).payload.links;
    const linkedLinks = events().find((event) => event.payload.entity === linked.match(/\be-[0-9a-z]{5}\b/)[0]).payload.links;
    assert.deepEqual(flaggedLinks, [{ type: "supersedes", target: byFlag }]);
    assert.deepEqual(linkedLinks, [{ type: "supersedes", target: byLink }]);
    assert.match((await must(box, demo, ["state", "show", byFlag])).out, /superseded/);
});

test("K6-legacy: --link supersedes:<id> keeps working unchanged", async () =>
{
    const target = await entity("K6 legacy text");
    assert.equal((await approved(["state", "add", "K6 legacy corrected text", "--link", `supersedes:${target}`], target)).code, 0);
    assert.match((await must(box, demo, ["state", "show", target])).out, /superseded by/);
});

/* ── K7-K12: a target of another kind names the verb that owns it ──── */

test("K7: decide --supersedes on a work id names work add --supersedes", async () =>
{
    const unit = await work("K7 outcome");
    const refused = await self(["decide", "K7 text", "--supersedes", unit]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is a work record/);
    assert.match(refused.out, /self work add "<outcome>" --supersedes <id>/);
});

test("K8: objective add --supersedes on a work id names work add --supersedes", async () =>
{
    const unit = await work("K8 outcome");
    const refused = await self(["objective", "add", "K8 outcome", "--supersedes", unit]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is a work record/);
    assert.match(refused.out, /self work add "<outcome>" --supersedes <id>/);
});

test("K9: milestone add --supersedes on a decision id names decide --supersedes", async () =>
{
    const parent = await objective("K9 objective");
    const decision = idIn((await must(box, demo, ["decide", "K9 decision"])).out);
    const refused = await self(["milestone", "add", "K9 checkpoint", "--objective", parent, "--exit", "c", "--supersedes", decision]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is a decision record/);
    assert.match(refused.out, /self decide "<text>" --supersedes <id>/);
});

test("K10: convention add --supersedes on an objective id names objective add --supersedes", async () =>
{
    const parent = await objective("K10 objective");
    const refused = await self(["convention", "add", "K10 rule", "--supersedes", parent]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is an? objective record/);
    assert.match(refused.out, /self objective add "<outcome>" --supersedes <id>/);
});

test("K11: work add --supersedes on a decision id names decide --supersedes", async () =>
{
    const decision = idIn((await must(box, demo, ["decide", "K11 decision"])).out);
    const refused = await self(["work", "add", "K11 outcome", "--supersedes", decision, "--why", "w"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is a decision record/);
    assert.match(refused.out, /self decide "<text>" --supersedes <id>/);
});

test("K12: state add --supersedes on a convention id names convention add --supersedes", async () =>
{
    const convention = idIn((await must(box, demo, ["convention", "add", "K12 rule"])).out);
    const refused = await self(["state", "add", "K12 text", "--supersedes", convention]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is a convention record/);
    assert.match(refused.out, /self convention add "<text>" --supersedes <id>/);
});

/* ── B1-B6: the boundary cells ─────────────────────────────────────── */

test("B1: superseding a done unit refuses — retirement is not a transition from done", async () =>
{
    const unit = await work("B1 outcome");
    await must(box, demo, ["work", "done", unit, "--report", "B1 verifiably happened"]);
    const refused = await self(["work", "add", "B1 corrected outcome", "--supersedes", unit, "--why", "w"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is already done/);
    assert.match(refused.out, /given up, not one that was reached/);
});

test("B2: superseding an already retired unit refuses, naming that it is retired", async () =>
{
    const unit = await work("B2 outcome");
    await approved(["work", "retire", unit, "--why", "given up earlier"], unit);
    const refused = await self(["work", "add", "B2 corrected outcome", "--supersedes", unit, "--why", "w"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is already retired/);
    assert.match(refused.out, /given up earlier/);
});

test("B3: --supersedes naming an id nothing answers to refuses, naming the id", async () =>
{
    const unit = await self(["work", "add", "B3 outcome", "--supersedes", "w-zzzzz", "--why", "w"]);
    assert.notEqual(unit.code, 0);
    assert.match(unit.out, /unknown work id "w-zzzzz"/);
    const free = await self(["state", "add", "B3 text", "--supersedes", "e-zzzzz"]);
    assert.notEqual(free.code, 0);
    assert.match(free.out, /unknown entity "e-zzzzz"/);
    const decision = await self(["decide", "B3 text", "--supersedes", "01zzzzz"]);
    assert.notEqual(decision.code, 0);
    assert.match(decision.out, /01zzzzz is not a decision/);
});

test("B4: superseding a unit without --why refuses — the retirement keeps its reason", async () =>
{
    const unit = await work("B4 outcome");
    const refused = await self(["work", "add", "B4 corrected outcome", "--supersedes", unit]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--why/);
    assert.match((await must(box, demo, ["work", "show", unit])).out, /Status: next/, "the unit was retired without its reason");
});

test("B5: one target named in both spellings records one supersedes link", async () =>
{
    const target = await entity("B5 text");
    const created = await approved(["state", "add", "B5 corrected text", "--supersedes", target, "--link", `supersedes:${target}`], target);
    const id = receiptIn(created.printed).match(/\be-[0-9a-z]{5}\b/)[0];
    assert.deepEqual(events().find((event) => event.payload.entity === id).payload.links,
        [{ type: "supersedes", target }]);
    assert.equal(((await must(box, demo, ["state", "show", id])).out.match(/link: supersedes/g) ?? []).length, 1);
});

test("B7: --why with nothing superseded is refused, never dropped", async () =>
{
    const refused = await self(["work", "add", "B7 outcome", "--why", "a reason for nothing"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--supersedes <work-id>/);
    assert.ok(!(await must(box, demo, ["work"])).out.includes("B7 outcome"), "the unit was created with its --why dropped");
});

test("B6: state add --supersedes on a work id names work add --supersedes", async () =>
{
    const unit = await work("B6 outcome");
    const refused = await self(["state", "add", "B6 text", "--supersedes", unit]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is a work record/);
    assert.match(refused.out, /self work add "<outcome>" --supersedes <id> --why w/);
});
