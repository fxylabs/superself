// The one place the plugin touches the `self` binary. Every tool and the
// slash command hand an argv array to `runSelf`; nothing here builds a shell
// string, reimplements a self verb, or prints the process environment.

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export interface RunOptions
{
    binary: string;
    cwd: string;
    maxOutputChars: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
}

export interface RunOutcome
{
    ok: boolean;
    text: string;
}

// A work id as the self CLI mints it. Validated before it reaches argv so a
// model-supplied id can never carry anything but the id itself.
export const WORK_ID = /^w-[a-z0-9]+$/;

export const INSTALL_HINT = "Install it with `npm i -g superself`, or set `selfBinary` in the plugin config to its full path.";

// A global npm install on a Mac or Linux box lands in one of these when the
// harness process was started with a narrower PATH than the user's shell.
const FALLBACK_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

function executable(path: string): boolean
{
    try
    {
        accessSync(path, constants.X_OK);
        return true;
    }
    catch
    {
        return false;
    }
}

function searchDirs(env: NodeJS.ProcessEnv): string[]
{
    const onPath = (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "");
    const home = env.HOME === undefined ? [] : [join(env.HOME, ".npm-global", "bin"), join(env.HOME, ".local", "bin")];
    return [...onPath, ...FALLBACK_BIN_DIRS, ...home];
}

// A binary named with a path is used as given; a bare name is looked up on
// PATH and then in the usual global-install directories.
export function resolveBinary(binary: string, env: NodeJS.ProcessEnv = process.env): string | undefined
{
    if (binary.includes("/") || isAbsolute(binary))
    {
        const path = resolve(binary);
        return executable(path) ? path : undefined;
    }
    return searchDirs(env).map((dir) => join(dir, binary)).find(executable);
}

// The project root is the nearest directory at or above `start` holding the
// `.self` marker `self project init` writes.
export function findProjectRoot(start: string): string | undefined
{
    let dir = resolve(start);
    for (;;)
    {
        if (existsSync(join(dir, ".self")))
        {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir)
        {
            return undefined;
        }
        dir = parent;
    }
}

// Keep the head: `self context` puts the goal and the open work first, and the
// marker names the command that prints the rest.
export function truncate(text: string, maxChars: number, command: string, root: string): string
{
    if (text.length <= maxChars)
    {
        return text;
    }
    const dropped = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n… [truncated ${dropped} more characters — run \`${command}\` in ${root} for the full output]`;
}

function notFound(binary: string): RunOutcome
{
    return { ok: false, text: `The \`self\` CLI was not found (looked for \`${binary}\` on PATH). ${INSTALL_HINT}` };
}

function noProject(cwd: string): RunOutcome
{
    return {
        ok: false,
        text: `No Superself project at or above ${cwd}: no \`.self\` file was found. `
            + "Run `self project init` in the project directory, or set `cwd` in the plugin config.",
    };
}

interface Exit
{
    code: number | null;
    stdout: string;
    stderr: string;
}

function collect(binary: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Exit>
{
    return new Promise((done, fail) =>
    {
        const child = spawn(binary, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], signal });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.on("error", fail);
        child.on("close", (code) => done({ code, stdout, stderr }));
    });
}

function failed(exit: Exit, command: string, root: string, maxChars: number): RunOutcome
{
    const text = exit.stderr.trim() || exit.stdout.trim() || `\`${command}\` exited with code ${exit.code}`;
    return { ok: false, text: truncate(text, maxChars, command, root) };
}

function notStarted(error: Error, command: string): RunOutcome
{
    const reason = error.name === "AbortError" ? "was cancelled" : `could not start: ${error.message}`;
    return { ok: false, text: `\`${command}\` ${reason}` };
}

function succeeded(exit: Exit, command: string, root: string, cwd: string, maxChars: number): RunOutcome
{
    const body = truncate(exit.stdout.trimEnd(), maxChars, command, root);
    const footer = resolve(root) === resolve(cwd) ? "" : `\n\n(ran in project root ${root})`;
    return { ok: true, text: body + footer };
}

// One independent child process per call: two tools running at once share
// nothing but the binary.
export async function runSelf(argv: string[], options: RunOptions): Promise<RunOutcome>
{
    const env = options.env ?? process.env;
    const binary = resolveBinary(options.binary, env);
    if (binary === undefined)
    {
        return notFound(options.binary);
    }
    const root = findProjectRoot(options.cwd);
    if (root === undefined)
    {
        return noProject(options.cwd);
    }
    const command = `self ${argv.join(" ")}`;
    try
    {
        const exit = await collect(binary, argv, root, env, options.signal);
        return exit.code === 0
            ? succeeded(exit, command, root, options.cwd, options.maxOutputChars)
            : failed(exit, command, root, options.maxOutputChars);
    }
    catch (error)
    {
        return notStarted(error as Error, command);
    }
}
