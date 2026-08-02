// The human-legible terminal render of the list surfaces — `self context`,
// `self work`, `self status`. It stands beside the plain render rather than in
// place of it: piped output is a machine contract that agents and the proof
// suite read byte for byte, so nothing in this file is reachable unless stdout
// is a terminal or `--pretty` says so.
//
// Three colours and no more: green for what is moving, yellow for what waits,
// red for what failed, with ids dimmed. A fourth colour would have to carry a
// fourth meaning, and none of these surfaces has one.

import { openChangeSets } from "./integration.js";
import {
    AttentionGroup,
    ATTENTION_ORDER,
    AttentionRow,
    branchLabel,
    BranchUnshipped,
    branchTotals,
    ProjectModel,
    WorkState
} from "./model.js";
import { contributionsOf, openObjectives } from "./objectives.js";
import { bold, dim, displayWidth, dumbTerminal, fitDisplay, green, oneLine, padDisplay, plural, red, termColumns, yellow } from "./style.js";
import { CliError } from "./types.js";

// A terminal narrower than this cannot hold four ruled columns and still show
// an outcome, so it is answered with the plain render instead of a table whose
// every row is an ellipsis.
const MIN_COLUMNS = 60;
const DEFAULT_COLUMNS = 80;
// A very wide terminal is not a reason to stretch an outcome across a metre of
// screen; past this the tables stop growing and the right edge stays where the
// eye can find it.
const MAX_TABLE_COLUMNS = 120;

// How many rows a context section spends before it names the command that
// prints the rest. `self context` on a terminal is a glance, not the archive.
const CONTEXT_ROWS = 8;

export type RenderMode = "pretty" | "plain";

export interface RenderChoice
{
    pretty?: boolean;
    plain?: boolean;
}

// Declared once so every surface that offers the choice offers exactly it.
export const RENDER_OPTIONS = {
    pretty: { type: "boolean" },
    plain: { type: "boolean" }
} as const;

// The single answer to "which render does this run get". Detection is the
// default and the flags only override it, so an agent that pipes `self context`
// keeps today's bytes whether or not it knows these flags exist.
export function resolveRender(choice: RenderChoice): RenderMode
{
    if (choice.pretty === true && choice.plain === true)
    {
        throw new CliError("--pretty and --plain ask for different renders — pass one of them, or neither");
    }
    if (choice.plain === true)
    {
        return "plain";
    }
    if (choice.pretty === true)
    {
        return "pretty";
    }
    if (process.stdout.isTTY !== true || dumbTerminal)
    {
        return "plain";
    }
    return termColumns(DEFAULT_COLUMNS) < MIN_COLUMNS ? "plain" : "pretty";
}

function columns(): number
{
    return termColumns(DEFAULT_COLUMNS);
}

/* ── ruled tables ──────────────────────────────────────────────────── */

type Paint = (text: string) => string;

const plain: Paint = (text) => text;

interface Column
{
    header: string;
    min: number;
    // The column that absorbs the difference between the natural widths and
    // the terminal — giving width back when it is narrow, taking up the slack
    // when it is wide. One per table; the others keep their natural width.
    flex?: boolean;
}

interface Cell
{
    text: string;
    paint?: Paint;
}

interface Row
{
    cells: Cell[];
    // Lines that belong to this row rather than to a row of their own — a
    // block reason, the proposal gating it, the outcome it contributes to.
    // They render under the value they qualify and run to the row's end.
    notes?: Cell[];
}

function rule(widths: number[], left: string, join: string, right: string): string
{
    return left + widths.map((width) => "─".repeat(width + 2)).join(join) + right;
}

// Every value reaches a bordered row through here, folded to one line. A
// stored outcome may contain a newline or a tab — `self work add` accepts one
// and the event guard is a secret filter, not a text normalizer — and a cell
// that moves the cursor down or across shatters every border below it.
function cellValue(cell: Cell | undefined): string
{
    return oneLine(cell?.text ?? "");
}

// The padding is measured on the unpainted text and appended after it, so an
// escape sequence never counts toward a column's width.
function cellText(cell: Cell | undefined, width: number): string
{
    const text = fitDisplay(cellValue(cell), width);
    return (cell?.paint ?? plain)(text) + padDisplay(text, width).slice(text.length);
}

function rowLine(cells: (Cell | undefined)[], widths: number[]): string
{
    return "│ " + widths.map((width, index) => cellText(cells[index], width)).join(" │ ") + " │";
}

// Natural width first — the widest header or value in each column — and then
// the flex column takes up any width left over, so every table on a surface
// ends at the same right edge whatever it holds. When the natural widths are
// already too wide, `shrinkToFit` decides; `null` means not even the minimums
// fit and the caller must not draw a border. Notes never widen a column: they
// qualify a value, and a long one truncates rather than pushing the value it
// qualifies out of view.
function columnWidths(spec: Column[], rows: Row[], available: number): number[] | null
{
    // Folded rather than spread into Math.max: a project with tens of
    // thousands of open units would otherwise overflow the argument list, and
    // a wide list is exactly when a person reaches for this render.
    const widths = spec.map((column, index) => rows.reduce(
        (widest, row) => Math.max(widest, displayWidth(cellValue(row.cells[index]))),
        Math.max(displayWidth(column.header), column.min)
    ));
    const target = Math.min(available, MAX_TABLE_COLUMNS);
    const slack = target - widths.reduce((sum, width) => sum + width, 0) - spec.length * 3 - 1;
    const flex = spec.findIndex((column) => column.flex === true);
    if (slack >= 0)
    {
        if (flex >= 0)
        {
            widths[flex] += slack;
        }
        return widths;
    }
    return shrinkToFit(spec, widths, -slack) ? widths : null;
}

// Every column gives width back, not only the flex one. A non-flex column can
// hold a list the model does not bound — the work units one proposal gates —
// and letting the flex column alone shrink pushed the border past the terminal
// and past MAX_TABLE_COLUMNS. The deficit is shared in proportion to what each
// column holds above its minimum, so no column collapses to nothing while
// another keeps room it does not need.
function shrinkToFit(spec: Column[], widths: number[], deficit: number): boolean
{
    const excess = widths.map((width, index) => width - spec[index].min);
    const total = excess.reduce((sum, value) => sum + value, 0);
    if (total < deficit)
    {
        return false;
    }
    let remaining = deficit;
    widths.forEach((_, index) =>
    {
        const give = Math.floor(deficit * excess[index] / total);
        widths[index] -= give;
        remaining -= give;
    });
    // Flooring leaves under one cell per column unclaimed; it is taken from
    // whichever columns still stand above their minimum.
    for (let index = 0; remaining > 0 && index < widths.length; index++)
    {
        const give = Math.min(remaining, widths[index] - spec[index].min);
        widths[index] -= give;
        remaining -= give;
    }
    return true;
}

// A note starts under the flex column and runs to the end of the row rather
// than sitting inside one cell. What notes carry — a block reason, the command
// that confirms a proposal — is the last thing that should lose characters to
// a column boundary, and a truncated id cannot be pasted anywhere.
function noteLine(spec: Column[], widths: number[], note: Cell): string
{
    const flex = Math.max(0, spec.findIndex((column) => column.flex === true));
    const span = widths.slice(flex).reduce((sum, width) => sum + width, 0) + (widths.length - flex - 1) * 3;
    const lead = widths.slice(0, flex).map((width) => " ".repeat(width));
    const text = fitDisplay(`↳ ${oneLine(note.text)}`, span);
    const painted = (note.paint ?? plain)(text) + padDisplay(text, span).slice(text.length);
    return (lead.length === 0 ? "│ " : `│ ${lead.join(" │ ")} │ `) + painted + " │";
}

// Not even every column's minimum fits, so no border is drawn: a rule that
// wraps says less than the plain lines it replaced. This is the same answer
// the narrow-terminal rule gives one table further down.
function unruledLines(spec: Column[], rows: Row[]): string[]
{
    const lines = [dim("  " + spec.map((column) => column.header).join("  "))];
    for (const row of rows)
    {
        lines.push("  " + row.cells.map((cell) => (cell.paint ?? plain)(cellValue(cell))).join("  "));
        lines.push(...(row.notes ?? []).map((note) => "    " + (note.paint ?? plain)(`↳ ${oneLine(note.text)}`)));
    }
    return lines;
}

function tableLines(spec: Column[], rows: Row[], available: number): string[]
{
    const widths = columnWidths(spec, rows, available);
    if (widths === null)
    {
        return unruledLines(spec, rows);
    }
    const header = spec.map((column): Cell => ({ text: column.header, paint: bold }));
    const lines = [rule(widths, "┌", "┬", "┐"), rowLine(header, widths), rule(widths, "├", "┼", "┤")];
    for (const row of rows)
    {
        lines.push(rowLine(row.cells, widths));
        for (const note of row.notes ?? [])
        {
            lines.push(noteLine(spec, widths, note));
        }
    }
    lines.push(rule(widths, "└", "┴", "┘"));
    return lines;
}

/* ── sections ──────────────────────────────────────────────────────── */

function heading(title: string, counts: string): string
{
    return bold(counts === "" ? title : `${title} (${counts})`);
}

// A section that had to stop short always says how much it left and which
// command prints the rest, so a glance is never mistaken for the whole list.
function moreLine(hidden: number, recover: string): string[]
{
    return hidden <= 0 ? [] : [dim(`  … +${hidden} more · ${recover}`)];
}

// Recovery commands are pasted into POSIX shells. Always quote a project slug
// as one literal argument; the '"'"' sequence is the portable way to embed a
// single quote inside a single-quoted shell word.
export function shellArgument(value: string): string
{
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Every recovery pointer a rendered surface prints names the project it pulls
// from. A context or a status is read far from where it was produced — piped
// into an agent, saved to a file, read at a terminal while standing somewhere
// else — and `--project other` made that literal: a bare `self work` in that
// output answers for wherever it is run rather than for what it describes.
//
// Only the verbs that have a scope form take one. `self integration plan`,
// `self attempt show`, `self decide confirm` and `self work accept` have none,
// so they are left as they are rather than promising a flag that does not
// exist. Both context renders read this, which is why it lives here: `views.ts`
// already imports this module, so one direction stays.
const SCOPED_POINTER = [
    /^self work show \S+$/,
    /^self work$/,
    /^self objective$/,
    /^self milestone$/,
    /^self status$/,
    /^self context$/,
    /^self log$/,
    /^self search /
];

export function scoped(command: string, project: string): string
{
    if (command.includes("--project "))
    {
        return command;
    }
    return SCOPED_POINTER.some((form) => form.test(command)) ? `${command} --project ${project}` : command;
}

function tableSection(title: string, counts: string, spec: Column[], rows: Row[], recover: string): string[]
{
    if (rows.length === 0)
    {
        return [heading(title, counts), dim("  none")];
    }
    return [
        heading(title, counts),
        ...tableLines(spec, rows.slice(0, CONTEXT_ROWS), columns()),
        ...moreLine(rows.length - CONTEXT_ROWS, recover)
    ];
}

function listSection(title: string, items: string[], recover: string, paint: Paint = plain): string[]
{
    if (items.length === 0)
    {
        return [heading(title, "0"), dim("  none")];
    }
    return [
        heading(title, String(items.length)),
        ...items.slice(0, CONTEXT_ROWS).map((item) => "  " + paint(fitDisplay(oneLine(item), columns() - 2))),
        ...moreLine(items.length - CONTEXT_ROWS, recover)
    ];
}

/* ── work ──────────────────────────────────────────────────────────── */

const WORK_COLUMNS: Column[] = [
    { header: "ID", min: 8 },
    { header: "STATE", min: 7 },
    { header: "OUTCOME", min: 12, flex: true },
    { header: "REPORTS", min: 7 }
];

const STATE_PAINT: Record<string, Paint> = {
    active: green,
    blocked: yellow,
    next: plain,
    done: green,
    retired: dim
};

function workRow(model: ProjectModel, work: WorkState): Row
{
    const toward = contributionsOf(model.goals, work).map((item) => item.id).join(", ");
    const notes: Cell[] = [];
    if (work.status === "blocked")
    {
        const why = work.blockedWhy === undefined ? "" : `: ${work.blockedWhy}`;
        notes.push({ text: `blocked on ${work.blockedOn}${why}`, paint: yellow });
    }
    // A unit that never started can still be gated, so this is named on its own
    // line rather than folded into the state cell.
    if (work.gatedBy.length > 0)
    {
        notes.push({ text: `gated by ${work.gatedBy.join(", ")} · self status`, paint: yellow });
    }
    if (toward !== "")
    {
        notes.push({ text: `toward ${toward}`, paint: dim });
    }
    return {
        cells: [
            { text: work.id, paint: dim },
            { text: work.status, paint: STATE_PAINT[work.status] ?? plain },
            { text: work.outcome },
            { text: String(work.reports.length) }
        ],
        notes
    };
}

export function renderWorkList(model: ProjectModel): string[]
{
    const open = model.works.filter((work) => work.status !== "done" && work.status !== "retired");
    const lines = open.length === 0
        ? [dim("no open work")]
        : tableLines(WORK_COLUMNS, open.map((work) => workRow(model, work)), columns());
    const done = model.works.filter((work) => work.status === "done").length;
    const retired = model.works.filter((work) => work.status === "retired").length;
    if (done > 0)
    {
        lines.push(`${green("✓")} ${dim(`${done} done — see log`)}`);
    }
    if (retired > 0)
    {
        lines.push(dim(`⊘ ${retired} retired — see log`));
    }
    return lines;
}

/* ── attention ─────────────────────────────────────────────────────── */

// The band and its ranking are the model's — `ATTENTION_ORDER` is imported,
// not restated — and nothing here re-decides which row belongs where. This
// file only gives each group a title, a column name and a table.
const ATTENTION_TITLES: Record<AttentionGroup, string> = {
    unblocks: "CONFIRMING UNBLOCKS WORK",
    undecidable: "CANNOT BE DECIDED YET",
    inEffect: "ALREADY IN EFFECT"
};

const ATTENTION_EFFECTS: Record<AttentionGroup, string> = {
    unblocks: "UNBLOCKS",
    undecidable: "WAITING ON",
    inEffect: "LANDED"
};

function attentionEffect(row: AttentionRow): string
{
    if (row.group === "undecidable")
    {
        return row.flags.join("; ");
    }
    return row.blocks.length === 0 ? "nothing recorded" : row.blocks.join(", ");
}

function attentionColumns(group: AttentionGroup): Column[]
{
    return [
        { header: "PROPOSAL", min: 12, flex: true },
        { header: ATTENTION_EFFECTS[group], min: 12 }
    ];
}

// The id travels on the row's own second line as the command that acts on it:
// a truncated id cannot be pasted, and the full one would take a third of the
// table for a value nobody reads character by character.
function attentionRow(row: AttentionRow): Row
{
    return {
        cells: [
            { text: row.text },
            { text: attentionEffect(row), paint: row.group === "inEffect" ? green : yellow }
        ],
        notes: [{ text: `self decide confirm ${row.decision}`, paint: dim }]
    };
}

function attentionCounts(model: ProjectModel): string
{
    return `${model.attention.unblocks.length} unblock work · `
        + `${model.attention.undecidable.length} cannot be decided yet · `
        + `${model.attention.inEffect.length} already in effect`;
}

function attentionSections(model: ProjectModel): string[]
{
    const total = ATTENTION_ORDER.reduce((sum, group) => sum + model.attention[group].length, 0);
    if (total === 0)
    {
        return [heading("DECISIONS WAITING", "0"), dim("  none")];
    }
    const lines = [heading("DECISIONS WAITING", attentionCounts(model))];
    for (const group of ATTENTION_ORDER.filter((item) => model.attention[item].length > 0))
    {
        const rows = model.attention[group];
        lines.push("", heading(ATTENTION_TITLES[group], String(rows.length)));
        lines.push(...tableLines(attentionColumns(group), rows.slice(0, CONTEXT_ROWS).map(attentionRow), columns()));
        lines.push(...moreLine(rows.length - CONTEXT_ROWS, scoped("self status", shellArgument(model.slug))));
    }
    return lines;
}

/* ── unshipped ─────────────────────────────────────────────────────── */

const UNSHIPPED_COLUMNS: Column[] = [
    { header: "BRANCH", min: 10 },
    { header: "UNSHIPPED", min: 14, flex: true }
];

// One row per branch, its units on the row's own lines. Commits are counted
// rather than listed: a hash truncated at a column boundary cannot be pasted,
// and the thing a reader acts on here is the branch.
function unshippedRow(branch: BranchUnshipped): Row
{
    const totals = branchTotals(branch);
    const shown = branch.unshipped.slice(0, CONTEXT_ROWS);
    const notes: Cell[] = shown.map((item): Cell => ({
        text: `${item.work} — ${item.unsettled} of ${plural(item.evidence, "commit")} unsettled (${item.status})`,
        paint: dim
    }));
    if (branch.unshipped.length > shown.length)
    {
        notes.push({ text: `+${branch.unshipped.length - shown.length} more · self work`, paint: dim });
    }
    return {
        cells: [
            { text: branchLabel(branch) },
            { text: `${plural(totals.units, "open work unit")} · ${totals.unsettled} of ${plural(totals.evidence, "commit")} unsettled`, paint: yellow }
        ],
        notes
    };
}

function unshippedCounts(model: ProjectModel): string
{
    if (model.unshipped.length === 0)
    {
        return "0";
    }
    const units = model.unshipped.reduce((sum, branch) => sum + branchTotals(branch).units, 0);
    return `${plural(model.unshipped.length, "branch", "branches")} · ${plural(units, "open work unit")}`;
}

function unshippedSection(model: ProjectModel): string[]
{
    return tableSection("UNSHIPPED BY BRANCH", unshippedCounts(model), UNSHIPPED_COLUMNS,
        model.unshipped.map(unshippedRow), scoped("self work", shellArgument(model.slug)));
}

/* ── status ────────────────────────────────────────────────────────── */

// What this machine is running right now, as the spool reports it. Kept to the
// four fields the roll-up reads so the renderer never has to open a spool.
export interface AttemptRow
{
    attempt: string;
    work: string;
    state: string;
    failure?: string;
}

interface AttemptTally
{
    work: string;
    open: number;
    running: number;
    blocked: number;
    cancelled: number;
    failures: Map<string, number>;
}

const ATTEMPT_COLUMNS: Column[] = [
    { header: "WORK", min: 8 },
    { header: "OPEN", min: 4 },
    { header: "ATTEMPTS", min: 16, flex: true }
];

// A person reading `self status` wants to know which unit is stuck, not which
// attempt id is. Per-attempt lines stay on the piped render, where a script
// still needs every id.
function tallyAttempts(rows: AttemptRow[]): AttemptTally[]
{
    const perWork = new Map<string, AttemptTally>();
    for (const row of rows)
    {
        const tally = perWork.get(row.work)
            ?? { work: row.work, open: 0, running: 0, blocked: 0, cancelled: 0, failures: new Map<string, number>() };
        tally.open += 1;
        if (row.state === "failed")
        {
            const kind = row.failure ?? "unknown";
            tally.failures.set(kind, (tally.failures.get(kind) ?? 0) + 1);
        }
        else if (row.state === "cancelled")
        {
            tally.cancelled += 1;
        }
        else if (row.state === "blocked")
        {
            tally.blocked += 1;
        }
        else
        {
            tally.running += 1;
        }
        perWork.set(row.work, tally);
    }
    return [...perWork.values()];
}

function failedCount(tally: AttemptTally): number
{
    return [...tally.failures.values()].reduce((sum, count) => sum + count, 0);
}

function tallyText(tally: AttemptTally): string
{
    const parts: string[] = [];
    if (tally.running > 0)
    {
        parts.push(`${tally.running} running`);
    }
    if (tally.failures.size > 0)
    {
        const kinds = [...tally.failures].map(([kind, count]) => `${kind} ×${count}`).join(", ");
        parts.push(`${failedCount(tally)} failed (${kinds})`);
    }
    if (tally.blocked > 0)
    {
        parts.push(`${tally.blocked} blocked`);
    }
    if (tally.cancelled > 0)
    {
        parts.push(`${tally.cancelled} cancelled`);
    }
    return parts.join(" · ");
}

function attemptRow(tally: AttemptTally): Row
{
    const paint = failedCount(tally) > 0 ? red : tally.blocked > 0 ? yellow : green;
    return {
        cells: [
            { text: tally.work, paint: dim },
            { text: String(tally.open) },
            { text: tallyText(tally), paint }
        ]
    };
}

function workCounts(model: ProjectModel): string
{
    const count = (status: string): number => model.works.filter((work) => work.status === status).length;
    return `${count("active")} active · ${count("blocked")} blocked · ${count("next")} next · ${count("done")} done`;
}

// What a surface is rendered from. `waiting` arrives already composed by the
// render layer's one waiting-item site, and carries everything that is not a
// live proposal — the proposals are the attention band, which is read straight
// off the model and grouped below, so no item is written twice.
export interface SurfaceInput
{
    model: ProjectModel;
    waiting: string[];
}

export interface StatusInput extends SurfaceInput
{
    objectives: string;
    integration: string;
    attempts: AttemptRow[];
}

export function renderStatus(input: StatusInput): string[]
{
    const { model } = input;
    const project = shellArgument(model.slug);
    const lines = [`${bold(model.slug)} — ${model.goal === undefined ? dim("(goal not set)") : oneLine(model.goal)}`, ""];
    lines.push(heading("WORK", workCounts(model)));
    if (openObjectives(model.goals).length > 0)
    {
        lines.push(heading("OBJECTIVES", input.objectives));
    }
    if (model.integration.changeSets.length > 0)
    {
        lines.push(heading("INTEGRATION", input.integration));
    }
    lines.push(heading("DECISIONS WAITING", attentionCounts(model)));
    lines.push("", ...unshippedSection(model));
    lines.push("", ...listSection("WAITING ON YOU", input.waiting.map(firstLine), scoped("self context", project), yellow));
    lines.push("", ...listSection("HEALTH", model.health, scoped("self status", project), red));
    const tallies = tallyAttempts(input.attempts);
    lines.push("", heading("ATTEMPTS ON THIS MACHINE", String(input.attempts.length)));
    lines.push(...(tallies.length === 0 ? [dim("  none")] : tableLines(ATTEMPT_COLUMNS, tallies.map(attemptRow), columns())));
    return lines;
}

function firstLine(text: string): string
{
    return text.split("\n", 1)[0];
}

/* ── context ───────────────────────────────────────────────────────── */

const OPEN_FIRST: Record<string, number> = { active: 0, blocked: 1, next: 2 };

// `self context` on a terminal is the same state the piped render carries,
// ordered for a glance: what is moving, what waits on a person, then the
// standing rules. It never runs through the 12,000-character budget — that cap
// exists to fit an agent's window, and a terminal has no such window.
export function renderContext(input: SurfaceInput): string[]
{
    const { model } = input;
    const project = shellArgument(model.slug);
    const lines = [bold(model.slug)];
    if (model.description !== undefined)
    {
        lines.push(dim(fitDisplay(oneLine(model.description), columns())));
    }
    lines.push(`Goal: ${fitDisplay(oneLine(model.goal ?? "(not set)"), columns() - 6)}`, "");
    const open = model.works
        .filter((work) => work.status !== "done" && work.status !== "retired")
        .sort((left, right) => (OPEN_FIRST[left.status] ?? 3) - (OPEN_FIRST[right.status] ?? 3));
    lines.push(...tableSection("WORK", workCounts(model), WORK_COLUMNS, open.map((work) => workRow(model, work)),
        scoped("self work", project)));
    lines.push("", ...unshippedSection(model));
    lines.push("", ...attentionSections(model));
    lines.push("", ...listSection("WAITING ON YOU", input.waiting.map(firstLine), scoped("self context", project), yellow));
    lines.push("", ...listSection("OBJECTIVES", objectiveLines(model), scoped("self objective", project)));
    lines.push("", ...listSection("DECISIONS", decisionLines(model), scoped("self search --type decision", project)));
    lines.push("", ...listSection("CONVENTIONS", model.conventions.map((item) => item.text),
        scoped("self search --type convention", project)));
    lines.push("", ...listSection("INTEGRATION", trainLines(model), "self integration plan"));
    lines.push("", ...listSection("HEALTH", model.health, scoped("self status", project), red));
    return lines;
}

function objectiveLines(model: ProjectModel): string[]
{
    return openObjectives(model.goals).map((objective) =>
        `${objective.id} ${objective.outcome} — ${objective.state}: ${objective.reason}`);
}

function decisionLines(model: ProjectModel): string[]
{
    return model.decisions
        .filter((decision) => decision.status === "confirmed")
        .map((decision) => decision.text)
        .reverse();
}

function trainLines(model: ProjectModel): string[]
{
    return openChangeSets(model.integration).map((changeSet) =>
        `${changeSet.id} — ${changeSet.phase}: ${changeSet.reason}`);
}

/* ── workspace ─────────────────────────────────────────────────────── */

const PROJECT_COLUMNS: Column[] = [
    { header: "PROJECT", min: 8 },
    { header: "WORK", min: 20 },
    { header: "GOAL", min: 12, flex: true }
];

export function renderWorkspace(models: ProjectModel[]): string[]
{
    const rows = models.map((model): Row => ({
        cells: [
            { text: model.slug, paint: bold },
            { text: workCounts(model) },
            { text: model.goal ?? "(no goal)" }
        ],
        notes: model.health.length === 0
            ? []
            : [{ text: `${model.health.length} health signal${model.health.length === 1 ? "" : "s"}`, paint: red }]
    }));
    if (rows.length === 0)
    {
        return [dim("  none")];
    }
    return tableLines(PROJECT_COLUMNS, rows, columns());
}
