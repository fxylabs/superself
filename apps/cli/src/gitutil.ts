import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function git(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string }
{
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return {
        ok: result.status === 0,
        out: (result.stdout ?? "").trim(),
        err: (result.stderr ?? "").trim()
    };
}

export function configureStoreIdentity(storeDir: string): void
{
    git(storeDir, "config", "user.name", "superself");
    git(storeDir, "config", "user.email", "self@superself.local");
}

export function ensureWorkspaceRepo(storeDir: string): void
{
    if (existsSync(join(storeDir, ".git")))
    {
        return;
    }
    git(storeDir, "init", "-q");
    configureStoreIdentity(storeDir);
}

export function commitAll(storeDir: string, message: string): void
{
    git(storeDir, "add", "-A");
    if (git(storeDir, "status", "--porcelain").out === "")
    {
        return;
    }
    git(storeDir, "commit", "-qm", message);
}

// 12 hex chars: short hashes recorded as evidence must stay unambiguous as
// the project repo grows.
export function headCommit(dir: string): string | null
{
    const result = git(dir, "rev-parse", "--short=12", "HEAD");
    return result.ok ? result.out : null;
}

export function gitCommonDir(dir: string): string | null
{
    const result = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    return result.ok ? realPath(result.out) : null;
}

// Scope resolution asks about the same directories repeatedly, and a one-shot
// CLI process never sees a worktree appear underneath it. Probe each once.
const tops = new Map<string, string | null>();

// The working tree a directory sits in — its identity as a checkout, since
// every linked worktree of one repository keeps its own top level.
export function topOf(dir: string): string | null
{
    if (!tops.has(dir))
    {
        const result = git(dir, "rev-parse", "--show-toplevel");
        tops.set(dir, result.ok ? realPath(result.out) : null);
    }
    return tops.get(dir) ?? null;
}

const real = new Map<string, string>();

// Paths reach the store through `resolve`, which keeps symlinks, while git
// answers with the resolved path: comparing the two needs both in the same
// form. Memoized with the probes below — resolution normalizes the same
// handful of paths once per registered project.
export function realPath(path: string): string
{
    if (!real.has(path))
    {
        real.set(path, existsSync(path) ? realpathSync(path) : path);
    }
    return real.get(path) ?? path;
}

const worktrees = new Map<string, string[]>();

// The top level of every working tree of this repository, in a single probe.
// Two checkouts of one repository are the case `self project add` must not
// treat as a new project, and the case scope resolution answers from: this
// list says which of the paths the store knows are checkouts of the
// repository the command is standing in.
export function checkoutTops(dir: string): string[]
{
    if (!worktrees.has(dir))
    {
        const listed = git(dir, "worktree", "list", "--porcelain");
        worktrees.set(dir, !listed.ok ? [] : listed.out
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => realPath(line.slice("worktree ".length))));
    }
    return worktrees.get(dir) ?? [];
}

// A detached HEAD reports the literal "HEAD"; record nothing rather than a
// name that points at no branch.
export function currentBranch(dir: string): string | null
{
    const result = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    return result.ok && result.out !== "" && result.out !== "HEAD" ? result.out : null;
}

export function excludeLocally(dir: string, pattern: string): void
{
    const common = gitCommonDir(dir);
    if (common === null)
    {
        return;
    }
    const excludeFile = join(common, "info", "exclude");
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").includes(pattern))
    {
        return;
    }
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    appendFileSync(excludeFile, prefix + pattern + "\n");
}
