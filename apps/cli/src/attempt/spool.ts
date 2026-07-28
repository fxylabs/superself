import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runnerStateDir } from "../machine.js";
import { writeAtomic } from "./atomic.js";
import { bootId } from "./boundary.js";
import { redact, redactSecrets, RedactionScope, safeCut } from "./redact.js";
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

// A runner that lost this attempt to a newer owner must not write to it. The
// fence says which of them the spool belongs to, and this is the error the
// loser stops on.
export class StaleRunnerError extends CliError
{
}

// The whole spool goes through one writer so that nothing reaches disk without
// redaction, and so a reader never sees half a record.
export class Spool
{
    // The fence this process holds on the attempt, once it has claimed one. A
    // spool opened to read, to settle, or to recover holds none and is not
    // fenced out of anything.
    private fence: number | null = null;

    // Raw output that has arrived but is not yet safe to redact, per file.
    private held = new Map<string, string>();

    constructor(public readonly dir: string, private scope: RedactionScope)
    {
    }

    setScope(scope: RedactionScope): void
    {
        this.scope = scope;
    }

    // Taken by the runner that owns this attempt. From here on every state
    // change checks that no newer owner has taken it away.
    claim(fence: number): void
    {
        this.fence = fence;
    }

    path(...parts: string[]): string
    {
        return join(this.dir, ...parts);
    }

    // Written through a temporary name in the same directory, so a reader
    // either sees the previous record or the next one — never a torn file that
    // a crash mid-write would otherwise leave behind. The temporary name is
    // this process's own: recovery and a live runner write the same status
    // file, and one shared name would let one rename publish the other's
    // half-written bytes.
    writeJson(name: string, value: unknown): void
    {
        writeAtomic(this.path(name), redactSecrets(JSON.stringify(value, null, 2), this.scope) + "\n");
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

    // Provider output arrives in chunks that may split a credential across two
    // writes. Redacting each chunk on its own leaves the half that no longer
    // matches any pattern in the file verbatim, so the part of the buffer a
    // pattern could still grow into is held back, and everything before the
    // last boundary no pattern can span is redacted and written at once.
    //
    // What this costs is the unfinished last line: a runner killed before the
    // stream closed loses it. That is the trade the leak forces — a complete
    // log that carries a credential is not a log this may keep — and it is
    // bounded to one line, because a completed line is written at once.
    appendRaw(name: string, chunk: string): void
    {
        const pending = (this.held.get(name) ?? "") + chunk;
        // Held first, and narrowed only after the bytes are on disk: the caller
        // swallows a write failure, and a buffer trimmed past a write that
        // never happened loses that region for good rather than retrying it
        // with the next chunk.
        this.held.set(name, pending);
        const cut = safeCut(pending, this.scope);
        if (cut > 0)
        {
            appendFileSync(this.path(name), redact(pending.slice(0, cut), this.scope));
            this.held.set(name, pending.slice(cut));
        }
    }

    // The stream is closed, so nothing can extend a match any further: whatever
    // is still held is redacted on its own and written. Called before anything
    // reads the file, or the last line of a run would be missing from it.
    flushRaw(name: string): void
    {
        const rest = this.held.get(name) ?? "";
        if (rest !== "")
        {
            appendFileSync(this.path(name), redact(rest, this.scope));
        }
        this.held.delete(name);
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

    // What the fence is for. Recovery takes an attempt over by stamping a
    // newer fence on it, so the runner that was declared dead finds the
    // attempt is no longer its to act on and stops. Asked before anything the
    // spool cannot take back — publishing an artifact, attaching a report —
    // because a status write can only record the act after it happened.
    assertOwned(): void
    {
        const current = this.status();
        if (current !== null && this.fence !== null && current.fence > this.fence)
        {
            throw new StaleRunnerError(`attempt ${current.attempt} was taken over at fence ${current.fence} — this runner holds fence ${this.fence} and no longer owns it`);
        }
    }

    setStatus(patch: Partial<AttemptStatus>): AttemptStatus
    {
        this.assertOwned();
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

// The states in which a spool claims a runner is still driving it. Only these
// can be recovered, and only these are exempt from retention while they are
// actually live.
const DRIVEN_STATES: AttemptState[] = ["preflight", "running", "retrying"];

// A heartbeat this old, from a runner that is supposed to be writing one every
// second, means nobody is driving this attempt any more.
export const STALE_HEARTBEAT_MS = 30_000;

// Three independent reasons, because no one of them is sufficient. A pid can
// be handed out again after a restart, which is why the boot identity is
// checked first; and a live pid that stopped writing its heartbeat is a runner
// that is no longer driving this attempt.
export function deadReason(spool: Spool, status: AttemptStatus, boot: string, now: number): string | null
{
    if (!DRIVEN_STATES.includes(status.state))
    {
        return null;
    }
    if (status.bootId !== boot)
    {
        return "the machine restarted while this attempt was running";
    }
    if (status.pid === undefined || !alive(status.pid))
    {
        return "the runner process that owned this attempt is gone";
    }
    const beat = spool.heartbeatAt();
    if (beat === null || now - beat > STALE_HEARTBEAT_MS)
    {
        return `no heartbeat for ${beat === null ? "the whole run" : `${Math.round((now - beat) / 1000)}s`}`;
    }
    return null;
}

export function alive(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
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
//
// A live attempt is exempt, and liveness is decided by the same evidence
// recovery uses rather than by the state the spool last managed to write. An
// abandoned attempt that nobody ever recovered is exactly the spool most
// likely to sit there forever, and a state field alone would keep it past
// every retention window the person configured.
export function pruneSpools(days: number, now: Date): string[]
{
    const cutoff = now.getTime() - days * 86_400_000;
    const boot = bootId();
    const removed: string[] = [];
    for (const spool of listSpools())
    {
        const status = spool.status();
        if (status === null || (DRIVEN_STATES.includes(status.state) && deadReason(spool, status, boot, now.getTime()) === null))
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
