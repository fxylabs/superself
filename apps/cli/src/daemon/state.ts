import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withLock, writeAtomic } from "../attempt/atomic.js";
import { bootId, nodeId } from "../attempt/boundary.js";
import { sameProcess } from "../attempt/tree.js";
import { runnerStateDir } from "../machine.js";
import { CliError } from "../types.js";

// Everything the supervisor keeps is machine-local, and it sits beside the
// spools it supervises rather than in the synced store: a pid, a tick clock,
// and the wakes this machine issued are observations of this machine and
// resolve to nothing in another clone of the workspace.
export function daemonDir(): string
{
    return join(runnerStateDir(), "daemon");
}

const DAEMON_FILE = "daemon.json";
const TICK_FILE = "tick.json";

export interface DaemonRecord
{
    pid: number;
    // When the process table said that pid started. A pid is handed out again
    // the moment its process is reaped, and a record that names only the number
    // lets an unrelated process inherit the supervisor's identity: `start`
    // refuses on its behalf and `stop` sends SIGTERM to a process this never
    // owned. Null where the table could not answer, and then liveness alone is
    // the whole of the check.
    startedAt: string | null;
    project: string;
    projectDir: string;
    nodeId: string;
    bootId: string;
    started: string;
    intervalMs: number;
}

// What the last tick did, and how many have run since this record was first
// written. `status` reads this rather than the log: a tick that changed
// nothing is exactly the tick a person watching a daemon wants to see.
export interface TickCounts
{
    live: number;
    settled: number;
    unreconciled: number;
    held: number;
    released: number;
    woken: number;
    deferred: number;
}

export interface TickRecord extends TickCounts
{
    at: string;
    ticks: number;
    failed?: string;
}

export function emptyCounts(): TickCounts
{
    return { live: 0, settled: 0, unreconciled: 0, held: 0, released: 0, woken: 0, deferred: 0 };
}

export function daemonFile(): string
{
    return join(daemonDir(), DAEMON_FILE);
}

export function readDaemon(): DaemonRecord | null
{
    return readRecord<DaemonRecord>(daemonFile());
}

// A record whose process is still there, on this machine and this boot, and is
// the process the record was written for. A pid is handed out again after a
// restart, so the boot identity is checked before the pid is: without it the
// first daemon started after a reboot refuses on behalf of a process that died
// with the previous one. Within one boot the same number comes back around too
// — a supervisor killed with SIGKILL leaves its record behind — so the launch
// instant is checked with it, and an unrelated process wearing the number is
// never mistaken for the supervisor.
export function liveDaemon(): DaemonRecord | null
{
    const record = readDaemon();
    if (record === null || record.nodeId !== nodeId() || record.bootId !== bootId() || !sameProcess(record.pid, record.startedAt ?? null))
    {
        return null;
    }
    return record;
}

// One supervisor per machine. Reading the record, starting the process, and
// writing the replacement are separate steps, so a second `daemon start`
// arriving between any two of them would pass the check too — everything that
// decides which process is the supervisor happens under this one lock.
export function withDaemonLock<T>(run: () => T): T
{
    return withLock(daemonFile(), run);
}

export function claimDaemon(record: DaemonRecord): void
{
    withDaemonLock(() => claimUnderLock(record));
}

// The claim itself, for a caller that is already holding the lock — the lock
// is not reentrant, and taking it twice would sit out its whole timeout and
// then break a lock this process is holding.
export function claimUnderLock(record: DaemonRecord): void
{
    const held = liveDaemon();
    if (held !== null && held.pid !== record.pid)
    {
        throw new CliError(refusal(held));
    }
    writeRecord(daemonFile(), record);
}

// The refusal names the project the live supervisor holds, because one machine
// runs one supervisor and that supervisor reconciles one project. A start from
// another project's checkout is refused by the same lock, and an operator who
// reads only "already running" is left to conclude that a daemon per project is
// available — it is not, and while this one runs, attempts of every other
// project on the machine are unsupervised.
export function refusal(held: DaemonRecord): string
{
    const other = held.project === undefined ? "" : ` supervising ${held.project}`;
    return `a self daemon is already running on this machine as process ${held.pid}${other} (since ${held.started}) — one supervisor runs per machine, so stop it with \`self daemon stop\` before starting another`;
}

// Removed only by the process the record names, or on behalf of one already
// gone: a daemon that lost its record to a newer one must not delete it.
export function releaseDaemon(pid: number): void
{
    withLock(daemonFile(), () =>
    {
        const record = readDaemon();
        if (record !== null && record.pid === pid)
        {
            rmSync(daemonFile(), { force: true });
        }
    });
}

export function readTick(): TickRecord | null
{
    return readRecord<TickRecord>(join(daemonDir(), TICK_FILE));
}

export function writeTick(counts: TickCounts, at: Date, failed?: string): TickRecord
{
    const record: TickRecord = { at: at.toISOString(), ticks: (readTick()?.ticks ?? 0) + 1, ...counts };
    if (failed !== undefined)
    {
        record.failed = failed;
    }
    writeRecord(join(daemonDir(), TICK_FILE), record);
    return record;
}

// The dispatches this machine issued and the process each was issued to. A
// dispatch takes a moment to claim its work unit, and until it has, nothing
// the spools say would stop the next tick from issuing a second one — this is
// the only record of a wake in flight, and it lives exactly as long as the
// process it names.
export interface WakeRecord
{
    workSpec: string;
    work: string;
    generation: number;
    at: string;
    child: number;
    // The dispatch process's launch instant, beside its pid, for the same
    // reason the owned tree of a launch carries one: a pid that came back
    // around would keep a generation looking "driven" for as long as whatever
    // inherited the number lives, and nothing would ever wake that work again.
    childStartedAt: string | null;
}

const WAKES_FILE = "wakes.json";

export function readWakes(): WakeRecord[]
{
    return readRecord<WakeRecord[]>(join(daemonDir(), WAKES_FILE)) ?? [];
}

// Written with the outstanding wakes only. A wake whose process is gone has
// either claimed its work unit — in which case the spools now say so — or died
// before it could, and either way it is no longer in flight. Read-modify-write
// under the lock, so a `daemon tick` run by hand beside the loop cannot drop
// the wake the other one just issued.
export function recordWake(wake: WakeRecord): void
{
    const file = join(daemonDir(), WAKES_FILE);
    withLock(file, () =>
    {
        const kept = readWakes().filter((entry) => entry.child !== wake.child && dispatchAlive(entry));
        writeRecord(file, [...kept, wake]);
    });
}

export function wakeInFlight(workSpec: string, generation: number): boolean
{
    return readWakes().some((wake) => wake.workSpec === workSpec && wake.generation === generation && dispatchAlive(wake));
}

// Whether the process this wake was issued to is still the process it was
// issued to. A pid alone is not an identity: it is reused, and a wake that
// answered a bare liveness probe on somebody else's process would report its
// generation driven for ever and silently stop the work being woken again.
function dispatchAlive(wake: WakeRecord): boolean
{
    return wake.child > 0 && sameProcess(wake.child, wake.childStartedAt ?? null);
}

function readRecord<T>(file: string): T | null
{
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

function writeRecord(file: string, value: unknown): void
{
    mkdirSync(daemonDir(), { recursive: true });
    writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}
