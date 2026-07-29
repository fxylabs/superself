import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SpecPin } from "../attempt/plan.js";
import { AttemptState, liveAttemptFor, listSpools } from "../attempt/spool.js";
import { approvalPending } from "../completion.js";
import { processStartTime } from "../attempt/tree.js";
import { buildModel, WorkState } from "../model.js";
import { ProjectContext } from "../paths.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { listHeads, SpecHead } from "../spec/store.js";
import { WorkSpec } from "../spec/workspec.js";
import { admitDispatch } from "./circuits.js";
import { forbiddenRefusal, forbiddenSpec } from "./forbidden.js";
import { declaredBudget, generationOf, loadPolicy, OvernightPolicy, policyRefusal, PolicyOutcome, TickDispatch, windowSpend, WindowSpend } from "./policy.js";
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
    | "not-started"
    // Everything the overnight policy owns. These are refusals about the night
    // rather than about the work, which is why they are named apart from the
    // gates below them.
    | PolicyOutcome;

export interface WakeDecision
{
    work: string;
    workSpec: string;
    generation: number;
    outcome: WakeOutcome;
    detail?: string;
}

// The outcomes that mean the policy held this generation back. A tick counts
// them as deferred: nothing was spent and nothing failed, and the next tick
// inside the window decides again.
export const POLICY_OUTCOMES: WakeOutcome[] = [
    "no-policy", "auto-dispatch-off", "outside-window", "project-not-allowed", "risk-not-allowed",
    "kind-not-allowed", "provider-not-allowed", "model-not-allowed", "retries-above-policy",
    "at-concurrency-cap", "over-budget", "stopped", "forbidden-action"
];

// Every work unit with desired state, judged once. Waking is the only step of
// the tick that starts something, so each refusal below is a reason a person
// reading `self daemon tick` can act on.
//
// The overnight policy is asked before any of them. Nothing this supervisor
// dispatches is dispatched on its own authority: with no policy in force, or
// outside the window one declares, the answer is no before the work unit's own
// state is even reached — and reconcile, settle and release, which spend
// nothing, carry on regardless.
export function wakeReady(ctx: ProjectContext, now: Date): WakeDecision[]
{
    const works = buildModel(ctx.storeDir, ctx.project, now).works;
    const policy = loadPolicy(ctx.storeDir, ctx.project);
    const spend = policy === null ? null : windowSpend(ctx, policy, now);
    const night: Night = { policy, spend, dispatched: { count: 0, declaredUsd: 0 } };
    return listHeads(ctx.storeDir, ctx.project).map((head) =>
    {
        const spec = sealedOnce(ctx, head);
        const decision = decide(ctx, head, spec, works.find((work) => work.id === head.work), night, now);
        if (decision.outcome === "woken")
        {
            const woken = spec();
            night.dispatched.count += 1;
            night.dispatched.declaredUsd += woken === null ? 0 : declaredBudget(woken);
        }
        return decision;
    });
}

// The sealed bytes behind one head, read at most once and only if something
// asks. Once, because what the policy is judging, what its budget is committing
// and which provider the dispatch reaches are all statements about the same
// bytes, and reading them per gate meant hashing the blob three times. Only if
// asked, because reading verifies the sha256 the generation was sealed under,
// and most heads in a project belong to work that is finished or not ready —
// a tick that hashed those too would pay for the whole project's history every
// few seconds while holding the machine's tick mutex, and one unreadable
// generation under finished work would fail a tick that had no business
// reading it.
type Sealed = () => WorkSpec | null;

function sealedOnce(ctx: ProjectContext, head: SpecHead): Sealed
{
    let spec: WorkSpec | null = null;
    let read = false;
    return () =>
    {
        if (!read)
        {
            spec = generationOf(ctx, head);
            read = true;
        }
        return spec;
    };
}

// What the policy is being asked against, carried through one tick rather than
// re-derived per generation: the spend is a fold over the whole window, and a
// wake set of any size would otherwise re-read the log once per entry. What
// this tick has itself handed out is carried the same way and for the same
// reason — it is spending and concurrency the fold cannot see yet.
interface Night
{
    policy: OvernightPolicy | null;
    spend: WindowSpend | null;
    dispatched: TickDispatch;
}

function decide(ctx: ProjectContext, head: SpecHead, sealed: Sealed, work: WorkState | undefined, night: Night, now: Date): WakeDecision
{
    const at = { work: head.work, workSpec: head.workSpec, generation: head.generation };
    // Before anything is read: work that is finished or gone is not a
    // candidate, and saying so costs a lookup in a model that is already built.
    if (work === undefined || work.status === "done")
    {
        return { ...at, outcome: "not-ready" };
    }
    const refusal = nightRefusal(ctx.project, head, sealed, night, now);
    if (refusal !== null)
    {
        return { ...at, ...refusal };
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
    const spec = sealed();
    if (spec === null)
    {
        return { ...at, outcome: "no-spec" };
    }
    const admission = admitDispatch(spec.provider.name, now);
    if (admission !== "admitted")
    {
        return { ...at, outcome: admission };
    }
    return { ...at, outcome: dispatch(ctx, head, now) ? "woken" : "not-started" };
}

// Whether the night permits this generation, before anything about the work
// unit is considered. Two refusals live here and they are not the same kind of
// thing: the forbidden-action list is categorical and holds inside the window,
// on an allowed project, for a unit a person approved during the day — while
// everything the policy itself says is a bound the operator chose and may
// change. A generation that is not sealed is left to the gates below, which
// already refuse it for the reason it is actually refused for.
function nightRefusal(project: string, head: SpecHead, sealed: Sealed, night: Night, now: Date): { outcome: WakeOutcome; detail: string } | null
{
    // Asked before the generation is read, and it is the answer for every head
    // on a machine whose operator granted no night: with no policy in force
    // there is nothing to judge the sealed bytes against.
    if (night.policy === null || night.spend === null)
    {
        return { outcome: "no-policy", detail: "no overnight policy is in force — `self overnight set` is what grants unattended dispatch" };
    }
    const spec = sealed();
    if (spec === null)
    {
        return null;
    }
    const forbidden = forbiddenSpec(spec);
    if (forbidden !== null)
    {
        return { outcome: "forbidden-action", detail: forbiddenRefusal(forbidden, `${head.workSpec} generation ${head.generation}`) };
    }
    const refusal = policyRefusal(night.policy, spec, project, night.spend, night.dispatched, now);
    return refusal === null ? null : { outcome: refusal.outcome, detail: refusal.detail };
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
    return generationOf(ctx, head)?.provider.name ?? null;
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
