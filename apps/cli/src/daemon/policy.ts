import { DRIVEN_STATES, listSpools } from "../attempt/spool.js";
import { readEvents } from "../logfile.js";
import { ProjectContext } from "../paths.js";
import { readGeneration, sealedGeneration, SpecHead, specDir } from "../spec/store.js";
import { WorkSpec } from "../spec/workspec.js";
import { CliError, SelfEvent } from "../types.js";
import { matchesModel } from "../completion.js";
import { commandReachesNetwork, FORBIDDEN_ACTIONS } from "./forbidden.js";

// The autonomy the operator granted, written down.
//
// A daemon that supervises without one is not autonomous — it reconciles what
// already exists, settles what already ended, releases what is no longer held.
// Spending is the part that needs an answer from a person, and this is that
// answer: a window it holds for, what may run inside it, and how much of it may
// run at once. Outside the window and with no policy at all, the wake path
// dispatches nothing, and everything else the tick does carries on.
//
// It narrows and never widens. There is no field here that exempts a work unit
// from the completion check, from its own approval requirement, or from the
// forbidden-action list — a policy that could grant those would be an operator
// signing a blank page, which is exactly what a written one is instead of.
//
// It is versioned and revocable because it stands in for someone who was not
// there: what was in force on a given night has to stay readable afterwards,
// and one command has to be able to take it back.

export type RiskClass = "internal" | "external" | "privileged";

export const RISK_CLASSES: RiskClass[] = ["internal", "external", "privileged"];

export interface OvernightPolicy
{
    version: number;
    setAt: string;
    // Local wall-clock times, 24-hour. A window from 22:00 to 07:00 crosses
    // midnight, which is the ordinary case rather than the exception.
    from: string;
    to: string;
    // When the operator comes back and reads the account of the night. It is
    // what `self digest` defaults its window to ending at, and it is recorded
    // with the policy so a digest run on another machine picks the same one.
    digestAt: string;
    projects: string[];
    riskClasses: RiskClass[];
    kinds: string[];
    // Null is "any the specs name", not "none": a policy that had to enumerate
    // every provider would silently stop dispatching the day one is renamed.
    providers: string[] | null;
    models: string[] | null;
    maxConcurrent: number;
    // A ceiling on declared budget, never on observed spend — no provider in
    // this product reports cost, and a ceiling that pretended to bound money
    // nobody measures would be worse than none. A spec that declares no budget
    // commits nothing against it.
    budgetUsd: number | null;
    maxRuns: number | null;
    stopAfterFailures: number | null;
    autoDispatch: boolean;
}

/* ── the fold ──────────────────────────────────────────────────────── */

// Asserted state, folded out of the synced log like a decision: the newest set
// wins and a revocation leaves none. Nothing is cached on the machine, so a
// restart, a second clone and a fresh checkout all read the same policy.
export function loadPolicy(storeDir: string, project: string): OvernightPolicy | null
{
    let policy: OvernightPolicy | null = null;
    for (const event of readEvents(storeDir, project))
    {
        if (event.type === "overnight.set")
        {
            policy = policyOf(event);
        }
        if (event.type === "overnight.revoked")
        {
            policy = null;
        }
    }
    return policy;
}

// Versions count every policy this project ever had, revoked ones included: a
// version that was reused after a revocation would make two different nights
// indistinguishable in the log.
export function policyVersion(storeDir: string, project: string): number
{
    return readEvents(storeDir, project).filter((event) => event.type === "overnight.set").length;
}

function policyOf(event: SelfEvent): OvernightPolicy
{
    return event.payload.policy as unknown as OvernightPolicy;
}

/* ── the window ────────────────────────────────────────────────────── */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validTime(value: string, flag: string): string
{
    if (!TIME.test(value))
    {
        throw new CliError(`${flag} expects a 24-hour local time like 22:00, not "${value}"`);
    }
    return value;
}

function minutes(time: string): number
{
    const [hour, minute] = time.split(":").map((part) => Number.parseInt(part, 10));
    return hour * 60 + minute;
}

function atMinute(now: Date): number
{
    return now.getHours() * 60 + now.getMinutes();
}

// A window that starts after it ends crosses midnight, so the comparison flips
// rather than the times being sorted. Equal endpoints are the whole day, which
// is what an operator who wants the policy always in force writes.
export function inWindow(policy: OvernightPolicy, now: Date): boolean
{
    const start = minutes(policy.from);
    const end = minutes(policy.to);
    if (start === end)
    {
        return true;
    }
    const at = atMinute(now);
    return start < end ? at >= start && at < end : at >= start || at < end;
}

// The instant the window running now began, or the last one that began if none
// is running. This is what a digest covers by default and what the budget and
// the stop condition are counted over: both are statements about one night.
export function windowStart(policy: OvernightPolicy, now: Date): Date
{
    const start = new Date(now);
    start.setHours(Number(policy.from.slice(0, 2)), Number(policy.from.slice(3)), 0, 0);
    if (start.getTime() > now.getTime())
    {
        start.setDate(start.getDate() - 1);
    }
    return start;
}

/* ── what a work spec is, to a policy ──────────────────────────────── */

// The sealed content the HEAD points at, or null when it is not sealed or no
// longer hashes to what it was sealed as. Every question the policy asks about
// a generation is asked of these bytes: a pointer alone says nothing about what
// would actually run.
export function generationOf(ctx: ProjectContext, head: SpecHead): WorkSpec | null
{
    const dir = specDir(ctx.storeDir, ctx.project, head.workSpec);
    const sealed = sealedGeneration(dir, head.generation);
    if (sealed === null || sealed.sha256 !== head.sha256)
    {
        return null;
    }
    try
    {
        return readGeneration(dir, sealed);
    }
    catch
    {
        return null;
    }
}

// What a spec risks, read off what it declares rather than asserted beside it.
// A separate risk field would be a second thing to keep true; the capability
// declaration is already the statement of what this run can reach, and the
// runner's preflight already enforces it.
//
// The command counts as part of that declaration. Preflight probes the domains
// a spec named, and the default boundary wrapper is empty, so a spec that names
// no domain and curls a host anyway reaches the network with nothing in its way
// — and reading only the capability list would call that internal and hand it
// to a default policy to wake. What the command says it will do is the class it
// gets, and the disagreement resolves toward the wider risk.
export function riskClassOf(spec: WorkSpec): RiskClass
{
    const capabilities = spec.capabilities;
    if (capabilities.self === true || list(capabilities.secrets).length > 0)
    {
        return "privileged";
    }
    if (list(capabilities.domains).length > 0 || capabilities.browser !== undefined || commandReachesNetwork(spec.command))
    {
        return "external";
    }
    return "internal";
}

function list(value: unknown): unknown[]
{
    return Array.isArray(value) ? value : [];
}

export function declaredBudget(spec: WorkSpec): number
{
    const declared = Number(spec.capabilities.budgetUsd);
    return Number.isFinite(declared) && declared > 0 ? declared : 0;
}

/* ── the gate ──────────────────────────────────────────────────────── */

// Why the policy will not let this generation be dispatched now. Every reason
// is one sentence naming the bound it hit and the value that hit it, because a
// person reading a tick has to be able to tell "not tonight" from "never".
export type PolicyOutcome =
    | "no-policy"
    | "auto-dispatch-off"
    | "outside-window"
    | "project-not-allowed"
    | "risk-not-allowed"
    | "kind-not-allowed"
    | "provider-not-allowed"
    | "model-not-allowed"
    | "retries-above-policy"
    | "at-concurrency-cap"
    | "over-budget"
    | "stopped"
    | "forbidden-action";

export interface PolicyRefusal
{
    outcome: PolicyOutcome;
    detail: string;
}

// What the window has already spent and already suffered. Counted once per
// tick rather than once per generation: both are folds over the same events,
// and a wake set of any size would otherwise re-read the log for each entry.
export interface WindowSpend
{
    committedUsd: number;
    failures: number;
    live: number;
}

export function windowSpend(ctx: ProjectContext, policy: OvernightPolicy, now: Date): WindowSpend
{
    const since = windowStart(policy, now).toISOString();
    const events = readEvents(ctx.storeDir, ctx.project).filter((event) => event.ts >= since);
    return {
        committedUsd: events.filter((event) => event.type === "run.woken").reduce((sum, event) => sum + wokenBudget(ctx, event), 0),
        failures: events.filter((event) => event.type === "run.failed" || event.type === "run.cancelled").length,
        live: liveAttempts(ctx.project)
    };
}

// The budget the generation a wake dispatched had declared. Read from the
// sealed bytes the wake event names, so a spec whose later generation declares
// something else does not rewrite what an earlier night committed.
function wokenBudget(ctx: ProjectContext, event: SelfEvent): number
{
    const id = String(event.payload.spec ?? "");
    const generation = Number(event.payload.generation);
    if (id === "" || !Number.isInteger(generation))
    {
        return 0;
    }
    try
    {
        const dir = specDir(ctx.storeDir, ctx.project, id);
        const sealed = sealedGeneration(dir, generation);
        return sealed === null ? 0 : declaredBudget(readGeneration(dir, sealed));
    }
    catch
    {
        return 0;
    }
}

// Attempts this machine is driving for the project right now. The cap is about
// how many providers are being spent against at once, so a run somebody started
// by hand counts against it exactly like one a wake issued.
function liveAttempts(project: string): number
{
    return listSpools().filter((spool) =>
    {
        const status = spool.status();
        return status !== null && status.project === project && DRIVEN_STATES.includes(status.state);
    }).length;
}

// What this tick has issued so far, which is spending the window has committed
// and cannot read yet. Both bounds a tick can walk past need it: the wake set
// is judged against one fold of the log, and every generation woken before this
// one has already taken an attempt slot and already committed its declared
// budget, while neither is visible in `run.woken` events the fold has read.
export interface TickDispatch
{
    count: number;
    declaredUsd: number;
}

// The whole policy gate, in one function, so the daemon and any other caller
// answer the question identically. Null means the policy permits this dispatch
// — never that anything else does: the approval gate, the live-attempt claim
// and the provider circuits are asked after this and can each still refuse.
export function policyRefusal(
    policy: OvernightPolicy | null,
    spec: WorkSpec,
    project: string,
    spend: WindowSpend,
    dispatched: TickDispatch,
    now: Date
): PolicyRefusal | null
{
    if (policy === null)
    {
        return { outcome: "no-policy", detail: "no overnight policy is in force — `self overnight set` is what grants unattended dispatch" };
    }
    if (!policy.autoDispatch)
    {
        return { outcome: "auto-dispatch-off", detail: `overnight policy v${policy.version} does not let ready work dispatch on its own` };
    }
    if (!inWindow(policy, now))
    {
        return { outcome: "outside-window", detail: `outside the overnight window ${policy.from}–${policy.to}` };
    }
    return allowRefusal(policy, spec, project)
        ?? spendRefusal(policy, spec, spend, dispatched);
}

function allowRefusal(policy: OvernightPolicy, spec: WorkSpec, project: string): PolicyRefusal | null
{
    const risk = riskClassOf(spec);
    if (!policy.projects.includes(project))
    {
        return { outcome: "project-not-allowed", detail: `project ${project} is not in overnight policy v${policy.version}` };
    }
    if (!policy.riskClasses.includes(risk))
    {
        return { outcome: "risk-not-allowed", detail: `this spec declares ${risk} risk and the policy allows ${policy.riskClasses.join(", ")}` };
    }
    if (!policy.kinds.includes(spec.role))
    {
        return { outcome: "kind-not-allowed", detail: `work kind "${spec.role}" is not one the policy allows (${policy.kinds.join(", ")})` };
    }
    // A provider is matched exactly and a model is matched by class. The
    // difference is not an oversight: a provider name is an endpoint's identity
    // and there is no family it stands for, while model names are versioned
    // under a class an operator means — `opus` is what a completion policy is
    // written in, and a night that refused `claude-opus-5` for not being the
    // string `opus` would read as a bug rather than as a bound.
    if (policy.providers !== null && !policy.providers.includes(spec.provider.name))
    {
        return { outcome: "provider-not-allowed", detail: `provider ${spec.provider.name} is not one the policy allows (${policy.providers.join(", ")})` };
    }
    if (policy.models !== null && !policy.models.some((allowed) => matchesModel(spec.requestedModel, allowed)))
    {
        return { outcome: "model-not-allowed", detail: `model ${spec.requestedModel} is not one the policy allows (${policy.models.join(", ")})` };
    }
    if (policy.maxRuns !== null && spec.retryPolicy.maxRuns > policy.maxRuns)
    {
        return {
            outcome: "retries-above-policy",
            detail: `this spec allows ${spec.retryPolicy.maxRuns} run(s) and the policy allows ${policy.maxRuns}`
        };
    }
    return null;
}

function spendRefusal(policy: OvernightPolicy, spec: WorkSpec, spend: WindowSpend, dispatched: TickDispatch): PolicyRefusal | null
{
    if (policy.stopAfterFailures !== null && spend.failures >= policy.stopAfterFailures)
    {
        return {
            outcome: "stopped",
            detail: `${spend.failures} run(s) failed this window and the policy stops after ${policy.stopAfterFailures}`
        };
    }
    const running = spend.live + dispatched.count;
    if (running >= policy.maxConcurrent)
    {
        return { outcome: "at-concurrency-cap", detail: `${running} attempt(s) already running and the policy caps concurrency at ${policy.maxConcurrent}` };
    }
    // What this tick has already handed out counts against the ceiling exactly
    // like what the window committed before it. A wake set is judged in one
    // pass against one fold, and a generation woken a moment ago records its
    // `run.woken` too late for that fold to see — so a ceiling read only off
    // the log would admit every eligible spec in the set, each one measured
    // against a window that still looks empty.
    const committed = spend.committedUsd + dispatched.declaredUsd;
    const declared = declaredBudget(spec);
    if (policy.budgetUsd !== null && committed + declared > policy.budgetUsd)
    {
        return {
            outcome: "over-budget",
            detail: `this window has committed $${committed} of a $${policy.budgetUsd} declared budget and this spec declares $${declared}`
        };
    }
    return null;
}

/* ── rendering ─────────────────────────────────────────────────────── */

export function describePolicy(policy: OvernightPolicy): string[]
{
    return [
        `version       ${policy.version}, set ${policy.setAt}`,
        `window        ${policy.from}–${policy.to} local, digest at ${policy.digestAt}`,
        `auto-dispatch ${policy.autoDispatch ? "on" : "off — nothing is woken until `self overnight set --auto-dispatch`"}`,
        `projects      ${policy.projects.join(", ")}`,
        `risk classes  ${policy.riskClasses.join(", ")}`,
        `work kinds    ${policy.kinds.join(", ")}`,
        `providers     ${policy.providers === null ? "any the specs name" : policy.providers.join(", ")}`,
        `models        ${policy.models === null ? "any the specs name" : policy.models.join(", ")}`,
        `concurrency   at most ${policy.maxConcurrent} attempt(s) at once`,
        `declared cost ${policy.budgetUsd === null ? "not bounded" : `at most $${policy.budgetUsd} declared per window`}`,
        `runs per spec ${policy.maxRuns === null ? "as the spec declares" : `at most ${policy.maxRuns}`}`,
        `stop after    ${policy.stopAfterFailures === null ? "no failure stop condition" : `${policy.stopAfterFailures} failed run(s) this window`}`,
        `never allowed ${FORBIDDEN_SUMMARY}`
    ];
}

// Read off the list itself rather than restated, so a category added there can
// never be missing from what a policy claims it will refuse.
const FORBIDDEN_SUMMARY = `${FORBIDDEN_ACTIONS.join(", ")} — categorically, and a unit awaiting approval is never woken`;
