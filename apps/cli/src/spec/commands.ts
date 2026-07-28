import { parseArgs } from "node:util";
import { commitStaged } from "../artifact.js";
import { AttemptPlan } from "../attempt/plan.js";
import { runAttempt } from "../attempt/run.js";
import { buildModel, WorkState } from "../model.js";
import { ProjectContext, requireProject } from "../paths.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { dim, styled } from "../style.js";
import { CliError } from "../types.js";
import {
    listGenerations,
    listHeads,
    liveAttemptFor,
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
        case "validate": cmdValidate(rest[1]); return;
        case "apply": cmdApply(rest[1]); return;
        case "dispatch": await cmdDispatch(rest[1]); return;
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
    recordEvent(
        ctx,
        makeEvent(ctx.project, "spec.dispatched", { spec: head.workSpec, generation: head.generation, sha256: head.sha256, requestedModel: spec.requestedModel }, { work: head.work }),
        `${head.workSpec} generation ${head.generation} dispatched`
    );
    const result = await runAttempt(ctx, plan, { now: new Date() });
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
}

function required(value: string | undefined, usage: string): string
{
    if (value === undefined || value.trim() === "")
    {
        throw new CliError(`usage: self ${usage}`);
    }
    return value;
}
