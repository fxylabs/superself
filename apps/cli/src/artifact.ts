import { accessSync, constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { artifactId } from "./ids.js";
import { readEvents } from "./logfile.js";
import { CliContext, readRegistry } from "./paths.js";
import { launchFile } from "./view.js";
import { ArtifactMeta, CliError } from "./types.js";

export interface ArtifactRecord extends ArtifactMeta
{
    project: string;
    work?: string;
    ts: string;
    summary: string;
}

// Bytes already in the store, waiting for the event that names them. Nothing
// outside this module may keep them without writing that event.
export interface StagedArtifacts
{
    artifacts: ArtifactMeta[];
    discard: () => void;
}

interface PlannedArtifact extends ArtifactMeta
{
    source: string;
}

// Every declared artifact is checked before any byte is written, and the whole
// set is removed again if one copy fails: a rejected report must leave the
// store exactly as it found it.
export function stageArtifacts(storeDir: string, slug: string, paths: string[] | undefined): StagedArtifacts
{
    if (paths === undefined || paths.length === 0)
    {
        return { artifacts: [], discard: () => {} };
    }
    const planned = planArtifacts(slug, paths);
    const createdRoot = mkdirSync(join(storeDir, "artifacts", slug), { recursive: true });
    const touched: string[] = [];
    const discard = (): void => removeStaged(createdRoot, touched);
    const failure = copyPlanned(storeDir, planned, touched);
    if (failure !== null)
    {
        discard();
        throw failure;
    }
    return { artifacts: planned.map(({ id, name, path }) => ({ id, name, path })), discard };
}

// The bytes and the event that names them land in the same store commit, so a
// report that cannot be written takes its artifacts back out with it.
export function commitStaged(staged: StagedArtifacts, writeEvent: () => void): void
{
    const failure = capture(writeEvent);
    if (failure !== null)
    {
        staged.discard();
        throw failure;
    }
}

function planArtifacts(slug: string, paths: string[]): PlannedArtifact[]
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
        if (!isReadable(source))
        {
            throw new CliError(`artifact "${path}" cannot be read`);
        }
        const id = artifactId();
        const name = basename(source);
        // Forward slashes: the path is persisted in the event and rendered
        // into view hrefs, so it must not vary by platform.
        return { id, name, path: `artifacts/${slug}/${id}-${name}`, source };
    });
}

// Hands the first failure back instead of throwing, so the caller can undo the
// files it already touched before the error reaches the user. Each target is
// recorded before its copy: an interrupted copy leaves a partial file that
// rollback must still remove.
function copyPlanned(storeDir: string, planned: PlannedArtifact[], touched: string[]): Error | null
{
    for (const item of planned)
    {
        const target = join(storeDir, item.path);
        // An id already on disk would overwrite stored bytes the log still
        // points at; artifacts are immutable after ingestion.
        if (existsSync(target))
        {
            return new CliError(`artifact id ${item.id} is already stored — run the report again`);
        }
        touched.push(target);
        const failure = capture(() => copyFileSync(item.source, target));
        if (failure !== null)
        {
            return new CliError(`artifact "${item.name}" could not be copied into the store: ${failure.message}`);
        }
    }
    return null;
}

function removeStaged(createdRoot: string | undefined, touched: string[]): void
{
    for (const file of touched)
    {
        rmSync(file, { force: true });
    }
    touched.length = 0;
    // Only a directory this command created may go: an older one holds
    // artifacts from earlier reports.
    if (createdRoot !== undefined)
    {
        rmSync(createdRoot, { recursive: true, force: true });
    }
}

function isReadable(source: string): boolean
{
    try
    {
        accessSync(source, constants.R_OK);
        return true;
    }
    catch
    {
        return false;
    }
}

function capture(action: () => void): Error | null
{
    try
    {
        action();
        return null;
    }
    catch (error)
    {
        return error instanceof Error ? error : new Error(String(error));
    }
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
