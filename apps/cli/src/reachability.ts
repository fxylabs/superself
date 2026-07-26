import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./gitutil.js";
import { projectStateDir } from "./paths.js";
import { WorkState } from "./model.js";

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
    for (const work of works.filter((item) => item.status !== "done"))
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
    for (const work of works.filter((item) => item.status !== "done"))
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
