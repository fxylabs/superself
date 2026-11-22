import { randomBytes } from 'node:crypto';
import { discoverOAuthServerInfo, exchangeAuthorization, OAuthError, registerClient, startAuthorization } from '@modelcontextprotocol/client';
import { openableUrl, openInBrowser } from '../auth/browser';
import { chooseServer, rememberServer } from '../auth/config';
import { withRefreshLock } from '../auth/lock';
import { openLoopback } from '../auth/loopback';
import { authFetch, AUTH_REQUEST_MS, withTokens } from '../auth/session';
import { deleteSignIn, keptMetadata, readSignIn, revocationEndpoint, writeSignIn } from '../auth/store';
import type { SignIn } from '../auth/store';
import { CliError, EXIT } from '../errors';
import { callTool } from '../mcp';
import { renderWorkspace } from '../render/workspace';
import type { WorkspaceShow } from '../render/workspace';
import { VERSION } from '../version';

/** Both scopes the workspace MCP server offers: reading records and writing them. */
const SCOPES = 'mcp:read mcp:write';

/** How long `self login` waits for the browser. */
const BROWSER_WAIT_MS = 5 * 60_000;

export interface Io
{
    out: (line: string) => void;
    err: (line: string) => void;
}

/** An OAuth refusal is the server's answer (exit 3); anything else on the way is a server not reached (exit 4). */
const fromServer = (step: string, server: string) => (error: unknown): never =>
{
    if (error instanceof CliError) throw error;
    if (OAuthError.isInstance(error)) throw new CliError(EXIT.refused, `${step} was refused: ${error.message}`);

    throw new CliError(EXIT.server, `${server} did not answer the ${step}: ${error instanceof Error ? error.message : String(error)}`);
};

/**
 * `self login [--server <origin>] [--no-browser]`
 *
 * The OAuth 2.1 flow Claude Code uses for the same server: discover the
 * authorization server from the MCP resource, register this machine as a
 * public client (once; reused while a sign-in is stored), open the consent
 * screen with PKCE, catch the answer on a loopback port and exchange the code.
 * The person picks the workspace on the consent screen.
 *
 * What cannot be undone comes last: the keychain is read before the browser
 * opens, so a keychain that refuses refuses before a grant exists; and if the
 * write still fails, the grant just issued is revoked.
 */
export const login = async (flag: string | undefined, browser: boolean, io: Io): Promise<string> =>
{
    const { server } = chooseServer(flag);
    const previous = readSignIn(server);
    const expected = new URL('/mcp', server).href;
    const info = await discoverOAuthServerInfo(expected, { fetchFn: authFetch }).catch(fromServer('sign-in discovery', server));
    const metadata = info.authorizationServerMetadata;
    const resource = info.resourceMetadata?.resource;

    if (metadata === undefined || resource === undefined) throw new CliError(EXIT.server, `${server} does not publish a sign-in for its MCP server`);

    // RFC 9728 §3.3: the tokens go to `resource`, so it must be the server the person named.
    if (new URL(resource).href !== expected) throw new CliError(EXIT.server, `${server} names another server as its resource (${resource}); refusing to sign in`);

    const loopback = await openLoopback();

    try
    {
        const clientId = previous !== null && previous.metadata.issuer === metadata.issuer
            ? previous.clientId
            : (await registerClient(info.authorizationServerUrl, {
                metadata,
                clientMetadata: {
                    client_name: 'Superself CLI',
                    redirect_uris: [loopback.redirectUri],
                    grant_types: ['authorization_code', 'refresh_token'],
                    response_types: ['code'],
                    token_endpoint_auth_method: 'none',
                    software_id: 'superself-cli',
                    software_version: VERSION,
                },
                scope: SCOPES,
                fetchFn: authFetch,
            }).catch(fromServer('client registration', server))).client_id;
        const state = randomBytes(24).toString('base64url');
        const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
            metadata,
            clientInformation: { client_id: clientId },
            redirectUrl: loopback.redirectUri,
            scope: SCOPES,
            state,
            resource,
        });
        const address = openableUrl(authorizationUrl.toString());

        io.err(browser ? 'Opening the browser to sign in. If it does not open, open this address:' : 'Open this address in a browser on this machine to sign in:');
        io.err(`  ${address}`);
        if (browser) openInBrowser(address);

        const { code, iss } = await loopback.wait(state, BROWSER_WAIT_MS);
        const answer = await exchangeAuthorization(info.authorizationServerUrl, {
            metadata,
            clientInformation: { client_id: clientId },
            authorizationCode: code,
            iss,
            codeVerifier,
            redirectUri: loopback.redirectUri,
            resource,
            fetchFn: authFetch,
        }).catch(fromServer('sign-in', server));
        const signIn = withTokens({ resource, clientId, metadata: keptMetadata(metadata) }, answer);

        await withRefreshLock(server, async () =>
        {
            try
            {
                writeSignIn(server, signIn);
            }
            catch (error)
            {
                await revokeAll(signIn).catch(() => undefined);

                throw error;
            }
        });
    }
    finally
    {
        loopback.close();
    }

    rememberServer(server);

    const workspace = await callTool(server, 'workspace_show', {}).then(
        shown => renderWorkspace(shown as WorkspaceShow),
        (error: unknown) => `workspace: not read (${error instanceof Error ? error.message : String(error)})`,
    );

    return [`signed in to ${server}`, workspace].join('\n');
};

/** RFC 7009, to the endpoint the metadata named and nowhere else, within a time limit. */
const revoke = async (endpoint: string, clientId: string, token: string, hint: string): Promise<void> =>
{
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }),
        redirect: 'error',
        signal: AbortSignal.timeout(AUTH_REQUEST_MS),
    });

    if (!response.ok) throw new Error(`the revocation endpoint answered ${response.status}`);
};

const revokeAll = async (signIn: SignIn): Promise<void> =>
{
    const endpoint = revocationEndpoint(signIn.metadata);

    if (endpoint === undefined) throw new Error('the server names no revocation endpoint');

    await revoke(endpoint, signIn.clientId, signIn.refreshToken, 'refresh_token');
    await revoke(endpoint, signIn.clientId, signIn.accessToken, 'access_token');
};

/**
 * `self logout [--server <origin>]`
 *
 * Revoke both tokens at the authorization server, then delete the sign-in from
 * the keychain. The local sign-in is removed either way; a revocation that did
 * not happen is said, and exits 4, because the grant still stands on the server.
 */
export const logout = async (flag: string | undefined): Promise<string> =>
{
    const { server } = chooseServer(flag);
    const signIn = readSignIn(server);

    if (signIn === null) return `not signed in to ${server}`;

    const failed = await revokeAll(signIn).then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));

    deleteSignIn(server);

    if (failed !== null)
    {
        throw new CliError(EXIT.server,
            `signed out on this machine, but ${server} was not told (${failed}): disconnect the Superself CLI in Superself's settings`);
    }

    return `signed out of ${server}`;
};
