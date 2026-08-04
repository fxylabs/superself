// Every command reads its arguments through here. A command states the options
// it takes and how many positionals it accepts, so anything else is named as a
// mistake instead of being dropped: a swallowed flag leaves the user believing
// it took effect, and a swallowed flag on a write leaves state they did not ask
// for. Parsing also gives every command the same `--` contract, after which an
// option-looking argument is text the user meant literally.
//
// What a command states is no longer stated here: `contract.ts` holds the one
// declaration of each command's options and positional count, and the
// dispatcher hands it to `parseCommand`. This module is the gate, not the
// catalogue.

import { parseArgs } from "node:util";
import { CliError } from "./types.js";

export interface OptionSpec
{
    type: "string" | "boolean";
    multiple?: boolean;
    short?: string;
}

export type OptionSpecs = Record<string, OptionSpec>;

// One option a verb cannot run without, or a group where at least one of them
// has to be given. The hint is what the flag is for, in the caller's terms; the
// unblocking path is the exact spelling of the verb that creates the missing
// precondition, for a requirement a project can be unable to satisfy yet.
export interface Requirement
{
    flags: string[];
    hint: string;
    // What stands after the flag on a help page: `<text>` unless stated.
    value?: string;
    unblock?: string;
}

export interface ParsedArguments
{
    values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    positionals: string[];
}

export function parseCommand(path: string, args: string[], options: OptionSpecs, accepts: number,
    requires: Requirement[] = []): ParsedArguments
{
    const parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
    const extra = parsed.positionals[accepts];
    if (extra !== undefined)
    {
        throw new CliError(`unexpected argument '${extra}' — ${helpHint(root(path))}`);
    }
    // The option set arrives from the contract rather than from a literal at
    // this call site, so node infers the widest value type it has; the shape
    // every command reads is the uniform one.
    const values = parsed.values as ParsedArguments["values"];
    requireOptions(path, values, requires);
    return { values, positionals: parsed.positionals };
}

/* ── the required-option gate ──────────────────────────────────────── */

// Every missing required option in one answer. A contract discovered one
// refusal at a time costs an agent a command round per hidden requirement, and
// the hints live here rather than in the handler because the same declaration
// is what the help page renders (#106).
export function requireOptions(path: string, values: ParsedArguments["values"], requires: Requirement[]): void
{
    const missing = requires.filter((requirement) => !requirement.flags.some((flag) => given(values[flag])));
    if (missing.length === 0)
    {
        return;
    }
    const head = missing.length === 1
        ? [`self ${path} needs ${spell(missing[0])}: ${missing[0].hint}`]
        : [`self ${path} needs ${missing.length} more options:`, ...listed(missing), helpHint(root(path))];
    throw new CliError([...head, ...missing.flatMap((requirement) =>
        requirement.unblock === undefined ? [] : [requirement.unblock])].join("\n"));
}

// An option is given when it carries text. A flag passed with an empty string
// states nothing the record could keep, so it counts as absent rather than as
// a value the command has to strip later.
function given(value: ParsedArguments["values"][string]): boolean
{
    if (Array.isArray(value))
    {
        return value.some((item) => given(item));
    }
    return typeof value === "string" ? value.trim() !== "" : value === true;
}

function listed(missing: Requirement[]): string[]
{
    const column = Math.max(...missing.map((requirement) => named(requirement).length));
    return missing.map((requirement) => `  ${named(requirement).padEnd(column)}  ${requirement.hint}`);
}

function named(requirement: Requirement): string
{
    return `${spell(requirement)} ${requirement.value ?? "<text>"}`;
}

export function spell(requirement: Requirement): string
{
    return requirement.flags.map((flag) => `--${flag}`).join("|");
}

// The scoped help a hint points at is the command's, and a path names the verb
// under it — `self work propose` is documented on `self work --help`.
function root(path: string): string
{
    return path.split(" ")[0];
}

export function unknownOption(arg: string, cmd: string | undefined): string
{
    return `unknown option '${arg}' — ${helpHint(cmd)}`;
}

// The value of an option the leaf declared required. The gate refused the call
// before the handler ran, so what is left here is the read — a handler that
// asked again would be a second implementation of the same rule.
export function required(value: string | undefined): string
{
    return value ?? "";
}

// The empty-argument refusal every command spells the same way. `main.ts` and
// `goals.ts` still carry private copies (see Known debt); this is the shared
// home new surfaces import instead of adding another one.
export function requireText(value: string | undefined, usage: string): string
{
    if (value === undefined || value.trim() === "")
    {
        throw new CliError(`usage: self ${usage}`);
    }
    return value;
}

// Point at the scoped help when a command is named, the root list otherwise.
// Every caller passes a root command name the contract already resolved, so
// the name is not checked against the command list a second time here.
export function helpHint(cmd: string | undefined): string
{
    return `run \`self ${cmd === undefined ? "" : cmd + " "}--help\` for the syntax`;
}

// Every command that dispatches on a subcommand reads it through here, so `--`
// means one thing across the whole CLI: what follows is text. A subcommand is
// never text, so `--` in its place is a mistake worth explaining, while a
// command whose first argument is text — `report`, `decide`, `search` — takes
// its `--` through parseCommand and keeps the literal argument. No subcommand
// starts with a dash either, so an option-looking one is a bad flag rather than
// an unknown subcommand.
export function subcommand(cmd: string, args: string[]): string | undefined
{
    const first = args[0];
    if (first === "--")
    {
        throw new CliError(`\`--\` starts literal text, but \`self ${cmd}\` expects a subcommand — ${helpHint(cmd)}`);
    }
    if (first !== undefined && first.startsWith("-"))
    {
        throw new CliError(unknownOption(first, cmd));
    }
    return first;
}
