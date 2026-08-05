import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOPICS } from "./guide.js";
import { cliVersion } from "./help.js";
import { currentConventions, ProjectModel } from "./model.js";

// A block states which CLI rendered it. The version is what makes a stale
// block visible: the block is rewritten by whatever binary the machine has, so
// without a stamp an older CLI silently rewrites a newer block and two
// machines' commits disagree with nothing to point at (#221). Blocks are found
// by the prefix, so one written before the stamp existed is still recognised
// and replaced in place rather than appended beside.
const BEGIN = "<!-- superself:begin";
const END = "<!-- superself:end -->";
const MACHINE_BEGIN = "<!-- superself:machine:begin";
const MACHINE_END = "<!-- superself:machine:end -->";
const TARGETS = ["AGENTS.md", "CLAUDE.md"];

function marker(prefix: string): string
{
    return `${prefix} v${cliVersion()} -->`;
}

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
        marker(MACHINE_BEGIN),
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

// The managed block's fixed text. It is content, not logic: the reader of this
// file is an agent session, and the wording is reviewed as prose.
const BLOCK_BODY: readonly string[] = [
        "## Project state (superself)",
        "",
        "Project state — goals, decisions, work units, reports — is version-controlled",
        "by the `self` CLI, outside this repository. Skip this section if the `self`",
        "command is unavailable.",
        "",
        "- Session start: run `self context` and treat its output as current truth.",
        "- Write for the reader by default: answers to the person in their language,",
        "  records — events, decisions, reports, conventions — in English, so a record",
        "  stays readable to whoever opens it next. A project that wants it otherwise",
        "  records its own convention.",
        "- Substantive work attaches to a work unit: `self work add \"<required outcome>\"`,",
        "  then `self work start <id>` — which is how you read a unit's brief and report",
        "  history, and records that this session picked it up. If another session holds",
        "  it, you are told who and since when, and never refused; judge it and proceed.",
        "  Report progress with `self report <id> \"<summary>\"` after committing — HEAD is",
        "  attached as evidence automatically.",
        "- Done is a judgment, and the claim must carry evidence: `self work done <id>`",
        "  closes the unit only when a report carries a commit or an artifact, or the",
        "  done itself states one — `self work done <id> --report \"<what verifiably",
        "  happened>\"`. A bare claim is refused, and declared criteria gate it.",
        "- A record's text is immutable once confirmed, so a correction restates it:",
        "  `--supersedes <id>` on any add verb records the new wording and carries the",
        "  lineage. `retract` withdraws a record with nothing replacing it, and `retire`",
        "  is for an outcome given up or moved — neither is a wording fix.",
        "- Record decisions the user confirmed: `self decide \"<text>\" --why \"<reason>\"`.",
        "  Use `--proposed` when the user has not confirmed. One decision per event.",
        "- Blocked? `self work block <id> --on decision|dependency|external --why \"...\"`.",
        "  Superseded or moved? `self work retire <id> --why \"...\" [--successor <id>]` —",
        "  never mark it done and never leave it falsely blocked.",
        "- Found a gap between an objective and current state? Propose the work with",
        "  `self work propose` and its full brief; the user accepts or declines it.",
        "- Proposed next work, or suggested continuing in the next session, and the",
        "  user approved? Register it with `self work add` right then, with the",
        "  context behind the proposal — an approved plan that is never registered is lost.",
        "- Deferring work for later? Attach a scoping brief the moment you create it:",
        "  `self report <id> --file <path>` covering scope, design anchors, and known",
        "  pitfalls — a bare outcome line loses the context that created the work.",
        "- A branch reaches main through a GitHub pull request: PR review and CI own",
        "  merge control. superself owns context and the work graph, not the merge gate.",
        "- Never hand-edit generated state files or anything under `.superself/`.",
        "",
        "This block is the short form. The installed CLI carries the rest — what each",
        "concept is, when to reach for it, and the order the verbs go in:",
    ""
];

function renderBlock(model: ProjectModel): string
{
    const lines: string[] = [marker(BEGIN), ...BLOCK_BODY];
    for (const topic of TOPICS)
    {
        lines.push(`- \`self help ${topic.name}\` — ${topic.summary}`);
    }
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
