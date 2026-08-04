// The one description of what the CLI can be asked to do. A command leaf
// carries its name, the options and positionals it accepts, and the handler
// that runs it, in one declaration; the usage lines that render it name the
// leaves they document. Dispatch, argument parsing, `self --help`, and the
// test-tier enumeration all read this, so a command cannot be documented
// without being dispatchable, dispatchable without being documented, or given
// an option contract nothing can reach.
//
// The declarations live with the handlers they bind, in the module that owns
// them; the root list is composed in `main.ts`, the dispatcher. This module
// holds the shapes, the resolution, and the checks — never a command body.

import { OptionSpec, OptionSpecs, ParsedArguments, Requirement, subcommand } from "./args.js";
import { CliError } from "./types.js";

/* ── shapes ────────────────────────────────────────────────────────── */

// What node's parser gives back for one declared option set. Mirroring it here
// is what lets a handler read `values.why` as a string without a cast.
type OptionValue<S> = S extends { multiple: true }
    ? (S extends { type: "boolean" } ? boolean[] : string[])
    : (S extends { type: "boolean" } ? boolean : string);

export type ParsedOptions<T extends OptionSpecs> = { -readonly [K in keyof T]?: OptionValue<T[K]> };

export interface CommandInput<T extends OptionSpecs = OptionSpecs>
{
    values: ParsedOptions<T>;
    positionals: string[];
}

// What the dispatcher hands a leaf once the declared option set is no longer in
// the type. `leaf` is the only place the two shapes meet.
export type ParsedInput = ParsedArguments;

export type CommandRun = (input: ParsedInput) => void | Promise<void>;

export interface CommandLeaf
{
    kind: "leaf";
    // Empty for the form a command takes when no verb is named.
    name: string;
    options: OptionSpecs;
    positionals: number;
    // Options deliberately absent from every help page: compatibility refusals
    // that only exist to name where a flag moved. The help checks skip these.
    undocumented: string[];
    // What the verb cannot run without. The parse gate refuses all of them in
    // one pass and the help page states them, both from this one declaration.
    requires: Requirement[];
    run: CommandRun;
}

// What a leaf declares beyond its options and positionals. Both fields are
// rare enough that a verb states them by name rather than by position.
export interface LeafExtras
{
    undocumented?: string[];
    requires?: Requirement[];
}

// How a first token that names no child is read.
//   refuse   every form of this command names its verb
//   text     the command's first argument is free text, so anything unmatched
//            belongs to the unnamed form — `self decide "<text>"`
//   options  only a leading long flag, or nothing at all, falls through to the
//            unnamed form; a word is still a verb, and `--` or a short flag is
//            still explained by `subcommand` — `self work --project x` against
//            `self work add`
export type Unnamed = "refuse" | "text" | "options";

export type Refusal = string | ((verb: string | undefined) => string);

export interface CommandBranch
{
    kind: "branch";
    name: string;
    children: CommandNode[];
    unnamed: Unnamed;
    // What an absent or unrecognized verb is refused with.
    refusal: Refusal;
}

export type CommandNode = CommandLeaf | CommandBranch;

// One line of a command's syntax, and the verbs it documents. A line that
// documents several verbs at once — `work start|block|unblock|done <id>` —
// names all of them, so every leaf stays accounted for.
export interface UsageLine
{
    syntax: string;
    description?: string[];
    verbs: string[];
}

export interface Command
{
    name: string;
    usage: UsageLine[];
    // The body of the scoped help: what the command does, then its flags.
    detail: string[];
    node: CommandNode;
    // A refusal the whole command owes before any verb is chosen.
    guard?: (args: string[]) => void;
}

/* ── declaration ───────────────────────────────────────────────────── */

export function leaf<const T extends OptionSpecs>(
    name: string,
    options: T,
    positionals: number,
    run: (input: CommandInput<T>) => void | Promise<void>,
    extras: LeafExtras = {}
): CommandLeaf
{
    // The one place the declared option set is erased. Everything downstream
    // parses with `options`, so what a handler reads is what was declared.
    return {
        kind: "leaf",
        name,
        options,
        positionals,
        undocumented: extras.undocumented ?? [],
        requires: extras.requires ?? [],
        run: run as unknown as CommandRun
    };
}

export function branch(spec: Omit<CommandBranch, "kind">): CommandBranch
{
    return { kind: "branch", ...spec };
}

/* ── resolution ────────────────────────────────────────────────────── */

export interface Resolved
{
    command: Command;
    leaf: CommandLeaf;
    args: string[];
    // What the walk named, verb included: the refusals a leaf owes say
    // `self work propose`, while the help they point at is the command's.
    path: string;
}

export function findCommandByName(commands: Command[], name: string | undefined): Command | undefined
{
    return name === undefined ? undefined : commands.find((command) => command.name === name);
}

// Which leaf an invocation names, and what is left for its parser. Returns null
// for a verb no command owns, which the dispatcher answers on its own.
export function resolveCommand(commands: Command[], argv: string[]): Resolved | null
{
    const command = findCommandByName(commands, argv[0]);
    if (command === undefined)
    {
        return null;
    }
    const rest = argv.slice(1);
    command.guard?.(rest);
    return { command, ...descend(command.node, command.name, rest) };
}

// The leaf a walk lands on, or nothing when the walk refuses. The reachability
// check asks the question before a refusal is due: whether a declared leaf can
// be reached at all, not what an actual invocation is answered with.
function reachedLeaf(command: Command, args: string[]): CommandLeaf | null
{
    try
    {
        return descend(command.node, command.name, args).leaf;
    }
    catch
    {
        return null;
    }
}

function descend(node: CommandNode, path: string, args: string[]): { leaf: CommandLeaf; args: string[]; path: string }
{
    if (node.kind === "leaf")
    {
        return { leaf: node, args, path };
    }
    const chosen = select(node, path, args);
    return descend(chosen.node, chosen.name === "" ? path : `${path} ${chosen.name}`, chosen.args);
}

function select(node: CommandBranch, path: string, args: string[]): { node: CommandNode; name: string; args: string[] }
{
    const unnamed = node.children.find((child) => child.name === "");
    if (unnamed !== undefined && takesUnnamed(node, args[0]))
    {
        return { node: unnamed, name: "", args };
    }
    const verb = subcommand(path, args);
    const child = node.children.find((item) => item.name !== "" && item.name === verb);
    if (child === undefined)
    {
        throw new CliError(typeof node.refusal === "string" ? node.refusal : node.refusal(verb));
    }
    return { node: child, name: child.name, args: args.slice(1) };
}

function takesUnnamed(node: CommandBranch, first: string | undefined): boolean
{
    if (node.unnamed === "refuse")
    {
        return false;
    }
    if (node.unnamed === "text")
    {
        return first === undefined || !node.children.some((child) => child.name === first);
    }
    return first === undefined || (first !== "--" && first.startsWith("--"));
}

/* ── the read-only consumer surface ────────────────────────────────── */

export interface DescribedOption
{
    name: string;
    type: "string" | "boolean";
    multiple: boolean;
    short?: string;
}

// One dispatchable command, joined to the line that documents it. This is what
// the enumeration and a future reference-documentation generator read; it
// carries no handler, so nothing downstream of it can run a command by
// describing one.
export interface CommandDescription
{
    root: string;
    // The verb below the root; empty for the unnamed form.
    verb: string;
    path: string;
    syntax: string;
    summary: string[];
    options: DescribedOption[];
    positionals: number;
}

export function describeCommands(commands: Command[]): CommandDescription[]
{
    return commands.flatMap((command) => commandLeaves(command).map((entry) =>
    {
        const line = command.usage.find((usage) => usage.verbs.includes(entry.verb));
        return {
            root: command.name,
            verb: entry.verb,
            path: entry.verb === "" ? command.name : `${command.name} ${entry.verb}`,
            syntax: line?.syntax ?? "",
            summary: line?.description ?? [],
            options: describeOptions(entry.leaf.options),
            positionals: entry.leaf.positionals
        };
    }));
}

function describeOptions(options: OptionSpecs): DescribedOption[]
{
    return Object.entries(options).map(([name, spec]) => ({
        name,
        type: spec.type,
        multiple: spec.multiple === true,
        short: spec.short
    }));
}

export interface CommandLeafEntry
{
    verb: string;
    leaf: CommandLeaf;
}

export function commandLeaves(command: Command): CommandLeafEntry[]
{
    return collectLeaves(command.node, []);
}

function collectLeaves(node: CommandNode, names: string[]): CommandLeafEntry[]
{
    if (node.kind === "leaf")
    {
        return [{ verb: names.join(" "), leaf: node }];
    }
    return node.children.flatMap((child) =>
        collectLeaves(child, child.name === "" ? names : [...names, child.name]));
}

/* ── the checks ────────────────────────────────────────────────────── */

// What makes the contract one contract rather than four that agree today. A
// usage line naming nothing is a help-only command; a leaf no line names is a
// dispatch-only command; a leaf the resolver cannot reach is an option contract
// nothing can parse against; a flag on one side and not the other is a page and
// a parser that disagree. All of them are answered here, over the declaration
// itself, so the test tier can fail on them.
export function checkContract(commands: Command[]): string[]
{
    const problems: string[] = [];
    for (const [index, command] of commands.entries())
    {
        if (commands.findIndex((item) => item.name === command.name) !== index)
        {
            problems.push(`"${command.name}" is declared twice in the root list`);
        }
        problems.push(...checkCommand(command), ...checkRequirements(commands, command));
    }
    return problems;
}

function checkCommand(command: Command): string[]
{
    const leaves = commandLeaves(command);
    const documented = command.usage.flatMap((line) => line.verbs);
    return [
        ...checkNode(command.node, command.name),
        ...checkCoverage(command, leaves, documented),
        ...checkReachable(command, leaves),
        ...checkFlags(command, leaves)
    ];
}

/* ── what a verb cannot run without ────────────────────────────────── */

// A requirement is refused by the parse gate and rendered by the help page, so
// a flag it names that the leaf never declared would refuse a call nothing can
// satisfy, and an unblocking path naming a verb that does not exist would send
// the reader somewhere the CLI answers with "unknown". Only a parsed leaf can
// carry requirements at all — `RawLeaf` has no field for them, so the type
// refuses what would otherwise be a declaration nothing enforces.
function checkRequirements(commands: Command[], command: Command): string[]
{
    return requirementsOf(command).flatMap(({ verb, requirement }) =>
    {
        const at = `${command.name}: "${label(command, verb)}"`;
        if (requirement.flags.length === 0)
        {
            return [`${at} declares a requirement naming no flag`];
        }
        return [
            ...requirement.flags.flatMap((flag) => checkRequiredFlag(at, flag, optionsOf(command, verb)[flag])),
            ...unblockPaths(requirement.unblock).filter((path) => !dispatchable(commands, path))
                .map((path) => `${at} points at \`self ${path}\`, which no command dispatches`)
        ];
    });
}

function checkRequiredFlag(at: string, flag: string, spec: OptionSpec | undefined): string[]
{
    if (spec === undefined)
    {
        return [`${at} requires --${flag}, which it does not declare as an option`];
    }
    // A boolean is absent or true, and a caller cannot state the true one is
    // meant: demanding it would refuse every call that left it off by choice.
    return spec.type === "boolean" ? [`${at} requires --${flag}, a boolean — a flag with no value states nothing`] : [];
}

interface DeclaredRequirement
{
    verb: string;
    requirement: Requirement;
}

function requirementsOf(command: Command): DeclaredRequirement[]
{
    return commandLeaves(command).flatMap((entry) =>
        entry.leaf.requires.map((requirement) => ({ verb: entry.verb, requirement })));
}

function optionsOf(command: Command, verb: string): OptionSpecs
{
    return commandLeaves(command).find((entry) => entry.verb === verb)?.leaf.options ?? {};
}

// The command paths an unblocking hint names, read out of the text it is
// written in: `self objective add "<outcome>" --proposed` names `objective add`
// and stops where the arguments start.
function unblockPaths(unblock: string | undefined): string[]
{
    return unblock === undefined ? []
        : [...unblock.matchAll(/\bself ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)*)/g)].map((found) => found[1]);
}

function dispatchable(commands: Command[], path: string): boolean
{
    const words = path.split(" ");
    const command = findCommandByName(commands, words[0]);
    return command !== undefined && reachedLeaf(command, words.slice(1)) !== null;
}

function checkCoverage(command: Command, leaves: CommandLeafEntry[], documented: string[]): string[]
{
    const problems: string[] = [];
    for (const verb of documented)
    {
        if (!leaves.some((entry) => entry.verb === verb))
        {
            problems.push(`${command.name}: a usage line documents "${label(command, verb)}", which no command dispatches`);
        }
    }
    for (const entry of leaves)
    {
        const lines = documented.filter((verb) => verb === entry.verb).length;
        if (lines !== 1)
        {
            problems.push(`${command.name}: "${label(command, entry.verb)}" is dispatched and ${lines === 0
                ? "no usage line documents it" : `${lines} usage lines document it`}`);
        }
    }
    return problems;
}

// Every declared leaf is walked to from the root exactly as an invocation would
// be. A leaf a sibling shadows, or one behind a fallback that never fires, has
// an option contract the parser can never be handed.
function checkReachable(command: Command, leaves: CommandLeafEntry[]): string[]
{
    const problems: string[] = [];
    for (const entry of leaves)
    {
        const argv = entry.verb === "" ? [] : entry.verb.split(" ");
        if (reachedLeaf(command, argv) !== entry.leaf)
        {
            problems.push(`${command.name}: "${label(command, entry.verb)}" declares an option contract nothing can reach`);
        }
    }
    return problems;
}

/* ── the page and the parser are one statement ─────────────────────── */

interface Flags
{
    long: Set<string>;
    short: Set<string>;
}

// `--help` and `-h` are answered before any command is resolved, so no leaf
// declares them and a page may name them freely. Every other flag a page names
// has to belong to a leaf under it.
const HELP_LONG = "help";
const HELP_SHORT = "h";

// The flags a human page names, read out of the text it is written in. Long and
// short spellings are kept apart because a command declares them separately:
// `log` documents `-n` and declares `lines` with `short: "n"`, and neither
// spelling stands for the other.
function flagsIn(lines: string[]): Flags
{
    const text = lines.join("\n");
    const long = new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((found) => found[1]));
    const short = new Set([...text.matchAll(/(?<![\w-])-([a-z])(?![\w-])/g)].map((found) => found[1]));
    long.delete(HELP_LONG);
    short.delete(HELP_SHORT);
    return { long, short };
}

function declaredFlags(leaves: CommandLeafEntry[]): Flags
{
    const flags: Flags = { long: new Set(), short: new Set() };
    for (const entry of leaves)
    {
        for (const [name, spec] of Object.entries(entry.leaf.options))
        {
            flags.long.add(name);
            if (spec.short !== undefined)
            {
                flags.short.add(spec.short);
            }
        }
    }
    return flags;
}

// A scoped page and the leaves under it are one statement about what a command
// accepts, checked in both directions: a page naming a flag no leaf declares
// sends the reader into an unknown-option refusal, and a leaf whose flag no page
// names is a flag only the source reveals. The unit is the leaf rather than the
// command, because a page documents each verb on its own line — a flag in one
// verb's line says nothing about the next verb — while the page's flag list is
// written once and so counts for every leaf under it.
function checkFlags(command: Command, leaves: CommandLeafEntry[]): string[]
{
    return [...checkAdvertised(command, leaves), ...checkDeclared(command, leaves)];
}

function checkAdvertised(command: Command, leaves: CommandLeafEntry[]): string[]
{
    const problems = command.usage.flatMap((line) =>
        undeclared(flagsIn(usageText(line)), leaves.filter((entry) => line.verbs.includes(entry.verb)))
            .map((flag) => `${command.name}: the usage line "${line.syntax}" names ${flag}, which no verb it documents accepts`));
    return problems.concat(undeclared(flagsIn(glossary(command.detail)), leaves)
        .map((flag) => `${command.name}: its flag list names ${flag}, which no verb of it accepts`));
}

function usageText(line: UsageLine): string[]
{
    return [line.syntax, ...(line.description ?? [])];
}

// A `detail` is prose and then a flag list, and only the list states what the
// command accepts. A sentence may point at another command's flag — `artifact`
// explains that `self report --artifact` is what ingests one — so reading prose
// as a declaration would refuse a page for being helpful.
function glossary(detail: string[]): string[]
{
    return detail.filter((line) => /^ {2}-/.test(line));
}

function undeclared(named: Flags, leaves: CommandLeafEntry[]): string[]
{
    const declared = declaredFlags(leaves);
    return [
        ...[...named.long].filter((flag) => !declared.long.has(flag)).map((flag) => `--${flag}`),
        ...[...named.short].filter((flag) => !declared.short.has(flag)).map((flag) => `-${flag}`)
    ];
}

function checkDeclared(command: Command, leaves: CommandLeafEntry[]): string[]
{
    const listed = flagsIn(glossary(command.detail));
    return leaves.flatMap((entry) =>
    {
        const shown = flagsIn(command.usage.filter((line) => line.verbs.includes(entry.verb)).flatMap(usageText));
        return Object.entries(entry.leaf.options)
            .filter(([name]) => !entry.leaf.undocumented.includes(name))
            .filter(([name, spec]) => !advertises(shown, name, spec) && !advertises(listed, name, spec))
            .map(([name]) => `${command.name}: "${label(command, entry.verb)}" accepts --${name}, and no help line for it says so`);
    });
}

function advertises(flags: Flags, name: string, spec: OptionSpec): boolean
{
    return flags.long.has(name) || (spec.short !== undefined && flags.short.has(spec.short));
}

function checkNode(node: CommandNode, path: string): string[]
{
    if (node.kind === "leaf")
    {
        return node.positionals < 0 ? [`${path}: accepts a negative number of positionals`] : [];
    }
    return [...checkBranch(node, path), ...node.children.flatMap((child) =>
        checkNode(child, child.name === "" ? path : `${path} ${child.name}`))];
}

function checkBranch(node: CommandBranch, path: string): string[]
{
    const problems: string[] = [];
    const unnamed = node.children.filter((child) => child.name === "").length;
    if (node.unnamed === "refuse" ? unnamed !== 0 : unnamed !== 1)
    {
        problems.push(`${path}: unnamed "${node.unnamed}" wants ${node.unnamed === "refuse" ? "no" : "one"} unnamed child, and has ${unnamed}`);
    }
    for (const [index, child] of node.children.entries())
    {
        if (node.children.findIndex((item) => item.name === child.name) !== index)
        {
            problems.push(`${path}: "${child.name}" is declared twice`);
        }
        if (child.name.startsWith("-"))
        {
            problems.push(`${path}: "${child.name}" reads as an option, so nothing can name it`);
        }
    }
    return problems;
}

function label(command: Command, verb: string): string
{
    return verb === "" ? command.name : `${command.name} ${verb}`;
}
