import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { checkoutTops, realPath, topOf } from "./gitutil.js";
import { machineWorkspace, setMachineWorkspace } from "./machine.js";
import { CliError, RegistryEntry } from "./types.js";

export const STORE_DIR = ".superself";
export const MARKER_FILE = ".self";
export const LINKS_FILE = "links.jsonl";

export interface CliContext
{
    workspaceDir: string;
    storeDir: string;
    project?: string;
    projectDir?: string;
}

export type ProjectContext = CliContext & { project: string; projectDir: string };

export function isStore(dir: string): boolean
{
    return existsSync(join(dir, "registry.jsonl"));
}

export function findUp(start: string, name: string): string | null
{
    let dir = resolve(start);
    while (true)
    {
        const candidate = join(dir, name);
        if (existsSync(candidate))
        {
            return candidate;
        }
        const parent = dirname(dir);
        if (parent === dir)
        {
            return null;
        }
        dir = parent;
    }
}

export function resolveContext(cwd: string): CliContext | null
{
    const marker = findUp(cwd, MARKER_FILE);
    const workspaceDir = workspaceDirFor(marker);
    if (workspaceDir === null)
    {
        return null;
    }
    const storeDir = join(workspaceDir, STORE_DIR);
    if (!isStore(storeDir))
    {
        throw new CliError(`${workspaceDir} holds no workspace store — run \`self workspace <path>\` to point this machine at one`);
    }
    if (marker !== null)
    {
        return {
            workspaceDir,
            storeDir,
            project: JSON.parse(readFileSync(marker, "utf8")).project,
            projectDir: dirname(marker)
        };
    }
    // No marker here, so the repository answers instead: registration is one
    // act per project, not one per checkout of it.
    const match = checkoutProject(storeDir, cwd);
    if (match === null)
    {
        return { workspaceDir, storeDir };
    }
    return { workspaceDir, storeDir, project: match.slug, projectDir: match.dir };
}

// The machine's workspace is the single source. Markers written before that
// carried the path themselves; the first command that meets one adopts it.
export function workspaceDirFor(marker: string | null): string | null
{
    const configured = machineWorkspace();
    if (configured !== null || marker === null)
    {
        return configured;
    }
    const legacy = JSON.parse(readFileSync(marker, "utf8")).workspace;
    if (typeof legacy !== "string" || !isStore(join(legacy, STORE_DIR)))
    {
        return null;
    }
    setMachineWorkspace(legacy);
    return legacy;
}

export function requireWorkspace(cwd: string): CliContext
{
    const ctx = resolveContext(cwd);
    if (ctx === null)
    {
        throw new CliError("this machine has no workspace — run `self init` in the directory that should hold it, or `self workspace <path>` to point at an existing one");
    }
    return ctx;
}

export function requireProject(cwd: string): ProjectContext
{
    const ctx = requireWorkspace(cwd);
    if (ctx.project === undefined || ctx.projectDir === undefined)
    {
        throw new CliError(unregisteredMessage(ctx.storeDir, cwd));
    }
    return ctx as ProjectContext;
}

// Reached only when neither a marker nor the repository answers. Inside a
// checkout that does hold a registered project, the directory is simply the
// wrong one — say where the project sits rather than sending the agent to
// `self project add`, the one command that must not run there.
function unregisteredMessage(storeDir: string, cwd: string): string
{
    const elsewhere = checkoutMatches(storeDir, cwd)[0];
    if (elsewhere !== undefined)
    {
        return `this repository's registered project "${elsewhere.slug}" is at ${elsewhere.dir} — run self from there (\`self project add\` here would register a duplicate)`;
    }
    return "not inside a registered project — run `self project add` here to register it, or `self project link <slug>` if it is a checkout of a project registered on another machine";
}

export function projectStateDir(storeDir: string, slug: string): string
{
    return join(storeDir, "projects", slug);
}

export function ensureDir(path: string): string
{
    mkdirSync(path, { recursive: true });
    return path;
}

export function readRegistry(storeDir: string): RegistryEntry[]
{
    return readJsonl(join(storeDir, "registry.jsonl"));
}

export interface StoreConfig
{
    lang?: string;
    theme?: string;
    // The zone every target date is judged in. Without it the same log would
    // read on-track on one machine and missed on another.
    timezone?: string;
}

export function readStoreConfig(storeDir: string): StoreConfig
{
    const file = join(storeDir, "config.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

// settled: reachable from the default branch — counts as progress, final.
// provisional: exists on a live branch that has not merged yet.
// abandoned: the branch that carried it still exists and no longer reaches it —
// the commit was reset or force-pushed away. Asserted only on that positive
// evidence, because it drops the work from progress and records the direction
// as a dead end.
// unknown: unreachable, and nothing says why. A squash- or rebase-merged branch
// that was deleted leaves exactly this trace, so it is never called abandoned.
// unverifiable: the hash resolves to nothing — history was rewritten or the
// evidence predates this clone.
//
// The verdicts are read here, beside the store's other state files, and decided
// against git in `reachability.ts`. The fold folds them into the model, so the
// reader has to sit below it.
export type Verdict = "settled" | "provisional" | "abandoned" | "unknown" | "unverifiable";

// Every fold, context and status read runs through this, so a store whose
// evidence file was truncated by an interrupted write degrades to "nothing is
// classified" instead of taking every command down with it. Absence and
// damage say the same thing here: no verdict, and nothing may be called landed.
export function readVerdicts(storeDir: string, slug: string): Record<string, Verdict>
{
    const file = join(projectStateDir(storeDir, slug), "evidence.json");
    if (!existsSync(file))
    {
        return {};
    }
    try
    {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch
    {
        return {};
    }
}

// One slug holds every checkout linked on this machine, not just the newest:
// parallel worktrees of one repository are normal, and last-wins repointing
// silently moved where a fold refreshes the managed block.
export function readLinks(storeDir: string): Record<string, string[]>
{
    const links: Record<string, string[]> = {};
    for (const entry of readJsonl(join(storeDir, LINKS_FILE)))
    {
        const paths = links[entry.slug] ?? (links[entry.slug] = []);
        if (!paths.includes(entry.path))
        {
            paths.push(entry.path);
        }
    }
    return links;
}

// Single-path needs resolve to the checkout the command was run from, so a
// fold never writes into a worktree another session is holding.
export function resolveProjectPath(storeDir: string, slug: string, from: string = process.cwd()): string | null
{
    const linked = readLinks(storeDir)[slug] ?? [];
    const active = linked.find((path) => contains(path, from));
    if (active !== undefined)
    {
        return active;
    }
    // An unlinked checkout is still the one the command ran in; only when the
    // command came from somewhere else does another checkout stand in.
    const match = checkoutProject(storeDir, from);
    if (match !== null && match.slug === slug)
    {
        return match.dir;
    }
    const fallback = linked.filter((path) => existsSync(path)).pop();
    return fallback ?? readRegistry(storeDir).find((item) => item.slug === slug)?.path ?? null;
}

export interface CheckoutMatch
{
    slug: string;
    dir: string;
}

interface RepositoryLink
{
    slug: string;
    path: string;
    top: string;
}

// Every project this machine has linked inside one of `tops`, the working
// trees of a single repository. A linked path outside all of them is ruled
// out on a string comparison; the few that remain are confirmed against their
// own top level, so a nested repository is never taken for the checkout it
// sits in.
function repositoryLinks(storeDir: string, tops: string[]): RepositoryLink[]
{
    const links = readLinks(storeDir);
    const found: RepositoryLink[] = [];
    for (const entry of readRegistry(storeDir))
    {
        for (const linked of links[entry.slug] ?? [])
        {
            const path = realPath(linked);
            if (!existsSync(path) || !tops.some((candidate) => contains(candidate, path)))
            {
                continue;
            }
            const top = topOf(path);
            if (top !== null && tops.includes(top))
            {
                found.push({ slug: entry.slug, path, top });
            }
        }
    }
    return found;
}

// Where each project registered in this repository sits inside the checkout
// `dir` belongs to, deepest first. A project is identified by its repository,
// so one linked checkout answers for every other checkout of it — including
// worktrees created long after registration. The registered path keeps its
// position under its own top level, which is what stops a monorepo where
// `apps/foo` is registered from claiming the whole worktree.
export function checkoutMatches(storeDir: string, dir: string): CheckoutMatch[]
{
    const target = realPath(resolve(dir));
    const here = topOf(target);
    if (here === null)
    {
        return [];
    }
    return repositoryLinks(storeDir, checkoutTops(target))
        .map((link) => ({ slug: link.slug, dir: join(here, relative(link.top, link.path)) }))
        .sort((a, b) => b.dir.length - a.dir.length);
}

// The project this directory belongs to on the strength of its repository
// alone. Two registered projects can share one repository, so the deepest
// mapped directory containing the current one wins.
export function checkoutProject(storeDir: string, dir: string): CheckoutMatch | null
{
    const target = realPath(resolve(dir));
    return checkoutMatches(storeDir, target).find((match) => contains(match.dir, target)) ?? null;
}

// The slug of a project already registered at another checkout of this same
// repository — the case `self project add` must refuse, because the project
// is registered already and a second entry would split its state in two.
export function siblingSlug(storeDir: string, dir: string): string | null
{
    const target = realPath(resolve(dir));
    const here = topOf(target);
    if (here === null)
    {
        return null;
    }
    return repositoryLinks(storeDir, checkoutTops(target)).find((link) => link.top !== here)?.slug ?? null;
}

function contains(parent: string, child: string): boolean
{
    const base = resolve(parent);
    const target = resolve(child);
    return target === base || target.startsWith(base + sep);
}

function readJsonl(file: string): any[]
{
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
}
