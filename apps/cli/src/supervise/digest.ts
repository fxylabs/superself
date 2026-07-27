import { buildModel } from "../model.js";
import { CliContext } from "../paths.js";
import { bold, dim, styled } from "../style.js";
import { AttemptRecord, foldAttempts } from "./attempt.js";
import { loadPolicy } from "./policy.js";
import { redact } from "./sanitize.js";

export interface DigestGroup
{
    label: string;
    lines: string[];
}

export interface Digest
{
    since: string;
    groups: DigestGroup[];
    nextActions: string[];
}

// The digest reads the same folded attempts the supervisor acts on, and
// prints only fields that are already safe to sync: no prompt, no raw
// output, no path, no handle.
export function buildDigest(ctx: CliContext, since: Date, now: Date): Digest
{
    const recent = foldAttempts(ctx.storeDir).filter((attempt) => touchedSince(attempt, since));
    const groups: DigestGroup[] = [
        group("Completed", recent.filter((a) => a.verdict === "passed")),
        group("Failed", recent.filter((a) => a.verdict === "failed")),
        group("Stale", recent.filter((a) => a.verdict === "stale")),
        group("Retried", recent.filter((a) => a.tries > 1 && a.verdict !== "passed")),
        group("Waiting on approval", recent.filter((a) => a.needsApproval && !a.approved)),
        group("Waiting on capacity", recent.filter((a) => a.state === "waiting-capacity")),
        group("Cancelled", recent.filter((a) => a.verdict === "cancelled"))
    ].filter((entry) => entry.lines.length > 0);
    groups.push({ label: "Cost and usage", lines: [usageLine(recent)] });
    return { since: since.toISOString(), groups, nextActions: nextActions(ctx, recent, now) };
}

function touchedSince(attempt: AttemptRecord, since: Date): boolean
{
    const stamps = [attempt.registeredAt, attempt.startedAt, attempt.settledAt, attempt.exitAt];
    return stamps.some((stamp) => stamp !== null && new Date(stamp) >= since);
}

function group(label: string, attempts: AttemptRecord[]): DigestGroup
{
    return { label, lines: attempts.map(line) };
}

function line(attempt: AttemptRecord): string
{
    const outputs = Object.entries(attempt.hashes)
        .map(([name, hash]) => `${name}@${hash.slice(0, 12)}`)
        .join(", ");
    const detail = attempt.reasons.length === 0 ? "" : ` — ${redact(attempt.reasons[0])}`;
    const tail = outputs === "" ? "" : ` [${outputs}]`;
    const tries = attempt.tries > 1 ? ` (try ${attempt.tries})` : "";
    return `- ${attempt.work} ${attempt.id} ${attempt.kind}/${attempt.runtime}${tries}${detail}${tail}`;
}

// Unknown is a real answer. A provider that reported nothing must not be
// rendered as zero, or a night of spending reads as free.
function usageLine(attempts: AttemptRecord[]): string
{
    const costs = attempts.map((a) => a.costUsd).filter((cost): cost is number => cost !== null);
    const usages = attempts.map((a) => a.usage).filter((usage): usage is number => usage !== null);
    const cost = costs.length === 0 ? "unknown" : `$${costs.reduce((sum, value) => sum + value, 0).toFixed(2)}`;
    const tokens = usages.length === 0 ? "unknown" : String(usages.reduce((sum, value) => sum + value, 0));
    const missing = attempts.length - costs.length;
    const note = missing > 0 && costs.length > 0 ? ` (${missing} attempt${missing === 1 ? "" : "s"} unknown)` : "";
    return `- cost ${cost}, tokens ${tokens}${note}`;
}

function nextActions(ctx: CliContext, attempts: AttemptRecord[], now: Date): string[]
{
    const actions: string[] = [];
    for (const attempt of attempts.filter((a) => a.needsApproval && !a.approved))
    {
        actions.push(`approve or drop ${attempt.id} (${attempt.work}) — \`self attempt approve ${attempt.id}\``);
    }
    for (const attempt of attempts.filter((a) => a.reasons.some((reason) => reason.includes("fresh review"))))
    {
        actions.push(`review ${attempt.work} in a fresh session before it can be done`);
    }
    for (const attempt of attempts.filter((a) => a.verdict === "failed"))
    {
        actions.push(`decide what to do about ${attempt.work} — ${attempt.id} failed validation`);
    }
    const policy = loadPolicy(ctx.storeDir, ctx.project ?? "");
    if (policy !== null && ctx.project !== undefined)
    {
        const open = buildModel(ctx.storeDir, ctx.project, now).works.filter((work) => work.status === "blocked");
        actions.push(...open.map((work) => `${work.id} is blocked on ${work.blockedOn}`));
    }
    return actions;
}

export function printDigest(digest: Digest): void
{
    const head = `Overnight digest — since ${digest.since.slice(0, 16).replace("T", " ")}`;
    console.log(styled ? bold(head) : head);
    if (digest.groups.length === 0)
    {
        console.log("nothing ran");
        return;
    }
    for (const entry of digest.groups)
    {
        console.log("");
        console.log(styled ? bold(entry.label) : `## ${entry.label}`);
        for (const item of entry.lines)
        {
            console.log(item);
        }
    }
    if (digest.nextActions.length > 0)
    {
        console.log("");
        console.log(styled ? bold("Next actions") : "## Next actions");
        for (const action of digest.nextActions)
        {
            console.log(styled ? `- ${dim(action)}` : `- ${action}`);
        }
    }
}
