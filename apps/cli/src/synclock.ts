// One machine, one sync at a time.
//
// A server-backed store has exactly one piece of work that is not a plain
// append: the sync — pulling the server's copy, marking what came back, tidying
// the queue, and reconciling the project list. Every one of those either
// rewrites a file or writes a mark whose meaning depends on what another writer
// is doing, so two of them at once is the whole of what can go wrong here. This
// is the lock that says only one runs.
//
// The foreground append is deliberately outside it and stays outside it. One
// line added to a queue file is safe against another process doing the same,
// and recording work is the thing a person is waiting on — it must never queue
// behind a network read. That asymmetry is why the rewrites below carry the
// tail of whatever was appended while they ran: the lock holds off other sync
// work, and nothing at all holds off an append.
//
// Synchronous, and with no `chmod`. The credential lock next door is neither:
// it is `async` because the refresh it guards is, and it makes its files
// private because a credential is in them. Neither applies here — the append
// path is synchronous throughout, and a store's own files carry the
// permissions the store was made with. Reaching for that helper would have
// bought an `await` in a synchronous path and a permission change on a
// directory the user chose the permissions of.
import { randomBytes } from "node:crypto";
import {
    closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync
} from "node:fs";
import { join } from "node:path";

export const SYNC_LOCK_FILE = "sync.lock";

// How long a holder may hold it before another process may take it away.
//
// The number is not a guess about how long the work takes; it is the bound the
// holder enforces on itself. A background pusher gives itself `PUSHER_LEASE_MS`
// (`pusher.ts`) and exits when it passes that, so a lock older than this one
// belongs to a process that either died or has already stopped working. Keeping
// the two numbers apart — the holder's bound strictly under the stealing
// threshold — is what makes "stale" a fact rather than an opinion, and it is why
// nothing here needs a heartbeat: a live holder cannot reach this age.
export const SYNC_LEASE_MS = 300_000;

interface LockRecord
{
    pid: number;
    nonce: string;
    at: string;
}

// Taken, or not taken at all — never waited for. A sync is work the next
// command can do just as well, and a person's command must not sit behind
// another process's network read. The answer is the nonce, which is what every
// publish below re-checks before it renames anything into place.
export function acquireSyncLock(storeDir: string): string | null
{
    const nonce = randomBytes(16).toString("hex");
    return acquire(join(storeDir, SYNC_LOCK_FILE), nonce) ? nonce : null;
}

export function releaseSyncLock(storeDir: string, nonce: string): void
{
    release(join(storeDir, SYNC_LOCK_FILE), nonce);
}

// The synchronous shape of the pair, for work that has no `await` in it. A push
// does, and holds the lock across it by acquiring and releasing itself: a
// `finally` around a promise-returning body releases the moment the promise is
// made rather than when it settles, which is a lock that guards nothing.
export function withSyncLock<T>(storeDir: string, work: (nonce: string) => T): T | null
{
    const nonce = acquireSyncLock(storeDir);
    if (nonce === null)
    {
        return null;
    }
    try
    {
        return work(nonce);
    }
    finally
    {
        releaseSyncLock(storeDir, nonce);
    }
}

function acquire(path: string, nonce: string): boolean
{
    if (create(path, nonce))
    {
        return true;
    }
    return stale(path) && steal(path, nonce) && create(path, nonce);
}

// `wx` is the whole exclusion: the create fails where the file is there, which
// is one system call and no window between a look and a write.
function create(path: string, nonce: string): boolean
{
    const record: LockRecord = { pid: process.pid, nonce, at: new Date().toISOString() };
    let handle: number;
    try
    {
        handle = openSync(path, "wx");
    }
    catch
    {
        return false;
    }
    writeSync(handle, JSON.stringify(record));
    closeSync(handle);
    // A lock this process created can still be stolen between the create and
    // this read, and acting as the holder without checking is how two writers
    // both believe they hold it.
    return heldBy(path, nonce);
}

// Whether the nonce on disk is still this holder's. Asked again before every
// rename a sync publishes, so a holder that was stolen from publishes nothing.
function heldBy(path: string, nonce: string): boolean
{
    return readLock(path)?.nonce === nonce;
}

function readLock(path: string): LockRecord | null
{
    try
    {
        return JSON.parse(readFileSync(path, "utf8")) as LockRecord;
    }
    catch
    {
        return null;
    }
}

// Age alone, and no liveness probe. The credential lock asks whether its
// holder's pid is still alive because a refresh must not be repeated on a
// guess; here the holder's own lease is the stronger statement, and a pid check
// would only add a way to be wrong about a pid another program has since
// reused.
//
// An unreadable lock file is treated as one written by a process that died
// mid-create: it names no holder, so the age of the file is all there is, and
// that is exactly the case the threshold answers.
function stale(path: string): boolean
{
    const age = Date.now() - writtenAt(path);
    return Number.isFinite(age) && age > SYNC_LEASE_MS;
}

function writtenAt(path: string): number
{
    const stamp = Date.parse(readLock(path)?.at ?? "");
    if (Number.isFinite(stamp))
    {
        return stamp;
    }
    try
    {
        return statSync(path).mtimeMs;
    }
    catch
    {
        return NaN;
    }
}

// Rename it out of the way, then create. `rename` on a vanished source fails,
// so of two processes that judge the same lock stale exactly one moves the
// inode and the other returns empty-handed — which is the difference between
// this and an unlink-then-create that would let both proceed.
function steal(path: string, nonce: string): boolean
{
    try
    {
        renameSync(path, `${path}.dead-${nonce}`);
    }
    catch
    {
        return false;
    }
    try
    {
        unlinkSync(`${path}.dead-${nonce}`);
    }
    catch
    {
        // The inode is out of the way, which is the part that matters.
    }
    return true;
}

// Released only where the nonce on disk is still this holder's: a process that
// was stolen from must never unlink the lock its successor now holds.
function release(path: string, nonce: string): void
{
    if (heldBy(path, nonce))
    {
        try
        {
            unlinkSync(path);
        }
        catch
        {
            // Already gone. Nothing to undo and nothing to say.
        }
    }
}

/* ── replacing a file the foreground may still be appending to ─────── */

// The one rewrite a sync makes, done so that neither a crash nor a concurrent
// append can cost a record.
//
// `rewrite` is handed everything the file holds and answers with what should
// replace it. What makes this safe is the second read: an append that landed
// while `rewrite` was thinking is still at the end of the file, and its bytes
// are carried onto the replacement before the rename. The original is
// authoritative until the rename lands, so a crash anywhere before it leaves
// the original whole and an abandoned temp file behind — which the next holder
// overwrites, because the temp is named by the nonce that is writing it.
//
// The nonce is re-checked immediately before the rename. A holder whose lease
// ran out and whose lock was taken publishes nothing.
export function publishRewrite(storeDir: string, file: string, nonce: string, rewrite: (text: string) => string): boolean
{
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const replacement = rewrite(before);
    const after = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!after.startsWith(before))
    {
        // Something rewrote it under us — nothing here is safe to publish over
        // that, and the next sync will find the file whole and try again.
        return false;
    }
    return publish(storeDir, file, nonce, replacement + after.slice(before.length));
}

function publish(storeDir: string, file: string, nonce: string, text: string): boolean
{
    const temp = `${file}.tmp-${nonce}`;
    writeFileSync(temp, text);
    if (!heldBy(join(storeDir, SYNC_LOCK_FILE), nonce))
    {
        unlinkSync(temp);
        return false;
    }
    renameSync(temp, file);
    return true;
}
