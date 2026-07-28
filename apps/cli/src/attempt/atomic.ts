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
    const lock = `${file}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    const first = acquire(lock);
    if (first !== null)
    {
        return release(first, lock, run);
    }
    // Which holder this process is waiting on. What makes breaking a lock
    // defensible is that one holder sat on it for the whole window, so the
    // identity is read before the wait and checked again after it.
    const waitingOn = tokenOf(lock);
    for (let waited = 0; waited < LOCK_TIMEOUT_MS; waited += LOCK_POLL_MS)
    {
        pause(LOCK_POLL_MS);
        const held = acquire(lock);
        if (held !== null)
        {
            return release(held, lock, run);
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
    return release(taken, lock, run);
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

function acquire(lock: string): Held | null
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
    const token = `${process.pid}.${randomBytes(8).toString("hex")}`;
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
