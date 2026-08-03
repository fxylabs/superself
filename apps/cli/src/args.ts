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

export interface ParsedArguments
{
    values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    positionals: string[];
}

export function parseCommand(cmd: string, args: string[], options: OptionSpecs, accepts: number): ParsedArguments
{
    const parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
    const extra = parsed.positionals[accepts];
    if (extra !== undefined)
    {
        throw new CliError(`unexpected argument '${extra}' — ${helpHint(cmd)}`);
    }
    // The option set arrives from the contract rather than from a literal at
    // this call site, so node infers the widest value type it has; the shape
    // every command reads is the uniform one.
    return { values: parsed.values as ParsedArguments["values"], positionals: parsed.positionals };
}

export function unknownOption(arg: string, cmd: string | undefined): string
{
    return `unknown option '${arg}' — ${helpHint(cmd)}`;
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
