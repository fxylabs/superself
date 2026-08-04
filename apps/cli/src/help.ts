// How the CLI describes itself, rendered from the command contract rather than
// from a second list beside it. `self` with no arguments prints the whole verb
// list; `self <command> --help` prints that command's syntax and flags. Both
// come from the same declarations that dispatch and parse the commands, so a
// command can never be documented in one place and missing from the other.
//
// The version belongs here for the same reason: what the binary answers about
// itself is one surface, and a per-command special case would be a second one.

import { readFileSync } from "node:fs";
import { spell } from "./args.js";
import { Command, commandLeaves, UsageLine } from "./contract.js";
import { findTopic, TOPICS } from "./guide.js";

// Where the description column starts in the verb list.
const COLUMN = 45;

function listLines(line: UsageLine): string[]
{
    const syntax = "  " + line.syntax;
    const description = line.description ?? [];
    if (description.length === 0)
    {
        return [syntax];
    }
    const indent = " ".repeat(COLUMN);
    const head = syntax.length + 2 > COLUMN ? [syntax, indent + description[0]] : [syntax.padEnd(COLUMN) + description[0]];
    return head.concat(description.slice(1).map((text) => indent + text));
}

export function rootUsage(commands: Command[]): string
{
    return ["usage: self <command>", ""]
        .concat(commands.flatMap((command) => command.usage.flatMap(listLines)))
        .concat("", listLines(VERSION_LINE))
        .concat("", topicLines())
        .join("\n");
}

// The verb list says what can be typed; the topics say when to type it. They
// are listed here because a page nobody knows about answers nothing (#221).
function topicLines(): string[]
{
    return ["concepts: self help <topic>"].concat(TOPICS.map((topic) =>
        `  ${topic.name.padEnd(12)}${topic.summary}`));
}

// The version switch stands where a verb would rather than inside one, so the
// line that documents it belongs to no command and is appended by the render.
const VERSION_LINE: UsageLine = {
    syntax: "--version",
    description: ["print the version of the package this binary was built from"],
    verbs: []
};

// Read out of the package the running code sits in, never a constant a release
// could forget to move: an install is verified by asking the binary, and an
// answer that came from anywhere but its own package would verify nothing.
// `dist/` sits one directory below the package root in a checkout and in the
// published tarball alike, so one relative step answers for both.
export function cliVersion(): string
{
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(manifest.version);
}

// A command whose subject has a concept page prints both: the syntax first,
// then what the thing is and when to reach for it. One page per subject beats
// two names for it, and nothing a topic says becomes unreachable because a
// command already owns the word (#221).
export function commandUsage(command: Command): string
{
    const header = command.usage.map((line, index) => (index === 0 ? "usage: self " : "       self ") + line.syntax);
    const topic = findTopic(command.name);
    return header.concat("", command.detail, required(command),
        topic === undefined ? [] : ["", ...topic.body]).join("\n");
}

/* ── the options a verb cannot run without ─────────────────────────── */

// Rendered from the leaves' own declarations, which is the same structure the
// parse gate refuses against: a reader who assembles a call from this page
// cannot be refused for a flag the page failed to mark (#106).
const REQUIRED_WIDTH = 76;

function required(command: Command): string[]
{
    const verbs = commandLeaves(command).flatMap((entry) => entry.leaf.requires.length === 0 ? []
        : [{ path: entry.verb === "" ? command.name : `${command.name} ${entry.verb}`, leaf: entry.leaf }]);
    if (verbs.length === 0)
    {
        return [];
    }
    const column = Math.max(...verbs.map((entry) => entry.path.length)) + 4;
    return ["", "required, and refused in one pass when missing:"].concat(verbs.flatMap((entry) =>
        wrapped(`  ${entry.path.padEnd(column)}`, entry.leaf.requires.map(spell))));
}

// A verb with nine required options would run off the page on one line, so the
// list wraps under the column its first flag stands in.
function wrapped(prefix: string, flags: string[]): string[]
{
    const lines: string[] = [];
    let line = prefix;
    for (const flag of flags)
    {
        if (line.trim() !== "" && line.length + flag.length + 1 > REQUIRED_WIDTH)
        {
            lines.push(line);
            line = " ".repeat(prefix.length);
        }
        line = line.endsWith(" ") ? line + flag : `${line} ${flag}`;
    }
    return lines.concat(line);
}
