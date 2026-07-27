import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

// Digests must not depend on who runs the command. Every option that a user's
// git config can move — rename detection, prefixes, line endings, external
// diff drivers, colour — is pinned here, so the same two commits hash the same
// on every machine and in CI.
const STABLE = [
    "-c", "core.autocrlf=false",
    "-c", "core.abbrev=40",
    "-c", "diff.renames=false",
    "-c", "diff.noprefix=false",
    "-c", "diff.external=",
    "-c", "diff.mnemonicPrefix=false"
];

function run(repoDir: string, args: string[]): { ok: boolean; out: string } | null
{
    if (!existsSync(repoDir))
    {
        return null;
    }
    const result = spawnSync("git", [...STABLE, ...args], { cwd: repoDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (result.error !== undefined)
    {
        return null;
    }
    return { ok: result.status === 0, out: result.stdout ?? "" };
}

export function isRepo(repoDir: string): boolean
{
    const result = run(repoDir, ["rev-parse", "--git-dir"]);
    return result !== null && result.ok;
}

// Full object names only: a short hash means a different string for the same
// commit, and every binding in this domain is a string comparison.
export function resolveSha(repoDir: string, rev: string): string | null
{
    const result = run(repoDir, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]);
    return result !== null && result.ok ? result.out.trim() : null;
}

export function commitExists(repoDir: string, rev: string): boolean
{
    return resolveSha(repoDir, rev) !== null;
}

// The tree a commit holds, as one comparable id: two commits with the same
// tree carry byte-identical content, whatever their histories say.
export function treeOf(repoDir: string, rev: string): string | null
{
    const result = run(repoDir, ["rev-parse", "--verify", "--end-of-options", `${rev}^{tree}`]);
    return result !== null && result.ok ? result.out.trim() : null;
}

// Whether `descendant` contains `ancestor` — what lets a merge receipt prove
// the commits it names are really related, not merely well-formed.
export function isAncestor(repoDir: string, ancestor: string, descendant: string): boolean
{
    const result = run(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return result !== null && result.ok;
}

// The feature bytes: what this branch adds on top of where it forked from,
// which is exactly what survives a conflict-free rebase onto a moved base.
export function featureDiff(repoDir: string, base: string, head: string): string | null
{
    const result = run(repoDir, ["diff", "--no-color", "--no-ext-diff", "--binary", "--full-index",
        "--src-prefix=a/", "--dst-prefix=b/", `${base}...${head}`]);
    return result !== null && result.ok ? result.out : null;
}

export function featureDigest(repoDir: string, base: string, head: string): string | null
{
    const diff = featureDiff(repoDir, base, head);
    return diff === null ? null : sha256(diff);
}

export function changedPaths(repoDir: string, base: string, head: string): string[] | null
{
    const result = run(repoDir, ["diff", "--no-color", "--no-ext-diff", "--name-only", `${base}...${head}`]);
    if (result === null || !result.ok)
    {
        return null;
    }
    return result.out.split("\n").map((line) => line.trim()).filter((line) => line !== "").sort();
}

export function sha256(text: string): string
{
    return createHash("sha256").update(text).digest("hex");
}

// Bytes, not text: an artifact may be a screenshot or an archive, and a
// receipt that hashed a lossy decoding of it would bind to nothing.
export function sha256File(path: string): string | null
{
    if (!existsSync(path) || statSync(path).isDirectory())
    {
        return null;
    }
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}
