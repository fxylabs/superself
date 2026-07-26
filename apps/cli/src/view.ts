import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { excludeLocally } from "./gitutil.js";
import { eventSummary, readEvents } from "./logfile.js";
import { DecisionState, ProjectModel, WorkState } from "./model.js";
import { CliContext, ensureDir, StoreConfig } from "./paths.js";
import { Verdict } from "./reachability.js";
import { ArtifactMeta, CliError, SelfEvent } from "./types.js";

const VIEW_DIR = "view";
const THEME_FILE = "theme.css";

// Panel caps from the Event Console canon: a dashboard shows the latest
// slice, and the full record lives on its own page.
const CAP_WAITING = 10;
const CAP_NEXT = 5;
const CAP_EVENTS = 5;
const CAP_DECISIONS = 5;
const CAP_ARTIFACTS = 4;
const CAP_WORKSPACE_ARTIFACTS = 6;
const EVENTS_PAGE = 300;
const SUMMARY_EVENTS = 8;
const SUMMARY_DECISIONS = 6;

// One table feeds both the CSS theme blocks and the favicon, so the browser
// tab can never drift from the accent the pages are rendered in.
const THEMES: Record<string, { accent: string; soft: string; line: string }> = {
    violet: { accent: "#a78bfa", soft: "#a78bfa1a", line: "#a78bfa4d" },
    cyan: { accent: "#22d3ee", soft: "#22d3ee1a", line: "#22d3ee4d" },
    orange: { accent: "#ff6b35", soft: "#ff6b351a", line: "#ff6b354d" },
    mono: { accent: "#e9e9f2", soft: "#e9e9f214", line: "#3a3a46" }
};

export function validTheme(name: string): string
{
    const theme = name.trim().toLowerCase();
    if (THEMES[theme] === undefined)
    {
        throw new CliError(`"${name}" is not a viewer theme — pick one of ${Object.keys(THEMES).join(", ")}`);
    }
    return theme;
}

interface SummaryArtifact
{
    id: string;
    name: string;
    path: string;
    workId: string;
    ts: string;
}

interface SummaryEvent
{
    id: string;
    ts: string;
    type: string;
    text: string;
}

interface SummaryDecision
{
    ts: string;
    text: string;
}

// Fields added after the first release are optional so the workspace page
// tolerates *.json summaries written by an older fold — other projects
// refresh theirs lazily, at their own next fold.
interface ProjectSummary
{
    slug: string;
    description?: string;
    goal?: string;
    updated: string;
    active: { id: string; outcome: string }[];
    blockedCount: number;
    nextCount: number;
    doneCount: number;
    health: string[];
    openQuestions: string[];
    proposedCount?: number;
    recentArtifacts?: SummaryArtifact[];
    recentEvents?: SummaryEvent[];
    recentDecisions?: SummaryDecision[];
    waiting?: WaitingRow[];
    foldId?: string;
}

interface WaitingRow
{
    kind: string;
    text: string;
    ref: string;
    action: string;
    href?: string;
    warn?: boolean;
}

interface RailProject
{
    slug: string;
    warn: boolean;
}

interface Rail
{
    workspace: string;
    projects: RailProject[];
    active?: string;
    foldId: string;
    foldTime: string;
    depth: number;
}

interface Shell
{
    title: string;
    crumb: string;
    query: string;
    rail: Rail;
    main: string;
    record?: string;
    back?: string;
    doc?: boolean;
}

let LANG = "en";
let THEME = "violet";
let USER_THEME = "";

export function writeViews(storeDir: string, model: ProjectModel, config: StoreConfig, verdicts: Record<string, Verdict> = {}): void
{
    LANG = config.lang ?? "en";
    THEME = config.theme ?? "violet";
    USER_THEME = readUserTheme(storeDir);
    const dir = ensureDir(join(storeDir, VIEW_DIR));
    excludeLocally(storeDir, VIEW_DIR + "/");
    excludeLocally(storeDir, THEME_FILE);
    const events = readEvents(storeDir, model.slug);
    const labels = buildLabels(events);
    const feed = toFeed([...events].reverse(), labels);
    writeFileSync(join(dir, `${model.slug}.json`), JSON.stringify(summarize(model, feed)) + "\n");

    const summaries = readSummaries(dir);
    const workspace = basename(dirname(storeDir));
    const rail = (depth: number, active?: string): Rail => ({
        workspace,
        projects: summaries.map((s) => ({ slug: s.slug, warn: waitingOf(s).length > 0 })),
        active,
        foldId: shortId(feed[0]?.id ?? ""),
        foldTime: stamp(),
        depth
    });

    writeFileSync(join(dir, `${model.slug}.html`), renderProjectPage(model, feed, verdicts, rail(0, model.slug)));
    const workDir = ensureDir(join(dir, model.slug));
    for (const work of model.works)
    {
        writeFileSync(join(workDir, `${work.id}.html`), renderWorkPage(model, work, verdicts, rail(1, model.slug)));
    }
    writeFileSync(join(workDir, "decisions.html"), renderDecisionsPage(model, rail(1, model.slug)));
    writeFileSync(join(workDir, "events.html"), renderEventsPage(model, feed, rail(1, model.slug)));
    writeFileSync(join(workDir, "artifacts.html"), renderArtifactsPage(model, rail(1, model.slug)));
    writeFileSync(join(dir, "workspace.html"), renderWorkspacePage(summaries, rail(0)));
}

// The override is inlined into a <style> element, so it must never be able
// to close it and start injecting markup.
function readUserTheme(storeDir: string): string
{
    const file = join(storeDir, THEME_FILE);
    return existsSync(file) ? readFileSync(file, "utf8").replace(/<\/style/gi, "") : "";
}

export function viewFile(storeDir: string, slug: string | undefined): string
{
    const file = join(storeDir, VIEW_DIR, slug === undefined ? "workspace.html" : `${slug}.html`);
    if (!existsSync(file))
    {
        throw new CliError(slug === undefined
            ? "no views rendered yet — record an event or run `self fold` first"
            : `no view for "${slug}" — check the slug with \`self work\` or run \`self fold\` in that project`);
    }
    return file;
}

export function openFile(ctx: CliContext, file: string): void
{
    launchFile(ctx, file);
    console.log(`opened ${file} — the page reloads itself when state changes and you are not interacting`);
}

export function launchFile(ctx: CliContext, file: string): void
{
    const command = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(command, [file], { cwd: ctx.workspaceDir, detached: true, stdio: "ignore" }).unref();
}

function summarize(model: ProjectModel, feed: SummaryEvent[]): ProjectSummary
{
    return {
        slug: model.slug,
        description: model.description,
        goal: model.goal,
        updated: new Date().toISOString(),
        active: model.works.filter((w) => w.status === "active").map((w) => ({ id: w.id, outcome: w.outcome })),
        blockedCount: model.works.filter((w) => w.status === "blocked").length,
        nextCount: model.works.filter((w) => w.status === "next").length,
        doneCount: model.works.filter((w) => w.status === "done").length,
        health: model.health,
        openQuestions: model.openQuestions,
        proposedCount: model.decisions.filter((d) => d.status === "proposed" && !d.expired).length,
        recentArtifacts: artifactRows(model).slice(0, CAP_ARTIFACTS)
            .map((r) => ({ id: r.meta.id, name: r.meta.name, path: r.meta.path, workId: r.workId, ts: r.ts })),
        recentEvents: feed.slice(0, SUMMARY_EVENTS),
        recentDecisions: decisionOrder(model.decisions).slice(0, SUMMARY_DECISIONS)
            .map((d) => ({ ts: d.ts, text: d.text })),
        waiting: waitingRows(model),
        foldId: shortId(feed[0]?.id ?? "")
    };
}

function readSummaries(dir: string): ProjectSummary[]
{
    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as ProjectSummary)
        .sort((a, b) => a.slug.localeCompare(b.slug));
}

/* ── attention ─────────────────────────────────────────────────────── */

// Everything that waits on the reader, ordered by how hard it blocks:
// stopped work, then a signal that state and repository disagree, then
// decisions and questions the reader alone can close.
function waitingRows(model: ProjectModel): WaitingRow[]
{
    const generated = new Set(model.works
        .filter((w) => w.status === "blocked")
        .map((w) => `${w.id} is waiting on a decision: ${w.blockedWhy ?? w.outcome}`));
    return [
        ...model.works.filter((w) => w.status === "blocked").map((w) => ({
            kind: "blocked",
            text: firstLine(`${w.outcome} — waiting on ${w.blockedOn ?? "?"}${w.blockedWhy === undefined ? "" : `: ${w.blockedWhy}`}`),
            ref: w.id,
            action: "open",
            href: `${w.id}.html`,
            warn: true
        })),
        ...model.health.map((h) => ({ kind: "health", text: firstLine(h), ref: "", action: "inspect", warn: true })),
        ...model.decisions.filter((d) => d.status === "proposed" && !d.expired).map((d) => ({
            kind: "proposal",
            text: firstLine(d.text),
            ref: shortId(d.id),
            action: "confirm"
        })),
        ...model.openQuestions.filter((q) => !generated.has(q))
            .map((q) => ({ kind: "question", text: firstLine(q), ref: "", action: "" }))
    ];
}

function waitingOf(summary: ProjectSummary): WaitingRow[]
{
    if (summary.waiting !== undefined)
    {
        return summary.waiting;
    }
    // stale summary from an older fold: rebuild the count from what it does carry
    return [
        ...Array.from({ length: summary.blockedCount }, () => ({ kind: "blocked", text: "", ref: "", action: "", warn: true })),
        ...summary.health.map((h) => ({ kind: "health", text: firstLine(h), ref: "", action: "", warn: true })),
        ...Array.from({ length: summary.proposedCount ?? 0 }, () => ({ kind: "proposal", text: "", ref: "", action: "" })),
        ...summary.openQuestions.map((q) => ({ kind: "question", text: firstLine(q), ref: "", action: "" }))
    ];
}

/* ── project dashboard ─────────────────────────────────────────────── */

function renderProjectPage(model: ProjectModel, events: SummaryEvent[], verdicts: Record<string, Verdict>, rail: Rail): string
{
    const active = model.works.filter((w) => w.status === "active");
    const next = model.works.filter((w) => w.status === "next");
    const done = model.works.filter((w) => w.status === "done");
    const waiting = waitingRows(model);
    const main = [
        `<p class="c2-goal">${esc(model.goal ?? "goal not set")}</p>`,
        waitingPanel(waiting, model.slug, ""),
        panel("IN PROGRESS", active.length, "",
            active.length === 0 ? empty("no active work") : table(active.map((w) => workRow(model.slug, w, verdicts)))),
        panel("NEXT", next.length, "",
            next.length === 0 ? empty("queue is empty") : capped(
                next.map((w) => nextRow(model.slug, w)), CAP_NEXT, "next work")),
        eventPanel(events.slice(0, CAP_EVENTS), events.length, `${model.slug}/events.html`),
        foldPanel("CONVENTIONS", model.conventions.map((c) => `<div class="dr-dec"><time>${day(c.ts)}</time><p>${esc(c.text)}</p></div>`)),
        foldPanel("DONE", done.map((w) => `<div class="dr-dec"><time>${day(w.lastEventTs)}</time><p>${workLink(model.slug, w)} ${esc(w.outcome)}</p></div>`))
    ].join("\n");
    const decisions = decisionOrder(model.decisions);
    const artifacts = artifactRows(model);
    const record = [
        panel("DECISIONS", 0, `${model.slug}/decisions.html`,
            decisions.length === 0 ? empty("no decisions yet") : decisions.slice(0, CAP_DECISIONS).map(decisionRow).join("\n"),
            more(decisions.length, CAP_DECISIONS, `${model.slug}/decisions.html`, "all decisions")),
        panel("ARTIFACTS", artifacts.length, `${model.slug}/artifacts.html`,
            artifacts.length === 0 ? empty("no artifacts yet") : artifacts.slice(0, CAP_ARTIFACTS).map((r) => artifactRow(r, "..")).join("\n"),
            more(artifacts.length, CAP_ARTIFACTS, `${model.slug}/artifacts.html`, "all artifacts"))
    ].join("\n");
    return page({
        title: model.slug,
        crumb: `${esc(rail.workspace)} / <b>${esc(model.slug)}</b>`,
        query: `state | project == "${model.slug}" | fold ${rail.foldId}`,
        rail,
        main,
        record
    });
}

function waitingPanel(rows: WaitingRow[], slug: string, prefix: string): string
{
    if (rows.length === 0)
    {
        return panel("WAITING ON YOU", 0, "", empty("nothing waiting on you"), "", true);
    }
    const cells = rows.map((row) => waitingCells(row, slug, prefix));
    return panel("WAITING ON YOU", rows.length, "", capped(cells, CAP_WAITING, "item"), "", true);
}

function waitingCells(row: WaitingRow, slug: string, prefix: string): string
{
    const action = row.action === "" ? "" :
        row.href === undefined ? `<td class="act">${esc(row.action)}</td>`
            : `<td class="act"><a href="${esc(`${prefix}${slug}/${row.href}`)}">${esc(row.action)}</a></td>`;
    return `<tr><td class="k${warnClass(row)}">${esc(row.kind)}</td><td>${esc(row.text)}</td>` +
        `<td class="n">${esc(row.ref)}</td>${action === "" ? `<td class="act"></td>` : action}</tr>`;
}

function warnClass(row: WaitingRow): string
{
    return row.warn === true ? " warn" : "";
}

function workRow(slug: string, work: WorkState, verdicts: Record<string, Verdict>): string
{
    const latest = work.reports[work.reports.length - 1];
    const sub = [
        latest === undefined ? "" : `latest: ${firstLine(latest.text)}`,
        work.evidence.length === 0 ? "" : `evidence ${work.evidence.map((c) => `${c} ${verdicts[c] ?? "unchecked"}`).join(" · ")}`
    ].filter((part) => part !== "").join(" · ");
    return `<tr><td class="n">${workLink(slug, work)}</td>` +
        `<td>${esc(work.outcome)}${sub === "" ? "" : `<span class="hf-sub">${esc(sub)}</span>`}</td>` +
        `<td class="r"><span class="pill p-${work.status}">${work.status}</span></td></tr>`;
}

function nextRow(slug: string, work: WorkState): string
{
    return `<tr><td class="n">${workLink(slug, work)}</td><td>${esc(work.outcome)}</td></tr>`;
}

/* ── work detail ───────────────────────────────────────────────────── */

function renderWorkPage(model: ProjectModel, work: WorkState, verdicts: Record<string, Verdict>, rail: Rail): string
{
    const chips = [
        `<span class="wd-chip">created ${day(work.ts)}</span>`,
        work.next === undefined ? "" : `<span class="wd-chip">next: ${esc(work.next)}</span>`,
        ...work.branches.map((b) => `<span class="wd-chip">branch ${esc(b)}</span>`)
    ].filter((chip) => chip !== "").join("");
    const blocked = work.status === "blocked"
        ? `<p class="wd-note">waiting on ${esc(work.blockedOn ?? "?")}${work.blockedWhy === undefined ? "" : `: ${esc(work.blockedWhy)}`}</p>`
        : "";
    const reports = [...work.reports].reverse().map((report, index) =>
        `<section class="wd-report${index === 0 ? "" : " is-past"}" aria-label="report">` +
        `<div class="wd-report-head"><time>${day(report.ts)}</time>` +
        `<span class="n">${report.commits.map(esc).join(" ") || "—"}</span></div>` +
        `<div class="wd-prose">${esc(report.text)}</div></section>`);
    const main = [
        `<div class="wd-head"><span class="n">${esc(work.id)}</span>` +
            `<span class="pill p-${work.status}">${work.status}</span></div>`,
        `<h1 class="wd-title">${esc(work.outcome)}</h1>`,
        chips === "" ? "" : `<div class="wd-meta">${chips}</div>`,
        blocked,
        reports.length === 0 ? `<p class="c2-empty">no reports yet</p>` : reports.join("\n")
    ].filter((part) => part !== "").join("\n");
    const artifacts = workArtifactRows(work);
    const linked = decisionOrder(model.decisions).filter((d) => d.work === work.id);
    const record = [
        panel("EVIDENCE", work.evidence.length, "",
            work.evidence.length === 0 ? empty("no evidence yet")
                : work.evidence.map((hash) => evidenceRow(hash, verdicts[hash])).join("\n")),
        panel("ARTIFACTS", artifacts.length, "",
            artifacts.length === 0 ? empty("no artifacts yet")
                : artifacts.map((r) => artifactRow(r, "../..")).join("\n")),
        linked.length === 0 ? "" : panel("DECISIONS FROM THIS WORK", linked.length, "", linked.map(decisionRow).join("\n"))
    ].filter((part) => part !== "").join("\n");
    return page({
        title: `${work.id} — ${model.slug}`,
        crumb: `${esc(rail.workspace)} / <a href="../${esc(model.slug)}.html">${esc(model.slug)}</a> / <b>${esc(work.id)}</b>`,
        query: `work | id == "${work.id}" | ${count(work.reports.length, "report")}`,
        rail,
        main,
        record,
        back: `../${model.slug}.html`,
        doc: true
    });
}

function evidenceRow(hash: string, verdict: Verdict | undefined): string
{
    const state = verdict ?? "unchecked";
    return `<div class="dr-evi"><span class="n">${esc(hash)}</span>` +
        `<i class="v-${esc(state)}">${esc(state)}</i></div>`;
}

/* ── list pages ────────────────────────────────────────────────────── */

function renderDecisionsPage(model: ProjectModel, rail: Rail): string
{
    const rows = decisionOrder(model.decisions, true);
    const main = [
        `<p class="c2-goal">Decisions — ${count(rows.length, "record")}</p>`,
        rows.length === 0 ? empty("no decisions yet")
            : `<div class="af-grid">${rows.map(decisionCard).join("\n")}</div>`
    ].join("\n");
    return listPage(model.slug, "decisions", `decisions | project == "${model.slug}" | ${count(rows.length, "item")}`, main, rail);
}

function renderEventsPage(model: ProjectModel, events: SummaryEvent[], rail: Rail): string
{
    const shown = events.slice(0, EVENTS_PAGE);
    const note = events.length > shown.length
        ? `<p class="c2-note">showing the latest ${shown.length} of ${events.length} events</p>` : "";
    const main = [
        `<p class="c2-goal">Events — ${count(events.length, "record")}</p>`,
        note,
        `<section class="c2-panel c2-feed" aria-label="event log">` +
            `${shown.map((event) => eventRow(event)).join("\n")}</section>`
    ].filter((part) => part !== "").join("\n");
    return listPage(model.slug, "events", `events | project == "${model.slug}" | ${count(events.length, "item")}`, main, rail);
}

function renderArtifactsPage(model: ProjectModel, rail: Rail): string
{
    const rows = artifactRows(model);
    const works = new Set(rows.map((r) => r.workId)).size;
    const main = [
        `<p class="c2-goal">Artifacts — ${count(rows.length, "item")} across ${count(works, "work unit")}</p>`,
        rows.length === 0 ? empty("no artifacts yet")
            : `<div class="af-grid">${rows.map((r) => artifactCard(r, model.slug)).join("\n")}</div>`
    ].join("\n");
    return listPage(model.slug, "artifacts", `artifacts | project == "${model.slug}" | ${count(rows.length, "item")}`, main, rail);
}

function listPage(slug: string, name: string, query: string, main: string, rail: Rail): string
{
    return page({
        title: `${name} — ${slug}`,
        crumb: `${esc(rail.workspace)} / <a href="../${esc(slug)}.html">${esc(slug)}</a> / <b>${esc(name)}</b>`,
        query,
        rail,
        main,
        back: `../${slug}.html`
    });
}

/* ── workspace dashboard ───────────────────────────────────────────── */

function renderWorkspacePage(summaries: ProjectSummary[], rail: Rail): string
{
    const waiting = summaries.flatMap((s) => waitingOf(s).map((row) => ({ row, slug: s.slug })));
    const waitingBody = waiting.length === 0 ? empty("nothing waiting on you")
        : capped(waiting.map(({ row, slug }) =>
            `<tr><td class="n"><a href="${esc(slug)}.html">${esc(slug)}</a></td>` +
            `<td class="k${warnClass(row)}">${esc(row.kind)}</td><td>${esc(row.text)}</td>` +
            `<td class="act">${esc(row.action)}</td></tr>`), CAP_WAITING, "item");
    const events = summaries
        .flatMap((s) => (s.recentEvents ?? []).map((e) => ({ ...e, slug: s.slug })))
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, CAP_EVENTS);
    const decisions = summaries
        .flatMap((s) => (s.recentDecisions ?? []).map((d) => ({ ...d, slug: s.slug })))
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, CAP_DECISIONS);
    const artifacts = summaries
        .flatMap((s) => (s.recentArtifacts ?? []).map((a) =>
            ({ meta: { id: a.id, name: a.name, path: a.path }, workId: a.workId, ts: a.ts, project: s.slug })))
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, CAP_WORKSPACE_ARTIFACTS);
    const main = [
        `<p class="c2-goal">Workspace — ${count(summaries.length, "project")}, ${count(waiting.length, "item")} waiting on you</p>`,
        panel("WAITING ON YOU", waiting.length, "", waitingBody, "", true),
        panel("PROJECTS", summaries.length, "",
            summaries.length === 0 ? empty("no projects registered") : table(summaries.map(projectRow))),
        events.length === 0 ? panel("EVENTS", 0, "", empty("no events yet"))
            : `<section class="c2-panel c2-feed" aria-label="events">` +
                `<div class="c2-panel-head"><h2>EVENTS</h2><span class="c2-live">live</span></div>` +
                events.map((e) => eventRow(e, e.slug)).join("\n") + `</section>`
    ].join("\n");
    const record = [
        panel("DECISIONS", 0, "",
            decisions.length === 0 ? empty("no decisions yet")
                : decisions.map((d) => `<div class="dr-dec"><time>${day(d.ts)}</time>` +
                    `<p><a href="${esc(d.slug)}.html">${esc(d.slug)}</a> · ${esc(d.text)}</p></div>`).join("\n")),
        panel("ARTIFACTS", artifacts.length, "",
            artifacts.length === 0 ? empty("no artifacts yet")
                : artifacts.map((r) => artifactRow(r, "..")).join("\n"))
    ].join("\n");
    return page({
        title: "Workspace",
        crumb: `<b>${esc(rail.workspace)}</b>`,
        query: `workspace | ${count(summaries.length, "project")} | fold ${rail.foldId}`,
        rail,
        main,
        record
    });
}

function projectRow(summary: ProjectSummary): string
{
    const waiting = waitingOf(summary);
    const sub = [
        `${summary.active.length} active`,
        `${summary.nextCount} next`,
        `${waiting.length} waiting`,
        `${summary.doneCount} done`
    ].join(" · ");
    const status = waiting.length > 0 ? "blocked" : "next";
    const label = waiting.length > 0 ? "attention" : "quiet";
    return `<tr><td class="n"><a href="${esc(summary.slug)}.html">${esc(summary.slug)}</a></td>` +
        `<td>${esc(summary.goal ?? summary.description ?? "goal not set")}<span class="hf-sub">${esc(sub)}</span></td>` +
        `<td class="r"><span class="pill p-${status}">${label}</span></td></tr>`;
}

/* ── shared pieces ─────────────────────────────────────────────────── */

function panel(label: string, countValue: number, openHref: string, body: string, footer = "", attention = false): string
{
    const chip = countValue > 0 ? `<b class="c2-count">${countValue}</b>` : "";
    const open = openHref === "" ? "" : `<a class="c2-open" href="${esc(openHref)}" aria-label="open ${label.toLowerCase()}">↗</a>`;
    return `<section class="c2-panel${attention ? " c2-attention" : ""}" aria-label="${label.toLowerCase()}">` +
        `<div class="c2-panel-head"><h2>${label}</h2>${chip}${open}</div>\n${body}${footer}</section>`;
}

function foldPanel(label: string, rows: string[]): string
{
    return rows.length === 0 ? "" :
        `<section class="c2-panel" aria-label="${label.toLowerCase()}">` +
        `<details class="c2-fold"><summary>${label} · ${rows.length}</summary>\n${rows.join("\n")}</details></section>`;
}

function table(rows: string[]): string
{
    return `<table>${rows.join("\n")}</table>`;
}

// Overflow inside a panel that has no page of its own: the rest stays on
// the page behind a fold rather than pointing at a destination that does
// not exist.
function capped(rows: string[], cap: number, word: string): string
{
    if (rows.length <= cap)
    {
        return table(rows);
    }
    return table(rows.slice(0, cap)) +
        `<details class="c2-fold"><summary>${rows.length - cap} more ${word}${rows.length - cap === 1 ? "" : "s"}</summary>` +
        table(rows.slice(cap)) + `</details>`;
}

function more(total: number, cap: number, href: string, label: string): string
{
    return total <= cap ? "" :
        `<a class="c2-more" href="${esc(href)}"><span>${cap} of ${total}</span><span>${esc(label)} →</span></a>`;
}

function empty(text: string): string
{
    return `<p class="c2-empty">${esc(text)}</p>`;
}

function decisionOrder(decisions: DecisionState[], all = false): DecisionState[]
{
    return decisions
        .filter((d) => all || d.status === "confirmed" || (d.status === "proposed" && !d.expired))
        .sort((a, b) => b.ts.localeCompare(a.ts));
}

function decisionRow(decision: DecisionState): string
{
    const mark = decision.status === "proposed" ? `<i class="dr-prop">proposed</i>` : "";
    return `<div class="dr-dec"><time>${day(decision.ts)}</time><p>${esc(decision.text)}${mark}</p></div>`;
}

function decisionCard(decision: DecisionState): string
{
    const why = decision.why === undefined ? "" : `<small>${esc(decision.why)}</small>`;
    return `<article class="af-card af-text"><div class="af-meta">` +
        `<b>${esc(decision.text)}</b>${why}` +
        `<small class="mono dim">${day(decision.ts)} · ${esc(decision.status)} · ${esc(decision.id)}</small>` +
        `</div></article>`;
}

function workLink(slug: string, work: WorkState): string
{
    return `<a href="${esc(slug)}/${esc(work.id)}.html">${esc(work.id)}</a>`;
}

/* ── events ────────────────────────────────────────────────────────── */

// A confirmation carries no text of its own and a transition carries only
// an id, so the feed reads the log back against itself rather than
// printing an empty line.
function buildLabels(events: SelfEvent[]): Map<string, string>
{
    const labels = new Map<string, string>();
    for (const event of events)
    {
        if (event.type === "decision.proposed")
        {
            labels.set(event.id, String(event.payload.text));
        }
        if (event.type === "work.created")
        {
            labels.set(String(event.payload.work), String(event.payload.outcome));
        }
    }
    return labels;
}

function toFeed(events: SelfEvent[], labels: Map<string, string>): SummaryEvent[]
{
    return events.map((event) =>
        ({ id: event.id, ts: event.ts, type: event.type, text: firstLine(eventText(event, labels)) }));
}

function eventText(event: SelfEvent, labels: Map<string, string>): string
{
    const confirms = event.refs?.confirms;
    if (confirms !== undefined)
    {
        return labels.get(confirms) ?? "proposal confirmed";
    }
    const base = eventSummary(event);
    const work = typeof event.payload.work === "string" ? event.payload.work : event.refs?.work;
    if (work === undefined)
    {
        return base;
    }
    if (base === work)
    {
        return `${work} ${labels.get(work) ?? ""}`.trim();
    }
    return base.startsWith(work) ? base : `${work} ${base}`;
}

function eventRow(event: SummaryEvent, project?: string): string
{
    const kind = eventKind(event.type);
    const label = project === undefined ? esc(event.text) : `${esc(project)} · ${esc(event.text)}`;
    return `<div class="c2-ev"><time>${event.ts.slice(5, 16).replace("T", " ")}</time>` +
        `<code class="e-${kind}">${esc(kind)}</code><span>${label}</span>` +
        `<em>${esc(shortId(event.id))}</em></div>`;
}

function eventKind(type: string): string
{
    const head = type.split(".")[0];
    return head === "decision" ? "decide" : head;
}

function eventPanel(events: SummaryEvent[], total: number, href: string): string
{
    if (events.length === 0)
    {
        return panel("EVENTS", 0, href, empty("no events yet"));
    }
    return `<section class="c2-panel c2-feed" aria-label="events">` +
        `<div class="c2-panel-head"><h2>EVENTS</h2><span class="c2-live">live</span>` +
        `<a class="c2-open" href="${esc(href)}" aria-label="open events">↗</a></div>` +
        events.map((event) => eventRow(event)).join("\n") +
        more(total, events.length, href, "event log") + `</section>`;
}

/* ── artifacts ─────────────────────────────────────────────────────── */

interface ArtifactRow
{
    meta: ArtifactMeta;
    workId: string;
    ts: string;
    project?: string;
}

function artifactRows(model: ProjectModel): ArtifactRow[]
{
    return model.works.flatMap(workArtifactRows).sort((a, b) => b.ts.localeCompare(a.ts));
}

function workArtifactRows(work: WorkState): ArtifactRow[]
{
    return work.reports.flatMap((report) =>
        report.artifacts.map((meta) => ({ meta, workId: work.id, ts: report.ts })));
}

// prefix walks from the page's directory back to the store root, where the
// ingested artifact bytes live.
function artifactRow(row: ArtifactRow, prefix: string): string
{
    const href = esc(`${prefix}/${row.meta.path}`);
    const thumb = isImage(row.meta.name)
        ? `<img src="${href}" alt="" loading="lazy">`
        : `<i class="dr-doc">${esc(extOf(row.meta.name))}</i>`;
    return `<a class="dr-art" href="${href}">${thumb}` +
        `<span><b>${esc(row.meta.name)}</b>` +
        `<small>${esc(row.meta.id)} · ${esc(row.project ?? row.workId)}</small></span></a>`;
}

function artifactCard(row: ArtifactRow, slug: string): string
{
    const href = esc(`../../${row.meta.path}`);
    const plate = isImage(row.meta.name)
        ? `<img class="af-plate" src="${href}" alt="" loading="lazy">`
        : `<i class="af-plate af-doc">${esc(extOf(row.meta.name))}</i>`;
    return `<article class="af-card"><a href="${href}">${plate}</a><div class="af-meta">` +
        `<b>${esc(row.meta.name)}</b><small class="mono">${esc(row.meta.id)}</small>` +
        `<small><a href="${esc(row.workId)}.html">${esc(row.workId)}</a> · ${esc(slug)}</small>` +
        `<small class="mono dim">${day(row.ts)}</small></div></article>`;
}

function isImage(name: string): boolean
{
    return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);
}

function extOf(name: string): string
{
    const match = /\.([^.]+)$/.exec(name);
    return match === null ? "file" : match[1].toLowerCase();
}

/* ── text helpers ──────────────────────────────────────────────────── */

function count(n: number, word: string): string
{
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function day(ts: string): string
{
    return ts.slice(5, 10);
}

function stamp(): string
{
    return new Date().toISOString().slice(0, 16).replace("T", " ");
}

function shortId(id: string): string
{
    return id.slice(0, 8);
}

function firstLine(text: string): string
{
    const line = text.split("\n", 1)[0];
    return line.length > 160 ? line.slice(0, 159) + "…" : line;
}

function esc(text: string): string
{
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ── page shell ────────────────────────────────────────────────────── */

function renderRail(rail: Rail): string
{
    const prefix = rail.depth === 0 ? "" : "../";
    const links = [
        `<a href="${prefix}workspace.html"${rail.active === undefined ? ` class="on"` : ""}>All projects</a>`,
        ...rail.projects.map((project) =>
            `<a href="${esc(prefix + project.slug)}.html"${project.slug === rail.active ? ` class="on"` : ""}>` +
            `${esc(project.slug)} <i class="dr-dot ${project.warn ? "warn" : "ok"}"></i></a>`)
    ];
    return `<aside class="dr-rail" aria-label="workspace rail">` +
        `<span class="c2-mark">self</span><p class="dr-ws">${esc(rail.workspace)}</p>` +
        `<nav class="dr-nav">${links.join("")}</nav>` +
        `<div class="dr-foot">fold ${esc(rail.foldId)}<br>${esc(rail.foldTime)} UTC</div></aside>`;
}

function page(shell: Shell): string
{
    const userTheme = USER_THEME === "" ? "" : `/* user theme — <store>/theme.css */\n${USER_THEME}\n`;
    const back = shell.back === undefined ? "" :
        `<a class="c2-back" href="${esc(shell.back)}" aria-label="back">←</a>`;
    const body = `<div class="sv-shell${shell.record === undefined ? " two" : ""}">` +
        renderRail(shell.rail) +
        `<div class="dr-main"><header class="c2-bar">${back}` +
        `<span class="c2-crumb">${shell.crumb}</span>` +
        `<span class="c2-query">${esc(shell.query)}</span></header>` +
        `<main class="c2-body${shell.doc === true ? " wd-doc" : ""}">\n${shell.main}\n</main></div>` +
        (shell.record === undefined ? "" : `<aside class="dr-side" aria-label="record column">${shell.record}</aside>`) +
        `</div>`;
    return `<!doctype html>
<html lang="${esc(LANG)}" data-theme="${esc(THEME)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(shell.title)} — superself</title>
<link rel="icon" href="${favicon()}">
<style>
/* design tokens — override via <store>/theme.css (docs/viewer-theming.md) */
${TOKENS}${themeBlocks()}${userTheme}/* layout — stable contract: restyle through tokens, never edit this file */
${LAYOUT_CSS}</style>
</head>
<body>
${body}
<script>${REFRESH_SCRIPT}</script>
</body>
</html>
`;
}

// The superself logo symbol — two interlocking crescents forming an S — as
// authored in the product repository (src/assets/icons/logo-symbol.svg, a
// 166×192 box filled with currentColor). Kept verbatim so the viewer and the
// product never draw slightly different marks.
const LOGO_SYMBOL = [
    "M137.954 26.8921C133.611 24.0908 129.082 22.0243 124.451 20.6696C120.622 15.8133 116.032 11.5655 110.752 8.16724C84.6518 -8.64033 51.2852 1.32481 36.2178 30.4281C21.1606 59.5313 30.1043 96.7514 56.2048 113.559C61.4948 116.969 67.0937 119.265 72.7645 120.539C57.728 101.481 54.4757 73.1244 66.4864 49.9221C78.4972 26.7313 102.128 15.687 124.451 20.6811C141.412 39.8077 145.58 69.9098 132.942 94.329L158.033 110.494C173.183 81.2182 164.198 43.7915 137.954 26.8921Z",
    "M108.874 78.4409C103.584 75.0312 97.9952 72.7236 92.314 71.4492C107.351 90.5185 110.603 118.876 98.5921 142.078C86.5814 165.28 62.951 176.324 40.6278 171.33C23.7798 152.284 19.7042 122.239 32.3427 97.8201L7.39499 81.7473C-7.75478 111.023 1.1169 148.369 27.207 165.177H27.1967C31.5194 167.955 36.0272 169.999 40.6278 171.342C44.4564 176.187 49.0466 180.423 54.3264 183.833C80.4268 200.64 113.793 190.675 128.861 161.572C143.918 132.469 134.974 95.2485 108.874 78.4409Z"
];

// The symbol on the page's own background, sized so a 16px tab keeps the
// crescents distinct: 12.5 of 16 units tall, centered. Inline SVG in a data:
// URI keeps the page free of network requests, and the fill takes the accent
// of the theme the page was rendered in.
function favicon(): string
{
    const accent = (THEMES[THEME] ?? THEMES.violet).accent;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>` +
        `<rect width='16' height='16' rx='3.5' fill='#101014'/>` +
        `<g fill='${accent}' transform='translate(2.6 1.75) scale(0.0651)'>` +
        LOGO_SYMBOL.map((d) => `<path d='${d}'/>`).join("") +
        `</g></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
}

// Reload to pick up refolds, but never while the reader is interacting:
// any pointer or key activity in the last 10s, or a live text selection, defers it.
const REFRESH_SCRIPT = `
let lastActivity = 0;
addEventListener("pointermove", () => lastActivity = Date.now());
addEventListener("keydown", () => lastActivity = Date.now());
setInterval(() => {
  if (Date.now() - lastActivity > 10000 && String(getSelection()) === "") location.reload();
}, 5000);
`;

// Every color, family, and surface flows from these tokens; a theme.css in
// the store root overrides them without touching the layout contract below.
// Accent is a theme, never a single brand color — and ok/warn are reserved
// for status meaning, so no theme may borrow them.
const TOKENS = `:root {
    --sv-bg: #101014;              /* page background */
    --sv-bg-bar: #131319;          /* app bar */
    --sv-bg-rail: #0c0c10;         /* workspace rail */
    --sv-bg-side: #0e0e13;         /* record column */
    --sv-surface: #14141a;         /* panel surface */
    --sv-surface-raised: #17171f;  /* query bar, active nav row */
    --sv-border: #232330;          /* frame borders */
    --sv-border-panel: #26262f;    /* panel borders */
    --sv-rule: #202029;            /* row hairlines */
    --sv-text: #f2f2f7;            /* headings */
    --sv-body: #d6d6de;            /* body text */
    --sv-muted: #8f8fa3;           /* labels */
    --sv-faint: #6e6e80;           /* ids, timestamps */
    --sv-ok: #34d399;              /* status only: settled, done, live */
    --sv-ok-line: #34d39944;
    --sv-warn: #f0a44b;            /* status only: health, blocked */
    --sv-warn-line: #f0a44b44;
    --sv-accent: #a78bfa;          /* themeable — see data-theme below */
    --sv-accent-soft: #a78bfa1a;
    --sv-accent-line: #a78bfa4d;
    --sv-sans: "Inter", "Pretendard Variable", Pretendard, -apple-system, "Apple SD Gothic Neo", "Segoe UI", sans-serif;
    --sv-mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --sv-rail-w: 180px;
    --sv-side-w: 300px;
    --sv-main-max: 1040px;
    --sv-doc-max: 760px;
    --sv-panel-gap: 20px;
    --sv-radius: 10px;
}
`;

function themeBlocks(): string
{
    return Object.entries(THEMES)
        .map(([name, set]) => `[data-theme="${name}"] { --sv-accent: ${set.accent};` +
            ` --sv-accent-soft: ${set.soft}; --sv-accent-line: ${set.line}; }`)
        .join("\n") + "\n";
}

const LAYOUT_CSS = `* { box-sizing: border-box; }
body { margin: 0; background: var(--sv-bg); color: var(--sv-body);
       font: 12.5px/1.5 var(--sv-sans); word-break: keep-all; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--sv-accent); outline-offset: 2px; }
.sv-shell { display: grid; grid-template-columns: var(--sv-rail-w) minmax(0, 1fr) var(--sv-side-w);
            min-height: 100vh; align-items: start; }
.sv-shell.two { grid-template-columns: var(--sv-rail-w) minmax(0, 1fr); }

.dr-rail { position: sticky; top: 0; height: 100vh; overflow: auto; display: flex; flex-direction: column;
           background: var(--sv-bg-rail); border-right: 1px solid var(--sv-border); padding: 16px 14px; }
.c2-mark { font: 700 13px var(--sv-mono); color: var(--sv-accent); }
.dr-ws { margin: 14px 0 6px; font: 9px var(--sv-mono); letter-spacing: .14em;
         color: var(--sv-faint); text-transform: uppercase; }
.dr-nav { display: flex; flex-direction: column; gap: 2px; }
.dr-nav a { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--sv-muted);
            padding: 7px 10px; border-radius: 6px; text-decoration: none; border: 1px solid transparent; }
.dr-nav a:hover { color: var(--sv-text); }
.dr-nav a.on { background: var(--sv-surface-raised); color: var(--sv-text); border-color: var(--sv-border-panel); }
.dr-dot { width: 6px; height: 6px; border-radius: 50%; margin-left: auto; flex: none; }
.dr-dot.ok { background: var(--sv-ok); }
.dr-dot.warn { background: var(--sv-warn); }
.dr-foot { margin-top: auto; padding-top: 18px; font: 10px/1.6 var(--sv-mono); color: var(--sv-faint); }

.dr-main { min-width: 0; }
.c2-bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 14px;
          padding: 12px 24px; background: var(--sv-bg-bar); border-bottom: 1px solid var(--sv-border); }
.c2-back { font: 13px/1 var(--sv-mono); color: var(--sv-muted); text-decoration: none;
           border: 1px solid var(--sv-border); border-radius: 6px; padding: 5px 9px;
           background: var(--sv-surface-raised); }
.c2-back:hover { color: var(--sv-text); }
.c2-crumb { font-size: 12px; color: var(--sv-muted); min-width: 0; overflow: hidden;
            white-space: nowrap; text-overflow: ellipsis; }
.c2-crumb b { color: var(--sv-text); font-weight: 600; }
.c2-crumb a { color: var(--sv-muted); text-decoration: none; }
.c2-crumb a:hover { color: var(--sv-text); }
.c2-query { margin-left: auto; font: 11px var(--sv-mono); color: var(--sv-faint);
            background: var(--sv-surface-raised); border: 1px solid var(--sv-border);
            border-radius: 6px; padding: 5px 10px; white-space: nowrap; }
.c2-body { display: flex; flex-direction: column; gap: 16px; padding: 20px 22px 44px;
           max-width: var(--sv-main-max); width: 100%; margin: 0 auto; }
.c2-body.wd-doc { max-width: var(--sv-doc-max); }
.c2-goal { margin: 0; font: 600 17px/1.4 var(--sv-sans); letter-spacing: -.01em; color: var(--sv-text); }
.c2-note { margin: 0; font: 11px var(--sv-mono); color: var(--sv-faint); }

.c2-panel { background: var(--sv-surface); border: 1px solid var(--sv-border-panel);
            border-radius: var(--sv-radius); padding: 16px 20px 12px; }
.c2-attention { border-color: var(--sv-accent-line); }
.c2-panel-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.c2-panel-head h2 { margin: 0; font: 600 10px var(--sv-mono); letter-spacing: .14em; color: var(--sv-muted); }
.c2-count { font: 10px var(--sv-mono); background: var(--sv-accent-soft); color: var(--sv-accent);
            border-radius: 4px; padding: 1px 7px; }
.c2-open { margin-left: auto; font: 11px var(--sv-mono); color: var(--sv-faint); text-decoration: none; }
.c2-open:hover { color: var(--sv-accent); }
.c2-empty { margin: 0 0 6px; color: var(--sv-faint); }
.c2-more { display: flex; justify-content: space-between; align-items: center; margin-top: 8px;
           padding: 8px 0 4px; border-top: 1px solid var(--sv-rule); font: 10.5px var(--sv-mono);
           color: var(--sv-faint); text-decoration: none; }
.c2-more span:last-child { color: var(--sv-accent); }
.c2-fold > summary { cursor: pointer; font: 10.5px var(--sv-mono); color: var(--sv-faint);
                     padding: 8px 0 4px; border-top: 1px solid var(--sv-rule); }
.c2-fold > summary:hover { color: var(--sv-body); }

table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
td { padding: 9px 12px 9px 0; border-bottom: 1px solid var(--sv-rule); vertical-align: top; line-height: 1.5; }
tr:last-child td { border-bottom: 0; }
td.k { font: 11px var(--sv-mono); color: var(--sv-accent); width: 78px; white-space: nowrap; }
td.k.warn { color: var(--sv-warn); }
td.n { font: 11px var(--sv-mono); color: var(--sv-faint); width: 86px; white-space: nowrap; }
td.n a { color: var(--sv-muted); text-decoration: none; }
td.n a:hover { color: var(--sv-accent); }
td.act { font: 11px var(--sv-mono); color: var(--sv-accent); text-align: right; width: 64px; white-space: nowrap; }
td.act a { text-decoration: none; }
td.r { text-align: right; width: 78px; }
.hf-sub { display: block; font-size: 11px; color: var(--sv-faint); margin-top: 3px; }

.pill { font: 9.5px var(--sv-mono); padding: 2px 8px; border-radius: 4px; border: 1px solid; }
.p-active { color: var(--sv-accent); border-color: var(--sv-accent-line); }
.p-done { color: var(--sv-ok); border-color: var(--sv-ok-line); }
.p-blocked { color: var(--sv-warn); border-color: var(--sv-warn-line); }
.p-next { color: var(--sv-faint); border-color: var(--sv-border-panel); }

.c2-live { font: 9px var(--sv-mono); color: var(--sv-ok); border: 1px solid var(--sv-ok-line);
           border-radius: 4px; padding: 1px 6px; letter-spacing: .1em; }
.c2-ev { display: flex; align-items: baseline; gap: 14px; font: 11.5px var(--sv-mono);
         padding: 6px 0; border-bottom: 1px solid var(--sv-rule); }
.c2-ev:last-child { border-bottom: 0; }
.c2-ev time { color: var(--sv-faint); white-space: nowrap; }
.c2-ev code { white-space: nowrap; }
.c2-ev span { flex: 1; min-width: 0; font: 12.5px var(--sv-sans); color: var(--sv-body); }
.c2-ev em { font-style: normal; color: var(--sv-faint); white-space: nowrap; }
.c2-ev .e-report { color: var(--sv-ok); }
.c2-ev .e-decide { color: var(--sv-accent); }
.c2-ev .e-work, .c2-ev .e-goal, .c2-ev .e-convention { color: var(--sv-muted); }

.dr-side { position: sticky; top: 0; height: 100vh; overflow: auto; display: flex; flex-direction: column;
           gap: 16px; padding: 20px 18px; background: var(--sv-bg-side);
           border-left: 1px solid var(--sv-border); }
.dr-dec { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--sv-rule); }
.dr-dec:last-child { border-bottom: 0; }
.dr-dec time { font: 10px var(--sv-mono); color: var(--sv-faint); padding-top: 2px; white-space: nowrap; }
.dr-dec p { margin: 0; font-size: 12px; line-height: 1.45; }
.dr-dec a { color: var(--sv-muted); }
.dr-prop { font: 9px var(--sv-mono); font-style: normal; color: var(--sv-accent);
           border: 1px solid var(--sv-accent-line); border-radius: 4px; padding: 0 5px; margin-left: 6px; }
.dr-evi { display: flex; align-items: baseline; gap: 8px; padding: 7px 0;
          border-bottom: 1px solid var(--sv-rule); font: 11.5px var(--sv-mono); }
.dr-evi:last-child { border-bottom: 0; }
.dr-evi .n { color: var(--sv-body); }
.dr-evi i { margin-left: auto; font-style: normal; font-size: 9.5px; color: var(--sv-faint); }
.dr-evi .v-settled { color: var(--sv-ok); }
.dr-evi .v-abandoned, .dr-evi .v-unverifiable { color: var(--sv-warn); }
.dr-art { display: flex; align-items: center; gap: 10px; padding: 6px 0;
          border-bottom: 1px solid var(--sv-rule); text-decoration: none; }
.dr-art:last-child { border-bottom: 0; }
.dr-art img, .dr-art .dr-doc { width: 44px; height: 30px; flex: none; object-fit: cover;
          border: 1px solid var(--sv-border-panel); border-radius: 5px; background: var(--sv-surface-raised); }
.dr-art .dr-doc { display: flex; align-items: center; justify-content: center;
          font: 9px var(--sv-mono); font-style: normal; color: var(--sv-faint); }
.dr-art span { min-width: 0; }
.dr-art b { display: block; font-size: 11.5px; font-weight: 600; color: var(--sv-body);
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-art small { font: 9.5px var(--sv-mono); color: var(--sv-faint); }

.wd-head { display: flex; align-items: center; gap: 10px; }
.wd-head .n { font: 11px var(--sv-mono); color: var(--sv-faint); }
.wd-title { margin: 0; font: 650 22px/1.35 var(--sv-sans); letter-spacing: -.01em; color: var(--sv-text); }
.wd-meta { display: flex; flex-wrap: wrap; gap: 8px; }
.wd-chip { font: 10.5px var(--sv-mono); color: var(--sv-muted); background: var(--sv-surface-raised);
           border: 1px solid var(--sv-border); border-radius: 4px; padding: 3px 8px; }
.wd-note { margin: 0; padding: 10px 14px; font-size: 12.5px; color: var(--sv-warn);
           background: var(--sv-surface); border: 1px solid var(--sv-warn-line); border-radius: var(--sv-radius); }
.wd-report { background: var(--sv-surface); border: 1px solid var(--sv-border-panel);
             border-radius: var(--sv-radius); padding: 18px 22px; }
.wd-report.is-past { opacity: .75; }
.wd-report-head { display: flex; justify-content: space-between; font: 11px var(--sv-mono);
                  color: var(--sv-faint); margin-bottom: 10px; }
.wd-prose { white-space: pre-wrap; font-size: 13.5px; line-height: 1.65; color: var(--sv-body); }

.af-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sv-panel-gap); }
.af-card { background: var(--sv-surface); border: 1px solid var(--sv-border-panel);
           border-radius: var(--sv-radius); overflow: hidden; }
.af-plate { display: block; width: 100%; height: 150px; object-fit: cover;
            border-bottom: 1px solid var(--sv-rule); background: var(--sv-surface-raised); }
.af-doc { display: flex; align-items: center; justify-content: center;
          font: 13px var(--sv-mono); font-style: normal; color: var(--sv-faint); }
.af-meta { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 3px; }
.af-meta b { font-size: 13px; font-weight: 600; color: var(--sv-text); overflow-wrap: anywhere; }
.af-meta small { font-size: 11px; color: var(--sv-muted); line-height: 1.45; overflow-wrap: anywhere; }
.af-meta .mono { font-family: var(--sv-mono); }
.af-meta .dim { color: var(--sv-faint); }
.af-meta a, .dr-dec a { text-decoration: none; color: var(--sv-muted); }
.af-meta a:hover, .dr-dec a:hover { color: var(--sv-accent); }
.af-text b { font-weight: 500; line-height: 1.5; }

@media (max-width: 68rem) {
    .sv-shell, .sv-shell.two { grid-template-columns: 1fr; }
    .dr-rail { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center;
               gap: 10px; border-right: 0; border-bottom: 1px solid var(--sv-border); }
    .dr-ws { margin: 0; }
    .dr-nav { flex-direction: row; flex-wrap: wrap; }
    .dr-foot { margin: 0 0 0 auto; padding-top: 0; }
    .dr-side { position: static; height: auto; border-left: 0; border-top: 1px solid var(--sv-border); }
    .c2-query { display: none; }
    .af-grid { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;
