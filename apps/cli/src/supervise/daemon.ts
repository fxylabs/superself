import { spawn } from "node:child_process";
import { appendFileSync, openSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliContext } from "../paths.js";
import { bold, dim, green, styled, yellow } from "../style.js";
import { CliError } from "../types.js";
import { AttemptRecord, foldAttempts, heldLeases } from "./attempt.js";
import { daemonFile, daemonLogFile, readLocalJson, writeLocalJson } from "./local.js";
import { alive, tick } from "./supervisor.js";

const DEFAULT_INTERVAL = 30;

interface DaemonRecord
{
    pid: number;
    startedAt: string;
    intervalSec: number;
}

export function daemonRecord(storeDir: string): DaemonRecord | null
{
    const record = readLocalJson<DaemonRecord>(daemonFile(storeDir));
    return record !== null && alive(record.pid) ? record : null;
}

function cliEntry(): string
{
    return fileURLToPath(new URL("../../bin/self.mjs", import.meta.url));
}

export function daemonStart(ctx: CliContext, intervalSec: number): void
{
    const running = daemonRecord(ctx.storeDir);
    if (running !== null)
    {
        console.log(`selfd already supervising (pid ${running.pid}, every ${running.intervalSec}s)`);
        return;
    }
    const stale = readLocalJson<DaemonRecord>(daemonFile(ctx.storeDir));
    const log = openSync(daemonLogFile(ctx.storeDir), "a");
    const child = spawn(process.execPath, [cliEntry(), "daemon", "run", "--interval", String(intervalSec)], {
        cwd: ctx.workspaceDir,
        detached: true,
        stdio: ["ignore", log, log]
    });
    child.unref();
    writeLocalJson(daemonFile(ctx.storeDir), { pid: child.pid, startedAt: new Date().toISOString(), intervalSec });
    if (stale !== null)
    {
        console.log(`recovered from a stopped supervisor (was pid ${stale.pid}) — running attempts are reconciled on the next pass`);
    }
    console.log(`selfd supervising every ${intervalSec}s (pid ${child.pid}) — log in ${daemonLogFile(ctx.storeDir)}`);
}

export function daemonStop(ctx: CliContext): void
{
    const running = daemonRecord(ctx.storeDir);
    rmSync(daemonFile(ctx.storeDir), { force: true });
    if (running === null)
    {
        console.log("selfd is not running");
        return;
    }
    try
    {
        process.kill(running.pid, "SIGTERM");
    }
    catch
    {
        // Already gone: the pointer is removed either way.
    }
    console.log(`selfd stopped (pid ${running.pid})`);
}

export async function daemonRun(ctx: CliContext, intervalSec: number): Promise<void>
{
    let stopping = false;
    const stop = (): void =>
    {
        stopping = true;
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    note(ctx, `selfd started, every ${intervalSec}s`);
    while (!stopping)
    {
        try
        {
            const summary = tick(ctx, new Date());
            const moved = [...summary.reconciled, ...summary.settled, ...summary.dispatched];
            if (moved.length > 0)
            {
                note(ctx, `tick: ${moved.join("; ")}`);
            }
        }
        catch (error)
        {
            note(ctx, `tick failed: ${(error as Error).message}`);
        }
        await sleep(intervalSec * 1000);
    }
    note(ctx, "selfd stopped");
}

function note(ctx: CliContext, text: string): void
{
    appendFileSync(daemonLogFile(ctx.storeDir), `${new Date().toISOString()} ${text}\n`);
}

function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) =>
    {
        setTimeout(resolve, ms);
    });
}

export function daemonStatus(ctx: CliContext): void
{
    const running = daemonRecord(ctx.storeDir);
    console.log(running === null
        ? (styled ? yellow("selfd is not running — start it with `self daemon start`") : "selfd is not running")
        : `${styled ? green("●") : "running"} selfd pid ${running.pid}, every ${running.intervalSec}s, since ${running.startedAt.slice(0, 16).replace("T", " ")}`);
    const attempts = foldAttempts(ctx.storeDir);
    if (attempts.length === 0)
    {
        console.log("no attempts registered");
        return;
    }
    for (const attempt of attempts)
    {
        console.log(attemptLine(attempt));
    }
    const leases = heldLeases(attempts);
    console.log(leases.size === 0
        ? "leases: none held"
        : `leases: ${[...leases].map(([key, id]) => `${key} → ${id}`).join(", ")}`);
}

function attemptLine(attempt: AttemptRecord): string
{
    const verdict = attempt.verdict === null ? "" : ` ${attempt.verdict}`;
    const detail = attempt.reasons.length === 0 ? "" : ` — ${attempt.reasons[0]}`;
    const head = `${attempt.id}  ${attempt.state}${verdict}`;
    return styled
        ? `${dim(attempt.id)}  ${bold(attempt.state + verdict)}  ${attempt.work} ${attempt.kind}${dim(detail)}`
        : `${head}  ${attempt.work} ${attempt.kind}${detail}`;
}

export function parseInterval(value: string | undefined): number
{
    if (value === undefined)
    {
        return DEFAULT_INTERVAL;
    }
    const seconds = Number.parseInt(value, 10);
    if (Number.isNaN(seconds) || seconds < 1)
    {
        throw new CliError("daemon --interval expects a number of seconds");
    }
    return seconds;
}
