import { readFileSync } from "node:fs";

// The one place the CLI describes itself. `self` with no arguments prints the
// whole verb list; `self <command> --help` prints that command's syntax and
// flags. Both are rendered from the same entries, so a command can never be
// documented in one place and missing from the other.
//
// The version belongs here for the same reason: what the binary answers about
// itself is one surface, and a per-command special case would be a second one.

interface UsageLine
{
    syntax: string;
    // Rendered beside the syntax in the verb list; further lines wrap under it.
    description?: string[];
}

export interface CommandHelp
{
    name: string;
    usage: UsageLine[];
    // The body of the scoped help: what the command does, then its flags.
    detail: string[];
}

export const COMMANDS: CommandHelp[] = [
    {
        name: "init",
        usage: [{ syntax: "init [--lang <code>] [--agents]", description: ["initialize the current directory as a workspace"] }],
        detail: [
            "create the workspace store this machine records project state in, and",
            "point this machine at it.",
            "",
            "  --lang <code>   language of the HTML views, as a BCP 47 code (en, ko, ja)",
            "  --agents        tell this machine's agents about self without asking"
        ]
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
        name: "timezone",
        usage: [{ syntax: "timezone [<zone>]", description: ["show or set the zone every target date is judged in"] }],
        detail: [
            "with no zone, print the current zone; with an IANA zone name such as",
            "Asia/Seoul, set it and re-render every project view."
        ]
    },
    {
        name: "project",
        usage: [
            {
                syntax: "project add [path] [--name s] [--desc d] [--no-connect]",
                description: ["register a project and render its agent block"]
            },
            { syntax: "project link [slug] [path]", description: ["attach a registered project's directory on this machine"] }
        ],
        detail: [
            "register a project with the workspace, or attach one registered on another",
            "machine. Every checkout of a registered git repository — worktrees",
            "included — resolves on its own; `link` with no slug infers it from the",
            "repository and only saves the probe.",
            "",
            "  --name <slug>   register under this slug instead of the directory name",
            "  --desc <text>   one-line description shown in the workspace view",
            "  --no-connect    skip writing the managed block into AGENTS.md and CLAUDE.md"
        ]
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
        usage: [{ syntax: 'goal set "<text>"', description: ["set the long-term project goal"] }],
        detail: ["record the outcome this project exists to reach. The latest one wins."]
    },
    {
        name: "objective",
        usage: [
            {
                syntax: "objective [--project <slug>] [--workspace]",
                description: [
                    "list objectives and their milestones",
                    "(--project reads another project, --workspace every registered one)"
                ]
            },
            {
                syntax: 'objective add "<outcome>" [--horizon week|month|quarter|year] [--target d]',
                description: ["create a time-boxed objective under the goal"]
            },
            {
                syntax: "objective show <id> [--project <slug>] | confirm <id>",
                description: ["print an objective, or confirm a proposed one"]
            },
            {
                syntax: "objective decline <id> --why w",
                description: ["turn down a proposed objective; it leaves waiting at once"]
            },
            {
                syntax: "objective revise <id> --why w [--outcome t] [--target d] [--success s] [--stop s]",
                description: ["an empty --target/--horizon/--priority withdraws that field"]
            },
            { syntax: "objective close <id> --as reached|dropped [--why w]", description: ["--why is required when it is dropped"] }
        ],
        detail: [
            "keep the time-boxed objectives that break the goal down, each with the",
            "reason for its state. Progress is never a percentage.",
            "",
            "list and show read: without a scope flag they answer for the project this",
            "directory belongs to. add, confirm, revise and close write, so they take no",
            "scope flag at all and record into the project they run in.",
            "",
            "  --project <slug>      read this registered project instead of this directory's",
            "  --workspace           list every registered project's objectives (list only)",
            "  --horizon <span>      week, month, quarter, or year",
            "  --target <date>       the date the outcome is judged on",
            "  --success <text>      what reached looks like",
            "  --stop <text>         the condition that ends it early",
            "  --priority <n>        smaller sorts first",
            "  --proposed            record as a proposal the user has not confirmed",
            "  --supersedes <id>     retire an earlier objective",
            "  --as <state>          how `close` ends it: reached or dropped",
            "  --why <text>          the reason for a revision or a decline, and for a close that drops"
        ]
    },
    {
        name: "milestone",
        usage: [
            {
                syntax: "milestone [--project <slug>]",
                description: ["list milestones with state, reason, and linked work"]
            },
            { syntax: 'milestone add "<outcome>" --objective <id> --exit "<criterion>" [--target d] [--after m] [--supersedes m]' },
            {
                syntax: "milestone show <id> [--project <slug>]",
                description: ["print a milestone, its exit criteria, and its coverage"]
            },
            { syntax: "milestone revise <id> --why w [--outcome t] [--target d] [--exit e] [--drop-exit c1]" },
            {
                syntax: 'milestone drop <id> --why "<reason>"',
                description: ["give up on a checkpoint with nothing replacing it"]
            },
            { syntax: "milestone met <id> --criterion c1 --why w [--work id] [--evidence c]" },
            { syntax: "milestone reach <id>", description: ["record a milestone as reached once every criterion is covered"] },
            {
                syntax: "milestone recheck <id> [--criterion c1] --why w",
                description: ["re-judge coverage, or a reach, a revision left stale"]
            }
        ],
        detail: [
            "keep the checkpoints under an objective. A milestone is reached only when",
            "every exit criterion is covered by evidence — finishing work never",
            "reaches one on its own.",
            "",
            "list and show read and take --project; every other verb writes into the",
            "project it runs in. There is no --workspace form: a milestone hangs under",
            "an objective, so `self objective --workspace` is the workspace-wide roll-up.",
            "",
            "  --project <slug>      read this registered project instead of this directory's",
            "  --objective <id>      the objective the milestone belongs to",
            "  --exit <criterion>    an exit criterion, repeatable",
            "  --target <date>       the date the checkpoint is judged on",
            "  --after <id>          order it after another milestone",
            "  --criterion <c>       the criterion `met` or `recheck` speaks about",
            "  --work <id>           the work unit whose evidence covers it",
            "  --evidence <hash>     a commit recorded with the coverage",
            "  --why <text>          how the evidence covers it, what was re-judged, or why it was dropped"
        ]
    },
    {
        name: "decide",
        usage: [
            { syntax: 'decide "<text>" [--why w] [--proposed] [--supersedes id] [--work id] [--blocks id] [--after id]' },
            { syntax: "decide confirm <event-id>", description: ["confirm a proposed decision"] },
            {
                syntax: 'decide decline <event-id> --why "<reason>"',
                description: ["turn down a proposal; it leaves \"waiting on you\" at once"]
            },
            {
                syntax: 'decide retract <event-id> --why "<reason>"',
                description: [
                    "take back a confirmed decision with nothing replacing it",
                    "it stops rendering as current and stays inspectable in search"
                ]
            }
        ],
        detail: [
            "record one decision. Confirmed by default: use --proposed for a decision",
            "the user has not agreed to yet, and `decide confirm` when they do.",
            "",
            "  --why <text>          the reason the decision was made, or the reason it was withdrawn",
            "  --proposed            record as a proposal, which never displaces a confirmed decision",
            "  --supersedes <id>     retire an earlier decision, repeatable",
            "  --work <work-id>      attach the decision to a work unit",
            "  --blocks <work-id>    the work confirming it would unblock, repeatable",
            "  --after <event-id>    the event it cannot be decided before",
            "",
            "--blocks is what ranks a proposal: `self context` and `self status` say",
            "whether confirming it unblocks work, cannot be decided yet, or only",
            "records a rule the gated work already landed under.",
            "",
            "--supersedes replaces a decision, `retract` withdraws one with nothing in",
            "its place, and `decline` answers a proposal. None of the three rewrites",
            "history: the record keeps its text and gains a status."
        ]
    },
    {
        name: "work",
        usage: [
            {
                syntax: "work [--project <slug>] [--pretty|--plain]",
                description: ["list open work, from any directory with --project", "(a terminal gets the ruled table; a pipe gets one line per unit)"]
            },
            { syntax: 'work add "<required outcome>"', description: ["create a work unit"] },
            {
                syntax: "work show <id> [--project <slug>]",
                description: ["print full work detail: brief, reports, evidence", "(resolves the owning project from any directory)"]
            },
            {
                syntax: "work start|block|unblock|done <id>",
                description: ["move a work unit (block: --on decision|dependency|external [--why w])"]
            },
            {
                syntax: "work link|unlink <id> --objective o | --milestone m",
                description: ["state, or withdraw, what a work unit contributes to"]
            },
            { syntax: 'work propose "<outcome>" --milestone m --value v --success s --stop s --risk r' },
            { syntax: "work accept|decline <proposal-id> [--why w]", description: ["act on a goal-gap proposal; decline states why"] },
            {
                syntax: "work retire <id> --why w [--successor <work-id>] [--successor-project <slug>]",
                description: [
                    "retire the unit itself: its outcome was given up or moved, not reached",
                    "history stays inspectable; the unit stops counting as open work"
                ]
            }
        ],
        detail: [
            "create and move units of work, and state what each contributes to.",
            "`work add` prints the new id.",
            "",
            "done is the judgment that the outcome was reached; the evidence for it",
            "lives in the unit's reports.",
            "",
            "  --project <slug>      list or show against this project, from any directory",
            "  --on <reason>         what a blocked unit waits on: decision, dependency, or external",
            "  --why <text>          detail recorded with the block, a revision, or the done",
            "  --successor <id>      the unit that carries a retired outcome now, resolved workspace-wide",
            "  --successor-project <slug>  the successor's project when its id is ambiguous",
            "  --objective <id>      the objective a linked unit contributes to",
            "  --milestone <id>      the milestone a linked or proposed unit contributes to",
            "  --value <text>        why the proposed work matters",
            "  --success <text>      what done looks like for the proposal",
            "  --stop <text>         the condition that ends the proposal early",
            "  --risk <text>         what could go wrong",
            "  --capacity <text>     the effort the proposal asks for",
            "  --evidence-plan <e>   how the outcome will be evidenced",
            "  --confidence <level>  low, medium, or high",
            "  --expires <date>      when an unanswered proposal lapses"
        ]
    },
    {
        name: "report",
        usage: [
            {
                syntax: 'report <work-id> "<summary>" [--file path] [--evidence v] [--artifact path] [--next n]'
            }
        ],
        detail: [
            "attach a report to a work unit. The current HEAD commit is recorded as",
            "evidence unless --evidence names other values. The project repository",
            "decides what each value is: one it resolves is recorded as a Git revision",
            "and watched, anything else is kept as a descriptive note and never",
            "resolved again. Force either reading with commit:<v> or note:<v>.",
            "",
            "  --file <path>       read the summary from a file instead of the argument",
            "  --evidence <v>      record evidence, repeatable: a revision this repo",
            "                      resolves, else a note; commit:<v>/note:<v> force it",
            "  --artifact <path>   copy a file into the store and attach it, repeatable",
            "  --next <text>       what the next session should pick up"
        ]
    },
    {
        name: "attempt",
        usage: [
            { syntax: "attempt run <plan.json>", description: ["preflight a work attempt's capabilities, then run and spool it"] },
            { syntax: "attempt register <plan.json>", description: ["preflight and spool an attempt a launcher of your own will start"] },
            {
                syntax: "attempt started <id> --pid N | heartbeat <id> | exited <id> [--code N]",
                description: ["drive a registered attempt from the launcher that owns its process"]
            },
            { syntax: "attempt list [--work id] [--json]", description: ["list this machine's attempts and the state each reached"] },
            { syntax: "attempt show <attempt-id>", description: ["print one attempt's durable record and capability receipt"] },
            {
                syntax: 'attempt directive <id> "<text>" | cancel <id>',
                description: ["deliver a follow-up or a cancellation through the spool"]
            },
            {
                syntax: "attempt propose <id> --action <kind>",
                description: ["record what a running attempt is asking to do, and refuse a forbidden one"]
            },
            { syntax: "attempt settle <id>", description: ["settle an attempt the runner finished but never settled"] },
            { syntax: "attempt recover", description: ["reconcile attempts a crash or restart left running"] },
            {
                syntax: "attempt prune [--days N] | retention [<days>] | breaker <provider> [--reset]",
                description: ["manage spool retention and the provider circuit breaker"]
            }
        ],
        detail: [
            "run a work attempt through its durable spool and manage what the spool",
            "keeps: preflight the plan's capabilities, run it, deliver directives, and",
            "recover or prune what earlier runs left behind. A launcher of your own",
            "registers an attempt and then drives it through started, heartbeat, and",
            "exited.",
            "",
            "An action a running attempt proposes is recorded and waits for a person.",
            "One in a forbidden category — publication, outreach, payment, purchase,",
            "provisioning, destructive action, policy change — is refused where it",
            "arrives rather than queued, and the refusal is what reaches the digest.",
            "",
            "  --work <work-id>    only attempts of this work unit",
            "  --action <kind>     what a running attempt is asking to be allowed to do",
            "  --json              machine-readable listing",
            "  --pid <pid>         the process id the launcher started",
            "  --code <n>          the exit code the launched process reported",
            "  --days <n>          prune spools untouched for this many days",
            "  --reset             close the named provider's circuit breaker"
        ]
    },
    {
        name: "artifact",
        usage: [
            {
                syntax: "artifact list [--work id] [--project slug]",
                description: ["list artifacts from the derived registry"]
            },
            {
                syntax: "artifact search <query> | open <id> [--project slug]",
                description: ["find an artifact, or open it with the OS default app at a terminal"]
            }
        ],
        detail: [
            "browse the files reports have attached. Artifacts are ingested by",
            "`self report --artifact`, never registered on their own. Without an",
            "interactive terminal, `open` prints the resolved path and launches nothing.",
            "",
            "  --work <work-id>    only artifacts attached to this work unit",
            "  --project <slug>    only artifacts of this project, instead of the current one"
        ]
    },
    {
        name: "convention",
        usage: [
            { syntax: 'convention add "<text>" [--supersedes <event-id>]', description: ["record a rule, optionally replacing ones it corrects"] },
            { syntax: 'convention drop <event-id> --why "<reason>"', description: ["retire a convention with nothing replacing it"] }
        ],
        detail: [
            "record a rule this project works by, or retire one by its event id.",
            "",
            "  --supersedes <id>     the convention this one replaces, repeatable",
            "  --why <text>          why a dropped rule no longer holds; every withdrawal carries one",
            "",
            "correcting a rule is one event, not a drop and a re-add: the replacement",
            "carries the lineage, so the pair can never both read as current."
        ]
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
            "  --global    write into this machine's agent instruction files instead"
        ]
    },
    {
        name: "view",
        usage: [{ syntax: "view [slug]", description: ["open the live workspace or project view in the browser at a terminal"] }],
        detail: [
            "open the HTML view the last fold rendered: the workspace, or one project.",
            "Without an interactive terminal, `view` prints the rendered path and",
            "launches nothing."
        ]
    },
    {
        name: "context",
        usage: [{ syntax: "context [--project <slug>] [--pretty|--plain]", description: ["print derived context for agents"] }],
        detail: [
            "print this project's current truth: goal, active decisions, open work, recent reports.",
            "piped output is capped at 12,000 characters per project; every omission names",
            "the command that recovers the omitted state in full.",
            "a terminal gets the ruled render instead, which carries no cap; --plain forces",
            "the capped agent output anywhere, --pretty forces the ruled render.",
            "there is no --workspace form: run from outside every project, `context` already",
            "summarizes the whole workspace.",
            "",
            "  --project <slug>    read this registered project instead of this directory's"
        ]
    },
    {
        name: "status",
        usage: [
            {
                syntax: "status [--project <slug>] [--workspace] [--pretty|--plain]",
                description: ["print a short state summary"]
            }
        ],
        detail: [
            "print what waits on you, what is moving, and any health signals.",
            "on a terminal this machine's open attempts are rolled up per work unit;",
            "piped output keeps one line per attempt.",
            "",
            "  --project <slug>    summarize this registered project instead of this directory's",
            "  --workspace         one line per registered project, from anywhere"
        ]
    },
    {
        name: "setup",
        usage: [{ syntax: "setup", description: ["print the workspace, project, and store this directory resolves to"] }],
        detail: ["explain how this directory resolves, and what to run when it resolves to nothing."]
    },
    {
        name: "log",
        usage: [{ syntax: "log [-n N] [--project <slug>] [--workspace]", description: ["print recent events"] }],
        detail: [
            "print the project's event log, newest last.",
            "--workspace merges every registered project onto one timeline and leads each",
            "line with the project it happened in.",
            "",
            "  -n <count>          how many events to print (default 20)",
            "  --project <slug>    read this registered project instead of this directory's",
            "  --workspace         every registered project's events on one timeline"
        ]
    },
    {
        name: "search",
        usage: [{ syntax: "search [query] [--type t] [--project p]", description: ["grep state (query optional with --type or --project)"] }],
        detail: [
            "search events across every registered project.",
            "the query may be omitted when --type or --project narrows the pull.",
            "",
            "  --type <type>       only events of this type, such as decision.confirmed",
            "  --project <slug>    only this project"
        ]
    },
    {
        name: "fold",
        usage: [{ syntax: "fold", description: ["re-derive canonical files from the log"] }],
        detail: ["rebuild state files, work briefs, and HTML views from the event log."]
    }
];

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

export function rootUsage(): string
{
    return ["usage: self <command>", ""]
        .concat(COMMANDS.flatMap((command) => command.usage.flatMap(listLines)))
        .concat("", listLines(VERSION_LINE))
        .join("\n");
}

const VERSION_LINE: UsageLine = {
    syntax: "--version",
    description: ["print the version of the package this binary was built from"]
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

export function commandUsage(command: CommandHelp): string
{
    const header = command.usage.map((line, index) => (index === 0 ? "usage: self " : "       self ") + line.syntax);
    return header.concat("", command.detail).join("\n");
}

export function findCommand(name: string | undefined): CommandHelp | undefined
{
    return COMMANDS.find((command) => command.name === name);
}
