import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { bootId, nodeId } from "../attempt/boundary.js";
import { sleep } from "../attempt/retry.js";
import { alive, processStartTime } from "../attempt/tree.js";
import { ProjectContext } from "../paths.js";
import { CliError } from "../types.js";
import { claimDaemon, claimUnderLock, daemonDir, DaemonRecord, emptyCounts, liveDaemon, readDaemon, refusal, releaseDaemon, withDaemonLock, withTickLock, writeTick } from "./state.js";
import { runTick, TickSummary } from "./tick.js";
import { cliEntry } from "./wake.js";

export const DEFAULT_INTERVAL_MS = 5_000;

// The signals a terminal or a service manager stops a daemon with. Both are
// answered the same way: the tick in flight finishes, and the loop stops
// before the next one — a supervisor killed between publishing an artifact and
// recording the report would leave exactly the half-settled attempt it exists
// to reconcile.
const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

// How long `stop` waits for the loop to come out of the tick it is in before
// it reports that the process is still there.
const STOP_TIMEOUT_MS = 30_000;
const STOP_POLL_MS = 100;

export async function runLoop(ctx: ProjectContext, intervalMs: number): Promise<void>
{
    const record: DaemonRecord = {
        pid: process.pid,
        startedAt: processStartTime(process.pid),
        project: ctx.project,
        projectDir: ctx.projectDir,
        nodeId: nodeId(),
        bootId: bootId(),
        started: new Date().toISOString(),
        intervalMs
    };
    claimDaemon(record);
    let stopping = false;
    const handlers = STOP_SIGNALS.map((signal): [NodeJS.Signals, () => void] => [signal, () => { stopping = true; }]);
    handlers.forEach(([signal, handler]) => process.on(signal, handler));
    try
    {
        let failures = 0;
        while (!stopping)
        {
            // A tick that throws must not end the loop, and the loop is the
            // only place that can hold to it: `tickOnce` rethrows so the
            // foreground `self daemon tick` still exits non-zero on a failure a
            // person asked for. The machine this supervises is exactly the
            // machine where a filesystem fills, a lock is contended, or two
            // settlers race, and a supervisor that exits on the first of those
            // stops reconciling everything else too — the failure is recorded
            // where `self daemon status` reads it, and the next tick runs.
            try
            {
                console.log(line(await tickOnce(ctx)));
                failures = 0;
            }
            catch (error)
            {
                failures++;
                console.error(`${new Date().toISOString()}  ${(error as Error).message} (${failures} in a row) — supervision continues`);
            }
            // Split into short waits so a stop arriving early in the interval
            // is answered then, rather than one whole interval later.
            for (let waited = 0; waited < intervalMs && !stopping; waited += STOP_POLL_MS)
            {
                await sleep(Math.min(STOP_POLL_MS, intervalMs - waited));
            }
        }
    }
    finally
    {
        handlers.forEach(([signal, handler]) => process.removeListener(signal, handler));
        releaseDaemon(process.pid);
    }
}

// One tick, and the record of it, whatever it did. A tick that throws must not
// end the loop: the machine it supervises is exactly the machine where a
// filesystem or a provider can fail, and a supervisor that exits on the first
// of them stops reconciling everything else too. What went wrong is kept on
// the record `self daemon status` reads.
//
// Every tick goes through the same mutex, whether the loop asked for it or a
// person did. The concurrency cap, the window's spend and the live-attempt
// count are all read before anything this tick dispatches has claimed its work,
// so a second tick running beside this one would decide against a picture that
// is already out of date and wake past the cap — the one thing the policy says
// it will not do.
export async function tickOnce(ctx: ProjectContext): Promise<TickSummary>
{
    return withTickLock(() => tickUnderLock(ctx));
}

async function tickUnderLock(ctx: ProjectContext): Promise<TickSummary>
{
    const now = new Date();
    try
    {
        const summary = await runTick(ctx, now);
        writeTick(summary, now);
        return summary;
    }
    catch (error)
    {
        const failed = (error as Error).message;
        const ticks = noteFailure(now, failed);
        throw new CliError(ticks === null ? `a tick failed: ${failed}` : `tick ${ticks} failed: ${failed}`);
    }
}

// The failed tick, on the record `status` reads. What can fail here is the
// write itself — an unwritable state directory is one of the reasons a tick
// fails in the first place — and the reason the tick failed must survive that:
// it travels in the error either way, and the loop puts it in the daemon log.
function noteFailure(now: Date, failed: string): number | null
{
    try
    {
        return writeTick(emptyCounts(), now, failed).ticks;
    }
    catch
    {
        return null;
    }
}

export function line(summary: TickSummary): string
{
    return `${summary.at}  live ${summary.live}  settled ${summary.settled}  unreconciled ${summary.unreconciled}`
        + `  held ${summary.held}  released ${summary.released}  woken ${summary.woken}  deferred ${summary.deferred}`;
}

// The loop, put behind the command that started it. What is detached is this
// same CLI running the loop in its own process group, so nothing about the
// supervisor depends on the terminal that started it staying open.
export function startDetached(ctx: ProjectContext, intervalMs: number): DaemonRecord
{
    mkdirSync(daemonDir(), { recursive: true });
    // The refusal, the launch and the record are one step. Two `start`s that
    // both read "nothing is running" would otherwise both launch, and the one
    // that lost the claim would leave a supervisor behind that no `stop` names.
    return withDaemonLock(() =>
    {
        const held = liveDaemon();
        if (held !== null)
        {
            throw new CliError(refusal(held));
        }
        const log = openSync(join(daemonDir(), "daemon.log"), "a");
        const child = spawn(process.execPath, [cliEntry(), "daemon", "start", "--foreground", "--interval", String(intervalMs)], {
            cwd: ctx.projectDir,
            stdio: ["ignore", log, log],
            detached: true
        });
        child.unref();
        if (child.pid === undefined)
        {
            throw new CliError("the daemon process could not be started");
        }
        const record: DaemonRecord = {
            pid: child.pid,
            // Read here, while the process that was just started is there to be
            // read: the identity that tells this supervisor from whatever the
            // kernel hands its number to next has to be recorded with the
            // number, or there is nothing to compare against later.
            startedAt: processStartTime(child.pid),
            project: ctx.project,
            projectDir: ctx.projectDir,
            nodeId: nodeId(),
            bootId: bootId(),
            started: new Date().toISOString(),
            intervalMs
        };
        // Recorded here rather than by the child, so a second `start` is
        // refused by the pid this one just took — the child claims the same
        // pid a moment later and finds its own record already there.
        claimUnderLock(record);
        return record;
    });
}

export async function stopDaemon(): Promise<string>
{
    const held = liveDaemon();
    if (held === null)
    {
        const stale = readDaemon();
        releaseDaemon(stale?.pid ?? 0);
        return stale === null ? "no self daemon is running on this machine" : `no self daemon is running — the record process ${stale.pid} left behind was cleared`;
    }
    process.kill(held.pid, "SIGTERM");
    for (let waited = 0; waited < STOP_TIMEOUT_MS; waited += STOP_POLL_MS)
    {
        if (!alive(held.pid))
        {
            releaseDaemon(held.pid);
            return `self daemon ${held.pid} stopped`;
        }
        await sleep(STOP_POLL_MS);
    }
    throw new CliError(`self daemon ${held.pid} did not stop within ${STOP_TIMEOUT_MS}ms — it is finishing the tick it is in, so try again`);
}

