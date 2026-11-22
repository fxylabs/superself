import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { readConfig, serverOf } from './auth/config';
import type { ServerEntry } from './auth/config';
import { authProviderFor } from './auth/session';
import { readTokens } from './auth/secret';
import { CliError, EXIT, notSignedIn } from './errors';
import { VERSION } from './version';

/**
 * One command, one tool call on the workspace MCP server, as the person the
 * stored sign-in belongs to. The server is stateless, so each call is its own
 * connection: initialize, call, close.
 */

/** The server a command talks to, and what this machine keeps for it — or the instruction to sign in. */
export const signedInServer = (flag: string | undefined): { server: string; entry: ServerEntry } =>
{
    const config = readConfig();
    const server = serverOf(flag, config);
    const entry = config.servers[server];

    if (entry === undefined || readTokens(server) === null) throw notSignedIn(server);

    return { server, entry };
};

export const callTool = async (server: string, entry: ServerEntry, name: string, args: Record<string, unknown>): Promise<unknown> =>
{
    const transport = new StreamableHTTPClientTransport(new URL(entry.resource), { authProvider: authProviderFor(server, entry) });
    const client = new Client({ name: 'superself-cli', version: VERSION });

    try
    {
        await client.connect(transport);

        const result = await client.callTool({ name, arguments: args }) as CallToolResult;

        if (result.isError === true) throw new CliError(EXIT.refused, textOf(result) || `${name} failed`);

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
 * What the person is told when a call fails. A refusal the server wrote for the
 * caller (a key no record has, a state that does not allow the command) is
 * shown in its own words with exit 3; a server that cannot be reached, or
 * answers 5xx, is exit 4.
 */
const asCliError = (error: unknown, server: string): CliError =>
{
    for (let cause: unknown = error; cause !== undefined && cause !== null; cause = (cause as { cause?: unknown }).cause)
    {
        if (cause instanceof CliError) return cause;
    }

    const message = error instanceof Error ? error.message : String(error);
    const status = statusOf(error);
    const words = serverWords(message);

    if (status === 401) return notSignedIn(server, 'the sign-in was refused');
    if (status !== undefined && status >= 400 && status < 500) return new CliError(EXIT.refused, words ?? message);
    if (words !== undefined && status === undefined) return new CliError(EXIT.refused, words);

    return new CliError(EXIT.server, `${server} did not answer: ${message}`);
};

const statusOf = (error: unknown): number | undefined =>
{
    const candidate = error as { status?: unknown; code?: unknown; data?: { status?: unknown } };

    if (typeof candidate.status === 'number') return candidate.status;
    if (typeof candidate.data?.status === 'number') return candidate.data.status;

    return undefined;
};

/** The `message` of a JSON-RPC error the server sent, when the SDK's error carries its body. */
const serverWords = (message: string): string | undefined =>
{
    const start = message.indexOf('{');

    if (start === -1) return undefined;

    try
    {
        const body = JSON.parse(message.slice(start)) as { error?: { message?: unknown } };

        return typeof body.error?.message === 'string' ? body.error.message : undefined;
    }
    catch
    {
        return undefined;
    }
};
