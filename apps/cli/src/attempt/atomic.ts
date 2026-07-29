import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CliError } from "../types.js";

// Publishing a file through a temporary name is only atomic when the temporary
// name belongs to one writer. A fixed `<file>.tmp` sibling is shared by every
// process on the machine, so two runners writing the same counter interleave
// their bytes and one rename publishes the other's half-written record.
export function writeAtomic(file: string, text: string): void
{
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    mkdirSync(dirname(file), { recursive: true });
    try
    {
        writeFileSync(temp, text);
        renameSync(temp, file);
    }
    catch (error)
    {
        rmSync(temp, { force: true });
        throw error;
    }
}

const LOCK_POLL_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;

// The machine-local counters are read, incremented, and written back. Running
// several attempts at once on one machine is the designed operating mode, so
// two runners reading the same value and minting the same number is not an
// edge case — it is what happens the first time a queue starts two attempts
// together. Exclusive creation is the one filesystem operation that can settle
// which of them goes first.
export function withLock<T>(file: string, run: () => T): T
{
    const lock = lockPath(file);
    return release(waitForLock(lock, LOCK_TIMEOUT_MS), lock, run);
}

// The same exclusion, held across work that awaits. `withLock` cannot bracket
// an asynchronous body: it would release the moment the call returned its
// promise and hand the lock to the next waiter while the critical section was
// still running. Acquisition is unchanged — exclusive creation, the same wait,
// the same stale rule — and only the release moves to where the work ends.
//
// How long to wait belongs to the caller. Five seconds suits a counter
// increment; a section that legitimately runs for longer needs patience that
// outlasts it, or every contended caller breaks the lock and both run.
export async function withLockAsync<T>(file: string, run: () => Promise<T>, timeoutMs: number = LOCK_TIMEOUT_MS): Promise<T>
{
    const lock = lockPath(file);
    const held = waitForLock(lock, timeoutMs);
    try
    {
        return await run();
    }
    finally
    {
        releaseHeld(held, lock);
    }
}

function waitForLock(lock: string, timeoutMs: number): Held
{
    mkdirSync(dirname(lock), { recursive: true });
    const first = acquire(lock);
    if (first !== null)
    {
        return first;
    }
    // Which holder this process is waiting on. What makes breaking a lock
    // defensible is that one holder sat on it for the whole window, so the
    // identity is read before the wait and checked again after it.
    const waitingOn = tokenOf(lock);
    for (let waited = 0; waited < timeoutMs; waited += LOCK_POLL_MS)
    {
        pause(LOCK_POLL_MS);
        const held = acquire(lock);
        if (held !== null)
        {
            return held;
        }
    }
    const taken = breakStale(lock, waitingOn);
    if (taken === null)
    {
        // Either the lock changed hands during the wait, or another waiter that
        // timed out at the same instant broke it first. Neither is a lock this
        // process holds, and the critical section is a read-modify-write on the
        // counter this primitive exists to serialise: running it unlocked would
        // corrupt exactly what the call was made to protect. The caller gets a
        // failure it can retry instead of a silent double write.
        throw new CliError(`could not take ${lock}: another process holds it and it is not stale — nothing was written`);
    }
    return taken;
}

// A lock still held by the same owner after the whole window belongs to a
// process that died holding it, and the counter it guards must not stay frozen
// for the life of the machine. A lock that changed hands in that window is a
// lock in use — breaking it a moment after a waiter legitimately took it is the
// mutual exclusion this primitive provides, gone, and one broken lock cascades
// into the next.
function breakStale(lock: string, waitingOn: string | null): Held | null
{
    if (waitingOn === null || tokenOf(lock) !== waitingOn)
    {
        return null;
    }
    rmSync(lock, { force: true });
    return acquire(lock);
}

// The lock a process holds, told apart from the one another process may have
// put in its place. Exclusive creation says who got there first; the token
// says whether the file still belongs to whoever is about to remove it.
interface Held
{
    fd: number;
    token: string;
}

// The identity written into the lock is the caller's, so a holder can be asked
// about afterwards: the default names this process, and a caller that has to
// tell a working holder from one a crash left behind says who it is in terms
// that outlive the file.
function acquire(lock: string, identity: string = String(process.pid)): Held | null
{
    let fd: number;
    try
    {
        fd = openSync(lock, "wx");
    }
    catch
    {
        return null;
    }
    const token = `${identity}.${randomBytes(8).toString("hex")}`;
    try
    {
        writeFileSync(fd, token);
    }
    catch (error)
    {
        closeSync(fd);
        rmSync(lock, { force: true });
        throw error;
    }
    return { fd, token };
}

function release<T>(held: Held, lock: string, run: () => T): T
{
    try
    {
        return run();
    }
    finally
    {
        releaseHeld(held, lock);
    }
}

function releaseHeld(held: Held, lock: string): void
{
    closeSync(held.fd);
    // A waiter that judged this lock stale has already removed it and taken
    // one of its own. Removing the path unconditionally would delete that
    // waiter's lock and let a third process in behind it — one lost
    // exclusion cascading into the next.
    if (tokenOf(lock) === held.token)
    {
        rmSync(lock, { force: true });
    }
}

// The lock taken and held by name, rather than wrapped around a call. What
// needs this is work `withLock` cannot bracket: an attempt's completion gate is
// asynchronous, and it may legitimately run for as long as a declared
// validation takes — so the rule about when a holder counts as abandoned
// belongs to the caller that knows what holding it means, not to the five
// second timeout that suits a counter increment.
export interface LockHold
{
    token: string;
    release: () => void;
}

export function lockPath(file: string): string
{
    return `${file}.lock`;
}

export function takeLock(file: string, identity: string): LockHold | null
{
    const lock = lockPath(file);
    mkdirSync(dirname(lock), { recursive: true });
    const held = acquire(lock, identity);
    return held === null ? null : { token: held.token, release: () => releaseHeld(held, lock) };
}

export function lockHolder(file: string): string | null
{
    return tokenOf(lockPath(file));
}

// Removed only if it is still the lock that was judged. A lock that changed
// hands between the judgement and this call belongs to whoever took it, and
// removing that one would let a third process in behind them.
export function breakLock(file: string, token: string): boolean
{
    const lock = lockPath(file);
    if (tokenOf(lock) !== token)
    {
        return false;
    }
    rmSync(lock, { force: true });
    return true;
}

function tokenOf(lock: string): string | null
{
    try
    {
        return readFileSync(lock, "utf8");
    }
    catch
    {
        return null;
    }
}

// Everything holding this lock is synchronous filesystem work, so the wait has
// to be synchronous too: a timer would hand the lock to the next turn of the
// event loop inside the same process.
function pause(ms: number): void
{
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
