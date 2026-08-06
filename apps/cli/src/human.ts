import { readSync } from "node:fs";

// The record of how a human was verified. It travels in the event payload,
// and the fold refuses to count an approval that does not carry one.
export interface HumanConfirmation
{
    method: "tty";
    challenge: string;
}

interface HumanRefusal
{
    code: string;
    detail: string;
    next: string;
}

// The environment the runner stamps on every child it starts. A process
// carrying one of these is an agent's, and the answer to anything that needs a
// person is already known before a terminal is looked for.
//
// Deliberately not the same list `machine.ts` `sessionToken` reads, and the
// difference is the point: these are set by a runner to declare "no person is
// behind this call", while an agent harness's own session variable marks a
// process the harness started — which is also what a person gets when they
// type a command into that harness's shell. Reading a harness variable here
// would call that person an agent. The two lists answer different questions
// and must not be merged into one.
const ATTEMPT_MARKERS = ["SUPERSELF_SESSION", "SUPERSELF_ATTEMPT_ID"];

export function attemptMarker(): string | undefined
{
    return ATTEMPT_MARKERS.find((name) => process.env[name] !== undefined);
}

// The human gate. What makes this input human is the interactive terminal:
// a process running with piped or scripted stdio never reaches the prompt,
// and no flag, environment variable or event payload substitutes for it.
// The challenge is the short id of the exact commit being approved, typed
// back — so the human states what they are approving, not just that they
// approve.
// `ask` is the sentence that asks for the challenge, supplied by a caller that
// wants the id in it emphasised. This module styles nothing itself — it sits
// below the terminal styling and importing a painter here would point the
// dependency upward — so a caller that wants weight hands the sentence over
// already painted (#264).
export function confirmHuman(subject: string, challenge: string, ask?: string): HumanConfirmation | HumanRefusal
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
    process.stdout.write(`${subject}\n${ask ?? `type ${challenge} to confirm exactly what you are approving`}: `);
    if (typed() !== challenge)
    {
        return {
            code: "human_challenge_failed",
            detail: `the typed confirmation is not ${challenge}, so nothing was approved`,
            next: "run the command again and type the stated challenge, or walk away — no event was recorded"
        };
    }
    return { method: "tty", challenge };
}

// Where the typed answer comes from. Replaceable so a test can drive the
// approved path in-process — without it, the branch that records an approved
// destruction has no way to run at all, since no test can type at a keyboard.
//
// This is not a way past the gate, and it is deliberately the only thing that
// moves. The interactive check above it does not: a process started from a
// command line — an agent's, a script's, a CI job's — gets a fresh module with
// the real keyboard, and faces the terminal test before it ever reaches here.
// Reaching this seam means already running inside the same process, where
// appending to the log directly was possible all along and is what the store's
// own rules forbid.
let typed: () => string = readLine;

export function useTypedAnswer(next: () => string): () => string
{
    const previous = typed;
    typed = next;
    return previous;
}

// A blocking read of fd 0. The command surface is synchronous, and the read
// deliberately bypasses the stream machinery: the raw descriptor is the
// terminal itself.
// A non-blocking stdin answers EAGAIN rather than waiting, and the caller is
// asked to try again — null says exactly that, so no read is mistaken for EOF.
function readChunk(buffer: Buffer): number | null
{
    try
    {
        return readSync(0, buffer, 0, buffer.length, null);
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN")
        {
            return null;
        }
        throw error;
    }
}

function readLine(): string
{
    const buffer = Buffer.alloc(256);
    let line = "";
    for (;;)
    {
        const read = readChunk(buffer);
        if (read === null)
        {
            continue;
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
