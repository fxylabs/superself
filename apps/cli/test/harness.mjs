// Shared setup for the integration tests: a throwaway machine whose HOME,
// config and git identity live under one temp root, so a test can never reach
// the real workspace. Mirrors what proof/lib.sh established for the shell
// suites the fast tier replaces.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));

export function machine()
{
    const root = mkdtempSync(join(tmpdir(), "self-test-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = test machine\n\temail = test@superself.local\n[init]\n\tdefaultBranch = main\n");
    const env = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        GIT_CONFIG_SYSTEM: "/dev/null"
    };
    return { root, env };
}

// Runs the built CLI and reports what a caller can assert on: exit code and
// the merged output, because a refusal's text is part of the contract.
export function selfIn(box, cwd, args)
{
    try
    {
        return { code: 0, out: execFileSync(process.execPath, [bin, ...args], { cwd, env: box.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    }
    catch (error)
    {
        return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
}

export function git(box, cwd, args)
{
    execFileSync("git", args, { cwd, env: box.env, stdio: "ignore" });
}

// The floor state: a workspace at <root>/ws holding one registered project at
// <root>/ws/demo. Returns the paths a test drives.
export function demoWorkspace(box)
{
    const ws = join(box.root, "ws");
    const demo = join(ws, "demo");
    mkdirSync(demo, { recursive: true });
    must(box, ws, ["init"]);
    git(box, demo, ["init", "-q", "-b", "main"]);
    must(box, demo, ["project", "add", "--name", "demo", "--desc", "fast tier project"]);
    return { ws, demo };
}

export function must(box, cwd, args)
{
    const result = selfIn(box, cwd, args);
    if (result.code !== 0)
    {
        throw new Error(`self ${args.join(" ")} failed:\n${result.out}`);
    }
    return result;
}

// Event ids arrive inside [brackets] on the confirmation line; a work id is
// printed on its own line after it.
export function idIn(text)
{
    const match = text.match(/\[([^\]]+)\]/);
    if (match === null)
    {
        throw new Error(`no id in: ${text}`);
    }
    return match[1];
}

export function workIdIn(text)
{
    const match = text.match(/\bw-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no work id in: ${text}`);
    }
    return match[0];
}
