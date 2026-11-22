import { Entry } from '@napi-rs/keyring';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/client';
import { CliError, EXIT } from '../errors';

/**
 * One sign-in, whole, in the OS keychain: the macOS Keychain, the Windows
 * Credential Manager, or the Secret Service on Linux. One item per server
 * origin, service name `superself`.
 *
 * The client id and the endpoints sit beside the tokens because they are one
 * fact: a refresh token is only good with the client it was issued to, so the
 * two are written and deleted together and can never come from different
 * logins.
 *
 * Nothing here prints, logs or writes a token anywhere else; an error names the
 * keychain, never what was in it.
 */
export interface SignIn
{
    /** The MCP resource the tokens are for: the server's origin and `/mcp`. */
    resource: string;
    clientId: string;
    /** What a refresh and a revocation need of the authorization server's metadata. */
    metadata: AuthorizationServerMetadata;
    accessToken: string;
    refreshToken: string;
    /** Milliseconds since the epoch. */
    expiresAt: number;
    scope: string;
}

const SERVICE = 'superself';

/**
 * On Linux the library would fall back to the kernel keyring, which forgets
 * everything at reboot; the Secret Service is required, and its absence is said.
 */
const entryOf = (server: string): Entry => new Entry(SERVICE, server, { linux: { store: 'secret-service' } });

const keychain = <T>(work: () => T): T =>
{
    try
    {
        return work();
    }
    catch
    {
        throw new CliError(EXIT.local, 'the OS keychain refused the request (is it locked? on Linux, is a Secret Service such as GNOME Keyring running?)');
    }
};

const isSignIn = (value: Partial<SignIn>): value is SignIn =>
    typeof value.resource === 'string' && typeof value.clientId === 'string' && typeof value.metadata === 'object' && value.metadata !== null
    && typeof value.accessToken === 'string' && typeof value.refreshToken === 'string' && typeof value.expiresAt === 'number';

/** The stored sign-in, or `null` when there is none or it is not one this version wrote. A keychain that cannot be read throws. */
export const readSignIn = (server: string): SignIn | null =>
{
    const stored = keychain(() => entryOf(server).getPassword());

    if (stored === null) return null;

    try
    {
        const parsed = JSON.parse(stored) as Partial<SignIn>;

        return isSignIn(parsed) ? { ...parsed, scope: parsed.scope ?? '' } : null;
    }
    catch
    {
        return null;
    }
};

export const writeSignIn = (server: string, signIn: SignIn): void =>
{
    keychain(() => entryOf(server).setPassword(JSON.stringify(signIn)));
};

export const deleteSignIn = (server: string): void =>
{
    keychain(() => entryOf(server).deletePassword());
};

/**
 * The metadata fields a refresh and a revocation read, and no more: the item
 * stays small (Windows caps a credential at 2,560 bytes).
 */
export const keptMetadata = (metadata: AuthorizationServerMetadata): AuthorizationServerMetadata =>
{
    const { issuer, authorization_endpoint, token_endpoint, response_types_supported } = metadata;
    const rest = metadata as { revocation_endpoint?: string; token_endpoint_auth_methods_supported?: string[] };

    return {
        issuer, authorization_endpoint, token_endpoint, response_types_supported,
        ...(rest.revocation_endpoint === undefined ? {} : { revocation_endpoint: rest.revocation_endpoint }),
        ...(rest.token_endpoint_auth_methods_supported === undefined ? {} : { token_endpoint_auth_methods_supported: rest.token_endpoint_auth_methods_supported }),
    } as AuthorizationServerMetadata;
};

/** RFC 8414 names it; the SDK's type is the union with OpenID's metadata, which does not. */
export const revocationEndpoint = (metadata: AuthorizationServerMetadata): string | undefined =>
    (metadata as { revocation_endpoint?: string }).revocation_endpoint;
