import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eventSummary, readEvents } from "./logfile.js";
import { buildModel, closedRecords, ProjectModel } from "./model.js";
import { CliContext, projectStateDir, readRegistry } from "./paths.js";
import { bold, dim, styled } from "./style.js";
import { SelfEvent } from "./types.js";

export function runSearch(ctx: CliContext, query: string, type?: string, projectFilter?: string): void
{
    const slugs = readRegistry(ctx.storeDir)
        .map((entry) => entry.slug)
        .filter((slug) => projectFilter === undefined || slug === projectFilter);
    const ordered = [...slugs].sort((a, b) => rank(a, ctx) - rank(b, ctx));
    const needle = query.toLowerCase();
    let hits = 0;
    for (const slug of ordered)
    {
        hits += type === undefined
            ? searchFiles(ctx.storeDir, slug, needle)
            : searchLog(ctx.storeDir, slug, needle, type);
    }
    if (hits === 0)
    {
        console.log("no matches");
    }
}

function rank(slug: string, ctx: CliContext): number
{
    return slug === ctx.project ? 0 : 1;
}

function searchLog(storeDir: string, slug: string, needle: string, type: string): number
{
    const prefix = type.includes(".") ? type : type + ".";
    // Folded once per project, not once per hit: search is the one surface that
    // still answers for records the current renders drop, so a match has to say
    // which of those it is.
    const closed = closedStatuses(storeDir, slug);
    let hits = 0;
    for (const event of readEvents(storeDir, slug))
    {
        if (!event.type.startsWith(prefix))
        {
            continue;
        }
        if (JSON.stringify(event).toLowerCase().includes(needle))
        {
            const status = closed.get(recordOf(event));
            const mark = status === undefined ? "" : ` [${status}]`;
            console.log(styled
                ? `${dim(`${slug}  ${event.ts.slice(0, 10)}  ${event.type}${mark}`)}  ${highlight(eventSummary(event), needle)}  ${dim(`[${event.id}]`)}`
                : `${slug}  ${event.ts.slice(0, 10)}  ${event.type}${mark}  [${event.id}]  ${eventSummary(event)}`);
            hits++;
        }
    }
    return hits;
}

// Which record an event speaks about. Decided by the event's own type wherever
// its payload names more than one record, because a payload id alone answers
// the wrong question: `work.proposed` carries the objective and milestone the
// proposal serves, and a proposal is identified by the event that opened it,
// so reading the payload would mark a declined proposal with its objective's
// status — or with nothing.
//
// The rest fall through to the payload, most specific first: a requirement
// event names its work unit too, and answering with the unit would mark the
// requirement with the unit's status. A decision and a convention are named by
// the event that opened them, which is why the event id is the last resort.
const PROPOSAL_TRANSITIONS = ["work.accepted", "work.declined"];

function recordOf(event: SelfEvent): string
{
    if (event.type === "work.proposed")
    {
        return event.id;
    }
    if (PROPOSAL_TRANSITIONS.includes(event.type))
    {
        return String(event.payload.proposal ?? event.id);
    }
    const named = event.payload.requirement ?? event.payload.milestone
        ?? event.payload.objective ?? event.payload.entity ?? event.payload.work;
    return named === undefined ? event.id : String(named);
}

// Every statement-type record that has left the current state, by the id a
// search hit resolves to. Read from the one registry in `model.ts`, so a type
// added there is marked here without this file changing.
function closedStatuses(storeDir: string, slug: string): Map<string, string>
{
    const model = folded(storeDir, slug);
    return model === null ? new Map() : closedRecords(model);
}

// Search is the command every omission line points at for recovery, so it
// keeps answering from the log even when the fold cannot run — a project whose
// state files this machine cannot read loses its status markers, not its hits.
function folded(storeDir: string, slug: string): ProjectModel | null
{
    try
    {
        return buildModel(storeDir, slug, new Date());
    }
    catch
    {
        return null;
    }
}

function searchFiles(storeDir: string, slug: string, needle: string): number
{
    const dir = projectStateDir(storeDir, slug);
    let hits = 0;
    for (const rel of stateFiles(dir))
    {
        const lines = readFileSync(join(dir, rel), "utf8").split("\n");
        for (let i = 0; i < lines.length; i++)
        {
            if (lines[i].toLowerCase().includes(needle))
            {
                console.log(styled
                    ? `${dim(`${slug}  ${rel}:${i + 1}`)}  ${highlight(lines[i].trim(), needle)}`
                    : `${slug}  ${rel}:${i + 1}  ${lines[i].trim()}`);
                hits++;
            }
        }
    }
    return hits;
}

function highlight(text: string, needle: string): string
{
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0)
    {
        return text;
    }
    return text.slice(0, index) + bold(text.slice(index, index + needle.length)) + text.slice(index + needle.length);
}

function stateFiles(dir: string): string[]
{
    const files: string[] = [];
    for (const name of ["state.md", "log.jsonl"])
    {
        if (existsSync(join(dir, name)))
        {
            files.push(name);
        }
    }
    for (const sub of ["work", "objective", "integration"])
    {
        if (existsSync(join(dir, sub)))
        {
            files.push(...readdirSync(join(dir, sub)).map((name) => join(sub, name)));
        }
    }
    return files;
}
