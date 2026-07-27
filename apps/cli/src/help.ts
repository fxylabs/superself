// The one place the CLI describes itself. Every verb is named here once, with
// the options it accepts, and the root list, the scoped help, the dispatch
// table, and the proof sweep all read from this array — so a command cannot be
// dispatchable but undocumented, or documented but unreachable.

import { CliError } from "./types.js";

interface UsageLine
{
    syntax: string;
    // Printed beside the syntax in the root list; further lines wrap under it.
    description?: readonly string[];
}

export interface OptionSpec
{
    type: "string" | "boolean";
    multiple?: boolean;
    short?: string;
}

export interface CommandHelp
{
    name: string;
    usage: readonly UsageLine[];
    // The body of the scoped help: what the command does, then its flags.
    detail: readonly string[];
    // The parseArgs spec the command reads its arguments with. It belongs to
    // the registry because help detection has to know which token is a flag's
    // value rather than a request: `--why -h` is a reason, not a question.
    options?: { readonly [name: string]: OptionSpec };
}

// Declared once and read twice: the command that parses with it, and the help
// detection that has to skip the value it consumes.
export const OPTIONS = {
    init: { lang: { type: "string" }, agents: { type: "boolean" } },
    project: { name: { type: "string" }, desc: { type: "string" }, "no-connect": { type: "boolean" } },
    decide: {
        proposed: { type: "boolean" },
        why: { type: "string" },
        supersedes: { type: "string", multiple: true },
        work: { type: "string" }
    },
    work: { on: { type: "string" }, why: { type: "string" } },
    report: {
        evidence: { type: "string", multiple: true },
        artifact: { type: "string", multiple: true },
        next: { type: "string" },
        file: { type: "string" }
    },
    artifact: { work: { type: "string" }, project: { type: "string" } },
    log: { lines: { type: "string", short: "n" } },
    search: { type: { type: "string" }, project: { type: "string" } }
} as const;

export const COMMANDS = [
    {
        name: "init",
        usage: [{ syntax: "init [--lang <code>] [--agents]", description: ["initialize the current directory as a workspace"] }],
        detail: [
            "create the workspace store this machine records project state in, and",
            "point this machine at it.",
            "",
            "  --lang <code>   language of the HTML views, as a BCP 47 code (en, ko, ja)",
            "  --agents        tell this machine's agents about self without asking"
        ],
        options: OPTIONS.init
    },
    {
        name: "workspace",
        usage: [{ syntax: "workspace [<path>]", description: ["show or set the workspace this machine uses"] }],
        detail: [
            "with no path, print the workspace this machine resolves to; with a path,",
            "point this machine at an existing workspace store."
        ]
    },
    {
        name: "lang",
        usage: [{ syntax: "lang [<code>]", description: ["show or set the language of the HTML views"] }],
        detail: [
            "with no code, print the current language; with a BCP 47 code, set it and",
            "re-render every project view."
        ]
    },
    {
        name: "theme",
        usage: [{ syntax: "theme [<name>]", description: ["show or set the viewer accent theme (violet, cyan, orange, mono)"] }],
        detail: [
            "with no name, print the current accent; with a name, set it and re-render",
            "every project view."
        ]
    },
    {
        name: "project",
        usage: [
            {
                syntax: "project add [path] [--name s] [--desc d] [--no-connect]",
                description: ["register a project and render its agent block"]
            },
            { syntax: "project link [slug] [path]", description: ["link this checkout of a registered project on this machine"] }
        ],
        detail: [
            "register a project with the workspace, or link another checkout of an",
            "already registered one. `link` with no slug infers it from the repository.",
            "",
            "  --name <slug>   register under this slug instead of the directory name",
            "  --desc <text>   one-line description shown in the workspace view",
            "  --no-connect    skip writing the managed block into AGENTS.md and CLAUDE.md"
        ],
        options: OPTIONS.project
    },
    {
        name: "remote",
        usage: [{ syntax: "remote add <url>", description: ["connect the workspace store to a git remote"] }],
        detail: ["set the git remote that `self sync` pushes the workspace store to."]
    },
    {
        name: "sync",
        usage: [{ syntax: "sync", description: ["pull, refold, and push the workspace store"] }],
        detail: ["commit pending state, rebase on the remote, re-derive canonical files, and push."]
    },
    {
        name: "clone",
        usage: [{ syntax: "clone <url> [dir]", description: ["clone a workspace store onto a new machine"] }],
        detail: ["clone an existing workspace store and point this machine at it."]
    },
    {
        name: "goal",
        usage: [{ syntax: 'goal set "<text>"', description: ["set the project goal"] }],
        detail: ["record the outcome this project exists to reach. The latest one wins."]
    },
    {
        name: "decide",
        usage: [
            { syntax: 'decide "<text>" [--why w] [--proposed] [--supersedes id] [--work id]' },
            { syntax: "decide confirm <event-id>", description: ["confirm a proposed decision"] }
        ],
        detail: [
            "record one decision. Confirmed by default: use --proposed for a decision",
            "the user has not agreed to yet, and `decide confirm` when they do.",
            "",
            "  --why <text>        the reason the decision was made",
            "  --proposed          record as a proposal, which never displaces a confirmed decision",
            "  --supersedes <id>   retire an earlier decision, repeatable",
            "  --work <work-id>    attach the decision to a work unit"
        ],
        options: OPTIONS.decide
    },
    {
        name: "work",
        usage: [
            { syntax: "work", description: ["list open work"] },
            { syntax: 'work add "<required outcome>"', description: ["create a work unit"] },
            { syntax: "work show <id>", description: ["print full work detail: brief, reports, evidence"] },
            {
                syntax: "work start|block|unblock|done <id>",
                description: ["move a work unit (block: --on decision|dependency|external [--why w])"]
            }
        ],
        detail: [
            "create and move units of work. `work add` prints the new id.",
            "",
            "  --on <reason>   what a blocked unit waits on: decision, dependency, or external",
            "  --why <text>    detail recorded with the block"
        ],
        options: OPTIONS.work
    },
    {
        name: "report",
        usage: [{ syntax: 'report <work-id> "<summary>" [--file path] [--evidence c] [--artifact path] [--next n]' }],
        detail: [
            "attach a report to a work unit. The current HEAD commit is recorded as",
            "evidence unless --evidence names other commits.",
            "",
            "  --file <path>       read the summary from a file instead of the argument",
            "  --evidence <hash>   record this commit as evidence, repeatable",
            "  --artifact <path>   copy a file into the store and attach it, repeatable",
            "  --next <text>       what the next session should pick up"
        ],
        options: OPTIONS.report
    },
    {
        name: "artifact",
        usage: [
            { syntax: "artifact list [--work id] [--project slug]", description: ["list artifacts from the derived registry"] },
            { syntax: "artifact search <query> | open <id>", description: ["find an artifact or open it with the OS default app"] }
        ],
        detail: [
            "browse the files reports have attached. Artifacts are ingested by",
            "`self report --artifact`, never registered on their own.",
            "",
            "  --work <work-id>    only artifacts attached to this work unit",
            "  --project <slug>    only artifacts of this project, instead of the current one"
        ],
        options: OPTIONS.artifact
    },
    {
        name: "convention",
        usage: [{ syntax: 'convention add "<text>" | drop <event-id>', description: ["record or retire a convention"] }],
        detail: ["record a rule this project works by, or retire one by its event id."]
    },
    {
        name: "connect",
        usage: [
            {
                syntax: "connect [--global]",
                description: [
                    "render the agent-onboarding block into AGENTS.md and CLAUDE.md",
                    "(--global: into this machine's agent instruction files)"
                ]
            }
        ],
        detail: [
            "write the managed block that tells any agent tool how this project",
            "records its state.",
            "",
            "  --global   write into this machine's agent instruction files instead"
        ]
    },
    {
        name: "view",
        usage: [{ syntax: "view [slug]", description: ["open the live workspace or project view in the browser"] }],
        detail: ["open the HTML view the last fold rendered: the workspace, or one project."]
    },
    {
        name: "context",
        usage: [{ syntax: "context", description: ["print derived context for agents"] }],
        detail: ["print this project's current truth: goal, active decisions, open work, recent reports."]
    },
    {
        name: "status",
        usage: [{ syntax: "status", description: ["print a short state summary"] }],
        detail: ["print what waits on you, what is moving, and any health signals."]
    },
    {
        name: "setup",
        usage: [{ syntax: "setup", description: ["print the workspace, project, and store this directory resolves to"] }],
        detail: ["explain how this directory resolves, and what to run when it resolves to nothing."]
    },
    {
        name: "log",
        usage: [{ syntax: "log [-n N]", description: ["print recent events"] }],
        detail: [
            "print the project's event log, newest last.",
            "",
            "  -n <count>   how many events to print (default 20)"
        ],
        options: OPTIONS.log
    },
    {
        name: "search",
        usage: [{ syntax: "search <query> [--type t] [--project p]", description: ["grep state across the workspace"] }],
        detail: [
            "search events across every registered project.",
            "",
            "  --type <type>       only events of this type, such as decision.confirmed",
            "  --project <slug>    only this project"
        ],
        options: OPTIONS.search
    },
    {
        name: "fold",
        usage: [{ syntax: "fold", description: ["re-derive canonical files from the log"] }],
        detail: ["rebuild state files, work briefs, and HTML views from the event log."]
    },
    {
        name: "help",
        usage: [{ syntax: "help [<command>]", description: ["print this list, or one command's syntax and flags"] }],
        detail: [
            "print the verb list, or the syntax of one command. `self <command> --help`",
            "says the same thing. Help reads no state and writes none, so it answers in",
            "any directory."
        ]
    }
] as const satisfies readonly CommandHelp[];

export type CommandName = (typeof COMMANDS)[number]["name"];

export function findCommand(name: string | undefined): CommandHelp | undefined
{
    return COMMANDS.find((command) => command.name === name);
}

// Where the description column starts in the root list.
const COLUMN = 46;

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

export function rootUsage(): string
{
    return ["usage: self <command>", ""].concat(COMMANDS.flatMap((command) => command.usage.flatMap(listLines))).join("\n");
}

export function commandUsage(command: CommandHelp): string
{
    const header = command.usage.map((line, index) => (index === 0 ? "usage: self " : "       self ") + line.syntax);
    return header.concat("", ...command.detail).join("\n");
}

// Help is resolved before any command runs, so asking for it needs no
// workspace, records no event, and always exits successfully. Returns the text
// to print, or null when the invocation is not a request for help.
export function helpRequest(argv: string[]): string | null
{
    if (argv.length === 0)
    {
        return rootUsage();
    }
    if (argv[0] === "help")
    {
        return scopedHelp(argv[1]);
    }
    const command = findCommand(argv[0]);
    // An unknown verb is a mistake, not a question — even with --help on it.
    // Leaving it here lets dispatch name it and exit non-zero.
    if (command === undefined)
    {
        return isHelpSwitch(argv[0]) ? rootUsage() : null;
    }
    return asksForHelp(argv.slice(1), command) ? commandUsage(command) : null;
}

function scopedHelp(name: string | undefined): string
{
    if (name === undefined)
    {
        return rootUsage();
    }
    // `self help --help` is a question about `help` itself, the one command
    // whose name and help switch mean the same thing.
    const command = findCommand(isHelpSwitch(name) ? "help" : name);
    if (command === undefined)
    {
        throw new CliError(`unknown command "${name}" — run \`self help\` for the command list`);
    }
    return commandUsage(command);
}

function isHelpSwitch(arg: string): boolean
{
    return arg === "--help" || arg === "-h";
}

// A help switch is only a request where a flag could stand. The token after an
// option that takes a value is that value — `--why -h` records the reason "-h"
// — and after `--` every token is text the user meant literally.
function asksForHelp(args: string[], command: CommandHelp): boolean
{
    const valueFlags = valueTaking(command);
    for (let index = 0; index < args.length; index += 1)
    {
        const arg = args[index];
        if (arg === "--")
        {
            return false;
        }
        if (isHelpSwitch(arg))
        {
            return true;
        }
        if (valueFlags.has(arg))
        {
            index += 1;
        }
    }
    return false;
}

function valueTaking(command: CommandHelp): Set<string>
{
    const flags = new Set<string>();
    for (const [name, spec] of Object.entries(command.options ?? {}))
    {
        if (spec.type !== "string")
        {
            continue;
        }
        flags.add(`--${name}`);
        if (spec.short !== undefined)
        {
            flags.add(`-${spec.short}`);
        }
    }
    return flags;
}
