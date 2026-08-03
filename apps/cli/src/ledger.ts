import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The process ledger: which OS process is running a work unit on this
// machine. A pid is machine-local and never syncs — the sanitization gate
// refuses it by design — so the synced log carries only the transitions
// (`work.run-started`, `work.run-exited`) and this file keeps the pid beside
// them for the one machine that can judge it.
//
// Liveness is judged at read time via signal 0. The OS is the truth: a
// process that died without reporting shows as stale on the next read, and
// that is the whole recovery story — no heartbeats, no reconciler.

export interface LedgerEntry
{
    work: string;
    project: string;
    pid: number;
    startedAt: string;
}

function ledgerFile(): string
{
    const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    return join(base, "superself", "ledger.jsonl");
}

export function recordProcess(entry: LedgerEntry): void
{
    const file = ledgerFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n");
}

// The newest entry wins: a unit re-run after a crash gets a new pid, and the
// stale one below it is history, not a second claim.
export function localProcess(project: string, work: string): LedgerEntry | null
{
    const file = ledgerFile();
    if (!existsSync(file))
    {
        return null;
    }
    const entries = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as LedgerEntry)
        .filter((entry) => entry.project === project && entry.work === work);
    return entries[entries.length - 1] ?? null;
}

export function processAlive(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        // EPERM is a live process owned by someone else; anything else is gone.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

// What a reader should say about a unit's process. On the machine that
// recorded the pid the OS decides between running and stale; anywhere else
// the synced transitions are the only truth, so the folded state passes
// through as last-reported.
export function judgeProcess(project: string, work: string, folded: { state: string; code?: number } | undefined): string | null
{
    if (folded === undefined)
    {
        return null;
    }
    if (folded.state === "exited")
    {
        return folded.code === undefined ? "exited" : `exited (code ${folded.code})`;
    }
    const local = localProcess(project, work);
    if (local === null)
    {
        return "running (recorded on another machine)";
    }
    return processAlive(local.pid)
        ? `running (pid ${local.pid})`
        : `stale (pid ${local.pid} is gone without reporting an exit)`;
}
