import { eventSummary, readEvents } from "./logfile.js";
import { buildModel, ProjectModel, WorkState } from "./model.js";
import { contributionsOf, openObjectives, openProposals } from "./objectives.js";
import { CliContext, readRegistry } from "./paths.js";
import { loadVerdicts, verdictSignals } from "./reachability.js";
import { blue, bold, dim, fit, green, red, styled, termWidth, yellow } from "./style.js";

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
        printWorkspaceOverview(ctx);
        return;
    }
    const model = modelWithVerdicts(ctx.storeDir, ctx.project);
    const lines: string[] = [`# ${model.slug}`, ""];
    if (model.description !== undefined)
    {
        lines.push(model.description, "");
    }
    lines.push(`Goal: ${model.goal ?? "(not set)"}`, "");
    pushList(lines, "Objectives", objectiveLines(model));
    pushList(lines, "Decisions", model.decisions.filter((d) => d.status === "confirmed").map((d) => `- ${d.text}${d.why === undefined ? "" : ` — ${d.why}`}`));
    pushList(lines, "Conventions", model.conventions.map((c) => `- ${c.text}`));
    pushList(lines, "Work in progress", inProgressLines(model));
    pushList(lines, "Attempts", attemptLines(model));
    pushList(lines, "Waiting on you", waitingLines(model));
    pushList(lines, "Next", model.works.filter((w) => w.status === "next").map((w) => `- ${w.id} ${w.outcome}`));
    pushList(lines, "Health", model.health.map((h) => `- ${h}`));
    console.log(lines.join("\n").replace(/\n+$/, ""));
}

// The outcome layer, in the order an agent needs it: the target, why it reads
// the way it does, and which milestone still has nothing pointed at it.
function objectiveLines(model: ProjectModel): string[]
{
    const lines: string[] = [];
    for (const objective of openObjectives(model.goals))
    {
        const box = objective.target === undefined ? "" : ` (${objective.horizon ?? "target"} ${objective.target})`;
        lines.push(`- ${objective.id} ${objective.outcome}${box} — ${objective.state}: ${objective.reason}`);
        for (const milestone of objective.milestones.filter((m) => m.state !== "closed"))
        {
            const flags = [milestone.criticalPath ? "critical path" : "", milestone.works.length === 0 ? "no work linked" : ""]
                .filter((flag) => flag !== "").join(", ");
            lines.push(`  - ${milestone.id} ${milestone.outcome} — ${milestone.state}: ${milestone.reason}` +
                `${flags === "" ? "" : ` [${flags}]`}`);
        }
    }
    return lines;
}

function inProgressLines(model: ProjectModel): string[]
{
    const active = model.works.filter((w) => w.status === "active").map((work) =>
    {
        const latest = work.reports[work.reports.length - 1];
        const report = latest === undefined ? "" : ` — ${latest.text}`;
        const next = work.next === undefined ? "" : ` (next: ${work.next})`;
        const toward = contributionsOf(model.goals, work).map((item) => item.id).join(", ");
        return `- ${work.id} ${work.outcome}${toward === "" ? "" : ` [toward ${toward}]`}${report}${next}`;
    });
    const blocked = model.works
        .filter((w) => w.status === "blocked" && w.blockedOn !== "decision")
        .map((w) => `- ${w.id} ${w.outcome} — blocked on ${w.blockedOn}${w.blockedWhy === undefined ? "" : `: ${w.blockedWhy}`}`);
    return [...active, ...blocked];
}

// What ran while nobody was in a session reaches the person through the next
// session they open, rather than through a queue they have to visit.
function attemptLines(model: ProjectModel): string[]
{
    return model.works
        .filter((work) => work.status !== "done")
        .flatMap((work) => work.attempts.map((attempt) =>
        {
            const verdict = attempt.verdict === undefined ? attempt.phase : `${attempt.phase} ${attempt.verdict}`;
            const outputs = attempt.outputs.length === 0 ? "" : ` [${attempt.outputs.join(", ")}]`;
            return `- ${work.id} ${attempt.id} ${attempt.kind}/${attempt.runtime} — ${verdict}${outputs}`;
        }));
}

function waitingLines(model: ProjectModel): string[]
{
    const questions = model.openQuestions.map((q) => `- ${q}`);
    const proposals = model.decisions
        .filter((d) => d.status === "proposed" && !d.expired)
        .map((d) => `- proposal: ${d.text} (confirm with \`self decide confirm ${d.id}\`)`);
    return [...questions, ...proposals, ...workProposalLines(model)];
}

// A proposal is only actionable if the reader can weigh it, so the whole brief
// travels with it rather than an outcome line pointing at a page.
function workProposalLines(model: ProjectModel): string[]
{
    return openProposals(model.goals).flatMap((proposal) => [
        `- work proposal ${proposal.id.slice(0, 8)}: ${proposal.outcome}`,
        `  toward ${proposal.milestone ?? proposal.objective} · value: ${proposal.value}`,
        `  success: ${proposal.success.join("; ")} · stop: ${proposal.stop.join("; ")}`,
        `  depends: ${proposal.depends.length === 0 ? "nothing" : proposal.depends.join(", ")} · risk: ${proposal.risk}`,
        `  capacity: ${proposal.capacity} · evidence plan: ${proposal.evidencePlan}`,
        `  confidence: ${proposal.confidence} · expires ${proposal.expires} — \`self work accept ${proposal.id.slice(0, 8)}\``
    ]);
}

function pushList(lines: string[], title: string, items: string[]): void
{
    if (items.length === 0)
    {
        return;
    }
    lines.push(`## ${title}`, "", ...items, "");
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
    console.log(`objectives: ${objectiveCountLine(model)}`);
    console.log(`waiting on you: ${waitingCount(model)}`);
    console.log(model.health.length === 0 ? "health: ok" : `health: ${model.health.join("; ")}`);
}

// A flat active count can look busy without saying whether the project is
// moving, so the objective roll-up sits beside it.
function objectiveCountLine(model: ProjectModel): string
{
    const objectives = openObjectives(model.goals);
    const milestones = objectives.flatMap((objective) => objective.milestones);
    const met = objectives.reduce((sum, objective) => sum + objective.met, 0);
    const total = objectives.reduce((sum, objective) => sum + objective.total, 0);
    return `${objectives.length} open, ${milestones.filter((m) => m.state === "reached").length} of ` +
        `${milestones.length} milestones reached, ${met} of ${total} exit criteria covered`;
}

export function waitingCount(model: ProjectModel): number
{
    return model.openQuestions.length
        + model.decisions.filter((d) => d.status === "proposed" && !d.expired).length
        + openProposals(model.goals).length;
}

function printStyledStatus(model: ProjectModel): void
{
    console.log(`${bold(model.slug)} — ${model.goal ?? dim("(goal not set)")}`);
    console.log(countGlyphs(model.works));
    if (openObjectives(model.goals).length > 0)
    {
        console.log(dim(objectiveCountLine(model)));
    }
    const waiting = waitingCount(model);
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
        const toward = contributionsOf(model.goals, work).map((item) => item.id).join(", ");
        console.log(styled ? workLines(work, toward) : plainWorkLine(work, toward));
    }
    const done = model.works.length - open.length;
    if (done > 0)
    {
        console.log(styled ? `${green("✓")} ${dim(`${done} done — see log`)}` : `(${done} done — see log)`);
    }
}

function plainWorkLine(work: WorkState, toward: string): string
{
    const blocked = work.status === "blocked" ? ` (on ${work.blockedOn})` : "";
    const reports = work.reports.length > 0 ? `  — ${work.reports.length} report(s), see \`self work show ${work.id}\`` : "";
    return `${work.id}  ${work.status}${blocked}  ${work.outcome}${toward === "" ? "" : `  [toward ${toward}]`}${reports}`;
}

function workLines(work: WorkState, toward: string): string
{
    const glyph = work.status === "active" ? blue("●") : work.status === "blocked" ? red("■") : "○";
    const indent = " ".repeat(work.id.length + 4);
    const lines = [`${glyph} ${dim(work.id)}  ${work.outcome}`];
    if (toward !== "")
    {
        lines.push(indent + dim(`toward ${toward}`));
    }
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
    if (type === "work.done" || type === "milestone.reached" || type === "objective.closed")
    {
        return green;
    }
    if (type.startsWith("work."))
    {
        return blue;
    }
    if (type.startsWith("decision.") || type.startsWith("objective.") || type.startsWith("milestone.") || type === "goal.set")
    {
        return yellow;
    }
    return dim;
}
