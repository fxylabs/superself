import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { ingestArtifacts } from "../artifact.js";
import { buildModel } from "../model.js";
import { CliContext, readRegistry, resolveProjectPath } from "../paths.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { EventRefs } from "../types.js";
import {
    AttemptRecord,
    AttemptVerdict,
    circuitOpen,
    circuitKey,
    foldAttempts,
    heldLeases,
    patchAttempt
} from "./attempt.js";
import { readSpool, spoolDir, spoolFile } from "./local.js";
import {
    DEFAULT_CIRCUIT_THRESHOLD,
    OvernightPolicy,
    forbiddenAction,
    loadPolicy,
    policyRefusal
} from "./policy.js";
import { redact } from "./sanitize.js";

const REPORT_CAP = 4000;

export interface TickSummary
{
    reconciled: string[];
    settled: string[];
    dispatched: string[];
    skipped: string[];
}

export function tick(ctx: CliContext, now: Date): TickSummary
{
    const summary: TickSummary = { reconciled: [], settled: [], dispatched: [], skipped: [] };
    const attempts = foldAttempts(ctx.storeDir);
    for (const attempt of attempts)
    {
        if (reconcile(ctx.storeDir, attempt, now))
        {
            summary.reconciled.push(`${attempt.id} ${attempt.exitSource}`);
        }
    }
    for (const attempt of attempts)
    {
        if (attempt.state === "exited")
        {
            settle(ctx, attempt, now);
            summary.settled.push(`${attempt.id} ${attempt.verdict}`);
        }
    }
    for (const attempt of attempts)
    {
        const refusal = considerDispatch(ctx, attempts, attempt, now);
        if (refusal === null)
        {
            launch(ctx, attempt, now);
            summary.dispatched.push(attempt.id);
        }
        else if (refusal !== "")
        {
            summary.skipped.push(`${attempt.id} — ${refusal}`);
        }
    }
    return summary;
}

/* ── observation ───────────────────────────────────────────────────── */

export function alive(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

interface ExitNotice
{
    code: number | null;
    providerStatus: string | null;
    retryAt: string | null;
}

// The wrapper writes the exit notice by rename, so a half-written file never
// reads as a confirmed exit.
function readExitNotice(storeDir: string, attempt: AttemptRecord): ExitNotice | null
{
    const raw = readSpool(storeDir, attempt.id, "exit");
    if (raw === null || raw.trim() === "")
    {
        return null;
    }
    const provider = readSpool(storeDir, attempt.id, "provider.json");
    const parsed = provider === null ? {} : safeJson(provider);
    return {
        code: Number.parseInt(raw.trim(), 10),
        providerStatus: typeof parsed.status === "string" ? parsed.status : null,
        retryAt: typeof parsed.retryAt === "string" ? parsed.retryAt : null
    };
}

function safeJson(text: string): Record<string, unknown>
{
    try
    {
        return JSON.parse(text);
    }
    catch
    {
        return {};
    }
}

function beatDeadline(attempt: AttemptRecord): number
{
    const base = attempt.lastBeat ?? attempt.startedAt ?? attempt.registeredAt;
    return new Date(base).getTime() + attempt.heartbeatSec * 1000;
}

// Exit detection needs no orchestrator: a confirmed notice, a pid that is
// gone, and a heartbeat that ran out are three different findings, and only
// the first says anything about what the run produced.
function reconcile(storeDir: string, attempt: AttemptRecord, now: Date): boolean
{
    if (attempt.state !== "running")
    {
        return false;
    }
    const notice = readExitNotice(storeDir, attempt);
    if (notice !== null)
    {
        patchAttempt(storeDir, attempt, "exit", {
            state: "exited",
            exitAt: now.toISOString(),
            exitSource: "confirmed",
            exitCode: notice.code,
            providerStatus: notice.providerStatus,
            retryAt: notice.retryAt
        }, now.toISOString());
        return true;
    }
    if (attempt.pid !== null && !alive(attempt.pid))
    {
        patchAttempt(storeDir, attempt, "exit", {
            state: "exited",
            exitAt: now.toISOString(),
            exitSource: "vanished"
        }, now.toISOString());
        return true;
    }
    if (now.getTime() > beatDeadline(attempt))
    {
        patchAttempt(storeDir, attempt, "exit", {
            state: "exited",
            exitAt: now.toISOString(),
            exitSource: "stale"
        }, now.toISOString());
        return true;
    }
    return false;
}

/* ── settlement ────────────────────────────────────────────────────── */

interface Validation
{
    verdict: AttemptVerdict;
    reasons: string[];
    hashes: Record<string, string>;
}

function classify(attempt: AttemptRecord): AttemptVerdict | null
{
    if (attempt.cancelRequested)
    {
        return "cancelled";
    }
    if (attempt.exitSource !== "confirmed")
    {
        return "stale";
    }
    if (attempt.providerStatus === "capacity")
    {
        return "capacity";
    }
    return null;
}

// Exit code zero is a claim, not a result. Nothing is called a success until
// the declared outputs exist and the validation contract passes.
function validate(storeDir: string, attempt: AttemptRecord, policy: OvernightPolicy | null): Validation
{
    const early = classify(attempt);
    if (early !== null)
    {
        return { verdict: early, reasons: [reasonFor(early, attempt)], hashes: {} };
    }
    const reasons: string[] = [];
    if (attempt.exitCode !== 0)
    {
        reasons.push(`the process exited with code ${attempt.exitCode}`);
    }
    const hashes: Record<string, string> = {};
    for (const path of attempt.declared)
    {
        if (!existsSync(path) || statSync(path).size === 0)
        {
            reasons.push(`declared output "${basename(path)}" is missing or empty`);
            continue;
        }
        hashes[basename(path)] = sha256(readFileSync(path));
    }
    if (attempt.declared.length === 0 && attempt.completes)
    {
        reasons.push("an attempt that completes work must declare at least one output");
    }
    if (attempt.requireReport && (readSpool(storeDir, attempt.id, "report.md") ?? "").trim() === "")
    {
        reasons.push("the run left no report in its spool");
    }
    if (attempt.completes && policy?.requireHardModel != null && attempt.model !== policy.requireHardModel)
    {
        reasons.push(`implementation must run on ${policy.requireHardModel}, not ${attempt.model ?? "an unnamed model"}`);
    }
    return { verdict: reasons.length === 0 ? "passed" : "failed", reasons, hashes };
}

function reasonFor(verdict: AttemptVerdict, attempt: AttemptRecord): string
{
    if (verdict === "cancelled")
    {
        return "cancelled by the user";
    }
    if (verdict === "capacity")
    {
        return `provider reported no capacity${attempt.retryAt === null ? "" : `, retry after ${attempt.retryAt}`}`;
    }
    return attempt.exitSource === "stale"
        ? `no heartbeat for ${attempt.heartbeatSec}s — the run is stale, not finished`
        : "the process disappeared without writing an exit notice";
}

function sha256(bytes: Buffer): string
{
    return createHash("sha256").update(bytes).digest("hex");
}

function usageOf(storeDir: string, attempt: AttemptRecord): { costUsd: number | null; usage: number | null }
{
    const raw = readSpool(storeDir, attempt.id, "usage.json");
    const parsed = raw === null ? {} : safeJson(raw);
    return {
        costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : null,
        usage: typeof parsed.usage === "number" ? parsed.usage : null
    };
}

export function settle(ctx: CliContext, attempt: AttemptRecord, now: Date): void
{
    const policy = loadPolicy(ctx.storeDir, attempt.project);
    const result = validate(ctx.storeDir, attempt, policy);
    const cost = usageOf(ctx.storeDir, attempt);
    const ts = now.toISOString();
    if (result.verdict === "capacity")
    {
        const retryAt = attempt.retryAt ?? new Date(now.getTime() + 3_600_000).toISOString();
        patchAttempt(ctx.storeDir, attempt, "capacity", {
            state: "waiting-capacity",
            verdict: null,
            reasons: result.reasons,
            retryAt,
            exitSource: null,
            pid: null,
            ...cost
        }, ts);
        syncEvent(ctx, attempt, "attempt.waiting", { text: `${attempt.id} waiting on provider capacity until ${retryAt}`, attempt: attempt.id, retryAt });
        return;
    }
    patchAttempt(ctx.storeDir, attempt, "settle", {
        state: "settled",
        settledAt: ts,
        verdict: result.verdict,
        reasons: result.reasons,
        hashes: result.hashes,
        pid: null,
        ...cost
    }, ts);
    attachReport(ctx, attempt, result, now);
    syncEvent(ctx, attempt, "attempt.settled", {
        text: `${attempt.work} attempt ${attempt.id} ${result.verdict}${result.reasons.length === 0 ? "" : ` — ${result.reasons[0]}`}`,
        attempt: attempt.id,
        verdict: result.verdict,
        reasons: result.reasons,
        hashes: result.hashes,
        report: attempt.reportEventId,
        costUsd: cost.costUsd,
        usage: cost.usage
    });
    if (result.verdict === "failed" || result.verdict === "stale")
    {
        scheduleRetry(ctx, attempt, result, now);
    }
}

// One report per attempt, whatever the supervisor is told twice. The event id
// is written back into the journal, so a duplicate exit notice finds the work
// already reported and stops there.
function attachReport(ctx: CliContext, attempt: AttemptRecord, result: Validation, now: Date): void
{
    if (attempt.reportEventId !== null)
    {
        return;
    }
    const prose = redact((readSpool(ctx.storeDir, attempt.id, "report.md") ?? "").trim()).slice(0, REPORT_CAP);
    const hashLine = Object.entries(result.hashes).map(([name, hash]) => `${name} ${hash.slice(0, 12)}`).join(", ");
    const lines = [
        `attempt ${attempt.id} (${attempt.runtime}${attempt.model === null ? "" : `/${attempt.model}`}) — ${result.verdict}`,
        ...result.reasons.map((reason) => `- ${reason}`),
        hashLine === "" ? "" : `outputs: ${hashLine}`,
        prose === "" ? "" : "",
        prose
    ].filter((line) => line !== "");
    const payload: Record<string, unknown> = { text: lines.join("\n") };
    const refs: EventRefs = { work: attempt.work };
    if (result.verdict === "passed" && attempt.declared.length > 0)
    {
        const metas = ingestArtifacts(ctx.storeDir, attempt.project, attempt.declared);
        payload.artifacts = metas;
        refs.artifacts = metas.map((meta) => meta.id);
    }
    const event = record(ctx, attempt.project, "report.added", payload, refs, `${attempt.work} attempt ${attempt.id} ${result.verdict}`);
    patchAttempt(ctx.storeDir, attempt, "reported", { reportEventId: event }, now.toISOString());
    completeWork(ctx, attempt, result, now);
}

// Physical completion is not semantic completion. Work is only done when the
// attempt that declared it would passed validation and every review the
// policy requires has already passed in its own session.
function completeWork(ctx: CliContext, attempt: AttemptRecord, result: Validation, now: Date): void
{
    if (!attempt.completes || result.verdict !== "passed")
    {
        return;
    }
    const policy = loadPolicy(ctx.storeDir, attempt.project);
    if (policy?.requireFreshReview === true && attempt.kind !== "review")
    {
        patchAttempt(ctx.storeDir, attempt, "await-review", {
            reasons: [...attempt.reasons, "a fresh review session must pass before this work is done"]
        }, now.toISOString());
        record(ctx, attempt.project, "attempt.awaiting-review",
            { text: `${attempt.work} passed ${attempt.id} and is waiting on a fresh review session`, attempt: attempt.id },
            { work: attempt.work }, `${attempt.work} awaiting fresh review`);
        return;
    }
    record(ctx, attempt.project, "work.done", { work: attempt.work }, undefined, `${attempt.work} completed by ${attempt.id}`);
}

function scheduleRetry(ctx: CliContext, attempt: AttemptRecord, result: Validation, now: Date): void
{
    const deterministic = result.verdict === "failed" && attempt.exitSource === "confirmed" && attempt.exitCode === 0;
    if (deterministic || attempt.tries > attempt.maxRetries)
    {
        return;
    }
    patchAttempt(ctx.storeDir, attempt, "retry", {
        state: "registered",
        verdict: null,
        exitSource: null,
        exitCode: null,
        exitAt: null,
        settledAt: null,
        reportEventId: null
    }, now.toISOString());
}

/* ── dispatch ──────────────────────────────────────────────────────── */

// Returns null when the attempt may launch, "" when it is simply not a
// candidate, and a sentence when something the user should see refused it.
export function considerDispatch(ctx: CliContext, attempts: AttemptRecord[], attempt: AttemptRecord, now: Date): string | null
{
    if (attempt.command === null || (attempt.state !== "registered" && attempt.state !== "waiting-capacity" && attempt.state !== "waiting-approval"))
    {
        return "";
    }
    const policy = loadPolicy(ctx.storeDir, attempt.project);
    const gate = dispatchRefusal(ctx, attempts, attempt, policy, now);
    if (gate !== null)
    {
        return gate;
    }
    const refusal = policyRefusal(policy, attempt.project, attempt.riskClass, attempt.kind, now);
    return refusal === null ? null : refusal.reason;
}

// The gates that hold whether or not a policy exists: approval, forbidden
// actions, dependencies, leases, capacity resets, and the breaker.
export function dispatchRefusal(
    ctx: CliContext,
    attempts: AttemptRecord[],
    attempt: AttemptRecord,
    policy: OvernightPolicy | null,
    now: Date
): string | null
{
    const forbidden = forbiddenAction(attempt.actions);
    if (forbidden !== null)
    {
        return `"${forbidden}" is never allowed without human approval`;
    }
    if (attempt.cancelRequested)
    {
        return "cancelled by the user";
    }
    if (attempt.needsApproval && !attempt.approved)
    {
        return "waiting on human approval";
    }
    if (attempt.retryAt !== null && now.toISOString() < attempt.retryAt)
    {
        return `waiting on provider capacity until ${attempt.retryAt}`;
    }
    const pending = unmetDependency(ctx, attempt);
    if (pending !== null)
    {
        return `waiting on ${pending}`;
    }
    const held = heldLeases(attempts).get(attempt.lease ?? "");
    if (attempt.lease !== null && held !== undefined && held !== attempt.id)
    {
        return `lease "${attempt.lease}" is held by ${held}`;
    }
    const threshold = policy?.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD;
    if (circuitOpen(ctx.storeDir, circuitKey(attempt), threshold))
    {
        return `the circuit for ${circuitKey(attempt)} is open after ${threshold} failures`;
    }
    const running = attempts.filter((item) => item.project === attempt.project && item.state === "running").length;
    if (policy !== null && running >= policy.maxConcurrent)
    {
        return `already running ${running} of ${policy.maxConcurrent} allowed at once`;
    }
    return budgetRefusal(attempts, attempt, policy);
}

function budgetRefusal(attempts: AttemptRecord[], attempt: AttemptRecord, policy: OvernightPolicy | null): string | null
{
    if (policy?.budgetUsd == null)
    {
        return null;
    }
    const spent = attempts
        .filter((item) => item.project === attempt.project && item.costUsd !== null)
        .reduce((total, item) => total + (item.costUsd ?? 0), 0);
    return spent >= policy.budgetUsd ? `the overnight budget of $${policy.budgetUsd} is spent` : null;
}

function unmetDependency(ctx: CliContext, attempt: AttemptRecord): string | null
{
    if (attempt.dependsOn.length === 0)
    {
        return null;
    }
    const works = buildModel(ctx.storeDir, attempt.project, new Date()).works;
    const pending = attempt.dependsOn.filter((id) => works.find((work) => work.id === id)?.status !== "done");
    return pending.length === 0 ? null : pending.join(", ");
}

// The wrapper, not the daemon, owns the exit notice: the run must be able to
// finish correctly even if the supervisor dies the moment after it starts.
export function launch(ctx: CliContext, attempt: AttemptRecord, now: Date): void
{
    clearExitNotice(ctx.storeDir, attempt);
    const out = quote(spoolFile(ctx.storeDir, attempt.id, "stdout"));
    const err = quote(spoolFile(ctx.storeDir, attempt.id, "stderr"));
    const exit = quote(spoolFile(ctx.storeDir, attempt.id, "exit"));
    const tmp = quote(spoolFile(ctx.storeDir, attempt.id, "exit.part"));
    const script = `( ${attempt.command} ) > ${out} 2> ${err}; printf %s "$?" > ${tmp}; mv ${tmp} ${exit}`;
    const cwd = resolveProjectPath(ctx.storeDir, attempt.project) ?? ctx.workspaceDir;
    // The run needs to know where to leave its report and usage numbers; the
    // spool is the only channel that never syncs.
    const env = {
        ...process.env,
        SUPERSELF_ATTEMPT: attempt.id,
        SUPERSELF_SPOOL: spoolDir(ctx.storeDir, attempt.id)
    };
    const child = spawn("/bin/sh", ["-c", script], { cwd, detached: true, stdio: "ignore", env });
    child.unref();
    const ts = now.toISOString();
    patchAttempt(ctx.storeDir, attempt, "start", {
        state: "running",
        pid: child.pid ?? null,
        startedAt: ts,
        lastBeat: ts,
        tries: attempt.tries + 1,
        retryAt: null
    }, ts);
    wakeWork(ctx, attempt, ts);
    syncEvent(ctx, attempt, "attempt.started", {
        text: `${attempt.work} attempt ${attempt.id} started on ${attempt.runtime}`,
        attempt: attempt.id
    });
}

// A relaunch must not inherit the previous run's exit notice, or the next
// reconcile would settle a process that has not started yet.
function clearExitNotice(storeDir: string, attempt: AttemptRecord): void
{
    spoolDir(storeDir, attempt.id);
    for (const name of ["exit", "exit.part", "provider.json"])
    {
        rmSync(spoolFile(storeDir, attempt.id, name), { force: true });
    }
}

// A dependency finishing is what makes the next unit ready; recording the
// wake keeps the reason visible in the log instead of a unit that silently
// changed state overnight.
function wakeWork(ctx: CliContext, attempt: AttemptRecord, ts: string): void
{
    const work = buildModel(ctx.storeDir, attempt.project, new Date(ts)).works.find((item) => item.id === attempt.work);
    if (work === undefined)
    {
        return;
    }
    if (work.status === "blocked" && work.blockedOn === "dependency")
    {
        record(ctx, attempt.project, "work.unblocked", { work: attempt.work }, undefined, `${attempt.work} dependency met`);
    }
    if (work.status === "next")
    {
        record(ctx, attempt.project, "work.started", { work: attempt.work }, undefined, `${attempt.work} ${work.outcome}`);
    }
}

/* ── synced events ─────────────────────────────────────────────────── */

export function syncEvent(ctx: CliContext, attempt: AttemptRecord, type: string, payload: Record<string, unknown>): void
{
    record(ctx, attempt.project, type, payload, { work: attempt.work }, String(payload.text ?? attempt.id));
}

export function record(
    ctx: CliContext,
    slug: string,
    type: string,
    payload: Record<string, unknown>,
    refs: EventRefs | undefined,
    summary: string
): string
{
    const projectDir = resolveProjectPath(ctx.storeDir, slug) ?? undefined;
    const event = makeEvent(slug, type, payload, refs);
    recordEvent({ ...ctx, project: slug, projectDir }, event, summary);
    return event.id;
}

export function registeredProjects(ctx: CliContext): string[]
{
    return readRegistry(ctx.storeDir).map((entry) => entry.slug);
}

function quote(path: string): string
{
    return `'${path.replace(/'/g, "'\\''")}'`;
}
