// The documentation is product surface (#209): these proofs assert what the
// user-facing documents claim against what the built CLI actually does. Four
// checks: concrete doc examples run and answer as the text claims, the cli.md
// verb catalogue diffs clean against the typed contract, event names the docs
// mention belong to the vocabulary the CLI writes, and the checked-in managed
// blocks equal the connect.ts template applied to this repository's state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../dist/main.js";
import { approvedIn, demoWorkspace, git, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));

// Tier 1 of #209: the normative user-facing set this suite answers for.
const TIER1 = [
    "README.md",
    "apps/cli/README.md",
    "ARCHITECTURE.md",
    "CONTRIBUTING.md",
    "docs/concepts/company-state-and-context.md",
    "docs/guides/getting-started.md",
    "docs/guides/running-a-long-term-project.md",
    "docs/reference/cli.md",
    "docs/roadmap.md",
    "docs/examples/governed-conversion-improvement.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/maintenance.yml"
];

function tier1(name)
{
    return readFileSync(join(repo, name), "utf8");
}

/* ── proof 1: concrete examples run and answer as documented ───────── */

// The extraction rule documented in docs/reference/cli.md: bash/sh fences,
// backslash continuations joined, `self` lines run in order per document.
function exampleLines(markdown)
{
    const lines = [];
    for (const fence of markdown.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g))
    {
        const raw = fence[1].split("\n");
        for (let index = 0; index < raw.length; index += 1)
        {
            let line = raw[index];
            while (line.trimEnd().endsWith("\\") && index + 1 < raw.length)
            {
                index += 1;
                line = line.trimEnd().slice(0, -1) + " " + raw[index].trim();
            }
            lines.push(line.trim());
        }
    }
    return lines.filter((line) => line !== "" && !line.startsWith("#"));
}

// A placeholder-bearing line and the verbs that need a real remote stay
// documentation; everything else must answer for itself.
function excluded(command, words)
{
    return command.includes("<") || command.includes("xxxxx")
        || ["remote", "sync", "clone"].includes(words[1]);
}

// The docs quote plain double- or single-quoted words, nothing fancier, so a
// three-branch tokenizer covers every example line.
function shellWords(text)
{
    const words = [];
    for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    {
        words.push(match[1] ?? match[2] ?? match[3]);
    }
    return words;
}

// Every directory an example enters exists as a git repository before the
// run, so `cd` steers and `self project init` finds a repository to register.
function enteredDir(box, dir)
{
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, ".git")))
    {
        git(box, dir, ["init", "-q", "-b", "main"]);
    }
    return dir;
}

function resolveExamplePath(box, cwd, path)
{
    if (path === "~")
    {
        return box.env.HOME;
    }
    if (path.startsWith("~/"))
    {
        return join(box.env.HOME, path.slice(2));
    }
    return join(cwd, path);
}

// The shell the reader types into expands `~` before the CLI sees it; the
// runner owes the arguments the same expansion.
function expandTilde(box, word)
{
    return word === "~" || word.startsWith("~/")
        ? resolveExamplePath(box, box.env.HOME, word)
        : word;
}

// The floor every document stands on: a scratch machine whose workspace is
// already initialized and whose starting directory is a repository named
// my-project — the identity the guides' `--project my-project` reads back.
function floorState(box)
{
    const floor = join(box.env.HOME, "floor-workspace");
    mkdirSync(floor, { recursive: true });
    must(box, floor, ["init"]);
    return { cwd: enteredDir(box, join(box.env.HOME, "my-project")) };
}

function runSegment(box, state, doc, segment)
{
    const command = segment.split(" # ")[0].trim();
    const words = shellWords(command);
    if (words[0] === "cd" && words.length === 2)
    {
        state.cwd = enteredDir(box, resolveExamplePath(box, state.cwd, words[1]));
        return;
    }
    if (words[0] !== "self" || excluded(command, words))
    {
        return;
    }
    const expectRefusal = segment.includes(" # refused");
    const result = selfIn(box, state.cwd, words.slice(1).map((word) => expandTilde(box, word)));
    if (expectRefusal)
    {
        assert.notEqual(result.code, 0, `${doc}: \`${command}\` should have been refused, and was not`);
        return;
    }
    assert.equal(result.code, 0, `${doc}: \`${command}\` failed:\n${result.out}`);
}

test("every concrete documented command answers as its document claims", () =>
{
    for (const doc of TIER1.filter((name) => name.endsWith(".md")))
    {
        const lines = exampleLines(tier1(doc));
        if (!lines.some((line) => line.startsWith("self ") || line.includes("&& self ")))
        {
            continue;
        }
        const box = machine();
        const state = floorState(box);
        for (const line of lines)
        {
            for (const segment of line.split("&&").map((part) => part.trim()))
            {
                runSegment(box, state, doc, segment);
            }
        }
    }
});

/* ── proof 2: the cli.md catalogue is the typed contract ───────────── */

test("the cli.md verb catalogue diffs clean against the typed contract", () =>
{
    const page = tier1("docs/reference/cli.md");
    const block = page.match(/top-level verbs:\n\n```text\n([\s\S]*?)```/);
    assert.ok(block !== null, "cli.md lost its top-level verb catalogue block");
    const documented = block[1].split(/\s+/).filter((word) => word !== "");
    const declared = COMMANDS.map((command) => command.name);
    assert.deepEqual([...documented].sort(), [...declared].sort(),
        "the cli.md catalogue and the typed command contract disagree");
});

/* ── proof 3: mentioned event names belong to the written vocabulary ── */

function entityIdIn(text)
{
    const match = text.match(/\b[eomw]-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no entity id in: ${text}`);
    return match[0];
}

// Drives every current write verb once and reads the vocabulary back from
// the store's own log — the oracle is what the CLI wrote, not a list here.
async function writeCurrentVocabulary(box, demo)
{
    must(box, demo, ["goal", "add", "the goal"]);
    must(box, demo, ["decide", "a first take", "--proposed"]);
    const decided = idIn(must(box, demo, ["decide", "a second take"]).out);
    await approvedIn(box, demo, ["decide", "a third take", "--supersedes", decided], decided);
    const note = entityIdIn(must(box, demo, ["state", "add", "a note", "--label", "note"]).out);
    must(box, demo, ["state", "place", note, "--priority", "7"]);
    await approvedIn(box, demo, ["state", "retract", note, "--why", "probe over"], note);
    const objective = entityIdIn(must(box, demo, ["objective", "add", "an outcome"]).out);
    const milestone = entityIdIn(must(box, demo, ["milestone", "add", "a checkpoint", "--objective", objective, "--exit", "the proof passes"]).out);
    const plan = workIdIn(must(box, demo, ["work", "propose", "review the flow before it is worked"]).out);
    must(box, demo, ["work", "revise", plan, "review the flow, then work it", "--why", "the first plan skipped the review"]);
    must(box, demo, ["work", "accept", plan]);
    const unit = workIdIn(must(box, demo, ["work", "add", "the flow works"]).out);
    must(box, demo, ["work", "link", unit, "--milestone", milestone]);
    must(box, demo, ["work", "unlink", unit, "--milestone", milestone]);
    must(box, demo, ["work", "start", unit]);
    must(box, demo, ["work", "block", unit, "--on", "dependency", "--why", "waiting"]);
    must(box, demo, ["work", "unblock", unit]);
    must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "the proof passed"]);
    must(box, demo, ["report", unit, "progress so far"]);
    must(box, demo, ["work", "done", unit, "--report", "the flow verifiably works"]);
    const retiredUnit = workIdIn(must(box, demo, ["work", "add", "a superseded outcome"]).out);
    await approvedIn(box, demo, ["work", "retire", retiredUnit, "--why", "moved elsewhere"], retiredUnit);
    const undoneUnit = workIdIn(must(box, demo, ["work", "add", "an outcome given up in error"]).out);
    const undone = await approvedIn(box, demo, ["work", "retire", undoneUnit, "--why", "given up"], undoneUnit);
    must(box, demo, ["undo", idIn(undone.printed), "--why", "the outcome is still wanted"]);
    const runUnit = workIdIn(must(box, demo, ["work", "add", "a supervised outcome"]).out);
    must(box, demo, ["work", "started", runUnit, "--pid", String(process.pid)]);
    must(box, demo, ["work", "exited", runUnit, "--code", "0"]);
}

async function writtenVocabulary(box, ws, demo)
{
    await writeCurrentVocabulary(box, demo);
    const log = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8");
    return new Set(log.trim().split("\n").map((line) => JSON.parse(line).type));
}

// Every dotted name under a namespace the CLI has ever owned; wildcards like
// `entity.*` and file names like `main.ts` are not event mentions.
const NAMESPACES = "entity|work|report|goal|decision|convention|objective|milestone"
    + "|run|spec|changeset|attempt|lease|merge|promotion|repo|target|main|ci|review";
const EVENT_MENTION = new RegExp(`\\b(?:${NAMESPACES})\\.[a-z][a-z-]*\\b`, "g");
const FILE_SUFFIXES = ["ts", "js", "mjs", "md", "json", "jsonl", "yml", "html", "sh"];

function eventMentions(markdown)
{
    const mentions = [];
    for (const section of markdown.split(/^(?=#{1,6} )/m))
    {
        const legacy = /legacy|retired|pre-cutover/i.test(section);
        for (const match of section.match(EVENT_MENTION) ?? [])
        {
            if (!FILE_SUFFIXES.includes(match.split(".")[1]))
            {
                mentions.push({ name: match, legacy });
            }
        }
    }
    return mentions;
}

test("event names the documents mention are the vocabulary the CLI writes", async () =>
{
    const box = machine();
    const { ws, demo } = demoWorkspace(box);
    const written = await writtenVocabulary(box, ws, demo);
    for (const doc of TIER1)
    {
        for (const mention of eventMentions(tier1(doc)))
        {
            assert.ok(written.has(mention.name) || mention.legacy,
                `${doc} mentions ${mention.name}, which the CLI does not write, outside a legacy-marked section`);
        }
    }
});

/* ── proof 4: the block connect writes has one shape, in both files ── */

// This repository stops tracking AGENTS.md and CLAUDE.md, because the block
// carries the project's conventions and this repository is public. The subject
// is therefore what `connect` writes into a scratch project, not what is
// checked in here.

// The marker carries the version that rendered it (#221), so a block is found
// by its prefix — a pinned literal would only match one release.
const BLOCK_BEGIN = "<!-- superself:begin";
const BLOCK_END = "<!-- superself:end -->";

function managedBlock(name, content)
{
    const from = content.indexOf(BLOCK_BEGIN);
    const to = content.indexOf(BLOCK_END);
    assert.ok(from !== -1 && to !== -1, `${name} carries no managed superself block`);
    return content.slice(from, to + BLOCK_END.length);
}

test("connect writes one managed block, of a fixed shape, to both instruction files", () =>
{
    const box = machine();
    const { demo } = demoWorkspace(box);
    const blocks = ["AGENTS.md", "CLAUDE.md"]
        .map((name) => ({ name, block: managedBlock(name, readFileSync(join(demo, name), "utf8")) }));
    assert.equal(blocks[0].block, blocks[1].block,
        "AGENTS.md and CLAUDE.md carry different managed blocks — the fold writes one block to both");
    const sections = [...blocks[0].block.matchAll(/^#{2,3} .+$/gm)].map((m) => m[0]);
    assert.deepEqual(sections, ["## Project state (superself)"],
        "the managed block of a project with no conventions holds a section beyond project state");
});
