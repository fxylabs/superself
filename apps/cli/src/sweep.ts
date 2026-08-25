// Recorded friction, swept into systemization proposals (#381).
//
// `self report --friction` (#380) turned "what differed from expectation" from
// a sentence buried in report prose into a field. Nothing read it. A pain that
// recurs in three projects stayed three sentences in three reports, and the
// third occurrence — the one a person finally notices — was noticed by nobody.
//
// This module is the reader. It collects the friction sentences recorded across
// the workspace's active projects inside a window, clusters the ones that say
// the same thing, and — only when asked with `--record` — proposes each cluster
// through the proposal gate that already exists. Preview is the default because
// generating proposals is not a side effect a read should have.
//
// Three things it deliberately is not:
//
//   - a scheduler. There is no timer, no daemon, and none is coming: an
//     unattended run is an external cron calling `self sweep --record`.
//   - a judge. The clustering is arithmetic over normalized tokens and calls no
//     model. Whether a cluster is one real problem is the reading agent's
//     judgment, and whether it is worth doing is the person's.
//   - a new record kind. A swept proposal is an `entity.proposed` like any
//     other, so it accepts, declines and revises through the unchanged verbs and
//     reaches a person through the unchanged `## Waiting on you` row.

import { presetRow } from "./aliases.js";
import { Command, CommandInput, leaf } from "./contract.js";
import { clashingPlan, normalize } from "./goals.js";
import { workId } from "./ids.js";
import { ProjectModel, ReportEntry, workspaceModels, WorkState } from "./model.js";
import { ProjectContext, requireProject, requireWorkspace } from "./paths.js";
import { makeEvent, recordEvents } from "./pipeline.js";
import { plural } from "./style.js";
import { CliError, CommandOutput, SelfEvent } from "./types.js";

/* ── the constants, and why they are constants ─────────────────────── */

// How far back a run reads by default. A window rather than the whole log
// because every run folds every active project, and an unbounded scan would
// make the cost of a nightly sweep grow with the age of the workspace.
const WINDOW_DAYS = 30;

// How much two sentences must share to be the same complaint: half their
// meaningful words or more, counted as a Jaccard ratio. Below a half, two
// sentences that merely mention the same tool cluster together.
const OVERLAP = 0.5;

// How many occurrences make a candidate. Three, because the whole account this
// feature comes from is of a pain that goes unnoticed until its third
// occurrence — the number is the defect's own, not a tuning choice.
const CLUSTER_FLOOR = 3;

// Neither threshold is a flag. A knob whose right value is a judgment about
// this project's own history is not something to hand a caller and ask them to
// guess at; the numbers move when the recorded evidence says they should, in a
// commit that can say why.

const DAY_MS = 86_400_000;

// Words that say nothing about which problem a sentence is about. Only English
// function words are listed: `normalize` splits on non-letters, so Korean
// particles stay attached to the word they modify and there is no token to drop
// — dropping them would need a morphological analyzer, which is a model by
// another name.
const STOP_WORDS = new Set([
    "a", "an", "and", "as", "at", "be", "been", "but", "by", "did", "do", "does", "for", "from", "had", "has",
    "have", "in", "is", "it", "its", "not", "of", "on", "or", "so", "than", "that", "the", "then", "this",
    "to", "was", "were", "when", "which", "with"
]);

// The honest answer to "what differed" when nothing did. It is recorded like
// any other sentence — refusing it at capture would make the truthful report
// the one the CLI rejects — and excluded here, where five of them would
// otherwise be the workspace's most recurring problem.
const AS_EXPECTED = new Set(["예상대로", "as expected"]);

// What a proposal made from a cluster is called. Fixed text plus the
// representative sentence, and no count: `normalize` keeps digits, so
// "(4 reports)" and "(5 reports)" would be different dedupe keys and the same
// problem would be proposed again the night after one more report lands.
const PROPOSAL_PREFIX = "recurring friction: ";

/* ── what is collected ─────────────────────────────────────────────── */

interface FrictionItem
{
    text: string;
    tokens: Set<string>;
    // The `report.added` event this sentence was written on — the evidence id a
    // proposal cites, and the id a reader follows back to the report.
    report: string;
    project: string;
    ts: string;
}

interface Cluster
{
    // Oldest first, so `items[0]` is the representative and stays the
    // representative as the cluster grows.
    items: FrictionItem[];
}

function collectFriction(models: ProjectModel[], from: Date): FrictionItem[]
{
    return models.flatMap((model) => model.works.flatMap((work) => reportItems(model, work.reports, from)));
}

function reportItems(model: ProjectModel, reports: ReportEntry[], from: Date): FrictionItem[]
{
    return reports
        .filter((report) => Date.parse(report.ts) >= from.getTime())
        .flatMap((report) => report.friction.map((text): FrictionItem =>
            ({ text, tokens: tokensOf(text), report: report.id, project: model.slug, ts: report.ts })));
}

// Which of the collected sentences may become a cluster. Kept apart from the
// collection so a run still says how much friction it read: "as expected" is
// friction that was written, and a preview reporting nothing read would be
// telling a project that says it every time to start saying it.
//
// A sentence with no meaningful word left is out for a different reason — it
// has nothing to compare, so every one of them would compare equal to every
// other.
function candidates(items: FrictionItem[]): FrictionItem[]
{
    return items.filter((item) => item.tokens.size > 0 && !AS_EXPECTED.has(normalize(item.text)));
}

function tokensOf(text: string): Set<string>
{
    return new Set(normalize(text).split(" ").filter((token) => token !== "" && !STOP_WORDS.has(token)));
}

/* ── clustering ────────────────────────────────────────────────────── */

// Each sentence joins the first cluster whose representative it overlaps with,
// or starts one. Compared against the representative rather than against every
// member because the representative is what the proposal text will say: a
// cluster whose members drifted away from the sentence it is proposed under is
// a cluster nobody can read.
function clusterFriction(items: FrictionItem[]): Cluster[]
{
    const clusters: Cluster[] = [];
    for (const item of oldestFirst(candidates(items)))
    {
        const found = clusters.find((cluster) => overlap(cluster.items[0].tokens, item.tokens) >= OVERLAP);
        if (found === undefined)
        {
            clusters.push({ items: [item] });
            continue;
        }
        found.items.push(item);
    }
    return clusters.filter((cluster) => cluster.items.length >= CLUSTER_FLOOR);
}

// Oldest first, and ties broken by the evidence id, so the representative of a
// cluster is a fact about the recorded evidence rather than about the order two
// logs happened to merge in.
function oldestFirst(items: FrictionItem[]): FrictionItem[]
{
    return [...items].sort((left, right) => left.ts.localeCompare(right.ts) || left.report.localeCompare(right.report));
}

function overlap(left: Set<string>, right: Set<string>): number
{
    const shared = [...left].filter((token) => right.has(token)).length;
    return shared === 0 ? 0 : shared / (left.size + right.size - shared);
}

function proposalTextFor(cluster: Cluster): string
{
    return PROPOSAL_PREFIX + cluster.items[0].text;
}

// One report can carry two sentences that land in the same cluster, so the ids
// are deduplicated: the evidence is which reports made the case, not how many
// sentences were counted.
function evidenceOf(cluster: Cluster): string[]
{
    return [...new Set(cluster.items.map((item) => item.report))];
}

/* ── the two dedupe layers ─────────────────────────────────────────── */

// Evidence overlap, and it runs first. An open proposal that already cites one
// of these reports has already asked about this cluster, and that holds however
// the text drifts — including when the window rolls past the representative and
// the sentence the proposal would carry changes.
//
// Only open proposals are looked at, here and in `clashingPlan`. A declined
// proposal does not hold back a re-proposal: friction that keeps recurring is
// exactly what should keep being asked about.
function alreadyAsked(model: ProjectModel, evidence: string[]): WorkState | undefined
{
    return model.works.find((work) => work.status === "review"
        && work.frictionEvidence.some((id) => evidence.includes(id)));
}

interface Disposition
{
    line: string;
    event?: SelfEvent;
}

function disposition(ctx: ProjectContext, model: ProjectModel, cluster: Cluster): Disposition
{
    const text = proposalTextFor(cluster);
    const evidence = evidenceOf(cluster);
    const asked = alreadyAsked(model, evidence);
    if (asked !== undefined)
    {
        return { line: `skipped   ${text} — ${asked.id} already cites this evidence` };
    }
    const clash = clashingPlan(model, normalize(text));
    if (clash !== undefined)
    {
        return { line: `skipped   ${text} — ${clash.id} already proposes it` };
    }
    const event = proposalEvent(ctx, text, evidence);
    return { line: `${String(event.payload.entity)}   ${text} (${plural(evidence.length, "report")})`, event };
}

// A standalone plan proposal, the same shape `self work propose "<plan>"`
// records: no brief, no objective, no milestone. The evidence rides as a ref
// rather than as payload text because these are record ids a reader follows.
function proposalEvent(ctx: ProjectContext, text: string, evidence: string[]): SelfEvent
{
    const row = presetRow(ctx.storeDir, "work");
    const payload: Record<string, unknown> = {
        entity: workId(),
        text,
        labels: [row.label],
        links: [],
        criteria: [],
        exposure: row.exposure,
        scope: "project"
    };
    if (row.priority !== undefined)
    {
        payload.priority = row.priority;
    }
    return makeEvent(ctx.project, "entity.proposed", payload, { friction: evidence });
}

/* ── the window ────────────────────────────────────────────────────── */

function windowDays(value: string | undefined): number
{
    if (value === undefined)
    {
        return WINDOW_DAYS;
    }
    const match = /^([1-9][0-9]*)([dw])$/.exec(value.trim());
    if (match === null)
    {
        throw new CliError(`--since takes a whole number of days or weeks, and "${value}" is not one`
            + " — write it like `--since 30d` or `--since 2w`");
    }
    return Number(match[1]) * (match[2] === "w" ? 7 : 1);
}

/* ── what a run says ───────────────────────────────────────────────── */

const NO_PROJECT = "no project is registered in this workspace, so there is no friction to read"
    + " — `self project init` in a project directory registers one";

function previewLines(projects: number, items: FrictionItem[], clusters: Cluster[], days: number): string[]
{
    if (projects === 0)
    {
        return [NO_PROJECT];
    }
    const reports = new Set(items.map((item) => item.report)).size;
    const head = `read ${plural(projects, "project")} for friction in the last ${plural(days, "day")}: `
        + `${plural(items.length, "sentence")} on ${plural(reports, "report")}`;
    if (clusters.length === 0)
    {
        return [head, "", emptyNote(items.length, days)];
    }
    return [head, ""].concat(clusters.flatMap(clusterLines), "",
        "nothing was recorded — `self sweep --record` proposes " + (clusters.length === 1 ? "it" : "them"));
}

function clusterLines(cluster: Cluster): string[]
{
    const evidence = evidenceOf(cluster);
    const projects = new Set(cluster.items.map((item) => item.project)).size;
    return [
        proposalTextFor(cluster),
        `  ${plural(evidence.length, "report")} in ${plural(projects, "project")} — ${evidence.join(", ")}`
    ];
}

function emptyNote(found: number, days: number): string
{
    return found === 0
        ? `no friction was recorded in the last ${plural(days, "day")} — self report … --friction "<what differed>"`
        : `nothing recurred ${CLUSTER_FLOOR} times or more, so there is nothing to propose`;
}

function recordedLine(made: number, skipped: number, days: number): string
{
    if (made + skipped === 0)
    {
        return `nothing recurred ${CLUSTER_FLOOR} times or more in the last ${plural(days, "day")}, so nothing was proposed`;
    }
    return `${plural(made, "proposal")} recorded`
        + (skipped === 0 ? "" : `, ${plural(skipped, "cluster")} skipped as already asked`);
}

/* ── the verb ──────────────────────────────────────────────────────── */

// A workspace read: it reads every active project, because friction repeating
// across projects is the whole thing being looked for.
function previewSweep(from: Date, days: number): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    const models = workspaceModels(ctx.storeDir);
    const items = collectFriction(models, from);
    const clusters = clusterFriction(items);
    return [{ kind: "document", plain: () => previewLines(models.length, items, clusters, days) }];
}

// A write: it takes no scope flag and records into the project this directory
// resolves to, even where a cluster's evidence spans several. Every proposal
// goes through one `recordEvents`, so three clusters are one append and one
// fold rather than three of each.
function recordSweep(from: Date, days: number): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const clusters = clusterFriction(collectFriction(models, from));
    const rows = clusters.map((cluster) => disposition(ctx, models[0], cluster));
    const events = rows.flatMap((row) => row.event === undefined ? [] : [row.event]);
    if (events.length > 0)
    {
        recordEvents(ctx, events, `${plural(events.length, "proposal")} from recurring friction`);
    }
    return [
        { kind: "receipt", text: recordedLine(events.length, rows.length - events.length, days) },
        { kind: "listing", rows: rows.map((row) => row.line), total: rows.length, noun: "cluster" }
    ];
}

const SWEEP_OPTIONS = { since: { type: "string" }, record: { type: "boolean" } } as const;

function cmdSweep({ values }: CommandInput<typeof SWEEP_OPTIONS>): CommandOutput
{
    const days = windowDays(values.since);
    const from = new Date(Date.now() - days * DAY_MS);
    return values.record === true ? recordSweep(from, days) : previewSweep(from, days);
}

export const SWEEP_COMMAND: Command = {
    name: "sweep",
    usage: [{
        syntax: "sweep [--since <window>] [--record]",
        description: ["cluster the friction reports recorded lately, and propose what recurs"],
        verbs: [""]
    }],
    detail: [
        "reads `self report --friction` sentences across every active project in",
        "the workspace, groups the ones that say the same thing, and shows what it",
        "would propose. it prints and records nothing by default; --record writes",
        "each group as a work proposal you accept or decline like any other.",
        "",
        "a group needs three sentences or more, and two sentences are the same",
        "complaint when they share half their meaningful words or more. neither",
        "number is a flag: the right value is a judgment about recorded evidence.",
        "",
        "there is no --project and no --workspace. the read is workspace-wide by",
        "definition, because friction repeating across projects is what it looks",
        "for; --record takes no scope either, and records into the project this",
        "directory resolves to.",
        "",
        "nothing schedules this. run it, or have a cron run `self sweep --record`.",
        "",
        "  --since <window>    how far back to read, as 30d or 2w (default 30d)",
        "  --record            write each group as a proposal instead of previewing"
    ],
    node: leaf("", SWEEP_OPTIONS, 0, cmdSweep)
};
