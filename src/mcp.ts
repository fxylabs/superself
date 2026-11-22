import { Client, OAuthError, ProtocolError, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { notSignedIn } from './auth/config';
import { authProviderFor } from './auth/session';
import { readSignIn } from './auth/store';
import { CliError, EXIT } from './errors';
import { VERSION } from './version';

/**
 * One command, one tool call on the workspace MCP server, as the person the
 * stored sign-in belongs to. The server is stateless, so each call is its own
 * connection: initialize, call, close.
 */
export const callTool = async (server: string, name: string, args: Record<string, unknown>): Promise<unknown> =>
{
    const signIn = readSignIn(server);

    if (signIn === null) throw notSignedIn(server);

    const transport = new StreamableHTTPClientTransport(new URL(signIn.resource), { authProvider: authProviderFor(server) });
    const client = new Client({ name: 'superself-cli', version: VERSION });

    try
    {
        await client.connect(transport);

        const result = await client.callTool({ name, arguments: args }) as CallToolResult;

        // The server answered, and said no: a refusal it wrote for the caller.
        if (result.isError === true) throw new CliError(EXIT.refused, textOf(result) || `${name} was refused`);

        return result.structuredContent ?? parsed(textOf(result));
    }
    catch (error)
    {
        throw asCliError(error, server);
    }
    finally
    {
        await client.close().catch(() => undefined);
    }
};

const textOf = (result: CallToolResult): string =>
    result.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n');

const parsed = (text: string): unknown =>
{
    try
    {
        return JSON.parse(text);
    }
    catch
    {
        return text;
    }
};

/**
 * A failure by who produced it, not by what it happens to carry:
 *
 * - a `CliError` was thrown where its cause is known (the keychain, the lock, a
 *   sign-in that ended) and keeps its code;
 * - a JSON-RPC error (`ProtocolError`) and an OAuth error are the server's
 *   answer: refused, exit 3, in its words;
 * - an HTTP status: 401 is a sign-in the server will not take, another 4xx a
 *   refusal, a 5xx a server that failed;
 * - anything else — a connection refused, a timeout — is a server not reached.
 */
const asCliError = (error: unknown, server: string): CliError =>
{
    for (let cause: unknown = error; cause !== undefined && cause !== null; cause = (cause as { cause?: unknown }).cause)
    {
        if (cause instanceof CliError) return cause;
    }

    const message = error instanceof Error ? error.message : String(error);

    if (ProtocolError.isInstance(error) || OAuthError.isInstance(error)) return new CliError(EXIT.refused, message);

    if (SdkHttpError.isInstance(error))
    {
        const status = error.data.status;

        if (status === 401) return notSignedIn(server, 'the server did not accept the sign-in');
        if (status >= 400 && status < 500) return new CliError(EXIT.refused, message);
    }

    return new CliError(EXIT.server, `${server} did not answer: ${message}`);
};
