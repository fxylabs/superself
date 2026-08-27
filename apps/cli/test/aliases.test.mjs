// The alias table and its dispatch (#207 A): built-in preset rows as
// defaults, user rows overriding or extending them in the workspace
// config.json, and the dispatcher resolving unknown first tokens against the
// merged table. Every test derives from its A cell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, idIn, machine, must, mustPerson, selfIn } from "./harness.mjs";

const box = machine();
const { demo } = await demoWorkspace(box);
const self = (args) => selfIn(box, demo, args);
const configFile = join(box.root, "ws", ".superself", "config.json");

function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no entity id in: ${text}`);
    }
    return match[0];
}

async function placementOf(id)
{
    const shown = (await must(box, demo, ["state", "show", id])).out;
    const line = shown.split("\n").find((item) => item.startsWith("placement:"));
    return line ?? "(no placement line)";
}

test("A1: all 8 preset verbs resolve through the table with spec §7 defaults", async () =>
{
    const goal = idIn((await must(box, demo, ["goal", "add", "own the niche"])).out);
    assert.equal(await placementOf(goal), "placement: project · full · priority 0");
    const objective = (await must(box, demo, ["objective", "add", "reach preview"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    assert.equal(await placementOf(objective), "placement: project · full · priority 10");
    const milestone = (await must(box, demo, ["milestone", "add", "suite green", "--objective", objective, "--exit", "tests pass"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    assert.equal(await placementOf(milestone), "placement: project · index · priority 20");
    const convention = idIn((await must(box, demo, ["convention", "add", "events only"])).out);
    assert.equal(await placementOf(convention), "placement: project · full · priority 30");
    const decision = idIn((await must(box, demo, ["decide", "keep sqlite"])).out);
    assert.equal(await placementOf(decision), "placement: project · index · priority 40");
    const idea = entityIn((await must(box, demo, ["idea", "add", "a spark"])).out);
    assert.equal(await placementOf(idea), "placement: project · search");
    assert.ok((await must(box, demo, ["state", "show", idea])).out.includes("labels: idea"));
    const roadmap = entityIn((await must(box, demo, ["roadmap", "add", "the arc"])).out);
    assert.equal(await placementOf(roadmap), "placement: project · index");
    assert.ok((await must(box, demo, ["state", "show", roadmap])).out.includes("labels: roadmap"));
    const work = (await mustPerson(box, demo, ["work", "add", "ship it"])).out.match(/\bw-[0-9a-z]{5}\b/)[0];
    assert.equal(await placementOf(work), "placement: project · search");
});

test("A2: a custom verb records an entity with its row's defaults", async () =>
{
    await must(box, demo, ["alias", "add", "risk", "--label", "risk", "--priority", "35", "--exposure", "index"]);
    const id = entityIn((await must(box, demo, ["risk", "add", "vendor lock-in"])).out);
    const shown = (await must(box, demo, ["state", "show", id])).out;
    assert.ok(shown.includes("labels: risk"));
    assert.equal(await placementOf(id), "placement: project · index · priority 35");
});

test("A3: alias set overrides a built-in row and subsequent preset calls use it", async () =>
{
    await must(box, demo, ["alias", "set", "decide", "--priority", "7"]);
    const decision = idIn((await must(box, demo, ["decide", "override check"])).out);
    assert.equal(await placementOf(decision), "placement: project · index · priority 7");
    assert.match((await must(box, demo, ["alias"])).out, /decide.*built-in, overridden/);
});

test("A4: alias drop removes a custom verb and restores an overridden built-in", async () =>
{
    await must(box, demo, ["alias", "drop", "risk"]);
    const refused = await self(["risk", "add", "gone now"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown command 'risk'/);
    await must(box, demo, ["alias", "drop", "decide"]);
    const decision = idIn((await must(box, demo, ["decide", "back to default"])).out);
    assert.equal(await placementOf(decision), "placement: project · index · priority 40");
    const bare = await self(["alias", "drop", "decide"]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /carries its shipped default — nothing to drop/);
});

test("A5: alias add naming a non-preset built-in command refuses by the reserved word", async () =>
{
    for (const reserved of ["context", "sync", "state", "alias"])
    {
        const result = await self(["alias", "add", reserved, "--label", "x"]);
        assert.notEqual(result.code, 0, `alias add ${reserved} was accepted`);
        assert.match(result.out, new RegExp(`"${reserved}" is a built-in command`));
    }
    const existing = await self(["alias", "add", "decide", "--label", "x"]);
    assert.notEqual(existing.code, 0);
    assert.match(existing.out, /already has an alias row/);
});

test("A6: an unknown verb with no row keeps the unknown-command refusal", async () =>
{
    const result = await self(["bogus"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown command 'bogus'/);
});

test("A7: hand-editing the config then invoking behaves identically to alias set", async () =>
{
    const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
    config.aliases = { ...config.aliases, pulse: { label: "pulse", priority: 12, exposure: "index" } };
    writeFileSync(configFile, JSON.stringify(config) + "\n");
    const id = entityIn((await must(box, demo, ["pulse", "add", "weekly pulse"])).out);
    assert.ok((await must(box, demo, ["state", "show", id])).out.includes("labels: pulse"));
    assert.equal(await placementOf(id), "placement: project · index · priority 12");
    assert.match((await must(box, demo, ["alias"])).out, /pulse.*custom/);
});

test("A8: explicit placement flags on an alias verb beat the row's defaults", async () =>
{
    const id = entityIn((await must(box, demo, ["pulse", "add", "louder pulse",
        "--priority", "3", "--exposure", "full", "--scope", "workspace"])).out);
    assert.equal(await placementOf(id), "placement: workspace · full · priority 3");
});
