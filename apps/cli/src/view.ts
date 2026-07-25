import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { excludeLocally } from "./gitutil.js";
import { ProjectModel, WorkState } from "./model.js";
import { CliContext, ensureDir } from "./paths.js";
import { CliError } from "./types.js";

const VIEW_DIR = "view";

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

export function writeViews(storeDir: string, model: ProjectModel): void
{
    const dir = ensureDir(join(storeDir, VIEW_DIR));
    excludeLocally(storeDir, VIEW_DIR + "/");
    writeFileSync(join(dir, `${model.slug}.html`), renderProjectPage(model));
    writeFileSync(join(dir, `${model.slug}.json`), JSON.stringify(summarize(model)) + "\n");
    writeFileSync(join(dir, "workspace.html"), renderWorkspacePage(readSummaries(dir)));
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
    const command = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(command, [file], { cwd: ctx.workspaceDir, detached: true, stdio: "ignore" }).unref();
    console.log(`opened ${file} — the page reloads itself when state changes and you are not interacting`);
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

function renderProjectPage(model: ProjectModel): string
{
    const active = model.works.filter((w) => w.status === "active");
    const blocked = model.works.filter((w) => w.status === "blocked");
    const next = model.works.filter((w) => w.status === "next");
    const done = model.works.filter((w) => w.status === "done");
    const confirmed = model.decisions.filter((d) => d.status === "confirmed");
    const proposed = model.decisions.filter((d) => d.status === "proposed" && !d.expired);
    const body = [
        `<p><a class="muted" href="workspace.html">← workspace</a></p>`,
        `<header><h1>${esc(model.slug)}</h1>${model.description === undefined ? "" : `<p class="muted">${esc(model.description)}</p>`}</header>`,
        `<p class="goal">${esc(model.goal ?? "goal not set")}</p>`,
        list("alert", model.health),
        cards("Work in progress", active.map(workCard)),
        cards("Blocked", blocked.map(workCard)),
        section("Next", next.map((w) => `<li><code>${esc(w.id)}</code> ${esc(w.outcome)}</li>`)),
        section("Open questions", model.openQuestions.map((q) => `<li>${esc(q)}</li>`)),
        section("Decisions", confirmed.map((d) => `<li>${esc(d.text)}${d.why === undefined ? "" : ` <span class="muted">— ${esc(d.why)}</span>`} <span class="muted">(${d.ts.slice(0, 10)})</span></li>`)),
        section("Proposed decisions", proposed.map((d) => `<li>${esc(d.text)} <span class="muted">— confirm with <code>self decide confirm ${esc(d.id)}</code></span></li>`)),
        section("Conventions", model.conventions.map((c) => `<li>${esc(c.text)}</li>`)),
        section("Done", done.map((w) => `<li><span class="badge b-done">done</span> <code>${esc(w.id)}</code> ${esc(w.outcome)} <span class="muted">(${w.lastEventTs.slice(0, 10)})</span></li>`)),
        `<footer class="muted">updated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</footer>`
    ].join("\n");
    return page(model.slug, body);
}

function workCard(work: WorkState): string
{
    const latest = work.reports[work.reports.length - 1];
    const parts = [
        `<div class="card"><div><span class="badge b-${work.status}">${work.status}</span> <code>${esc(work.id)}</code> <strong>${esc(work.outcome)}</strong></div>`
    ];
    if (work.status === "blocked")
    {
        parts.push(`<p class="alert-text">waiting on ${esc(work.blockedOn ?? "?")}${work.blockedWhy === undefined ? "" : `: ${esc(work.blockedWhy)}`}</p>`);
    }
    if (latest !== undefined)
    {
        parts.push(`<p>${esc(firstLine(latest.text))} <span class="muted">(${latest.ts.slice(0, 10)}, ${work.reports.length} report(s))</span></p>`);
    }
    if (work.next !== undefined)
    {
        parts.push(`<p class="muted">next: ${esc(work.next)}</p>`);
    }
    if (work.evidence.length > 0)
    {
        parts.push(`<p class="muted">evidence: ${work.evidence.map((c) => `<code>${esc(c)}</code>`).join(" ")}</p>`);
    }
    return parts.join("\n") + "</div>";
}

function renderWorkspacePage(summaries: ProjectSummary[]): string
{
    const cards = summaries.map((summary) => [
        `<a class="card" href="${esc(summary.slug)}.html"><h2>${esc(summary.slug)}</h2>`,
        summary.description === undefined ? "" : `<p class="muted">${esc(summary.description)}</p>`,
        `<p class="goal">${esc(summary.goal ?? "goal not set")}</p>`,
        `<p>${badge(summary.active.length, "active", "b-active")} ${badge(summary.blockedCount, "blocked", "b-blocked")} ${badge(summary.nextCount, "next", "b-next")} ${badge(summary.doneCount, "done", "b-done")}</p>`,
        summary.active.map((w) => `<p><code>${esc(w.id)}</code> ${esc(w.outcome)}</p>`).join("\n"),
        summary.health.map((h) => `<p class="alert-text">${esc(h)}</p>`).join("\n"),
        summary.openQuestions.map((q) => `<p class="alert-text">${esc(q)}</p>`).join("\n"),
        `<footer class="muted">updated ${summary.updated.slice(0, 16).replace("T", " ")} UTC</footer></a>`
    ].join("\n")).join("\n");
    const body = `<header><h1>Workspace</h1></header>\n<div class="grid">${cards}</div>`;
    return page("Workspace", body);
}

function badge(count: number, label: string, cls: string): string
{
    return `<span class="badge ${count === 0 ? "b-zero" : cls}">${count} ${label}</span>`;
}

function section(title: string, items: string[]): string
{
    return items.length === 0 ? "" : `<h2>${title}</h2>\n<ul>${items.join("\n")}</ul>`;
}

function cards(title: string, items: string[]): string
{
    return items.length === 0 ? "" : `<h2>${title}</h2>\n${items.join("\n")}`;
}

function list(cls: string, items: string[]): string
{
    return items.length === 0 ? "" : `<ul class="${cls}">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
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

function page(title: string, body: string): string
{
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — superself</title>
<style>${CSS}</style>
</head>
<body><main>
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

const CSS = `
:root { --bg: #fafaf8; --fg: #1a1a1a; --muted: #6b6b6b; --card: #ffffff; --border: #e2e0dc;
        --accent: #2757d6; --alert: #b3362c; --ok: #22764a; --neutral: #6b6b6b; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #16181c; --fg: #e8e6e3; --muted: #9a9892; --card: #1f2228; --border: #32363e;
          --accent: #7ba3f0; --alert: #e0796f; --ok: #74c69a; --neutral: #9a9892; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
       font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 2rem 0 .5rem; text-transform: uppercase;
     letter-spacing: .06em; color: var(--muted); }
.card h2 { text-transform: none; letter-spacing: 0; color: var(--fg);
           font-size: 1.1rem; margin: 0 0 .25rem; }
.goal { font-size: 1.1rem; margin: .5rem 0 0; }
.muted { color: var(--muted); }
.card { display: block; background: var(--card); border: 1px solid var(--border);
        border-radius: 8px; padding: .9rem 1rem; margin: .6rem 0;
        color: inherit; text-decoration: none; }
a.card:hover { border-color: var(--accent); }
a { color: var(--accent); }
a.muted { color: var(--muted); text-decoration: none; }
a.muted:hover { color: var(--fg); }
.card p { margin: .4rem 0 0; }
.card footer { margin-top: .6rem; font-size: .8rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: .8rem; }
.badge { display: inline-block; font-size: .75rem; font-weight: 600; padding: .05rem .5rem;
         border-radius: 99px; border: 1px solid currentColor; }
.b-active { color: var(--accent); }
.b-blocked { color: var(--alert); }
.b-next { color: var(--neutral); }
.b-done { color: var(--ok); }
.b-zero { color: var(--muted); opacity: .55; }
.alert { border: 1px solid var(--alert); border-radius: 8px; padding: .6rem 1rem .6rem 2rem;
         color: var(--alert); }
.alert-text { color: var(--alert); }
ul { padding-left: 1.3rem; margin: .4rem 0; }
li { margin: .3rem 0; }
code { font: .85em ui-monospace, "SF Mono", Menlo, monospace; background: var(--border);
       padding: .1em .35em; border-radius: 4px; }
footer { color: var(--muted); margin-top: 2.5rem; font-size: .85rem; }
`;
