import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { breakLock, LockHold, lockHolder, lockPath, takeLock, withLock, writeAtomic } from "../attempt/atomic.js";
import { bootId, nodeId } from "../attempt/boundary.js";
import { alive, sameProcess } from "../attempt/tree.js";
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

export function tickFile(): string
{
    return join(daemonDir(), TICK_FILE);
}

// One tick at a time on this machine, whoever asked for it. The loop's tick and
// a tick a person runs by hand read the same live-attempt count and the same
// window spend, and both decide against it before either dispatch has claimed
// anything — so two of them running together each see room under the
// concurrency cap that only one of them has, and the cap is overshot by exactly
// the work the other one issued. Serialising them is what makes the cap a
// statement about the machine rather than about one tick.
//
// The patience is long because the section is: a tick settles attempts through
// the completion gate, and a gate runs whatever validation a spec declared. A
// timeout shorter than a real tick would have every contended caller judge the
// holder stale and run anyway, which is this lock not existing.
const TICK_LOCK_TIMEOUT_MS = 30_000;
const TICK_LOCK_POLL_MS = 100;

// The lock a crash left behind is not something to be patient about. A
// supervisor killed mid-tick leaves the file with its own pid in it, and that
// pid's token will never change again — so patience alone would have every
// tick after the crash sit out the whole window before breaking a lock that
// was free the instant the holder died. During that window supervision does
// nothing, which is the state the supervisor exists to end rather than one it
// may enter.
//
// So the holder is asked about rather than waited on, the same rule the
// settlement lock in attempt/settlement.ts applies for the same reason: a pid
// that is not alive on this machine holds nothing, and its lock is taken now.
//
// The age rule is the backstop the pid alone cannot give, because a number is
// handed out again and a lock could name a live process that never took it.
// It is far longer than any wait on purpose: a tick may legitimately run for
// minutes when a completion gate runs a declared validation, and an age rule
// as short as the wait would take the lock from a tick that is working.
const TICK_LOCK_WEDGED_MS = 600_000;

export async function withTickLock<T>(run: () => Promise<T>): Promise<T>
{
    const held = await claimTick();
    try
    {
        return await run();
    }
    finally
    {
        held.release();
    }
}

// The mutex, waited for on the event loop rather than through it. The wait has
// to yield: a supervisor answers its stop signal between turns, and a
// synchronous poll would make a contended tick a process `self daemon stop`
// cannot reach.
async function claimTick(): Promise<LockHold>
{
    const deadline = Date.now() + TICK_LOCK_TIMEOUT_MS;
    for (;;)
    {
        const held = claimTickOnce();
        if (held !== null)
        {
            return held;
        }
        if (Date.now() >= deadline)
        {
            // A holder that is alive and has not been holding it long enough
            // to be wedged is a tick that is running right now. Taking it from
            // there would be the exclusion this lock provides, gone — so the
            // caller is told, the loop catches it and ticks again, and a person
            // who asked by hand gets one line rather than a second tick.
            throw new CliError(`a tick is already running on this machine as process ${tickHolder() ?? "?"} — nothing was ticked, and the next tick decides again`);
        }
        await pause(TICK_LOCK_POLL_MS);
    }
}

function claimTickOnce(): LockHold | null
{
    const file = tickFile();
    const held = takeLock(file, String(process.pid));
    if (held !== null)
    {
        return held;
    }
    const token = lockHolder(file);
    if (token === null || !abandonedTick(file, token))
    {
        return null;
    }
    // Broken only if it is still the lock that was judged: a tick that took it
    // between the judgement and here is working behind a lock of its own.
    return breakLock(file, token) ? takeLock(file, String(process.pid)) : null;
}

// Whether the lock may be taken from whoever the file says has it.
//
// A lock that names no holder is a lock being taken right now, and it is the
// one answer that must not be "yes": the file is created exclusively and its
// token is written a syscall later, so a waiter that read the gap and called
// it abandoned would delete the lock of the process that had just won it, and
// two ticks would run believing they were alone. That is not a rare window —
// two ticks started together arrive at it together. Only the age rule can
// judge a lock with nothing in it, and it will hardly ever have to.
function abandonedTick(file: string, token: string): boolean
{
    const pid = tickHolderOf(token);
    if (pid !== null && !alive(pid))
    {
        return true;
    }
    return lockAge(lockPath(file)) > TICK_LOCK_WEDGED_MS;
}

function tickHolder(): number | null
{
    const token = lockHolder(tickFile());
    return token === null ? null : tickHolderOf(token);
}

// The process that took the lock, as its token records it. `takeLock` and
// `withLock` both write the identity they were given followed by a random
// suffix, and the identity is the pid.
function tickHolderOf(token: string): number | null
{
    const pid = Number.parseInt(token.split(".")[0] ?? "", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// How long the lock has existed. A lock file is created once and never written
// again, so its own timestamp is when its holder took it.
function lockAge(lock: string): number
{
    try
    {
        return Date.now() - statSync(lock).mtimeMs;
    }
    catch
    {
        return 0;
    }
}

function pause(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readTick(): TickRecord | null
{
    return readRecord<TickRecord>(tickFile());
}

export function writeTick(counts: TickCounts, at: Date, failed?: string): TickRecord
{
    const record: TickRecord = { at: at.toISOString(), ticks: (readTick()?.ticks ?? 0) + 1, ...counts };
    if (failed !== undefined)
    {
        record.failed = failed;
    }
    writeRecord(tickFile(), record);
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
