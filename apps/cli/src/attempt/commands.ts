import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseCommand } from "../args.js";
import { bootId } from "./boundary.js";
import { queueDirective } from "./directive.js";
import { claimStarted, externalExited, externalHeartbeat, registerAttempt } from "./external.js";
import { forbiddenAction, forbiddenDeclaration, forbiddenRefusal } from "../daemon/forbidden.js";
import { AttemptPlan, planScope, readPlan } from "./plan.js";
import { PreflightReceipt } from "./preflight.js";
import { bindingOf, releaseWorkdir, StepRecord } from "./provision.js";
import { readBreaker, resetBreaker } from "./retry.js";
import { AttemptStatus, deadVerdict, DeadVerdict, listSpools, openSpool, ownerOf, PREPARATION_LOG, pruneSpools, readRunnerConfig, Spool, spoolBytes, writeRunnerConfig } from "./spool.js";
import { BUSY, trySettling } from "./settlement.js";
import { AttemptResult, nextFence, runAttempt, settleAttempt, settleConfirmedExit } from "./run.js";
import { treeAlive, treeContain, treeTerminate } from "./tree.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { CliContext, ProjectContext, requireProject } from "../paths.js";
import { dim, green, red, styled, yellow } from "../style.js";
import { CliError } from "../types.js";

export async function runAttemptCommand(rest: string[]): Promise<void>
{
    switch (rest[0])
    {
        case "run": await cmdRun(rest.slice(1)); return;
        case "register": await cmdRegister(rest.slice(1)); return;
        case "started": cmdStarted(rest.slice(1)); return;
        case "heartbeat": cmdHeartbeat(rest.slice(1)); return;
        case "exited": await cmdExited(rest.slice(1)); return;
        case "list": cmdList(rest.slice(1)); return;
        case "show": cmdShow(rest.slice(1)); return;
        case "directive": cmdDirective(rest.slice(1)); return;
        case "propose": cmdPropose(rest.slice(1)); return;
        case "cancel": cmdCancel(rest.slice(1)); return;
        case "settle": await cmdSettle(rest.slice(1)); return;
        case "recover": await cmdRecover(rest.slice(1)); return;
        case "prune": cmdPrune(rest.slice(1)); return;
        case "retention": cmdRetention(rest.slice(1)); return;
        case "breaker": cmdBreaker(rest.slice(1)); return;
        default: throw new CliError("usage: self attempt run <plan.json> | register <plan.json> | started <id> --pid N | heartbeat <id> | exited <id> [--code N] | list | show <id> | directive <id> \"<text>\" | propose <id> --action <kind> | cancel <id> | settle <id> | recover | prune [--days N] | retention [<days>] | breaker [<provider>] [--reset]");
    }
}

async function cmdRun(args: string[]): Promise<void>
{
    const [file] = parseCommand("attempt", args, {}, 1).positionals;
    if (file === undefined)
    {
        throw new CliError("usage: self attempt run <plan.json>");
    }
    const ctx = requireProject(process.cwd());
    const plan = refuseForbidden(readPlan(file), file);
    const result = await runAttempt(ctx, plan, { now: new Date() });
    if (result.state !== "completed")
    {
        process.exitCode = 1;
    }
}

// The same preflight `run` does, without the launch. What comes back on stdout
// is the attempt id, so the launcher that registered it can address everything
// else to it.
async function cmdRegister(args: string[]): Promise<void>
{
    const [file] = parseCommand("attempt", args, {}, 1).positionals;
    if (file === undefined)
    {
        throw new CliError("usage: self attempt register <plan.json>");
    }
    const result = await registerAttempt(requireProject(process.cwd()), refuseForbidden(readPlan(file), file), { now: new Date() });
    if (result.state !== "registered")
    {
        process.exitCode = 1;
    }
}

// The forbidden-action list, at the moment a plan is first handed to the CLI.
// This is not a capability check — preflight already owns what the run may
// reach — it is the categorical one: an attempt that declares it will publish,
// pay, provision or delete is refused before a spool exists for it, because
// there is no later point at which refusing it costs nothing.
function refuseForbidden(plan: AttemptPlan, file: string): AttemptPlan
{
    const forbidden = forbiddenDeclaration(plan);
    if (forbidden !== null)
    {
        throw new CliError(forbiddenRefusal(forbidden, `attempt plan "${file}"`));
    }
    return plan;
}

function cmdStarted(args: string[]): void
{
    const { values, positionals } = parseCommand("attempt", args, { pid: { type: "string" } }, 1);
    const pid = Number(values.pid);
    if (positionals[0] === undefined || !Number.isInteger(pid) || pid <= 0)
    {
        throw new CliError("usage: self attempt started <attempt-id> --pid <pid>");
    }
    const status = claimStarted(requireProject(process.cwd()), positionals[0], pid);
    console.log(`attempt ${status.attempt} is running under an external launcher at fence ${status.fence}`);
}

function cmdHeartbeat(args: string[]): void
{
    const [id] = parseCommand("attempt", args, {}, 1).positionals;
    if (id === undefined)
    {
        throw new CliError("usage: self attempt heartbeat <attempt-id>");
    }
    externalHeartbeat(id);
}

async function cmdExited(args: string[]): Promise<void>
{
    const { values, positionals } = parseCommand("attempt", args, { code: { type: "string" } }, 1);
    const code = values.code === undefined ? 0 : Number(values.code);
    if (positionals[0] === undefined || !Number.isInteger(code))
    {
        throw new CliError("usage: self attempt exited <attempt-id> [--code N]");
    }
    const result = await externalExited(requireProject(process.cwd()), positionals[0], code, { now: new Date() });
    if (result.state !== "completed")
    {
        process.exitCode = 1;
    }
}

function cmdList(args: string[]): void
{
    const { values } = parseArgs({ args, options: { work: { type: "string" }, json: { type: "boolean" } } });
    const statuses = listSpools()
        .map((spool) => spool.status())
        .filter((status): status is AttemptStatus => status !== null)
        .filter((status) => values.work === undefined || status.work === values.work);
    if (values.json === true)
    {
        console.log(JSON.stringify(statuses, null, 2));
        return;
    }
    if (statuses.length === 0)
    {
        console.log("no attempts on this machine — start one with `self attempt run <plan.json>`");
        return;
    }
    for (const status of statuses)
    {
        console.log(statusLine(status));
    }
}

function statusLine(status: AttemptStatus): string
{
    const failure = status.failure === undefined ? "" : `  ${status.failure}`;
    const line = `${status.attempt}  ${status.work}  ${status.state}${failure}  run ${status.run}/${status.runs}`;
    return styled ? `${stateColour(status.state)(line)}` : line;
}

function stateColour(state: AttemptStatus["state"]): (text: string) => string
{
    if (state === "completed")
    {
        return green;
    }
    if (state === "failed" || state === "exited-unreconciled" || state === "preflight-failed")
    {
        return red;
    }
    if (state === "waiting-provider" || state === "retrying" || state === "cancelled")
    {
        return yellow;
    }
    return dim;
}

function cmdShow(args: string[]): void
{
    const [id] = parseCommand("attempt", args, {}, 1).positionals;
    if (id === undefined)
    {
        throw new CliError("usage: self attempt show <attempt-id>");
    }
    const spool = openSpool(id);
    const status = spool.status();
    if (status === null)
    {
        throw new CliError(`attempt "${id}" has no status record`);
    }
    console.log(`${status.attempt}  ${status.work}  ${status.role}`);
    console.log(`state      ${status.state}${status.failure === undefined ? "" : ` (${status.failure})`}`);
    if (status.detail !== undefined)
    {
        console.log(`detail     ${status.detail}`);
    }
    if (status.exitSource !== undefined)
    {
        console.log(`exit       ${status.exitSource}${status.exitCode === undefined ? "" : ` (code ${status.exitCode})`}`);
    }
    console.log(`runs       ${status.runs} of this attempt, fence ${status.fence}`);
    console.log(`node       ${status.nodeId} boot ${status.bootId}${status.pid === undefined ? "" : ` pid ${status.pid}`}`);
    console.log(`spool      ${spool.dir} (${spoolBytes(spool.dir)} bytes)`);
    printPreparation(spool);
    printReceipt(spool);
    for (const line of spool.readLines<Record<string, unknown>>("runs.jsonl"))
    {
        console.log(`run ${line.run}  exit ${line.exit}  ${line.failure ?? "ok"}${line.backoffMs === undefined ? "" : `  backoff ${line.backoffMs}ms of ${line.backoffCapMs}ms`}`);
    }
    const request = spool.path("approval-request.txt");
    if (existsSync(request))
    {
        console.log("");
        console.log(readFileSync(request, "utf8").trimEnd());
    }
}

// What the runner bound this attempt to and what preparation it ran there. An
// operator reading a failed attempt has to be able to tell a bad build from a
// preparation that never finished, and the steps are where that is said.
function printPreparation(spool: Spool): void
{
    const binding = bindingOf(spool);
    if (binding === null)
    {
        return;
    }
    console.log(`workdir    ${binding.workdir} — ${binding.repo} at ${binding.head.slice(0, 12)}${binding.released ? " (released)" : ""}`);
    console.log(`binding    ${binding.digest.slice(0, 12)}  template ${binding.template ?? "none"}  ${binding.steps} step(s)`);
    for (const step of spool.readLines<StepRecord>(PREPARATION_LOG))
    {
        console.log(`  prep ${step.step}  ${step.name}  ${step.timedOut ? "timed out" : `exit ${step.exit}`}  ${step.durationMs}ms`);
    }
}

function printReceipt(spool: Spool): void
{
    const receipt = spool.readJson<PreflightReceipt>("preflight.json");
    if (receipt === null)
    {
        return;
    }
    console.log(`boundary   ${receipt.adapter} ${receipt.boundaryDigest.slice(0, 12)} (probe saw ${receipt.innerDigest?.slice(0, 12) ?? "nothing"}), policy ${receipt.policyDigest.slice(0, 12)}`);
    for (const check of receipt.checks)
    {
        console.log(`  ${check.ok ? "ok  " : "FAIL"} ${check.capability.padEnd(9)} ${check.target}  ${dim(check.detail)}`);
    }
}

function cmdDirective(args: string[]): void
{
    const [id, text] = parseCommand("attempt", args, {}, 2).positionals;
    if (id === undefined || text === undefined || text.trim() === "")
    {
        throw new CliError('usage: self attempt directive <attempt-id> "<text>"');
    }
    const directive = queueDirective(openSpool(id), "followup", text);
    console.log(`follow-up ${directive.id} queued for ${id} — it is delivered from the spool, not from a terminal`);
}

// An agent may ask for anything mid-run, and the answer to a forbidden category
// is the same one it would have got at registration. It is refused where it
// arrives rather than queued for the morning: a queue is a promise that
// somebody will decide, and these are the actions nobody decides unattended.
//
// The refusal is recorded before it is thrown, because the interesting fact is
// not that the attempt was stopped — it kept running — but that it asked. An
// operator who reads the digest has to find that out.
function cmdPropose(args: string[]): void
{
    const { values, positionals } = parseCommand("attempt", args, { action: { type: "string" } }, 1);
    const [id] = positionals;
    if (id === undefined || values.action === undefined || values.action.trim() === "")
    {
        throw new CliError("usage: self attempt propose <attempt-id> --action <kind>");
    }
    const ctx = requireProject(process.cwd());
    const status = openSpool(id).status();
    if (status === null)
    {
        throw new CliError(`attempt "${id}" has no status record`);
    }
    // The same split settlement makes: an attempt of another project records
    // into that project's log, and the branch stamp of this checkout is not
    // that project's branch.
    const owner: CliContext = status.project === ctx.project ? ctx : { ...ctx, projectDir: undefined };
    const category = forbiddenAction(values.action);
    const refs = { work: status.work, attempt: status.attempt };
    if (category === null)
    {
        recordEvent(owner, makeEvent(status.project, "run.proposed", { attempt: status.attempt, action: values.action }, refs),
            `${status.work} proposed ${values.action}`);
        console.log(`${status.attempt} proposed "${values.action}" — it is on record and waits for a person; nothing was granted`);
        return;
    }
    recordEvent(owner, makeEvent(status.project, "run.refused", { attempt: status.attempt, action: values.action, category }, refs),
        `${status.work} refused ${values.action}`);
    throw new CliError(forbiddenRefusal({ action: values.action, category }, `attempt ${status.attempt}`) +
        " — the proposal is on record and the attempt keeps running");
}

// A cancel reaches the runner's own attempts through the spool, because the
// runner is watching it. Nothing watches the spool of a process the runner did
// not spawn, so an externally launched attempt is contained through the
// process group its launcher claimed — and only while that group still holds
// something that launch put there, so a group id handed on after this one
// emptied never receives this attempt's containment.
function cmdCancel(args: string[]): void
{
    const [id] = parseCommand("attempt", args, {}, 1).positionals;
    if (id === undefined)
    {
        throw new CliError("usage: self attempt cancel <attempt-id>");
    }
    const spool = openSpool(id);
    const directive = queueDirective(spool, "cancel", "cancel requested");
    console.log(`cancel ${directive.id} queued for ${id}`);
    const owner = ownerOf(spool);
    if (owner === null)
    {
        return;
    }
    const contained = treeTerminate(owner, "SIGTERM");
    spool.append("events.jsonl", { event: "run.contained", contained });
    console.log(contained
        ? `the process group attempt ${id} was launched in has been signalled — \`self attempt recover\` settles the spool once it is gone`
        : `no process this launch of attempt ${id} started is still running — no signal was sent`);
}

async function cmdSettle(args: string[]): Promise<void>
{
    const [id] = parseCommand("attempt", args, {}, 1).positionals;
    if (id === undefined)
    {
        throw new CliError("usage: self attempt settle <attempt-id>");
    }
    await settleAttempt(requireProject(process.cwd()), openSpool(id));
}

// A crash or a restart leaves a spool that still says `running`. Nothing here
// decides for itself that such an attempt succeeded: an exit nobody confirmed
// says nothing about what the run produced, and the honest verdict is that it
// exited without being reconciled. An exit a launcher did watch happen is the
// one exception, and it is not this command's judgement either — it goes to
// the completion gate, the same one the supervisor's reconciliation uses.
async function cmdRecover(args: string[]): Promise<void>
{
    parseCommand("attempt", args, {}, 0);
    const ctx = requireProject(process.cwd());
    const boot = bootId();
    const now = Date.now();
    const done: Recovery[] = [];
    for (const spool of listSpools())
    {
        const status = spool.status();
        if (status === null)
        {
            continue;
        }
        const verdict = deadVerdict(spool, status, boot, now);
        if (verdict === null)
        {
            continue;
        }
        // Behind the attempt's settlement lock, and only if it is free. A
        // settlement in flight is invisible in everything the verdict above
        // reads — the launcher inside the completion gate is not the process
        // the status names — and taking the attempt over would fence out the
        // one settler that is finishing it properly. It is left alone and
        // named, rather than recovered from under whoever holds it.
        const taken = await trySettling(status.attempt, async () => recoverOne(ctx, spool, status, verdict));
        if (taken === BUSY)
        {
            console.error(`attempt ${status.attempt} is being settled by another process right now — it was left alone`);
            continue;
        }
        done.push(taken);
    }
    console.log(recoveryLine(done));
}

// What one pass of recovery did, so the two outcomes are not reported as one.
// An attempt the gate settled produced a result; one written off did not, and
// an operator reading "recovered 2" has to be able to tell them apart.
type Recovery = "settled" | "gate-failed" | "unreconciled" | "held";

function recoveryLine(done: Recovery[]): string
{
    const counted = done.filter((item) => item !== "held");
    if (counted.length === 0)
    {
        return "no attempt needed recovery";
    }
    const parts = [`recovered ${counted.length} attempt(s)`];
    for (const [outcome, phrase] of RECOVERY_PHRASES)
    {
        const many = counted.filter((item) => item === outcome).length;
        if (many > 0)
        {
            parts.push(`${many} ${phrase}`);
        }
    }
    return parts.join(" — ");
}

const RECOVERY_PHRASES: [Recovery, string][] = [
    ["settled", "settled through the completion gate"],
    ["gate-failed", "refused by the completion gate"],
    ["unreconciled", "as exited-unreconciled"]
];

// One attempt, judged again under the lock. An attempt whose launch rides out
// the containment keeps its work unit; a confirmed exit over a run that left a
// result goes to the completion gate; everything else is written off.
async function recoverOne(ctx: ProjectContext, spool: Spool, status: AttemptStatus, verdict: DeadVerdict): Promise<Recovery>
{
    // The terminal write below releases the work unit, and a dead verdict
    // does not mean a dead group: an owner that went quiet may still be
    // running everything it started. Whatever is still alive is contained
    // before the unit is let go, and an attempt whose group rides out the
    // containment is left held rather than settled — releasing it would
    // seat a second owner beside the processes of the first.
    const owner = ownerOf(spool);
    if (owner !== null && treeAlive(owner))
    {
        const survivors = await treeContain(owner);
        spool.append("events.jsonl", { event: "run.contained", contained: survivors.length === 0 });
        if (survivors.length > 0)
        {
            console.error(`attempt ${status.attempt} is not being driven (${verdict.reason}) but ${survivors.length} process(es) its launch started survived containment (pid ${survivors.join(", ")}) — it keeps the work unit until they are gone`);
            return "held";
        }
    }
    // Taking the attempt over, not just relabelling it: a runner that was
    // wrongly declared dead, or one that comes back between the check and
    // the write, finds a fence newer than its own and stops rather than
    // overwriting this verdict.
    const fence = nextFence();
    spool.claim(fence);
    const gated = await gateSettled(ctx, spool, status, verdict, fence);
    if (gated !== null)
    {
        return gated.state === "completed" ? "settled" : "gate-failed";
    }
    // What is recorded beside the verdict is how it was reached. Neither an
    // owner that disappeared nor one that went quiet said anything about
    // what its process produced, and settlement refuses both on that
    // ground rather than on the state alone — while an exit the launcher
    // did report keeps its source and its code, and only that record may
    // carry one.
    spool.setStatus({
        state: "exited-unreconciled",
        failure: "unknown",
        detail: verdict.reason,
        exitSource: verdict.exitSource,
        exitCode: verdict.exitSource === "confirmed" ? status.exitCode : undefined,
        fence
    });
    spool.append("events.jsonl", { event: "run.recovered", detail: verdict.reason, exitSource: verdict.exitSource });
    // The verdict is terminal, so whatever this attempt was provisioned with is
    // nobody's any more — including an attempt that died in the middle of its
    // own preparation and never ran at all.
    const plan = spool.readJson<AttemptPlan>("plan.json");
    if (plan !== null)
    {
        releaseWorkdir(plan, spool);
    }
    recordRecovery(ctx, status, verdict.reason);
    return "unreconciled";
}

// An exit a launcher watched happen, over a run that left a result envelope,
// is a result the gate can judge — and only the gate may judge it. Recovery
// used to write `unknown` over exactly this evidence, so an attempt whose
// settlement died after the provider had already produced its result lost a
// validated outcome and had to be run again (#83). Whether the gate accepts it
// is still the gate's answer: a refusal settles the attempt as failed
// validation, which is a terminal verdict of its own and not a recovery.
async function gateSettled(ctx: ProjectContext, spool: Spool, status: AttemptStatus, verdict: DeadVerdict, fence: number): Promise<AttemptResult | null>
{
    const plan = spool.readJson<AttemptPlan>("plan.json");
    if (verdict.exitSource !== "confirmed" || plan === null)
    {
        return null;
    }
    spool.setScope(planScope(plan));
    spool.setStatus({ fence });
    return await settleConfirmedExit(ctx, plan, spool, status.attempt);
}

function recordRecovery(ctx: ProjectContext, status: AttemptStatus, reason: string): void
{
    // The branch on an event is the checkout the change was made from. This
    // command recovers every attempt on the machine, and the checkout it
    // happens to run in is not the one another project's attempt belongs to,
    // so nothing is stamped on an event that is not this project's.
    const owner: CliContext = status.project === ctx.project ? ctx : { ...ctx, projectDir: undefined };
    recordEvent(
        owner,
        makeEvent(status.project, "run.failed", { attempt: status.attempt, failure: "unknown", detail: reason }, { work: status.work, attempt: status.attempt }),
        `${status.work} exited-unreconciled`
    );
}

function cmdPrune(args: string[]): void
{
    const { values } = parseArgs({ args, options: { days: { type: "string" } } });
    const days = values.days === undefined ? readRunnerConfig().retentionDays : Number(values.days);
    if (!Number.isFinite(days) || days <= 0)
    {
        throw new CliError("self attempt prune --days expects a positive number of days");
    }
    const removed = pruneSpools(days, new Date());
    console.log(removed.length === 0 ? `no attempt spool is older than ${days} day(s)` : `deleted ${removed.length} attempt spool(s) older than ${days} day(s)`);
}

function cmdRetention(args: string[]): void
{
    const [value] = parseCommand("attempt", args, {}, 1).positionals;
    if (value === undefined)
    {
        console.log(String(readRunnerConfig().retentionDays));
        return;
    }
    const days = Number(value);
    if (!Number.isFinite(days) || days <= 0)
    {
        throw new CliError("self attempt retention expects a positive number of days");
    }
    writeRunnerConfig({ retentionDays: days });
    console.log(`attempt spools on this machine are kept for ${days} day(s)`);
}

function cmdBreaker(args: string[]): void
{
    const { values, positionals } = parseCommand("attempt", args, { reset: { type: "boolean" } }, 1);
    const provider = positionals[0];
    if (provider === undefined)
    {
        throw new CliError("usage: self attempt breaker <provider> [--reset]");
    }
    if (values.reset === true)
    {
        resetBreaker(provider);
        console.log(`circuit breaker for "${provider}" reset`);
        return;
    }
    const record = readBreaker(provider);
    console.log(`${record.provider}  ${record.state}  ${record.failures} consecutive failure(s)${record.openedAt === undefined ? "" : `  opened ${record.openedAt}`}`);
}
