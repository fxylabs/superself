// The one place the CLI describes itself. `self` with no arguments prints the
// whole verb list; `self <command> --help` prints that command's syntax and
// flags. Both are rendered from the same entries, so a command can never be
// documented in one place and missing from the other.

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
            { syntax: "project link [slug] [path]", description: ["link this checkout of a registered project on this machine"] }
        ],
        detail: [
            "register a project with the workspace, or link another checkout of an",
            "already registered one. `link` with no slug infers it from the repository.",
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
            { syntax: "objective", description: ["list objectives and their milestones"] },
            {
                syntax: 'objective add "<outcome>" [--horizon week|month|quarter|year] [--target d]',
                description: ["create a time-boxed objective under the goal"]
            },
            { syntax: "objective show|confirm <id>", description: ["print an objective, or confirm a proposed one"] },
            {
                syntax: "objective revise <id> --why w [--outcome t] [--target d] [--success s] [--stop s]",
                description: ["an empty --target/--horizon/--priority withdraws that field"]
            },
            { syntax: "objective close <id> --as reached|dropped [--why w]" }
        ],
        detail: [
            "keep the time-boxed objectives that break the goal down, each with the",
            "reason for its state. Progress is never a percentage.",
            "",
            "  --horizon <span>      week, month, quarter, or year",
            "  --target <date>       the date the outcome is judged on",
            "  --success <text>      what reached looks like",
            "  --stop <text>         the condition that ends it early",
            "  --priority <n>        smaller sorts first",
            "  --proposed            record as a proposal the user has not confirmed",
            "  --supersedes <id>     retire an earlier objective",
            "  --as <state>          how `close` ends it: reached or dropped",
            "  --why <text>          the reason recorded with a revision or a close"
        ]
    },
    {
        name: "milestone",
        usage: [
            { syntax: "milestone", description: ["list milestones with state, reason, and linked work"] },
            { syntax: 'milestone add "<outcome>" --objective <id> --exit "<criterion>" [--target d] [--after m] [--supersedes m]' },
            { syntax: "milestone show <id>", description: ["print a milestone, its exit criteria, and its coverage"] },
            { syntax: "milestone revise <id> --why w [--outcome t] [--target d] [--exit e] [--drop-exit c1]" },
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
            "  --objective <id>      the objective the milestone belongs to",
            "  --exit <criterion>    an exit criterion, repeatable",
            "  --target <date>       the date the checkpoint is judged on",
            "  --after <id>          order it after another milestone",
            "  --criterion <c>       the criterion `met` or `recheck` speaks about",
            "  --work <id>           the work unit whose evidence covers it",
            "  --evidence <hash>     a commit recorded with the coverage",
            "  --why <text>          how the evidence covers it, or what was re-judged"
        ]
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
            "  --why <text>          the reason the decision was made",
            "  --proposed            record as a proposal, which never displaces a confirmed decision",
            "  --supersedes <id>     retire an earlier decision, repeatable",
            "  --work <work-id>      attach the decision to a work unit"
        ]
    },
    {
        name: "work",
        usage: [
            { syntax: "work [--project <slug>]", description: ["list open work, from any directory with --project"] },
            { syntax: 'work add "<required outcome>"', description: ["create a work unit"] },
            {
                syntax: "work show <id> [--project <slug>]",
                description: ["print full work detail: brief, reports, evidence", "(resolves the owning project from any directory)"]
            },
            {
                syntax: "work start|block|unblock|done <id>",
                description: [
                    "move a work unit (block: --on decision|dependency|external [--why w])",
                    "done is refused while anything the completion check asks for is missing"
                ]
            },
            {
                syntax: "work link|unlink <id> --objective o | --milestone m",
                description: ["state, or withdraw, what a work unit contributes to"]
            },
            { syntax: 'work propose "<outcome>" --milestone m --value v --success s --stop s --risk r' },
            { syntax: "work accept|decline <proposal-id>", description: ["act on a goal-gap proposal"] },
            { syntax: 'work require <id> "<what the outcome must cover>"', description: ["declare a requirement; prints its id"] },
            { syntax: 'work revise <id> --requirement r1 --statement "<restated>" --why w', description: ["restate one; its coverage goes stale"] },
            { syntax: "work retire <id> --requirement r1 --why w" },
            {
                syntax: "work retire <id> --why w [--successor <work-id>] [--successor-project <slug>]",
                description: [
                    "retire the unit itself: its outcome was given up or moved, not reached",
                    "history stays inspectable; the unit stops counting as open work"
                ]
            },
            {
                syntax: "work met <id> --requirement r1 --why w [--evidence c] [--artifact a] [--report e]",
                description: ["cover a requirement with evidence the unit already carries"]
            },
            { syntax: "work recheck <id> --requirement r1 --why w", description: ["re-judge coverage a revision left stale"] },
            { syntax: "work approval-required <id> [--why w]", description: ["make this unit wait for a person before dispatch and done"] },
            { syntax: "work approve <id> [--by name]", description: ["grant it, from an interactive terminal only"] },
            { syntax: "work policy <id> [--model class] [--fresh-review] [--why w]", description: ["what its implementation had to be"] }
        ],
        detail: [
            "create and move units of work, and state what each contributes to.",
            "`work add` prints the new id.",
            "",
            "a unit is done only when every live requirement is covered by evidence,",
            "any approval it waits on has been granted at a terminal, and its",
            "completion policy is satisfied. A passing attempt never marks work done:",
            "settlement records what the run produced and frees the unit.",
            "",
            "  --project <slug>      list or show against this project, from any directory",
            "  --on <reason>         what a blocked unit waits on: decision, dependency, or external",
            "  --why <text>          detail recorded with the block, a revision, or the done",
            "  --requirement <id>    the requirement `met`, `recheck`, `revise` or `retire` speaks about",
            "  --successor <id>      the unit that carries a retired outcome now, resolved workspace-wide",
            "  --successor-project <slug>  the successor's project when its id is ambiguous",
            "  --statement <text>    the restated requirement a revision records",
            "  --evidence <hash>     a commit already attached to the unit that covers it",
            "  --artifact <id>       an artifact already attached to the unit that covers it",
            "  --report <event-id>   a report already attached to the unit that covers it",
            "  --model <class>       the model class its implementation attempts had to run under",
            "  --fresh-review        a review receipt from a session other than the implementer's",
            "  --by <name>           who granted the approval",
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
                syntax: 'report <work-id> "<summary>" [--file path] [--evidence c] [--artifact path] [--next n]'
            }
        ],
        detail: [
            "attach a report to a work unit. The current HEAD commit is recorded as",
            "evidence unless --evidence names other commits.",
            "",
            "  --file <path>       read the summary from a file instead of the argument",
            "  --evidence <hash>   record this commit as evidence, repeatable",
            "  --artifact <path>   copy a file into the store and attach it, repeatable",
            "  --next <text>       what the next session should pick up"
        ]
    },
    {
        name: "integration",
        usage: [
            { syntax: "integration [status]", description: ["compact status of every repository's integration train"] },
            { syntax: "integration register --repo r --base b --head h [--pr n] [--work id] [--domain name@ver]" },
            { syntax: "integration show|list|plan [--json]", description: ["machine-readable train, receipts, and blockers"] },
            { syntax: "integration declare <id> [--depends cs] [--consolidates cs --why w] [--domain d] [--check c]" },
            { syntax: "integration head <id> --head h", description: ["record an author's new head; a changed digest owes a review"] },
            { syntax: "integration lease acquire|release|show --repo r [--holder h] [--fence N]" },
            { syntax: "integration attempt start <id> --fence N --action rebase|resolve|merge" },
            { syntax: "integration attempt finish <attempt> --outcome completed|conflict|failed [--head h]" },
            { syntax: "integration observe ci|main|target --repo r --head h [--check c] [--conclusion x] [--at iso] [--dedupe k]" },
            { syntax: "integration target --repo r [--branch b]", description: ["configure the autonomous integration branch merges land on"] },
            { syntax: "integration approve <id> --head h", description: ["the human gate on a merge that lands on main (interactive terminal)"] },
            { syntax: "integration merge <id> --fence N --merge-commit m --main-before a --main-after b" },
            {
                syntax: "integration promote request|approve|record|show",
                description: ["the only lane into main: release review + human approval, exact candidate"]
            },
            { syntax: "integration reconcile [--repo r]", description: ["converge leases and in-flight attempts, idempotently"] }
        ],
        detail: [
            "run each repository's integration train: register a change set, keep its",
            "head and reviews current, and drive the lease, attempt, and merge steps",
            "an integrator takes. `register` also accepts --depends, --supersedes,",
            "--check, --rank, and --diff-digest.",
            "",
            "run `self integration` for the compact status, and `self integration plan`",
            "for the machine-readable order, receipts, and blockers."
        ]
    },
    {
        name: "review",
        usage: [
            { syntax: "review request <id> --scope change|integration_delta|release" },
            { syntax: "review ingest --file <envelope.json>", description: ["the only way a review receipt comes into being"] },
            { syntax: "review list [<id>] | contract", description: ["receipts on record, or the runner's result contract"] }
        ],
        detail: [
            "request the review a change set owes and ingest the envelope the runner",
            "returns. A receipt exists only through `review ingest`.",
            "",
            "  --scope <scope>     what the request covers: change, integration_delta, or release",
            "  --file <path>       the result envelope to ingest",
            "  --json              machine-readable listing"
        ]
    },
    {
        name: "spec",
        usage: [
            { syntax: "spec validate <workspec.json>", description: ["check a work spec without touching project state"] },
            { syntax: "spec apply <workspec.json>", description: ["seal a work spec as an immutable generation and move its HEAD"] },
            { syntax: "spec dispatch <work-spec-id>", description: ["compile the current generation and run it as one attempt"] },
            {
                syntax: "spec list [--json] | show <id> [--json]",
                description: ["work specs, their generations, and the attempts pinned to them"]
            }
        ],
        detail: [
            "keep a work unit's desired state as immutable, content-addressed",
            "generations, and materialize the current one as a runner attempt pinned",
            "to the exact generation it was admitted under.",
            "",
            "  --json              machine-readable listing"
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
        name: "daemon",
        usage: [
            { syntax: "daemon start [--interval ms] [--foreground]", description: ["supervise this project's attempts without a chat turn"] },
            { syntax: "daemon stop | status [--json]", description: ["stop the supervisor, or report what it has done"] },
            { syntax: "daemon tick [--json]", description: ["run exactly one supervision pass in the foreground"] },
            { syntax: "daemon circuits [--json]", description: ["provider circuit state and any capacity reset"] }
        ],
        detail: [
            "run the supervision loop over this project's attempts: reconcile what is",
            "still being driven against what has exited, settle a confirmed exit",
            "through the completion gate, release the work unit it held, and wake",
            "ready approved work that has a work spec.",
            "",
            "One supervisor per machine, supervising the project it was started in.",
            "It is not one per project: a start from another project's checkout is",
            "refused while this one runs, and that project's attempts are left",
            "unsupervised until it stops.",
            "",
            "`tick` is one iteration of exactly that, in the foreground — running it",
            "twice in a row does nothing the second time.",
            "",
            "  --interval <ms>     how long the loop waits between ticks (default 5000)",
            "  --foreground        run the loop in this process instead of detaching it",
            "  --json              machine-readable status, tick, or circuit listing"
        ]
    },
    {
        name: "overnight",
        usage: [
            {
                syntax: "overnight set [--from 22:00] [--to 07:00] [--auto-dispatch] [--risk r] [--kind k]",
                description: ["record the policy the daemon may dispatch under while nobody watches"]
            },
            { syntax: "overnight show [--json] | off", description: ["print the policy in force, or revoke it"] }
        ],
        detail: [
            "grant the supervisor a bounded, versioned, revocable autonomy. Outside",
            "the window, and with no policy at all, the daemon still reconciles,",
            "settles and releases — it dispatches nothing new. Inside it, a work",
            "spec is woken only if the policy allows its project, its risk class,",
            "its work kind, its provider and its model, and only within the",
            "concurrency cap, the declared-cost ceiling and the stop condition.",
            "",
            "A policy narrows and never widens. It cannot exempt a unit from its",
            "approval requirement or from its completion policy, and it can never",
            "grant publication, outreach, payment, purchase, provisioning,",
            "destructive action or policy change — those are refused categorically,",
            "at registration and again when a running attempt proposes one, and a",
            "declaration is judged by its command as well as by its tools.",
            "",
            "Setting one is a person's act: `set` asks for the window typed back at",
            "an interactive terminal, and refuses outright inside an agent attempt.",
            "`off` needs no terminal — revoking only narrows, and stopping",
            "unattended spending must never wait for one.",
            "",
            "  --from <hh:mm>       when the window opens, local time (default 22:00)",
            "  --to <hh:mm>         when it closes (default 07:00)",
            "  --digest-at <hh:mm>  when the operator reads the account (default 07:30)",
            "  --auto-dispatch      let ready work dispatch on its own; off by default",
            "  --project <slug>     repeatable; defaults to this project alone",
            "  --risk <class>       repeatable; internal, external or privileged (default internal)",
            "  --kind <role>        repeatable work spec role (default implementation)",
            "  --provider <name>    repeatable; any provider the specs name by default",
            "  --model <name>       repeatable; any model the specs name by default",
            "  --max-concurrent <n> attempts running at once (default 1)",
            "  --budget-usd <n>     ceiling on declared budget per window, never on observed spend",
            "  --max-runs <n>       ceiling on the runs a spec's retry policy may declare",
            "  --stop-after <n>     stop waking after this many failed runs this window",
            "  --json               machine-readable policy"
        ]
    },
    {
        name: "digest",
        usage: [
            {
                syntax: "digest [--since <ts> | --hours <n>] [--json]",
                description: ["the account of what happened while nobody was watching"]
            }
        ],
        detail: [
            "fold this project's event log over a window and group it: completed,",
            "failed, retried, waiting on approval, waiting on capacity, then the",
            "next actions. Reading it records nothing.",
            "",
            "Completed, failed and retried are what happened inside the window.",
            "Waiting on approval is what is still waiting when it ends — a unit",
            "nobody answered all night has no events in the window, and dropping it",
            "would leave out the main fact about that night.",
            "",
            "Cost and token counts come from what the provider reported and read",
            "unknown otherwise — a window whose spending nobody can see must not",
            "read as free. Nothing is inferred from prose, and no prompt, output,",
            "path or credential can appear: every line comes from events that",
            "already crossed the sanitization guard.",
            "",
            "  --since <ts>   an explicit instant to start from",
            "  --hours <n>    the last n hours",
            "  --json         machine-readable digest",
            "",
            "with neither, the window starts where the overnight policy's window",
            "does, or twelve hours ago when there is no policy."
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
        ]
    },
    {
        name: "search",
        usage: [{ syntax: "search <query> [--type t] [--project p]", description: ["grep state across the workspace"] }],
        detail: [
            "search events across every registered project.",
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
    return ["usage: self <command>", ""].concat(COMMANDS.flatMap((command) => command.usage.flatMap(listLines))).join("\n");
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
