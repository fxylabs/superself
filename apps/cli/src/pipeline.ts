import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { foldProject } from "./fold.js";
import { commitAll } from "./gitutil.js";
import { ulid } from "./ids.js";
import { CliContext, ensureDir, projectStateDir } from "./paths.js";
import { bold, dim, green, styled } from "./style.js";
import { EventRefs, SelfEvent } from "./types.js";

export function makeEvent(
    project: string,
    type: string,
    payload: Record<string, unknown>,
    refs?: EventRefs,
    humanConfirmed = false
): SelfEvent
{
    const event: SelfEvent = {
        id: ulid(),
        ts: new Date().toISOString(),
        type,
        origin: { actor: "agent", session: process.env.SUPERSELF_SESSION, confirmed: humanConfirmed },
        project,
        payload
    };
    if (refs !== undefined)
    {
        event.refs = refs;
    }
    return event;
}

export function recordEvent(ctx: CliContext, event: SelfEvent, summary: string): void
{
    const dir = ensureDir(projectStateDir(ctx.storeDir, event.project));
    appendFileSync(join(dir, "log.jsonl"), JSON.stringify(event) + "\n");
    foldProject(ctx.storeDir, event.project);
    commitAll(ctx.storeDir, `${event.type} ${event.project}: ${truncate(summary, 60)}`);
    console.log(styled
        ? `${green("✓")} ${bold(event.type)}  ${dim(truncate(summary, 80))}  ${dim(`[${event.id}]`)}`
        : `${event.type} recorded [${event.id}]`);
}

function truncate(text: string, max: number): string
{
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
