import { eventSummary, readEvents } from "./logfile.js";
import { buildModel, ProjectModel, WorkState } from "./model.js";
import { CliContext, readRegistry } from "./paths.js";
import { loadVerdicts, verdictSignals } from "./reachability.js";

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
    pushList(lines, "Decisions", model.decisions.filter((d) => d.status === "confirmed").map((d) => `- ${d.text}${d.why === undefined ? "" : ` — ${d.why}`}`));
    pushList(lines, "Conventions", model.conventions.map((c) => `- ${c.text}`));
    pushList(lines, "Work in progress", inProgressLines(model));
    pushList(lines, "Waiting on you", waitingLines(model));
    pushList(lines, "Next", model.works.filter((w) => w.status === "next").map((w) => `- ${w.id} ${w.outcome}`));
    pushList(lines, "Health", model.health.map((h) => `- ${h}`));
    console.log(lines.join("\n").replace(/\n+$/, ""));
}

function inProgressLines(model: ProjectModel): string[]
{
    const active = model.works.filter((w) => w.status === "active").map((work) =>
    {
        const latest = work.reports[work.reports.length - 1];
        const report = latest === undefined ? "" : ` — ${latest.text}`;
        const next = work.next === undefined ? "" : ` (next: ${work.next})`;
        return `- ${work.id} ${work.outcome}${report}${next}`;
    });
    const blocked = model.works
        .filter((w) => w.status === "blocked" && w.blockedOn !== "decision")
        .map((w) => `- ${w.id} ${w.outcome} — blocked on ${w.blockedOn}${w.blockedWhy === undefined ? "" : `: ${w.blockedWhy}`}`);
    return [...active, ...blocked];
}

function waitingLines(model: ProjectModel): string[]
{
    const questions = model.openQuestions.map((q) => `- ${q}`);
    const proposals = model.decisions
        .filter((d) => d.status === "proposed" && !d.expired)
        .map((d) => `- proposal: ${d.text} (confirm with \`self decide confirm ${d.id}\`)`);
    return [...questions, ...proposals];
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
    console.log(`${model.slug} — goal: ${model.goal ?? "(not set)"}`);
    console.log(`work: ${countLine(model.works)}`);
    console.log(`waiting on you: ${model.openQuestions.length + model.decisions.filter((d) => d.status === "proposed" && !d.expired).length}`);
    console.log(model.health.length === 0 ? "health: ok" : `health: ${model.health.join("; ")}`);
}

function printWorkspaceOverview(ctx: CliContext): void
{
    const registry = readRegistry(ctx.storeDir);
    if (registry.length === 0)
    {
        console.log("no projects registered — run `self project add` inside a project directory");
        return;
    }
    for (const entry of registry)
    {
        const model = modelWithVerdicts(ctx.storeDir, entry.slug);
        const health = model.health.length === 0 ? "" : ` [${model.health.length} health signal(s)]`;
        console.log(`${entry.slug} — ${model.goal ?? "(no goal)"} (${countLine(model.works)})${health}`);
    }
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
        const blocked = work.status === "blocked" ? ` (on ${work.blockedOn})` : "";
        const reports = work.reports.length > 0 ? `  — ${work.reports.length} report(s), see \`self work show ${work.id}\`` : "";
        console.log(`${work.id}  ${work.status}${blocked}  ${work.outcome}${reports}`);
    }
    const done = model.works.length - open.length;
    if (done > 0)
    {
        console.log(`(${done} done — see log)`);
    }
}

export function printLog(ctx: CliContext & { project: string }, limit: number): void
{
    const events = readEvents(ctx.storeDir, ctx.project);
    for (const event of events.slice(-limit))
    {
        console.log(`${event.ts}  ${event.type}  [${event.id}]  ${eventSummary(event)}`);
    }
}
