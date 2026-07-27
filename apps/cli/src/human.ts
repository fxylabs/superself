import { readSync } from "node:fs";

// The record of how a human was verified. It travels in the event payload,
// and the fold refuses to count an approval that does not carry one.
export interface HumanConfirmation
{
    method: "tty";
    challenge: string;
}

export interface HumanRefusal
{
    code: string;
    detail: string;
    next: string;
}

// The human gate. What makes this input human is the interactive terminal:
// a process running with piped or scripted stdio never reaches the prompt,
// and no flag, environment variable or event payload substitutes for it.
// The challenge is the short id of the exact commit being approved, typed
// back — so the human states what they are approving, not just that they
// approve.
export function confirmHuman(subject: string, challenge: string): HumanConfirmation | HumanRefusal
{
    if (!process.stdin.isTTY || !process.stdout.isTTY)
    {
        return {
            code: "human_gate_unavailable",
            detail: `${subject} needs a human at an interactive terminal, and this process has none — ` +
                "piped or scripted input cannot mint a human approval",
            next: "a maintainer runs this command again in their own terminal"
        };
    }
    process.stdout.write(`${subject}\ntype ${challenge} to confirm exactly what you are approving: `);
    if (readLine() !== challenge)
    {
        return {
            code: "human_challenge_failed",
            detail: `the typed confirmation is not ${challenge}, so nothing was approved`,
            next: "run the command again and type the stated challenge, or walk away — no event was recorded"
        };
    }
    return { method: "tty", challenge };
}

// A blocking read of fd 0. The command surface is synchronous, and the read
// deliberately bypasses the stream machinery: the raw descriptor is the
// terminal itself.
function readLine(): string
{
    const buffer = Buffer.alloc(256);
    let line = "";
    for (;;)
    {
        let read: number;
        try
        {
            read = readSync(0, buffer, 0, buffer.length, null);
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code === "EAGAIN")
            {
                continue;
            }
            throw error;
        }
        if (read === 0)
        {
            return line.trim();
        }
        line += buffer.subarray(0, read).toString("utf8");
        const cut = line.indexOf("\n");
        if (cut !== -1)
        {
            return line.slice(0, cut).trim();
        }
    }
}
