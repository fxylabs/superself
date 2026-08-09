import { EntityState, isCurrent, orderEntities, pendingSummary, rendersIn } from "./entities.js";
import { claimNote, judgeProcess } from "./ledger.js";
import { sessionToken } from "./machine.js";
import { eventRecord, eventSummary, readEvents } from "./logfile.js";
import {
    AttentionRow,
    ATTENTION_ORDER,
    branchLabel,
    BranchUnshipped,
    branchTotals,
    buildModel,
    closedRecords,
    ForeignObjectiveLink,
    foreignToward,
    otherGoals,
    ProjectModel,
    WaitingItem,
    workScope,
    WorkState
} from "./model.js";
import { contributionsOf, ObjectiveState, openObjectives, openProposals } from "./objectives.js";
import { activeProjects, archivedNote, CliContext, ProjectScope, readRegistry, readStoreConfig, readVerdicts, tokenScale, TokenScale } from "./paths.js";
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
    WaitingRow,
    workspacePointer
} from "./pretty.js";
import { artifactSignals, verdictSignals } from "./reachability.js";
import { blue, charactersFor, countCharacters, dim, displayWidth, fit, green, oneLine, plural, red, styled, takeCharacters, termWidth, yellow } from "./style.js";
import { CliError, CommandOutput, SelfEvent } from "./types.js";

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
    return withVerdicts(storeDir, renderedModel(storeDir, slug));
}

function withVerdicts(storeDir: string, model: ProjectModel): ProjectModel
{
    model.health.push(...verdictSignals(model.works, readVerdicts(storeDir, model.slug)),
        ...artifactSignals(storeDir, model.works));
    return model;
}

// The fold, as this project renders it (#181 D1/D2): its own work minus what
// moved to another project, plus every unit another project's log scoped in
// here. Nothing is copied — each unit is still the fold of the log that owns
// it, and only where it renders has changed.
function renderedModel(storeDir: string, slug: string): ProjectModel
{
    const model = buildModel(storeDir, slug, new Date());
    model.works = [
        ...scopedWorks(model, slug),
        ...foreignModels(storeDir, slug).flatMap((other) => scopedWorks(other, slug))
    ];
    return model;
}

// Every active project as it renders, from one fold each. The workspace
// surfaces answer for all of them at once, and folding per project per answer
// would cost one fold for every pair — well past #128's half-second budget. An
// archived project is not one of them (#283): it is out of the workspace answer
// until it is restored, here and in the scope resolver alike.
function renderedModels(storeDir: string): ProjectModel[]
{
    const folded = activeProjects(storeDir).map((entry) => buildModel(storeDir, entry.slug, new Date()));
    // Collected before anything is assigned: a model's own works are still the
    // fold's while the next model is reading them.
    const scoped = folded.map((model) => folded.flatMap((other) => scopedWorks(other, model.slug)));
    folded.forEach((model, index) => { model.works = scoped[index]; });
    return folded;
}

function foreignModels(storeDir: string, slug: string | undefined): ProjectModel[]
{
    return activeProjects(storeDir).filter((entry) => entry.slug !== slug)
        .map((entry) => buildModel(storeDir, entry.slug, new Date()));
}

function scopedWorks(model: ProjectModel, viewer: string): WorkState[]
{
    return model.works.filter((work) => rendersIn({ scope: workScope(model, work) }, model.slug, viewer));
}

// The pretty render is reached before the budget, never through it: the
// 3,000-token cap exists to fit an agent's context window, and inflating
// it with box rules and escape sequences would spend the agent's budget on
// decoration it never receives.
export function printContext(ctx: CliContext, render: RenderMode): void
{
    if (ctx.project === undefined)
    {
        printWorkspaceContext(ctx, render);
        return;
    }
    const model = modelWithVerdicts(ctx.storeDir, ctx.project);
    // An archived project still renders its context — a session standing in its
    // checkout has to be able to read the state it left (#283). What it owes
    // that session is one line saying the project is set aside and how it comes
    // back, on the stream the context itself is written to; a `--project` read
    // has already been told, on stderr, by the scope resolver.
    const note = archivedNote(ctx.storeDir, ctx.project);
    if (note !== null)
    {
        console.log(note);
    }
    if (render === "pretty")
    {
        console.log(renderContext({ model, waiting: unrankedWaitingRows(model) }).join("\n"));
        return;
    }
    // One fold per foreign project, read twice: for the records scoped in
    // here (#181 D2), and for what the linked foreign objectives can be said
    // to hold — status and target — at read time (#244).
    const all = [model, ...foreignModels(ctx.storeDir, ctx.project)];
    writeContext(renderProjectContext(model, contextBodyLimit(tokenScale(readStoreConfig(ctx.storeDir))),
        scopedIn(all, ctx.project), all));
}

// Every active project at once, for a directory that belongs to none of them.
// An archived project is not in this answer (#283) — it is read by naming it.
function printWorkspaceContext(ctx: CliContext, render: RenderMode): void
{
    const models = renderedModels(ctx.storeDir).map((model) => withVerdicts(ctx.storeDir, model));
    if (render === "pretty" && models.length > 0)
    {
        console.log(renderWorkspace(models).join("\n"));
        return;
    }
    writeContext(renderWorkspaceContext(models, contextBodyLimit(tokenScale(readStoreConfig(ctx.storeDir)))));
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
    // The record each row renders, positionally, where the rows are records at
    // all. Search's default membership is "live and not shown here" (#212 R1),
    // and reading it off the rows the budget kept is what keeps the two
    // surfaces from drifting apart.
    ids?: string[];
    omission: (count: number) => string;
}

function renderProjectContext(model: ProjectModel, limit: number, foreign: EntityState[] = [], all: ProjectModel[] = []): string
{
    const { head, sections } = projectContextSections(model, foreign, all);
    return assembleContext(head, sections, fitKeeps(head, sections, limit));
}

function projectContextSections(model: ProjectModel, foreign: EntityState[], all: ProjectModel[] = []): { head: string[]; sections: ContextSection[] }
{
    const project = shellArgument(model.slug);
    const linked = collectForeignObjectives(all);
    // Collect is scope-aware (#197 §6): this project's current records plus
    // every other store's workspace-scoped ones, in one priority ordering —
    // workspace and project entities interleave rather than sectioning. Work
    // records are deliberately absent: the derived live state below is the
    // render a work unit gets (#197 §7 — "live state shows the active ones").
    const placed = orderEntities([
        ...model.entities.filter((item) => item.status === "confirmed" && isCurrent(item)
            && rendersIn(item, model.slug, model.slug)),
        ...foreign
    ].filter((item) => item.source !== "work"));
    return {
        head: [`# ${model.slug}`, ""],
        sections: [
            descriptionSection(model, project),
            fullSection(placed, project),
            ...liveSections(model, project, linked),
            indexSection(placed, project)
        ]
    };
}

/* ── what a context can say about another project's objective (#244) ─ */

// The owning slug is stated by this project's own log; everything else — the
// objective's outcome, target and status — is the owner's to say, read here
// from folds already in hand. Every registered fold is keyed, the viewer's
// own included, so a slug the map does not know is a project the workspace no
// longer registers (D4).
interface ForeignObjectiveView
{
    slugs: Set<string>;
    states: Map<string, ObjectiveState>;
}

function collectForeignObjectives(all: ProjectModel[]): ForeignObjectiveView
{
    const states = new Map<string, ObjectiveState>();
    for (const model of all)
    {
        for (const objective of model.goals.objectives)
        {
            states.set(`${model.slug}/${objective.id}`, objective);
        }
    }
    return { slugs: new Set(all.map((model) => model.slug)), states };
}

// The contributing project cannot see the objective through its own
// `self objective`, so disclosure rides the toward note it already reads: the
// slug always, and the status whenever the owner moved it off active —
// dropped, superseded, reached (D1, D2, D6) — or stopped being registered at
// all (D4). A live link to a live objective stays a bare `id (slug)`.
function foreignTowardLabel(link: ForeignObjectiveLink, view: ForeignObjectiveView): string
{
    if (!view.slugs.has(link.project))
    {
        return `${link.id} (${link.project}, not registered)`;
    }
    const status = view.states.get(`${link.project}/${link.id}`)?.status ?? "unknown";
    return status === "active" ? `${link.id} (${link.project})` : `${link.id} (${link.project}, ${status})`;
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
    const full = placed.filter((item) => item.exposure === "full");
    return {
        rows: full.map(fullEntityRow),
        ids: full.map((item) => item.id),
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

// One record on one line: its labels, its text and the reason it carries. The
// index block prints it with a bullet, and `self search` prints it with the
// columns that say which project and which id (#212 T4) — one body, so a
// record cannot read two ways across the two surfaces that answer for it.
export function recordLine(entity: EntityState): string
{
    const why = entity.why === undefined ? "" : ` — ${entity.why}`;
    return `${entityLabel(entity)}${oneLine(entity.text)}${oneLine(why)}`;
}

function indexEntityRow(entity: EntityState): string
{
    return `- ${recordLine(entity)}`;
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
    const indexed = placed.filter((item) => item.exposure === "index");
    const rows = indexed.map(indexEntityRow);
    if (searchable > 0)
    {
        rows.push(`- ${plural(searchable, "entity", "entities")} at search exposure; run \`${scoped("self state", project)}\``);
    }
    return {
        header: "## Index",
        rows,
        // The trailing search-exposure count renders no record of its own, so
        // it carries no id: the tier it counts is exactly what search answers.
        ids: indexed.map((item) => item.id),
        omission: (count) => `- … ${plural(count, "index row")} omitted; run \`${scoped("self state", project)}\``
    };
}

// The derived live state (#197 §6, user-ruled 2026-08-03): what is moving and
// what waits on a person, anchored between the full block and the index lines
// — even when the full block is empty. Engine-owned: nothing here is asserted
// or placed, so its internal order is fixed.
function liveSections(model: ProjectModel, project: string, linked: ForeignObjectiveView): ContextSection[]
{
    return [
        {
            header: "## Work in progress",
            rows: [...inProgressLines(model, linked), ...otherOpenRows(model, project)],
            omission: (count) => `- … ${plural(count, "work item")} omitted; run \`${scoped("self work", project)}\``
        },
        {
            header: "## Waiting on you",
            rows: [...waitingItems(model), ...entityWaitingItems(model)].map((item) => `- ${item.full}`),
            omission: (count) => `- … ${plural(count, "waiting item")} omitted; run \`${scoped("self status", project)}\``
        },
        {
            header: "## Deadlines",
            rows: deadlineRows(model, linked),
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
//
// Waiting items rather than lines, because both renders read them now. They
// used to be built as finished text here and appended to the piped block
// alone, which left `self state confirm` — a command only a person can run —
// off the only render a person reads (#264).
function entityWaitingItems(model: ProjectModel): WaitingItem[]
{
    return model.entities.flatMap((entity) => entityWaitingItem(entity) ?? []);
}

function entityWaitingItem(entity: EntityState): WaitingItem | undefined
{
    const action = `self state confirm ${entity.id}`;
    if (entity.status === "proposed" && entity.source === undefined)
    {
        return confirmable(`proposed entity ${entity.id}: ${oneLine(entity.text)}`, entity.id, action);
    }
    if (entity.status === "confirmed" && entity.pending !== undefined)
    {
        return confirmable(`proposed placement of ${entity.id}: ${pendingSummary(entity.pending)}`, entity.id, action);
    }
    return undefined;
}

// One sentence, said twice over: the piped render ends it by naming the
// command, and the terminal render prints that command on a line of its own.
// Composed here from the same two parts so the two can never disagree about
// which command rules on the row.
function confirmable(lead: string, id: string, action: string): WaitingItem
{
    return {
        full: `${lead} (confirm with \`${action}\`)`,
        lead,
        identity: lead.split(":")[0],
        recovery: { verb: "search", id },
        action
    };
}

// Deadlines derive from the reserved `target` metadata over the live set,
// soonest first, and the linked foreign objectives' targets merge in on the
// same ordering (#244 C4). The date renders as recorded — judging it against
// today is the health signals' job, so this projection is stable for a given
// set of logs.
function deadlineRows(model: ProjectModel, linked: ForeignObjectiveView): string[]
{
    const local = model.entities
        .filter((item) => item.status === "confirmed" && isCurrent(item) && item.target !== undefined
            && rendersIn(item, model.slug, model.slug))
        .map((item) => ({ target: item.target ?? "", id: item.id, row: `- ${item.target}: ${entityLabel(item)}${oneLine(item.text)}` }));
    return [...local, ...foreignDeadlineRows(model, linked)]
        .sort((left, right) => left.target.localeCompare(right.target) || left.id.localeCompare(right.id))
        .map((item) => item.row);
}

// One row per linked foreign objective, however many rendered units
// contribute to it, and only while the owner still holds it active with a
// target: a dropped, superseded or reached objective leaves the deadlines the
// moment nothing is working toward it (#244 C4, D1). A closed unit's link
// stops carrying the row for the same reason its contribution leaves the
// owner's counts.
function foreignDeadlineRows(model: ProjectModel, linked: ForeignObjectiveView): { target: string; id: string; row: string }[]
{
    const rows = new Map<string, { target: string; id: string; row: string }>();
    for (const work of model.works.filter((item) => item.status !== "done" && item.status !== "retired"))
    {
        for (const link of work.foreignObjectives.filter((item) => item.project !== model.slug))
        {
            const objective = linked.states.get(`${link.project}/${link.id}`);
            if (objective?.status === "active" && objective.target !== undefined && !rows.has(link.id))
            {
                rows.set(link.id, { target: objective.target, id: link.id, row: `- ${objective.target}: [objective] ${oneLine(objective.outcome)} (${link.project})` });
            }
        }
    }
    return [...rows.values()];
}

// Full rows for the work actually moving, and nothing else (#205 table C): a
// unit blocked on a dependency or an external wait left this block for the
// open-work count, and a unit blocked on a decision renders under "waiting".
function inProgressLines(model: ProjectModel, linked: ForeignObjectiveView): string[]
{
    const project = shellArgument(model.slug);
    return model.works.filter((w) => w.status === "active").map((work) =>
    {
        const latest = [...work.reports].sort(compareDated).at(-1);
        const report = latest === undefined ? "" : reportExcerpt(latest.text, work.id, project);
        const next = work.next === undefined ? "" : ` (next: ${work.next})`;
        // Local contributions stay unannotated, as they always were; only the
        // foreign ones carry the owning slug and its disclosures (#244 C3).
        const toward = [
            ...contributionsOf(model.goals, work).map((item) => item.id),
            ...work.foreignObjectives.map((link) => foreignTowardLabel(link, linked))
        ].join(", ");
        return `- ${work.id} ${work.outcome}${toward === "" ? "" : ` [toward ${toward}]`}${heldNote(work)}${report}${next}`;
    });
}

// Whether another session is on this unit right now, rendered where a reader
// chooses what to pick up (#230). It reads before the report excerpt, because
// a unit somebody else is holding is a fact about whether to start at all
// rather than a detail of how far it got.
function heldNote(work: WorkState): string
{
    const note = claimNote(work.claim, sessionToken(), work.process);
    return note === null ? "" : `  [${note}]`;
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
//
// How many rows each section keeps, rather than the rendered text: the render
// assembles from this, and search reads the same answer to find out which
// records the budget cut (#212 R1).
function fitKeeps(head: string[], sections: ContextSection[], limit: number): number[]
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
    return keeps;
}

/* ── what context showed, for the surface that answers over the rest ─ */

// R1 (#212): every record the current context render actually shows. The
// default `self search` answers over the live records this set does not hold —
// the search tier, plus the index and full records the budget cut — so the
// membership is read off the very sections `printContext` renders instead of
// being restated as a tier, and the two cannot drift apart.
export function contextRendered(storeDir: string, models: ProjectModel[]): Set<string>
{
    const limit = contextBodyLimit(tokenScale(readStoreConfig(storeDir)));
    const shown = new Set<string>();
    for (const model of models)
    {
        const { head, sections } = projectContextSections(contextView(storeDir, models, model), scopedIn(models, model.slug), models);
        const keeps = fitKeeps(head, sections, limit);
        sections.forEach((section, index) =>
            (section.ids ?? []).slice(0, keeps[index]).forEach((id) => shown.add(id)));
    }
    return shown;
}

// The model as `printContext` renders it: the works its scope carries and the
// signals the console surfaces recheck, both of which spend budget. Copied
// rather than assigned onto the fold — the caller reads the same folds again
// for the next project.
function contextView(storeDir: string, models: ProjectModel[], model: ProjectModel): ProjectModel
{
    const works = models.flatMap((other) => scopedWorks(other, model.slug));
    return {
        ...model,
        works,
        health: [...model.health, ...verdictSignals(works, readVerdicts(storeDir, model.slug)),
            ...artifactSignals(storeDir, works)]
    };
}

// Every other project's records that render here (#181 D2), over folds
// already in hand — the printed render and the search membership both read it.
function scopedIn(models: ProjectModel[], viewer: string): EntityState[]
{
    return models.filter((model) => model.slug !== viewer)
        .flatMap((model) => model.entities.filter((entity) =>
            rendersIn(entity, model.slug, viewer) && entity.status === "confirmed" && isCurrent(entity)));
}

// What the ruled render takes: the same items the plain render sentences,
// minus the live proposals. Those are the attention band, which that render
// groups into its own tables — listing them here as well would print every
// proposal twice.
//
// Each row carries the command that acts on it. An item that named no command
// of its own falls back to its recovery pointer, so no row reaches a person
// with nothing to run.
function unrankedWaitingRows(model: ProjectModel): WaitingRow[]
{
    const project = shellArgument(model.slug);
    return [...model.waiting, ...workProposalItems(model), ...entityWaitingItems(model)]
        .map((item) => ({ text: item.lead ?? item.full, action: item.action ?? recoveryCommand(item.recovery, project) }));
}

function recoveryCommand(recovery: WaitingItem["recovery"], project: string): string
{
    return typeof recovery === "string" ? scoped(recovery, project) : pointerTo(recovery, project);
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
        action: `self work accept ${proposal.id.slice(0, 8)}`,
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
        return "no projects registered — run `self project init` inside a project directory";
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
            waiting: unrankedWaitingRows(model),
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
    if (activeProjects(ctx.storeDir).length === 0)
    {
        console.log(readRegistry(ctx.storeDir).length === 0
            ? "no projects registered — run `self project init` inside a project directory"
            : "every registered project is archived — run `self project --archived` to list them");
        return;
    }
    const models = renderedModels(ctx.storeDir).map((model) => withVerdicts(ctx.storeDir, model));
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

// The size this listing states is the open units, which is what its rows are:
// the two bucket lines under them say how much was left out and are not part of
// the count. A project with nothing open answers with the wording it always
// did, and the buckets still follow it.
export function workList(ctx: ProjectScope, render: RenderMode): CommandOutput
{
    const model = renderedModel(ctx.storeDir, ctx.project);
    if (render === "pretty")
    {
        return [{ kind: "document", lines: renderWorkList(model) }];
    }
    const open = model.works.filter((w) => w.status !== "done" && w.status !== "retired");
    const rows = open.length === 0 ? ["no open work"] : open.map((work) => openWorkRow(model, work));
    return [{
        kind: "listing",
        rows: [...rows, ...hiddenBuckets(model)],
        total: open.length,
        noun: "open work unit"
    }];
}

function openWorkRow(model: ProjectModel, work: WorkState): string
{
    const toward = [...contributionsOf(model.goals, work).map((item) => item.id), ...foreignToward(work)];
    return plainWorkLine(work, toward.join(", "), shellArgument(model.slug));
}

// What the listing does not show, said in its own words rather than folded into
// the size line: a done unit is not a smaller number of open ones, and the log
// is where it is read.
function hiddenBuckets(model: ProjectModel): string[]
{
    const count = (status: string): number => model.works.filter((w) => w.status === status).length;
    return [
        ...count("done") > 0 ? [`(${count("done")} done — see log)`] : [],
        ...count("retired") > 0 ? [`(${count("retired")} retired — see log)`] : []
    ];
}

function plainWorkLine(work: WorkState, toward: string, project: string): string
{
    const blocked = work.status === "blocked" ? ` (on ${work.blockedOn})` : "";
    const reports = work.reports.length > 0
        ? `  — ${work.reports.length} report(s), see \`${pointerTo({ verb: "work-show", id: work.id }, project)}\`` : "";
    return `${work.id}  ${work.status}${blocked}  ${work.outcome}${toward === "" ? "" : `  [toward ${toward}]`}`
        + `${gatedNote(work)}${heldNote(work)}${reports}`;
}

// A unit that never started can still be gated, which is the whole point of
// inverting the relation: `blocked on decision` needs the unit to be moving
// before it can say anything, and a proposal does not wait for that.
function gatedNote(work: WorkState): string
{
    return work.gatedBy.length === 0 ? "" : `  [gated by ${work.gatedBy.join(", ")}]`;
}

// The one listing that is a window by construction: `-n` says how many lines to
// print and the rest of the log is still there. The total is counted from the
// same read the rows are cut from — reading the log twice would let the number
// a reader is given describe a log that has moved on since.
export function projectLog(ctx: ProjectScope, limit: number): CommandOutput
{
    const events = readEvents(ctx.storeDir, ctx.project);
    const shown = events.slice(-limit);
    return [{
        kind: "listing",
        rows: shown.map((event) => logLine(event, undefined)),
        total: events.length,
        noun: "event",
        window: { shown: shown.length, recover: pointerTo({ verb: "log", lines: events.length }, shellArgument(ctx.project)) }
    }];
}

/* ── one record's own history (#212 R3) ────────────────────────────── */

// History is per-entity and explicit: there is no global history search, so
// the caller has already resolved which record is wanted and which log holds
// it. Everything below renders that record's events as the rows `self log`
// prints — a raw event object is never an answer (#212 T6.7).
const HISTORY_PAGE = 10;

interface HistoryRecord
{
    id: string;
    storeDir: string;
    // The project whose log holds the record, which is not always the project
    // it renders in (#181 D1).
    owner: string;
    // The project the reader asked about, for the pointer to the next page.
    project: string;
    // Which show verb the reader typed, so the next page is reachable by
    // repeating their own command.
    command: "state" | "work";
    // The owner's fold, for the settled status this record answers as.
    model: ProjectModel;
    // Named, never folded in: a successor has a history of its own.
    successor?: string;
}

export function printHistory(record: HistoryRecord, asked: string | undefined): void
{
    const page = requirePage(asked);
    const events = historyEvents(record);
    const pages = Math.max(1, Math.ceil(events.length / HISTORY_PAGE));
    console.log(historyHead(record, events.length));
    if (page > pages)
    {
        console.log(`no events on page ${page} — ${record.id} has ${plural(pages, "page")}`);
        return;
    }
    const start = (page - 1) * HISTORY_PAGE;
    for (const event of events.slice(start, start + HISTORY_PAGE))
    {
        console.log(logLine(event, undefined));
    }
    if (start + HISTORY_PAGE < events.length)
    {
        console.log(`… ${events.length - start - HISTORY_PAGE} more; run \`${nextPage(record, page + 1)}\``);
    }
}

// A page is counted from one. A page past the last is answered rather than
// refused (#212 T6.5); a page that is not a page at all is a mistake in the
// command line, which is refused before anything is read.
function requirePage(asked: string | undefined): number
{
    if (asked === undefined)
    {
        return 1;
    }
    const page = Number.parseInt(asked, 10);
    if (Number.isNaN(page) || page <= 0 || String(page) !== asked.trim())
    {
        throw new CliError(`--page expects a page number from 1, not "${asked}"`);
    }
    return page;
}

// Only the events that speak about this record, oldest first. A merged log
// orders by neither time nor dependency, so the page is sorted rather than
// taken in append order.
function historyEvents(record: HistoryRecord): SelfEvent[]
{
    return readEvents(record.storeDir, record.owner)
        .filter((event) => eventRecord(event) === record.id)
        .sort(compareDated);
}

function historyHead(record: HistoryRecord, count: number): string
{
    const status = closedRecords(record.model).get(record.id) ?? "live";
    const successor = record.successor === undefined ? "" : ` · superseded by ${record.successor}`;
    return `${record.id}  ${status}${successor}  ${plural(count, "event")}`;
}

function nextPage(record: HistoryRecord, page: number): string
{
    return `self ${record.command} show ${record.id} --history --page ${page} --project ${shellArgument(record.project)}`;
}

// Every registered project's events on one timeline, newest last, cut to the
// limit after the merge rather than before it: the ask is the workspace's last
// N events, not the last N of each project pasted together. The slug leads
// each line as it does in `self search`, because a merged log that says what
// happened without saying where is not readable.
export function workspaceLog(scopes: ProjectScope[], limit: number): CommandOutput
{
    const merged = scopes.flatMap((scope) => readEvents(scope.storeDir, scope.project)
        .map((event) => ({ event, slug: scope.project })));
    merged.sort((left, right) => compareDated(left.event, right.event));
    const shown = merged.slice(-limit);
    // The whole of this log is the workspace's, so the command for the rest
    // names `--workspace` and no project: pointing at one of the projects it
    // merged would answer a narrower question than the one that was asked.
    return [{
        kind: "listing",
        rows: shown.map((item) => logLine(item.event, item.slug)),
        total: merged.length,
        noun: "event",
        window: { shown: shown.length, recover: workspacePointer({ verb: "log", lines: merged.length }) }
    }];
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
