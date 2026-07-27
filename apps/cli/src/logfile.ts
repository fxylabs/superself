import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectStateDir } from "./paths.js";
import { CliError, SelfEvent } from "./types.js";

export function readEvents(storeDir: string, slug: string): SelfEvent[]
{
    const file = join(projectStateDir(storeDir, slug), "log.jsonl");
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
}

export function findEventByPrefix(storeDir: string, slug: string, prefix: string): SelfEvent
{
    const matches = readEvents(storeDir, slug).filter((event) => event.id.startsWith(prefix));
    if (matches.length === 0)
    {
        throw new CliError(`no event matches id prefix "${prefix}"`);
    }
    if (matches.length > 1)
    {
        throw new CliError(`id prefix "${prefix}" is ambiguous (${matches.length} matches)`);
    }
    return matches[0];
}

export function eventSummary(event: SelfEvent): string
{
    const payload = event.payload;
    const parts = [payload.work, payload.objective, payload.milestone, payload.proposal, payload.criterion,
        payload.attempt, payload.text ?? payload.outcome ?? payload.why ?? payload.as ?? payload.detail]
        .filter((value) => value !== undefined)
        .map((value) => String(value));
    return parts.join(" ");
}
