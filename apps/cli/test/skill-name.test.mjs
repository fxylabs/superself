// The name a skill answers to, the correction path, the shadow between scopes,
// and withdrawing one (#391).
//
// Every test below is one cell of the case table in
// docs/maintainers/case-tables/391-skill-registry.md, named by its cell id, and
// asserts that cell's stated outcome. Group C (the name, replacement and
// shadowing) and group D (dropping) land here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, git, machine, must, retireFixture, selfIn } from "./harness.mjs";

async function floor()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    return { box, ws, demo, self: (args, cwd = demo) => selfIn(box, cwd, args) };
}

// The receipt line, which is the id on a line of its own: the shadow and
// proposal notices name ids too, and a cell that reads the first id it sees
// would be reading whichever notice happened to print.
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

function recordOf(ws, id, slug = "demo")
{
    const written = events(ws, slug).find((event) => event.payload.entity === id);
    assert.ok(written !== undefined, `no event recorded ${id}`);
    return written;
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

// A replacement, landed: the agent proposes and the person confirms, which is
// the two-step this surface is built on (R4).
async function replace(ground, name, line, purpose = "push the built image to staging")
{
    const proposed = await addSkill(ground, name, line, purpose);
    await must(ground.box, ground.demo, ["state", "confirm", proposed]);
    return proposed;
}

// The `## Skills` block of a piped context, without the sections around it.
function skillBlock(text)
{
    const lines = text.split("\n");
    const at = lines.indexOf("## Skills");
    if (at < 0)
    {
        return "";
    }
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((line) => line.startsWith("## "));
    return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

/* ── group C: the name, replacement and shadowing ──────────────────── */

test("C1: registering a standing name again proposes a superseding version and moves nothing", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy");
    const asked = await must(ground.box, ground.demo,
        ["skill", "add", "deploy", "--command", "make deploy FAST=1", "--purpose", "push the built image to staging"]);
    const second = receiptEntity(asked.out);
    const written = recordOf(ground.ws, second);
    assert.equal(written.type, "entity.proposed");
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: first }]);
    assert.match((await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out, /make deploy\n/);
    assert.match(asked.out, new RegExp(`self state confirm ${second}`));
});

test("C2: the proposed version waits on a person, and the standing one keeps the Skills row", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy");
    const second = await addSkill(ground, "deploy", "make deploy FAST=1");
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.match(context, new RegExp(`proposed entity ${second}`));
    assert.match(skillBlock(context), new RegExp(first));
    assert.equal(skillBlock(context).includes(second), false, "the proposal is rendered as a live skill");
});

test("C3: confirming the proposal supersedes the standing version and makes the new one the head", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy");
    const second = await replace(ground, "deploy", "make deploy FAST=1");
    assert.match((await must(ground.box, ground.demo, ["state", "show", first])).out, /superseded/);
    const page = (await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out;
    assert.match(page, new RegExp(`# ${second} — deploy`));
    assert.match(page, /make deploy FAST=1/);
});

test("C4: the confirm lands from a pipe — `state confirm` is the person's verb and carries no terminal gate", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy");
    const second = await addSkill(ground, "deploy", "make deploy FAST=1");
    const landed = await ground.self(["state", "confirm", second]);
    assert.equal(landed.code, 0, landed.out);
});

test("C5: the page names every version, in order, and says which one holds", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy");
    const second = await replace(ground, "deploy", "make deploy FAST=1");
    const page = (await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out;
    assert.match(page, /- Version: v2 of 2/);
    assert.match(page, new RegExp(`- v1 ${first} — superseded`));
    assert.match(page, new RegExp(`- v2 ${second} — holds now`));
});

test("C6: restating exactly the same line and purpose is refused, and records nothing", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy");
    const before = events(ground.ws).length;
    const refused = await ground.self(
        ["skill", "add", "deploy", "--command", "make deploy", "--purpose", "push the built image to staging"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${first} already states exactly this line and this purpose`));
    assert.equal(events(ground.ws).length, before);
});

test("C7: a recipe may replace a line — the kind changes and the chain does not", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy");
    const recipe = join(ground.demo, "deploy.md");
    writeFileSync(recipe, "# deploy\n\nbuild, then push\n");
    const second = receiptEntity((await must(ground.box, ground.demo,
        ["skill", "add", "deploy", "--file", recipe, "--purpose", "push the built image to staging"])).out);
    const written = recordOf(ground.ws, second);
    assert.equal(written.type, "entity.proposed");
    assert.match(String(written.payload.artifact), /^a-[0-9a-z]{5}$/);
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: first }]);
    await must(ground.box, ground.demo, ["state", "confirm", second]);
    const page = (await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out;
    assert.match(page, /## Recipe\n\n# deploy/);
    assert.match(page, new RegExp(`- v1 ${first}`));
});

test("C8: a replaced version's id answers with the version that holds", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy");
    const second = await replace(ground, "deploy", "make deploy FAST=1");
    assert.match((await must(ground.box, ground.demo, ["skill", "show", first])).out,
        new RegExp(`# ${second} — deploy`));
});

test("C9: a workspace skill is replaced against the workspace record", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy", "p", ["--workspace"]);
    const second = receiptEntity((await must(ground.box, ground.demo,
        ["skill", "add", "deploy", "--command", "make deploy FAST=1", "--purpose", "p", "--workspace"])).out);
    const written = recordOf(ground.ws, second);
    assert.equal(written.type, "entity.proposed");
    assert.equal(written.payload.scope, "workspace");
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: first }]);
});

test("C10: a project skill of a workspace skill's name is a new confirmed record, and the shadow is disclosed", async () =>
{
    const ground = await floor();
    const shared = await addSkill(ground, "deploy", "make deploy", "p", ["--workspace"]);
    const beta = await project(ground, "beta");
    const asked = await must(ground.box, beta,
        ["skill", "add", "deploy", "--command", "make deploy-beta", "--purpose", "beta's own deploy"]);
    const own = receiptEntity(asked.out);
    const written = recordOf(ground.ws, own, "beta");
    assert.equal(written.type, "entity.confirmed");
    assert.equal(written.payload.links.length, 0, "a shadow linked itself to the workspace skill");
    assert.match(asked.out, new RegExp(`shadows the workspace skill ${shared}`));
});

test("C11: the project's own skill is what the name answers with where it shadows", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy", "p", ["--workspace"]);
    const beta = await project(ground, "beta");
    const own = await addSkill(ground, "deploy", "make deploy-beta", "beta's own deploy", [], beta);
    assert.match((await must(ground.box, beta, ["skill", "show", "deploy"])).out, new RegExp(`# ${own} — deploy`));
});

test("C12: the listing carries both rows, and marks the one the name no longer reaches", async () =>
{
    const ground = await floor();
    const shared = await addSkill(ground, "deploy", "make deploy", "p", ["--workspace"]);
    const beta = await project(ground, "beta");
    const own = await addSkill(ground, "deploy", "make deploy-beta", "beta's own deploy", [], beta);
    const listed = (await must(ground.box, beta, ["skill"])).out;
    assert.match(listed, new RegExp(`${own}.*project`));
    assert.match(listed, new RegExp(`${shared}.*workspace.*\\(shadowed here\\)`));
});

test("C13: the workspace skill still answers, unshadowed, in every other project", async () =>
{
    const ground = await floor();
    const shared = await addSkill(ground, "deploy", "make deploy", "p", ["--workspace"]);
    const beta = await project(ground, "beta");
    await addSkill(ground, "deploy", "make deploy-beta", "beta's own deploy", [], beta);
    const gamma = await project(ground, "gamma");
    assert.match((await must(ground.box, gamma, ["skill", "show", "deploy"])).out, new RegExp(`# ${shared} — deploy`));
});

test("C14: a workspace skill registered under a standing project name is disclosed the other way round", async () =>
{
    const ground = await floor();
    const own = await addSkill(ground, "deploy", "make deploy-here", "the project's own");
    const asked = await must(ground.box, ground.demo,
        ["skill", "add", "deploy", "--command", "make deploy", "--purpose", "the shared one", "--workspace"]);
    const shared = receiptEntity(asked.out);
    assert.equal(recordOf(ground.ws, shared).type, "entity.confirmed");
    assert.match(asked.out, new RegExp(`this project's own "deploy" \\(${own}\\) still answers here`));
});

test("C15: dropping the project skill lets the workspace one through here", async () =>
{
    const ground = await floor();
    const own = await addSkill(ground, "deploy", "make deploy-here", "the project's own");
    const shared = await addSkill(ground, "deploy", "make deploy", "the shared one", ["--workspace"]);
    const dropped = await approvedIn(ground.box, ground.demo, ["skill", "drop", own, "--why", "the project follows the shared one"], own);
    assert.equal(dropped.code, 0, dropped.out);
    assert.match((await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out, new RegExp(`# ${shared} — deploy`));
});

test("C16: a further registration proposes against the version that holds, not the first one", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy");
    const second = await replace(ground, "deploy", "make deploy FAST=1");
    const third = await addSkill(ground, "deploy", "make deploy FAST=2");
    assert.deepEqual(recordOf(ground.ws, third).payload.links, [{ type: "supersedes", target: second }]);
});

test("C17: an id prefix that reaches two skills is refused rather than resolved to one of them", async () =>
{
    const ground = await floor();
    // Two ids sharing a prefix cannot be asked for from the verb — the mint is
    // random — so the records are written as fixtures and the resolver is the
    // subject.
    for (const id of ["e-aa111", "e-aa222"])
    {
        retireFixture(ground.box, ground.ws, "demo", "entity.confirmed", {
            entity: id, text: `skill ${id}`, labels: ["skill"], links: [], criteria: ["make it"],
            exposure: "index", scope: "project", priority: 50, why: "p"
        });
    }
    const refused = await ground.self(["skill", "show", "e-aa"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is ambiguous \(2 matches\)/);
});

test("C18: a second replacement proposed while one still waits leaves the standing version answering", async () =>
{
    const ground = await floor();
    const first = await addSkill(ground, "deploy", "make deploy");
    const second = await addSkill(ground, "deploy", "make deploy FAST=1");
    const third = await addSkill(ground, "deploy", "make deploy FAST=2");
    assert.deepEqual(recordOf(ground.ws, third).payload.links, [{ type: "supersedes", target: first }]);
    assert.match((await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out, new RegExp(`# ${first} — deploy`));
    await must(ground.box, ground.demo, ["state", "confirm", second]);
    assert.match((await must(ground.box, ground.demo, ["skill", "show", "deploy"])).out, new RegExp(`# ${second} — deploy`));
});

/* ── group D: dropping ─────────────────────────────────────────────── */

test("D1: a drop at a terminal records a retraction and leaves the listing and the context", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy");
    const dropped = await approvedIn(ground.box, ground.demo, ["skill", "drop", "deploy", "--why", "the deploy moved to the pipeline"], id);
    assert.equal(dropped.code, 0, dropped.out);
    assert.equal(recordOf(ground.ws, id, "demo") !== undefined, true);
    assert.ok(events(ground.ws).some((event) => event.type === "entity.retracted" && event.payload.entity === id));
    assert.match((await must(ground.box, ground.demo, ["skill"])).out, /no skills registered/);
    assert.equal(skillBlock((await must(ground.box, ground.demo, ["context"])).out), "");
});

// D2 and D3 asserted the terminal gate the retirement path had until #400.
// A drop is one `self undo` takes straight back, so it records from a pipe —
// what survives is the disclosure of what it destroys, and the `by` that says
// who destroyed it.
test("D2: a drop from a pipe records, disclosed, and the event says a session wrote it", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy");
    const before = events(ground.ws).length;
    const dropped = await ground.self(["skill", "drop", "deploy", "--why", "w"]);
    assert.equal(dropped.code, 0, dropped.out);
    assert.match(dropped.out, /`self undo` takes it back/);
    const written = events(ground.ws).slice(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.retracted"]);
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
});

test("D3: a person's drop records the same event, and says a person wrote it", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy");
    const before = events(ground.ws).length;
    const dropped = await approvedIn(ground.box, ground.demo, ["skill", "drop", "deploy", "--why", "w"], "not the id");
    assert.equal(dropped.code, 0, dropped.out);
    const written = events(ground.ws).slice(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.retracted"]);
    assert.deepEqual(written[0].payload.by, { kind: "person" });
});

test("D4: a drop with no --why is refused by the gate that names the missing option", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy");
    const refused = await ground.self(["skill", "drop", "deploy"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--why/);
});

test("D5: dropping a name nothing answers to is refused, and names the listing", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["skill", "drop", "deploy", "--why", "w"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no skill here answers to "deploy"/);
    assert.match(refused.out, /self skill/);
});

test("D6: a drop answers to the id exactly as it answers to the name", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy");
    const dropped = await approvedIn(ground.box, ground.demo, ["skill", "drop", id, "--why", "the deploy moved"], id);
    assert.equal(dropped.code, 0, dropped.out);
    assert.match((await must(ground.box, ground.demo, ["skill"])).out, /no skills registered/);
});

test("D7: dropping an already withdrawn skill is refused, and says which it is", async () =>
{
    const ground = await floor();
    const id = await addSkill(ground, "deploy", "make deploy");
    await approvedIn(ground.box, ground.demo, ["skill", "drop", id, "--why", "the deploy moved"], id);
    const refused = await ground.self(["skill", "drop", id, "--why", "again"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${id} was already retracted`));
});

test("D8: --workspace on a drop is refused by name", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy");
    const refused = await ground.self(["skill", "drop", "deploy", "--workspace", "--why", "w"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /skill drop takes no --workspace/);
});

test("D9: --command on a drop is refused by name", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy");
    const refused = await ground.self(["skill", "drop", "deploy", "--command", "c", "--why", "w"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /skill drop takes no --command/);
});

test("D10: a live skill's recipe cannot be pruned out from under it, and the refusal names the record", async () =>
{
    const ground = await floor();
    const recipe = join(ground.demo, "recipe.md");
    writeFileSync(recipe, "# release notes\n\ncollect the merged PRs\n");
    const id = receiptEntity((await must(ground.box, ground.demo,
        ["skill", "add", "release notes", "--file", recipe, "--purpose", "draft the notes"])).out);
    const artifact = String(recordOf(ground.ws, id).payload.artifact);
    const refused = await ground.self(["artifact", "prune", artifact, "--why", "reclaiming space"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${artifact} is what ${id} points at`));
});

test("D12: a workspace skill is not dropped from a project whose log does not hold it", async () =>
{
    const ground = await floor();
    await addSkill(ground, "deploy", "make deploy", "the shared one", ["--workspace"]);
    const beta = await project(ground, "beta");
    const refused = await selfIn(ground.box, beta, ["skill", "drop", "deploy", "--why", "beta does not deploy"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is a workspace skill recorded in project "demo"/);
    assert.match(refused.out, /in demo's checkout/);
});

test("D11: once the skill is withdrawn, its recipe's bytes are removable like any other", async () =>
{
    const ground = await floor();
    const recipe = join(ground.demo, "recipe.md");
    writeFileSync(recipe, "# release notes\n\ncollect the merged PRs\n");
    const id = receiptEntity((await must(ground.box, ground.demo,
        ["skill", "add", "release notes", "--file", recipe, "--purpose", "draft the notes"])).out);
    const artifact = String(recordOf(ground.ws, id).payload.artifact);
    await approvedIn(ground.box, ground.demo, ["skill", "drop", id, "--why", "the recipe is folded into the runbook"], id);
    const pruned = await approvedIn(ground.box, ground.demo, ["artifact", "prune", artifact, "--why", "reclaiming space"], artifact);
    assert.equal(pruned.code, 0, pruned.out);
    assert.match((await must(ground.box, ground.demo, ["artifact", "list"])).out, /pruned/);
});
