import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { currentConventions, ProjectModel } from "./model.js";

const BEGIN = "<!-- superself:begin -->";
const END = "<!-- superself:end -->";
const MACHINE_BEGIN = "<!-- superself:machine:begin -->";
const MACHINE_END = "<!-- superself:machine:end -->";
const TARGETS = ["AGENTS.md", "CLAUDE.md"];

// The instruction file each agent tool reads in every project on this machine.
const MACHINE_TARGETS = [
    [".claude", "CLAUDE.md"],
    [".codex", "AGENTS.md"],
    [".gemini", "GEMINI.md"]
];

export function connectProject(projectDir: string, model: ProjectModel): string[]
{
    const written: string[] = [];
    for (const name of TARGETS)
    {
        upsertBlock(join(projectDir, name), renderBlock(model), true, BEGIN, END);
        written.push(name);
    }
    return written;
}

export function connectMachine(): string[]
{
    const written: string[] = [];
    for (const [dir, name] of MACHINE_TARGETS)
    {
        if (!existsSync(join(homedir(), dir)))
        {
            continue;
        }
        const file = join(homedir(), dir, name);
        upsertBlock(file, renderMachineBlock(), true, MACHINE_BEGIN, MACHINE_END);
        written.push(file);
    }
    return written;
}

export function machineBlock(): string
{
    return renderMachineBlock();
}

export function refreshBlocks(projectDir: string, model: ProjectModel): void
{
    for (const name of TARGETS)
    {
        const file = join(projectDir, name);
        if (existsSync(file) && readFileSync(file, "utf8").includes(BEGIN))
        {
            upsertBlock(file, renderBlock(model), false, BEGIN, END);
        }
    }
}

function upsertBlock(file: string, block: string, create: boolean, begin: string, end: string): void
{
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current === null)
    {
        if (create)
        {
            writeFileSync(file, block + "\n");
        }
        return;
    }
    const from = current.indexOf(begin);
    const to = current.indexOf(end);
    const next = from !== -1 && to !== -1
        ? current.slice(0, from) + block + current.slice(to + end.length)
        : current.replace(/\n*$/, "\n\n") + block + "\n";
    if (next !== current)
    {
        writeFileSync(file, next);
    }
}

function renderMachineBlock(): string
{
    return [
        MACHINE_BEGIN,
        "## Project state (superself)",
        "",
        "The `self` CLI version-controls project state — goals, decisions, work",
        "units, reports — outside the code repository.",
        "",
        "- A registered project carries its own superself block in AGENTS.md or",
        "  CLAUDE.md: run `self context` at session start and follow that block.",
        "  `self setup` tells you which project, if any, a directory resolves to.",
        "- In an unregistered project, ask the user once whether to register it with",
        "  `self project add`. Never register a project on your own.",
        "- Every checkout of a registered git repository — worktrees included —",
        "  resolves on its own: work there as usual, and never run",
        "  `self project add` to attach one.",
        MACHINE_END
    ].join("\n");
}

function renderBlock(model: ProjectModel): string
{
    const lines: string[] = [
        BEGIN,
        "## Project state (superself)",
        "",
        "Project state — goals, decisions, work units, reports — is version-controlled",
        "by the `self` CLI, outside this repository. Skip this section if the `self`",
        "command is unavailable.",
        "",
        "- Session start: run `self context` and treat its output as current truth.",
        "- Substantive work attaches to a work unit: `self work add \"<required outcome>\"`,",
        "  then `self work start <id>`. Report progress with `self report <id> \"<summary>\"`",
        "  after committing — HEAD is attached as evidence automatically.",
        "- The long-term goal and time-boxed objectives are separate state: `self goal set`",
        "  keeps the goal, `self objective add \"<outcome>\" --target <date>`",
        "  adds an objective, and `self milestone add \"<outcome>\" --objective <id> --exit \"<criterion>\"`",
        "  adds a checkpoint under it. `self objective` lists both with the reason for each state.",
        "- Every asserted record — goal, decision, convention, objective, milestone, work —",
        "  folds into one entity with placement. `self state` lists them all,",
        "  `self state show <id>` prints one, and `self state add \"<text>\" --label <l>`",
        "  records a free-labeled one; `self alias add <verb>` makes a verb of a label.",
        "- Placement is scope × priority × exposure. `self state place <id> [--priority <n>]",
        "  [--exposure full|index|search] [--scope project|workspace]` moves what context",
        "  renders; a demotion records `--why`, and demoting out of full waits for the user:",
        "  pass `--proposed`, then the user runs `self state confirm <id>`.",
        "- Retention caps bound the rendered tiers. Past a cap, `state add` and `state place`",
        "  refuse until `--demote <id>` names what frees the room — pass `--proposed` so the",
        "  add and the demotion land as a pair waiting on the user.",
        "- A workspace-scoped record renders in every project's context: `--scope workspace`",
        "  on a state or alias verb, or `self convention add \"<text>\" --workspace`.",
        "- State what work contributes to: `self work link <id> --milestone <id>`. A milestone",
        "  is reached only when every exit criterion is covered — `self milestone met <id>",
        "  --criterion <c> --why \"<how the evidence covers it>\"`, then `self milestone reach <id>`.",
        "  Finishing work never reaches a milestone on its own, and progress is never a percentage.",
        "- Revising an objective or a milestone leaves what it already settled stale. Re-judge it",
        "  at the current revision with `self milestone recheck <id> --criterion <c> --why \"<what",
        "  you re-judged>\"` — a reach still needs every live criterion covered first.",
        "- Done is a judgment, and the claim must carry evidence: `self work done <id>` closes",
        "  the unit only when a report carries a commit or an artifact, or the done itself",
        "  states one — `self work done <id> --report \"<what verifiably happened>\"`.",
        "  A bare claim is refused, and declared criteria gate done until each is covered.",
        "- Found a gap between an objective and current state? Propose the work with",
        "  `self work propose` and its full brief; the user accepts or declines it.",
        "- Record decisions the user confirmed: `self decide \"<text>\" --why \"<reason>\"`.",
        "  Use `--proposed` when the user has not confirmed. One decision per event.",
        "- Blocked? `self work block <id> --on decision|dependency|external --why \"...\"`.",
        "- Superseded or moved to another unit or project? `self work retire <id> --why \"...\"",
        "  [--successor <work-id>]` — never mark it done and never leave it falsely blocked.",
        "- Picking up existing work? `self work show <id>` prints its full brief and",
        "  report history. Leave a brief for the next session with `self report <id> --file <path>`.",
        "- Proposed next work, or suggested continuing in the next session, and the",
        "  user approved? Register it with `self work add` right then, with the",
        "  context behind the proposal — an approved plan that is never registered is lost.",
        "- Deferring work for later? Attach a scoping brief the moment you create it:",
        "  `self report <id> --file <path>` covering scope, design anchors, and known",
        "  pitfalls — a bare outcome line loses the context that created the work.",
        "- A branch reaches main through a GitHub pull request: PR review and CI own",
        "  merge control. superself owns context and the work graph, not the merge gate.",
        "- Search past state with `self search <query>`; list work with `self work`.",
        "- Never hand-edit generated state files or anything under `.superself/`."
    ];
    const conventions = currentConventions(model.conventions);
    if (conventions.length > 0)
    {
        lines.push("", "### Conventions", "");
        for (const convention of conventions)
        {
            lines.push(`- ${convention.text}`);
        }
    }
    lines.push(END);
    return lines.join("\n");
}
