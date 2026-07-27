import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Boundary } from "./boundary.js";
import { CliError } from "../types.js";

export interface ArtifactPlan
{
    // The name the agent stages under the attempt's out/ directory.
    name: string;
    // Where the runner publishes it once it has been verified.
    dest: string;
    // Declared validation, run against the published file. A non-zero exit
    // fails the completion gate.
    validate?: string[];
    minBytes?: number;
}

export interface ProviderPlan
{
    name: string;
    endpoint: string;
}

export interface BrowserPlan
{
    tab: string;
    probe: string[];
}

export interface CapabilityPlan
{
    context: boolean;
    read: string[];
    write: string[];
    provider?: ProviderPlan;
    domains: string[];
    browser?: BrowserPlan;
    self: boolean;
    tools: string[];
    budgetUsd?: number;
    secrets: string[];
}

export interface RetryPlan
{
    maxRuns: number;
    baseMs: number;
    maxMs: number;
}

export interface AttemptPlan
{
    work: string;
    role: string;
    summary: string;
    boundary: Boundary;
    command: string[];
    capabilities: CapabilityPlan;
    artifacts: ArtifactPlan[];
    retry: RetryPlan;
    preflightTimeoutMs: number;
    runTimeoutMs: number;
    heartbeatMs: number;
    resume: boolean;
}

export function readPlan(file: string): AttemptPlan
{
    if (!existsSync(file))
    {
        throw new CliError(`attempt plan "${file}" does not exist`);
    }
    let raw: any;
    try
    {
        raw = JSON.parse(readFileSync(file, "utf8"));
    }
    catch (error)
    {
        throw new CliError(`attempt plan "${file}" is not valid JSON: ${(error as Error).message}`);
    }
    return normalizePlan(raw, dirname(resolve(file)));
}

export function normalizePlan(raw: any, base: string): AttemptPlan
{
    const command = stringList(raw.command, "command");
    if (command.length === 0)
    {
        throw new CliError("attempt plan needs a `command` array — the provider invocation this attempt runs");
    }
    const capabilities = normalizeCapabilities(raw.capabilities ?? {}, base);
    const artifacts = normalizeArtifacts(raw.artifacts, base);
    // Every declared destination is a write capability whether or not the plan
    // named it: an artifact the runner cannot publish is a capability failure,
    // and it must be found before the provider is invoked, not after.
    for (const artifact of artifacts)
    {
        const dir = dirname(artifact.dest);
        if (!capabilities.write.includes(dir))
        {
            capabilities.write.push(dir);
        }
    }
    return {
        work: requireString(raw.work, "work"),
        role: typeof raw.role === "string" ? raw.role : "implementation",
        summary: typeof raw.summary === "string" ? raw.summary : "",
        boundary: normalizeBoundary(raw.boundary ?? {}, base),
        command,
        capabilities,
        artifacts,
        retry: normalizeRetry(raw.retry ?? {}),
        preflightTimeoutMs: positive(raw.preflightTimeoutMs, 10_000, "preflightTimeoutMs"),
        runTimeoutMs: positive(raw.runTimeoutMs, 900_000, "runTimeoutMs"),
        heartbeatMs: positive(raw.heartbeatMs, 1_000, "heartbeatMs"),
        resume: raw.resume === true
    };
}

function normalizeBoundary(raw: any, base: string): Boundary
{
    return {
        wrapper: stringList(raw.wrapper, "boundary.wrapper"),
        cwd: raw.cwd === undefined ? base : absolute(String(raw.cwd), base),
        passthrough: raw.passthrough === undefined ? ["PATH", "HOME", "LANG", "TMPDIR"] : stringList(raw.passthrough, "boundary.passthrough"),
        env: stringMap(raw.env, "boundary.env")
    };
}

function normalizeCapabilities(raw: any, base: string): CapabilityPlan
{
    const capabilities: CapabilityPlan = {
        context: raw.context !== false,
        read: stringList(raw.read, "capabilities.read").map((path) => absolute(path, base)),
        write: stringList(raw.write, "capabilities.write").map((path) => absolute(path, base)),
        domains: stringList(raw.domains, "capabilities.domains"),
        self: raw.self === true,
        tools: stringList(raw.tools, "capabilities.tools"),
        secrets: stringList(raw.secrets, "capabilities.secrets")
    };
    if (raw.provider !== undefined)
    {
        capabilities.provider = {
            name: requireString(raw.provider.name, "capabilities.provider.name"),
            endpoint: requireString(raw.provider.endpoint, "capabilities.provider.endpoint")
        };
    }
    if (raw.browser !== undefined)
    {
        capabilities.browser = {
            tab: requireString(raw.browser.tab, "capabilities.browser.tab"),
            probe: stringList(raw.browser.probe, "capabilities.browser.probe")
        };
    }
    if (raw.budgetUsd !== undefined)
    {
        capabilities.budgetUsd = Number(raw.budgetUsd);
    }
    return capabilities;
}

function normalizeArtifacts(raw: any, base: string): ArtifactPlan[]
{
    if (raw === undefined)
    {
        return [];
    }
    if (!Array.isArray(raw))
    {
        throw new CliError("attempt plan `artifacts` must be an array");
    }
    return raw.map((entry: any): ArtifactPlan =>
    {
        const artifact: ArtifactPlan = {
            name: requireString(entry.name, "artifacts[].name"),
            dest: absolute(requireString(entry.dest, "artifacts[].dest"), base)
        };
        if (entry.validate !== undefined)
        {
            artifact.validate = stringList(entry.validate, "artifacts[].validate");
        }
        if (entry.minBytes !== undefined)
        {
            artifact.minBytes = Number(entry.minBytes);
        }
        if (artifact.name.includes("/") || artifact.name.includes("\\") || artifact.name === ".." )
        {
            throw new CliError(`artifact name "${artifact.name}" must be a single file name staged in the attempt's out/ directory`);
        }
        return artifact;
    });
}

function normalizeRetry(raw: any): RetryPlan
{
    const retry = {
        maxRuns: positive(raw.maxRuns, 3, "retry.maxRuns"),
        baseMs: positive(raw.baseMs, 500, "retry.baseMs"),
        maxMs: positive(raw.maxMs, 30_000, "retry.maxMs")
    };
    if (retry.maxRuns > 20)
    {
        throw new CliError("retry.maxRuns above 20 is not a bounded retry policy");
    }
    return retry;
}

// The identity of what this attempt was allowed to do. Recorded in the
// preflight receipt so a later reader can tell that the policy the probe
// cleared is the policy the provider ran under.
export function policyDigest(plan: AttemptPlan): string
{
    const canonical = {
        role: plan.role,
        command: plan.command,
        capabilities: plan.capabilities,
        artifacts: plan.artifacts,
        retry: plan.retry
    };
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function absolute(path: string, base: string): string
{
    return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function requireString(value: unknown, field: string): string
{
    if (typeof value !== "string" || value.trim() === "")
    {
        throw new CliError(`attempt plan field "${field}" must be a non-empty string`);
    }
    return value;
}

function stringList(value: unknown, field: string): string[]
{
    if (value === undefined)
    {
        return [];
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    {
        throw new CliError(`attempt plan field "${field}" must be an array of strings`);
    }
    return value as string[];
}

function stringMap(value: unknown, field: string): Record<string, string>
{
    if (value === undefined)
    {
        return {};
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
    {
        throw new CliError(`attempt plan field "${field}" must be an object of string values`);
    }
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
    {
        out[key] = String(item);
    }
    return out;
}

function positive(value: unknown, fallback: number, field: string): number
{
    if (value === undefined)
    {
        return fallback;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0)
    {
        throw new CliError(`attempt plan field "${field}" must be a positive number`);
    }
    return number;
}
