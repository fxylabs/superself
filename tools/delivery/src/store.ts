import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeliveryError, DeliveryEvent } from "./types.js";

// The ledger is machine-local state, not repository content: the runner that
// drives it lives outside this repository, and a half-finished release must
// survive a session ending without leaving anything to commit.
export function deliveryDir(): string
{
    const override = process.env.SUPERSELF_DELIVERY_DIR;
    if (override !== undefined && override !== "")
    {
        return override;
    }
    const state = process.env.XDG_STATE_HOME;
    return state !== undefined && state !== ""
        ? join(state, "superself-delivery")
        : join(homedir(), ".local", "state", "superself-delivery");
}

export function recordFile(issue: number): string
{
    return join(deliveryDir(), `issue-${issue}.jsonl`);
}

export function readEvents(issue: number): DeliveryEvent[]
{
    const file = recordFile(issue);
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as DeliveryEvent);
}

export function appendEvent(issue: number, type: string, payload: Record<string, unknown>): DeliveryEvent
{
    const events = readEvents(issue);
    const event: DeliveryEvent = {
        seq: events.length + 1,
        ts: new Date().toISOString(),
        type,
        payload
    };
    mkdirSync(deliveryDir(), { recursive: true });
    appendFileSync(recordFile(issue), JSON.stringify(event) + "\n");
    return event;
}

export function requireRecord(issue: number): DeliveryEvent[]
{
    const events = readEvents(issue);
    if (events.length === 0)
    {
        throw new DeliveryError(`no delivery record for issue #${issue} — run \`delivery open --issue ${issue}\` first`);
    }
    return events;
}
