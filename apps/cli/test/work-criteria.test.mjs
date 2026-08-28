// #408, sections A, B, J and L of `docs/maintainers/case-tables/408-work-criteria.md`:
// declaring a work unit's completion conditions at birth and afterwards, who
// the record says wrote each of them, and the help, documentation and contract
// that describe the grammar. One test per cell, named by its cell number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkContract } from "../dist/contract.js";
import { COMMANDS } from "../dist/main.js";
import { demoWorkspace, git, logFixture, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));

const box = machine();
const { ws, demo } = await demoWorkspace(box);

const AGENT = { SUPERSELF_SESSION: "s-408" };

function events()
{
    return readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
}

function newest(type)
{
    const found = events().filter((event) => event.type === type).at(-1);
    assert.ok(found !== undefined, `no ${type} in the log`);
    return found;
}

// `U` throughout the table: a confirmed, started unit declaring three criteria.
async function startedUnit(outcome, extra = [])
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", outcome,
        "--criteria", "the fixture regenerates clean",
        "--criteria", "the release note names the flag",
        "--criteria", "the vendor quota is raised", ...extra])).out);
    await must(box, demo, ["work", "start", id]);
    return id;
}

/* ── A. declaring at birth ─────────────────────────────────────────── */

test("cell 1: work add records the declared criteria in the order they were given", async () =>
{
    const receipt = (await mustPerson(box, demo, ["work", "add", "cell 1", "--criteria", "a", "--criteria", "b"])).printed;
    const id = workIdIn(receipt);
    const created = events().findLast((event) => event.type === "entity.confirmed" && event.payload.entity === id);
    assert.deepEqual(created.payload.criteria, ["a", "b"]);
    assert.ok(receipt.split("\n").includes(id), "the receipt is no longer the work id on a line of its own");
});

test("cell 2: work add with no --criteria writes the byte-identical empty list", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 2"])).out);
    const created = events().findLast((event) => event.type === "entity.confirmed" && event.payload.entity === id);
    assert.deepEqual(created.payload.criteria, []);
    assert.equal(created.payload.verify, undefined, "a call declaring no verification wrote no verify key");
    assert.doesNotMatch((await must(box, demo, ["work", "show", id])).out, /Criteria/);
});

test("cell 3: --verify rides the creation event as a map keyed by the position it names", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 3", "--criteria", "a", "--criteria", "b",
        "--verify", "c2 the release note names the flag"])).out);
    const created = events().findLast((event) => event.type === "entity.confirmed" && event.payload.entity === id);
    assert.deepEqual(created.payload.verify, { c2: "the release note names the flag" });
});

test("cell 4: --verify with no --criteria is refused by name", async () =>
{
    const result = await selfIn(box, demo, ["work", "add", "cell 4", "--verify", "c1 how"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /work add --verify states how one declared criterion is checked — pass --criteria "<text>" too/);
});

test("cell 5: --verify that names no criterion is refused, naming what this call declares", async () =>
{
    const result = await selfIn(box, demo, ["work", "add", "cell 5", "--criteria", "a", "--verify", "the fixture regenerates"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /work add --verify must begin with the criterion it verifies — "c1 <how it is checked>"; this call declares c1/);
});

test("cell 6: --verify naming a position this call does not declare is refused", async () =>
{
    const result = await selfIn(box, demo, ["work", "add", "cell 6", "--criteria", "a", "--verify", "c4 how"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /work add --verify names c4, and this call declares c1/);
});

test("cell 7: one criterion states one verification method", async () =>
{
    const result = await selfIn(box, demo, ["work", "add", "cell 7", "--criteria", "a", "--criteria", "b",
        "--verify", "c1 one", "--verify", "c1 two"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /work add --verify names c1 twice — one criterion states one verification method/);
});

test("cell 8: an empty --criteria is refused by the shipped validText refusal", async () =>
{
    const work = await selfIn(box, demo, ["work", "add", "cell 8", "--criteria", ""]);
    const raw = await selfIn(box, demo, ["state", "add", "cell 8 raw", "--criteria", ""]);
    assert.notEqual(work.code, 0);
    assert.match(work.out, /one criterion's text/);
    assert.equal(work.out, raw.out, "the work verb gives a different refusal from `state add --criteria`");
});

test("cell 9: one call declaring the same criterion twice is refused", async () =>
{
    const result = await selfIn(box, demo, ["work", "add", "cell 9", "--criteria", "a", "--criteria", "a"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /work add --criteria declares "a" twice — a criterion is judged once, and two with one text could never be told apart/);
});

test("cell 10: work propose carries the declared list on the proposal", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 10", "--criteria", "a", "--criteria", "b"], AGENT)).out);
    const proposed = events().findLast((event) => event.type === "entity.proposed" && event.payload.entity === id);
    assert.deepEqual(proposed.payload.criteria, ["a", "b"]);
    assert.deepEqual(proposed.payload.labels, ["work"]);
    assert.deepEqual(proposed.payload.links, []);
});

test("cell 11: criteria and --supersedes ride the same proposal", async () =>
{
    const target = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 11 target"])).out);
    await must(box, demo, ["work", "start", target]);
    const printed = (await must(box, demo, ["work", "propose", "cell 11", "--criteria", "a",
        "--supersedes", target, "--why", "the outcome moved"], AGENT)).printed;
    const id = workIdIn(printed);
    const proposed = events().findLast((event) => event.type === "entity.proposed" && event.payload.entity === id);
    assert.deepEqual(proposed.payload.criteria, ["a"]);
    assert.equal(proposed.payload.supersedes.entity, target);
    assert.match(printed, new RegExp(`${id}\\n  replaces ${target} on acceptance — ${target} is untouched until it is confirmed with \`self work confirm ${id}\``),
        "#389's two-line proposal receipt changed shape");
});

test("cell 12: criteria do not make a plan novel — requireNovel refuses the second one", async () =>
{
    await must(box, demo, ["work", "propose", "cell 12 outcome", "--criteria", "a"], AGENT);
    const again = await selfIn(box, demo, ["work", "propose", "cell 12 outcome", "--criteria", "b"], AGENT);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already/);
});

/* ── B. declaring later ────────────────────────────────────────────── */

test("cell 13: work criteria add appends the criterion, never inserts it", async () =>
{
    const id = await startedUnit("cell 13");
    await must(box, demo, ["work", "criteria", "add", id, "d"], AGENT);
    const declared = newest("entity.criterion-declared");
    assert.equal(declared.payload.entity, id);
    assert.equal(declared.payload.criterion, "d");
    assert.ok(declared.payload.by !== undefined, "the declaration says who wrote it");
    const shown = (await must(box, demo, ["state", "show", id])).out;
    assert.match(shown, /criterion: c4 d/);
    assert.match(shown, /criterion: c1 the fixture regenerates clean/);
});

test("cell 14: declaring the first criterion says that done now waits on it", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 14"])).out);
    const receipt = (await must(box, demo, ["work", "criteria", "add", id, "a"])).printed;
    assert.match(receipt, new RegExp(`${id} c1 "a" — done now waits on it`));
    const done = await selfIn(box, demo, ["work", "done", id, "--report", "it happened"]);
    assert.notEqual(done.code, 0);
    assert.match(done.out, /c1 {2}open — a/);
});

test("cell 15: --verify on work criteria add is bare, and work show prints it", async () =>
{
    const id = await startedUnit("cell 15");
    await must(box, demo, ["work", "criteria", "add", id, "d", "--verify", "the quota page shows 10k"]);
    assert.equal(newest("entity.criterion-declared").payload.verify, "the quota page shows 10k");
    assert.match((await must(box, demo, ["work", "show", id])).out, /c4 open — d · verify: the quota page shows 10k/);
});

test("cell 16: a plan still in review may still be given a criterion", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 16"], AGENT)).out);
    await must(box, demo, ["work", "criteria", "add", id, "a"]);
    assert.match((await must(box, demo, ["state", "show", id])).out, /criterion: c1 a/);
});

test("cell 17: a criterion the unit already declares is refused by the shared writer", async () =>
{
    const id = await startedUnit("cell 17");
    await must(box, demo, ["work", "criteria", "add", id, "d"]);
    const again = await selfIn(box, demo, ["work", "criteria", "add", id, "d"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, new RegExp(`${id} already declares c4 "d" — a criterion is judged once, and two with one text could never be told apart`));
});

test("cell 18: a done unit's outcome is already judged", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 18"])).out);
    await must(box, demo, ["work", "start", id]);
    await must(box, demo, ["work", "done", id, "--report", "it happened"]);
    const result = await selfIn(box, demo, ["work", "criteria", "add", id, "d"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${id} is done — a criterion states what completion required, and this outcome is already judged`));
});

test("cell 19: a retired unit sends the declaration to its successor", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 19"])).out);
    await must(box, demo, ["work", "start", id]);
    await mustPerson(box, demo, ["work", "add", "cell 19 successor", "--supersedes", id, "--why", "the outcome moved"], { ...AGENT });
    const result = await selfIn(box, demo, ["work", "criteria", "add", id, "d"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${id} was retired — declare it on the successor, whose criteria start uncovered`));
});

test("cell 20: a runbook definition id is refused as not a work id", async () =>
{
    const runbook = (await must(box, demo, ["runbook", "add", "cell 20 procedure",
        "--stage", "the first stage"])).out.match(/\be-[0-9a-z]{5}\b/)[0];
    const result = await selfIn(box, demo, ["work", "criteria", "add", runbook, "d"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown work id/);
});

test("cell 21: the shared writer refuses a runbook run by name, and stageDigest is unchanged", async () =>
{
    const runbook = (await must(box, demo, ["runbook", "add", "cell 21 procedure",
        "--stage", "the first stage"])).out.match(/\be-[0-9a-z]{5}\b/)[0];
    const unit = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 21 unit"])).out);
    void unit;
    const started = (await must(box, demo, ["runbook", "start", runbook, "--instance", "E001"])).out;
    const run = started.match(/\be-[0-9a-z]{5}\b/g).at(-1);
    const before = (await must(box, demo, ["runbook", "show", runbook])).out;
    const { recordDeclaration } = await import("../dist/state.js");
    const { buildModel } = await import("../dist/model.js");
    const model = buildModel(join(ws, ".superself"), "demo", new Date());
    const entity = model.entities.find((item) => item.id === run);
    assert.throws(() => recordDeclaration({ storeDir: join(ws, ".superself"), project: "demo" }, "demo", entity, "d", undefined),
        /is a runbook run — its stages come from the procedure it follows, and a stage is added by revising the runbook \(`self runbook revise <id> --stage "<text>" --why w`\)/);
    assert.equal((await must(box, demo, ["runbook", "show", runbook])).out, before, "the refused call moved the stages fingerprint");
});

test("cell 22: an undone unit has nothing to declare a criterion on", async () =>
{
    const printed = (await mustPerson(box, demo, ["work", "add", "cell 22"])).printed;
    const id = workIdIn(printed);
    const creation = events().findLast((event) => event.type === "entity.confirmed" && event.payload.entity === id);
    await must(box, demo, ["undo", creation.id, "--why", "recorded by mistake"]);
    const result = await selfIn(box, demo, ["work", "criteria", "add", id, "d"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`${id} was recorded by mistake and is undone — there is nothing to declare a criterion on`));
});

/* ── J. who wrote it ───────────────────────────────────────────────── */

test("cell 87: a person declaring a criterion is recorded as a person, with no prompt", async () =>
{
    const id = await startedUnit("cell 87");
    await mustPerson(box, demo, ["work", "criteria", "add", id, "d"]);
    assert.deepEqual(newest("entity.criterion-declared").payload.by, { kind: "person" });
});

test("cell 88: an agent session blocking a criterion is recorded with its token", async () =>
{
    const id = await startedUnit("cell 88");
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"], AGENT);
    assert.deepEqual(newest("entity.criterion-blocked").payload.by, { kind: "agent", session: "s-408" });
});

test("cell 89: entity.covered carries `by`, and the shipped claim line still reads off actor", async () =>
{
    const id = await startedUnit("cell 89");
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "the note names it"], AGENT);
    const covered = newest("entity.covered");
    assert.deepEqual(covered.payload.by, { kind: "agent", session: "s-408" });
    assert.match((await must(box, demo, ["state", "show", id])).out, /covered: the release note names the flag — the note names it \(agent /);
});

test("cell 90: the criterion events render with #400's who-wrote-it line in --history", async () =>
{
    const id = await startedUnit("cell 90");
    await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "external", "--why", "the vendor is silent"], AGENT);
    const history = (await must(box, demo, ["work", "show", id, "--history"])).out;
    assert.match(history, /entity\.criterion-blocked.*· by agent/s);
});

/* ── L. help, documentation and the contract ───────────────────────── */

// Read inside the cells rather than at module load: the driver runs one
// command at a time, and a top-level await here would overlap the first cell.
const page = async (args) => (await must(box, demo, args)).out;

const RUNBOOK_BOUNDARY = [
    "a runbook is a procedure this project repeats — registered once, run per",
    "piece of work, with the same stages every run. A work unit's criteria are",
    "that one unit's completion conditions: declared on it, judged on it, never",
    "run again. If you would declare the same list on the next unit too, it is a",
    "runbook."
].join("\n");

test("cell 97: the usage lines carry the declaring, blocking, declaring-later and covering forms", async () =>
{
    const workHelp = await page(["work", "--help"]);
    assert.match(workHelp, /work add "<required outcome>".*\[--criteria "<text>" …\] \[--verify "cN <how>"\]/);
    assert.match(workHelp, /work propose "<plan>".*\[--criteria "<text>" …\] \[--verify "cN <how>"\]/);
    assert.match(workHelp, /work block\|unblock <id> \[--criterion cN\]/);
    assert.match(workHelp, /work criteria add <id> "<text>" \[--verify "<how it is checked>"\]/);
    assert.match(workHelp, /work cover <id> --criterion cN --why "<how it is covered>"/);
});

test("cell 98: the option list states all four flags in the words the design gives", async () =>
{
    const workHelp = await page(["work", "--help"]);
    assert.match(workHelp, /--criteria <text> +a completion condition this unit is judged on, repeatable/);
    assert.match(workHelp, /and ordered c1\.\.cN/);
    assert.match(workHelp, /--verify "cN <how>" +how one declared criterion is checked — recorded, never/);
    assert.match(workHelp, /executed/);
    assert.match(workHelp, /--criterion <cN> +which declared criterion a claim or a block answers/);
    assert.match(workHelp, /--evidence <commit> +a commit recorded with the coverage claim/);
});

test("cell 99: `self help work` states the rule and that nothing deletes a criterion", async () =>
{
    const helpWork = await page(["help", "work"]);
    assert.match(helpWork, /a unit that declares criteria is not done until every one of them is\ncovered/);
    assert.match(helpWork, /nothing deletes a criterion: a mistaken one is undone with `self undo`, and\none no longer needed is covered with a reason and no evidence/);
});

test("cell 100: `self help work` and `self work --help` both carry the runbook boundary verbatim", async () =>
{
    const workHelp = await page(["work", "--help"]);
    const helpWork = await page(["help", "work"]);
    assert.ok(workHelp.includes(RUNBOOK_BOUNDARY), "`self work --help` lost the runbook boundary paragraph");
    assert.ok(helpWork.includes(RUNBOOK_BOUNDARY), "`self help work` lost the runbook boundary paragraph");
});

test("cell 101: `self help runbook` carries the same boundary from the other side", async () =>
{
    const runbookHelp = await page(["help", "runbook"]);
    assert.match(runbookHelp, /a runbook is a procedure this project repeats/);
    assert.match(runbookHelp, /A work unit's criteria are that one unit's completion\nconditions: declared on it, judged on it, never run again/);
});

test("cell 102: docs/reference/cli.md documents the three verbs and the three event types", () =>
{
    const cli = readFileSync(join(repo, "docs/reference/cli.md"), "utf8");
    const outcomes = cli.split(/^### /m).find((section) => section.startsWith("Outcome and work commands"));
    assert.match(outcomes, /`work add "<outcome>" --criteria/);
    assert.match(outcomes, /`work criteria add <id> "<text>" \[--verify/);
    assert.match(outcomes, /`work cover <id> --criterion cN/);
    assert.match(outcomes, /`work block <id> --criterion cN/);
    assert.match(outcomes, /recorded prose and is \*\*never executed\*\*/);
    const grammar = cli.split(/^The CLI writes one shared event grammar\./m)[1];
    assert.match(grammar, /`entity\.criterion-declared`/);
    assert.match(grammar, /`entity\.criterion-blocked`/);
    assert.match(grammar, /`entity\.criterion-unblocked`/);
    assert.match(grammar, /recorded, never executed/);
    assert.match(grammar, /whose `verify` text is/);
});

test("cell 103: checkContract over the composed command list is still empty", () =>
{
    assert.deepEqual(checkContract(COMMANDS), []);
});

test("cell 104: ARCHITECTURE.md's event list carries the three, each marked ignored by an older fold", () =>
{
    const architecture = readFileSync(join(repo, "ARCHITECTURE.md"), "utf8");
    for (const type of ["entity.criterion-declared", "entity.criterion-blocked", "entity.criterion-unblocked"])
    {
        const line = architecture.split("\n").find((text) => text.includes(type));
        assert.ok(line !== undefined, `ARCHITECTURE.md does not name ${type}`);
        assert.match(line, /ignored by an older fold/);
    }
});

/* ── the self-adversarial pass ─────────────────────────────────────── */

// Three holes the case table does not have a cell for, found by driving the
// grammar against the shipped rules it composes with. Each is closed here.

test("a duplicate criterion is refused on the raw path too, and one already recorded folds to one", async () =>
{
    const refused = await selfIn(box, demo, ["state", "add", "the raw duplicate", "--criteria", "a", "--criteria", "a"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /state add --criteria declares "a" twice/);
    // A record written before that refusal — or hand-appended — folds to the
    // one criterion it always meant, and stays finishable: two criteria with
    // one text could never be addressed apart, and `cN` is the address.
    const id = "w-dupfd";
    logFixture(ws, "demo", {
        id: "01hz00000000000000000dup1", ts: "2026-01-01T00:00:00.000Z", type: "entity.confirmed", project: "demo",
        refs: {}, origin: { actor: "agent", confirmed: true },
        payload: { entity: id, text: "a duplicated declaration", labels: ["work"], links: [],
            criteria: ["a", "a", "b"], verify: { c3: "how b is checked" }, exposure: "search", scope: "project" }
    });
    const shown = (await must(box, demo, ["state", "show", id])).out;
    assert.match(shown, /criterion: c1 a\ncriterion: c2 b\n {2}verify: how b is checked/);
    await must(box, demo, ["work", "start", id]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "landed"]);
    assert.equal((await selfIn(box, demo, ["work", "done", id, "--report", "it happened"])).code, 0,
        "a unit whose payload declared one criterion twice can never be finished");
});

test("a criterion-axis write about a scoped-in unit lands in the log that owns it", async () =>
{
    const other = join(ws, "other");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    await must(box, other, ["project", "init", "--name", "other", "--desc", "the second project"]);
    const id = await startedUnit("the scoped-out unit");
    await must(box, demo, ["state", "place", id, "--scope", "other"]);
    await must(box, other, ["work", "criteria", "add", id, "declared from the other side"]);
    await must(box, other, ["work", "block", id, "--criterion", "c1", "--on", "external", "--why", "the vendor is silent"]);
    assert.deepEqual(events().slice(-2).map((event) => event.project), ["demo", "demo"],
        "a write about a scoped-in unit landed outside its own log");
    assert.equal(existsSync(join(ws, ".superself", "projects", "other", "log.jsonl")), false,
        "the second project's log grew a criterion event about a unit it does not own");
    assert.match((await must(box, other, ["state", "show", id])).out, /criterion: c4 declared from the other side/);
});

test("a criterion is refused on a unit this CLI cannot address, rather than written blind", async () =>
{
    const legacy = "w-legac";
    logFixture(ws, "demo", {
        id: "01hz00000000000000000leg1", ts: "2026-01-01T00:00:00.000Z", type: "entity.confirmed", project: "demo",
        refs: {}, origin: { actor: "agent", confirmed: true },
        payload: { entity: legacy, text: "a unit with no criteria", labels: ["work"], links: [], criteria: [],
            exposure: "search", scope: "project" }
    });
    // It resolves, so declaring on it works — the guard is for a unit the
    // entity fold does not hold at all, which is what the refusal names.
    await must(box, demo, ["work", "criteria", "add", legacy, "a"]);
    assert.match((await must(box, demo, ["state", "show", legacy])).out, /criterion: c1 a/);
});
