import { WorkState } from "../model.js";
import { AttemptRecord, EnvelopeSummary, ModelResolution } from "./attempt.js";
import { widenedCapabilities } from "./capability.js";
import { readRun } from "./local.js";

export const ENVELOPE_FILE = "completion.json";

// The one durable statement a run makes about what it did. It is correlated
// to the attempt, the work unit, the revision it was written against, and the
// fence of the launch that produced it, so a stale process or a second run
// cannot have its claim mistaken for this one's.
export interface CompletionEnvelope
{
    attempt: string;
    work: string;
    fence: number;
    completionId: string;
    workRevision: number | null;
    designRevision: number | null;
    requestedModel: string | null;
    resolvedModel: string | null;
    modelResolution: ModelResolution;
    requirements: string[];
    actions: string[];
    outputs: string[];
    validations: { name: string; status: string; detail?: string }[];
}

export interface EnvelopeCheck
{
    summary: EnvelopeSummary | null;
    reasons: string[];
    // The specification moved, or coverage does not reach it. Neither is a
    // failure of the run; both mean the work cannot be called done.
    revisionMismatch: boolean;
    // Identity, fence, or capability claims that do not hold. A run that lies
    // about which launch it is, or about what it was allowed to do, is
    // refused rather than judged on its output.
    refused: boolean;
}

function asStringArray(value: unknown): string[]
{
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asResolution(value: unknown): ModelResolution | null
{
    return value === "exact" || value === "unknown" || value === "refused" ? value : null;
}

export function readEnvelope(storeDir: string, attempt: AttemptRecord): CompletionEnvelope | null
{
    const raw = readRun(storeDir, attempt.id, attempt.fence, ENVELOPE_FILE);
    if (raw === null || raw.trim() === "")
    {
        return null;
    }
    let parsed: Record<string, unknown>;
    try
    {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    }
    catch
    {
        return null;
    }
    const resolution = asResolution(parsed.modelResolution);
    if (resolution === null)
    {
        return null;
    }
    return {
        attempt: String(parsed.attempt ?? ""),
        work: String(parsed.work ?? ""),
        fence: typeof parsed.fence === "number" ? parsed.fence : -1,
        completionId: String(parsed.completionId ?? ""),
        workRevision: typeof parsed.workRevision === "number" ? parsed.workRevision : null,
        designRevision: typeof parsed.designRevision === "number" ? parsed.designRevision : null,
        requestedModel: typeof parsed.requestedModel === "string" ? parsed.requestedModel : null,
        resolvedModel: typeof parsed.resolvedModel === "string" && parsed.resolvedModel !== "" ? parsed.resolvedModel : null,
        modelResolution: resolution,
        requirements: asStringArray(parsed.requirements),
        actions: asStringArray(parsed.actions),
        outputs: asStringArray(parsed.outputs),
        validations: Array.isArray(parsed.validations)
            ? (parsed.validations as Record<string, unknown>[])
                .filter((item) => item !== null && typeof item === "object")
                .map((item) => ({
                    name: String(item.name ?? "unnamed"),
                    status: String(item.status ?? "unknown"),
                    detail: item.detail === undefined ? undefined : String(item.detail)
                }))
            : []
    };
}

function summarize(envelope: CompletionEnvelope): EnvelopeSummary
{
    return {
        completionId: envelope.completionId,
        requestedModel: envelope.requestedModel,
        resolvedModel: envelope.resolvedModel,
        modelResolution: envelope.modelResolution,
        workRevision: envelope.workRevision,
        designRevision: envelope.designRevision,
        requirements: envelope.requirements,
        claimedActions: envelope.actions,
        validations: envelope.validations,
        outputs: envelope.outputs
    };
}

// Nothing here trusts the envelope; it only reads what the envelope says so
// the supervisor can check it against what it already knows. An exit code, a
// line of result prose, or the wrapper simply terminating never reaches this
// function, because none of them is a claim anyone can check.
export function checkEnvelope(
    storeDir: string,
    attempt: AttemptRecord,
    work: WorkState | undefined
): EnvelopeCheck
{
    const envelope = readEnvelope(storeDir, attempt);
    if (envelope === null)
    {
        return {
            summary: null,
            reasons: [`the run left no readable completion envelope — an exit code is a claim, not a result (write ${ENVELOPE_FILE} into the spool)`],
            revisionMismatch: false,
            refused: false
        };
    }
    const identity = identityReasons(attempt, envelope);
    if (identity.length > 0)
    {
        return { summary: summarize(envelope), reasons: identity, revisionMismatch: false, refused: true };
    }
    const widened = widenedCapabilities(attempt.capabilities, envelope.actions);
    if (widened.length > 0)
    {
        return {
            summary: summarize(envelope),
            reasons: [`the completion envelope claims "${widened[0]}", which the launcher never granted — a run cannot widen its own capabilities`],
            revisionMismatch: false,
            refused: true
        };
    }
    const reasons = [...modelReasons(attempt, envelope), ...validationReasons(envelope)];
    const coverage = coverageReasons(attempt, envelope, work);
    return {
        summary: summarize(envelope),
        reasons: [...reasons, ...coverage],
        revisionMismatch: coverage.length > 0,
        refused: false
    };
}

function identityReasons(attempt: AttemptRecord, envelope: CompletionEnvelope): string[]
{
    const reasons: string[] = [];
    if (envelope.attempt !== attempt.id)
    {
        reasons.push(`the completion envelope names attempt "${envelope.attempt}", not ${attempt.id}`);
    }
    if (envelope.work !== attempt.work)
    {
        reasons.push(`the completion envelope names work "${envelope.work}", not ${attempt.work}`);
    }
    if (envelope.fence !== attempt.fence)
    {
        reasons.push(`the completion envelope carries fence ${envelope.fence}, but this launch is at fence ${attempt.fence} — it was written by a superseded process`);
    }
    if (envelope.completionId.trim() === "")
    {
        reasons.push("the completion envelope has no completion id");
    }
    return reasons;
}

// Which model was asked for and which one actually answered are different
// facts, and a run that cannot name the second must say so rather than let
// the first stand in for it.
function modelReasons(attempt: AttemptRecord, envelope: CompletionEnvelope): string[]
{
    const reasons: string[] = [];
    if (attempt.requestedModel !== null && envelope.requestedModel !== attempt.requestedModel)
    {
        reasons.push(`the run was registered for model "${attempt.requestedModel}" but reports requesting "${envelope.requestedModel ?? "none"}"`);
    }
    if (envelope.modelResolution === "exact" && envelope.resolvedModel === null)
    {
        reasons.push("the completion envelope claims an exact model resolution without naming the model that answered");
    }
    return reasons;
}

function validationReasons(envelope: CompletionEnvelope): string[]
{
    return envelope.validations
        .filter((check) => check.status !== "passed" && check.status !== "skipped")
        .map((check) => `validation "${check.name}" ${check.status}${check.detail === undefined ? "" : ` — ${check.detail}`}`);
}

// Coverage is checked against the unit as it stands now, not as it stood when
// the run started. A criterion added while the agent worked is a criterion
// nobody has met, and saying so is the difference between revision_required
// and a wrongly closed unit.
function coverageReasons(attempt: AttemptRecord, envelope: CompletionEnvelope, work: WorkState | undefined): string[]
{
    if (!attempt.completes)
    {
        return [];
    }
    if (work === undefined)
    {
        return [`work ${attempt.work} is no longer in the project model — its coverage cannot be checked`];
    }
    const reasons: string[] = [];
    if (attempt.workRevision !== work.revision)
    {
        reasons.push(`${attempt.work} moved from revision ${attempt.workRevision} to ${work.revision} while the attempt ran`);
    }
    if (envelope.workRevision !== work.revision)
    {
        reasons.push(`the completion envelope covers revision ${envelope.workRevision ?? "none"} of ${attempt.work}, which is now at revision ${work.revision}`);
    }
    if (work.designRevision !== null && envelope.designRevision !== work.designRevision)
    {
        reasons.push(`the approved design of ${attempt.work} is revision ${work.designRevision}, but the run reports building against ${envelope.designRevision ?? "none"}`);
    }
    const covered = new Set(envelope.requirements);
    const missing = work.requirements.filter((requirement) => !covered.has(requirement.id));
    for (const requirement of missing)
    {
        reasons.push(`requirement ${requirement.id} is not covered: ${requirement.text}`);
    }
    const unknown = envelope.requirements.filter((id) => !work.requirements.some((item) => item.id === id));
    for (const id of unknown)
    {
        reasons.push(`the run claims to cover "${id}", which is not a requirement of ${attempt.work}`);
    }
    return reasons;
}
