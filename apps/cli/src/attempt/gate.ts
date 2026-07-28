import { copyFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { commitStaged, stageArtifacts } from "../artifact.js";
import { readEvents } from "../logfile.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { CliContext } from "../paths.js";
import { sha256File as hashFile } from "../repo.js";
import { CliError, EventRefs } from "../types.js";
import { runBounded } from "./boundary.js";
import { AttemptPlan, ArtifactPlan } from "./plan.js";
import { redact } from "./redact.js";
import { Spool } from "./spool.js";

export interface ResultArtifact
{
    name: string;
    sha256: string;
    bytes: number;
}

export interface ResultEnvelope
{
    status: string;
    summary?: string;
    artifacts?: ResultArtifact[];
    evidence?: { kind: string; ref: string }[];
    failure?: { class?: string; message?: string };
}

export interface GateFailure
{
    reason: string;
}

export interface GateSuccess
{
    published: { name: string; dest: string; sha256: string; bytes: number }[];
    reported: boolean;
    reportSkipped: boolean;
}

type ProjectContext = CliContext & { project: string; projectDir: string };

// Nothing here trusts the agent's word. An exit code says the process ended, a
// summary says the agent believes it succeeded, and neither is evidence that
// the declared file exists, holds what was declared, or reached the record.
export function verifyDeclarations(plan: AttemptPlan, spool: Spool, envelope: ResultEnvelope | null): GateFailure | null
{
    if (envelope === null)
    {
        return { reason: "the attempt produced no structured result envelope — an exit code alone is not a result" };
    }
    if (envelope.status !== "completed")
    {
        return { reason: `the result envelope reports status "${envelope.status}"` };
    }
    const declared = envelope.artifacts ?? [];
    for (const artifact of plan.artifacts)
    {
        const claim = declared.find((item) => item.name === artifact.name);
        if (claim === undefined)
        {
            return { reason: `the plan declared artifact "${artifact.name}" and the result envelope does not carry it` };
        }
        const failure = verifyStaged(artifact, claim, spool);
        if (failure !== null)
        {
            return failure;
        }
    }
    return null;
}

function verifyStaged(artifact: ArtifactPlan, claim: ResultArtifact, spool: Spool): GateFailure | null
{
    const staged = spool.path("out", artifact.name);
    if (!existsSync(staged))
    {
        return { reason: `artifact "${artifact.name}" was claimed in the result envelope but no file was written` };
    }
    const bytes = statSync(staged).size;
    if (bytes !== claim.bytes)
    {
        return { reason: `artifact "${artifact.name}" is ${bytes} bytes and the result envelope declared ${claim.bytes}` };
    }
    if (artifact.minBytes !== undefined && bytes < artifact.minBytes)
    {
        return { reason: `artifact "${artifact.name}" is ${bytes} bytes, below the ${artifact.minBytes} the plan requires` };
    }
    const actual = sha256File(staged);
    if (actual !== claim.sha256)
    {
        return { reason: `artifact "${artifact.name}" hashes to ${actual.slice(0, 16)} and the result envelope declared ${claim.sha256.slice(0, 16)}` };
    }
    return null;
}

// The repository hashes bytes the same way for a review receipt, and one
// digest function keeps a gate and a receipt binding to the same value. It
// answers null for a path that is missing or a directory; the gate hashes only
// a file it has just verified, so null here is a bug rather than a verdict.
export function sha256File(path: string): string
{
    const digest = hashFile(path);
    if (digest === null)
    {
        throw new CliError(`cannot hash "${path}": it is not a readable file`);
    }
    return digest;
}

export interface Published
{
    name: string;
    dest: string;
    sha256: string;
    bytes: number;
}

// Published through a temporary name inside the destination directory and then
// renamed: a reader watching that path sees the finished file or nothing, and
// never the half of it that a crash mid-copy would leave.
export function publishArtifacts(plan: AttemptPlan, spool: Spool, attemptId: string): { published: Published[]; failure: GateFailure | null }
{
    const published: Published[] = [];
    for (const artifact of plan.artifacts)
    {
        if (existsSync(artifact.dest))
        {
            return { published, failure: { reason: `artifact destination "${artifact.dest}" already exists — an attempt never overwrites a published artifact` } };
        }
        const staged = spool.path("out", artifact.name);
        const temp = join(dirname(artifact.dest), `.self-publish-${attemptId}-${basename(artifact.dest)}`);
        try
        {
            copyFileSync(staged, temp);
            renameSync(temp, artifact.dest);
        }
        catch (error)
        {
            rmSync(temp, { force: true });
            return { published, failure: { reason: `artifact "${artifact.name}" could not be published to ${artifact.dest}: ${(error as Error).message}` } };
        }
        published.push({ name: artifact.name, dest: artifact.dest, sha256: sha256File(artifact.dest), bytes: statSync(artifact.dest).size });
    }
    return { published, failure: null };
}

// What this attempt put there, and only that. A gate that fails after
// publishing must not leave a file the next reader would take for a result.
export function unpublish(published: Published[]): void
{
    for (const item of published)
    {
        rmSync(item.dest, { force: true });
    }
}

export async function validatePublished(plan: AttemptPlan, published: Published[]): Promise<GateFailure | null>
{
    for (const artifact of plan.artifacts)
    {
        const item = published.find((entry) => entry.name === artifact.name);
        if (item === undefined || artifact.validate === undefined || artifact.validate.length === 0)
        {
            continue;
        }
        const outcome = await runBounded(plan.boundary, [...artifact.validate, item.dest], plan.preflightTimeoutMs);
        if (outcome.code !== 0)
        {
            const detail = outcome.timedOut ? "validation did not finish in time" : (outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.code}`);
            return { reason: `declared validation of "${artifact.name}" failed: ${redact(detail)}` };
        }
    }
    return null;
}

// One attempt, one report. The attempt id travels on the event, so a rerun
// after a crash between the report and the spool update finds its own report
// already in the log and adds nothing.
export function alreadyReported(ctx: ProjectContext, attemptId: string): boolean
{
    return readEvents(ctx.storeDir, ctx.project)
        .some((event) => event.type === "report.added" && event.refs?.attempt === attemptId);
}

// The completion is exactly-once for the same reason the report is, and it
// says so here rather than in whichever caller happens to reach settlement
// twice. The folded model would survive a duplicate — it folds by attempt id —
// but the log it folds is append-only and synced.
export function alreadyCompleted(ctx: ProjectContext, attemptId: string): boolean
{
    return readEvents(ctx.storeDir, ctx.project)
        .some((event) => event.type === "run.completed" && event.refs?.attempt === attemptId);
}

export function attachReport(ctx: ProjectContext, plan: AttemptPlan, attemptId: string, envelope: ResultEnvelope, published: Published[]): boolean
{
    if (alreadyReported(ctx, attemptId))
    {
        return false;
    }
    const text = redact(envelope.summary?.trim() || `attempt ${attemptId} completed`);
    const refs: EventRefs = { work: plan.work, attempt: attemptId };
    const commits = (envelope.evidence ?? []).filter((item) => item.kind === "commit").map((item) => item.ref);
    if (commits.length > 0)
    {
        refs.commits = commits;
    }
    const payload: Record<string, unknown> = { text };
    const staged = stageArtifacts(ctx.storeDir, ctx.project, published.map((item) => item.dest));
    if (staged.artifacts.length > 0)
    {
        payload.artifacts = staged.artifacts;
        refs.artifacts = staged.artifacts.map((meta) => meta.id);
    }
    commitStaged(staged, (recorded) =>
        recordEvent(ctx, makeEvent(ctx.project, "report.added", payload, refs), `${plan.work} ${text}`, recorded));
    return true;
}
