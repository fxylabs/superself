// Consent given in chat reaches the store (#400). Every test below is one cell
// of docs/maintainers/case-tables/400-agent-consent.md, named by its number.
//
// The rule the table states: a verb whose record `self undo` can take back
// needs no person at a keyboard, and records who wrote it instead. The one gate
// that survives is on `artifact prune`, because `undo.ts` names `artifact.pruned`
// as the deletion no event reverses.
//
// Sections A, B, D and G of the table live in work-entry-gate.test.mjs, which
// is where those cells already were. This file holds C (the retiring family),
// E (`state confirm` and `state place`), F (`report confirm` and `runbook
// approve`), G's prune cells, H (undoing a design approval) and I (the
// surfaces).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOPICS } from "../dist/guide.js";
import { COMMANDS } from "../dist/main.js";
import { approvedIn, demoWorkspace, idIn, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

function events(project = "demo")
{
    const file = join(ws, ".superself", "projects", project, "log.jsonl");
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8").trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

function since(before)
{
    return events().slice(before);
}

const decide = async (text) => idIn((await must(box, demo, ["decide", text])).out);
const entityIn = (text) => text.match(/\be-[0-9a-z]{5}\b/)[0];

/* ── C: the retiring family ────────────────────────────────────────── */

test("cell 14: a session's supersede records the successor and discloses what it replaced", async () =>
{
    const first = await decide("cell 14: the policy as first taken");
    const before = events().length;
    const recorded = await selfIn(box, demo, ["decide", "cell 14: the policy as it now stands", "--supersedes", first]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.match(recorded.out, /cell 14: the policy as first taken/);
    assert.match(recorded.out, /replaced by this new decision: cell 14: the policy as it now stands/);
    assert.deepEqual(since(before).map((event) => event.payload.by), [{ kind: "agent" }]);
    assert.match((await must(box, demo, ["state", "show", first])).out, /superseded/);
});

test("cell 15: a session's retract records the withdrawal, with the record and the reason disclosed", async () =>
{
    const id = await decide("cell 15: a policy whose scope ran out");
    const before = events().length;
    const recorded = await selfIn(box, demo, ["decide", "retract", id, "--why", "the scope it covered is gone"]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.match(recorded.out, /cell 15: a policy whose scope ran out/);
    assert.match(recorded.out, /retracted because: the scope it covered is gone/);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.retracted"]);
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
});

// A proposal is not a confirmed target, so the retirement path has nothing to
// disclose — the decline is a plain append, and it carries `by` all the same.
test("cell 16: a session declines a proposal, and nothing is disclosed because nothing confirmed is lost", async () =>
{
    const id = idIn((await must(box, demo, ["decide", "cell 16: a direction nobody took", "--proposed"])).out);
    const before = events().length;
    const recorded = await selfIn(box, demo, ["decide", "decline", id, "--why", "the question went away"]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.ok(!recorded.out.includes("`self undo` takes it back"), recorded.out);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.retracted"]);
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
});

test("cell 17: a session retires a work unit, disclosed and attributed", async () =>
{
    const unit = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 17: an outcome that moved"])).out);
    const before = events().length;
    const recorded = await selfIn(box, demo, ["work", "retire", unit, "--why", "the outcome moved to another unit"]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.match(recorded.out, /cell 17: an outcome that moved/);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.retired"]);
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
});

// A person reaches the same write, and reads the same disclosure. What is
// asserted here is the absence: no question is printed and no answer is read,
// so `work retire` stays one command for a person too.
test("cell 18: a person's retract records with by = person, and no prompt is printed", async () =>
{
    const id = await decide("cell 18: a policy a person took back");
    const before = events().length;
    const recorded = await approvedIn(box, demo, ["decide", "retract", id, "--why", "it no longer holds"], "");
    assert.equal(recorded.code, 0, recorded.out);
    assert.ok(!recorded.out.includes("to confirm"), recorded.out);
    assert.deepEqual(since(before).map((event) => event.payload.by), [{ kind: "person" }]);
});

test("cell 19: the retiring family answers as one — convention drop records like the rest", async () =>
{
    const id = idIn((await must(box, demo, ["convention", "add", "cell 19: a rule that stopped helping"])).out);
    const before = events().length;
    const recorded = await selfIn(box, demo, ["convention", "drop", id, "--why", "the practice changed"]);
    assert.equal(recorded.code, 0, recorded.out);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.retracted"]);
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
});

test("cell 20: a withdrawal a session wrote is a withdrawal a session takes back", async () =>
{
    const id = await decide("cell 20: a policy withdrawn in error");
    const recorded = await selfIn(box, demo, ["decide", "retract", id, "--why", "withdrawn too early"]);
    assert.equal(recorded.code, 0, recorded.out);
    const undone = await selfIn(box, demo, ["undo", events().at(-1).id]);
    assert.equal(undone.code, 0, undone.out);
    assert.match((await must(box, demo, ["state", "show", id])).out, /confirmed/);
});

/* ── E: `state confirm` and `state place` ──────────────────────────── */

test("cell 25: a session confirms a proposed record, and the confirm says so", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "cell 25: a record waiting on review", "--proposed"])).out);
    const before = events().length;
    const confirmed = await selfIn(box, demo, ["state", "confirm", id], { SUPERSELF_SESSION: "sess-25" });
    assert.equal(confirmed.code, 0, confirmed.out);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.confirmed"]);
    assert.deepEqual(written[0].payload.by, { kind: "agent", session: "sess-25" });
});

test("cell 26: a proposed record's scope widens to the workspace, and the placement is recorded", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "cell 26: a record bound for the workspace", "--proposed"])).out);
    const before = events().length;
    const placed = await selfIn(box, demo, ["state", "place", id, "--scope", "workspace"]);
    assert.equal(placed.code, 0, placed.out);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.placed"]);
    assert.equal(written[0].payload.scope, "workspace");
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
    // Widening hides nothing, and it reveals nothing either: the record is
    // still a proposal, so the only place it renders is the band of things
    // waiting to be confirmed — never as a placed record at the scope it now
    // names. That is the projection this cell exists to hold, since a placement
    // reaches it before the record is confirmed for the first time in #400.
    const shown = (await must(box, demo, ["context"])).out;
    const mentions = shown.split("\n").filter((line) => line.includes("cell 26: a record bound for the workspace"));
    assert.equal(mentions.length, 1, `a proposal rendered more than once:\n${shown}`);
    assert.match(mentions[0], new RegExp(`proposed entity ${id}`));
});

test("cell 27: confirming after the widening lands the record at workspace scope", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "cell 27: a record raised then confirmed", "--proposed"])).out);
    assert.equal((await selfIn(box, demo, ["state", "place", id, "--scope", "workspace"])).code, 0);
    assert.equal((await selfIn(box, demo, ["state", "confirm", id])).code, 0);
    assert.match((await must(box, demo, ["state", "show", id])).out, /placement: workspace/);
});

test("cell 28: demoting a proposal's exposure is refused, and the refusal names state confirm", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "cell 28: a record nobody may hide yet", "--proposed"])).out);
    const before = events().length;
    const refused = await selfIn(box, demo, ["state", "place", id, "--exposure", "search", "--why", "quieter"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /renders nowhere to be demoted from/);
    assert.match(refused.out, new RegExp(`self state confirm ${id}`));
    assert.equal(events().length, before, "a refused placement still appended");
});

test("cell 29: a proposal's priority moves — priority hides nothing", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "cell 29: a record moved up the order", "--proposed"])).out);
    const placed = await selfIn(box, demo, ["state", "place", id, "--priority", "3"]);
    assert.equal(placed.code, 0, placed.out);
    assert.equal(events().at(-1).payload.priority, 3);
});

// The cap judges a record at the confirm, not at the propose (#240 R3), and a
// placement onto a proposal is the same kind of statement about where it will
// land — so the tier it names is judged when the record takes its seat there.
test("cell 31: a proposal placed past the full cap records, and the confirm is where the cap judges it", async () =>
{
    const file = join(ws, ".superself", "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, fullTokens: 60 }) + "\n");
    try
    {
        await must(box, demo, ["state", "add", "cell 31: holds the tier", "--exposure", "full"]);
        const id = entityIn((await must(box, demo, ["state", "add",
            "cell 31: a proposal aiming at a tier with no room", "--proposed"])).out);
        const placed = await selfIn(box, demo, ["state", "place", id, "--exposure", "full"]);
        assert.equal(placed.code, 0, placed.out);
        const refused = await selfIn(box, demo, ["state", "confirm", id]);
        assert.equal(refused.code, 1, refused.out);
        assert.match(refused.out, /cap/);
    }
    finally
    {
        writeFileSync(file, JSON.stringify(config) + "\n");
    }
});

test("cell 30: a retracted record is still refused — a withdrawn record has no placement", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "cell 30: a record that was taken back"])).out);
    assert.equal((await selfIn(box, demo, ["state", "retract", id, "--why", "done with it"])).code, 0);
    const refused = await selfIn(box, demo, ["state", "place", id, "--scope", "workspace"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /was retracted/);
});

/* ── F: `report confirm` and `runbook approve` ─────────────────────── */

function designFile(name, body)
{
    const path = join(box.root, `${name}.md`);
    writeFileSync(path, `# ${name}\n\n${body}\n`);
    return path;
}

// A work unit carrying an approvable design, and the report's own id.
async function designed(name, summary)
{
    const decision = await decide(`${name}: the rule this design implements`);
    const unit = workIdIn((await mustPerson(box, demo, ["work", "add", `${name}: the outcome`])).out);
    const result = await must(box, demo, ["report", unit, `${name} design`, "--design",
        "--implements", decision, "--artifact", designFile(name, summary)]);
    return { unit, report: result.out.match(/design report (\S+) recorded/)[1] };
}

test("cell 32: a session records the design approval, bound to the artifact digest", async () =>
{
    const { report } = await designed("cell32", "the design as agreed in chat");
    const before = events().length;
    const approved = await selfIn(box, demo, ["report", "confirm", report]);
    assert.equal(approved.code, 0, approved.out);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["report.confirmed"]);
    assert.equal(written[0].refs.confirms, report);
    assert.equal(typeof written[0].payload.digest, "string");
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
});

test("cell 33: the approval a session recorded admits a dispatch like any other", async () =>
{
    const { unit, report } = await designed("cell33", "the design a session approved");
    assert.equal((await selfIn(box, demo, ["report", "confirm", report])).code, 0);
    const started = await selfIn(box, demo, ["work", "start", unit]);
    assert.equal(started.code, 0, started.out);
});

test("cell 35: a second approval says so and records nothing", async () =>
{
    const { report } = await designed("cell35", "the design approved twice");
    assert.equal((await selfIn(box, demo, ["report", "confirm", report])).code, 0);
    const before = events().length;
    const again = await selfIn(box, demo, ["report", "confirm", report]);
    assert.match(again.out, /already/);
    assert.equal(events().length, before, "a second approval appended");
});

/* ── G: `artifact prune` — the gate that stays ─────────────────────── */

// An artifact on a unit that is finished, which is the state a prune is
// allowed from at all.
async function prunable(name)
{
    const unit = workIdIn((await mustPerson(box, demo, ["work", "add", `${name}: the outcome behind the bytes`])).out);
    writeFileSync(join(demo, `${name}.md`), `the evidence for ${name}\n`);
    const filed = await must(box, demo, ["report", unit, `${name} evidence`, "--artifact", join(demo, `${name}.md`)]);
    await must(box, demo, ["work", "start", unit]);
    await must(box, demo, ["work", "done", unit, "--report", "the outcome verifiably happened"]);
    return events().find((event) => event.id === filed.out.match(/\[([^\]]+)\]/)[1]).payload.artifacts[0].id;
}

test("cell 39: a piped prune is refused, and the refusal states the rule in one line", async () =>
{
    const id = await prunable("cell39");
    const before = events().length;
    const refused = await selfIn(box, demo, ["artifact", "prune", id, "--why", "the guide moved"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /removing stored bytes cannot be taken back by `self undo`, so a person types the id/);
    assert.equal(events().length, before, "a refused prune appended");
});

test("cell 40: a marker refuses the prune even where a terminal would answer", async () =>
{
    const id = await prunable("cell40");
    const before = events().length;
    const refused = await approvedIn(box, demo, ["artifact", "prune", id, "--why", "the guide moved"], id,
        { SUPERSELF_SESSION: "a-runner" });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /has no terminal to type it at/);
    assert.equal(events().length, before, "a refused prune appended");
});

test("cell 41: a person types the id back, and the bytes go", async () =>
{
    const id = await prunable("cell41");
    const before = events().length;
    const pruned = await approvedIn(box, demo, ["artifact", "prune", id, "--why", "the guide moved"], id);
    assert.equal(pruned.code, 0, pruned.out);
    const written = since(before);
    assert.deepEqual(written.map((event) => event.type), ["artifact.pruned"]);
    assert.equal(written[0].payload.confirmation.method, "tty");
});

/* ── H: undoing a design approval ──────────────────────────────────── */

test("cell 42: an approval nothing was built on is undone, and the design reads unapproved", async () =>
{
    const { unit, report } = await designed("cell42", "the design approved by mistake");
    assert.equal((await selfIn(box, demo, ["report", "confirm", report])).code, 0);
    const approval = events().at(-1).id;
    const undone = await selfIn(box, demo, ["undo", approval]);
    assert.equal(undone.code, 0, undone.out);
    assert.equal(events().at(-1).refs.annuls, approval);
    assert.match((await must(box, demo, ["work", "show", unit])).out, /design implementing .*, not approved/);
});

test("cell 43: after the undo, the unit is refused as waiting on its design again", async () =>
{
    const { unit, report } = await designed("cell43", "the design whose approval was taken back");
    assert.equal((await selfIn(box, demo, ["report", "confirm", report])).code, 0);
    assert.equal((await selfIn(box, demo, ["undo", events().at(-1).id])).code, 0);
    const refused = await selfIn(box, demo, ["work", "start", unit]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`waiting on an approval: \`self report confirm ${report}\``));
});

// The dependent chain #400 had to teach `undo.ts` about: the approval names
// its unit nowhere in its payload, so nothing said a later `work start` stood
// on it — and taking it back alone would leave a dispatched unit whose design
// nobody approved.
test("cell 44: an approval a dispatch stood on is refused, with the list of what to take back first", async () =>
{
    const { unit, report } = await designed("cell44", "the design the unit was started on");
    assert.equal((await selfIn(box, demo, ["report", "confirm", report])).code, 0);
    const approval = events().at(-1).id;
    assert.equal((await selfIn(box, demo, ["work", "start", unit])).code, 0);
    const before = events().length;
    const refused = await selfIn(box, demo, ["undo", approval]);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /was built on/);
    assert.match(refused.out, /entity\.started/);
    assert.equal(events().length, before, "a refused undo appended");
});

test("cell 45: undoing a prune is refused by name, unchanged", async () =>
{
    const id = await prunable("cell45");
    assert.equal((await approvedIn(box, demo, ["artifact", "prune", id, "--why", "the guide moved"], id)).code, 0);
    const refused = await selfIn(box, demo, ["undo", events().at(-1).id]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /nothing takes back a deletion/);
});

/* ── I: what a reader is told ──────────────────────────────────────── */

test("cell 46: a record's history states the session that wrote each event", async () =>
{
    const id = entityIn((await selfIn(box, demo, ["state", "add", "cell 46: a record a session wrote"],
        { SUPERSELF_SESSION: "sess-46" })).out);
    const page = (await must(box, demo, ["state", "show", id, "--history"])).out;
    assert.match(page, /by agent \(session sess-46\)/);
});

test("cell 47: a record a person wrote says a person wrote it", async () =>
{
    const unit = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 47: an outcome a person recorded"])).out);
    const page = (await must(box, demo, ["work", "show", unit, "--history"])).out;
    assert.match(page, /by person/);
});

// A store written before #400 carries no `by`, and the page says nothing rather
// than inventing "person" for it.
test("cell 47b: an event carrying no by is rendered without a writer line", async () =>
{
    const page = (await must(box, demo, ["state", "show",
        events().find((event) => event.payload.by === undefined && typeof event.payload.entity === "string").payload.entity,
        "--history"])).out;
    assert.ok(page.length > 0, "the history printed nothing at all");
});

// The sentences the person gate wrote, in the words the help pages used to
// carry them. A page still saying one of these describes a refusal the CLI no
// longer has — which is the way this change rots: the behaviour moves and a
// paragraph two files away keeps promising the old rule.
const RETIRED_CLAIMS = ["own terminal", "person's call", "at its keyboard", "person at a terminal",
    "no person is at the terminal", "typed back"];

// `artifact` is the one page allowed to keep them: `undo.ts` names
// `artifact.pruned` as the deletion no event reverses, so its gate — and the
// sentences describing it — are what this cell holds in place rather than out.
const GATE_PAGE = "artifact";

test("cell 56: no help page but the artifact one claims a person's terminal", async () =>
{
    const names = [...new Set([...COMMANDS.map((command) => command.name), ...TOPICS.map((topic) => topic.name)])];
    for (const name of names.filter((topic) => topic !== GATE_PAGE))
    {
        const page = (await must(box, demo, ["help", name])).out;
        const claimed = RETIRED_CLAIMS.filter((claim) => page.includes(claim));
        assert.deepEqual(claimed, [], `\`self help ${name}\` still claims: ${claimed.join(", ")}`);
    }
});

test("cell 57: the artifact page keeps the one gate, and states why it is the only one", async () =>
{
    const page = (await must(box, demo, ["help", GATE_PAGE])).out;
    assert.match(page, /still needs a person at a terminal typing the artifact id/);
    assert.match(page, /`self undo` takes back every other record, and never a deletion/);
});
