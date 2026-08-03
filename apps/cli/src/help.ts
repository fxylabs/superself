// How the CLI describes itself, rendered from the command contract rather than
// from a second list beside it. `self` with no arguments prints the whole verb
// list; `self <command> --help` prints that command's syntax and flags. Both
// come from the same declarations that dispatch and parse the commands, so a
// command can never be documented in one place and missing from the other.
//
// The version belongs here for the same reason: what the binary answers about
// itself is one surface, and a per-command special case would be a second one.

import { readFileSync } from "node:fs";
import { Command, UsageLine } from "./contract.js";

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
        .join("\n");
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

export function commandUsage(command: Command): string
{
    const header = command.usage.map((line, index) => (index === 0 ? "usage: self " : "       self ") + line.syntax);
    return header.concat("", command.detail).join("\n");
}
