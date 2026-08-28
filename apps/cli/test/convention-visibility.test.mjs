// #276: the managed block lands in AGENTS.md and CLAUDE.md, which a project
// normally tracks, so every convention it carried became repository content on
// the next commit that touched the tree. A convention reaches the block only
// when it was recorded `--public`; everything else stays in the store, where
// `self context` still renders it. One test per cell of the design's case
// table, in its order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, git, idIn, logFixture, machine, must, selfIn } from "./harness.mjs";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

function instructions(demo)
{
    return INSTRUCTION_FILES.map((name) => readFileSync(join(demo, name), "utf8"));
}

// The section heading the block renders conventions under, and nothing else in
// the block writes it — so its absence is the whole claim for an empty case.
function hasSection(demo)
{
    return instructions(demo).map((content) => content.includes("### Conventions"));
}

function carries(demo, text)
{
    return instructions(demo).map((content) => content.includes(text));
}

async function project()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    return { box, ws, demo };
}

/* ── cell 1: no convention at all ─────────────────────────────────── */

test("a project with no convention gets a block with no conventions section", async () =>
{
    const { box, demo } = await project();
    await must(box, demo, ["connect"]);
    assert.deepEqual(hasSection(demo), [false, false], "the block grew a conventions section out of nothing");
});

/* ── cell 2: an internal convention leaves no byte in a tracked file ─ */

test("a convention recorded without --public reaches neither instruction file", async () =>
{
    const { box, demo } = await project();
    const rule = "internal rule: the local scheduler runs at 04:00";
    await must(box, demo, ["convention", "add", rule]);
    await must(box, demo, ["connect"]);
    assert.deepEqual(hasSection(demo), [false, false], "an internal rule opened a conventions section");
    assert.deepEqual(carries(demo, rule), [false, false], "an internal rule's text reached a tracked file");
    // The record is not gone, only unpublished: the store still answers for it.
    assert.match((await must(box, demo, ["context"])).out, /internal rule: the local scheduler/,
        "the rule vanished from context too — visibility is about tracked files, not about the record");
});

/* ── cell 3: one public convention ────────────────────────────────── */

test("a convention recorded --public renders into the block", async () =>
{
    const { box, demo } = await project();
    const rule = "contributors run `pnpm test` before opening a pull request";
    await must(box, demo, ["convention", "add", rule, "--public"]);
    await must(box, demo, ["connect"]);
    assert.deepEqual(hasSection(demo), [true, true], "a --public rule opened no conventions section");
    assert.deepEqual(carries(demo, `- ${rule}`), [true, true], "a --public rule's text is missing from the block");
});

/* ── cell 4: public and internal together ─────────────────────────── */

test("with both kinds recorded, only the public one is in the block", async () =>
{
    const { box, demo } = await project();
    await must(box, demo, ["convention", "add", "internal one: pricing experiments stay unannounced"]);
    await must(box, demo, ["convention", "add", "public one: every commit is signed off", "--public"]);
    await must(box, demo, ["convention", "add", "internal two: the distribution calendar lives in the ops sheet"]);
    await must(box, demo, ["connect"]);
    assert.deepEqual(carries(demo, "public one: every commit is signed off"), [true, true],
        "the public rule is missing from the block");
    assert.deepEqual(carries(demo, "internal one"), [false, false], "an internal rule reached a tracked file");
    assert.deepEqual(carries(demo, "internal two"), [false, false], "an internal rule reached a tracked file");
    const listed = readFileSync(join(demo, "AGENTS.md"), "utf8").match(/^- (?:public|internal) \w+:/gm) ?? [];
    assert.equal(listed.length, 1, `the block lists more than the one public rule: ${listed.join(", ")}`);
});

/* ── cell 5: a block that already carried the rule ────────────────── */

test("an already-published rule is dropped from the block in place, and text outside the markers survives", async () =>
{
    const { box, demo } = await project();
    const rule = "internal rule already published by an earlier release";
    await must(box, demo, ["convention", "add", rule]);
    const file = join(demo, "AGENTS.md");
    // The block a pre-#276 release would have left: the rule inside the
    // markers, project text after them.
    const current = readFileSync(file, "utf8");
    const end = current.indexOf("<!-- superself:end -->");
    writeFileSync(file, `${current.slice(0, end)}\n### Conventions\n\n- ${rule}\n${current.slice(end)}\ntrailing project text\n`);
    await must(box, demo, ["connect"]);
    const rewritten = readFileSync(file, "utf8");
    assert.ok(!rewritten.includes(rule), "the published rule survived the rewrite");
    assert.ok(!rewritten.includes("### Conventions"), "the emptied conventions section was left behind");
    assert.ok(rewritten.includes("trailing project text"), "the rewrite ate text the block does not own");
    assert.equal(rewritten.match(/<!-- superself:begin/g).length, 1, "the old block was left beside the new one");
});

/* ── cell 6: the fold path writes the same block ──────────────────── */

test("recording anything at all refreshes the block to the same result", async () =>
{
    const { box, demo } = await project();
    const rule = "internal rule the fold has to take back out";
    await must(box, demo, ["convention", "add", rule]);
    const file = join(demo, "CLAUDE.md");
    const current = readFileSync(file, "utf8");
    const end = current.indexOf("<!-- superself:end -->");
    writeFileSync(file, `${current.slice(0, end)}\n### Conventions\n\n- ${rule}\n${current.slice(end)}`);
    // No `connect` here: any record at all folds, and the fold rewrites the
    // block. That is what made the leak automatic, and it is what undoes it.
    await must(box, demo, ["decide", "unrelated decision", "--why", "to make the fold run"]);
    assert.ok(!readFileSync(file, "utf8").includes(rule), "the fold left the published rule standing");
});

/* ── cell 7: the legacy event shape ───────────────────────────────── */

test("a legacy convention.added event reads as internal", async () =>
{
    const { box, ws, demo } = await project();
    const rule = "a rule written before the entity grammar existed";
    logFixture(ws, "demo", {
        id: "01hz00000000000000000276a",
        ts: new Date().toISOString(),
        type: "convention.added",
        origin: { actor: "agent", confirmed: true },
        project: "demo",
        // A payload from before the key existed: no `visibility` to read.
        payload: { text: rule }
    });
    await must(box, demo, ["connect"]);
    assert.deepEqual(carries(demo, rule), [false, false], "a legacy convention reached a tracked file");
    assert.match((await must(box, demo, ["context"])).out, /a rule written before the entity grammar existed/,
        "the legacy convention stopped rendering in context");
});

/* ── cell 8: public restated as internal ──────────────────────────── */

// A supersession retires the rule it replaces. These cells drive a person's
// terminal because that is the caller they are about; since #400 a session
// reaches the same write, and the record says which of the two wrote it.
test("restating a public rule without --public takes it out of the block", async () =>
{
    const { box, demo } = await project();
    const first = idIn((await must(box, demo, ["convention", "add", "public wording", "--public"])).out);
    await must(box, demo, ["connect"]);
    assert.deepEqual(carries(demo, "public wording"), [true, true], "the public rule never reached the block");
    const restated = await approvedIn(box, demo, ["convention", "add", "quieter wording", "--supersedes", first], first);
    assert.equal(restated.code, 0, `the restatement was refused:\n${restated.out}`);
    await must(box, demo, ["connect"]);
    assert.deepEqual(carries(demo, "public wording"), [false, false], "the superseded rule stayed in the block");
    assert.deepEqual(carries(demo, "quieter wording"), [false, false], "the internal replacement reached the block");
    assert.deepEqual(hasSection(demo), [false, false], "an empty conventions section was left behind");
});

/* ── cell 9: internal restated as public ──────────────────────────── */

test("restating an internal rule with --public puts the new wording in the block, not the old", async () =>
{
    const { box, demo } = await project();
    const first = idIn((await must(box, demo, ["convention", "add", "quiet original wording"])).out);
    const restated = await approvedIn(box, demo,
        ["convention", "add", "published replacement wording", "--public", "--supersedes", first], first);
    assert.equal(restated.code, 0, `the restatement was refused:\n${restated.out}`);
    await must(box, demo, ["connect"]);
    assert.deepEqual(carries(demo, "published replacement wording"), [true, true],
        "the public replacement is missing from the block");
    assert.deepEqual(carries(demo, "quiet original wording"), [false, false], "the superseded original reached the block");
});

/* ── cell 10: --public with --workspace ───────────────────────────── */

test("--public and --workspace hold together, and the other project's block does not move", async () =>
{
    const { box, ws, demo } = await project();
    const other = join(ws, "other");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    await must(box, other, ["project", "init", "--name", "other"]);
    const before = readFileSync(join(other, "AGENTS.md"), "utf8");
    const rule = "every project in this workspace signs its commits";
    assert.equal((await selfIn(box, demo, ["convention", "add", rule, "--public", "--workspace"])).code, 0,
        "--public and --workspace were refused together");
    await must(box, demo, ["connect"]);
    await must(box, other, ["connect"]);
    assert.deepEqual(carries(demo, rule), [true, true], "the rule is missing from its own project's block");
    // A block is built from one project's own log, so a workspace-scoped rule
    // renders in the other project's *context* and not in its tracked files.
    assert.equal(readFileSync(join(other, "AGENTS.md"), "utf8"), before,
        "a workspace-scoped rule rewrote another project's tracked instruction file");
});

/* ── cell 11: drop refuses --public by name ───────────────────────── */

test("convention drop refuses --public by name rather than dropping the flag", async () =>
{
    const { box, demo } = await project();
    const id = idIn((await must(box, demo, ["convention", "add", "a rule to keep", "--public"])).out);
    const refused = await selfIn(box, demo, ["convention", "drop", id, "--why", "no longer holds", "--public"]);
    assert.equal(refused.code, 1, "convention drop accepted --public");
    assert.match(refused.out, /convention drop takes no --public/, `the refusal does not name the flag:\n${refused.out}`);
    await must(box, demo, ["connect"]);
    assert.deepEqual(carries(demo, "a rule to keep"), [true, true], "the refused drop dropped the rule anyway");
});

/* ── cell 12: dropping a public rule empties the section ──────────── */

test("a dropped public rule leaves the block", async () =>
{
    const { box, demo } = await project();
    const id = idIn((await must(box, demo, ["convention", "add", "a rule that stops holding", "--public"])).out);
    await must(box, demo, ["connect"]);
    assert.deepEqual(carries(demo, "a rule that stops holding"), [true, true], "the public rule never reached the block");
    const dropped = await approvedIn(box, demo, ["convention", "drop", id, "--why", "the practice changed"], id);
    assert.equal(dropped.code, 0, `the drop was refused:\n${dropped.out}`);
    assert.deepEqual(carries(demo, "a rule that stops holding"), [false, false], "the dropped rule stayed in the block");
    assert.deepEqual(hasSection(demo), [false, false], "an empty conventions section was left behind");
});

/* ── cell 13: project init writes a clean file ────────────────────── */

test("project init writes instruction files with no conventions section", async () =>
{
    const box = machine();
    const { ws } = await demoWorkspace(box);
    const fresh = join(ws, "fresh");
    mkdirSync(fresh, { recursive: true });
    git(box, fresh, ["init", "-q", "-b", "main"]);
    await must(box, fresh, ["project", "init", "--name", "fresh"]);
    for (const name of INSTRUCTION_FILES)
    {
        assert.ok(existsSync(join(fresh, name)), `project init wrote no ${name}`);
    }
    assert.deepEqual(hasSection(fresh), [false, false], "a project with no log grew a conventions section");
});

/* ── cell 14: no instruction file, nothing created ────────────────── */

test("a fold does not create an instruction file that is not there", async () =>
{
    const { box, demo } = await project();
    await must(box, demo, ["convention", "add", "a published rule", "--public"]);
    INSTRUCTION_FILES.forEach((name) => rmSync(join(demo, name)));
    await must(box, demo, ["decide", "unrelated decision", "--why", "to make the fold run"]);
    for (const name of INSTRUCTION_FILES)
    {
        assert.ok(!existsSync(join(demo, name)), `the fold created ${name}, which the project had removed`);
    }
});

/* ── cell 15: the leak path itself ────────────────────────────────── */

test("a commit in the project repository carries no internal convention", async () =>
{
    const { box, demo } = await project();
    const rules = ["internal a: the content calendar", "internal b: the launchd jobs", "internal c: the pricing floor"];
    for (const rule of rules)
    {
        await must(box, demo, ["convention", "add", rule]);
    }
    writeFileSync(join(demo, "src.txt"), "an unrelated change\n");
    git(box, demo, ["add", "-A"]);
    const staged = execFileSync("git", ["diff", "--cached"], { cwd: demo, env: box.env, encoding: "utf8" });
    for (const rule of rules)
    {
        assert.ok(!staged.includes(rule), `an unrelated commit carries "${rule}"`);
    }
});

/* ── cell 16: the payload of an ordinary add ──────────────────────── */

test("an add without --public writes no visibility key at all", async () =>
{
    const { box, ws, demo } = await project();
    await must(box, demo, ["convention", "add", "an ordinary rule"]);
    const log = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trimEnd().split("\n");
    const payload = JSON.parse(log[log.length - 1]).payload;
    assert.equal(payload.text, "an ordinary rule", "the last event is not the convention that was just recorded");
    assert.ok(!("visibility" in payload), "an ordinary add wrote a visibility key");
    await must(box, demo, ["convention", "add", "a published rule", "--public"]);
    const after = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trimEnd().split("\n");
    assert.equal(JSON.parse(after[after.length - 1]).payload.visibility, "public",
        "a --public add wrote no visibility key");
});

/* ── O3: the file exists but carries no markers ───────────────────── */

// The design declared "target file state" with three values and left this one
// with no cell. The block is appended rather than replaced on this path
// (connect.ts), and the appended block has to obey the filter too.

test("a block appended to a file that had none carries only the public rule", async () =>
{
    const { box, demo } = await project();
    await must(box, demo, ["convention", "add", "internal rule for the append path"]);
    await must(box, demo, ["convention", "add", "public rule for the append path", "--public"]);
    writeFileSync(join(demo, "AGENTS.md"), "# House notes\n\nWritten by hand, no markers.\n");
    await must(box, demo, ["connect"]);
    const rewritten = readFileSync(join(demo, "AGENTS.md"), "utf8");
    assert.ok(rewritten.includes("Written by hand, no markers."), "the append ate the text that was already there");
    assert.ok(rewritten.includes("- public rule for the append path"), "the appended block carries no public rule");
    assert.ok(!rewritten.includes("internal rule for the append path"), "the appended block carries an internal rule");
});
