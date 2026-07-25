import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eventSummary, readEvents } from "./logfile.js";
import { CliContext, projectStateDir, readRegistry } from "./paths.js";

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
    let hits = 0;
    for (const event of readEvents(storeDir, slug))
    {
        if (!event.type.startsWith(prefix))
        {
            continue;
        }
        if (JSON.stringify(event).toLowerCase().includes(needle))
        {
            console.log(`${slug}  ${event.ts.slice(0, 10)}  ${event.type}  [${event.id}]  ${eventSummary(event)}`);
            hits++;
        }
    }
    return hits;
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
                console.log(`${slug}  ${rel}:${i + 1}  ${lines[i].trim()}`);
                hits++;
            }
        }
    }
    return hits;
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
    const workDir = join(dir, "work");
    if (existsSync(workDir))
    {
        for (const name of readdirSync(workDir))
        {
            files.push(join("work", name));
        }
    }
    return files;
}
