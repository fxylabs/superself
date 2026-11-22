import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CliError, EXIT } from '../errors';

/**
 * The redirect the browser comes back to after the consent screen: a server on
 * `127.0.0.1`, on a port the OS hands out, in this process. The authorization
 * server lets the port vary and nothing else, so the host is always spelled
 * `127.0.0.1` and the path always `/callback`. The browser therefore has to run
 * on this machine (or reach this port, e.g. through `ssh -L`).
 */
export interface Callback
{
    code: string;
    /** RFC 9207: the issuer that sent the browser back, checked before the code is spent. */
    iss: string | undefined;
}

export interface Loopback
{
    redirectUri: string;
    /** Resolves with the first callback whose `state` matches; rejects when the authorization server answers an error, or at the timeout. */
    wait: (state: string, timeoutMs: number) => Promise<Callback>;
    close: () => void;
}

const PAGE = (title: string, line: string): string =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + `<body style="font-family:system-ui,sans-serif;margin:3rem"><h1 style="font-size:1.25rem">${title}</h1><p>${line}</p></body>`;

/** The request's target as a URL, or `null` for one that is not — any local process can send anything here. */
const targetOf = (raw: string | undefined): URL | null =>
{
    try
    {
        return new URL(raw ?? '/', 'http://127.0.0.1');
    }
    catch
    {
        return null;
    }
};

export const openLoopback = async (): Promise<Loopback> =>
{
    let deliver: ((url: URL) => boolean) | undefined;

    const server: Server = createServer((request, response) =>
    {
        const url = targetOf(request.url);

        if (url === null || url.pathname !== '/callback' || deliver === undefined || !deliver(url))
        {
            response.writeHead(url === null ? 400 : 404, { 'content-type': 'text/plain' }).end(url === null ? 'bad request' : 'not found');

            return;
        }

        const failed = url.searchParams.has('error');

        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(failed
            ? PAGE('Sign-in was not completed', 'Return to the terminal to see why.')
            : PAGE('Signed in to Superself', 'You can close this tab and return to the terminal.'));
    });

    await new Promise<void>((resolve, reject) =>
    {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const { port } = server.address() as AddressInfo;

    return {
        redirectUri: `http://127.0.0.1:${port}/callback`,
        wait: (state, timeoutMs) => new Promise<Callback>((resolve, reject) =>
        {
            const timer = setTimeout(() => reject(new CliError(EXIT.local,
                `no answer from the browser in ${timeoutMs / 60_000} minutes (the browser has to run on this machine)`)), timeoutMs);

            deliver = (url) =>
            {
                // A request that does not carry this login's state is not this login's answer.
                if (url.searchParams.get('state') !== state) return false;

                clearTimeout(timer);

                const error = url.searchParams.get('error');
                const code = url.searchParams.get('code');

                if (error !== null)
                {
                    const description = url.searchParams.get('error_description');

                    reject(new CliError(EXIT.refused, error === 'access_denied' ? 'the sign-in was declined in the browser'
                        : `the authorization server answered ${error}${description === null ? '' : `: ${description}`}`));
                }
                else if (code === null)
                {
                    reject(new CliError(EXIT.refused, 'the browser came back without a code'));
                }
                else
                {
                    resolve({ code, iss: url.searchParams.get('iss') ?? undefined });
                }

                return true;
            };
        }),
        close: () =>
        {
            server.close();
            server.closeAllConnections();
        },
    };
};
