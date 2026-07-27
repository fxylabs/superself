import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

export function spoolFile(storeDir: string, attempt: string, name: string): string
{
    return join(spoolDir(storeDir, attempt), name);
}

export function readSpool(storeDir: string, attempt: string, name: string): string | null
{
    const file = spoolFile(storeDir, attempt, name);
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
}

function journalFile(storeDir: string): string
{
    return join(localDir(storeDir), "attempts.jsonl");
}

// The journal is append-only for the same reason the synced log is: a daemon
// that dies mid-write must leave a state that still folds.
export function appendJournal(storeDir: string, entry: JournalEntry): void
{
    appendFileSync(journalFile(storeDir), JSON.stringify(entry) + "\n");
}

export function readJournal(storeDir: string): JournalEntry[]
{
    const file = journalFile(storeDir);
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as JournalEntry);
}

export function writeLocalJson(file: string, value: unknown): void
{
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function readLocalJson<T>(file: string): T | null
{
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : null;
}
