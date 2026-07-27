import { createHash } from "node:crypto";
import { spawn, SpawnOptions } from "node:child_process";
import { hostname, uptime } from "node:os";

// The execution boundary an attempt runs inside: the wrapper that starts every
// process (a sandbox, a container shim, or nothing), the directory it starts
// in, and the environment it can see.
//
// A capability probe that runs outside this boundary proves nothing. The
// recurring failure this exists to stop is a host DNS lookup that resolves
// while the identical lookup inside the sandbox returns ENOTFOUND: the probe
// passed, the provider was invoked, and the attempt burned on a denial the
// preflight could have seen.
export interface Boundary
{
    // Argv prepended to every command started in this boundary. Empty means
    // the boundary is the plain host process boundary.
    wrapper: string[];
    cwd: string;
    // Variable names copied from the current environment into the boundary.
    passthrough: string[];
    // Literal variables the boundary adds on top of the passthrough.
    env: Record<string, string>;
}

export interface BoundaryIdentity
{
    digest: string;
    nodeId: string;
    bootId: string;
}

// The digest covers values, not only names: a PATH that changed between the
// probe and the launch is exactly the drift this catches. It is one-way, so
// including values never puts them anywhere readable.
export function boundaryDigest(boundary: Boundary): string
{
    const env = boundaryEnv(boundary);
    const canonical = {
        wrapper: boundary.wrapper,
        cwd: boundary.cwd,
        env: Object.keys(env).sort().map((name) => [name, env[name]])
    };
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function boundaryEnv(boundary: Boundary): Record<string, string>
{
    const env: Record<string, string> = {};
    for (const name of boundary.passthrough)
    {
        const value = process.env[name];
        if (value !== undefined)
        {
            env[name] = value;
        }
    }
    return { ...env, ...boundary.env };
}

export function identityOf(boundary: Boundary): BoundaryIdentity
{
    return { digest: boundaryDigest(boundary), nodeId: nodeId(), bootId: bootId() };
}

export function nodeId(): string
{
    return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}

// Cross-platform by construction: derived from the boot instant rather than
// read from a platform-specific file, and rounded so that clock drift between
// two calls on the same boot cannot change it. Its only job is to tell "this
// pid belongs to the run I recorded" from "this pid was handed out again after
// a restart".
export function bootId(): string
{
    const bootSeconds = Math.round((Date.now() / 1000 - uptime()) / 60);
    return createHash("sha256").update(`${hostname()}:${bootSeconds}`).digest("hex").slice(0, 16);
}

export interface BoundarySpawn
{
    argv: string[];
    options: SpawnOptions;
}

// Everything an attempt starts — the probe and the provider alike — goes
// through this one function, so the two cannot drift apart by construction.
export function boundaryCommand(boundary: Boundary, argv: string[], extraEnv: Record<string, string> = {}): BoundarySpawn
{
    const full = [...boundary.wrapper, ...argv];
    return {
        argv: full,
        options: { cwd: boundary.cwd, env: { ...boundaryEnv(boundary), ...extraEnv } }
    };
}

export interface RunOutcome
{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    spawnError?: NodeJS.ErrnoException;
}

// A bounded run used by every probe: a boundary that hangs must cost the
// timeout, never the attempt.
export function runBounded(boundary: Boundary, argv: string[], timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<RunOutcome>
{
    const command = boundaryCommand(boundary, argv, extraEnv);
    return new Promise((resolve) =>
    {
        const child = spawn(command.argv[0], command.argv.slice(1), { ...command.options, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() =>
        {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", (error) =>
        {
            clearTimeout(timer);
            resolve({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error as NodeJS.ErrnoException });
        });
        child.on("close", (code, signal) =>
        {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr, timedOut });
        });
    });
}
