// The capability probe. This file is a program, not a library: the runner
// starts it through the very launcher that will start the provider, so that
// what it proves is true of the boundary the provider will run in. A probe
// executed in the parent's own boundary would have cleared every host DNS
// lookup that the sandbox then denied — the failure this whole path exists to
// stop.
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { delimiter, join } from "node:path";

interface ProbeManifest
{
    envNames: string[];
    read: string[];
    write: string[];
    provider?: { name: string; endpoint: string };
    domains: string[];
    tools: string[];
    secrets: string[];
    // Whether the agent must be able to report back through the self CLI from
    // inside this boundary. A successful attempt that cannot attach its own
    // result is an attempt that has to be redone by hand.
    self: boolean;
    timeoutMs: number;
}

export interface ProbeCheck
{
    capability: string;
    target: string;
    ok: boolean;
    detail: string;
}

export interface ProbeReport
{
    innerDigest: string;
    cwd: string;
    checks: ProbeCheck[];
}

async function main(): Promise<void>
{
    const manifest: ProbeManifest = JSON.parse(process.argv[2]);
    const checks: ProbeCheck[] = [];
    for (const path of manifest.read)
    {
        checks.push(readCheck(path));
    }
    for (const path of manifest.write)
    {
        checks.push(writeCheck(path));
    }
    for (const name of manifest.tools)
    {
        checks.push(toolCheck("tool", name));
    }
    if (manifest.self)
    {
        checks.push(toolCheck("self", "self"));
    }
    for (const name of manifest.secrets)
    {
        const value = process.env[name];
        // Presence only. The value is never read out, logged, or digested.
        checks.push({ capability: "secret", target: name, ok: value !== undefined && value.trim() !== "", detail: value === undefined || value.trim() === "" ? "not set in this boundary" : "set" });
    }
    if (manifest.provider !== undefined)
    {
        checks.push(await hostCheck("provider", hostOf(manifest.provider.endpoint), manifest.timeoutMs));
    }
    for (const domain of manifest.domains)
    {
        checks.push(await hostCheck("network", hostOf(domain), manifest.timeoutMs));
    }
    const report: ProbeReport = { innerDigest: innerDigest(manifest.envNames), cwd: process.cwd(), checks };
    process.stdout.write(JSON.stringify(report));
}

// The boundary as this process actually sees it. The runner compares it with
// the boundary it believes it configured; a wrapper that silently rewrites the
// working directory or drops a variable shows up as a mismatch instead of as a
// mid-attempt failure.
function innerDigest(envNames: string[]): string
{
    const env: [string, string][] = [];
    for (const name of [...envNames].sort())
    {
        const value = process.env[name];
        if (value !== undefined)
        {
            env.push([name, value]);
        }
    }
    return createHash("sha256").update(JSON.stringify({ cwd: process.cwd(), env })).digest("hex");
}

function readCheck(path: string): ProbeCheck
{
    try
    {
        accessSync(path, constants.R_OK);
        return { capability: "read", target: path, ok: true, detail: "readable" };
    }
    catch (error)
    {
        return { capability: "read", target: path, ok: false, detail: codeOf(error) };
    }
}

// The exact directory, written to for real. `access(W_OK)` answers a different
// question than "can this attempt publish here": read-only mounts, full disks,
// and sandbox write denials all pass the permission bits and fail the write.
function writeCheck(path: string): ProbeCheck
{
    let probe: string | null = null;
    try
    {
        if (!statSync(path).isDirectory())
        {
            return { capability: "write", target: path, ok: false, detail: "not a directory" };
        }
        probe = mkdtempSync(join(path, ".self-preflight-"));
        writeFileSync(join(probe, "probe"), "probe");
        return { capability: "write", target: path, ok: true, detail: "writable" };
    }
    catch (error)
    {
        return { capability: "write", target: path, ok: false, detail: codeOf(error) };
    }
    finally
    {
        if (probe !== null)
        {
            rmSync(probe, { recursive: true, force: true });
        }
    }
}

function toolCheck(capability: string, name: string): ProbeCheck
{
    const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "");
    for (const dir of dirs)
    {
        try
        {
            accessSync(join(dir, name), constants.X_OK);
            return { capability, target: name, ok: true, detail: join(dir, name) };
        }
        catch
        {
            continue;
        }
    }
    return { capability, target: name, ok: false, detail: "not on PATH in this boundary" };
}

// Provider reachability and task-domain reachability are the same operation
// and two different answers: one means the attempt cannot start at all, the
// other means the task cannot be done. They stay separate capabilities so the
// runner can retry one and refuse the other.
async function hostCheck(capability: string, host: string, timeoutMs: number): Promise<ProbeCheck>
{
    let timer: NodeJS.Timeout | undefined;
    try
    {
        const timeout = new Promise<never>((_, reject) =>
        {
            timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), timeoutMs);
        });
        await Promise.race([lookup(host), timeout]);
        return { capability, target: host, ok: true, detail: "resolved" };
    }
    catch (error)
    {
        return { capability, target: host, ok: false, detail: codeOf(error) };
    }
    finally
    {
        clearTimeout(timer);
    }
}

function hostOf(value: string): string
{
    try
    {
        return new URL(value).hostname;
    }
    catch
    {
        return value.replace(/^[a-z]+:\/\//i, "").split("/")[0];
    }
}

function codeOf(error: unknown): string
{
    const code = (error as NodeJS.ErrnoException).code;
    return code ?? (error instanceof Error ? error.message : String(error));
}

await main();
