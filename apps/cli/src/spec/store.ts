import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { writeAtomic } from "../attempt/atomic.js";
import { bootId } from "../attempt/boundary.js";
import { SpecPin } from "../attempt/plan.js";
import { AttemptStatus, isLive, listSpools, Spool } from "../attempt/spool.js";
import { runnerStateDir } from "../machine.js";
import { projectStateDir } from "../paths.js";
import { sha256File } from "../repo.js";
import { CliError } from "../types.js";
import { normalizeSpec, specBody, WorkSpec } from "./workspec.js";

// Where a work unit's desired state currently stands: the generation every
// dispatch is compiled from until a newer one is applied. The pointer moves;
// the generations it has pointed at never do.
export interface SpecHead
{
    workSpec: string;
    work: string;
    generation: number;
    sha256: string;
    applied: string;
}

export interface SealedGeneration
{
    generation: number;
    sha256: string;
    file: string;
}

// The attempt a spec generation materialized, as the machine that ran it
// recorded it. Attempts are machine-local, which is why this is read from the
// spool rather than from the synced log: the log says a generation was
// dispatched, the spool says what the run under it became.
export interface PinnedAttempt
{
    attempt: string;
    work: string;
    state: AttemptStatus["state"];
    spec: SpecPin;
    live: boolean;
}

const SPECS_SUBDIR = "specs";
const HEAD_FILE = "head.json";
const GENERATION_DIGITS = 6;

export function specsRoot(storeDir: string, slug: string): string
{
    return join(projectStateDir(storeDir, slug), SPECS_SUBDIR);
}

// One apply at a time per project: everything `spec apply` reads before it
// seals (HEAD, the sealed set, every other spec's claim on the work unit) is
// what a concurrent apply is about to change. The lock lives in the machine's
// runner state, not in the store — the store is committed with `git add -A`,
// and a lock is per-machine by nature, never synced state.
export function applyLockFile(slug: string): string
{
    return join(runnerStateDir(), "locks", `spec-apply.${encodeURIComponent(slug)}`);
}

// The id reaches the filesystem here. A registry slug is checked the same way
// before it is handed to `join`, and for the same reason: anything but a single
// segment writes a spec outside the project's own state, or on top of another
// one's.
export function specDir(storeDir: string, slug: string, workSpecId: string): string
{
    const root = specsRoot(storeDir, slug);
    const dir = resolve(root, workSpecId);
    const step = relative(root, dir);
    if (step === "" || step === ".." || step.includes(sep))
    {
        throw new CliError(`work spec id "${workSpecId}" is not a single path segment — a spec cannot be sealed outside its project's state`);
    }
    return dir;
}

export function readHead(dir: string): SpecHead | null
{
    const file = join(dir, HEAD_FILE);
    if (!existsSync(file))
    {
        return null;
    }
    try
    {
        return JSON.parse(readFileSync(file, "utf8")) as SpecHead;
    }
    catch
    {
        throw new CliError(`the HEAD pointer at ${file} is unreadable — a spec store is append-only and is never hand-edited`);
    }
}

// Every generation this spec has ever had, oldest first. The generation number
// and the digest of its content are both in the file name, so the store answers
// "what was generation 2" without opening anything.
export function listGenerations(dir: string): SealedGeneration[]
{
    if (!existsSync(dir))
    {
        return [];
    }
    return readdirSync(dir)
        .filter((name) => name !== HEAD_FILE && name.endsWith(".json"))
        .flatMap((name): SealedGeneration[] =>
        {
            const match = name.match(/^(\d{6})-([0-9a-f]{64})\.json$/);
            return match === null ? [] : [{ generation: Number(match[1]), sha256: match[2], file: join(dir, name) }];
        })
        .sort((left, right) => left.generation - right.generation);
}

export function sealedGeneration(dir: string, generation: number): SealedGeneration | null
{
    const sealed = listGenerations(dir).filter((entry) => entry.generation === generation);
    if (sealed.length > 1)
    {
        throw new CliError(`generation ${generation} of ${dir} is sealed twice with different content — a generation is written once and never again`);
    }
    return sealed[0] ?? null;
}

// The content itself, checked against the digest its own name carries. A
// generation that no longer hashes to its name is not a generation this may
// dispatch: the immutability the whole contract rests on has already been lost.
export function readGeneration(dir: string, entry: SealedGeneration): WorkSpec
{
    const actual = sha256File(entry.file);
    if (actual !== entry.sha256)
    {
        throw new CliError(`generation ${entry.generation} hashes to ${String(actual).slice(0, 12)} and was sealed as ${entry.sha256.slice(0, 12)} — the sealed content was modified`);
    }
    return normalizeSpec(JSON.parse(readFileSync(entry.file, "utf8")));
}

// Written before the event that makes it real, and taken back out again if that
// event never reaches the log — the same boundary artifact bytes cross. The
// generation blob is exactly the bytes that were hashed, so the store is
// content-addressed by construction rather than by a recorded claim.
export function seal(dir: string, spec: WorkSpec, digest: string, now: Date): () => void
{
    // Refused here as well as in the apply flow above it: the apply lock makes
    // two sealers of one generation impossible, and this keeps a caller that
    // somehow bypassed the lock at a refusal instead of a poisoned store.
    const sealed = listGenerations(dir).find((entry) => entry.generation === spec.generation);
    if (sealed !== undefined)
    {
        throw new CliError(`generation ${spec.generation} of ${spec.workSpecId} is already sealed as ${sealed.sha256.slice(0, 12)} — a generation is written once and never again`);
    }
    const createdRoot = mkdirSync(dir, { recursive: true });
    const blob = join(dir, `${String(spec.generation).padStart(GENERATION_DIGITS, "0")}-${digest}.json`);
    const headFile = join(dir, HEAD_FILE);
    const previousHead = existsSync(headFile) ? readFileSync(headFile, "utf8") : null;
    writeAtomic(blob, specBody(spec));
    advanceHead(dir, spec, digest, now);
    return (): void =>
    {
        rmSync(blob, { force: true });
        if (previousHead === null)
        {
            rmSync(headFile, { force: true });
        }
        else
        {
            writeAtomic(headFile, previousHead);
        }
        if (createdRoot !== undefined)
        {
            rmSync(createdRoot, { recursive: true, force: true });
        }
    };
}

// The HEAD advance on its own, for the repair path: a crash that interrupted
// an apply after the generation blob was durable left HEAD behind, and the
// blob — verified against the digest in its own name — carries everything the
// pointer records.
export function advanceHead(dir: string, spec: WorkSpec, digest: string, now: Date): void
{
    const head: SpecHead = {
        workSpec: spec.workSpecId,
        work: spec.workId,
        generation: spec.generation,
        sha256: digest,
        applied: now.toISOString()
    };
    writeAtomic(join(dir, HEAD_FILE), JSON.stringify(head, null, 2) + "\n");
}

export function listHeads(storeDir: string, slug: string): SpecHead[]
{
    const root = specsRoot(storeDir, slug);
    if (!existsSync(root))
    {
        return [];
    }
    return readdirSync(root)
        .flatMap((name) => readHead(join(root, name)) ?? [])
        .sort((left, right) => left.workSpec.localeCompare(right.workSpec));
}

// Every attempt on this machine that was admitted under a spec generation —
// how a query walks work to generation to the runs it produced.
export function pinnedAttempts(workSpecId: string): PinnedAttempt[]
{
    const boot = bootId();
    const now = Date.now();
    return listSpools().flatMap((spool): PinnedAttempt[] =>
    {
        const status = spool.status();
        const record = spool.readJson<{ spec?: SpecPin }>("attempt.json");
        if (status === null || record?.spec === undefined || record.spec.workSpec !== workSpecId)
        {
            return [];
        }
        return [{
            attempt: status.attempt,
            work: status.work,
            state: status.state,
            spec: record.spec,
            live: isLive(spool, status, boot, now)
        }];
    });
}

