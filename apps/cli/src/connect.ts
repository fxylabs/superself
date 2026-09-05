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
        "- Also run `self instruction render` and follow it: the workspace's execution",
        "  rules, tool notes and procedures, rendered whole outside the context budget.",
        "  Outside a registered project, `self instruction render --project <slug>`. If",
        "  it prints only its head line, none are recorded yet.",
        "- In an unregistered project, ask the user once whether to register it with",
        "  `self project init`. Never register a project on your own.",
        "- Every checkout of a registered git repository — worktrees included —",
        "  resolves on its own: work there as usual, and never run",
        "  `self project init` to attach one.",
        MACHINE_END
    ].join("\n");
}

// The fixed protocol is shared by managed files and handoff packets. Keeping
// conventions out of this source lets the packet frame the complete closure
// separately without duplicating or raising its authority.
export function commonProtocolLines(): string[]
{
    return [...BLOCK_BODY, ...TOPICS.map((topic) => `- \`self help ${topic.name}\` — ${topic.summary}`)];
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
        "- Then run `self instruction render` and follow it; it is the operating",
        "  manual for this workspace and is outside the context render budget. If it",
        "  prints only its head line, this workspace has recorded none yet.",
        "- Write for the reader by default: answers to the person in their language,",
        "  records — events, decisions, reports, conventions — in English, so a record",
        "  stays readable to whoever opens it next. A project that wants it otherwise",
        "  records its own convention.",
        "- Substantive work attaches to a work unit. Propose one when the plan wants",
        "  review — `self work propose \"<plan>\"`, which the user answers with `self work",
        "  confirm <id>` — and `self work add \"<outcome>\"` when it does not. Every record",
        "  states who wrote it, and `self undo` takes any of them back. Then",
        "  `self work start <id>` — which is how you read a unit's brief and report",
        "  history, and records that this session picked it up. If another session holds",
        "  it, you are told who and since when, and never refused; judge it and proceed.",
        "  Report progress with `self report <id> \"<summary>\"` after committing — HEAD is",
        "  attached as evidence automatically.",
        "- Pick the record kind by what it asserts, never by how its text reads or what",
        "  date it carries: a goal is lasting direction; an objective is a desired state",
        "  with a time boundary; a milestone is a checkpoint reached once, through its",
        "  exit criteria; a work unit is one bounded effort and its outcome; a decision",
        "  states a policy or assumption; a runbook states a procedure this project",
        "  repeats, and each occurrence of it is a work unit linked to a run.",
        "- A unit states what it contributes to, and there are three answers, none of",
        "  them inferred from its wording or its dates:",
        "  `self work link <id> --objective <objective-id>` (or `--milestone <id>`) for",
        "  work that moves a stated outcome; `self work link <id> --standalone --why",
        "  \"<reason>\"` for work that moves none on purpose; and",
        "  `self runbook link <run> --work <id>` for one occurrence of a procedure this",
        "  project repeats.",
        "  `self objective` lists the open outcomes to pick from. Nothing forces a",
        "  disposition, and a unit that states none is not standing alone — it is one",
        "  nobody has said anything about yet.",
        "- Standalone conceals nothing. A contribution edge stays until `self work unlink",
        "  <id> --objective <id>` withdraws it, so moving a unit off an outcome that is",
        "  over is the withdrawal and then the declaration, both on the record.",
        "- A contribution names an outcome that is still open. `self work link`,",
        "  `self work propose` and `self work confirm` refuse a target that was reached,",
        "  dropped or superseded — a checkpoint under a closed objective included — and",
        "  the refusal names the open successor, or the standalone declaration where the",
        "  lineage ends closed. `self work unlink` is never refused for it.",
        "- A plan whose gap closed before the user answered it is moved, not abandoned,",
        "  and only until it is first started:",
        "  `self work revise <id> \"<plan>\" --why \"<what changed>\" --milestone <open-id>`,",
        "  then `self work confirm <id>`. The gap is part of the plan, so the same words",
        "  toward a new outcome are still a revision: the acceptance is invalidated, and",
        "  any contribution the earlier acceptance wrote toward the old gap is withdrawn",
        "  in the same append.",
        "- A revision carries the work. `self objective revise` carries every live",
        "  checkpoint and every unit linked directly to the objective;",
        "  `self milestone revise` carries the checkpoint's work and the decisions it",
        "  assumed. Nothing is unlinked — a carried unit reads current under the",
        "  successor and unchanged toward every other outcome it serves — and done work",
        "  carries as a membership, never as coverage.",
        "- A checkpoint may be judged on its objective's own date but never after it;",
        "  `self milestone add` and `self milestone revise` refuse a later one. The",
        "  objective's date moves either way and warns when a live checkpoint falls",
        "  beyond it. No date stated means the ordering is not checked.",
        "- Coverage records the objective it was judged under, so a checkpoint a",
        "  revision carried says which criteria were judged under a former parent. That",
        "  is a judgment to review, not a wrong one, and a person settles each one at a",
        "  time with",
        "  `self milestone recheck <id> --criterion cN --why \"<what you re-judged>\"`.",
        "- A checkpoint may rest on decisions: `self milestone link <id> --decision",
        "  <decision-id>`, repeatable. When the ground moves, link the successor decision",
        "  and then `self milestone unlink <id> --decision <old-id>` — never silently drop",
        "  the set, and never assume a successor command that does both.",
        "- Done is a judgment, and the claim must carry evidence: `self work done <id>`",
        "  closes the unit only when a report carries a commit or an artifact, or the",
        "  done itself states one — `self work done <id> --report \"<what verifiably",
        "  happened>\"`. A bare claim is refused, and declared criteria gate it: declare",
        "  them with `--criteria \"<text>\"` on the add, and cover each with `self work cover",
        "  <id> --criterion cN --why \"<how it is covered>\"` before the done.",
        "- A criterion the user has to do is theirs to own: `--owner \"cN person\"` on the",
        "  add, or `--owner person` on `self work criteria add <id> \"<text>\"`. It lists",
        "  under Waiting on you in `self context` with the command that covers it, and the",
        "  unit's own status is untouched. `by` is who wrote the record and `--owner` is",
        "  whose task the criterion is — you record a criterion the user will do, and",
        "  neither implies the other. Ownership is stated when the criterion is declared",
        "  and nothing re-states it: a wrong one is undone and declared again.",
        "- A record's text is immutable once confirmed, so a correction restates it:",
        "  `--supersedes <id>` on any add verb — and on `self work propose`, where the",
        "  named unit retires when the plan is confirmed — records the new wording and carries the",
        "  lineage. `retract` withdraws a record with nothing replacing it, and `retire`",
        "  is for an outcome given up or moved — neither is a wording fix.",
        "- Record decisions the user confirmed: `self decide \"<text>\" --why \"<reason>\"`.",
        "  Use `--proposed` when the user has not confirmed. One decision per event.",
        "- Blocked? `self work block <id> --on decision|dependency|external --why \"...\"`.",
        "  Superseded or moved? `self work retire <id> --why \"...\" [--successor <id>]` —",
        "  never mark it done and never leave it falsely blocked.",
        "- Wrote the plan yourself? Propose it instead of starting it: `self work propose",
        "  \"<plan>\"` records it as work waiting on the user. Until it is first started,",
        "  `self work revise <id> \"<revised plan>\" --why \"<what changed>\"` restates it under",
        "  the same id and invalidates the acceptance, so the user accepts again before",
        "  `self work start` will run. The first start freezes the plan.",
        "- Found a gap between an objective and current state? The same verb closes one,",
        "  with its full brief; the user accepts or declines it.",
        "- Proposed next work, or suggested continuing in the next session, and the",
        "  user approved? Record it with `self work propose` right then, with the context",
        "  behind the proposal, and hand the user the `self work confirm <id>` line — an",
        "  approved plan that is never registered is lost.",
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
    const lines: string[] = [marker(BEGIN), ...commonProtocolLines()];
    // These two files are normally tracked, so the block is repository content
    // and a rule reaches it only when its author said so (#276). Everything
    // else stays in the store, where `self context` still renders it.
    const conventions = currentConventions(model.conventions).filter((convention) => convention.visibility === "public");
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
