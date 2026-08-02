// The manifest is the operator's statement of what a bundle may contain: every
// source named outright, every pin written down. It is read and refused here so
// that `compile` never has to decide what an under-specified selection meant —
// a bundle compiled from a guess is exactly the drift this subsystem exists to
// remove.

import { existsSync, readFileSync } from "node:fs";
import { requireRevision } from "../gitutil.js";
import { CliError } from "../types.js";

export const MANIFEST_FORMAT = "self.evidence.manifest@1";
export const MANIFEST_FORMATS = [MANIFEST_FORMAT];
export const PROFILES = ["research"];

export interface GitPin
{
    repo: string;
    commit: string;
}

export interface SelfPin
{
    head: string;
    logSha256: string;
}

export interface Exclusion
{
    ref: string;
    why: string;
}

export interface Selection
{
    decisions: string[];
    work: string[];
    reports: string[];
    milestones: string[];
    commits: GitPin[];
}

export interface Manifest
{
    format: string;
    profile: string;
    project: string;
    pins: { self?: Partial<SelfPin>; git: GitPin[] };
    select: Selection;
    exclude: Exclusion[];
}

// An event id as this store mints them, and a git object name at full length.
// Pins are compared as strings, so an abbreviation or an uppercase spelling
// would be a second name for one thing.
const ULID = /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SELECTORS = ["decisions", "work", "reports", "milestones"] as const;

export function readManifestFile(file: string): Manifest
{
    if (!existsSync(file))
    {
        throw new CliError(`manifest "${file}" does not exist — pass the path of a ${MANIFEST_FORMAT} file`);
    }
    return parseManifest(readFileSync(file, "utf8"), file);
}

export function parseManifest(text: string, file: string): Manifest
{
    const raw = readJson(text, file);
    requireFormat(raw.format, file);
    const select = requireSelection(raw.select);
    return {
        format: MANIFEST_FORMAT,
        profile: requireProfile(raw.profile),
        project: requireName(raw.project, "project"),
        pins: { self: readSelfPin(raw.pins), git: readGitPins(raw.pins) },
        select,
        exclude: requireExclusions(raw.exclude)
    };
}

function readJson(text: string, file: string): Record<string, unknown>
{
    let parsed: unknown;
    try
    {
        parsed = JSON.parse(text);
    }
    catch (error)
    {
        throw new CliError(`manifest "${file}" is not JSON — ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    {
        throw new CliError(`manifest "${file}" is not a JSON object — a manifest is one ${MANIFEST_FORMAT} record`);
    }
    return parsed as Record<string, unknown>;
}

// The version is named on both sides, because "unsupported" without the list is
// a refusal the writer cannot act on.
function requireFormat(found: unknown, file: string): void
{
    if (typeof found !== "string" || !MANIFEST_FORMATS.includes(found))
    {
        throw new CliError(`manifest "${file}" declares format ${describe(found)} — this build compiles ${MANIFEST_FORMATS.join(", ")}`);
    }
}

function requireProfile(found: unknown): string
{
    if (typeof found !== "string" || !PROFILES.includes(found))
    {
        throw new CliError(`manifest profile ${describe(found)} is not a profile this build ships — available: ${PROFILES.join(", ")}`);
    }
    return found;
}

function requireName(found: unknown, field: string): string
{
    if (typeof found !== "string" || found.trim() === "")
    {
        throw new CliError(`manifest field "${field}" must name a registered project — found ${describe(found)}`);
    }
    return found;
}

function requireSelection(found: unknown): Selection
{
    const raw = asObject(found, "select");
    const select: Selection = { decisions: [], work: [], reports: [], milestones: [], commits: readCommits(raw.commits) };
    for (const field of SELECTORS)
    {
        select[field] = requireStrings(raw[field], `select.${field}`);
    }
    if (SELECTORS.every((field) => select[field].length === 0) && select.commits.length === 0)
    {
        throw new CliError("manifest selects nothing — name at least one decision, work unit, report, milestone or commit");
    }
    return select;
}

function requireStrings(found: unknown, field: string): string[]
{
    if (found === undefined)
    {
        return [];
    }
    if (!Array.isArray(found) || found.some((item) => typeof item !== "string" || item.trim() === ""))
    {
        throw new CliError(`manifest field "${field}" must be a list of id selectors — found ${describe(found)}`);
    }
    return found as string[];
}

function requireExclusions(found: unknown): Exclusion[]
{
    if (found === undefined)
    {
        return [];
    }
    if (!Array.isArray(found))
    {
        throw new CliError(`manifest field "exclude" must be a list of {ref, why} records — found ${describe(found)}`);
    }
    return found.map((item, index) =>
    {
        const raw = asObject(item, `exclude[${index}]`);
        return {
            ref: requireField(raw.ref, `exclude[${index}].ref`),
            why: requireField(raw.why, `exclude[${index}].why`)
        };
    });
}

function readCommits(found: unknown): GitPin[]
{
    return readPinList(found, "select.commits");
}

function readGitPins(pins: unknown): GitPin[]
{
    return readPinList(asObject(pins ?? {}, "pins").git, "pins.git");
}

// Both places that carry a commit spell it the same way, so one reader answers
// for both and a pin can never be stricter than the selection it pins.
function readPinList(found: unknown, field: string): GitPin[]
{
    if (found === undefined)
    {
        return [];
    }
    if (!Array.isArray(found))
    {
        throw new CliError(`manifest field "${field}" must be a list of {repo, commit} records — found ${describe(found)}`);
    }
    return found.map((item, index) =>
    {
        const raw = asObject(item, `${field}[${index}]`);
        const repo = requireField(raw.repo, `${field}[${index}].repo`);
        return { repo, commit: requireCommit(raw.commit, `${field}[${index}].commit`) };
    });
}

// The same guard `--evidence commit:` goes through, and then the pin's own
// stricter rule on top of it: a pin is a full object name, because an
// abbreviation names a different string for the same commit and every check
// downstream is a string comparison.
export function requireCommit(found: unknown, field: string): string
{
    const value = requireField(found, field);
    const revision = requireRevision(value, () => `manifest field "${field}" is not a Git object name — found ${describe(found)}`);
    if (revision.length !== 40)
    {
        throw new CliError(`manifest field "${field}" pins the abbreviation "${value}" — a pin names a commit at its full 40-character length`);
    }
    return revision;
}

// Pins are read leniently and required late, so `compile --pin` can take the
// manifest that is missing them and write the one that is not.
function readSelfPin(pins: unknown): Partial<SelfPin> | undefined
{
    const found = asObject(pins ?? {}, "pins").self;
    if (found === undefined)
    {
        return undefined;
    }
    const raw = asObject(found, "pins.self");
    return {
        head: typeof raw.head === "string" ? raw.head : undefined,
        logSha256: typeof raw.logSha256 === "string" ? raw.logSha256 : undefined
    };
}

// Determinism is claimed over pinned inputs and nowhere else, so an incomplete
// pin refuses here rather than compiling a bundle whose inputs could move.
export function requireSelfPin(manifest: Manifest): SelfPin
{
    const pin = manifest.pins.self ?? {};
    if (pin.head === undefined || !ULID.test(pin.head))
    {
        throw new CliError(`manifest field "pins.self.head" must name the log head event — found ${describe(pin.head)}, run \`self evidence compile <manifest> --pin\` to write it`);
    }
    if (pin.logSha256 === undefined || !SHA256.test(pin.logSha256))
    {
        throw new CliError(`manifest field "pins.self.logSha256" must be the 64-character hash of the pinned log — found ${describe(pin.logSha256)}, run \`self evidence compile <manifest> --pin\` to write it`);
    }
    return { head: pin.head, logSha256: pin.logSha256 };
}

function asObject(found: unknown, field: string): Record<string, unknown>
{
    if (found === null || typeof found !== "object" || Array.isArray(found))
    {
        throw new CliError(`manifest field "${field}" must be a JSON object — found ${describe(found)}`);
    }
    return found as Record<string, unknown>;
}

function requireField(found: unknown, field: string): string
{
    if (typeof found !== "string" || found.trim() === "")
    {
        throw new CliError(`manifest field "${field}" must be a non-empty string — found ${describe(found)}`);
    }
    return found;
}

// Names what arrived without printing a value that could be content: a manifest
// is written by hand and a refusal is read over a shoulder.
function describe(found: unknown): string
{
    if (found === undefined)
    {
        return "nothing";
    }
    if (typeof found === "string")
    {
        return `"${found.length > 60 ? found.slice(0, 60) + "…" : found}"`;
    }
    return Array.isArray(found) ? "a list" : `a ${found === null ? "null" : typeof found}`;
}
