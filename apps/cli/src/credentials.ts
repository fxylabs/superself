// The credential file, and every rule that keeps a token in it.
//
// This is the lowest of the three layers PR7 adds, and it is deliberately the
// one a customer reads first: everything security-relevant about holding a
// credential — the file modes, the atomic write, the per-profile lock, the
// pending marker that turns a power cut into a forced re-login instead of a
// false theft alert — is here, in the open-source repository, with nothing
// above it that a private plugin could replace.
//
// Two properties are worth stating because they are structural rather than
// conventional. A token never reaches the event log: login appends no event at
// all, and `test/structure.mjs` forbids the ledger and pipeline layers from
// importing this module, so there is no path from a credential to a synced
// record. And no file this module creates ever holds a byte of a token before
// its mode is `0600` — `mode:` alone is masked by the umask, so every create
// is `O_EXCL` plus an explicit `fchmod` on the descriptor.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
    chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync,
    readFileSync, renameSync, statSync, unlinkSync, writeSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail, pending } from "./types.js";

/* ── constants (design §10) ────────────────────────────────────────── */

// Where a profile points when nothing says otherwise. It lives here rather
// than beside `self login` because two things that are not login need it: the
// profile a credential is written into, and the plugin trust document, which
// has to be fetchable on a machine that has never logged in at all.
export const DEFAULT_API_BASE = "https://app.superselfs.com";

// How close to expiry an access token is refreshed before the call rather
// than after a 401.
export const REFRESH_MARGIN_MS = 60_000;
// How long a writer waits for another process's credential lock.
export const LOCK_WAIT_MS = 20_000;
// The lease. Deliberately longer than a whole legal refresh (connect 5 s +
// request 30 s), so a live holder is never stealable mid-flight.
export const STALE_LOCK_MS = 45_000;
// The escape from a lock whose owner cannot be proven gone — a pid the OS
// recycled, or one `kill(pid, 0)` answers with EPERM. Safe because the refresh
// is gated independently by the byte-identical token guard, so a wrong steal
// costs one wasted acquisition and can never produce a second refresh.
export const LOCK_ABSOLUTE_STEAL_MS = 600_000;
// Past this the stored refresh token cannot be valid under any circumstances,
// so the marker protects nothing and is removed rather than left to wedge the
// CLI. Equal to the server's absolute refresh TTL.
export const PENDING_MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ── the clock ─────────────────────────────────────────────────────── */

// UTC internals, one source (`01m0j3ch`), and injectable so the lease, the
// absolute steal bound and the marker TTL can be driven in a test without a
// test-only branch in the code that reads them.
let clock: () => Date = () => new Date();

export function now(): Date
{
    return clock();
}

export function useClock(next: () => Date): () => Date
{
    const previous = clock;
    clock = next;
    return previous;
}

/* ── where things live ─────────────────────────────────────────────── */

// Beside `machine.json`, never inside it: a credential is machine state, and
// the directory it shares is the one this module holds at `0700`.
export function configDir(): string
{
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "superself");
}

export function stateDir(): string
{
    return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "superself");
}

export function credentialsPath(): string
{
    return join(configDir(), "credentials.json");
}

// One marker and one lock per profile, named for the profile they cover. A
// single fixed name would let an ordinary command on one profile evaluate — and
// delete — another profile's marker, which is the exact path to the false theft
// alert the marker exists to close.
export function pendingPath(profile: string): string
{
    return join(configDir(), `credentials.${profileName(profile)}.pending`);
}

export function lockPath(profile: string): string
{
    return join(configDir(), `credentials.${profileName(profile)}.lock`);
}

// A profile name reaches the filesystem, so it is checked before it does. The
// name comes from `--profile` or `SUPERSELF_PROFILE`, both caller-supplied.
const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function profileName(name: string): string
{
    if (!PROFILE_NAME.test(name) || name.includes(".."))
    {
        throw fail("invalid_profile_name",
            `profile "${name}" is not a name — use lowercase letters, digits, dot, dash or underscore`);
    }
    return name;
}

/* ── writing a file no other user can read ─────────────────────────── */

// `mode:` applies to a directory this call creates and does nothing at all to
// one that already exists — and in practice one always does: `self init`
// creates `$XDG_CONFIG_HOME/superself` for `machine.json` long before any
// credential is written, at whatever the umask was. So the mode is applied
// afterwards as well, for the same reason every file here gets an explicit
// `fchmod`: the intent is a property of the directory, not of who happened to
// create it first.
export function ensurePrivateDir(dir: string): void
{
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32")
    {
        return;
    }
    // Only ever tightens. The property this enforces is "no other user can
    // read this", so a directory an operator has deliberately made *stricter*
    // than 0700 is already satisfying it and is left exactly as it is —
    // widening it back to 0700 would be this function undoing a decision it
    // has no business overruling.
    if ((statSync(dir).mode & 0o077) !== 0)
    {
        chmodSync(dir, 0o700);
    }
}

// Create-and-own, with the mode applied to the descriptor before the first
// byte. `O_EXCL` is what makes it a creation rather than a write into whatever
// was already there, and `fchmod` is what makes the mode real: `mode:` is
// masked by the umask and does nothing at all to a file that already exists.
export function writePrivateFile(path: string, text: string): void
{
    ensurePrivateDir(join(path, ".."));
    const fd = openSync(path, "wx", 0o600);
    try
    {
        fchmodSync(fd, 0o600);
        writeSync(fd, text);
        fsyncSync(fd);
    }
    finally
    {
        closeSync(fd);
    }
}

// The durable replace: a private temp file in the same directory, flushed,
// renamed over the target, and the directory itself flushed so the rename
// survives a power cut. A killed process never leaves a truncated file.
export function replacePrivateFile(path: string, text: string): void
{
    const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
    writePrivateFile(temp, text);
    try
    {
        renameSync(temp, path);
    }
    catch (error)
    {
        unlinkSync(temp);
        throw error;
    }
    syncDir(join(path, ".."));
}

function syncDir(dir: string): void
{
    const fd = openSync(dir, "r");
    try
    {
        fsyncSync(fd);
    }
    catch
    {
        // A filesystem that refuses to flush a directory handle (some network
        // mounts) does not make the rename less atomic; there is nothing to
        // recover from here and nothing to say about it.
    }
    finally
    {
        closeSync(fd);
    }
}

/* ── the credential file ───────────────────────────────────────────── */

export interface Profile
{
    api_base: string;
    account_id: string;
    grant_id: string;
    scopes: string[];
    console_base?: string;
    access_token: string;
    access_expires_at: string;
    refresh_token: string;
    grant_started_at: string;
    device_label?: string;
    obtained_at: string;
}

interface CredentialFile
{
    version: 1;
    default: string;
    profiles: Record<string, Profile>;
}

// POSIX modes mean nothing on Windows, so the check is skipped there with one
// warning rather than refusing to run for a property that platform cannot
// express (§9 Q13). The warning is emitted once per invocation.
let warnedWindows = false;

// Said once per invocation rather than once per process: a second `runCli` in
// one process is a second command, and a command that skipped a check owes its
// caller the line saying so even when an earlier one already said it.
export function resetCredentialWarnings(): void
{
    warnedWindows = false;
}

function checkMode(path: string): void
{
    if (process.platform === "win32")
    {
        if (!warnedWindows)
        {
            warnedWindows = true;
            process.stderr.write(`warning: file permissions are not enforced on this platform — ${path}\n`);
        }
        return;
    }
    if ((statSync(path).mode & 0o077) !== 0)
    {
        throw fail("credentials_permissions",
            `${path} is readable by other users`, { hint: `chmod 600 ${path}` });
    }
}

export function readCredentialFile(): CredentialFile | null
{
    const path = credentialsPath();
    if (!existsSync(path))
    {
        return null;
    }
    checkMode(path);
    try
    {
        return JSON.parse(readFileSync(path, "utf8")) as CredentialFile;
    }
    catch
    {
        throw fail("credentials_unreadable", `${path} is not readable as a credential file`, { hint: "self login" });
    }
}

// Which profile this run is about: the flag, then the environment, then the
// file's own default, then "default". Nothing here reads a token.
export function resolveProfileName(flag?: string): string
{
    const named = flag ?? process.env.SUPERSELF_PROFILE;
    if (named !== undefined && named !== "")
    {
        return profileName(named);
    }
    return profileName(readCredentialFile()?.default ?? "default");
}

export function readProfile(name: string): Profile
{
    const file = readCredentialFile();
    if (file === null)
    {
        throw fail("login_required", "no credential on this machine", { hint: "self login" });
    }
    const profile = file.profiles[name];
    if (profile === undefined)
    {
        throw fail("profile_not_found",
            `no profile "${name}" — this machine has ${Object.keys(file.profiles).join(", ") || "none"}`);
    }
    return profile;
}

// Which account this machine is logged in as, for the one caller that needs the
// name rather than the credential: the entry point, which reads it once and
// hands it to the append path as a value. No token leaves here, and nothing
// downstream of it can ask for one.
//
// Best effort by construction. A machine with no credential, an unreadable
// file, or a default profile that is not there is a machine whose records say
// who wrote them nowhere — a gap in an audit trail, and never a reason to
// refuse the work the caller actually asked for.
export function currentAccount(): string | undefined
{
    try
    {
        return readProfile(resolveProfileName()).account_id;
    }
    catch
    {
        return undefined;
    }
}

// Replace one profile, leaving every other one exactly as it was. The caller
// holds the lock; this is the write itself.
//
// `default` is set only when it is absent. An agent's ambient identity must not
// change because somebody logged a second account in (cell 34).
export function writeProfile(name: string, profile: Profile): void
{
    const file = readCredentialFile() ?? { version: 1 as const, default: name, profiles: {} };
    const next: CredentialFile = {
        version: 1,
        default: file.default === undefined || file.default === "" ? name : file.default,
        profiles: { ...file.profiles, [name]: profile }
    };
    replacePrivateFile(credentialsPath(), `${JSON.stringify(next, null, 2)}\n`);
}

export function removeProfile(name: string): void
{
    const file = readCredentialFile();
    if (file === null || file.profiles[name] === undefined)
    {
        return;
    }
    const profiles = { ...file.profiles };
    delete profiles[name];
    replacePrivateFile(credentialsPath(), `${JSON.stringify({ ...file, profiles }, null, 2)}\n`);
}

/* ── the per-profile lock ──────────────────────────────────────────── */

interface LockRecord
{
    pid: number;
    // The owner's process start time. It is what makes a pid comparison mean
    // anything: without it a recycled pid reads as a live owner forever.
    pid_start: string;
    nonce: string;
    at: string;
}

// Linux exposes the start time in field 22 of /proc/<pid>/stat; macOS answers
// through `ps -o lstart=`. Where neither can answer, the boot-identifying
// fallback is this process's own boot time, which changes across a reboot and
// so still tells a pre-reboot lock from a live one.
export function processStart(pid: number): string
{
    const stat = `/proc/${pid}/stat`;
    if (existsSync(stat))
    {
        // The command name sits in parentheses and may itself contain spaces,
        // so the fields are counted from after the closing one. Start time is
        // field 22 overall, which is index 19 of what remains.
        const line = readFileSync(stat, "utf8");
        return line.slice(line.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? "";
    }
    try
    {
        return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch
    {
        // Neither source can answer — a pid that is already gone, or a
        // platform with neither interface. The boot second stands in: it
        // changes across a reboot, which is the comparison that matters.
        return `boot:${Math.round(Date.now() / 1000 - Math.round(process.uptime()))}`;
    }
}

function alive(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        // ESRCH proves the owner is gone. EPERM proves only that this user
        // cannot signal it, which is not the same statement — that case waits
        // for the absolute bound rather than stealing on a guess.
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
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

// Whether the lock at `path` may be taken from its owner, and why. Age past
// the lease is necessary in both branches and sufficient in neither: the owner
// must be provably gone, or the absolute bound must have passed.
function stealable(record: LockRecord | null, ageMs: number): boolean
{
    if (record === null)
    {
        return ageMs > STALE_LOCK_MS;
    }
    if (ageMs > LOCK_ABSOLUTE_STEAL_MS)
    {
        return true;
    }
    if (ageMs <= STALE_LOCK_MS)
    {
        return false;
    }
    return !alive(record.pid) || processStart(record.pid) !== record.pid_start;
}

// Rename the lock out of the way, then create it exclusively. `rename` on a
// vanished source fails ENOENT, so of two processes that judge the same lock
// stale exactly one moves the inode and the loser returns to waiting — which
// is the whole difference between this and the unlink-then-create that would
// let both refresh and trip the server's own reuse detection.
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
        // Best effort: the inode is already out of the way, which is the part
        // that matters.
    }
    return true;
}

function tryAcquire(path: string, nonce: string): boolean
{
    const record: LockRecord = {
        pid: process.pid,
        pid_start: processStart(process.pid),
        nonce,
        at: now().toISOString()
    };
    try
    {
        writePrivateFile(path, JSON.stringify(record));
    }
    catch
    {
        return false;
    }
    // Ownership proof: a lock this process created can still have been stolen
    // between the create and this read, and acting as the owner without
    // checking is how two writers both believe they hold it.
    return readLock(path)?.nonce === nonce;
}

interface LockOptions
{
    // How long to wait before giving up. A refresh gives up at 20 s with exit
    // 3; a login that already holds an approved grant waits to the absolute
    // bound instead, because dropping the grant on a timeout would throw away
    // the one thing a human just approved.
    waitMs?: number;
    // Announced once, on stderr, when the wait passes the lease. Never on
    // stdout, and never in `--json`.
    onWait?: () => void;
}

// Run `work` holding the profile's lock. Released in a `finally`, and only
// when the nonce on disk is still this process's own: a process that was
// stolen from must never unlink the lock its successor now holds.
export async function withCredentialLock<T>(profile: string, options: LockOptions, work: () => Promise<T>): Promise<T>
{
    const path = lockPath(profile);
    const nonce = randomBytes(16).toString("hex");
    await waitForLock(path, nonce, options);
    try
    {
        return await work();
    }
    finally
    {
        if (readLock(path)?.nonce === nonce)
        {
            try
            {
                unlinkSync(path);
            }
            catch
            {
                // Already gone, which is the state a release wants anyway.
            }
        }
    }
}

async function waitForLock(path: string, nonce: string, options: LockOptions): Promise<void>
{
    const started = now().getTime();
    let announced = false;
    while (true)
    {
        if (tryAcquire(path, nonce) || breakStale(path, nonce))
        {
            return;
        }
        const waited = now().getTime() - started;
        if (options.waitMs !== undefined && waited > options.waitMs)
        {
            throw pending("refresh_lock_timeout",
                `another self process is holding the credential for profile "${profileOf(path)}"`, { retry_after_s: 5 });
        }
        if (!announced && waited > STALE_LOCK_MS && options.onWait !== undefined)
        {
            announced = true;
            options.onWait();
        }
        await sleep(100);
    }
}

function breakStale(path: string, nonce: string): boolean
{
    const record = readLock(path);
    const at = record === null ? lockMtime(path) : Date.parse(record.at);
    if (Number.isNaN(at) || !stealable(record, now().getTime() - at))
    {
        return false;
    }
    return steal(path, nonce) && tryAcquire(path, nonce);
}

// The profile a lock path names, for the one message that has to say which
// profile is busy.
function profileOf(path: string): string
{
    return path.replace(/^.*credentials\./, "").replace(/\.lock$/, "");
}

function lockMtime(path: string): number
{
    try
    {
        return statSync(path).mtimeMs;
    }
    catch
    {
        return Number.NaN;
    }
}

// Waiting is a real wait, and the injected clock is what a test advances — so
// the sleep is short and the loop reads the clock rather than counting sleeps.
function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── the pending marker ────────────────────────────────────────────── */

interface PendingMarker
{
    version: 1;
    profile: string;
    grant_id: string;
    // Digests, never tokens. The marker answers one question — "might a
    // rotation have landed that I did not persist?" — and a digest answers it
    // without a second copy of a live secret existing on disk.
    prior_refresh_sha256: string;
    prior_access_sha256: string;
    at: string;
}

export function digest(value: string): string
{
    return createHash("sha256").update(value).digest("hex");
}

export function writeMarker(profile: string, marker: PendingMarker): void
{
    replacePrivateFile(pendingPath(profile), JSON.stringify(marker));
}

export function removeMarker(profile: string): void
{
    try
    {
        unlinkSync(pendingPath(profile));
    }
    catch
    {
        // Nothing to remove is the state a removal wants.
    }
}

export function readMarker(profile: string): PendingMarker | null
{
    const path = pendingPath(profile);
    if (!existsSync(path))
    {
        return null;
    }
    checkMode(path);
    try
    {
        return JSON.parse(readFileSync(path, "utf8")) as PendingMarker;
    }
    catch
    {
        return null;
    }
}

// The startup predicate, evaluated against **this profile only**. It blocks
// when the credential on disk is still the one the interrupted refresh was
// about to rotate — because presenting that token is what would trip the
// server's reuse detection, revoke the whole grant chain, and email the owner
// a theft alert over what was really a power cut.
//
// Two ways it heals itself, so it can never wedge the CLI: a digest that no
// longer matches means the write did land (or a login replaced the
// credential), and a marker past its TTL covers a token that cannot be valid
// any more.
export function guardMarker(profile: string, storedRefreshToken: string): void
{
    const marker = readMarker(profile);
    if (marker === null)
    {
        return;
    }
    if (now().getTime() - Date.parse(marker.at) > PENDING_MARKER_TTL_MS)
    {
        removeMarker(profile);
        return;
    }
    if (marker.prior_refresh_sha256 !== digest(storedRefreshToken))
    {
        removeMarker(profile);
        return;
    }
    throw fail("login_required",
        "a credential refresh was interrupted and may have rotated the stored token",
        { reason: "refresh_interrupted", hint: "self login" });
}
