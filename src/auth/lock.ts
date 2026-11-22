import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, EXIT } from '../errors';
import { stateDir } from './config';

/**
 * One `self` at a time may change a server's stored sign-in.
 *
 * Refresh tokens rotate, and presenting one that was already rotated revokes the
 * whole grant on the server. So a refresh — and a login's write — runs under
 * this lock, and the holder reads the keychain again first: another process may
 * have just refreshed.
 *
 * The lock is a file created with `wx`, holding the holder's pid and a random
 * value. It is stale only when that pid is no longer running — never by its age,
 * because a live holder may be waiting on a slow network or a keychain prompt,
 * and taking its lock would send its refresh token twice. A stale lock is taken
 * over by renaming it aside (one rename wins), and a lock is released only by the
 * process whose value is in it.
 */
const WAIT_MS = 30_000;
const STEP_MS = 100;

interface Holder
{
    pid: number;
    nonce: string;
}

const lockFile = (server: string): string => join(stateDir(), `refresh-${Buffer.from(server).toString('base64url')}.lock`);

const readHolder = (path: string): Holder | null =>
{
    try
    {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Holder>;

        return typeof parsed.pid === 'number' && typeof parsed.nonce === 'string' ? { pid: parsed.pid, nonce: parsed.nonce } : null;
    }
    catch
    {
        return null;
    }
};

/** `kill(pid, 0)` sends nothing: it answers whether the process exists (EPERM: it does, as another user). */
const alive = (pid: number): boolean =>
{
    try
    {
        process.kill(pid, 0);

        return true;
    }
    catch (error)
    {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

const tryCreate = (path: string, mine: Holder): boolean =>
{
    try
    {
        const fd = openSync(path, 'wx', 0o600);

        try
        {
            writeSync(fd, JSON.stringify(mine));
        }
        finally
        {
            closeSync(fd);
        }

        return true;
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;

        throw error;
    }
};

/**
 * Move `path` aside atomically and look at what was moved. If it is what `keep`
 * says to keep, it is put back with `link`, which never replaces a file that
 * appeared meanwhile. Answers whether the moved lock was removed.
 */
const removeUnless = (path: string, keep: (holder: Holder | null) => boolean): boolean =>
{
    const aside = `${path}.${randomBytes(6).toString('hex')}.aside`;

    try
    {
        renameSync(path, aside);
    }
    catch
    {
        return false;
    }

    const moved = readHolder(aside);

    if (keep(moved))
    {
        try
        {
            linkSync(aside, path);
        }
        catch
        {
            // A new lock was made in the moment it was aside; that one stands.
        }
    }

    unlinkSync(aside);

    return !keep(moved);
};

export const withRefreshLock = async <T>(server: string, work: () => Promise<T>): Promise<T> =>
{
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });

    const path = lockFile(server);
    const mine: Holder = { pid: process.pid, nonce: randomBytes(12).toString('hex') };
    const until = Date.now() + WAIT_MS;

    for (;;)
    {
        if (tryCreate(path, mine)) break;

        const holder = readHolder(path);

        // A holder that is gone left its lock behind; one that is half-written is being made and is waited for.
        if (holder !== null && !alive(holder.pid)) removeUnless(path, moved => moved === null || alive(moved.pid));

        if (Date.now() > until)
        {
            throw new CliError(EXIT.local, `another self process (pid ${holder?.pid ?? '?'}) is still renewing the sign-in; try again in a moment`);
        }

        await new Promise(resolve => setTimeout(resolve, STEP_MS));
    }

    try
    {
        return await work();
    }
    finally
    {
        removeUnless(path, moved => moved?.nonce !== mine.nonce);
    }
};

/**
 * Run `work` with Ctrl-C and SIGTERM held until it ends: a refresh the server
 * has already answered must reach the keychain, or the next one presents a
 * rotated token and the grant is revoked. A signal that arrived meanwhile ends
 * the process right after.
 */
export const withSignalsHeld = async <T>(work: () => Promise<T>): Promise<T> =>
{
    let received: NodeJS.Signals | undefined;
    const hold = (signal: NodeJS.Signals): void =>
    {
        received = signal;
    };

    process.on('SIGINT', hold);
    process.on('SIGTERM', hold);

    try
    {
        return await work();
    }
    finally
    {
        process.off('SIGINT', hold);
        process.off('SIGTERM', hold);

        if (received !== undefined) process.kill(process.pid, received);
    }
};
