import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { excludeLocally } from "./gitutil.js";
import { eventSummary, readEvents } from "./logfile.js";
import { DecisionState, ProjectModel, WorkState } from "./model.js";
import { CliContext, ensureDir } from "./paths.js";
import { Verdict } from "./reachability.js";
import { ArtifactMeta, CliError, SelfEvent } from "./types.js";

const VIEW_DIR = "view";
const THEME_FILE = "theme.css";
const EVENT_TAIL = 15;
const DECISION_ROWS = 5;
const PROJECT_ARTIFACTS = 6;
const SUMMARY_ARTIFACTS = 4;
const WORKSPACE_ARTIFACTS = 8;

// Optional localization layer, unused by default: view labels are
// English-base and scan-only chrome is not translated. The workspace
// language set by `self lang` is the language agents write human-facing
// documents and artifacts in; here it only reaches the html lang attribute.
const STRINGS: Record<string, Record<string, string>> = {
    ko: {
        "Workspace": "워크스페이스",
        "workspace": "워크스페이스",
        "Work in progress": "진행 중인 작업",
        "Blocked": "막힌 작업",
        "Next": "다음 작업",
        "Open questions": "열린 질문",
        "Decisions": "결정",
        "Proposed decisions": "제안된 결정",
        "Conventions": "컨벤션",
        "Artifacts": "산출물",
        "Done": "완료된 작업",
        "Reports (latest first)": "보고 (최신순)",
        "updated": "갱신",
        "goal not set": "목표 미설정",
        "created": "생성",
        "last event": "마지막 이벤트",
        "next action": "다음 행동",
        "evidence": "증거",
        "waiting on": "대기:",
        "confirm with": "확인 명령",
        "report(s)": "보고",
        "work unit(s) done": "작업 완료",
        "active": "진행",
        "blocked": "막힘",
        "next": "다음",
        "done": "완료"
    }
};

let LANG = "en";
let USER_THEME = "";

function t(key: string): string
{
    return STRINGS[LANG]?.[key] ?? key;
}

interface SummaryArtifact
{
    id: string;
    name: string;
    path: string;
    workId: string;
    ts: string;
}

// proposedCount and recentArtifacts are optional so the workspace renderer
// tolerates stale *.json summaries written before they existed — other
// projects refold lazily.
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
}

export function writeViews(storeDir: string, model: ProjectModel, lang: string, verdicts: Record<string, Verdict> = {}): void
{
    LANG = lang;
    USER_THEME = readUserTheme(storeDir);
    const dir = ensureDir(join(storeDir, VIEW_DIR));
    excludeLocally(storeDir, VIEW_DIR + "/");
    excludeLocally(storeDir, THEME_FILE);
    const events = readEvents(storeDir, model.slug).slice(-EVENT_TAIL).reverse();
    writeFileSync(join(dir, `${model.slug}.html`), renderProjectPage(model, events, verdicts));
    writeFileSync(join(dir, `${model.slug}.json`), JSON.stringify(summarize(model)) + "\n");
    writeFileSync(join(dir, "workspace.html"), renderWorkspacePage(readSummaries(dir)));
    const workDir = ensureDir(join(dir, model.slug));
    for (const work of model.works)
    {
        writeFileSync(join(workDir, `${work.id}.html`), renderWorkPage(model.slug, work, verdicts));
    }
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

function summarize(model: ProjectModel): ProjectSummary
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
        recentArtifacts: artifactRows(model).slice(0, SUMMARY_ARTIFACTS)
            .map((r) => ({ id: r.meta.id, name: r.meta.name, path: r.meta.path, workId: r.workId, ts: r.ts }))
    };
}

function readSummaries(dir: string): ProjectSummary[]
{
    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as ProjectSummary)
        .sort((a, b) => a.slug.localeCompare(b.slug));
}

function renderProjectPage(model: ProjectModel, events: SelfEvent[], verdicts: Record<string, Verdict>): string
{
    const active = model.works.filter((w) => w.status === "active");
    const blocked = model.works.filter((w) => w.status === "blocked");
    const next = model.works.filter((w) => w.status === "next");
    const done = model.works.filter((w) => w.status === "done");
    const counts = [countSpan(active.length, "active"), countSpan(blocked.length, "blocked"),
        countSpan(next.length, "next"), countSpan(done.length, "done")].join(" · ");
    const queue = next.map((w) => `<li>${workLink(model.slug, w)} ${esc(w.outcome)}</li>`).join("\n");
    const body = [
        `<a class="crumb" href="workspace.html">← workspace</a>`,
        `<p class="eyebrow">Project record</p>`,
        `<header class="board-head"><h1>${esc(model.slug)}</h1>` +
            (model.description === undefined ? "" : `<span class="desc">${esc(model.description)}</span>`) +
            `<span class="goal-line">${esc(model.goal ?? "goal not set")}</span>` +
            `<span class="counts">${counts}</span>` +
            `<span class="stamp">updated ${stamp()} UTC</span></header>`,
        attentionBand(model, blocked),
        `<div class="board">`,
        plates("Artifacts", artifactRows(model), "..", ` class="span"`, "no artifacts yet", PROJECT_ARTIFACTS),
        panel("In progress", active.map((w) => workCard(model.slug, w, verdicts)), "no active work"),
        panel("Next", queue === "" ? [] : [`<ul class="queue">${queue}</ul>`], "queue is empty"),
        events.length === 0 ? panel("Recent events", [], "no events yet") : eventLog("Recent events", events),
        `</div>`,
        decisionSection(model.decisions),
        foldSection("Conventions", model.conventions.map((c) => row(c.ts, `<p>${esc(c.text)}</p><p class="id">${esc(c.id)}</p>`))),
        foldSection("Done", done.map((w) => row(w.lastEventTs, `<p>${workLink(model.slug, w)} ${esc(w.outcome)}</p>`))),
        pageFooter()
    ].join("\n");
    return page(model.slug, body, true);
}

// Everything that waits on the reader, in one band under the header; an
// explicit empty state so absence reads as information, not omission.
function attentionBand(model: ProjectModel, blocked: WorkState[]): string
{
    // the model already turns decision-blocked work into an open question;
    // the blocked entry carries the link, so drop the generated duplicate
    const generated = new Set(blocked.map((w) => `${w.id} is waiting on a decision: ${w.blockedWhy ?? w.outcome}`));
    const proposed = model.decisions.filter((d) => d.status === "proposed" && !d.expired);
    const items = [
        ...blocked.map((w) => att("blocked", `${workLink(model.slug, w)} ${esc(w.outcome)} — waiting on ${esc(w.blockedOn ?? "?")}${w.blockedWhy === undefined ? "" : `: ${esc(w.blockedWhy)}`}`)),
        ...model.health.map((h) => att("health", esc(h))),
        ...proposed.map((d) => att("proposal", `${esc(d.text)} · <code>self decide confirm ${esc(d.id)}</code>`)),
        ...model.openQuestions.filter((q) => !generated.has(q)).map((q) => att("question", esc(q)))
    ];
    return items.length === 0
        ? `<div class="attention calm"><p>nothing waiting on you</p></div>`
        : `<div class="attention">${items.join("\n")}</div>`;
}

function att(kind: string, body: string): string
{
    return `<p class="att"><b class="kind">${kind}</b> ${body}</p>`;
}

function panel(title: string, items: string[], empty: string): string
{
    return `<section><h2>${title}</h2>\n${items.length === 0 ? `<p class="empty">${esc(empty)}</p>` : items.join("\n")}</section>`;
}

function decisionSection(decisions: DecisionState[]): string
{
    const rows = decisionRows(decisions);
    if (rows.length === 0)
    {
        return "";
    }
    const rest = rows.slice(DECISION_ROWS);
    const fold = rest.length === 0 ? "" :
        `\n<details class="fold"><summary>${count(rest.length, "earlier decision")}</summary>\n${rest.join("\n")}</details>`;
    return `<section><h2>Decisions</h2>\n${rows.slice(0, DECISION_ROWS).join("\n")}${fold}</section>`;
}

function foldSection(title: string, rows: string[]): string
{
    return rows.length === 0 ? "" :
        `<section><details class="fold"><summary>${title} · ${rows.length}</summary>\n${rows.join("\n")}</details></section>`;
}

function noteBand(notes: string[]): string
{
    return notes.length === 0 ? "" : `<div class="note-band">${notes.map((n) => `<p>${esc(n)}</p>`).join("")}</div>`;
}

function decisionRows(decisions: DecisionState[]): string[]
{
    return decisions
        .filter((d) => d.status === "confirmed" || (d.status === "proposed" && !d.expired))
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .map((d) =>
        {
            const why = [
                d.why === undefined ? "" : esc(d.why),
                d.status === "proposed" ? `<code>self decide confirm ${esc(d.id)}</code>` : ""
            ].filter((part) => part !== "").join(" · ");
            const body = `<p>${esc(d.text)}</p>` +
                (why === "" ? "" : `<p class="why">${why}</p>`) +
                `<p class="id">${esc(d.id)}</p>`;
            return row(d.ts, body, d.status === "proposed" ? " proposed" : "");
        });
}

function workLink(slug: string, work: WorkState): string
{
    return `<a href="${esc(slug)}/${esc(work.id)}.html"><code>${esc(work.id)}</code></a>`;
}

// Compressed card for the dashboard column: id, outcome, latest report
// first line, evidence chips — everything else lives on the work page.
function workCard(slug: string, work: WorkState, verdicts: Record<string, Verdict>): string
{
    const latest = work.reports[work.reports.length - 1];
    const parts = [
        `<div class="work ${work.status}"><h3>${workLink(slug, work)} ${esc(work.outcome)}</h3>`
    ];
    if (latest !== undefined)
    {
        parts.push(`<p>${esc(firstLine(latest.text))} <span class="meta">(${latest.ts.slice(0, 10)})</span></p>`);
    }
    if (work.evidence.length > 0)
    {
        parts.push(`<p class="meta">evidence ${work.evidence.map((c) => hashChip(c, verdicts)).join(" ")}</p>`);
    }
    return parts.join("\n") + "</div>";
}

function count(n: number, word: string): string
{
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function hashChip(hash: string, verdicts: Record<string, Verdict>): string
{
    const verdict = verdicts[hash];
    return verdict === undefined
        ? `<span class="hash"><b>${esc(hash)}</b></span>`
        : `<span class="hash v-${verdict}"><b>${esc(hash)}</b> ${verdict}</span>`;
}

function renderWorkPage(slug: string, work: WorkState, verdicts: Record<string, Verdict>): string
{
    const facts = [
        `<li>created ${work.ts.slice(0, 10)} · last event ${work.lastEventTs.slice(0, 10)}</li>`
    ];
    if (work.next !== undefined)
    {
        facts.push(`<li>next: ${esc(work.next)}</li>`);
    }
    if (work.evidence.length > 0)
    {
        facts.push(`<li>evidence ${work.evidence.map((c) => hashChip(c, verdicts)).join(" ")}</li>`);
    }
    const reports = [...work.reports].reverse().map((report) =>
        row(report.ts,
            (report.commits.length > 0 ? `<p class="id">${report.commits.map((c) => `<code>${esc(c)}</code>`).join(" ")}</p>` : "") +
            `<div class="prose">${esc(report.text)}</div>`));
    const blockedNote = work.status === "blocked"
        ? noteBand([`waiting on ${work.blockedOn ?? "?"}${work.blockedWhy === undefined ? "" : `: ${work.blockedWhy}`}`])
        : "";
    const body = [
        `<a class="crumb" href="../${esc(slug)}.html">← ${esc(slug)}</a>`,
        `<p class="eyebrow">Work record · <span class="st st-${work.status}">${work.status}</span></p>`,
        `<header><h1><code>${esc(work.id)}</code></h1></header>`,
        `<p class="goal"><em>${esc(work.outcome)}</em></p>`,
        blockedNote,
        `<ul class="facts">${facts.join("\n")}</ul>`,
        plates("Artifacts", workArtifactRows(work), "../.."),
        ledger("Reports (latest first)", reports),
        pageFooter()
    ].join("\n");
    return page(`${work.id} — ${slug}`, body);
}

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

// prefix walks from the page's directory back up to the store root, where
// the ingested artifact files live. With an empty-state text the section
// renders even without rows, so the panel never silently vanishes; visible
// caps the open grid and folds the rest so the strip stays one glance tall.
function plates(title: string, rows: ArtifactRow[], prefix: string, cls = "", empty?: string, visible?: number): string
{
    if (rows.length === 0 && empty === undefined)
    {
        return "";
    }
    if (rows.length === 0)
    {
        return `<section${cls}><h2>${title}</h2>\n<p class="empty">${esc(empty ?? "")}</p></section>`;
    }
    const shown = rows.slice(0, visible ?? rows.length);
    const rest = rows.slice(visible ?? rows.length);
    const fold = rest.length === 0 ? "" :
        `\n<details class="fold"><summary>${count(rest.length, "earlier artifact")}</summary>` +
        `<div class="plates">${rest.map((r) => plate(r, prefix)).join("\n")}</div></details>`;
    return `<section${cls}><h2>${title}</h2>\n<div class="plates">${shown.map((r) => plate(r, prefix)).join("\n")}</div>${fold}</section>`;
}

function plate(rowItem: ArtifactRow, prefix: string): string
{
    const href = esc(`${prefix}/${rowItem.meta.path}`);
    const ext = rowItem.meta.name.replace(/^.*(\.[^.]+)$/, "$1");
    const thumb = isImage(rowItem.meta.name)
        ? `<img src="${href}" alt="" loading="lazy">`
        : `<div class="doc">${esc(ext)}</div>`;
    const caption = `${esc(rowItem.project ?? rowItem.meta.id)} · ${esc(rowItem.workId)} · ${rowItem.ts.slice(0, 10)}`;
    return `<a class="plate" href="${href}"><figure>${thumb}` +
        `<figcaption>${esc(rowItem.meta.name)}<span>${caption}</span></figcaption></figure></a>`;
}

function isImage(name: string): boolean
{
    return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);
}

function eventLog(title: string, events: SelfEvent[]): string
{
    if (events.length === 0)
    {
        return "";
    }
    const items = events.map((event) =>
        `<li><time>${event.ts.slice(5, 16).replace("T", " ")}</time><span class="type">${esc(event.type)}</span><span>${esc(firstLine(eventSummary(event)))}</span></li>`);
    return `<section><h2>${title}</h2>\n<ul class="log">${items.join("\n")}</ul></section>`;
}

function renderWorkspacePage(summaries: ProjectSummary[]): string
{
    const blockedTotal = summaries.reduce((n, s) => n + s.blockedCount, 0);
    const waitingTotal = summaries.reduce((n, s) => n + (s.proposedCount ?? 0) + s.openQuestions.length, 0);
    const healthTotal = summaries.reduce((n, s) => n + s.health.length, 0);
    const recent = summaries
        .flatMap((s) => (s.recentArtifacts ?? []).map((a) =>
            ({ meta: { id: a.id, name: a.name, path: a.path }, workId: a.workId, ts: a.ts, project: s.slug })))
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, WORKSPACE_ARTIFACTS);
    const cards = summaries.map((summary) => [
        `<div class="project"><h2><a href="${esc(summary.slug)}.html">${esc(summary.slug)}</a></h2>`,
        summary.description === undefined ? "" : `<p class="desc">${esc(summary.description)}</p>`,
        `<p class="goal-line">${esc(summary.goal ?? "goal not set")}</p>`,
        `<p class="counts">${countSpan(summary.active.length, "active")} · ${countSpan(summary.blockedCount, "blocked")} · ${countSpan(summary.nextCount, "next")} · ${countSpan(summary.doneCount, "done")}</p>`,
        summary.active.map((w) => `<p><a href="${esc(summary.slug)}/${esc(w.id)}.html"><code>${esc(w.id)}</code></a> ${esc(w.outcome)}</p>`).join("\n"),
        [...summary.health, ...summary.openQuestions].map((n) => `<p class="alert">${esc(n)}</p>`).join("\n"),
        `<footer>updated ${summary.updated.slice(0, 16).replace("T", " ")} UTC</footer></div>`
    ].join("\n")).join("\n");
    const body = [
        `<p class="eyebrow">Workspace record</p>`,
        `<header><h1>Workspace</h1></header>`,
        workspaceAttention(blockedTotal, waitingTotal, healthTotal),
        plates("Recent artifacts", recent, ".."),
        `<div class="projects">${cards}</div>`,
        pageFooter()
    ].join("\n");
    return page("Workspace", body, true);
}

// The workspace answers "is anything waiting on me?" before a single
// project card is read.
function workspaceAttention(blocked: number, waiting: number, health: number): string
{
    if (blocked + waiting + health === 0)
    {
        return `<div class="attention calm"><p>nothing waiting on you</p></div>`;
    }
    const line = [
        countSpan(blocked, "blocked"),
        countSpan(waiting, "waiting on you"),
        countSpan(health, health === 1 ? "health signal" : "health signals")
    ].join(" · ");
    return `<div class="attention"><p class="att counts">${line}</p></div>`;
}

function countSpan(n: number, label: string): string
{
    if (n === 0)
    {
        return `<span class="zero">0 ${label}</span>`;
    }
    const cls = label === "active" ? ` class="on-active"` : label === "blocked" ? ` class="on-blocked"` : "";
    return `<b${cls}>${n} ${label}</b>`;
}

function ledger(title: string, rows: string[]): string
{
    return rows.length === 0 ? "" : `<section><h2>${title}</h2>\n${rows.join("\n")}</section>`;
}

function row(ts: string, body: string, cls = ""): string
{
    return `<div class="row${cls}"><time>${ts.slice(0, 10)}</time><div class="body">${body}</div></div>`;
}

function pageFooter(): string
{
    return `<footer>superself record · updated ${stamp()} UTC · generated from the event log</footer>`;
}

function stamp(): string
{
    return new Date().toISOString().slice(0, 16).replace("T", " ");
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

function page(title: string, body: string, wide = false): string
{
    const userTheme = USER_THEME === "" ? "" : `/* user theme — <store>/theme.css */\n${USER_THEME}\n`;
    return `<!doctype html>
<html lang="${esc(LANG)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — superself</title>
<style>
/* theme tokens — override via <store>/theme.css (docs/viewer-theming.md) */
${DEFAULT_THEME}
${userTheme}/* layout — stable contract: restyle through tokens, never edit this file */
${LAYOUT_CSS}</style>
</head>
<body><main${wide ? ` class="wide"` : ""}>
${body}
</main>
<script>${REFRESH_SCRIPT}</script>
</body>
</html>
`;
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
const DEFAULT_THEME = `:root {
    --paper: #faf9f4;          /* page background */
    --ink: #182420;            /* primary text */
    --ink-soft: #5c6b62;       /* secondary text */
    --rule: #c9d6c9;           /* hairlines and borders */
    --seal: #1d5c43;           /* accent: links, active work, settled evidence */
    --note: #a34a2f;           /* attention: alerts, blocked work, proposals */
    --card: #ffffff;           /* raised surfaces */
    --mono: "SF Mono", ui-monospace, Menlo, monospace;
    --sans: "Inter", "Pretendard Variable", Pretendard, -apple-system, "Apple SD Gothic Neo", "Segoe UI", sans-serif;
}
`;

const LAYOUT_CSS = `* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink);
       font: 15px/1.65 var(--sans); word-break: keep-all; }
main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
main.wide { max-width: 64rem; }
a { color: var(--seal); }
code { font: .85em var(--mono); }
.crumb { font: 12px var(--mono); color: var(--ink-soft); text-decoration: none;
         letter-spacing: .04em; }
.crumb:hover { color: var(--ink); }
.eyebrow { font: 600 11px var(--mono); letter-spacing: .22em; text-transform: uppercase;
           color: var(--seal); margin: 2.4rem 0 .2rem; }
h1 { font: 700 26px/1.25 var(--sans); margin: .6rem 0 .2rem; letter-spacing: -.02em; }
h1 code { font: 600 22px var(--mono); }
.desc { color: var(--ink-soft); margin: 0; }
.goal { font: 500 19px/1.5 var(--sans); margin: 1.2rem 0 0; }
.goal em { font-style: normal;
           box-shadow: inset 0 -0.45em 0 color-mix(in srgb, var(--seal) 14%, transparent); }
.note-band { border-left: 3px solid var(--note); padding: .55rem 1rem; margin: 2rem 0 0;
             color: var(--note); background: color-mix(in srgb, var(--note) 6%, transparent); }
.note-band p { margin: .15rem 0; }
section { margin-top: 2.6rem; }
h2 { font: 600 12px var(--mono); letter-spacing: .2em; text-transform: uppercase;
     color: var(--ink-soft); border-bottom: 1px solid var(--ink);
     padding-bottom: .45rem; margin: 0 0 .2rem; }
.row { display: grid; grid-template-columns: 6.8rem 1fr; gap: 1rem;
       padding: .8rem 0; border-bottom: 1px solid var(--rule); }
.row time { font: 12px var(--mono); color: var(--ink-soft); padding-top: .25rem; }
.row .body p { margin: .2rem 0 0; }
.row .body > :first-child { margin-top: 0; }
.row .why { color: var(--ink-soft); }
.row .id { font: 11px var(--mono); color: var(--ink-soft); opacity: .8; }
.row.proposed .body > p:first-child::before { content: "proposed "; font: 600 11px var(--mono);
       color: var(--note); letter-spacing: .08em; }
.work { background: var(--card); border: 1px solid var(--rule); border-left: 3px solid var(--seal);
        border-radius: 3px; padding: .9rem 1.1rem; margin: .8rem 0; }
.work.blocked { border-left-color: var(--note); }
.work.next, .work.done { border-left-color: var(--rule); }
.work h3 { font: 600 15px var(--sans); margin: 0; }
.work h3 a { text-decoration: none; }
.work h3 code { color: var(--seal); }
.work p { margin: .35rem 0 0; }
.work .meta { color: var(--ink-soft); font-size: 13.5px; }
.alert { color: var(--note); }
.hash { font: 12px var(--mono); color: var(--ink-soft); white-space: nowrap; }
.hash b { font-weight: 500; color: var(--seal); }
.hash.v-provisional b { color: var(--ink-soft); }
.hash.v-abandoned b, .hash.v-unverifiable b { color: var(--note); }
.st { letter-spacing: .08em; }
.st-active { color: var(--seal); }
.st-blocked { color: var(--note); }
.st-next, .st-done { color: var(--ink-soft); }
.facts { list-style: none; padding: 0; margin: 1.6rem 0 0;
         color: var(--ink-soft); font-size: 13.5px; }
.facts li { margin: .3rem 0; }
.plates { display: grid; grid-template-columns: repeat(auto-fill, minmax(11.5rem, 1fr));
          gap: 1rem; margin-top: 1rem; }
.plate { text-decoration: none; color: inherit; }
figure { margin: 0; }
.plate img, .plate .doc { width: 100%; height: 6.4rem; object-fit: cover; display: block;
        border: 1px solid var(--rule); border-radius: 2px; background: var(--card); }
.plate .doc { display: flex; align-items: center; justify-content: center;
        font: 13px var(--mono); color: var(--ink-soft); }
.plate figcaption { font-size: 12.5px; margin-top: .4rem; overflow-wrap: anywhere; }
.plate figcaption span { display: block; font: 11px var(--mono); color: var(--ink-soft); }
.log { list-style: none; padding: 0; margin: .6rem 0 0; }
.log li { display: grid; grid-template-columns: 6.8rem 8.5rem 1fr; gap: 1rem;
          padding: .34rem 0; font-size: 13.5px; border-bottom: 1px dotted var(--rule); }
.log time, .log .type { font: 12px var(--mono); color: var(--ink-soft); }
.log .type { color: var(--seal); }
.prose { white-space: pre-wrap; }
.projects { display: grid; grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
            gap: 1rem; margin-top: 1.4rem; }
.project { background: var(--card); border: 1px solid var(--rule);
           border-top: 3px solid var(--seal); border-radius: 3px; padding: 1rem 1.2rem; }
.project h2 { font: 700 17px var(--sans); border: 0; padding: 0; margin: 0;
              text-transform: none; letter-spacing: 0; color: var(--ink); }
.project h2 a { color: inherit; text-decoration: none; }
.project h2 a:hover { color: var(--seal); }
.project a { text-decoration: none; }
.project .goal-line { font: 500 14.5px/1.5 var(--sans); margin: .5rem 0 0; }
.project p { margin: .35rem 0 0; }
.project footer { margin-top: .8rem; }
.counts { font: 12px var(--mono); color: var(--ink-soft); }
.counts b { font-weight: 600; }
.counts .on-active { color: var(--seal); }
.counts .on-blocked { color: var(--note); }
.counts .zero { opacity: .55; }
.board-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .35rem 1.1rem;
              margin: .8rem 0 0; }
.board-head h1 { font-size: 21px; margin: 0; }
.board-head .desc { margin: 0; }
.board-head .goal-line { font: 500 15px/1.5 var(--sans); margin: 0;
        box-shadow: inset 0 -0.4em 0 color-mix(in srgb, var(--seal) 12%, transparent); }
.stamp { font: 12px var(--mono); color: var(--ink-soft); }
.attention { border-left: 3px solid var(--note); padding: .6rem 1rem; margin: 1.7rem 0 0;
             background: color-mix(in srgb, var(--note) 6%, transparent); }
.attention .att { margin: .25rem 0; }
.attention .kind { font: 600 10.5px var(--mono); letter-spacing: .14em; text-transform: uppercase;
                   color: var(--note); margin-right: .4rem; }
.attention.calm { border-left-color: var(--rule); background: transparent; }
.attention.calm p { margin: .15rem 0; color: var(--ink-soft); }
.board { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr);
         gap: 2.2rem 1.8rem; margin-top: 2.6rem; }
.board section { margin-top: 0; }
.board .span { grid-column: 1 / -1; }
.board .log { max-height: 30rem; overflow-y: auto; }
.board .log li { display: block; padding: .4rem 0; }
.board .log li time, .board .log li .type { margin-right: .55rem; }
@media (max-width: 60rem) { .board { grid-template-columns: 1fr; } }
.queue { list-style: none; padding: 0; margin: .4rem 0 0; }
.queue li { margin: 0; padding: .5rem 0; border-bottom: 1px solid var(--rule); }
.queue a { text-decoration: none; }
.empty { color: var(--ink-soft); opacity: .85; }
.fold summary { cursor: pointer; font: 600 12px var(--mono); letter-spacing: .2em;
                text-transform: uppercase; color: var(--ink-soft); padding: .45rem 0; }
.fold summary:hover { color: var(--ink); }
.fold:first-child > summary { border-bottom: 1px solid var(--ink); margin-bottom: .2rem; }
footer { margin-top: 3.5rem; color: var(--ink-soft); font: 12px var(--mono); }
ul { padding-left: 1.3rem; margin: .4rem 0; }
li { margin: .3rem 0; }
`;
