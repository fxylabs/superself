import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { attemptId } from "../ids.js";
import { buildModel } from "../model.js";
import { CliContext, requireProject, requireWorkspace } from "../paths.js";
import { CliError } from "../types.js";
import {
    AttemptRecord,
    findAttempt,
    foldAttempts,
    newAttempt,
    patchAttempt,
    registerAttempt,
    circuits
} from "./attempt.js";
import { daemonRun, daemonStart, daemonStatus, daemonStop, parseInterval } from "./daemon.js";
import { buildDigest, printDigest } from "./digest.js";
import { appendJournal, spoolFile } from "./local.js";
import {
    DEFAULT_CIRCUIT_THRESHOLD,
    FORBIDDEN_ACTIONS,
    OvernightPolicy,
    describePolicy,
    forbiddenAction,
    loadPolicy,
    policyVersion,
    validTime
} from "./policy.js";
import { dispatchRefusal, launch, record, tick } from "./supervisor.js";

const ATTEMPT_USAGE = `usage: self attempt register --work <id> [--runtime r] [--kind k] [--model m]
                              [--risk internal|external] [--action a] [--output path]
                              [--command "…"] [--session s] [--lease key] [--after work-id]
                              [--completes] [--no-report] [--needs-approval]
                              [--budget-usd n] [--heartbeat sec] [--retries n]
       self attempt list | show <id> | run <id> | cancel <id> | approve <id>
       self attempt started <id> --pid <n> | heartbeat <id>
       self attempt exited <id> [--code n] [--provider-status capacity] [--retry-at ts]
       self attempt propose <id> --action <kind>`;

export function runAttempt(rest: string[]): void
{
    const verb = rest[0];
    if (verb === "register")
    {
        registerCommand(rest.slice(1));
        return;
    }
    if (verb === "list")
    {
        listAttempts(requireWorkspace(process.cwd()));
        return;
    }
    const handlers: Record<string, (ctx: CliContext, attempt: AttemptRecord, args: string[]) => void> = {
        show: showAttempt,
        run: runNow,
        started: markStarted,
        heartbeat: beat,
        exited: markExited,
        approve: approve,
        cancel: cancel,
        propose: proposeAction
    };
    const handler = handlers[verb ?? ""];
    if (handler === undefined)
    {
        throw new CliError(ATTEMPT_USAGE);
    }
    const ctx = requireWorkspace(process.cwd());
    handler(ctx, requireAttempt(ctx, rest[1]), rest.slice(2));
}

function requireAttempt(ctx: CliContext, id: string | undefined): AttemptRecord
{
    if (id === undefined || id.trim() === "")
    {
        throw new CliError("… <attempt-id> — run `self attempt list` to see ids");
    }
    const attempt = findAttempt(foldAttempts(ctx.storeDir), id.trim());
    if (attempt === undefined)
    {
        throw new CliError(`unknown attempt "${id}" — run \`self attempt list\` to see ids`);
    }
    return attempt;
}

/* ── registration ──────────────────────────────────────────────────── */

const REGISTER_OPTIONS = {
    work: { type: "string" },
    runtime: { type: "string" },
    kind: { type: "string" },
    model: { type: "string" },
    risk: { type: "string" },
    action: { type: "string", multiple: true },
    output: { type: "string", multiple: true },
    command: { type: "string" },
    session: { type: "string" },
    lease: { type: "string" },
    after: { type: "string", multiple: true },
    completes: { type: "boolean" },
    "no-report": { type: "boolean" },
    "needs-approval": { type: "boolean" },
    "budget-usd": { type: "string" },
    heartbeat: { type: "string" },
    retries: { type: "string" }
} as const;

// Registration happens before the process exists, which is the only moment
// the supervisor can still refuse a launch it would have to clean up after.
function registerCommand(args: string[]): void
{
    const { values } = parseArgs({ args, options: REGISTER_OPTIONS });
    const ctx = requireProject(process.cwd());
    const work = requireOpenWork(ctx, values.work);
    const id = attemptId();
    const attempt = newAttempt(id, ctx.project, work, new Date().toISOString());
    attempt.runtime = values.runtime ?? "unknown";
    attempt.kind = values.kind ?? "implementation";
    attempt.model = values.model ?? null;
    attempt.riskClass = requireRisk(values.risk);
    attempt.actions = values.action ?? [];
    attempt.declared = (values.output ?? []).map((path) => resolve(path));
    attempt.command = values.command ?? null;
    attempt.session = values.session ?? process.env.SUPERSELF_SESSION ?? null;
    attempt.lease = values.lease ?? null;
    attempt.dependsOn = values.after ?? [];
    attempt.completes = values.completes === true;
    attempt.requireReport = values["no-report"] !== true;
    attempt.needsApproval = values["needs-approval"] === true;
    attempt.budgetUsd = optionalNumber(values["budget-usd"], "--budget-usd");
    attempt.heartbeatSec = optionalNumber(values.heartbeat, "--heartbeat") ?? 900;
    attempt.maxRetries = optionalNumber(values.retries, "--retries") ?? 0;
    attempt.state = attempt.needsApproval ? "waiting-approval" : "registered";
    refuseForbidden(attempt.actions);
    requireFreshReviewSession(ctx, attempt);
    registerAttempt(ctx.storeDir, attempt);
    record(ctx, ctx.project, "attempt.registered", registeredPayload(attempt), { work }, `${work} attempt ${id} registered`);
    console.log(id);
}

function registeredPayload(attempt: AttemptRecord): Record<string, unknown>
{
    return {
        text: `${attempt.work} attempt ${attempt.id} registered for ${attempt.runtime} (${attempt.kind}, risk ${attempt.riskClass})`,
        attempt: attempt.id,
        runtime: attempt.runtime,
        kind: attempt.kind,
        model: attempt.model,
        riskClass: attempt.riskClass,
        actions: attempt.actions,
        declared: attempt.declared.map((path) => basename(path)),
        dependsOn: attempt.dependsOn,
        completes: attempt.completes,
        needsApproval: attempt.needsApproval,
        heartbeatSec: attempt.heartbeatSec,
        budgetUsd: attempt.budgetUsd
    };
}

function refuseForbidden(actions: string[]): void
{
    const forbidden = forbiddenAction(actions);
    if (forbidden !== null)
    {
        throw new CliError(`"${forbidden}" needs human approval and no overnight policy can grant it — never allowed: ${FORBIDDEN_ACTIONS.join(", ")}`);
    }
}

// A review that runs in the session that wrote the code is not a review. The
// implementation's session is on record, so the check is mechanical.
function requireFreshReviewSession(ctx: CliContext & { project: string }, attempt: AttemptRecord): void
{
    if (attempt.kind !== "review")
    {
        return;
    }
    const prior = foldAttempts(ctx.storeDir).filter((item) => item.work === attempt.work && item.kind !== "review");
    if (prior.length === 0)
    {
        throw new CliError(`no implementation attempt is on record for ${attempt.work} — there is nothing to review yet`);
    }
    if (prior.some((item) => item.session === attempt.session))
    {
        throw new CliError("a review must run in a fresh session — pass --session with an id the implementation did not use");
    }
}

function requireRisk(value: string | undefined): string
{
    const risk = value ?? "internal";
    if (risk !== "internal" && risk !== "external")
    {
        throw new CliError('--risk expects internal or external');
    }
    return risk;
}

function optionalNumber(value: string | undefined, flag: string): number | null
{
    if (value === undefined)
    {
        return null;
    }
    const parsed = Number(value);
    if (Number.isNaN(parsed) || parsed < 0)
    {
        throw new CliError(`${flag} expects a non-negative number`);
    }
    return parsed;
}

function requireOpenWork(ctx: CliContext & { project: string }, id: string | undefined): string
{
    if (id === undefined)
    {
        throw new CliError("self attempt register --work <id> — every attempt belongs to a work unit");
    }
    const work = buildModel(ctx.storeDir, ctx.project, new Date()).works.find((item) => item.id === id);
    if (work === undefined)
    {
        throw new CliError(`unknown work id "${id}" — run \`self work\` to list ids`);
    }
    if (work.status === "done")
    {
        throw new CliError(`${id} is already done`);
    }
    return id;
}

/* ── attempt verbs ─────────────────────────────────────────────────── */

function listAttempts(ctx: CliContext): void
{
    const attempts = foldAttempts(ctx.storeDir);
    if (attempts.length === 0)
    {
        console.log("no attempts registered — register one with `self attempt register --work <id>`");
        return;
    }
    for (const attempt of attempts)
    {
        const verdict = attempt.verdict === null ? "" : ` ${attempt.verdict}`;
        console.log(`${attempt.id}  ${attempt.state}${verdict}  ${attempt.project}  ${attempt.work}  ${attempt.kind}/${attempt.runtime}`);
    }
}

function showAttempt(ctx: CliContext, attempt: AttemptRecord): void
{
    const lines = [
        `${attempt.id}  ${attempt.state}${attempt.verdict === null ? "" : ` (${attempt.verdict})`}`,
        `work        ${attempt.project} ${attempt.work}`,
        `runtime     ${attempt.kind}/${attempt.runtime}${attempt.model === null ? "" : ` on ${attempt.model}`}`,
        `risk        ${attempt.riskClass}${attempt.actions.length === 0 ? "" : ` — actions: ${attempt.actions.join(", ")}`}`,
        `declared    ${attempt.declared.length === 0 ? "none" : attempt.declared.map((path) => basename(path)).join(", ")}`,
        `contract    ${attempt.requireReport ? "report required" : "no report required"}, ${attempt.completes ? "completes the work" : "does not complete the work"}`,
        `heartbeat   every ${attempt.heartbeatSec}s, last ${attempt.lastBeat ?? "never"}`,
        `tries       ${attempt.tries}, retries allowed ${attempt.maxRetries}`,
        `cost        ${attempt.costUsd === null ? "unknown" : `$${attempt.costUsd}`}, tokens ${attempt.usage === null ? "unknown" : attempt.usage}`,
        `exit        ${attempt.exitSource ?? "not observed"}${attempt.exitCode === null ? "" : ` code ${attempt.exitCode}`}`
    ];
    for (const hash of Object.entries(attempt.hashes))
    {
        lines.push(`output      ${hash[0]} ${hash[1]}`);
    }
    for (const reason of attempt.reasons)
    {
        lines.push(`reason      ${reason}`);
    }
    console.log(lines.join("\n"));
}

// Manual dispatch answers to every gate except the overnight window: a person
// at the keyboard is the approval the window stands in for.
function runNow(ctx: CliContext, attempt: AttemptRecord): void
{
    if (attempt.command === null)
    {
        throw new CliError(`${attempt.id} was registered without a command — launch it yourself and record it with \`self attempt started ${attempt.id} --pid <n>\``);
    }
    if (attempt.state === "running" || attempt.state === "exited")
    {
        throw new CliError(`${attempt.id} is already ${attempt.state}`);
    }
    if (attempt.state === "settled")
    {
        throw new CliError(`${attempt.id} already settled as ${attempt.verdict} — register a new attempt instead of re-running a judged one`);
    }
    const attempts = foldAttempts(ctx.storeDir);
    const policy = loadPolicy(ctx.storeDir, attempt.project);
    const refusal = dispatchRefusal(ctx, attempts, attempt, policy, new Date());
    if (refusal !== null)
    {
        throw new CliError(`${attempt.id} cannot start — ${refusal}`);
    }
    launch(ctx, attempt, new Date());
    console.log(`${attempt.id} running (pid ${attempt.pid})`);
}

function markStarted(ctx: CliContext, attempt: AttemptRecord, args: string[]): void
{
    const { values } = parseArgs({ args, options: { pid: { type: "string" } } });
    if (values.pid === undefined)
    {
        throw new CliError("self attempt started <id> --pid <n>");
    }
    const now = new Date().toISOString();
    patchAttempt(ctx.storeDir, attempt, "start", {
        state: "running",
        pid: Number.parseInt(values.pid, 10),
        startedAt: now,
        lastBeat: now,
        tries: attempt.tries + 1
    }, now);
    record(ctx, attempt.project, "attempt.started",
        { text: `${attempt.work} attempt ${attempt.id} started on ${attempt.runtime}`, attempt: attempt.id },
        { work: attempt.work }, `${attempt.work} attempt ${attempt.id} started`);
}

function beat(ctx: CliContext, attempt: AttemptRecord): void
{
    const now = new Date().toISOString();
    patchAttempt(ctx.storeDir, attempt, "beat", { lastBeat: now }, now);
    console.log(`${attempt.id} heartbeat ${now}`);
}

// A durable exit notice: written to the spool so the supervisor finds it
// whenever it next looks, and ignored once the attempt has settled.
function markExited(ctx: CliContext, attempt: AttemptRecord, args: string[]): void
{
    const { values } = parseArgs({
        args,
        options: {
            code: { type: "string" },
            "provider-status": { type: "string" },
            "retry-at": { type: "string" }
        }
    });
    if (attempt.state === "settled")
    {
        console.log(`${attempt.id} already settled as ${attempt.verdict} — exit notice ignored`);
        return;
    }
    writeFileSync(spoolFile(ctx.storeDir, attempt.id, "exit"), String(values.code ?? "0"));
    if (values["provider-status"] !== undefined)
    {
        writeFileSync(spoolFile(ctx.storeDir, attempt.id, "provider.json"), JSON.stringify({
            status: values["provider-status"],
            retryAt: values["retry-at"] ?? null
        }) + "\n");
    }
    if (attempt.state !== "running")
    {
        patchAttempt(ctx.storeDir, attempt, "start", { state: "running" }, new Date().toISOString());
    }
    console.log(`${attempt.id} exit notice recorded — the supervisor settles it on the next pass`);
}

function approve(ctx: CliContext, attempt: AttemptRecord): void
{
    const now = new Date().toISOString();
    patchAttempt(ctx.storeDir, attempt, "approve", { approved: true, state: "registered" }, now);
    record(ctx, attempt.project, "attempt.approved",
        { text: `${attempt.work} attempt ${attempt.id} approved by the user`, attempt: attempt.id },
        { work: attempt.work }, `${attempt.work} attempt ${attempt.id} approved`);
}

function cancel(ctx: CliContext, attempt: AttemptRecord): void
{
    const now = new Date().toISOString();
    if (attempt.pid !== null && attempt.state === "running")
    {
        try
        {
            process.kill(attempt.pid, "SIGTERM");
        }
        catch
        {
            // The process is already gone; the request is what must persist.
        }
    }
    patchAttempt(ctx.storeDir, attempt, "cancel", { cancelRequested: true }, now);
    record(ctx, attempt.project, "attempt.cancelled",
        { text: `${attempt.work} attempt ${attempt.id} cancelled by the user`, attempt: attempt.id },
        { work: attempt.work }, `${attempt.work} attempt ${attempt.id} cancelled`);
}

// An agent may ask for anything mid-run. The forbidden list is checked here
// too, because a proposal that arrives after launch is still a proposal.
function proposeAction(ctx: CliContext, attempt: AttemptRecord, args: string[]): void
{
    const { values } = parseArgs({ args, options: { action: { type: "string" } } });
    if (values.action === undefined)
    {
        throw new CliError("self attempt propose <id> --action <kind>");
    }
    const action = values.action.toLowerCase();
    const now = new Date().toISOString();
    if (FORBIDDEN_ACTIONS.includes(action))
    {
        appendJournal(ctx.storeDir, { ts: now, attempt: attempt.id, kind: "proposal.refused", patch: { action } });
        record(ctx, attempt.project, "attempt.refused",
            { text: `${attempt.work} attempt ${attempt.id} proposed "${action}" and was refused`, attempt: attempt.id, action },
            { work: attempt.work }, `${attempt.work} refused ${action}`);
        throw new CliError(`"${action}" is never allowed without human approval — the proposal is on record and the attempt keeps running`);
    }
    patchAttempt(ctx.storeDir, attempt, "propose", {
        actions: [...attempt.actions, action],
        needsApproval: true,
        approved: false
    }, now);
    console.log(`${attempt.id} proposed "${action}" — waiting on human approval`);
}

/* ── daemon ────────────────────────────────────────────────────────── */

export async function runDaemon(rest: string[]): Promise<void>
{
    const ctx = requireWorkspace(process.cwd());
    const { values } = parseArgs({ args: rest.slice(1), options: { interval: { type: "string" } }, allowPositionals: true });
    const interval = parseInterval(values.interval);
    switch (rest[0])
    {
        case "start": daemonStart(ctx, interval); break;
        case "stop": daemonStop(ctx); break;
        case "status": daemonStatus(ctx); break;
        case "run": await daemonRun(ctx, interval); break;
        case "tick": printTick(ctx); break;
        case "reset-circuit": resetCircuit(ctx, rest[1]); break;
        case "circuits": printCircuits(ctx); break;
        default: throw new CliError("usage: self daemon start [--interval s] | stop | status | tick | circuits | reset-circuit <project/runtime>");
    }
}

function printTick(ctx: CliContext): void
{
    const summary = tick(ctx, new Date());
    const groups: [string, string[]][] = [
        ["reconciled", summary.reconciled],
        ["settled", summary.settled],
        ["dispatched", summary.dispatched],
        ["held back", summary.skipped]
    ];
    const moved = groups.filter(([, items]) => items.length > 0);
    if (moved.length === 0)
    {
        console.log("tick: nothing to do");
        return;
    }
    for (const [label, items] of moved)
    {
        console.log(`${label}: ${items.join("; ")}`);
    }
}

function printCircuits(ctx: CliContext): void
{
    const threshold = loadPolicy(ctx.storeDir, ctx.project ?? "")?.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD;
    const states = circuits(ctx.storeDir, threshold);
    if (states.length === 0)
    {
        console.log("no runtime has failed yet");
        return;
    }
    for (const state of states)
    {
        console.log(`${state.key}  ${state.open ? "open" : "closed"}  ${state.failures} consecutive failure(s) of ${threshold}`);
    }
}

function resetCircuit(ctx: CliContext, key: string | undefined): void
{
    if (key === undefined)
    {
        throw new CliError("self daemon reset-circuit <project/runtime>");
    }
    appendJournal(ctx.storeDir, { ts: new Date().toISOString(), attempt: "-", kind: "circuit.reset", patch: { key } });
    console.log(`circuit ${key} closed`);
}

/* ── overnight policy ──────────────────────────────────────────────── */

const POLICY_OPTIONS = {
    from: { type: "string" },
    to: { type: "string" },
    wake: { type: "string" },
    project: { type: "string", multiple: true },
    risk: { type: "string", multiple: true },
    kind: { type: "string", multiple: true },
    "max-concurrent": { type: "string" },
    "budget-usd": { type: "string" },
    retries: { type: "string" },
    "circuit-at": { type: "string" },
    "auto-dispatch": { type: "boolean" },
    "hard-model": { type: "string" },
    "no-fresh-review": { type: "boolean" }
} as const;

export function runOvernight(rest: string[]): void
{
    if (rest[0] === "show" || rest[0] === undefined)
    {
        showPolicy(requireProject(process.cwd()));
        return;
    }
    if (rest[0] === "off")
    {
        revokePolicy(requireProject(process.cwd()));
        return;
    }
    if (rest[0] !== "set")
    {
        throw new CliError("usage: self overnight set [--from 22:00] [--to 07:00] [--wake 07:30] [--project p] [--risk r] [--kind k] [--max-concurrent n] [--budget-usd n] [--retries n] [--circuit-at n] [--auto-dispatch] [--hard-model m] [--no-fresh-review] | show | off");
    }
    setPolicy(requireProject(process.cwd()), rest.slice(1));
}

// The policy is versioned and revocable because it stands in for the user
// while they are asleep: what it allowed on a given night must stay legible
// afterwards, and one command must be able to take it back.
function setPolicy(ctx: CliContext & { project: string }, args: string[]): void
{
    const { values } = parseArgs({ args, options: POLICY_OPTIONS });
    const policy: OvernightPolicy = {
        version: policyVersion(ctx.storeDir, ctx.project) + 1,
        setAt: new Date().toISOString(),
        from: validTime(values.from ?? "22:00", "--from"),
        to: validTime(values.to ?? "07:00", "--to"),
        wake: validTime(values.wake ?? "07:30", "--wake"),
        projects: values.project ?? [ctx.project],
        riskClasses: values.risk ?? ["internal"],
        kinds: values.kind ?? ["implementation", "review", "maintenance"],
        maxConcurrent: Number(values["max-concurrent"] ?? 2),
        budgetUsd: values["budget-usd"] === undefined ? null : Number(values["budget-usd"]),
        maxRetries: Number(values.retries ?? 1),
        circuitThreshold: Number(values["circuit-at"] ?? DEFAULT_CIRCUIT_THRESHOLD),
        autoDispatch: values["auto-dispatch"] === true,
        requireHardModel: values["hard-model"] ?? null,
        requireFreshReview: values["no-fresh-review"] !== true
    };
    if (policy.riskClasses.includes("external"))
    {
        throw new CliError("--risk external cannot run unattended — external-risk work waits for a person");
    }
    record(ctx, ctx.project, "overnight.policy.set",
        { text: `overnight policy v${policy.version}: ${policy.from}–${policy.to}, ${policy.autoDispatch ? "auto-dispatch on" : "auto-dispatch off"}`, policy: policy as unknown as Record<string, unknown> },
        undefined, `overnight policy v${policy.version}`);
    console.log(describePolicy(policy).join("\n"));
}

function revokePolicy(ctx: CliContext & { project: string }): void
{
    if (loadPolicy(ctx.storeDir, ctx.project) === null)
    {
        console.log("no overnight policy is in force");
        return;
    }
    record(ctx, ctx.project, "overnight.policy.revoked",
        { text: "overnight policy revoked — nothing dispatches unattended" }, undefined, "overnight policy revoked");
}

function showPolicy(ctx: CliContext & { project: string }): void
{
    const policy = loadPolicy(ctx.storeDir, ctx.project);
    console.log(policy === null
        ? "no overnight policy is in force — nothing dispatches unattended"
        : describePolicy(policy).join("\n"));
}

/* ── digest ────────────────────────────────────────────────────────── */

export function runDigest(rest: string[]): void
{
    const ctx = requireWorkspace(process.cwd());
    const { values } = parseArgs({ args: rest, options: { hours: { type: "string" }, since: { type: "string" } } });
    const now = new Date();
    printDigest(buildDigest(ctx, digestSince(values.hours, values.since, now), now));
}

function digestSince(hours: string | undefined, since: string | undefined, now: Date): Date
{
    if (since !== undefined)
    {
        const parsed = new Date(since);
        if (Number.isNaN(parsed.getTime()))
        {
            throw new CliError(`--since expects a timestamp, not "${since}"`);
        }
        return parsed;
    }
    const span = hours === undefined ? 12 : Number(hours);
    if (Number.isNaN(span) || span <= 0)
    {
        throw new CliError("--hours expects a positive number");
    }
    return new Date(now.getTime() - span * 3_600_000);
}
