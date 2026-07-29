import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SpecPin } from "../attempt/plan.js";
import { AttemptState, liveAttemptFor, listSpools } from "../attempt/spool.js";
import { approvalPending } from "../completion.js";
import { processStartTime } from "../attempt/tree.js";
import { buildModel, WorkState } from "../model.js";
import { ProjectContext } from "../paths.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { listHeads, readGeneration, sealedGeneration, SpecHead, specDir } from "../spec/store.js";
import { admitDispatch } from "./circuits.js";
import { recordWake, wakeInFlight } from "./state.js";

// Why a work unit did not become a dispatch this tick, or that it did. Every
// reason is a statement about observable state rather than a policy the
// supervisor invented: the unit is done, something is already driving it, the
// generation it has was already materialized, or the provider it needs is not
// taking work right now.
export type WakeOutcome =
    | "woken"
    | "no-spec"
    | "not-ready"
    | "awaiting-approval"
    | "driven"
    | "materialized"
    | "circuit-open"
    | "waiting-reset"
    // The dispatch could not be started at all. Nothing was spent and nothing
    // was recorded, so the next tick issues it again.
    | "not-started";

export interface WakeDecision
{
    work: string;
    workSpec: string;
    generation: number;
    outcome: WakeOutcome;
}

// Every work unit with desired state, judged once. Waking is the only step of
// the tick that starts something, so each refusal below is a reason a person
// reading `self daemon tick` can act on.
export function wakeReady(ctx: ProjectContext, now: Date): WakeDecision[]
{
    const works = buildModel(ctx.storeDir, ctx.project, now).works;
    return listHeads(ctx.storeDir, ctx.project).map((head) => decide(ctx, head, works.find((work) => work.id === head.work), now));
}

function decide(ctx: ProjectContext, head: SpecHead, work: WorkState | undefined, now: Date): WakeDecision
{
    const at = { work: head.work, workSpec: head.workSpec, generation: head.generation };
    if (work === undefined || work.status === "done")
    {
        return { ...at, outcome: "not-ready" };
    }
    // A unit blocked on a decision is waiting for a person to answer, and a
    // supervisor that dispatched it anyway would be answering on their behalf.
    // A dependency or an external blocker is the same refusal for the same
    // reason: the unit itself declares that something must land first.
    if (work.status === "blocked")
    {
        return { ...at, outcome: work.blockedOn === "decision" ? "awaiting-approval" : "not-ready" };
    }
    // The durable approval state the completion check owns, read here rather
    // than re-decided: a unit that declares it needs a person's answer is not
    // one a supervisor may dispatch at while that answer is missing.
    if (approvalPending(work))
    {
        return { ...at, outcome: "awaiting-approval" };
    }
    if (liveAttemptFor(head.work) !== null || wakeInFlight(head.workSpec, head.generation))
    {
        return { ...at, outcome: "driven" };
    }
    const materialized = attemptsAt(head);
    if (materialized.length > 0 && !onlyCapacityRefusals(materialized))
    {
        return { ...at, outcome: "materialized" };
    }
    const provider = providerOf(ctx, head);
    if (provider === null)
    {
        return { ...at, outcome: "no-spec" };
    }
    const admission = admitDispatch(provider, now);
    if (admission !== "admitted")
    {
        return { ...at, outcome: admission };
    }
    return { ...at, outcome: dispatch(ctx, head, now) ? "woken" : "not-started" };
}

// What this machine has already run under the generation that is current now.
// One attempt per generation is what makes a tick idempotent: the run a wake
// started is itself the record that stops the next tick starting a second one.
interface GenerationAttempt
{
    attempt: string;
    state: AttemptState;
    failure?: string;
}

function attemptsAt(head: SpecHead): GenerationAttempt[]
{
    return listSpools().flatMap((spool): GenerationAttempt[] =>
    {
        const status = spool.status();
        const pin = spool.readJson<{ spec?: SpecPin }>("attempt.json")?.spec;
        if (status === null || pin === undefined || pin.workSpec !== head.workSpec || pin.generation !== head.generation)
        {
            return [];
        }
        return [{ attempt: status.attempt, state: status.state, failure: status.failure }];
    });
}

// A generation whose every attempt was refused capacity has not been tried:
// the provider said "not now", which is a statement about the provider and
// never about the desired state. That is the one case a second dispatch of the
// same generation is owed — and it is owed exactly once, because the reset
// that admits it is spent when it is read.
function onlyCapacityRefusals(attempts: GenerationAttempt[]): boolean
{
    return attempts.every((attempt) => attempt.state === "waiting-provider" || attempt.failure === "transient-provider");
}

// The provider the current generation names, read from the sealed content the
// HEAD points at. A generation that is not sealed, or no longer hashes to what
// it was sealed as, is not one this may dispatch — `spec dispatch` refuses it
// for the same reason, and waking it would only spend a process to be told so.
export function providerOf(ctx: ProjectContext, head: SpecHead): string | null
{
    const dir = specDir(ctx.storeDir, ctx.project, head.workSpec);
    const sealed = sealedGeneration(dir, head.generation);
    if (sealed === null || sealed.sha256 !== head.sha256)
    {
        return null;
    }
    try
    {
        return readGeneration(dir, sealed).provider.name;
    }
    catch
    {
        return null;
    }
}

// The dispatch is the CLI's own, run detached: the supervisor schedules and
// the runner owns preflight, spool, gate, report and breaker exactly as it
// does when a person types the command. Nothing here waits for it — a tick
// that blocked on a provider call would be a tick that stops reconciling
// everything else for as long as one run takes.
function dispatch(ctx: ProjectContext, head: SpecHead, now: Date): boolean
{
    const child = spawn(process.execPath, [cliEntry(), "spec", "dispatch", head.workSpec], {
        cwd: ctx.projectDir,
        stdio: "ignore",
        detached: true
    });
    child.unref();
    // A spawn that yielded no pid started nothing this machine can point at,
    // and it must not be written down as a wake in flight: pid 0 is the
    // caller's own process group to a liveness probe, so the record would
    // answer "still running" for ever and this generation would never be woken
    // again. Nothing is recorded, and the next tick issues it properly.
    if (child.pid === undefined)
    {
        return false;
    }
    recordWake({
        workSpec: head.workSpec,
        work: head.work,
        generation: head.generation,
        at: now.toISOString(),
        child: child.pid,
        childStartedAt: processStartTime(child.pid)
    });
    recordEvent(
        ctx,
        makeEvent(ctx.project, "run.woken", { spec: head.workSpec, generation: head.generation, sha256: head.sha256 }, { work: head.work }),
        `${head.workSpec} generation ${head.generation} woken by the daemon`
    );
    return true;
}

// The same CLI this process is running. `self` is a shim that imports the
// compiled entry, so the argument vector is the entry when the daemon was
// started through it; a process that reached here another way falls back to
// the module this file was compiled beside.
export function cliEntry(): string
{
    return process.argv[1] ?? fileURLToPath(new URL("../main.js", import.meta.url));
}
