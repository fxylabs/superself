// The rules, tool notes and procedures a session receives whole (#440).
//
// Every test below is one cell of the case table in
// docs/maintainers/case-tables/440-instructions.md, named by its cell id, and
// asserts that cell's stated outcome. Groups A (`instruction add`) and B
// (`self instruction` / `instruction list`) land here; the render is in
// instruction-render.test.mjs, context, search, the handoff and the lifecycle
// in instruction-context.test.mjs, and placement in instruction-place.test.mjs.
//
// The rulings the table stands on:
//
//   R1  an instruction is an entity labelled `instruction` with
//       `source === undefined`: the rule is its text, its section a second
//       label beside it, its order the existing `priority`, and which projects
//       render it the existing `EntityScope`
//   R2  no new event type: entity.confirmed, entity.proposed, entity.placed
//       and entity.retracted do all of it, and `FOLD_VERSION` stays at 1
//   R3  the one widening is `ComposedValues.priority`, validated by
//       `validPriority`; `reserved` spreads last, so `add` offers no --label
//   R4  supersession is held to instructions by resolving the target through
//       the instruction predicate before the add — the kinds the fold reads as
//       `"entity"` only; a convention keeps the fold's own refusal
//   R5  an instruction charges no retention tier at any exposure and is
//       bounded by `instructionTokens` instead — its own cap, per render
//       target, 2,000 tokens by default (#446 §D-14); `--demote` leaves the
//       verb with the tier it freed room in (§D-16)
//   R6  the listing closes with one cap-share line per occupied render target,
//       so a workspace manual and a project set are never added together
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FOLD_VERSION } from "@superself/fold";
import { ulid } from "../dist/ids.js";
import { demoWorkspace, git, logFixture, machine, must, mustPerson, receiptIn, selfIn } from "./harness.mjs";

/* ── the floor every cell stands on ────────────────────────────────── */

async function floor()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    return { box, ws, demo, self: (args, cwd = demo) => selfIn(box, cwd, args) };
}

// A second registered project in the same workspace, for the scope cells.
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

// A project that has recorded nothing has no log file yet, and the cells that
// count "nothing was recorded" start there.
function events(ws, slug = "demo")
{
    const file = join(ws, ".superself", "projects", slug, "log.jsonl");
    return !existsSync(file) ? [] : readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function recordOf(ws, id, slug = "demo")
{
    const written = events(ws, slug).find((event) => event.payload.entity === id);
    assert.ok(written !== undefined, `no event recorded ${id}`);
    return written;
}

// Caps are user-set values in the store's config.json, in tokens: one token
// per character here, so a cap a cell sets is a character count.
function setCaps(ws, caps)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

// One `entity.confirmed` exactly as the pipeline writes one, so a cell can
// state the `ts` and the id the ordering turns on: two adds driven through the
// CLI are milliseconds apart and can never be made to share a `ts`.
function ruleFixture(ground, text, ts, id)
{
    logFixture(ground.ws, "demo", {
        id: ulid(), ts, type: "entity.confirmed", origin: { actor: "agent", confirmed: true }, project: "demo",
        payload: {
            entity: id, text, labels: ["instruction", "rule"], links: [], criteria: [],
            exposure: "full", scope: "project", priority: 20, by: { kind: "agent" }
        }
    });
    return id;
}

/* ── group A: recording an instruction ─────────────────────────────── */

test("A1: an add records one full-exposure instruction with its kind, scope and priority", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    assert.match(id, /^e-[0-9a-z]{5}$/);
    const written = recordOf(ground.ws, id);
    assert.equal(written.type, "entity.confirmed");
    assert.equal(written.payload.text, "tests run on the dev VM");
    assert.deepEqual(written.payload.labels, ["instruction", "rule"]);
    assert.equal(written.payload.exposure, "full");
    assert.equal(written.payload.scope, "project");
    assert.equal(written.payload.priority, 50);
    assert.match((await must(ground.box, ground.demo, ["state", "show", id])).out, /placement: project · full/);
});

test("A2: --kind tool writes `tool` as the second label", async () =>
{
    const ground = await floor();
    const id = await add(ground, "`self report` carries --friction", "tool");
    assert.deepEqual(recordOf(ground.ws, id).payload.labels, ["instruction", "tool"]);
});

test("A3: --kind procedure writes `procedure` as the second label", async () =>
{
    const ground = await floor();
    const id = await add(ground, "targeted suites, then commit, then CI", "procedure");
    assert.deepEqual(recordOf(ground.ws, id).payload.labels, ["instruction", "procedure"]);
});

test("A4: a kind outside the three is refused by name, and names all three", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    const refused = await ground.self(["instruction", "add", "x", "--kind", "harness"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"harness" is not an instruction kind — pass rule \(a judgement or execution rule\), /);
    assert.match(refused.out, /tool \(a note about a command\), or procedure \(steps in a fixed order\)/);
    assert.equal(events(ground.ws).length, before);
});

test("A5: an add with no --kind is refused by the requirement gate that names the hint", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["instruction", "add", "x"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /self instruction add needs --kind: which section it renders under/);
});

test("A6: a blank text is refused by the text gate, however it is spelled", async () =>
{
    const ground = await floor();
    for (const text of ["", "   "])
    {
        const refused = await ground.self(["instruction", "add", text, "--kind", "rule"]);
        assert.notEqual(refused.code, 0, `"${text}" was accepted as an instruction`);
        assert.match(refused.out, /usage: self instruction add "<text>"/);
    }
});

test("A7: --priority is written to the payload — the ComposedValues widening", async () =>
{
    const ground = await floor();
    const id = await add(ground, "a rule that reads first", "rule", ["--priority", "10"]);
    assert.equal(recordOf(ground.ws, id).payload.priority, 10);
});

test("A8: an add with no --priority takes 50 from the row", async () =>
{
    const ground = await floor();
    const id = await add(ground, "a rule with no stated order", "rule");
    assert.equal(recordOf(ground.ws, id).payload.priority, 50);
});

test("A9: a malformed priority is refused rather than rounded, and nothing is recorded", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    for (const [spelling, named] of [["--priority=-1", "-1"], ["--priority=x", "x"]])
    {
        const refused = await ground.self(["instruction", "add", "x", "--kind", "rule", spelling]);
        assert.notEqual(refused.code, 0, `${spelling} was accepted`);
        assert.match(refused.out, new RegExp("--priority takes a whole number, 0 or higher, small enough to keep"
            + ` exactly — "${named}" is not one`), `${spelling} was refused without naming what was wrong`);
    }
    assert.equal(events(ground.ws).length, before);
});

test("A10: --workspace records the instruction at workspace scope", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    const id = await add(ground, "every project reviews before merge", "rule", ["--workspace"]);
    assert.equal(recordOf(ground.ws, id).payload.scope, "workspace");
});

test("A11: --scope names another project, and the event still lands in this project's log", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    const id = await add(ground, "the other project deploys on Fridays", "rule", ["--scope", "other"]);
    assert.equal(recordOf(ground.ws, id).payload.scope, "other");
    assert.equal(events(ground.ws, "other").some((event) => event.payload.entity === id), false,
        "the record moved into the project it renders in instead of staying in the log that wrote it");
});

test("A12: --scope project is refused by name, as it is everywhere else", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["instruction", "add", "x", "--kind", "rule", "--scope", "project"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--scope project was retired — omit --scope to place a record in the project you are in/);
    assert.match(refused.out, /--scope workspace` for every project/);
});

test("A13: --scope naming no registered project is refused, and names how to list them", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["instruction", "add", "x", "--kind", "rule", "--scope", "nosuch"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"nosuch" is not a registered project — run `self project` to list the slugs/);
});

test("A14: --scope naming an archived project is refused — it would render nowhere", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    await must(ground.box, ground.demo, ["project", "archive", "other", "--why", "finished"]);
    const refused = await ground.self(["instruction", "add", "x", "--kind", "rule", "--scope", "other"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /project "other" is archived, so a record placed there would render nowhere/);
    assert.match(refused.out, /self project restore other/);
});

test("A15: --workspace and --scope together are refused — one placement, two spellings", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    const refused = await ground.self(["instruction", "add", "x", "--kind", "rule", "--workspace", "--scope", "other"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--workspace and --scope name the same thing two ways — pass one of them/);
});

test("A16: --supersedes an instruction lands one record, retires the predecessor, discloses first", async () =>
{
    const ground = await floor();
    const first = await add(ground, "tests run locally", "rule");
    const written = await must(ground.box, ground.demo,
        ["instruction", "add", "tests run on the dev VM", "--kind", "rule", "--supersedes", first]);
    const second = entityIn(written.out.trimEnd().split("\n").at(-1));
    assert.notEqual(second, first);
    assert.ok(written.out.indexOf(first) < written.out.indexOf("entity.confirmed recorded"),
        "the retirement disclosure did not print before the write");
    const record = recordOf(ground.ws, second);
    assert.equal(record.type, "entity.confirmed");
    assert.deepEqual(record.payload.links, [{ type: "supersedes", target: first }]);
    assert.match((await must(ground.box, ground.demo, ["state", "show", first])).out, /superseded/);
});

test("A17: --supersedes a skill is refused by the instruction predicate, and nothing is recorded", async () =>
{
    const ground = await floor();
    await must(ground.box, ground.demo, ["skill", "add", "deploy", "--command", "make deploy", "--purpose", "ship"]);
    await add(ground, "tests run on the dev VM", "rule");
    const skill = entityIn((await must(ground.box, ground.demo, ["skill"])).out);
    const before = events(ground.ws).length;
    const refused = await ground.self(["instruction", "add", "y", "--kind", "rule", "--supersedes", skill]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${skill} is not an instruction — \`instruction add --supersedes\` `
        + "replaces an instruction; run `self instruction` for the ids it takes".replace(/[`]/g, "`")));
    assert.equal(events(ground.ws).length, before);
});

test("A18: --supersedes a convention keeps the fold's own refusal, naming `convention add`", async () =>
{
    const ground = await floor();
    await must(ground.box, ground.demo, ["convention", "add", "a prose rule"]);
    const convention = events(ground.ws).find((event) => event.payload.labels?.includes("convention")).payload.entity;
    const refused = await ground.self(["instruction", "add", "y", "--kind", "rule", "--supersedes", convention]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${convention} is a convention record — replace it with`));
    assert.match(refused.out, /`self convention add "<text>" --supersedes /);
});

test("A19: --supersedes a runbook gets the same refusal as a skill — the fold reads both as `entity`", async () =>
{
    const ground = await floor();
    const runbook = entityIn((await must(ground.box, ground.demo,
        ["runbook", "add", "release", "--stage", "build", "--stage", "ship"])).out);
    const refused = await ground.self(["instruction", "add", "y", "--kind", "rule", "--supersedes", runbook]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${runbook} is not an instruction`));
    assert.match(refused.out, /run `self instruction` for the ids it takes/);
});

test("A20: --supersedes an unknown id is refused by the resolver that names the listing", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["instruction", "add", "y", "--kind", "rule", "--supersedes", "e-nosuch"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown entity "e-nosuch" — run `self state list` for ids/);
});

test("A21: --supersedes an already-superseded instruction is refused", async () =>
{
    const ground = await floor();
    const first = await add(ground, "tests run locally", "rule");
    await add(ground, "tests run on the dev VM", "rule", ["--supersedes", first]);
    const refused = await ground.self(["instruction", "add", "z", "--kind", "rule", "--supersedes", first]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${first} was already superseded — nothing is left to supersede`));
});

test("A22: --proposed records a proposal that renders nowhere until a person confirms it", async () =>
{
    const ground = await floor();
    const id = await add(ground, "a rule nobody has agreed to yet", "rule", ["--proposed"]);
    assert.equal(recordOf(ground.ws, id).type, "entity.proposed");
    const rendered = (await must(ground.box, ground.demo, ["instruction", "render"])).out;
    assert.equal(rendered.includes("a rule nobody has agreed to yet"), false);
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.ok(context.includes(`proposed entity ${id}: a rule nobody has agreed to yet`
        + ` (confirm with \`self state confirm ${id}\`)`), context);
});

// The cell #446 turns over: this state used to refuse the add, and the tier it
// seeds is one the record never enters.
test("A23: a full tier at its cap does not see the add at all, and is unmoved by it", async () =>
{
    const ground = await floor();
    // A 30-token full tier, 28 of it already spent by an ordinary record.
    await must(ground.box, ground.demo, ["state", "add", "an ordinary full record here", "--exposure", "full"]);
    setCaps(ground.ws, { fullTokens: 30 });
    const id = await add(ground, "a second standing rule here", "rule");
    assert.equal(recordOf(ground.ws, id).type, "entity.confirmed");
    assert.match((await must(ground.box, ground.demo, ["instruction", "render"])).out,
        /- a second standing rule here/);
    // The tier's held count is the ordinary record's alone, before and after.
    const refused = await ground.self(["state", "add", "one more full record", "--exposure", "full"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 28 of 30 tokens/);
});

test("A24: past the instruction cap --proposed records the proposal, and the confirm is what gates", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, { instructionTokens: 30 });
    await add(ground, "tests run on the dev VM", "rule");
    const added = await add(ground, "a second standing rule here", "rule", ["--proposed"]);
    assert.equal(recordOf(ground.ws, added).type, "entity.proposed");
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.ok(context.includes(`proposed entity ${added}`), context);
    const refused = await ground.self(["state", "confirm", added]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /confirming this would put the project instructions over their cap/);
});

test("A25: under the instruction cap the add lands, naming no demotion and no other record kind", async () =>
{
    const ground = await floor();
    await must(ground.box, ground.demo, ["state", "add", "ship the thing", "--label", "goal", "--exposure", "full"]);
    await must(ground.box, ground.demo,
        ["state", "add", "review before merge", "--label", "convention", "--exposure", "full"]);
    const landed = await must(ground.box, ground.demo,
        ["instruction", "add", "tests run on the dev VM", "--kind", "rule"]);
    assert.equal(landed.code, 0);
    for (const word of ["--demote", "goal", "objective", "convention", "full tier"])
    {
        assert.equal(landed.out.includes(word), false, `the receipt named ${word}:\n${landed.out}`);
    }
});

test("A26: an add outside every registered project is refused, and records nothing", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    const refused = await ground.self(["instruction", "add", "x", "--kind", "rule"], ground.ws);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /not inside a registered project — run `self project init` here to register it/);
    assert.equal(events(ground.ws).length, before);
});

test("A27: an add inside an archived project's checkout is refused by the append gate", async () =>
{
    const ground = await floor();
    const other = await sibling(ground, "other");
    await must(ground.box, ground.demo, ["project", "archive", "other", "--why", "finished"]);
    const before = events(ground.ws, "other").length;
    const refused = await ground.self(["instruction", "add", "x", "--kind", "rule"], other);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /project "other" is archived, so nothing more is recorded into it/);
    assert.equal(events(ground.ws, "other").length, before);
});

test("A28: a --workspace add lands, and the project tier's refusal counts neither instruction", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    // 24 tokens of ordinary full record, and two instructions the tier does not
    // hold: the project-scoped 23 and the workspace-scoped 14.
    await must(ground.box, ground.demo, ["state", "add", "one ordinary record here", "--exposure", "full"]);
    setCaps(ground.ws, { fullTokens: 25 });
    await add(ground, "tests run on the dev VM", "rule");
    await add(ground, "reviewed first", "rule", ["--workspace"]);
    const refused = await ground.self(["state", "add", "another project-scoped full rule", "--exposure", "full"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 24 of 25 tokens/);
    assert.equal(refused.out.includes("holds 47"), false, refused.out);
    assert.equal(refused.out.includes("holds 61"), false, refused.out);
});

test("A29: the append mints one ordinary entity event and no storage of its own", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["fold"]);
    const written = events(ground.ws).slice(before);
    assert.equal(written.length, 1);
    assert.equal(written[0].type, "entity.confirmed");
    assert.equal(written[0].payload.entity, id);
    assert.equal(existsSync(join(ground.ws, ".superself", "projects", "demo", "instruction")), false);
    assert.equal(readdirSync(join(ground.ws, ".superself", "projects", "demo")).includes("instruction"), false);
});

test("A30: --why is on the record, and --label does not exist for the reserved spread to discard", async () =>
{
    const ground = await floor();
    const id = await add(ground, "a PR is never reviewed by its author", "rule",
        ["--why", "so a PR is never reviewed by its author"]);
    assert.equal(recordOf(ground.ws, id).payload.why, "so a PR is never reviewed by its author");
    assert.match((await must(ground.box, ground.demo, ["state", "show", id])).out,
        /so a PR is never reviewed by its author/);
    const refused = await ground.self(["instruction", "add", "y", "--kind", "rule", "--label", "worker"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown option '--label' — run `self instruction --help`/);
});

test("A31: the add has no keyboard gate — a person and a session both land, differing only in `by`", async () =>
{
    const ground = await floor();
    const typed = entityIn((await mustPerson(ground.box, ground.demo,
        ["instruction", "add", "a rule somebody recorded", "--kind", "rule", "--priority", "20"])).out);
    const driven = await add(ground, "a rule somebody recorded", "rule", ["--priority", "20"]);
    const written = [recordOf(ground.ws, typed).payload, recordOf(ground.ws, driven).payload];
    assert.equal(recordOf(ground.ws, typed).type, "entity.confirmed");
    assert.equal(recordOf(ground.ws, driven).type, "entity.confirmed");
    // The two records are the same record twice over, `by` excluded: the same
    // text, the same section, the same tier, the same scope, the same order.
    for (const field of ["text", "labels", "exposure", "scope", "priority"])
    {
        assert.deepEqual(written[0][field], written[1][field], `the two adds disagree on ${field}`);
    }
    assert.notDeepEqual(written[0].by, written[1].by);
    assert.equal(written[0].by.kind, "person");
    assert.equal(written[1].by.kind, "agent");
});

test("A32: after the skill refusal, the advertised `self instruction` answers with the instruction alone", async () =>
{
    const ground = await floor();
    await must(ground.box, ground.demo, ["skill", "add", "deploy", "--command", "make deploy", "--purpose", "ship"]);
    await add(ground, "tests run on the dev VM", "rule");
    const skill = entityIn((await must(ground.box, ground.demo, ["skill"])).out);
    assert.notEqual((await ground.self(["instruction", "add", "y", "--kind", "rule", "--supersedes", skill])).code, 0);
    const listed = await must(ground.box, ground.demo, ["instruction"]);
    assert.match(listed.out, /tests run on the dev VM/);
    assert.equal(listed.out.includes(skill), false, "the skill is listed as an instruction");
    assert.match(listed.out, /1 instruction/);
});

test("A33: a second --kind is refused by name, and nothing is recorded", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    const refused = await ground.self(["instruction", "add", "x", "--kind", "rule", "--kind", "tool"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out,
        /--kind states the one section this instruction renders under, and was passed twice/);
    assert.match(refused.out, /— pass rule, tool, or procedure once/);
    assert.equal(events(ground.ws).length, before);
});

test("A34: a text holding a line break is refused, and nothing is recorded", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    const text = "run the targeted suites, then commit and push\nthen watch CI";
    const refused = await ground.self(["instruction", "add", text, "--kind", "procedure"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out,
        /an instruction is one line — "run the targeted suites, then commit and…" holds a line break;/);
    assert.match(refused.out,
        /record each step as its own --kind procedure instruction, ordered by --priority/);
    // The refusal is itself one line: the quoted head is flattened, so the
    // break it is about is never printed into the reader's terminal.
    assert.equal(refused.out.trimEnd().split("\n").length, 1, refused.out);
    assert.equal(events(ground.ws).length, before);
    assert.equal((await must(ground.box, ground.demo, ["instruction"])).out.includes("targeted suites"), false);
});

test("A35: padding and a trailing newline record trimmed; a mid-text tab is refused like a line break", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    const padded = await add(ground, "  padded  ", "rule");
    assert.equal(recordOf(ground.ws, padded).payload.text, "padded");
    const trailed = await add(ground, "text\n", "rule");
    assert.equal(recordOf(ground.ws, trailed).payload.text, "text");
    const refused = await ground.self(["instruction", "add", "run\tthe suites", "--kind", "rule"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /an instruction is one line — "run the suites…" holds a line break;/);
    assert.match(refused.out,
        /record each step as its own --kind procedure instruction, ordered by --priority/);
    assert.equal(events(ground.ws).length, before + 2);
});

/* ── group A: the instruction cap (#446) ───────────────────────────── */

// The wording §D-15 decides, asserted whole rather than by a word a wrong
// refusal would also carry: the tier refusal it replaces holds "holds", "of",
// "tokens" and "this text adds <m> more" too, and differs only in which cap it
// names and which remedy it offers.
const CAP_REFUSAL = (held, cap, adding, scope = "project") =>
    `instructions hold ${held} of the ${cap}-token ${scope} instruction cap and this text adds ${adding}`
    + " more — retire or supersede one with a shorter text, or raise instructionTokens in config.json";

test("A36: an add past the instruction cap is refused against that cap, and records nothing", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, { instructionTokens: 30 });
    await add(ground, "tests run on the dev VM", "rule");
    const before = events(ground.ws).length;
    const refused = await ground.self(["instruction", "add", "a second standing rule here", "--kind", "rule"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes(CAP_REFUSAL(23, 30, 27)), refused.out);
    assert.equal(events(ground.ws).length, before);
    for (const word of ["--demote", "goal", "objective", "convention", "full tier", "index tier"])
    {
        assert.equal(refused.out.includes(word), false, `the refusal named ${word}:\n${refused.out}`);
    }
});

test("A37: --demote is not an option this verb has, and the help page names it nowhere", async () =>
{
    const ground = await floor();
    const seated = await add(ground, "tests run on the dev VM", "rule");
    const refused = await ground.self(["instruction", "add", "x", "--kind", "rule", "--demote", seated]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown option '--demote' — run `self instruction --help`/);
    const page = (await must(ground.box, ground.demo, ["help", "instruction"])).out;
    assert.equal(page.includes("--demote"), false, page);
});

test("A38: the instruction add lands at a full cap, and the tier's own refusal counts neither", async () =>
{
    const ground = await floor();
    // A 60-token full tier holding one 50-token ordinary record, and one
    // instruction the tier does not hold.
    await must(ground.box, ground.demo,
        ["state", "add", "an ordinary full record that is not an instruction", "--exposure", "full"]);
    setCaps(ground.ws, { fullTokens: 60 });
    await add(ground, "tests run on the dev VM", "rule");
    const refused = await ground.self(["state", "add", "one more full record", "--exposure", "full"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes("the project full tier holds 50 of 60 tokens and this text adds 20 more"),
        refused.out);
});

test("A39: raising instructionTokens in config.json admits the add the cap refused", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, { instructionTokens: 30 });
    await add(ground, "tests run on the dev VM", "rule");
    assert.notEqual((await ground.self(
        ["instruction", "add", "a second standing rule here", "--kind", "rule"])).code, 0);
    setCaps(ground.ws, { instructionTokens: 200 });
    const id = await add(ground, "a second standing rule here", "rule");
    assert.match((await must(ground.box, ground.demo, ["instruction", "render"])).out,
        /- a second standing rule here/);
    assert.equal(recordOf(ground.ws, id).type, "entity.confirmed");
});

test("A40: the raw verb follows the label — a labelled add lands at a full tier's cap", async () =>
{
    const ground = await floor();
    await must(ground.box, ground.demo,
        ["state", "add", "an ordinary full record that is not an instruction", "--exposure", "full"]);
    setCaps(ground.ws, { fullTokens: 60 });
    const landed = await must(ground.box, ground.demo,
        ["state", "add", "a raw note the label makes an instruction", "--label", "instruction", "--exposure", "full"]);
    assert.equal(landed.code, 0);
    assert.match((await must(ground.box, ground.demo, ["instruction", "render"])).out,
        /- a raw note the label makes an instruction/);
});

test("A41: the raw verb is judged by the instruction cap, and a preset label beside it is not", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, { instructionTokens: 30, fullTokens: 1000 });
    await add(ground, "tests run on the dev VM", "rule");
    const refused = await ground.self(
        ["state", "add", "a raw note the label makes one", "--label", "instruction", "--exposure", "full"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes(CAP_REFUSAL(23, 30, 30)), refused.out);
    // `sourceOf` reads the convention label, so `source !== undefined` and the
    // predicate rejects it: it is a convention, and it charges the full tier.
    const convention = await must(ground.box, ground.demo, ["state", "add", "a raw note the label makes one",
        "--label", "instruction", "--label", "convention", "--exposure", "full"]);
    assert.equal(convention.code, 0);
});

test("A42: --demote on a raw instruction add is refused toward the room that does exist", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, { instructionTokens: 30, fullTokens: 1000 });
    const seated = await must(ground.box, ground.demo,
        ["state", "add", "an ordinary full record here", "--exposure", "full"]);
    const before = events(ground.ws).length;
    const refused = await ground.self(["state", "add", "a raw note the label makes one", "--label", "instruction",
        "--exposure", "full", "--demote", entityIn(receiptIn(seated.out))]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes("--demote frees room in a retention tier and an instruction charges none"
        + " — retire or supersede an instruction with a shorter text, or raise instructionTokens in config.json"),
        refused.out);
    assert.equal(events(ground.ws).length, before);
});

/* ── group B: reading the list ─────────────────────────────────────── */


test("B1: a project with no instructions says so and names the verb that records one", async () =>
{
    const ground = await floor();
    const listed = await must(ground.box, ground.demo, ["instruction"]);
    assert.equal(listed.code, 0);
    assert.match(listed.out, /no instructions recorded/);
    assert.match(listed.out, /self instruction add "<text>" --kind rule\|tool\|procedure/);
});

test("B2: the bare verb and `list` print the same bytes — one is not a second page", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    const bare = await must(ground.box, ground.demo, ["instruction"]);
    const listed = await must(ground.box, ground.demo, ["instruction", "list"]);
    assert.equal(bare.out, listed.out);
});

test("B3: the listing groups Tools, Rules, Procedures in that order, by priority inside each", async () =>
{
    const ground = await floor();
    await add(ground, "a rule", "rule", ["--priority", "20"]);
    await add(ground, "a tool note", "tool", ["--priority", "10"]);
    await add(ground, "a procedure", "procedure", ["--priority", "30"]);
    await add(ground, "an earlier rule", "rule", ["--priority", "5"]);
    const out = (await must(ground.box, ground.demo, ["instruction"])).out;
    const rows = out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    const headings = rows.filter((line) => ["Tools", "Rules", "Procedures"].includes(line));
    assert.deepEqual(headings, ["Tools", "Rules", "Procedures"]);
    assert.ok(rows.findIndex((line) => line.includes("an earlier rule"))
        < rows.findIndex((line) => line.includes("a rule")), "priority 5 did not read before priority 20");
});

test("B4: a priority tie falls to orderEntities — scope, then newer `ts`, then id", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    const own = await add(ground, "the project's own rule", "rule", ["--priority", "20"]);
    const shared = await add(ground, "the workspace rule", "rule", ["--priority", "20", "--workspace"]);
    // The second and third legs need a stated `ts`: the pair that shares one is
    // where the id is the only tie-break left, and two CLI adds never share it.
    const older = ruleFixture(ground, "the older project rule", "2026-08-01T00:00:00.000Z", "e-bbbb1");
    const newer = ruleFixture(ground, "the newer project rule", "2026-08-02T00:00:00.000Z", "e-bbbb2");
    const lower = ruleFixture(ground, "one of a pair minted together", "2026-07-01T00:00:00.000Z", "e-aaaa1");
    const higher = ruleFixture(ground, "the other of that pair", "2026-07-01T00:00:00.000Z", "e-aaaa2");
    const out = (await must(ground.box, ground.demo, ["instruction"])).out;
    const at = (id) => out.indexOf(id);
    assert.ok(at(shared) < at(own), "the workspace record did not sort first at equal priority");
    assert.ok(at(newer) < at(older), "the newer record did not sort above the older one at equal priority and scope");
    assert.ok(at(lower) < at(higher), "the id did not break the tie two records sharing a `ts` leave");
    assert.deepEqual([at(shared), at(own), at(newer), at(older), at(lower), at(higher)]
        .filter((position) => position === -1), [], out);
});

test("B5: an unmeasured store says its token total is an estimate, and how to measure it", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    const out = (await must(ground.box, ground.demo, ["instruction"])).out;
    assert.match(out, /^instructions hold \d+ tokens — \d+ of the \d+-token project instruction cap \(\d+%\)/m);
    assert.match(out, / \(estimated at [0-9.]+ tokens per character; `self tokens` records a measurement\)$/m);
});

test("B6: once `self tokens` records a measurement the estimate note is gone", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["tokens", "10", "40"]);
    const out = (await must(ground.box, ground.demo, ["instruction"])).out;
    assert.match(out, /^instructions hold \d+ tokens — \d+ of the \d+-token project instruction cap \(\d+%\)$/m);
    assert.equal(out.includes("estimated at"), false, out);
});

test("B7: the closing line states the share of the instruction cap the instructions occupy", async () =>
{
    const ground = await floor();
    const other = await sibling(ground, "other");
    setCaps(ground.ws, {});
    // Recorded from demo and scoped into `other`, then listed from `other`: the
    // tier the share is about is that project's own, and `scopeLabel` is what
    // spells it — the project a listing is standing in is `project`, wherever
    // the record's log sits.
    await add(ground, "tests run on the dev VM", "rule", ["--scope", "other"]);
    const out = (await must(ground.box, other, ["instruction"])).out;
    assert.match(out, /^instructions hold 23 tokens — 23 of the 2000-token project instruction cap \(1%\)$/m);
    assert.equal(out.includes("other instruction cap"), false, out);
    assert.equal(out.includes("full cap"), false, out);
});

test("B8: a raised instructionTokens is the cap the share is against", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, { instructionTokens: 4000, fullTokens: 1000 });
    await add(ground, "tests run on the dev VM", "rule");
    const out = (await must(ground.box, ground.demo, ["instruction"])).out;
    assert.match(out, /^instructions hold 23 tokens — 23 of the 4000-token project instruction cap \(1%\)$/m);
    assert.equal(out.includes("2000-token"), false, out);
    assert.equal(out.includes("1000-token"), false, out);
});

test("B9: a project set and a workspace manual get one share line each, neither counting the other", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    setCaps(ground.ws, {});
    await add(ground, "tests run on the dev VM", "rule");
    await add(ground, "reviewed before merge", "rule", ["--workspace"]);
    const out = (await must(ground.box, ground.demo, ["instruction"])).out;
    assert.match(out, /^instructions hold 23 tokens — 23 of the 2000-token project instruction cap \(1%\)$/m);
    assert.match(out, /^instructions hold 21 tokens — 21 of the 2000-token workspace instruction cap \(1%\)$/m);
    assert.equal(out.includes("44 tokens"), false, "the two caps were added together");
});

test("B10: --json on the listing is refused by name, as a JSON envelope on stdout", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    const refused = await ground.self(["instruction", "list", "--json"]);
    assert.notEqual(refused.code, 0);
    const envelope = JSON.parse(refused.out.trim());
    assert.equal(envelope.error.code, "json_unsupported");
    assert.equal(envelope.error.message, "`self instruction list` has no --json contract yet");
    assert.equal(envelope.error.hint, "read the human output, or use a command that declares --json");
});

test("B11: SUPERSELF_JSON=1 is ignored on a leaf with no payload contract", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    const listed = await must(ground.box, ground.demo, ["instruction", "list"], { SUPERSELF_JSON: "1" });
    assert.equal(listed.code, 0);
    assert.match(listed.out, /tests run on the dev VM/);
    assert.match(listed.out, /1 instruction/);
});

test("B12: only the confirmed, current, full-exposure one is listed and counted", async () =>
{
    const ground = await floor();
    const live = await add(ground, "the one that holds", "rule");
    await add(ground, "a proposal", "rule", ["--proposed"]);
    const replaced = await add(ground, "the old wording", "rule");
    await add(ground, "the new wording", "rule", ["--supersedes", replaced]);
    const withdrawn = await add(ground, "withdrawn later", "rule");
    await must(ground.box, ground.demo, ["state", "retract", withdrawn, "--why", "no longer holds"]);
    const demoted = await add(ground, "quieter now", "rule");
    await must(ground.box, ground.demo, ["state", "place", demoted, "--exposure", "index", "--why", "narrower"]);
    const out = (await must(ground.box, ground.demo, ["instruction"])).out;
    for (const gone of ["a proposal", "the old wording", "withdrawn later", "quieter now"])
    {
        assert.equal(out.includes(gone), false, `${gone} is still listed`);
    }
    assert.match(out, /the one that holds/);
    assert.match(out, /the new wording/);
    assert.match(out, /^2 instructions$/m);
    assert.ok(out.includes(live), out);
});

test("B13: a demoted instruction leaves the listing and returns to the context index", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "index", "--why", "narrower"]);
    const listed = await must(ground.box, ground.demo, ["instruction"]);
    assert.equal(listed.out.includes("tests run on the dev VM"), false);
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.match(context, /## Index/);
    assert.match(context, /- \[instruction, rule\] tests run on the dev VM/);
});

test("B14: the listing outside every registered project is refused", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["instruction"], ground.ws);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /not inside a registered project — run `self project init` here to register it/);
});

// The harness merges stdout and stderr into one string, so which stream the
// line came out on is not provable in this process — the table says so under
// group B. What is provable, and what this asserts, is that the sentence is
// printed and the answer still stands.
test("B15: one unreadable store is named on stderr and the readable ones still answer", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    const third = await sibling(ground, "third");
    await must(ground.box, third, ["instruction", "add", "reviewed before merge", "--kind", "rule", "--workspace"]);
    appendFileSync(join(ground.ws, ".superself", "projects", "other", "log.jsonl"), "not an event\n");
    const listed = await ground.self(["instruction"]);
    assert.equal(listed.code, 0, listed.out);
    assert.match(listed.out, /reviewed before merge/);
    assert.match(listed.out, /project "other" is left out of this answer — its state could not be read/);
});

test("B16: the line the empty listing advertises records an instruction the listing then shows", async () =>
{
    const ground = await floor();
    assert.match((await must(ground.box, ground.demo, ["instruction"])).out,
        /self instruction add "<text>" --kind rule\|tool\|procedure/);
    await must(ground.box, ground.demo, ["instruction", "add", "tests run on the dev VM", "--kind", "rule"]);
    assert.match((await must(ground.box, ground.demo, ["instruction"])).out, /tests run on the dev VM/);
});

test("B17: --project is not an option on the listing — another project's set is read by rendering it", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    const refused = await ground.self(["instruction", "list", "--project", "other"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown option '--project' — run `self instruction --help`/);
    assert.equal((await must(ground.box, ground.demo, ["instruction", "render", "--project", "other"])).code, 0);
});

test("B18: the share line counts the instructions alone, not what the tier holds", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, {});
    await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo,
        ["state", "add", "an ordinary full record that is not an instruction", "--exposure", "full"]);
    const out = (await must(ground.box, ground.demo, ["instruction"])).out;
    assert.match(out, /^instructions hold 23 tokens — 23 of the 2000-token project instruction cap \(1%\)$/m);
    assert.equal(out.includes("an ordinary full record"), false, out);
    // What the full tier holds is the ordinary record's 50 — not the 73 the two
    // of them made when an instruction charged the tier, and not the 23 above.
    setCaps(ground.ws, { fullTokens: 60 });
    const refused = await ground.self(["state", "add", "one more full record", "--exposure", "full"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 50 of 60 tokens/);
    assert.equal(refused.out.includes("holds 73"), false, refused.out);
});

test("B19: the estimate note closes the last share line and is said once", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    await add(ground, "tests run on the dev VM", "rule");
    await add(ground, "reviewed before merge", "rule", ["--workspace"]);
    const out = (await must(ground.box, ground.demo, ["instruction"])).out;
    const shares = out.split("\n").filter((line) => line.startsWith("instructions hold "));
    assert.equal(shares.length, 2, out);
    assert.equal(out.split("estimated at").length - 1, 1, out);
    assert.match(shares.at(-1),
        / \(estimated at [0-9.]+ tokens per character; `self tokens` records a measurement\)$/);
    assert.match(shares[0], /\(\d+%\)$/);
});

test("B20: an unknown leaf under `instruction` is refused with the branch usage", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["instruction", "bogus"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out,
        /usage: self instruction \| add "<text>" --kind rule\|tool\|procedure \| render \[--project <slug>\]/);
});

test("B21: each occupied target gets its own instruction-cap share, counting nothing else", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    setCaps(ground.ws, {});
    await add(ground, "tests run on the dev VM", "rule");
    await add(ground, "reviewed first", "rule", ["--workspace"]);
    // One ordinary full record in each of the two tiers the instructions do
    // not charge, so a share that read tier occupancy would print a larger one.
    await must(ground.box, ground.demo,
        ["state", "add", "an ordinary full record that is not an instruction", "--exposure", "full"]);
    await must(ground.box, ground.demo, ["state", "add", "a workspace-scoped ordinary record",
        "--exposure", "full", "--scope", "workspace"]);
    const out = (await must(ground.box, ground.demo, ["instruction"])).out;
    assert.match(out, /^instructions hold 23 tokens — 23 of the 2000-token project instruction cap \(1%\)$/m);
    assert.match(out, /^instructions hold 14 tokens — 14 of the 2000-token workspace instruction cap \(1%\)$/m);
    assert.equal(out.split("instructions hold ").length - 1, 2, out);
});

test("B22: neither tier's refusal counts an instruction, at full or at index", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, {});
    const demoted = await add(ground, "tests run on the dev VM", "rule");
    await add(ground, "reviewed first", "rule");
    await must(ground.box, ground.demo, ["state", "place", demoted, "--exposure", "index", "--why", "narrower"]);
    await must(ground.box, ground.demo,
        ["state", "add", "an ordinary full record that is not an instruction", "--exposure", "full"]);
    await must(ground.box, ground.demo, ["state", "add", "an index note"]);
    setCaps(ground.ws, { fullTokens: 60, indexTokens: 20 });
    const atFull = await ground.self(["state", "add", "one more full record", "--exposure", "full"]);
    assert.notEqual(atFull.code, 0);
    assert.ok(atFull.out.includes("the project full tier holds 50 of 60 tokens"), atFull.out);
    const atIndex = await ground.self(["state", "add", "one more index note"]);
    assert.notEqual(atIndex.code, 0);
    assert.ok(atIndex.out.includes("the project index tier holds 13 of 20 tokens"), atIndex.out);
});

/* ── group G: the one surface cell that needs a store ──────────────── */

// Cell G13 of the table. It stands here rather than in structure.test.mjs,
// which reaches no CLI: the claim is about what a fold leaves on disk, and
// A29 above drives the same store for the other half of it. The rest of group
// G is in docs.test.mjs, guide.test.mjs, handoff.test.mjs, golden.test.mjs,
// structure.test.mjs, pr7-loader.test.mjs and the dsh plugin's own suite.
test("G13: a fold over a store holding instructions leaves FOLD_VERSION at 1 and mints no directory", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    await add(ground, "`self report` carries --friction", "tool");
    await must(ground.box, ground.demo, ["fold"]);
    const state = join(ground.ws, ".superself", "projects", "demo");
    assert.equal(readdirSync(state).includes("instruction"), false, readdirSync(state).join(", "));
    assert.equal(readdirSync(state).includes("instructions"), false, readdirSync(state).join(", "));
    assert.equal(FOLD_VERSION, 1, "the fold version moved for a record kind composed out of the existing grammar");
});
