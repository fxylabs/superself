/**
 * One process, one command, one exit code — the same codes the `self` inside a
 * Superself runtime answers with, so a script reads both alike.
 *
 * | code | meaning |
 * | --- | --- |
 * | 0 | done |
 * | 2 | the command line was wrong |
 * | 3 | refused: the server said no, or there is no sign-in to use |
 * | 4 | the server could not be reached or did not answer |
 */
export const EXIT = { ok: 0, usage: 2, refused: 3, server: 4 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error whose message is written for the person at the terminal, with the exit code it ends the process by. */
export class CliError extends Error
{
    constructor(readonly code: ExitCode, message: string)
    {
        super(message);
    }
}

export const usage = (message: string): CliError => new CliError(EXIT.usage, message);

/** No sign-in is stored for the server, or the one stored has ended (`reason` says how). */
export const notSignedIn = (server: string, reason?: string): CliError =>
    new CliError(EXIT.refused, reason === undefined
        ? `not signed in to ${server}: run self login`
        : `${reason}; sign in again with self login (${server})`);
