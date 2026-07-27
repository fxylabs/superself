import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { excludeLocally } from "../gitutil.js";
import { ensureDir } from "../paths.js";

// Everything the supervisor needs to run a process — handles, raw output,
// the command itself — is machine-local and never syncs. It lives beside the
// store so one directory holds a machine's whole workspace, and is excluded
// from the store repository the same way links.jsonl is.
export const LOCAL_DIR = "local";

let excluded = false;

export function localDir(storeDir: string): string
{
    if (!excluded)
    {
        excludeLocally(storeDir, LOCAL_DIR + "/");
        excluded = true;
    }
    return ensureDir(join(storeDir, LOCAL_DIR));
}

export function spoolDir(storeDir: string, attempt: string): string
{
    return ensureDir(join(localDir(storeDir), "spool", attempt));
}

// Each launch gets its own directory, named for the fence that minted it.
// A wrapper from a superseded launch keeps writing — into its own directory,
// where it can never be mistaken for the run that is current. Retried runs
// keep their predecessors' output instead of overwriting the evidence.
export function runDir(storeDir: string, attempt: string, fence: number): string
{
    return ensureDir(join(spoolDir(storeDir, attempt), `run-${fence}`));
}

export function runFile(storeDir: string, attempt: string, fence: number, name: string): string
{
    return join(runDir(storeDir, attempt, fence), name);
}

export function readRun(storeDir: string, attempt: string, fence: number, name: string): string | null
{
    const file = runFile(storeDir, attempt, fence, name);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function daemonFile(storeDir: string): string
{
    return join(localDir(storeDir), "daemon.json");
}

export function daemonLogFile(storeDir: string): string
{
    return join(localDir(storeDir), "daemon.log");
}

export interface JournalEntry
{
    ts: string;
    attempt: string;
    kind: string;
    patch: Record<string, unknown>;
    // Assigned on read, not on write: the journal is append-only and repair
    // only ever drops a torn tail, so an entry's index is stable forever and
    // is what a durable consumer cursor points at.
    seq?: number;
}

export function journalFile(storeDir: string): string
{
    return join(localDir(storeDir), "attempts.jsonl");
}

function quarantineFile(storeDir: string): string
{
    return join(localDir(storeDir), "attempts.quarantine.jsonl");
}

// An append that returns has reached the disk. Without the fsync a crash can
// lose a registration the supervisor already acted on, which is the one thing
// the journal exists to prevent.
export function appendJournal(storeDir: string, entry: JournalEntry): void
{
    const line = JSON.stringify({ ts: entry.ts, attempt: entry.attempt, kind: entry.kind, patch: entry.patch }) + "\n";
    const fd = openSync(journalFile(storeDir), "a");
    try
    {
        writeSync(fd, line);
        fsyncSync(fd);
    }
    finally
    {
        closeSync(fd);
    }
}

export interface JournalRead
{
    entries: JournalEntry[];
    // Bytes that fold cleanly. A torn tail lives past this offset and is what
    // repairJournal truncates.
    validBytes: number;
    torn: string[];
}

// A daemon killed mid-append leaves a partial final line. Reading must survive
// it: the preceding entries are all still valid, and refusing to parse them
// would make one interrupted write cost the whole supervision history.
export function scanJournal(storeDir: string): JournalRead
{
    const file = journalFile(storeDir);
    if (!existsSync(file))
    {
        return { entries: [], validBytes: 0, torn: [] };
    }
    const raw = readFileSync(file, "utf8");
    const entries: JournalEntry[] = [];
    const torn: string[] = [];
    let validBytes = 0;
    let offset = 0;
    while (offset < raw.length)
    {
        const end = raw.indexOf("\n", offset);
        const complete = end !== -1;
        const line = raw.slice(offset, complete ? end : raw.length);
        const consumed = Buffer.byteLength(complete ? raw.slice(offset, end + 1) : line, "utf8");
        const parsed = complete ? parseEntry(line) : null;
        if (parsed !== null)
        {
            parsed.seq = entries.length;
            entries.push(parsed);
            validBytes += consumed;
        }
        else if (line.trim() !== "")
        {
            torn.push(line);
        }
        else
        {
            validBytes += consumed;
        }
        offset = complete ? end + 1 : raw.length;
    }
    return { entries, validBytes, torn };
}

function parseEntry(line: string): JournalEntry | null
{
    if (line.trim() === "")
    {
        return null;
    }
    try
    {
        const value = JSON.parse(line) as JournalEntry;
        return typeof value?.attempt === "string" && typeof value?.kind === "string" ? value : null;
    }
    catch
    {
        return null;
    }
}

export function readJournal(storeDir: string): JournalEntry[]
{
    return scanJournal(storeDir).entries;
}

// Quarantine before truncating: a torn line is evidence of how a machine died
// and is worth keeping, but leaving it in place would re-tear every read.
// Only a caller holding the store lock may repair, or a live appender's write
// would be cut in half.
export function repairJournal(storeDir: string): string[]
{
    const scan = scanJournal(storeDir);
    if (scan.torn.length === 0)
    {
        return [];
    }
    const stamp = new Date().toISOString();
    appendFileSync(quarantineFile(storeDir), scan.torn.map((line) => `${stamp} ${line}\n`).join(""));
    const rewritten = scan.entries
        .map((entry) => JSON.stringify({ ts: entry.ts, attempt: entry.attempt, kind: entry.kind, patch: entry.patch }) + "\n")
        .join("");
    writeLocalFileDurable(journalFile(storeDir), rewritten);
    return scan.torn;
}

// Replace by rename so a reader never meets a half-written file, and fsync
// both the payload and the rename so a crash cannot resurrect the old one.
export function writeLocalFileDurable(file: string, text: string): void
{
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w");
    try
    {
        writeSync(fd, text);
        fsyncSync(fd);
    }
    finally
    {
        closeSync(fd);
    }
    renameSync(tmp, file);
}

// The byte-exact twin of writeLocalFileDurable: a staged artifact may be an
// image or a binary, and round-tripping it through a string would corrupt it.
export function writeLocalBytesDurable(file: string, bytes: Buffer): void
{
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w");
    try
    {
        writeSync(fd, bytes);
        fsyncSync(fd);
    }
    finally
    {
        closeSync(fd);
    }
    renameSync(tmp, file);
}

export function writeLocalJsonDurable(file: string, value: unknown): void
{
    writeLocalFileDurable(file, JSON.stringify(value, null, 2) + "\n");
}

export function readLocalJson<T>(file: string): T | null
{
    if (!existsSync(file))
    {
        return null;
    }
    try
    {
        return JSON.parse(readFileSync(file, "utf8")) as T;
    }
    catch
    {
        return null;
    }
}
