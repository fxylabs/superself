// Cutover integrity (#207 E). E1 replays a store written entirely by the
// pre-cutover binary (the merge base, built and driven by the fixture
// generator) against this binary: every captured read surface must answer
// byte-identically, and a refold must leave the canonical files byte-identical.
// E2/E3 fold a mixed log — legacy events plus new entity events targeting
// them — and E6 pins the printed lines to the entity events the verbs record
// (ruling ②). E4 (no legacy write path remains) is the dispatcher's diff
// gate, deliberately not a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoWorkspace, git, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));

/* ── E1: pre-cutover store byte-identity ───────────────────────────── */

const e1 = machine();
const ws = join(e1.root, "ws");
const store = join(ws, ".superself");
mkdirSync(ws, { recursive: true });
cpSync(join(fixtures, "pre-cutover-store"), store, { recursive: true });
must(e1, ws, ["workspace", ws]);

test("E1: every captured read surface answers byte-identically for a pre-cutover store", () =>
{
    const manifest = JSON.parse(readFileSync(join(fixtures, "pre-cutover-reads", "manifest.json"), "utf8"));
    assert.ok(manifest.length >= 15, "the fixture manifest shrank unexpectedly");
    for (const [name, args] of manifest)
    {
        const expected = readFileSync(join(fixtures, "pre-cutover-reads", `${name}.txt`), "utf8");
        const result = must(e1, ws, args);
        assert.equal(result.out, expected, `\`self ${args.join(" ")}\` drifted from the pre-cutover binary (${name})`);
    }
});

test("E1: a refold leaves the pre-cutover canonical files byte-identical", () =>
{
    const dir = join(store, "projects", "demo");
    const canonical = ["state.md",
        ...readdirSync(join(dir, "objective")).map((name) => join("objective", name)),
        ...readdirSync(join(dir, "work")).map((name) => join("work", name))];
    const before = new Map(canonical.map((rel) => [rel, readFileSync(join(dir, rel), "utf8")]));
    // The store travels without its git history; the refold path commits, so
    // the copy gets a fresh repository first. `lang en` is the workspace-wide
    // refold every view setting takes (the language is already en).
    git(e1, store, ["init", "-q", "-b", "main"]);
    must(e1, ws, ["lang", "en"]);
    for (const rel of canonical)
    {
        assert.equal(readFileSync(join(dir, rel), "utf8"), before.get(rel),
            `${rel} was rewritten differently by the post-cutover fold`);
    }
});

/* ── E2/E3: a mixed log folds coherently and deterministically ─────── */

const mixedBox = machine();
const { demo: mixedDemo } = demoWorkspace(mixedBox);
const mixedLog = join(mixedBox.root, "ws", ".superself", "projects", "demo", "log.jsonl");

test("E2: lifecycle verbs target legacy-derived records and record entity events referencing them", () =>
{
    // A pre-cutover log fragment: a proposed decision and a convention, in
    // the event types only an old binary writes.
    appendFileSync(mixedLog, [
        { id: "01hz00000000000000000000e1", ts: "2025-01-01T00:00:00.000Z", type: "decision.proposed", project: "demo", payload: { text: "adopt the queue" }, refs: {}, origin: {} },
        { id: "01hz00000000000000000000e2", ts: "2025-01-01T00:01:00.000Z", type: "convention.added", project: "demo", payload: { text: "legacy standing rule" }, refs: {}, origin: {} }
    ].map((line) => JSON.stringify(line) + "\n").join(""));
    must(mixedBox, mixedDemo, ["fold"]);
    // Confirm the legacy proposal through the cutover verb: the event is
    // entity.confirmed, and the legacy-derived record settles to confirmed.
    const confirmed = must(mixedBox, mixedDemo, ["decide", "confirm", "01hz00000000000000000000e1"]);
    assert.match(confirmed.out, /entity\.confirmed recorded/);
    assert.ok(must(mixedBox, mixedDemo, ["state", "show", "01hz00000000000000000000e1"]).out.includes("confirmed"));
    assert.ok(must(mixedBox, mixedDemo, ["context"]).out.includes("adopt the queue"),
        "a legacy proposal confirmed through an entity event did not reach the render");
    // Place the legacy convention by entity event, then withdraw it.
    must(mixedBox, mixedDemo, ["state", "place", "01hz00000000000000000000e2", "--priority", "5"]);
    assert.ok(must(mixedBox, mixedDemo, ["state", "show", "01hz00000000000000000000e2"]).out.includes("placement: project · full · priority 5"));
    const dropped = must(mixedBox, mixedDemo, ["convention", "drop", "01hz00000000000000000000e2", "--why", "replaced by the gate"]);
    assert.match(dropped.out, /entity\.retracted recorded/);
    assert.ok(!must(mixedBox, mixedDemo, ["context"]).out.includes("legacy standing rule"),
        "a legacy convention dropped through an entity event still renders");
    assert.match(must(mixedBox, mixedDemo, ["search", "legacy standing rule", "--type", "convention"]).out, /\[dropped\]/);
});

test("E3: two folds of a mixed store render identically", () =>
{
    must(mixedBox, mixedDemo, ["decide", "a native ruling beside legacy history"]);
    must(mixedBox, mixedDemo, ["fold"]);
    const context = must(mixedBox, mixedDemo, ["context"]).out;
    const list = must(mixedBox, mixedDemo, ["state", "list"]).out;
    const stateFile = join(mixedBox.root, "ws", ".superself", "projects", "demo", "state.md");
    const stateBefore = readFileSync(stateFile, "utf8");
    must(mixedBox, mixedDemo, ["fold"]);
    assert.equal(must(mixedBox, mixedDemo, ["context"]).out, context, "a refold changed the rendered context");
    assert.equal(must(mixedBox, mixedDemo, ["state", "list"]).out, list, "a refold changed the entity list");
    assert.equal(readFileSync(stateFile, "utf8"), stateBefore, "a refold changed the canonical state file");
});

/* ── E5: evidence-gate parity ──────────────────────────────────────── */

// The phase 3 evidence-gate suite is the regression net (#207 E5): the B
// tests of test/execution.test.mjs — "B: no reports and no done-time text
// refuses…", "B: bare-summary reports do not satisfy done (ruling 2)",
// "B: a done-time text report satisfies the gate and is recorded",
// "B: a report carrying an artifact satisfies done", "B: a report carrying
// commit evidence satisfies done" — run unchanged against the cutover
// binary. One representative refusal is pinned here so parity is asserted in
// this file too.
test("E5: the done evidence refusal reads exactly as it did before the cutover", () =>
{
    const work = workIdIn(must(mixedBox, mixedDemo, ["work", "add", "close with nothing"]).out);
    const refused = selfIn(mixedBox, mixedDemo, ["work", "done", work]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /has no evidence for done — attach a report first/);
    assert.match(refused.out, /self report/);
    assert.match(refused.out, /--report/);
});

/* ── E6: honest output — the printed line names the entity event ───── */

test("E6: one representative verb per family prints the entity event it records", () =>
{
    const box = machine();
    const { demo } = demoWorkspace(box);
    assert.match(must(box, demo, ["goal", "set", "own the niche"]).out, /entity\.confirmed recorded/);
    const proposed = idIn(must(box, demo, ["decide", "maybe so", "--proposed"]).out);
    assert.match(must(box, demo, ["decide", "decline", proposed, "--why", "not now"]).out, /entity\.retracted recorded/);
    const objective = must(box, demo, ["objective", "add", "reach preview"]).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const milestone = must(box, demo, ["milestone", "add", "suite green", "--objective", objective, "--exit", "tests pass"]).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    assert.match(must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "ran green"]).out, /entity\.covered recorded/);
    assert.match(must(box, demo, ["milestone", "reach", milestone]).out, /entity\.done recorded/);
    const work = workIdIn(must(box, demo, ["work", "add", "ship it"]).out);
    assert.match(must(box, demo, ["work", "start", work]).out, /entity\.started recorded/);
    assert.match(must(box, demo, ["work", "retire", work, "--why", "moved on"]).out, /entity\.retired recorded/);
    const raw = must(box, demo, ["state", "add", "standing note"]).out.match(/\be-[0-9a-z]{5}\b/)[0];
    assert.match(must(box, demo, ["state", "place", raw, "--priority", "3"]).out, /entity\.placed recorded/);
});
