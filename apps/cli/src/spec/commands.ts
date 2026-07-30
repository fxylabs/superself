import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseCommand } from "../args.js";
import { commitStaged } from "../artifact.js";
import { withLock } from "../attempt/atomic.js";
import { AttemptPlan } from "../attempt/plan.js";
import { runAttempt } from "../attempt/run.js";
import { liveAttemptFor } from "../attempt/spool.js";
import { approvalPending } from "../completion.js";
import { buildModel, WorkState } from "../model.js";
import { ProjectContext, projectStateDir, requireProject } from "../paths.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { dim, styled } from "../style.js";
import { CliError } from "../types.js";
import {
    advanceHead,
    applyLockFile,
    listGenerations,
    listHeads,
    pinnedAttempts,
    readGeneration,
    readHead,
    seal,
    sealedGeneration,
    SpecHead,
    specDir
} from "./store.js";
import { compileSpec, pinFor, readSpecFile, specDigest, WorkSpec } from "./workspec.js";

const USAGE = "usage: self spec validate <workspec.json> | apply <workspec.json> | dispatch <work-spec-id> | list [--json] | show <work-spec-id> [--json]";

export async function runSpecCommand(rest: string[]): Promise<void>
{
    switch (rest[0])
    {
        case "validate": cmdValidate(only(rest.slice(1))); return;
        case "apply": cmdApply(only(rest.slice(1))); return;
        case "dispatch": await cmdDispatch(only(rest.slice(1))); return;
        case "list": cmdList(rest.slice(1)); return;
        case "show": cmdShow(rest.slice(1)); return;
        default: throw new CliError(USAGE);
    }
}

// Reads a file and answers. Nothing here writes: an agent must be able to ask
// whether what it wrote is a spec at all without a rejected draft leaving a
// generation, an event, or a commit behind.
function cmdValidate(file: string | undefined): void
{
    const ctx = requireProject(process.cwd());
    const spec = readSpecFile(required(file, "spec validate <workspec.json>"));
    const plan = compileSpec(spec, ctx.projectDir);
    console.log(`${spec.workSpecId} generation ${spec.generation} for ${spec.workId} is valid — ${specDigest(spec).slice(0, 12)}`);
    console.log(`${dim("compiles to")} ${plan.command.length} argument command, ${plan.artifacts.length} declared artifact(s), up to ${plan.retry.maxRuns} run(s) of ${plan.runTimeoutMs}ms`);
}

// A generation is content, so applying is decided by content: the same spec
// applied twice is one generation and one event, and content that differs from
// what a generation number was already sealed with is refused rather than
// quietly replacing it. Nothing else in this store can be edited or deleted,
// which is what lets an attempt bind to a generation and stay bound.
function cmdApply(file: string | undefined): void
{
    const ctx = requireProject(process.cwd());
    const spec = readSpecFile(required(file, "spec apply <workspec.json>"));
    // Before anything is sealed: a generation that cannot be compiled into an
    // attempt plan is a generation nothing can ever dispatch.
    compileSpec(spec, ctx.projectDir);
    requireOpenWork(ctx, spec.workId);
    const dir = specDir(ctx.storeDir, ctx.project, spec.workSpecId);
    const digest = specDigest(spec);
    // Everything from here reads state a concurrent apply is about to change —
    // HEAD, the sealed set, the other specs' claims — and then writes it. Two
    // appliers passing those reads together would seal one generation number
    // twice, and a generation sealed twice with different content is a store
    // no repair verb can un-poison.
    withLock(applyLockFile(ctx.project), () => applyUnderLock(ctx, spec, dir, digest));
}

function applyUnderLock(ctx: ProjectContext, spec: WorkSpec, dir: string, digest: string): void
{
    repairInterruptedApply(ctx, dir);
    const head = readHead(dir);
    if (head !== null && head.work !== spec.workId)
    {
        throw new CliError(`${spec.workSpecId} materializes ${head.work} and this generation names ${spec.workId} — a work spec never changes the work unit it belongs to`);
    }
    // One HEAD per work unit. Desired state that two pointers could disagree
    // about is not desired state, and a changed intent is the next generation
    // of the spec the unit already has rather than a second spec beside it.
    const claimed = listHeads(ctx.storeDir, ctx.project).find((entry) => entry.work === spec.workId && entry.workSpec !== spec.workSpecId);
    if (claimed !== undefined)
    {
        throw new CliError(`${spec.workId} already has work spec ${claimed.workSpec} at generation ${claimed.generation} — a work unit has one desired-state HEAD, so a change is its next generation`);
    }
    const sealed = sealedGeneration(dir, spec.generation);
    if (sealed !== null)
    {
        if (sealed.sha256 !== digest)
        {
            throw new CliError(`generation ${spec.generation} of ${spec.workSpecId} is sealed as ${sealed.sha256.slice(0, 12)} and this file is ${digest.slice(0, 12)} — a generation is immutable; apply changed content as generation ${(head?.generation ?? spec.generation) + 1}`);
        }
        console.log(`${spec.workSpecId} generation ${spec.generation} is already applied (${digest.slice(0, 12)}) — nothing recorded`);
        return;
    }
    const expected = head === null ? 1 : head.generation + 1;
    if (spec.generation !== expected)
    {
        throw new CliError(head === null
            ? `${spec.workSpecId} has no generation yet, so the first one is 1 — this spec declares ${spec.generation}`
            : `${spec.workSpecId} is at generation ${head.generation}, so the next one is ${expected} — this spec declares ${spec.generation}`);
    }
    const discard = seal(dir, spec, digest, new Date());
    commitStaged({ discard }, (recorded) => recordEvent(
        ctx,
        makeEvent(ctx.project, "spec.applied", { spec: spec.workSpecId, generation: spec.generation, sha256: digest, requestedModel: spec.requestedModel }, { work: spec.workId }),
        `${spec.workSpecId} generation ${spec.generation}`,
        recorded
    ));
    console.log(`${spec.workSpecId} generation ${spec.generation} applied — ${digest.slice(0, 12)} is now HEAD for ${spec.workId}`);
}

// An apply is three durable writes — the generation blob, the HEAD advance,
// the spec.applied event — and a crash can stop after any of them. The blob is
// the journal entry: written first, content-addressed, and read by nothing
// until HEAD points at it, so a store holding a blob past HEAD is fully-before
// to every reader. The next apply completes the interrupted commit here, under
// the apply lock, instead of misreading the blob as "already applied" and
// leaving a spec that can never advance again.
function repairInterruptedApply(ctx: ProjectContext, dir: string): void
{
    const latest = listGenerations(dir).at(-1);
    if (latest === undefined)
    {
        return;
    }
    const head = readHead(dir);
    if (head !== null && head.generation >= latest.generation && appliedEventRecorded(ctx, head.workSpec, latest))
    {
        return;
    }
    const spec = readGeneration(dir, latest);
    if (head === null || head.generation < latest.generation)
    {
        advanceHead(dir, spec, latest.sha256, new Date());
    }
    if (!appliedEventRecorded(ctx, spec.workSpecId, latest))
    {
        recordEvent(
            ctx,
            makeEvent(ctx.project, "spec.applied", { spec: spec.workSpecId, generation: latest.generation, sha256: latest.sha256, requestedModel: spec.requestedModel }, { work: spec.workId }),
            `${spec.workSpecId} generation ${latest.generation} (completing an interrupted apply)`
        );
    }
}

// Whether the log already admits this generation. The sealed blob and the
// HEAD pointer answer from the store tree; the event is the one leg of the
// apply that only the log itself can answer for.
function appliedEventRecorded(ctx: ProjectContext, workSpecId: string, sealed: { generation: number; sha256: string }): boolean
{
    const log = join(projectStateDir(ctx.storeDir, ctx.project), "log.jsonl");
    if (!existsSync(log))
    {
        return false;
    }
    return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.includes(sealed.sha256))
        .some((line) => isAppliedEvent(line, workSpecId, sealed));
}

function isAppliedEvent(line: string, workSpecId: string, sealed: { generation: number; sha256: string }): boolean
{
    try
    {
        const event = JSON.parse(line);
        return event.type === "spec.applied"
            && event.payload?.spec === workSpecId
            && event.payload?.generation === sealed.generation
            && event.payload?.sha256 === sealed.sha256;
    }
    catch
    {
        return false;
    }
}

// The only path from desired state to a running process. The generation is read
// once, compiled once, and pinned onto the attempt before the provider is
// reached, so an apply that lands while this runs changes what the next
// dispatch compiles and nothing about this one.
async function cmdDispatch(id: string | undefined): Promise<void>
{
    const ctx = requireProject(process.cwd());
    const { head, spec } = currentGeneration(ctx, required(id, "spec dispatch <work-spec-id>"));
    requireUnblockedWork(ctx, head.work);
    const live = liveAttemptFor(head.work);
    if (live !== null)
    {
        throw new CliError(`${head.work} is already being driven by attempt ${live.attempt} (${live.state}) — one work unit materializes one attempt at a time`);
    }
    const plan: AttemptPlan = compileSpec(spec, ctx.projectDir);
    plan.spec = pinFor(spec, head.sha256);
    // Recorded inside the per-work claim: a dispatch that loses the race for
    // the work unit is a refusal, and a refusal spends no spec.dispatched
    // event — however close together the racers started.
    const result = await runAttempt(ctx, plan, {
        now: new Date(),
        onAdmitted: () => recordEvent(
            ctx,
            makeEvent(ctx.project, "spec.dispatched", { spec: head.workSpec, generation: head.generation, sha256: head.sha256, requestedModel: spec.requestedModel }, { work: head.work }),
            `${head.workSpec} generation ${head.generation} dispatched`
        )
    });
    if (result.state !== "completed")
    {
        process.exitCode = 1;
    }
}

function cmdList(args: string[]): void
{
    const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
    const ctx = requireProject(process.cwd());
    const heads = listHeads(ctx.storeDir, ctx.project);
    if (values.json === true)
    {
        console.log(JSON.stringify(heads, null, 2));
        return;
    }
    if (heads.length === 0)
    {
        console.log("no work spec in this project — apply one with `self spec apply <workspec.json>`");
        return;
    }
    for (const head of heads)
    {
        console.log(`${head.workSpec}  ${head.work}  generation ${head.generation}  ${head.sha256.slice(0, 12)}  ${head.applied}`);
    }
}

// Work to generation to attempts, by stable id. The generations are the synced
// desired state; the attempts are this machine's observation of what ran under
// them, and each one says which generation admitted it.
function cmdShow(args: string[]): void
{
    const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, allowPositionals: true });
    const ctx = requireProject(process.cwd());
    const { head, spec } = currentGeneration(ctx, required(positionals[0], "spec show <work-spec-id>"));
    const dir = specDir(ctx.storeDir, ctx.project, head.workSpec);
    const generations = listGenerations(dir);
    const attempts = pinnedAttempts(head.workSpec);
    if (values.json === true)
    {
        console.log(JSON.stringify({ head, spec, generations, attempts }, null, 2));
        return;
    }
    console.log(`${head.workSpec}  ${head.work}  generation ${head.generation}  ${head.sha256.slice(0, 12)}`);
    console.log(`role       ${spec.role}`);
    console.log(`provider   ${spec.provider.name} ${spec.provider.endpoint}, model ${spec.requestedModel}`);
    console.log(`command    ${spec.command.join(" ")}`);
    console.log(`timeouts   run ${spec.timeoutPolicy.runMs}ms${spec.timeoutPolicy.preflightMs === undefined ? "" : `, preflight ${spec.timeoutPolicy.preflightMs}ms`}`);
    console.log(`retry      up to ${spec.retryPolicy.maxRuns} run(s)`);
    console.log(`validation ${validationLine(spec)}`);
    console.log("generations");
    for (const generation of generations)
    {
        const mark = generation.generation === head.generation ? "  HEAD" : "";
        console.log(`  ${generation.generation}  ${generation.sha256.slice(0, 12)}${styled ? dim(mark) : mark}`);
    }
    console.log("attempts");
    if (attempts.length === 0)
    {
        console.log(`  ${dim("none on this machine")}`);
    }
    for (const attempt of attempts)
    {
        console.log(`  ${attempt.attempt}  generation ${attempt.spec.generation}  ${attempt.state}${attempt.live ? "  live" : ""}`);
    }
}

function validationLine(spec: WorkSpec): string
{
    const forms: string[] = [];
    if (spec.validation.responseSchema !== undefined)
    {
        const artifacts = spec.validation.responseSchema.artifacts;
        forms.push(`response envelope "${spec.validation.responseSchema.status}"${artifacts.length === 0 ? "" : ` carrying ${artifacts.join(", ")}`}`);
    }
    if (spec.validation.artifactCommands === true)
    {
        forms.push("declared validate command per artifact");
    }
    return forms.join("; ");
}

function currentGeneration(ctx: ProjectContext, id: string): { head: SpecHead; spec: WorkSpec }
{
    const dir = specDir(ctx.storeDir, ctx.project, id);
    const head = readHead(dir);
    if (head === null)
    {
        throw new CliError(`no work spec "${id}" in ${ctx.project} — run \`self spec list\` to see the specs this project has applied`);
    }
    const sealed = sealedGeneration(dir, head.generation);
    if (sealed === null || sealed.sha256 !== head.sha256)
    {
        throw new CliError(`${id} points at generation ${head.generation} (${head.sha256.slice(0, 12)}) and that generation is not sealed in the store`);
    }
    return { head, spec: readGeneration(dir, sealed) };
}

// A spec describes work that is still to be done. The runner checks this again
// inside the preflight, where the work unit is a declared read capability; this
// is the same answer given before anything is sealed or spent.
function requireOpenWork(ctx: ProjectContext, id: string): WorkState
{
    const work = buildModel(ctx.storeDir, ctx.project, new Date()).works.find((item) => item.id === id);
    if (work === undefined)
    {
        throw new CliError(`unknown work id "${id}" — run \`self work\` to list ids`);
    }
    if (work.status === "done")
    {
        throw new CliError(`${id} is already done — a work spec materializes work that is still open`);
    }
    if (work.status === "retired")
    {
        throw new CliError(`${id} is retired — a work spec materializes work that is still open`);
    }
    return work;
}

// The one gate this slice keeps beyond openness: a work unit blocked on a
// dependency or an approval has declared that something must land first, and
// dispatch is the moment that declaration is honored. Applying a spec while
// blocked stays allowed — desired state is exactly what one prepares while
// waiting — and anything richer than reading the blocker's presence belongs
// to the daemon slice.
function requireUnblockedWork(ctx: ProjectContext, id: string): void
{
    const work = requireOpenWork(ctx, id);
    if (work.status === "blocked")
    {
        const why = work.blockedWhy === undefined ? "" : `: ${work.blockedWhy}`;
        throw new CliError(`${id} is blocked on ${work.blockedOn}${why} — resolve the blocker and \`self work unblock ${id}\` before dispatching`);
    }
    // The same durable approval state the supervisor's wake path reads. A unit
    // waiting on a person is waiting whoever issues the dispatch.
    if (approvalPending(work))
    {
        throw new CliError(`${id} requires human approval before anything is dispatched at it — grant it from an interactive terminal with \`self work approve ${id}\``);
    }
}

// The one argument these verbs take, read through the same parser as every
// other command: a flag none of them accepts is named before validate reads a
// file, and before apply or dispatch writes anything at all.
function only(args: string[]): string | undefined
{
    return parseCommand("spec", args, {}, 1).positionals[0];
}

function required(value: string | undefined, usage: string): string
{
    if (value === undefined || value.trim() === "")
    {
        throw new CliError(`usage: self ${usage}`);
    }
    return value;
}
