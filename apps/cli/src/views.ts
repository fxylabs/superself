import { AttemptStatus, listSpools } from "./attempt/spool.js";
import { ChangeSet, openChangeSets } from "./integration.js";
import { eventSummary, readEvents } from "./logfile.js";
import {
    AttentionRow,
    ATTEMPT_FAILURE_DAYS,
    ATTENTION_ORDER,
    branchLabel,
    BranchUnshipped,
    branchTotals,
    buildModel,
    ProjectModel,
    WaitingItem,
    WorkState
} from "./model.js";
import { contributionsOf, openObjectives, openProposals } from "./objectives.js";
import { CliContext, readRegistry, readVerdicts } from "./paths.js";
import { AttemptRow, RenderMode, renderContext, renderStatus, renderWorkList, renderWorkspace } from "./pretty.js";
import { artifactSignals, verdictSignals } from "./reachability.js";
import { blue, dim, fit, green, plural, red, styled, termWidth, yellow } from "./style.js";

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

// Console surfaces reuse the verdicts persisted by the last fold, so they
// agree with canonical state without re-running git. Artifacts are re-checked
// here instead: the store holds the bytes, so the answer never depends on
// which project checkout this command ran from.
function modelWithVerdicts(storeDir: string, slug: string): ProjectModel
{
    const model = buildModel(storeDir, slug, new Date());
    model.health.push(...verdictSignals(model.works, readVerdicts(storeDir, slug)), ...artifactSignals(storeDir, model.works));
    return model;
}

// The pretty render is reached before the budget, never through it: the
// 12,000-character cap exists to fit an agent's context window, and inflating
// it with box rules and escape sequences would spend the agent's budget on
// decoration it never receives.
export function printContext(ctx: CliContext, render: RenderMode): void
{
    if (ctx.project === undefined)
    {
        const models = readRegistry(ctx.storeDir).map((entry) => modelWithVerdicts(ctx.storeDir, entry.slug));
        if (render === "pretty" && models.length > 0)
        {
            console.log(renderWorkspace(models).join("\n"));
            return;
        }
        writeContext(renderWorkspaceContext(models));
        return;
    }
    const model = modelWithVerdicts(ctx.storeDir, ctx.project);
    if (render === "pretty")
    {
        console.log(renderContext({ model, waiting: unrankedWaitingLines(model) }).join("\n"));
        return;
    }
    writeContext(renderProjectContext(model));
}

function renderProjectContext(model: ProjectModel): string
{
    const confirmed = confirmedDecisionLines(model);
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
    return renderProject(model, fillDecisions(model, options, confirmed));
}

function confirmedDecisionLines(model: ProjectModel): string[]
{
    return [...model.decisions]
        .filter((decision) => decision.status === "confirmed")
        .sort(compareDated)
        .map((decision) => `- ${decision.text}${decision.why === undefined ? "" : ` — ${decision.why}`}`);
}

// Report excerpts and the non-decision sections claim their space first.
// Decisions then enter newest-first until the next whole decision would
// cross the cap. Selected decisions retain their original chronological
// order in the rendered section.
function fillDecisions(model: ProjectModel, options: ProjectContextOptions, confirmed: string[]): ProjectContextOptions
{
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
    return options;
}

function renderProject(model: ProjectModel, options: ProjectContextOptions): string
{
    const project = shellArgument(model.slug);
    const lines: string[] = [`# ${model.slug}`, ""];
    if (model.description !== undefined)
    {
        lines.push(detail(model.description, options.detailLimit, `self search --project ${project}`), "");
    }
    lines.push(`Goal: ${detail(model.goal ?? "(not set)", options.detailLimit, `self search --project ${project}`)}`, "");
    pushList(lines, "Objectives", options.compactOptional
        ? countedOmission(openObjectives(model.goals).length, "open objective", "self objective")
        : objectiveLines(model));
    pushList(lines, "Decisions", decisionLines(options.decisions, options.omittedDecisions, "self search --type decision"));
    pushList(lines, "Conventions", model.conventions.map((convention) =>
        `- ${detail(convention.text, options.detailLimit, `self search ${convention.id} --type convention --project ${project}`)}`));
    pushList(lines, "Integration train", options.compactOptional
        ? countedOmission(openChangeSets(model.integration).length, "open change set", "self integration plan")
        : trainLines(model));
    pushList(lines, "Work in progress", inProgressLines(model, options.reportExcerpt, options.detailLimit));
    pushList(lines, "Unshipped by branch", options.compactOptional ? unshippedCountLines(model) : unshippedLines(model));
    pushList(lines, "Waiting on you", [
        ...options.compactOptional ? attentionOmission(model) : [],
        ...waitingItems(model).map((item) => `- ${detail(item.full, options.detailLimit, item.recovery)}`)
    ]);
    const next = model.works.filter((work) => work.status === "next");
    pushList(lines, "Next", options.compactOptional
        ? countedOmission(next.length, "next work item", "self work")
        : next.map((work) => `- ${work.id} ${detail(work.outcome, options.detailLimit, `self work show ${work.id}`)}`));
    pushList(lines, "Health", options.compactOptional
        ? countedOmission(model.health.length, "health signal", "self status")
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
    const project = shellArgument(model.slug);
    const recovery = `self search --project ${project}`;
    const lines: string[] = [`# ${model.slug}`, ""];
    if (model.description !== undefined)
    {
        lines.push(`Description: omitted; run \`${recovery}\``, "");
    }
    lines.push(`Goal: omitted; run \`${recovery}\``, "");
    pushList(lines, "Objectives", countedOmission(openObjectives(model.goals).length, "open objective", "self objective"));
    pushList(lines, "Decisions", decisionLines(decisions, omittedDecisions, `self search --type decision --project ${project}`));
    pushList(lines, "Conventions", [...model.conventions]
        .sort(compareDated)
        .map((convention) => `- convention ${convention.id}; run \`self search ${convention.id} --type convention --project ${project}\``));
    pushList(lines, "Integration train", countedOmission(openChangeSets(model.integration).length, "open change set", "self integration plan"));
    const progressing = [...model.works]
        .filter((work) => work.status === "active" || (work.status === "blocked" && work.blockedOn !== "decision"))
        .sort((left, right) => left.id.localeCompare(right.id));
    pushList(lines, "Work in progress", progressing.map((work) =>
        `- ${work.status} work ${work.id}; run \`self work show ${work.id}\``));
    pushList(lines, "Unshipped by branch", unshippedCountLines(model));
    pushList(lines, "Waiting on you", [
        ...attentionOmission(model),
        ...waitingItems(model).map((item) => `- ${item.identity}; run \`${item.recovery}\``)
    ]);
    pushList(lines, "Next", countedOmission(model.works.filter((work) => work.status === "next").length, "next work item", "self work"));
    pushList(lines, "Health", countedOmission(model.health.length, "health signal", "self status"));
    return lines.join("\n").replace(/\n+$/, "");
}

// The selected decisions, preceded by the omission row that names how many
// confirmed decisions the budget left out and the command that pulls them.
function decisionLines(selected: string[], omitted: number, recovery: string): string[]
{
    const lines = [...selected];
    if (omitted > 0)
    {
        lines.unshift(`- … ${omitted} confirmed decision${omitted === 1 ? "" : "s"} omitted; run \`${recovery}\``);
    }
    return lines;
}

// Once the budget starts cutting rows short, a row can no longer be trusted to
// carry its own group, so the band is stated once as counts. Nothing is hidden:
// every proposal still has its row, and this says where to read the ranking
// back in full.
function attentionOmission(model: ProjectModel): string[]
{
    return attentionRows(model).length === 0 ? [] : [`- ${attentionLine(model)}; run \`self status\``];
}

// One omission row for a section the budget treats as optional: the count and
// the command that prints the section in full, or no row when there is
// nothing to omit.
function countedOmission(count: number, noun: string, recovery: string): string[]
{
    if (count === 0)
    {
        return [];
    }
    return [`- … ${count} ${noun}${count === 1 ? "" : "s"} omitted; run \`${recovery}\``];
}

// If even one identity-and-pointer row per protected item cannot fit, listing
// a prefix would silently privilege log order. Aggregate every protected
// category instead and say exactly where the complete canonical state lives.
function renderAggregateProject(model: ProjectModel): string
{
    const active = model.works.filter((work) => work.status === "active").length;
    const blocked = model.works.filter((work) => work.status === "blocked").length;
    const waiting = waitingItems(model).length;
    const project = shellArgument(model.slug);
    const recovery = `self search --project ${project}`;
    return [
        `# ${takeCharacters(model.slug, 200)}`,
        "",
        `Protected context is larger than ${CONTEXT_LIMIT.toLocaleString("en-US")} characters even as identity rows.`,
        `- description/goal: run \`${recovery}\``,
        `- ${model.conventions.length} convention${model.conventions.length === 1 ? "" : "s"}: run \`${recovery}\``,
        `- ${active} active and ${blocked} blocked work item${active + blocked === 1 ? "" : "s"}: run \`self work\``,
        `- ${plural(model.unshipped.length, "branch", "branches")} carrying unshipped open work: run \`self work\``,
        `- ${waiting} waiting item${waiting === 1 ? "" : "s"}: run \`${recovery}\``,
        `- decisions: run \`self search --type decision --project ${project}\``
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
        const candidate = renderProject(model, { ...options, detailLimit: middle, compactOptional: true });
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

// What an agent must read before it touches a repository: whose turn it is in
// the lane, and the exact prerequisite standing between each item and merge.
function trainLines(model: ProjectModel): string[]
{
    const lines: string[] = [];
    for (const repository of model.integration.repositories)
    {
        const open = repository.train
            .map((id) => model.integration.changeSets.find((item) => item.id === id))
            .filter((item): item is ChangeSet => item !== undefined && item.closed === undefined && item.merge === undefined);
        if (open.length === 0)
        {
            continue;
        }
        const lease = repository.lease;
        lines.push(`- ${repository.name} — ${lease !== undefined && lease.live
            ? `lease held by ${lease.holder} at fence ${lease.fence}` : "no live integration lease"}` +
            `${repository.integrationBranch === undefined
                ? "" : `, merges into ${repository.integrationBranch}; only promotion into main takes a human approval`}`);
        for (const changeSet of open)
        {
            lines.push(`  - ${changeSet.order + 1}. ${changeSet.id}${changeSet.pr === undefined ? "" : ` #${changeSet.pr}`} — ` +
                `${changeSet.phase}: ${changeSet.reason}`);
            lines.push(`    next: ${changeSet.next}`);
        }
    }
    return lines;
}

function inProgressLines(model: ProjectModel, reportLimit: number, detailLimit: number): string[]
{
    const active = model.works.filter((w) => w.status === "active").map((work) =>
    {
        const latest = [...work.reports].sort(compareDated).at(-1);
        const outcome = detail(work.outcome, detailLimit, `self work show ${work.id}`);
        const report = latest === undefined ? "" : reportExcerpt(latest.text, work.id, reportLimit);
        const next = work.next === undefined ? "" : ` (next: ${detail(work.next, detailLimit, `self work show ${work.id}`)})`;
        const toward = contributionsOf(model.goals, work).map((item) => item.id).join(", ");
        return `- ${work.id} ${outcome}${toward === "" ? "" : ` [toward ${toward}]`}${report}${next}`;
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

// What the ruled render takes: the same items the plain render sentences,
// minus the live proposals. Those are the attention band, which that render
// groups into its own tables — listing them here as well would print every
// proposal twice.
function unrankedWaitingLines(model: ProjectModel): string[]
{
    return [...model.waiting, ...workProposalItems(model)].map((item) => item.full);
}

function waitingItems(model: ProjectModel): WaitingItem[]
{
    return [...model.waiting, ...proposalItems(model), ...workProposalItems(model)];
}

function attentionRows(model: ProjectModel): AttentionRow[]
{
    return ATTENTION_ORDER.flatMap((group) => model.attention[group]);
}

// The band the model computed, one row per proposal. The group stands ahead of
// the text because the budget truncates from the end and the truncation carries
// its own recovery command: what a shortened row must keep is the ranking, not
// the id a reader can already pull from the pointer beside it.
function proposalItems(model: ProjectModel): WaitingItem[]
{
    const project = shellArgument(model.slug);
    return attentionRows(model).map((row): WaitingItem => ({
        full: `proposal [${attentionLabel(row)}]: ${row.text}`
            + ` (confirm with \`self decide confirm ${row.decision}\`)`,
        identity: `proposal ${row.decision}`,
        recovery: `self search ${row.decision} --type decision --project ${project}`
    }));
}

function attentionLabel(row: AttentionRow): string
{
    if (row.group === "inEffect")
    {
        return `already in effect: ${row.blocks.join(", ")} landed`;
    }
    if (row.group === "undecidable")
    {
        return `cannot be decided yet: ${row.flags.join("; ")}`;
    }
    return row.blocks.length === 0
        ? "no work recorded as gated"
        : `confirming unblocks ${row.blocks.join(", ")}`;
}

// The whole band in one line, for the surfaces that report counts rather than
// rows — and for the compacted context, where it is the honest remainder of a
// grouping that no longer fits.
function attentionLine(model: ProjectModel): string
{
    return `decisions waiting: ${model.attention.unblocks.length} unblock work, `
        + `${model.attention.undecidable.length} cannot be decided yet, `
        + `${model.attention.inEffect.length} already in effect`;
}

// What each branch is still carrying, one line per branch. Commits are counted
// rather than listed: the hashes are what `self work show` prints, and a reader
// deciding what to push needs the branch and the units on it.
function unshippedLines(model: ProjectModel): string[]
{
    return model.unshipped.map((branch) =>
    {
        const units = branch.unshipped.map((item) =>
            `${item.work} (${item.unsettled} of ${plural(item.evidence, "commit")} unsettled, ${item.status})`);
        return `- ${branchLabel(branch)} — ${unitCount(branch)} unshipped: ${units.join(", ")}`;
    });
}

// The honest remainder once the budget stops paying for whole rows: the same
// per-branch counts, and the command that reads the units back. Nothing is
// hidden — the branches themselves are still named.
function unshippedCountLines(model: ProjectModel): string[]
{
    return model.unshipped.map((branch) => `- ${branchLabel(branch)} — ${unitCount(branch)} unshipped; run \`self work\``);
}

// The whole statement in one line, for the surfaces that report counts rather
// than rows. Bounded, because this list only ever grows: a branch leaves it by
// having its evidence settle, and nothing ages a branch out. An unbounded join
// would turn one status line into a paragraph on a project a year in.
const STATUS_BRANCHES = 4;

function unshippedLine(model: ProjectModel): string
{
    if (model.unshipped.length === 0)
    {
        return "nothing waiting to ship";
    }
    const named = model.unshipped.slice(0, STATUS_BRANCHES)
        .map((branch) => `${branchLabel(branch)} ${unitCount(branch)}`);
    const hidden = model.unshipped.length - named.length;
    return hidden === 0
        ? named.join(", ")
        : `${named.join(", ")}, +${hidden} more; run \`self context\``;
}

// Counted as open work wherever it is printed, because that is the scope the
// model derives: the units whose verdicts every fold rechecks. A reader who
// sees "1 open work unit" is not told a branch holds nothing else.
function unitCount(branch: BranchUnshipped): string
{
    return plural(branchTotals(branch).units, "open work unit");
}

// A proposal is only actionable if the reader can weigh it, so the whole brief
// travels with it rather than an outcome line pointing at a page.
function workProposalItems(model: ProjectModel): WaitingItem[]
{
    const project = shellArgument(model.slug);
    return openProposals(model.goals).map((proposal): WaitingItem => ({
        full: [
            `work proposal ${proposal.id.slice(0, 8)}: ${proposal.outcome}`,
            `  toward ${proposal.milestone ?? proposal.objective} · value: ${proposal.value}`,
            `  success: ${proposal.success.join("; ")} · stop: ${proposal.stop.join("; ")}`,
            `  depends: ${proposal.depends.length === 0 ? "nothing" : proposal.depends.join(", ")} · risk: ${proposal.risk}`,
            `  capacity: ${proposal.capacity} · evidence plan: ${proposal.evidencePlan}`,
            `  confidence: ${proposal.confidence} · expires ${proposal.expires} — \`self work accept ${proposal.id.slice(0, 8)}\``
        ].join("\n"),
        identity: `work proposal ${proposal.id.slice(0, 8)}`,
        recovery: `self search ${proposal.id.slice(0, 8)} --project ${project}`
    }));
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

function renderWorkspaceContext(models: ProjectModel[]): string
{
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

// Context recovery commands are pasted into POSIX shells. Always quote a
// project slug as one literal argument; the '"'"' sequence is the portable
// way to embed a single quote inside a single-quoted shell word.
function shellArgument(value: string): string
{
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function printStatus(ctx: CliContext, render: RenderMode): void
{
    if (ctx.project === undefined)
    {
        printWorkspaceOverview(ctx, render);
        return;
    }
    const model = modelWithVerdicts(ctx.storeDir, ctx.project);
    if (render === "pretty")
    {
        console.log(renderStatus({
            model,
            waiting: unrankedWaitingLines(model),
            objectives: objectiveCountLine(model),
            integration: integrationCountLine(model),
            attempts: openAttempts(ctx.project)
        }).join("\n"));
        return;
    }
    console.log(`${model.slug} — goal: ${model.goal ?? "(not set)"}`);
    console.log(`work: ${countLine(model.works)}`);
    console.log(`objectives: ${objectiveCountLine(model)}`);
    console.log(`integration: ${integrationCountLine(model)}`);
    console.log(`waiting on you: ${waitingCount(model)}`);
    console.log(`unshipped: ${unshippedLine(model)}`);
    if (attentionRows(model).length > 0)
    {
        console.log(attentionLine(model));
    }
    console.log(model.health.length === 0 ? "health: ok" : `health: ${model.health.join("; ")}`);
    printAttempts(ctx.project);
}

// Attempt state is machine-local: it says what this machine is running right
// now, which is not something the synced store can answer. Only unfinished
// attempts are listed — a completed one has already become a report.
//
// And only recent ones. A spool lives until retention prunes it, thirty days
// by default, so without an age gate a failed attempt from three weeks ago
// keeps a line here forever — the same slow accumulation the folded model gates
// on, one surface over, and gated on the same window. `self attempt list`
// remains the surface that shows every spool.
function openAttempts(project: string): AttemptRow[]
{
    const cutoff = Date.now() - ATTEMPT_FAILURE_DAYS * 86_400_000;
    return listSpools()
        .map((spool) => spool.status())
        .filter((status): status is AttemptStatus => status !== null && status.project === project && status.state !== "completed")
        .filter((status) => new Date(status.updated).getTime() > cutoff)
        .map((status) => ({ attempt: status.attempt, work: status.work, state: status.state, failure: status.failure }));
}

function printAttempts(project: string): void
{
    for (const status of openAttempts(project))
    {
        const failure = status.failure === undefined ? "" : ` (${status.failure})`;
        console.log(`attempt ${status.attempt} ${status.work}: ${status.state}${failure}`);
    }
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
    return model.openQuestions.length + attentionRows(model).length + openProposals(model.goals).length;
}

// One line for the whole lane: how many change sets are open, which one may
// move next, and whether anything is stopped on policy rather than on work.
function integrationCountLine(model: ProjectModel): string
{
    const all = model.integration.changeSets;
    if (all.length === 0)
    {
        return "no change sets registered";
    }
    const open = openChangeSets(model.integration);
    const merged = all.filter((item) => item.phase === "merged").length;
    const ready = open.filter((item) => item.phase === "merge_ready").map((item) => item.id);
    const blocked = open.filter((item) => item.phase === "blocked_policy").map((item) => item.id);
    return `${open.length} open, ${merged} merged, ${ready.length === 0 ? "none merge_ready" : `merge_ready: ${ready.join(", ")}`}` +
        `${blocked.length === 0 ? "" : `, blocked_policy: ${blocked.join(", ")}`}`;
}

function printWorkspaceOverview(ctx: CliContext, render: RenderMode): void
{
    const registry = readRegistry(ctx.storeDir);
    if (registry.length === 0)
    {
        console.log("no projects registered — run `self project add` inside a project directory");
        return;
    }
    const models = registry.map((entry) => modelWithVerdicts(ctx.storeDir, entry.slug));
    if (render === "pretty")
    {
        console.log(renderWorkspace(models).join("\n"));
        return;
    }
    for (const model of models)
    {
        const health = model.health.length === 0 ? "" : ` [${model.health.length} health signal(s)]`;
        console.log(`${model.slug} — ${model.goal ?? "(no goal)"} (${countLine(model.works)})${health}`);
    }
}

function countLine(works: WorkState[]): string
{
    const count = (status: string): number => works.filter((w) => w.status === status).length;
    const retired = count("retired");
    return `${count("active")} active, ${count("blocked")} blocked, ${count("next")} next, ${count("done")} done`
        + (retired > 0 ? `, ${retired} retired` : "");
}

export function printWorkList(ctx: CliContext & { project: string }, render: RenderMode): void
{
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    if (render === "pretty")
    {
        console.log(renderWorkList(model).join("\n"));
        return;
    }
    const open = model.works.filter((w) => w.status !== "done" && w.status !== "retired");
    if (open.length === 0)
    {
        console.log("no open work");
    }
    for (const work of open)
    {
        console.log(plainWorkLine(work, contributionsOf(model.goals, work).map((item) => item.id).join(", ")));
    }
    const done = model.works.filter((w) => w.status === "done").length;
    if (done > 0)
    {
        console.log(`(${done} done — see log)`);
    }
    const retired = model.works.filter((w) => w.status === "retired").length;
    if (retired > 0)
    {
        console.log(`(${retired} retired — see log)`);
    }
}

function plainWorkLine(work: WorkState, toward: string): string
{
    const blocked = work.status === "blocked" ? ` (on ${work.blockedOn})` : "";
    const reports = work.reports.length > 0 ? `  — ${work.reports.length} report(s), see \`self work show ${work.id}\`` : "";
    return `${work.id}  ${work.status}${blocked}  ${work.outcome}${toward === "" ? "" : `  [toward ${toward}]`}`
        + `${gatedNote(work)}${reports}`;
}

// A unit that never started can still be gated, which is the whole point of
// inverting the relation: `blocked on decision` needs the unit to be moving
// before it can say anything, and a proposal does not wait for that.
function gatedNote(work: WorkState): string
{
    return work.gatedBy.length === 0 ? "" : `  [gated by ${work.gatedBy.join(", ")}]`;
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
