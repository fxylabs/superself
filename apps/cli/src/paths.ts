import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { checkoutTops, excludeLocally, realPath, repositoryIdentity, topOf } from "./gitutil.js";
import { machineWorkspace, setMachineWorkspace } from "./machine.js";
import { CliError, RegistryEntry } from "./types.js";

export const STORE_DIR = ".superself";
export const MARKER_FILE = ".self";
export const LINKS_FILE = "links.jsonl";
// Derived, machine-local, and git-excluded: what it summarizes is this
// machine's checkout of the project repository, so it must never travel in the
// synced store. `EVIDENCE_HEAD_EXCLUDE` is the pattern `self sync` writes into
// the store's local excludes.
export const EVIDENCE_HEAD_FILE = ".evidence-head.json";
export const EVIDENCE_HEAD_EXCLUDE = `projects/*/${EVIDENCE_HEAD_FILE}`;

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

// ── resolution cache ─────────────────────────────────────────────────────
// Which project a directory belongs to is asked many times inside one
// command: once per registered project by `self setup`, once per project by a
// workspace fold, and again by everything they call. The answer is derived
// from the registry, the links ledger, and what git says about the paths in
// them, so re-deriving it re-reads both files and re-probes the same
// directories.
//
// The cache is deliberately in-process and nothing else. A resolution answer
// contains, implicitly, the claim that a given repository still stands at a
// given path; persisting that claim is the #115 bug, where a checkout deleted
// and replaced went on resolving to the project that used to be there. Nothing
// here is written down, so a read after a write in another process starts from
// the files.
//
// What keeps it from outliving the state it summarizes is not the process:
// `self daemon start --foreground` is one process running ticks for as long as
// the supervisor lives. It is that every writer of those files calls
// `invalidateResolution` — the event append included, before the fold that
// follows it — and that a daemon tick clears them before it does anything, so
// a tick reads what the last one left on disk rather than what it summarized
// an hour ago. State the invariant that way to the next caller: the caches
// live until the next append or the next tick, never "until this command
// ends".
const links = new Map<string, Record<string, LinkedCheckout[]>>();
const registries = new Map<string, RegistryEntry[]>();
const matched = new Map<string, CheckoutMatch[]>();
const resolvedPaths = new Map<string, string | null>();

export function invalidateResolution(): void
{
    links.clear();
    registries.clear();
    matched.clear();
    resolvedPaths.clear();
}

export function readRegistry(storeDir: string): RegistryEntry[]
{
    const cached = registries.get(storeDir);
    if (cached !== undefined)
    {
        return cached;
    }
    const entries: RegistryEntry[] = readJsonl(join(storeDir, "registry.jsonl"));
    registries.set(storeDir, entries);
    return entries;
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

// What the verdicts beside it were computed against: `repository` digests
// every ref and the working tree's HEAD, `verdicts` digests the evidence file
// itself. Both are derived from the state the record summarizes, which is what
// makes the record safe to trust — a ref that moved, a branch that was
// deleted, or an evidence file another machine's fold replaced all change one
// of the two, and the recheck runs.
//
// It is emphatically not a cache of what repository a path holds. That
// question is answered lazily at resolution and never stored, because a stale
// answer to it resolves a command into the wrong project (#115).
export interface EvidenceHead
{
    repository: string;
    verdicts: string;
}

export function readEvidenceHead(storeDir: string, slug: string): EvidenceHead | null
{
    const file = join(projectStateDir(storeDir, slug), EVIDENCE_HEAD_FILE);
    if (!existsSync(file))
    {
        return null;
    }
    try
    {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return typeof parsed?.repository === "string" && typeof parsed?.verdicts === "string" ? parsed : null;
    }
    catch
    {
        return null;
    }
}

// Written once the exclude is in place, so a store that has never synced
// cannot commit a machine-local file on its first fold. The exclude is asked
// for once per process, because it costs a git probe and nothing this process
// does removes the line again. A daemon is one process for as long as it runs,
// so an exclude taken out from under it stays out of this set — the sync path
// is where that would matter, and `ensureSyncConfig` writes the line again
// there rather than trusting this.
const excluded = new Set<string>();

export function writeEvidenceHead(storeDir: string, slug: string, head: EvidenceHead): void
{
    if (!excluded.has(storeDir))
    {
        excluded.add(storeDir);
        excludeLocally(storeDir, EVIDENCE_HEAD_EXCLUDE);
    }
    writeFileSync(join(projectStateDir(storeDir, slug), EVIDENCE_HEAD_FILE), JSON.stringify(head) + "\n");
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
// The file is an append-only ledger, read in order: a link entry adds a path,
// a prune entry takes it away again, and a later link entry at the same path
// brings it back. Nothing is ever deleted from the file behind a reader's
// back, so what happened to a link is still legible after it stopped
// resolving — which is the whole point of pruning through a recorded entry
// rather than by rewriting the list (#128).
export function readLinks(storeDir: string): Record<string, LinkedCheckout[]>
{
    const cached = links.get(storeDir);
    if (cached !== undefined)
    {
        return cached;
    }
    const read: Record<string, LinkedCheckout[]> = {};
    for (const entry of readJsonl(join(storeDir, LINKS_FILE)))
    {
        applyLinkEntry(read[entry.slug] ?? (read[entry.slug] = []), entry);
    }
    links.set(storeDir, read);
    return read;
}

function applyLinkEntry(linked: LinkedCheckout[], entry: any): void
{
    const at = linked.findIndex((item) => item.path === entry.path);
    if (entry.pruned !== undefined)
    {
        if (at !== -1)
        {
            linked.splice(at, 1);
        }
        return;
    }
    if (at === -1)
    {
        linked.push(entry.repository === undefined
            ? { path: entry.path }
            : { path: entry.path, repository: String(entry.repository) });
    }
}

export interface PrunedLink
{
    slug: string;
    path: string;
}

// Links whose checkout is simply not there any more. Every read of a linked
// path pays for it — `existsSync`, and on the paths that survive that, a probe
// — so a workspace that accumulates deleted worktrees pays for them on every
// command forever (#128).
//
// Pruning is recorded, never silent list surgery: an entry naming the path and
// why it went states what happened, and the path is restored by re-linking it
// with `self project link`, exactly as the #115 remedy restores a replaced
// one. The record is a line in the links ledger rather than an event in the
// log because a link path is this machine's filesystem, and the sanitization
// gate refuses — correctly — to let a machine's paths into synced state.
//
// It runs only in a workspace sweep, never on an append: a read command must
// not decide that a volume which happens to be unmounted right now is gone.
export function pruneDeadLinks(storeDir: string): PrunedLink[]
{
    const gone: PrunedLink[] = [];
    for (const [slug, linked] of Object.entries(readLinks(storeDir)))
    {
        for (const link of linked.filter((item) => !existsSync(realPath(item.path))))
        {
            gone.push({ slug, path: link.path });
        }
    }
    if (gone.length > 0)
    {
        appendFileSync(join(storeDir, LINKS_FILE), gone
            .map((item) => JSON.stringify({ ...item, pruned: new Date().toISOString(), why: "path no longer exists" }) + "\n")
            .join(""));
        invalidateResolution();
    }
    return gone;
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
// One checkout reaches the ledger under one spelling. A path handed in as an
// argument keeps whatever symlinks the caller typed, while the same directory
// entered and read back from `process.cwd()` arrives resolved — and the two
// compare unequal, so linking a path both ways used to leave two entries for
// one checkout, each probed on every resolution. Every read already asks about
// `realPath(link.path)`, so recording it resolved is what the file was being
// read as anyway (#128).
//
// Every comparison against an existing line resolves that line too. A ledger
// written before this change holds whatever spelling was typed then, and
// comparing a resolved path against a raw one matched neither the stale scan
// nor the linked check: the re-link printed success, replaced nothing, and
// appended a second entry for one physical checkout. `pruneDeadLinks` can
// never remove it, because the path it names does exist — so the extra
// `existsSync` and identity probe on every resolution stayed forever, which is
// the cost #128 set out to remove.
export function recordLink(storeDir: string, slug: string, at: string, repository: string | null): boolean
{
    const path = realPath(at);
    const file = join(storeDir, LINKS_FILE);
    const entries = readJsonl(file);
    const here = (line: { path?: unknown }): boolean => typeof line.path === "string" && realPath(line.path) === path;
    const stale = entries.filter((entry) => here(entry)
        && entry.repository !== undefined && repository !== null && String(entry.repository) !== repository);
    const entry = repository === null ? { slug, path } : { slug, path, repository };
    // Whether this path is linked is read off the ledger's resolved state, not
    // off the raw lines: a path that was pruned still has its original line in
    // the file, and taking that as "already linked" would make the re-link at a
    // restored path report success and change nothing — the same dead end #115
    // closed for a replaced one.
    const linked = (readLinks(storeDir)[slug] ?? []).some(here);
    if (stale.length > 0)
    {
        // The stale claim goes; what was recorded about the path stays. A prune
        // entry is kept where it stood, so replacing an identity never quietly
        // erases the account of a checkout that went missing first — and the new
        // entry is appended last, so the replay ends with the path linked.
        const kept = entries.filter((item) => !here(item) || item.pruned !== undefined).concat([entry]);
        writeFileSync(file, kept.map((item) => JSON.stringify(item) + "\n").join(""));
        invalidateResolution();
        return true;
    }
    if (!linked)
    {
        appendFileSync(file, JSON.stringify(entry) + "\n");
        invalidateResolution();
    }
    return false;
}

// Warned about once per process, and deliberately not per tick: the resolution
// path runs on every command, and a stale link would otherwise print the same
// line in front of every one of them — or, in a daemon, once every interval
// into the log for as long as it runs, burying everything else it records. The
// remedy the line names is a person re-linking the checkout, so repeating it
// teaches nothing the first one did not.
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
    // A serialized tuple, not a joined string: a separator that can occur
    // inside a path would let two different questions share one answer.
    const key = JSON.stringify([storeDir, slug, from]);
    if (!resolvedPaths.has(key))
    {
        resolvedPaths.set(key, resolveProjectPathOnce(storeDir, slug, from));
    }
    return resolvedPaths.get(key) ?? null;
}

function resolveProjectPathOnce(storeDir: string, slug: string, from: string): string | null
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
    const key = JSON.stringify([storeDir, dir]);
    if (!matched.has(key))
    {
        matched.set(key, checkoutMatchesOnce(storeDir, dir));
    }
    return matched.get(key) ?? [];
}

function checkoutMatchesOnce(storeDir: string, dir: string): CheckoutMatch[]
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
