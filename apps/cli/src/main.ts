import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { commitStaged, runArtifact, stageArtifacts } from "./artifact.js";
import { connectMachine, connectProject, machineBlock } from "./connect.js";
import { DEFAULT_ZONE, validZone } from "./dates.js";
import { foldProject, renderWorkBody } from "./fold.js";
import { cmdMilestone, cmdObjective, cmdProposalDecision, cmdPropose, cmdWorkLink, rejectManualProgress } from "./goals.js";
import { commitAll, ensureWorkspaceRepo, excludeLocally, headCommit } from "./gitutil.js";
import { requirementId, workId } from "./ids.js";
import { findEventByPrefix } from "./logfile.js";
import { machineWorkspace, setMachineWorkspace } from "./machine.js";
import { buildModel, WorkState } from "./model.js";
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
import { runAttempt, runDaemon, runDigest, runOvernight } from "./supervise/commands.js";
import { runSearch } from "./search.js";
import { printSetup } from "./setup.js";
import { cloneStore, ensureSyncConfig, remoteAdd, syncStore } from "./sync.js";
import { dim, errRed, markdownHeadings, styled } from "./style.js";
import { openFile, validTheme, viewFile } from "./view.js";
import { printContext, printLog, printStatus, printWorkList } from "./views.js";
import { CliError, EventRefs } from "./types.js";

const USAGE = `usage: self <command>

  init [--lang <code>] [--agents]             initialize the current directory as a workspace
  workspace [<path>]                         show or set the workspace this machine uses
  lang [<code>]                              show or set the language of the HTML views
  theme [<name>]                             show or set the viewer accent theme (violet, cyan, orange, mono)
  timezone [<zone>]                          show or set the zone every target date is judged in
  project add [path] [--name s] [--desc d] [--no-connect]
                                             register a project and render its agent block
  project link [slug] [path]                 link this checkout of a registered project on this machine
  remote add <url>                           connect the workspace store to a git remote
  sync                                       pull, refold, and push the workspace store
  clone <url> [dir]                          clone a workspace store onto a new machine
  goal set "<text>"                          set the long-term project goal
  objective                                  list objectives and their milestones
  objective add "<outcome>" [--horizon week|month|quarter|year] [--target d]
              [--success s] [--stop s] [--priority n] [--proposed] [--supersedes id]
  objective show|confirm <id>                print an objective, or confirm a proposed one
  objective revise <id> --why w [--outcome t] [--target d] [--success s] [--stop s]
                                             an empty --target/--horizon/--priority withdraws that field
  objective close <id> --as reached|dropped [--why w]
  milestone                                  list milestones with state, reason, and linked work
  milestone add "<outcome>" --objective <id> --exit "<criterion>" [--target d] [--after m] [--supersedes m]
  milestone show <id>                        print a milestone, its exit criteria, and its coverage
  milestone revise <id> --why w [--outcome t] [--target d] [--exit e] [--drop-exit c1]
  milestone met <id> --criterion c1 --why w [--work id] [--evidence c]
  milestone reach <id>                       record a milestone as reached once every criterion is covered
  milestone recheck <id> [--criterion c1] --why w
                                             re-judge coverage, or a reach, a revision left stale
  decide "<text>" [--why w] [--proposed] [--supersedes id] [--work id]
  decide confirm <event-id>                  confirm a proposed decision
  work                                       list open work
  work add "<required outcome>"              create a work unit
  work show <id>                             print full work detail: brief, reports, evidence
  work start|block|unblock|done <id>         move a work unit (block: --on decision|dependency|external [--why w])
  work link|unlink <id> --objective o | --milestone m
                                             state, or withdraw, what a work unit contributes to
  work propose "<outcome>" --milestone m --value v --success s --stop s --risk r
              --capacity c --evidence-plan e --confidence low|medium|high --expires d
  work accept|decline <proposal-id>          act on a goal-gap proposal
  work require <id> "<criterion>" [--drop r]  add or retire an acceptance criterion (bumps the revision)
  work design <id>                           approve the current design revision of a work unit
  report <work-id> "<summary>" [--file path] [--evidence c] [--artifact path] [--next n]
  attempt register --work <id> [--command c] [--output p] [--completes] …
                                             register a run before the process exists
  attempt list | show <id> | run <id>        inspect or dispatch a registered attempt
  attempt started <id> --pid n | heartbeat <id> | exited <id> [--code n]
                                             report what an externally launched run is doing
  attempt complete [--resolved-model m] …    write the completion envelope from inside a supervised run
  attempt approve|cancel <id>                approve an attempt or take one back
  attempt propose <id> --action <kind>       ask mid-run for an action the launch did not declare
  daemon start [--interval s] | stop | status | tick | circuits
                                             supervise attempts with no chat turn open
  overnight set [--from 22:00] [--to 07:00] [--auto-dispatch] … | show | off
                                             set, read, or revoke the unattended-run policy
  digest [--hours n] [--since ts]            group what ran, failed, retried, and waits
  artifact list [--work id] [--project slug]  list artifacts from the derived registry
  artifact search <query> | open <id> [--project slug]
                                             find an artifact or open it with the OS default app
  convention add "<text>" | drop <event-id>  record or retire a convention
  connect [--global]                         render the agent-onboarding block into AGENTS.md and CLAUDE.md
                                             (--global: into this machine's agent instruction files)
  view [slug]                                open the live workspace or project view in the browser
  context                                    print derived context for agents
  status                                     print a short state summary
  setup                                      print the workspace, project, and store this directory resolves to
  log [-n N]                                 print recent events
  search <query> [--type t] [--project p]    grep state across the workspace
  fold                                       re-derive canonical files from the log`;

async function main(argv: string[]): Promise<void>
{
    const cmd = argv[0];
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
        case "sync": syncStore(requireWorkspace(process.cwd())); break;
        case "clone": cloneStore(requireText(rest[0], "clone <url> [dir]"), rest[1]); break;
        case "goal": cmdGoal(rest); break;
        case "objective": cmdObjective(requireProject(process.cwd()), guarded(rest)); break;
        case "milestone": cmdMilestone(requireProject(process.cwd()), guarded(rest)); break;
        case "decide": cmdDecide(rest); break;
        case "work": cmdWork(rest); break;
        case "report": cmdReport(rest); break;
        case "attempt": runAttempt(rest); break;
        case "daemon": await runDaemon(rest); break;
        case "overnight": runOvernight(rest); break;
        case "digest": runDigest(rest); break;
        case "artifact": runArtifact(requireWorkspace(process.cwd()), rest); break;
        case "convention": cmdConvention(rest); break;
        case "connect": cmdConnect(rest); break;
        case "view": cmdView(rest); break;
        case "context": printContext(requireWorkspace(process.cwd())); break;
        case "status": printStatus(requireWorkspace(process.cwd())); break;
        case "setup": printSetup(process.cwd()); break;
        case "log": cmdLog(rest); break;
        case "search": cmdSearch(rest); break;
        case "fold": cmdFold(); break;
        default: printUsage(); break;
    }
}

// Dim the description column so the command column stands out; piped output is untouched.
function printUsage(): void
{
    if (!styled)
    {
        console.log(USAGE);
        return;
    }
    console.log(USAGE.split("\n").map((line) =>
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
    const { values } = parseArgs({ args: rest, options: { lang: { type: "string" }, agents: { type: "boolean" } } });
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
    if (rest[0] === undefined)
    {
        console.log(machineWorkspace() ?? "no workspace set — run `self init` in the directory that should hold it");
        return;
    }
    const dir = resolve(rest[0]);
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
    const ctx = requireWorkspace(process.cwd());
    if (rest[0] === undefined)
    {
        console.log(readStoreConfig(ctx.storeDir).lang ?? "en");
        return;
    }
    const lang = validLang(rest[0]);
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
    const ctx = requireWorkspace(process.cwd());
    if (rest[0] === undefined)
    {
        console.log(readStoreConfig(ctx.storeDir).timezone ?? DEFAULT_ZONE);
        return;
    }
    const timezone = validZone(rest[0]);
    writeConfig(ctx, { timezone }, `timezone set ${timezone}`);
    console.log(`target dates are now judged in "${timezone}"`);
}

function cmdTheme(rest: string[]): void
{
    const ctx = requireWorkspace(process.cwd());
    if (rest[0] === undefined)
    {
        console.log(readStoreConfig(ctx.storeDir).theme ?? "violet");
        return;
    }
    const theme = validTheme(rest[0]);
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
    if (rest[0] === "add")
    {
        projectAdd(rest.slice(1));
        return;
    }
    if (rest[0] === "link")
    {
        projectLink(rest.slice(1));
        return;
    }
    throw new CliError('usage: self project add [path] [--name <slug>] [--desc "<description>"] | link [slug] [path]');
}

function projectAdd(args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { name: { type: "string" }, desc: { type: "string" }, "no-connect": { type: "boolean" } },
        allowPositionals: true
    });
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
    const ctx = requireWorkspace(process.cwd());
    const projectDir = resolve(args[1] ?? process.cwd());
    if (!existsSync(projectDir))
    {
        throw new CliError(`"${projectDir}" does not exist`);
    }
    // Omitting the slug is the worktree case: the repository already answers
    // which project this checkout belongs to.
    const slug = args[0] ?? requireText(siblingSlug(ctx.storeDir, projectDir) ?? undefined, "project link <slug> [path]");
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
    const ctx = requireWorkspace(process.cwd());
    if (rest[0] !== undefined && !readRegistry(ctx.storeDir).some((entry) => entry.slug === rest[0]))
    {
        throw new CliError(`unknown project "${rest[0]}" — registered: ${readRegistry(ctx.storeDir).map((e) => e.slug).join(", ")}`);
    }
    openFile(ctx, viewFile(ctx.storeDir, rest[0]));
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

function cmdRemote(rest: string[]): void
{
    if (rest[0] !== "add")
    {
        throw new CliError("usage: self remote add <url>");
    }
    remoteAdd(requireWorkspace(process.cwd()), requireText(rest[1], "remote add <url>"));
}

function cmdGoal(rest: string[]): void
{
    if (rest[0] !== "set")
    {
        throw new CliError('usage: self goal set "<text>"');
    }
    const ctx = requireProject(process.cwd());
    const text = requireText(rest[1], 'goal set "<text>"');
    recordEvent(ctx, makeEvent(ctx.project, "goal.set", { text }, undefined, true), text);
}

function cmdDecide(rest: string[]): void
{
    const ctx = requireProject(process.cwd());
    if (rest[0] === "confirm")
    {
        confirmDecision(ctx, rest[1]);
        return;
    }
    const { values, positionals } = parseArgs({
        args: rest,
        options: {
            proposed: { type: "boolean" },
            why: { type: "string" },
            supersedes: { type: "string", multiple: true },
            work: { type: "string" }
        },
        allowPositionals: true
    });
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
    const ctx = requireProject(process.cwd());
    if (rest.length === 0)
    {
        printWorkList(ctx);
        return;
    }
    if (rest[0] === "add")
    {
        const outcome = requireText(rest[1], 'work add "<required outcome>"');
        const id = workId();
        recordEvent(ctx, makeEvent(ctx.project, "work.created", { work: id, outcome }), `${id} ${outcome}`);
        console.log(id);
        return;
    }
    if (rest[0] === "show")
    {
        const wanted = requireText(rest[1], "work show <work-id>");
        const model = buildModel(ctx.storeDir, ctx.project, new Date());
        const work = model.works.find((item) => item.id === wanted);
        if (work === undefined)
        {
            throw new CliError(`unknown work id "${wanted}" — run \`self work\` to list ids`);
        }
        console.log(markdownHeadings(renderWorkBody(work, model, loadVerdicts(ctx.storeDir, ctx.project)).trimEnd()));
        return;
    }
    if (rest[0] === "link" || rest[0] === "unlink")
    {
        cmdWorkLink(ctx, rest.slice(1), rest[0] === "link");
        return;
    }
    if (rest[0] === "propose")
    {
        cmdPropose(ctx, rest.slice(1));
        return;
    }
    if (rest[0] === "accept" || rest[0] === "decline")
    {
        cmdProposalDecision(ctx, rest.slice(1), rest[0] === "accept");
        return;
    }
    if (rest[0] === "require")
    {
        cmdRequire(ctx, rest.slice(1));
        return;
    }
    if (rest[0] === "design")
    {
        cmdDesign(ctx, rest.slice(1));
        return;
    }
    const type = TRANSITIONS[rest[0]];
    if (type === undefined)
    {
        throw new CliError(`unknown work subcommand "${rest[0]}" — use add|show|require|design|start|block|unblock|done|link|unlink|propose|accept|decline`);
    }
    transitionWork(ctx, type, rest.slice(1));
}

// Acceptance criteria are what a passing attempt is measured against, so they
// are recorded as their own events: adding one is a revision of the unit, and
// an attempt registered before it cannot silently claim to have covered it.
function cmdRequire(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { drop: { type: "string" } },
        allowPositionals: true
    });
    const work = requireOpenWork(ctx, positionals[0]);
    if (values.drop !== undefined)
    {
        const model = buildModel(ctx.storeDir, ctx.project, new Date()).works.find((item) => item.id === work.id);
        if (!(model?.requirements ?? []).some((item) => item.id === values.drop))
        {
            throw new CliError(`${work.id} has no requirement "${values.drop}" — run \`self work show ${work.id}\` to list them`);
        }
        recordEvent(ctx, makeEvent(ctx.project, "work.requirement.dropped", { work: work.id, requirement: values.drop }),
            `${work.id} dropped ${values.drop}`);
        return;
    }
    const text = requireText(positionals[1], 'work require <work-id> "<acceptance criterion>" [--drop <requirement-id>]');
    const id = requirementId();
    recordEvent(ctx, makeEvent(ctx.project, "work.requirement.added", { work: work.id, requirement: id, text }),
        `${work.id} requires ${text}`);
    console.log(id);
}

function cmdDesign(ctx: ProjectContext, args: string[]): void
{
    const work = requireOpenWork(ctx, args[0]);
    const model = buildModel(ctx.storeDir, ctx.project, new Date()).works.find((item) => item.id === work.id);
    const next = (model?.designRevision ?? 0) + 1;
    recordEvent(ctx, makeEvent(ctx.project, "work.design.approved", { work: work.id, designRevision: next }, undefined, true),
        `${work.id} design revision ${next} approved`);
    console.log(String(next));
}

function transitionWork(ctx: ProjectContext, type: string, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { on: { type: "string" }, why: { type: "string" } },
        allowPositionals: true
    });
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
    const ctx = requireProject(process.cwd());
    const { values, positionals } = parseArgs({
        args: rest,
        options: {
            evidence: { type: "string", multiple: true },
            artifact: { type: "string", multiple: true },
            next: { type: "string" },
            file: { type: "string" }
        },
        allowPositionals: true
    });
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
    const ctx = requireProject(process.cwd());
    if (rest[0] === "add")
    {
        const text = requireText(rest[1], 'convention add "<text>"');
        recordEvent(ctx, makeEvent(ctx.project, "convention.added", { text }, undefined, true), text);
        return;
    }
    if (rest[0] === "drop")
    {
        const target = findEventByPrefix(ctx.storeDir, ctx.project, requireText(rest[1], "convention drop <event-id>"));
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
    const ctx = requireProject(process.cwd());
    const { values } = parseArgs({ args: rest, options: { lines: { type: "string", short: "n" } } });
    const limit = values.lines === undefined ? 20 : Number.parseInt(values.lines, 10);
    if (Number.isNaN(limit) || limit <= 0)
    {
        throw new CliError("log -n expects a positive number");
    }
    printLog(ctx, limit);
}

function cmdSearch(rest: string[]): void
{
    const { values, positionals } = parseArgs({
        args: rest,
        options: { type: { type: "string" }, project: { type: "string" } },
        allowPositionals: true
    });
    const query = requireText(positionals[0], "search <query>");
    runSearch(requireWorkspace(process.cwd()), query, values.type, values.project);
}

function cmdConnect(rest: string[]): void
{
    if (rest[0] === "--global")
    {
        connectMachineAgents();
        return;
    }
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const files = connectProject(ctx.projectDir, model);
    console.log(`managed block rendered into ${files.join(", ")} — commit them so every agent tool loads it`);
}

function cmdFold(): void
{
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

try
{
    await main(process.argv.slice(2));
}
catch (error)
{
    if (error instanceof CliError)
    {
        console.error(`${errRed("error:")} ${error.message}`);
        process.exitCode = 1;
    }
    else
    {
        throw error;
    }
}
