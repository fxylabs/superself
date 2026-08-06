// Workspace scope as a placement value (#207 D): a workspace-scoped entity
// renders in every project's context while its events stay in the home
// store, caps count per scope value, and a capped workspace tier gates with
// the same one-pass refusal and demotion shapes the project tiers use
// (test/place.test.mjs pins those shapes for project scope).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, git, idIn, machine, must, selfIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);
const other = join(ws, "other");
mkdirSync(other, { recursive: true });
git(box, other, ["init", "-q", "-b", "main"]);
must(box, other, ["project", "init", "--name", "other", "--no-connect"]);

const self = (args) => selfIn(box, demo, args);

function entityIn(text)
{
    return text.match(/\be-[0-9a-z]{5}\b/)[0];
}

function setCaps(caps, root = ws)
{
    const file = join(root, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    // One token per character, so the cap below is the character count of the
    // text it gates (#213).
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

function otherContext()
{
    return must(box, other, ["context"]).out;
}

let shared;

test("D1: state add --scope workspace renders in every project's context, from the home store", () =>
{
    shared = entityIn(must(box, demo, ["state", "add", "one shared truth", "--scope", "workspace", "--priority", "5"]).out);
    assert.ok(must(box, demo, ["context"]).out.includes("one shared truth"), "the home project lost its own workspace entity");
    assert.ok(otherContext().includes("one shared truth"), "the workspace entity did not reach the other project's context");
    // The events stayed in the home store: the home log carries the creation,
    // and the other project's log — not yet written to at all — carries nothing.
    assert.ok(readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").includes(shared));
    assert.ok(!existsSync(join(ws, ".superself", "projects", "other", "log.jsonl")),
        "recording a workspace entity wrote into another project's store");
});

test("D2: state place --scope workspace moves an entity into every context by placement event", () =>
{
    const local = entityIn(must(box, demo, ["state", "add", "promoted note", "--priority", "6"]).out);
    assert.ok(!otherContext().includes("promoted note"));
    must(box, demo, ["state", "place", local, "--scope", "workspace"]);
    assert.ok(must(box, demo, ["state", "show", local]).out.includes("placement: workspace · index · priority 6"));
    assert.ok(otherContext().includes("promoted note"), "a workspace placement did not reach the other context");
    // D3: back to one project's context only. The `project` keyword was retired
    // by #181, so the home project is named by its slug.
    must(box, demo, ["state", "place", local, "--scope", "demo"]);
    assert.ok(!otherContext().includes("promoted note"), "a project placement still renders workspace-wide");
    assert.ok(must(box, demo, ["context"]).out.includes("promoted note"));
});

// A fresh machine for the cap arithmetic, so each tier's exact count is what
// this section put there and nothing else.
const capBox = machine();
const capWs = join(capBox.root, "ws");
const capDemo = demoWorkspace(capBox).demo;
const capSelf = (args) => selfIn(capBox, capDemo, args);
let capShared;

test("D4: the caps count per scope value, so the tiers fill and gate independently", () =>
{
    setCaps({ indexTokens: 14 }, capWs);
    must(capBox, capDemo, ["state", "add", "project seat"]);
    const projectRefused = capSelf(["state", "add", "one over"]);
    assert.notEqual(projectRefused.code, 0);
    assert.match(projectRefused.out, /the project index tier holds 12 of 14 tokens/);
    // The full project tier does not gate the workspace tier: the first
    // workspace add still fits, and only the second hits the workspace cap.
    capShared = entityIn(must(capBox, capDemo, ["state", "add", "workspace seat", "--scope", "workspace"]).out);
    const workspaceRefused = capSelf(["state", "add", "workspace over", "--scope", "workspace"]);
    assert.notEqual(workspaceRefused.code, 0);
    assert.match(workspaceRefused.out, /the workspace index tier holds 14 of 14 tokens/);
});

test("D5: a capped workspace tier refuses with the same one-pass shape, and --demote frees it", () =>
{
    // The shapes — cap, usage, remedy, chained demotion — are pinned for
    // project scope by test/place.test.mjs ("adding past the index cap is
    // refused with the cap, the usage, and the demote shape" and the chain
    // tests); this asserts the workspace tier speaks the same contract.
    const refused = capSelf(["state", "add", "workspace over", "--scope", "workspace"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--demote <id>/);
    assert.match(refused.out, /self state place <id> --exposure search --why/);
    const projectSeat = must(capBox, capDemo, ["state", "list"]).out.match(/\be-[0-9a-z]{5}\b(?=.*project seat)/)[0];
    const wrongScope = capSelf(["state", "add", "workspace over", "--scope", "workspace", "--demote", projectSeat]);
    assert.notEqual(wrongScope.code, 0);
    assert.match(wrongScope.out, /is project-scoped — the workspace index cap frees only by demoting workspace-scoped records/);
    const admitted = entityIn(must(capBox, capDemo, ["state", "add", "workspace over", "--scope", "workspace", "--demote", capShared]).out);
    assert.ok(must(capBox, capDemo, ["state", "show", capShared]).out.includes("placement: workspace · search"));
    assert.ok(must(capBox, capDemo, ["state", "show", admitted]).out.includes("placement: workspace · index"));
});

test("D6: convention add --workspace records at workspace scope and renders everywhere", () =>
{
    const rule = idIn(must(box, demo, ["convention", "add", "one shared rule", "--workspace"]).out);
    assert.ok(must(box, demo, ["state", "show", rule]).out.includes("placement: workspace · full · priority 30"));
    assert.ok(otherContext().includes("one shared rule"), "a workspace convention did not reach the other project's context");
});

test("D7: workspace and project entities interleave by priority in one ordering", () =>
{
    must(box, other, ["goal", "add", "the other project's goal"]);
    must(box, other, ["objective", "add", "the other project's objective"]);
    must(box, demo, ["state", "place", shared, "--exposure", "full", "--why", "promoted for the ordering check"]);
    const context = otherContext();
    const goal = context.indexOf("- [goal] the other project's goal");
    const sharedRow = context.indexOf("- one shared truth");
    const objective = context.indexOf("- [objective] the other project's objective");
    assert.ok(goal !== -1 && sharedRow !== -1 && objective !== -1, context);
    assert.ok(goal < sharedRow && sharedRow < objective,
        "a workspace entity at priority 5 did not interleave between priorities 0 and 10");
});
