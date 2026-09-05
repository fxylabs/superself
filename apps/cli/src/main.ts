import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
    completionRefusal,
    CRITERION_BLOCKED,
    CRITERION_DECLARED,
    CRITERION_UNBLOCKED,
    CriterionState,
    DEFAULT_ZONE,
    entityCharacters,
    EntityState,
    Exposure,
    FoldError,
    isLive,
    payloadArtifact,
    rendersIn,
    requireSupersedeKind,
    scopeTarget,
    standaloneEdge
} from "@superself/fold";
import { ALIAS_COMMAND, presetRow, registerPluginClaims, registerReservedVerbs, resolveAliasCommand } from "./aliases.js";
import { applyCommand } from "./apply.js";
import { archivedListing, PROJECT_ARCHIVE_LEAF, PROJECT_RESTORE_LEAF } from "./archive.js";
import { helpHint, parseCommand, required, Requirement, unknownOption } from "./args.js";
import { ARTIFACT_COMMAND, artifactDigest, attachedArtifactLines, commitStaged, resolveArtifactRef, stageArtifacts } from "./artifact.js";
import { connectCloud, createWorkspaceProject } from "./cloud.js";
import { connectMachine, connectProject, machineBlock } from "./connect.js";
import { branch, Command, CommandInput, CommandNode, findCommandByName, leaf, Resolved, resolveCommand } from "./contract.js";
import { validZone } from "./dates.js";
import { derivationLines, PROJECT_FROM_LEAF } from "./derivation.js";
import { citationLines, CitedDecision, citedIds, dispatchRefusal, requireCitations } from "./design.js";
import { foldEveryProject, foldProject, foldWorkspace, renderWorkBody } from "./fold.js";
import { findTopic, topicPage } from "./guide.js";
import { attachmentListing, MILESTONE_COMMAND, OBJECTIVE_COMMAND, requireRetirable, requireSupersedableWork, WORK_GOAL_LEAVES } from "./goals.js";
import { classifyEvidence, commitAll, commonDir, ensureWorkspaceRepo, excludeLocally, headCommit, realPath, repositoryIdentity, resetProbes, topOf } from "./gitutil.js";
import { cliVersion, commandUsage, rootUsage } from "./help.js";
import { WrittenBy, askLine, atKeyboard, writtenBy } from "./human.js";
import { workId, wrongKindHint } from "./ids.js";
import { findEventByPrefix, readEvents } from "./logfile.js";
import { machineWorkspace, sessionToken, setMachineWorkspace } from "./machine.js";
import { applicableConventions, buildModel, DecisionState, ProjectModel, readableModels, ReportEntry, resetUnreadableNotices, reviewRefusal, workScope, workspaceModels, WorkState } from "./model.js";
import {
    checkoutMatches,
    checkoutProject,
    CliContext,
    contains,
    dropEvidenceHead,
    ensureDir,
    invalidateResolution,
    isStore,
    linkedPaths,
    LINKS_FILE,
    machineStoreServerBacked,
    MARKER_FILE,
    ProjectContext,
    projectStateDir,
    projectArchive,
    readRegistry,
    readScope,
    readScopes,
    readStoreConfig,
    readVerdicts,
    recordedPaths,
    recordLink,
    recordUnlink,
    refuseArchived,
    requireProject,
    requireRegistered,
    requireWorkspace,
    resetProcessNotices,
    resolveProjectPath,
    SCOPE_OPTIONS,
    siblingSlug,
    slugsLinkedAt,
    tokenScale,
    useAccount,
    STORE_DIR,
    StoreConfig,
    WORKSPACE_SCOPE_OPTIONS
} from "./paths.js";
import { serverBacked } from "./mode.js";
import { notice, renderOutput } from "./output.js";
import { makeEvent, recordEvent, recordEvents, resetPipeline, stateIntent } from "./pipeline.js";
import { annulledIds, coupledUnit, dependentRefusal, dependentsOf, requireUndoable } from "./undo.js";
import { resetHomeRule } from "./redact.js";
import { verdictsFrozen } from "./reachability.js";
import { RUNBOOK_COMMAND } from "./runbook.js";
import { INSTRUCTION_COMMAND } from "./instruction.js";
import { SKILL_COMMAND } from "./skill.js";
import { dropCollected, recordRetirement, retiring, retirementIntent, supersedeTargets, supersedingRecord } from "./retirement.js";
import { claimMoves, claimNote, noteSessionSeen, recordProcess } from "./ledger.js";
import { runSearch } from "./search.js";
import { setupOutput } from "./setup.js";
import { SWEEP_COMMAND } from "./sweep.js";
import { STORE_COMMAND } from "./store.js";
import {
    admittingDemotions,
    CapGateValues,
    confirmEntityUnit,
    COVER_OPTIONS,
    COVERAGE_REQUIRED,
    coverRecord,
    Declaration,
    declarationOf,
    DECLARE_OPTIONS,
    demotionEvents,
    holdsDecision,
    Placed,
    recordCriterionBlock,
    recordCriterionUnblock,
    recordDeclaration,
    recordOwner,
    requireDecision,
    requirePersonOwner,
    resolveCriterion,
    STATE_COMMAND,
    tierOf
} from "./state.js";
import { cloneStore, ensureSyncConfig, remoteAdd, syncStore } from "./sync.js";
import { bold, dim, markdownHeadings, styled } from "./style.js";
import { openFile, validTheme, viewFile } from "./view.js";
import { RENDER_OPTIONS } from "./pretty.js";
import { contextOutput, handoffContextLines, handoffInstructionLines, handoffOutput, HandoffSnapshot, historyOutput, projectLog, statusOutput, workList, workspaceLog } from "./views.js";
import { APP_COMMAND, registerHostVerbs } from "./app.js";
import { LOGIN_COMMAND, LOGOUT_COMMAND, WHOAMI_COMMAND, clientTag } from "./login.js";
import { currentAccount, resetCredentialWarnings, resolveProfileName } from "./credentials.js";
import { catchUp, serverBackedStore } from "./puller.js";
import { sendQueued } from "./pusher.js";
import {
    InstalledPlugin, LoadContext, assertDevPluginMode, devPluginDir, installedPlugins,
    loadDevPlugin, loadPlugin, pluginVerbs, resolveRailMajor
} from "./plugins.js";
import { loadTrustDocument, resetVerifierCalls } from "./trust.js";
import { jsonMode, renderFailure, selectJsonMode } from "./output.js";
import { suppressJournal } from "./rail.js";
import { CliError, CommandOutput, EventRefs, OutputBlock, refuse, SelfEvent } from "./types.js";

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
    // After those two and not before them: this reads the machine's pointer off
    // disk, and `--version` is a question about the binary that a machine whose
    // config will not parse is still entitled to an answer to. Inside `main`,
    // so it is inside the catch — an unreadable pointer owes its caller the
    // sentence every other unreadable file gets rather than a stack.
    noteAccount();
    // Before the command and not after it: a read answers from the log, and the
    // log a server-backed store reads is the workspace's, so the workspace's
    // own copy has to be here before anything reads it. Inside `main`, so a
    // catch-up that raises owes its caller the same sentence every other
    // failure gets rather than a stack.
    await catchUp();
    // Host flags are consumed once, here, for every command. `self app install
    // email --no-journal` is as reasonable a request as the same flag on a
    // mini-app verb, and neither leaf should have to declare an option about
    // whether this machine keeps a record of its own calls.
    suppressJournal(argv.includes("--no-journal"));
    stateIntent(hostIntent(argv));
    await dispatch(hostFlagsRemoved(argv));
}

// Who owns the verb, most specific first: a built-in, then an installed
// mini-app's, then an alias somebody wrote for one of those.
async function dispatch(args: string[]): Promise<void>
{
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

// `--meant "<what the caller meant>"` belongs to the host for the same reason
// (#390). Every mutating verb takes it, so declaring it per leaf would owe a
// help line on each of the fifty-odd of them and would still miss the next one
// someone adds. Being a host flag also means the requirement machinery never
// sees it, which is why an empty one is refused here by hand.
const HOST_INTENT = "--meant";

function hostIntent(argv: string[]): string | undefined
{
    const end = argv.indexOf("--");
    const at = argv.indexOf(HOST_INTENT);
    if (at === -1 || (end !== -1 && at > end))
    {
        return undefined;
    }
    const text = argv[at + 1];
    if (text === undefined || text.trim() === "")
    {
        throw new CliError('--meant states what this call was meant to do, so it takes text: --meant "<what you meant>"');
    }
    return text;
}

function hostFlagsRemoved(argv: string[]): string[]
{
    const end = argv.indexOf("--");
    const intent = argv.indexOf(HOST_INTENT);
    const consumed = intent === -1 || (end !== -1 && intent > end) ? [] : [intent, intent + 1];
    return argv.filter((argument, at) =>
        (argument !== "--no-journal" || (end !== -1 && at > end)) && !consumed.includes(at));
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

const INIT_OPTIONS = {
    lang: { type: "string" },
    agents: { type: "boolean" },
    git: { type: "boolean" },
    cloud: { type: "boolean" },
    workspace: { type: "string" }
} as const;

const PROJECT_INIT_OPTIONS = { name: { type: "string" }, desc: { type: "string" }, "no-connect": { type: "boolean" } } as const;

// `--here` is the write that names no path; `--force` is what linking a second
// repository to a project asks for, because it changes where the project's
// evidence is judged (#332).
const PROJECT_LINK_OPTIONS = { here: { type: "boolean" }, force: { type: "boolean" } } as const;

// The inverse takes the same options for the same reasons, and `--force` keeps
// its meaning: yes, change the set of repositories this project's evidence is
// judged across. On `link` that is adding one; here it is taking away the last
// checkout this machine has (#263).
const PROJECT_UNLINK_OPTIONS = { here: { type: "boolean" }, force: { type: "boolean" } } as const;

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

// `undo` takes the withdraw verbs' `--why` and one flag of its own, so the
// withdraw verbs are not handed a flag they do not accept (#390).
const UNDO_OPTIONS = { why: { type: "string" }, supersession: { type: "boolean" } } as const;

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
const WORK_ADD_OPTIONS = {
    supersedes: { type: "string" },
    why: { type: "string" },
    standalone: { type: "boolean" },
    ...DECLARE_OPTIONS
} as const;

const WORK_ADD_USAGE = 'work add "<required outcome>" [--supersedes <work-id> --why w] [--standalone --why w] [--criteria "<text>" …]';

const WORK_COVER_USAGE = 'work cover <work-id> --criterion cN --why "<how it is covered>" [--evidence <commit>] [--work <id>]';

// One criterion declared after the unit was created. `--verify` and `--owner`
// are bare here, because this call declares exactly one and there is nothing to
// disambiguate.
const CRITERIA_ADD_OPTIONS = { verify: { type: "string" }, owner: { type: "string" } } as const;

// The unit's own block takes no criterion; naming one moves the criterion axis
// instead, which is the same act one level down and never touches the unit's
// status.
const WORK_BLOCK_OPTIONS = { ...TRANSITION_OPTIONS, criterion: { type: "string" } } as const;

const REPORT_OPTIONS = {
    evidence: { type: "string", multiple: true },
    artifact: { type: "string", multiple: true },
    // Taken as repeatable so that a second one is refused by name rather than
    // silently dropped: it names a member of one bundle, and with two bundles
    // nothing in the flag says which (#362).
    entry: { type: "string", multiple: true },
    next: { type: "string" },
    // What differed from expectation, one sentence per occurrence (#380).
    // Repeatable because a session hits more than one, and each is its own
    // sentence: joining them would make a later sweep read two pains as one.
    friction: { type: "string", multiple: true },
    file: { type: "string" },
    design: { type: "boolean" },
    implements: { type: "string", multiple: true }
} as const;

// Declared once for the whole verb, so the subcommand that does not take one
// of these says so itself rather than dropping the flag.
const CONVENTION_OPTIONS = {
    supersedes: { type: "string", multiple: true },
    why: { type: "string" },
    workspace: { type: "boolean" },
    public: { type: "boolean" },
    // Taken as repeatable so a second one is refused by name (#238): a rule
    // points at one document, and a single option would let the parser keep
    // the last value and drop the first without a word.
    artifact: { type: "string", multiple: true },
    demote: { type: "string", multiple: true }
} as const;

// The same shape, for the same reason: `goal add` refuses the withdrawal's
// reason and `goal retract` refuses the successor's link, rather than either
// silently dropping a flag the caller meant.
const GOAL_OPTIONS = {
    supersedes: { type: "string", multiple: true },
    why: { type: "string" },
    workspace: { type: "boolean" },
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

const HANDOFF_OPTIONS = { ...SCOPE_OPTIONS } as const;

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
const WORK_CHILDREN: CommandNode[] = [
    leaf("", SCOPED_RENDER_OPTIONS, 0, cmdWorkList),
    retiring(leaf("add", WORK_ADD_OPTIONS, 1, cmdWorkAdd)),
    leaf("show", HISTORY_OPTIONS, 1, cmdWorkShow),
    leaf("start", TRANSITION_OPTIONS, 1, cmdWorkStart),
    ...WORK_TRANSITIONS.map(([verb, type, requires]) =>
        leaf(verb, WORK_BLOCK_OPTIONS, 1, (input) => transitionWork(type, input), { requires })),
    // A branch with one leaf today. Block and unblock are deliberately not
    // under it: blocking is one act with one `--on` enum, and a second
    // spelling of it under a second noun is how two gates that must agree stop
    // agreeing.
    branch({
        name: "criteria",
        unnamed: "refuse",
        refusal: 'usage: self work criteria add <work-id> "<text>" [--verify "<how it is checked>"] [--owner person]',
        children: [leaf("add", CRITERIA_ADD_OPTIONS, 2, cmdWorkCriteriaAdd)]
    }),
    leaf("cover", COVER_OPTIONS, 1, (input) => coverRecord(input, "work cover", WORK_COVER_USAGE),
        { requires: COVERAGE_REQUIRED }),
    leaf("done", DONE_OPTIONS, 1, cmdWorkDone),
    leaf("started", PROCESS_OPTIONS, 1, (input) => cmdWorkProcess(input, true)),
    leaf("exited", PROCESS_OPTIONS, 1, (input) => cmdWorkProcess(input, false)),
    retiring(leaf("retire", RETIRE_OPTIONS, 1, cmdWorkRetireUnit, {
        undocumented: ["requirement"],
        requires: [{ flags: ["why"], hint: "why the outcome was given up or moved" }]
    })),
    ...WORK_GOAL_LEAVES
];

/* ── the canonical hierarchy ───────────────────────────────────────── */

// Dispatch, argument parsing, help, and the test-tier enumeration read this
// list and nothing beside it; each entry is declared where its handlers live,
// and composed here in the order the verb list prints.
export const COMMANDS: Command[] = [
    {
        name: "init",
        usage: [{
            syntax: "init [--git|--cloud] [--workspace <id>] [--lang <code>] [--agents]",
            description: ["initialize the current directory as a workspace"],
            verbs: [""]
        }],
        detail: [
            "create the workspace store this machine records project state in, and",
            "point this machine at it. a store keeps its records in a git repository",
            "this machine commits, or on a workspace server this machine is signed in",
            "to; with neither flag and a person at the terminal, it asks which.",
            "",
            "  --git             keep the records in a git repository here",
            "  --cloud           keep them on a workspace server: sign in if this",
            "                    machine has not, attach to a workspace, and pull it",
            "  --workspace <id>  the workspace on the server to attach to, so",
            "                    --cloud needs nobody at the terminal. with a person",
            "                    there it is picked from this account's workspaces",
            "  --lang <code>     language of the HTML views, as a BCP 47 code (en, ko, ja)",
            "  --agents          tell this machine's agents about self without asking"
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
                syntax: "project link [slug] [path|--here] [--force]",
                description: [
                    "attach a registered project's directory on this machine, or — with neither",
                    "a path nor --here — show where it is linked (--force adds a second repository)"
                ],
                verbs: ["link"]
            },
            {
                syntax: "project unlink [slug] <path|--here> [--force]",
                description: [
                    "detach a checkout path from a registered project on this machine",
                    "(--force detaches the last one it has left)"
                ],
                verbs: ["unlink"]
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
            "only saves the probe. `link` with neither a path nor --here reads: it prints",
            "where the slug is linked on this machine and whether this directory is one of",
            "those paths. --here or a path writes; a path of a repository the project does",
            "not have yet needs --force, because it changes where its evidence is judged.",
            "",
            "`unlink` is that write undone: it takes a recorded path out of this machine's",
            "link ledger — a path whose checkout is gone included, which is the one thing",
            "no other verb could do — and removes the `.self` marker it wrote there. The",
            "project itself is untouched: it stays registered, its log gains no event, and",
            "the path recorded in its registry row stands. It names one of a <path> and",
            "--here, never neither, because `project link <slug>` is already the listing;",
            "and taking away the last checkout on this machine needs --force, because the",
            "project then resolves only from wherever a command happens to run.",
            "",
            "the bare list is the answer to \"which slugs does --scope and --project take\",",
            "and it reads the whole workspace: it takes neither flag, while init, link and",
            "unlink are writes that record into the workspace store they run against — link",
            "and unlink into its machine-local link ledger alone, taking no scope flag and",
            "naming the slug they act on — and from is a write that records into the",
            "project it runs in.",
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
                leaf("link", PROJECT_LINK_OPTIONS, 2, projectLink),
                leaf("unlink", PROJECT_UNLINK_OPTIONS, 2, projectUnlink),
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
            { syntax: 'goal add "<text>" [--supersedes <id>] [--workspace]', description: ["record a long-term goal, replacing ones it corrects"], verbs: ["add"] },
            { syntax: 'goal retract <id> --why "<reason>"', description: ["withdraw a goal with nothing replacing it"], verbs: ["retract"] }
        ],
        detail: [
            "record an outcome this project exists to reach, or withdraw one by its id.",
            "",
            "  --supersedes <id>     the goal this one replaces, repeatable",
            "  --why <text>          why a withdrawn goal no longer holds; every withdrawal carries one",
            "  --workspace           record at workspace scope: the goal renders in every",
            "                        project's context; its record stays in this project's store",
            "  --demote <id>         past a retention cap: the confirmed entity that frees its place by",
            "                        moving one tier down (full → index, index → search); repeatable",
            "",
            "a project holds as many goals as it means to: recording one displaces",
            "nothing. Replacing a goal is stated with --supersedes, never implied by",
            "stating another.",
            "",
            "a workspace goal is the company's own direction: it is read from inside",
            "every registered project, and it counts against the workspace retention",
            "tier rather than any project's."
        ],
        node: branch({
            name: "goal",
            unnamed: "refuse",
            // `goal set` was the one destructive verb whose caller never named
            // what it destroyed, so it is refused rather than kept working
            // under a spelling that no longer describes what happens.
            refusal: (verb) => verb === "set"
                ? 'goal set is now `self goal add "<text>"` — the goal it replaces is named with --supersedes <id> rather than implied'
                : 'usage: self goal add "<text>" [--supersedes <id>] [--workspace] | retract <id> --why w',
            children: [
                retiring(leaf("add", GOAL_OPTIONS, 1, goalAdd)),
                retiring(leaf("retract", GOAL_OPTIONS, 1, goalRetract, { requires: [WHY_REQUIRED] }))
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
                retiring(leaf("", DECIDE_OPTIONS, 1, cmdDecide)),
                leaf("confirm", {}, 1, ({ positionals }) => confirmDecision(positionals[0])),
                retiring(leaf("decline", WITHDRAW_OPTIONS, 1, ({ values, positionals }) =>
                    withdrawDecision(requireProject(process.cwd()), "decline", positionals[0], values.why),
                { requires: [{ flags: ["why"], hint: "why the proposed decision was turned down" }] })),
                retiring(leaf("retract", WITHDRAW_OPTIONS, 1, ({ values, positionals }) =>
                    withdrawDecision(requireProject(process.cwd()), "retract", positionals[0], values.why),
                { requires: [WHY_REQUIRED] }))
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
                syntax: 'work add "<required outcome>" [--supersedes <work-id> --why w] [--standalone --why w]'
                    + ' [--criteria "<text>" …] [--verify "cN <how>"] [--owner "cN person"]',
                description: [
                    "create a work unit; --supersedes retires the unit it replaces, naming this one its successor",
                    "(the confirmed-at-once form; `work propose` is the one that asks for review first)",
                    "--criteria declares what the unit is judged on, ordered c1..cN; --owner makes one of them a person's own task",
                    "--standalone records at birth that the unit contributes to nothing on purpose, with the reason"
                ],
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
                syntax: "work block|unblock <id> [--criterion cN]",
                description: [
                    "move a work unit (block: --on decision|dependency|external [--why w])",
                    "--criterion moves one declared criterion instead; the unit's own status never changes"
                ],
                verbs: ["block", "unblock"]
            },
            {
                syntax: 'work criteria add <id> "<text>" [--verify "<how it is checked>"] [--owner person]',
                description: [
                    "declare one more completion condition on a unit that already exists",
                    "(appended as the next cN, never inserted; nothing removes one but `self undo`)",
                    "--owner person makes it that person's task rather than this session's"
                ],
                verbs: ["criteria add"]
            },
            {
                syntax: 'work cover <id> --criterion cN --why "<how it is covered>" [--evidence <commit>] [--work <id>]',
                description: [
                    "judge one declared criterion covered; the same claim `state cover` records",
                    "(a criterion no longer needed is covered with a reason and no evidence)"
                ],
                verbs: ["cover"]
            },
            {
                syntax: 'work done <id> [--report "<what verifiably happened>"] [--why w]',
                description: [
                    "close a unit whose outcome was reached; the claim must carry evidence",
                    "(a report with a commit or artifact, or the done-time --report text)",
                    "a unit that declares criteria is refused until every one of them is covered"
                ],
                verbs: ["done"]
            },
            {
                syntax: "work link|unlink <id> --objective o [--objective-project <slug>] | --milestone m | --standalone --why w",
                description: [
                    "state, or withdraw, what a work unit contributes to",
                    "(an objective resolves here first, then across every registered project)",
                    "--standalone states that it contributes to nothing on purpose, and owes the reason",
                    "(`work unlink <id> --standalone` takes that declaration back)"
                ],
                verbs: ["link", "unlink"]
            },
            {
                syntax: 'work propose "<plan>" [--supersedes <work-id> --why w] [--milestone m --value v]'
                    + ' [--standalone --why w] [--criteria "<text>" …] [--verify "cN <how>"] [--owner "cN person"]',
                description: [
                    "propose work for a person to review; the plan text alone is enough",
                    "(--objective or --milestone makes it a gap proposal, which owes the full brief)",
                    "--supersedes proposes a correction: the unit it names is retired when the plan is confirmed",
                    "--criteria declares what the unit is judged on, ordered c1..cN; --owner makes one of them a person's own task",
                    "--standalone plans a unit that closes no stated gap, and says why it contributes to nothing"
                ],
                verbs: ["propose"]
            },
            {
                syntax: 'work revise <id> "<revised plan>" --why w',
                description: [
                    "restate an unstarted plan under the same work id; acceptance is invalidated",
                    "(a plan that has started is corrected by a successor, the way `work add` records one)"
                ],
                verbs: ["revise"]
            },
            {
                syntax: "work confirm|decline <proposal-id> [--why w]",
                description: [
                    "answer a proposed plan; decline states why",
                    "(the record says who confirmed it, and `self undo` takes it back)"
                ],
                verbs: ["confirm", "decline"]
            },
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
            "a unit says one of three things about its outcomes, and nothing infers",
            "them from its wording or its dates:",
            "",
            "  self work link <id> --objective <id>|--milestone <id>   it contributes to that",
            '  self work link <id> --standalone --why "<reason>"       it contributes to nothing,',
            "                                                         and here is why",
            "  self runbook link <run> --work <id>                     it is one occurrence of a",
            "                                                         procedure this project repeats",
            "",
            "a unit that states none of the three is not refused — nothing here forces a",
            "methodology — it is a unit nobody has said anything about yet, which is a",
            "different fact from one that stands alone on purpose. --standalone conceals",
            "nothing: a contribution edge stays until `work unlink` withdraws it, so",
            "moving a unit off an outcome that is over is two statements, the withdrawal",
            "and the declaration.",
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
            "spells a correction. A session spells the same correction as a plan:",
            '`work propose "<corrected outcome>" --supersedes <id> --why w` leaves the unit',
            "it names untouched until the plan is confirmed, and the retirement lands with",
            "the confirm.",
            "",
            "done is the judgment that the outcome was reached, and the claim must",
            "carry evidence: a report with a commit or an artifact, or a done-time",
            "--report stating what verifiably happened — a bare summary never",
            "satisfies. Done is allowed while blocked: completion is a judgment",
            "on the outcome, not the block.",
            "",
            "a unit that declares criteria is not done until every one of them is",
            "covered. They are declared at birth with --criteria, appended later with",
            '`work criteria add <id> "<text>"`, addressed c1..cN in the order they were',
            "declared, and judged one at a time:",
            "",
            '  self work cover <id> --criterion c2 --why "<how it is covered>"',
            '  self work block <id> --criterion c3 --on external --why "<what it waits on>"',
            "",
            "nothing deletes a criterion: a mistaken one is undone with `self undo`, and",
            "one no longer needed is covered with a reason and no evidence. Covering a",
            "blocked criterion is allowed and ends its block — the claim is the newer",
            "fact — and a blocked criterion never changes the unit's own status.",
            "",
            'a criterion can be somebody else\'s task: --owner "cN person" on the add, or',
            "--owner person on `work criteria add`, and `self context` lists it under",
            "Waiting on you with the command that covers it. `by` is who wrote the record;",
            "--owner is whose task the criterion is — a session records a criterion a",
            "person will do, and neither field implies the other. Ownership is stated when",
            "the criterion is declared and nothing re-states it: a wrong one is undone and",
            "declared again.",
            "",
            "a runbook is a procedure this project repeats — registered once, run per",
            "piece of work, with the same stages every run. A work unit's criteria are",
            "that one unit's completion conditions: declared on it, judged on it, never",
            "run again. If you would declare the same list on the next unit too, it is a",
            "runbook.",
            "",
            "a plan is proposed when it wants review before it is worked: `work propose",
            '"<plan>"` records it as work waiting on an answer, and `work confirm` confirms',
            "it under the same id. `work add` is the confirmed-at-once form, exactly as",
            '`decide "<text>"` is to `decide --proposed`. Neither asks for a person at a',
            "keyboard: every record here is one `self undo` takes straight back, and each",
            "states whether a person or a session wrote it. Until it is first started that",
            "plan can be restated in place — `work revise <id> \"<revised plan>\" --why w`",
            "keeps the id, keeps every earlier version in the unit's history, and",
            "invalidates the confirmation, so the plan is confirmed again before it can be",
            "picked up. Unlike `objective revise` and `milestone revise`, it mints no new",
            "id and supersedes nothing. The first `work start` freezes the plan: after it,",
            "a correction is a successor, the same as for any confirmed record.",
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
            "  --standalone          this unit contributes to no outcome on purpose; --why states",
            "                        why, and `work unlink <id> --standalone` takes it back",
            "  --supersedes <id>     the unit this one replaces: it retires with this unit as",
            "                        its successor, and --why states why the outcome moved",
            "                        on `work propose`, the retirement waits for the acceptance",
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
            "  --expires <date>      when an unanswered proposal lapses",
            "  --criteria <text>     a completion condition this unit is judged on, repeatable",
            "                        and ordered c1..cN",
            '  --verify "cN <how>"   how one declared criterion is checked — recorded, never',
            "                        executed (bare on `work criteria add`, which declares one)",
            '  --owner "cN person"   the criterion is a person\'s own task rather than this',
            "                        session's — it waits on them in `self context`; stated",
            "                        at declaration and never re-stated (bare on `work",
            "                        criteria add`, which declares one)",
            "  --criterion <cN>      which declared criterion a claim or a block answers",
            "  --evidence <commit>   a commit recorded with the coverage claim",
            "  --work <id>           the unit a coverage claim cites as its evidence"
        ],
        node: branch({
            name: "work",
            unnamed: "options",
            refusal: (verb) => `unknown work subcommand "${verb}" — use add|show|start|started|exited|block|unblock|criteria|cover|done|retire|link|unlink|propose|revise|confirm|decline`,
            children: WORK_CHILDREN
        })
    },
    {
        name: "handoff",
        usage: [{
            syntax: "handoff <work-id> [--project <slug>]",
            description: ["compile one deterministic, self-contained read-only packet for a fresh agent"],
            verbs: [""]
        }],
        detail: [
            "compile the fixed common protocol, applicable conventions, bounded project",
            "context, complete work and report history, and location-correct recovery.",
            "The packet is read-only and uses exact work ids; it has no --workspace mode.",
            "",
            "  --project <slug>  read the exact owning project, including an explicitly named archived target"
        ],
        node: leaf("", HANDOFF_OPTIONS, 1, cmdHandoff)
    },
    {
        name: "undo",
        usage: [
            {
                syntax: "undo [<event-id>] [--supersession] [--why <text>]",
                verbs: [""]
            }
        ],
        detail: [
            "take back a record made by mistake. The id names the event to undo; with",
            "no id at all the newest append is the target, which is the one a receipt",
            "was just printed for.",
            "",
            "No --why is owed. \"This was a mistake\" is the whole statement, and the",
            "annulment already names the event it reversed.",
            "",
            "One append is one undo: a `work done --report` and a `work confirm` each",
            "write more than one event as a single state change, and undoing either",
            "half takes back the whole of it. A record something was already built on",
            "is refused with the list of what stands on it and the lines to take those",
            "back first — never a cascade nobody asked for.",
            "",
            "A few kinds are refused by name, each naming the verb that does the job:",
            "a registered artifact and a prune (`self artifact prune`; nothing takes back",
            "a deletion), a project archive or restore (`self project restore|archive",
            "<slug>`, which run from anywhere this verb cannot), process telemetry",
            "(a process really ran), and an undo itself.",
            "",
            "No terminal is needed, here or anywhere else that records. This verb is",
            "why: a record a session wrote is a record a person takes back in one line,",
            "so nothing recording had to ask for a keyboard first. Removing stored bytes",
            "is the one act it cannot reach, and `self artifact prune` still asks.",
            "",
            "  --supersession  take back only what a creation displaced, leaving the",
            "                  record itself standing",
            "  --why <text>    why the record was wrong, where it is worth saying"
        ],
        node: leaf("", UNDO_OPTIONS, 1, ({ values, positionals }) =>
            cmdUndo(requireProject(process.cwd()), positionals[0], values))
    },
    // The command list is handed over as a thunk rather than imported by
    // `apply.ts`: this is the root list the verb dispatches against, and a
    // module that composes commands importing the composition back is a cycle.
    applyCommand(() => COMMANDS),
    {
        name: "report",
        usage: [
            {
                syntax: 'report <work-id> "<summary>" [--file path] [--evidence v] [--artifact path] [--entry file] [--next n] [--friction f]',
                description: ["add --design --implements <decision-id> to submit a design or scope proposal,", "which is refused unless every decision it cites still holds"],
                verbs: [""]
            },
            {
                syntax: "report confirm <report-id>",
                description: ["approve a design, binding the approval to the artifact's hash"],
                verbs: ["confirm"]
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
            "  --artifact <path>   copy a file into the store and attach it, repeatable;",
            "                      a directory attaches as one bundle — every file it",
            "                      holds, under one id (a design report carries exactly",
            "                      one artifact: the design)",
            "  --entry <file>      the member of that bundle a person is meant to open,",
            "                      named relative to the directory's own root; without",
            "                      it, index.html, index.md or README.md at that root,",
            "                      else a generated index",
            "  --next <text>       what the next session should pick up",
            "  --friction <text>   one sentence on what differed from expectation,",
            "                      repeatable; --next is what happens later, --friction",
            "                      is what already went other than planned. Optional —",
            "                      `self context` says so when a project stops writing it",
            "  --design            this report proposes a design or a scope, not history",
            "  --implements <id>   the decisions the design implements, repeatable and",
            "                      comma-separable; every one must exist, still hold, and",
            "                      render in the work unit's project",
            "",
            "a design report is refused unless it cites a live decision, and the receipt",
            "prints each cited decision's own text so a design that drifted from it is",
            "visible at submission. Changing direction is spelled by superseding the",
            "decision and citing the successor — no flag skips the citation.",
            "",
            "`report confirm` records the approval of a design. It binds to the design",
            "artifact's own hash, so the approval names which exact bytes were ruled on,",
            "and the event states whether a person or a session wrote it — a session",
            "records the answer the person already gave, and `self undo` takes the ruling",
            "back. `self work start` refuses a unit whose design is unapproved, whose",
            "approval names no hash, or whose decision has since been superseded or",
            "retracted.",
            "",
            "both forms write, so neither takes a read scope: they record into the",
            "project the named work unit belongs to."
        ],
        node: branch({
            name: "report",
            // Every other first argument is a work id, so only the literal
            // verb is a subcommand — the same reading `decide` takes.
            unnamed: "text",
            refusal: 'usage: self report <work-id> "<summary>" [--design --implements <id>] | confirm <report-id>',
            children: [
                leaf("", REPORT_OPTIONS, 2, cmdReport),
                leaf("confirm", {}, 1, cmdReportConfirm)
            ]
        })
    },
    ARTIFACT_COMMAND,
    STORE_COMMAND,
    {
        name: "convention",
        usage: [
            { syntax: 'convention add "<text>" [--supersedes <event-id>] [--workspace] [--public] [--artifact <id|path>]', description: ["record a rule, optionally replacing ones it corrects"], verbs: ["add"] },
            { syntax: 'convention drop <event-id> --why "<reason>"', description: ["retire a convention with nothing replacing it"], verbs: ["drop"] }
        ],
        detail: [
            "record a rule this project works by, or retire one by its event id.",
            "",
            "  --supersedes <id>     the convention this one replaces, repeatable",
            "  --artifact <id|path>  the guide this rule points at: an `a-` id this project stores,",
            "                        or a path registered now. One per rule, and context renders a",
            "                        pointer to it — the pointer counts against the retention cap,",
            "                        the document does not, so a rule may point at a long guide",
            "  --why <text>          why a dropped rule no longer holds; every withdrawal carries one",
            "  --workspace           record at workspace scope: the rule renders in every",
            "                        project's context; its record stays in this project's store",
            "  --public              also render the rule into the managed AGENTS.md/CLAUDE.md block;",
            "                        without it the rule stays in the store and never reaches a",
            "                        tracked file",
            "  --demote <id>         past a retention cap: the confirmed entity that frees its place by",
            "                        moving one tier down (full → index, index → search); repeatable",
            "",
            "correcting a rule is one event, not a drop and a re-add: the replacement",
            "carries the lineage, so the pair can never both read as current.",
            "",
            "visibility is stated once, at the moment the rule is recorded. To change it,",
            "restate the rule with --supersedes and the visibility you want."
        ],
        node: branch({
            name: "convention",
            unnamed: "refuse",
            refusal: 'usage: self convention add "<text>" [--supersedes <event-id>] [--workspace] [--public] [--artifact <id|path>]'
                + " | drop <event-id> --why w",
            children: [
                retiring(leaf("add", CONVENTION_OPTIONS, 1, conventionAdd)),
                retiring(leaf("drop", CONVENTION_OPTIONS, 1, conventionDrop, { requires: [WHY_REQUIRED] }))
            ]
        })
    },
    STATE_COMMAND,
    ALIAS_COMMAND,
    RUNBOOK_COMMAND,
    SKILL_COMMAND,
    INSTRUCTION_COMMAND,
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
            "  --global    write into this machine's agent instruction files instead",
            "",
            "the block carries the fixed protocol and the conventions recorded with",
            "--public. Every other record stays in the store, where `self context`",
            "renders it — these files are tracked, and the block is repository content."
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
    SWEEP_COMMAND,
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

// Which of the two kinds of store this makes, then the making of it.
//
// The order is what keeps a question from being asked that has no reason to be:
// two flags that contradict each other is a mistake whatever the answer would
// have been, and a directory that is already a store is answered by what is
// there rather than by asking what to put there.
async function cmdInit({ values }: CommandInput<typeof INIT_OPTIONS>): Promise<CommandOutput>
{
    const named = namedMode(values);
    const cwd = process.cwd();
    const storeDir = join(cwd, STORE_DIR);
    if (existsSync(storeDir))
    {
        return alreadyThere(storeDir, named);
    }
    // Here rather than where the code is used. The cloud branch reads it after
    // an inline device login, so a typo in it used to cost a browser, a page
    // and an approval before the refusal — while the git branch has always
    // refused it first. Both branches now answer a bad code the same way.
    if (values.lang !== undefined)
    {
        validLang(String(values.lang));
    }
    return withAgents(await storeOf(named ?? askStoreMode(), cwd, storeDir, values), values);
}

// The store the chosen mode makes, and the one flag that belongs to only one of
// them. `--workspace` names a workspace on a server, and a git-backed store has
// none — accepting it there would take an argument, do nothing with it, and
// leave the caller believing this machine was attached to something.
function storeOf(mode: StoreMode, cwd: string, storeDir: string,
    values: CommandInput<typeof INIT_OPTIONS>["values"]): Promise<CommandOutput>
{
    if (mode === "cloud")
    {
        return connectCloud(cwd, storeDir, values.workspace, () => validLang(values.lang ?? askLang()));
    }
    if (values.workspace !== undefined)
    {
        throw new CliError("`--workspace` names a workspace on a server, and a git-backed store keeps its records "
            + "here — pass `--cloud` to attach this machine to that workspace, and nothing was created");
    }
    return gitInit(cwd, storeDir, values);
}

// Asked of both kinds of store, because it is a question about this machine
// rather than about where the records go: the agents here are the ones that
// will be offering to register projects, whichever workspace those projects
// end up in.
function withAgents(made: CommandOutput, values: CommandInput<typeof INIT_OPTIONS>["values"]): CommandOutput
{
    const agents = values.agents === true || askAgents();
    return agents ? [...made, ...connectMachineAgents()] : made;
}

// A store keeps its records in a git repository this machine commits, or on a
// workspace server it is signed in to, and one store is one or the other for
// its whole life.
type StoreMode = "git" | "cloud";

function namedMode(values: CommandInput<typeof INIT_OPTIONS>["values"]): StoreMode | undefined
{
    if (values.git === true && values.cloud === true)
    {
        throw new CliError("`--git` and `--cloud` name the two kinds of store a workspace can keep its records in, "
            + "and one store is one or the other — pass whichever this one is, and nothing was created");
    }
    if (values.git === true)
    {
        return "git";
    }
    return values.cloud === true ? "cloud" : undefined;
}

// The question, and the refusal that stands in its place where nobody is there
// to be asked. There is no default: which kind of store this is decides where
// every record this workspace ever holds is kept, and it is not undone by
// running the command again — so a machine driving this CLI states it, and a
// person is asked it.
function askStoreMode(): StoreMode
{
    if (!atKeyboard())
    {
        throw new CliError("a workspace store keeps its records in a git repository this machine commits, or on a "
            + "workspace server this machine is signed in to, and nobody is at this terminal to be asked which — "
            + "pass `--git` or `--cloud`");
    }
    return readStoreMode(askLine("where should this workspace keep its records — [g]it here, or the [c]loud? [g/c]: "));
}

function readStoreMode(answer: string): StoreMode
{
    const said = answer.trim().toLowerCase();
    if (said === "g" || said === "git")
    {
        return "git";
    }
    if (said === "c" || said === "cloud")
    {
        return "cloud";
    }
    throw new CliError(`"${answer.trim()}" is neither, so nothing was created — `
        + "run `self init` again and answer `g` for a git repository here or `c` for a workspace server");
}

// The git-backed store, exactly as it has always been made.
async function gitInit(cwd: string, storeDir: string,
    values: CommandInput<typeof INIT_OPTIONS>["values"]): Promise<CommandOutput>
{
    const lang = validLang(values.lang ?? askLang());
    ensureDir(storeDir);
    writeFileSync(join(storeDir, "registry.jsonl"), "");
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({ lang }) + "\n");
    ensureWorkspaceRepo(storeDir);
    ensureSyncConfig(storeDir);
    excludeLocally(cwd, STORE_DIR + "/");
    commitAll(storeDir, "self init");
    setMachineWorkspace(cwd);
    return [{ kind: "receipt", text: `workspace initialized at ${storeDir} (views in "${lang}")` }];
}

// What is already at `.superself`, in the four ways it can be there. Only the
// last of them is this command succeeding at nothing.
//
// A store is git-backed or server-backed for its whole life, and the mode a
// caller named is answered against the mode that is there: asking for the kind
// this store is not is a refusal, because nothing this command does could turn
// one into the other and reporting "already initialized" would say it had.
//
// Nothing here asks anything. A directory that is already a store has no
// question left in it, which is why this stands in front of the one `init`
// would otherwise ask.
function alreadyThere(storeDir: string, named: StoreMode | undefined): CommandOutput
{
    if (!isStore(storeDir))
    {
        throw new CliError(`${storeDir} already exists and is not a workspace store — another tool owns that directory`);
    }
    if (serverBacked(storeDir))
    {
        throw new CliError(`${storeDir} is a server-backed workspace store — one store is one or the other, and ${
            attachedTo(storeDir)}`);
    }
    if (named === "cloud")
    {
        throw new CliError(`${storeDir} is a git-backed workspace store — one store is one or the other, and `
            + "`--cloud` makes the kind whose records a workspace server holds");
    }
    return [{ kind: "receipt", text: `workspace already initialized at ${storeDir}` }];
}

// Whether this machine is actually using the store that is there.
//
// The marker says the store keeps its records on a server; it says nothing
// about whether this machine ever finished attaching to it. A flow killed
// between the marker and the pointer leaves exactly that — a store whose
// records are a server's and a machine pointing nowhere — and claiming
// "attached already" over it left no `self init` able to move and named
// neither remedy.
function attachedTo(storeDir: string): string
{
    if (sameDirectory(machineWorkspace(), dirname(storeDir)))
    {
        return "this machine is attached to a workspace already";
    }
    return "this machine is not using it — run `self workspace " + dirname(storeDir) + "` to point this machine at "
        + "it, or remove that directory to start over";
}

// Two paths, compared as the directory each of them reaches rather than as
// text. A machine is pointed at what `self workspace` resolved, and a shell
// standing in the same place through a symlink has a different string for it —
// so comparing the strings answers "this machine is not using it" for a store
// this machine is using, and sends somebody to repair a pointer that is right.
// A path that cannot be resolved is one of the two that is not there, which is
// an honest "no".
function sameDirectory(pointer: string | null, dir: string): boolean
{
    const at = pointer === null ? null : reachedBy(pointer);
    return at !== null && at === reachedBy(dir);
}

function reachedBy(dir: string): string | null
{
    try
    {
        return realpathSync(dir);
    }
    catch
    {
        return null;
    }
}

// Asked once, at the only moment a person is certain to be present — and
// `atKeyboard` is what "certain" means here rather than a pair of terminals.
//
// A runner stamps an attempt marker on every child it starts, and such a
// process can have both ends of a terminal: reading `isTTY` alone put this
// question to an agent that will never answer it, after the store had already
// been written. `false` is the answer a process with nobody behind it always
// gave down a pipe, and it is the answer it gives now however many terminals
// it has.
function askAgents(): boolean
{
    if (!atKeyboard())
    {
        return false;
    }
    const answer = askLine("tell the agents on this machine about self, so they offer to register projects? [Y/n]: ");
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

// The same decision as every other question this command asks, for the same
// reason: an agent's process is not a person however many terminals it has,
// and one that is asked this hangs on it forever. `en` is what a piped caller
// has always been given and is what a marked process is given now.
function askLang(): string
{
    if (!atKeyboard())
    {
        return "en";
    }
    const answer = askLine("language for the HTML views (en, ko, …) [en]: ").trim();
    return answer === "" ? "en" : answer;
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
        throw new CliError(`"${projectDir}" is another checkout of the registered project "${sibling}" — run \`self project link ${sibling} --here\` instead of registering a duplicate`);
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
//
// The second is a completion and not a dead end, which is why this stays a
// refusal: `project link` records the link, writes the marker, guarantees the
// state directory and folds, exactly as a registration does after its row
// (#251 T1.7, T3.1). What must not happen is `project init` writing a second
// row for a slug that has one.
function refuseTakenSlug(storeDir: string, projectDir: string, slug: string): void
{
    if (!readRegistry(storeDir).some((entry) => entry.slug === slug))
    {
        return;
    }
    const held = resolveProjectPath(storeDir, slug, projectDir);
    throw new CliError(`project "${slug}" is already registered${held === null
        ? " in this workspace, with no directory linked on this machine" : ` at ${held}`}`
        + ` — run \`self project link ${slug} --here\` if this directory is that project,`
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
            + "or `self project link <slug> --here` if it is a checkout of a project registered already";
    }
    return 'usage: self project | init [--name <slug>] [--desc "<description>"] | link [slug] [path|--here] [--force]'
        + ' | unlink [slug] <path|--here> [--force] | from <parent-slug> --why "<reason>"';
}

// The leaf accepts one positional so a path can be refused by name here. The
// arity gate would answer a stray argument with the syntax alone, and the
// mistake this verb exists to end is precisely a caller who believes it takes
// one (#251 T1.8).
async function projectInit({ values, positionals }: CommandInput<typeof PROJECT_INIT_OPTIONS>): Promise<CommandOutput>
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
    // Where the records live on a server, the workspace makes the project and
    // this machine registers what the workspace made — id and all. A refusal
    // arrives here, at the command somebody is waiting on, rather than as a
    // queue that will not empty; nothing local has been written yet, so
    // nothing local is left behind by one.
    const id = serverBacked(ctx.storeDir) ? await createWorkspaceProject(ctx.storeDir, slug, values.desc) : undefined;
    registerProject(ctx, projectDir, slug, values.desc, id);
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
function registerProject(ctx: CliContext, projectDir: string, slug: string, description: string | undefined,
    id: string | undefined): void
{
    const entry: Record<string, unknown> = { slug, added: new Date().toISOString() };
    if (description !== undefined)
    {
        entry.description = description;
    }
    // The workspace's own id for this project, on the row from the moment the
    // row exists. `pusher.ts` reads it at P6 to tell a project this machine
    // made and never registered from one the workspace has forgotten, and a
    // window in which the row is there without it is a window in which a push
    // would re-create a project somebody deleted.
    if (id !== undefined)
    {
        entry.id = id;
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

// `project link` reads unless told where to write (#332): with neither a path
// nor --here it prints where the slug is linked and whether this directory is
// one of those paths, and moves nothing. Running it to look used to re-point
// the link to wherever it was run from, and the next fold judged every
// evidence verdict against that repository.
function projectLink({ values, positionals }: CommandInput<typeof PROJECT_LINK_OPTIONS>): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    const target = linkTarget(positionals[1], values.here === true, values.force === true);
    if (target === null)
    {
        return linkListing(ctx, positionals[0]);
    }
    const projectDir = resolve(target);
    if (!existsSync(projectDir))
    {
        throw new CliError(`"${projectDir}" does not exist`);
    }
    const slug = positionals[0] ?? inferredSlug(ctx.storeDir, projectDir);
    if (!readRegistry(ctx.storeDir).some((entry) => entry.slug === slug))
    {
        throw new CliError(`project "${slug}" is not registered — run \`self project init\` inside its directory instead`);
    }
    requireLinkable(ctx.storeDir, slug, projectDir, values.force === true);
    linkProject(ctx, slug, projectDir);
    // A registry row can stand with no state directory behind it — the shape a
    // crashed registration leaves — and this verb is the completion path the
    // init refusal names (#251 T1.7). The fold writes into that directory, so
    // it is guaranteed here exactly as registerProject guarantees it (#257).
    ensureDir(join(projectStateDir(ctx.storeDir, slug), "work"));
    foldProject(ctx.storeDir, slug);
    return [{ kind: "receipt", text: `project "${slug}" linked to ${projectDir}` }];
}

// Where a write goes, or `null` for a read. One of a path and --here, never
// both; --force alone is a write with nowhere to go, and is refused rather
// than read as one.
function linkTarget(path: string | undefined, here: boolean, force: boolean): string | null
{
    if (path !== undefined && here)
    {
        throw new CliError("project link takes one of <path> or --here — a path names the directory to link, --here links this one");
    }
    if (path !== undefined)
    {
        return path;
    }
    if (here)
    {
        return process.cwd();
    }
    if (force)
    {
        throw new CliError("--force applies to a write — name the path to link, or pass --here to link this directory");
    }
    return null;
}

// The read form. The slug, when omitted, is the one this directory answers
// for — the marker, else the repository — exactly as every read verb finds it.
function linkListing(ctx: CliContext, wanted: string | undefined): CommandOutput
{
    const slug = wanted ?? requireProject(process.cwd()).project;
    requireRegistered(ctx.storeDir, slug);
    return [linkedListing(ctx.storeDir, slug)];
}

// Where the slug stands on this machine, as one block. `project unlink`
// answers with it too — "what is left" after a detachment is the same question
// this listing exists to answer, and wording it twice is how two answers drift
// apart (#263).
function linkedListing(storeDir: string, slug: string): OutputBlock
{
    const linked = linkedPaths(storeDir, slug);
    const cwd = realPath(process.cwd());
    const remedy = `run \`self project link ${slug} --here\``;
    const rows = linked.length === 0
        ? [`project "${slug}" has no linked path on this machine — ${remedy} from its checkout`]
        : [`project "${slug}" is linked on this machine to:`,
            ...linked.map((path) => `  ${path}${contains(path, cwd) ? "  (this directory)" : ""}`)];
    if (linked.length > 0 && !linked.some((path) => contains(path, cwd)))
    {
        rows.push(`this directory is not linked — ${remedy} to link it`);
    }
    return { kind: "listing", rows, total: linked.length, noun: "linked path" };
}

// Linking a repository the project does not have yet, while it has one, is
// the act that changes where its evidence is judged (#331) — a person's call,
// asked for with --force and disclosed before the write (#332). Another
// checkout of a linked repository, a path already linked, a path inside one,
// and the #115 replacement at a known path are not that act.
function requireLinkable(storeDir: string, slug: string, projectDir: string, force: boolean): void
{
    const linked = linkedPaths(storeDir, slug);
    const target = realPath(projectDir);
    if (linked.length === 0 || linked.some((path) => contains(path, target)) || checkoutOfLinked(target, linked))
    {
        return;
    }
    if (!force)
    {
        throw new CliError(`project "${slug}" is linked to ${linked.join(", ")}; "${projectDir}" is a different repository — ` +
            "pass --force to link it as well, and the project's evidence is then judged in both");
    }
    notice(`project "${slug}" was linked to ${linked.join(", ")}; now linked to ${[...linked, target].join(", ")}`);
}

// Whether the path is a checkout — a clone or a worktree — of a repository
// already linked, told by identity. A checkout with no commit yet claims
// nothing and is taken as it always was; a path that is no repository stands
// for the repositories below it, which is exactly what the guard is for.
function checkoutOfLinked(target: string, linked: string[]): boolean
{
    if (commonDir(target) === null)
    {
        return false;
    }
    const identity = repositoryIdentity(target);
    return identity === null || linked.some((path) => repositoryIdentity(path) === identity);
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
            `name the one you mean: \`self project link <slug> --here\` from its directory`);
    }
    return requireText(undefined, "project link <slug> [path|--here]");
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
    const change = recordLink(ctx.storeDir, slug, projectDir, repositoryIdentity(projectDir));
    if (change === "replaced")
    {
        // A disclosure the caller is owed before the link is replaced, not the
        // verb's answer: it prints where it stands, through the gate's notice,
        // so nothing moves relative to the recorded line that follows it.
        notice(`replacing the repository previously linked at ${projectDir}`);
    }
    if (change !== "unchanged")
    {
        // The set of repositories the project is judged across moved, so the
        // verdicts judged against the previous set are stale; the fold that
        // follows walks them again (#332).
        dropEvidenceHead(ctx.storeDir, slug);
    }
    writeFileSync(join(projectDir, MARKER_FILE), JSON.stringify({ project: slug }) + "\n");
    excludeLocally(projectDir, MARKER_FILE);
}

// `project link` undone (#263). A registered checkout path leaves this
// machine's link ledger — a path whose checkout is gone included, which is the
// one thing no other verb could do and the reason the issue exists. Nothing of
// the project itself moves: no event, and the registry row it was registered
// with stands, so the slug stays registered and resolvable from its own
// directory.
function projectUnlink({ values, positionals }: CommandInput<typeof PROJECT_UNLINK_OPTIONS>): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    // Refused before the slug is resolved, exactly as `link` refuses its
    // spellings first: which directory a command was typed in cannot decide
    // whether the command was typed correctly.
    const named = unlinkTarget(positionals[1], values.here === true, positionals[0]);
    const slug = positionals[0] ?? requireProject(process.cwd()).project;
    requireRegistered(ctx.storeDir, slug);
    const path = named === null
        ? hereLink(ctx.storeDir, slug)
        : requireLinkedPath(ctx.storeDir, slug, resolve(named));
    requireDetachable(ctx.storeDir, slug, path, values.force === true);
    const marker = detachProject(ctx, slug, path);
    warnStillResolving(ctx.storeDir, slug, path);
    foldProject(ctx.storeDir, slug);
    return [
        {
            kind: "receipt",
            text: `project "${slug}" unlinked from ${path}${marker ? ` — its ${MARKER_FILE} marker there is gone too` : ""}`
        },
        linkedListing(ctx.storeDir, slug)
    ];
}

// The path a write was told to take away, or `null` for `--here`. Unlike
// `link`, naming neither is not a read: `self project link <slug>` already
// prints what is linked, and a second verb printing it would be two spellings
// for one answer. `--force` needs no case of its own — with nothing named it
// has nothing to apply to, and falls into the same refusal.
function unlinkTarget(path: string | undefined, here: boolean, slug: string | undefined): string | null
{
    if (path !== undefined && here)
    {
        throw new CliError("project unlink takes one of <path> or --here — a path names the directory to detach, --here detaches this one");
    }
    if (path !== undefined)
    {
        return path;
    }
    if (here)
    {
        return null;
    }
    throw new CliError("project unlink takes the path to detach — name it, or pass --here to detach this directory"
        + ` (\`self project link ${slug ?? "<slug>"}\` lists what is linked)`);
}

// What `--here` means: the recorded path that contains this directory. The
// same containment marks a row `(this directory)` in the listing, so what a
// reader sees marked is what `--here` takes away — and a subdirectory of a
// linked checkout is inside it, which is where a person actually stands.
function hereLink(storeDir: string, slug: string): string
{
    const recorded = recordedPaths(storeDir, slug);
    const cwd = realPath(process.cwd());
    // Deepest first: a folder of checkouts and a checkout inside it can both
    // be linked, and both contain this directory. The nearer one is the one a
    // person standing here means.
    const here = recorded.filter((path) => contains(path, cwd)).sort((a, b) => b.length - a.length)[0];
    if (here !== undefined)
    {
        return here;
    }
    throw new CliError(recorded.length === 0
        ? `project "${slug}" has no linked path on this machine — nothing to unlink`
        : `this directory is not a linked path of "${slug}" — it is linked to ${recorded.join(", ")}; name the path to detach`);
}

// An explicit path matches a recorded one exactly — containment is `--here`'s
// job, and a verb that removes things guesses at nothing. The path is resolved
// through `realPath` as the ledger records it; a path that is already gone
// resolves to itself, which is how a dead link is nameable at all.
function requireLinkedPath(storeDir: string, slug: string, path: string): string
{
    const target = realPath(path);
    const recorded = recordedPaths(storeDir, slug);
    if (recorded.includes(target))
    {
        return target;
    }
    const holder = slugsLinkedAt(storeDir, target).find((other) => other !== slug);
    if (holder !== undefined)
    {
        throw new CliError(`"${target}" is linked to project "${holder}", not "${slug}" — ` +
            `run \`self project unlink ${holder} ${target}\` to detach it there`);
    }
    throw new CliError(`"${target}" is not a linked path of project "${slug}"` + (recorded.length === 0
        ? " — it has no linked path on this machine"
        : `, which is linked to ${recorded.join(", ")}`));
}

// Taking away the last checkout this machine has is the act that changes where
// the project's evidence is judged — to nowhere — so it is asked for with
// --force and disclosed before the write, the mirror of what adding a
// repository asks for (#332). A path whose checkout is already gone resolved
// nothing to begin with, so it is never the last standing one.
function requireDetachable(storeDir: string, slug: string, path: string, force: boolean): void
{
    const standing = linkedPaths(storeDir, slug);
    if (!standing.includes(path) || standing.length > 1)
    {
        return;
    }
    if (!force)
    {
        throw new CliError(`"${path}" is the only checkout of "${slug}" on this machine — unlinking it leaves the project ` +
            "resolvable only from its own directory and the path its registry row recorded — pass --force to detach it anyway");
    }
    notice(`project "${slug}" had one checkout on this machine (${path}); after this it has none`);
}

// The ledger entry and the marker go together: `link` wrote both, and a marker
// left behind keeps the directory answering for the project after its link is
// gone — the detachment not happening. A marker naming another project is
// another project's, and stays.
function detachProject(ctx: CliContext, slug: string, path: string): boolean
{
    // The ledger is this machine's, never the store's: the exclude is asserted
    // on every write to it, exactly as `linkProject` asserts it, so a store
    // whose links file predates the rule cannot start syncing paths here.
    excludeLocally(ctx.storeDir, LINKS_FILE);
    recordUnlink(ctx.storeDir, slug, path);
    // The set of repositories the project is judged across moved, so the
    // verdicts judged against the previous set are stale; the fold that
    // follows walks them again (#332).
    dropEvidenceHead(ctx.storeDir, slug);
    const marker = join(path, MARKER_FILE);
    if (!existsSync(marker) || markerSlug(marker) !== slug)
    {
        return false;
    }
    rmSync(marker);
    return true;
}

// A marker file too broken to read claims nothing, and is left where it is:
// removing a file whose contents could not be understood is not this verb's
// call to make.
function markerSlug(marker: string): string | null
{
    try
    {
        const read = JSON.parse(readFileSync(marker, "utf8")).project;
        return typeof read === "string" ? read : null;
    }
    catch
    {
        return null;
    }
}

// A project is identified by its repository, so another checkout of the same
// repository that stayed linked keeps answering for the detached path (#6).
// Said plainly rather than left for the reader to discover: the receipt names
// a path that is out of the ledger, and the listing names what is left, but
// neither of them says the directory still resolves.
function warnStillResolving(storeDir: string, slug: string, path: string): void
{
    if (!existsSync(path))
    {
        return;
    }
    const through = checkoutProject(storeDir, path);
    if (through === null || through.slug !== slug)
    {
        return;
    }
    const linked = linkedPaths(storeDir, slug);
    const identity = repositoryIdentity(path);
    const siblings = linked.filter((other) => repositoryIdentity(other) === identity);
    notice(`${path} still answers for "${slug}" — another checkout of its repository is linked ` +
        `(${(siblings.length === 0 ? linked : siblings).join(", ")}); unlink that too to detach the repository`);
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
        usage, entityCharacters({ text, artifact: payloadArtifact(payload) }), supersedeTargets(payload));
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
    // Every preset kind corrects a record the same way, so they all disclose
    // through this one line rather than each add verb deciding. A proposal
    // displaces nothing until it is confirmed, and discloses nothing.
    const displaced = proposed ? [] : supersedeTargets(payload);
    recordRetirement(ctx, retirementIntent(models[0], "supersede", displaced,
        { successor: supersedingRecord(payload) }), models[0],
        (by) =>
        {
            event.payload = { ...payload, by };
            return [event, ...demotionEvents(demotions, event.id, proposed)];
        },
        text);
}

function goalAdd({ values, positionals }: CommandInput<typeof GOAL_OPTIONS>): void
{
    const text = requireText(positionals[0], 'goal add "<text>" [--supersedes <id>] [--workspace]');
    if (values.why !== undefined)
    {
        throw new CliError("goal add takes no --why — the goal is its own statement; --why records why a goal was withdrawn");
    }
    const ctx = requireProject(process.cwd());
    const models = workspaceModels(ctx.storeDir, ctx.project);
    presetEntityEvent(ctx, models, "goal", text, goalExtra(models[0], values), undefined, { demote: values.demote });
}

// Everything the flags say about a goal beyond its text: what it replaces, and
// where it renders.
function goalExtra(model: ProjectModel, values: CommandInput<typeof GOAL_OPTIONS>["values"]): Record<string, unknown>
{
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
    if (values.workspace === true)
    {
        // A placement value, not a read scope (#207 D6, #287): the goal renders
        // in every project's context while its record stays in this store.
        extra.scope = "workspace";
    }
    return extra;
}

function goalRetract({ values, positionals }: CommandInput<typeof GOAL_OPTIONS>): void
{
    if (values.supersedes !== undefined)
    {
        throw new CliError('goal retract takes no --supersedes — to replace a goal, run `goal add "<text>" --supersedes <id>`');
    }
    if (values.workspace === true)
    {
        throw new CliError("goal retract takes no --workspace — a goal is withdrawn wherever it renders; --workspace states a new goal's scope");
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
    recordRetirement(ctx, retirementIntent(model, "retract", [goal.id], { why: payload.why }), model,
        (by) => [makeEvent(ctx.project, "entity.retracted",
            { ...payload, by }, { retracts: goal.id }, true)],
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
    recordRetirement(ctx, retirementIntent(model, "retract", withdrawn, { why: payload.why }), model,
        (by) => [makeEvent(ctx.project, "entity.retracted",
            { ...payload, by }, refs, true)],
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
    // Before the retirement is resolved: a call that spells both corrections
    // is refused for the collision rather than for whichever of the two the
    // reading order happened to reach first.
    const born = bornStandalone(id, values);
    const retirement = supersededRetirement(ctx, id, values);
    // The unit is recorded and what it contributes to is still nobody's
    // statement (#286). The model is the one read before the append, which is
    // all this needs: the objectives it names are not changed by the unit.
    const superseded = retirement === undefined
        ? undefined
        : model.works.find((work) => work.id === retirement.payload.entity);
    const payload = workPayload(ctx, id, outcome, declarationOf(values, "work add"), born);
    recordRetirement(ctx, retirementIntent(model, "supersede",
        retirement === undefined ? [] : [String(retirement.payload.entity)],
        { successor: supersedingRecord(payload) }), model,
        (by) => addedEvents(ctx, payload, retirement, by),
        `${id} ${outcome}`);
    return [{ kind: "receipt", text: id }, attachmentListing(model, id, superseded, born.length > 0)];
}

// The unit, and the retirement it displaces where there is one — composed
// together so both land in one append, each saying who wrote it (#400).
function addedEvents(ctx: ProjectContext, payload: Record<string, unknown>,
    retirement: SelfEvent | undefined, by: WrittenBy): SelfEvent[]
{
    const events = [makeEvent(ctx.project, "entity.confirmed", { ...payload, by })];
    if (retirement !== undefined)
    {
        retirement.payload = { ...retirement.payload, by };
        events.push(retirement);
    }
    return events;
}

// The disposition a unit is born with, where the call states one (#417 §1).
// It rides the creation event's own link list rather than a second append: a
// unit and what it says about its outcomes are one statement, and `self undo`
// on the creation takes both back together.
//
// `--why` is already spoken for on this verb — it states why a superseded unit
// gave up its outcome — so the two cannot be spelled in one call. Refusing
// says which two reasons collided and how to state both.
function bornStandalone(id: string, values: CommandInput<typeof WORK_ADD_OPTIONS>["values"]): Record<string, unknown>[]
{
    if (values.standalone !== true)
    {
        return [];
    }
    if (values.supersedes !== undefined)
    {
        throw new CliError("work add --why states why the replaced unit gave up its outcome, and --standalone needs a "
            + "reason of its own — record the correction first, then `self work link <new-id> --standalone --why \"…\"`");
    }
    const why = requireText(values.why, 'work add "<outcome>" --standalone --why "<why it contributes to no outcome>"');
    return [{ ...standaloneEdge(id, why) }];
}

function workPayload(ctx: ProjectContext, id: string, outcome: string, declared: Declaration,
    links: Record<string, unknown>[]): Record<string, unknown>
{
    const row = presetRow(ctx.storeDir, "work");
    const payload: Record<string, unknown> = {
        entity: id,
        text: outcome,
        labels: [row.label],
        links,
        // Byte-identical to what this wrote before #408 for a unit that
        // declares nothing, which is every unit in every store written before
        // it: an empty list and no `verify` key at all.
        ...declared,
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
        // A standalone declaration owns the `--why` on such a call, and
        // `bornStandalone` has already refused the pair that would make one
        // reason answer for two statements.
        if (values.why !== undefined && values.standalone !== true)
        {
            throw new CliError("work add --why states why a replaced unit gave up its outcome — pass --supersedes <work-id> too, or record the reason with `self report`");
        }
        return undefined;
    }
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireSupersedableWork(ctx, model, values.supersedes);
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

function cmdHandoff({ values, positionals }: CommandInput<typeof HANDOFF_OPTIONS>): CommandOutput
{
    const wanted = requireText(positionals[0], "handoff <work-id> [--project <slug>]");
    const ctx = requireWorkspace(process.cwd());
    return handoffOutput(captureHandoff(ctx, wanted, values.project));
}

function captureHandoff(ctx: CliContext, wanted: string, project: string | undefined): HandoffSnapshot
{
    if (project !== undefined)
    {
        requireRegistered(ctx.storeDir, project);
    }
    const readAtDate = new Date();
    const models = orderedSlugs(ctx).map((slug) => buildModel(ctx.storeDir, slug, readAtDate));
    const found = resolveHandoffWork(ctx, wanted, project, models);
    const archived = projectArchive(ctx.storeDir, found.slug) !== undefined;
    if (archived && project === undefined && ctx.project !== found.slug)
    {
        throw new CliError(`project "${found.slug}" is archived — pass --project ${found.slug} to address it explicitly`);
    }
    requireWorkable(found);
    const sources = handoffSourceModels(ctx.storeDir, found.slug, models);
    const conventions = applicableConventions(found.slug, sources);
    const verdicts = readVerdicts(ctx.storeDir, found.slug);
    return {
        readAt: readAtDate.toISOString(), packetProject: ctx.project, targetProject: found.slug,
        targetModel: found.model, work: found.work, supersedes: handoffSupersededSources(found.slug, found.work, models),
        sourceModels: sources, conventions,
        contextLines: handoffContextLines(ctx.storeDir, found.model, sources,
            new Set(conventions.map((item) => item.id)), verdicts),
        instructions: handoffInstructionLines(found.model, sources),
        verdicts, archived, ownerCheckoutAvailable: handoffCheckoutAvailable(ctx, found.slug)
    };
}

// A packet hands a session work to do, and a unit whose own creation was taken
// back has none (#390): the id still resolves — `self work show` answers for
// it — but handing it over would brief a session on a mistake.
function requireWorkable(found: FoundWork): void
{
    if (found.work.status === "undone")
    {
        throw new CliError(`${found.work.id} was recorded by mistake and undone — there is nothing to hand over; `
            + `\`self work show ${found.work.id}\` says what it was and when it was taken back`);
    }
}

function resolveHandoffWork(ctx: CliContext, wanted: string, project: string | undefined,
    models: ProjectModel[]): FoundWork
{
    const candidates = models.filter((model) => project === undefined || model.slug === project);
    const matches = candidates.flatMap((model) => model.works.filter((work) => work.id === wanted)
        .map((work) => ({ slug: model.slug, model, work })));
    if (matches.length === 0)
    {
        const prefix = candidates.flatMap((model) => model.works.filter((work) => work.id.startsWith(wanted)));
        if (prefix.length > 0)
        {
            throw new CliError(`handoff requires the exact work id "${wanted}" — prefix matching is not supported`);
        }
        throw new CliError(wrongKindHint(wanted, "work") ?? `unknown work id "${wanted}" — run \`self work\` to list open ids`);
    }
    const current = matches.find((match) => match.slug === ctx.project);
    if (current !== undefined)
    {
        return current;
    }
    if (matches.length > 1)
    {
        throw new CliError(`work id "${wanted}" exists in more than one project (${matches.map((m) => m.slug).join(", ")}) — pass --project <slug>`);
    }
    return matches[0];
}

function handoffSourceModels(storeDir: string, target: string, models: ProjectModel[]): ProjectModel[]
{
    return models.filter((model) => model.slug === target || projectArchive(storeDir, model.slug) === undefined);
}

function handoffSupersededSources(target: string, work: WorkState, models: ProjectModel[]): string[]
{
    return models.flatMap((model) => model.works
        .filter((item) => item.status === "retired" && item.successor?.work === work.id
            && item.successor.project === target)
        .map((item) => `${item.id} (${model.slug}) — ${item.retiredWhy}`));
}

function handoffCheckoutAvailable(ctx: CliContext, target: string): boolean
{
    if (ctx.project === target && ctx.projectDir !== undefined && existsSync(ctx.projectDir))
    {
        return true;
    }
    const path = resolveProjectPath(ctx.storeDir, target);
    return path !== null && existsSync(path);
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
// The two lines that lead the page, then the page, then what `--for` attached
// to the unit (#407). The attachments are composed here for the reason
// liveness is: they are read from the derived registry rather than folded onto
// the unit, so the synced `work/<id>.md` carries exactly what it always did.
function workPageLines(ctx: CliContext, found: FoundWork): string[]
{
    const body = renderWorkBody(found.work, found.model, readVerdicts(ctx.storeDir, found.slug),
        supersededSources(ctx, found));
    const attached = attachedArtifactLines(ctx.storeDir, found.slug, found.work.id);
    return [
        ...optionalLine(holderNote(found.work)),
        ...optionalLine(scopeNote(found)),
        ...markdownHeadings([body.trimEnd(), ...attached].join("\n")).split("\n")
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
    requireDispatchable(ctx, owner, work);
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

// The dispatch half of the design gate (#316), read before the claim and
// before the brief: picking a unit up is what turns a design into code, so a
// design nobody approved — or one whose decision has since been superseded —
// stops here rather than being noticed at review.
function requireDispatchable(ctx: ProjectContext, owner: string, work: WorkState): void
{
    // Review first, and composed here rather than inside the design gate: a
    // plan nobody accepted is not a design that stopped standing, and one
    // gate answering both questions would be two rules under one name (#356).
    const refused = reviewRefusal(work) ?? dispatchRefusal(workspaceModels(ctx.storeDir, owner), owner, work);
    if (refused !== null)
    {
        throw new CliError(refused);
    }
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
    recordRetirement(ctx, retirementIntent(model, "retire", [work.id], { why }), model,
        (by) => [makeEvent(ctx.project, "entity.retired",
            { ...payload, by }, undefined, true)],
        `${work.id} ${why}`);
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

function transitionWork(type: string, { values, positionals }: CommandInput<typeof WORK_BLOCK_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    const { work, owner } = requireOpenWork(ctx, positionals[0]);
    const payload: Record<string, unknown> = { entity: work.id };
    if (type === "entity.blocked")
    {
        // The gate demanded --on; what is left is whether the reason it names
        // is one the work graph knows. Judged before the criterion is
        // resolved, so a caller who typed both mistakes is told about the enum
        // rather than about an id.
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
    if (values.criterion !== undefined)
    {
        blockCriterion(ctx, work, owner, values, type === "entity.blocked");
        return;
    }
    recordEvent(ctx, makeEvent(owner, type, payload), `${work.id} ${work.outcome}`);
}

// The criterion axis of the same verb (#408). The unit's own status never
// moves: one unit reading active and blocked at once is what a criterion-scoped
// block exists to avoid, and `views.ts` already states the rule the other way
// round for runbook approvals.
function blockCriterion(ctx: ProjectContext, work: WorkState, owner: string,
    values: CommandInput<typeof WORK_BLOCK_OPTIONS>["values"], blocking: boolean): void
{
    // A plan nobody confirmed has no working state to move — the shipped
    // `executionTarget` rule, one level down.
    if (work.status === "review")
    {
        throw new CliError(`${work.id} is a plan still awaiting review — a criterion's block records a fact about `
            + `work that holds; confirm it first with \`self work confirm ${work.id}\``);
    }
    const entity = criterionRecord(ctx, work.id, owner);
    const state = criterionNamed(entity, String(values.criterion));
    if (blocking)
    {
        recordCriterionBlock(ctx, owner, entity, state, String(values.on), values.why);
        return;
    }
    recordCriterionUnblock(ctx, owner, entity, state);
}

// The record a criterion-axis write lands on, read out of the log that owns it
// (#181 D3): a unit scoped in from another project resolves here and its
// criteria are declared and judged where its own events live.
function criterionRecord(ctx: ProjectContext, id: string, owner: string): EntityState
{
    const entity = buildModel(ctx.storeDir, owner, new Date()).entities.find((item) => item.id === id);
    if (entity === undefined)
    {
        throw new CliError(`${id} is folded from history no criterion can attach to — declare criteria on a unit `
            + "this CLI recorded");
    }
    return entity;
}

// Which criterion a `cN` or a text names, as the state the writers judge. The
// resolver answers with the text, which is the criterion's identity in the log.
function criterionNamed(entity: EntityState, wanted: string): CriterionState
{
    const criterion = resolveCriterion(entity, wanted);
    return entity.criterionStates.find((item) => item.text === criterion) as CriterionState;
}

// A criterion declared after the record was created (#408). Allowed on a plan
// still under review — a plan being shaped is exactly when its conditions get
// stated, and declaring is not a claim about doing — and refused on an outcome
// already judged.
function cmdWorkCriteriaAdd({ values, positionals }: CommandInput<typeof CRITERIA_ADD_OPTIONS>): CommandOutput
{
    const usage = 'work criteria add <work-id> "<text>" [--verify "<how it is checked>"] [--owner person]';
    const ctx = requireProject(process.cwd());
    const { work, owner: project } = requireDeclarable(ctx, requireText(positionals[0], usage));
    const text = requireText(positionals[1], usage);
    const stated = {
        verify: values.verify === undefined ? undefined : requireText(values.verify, usage),
        owner: values.owner === undefined
            ? undefined
            : requirePersonOwner(requireText(values.owner, usage), "work criteria add")
    };
    recordDeclaration(ctx, project, criterionRecord(ctx, work.id, project), text, stated);
    return [{ kind: "receipt", text: declarationReceipt(work, text, stated.owner) }];
}

// The receipt states the facts a caller needs: which `cN` the criterion became,
// whose task it is where that was stated, and — where the unit declared none
// until now — that done waits on it from this moment.
function declarationReceipt(work: WorkState, text: string, owner: string | undefined): string
{
    const at = `c${work.criteria.length + 1}`;
    return `${work.id} ${at} "${text}"${owner === undefined ? "" : ` (${owner})`}`
        + `${work.criteria.length === 0 ? " — done now waits on it" : ""}`;
}

// Which units may still be handed a completion condition: a plan under review,
// and a unit that is open. A done outcome is already judged, a retired one was
// given up, and an undone one never held.
function requireDeclarable(ctx: ProjectContext, wanted: string): OpenWork
{
    const found = requireRenderedWork(ctx, wanted);
    const refusal = DECLARE_REFUSAL[found.work.status]?.(found.work);
    if (refusal !== undefined)
    {
        throw new CliError(refusal);
    }
    return found;
}

const DECLARE_REFUSAL: Record<string, ((work: WorkState) => string) | undefined> = {
    done: (work) => `${work.id} is done — a criterion states what completion required, and this outcome is already judged`,
    retired: (work) => `${work.id} was retired — declare it on the successor, whose criteria start uncovered`,
    undone: (work) => `${work.id} was recorded by mistake and is undone — there is nothing to declare a criterion on`
};

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
    const dir = reportingDir(ctx);
    const { commits, notes } = classifyEvidence(dir, values.evidence ?? headEvidence(dir));
    if (commits.length > 0)
    {
        refs.commits = commits;
        // Says the split already happened, against the repository that could
        // answer it. A reader of this event must take these as revisions rather
        // than guess at their shape a second time.
        payload.evidenceTyped = true;
        // Which repository that was, beside the branch the pipeline stamps: a
        // project spanning several judges the hash where the report made it
        // (#331). A checkout with no commit has no identity to record.
        const repository = repositoryIdentity(dir);
        if (repository !== null)
        {
            refs.repository = repository;
        }
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

// What differed from expectation, moved out of report prose and into a key a
// later reader can collect (#380). Optional by ruling: a report with no
// friction records exactly as it always did, and only `self context` remarks
// on a project that has stopped writing it. Blank is refused rather than
// stored — an empty sentence records the flag without recording the fact, and
// the writer passing it meant to state one.
function attachFriction(sentences: string[] | undefined, payload: Record<string, unknown>): void
{
    const stated = (sentences ?? []).map((sentence) => sentence.trim());
    if (stated.some((sentence) => sentence === ""))
    {
        throw new CliError('--friction takes one sentence saying what differed from expectation — pass --friction "the root suite took 25 minutes, not the 12 CONTRIBUTING states", or leave the flag off');
    }
    if (stated.length > 0)
    {
        payload.friction = stated;
    }
}

function cmdReport({ values, positionals }: CommandInput<typeof REPORT_OPTIONS>): CommandOutput
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
    attachFriction(values.friction, payload);
    // Before a byte is staged: a design citing a decision that no longer holds
    // must leave the store exactly as it found it.
    const cited = designCitations(ctx, owner, values, refs, payload);
    const staged = stageArtifacts(ctx.storeDir, owner, values.artifact, values.entry);
    if (staged.artifacts.length > 0)
    {
        payload.artifacts = staged.artifacts;
        refs.artifacts = staged.artifacts.map((meta) => meta.id);
    }
    const event = makeEvent(owner, "report.added", payload, refs);
    commitStaged(staged, (recorded) => recordEvent(ctx, event, `${work.id} ${text}`, recorded));
    return cited === null ? [] : [designReceipt(event.id, work.id, cited, staged.artifacts.length > 0)];
}

// The submission half of the design gate (#316). Marks the event and resolves
// the citation, or refuses — and the two flags are refused apart, because a
// design with no citation and a citation on an ordinary report are each a
// caller meaning something the record cannot carry.
function designCitations(ctx: ProjectContext, owner: string,
    values: CommandInput<typeof REPORT_OPTIONS>["values"],
    refs: EventRefs, payload: Record<string, unknown>): CitedDecision[] | null
{
    const ids = citedIds(values.implements);
    if (values.design !== true)
    {
        if (ids.length > 0)
        {
            throw new CliError("--implements states what a design implements — pass --design too, or leave it off an ordinary report");
        }
        return null;
    }
    if (ids.length === 0)
    {
        throw new CliError("a design report has to say which decision it implements — pass --implements <decision-id> (`self search --type decision` lists them), or drop --design if this reports what happened");
    }
    if ((values.artifact ?? []).length > 1)
    {
        throw new CliError("a design report carries one artifact — the design an approval binds to — so pass --artifact once");
    }
    const cited = requireCitations(workspaceModels(ctx.storeDir, owner), owner, ids);
    payload.design = true;
    refs.implements = cited.map((item) => item.id);
    return cited;
}

// The echo the issue asks for: each cited decision's own text, beside the
// command that approves the design. A design that drifted from its decision is
// readable here, at submission, rather than at review.
function designReceipt(report: string, work: string, cited: CitedDecision[], bound: boolean): OutputBlock
{
    const next = bound
        ? `  it is approved with: self report confirm ${report}`
        : "  no artifact attached, so this design binds no hash — `self work start` refuses until an approved design carries one";
    return {
        kind: "receipt",
        text: [`design report ${report} recorded for ${work}`, ...citationLines(cited), next].join("\n")
    };
}

// The approval half (#316). There is no approval verb left in the CLI —
// decision 01kz2nczhtde554qx5tqpqzrt3 removed the whole governance layer — so
// this is the one ruling on a design there is. What it binds to is the design
// artifact's digest: what is approved is a set of bytes, and the record says
// which, whoever recorded it.
//
// It asked for a person at a terminal until #400. The ruling is undoable —
// `self undo` takes a `report.confirmed` back like any other record — so the
// approval is recorded from wherever the person said yes, and the event states
// who wrote it.
function cmdReportConfirm({ positionals }: CommandInput<Record<string, never>>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const wanted = requireText(positionals[0], "report confirm <report-id> — `self work show <work-id>` lists a unit's reports");
    const found = requireDesignReport(ctx, wanted);
    // A bundle stores no digest of its own, so the digest is derived from its
    // manifest (#362): a stored hash could contradict the member list, and a
    // derived one cannot.
    const digest = artifactDigest(found.report.artifacts[0]);
    if (digest === undefined)
    {
        throw new CliError(`${found.report.id} carries no artifact digest, so there is nothing for an approval to bind to — resubmit the design with --artifact <path>`);
    }
    if (found.report.approval !== undefined)
    {
        return [{ kind: "receipt", text: `${found.report.id} was already approved on ${found.report.approval.ts.slice(0, 10)} — nothing recorded` }];
    }
    return recordDesignApproval(ctx, found, digest);
}

interface FoundReport
{
    owner: string;
    work: WorkState;
    report: ReportEntry;
}

function recordDesignApproval(ctx: ProjectContext, found: FoundReport, digest: string): CommandOutput
{
    const payload = { report: found.report.id, digest, by: writtenBy() };
    const refs: EventRefs = { work: found.work.id, confirms: found.report.id, artifacts: found.report.artifacts.map((meta) => meta.id) };
    recordEvent(ctx, makeEvent(found.owner, "report.confirmed", payload, refs, true), `${found.work.id} design ${found.report.id} approved`);
    return [{ kind: "receipt", text: `${found.report.id} approved for ${found.work.id}, bound to artifact ${digest.slice(0, 12)}` }];
}

// A report is named by its own event id, and it is found wherever the unit
// carrying it renders — the same workspace-wide reading `work show` takes, so
// a design is approved from the person's own checkout rather than only from
// the one the agent submitted it in.
function requireDesignReport(ctx: ProjectContext, wanted: string): FoundReport
{
    for (const model of workspaceModels(ctx.storeDir, ctx.project))
    {
        for (const work of model.works)
        {
            const report = work.reports.find((item) => item.id === wanted || item.id.startsWith(wanted));
            if (report !== undefined && report.design === true)
            {
                return { owner: model.slug, work, report };
            }
            if (report !== undefined)
            {
                throw new CliError(`${report.id} is an ordinary report, not a design — only a report recorded with --design is approved`);
            }
        }
    }
    throw new CliError(`no report "${wanted}" — \`self work show <work-id>\` lists a unit's reports by id`);
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

function headEvidence(dir: string): string[]
{
    const head = headCommit(dir);
    return head === null ? [] : [head];
}

// The repository a report is made from: the project directory where that is
// a repository, else the checkout the command stands in. A project registered
// at the folder holding its repositories has no HEAD of its own, and the
// evidence a report attaches by default is the HEAD of wherever it ran (#331).
function reportingDir(ctx: ProjectContext): string
{
    return topOf(ctx.projectDir) !== null || topOf(process.cwd()) === null ? ctx.projectDir : process.cwd();
}

function conventionAdd({ values, positionals }: CommandInput<typeof CONVENTION_OPTIONS>): void
{
    const text = requireText(positionals[0], 'convention add "<text>" [--supersedes <event-id>] [--workspace] [--public]');
    if (values.why !== undefined)
    {
        throw new CliError("convention add takes no --why — the rule is its own statement; --why records why a rule was withdrawn");
    }
    const ctx = requireProject(process.cwd());
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const extra = conventionExtra(models[0], values);
    // Last, after every other refusal: a path is registered here, and the
    // registration is one event of its own that a later refusal cannot take
    // back (#238).
    const artifact = resolveArtifactRef(ctx, values.artifact);
    if (artifact !== undefined)
    {
        extra.artifact = artifact;
    }
    presetEntityEvent(ctx, models, "convention", text, extra, undefined, { demote: values.demote });
}

// Everything the flags say about a rule beyond its text: what it replaces,
// where it renders, and whether it may reach a tracked file.
function conventionExtra(model: ProjectModel, values: CommandInput<typeof CONVENTION_OPTIONS>["values"]): Record<string, unknown>
{
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
    if (values.public === true)
    {
        // The one thing that lets a rule reach AGENTS.md and CLAUDE.md, which
        // are tracked (#276). Absent from the payload otherwise, so a rule
        // recorded any other way — `state add`, an alias preset — is internal
        // for good, which is the safe direction to be stuck in.
        extra.visibility = "public";
    }
    return extra;
}

// The option table is declared once for the whole verb, so the subcommand that
// does not take one of these says so by name rather than dropping the flag and
// ignoring what the person meant by it. Each of the three states something
// about a *new* rule, and a withdrawal states none of them.
function refuseStatingFlags(values: CommandInput<typeof CONVENTION_OPTIONS>["values"]): void
{
    if (values.supersedes !== undefined)
    {
        throw new CliError('convention drop takes no --supersedes — to replace a rule, run `convention add "<text>" --supersedes <event-id>`');
    }
    if (values.workspace === true)
    {
        throw new CliError("convention drop takes no --workspace — a rule is dropped wherever it renders; --workspace states a new rule's scope");
    }
    if (values.public === true)
    {
        throw new CliError("convention drop takes no --public — a rule is dropped wherever it renders; --public states a new rule's visibility");
    }
    if (values.artifact !== undefined)
    {
        throw new CliError('convention drop takes no --artifact — a rule points at a guide when it is stated; to change what it points at, '
            + 'restate the rule with `convention add "<text>" --supersedes <event-id> --artifact <id|path>`');
    }
}

function conventionDrop({ values, positionals }: CommandInput<typeof CONVENTION_OPTIONS>): void
{
    refuseStatingFlags(values);
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
    recordRetirement(ctx, retirementIntent(model, "retract", [id], { why: payload.why }), model,
        (by) => [makeEvent(ctx.project, "entity.retracted",
            { ...payload, by }, { retracts: id }, true)],
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

// A fold that could recompute nothing says so instead of claiming success.
// The band is not consulted here the way the health signal consults it: the
// receipt answers what this command did, and skipping the recomputation is
// what it did whether or not anything was left unshipped (#308).
function cmdFold(): CommandOutput
{
    const ctx = requireProject(process.cwd());
    foldWorkspace(ctx.storeDir, ctx.project);
    commitAll(ctx.storeDir, `fold ${ctx.project}: manual refold`);
    return [{ kind: "receipt", text: verdictsFrozen(ctx.storeDir, ctx.project)
        ? `folded ${ctx.project}'s pages — evidence verdicts were not recomputed: no checkout of `
            + `"${ctx.project}" is linked on this machine; run \`self project link ${ctx.project} --here\` in it`
        : `refolded ${ctx.project}` }];
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

// A mistaken record is erased, not ceremonially superseded (#390). The event
// is named rather than the record, because what went wrong is an act, not a
// state — and because naming the act is what lets this stay safe under a
// merge: an annulment cannot have been written without seeing the event it
// reverses, which is the exact case a withdrawal stays terminal against.
function cmdUndo(ctx: ProjectContext, prefix: string | undefined, values: { why?: string; supersession?: boolean }): CommandOutput
{
    const events = readEvents(ctx.storeDir, ctx.project);
    const event = undoTarget(ctx, events, prefix);
    requireUndoable(event);
    const taken = annulledIds(events);
    requireNotAnnulled(taken, event);
    // A member already taken back on its own is left alone: one annulment per
    // annulled event keeps `refs.annuls` the single carrier of the meaning.
    const unit = coupledUnit(events, event).filter((member) => !taken.has(member.id));
    const dependents = dependentsOf(events, unit);
    if (dependents.length > 0)
    {
        throw refuse("built_on", dependentRefusal(event, dependents));
    }
    return recordAnnulment(ctx, unit, event, values);
}

// The append the annulments are written as: one `entity.annulled` per member
// of the coupled unit, all in one write, so a reader can never find half of an
// undo either.
function recordAnnulment(ctx: ProjectContext, unit: SelfEvent[], event: SelfEvent,
    values: { why?: string; supersession?: boolean }): CommandOutput
{
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const named = annulledRecord(event);
    const record = model.entities.find((item) => item.id === named);
    const text = record?.text ?? named;
    recordEvents(ctx, unit.map((member) => makeEvent(ctx.project, "entity.annulled",
        annulmentPayload(member, values), { annuls: member.id }, false)), `${named} ${text}`.trim());
    return [{ kind: "receipt", text: undoneNote(ctx, unit, event, named, values.supersession === true, record) }];
}

// The three criterion-axis undos, which name the criterion by the `cN` the
// fold computes and therefore need the record, not the event alone. Read off
// the fold as it stood before the annulment: a block and its release both
// leave the declared list where it was, so `c3` is still `c3`, and a
// declaration taken back is named by its text because its position leaves
// with it.
function criterionNote(ctx: ProjectContext, event: SelfEvent, named: string, record: EntityState | undefined): string | null
{
    const text = String(event.payload.criterion ?? "");
    const at = record?.criterionStates.find((item) => item.text === text);
    if (event.type === CRITERION_DECLARED)
    {
        return `${named} no longer declares "${text}" — the declaration was taken back; the criteria after it renumber`;
    }
    if (at === undefined)
    {
        return null;
    }
    if (event.type === CRITERION_BLOCKED)
    {
        return `${named} ${at.id} is open again — the block was taken back`;
    }
    return event.type === CRITERION_UNBLOCKED
        ? `${named} ${at.id} waits on ${blockedAgain(ctx, event)} again — the release was taken back`
        : null;
}

// What the restored block says it waits on. The release carries neither the
// `--on` nor the `--why`, so they are read back off the block this undo puts
// back — the newest one recorded against this criterion before the release.
function blockedAgain(ctx: ProjectContext, release: SelfEvent): string
{
    const block = readEvents(ctx.storeDir, ctx.project)
        .filter((item) => item.type === CRITERION_BLOCKED && item.payload.entity === release.payload.entity
            && item.payload.criterion === release.payload.criterion && item.ts <= release.ts)
        .sort((left, right) => left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id)).at(-1);
    const why = block?.payload.why === undefined ? "" : `: ${String(block.payload.why)}`;
    return `${String(block?.payload.on ?? "external")}${why}`;
}

// `undid` lets `self log` render the annulment's row without resolving the
// event it names. `why` is optional (#390 R2): "this was a mistake" is the
// whole statement, and the annulment already names what it reversed.
function annulmentPayload(member: SelfEvent, values: { why?: string; supersession?: boolean }): Record<string, unknown>
{
    const entity = annulledRecord(member);
    return {
        undid: member.type,
        ...(entity === "" ? {} : { entity }),
        ...(values.supersession === true ? { scope: "supersession" } : {}),
        ...(values.why === undefined ? {} : { why: values.why })
    };
}

// What an undo actually gave back, in the words of the act it reversed.
// Undoing a link never removed the record and undoing a revision never removed
// it either, so neither says "standing again", which would claim a
// restoration that did not happen; a creation taken back says the opposite —
// the record is gone, and saying it stands would be the same error mirrored.
const UNDONE_NOTE: ReadonlyArray<readonly [string, (record: string) => string]> = [
    ["entity.linked", (record) => `${record} no longer carries the link — the linked event was taken back`],
    ["entity.unlinked", (record) => `${record} carries the link again — the unlink was taken back`],
    ["entity.revised", (record) => `${record} states its previous plan again — the revision was taken back`],
    ["entity.retracted", (record) => `${record} is standing again — its withdrawal was taken back`],
    ["entity.retired", (record) => `${record} is standing again — its retirement was taken back`],
    ["entity.covered", (record) => `${record} has that criterion open again — the coverage claim was taken back`],
    ["entity.placed", (record) => `${record} is placed where it was — the placement was taken back`],
    ["report.added", (record) => `the report on ${record} was taken back`],
    // Named by neither end: the link's own id is what went, and whichever
    // record it was attached to is standing exactly as it was (#407).
    ["artifact.linked", () => "the link is no longer recorded — `self artifact list` no longer shows it, and nothing was removed from the store"]
];

function undoneNote(ctx: ProjectContext, unit: SelfEvent[], event: SelfEvent, named: string, narrow: boolean,
    record: EntityState | undefined): string
{
    if (narrow)
    {
        return `${named} stands and no longer claims to replace anything — its supersession was taken back`;
    }
    const rest = unit.length === 1 ? "" : ` (${unit.length} events of one append, taken back together)`;
    return `${criterionNote(ctx, event, named, record) ?? namedNote(event, named)}${rest}`;
}

function namedNote(event: SelfEvent, named: string): string
{
    const stated = UNDONE_NOTE.find(([type]) => type === event.type);
    if (stated !== undefined)
    {
        return stated[1](named);
    }
    if (event.type === "entity.confirmed" && event.refs?.confirms !== undefined)
    {
        return `${named} is proposed again — its confirm was taken back; it is confirmed again with `
            + `\`self work confirm ${named}\``;
    }
    if (event.type === "entity.proposed" || event.type === "entity.confirmed")
    {
        return `${named} was recorded by mistake and is undone — it is gone from every live surface`;
    }
    return `${named} is open again — its ${event.type.replace("entity.", "")} was taken back`;
}

// Which record an event speaks about, for the receipt and the annulment's own
// payload. A creation that displaced something names the record it displaced
// only under `--supersession`; otherwise it names its own.
function annulledRecord(event: SelfEvent): string
{
    const named = String(event.payload.entity ?? event.refs?.work ?? "");
    return named !== "" ? named : supersedeTargets(event.payload)[0] ?? linkedArtifact(event) ?? "";
}

// A link attached to nothing names no other record, so the record an undo of
// it is about is the artifact itself (#407).
function linkedArtifact(event: SelfEvent): string | undefined
{
    const artifact = event.payload.artifact as { id?: unknown } | undefined;
    return typeof artifact?.id === "string" ? artifact.id : undefined;
}

// An undo is not undone (#390): a second one against the same event is
// refused rather than stacked, and one annulment stays in the log.
function requireNotAnnulled(taken: Set<string>, event: SelfEvent): void
{
    if (taken.has(event.id))
    {
        throw new CliError(`${event.id} was already undone — the record it took back is standing`);
    }
}

// The event to take back: the one the id names, or the newest append when the
// caller named none. A record is settled by the next append and nothing else
// (#390 §2.2), so the bare form is the ergonomic payoff — the correction is
// one command with no id to look up.
function undoTarget(ctx: ProjectContext, events: SelfEvent[], prefix: string | undefined): SelfEvent
{
    if (prefix !== undefined)
    {
        return resolveUndoPrefix(ctx, prefix);
    }
    const newest = [...events].sort((left, right) => left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id)).at(-1);
    if (newest === undefined)
    {
        throw new CliError(`nothing has been recorded in "${ctx.project}" — \`self undo <event-id>\` names the event to take back`);
    }
    return newest;
}

// The prefix, resolved in this project's log. An event another project's log
// holds is named rather than reported missing: `undo` writes into the project
// the directory resolves to, so the answer is which directory to stand in.
function resolveUndoPrefix(ctx: ProjectContext, prefix: string): SelfEvent
{
    try
    {
        return findEventByPrefix(ctx.storeDir, ctx.project, prefix);
    }
    catch (error)
    {
        const owner = orderedSlugs(ctx).filter((slug) => slug !== ctx.project)
            .find((slug) => readEvents(ctx.storeDir, slug).some((event) => event.id.startsWith(prefix)));
        if (owner === undefined)
        {
            throw error;
        }
        throw new CliError(`"${prefix}" is an event in project "${owner}", not in "${ctx.project}" — `
            + `undo records into the project the directory resolves to, so run it from ${owner}'s checkout`);
    }
}

// Everything this process remembers between commands, forgotten. The caches are
// each memoized because one command asks the same question repeatedly; none of
// them is a claim about the machine that outlives the command, and `paths.ts`
// already states the lifetime that way — "until the next append or the next
// tick", never "until this process ends".
//
// A second `runCli` in one process is a second command. It may stand in a
// different directory, under a different HOME, against a repository the first
// one's caller created in between; it starts from disk, not from what its
// predecessor found there. The structure check's `invocation-state` rule holds
// this list complete: a new module-level cache is a violation until a reset
// here covers it or an exemption names why it needs none.
function resetInvocation(): void
{
    resetProbes();
    invalidateResolution();
    resetProcessNotices();
    resetHomeRule();
    resetPipeline();
    dropCollected();
    resetVerifierCalls();
    resetCredentialWarnings();
    resetUnreadableNotices();
    selectJsonMode(false);
    suppressJournal(false);
    useAccount(undefined);
}

// Who the log will say wrote this invocation's records, read once, here, and
// carried from here on as a value. This is the whole of the reason the append
// path can stamp an author without holding an import path to a credential, which
// is the structure check's credential-isolation rule.
//
// Read at all only where this machine's store keeps its records on a server. A
// git-backed run must touch no credential file: its log states no account, so
// reading one would be a file opened, a permission checked and a warning
// possibly printed for a value nothing was ever going to use.
function noteAccount(): void
{
    if (machineStoreServerBacked())
    {
        useAccount(currentAccount());
    }
}

export async function runCli(argv: string[]): Promise<void>
{
    resetInvocation();
    process.exitCode = 0;
    try
    {
        await main(argv);
    }
    catch (error)
    {
        reportFailure(error, argv);
    }
    await sendWhatIsQueued();
}

// The last thing a command does, and the first thing that is not the command:
// a server-backed store's queue goes to the workspace.
//
// After the failure report and outside the `try`, because it is owed whatever
// the command did. A verb that recorded three events and then failed rendering
// them has three events to send, and a verb that refused before it wrote
// anything has an older queue that still has not gone.
//
// Nothing it does can change what the caller was told. The sending is a
// separate process by default and this is the call that starts it; the queue is
// the only thing it can leave behind, and the next command reads that.
async function sendWhatIsQueued(): Promise<void>
{
    const storeDir = serverBackedStore();
    if (storeDir !== null)
    {
        await sendQueued(storeDir);
    }
}

// What the caller is told, and what this process exits with. An error with no
// sentence for it is re-thrown rather than swallowed: node prints the stack and
// exits 1, which is the honest answer for a failure the CLI has no words for.
function reportFailure(error: unknown, argv: string[]): void
{
    // The fold refuses in its own error type: `@superself/fold` is folded by
    // a server as well as by this CLI, so it cannot construct a refusal that
    // carries an exit code. Its message becomes one here, at the one
    // boundary, rather than reaching the reporter as an unrecognised throw.
    const raised = error instanceof FoldError ? new CliError(error.message) : error;
    const message = userMessage(raised, argv);
    if (message === null)
    {
        throw raised;
    }
    // The exit vocabulary lives on the error, so a command that constructs
    // none of 2 or 3 keeps exactly the behaviour it had. Under `--json` the
    // envelope goes to stdout, so an agent capturing stdout gets parseable
    // JSON on every path rather than on the successful ones only.
    const refusal = raised instanceof CliError ? raised : null;
    renderFailure(refusal?.code ?? "parse_error", message, refusal?.fields ?? {});
    process.exitCode = refusal?.exit ?? 1;
}
