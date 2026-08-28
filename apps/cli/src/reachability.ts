import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EntityState, isLive, scopeTarget } from "./entities.js";
import { checkoutTops, git, realPath, refListing, repositoryIdentity, resolveCommits, revListExcept } from "./gitutil.js";
import { EvidenceHead, linkedPaths, ProjectRepositories, projectArchive, projectStateDir, readEvidenceHead, readVerdicts, Verdict, writeEvidenceHead } from "./paths.js";
import { WorkState } from "./model.js";
import { artifactMetas } from "./registry.js";
import { digestFile } from "./repo.js";
import { ArtifactMember, ArtifactMeta } from "./types.js";

interface Evidence
{
    hash: string;
    branch?: string;
    // The repository the report named, by identity (#331). Where two linked
    // repositories both resolve the hash, this one judges it.
    repository?: string;
}

// Everything a reachability verdict reads *out of the refs*, in one probe:
// every ref, and the HEAD of the working tree the command stands in. A branch
// deletion is the case a HEAD alone would miss — it moves no commit and still
// flips an abandonment verdict — and it is in here because deleting a branch
// takes its line out of the listing.
//
// It is not everything a verdict turns on, and the key must not be read as if
// it were: whether the object is still in the database moves nothing here, so
// it is asked on every fold rather than gated on this (#128).
interface RepositoryState
{
    key: string;
    branches: Set<string>;
}

function repositoryState(projectDir: string): RepositoryState
{
    const listing = refListing(projectDir);
    const branches = new Set(listing.split("\n")
        .map((line) => line.slice(line.indexOf(" ") + 1))
        .filter((name) => name.startsWith("refs/heads/"))
        .map((name) => name.slice("refs/heads/".length)));
    return { key: digest(listing), branches };
}

// One repository a project's evidence is judged in (#331): where it is, what
// it is, what it is called, and the state its verdicts are keyed on. The
// identity is the root commit, the same value a link records and a report
// stamps; a repository with no commit yet is keyed by its path instead. The
// label is the name a person knows the repository by — its main working
// tree's directory — and is what the health line prints.
interface Repository
{
    dir: string;
    identity: string;
    label: string;
    state: RepositoryState;
}

function openRepository(dir: string): Repository | null
{
    if (!existsSync(dir) || !git(dir, "rev-parse", "--git-dir").ok)
    {
        return null;
    }
    return {
        dir,
        identity: repositoryIdentity(dir) ?? realPath(dir),
        label: basename(checkoutTops(dir)[0] ?? dir),
        state: repositoryState(dir)
    };
}

function digest(content: string): string
{
    return createHash("sha256").update(content).digest("hex");
}

// Recomputes verdicts across every repository the project is linked to on
// this machine (#331); where none is, the stored verdicts pass through
// untouched, so an unlinked machine never demotes evidence it cannot check.
//
// Two things bound what is recomputed, and neither of them changes what a
// verdict says. Settled is final, which is a recorded decision: a commit on
// the default branch does not come off it, and the archive was riding the
// sweep on every event for nothing. And the two history walks are spent only
// in a repository whose state a verdict was computed against has moved — a
// ref, a branch, a HEAD, or the evidence file itself, which another machine's
// fold can replace under a sync. A hash nothing has judged yet is always
// walked, whatever the state says (#128).
//
// Whether the object is still in the database is asked every time, because it
// is the one input the ref listing cannot carry: pruning an unreachable commit
// moves no ref, so a gate keyed on the listing alone went on answering
// "unknown" where the truth had become "unverifiable" — and "unverifiable" is
// the verdict that raises the health signal saying recorded evidence has
// vanished. In a repository whose refs never move, which is exactly where an
// auto-`gc` past the loose-object grace is the only thing that happens, the
// signal never fired again. Asking costs one `cat-file --batch-check` process
// for the whole repository, so the bound #128 defends — flat in the number of
// commits — is untouched.
export function updateVerdicts(storeDir: string, slug: string, linked: ProjectRepositories, evidence: Evidence[]): Record<string, Verdict>
{
    const verdicts = readVerdicts(storeDir, slug);
    const opened = linked.dirs.map(openRepository);
    const repositories = opened.filter((repo): repo is Repository => repo !== null);
    if (repositories.length === 0)
    {
        return verdicts;
    }
    // Every linked repository answered: the one condition under which
    // "nothing resolves it" may be said. A path that is gone, or one git can
    // no longer open, might be the repository that knows the hash.
    const complete = linked.missing.length === 0 && opened.length === repositories.length;
    const known = readEvidenceHead(storeDir, slug);
    const current = digest(serialize(verdicts));
    const moved = (repo: Repository): boolean =>
        known === null || known.verdicts !== current || keyOf(known, repo) !== repo.state.key;
    const pending = evidence.filter((item) => verdicts[item.hash] !== "settled");
    const judged = pending.length === 0
        ? new Map<string, Verdict>()
        : classifyAcross(repositories, pending, verdicts, moved, complete);
    if (judged === null)
    {
        return verdicts;
    }
    return commitVerdicts(storeDir, slug, verdicts, judged, repositories);
}

// The key this repository's verdicts were last judged against. A head written
// before verdicts were judged across repositories recorded one key for the
// one repository it had, and that key still answers for it — so an upgrade
// walks nothing a moved ref would not have.
function keyOf(known: EvidenceHead, repo: Repository): string | undefined
{
    return known.repositories === undefined ? known.repository : known.repositories[repo.identity];
}

// The repositories this machine last judged the verdicts across, as the
// health line names them (#331). Read off the head rather than derived, so
// the console surfaces — which reuse the stored verdicts without touching git
// — print the same names the fold did.
export function askedRepositories(storeDir: string, slug: string): string[]
{
    return readEvidenceHead(storeDir, slug)?.asked ?? [];
}

function serialize(verdicts: Record<string, Verdict>): string
{
    return JSON.stringify(verdicts, null, 2) + "\n";
}

// The evidence file is written only when a verdict actually moved, exactly as
// before. The head record is written whenever the fold got a clean answer, so
// the next fold can tell that nothing has moved under it — and it records the
// digest of the file as it now stands, so it is a statement about the verdicts
// beside it rather than about the ones this run started from.
function commitVerdicts(
    storeDir: string,
    slug: string,
    verdicts: Record<string, Verdict>,
    judged: Map<string, Verdict>,
    repositories: Repository[]
): Record<string, Verdict>
{
    let changed = false;
    for (const [hash, verdict] of judged)
    {
        if (verdicts[hash] !== verdict)
        {
            verdicts[hash] = verdict;
            changed = true;
        }
    }
    const content = serialize(verdicts);
    if (changed)
    {
        writeFileSync(join(projectStateDir(storeDir, slug), "evidence.json"), content);
    }
    writeEvidenceHead(storeDir, slug, headOf(repositories, digest(content)));
    return verdicts;
}

// One key per repository, and a combined key over all of them in identity
// order, so the record reads the same whichever checkout the fold ran from.
function headOf(repositories: Repository[], verdicts: string): EvidenceHead
{
    const sorted = [...repositories].sort((a, b) => a.identity.localeCompare(b.identity));
    return {
        repository: digest(sorted.map((repo) => repo.state.key).join("\n")),
        verdicts,
        repositories: Object.fromEntries(sorted.map((repo) => [repo.identity, repo.state.key])),
        asked: repositories.map((repo) => repo.label)
    };
}

// The same four questions `classify` asked one hash at a time, asked once for
// the whole set, in the repository that knows each hash (#331). The order is
// the order it decided in, so a hash gets the verdict it always got:
//
//   no linked repository resolves it        → unverifiable
//   reachable from that repo's default branch → settled
//   reachable from some ref, or from HEAD   → provisional
//   otherwise, and its branch still exists  → abandoned, else unknown
//
// Existence is asked of every repository for every hash — one `cat-file
// --batch-check` per repository, which is #128's bound — and a hash is judged
// in the repository the report named when that one resolves it, else in the
// first, in link order, that does. Only the walks are gated, per repository:
// a hash that still resolves and already carries a verdict keeps it while the
// repository that knows it stands still. A stored `unverifiable` is walked
// again the moment the object comes back, because no ref listing can report
// that it did.
//
// `unverifiable` is said only when every linked repository could be asked.
// A repository whose path is not on this machine might be the one that knows
// the hash, and silence from it is not "nothing resolves" — those hashes keep
// whatever verdict they had.
//
// `null` says git could not be asked. The caller leaves every stored verdict
// alone there rather than reading silence as "nothing resolves".
function classifyAcross(
    repositories: Repository[],
    items: Evidence[],
    verdicts: Record<string, Verdict>,
    moved: (repo: Repository) => boolean,
    complete: boolean
): Map<string, Verdict> | null
{
    const resolved = resolveEverywhere(repositories, items.map((item) => item.hash));
    if (resolved === null)
    {
        return null;
    }
    const judged = new Map<string, Verdict>();
    const homed = new Map<Repository, Evidence[]>(repositories.map((repo) => [repo, []]));
    for (const item of items)
    {
        const home = homeOf(item, repositories, resolved);
        if (home !== null)
        {
            homed.get(home)?.push(item);
        }
        else if (complete)
        {
            judged.set(item.hash, "unverifiable");
        }
    }
    return walkHomed(homed, verdicts, moved, resolved, judged);
}

function walkHomed(
    homed: Map<Repository, Evidence[]>,
    verdicts: Record<string, Verdict>,
    moved: (repo: Repository) => boolean,
    resolved: Map<Repository, Map<string, string>>,
    judged: Map<string, Verdict>
): Map<string, Verdict> | null
{
    for (const [repo, owned] of homed)
    {
        const walked = classifyIn(repo, owned, verdicts, moved(repo), resolved.get(repo) ?? new Map());
        if (walked === null)
        {
            return null;
        }
        walked.forEach((verdict, hash) => judged.set(hash, verdict));
    }
    return judged;
}

function resolveEverywhere(repositories: Repository[], hashes: string[]): Map<Repository, Map<string, string>> | null
{
    const resolved = new Map<Repository, Map<string, string>>();
    for (const repo of repositories)
    {
        const answer = resolveCommits(repo.dir, hashes);
        if (answer === null)
        {
            return null;
        }
        resolved.set(repo, answer);
    }
    return resolved;
}

function homeOf(item: Evidence, repositories: Repository[], resolved: Map<Repository, Map<string, string>>): Repository | null
{
    const knows = (repo: Repository): boolean => resolved.get(repo)?.has(item.hash) === true;
    return repositories.find((repo) => repo.identity === item.repository && knows(repo))
        ?? repositories.find(knows)
        ?? null;
}

function classifyIn(
    repo: Repository,
    items: Evidence[],
    verdicts: Record<string, Verdict>,
    moved: boolean,
    resolved: Map<string, string>
): Map<string, Verdict> | null
{
    const walking = items.filter((item) =>
        moved || verdicts[item.hash] === undefined || verdicts[item.hash] === "unverifiable");
    return walkVerdicts(repo.dir, repo.state, walking, resolved);
}

// Where the commit sits once it is known to exist: merged, live on some ref,
// or reachable from nothing. Two `rev-list` processes for the whole set, which
// is what makes the cost flat in the number of commits (#128).
// No default branch in this checkout means nothing can be called merged, so
// nothing is excluded and every commit stays a candidate.
function unmergedOids(projectDir: string, mainRef: string | null, items: Evidence[], resolved: Map<string, string>): Set<string> | null
{
    const oids = items.map((item) => resolved.get(item.hash) as string);
    return mainRef === null ? new Set(oids) : revListExcept(projectDir, oids, ["--not", mainRef]);
}

// `--single-worktree` keeps `--all` to this working tree's HEAD, which is the
// one `merge-base --is-ancestor <hash> HEAD` asked about. Without it a sibling
// worktree's detached HEAD would start rescuing commits, and that would be a
// verdict this fold never used to reach.
function danglingOids(projectDir: string, unsettled: Evidence[], resolved: Map<string, string>): Set<string> | null
{
    return revListExcept(projectDir, unsettled.map((item) => resolved.get(item.hash) as string),
        ["--single-worktree", "--not", "--all"]);
}

function walkVerdicts(
    projectDir: string,
    state: RepositoryState,
    items: Evidence[],
    resolved: Map<string, string>
): Map<string, Verdict> | null
{
    const verdicts = new Map<string, Verdict>();
    if (items.length === 0)
    {
        return verdicts;
    }
    const mainRef = defaultRef(projectDir);
    const unmerged = unmergedOids(projectDir, mainRef, items, resolved);
    if (unmerged === null)
    {
        return null;
    }
    const unsettled = items.filter((item) => unmerged.has(resolved.get(item.hash) as string));
    const dangling = danglingOids(projectDir, unsettled, resolved);
    if (dangling === null)
    {
        return null;
    }
    for (const item of items)
    {
        verdicts.set(item.hash, verdictOf(item, state, mainRef, resolved.get(item.hash), unmerged, dangling));
    }
    return verdicts;
}

function verdictOf(
    item: Evidence,
    state: RepositoryState,
    mainRef: string | null,
    oid: string | undefined,
    unmerged: Set<string>,
    dangling: Set<string>
): Verdict
{
    if (oid === undefined)
    {
        return "unverifiable";
    }
    if (!unmerged.has(oid))
    {
        return "settled";
    }
    if (!dangling.has(oid))
    {
        return "provisional";
    }
    return discarded(state, mainRef, item) ? "abandoned" : "unknown";
}

// No default branch in this checkout means nothing can be called merged. The
// old fallback to HEAD settled every commit the current branch reached, which
// read unmerged work as finished.
function defaultRef(projectDir: string): string | null
{
    const remoteHead = git(projectDir, "symbolic-ref", "-q", "refs/remotes/origin/HEAD");
    if (remoteHead.ok)
    {
        return remoteHead.out.replace("refs/remotes/", "");
    }
    for (const name of ["main", "master"])
    {
        if (git(projectDir, "show-ref", "--verify", "-q", `refs/heads/${name}`).ok)
        {
            return name;
        }
    }
    return null;
}

// The branch a report was made from still exists and no longer reaches the
// commit: it was reset or force-pushed away. Evidence reported from the default
// branch is excluded — an unreachable hash handed in from elsewhere says
// nothing about a discarded branch.
//
// Whether the branch exists is read off the ref listing the state key was
// built from, so it costs no probe of its own and cannot disagree with the key
// that decided this recheck was needed.
function discarded(state: RepositoryState, mainRef: string | null, item: Evidence): boolean
{
    return item.branch !== undefined
        && item.branch !== mainRef
        && state.branches.has(item.branch);
}

// Open work, plus any unit a live proposal gates. A closed unit is normally
// left alone — its verdicts stop moving and rechecking the whole archive on
// every event would make recording state cost more the longer a project lives.
// A gated unit is the exception the band needs: its evidence usually merges
// after the unit closed, and a verdict frozen at "provisional" would leave a
// rule the work already landed under reading as one still waiting to be made.
// The exception stays bounded — it is the work named by proposals nobody has
// confirmed yet, not the archive.
export function evidenceOf(works: WorkState[]): Evidence[]
{
    const seen = new Map<string, Evidence>();
    const tracked = works.filter((item) =>
        (item.status !== "done" && item.status !== "retired") || item.gatedBy.length > 0);
    for (const work of tracked)
    {
        for (const report of work.reports)
        {
            for (const hash of report.commits)
            {
                if (!seen.has(hash) || seen.get(hash)?.branch === undefined)
                {
                    seen.set(hash, { hash, branch: report.branch, repository: report.repository });
                }
            }
        }
    }
    return [...seen.values()];
}

// Only verdicts that ask for an action reach health. "unknown" says the fold
// cannot tell a merge from a discard; that is not the reader's problem to fix,
// and raising it would fire on every squash-merged pull request.
export function verdictSignals(works: WorkState[], verdicts: Record<string, Verdict>, asked: string[]): string[]
{
    const signals: string[] = [];
    for (const work of works.filter((item) => item.status !== "done" && item.status !== "retired"))
    {
        for (const hash of work.evidence)
        {
            if (verdicts[hash] === "abandoned")
            {
                signals.push(`${work.id} evidence ${hash} was reset away on its branch — that direction reads as attempted and abandoned`);
            }
            if (verdicts[hash] === "unverifiable")
            {
                signals.push(`${work.id} evidence ${hash} ${vanished(asked)}`);
            }
        }
    }
    return signals;
}

// A project judged in one repository keeps the line it always had. One judged
// across several names the repositories that were asked, because the reader's
// first question is whether the one holding the hash was among them — and the
// likeliest answer, a repository not linked on this machine, is said beside
// the rewrite it used to be blamed on (#331).
function vanished(asked: string[]): string
{
    if (asked.length < 2)
    {
        return "no longer resolves in the project repo — history may have been rewritten";
    }
    return `no longer resolves in any linked repository (asked: ${asked.join(", ")}) — ` +
        "history may have been rewritten, or the repository holding it is not linked on this machine";
}

// Whether a verdict can be recomputed on this machine at all. It asks the
// condition `updateVerdicts` returns at — no repository opened — without
// opening one: the machine link ledger and `existsSync`, no git process, so a
// read surface may ask it too (#128).
export function verdictsFrozen(storeDir: string, slug: string): boolean
{
    return linkedPaths(storeDir, slug).length === 0;
}

// Said only where frozen verdicts are still claiming something. The stored
// verdicts are left exactly as they stand — not demoting evidence this
// machine cannot check is the correct half of #128, and the defect was the
// silence over it, not the guard (#308). An empty band claims nothing, so
// there is nothing to say: on a machine sharing a store, every project not
// checked out here would otherwise raise a line.
export function frozenVerdictSignals(storeDir: string, slug: string, unshipped: number): string[]
{
    return unshipped === 0 || !verdictsFrozen(storeDir, slug) ? [] :
        [`no checkout of "${slug}" is linked on this machine, so these unshipped rows are the last verdicts `
            + `this machine could compute — run \`self project link ${slug} --here\` in the checkout`];
}

// Artifacts are the other evidence class this module verifies, against the
// store that owns their bytes, never against git. Open work only: a fold runs
// on every event, and rehashing the whole finished archive each time would
// make recording state cost more the longer a project lives.
export function artifactSignals(storeDir: string, works: WorkState[]): string[]
{
    const signals: string[] = [];
    for (const work of works.filter((item) => item.status !== "done" && item.status !== "retired"))
    {
        // A pruned record names bytes a person had removed on purpose, so the
        // file being absent is the recorded outcome rather than a defect.
        //
        // Defensive, not load-bearing: `artifact prune` refuses an artifact
        // whose work is anything but done or retired, which is exactly the set
        // this loop skips, so no ordinary path brings a pruned record here. It
        // guards a log edited by hand or written by another version — where
        // without it every fold would tell the reader to run `self sync` for a
        // file nothing will ever send them.
        for (const meta of work.artifacts.filter((item) => item.pruned === undefined))
        {
            const failure = artifactFailure(storeDir, meta);
            if (failure !== null)
            {
                signals.push(`${work.id} artifact ${meta.id} ${meta.name} ${failure}`);
            }
        }
    }
    return signals;
}

// A bundle's health is its members' (#362). Everything else is unchanged: a
// path outside the store is refused before it is read, and a single file
// answers exactly as it did.
function artifactFailure(storeDir: string, meta: ArtifactMeta): string | null
{
    // A link (#407) is an address, and this CLI never fetched it: there is
    // nothing on this machine to verify, so there is nothing to report. A
    // health check that reached the network would be a health check that
    // failed on a train.
    if (meta.url !== undefined)
    {
        return null;
    }
    const file = storedPath(storeDir, meta.path);
    if (file === null)
    {
        return "is recorded at a path outside this store's artifacts — the event naming it cannot be trusted";
    }
    return meta.members === undefined ? fileFailure(file, meta.digest) : bundleFailure(file, meta.members);
}

// The first member that fails is the signal, named by its path relative to the
// bundle. A store that never synced this bundle would otherwise print one line
// per file it holds, which says nothing the first line did not.
//
// A member path is event data and holds the same trust as the artifact path
// above it: none. A synced line naming `../../../../etc/passwd` as a member
// would otherwise have every fold, status and context on the reader's machine
// hash a file a peer chose, and say whether it had changed.
function bundleFailure(dir: string, members: ArtifactMember[]): string | null
{
    for (const member of members)
    {
        const file = containedPath(dir, member.path);
        if (file === null)
        {
            return `member ${member.path} is recorded outside the bundle it belongs to — the event naming it cannot be trusted`;
        }
        const failure = fileFailure(file, member.digest);
        if (failure !== null)
        {
            return `member ${member.path} ${failure}`;
        }
    }
    return null;
}

// An artifact ingested before digests were recorded carries none, so absence
// of a digest is silence, not a mismatch. Every answer here is a signal, never
// an exception: this runs inside every fold, status and context, and one file
// the store will not hand over may not take those commands down with it.
function fileFailure(file: string, digest: string | undefined): string | null
{
    if (!existsSync(file))
    {
        return "is missing from this store — run `self sync` to fetch it";
    }
    if (digest === undefined)
    {
        return null;
    }
    try
    {
        return digestFile(file) === digest
            ? null
            : "no longer matches the digest recorded when it was attached";
    }
    catch (error)
    {
        return unreadable(error);
    }
}

// The errno code names the cause — a permission that changed (EACCES, EPERM on
// Windows), a directory standing where a file belongs (EISDIR), a failing
// device. Only a bare errno name is repeated: the message carries the store's
// absolute path, and an unrecognised platform error carries whatever prose the
// system felt like, while this line is printed to everyone who reads status.
const ERRNO = /^E[A-Z0-9]+$/;

function unreadable(error: unknown): string
{
    const code = (error as NodeJS.ErrnoException)?.code;
    const cause = typeof code === "string" && ERRNO.test(code) ? ` (${code})` : "";
    return `cannot be read in this store${cause} — check that a readable file, not a directory, sits at its path`;
}

// The path comes from the event log, and a log travels between machines
// through a shared remote. A path resolving outside the artifacts root is
// refused instead of read: whether some file elsewhere on this machine exists,
// or matches a digest a peer chose, is not a question status may answer.
function storedPath(storeDir: string, path: string | undefined): string | null
{
    const file = resolve(storeDir, typeof path === "string" ? path : "");
    return within(join(storeDir, "artifacts"), file) ? file : null;
}

// The same reading, for a path named relative to a directory rather than to
// the store: one rule about what an event may point at, so the manifest half
// cannot drift into trusting what the artifact half refuses.
function containedPath(dir: string, path: string): string | null
{
    const file = resolve(dir, typeof path === "string" ? path : "");
    return within(dir, file) ? file : null;
}

function within(root: string, file: string): boolean
{
    const step = relative(root, file);
    return step !== "" && step !== ".." && !step.startsWith(".." + sep) && !isAbsolute(step);
}

// The artifact a live record points at (#238), checked against the store the
// same way a report's evidence is. `artifactSignals` above is left exactly as
// it stands: this is a second axis, and a second axis added to an existing
// function is a function two changes have to share.
//
// Live records only — proposed and confirmed. A retracted or superseded rule
// renders nowhere, so an artifact it named is nobody's problem, and reporting
// it would make a project noisier the longer it runs.
//
// This does not reopen the "open work only" rule `artifactSignals` states.
// That rule exists because a finished archive grows without bound; the set
// here is one artifact per live record, and live records are what the
// retention caps bound.
//
// One project's own fold, never the whole registry: a workspace-scoped rule
// renders in other projects through `scopedIn`, which never reaches
// `model.entities`, so the owning project raises the line exactly once.
export function entityArtifactSignals(storeDir: string, slug: string, entities: EntityState[]): string[]
{
    const referring = entities.filter((item) => isLive(item) && item.artifact !== undefined);
    const metas = artifactMetas(storeDir, slug, referring.map((item) => item.artifact as string));
    return referring.flatMap((entity) => referenceFailure(storeDir, metas, entity));
}

function referenceFailure(storeDir: string, metas: Map<string, ArtifactMeta>, entity: EntityState): string[]
{
    const id = entity.artifact as string;
    const meta = metas.get(id);
    // The same guard `artifactSignals` carries, for the same reason: prune
    // refuses an artifact a live record points at, so this is reachable only
    // from a log this CLI did not write — and saying "run `self sync`" about
    // bytes somebody removed on purpose is worse than saying nothing.
    if (meta?.pruned !== undefined)
    {
        return [];
    }
    if (meta === undefined)
    {
        return [`${entity.id} names artifact ${id}, which this project's log does not record — `
            + "run `self artifact list` to see what it holds, or restate the record with an artifact it stores"];
    }
    const failure = artifactFailure(storeDir, meta);
    return failure === null ? [] : [`${entity.id} artifact ${meta.id} ${meta.name} ${failure}`];
}

// The third thing that can render nowhere, beside a vanished commit and a
// missing artifact: a record whose scope names a project that was archived
// after the record was placed (#285).
//
// Nothing is wrong with the record. Its scope is still valid data — the slug is
// registered and comes back whole with `self project restore` — but every
// workspace aggregate answers from `paths.ts` `activeProjects`, so the project
// it renders in is out of every context until it is active again, and the
// record goes quiet with it. Placing a new record there is refused from the
// archive onward (#283), so only records placed before it reach this state, and
// without a line naming them the person who archived the project never learns
// what went silent with it.
//
// Read from the home project's own fold, which is where the record's events
// live and where `self state place` moves it from. That is also why the line
// names both ids a reader needs: the record, and the slug it points at.
//
// A scope naming a slug this workspace never registered is a different report
// and `self project` already makes it — that record cannot be brought back by
// restoring anything. This one is about a slug that is registered and set
// aside, so the line offers the way back as well as the way out.
export function archivedScopeSignals(storeDir: string, slug: string, entities: EntityState[]): string[]
{
    const signals: string[] = [];
    for (const entity of entities.filter((item) => isLive(item)))
    {
        const target = scopeTarget(entity, slug);
        if (target !== slug && target !== "workspace" && projectArchive(storeDir, target) !== undefined)
        {
            signals.push(`${entity.id} renders in "${target}", which is archived, so it renders nowhere — `
                + `run \`self project restore ${target}\` to bring it back, `
                + `or \`self state place ${entity.id} --scope <slug>\` to move it somewhere active`);
        }
    }
    return signals;
}
