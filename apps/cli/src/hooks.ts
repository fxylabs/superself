import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { git, gitCommonDir } from "./gitutil.js";

// Hooks live in Git's resolved hooks directory, which is shared by worktrees
// unless the repository explicitly configures another core.hooksPath.
export function installProjectHooks(projectDir: string): boolean
{
    const resolved = git(projectDir, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
    if (!resolved.ok || resolved.out === "")
    {
        return false;
    }
    const hooksDir = resolved.out;
    if (!safeToManage(projectDir, hooksDir))
    {
        return false;
    }
    mkdirSync(hooksDir, { recursive: true });
    installHook(join(hooksDir, "post-commit"), "post-commit", postCommitHook());
    installHook(join(hooksDir, "post-rewrite"), "post-rewrite", postRewriteHook());
    return true;
}

function installHook(hook: string, name: string, next: string): void
{
    const signature = `# superself:${name}:v1`;
    if (existsSync(hook))
    {
        const current = readFileSync(hook, "utf8");
        if (!current.includes(signature))
        {
            renameSync(hook, nextBackup(hook, name));
        }
        else if (current === next)
        {
            chmodSync(hook, 0o755);
            return;
        }
    }
    writeFileSync(hook, next, { mode: 0o755 });
    chmodSync(hook, 0o755);
}

function safeToManage(projectDir: string, hooksDir: string): boolean
{
    const configured = git(projectDir, "config", "--show-scope", "--show-origin", "--get", "core.hooksPath");
    if (configured.ok)
    {
        const [scope] = configured.out.split("\t");
        warn(`core.hooksPath is configured at ${scope} scope`);
        return false;
    }
    const common = gitCommonDir(projectDir);
    if (common === null || canonical(hooksDir) !== join(canonical(common), "hooks"))
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

function nextBackup(hook: string, name: string): string
{
    let index = 1;
    while (existsSync(join(dirname(hook), `${name}.superself.before.${index}`)))
    {
        index += 1;
    }
    return join(dirname(hook), `${name}.superself.before.${index}`);
}

// The hook never rejects a code commit. A harvesting failure is different
// from an absent CLI, though: keep the commit successful and name the recovery
// command instead of silently losing the state assertion.
function postCommitHook(): string
{
    return [
        "#!/bin/sh",
        "# superself:post-commit:v1",
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

// post-rewrite supplies every old/new commit pair on stdin after amend or
// rebase. Capture it once so both pre-existing hooks and self receive the same
// mapping; the previous hook remains authoritative for its own behavior.
function postRewriteHook(): string
{
    return [
        "#!/bin/sh",
        "# superself:post-rewrite:v1",
        "hook_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
        "rewrite_map=$(cat) || rewrite_map=",
        "for previous in \"$hook_dir\"/post-rewrite.superself.before.*",
        "do",
        "    if [ -x \"$previous\" ]; then",
        "        printf '%s\\n' \"$rewrite_map\" | \"$previous\" \"$@\" || :",
        "    fi",
        "done",
        "if command -v self >/dev/null 2>&1; then",
        "    if ! printf '%s\\n' \"$rewrite_map\" | self harvest --rewrite >/dev/null 2>&1; then",
        "        printf '%s\\n' 'self: rewrite succeeded, but trailer reconciliation failed; run `self harvest --all` to retry' >&2",
        "    fi",
        "fi",
        "exit 0",
        ""
    ].join("\n");
}
