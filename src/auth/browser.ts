import { spawn } from 'node:child_process';
import { CliError, EXIT } from '../errors';
import { isLoopback } from './config';

/**
 * Open an address the server gave in the person's browser.
 *
 * The address comes from the server, so it is checked before anything runs it:
 * `https`, or `http` on this machine, and on the server's own origin when
 * `origin` is given. It is handed to the opener as one argument — on Windows to
 * `rundll32 url.dll,FileProtocolHandler`, which parses no shell syntax, not to
 * `cmd /c start`, which would.
 *
 * Whether a browser came up cannot be known from here, so the caller always
 * prints the address as well, and a failure to start the opener is not an error.
 */
export const openableUrl = (address: string, origin?: string): string =>
{
    let url: URL;

    try
    {
        url = new URL(address);
    }
    catch
    {
        throw new CliError(EXIT.server, `the server gave an address that is not a URL: ${address}`);
    }

    const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url));

    if (!scheme || (origin !== undefined && url.origin !== origin))
    {
        throw new CliError(EXIT.server, `refusing to open an address the server gave: ${url.origin}${origin === undefined ? '' : ` (expected ${origin})`}`);
    }

    return url.toString();
};

export const openInBrowser = (url: string): void =>
{
    const [command, args] = process.platform === 'darwin' ? ['open', [url]]
        : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
            : ['xdg-open', [url]];

    try
    {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });

        child.on('error', () => undefined);
        child.unref();
    }
    catch
    {
        // No opener on this machine: the printed address is the way.
    }
};
