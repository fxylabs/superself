import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { git, gitCommonDir } from "./gitutil.js";

const SIGNATURE = "# superself:post-commit:v1";

// Hooks live in Git's resolved hooks directory, which is shared by worktrees
// unless the repository explicitly configures another core.hooksPath.
export function installPostCommitHook(projectDir: string): boolean
{
    const resolved = git(projectDir, "rev-parse", "--path-format=absolute", "--git-path", "hooks/post-commit");
    if (!resolved.ok || resolved.out === "")
    {
        return false;
    }
    const hook = resolved.out;
    if (!safeToManage(projectDir, hook))
    {
        return false;
    }
    mkdirSync(dirname(hook), { recursive: true });
    const next = postCommitHook();
    if (existsSync(hook))
    {
        const current = readFileSync(hook, "utf8");
        if (!current.includes(SIGNATURE))
        {
            renameSync(hook, nextBackup(hook));
        }
        else if (current === next)
        {
            chmodSync(hook, 0o755);
            return true;
        }
    }
    writeFileSync(hook, next, { mode: 0o755 });
    chmodSync(hook, 0o755);
    return true;
}

function safeToManage(projectDir: string, hook: string): boolean
{
    const configured = git(projectDir, "config", "--show-scope", "--show-origin", "--get", "core.hooksPath");
    if (configured.ok)
    {
        const [scope] = configured.out.split("\t");
        warn(`core.hooksPath is configured at ${scope} scope`);
        return false;
    }
    const common = gitCommonDir(projectDir);
    if (common === null || canonical(dirname(hook)) !== join(canonical(common), "hooks"))
    {
        warn("the resolved hook is not in Git's default common hooks directory");
        return false;
    }
    return true;
}

function canonical(path: string): string
{
    let ancestor = resolve(path);
    while (!existsSync(ancestor))
    {
        const parent = dirname(ancestor);
        if (parent === ancestor)
        {
            return resolve(path);
        }
        ancestor = parent;
    }
    return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)));
}

function warn(reason: string): void
{
    console.warn(`self: post-commit hook not installed because ${reason}; run \`self harvest\` after stateful commits`);
}

function nextBackup(hook: string): string
{
    let index = 1;
    while (existsSync(join(dirname(hook), `post-commit.superself.before.${index}`)))
    {
        index += 1;
    }
    return join(dirname(hook), `post-commit.superself.before.${index}`);
}

// The hook never rejects a code commit. A harvesting failure is different
// from an absent CLI, though: keep the commit successful and name the recovery
// command instead of silently losing the state assertion.
function postCommitHook(): string
{
    return [
        "#!/bin/sh",
        SIGNATURE,
        "hook_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
        "for previous in \"$hook_dir\"/post-commit.superself.before.*",
        "do",
        "    if [ -x \"$previous\" ]; then",
        "        \"$previous\" \"$@\" || :",
        "    fi",
        "done",
        "if command -v self >/dev/null 2>&1; then",
        "    if ! self harvest >/dev/null 2>&1; then",
        "        printf '%s\\n' 'self: commit succeeded, but trailer harvest failed; run `self harvest` to retry' >&2",
        "    fi",
        "fi",
        "exit 0",
        ""
    ].join("\n");
}
