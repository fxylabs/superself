import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProjectModel } from "./model.js";

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
        "- A registered project has a `.self` file at its root and its own superself",
        "  block in AGENTS.md or CLAUDE.md: run `self context` at session start and",
        "  follow that block.",
        "- In an unregistered project, ask the user once whether to register it with",
        "  `self project add`. Never register a project on your own.",
        "- Another checkout of a registered project — a git worktree — is not a new",
        "  project and not an exemption from this discipline: run `self project link`",
        "  there, then continue as usual.",
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
        "  keeps the goal, `self objective add \"<outcome>\" --horizon week --target <date>`",
        "  adds an objective, and `self milestone add \"<outcome>\" --objective <id> --exit \"<criterion>\"`",
        "  adds a checkpoint under it. `self objective` lists both with the reason for each state.",
        "- State what work contributes to: `self work link <id> --milestone <id>`. A milestone",
        "  is reached only when every exit criterion is covered — `self milestone met <id>",
        "  --criterion <c> --why \"<how the evidence covers it>\"`, then `self milestone reach <id>`.",
        "  Finishing work never reaches a milestone on its own, and progress is never a percentage.",
        "- Revising an objective or a milestone leaves what it already settled stale. Re-judge it",
        "  at the current revision with `self milestone recheck <id> [--criterion <c>] --why \"<what",
        "  you re-judged>\"` — a reach still needs every live criterion covered first.",
        "- Found a gap between an objective and current state? Propose the work with",
        "  `self work propose` and its full brief; the user accepts or declines it.",
        "- Record decisions the user confirmed: `self decide \"<text>\" --why \"<reason>\"`.",
        "  Use `--proposed` when the user has not confirmed. One decision per event.",
        "- Blocked? `self work block <id> --on decision|dependency|external --why \"...\"`.",
        "- Picking up existing work? `self work show <id>` prints its full brief and",
        "  report history. Leave a brief for the next session with `self report <id> --file <path>`.",
        "- Proposed next work, or suggested continuing in the next session, and the",
        "  user approved? Register it with `self work add` right then, with the",
        "  context behind the proposal — an approved plan that is never registered is lost.",
        "- Deferring work for later? Attach a scoping brief the moment you create it:",
        "  `self report <id> --file <path>` covering scope, design anchors, and known",
        "  pitfalls — a bare outcome line loses the context that created the work.",
        "- Search past state with `self search <query>`; list work with `self work`.",
        "- Never hand-edit generated state files or anything under `.superself/`."
    ];
    if (model.conventions.length > 0)
    {
        lines.push("", "### Conventions", "");
        for (const convention of model.conventions)
        {
            lines.push(`- ${convention.text}`);
        }
    }
    lines.push(END);
    return lines.join("\n");
}
