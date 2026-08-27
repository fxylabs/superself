// A named command or recipe, registered once and reused (#391).
//
// Every test below is one cell of the case table in
// docs/maintainers/case-tables/391-skill-registry.md, named by its cell id, and
// asserts that cell's stated outcome. Groups A (registering), B (reading) and
// G (project scope and the resolver) land here; the name, replacement and
// shadowing rules are in skill-name.test.mjs, and context, the trust surface
// and the ordinary-record cells are in skill-context.test.mjs.
//
// The rulings the table stands on:
//
//   R1  a skill is an entity labelled `skill`: the name is its text, the
//       purpose its `why`, the one line its reserved `criteria`, and the
//       longer recipe its reserved `artifact`
//   R2  no new event type: entity.confirmed, entity.proposed and
//       entity.retracted do all of it
//   R3  a version is a place in the supersedes chain, derived and never stored
//   R4  re-registering the same name at the same scope proposes a superseding
//       version; `self state confirm` lands it
//   R5  a project skill shadows a workspace skill of the same name, always,
//       and the shadow is always disclosed
//   R6  a placeholder is recognised and listed, never substituted
//   R7  a skill is printed, never run — `skill run` is a refusal and is absent
//       from every help page
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../dist/main.js";
import { demoWorkspace, git, machine, must, retireFixture, selfIn } from "./harness.mjs";

/* ── the floor every cell stands on ────────────────────────────────── */

async function floor()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    return { box, ws, demo, self: (args, cwd = demo) => selfIn(box, cwd, args) };
}

function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no entity id in: ${text}`);
    return match[0];
}

async function addSkill(ground, name, line, purpose = "what it is for", extra = [])
{
    const args = ["skill", "add", name, "--command", line, "--purpose", purpose, ...extra];
    return entityIn((await must(ground.box, ground.demo, args)).out);
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

function stateDir(ws, slug = "demo")
{
    return join(ws, ".superself", "projects", slug);
}

function artifactDir(ws, slug = "demo")
{
    return join(ws, ".superself", "artifacts", slug);
}

// Caps are user-set values in the store's config.json, in tokens: one token
// per character here, so a cap a cell sets is a character count.
function setCaps(ws, caps)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

function writeRecipe(ground, name, body = "# deploy\n\n1. build the image\n2. push it\n")
{
    const path = join(ground.demo, name);
    writeFileSync(path, body);
    return path;
}

/* ── group A: registering a skill ──────────────────────────────────── */

test("A1: a project with no skills says so and names the verb that registers one", async () =>
{
    const ground = await floor();
    const listed = await must(ground.box, ground.demo, ["skill"]);
    assert.equal(listed.code, 0);
    assert.match(listed.out, /no skills registered/);
    assert.match(listed.out, /self skill add/);
});

test("A2: an add records one skill entity with the name, the line, the purpose and the placement", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy", "push the built image to staging");
    assert.match(id, /^e-[0-9a-z]{5}$/);
    const written = recordOf(ground.ws, id);
    assert.equal(written.type, "entity.confirmed");
    assert.equal(written.payload.text, "deploy");
    assert.deepEqual(written.payload.labels, ["skill"]);
    assert.deepEqual(written.payload.criteria, ["make deploy"]);
    assert.equal(written.payload.why, "push the built image to staging");
    assert.equal(written.payload.scope, "project");
    assert.equal(written.payload.exposure, "index");
    assert.equal(written.payload.priority, 50);
});

test("A3: an add naming no body is refused — a skill is the line or the recipe it holds", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    const refused = await ground.self(["skill", "add", "deploy", "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /states neither/);
    assert.equal(events(ground.ws).length, before);
});

test("A4: an add with no --purpose is refused by the gate that names the missing option", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["skill", "add", "deploy", "--command", "make deploy"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--purpose/);
});

test("A5: --command and --file together are refused, and no artifact is registered", async () =>
{
    const ground = await floor();
    const recipe = writeRecipe(ground, "recipe.md");
    const before = events(ground.ws).length;
    const refused = await ground.self(["skill", "add", "deploy", "--command", "c", "--file", recipe, "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /a skill has one body/);
    assert.equal(events(ground.ws).length, before);
    assert.equal(existsSync(artifactDir(ground.ws)), false);
});

test("A6: a second --command is refused by name", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["skill", "add", "deploy", "--command", "a", "--command", "b", "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /was passed twice/);
});

test("A7: a blank name is refused by the text gate, however it is spelled", async () =>
{
    const ground = await floor();
    for (const name of ["", "   "])
    {
        const refused = await ground.self(["skill", "add", name, "--command", "c", "--purpose", "p"]);
        assert.notEqual(refused.code, 0, `"${name}" was accepted as a name`);
        assert.match(refused.out, /usage: self skill add/);
    }
});

test("A8: a name shaped like a record id is refused — a skill is named by what a person types", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["skill", "add", "e-abc12", "--command", "c", "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /shaped like a record id/);
});

test("A9: --file registers the recipe as an artifact, and the record carries the pointer", async () =>
{
    const ground = await floor();
    const recipe = writeRecipe(ground, "recipe.md");
    const id = entityIn((await must(ground.box, ground.demo,
        ["skill", "add", "release notes", "--file", recipe, "--purpose", "draft the notes"])).out);
    const written = recordOf(ground.ws, id);
    assert.match(String(written.payload.artifact), /^a-[0-9a-z]{5}$/);
    assert.deepEqual(written.payload.criteria, []);
    assert.ok(readdirSync(artifactDir(ground.ws)).length > 0, "the recipe's bytes are not in the store");
});

test("A10: --file naming no file is refused, and registers nothing", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    const refused = await ground.self(["skill", "add", "recipe", "--file", "nowhere.md", "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /there is no file there/);
    assert.equal(events(ground.ws).length, before);
    assert.equal(existsSync(artifactDir(ground.ws)), false);
});

test("A11: an empty recipe is refused — it tells the next session nothing", async () =>
{
    const ground = await floor();
    const recipe = writeRecipe(ground, "empty.md", "   \n\n");
    const refused = await ground.self(["skill", "add", "recipe", "--file", recipe, "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is empty/);
    assert.equal(existsSync(artifactDir(ground.ws)), false);
});

test("A12: --file naming a directory is refused — a skill's recipe is one file", async () =>
{
    const ground = await floor();
    const dir = join(ground.demo, "recipes");
    mkdirSync(dir, { recursive: true });
    const refused = await ground.self(["skill", "add", "recipe", "--file", dir, "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is a directory/);
});

test("A13: a recipe holding a terminal control byte is refused, naming the code point and offset", async () =>
{
    const ground = await floor();
    const recipe = writeRecipe(ground, "control.md", "deploy the thing\nnow \u001b[31mred\u001b[0m\n");
    const refused = await ground.self(["skill", "add", "recipe", "--file", recipe, "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /U\+001B/);
    assert.match(refused.out, /at offset 21/);
    assert.equal(existsSync(artifactDir(ground.ws)), false);
});

test("A14: a recipe outside the project is read and copied, and the record carries no path", async () =>
{
    const ground = await floor();
    const outside = join(ground.box.root, "outside.md");
    writeFileSync(outside, "# the recipe\n\nrun the thing\n");
    const id = entityIn((await must(ground.box, ground.demo,
        ["skill", "add", "outside", "--file", outside, "--purpose", "p"])).out);
    const written = recordOf(ground.ws, id);
    assert.match(String(written.payload.artifact), /^a-[0-9a-z]{5}$/);
    assert.equal(written.payload.path, undefined);
    assert.equal(JSON.stringify(written.payload).includes(ground.box.root), false,
        "the record repeats the path the recipe was read from");
});

test("A15: --workspace records the workspace scope in the payload", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy", "p", ["--workspace"]);
    assert.equal(recordOf(ground.ws, id).payload.scope, "workspace");
});

test("A16: --why on an add is refused by name — a purpose is not a withdrawal's reason", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["skill", "add", "deploy", "--command", "c", "--purpose", "p", "--why", "w"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /skill add takes no --why/);
});

test("A17: a malformed placeholder is refused, and the refusal names it", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["skill", "add", "deploy", "--command", "d {{ tag }}", "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /\{\{ tag \}\}/);
    assert.match(refused.out, /not a placeholder a caller can fill/);
});

test("A18: well-formed placeholders are recorded, and the page lists every one of them", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "d {{tag}} {{env_name}}", "p");
    const page = (await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out;
    assert.match(page, /Placeholders: \{\{tag\}\}, \{\{env_name\}\}/);
});

test("A19: past the index cap the add is refused until --demote names what frees the room", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, { indexTokens: 20 });
    await addSkill(ground, "deploy staging", "make deploy", "p");
    const refused = await ground.self(["skill", "add", "release notes", "--command", "make release", "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--demote/);
});

test("A20: a line shaped like a credential is refused by the sanitizer, and records nothing", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    const refused = await ground.self(["skill", "add", "deploy",
        "--command", "curl -H 'Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz'", "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /refusing to record/);
    assert.equal(events(ground.ws).length, before);
});

test("A21: a line naming an absolute path under this machine's home is refused by the sanitizer", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["skill", "add", "deploy",
        "--command", `cat ${join(ground.box.env.HOME, "notes.txt")}`, "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /home directory/);
});

test("A22: registering a skill appends exactly one entity.confirmed and no event type of its own", async () =>
{
    const ground = await floor();
    const before = events(ground.ws).length;
    const id = await addSkill(ground, "deploy", "make deploy", "p");
    const appended = events(ground.ws).slice(before);
    assert.deepEqual(appended.map((event) => event.type), ["entity.confirmed"]);
    assert.equal(appended[0].payload.entity, id);
    assert.match((await must(ground.box, ground.demo, ["log", "-n", "3"])).out, /entity\.confirmed/);
});

test("A23: the fold writes no skill directory and the state directory gains no folder", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy", "p");
    const before = readdirSync(stateDir(ground.ws)).sort();
    await must(ground.box, ground.demo, ["fold"]);
    assert.deepEqual(readdirSync(stateDir(ground.ws)).sort(), before);
    assert.equal(existsSync(join(stateDir(ground.ws), "skill")), false);
});

test("A24: --project is not a flag a write verb takes", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["skill", "add", "deploy", "--command", "c", "--purpose", "p", "--project", "demo"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown option '--project'/);
});

test("A25: a --command carrying more than one line is refused, and names --file", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["skill", "add", "deploy", "--command", "make build\nmake deploy", "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--file/);
});

/* ── group B: reading ──────────────────────────────────────────────── */

test("B1: show prints the name, the purpose, the scope, the version and the line", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy", "push the built image to staging");
    const page = (await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out;
    assert.match(page, new RegExp(`# ${id} — deploy`));
    assert.match(page, /- Purpose: push the built image to staging/);
    assert.match(page, /- Scope: project \(demo\)/);
    assert.match(page, /- Version: v1 of 1/);
    assert.match(page, /## Command\n\nmake deploy/);
});

test("B2: show answers to the skill's id exactly as it answers to its name", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy", "p");
    const byName = (await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out;
    assert.equal((await must(ground.box, ground.demo, ["skill", "show", id])).out, byName);
});

test("B3: show answers to a prefix of the id", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy", "p");
    const byName = (await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out;
    assert.equal((await must(ground.box, ground.demo, ["skill", "show", id.slice(0, 4)])).out, byName);
});

test("B4: show of a name nothing answers to is refused, and names the listing", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["skill", "show", "deploy"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no skill here answers to "deploy"/);
    assert.match(refused.out, /self skill/);
});

test("B5: show of a recipe skill prints the document inline and the pointer that opens it", async () =>
{
    const ground = await floor();
    const recipe = writeRecipe(ground, "recipe.md", "# release notes\n\ncollect the merged PRs\n");
    const id = entityIn((await must(ground.box, ground.demo,
        ["skill", "add", "release notes", "--file", recipe, "--purpose", "draft the notes"])).out);
    const page = (await must(ground.box, ground.demo, ["skill", "show", id])).out;
    assert.match(page, /- Recipe: a-[0-9a-z]{5} — see `self artifact open a-[0-9a-z]{5}`/);
    assert.match(page, /## Recipe\n\n# release notes\n\ncollect the merged PRs/);
});

test("B6: show of a recipe whose bytes were pruned prints the record, the pointer and why — and exits 0", async () =>
{
    const ground = await floor();
    const recipe = writeRecipe(ground, "recipe.md");
    const id = entityIn((await must(ground.box, ground.demo,
        ["skill", "add", "release notes", "--file", recipe, "--purpose", "p"])).out);
    const artifact = String(recordOf(ground.ws, id).payload.artifact);
    // A prune is a person's call and a test has no terminal. What this cell is
    // about is the state a prune leaves, so the event is written as a fixture;
    // the gate's own behaviour is D10 and D11's subject.
    retireFixture(ground.box, ground.ws, "demo", "artifact.pruned",
        { artifact, why: "the guide is folded into the rule" });
    const page = await must(ground.box, ground.demo, ["skill", "show", id]);
    assert.equal(page.code, 0);
    assert.match(page.out, new RegExp(`- Recipe: ${artifact}`));
    assert.match(page.out, /whose bytes were removed/);
    assert.match(page.out, /self artifact list/);
});

test("B7: list prints one row per skill: id, name, scope and purpose", async () =>
{
    const ground = await floor();
    const deploy = await addSkill(ground, "deploy", "make deploy", "push the built image to staging");
    const notes = await addSkill(ground, "release notes", "gh pr list", "draft the notes from merged PRs");
    const listed = (await must(ground.box, ground.demo, ["skill", "list"])).out;
    assert.match(listed, new RegExp(`${deploy}  deploy .*project.*push the built image to staging`));
    assert.match(listed, new RegExp(`${notes}  release notes  project.*draft the notes from merged PRs`));
    assert.match(listed, /2 skills/);
});

test("B8: list with nothing registered says so and names the verb that registers one", async () =>
{
    const ground = await floor();
    const listed = await must(ground.box, ground.demo, ["skill", "list"]);
    assert.equal(listed.code, 0);
    assert.match(listed.out, /no skills registered/);
});

test("B9: a workspace skill registered in one project is listed in another, marked workspace", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy", "p", ["--workspace"]);
    const beta = await secondProject(ground, "beta");
    const listed = (await must(ground.box, beta, ["skill"])).out;
    assert.match(listed, /deploy +workspace/);
});

test("B10: a project skill registered in one project is not listed in another", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy", "p");
    const beta = await secondProject(ground, "beta");
    assert.match((await must(ground.box, beta, ["skill"])).out, /no skills registered/);
});

test("B11: --project reads another registered project's skills", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy", "p");
    const beta = await secondProject(ground, "beta");
    assert.match((await must(ground.box, beta, ["skill", "--project", "demo"])).out, /deploy/);
});

test("B12: --project shows another registered project's skill by name", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy", "push the built image to staging");
    const beta = await secondProject(ground, "beta");
    const page = (await must(ground.box, beta, ["skill", "show", "deploy", "--project", "demo"])).out;
    assert.match(page, /- Purpose: push the built image to staging/);
});

test("B13: a skill is found by search, because it is a record like any other", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy", "p");
    assert.match((await must(ground.box, ground.demo, ["search", "deploy", "--all"])).out,
        new RegExp(`${id}[\\s\\S]*deploy`));
});

test("B14: state show answers for a skill with the ordinary entity page", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy", "p");
    const page = (await must(ground.box, ground.demo, ["state", "show", id])).out;
    assert.match(page, /deploy/);
    assert.match(page, /skill/);
});

/* ── group G: project scope and the resolver ───────────────────────── */

async function secondProject(ground, name)
{
    const dir = join(ground.ws, name);
    mkdirSync(dir, { recursive: true });
    git(ground.box, dir, ["init", "-q", "-b", "main"]);
    await must(ground.box, dir, ["project", "init", "--name", name, "--no-connect"]);
    return dir;
}

test("G1: an add outside a registered project is refused by the project resolver", async () =>
{
    const ground = await floor();
    const loose = join(ground.box.root, "loose");
    mkdirSync(loose, { recursive: true });
    const refused = await selfIn(ground.box, loose, ["skill", "add", "deploy", "--command", "c", "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /project/);
});

test("G2: an archived project refuses the add, like every other append", async () =>
{
    const ground = await floor();
    await must(ground.box, ground.ws, ["project", "archive", "demo", "--why", "nobody is working on it"]);
    const refused = await ground.self(["skill", "add", "deploy", "--command", "c", "--purpose", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /archived/);
});

test("G3: an archived project's skills still read, with the archived notice beside them", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy", "p");
    await must(ground.box, ground.ws, ["project", "archive", "demo", "--why", "nobody is working on it"]);
    const listed = await must(ground.box, ground.ws, ["skill", "--project", "demo"]);
    assert.equal(listed.code, 0);
    assert.match(listed.out, /deploy/);
    assert.match(listed.out, /archived/);
});

test("G4: `skill` is a reserved root verb, so an alias row may not claim it", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["alias", "add", "skill", "--label", "recipe"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /reserved/);
});

test("G5: `skill` is in the built-in verb list the plugin collision guard is registered with", async () =>
{
    // `main.ts` hands `COMMANDS.map(name)` to both guards — `alias add`'s
    // reserved list (G4) and `app install`'s `verb_reserved` refusal — so a
    // plugin claiming `skill` is refused by the same mechanism cell 12 of
    // pr7-loader.test.mjs drives end to end.
    assert.ok(COMMANDS.map((command) => command.name).includes("skill"),
        "`skill` is dispatchable but is not a name the plugin guard would refuse");
});
