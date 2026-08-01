import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { checkoutTops, realPath, repositoryIdentity, topOf } from "./gitutil.js";
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

// A path this machine linked, and the repository that stood there when it was
// linked. The identity is absent on links written before it was recorded, and
// on a checkout that had no commit yet when it was linked — both are read as
// "nothing was claimed" rather than as a mismatch.
export interface LinkedCheckout
{
    path: string;
    repository?: string;
}

// One slug holds every checkout linked on this machine, not just the newest:
// parallel worktrees of one repository are normal, and last-wins repointing
// silently moved where a fold refreshes the managed block.
export function readLinks(storeDir: string): Record<string, LinkedCheckout[]>
{
    const links: Record<string, LinkedCheckout[]> = {};
    for (const entry of readJsonl(join(storeDir, LINKS_FILE)))
    {
        const linked = links[entry.slug] ?? (links[entry.slug] = []);
        if (!linked.some((item) => item.path === entry.path))
        {
            linked.push(entry.repository === undefined
                ? { path: entry.path }
                : { path: entry.path, repository: String(entry.repository) });
        }
    }
    return links;
}

// Linking a path this machine already linked. Appending a second entry for a
// path would leave the stale one in front of it, so the entry is replaced —
// and only when what it claimed is no longer what stands there, which is the
// one case that needs it. Every read skips a path whose recorded identity
// stopped matching, so without this the remedy the #115 warning names could
// not clear the state it warns about and the checkout stayed unusable for
// good (#115).
//
// Deliberate is the point: `self project link` is a user act at that path, so
// the replacement is something a person asked for rather than resolution
// quietly deciding the claim was wrong.
export function recordLink(storeDir: string, slug: string, path: string, repository: string | null): boolean
{
    const file = join(storeDir, LINKS_FILE);
    const entries = readJsonl(file);
    const stale = entries.filter((entry) => entry.path === path
        && entry.repository !== undefined && repository !== null && String(entry.repository) !== repository);
    const entry = repository === null ? { slug, path } : { slug, path, repository };
    if (stale.length > 0)
    {
        const kept = entries.filter((item) => item.path !== path).concat([entry]);
        writeFileSync(file, kept.map((item) => JSON.stringify(item) + "\n").join(""));
        return true;
    }
    if (!entries.some((item) => item.slug === slug && item.path === path))
    {
        appendFileSync(file, JSON.stringify(entry) + "\n");
    }
    return false;
}

// Warned about once per process: the resolution path runs on every command,
// and a stale link would otherwise print the same line in front of every one
// of them.
const reported = new Set<string>();

// Whether the repository standing at a linked path is still the one that was
// linked there. A checkout deleted and replaced by an unrelated repository at
// the same path used to resolve silently to the old project — every command in
// the new repository answered as the old one (#115). A link that claimed no
// identity is left alone, because there is nothing to compare it against.
//
// What stands there arrives as a thunk, because deriving it is a git history
// walk of ~280 ms: a link that claimed nothing never pays for it, and a caller
// that already knows every candidate is a working tree of one repository
// passes one answer for all of them (#128).
function sameRepository(link: LinkedCheckout, path: string, identity: () => string | null): boolean
{
    if (link.repository === undefined || identity() === link.repository)
    {
        return true;
    }
    if (!reported.has(path))
    {
        reported.add(path);
        console.error(`warning: ${path} is no longer the repository linked there — ignoring the link; ` +
            `run \`self project link <slug>\` in that checkout to link it to what stands there now`);
    }
    return false;
}

// A link whose path is gone is still this project's — a checkout comes back,
// and a fold that skipped it would stop refreshing the managed block the
// moment a worktree was pruned. A link whose path now holds a different
// repository is not: writing this project's block into it would put one
// project's state inside another project's repository.
function standing(link: LinkedCheckout): boolean
{
    const path = realPath(link.path);
    return !existsSync(path) || sameRepository(link, path, () => repositoryIdentity(path));
}

// Single-path needs resolve to the checkout the command was run from, so a
// fold never writes into a worktree another session is holding.
//
// Standing is asked of the link that is about to be used, never of every link
// for the slug: `self setup` resolves once per registered project, and probing
// each of a project's checkouts there put a read command an order of magnitude
// over #128's half-second budget.
export function resolveProjectPath(storeDir: string, slug: string, from: string = process.cwd()): string | null
{
    const linked = readLinks(storeDir)[slug] ?? [];
    const active = linked.find((link) => contains(link.path, from) && standing(link));
    if (active !== undefined)
    {
        return active.path;
    }
    // An unlinked checkout is still the one the command ran in; only when the
    // command came from somewhere else does another checkout stand in.
    const match = checkoutProject(storeDir, from);
    if (match !== null && match.slug === slug)
    {
        return match.dir;
    }
    return lastStanding(linked) ?? readRegistry(storeDir).find((item) => item.slug === slug)?.path ?? null;
}

// The newest linked checkout that is still there and still holds what was
// linked. Asked newest first and stopped at the first answer, so the common
// store pays for one probe rather than one per link.
function lastStanding(linked: LinkedCheckout[]): string | undefined
{
    for (let index = linked.length - 1; index >= 0; index -= 1)
    {
        const link = linked[index];
        if (existsSync(link.path) && standing(link))
        {
            return link.path;
        }
    }
    return undefined;
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

// Whether `path` is a working tree of the repository `tops` describes, and
// which of them it is. The string test rules out the paths that are nowhere
// near this repository without spending a git call; the top level is what
// decides, because a path can sit inside the outer working tree and still be
// a repository of its own.
function checkoutTop(path: string, tops: string[]): string | null
{
    if (!existsSync(path) || !tops.some((candidate) => contains(candidate, path)))
    {
        return null;
    }
    const top = topOf(path);
    return top !== null && tops.includes(top) ? top : null;
}

// Every project this machine has linked inside one of `tops`, the working
// trees of a single repository.
//
// The top level decides before the identity does. A repository nested inside
// another one's working tree passes the path comparison but is not a checkout
// of it, and judging it against the outer repository's identity called a link
// that had gone nowhere stale — a warning naming a remedy that recomputes the
// same identity, finds nothing to replace, and leaves the line printing in
// front of every command. Not a working tree of this repository is dropped
// silently: the link says nothing about the repository being resolved.
function repositoryLinks(storeDir: string, tops: string[]): RepositoryLink[]
{
    const links = readLinks(storeDir);
    const identity = repositoryClaim(tops);
    const found: RepositoryLink[] = [];
    for (const entry of readRegistry(storeDir))
    {
        for (const linked of links[entry.slug] ?? [])
        {
            const path = realPath(linked.path);
            const top = checkoutTop(path, tops);
            if (top !== null && sameRepository(linked, path, identity))
            {
                found.push({ slug: entry.slug, path, top });
            }
        }
    }
    return found;
}

// Every path that reaches this claim is a working tree of one repository, so
// what stands at it is the same value for all of them: asked once for the
// repository rather than once per link, and not at all until a link actually
// claims an identity to compare against (#128).
function repositoryClaim(tops: string[]): () => string | null
{
    let identity: string | null | undefined;
    return () =>
    {
        if (identity === undefined)
        {
            identity = tops.length === 0 ? null : repositoryIdentity(tops[0]);
        }
        return identity;
    };
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

// The slug of a project already registered at this same directory in another
// checkout of this repository — the case `self project add` must refuse,
// because the project is registered already and a second entry would split its
// state in two.
//
// The position under the top level is what makes it the same directory. A
// project registered at `apps/foo` says nothing about the repository root
// beside it: answering for the root there refused a legitimate registration
// and, through `project link`, linked the root to the subdirectory project
// (#114).
export function siblingSlug(storeDir: string, dir: string): string | null
{
    const target = realPath(resolve(dir));
    const here = topOf(target);
    if (here === null)
    {
        return null;
    }
    return repositoryLinks(storeDir, checkoutTops(target))
        .find((link) => link.top !== here && join(here, relative(link.top, link.path)) === target)?.slug ?? null;
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
