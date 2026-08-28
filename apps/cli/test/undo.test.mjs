// A mistaken record is undone, not ceremonially superseded (#390).
//
// Every test here is one cell of docs/maintainers/case-tables/390-undo-review-settle.md,
// named by its cell number. The table is the review surface; a cell it lacks is
// a path nothing proves. Cells 66–78 live in `review-settle.test.mjs`; the
// cells this issue leaves unchanged are proved where they already were, and the
// table names those tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../dist/ids.js";
import { approvedIn, demoWorkspace, git, idIn, logFixture, machine, must, mustPerson, personIn, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

const logPath = (project = "demo") => join(ws, ".superself", "projects", project, "log.jsonl");

function events(project = "demo")
{
    return readFileSync(logPath(project), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

// The last event of a type, optionally about one record. Every cell that needs
// an event id that no receipt printed reads it back this way.
function lastEvent(type, entity)
{
    const found = events().filter((event) => event.type === type
        && (entity === undefined || event.payload.entity === entity || event.refs?.work === entity)).at(-1);
    assert.notEqual(found, undefined, `no ${type} for ${entity ?? "any record"}`);
    return found;
}

function annulmentsOf(id)
{
    return events().filter((event) => event.refs?.annuls === id);
}

// One appended line the pipeline would have written, for the kinds no verb in
// this tree produces any more. The undo refuses them by type, so nothing here
// depends on the fold making anything of them.
function fixture(type, payload, refs)
{
    return logFixture(ws, "demo", {
        id: ulid(),
        ts: new Date().toISOString(),
        type,
        origin: { actor: "agent", confirmed: false },
        project: "demo",
        payload,
        ...(refs === undefined ? {} : { refs })
    });
}

async function addUnit(outcome)
{
    return workIdIn((await mustPerson(box, demo, ["work", "add", outcome])).out);
}

async function context()
{
    return (await must(box, demo, ["context"])).out;
}

// A raw entity's own id, which is not the event id the receipt brackets.
function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    assert.notEqual(match, null, `no entity id in: ${text}`);
    return match[0];
}

// A second registered project, at its own checkout. `project init` reads the
// directory it stands in, so the cells that need one stand there.
async function newProject(slug)
{
    const dir = join(ws, slug);
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    await must(box, dir, ["project", "init", "--name", slug, "--desc", `${slug} project`]);
    return dir;
}

/* ── 3.1 which kinds an undo takes back ────────────────────────────── */

test("cell 1: undoing a proposal takes the plan back before a person ever reads it", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 1: cut the retry timeout"])).out);
    await must(box, demo, ["undo", lastEvent("entity.proposed", id).id]);
    assert.doesNotMatch((await must(box, demo, ["work"])).out, new RegExp(id));
    assert.doesNotMatch(await context(), new RegExp(id));
    assert.match((await must(box, demo, ["work", "show", id])).out, /- Status: undone/);
});

test("cell 2: undoing a work add takes the unit off every live surface", async () =>
{
    const id = await addUnit("cell 2: an outcome added with the wrong words");
    const page = join(ws, ".superself", "projects", "demo", "work", `${id}.md`);
    assert.ok(existsSync(page), "the unit never got a page to remove");
    await must(box, demo, ["undo", lastEvent("entity.confirmed", id).id]);
    assert.doesNotMatch((await must(box, demo, ["work"])).out, new RegExp(id));
    assert.ok(!existsSync(page), "the folded page survived the undo");
});

test("cell 3: undoing a decision that replaced nothing takes it out of context", async () =>
{
    const id = idIn((await must(box, demo, ["decide", "cell 3: a policy recorded by mistake"])).out);
    await must(box, demo, ["undo", id]);
    assert.doesNotMatch(await context(), /cell 3: a policy recorded by mistake/);
});

test("cell 4: undoing a convention takes the rule out of the conventions block", async () =>
{
    const id = idIn((await must(box, demo, ["convention", "add", "cell 4: a rule nobody agreed to"])).out);
    await must(box, demo, ["undo", id]);
    assert.doesNotMatch(await context(), /cell 4: a rule nobody agreed to/);
});

test("cell 5: undoing a goal that superseded another gives the predecessor back", async () =>
{
    const first = idIn((await must(box, demo, ["goal", "add", "cell 5: the direction that stood"])).out);
    const replacing = await approvedIn(box, demo,
        ["goal", "add", "cell 5: the direction typed in error", "--supersedes", first], first);
    await must(box, demo, ["undo", idIn(replacing.printed)]);
    const seen = await context();
    assert.match(seen, /cell 5: the direction that stood/);
    assert.doesNotMatch(seen, /cell 5: the direction typed in error/);
});

test("cell 6: undoing a confirm returns the plan to review and names the confirm line", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 6: pin the clock in the retry test"])).out);
    const confirmed = idIn((await mustPerson(box, demo, ["work", "confirm", id])).out);
    const undone = await must(box, demo, ["undo", confirmed]);
    assert.match(undone.out, new RegExp(`self work confirm ${id}`));
    assert.match((await must(box, demo, ["work", "show", id])).out, /- Status: review/);
});

test("cell 7: undoing a convention drop leaves the rule standing again", async () =>
{
    const id = idIn((await must(box, demo, ["convention", "add", "cell 7: a rule dropped in error"])).out);
    const dropped = await approvedIn(box, demo, ["convention", "drop", id, "--why", "dropped in error"], id);
    await must(box, demo, ["undo", idIn(dropped.printed)]);
    assert.match(await context(), /cell 7: a rule dropped in error/);
});

test("cell 8: undoing a retirement opens the unit again", async () =>
{
    const id = await addUnit("cell 8: an outcome given up too early");
    const retired = await approvedIn(box, demo, ["work", "retire", id, "--why", "given up early"], id);
    await must(box, demo, ["undo", idIn(retired.printed)]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", id])).out, /- Status: retired/);
});

test("cell 9: undoing a link takes the edge off the record", async () =>
{
    const objective = (await must(box, demo, ["objective", "add", "cell 9: the outcome the unit serves"])).out
        .match(/\bo-[0-9a-z]{5}\b/)[0];
    const id = await addUnit("cell 9: a unit linked to the wrong outcome");
    await must(box, demo, ["work", "link", id, "--objective", objective]);
    await must(box, demo, ["undo", lastEvent("entity.linked", id).id]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", id])).out, new RegExp(objective));
});

test("cell 10: undoing an unlink puts the edge back", async () =>
{
    const objective = (await must(box, demo, ["objective", "add", "cell 10: the outcome the edge points at"])).out
        .match(/\bo-[0-9a-z]{5}\b/)[0];
    const id = await addUnit("cell 10: a unit unlinked by mistake");
    await must(box, demo, ["work", "link", id, "--objective", objective]);
    await must(box, demo, ["work", "unlink", id, "--objective", objective]);
    await must(box, demo, ["undo", lastEvent("entity.unlinked", id).id]);
    assert.match((await must(box, demo, ["work", "show", id])).out, new RegExp(objective));
});

test("cell 11: undoing a revision makes the version before it current again", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 11: cut the timeout to 5s"])).out);
    await must(box, demo, ["work", "revise", id, "cell 11: cut the timeout to 3s", "--why", "5s still times out"]);
    const undone = await must(box, demo, ["undo", lastEvent("entity.revised", id).id]);
    assert.match(undone.out, /states its previous plan again/);
    assert.match((await must(box, demo, ["work", "show", id])).out, /cell 11: cut the timeout to 5s/);
});

test("cell 12: undoing a start unfreezes the plan", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 12: a plan picked up in error"])).out);
    await mustPerson(box, demo, ["work", "confirm", id]);
    await must(box, demo, ["work", "start", id]);
    await must(box, demo, ["undo", lastEvent("entity.started", id).id]);
    assert.match((await must(box, demo, ["work", "show", id])).out, /- Status: next/);
    // The freeze `work revise` reads is `startedOnce`, and it clears with the
    // start: a plan nobody picked up is revisable again.
    assert.equal((await selfIn(box, demo, ["work", "revise", id, "cell 12: a revised plan", "--why", "it changed"])).code, 0);
});

test("cell 13: undoing a block opens the unit again", async () =>
{
    const id = await addUnit("cell 13: a unit blocked by mistake");
    await must(box, demo, ["work", "block", id, "--on", "dependency", "--why", "waiting on nothing"]);
    await must(box, demo, ["undo", lastEvent("entity.blocked", id).id]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", id])).out, /- Status: blocked/);
});

test("cell 14: undoing an unblock leaves the unit blocked with its original reason", async () =>
{
    const id = await addUnit("cell 14: a unit unblocked too soon");
    await must(box, demo, ["work", "block", id, "--on", "external", "--why", "the vendor has not answered"]);
    await must(box, demo, ["work", "unblock", id]);
    await must(box, demo, ["undo", lastEvent("entity.unblocked", id).id]);
    const page = (await must(box, demo, ["work", "show", id])).out;
    assert.match(page, /- Status: blocked/);
    assert.match(page, /the vendor has not answered/);
});

test("cell 15: undoing a done opens the unit at the state before it", async () =>
{
    const id = await addUnit("cell 15: an outcome closed against the wrong unit");
    await must(box, demo, ["work", "done", id, "--report", "cell 15: what verifiably happened"]);
    await must(box, demo, ["undo", lastEvent("entity.done", id).id]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", id])).out, /- Status: done/);
});

test("cell 16: undoing a coverage claim opens the criterion again", async () =>
{
    const objective = (await must(box, demo, ["objective", "add", "cell 16: the outcome with a checkpoint"])).out
        .match(/\bo-[0-9a-z]{5}\b/)[0];
    const milestone = (await must(box, demo, ["milestone", "add", "cell 16: the checkpoint", "--objective", objective,
        "--exit", "the proof passes", "--exit", "the docs regenerate"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    await must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "the proof passed"]);
    assert.match((await must(box, demo, ["milestone", "show", milestone])).out, /the proof passed/);
    await must(box, demo, ["undo", lastEvent("entity.covered", milestone).id]);
    assert.doesNotMatch((await must(box, demo, ["milestone", "show", milestone])).out, /the proof passed/);
});

test("cell 17: undoing a placement puts the record back where it was", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "cell 17: a record placed by mistake"])).out);
    const before = (await must(box, demo, ["state", "show", id])).out;
    await must(box, demo, ["state", "place", id, "--priority", "3"]);
    assert.notEqual((await must(box, demo, ["state", "show", id])).out, before);
    await must(box, demo, ["undo", lastEvent("entity.placed", id).id]);
    assert.equal((await must(box, demo, ["state", "show", id])).out, before);
});

test("cell 18: undoing a report takes it off the unit and out of the friction record", async () =>
{
    const id = await addUnit("cell 18: a unit a report was filed against by mistake");
    await must(box, demo, ["report", id, "cell 18: the wrong unit's report", "--friction", "cell 18 friction"]);
    assert.match((await must(box, demo, ["work", "show", id])).out, /cell 18: the wrong unit's report/);
    await must(box, demo, ["undo", lastEvent("report.added", id).id]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", id])).out, /cell 18: the wrong unit's report/);
});

test("cell 19: undo --supersession leaves the successor standing and gives the predecessor back", async () =>
{
    const first = idIn((await must(box, demo, ["decide", "cell 19: the standing policy"])).out);
    const replacing = await approvedIn(box, demo, ["decide", "cell 19: the addition", "--supersedes", first], first);
    await must(box, demo, ["undo", idIn(replacing.printed), "--supersession"]);
    const seen = await context();
    assert.match(seen, /cell 19: the standing policy/);
    assert.match(seen, /cell 19: the addition/);
});

test("cell 20: undo without --supersession takes the successor back as well", async () =>
{
    const first = idIn((await must(box, demo, ["decide", "cell 20: the policy that held"])).out);
    const replacing = await approvedIn(box, demo, ["decide", "cell 20: the replacement typed in error", "--supersedes", first], first);
    await must(box, demo, ["undo", idIn(replacing.printed)]);
    const seen = await context();
    assert.match(seen, /cell 20: the policy that held/);
    assert.doesNotMatch(seen, /cell 20: the replacement typed in error/);
});

/* ── 3.2 which kinds are refused, and by what name ─────────────────── */

async function refusedUndo(id)
{
    const before = events().length;
    const refused = await selfIn(box, demo, ["undo", id]);
    assert.notEqual(refused.code, 0, refused.out);
    assert.equal(events().length, before, "a refused undo appended anyway");
    return refused.out;
}

// Cell 21 read "undoing a person's ruling on a design report is refused". #400
// took that refusal off the list: it rested on the ruling being a person's, and
// a session records the same ruling now — so a design approved against the
// wrong unit is taken back like any other mistake. What guards it instead is
// cell 44 of the #400 table, in agent-consent.test.mjs: an approval a dispatch
// stood on is refused with the list.
test("cell 21: a design approval nothing was built on is undone, and the design reads unapproved", async () =>
{
    const approval = fixture("report.confirmed", { digest: "sha256:cell21" }, { work: "w-cell21", confirms: "r-cell21" });
    const undone = await selfIn(box, demo, ["undo", approval]);
    assert.equal(undone.code, 0, undone.out);
    assert.equal(events().at(-1).refs.annuls, approval);
});

test("cell 22: undoing an artifact registration is refused, naming artifact prune", async () =>
{
    const out = await refusedUndo(fixture("artifact.registered", { artifact: "a-cell22" }));
    assert.match(out, /self artifact prune a-cell22 --why w/);
});

test("cell 23: undoing a prune is refused — nothing takes back a deletion", async () =>
{
    assert.match(await refusedUndo(fixture("artifact.pruned", { artifact: "a-cell23" })), /nothing takes back a deletion/);
});

// Cell 24 (`project.archived`) is proved unchanged by
// `project-archive.test.mjs` cell 16, which asserts the same refusal names
// `self project restore`.

test("cell 25: undoing a project restore is refused, naming project archive", async () =>
{
    assert.match(await refusedUndo(fixture("project.restored", {})), /self project archive demo/);
});

test("cell 26: undoing process telemetry is refused — a process really ran", async () =>
{
    assert.match(await refusedUndo(fixture("work.run-started", { work: "w-cell26" })), /a process really ran/);
});

test("cell 27: an undo is not undone", async () =>
{
    const id = idIn((await must(box, demo, ["decide", "cell 27: a decision taken back once"])).out);
    await must(box, demo, ["undo", id]);
    assert.match(await refusedUndo(annulmentsOf(id)[0].id), /an undo is not undone/);
});

test("cell 28: an older log's entity.restored is refused the same way", async () =>
{
    assert.match(await refusedUndo(fixture("entity.restored", { entity: "w-cell28" }, { annuls: ulid() })),
        /an undo is not undone/);
});

test("cell 29: a legacy event predating the record grammar is refused by name", async () =>
{
    assert.match(await refusedUndo(fixture("goal.set", { text: "cell 29: a legacy goal line" })),
        /predates the record grammar/);
});

test("cell 30: an id no log holds is refused as an unknown prefix", async () =>
{
    const refused = await selfIn(box, demo, ["undo", "01zzzzzzzzzzzzzzzzzzzzzzzz"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no event matches id prefix/);
});

test("cell 31: an ambiguous id prefix is refused as ambiguous", async () =>
{
    const refused = await selfIn(box, demo, ["undo", "0"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is ambiguous/);
});

test("cell 31a: an event another project's log holds is refused by naming that project", async () =>
{
    const other = await newProject("cell31a");
    const there = idIn((await must(box, other, ["decide", "cell 31a: a decision recorded next door"])).out);
    const refused = await selfIn(box, demo, ["undo", there]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is an event in project "cell31a", not in "demo"/);
});

/* ── 3.3 settled, dependents, and the invocation ───────────────────── */

test("cell 32: the bare form takes back the newest append and names the record", async () =>
{
    const id = await addUnit("cell 32: an outcome undone with no id to look up");
    const undone = await must(box, demo, ["undo"]);
    assert.match(undone.out, new RegExp(id));
    assert.match((await must(box, demo, ["work", "show", id])).out, /- Status: undone/);
});

test("cell 33: the full event id takes back the same append the bare form would", async () =>
{
    const id = await addUnit("cell 33: an outcome undone by its full event id");
    await must(box, demo, ["undo", lastEvent("entity.confirmed", id).id]);
    assert.match((await must(box, demo, ["work", "show", id])).out, /- Status: undone/);
});

// The design's cell said five characters. Two ulids minted in one session share
// their whole timestamp half, so a five-character prefix is ambiguous by
// construction — cell 31 is what proves the ambiguity refusal, and this cell
// proves an unambiguous prefix resolves.
test("cell 34: an unambiguous id prefix resolves through findEventByPrefix", async () =>
{
    const id = await addUnit("cell 34: an outcome undone by a prefix");
    const event = lastEvent("entity.confirmed", id).id;
    await must(box, demo, ["undo", event.slice(0, 20)]);
    assert.match((await must(box, demo, ["work", "show", id])).out, /- Status: undone/);
});

test("cell 35: a settled record is still undoable — settled is not a lock", async () =>
{
    const id = await addUnit("cell 35: an outcome undone after the log moved on");
    await must(box, demo, ["decide", "cell 35: an unrelated decision that settles it"]);
    await must(box, demo, ["undo", lastEvent("entity.confirmed", id).id]);
    assert.match((await must(box, demo, ["work", "show", id])).out, /- Status: undone/);
});

test("cell 36: a record a report was filed against is refused with the report listed", async () =>
{
    const id = await addUnit("cell 36: an outcome a report already names");
    await must(box, demo, ["report", id, "cell 36: the report that stands on it"]);
    const refused = await selfIn(box, demo, ["undo", lastEvent("entity.confirmed", id).id]);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /was built on — 1 event names it/);
    assert.match(refused.out, /report\.added/);
    assert.match(refused.out, /take them back first, newest first/);
});

test("cell 37: a record that was started since is refused with the start listed", async () =>
{
    const id = await addUnit("cell 37: an outcome somebody picked up");
    await must(box, demo, ["work", "start", id]);
    const refused = await selfIn(box, demo, ["undo", lastEvent("entity.confirmed", id).id]);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /entity\.started/);
});

test("cell 38: undoing a start under a later done is refused with the done listed", async () =>
{
    const id = await addUnit("cell 38: an outcome started and then finished");
    await must(box, demo, ["work", "start", id]);
    const started = lastEvent("entity.started", id).id;
    await must(box, demo, ["work", "done", id, "--report", "cell 38: what verifiably happened"]);
    const refused = await selfIn(box, demo, ["undo", started]);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /entity\.done/);
});

test("cell 39: undoing a start under a later report is refused — d3 over-refuses on purpose", async () =>
{
    const id = await addUnit("cell 39: an outcome started and then reported on");
    await must(box, demo, ["work", "start", id]);
    const started = lastEvent("entity.started", id).id;
    await must(box, demo, ["report", id, "cell 39: the report that followed the start"]);
    const refused = await selfIn(box, demo, ["undo", started]);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /report\.added/);
});

test("cell 40: undoing a proposal its acceptance answered is refused, naming the acceptance", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 40: a plan somebody accepted"])).out);
    const proposal = lastEvent("entity.proposed", id).id;
    await mustPerson(box, demo, ["work", "confirm", id]);
    const refused = await selfIn(box, demo, ["undo", proposal]);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /entity\.confirmed/);
});

test("cell 41: undoing a report a swept proposal cites is refused, naming the proposal", async () =>
{
    const said = "cell 41: the same thing kept going wrong";
    for (let index = 0; index < 3; index += 1)
    {
        const unit = await addUnit(`cell 41: outcome ${index}`);
        await must(box, demo, ["report", unit, `cell 41: report ${index}`, "--friction", said]);
    }
    const cited = lastEvent("report.added").id;
    await must(box, demo, ["sweep", "--record"]);
    const refused = await selfIn(box, demo, ["undo", cited]);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /entity\.proposed/);
});

test("cell 42: undoing a decision another is sequenced behind is refused", async () =>
{
    const first = idIn((await must(box, demo, ["decide", "cell 42: the decision that comes first"])).out);
    await must(box, demo, ["decide", "cell 42: the decision behind it", "--after", first]);
    const refused = await selfIn(box, demo, ["undo", first]);
    assert.equal(refused.code, 2, refused.out);
});

test("cell 43: undoing a decision a design approval cites is refused", async () =>
{
    const decision = idIn((await must(box, demo, ["decide", "cell 43: the decision a design implements"])).out);
    fixture("report.confirmed", { digest: "sha256:cell43" }, { work: "w-cell43", implements: [decision] });
    const refused = await selfIn(box, demo, ["undo", decision]);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /report\.confirmed/);
});

test("cell 44: a dependent that is itself annulled is not a dependent", async () =>
{
    const id = await addUnit("cell 44: an outcome whose only dependent was taken back");
    const creation = lastEvent("entity.confirmed", id).id;
    await must(box, demo, ["report", id, "cell 44: a report filed and then taken back"]);
    await must(box, demo, ["undo", lastEvent("report.added", id).id]);
    await must(box, demo, ["undo", creation]);
    assert.match((await must(box, demo, ["work", "show", id])).out, /- Status: undone/);
});

test("cell 45: the bare form with nothing ever recorded names the id form", async () =>
{
    const other = await newProject("cell45");
    const refused = await selfIn(box, other, ["undo"]);
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /nothing has been recorded in "cell45"/);
    assert.match(refused.out, /self undo <event-id>/);
});

// The design described a refusal. The bare form has exactly one meaning — the
// newest append — and refusing it in the settled case would leave the
// ergonomic payoff with no spelling at all.
test("cell 46: the bare form after a second append takes back the newer one", async () =>
{
    const first = await addUnit("cell 46: the outcome recorded first");
    const second = await addUnit("cell 46: the outcome recorded second");
    await must(box, demo, ["undo"]);
    assert.match((await must(box, demo, ["work", "show", second])).out, /- Status: undone/);
    assert.doesNotMatch((await must(box, demo, ["work", "show", first])).out, /- Status: undone/);
});

test("cell 47: a second undo of the same event is refused, and one annulment stays in the log", async () =>
{
    const id = await addUnit("cell 47: an outcome somebody tried to undo twice");
    const creation = lastEvent("entity.confirmed", id).id;
    await must(box, demo, ["undo", creation]);
    const again = await selfIn(box, demo, ["undo", creation]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /was already undone/);
    assert.equal(annulmentsOf(creation).length, 1);
});

test("cell 48: undoing the done of a work done --report takes the report with it", async () =>
{
    const id = await addUnit("cell 48: an outcome closed with its evidence");
    await must(box, demo, ["work", "done", id, "--report", "cell 48: the evidence for a done that never happened"]);
    const done = lastEvent("entity.done", id).id;
    const report = lastEvent("report.added", id).id;
    await must(box, demo, ["undo", done]);
    const page = (await must(box, demo, ["work", "show", id])).out;
    assert.doesNotMatch(page, /- Status: done/);
    assert.doesNotMatch(page, /cell 48: the evidence for a done that never happened/);
    // One annulment per member, never two for the one the caller named: the
    // unit is a set of events, not a list a re-read can double.
    assert.equal(annulmentsOf(done).length, 1);
    assert.equal(annulmentsOf(report).length, 1);
});

test("cell 49: undoing the report of a work done --report takes the done with it", async () =>
{
    const id = await addUnit("cell 49: an outcome closed with its evidence, undone the other way");
    await must(box, demo, ["work", "done", id, "--report", "cell 49: the evidence"]);
    await must(box, demo, ["undo", lastEvent("report.added", id).id]);
    const page = (await must(box, demo, ["work", "show", id])).out;
    assert.doesNotMatch(page, /- Status: done/);
    assert.doesNotMatch(page, /cell 49: the evidence/);
});

test("cell 50: undoing an acceptance takes its grouping edge with it", async () =>
{
    const objective = (await must(box, demo, ["objective", "add", "cell 50: the outcome the plan serves"])).out
        .match(/\bo-[0-9a-z]{5}\b/)[0];
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 50: a plan toward that outcome",
        "--objective", objective, "--value", "closes the gap", "--success", "it ships", "--stop", "if superseded",
        "--risk", "low", "--capacity", "one round", "--evidence-plan", "a recorded run",
        "--confidence", "high", "--expires", "2099-01-01"])).out);
    const accepted = idIn((await mustPerson(box, demo, ["work", "confirm", id])).out);
    const linked = lastEvent("entity.linked", id).id;
    assert.equal(events().filter((event) => event.refs?.batch === lastEvent("entity.confirmed", id).refs?.batch).length, 2);
    await must(box, demo, ["undo", accepted]);
    const page = (await must(box, demo, ["work", "show", id])).out;
    assert.match(page, /- Status: review/);
    assert.doesNotMatch(page, new RegExp(objective));
    assert.equal(annulmentsOf(accepted).length, 1);
    assert.equal(annulmentsOf(linked).length, 1);
});

// Added during implementation. #389 landed after this design was written: a
// superseding plan's acceptance writes `entity.confirmed` + `entity.retired`
// as one append under one typed confirmation, and both halves must come back.
test("cell 50a: undoing the acceptance of a superseding plan opens the unit it retired", async () =>
{
    const target = await addUnit("cell 50a: the outcome a correction replaced");
    const plan = workIdIn((await must(box, demo, ["work", "propose", "cell 50a: the outcome, stated correctly",
        "--supersedes", target, "--why", "the first wording was wrong"])).out);
    const accepted = await approvedIn(box, demo, ["work", "confirm", plan], target);
    assert.equal(accepted.code, 0, accepted.out);
    assert.match((await must(box, demo, ["work", "show", target])).out, /- Status: retired/);
    const confirm = lastEvent("entity.confirmed", plan).id;
    const retired = lastEvent("entity.retired", target).id;
    await must(box, demo, ["undo", confirm]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", target])).out, /- Status: retired/);
    assert.match((await must(box, demo, ["work", "show", plan])).out, /- Status: review/);
    assert.equal(annulmentsOf(confirm).length, 1);
    assert.equal(annulmentsOf(retired).length, 1);
});

test("cell 51: undoing one half of a cap-driven placement pair takes both", async () =>
{
    const admitted = entityIn((await must(box, demo, ["state", "add", "cell 51: the record making room"])).out);
    const demoted = entityIn((await must(box, demo, ["state", "add", "cell 51: the record that moved down"])).out);
    const batch = ulid();
    const first = ulid();
    logFixture(ws, "demo", {
        id: first, ts: new Date().toISOString(), type: "entity.placed",
        origin: { actor: "agent", confirmed: false }, project: "demo",
        payload: { entity: admitted, priority: 1 }, refs: { batch }
    });
    logFixture(ws, "demo", {
        id: ulid(), ts: new Date().toISOString(), type: "entity.placed",
        origin: { actor: "agent", confirmed: false }, project: "demo",
        payload: { entity: demoted, priority: 9 }, refs: { batch, admits: admitted }
    });
    await must(box, demo, ["undo", first]);
    assert.equal(events().filter((event) => event.type === "entity.annulled").at(-1).refs.batch !== undefined, true);
    assert.doesNotMatch((await must(box, demo, ["state", "show", demoted])).out, /p9/);
});

test("cell 52: an event carrying no batch id is a unit of one", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "cell 52: a record recorded on its own"])).out);
    assert.equal(lastEvent("entity.confirmed", id).refs?.batch, undefined);
    await must(box, demo, ["undo", lastEvent("entity.confirmed", id).id]);
    assert.equal(annulmentsOf(lastEvent("entity.confirmed", id).id).length, 1);
});

test("cell 52a: undoing one swept proposal leaves the others standing", async () =>
{
    const dir = await newProject("cell52a");
    const clusters = ["the deploy credentials expired midway", "the golden fixture needed regenerating by hand"];
    for (const said of clusters)
    {
        for (let index = 0; index < 3; index += 1)
        {
            const unit = workIdIn((await mustPerson(box, dir, ["work", "add", `cell 52a outcome ${said} ${index}`])).out);
            await must(box, dir, ["report", unit, `cell 52a report ${index}`, "--friction", said]);
        }
    }
    // The sweep reads the whole workspace's friction, so it may record more
    // clusters than this cell created. What the cell is about is the append:
    // several unrelated proposals, written once, undone one at a time.
    const recorded = await must(box, dir, ["sweep", "--record"]);
    const swept = events("cell52a").filter((event) => event.type === "entity.proposed" && event.refs?.friction !== undefined);
    assert.ok(swept.length >= 2, `the sweep did not record two clusters:\n${recorded.out}`);
    assert.equal(swept[0].refs.batch, swept[1].refs.batch, "the sweep's proposals were not one append");
    await must(box, dir, ["undo", swept[0].id]);
    const after = events("cell52a");
    assert.equal(after.filter((event) => event.refs?.annuls === swept[0].id).length, 1);
    assert.equal(after.filter((event) => event.refs?.annuls === swept[1].id).length, 0,
        "the other swept proposal was annulled too");
});

test("cell 52b: undoing one withdrawal of a reviewed set leaves the others standing", async () =>
{
    const ids = [];
    for (let index = 0; index < 3; index += 1)
    {
        ids.push(idIn((await must(box, demo, ["convention", "add", `cell 52b: rule ${index}`])).out));
    }
    const plan = join(demo, "cell52b.txt");
    writeFileSync(plan, ids.map((id) => `convention drop ${id} --why "dropped as a set"`).join("\n") + "\n");
    const applied = await approvedIn(box, demo, ["apply", plan], "retract 3");
    assert.equal(applied.code, 0, applied.out);
    const dropped = events().filter((event) => event.type === "entity.retracted" && ids.includes(event.payload.entity));
    assert.equal(dropped.length, 3);
    assert.equal(new Set(dropped.map((event) => event.refs.batch)).size, 1, "the set was not one append");
    await must(box, demo, ["undo", dropped[0].id]);
    assert.equal(annulmentsOf(dropped[1].id).length, 0, "an unrelated withdrawal in the set was annulled");
    const seen = await context();
    assert.match(seen, /cell 52b: rule 0/);
    assert.doesNotMatch(seen, /cell 52b: rule 1/);
});

test("cell 52c: an undo inside a reviewed set is refused before anything is dispatched", async () =>
{
    const id = idIn((await must(box, demo, ["decide", "cell 52c: a decision named inside a set"])).out);
    const plan = join(demo, "cell52c.txt");
    writeFileSync(plan, `undo ${id}\n`);
    const refused = await selfIn(box, demo, ["apply", plan]);
    assert.notEqual(refused.code, 0, refused.out);
    assert.equal(annulmentsOf(id).length, 0);
});

/* ── 3.4 what every reader answers afterwards ──────────────────────── */

// One undone unit, and the readers that must agree about it. Minted on first
// use rather than at module scope: a top-level `await` yields, and the test
// runner starts the first case in that gap — two `self` calls sharing the
// driver's globals is exactly what its overlap guard refuses.
const undoneOutcome = "cell 53: an outcome that never held";
let undoneMinted = null;

async function undoneUnitId()
{
    if (undoneMinted === null)
    {
        const id = await addUnit(undoneOutcome);
        await must(box, demo, ["undo", lastEvent("entity.confirmed", id).id]);
        undoneMinted = id;
    }
    return undoneMinted;
}

test("cell 53: an undone unit is not in the work listing", async () =>
{
    const undoneUnit = await undoneUnitId();
    assert.doesNotMatch((await must(box, demo, ["work"])).out, new RegExp(undoneUnit));
});

test("cell 54: an undone unit is absent from every section of context", async () =>
{
    const undoneUnit = await undoneUnitId();
    assert.doesNotMatch(await context(), new RegExp(undoneUnit));
});

test("cell 55: an undone unit still answers by id, saying it is undone and when", async () =>
{
    const page = (await must(box, demo, ["work", "show", await undoneUnitId()])).out;
    assert.match(page, /- Status: undone/);
    assert.match(page, /- Undone: \d{4}-\d{2}-\d{2}/);
});

test("cell 56: the record's history shows both halves and marks the one taken back", async () =>
{
    const page = (await must(box, demo, ["work", "show", await undoneUnitId(), "--history"])).out;
    assert.match(page, /· undone/);
    assert.match(page, /entity\.annulled/);
    assert.match(page, /undone entity\.confirmed/);
});

test("cell 57: the log shows both halves and marks the one taken back", async () =>
{
    const page = (await must(box, demo, ["log", "-n", "400"])).out;
    assert.match(page, /· undone/);
    assert.match(page, /entity\.annulled/);
});

test("cell 58: an undone unit is not a search hit", async () =>
{
    assert.doesNotMatch((await must(box, demo, ["search", undoneOutcome])).out, new RegExp(await undoneUnitId()));
});

test("cell 59: an undone unit is refused as a handoff subject", async () =>
{
    const refused = await selfIn(box, demo, ["handoff", await undoneUnitId()]);
    assert.notEqual(refused.code, 0, refused.out);
});

test("cell 60: the undone unit's folded page is gone and state.md does not mention it", async () =>
{
    const undoneUnit = await undoneUnitId();
    assert.ok(!existsSync(join(ws, ".superself", "projects", "demo", "work", `${undoneUnit}.md`)));
    assert.doesNotMatch(readFileSync(join(ws, ".superself", "projects", "demo", "state.md"), "utf8"),
        new RegExp(undoneUnit));
});

test("cell 61: a second fold of the same log answers identically", async () =>
{
    const undoneUnit = await undoneUnitId();
    const before = (await must(box, demo, ["work", "show", undoneUnit])).out;
    await must(box, demo, ["fold"]);
    assert.equal((await must(box, demo, ["work", "show", undoneUnit])).out, before);
});

test("cell 62: a shuffled log folds a creation's annulment to the same state", async () =>
{
    const id = await addUnit("cell 62: an outcome undone in a log a merge reordered");
    await must(box, demo, ["undo", lastEvent("entity.confirmed", id).id]);
    const inOrder = (await must(box, demo, ["work", "show", id])).out;
    const lines = readFileSync(logPath(), "utf8").trim().split("\n");
    // A union merge orders by neither time nor dependency: put the annulment
    // above the creation it reverses and read the same question again.
    writeFileSync(logPath(), [lines.at(-1), ...lines.slice(0, -1)].join("\n") + "\n");
    assert.equal((await must(box, demo, ["work", "show", id])).out, inOrder);
});

// Byte-identical folding for a log written before this issue: the same
// `entity.restored` line, folding to the same state it always did.
test("cell 62a: an older log's entity.restored still folds to the narrow supersession undo", async () =>
{
    const first = idIn((await must(box, demo, ["decide", "cell 62a: the policy a legacy undo gave back"])).out);
    const replacing = await approvedIn(box, demo, ["decide", "cell 62a: the legacy replacement", "--supersedes", first], first);
    fixture("entity.restored", { entity: first, why: "the legacy spelling of an undo" },
        { annuls: idIn(replacing.printed) });
    const seen = await context();
    assert.match(seen, /cell 62a: the policy a legacy undo gave back/);
    assert.match(seen, /cell 62a: the legacy replacement/);
});

test("cell 63: an undone unit's artifact is not pruned", async () =>
{
    const file = join(demo, "cell63.md");
    writeFileSync(file, "# cell 63\n\nthe document the unit attached\n");
    git(box, demo, ["add", "cell63.md"]);
    const id = await addUnit("cell 63: an outcome that attached a document");
    await must(box, demo, ["report", id, "cell 63: the report carrying the document", "--artifact", file]);
    const listed = (await must(box, demo, ["artifact", "list"])).out;
    await must(box, demo, ["undo", lastEvent("report.added", id).id]);
    assert.equal((await must(box, demo, ["artifact", "list"])).out, listed);
});

test("cell 64: a done taken back leaves the completion gate reading the reports that stand", async () =>
{
    const id = await addUnit("cell 64: an outcome closed and reopened");
    await must(box, demo, ["work", "done", id, "--report", "cell 64: the evidence"]);
    await must(box, demo, ["undo", lastEvent("entity.done", id).id]);
    // The report went back with the done, so the gate asks for evidence again.
    const page = (await must(box, demo, ["work", "show", id])).out;
    assert.doesNotMatch(page, /cell 64: the evidence/);
    assert.doesNotMatch(page, /- Status: done/);
});

test("cell 65: an undone unit's branch is not counted as unshipped", async () =>
{
    const id = await addUnit("cell 65: an outcome whose branch never mattered");
    await must(box, demo, ["undo", lastEvent("entity.confirmed", id).id]);
    assert.doesNotMatch((await must(box, demo, ["status"])).out, new RegExp(id));
});

test("an undone record's own annulment carries no person's mark", async () =>
{
    const id = idIn((await must(box, demo, ["decide", "an annulment asserts nothing"])).out);
    await must(box, demo, ["undo", id]);
    // An undo removes an effect and asserts none, so claiming a person's
    // confirmation on it would be a false claim the fold reads (#390 §4.1).
    assert.equal(annulmentsOf(id)[0].origin.confirmed, false);
});
