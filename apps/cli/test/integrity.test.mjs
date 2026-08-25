// Cutover integrity (#207 E). E1 replays a store written entirely by the
// pre-cutover binary (the merge base, built and driven by the fixture
// generator) against this binary. E2/E3 fold a mixed log — legacy events plus
// new entity events targeting them — and E6 pins the printed lines to the
// entity events the verbs record (ruling ②). E4 (no legacy write path remains)
// is the dispatcher's diff gate, deliberately not a test.
//
// E1's claim is narrower since #305, which stopped folding `work.*` to state.
// The fixture store's one legacy unit `w-2hcs1` is linked to the milestone
// `m-48nbn`, so the surfaces that answer for work — and the work-linkage line
// of every surface that names one — legitimately changed. What is still
// byte-identical for a pre-cutover store is the nine captures that read no
// work (`state list`, the seven `state show` pages, and `self log`) and, on
// the surfaces that do, every line that is not about work: an objective's
// exit criteria, its coverage, its revisions and its identity.
//
// The store itself (`fixtures/pre-cutover-store`) is untouched — a log an old
// binary wrote is the whole of what this test has. What moved is seven
// captures under `pre-cutover-reads`, and two work captures that name units
// no fold answers for any more, which are gone.
//
// The group G cells of docs/maintainers/case-tables/305-legacy-work-fold.md
// live in this file, below E1, because the store they question is here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { approvedIn, demoWorkspace, git, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));

/* ── E1: pre-cutover store byte-identity ───────────────────────────── */

const e1 = machine();
const ws = join(e1.root, "ws");
const store = join(ws, ".superself");
mkdirSync(ws, { recursive: true });
cpSync(join(fixtures, "pre-cutover-store"), store, { recursive: true });
must(e1, ws, ["workspace", ws]);

// The listings among the captures gained exactly one line with the render
// gate's stage 3 (#294) and stage 4 (#296): the size a piped listing states,
// which is each stage's one deliberate output change. `state list` is stage
// 4's — the listing stage 3's surface table left out. The captured bytes are
// still the assertion for everything above it — they have to be there, in that
// order — and the added line is asserted as the only thing that follows them.
//
// Every other capture here is a document, and stage 4 moved all of them behind
// the gate: `context`, `status`, and the `show` pages are asserted byte for
// byte against a binary that predates the move.
//
// `work-list` left this set with #305: the pre-cutover store now folds to no
// open work at all, and an empty listing states no size.
const SIZED_READS = new Set(["objective-list", "milestone-list", "state-list", "log"]);
const SIZE_LINE = /^\d+ (open objectives?|milestones?|live entit(y|ies)|events?)\n$/;

// G3 is the nine captures that read no work — `state list`, the seven
// `state show` pages, and `self log` — which still hold the pre-cutover
// binary's own bytes. The other seven captures were rebaselined for #305, and
// the diff that rebaselined them is on the pull request.
test("E1 / #305 G3: every captured read surface answers exactly as its capture states", () =>
{
    const manifest = JSON.parse(readFileSync(join(fixtures, "pre-cutover-reads", "manifest.json"), "utf8"));
    assert.equal(manifest.length, 16, "the fixture manifest changed size unexpectedly");
    for (const [name, args] of manifest)
    {
        const expected = readFileSync(join(fixtures, "pre-cutover-reads", `${name}.txt`), "utf8");
        const result = must(e1, ws, args);
        const drifted = `\`self ${args.join(" ")}\` drifted from its capture (${name})`;
        if (!SIZED_READS.has(name))
        {
            assert.equal(result.out, expected, drifted);
            continue;
        }
        assert.equal(result.out.slice(0, expected.length), expected, drifted);
        assert.match(result.out.slice(expected.length), SIZE_LINE, drifted);
    }
});

// #305 G4, named on its own because a log that stopped printing a dropped
// record would take the ruling's premise away: the history is where those
// records stay readable, so it is the one surface that may not move.
test("#305 G4: `self log` prints the dropped units' events exactly as it did before", () =>
{
    const expected = readFileSync(join(fixtures, "pre-cutover-reads", "log.txt"), "utf8");
    const printed = must(e1, ws, ["log", "-n", "500", "--project", "demo"]).out;
    assert.equal(printed.slice(0, expected.length), expected, "the log capture drifted");
    assert.match(expected, /work\.created/, "the log capture holds no dropped record, so this cell proves nothing");
    assert.match(expected, /work\.proposed/, "the log capture holds no dropped proposal, so this cell proves nothing");
});

// #305 G5's judgment: what the cutover was allowed to move is the work-linkage
// line of a surface, never what the record itself states. A capture whose
// criteria or coverage moved is a defect, not a rebaseline.
test("#305 G5: what a rebaselined capture says about criteria and coverage did not move", () =>
{
    const objective = must(e1, ws, ["objective", "show", "o-yfxat", "--project", "demo"]).out;
    assert.ok(objective.includes("- Revision: 1"), objective);
    assert.ok(objective.includes("- Progress: 1 of 3 exit criteria covered"), objective);
    assert.ok(objective.includes("- c1 — tests pass _(covered)_"), objective);
    assert.ok(objective.includes("- c2 — docs updated _(open)_"), objective);
    assert.ok(objective.includes("- c1 on 2026-08-03 — suite ran green _(revision 1/1)_"), objective);
    assert.ok(objective.includes("- c1 — docs live _(open)_"), objective);
    const status = must(e1, ws, ["status", "--project", "demo"]).out;
    assert.ok(status.includes("objectives: 3 open, 0 of 2 milestones reached, 1 of 3 exit criteria covered"), status);
});

// #305 G8. A verb handed a unit the fold no longer answers for says so in the
// words every other verb uses for an id it does not hold.
test("#305 G8: a verb handed a pre-cutover work id refuses it as unknown", () =>
{
    for (const args of [["handoff", "w-2hcs1"], ["work", "show", "w-2hcs1"]])
    {
        const refused = selfIn(e1, ws, [...args, "--project", "demo"]);
        assert.equal(refused.code, 1, `\`self ${args.join(" ")}\` did not refuse`);
        assert.match(refused.out, /unknown work id "w-2hcs1"/, refused.out);
    }
});

// `self search` left the byte-identity set above with #212, which changed on
// purpose what it answers — live records rather than log lines — so a capture
// of its pre-cutover output is a claim the product no longer makes. This reads
// the same pristine store under the new contract instead. It runs before the
// refold below, so what it reads is the capture rather than a re-derivation.
test("E1: a pre-cutover store answers search over its live records, not its log", () =>
{
    const decisions = must(e1, ws, ["search", "ship", "--type", "decision", "--all"]).out;
    assert.match(decisions, /ship daily/);
    assert.doesNotMatch(decisions, /ship weekly/, "a superseded decision answered a live-record search");
    const printed = decisions.split("\n").filter((row) => row.trim() !== "");
    // The last line is the size the gate states under a listing (#294); the
    // rest are the hits, and every one of them has to read as a row.
    assert.match(printed.at(-1), /^\d+ match(es)?$/, `the answer did not state its size: ${printed.at(-1)}`);
    for (const line of printed.slice(0, -1))
    {
        assert.doesNotMatch(line, /"type":|"payload":|"origin":/, `a raw event object reached the answer: ${line}`);
        assert.match(line, /^demo {2}decision {2}\S+ {2}/, `a hit did not read as a row: ${line}`);
    }
    const entities = must(e1, ws, ["search", "raw", "--type", "entity", "--all"]).out;
    assert.match(entities, /raw standing note/);
    assert.match(entities, /\(proposed\)/, "a proposed raw entity lost its marker");
});

/* ── #305 G: the cutover over the pre-cutover store ────────────────── */

const demoDir = join(store, "projects", "demo");
const logFile = join(demoDir, "log.jsonl");
const workFree = ["objective/o-93cg3.md", "objective/o-tvmtf.md"];
const before = new Map();

// One refold of the pre-cutover store, and everything the cells below read
// about it. `lang en` is the workspace-wide refold every view setting takes
// (the language is already en); the store travels without its git history and
// the refold path commits, so the copy gets a fresh repository first.
function refold()
{
    if (before.size === 0)
    {
        for (const rel of ["state.md", ...readdirSync(join(demoDir, "objective")).map((name) => join("objective", name)),
            ...readdirSync(join(demoDir, "work")).map((name) => join("work", name)), ".hashes.json", "log.jsonl"])
        {
            before.set(rel.split("\\").join("/"), readFileSync(join(demoDir, rel), "utf8"));
        }
        git(e1, store, ["init", "-q", "-b", "main"]);
    }
    must(e1, ws, ["lang", "en"]);
}

test("#305 G1: the fold rewrites no line of the log it read", () =>
{
    refold();
    assert.equal(readFileSync(logFile, "utf8"), before.get("log.jsonl"),
        "the cutover fold rewrote the log it was supposed to only read");
});

test("#305 G2: the page of a unit the fold no longer answers for is removed", () =>
{
    refold();
    assert.deepEqual(readdirSync(join(demoDir, "work")).filter((name) => name.endsWith(".md")), [],
        "a page for a dropped unit survived the fold, still claiming the unit is open");
    for (const rel of ["work/w-2hcs1.md", "work/w-sc46n.md", "work/w-0q8c9.md"])
    {
        assert.ok(before.has(rel), `the fixture no longer carries ${rel}, so this cell proves nothing`);
    }
});

test("#305 G7: the hash entry of a removed page goes with it", () =>
{
    refold();
    const hashes = JSON.parse(readFileSync(join(demoDir, ".hashes.json"), "utf8"));
    assert.deepEqual(Object.keys(hashes).filter((key) => key.startsWith("work/")), [],
        "an orphan hash entry survived, so the next fold warns about a file that is gone");
    assert.ok(Object.keys(hashes).includes("state.md"), "the sweep took an entry it had no business taking");
});

// G5's judgment applied to the canonical files rather than to the captures:
// the fold was allowed to move the work lines of a page, and nothing else.
test("#305 G5 (canonical files): the cutover fold moved only what names work", () =>
{
    refold();
    for (const rel of workFree)
    {
        assert.equal(readFileSync(join(demoDir, rel), "utf8"), before.get(rel),
            `${rel} names no work and was still rewritten`);
    }
    // The one objective page that does name work keeps everything it states
    // about itself; only the work lines moved.
    const yfxat = readFileSync(join(demoDir, "objective", "o-yfxat.md"), "utf8");
    assert.doesNotMatch(yfxat, /\bw-[0-9a-z]{5}\b/, "a dropped unit is still cited on an objective page");
    for (const kept of ["# o-yfxat — reach preview", "- Revision: 1", "- Progress: 1 of 3 exit criteria covered",
        "- c1 — tests pass _(covered)_", "- c2 — docs updated _(open)_",
        "- c1 on 2026-08-03 — suite ran green _(revision 1/1)_", "- c1 — docs live _(open)_"])
    {
        assert.ok(yfxat.includes(kept), `the cutover moved a line that says nothing about work: ${kept}\n${yfxat}`);
    }
});

test("#305 G6: a second fold changes nothing — the sweep has nothing left to take", () =>
{
    refold();
    const after = new Map(["state.md", "objective/o-yfxat.md", ...workFree, ".hashes.json"]
        .map((rel) => [rel, readFileSync(join(demoDir, rel), "utf8")]));
    must(e1, ws, ["lang", "en"]);
    for (const [rel, text] of after)
    {
        assert.equal(readFileSync(join(demoDir, rel), "utf8"), text, `${rel} was rewritten differently by a second fold`);
    }
    assert.equal(readFileSync(logFile, "utf8"), before.get("log.jsonl"), "a second fold rewrote the log");
});

/* ── E2/E3: a mixed log folds coherently and deterministically ─────── */

const mixedBox = machine();
const { demo: mixedDemo } = demoWorkspace(mixedBox);
const mixedLog = join(mixedBox.root, "ws", ".superself", "projects", "demo", "log.jsonl");

test("E2: lifecycle verbs target legacy-derived records and record entity events referencing them", async () =>
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
    const dropped = await approvedIn(mixedBox, mixedDemo, ["convention", "drop", "01hz00000000000000000000e2", "--why", "replaced by the gate"], "01hz00000000000000000000e2");
    assert.match(dropped.out, /entity\.retracted recorded/);
    assert.ok(!must(mixedBox, mixedDemo, ["context"]).out.includes("legacy standing rule"),
        "a legacy convention dropped through an entity event still renders");
    // Search answers over live records (#212), so the dropped rule left that
    // answer; its settled status is read where the record is named.
    assert.equal(must(mixedBox, mixedDemo, ["search", "legacy standing rule"]).out.trim(), "no matches");
    assert.match(must(mixedBox, mixedDemo, ["state", "show", "01hz00000000000000000000e2", "--history"]).out, /dropped/);
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

test("E6: one representative verb per family prints the entity event it records", async () =>
{
    const box = machine();
    const { demo } = demoWorkspace(box);
    assert.match(must(box, demo, ["goal", "add", "own the niche"]).out, /entity\.confirmed recorded/);
    const proposed = idIn(must(box, demo, ["decide", "maybe so", "--proposed"]).out);
    assert.match(must(box, demo, ["decide", "decline", proposed, "--why", "not now"]).out, /entity\.retracted recorded/);
    const objective = must(box, demo, ["objective", "add", "reach preview"]).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const milestone = must(box, demo, ["milestone", "add", "suite green", "--objective", objective, "--exit", "tests pass"]).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    assert.match(must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "ran green"]).out, /entity\.covered recorded/);
    assert.match(must(box, demo, ["milestone", "reach", milestone]).out, /entity\.done recorded/);
    const work = workIdIn(must(box, demo, ["work", "add", "ship it"]).out);
    assert.match(must(box, demo, ["work", "start", work]).out, /entity\.started recorded/);
    assert.match((await approvedIn(box, demo, ["work", "retire", work, "--why", "moved on"], work)).printed, /entity\.retired recorded/);
    const raw = must(box, demo, ["state", "add", "standing note"]).out.match(/\be-[0-9a-z]{5}\b/)[0];
    assert.match(must(box, demo, ["state", "place", raw, "--priority", "3"]).out, /entity\.placed recorded/);
});
