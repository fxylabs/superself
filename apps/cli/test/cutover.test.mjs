// The preset write cutover (#207 B): every preset verb records shared-grammar
// `entity.*` events — asserted against the log lines the verbs actually
// append, the folded placement, and the printed output (ruling ②). Each test
// derives from its B cell; B14's regression net is the phase 3 suite, cited
// at the bottom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildModel } from "../dist/model.js";
import { approvedIn, demoWorkspace, idIn, machine, must, mustPerson, receiptIn, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = await demoWorkspace(box);
const log = join(box.root, "ws", ".superself", "projects", "demo", "log.jsonl");
const self = (args) => selfIn(box, demo, args);
// Destroying a record needs a person at a terminal (#173): the command line
// runs in full and only the typed answer is stood in for.
const approved = (args, answer) => approvedIn(box, demo, args, answer);

function events()
{
    return readFileSync(log, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

function eventFor(id, type)
{
    return events().find((event) => event.type === type && event.payload.entity === id);
}

async function shown(id)
{
    return (await must(box, demo, ["state", "show", id])).out;
}

test("B1: goal add records entity.confirmed at goal placement and supersedes the goal it names", async () =>
{
    const first = idIn((await must(box, demo, ["goal", "add", "first direction"])).out);
    const printed = (await approved(["goal", "add", "second direction", "--supersedes", first], first)).printed;
    assert.match(printed, /entity\.confirmed recorded/);
    const second = idIn(printed);
    const recorded = eventFor(second, "entity.confirmed");
    assert.deepEqual(recorded.payload.labels, ["goal"]);
    assert.equal(recorded.payload.priority, 0);
    assert.equal(recorded.payload.exposure, "full");
    assert.ok((await shown(first)).includes(`superseded by: ${second}`));
    assert.match((await must(box, demo, ["status"])).out, /goal: second direction/);
});

test("B2: decide records entity.confirmed labeled decision at index p40", async () =>
{
    const id = idIn((await must(box, demo, ["decide", "keep sqlite", "--why", "simple"])).out);
    const recorded = eventFor(id, "entity.confirmed");
    assert.deepEqual(recorded.payload.labels, ["decision"]);
    assert.equal(recorded.payload.priority, 40);
    assert.equal(recorded.payload.exposure, "index");
    assert.equal(recorded.payload.why, "simple");
});

test("B3: decide --proposed records entity.proposed, and decide confirm answers it", async () =>
{
    const id = idIn((await must(box, demo, ["decide", "adopt turso", "--proposed"])).out);
    assert.notEqual(eventFor(id, "entity.proposed"), undefined);
    const confirmed = await must(box, demo, ["decide", "confirm", id]);
    assert.match(confirmed.out, /entity\.confirmed recorded/);
    const answer = events().find((event) => event.type === "entity.confirmed" && event.refs?.confirms === id);
    assert.notEqual(answer, undefined, "the confirm did not reference the proposal");
    assert.ok((await shown(id)).includes("confirmed"));
});

test("B4: decline and retract record entity.retracted, and the declined proposal keeps its marker", async () =>
{
    const declined = idIn((await must(box, demo, ["decide", "maybe queue", "--proposed"])).out);
    await must(box, demo, ["decide", "decline", declined, "--why", "not now"]);
    assert.equal(eventFor(declined, "entity.retracted").payload.why, "not now");
    // Search answers over live records now (#212), so the marker a withdrawn
    // record keeps is read where the record is named rather than in a pull.
    assert.match((await must(box, demo, ["state", "show", declined, "--history"])).out, /declined/);
    assert.equal((await must(box, demo, ["search", "maybe queue"])).out.trim(), "no matches");
    const retracted = idIn((await must(box, demo, ["decide", "temp rule"])).out);
    await approved(["decide", "retract", retracted, "--why", "walked back"], retracted);
    assert.match((await must(box, demo, ["state", "show", retracted, "--history"])).out, /retracted/);
    assert.equal((await must(box, demo, ["search", "temp rule"])).out.trim(), "no matches");
});

test("B5: convention add records entity.confirmed at p30 full, with scope and supersedes carried", async () =>
{
    const old = idIn((await must(box, demo, ["convention", "add", "four spaces"])).out);
    const corrected = idIn((await approved(["convention", "add", "four spaces, semicolons", "--supersedes", old], old)).printed);
    const recorded = eventFor(corrected, "entity.confirmed");
    assert.deepEqual(recorded.payload.labels, ["convention"]);
    assert.equal(recorded.payload.priority, 30);
    assert.equal(recorded.payload.exposure, "full");
    assert.deepEqual(recorded.payload.links, [{ type: "supersedes", target: old }]);
    assert.ok((await shown(old)).includes(`superseded by: ${corrected}`));
    const scoped = idIn((await must(box, demo, ["convention", "add", "shared rule", "--workspace"])).out);
    assert.equal(eventFor(scoped, "entity.confirmed").payload.scope, "workspace");
});

test("B6: convention drop records entity.retracted and the rule leaves the render", async () =>
{
    const id = idIn((await must(box, demo, ["convention", "add", "tabs everywhere"])).out);
    const printed = await approved(["convention", "drop", id, "--why", "spaces won"], id);
    assert.match(printed.printed, /entity\.retracted recorded/);
    assert.equal(eventFor(id, "entity.retracted").payload.why, "spaces won");
    assert.ok(!(await must(box, demo, ["context"])).out.includes("tabs everywhere"));
});

test("B7: objective add records entity.confirmed with target metadata and unvalidated legacy fields", async () =>
{
    const printed = (await must(box, demo, ["objective", "add", "reach preview",
        "--horizon", "fortnight", "--target", "2099-01-01", "--success", "it ships", "--stop", "if superseded"])).out;
    const id = printed.match(/\bo-[0-9a-z]{5}\b/)[0];
    const recorded = eventFor(id, "entity.confirmed");
    assert.deepEqual(recorded.payload.labels, ["objective"]);
    assert.equal(recorded.payload.priority, 10);
    assert.equal(recorded.payload.exposure, "full");
    assert.equal(recorded.payload.target, "2099-01-01");
    // The horizon enum is gone: whatever span the caller states is recorded.
    assert.equal(recorded.payload.horizon, "fortnight");
    assert.match((await must(box, demo, ["objective", "show", id])).out, /fortnight/);
});

test("B8: objective confirm and decline answer a proposal with entity events", async () =>
{
    const confirmedId = (await must(box, demo, ["objective", "add", "confirm me", "--proposed"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    assert.notEqual(eventFor(confirmedId, "entity.proposed"), undefined);
    await must(box, demo, ["objective", "confirm", confirmedId]);
    assert.ok((await shown(confirmedId)).includes("confirmed"));
    const declinedId = (await must(box, demo, ["objective", "add", "decline me", "--proposed"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    await must(box, demo, ["objective", "decline", declinedId, "--why", "off goal"]);
    assert.equal(eventFor(declinedId, "entity.retracted").payload.why, "off goal");
    assert.ok(!(await must(box, demo, ["objective"])).out.includes("decline me"));
});

let preview;

test("B9: objective revise supersedes with a new id carrying the links and target", async () =>
{
    preview = (await must(box, demo, ["objective", "add", "old target", "--target", "2099-03-01"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const printed = (await approved(["objective", "revise", preview, "--why", "slipped", "--target", "2099-06-30"], preview)).printed;
    const successor = receiptIn(printed).match(/\bo-[0-9a-z]{5}\b/)[0];
    assert.notEqual(successor, preview, "a revision kept the record id");
    assert.ok((await shown(preview)).includes(`superseded by: ${successor}`));
    const page = await shown(successor);
    assert.ok(page.includes("target: 2099-06-30"));
    assert.ok(page.includes(`link: supersedes ${preview}`));
    assert.ok(page.includes("placement: project · full · priority 10"));
    preview = successor;
});

test("B10: objective close maps reached to entity.done and dropped to entity.retired", async () =>
{
    const reached = (await must(box, demo, ["objective", "add", "land the tier"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const printed = await must(box, demo, ["objective", "close", reached, "--as", "reached"]);
    assert.match(printed.out, /entity\.done recorded/);
    assert.ok(!(await must(box, demo, ["objective"])).out.includes("land the tier"), "a reached objective still lists as open");
    const dropped = (await must(box, demo, ["objective", "add", "dead end"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    await approved(["objective", "close", dropped, "--as", "dropped", "--why", "descoped"], dropped);
    assert.equal(eventFor(dropped, "entity.retired").payload.why, "descoped");
});

let milestone;

test("B11: milestone add records entity.confirmed with criteria and its member-of grouping", async () =>
{
    milestone = (await must(box, demo, ["milestone", "add", "suite green", "--objective", preview,
        "--exit", "tests pass", "--exit", "docs updated"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    const recorded = eventFor(milestone, "entity.confirmed");
    assert.deepEqual(recorded.payload.labels, ["milestone"]);
    assert.equal(recorded.payload.priority, 20);
    assert.equal(recorded.payload.exposure, "index");
    assert.deepEqual(recorded.payload.criteria, ["tests pass", "docs updated"]);
    assert.deepEqual(recorded.payload.links, [{ type: "member-of", target: preview }]);
});

test("B12: met covers, reach is the gated done, revise supersedes, drop retires", async () =>
{
    assert.match((await must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "ran green"])).out,
        /entity\.covered recorded/);
    const early = await self(["milestone", "reach", milestone]);
    assert.notEqual(early.code, 0);
    assert.match(early.out, /uncovered exit criteria/);
    await must(box, demo, ["milestone", "met", milestone, "--criterion", "c2", "--why", "docs regenerated"]);
    assert.match((await must(box, demo, ["milestone", "reach", milestone])).out, /entity\.done recorded/);
    const revised = (await must(box, demo, ["milestone", "add", "next checkpoint", "--objective", preview, "--exit", "one thing"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    const successor = receiptIn((await approved(["milestone", "revise", revised, "--why", "widened", "--exit", "another thing"], revised)).printed).match(/\bm-[0-9a-z]{5}\b/)[0];
    assert.notEqual(successor, revised, "a revision kept the milestone id");
    assert.ok((await shown(revised)).includes(`superseded by: ${successor}`));
    assert.match((await approved(["milestone", "drop", successor, "--why", "checkpoint removed"], successor)).printed, /entity\.retired recorded/);
    assert.equal(eventFor(successor, "entity.retired").payload.why, "checkpoint removed");
});

test("B13: the work verbs record the entity lifecycle — add, propose, accept, decline, link, retire", async () =>
{
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "ship the cutover"])).out);
    assert.deepEqual(eventFor(work, "entity.confirmed").payload.labels, ["work"]);
    assert.equal(eventFor(work, "entity.confirmed").payload.exposure, "search");
    await must(box, demo, ["work", "link", work, "--objective", preview]);
    assert.deepEqual(eventFor(work, "entity.linked").payload.link, { type: "member-of", target: preview });
    assert.match((await must(box, demo, ["work", "show", work])).out, new RegExp(`Contributes to: ${preview}`));
    const proposal = workIdIn((await must(box, demo, ["work", "propose", "a proposed direction", "--objective", preview,
        "--value", "closes the gap", "--success", "it ships", "--stop", "if superseded",
        "--risk", "low", "--capacity", "one round", "--evidence-plan", "a recorded run",
        "--confidence", "high", "--expires", "2099-01-01"])).out);
    const brief = eventFor(proposal, "entity.proposed");
    assert.equal(brief.payload.value, "closes the gap");
    assert.equal(brief.payload.expires, "2099-01-01");
    await mustPerson(box, demo, ["work", "confirm", proposal]);
    assert.notEqual(events().find((event) => event.type === "entity.confirmed" && event.refs?.confirms === proposal), undefined);
    assert.ok((await must(box, demo, ["work"])).out.includes("a proposed direction"), "an accepted proposal did not become an open unit");
    const declined = workIdIn((await must(box, demo, ["work", "propose", "a declined direction", "--objective", preview,
        "--value", "little", "--success", "s", "--stop", "s",
        "--risk", "low", "--capacity", "one round", "--evidence-plan", "a run",
        "--confidence", "low", "--expires", "2099-01-01"])).out);
    await must(box, demo, ["work", "decline", declined, "--why", "not worth it"]);
    assert.equal(eventFor(declined, "entity.retracted").payload.why, "not worth it");
    await approved(["work", "retire", work, "--why", "moved", "--successor", proposal], work);
    const retired = eventFor(work, "entity.retired");
    assert.equal(retired.payload.successor, proposal);
    assert.match((await must(box, demo, ["work", "show", work])).out, /Retired: moved — successor/);
});

test("B14: work start/block/unblock/done record the phase 3 execution events through the shared gate", async () =>
{
    // The regression net for the gate itself is the unchanged phase 3 suite:
    // test/execution.test.mjs section B ("B: no reports and no done-time text
    // refuses…" through "B: a report carrying commit evidence satisfies
    // done") and test/lifecycle.test.mjs "the work spine: add, start, report,
    // evidenced done as a judgment". Here: the recorded event types.
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "exercise the spine"])).out);
    await must(box, demo, ["work", "start", work]);
    assert.notEqual(eventFor(work, "entity.started"), undefined);
    await must(box, demo, ["work", "block", work, "--on", "external", "--why", "vendor wait"]);
    assert.equal(eventFor(work, "entity.blocked").payload.on, "external");
    await must(box, demo, ["work", "unblock", work]);
    assert.notEqual(eventFor(work, "entity.unblocked"), undefined);
    await must(box, demo, ["work", "done", work, "--report", "landed and verified"]);
    assert.notEqual(eventFor(work, "entity.done"), undefined);
    const report = events().find((event) => event.type === "report.added" && event.refs?.work === work);
    assert.notEqual(report, undefined, "the done-time report did not land as report.added");
    assert.ok(!(await must(box, demo, ["work"])).out.includes("exercise the spine"), "a done unit still lists as open");
});

/* ── #408 K: a 0.11.0 CLI reading a store written here ─────────────── */

// Section K of the #408 case table is a claim about *another* CLI's fold, so
// it is asserted against that CLI rather than against a description of it: the
// tree at the merge base — 0.11.0 plus #405, the last commit before this
// issue — is checked out and built once here, and its `buildModel` is pointed
// at a store this branch's verbs wrote.
//
// `resolveBase` is the structure gate's own base resolution, so a checkout
// that cannot answer this fails loudly with the sentence that gate gives
// rather than quietly skipping the section.
const baseModel = await buildBaseCli();

async function buildBaseCli()
{
    const { resolveBase } = await import("./structure.mjs");
    const repo = fileURLToPath(new URL("../../..", import.meta.url));
    const base = resolveBase(undefined, repo);
    const root = mkdtempSync(join(tmpdir(), "self-0-11-"));
    const tar = execFileSync("git", ["archive", base, "apps/cli/src", "apps/cli/tsconfig.json", "apps/cli/package.json"],
        { cwd: repo, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(root, "base.tar"), tar);
    execFileSync("tar", ["-xf", join(root, "base.tar")], { cwd: root });
    const cli = join(root, "apps", "cli");
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(cli, "node_modules"));
    execFileSync(join(cli, "node_modules", ".bin", "tsc"), [], { cwd: cli, stdio: "inherit" });
    return (await import(pathToFileURL(join(cli, "dist", "model.js")).href)).buildModel;
}

const storeDir = join(box.root, "ws", ".superself");
const readHere = () => buildModel(storeDir, "demo", new Date());
const readThere = () => baseModel(storeDir, "demo", new Date());

// One unit carrying every shape section K is about: birth criteria with a
// `verify` map, a criterion declared afterwards and covered, and a criterion
// blocked and then released.
const mixed = { id: null };

async function mixedUnit()
{
    if (mixed.id === null)
    {
        mixed.id = workIdIn((await mustPerson(box, demo, ["work", "add", "the mixed-version unit",
            "--criteria", "declared at birth", "--criteria", "waited on",
            "--verify", "c1 the fixture regenerates"])).out);
        await must(box, demo, ["work", "start", mixed.id]);
        await must(box, demo, ["work", "criteria", "add", mixed.id, "declared afterwards"]);
        await must(box, demo, ["work", "cover", mixed.id, "--criterion", "c3", "--why", "judged here"]);
        await must(box, demo, ["work", "block", mixed.id, "--criterion", "c2", "--on", "external", "--why", "the vendor is silent"]);
        await must(box, demo, ["work", "block", mixed.id, "--on", "decision", "--why", "the unit's own block"]);
    }
    return mixed.id;
}

test("cell 91: payload.verify on a creation event is ignored there — the criteria read, the methods do not", async () =>
{
    const id = await mixedUnit();
    const there = readThere().entities.find((item) => item.id === id);
    assert.deepEqual(there.criteria, ["declared at birth", "waited on"]);
    assert.equal(there.verify, undefined, "the older fold grew a field for a key it does not read");
    assert.equal(readHere().entities.find((item) => item.id === id).criterionStates[0].verify,
        "the fixture regenerates", "this CLI lost the verification text it recorded");
});

test("cell 92: entity.criterion-declared is ignored there — k of n counts low", async () =>
{
    const id = await mixedUnit();
    assert.equal(readThere().entities.find((item) => item.id === id).criteria.length, 2);
    assert.equal(readHere().entities.find((item) => item.id === id).criteria.length, 3);
});

test("cell 93: a claim on a criterion it never read folds to nothing, so its done gate is looser", async () =>
{
    const id = await mixedUnit();
    const there = readThere().entities.find((item) => item.id === id);
    assert.deepEqual(there.covered.map((claim) => claim.criterion), [],
        "the older fold attached a claim to a criterion it never declared");
    const here = readHere().entities.find((item) => item.id === id);
    const openThere = there.criteria.filter((text) => !there.covered.some((claim) => claim.criterion === text));
    const openHere = here.criteria.filter((text) => !here.covered.some((claim) => claim.criterion === text));
    assert.ok(openThere.every((text) => openHere.includes(text)),
        "the older gate refuses a done this CLI would allow");
});

test("cell 94: the criterion block is ignored there, and the unit's own block is untouched", async () =>
{
    const id = await mixedUnit();
    const there = readThere().entities.find((item) => item.id === id);
    assert.equal(there.execution.status, "blocked");
    assert.equal(there.execution.on, "decision", "a criterion's block replaced the unit's own");
    assert.equal(there.execution.why, "the unit's own block");
    assert.equal(readHere().works.find((item) => item.id === id).blockedOn, "decision");
});

test("cell 95: an entity.covered `work cover` wrote folds normally there", async () =>
{
    const unit = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 95", "--criteria", "judged by the alias"])).out);
    await must(box, demo, ["work", "cover", unit, "--criterion", "c1", "--why", "the alias wrote it"]);
    const there = readThere().entities.find((item) => item.id === unit);
    assert.deepEqual(there.covered.map((claim) => claim.criterion), ["judged by the alias"]);
    assert.equal(there.covered[0].why, "the alias wrote it");
});

test("cell 96: a unit written before this issue declares what its creation payload declared, and no more", async () =>
{
    const id = "w-pre011";
    appendFileSync(log, JSON.stringify({
        id: "01hz00000000000000000k96a", ts: "2026-01-01T00:00:00.000Z", type: "entity.confirmed", project: "demo",
        refs: {}, origin: { actor: "human", confirmed: true },
        payload: { entity: id, text: "written by 0.11.0", labels: ["work"], links: [],
            criteria: ["the one it declared"], exposure: "search", scope: "project" }
    }) + "\n");
    await must(box, demo, ["fold"]);
    const here = readHere().entities.find((item) => item.id === id);
    assert.deepEqual(here.criteria, ["the one it declared"]);
    assert.deepEqual(here.criterionStates.map((item) => ({ id: item.id, text: item.text })),
        [{ id: "c1", text: "the one it declared" }]);
    const bare = "w-pre012";
    appendFileSync(log, JSON.stringify({
        id: "01hz00000000000000000k96b", ts: "2026-01-01T00:01:00.000Z", type: "entity.confirmed", project: "demo",
        refs: {}, origin: { actor: "human", confirmed: true },
        payload: { entity: bare, text: "declared nothing before this issue", labels: ["work"], links: [],
            criteria: [], exposure: "search", scope: "project" }
    }) + "\n");
    await must(box, demo, ["fold"]);
    await must(box, demo, ["work", "start", bare]);
    assert.equal((await selfIn(box, demo, ["work", "done", bare, "--report", "it verifiably happened"])).code, 0,
        "a unit that declares nothing is gated on something");
});
