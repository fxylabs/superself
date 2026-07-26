import { eventSummary, readEvents } from "./logfile.js";
import { buildModel, ProjectModel, WorkState } from "./model.js";
import { CliContext, readRegistry } from "./paths.js";
import { loadVerdicts, verdictSignals } from "./reachability.js";
import { blue, bold, dim, fit, green, red, styled, termWidth, yellow } from "./style.js";

const CONTEXT_LIMIT = 12_000;
// The command writes one final newline; the rendered body owns the rest.
const CONTEXT_BODY_LIMIT = CONTEXT_LIMIT - 1;
const REPORT_EXCERPT_LIMIT = 500;

interface ProjectContextOptions
{
    decisions: string[];
    omittedDecisions: number;
    reportExcerpt: number;
    detailLimit: number;
    compactOptional: boolean;
}

interface WaitingItem
{
    full: string;
    identity: string;
    recovery: string;
}

// Console surfaces reuse the verdicts persisted by the last fold, so they
// agree with canonical state without re-running git.
function modelWithVerdicts(storeDir: string, slug: string): ProjectModel
{
    const model = buildModel(storeDir, slug, new Date());
    model.health.push(...verdictSignals(model.works, loadVerdicts(storeDir, slug)));
    return model;
}

export function printContext(ctx: CliContext): void
{
    if (ctx.project === undefined)
    {
        writeContext(renderWorkspaceContext(ctx));
        return;
    }
    const model = modelWithVerdicts(ctx.storeDir, ctx.project);
    writeContext(renderProjectContext(model));
}

function renderProjectContext(model: ProjectModel): string
{
    const confirmed = [...model.decisions]
        .filter((decision) => decision.status === "confirmed")
        .sort(compareDated)
        .map((decision) => `- ${decision.text}${decision.why === undefined ? "" : ` — ${decision.why}`}`);
    let options: ProjectContextOptions = {
        decisions: [],
        omittedDecisions: confirmed.length,
        reportExcerpt: REPORT_EXCERPT_LIMIT,
        detailLimit: Number.POSITIVE_INFINITY,
        compactOptional: false
    };

    if (contextLength(renderProject(model, options)) > CONTEXT_BODY_LIMIT)
    {
        options = { ...options, reportExcerpt: largestReportExcerpt(model, options) };
    }
    if (contextLength(renderProject(model, options)) > CONTEXT_BODY_LIMIT)
    {
        options = { ...options, compactOptional: true, detailLimit: largestDetailLimit(model, options) };
    }
    if (contextLength(renderProject(model, options)) > CONTEXT_BODY_LIMIT)
    {
        return renderMinimalProjectContext(model, confirmed);
    }

    // Report excerpts and the non-decision sections claim their space first.
    // Decisions then enter newest-first until the next whole decision would
    // cross the cap. Selected decisions retain their original chronological
    // order in the rendered section.
    for (let index = confirmed.length - 1; index >= 0; index--)
    {
        const candidate = {
            ...options,
            decisions: [confirmed[index], ...options.decisions],
            omittedDecisions: index
        };
        if (contextLength(renderProject(model, candidate)) > CONTEXT_BODY_LIMIT)
        {
            break;
        }
        options = candidate;
    }
    return renderProject(model, options);
}

function renderProject(model: ProjectModel, options: ProjectContextOptions): string
{
    const lines: string[] = [`# ${model.slug}`, ""];
    if (model.description !== undefined)
    {
        lines.push(detail(model.description, options.detailLimit, `self search --project ${model.slug}`), "");
    }
    lines.push(`Goal: ${detail(model.goal ?? "(not set)", options.detailLimit, `self search --project ${model.slug}`)}`, "");
    const decisionLines = [...options.decisions];
    if (options.omittedDecisions > 0)
    {
        decisionLines.unshift(`- … ${options.omittedDecisions} confirmed decision${options.omittedDecisions === 1 ? "" : "s"} omitted; run \`self search --type decision\``);
    }
    pushList(lines, "Decisions", decisionLines);
    pushList(lines, "Conventions", model.conventions.map((convention) =>
        `- ${detail(convention.text, options.detailLimit, `self search ${convention.id} --type convention --project ${model.slug}`)}`));
    pushList(lines, "Work in progress", inProgressLines(model, options.reportExcerpt, options.detailLimit));
    pushList(lines, "Waiting on you", waitingItems(model).map((item) =>
        detail(item.full, options.detailLimit, item.recovery)));
    const next = model.works.filter((work) => work.status === "next");
    pushList(lines, "Next", options.compactOptional && next.length > 0
        ? [`- … ${next.length} next work item${next.length === 1 ? "" : "s"} omitted; run \`self work\``]
        : next.map((work) => `- ${work.id} ${detail(work.outcome, options.detailLimit, `self work show ${work.id}`)}`));
    pushList(lines, "Health", options.compactOptional && model.health.length > 0
        ? [`- … ${model.health.length} health signal${model.health.length === 1 ? "" : "s"} omitted; run \`self status\``]
        : model.health.map((health) => `- ${detail(health, options.detailLimit, "self status")}`));
    return lines.join("\n").replace(/\n+$/, "");
}

function renderMinimalProjectContext(model: ProjectModel, confirmed: string[]): string
{
    let selected: string[] = [];
    let omitted = confirmed.length;
    if (contextLength(renderMinimalProject(model, selected, omitted)) > CONTEXT_BODY_LIMIT)
    {
        return renderAggregateProject(model);
    }
    for (let index = confirmed.length - 1; index >= 0; index--)
    {
        const candidate = [confirmed[index], ...selected];
        if (contextLength(renderMinimalProject(model, candidate, index)) > CONTEXT_BODY_LIMIT)
        {
            break;
        }
        selected = candidate;
        omitted = index;
    }
    return renderMinimalProject(model, selected, omitted);
}

function renderMinimalProject(model: ProjectModel, decisions: string[], omittedDecisions: number): string
{
    const recovery = `self search --project ${model.slug}`;
    const lines: string[] = [`# ${model.slug}`, ""];
    if (model.description !== undefined)
    {
        lines.push(`Description: omitted; run \`${recovery}\``, "");
    }
    lines.push(`Goal: omitted; run \`${recovery}\``, "");
    const decisionLines = [...decisions];
    if (omittedDecisions > 0)
    {
        decisionLines.unshift(`- … ${omittedDecisions} confirmed decision${omittedDecisions === 1 ? "" : "s"} omitted; run \`self search --type decision --project ${model.slug}\``);
    }
    pushList(lines, "Decisions", decisionLines);
    pushList(lines, "Conventions", [...model.conventions]
        .sort(compareDated)
        .map((convention) => `- convention ${convention.id}; run \`self search ${convention.id} --type convention --project ${model.slug}\``));
    const progressing = [...model.works]
        .filter((work) => work.status === "active" || (work.status === "blocked" && work.blockedOn !== "decision"))
        .sort((left, right) => left.id.localeCompare(right.id));
    pushList(lines, "Work in progress", progressing.map((work) =>
        `- ${work.status} work ${work.id}; run \`self work show ${work.id}\``));
    pushList(lines, "Waiting on you", waitingItems(model).map((item) =>
        `- ${item.identity}; run \`${item.recovery}\``));
    const next = model.works.filter((work) => work.status === "next").length;
    if (next > 0)
    {
        pushList(lines, "Next", [`- … ${next} next work item${next === 1 ? "" : "s"} omitted; run \`self work\``]);
    }
    if (model.health.length > 0)
    {
        pushList(lines, "Health", [`- … ${model.health.length} health signal${model.health.length === 1 ? "" : "s"} omitted; run \`self status\``]);
    }
    return lines.join("\n").replace(/\n+$/, "");
}

// If even one identity-and-pointer row per protected item cannot fit, listing
// a prefix would silently privilege log order. Aggregate every protected
// category instead and say exactly where the complete canonical state lives.
function renderAggregateProject(model: ProjectModel): string
{
    const active = model.works.filter((work) => work.status === "active").length;
    const blocked = model.works.filter((work) => work.status === "blocked").length;
    const waiting = waitingItems(model).length;
    const recovery = `self search --project ${model.slug}`;
    return [
        `# ${takeCharacters(model.slug, 200)}`,
        "",
        `Protected context is larger than ${CONTEXT_LIMIT.toLocaleString("en-US")} characters even as identity rows.`,
        `- description/goal: run \`${recovery}\``,
        `- ${model.conventions.length} convention${model.conventions.length === 1 ? "" : "s"}: run \`${recovery}\``,
        `- ${active} active and ${blocked} blocked work item${active + blocked === 1 ? "" : "s"}: run \`self work\``,
        `- ${waiting} waiting item${waiting === 1 ? "" : "s"}: run \`${recovery}\``,
        `- decisions: run \`self search --type decision --project ${model.slug}\``
    ].join("\n");
}

function largestReportExcerpt(model: ProjectModel, options: ProjectContextOptions): number
{
    let low = 0;
    let high = REPORT_EXCERPT_LIMIT;
    while (low < high)
    {
        const middle = Math.ceil((low + high) / 2);
        const candidate = renderProject(model, { ...options, reportExcerpt: middle });
        if (contextLength(candidate) <= CONTEXT_BODY_LIMIT)
        {
            low = middle;
        }
        else
        {
            high = middle - 1;
        }
    }
    return low;
}

function largestDetailLimit(model: ProjectModel, options: ProjectContextOptions): number
{
    let low = 24;
    let high = 1_000;
    let best = low;
    while (low <= high)
    {
        const middle = Math.floor((low + high) / 2);
        const candidate = renderProject(model, { ...options, detailLimit: middle });
        if (contextLength(candidate) <= CONTEXT_BODY_LIMIT)
        {
            best = middle;
            low = middle + 1;
        }
        else
        {
            high = middle - 1;
        }
    }
    return best;
}

function inProgressLines(model: ProjectModel, reportLimit: number, detailLimit: number): string[]
{
    const active = model.works.filter((w) => w.status === "active").map((work) =>
    {
        const latest = [...work.reports].sort(compareDated).at(-1);
        const outcome = detail(work.outcome, detailLimit, `self work show ${work.id}`);
        const report = latest === undefined ? "" : reportExcerpt(latest.text, work.id, reportLimit);
        const next = work.next === undefined ? "" : ` (next: ${detail(work.next, detailLimit, `self work show ${work.id}`)})`;
        return `- ${work.id} ${outcome}${report}${next}`;
    });
    const blocked = model.works
        .filter((w) => w.status === "blocked" && w.blockedOn !== "decision")
        .map((work) => `- ${work.id} ${detail(work.outcome, detailLimit, `self work show ${work.id}`)} — blocked on ${work.blockedOn}${work.blockedWhy === undefined ? "" : `: ${detail(work.blockedWhy, detailLimit, `self work show ${work.id}`)}`}`);
    return [...active, ...blocked];
}

function reportExcerpt(text: string, work: string, limit: number): string
{
    const recovery = `\`self work show ${work}\``;
    if (limit === 0)
    {
        return ` — latest report: ${recovery}`;
    }
    const normalized = text.trim().replace(/\s+/g, " ");
    const excerpt = takeCharacters(normalized, limit);
    const ellipsis = contextLength(normalized) > limit ? "…" : "";
    return ` — latest report: ${excerpt}${ellipsis} (full: ${recovery})`;
}

function waitingItems(model: ProjectModel): WaitingItem[]
{
    const questions = model.works
        .filter((work) => work.status === "blocked" && work.blockedOn === "decision")
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((work): WaitingItem => ({
            full: `- ${work.id} is waiting on a decision: ${work.blockedWhy ?? work.outcome}`,
            identity: `blocked work ${work.id}`,
            recovery: `self work show ${work.id}`
        }));
    const proposals = [...model.decisions]
        .filter((d) => d.status === "proposed" && !d.expired)
        .sort(compareDated)
        .map((decision): WaitingItem => ({
            full: `- proposal: ${decision.text} (confirm with \`self decide confirm ${decision.id}\`)`,
            identity: `proposal ${decision.id}`,
            recovery: `self search ${decision.id} --type decision --project ${model.slug}`
        }));
    return [...questions, ...proposals];
}

function compareDated(left: { ts: string; id: string }, right: { ts: string; id: string }): number
{
    return left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id);
}

function pushList(lines: string[], title: string, items: string[]): void
{
    if (items.length === 0)
    {
        return;
    }
    lines.push(`## ${title}`, "", ...items, "");
}

function detail(text: string, limit: number, recovery: string): string
{
    if (!Number.isFinite(limit) || contextLength(text) <= limit)
    {
        return text;
    }
    return `${takeCharacters(text.trim().replace(/\s+/g, " "), limit)}… (full: \`${recovery}\`)`;
}

function renderWorkspaceContext(ctx: CliContext): string
{
    const models = readRegistry(ctx.storeDir).map((entry) => modelWithVerdicts(ctx.storeDir, entry.slug));
    if (models.length === 0)
    {
        return "no projects registered — run `self project add` inside a project directory";
    }
    const full = models.map(workspaceContextLine).join("\n");
    if (contextLength(full) <= CONTEXT_BODY_LIMIT)
    {
        return full;
    }
    const kept: string[] = [];
    for (let index = 0; index < models.length; index++)
    {
        const next = [...kept, workspaceContextLine(models[index])];
        const omitted = models.length - index - 1;
        if (omitted > 0)
        {
            next.push(workspaceOmission(omitted));
        }
        if (contextLength(next.join("\n")) > CONTEXT_BODY_LIMIT)
        {
            break;
        }
        kept.push(workspaceContextLine(models[index]));
    }
    const omitted = models.length - kept.length;
    if (omitted > 0)
    {
        kept.push(workspaceOmission(omitted));
    }
    return kept.length === 0
        ? workspaceOmission(models.length)
        : kept.join("\n");
}

function workspaceContextLine(model: ProjectModel): string
{
    const health = model.health.length === 0 ? "" : ` [${model.health.length} health signal(s)]`;
    const goal = detail(model.goal ?? "(no goal)", 500, "self status");
    return `${model.slug} — ${goal} (${countLine(model.works)})${health}`;
}

function workspaceOmission(count: number): string
{
    return `… ${count} project summar${count === 1 ? "y" : "ies"} omitted; run \`self status\` from the workspace for the full summaries`;
}

function writeContext(text: string): void
{
    process.stdout.write(text + "\n");
}

function contextLength(text: string): number
{
    return Array.from(text).length;
}

function takeCharacters(text: string, count: number): string
{
    return Array.from(text).slice(0, Math.max(0, count)).join("");
}

export function printStatus(ctx: CliContext): void
{
    if (ctx.project === undefined)
    {
        printWorkspaceOverview(ctx);
        return;
    }
    const model = modelWithVerdicts(ctx.storeDir, ctx.project);
    if (styled)
    {
        printStyledStatus(model);
        return;
    }
    console.log(`${model.slug} — goal: ${model.goal ?? "(not set)"}`);
    console.log(`work: ${countLine(model.works)}`);
    console.log(`waiting on you: ${model.openQuestions.length + model.decisions.filter((d) => d.status === "proposed" && !d.expired).length}`);
    console.log(model.health.length === 0 ? "health: ok" : `health: ${model.health.join("; ")}`);
}

function printStyledStatus(model: ProjectModel): void
{
    console.log(`${bold(model.slug)} — ${model.goal ?? dim("(goal not set)")}`);
    console.log(countGlyphs(model.works));
    const waiting = model.openQuestions.length + model.decisions.filter((d) => d.status === "proposed" && !d.expired).length;
    if (waiting > 0)
    {
        console.log(yellow(`⚠ waiting on you: ${waiting}`));
    }
    for (const signal of model.health)
    {
        console.log(yellow(`⚠ ${signal}`));
    }
    if (waiting === 0 && model.health.length === 0)
    {
        console.log(`${green("✓")} ${dim("nothing waiting, health ok")}`);
    }
}

const STATUS_GLYPHS: [string, string][] = [
    ["active", blue("●")],
    ["blocked", red("■")],
    ["next", "○"],
    ["done", green("✓")]
];

function countGlyphs(works: WorkState[]): string
{
    const parts = STATUS_GLYPHS
        .map(([status, glyph]) => ({ glyph, status, n: works.filter((w) => w.status === status).length }))
        .filter((part) => part.n > 0)
        .map((part) => `${part.glyph} ${part.n} ${part.status}`);
    return parts.length === 0 ? dim("no work yet") : parts.join("   ");
}

function printWorkspaceOverview(ctx: CliContext): void
{
    const registry = readRegistry(ctx.storeDir);
    if (registry.length === 0)
    {
        console.log("no projects registered — run `self project add` inside a project directory");
        return;
    }
    const models = registry.map((entry) => modelWithVerdicts(ctx.storeDir, entry.slug));
    if (styled)
    {
        const width = Math.max(...models.map((model) => model.slug.length));
        console.log(models.map((model) => overviewBlock(model, width)).join("\n\n"));
        return;
    }
    for (const model of models)
    {
        const health = model.health.length === 0 ? "" : ` [${model.health.length} health signal(s)]`;
        console.log(`${model.slug} — ${model.goal ?? "(no goal)"} (${countLine(model.works)})${health}`);
    }
}

function overviewBlock(model: ProjectModel, width: number): string
{
    const health = model.health.length === 0 ? "" : `   ${yellow(`⚠ ${model.health.length}`)}`;
    const indent = " ".repeat(width + 2);
    const goal = fit(model.goal ?? "(no goal)", termWidth() - indent.length);
    return `${bold(model.slug.padEnd(width))}  ${countGlyphs(model.works)}${health}\n${indent}${dim(goal)}`;
}

function countLine(works: WorkState[]): string
{
    const count = (status: string): number => works.filter((w) => w.status === status).length;
    return `${count("active")} active, ${count("blocked")} blocked, ${count("next")} next, ${count("done")} done`;
}

export function printWorkList(ctx: CliContext & { project: string }): void
{
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const open = model.works.filter((w) => w.status !== "done");
    if (open.length === 0)
    {
        console.log("no open work");
    }
    for (const work of open)
    {
        console.log(styled ? workLines(work) : plainWorkLine(work));
    }
    const done = model.works.length - open.length;
    if (done > 0)
    {
        console.log(styled ? `${green("✓")} ${dim(`${done} done — see log`)}` : `(${done} done — see log)`);
    }
}

function plainWorkLine(work: WorkState): string
{
    const blocked = work.status === "blocked" ? ` (on ${work.blockedOn})` : "";
    const reports = work.reports.length > 0 ? `  — ${work.reports.length} report(s), see \`self work show ${work.id}\`` : "";
    return `${work.id}  ${work.status}${blocked}  ${work.outcome}${reports}`;
}

function workLines(work: WorkState): string
{
    const glyph = work.status === "active" ? blue("●") : work.status === "blocked" ? red("■") : "○";
    const indent = " ".repeat(work.id.length + 4);
    const lines = [`${glyph} ${dim(work.id)}  ${work.outcome}`];
    if (work.status === "blocked")
    {
        lines.push(indent + red(`blocked on ${work.blockedOn}${work.blockedWhy === undefined ? "" : `: ${work.blockedWhy}`}`));
    }
    if (work.reports.length > 0)
    {
        lines.push(indent + dim(`${work.reports.length} report(s) · self work show ${work.id}`));
    }
    return lines.join("\n");
}

export function printLog(ctx: CliContext & { project: string }, limit: number): void
{
    const events = readEvents(ctx.storeDir, ctx.project);
    for (const event of events.slice(-limit))
    {
        if (styled)
        {
            const ts = event.ts.slice(5, 16).replace("T", " ");
            const width = Math.max(20, termWidth() - 37 - event.id.length);
            const summary = fit(eventSummary(event).split("\n", 1)[0], width);
            console.log(`${dim(ts)}  ${eventStyle(event.type)(event.type.padEnd(18))}  ${summary}  ${dim(`[${event.id}]`)}`);
        }
        else
        {
            console.log(`${event.ts}  ${event.type}  [${event.id}]  ${eventSummary(event)}`);
        }
    }
}

function eventStyle(type: string): (text: string) => string
{
    if (type === "work.blocked")
    {
        return red;
    }
    if (type === "work.done")
    {
        return green;
    }
    if (type.startsWith("work."))
    {
        return blue;
    }
    if (type.startsWith("decision.") || type === "goal.set")
    {
        return yellow;
    }
    return dim;
}
