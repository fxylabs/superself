// The machine-local counters — the fence, the boot record, the provider
// breakers — are read, incremented and written back, and several runners on one
// machine is the designed operating mode. withLock is the only thing standing
// between that and two runners minting the same fence.
//
// The interesting half is what happens when a lock outlives its holder. Breaking
// it is necessary, or a process that died holding it freezes the counter for the
// life of the machine. Breaking it wrongly is worse than not breaking it: the
// section runs unlocked, or a holder deletes a lock that now belongs to someone
// else and lets a third process in behind them.
//
// Each case below is a separate process because the wait is synchronous: the
// primitive blocks the event loop on purpose, so nothing else in the same
// process can move while it waits.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withLock } from "../dist/attempt/atomic.js";

const HELD_BY_A_DEAD_PROCESS = "proof-stale-token";

// A holder that is still alive after the whole window, told apart from the
// stale one by the token it wrote.
const A_NEW_HOLDER = "proof-handover-token";

function locked(dir)
{
    return join(dir, "counter.json.lock");
}

// A lock nobody will ever release, standing in for a process that died holding
// one. Written directly rather than through withLock, because a live holder
// would be released by the process that took it.
function abandon(dir, token)
{
    writeFileSync(locked(dir), token);
}

// A lock whose owner is still there after the window: something hands it over
// while this process waits. The rewrite happens from another process because
// the wait blocks this one's event loop.
function handOverDuring(dir)
{
    const rewrite = `require("fs").writeFileSync(${JSON.stringify(locked(dir))}, ${JSON.stringify(A_NEW_HOLDER)})`;
    spawn(process.execPath, ["-e", `setTimeout(() => { ${rewrite}; }, 1000)`], { detached: true, stdio: "ignore" }).unref();
}

function caseStale(dir)
{
    abandon(dir, HELD_BY_A_DEAD_PROCESS);
    let ran = false;
    withLock(join(dir, "counter.json"), () => { ran = true; });
    if (!ran)
    {
        return "a lock held by a dead process was never broken — the counter it guards is frozen for good";
    }
    if (existsSync(locked(dir)))
    {
        return "the lock taken over from a dead process was not released";
    }
    return null;
}

function caseHandover(dir)
{
    abandon(dir, HELD_BY_A_DEAD_PROCESS);
    handOverDuring(dir);
    let ran = false;
    let refused = false;
    try
    {
        withLock(join(dir, "counter.json"), () => { ran = true; });
    }
    catch
    {
        refused = true;
    }
    if (ran)
    {
        return "the critical section ran with no lock at all after the break was lost";
    }
    if (!refused)
    {
        return "losing the break was not reported to the caller";
    }
    if (readFileSync(locked(dir), "utf8") !== A_NEW_HOLDER)
    {
        return "a lock that changed hands during the wait was broken anyway";
    }
    return null;
}

// The other half: a holder whose own lock was broken and retaken must not
// delete the lock that now belongs to the process that broke it. Here the
// takeover is simulated from inside the critical section, which is exactly the
// state a broken-and-retaken lock leaves behind.
function caseRelease(dir)
{
    withLock(join(dir, "counter.json"), () => { writeFileSync(locked(dir), A_NEW_HOLDER); });
    if (!existsSync(locked(dir)))
    {
        return "a holder deleted a lock it no longer owned, letting a third process in behind the one holding it";
    }
    if (readFileSync(locked(dir), "utf8") !== A_NEW_HOLDER)
    {
        return "the lock a waiter had taken was replaced by the previous holder";
    }
    return null;
}

const CASES = { stale: caseStale, handover: caseHandover, release: caseRelease };

const wanted = process.argv[2];
if (wanted !== undefined)
{
    const dir = mkdtempSync(join(tmpdir(), `self-lock-${wanted}-`));
    try
    {
        const failure = CASES[wanted](dir);
        if (failure !== null)
        {
            console.error(`${wanted}: ${failure}`);
        }
        process.exit(failure === null ? 0 : 1);
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
}

// The two cases that wait out the whole window run side by side, so the proof
// costs one window rather than two.
const self = fileURLToPath(import.meta.url);
const running = Object.keys(CASES).map((name) => new Promise((resolve) =>
{
    spawn(process.execPath, [self, name], { stdio: "inherit" }).on("close", (code) => resolve(code === 0));
}));
process.exit((await Promise.all(running)).every((ok) => ok) ? 0 : 1);
