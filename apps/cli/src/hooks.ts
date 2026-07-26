import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./gitutil.js";

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

function nextBackup(hook: string): string
{
    let index = 1;
    while (existsSync(join(dirname(hook), `post-commit.superself.before.${index}`)))
    {
        index += 1;
    }
    return join(dirname(hook), `post-commit.superself.before.${index}`);
}

// A post-commit hook cannot reject the commit, but an uncaught failure still
// leaves alarming output in the terminal. Every path here is deliberately a
// quiet success, including machines where superself is not installed.
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
        "    self harvest >/dev/null 2>&1 || :",
        "fi",
        "exit 0",
        ""
    ].join("\n");
}
