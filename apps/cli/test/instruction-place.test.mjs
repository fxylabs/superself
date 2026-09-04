// `state place` against an instruction (#440): the placement verb every record
// already has, driven over the one record kind whose full exposure means
// "rendered by a different command".
//
// Every test below is one cell of group E of the case table in
// docs/maintainers/case-tables/440-instructions.md, named by its cell id, and
// asserts that cell's stated outcome. The add and the listing are in
// instruction.test.mjs, the render in instruction-render.test.mjs, and context,
// search, the handoff and the lifecycle in instruction-context.test.mjs.
//
// The rulings this group stands on:
//
//   R1  nothing about placement is new. `statePlace` demands `--why` on a
//       demotion, refuses demoting a proposal, and reads no keyboard
//   R2  "demotion out of full is human-owned" is help prose, not a gate: an
//       agent that omits `--proposed` demotes directly (E4)
//   R3  demoting an instruction out of `full` moves it from
//       `instruction render` into `self context`'s index block, and promoting
//       it back moves it the other way — one conditional predicate does both
//   R4  a record scoped in from another project resolves here and its
//       `entity.placed` lands in its home log
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, git, idIn, machine, must, mustPerson, receiptIn, selfIn } from "./harness.mjs";

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
    return entityIn(receiptIn((await must(ground.box, cwd,
        ["instruction", "add", text, "--kind", kind, ...extra])).out));
}

async function render(ground, cwd = ground.demo)
{
    return (await must(ground.box, cwd, ["instruction", "render"])).out;
}

async function context(ground, cwd = ground.demo)
{
    return (await must(ground.box, cwd, ["context"])).out;
}

function events(ws, slug)
{
    const file = join(ws, ".superself", "projects", slug, "log.jsonl");
    return !existsSync(file) ? [] : readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function setCaps(ws, caps)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

/* ── group E: moving one ───────────────────────────────────────────── */

test("E1: a person's demotion lands directly and moves the record out of the render", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await mustPerson(ground.box, ground.demo,
        ["state", "place", id, "--exposure", "index", "--why", "narrower than it looked"]);
    assert.match((await must(ground.box, ground.demo, ["state", "show", id])).out, /placement: project · index/);
    assert.equal((await render(ground)).includes("tests run on the dev VM"), false);
    assert.match(await context(ground), /- \[instruction, rule\] tests run on the dev VM/);
});

test("E2: a session's --proposed demotion moves nothing and waits on the confirm", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo,
        ["state", "place", id, "--exposure", "index", "--why", "narrower than it looked", "--proposed"]);
    const shown = (await must(ground.box, ground.demo, ["state", "show", id])).out;
    assert.match(shown, /placement: project · full/);
    assert.match(shown, /pending placement: exposure index \(narrower than it looked\)/);
    assert.match(shown, new RegExp(`confirm with \`self state confirm ${id}\``));
    assert.match(await context(ground),
        new RegExp(`proposed placement of ${id}: exposure index \\(narrower than it looked\\)`));
    assert.match(await render(ground), /- tests run on the dev VM/);
});

test("E3: the advertised confirm lands the demotion, and a second confirm is refused", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo,
        ["state", "place", id, "--exposure", "index", "--why", "narrower than it looked", "--proposed"]);
    await must(ground.box, ground.demo, ["state", "confirm", id]);
    assert.match((await must(ground.box, ground.demo, ["state", "show", id])).out, /placement: project · index/);
    assert.equal((await render(ground)).includes("tests run on the dev VM"), false);
    assert.match(await context(ground), /- \[instruction, rule\] tests run on the dev VM/);
    const again = await ground.self(["state", "confirm", id]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already confirmed/);
});

test("E4: a session that omits --proposed demotes directly — nothing gates the actor", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    const placed = await must(ground.box, ground.demo,
        ["state", "place", id, "--exposure", "index", "--why", "narrower than it looked"]);
    assert.equal(placed.code, 0);
    assert.match((await must(ground.box, ground.demo, ["state", "show", id])).out, /placement: project · index/);
});

test("E5: a demotion with no --why is refused, and says why a reason is owed", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    const refused = await ground.self(["state", "place", id, "--exposure", "index"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`demoting ${id} from full to index needs --why "<reason>"`));
    assert.match(refused.out, /a record leaves the rendered set only with its reason on record/);
});

test("E6: a proposal renders nowhere, so it is refused a demotion and told what to do", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule", ["--proposed"]);
    const refused = await ground.self(["state", "place", id, "--exposure", "index", "--why", "narrower"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${id} is still proposed, so it renders nowhere to be demoted from`));
    assert.match(refused.out, new RegExp(`confirm it with \`self state confirm ${id}\``));
    assert.match(refused.out, /or propose it at index instead/);
});

test("E7: both halves of that remedy work — confirm then demote, or propose at index", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule", ["--proposed"]);
    await must(ground.box, ground.demo, ["state", "confirm", id]);
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "index", "--why", "narrower"]);
    assert.match((await must(ground.box, ground.demo, ["state", "show", id])).out, /placement: project · index/);
    const fresh = entityIn(receiptIn((await must(ground.box, ground.demo, ["state", "add", "a quiet note",
        "--label", "instruction", "--label", "rule", "--exposure", "index", "--proposed"])).out));
    // The placement line itself: `/index/` alone passes on the word wherever it
    // came from — the `--exposure index` echoed back in a receipt would do it.
    assert.match((await must(ground.box, ground.demo, ["state", "show", fresh])).out,
        /placement: project · index/);
});

test("E8: promotion back to full needs no --why, and returns the record to the render", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "index", "--why", "narrower"]);
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "full"]);
    assert.match(await render(ground), /- tests run on the dev VM/);
    assert.equal((await context(ground)).includes("tests run on the dev VM"), false);
});

test("E9: a full tier at its cap refuses no instruction's promotion, and still refuses a record's", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "index", "--why", "narrower"]);
    // A 32-token full tier holding one 30-token ordinary record, and a full
    // instruction beside it the tier does not hold.
    await add(ground, "a PR gets a cross-model review", "rule");
    await must(ground.box, ground.demo, ["state", "add", "a PR gets a cross-model review", "--exposure", "full"]);
    const waiting = entityIn(receiptIn((await must(ground.box, ground.demo,
        ["state", "add", "an ordinary index note here"])).out));
    setCaps(ground.ws, { fullTokens: 32 });
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "full"]);
    assert.match(await render(ground), /- tests run on the dev VM/);
    const refused = await ground.self(["state", "place", waiting, "--exposure", "full"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes("the project full tier holds 30 of 32 tokens and this text adds 27 more"),
        refused.out);
    assert.equal(refused.out.includes("holds 53"), false, refused.out);
});

test("E10: a scope move is not a demotion — no --why, and it then renders everywhere", async () =>
{
    const ground = await floor();
    const other = await sibling(ground, "other");
    const third = await sibling(ground, "third");
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--scope", "workspace"]);
    for (const cwd of [ground.demo, other, third])
    {
        assert.match(await render(ground, cwd), /- tests run on the dev VM/);
    }
});

test("E11: a scope move into an archived project is refused — it would render nowhere", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["project", "archive", "other", "--why", "finished"]);
    const refused = await ground.self(["state", "place", id, "--scope", "other"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /project "other" is archived, so a record placed there would render nowhere/);
    assert.match(refused.out, /self project restore other/);
});

test("E12: a priority-only move needs no --why and reorders the section", async () =>
{
    const ground = await floor();
    const first = await add(ground, "the rule that reads first", "rule", ["--priority", "10"]);
    const second = await add(ground, "the rule that reads second", "rule", ["--priority", "20"]);
    await must(ground.box, ground.demo, ["state", "place", second, "--priority", "5"]);
    const out = await render(ground);
    assert.ok(out.indexOf("the rule that reads second") < out.indexOf("the rule that reads first"), out);
    assert.match((await must(ground.box, ground.demo, ["state", "show", first])).out, /placement: project · full/);
});

test("E13: a place with no placement flag is refused, and names every flag it takes", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    const refused = await ground.self(["state", "place", id]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out,
        /state place changes placement — pass --priority <n>, --exposure full\|index\|search, --scope <slug>\|workspace, or several/);
});

test("E14: a placement that changes nothing is refused rather than recorded", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    const refused = await ground.self(["state", "place", id, "--exposure", "full"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${id} already sits at that placement — nothing changes`));
});

test("E15: the search tier takes it out of both renders, and default search still finds it", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo,
        ["state", "place", id, "--exposure", "search", "--why", "kept for the record"]);
    assert.equal((await render(ground)).includes("tests run on the dev VM"), false);
    const shown = await context(ground);
    assert.equal(shown.includes("tests run on the dev VM"), false, shown);
    assert.match(shown, /- 1 entity at search exposure; run `self state/);
    assert.match((await must(ground.box, ground.demo, ["search", "dev VM"])).out, /tests run on the dev VM/);
});

test("E16: a retracted instruction has no placement left to change", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "retract", id, "--why", "the VM moved"]);
    const refused = await ground.self(["state", "place", id, "--priority", "1"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${id} was retracted`));
    assert.match(refused.out, /a withdrawn record no longer renders, so it has no placement to change/);
});

test("E17: a foreign workspace record resolves here and its event lands in its own log", async () =>
{
    const ground = await floor();
    const other = await sibling(ground, "other");
    const id = await add(ground, "every project reviews before merge", "rule", ["--workspace"]);
    const before = events(ground.ws, "other").length;
    await must(ground.box, other, ["state", "place", id, "--exposure", "index", "--why", "narrower than it looked"]);
    assert.equal(events(ground.ws, "other").length, before, "the placement landed in the wrong project's log");
    assert.ok(events(ground.ws, "demo").some((event) =>
        event.type === "entity.placed" && event.payload.entity === id), "no placement in the owning log");
    for (const cwd of [ground.demo, other])
    {
        assert.equal((await render(ground, cwd)).includes("every project reviews before merge"), false);
        assert.match(await context(ground, cwd), /- \[instruction, rule\] every project reviews before merge/);
    }
});

// The table's E18 quoted `requireDemotionRoom`'s refusal, which is only
// reachable when the named `--demote` target is itself at `full` — and
// `requireDemotableSeat` admits a full demotion only where the tier being
// entered is `full`, so no demotion out of `full` can ever raise it. The
// refusal a demotion into a crowded index tier actually raises is
// `requireTokenRoom`'s, and its advertised line is the one asserted below;
// see the amendment note under group E's table.
test("E18: an instruction demotes into a crowded index tier; an ordinary record's is still refused", async () =>
{
    const ground = await floor();
    const moving = await add(ground, "tests run on the dev VM", "rule");
    const seated = entityIn(receiptIn((await must(ground.box, ground.demo,
        ["state", "add", "an index note"])).out));
    const ordinary = entityIn(receiptIn((await must(ground.box, ground.demo,
        ["state", "add", "an ordinary full record", "--exposure", "full"])).out));
    setCaps(ground.ws, { indexTokens: 30 });
    // The instruction charges no index tier either, so the crowded tier does
    // not see it arrive.
    await must(ground.box, ground.demo, ["state", "place", moving, "--exposure", "index",
        "--why", "narrower than it looked"]);
    assert.match((await must(ground.box, ground.demo, ["state", "show", moving])).out, /placement: project · index/);
    assert.equal((await render(ground)).includes("tests run on the dev VM"), false);
    // `requireTokenRoom` still answers for a record the tier does hold, and its
    // advertised line still frees the room.
    const refused = await ground.self(["state", "place", ordinary, "--exposure", "index",
        "--why", "narrower than it looked"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes("the project index tier holds 13 of 30 tokens and this text adds 23 more"),
        refused.out);
    assert.match(refused.out, /demote first with `self state place <id> --exposure search --why "<reason>"`/);
    await must(ground.box, ground.demo, ["state", "place", seated, "--exposure", "search", "--why", "quieter"]);
    await must(ground.box, ground.demo, ["state", "place", ordinary, "--exposure", "index",
        "--why", "narrower than it looked"]);
    assert.match((await must(ground.box, ground.demo, ["state", "show", ordinary])).out,
        /placement: project · index/);
});

test("E19: undoing the demotion's `entity.placed` puts the instruction back in the render", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    const placed = await must(ground.box, ground.demo,
        ["state", "place", id, "--exposure", "index", "--why", "narrower than it looked"]);
    assert.equal((await render(ground)).includes("tests run on the dev VM"), false);
    const undone = await must(ground.box, ground.demo, ["undo", idIn(placed.out)]);
    assert.match(undone.out, new RegExp(`${id} is placed where it was — the placement was taken back`));
    assert.match(await render(ground), /- tests run on the dev VM/);
    assert.match((await must(ground.box, ground.demo, ["state", "show", id])).out, /placement: project · full/);
    assert.equal((await context(ground)).includes("tests run on the dev VM"), false);
});

/* ── group E: no cap sees a placement of an instruction (#446) ─────── */

test("E20: a promotion lands with the full tier and the instruction cap both at their limits", async () =>
{
    const ground = await floor();
    const id = await add(ground, "tests run on the dev VM", "rule");
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "index", "--why", "narrower"]);
    await must(ground.box, ground.demo, ["state", "add", "an ordinary full record here", "--exposure", "full"]);
    // 28 tokens of full tier at a cap of 28, and 23 of instruction cap at 23:
    // the promotion moves neither, because the full tier does not hold an
    // instruction and the instruction cap counts one at any exposure.
    setCaps(ground.ws, { fullTokens: 28, instructionTokens: 23 });
    await must(ground.box, ground.demo, ["state", "place", id, "--exposure", "full"]);
    assert.match(await render(ground), /- tests run on the dev VM/);
    assert.match((await must(ground.box, ground.demo, ["state", "show", id])).out, /placement: project · full/);
});

test("E21: every placement of an instruction lands, naming no demotion; --demote has nothing to free", async () =>
{
    const ground = await floor();
    await sibling(ground, "other");
    const id = await add(ground, "tests run on the dev VM", "rule");
    const seated = entityIn(receiptIn((await must(ground.box, ground.demo,
        ["state", "add", "an ordinary full record here", "--exposure", "full"])).out));
    setCaps(ground.ws, { fullTokens: 1, indexTokens: 1, instructionTokens: 1 });
    for (const move of [["--priority", "5"], ["--scope", "workspace"],
        ["--exposure", "index", "--why", "narrower than it looked"]])
    {
        const landed = await must(ground.box, ground.demo, ["state", "place", id, ...move]);
        assert.equal(landed.code, 0);
        for (const word of ["--demote", "goal", "objective", "convention", "over its cap"])
        {
            assert.equal(landed.out.includes(word), false, `${move.join(" ")} named ${word}:\n${landed.out}`);
        }
    }
    const refused = await ground.self(["state", "place", id, "--exposure", "full", "--demote", seated]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--demote frees room in the capped tier a record enters — this command enters none/);
});
