import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ingestStagedArtifact } from "../artifact.js";
import { artifactId, ulid } from "../ids.js";
import { eventExists } from "../logfile.js";
import { WorkState, buildModel } from "../model.js";
import { CliContext, ensureDir } from "../paths.js";
import { ArtifactMeta, EventRefs } from "../types.js";
import {
    AttemptRecord,
    AttemptVerdict,
    EnvelopeSummary,
    SettlementPlan,
    patchAttempt
} from "./attempt.js";
import { checkEnvelope } from "./envelope.js";
import { generation } from "./lock.js";
import { readRun, runDir, writeLocalBytesDurable } from "./local.js";
import { OvernightPolicy } from "./policy.js";
import { redact, scrubPaths } from "./sanitize.js";

const REPORT_CAP = 4000;

interface StagedOutput
{
    label: string;
    name: string;
    hash: string;
    staged: string;
}

export interface Validation
{
    verdict: AttemptVerdict;
    reasons: string[];
    staged: StagedOutput[];
    // Recorded alongside the verdict so the envelope the supervisor judged is
    // the one it stores, rather than a second read of a file that may have
    // changed in between.
    envelope: EnvelopeSummary | null;
}

/* ── declared outputs ──────────────────────────────────────────────── */

// Two declared outputs can share a basename, and a report that keyed them by
// basename alone would silently drop one and hash-attach the other under its
// neighbour's name. Labels stay readable but are made unique.
function outputLabels(paths: string[]): string[]
{
    const counts = new Map<string, number>();
    for (const path of paths)
    {
        const name = basename(path);
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const used = new Set<string>();
    return paths.map((path) =>
    {
        const name = basename(path);
        if ((counts.get(name) ?? 0) === 1)
        {
            used.add(name);
            return name;
        }
        const parent = basename(dirname(path));
        let label = parent === "" || parent === "." ? name : `${parent}/${name}`;
        let suffix = 2;
        while (used.has(label))
        {
            label = `${parent}/${name}#${suffix}`;
            suffix += 1;
        }
        used.add(label);
        return label;
    });
}

function sha256(bytes: Buffer): string
{
    return createHash("sha256").update(bytes).digest("hex");
}

function safeName(label: string): string
{
    return label.replace(/[^A-Za-z0-9._-]/g, "_");
}

// One read decides everything. The bytes that are hashed are the bytes that
// are staged, and ingestion later copies the staged file — so nothing the
// declared output does between validation and attachment can make the stored
// artifact differ from the hash that was published for it.
function stageOutputs(storeDir: string, attempt: AttemptRecord): { staged: StagedOutput[]; missing: string[] }
{
    const labels = outputLabels(attempt.declared);
    const dir = ensureDir(join(runDir(storeDir, attempt.id, attempt.fence), "staged"));
    const staged: StagedOutput[] = [];
    const missing: string[] = [];
    attempt.declared.forEach((path, index) =>
    {
        const label = labels[index];
        if (!existsSync(path))
        {
            missing.push(`declared output "${label}" is missing or empty`);
            return;
        }
        const fd = openSync(path, "r");
        let bytes: Buffer;
        try
        {
            if (fstatSync(fd).size === 0)
            {
                missing.push(`declared output "${label}" is missing or empty`);
                return;
            }
            bytes = readFileSync(fd);
        }
        finally
        {
            closeSync(fd);
        }
        const target = join(dir, safeName(label));
        writeLocalBytesDurable(target, bytes);
        staged.push({ label, name: basename(path), hash: sha256(bytes), staged: target });
    });
    return { staged, missing };
}

/* ── validation ────────────────────────────────────────────────────── */

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

export function reasonFor(verdict: AttemptVerdict, attempt: AttemptRecord): string
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

// Exit code zero is a claim, not a result. Nothing is called a success until
// a completion envelope correlated to this launch says what was produced, the
// declared outputs exist and hash, the validation contract passes, and the
// coverage the envelope claims reaches the unit's current revision.
export function validate(
    ctx: CliContext,
    attempt: AttemptRecord,
    work: WorkState | undefined,
    policy: OvernightPolicy | null
): Validation
{
    const early = classify(attempt);
    if (early !== null)
    {
        return { verdict: early, reasons: [reasonFor(early, attempt)], staged: [], envelope: null };
    }
    const reasons: string[] = [];
    if (attempt.exitCode !== 0)
    {
        reasons.push(`the process exited with code ${attempt.exitCode}`);
    }
    const { staged, missing } = stageOutputs(ctx.storeDir, attempt);
    reasons.push(...missing);
    if (attempt.declared.length === 0 && attempt.completes)
    {
        reasons.push("an attempt that completes work must declare at least one output");
    }
    if (attempt.requireReport && (readRun(ctx.storeDir, attempt.id, attempt.fence, "report.md") ?? "").trim() === "")
    {
        reasons.push("the run left no report in its spool");
    }
    const envelope = checkEnvelope(ctx.storeDir, attempt, work);
    reasons.push(...envelope.reasons);
    reasons.push(...modelPolicyReasons(attempt, envelope.summary, policy));
    if (envelope.refused)
    {
        return { verdict: "refused", reasons, staged, envelope: envelope.summary };
    }
    if (reasons.length === 0)
    {
        return { verdict: "passed", reasons, staged, envelope: envelope.summary };
    }
    // A specification that moved is not a run that failed, and the difference
    // is what tells the user to re-scope rather than to re-run.
    const onlyCoverage = envelope.revisionMismatch && reasons.every((reason) => envelope.reasons.includes(reason));
    return { verdict: onlyCoverage ? "revision_required" : "failed", reasons, staged, envelope: envelope.summary };
}

function modelPolicyReasons(
    attempt: AttemptRecord,
    summary: { resolvedModel: string | null; modelResolution: string } | null,
    policy: OvernightPolicy | null
): string[]
{
    if (!attempt.completes || policy?.requireHardModel == null)
    {
        return [];
    }
    const required = policy.requireHardModel;
    if (summary === null)
    {
        return [`implementation must run on ${required}, and no completion envelope named the model that answered`];
    }
    if (summary.modelResolution !== "exact")
    {
        return [`implementation must run on ${required}, but the run reported its model as ${summary.modelResolution} rather than naming it`];
    }
    const resolved = summary.resolvedModel ?? "";
    return resolved === required || resolved.includes(required)
        ? []
        : [`implementation must run on ${required}, not ${resolved === "" ? "an unnamed model" : resolved}`];
}

export function usageOf(storeDir: string, attempt: AttemptRecord): { costUsd: number | null; usage: number | null }
{
    const raw = readRun(storeDir, attempt.id, attempt.fence, "usage.json");
    let parsed: Record<string, unknown> = {};
    try
    {
        parsed = raw === null ? {} : JSON.parse(raw) as Record<string, unknown>;
    }
    catch
    {
        parsed = {};
    }
    return {
        costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : null,
        usage: typeof parsed.usage === "number" ? parsed.usage : null
    };
}

/* ── the settlement transaction ────────────────────────────────────── */

export interface SettleDeps
{
    record: (ctx: CliContext, slug: string, type: string, payload: Record<string, unknown>, refs: EventRefs | undefined, summary: string, id: string) => void;
}

function planFor(
    attempt: AttemptRecord,
    result: Validation,
    cost: { costUsd: number | null; usage: number | null },
    policy: OvernightPolicy | null
): SettlementPlan
{
    const hashes: Record<string, string> = {};
    for (const output of result.staged)
    {
        hashes[output.label] = output.hash;
    }
    const attaches = result.verdict === "passed" && result.staged.length > 0;
    return {
        key: `${attempt.id}:${attempt.fence}:${attempt.tries}`,
        verdict: result.verdict,
        reasons: result.reasons,
        hashes,
        staged: attaches
            ? result.staged.map((output) => ({ label: output.label, name: output.name, artifactId: artifactId() }))
            : [],
        reportEventId: ulid(),
        settledEventId: ulid(),
        workEventId: ulid(),
        workEventType: workEventType(attempt, result, policy),
        costUsd: cost.costUsd,
        usage: cost.usage,
        owner: generation()
    };
}

// Physical completion is not semantic completion. Work is only done when the
// attempt that declared it would passed validation and every review the
// policy requires has already passed in its own session.
function workEventType(attempt: AttemptRecord, result: Validation, policy: OvernightPolicy | null): string | null
{
    if (!attempt.completes || result.verdict !== "passed")
    {
        return null;
    }
    return policy?.requireFreshReview === true && attempt.kind !== "review"
        ? "attempt.awaiting-review"
        : "work.done";
}

// Opening the transaction is one durable write that names every id the
// settlement will use. Everything after it is replayable: each effect asks
// whether its own id is already on record before doing anything.
export function beginSettlement(
    ctx: CliContext,
    attempt: AttemptRecord,
    result: Validation,
    cost: { costUsd: number | null; usage: number | null },
    policy: OvernightPolicy | null,
    ts: string
): SettlementPlan
{
    const plan = planFor(attempt, result, cost, policy);
    patchAttempt(ctx.storeDir, attempt, "settle.begin", {
        settlement: plan,
        settlementSteps: [],
        settlementCommitted: false
    }, ts);
    return plan;
}

function stepDone(attempt: AttemptRecord, step: string): boolean
{
    return attempt.settlementSteps.includes(step);
}

function markStep(ctx: CliContext, attempt: AttemptRecord, step: string, ts: string): void
{
    patchAttempt(ctx.storeDir, attempt, "settle.step", {
        settlementSteps: [...attempt.settlementSteps, step]
    }, ts);
}

// Runs the plan to completion, from wherever it stopped. Every step is safe
// to run twice, so a crash between any two of them converges to exactly one
// committed outcome: no duplicate report, no duplicate artifact, no second
// work transition.
export function runSettlement(ctx: CliContext, attempt: AttemptRecord, deps: SettleDeps, ts: string): void
{
    const plan = attempt.settlement;
    if (plan === null || attempt.settlementCommitted)
    {
        return;
    }
    const artifacts = attachArtifacts(ctx, attempt, plan, ts);
    writeReport(ctx, attempt, plan, artifacts, deps, ts);
    writeWorkEvent(ctx, attempt, plan, deps, ts);
    writeSettledEvent(ctx, attempt, plan, deps, ts);
    commitSettlement(ctx, attempt, plan, ts);
}

function attachArtifacts(ctx: CliContext, attempt: AttemptRecord, plan: SettlementPlan, ts: string): ArtifactMeta[]
{
    const staged = join(runDir(ctx.storeDir, attempt.id, attempt.fence), "staged");
    const metas = plan.staged
        .filter((entry) => existsSync(join(staged, safeName(entry.label))))
        .map((entry) => ingestStagedArtifact(ctx.storeDir, attempt.project, entry.artifactId, entry.name, join(staged, safeName(entry.label))));
    if (!stepDone(attempt, "artifacts"))
    {
        markStep(ctx, attempt, "artifacts", ts);
    }
    return metas;
}

function writeReport(ctx: CliContext, attempt: AttemptRecord, plan: SettlementPlan, artifacts: ArtifactMeta[], deps: SettleDeps, ts: string): void
{
    if (!eventExists(ctx.storeDir, attempt.project, plan.reportEventId))
    {
        const payload: Record<string, unknown> = { text: reportText(ctx, attempt, plan) };
        const refs: EventRefs = { work: attempt.work };
        if (artifacts.length > 0)
        {
            payload.artifacts = artifacts;
            refs.artifacts = artifacts.map((meta) => meta.id);
        }
        deps.record(ctx, attempt.project, "report.added", payload, refs,
            `${attempt.work} attempt ${attempt.id} ${plan.verdict}`, plan.reportEventId);
    }
    if (!stepDone(attempt, "report"))
    {
        patchAttempt(ctx.storeDir, attempt, "settle.step", {
            settlementSteps: [...attempt.settlementSteps, "report"],
            reportEventId: plan.reportEventId
        }, ts);
    }
}

function reportText(ctx: CliContext, attempt: AttemptRecord, plan: SettlementPlan): string
{
    const prose = scrubPaths(ctx, redact((readRun(ctx.storeDir, attempt.id, attempt.fence, "report.md") ?? "").trim())).slice(0, REPORT_CAP);
    const hashLine = Object.entries(plan.hashes).map(([label, hash]) => `${label} ${hash.slice(0, 12)}`).join(", ");
    const model = attempt.envelope?.resolvedModel ?? attempt.model;
    return [
        `attempt ${attempt.id} (${attempt.runtime}${model === null ? "" : `/${model}`}) — ${plan.verdict}`,
        ...plan.reasons.map((reason) => `- ${scrubPaths(ctx, reason)}`),
        hashLine === "" ? "" : `outputs: ${hashLine}`,
        prose
    ].filter((line) => line !== "").join("\n");
}

function writeWorkEvent(ctx: CliContext, attempt: AttemptRecord, plan: SettlementPlan, deps: SettleDeps, ts: string): void
{
    if (plan.workEventType !== null && !eventExists(ctx.storeDir, attempt.project, plan.workEventId))
    {
        const payload = plan.workEventType === "work.done"
            ? { work: attempt.work }
            : { text: `${attempt.work} passed ${attempt.id} and is waiting on a fresh review session`, attempt: attempt.id };
        const summary = plan.workEventType === "work.done"
            ? `${attempt.work} completed by ${attempt.id}`
            : `${attempt.work} awaiting fresh review`;
        deps.record(ctx, attempt.project, plan.workEventType, payload, { work: attempt.work }, summary, plan.workEventId);
    }
    if (!stepDone(attempt, "work"))
    {
        markStep(ctx, attempt, "work", ts);
    }
}

function writeSettledEvent(ctx: CliContext, attempt: AttemptRecord, plan: SettlementPlan, deps: SettleDeps, ts: string): void
{
    if (!eventExists(ctx.storeDir, attempt.project, plan.settledEventId))
    {
        deps.record(ctx, attempt.project, "attempt.settled", {
            text: `${attempt.work} attempt ${attempt.id} ${plan.verdict}${plan.reasons.length === 0 ? "" : ` — ${scrubPaths(ctx, plan.reasons[0])}`}`,
            attempt: attempt.id,
            verdict: plan.verdict,
            reasons: plan.reasons.map((reason) => scrubPaths(ctx, reason)),
            hashes: plan.hashes,
            report: plan.reportEventId,
            resolvedModel: attempt.envelope?.resolvedModel ?? null,
            modelResolution: attempt.envelope?.modelResolution ?? null,
            requirements: attempt.envelope?.requirements ?? [],
            costUsd: plan.costUsd,
            usage: plan.usage
        }, { work: attempt.work }, `${attempt.work} attempt ${attempt.id} ${plan.verdict}`, plan.settledEventId);
    }
    if (!stepDone(attempt, "settled"))
    {
        markStep(ctx, attempt, "settled", ts);
    }
}

// The one write that makes the outcome semantic. Until it lands the attempt
// is still "exited" and the next tick resumes the same plan; after it lands
// no tick will ever plan this settlement again.
function commitSettlement(ctx: CliContext, attempt: AttemptRecord, plan: SettlementPlan, ts: string): void
{
    patchAttempt(ctx.storeDir, attempt, "settle.commit", {
        state: "settled",
        settledAt: ts,
        verdict: plan.verdict,
        reasons: plan.reasons,
        hashes: plan.hashes,
        pid: null,
        costUsd: plan.costUsd,
        usage: plan.usage,
        reportEventId: plan.reportEventId,
        settlementCommitted: true
    }, ts);
}

export function currentWork(ctx: CliContext, attempt: AttemptRecord, now: Date): WorkState | undefined
{
    return buildModel(ctx.storeDir, attempt.project, now).works.find((item) => item.id === attempt.work);
}
