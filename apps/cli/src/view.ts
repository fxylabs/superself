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
const EVENT_TAIL = 8;

// Optional localization layer, unused by default: human-facing labels are
// English-base and scan-only chrome is not translated. `self lang` still
// records the workspace language, which reaches the html lang attribute.
// Kept until the retire-localization proposal is confirmed or rejected.
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
        openQuestions: model.openQuestions
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
    const proposed = model.decisions.filter((d) => d.status === "proposed" && !d.expired);
    const notes = [...model.health, ...model.openQuestions];
    if (proposed.length > 0)
    {
        notes.push(`${proposed.length} proposed ${proposed.length === 1 ? "decision awaits" : "decisions await"} confirmation — see the decision ledger`);
    }
    const body = [
        `<a class="crumb" href="workspace.html">← workspace</a>`,
        `<p class="eyebrow">Project record</p>`,
        `<header><h1>${esc(model.slug)}</h1>${model.description === undefined ? "" : `<p class="desc">${esc(model.description)}</p>`}</header>`,
        `<p class="goal"><em>${esc(model.goal ?? "goal not set")}</em></p>`,
        noteBand(notes),
        cardSection("Work in progress", [...active, ...blocked].map((w) => workCard(model.slug, w, verdicts))),
        cardSection("Next", next.map((w) => workCard(model.slug, w, verdicts))),
        ledger("Decision ledger", decisionRows(model.decisions)),
        ledger("Conventions", model.conventions.map((c) => row(c.ts, `<p>${esc(c.text)}</p><p class="id">${esc(c.id)}</p>`))),
        plates("Artifacts", artifactRows(model), ".."),
        eventLog("Recent events", events),
        ledger("Done", done.map((w) => row(w.lastEventTs, `<p>${workLink(model.slug, w)} ${esc(w.outcome)}</p>`))),
        pageFooter()
    ].join("\n");
    return page(model.slug, body);
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

function workCard(slug: string, work: WorkState, verdicts: Record<string, Verdict>): string
{
    const latest = work.reports[work.reports.length - 1];
    const parts = [
        `<div class="work ${work.status}"><h3>${workLink(slug, work)} ${esc(work.outcome)}</h3>`
    ];
    if (work.status === "blocked")
    {
        parts.push(`<p class="alert">waiting on ${esc(work.blockedOn ?? "?")}${work.blockedWhy === undefined ? "" : `: ${esc(work.blockedWhy)}`}</p>`);
    }
    if (latest !== undefined)
    {
        parts.push(`<p>${esc(firstLine(latest.text))} <span class="meta">(${latest.ts.slice(0, 10)})</span></p>`);
    }
    if (work.next !== undefined)
    {
        parts.push(`<p class="meta">next: ${esc(work.next)}</p>`);
    }
    const meta = [
        work.artifacts.length > 0 ? count(work.artifacts.length, "artifact") : "",
        work.reports.length > 0 ? count(work.reports.length, "report") : "",
        work.evidence.length > 0 ? `evidence ${work.evidence.map((c) => hashChip(c, verdicts)).join(" ")}` : ""
    ].filter((part) => part !== "");
    if (meta.length > 0)
    {
        parts.push(`<p class="meta">${meta.join(" · ")}</p>`);
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
// the ingested artifact files live.
function plates(title: string, rows: ArtifactRow[], prefix: string): string
{
    if (rows.length === 0)
    {
        return "";
    }
    const items = rows.map((rowItem) =>
    {
        const href = esc(`${prefix}/${rowItem.meta.path}`);
        const ext = rowItem.meta.name.replace(/^.*(\.[^.]+)$/, "$1");
        const thumb = isImage(rowItem.meta.name)
            ? `<img src="${href}" alt="" loading="lazy">`
            : `<div class="doc">${esc(ext)}</div>`;
        return `<a class="plate" href="${href}"><figure>${thumb}` +
            `<figcaption>${esc(rowItem.meta.name)}<span>${esc(rowItem.meta.id)} · ${esc(rowItem.workId)} · ${rowItem.ts.slice(0, 10)}</span></figcaption></figure></a>`;
    });
    return `<section><h2>${title}</h2>\n<div class="plates">${items.join("\n")}</div></section>`;
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
    const cards = summaries.map((summary) => [
        `<a class="project" href="${esc(summary.slug)}.html"><h2>${esc(summary.slug)}</h2>`,
        summary.description === undefined ? "" : `<p class="desc">${esc(summary.description)}</p>`,
        `<p class="goal-line">${esc(summary.goal ?? "goal not set")}</p>`,
        `<p class="counts">${countSpan(summary.active.length, "active")} · ${countSpan(summary.blockedCount, "blocked")} · ${countSpan(summary.nextCount, "next")} · ${countSpan(summary.doneCount, "done")}</p>`,
        summary.active.map((w) => `<p><code>${esc(w.id)}</code> ${esc(w.outcome)}</p>`).join("\n"),
        [...summary.health, ...summary.openQuestions].map((n) => `<p class="alert">${esc(n)}</p>`).join("\n"),
        `<footer>updated ${summary.updated.slice(0, 16).replace("T", " ")} UTC</footer></a>`
    ].join("\n")).join("\n");
    const body = [
        `<p class="eyebrow">Workspace record</p>`,
        `<header><h1>Workspace</h1></header>`,
        `<div class="projects">${cards}</div>`,
        pageFooter()
    ].join("\n");
    return page("Workspace", body, true);
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

function cardSection(title: string, items: string[]): string
{
    return items.length === 0 ? "" : `<section><h2>${title}</h2>\n${items.join("\n")}</section>`;
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
    return `<footer>superself record · updated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · generated from the event log</footer>`;
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
    --serif: "Iowan Old Style", "Palatino", Palatino, "Nanum Myeongjo", serif;
    --sans: -apple-system, "Apple SD Gothic Neo", "Segoe UI", sans-serif;
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
h1 { font: 600 30px/1.2 var(--serif); margin: .6rem 0 .2rem; letter-spacing: -.01em; }
h1 code { font: 600 24px var(--mono); }
.desc { color: var(--ink-soft); margin: 0; }
.goal { font: 400 21px/1.5 var(--serif); margin: 1.2rem 0 0; }
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
.project { display: block; background: var(--card); border: 1px solid var(--rule);
           border-top: 3px solid var(--seal); border-radius: 3px; padding: 1rem 1.2rem;
           color: inherit; text-decoration: none; }
.project:hover { border-color: var(--seal); }
.project h2 { font: 600 19px var(--serif); border: 0; padding: 0; margin: 0;
              text-transform: none; letter-spacing: 0; color: var(--ink); }
.project .goal-line { font: 400 15px/1.5 var(--serif); margin: .5rem 0 0; }
.project p { margin: .35rem 0 0; }
.project footer { margin-top: .8rem; }
.counts { font: 12px var(--mono); color: var(--ink-soft); }
.counts b { font-weight: 600; }
.counts .on-active { color: var(--seal); }
.counts .on-blocked { color: var(--note); }
.counts .zero { opacity: .55; }
footer { margin-top: 3.5rem; color: var(--ink-soft); font: 12px var(--mono); }
ul { padding-left: 1.3rem; margin: .4rem 0; }
li { margin: .3rem 0; }
`;
