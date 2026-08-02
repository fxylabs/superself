import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { git, refListing, resolveCommits, revListExcept } from "./gitutil.js";
import { EvidenceHead, projectStateDir, readEvidenceHead, readVerdicts, Verdict, writeEvidenceHead } from "./paths.js";
import { WorkState } from "./model.js";
import { digestFile } from "./repo.js";
import { ArtifactMeta } from "./types.js";

export interface Evidence
{
    hash: string;
    branch?: string;
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

function digest(content: string): string
{
    return createHash("sha256").update(content).digest("hex");
}

// Recomputes verdicts where the project repo is available; anywhere else the
// stored verdicts pass through untouched, so an unlinked machine never
// demotes evidence it cannot check.
//
// Two things bound what is recomputed, and neither of them changes what a
// verdict says. Settled is final, which is a recorded decision: a commit on
// the default branch does not come off it, and the archive was riding the
// sweep on every event for nothing. And the two history walks are spent only
// when the repository state a verdict was computed against has moved — a ref,
// a branch, a HEAD, or the evidence file itself, which another machine's fold
// can replace under a sync. A hash nothing has judged yet is always walked,
// whatever the state says (#128).
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
export function updateVerdicts(storeDir: string, slug: string, projectDir: string | null, evidence: Evidence[]): Record<string, Verdict>
{
    const verdicts = readVerdicts(storeDir, slug);
    if (projectDir === null || !existsSync(projectDir) || !git(projectDir, "rev-parse", "--git-dir").ok)
    {
        return verdicts;
    }
    const state = repositoryState(projectDir);
    const known = readEvidenceHead(storeDir, slug);
    const moved = !unchanged(known, { repository: state.key, verdicts: digest(serialize(verdicts)) });
    const pending = evidence.filter((item) => verdicts[item.hash] !== "settled");
    const judged = pending.length === 0
        ? new Map<string, Verdict>()
        : classifyAll(projectDir, state, pending, verdicts, moved);
    if (judged === null)
    {
        return verdicts;
    }
    return commitVerdicts(storeDir, slug, verdicts, judged, state);
}

function unchanged(known: EvidenceHead | null, current: EvidenceHead): boolean
{
    return known !== null && known.repository === current.repository && known.verdicts === current.verdicts;
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
    state: RepositoryState
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
    writeEvidenceHead(storeDir, slug, { repository: state.key, verdicts: digest(content) });
    return verdicts;
}

// The same four questions `classify` asked one hash at a time, asked once for
// the whole set. The order is the order it decided in, so a hash gets the
// verdict it always got:
//
//   nothing resolves it                     → unverifiable
//   reachable from the default branch       → settled
//   reachable from some ref, or from HEAD   → provisional
//   otherwise, and its branch still exists  → abandoned, else unknown
//
// Existence is asked for every hash; only the walks are gated. A hash that
// still resolves and already carries a verdict keeps it while the repository
// state stands still, and a hash that resolves to nothing is `unverifiable`
// without walking anything. A stored `unverifiable` is walked again the moment
// the object comes back, because no ref listing can report that it did.
//
// `null` says git could not be asked. The caller leaves every stored verdict
// alone there rather than reading silence as "nothing resolves".
function classifyAll(
    projectDir: string,
    state: RepositoryState,
    items: Evidence[],
    verdicts: Record<string, Verdict>,
    moved: boolean
): Map<string, Verdict> | null
{
    const resolved = resolveCommits(projectDir, items.map((item) => item.hash));
    if (resolved === null)
    {
        return null;
    }
    const judged = new Map<string, Verdict>();
    for (const item of items.filter((entry) => !resolved.has(entry.hash)))
    {
        judged.set(item.hash, "unverifiable");
    }
    const walking = items.filter((item) => resolved.has(item.hash)
        && (moved || verdicts[item.hash] === undefined || verdicts[item.hash] === "unverifiable"));
    const walked = walkVerdicts(projectDir, state, walking, resolved);
    if (walked === null)
    {
        return null;
    }
    walked.forEach((verdict, hash) => judged.set(hash, verdict));
    return judged;
}

// Where the commit sits once it is known to exist: merged, live on some ref,
// or reachable from nothing. Two `rev-list` processes for the whole set, which
// is what makes the cost flat in the number of commits (#128).
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
    const oids = (of: Evidence[]): string[] => of.map((item) => resolved.get(item.hash) as string);
    // No default branch in this checkout means nothing can be called merged,
    // so nothing is excluded and every commit stays a candidate.
    const unmerged = mainRef === null
        ? new Set(oids(items))
        : revListExcept(projectDir, oids(items), ["--not", mainRef]);
    if (unmerged === null)
    {
        return null;
    }
    const unsettled = items.filter((item) => unmerged.has(resolved.get(item.hash) as string));
    // `--single-worktree` keeps `--all` to this working tree's HEAD, which is
    // the one `merge-base --is-ancestor <hash> HEAD` asked about. Without it a
    // sibling worktree's detached HEAD would start rescuing commits, and that
    // would be a verdict this fold never used to reach.
    const dangling = revListExcept(projectDir, oids(unsettled), ["--single-worktree", "--not", "--all"]);
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
                    seen.set(hash, { hash, branch: report.branch });
                }
            }
        }
    }
    return [...seen.values()];
}

// Only verdicts that ask for an action reach health. "unknown" says the fold
// cannot tell a merge from a discard; that is not the reader's problem to fix,
// and raising it would fire on every squash-merged pull request.
export function verdictSignals(works: WorkState[], verdicts: Record<string, Verdict>): string[]
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
                signals.push(`${work.id} evidence ${hash} no longer resolves in the project repo — history may have been rewritten`);
            }
        }
    }
    return signals;
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
        for (const meta of work.artifacts)
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

// An artifact ingested before digests were recorded carries none, so absence
// of a digest is silence, not a mismatch. Every answer here is a signal, never
// an exception: this runs inside every fold, status and context, and one file
// the store will not hand over may not take those commands down with it.
function artifactFailure(storeDir: string, meta: ArtifactMeta): string | null
{
    const file = storedPath(storeDir, meta.path);
    if (file === null)
    {
        return "is recorded at a path outside this store's artifacts — the event naming it cannot be trusted";
    }
    if (!existsSync(file))
    {
        return "is missing from this store — run `self sync` to fetch it";
    }
    if (meta.digest === undefined)
    {
        return null;
    }
    try
    {
        return digestFile(file) === meta.digest
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
function storedPath(storeDir: string, path: string): string | null
{
    const root = join(storeDir, "artifacts");
    const file = resolve(storeDir, typeof path === "string" ? path : "");
    const step = relative(root, file);
    const escapes = step === "" || step === ".." || step.startsWith(".." + sep) || isAbsolute(step);
    return escapes ? null : file;
}
