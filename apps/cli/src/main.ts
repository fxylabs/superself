import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { helpHint, parseCommand, subcommand, unknownOption } from "./args.js";
import { commitStaged, runArtifact, stageArtifacts } from "./artifact.js";
import { runAttemptCommand } from "./attempt/commands.js";
import { connectMachine, connectProject, machineBlock } from "./connect.js";
import { DEFAULT_ZONE, validZone } from "./dates.js";
import { foldEveryProject, foldProject, foldWorkspace, renderWorkBody } from "./fold.js";
import { cmdMilestone, cmdObjective, cmdProposalDecision, cmdPropose, cmdWorkLink, rejectManualProgress } from "./goals.js";
import { classifyEvidence, commitAll, ensureWorkspaceRepo, excludeLocally, headCommit, repositoryIdentity } from "./gitutil.js";
import { cliVersion, commandUsage, findCommand, rootUsage } from "./help.js";
import { workId } from "./ids.js";
import { findEventByPrefix } from "./logfile.js";
import { machineWorkspace, setMachineWorkspace } from "./machine.js";
import { buildModel, DecisionState, ProjectModel, WorkState } from "./model.js";
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
    requireProject,
    requireRegistered,
    requireWorkspace,
    SCOPE_OPTIONS,
    siblingSlug,
    STORE_DIR,
    StoreConfig,
    WORKSPACE_SCOPE_OPTIONS
} from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { doneEvent } from "./requirements.js";
import { runSearch } from "./search.js";
import { printSetup } from "./setup.js";
import { cloneStore, ensureSyncConfig, remoteAdd, syncStore } from "./sync.js";
import { dim, errRed, markdownHeadings, styled } from "./style.js";
import { openFile, validTheme, viewFile } from "./view.js";
import { RENDER_OPTIONS, resolveRender } from "./pretty.js";
import { printContext, printLog, printStatus, printWorkList, printWorkspaceLog } from "./views.js";
import { CliError, EventRefs } from "./types.js";

async function main(argv: string[]): Promise<void>
{
    // Asked of the binary itself, so it stands where a verb would rather than
    // inside one: `self work --version` is a flag `work` never declared, and
    // naming it there is the answer that surface owes.
    if (argv[0] === "--version" || argv[0] === "-V")
    {
        console.log(cliVersion());
        return;
    }
    const help = helpText(argv);
    if (help !== null)
    {
        printUsage(help);
        return;
    }
    const cmd = argv[0] ?? "";
    const rest = argv.slice(1);
    switch (cmd)
    {
        case "init": await cmdInit(rest); break;
        case "workspace": cmdWorkspace(rest); break;
        case "lang": cmdLang(rest); break;
        case "theme": cmdTheme(rest); break;
        case "timezone": cmdTimezone(rest); break;
        case "project": cmdProject(rest); break;
        case "remote": cmdRemote(rest); break;
        case "sync": cmdSync(rest); break;
        case "clone": cmdClone(rest); break;
        case "goal": cmdGoal(rest); break;
        case "objective": cmdObjective(guarded(rest)); break;
        case "milestone": cmdMilestone(guarded(rest)); break;
        case "decide": cmdDecide(rest); break;
        case "work": cmdWork(rest); break;
        case "report": cmdReport(rest); break;
        case "artifact": cmdArtifact(rest); break;
        case "attempt": await runAttemptCommand(rest); break;
        case "convention": cmdConvention(rest); break;
        case "connect": cmdConnect(rest); break;
        case "view": cmdView(rest); break;
        case "context": cmdContext(rest); break;
        case "status": cmdStatus(rest); break;
        case "setup": cmdSetup(rest); break;
        case "log": cmdLog(rest); break;
        case "search": cmdSearch(rest); break;
        case "fold": cmdFold(rest); break;
        default: cmdUnknown(cmd); break;
    }
}

// Bare `self` is a request for the verb list; anything else that reached no
// command is a mistake, named on stderr with a non-zero exit so a caller that
// typoed a verb never reads the usage text as success. An option-looking one
// is a flag that reached no command, so it is named as a flag.
function cmdUnknown(cmd: string): void
{
    if (cmd === "")
    {
        printUsage(rootUsage());
        return;
    }
    if (cmd.startsWith("-"))
    {
        throw new CliError(unknownOption(cmd, undefined));
    }
    throw new CliError(`unknown command '${cmd}' — ${helpHint(undefined)}`);
}

// Help is answered before any command runs, so asking for it needs no
// workspace, writes no event, and always exits successfully.
function helpText(argv: string[]): string | null
{
    if (argv[0] !== "help" && !asksForHelp(argv))
    {
        return null;
    }
    const command = findCommand(argv[0] === "help" ? argv[1] : argv[0]);
    return command === undefined ? rootUsage() : commandUsage(command);
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

// Dim the description column so the command column stands out; piped output is untouched.
function printUsage(usage: string): void
{
    if (!styled)
    {
        console.log(usage);
        return;
    }
    console.log(usage.split("\n").map((line) =>
    {
        const match = line.match(/^(  \S.*?)(\s{2,})(\S.*)$/);
        if (match !== null)
        {
            return match[1] + match[2] + dim(match[3]);
        }
        return /^\s{20,}\S/.test(line) ? dim(line.trimEnd()) : line;
    }).join("\n"));
}

async function cmdInit(rest: string[]): Promise<void>
{
    const { values } = parseCommand("init", rest, { lang: { type: "string" }, agents: { type: "boolean" } }, 0);
    const cwd = process.cwd();
    const storeDir = join(cwd, STORE_DIR);
    if (existsSync(storeDir))
    {
        if (!isStore(storeDir))
        {
            throw new CliError(`${storeDir} already exists and is not a workspace store — another tool owns that directory`);
        }
        console.log(`workspace already initialized at ${storeDir}`);
        return;
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
    console.log(`workspace initialized at ${storeDir} (views in "${lang}")`);
    if (values.agents === true || await askAgents())
    {
        connectMachineAgents();
    }
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

function connectMachineAgents(): void
{
    const files = connectMachine();
    if (files.length === 0)
    {
        console.log("no agent instruction files found on this machine — paste this into yours:\n");
        console.log(machineBlock());
        return;
    }
    console.log(`agents on this machine now know about self — block written into ${files.join(", ")}`);
}

function cmdWorkspace(rest: string[]): void
{
    const [path] = parseCommand("workspace", rest, {}, 1).positionals;
    if (path === undefined)
    {
        console.log(machineWorkspace() ?? "no workspace set — run `self init` in the directory that should hold it");
        return;
    }
    const dir = resolve(path);
    if (!isStore(join(dir, STORE_DIR)))
    {
        throw new CliError(`${dir} holds no workspace store — run \`self init\` there first`);
    }
    setMachineWorkspace(dir);
    console.log(`this machine now uses the workspace at ${dir}`);
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

function cmdLang(rest: string[]): void
{
    const [code] = parseCommand("lang", rest, {}, 1).positionals;
    const ctx = requireWorkspace(process.cwd());
    if (code === undefined)
    {
        console.log(readStoreConfig(ctx.storeDir).lang ?? "en");
        return;
    }
    const lang = validLang(code);
    writeConfig(ctx, { lang }, `lang set ${lang}`);
    console.log(`views now render in "${lang}"`);
}

function guarded(rest: string[]): string[]
{
    rejectManualProgress(rest);
    return rest;
}

function cmdTimezone(rest: string[]): void
{
    const [zone] = parseCommand("timezone", rest, {}, 1).positionals;
    const ctx = requireWorkspace(process.cwd());
    if (zone === undefined)
    {
        console.log(readStoreConfig(ctx.storeDir).timezone ?? DEFAULT_ZONE);
        return;
    }
    const timezone = validZone(zone);
    writeConfig(ctx, { timezone }, `timezone set ${timezone}`);
    console.log(`target dates are now judged in "${timezone}"`);
}

function cmdTheme(rest: string[]): void
{
    const [name] = parseCommand("theme", rest, {}, 1).positionals;
    const ctx = requireWorkspace(process.cwd());
    if (name === undefined)
    {
        console.log(readStoreConfig(ctx.storeDir).theme ?? "violet");
        return;
    }
    const theme = validTheme(name);
    writeConfig(ctx, { theme }, `theme set ${theme}`);
    console.log(`views now render with the "${theme}" accent`);
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

function cmdProject(rest: string[]): void
{
    const sub = subcommand("project", rest);
    if (sub === "add")
    {
        projectAdd(rest.slice(1));
        return;
    }
    if (sub === "link")
    {
        projectLink(rest.slice(1));
        return;
    }
    throw new CliError('usage: self project add [path] [--name <slug>] [--desc "<description>"] | link [slug] [path]');
}

function projectAdd(args: string[]): void
{
    const { values, positionals } = parseCommand(
        "project",
        args,
        { name: { type: "string" }, desc: { type: "string" }, "no-connect": { type: "boolean" } },
        1
    );
    const ctx = requireWorkspace(process.cwd());
    const projectDir = resolve(positionals[0] ?? process.cwd());
    const slug = values.name ?? basename(projectDir);
    const sibling = siblingSlug(ctx.storeDir, projectDir);
    if (sibling !== null)
    {
        throw new CliError(`"${projectDir}" is another checkout of the registered project "${sibling}" — run \`self project link ${sibling}\` instead of registering a duplicate`);
    }
    if (readRegistry(ctx.storeDir).some((entry) => entry.slug === slug))
    {
        throw new CliError(`project "${slug}" is already registered`);
    }
    const entry: Record<string, unknown> = { slug, added: new Date().toISOString() };
    if (values.desc !== undefined)
    {
        entry.description = values.desc;
    }
    appendFileSync(join(ctx.storeDir, "registry.jsonl"), JSON.stringify(entry) + "\n");
    // The registry this process already read no longer says what the file says.
    // Resolution is cached in memory until something clears it, so the writer
    // of a cached file is the one that has to say it moved (#128).
    invalidateResolution();
    linkProject(ctx, slug, projectDir);
    ensureDir(join(projectStateDir(ctx.storeDir, slug), "work"));
    foldProject(ctx.storeDir, slug);
    commitAll(ctx.storeDir, `project add ${slug}`);
    console.log(`project "${slug}" registered`);
    if (values["no-connect"] !== true)
    {
        const files = connectProject(projectDir, buildModel(ctx.storeDir, slug, new Date()));
        console.log(`managed block rendered into ${files.join(", ")} — commit them so every agent tool loads it`);
    }
}

function projectLink(args: string[]): void
{
    const [wanted, path] = parseCommand("project", args, {}, 2).positionals;
    const ctx = requireWorkspace(process.cwd());
    const projectDir = resolve(path ?? process.cwd());
    if (!existsSync(projectDir))
    {
        throw new CliError(`"${projectDir}" does not exist`);
    }
    const slug = wanted ?? inferredSlug(ctx.storeDir, projectDir);
    if (!readRegistry(ctx.storeDir).some((entry) => entry.slug === slug))
    {
        throw new CliError(`project "${slug}" is not registered — run \`self project add\` instead`);
    }
    linkProject(ctx, slug, projectDir);
    foldProject(ctx.storeDir, slug);
    console.log(`project "${slug}" linked to ${projectDir}`);
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

function cmdView(rest: string[]): void
{
    const [slug] = parseCommand("view", rest, {}, 1).positionals;
    const ctx = requireWorkspace(process.cwd());
    if (slug !== undefined)
    {
        requireRegistered(ctx.storeDir, slug);
    }
    openFile(ctx, viewFile(ctx.storeDir, slug));
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
        console.log(`replacing the repository previously linked at ${projectDir}`);
    }
    writeFileSync(join(projectDir, MARKER_FILE), JSON.stringify({ project: slug }) + "\n");
    excludeLocally(projectDir, MARKER_FILE);
}

function cmdSync(rest: string[]): void
{
    parseCommand("sync", rest, {}, 0);
    syncStore(requireWorkspace(process.cwd()));
}

function cmdClone(rest: string[]): void
{
    const [url, dir] = parseCommand("clone", rest, {}, 2).positionals;
    cloneStore(requireText(url, "clone <url> [dir]"), dir);
}

// `context` has no workspace form because it already is one: run from outside
// any project, it renders the workspace summary, and --project names one
// project to read instead of the directory's own.
function cmdContext(rest: string[]): void
{
    const { values } = parseCommand("context", rest, { ...SCOPE_OPTIONS, ...RENDER_OPTIONS }, 0);
    printContext(readScope(process.cwd(), values), resolveRender(values));
}

function cmdStatus(rest: string[]): void
{
    const { values } = parseCommand("status", rest, { ...WORKSPACE_SCOPE_OPTIONS, ...RENDER_OPTIONS }, 0);
    printStatus(readScope(process.cwd(), values), resolveRender(values));
}

function cmdSetup(rest: string[]): void
{
    parseCommand("setup", rest, {}, 0);
    printSetup(process.cwd());
}

function cmdArtifact(rest: string[]): void
{
    runArtifact(() => requireWorkspace(process.cwd()), rest);
}

function cmdRemote(rest: string[]): void
{
    if (subcommand("remote", rest) !== "add")
    {
        throw new CliError("usage: self remote add <url>");
    }
    const [, url] = parseCommand("remote", rest, {}, 2).positionals;
    remoteAdd(requireWorkspace(process.cwd()), requireText(url, "remote add <url>"));
}

function cmdGoal(rest: string[]): void
{
    if (subcommand("goal", rest) !== "set")
    {
        throw new CliError('usage: self goal set "<text>"');
    }
    const text = requireText(parseCommand("goal", rest, {}, 2).positionals[1], 'goal set "<text>"');
    const ctx = requireProject(process.cwd());
    recordEvent(ctx, makeEvent(ctx.project, "goal.set", { text }, undefined, true), text);
}

function cmdDecide(rest: string[]): void
{
    // `confirm`, `retract` and `decline` are the only subcommands: every other
    // first argument is the decision text, which may itself start with a dash
    // after `--`. Only the withdrawals take `--why`, so asking `confirm` for
    // one is still named as a flag it does not have.
    if (rest[0] === "confirm")
    {
        const [, prefix] = parseCommand("decide", rest, {}, 2).positionals;
        confirmDecision(requireProject(process.cwd()), prefix);
        return;
    }
    if (rest[0] === "retract" || rest[0] === "decline")
    {
        const { values, positionals } = parseCommand("decide", rest, { why: { type: "string" } }, 2);
        withdrawDecision(requireProject(process.cwd()), rest[0], positionals[1], values.why);
        return;
    }
    const { values, positionals } = parseCommand(
        "decide",
        rest,
        {
            proposed: { type: "boolean" },
            why: { type: "string" },
            supersedes: { type: "string", multiple: true },
            work: { type: "string" },
            blocks: { type: "string", multiple: true },
            after: { type: "string" }
        },
        1
    );
    const ctx = requireProject(process.cwd());
    const text = requireText(positionals[0], 'decide "<decision>" [--why w] [--proposed]');
    const payload: Record<string, unknown> = { text };
    if (values.why !== undefined)
    {
        payload.why = values.why;
    }
    // The work link is stated, never inferred from what happens to be open:
    // most decisions belong to the project, not to a unit of work.
    const refs = decisionRefs(ctx, values);
    const type = values.proposed === true ? "decision.proposed" : "decision.confirmed";
    recordEvent(ctx, makeEvent(ctx.project, type, payload, refs, values.proposed !== true), text);
}

function confirmDecision(ctx: ProjectContext, prefix: string | undefined): void
{
    const target = findEventByPrefix(ctx.storeDir, ctx.project, requireText(prefix, "decide confirm <event-id>"));
    if (target.type !== "decision.proposed")
    {
        throw new CliError(`${target.id} is not a proposed decision`);
    }
    recordEvent(ctx, makeEvent(ctx.project, "decision.confirmed", {}, { confirms: target.id }, true), String(target.payload.text));
}

// Withdrawal without a successor: `retract` takes back a confirmed decision,
// `decline` turns down a proposal. One body, because the two differ only in
// which status they are admitted on and which ref they write — a second copy
// would drift on the part they share, which is every refusal below.
function withdrawDecision(ctx: ProjectContext, verb: "retract" | "decline", prefix: string | undefined, why: string | undefined): void
{
    const usage = `decide ${verb} <event-id> --why "<reason>"`;
    const event = findEventByPrefix(ctx.storeDir, ctx.project, requireText(prefix, usage));
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    // A confirmation event carries no record of its own — the proposal it
    // confirmed is the record — so naming either id reaches the same decision.
    const id = event.type === "decision.confirmed" && event.refs?.confirms !== undefined ? event.refs.confirms : event.id;
    const decision = model.decisions.find((item) => item.id === id);
    if (decision === undefined)
    {
        throw new CliError(`${event.id} is not a decision`);
    }
    const admits = verb === "retract" ? "confirmed" : "proposed";
    if (decision.status !== admits)
    {
        throw new CliError(withdrawalRefusal(verb, decision));
    }
    // Every lifecycle exit that is not a supersession carries its reason: a
    // supersession says why by naming its successor, and nothing else does.
    const payload = { why: requireText(why, usage) };
    const refs = verb === "retract" ? { retracts: decision.id } : { declines: decision.id };
    const type = verb === "retract" ? "decision.retracted" : "decision.declined";
    recordEvent(ctx, makeEvent(ctx.project, type, payload, refs, true), decision.text);
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
    supersedes?: string[];
    work?: string;
    blocks?: string[];
    after?: string;
}

// Every id a decision names is resolved before the event is written, so a
// typo is refused here rather than folding into a relation that points at
// nothing on every machine that pulls it.
function decisionRefs(ctx: ProjectContext, options: DecisionOptions): EventRefs | undefined
{
    const refs: EventRefs = {};
    if (options.supersedes !== undefined && options.supersedes.length > 0)
    {
        refs.supersedes = options.supersedes.map((prefix) => findEventByPrefix(ctx.storeDir, ctx.project, prefix).id);
    }
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

const TRANSITIONS: Record<string, string> = {
    start: "work.started",
    block: "work.blocked",
    unblock: "work.unblocked",
    done: "work.done"
};

function cmdWork(rest: string[]): void
{
    // Listing and showing are workspace reads, so they resolve from any
    // directory; every verb that writes still requires the linked checkout.
    // A bare `--` is not a listing flag: subcommand() explains it below.
    if (rest.length === 0 || (rest[0] !== "--" && rest[0].startsWith("--")))
    {
        cmdWorkList(rest);
        return;
    }
    const sub = subcommand("work", rest);
    if (sub === "show")
    {
        cmdWorkShow(rest.slice(1));
        return;
    }
    if (sub === "add")
    {
        const outcome = requireText(parseCommand("work", rest, {}, 2).positionals[1], 'work add "<required outcome>"');
        const ctx = requireProject(process.cwd());
        const id = workId();
        recordEvent(ctx, makeEvent(ctx.project, "work.created", { work: id, outcome }), `${id} ${outcome}`);
        console.log(id);
        return;
    }
    if (sub === "link" || sub === "unlink")
    {
        cmdWorkLink(requireProject(process.cwd()), rest.slice(1), sub === "link");
        return;
    }
    if (sub === "propose")
    {
        cmdPropose(requireProject(process.cwd()), rest.slice(1));
        return;
    }
    if (sub === "accept" || sub === "decline")
    {
        cmdProposalDecision(requireProject(process.cwd()), rest.slice(1), sub === "accept");
        return;
    }
    if (sub === "retire")
    {
        cmdWorkRetireUnit(rest.slice(1));
        return;
    }
    const type = TRANSITIONS[sub as string];
    if (type === undefined)
    {
        throw new CliError(`unknown work subcommand "${sub}" — use add|show|start|block|unblock|done|retire|link|unlink|propose|accept|decline`);
    }
    transitionWork(type, rest.slice(1));
}

function cmdWorkList(rest: string[]): void
{
    const { values } = parseCommand("work", rest, { ...SCOPE_OPTIONS, ...RENDER_OPTIONS }, 0);
    printWorkList(readScopes(process.cwd(), values)[0], resolveRender(values));
}

function cmdWorkShow(args: string[]): void
{
    const { values, positionals } = parseCommand("work", args, SCOPE_OPTIONS, 1);
    const wanted = requireText(positionals[0], "work show <work-id> [--project <slug>]");
    const ctx = requireWorkspace(process.cwd());
    const found = findWorkAcross(ctx, wanted, values.project);
    if (found === null)
    {
        throw new CliError(`unknown work id "${wanted}" — run \`self work\` to list ids`);
    }
    console.log(markdownHeadings(renderWorkBody(found.work, found.model, readVerdicts(ctx.storeDir, found.slug), supersededSources(ctx, found)).trimEnd()));
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
function cmdWorkRetireUnit(args: string[]): void
{
    const { values, positionals } = parseCommand(
        "work",
        args,
        { why: { type: "string" }, successor: { type: "string" }, "successor-project": { type: "string" }, requirement: { type: "string" } },
        1
    );
    if (values.requirement !== undefined)
    {
        // The verb that used to carry this moved: one verb per scope, so a
        // requirement can never be dropped when the caller meant the unit.
        throw new CliError("`work retire` retires the unit itself — to retire one requirement, use `self work drop <id> --requirement r1 --why w`");
    }
    const ctx = requireProject(process.cwd());
    const work = requireRetirable(ctx, positionals[0]);
    if (work.status === "retired")
    {
        // Idempotent by design: the state the caller asked for already holds,
        // so repeating the transition records nothing and refuses nothing.
        console.log(`${work.id} is already retired — ${work.retiredWhy}`);
        return;
    }
    const why = requireText(values.why, 'work retire <work-id> --why "<why the outcome was given up or moved>" [--successor <work-id>]');
    const payload = { work: work.id, why, ...successorRef(ctx, work.id, values.successor, values["successor-project"]) };
    recordEvent(ctx, makeEvent(ctx.project, "work.retired", payload, undefined, true), `${work.id} ${why}`);
}

// The unit a retirement speaks about: known, and not already closed as done.
// Already-retired is the caller's case to answer — a no-op, not a refusal.
function requireRetirable(ctx: ProjectContext, id: string | undefined): WorkState
{
    const wanted = requireText(id, "work retire <work-id> — run `self work` to list ids");
    const work = buildModel(ctx.storeDir, ctx.project, new Date()).works.find((item) => item.id === wanted);
    if (work === undefined)
    {
        throw new CliError(`unknown work id "${wanted}" — run \`self work\` to list ids`);
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
    // Identity, not spelling: the same id may exist in another project, so
    // self-succession is judged only after the reference has resolved.
    if (found.slug === ctx.project && found.work.id === source)
    {
        throw new CliError(`${source} cannot succeed itself — name the unit that carries the outcome now`);
    }
    if (found.work.status === "retired")
    {
        throw new CliError(`successor ${found.work.id} is itself retired — the outcome cannot move to a unit that gave it up`);
    }
    return { successor: found.work.id, successorProject: found.slug };
}

function transitionWork(type: string, args: string[]): void
{
    const { values, positionals } = parseCommand("work", args, { on: { type: "string" }, why: { type: "string" } }, 1);
    const ctx = requireProject(process.cwd());
    const work = requireOpenWork(ctx, positionals[0]);
    // Done is not a transition like the others: it is the claim that the
    // outcome was reached, and the completion check is what admits it.
    if (type === "work.done")
    {
        recordEvent(ctx, doneEvent(ctx, work, values.why), `${work.id} ${work.outcome}`);
        return;
    }
    const payload: Record<string, unknown> = { work: work.id };
    if (type === "work.blocked")
    {
        if (values.on !== "decision" && values.on !== "dependency" && values.on !== "external")
        {
            throw new CliError("work block requires --on decision|dependency|external");
        }
        payload.on = values.on;
        if (values.why !== undefined)
        {
            payload.why = values.why;
        }
    }
    recordEvent(ctx, makeEvent(ctx.project, type, payload), `${work.id} ${work.outcome}`);
}

function cmdReport(rest: string[]): void
{
    const { values, positionals } = parseCommand(
        "report",
        rest,
        {
            evidence: { type: "string", multiple: true },
            artifact: { type: "string", multiple: true },
            next: { type: "string" },
            file: { type: "string" }
        },
        2
    );
    const ctx = requireProject(process.cwd());
    const work = requireOpenWork(ctx, positionals[0]);
    const text = values.file === undefined
        ? requireText(positionals[1], 'report <work-id> "<summary>" — every report attaches to a work unit')
        : readReportFile(values.file);
    const { commits, notes } = classifyEvidence(ctx.projectDir, values.evidence ?? headEvidence(ctx));
    const refs: EventRefs = { work: work.id };
    const payload: Record<string, unknown> = { text };
    if (commits.length > 0)
    {
        refs.commits = commits;
        // Says the split already happened, against the repository that could
        // answer it. A reader of this event must take these as revisions
        // rather than guess at their shape a second time.
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
    const staged = stageArtifacts(ctx.storeDir, ctx.project, values.artifact);
    if (staged.artifacts.length > 0)
    {
        payload.artifacts = staged.artifacts;
        refs.artifacts = staged.artifacts.map((meta) => meta.id);
    }
    commitStaged(staged, (recorded) =>
        recordEvent(ctx, makeEvent(ctx.project, "report.added", payload, refs), `${work.id} ${text}`, recorded));
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
        throw new CliError(`unknown work id "${unknown}" — run \`self work\` to list ids`);
    }
    return [...new Set(ids)];
}

function requireOpenWork(ctx: ProjectContext, id: string | undefined): WorkState
{
    const wanted = requireText(id, "… <work-id> — run `self work` to list ids");
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = model.works.find((item) => item.id === wanted);
    if (work === undefined)
    {
        throw new CliError(`unknown work id "${wanted}" — run \`self work\` to list ids`);
    }
    if (work.status === "done")
    {
        throw new CliError(`${wanted} is already done`);
    }
    if (work.status === "retired")
    {
        throw new CliError(`${wanted} is retired — ${work.retiredWhy ?? "its outcome was given up"}; see \`self work show ${wanted}\``);
    }
    return work;
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

function cmdConvention(rest: string[]): void
{
    const sub = subcommand("convention", rest);
    const { values, positionals } = parseCommand("convention",
        rest, { supersedes: { type: "string", multiple: true }, why: { type: "string" } }, 2);
    const value = positionals[1];
    if (sub === "add")
    {
        const text = requireText(value, 'convention add "<text>" [--supersedes <event-id>]');
        if (values.why !== undefined)
        {
            throw new CliError("convention add takes no --why — the rule is its own statement; --why records why a rule was withdrawn");
        }
        const ctx = requireProject(process.cwd());
        // A correction is one event: the replacement carries the lineage, so
        // the rule it replaces never has to be dropped and re-added — which is
        // how two contradicting conventions used to end up both current.
        const refs = values.supersedes === undefined ? undefined
            : { supersedes: currentConventionIds(ctx, values.supersedes) };
        recordEvent(ctx, makeEvent(ctx.project, "convention.added", { text }, refs, true), text);
        return;
    }
    if (sub === "drop")
    {
        // Declared once for the whole verb, so the subcommand that does not
        // take it says so rather than dropping one convention and ignoring the
        // id the person expected it to replace.
        if (values.supersedes !== undefined)
        {
            throw new CliError('convention drop takes no --supersedes — to replace a rule, run `convention add "<text>" --supersedes <event-id>`');
        }
        const ctx = requireProject(process.cwd());
        const usage = 'convention drop <event-id> --why "<why the rule no longer holds>"';
        const target = findEventByPrefix(ctx.storeDir, ctx.project, requireText(value, usage));
        // Every withdrawal carries its reason. A rule that left the current set
        // with nothing recorded reads, a year later, exactly like one nobody
        // ever wrote down.
        const payload = { why: requireText(values.why, usage) };
        const refs = { supersedes: currentConventionIds(ctx, [target.id]) };
        recordEvent(ctx, makeEvent(ctx.project, "convention.dropped", payload, refs, true), String(target.payload.text));
        return;
    }
    throw new CliError('usage: self convention add "<text>" [--supersedes <event-id>] | drop <event-id> --why w');
}

// The ids of conventions that still hold. A withdrawn one is refused rather
// than named again: the first withdrawal is what happened, and a second event
// pointing at it would claim to change a record it cannot.
function currentConventionIds(ctx: ProjectContext, prefixes: string[]): string[]
{
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    return prefixes.map((prefix) =>
    {
        const target = findEventByPrefix(ctx.storeDir, ctx.project, prefix);
        if (target.type !== "convention.added")
        {
            throw new CliError(`${target.id} is not a convention`);
        }
        const state = model.conventions.find((convention) => convention.id === target.id);
        if (state !== undefined && state.status !== "current")
        {
            throw new CliError(`${target.id} was already ${state.status} — it is not a convention that still holds`);
        }
        return target.id;
    });
}

function cmdLog(rest: string[]): void
{
    const { values } = parseCommand("log", rest, { lines: { type: "string", short: "n" }, ...WORKSPACE_SCOPE_OPTIONS }, 0);
    const limit = values.lines === undefined ? 20 : Number.parseInt(values.lines, 10);
    if (Number.isNaN(limit) || limit <= 0)
    {
        throw new CliError("log -n expects a positive number");
    }
    const scopes = readScopes(process.cwd(), values);
    if (values.workspace === true)
    {
        printWorkspaceLog(scopes, limit);
        return;
    }
    printLog(scopes[0], limit);
}

function cmdSearch(rest: string[]): void
{
    const { values, positionals } = parseCommand(
        "search",
        rest,
        { type: { type: "string" }, project: { type: "string" } },
        1
    );
    // Context recovery pointers pull whole categories, so a filter alone is a
    // complete request: `--type` or `--project` may stand in for the query.
    const query = positionals[0] ?? (values.type === undefined && values.project === undefined
        ? requireText(undefined, "search <query>, search --type <type>, or search --project <slug>")
        : "");
    runSearch(requireWorkspace(process.cwd()), query, values.type, values.project);
}

function cmdConnect(rest: string[]): void
{
    const { values } = parseCommand("connect", rest, { global: { type: "boolean" } }, 0);
    if (values.global === true)
    {
        connectMachineAgents();
        return;
    }
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const files = connectProject(ctx.projectDir, model);
    console.log(`managed block rendered into ${files.join(", ")} — commit them so every agent tool loads it`);
}

function cmdFold(rest: string[]): void
{
    parseCommand("fold", rest, {}, 0);
    const ctx = requireProject(process.cwd());
    foldWorkspace(ctx.storeDir, ctx.project);
    commitAll(ctx.storeDir, `fold ${ctx.project}: manual refold`);
    console.log(`refolded ${ctx.project}`);
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
// directly — goals, integration, review, attempt — are answered the same way.
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

try
{
    await main(process.argv.slice(2));
}
catch (error)
{
    const message = userMessage(error, process.argv.slice(2));
    if (message === null)
    {
        throw error;
    }
    console.error(`${errRed("error:")} ${message}`);
    process.exitCode = 1;
}
