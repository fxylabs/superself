import { randomBytes } from 'node:crypto';
import { discoverOAuthServerInfo, exchangeAuthorization, registerClient, startAuthorization } from '@modelcontextprotocol/client';
import { openInBrowser } from '../auth/browser';
import { readConfig, serverOf, writeConfig } from '../auth/config';
import type { ServerEntry } from '../auth/config';
import { openLoopback } from '../auth/loopback';
import { deleteTokens, readTokens, writeTokens } from '../auth/secret';
import { tokensFrom } from '../auth/session';
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

/**
 * `self login [--server <origin>] [--no-browser]`
 *
 * The OAuth 2.1 flow Claude Code uses for the same server: discover the
 * authorization server from the MCP resource, register this machine as a
 * public client (once; the registration is reused while a sign-in stands),
 * open the consent screen with PKCE, catch the answer on a loopback port and
 * exchange the code. The person picks the workspace on the consent screen.
 * The tokens go to the OS keychain and nowhere else.
 */
export const login = async (flag: string | undefined, browser: boolean, io: Io): Promise<string> =>
{
    const config = readConfig();
    const server = serverOf(flag, config);
    const info = await discoverOAuthServerInfo(new URL('/mcp', server)).catch((error: unknown) =>
    {
        throw new CliError(EXIT.server, `${server} did not answer the sign-in discovery: ${error instanceof Error ? error.message : String(error)}`);
    });
    const metadata = info.authorizationServerMetadata;
    const resource = info.resourceMetadata?.resource;

    if (metadata === undefined || resource === undefined)
    {
        throw new CliError(EXIT.server, `${server} does not publish a sign-in for its MCP server`);
    }

    const loopback = await openLoopback();

    try
    {
        const known = config.servers[server];
        const clientId = known !== undefined && known.issuer === metadata.issuer
            ? known.clientId
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
            })).client_id;
        const state = randomBytes(24).toString('base64url');
        const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
            metadata,
            clientInformation: { client_id: clientId },
            redirectUrl: loopback.redirectUri,
            scope: SCOPES,
            state,
            resource,
        });

        io.err(browser ? 'Opening the browser to sign in. If it does not open, open this address:' : 'Open this address in a browser to sign in:');
        io.err(`  ${authorizationUrl.toString()}`);
        if (browser) openInBrowser(authorizationUrl.toString());

        const { code, iss } = await loopback.wait(state, BROWSER_WAIT_MS);
        const answer = await exchangeAuthorization(info.authorizationServerUrl, {
            metadata,
            clientInformation: { client_id: clientId },
            authorizationCode: code,
            iss,
            codeVerifier,
            redirectUri: loopback.redirectUri,
            resource,
        });
        const entry: ServerEntry = { resource, issuer: metadata.issuer, metadata, clientId };

        writeTokens(server, tokensFrom(answer));
        writeConfig({ server, servers: { ...config.servers, [server]: entry } });

        const shown = await callTool(server, entry, 'workspace_show', {}) as WorkspaceShow;

        return [`signed in to ${server}`, renderWorkspace(shown)].join('\n');
    }
    finally
    {
        loopback.close();
    }
};

/**
 * `self logout [--server <origin>]`
 *
 * Revoke both tokens at the authorization server (RFC 7009), then delete them
 * from the keychain and forget the client registration. A revocation that does
 * not reach the server is said, and the local sign-in is removed all the same.
 */
export const logout = async (flag: string | undefined): Promise<string> =>
{
    const config = readConfig();
    const server = serverOf(flag, config);
    const entry = config.servers[server];
    const tokens = readTokens(server);

    if (entry === undefined && tokens === null) return `not signed in to ${server}`;

    const lines: string[] = [];
    // RFC 8414 names it; the SDK's type is the union with OpenID's metadata, which does not.
    const endpoint = entry === undefined ? undefined : (entry.metadata as { revocation_endpoint?: string }).revocation_endpoint;

    if (tokens !== null && entry !== undefined && endpoint !== undefined)
    {
        const failed = await revoke(endpoint, entry.clientId, tokens.refreshToken, 'refresh_token')
            .then(() => revoke(endpoint, entry.clientId, tokens.accessToken, 'access_token'))
            .then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));

        if (failed !== null) lines.push(`the server was not told (${failed}); disconnect this CLI in Settings, Connected Agents`);
    }

    deleteTokens(server);

    const { [server]: _forgotten, ...servers } = config.servers;

    writeConfig({ server: config.server, servers });
    lines.push(`signed out of ${server}`);

    return lines.join('\n');
};

const revoke = async (endpoint: string, clientId: string, token: string, hint: string): Promise<void> =>
{
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }),
    });

    if (!response.ok) throw new Error(`revocation answered ${response.status}`);
};
