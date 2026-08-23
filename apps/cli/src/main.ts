import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { ALIAS_COMMAND, presetRow, registerPluginClaims, registerReservedVerbs, resolveAliasCommand } from "./aliases.js";
import { archivedListing, PROJECT_ARCHIVE_LEAF, PROJECT_RESTORE_LEAF } from "./archive.js";
import { helpHint, parseCommand, required, Requirement, unknownOption } from "./args.js";
import { ARTIFACT_COMMAND, commitStaged, stageArtifacts } from "./artifact.js";
import { connectMachine, connectProject, machineBlock } from "./connect.js";
import { branch, Command, CommandInput, CommandLeaf, findCommandByName, leaf, Resolved, resolveCommand } from "./contract.js";
import { DEFAULT_ZONE, validZone } from "./dates.js";
import { derivationLines, PROJECT_FROM_LEAF } from "./derivation.js";
import { EntityState, Exposure, isEntityCreation, isLive, rendersIn, requireSupersedeKind, scopeTarget } from "./entities.js";
import { foldEveryProject, foldProject, foldWorkspace, renderWorkBody } from "./fold.js";
import { findTopic, topicPage } from "./guide.js";
import { MILESTONE_COMMAND, OBJECTIVE_COMMAND, WORK_GOAL_LEAVES } from "./goals.js";
import { classifyEvidence, commitAll, ensureWorkspaceRepo, excludeLocally, headCommit, repositoryIdentity } from "./gitutil.js";
import { cliVersion, commandUsage, rootUsage } from "./help.js";
import { workId, wrongKindHint } from "./ids.js";
import { findEventByPrefix, readEvents } from "./logfile.js";
import { machineWorkspace, sessionToken, setMachineWorkspace } from "./machine.js";
import { buildModel, DecisionState, ProjectModel, readableModels, workScope, workspaceModels, WorkState } from "./model.js";
import {
    checkoutMatches,
    checkoutProject,
    CliContext,
    ensureDir,
    invalidateResolution,
    isStore,
    LINKS_FILE,
    MARKER_FILE,
    ProjectContext,
    projectStateDir,
    readRegistry,
    readScope,
    readScopes,
    readStoreConfig,
    readVerdicts,
    recordLink,
    refuseArchived,
    requireProject,
    requireRegistered,
    requireWorkspace,
    resolveProjectPath,
    SCOPE_OPTIONS,
    siblingSlug,
    tokenScale,
    STORE_DIR,
    StoreConfig,
    WORKSPACE_SCOPE_OPTIONS
} from "./paths.js";
import { notice, renderOutput } from "./output.js";
import { makeEvent, recordEvent, recordEvents } from "./pipeline.js";
import { recordRetirement, retirementIntent, supersedeTargets } from "./retirement.js";
import { completionRefusal } from "./completion.js";
import { claimMoves, claimNote, noteSessionSeen, recordProcess } from "./ledger.js";
import { runSearch } from "./search.js";
import { setupOutput } from "./setup.js";
import {
    admittingDemotions,
    CapGateValues,
    confirmEntityUnit,
    demotionEvents,
    Placed,
    recordOwner,
    STATE_COMMAND,
    tierOf
} from "./state.js";
import { cloneStore, ensureSyncConfig, remoteAdd, syncStore } from "./sync.js";
import { countCharacters, dim, markdownHeadings, styled } from "./style.js";
import { openFile, validTheme, viewFile } from "./view.js";
import { RENDER_OPTIONS } from "./pretty.js";
import { contextOutput, historyOutput, projectLog, statusOutput, workList, workspaceLog } from "./views.js";
import { APP_COMMAND, registerHostVerbs } from "./app.js";
import { LOGIN_COMMAND, LOGOUT_COMMAND, WHOAMI_COMMAND, clientTag } from "./login.js";
import { resolveProfileName } from "./credentials.js";
import {
    InstalledPlugin, LoadContext, assertDevPluginMode, devPluginDir, installedPlugins,
    loadDevPlugin, loadPlugin, pluginVerbs, resolveRailMajor
} from "./plugins.js";
import { loadTrustDocument } from "./trust.js";
import { jsonMode, renderFailure, selectJsonMode } from "./output.js";
import { suppressJournal } from "./rail.js";
import { CliError, CommandOutput, EventRefs, SelfEvent } from "./types.js";

async function main(argv: string[]): Promise<void>
{
    // Env-only, and first: a development plugin configured without development
    // mode is a mistake worth refusing on any invocation, and asking costs two
    // environment reads rather than a look at the plugin directory.
    assertDevPluginMode();
    if (answeredWithoutACommand(argv))
    {
        return;
    }
    // Host flags are consumed once, here, for every command. `self app install
    // email --no-journal` is as reasonable a request as the same flag on a
    // mini-app verb, and neither leaf should have to declare an option about
    // whether this machine keeps a record of its own calls.
    suppressJournal(argv.includes("--no-journal"));
    const args = hostFlagsRemoved(argv);
    const resolved = resolveCommand(COMMANDS, args);
    if (resolved !== null)
    {
        await runLeaf(resolved);
        return;
    }
    if (!await runPlugin(args))
    {
        await runAlias(args);
    }
}

// The two questions answered before any command is resolved. Both need no
// workspace, write no event, and exit successfully — asking what the binary is,
// and asking what it can do.
function answeredWithoutACommand(argv: string[]): boolean
{
    // `--version` is asked of the binary itself, so it stands where a verb
    // would rather than inside one: `self work --version` is a flag `work`
    // never declared, and naming it there is the answer that surface owes.
    if (argv[0] === "--version" || argv[0] === "-V")
    {
        renderOutput([{ kind: "value", text: cliVersion() }]);
        return true;
    }
    // A help request for a verb an installed mini-app claims is declined here,
    // so dispatch can load that plugin and render its own page. Answering it
    // with the root list — which is what a name no built-in owns used to get —
    // told a reader the verb did not exist while `self --help` listed it two
    // lines above.
    if (helpForPluginVerb(argv))
    {
        return false;
    }
    const help = helpText(argv);
    if (help !== null)
    {
        printUsage(help);
        return true;
    }
    return false;
}

function helpForPluginVerb(argv: string[]): boolean
{
    if (argv[0] !== "help" && !asksForHelp(argv))
    {
        return false;
    }
    const name = argv[0] === "help" ? argv[1] : argv[0];
    return name !== undefined && findCommandByName(COMMANDS, name) === undefined && pluginVerbs().has(name);
}

// Resolution order, and the whole of it: a built-in always wins, then an
// installed plugin's verb, then the alias table. Nothing above this line has
// touched the plugin tree — a built-in verb resolves from `COMMANDS` and
// returns, so `self work add` pays for no directory read, no signature check
// and no import.
//
// The verb index built here is metadata only: one `readdir` plus one
// `manifest.json` read per key. The signature check, the hash and the import
// happen for the one plugin that claims the verb, and only then.
async function runPlugin(argv: string[]): Promise<boolean>
{
    // `self help email` names its subject in the second position, exactly as
    // `self email --help` names it in the first. Both are one question.
    const asked = argv[0] === "help" ? argv[1] : argv[0];
    const development = devPluginDir();
    const plugin = asked === undefined ? undefined : pluginVerbs().get(asked);
    if (asked === undefined || (development === null && plugin === undefined))
    {
        return false;
    }
    const commands = await pluginCommands(argv, plugin, development);
    const named = commands.find((command) => command.name === asked);
    if (named !== undefined && (argv[0] === "help" || asksForHelp(argv)))
    {
        printUsage(commandUsage(named));
        return true;
    }
    const resolved = resolveCommand(commands, argv);
    if (resolved === null)
    {
        return false;
    }
    await runLeaf(resolved);
    return true;
}

// `--no-journal` belongs to the host, not to any leaf: whether this machine
// keeps a local record of its own calls is not a question a mini-app should
// have to declare an option for. So the host reads it and removes it, and the
// leaf parses an argv that never contained it. After `--` it is a positional
// the caller meant literally and is left alone.
// The resolved verb path and nothing else — `email send`, never
// `email send --json`.
//
// This feeds the derived call key, so a flag leaking into it would make
// `self email send` and `self email send --json` two different calls against
// the same account: the second is a fresh key, and a fresh key is a second
// charge. Render flags are excluded from the derivation by §4.1 precisely so a
// retry that adds `--json` is still the same call.
function verbPath(argv: string[]): string
{
    const words: string[] = [];
    for (const argument of argv)
    {
        if (argument.startsWith("-") || words.length === 2)
        {
            break;
        }
        words.push(argument);
    }
    return words.join(" ");
}

function hostFlagsRemoved(argv: string[]): string[]
{
    const end = argv.indexOf("--");
    return argv.filter((argument, at) =>
        argument !== "--no-journal" || (end !== -1 && at > end));
}

// `--timeout <s>` replaces the derived per-command deadline outright, in both
// directions (§4.2). It is the one flag the host reads out of argv before the
// leaf parses, and it has to be: the session it configures is built before the
// plugin exists to declare anything. The leaf still declares and parses it
// normally, so nothing here bypasses the contract — this only reads it early.
function deadlineFrom(argv: string[]): { deadlineMs?: number }
{
    const at = argv.indexOf("--timeout");
    const seconds = at === -1 ? Number.NaN : Number(argv[at + 1]);
    return Number.isFinite(seconds) && seconds > 0 ? { deadlineMs: seconds * 1000 } : {};
}

async function pluginCommands(argv: string[], plugin: InstalledPlugin | undefined, development: string | null): Promise<Command[]>
{
    const profile = resolveProfileName();
    const tag = plugin === undefined ? undefined : `${plugin.key}@${plugin.version}`;
    const session = {
        profile,
        client: clientTag(tag),
        notice: (line: string) => console.error(line),
        ...deadlineFrom(argv)
    };
    // Step 0, and first: the signed key list this load will be judged against.
    // Fail-open on a valid cache, so an installed plugin keeps working offline;
    // refreshed when the cache is older than 24 h, so a revocation reaches this
    // machine within a day of it being published. The development path has no
    // signature to judge and so has no document to fetch.
    const trust = development === null
        ? (await loadTrustDocument({ mode: "load", session })).document
        : undefined;
    // Resolved before the import, never deferred to the plugin's own first
    // call: an incompatible plugin must not get to issue one live, chargeable
    // request before the check that exists to stop it has run.
    const railApi = plugin === undefined ? undefined : await resolveRailMajor(plugin.key, session);
    const context: LoadContext = { cliVersion: cliVersion(), session, railApi, commandPath: () => verbPath(argv) };
    return trust === undefined
        ? loadDevPlugin(development as string, context)
        : loadPlugin(plugin as InstalledPlugin, context, trust);
}

// A first token no command owns resolves against the alias table (#207 A1):
// `self idea`, `self roadmap`, and every user-added verb dispatch through the
// same contract machinery as a composed command. No table row — or no
// workspace to read one from — keeps the unknown-command refusal exactly as it
// was (A6).
async function runAlias(argv: string[]): Promise<void>
{
    const alias = resolveAliasCommand(process.cwd(), argv[0]);
    const aliased = alias === null ? null : resolveCommand([alias], argv);
    if (aliased === null)
    {
        cmdUnknown(argv[0] ?? "");
        return;
    }
    await runLeaf(aliased);
}

// The one parse in the CLI: the option set, the positional count and what the
// verb cannot run without all come from the leaf the contract resolved to, so
// nothing a command accepts or demands can be declared anywhere else.
//
// A handler that answers with blocks is printed by the render gate, once, with
// the flags this run was parsed with. One that prints for itself returns
// nothing and is unaffected — the migration is per verb. Neither path touches
// the refusal path: a `CliError` thrown in a handler passes straight through
// here to the top-level catch, so nothing a command refuses is swallowed by
// having something to print.
async function runLeaf(resolved: Resolved): Promise<void>
{
    selectJsonMode(wantsJson(resolved));
    refuseInteraction(resolved);
    const parsed = parseCommand(resolved.path, resolved.args, resolved.leaf.options,
        resolved.leaf.positionals, resolved.leaf.requires);
    const output = await resolved.leaf.run(parsed);
    if (Array.isArray(output))
    {
        renderOutput(output, parsed.values);
    }
}

// Which selector asked for machine mode, and what each one may do — the
// asymmetry is deliberate and is the whole point. A flag is a per-command
// request, so an explicit `--json` on a leaf that promises no machine shape is
// refused **by name**. An environment variable is an ambient preference an
// agent exports once for a session, so it is simply ignored there: one export
// must not break every command that predates the flag.
function wantsJson(resolved: Resolved): boolean
{
    const promises = Object.prototype.hasOwnProperty.call(resolved.leaf.options, "json");
    if (!promises)
    {
        if (asksJson(resolved.args))
        {
            // Machine mode is selected before the refusal is thrown, so the
            // caller gets the envelope on stdout. An agent that asked for JSON
            // and was handed a human sentence on stderr has to parse prose to
            // find out that it cannot parse anything — the one shape it is
            // guaranteed to understand is the one this refusal owes it.
            selectJsonMode(true);
            throw new CliError(`\`self ${resolved.path}\` has no --json contract yet`, "json_unsupported",
                { hint: "read the human output, or use a command that declares --json" });
        }
        return false;
    }
    return asksJson(resolved.args) || process.env.SUPERSELF_JSON === "1";
}

// Machine mode implies non-interactive, and the refusal has to arrive *before*
// the handler runs — a command that reaches its confirmation gate and then
// discovers nobody is there has already done the work it was asking about. A
// leaf declaring `--yes` is a leaf that needs confirmation, which is the one
// place that fact is stated.
function refuseInteraction(resolved: Resolved): void
{
    const needsConfirmation = Object.prototype.hasOwnProperty.call(resolved.leaf.options, "yes");
    if (jsonMode() && needsConfirmation && !resolved.args.includes("--yes"))
    {
        throw new CliError(`\`self ${resolved.path}\` destroys something, and machine mode never prompts`,
            "confirmation_required", { hint: "pass --yes if that is what you mean" });
    }
}

// After `--` a flag is a positional the user meant literally.
function asksJson(args: string[]): boolean
{
    for (const arg of args)
    {
        if (arg === "--")
        {
            return false;
        }
        if (arg === "--json")
        {
            return true;
        }
    }
    return false;
}

// Bare `self` is a request for the verb list; anything else that reached no
// command is a mistake, named on stderr with a non-zero exit so a caller that
// typoed a verb never reads the usage text as success. An option-looking one
// is a flag that reached no command, so it is named as a flag.
function cmdUnknown(cmd: string): void
{
    if (cmd === "")
    {
        printUsage(rootUsage(withPluginVerbs()));
        return;
    }
    if (cmd.startsWith("-"))
    {
        throw new CliError(unknownOption(cmd, undefined));
    }
    throw new CliError(`unknown command '${cmd}' — ${helpHint(undefined)}`, "unknown_command",
        { hint: `if it is a mini-app, install it with \`self app install ${cmd}\`` });
}

// The root page shows installed mini-app verbs, marked as what they are, so a
// reader is never told a verb that works does not exist. Metadata only: this
// reads manifests, never a signature and never plugin code.
function withPluginVerbs(): Command[]
{
    return COMMANDS.concat(installedPlugins().flatMap((plugin) => plugin.manifest.verbs.map((verb) => ({
        name: verb,
        usage: [{ syntax: verb, description: [`from the installed mini-app ${plugin.key}@${plugin.version}`], verbs: [""] }],
        detail: [],
        node: leaf("", {}, 0, () => undefined)
    }))));
}

// Help is answered before any command runs, so asking for it needs no
// workspace, writes no event, and always exits successfully. An alias verb's
// page is looked up best-effort — where no workspace or no row answers, the
// root list does, exactly as before.
function helpText(argv: string[]): string | null
{
    if (argv[0] !== "help" && !asksForHelp(argv))
    {
        return null;
    }
    const name = argv[0] === "help" ? argv[1] : argv[0];
    const command = findCommandByName(COMMANDS, name);
    if (command !== undefined)
    {
        return commandUsage(command);
    }
    const alias = name === undefined ? null : resolveAliasCommand(process.cwd(), name);
    if (alias !== null)
    {
        return commandUsage(alias);
    }
    // A concept page answers the question a syntax page cannot (#221). It is
    // resolved last, so a name a command or an alias verb owns is never taken
    // by a topic.
    const topic = findTopic(name);
    return topic === undefined ? rootUsage(withPluginVerbs()) : topicPage(topic);
}

// After `--` a flag is a positional the user meant literally, not a request.
// The token right after an option is that option's value position, so a
// `--help` standing there is handed to the command's own parser — which
// names the mistake, or takes the value — instead of hijacking the call;
// anywhere a flag could stand, `--help` wins.
function asksForHelp(argv: string[]): boolean
{
    let value = false;
    for (const arg of argv)
    {
        if (arg === "--")
        {
            return false;
        }
        if (value)
        {
            value = false;
            continue;
        }
        if (arg === "--help" || arg === "-h")
        {
            return true;
        }
        value = arg.startsWith("-") && !arg.includes("=");
    }
    return false;
}

// The verb list and a command's own page are answers with no command behind
// them: they are composed before anything resolves, so there is no leaf to
// return them from and no handler for the dispatcher to print for. They reach
// the gate directly, which asks for neither — a workspace least of all, since
// what the CLI can do has to answer on a machine that has none.
function printUsage(usage: string): void
{
    renderOutput([{ kind: "document", plain: () => usageLines(usage) }]);
}

// Dim the description column so the command column stands out; piped output is
// untouched. The page carries one render because what differs between a
// terminal and a pipe here is paint, and paint is `style.ts`'s answer rather
// than the render mode's: a usage list is not a ruled table, so a terminal too
// narrow for one is no reason for it to lose its dimming.
function usageLines(usage: string): string[]
{
    if (!styled)
    {
        return usage.split("\n");
    }
    return usage.split("\n").map((line) =>
    {
        const match = line.match(/^(  \S.*?)(\s{2,})(\S.*)$/);
        if (match !== null)
        {
            return match[1] + match[2] + dim(match[3]);
        }
        return /^\s{20,}\S/.test(line) ? dim(line.trimEnd()) : line;
    });
}

/* ── the option sets this module's leaves declare ──────────────────── */

const INIT_OPTIONS = { lang: { type: "string" }, agents: { type: "boolean" } } as const;

const PROJECT_INIT_OPTIONS = { name: { type: "string" }, desc: { type: "string" }, "no-connect": { type: "boolean" } } as const;

// The bare listing answers for the projects this workspace is working on; the
// flag asks for the ones it set aside (#283). Two lists rather than one marked
// list: the reason a project was archived is worth a column of its own, and the
// default listing exists to be short.
const PROJECT_LIST_OPTIONS = { archived: { type: "boolean" } } as const;

const DECIDE_OPTIONS = {
    proposed: { type: "boolean" },
    why: { type: "string" },
    supersedes: { type: "string", multiple: true },
    work: { type: "string" },
    blocks: { type: "string", multiple: true },
    after: { type: "string" },
    demote: { type: "string", multiple: true }
} as const;

const WITHDRAW_OPTIONS = { why: { type: "string" } } as const;

const TRANSITION_OPTIONS = { on: { type: "string" }, why: { type: "string" } } as const;

const PROCESS_OPTIONS = { pid: { type: "string" }, code: { type: "string" } } as const;

const RETIRE_OPTIONS = {
    why: { type: "string" },
    successor: { type: "string" },
    "successor-project": { type: "string" },
    requirement: { type: "string" }
} as const;

// `--supersedes` is the correction path every add verb takes; on a work unit it
// retires the unit it replaces, which is why the reason comes with it.
const WORK_ADD_OPTIONS = { supersedes: { type: "string" }, why: { type: "string" } } as const;

const WORK_ADD_USAGE = 'work add "<required outcome>" [--supersedes <work-id> --why w]';

const REPORT_OPTIONS = {
    evidence: { type: "string", multiple: true },
    artifact: { type: "string", multiple: true },
    next: { type: "string" },
    file: { type: "string" }
} as const;

// Declared once for the whole verb, so the subcommand that does not take one
// of these says so itself rather than dropping the flag.
const CONVENTION_OPTIONS = {
    supersedes: { type: "string", multiple: true },
    why: { type: "string" },
    workspace: { type: "boolean" },
    demote: { type: "string", multiple: true }
} as const;

// The same shape, for the same reason: `goal add` refuses the withdrawal's
// reason and `goal retract` refuses the successor's link, rather than either
// silently dropping a flag the caller meant.
const GOAL_OPTIONS = {
    supersedes: { type: "string", multiple: true },
    why: { type: "string" },
    demote: { type: "string", multiple: true }
} as const;

const SCOPED_RENDER_OPTIONS = { ...SCOPE_OPTIONS, ...RENDER_OPTIONS } as const;

const WORKSPACE_RENDER_OPTIONS = { ...WORKSPACE_SCOPE_OPTIONS, ...RENDER_OPTIONS } as const;

const LOG_OPTIONS = { lines: { type: "string", short: "n" }, ...WORKSPACE_SCOPE_OPTIONS } as const;

const SEARCH_OPTIONS = {
    type: { type: "string" },
    project: { type: "string" },
    exposure: { type: "string" },
    all: { type: "boolean" }
} as const;

// A `show` that also prints one record's own history (#212 R3). History is
// per-entity and explicit — there is no global history search — so it is read
// on the verb that already names the record.
const HISTORY_OPTIONS = { ...SCOPE_OPTIONS, history: { type: "boolean" }, page: { type: "string" } } as const;

// The shared execution grammar (#207 B14): a work verb records the same
// `entity.*` fact the raw state verbs record, whichever kind of unit it moves.
// `start` is not among these: it hands over the brief as well as recording the
// transition (#230), which is the whole reason a session calls it at all.
const WORK_TRANSITIONS: [string, string, Requirement[]][] = [
    ["block", "entity.blocked", [{ flags: ["on"], value: "<reason>", hint: "what the unit waits on: decision, dependency, or external" }]],
    ["unblock", "entity.unblocked", []]
];

// Every withdrawal in the CLI carries its reason, so the verbs that record one
// declare it rather than each asking for it in its own words.
const WHY_REQUIRED: Requirement = { flags: ["why"], hint: "why the record no longer holds" };

// Done is not a transition like the others: it is the claim that the outcome
// was reached, so it carries its own option set — the done-time text report
// the evidence gate accepts as the floor (#205, ruling ②).
const DONE_OPTIONS = { why: { type: "string" }, report: { type: "string" } } as const;

// Listing and showing are workspace reads, so they resolve from any directory;
// every verb that writes still requires the linked checkout. The unnamed form
// takes over only for a leading long flag, so a bare `--` is still explained
// as a separator standing where a subcommand belongs.
const WORK_CHILDREN: CommandLeaf[] = [
    leaf("", SCOPED_RENDER_OPTIONS, 0, cmdWorkList),
    leaf("add", WORK_ADD_OPTIONS, 1, cmdWorkAdd),
    leaf("show", HISTORY_OPTIONS, 1, cmdWorkShow),
    leaf("start", TRANSITION_OPTIONS, 1, cmdWorkStart),
    ...WORK_TRANSITIONS.map(([verb, type, requires]) =>
        leaf(verb, TRANSITION_OPTIONS, 1, (input) => transitionWork(type, input), { requires })),
    leaf("done", DONE_OPTIONS, 1, cmdWorkDone),
    leaf("started", PROCESS_OPTIONS, 1, (input) => cmdWorkProcess(input, true)),
    leaf("exited", PROCESS_OPTIONS, 1, (input) => cmdWorkProcess(input, false)),
    leaf("retire", RETIRE_OPTIONS, 1, cmdWorkRetireUnit, {
        undocumented: ["requirement"],
        requires: [{ flags: ["why"], hint: "why the outcome was given up or moved" }]
    }),
    ...WORK_GOAL_LEAVES
];

/* ── the canonical hierarchy ───────────────────────────────────────── */

// Dispatch, argument parsing, help, and the test-tier enumeration read this
// list and nothing beside it; each entry is declared where its handlers live,
// and composed here in the order the verb list prints.
export const COMMANDS: Command[] = [
    {
        name: "init",
        usage: [{ syntax: "init [--lang <code>] [--agents]", description: ["initialize the current directory as a workspace"], verbs: [""] }],
        detail: [
            "create the workspace store this machine records project state in, and",
            "point this machine at it.",
            "",
            "  --lang <code>   language of the HTML views, as a BCP 47 code (en, ko, ja)",
            "  --agents        tell this machine's agents about self without asking"
        ],
        node: leaf("", INIT_OPTIONS, 0, cmdInit)
    },
    {
        name: "workspace",
        usage: [{ syntax: "workspace [<path>]", description: ["show or set the workspace this machine uses"], verbs: [""] }],
        detail: [
            "with no path, print the workspace this machine resolves to; with a path,",
            "point this machine at an existing workspace store."
        ],
        node: leaf("", {}, 1, ({ positionals }) => cmdWorkspace(positionals[0]))
    },
    {
        name: "lang",
        usage: [{ syntax: "lang [<code>]", description: ["show or set the language of the HTML views"], verbs: [""] }],
        detail: [
            "with no code, print the current language; with a BCP 47 code, set it and",
            "re-render every project view."
        ],
        node: leaf("", {}, 1, ({ positionals }) => cmdLang(positionals[0]))
    },
    {
        name: "theme",
        usage: [{ syntax: "theme [<name>]", description: ["show or set the viewer accent theme (violet, cyan, orange, mono)"], verbs: [""] }],
        detail: [
            "with no name, print the current accent; with a name, set it and re-render",
            "every project view."
        ],
        node: leaf("", {}, 1, ({ positionals }) => cmdTheme(positionals[0]))
    },
    {
        name: "timezone",
        usage: [{ syntax: "timezone [<zone>]", description: ["show or set the zone every target date is judged in"], verbs: [""] }],
        detail: [
            "with no zone, print the current zone; with an IANA zone name such as",
            "Asia/Seoul, set it and re-render every project view."
        ],
        node: leaf("", {}, 1, ({ positionals }) => cmdTimezone(positionals[0]))
    },
    {
        name: "tokens",
        usage: [{ syntax: "tokens [<tokens> <characters>]", description: ["show or record what a character costs in context tokens"], verbs: [""] }],
        detail: [
            "the retention caps and the context budget are stated in tokens, and the",
            "CLI counts characters, so one number converts between them. With no",
            "arguments, print it and say whether it was measured or is still the",
            "shipped estimate.",
            "",
            "with a measurement — the tokens some text cost and the characters it",
            "held — record it, and every cap and budget reads through it from then on.",
            "a session's own model cannot see what one tool result cost, so the",
            "number comes from a token-counting call or from what a harness reported."
        ],
        node: leaf("", {}, 2, ({ positionals }) => cmdTokens(positionals[0], positionals[1]))
    },
    {
        name: "project",
        usage: [
            {
                syntax: "project [--archived]",
                description: [
                    "list the registered slugs, which project each came from,",
                    "and any scope naming a project this workspace lost",
                    "(--archived lists the projects that are set aside instead)"
                ],
                verbs: ["", "list"]
            },
            {
                syntax: "project init [--name s] [--desc d] [--no-connect]",
                description: ["register the directory this runs in, and render its agent block"],
                verbs: ["init"]
            },
            {
                syntax: "project link [slug] [path]",
                description: ["attach a registered project's directory on this machine"],
                verbs: ["link"]
            },
            {
                syntax: 'project from <parent-slug> --why "<reason>" [--supersedes <id>]',
                description: ["record that this project came from another registered one"],
                verbs: ["from"]
            },
            {
                syntax: 'project archive <slug> --why "<reason>"',
                description: ["set a project aside, with its open work as it stands"],
                verbs: ["archive"]
            },
            {
                syntax: 'project restore <slug> [--why "<reason>"]',
                description: ["bring an archived project back, in the state it was left"],
                verbs: ["restore"]
            }
        ],
        detail: [
            "list the projects this workspace holds, register one with it, attach one",
            "registered on another machine, or record which project this one came from.",
            "Every checkout of a registered git repository — worktrees included —",
            "resolves on its own; `link` with no slug infers it from the repository and",
            "only saves the probe.",
            "",
            "the bare list is the answer to \"which slugs does --scope and --project take\",",
            "and it reads the whole workspace: it takes neither flag, while init and link",
            "are writes that record into the workspace store they run against and from is",
            "a write that records into the project it runs in.",
            "",
            "`init` takes no path: it registers the directory it runs in, so a project is",
            "named by --name rather than by an argument that reads like a name and is",
            "read as a path. Attaching another checkout of a project already registered",
            "is `link`, the one registration verb whose job involves a path.",
            "",
            "`from` records one relation — this project came from that one — as a record",
            "carrying the parent's slug, its reason and its time. It runs in the child,",
            "and the listing above answers both directions: the parent on the child's row,",
            "and every child on the parent's. A project comes from one place, so a second",
            "`from` is refused and a correction restates it with --supersedes.",
            "",
            "`archive` sets a project aside: it leaves this listing, `self context` and",
            "every --workspace aggregate, and stays readable through --archived and an",
            "explicit --project <slug>. It is not retirement — open work neither blocks",
            "it nor is retired by it, and `restore` brings the project and every unit",
            "back in the state it was left. Nothing is recorded into an archived project",
            "until it is restored.",
            "",
            "`restore` is the only way back, and it takes --why for the archive that",
            "should never have been written. `self undo` is not a second one: it reads",
            "the project from the directory it runs in, and both verbs here name a slug",
            "so a workspace is tidied from anywhere — including when the project's",
            "checkout is on another machine.",
            "",
            "  --archived          list the projects that are set aside, with their reasons",
            "  --name <slug>       register under this slug instead of the directory name",
            "  --desc <text>       one-line description shown in the workspace view",
            "  --no-connect        skip writing the managed block into AGENTS.md and CLAUDE.md",
            "  --why <text>        why this project came from that one, why it is set aside,",
            "                      or why an archive should never have been written",
            "  --supersedes <id>   the derivation record this one corrects",
            "  --demote <id>       past the index cap: the index record that frees its place"
        ],
        node: branch({
            name: "project",
            unnamed: "options",
            refusal: projectRefusal,
            children: [
                leaf("", PROJECT_LIST_OPTIONS, 0, projectList),
                leaf("list", PROJECT_LIST_OPTIONS, 0, projectList),
                leaf("init", PROJECT_INIT_OPTIONS, 1, projectInit),
                leaf("link", {}, 2, ({ positionals }) => projectLink(positionals[0], positionals[1])),
                PROJECT_FROM_LEAF,
                PROJECT_ARCHIVE_LEAF,
                PROJECT_RESTORE_LEAF
            ]
        })
    },
    {
        name: "remote",
        usage: [{ syntax: "remote add <url>", description: ["connect the workspace store to a git remote"], verbs: ["add"] }],
        detail: ["set the git remote that `self sync` pushes the workspace store to."],
        node: branch({
            name: "remote",
            unnamed: "refuse",
            refusal: "usage: self remote add <url>",
            children: [
                leaf("add", {}, 1, ({ positionals }) =>
                    remoteAdd(requireWorkspace(process.cwd()), requireText(positionals[0], "remote add <url>")))
            ]
        })
    },
    {
        name: "sync",
        usage: [{ syntax: "sync", description: ["pull, refold, and push the workspace store"], verbs: [""] }],
        detail: ["commit pending state, rebase on the remote, re-derive canonical files, and push."],
        node: leaf("", {}, 0, () => syncStore(requireWorkspace(process.cwd())))
    },
    {
        name: "clone",
        usage: [{ syntax: "clone <url> [dir]", description: ["clone a workspace store onto a new machine"], verbs: [""] }],
        detail: ["clone an existing workspace store and point this machine at it."],
        node: leaf("", {}, 2, ({ positionals }) => cloneStore(requireText(positionals[0], "clone <url> [dir]"), positionals[1]))
    },
    {
        name: "goal",
        usage: [
            { syntax: 'goal add "<text>" [--supersedes <id>]', description: ["record a long-term goal, replacing ones it corrects"], verbs: ["add"] },
            { syntax: 'goal retract <id> --why "<reason>"', description: ["withdraw a goal with nothing replacing it"], verbs: ["retract"] }
        ],
        detail: [
            "record an outcome this project exists to reach, or withdraw one by its id.",
            "",
            "  --supersedes <id>     the goal this one replaces, repeatable",
            "  --why <text>          why a withdrawn goal no longer holds; every withdrawal carries one",
            "  --demote <id>         past a retention cap: the confirmed entity that frees its place by",
            "                        moving one tier down (full → index, index → search); repeatable",
            "",
            "a project holds as many goals as it means to: recording one displaces",
            "nothing. Replacing a goal is stated with --supersedes, never implied by",
            "stating another."
        ],
        node: branch({
            name: "goal",
            unnamed: "refuse",
            // `goal set` was the one destructive verb whose caller never named
            // what it destroyed, so it is refused rather than kept working
            // under a spelling that no longer describes what happens.
            refusal: (verb) => verb === "set"
                ? 'goal set is now `self goal add "<text>"` — the goal it replaces is named with --supersedes <id> rather than implied'
                : 'usage: self goal add "<text>" [--supersedes <id>] | retract <id> --why w',
            children: [
                leaf("add", GOAL_OPTIONS, 1, goalAdd),
                leaf("retract", GOAL_OPTIONS, 1, goalRetract, { requires: [WHY_REQUIRED] })
            ]
        })
    },
    OBJECTIVE_COMMAND,
    MILESTONE_COMMAND,
    {
        name: "decide",
        usage: [
            { syntax: 'decide "<text>" [--why w] [--proposed] [--supersedes id] [--work id] [--blocks id] [--after id]', verbs: [""] },
            { syntax: "decide confirm <event-id>", description: ["confirm a proposed decision"], verbs: ["confirm"] },
            {
                syntax: 'decide decline <event-id> --why "<reason>"',
                description: ["turn down a proposal; it leaves \"waiting on you\" at once"],
                verbs: ["decline"]
            },
            {
                syntax: 'decide retract <event-id> --why "<reason>"',
                description: [
                    "take back a confirmed decision with nothing replacing it",
                    "it stops rendering as current and stays inspectable in search"
                ],
                verbs: ["retract"]
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
            "  --demote <id>         past a retention cap: the confirmed entity that frees its place by",
            "                        moving one tier down (full → index, index → search); repeatable",
            "",
            "--blocks is what ranks a proposal: `self context` and `self status` say",
            "whether confirming it unblocks work, cannot be decided yet, or only",
            "records a rule the gated work already landed under.",
            "",
            "--supersedes replaces a decision, `retract` withdraws one with nothing in",
            "its place, and `decline` answers a proposal. None of the three rewrites",
            "history: the record keeps its text and gains a status."
        ],
        node: branch({
            name: "decide",
            // `confirm`, `retract` and `decline` are the only subcommands:
            // every other first argument is the decision text, which may itself
            // start with a dash after `--`. Only the withdrawals take `--why`,
            // so asking `confirm` for one is still named as a flag it does not
            // have.
            unnamed: "text",
            refusal: 'usage: self decide "<text>" | confirm <id> | retract <id> --why w | decline <id> --why w',
            children: [
                leaf("", DECIDE_OPTIONS, 1, cmdDecide),
                leaf("confirm", {}, 1, ({ positionals }) => confirmDecision(positionals[0])),
                leaf("decline", WITHDRAW_OPTIONS, 1, ({ values, positionals }) =>
                    withdrawDecision(requireProject(process.cwd()), "decline", positionals[0], values.why),
                { requires: [{ flags: ["why"], hint: "why the proposed decision was turned down" }] }),
                leaf("retract", WITHDRAW_OPTIONS, 1, ({ values, positionals }) =>
                    withdrawDecision(requireProject(process.cwd()), "retract", positionals[0], values.why),
                { requires: [WHY_REQUIRED] })
            ]
        })
    },
    {
        name: "work",
        usage: [
            {
                syntax: "work [--project <slug>] [--pretty|--plain]",
                description: ["list open work, from any directory with --project", "(a terminal gets the ruled table; a pipe gets one line per unit)"],
                verbs: [""]
            },
            {
                syntax: 'work add "<required outcome>" [--supersedes <work-id> --why w]',
                description: ["create a work unit; --supersedes retires the unit it replaces, naming this one its successor"],
                verbs: ["add"]
            },
            {
                syntax: "work show <id> [--history [--page n]] [--project <slug>]",
                description: [
                    "print full work detail: brief, reports, evidence",
                    "(resolves the owning project from any directory)",
                    "--history prints this unit's own events instead, oldest first"
                ],
                verbs: ["show"]
            },
            {
                syntax: "work start <id>",
                description: ["pick a unit up: prints its brief and reports, and records the claim", "(if another session holds it, that is disclosed — never refused)"],
                verbs: ["start"]
            },
            {
                syntax: "work block|unblock <id>",
                description: ["move a work unit (block: --on decision|dependency|external [--why w])"],
                verbs: ["block", "unblock"]
            },
            {
                syntax: 'work done <id> [--report "<what verifiably happened>"] [--why w]',
                description: [
                    "close a unit whose outcome was reached; the claim must carry evidence",
                    "(a report with a commit or artifact, or the done-time --report text)"
                ],
                verbs: ["done"]
            },
            {
                syntax: "work link|unlink <id> --objective o [--objective-project <slug>] | --milestone m",
                description: [
                    "state, or withdraw, what a work unit contributes to",
                    "(an objective resolves here first, then across every registered project)"
                ],
                verbs: ["link", "unlink"]
            },
            { syntax: 'work propose "<outcome>" --milestone m --value v --success s --stop s --risk r', verbs: ["propose"] },
            { syntax: "work accept|decline <proposal-id> [--why w]", description: ["act on a goal-gap proposal; decline states why"], verbs: ["accept", "decline"] },
            {
                syntax: "work started <id> --pid N | exited <id> [--code N]",
                description: ["record the agent process running a unit, and how it ended", "liveness is judged at read time from the pid on this machine"],
                verbs: ["started", "exited"]
            },
            {
                syntax: "work retire <id> --why w [--successor <work-id>] [--successor-project <slug>]",
                description: [
                    "retire the unit itself: its outcome was given up or moved, not reached",
                    "history stays inspectable; the unit stops counting as open work"
                ],
                verbs: ["retire"]
            }
        ],
        detail: [
            "create and move units of work, and state what each contributes to.",
            "`work add` prints the new id.",
            "",
            "`work start` is how a session picks a unit up: it prints the brief and the",
            "report history, and records that this session took it. `work show` is the",
            "same reading with nothing recorded, so looking at a unit is never a claim.",
            "A unit another session already holds is disclosed with when it was taken,",
            "and never refused — the claim tells you who is on it, it does not lock it.",
            "",
            "a unit's outcome is immutable once recorded, so correcting it restates it:",
            '`work add "<corrected outcome>" --supersedes <id> --why w` records the new unit',
            "and retires the one it replaces with the new unit as its successor — the same",
            "pair `work retire --successor` records, spelled the way every other add verb",
            "spells a correction.",
            "",
            "done is the judgment that the outcome was reached, and the claim must",
            "carry evidence: a report with a commit or an artifact, or a done-time",
            "--report stating what verifiably happened — a bare summary never",
            "satisfies. Declared criteria additionally gate it. Done is allowed",
            "while blocked: completion is a judgment on the outcome, not the block.",
            "",
            "history is per unit and explicit: `work show <id> --history` prints the",
            "events of that unit alone, oldest first, ten to a page. A retired or",
            "superseded unit answers there too — nothing is made unreachable, and a",
            "superseded unit names its successor rather than folding it in.",
            "",
            "  --project <slug>      list or show against this project, from any directory",
            "  --history             print this unit's own events instead of its brief",
            "  --page <n>            which page of that history, ten events to a page",
            "  --on <reason>         what a blocked unit waits on: decision, dependency, or external",
            "  --why <text>          detail recorded with the block, a revision, or the done,",
            "                        and why a superseded or retired unit gave up its outcome",
            "  --supersedes <id>     the unit this one replaces: it retires with this unit as",
            "                        its successor, and --why states why the outcome moved",
            "  --report <text>       what verifiably happened, recorded as a report with the done",
            "  --successor <id>      the unit that carries a retired outcome now, resolved workspace-wide",
            "  --successor-project <slug>  the successor's project when its id is ambiguous",
            "  --objective <id>      the objective a linked unit contributes to, resolved in",
            "                        this project first and then across every registered one",
            "  --objective-project <slug>  the objective's project when its id is ambiguous,",
            "                        or to name where it resolves outright",
            "  --milestone <id>      the milestone a linked or proposed unit contributes to,",
            "                        resolved in the current project only",
            "  --value <text>        why the proposed work matters",
            "  --success <text>      what done looks like for the proposal",
            "  --stop <text>         the condition that ends the proposal early",
            "  --risk <text>         what could go wrong",
            "  --capacity <text>     the effort the proposal asks for",
            "  --evidence-plan <e>   how the outcome will be evidenced",
            "  --confidence <level>  low, medium, or high",
            "  --expires <date>      when an unanswered proposal lapses"
        ],
        node: branch({
            name: "work",
            unnamed: "options",
            refusal: (verb) => `unknown work subcommand "${verb}" — use add|show|start|started|exited|block|unblock|done|retire|link|unlink|propose|accept|decline`,
            children: WORK_CHILDREN
        })
    },
    {
        name: "undo",
        usage: [
            {
                syntax: 'undo <event-id> --why "<why the retirement was wrong>"',
                verbs: [""]
            }
        ],
        detail: [
            "take back one retirement, supersession, withdrawal or link. Nothing else",
            "is undone: the id names the event to take back, and any other kind of",
            "event is refused rather than guessed at.",
            "",
            "A project archive is not among them. It is ended by `self project restore",
            "<slug>`, which runs from anywhere the archive did — this verb would need",
            "the project's checkout, and a project that is set aside frequently has",
            "none on this machine.",
            "",
            "The record comes back and the log keeps both halves — what happened and",
            "what took it back. A supersession's successor stays; it simply stops",
            "claiming to replace anything, which is the accident this answers: a",
            "record that belonged, carrying a link that did not.",
            "",
            "No terminal is needed. Retiring a record is a person's call because it",
            "cannot be taken back; this is the taking back, and gating it would",
            "contradict the reason the other gate exists.",
            "",
            "  --why <text>    why the retirement was wrong"
        ],
        node: leaf("", WITHDRAW_OPTIONS, 1, ({ values, positionals }) =>
            cmdUndo(requireProject(process.cwd()), positionals[0], values.why), { requires: [WHY_REQUIRED] })
    },
    {
        name: "report",
        usage: [
            {
                syntax: 'report <work-id> "<summary>" [--file path] [--evidence v] [--artifact path] [--next n]',
                verbs: [""]
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
        ],
        node: leaf("", REPORT_OPTIONS, 2, cmdReport)
    },
    ARTIFACT_COMMAND,
    {
        name: "convention",
        usage: [
            { syntax: 'convention add "<text>" [--supersedes <event-id>] [--workspace]', description: ["record a rule, optionally replacing ones it corrects"], verbs: ["add"] },
            { syntax: 'convention drop <event-id> --why "<reason>"', description: ["retire a convention with nothing replacing it"], verbs: ["drop"] }
        ],
        detail: [
            "record a rule this project works by, or retire one by its event id.",
            "",
            "  --supersedes <id>     the convention this one replaces, repeatable",
            "  --why <text>          why a dropped rule no longer holds; every withdrawal carries one",
            "  --workspace           record at workspace scope: the rule renders in every",
            "                        project's context; its record stays in this project's store",
            "  --demote <id>         past a retention cap: the confirmed entity that frees its place by",
            "                        moving one tier down (full → index, index → search); repeatable",
            "",
            "correcting a rule is one event, not a drop and a re-add: the replacement",
            "carries the lineage, so the pair can never both read as current."
        ],
        node: branch({
            name: "convention",
            unnamed: "refuse",
            refusal: 'usage: self convention add "<text>" [--supersedes <event-id>] [--workspace] | drop <event-id> --why w',
            children: [
                leaf("add", CONVENTION_OPTIONS, 1, conventionAdd),
                leaf("drop", CONVENTION_OPTIONS, 1, conventionDrop, { requires: [WHY_REQUIRED] })
            ]
        })
    },
    STATE_COMMAND,
    ALIAS_COMMAND,
    {
        name: "connect",
        usage: [
            {
                syntax: "connect [--global]",
                description: [
                    "render the agent-onboarding block into AGENTS.md and CLAUDE.md",
                    "(--global: into this machine's agent instruction files)"
                ],
                verbs: [""]
            }
        ],
        detail: [
            "write the managed block that tells any agent tool how this project",
            "records its state.",
            "",
            "  --global    write into this machine's agent instruction files instead"
        ],
        node: leaf("", { global: { type: "boolean" } }, 0, ({ values }) => cmdConnect(values.global === true))
    },
    {
        name: "view",
        usage: [{ syntax: "view [slug]", description: ["open the live workspace or project view in the browser at a terminal"], verbs: [""] }],
        detail: [
            "open the HTML view the last fold rendered: the workspace, or one project.",
            "Without an interactive terminal, `view` prints the rendered path and",
            "launches nothing."
        ],
        node: leaf("", {}, 1, ({ positionals }) => cmdView(positionals[0]))
    },
    {
        name: "context",
        usage: [{ syntax: "context [--project <slug>] [--pretty|--plain]", description: ["print derived context for agents"], verbs: [""] }],
        detail: [
            "print this project's current truth: the placed entities — goal, conventions,",
            "decisions, everything asserted — in priority order and at their exposure,",
            "with the derived live state (work moving, waits, deadlines) anchored after",
            "the full-text block.",
            "piped output is capped at 3,000 context tokens per project; every omission names",
            "the command that recovers the omitted state in full.",
            "a terminal gets the ruled render instead, which carries no cap; --plain forces",
            "the capped agent output anywhere, --pretty forces the ruled render.",
            "there is no --workspace form: run from outside every project, `context` already",
            "summarizes the whole workspace.",
            "",
            "  --project <slug>    read this registered project instead of this directory's"
        ],
        // `context` has no workspace form because it already is one: run from
        // outside any project, it renders the workspace summary, and --project
        // names one project to read instead of the directory's own.
        node: leaf("", SCOPED_RENDER_OPTIONS, 0, ({ values }) =>
            contextOutput(readScope(process.cwd(), values)))
    },
    {
        name: "status",
        usage: [
            {
                syntax: "status [--project <slug>] [--workspace] [--pretty|--plain]",
                description: ["print a short state summary"],
                verbs: [""]
            }
        ],
        detail: [
            "print what waits on you, what is moving, and any health signals.",
            "an open unit with a recorded process shows its state — running, stale,",
            "or exited — judged on this machine at read time.",
            "",
            "  --project <slug>    summarize this registered project instead of this directory's",
            "  --workspace         one line per registered project, from anywhere"
        ],
        node: leaf("", WORKSPACE_RENDER_OPTIONS, 0, ({ values }) =>
            statusOutput(readScope(process.cwd(), values)))
    },
    {
        name: "setup",
        usage: [{ syntax: "setup", description: ["print the workspace, project, and store this directory resolves to"], verbs: [""] }],
        detail: ["explain how this directory resolves, and what to run when it resolves to nothing."],
        node: leaf("", {}, 0, () => setupOutput(process.cwd()))
    },
    {
        name: "log",
        usage: [{ syntax: "log [-n N] [--project <slug>] [--workspace]", description: ["print recent events"], verbs: [""] }],
        detail: [
            "print the project's event log, newest last.",
            "--workspace merges every registered project onto one timeline and leads each",
            "line with the project it happened in.",
            "",
            "  -n <count>          how many events to print (default 20)",
            "  --project <slug>    read this registered project instead of this directory's",
            "  --workspace         every registered project's events on one timeline"
        ],
        node: leaf("", LOG_OPTIONS, 0, cmdLog)
    },
    {
        name: "search",
        usage: [{
            syntax: "search [query] [--type <kind>] [--exposure <tier>|--all] [--project p]",
            description: ["find live records context does not show (query optional with a narrowing flag)"],
            verbs: [""]
        }],
        detail: [
            "search answers over live records, not the log. Its default is every live",
            "record the current context render does not show: the search tier, plus the",
            "index and full records the context budget cut. A superseded, retired,",
            "retracted or done record is not in the answer, and no flag reaches one.",
            "",
            "each hit is one readable row — the project, the record kind, the id, and",
            "the record's text cut to one line. `self state show <id>` prints the whole",
            "record, and `self state show <id> --history` its own events.",
            "",
            "every registered project answers, the current one's rows first. the query",
            "may be omitted when --type, --exposure, --all or --project narrows the pull.",
            "",
            "  --type <kind>       only records of this kind: goal, decision, convention,",
            "                      objective, milestone, work, or entity",
            "  --exposure <tier>   only records placed at full, index, or search",
            "  --all               every live record, whether context renders it or not",
            "  --project <slug>    only this project"
        ],
        node: leaf("", SEARCH_OPTIONS, 1, cmdSearch)
    },
    {
        name: "fold",
        usage: [{ syntax: "fold", description: ["re-derive canonical files from the log"], verbs: [""] }],
        detail: ["rebuild state files, work briefs, and HTML views from the event log."],
        node: leaf("", {}, 0, cmdFold)
    },
    LOGIN_COMMAND,
    LOGOUT_COMMAND,
    WHOAMI_COMMAND,
    APP_COMMAND
];

// The composed names are what `alias add` refuses as reserved (#207 A5); the
// preset verbs among them are table rows, which the registration filters out.
registerReservedVerbs(COMMANDS.map((command) => command.name));

// The same handover, for the other surface that can create a verb collision:
// `self app install` refuses a plugin whose verb is a built-in or already an
// alias row. `registerReservedVerbs` keeps its module-load snapshot untouched —
// teaching it about plugin verbs would mean reading the plugin directory on
// every invocation, which is exactly what cell 1 forbids.
registerHostVerbs(COMMANDS.map((command) => command.name),
    (verb) => resolveAliasCommand(process.cwd(), verb) !== null);

// And the mirror of it: an alias row may not shadow a verb a plugin claims.
// This reads the verb index, so it runs only when `alias add` actually asks —
// never on the path a built-in verb takes.
registerPluginClaims((verb) => pluginVerbs().has(verb));

/* ── the workspace and project verbs this module implements ────────── */

async function cmdInit({ values }: CommandInput<typeof INIT_OPTIONS>): Promise<CommandOutput>
{
    const cwd = process.cwd();
    const storeDir = join(cwd, STORE_DIR);
    if (existsSync(storeDir))
    {
        if (!isStore(storeDir))
        {
            throw new CliError(`${storeDir} already exists and is not a workspace store — another tool owns that directory`);
        }
        return [{ kind: "receipt", text: `workspace already initialized at ${storeDir}` }];
    }
    const lang = validLang(values.lang ?? await askLang());
    ensureDir(storeDir);
    writeFileSync(join(storeDir, "registry.jsonl"), "");
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({ lang }) + "\n");
    ensureWorkspaceRepo(storeDir);
    ensureSyncConfig(storeDir);
    excludeLocally(cwd, STORE_DIR + "/");
    commitAll(storeDir, "self init");
    setMachineWorkspace(cwd);
    const opened: CommandOutput = [{ kind: "receipt", text: `workspace initialized at ${storeDir} (views in "${lang}")` }];
    const agents = values.agents === true || await askAgents();
    return agents ? [...opened, ...connectMachineAgents()] : opened;
}

// Asked once, at the only moment a person is certain to be present.
async function askAgents(): Promise<boolean>
{
    if (!process.stdin.isTTY || !process.stdout.isTTY)
    {
        return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("tell the agents on this machine about self, so they offer to register projects? [Y/n]: ");
    rl.close();
    return !answer.trim().toLowerCase().startsWith("n");
}

// Nothing written is still an answer: the block a person has to paste is what
// the write would have produced, so it comes back as the page it is rather
// than as a sentence with newlines in it.
function connectMachineAgents(): CommandOutput
{
    const files = connectMachine();
    if (files.length > 0)
    {
        return [{ kind: "receipt", text: `agents on this machine now know about self — block written into ${files.join(", ")}` }];
    }
    return [
        { kind: "receipt", text: "no agent instruction files found on this machine — paste this into yours:\n" },
        { kind: "document", plain: () => machineBlock().split("\n") }
    ];
}

function cmdWorkspace(path: string | undefined): CommandOutput
{
    if (path === undefined)
    {
        // The sentence a machine with no pointer gets is the value, not a
        // refusal: nothing was asked for that could not be answered, and the
        // answer is where to make the workspace that is missing.
        return [{ kind: "value", text: machineWorkspace() ?? "no workspace set — run `self init` in the directory that should hold it" }];
    }
    const dir = resolve(path);
    if (!isStore(join(dir, STORE_DIR)))
    {
        throw new CliError(`${dir} holds no workspace store — run \`self init\` there first`);
    }
    setMachineWorkspace(dir);
    return [{ kind: "receipt", text: `this machine now uses the workspace at ${dir}` }];
}

async function askLang(): Promise<string>
{
    if (!process.stdin.isTTY || !process.stdout.isTTY)
    {
        return "en";
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("language for the HTML views (en, ko, …) [en]: ");
    rl.close();
    return answer.trim() === "" ? "en" : answer.trim();
}

function validLang(code: string): string
{
    const lang = code.trim().toLowerCase();
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(lang))
    {
        throw new CliError(`"${code}" is not a language code — use a BCP 47 code like en, ko, ja`);
    }
    return lang;
}

// The pilot for the render gate: the read answers with the one value it was
// asked for, the write with what it recorded, and the printing is the gate's.
// The bytes are what they always were — a migrated verb is not a redesigned one.
function cmdLang(code: string | undefined): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    if (code === undefined)
    {
        return [{ kind: "value", text: readStoreConfig(ctx.storeDir).lang ?? "en" }];
    }
    const lang = validLang(code);
    writeConfig(ctx, { lang }, `lang set ${lang}`);
    return [{ kind: "receipt", text: `views now render in "${lang}"` }];
}

function cmdTimezone(zone: string | undefined): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    if (zone === undefined)
    {
        return [{ kind: "value", text: readStoreConfig(ctx.storeDir).timezone ?? DEFAULT_ZONE }];
    }
    const timezone = validZone(zone);
    writeConfig(ctx, { timezone }, `timezone set ${timezone}`);
    return [{ kind: "receipt", text: `target dates are now judged in "${timezone}"` }];
}

function cmdTheme(name: string | undefined): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    if (name === undefined)
    {
        return [{ kind: "value", text: readStoreConfig(ctx.storeDir).theme ?? "violet" }];
    }
    const theme = validTheme(name);
    writeConfig(ctx, { theme }, `theme set ${theme}`);
    return [{ kind: "receipt", text: `views now render with the "${theme}" accent` }];
}

function cmdTokens(tokens: string | undefined, characters: string | undefined): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    if (tokens === undefined)
    {
        const scale = tokenScale(readStoreConfig(ctx.storeDir));
        return [{ kind: "value", text: `${scale.perCharacter} tokens per character — ${scale.measured ? "measured" : "the shipped estimate"}` }];
    }
    const measured = countArgument(tokens, "tokens");
    const held = countArgument(characters, "characters");
    if (measured > held)
    {
        throw new CliError(`${measured} tokens from ${held} characters — no tokenizer emits more tokens than the text has `
            + "characters, so the arguments are the wrong way round: `self tokens <tokens> <characters>`");
    }
    writeConfig(ctx, { tokensPerCharacter: measured / held, tokensMeasured: true },
        `tokens measured at ${measured / held} per character`);
    return [{ kind: "receipt", text: `${measured / held} tokens per character — measured from ${measured} tokens of ${held} characters` }];
}

// Both arguments are counts of real things, so both are whole and positive.
function countArgument(value: string | undefined, name: string): number
{
    const parsed = Number(requireText(value, "tokens [<tokens> <characters>]"));
    if (!Number.isSafeInteger(parsed) || parsed <= 0)
    {
        throw new CliError(`${name} must be a whole number above zero — a measurement counts something that was there`);
    }
    return parsed;
}

// A view setting reaches every page only through a refold, so writing the
// config and re-rendering every project is one step.
function writeConfig(ctx: CliContext, patch: StoreConfig, message: string): void
{
    const config = { ...readStoreConfig(ctx.storeDir), ...patch };
    writeFileSync(join(ctx.storeDir, "config.json"), JSON.stringify(config) + "\n");
    foldEveryProject(ctx.storeDir);
    commitAll(ctx.storeDir, message);
}

// Four ways the same project is already here: the marker this directory
// already carries, another checkout of it, the slug itself, or a registry row
// whose registration never finished. `workspace` is none of them — it is the
// scope value that means every registered project (#181 T1.10), so a project
// answering to it would make `--scope workspace` ambiguous between one project
// and all of them.
//
// Every branch runs before the first byte is written (#251): registering wrote
// the registry row first and validated afterwards, so a refusal that arrived
// late left a project half in the workspace and not in it.
function refuseDuplicateProject(storeDir: string, projectDir: string, slug: string): void
{
    if (slug === "workspace")
    {
        throw new CliError('"workspace" is reserved — `--scope workspace` means every registered project, '
            + "so no single project may answer to it; register this one with `--name <slug>`");
    }
    refuseRegisteredHere(storeDir, projectDir);
    const sibling = siblingSlug(storeDir, projectDir);
    if (sibling !== null)
    {
        throw new CliError(`"${projectDir}" is another checkout of the registered project "${sibling}" — run \`self project link ${sibling}\` instead of registering a duplicate`);
    }
    refuseTakenSlug(storeDir, projectDir, slug);
}

// The marker names the project this directory already is, so registering it a
// second time is answered with that name rather than with whatever slug the
// call asked for. An archived project is answered with `restore` instead
// (#283): bringing one back is a state change on the project that is here, and
// a second registration would split its state in two.
function refuseRegisteredHere(storeDir: string, projectDir: string): void
{
    const marker = join(projectDir, MARKER_FILE);
    if (!existsSync(marker))
    {
        return;
    }
    const slug = JSON.parse(readFileSync(marker, "utf8")).project;
    refuseArchived(storeDir, slug, "registering it again would split its state in two");
    throw new CliError(`"${projectDir}" is already registered as project "${slug}" — run \`self context\` to read its state`);
}

// A slug is taken whether or not the registration that took it finished. The
// holder is named where a directory is known, and where none is — a registry
// row whose marker was never written — completing it is the link, so both
// remedies are handed over in the one pass.
function refuseTakenSlug(storeDir: string, projectDir: string, slug: string): void
{
    if (!readRegistry(storeDir).some((entry) => entry.slug === slug))
    {
        return;
    }
    const held = resolveProjectPath(storeDir, slug, projectDir);
    throw new CliError(`project "${slug}" is already registered${held === null
        ? " in this workspace, with no directory linked on this machine" : ` at ${held}`}`
        + ` — run \`self project link ${slug}\` here if this directory is that project,`
        + " or `self project init --name <slug>` to register it under another slug");
}

// `add` took a path positional that reads like a name: `self project add
// hyunam` inside `hyunam` meant the subfolder, not the name (#251). A verb
// removed over that mistake owes the caller both verbs that replaced it,
// which is why the removal is answered here rather than by the usage line.
function projectRefusal(verb: string | undefined): string
{
    if (verb === "add")
    {
        return "`self project add` is gone — run `self project init` inside the directory to register it, "
            + "or `self project link <slug>` if it is a checkout of a project registered already";
    }
    return 'usage: self project | init [--name <slug>] [--desc "<description>"] | link [slug] [path]'
        + ' | from <parent-slug> --why "<reason>"';
}

// The leaf accepts one positional so a path can be refused by name here. The
// arity gate would answer a stray argument with the syntax alone, and the
// mistake this verb exists to end is precisely a caller who believes it takes
// one (#251 T1.8).
function projectInit({ values, positionals }: CommandInput<typeof PROJECT_INIT_OPTIONS>): CommandOutput
{
    if (positionals[0] !== undefined)
    {
        throw new CliError(`\`self project init\` takes no path — it registers the directory it runs in, so run it inside `
            + `"${positionals[0]}" to register that one, and name it with \`--name <slug>\``);
    }
    const ctx = requireWorkspace(process.cwd());
    const projectDir = resolve(process.cwd());
    const slug = values.name ?? basename(projectDir);
    refuseDuplicateProject(ctx.storeDir, projectDir, slug);
    registerProject(ctx, projectDir, slug, values.desc);
    const registered: CommandOutput = [{ kind: "receipt", text: `project "${slug}" registered` }];
    if (values["no-connect"] === true)
    {
        return registered;
    }
    return [...registered, ...blockReceipt(connectProject(projectDir, buildModel(ctx.storeDir, slug, new Date())))];
}

// Every write a registration makes, reached only once every refusal above has
// passed. Nothing here can be undone by a later validation, so no validation
// may stand later than this call.
function registerProject(ctx: CliContext, projectDir: string, slug: string, description: string | undefined): void
{
    const entry: Record<string, unknown> = { slug, added: new Date().toISOString() };
    if (description !== undefined)
    {
        entry.description = description;
    }
    appendFileSync(join(ctx.storeDir, "registry.jsonl"), JSON.stringify(entry) + "\n");
    // The registry this process already read no longer says what the file says.
    // Resolution is cached in memory until something clears it, so the writer
    // of a cached file is the one that has to say it moved (#128).
    invalidateResolution();
    linkProject(ctx, slug, projectDir);
    ensureDir(join(projectStateDir(ctx.storeDir, slug), "work"));
    foldProject(ctx.storeDir, slug);
    commitAll(ctx.storeDir, `project init ${slug}`);
}

// The registered slugs, which is what every `--scope <slug>` and `--project
// <slug>` refusal points a caller at, and the one diagnostic the registry can
// answer on its own: a record whose scope names a project this workspace does
// not have renders nowhere (#181 T3.10), so it is named here rather than
// silently disappearing from every context. It is also where both directions
// of the derivation relation are read (#75 R2): the parent under the child's
// row, the children under the parent's. A project whose state cannot be read
// is named and skipped rather than thrown (T4.5) — this verb answers about the
// workspace as a whole, and one broken store must not take the rest with it.
// An archived project is out of this listing and in `--archived` instead
// (#283): the bare list answers "what is this workspace working on".
function projectList({ values }: CommandInput<typeof PROJECT_LIST_OPTIONS>): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    if (values.archived === true)
    {
        return [archivedListing(ctx.storeDir)];
    }
    const { models, unreadable } = readableModels(ctx.storeDir);
    const registered = new Set(readRegistry(ctx.storeDir).map((entry) => entry.slug));
    // The size is the projects, not the lines under them: a parent, a child, an
    // unreadable store and a dangling scope each add a line that is about a
    // project rather than being one.
    return [{
        kind: "listing",
        rows: models.length === 0 && unreadable.length === 0
            ? [emptyWorkspaceLine(ctx.storeDir)]
            : [
                ...models.flatMap((model) => [projectRow(model, ctx.project), ...derivationLines(models, model, registered)]),
                ...unreadable,
                ...danglingScopes(models, registered)
            ],
        total: models.length,
        noun: "project"
    }];
}

function emptyWorkspaceLine(storeDir: string): string
{
    return readRegistry(storeDir).length === 0
        ? "no projects registered — run `self project init` inside a project directory"
        : "every registered project is archived — run `self project --archived` to list them";
}

function projectRow(model: ProjectModel, here: string | undefined): string
{
    const mark = model.slug === here ? "  (this directory)" : "";
    return `${model.slug}${model.description === undefined ? "" : ` — ${model.description}`}${mark}`;
}

function danglingScopes(models: ProjectModel[], registered: Set<string>): string[]
{
    const lines: string[] = [];
    for (const model of models)
    {
        for (const entity of model.entities.filter((item) => isLive(item)))
        {
            const target = scopeTarget(entity, model.slug);
            if (target !== "workspace" && !registered.has(target))
            {
                lines.push(`dangling scope: ${entity.id} in ${model.slug} renders in "${target}", which is not registered — `
                    + `run \`self state place ${entity.id} --scope <slug>\` to bring it back`);
            }
        }
    }
    return lines;
}

function projectLink(wanted: string | undefined, path: string | undefined): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    const projectDir = resolve(path ?? process.cwd());
    if (!existsSync(projectDir))
    {
        throw new CliError(`"${projectDir}" does not exist`);
    }
    const slug = wanted ?? inferredSlug(ctx.storeDir, projectDir);
    if (!readRegistry(ctx.storeDir).some((entry) => entry.slug === slug))
    {
        throw new CliError(`project "${slug}" is not registered — run \`self project init\` inside its directory instead`);
    }
    linkProject(ctx, slug, projectDir);
    // A registry row can stand with no state directory behind it — the shape a
    // crashed registration leaves — and this verb is the completion path the
    // init refusal names (#251 T1.7). The fold writes into that directory, so
    // it is guaranteed here exactly as registerProject guarantees it (#257).
    ensureDir(join(projectStateDir(ctx.storeDir, slug), "work"));
    foldProject(ctx.storeDir, slug);
    return [{ kind: "receipt", text: `project "${slug}" linked to ${projectDir}` }];
}

// Omitting the slug is the worktree case: the repository already answers which
// project this checkout belongs to, and linking it only saves the probe. It
// answers for this directory only when a registered project sits at it or
// above it. At a monorepo root the registered projects sit *below* it, and
// inferring one there linked the whole worktree to a subdirectory project,
// which then claimed every checkout of the repository on the machine (#114).
// The candidates are named instead — which of them was meant is the one thing
// the repository cannot say.
function inferredSlug(storeDir: string, projectDir: string): string
{
    const here = checkoutProject(storeDir, projectDir);
    if (here !== null)
    {
        return here.slug;
    }
    const below = checkoutMatches(storeDir, projectDir).filter((match) => match.dir.startsWith(projectDir + sep));
    if (below.length > 0)
    {
        throw new CliError(`"${projectDir}" is the root of a repository whose registered projects sit below it ` +
            `(${below.map((match) => `${match.slug} at ${match.dir}`).join(", ")}) — ` +
            `name the one you mean, or run \`self project link\` from its directory`);
    }
    return requireText(undefined, "project link <slug> [path]");
}

function cmdView(slug: string | undefined): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    if (slug !== undefined)
    {
        requireRegistered(ctx.storeDir, slug);
    }
    return openFile(ctx, viewFile(ctx.storeDir, slug));
}

// The link records which repository stood here, not the path alone: a path is
// reused by whatever is created at it next, and resolution has to be able to
// tell the linked checkout from its replacement. Re-linking a path whose
// recorded repository is gone replaces the claim, so this verb is the remedy
// the stale-link warning names rather than a no-op that reports success (#115).
function linkProject(ctx: CliContext, slug: string, projectDir: string): void
{
    excludeLocally(ctx.storeDir, LINKS_FILE);
    if (recordLink(ctx.storeDir, slug, projectDir, repositoryIdentity(projectDir)))
    {
        // A disclosure the caller is owed before the link is replaced, not the
        // verb's answer: it prints where it stands, through the gate's notice,
        // so nothing moves relative to the recorded line that follows it.
        notice(`replacing the repository previously linked at ${projectDir}`);
    }
    writeFileSync(join(projectDir, MARKER_FILE), JSON.stringify({ project: slug }) + "\n");
    excludeLocally(projectDir, MARKER_FILE);
}

// Every preset write is an entity write now (#207 B): the verb keeps its
// vocabulary and its refusals, the recorded event is the shared grammar's,
// and the printed line names the entity event it recorded (ruling ②). The
// entity id is the creation event's own id, exactly the id a goal or a
// decision has always answered to.
function presetPayload(row: ReturnType<typeof presetRow>, id: string, text: string, extra: Record<string, unknown>): Record<string, unknown>
{
    const payload: Record<string, unknown> = {
        entity: id,
        text,
        labels: [row.label],
        links: [],
        criteria: [],
        exposure: row.exposure,
        scope: "project",
        ...extra
    };
    if (row.priority !== undefined && payload.priority === undefined)
    {
        payload.priority = row.priority;
    }
    return payload;
}

// A demotion frees room for a record being added, and a withdrawal adds
// none — the flag is refused by name rather than dropped, on the verbs whose
// option table is shared with their add.
function refuseWithdrawalDemote(verb: string, demote: string[] | undefined): void
{
    if (demote !== undefined)
    {
        throw new CliError(`${verb} takes no --demote — a demotion frees room for a record being added, and a withdrawal adds none`);
    }
}

// The same cap gate `state add` passes (#240 R1): the tier a preset record
// enters is judged by the one shared check, so a preset add refuses exactly
// where the raw verb would — `--demote` and the supersession credit included.
function presetDemotions(ctx: ProjectContext, models: ProjectModel[], verb: string, exposure: Exposure,
    payload: Record<string, unknown>, values: CapGateValues, text: string): Placed[]
{
    const target = payload.scope === "workspace" ? "workspace" : ctx.project;
    const usage = verb === "decide" ? 'decide "<text>"' : `${verb} add "<text>"`;
    return admittingDemotions(ctx, models, values, tierOf(target, exposure),
        usage, countCharacters(text), supersedeTargets(payload));
}

function presetEntityEvent(ctx: ProjectContext, models: ProjectModel[], verb: string, text: string,
    extra: Record<string, unknown>, refs: EventRefs | undefined, values: CapGateValues): void
{
    const proposed = values.proposed === true;
    const event = makeEvent(ctx.project, proposed ? "entity.proposed" : "entity.confirmed", {}, refs, !proposed);
    const row = presetRow(ctx.storeDir, verb);
    const payload = presetPayload(row, event.id, text, extra);
    event.payload = payload;
    const demotions = presetDemotions(ctx, models, verb, row.exposure, payload, values, text);
    // Every preset kind corrects a record the same way, so they all reach the
    // gate through this one line rather than each add verb deciding. A
    // proposal displaces nothing until it is confirmed, and passes through.
    const displaced = proposed ? [] : supersedeTargets(payload);
    recordRetirement(ctx, retirementIntent(models[0], "supersede", displaced), models[0],
        (confirmation) =>
        {
            if (confirmation !== undefined)
            {
                event.payload = { ...payload, confirmation };
            }
            return [event, ...demotionEvents(demotions, event.id, proposed)];
        },
        text);
}

function goalAdd({ values, positionals }: CommandInput<typeof GOAL_OPTIONS>): void
{
    const text = requireText(positionals[0], 'goal add "<text>" [--supersedes <id>]');
    if (values.why !== undefined)
    {
        throw new CliError("goal add takes no --why — the goal is its own statement; --why records why a goal was withdrawn");
    }
    const ctx = requireProject(process.cwd());
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const model = models[0];
    const extra: Record<string, unknown> = {};
    // What a new goal replaces is named, never inferred from what happens to
    // be standing. A project may aim at several outcomes at once, so stating
    // one more says nothing about the ones already recorded.
    if (values.supersedes !== undefined)
    {
        extra.links = values.supersedes.map((prefix) =>
        {
            requireSupersedeKind(model.entities, prefix, "goal");
            return { type: "supersedes", target: requireGoal(model, prefix).id };
        });
    }
    presetEntityEvent(ctx, models, "goal", text, extra, undefined, { demote: values.demote });
}

function goalRetract({ values, positionals }: CommandInput<typeof GOAL_OPTIONS>): void
{
    if (values.supersedes !== undefined)
    {
        throw new CliError('goal retract takes no --supersedes — to replace a goal, run `goal add "<text>" --supersedes <id>`');
    }
    refuseWithdrawalDemote("goal retract", values.demote);
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const goal = requireGoal(model, requireText(positionals[0], 'goal retract <id> --why "<why it no longer holds>"'));
    if (!isLive(goal))
    {
        throw new CliError(`${goal.id} is already ${goal.status} — a goal leaves once, and the first withdrawal is what happened`);
    }
    const payload = { entity: goal.id, why: required(values.why) };
    recordRetirement(ctx, retirementIntent(model, "retract", [goal.id]), model,
        (confirmation) => [makeEvent(ctx.project, "entity.retracted",
            confirmation === undefined ? payload : { ...payload, confirmation }, { retracts: goal.id }, true)],
        goal.text);
}

// Exact id first, then a unique prefix, over every goal the fold carries —
// legacy `goal.set` records and native goal entities answer through one
// lookup, and a withdrawn one is still found so the refusal can say so.
function requireGoal(model: ProjectModel, prefix: string): EntityState
{
    const goals = model.entities.filter((item) => item.source === "goal");
    const exact = goals.find((item) => item.id === prefix);
    if (exact !== undefined)
    {
        return exact;
    }
    const matches = goals.filter((item) => item.id.startsWith(prefix));
    if (matches.length > 1)
    {
        throw new CliError(`goal id "${prefix}" is ambiguous (${matches.length} matches) — spell more of it`);
    }
    if (matches.length === 0)
    {
        throw new CliError(`${prefix} is not a goal`);
    }
    return matches[0];
}

function cmdDecide({ values, positionals }: CommandInput<typeof DECIDE_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    const text = requireText(positionals[0], 'decide "<decision>" [--why w] [--proposed]');
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const model = models[0];
    const extra: Record<string, unknown> = {};
    if (values.why !== undefined)
    {
        extra.why = values.why;
    }
    if (values.supersedes !== undefined && values.supersedes.length > 0)
    {
        extra.links = values.supersedes.map((prefix) =>
        {
            requireSupersedeKind(model.entities, prefix, "decision");
            return { type: "supersedes", target: requireDecision(model, prefix).id };
        });
    }
    // The work link is stated, never inferred from what happens to be open:
    // most decisions belong to the project, not to a unit of work.
    presetEntityEvent(ctx, models, "decide", text, extra, decisionRefs(ctx, values),
        { proposed: values.proposed, demote: values.demote });
}

// Exact id first, then a unique prefix, over the folded records — legacy
// decisions and native decision entities answer through one lookup.
function requireDecision(model: ProjectModel, prefix: string | undefined): DecisionState
{
    const wanted = requireText(prefix, "decide … <decision-id>");
    const exact = model.decisions.find((item) => item.id === wanted);
    if (exact !== undefined)
    {
        return exact;
    }
    const matches = model.decisions.filter((item) => item.id.startsWith(wanted));
    if (matches.length > 1)
    {
        throw new CliError(`decision id "${wanted}" is ambiguous (${matches.length} matches) — spell more of it`);
    }
    if (matches.length === 0)
    {
        throw new CliError(`${wanted} is not a decision`);
    }
    return matches[0];
}

// Whether `requireDecision` would find anything here, asked of a whole project
// so `recordOwner` can pick the one whose lookup is about to succeed. A prefix
// is what makes this worth stating: two projects can both answer to one, which
// is the ambiguity `recordOwner` refuses by naming them.
function holdsDecision(model: ProjectModel, wanted: string): boolean
{
    return model.decisions.some((item) => item.id === wanted || item.id.startsWith(wanted));
}

// The project comes from the decision rather than from the directory (#302):
// this is the line a `--project` context prints beside a proposed decision, and
// it now resolves where that context was read.
function confirmDecision(prefix: string | undefined): void
{
    const wanted = requireText(prefix, "decide confirm <event-id>");
    const { ctx, model } = recordOwner(process.cwd(), wanted, (candidate) => holdsDecision(candidate, wanted));
    const decision = requireDecision(model, wanted);
    if (decision.status !== "proposed")
    {
        throw new CliError(`${decision.id} is not a proposed decision`);
    }
    // The shared confirm path (#240 R3): the same room gate `state confirm`
    // runs, paired demotions included — a proposal past a cap is refused
    // here, never at propose time.
    confirmEntityUnit(ctx, decision.id);
}

// Withdrawal without a successor: `retract` takes back a confirmed decision,
// `decline` turns down a proposal. One body, because the two differ only in
// which status they are admitted on and which ref they write — a second copy
// would drift on the part they share, which is every refusal below. Both
// record the shared grammar's one withdrawal event; the declined proposal
// keeps its distinct marker in the folded record (#207 B4).
function withdrawDecision(ctx: ProjectContext, verb: "retract" | "decline", prefix: string | undefined, why: string | undefined): void
{
    const usage = `decide ${verb} <event-id> --why "<reason>"`;
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const decision = requireDecision(model, requireText(prefix, usage));
    const admits = verb === "retract" ? "confirmed" : "proposed";
    if (decision.status !== admits)
    {
        throw new CliError(withdrawalRefusal(verb, decision));
    }
    // Every lifecycle exit that is not a supersession carries its reason: a
    // supersession says why by naming its successor, and nothing else does.
    // The gate refused a call without one before this ran.
    const payload = { entity: decision.id, why: required(why) };
    const refs = verb === "retract" ? { retracts: decision.id } : { declines: decision.id };
    // A decline turns down a proposal, which was never held: only the retract
    // of a confirmed decision reaches the gate.
    const withdrawn = verb === "retract" ? [decision.id] : [];
    recordRetirement(ctx, retirementIntent(model, "retract", withdrawn), model,
        (confirmation) => [makeEvent(ctx.project, "entity.retracted",
            confirmation === undefined ? payload : { ...payload, confirmation }, refs, true)],
        decision.text);
}

// Each refusal names the state the record is actually in and the verb that
// fits it, so a person who reached for the wrong one is not left guessing.
function withdrawalRefusal(verb: "retract" | "decline", decision: DecisionState): string
{
    if (decision.status === "retracted" || decision.status === "declined")
    {
        return `${decision.id} was already ${decision.status}`;
    }
    if (decision.status === "superseded")
    {
        return `${decision.id} was already superseded by a later decision — nothing is left to ${verb}`;
    }
    return verb === "retract"
        ? `${decision.id} is a proposed decision, not a confirmed one — turn it down with \`self decide decline ${decision.id}\``
        : `${decision.id} is a confirmed decision, not a proposal — take it back with \`self decide retract ${decision.id} --why "..."\``;
}

interface DecisionOptions
{
    work?: string;
    blocks?: string[];
    after?: string;
}

// Every id a decision names is resolved before the event is written, so a
// typo is refused here rather than folding into a relation that points at
// nothing on every machine that pulls it. Supersession travels as an entity
// link now; these are the work-graph refs the attention band reads.
function decisionRefs(ctx: ProjectContext, options: DecisionOptions): EventRefs | undefined
{
    const refs: EventRefs = {};
    if (options.work !== undefined)
    {
        refs.work = requireKnownWork(ctx, options.work);
    }
    if (options.blocks !== undefined && options.blocks.length > 0)
    {
        // Any known unit, open or finished: a proposal that gates work which
        // already landed is exactly what "already in effect" is derived from.
        refs.blocks = requireKnownWorks(ctx, options.blocks);
    }
    if (options.after !== undefined)
    {
        refs.after = findEventByPrefix(ctx.storeDir, ctx.project, options.after).id;
    }
    return Object.keys(refs).length === 0 ? undefined : refs;
}

function cmdWorkAdd({ values, positionals }: CommandInput<typeof WORK_ADD_OPTIONS>): CommandOutput
{
    const outcome = requireText(positionals[0], WORK_ADD_USAGE);
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const id = workId();
    const retirement = supersededRetirement(ctx, id, values);
    recordRetirement(ctx, retirementIntent(model, "supersede", retirement === undefined ? [] : [String(retirement.payload.entity)]), model,
        (confirmation) =>
        {
            const events = [makeEvent(ctx.project, "entity.confirmed", workPayload(ctx, id, outcome))];
            if (retirement !== undefined)
            {
                retirement.payload = confirmation === undefined ? retirement.payload : { ...retirement.payload, confirmation };
                events.push(retirement);
            }
            return events;
        },
        `${id} ${outcome}`);
    return [{ kind: "receipt", text: id }];
}

function workPayload(ctx: ProjectContext, id: string, outcome: string): Record<string, unknown>
{
    const row = presetRow(ctx.storeDir, "work");
    const payload: Record<string, unknown> = {
        entity: id,
        text: outcome,
        labels: [row.label],
        links: [],
        criteria: [],
        exposure: row.exposure,
        scope: "project"
    };
    if (row.priority !== undefined)
    {
        payload.priority = row.priority;
    }
    return payload;
}

// A work correction is the retirement `work retire --successor` already
// records — the same event, the same payload, the same gate on the unit being
// retired — written beside the new unit so the pair is one append. Nothing
// else about a work unit's outcome moves it, so `--supersedes` is a spelling
// over that transition, never a second way to close a unit.
function supersededRetirement(ctx: ProjectContext, successor: string, values: CommandInput<typeof WORK_ADD_OPTIONS>["values"]): SelfEvent | undefined
{
    if (values.supersedes === undefined)
    {
        if (values.why !== undefined)
        {
            throw new CliError("work add --why states why a replaced unit gave up its outcome — pass --supersedes <work-id> too, or record the reason with `self report`");
        }
        return undefined;
    }
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    requireSupersedeKind(model.entities, values.supersedes, "work");
    const work = requireRetirable(model, values.supersedes);
    if (work.status === "retired")
    {
        // Not the no-op `work retire` answers with: the new unit is about to be
        // recorded, and it would land claiming a supersession that never happened.
        throw new CliError(`${work.id} is already retired — ${work.retiredWhy}`);
    }
    const why = requireText(values.why, `work add "<outcome>" --supersedes ${work.id} --why "<why the outcome moved to the new unit>"`);
    return makeEvent(ctx.project, "entity.retired", { entity: work.id, why, successor, successorProject: ctx.project }, undefined, true);
}

function cmdWorkList({ values }: CommandInput<typeof SCOPED_RENDER_OPTIONS>): CommandOutput
{
    return workList(readScopes(process.cwd(), values)[0]);
}

function cmdWorkShow({ values, positionals }: CommandInput<typeof HISTORY_OPTIONS>): CommandOutput
{
    const wanted = requireText(positionals[0], "work show <work-id> [--history [--page n]] [--project <slug>]");
    const ctx = requireWorkspace(process.cwd());
    const found = findWorkAcross(ctx, wanted, values.project);
    if (found === null)
    {
        // Search is the surface that finds a record now (#212), so the refusal
        // names it rather than a listing that shows open units alone.
        throw new CliError(wrongKindHint(wanted, "work") ?? `unknown work id "${wanted}" — run \`self search "<text>"\` to find one, or \`self work\` to list open ids`);
    }
    return values.history === true
        ? workHistory(ctx, found, values.project, values.page)
        : workPage(ctx, found);
}

// One unit's own events, paged (#212 R3). The unit was already resolved, so
// history says nothing about which project to stand in that `show` has not
// already answered.
function workHistory(ctx: CliContext, found: FoundWork, project: string | undefined, page: string | undefined): CommandOutput
{
    return historyOutput({
        id: found.work.id,
        storeDir: ctx.storeDir,
        owner: found.slug,
        project: project ?? found.slug,
        command: "work",
        model: found.model,
        successor: found.work.successor?.work
    }, page);
}

function workPage(ctx: CliContext, found: FoundWork): CommandOutput
{
    return [{ kind: "document", plain: () => workPageLines(ctx, found) }];
}

// The two lines that lead the page, then the page. Both are composed here
// rather than inside `renderWorkBody`, which also writes the synced
// `work/<id>.md`: liveness is this machine's answer, and a synced file
// carrying it would tell another clone what only this one can judge.
function workPageLines(ctx: CliContext, found: FoundWork): string[]
{
    const body = renderWorkBody(found.work, found.model, readVerdicts(ctx.storeDir, found.slug),
        supersededSources(ctx, found));
    return [
        ...optionalLine(holderNote(found.work)),
        ...optionalLine(scopeNote(found)),
        ...markdownHeadings(body.trimEnd()).split("\n")
    ];
}

// A lead line the page carries only sometimes, as the zero or one line it is.
// Spreading the `string | null` directly would spread a present line into its
// characters, which is a defect the types happily admit.
function optionalLine(text: string | null): string[]
{
    return text === null ? [] : [text];
}

// Where a unit renders when that is no longer the project whose log holds it
// (#181 D1/D2). The page is still this log's, so the line says so rather than
// letting a reader take the absence from `self work` here for a lost record.
function scopeNote(found: FoundWork): string | null
{
    const target = scopeTarget({ scope: workScope(found.model, found.work) }, found.slug);
    if (target === found.slug)
    {
        return null;
    }
    return target === "workspace"
        ? `${found.work.id} renders in every project; its record lives in ${found.slug}`
        : `${found.work.id} renders in ${target}; its record lives in ${found.slug}`;
}

// The brief is the one thing a session cannot skip before starting, so the
// command that hands it over is the command that records the claim (#230).
// `show` stays a pure read — three looks must not be three claims — and this
// verb is what an agent calls because it needs what comes back, not because a
// managed block told it to.
//
// The brief is the verb's answer and comes back as the page it is; everything
// above it — the note that another session holds the unit, the line the append
// prints — is a disclosure from a lower layer, said through `notice` while the
// command is still running. That is what keeps the order a reader has always
// read: notices land as they happen, the answer lands when there is one.
function cmdWorkStart({ positionals }: CommandInput<typeof TRANSITION_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const { work, owner } = requireOpenWork(ctx, positionals[0]);
    const mine = sessionToken();
    // Read before anything is written, and printed before it too: the fact a
    // session is deciding on is who held the unit when it walked up. A
    // disclosure, not the verb's answer, so it goes through the gate's notice
    // at the moment it stood.
    const held = holderNote(work);
    if (held !== null)
    {
        notice(held);
    }
    if (claimMoves(work.claim, mine, work.process))
    {
        recordEvent(ctx, makeEvent(owner, "entity.started", { entity: work.id }), `${work.id} ${work.outcome}`);
    }
    noteSessionSeen(mine, new Date().toISOString());
    return [{ kind: "document", plain: () => briefLines(ctx, owner, work) }];
}

// The unit as it stood when the session walked up, against the model the claim
// it just recorded is already folded into — which is the pair the line above
// this call has always composed.
function briefLines(ctx: ProjectContext, owner: string, work: WorkState): string[]
{
    const model = buildModel(ctx.storeDir, owner, new Date());
    return markdownHeadings(renderWorkBody(work, model, readVerdicts(ctx.storeDir, owner)).trimEnd()).split("\n");
}

// What a reader is told about who holds a unit, or nothing when no session
// has claimed it.
function holderNote(work: WorkState): string | null
{
    return claimNote(work.claim, sessionToken(), work.process);
}

// Cell 7 of #230's table: a non-holder acting on a unit is told, never
// refused. The unit may genuinely have moved to this session, and a stale
// claim from a session that died is exactly the case a refusal would get
// wrong. The holder itself is told nothing — it already knows.
function announceOtherHolder(work: WorkState): void
{
    const held = holderNote(work);
    if (held !== null && work.claim?.session !== sessionToken())
    {
        notice(held);
    }
}

// Read-time reverse provenance for the cross-project case: a retire event
// lives in the source project's log, so the successor's page derives this by
// scanning the workspace instead of asserting state it does not own. The
// same-project case folds inside renderWorkBody, where it can never go stale.
function supersededSources(ctx: CliContext, found: FoundWork): string[]
{
    const lines: string[] = [];
    for (const slug of orderedSlugs(ctx).filter((item) => item !== found.slug))
    {
        const model = buildModel(ctx.storeDir, slug, new Date());
        for (const work of model.works)
        {
            if (work.status === "retired" && work.successor?.work === found.work.id
                && work.successor.project === found.slug)
            {
                lines.push(`${work.id} (${slug}) — ${work.retiredWhy}`);
            }
        }
    }
    return lines;
}

interface FoundWork
{
    slug: string;
    model: ProjectModel;
    work: WorkState;
}

// A bare id resolves across the whole workspace: the linked checkout's own
// project wins outright, and a cross-project id collision demands the
// caller's project flag — named by each caller, because `work show` and
// `work retire --successor` spell it differently.
function findWorkAcross(ctx: CliContext, wanted: string, project: string | undefined, projectFlag = "--project"): FoundWork | null
{
    const slugs = project === undefined
        ? orderedSlugs(ctx)
        : [requireRegistered(ctx.storeDir, project)];
    const matches: FoundWork[] = [];
    for (const slug of slugs)
    {
        const model = buildModel(ctx.storeDir, slug, new Date());
        const work = model.works.find((item) => item.id === wanted);
        if (work !== undefined)
        {
            matches.push({ slug, model, work });
        }
    }
    if (matches.length > 0 && matches[0].slug === ctx.project)
    {
        return matches[0];
    }
    if (matches.length > 1)
    {
        throw new CliError(`work id "${wanted}" exists in more than one project (${matches.map((m) => m.slug).join(", ")}) — pass ${projectFlag} <slug>`);
    }
    return matches[0] ?? null;
}

// The current checkout's project first, so its lookups behave exactly as
// they always have, then every other registered project.
function orderedSlugs(ctx: CliContext): string[]
{
    const rest = readRegistry(ctx.storeDir).map((entry) => entry.slug).filter((slug) => slug !== ctx.project);
    return ctx.project === undefined ? rest : [ctx.project, ...rest];
}

// Retiring a unit records that its outcome was deliberately given up or moved
// — never achieved. The unit keeps every report, evidence hash, and artifact,
// and stops counting as live work everywhere the status is read.
function cmdWorkRetireUnit({ values, positionals }: CommandInput<typeof RETIRE_OPTIONS>): CommandOutput
{
    if (values.requirement !== undefined)
    {
        // The verb that used to carry this moved: one verb per scope, so a
        // requirement can never be dropped when the caller meant the unit.
        throw new CliError("`work retire` retires the unit itself — to retire one requirement, use `self work drop <id> --requirement r1 --why w`");
    }
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireRetirable(model, positionals[0]);
    if (work.status === "retired")
    {
        // Idempotent by design: the state the caller asked for already holds,
        // so repeating the transition records nothing and refuses nothing —
        // and a receipt for a state that already held is still a receipt.
        return [{ kind: "receipt", text: `${work.id} is already retired — ${work.retiredWhy}` }];
    }
    const why = required(values.why);
    // Before the approval prompt, not after: a person deciding whether to
    // destroy the record should read that another session is on it first.
    announceOtherHolder(work);
    recordUnitRetirement(ctx, model, work, why, values);
    // The approved path says what it recorded through the append's own
    // announce line, so the verb has nothing of its own left to answer with.
    return [];
}

// What the retirement gate does with a unit that is still live: disclose it,
// read a typed confirmation from a terminal, append only then. `why` is
// resolved by the caller, because a reason that is present but empty is
// refused before the holder is announced rather than after.
function recordUnitRetirement(ctx: ProjectContext, model: ProjectModel, work: WorkState, why: string,
    values: CommandInput<typeof RETIRE_OPTIONS>["values"]): void
{
    const payload = { entity: work.id, why, ...successorRef(ctx, work.id, values.successor, values["successor-project"]) };
    recordRetirement(ctx, retirementIntent(model, "retire", [work.id]), model,
        (confirmation) => [makeEvent(ctx.project, "entity.retired",
            confirmation === undefined ? payload : { ...payload, confirmation }, undefined, true)],
        `${work.id} ${why}`);
}

// The one answer to "may this unit be retired": known, and not already closed
// as done. Read by `work retire` and by `work add --supersedes`, which records
// the same retirement. Already-retired is the caller's case to answer — a
// no-op for one, a refusal for the other.
function requireRetirable(model: ProjectModel, id: string | undefined): WorkState
{
    const wanted = requireText(id, "work retire <work-id> — run `self work` to list ids");
    const work = model.works.find((item) => item.id === wanted);
    if (work === undefined)
    {
        throw new CliError(wrongKindHint(wanted, "work") ?? `unknown work id "${wanted}" — run \`self work\` to list ids`);
    }
    if (work.status === "done")
    {
        throw new CliError(`${work.id} is already done — retirement records an outcome that was given up, not one that was reached`);
    }
    return work;
}

// The successor is validated before anything is written: an unknown reference
// refuses the retirement instead of recording a pointer nothing can follow.
function successorRef(ctx: ProjectContext, source: string, successor: string | undefined, project: string | undefined): Record<string, unknown>
{
    if (successor === undefined)
    {
        if (project !== undefined)
        {
            throw new CliError("work retire --successor-project needs --successor <work-id> to point at");
        }
        return {};
    }
    const found = findWorkAcross(ctx, successor, project, "--successor-project");
    if (found === null)
    {
        throw new CliError(`unknown successor "${successor}" — the unit that carries the outcome must exist before ${source} is retired`);
    }
    requireSuccessorStanding(ctx, source, found);
    return { successor: found.work.id, successorProject: found.slug };
}

// What the resolved successor has to be: another unit, still standing, in a
// project still being worked on. Identity, not spelling — the same id may exist
// in another project, so self-succession is judged only after the reference has
// resolved.
function requireSuccessorStanding(ctx: ProjectContext, source: string, found: FoundWork): void
{
    if (found.slug === ctx.project && found.work.id === source)
    {
        throw new CliError(`${source} cannot succeed itself — name the unit that carries the outcome now`);
    }
    if (found.work.status === "retired")
    {
        throw new CliError(`successor ${found.work.id} is itself retired — the outcome cannot move to a unit that gave it up`);
    }
    // An archived project receives nothing (#283): the outcome would move into
    // a project that is out of every listing, where nothing reports on it again
    // until someone restores it.
    refuseArchived(ctx.storeDir, found.slug, "it cannot receive a successor");
}

// The process ledger's two verbs. The synced event carries the transition and
// never the pid — a pid is machine-local, and the sanitization gate refuses
// it by design — so the pid lands in the machine ledger beside the event.
function cmdWorkProcess({ values, positionals }: CommandInput<typeof PROCESS_OPTIONS>, started: boolean): void
{
    const ctx = requireProject(process.cwd());
    const { work, owner } = requireOpenWork(ctx, positionals[0]);
    if (started)
    {
        const pid = Number(values.pid);
        if (!Number.isInteger(pid) || pid <= 0)
        {
            throw new CliError("work started records the process running this unit — pass its id: work started <work-id> --pid <N>");
        }
        recordProcess({ work: work.id, project: owner, pid, startedAt: new Date().toISOString() });
        recordEvent(ctx, makeEvent(owner, "work.run-started", { work: work.id }), `${work.id} ${work.outcome}`);
        return;
    }
    const payload: Record<string, unknown> = { work: work.id };
    if (values.code !== undefined)
    {
        const code = Number(values.code);
        if (!Number.isInteger(code) || code < 0)
        {
            throw new CliError("work exited takes the process exit status: work exited <work-id> [--code <N>]");
        }
        payload.code = code;
    }
    recordEvent(ctx, makeEvent(owner, "work.run-exited", payload), `${work.id} ${work.outcome}`);
}

function transitionWork(type: string, { values, positionals }: CommandInput<typeof TRANSITION_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    const { work, owner } = requireOpenWork(ctx, positionals[0]);
    const payload: Record<string, unknown> = { entity: work.id };
    if (type === "entity.blocked")
    {
        // The gate demanded --on; what is left is whether the reason it names
        // is one the work graph knows.
        if (values.on !== "decision" && values.on !== "dependency" && values.on !== "external")
        {
            throw new CliError(`work block --on must be decision, dependency or external — "${values.on}" is none of them`);
        }
        payload.on = values.on;
        if (values.why !== undefined)
        {
            payload.why = values.why;
        }
    }
    recordEvent(ctx, makeEvent(owner, type, payload), `${work.id} ${work.outcome}`);
}

// The claim that the outcome was reached, admitted by the completion gate
// (#205 table B): a report carrying a commit or an artifact satisfies it, and
// a done-time --report is the floor for genuinely trivial work — recorded as
// a report in the same append, so the evidence and the claim can never land
// apart. Done is allowed while blocked (ruling ①): `requireOpenWork` refuses
// only the closed states.
function cmdWorkDone({ values, positionals }: CommandInput<typeof DONE_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    const { work, owner } = requireOpenWork(ctx, positionals[0]);
    const report = values.report === undefined ? undefined
        : requireText(values.report, 'work done <work-id> --report "<what verifiably happened>"');
    const refusal = completionRefusal(work, report);
    if (refusal !== null)
    {
        throw new CliError(refusal);
    }
    const payload: Record<string, unknown> = { entity: work.id };
    if (values.why !== undefined)
    {
        payload.why = values.why;
    }
    announceOtherHolder(work);
    const events = report === undefined ? []
        : [makeEvent(owner, "report.added", { text: report }, { work: work.id })];
    events.push(makeEvent(owner, "entity.done", payload));
    recordEvents(ctx, events, `${work.id} ${work.outcome}`);
}

function attachEvidence(ctx: ProjectContext, values: CommandInput<typeof REPORT_OPTIONS>["values"],
    refs: EventRefs, payload: Record<string, unknown>): void
{
    const { commits, notes } = classifyEvidence(ctx.projectDir, values.evidence ?? headEvidence(ctx));
    if (commits.length > 0)
    {
        refs.commits = commits;
        // Says the split already happened, against the repository that could
        // answer it. A reader of this event must take these as revisions rather
        // than guess at their shape a second time.
        payload.evidenceTyped = true;
    }
    if (notes.length > 0)
    {
        payload.notes = notes;
    }
    if (values.next !== undefined)
    {
        payload.next = values.next;
    }
}

function cmdReport({ values, positionals }: CommandInput<typeof REPORT_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    const { work, owner } = requireOpenWork(ctx, positionals[0]);
    const text = values.file === undefined
        ? requireText(positionals[1], 'report <work-id> "<summary>" — every report attaches to a work unit')
        : readReportFile(values.file);
    announceOtherHolder(work);
    const refs: EventRefs = { work: work.id };
    const payload: Record<string, unknown> = { text };
    attachEvidence(ctx, values, refs, payload);
    const staged = stageArtifacts(ctx.storeDir, owner, values.artifact);
    if (staged.artifacts.length > 0)
    {
        payload.artifacts = staged.artifacts;
        refs.artifacts = staged.artifacts.map((meta) => meta.id);
    }
    commitStaged(staged, (recorded) =>
        recordEvent(ctx, makeEvent(owner, "report.added", payload, refs), `${work.id} ${text}`, recorded));
}

// A decision may look back at finished work, so this accepts any unit the
// log knows — unlike requireOpenWork, which gates the verbs that move it.
function requireKnownWork(ctx: ProjectContext, id: string): string
{
    return requireKnownWorks(ctx, [id])[0];
}

// One fold for the whole list, and each id kept once: a decision may gate
// several units, and folding the log per id would make naming four of them
// cost four passes over every event in the project.
function requireKnownWorks(ctx: ProjectContext, ids: string[]): string[]
{
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const unknown = ids.find((id) => !model.works.some((item) => item.id === id));
    if (unknown !== undefined)
    {
        throw new CliError(wrongKindHint(unknown, "work") ?? `unknown work id "${unknown}" — run \`self work\` to list ids`);
    }
    return [...new Set(ids)];
}

// One unit and the log that owns it. A unit scoped in from another project
// resolves here and every write about it lands in its home log (#181 D3), so
// the owner travels with the unit rather than being assumed to be the project
// the command ran in.
interface OpenWork
{
    work: WorkState;
    owner: string;
}

function requireOpenWork(ctx: ProjectContext, id: string | undefined): OpenWork
{
    const wanted = requireText(id, "… <work-id> — run `self work` to list ids");
    const found = requireRenderedWork(ctx, wanted);
    const work = found.work;
    if (work.status === "done")
    {
        throw new CliError(`${wanted} is already done`);
    }
    if (work.status === "retired")
    {
        throw new CliError(`${wanted} is retired — ${work.retiredWhy ?? "its outcome was given up"}; see \`self work show ${wanted}\``);
    }
    return found;
}

// Every unit this project answers for (#181 D3/D5): its own, whatever project
// they now render in — the home log always answers for its own record — plus
// the units another project's log scoped in here. A unit that renders in
// neither is unknown here, exactly as an id from an unrelated project is.
function requireRenderedWork(ctx: ProjectContext, wanted: string): OpenWork
{
    for (const model of workspaceModels(ctx.storeDir, ctx.project))
    {
        const work = model.works.find((item) => item.id === wanted);
        const mine = model.slug === ctx.project;
        if (work !== undefined && (mine || rendersIn({ scope: workScope(model, work) }, model.slug, ctx.project)))
        {
            return { work, owner: model.slug };
        }
    }
    throw new CliError(wrongKindHint(wanted, "work") ?? `unknown work id "${wanted}" — run \`self work\` to list ids`);
}

function readReportFile(path: string): string
{
    if (!existsSync(path))
    {
        throw new CliError(`report --file: "${path}" does not exist`);
    }
    const text = readFileSync(path, "utf8").trim();
    if (text === "")
    {
        throw new CliError(`report --file: "${path}" is empty`);
    }
    return text;
}

function headEvidence(ctx: ProjectContext): string[]
{
    const head = headCommit(ctx.projectDir);
    return head === null ? [] : [head];
}

function conventionAdd({ values, positionals }: CommandInput<typeof CONVENTION_OPTIONS>): void
{
    const text = requireText(positionals[0], 'convention add "<text>" [--supersedes <event-id>] [--workspace]');
    if (values.why !== undefined)
    {
        throw new CliError("convention add takes no --why — the rule is its own statement; --why records why a rule was withdrawn");
    }
    const ctx = requireProject(process.cwd());
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const model = models[0];
    const extra: Record<string, unknown> = {};
    // A correction is one event: the replacement carries the lineage, so
    // the rule it replaces never has to be dropped and re-added — which is
    // how two contradicting conventions used to end up both current.
    if (values.supersedes !== undefined)
    {
        values.supersedes.forEach((prefix) => requireSupersedeKind(model.entities, prefix, "convention"));
        extra.links = currentConventionIds(model, values.supersedes)
            .map((target) => ({ type: "supersedes", target }));
    }
    if (values.workspace === true)
    {
        // A placement value, not a read scope (#207 D6): the rule renders in
        // every project's context while its record stays in this store.
        extra.scope = "workspace";
    }
    presetEntityEvent(ctx, models, "convention", text, extra, undefined, { demote: values.demote });
}

function conventionDrop({ values, positionals }: CommandInput<typeof CONVENTION_OPTIONS>): void
{
    // Declared once for the whole verb, so the subcommand that does not
    // take it says so rather than dropping one convention and ignoring the
    // id the person expected it to replace.
    if (values.supersedes !== undefined)
    {
        throw new CliError('convention drop takes no --supersedes — to replace a rule, run `convention add "<text>" --supersedes <event-id>`');
    }
    if (values.workspace === true)
    {
        throw new CliError("convention drop takes no --workspace — a rule is dropped wherever it renders; --workspace states a new rule's scope");
    }
    refuseWithdrawalDemote("convention drop", values.demote);
    const ctx = requireProject(process.cwd());
    const usage = 'convention drop <event-id> --why "<why the rule no longer holds>"';
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const id = currentConventionIds(model, [requireText(positionals[0], usage)])[0];
    // Every withdrawal carries its reason. A rule that left the current set
    // with nothing recorded reads, a year later, exactly like one nobody
    // ever wrote down.
    const payload = { entity: id, why: required(values.why) };
    const text = model.conventions.find((item) => item.id === id)?.text ?? id;
    recordRetirement(ctx, retirementIntent(model, "retract", [id]), model,
        (confirmation) => [makeEvent(ctx.project, "entity.retracted",
            confirmation === undefined ? payload : { ...payload, confirmation }, { retracts: id }, true)],
        text);
}

// The ids of conventions that still hold, legacy and native alike. A
// withdrawn one is refused rather than named again: the first withdrawal is
// what happened, and a second event pointing at it would claim to change a
// record it cannot.
function currentConventionIds(model: ProjectModel, prefixes: string[]): string[]
{
    return prefixes.map((prefix) =>
    {
        const matches = model.conventions.filter((item) => item.id === prefix || item.id.startsWith(prefix));
        if (matches.length === 0)
        {
            throw new CliError(`${prefix} is not a convention`);
        }
        if (matches.length > 1 && !matches.some((item) => item.id === prefix))
        {
            throw new CliError(`convention id "${prefix}" is ambiguous (${matches.length} matches) — spell more of it`);
        }
        const state = matches.find((item) => item.id === prefix) ?? matches[0];
        if (state.status !== "current")
        {
            throw new CliError(`${state.id} was already ${state.status} — it is not a convention that still holds`);
        }
        return state.id;
    });
}

function cmdLog({ values }: CommandInput<typeof LOG_OPTIONS>): CommandOutput
{
    const limit = values.lines === undefined ? 20 : Number.parseInt(values.lines, 10);
    if (Number.isNaN(limit) || limit <= 0)
    {
        throw new CliError("log -n expects a positive number");
    }
    const scopes = readScopes(process.cwd(), values);
    return values.workspace === true ? workspaceLog(scopes, limit) : projectLog(scopes[0], limit);
}

function cmdSearch({ values, positionals }: CommandInput<typeof SEARCH_OPTIONS>): CommandOutput
{
    // Context recovery pointers pull whole categories, so a narrowing flag
    // alone is a complete request and stands in for the query.
    const narrowed = values.type !== undefined || values.project !== undefined
        || values.exposure !== undefined || values.all === true;
    const query = positionals[0] ?? (narrowed ? ""
        : requireText(undefined, "search <query>, or search with --type <kind>, --exposure <tier>, --all, or --project <slug>"));
    return runSearch(requireWorkspace(process.cwd()), query, values);
}

function cmdConnect(global: boolean): CommandOutput
{
    if (global)
    {
        return connectMachineAgents();
    }
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    return blockReceipt(connectProject(ctx.projectDir, model));
}

// What a rendered managed block leaves the caller to do. Both writers of it —
// registration and `connect` — say it the same way, from here.
function blockReceipt(files: string[]): CommandOutput
{
    return [{ kind: "receipt", text: `managed block rendered into ${files.join(", ")} — commit them so every agent tool loads it` }];
}

function cmdFold(): CommandOutput
{
    const ctx = requireProject(process.cwd());
    foldWorkspace(ctx.storeDir, ctx.project);
    commitAll(ctx.storeDir, `fold ${ctx.project}: manual refold`);
    return [{ kind: "receipt", text: `refolded ${ctx.project}` }];
}

function requireText(value: string | undefined, usage: string): string
{
    if (value === undefined || value.trim() === "")
    {
        throw new CliError(`usage: self ${usage}`);
    }
    return value;
}

// A bad flag is a user mistake, not a defect: node reports it by throwing from
// parseArgs, and without this it would surface as an internal stack trace.
// Commands here parse through parseCommand; the modules that call parseArgs
// directly — goals — are answered the same way.
function userMessage(error: unknown, argv: string[]): string | null
{
    if (error instanceof CliError)
    {
        return error.message;
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (!(error instanceof Error) || code === undefined || !code.startsWith("ERR_PARSE_ARGS_"))
    {
        return null;
    }
    // node appends advice about `--` that repeats the flag; the first sentence
    // is the part that names what went wrong.
    const cause = error.message.split(". ")[0];
    return `${cause.charAt(0).toLowerCase()}${cause.slice(1)} — ${helpHint(argv[0])}`;
}

// The whole invocation, including its error boundary. `bin/self.mjs` calls this
// and nothing else, so importing this module — to read the contract — runs no
// command.
/* ── undo ──────────────────────────────────────────────────────────── */

// The kinds of event an undo can take back, and what each one did. Anything
// outside this table is refused by name: `undo` reads like it reverses any
// event, and the refusal is where that impression gets corrected.
const UNDOABLE: Record<string, string> = {
    "entity.retracted": "withdrawal",
    "entity.retired": "retirement",
    // A link is a statement too (#244 D5): taking the event back removes the
    // contribution edge from every surface that read it, in every project.
    "entity.linked": "link"
};

// Reversing one destructive event. The event is named rather than the record,
// because what went wrong is an act, not a state — and because naming the act
// is what lets this stay safe under a merge: an undo cannot have been written
// without seeing the event it reverses, which is the exact case a withdrawal
// stays terminal against.
function cmdUndo(ctx: ProjectContext, prefix: string | undefined, why: string | undefined): CommandOutput
{
    const usage = 'undo <event-id> --why "<why the retirement was wrong>"';
    const event = findEventByPrefix(ctx.storeDir, ctx.project, requireText(prefix, usage));
    const undone = undoableKind(event);
    if (readEvents(ctx.storeDir, ctx.project).some((item: SelfEvent) => item.refs?.annuls === event.id))
    {
        throw new CliError(`${event.id} was already undone — the record it took back is standing`);
    }
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const restored = restoredBy(event);
    const text = model.entities.find((item) => item.id === restored)?.text ?? restored;
    recordEvent(ctx, makeEvent(ctx.project, "entity.restored",
        { entity: restored, why: required(why) }, { annuls: event.id }, true), text);
    // Undoing a link never removed the record itself, so "standing again"
    // would claim a restoration that did not happen.
    return [{
        kind: "receipt",
        text: undone === "link"
            ? `${restored} no longer carries the link — the linked event was taken back`
            : `${restored} is standing again — its ${undone} was taken back`
    }];
}

// Which act this event was, or a refusal naming the ones that can be taken
// back. A creation is undoable only where it displaced something: without a
// supersedes link there is nothing for an undo to give back.
function undoableKind(event: SelfEvent): string
{
    const named = UNDOABLE[event.type];
    if (named !== undefined)
    {
        return named;
    }
    if (isEntityCreation(event) && supersedeTargets(event.payload).length > 0)
    {
        return "supersession";
    }
    refuseArchiveUndo(event);
    throw new CliError(`${event.id} is a ${event.type} — undo takes back a retirement, a withdrawal, a link, `
        + "or a record's supersession of another, and nothing else");
}

// An archive is ended by `project restore` and by nothing else (#283). This
// refusal exists because reaching it at all means someone looked for `undo`
// here, and the generic answer above would send them away without the verb
// that does the job. `restore` also runs from anywhere, which is why it is the
// only way back: `undo` resolves its project from the working directory, and
// an archived project's checkout is frequently on another machine.
function refuseArchiveUndo(event: SelfEvent): void
{
    if (event.type === "project.archived")
    {
        throw new CliError(`${event.id} archived project "${event.project}" — an archive is ended by `
            + `\`self project restore ${event.project}\`, which takes --why if it should never have been archived`);
    }
}

// What comes back. A withdrawal and a retirement name their target; a
// supersession names it from the link the successor carries.
function restoredBy(event: SelfEvent): string
{
    return UNDOABLE[event.type] === undefined
        ? supersedeTargets(event.payload)[0]
        : String(event.payload.entity ?? "");
}

export async function runCli(argv: string[]): Promise<void>
{
    try
    {
        await main(argv);
    }
    catch (error)
    {
        const message = userMessage(error, argv);
        if (message === null)
        {
            throw error;
        }
        // The exit vocabulary lives on the error, so a command that constructs
        // none of 2 or 3 keeps exactly the behaviour it had. Under `--json` the
        // envelope goes to stdout, so an agent capturing stdout gets parseable
        // JSON on every path rather than on the successful ones only.
        const refusal = error instanceof CliError ? error : null;
        renderFailure(refusal?.code ?? "parse_error", message, refusal?.fields ?? {});
        process.exitCode = refusal?.exit ?? 1;
    }
}
