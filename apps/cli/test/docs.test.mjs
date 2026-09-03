// The documentation is product surface (#209): these proofs assert what the
// user-facing documents claim against what the built CLI actually does. Four
// checks: concrete doc examples run and answer as the text claims, the cli.md
// verb catalogue diffs clean against the typed contract, event names the docs
// mention belong to the vocabulary the CLI writes, and the checked-in managed
// blocks equal the connect.ts template applied to this repository's state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../dist/main.js";
import { commandLeaves } from "../dist/contract.js";
import { approvedIn, demoWorkspace, git, idIn, machine, must, mustPerson, personIn, selfIn, workIdIn } from "./harness.mjs";

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
async function floorState(box)
{
    const floor = join(box.env.HOME, "floor-workspace");
    mkdirSync(floor, { recursive: true });
    await must(box, floor, ["init", "--git"]);
    return { cwd: enteredDir(box, join(box.env.HOME, "my-project")) };
}

// The documents show a person at their own terminal recording work. Those
// lines are driven with a keyboard, so the events they write say `person` —
// what a document claims is judged against the run it describes, and since
// #400 that includes who the run says wrote each record.
const PERSON_LINES = [["work", "add"], ["work", "confirm"]];

function personLine(argv)
{
    return PERSON_LINES.some((line) => line.every((word, index) => argv[index] === word));
}

async function runSegment(box, state, doc, segment)
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
    const argv = words.slice(1).map((word) => expandTilde(box, word));
    const result = personLine(argv)
        ? await personIn(box, state.cwd, argv)
        : await selfIn(box, state.cwd, argv);
    if (expectRefusal)
    {
        assert.notEqual(result.code, 0, `${doc}: \`${command}\` should have been refused, and was not`);
        return;
    }
    assert.equal(result.code, 0, `${doc}: \`${command}\` failed:\n${result.out}`);
}

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
    await must(box, demo, ["goal", "add", "the goal"]);
    await must(box, demo, ["decide", "a first take", "--proposed"]);
    const decided = idIn((await must(box, demo, ["decide", "a second take"])).out);
    await approvedIn(box, demo, ["decide", "a third take", "--supersedes", decided], decided);
    const note = entityIdIn((await must(box, demo, ["state", "add", "a note", "--label", "note"])).out);
    await must(box, demo, ["state", "place", note, "--priority", "7"]);
    await approvedIn(box, demo, ["state", "retract", note, "--why", "probe over"], note);
    const objective = entityIdIn((await must(box, demo, ["objective", "add", "an outcome"])).out);
    const milestone = entityIdIn((await must(box, demo, ["milestone", "add", "a checkpoint", "--objective", objective, "--exit", "the proof passes"])).out);
    const plan = workIdIn((await must(box, demo, ["work", "propose", "review the flow before it is worked"])).out);
    await must(box, demo, ["work", "revise", plan, "review the flow, then work it", "--why", "the first plan skipped the review"]);
    await mustPerson(box, demo, ["work", "confirm", plan]);
    const unit = workIdIn((await mustPerson(box, demo, ["work", "add", "the flow works"])).out);
    await must(box, demo, ["work", "link", unit, "--milestone", milestone]);
    await must(box, demo, ["work", "unlink", unit, "--milestone", milestone]);
    await must(box, demo, ["work", "start", unit]);
    await must(box, demo, ["work", "block", unit, "--on", "dependency", "--why", "waiting"]);
    await must(box, demo, ["work", "unblock", unit]);
    // The criterion axis (#408): declared, blocked, released and covered, so
    // the three types the documents name are read back off the log rather than
    // taken on trust from a list here.
    await must(box, demo, ["work", "criteria", "add", unit, "the flow is proved end to end"]);
    await must(box, demo, ["work", "block", unit, "--criterion", "c1", "--on", "external", "--why", "the vendor is silent"]);
    await must(box, demo, ["work", "unblock", unit, "--criterion", "c1"]);
    await must(box, demo, ["work", "cover", unit, "--criterion", "c1", "--why", "the proof ran end to end"]);
    await must(box, demo, ["milestone", "met", milestone, "--criterion", "c1", "--why", "the proof passed"]);
    await must(box, demo, ["report", unit, "progress so far"]);
    await must(box, demo, ["work", "done", unit, "--report", "the flow verifiably works"]);
    const retiredUnit = workIdIn((await mustPerson(box, demo, ["work", "add", "a superseded outcome"])).out);
    await approvedIn(box, demo, ["work", "retire", retiredUnit, "--why", "moved elsewhere"], retiredUnit);
    const undoneUnit = workIdIn((await mustPerson(box, demo, ["work", "add", "an outcome given up in error"])).out);
    const undone = await approvedIn(box, demo, ["work", "retire", undoneUnit, "--why", "given up"], undoneUnit);
    await must(box, demo, ["undo", idIn(undone.printed), "--why", "the outcome is still wanted"]);
    const runUnit = workIdIn((await mustPerson(box, demo, ["work", "add", "a supervised outcome"])).out);
    await must(box, demo, ["work", "started", runUnit, "--pid", String(process.pid)]);
    await must(box, demo, ["work", "exited", runUnit, "--code", "0"]);
    const skill = entityIdIn((await must(box, demo, ["skill", "add", "deploy staging",
        "--command", "make deploy ENV=staging", "--purpose", "push the built image to staging"])).out);
    await approvedIn(box, demo, ["skill", "drop", skill, "--why", "the deploy moved to the pipeline"], skill);
    writeFileSync(join(demo, "registered-guide.md"), "a guide no report is about\n");
    const guide = (await must(box, demo, ["artifact", "add", "registered-guide.md"])).out.match(/\ba-[0-9a-z]{5}\b/)[0];
    // The other shape an artifact takes (#407): a URL, recorded with no bytes
    // and never fetched, under an event type of its own.
    await must(box, demo, ["artifact", "add", "https://example.com/briefs/one", "--kind", "brief"]);
    // Removing stored bytes is the one act that still asks for a person: it is
    // what `self undo` cannot take back, so the last verb in the vocabulary is
    // driven with a keyboard rather than through a plain call.
    await approvedIn(box, demo, ["artifact", "prune", guide, "--why", "the guide is folded into the rule"], guide);
}

async function writtenVocabulary(box, ws, demo)
{
    await writeCurrentVocabulary(box, demo);
    const log = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8");
    return new Set(log.trim().split("\n").map((line) => JSON.parse(line).type));
}

// Every dotted name under a namespace the CLI has ever owned; wildcards like
// `entity.*` and file names like `main.ts` are not event mentions.
const NAMESPACES = "entity|work|report|artifact|goal|decision|convention|objective|milestone"
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

/* ── proof 4: the block connect writes has one shape, in both files ── */

// This repository stops tracking AGENTS.md and CLAUDE.md, because the CLI
// rewrites them on every fold and an unrelated commit would carry whatever
// they picked up. The subject is therefore what `connect` writes into a
// scratch project, not what is checked in here. Since #276 a convention
// reaches the block only when it was recorded `--public`, which is what the
// recorded rule below holds the shape to.

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

test("every concrete documented command answers as its document claims", async () =>
{
    for (const doc of TIER1.filter((name) => name.endsWith(".md")))
    {
        const lines = exampleLines(tier1(doc));
        if (!lines.some((line) => line.startsWith("self ") || line.includes("&& self ")))
        {
            continue;
        }
        const box = machine();
        const state = await floorState(box);
        for (const line of lines)
        {
            for (const segment of line.split("&&").map((part) => part.trim()))
            {
                await runSegment(box, state, doc, segment);
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

test("event names the documents mention are the vocabulary the CLI writes", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
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

test("connect writes one managed block, of a fixed shape, to both instruction files", async () =>
{
    const box = machine();
    const { demo } = await demoWorkspace(box);
    await must(box, demo, ["convention", "add", "an internal rule the block must not carry"]);
    const blocks = ["AGENTS.md", "CLAUDE.md"]
        .map((name) => ({ name, block: managedBlock(name, readFileSync(join(demo, name), "utf8")) }));
    assert.equal(blocks[0].block, blocks[1].block,
        "AGENTS.md and CLAUDE.md carry different managed blocks — the fold writes one block to both");
    const sections = [...blocks[0].block.matchAll(/^#{2,3} .+$/gm)].map((m) => m[0]);
    assert.deepEqual(sections, ["## Project state (superself)"],
        "the managed block holds a section beyond project state after a convention was recorded");
});

/* ── proof 5: the catalogue names the flags the parser accepts ─────── */

// The family table in cli.md is a summary and says so — several rows abbreviate
// a verb's options, and one that spelled every flag of every verb would be the
// help page with worse formatting. What a summary may never do is name a flag
// the parser does not accept: a reader copies the line, and a flag that is not
// there is a refusal they cannot act on. That direction is asserted for the
// whole table.
//
// `init` is held to the stronger rule — the catalogue entry is the contract's
// syntax line, flag for flag. It is the first command anybody runs, and its
// flags decide which kind of store they get; a summary that drops `--git` and
// `--cloud` there does not summarize the choice, it hides it. That is exactly
// the drift #430 found and this is what keeps it from coming back.
function catalogueEntries()
{
    const table = tier1("docs/reference/cli.md").match(/\| Family \| Current entry points \|\n[\s\S]*?\n\n/);
    assert.ok(table !== null, "cli.md lost its family table of entry points");
    // A `|` inside a table cell is escaped, and is a `|` to the reader.
    return [...table[0].matchAll(/`([^`]+)`/g)].map((found) => found[1].replaceAll("\\|", "|"));
}

function longFlags(syntax)
{
    return [...syntax.matchAll(/--[a-z][a-z-]*/g)].map((found) => found[0].slice(2));
}

function declaredFlags(command)
{
    return new Set(commandLeaves(command).flatMap(({ leaf }) => Object.keys(leaf.options)));
}

test("H1: every flag the cli.md catalogue names is one the parser accepts", () =>
{
    for (const entry of catalogueEntries())
    {
        const verb = entry.split(/\s+/)[0];
        const command = COMMANDS.find((candidate) => candidate.name === verb);
        assert.ok(command !== undefined, `the cli.md catalogue names \`${verb}\`, which is not a command`);
        for (const flag of longFlags(entry))
        {
            assert.ok(declaredFlags(command).has(flag),
                `the cli.md catalogue offers \`${entry}\`, and \`${verb}\` declares no --${flag}`);
        }
    }
});

test("H2: the catalogue's init entry is the contract's init syntax, flag for flag", () =>
{
    const declared = COMMANDS.find((command) => command.name === "init").usage[0].syntax;
    const documented = catalogueEntries().find((entry) => entry.split(/\s+/)[0] === "init");
    assert.equal(documented, declared, "cli.md and `self init --help` offer different flags");
});

/* ── group G of #440: the surfaces a new top-level verb touches ────── */

// Cells G1, G2, G5, G6 and G7 of
// docs/maintainers/case-tables/440-instructions.md.

test("G1: the cli.md catalogue gains an Instructions family row the parser accepts whole", () =>
{
    const entries = catalogueEntries().filter((entry) => entry.split(/\s+/)[0] === "instruction");
    assert.deepEqual(entries.map((entry) => entry.split(/\s+/).slice(0, 2).join(" ").replace(/"$/, "")),
        ["instruction [list]", "instruction add", "instruction render"]);
    const command = COMMANDS.find((candidate) => candidate.name === "instruction");
    assert.ok(command !== undefined, "cli.md names `instruction`, which is not a command");
    for (const entry of entries)
    {
        for (const flag of longFlags(entry))
        {
            assert.ok(declaredFlags(command).has(flag),
                `the cli.md catalogue offers \`${entry}\`, and \`instruction\` declares no --${flag}`);
        }
    }
    for (const flag of ["kind", "priority", "workspace", "scope", "supersedes", "demote", "proposed", "why",
        "project", "json"])
    {
        assert.ok(entries.some((entry) => longFlags(entry).includes(flag)),
            `the catalogue's Instructions row does not name --${flag}`);
    }
});

test("G2: the catalogue's verb fence carries `instruction`, and still diffs clean", () =>
{
    const page = tier1("docs/reference/cli.md");
    const block = page.match(/top-level verbs:\n\n```text\n([\s\S]*?)```/);
    const documented = block[1].split(/\s+/).filter((word) => word !== "");
    assert.ok(documented.includes("instruction"), "the cli.md verb fence does not name `instruction`");
    assert.deepEqual([...documented].sort(), [...COMMANDS.map((command) => command.name)].sort());
});

test("G5: the managed block gains the render bullet without gaining a section heading", async () =>
{
    const box = machine();
    const { demo } = await demoWorkspace(box);
    const blocks = ["AGENTS.md", "CLAUDE.md"]
        .map((name) => managedBlock(name, readFileSync(join(demo, name), "utf8")));
    assert.equal(blocks[0], blocks[1]);
    assert.deepEqual([...blocks[0].matchAll(/^#{2,3} .+$/gm)].map((found) => found[0]),
        ["## Project state (superself)"]);
    for (const block of blocks)
    {
        assert.ok(block.includes("- Then run `self instruction render` and follow it; it is the operating\n"
            + "  manual for this workspace and is outside the context render budget."), block);
        assert.ok(block.indexOf("- Session start: run `self context`") < block.indexOf("- Then run `self instruction"),
            "the render bullet does not follow the session-start bullet");
    }
});

test("G6: the line the managed block advertises runs as written from that checkout", async () =>
{
    const box = machine();
    const { demo } = await demoWorkspace(box);
    const block = managedBlock("AGENTS.md", readFileSync(join(demo, "AGENTS.md"), "utf8"));
    const advertised = block.split("\n").find((line) => line.includes("`self instruction render`"));
    assert.ok(advertised !== undefined, "the block advertises no render line");
    const rendered = await must(box, demo, advertised.match(/`self ([^`]+)`/)[1].split(" "));
    assert.equal(rendered.code, 0);
    assert.match(rendered.out, /^# Instructions — follow; do not restate\.$/m);
});

// G7 as amended during implementation: this repository does not track
// AGENTS.md or CLAUDE.md (.gitignore, and proof 4 above says why), so there is
// no checked-in file to compare the new template against. What there is, is a
// checkout whose untracked instruction files hold an older block — which is
// what every developer's tree looks like the moment this change lands — and
// the rule that a fold rewrites both of them in place, touching nothing that
// is checked in.
test("G7: a fold rewrites an older block in both untracked instruction files, and nothing tracked", async () =>
{
    const box = machine();
    const { demo } = await demoWorkspace(box);
    const stale = `${BLOCK_BEGIN} v0.0.1 -->\n## Project state (superself)\n\nan older block\n${BLOCK_END}`;
    for (const name of ["AGENTS.md", "CLAUDE.md"])
    {
        writeFileSync(join(demo, name), `# ${name}\n\n${stale}\n`);
    }
    writeFileSync(join(demo, "README.md"), "tracked content\n");
    await must(box, demo, ["fold"]);
    const blocks = ["AGENTS.md", "CLAUDE.md"]
        .map((name) => managedBlock(name, readFileSync(join(demo, name), "utf8")));
    assert.equal(blocks[0], blocks[1]);
    for (const block of blocks)
    {
        assert.equal(block.includes("an older block"), false, "the stale block survived the fold");
        assert.ok(block.includes("- Then run `self instruction render` and follow it"), block);
    }
    assert.equal(readFileSync(join(demo, "README.md"), "utf8"), "tracked content\n");
});
