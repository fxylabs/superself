import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { git } from "./gitutil.js";
import { projectStateDir } from "./paths.js";
import { WorkState } from "./model.js";
import { digestFile } from "./repo.js";
import { ArtifactMeta } from "./types.js";

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
export type Verdict = "settled" | "provisional" | "abandoned" | "unknown" | "unverifiable";

export interface Evidence
{
    hash: string;
    branch?: string;
}

export function loadVerdicts(storeDir: string, slug: string): Record<string, Verdict>
{
    const file = join(projectStateDir(storeDir, slug), "evidence.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

// Recomputes verdicts where the project repo is available; anywhere else the
// stored verdicts pass through untouched, so an unlinked machine never
// demotes evidence it cannot check.
export function updateVerdicts(storeDir: string, slug: string, projectDir: string | null, evidence: Evidence[]): Record<string, Verdict>
{
    const verdicts = loadVerdicts(storeDir, slug);
    if (projectDir === null || !existsSync(projectDir) || !git(projectDir, "rev-parse", "--git-dir").ok)
    {
        return verdicts;
    }
    let changed = false;
    const mainRef = defaultRef(projectDir);
    for (const item of evidence)
    {
        if (verdicts[item.hash] === "settled")
        {
            continue;
        }
        const verdict = classify(projectDir, mainRef, item);
        if (verdicts[item.hash] !== verdict)
        {
            verdicts[item.hash] = verdict;
            changed = true;
        }
    }
    if (changed)
    {
        writeFileSync(join(projectStateDir(storeDir, slug), "evidence.json"), JSON.stringify(verdicts, null, 2) + "\n");
    }
    return verdicts;
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

function classify(projectDir: string, mainRef: string | null, item: Evidence): Verdict
{
    if (!git(projectDir, "cat-file", "-e", `${item.hash}^{commit}`).ok)
    {
        return "unverifiable";
    }
    if (mainRef !== null && git(projectDir, "merge-base", "--is-ancestor", item.hash, mainRef).ok)
    {
        return "settled";
    }
    if (git(projectDir, "for-each-ref", "--contains", item.hash).out !== ""
        || git(projectDir, "merge-base", "--is-ancestor", item.hash, "HEAD").ok)
    {
        return "provisional";
    }
    return discarded(projectDir, mainRef, item) ? "abandoned" : "unknown";
}

// The branch a report was made from still exists and no longer reaches the
// commit: it was reset or force-pushed away. Evidence reported from the default
// branch is excluded — an unreachable hash handed in from elsewhere says
// nothing about a discarded branch.
function discarded(projectDir: string, mainRef: string | null, item: Evidence): boolean
{
    return item.branch !== undefined
        && item.branch !== mainRef
        && git(projectDir, "show-ref", "--verify", "-q", `refs/heads/${item.branch}`).ok;
}

export function evidenceOf(works: WorkState[]): Evidence[]
{
    const seen = new Map<string, Evidence>();
    for (const work of works.filter((item) => item.status !== "done" && item.status !== "retired"))
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
