import { OAuthError, refreshAuthorization } from '@modelcontextprotocol/client';
import type { AuthProvider, OAuthTokens } from '@modelcontextprotocol/client';
import { notSignedIn } from '../errors';
import type { ServerEntry } from './config';
import { withRefreshLock } from './lock';
import { deleteTokens, readTokens, writeTokens } from './secret';
import type { Tokens } from './secret';

/**
 * The access token a command presents, kept fresh.
 *
 * An access token lives 8 hours; the refresh token renews it, and it rotates on
 * every use. A token that expires within `MARGIN_MS` is renewed before the
 * request rather than after a 401, and every renewal runs under the refresh
 * lock (`lock.ts`), re-reading the keychain once it holds it.
 */
const MARGIN_MS = 60_000;

/** Tokens as the token endpoint answered them, in the shape the keychain keeps. */
export const tokensFrom = (answer: OAuthTokens, previous?: Tokens): Tokens =>
{
    const refreshToken = answer.refresh_token ?? previous?.refreshToken;

    if (refreshToken === undefined) throw new Error('the authorization server issued no refresh token');

    return {
        accessToken: answer.access_token,
        refreshToken,
        expiresAt: Date.now() + (answer.expires_in ?? 0) * 1000,
        scope: answer.scope ?? previous?.scope ?? '',
    };
};

const fresh = (tokens: Tokens): boolean => tokens.expiresAt - Date.now() > MARGIN_MS;

/**
 * Renew under the lock, unless another process already has: `stale` is the
 * access token this process saw fail or expire, and a different, fresh one in
 * the keychain is that other process's renewal.
 *
 * A refusal from the token endpoint means the grant is over — revoked from the
 * settings, signed out everywhere, or past its 180 days — so the stored tokens
 * are deleted and the person is told to sign in again.
 */
const renew = (server: string, entry: ServerEntry, stale: string): Promise<string> =>
    withRefreshLock(server, async () =>
    {
        const current = readTokens(server);

        if (current === null) throw notSignedIn(server);
        if (current.accessToken !== stale && fresh(current)) return current.accessToken;

        let answer: OAuthTokens;

        try
        {
            answer = await refreshAuthorization(entry.issuer, {
                metadata: entry.metadata,
                clientInformation: { client_id: entry.clientId },
                refreshToken: current.refreshToken,
                resource: entry.resource,
            });
        }
        catch (error)
        {
            if (isGrantRefusal(error))
            {
                deleteTokens(server);

                throw notSignedIn(server, 'the sign-in has ended');
            }

            throw error;
        }

        const renewed = tokensFrom(answer, current);

        writeTokens(server, renewed);

        return renewed.accessToken;
    });

/**
 * `invalid_grant` (and the client being gone) end the sign-in; a network fault or a 5xx does not.
 * The OAuth error code is the SDK error's `code`; its message is the server's description, which names no code.
 */
const ENDING_CODES: readonly string[] = ['invalid_grant', 'invalid_client', 'unauthorized_client'];

const isGrantRefusal = (error: unknown): boolean => OAuthError.isInstance(error) && ENDING_CODES.includes(error.code);

/** The transport's view: a token before every request, and one renewal and retry after a 401. */
export const authProviderFor = (server: string, entry: ServerEntry): AuthProvider =>
{
    let presented: string | undefined;

    return {
        token: async () =>
        {
            const stored = readTokens(server);

            if (stored === null) throw notSignedIn(server);

            presented = fresh(stored) ? stored.accessToken : await renew(server, entry, stored.accessToken);

            return presented;
        },
        onUnauthorized: async () =>
        {
            await renew(server, entry, presented ?? '');
        },
    };
};
