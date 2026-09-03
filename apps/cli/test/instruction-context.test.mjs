// What an instruction does to the surfaces around it, and what happens to one
// over its life (#440).
//
// Every test below is one cell of the case table in
// docs/maintainers/case-tables/440-instructions.md, named by its cell id, and
// asserts that cell's stated outcome. Group D (context, search, handoff and
// the plugin) and group F (lifecycle) land here; the add and the listing are in
// instruction.test.mjs, the render in instruction-render.test.mjs, and
// placement in instruction-place.test.mjs.
//
// The rulings these groups stand on:
//
//   D1  a full-exposure instruction is not in the context projection at all —
//       one conditional predicate beside `isRunbookRun` and `isSkill`
//   D2  because the predicate is conditional, a demoted instruction falls back
//       into the ordinary index block with no further code
//   D3  `self search`'s default set is every live record the context render
//       does not show, so a full-exposure instruction is in it; its kind there
//       is `entity`, like every label-composed record
//   D4  the handoff packet carries the render as a mandatory uncapped section
//       between the conventions and the capped context subsection
//   F1  the lifecycle verbs are the ones every record already has: retract,
//       show --history, undo, confirm. Nothing here is new
//   F2  since #400 `state retract` discloses and proceeds — a session's
//       withdrawal lands, with what it destroys printed first
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, git, idIn, machine, must, receiptIn, selfIn, workIdIn } from "./harness.mjs";

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

// A work unit to hand over, for the packet cells.
async function unit(ground)
{
    return workIdIn((await must(ground.box, ground.demo, ["work", "add", "compile a packet"])).out);
}

function setCaps(ws, caps)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

// One packet section, from its heading to the blank line after its end marker.
function section(packet, heading)
{
    const from = packet.indexOf(`## ${heading}\n`);
    assert.notEqual(from, -1, `the packet has no ## ${heading}`);
    const rest = packet.slice(from);
    const end = rest.indexOf("\n\n");
    return end === -1 ? rest : rest.slice(0, end);
}

/* ── group D: context, search, the handoff and the plugin ──────────── */

test("D1: a full-exposure instruction's text appears nowhere in `self context`", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.equal(context.includes("tests run on the dev VM"), false, context);
    assert.equal(context.includes("[instruction, rule]"), false, context);
});

test("D2: the same record demoted to index is one ordinary index line", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "index", "--why", "narrower"]);
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.match(context, /- \[instruction, rule\] tests run on the dev VM/);
});

test("D3: default search finds it, and so does --type entity — a composed record's kind", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    assert.match((await must(ground.box, ground.demo, ["search", "dev VM"])).out, /tests run on the dev VM/);
    assert.match((await must(ground.box, ground.demo, ["search", "dev VM", "--type", "entity"])).out,
        /tests run on the dev VM/);
});

test("D4: --type instruction is refused — the kind list is the record kinds", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    const refused = await ground.self(["search", "dev", "--type", "instruction"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out,
        /unknown record kind "instruction" — pass one of goal, decision, convention, objective, milestone, work, entity/);
});

test("D5: once demoted, context shows it and the default search set no longer does", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "index", "--why", "narrower"]);
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.match(context, /- \[instruction, rule\] tests run on the dev VM/);
    const found = await must(ground.box, ground.demo, ["search", "dev VM"]);
    assert.equal(found.out.includes(id), false, found.out);
    assert.match((await must(ground.box, ground.demo, ["search", "dev VM", "--all"])).out, /tests run on the dev VM/);
});

test("D6: the packet's capped context subsection carries no line holding the instruction", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    const work = await unit(ground);
    const packet = (await must(ground.box, ground.demo, ["handoff", work])).out;
    assert.equal(section(packet, "Current project context").includes("tests run on the dev VM"), false);
});

test("D7: the packet carries ## Instructions between the conventions and the context", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    await add(ground, "`self report` carries --friction", "tool");
    await add(ground, "targeted suites, then commit, then CI", "procedure");
    const work = await unit(ground);
    const packet = (await must(ground.box, ground.demo, ["handoff", work])).out;
    assert.ok(packet.indexOf("## Applicable conventions") < packet.indexOf("## Instructions"), packet);
    assert.ok(packet.indexOf("## Instructions") < packet.indexOf("## Current project context"), packet);
    // The block is the render, line for line under the prefix — the packet and
    // the command read through one helper, and this is what says so.
    const rendered = (await must(ground.box, ground.demo, ["instruction", "render"])).out;
    const block = section(packet, "Instructions").split("\n");
    assert.equal(block[1], "--- BEGIN INSTRUCTIONS (renderer-owned) ---");
    assert.equal(block.at(-1), "--- END INSTRUCTIONS (renderer-owned) ---");
    assert.deepEqual(block.slice(2, -1).map((line) => line.replace(/^INSTRUCTION \| /, "")),
        rendered.replace(/\n$/, "").split("\n"));
    for (const line of block.slice(2, -1))
    {
        assert.match(line, /^INSTRUCTION \| /, line);
    }
});

test("D8: the snapshot limits name the instructions among the uncapped sections", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    const work = await unit(ground);
    const packet = (await must(ground.box, ground.demo, ["handoff", work])).out;
    assert.ok(packet.includes(
        "Protocol, instructions, conventions, work, and reports are mandatory and are not silently truncated."),
    packet);
});

test("D9: the conventions closure is unchanged — it holds the convention and not the instruction", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["convention", "add", "a prose rule the packet carries"]);
    const work = await unit(ground);
    const packet = (await must(ground.box, ground.demo, ["handoff", work])).out;
    const conventions = section(packet, "Applicable conventions");
    assert.match(conventions, /a prose rule the packet carries/);
    assert.equal(conventions.includes("tests run on the dev VM"), false, conventions);
});

// The dsh `superself_context` tool is `self context` and nothing else — the
// argv mapping is asserted in apps/dsh-plugin/test/tools.test.mjs — so what
// this cell is about is whether those bytes moved. D11, whose subject is the
// plugin's own tool table, is asserted in that suite for the same reason.
test("D10: the plugin's context tool is untouched by an instruction in the store", async () =>
{
    const ground = await floor();
    const bare = (await must(ground.box, ground.demo, ["context"])).out;
    await add(ground, "tests run on the dev VM", "rule");
    const after = (await must(ground.box, ground.demo, ["context"])).out;
    assert.equal(after, bare, "the context tool's own output moved when an instruction was recorded");
});

test("D12: over both caps, the index rows and the render both print whole and the add stays gated", async () =>
{
    const ground = await floor();
    await add(ground, "tests run on the dev VM", "rule");
    await add(ground, "a PR gets a cross-model review", "rule");
    await must(ground.box, ground.demo, ["state", "add", "the first index note"]);
    await must(ground.box, ground.demo, ["state", "add", "the second index note"]);
    setCaps(ground.ws, { fullTokens: 20, indexTokens: 20 });
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.match(context, /- the first index note/);
    assert.match(context, /- the second index note/);
    const rendered = (await must(ground.box, ground.demo, ["instruction", "render"])).out;
    assert.match(rendered, /- tests run on the dev VM/);
    assert.match(rendered, /- a PR gets a cross-model review/);
    const refused = await ground.self(["state", "add", "a third index note"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project index tier holds \d+ of 20 tokens/);
});

test("D13: a --workspace instruction is out of every context and in every render", async () =>
{
    const ground = await floor();
    const other = await sibling(ground, "other");
    const third = await sibling(ground, "third");
    await add(ground, "every project reviews before merge", "rule", ["--workspace"]);
    for (const cwd of [ground.demo, other, third])
    {
        const context = (await must(ground.box, cwd, ["context"])).out;
        assert.equal(context.includes("every project reviews before merge"), false, context);
        assert.match((await must(ground.box, cwd, ["instruction", "render"])).out,
            /- every project reviews before merge/);
    }
});

test("D14: a project with no instructions hands over a section that reads `(none)`", async () =>
{
    const ground = await floor();
    const work = await unit(ground);
    const packet = (await must(ground.box, ground.demo, ["handoff", work])).out;
    // The head line alone is an empty render (§D-3), and the packet drops it:
    // an empty section reads the way every other empty section of the packet
    // reads, rather than looking populated to the session that gets it.
    assert.deepEqual(section(packet, "Instructions").split("\n"), [
        "## Instructions",
        "--- BEGIN INSTRUCTIONS (renderer-owned) ---",
        "DATA | (none)",
        "--- END INSTRUCTIONS (renderer-owned) ---"
    ]);
    assert.equal(packet.includes("INSTRUCTION | "), false, packet);
});

// The behaviour change this verb makes to a store that already used the word:
// `instruction` is a free label, and a store that recorded one before this
// release now has a record the context render leaves out. Accepted — the label
// is the mechanism — and pinned here so it is visible rather than discovered.
test("D15: a pre-existing `instruction` label leaves `self context` and enters the render", async () =>
{
    const ground = await floor();
    await must(ground.box, ground.demo,
        ["state", "add", "an older standing rule", "--label", "instruction", "--exposure", "full"]);
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.equal(context.includes("an older standing rule"), false, context);
    assert.match((await must(ground.box, ground.demo, ["instruction", "render"])).out,
        /## Unclassified\n- an older standing rule/);
    assert.match((await must(ground.box, ground.demo, ["search", "older standing"])).out,
        /an older standing rule/);
});

/* ── group F: the life of one instruction ──────────────────────────── */

test("F1: a retraction takes it out of the render, the listing, context and default search", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "index", "--why", "so context shows it"]);
    await must(ground.box, ground.demo, ["state", "retract", id, "--why", "the VM moved"]);
    for (const args of [["instruction", "render"], ["instruction"], ["context"], ["search", "dev VM"]])
    {
        const answered = await must(ground.box, ground.demo, args);
        assert.equal(answered.out.includes("tests run on the dev VM"), false, `${args.join(" ")}: ${answered.out}`);
    }
});

test("F2: a retraction with no --why is refused by the requirement gate", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    const refused = await ground.self(["state", "retract", id]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /self state retract needs --why: why the record no longer holds/);
});

test("F3: the disclosure names the record as an instruction, and quotes what it says", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    const out = (await must(ground.box, ground.demo, ["state", "retract", id, "--why", "the VM moved"])).out;
    assert.match(out, /this takes back a confirmed instruction — `self undo` takes it back/);
    assert.match(out, new RegExp(`${id} {2}instruction {2}confirmed \\S+ {2}\\(.+\\)`));
    assert.match(out, /tests run on the dev VM/);
    assert.ok(out.indexOf("takes back a confirmed instruction") < out.indexOf("entity.retracted recorded"), out);
});

test("F4: the `self undo` the retraction advertises takes it back, and it renders again", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    const out = (await must(ground.box, ground.demo, ["state", "retract", id, "--why", "the VM moved"])).out;
    await must(ground.box, ground.demo, ["undo", idIn(out)]);
    assert.match((await must(ground.box, ground.demo, ["instruction", "render"])).out, /- tests run on the dev VM/);
});

test("F5: a session with no keyboard retracts, with the disclosure printed", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    const out = await must(ground.box, ground.demo, ["state", "retract", id, "--why", "the VM moved"]);
    assert.equal(out.code, 0);
    assert.match(out.out, /this takes back a confirmed instruction/);
    assert.match((await must(ground.box, ground.demo, ["state", "show", id])).out, /retracted/);
});

test("F6: `state show` prints the ordinary entity page — labels, placement and the why", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule", ["--why", "the laptop is not the target"]);
    const page = (await must(ground.box, ground.demo, ["state", "show", id])).out;
    assert.match(page, /tests run on the dev VM/);
    assert.match(page, /instruction, rule/);
    assert.match(page, /placement: project · full/);
    assert.match(page, /the laptop is not the target/);
});

test("F7: `--history` prints that record's own events, oldest first", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "index", "--why", "narrower"]);
    await must(ground.box, ground.demo, ["state", "retract", id, "--why", "the VM moved"]);
    const history = (await must(ground.box, ground.demo, ["state", "show", id, "--history"])).out;
    const seen = ["entity.confirmed", "entity.placed", "entity.retracted"]
        .map((type) => history.indexOf(type));
    assert.equal(seen.some((at) => at === -1), false, history);
    assert.deepEqual([...seen].sort((left, right) => left - right), seen, history);
});

test("F8: a chain of three renders only its head, and the first names its successor", async () =>
{
    const ground = await floor();
    const first = await add(ground, "tests run locally", "rule");
    const second = await add(ground, "tests run on the build box", "rule", ["--supersedes", first]);
    await add(ground, "tests run on the dev VM", "rule", ["--supersedes", second]);
    const rendered = (await must(ground.box, ground.demo, ["instruction", "render"])).out;
    assert.match(rendered, /- tests run on the dev VM/);
    assert.equal(rendered.includes("tests run locally"), false);
    assert.equal(rendered.includes("tests run on the build box"), false);
    assert.match((await must(ground.box, ground.demo, ["state", "show", first, "--history"])).out,
        new RegExp(second));
});

test("F9: undoing the successor's add leaves the predecessor live and rendering", async () =>
{
    const ground = await floor();
    const first = await add(ground, "tests run locally", "rule");
    const written = await must(ground.box, ground.demo,
        ["instruction", "add", "tests run on the dev VM", "--kind", "rule", "--supersedes", first]);
    await must(ground.box, ground.demo, ["undo", idIn(written.out)]);
    const rendered = (await must(ground.box, ground.demo, ["instruction", "render"])).out;
    assert.match(rendered, /- tests run locally/);
    assert.equal(rendered.includes("tests run on the dev VM"), false);
});

test("F10: undoing a first instruction's add takes it out of the render and the listing", async () =>
{
    const ground = await floor();
    const written = await must(ground.box, ground.demo,
        ["instruction", "add", "tests run on the dev VM", "--kind", "rule"]);
    await must(ground.box, ground.demo, ["undo", idIn(written.out)]);
    assert.equal((await must(ground.box, ground.demo, ["instruction", "render"])).out
        .includes("tests run on the dev VM"), false);
    assert.match((await must(ground.box, ground.demo, ["instruction"])).out, /no instructions recorded/);
});

test("F11: undoing the retraction puts the instruction back in the render", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    const out = (await must(ground.box, ground.demo, ["state", "retract", id, "--why", "the VM moved"])).out;
    await must(ground.box, ground.demo, ["undo", idIn(out)]);
    assert.match((await must(ground.box, ground.demo, ["instruction", "render"])).out, /- tests run on the dev VM/);
});

test("F12: --supersession takes back the claim alone, and both versions render", async () =>
{
    const ground = await floor();
    const first = await add(ground, "tests run locally", "rule");
    const written = await must(ground.box, ground.demo,
        ["instruction", "add", "tests run on the dev VM", "--kind", "rule", "--supersedes", first]);
    const second = entityIn(receiptIn(written.out));
    const undone = await must(ground.box, ground.demo, ["undo", idIn(written.out), "--supersession"]);
    assert.match(undone.out,
        new RegExp(`${second} stands and no longer claims to replace anything — its supersession was taken back`));
    const rendered = (await must(ground.box, ground.demo, ["instruction", "render"])).out;
    assert.match(rendered, /- tests run on the dev VM/);
    assert.match(rendered, /- tests run locally/);
});

test("F13: a confirm lands a proposed instruction, and a second confirm is refused", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule", ["--proposed"]);
    await must(ground.box, ground.demo, ["state", "confirm", id]);
    assert.match((await must(ground.box, ground.demo, ["instruction", "render"])).out, /- tests run on the dev VM/);
    const again = await ground.self(["state", "confirm", id]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already confirmed/);
});

test("F14: a confirm past the cap is refused, and the line it advertises lets it land", async () =>
{
    const ground = await floor();
    const proposed = await add(ground, "tests run on the dev VM", "rule", ["--proposed"]);
    const seated = await add(ground, "a PR gets a cross-model review", "rule");
    setCaps(ground.ws, { fullTokens: 33 });
    const refused = await ground.self(["state", "confirm", proposed]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /confirming this would put the project full tier over its cap \(\d+ of 33 tokens held\)/);
    assert.match(refused.out, /free room first with `self state place <id> --exposure index --why "<reason>"`/);
    await must(ground.box, ground.demo, ["state", "place", seated, "--exposure", "index", "--why", "make room"]);
    await must(ground.box, ground.demo, ["state", "confirm", proposed]);
    assert.match((await must(ground.box, ground.demo, ["instruction", "render"])).out, /- tests run on the dev VM/);
});

test("F15: a retracted instruction refuses a second retraction and refuses to be superseded", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "retract", id, "--why", "the VM moved"]);
    const again = await ground.self(["state", "retract", id, "--why", "again"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, new RegExp(`${id} was already retracted`));
    const superseding = await ground.self(["instruction", "add", "a successor", "--kind", "rule", "--supersedes", id]);
    assert.notEqual(superseding.code, 0);
    assert.match(superseding.out, new RegExp(`${id} was already retracted — nothing is left to supersede`));
});
