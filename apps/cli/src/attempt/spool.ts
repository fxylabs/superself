import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runnerStateDir } from "../machine.js";
import { redact, redactSecrets, RedactionScope } from "./redact.js";
import { CliError } from "../types.js";

// Every state a spool can be in. `completed` is reachable only through the
// completion gate; nothing else in the runner may write it.
export type AttemptState =
    | "preflight"
    | "preflight-failed"
    | "waiting-provider"
    | "running"
    | "retrying"
    | "failed"
    | "cancelled"
    | "exited-unreconciled"
    | "completed";

export interface AttemptStatus
{
    attempt: string;
    work: string;
    project: string;
    role: string;
    state: AttemptState;
    run: number;
    runs: number;
    fence: number;
    nodeId: string;
    bootId: string;
    pid?: number;
    provider?: string;
    failure?: string;
    detail?: string;
    created: string;
    updated: string;
}

export const ATTEMPTS_SUBDIR = "attempts";

export function attemptsRoot(): string
{
    return join(runnerStateDir(), ATTEMPTS_SUBDIR);
}

export function spoolDir(attemptId: string): string
{
    return join(attemptsRoot(), attemptId);
}

export function createSpool(attemptId: string): string
{
    const dir = spoolDir(attemptId);
    mkdirSync(join(dir, "out"), { recursive: true });
    return dir;
}

// The whole spool goes through one writer so that nothing reaches disk without
// redaction, and so a reader never sees half a record.
export class Spool
{
    constructor(public readonly dir: string, private scope: RedactionScope)
    {
    }

    setScope(scope: RedactionScope): void
    {
        this.scope = scope;
    }

    path(...parts: string[]): string
    {
        return join(this.dir, ...parts);
    }

    // Written through a temporary name in the same directory, so a reader
    // either sees the previous record or the next one — never a torn file that
    // a crash mid-write would otherwise leave behind.
    writeJson(name: string, value: unknown): void
    {
        const target = this.path(name);
        const temp = `${target}.tmp`;
        writeFileSync(temp, redactSecrets(JSON.stringify(value, null, 2), this.scope) + "\n");
        renameSync(temp, target);
    }

    readJson<T>(name: string): T | null
    {
        const file = this.path(name);
        if (!existsSync(file))
        {
            return null;
        }
        try
        {
            return JSON.parse(readFileSync(file, "utf8")) as T;
        }
        catch
        {
            return null;
        }
    }

    append(name: string, record: Record<string, unknown>): void
    {
        appendFileSync(this.path(name), redactSecrets(JSON.stringify({ ts: new Date().toISOString(), ...record }), this.scope) + "\n");
    }

    // Provider output arrives in chunks that may split a secret across two
    // writes, so each chunk is redacted and flushed as it lands: the spool must
    // stay complete even if the process dies in the next millisecond.
    appendRaw(name: string, chunk: string): void
    {
        appendFileSync(this.path(name), redact(chunk, this.scope));
    }

    readLines<T>(name: string): T[]
    {
        const file = this.path(name);
        if (!existsSync(file))
        {
            return [];
        }
        return readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .flatMap((line) =>
            {
                try
                {
                    return [JSON.parse(line) as T];
                }
                catch
                {
                    // A line torn by a crash is dropped rather than failing the
                    // read: recovery must be able to see everything before it.
                    return [];
                }
            });
    }

    status(): AttemptStatus | null
    {
        return this.readJson<AttemptStatus>("status.json");
    }

    setStatus(patch: Partial<AttemptStatus>): AttemptStatus
    {
        const current = this.status();
        if (current === null)
        {
            throw new CliError(`attempt spool ${this.dir} has no status record`);
        }
        const next = { ...current, ...patch, updated: new Date().toISOString() };
        this.writeJson("status.json", next);
        return next;
    }

    heartbeat(): void
    {
        this.writeJson("heartbeat.json", { ts: new Date().toISOString(), pid: process.pid });
    }

    heartbeatAt(): number | null
    {
        const beat = this.readJson<{ ts: string }>("heartbeat.json");
        return beat === null ? null : new Date(beat.ts).getTime();
    }
}

export function openSpool(attemptId: string, scope: RedactionScope = { literals: [] }): Spool
{
    const dir = spoolDir(attemptId);
    if (!existsSync(dir))
    {
        throw new CliError(`unknown attempt "${attemptId}" — run \`self attempt list\` to see the attempts on this machine`);
    }
    return new Spool(dir, scope);
}

export function listSpools(): Spool[]
{
    const root = attemptsRoot();
    if (!existsSync(root))
    {
        return [];
    }
    // Oldest first. Attempt ids carry no ordering, so the record decides:
    // anything reading this list wants the newest attempt at the end.
    return readdirSync(root)
        .filter((name) => existsSync(join(root, name, "status.json")))
        .map((name) => new Spool(join(root, name), { literals: [] }))
        .sort((left, right) => (left.status()?.created ?? "").localeCompare(right.status()?.created ?? ""));
}

export interface RunnerConfig
{
    retentionDays: number;
}

const DEFAULT_RETENTION_DAYS = 30;

export function readRunnerConfig(): RunnerConfig
{
    const file = join(runnerStateDir(), "config.json");
    if (!existsSync(file))
    {
        return { retentionDays: DEFAULT_RETENTION_DAYS };
    }
    try
    {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        const days = Number(raw.retentionDays);
        return { retentionDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS };
    }
    catch
    {
        return { retentionDays: DEFAULT_RETENTION_DAYS };
    }
}

export function writeRunnerConfig(config: RunnerConfig): void
{
    const dir = runnerStateDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

// Deletion is a first-class operation, not a side effect of disk pressure: a
// spool holds this machine's raw provider output, and the person running it
// decides how long that stays.
export function pruneSpools(days: number, now: Date): string[]
{
    const cutoff = now.getTime() - days * 86_400_000;
    const removed: string[] = [];
    for (const spool of listSpools())
    {
        const status = spool.status();
        if (status === null || status.state === "running" || status.state === "preflight")
        {
            continue;
        }
        if (new Date(status.updated).getTime() > cutoff)
        {
            continue;
        }
        rmSync(spool.dir, { recursive: true, force: true });
        removed.push(status.attempt);
    }
    return removed;
}

export function spoolBytes(dir: string): number
{
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true }))
    {
        const path = join(dir, entry.name);
        total += entry.isDirectory() ? spoolBytes(path) : statSync(path).size;
    }
    return total;
}
