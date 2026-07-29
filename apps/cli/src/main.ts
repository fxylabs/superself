import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { helpHint, parseCommand, subcommand, unknownOption } from "./args.js";
import { commitStaged, runArtifact, stageArtifacts } from "./artifact.js";
import { runAttemptCommand } from "./attempt/commands.js";
import { connectMachine, connectProject, machineBlock } from "./connect.js";
import { runDaemonCommand } from "./daemon/commands.js";
import { DEFAULT_ZONE, validZone } from "./dates.js";
import { foldProject, renderWorkBody } from "./fold.js";
import { cmdMilestone, cmdObjective, cmdProposalDecision, cmdPropose, cmdWorkLink, rejectManualProgress } from "./goals.js";
import { commitAll, ensureWorkspaceRepo, excludeLocally, headCommit } from "./gitutil.js";
import { commandUsage, findCommand, rootUsage } from "./help.js";
import { workId } from "./ids.js";
import { findEventByPrefix } from "./logfile.js";
import { machineWorkspace, setMachineWorkspace } from "./machine.js";
import { buildModel, ProjectModel, WorkState } from "./model.js";
import {
    CliContext,
    ensureDir,
    isStore,
    LINKS_FILE,
    MARKER_FILE,
    ProjectContext,
    projectStateDir,
    readLinks,
    readRegistry,
    readStoreConfig,
    requireProject,
    requireWorkspace,
    siblingSlug,
    STORE_DIR,
    StoreConfig
} from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { loadVerdicts } from "./reachability.js";
import { cmdReview } from "./reviews.js";
import { cmdIntegration } from "./train.js";
import { runSearch } from "./search.js";
import { runSpecCommand } from "./spec/commands.js";
import { printSetup } from "./setup.js";
import { cloneStore, ensureSyncConfig, remoteAdd, syncStore } from "./sync.js";
import { dim, errRed, markdownHeadings, styled } from "./style.js";
import { openFile, validTheme, viewFile } from "./view.js";
import { printContext, printLog, printStatus, printWorkList } from "./views.js";
import { CliError, EventRefs } from "./types.js";

async function main(argv: string[]): Promise<void>
{
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
        case "objective": cmdObjective(requireProject(process.cwd()), guarded(rest)); break;
        case "milestone": cmdMilestone(requireProject(process.cwd()), guarded(rest)); break;
        case "decide": cmdDecide(rest); break;
        case "work": cmdWork(rest); break;
        case "report": cmdReport(rest); break;
        case "integration": cmdIntegration(requireProject(process.cwd()), rest); break;
        case "review": cmdReview(requireProject(process.cwd()), rest); break;
        case "artifact": cmdArtifact(rest); break;
        case "spec": await runSpecCommand(rest); break;
        case "attempt": await runAttemptCommand(rest); break;
        case "daemon": await runDaemonCommand(rest); break;
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
    for (const entry of readRegistry(ctx.storeDir))
    {
        foldProject(ctx.storeDir, entry.slug);
    }
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
    // Omitting the slug is the worktree case: the repository already answers
    // which project this checkout belongs to.
    const slug = wanted ?? requireText(siblingSlug(ctx.storeDir, projectDir) ?? undefined, "project link <slug> [path]");
    if (!readRegistry(ctx.storeDir).some((entry) => entry.slug === slug))
    {
        throw new CliError(`project "${slug}" is not registered — run \`self project add\` instead`);
    }
    linkProject(ctx, slug, projectDir);
    foldProject(ctx.storeDir, slug);
    console.log(`project "${slug}" linked to ${projectDir}`);
}

function cmdView(rest: string[]): void
{
    const [slug] = parseCommand("view", rest, {}, 1).positionals;
    const ctx = requireWorkspace(process.cwd());
    if (slug !== undefined && !readRegistry(ctx.storeDir).some((entry) => entry.slug === slug))
    {
        throw new CliError(`unknown project "${slug}" — registered: ${readRegistry(ctx.storeDir).map((e) => e.slug).join(", ")}`);
    }
    openFile(ctx, viewFile(ctx.storeDir, slug));
}

function linkProject(ctx: CliContext, slug: string, projectDir: string): void
{
    excludeLocally(ctx.storeDir, LINKS_FILE);
    if (!(readLinks(ctx.storeDir)[slug] ?? []).includes(projectDir))
    {
        appendFileSync(join(ctx.storeDir, LINKS_FILE), JSON.stringify({ slug, path: projectDir }) + "\n");
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

function cmdContext(rest: string[]): void
{
    parseCommand("context", rest, {}, 0);
    printContext(requireWorkspace(process.cwd()));
}

function cmdStatus(rest: string[]): void
{
    parseCommand("status", rest, {}, 0);
    printStatus(requireWorkspace(process.cwd()));
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
    // `confirm` is the only subcommand: every other first argument is the
    // decision text, which may itself start with a dash after `--`.
    if (rest[0] === "confirm")
    {
        const [, prefix] = parseCommand("decide", rest, {}, 2).positionals;
        confirmDecision(requireProject(process.cwd()), prefix);
        return;
    }
    const { values, positionals } = parseCommand(
        "decide",
        rest,
        {
            proposed: { type: "boolean" },
            why: { type: "string" },
            supersedes: { type: "string", multiple: true },
            work: { type: "string" }
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
    const refs = decisionRefs(ctx, values.supersedes, values.work);
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

function decisionRefs(ctx: ProjectContext, prefixes: string[] | undefined, work: string | undefined): EventRefs | undefined
{
    const refs: EventRefs = {};
    if (prefixes !== undefined && prefixes.length > 0)
    {
        refs.supersedes = prefixes.map((prefix) => findEventByPrefix(ctx.storeDir, ctx.project, prefix).id);
    }
    if (work !== undefined)
    {
        refs.work = requireKnownWork(ctx, work);
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
    const type = TRANSITIONS[sub as string];
    if (type === undefined)
    {
        throw new CliError(`unknown work subcommand "${sub}" — use add|show|start|block|unblock|done|link|unlink|propose|accept|decline`);
    }
    transitionWork(type, rest.slice(1));
}

function cmdWorkList(rest: string[]): void
{
    const { values } = parseCommand("work", rest, { project: { type: "string" } }, 0);
    if (values.project === undefined)
    {
        printWorkList(requireProject(process.cwd()));
        return;
    }
    const ctx = requireWorkspace(process.cwd());
    printWorkList({ ...ctx, project: requireRegistered(ctx.storeDir, values.project) });
}

function cmdWorkShow(args: string[]): void
{
    const { values, positionals } = parseCommand("work", args, { project: { type: "string" } }, 1);
    const wanted = requireText(positionals[0], "work show <work-id> [--project <slug>]");
    const ctx = requireWorkspace(process.cwd());
    const found = findWorkAcross(ctx, wanted, values.project);
    if (found === null)
    {
        throw new CliError(`unknown work id "${wanted}" — run \`self work\` to list ids`);
    }
    console.log(markdownHeadings(renderWorkBody(found.work, found.model, loadVerdicts(ctx.storeDir, found.slug)).trimEnd()));
}

interface FoundWork
{
    slug: string;
    model: ProjectModel;
    work: WorkState;
}

// A bare id resolves across the whole workspace: the linked checkout's own
// project wins outright, and a cross-project id collision demands --project.
function findWorkAcross(ctx: CliContext, wanted: string, project: string | undefined): FoundWork | null
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
        throw new CliError(`work id "${wanted}" exists in more than one project (${matches.map((m) => m.slug).join(", ")}) — pass --project <slug>`);
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

function requireRegistered(storeDir: string, slug: string): string
{
    if (!readRegistry(storeDir).some((entry) => entry.slug === slug))
    {
        throw new CliError(`unknown project "${slug}" — registered: ${readRegistry(storeDir).map((e) => e.slug).join(", ")}`);
    }
    return slug;
}

function transitionWork(type: string, args: string[]): void
{
    const { values, positionals } = parseCommand("work", args, { on: { type: "string" }, why: { type: "string" } }, 1);
    const ctx = requireProject(process.cwd());
    const work = requireOpenWork(ctx, positionals[0]);
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
    const commits = values.evidence ?? headEvidence(ctx);
    const refs: EventRefs = { work: work.id };
    if (commits.length > 0)
    {
        refs.commits = commits;
    }
    const payload: Record<string, unknown> = { text };
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
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    if (!model.works.some((item) => item.id === id))
    {
        throw new CliError(`unknown work id "${id}" — run \`self work\` to list ids`);
    }
    return id;
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
    const [, value] = parseCommand("convention", rest, {}, 2).positionals;
    if (sub === "add")
    {
        const text = requireText(value, 'convention add "<text>"');
        const ctx = requireProject(process.cwd());
        recordEvent(ctx, makeEvent(ctx.project, "convention.added", { text }, undefined, true), text);
        return;
    }
    if (sub === "drop")
    {
        const ctx = requireProject(process.cwd());
        const target = findEventByPrefix(ctx.storeDir, ctx.project, requireText(value, "convention drop <event-id>"));
        if (target.type !== "convention.added")
        {
            throw new CliError(`${target.id} is not a convention`);
        }
        recordEvent(ctx, makeEvent(ctx.project, "convention.dropped", {}, { supersedes: [target.id] }, true), String(target.payload.text));
        return;
    }
    throw new CliError('usage: self convention add "<text>" | drop <event-id>');
}

function cmdLog(rest: string[]): void
{
    const { values } = parseCommand("log", rest, { lines: { type: "string", short: "n" } }, 0);
    const limit = values.lines === undefined ? 20 : Number.parseInt(values.lines, 10);
    if (Number.isNaN(limit) || limit <= 0)
    {
        throw new CliError("log -n expects a positive number");
    }
    printLog(requireProject(process.cwd()), limit);
}

function cmdSearch(rest: string[]): void
{
    const { values, positionals } = parseCommand(
        "search",
        rest,
        { type: { type: "string" }, project: { type: "string" } },
        1
    );
    const query = requireText(positionals[0], "search <query>");
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
    foldProject(ctx.storeDir, ctx.project);
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
