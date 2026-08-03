// The placement projection (#202, #197 §6): `self context` renders entities
// by priority and exposure — full text, one line, absent-with-pointer — with
// the derived live state anchored between the full block and the index lines,
// under the unchanged 12,000-character budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = demoWorkspace(box);

function shortIdIn(text, prefix)
{
    const match = text.match(new RegExp(`\\b${prefix}-[0-9a-z]{5}\\b`));
    if (match === null)
    {
        throw new Error(`no ${prefix}- id in: ${text}`);
    }
    return match[0];
}

function setCaps(activeBox, caps)
{
    const file = join(activeBox.root, "ws", ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, ...caps }) + "\n");
}

let decision;
let objective;

test("context renders by placement: full block, anchored live state, index lines, search pointer", () =>
{
    must(box, demo, ["goal", "set", "own the niche"]);
    objective = shortIdIn(must(box, demo, ["objective", "add", "reach preview", "--target", "2030-01-01"]).out, "o");
    must(box, demo, ["convention", "add", "events only, no hand edits"]);
    decision = must(box, demo, ["decide", "keep sqlite", "--why", "simple"]).out.match(/\[([^\]]+)\]/)[1];
    must(box, demo, ["milestone", "add", "suite green", "--objective", objective, "--exit", "tests pass"]);
    const work = workIdIn(must(box, demo, ["work", "add", "ship phase 2"]).out);
    must(box, demo, ["work", "start", work]);
    must(box, demo, ["state", "add", "raw searchable note", "--exposure", "search"]);

    const out = must(box, demo, ["context"]).out;
    const at = (needle) =>
    {
        const index = out.indexOf(needle);
        assert.notEqual(index, -1, `context is missing "${needle}":\n${out}`);
        return index;
    };
    // The full block in priority order: goal 0, objective 10, convention 30.
    assert.ok(at("- [goal] own the niche") < at("- [objective] reach preview (target 2030-01-01)"));
    assert.ok(at("- [objective] reach preview") < at("- [convention] events only, no hand edits"));
    // Live state anchors after the full block, before the index lines.
    assert.ok(at("- [convention] events only, no hand edits") < at("## Work in progress"));
    assert.ok(at(`- ${work} ship phase 2`) < at("## Index"));
    assert.ok(at("## Deadlines") < at("- 2030-01-01: [objective] reach preview"));
    // Index: one line each, priority order — milestone 20 before decision 40.
    assert.ok(at("- [milestone] suite green") < at("- [decision] keep sqlite — simple"));
    // Search exposure is absent with a pointer.
    assert.ok(!out.includes("raw searchable note"), "a search-exposure entity rendered in context");
    at("- 1 entity at search exposure; run `self state --project 'demo'`");
    // The replaced ladder's fixed sections are gone.
    assert.ok(!out.includes("Goal:"), "the hardcoded Goal: line survived the placement projection");
});

test("a placement event reorders the projection for a preset record", () =>
{
    must(box, demo, ["state", "place", decision, "--exposure", "full", "--priority", "5"]);
    const out = must(box, demo, ["context"]).out;
    const goal = out.indexOf("- [goal] own the niche");
    const moved = out.indexOf("- [decision] keep sqlite — simple");
    const objectiveRow = out.indexOf("- [objective] reach preview");
    assert.ok(goal !== -1 && moved !== -1 && objectiveRow !== -1, out);
    assert.ok(goal < moved && moved < objectiveRow, "priority 5 did not order the promoted decision between 0 and 10");
});

test("equal priorities tie by recency, absent priority sorts last, and refolds keep one order", () =>
{
    must(box, demo, ["state", "add", "alpha row", "--priority", "1"]);
    must(box, demo, ["state", "add", "beta row", "--priority", "1"]);
    must(box, demo, ["state", "add", "gamma row"]);
    const out = must(box, demo, ["context"]).out;
    const beta = out.indexOf("- beta row");
    const alpha = out.indexOf("- alpha row");
    const milestone = out.indexOf("- [milestone] suite green");
    const gamma = out.indexOf("- gamma row");
    assert.ok(beta !== -1 && alpha !== -1 && milestone !== -1 && gamma !== -1, out);
    assert.ok(beta < alpha, "the newer of two equal priorities did not render first");
    assert.ok(alpha < milestone && milestone < gamma, "an absent priority did not sort last");
    must(box, demo, ["fold"]);
    const refolded = must(box, demo, ["context"]).out;
    assert.equal(refolded, out, "a refold changed the rendered order");
});

// A fresh machine for the empty store and the budget, where the content sizes
// stay under the test's control.
const freshBox = machine();
const freshDemo = demoWorkspace(freshBox).demo;

test("a fresh store renders no empty section headers, and live state renders without entities", () =>
{
    const empty = must(freshBox, freshDemo, ["context"]).out;
    assert.ok(!empty.includes("##"), `an empty store rendered a section header:\n${empty}`);
    assert.ok(empty.includes("# demo"));
    const work = workIdIn(must(freshBox, freshDemo, ["work", "add", "only moving part"]).out);
    must(freshBox, freshDemo, ["work", "start", work]);
    const out = must(freshBox, freshDemo, ["context"]).out;
    assert.ok(out.includes("## Work in progress"), "live state did not render with an empty full block");
    assert.ok(out.includes(`- ${work} only moving part`));
    assert.ok(!out.includes("## Index"), "an empty index block rendered its header");
});

test("budget exhaustion mid-block leaves pointer rows that name the recovery command", () =>
{
    // Preset conventions are not cap-gated, so the full tier can exceed the
    // whole 12,000-character budget: three rules of 5,000 characters.
    for (const name of ["one", "two", "three"])
    {
        must(freshBox, freshDemo, ["convention", "add", `rule ${name} ${"x".repeat(5_000)}`]);
    }
    must(freshBox, freshDemo, ["decide", "small enough to omit"]);
    const out = must(freshBox, freshDemo, ["context"]).out;
    assert.ok(Array.from(out).length <= 12_000, `context ran past the budget: ${Array.from(out).length}`);
    assert.match(out, /- … \d+ full-exposure entit(y|ies) omitted; run `self state --project 'demo'`/);
    assert.match(out, /- … 1 index row omitted; run `self state --project 'demo'`/);
    assert.match(out, /- … 1 work item omitted; run `self work --project 'demo'`/);
});

// A machine whose legacy records stand past a cap, as the real store's
// decisions do: rendering never refuses, the entity verbs are what the cap
// gates, and repeatable --demote is how a deep overrun names enough.
const legacyBox = machine();
const legacyDemo = demoWorkspace(legacyBox).demo;
const legacySelf = (args) => selfIn(legacyBox, legacyDemo, args);

test("a legacy store over a cap renders in full while state add stays gated", () =>
{
    setCaps(legacyBox, { indexCap: 1 });
    const first = must(legacyBox, legacyDemo, ["decide", "legacy ruling one"]).out.match(/\[([^\]]+)\]/)[1];
    const second = must(legacyBox, legacyDemo, ["decide", "legacy ruling two"]).out.match(/\[([^\]]+)\]/)[1];
    const out = must(legacyBox, legacyDemo, ["context"]).out;
    assert.ok(out.includes("- [decision] legacy ruling one"));
    assert.ok(out.includes("- [decision] legacy ruling two"));
    const refused = legacySelf(["state", "add", "a third index row"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project index tier holds 2 of 1 entities/);
    const short = legacySelf(["state", "add", "a third index row", "--demote", first]);
    assert.notEqual(short.code, 0);
    assert.match(short.out, /still 1 over the 1-entity index cap after 1 named demotion/);
    must(legacyBox, legacyDemo, ["state", "add", "a third index row", "--demote", first, "--demote", second]);
    assert.ok(must(legacyBox, legacyDemo, ["state", "show", first]).out.includes("placement: project · search"));
    assert.ok(must(legacyBox, legacyDemo, ["state", "show", second]).out.includes("placement: project · search"));
});
