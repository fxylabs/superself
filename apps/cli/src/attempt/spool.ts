import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { runnerStateDir } from "../machine.js";
import { writeAtomic } from "./atomic.js";
import { bootId } from "./boundary.js";
import { redact, redactSecrets, RedactionScope, safeCut } from "./redact.js";
import { alive, OwnedTree, treeAlive } from "./tree.js";
import { CliError } from "../types.js";

// Every state a spool can be in. `completed` is reachable only through the
// completion gate; nothing else in the runner may write it.
export type AttemptState =
    | "registered"
    | "preflight"
    | "preflight-failed"
    | "waiting-provider"
    | "running"
    | "retrying"
    | "failed"
    | "cancelled"
    | "exited-unreconciled"
    | "completed";

// How the runner learned that the process driving this attempt is no longer
// running. A wrapper that reported the exit it watched is the only one of the
// three that says anything about what the process produced: a pid that
// disappeared and a heartbeat that went quiet both leave the output half
// written for all anyone here can tell.
export type ExitSource = "confirmed" | "vanished" | "stale";

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
    exitSource?: ExitSource;
    exitCode?: number;
    created: string;
    updated: string;
}

export const ATTEMPTS_SUBDIR = "attempts";

// The process group an external launcher handed this attempt, written beside
// the status rather than into it: the status is the attempt's state and this
// is the identity of whatever is driving it.
export const OWNER_FILE = "owner.json";

// The provisioned worktree, when the plan asked for one. It sits inside the
// spool so that one attempt id names one checkout — two attempts of the same
// work can never be handed the same directory — and so that retention reclaims
// the disk with the rest of the attempt.
export const WORKDIR_SUBDIR = "workdir";

// Where the runner records what it bound this attempt to: the repository, the
// remote, the head, and the digest of the three. `attempt/provision.ts` is the
// only writer.
export const PROVISION_FILE = "provision.json";

// The ordered record of the preparation steps that ran, one line each.
export const PREPARATION_LOG = "preparation.jsonl";

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

    // The pid the beat belongs to. A launcher heartbeating on behalf of the
    // process it started records that process, not the short-lived CLI run
    // that carried the message.
    heartbeat(pid: number = process.pid): void
    {
        this.writeJson("heartbeat.json", { ts: new Date().toISOString(), pid });
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
    // Oldest first. Attempt ids carry no ordering, so the record decides:
    // anything reading this list wants the newest attempt at the end.
    return spoolDirs()
        .filter((dir) => existsSync(join(dir, "status.json")))
        .map((dir) => new Spool(dir, { literals: [] }))
        .sort((left, right) => (left.status()?.created ?? "").localeCompare(right.status()?.created ?? ""));
}

// Every directory under the spool root, including the ones no reader can make
// an attempt out of. Only retention wants this: everything else is looking for
// an attempt, and a directory without a status is not one.
function spoolDirs(): string[]
{
    const root = attemptsRoot();
    if (!existsSync(root))
    {
        return [];
    }
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name));
}

// The states in which a spool claims a runner is still driving it. Only these
// can be recovered, and only these are exempt from retention while they are
// actually live. `registered` is not one of them: a registered attempt has no
// process by construction, so there is nothing about it to declare dead.
export const DRIVEN_STATES: AttemptState[] = ["preflight", "running", "retrying"];

// The process group an external launcher claimed this attempt with, when one
// did. The runner's own attempts have no such record: their owner is the
// runner process the status already names.
export function ownerOf(spool: Spool): OwnedTree | null
{
    return spool.readJson<OwnedTree>(OWNER_FILE);
}

// A heartbeat this old, from a runner that is supposed to be writing one every
// second, means nobody is driving this attempt any more.
export const STALE_HEARTBEAT_MS = 30_000;

// Why an attempt is no longer being driven, and how that was learned. The two
// travel together because they are not the same statement: an owner that
// disappeared and an owner that went quiet are equally not driving the
// attempt, and only one of them is even in principle recoverable evidence
// about what the run produced.
export interface DeadVerdict
{
    reason: string;
    exitSource: ExitSource;
}

// Three independent reasons, because no one of them is sufficient. A pid can
// be handed out again after a restart, which is why the boot identity is
// checked first; and a live owner that stopped writing its heartbeat is one
// that is no longer driving this attempt.
export function deadVerdict(spool: Spool, status: AttemptStatus, boot: string, now: number): DeadVerdict | null
{
    if (!DRIVEN_STATES.includes(status.state))
    {
        return null;
    }
    const dead = deadReason(spool, status, boot, now);
    // A status that already carries a confirmed exit is not a disappearance:
    // the launcher watched the exit happen and recorded it, and what died was
    // the settlement between that write and the terminal one. The verdict
    // keeps the witnessed source rather than reclassifying it — a reported
    // exit code stays evidence, and a result the gate already published stays
    // settleable, where "vanished" would destroy both.
    if (dead !== null && status.exitSource === "confirmed")
    {
        return { reason: `the exit was reported but its settlement never finished — ${dead.reason}`, exitSource: "confirmed" };
    }
    return dead;
}

function deadReason(spool: Spool, status: AttemptStatus, boot: string, now: number): DeadVerdict | null
{
    if (status.bootId !== boot)
    {
        return { reason: "the machine restarted while this attempt was running", exitSource: "vanished" };
    }
    if (!ownerLive(spool, status))
    {
        return { reason: "the process that owned this attempt is gone", exitSource: "vanished" };
    }
    const beat = spool.heartbeatAt();
    if (beat === null || now - beat > STALE_HEARTBEAT_MS)
    {
        return {
            reason: `no heartbeat for ${beat === null ? "the whole run" : `${Math.round((now - beat) / 1000)}s`}`,
            exitSource: "stale"
        };
    }
    return null;
}

// One work unit materializes one attempt at a time. Every attempt counts, not
// only the ones a spec dispatched: a work unit already being driven is busy
// whoever launched the runner. Nothing here reaches into another machine's
// spools, and it does not need to — an attempt is owned by the machine running
// it, and that is the machine a dispatch is issued from.
export function liveAttemptFor(work: string): AttemptStatus | null
{
    const boot = bootId();
    const now = Date.now();
    for (const spool of listSpools())
    {
        const status = spool.status();
        if (status !== null && status.work === work && isLive(spool, status, boot, now))
        {
            return status;
        }
    }
    return null;
}

// Liveness is decided by the same evidence recovery uses, never by the state
// the spool last managed to write: an attempt whose runner died is not holding
// the work unit against the next dispatch.
export function isLive(spool: Spool, status: AttemptStatus, boot: string, now: number): boolean
{
    return DRIVEN_STATES.includes(status.state) && deadVerdict(spool, status, boot, now) === null;
}

// An externally launched attempt is alive while anything its launch put in the
// process group is: the wrapper may be gone and the payload it forked still
// running, and settling on the wrapper's pid alone would declare a spending
// provider dead. The runner's own attempts have no group record, and their pid
// is the whole of the answer.
function ownerLive(spool: Spool, status: AttemptStatus): boolean
{
    const owner = ownerOf(spool);
    return owner === null ? status.pid !== undefined && alive(status.pid) : treeAlive(owner);
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
    for (const dir of spoolDirs())
    {
        const name = sweepable(dir, boot, now.getTime(), cutoff);
        if (name === null)
        {
            continue;
        }
        rmSync(dir, { recursive: true, force: true });
        removed.push(name);
    }
    return removed;
}

// What retention deletes, and what it deletes it as. A spool with a readable
// status is judged by that status. One without is corrupt — no attempt id, no
// state, no owner, nothing to recover it into — and is judged by the age of
// the directory itself, because there is nothing else left to judge it by.
// Skipping it, as every reader of an attempt rightly does, left the one spool
// nobody can use as the one spool retention could never reach.
function sweepable(dir: string, boot: string, now: number, cutoff: number): string | null
{
    const spool = new Spool(dir, { literals: [] });
    const status = spool.status();
    if (status === null)
    {
        return touchedAt(dir) <= cutoff ? basename(dir) : null;
    }
    if (DRIVEN_STATES.includes(status.state) && deadVerdict(spool, status, boot, now) === null)
    {
        return null;
    }
    return new Date(status.updated).getTime() <= cutoff ? status.attempt : null;
}

// When the directory itself was last written, asked in the one step the answer
// is true for. Another prune on the same machine may take it between the
// listing and this read, and asking whether it exists before reading it leaves
// that same gap open — a sweep that threw there would leave every spool behind
// it in the retention window unswept. A directory nothing can stat is not one
// this sweep may delete, so it reads as forever young.
function touchedAt(dir: string): number
{
    try
    {
        return statSync(dir).mtimeMs;
    }
    catch
    {
        return Number.POSITIVE_INFINITY;
    }
}

// What this attempt spooled, which is not what its provisioned worktree holds.
// The worktree is a checkout plus whatever preparation installed into it — a
// dependency tree runs to six figures of files — and walking it would turn
// `self attempt show` into a multi-second directory crawl over bytes the spool
// does not own.
export function spoolBytes(dir: string): number
{
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true }))
    {
        if (entry.name === WORKDIR_SUBDIR)
        {
            continue;
        }
        const path = join(dir, entry.name);
        total += entry.isDirectory() ? spoolBytes(path) : statSync(path).size;
    }
    return total;
}
