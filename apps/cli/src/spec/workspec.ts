import { existsSync, readFileSync } from "node:fs";
import { AttemptPlan, normalizePlan, SpecPin } from "../attempt/plan.js";
import { sha256 } from "../repo.js";
import { CliError } from "../types.js";

// The desired state of one work unit's execution, as data. A WorkSpec is
// written once and applied as an immutable generation; the runner attempt it
// materializes is derived from it, never the other way round.
//
// Everything here is language-neutral machine state: it is read on a machine
// that never saw the one that wrote it, so what it names has to be either
// portable (a work id, a provider name, a model name) or resolved late (a
// relative path, resolved against the project checkout at dispatch).
export interface WorkSpec
{
    workSpecId: string;
    generation: number;
    workId: string;
    role: string;
    summary: string;
    provider: { name: string; endpoint: string };
    // The model this work asks for. Recorded and pinned onto the attempt, never
    // spliced into `command`: the runner does not rewrite an invocation its
    // author declared, so the spec states the ask and the command carries it.
    requestedModel: string;
    command: string[];
    // Handed to the attempt planner as written. Keeping these three sub-objects
    // raw is deliberate: one normalizer decides what a boundary, a capability
    // plan and an artifact declaration mean, and a second copy of those rules
    // here would be the copy that goes stale.
    boundary: Record<string, unknown>;
    capabilities: Record<string, unknown>;
    artifacts: unknown[];
    validation: SpecValidation;
    timeoutPolicy: { runMs: number; preflightMs?: number; heartbeatMs?: number };
    retryPolicy: { maxRuns: number; baseMs?: number; maxMs?: number };
    resume?: boolean;
}

// What this spec accepts as proof that the attempt did the work. Both forms
// compile onto gates the runner already enforces — a declaration that nothing
// checks is worse than no declaration at all.
export interface SpecValidation
{
    // The shape the result envelope must have: the completion gate admits only
    // `completed`, and every artifact named here must be one the spec declares,
    // which the gate then requires the envelope to carry with matching bytes.
    responseSchema?: { status: string; artifacts: string[] };
    // Every declared artifact carries its own validate command, run against the
    // published file by the completion gate.
    artifactCommands?: boolean;
}

const FIELDS = [
    "workSpecId", "generation", "workId", "role", "summary", "provider", "requestedModel",
    "command", "boundary", "capabilities", "artifacts", "validation", "timeoutPolicy",
    "retryPolicy", "resume"
];

// A generation is content, and content that differs by a field nobody reads is
// still different content. An unknown key is refused rather than dropped, so
// the digest a spec hashes to is the whole of what its author wrote.
export function normalizeSpec(raw: any): WorkSpec
{
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    {
        throw new CliError("a work spec must be a JSON object");
    }
    const unknown = Object.keys(raw).filter((key) => !FIELDS.includes(key));
    if (unknown.length > 0)
    {
        throw new CliError(`work spec carries unknown field(s) ${unknown.join(", ")} — the contract is ${FIELDS.join(", ")}`);
    }
    const spec: WorkSpec = {
        workSpecId: specId(raw.workSpecId),
        generation: generationOf(raw.generation),
        workId: requireString(raw.workId, "workId"),
        role: typeof raw.role === "string" ? raw.role : "implementation",
        summary: typeof raw.summary === "string" ? raw.summary : "",
        provider: {
            name: requireString(raw.provider?.name, "provider.name"),
            endpoint: requireString(raw.provider?.endpoint, "provider.endpoint")
        },
        requestedModel: requireString(raw.requestedModel, "requestedModel"),
        command: commandOf(raw.command),
        boundary: object(raw.boundary ?? {}, "boundary"),
        capabilities: object(raw.capabilities, "capabilities"),
        artifacts: array(raw.artifacts, "artifacts"),
        validation: validationOf(raw.validation, raw.artifacts),
        timeoutPolicy: {
            runMs: positive(raw.timeoutPolicy?.runMs, "timeoutPolicy.runMs"),
            preflightMs: optionalPositive(raw.timeoutPolicy?.preflightMs, "timeoutPolicy.preflightMs"),
            heartbeatMs: optionalPositive(raw.timeoutPolicy?.heartbeatMs, "timeoutPolicy.heartbeatMs")
        },
        retryPolicy: {
            maxRuns: positive(raw.retryPolicy?.maxRuns, "retryPolicy.maxRuns"),
            baseMs: optionalPositive(raw.retryPolicy?.baseMs, "retryPolicy.baseMs"),
            maxMs: optionalPositive(raw.retryPolicy?.maxMs, "retryPolicy.maxMs")
        }
    };
    if (raw.resume === true)
    {
        spec.resume = true;
    }
    return spec;
}

export function readSpecFile(file: string): WorkSpec
{
    if (!existsSync(file))
    {
        throw new CliError(`work spec "${file}" does not exist`);
    }
    let raw: unknown;
    try
    {
        raw = JSON.parse(readFileSync(file, "utf8"));
    }
    catch (error)
    {
        throw new CliError(`work spec "${file}" is not valid JSON: ${(error as Error).message}`);
    }
    return normalizeSpec(raw);
}

// The bytes a generation is. Keys are ordered so that the same spec written by
// two agents in two field orders is one generation rather than two, and the
// file the store seals is exactly what was hashed — `sha256File` of the sealed
// blob answers the digest in its own name.
export function specBody(spec: WorkSpec): string
{
    return JSON.stringify(canonical(spec)) + "\n";
}

export function specDigest(spec: WorkSpec): string
{
    return sha256(specBody(spec));
}

function canonical(value: unknown): unknown
{
    if (Array.isArray(value))
    {
        return value.map(canonical);
    }
    if (value === null || typeof value !== "object")
    {
        return value;
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    // Code-unit order, never collation: `localeCompare` answers with the ICU
    // collation of the process locale, and this ordering is what the content
    // address hashes — the same spec must digest identically on every machine.
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
}

// The one direction this module travels: desired state in, an attempt plan out.
// The plan normalizer decides every bound and every path, so a spec that
// compiles is a spec the runner can actually launch — which is why apply
// compiles before it seals anything.
//
// `base` is the project checkout rather than the directory the spec file came
// from: a generation is applied once and dispatched later from anywhere, so a
// relative path in it has to mean the same thing both times.
export function compileSpec(spec: WorkSpec, base: string): AttemptPlan
{
    return normalizePlan({
        work: spec.workId,
        role: spec.role,
        summary: spec.summary,
        boundary: spec.boundary,
        command: spec.command,
        capabilities: { ...spec.capabilities, provider: spec.provider },
        artifacts: spec.artifacts,
        retry: { maxRuns: spec.retryPolicy.maxRuns, baseMs: spec.retryPolicy.baseMs, maxMs: spec.retryPolicy.maxMs },
        preflightTimeoutMs: spec.timeoutPolicy.preflightMs,
        runTimeoutMs: spec.timeoutPolicy.runMs,
        heartbeatMs: spec.timeoutPolicy.heartbeatMs,
        resume: spec.resume === true
    }, base);
}

export function pinFor(spec: WorkSpec, digest: string): SpecPin
{
    return {
        workSpec: spec.workSpecId,
        generation: spec.generation,
        sha256: digest,
        requestedModel: spec.requestedModel
    };
}

// The declared artifacts, by the name the envelope has to carry them under.
// Read from the raw declaration rather than from a compiled plan, because the
// validation contract is checked while the spec is still being normalized.
function artifactNames(raw: unknown): string[]
{
    if (!Array.isArray(raw))
    {
        return [];
    }
    return raw.map((entry: any) => typeof entry?.name === "string" ? entry.name : "");
}

function validationOf(raw: any, artifacts: unknown): SpecValidation
{
    // A missing contract and an empty one are the same omission, and the
    // sentence that names both accepted forms is the useful answer to either.
    const validation = raw === undefined ? {} : object(raw, "validation");
    const schema = validation.responseSchema;
    const commands = validation.artifactCommands === true;
    if (schema === undefined && !commands)
    {
        throw new CliError("work spec `validation` must declare either a `responseSchema` the result envelope has to satisfy, or `artifactCommands: true` so every declared artifact carries its own validate command");
    }
    const contract: SpecValidation = {};
    if (schema !== undefined)
    {
        contract.responseSchema = responseSchemaOf(schema, artifacts);
    }
    if (commands)
    {
        contract.artifactCommands = requireArtifactCommands(artifacts);
    }
    return contract;
}

function responseSchemaOf(raw: any, artifacts: unknown): { status: string; artifacts: string[] }
{
    const schema = object(raw, "validation.responseSchema");
    // The completion gate admits exactly one status, so a spec asking for
    // another one is asking for a gate that does not exist.
    if (schema.status !== "completed")
    {
        throw new CliError('work spec `validation.responseSchema.status` must be "completed" — the completion gate admits no other result status');
    }
    const declared = artifactNames(artifacts);
    const required = array(schema.artifacts ?? [], "validation.responseSchema.artifacts").map((name) =>
    {
        if (typeof name !== "string" || !declared.includes(name))
        {
            throw new CliError(`work spec response schema requires artifact "${String(name)}", which the spec does not declare — the envelope is checked against the declared set`);
        }
        return name;
    });
    return { status: schema.status, artifacts: required };
}

function requireArtifactCommands(artifacts: unknown): boolean
{
    const declared = array(artifacts, "artifacts");
    if (declared.length === 0)
    {
        throw new CliError("work spec sets `validation.artifactCommands` and declares no artifact — there is nothing for a validate command to run against");
    }
    for (const entry of declared as any[])
    {
        if (!Array.isArray(entry?.validate) || entry.validate.length === 0)
        {
            throw new CliError(`work spec sets \`validation.artifactCommands\` and artifact "${String(entry?.name)}" carries no validate command`);
        }
    }
    return true;
}

// The id names the directory this spec's generations are sealed in, so it is
// held to the same rule a project slug is: one path segment, never a traversal.
const SPEC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

function specId(value: unknown): string
{
    const id = requireString(value, "workSpecId");
    if (!SPEC_ID.test(id) || id.includes(".."))
    {
        throw new CliError(`work spec id "${id}" must be a single path segment of letters, digits, dot, dash or underscore — it names the directory its generations are sealed in`);
    }
    return id;
}

// Generations are counted, not dated: they are compared, ordered, and named in
// a file name, and the padding that orders them holds six digits.
const MAX_GENERATION = 999_999;

function generationOf(value: unknown): number
{
    const generation = Number(value);
    if (!Number.isInteger(generation) || generation < 1 || generation > MAX_GENERATION)
    {
        throw new CliError(`work spec field "generation" must be a whole number between 1 and ${MAX_GENERATION}`);
    }
    return generation;
}

function commandOf(value: unknown): string[]
{
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string"))
    {
        throw new CliError("work spec field \"command\" must be a non-empty array of strings — the provider invocation this spec materializes");
    }
    return value as string[];
}

function requireString(value: unknown, field: string): string
{
    if (typeof value !== "string" || value.trim() === "")
    {
        throw new CliError(`work spec field "${field}" must be a non-empty string`);
    }
    return value;
}

function object(value: unknown, field: string): Record<string, any>
{
    if (value === null || typeof value !== "object" || Array.isArray(value))
    {
        throw new CliError(`work spec field "${field}" must be an object`);
    }
    return value as Record<string, any>;
}

function array(value: unknown, field: string): unknown[]
{
    if (!Array.isArray(value))
    {
        throw new CliError(`work spec field "${field}" must be an array`);
    }
    return value;
}

function positive(value: unknown, field: string): number
{
    const number = Number(value);
    if (value === undefined || !Number.isFinite(number) || number <= 0)
    {
        throw new CliError(`work spec field "${field}" must be a positive number`);
    }
    return number;
}

function optionalPositive(value: unknown, field: string): number | undefined
{
    return value === undefined ? undefined : positive(value, field);
}
