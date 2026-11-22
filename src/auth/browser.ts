import { spawn } from 'node:child_process';

/**
 * Open a URL in the person's browser. Whether a browser came up cannot be known
 * from here, so the caller always prints the URL as well; a failure to start the
 * opener is swallowed for the same reason.
 */
export const openInBrowser = (url: string): void =>
{
    const [command, args] = process.platform === 'darwin' ? ['open', [url]]
        : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replaceAll('&', '^&')]]
            : ['xdg-open', [url]];

    try
    {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });

        child.on('error', () => undefined);
        child.unref();
    }
    catch
    {
        // No opener on this machine: the printed URL is the way.
    }
};
