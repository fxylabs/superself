import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ReviewScope, REVIEW_SCOPES, ReviewVerdict, REVIEW_VERDICTS, TestResult } from "./integration.js";
import { sha256, sha256File } from "./repo.js";
import { CliError } from "./types.js";

export const ENVELOPE_SCHEMA = "superself.review-result/1";

// The one door a review verdict can come through. A runner writes this file;
// the supervisor validates it, hashes it, and only then does a receipt exist.
// An agent's prose, its exit code and the file it claims to have written are
// not inputs here — nothing in this module reads them.
export interface ReviewEnvelope
{
    schema: string;
    changeSet: string;
    scope: ReviewScope;
    base: string;
    head: string;
    digest: string;
    verdict: ReviewVerdict;
    findings: string[];
    tests: TestResult[];
    artifact: { path: string; sha256: string; bytes: number };
    reviewer: { name: string; model: string; session?: string };
    completedAt: string;
}

export interface ValidatedEnvelope
{
    envelope: ReviewEnvelope;
    envelopeDigest: string;
    artifactPath: string;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export class EnvelopeError extends CliError
{
    readonly code: string;

    constructor(code: string, message: string)
    {
        super(`review envelope rejected [${code}]: ${message}`);
        this.code = code;
    }
}

export function readEnvelope(file: string): ValidatedEnvelope
{
    const path = resolve(file);
    if (!existsSync(path))
    {
        throw new EnvelopeError("envelope_missing", `${file} does not exist`);
    }
    const raw = parse(path);
    const envelope = validate(raw);
    const artifactPath = validateArtifact(path, envelope);
    return { envelope, envelopeDigest: sha256(canonical(raw)), artifactPath };
}

function parse(path: string): Record<string, unknown>
{
    let value: unknown;
    try
    {
        value = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error)
    {
        throw new EnvelopeError("envelope_unparsable", `${path} is not JSON: ${(error as Error).message}`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
    {
        throw new EnvelopeError("envelope_unparsable", `${path} is not a JSON object`);
    }
    return value as Record<string, unknown>;
}

function validate(raw: Record<string, unknown>): ReviewEnvelope
{
    if (raw.schema !== ENVELOPE_SCHEMA)
    {
        throw new EnvelopeError("schema_unknown", `expected "${ENVELOPE_SCHEMA}", found ${JSON.stringify(raw.schema)}`);
    }
    const envelope: ReviewEnvelope = {
        schema: ENVELOPE_SCHEMA,
        changeSet: text(raw, "changeSet"),
        scope: scope(raw),
        base: sha(raw, "base"),
        head: sha(raw, "head"),
        digest: digest(raw),
        verdict: verdict(raw),
        findings: findings(raw),
        tests: tests(raw),
        artifact: artifact(raw),
        reviewer: reviewer(raw),
        completedAt: text(raw, "completedAt")
    };
    requireEvidence(envelope);
    return envelope;
}

// An approval with nothing run behind it is a claim, not a review. The gate
// asks for the tests by name so a later reader can re-run exactly them.
function requireEvidence(envelope: ReviewEnvelope): void
{
    if (envelope.verdict === "approve" && envelope.tests.length === 0)
    {
        throw new EnvelopeError("tests_missing", "an approve verdict must list the tests it was based on");
    }
}

function text(raw: Record<string, unknown>, field: string): string
{
    const value = raw[field];
    if (typeof value !== "string" || value.trim() === "")
    {
        throw new EnvelopeError("field_missing", `"${field}" must be a non-empty string`);
    }
    return value;
}

function scope(raw: Record<string, unknown>): ReviewScope
{
    const value = raw.scope;
    if (!REVIEW_SCOPES.includes(value as ReviewScope))
    {
        throw new EnvelopeError("scope_invalid", `"scope" must be one of ${REVIEW_SCOPES.join(", ")}`);
    }
    return value as ReviewScope;
}

function verdict(raw: Record<string, unknown>): ReviewVerdict
{
    const value = raw.verdict;
    if (!REVIEW_VERDICTS.includes(value as ReviewVerdict))
    {
        throw new EnvelopeError("verdict_invalid", `"verdict" must be one of ${REVIEW_VERDICTS.join(", ")}`);
    }
    return value as ReviewVerdict;
}

function sha(raw: Record<string, unknown>, field: string): string
{
    const value = text(raw, field);
    if (!HEX40.test(value))
    {
        throw new EnvelopeError("commit_invalid", `"${field}" must be a full 40-character commit id, found "${value}"`);
    }
    return value;
}

function digest(raw: Record<string, unknown>): string
{
    const value = text(raw, "digest");
    if (!HEX64.test(value))
    {
        throw new EnvelopeError("digest_invalid", `"digest" must be a sha256 hex digest, found "${value}"`);
    }
    return value;
}

function findings(raw: Record<string, unknown>): string[]
{
    if (!Array.isArray(raw.findings))
    {
        throw new EnvelopeError("field_missing", '"findings" must be an array, empty when there are none');
    }
    return raw.findings.map((item) => typeof item === "string" ? item : JSON.stringify(item));
}

function tests(raw: Record<string, unknown>): TestResult[]
{
    if (!Array.isArray(raw.tests))
    {
        throw new EnvelopeError("field_missing", '"tests" must be an array of {name, status}');
    }
    return raw.tests.map((item, index) =>
    {
        const entry = item as Record<string, unknown>;
        if (entry === null || typeof entry !== "object" || typeof entry.name !== "string" || typeof entry.status !== "string")
        {
            throw new EnvelopeError("field_missing", `"tests[${index}]" must be {name, status} with string values`);
        }
        return { name: entry.name, status: entry.status };
    });
}

function artifact(raw: Record<string, unknown>): { path: string; sha256: string; bytes: number }
{
    const value = raw.artifact as Record<string, unknown> | undefined;
    if (value === undefined || value === null || typeof value !== "object")
    {
        throw new EnvelopeError("artifact_undeclared", '"artifact" must declare {path, sha256, bytes} for the review record');
    }
    if (typeof value.path !== "string" || typeof value.sha256 !== "string" || typeof value.bytes !== "number")
    {
        throw new EnvelopeError("artifact_undeclared", '"artifact" needs a string path, a sha256 string and a byte count');
    }
    if (!HEX64.test(value.sha256))
    {
        throw new EnvelopeError("artifact_digest_invalid", `"artifact.sha256" must be a sha256 hex digest, found "${value.sha256}"`);
    }
    return { path: value.path, sha256: value.sha256, bytes: value.bytes };
}

function reviewer(raw: Record<string, unknown>): { name: string; model: string; session?: string }
{
    const value = raw.reviewer as Record<string, unknown> | undefined;
    if (value === undefined || value === null || typeof value !== "object")
    {
        throw new EnvelopeError("reviewer_missing", '"reviewer" must declare {name, model} and may declare a session');
    }
    if (typeof value.name !== "string" || typeof value.model !== "string")
    {
        throw new EnvelopeError("reviewer_missing", '"reviewer.name" and "reviewer.model" must be strings');
    }
    return { name: value.name, model: value.model, session: typeof value.session === "string" ? value.session : undefined };
}

// The declared bytes must be on disk and must be the declared bytes. This is
// where "the review wrote its report" stops being something an agent says.
function validateArtifact(envelopeFile: string, envelope: ReviewEnvelope): string
{
    const path = artifactPath(envelopeFile, envelope.artifact.path);
    if (!existsSync(path))
    {
        throw new EnvelopeError("artifact_missing", `declared artifact "${envelope.artifact.path}" is not at ${path}`);
    }
    if (statSync(path).isDirectory())
    {
        throw new EnvelopeError("artifact_missing", `declared artifact "${envelope.artifact.path}" is a directory`);
    }
    const bytes = statSync(path).size;
    if (bytes !== envelope.artifact.bytes)
    {
        throw new EnvelopeError("artifact_size_mismatch", `declared ${envelope.artifact.bytes} bytes, found ${bytes}`);
    }
    const found = sha256File(path);
    if (found !== envelope.artifact.sha256)
    {
        throw new EnvelopeError("artifact_digest_mismatch", `declared ${envelope.artifact.sha256}, found ${found}`);
    }
    return path;
}

// The artifact travels with its envelope. A runner that names a path outside
// the envelope's own directory is asking the supervisor to copy a file it
// never produced into the store, and that is refused whatever it hashes to.
function artifactPath(envelopeFile: string, declared: string): string
{
    const root = resolve(envelopeFile, "..");
    const path = resolve(root, declared);
    const step = relative(root, path);
    if (isAbsolute(declared) || step === "" || step.startsWith(".."))
    {
        throw new EnvelopeError("artifact_outside_envelope",
            `"artifact.path" must sit beside the envelope, and "${declared}" does not`);
    }
    return path;
}

// Key order in the file must not change the digest: the same review result
// re-serialized by a different runner is the same result.
export function canonical(value: unknown): string
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonical).join(",")}]`;
    }
    if (value === null || typeof value !== "object")
    {
        return JSON.stringify(value) ?? "null";
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
}

export function reviewContract(): Record<string, unknown>
{
    return {
        schema: ENVELOPE_SCHEMA,
        transport: "a JSON file written by any runner, ingested with `self review ingest --file <path>`",
        rules: [
            "the supervisor, not the reviewing agent, ingests the envelope",
            "an exit code, a chat message or a claimed file write never creates a receipt",
            "artifact.path resolves relative to the envelope file and must match sha256 and bytes exactly",
            "digest binds the verdict to bytes: the feature diff digest for scope change, " +
                "the integration delta digest for scope integration_delta, " +
                "and the release-candidate feature digest for scope release",
            "an approve verdict must list at least one test"
        ],
        fields: {
            schema: `constant "${ENVELOPE_SCHEMA}"`,
            changeSet: "the change set id the review was bounded to",
            scope: REVIEW_SCOPES,
            base: "40-character base commit id",
            head: "40-character reviewed head commit id",
            digest: "sha256 hex digest of the reviewed bytes",
            verdict: REVIEW_VERDICTS,
            findings: "array of strings, empty when there are none",
            tests: "array of {name, status}",
            artifact: "{path, sha256, bytes} of the review record file",
            reviewer: "{name, model, session?}",
            completedAt: "ISO 8601 timestamp"
        },
        rejectionCodes: [
            "envelope_missing", "envelope_unparsable", "schema_unknown", "field_missing", "scope_invalid",
            "verdict_invalid", "commit_invalid", "digest_invalid", "tests_missing", "artifact_undeclared",
            "artifact_digest_invalid", "artifact_missing", "artifact_outside_envelope", "artifact_size_mismatch",
            "artifact_digest_mismatch", "changeset_unknown", "head_mismatch", "digest_unbound"
        ]
    };
}
