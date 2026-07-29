import { parseCommand } from "../args.js";
import { approvalPending } from "../completion.js";
import { readEvents } from "../logfile.js";
import { buildModel, WorkState } from "../model.js";
import { ProjectContext, requireProject } from "../paths.js";
import { bold, dim, styled } from "../style.js";
import { CliError, SelfEvent } from "../types.js";
import { circuitOf } from "./circuits.js";
import { loadPolicy, OvernightPolicy, windowStart } from "./policy.js";

// The account of a window the operator was not watching.
//
// It is a fold and nothing else: reading it records no event, moves no attempt
// and writes no file, so an operator can run it as often as they like and a
// digest taken twice says the same thing both times. That is also why there is
// no "since the last digest" mark to read — a digest that remembered having
// been run would be a digest that writes state. The window a policy declares is
// the default instead, which is the night the operator actually means.
//
// Everything in it comes off the synced event log. Nothing is inferred from
// prose, nothing is estimated, and no field is filled in because it looked
// empty: an attempt whose provider reported no cost renders as unknown, because
// a night whose spending nobody can see must not read as free.
//
// What it carries is what the log already carries — ids, verdicts, failure
// classes, artifact digests, event references — every byte of which crossed the
// sanitization guard before it was recorded. No prompt, no output, no path and
// no credential can reach here, because none of them is in the source.

export interface DigestAttempt
{
    attempt: string;
    work: string;
    state: "started" | "completed" | "failed" | "blocked" | "cancelled";
    ts: string;
    runs: number;
    failure?: string;
    detail?: string;
    provider?: string;
    artifacts: { name: string; sha256: string; bytes: number }[];
    // Whatever the provider reported, and nothing at all otherwise. Null is the
    // answer "nobody knows", kept apart from the number zero.
    costUsd: number | null;
    tokens: number | null;
}

export interface DigestGroup
{
    label: string;
    lines: string[];
}

export interface Digest
{
    project: string;
    since: string;
    until: string;
    window: string;
    groups: DigestGroup[];
    cost: { usd: number | null; tokens: number | null; unpriced: number; uncounted: number };
    nextActions: string[];
}

/* ── the fold ──────────────────────────────────────────────────────── */

const STATES: Record<string, DigestAttempt["state"]> = {
    "run.started": "started",
    "run.completed": "completed",
    "run.failed": "failed",
    "run.blocked": "blocked",
    "run.cancelled": "cancelled"
};

export function foldAttempts(events: SelfEvent[]): DigestAttempt[]
{
    const attempts = new Map<string, DigestAttempt>();
    for (const event of events)
    {
        const state = STATES[event.type];
        const id = event.refs?.attempt ?? String(event.payload.attempt ?? "");
        if (state === undefined || id === "")
        {
            continue;
        }
        const attempt = attempts.get(id) ?? blank(id, event);
        attempts.set(id, advance(attempt, state, event));
    }
    return [...attempts.values()];
}

function blank(id: string, event: SelfEvent): DigestAttempt
{
    return {
        attempt: id,
        work: event.refs?.work ?? String(event.payload.work ?? ""),
        state: "started",
        ts: event.ts,
        runs: 0,
        artifacts: [],
        costUsd: null,
        tokens: null
    };
}

// Each event moves the record forward. A run that started twice inside the
// window was retried, which is a fact about the events rather than a field
// anything writes down.
function advance(attempt: DigestAttempt, state: DigestAttempt["state"], event: SelfEvent): DigestAttempt
{
    return {
        ...attempt,
        state,
        ts: event.ts,
        runs: attempt.runs + (state === "started" ? 1 : 0),
        failure: str(event.payload.failure) ?? attempt.failure,
        detail: str(event.payload.detail) ?? attempt.detail,
        provider: str(event.payload.provider) ?? attempt.provider,
        artifacts: artifactsOf(event) ?? attempt.artifacts,
        costUsd: numberOf(event.payload.costUsd) ?? attempt.costUsd,
        tokens: numberOf(event.payload.tokens) ?? attempt.tokens
    };
}

function artifactsOf(event: SelfEvent): DigestAttempt["artifacts"] | undefined
{
    if (!Array.isArray(event.payload.artifacts))
    {
        return undefined;
    }
    return (event.payload.artifacts as Record<string, unknown>[])
        .map((item) => ({ name: String(item.name), sha256: String(item.sha256), bytes: Number(item.bytes) }));
}

// Provider data or nothing. A field that is present but not a number is the
// same as absent — it is not evidence of a cost, and rounding it into one is
// the fabrication this whole surface is written to avoid.
function numberOf(value: unknown): number | null
{
    const number = Number(value);
    return value !== undefined && value !== null && Number.isFinite(number) ? number : null;
}

function str(value: unknown): string | undefined
{
    return value === undefined || value === null ? undefined : String(value);
}

/* ── the groups ────────────────────────────────────────────────────── */

export function buildDigest(ctx: ProjectContext, since: Date, now: Date): Digest
{
    const policy = loadPolicy(ctx.storeDir, ctx.project);
    const events = readEvents(ctx.storeDir, ctx.project).filter((event) => event.ts >= since.toISOString() && event.ts <= now.toISOString());
    const attempts = foldAttempts(events);
    const works = buildModel(ctx.storeDir, ctx.project, now).works;
    // Present tense, and deliberately not window-scoped. A unit that has been
    // waiting on a person since before the window is exactly the unit the night
    // could not touch, and a window that dropped it would be an account of the
    // night with its main fact missing. Everything else here is what happened
    // inside the window; this is what is still true when it ends.
    const waiting = works.filter((work) => work.status !== "done" && approvalPending(work));
    // A provider that answered "not now" is not a failure — it answered, and it
    // said the machine may ask again. So it is counted once, under capacity,
    // and never also under failed.
    const capacity = attempts.filter(waitingOnCapacity);
    const failed = attempts.filter((attempt) => ended(attempt) && !waitingOnCapacity(attempt));
    const refused = events.filter((event) => event.type === "run.refused");
    const groups = [
        group("Completed", attempts.filter((attempt) => attempt.state === "completed").map(line)),
        group("Failed", failed.map(line)),
        group("Retried", retried(attempts)),
        group("Waiting on approval", waiting.map(approvalLine).concat(refused.map(refusalLine))),
        group("Waiting on capacity", capacity.map((attempt) => capacityLine(attempt, now)))
    ].filter((entry) => entry.lines.length > 0);
    return {
        project: ctx.project,
        since: since.toISOString(),
        until: now.toISOString(),
        window: policy === null ? "no overnight policy" : `${policy.from}–${policy.to} (policy v${policy.version})`,
        groups,
        cost: costOf(attempts),
        nextActions: nextActions(works, waiting, capacity, refused)
    };
}

function group(label: string, lines: string[]): DigestGroup
{
    return { label, lines };
}

const TRANSIENT = ["transient-provider", "transient-network"];

function waitingOnCapacity(attempt: DigestAttempt): boolean
{
    return attempt.failure !== undefined && TRANSIENT.includes(attempt.failure);
}

function ended(attempt: DigestAttempt): boolean
{
    return attempt.state === "failed" || attempt.state === "cancelled" || attempt.state === "blocked";
}

// A unit that was tried more than once inside the window. Retrying is a fact
// about the unit rather than about any one attempt — a run is retried by being
// dispatched again, under a new attempt id — so it is counted where it happened
// and the attempts are named beside it.
function retried(attempts: DigestAttempt[]): string[]
{
    const byWork = new Map<string, DigestAttempt[]>();
    for (const attempt of attempts)
    {
        byWork.set(attempt.work, [...byWork.get(attempt.work) ?? [], attempt]);
    }
    return [...byWork.entries()]
        .filter(([, tries]) => tries.length > 1)
        .map(([work, tries]) => `- ${work} tried ${tries.length} times — ${tries.map((item) => `${item.attempt} ${item.state}`).join(", ")}`);
}

function line(attempt: DigestAttempt): string
{
    const artifacts = attempt.artifacts.map((item) => `${item.name}@${item.sha256.slice(0, 12)}`).join(", ");
    const why = attempt.failure === undefined ? "" : ` ${attempt.failure}`;
    const detail = attempt.detail === undefined ? "" : ` — ${attempt.detail}`;
    const runs = attempt.runs > 1 ? ` (run ${attempt.runs})` : "";
    return `- ${attempt.work} ${attempt.attempt}${why}${runs}${detail}${artifacts === "" ? "" : ` [${artifacts}]`}`;
}

function approvalLine(work: WorkState): string
{
    const why = work.completion.approvalRequired?.why;
    return `- ${work.id} needs a person's approval${why === undefined ? "" : ` (${why})`}`;
}

// A proposal an attempt made mid-run and was refused for. It is in the digest
// because the attempt kept running afterwards: the operator has to find out
// that something asked, and what it asked for.
function refusalLine(event: SelfEvent): string
{
    return `- ${event.refs?.work ?? ""} ${String(event.payload.attempt ?? "")} proposed ${String(event.payload.action ?? "")} ` +
        `(${String(event.payload.category ?? "")}) and was refused [${event.id}]`;
}

// The reset the provider's circuit is holding, read from this machine's own
// breaker. It is the one thing in the digest that is not in the log, and it is
// here because "waiting on capacity" without the instant it ends is not an
// account of anything the operator can act on.
function capacityLine(attempt: DigestAttempt, now: Date): string
{
    const retryAt = attempt.provider === undefined ? undefined : circuitOf(attempt.provider, now).retryAt;
    return `- ${attempt.work} ${attempt.attempt} ${attempt.provider ?? "provider unrecorded"} — ` +
        `retryAt ${retryAt ?? "unknown"}`;
}

// Costs are summed over what was reported and counted separately over what was
// not. A window in which nothing reported anything renders unknown rather than
// zero, and one in which half reported says how much of it is missing.
function costOf(attempts: DigestAttempt[]): Digest["cost"]
{
    const priced = attempts.map((attempt) => attempt.costUsd).filter((cost): cost is number => cost !== null);
    const counted = attempts.map((attempt) => attempt.tokens).filter((tokens): tokens is number => tokens !== null);
    return {
        usd: priced.length === 0 ? null : priced.reduce((sum, value) => sum + value, 0),
        tokens: counted.length === 0 ? null : counted.reduce((sum, value) => sum + value, 0),
        unpriced: attempts.length - priced.length,
        uncounted: attempts.length - counted.length
    };
}

// Each one is the command the operator would type. A next action nobody can
// act on is a sentence, and the digest already has enough of those.
function nextActions(works: WorkState[], waiting: WorkState[], capacity: DigestAttempt[], refused: SelfEvent[]): string[]
{
    const actions = waiting.map((work) => `approve ${work.id} at a terminal — \`self work approve ${work.id}\``);
    for (const event of refused)
    {
        actions.push(`decide what to do about the ${String(event.payload.category ?? "")} action ${String(event.payload.attempt ?? "")} asked for — nothing was queued`);
    }
    for (const provider of [...new Set(capacity.map((attempt) => attempt.provider))].filter((name): name is string => name !== undefined))
    {
        actions.push(`${provider} refused this machine on capacity — \`self daemon circuits\` says when it may be asked again`);
    }
    for (const work of works.filter((item) => item.status !== "done" && item.owes !== undefined))
    {
        actions.push(`${work.id} — ${work.owes}`);
    }
    return actions;
}

/* ── the verb ──────────────────────────────────────────────────────── */

export function runDigestCommand(rest: string[]): void
{
    const { values } = parseCommand("digest", rest, { since: { type: "string" }, hours: { type: "string" }, json: { type: "boolean" } }, 0);
    const ctx = requireProject(process.cwd());
    const now = new Date();
    const digest = buildDigest(ctx, since(ctx, values.since, values.hours, now), now);
    console.log(values.json === true ? JSON.stringify(digest, null, 2) : render(digest).join("\n"));
}

// The window, in the order the operator's intent is most specific: an explicit
// instant, then a span, then the night the policy declares, then a plain half
// day for a project that has no policy at all.
function since(ctx: ProjectContext, at: string | undefined, hours: string | undefined, now: Date): Date
{
    if (at !== undefined)
    {
        const parsed = new Date(at);
        if (Number.isNaN(parsed.getTime()))
        {
            throw new CliError(`self digest --since expects a timestamp, not "${at}"`);
        }
        return parsed;
    }
    if (hours !== undefined)
    {
        const span = Number(hours);
        if (!Number.isFinite(span) || span <= 0)
        {
            throw new CliError("self digest --hours expects a positive number of hours");
        }
        return new Date(now.getTime() - span * 3_600_000);
    }
    return defaultSince(loadPolicy(ctx.storeDir, ctx.project), now);
}

const DEFAULT_HOURS = 12;

function defaultSince(policy: OvernightPolicy | null, now: Date): Date
{
    return policy === null ? new Date(now.getTime() - DEFAULT_HOURS * 3_600_000) : windowStart(policy, now);
}

// The groups that are an account of the window rather than of what is still
// waiting when it ends. A window with none of them had nothing run in it,
// however much is standing open.
const RUN_GROUPS = ["Completed", "Failed", "Retried"];

function render(digest: Digest): string[]
{
    const head = `${digest.project} — ${digest.since} to ${digest.until}, ${digest.window}`;
    const lines = [styled ? bold(head) : head];
    for (const entry of digest.groups)
    {
        lines.push("", styled ? bold(entry.label) : `## ${entry.label}`, ...entry.lines);
    }
    if (!digest.groups.some((entry) => RUN_GROUPS.includes(entry.label)))
    {
        lines.push("", "nothing ran in this window");
    }
    lines.push("", styled ? bold("Cost and usage") : "## Cost and usage", costLine(digest.cost));
    if (digest.nextActions.length > 0)
    {
        lines.push("", styled ? bold("Next actions") : "## Next actions");
        lines.push(...digest.nextActions.map((action) => styled ? `- ${dim(action)}` : `- ${action}`));
    }
    return lines;
}

function costLine(cost: Digest["cost"]): string
{
    const missing = [
        cost.unpriced === 0 ? "" : `cost unknown for ${cost.unpriced} attempt(s)`,
        cost.uncounted === 0 ? "" : `tokens unknown for ${cost.uncounted}`
    ].filter((note) => note !== "");
    return `- cost ${cost.usd === null ? "unknown" : `$${cost.usd}`}, tokens ${cost.tokens === null ? "unknown" : cost.tokens}` +
        `${missing.length === 0 ? "" : ` (${missing.join(", ")})`}`;
}
