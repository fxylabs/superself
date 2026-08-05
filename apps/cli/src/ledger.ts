import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sessionPid } from "./machine.js";

// The process ledger: which OS process is running a work unit on this
// machine. A pid is machine-local and never syncs — the sanitization gate
// refuses it by design — so the synced log carries only the transitions
// (`work.run-started`, `work.run-exited`) and this file keeps the pid beside
// them for the one machine that can judge it.
//
// Liveness is judged at read time via signal 0. The OS is the truth: a
// process that died without reporting shows as stale on the next read, and
// that is the whole recovery story — no heartbeats, no reconciler.

interface LedgerEntry
{
    work: string;
    project: string;
    pid: number;
    startedAt: string;
}

function ledgerFile(): string
{
    return stateFile("ledger.jsonl");
}

function stateFile(name: string): string
{
    const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    return join(base, "superself", name);
}

function appendEntry(file: string, entry: object): void
{
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n");
}

function readEntries<T>(file: string): T[]
{
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as T);
}

export function recordProcess(entry: LedgerEntry): void
{
    appendEntry(ledgerFile(), entry);
}

// The newest entry wins: a unit re-run after a crash gets a new pid, and the
// stale one below it is history, not a second claim.
function localProcess(project: string, work: string): LedgerEntry | null
{
    const entries = readEntries<LedgerEntry>(ledgerFile())
        .filter((entry) => entry.project === project && entry.work === work);
    return entries[entries.length - 1] ?? null;
}

function processAlive(pid: number): boolean
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

// The same ledger, keyed by session rather than by work unit: which agent
// session is still running on this machine (#230). It answers the one thing a
// synced claim cannot — the claim says a session took a unit and when, and the
// pid behind that session is machine-local by decision
// `01kz8c83me299m37gk8rjjydw0`, so a session this machine never recorded is
// answered "unknown" rather than guessed at from a place name that is not in
// the event.
interface SessionEntry
{
    session: string;
    pid: number;
    seenAt: string;
}

interface SessionLiveness
{
    state: "running" | "ended";
    at: string;
}

function recordSession(session: string, pid: number, seenAt: string): void
{
    appendEntry(stateFile("sessions.jsonl"), { session, pid, seenAt });
}

function judgeSession(session: string): SessionLiveness | null
{
    const entries = readEntries<SessionEntry>(stateFile("sessions.jsonl")).filter((entry) => entry.session === session);
    const latest = entries[entries.length - 1];
    if (latest === undefined)
    {
        return null;
    }
    return { state: processAlive(latest.pid) ? "running" : "ended", at: latest.seenAt };
}

interface WorkClaim
{
    session?: string;
    ts: string;
}

// What a reader is told about the session holding a unit — a sentence, like
// `judgeProcess` above, and for the same reason: liveness is machine-local, so
// the one module that can judge it is the one that says what the answer means.
//
// The sentence never names who or where. A claim carries an opaque token by
// decision `01kz8c83me299m37gk8rjjydw0`, so what a second session learns is
// that some session took the unit and when — never a person or a machine. It
// is a disclosure: nothing here refuses anything, and a claim this machine
// cannot judge says so rather than guessing.
export function claimNote(claim: WorkClaim | undefined, mine: string | undefined, process?: { state: string; at: string }): string | null
{
    if (claim?.session === undefined)
    {
        return null;
    }
    if (claim.session === mine)
    {
        return "held by this session";
    }
    // A reported exit is the holder's own word that it is done, and it beats
    // this machine's guess: the session may have ended on a machine whose
    // ledger this one has never seen.
    if (process?.state === "exited")
    {
        return `was held by another session, ended ${minute(process.at)}`;
    }
    const judged = judgeSession(claim.session);
    if (judged === null)
    {
        return `held by another session, last recorded ${minute(claim.ts)}`;
    }
    return judged.state === "running"
        ? `held by another session, running since ${minute(claim.ts)}`
        : `was held by another session, ended ${minute(judged.at)}`;
}

// Held to the minute, in UTC as the log records it. A date alone cannot
// separate two sessions that picked the same unit up an hour apart, which is
// the case this whole disclosure exists for.
function minute(ts: string): string
{
    return ts.slice(0, 16).replace("T", " ");
}

// Whether a start by this session takes the claim: an unclaimed record, one
// whose holder ended, and one started before sessions were stamped. The same
// session needs no second claim, and a live holder is disclosed rather than
// displaced — nothing here refuses.
//
// One implementation, read by every verb that records a start (#231). Both
// `work start` and `state start` write the same `entity.started`, and two
// answers to whether it moves the claim would drift into two behaviours for
// one transition.
export function claimMoves(claim: WorkClaim | undefined, mine: string | undefined, process?: { state: string; at: string }): boolean
{
    const holder = claim?.session;
    if (holder === undefined)
    {
        return true;
    }
    if (holder === mine)
    {
        return false;
    }
    return process?.state === "exited" || judgeSession(holder)?.state === "ended";
}

// The pid that answers whether this session is still running, kept beside the
// log on this machine alone. A session with no resolvable identity or no
// resolvable process records nothing, and every reader answers "unknown"
// rather than inventing a liveness it cannot see.
export function noteSessionSeen(session: string | undefined, at: string): void
{
    const pid = sessionPid();
    if (session !== undefined && pid !== undefined)
    {
        recordSession(session, pid, at);
    }
}
