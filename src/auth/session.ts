import { OAuthError, refreshAuthorization } from '@modelcontextprotocol/client';
import type { AuthProvider, FetchLike, OAuthTokens } from '@modelcontextprotocol/client';
import { CliError, EXIT } from '../errors';
import { notSignedIn } from './config';
import { withRefreshLock, withSignalsHeld } from './lock';
import { deleteSignIn, readSignIn, writeSignIn } from './store';
import type { SignIn } from './store';

/**
 * The access token a command presents, kept fresh.
 *
 * An access token lives 8 hours; the refresh token renews it, and it rotates on
 * every use. A token that expires within `MARGIN_MS` is renewed before the
 * request rather than after a 401, and every renewal runs under the refresh
 * lock, re-reading the keychain once it holds it.
 */
const MARGIN_MS = 60_000;

/** How long a request to the authorization server may take. The refresh lock is held meanwhile. */
export const AUTH_REQUEST_MS = 15_000;

/** `fetch` with a time limit and no redirects: a token request goes to the endpoint the metadata names, nowhere else. */
export const authFetch: FetchLike = (url, init) =>
    fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(AUTH_REQUEST_MS) });

/** The token fields of a token endpoint's answer, onto the sign-in they renew. */
export const withTokens = (base: Omit<SignIn, 'accessToken' | 'refreshToken' | 'expiresAt' | 'scope'> & Partial<SignIn>, answer: OAuthTokens): SignIn =>
{
    const refreshToken = answer.refresh_token ?? base.refreshToken;

    if (refreshToken === undefined) throw new CliError(EXIT.refused, 'the authorization server issued no refresh token');

    return {
        ...base,
        accessToken: answer.access_token,
        refreshToken,
        expiresAt: Date.now() + (answer.expires_in ?? 0) * 1000,
        scope: answer.scope ?? base.scope ?? '',
    };
};

const fresh = (signIn: SignIn): boolean => signIn.expiresAt - Date.now() > MARGIN_MS;

/**
 * `invalid_grant` (and the client being gone) end the sign-in; a network fault or a 5xx does not.
 * The OAuth error code is the SDK error's `code`; its message is the server's description, which names no code.
 */
const ENDING_CODES: readonly string[] = ['invalid_grant', 'invalid_client', 'unauthorized_client'];

const endsSignIn = (error: unknown): boolean => OAuthError.isInstance(error) && ENDING_CODES.includes(error.code);

/**
 * Renew under the lock, unless another process already has: `stale` is the
 * access token this process saw fail or expire, and a different, fresh one in
 * the keychain is that other process's renewal.
 *
 * Once the request is sent, the answer must reach the keychain: signals are
 * held until it is written. A refusal from the token endpoint means the grant
 * is over — disconnected in the settings, signed out everywhere, or past its
 * 180 days — so the stored sign-in is deleted.
 */
const renew = (server: string, stale: string): Promise<string> =>
    withRefreshLock(server, async () =>
    {
        const current = readSignIn(server);

        if (current === null) throw notSignedIn(server);
        if (current.accessToken !== stale && fresh(current)) return current.accessToken;

        return await withSignalsHeld(async () =>
        {
            let answer: OAuthTokens;

            try
            {
                answer = await refreshAuthorization(current.metadata.issuer, {
                    metadata: current.metadata,
                    clientInformation: { client_id: current.clientId },
                    refreshToken: current.refreshToken,
                    resource: current.resource,
                    fetchFn: authFetch,
                });
            }
            catch (error)
            {
                if (!endsSignIn(error)) throw error;

                deleteSignIn(server);

                throw notSignedIn(server, 'the sign-in has ended (disconnected, signed out elsewhere, or past 180 days)');
            }

            const renewed = withTokens(current, answer);

            writeSignIn(server, renewed);

            return renewed.accessToken;
        });
    });

/** The transport's view: a token before every request, and one renewal and retry after a 401. */
export const authProviderFor = (server: string): AuthProvider =>
{
    let presented: string | undefined;

    return {
        token: async () =>
        {
            const stored = readSignIn(server);

            if (stored === null) throw notSignedIn(server);

            presented = fresh(stored) ? stored.accessToken : await renew(server, stored.accessToken);

            return presented;
        },
        onUnauthorized: async () =>
        {
            await renew(server, presented ?? '');
        },
    };
};
