import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The redirect the browser comes back to after the consent screen: a server on
 * `127.0.0.1`, on a port the OS hands out. The authorization server lets the
 * port vary and nothing else, so the host is always spelled `127.0.0.1` and the
 * path always `/callback`.
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
    /** Resolves with the first callback whose `state` matches; rejects on an OAuth error or the timeout. */
    wait: (state: string, timeoutMs: number) => Promise<Callback>;
    close: () => void;
}

const PAGE = (title: string, line: string): string =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + `<body style="font-family:system-ui,sans-serif;margin:3rem"><h1 style="font-size:1.25rem">${title}</h1><p>${line}</p></body>`;

export const openLoopback = async (): Promise<Loopback> =>
{
    let deliver: ((url: URL) => boolean) | undefined;

    const server: Server = createServer((request, response) =>
    {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');

        if (url.pathname !== '/callback' || deliver === undefined || !deliver(url))
        {
            response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');

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
            const timer = setTimeout(() => reject(new Error(`no answer from the browser in ${timeoutMs / 60_000} minutes`)), timeoutMs);

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

                    reject(new Error(error === 'access_denied' ? 'the sign-in was declined in the browser'
                        : `the authorization server answered ${error}${description === null ? '' : `: ${description}`}`));
                }
                else if (code === null)
                {
                    reject(new Error('the browser came back without a code'));
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
