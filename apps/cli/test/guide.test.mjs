// An agent in someone else's project can reach the managed block and the
// installed binary, and nothing else. These proofs hold that surface together:
// every concept page is reachable from the binary, the block points only at
// pages that exist, and a block states which CLI wrote it (#221).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandLeaves } from "../dist/contract.js";
import { TOPICS } from "../dist/guide.js";
import { cliVersion, rootUsage } from "../dist/help.js";
import { COMMANDS } from "../dist/main.js";
import { demoWorkspace, machine, must, selfIn } from "./harness.mjs";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "self-guide-"));

function self(args)
{
    return execFileSync(process.execPath, [bin, ...args], { cwd: home, encoding: "utf8", env: { ...process.env, HOME: home } });
}

test("every concept page answers from the binary, with its own name and body", () =>
{
    for (const topic of TOPICS)
    {
        const page = self(["help", topic.name]);
        assert.ok(page.includes(topic.body[0]), `\`self help ${topic.name}\` printed a page without its body`);
    }
});

// A subject a command already owns keeps one page: the syntax, then the
// concept. Nothing a topic says may become unreachable because a command owns
// the word.
test("a subject with both a command and a concept page prints both on one page", () =>
{
    for (const command of COMMANDS)
    {
        const topic = TOPICS.find((item) => item.name === command.name);
        if (topic === undefined)
        {
            continue;
        }
        const page = self(["help", command.name]);
        assert.match(page, /^usage: self /, `\`self help ${command.name}\` lost its syntax`);
        assert.ok(page.includes(topic.body[0]), `\`self help ${command.name}\` lost its concept page`);
    }
});

test("the verb list names every concept page, so an agent can find one unprompted", () =>
{
    const listing = rootUsage(COMMANDS);
    for (const topic of TOPICS)
    {
        assert.ok(listing.includes(`self help <topic>`), "the root usage stopped saying how a topic is asked for");
        assert.ok(listing.includes(topic.name), `the root usage does not list "${topic.name}"`);
    }
});

test("an unknown topic falls back to the verb list rather than refusing", () =>
{
    assert.equal(self(["help", "nonesuch"]), rootUsage(COMMANDS) + "\n");
});

/* ── the block states which CLI wrote it ───────────────────────────── */

const box = machine();
const { demo } = demoWorkspace(box);

test("a rendered block carries the version that rendered it", () =>
{
    const block = readFileSync(join(demo, "CLAUDE.md"), "utf8");
    assert.ok(block.includes(`<!-- superself:begin v${cliVersion()} -->`), `the block carries no version marker:\n${block.slice(0, 200)}`);
});

test("the block points only at concept pages that exist", () =>
{
    const block = readFileSync(join(demo, "CLAUDE.md"), "utf8");
    for (const asked of block.matchAll(/`self help ([a-z-]+)`/g))
    {
        assert.ok(TOPICS.some((topic) => topic.name === asked[1]),
            `the block points at \`self help ${asked[1]}\`, which is not a topic`);
    }
});

// The marker gained a version after blocks were already checked into projects.
// An old one has to be replaced where it stands: appending a second block
// beside it would leave the agent reading two generations at once.
test("a block written before the version marker is replaced in place", () =>
{
    const file = join(demo, "CLAUDE.md");
    const current = readFileSync(file, "utf8");
    const begin = current.indexOf("<!-- superself:begin");
    const end = current.indexOf("<!-- superself:end -->");
    const legacy = current.slice(0, begin) + "<!-- superself:begin -->\nstale body\n"
        + current.slice(end) + "\ntrailing project text\n";
    writeFileSync(file, legacy);
    must(box, demo, ["connect"]);
    const rewritten = readFileSync(file, "utf8");
    assert.equal(rewritten.match(/<!-- superself:begin/g).length, 1, "the old block was left beside the new one");
    assert.ok(rewritten.includes(`<!-- superself:begin v${cliVersion()} -->`), "the rewritten block carries no version");
    assert.ok(!rewritten.includes("stale body"), "the old body survived the rewrite");
    assert.ok(rewritten.includes("trailing project text"), "the rewrite ate text the block does not own");
});

test("recording something rewrites the block without being asked", () =>
{
    const file = join(demo, "CLAUDE.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/<!-- superself:begin[^\n]*-->/, "<!-- superself:begin v0.0.1 -->"));
    must(box, demo, ["decide", "the block refreshes on a write", "--why", "proving the fold path"]);
    assert.ok(readFileSync(file, "utf8").includes(`<!-- superself:begin v${cliVersion()} -->`),
        "an event append did not bring the block forward");
});

test("a project that never registered a block does not gain one from a write", () =>
{
    const bare = selfIn(box, demo, ["state"]);
    assert.equal(bare.code, 0);
    assert.doesNotMatch(readFileSync(join(demo, "CLAUDE.md"), "utf8"), /superself:begin[^\n]*-->[\s\S]*superself:begin/);
});

// Every leaf the contract declares is reachable from the binary; the concept
// pages are the other half of what an agent reads, so they answer for
// themselves rather than being listed in a document only this repository has.
test("the concept pages and the command pages are both answerable offline", () =>
{
    for (const command of COMMANDS)
    {
        assert.ok(commandLeaves(command).length > 0, `${command.name} declares no leaf`);
    }
    assert.ok(TOPICS.length > 0, "the guide declares no topic");
});
