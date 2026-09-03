// `self instruction render` — the operating manual a session reads whole
// (#440).
//
// Every test below is one cell of group C of the case table in
// docs/maintainers/case-tables/440-instructions.md, named by its cell id, and
// asserts that cell's stated outcome. The add and the listing are in
// instruction.test.mjs; context, search, the handoff and the lifecycle are in
// instruction-context.test.mjs; placement is in instruction-place.test.mjs.
//
// The rulings this group stands on:
//
//   R1  the sections are Tools, Rules, Procedures, Unclassified, in that
//       order, and an empty one is omitted rather than printed empty
//   R2  the head prints on an empty store: a command that printed nothing
//       would make an empty store indistinguishable from a failed run
//   R3  only confirmed, current, in-scope, full-exposure records render —
//       proposed, superseded, retracted, demoted and search-tier ones are not
//   R4  a record's kind is the first of `rule`, `tool`, `procedure` its label
//       list holds: membership, never position
//   R5  the render is uncapped by construction and is never spliced into
//       `self context`, which would zero every other section of that page
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTRUCTION_HEAD } from "../dist/instructions.js";
import { ulid } from "../dist/ids.js";
import { demoWorkspace, git, logFixture, machine, must, receiptIn, selfIn } from "./harness.mjs";

async function floor()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    return { box, ws, demo, self: (args, cwd = demo) => selfIn(box, cwd, args) };
}

async function sibling(ground, slug)
{
    const dir = join(ground.ws, slug);
    mkdirSync(dir, { recursive: true });
    git(ground.box, dir, ["init", "-q", "-b", "main"]);
    await must(ground.box, dir, ["project", "init", "--name", slug]);
    return dir;
}

function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no entity id in: ${text}`);
    return match[0];
}

async function add(ground, text, kind, extra = [], cwd = ground.demo)
{
    // The receipt is the last line: a superseding add discloses the predecessor
    // first, so the whole output opens with the id of the record being replaced.
    return entityIn(receiptIn((await must(ground.box, cwd,
        ["instruction", "add", text, "--kind", kind, ...extra])).out));
}

async function render(ground, args = [], cwd = ground.demo)
{
    return (await must(ground.box, cwd, ["instruction", "render", ...args])).out;
}

// The heading lines a render printed, in the order it printed them.
function headings(text)
{
    return text.split("\n").filter((line) => line.startsWith("## "));
}

function setCaps(ws, caps)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

// One `entity.confirmed` exactly as the pipeline writes one, so a cell can
// state the `ts` and the id the ordering turns on: two adds driven through the
// CLI are milliseconds apart and can never be made to share a `ts`.
function toolFixture(ground, text, ts, id)
{
    logFixture(ground.ws, "demo", {
        id: ulid(), ts, type: "entity.confirmed", origin: { actor: "agent", confirmed: true }, project: "demo",
        payload: {
            entity: id, text, labels: ["instruction", "tool"], links: [], criteria: [],
            exposure: "full", scope: "project", priority: 20, by: { kind: "agent" }
        }
    });
    return text;
}

/* ── group C: the render ───────────────────────────────────────────── */

test("C1: an empty store renders the head alone, with no section heading, exit 0", async () =>
{
    const ground = await floor();
    const rendered = await must(ground.box, ground.demo, ["instruction", "render"]);
    assert.equal(rendered.code, 0);
    assert.equal(rendered.out, `${INSTRUCTION_HEAD}\n`);
    assert.deepEqual(headings(rendered.out), []);
});

test("C2: one kind renders one section — the empty ones are absent, not printed empty", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    const out = await render(ground);
    assert.deepEqual(headings(out), ["## Rules"]);
    assert.match(out, /^- tests run on the dev VM$/m);
    for (const absent of ["## Tools", "## Procedures", "## Unclassified"])
    {
        assert.equal(out.includes(absent), false, `${absent} was printed with nothing under it`);
    }
});

test("C3: the sections print Tools, Rules, Procedures, entries by priority inside each", async () =>
{
    const ground = await floor();
    await add(ground, "a later rule", "rule", ["--priority", "40"]);
    await add(ground, "an earlier rule", "rule", ["--priority", "10"]);
    await add(ground, "a tool note", "tool");
    await add(ground, "a procedure", "procedure");
    const out = await render(ground);
    assert.deepEqual(headings(out), ["## Tools", "## Rules", "## Procedures"]);
    assert.ok(out.indexOf("an earlier rule") < out.indexOf("a later rule"), out);
});

test("C4: a priority tie inside a section falls to orderEntities, exactly as the listing does", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    await add(ground, "the project's own tool note", "tool", ["--priority", "20"]);
    await add(ground, "the workspace tool note", "tool", ["--priority", "20", "--workspace"]);
    // The second and third legs need a stated `ts`: the pair that shares one is
    // where the id is the only tie-break left, and two CLI adds never share it.
    toolFixture(ground, "the older tool note", "2026-08-01T00:00:00.000Z", "e-bbbb1");
    toolFixture(ground, "the newer tool note", "2026-08-02T00:00:00.000Z", "e-bbbb2");
    toolFixture(ground, "one of a pair minted together", "2026-07-01T00:00:00.000Z", "e-aaaa1");
    toolFixture(ground, "the other of that pair", "2026-07-01T00:00:00.000Z", "e-aaaa2");
    const lines = (await render(ground)).split("\n").filter((line) => line.startsWith("- "));
    assert.deepEqual(lines, [
        "- the workspace tool note",
        "- the project's own tool note",
        "- the newer tool note",
        "- the older tool note",
        "- one of a pair minted together",
        "- the other of that pair"
    ]);
});

test("C5: a --workspace instruction recorded in one project renders in another", async () =>
{
    const ground = await floor();
    const other = await sibling(ground, "other");
    await add(ground, "every project reviews before merge", "rule", ["--workspace"]);
    assert.match(await render(ground, [], other), /- every project reviews before merge/);
});

test("C6: a --scope instruction renders in the project it names and nowhere else", async () =>
{
    const ground = await floor();
    const other = await sibling(ground, "other");
    await must(ground.box, other, ["instruction", "add", "demo deploys on Fridays", "--kind", "rule",
        "--scope", "demo"]);
    assert.match(await render(ground), /- demo deploys on Fridays/);
    assert.equal((await render(ground, [], other)).includes("demo deploys on Fridays"), false);
});

test("C7: a proposed instruction is absent from the render", async () =>
{
    const ground = await floor();
    await add(ground, "a rule nobody has agreed to", "rule", ["--proposed"]);
    assert.equal((await render(ground)).includes("a rule nobody has agreed to"), false);
});

test("C8: a superseded instruction is absent and its successor renders", async () =>
{
    const ground = await floor();
    const first = await add(ground, "tests run locally", "rule");
    await add(ground, "tests run on the dev VM", "rule", ["--supersedes", first]);
    const out = await render(ground);
    assert.match(out, /- tests run on the dev VM/);
    assert.equal(out.includes("tests run locally"), false);
});

test("C9: a retracted instruction is absent from the render", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "retract", id, "--why", "the VM moved"]);
    assert.equal((await render(ground)).includes("tests run on the dev VM"), false);
});

test("C10: a demoted instruction leaves the render and enters the context index", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "index", "--why", "narrower"]);
    assert.equal((await render(ground)).includes("tests run on the dev VM"), false);
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.match(context, /## Index/);
    assert.match(context, /- \[instruction, rule\] tests run on the dev VM/);
});

test("C11: an instruction at search exposure is in neither render, and the index counts it", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "search", "--why", "kept for the record"]);
    assert.equal((await render(ground)).includes("tests run on the dev VM"), false);
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.equal(context.includes("tests run on the dev VM"), false);
    assert.match(context, /- 1 entity at search exposure; run `self state/);
});

test("C12: --project renders another registered project's set", async () =>
{
    const ground = await floor();
    const other = await sibling(ground, "other");
    await add(ground, "demo's own standing rule", "rule");
    const out = await render(ground, ["--project", "demo"], other);
    assert.match(out, /- demo's own standing rule/);
});

test("C13: --project naming an archived project renders it, with the archived notice beside it", async () =>
{
    const ground = await floor();
    const other = await sibling(ground, "other");
    await must(ground.box, other, ["instruction", "add", "other's standing rule", "--kind", "rule"]);
    await must(ground.box, ground.demo, ["project", "archive", "other", "--why", "finished"]);
    const out = await render(ground, ["--project", "other"]);
    assert.match(out, /- other's standing rule/);
    // The whole sentence, the way handoff.test.mjs asserts its own archived
    // notice: a bare /archived/ would pass on the word alone, wherever it came
    // from, and the remedy the notice names is the half a reader acts on.
    assert.match(out, new RegExp("^project \"other\" is archived \\(\\d{4}-\\d{2}-\\d{2}: finished\\)"
        + " — run `self project restore other` to bring it back$", "m"));
});

test("C14: --project naming no registered project is refused, and names `self project`", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    const refused = await ground.self(["instruction", "render", "--project", "nosuch"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown project "nosuch" — run `self project` to list the registered slugs/);
});

// The harness merges stdout and stderr into one string, so which stream the
// line came out on is not provable in this process — the table says so under
// group C. What is provable, and what this asserts, is that the sentence is
// printed and the render still stands.
test("C15: one unreadable store is named on stderr and the readable set still renders", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    const third = await sibling(ground, "third");
    await must(ground.box, third, ["instruction", "add", "reviewed before merge", "--kind", "rule", "--workspace"]);
    appendFileSync(join(ground.ws, ".superself", "projects", "other", "log.jsonl"), "not an event\n");
    const rendered = await ground.self(["instruction", "render"]);
    assert.equal(rendered.code, 0, rendered.out);
    assert.match(rendered.out, /- reviewed before merge/);
    assert.match(rendered.out, /project "other" is left out of this answer — its state could not be read/);
});

test("C16: a render outside every registered project, naming none, is refused", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["instruction", "render"], ground.ws);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /not inside a registered project — run `self project init` here to register it/);
});

test("C17: a raw-add instruction with no kind label renders under Unclassified, printed last", async () =>
{
    const ground = await floor();
    await add(ground, "a classified procedure", "procedure");
    await must(ground.box, ground.demo,
        ["state", "add", "raw note", "--label", "instruction", "--exposure", "full"]);
    const out = await render(ground);
    assert.deepEqual(headings(out), ["## Procedures", "## Unclassified"]);
    assert.match(out, /## Unclassified\n- raw note/);
});

test("C18: a raw add carrying two kind labels reads as the first of rule, tool, procedure it holds", async () =>
{
    const ground = await floor();
    await must(ground.box, ground.demo, ["state", "add", "raw note", "--label", "instruction",
        "--label", "procedure", "--label", "rule", "--exposure", "full"]);
    const out = await render(ground);
    assert.deepEqual(headings(out), ["## Rules"]);
    assert.match(out, /## Rules\n- raw note/);
});

test("C19: a preset label beside `instruction` folds to a source, so the predicate rejects it", async () =>
{
    const ground = await floor();
    await must(ground.box, ground.demo, ["state", "add", "raw note", "--label", "instruction",
        "--label", "convention", "--exposure", "full"]);
    assert.equal((await render(ground)).includes("raw note"), false);
    assert.match((await must(ground.box, ground.demo, ["context"])).out, /raw note/);
});

test("C20: --json emits one object: sections in render order, entries in render order", async () =>
{
    const ground = await floor();
    await add(ground, "a rule", "rule", ["--why", "because"]);
    await add(ground, "a tool note", "tool", ["--why", "because"]);
    await add(ground, "a procedure", "procedure", ["--why", "because"]);
    // The two shapes an entry can arrive in with a field missing: an add made
    // with no --why, and a raw `state add` record, which can hold no priority
    // and no kind label at all.
    await add(ground, "a rule nobody stated a reason for", "rule");
    await must(ground.box, ground.demo,
        ["state", "add", "raw note", "--label", "instruction", "--exposure", "full"]);
    const out = (await must(ground.box, ground.demo, ["instruction", "render", "--json"])).out;
    const payload = JSON.parse(out.trim());
    assert.equal(out.trim(), JSON.stringify(payload), "something was printed around the object");
    assert.equal(payload.project, "demo");
    assert.deepEqual(payload.sections.map((section) => [section.kind, section.heading]),
        [["tool", "Tools"], ["rule", "Rules"], ["procedure", "Procedures"], ["unclassified", "Unclassified"]]);
    const entries = payload.sections.flatMap((section) => section.entries);
    assert.equal(entries.length, 5);
    // Five keys on every entry, always, and an absent field is `null` rather
    // than a key the caller's reader has to branch on the presence of.
    for (const entry of entries)
    {
        assert.deepEqual(Object.keys(entry), ["id", "text", "priority", "scope", "why"], JSON.stringify(entry));
    }
    const noReason = entries.find((entry) => entry.text === "a rule nobody stated a reason for");
    assert.equal(noReason.why, null);
    assert.equal(noReason.priority, 50);
    const raw = entries.find((entry) => entry.text === "raw note");
    assert.equal(raw.why, null);
    assert.equal(raw.priority, null);
    assert.equal(payload.sections.some((section) => section.entries.length === 0), false);
});

test("C21: SUPERSELF_JSON=1 is honoured on the leaf that declares --json", async () =>
{
    const ground = await floor();
    await add(ground, "a rule", "rule", ["--why", "because"]);
    const flagged = (await must(ground.box, ground.demo, ["instruction", "render", "--json"])).out;
    const ambient = (await must(ground.box, ground.demo, ["instruction", "render"],
        { SUPERSELF_JSON: "1" })).out;
    assert.equal(ambient, flagged);
});

test("C22: the payload's entry ids and their order equal the rendered lines, section for section", async () =>
{
    const ground = await floor();
    const rule = await add(ground, "a rule", "rule", ["--priority", "20"]);
    const earlier = await add(ground, "an earlier rule", "rule", ["--priority", "10"]);
    const tool = await add(ground, "a tool note", "tool");
    const payload = JSON.parse((await must(ground.box, ground.demo, ["instruction", "render", "--json"])).out.trim());
    assert.deepEqual(payload.sections.flatMap((section) => section.entries.map((entry) => entry.id)),
        [tool, earlier, rule]);
    const lines = (await render(ground)).split("\n").filter((line) => line.startsWith("- "));
    assert.deepEqual(lines, ["- a tool note", "- an earlier rule", "- a rule"]);
    assert.deepEqual(payload.sections.flatMap((section) => section.entries.map((entry) => `- ${entry.text}`)), lines);
});

test("C23: a store far over its full cap renders whole while the add stays gated", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    await add(ground, "a PR gets a cross-model review before merge", "rule");
    setCaps(ground.ws, { fullTokens: 20 });
    const out = await render(ground);
    assert.match(out, /- tests run on the dev VM/);
    assert.match(out, /- a PR gets a cross-model review before merge/);
    const refused = await ground.self(["instruction", "add", "one more standing rule", "--kind", "rule"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds \d+ of 20 tokens and this text adds \d+ more/);
});

test("C24: the render is never spliced into `self context` — its head appears nowhere there", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.equal(context.includes(INSTRUCTION_HEAD), false, context);
    assert.match(await render(ground), new RegExp(`^${INSTRUCTION_HEAD}$`, "m"));
});

test("C25: --project renders a named project's set from outside every registered one", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    await add(ground, "demo's own standing rule", "rule");
    // The workspace root is inside no project, which is where C16's refusal
    // comes from; naming the project is what answers it.
    const out = await must(ground.box, ground.ws, ["instruction", "render", "--project", "demo"]);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /- demo's own standing rule/);
    assert.match(out.out, new RegExp(`^${INSTRUCTION_HEAD}$`, "m"));
});

test("C26: a --workspace instruction whose project is archived leaves every project's render", async () =>
{
    const ground = await floor();
    const other = await sibling(ground, "other");
    const third = await sibling(ground, "third");
    await must(ground.box, other, ["instruction", "add", "every project reviews before merge",
        "--kind", "rule", "--workspace"]);
    await must(ground.box, ground.demo, ["project", "archive", "other", "--why", "finished"]);
    // `workspaceModels` walks `activeProjects`, so an archived project's log is
    // in no other project's answer — including for a record scoped to them all.
    // The current behaviour, pinned; the table says it is not a decision.
    for (const cwd of [ground.demo, third])
    {
        assert.equal((await render(ground, [], cwd)).includes("every project reviews before merge"), false);
    }
    // Naming it explicitly is how its own set is still read (#283).
    assert.match(await render(ground, ["--project", "other"]), /- every project reviews before merge/);
});
