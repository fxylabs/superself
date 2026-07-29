import { statSync } from "node:fs";
import { join } from "node:path";
import { runnerStateDir } from "../machine.js";
import { breakLock, LockHold, lockHolder, lockPath, takeLock } from "./atomic.js";
import { alive } from "./tree.js";
import { CliError } from "../types.js";

// One settler at a time, per attempt.
//
// Everything that runs an attempt's completion gate takes this first: the
// runner finishing its own child, a launcher reporting the exit it watched, the
// supervisor settling an exit nobody was at a terminal for, and a person
// running `self attempt settle` or `self attempt recover`. The gate publishes
// an artifact and appends a report to an append-only synced log, and neither
// can be taken back — so "has this attempt been reported?" and the append that
// answers it have to be one step rather than two, and a second settler has to
// be refused before it starts rather than fenced out halfway through the first
// one's work.
//
// The fence is what makes a takeover safe once it has been decided. This is
// what decides it: fencing alone cannot tell a settlement that crashed from one
// that is running right now, and a supervisor that mints a newer fence over a
// live gate takes an attempt away from the process that was finishing it
// properly.
export const BUSY = Symbol("a settlement of this attempt is already in flight");

const POLL_MS = 100;

// A holder that has sat on the lock this long is not working: a completion gate
// runs a declared validation under the plan's preflight bound, publishes, and
// commits the store, and none of that is a ten minute operation. Past it the
// lock is taken whoever holds it — otherwise a crashed settler whose pid the
// kernel later handed to something unrelated would hold one attempt
// unsettleable for the life of the machine.
const WEDGED_MS = 600_000;

// How long a settler that must go through the gate itself waits for the one in
// front of it. Longer than the window above, so the wait ends by taking an
// abandoned lock rather than by giving up on a lock nobody holds.
const WAIT_MS = WEDGED_MS + 60_000;

export function settlementFile(attempt: string): string
{
    return join(runnerStateDir(), "locks", `settle.${encodeURIComponent(attempt)}`);
}

// For a settler that has to reach the gate: the launcher whose exit report is
// the documented settlement verb, and a person who asked for one by hand. It
// waits for the settlement in front of it and then judges the attempt again
// from what that one left, rather than taking it over mid-gate.
export async function settling<T>(attempt: string, run: () => Promise<T>): Promise<T>
{
    const deadline = Date.now() + WAIT_MS;
    for (;;)
    {
        const held = claim(attempt);
        if (held !== null)
        {
            return await behind(held, run);
        }
        if (Date.now() > deadline)
        {
            throw new CliError(`attempt ${attempt} is being settled by process ${holderPid(attempt) ?? "?"} right now and has been for longer than any completion gate takes — nothing was written`);
        }
        await pause(POLL_MS);
    }
}

// For the supervisor. A tick is a pass over everything, and every attempt it
// finds is one it will judge again in a few seconds: waiting for a settlement
// in flight would stop it reconciling the rest of the machine for the length of
// somebody else's gate, so an attempt that is already being settled is left to
// its settler and reported as held.
export async function trySettling<T>(attempt: string, run: () => Promise<T>): Promise<T | typeof BUSY>
{
    const held = claim(attempt);
    return held === null ? BUSY : await behind(held, run);
}

async function behind<T>(held: LockHold, run: () => Promise<T>): Promise<T>
{
    try
    {
        return await run();
    }
    finally
    {
        held.release();
    }
}

// The lock, or nothing. A lock whose holder is gone is exactly the state the
// supervisor exists for — a settlement that crashed between publishing an
// artifact and recording the report — so it is taken rather than waited on.
function claim(attempt: string): LockHold | null
{
    const file = settlementFile(attempt);
    const held = takeLock(file, String(process.pid));
    if (held !== null)
    {
        return held;
    }
    const token = lockHolder(file);
    if (token === null || !abandoned(file, token))
    {
        return null;
    }
    // Broken only if it is still the lock that was judged: a settler that took
    // it between the judgement and here is working behind a lock of its own.
    return breakLock(file, token) ? takeLock(file, String(process.pid)) : null;
}

function abandoned(file: string, token: string): boolean
{
    const pid = holderOf(token);
    if (pid === null || !alive(pid))
    {
        return true;
    }
    return age(lockPath(file)) > WEDGED_MS;
}

function holderPid(attempt: string): number | null
{
    const token = lockHolder(settlementFile(attempt));
    return token === null ? null : holderOf(token);
}

// The process that took the lock, as its token records it. `takeLock` writes
// the identity it was given followed by a random suffix, and the identity here
// is the pid.
function holderOf(token: string): number | null
{
    const pid = Number.parseInt(token.split(".")[0] ?? "", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
}

// How long the lock has existed. A lock file is created once and never written
// again, so its own timestamp is when its holder took it. A file that has since
// gone is not old — it is free, and the next attempt to take it will say so.
function age(lock: string): number
{
    try
    {
        return Date.now() - statSync(lock).mtimeMs;
    }
    catch
    {
        return 0;
    }
}

function pause(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}
