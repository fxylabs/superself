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
//
// What all of it rests on, stated because it is a precondition and not a
// preference: a **local POSIX filesystem**. Four properties, and every one of
// them is load-bearing —
//
//   `O_EXCL` on a create is exclusive against every other process on the
//   machine, which is the whole of the exclusion below;
//   `rename` replaces a name in one step, so a reader sees the old file or the
//   new one and never half of either;
//   an inode a `rename` unlinked stays readable through a descriptor still open
//   on it, which is how the publish recovers an append that landed in the
//   moment before it;
//   a file's mtime is a time this machine's clock would recognise, which is
//   what an unreadable lock file is judged by.
//
// A store kept on a network share or inside a folder a cloud client syncs
// breaks at least one: most emulate `O_EXCL` rather than implement it, several
// copy-and-delete rather than rename, and none of them promise the third. This
// is not a lock there, and no amount of care in this file makes it one.
import { randomBytes } from "node:crypto";
import {
    Dirent, appendFileSync, closeSync, fstatSync, openSync, readSync, readdirSync, readFileSync, renameSync,
    statSync, unlinkSync, writeFileSync, writeSync
} from "node:fs";
import { join } from "node:path";

export const SYNC_LOCK_FILE = "sync.lock";

// How long a holder may hold it before another process may take it away.
//
// The number is not a guess about how long the work takes; it is the bound
// every holder enforces on itself. There are two of them and both are bounded:
// a background pusher gives itself `PUSHER_LEASE_MS` (`pusher.ts`) and a
// catch-up gives itself `PULLER_LEASE_MS` (`puller.ts`), and each stops where
// its own bound runs out. So a lock older than this one belongs to a process
// that either died or has already stopped working. Keeping the numbers apart —
// every holder's bound strictly under the stealing threshold — is what makes
// "stale" a fact rather than an opinion, and it is why nothing here needs a
// heartbeat: a live holder cannot reach this age.
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
    if (!acquire(join(storeDir, SYNC_LOCK_FILE), nonce))
    {
        return null;
    }
    sweepAbandoned(storeDir);
    return nonce;
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
//
// Two clocks, and they are not the same clock. This reads a wall-clock stamp
// one process wrote and subtracts it from `Date.now()` in another, because that
// stamp is the only thing on disk two processes can both read. A holder's own
// bound is the difference of two readings inside one process. So a wall clock
// that jumps forward — NTP stepping it, a laptop waking from suspend — ages a
// lock whose holder still believes it is young, and one that jumps back holds a
// dead lock un-stealable for the length of the jump.
//
// Documented rather than repaired. Putting the holder's bound on a monotonic
// clock would leave it compared against a wall-clock stamp here, which moves
// the disagreement rather than ending it, and what the disagreement costs is
// bounded either way: a sync skipped for as long as the jump, or a second
// holder that the nonce re-checked before every rename stops from publishing.
// Neither costs a record.
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

/* ── what a holder that died left behind ───────────────────────────── */

// The temp file a publish writes and the inode a steal renames aside, both
// swept the moment this process becomes the holder.
//
// Inside the lock, which is what makes this a sweep rather than a race with a
// live writer: each of those names is written by a holder between its own
// acquire and its own release, and there is one holder at a time. A file
// carrying either name while this process holds the lock was left by a process
// that is no longer a holder, and nothing will ever read it — a publish names
// its temp after the nonce writing it, so the next publish writes a name of its
// own rather than finding this one.
//
// That last point is why the sweep exists at all. "The next holder overwrites
// it" was never true of a file named after a nonce nobody will draw again:
// without this, a store collects one leftover per interrupted sync, in a
// directory a person opens.
function sweepAbandoned(storeDir: string): void
{
    sweep(storeDir);
    const projects = join(storeDir, "projects");
    contentsOf(projects).filter((entry) => entry.isDirectory())
        .forEach((entry) => sweep(join(projects, entry.name)));
}

function sweep(dir: string): void
{
    contentsOf(dir).filter((entry) => entry.isFile() && abandoned(entry.name))
        .forEach((entry) => discard(join(dir, entry.name)));
}

// Named by a nonce, and the nonce is what is checked: a file a person put in
// the store is not swept for having "tmp" somewhere in its name.
function abandoned(name: string): boolean
{
    return /-[0-9a-f]{32}$/.test(name)
        && (name.includes(".tmp-") || name.startsWith(`${SYNC_LOCK_FILE}.dead-`));
}

function contentsOf(dir: string): Dirent[]
{
    try
    {
        return readdirSync(dir, { withFileTypes: true });
    }
    catch
    {
        // A store that has never held a project has no projects directory, and
        // a directory this process may not read holds nothing it may sweep.
        return [];
    }
}

function discard(path: string): void
{
    try
    {
        unlinkSync(path);
    }
    catch
    {
        // Gone already, or not this process's to remove. Neither is worth
        // stopping a sync over: nothing reads the file either way.
    }
}

/* ── replacing a file the foreground may still be appending to ─────── */

// The one rewrite a sync makes, done so that neither a crash nor a concurrent
// append can cost a record.
//
// `rewrite` is handed everything the file holds and answers with what should
// replace it. An append can land at two moments while that happens, and they
// need different answers:
//
//   between the two reads      the second read sees those bytes, and they go
//                              onto the end of the replacement before it is
//                              published
//   after the second read,     nothing has seen them, and the rename unlinks
//   before the rename          the inode they are on. They are read back out of
//                              a descriptor this function has held open on that
//                              inode since before the first read, and appended
//                              to the published file
//
// The second window is as wide as the time it takes to write the replacement
// out, so on a queue of any size it is not theoretical: without the recovery, a
// rewrite drops a run of appends off the end of the file, silently, and the
// records in them exist nowhere else on this machine.
//
// The original is authoritative until the rename lands, so a crash anywhere
// before it leaves the original whole and an abandoned temp file behind, which
// the next process to take the lock sweeps up.
//
// The nonce is re-checked immediately before the rename. A holder whose lease
// ran out and whose lock was taken publishes nothing — and carries no tail
// either, because there was no rename for one to be lost to.
export function publishRewrite(storeDir: string, file: string, nonce: string, rewrite: (text: string) => string): boolean
{
    const original = openReadable(file);
    try
    {
        return publishCarrying(storeDir, file, nonce, rewrite, original);
    }
    finally
    {
        // Every way out of the publish leaves through here: the refusals, the
        // rename, and a `rewrite` that throws on a line it cannot parse.
        closeReadable(original);
    }
}

function publishCarrying(storeDir: string, file: string, nonce: string,
    rewrite: (text: string) => string, original: number | null): boolean
{
    const before = bytesFrom(original, 0).toString("utf8");
    const replacement = rewrite(before);
    const carried = bytesFrom(original, 0);
    const after = carried.toString("utf8");
    if (!after.startsWith(before))
    {
        // Something rewrote it under us — nothing here is safe to publish over
        // that, and the next sync will find the file whole and try again.
        return false;
    }
    if (!publish(storeDir, file, nonce, replacement + after.slice(before.length)))
    {
        return false;
    }
    carryLateTail(file, original, carried.length);
    return true;
}

// The appends that landed after the second read and before the rename.
//
// `rename` unlinks the inode the original was on, and on the filesystems this
// module is written for (see the header) a descriptor still open on that inode
// keeps reading it. So this is the one place those bytes still exist once the
// rename has landed, and they go onto the end of the published file — where an
// appender a moment slower would have put them itself.
//
// What is not preserved is the order within that moment: an append made after
// the rename reaches the new file first and this tail follows it. Neither file
// this publishes is read in order — every row in both is found by the append id
// or the slug it names — and the alternative is a rewrite that waits for a file
// the foreground is deliberately free to keep growing.
function carryLateTail(file: string, original: number | null, carried: number): void
{
    const tail = bytesFrom(original, carried);
    if (tail.length > 0)
    {
        appendFileSync(file, tail);
    }
}

// Opened before the first read, so that the inode the reads below are about is
// the inode the tail is recovered from. A file that is not there is not an
// error: there is nothing to read and nothing an appender could have added to.
function openReadable(file: string): number | null
{
    try
    {
        return openSync(file, "r");
    }
    catch
    {
        return null;
    }
}

function closeReadable(fd: number | null): void
{
    if (fd !== null)
    {
        closeSync(fd);
    }
}

// What the original holds from `position` on, through the one descriptor this
// publish keeps. Bytes rather than decoded text throughout, because `position`
// is an offset on an inode and the length of a decoded string is not one.
function bytesFrom(fd: number | null, position: number): Buffer
{
    if (fd === null)
    {
        return Buffer.alloc(0);
    }
    const wanted = Math.max(fstatSync(fd).size - position, 0);
    if (wanted === 0)
    {
        return Buffer.alloc(0);
    }
    const buffer = Buffer.alloc(wanted);
    return buffer.subarray(0, readSync(fd, buffer, 0, wanted, position));
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
