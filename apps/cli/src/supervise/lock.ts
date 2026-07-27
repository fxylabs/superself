import { closeSync, fsyncSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CliError } from "../types.js";
import { localDir, readLocalJson } from "./local.js";

// One generation per process. A daemon that was killed and restarted is a
// different generation even on the same pid, which is what lets a settlement
// tell "me, earlier" apart from "someone else, now".
const GENERATION = `${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

export function generation(): string
{
    return GENERATION;
}

interface LockHolder
{
    pid: number;
    generation: string;
    takenAt: string;
}

function lockFile(storeDir: string): string
{
    return join(localDir(storeDir), "journal.lock");
}

function holderAlive(holder: LockHolder): boolean
{
    try
    {
        process.kill(holder.pid, 0);
        return true;
    }
    catch (error)
    {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

// Held locks are short — one tick — so a lock whose holder is gone, or that
// has outlived any honest critical section, is a crash and may be broken.
const STALE_MS = 120_000;

// A lock file exists for an instant before its holder has written itself into
// it. Treating that unreadable instant as abandoned would let a competitor
// delete a live lock and hold it at the same time, so an unreadable lock is
// broken on age alone and never on sight.
function breakable(file: string): boolean
{
    const holder = readLocalJson<LockHolder>(file);
    if (holder === null)
    {
        return olderThanGrace(file);
    }
    return !holderAlive(holder) || Date.now() - new Date(holder.takenAt).getTime() > STALE_MS;
}

function olderThanGrace(file: string): boolean
{
    try
    {
        return Date.now() - statSync(file).mtimeMs > STALE_MS;
    }
    catch
    {
        // It went away while we looked: the next acquire attempt decides.
        return false;
    }
}

function sleepSync(ms: number): void
{
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryAcquire(storeDir: string): boolean
{
    const file = lockFile(storeDir);
    try
    {
        // wx is the atomic part: exactly one process can create the file.
        const fd = openSync(file, "wx");
        try
        {
            const holder: LockHolder = { pid: process.pid, generation: GENERATION, takenAt: new Date().toISOString() };
            writeSync(fd, JSON.stringify(holder) + "\n");
            fsyncSync(fd);
        }
        finally
        {
            closeSync(fd);
        }
        return true;
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        {
            throw error;
        }
        if (breakable(file))
        {
            rmSync(file, { force: true });
        }
        return false;
    }
}

let depth = 0;

// Every write to the journal happens inside this, so a fold read under the
// lock is the durable truth and a compare-and-set against it cannot be raced.
// Two daemon ticks on the same store serialise here rather than both settling
// the same attempt.
export function withStoreLock<T>(storeDir: string, fn: () => T): T
{
    if (depth > 0)
    {
        return fn();
    }
    const deadline = Date.now() + 30_000;
    while (!tryAcquire(storeDir))
    {
        if (Date.now() > deadline)
        {
            throw new CliError("another supervisor is holding this workspace's attempt journal — retry, or stop it with `self daemon stop`");
        }
        sleepSync(25 + Math.floor(Math.random() * 25));
    }
    depth += 1;
    try
    {
        return fn();
    }
    finally
    {
        depth -= 1;
        rmSync(lockFile(storeDir), { force: true });
    }
}
