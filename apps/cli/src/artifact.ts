import { accessSync, constants, copyFileSync, existsSync, mkdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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

// What this command made, and nothing else. Rollback undoes its own work only:
// never a directory it found, never a file another report is writing.
interface Staging
{
    dirs: string[];
    files: string[];
}

// Every declared artifact is checked before any byte is written, and the whole
// set is removed again if one copy fails: a rejected report must leave the
// store exactly as it found it.
//
// A process killed between the copies and the event leaves those bytes behind.
// They are unreachable — every view reads artifacts from the log — and nothing
// sweeps them, because a file no event names is indistinguishable from a file
// another report is staging right now, and losing stored bytes is the one
// mistake this module cannot undo.
export function stageArtifacts(storeDir: string, slug: string, paths: string[] | undefined): StagedArtifacts
{
    if (paths === undefined || paths.length === 0)
    {
        return { artifacts: [], discard: () => {} };
    }
    const slugDir = artifactDir(storeDir, slug);
    const planned = planArtifacts(slug, paths);
    const staging: Staging = { dirs: createDirs(slugDir), files: [] };
    const discard = (): void => removeStaged(staging);
    const failure = copyPlanned(storeDir, planned, staging);
    if (failure !== null)
    {
        discard();
        throw failure;
    }
    return { artifacts: planned.map(({ id, name, path }) => ({ id, name, path })), discard };
}

// The line appended to the log is what makes a report true, and that is the
// boundary this rollback respects. Bytes staged for an event that never
// reached the log go back out; bytes for an event that did reach it stay,
// whatever fails afterwards — folding, rendering, committing — because the next
// command folds and commits the store again, while nothing can bring back the
// file a durable report already names.
export function commitStaged(staged: StagedArtifacts, writeEvent: (recorded: () => void) => void): void
{
    let recorded = false;
    const markRecorded = (): void =>
    {
        recorded = true;
    };
    const failure = capture(() => writeEvent(markRecorded));
    if (failure === null)
    {
        return;
    }
    if (!recorded)
    {
        staged.discard();
    }
    throw failure;
}

// The slug reaches the filesystem here, and a registry entry is not a name this
// module may hand to `join` unchecked: anything but a single path segment would
// put a project's bytes outside the artifacts root, or on top of another
// project's. Such a report is refused rather than quietly bent into shape.
function artifactDir(storeDir: string, slug: string): string
{
    const root = join(storeDir, "artifacts");
    const dir = resolve(root, slug);
    const step = relative(root, dir);
    if (step === "" || step === ".." || step.includes(sep))
    {
        throw new CliError(`project "${slug}" cannot store artifacts — a project name must be a single path segment`);
    }
    return dir;
}

// mkdir reports only the topmost directory it had to make; every step from
// there down to the slug directory was made by this command too. Those are the
// only directories rollback may take back.
function createDirs(dir: string): string[]
{
    const top = mkdirSync(dir, { recursive: true });
    if (top === undefined)
    {
        return [];
    }
    const created: string[] = [];
    let current = dir;
    while (current === top || current.startsWith(top + sep))
    {
        created.push(current);
        if (current === top)
        {
            break;
        }
        current = dirname(current);
    }
    return created;
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
function copyPlanned(storeDir: string, planned: PlannedArtifact[], staging: Staging): Error | null
{
    for (const item of planned)
    {
        const target = join(storeDir, item.path);
        staging.files.push(target);
        // Created exclusively: stored bytes the log already points at are never
        // overwritten, and unlike asking first and copying after, this leaves no
        // window between the two. Artifacts are immutable after ingestion.
        const failure = capture(() => copyFileSync(item.source, target, constants.COPYFILE_EXCL));
        if (failure === null)
        {
            continue;
        }
        if (codeOf(failure) === "EEXIST")
        {
            // Whoever wrote that name got there first; rollback must not reach
            // for a file this command did not create.
            staging.files.pop();
            return new CliError(`artifact id ${item.id} is already stored — run the report again`);
        }
        return new CliError(`artifact "${item.name}" could not be copied into the store: ${failure.message}`);
    }
    return null;
}

// Rollback removes what this command made and nothing more: the files it
// copied, by name, and then the directories it created, one level at a time and
// only while they are empty. A recursive delete here would take the shared
// artifacts root — or a concurrent report's bytes — down with one failed set.
function removeStaged(staging: Staging): void
{
    for (const file of staging.files)
    {
        rmSync(file, { force: true });
    }
    staging.files.length = 0;
    for (const dir of staging.dirs)
    {
        // Deepest first, and a directory another report has meanwhile filled
        // refuses to go and is left standing.
        capture(() => rmdirSync(dir));
    }
    staging.dirs.length = 0;
}

function codeOf(error: Error): string | undefined
{
    return (error as NodeJS.ErrnoException).code;
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
            for (const meta of declaredArtifacts(event))
            {
                records.push({
                    ...meta,
                    project: slug,
                    work: event.refs?.work,
                    ts: event.ts,
                    summary: summaryOf(event)
                });
            }
        }
    }
    return records;
}

// Bytes reach the store through a report or through a review receipt, and the
// registry is derived from whichever event named them: a review record that
// only one surface could find would be a record nobody can audit.
function declaredArtifacts(event: { type: string; payload: Record<string, unknown> }): ArtifactMeta[]
{
    if (event.type === "report.added" && Array.isArray(event.payload.artifacts))
    {
        return event.payload.artifacts as ArtifactMeta[];
    }
    if (event.type === "review.received" && event.payload.artifact !== undefined)
    {
        return [event.payload.artifact as ArtifactMeta];
    }
    return [];
}

function summaryOf(event: { type: string; payload: Record<string, unknown> }): string
{
    if (event.type !== "review.received")
    {
        return String(event.payload.text ?? "");
    }
    return `${event.payload.scope} review ${event.payload.verdict} for ${event.payload.changeSet}`;
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
        openArtifact(ctx, rest.slice(1));
        return;
    }
    throw new CliError("usage: self artifact list [--work id] [--project slug] | search <query> | open <id> [--project slug]");
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

function openArtifact(ctx: CliContext, args: string[]): void
{
    const id: string | undefined = args[0];
    const wanted = id?.trim();
    if (wanted === undefined || wanted === "" || wanted.startsWith("--"))
    {
        throw new CliError("usage: self artifact open <id> [--project slug]");
    }
    const project = valueAfter(args, "--project");
    const slugs = project === undefined
        ? readRegistry(ctx.storeDir).map((entry) => entry.slug)
        : [requireRegistered(ctx, project)];
    const matches = listArtifacts(ctx.storeDir, slugs).filter((item) => item.id === wanted);
    if (matches.length === 0)
    {
        throw new CliError(`unknown artifact "${wanted}" — run \`self artifact list\` to see ids`);
    }
    // An id is minted per artifact, not per workspace, so two projects can
    // hold the same one. Opening whichever the fold listed first would show
    // bytes nobody asked for; the ambiguity is stated instead.
    const stored = [...new Map(matches.map((item): [string, ArtifactRecord] => [item.path, item])).values()];
    if (stored.length > 1)
    {
        const where = stored.map((item) => `${item.project}/${item.name}`).join(", ");
        throw new CliError(`artifact id "${wanted}" names ${stored.length} stored files (${where}) — narrow it with \`--project <slug>\``);
    }
    const record = stored[0];
    const file = join(ctx.storeDir, record.path);
    if (!existsSync(file))
    {
        throw new CliError(`artifact file ${record.path} is missing from this store — run \`self sync\` to fetch it`);
    }
    launchFile(ctx, file);
    console.log(`opened ${record.name} (${record.id})`);
}
