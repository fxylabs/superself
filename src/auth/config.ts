import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/client';
import { usage } from '../errors';

/**
 * What this machine remembers that is not a secret: which server `self` talks
 * to, and for each server the authorization server's metadata, the resource the
 * tokens are for and the OAuth client this machine registered there. The
 * tokens themselves are in the OS keychain (`secret.ts`), never here.
 */

/** The production app. `self login --server <origin>` or `SUPERSELF_SERVER` names another. */
export const DEFAULT_SERVER = 'https://app.superselfs.com';

export interface ServerEntry
{
    /** The MCP resource the tokens are issued for: the server's origin and `/mcp`. */
    resource: string;
    /** The authorization server's issuer, as its metadata names it. */
    issuer: string;
    metadata: AuthorizationServerMetadata;
    /** The client this machine registered; kept while a sign-in stands, forgotten at logout. */
    clientId: string;
}

export interface Config
{
    /** The server `self` talks to when no flag or variable names one. */
    server?: string;
    servers: Record<string, ServerEntry>;
}

/** `$XDG_CONFIG_HOME/superself`, `%APPDATA%\superself` on Windows, else `~/.config/superself`. */
export const configDir = (): string =>
{
    if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'superself');
    if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'superself');

    return join(homedir(), '.config', 'superself');
};

const configFile = (): string => join(configDir(), 'config.json');

export const readConfig = (): Config =>
{
    try
    {
        const parsed = JSON.parse(readFileSync(configFile(), 'utf8')) as Partial<Config>;

        return { server: parsed.server, servers: parsed.servers ?? {} };
    }
    catch
    {
        return { servers: {} };
    }
};

/** Written whole through a temporary file and a rename, so a reader never sees half of it. */
export const writeConfig = (config: Config): void =>
{
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });

    const temporary = `${configFile()}.${process.pid}.tmp`;

    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, configFile());
};

/**
 * An origin as `self` keeps it: scheme, host and port, nothing after. A value
 * that is not an absolute http(s) URL is refused here rather than at the
 * first request.
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
        throw usage(`not a server address: ${value} (give an origin such as https://app.superselfs.com)`);
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw usage(`not a server address: ${value}`);

    return url.origin;
};

/** The server a command talks to: the flag, then `SUPERSELF_SERVER`, then the one `self login` last chose, then production. */
export const serverOf = (flag: string | undefined, config: Config): string =>
    normalizeServer(flag ?? process.env.SUPERSELF_SERVER ?? config.server ?? DEFAULT_SERVER);
