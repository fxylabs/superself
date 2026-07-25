import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./gitutil.js";
import { projectStateDir } from "./paths.js";
import { WorkState } from "./model.js";

// settled: reachable from the default branch — counts as progress, final.
// provisional: exists on a live branch that has not merged yet.
// abandoned: the commit exists but no ref reaches it — its branch was discarded.
// unverifiable: the hash resolves to nothing — history was rewritten or the
// evidence predates this clone; never treated as discarded work.
export type Verdict = "settled" | "provisional" | "abandoned" | "unverifiable";

export function loadVerdicts(storeDir: string, slug: string): Record<string, Verdict>
{
    const file = join(projectStateDir(storeDir, slug), "evidence.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

// Recomputes verdicts where the project repo is available; anywhere else the
// stored verdicts pass through untouched, so an unlinked machine never
// demotes evidence it cannot check.
export function updateVerdicts(storeDir: string, slug: string, projectDir: string | null, hashes: string[]): Record<string, Verdict>
{
    const verdicts = loadVerdicts(storeDir, slug);
    if (projectDir === null || !existsSync(projectDir) || !git(projectDir, "rev-parse", "--git-dir").ok)
    {
        return verdicts;
    }
    let changed = false;
    const mainRef = defaultRef(projectDir);
    for (const hash of hashes)
    {
        if (verdicts[hash] === "settled")
        {
            continue;
        }
        const verdict = classify(projectDir, mainRef, hash);
        if (verdicts[hash] !== verdict)
        {
            verdicts[hash] = verdict;
            changed = true;
        }
    }
    if (changed)
    {
        writeFileSync(join(projectStateDir(storeDir, slug), "evidence.json"), JSON.stringify(verdicts, null, 2) + "\n");
    }
    return verdicts;
}

function defaultRef(projectDir: string): string
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
    return "HEAD";
}

function classify(projectDir: string, mainRef: string, hash: string): Verdict
{
    if (!git(projectDir, "cat-file", "-e", `${hash}^{commit}`).ok)
    {
        return "unverifiable";
    }
    if (git(projectDir, "merge-base", "--is-ancestor", hash, mainRef).ok)
    {
        return "settled";
    }
    if (git(projectDir, "for-each-ref", "--contains", hash).out !== ""
        || git(projectDir, "merge-base", "--is-ancestor", hash, "HEAD").ok)
    {
        return "provisional";
    }
    return "abandoned";
}

export function evidenceHashes(works: WorkState[]): string[]
{
    return works.filter((work) => work.status !== "done").flatMap((work) => work.evidence);
}

export function verdictSignals(works: WorkState[], verdicts: Record<string, Verdict>): string[]
{
    const signals: string[] = [];
    for (const work of works.filter((item) => item.status !== "done"))
    {
        for (const hash of work.evidence)
        {
            if (verdicts[hash] === "abandoned")
            {
                signals.push(`${work.id} evidence ${hash} was discarded with its branch — that direction reads as attempted and abandoned`);
            }
            if (verdicts[hash] === "unverifiable")
            {
                signals.push(`${work.id} evidence ${hash} no longer resolves in the project repo — history may have been rewritten`);
            }
        }
    }
    return signals;
}
