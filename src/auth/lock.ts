import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config';

/**
 * One `self` at a time may refresh a server's tokens.
 *
 * Refresh tokens rotate, and presenting one that was already rotated revokes the
 * whole grant on the server: two `self` processes that refresh with the same
 * token sign the person out. So a refresh runs under this lock, and the process
 * that gets it reads the keychain again first — another one may have just
 * refreshed.
 *
 * The lock is a file created with `wx` (it fails when the file exists). It holds
 * a process id and nothing else. A lock older than `STALE_MS` belongs to a
 * process that died holding it and is taken over.
 */
const STALE_MS = 30_000;
const WAIT_MS = 20_000;
const STEP_MS = 100;

const lockFile = (server: string): string =>
    join(configDir(), `refresh-${Buffer.from(server).toString('base64url')}.lock`);

export const withRefreshLock = async <T>(server: string, work: () => Promise<T>): Promise<T> =>
{
    const path = lockFile(server);
    const until = Date.now() + WAIT_MS;

    mkdirSync(configDir(), { recursive: true, mode: 0o700 });

    for (;;)
    {
        if (tryTake(path)) break;
        if (Date.now() > until) throw new Error(`another self process has held the sign-in lock for ${WAIT_MS / 1000}s: ${path}`);

        await new Promise(resolve => setTimeout(resolve, STEP_MS));
    }

    try
    {
        return await work();
    }
    finally
    {
        try
        {
            unlinkSync(path);
        }
        catch
        {
            // Taken over as stale by another process; nothing of ours is left to remove.
        }
    }
};

const tryTake = (path: string): boolean =>
{
    try
    {
        const fd = openSync(path, 'wx', 0o600);

        writeSync(fd, String(process.pid));
        closeSync(fd);

        return true;
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

        removeIfStale(path);

        return false;
    }
};

const removeIfStale = (path: string): void =>
{
    try
    {
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) unlinkSync(path);
    }
    catch
    {
        // Gone between the open and the stat: the next try takes it.
    }
};
