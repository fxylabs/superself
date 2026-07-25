import { copyFileSync, existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { artifactId } from "./ids.js";
import { readEvents } from "./logfile.js";
import { CliContext, ensureDir, readRegistry } from "./paths.js";
import { launchFile } from "./view.js";
import { ArtifactMeta, CliError } from "./types.js";

export interface ArtifactRecord extends ArtifactMeta
{
    project: string;
    work?: string;
    ts: string;
    summary: string;
}

// Copies the files into the store before the event is written, so the event
// and the bytes it references land in the same store commit.
export function ingestArtifacts(storeDir: string, slug: string, paths: string[]): ArtifactMeta[]
{
    return paths.map((path) =>
    {
        const source = resolve(path);
        if (!existsSync(source))
        {
            throw new CliError(`artifact "${path}" does not exist`);
        }
        if (statSync(source).isDirectory())
        {
            throw new CliError(`artifact "${path}" is a directory — pass files individually`);
        }
        const id = artifactId();
        const name = basename(source);
        const relative = join("artifacts", slug, `${id}-${name}`);
        ensureDir(join(storeDir, "artifacts", slug));
        copyFileSync(source, join(storeDir, relative));
        return { id, name, path: relative };
    });
}

export function listArtifacts(storeDir: string, slugs: string[]): ArtifactRecord[]
{
    const records: ArtifactRecord[] = [];
    for (const slug of slugs)
    {
        for (const event of readEvents(storeDir, slug))
        {
            if (event.type !== "report.added" || !Array.isArray(event.payload.artifacts))
            {
                continue;
            }
            for (const meta of event.payload.artifacts as ArtifactMeta[])
            {
                records.push({
                    ...meta,
                    project: slug,
                    work: event.refs?.work,
                    ts: event.ts,
                    summary: String(event.payload.text ?? "")
                });
            }
        }
    }
    return records;
}

export function runArtifact(ctx: CliContext, rest: string[]): void
{
    if (rest[0] === "list")
    {
        printRecords(scopedRecords(ctx, rest.slice(1)));
        return;
    }
    if (rest[0] === "search")
    {
        searchArtifacts(ctx, rest[1]);
        return;
    }
    if (rest[0] === "open")
    {
        openArtifact(ctx, rest[1]);
        return;
    }
    throw new CliError("usage: self artifact list [--work id] [--project slug] | search <query> | open <id>");
}

function scopedRecords(ctx: CliContext, args: string[]): ArtifactRecord[]
{
    const work = valueAfter(args, "--work");
    const project = valueAfter(args, "--project") ?? ctx.project;
    const slugs = project === undefined
        ? readRegistry(ctx.storeDir).map((entry) => entry.slug)
        : [requireRegistered(ctx, project)];
    const records = listArtifacts(ctx.storeDir, slugs);
    return work === undefined ? records : records.filter((record) => record.work === work);
}

function valueAfter(args: string[], flag: string): string | undefined
{
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
}

function requireRegistered(ctx: CliContext, slug: string): string
{
    if (!readRegistry(ctx.storeDir).some((entry) => entry.slug === slug))
    {
        throw new CliError(`unknown project "${slug}" — registered: ${readRegistry(ctx.storeDir).map((e) => e.slug).join(", ")}`);
    }
    return slug;
}

function searchArtifacts(ctx: CliContext, query: string | undefined): void
{
    if (query === undefined || query.trim() === "")
    {
        throw new CliError("usage: self artifact search <query>");
    }
    const needle = query.toLowerCase();
    const slugs = readRegistry(ctx.storeDir).map((entry) => entry.slug);
    const hits = listArtifacts(ctx.storeDir, slugs).filter((record) =>
        [record.id, record.name, record.work ?? "", record.summary].join(" ").toLowerCase().includes(needle));
    printRecords(hits);
}

function printRecords(records: ArtifactRecord[]): void
{
    if (records.length === 0)
    {
        console.log("no artifacts — attach one with `self report <work-id> \"…\" --artifact <path>`");
        return;
    }
    for (const record of records)
    {
        console.log(`${record.id}  ${record.ts.slice(0, 10)}  ${record.project}  ${record.work ?? "-"}  ${record.name}`);
    }
}

function openArtifact(ctx: CliContext, id: string | undefined): void
{
    const wanted = id?.trim();
    if (wanted === undefined || wanted === "")
    {
        throw new CliError("usage: self artifact open <id>");
    }
    const slugs = readRegistry(ctx.storeDir).map((entry) => entry.slug);
    const record = listArtifacts(ctx.storeDir, slugs).find((item) => item.id === wanted);
    if (record === undefined)
    {
        throw new CliError(`unknown artifact "${wanted}" — run \`self artifact list\` to see ids`);
    }
    const file = join(ctx.storeDir, record.path);
    if (!existsSync(file))
    {
        throw new CliError(`artifact file ${record.path} is missing from this store — run \`self sync\` to fetch it`);
    }
    launchFile(ctx, file);
    console.log(`opened ${record.name} (${record.id})`);
}
