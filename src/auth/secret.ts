import { Entry } from '@napi-rs/keyring';

/**
 * The tokens of one server, kept in the OS keychain: the macOS Keychain, the
 * Windows Credential Manager, or the Secret Service on Linux. One item per
 * server origin, under the service name `superself`.
 *
 * Nothing here prints, logs or writes a token anywhere else; an error names the
 * keychain, never what was in it.
 */
export interface Tokens
{
    accessToken: string;
    refreshToken: string;
    /** Milliseconds since the epoch. */
    expiresAt: number;
    scope: string;
}

const SERVICE = 'superself';

const entryOf = (server: string): Entry => new Entry(SERVICE, server);

export const readTokens = (server: string): Tokens | null =>
{
    const stored = keychain(() => entryOf(server).getPassword());

    if (stored === null) return null;

    try
    {
        const parsed = JSON.parse(stored) as Partial<Tokens>;

        if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string' || typeof parsed.expiresAt !== 'number')
        {
            return null;
        }

        return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt, scope: parsed.scope ?? '' };
    }
    catch
    {
        return null;
    }
};

export const writeTokens = (server: string, tokens: Tokens): void =>
{
    keychain(() => entryOf(server).setPassword(JSON.stringify(tokens)));
};

export const deleteTokens = (server: string): void =>
{
    keychain(() => entryOf(server).deletePassword());
};

/** A keychain that refuses (locked, no Secret Service running) is named as such; its own message may echo nothing secret, but it is not relayed. */
const keychain = <T>(work: () => T): T =>
{
    try
    {
        return work();
    }
    catch
    {
        throw new Error('the OS keychain refused the request (is it locked, or is no keychain service running?)');
    }
};
