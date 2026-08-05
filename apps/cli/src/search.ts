// `self search` answers over live records, not the log (#212).
//
// The fold already answers "what is currently true", so this surface reads it
// rather than grepping `log.jsonl` a second way: a superseded, retired,
// retracted or done record is simply absent, and every answer is a readable
// row instead of a raw event object. The default set is every live record the
// current context render does not show — the search tier, plus the index and
// full records the context budget cut (R1) — which `views.ts` derives from the
// render itself so the two cannot disagree. `--exposure` names one tier and
// `--all` covers every live record, so nothing live is out of reach.
//
// History is per-entity and explicit: `state show <id> --history` and
// `work show <id> --history` (R3). No flag here reaches a dead record.

import { EntityState, Exposure, EXPOSURES, isCurrent, scopeTarget } from "./entities.js";
import { buildModel, ProjectModel, WorkState } from "./model.js";
import { CliContext, readRegistry, requireRegistered } from "./paths.js";
import { bold, dim, displayWidth, fitDisplay, oneLine, styled } from "./style.js";
import { CliError } from "./types.js";
import { contextRendered, recordLine } from "./views.js";

// The record kinds `--type` narrows to (R2). The preset sources plus the free
// entity `state add` records — the kinds a record answers as, never the event
// types the log happens to spell them with.
const KINDS = ["goal", "decision", "convention", "objective", "milestone", "work", "entity"] as const;

// What one row spends on the record's own text. Fixed rather than read off the
// terminal: a piped run and a terminal run print the same rows (#212 T4.6),
// and the whole record is one `show` away.
const ROW_TEXT = 100;

interface SearchChoice
{
    type?: string;
    project?: string;
    exposure?: string;
    all?: boolean;
}

// One live record, as the answer speaks about it: where its log lives, where
// it renders, and every string a query may be found in.
interface LiveRecord
{
    id: string;
    owner: string;
    target: string;
    kind: string;
    exposure: Exposure;
    mark?: string;
    body: string;
    haystack: string;
}

export function runSearch(ctx: CliContext, query: string, choice: SearchChoice): void
{
    const tier = requireOneWidening(choice);
    const kind = choice.type === undefined ? undefined : requireKind(choice.type);
    const wanted = choice.project === undefined ? null : requireRegistered(ctx.storeDir, choice.project);
    const unreadable: string[] = [];
    // Every registered project is folded even when one is named: a record
    // renders in the project its scope points at (#181 D1), so what context
    // shows anywhere is what the default answers around (#212 R1).
    const models = orderedSlugs(ctx)
        .map((slug) => folded(ctx.storeDir, slug, unreadable))
        .filter((model): model is ProjectModel => model !== null);
    const shown = contextRendered(ctx.storeDir, models);
    const needle = query.trim().toLowerCase();
    const hits = match(models.filter((model) => wanted === null || model.slug === wanted).flatMap(liveRecords)
        .filter((record) => admits(record, tier, kind, choice.all === true, shown)), needle);
    report(unreadable.filter((slug) => wanted === null || slug === wanted), hits, needle);
}

function report(unreadable: string[], hits: LiveRecord[], needle: string): void
{
    for (const slug of unreadable)
    {
        console.log(`${slug}: its state could not be read here, so its records are not in this answer`);
    }
    for (const record of hits)
    {
        console.log(row(record, needle));
    }
    if (hits.length === 0)
    {
        console.log("no matches");
    }
}

/* ── which records the answer is drawn from ────────────────────────── */

// `--all` widens to every live record and `--exposure` narrows to one tier;
// asking for both states two different questions, so it is refused rather than
// letting either win (#212 T7.4).
function requireOneWidening(choice: SearchChoice): Exposure | undefined
{
    if (choice.exposure === undefined)
    {
        return undefined;
    }
    if (choice.all === true)
    {
        throw new CliError(`--all answers over every live record and --exposure reads the ${choice.exposure} tier alone`
            + " — pass one of them, not both");
    }
    if (!(EXPOSURES as readonly string[]).includes(choice.exposure))
    {
        throw new CliError(`unknown exposure "${choice.exposure}" — pass one of ${EXPOSURES.join(", ")}`);
    }
    return choice.exposure as Exposure;
}

// The default is what context does not show; a named tier is that tier whether
// or not context renders it; `--all` is every live record. A dead record is
// reached by none of them (#212 T7.7) — it never entered this set.
function admits(record: LiveRecord, tier: Exposure | undefined, kind: string | undefined, all: boolean, shown: Set<string>): boolean
{
    if (kind !== undefined && record.kind !== kind)
    {
        return false;
    }
    if (tier !== undefined)
    {
        return record.exposure === tier;
    }
    return all || !shown.has(record.id);
}

// `--type` names a record kind (R2). An event-type spelling is what it used to
// take, so it is answered with the kind to use rather than with "unknown".
function requireKind(type: string): string
{
    if (type.includes("."))
    {
        throw new CliError(`--type names a record kind, not an event type — for "${type}" pass \`--type ${type.split(".")[0]}\``);
    }
    if (!(KINDS as readonly string[]).includes(type))
    {
        throw new CliError(`unknown record kind "${type}" — pass one of ${KINDS.join(", ")}`);
    }
    return type;
}

function orderedSlugs(ctx: CliContext): string[]
{
    return readRegistry(ctx.storeDir).map((entry) => entry.slug)
        .sort((left, right) => rank(left, ctx) - rank(right, ctx));
}

function rank(slug: string, ctx: CliContext): number
{
    return slug === ctx.project ? 0 : 1;
}

// A project this machine cannot fold is named and skipped, so the projects
// that do answer still answer (#212 T5.8). Search stopped reading the log a
// second way, so there is no degraded reading left to fall back on: an
// unreadable project has no live records to speak for.
function folded(storeDir: string, slug: string, unreadable: string[]): ProjectModel | null
{
    try
    {
        return buildModel(storeDir, slug, new Date());
    }
    catch
    {
        unreadable.push(slug);
        return null;
    }
}

/* ── the live records of one project ───────────────────────────────── */

function liveRecords(model: ProjectModel): LiveRecord[]
{
    const works = new Map(model.works.map((work) => [work.id, work]));
    const records = model.entities.filter(isCurrent)
        .map((entity) => entityRecord(model, entity, works.get(entity.id)));
    const known = new Set(records.map((record) => record.id));
    // A unit folded from the pre-cutover `work.*` grammar has no entity of its
    // own (#207 §8), and it is as live as any other open unit.
    return [...records, ...model.works
        .filter((work) => !known.has(work.id) && work.status !== "done" && work.status !== "retired")
        .map((work) => legacyWorkRecord(model, work))];
}

function entityRecord(model: ProjectModel, entity: EntityState, work: WorkState | undefined): LiveRecord
{
    const body = recordLine(entity);
    return {
        id: entity.id,
        owner: model.slug,
        target: scopeTarget(entity, model.slug),
        kind: entity.source ?? "entity",
        exposure: entity.exposure,
        mark: statusMark(entity),
        body,
        haystack: [entity.id, body, ...entity.labels, ...entity.criteria, entity.target ?? "", carried(work)]
            .join("\n").toLowerCase()
    };
}

// A record's working state, where it has one worth a reader's eye: a proposal
// waiting on a person, and a unit in progress, blocked, or not yet started.
// `isCurrent` already dropped the done and retired ones.
function statusMark(entity: EntityState): string | undefined
{
    if (entity.status === "proposed")
    {
        return "proposed";
    }
    if (entity.execution !== undefined)
    {
        return entity.execution.status === "in-progress" ? "in progress" : entity.execution.status;
    }
    return entity.source === "work" ? "open" : undefined;
}

// Reports, requirements and artifacts are carried by a work unit, never rows
// of their own (#212 T3.10–T3.12): their text is searchable, and what it
// resolves to is the unit that carries them.
function carried(work: WorkState | undefined): string
{
    if (work === undefined)
    {
        return "";
    }
    return [
        ...work.reports.map((report) => report.text),
        ...work.completion.requirements.map((requirement) => requirement.text),
        ...work.artifacts.map((artifact) => artifact.name),
        ...work.notes,
        work.next ?? "",
        work.blockedWhy ?? ""
    ].join("\n");
}

function legacyWorkRecord(model: ProjectModel, work: WorkState): LiveRecord
{
    const body = work.outcome;
    return {
        id: work.id,
        owner: model.slug,
        target: model.slug,
        kind: "work",
        exposure: "search",
        mark: work.status === "active" ? "in progress" : work.status === "next" ? "open" : work.status,
        body,
        haystack: [work.id, body, carried(work)].join("\n").toLowerCase()
    };
}

/* ── finding the query ─────────────────────────────────────────────── */

// An id spelled in full answers with that record alone: an id also appears in
// the links, reports and refusals of records that merely mention it, and a
// caller who typed a whole id asked about one record (#212 T2.3).
function match(records: LiveRecord[], needle: string): LiveRecord[]
{
    if (needle === "")
    {
        return records;
    }
    const exact = records.filter((record) => record.id.toLowerCase() === needle);
    return exact.length > 0 ? exact : records.filter((record) => record.haystack.includes(needle));
}

/* ── the row ───────────────────────────────────────────────────────── */

function row(record: LiveRecord, needle: string): string
{
    const mark = record.mark === undefined ? "" : `(${record.mark}) `;
    const moved = record.target === record.owner ? ""
        : `  [renders in ${record.target === "workspace" ? "every project" : record.target}]`;
    const body = mark + excerpt(oneLine(record.body), needle);
    const lead = `${record.owner}  ${record.kind}  ${record.id}`;
    return styled
        ? `${dim(lead)}  ${highlight(body, needle)}${dim(moved)}`
        : `${lead}  ${body}${moved}`;
}

// A brief runs to thousands of characters and the row is one line, so the row
// carries the window the query was found in and the id that prints the whole
// (#212 T4.2). A match past the window would otherwise be cut off the row that
// exists to show it.
function excerpt(text: string, needle: string): string
{
    if (displayWidth(text) <= ROW_TEXT)
    {
        return text;
    }
    const found = needle === "" ? -1 : text.toLowerCase().indexOf(needle);
    if (found < 0 || displayWidth(text.slice(0, found)) < ROW_TEXT - needle.length)
    {
        return fitDisplay(text, ROW_TEXT);
    }
    return "…" + fitDisplay(text.slice(Math.max(0, found - 20)), ROW_TEXT - 1);
}

function highlight(text: string, needle: string): string
{
    const index = needle === "" ? -1 : text.toLowerCase().indexOf(needle);
    if (index < 0)
    {
        return text;
    }
    return text.slice(0, index) + bold(text.slice(index, index + needle.length)) + text.slice(index + needle.length);
}
