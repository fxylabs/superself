// One reviewed set, applied as one append (#312). An agent auditing a
// project's state produces a dozen record-destroying calls at once, and
// writing them one at a time is a dozen appends any one of which can be the
// one that fails — so a set of them lands together or not at all, and one
// disclosure states the whole of what it destroyed.
//
// `self apply <file>` reads that set. Every line takes exactly the path a
// typed command takes — the contract resolves it, the parse gate reads its
// options, the verb that owns the record resolves the record — and every write
// is held until the whole set has been stated. Nothing is queued invisibly and
// nothing is applied outside the file: a line that records rather than
// destroys, one the CLI does not dispatch, one its own verb refuses, or one
// naming a record another line already names refuses the whole file with
// nothing written.
//
// A plan is deliberately not read from stdin: a file piped in would be a set
// nobody could read back before it was applied.
import { readFileSync } from "node:fs";
import { parseCommand, requireText } from "./args.js";
import { resolveAliasCommand } from "./aliases.js";
import { Command, leaf, Resolved, resolveCommand } from "./contract.js";
import {
    collectedSoFar,
    collectRetirements,
    dropCollected,
    NESTED_SET_REFUSAL,
    recordCollected,
    retires
} from "./retirement.js";
import { plural } from "./style.js";
import { CliError, CommandOutput } from "./types.js";

// One command as it stands in the file: where it was written, what it says,
// and the argv it becomes. The line number and the text travel together
// because a refusal names both.
interface PlanLine
{
    number: number;
    text: string;
    argv: string[];
}

const APPLY = "apply";

// The command list is handed over rather than imported: `main.ts` composes the
// root list this verb belongs to, so importing it back would be a cycle. A
// thunk, because the list is still being built where this is declared.
export function applyCommand(commands: () => Command[]): Command
{
    return {
        name: APPLY,
        usage: [{
            syntax: "apply <file>",
            description: [
                "run a reviewed file of record-destroying commands as one append",
                "(the whole set lands together, or the first refusal stops all of it)"
            ],
            verbs: [""]
        }],
        detail: APPLY_DETAIL,
        node: leaf("", {}, 1, ({ positionals }) =>
            applyPlan(commands(), requireText(positionals[0], "apply <file>")))
    };
}

const APPLY_DETAIL = [
    "run a reviewed set of record-destroying commands as one append. An agent",
    "auditing project state prepares many of them at once, and writing them one",
    "at a time is many appends any one of which can be the one that fails. This",
    "runs that set, states every record it destroys — its id, its own text, its",
    "reason — and records the whole of it in one write.",
    "",
    "the file holds one command per line, exactly as it would be typed, with or",
    "without the leading `self`. Blank lines and lines beginning with # are notes:",
    "",
    "  # two records that say the same thing",
    "  self decide retract 01kz2n… --why \"a duplicate of 01kz2m…\"",
    "  self work retire w-abc12 --why \"the outcome moved to w-def34\"",
    "",
    "every line has to destroy a record. A line that records something instead,",
    "one no command dispatches, one its own verb refuses, or one naming a record",
    "an earlier line already names refuses the whole file, and nothing in it is",
    "written — one append covers a set, and a set with a hole in it is not the",
    "set that was reviewed. A verb outside that set — one that writes the",
    "store config, the git remote or an installed app, or one that only",
    "reads — is refused before it runs, so a refused file leaves nothing changed",
    "anywhere.",
    "",
    "a supersession states what it would write as well as what it would retire:",
    "its successor's own words are its reason, so they are in the disclosure.",
    "",
    "a plan is not read from stdin: a set is reviewed before it is applied, and a",
    "file that arrives on a pipe is one nobody read back."
];

// The collection is opened before the first line runs and dropped on every
// path out, so a refusal never leaves the append gate holding the log shut.
async function applyPlan(commands: Command[], path: string): Promise<CommandOutput>
{
    const lines = planLines(path);
    collectRetirements();
    try
    {
        for (const line of lines)
        {
            const before = collectedSoFar();
            await runPlanLine(commands, line);
            refuseIdleLine(line, before);
        }
        return [{ kind: "receipt", text: `${plural(recordCollected(), "record")} retired in one append` }];
    }
    finally
    {
        dropCollected();
    }
}

// Every line goes through the contract and the parse gate a typed command goes
// through, so nothing here knows what a decision or a work unit is. The render
// gate is deliberately not called: a line's own receipt would describe a write
// that has not happened yet, and what a reader gets is the one disclosure.
async function runPlanLine(commands: Command[], line: PlanLine): Promise<void>
{
    try
    {
        const resolved = resolvePlanLine(commands, line.argv);
        await resolved.leaf.run(parseCommand(resolved.path, resolved.args,
            resolved.leaf.options, resolved.leaf.positionals, resolved.leaf.requires));
    }
    catch (error)
    {
        throw lineRefusal(line, error);
    }
}

// The root list first and the alias table second, the order a typed command is
// resolved in — an alias verb's `add --supersedes <id>` retires a record like
// any other, so a plan has to reach it. A plugin verb destroys no record, and
// the refusal says which verbs a plan runs rather than claiming the word names
// nothing.
function resolvePlanLine(commands: Command[], argv: string[]): Resolved
{
    const alias = resolveAliasCommand(process.cwd(), argv[0]);
    const resolved = resolveCommand(commands, argv)
        ?? (alias === null ? null : resolveCommand([alias], argv));
    if (resolved === null)
    {
        throw new CliError(`\`self ${argv[0] ?? ""}\` is not a verb a plan runs — `
            + "a plan runs the built-in and alias verbs that destroy a record");
    }
    refuseOutOfSet(resolved);
    return resolved;
}

// Refused before it runs, and that ordering is the whole point. Holding the
// event log shut only stops a verb that writes to the event log; `remote add`
// rewrites the store's git remote, `theme` rewrites its config, `app install`
// writes the plugin registry. Resolving those and refusing them afterwards
// left the change made and the refusal claiming otherwise, so a line is checked
// against the verbs that can reach the retirement gate before it is dispatched.
function refuseOutOfSet(resolved: Resolved): void
{
    if (resolved.command.name === APPLY)
    {
        throw new CliError(NESTED_SET_REFUSAL);
    }
    if (!retires(resolved.leaf))
    {
        throw new CliError(`\`self ${resolved.path}\` destroys no record, and one append covers only the `
            + "calls that do — a plan runs the verbs that retire, retract or supersede a record, and nothing else");
    }
}

// A line whose verb can destroy a record but whose arguments did not — an
// `add` with no `--supersedes`, a `close --as reached` — records something the
// disclosure never states rather than destroying anything, so it has no place
// in a set one append covers. Queuing nothing is what gives it away, which is
// what the check above cannot see: the verb is in the set, the call is not.
function refuseIdleLine(line: PlanLine, before: number): void
{
    if (collectedSoFar() === before)
    {
        throw lineRefusal(line, new CliError("this destroys no record, and one append covers only the calls that do"));
    }
}

// A refused line refuses the file: a set was reviewed, and a set with one line
// silently dropped is not the set that was reviewed.
function lineRefusal(line: PlanLine, error: unknown): CliError
{
    return new CliError([
        `line ${line.number} was refused, and nothing in this file was recorded`,
        `    ${line.text}`,
        `  ${error instanceof Error ? error.message : String(error)}`
    ].join("\n"));
}

function planLines(path: string): PlanLine[]
{
    const lines = readPlan(path).split("\n").flatMap((text, index) => plannedLine(text, index + 1));
    if (lines.length === 0)
    {
        throw new CliError(`${path} names no command — a plan holds one command per line, `
            + "and # starts a note");
    }
    return lines;
}

// A note or a blank stands for nothing to run. The leading `self` is optional
// because a plan is pasted out of a terminal, where it was there.
function plannedLine(text: string, number: number): PlanLine[]
{
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.startsWith("#"))
    {
        return [];
    }
    const argv = words(trimmed, number);
    return [{ number, text: trimmed, argv: argv[0] === "self" ? argv.slice(1) : argv }];
}

function readPlan(path: string): string
{
    try
    {
        return readFileSync(path, "utf8");
    }
    catch (error)
    {
        throw new CliError(`no plan to read at ${path} — a plan is a file of commands, one per line `
            + `(${error instanceof Error ? error.message : String(error)})`);
    }
}

// A written line becomes an argv here, and only here: what the options on it
// mean is still read by the one parse gate.
function words(text: string, number: number): string[]
{
    const state = [...text].reduce<Scan>(scan, { words: [], quote: "", escape: false });
    if (state.quote !== "")
    {
        throw new CliError(`line ${number}: the ${state.quote} quote is never closed`);
    }
    return state.word === undefined ? state.words : [...state.words, state.word];
}

interface Scan
{
    words: string[];
    word?: string;
    quote: string;
    escape: boolean;
}

// One character. Quoting is what a person types at a shell — double or single
// quotes around an argument, and a backslash escaping the next character
// inside double quotes — because the file is written to be pasted from one.
function scan(state: Scan, char: string): Scan
{
    if (state.escape)
    {
        return { ...state, word: (state.word ?? "") + char, escape: false };
    }
    if (char === "\\" && state.quote === "\"")
    {
        return { ...state, escape: true };
    }
    if (char === state.quote)
    {
        return { ...state, quote: "" };
    }
    if (state.quote === "" && (char === "\"" || char === "'"))
    {
        return { ...state, word: state.word ?? "", quote: char };
    }
    if (state.quote !== "" || !/\s/.test(char))
    {
        return { ...state, word: (state.word ?? "") + char };
    }
    return state.word === undefined ? state : { ...state, words: [...state.words, state.word], word: undefined };
}
