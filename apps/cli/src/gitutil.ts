import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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

export function excludeLocally(dir: string, pattern: string): void
{
    const common = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!common.ok)
    {
        return;
    }
    const excludeFile = join(common.out, "info", "exclude");
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").includes(pattern))
    {
        return;
    }
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    appendFileSync(excludeFile, prefix + pattern + "\n");
}
