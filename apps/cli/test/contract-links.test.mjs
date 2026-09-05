// The link contract of #417, part (a): a work unit's stated disposition —
// contribution, standalone with a reason, or an operational run — and the
// decisions a checkpoint says it assumes.
//
// Every test below is one cell of
// docs/maintainers/case-tables/417-contract-links.md, named by its cell
// number, and asserts that cell's stated outcome. The assertions read what the
// CLI prints and what its log holds; none of them calls the helper the
// implementation calls, so a helper that is wrong in the same way twice still
// fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../dist/main.js";
import { checkContract, leaf, resolveCommand } from "../dist/contract.js";
import { commonProtocolLines } from "../dist/connect.js";
import { findTopic } from "../dist/guide.js";
import { demoWorkspace, idIn, machine, must, mustPerson, receiptIn, selfIn, workIdIn } from "./harness.mjs";

function eventsOf(ws, slug)
{
    const file = join(ws, ".superself", "projects", slug, "log.jsonl");
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

function linksOf(ws, slug, entity, type)
{
    return eventsOf(ws, slug).filter((event) => event.type === type && event.payload.entity === entity)
        .map((event) => event.payload.link);
}

function objectiveIdIn(text)
{
    const match = text.match(/\bo-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no objective id in: ${text}`);
    return match[0];
}

function milestoneIdIn(text)
{
    const match = text.match(/\bm-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no milestone id in: ${text}`);
    return match[0];
}

// A project with one unit and nothing said about what it serves.
async function unattached(outcome = "a bounded effort")
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", outcome])).out);
    return { box, ws, demo, work };
}

/* ── 1: the standalone disposition ─────────────────────────────────── */

test("1: a unit declares that it contributes to nothing, with the reason", async () =>
{
    const { box, ws, demo, work } = await unattached();
    await must(box, demo, ["work", "link", work, "--standalone", "--why", "it keeps a private tool running"]);
    assert.deepEqual(linksOf(ws, "demo", work, "entity.linked"),
        [{ type: "standalone", target: work, why: "it keeps a private tool running" }]);
});

test("2: a standalone declaration with no reason is refused, and records nothing", async () =>
{
    const { box, ws, demo, work } = await unattached();
    const refused = await selfIn(box, demo, ["work", "link", work, "--standalone"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--why/);
    assert.equal(linksOf(ws, "demo", work, "entity.linked").length, 0);
});

test("3: the declaration is withdrawn by the same edge, unlinked", async () =>
{
    const { box, ws, demo, work } = await unattached();
    await must(box, demo, ["work", "link", work, "--standalone", "--why", "nothing current needs it"]);
    await must(box, demo, ["work", "unlink", work, "--standalone"]);
    assert.deepEqual(linksOf(ws, "demo", work, "entity.unlinked"), [{ type: "standalone", target: work }]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", work])).out, /Standalone/);
});

test("4: declaring standalone twice is refused — one edge is one link", async () =>
{
    const { box, ws, demo, work } = await unattached();
    await must(box, demo, ["work", "link", work, "--standalone", "--why", "the first reason"]);
    const refused = await selfIn(box, demo, ["work", "link", work, "--standalone", "--why", "a second reason"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /already stands alone — the first reason/);
    assert.equal(linksOf(ws, "demo", work, "entity.linked").length, 1);
});

test("5: standalone and an outcome in one call is refused", async () =>
{
    const { box, ws, demo, work } = await unattached();
    const objective = objectiveIdIn((await must(box, demo, ["objective", "add", "a time-boxed outcome"])).out);
    const refused = await selfIn(box, demo,
        ["work", "link", work, "--standalone", "--why", "w", "--objective", objective]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /contributes to no outcome/);
    assert.equal(linksOf(ws, "demo", work, "entity.linked").length, 0);
});

test("6: the unit's page states the disposition, the reason and when it was declared", async () =>
{
    const { box, demo, work } = await unattached();
    await must(box, demo, ["work", "link", work, "--standalone", "--why", "it keeps a private tool running"]);
    const shown = (await must(box, demo, ["work", "show", work])).out;
    assert.match(shown, /- Standalone: it keeps a private tool running \(declared \d{4}-\d{2}-\d{2}\)/);
});

test("7: a standalone declaration conceals no contribution the unit already states", async () =>
{
    const { box, demo, work } = await unattached();
    const objective = objectiveIdIn((await must(box, demo, ["objective", "add", "a time-boxed outcome"])).out);
    await must(box, demo, ["work", "link", work, "--objective", objective]);
    await must(box, demo, ["work", "link", work, "--standalone", "--why", "it also carries private upkeep"]);
    const shown = (await must(box, demo, ["work", "show", work])).out;
    assert.match(shown, /- Contributes to: /);
    assert.match(shown, /- Standalone: it also carries private upkeep/);
});

test("8: withdrawing a declaration nobody made is refused, and names the verb that makes one", async () =>
{
    const { box, demo, work } = await unattached();
    const refused = await selfIn(box, demo, ["work", "unlink", work, "--standalone"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /does not stand alone/);
    assert.match(refused.out, new RegExp(`self work link ${work} --standalone --why`));
});

test("9: a unit is born standalone in one append", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    const printed = (await mustPerson(box, demo,
        ["work", "add", "keep the private tool running", "--standalone", "--why", "no stated outcome needs it"])).out;
    const work = workIdIn(printed);
    const creations = eventsOf(ws, "demo").filter((event) => event.payload.entity === work);
    assert.equal(creations.length, 1, "the unit and its disposition are one append");
    assert.deepEqual(creations[0].payload.links,
        [{ type: "standalone", target: work, why: "no stated outcome needs it" }]);
    assert.match((await must(box, demo, ["work", "show", work])).out, /- Standalone: no stated outcome needs it/);
});

test("10: one --why cannot state both a supersession and a standalone declaration", async () =>
{
    const { box, ws, demo, work } = await unattached();
    const refused = await selfIn(box, demo,
        ["work", "add", "a replacement", "--supersedes", work, "--why", "moved", "--standalone"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--standalone needs a reason of its own/);
    assert.match(refused.out, /self work link <new-id> --standalone --why/);
    assert.equal(eventsOf(ws, "demo").filter((event) => event.type === "entity.retired").length, 0);
});

test("11: a plan proposed standalone is still standalone once it is confirmed", async () =>
{
    const box = machine();
    const { demo } = await demoWorkspace(box);
    const plan = workIdIn((await must(box, demo,
        ["work", "propose", "tidy the build script", "--standalone", "--why", "it closes no stated gap"])).out);
    assert.match((await must(box, demo, ["work", "show", plan])).out, /- Standalone: it closes no stated gap/);
    await mustPerson(box, demo, ["work", "confirm", plan]);
    assert.match((await must(box, demo, ["work", "show", plan])).out, /- Standalone: it closes no stated gap/);
});

test("12: declare, withdraw and declare again — the newest reason is what the unit reads", async () =>
{
    const { box, demo, work } = await unattached();
    await must(box, demo, ["work", "link", work, "--standalone", "--why", "the first reason"]);
    await must(box, demo, ["work", "unlink", work, "--standalone"]);
    await must(box, demo, ["work", "link", work, "--standalone", "--why", "the second reason"]);
    assert.match((await must(box, demo, ["work", "show", work])).out, /- Standalone: the second reason/);
    const history = (await must(box, demo, ["work", "show", work, "--history"])).out;
    assert.equal(history.match(/entity\.linked/g).length, 2, "both declarations stay on the record");
    assert.equal(history.match(/entity\.unlinked/g).length, 1);
});

test("13: undoing the declaring event takes the disposition off every surface", async () =>
{
    const { box, demo, work } = await unattached();
    const declared = idIn((await must(box, demo, ["work", "link", work, "--standalone", "--why", "nothing needs it"])).out);
    await must(box, demo, ["undo", declared, "--why", "declared on the wrong unit"]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", work])).out, /Standalone/);
});

/* ── 2: the decisions a checkpoint assumes ─────────────────────────── */

// A project with one objective, one checkpoint under it, and two decisions.
async function checkpoint()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    const objective = objectiveIdIn((await must(box, demo, ["objective", "add", "a time-boxed outcome"])).out);
    const first = idIn((await must(box, demo, ["decide", "the store is append-only"])).out);
    const second = idIn((await must(box, demo, ["decide", "the fold reads one log"])).out);
    const milestone = milestoneIdIn((await must(box, demo,
        ["milestone", "add", "a checkpoint", "--objective", objective, "--exit", "the proof passes"])).out);
    return { box, ws, demo, objective, milestone, first, second };
}

test("14: a checkpoint states a decision it assumes", async () =>
{
    const { box, ws, demo, milestone, first } = await checkpoint();
    await must(box, demo, ["milestone", "link", milestone, "--decision", first]);
    assert.deepEqual(linksOf(ws, "demo", milestone, "entity.linked"), [{ type: "assumes", target: first }]);
});

test("15: assuming the same decision twice is refused", async () =>
{
    const { box, ws, demo, milestone, first } = await checkpoint();
    await must(box, demo, ["milestone", "link", milestone, "--decision", first]);
    const refused = await selfIn(box, demo, ["milestone", "link", milestone, "--decision", first]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /already assumes/);
    assert.equal(linksOf(ws, "demo", milestone, "entity.linked").length, 1);
});

test("16: an id that is not a decision is refused as one", async () =>
{
    const { box, demo, milestone } = await checkpoint();
    const refused = await selfIn(box, demo, ["milestone", "link", milestone, "--decision", "not-a-decision"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is not a decision/);
});

test("17: a prefix two decisions answer to is refused as ambiguous", async () =>
{
    const { box, demo, milestone, first, second } = await checkpoint();
    const shared = [...first].findIndex((character, index) => character !== second[index]);
    const refused = await selfIn(box, demo, ["milestone", "link", milestone, "--decision", first.slice(0, shared)]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is ambiguous \(2 matches\)/);
});

test("18: an assumption is withdrawn by name", async () =>
{
    const { box, ws, demo, milestone, first } = await checkpoint();
    await must(box, demo, ["milestone", "link", milestone, "--decision", first]);
    await must(box, demo, ["milestone", "unlink", milestone, "--decision", first]);
    assert.deepEqual(linksOf(ws, "demo", milestone, "entity.unlinked"), [{ type: "assumes", target: first }]);
    assert.doesNotMatch((await must(box, demo, ["milestone", "show", milestone])).out, /Assumes/);
});

test("19: withdrawing an assumption never stated is refused", async () =>
{
    const { box, demo, milestone, first } = await checkpoint();
    const refused = await selfIn(box, demo, ["milestone", "unlink", milestone, "--decision", first]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /does not assume/);
    assert.match(refused.out, new RegExp(`self milestone link ${milestone} --decision`));
});

test("20: withdrawing one assumption leaves the others where they were", async () =>
{
    const { box, demo, milestone, first, second } = await checkpoint();
    await must(box, demo, ["milestone", "link", milestone, "--decision", first]);
    await must(box, demo, ["milestone", "link", milestone, "--decision", second]);
    await must(box, demo, ["milestone", "unlink", milestone, "--decision", first]);
    const shown = (await must(box, demo, ["milestone", "show", milestone])).out;
    assert.match(shown, new RegExp(`- Assumes: ${second}$`, "m"));
});

test("21: an assumption is replaced by linking the successor and unlinking the old one", async () =>
{
    const { box, demo, milestone, first } = await checkpoint();
    await must(box, demo, ["milestone", "link", milestone, "--decision", first]);
    const successor = idIn((await must(box, demo,
        ["decide", "the store is append-only and compacted", "--supersedes", first])).out);
    await must(box, demo, ["milestone", "link", milestone, "--decision", successor]);
    await must(box, demo, ["milestone", "unlink", milestone, "--decision", first]);
    const shown = (await must(box, demo, ["milestone", "show", milestone])).out;
    assert.match(shown, new RegExp(`- Assumes: ${successor}$`, "m"));
    assert.doesNotMatch(shown, new RegExp(first));
});

test("22: a checkpoint is born naming the decisions it assumes", async () =>
{
    const { box, demo, objective, first, second } = await checkpoint();
    const born = milestoneIdIn((await must(box, demo, ["milestone", "add", "a second checkpoint",
        "--objective", objective, "--exit", "the second proof passes",
        "--decision", first, "--decision", second])).out);
    assert.match((await must(box, demo, ["milestone", "show", born])).out,
        new RegExp(`- Assumes: ${first}, ${second}$`, "m"));
});

test("23: a revision states its own assumptions", async () =>
{
    const { box, demo, milestone, first } = await checkpoint();
    // The receipt, not the first id printed: a revision discloses the record it
    // replaces before it writes, so the predecessor leads the output.
    const revised = milestoneIdIn(receiptIn((await must(box, demo,
        ["milestone", "revise", milestone, "--why", "the ground moved", "--decision", first])).out));
    assert.notEqual(revised, milestone);
    assert.match((await must(box, demo, ["milestone", "show", revised])).out,
        new RegExp(`- Assumes: ${first}$`, "m"));
});

test("24: the checkpoint's page names the decisions it assumes", async () =>
{
    const { box, demo, milestone, first } = await checkpoint();
    await must(box, demo, ["milestone", "link", milestone, "--decision", first]);
    assert.match((await must(box, demo, ["milestone", "show", milestone])).out,
        new RegExp(`- Assumes: ${first}$`, "m"));
});

/* ── 3: one guidance contract, part (a) ────────────────────────────── */

// Every `self …` command a piece of guidance offers a reader — read from the
// places a reader copies from, which is a backtick span or a line that is
// itself a command. Prose that merely says the word is not an offer: "a
// refusal (self not installed …)" names no command, and reading it as one
// would make the check fail on English rather than on the contract.
function offeredCommands(text)
{
    // Fenced blocks are read by the line rule below; taking their delimiters as
    // inline spans would pair a fence with the next stray backtick and read a
    // whole block as one quotation.
    const prose = text.replace(/```[\s\S]*?```/g, "");
    const quoted = [...prose.matchAll(/`([^`]*)`/g)].map((found) => found[1]);
    const commandLines = text.split("\n").filter((line) => /^\s*self\s/.test(line));
    return [...quoted, ...commandLines]
        .flatMap((source) => [...source.matchAll(/\bself ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)*)/g)])
        .map((found) => found[1]);
}

// The three routes an agent enters this contract through. Each is read from
// what actually ships: the CLI's own pages, the block `connect` generates, and
// the plugin's tool descriptions plus its README.
const pluginRoot = new URL("../../dsh-plugin/", import.meta.url);

function entryRoutes()
{
    const cliPages = [
        ...COMMANDS.filter((command) => ["work", "milestone"].includes(command.name))
            .flatMap((command) => [...command.usage.flatMap((line) => [line.syntax, ...line.description ?? []]), ...command.detail]),
        ...["work", "goals"].flatMap((name) => findTopic(name).body)
    ].join("\n");
    const plugin = readFileSync(new URL("src/tools.ts", pluginRoot), "utf8")
        + readFileSync(new URL("README.md", pluginRoot), "utf8");
    return { cli: cliPages, block: commonProtocolLines().join("\n"), plugin };
}

// What every one of these has to say in part (a). Spelled as a command each
// route must offer, because that is what a reader copies.
const SHIPPED = [
    "work link <id> --standalone --why",
    "milestone link <id> --decision",
    "runbook link <run> --work <id>"
];

test("27, 28, 29: each entry route offers the standalone, assumption and run-link commands", () =>
{
    for (const [route, text] of Object.entries(entryRoutes()))
    {
        assert.match(text, /work link [^\n]*--standalone/, `${route} never offers the standalone declaration`);
        assert.match(text, /milestone (link|unlink)[^\n]*--decision/, `${route} never offers the assumption commands`);
        assert.match(text, /runbook link[^\n]*--work/, `${route} never offers the operational run link`);
    }
    assert.equal(SHIPPED.length, 3);
});

// The six record kinds, and the question each one answers. A route that names
// the kinds but not what distinguishes them leaves the reader choosing by feel,
// which is the choice #417 observed going wrong.
const RECORD_KINDS = ["goal", "objective", "milestone", "work", "decision", "runbook"];

test("27, 28, 29: each entry route names every record kind a reader chooses between", () =>
{
    for (const [route, text] of Object.entries(entryRoutes()))
    {
        for (const kind of RECORD_KINDS)
        {
            assert.match(text, new RegExp(`\\b${kind}\\b`), `${route} never names the ${kind} record`);
        }
        assert.match(text, /never by how (the|its) text reads/,
            `${route} never says a record kind is chosen by what it asserts`);
    }
});

test("25, 26: the pages declare the flags they offer", () =>
{
    const work = COMMANDS.find((command) => command.name === "work");
    const milestone = COMMANDS.find((command) => command.name === "milestone");
    assert.ok(work.detail.some((line) => /^ {2}--standalone\b/.test(line)),
        "`self work --help` offers --standalone without listing it among its flags");
    assert.ok(milestone.detail.some((line) => /^ {2}--decision\b/.test(line)),
        "`self milestone --help` offers --decision without listing it among its flags");
});

// `self help <topic>` is answered by the guide rather than by a command in the
// contract, so a reader who follows it gets a page either way. Every other
// path has to resolve to a leaf.
function dispatches(path)
{
    const words = path.split(" ");
    return words[0] === "help"
        ? words.length === 1 || findTopic(words[1]) !== undefined
        : resolveCommand(COMMANDS, words) !== null;
}

test("30: every command the three routes name is one this branch dispatches", () =>
{
    for (const [route, text] of Object.entries(entryRoutes()))
    {
        for (const path of new Set(offeredCommands(text)))
        {
            assert.ok(dispatches(path),
                `the ${route} guidance offers \`self ${path}\`, which this branch does not dispatch`);
        }
    }
});

test("31: the offer after `work add` reaches the third disposition", async () =>
{
    const box = machine();
    const { demo } = await demoWorkspace(box);
    const printed = (await mustPerson(box, demo, ["work", "add", "a bounded effort"])).out;
    assert.match(printed, new RegExp(`self work link ${workIdIn(printed)} --standalone --why`));
});

test("31: a unit born standalone is not offered the declaration it just made", async () =>
{
    const box = machine();
    const { demo } = await demoWorkspace(box);
    const printed = (await mustPerson(box, demo,
        ["work", "add", "a bounded effort", "--standalone", "--why", "nothing stated needs it"])).out;
    assert.doesNotMatch(printed, /--standalone --why "</);
});

/* ── 4: the contract gate ──────────────────────────────────────────── */

test("33: a requirement naming only a boolean is still refused", () =>
{
    const command = {
        name: "probe",
        usage: [{ syntax: "probe run [--flag]", verbs: ["run"] }],
        detail: ["  --flag                a flag that states nothing"],
        node: leaf("run", { flag: { type: "boolean" } }, 0, () => undefined,
            { requires: [{ flags: ["flag"], hint: "a flag with no value" }] })
    };
    assert.ok(checkContract([command]).some((problem) => /a flag with no value states nothing/.test(problem)),
        "a requirement that names one boolean and nothing else must still be refused");
});
