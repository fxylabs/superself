// What a registered skill does to `self context`, what the trust surface
// refuses, and how an ordinary record's verbs answer for one (#391).
//
// Every test below is one cell of the case table in
// docs/maintainers/case-tables/391-skill-registry.md, named by its cell id, and
// asserts that cell's stated outcome. Group E (`self context`), group F (the
// trust surface) and group H (an ordinary record) land here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, git, idIn, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

async function floor()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    return { box, ws, demo, self: (args, cwd = demo) => selfIn(box, cwd, args) };
}

function receiptEntity(text)
{
    const found = text.split("\n").map((line) => line.trim()).find((line) => /^e-[0-9a-z]{5}$/.test(line));
    assert.ok(found !== undefined, `no receipt id in: ${text}`);
    return found;
}

function events(ws, slug = "demo")
{
    const file = join(ws, ".superself", "projects", slug, "log.jsonl");
    return !existsSync(file) ? [] : readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

async function addSkill(ground, name, line, purpose = "push the built image to staging", extra = [], at = ground.demo)
{
    const args = ["skill", "add", name, "--command", line, "--purpose", purpose, ...extra];
    return receiptEntity((await must(ground.box, at, args)).out);
}

async function project(ground, name)
{
    const dir = join(ground.ws, name);
    mkdirSync(dir, { recursive: true });
    git(ground.box, dir, ["init", "-q", "-b", "main"]);
    await must(ground.box, dir, ["project", "init", "--name", name, "--no-connect"]);
    return dir;
}

function block(text, header)
{
    const lines = text.split("\n");
    const at = lines.indexOf(header);
    if (at < 0)
    {
        return "";
    }
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((line) => line.startsWith("## "));
    return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

function setCaps(ws, caps)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

/* ── group E: self context ─────────────────────────────────────────── */

test("E1: a project with no skills renders no Skills header and no row", async () =>
{
    const ground = await floor();
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.equal(context.includes("## Skills"), false, `an empty project grew a Skills section:\n${context}`);
    // The byte-identity half of this cell is the committed golden fixture,
    // whose scenario registers no skill: `test/fixtures/golden/piped.txt` pins
    // `self context` for that project byte for byte.
});

test("E2: one skill renders one row: the name, the purpose and the command that prints it", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy", "push the built image to staging");
    const rows = block((await must(ground.box, ground.demo, ["context"])).out, "## Skills");
    assert.equal(rows.trim(), `- deploy — push the built image to staging · \`self skill show ${id} --project 'demo'\``);
});

test("E3: a workspace skill renders in another project's context, marked workspace", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy", "push the built image to staging", ["--workspace"]);
    const beta = await project(ground, "beta");
    assert.match(block((await must(ground.box, beta, ["context"])).out, "## Skills"), /- deploy \(workspace\) —/);
});

test("E4: a shadowed pair renders one row, and the row says it shadows a workspace skill", async () =>
{
    const ground = await floor();
    const shared = await addSkill(ground, "deploy", "make deploy", "the shared one", ["--workspace"]);
    const beta = await project(ground, "beta");
    const own = await addSkill(ground, "deploy", "make deploy-beta", "beta's own deploy", [], beta);
    const rows = block((await must(ground.box, beta, ["context"])).out, "## Skills");
    assert.equal(rows.trim().split("\n").length, 1, `both records took a row:\n${rows}`);
    assert.match(rows, /- deploy \(shadows a workspace skill\) — beta's own deploy/);
    assert.match(rows, new RegExp(own));
    assert.equal(rows.includes(shared), false, "the shadowed workspace skill kept a row of its own");
});

test("E5: the command line never reaches context — name, purpose and pointer only", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy ENV=staging", "push the built image to staging");
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.equal(context.includes("make deploy"), false, `the command line reached context:\n${context}`);
});

test("E6: past the budget the section collapses to a counted omission row naming the listing", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, { indexTokens: 100000 });
    for (let index = 0; index < 14; index += 1)
    {
        await addSkill(ground, `skill ${index}`, "make it", "p".padEnd(240, " and more of what it is for"));
    }
    const rows = block((await must(ground.box, ground.demo, ["context"])).out, "## Skills");
    assert.match(rows, /skills omitted; run `self skill --project 'demo'`/);
});

test("E7: a skill is not in the default search answer — context already showed it", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy");
    // The default membership is "live and not shown in context" (#212 R1), and
    // the Skills section supplies its ids, so a skill counts as shown. `--all`
    // is what reaches it, and B13 is the cell that proves it does.
    const found = (await must(ground.box, ground.demo, ["search", "deploy"])).out;
    assert.match(found, /no matches/);
    assert.equal(found.includes(id), false, `the default search answer repeats what context rendered:\n${found}`);
});

test("E8: the terminal render carries the section too", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy", "push the built image to staging");
    const rendered = (await must(ground.box, ground.demo, ["context", "--pretty"])).out;
    assert.match(rendered, /SKILLS/);
    assert.match(rendered, /deploy — push the built image to staging/);
});

test("E9: a proposed replacement waits on a person and takes no Skills row", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy");
    const second = await addSkill(ground, "deploy", "make deploy FAST=1");
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.match(block(context, "## Waiting on you"), new RegExp(second));
    assert.equal(block(context, "## Skills").includes(second), false);
    assert.match(block(context, "## Skills"), new RegExp(first));
});

test("E10: a skill is in the Skills block and not also in the Index block — one record, one row", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy");
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.match(block(context, "## Skills"), new RegExp(id));
    assert.equal(block(context, "## Index").includes(id), false, `the skill was rendered twice:\n${context}`);
});

/* ── group F: the trust surface ────────────────────────────────────── */

test("F1: `skill run` is refused, names the verb that prints the line, and records nothing", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy");
    const before = events(ground.ws).length;
    const refused = await ground.self(["skill", "run", "deploy"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /a skill is printed, never run/);
    assert.match(refused.out, /self skill show deploy/);
    assert.equal(events(ground.ws).length, before);
});

test("F2: no help page offers `skill run` — the refusal is reachable, the promise is not made", async () =>
{
    const ground = await floor();
    const scoped = (await must(ground.box, ground.demo, ["skill", "--help"])).out;
    const root = (await must(ground.box, ground.demo, ["--help"])).out;
    assert.match(root, /\bskill\b/);
    for (const page of [scoped, root])
    {
        assert.equal(/skill run/.test(page), false, `a help page offers \`skill run\`:\n${page}`);
    }
});

test("F3: show prints the line and appends nothing — reading a skill is not an act", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy ENV=staging");
    const before = events(ground.ws).length;
    const page = await must(ground.box, ground.demo, ["skill", "show", "deploy"]);
    assert.equal(page.code, 0);
    assert.match(page.out, /make deploy ENV=staging/);
    assert.equal(events(ground.ws).length, before);
});

test("F4: the line is printed verbatim, placeholders intact, beside the list of what they are", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy TAG={{tag}} ENV={{env_name}}");
    const page = (await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out;
    assert.match(page, /## Command\n\nmake deploy TAG=\{\{tag\}\} ENV=\{\{env_name\}\}/);
    assert.match(page, /- Placeholders: \{\{tag\}\}, \{\{env_name\}\}/);
});

test("F5: there is no flag that fills a placeholder — `--arg` is an unknown option", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy TAG={{tag}}");
    const refused = await ground.self(["skill", "show", "deploy", "--arg", "tag=v1"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown option '--arg'/);
});

/* ── group H: an ordinary record ───────────────────────────────────── */

test("H1: a recipe's bytes are counted by `store size` like any other artifact", async () =>
{
    const ground = await floor();
    const recipe = join(ground.demo, "recipe.md");
    writeFileSync(recipe, "# release notes\n\ncollect the merged PRs\n");
    await must(ground.box, ground.demo, ["skill", "add", "release notes", "--file", recipe, "--purpose", "draft the notes"]);
    const size = JSON.parse((await must(ground.box, ground.demo, ["store", "size", "--json"])).out);
    assert.ok(size.artifactBytes > 0, `the recipe's bytes are not counted: ${JSON.stringify(size)}`);
});

// Inverted by #390: `refuseAcceptanceUndo` is deleted, and a confirm is taken
// back like any other `entity.*` event. It can only ever move the replacement
// back to proposed, so landing it again still costs what landing it cost.
test("H2: undoing the confirm that landed a replacement returns it to proposed", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy");
    const second = await addSkill(ground, "deploy", "make deploy FAST=1");
    const landed = await must(ground.box, ground.demo, ["state", "confirm", second]);
    const undone = await ground.self(["undo", idIn(landed.out)]);
    assert.equal(undone.code, 0, undone.out);
    assert.match((await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out, new RegExp(first));
});

// Inverted by #390: a creation recorded by mistake is the cheapest thing in
// the system to erase, whether or not it displaced anything.
test("H3: undoing a first registration takes the skill out of the registry", async () =>
{
    const ground = await floor();
    const recorded = await must(ground.box, ground.demo,
        ["skill", "add", "deploy", "--command", "make deploy", "--purpose", "p"]);
    const undone = await ground.self(["undo", idIn(recorded.out)]);
    assert.equal(undone.code, 0, undone.out);
    assert.doesNotMatch((await must(ground.box, ground.demo, ["skill"])).out, /make deploy/);
});

test("H4: undoing a drop puts the skill back", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy");
    const dropped = await approvedIn(ground.box, ground.demo, ["skill", "drop", id, "--why", "the deploy moved"], id);
    const back = await must(ground.box, ground.demo, ["undo", idIn(dropped.out), "--why", "it is still the deploy"]);
    assert.equal(back.code, 0, back.out);
    assert.match((await must(ground.box, ground.demo, ["skill"])).out, /deploy/);
});

test("H5: a handoff packet carries the skill in its context section and not in the conventions closure", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy", "push the built image to staging");
    const unit = workIdIn((await mustPerson(ground.box, ground.demo, ["work", "add", "the deploy works"])).out);
    const packet = (await must(ground.box, ground.demo, ["handoff", unit])).out;
    assert.match(packet, new RegExp(`- deploy — push the built image to staging.*${id}`));
    assert.equal(block(packet, "## Conventions").includes(id), false,
        "a skill was carried as a convention");
});
