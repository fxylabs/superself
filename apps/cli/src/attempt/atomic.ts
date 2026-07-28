import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
    for (let waited = 0; waited < LOCK_TIMEOUT_MS; waited += LOCK_POLL_MS)
    {
        const held = acquire(lock);
        if (held !== null)
        {
            return release(held, lock, run);
        }
        pause(LOCK_POLL_MS);
    }
    // A lock still held after the whole window belongs to a process that died
    // holding it. The counter it guards must not stay frozen for the life of
    // the machine, so the stale lock is broken and taken once.
    rmSync(lock, { force: true });
    const taken = acquire(lock);
    return taken === null ? run() : release(taken, lock, run);
}

function acquire(lock: string): number | null
{
    try
    {
        return openSync(lock, "wx");
    }
    catch
    {
        return null;
    }
}

function release<T>(fd: number, lock: string, run: () => T): T
{
    try
    {
        return run();
    }
    finally
    {
        closeSync(fd);
        rmSync(lock, { force: true });
    }
}

// Everything holding this lock is synchronous filesystem work, so the wait has
// to be synchronous too: a timer would hand the lock to the next turn of the
// event loop inside the same process.
function pause(ms: number): void
{
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
