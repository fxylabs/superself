import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { foldProject } from "./fold.js";
import { commitAll, currentBranch } from "./gitutil.js";
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

// The branch is stamped here, not by each verb: every event is made from one
// checkout, and that is the only place holding it.
// Machine callers ask for `quiet` and print their own JSON: the acknowledgement
// line is for a person watching a terminal, and mixing it into a JSON stream
// would make the surface unparseable.
export function recordEvent(ctx: CliContext, event: SelfEvent, summary: string, quiet = false): void
{
    const branch = ctx.projectDir === undefined ? null : currentBranch(ctx.projectDir);
    if (branch !== null)
    {
        event.refs = { ...event.refs, branch };
    }
    const dir = ensureDir(projectStateDir(ctx.storeDir, event.project));
    appendFileSync(join(dir, "log.jsonl"), JSON.stringify(event) + "\n");
    foldProject(ctx.storeDir, event.project);
    commitAll(ctx.storeDir, `${event.type} ${event.project}: ${truncate(summary, 60)}`);
    if (quiet)
    {
        return;
    }
    console.log(styled
        ? `${green("✓")} ${bold(event.type)}  ${dim(truncate(summary, 80))}  ${dim(`[${event.id}]`)}`
        : `${event.type} recorded [${event.id}]`);
}

function truncate(text: string, max: number): string
{
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
