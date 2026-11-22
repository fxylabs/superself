/**
 * One process, one command, one exit code. 0, 2, 3 and 4 mean what they mean
 * for the `self` inside a Superself runtime, so a script reads both alike; 1 is
 * this machine's own failure, which a runtime does not have.
 *
 * | code | meaning |
 * | --- | --- |
 * | 0 | done |
 * | 1 | this machine could not do it: the keychain refused, the sign-in lock was held, the browser never came back |
 * | 2 | the command line was wrong |
 * | 3 | refused: the server said no, the sign-in was declined, or there is no sign-in to use |
 * | 4 | the server could not be reached or did not answer |
 */
export const EXIT = { ok: 0, local: 1, usage: 2, refused: 3, server: 4 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error whose message is written for the person at the terminal, with the exit code it ends the process by. Thrown where the failure is known. */
export class CliError extends Error
{
    constructor(readonly code: ExitCode, message: string)
    {
        super(message);
    }
}

export const usage = (message: string): CliError => new CliError(EXIT.usage, message);
