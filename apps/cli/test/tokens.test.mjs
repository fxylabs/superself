// Retention caps and the context budget are measured in tokens (#213). These
// cases are the approved case table for w-qm7yc: what `self tokens` accepts,
// what the ratio changes, and what a store written against the retired
// character-and-count keys is told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, machine, must, selfIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);
const self = (args) => selfIn(box, demo, args);

function configFile()
{
    return join(ws, ".superself", "config.json");
}

function writeConfig(patch)
{
    const file = configFile();
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, ...patch }) + "\n");
}

function dropKeys(...keys)
{
    const config = JSON.parse(readFileSync(configFile(), "utf8"));
    for (const key of keys)
    {
        delete config[key];
    }
    writeFileSync(configFile(), JSON.stringify(config) + "\n");
}

/* ── A: self tokens ────────────────────────────────────────────────── */

test("A1: with nothing measured, the ratio prints as the shipped estimate", () =>
{
    const shown = must(box, demo, ["tokens"]).out;
    assert.match(shown, /0\.25 tokens per character/);
    assert.match(shown, /the shipped estimate/);
});

test("A3: a measurement records the ratio and prints what it came from", () =>
{
    const recorded = must(box, demo, ["tokens", "300", "1200"]).out;
    assert.match(recorded, /0\.25 tokens per character/);
    assert.match(recorded, /measured from 300 tokens of 1200 characters/);
    // A2: reading it back says measured rather than estimated.
    assert.match(must(box, demo, ["tokens"]).out, /measured/);
    assert.doesNotMatch(must(box, demo, ["tokens"]).out, /shipped estimate/);
});

test("A4: one argument alone is refused with the usage", () =>
{
    const refused = self(["tokens", "300"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /tokens \[<tokens> <characters>\]/);
});

test("A5: zero and negative counts are refused", () =>
{
    for (const pair of [["0", "100"], ["100", "0"]])
    {
        const refused = self(["tokens", ...pair]);
        assert.notEqual(refused.code, 0, `self tokens ${pair.join(" ")} was accepted`);
        assert.match(refused.out, /whole number above zero/);
    }
    // A leading dash is a flag everywhere in this CLI, so a negative count is
    // refused by the parser before the verb ever sees it.
    const negative = self(["tokens", "-5", "100"]);
    assert.notEqual(negative.code, 0);
    assert.match(negative.out, /unknown option '-5'/);
});

test("A6: a fractional count is refused", () =>
{
    const refused = self(["tokens", "12.5", "100"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /whole number above zero/);
});

test("A7: more tokens than characters is refused as the arguments the wrong way round", () =>
{
    const refused = self(["tokens", "1200", "300"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no tokenizer emits more tokens than the text has characters/);
    assert.match(refused.out, /self tokens <tokens> <characters>/);
});

/* ── B and D: the ratio is what decides ────────────────────────────── */

test("B2 and D2: the same text passes or refuses depending on the recorded ratio", () =>
{
    writeConfig({ indexTokens: 10, tokensPerCharacter: 0.25, tokensMeasured: true });
    // 20 characters at 0.25 is 5 tokens, twice over: both fit under 10.
    must(box, demo, ["state", "add", "12345678901234567890"]);
    const second = self(["state", "add", "12345678901234567890"]);
    assert.equal(second.code, 0, second.out);
    // The same two entities at 0.5 cost 20 tokens, so the next one refuses —
    // nothing about the records changed, only what a character costs.
    writeConfig({ tokensPerCharacter: 0.5 });
    const refused = self(["state", "add", "12345678901234567890"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project index tier holds 20 of 10 tokens and this text adds 10 more/);
});

test("D3: two index sets of equal entity count and unequal text gate differently", () =>
{
    const wide = machine();
    const wideDemo = demoWorkspace(wide).demo;
    const file = join(wide.root, "ws", ".superself", "config.json");
    writeFileSync(file, JSON.stringify({ indexTokens: 20, tokensPerCharacter: 1, tokensMeasured: true }) + "\n");
    // Two short rows leave room; two long rows of the same count do not.
    must(wide, wideDemo, ["state", "add", "aaaa"]);
    must(wide, wideDemo, ["state", "add", "bbbb"]);
    assert.equal(selfIn(wide, wideDemo, ["state", "add", "cccc"]).code, 0);

    const tall = machine();
    const tallDemo = demoWorkspace(tall).demo;
    writeFileSync(join(tall.root, "ws", ".superself", "config.json"),
        JSON.stringify({ indexTokens: 20, tokensPerCharacter: 1, tokensMeasured: true }) + "\n");
    must(tall, tallDemo, ["state", "add", "aaaaaaaaaa"]);
    must(tall, tallDemo, ["state", "add", "bbbbbbbbbb"]);
    const refused = selfIn(tall, tallDemo, ["state", "add", "cccc"]);
    assert.notEqual(refused.code, 0, "two long rows gated like two short ones");
    assert.match(refused.out, /the project index tier holds 20 of 20 tokens/);
});

test("D4: an unmeasured ratio says so in the refusal it produced", () =>
{
    const fresh = machine();
    const freshDemo = demoWorkspace(fresh).demo;
    writeFileSync(join(fresh.root, "ws", ".superself", "config.json"), JSON.stringify({ indexTokens: 1 }) + "\n");
    const refused = selfIn(fresh, freshDemo, ["state", "add", "over the tiny cap"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /estimated at 0\.25 tokens per character/);
    assert.match(refused.out, /`self tokens` records a measurement/);
});

/* ── E: migration off the retired keys ─────────────────────────────── */

test("E3: a store still setting fullCap is refused, and told the converted value", () =>
{
    dropKeys("indexTokens", "fullTokens", "tokensPerCharacter", "tokensMeasured");
    writeConfig({ fullCap: 4000 });
    const refused = self(["state", "add", "anything at all"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /config\.json still sets fullCap, which counted characters of full-exposure text/);
    assert.match(refused.out, /replace it with fullTokens \(4000 characters is about 1000 tokens\)/);
});

test("E4: a store still setting indexCap is told an entity count converts into nothing", () =>
{
    dropKeys("fullCap");
    writeConfig({ indexCap: 50 });
    const refused = self(["state", "add", "anything at all"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /an entity count has no token conversion; the default is 12,000/);
});

test("E5: an old key beside its replacement is refused with the key to remove", () =>
{
    writeConfig({ indexTokens: 500 });
    const refused = self(["state", "add", "anything at all"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /indexTokens is already set, so remove indexCap/);
});

test("E1 and E2: with the old keys gone, the store gates on the new ones", () =>
{
    dropKeys("indexCap", "indexTokens");
    const added = self(["state", "add", "the defaults let this through"]);
    assert.equal(added.code, 0, added.out);
    writeConfig({ indexTokens: 1 });
    assert.notEqual(self(["state", "add", "but a one-token cap does not"]).code, 0);
});

/* ── F: the render budget ──────────────────────────────────────────── */

test("F1 and F2: the budget is stated in tokens and never refuses a render", () =>
{
    dropKeys("indexTokens");
    const under = must(box, demo, ["context"]).out;
    assert.ok(Array.from(under).length <= 12_000, `context ran past the budget: ${Array.from(under).length}`);
    // A ratio that costs twice as much buys half the characters, and the
    // render still answers — it cuts rows and points at the recovery command.
    writeConfig({ tokensPerCharacter: 0.5, tokensMeasured: true });
    for (const name of ["one", "two", "three"])
    {
        must(box, demo, ["convention", "add", `rule ${name} ${"x".repeat(3_000)}`]);
    }
    const over = must(box, demo, ["context"]).out;
    assert.equal(selfIn(box, demo, ["context"]).code, 0, "a render refused");
    assert.ok(Array.from(over).length <= 6_000, `context ran past the halved budget: ${Array.from(over).length}`);
    assert.match(over, /omitted; run `self state --project 'demo'`/);
});
