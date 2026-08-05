import { EntityState, isCurrent, orderEntities, pendingSummary } from "./entities.js";
import { judgeProcess } from "./ledger.js";
import { eventSummary, readEvents } from "./logfile.js";
import {
    AttentionRow,
    ATTENTION_ORDER,
    branchLabel,
    BranchUnshipped,
    branchTotals,
    buildModel,
    otherGoals,
    ProjectModel,
    WaitingItem,
    WorkState
} from "./model.js";
import { contributionsOf, openObjectives, openProposals } from "./objectives.js";
import { CliContext, ProjectScope, readRegistry, readStoreConfig, readVerdicts, tokenScale, TokenScale } from "./paths.js";
import {
    AttemptRow,
    Pointer,
    RenderMode,
    renderContext,
    renderStatus,
    renderWorkList,
    renderWorkspace,
    scoped,
    shellArgument,
    pointerTo,
    workspacePointer
} from "./pretty.js";
import { artifactSignals, verdictSignals } from "./reachability.js";
import { blue, charactersFor, countCharacters, dim, displayWidth, fit, green, oneLine, plural, red, styled, takeCharacters, termWidth, yellow } from "./style.js";
import { SelfEvent } from "./types.js";

// What one piped render may spend (#213). A cap measures what a store may
// hold; this measures what a single render costs the reader it is handed to,
// which is why the index cap is the larger of the two.
const CONTEXT_TOKENS = 3_000;

// The budget as the fitting code charges it. The rows are cut in characters —
// one physical counter, as `style.ts` requires — so the token budget is
// converted to its character allowance once, here. The command writes one
// final newline; the rendered body owns the rest.
function contextBodyLimit(scale: TokenScale): number
{
    return charactersFor(CONTEXT_TOKENS, scale.perCharacter) - 1;
}
const REPORT_EXCERPT_LIMIT = 500;

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
// 3,000-token cap exists to fit an agent's context window, and inflating
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
        writeContext(renderWorkspaceContext(models, contextBodyLimit(tokenScale(readStoreConfig(ctx.storeDir)))));
        return;
    }
    const model = modelWithVerdicts(ctx.storeDir, ctx.project);
    if (render === "pretty")
    {
        console.log(renderContext({ model, waiting: unrankedWaitingLines(model) }).join("\n"));
        return;
    }
    writeContext(renderProjectContext(model, contextBodyLimit(tokenScale(readStoreConfig(ctx.storeDir))), foreignWorkspaceEntities(ctx)));
}

// A workspace-scoped entity renders in every project's context (#197 §3,
// #207 D1) while its events stay in its home store — so the collect step
// reads every other registered project's fold and carries only the
// workspace-scoped, current records into this render.
function foreignWorkspaceEntities(ctx: CliContext): EntityState[]
{
    return readRegistry(ctx.storeDir)
        .filter((entry) => entry.slug !== ctx.project)
        .flatMap((entry) => buildModel(ctx.storeDir, entry.slug, new Date()).entities)
        .filter((entity) => entity.scope === "workspace" && entity.status === "confirmed" && isCurrent(entity));
}

// The placement projection (#197 §6, #202): collect the live entities, order
// them by priority, render each by its exposure — full text, one line, or
// absent with a pointer — and anchor the derived live state directly after
// the full-exposure block, before the index lines. One rule replaces the
// hardcoded section order and the degradation ladder: render in priority
// order until the budget is spent, then pointer rows.
interface ContextSection
{
    header?: string;
    rows: string[];
    omission: (count: number) => string;
}

function renderProjectContext(model: ProjectModel, limit: number, foreign: EntityState[] = []): string
{
    const project = shellArgument(model.slug);
    // Collect is scope-aware (#197 §6): this project's current records plus
    // every other store's workspace-scoped ones, in one priority ordering —
    // workspace and project entities interleave rather than sectioning. Work
    // records are deliberately absent: the derived live state below is the
    // render a work unit gets (#197 §7 — "live state shows the active ones").
    const placed = orderEntities([
        ...model.entities.filter((item) => item.status === "confirmed" && isCurrent(item)),
        ...foreign
    ].filter((item) => item.source !== "work"));
    const sections = [
        descriptionSection(model, project),
        fullSection(placed, project),
        ...liveSections(model, project),
        indexSection(placed, project)
    ];
    return fitContext([`# ${model.slug}`, ""], sections, limit);
}

function descriptionSection(model: ProjectModel, project: string): ContextSection
{
    return {
        rows: model.description === undefined ? [] : [model.description],
        omission: () => `description omitted; run \`${pointerTo({ verb: "search" }, project)}\``
    };
}

function fullSection(placed: EntityState[], project: string): ContextSection
{
    return {
        rows: placed.filter((item) => item.exposure === "full").map(fullEntityRow),
        omission: (count) => `- … ${plural(count, "full-exposure entity", "full-exposure entities")} omitted; run \`${scoped("self state", project)}\``
    };
}

// Full exposure is the whole record: text as recorded, the deadline it
// carries, and its rationale. No id — the pointer rows and `state list` carry
// those — so the block reads as direction, not as a table.
function fullEntityRow(entity: EntityState): string
{
    const target = entity.target === undefined ? "" : ` (target ${entity.target})`;
    const why = entity.why === undefined ? "" : ` — ${entity.why}`;
    return `- ${entityLabel(entity)}${entity.text}${target}${why}`;
}

function indexEntityRow(entity: EntityState): string
{
    const why = entity.why === undefined ? "" : ` — ${entity.why}`;
    return `- ${entityLabel(entity)}${oneLine(entity.text)}${oneLine(why)}`;
}

function entityLabel(entity: EntityState): string
{
    return entity.labels.length === 0 ? "" : `[${entity.labels.join(", ")}] `;
}

// The index block: one line per entity, and the search tier absent by design
// — a count and the command that lists it is all search exposure renders.
function indexSection(placed: EntityState[], project: string): ContextSection
{
    const searchable = placed.filter((item) => item.exposure === "search").length;
    const rows = placed.filter((item) => item.exposure === "index").map(indexEntityRow);
    if (searchable > 0)
    {
        rows.push(`- ${plural(searchable, "entity", "entities")} at search exposure; run \`${scoped("self state", project)}\``);
    }
    return {
        header: "## Index",
        rows,
        omission: (count) => `- … ${plural(count, "index row")} omitted; run \`${scoped("self state", project)}\``
    };
}

// The derived live state (#197 §6, user-ruled 2026-08-03): what is moving and
// what waits on a person, anchored between the full block and the index lines
// — even when the full block is empty. Engine-owned: nothing here is asserted
// or placed, so its internal order is fixed.
function liveSections(model: ProjectModel, project: string): ContextSection[]
{
    return [
        {
            header: "## Work in progress",
            rows: [...inProgressLines(model), ...otherOpenRows(model, project)],
            omission: (count) => `- … ${plural(count, "work item")} omitted; run \`${scoped("self work", project)}\``
        },
        {
            header: "## Waiting on you",
            rows: [...waitingItems(model).map((item) => `- ${item.full}`), ...entityWaitingRows(model)],
            omission: (count) => `- … ${plural(count, "waiting item")} omitted; run \`${scoped("self status", project)}\``
        },
        {
            header: "## Deadlines",
            rows: deadlineRows(model),
            omission: (count) => `- … ${plural(count, "deadline")} omitted; run \`${scoped("self state", project)}\``
        },
        {
            header: "## Unshipped by branch",
            rows: unshippedLines(model),
            omission: (count) => `- … ${plural(count, "branch", "branches")} omitted; run \`${scoped("self work", project)}\``
        },
        {
            header: "## Health",
            rows: model.health.map((signal) => `- ${signal}`),
            omission: (count) => `- … ${plural(count, "health signal")} omitted; run \`${scoped("self status", project)}\``
        }
    ];
}

// Work in progress and approval waits render as full rows; all other open
// work is a count with the command that lists it (#197 §6, #205 table C) —
// including a unit blocked on a dependency or an external wait, which is
// parked, not moving, and not waiting on the reader. A unit blocked on a
// decision is excluded here because it renders as a full waiting row.
function otherOpenRows(model: ProjectModel, project: string): string[]
{
    const other = model.works.filter((work) => work.status === "next"
        || (work.status === "blocked" && work.blockedOn !== "decision")).length;
    return other === 0 ? [] : [`- ${plural(other, "more open work item")}; run \`${scoped("self work", project)}\``];
}

// The entity grammar's own approval waits: a proposed entity, and a placement
// proposal pending on a confirmed one. Each row carries the confirm command,
// so the paired proposed-add and proposed-demotion an agent recorded past a
// cap are both actionable from this render alone — the demotion's why names
// the record it admits.
function entityWaitingRows(model: ProjectModel): string[]
{
    const rows: string[] = [];
    for (const entity of model.entities)
    {
        if (entity.status === "proposed" && entity.source === undefined)
        {
            rows.push(`- proposed entity ${entity.id}: ${oneLine(entity.text)} (confirm with \`self state confirm ${entity.id}\`)`);
        }
        else if (entity.status === "confirmed" && entity.pending !== undefined)
        {
            rows.push(`- proposed placement of ${entity.id}: ${pendingSummary(entity.pending)} (confirm with \`self state confirm ${entity.id}\`)`);
        }
    }
    return rows;
}

// Deadlines derive from the reserved `target` metadata over the live set,
// soonest first. The date renders as recorded — judging it against today is
// the health signals' job, so this projection is stable for a given log.
function deadlineRows(model: ProjectModel): string[]
{
    return model.entities
        .filter((item) => item.status === "confirmed" && isCurrent(item) && item.target !== undefined)
        .sort((left, right) => (left.target ?? "").localeCompare(right.target ?? "") || left.id.localeCompare(right.id))
        .map((item) => `- ${item.target}: ${entityLabel(item)}${oneLine(item.text)}`);
}

// Full rows for the work actually moving, and nothing else (#205 table C): a
// unit blocked on a dependency or an external wait left this block for the
// open-work count, and a unit blocked on a decision renders under "waiting".
function inProgressLines(model: ProjectModel): string[]
{
    const project = shellArgument(model.slug);
    return model.works.filter((w) => w.status === "active").map((work) =>
    {
        const latest = [...work.reports].sort(compareDated).at(-1);
        const report = latest === undefined ? "" : reportExcerpt(latest.text, work.id, project);
        const next = work.next === undefined ? "" : ` (next: ${work.next})`;
        const toward = contributionsOf(model.goals, work).map((item) => item.id).join(", ");
        return `- ${work.id} ${work.outcome}${toward === "" ? "" : ` [toward ${toward}]`}${report}${next}`;
    });
}

// A report can be pages; its row carries a bounded excerpt and the command
// that prints it whole. Fixed at 500 characters rather than derived from the
// budget: the budget now cuts whole rows, and a row that survives should read
// the same however full the context is.
function reportExcerpt(text: string, work: string, project: string): string
{
    const recovery = `\`${pointerTo({ verb: "work-show", id: work }, project)}\``;
    const normalized = text.trim().replace(/\s+/g, " ");
    const excerpt = takeCharacters(normalized, REPORT_EXCERPT_LIMIT);
    const ellipsis = countCharacters(normalized) > REPORT_EXCERPT_LIMIT ? "…" : "";
    return ` — latest report: ${excerpt}${ellipsis} (full: ${recovery})`;
}

/* ── fitting the budget ────────────────────────────────────────────── */

function sectionLines(section: ContextSection, keep: number): string[]
{
    if (section.rows.length === 0)
    {
        return [];
    }
    const omitted = section.rows.length - keep;
    const rows = [...section.rows.slice(0, keep), ...(omitted > 0 ? [section.omission(omitted)] : [])];
    return [...(section.header === undefined ? [] : [section.header, ""]), ...rows, ""];
}

function assembleContext(head: string[], sections: ContextSection[], keeps: number[]): string
{
    return [...head, ...sections.flatMap((section, index) => sectionLines(section, keeps[index]))]
        .join("\n").replace(/\n+$/, "");
}

// The budget is spent from the top, so rows leave from the bottom section
// upward — the lowest-priority rendering first — each cut section collapsing
// to one pointer row that counts what it holds and names the recovery
// command. A row that does not fit whole is never truncated: it joins the
// counted omission instead, and the pointer recovers it intact.
function fitContext(head: string[], sections: ContextSection[], limit: number): string
{
    const keeps = sections.map((section) => section.rows.length);
    let rendered = assembleContext(head, sections, keeps);
    for (let index = sections.length - 1; index >= 0 && countCharacters(rendered) > limit; index--)
    {
        while (keeps[index] > 0 && countCharacters(rendered) > limit)
        {
            keeps[index] -= 1;
            rendered = assembleContext(head, sections, keeps);
        }
    }
    return rendered;
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
        recovery: { verb: "search", id: row.decision, type: "decision" }
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
        : `${named.join(", ")}, +${hidden} more; run \`${scoped("self context", shellArgument(model.slug))}\``;
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
        recovery: { verb: "search", id: proposal.id.slice(0, 8) }
    }));
}

function compareDated(left: { ts: string; id: string }, right: { ts: string; id: string }): number
{
    return left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id);
}

function detail(text: string, limit: number, recovery: Pointer): string
{
    if (!Number.isFinite(limit) || countCharacters(text) <= limit)
    {
        return text;
    }
    return `${takeCharacters(text.trim().replace(/\s+/g, " "), limit)}… (full: \`${recovery}\`)`;
}

// Each line is tried with the omission notice that would follow it, because
// the notice costs characters too and a line kept without room for it would
// push the render past the budget.
function keptWithinLimit(models: ProjectModel[], limit: number): string[]
{
    const kept: string[] = [];
    for (let index = 0; index < models.length; index++)
    {
        const next = [...kept, workspaceContextLine(models[index])];
        const omitted = models.length - index - 1;
        if (omitted > 0)
        {
            next.push(workspaceOmission(omitted));
        }
        if (countCharacters(next.join("\n")) > limit)
        {
            break;
        }
        kept.push(workspaceContextLine(models[index]));
    }
    return kept;
}

function renderWorkspaceContext(models: ProjectModel[], limit: number): string
{
    if (models.length === 0)
    {
        return "no projects registered — run `self project add` inside a project directory";
    }
    const full = models.map(workspaceContextLine).join("\n");
    if (countCharacters(full) <= limit)
    {
        return full;
    }
    const kept = keptWithinLimit(models, limit);
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
    const goal = detail((model.goal ?? "(no goal)") + otherGoals(model), 500, workspacePointer("self status"));
    return `${model.slug} — ${goal} (${countLine(model.works)})${health}`;
}

function workspaceOmission(count: number): string
{
    // The workspace's own omission, not a project's: `self status` here is the
    // command being pointed at, which is why this function and
    // workspaceContextLine are the two names the scope-pointer review exempts.
    const recovery = "self status";
    return `… ${count} project summar${count === 1 ? "y" : "ies"} omitted; run \`${recovery}\` from the workspace for the full summaries`;
}

function writeContext(text: string): void
{
    process.stdout.write(text + "\n");
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
            attempts: openProcesses(ctx.project, model)
        }).join("\n"));
        return;
    }
    console.log(`${model.slug} — goal: ${(model.goal ?? "(not set)") + otherGoals(model)}`);
    console.log(`work: ${countLine(model.works)}`);
    console.log(`objectives: ${objectiveCountLine(model)}`);
    console.log(`waiting on you: ${waitingCount(model)}`);
    console.log(`unshipped: ${unshippedLine(model)}`);
    if (attentionRows(model).length > 0)
    {
        console.log(attentionLine(model));
    }
    console.log(model.health.length === 0 ? "health: ok" : `health: ${model.health.join("; ")}`);
    printProcesses(ctx.project, model);
}

// Process state on an open unit, judged at read time: the folded transition
// is the synced truth, and the machine ledger refines running into stale
// where this machine recorded the pid. A closed unit's process is history a
// report already carries, so only open units speak here.
function openProcesses(project: string, model: ProjectModel): AttemptRow[]
{
    const rows: AttemptRow[] = [];
    for (const work of model.works.filter((item) => item.status === "active" || item.status === "blocked"))
    {
        const judged = judgeProcess(project, work.id, work.process);
        if (judged !== null)
        {
            rows.push({ attempt: judged, work: work.id, state: judged.split(" ")[0] });
        }
    }
    return rows;
}

function printProcesses(project: string, model: ProjectModel): void
{
    for (const row of openProcesses(project, model))
    {
        console.log(`process ${row.work}: ${row.attempt}`);
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

function waitingCount(model: ProjectModel): number
{
    return model.openQuestions.length + attentionRows(model).length + openProposals(model.goals).length;
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
        console.log(`${model.slug} — ${(model.goal ?? "(no goal)") + otherGoals(model)} (${countLine(model.works)})${health}`);
    }
}

function countLine(works: WorkState[]): string
{
    const count = (status: string): number => works.filter((w) => w.status === status).length;
    const retired = count("retired");
    return `${count("active")} active, ${count("blocked")} blocked, ${count("next")} next, ${count("done")} done`
        + (retired > 0 ? `, ${retired} retired` : "");
}

export function printWorkList(ctx: ProjectScope, render: RenderMode): void
{
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const project = shellArgument(model.slug);
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
        console.log(plainWorkLine(work, contributionsOf(model.goals, work).map((item) => item.id).join(", "), project));
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

function plainWorkLine(work: WorkState, toward: string, project: string): string
{
    const blocked = work.status === "blocked" ? ` (on ${work.blockedOn})` : "";
    const reports = work.reports.length > 0
        ? `  — ${work.reports.length} report(s), see \`${pointerTo({ verb: "work-show", id: work.id }, project)}\`` : "";
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

export function printLog(ctx: ProjectScope, limit: number): void
{
    for (const event of readEvents(ctx.storeDir, ctx.project).slice(-limit))
    {
        console.log(logLine(event, undefined));
    }
}

// Every registered project's events on one timeline, newest last, cut to the
// limit after the merge rather than before it: the ask is the workspace's last
// N events, not the last N of each project pasted together. The slug leads
// each line as it does in `self search`, because a merged log that says what
// happened without saying where is not readable.
export function printWorkspaceLog(scopes: ProjectScope[], limit: number): void
{
    const merged = scopes.flatMap((scope) => readEvents(scope.storeDir, scope.project)
        .map((event) => ({ event, slug: scope.project })));
    merged.sort((left, right) => compareDated(left.event, right.event));
    for (const item of merged.slice(-limit))
    {
        console.log(logLine(item.event, item.slug));
    }
}

// One event, styled for a terminal and plain for everything else. The plain
// form is the machine contract, so the project column appears only in the
// workspace form — the surface where a line without it is ambiguous.
function logLine(event: SelfEvent, slug: string | undefined): string
{
    if (!styled)
    {
        return `${slug === undefined ? "" : slug + "  "}${event.ts}  ${event.type}  [${event.id}]  ${eventSummary(event)}`;
    }
    const lead = slug === undefined ? 0 : displayWidth(slug) + 2;
    const ts = event.ts.slice(5, 16).replace("T", " ");
    const summary = fit(eventSummary(event).split("\n", 1)[0], Math.max(20, termWidth() - 37 - lead - event.id.length));
    return `${slug === undefined ? "" : dim(slug + "  ")}${dim(ts)}  ` +
        `${eventStyle(event.type)(event.type.padEnd(18))}  ${summary}  ${dim(`[${event.id}]`)}`;
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
