// Every command reads its arguments through here. A command states the options
// it takes and how many positionals it accepts, so anything else is named as a
// mistake instead of being dropped: a swallowed flag leaves the user believing
// it took effect, and a swallowed flag on a write leaves state they did not ask
// for. Parsing also gives every command the same `--` contract, after which an
// option-looking argument is text the user meant literally.

import { parseArgs } from "node:util";
import { findCommand } from "./help.js";
import { CliError } from "./types.js";

interface OptionSpec
{
    type: "string" | "boolean";
    multiple?: boolean;
    short?: string;
}

export function parseCommand<T extends Record<string, OptionSpec>>(cmd: string, args: string[], options: T, accepts: number)
{
    const parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
    const extra = parsed.positionals[accepts];
    if (extra !== undefined)
    {
        throw new CliError(`unexpected argument '${extra}' — ${helpHint(cmd)}`);
    }
    return parsed;
}

export function unknownOption(arg: string, cmd: string | undefined): string
{
    return `unknown option '${arg}' — ${helpHint(cmd)}`;
}

// Point at the scoped help when the command is known, the root list otherwise.
export function helpHint(cmd: string | undefined): string
{
    const command = findCommand(cmd);
    return `run \`self ${command === undefined ? "" : command.name + " "}--help\` for the syntax`;
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
