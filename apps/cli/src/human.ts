import { execFileSync } from "node:child_process";
import { readSync } from "node:fs";
import { sessionToken } from "./machine.js";

// The record of how a human was verified. It travels in the event payload of
// the one act that still asks for one — `artifact prune` — so the log says the
// bytes left under an answer somebody typed rather than under a flag any
// process can set.
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

function attemptMarker(): string | undefined
{
    return ATTEMPT_MARKERS.find((name) => process.env[name] !== undefined);
}

// Whether a person is at this process's keyboard. The one answer to "is
// anybody there": a runner stamps an attempt marker on every child it starts,
// and a scripted or piped stdin never had a person behind it.
//
// stdin alone, deliberately. `stdout.isTTY` belongs to the gates that print a
// question and read the answer back, and this one prints nothing — what makes
// it a person is a keyboard, and stdout is not the keyboard. Reading it here
// would refuse a person for redirecting their own output.
export function personAtTerminal(): boolean
{
    return attemptMarker() === undefined && process.stdin.isTTY === true;
}

// Who wrote a record (#400). The verbs whose record `self undo` takes back no
// longer refuse a process with nobody behind it: the consent they asked for was
// given in the conversation the session is having, and a person retyping the
// command adds nothing to it except a chance to mistype. What replaces the
// refusal is this — the record states which kind of caller wrote it, so a
// reader is told rather than guaranteed.
//
// It answers cooperating callers, exactly as the gate it replaces did. A
// process that unsets the marker and allocates a pty writes `person`; that was
// as true of the refusal, and #400 does not change the trust model.
export interface WrittenBy
{
    kind: "person" | "agent";
    // Which session, on the terms `machine.ts` already sets: it separates one
    // session from another and names nobody.
    //
    // Not the same fact as `origin.session`, which every event carries. That
    // one answers "which process wrote this line", and a person typing into an
    // agent harness's shell has one — the case `machine.ts` and the marker list
    // above both exist to keep apart. This one is that value read through
    // "was anybody home": a person's call carries no session, however much the
    // harness around them had one, and an absent field says that better than an
    // empty string would.
    session?: string;
    // The name a verb was given for whoever asked — `runbook approve --by`.
    // It rides here rather than beside it, because who approved and what kind
    // of process recorded it are one statement about one event.
    name?: string;
}

export function writtenBy(name?: string): WrittenBy
{
    const person = personAtTerminal();
    const session = person ? undefined : sessionToken();
    return {
        kind: person ? "person" : "agent",
        ...(session === undefined ? {} : { session }),
        ...(name === undefined ? {} : { name })
    };
}

// Whether this process may ask a question at all: somebody at the keyboard, and
// a screen for the question to appear on. Both ends, unlike `personAtTerminal`
// above — that one answers "did a person write this", and a question whose text
// goes down a pipe is one nobody can see themselves being asked.
export function atKeyboard(): boolean
{
    return personAtTerminal() && process.stdout.isTTY === true;
}

// A question whose answer decides what the command does next, asked on the same
// line it is answered on. The gate below asks a person to confirm something
// this CLI already knows it is about to do; this one asks a person to choose,
// and the command has nothing to say until they have.
//
// It checks no terminal itself. Every caller has already decided that asking is
// possible — the alternative is not a default but a refusal naming the flag
// that answers the question without a person, and only the caller knows which
// flag that is.
export function askLine(question: string): string
{
    process.stdout.write(question);
    return typed();
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

// EAGAIN means a prior process left fd 0 with O_NONBLOCK set. Input still
// arrives when typed, but a bare retry spins a core for the whole wait — so
// each empty read pauses briefly before asking again (#309). Atomics.wait is
// the synchronous sleep: nothing else can wake this array, so the timeout is
// the whole story.
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

// The terminal's own state is the other way the gate can present as frozen: a
// process that died mid-raw-mode leaves echo off, and the challenge is then
// typed into what looks like a hung prompt (#309). stty on the inherited fd 0
// reads and sets that state directly; a terminal it cannot describe is used
// as found, which is exactly the behaviour before this existed.
function ttyState(): string | null
{
    try
    {
        return execFileSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"] }).toString().trim();
    }
    catch
    {
        return null;
    }
}

function setTtyState(state: string): void
{
    try
    {
        execFileSync("stty", [state], { stdio: ["inherit", "ignore", "ignore"] });
    }
    catch
    {
        // A state that cannot be applied changes nothing — the read below
        // works either way, it just may not echo.
    }
}

function collectLine(): string
{
    const buffer = Buffer.alloc(256);
    let line = "";
    for (;;)
    {
        const read = readChunk(buffer);
        if (read === null)
        {
            Atomics.wait(PAUSE, 0, 0, 25);
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

function readLine(): string
{
    const found = ttyState();
    if (found !== null)
    {
        setTtyState("sane");
    }
    try
    {
        return collectLine();
    }
    finally
    {
        if (found !== null)
        {
            setTtyState(found);
        }
    }
}
