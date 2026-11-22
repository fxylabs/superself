import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, EXIT, usage } from '../errors';

/**
 * This machine's only non-secret setting: the server `self` talks to when no
 * flag or variable names one. Everything about a sign-in — the client, the
 * endpoints, the tokens — is one keychain item (`store.ts`), so there is no
 * second place for it to disagree with.
 *
 * The folder is fixed per user (`~/.config/superself`, `%APPDATA%\superself`):
 * the refresh lock lives there too, and two processes of one person must find
 * the same lock whatever their environment says.
 */

/** The production app. `self login --server <origin>` or `SUPERSELF_SERVER` names another. */
export const DEFAULT_SERVER = 'https://app.superselfs.com';

interface Config
{
    server?: string;
}

export const stateDir = (): string =>
    (process.platform === 'win32' && process.env.APPDATA ? join(process.env.APPDATA, 'superself') : join(homedir(), '.config', 'superself'));

const configFile = (): string => join(stateDir(), 'config.json');

const readConfig = (): Config =>
{
    try
    {
        const parsed = JSON.parse(readFileSync(configFile(), 'utf8')) as Config;

        return typeof parsed.server === 'string' ? { server: parsed.server } : {};
    }
    catch
    {
        return {};
    }
};

/** Written whole through a temporary file and a rename, so a reader never sees half of it. */
export const rememberServer = (server: string): void =>
{
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });

    const temporary = `${configFile()}.${process.pid}.tmp`;

    writeFileSync(temporary, `${JSON.stringify({ server } satisfies Config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, configFile());
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export const isLoopback = (url: URL): boolean => LOOPBACK.has(url.hostname);

/**
 * An origin as `self` keeps it: scheme, host and port. `https`, or `http` on
 * this machine for a server under development — a token is never sent in the
 * clear across a network.
 */
export const normalizeServer = (value: string): string =>
{
    let url: URL;

    try
    {
        url = new URL(value);
    }
    catch
    {
        throw usage(`not a server address: ${value} (give an origin such as ${DEFAULT_SERVER})`);
    }

    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url)))
    {
        throw usage(`not a server address: ${value} (https, or http on localhost)`);
    }

    return url.origin;
};

export interface ChosenServer
{
    server: string;
    /** Whether `--server` named it. A command line this CLI prints for the person repeats it then. */
    byFlag: boolean;
}

/** The server a command talks to: the flag, then `SUPERSELF_SERVER`, then the one `self login` last chose, then production. */
export const chooseServer = (flag: string | undefined): ChosenServer => ({
    server: normalizeServer(flag ?? process.env.SUPERSELF_SERVER ?? readConfig().server ?? DEFAULT_SERVER),
    byFlag: flag !== undefined,
});

/** `self login`, with `--server` when a bare one would sign in somewhere else. */
export const loginCommand = (server: string): string =>
    (chooseServer(undefined).server === server ? 'self login' : `self login --server ${server}`);

/** No sign-in is stored for the server, or the one stored has ended (`reason` says how). */
export const notSignedIn = (server: string, reason?: string): CliError =>
    new CliError(EXIT.refused, `${reason ?? `not signed in to ${server}`}: run ${loginCommand(server)}`);
