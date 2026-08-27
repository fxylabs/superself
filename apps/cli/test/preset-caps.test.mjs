// Preset adds gate behind the same cap check as `state add` (#240, w-wdhg4).
// One test per cell of the approved case table; each cell's expected outcome
// is the assertion. The refusal shapes themselves are pinned for `state add`
// by test/place.test.mjs — here the same shapes must come out of the preset
// verbs, because both reach the one gate (R1/R2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, git, idIn, machine, must, personIn, selfIn } from "./harness.mjs";

function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no entity id in: ${text}`);
    }
    return match[0];
}

// Caps are user-set values in the store's config.json, in tokens (#213). One
// token per character, so every cap below is the character count of the text
// it gates, which is what keeps the arithmetic in each cell readable.
function setCaps(activeBox, caps)
{
    const file = join(activeBox.root, "ws", ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

/* ── T1: preset add into a capped tier (convention add, full tier) ──── */

const t1Box = machine();
const t1Demo = (await demoWorkspace(t1Box)).demo;
const t1Self = (args) => selfIn(t1Box, t1Demo, args);
let t1Small;
let t1Fresh;

/* ── T2: per verb, each at exactly the cap of the tier it enters ────── */

const fullCapBox = machine();

const fullCapDemo = (await demoWorkspace(fullCapBox)).demo;

const fullCapSelf = (args) => selfIn(fullCapBox, fullCapDemo, args);

const indexCapBox = machine();

const indexCapDemo = (await demoWorkspace(indexCapBox)).demo;

const indexCapSelf = (args) => selfIn(indexCapBox, indexCapDemo, args);

let indexObjective;

/* ── T3: the cap counts per scope — the tier entered is where it renders ── */

const t3Box = machine();

const { ws: t3Ws, demo: t3Demo } = await demoWorkspace(t3Box);

const t3Other = join(t3Ws, "other");

mkdirSync(t3Other, { recursive: true });

git(t3Box, t3Other, ["init", "-q", "-b", "main"]);

await must(t3Box, t3Other, ["project", "init", "--name", "other", "--no-connect"]);

const t3Gamma = join(t3Ws, "gamma");

mkdirSync(t3Gamma, { recursive: true });

git(t3Box, t3Gamma, ["init", "-q", "-b", "main"]);

await must(t3Box, t3Gamma, ["project", "init", "--name", "gamma", "--no-connect"]);

const t3Self = (args) => selfIn(t3Box, t3Demo, args);

let t3ProjectSeat;

/* ── T4: propose passes, confirm gates (R3) ─────────────────────────── */

const t4Box = machine();

const t4Demo = (await demoWorkspace(t4Box)).demo;

const t4Self = (args) => selfIn(t4Box, t4Demo, args);

let t4Filler;

let t4First;

let t4Second;

/* ── T5: correction paths — --supersedes frees the predecessor's room ── */

const t5Box = machine();

const t5Demo = (await demoWorkspace(t5Box)).demo;

const t5Self = (args) => selfIn(t5Box, t5Demo, args);

let t5Successor;

test("T1.1: below the cap, a preset add records as today", async () =>
{
    setCaps(t1Box, { fullTokens: 40 });
    t1Small = idIn((await must(t1Box, t1Demo, ["convention", "add", "a small rule"])).out);
    assert.ok((await must(t1Box, t1Demo, ["state", "show", t1Small])).out.includes("placement: project · full"));
});

test("T1.2: exactly at the cap, a plain preset add refuses with the tier, the cap and the demote shapes", async () =>
{
    setCaps(t1Box, { fullTokens: 12 });
    const refused = await t1Self(["convention", "add", "x"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 12 of 12 tokens and this text adds 1 more/);
    assert.match(refused.out, /--demote <id>/);
    assert.match(refused.out, /\(that full entity moves to index\)/);
    assert.match(refused.out, /self state place <id> --exposure index --why/);
});

test("T1.3: over the cap, a plain preset add refuses with the same wording", async () =>
{
    setCaps(t1Box, { fullTokens: 10 });
    const refused = await t1Self(["convention", "add", "x"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 12 of 10 tokens and this text adds 1 more/);
    assert.match(refused.out, /--demote <id>/);
});

test("T1.4: at the cap, --demote freeing enough room records, and the demoted record moves one tier down", async () =>
{
    setCaps(t1Box, { fullTokens: 12 });
    t1Fresh = idIn((await must(t1Box, t1Demo, ["convention", "add", "a fresh rule", "--demote", t1Small])).out);
    assert.ok((await must(t1Box, t1Demo, ["state", "show", t1Small])).out.includes("placement: project · index"));
    assert.ok((await must(t1Box, t1Demo, ["state", "show", t1Fresh])).out.includes("placement: project · full"));
});

test("T1.5: at the cap, --demote freeing too little refuses, naming what is still short", async () =>
{
    const refused = await t1Self(["convention", "add", "a much longer rule", "--demote", t1Fresh]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /still 6 tokens over the 12-token full cap/);
});

test("T1.6: --demote naming a record in another tier refuses — a demotion frees a seat in the tier being entered", async () =>
{
    const refused = await t1Self(["convention", "add", "y", "--demote", t1Small]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /sits at index exposure — name a record at full exposure/);
});

test("T1.7: below the cap, text long enough to cross it by itself refuses — the added text counts before the write", async () =>
{
    setCaps(t1Box, { fullTokens: 40 });
    const refused = await t1Self(["convention", "add", "r".repeat(40)]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 12 of 40 tokens and this text adds 40 more/);
});

test("T1.8: below the cap, --demote given but not needed refuses as unnecessary", async () =>
{
    const refused = await t1Self(["convention", "add", "tiny", "--demote", t1Fresh]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is not over its cap — nothing needs to demote/);
});

test("T2.1: goal add at the full cap is refused", async () =>
{
    setCaps(fullCapBox, { fullTokens: 16 });
    await must(fullCapBox, fullCapDemo, ["state", "add", "16 chars of rule", "--exposure", "full"]);
    const refused = await fullCapSelf(["goal", "add", "a goal"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 16 of 16 tokens/);
});

test("T2.2: objective add at the full cap is refused", async () =>
{
    const refused = await fullCapSelf(["objective", "add", "an objective"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 16 of 16 tokens/);
});

test("T2.3: convention add at the full cap is refused", async () =>
{
    const refused = await fullCapSelf(["convention", "add", "a rule"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 16 of 16 tokens/);
});

test("T2.4: milestone add at the index cap is refused", async () =>
{
    setCaps(indexCapBox, { indexTokens: 16 });
    indexObjective = (await must(indexCapBox, indexCapDemo, ["objective", "add", "the objective"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    await must(indexCapBox, indexCapDemo, ["state", "add", "16 chars of note"]);
    const refused = await indexCapSelf(["milestone", "add", "reach the gate", "--objective", indexObjective, "--exit", "done"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project index tier holds 16 of 16 tokens/);
});

test("T2.5: decide with the default placement at the index cap is refused", async () =>
{
    const refused = await indexCapSelf(["decide", "a ruling"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project index tier holds 16 of 16 tokens/);
});

test("T2.6: decide in a store whose alias sets exposure search records — the search tier is uncapped", async () =>
{
    await must(indexCapBox, indexCapDemo, ["alias", "set", "decide", "--exposure", "search"]);
    const id = idIn((await must(indexCapBox, indexCapDemo, ["decide", "search bound ruling"])).out);
    assert.ok((await must(indexCapBox, indexCapDemo, ["state", "show", id])).out.includes("placement: project · search"));
});

test("T2.7: work add records ungated — it enters the search tier", async () =>
{
    // A person's own command since #389, and the cap is what this cell is
    // about: driven with a keyboard so the retention tier is what answers.
    const added = await personIn(indexCapBox, indexCapDemo, ["work", "add", "an outcome"]);
    assert.equal(added.code, 0, added.out);
});

test("T2.8: an alias-resolved add at its configured tier's cap is refused — it was already gated", async () =>
{
    await must(fullCapBox, fullCapDemo, ["alias", "add", "memo", "--exposure", "full"]);
    const refused = await fullCapSelf(["memo", "add", "a memo"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 16 of 16 tokens/);
});

test("T3.1: scope omitted, this project's tier at cap — refused naming this project", async () =>
{
    setCaps(t3Box, { fullTokens: 16 });
    t3ProjectSeat = entityIn((await must(t3Box, t3Demo, ["state", "add", "16 chars of rule", "--exposure", "full"])).out);
    const refused = await t3Self(["convention", "add", "a rule"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 16 of 16 tokens/);
});

test("T3.2: workspace scope with room records while this project's tier is at cap — the workspace tier is the one entered", async () =>
{
    const id = idIn((await must(t3Box, t3Demo, ["convention", "add", "a workspace rule", "--workspace"])).out);
    assert.ok((await must(t3Box, t3Demo, ["state", "show", id])).out.includes("placement: workspace · full"));
});

test("T3.3: --scope naming a project whose tier is at cap — refused naming the destination project", async () =>
{
    await must(t3Box, t3Other, ["state", "add", "16 chars of rule", "--exposure", "full"]);
    await must(t3Box, t3Demo, ["alias", "add", "memo", "--exposure", "full"]);
    const refused = await t3Self(["memo", "add", "a memo", "--scope", "other"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the other full tier holds 16 of 16 tokens/);
});

test("T3.4: --scope naming a project below its cap records while this project is at cap", async () =>
{
    const id = entityIn((await must(t3Box, t3Demo, ["memo", "add", "a gamma memo", "--scope", "gamma"])).out);
    assert.ok((await must(t3Box, t3Demo, ["state", "show", id])).out.includes("placement: gamma · full"));
});

test("T3.5: --demote naming a record in a different scope than the one entered is refused", async () =>
{
    const refused = await t3Self(["convention", "add", "w", "--workspace", "--demote", t3ProjectSeat]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is project-scoped — the workspace full cap frees only by demoting workspace-scoped records/);
});

test("T4.1: a --proposed preset add into a tier at cap records — no room check at propose time", async () =>
{
    setCaps(t4Box, { indexTokens: 17 });
    t4Filler = entityIn((await must(t4Box, t4Demo, ["state", "add", "17 chars of rule!"])).out);
    const proposed = await t4Self(["decide", "over the cap now", "--proposed"]);
    assert.equal(proposed.code, 0, proposed.out);
    assert.match(proposed.out, /entity\.proposed recorded/);
    t4First = idIn(proposed.out);
});

test("T4.2: confirming that proposal while still at cap is refused at confirm", async () =>
{
    const refused = await t4Self(["decide", "confirm", t4First]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /would put the project index tier over its cap \(17 of 17 tokens held\)/);
});

test("T4.3: confirming it after room was freed confirms", async () =>
{
    await must(t4Box, t4Demo, ["state", "place", t4Filler, "--exposure", "search", "--why", "make room"]);
    await must(t4Box, t4Demo, ["decide", "confirm", t4First]);
    assert.ok((await must(t4Box, t4Demo, ["state", "show", t4First])).out.includes("placement: project · index"));
});

test("T4.4: --proposed with --demote records the pair, and confirm applies both together", async () =>
{
    // Index holds the confirmed decision (16 of 17): the new 17-token ruling
    // needs the seat, so the agent lands the pair and a person confirms it.
    const proposed = await must(t4Box, t4Demo, ["decide", "a second ruling!!", "--proposed", "--demote", t4First]);
    t4Second = idIn(proposed.out);
    const holderShown = (await must(t4Box, t4Demo, ["state", "show", t4First])).out;
    assert.ok(holderShown.includes(`pending placement: exposure search (demoted to admit ${t4Second} under the index cap)`));
    const swap = await must(t4Box, t4Demo, ["decide", "confirm", t4Second]);
    assert.equal([...swap.out.matchAll(/entity\.confirmed/g)].length, 2, `the pair did not land as one unit:\n${swap.out}`);
    assert.ok((await must(t4Box, t4Demo, ["state", "show", t4Second])).out.includes("placement: project · index"));
    assert.ok((await must(t4Box, t4Demo, ["state", "show", t4First])).out.includes("placement: project · search"));
});

test("T4.5: a declined proposal consumed no room and none was ever reserved", async () =>
{
    // Index stands at exactly 17 of 17 with the confirmed second ruling.
    const proposed = await must(t4Box, t4Demo, ["decide", "one more ruling!!", "--proposed"]);
    const third = idIn(proposed.out);
    await must(t4Box, t4Demo, ["decide", "decline", third, "--why", "not needed"]);
    // Freeing the confirmed seat leaves exactly 17 tokens of room: the add
    // below fills all of it, so any seat the declined proposal still held
    // would refuse this write.
    await must(t4Box, t4Demo, ["state", "place", t4Second, "--exposure", "search", "--why", "drained"]);
    const filled = await t4Self(["state", "add", "17 chars of rule!"]);
    assert.equal(filled.code, 0, filled.out);
});

test("T5.1: --supersedes in the same tier records — the predecessor's room is freed by the same write", async () =>
{
    setCaps(t5Box, { fullTokens: 16 });
    const first = idIn((await must(t5Box, t5Demo, ["convention", "add", "16 chars of rule"])).out);
    const replaced = await approvedIn(t5Box, t5Demo, ["convention", "add", "sixteen chars ok", "--supersedes", first], first);
    assert.equal(replaced.code, 0, replaced.out);
    t5Successor = idIn(replaced.printed);
    assert.ok((await must(t5Box, t5Demo, ["state", "show", t5Successor])).out.includes("placement: project · full"));
    assert.ok((await must(t5Box, t5Demo, ["state", "show", first])).out.includes("superseded"));
});

test("T5.2: a successor longer than the room freed is refused, naming the shortfall", async () =>
{
    const refused = await t5Self(["convention", "add", "a rule far too long!!", "--supersedes", t5Successor]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 0 of 16 tokens and this text adds 21 more/);
});

test("T5.3: a predecessor in another tier frees nothing — the entered tier's room is what is checked", async () =>
{
    const shared = idIn((await must(t5Box, t5Demo, ["convention", "add", "ws rule sixteen!", "--workspace"])).out);
    const refused = await t5Self(["convention", "add", "project bound", "--supersedes", shared]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project full tier holds 16 of 16 tokens and this text adds 13 more/);
});
