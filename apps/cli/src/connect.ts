import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectModel } from "./model.js";

const BEGIN = "<!-- superself:begin -->";
const END = "<!-- superself:end -->";
const TARGETS = ["AGENTS.md", "CLAUDE.md"];

export function connectProject(projectDir: string, model: ProjectModel): string[]
{
    const written: string[] = [];
    for (const name of TARGETS)
    {
        upsertBlock(join(projectDir, name), renderBlock(model), true);
        written.push(name);
    }
    return written;
}

export function refreshBlocks(projectDir: string, model: ProjectModel): void
{
    for (const name of TARGETS)
    {
        const file = join(projectDir, name);
        if (existsSync(file) && readFileSync(file, "utf8").includes(BEGIN))
        {
            upsertBlock(file, renderBlock(model), false);
        }
    }
}

function upsertBlock(file: string, block: string, create: boolean): void
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
    const begin = current.indexOf(BEGIN);
    const end = current.indexOf(END);
    const next = begin !== -1 && end !== -1
        ? current.slice(0, begin) + block + current.slice(end + END.length)
        : current.replace(/\n*$/, "\n\n") + block + "\n";
    if (next !== current)
    {
        writeFileSync(file, next);
    }
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
        "- Record decisions the user confirmed: `self decide \"<text>\" --why \"<reason>\"`.",
        "  Use `--proposed` when the user has not confirmed. One decision per event.",
        "- Blocked? `self work block <id> --on decision|dependency|external --why \"...\"`.",
        "- Picking up existing work? `self work show <id>` prints its full brief and",
        "  report history. Leave a brief for the next session with `self report <id> --file <path>`.",
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
