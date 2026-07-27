import { join } from "node:path";
import { JournalEntry, localDir, readJournal, readLocalJson, writeLocalJsonDurable } from "./local.js";

// Which journal entries are worth waking a scheduler for. A completion, a
// failure, an approval, a capacity park, and a cancellation all change what
// is eligible to run; a heartbeat does not.
const WAKE_KINDS = ["register", "settle.commit", "approve", "cancel", "capacity", "exit", "propose"];

export interface Subscription
{
    // The seq of the last entry this consumer has finished with. Durable, so
    // a restarted daemon resumes at the same place a running one would have,
    // rather than starting from a memory that died with the process.
    cursor: number;
    updatedAt: string;
}

function cursorFile(storeDir: string): string
{
    return join(localDir(storeDir), "cursors.json");
}

export function subscriptions(storeDir: string): Record<string, Subscription>
{
    return readLocalJson<Record<string, Subscription>>(cursorFile(storeDir)) ?? {};
}

export function cursorOf(storeDir: string, consumer: string): number
{
    return subscriptions(storeDir)[consumer]?.cursor ?? -1;
}

// A consumer that has never run starts before entry zero, so its first pass
// replays the whole journal. That is the intended behaviour: a scheduler
// coming up for the first time on an existing store must see everything.
export function ensureSubscription(storeDir: string, consumer: string, ts: string): void
{
    const all = subscriptions(storeDir);
    if (all[consumer] === undefined)
    {
        all[consumer] = { cursor: -1, updatedAt: ts };
        writeLocalJsonDurable(cursorFile(storeDir), all);
    }
}

export function pendingSignals(storeDir: string, consumer: string): JournalEntry[]
{
    const cursor = cursorOf(storeDir, consumer);
    return readJournal(storeDir).filter((entry) => (entry.seq ?? -1) > cursor && WAKE_KINDS.includes(entry.kind));
}

// Advancing is its own durable write, after the effects it covers. A crash
// before it means the signals replay, and replaying them is safe because
// every effect they trigger is gated on state that has already moved.
export function advanceCursor(storeDir: string, consumer: string, seq: number, ts: string): void
{
    const all = subscriptions(storeDir);
    const current = all[consumer]?.cursor ?? -1;
    if (seq <= current)
    {
        return;
    }
    all[consumer] = { cursor: seq, updatedAt: ts };
    writeLocalJsonDurable(cursorFile(storeDir), all);
}
