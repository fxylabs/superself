import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Verdict } from "@superself/fold";
import { checkoutTops, commonDir, excludeLocally, realPath, repositoryIdentity, topOf } from "./gitutil.js";
import { machineWorkspace, setMachineWorkspace } from "./machine.js";
import { serverBacked } from "./mode.js";
import { CliError, RegistryEntry } from "./types.js";

export const STORE_DIR = ".superself";
export const MARKER_FILE = ".self";
export const LINKS_FILE = "links.jsonl";
// Derived, machine-local, and git-excluded: what it summarizes is this
// machine's checkout of the project repository, so it must never travel in the
// synced store. `EVIDENCE_HEAD_EXCLUDE` is the pattern `self sync` writes into
// the store's local excludes.
const EVIDENCE_HEAD_FILE = ".evidence-head.json";
export const EVIDENCE_HEAD_EXCLUDE = `projects/*/${EVIDENCE_HEAD_FILE}`;

export interface CliContext
{
    workspaceDir: string;
    storeDir: string;
    // Which account this machine is logged in as, where the store is
    // server-backed and the log has to say whose work a record is. Set once per
    // invocation by the entry point and carried on every context this module
    // builds, so the append path records it without holding a way to read it.
    account?: string;
    project?: string;
    projectDir?: string;
}

// The value behind `CliContext.account`. A state writer must have no import
// path to a credential, so the reading happens at the entry point and the
// answer is left here — the resolution layer, which is where a context is made
// and therefore the only place that could put it on one.
let account: string | undefined = undefined;

export function useAccount(name: string | undefined): void
{
    account = name;
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

function resolveContext(cwd: string): CliContext | null
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
    const at = projectAt(storeDir, cwd, marker);
    return at === null
        ? { workspaceDir, storeDir, account }
        : { workspaceDir, storeDir, account, project: at.slug, projectDir: at.dir };
}

// Whether the store this machine points at keeps its records on a server. Asked
// by the entry point before any command has run, so it refuses nothing and
// resolves nothing else: a machine pointing at no workspace is an ordinary
// answer here, and the command that needs one says so itself.
//
// The machine's own pointer is read rather than the directory's marker, because
// a marker is only consulted to migrate a store written before the pointer
// existed — and a store written then is a git-backed one.
export function machineStoreServerBacked(): boolean
{
    const workspaceDir = machineWorkspace();
    return workspaceDir !== null && serverBacked(join(workspaceDir, STORE_DIR));
}

// The project this directory belongs to. The marker that governs the place is
// the first answer; without one the repository answers instead, and failing
// that the marker is carried across to this working tree. Registration is one
// act per project, not one per checkout of it.
//
// Exported because `self setup` explains this resolution to a person: asking
// the same function is what stops the explanation from naming one directory
// while every other command works in another.
export function projectAt(storeDir: string, cwd: string, marker: string | null): CheckoutMatch | null
{
    const governs = governing(cwd, marker);
    if (governs !== null)
    {
        return { slug: JSON.parse(readFileSync(governs, "utf8")).project, dir: dirname(governs) };
    }
    return checkoutProject(storeDir, cwd) ?? relocated(cwd, marker);
}

// The marker that governs this directory: the nearest `.self` above it, unless
// another working tree of the same repository stands in between. `.self` is
// git-excluded, so a worktree made inside a registered checkout carries no
// marker of its own, and walking past that boundary recorded the parent
// checkout's HEAD as the evidence for work that is not on it (#235).
//
// The file check stands in front of git. With no `.git` in between there is no
// room for another working tree, and no git process is spawned at all.
function governing(cwd: string, marker: string | null): string | null
{
    if (marker === null)
    {
        return null;
    }
    const dir = realPath(dirname(marker));
    if (checkoutBetween(cwd, dir) === null)
    {
        return marker;
    }
    const here = topOf(cwd);
    if (here === null || contains(here, dir))
    {
        return marker;
    }
    const common = commonDir(here);
    return common !== null && common === commonDir(dir) ? null : marker;
}

// The root of another working tree standing between this directory and the one
// the marker sits in. A linked worktree's root holds a `.git` file (`gitdir:
// …`) and a repository's root a `.git` directory, so this costs file checks
// alone and spawns no git.
//
// The marker's own directory is left out of the walk: a marker beside a `.git`
// is the ordinary registered root, not a boundary.
export function checkoutBetween(cwd: string, stop: string): string | null
{
    let at = realPath(resolve(cwd));
    while (at !== stop)
    {
        if (existsSync(join(at, ".git")))
        {
            return at;
        }
        const up = dirname(at);
        if (up === at)
        {
            return null;
        }
        at = up;
    }
    return null;
}

// The last answer when the link ledger has none: the place the marker names,
// carried to the same position inside this working tree. A command run in a
// worktree after its links were pruned (#308) arrives here.
function relocated(cwd: string, marker: string | null): CheckoutMatch | null
{
    if (marker === null)
    {
        return null;
    }
    const dir = dirname(marker);
    const here = topOf(cwd);
    const top = topOf(dir);
    if (here === null || top === null)
    {
        return null;
    }
    const at = join(here, relative(top, dir));
    return existsSync(at) && contains(at, realPath(resolve(cwd)))
        ? { slug: JSON.parse(readFileSync(marker, "utf8")).project, dir: at }
        : null;
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
// `self project init`, the one command that must not run there.
function unregisteredMessage(storeDir: string, cwd: string): string
{
    const elsewhere = checkoutMatches(storeDir, cwd)[0];
    if (elsewhere !== undefined)
    {
        return `this repository's registered project "${elsewhere.slug}" is at ${elsewhere.dir} — run self from there (\`self project init\` here would register a duplicate)`;
    }
    return "not inside a registered project — run `self project init` here to register it, or `self project link <slug> --here` if it is a checkout of a project registered on another machine";
}

/* ── read scope ────────────────────────────────────────────────────── */

// Which project a read answers for. Every read verb answers for the project
// the directory resolves to, takes `--project <slug>` to answer for another
// registered one, and — where the verb has a workspace-wide form — takes
// `--workspace` to answer for all of them. One resolver stands behind all
// three, so a slug means the same thing on every surface instead of each verb
// growing its own answer to "which project is this".
//
// A named project resolves out of the workspace store alone. Project state is
// synced state, so a read never needs the checkout, and a project registered
// on another machine reads here exactly as its own machine reads it. Nothing
// below folds, refolds, or appends: resolving a project in order to read it
// leaves it exactly as it stood.
//
// Writes have no scope flag at all. A write records into the project it runs
// in, so `--project` on one is an option that command never declared, and the
// argument gate names it rather than dropping it. A write that confirms a
// record which already exists is the one that does not have to ask: the id it
// names already has an owner, so `model.ts` `projectsHolding` finds it and
// `projectScope` below turns that slug into the context (#302). That is a
// third answer to "which project is this" — the directory, `--project`, and
// the record itself — and it is the last one: it exists because the argument
// already carried the answer, not because a caller wanted to choose.
//
// An archived project (#283) is registered and readable but out of every
// workspace-wide answer: `--workspace` resolves the active projects, and
// `--project <slug>` still resolves an archived one, with one line saying so.

export type ProjectScope = CliContext & { project: string };

interface ScopeChoice
{
    project?: string;
    workspace?: boolean;
}

// Declared once so every surface that offers the choice offers exactly it.
export const SCOPE_OPTIONS = { project: { type: "string" } } as const;
export const WORKSPACE_SCOPE_OPTIONS = { project: { type: "string" }, workspace: { type: "boolean" } } as const;

// The scope for a read that also answers outside a project: `self context` and
// `self status` summarize the workspace there rather than refusing, so this
// keeps returning a context with no project for them to branch on.
export function readScope(cwd: string, choice: ScopeChoice): CliContext
{
    requireOneScope(choice);
    if (choice.workspace !== true)
    {
        return choice.project === undefined ? requireWorkspace(cwd) : namedScope(cwd, choice.project);
    }
    const ctx = requireWorkspace(cwd);
    requireProjects(ctx.storeDir);
    // The directory's own project is dropped deliberately: the caller asked
    // for the workspace, and carrying it would answer for one project.
    return workspaceOnly(ctx);
}

// The same context with the directory's own project taken off it: which store
// this is and who this machine is logged in as are facts about the machine and
// travel, and the project is a fact about a directory and does not. Written
// once because every caller drops the same two fields, and one of them dropping
// the account by hand would silently take the author off every record a write
// naming another project makes.
//
// Exported for the one caller outside this module — `archive.ts`, which names a
// project rather than running in it and had built the narrowed context by hand.
export function workspaceOnly(ctx: CliContext): CliContext
{
    return { workspaceDir: ctx.workspaceDir, storeDir: ctx.storeDir, account: ctx.account };
}

// The scopes for a read that speaks per project — one, or every registered one.
export function readScopes(cwd: string, choice: ScopeChoice): ProjectScope[]
{
    requireOneScope(choice);
    if (choice.workspace !== true)
    {
        return [choice.project === undefined ? requireProject(cwd) : namedScope(cwd, choice.project)];
    }
    const ctx = requireWorkspace(cwd);
    return requireProjects(ctx.storeDir)
        .map((entry) => ({ ...workspaceOnly(ctx), project: entry.slug }));
}

function namedScope(cwd: string, slug: string): ProjectScope
{
    const ctx = requireWorkspace(cwd);
    const project = requireRegistered(ctx.storeDir, slug);
    // An archived project reads exactly as it always did (#283): naming it is
    // how its state stays reachable while it is out of every aggregate. The
    // note goes to the person on stderr, so a piped read still gets the bytes
    // an agent has always read.
    const note = archivedNote(ctx.storeDir, project);
    if (note !== null)
    {
        console.error(note);
    }
    return projectScope(ctx, project);
}

// The scope for a project whose slug the caller already resolved — from
// `--project` on a read, or from the record a confirm names (#302).
//
// The checkout travels only when that project is the one this directory
// already belongs to. Handing the current directory over as another project's
// would name a path belonging to somebody else, deriving that project's own
// checkout costs a repository probe (#128) no read needs, and a project
// registered on another machine has no path here to derive.
export function projectScope(ctx: CliContext, project: string): ProjectScope
{
    return ctx.project === project
        ? ctx as ProjectScope
        : { ...workspaceOnly(ctx), project };
}

export function requireRegistered(storeDir: string, slug: string): string
{
    const slugs = readRegistry(storeDir).map((entry) => entry.slug);
    if (!slugs.includes(slug))
    {
        throw new CliError(slugs.length === 0
            ? `unknown project "${slug}" — this workspace has no registered projects`
            : `unknown project "${slug}" — run \`self project\` to list the registered slugs: ${slugs.join(", ")}`);
    }
    return slug;
}

// A workspace-wide read of an empty workspace has nothing to aggregate. It is
// refused rather than answered with silence: the caller asked for every
// project, and empty output reads as "nothing is happening" when the truth is
// that nothing is registered.
function requireProjects(storeDir: string): RegistryEntry[]
{
    const entries = activeProjects(storeDir);
    if (entries.length === 0)
    {
        throw new CliError(readRegistry(storeDir).length === 0
            ? "this workspace has no registered projects — run `self project init` inside a project directory to register one"
            : "every registered project is archived — run `self project --archived` to list them, "
                + "or `self project restore <slug>` to bring one back");
    }
    return entries;
}

// Two scopes is not a narrower ask, it is two different ones. Letting either
// flag win would answer a question the caller did not ask.
function requireOneScope(choice: ScopeChoice): void
{
    if (choice.workspace === true && choice.project !== undefined)
    {
        throw new CliError(`--workspace reads every registered project and --project reads "${choice.project}" — pass one of them, not both`);
    }
}

/* ── archived projects ─────────────────────────────────────────────── */

// A project set aside (#283). Archiving is not retirement: no record changes,
// open work stays exactly as it stands, and `self project restore` brings the
// whole project back in the state it was left. What the state does is take the
// project out of every answer about the workspace, so a slug nobody is working
// on stops spending a reader's attention.
//
// It is read here, beside the store's other per-project state, because two
// families answer for the workspace — the scope resolver above, and the model
// enumeration in `model.ts` — and both have to exclude the same slugs. A second
// reader of the same events is what would let one of them keep a project the
// other dropped.
interface ProjectArchive
{
    ts: string;
    why: string;
}

const archives = new Map<string, ProjectArchive | null>();

export function projectArchive(storeDir: string, slug: string): ProjectArchive | undefined
{
    const key = JSON.stringify([storeDir, slug]);
    if (!archives.has(key))
    {
        archives.set(key, foldArchive(archiveEvents(storeDir, slug)));
    }
    return archives.get(key) ?? undefined;
}

// A log this machine cannot parse says nothing about whether the project was
// set aside, and answering "archived" for it would drop the project out of the
// listing that exists to name a store nobody can read (#75 T4.5). Unreadable
// reads as active, and the surface that folds the log reports the damage.
function archiveEvents(storeDir: string, slug: string): any[]
{
    try
    {
        return readJsonl(join(projectStateDir(storeDir, slug), "log.jsonl"));
    }
    catch
    {
        return [];
    }
}

// Ordered by timestamp with the event id breaking the tie, never by log order:
// a union-merged log carries the lines in neither, and two clones of one store
// must fold to one answer. The last transition standing is the state — there is
// no third one, because `restore` is the only way out of an archive and `undo`
// takes no archive back.
function foldArchive(events: any[]): ProjectArchive | null
{
    let state: ProjectArchive | null = null;
    for (const event of archiveTransitions(events))
    {
        state = event.type === "project.restored"
            ? null
            : { ts: String(event.ts), why: String(event.payload?.why ?? "") };
    }
    return state;
}

function archiveTransitions(events: any[]): any[]
{
    return events
        .filter((event) => event?.type === "project.archived" || event?.type === "project.restored")
        .sort((left, right) => String(left.ts).localeCompare(String(right.ts))
            || String(left.id).localeCompare(String(right.id)));
}

// The registered projects a workspace answer speaks for. Every aggregate reads
// this rather than the registry: an archived project that stayed in one of them
// would still be spending the attention archiving it was meant to give back.
export function activeProjects(storeDir: string): RegistryEntry[]
{
    return readRegistry(storeDir).filter((entry) => projectArchive(storeDir, entry.slug) === undefined);
}

interface ArchivedProject
{
    entry: RegistryEntry;
    archive: ProjectArchive;
}

export function archivedProjects(storeDir: string): ArchivedProject[]
{
    return readRegistry(storeDir).flatMap((entry) =>
    {
        const archive = projectArchive(storeDir, entry.slug);
        return archive === undefined ? [] : [{ entry, archive }];
    });
}

// A slug an archived project answers to, refused with what the caller was
// trying to do with it. Every surface that will not take an archived project —
// a write, a placement scope, a successor — refuses in these words, so the way
// back is named the same wherever a caller meets it.
export function refuseArchived(storeDir: string, slug: string, act: string): void
{
    if (projectArchive(storeDir, slug) !== undefined)
    {
        throw new CliError(`project "${slug}" is archived, so ${act} — `
            + `run \`self project restore ${slug}\` to bring it back`);
    }
}

// Said once per process, by whichever surface first resolves the project: a
// read of an archived project answers exactly as it always did, and the note is
// the one line that says why the slug is missing from everything else. `null`
// once it has been said, so `--project <slug>` and the render behind it never
// print it twice.
const noted = new Set<string>();

export function archivedNote(storeDir: string, slug: string): string | null
{
    const archive = projectArchive(storeDir, slug);
    if (archive === undefined || noted.has(slug))
    {
        return null;
    }
    noted.add(slug);
    return `project "${slug}" is archived (${archive.ts.slice(0, 10)}: ${archive.why}) — `
        + `run \`self project restore ${slug}\` to bring it back`;
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
const resolvedLists = new Map<string, ProjectRepositories>();

export function invalidateResolution(): void
{
    links.clear();
    registries.clear();
    matched.clear();
    resolvedPaths.clear();
    resolvedLists.clear();
    // The archive state is folded from a project's own log, which an append
    // just changed: `project archive` and `project restore` both write through
    // the same pipeline, so a read after either must start from the file.
    archives.clear();
}

// The three "said once" sets, forgotten between invocations rather than between
// appends. They are deliberately not part of `invalidateResolution`: that runs
// on every append, and clearing them there would print the archived note or the
// stale-link warning again in the middle of one command. What they must not
// outlive is the invocation — a second `runCli` in the same process is a second
// command, and a command that says nothing because an earlier one already did
// is a command answering for a run the caller never saw.
export function resetProcessNotices(): void
{
    noted.clear();
    excluded.clear();
    reported.clear();
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
    // The retention caps (#197 §4, #213), user-set in the store's config.json
    // and enforced by the entity verbs: both tiers in context tokens, each per
    // scope. They gate `state add` and `state place` only — rendering never
    // refuses, however far over a legacy store stands.
    fullTokens?: number;
    indexTokens?: number;
    // The instruction cap (#446), in the same tokens and per the same render
    // target, and deliberately not a retention tier: `instruction render`
    // prints every instruction whole however far the store stands over the
    // caps above, so an instruction charges none of them and is bounded here
    // instead. Sized for a manual rather than for a context window.
    instructionTokens?: number;
    // What one character costs in tokens, and whether that number came from a
    // real measurement or is still the shipped estimate. `self tokens` records
    // an observation; nothing else writes these.
    tokensPerCharacter?: number;
    tokensMeasured?: boolean;
    // Retired by #213 and never read as a cap again — see requireTokenCaps.
    fullCap?: number;
    indexCap?: number;
    // The alias table (#207 A): user rows over the built-in preset defaults,
    // keyed by verb. Same user-set-policy precedent as the caps above —
    // hand-editable, read on every invocation, never event-sourced.
    aliases?: Record<string, AliasRow>;
}

// One alias row: the label a verb records, and the default placement it
// records under. A malformed hand-edited value reads as absent, so the
// built-in default (or no default) answers instead of a crash.
export interface AliasRow
{
    label?: string;
    priority?: number;
    exposure?: string;
}

export function readStoreConfig(storeDir: string): StoreConfig
{
    const file = join(storeDir, "config.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

export interface RetentionCaps
{
    full: number;
    index: number;
    // Beside the tiers rather than one of them: what an instruction charges,
    // at any exposure, per render target (#446 §D-14).
    instruction: number;
}

// The defaults are user-ruled (2026-08-05): the full tier ≤ 1,000 tokens, the
// index tier ≤ 12,000. The index cap is deliberately the larger — a cap
// measures what a store may hold, the render budget measures what one render
// may spend, and the budget already cuts rows and leaves a pointer to the rest.
// The instruction cap is larger again, at 2,000: it bounds a manual read whole
// rather than a projection read under a budget, so the number that governs it
// is how much standing direction a session can be handed, not how much of one
// render a section may spend (#446 §D-14).
// A malformed configured value reads as the default rather than as no cap.
export function retentionCaps(config: StoreConfig): RetentionCaps
{
    requireTokenCaps(config);
    return {
        full: capValue(config.fullTokens, 1_000),
        index: capValue(config.indexTokens, 12_000),
        instruction: capValue(config.instructionTokens, 2_000)
    };
}

function capValue(value: number | undefined, fallback: number): number
{
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// What each retired key measured, and the key that replaced it.
const RETIRED_CAPS = [
    { old: "fullCap", now: "fullTokens", measured: "characters of full-exposure text" },
    { old: "indexCap", now: "indexTokens", measured: "index entities" }
] as const;

// A store written against the character-and-count caps is refused rather than
// re-interpreted (#213). `indexCap` counts entities, which has no conversion
// into tokens at all, so reading either key as a token cap would change what
// the store enforces without ever saying so.
function requireTokenCaps(config: StoreConfig): void
{
    for (const { old, now, measured } of RETIRED_CAPS)
    {
        if (config[old] !== undefined)
        {
            throw new CliError(`config.json still sets ${old}, which counted ${measured}; caps are measured in `
                + `context tokens now — ${remedy(old, now, config)}`);
        }
    }
}

// What to do about the retired key. Where the new key is already set the old
// one is only in the way; where it is not, the refusal names the value to put
// there — converted for a character count, and stated as the default for an
// entity count, which converts into nothing.
function remedy(old: string, now: "fullTokens" | "indexTokens", config: StoreConfig): string
{
    if (config[now] !== undefined)
    {
        return `${now} is already set, so remove ${old}`;
    }
    if (old === "indexCap")
    {
        return `replace it with ${now} (an entity count has no token conversion; the default is 12,000)`;
    }
    const characters = capValue(config.fullCap, 4_000);
    return `replace it with ${now} (${characters} characters is about `
        + `${Math.ceil(characters * tokenScale(config).perCharacter)} tokens)`;
}

const DEFAULT_TOKENS_PER_CHARACTER = 0.25;

export interface TokenScale
{
    perCharacter: number;
    // False while the ratio is the shipped estimate, so every number derived
    // from it can say which it is.
    measured: boolean;
}

// The conversion the caps and the render budget both speak through. A value
// outside (0, 1] reads as absent: no tokenizer emits more tokens than the text
// has characters, so such a number is a mistyped entry rather than a setting.
export function tokenScale(config: StoreConfig): TokenScale
{
    const value = config.tokensPerCharacter;
    return typeof value === "number" && value > 0 && value <= 1
        ? { perCharacter: value, measured: config.tokensMeasured === true }
        : { perCharacter: DEFAULT_TOKENS_PER_CHARACTER, measured: false };
}

// What each recorded commit turned out to be. The five values are declared in
// `@superself/fold`, because the fold takes them as an argument and must not
// disagree with the machine that decides them; they are re-exported here
// because this is where the file holding them is read, `reachability.ts`
// decides them against git, and both already ask this module.
//
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
export { Verdict } from "@superself/fold";

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
    // One key per repository the verdicts were judged across, by repository
    // identity (#331): a project linked to two repositories walks only the one
    // whose refs moved. Absent on a head written before evidence was judged
    // across repositories; the combined `repository` key above stands in.
    repositories?: Record<string, string>;
    // The repositories this machine asked, as the health line names them —
    // read by the console surfaces, which reuse the stored verdicts without
    // touching git and so cannot derive the names themselves.
    asked?: string[];
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
        return typeof parsed?.repository === "string" && typeof parsed?.verdicts === "string" ? evidenceHead(parsed) : null;
    }
    catch
    {
        return null;
    }
}

// The optional fields are taken only in the shape they were written in; a
// hand-edited or half-written head reads as one that recorded nothing there.
function evidenceHead(parsed: EvidenceHead & { repositories?: unknown; asked?: unknown }): EvidenceHead
{
    const head: EvidenceHead = { repository: parsed.repository, verdicts: parsed.verdicts };
    if (parsed.repositories !== null && typeof parsed.repositories === "object" && !Array.isArray(parsed.repositories))
    {
        head.repositories = Object.fromEntries(Object.entries(parsed.repositories)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
    if (Array.isArray(parsed.asked))
    {
        head.asked = parsed.asked.filter((name): name is string => typeof name === "string");
    }
    return head;
}

// Written once the exclude is in place, so a store that has never synced
// cannot commit a machine-local file on its first fold. The exclude is asked
// for once per process, because it costs a git probe and nothing this process
// does removes the line again. A daemon is one process for as long as it runs,
// so an exclude taken out from under it stays out of this set — the sync path
// is where that would matter, and `ensureSyncConfig` writes the line again
// there rather than trusting this.
const excluded = new Set<string>();

// Forgetting what the verdicts were judged against is how they are marked
// stale: the next fold finds no head, treats every repository as moved, and
// walks every unsettled hash again. Asked for after a link changes (#332), so
// health never carries a judgment made against the previous repository.
export function dropEvidenceHead(storeDir: string, slug: string): void
{
    rmSync(join(projectStateDir(storeDir, slug), EVIDENCE_HEAD_FILE), { force: true });
}

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
interface LinkedCheckout
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
// The stale claim goes; what was recorded about the path stays. A prune entry
// is kept where it stood, so replacing an identity never quietly erases the
// account of a checkout that went missing first — and the new entry is appended
// last, so the replay ends with the path linked.
function replaceLinkIdentity(file: string, entries: Record<string, unknown>[], entry: Record<string, unknown>,
    here: (line: { path?: unknown }) => boolean): void
{
    const kept = entries.filter((item) => !here(item) || item.pruned !== undefined).concat([entry]);
    writeFileSync(file, kept.map((item) => JSON.stringify(item) + "\n").join(""));
    invalidateResolution();
}

// What a link wrote: a new path, a replaced claim at a known path, or nothing.
// The caller that marks verdicts stale needs to know the ledger moved (#332),
// and the one that discloses a replacement needs to know it was that.
export type LinkChange = "added" | "replaced" | "unchanged";

export function recordLink(storeDir: string, slug: string, at: string, repository: string | null): LinkChange
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
        replaceLinkIdentity(file, entries, entry, here);
        return "replaced";
    }
    if (linked)
    {
        return "unchanged";
    }
    appendFileSync(file, JSON.stringify(entry) + "\n");
    invalidateResolution();
    return "added";
}

// Every path this machine has recorded for a slug, gone ones included,
// resolved the way every read of the ledger resolves them. `project unlink`
// reads this rather than `linkedPaths`: a path whose checkout is no longer
// there is exactly what it is asked to detach (#263).
export function recordedPaths(storeDir: string, slug: string): string[]
{
    return (readLinks(storeDir)[slug] ?? []).map((link) => realPath(link.path));
}

// The paths this machine has linked for a slug and still has, resolved the
// way every read of the ledger resolves them. What `project link` prints when
// asked to read, and what it compares a write against (#332).
export function linkedPaths(storeDir: string, slug: string): string[]
{
    return recordedPaths(storeDir, slug).filter((path) => existsSync(path));
}

// Which projects have this exact path recorded. One path can be recorded for
// two slugs — linking it to a second project never took it from the first —
// so an unlink that named the wrong project is told which one holds it (#263).
export function slugsLinkedAt(storeDir: string, path: string): string[]
{
    return Object.entries(readLinks(storeDir))
        .filter(([, linked]) => linked.some((link) => realPath(link.path) === path))
        .map(([slug]) => slug);
}

// Detaching a path a person named, written the way the automatic sweep writes
// one it found gone (#128): an appended entry naming the path and why it went,
// never surgery on the lines already in the file. So the account of a checkout
// stays legible after it stops resolving, and re-linking the path brings it
// back — the ledger is replayed in order, and a later link entry wins.
export function recordUnlink(storeDir: string, slug: string, path: string): void
{
    appendFileSync(join(storeDir, LINKS_FILE),
        JSON.stringify({ slug, path, pruned: new Date().toISOString(), why: "unlinked" }) + "\n");
    invalidateResolution();
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
            `run \`self project link <slug> --here\` in that checkout to link it to what stands there now`);
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

// Every repository a project's evidence is judged across, one path each
// (#331), in the order the links were recorded — so a hash two repositories
// both know is judged in the same one whichever checkout the fold ran from.
// The path `resolveProjectPath` picks stands for its repository, so a project
// linked to one repository is judged exactly where it was before; a second
// worktree of a repository already in hand is dropped before its identity is
// probed — the `rev-parse` that tells two paths are one repository is the
// cheap question, the history walk behind `standing` the dear one (#128).
//
// A linked path that exists but is not a repository stands for the
// repositories one level below it: the folder that holds a project's
// checkouts is what gets linked when the project spans more than one.
//
// `missing` is the links whose path is not on this machine and whose
// recorded repository is none of the ones found — a repository that cannot
// be asked, which is what stops a hash it alone knows from reading as
// vanished. A path that is gone but whose repository is here under another
// worktree is not missing, and a link that recorded no identity claims
// nothing, exactly as every other read of the ledger takes it.
export interface ProjectRepositories
{
    dirs: string[];
    missing: string[];
}

export function resolveProjectPaths(storeDir: string, slug: string, from: string = process.cwd()): ProjectRepositories
{
    const key = JSON.stringify([storeDir, slug, from]);
    if (!resolvedLists.has(key))
    {
        resolvedLists.set(key, resolveProjectPathsOnce(storeDir, slug, from));
    }
    return resolvedLists.get(key) ?? { dirs: [], missing: [] };
}

function resolveProjectPathsOnce(storeDir: string, slug: string, from: string): ProjectRepositories
{
    const primary = resolveProjectPath(storeDir, slug, from);
    const primaryKey = primary === null ? null : commonDir(primary);
    const found = new Map<string, string>();
    const take = (path: string): void =>
    {
        for (const dir of repositoriesAt(path))
        {
            const key = commonDir(dir) ?? dir;
            if (!found.has(key))
            {
                found.set(key, key === primaryKey && primary !== null ? primary : dir);
            }
        }
    };
    const absent = takeLinked(readLinks(storeDir)[slug] ?? [], found, primaryKey, take);
    if (primary !== null && !found.has(primaryKey ?? primary))
    {
        take(primary);
    }
    const dirs = [...found.values()];
    return { dirs, missing: missingRepositories(absent, dirs) };
}

// Every standing link whose repository is not in hand yet is taken; the links
// whose path is not on this machine come back for the caller to account for.
// A link of the primary's own repository is taken on the primary's standing,
// already asked by `resolveProjectPath`, so a project linked to one repository
// pays for no probe it did not pay for before (#128).
function takeLinked(
    linked: LinkedCheckout[],
    found: Map<string, string>,
    primaryKey: string | null,
    take: (path: string) => void
): LinkedCheckout[]
{
    const absent: LinkedCheckout[] = [];
    for (const link of linked)
    {
        const path = realPath(link.path);
        if (!existsSync(path))
        {
            absent.push(link);
            continue;
        }
        const key = commonDir(path) ?? path;
        if (!found.has(key) && (key === primaryKey || standing(link)))
        {
            take(path);
        }
    }
    return absent;
}

// Identities are asked only when a link is absent: they are what tells a
// missing worktree of a repository in hand from a missing repository.
function missingRepositories(absent: LinkedCheckout[], dirs: string[]): string[]
{
    const claimed = absent.filter((link) => link.repository !== undefined);
    if (claimed.length === 0)
    {
        return [];
    }
    const here = new Set(dirs.map((dir) => repositoryIdentity(dir)));
    return claimed.filter((link) => !here.has(link.repository as string)).map((link) => link.path);
}

// The repository at a path, or — a folder that is not one — the repositories
// directly below it, by name. One level only, and only children that carry a
// `.git` entry are asked, so a folder of many things costs one `rev-parse`
// per checkout rather than one per entry.
function repositoriesAt(path: string): string[]
{
    if (!existsSync(path))
    {
        return [];
    }
    if (commonDir(path) !== null)
    {
        return [path];
    }
    return childDirectories(path)
        .filter((child) => existsSync(join(child, ".git")) && commonDir(child) !== null);
}

function childDirectories(path: string): string[]
{
    try
    {
        return readdirSync(path, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(path, entry.name))
            .sort();
    }
    catch
    {
        return [];
    }
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

interface CheckoutMatch
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
// checkout of this repository — the case `self project init` must refuse,
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

export function contains(parent: string, child: string): boolean
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
