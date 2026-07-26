import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export interface Checkout
{
    common: string;
    top: string;
}

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

// Every linked worktree of one repository shares a common directory while
// keeping its own top level. That pair identifies a checkout, and two
// checkouts of one repository are the case `self project add` must not treat
// as a new project.
export function checkoutOf(dir: string): Checkout | null
{
    const common = gitCommonDir(dir);
    const top = git(dir, "rev-parse", "--show-toplevel");
    return common !== null && top.ok ? { common, top: realPath(top.out) } : null;
}

function realPath(path: string): string
{
    return existsSync(path) ? realpathSync(path) : path;
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
