import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { bootId } from "./boundary.js";
import { queueDirective } from "./directive.js";
import { readPlan } from "./plan.js";
import { PreflightReceipt } from "./preflight.js";
import { readBreaker, resetBreaker } from "./retry.js";
import { AttemptStatus, deadReason, listSpools, openSpool, pruneSpools, readRunnerConfig, Spool, spoolBytes, writeRunnerConfig } from "./spool.js";
import { nextFence, runAttempt, settleAttempt } from "./run.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { CliContext, ProjectContext, requireProject } from "../paths.js";
import { dim, green, red, styled, yellow } from "../style.js";
import { CliError } from "../types.js";

export async function runAttemptCommand(rest: string[]): Promise<void>
{
    switch (rest[0])
    {
        case "run": await cmdRun(rest.slice(1)); return;
        case "list": cmdList(rest.slice(1)); return;
        case "show": cmdShow(rest[1]); return;
        case "directive": cmdDirective(rest.slice(1)); return;
        case "cancel": cmdCancel(rest[1]); return;
        case "settle": cmdSettle(rest[1]); return;
        case "recover": cmdRecover(); return;
        case "prune": cmdPrune(rest.slice(1)); return;
        case "retention": cmdRetention(rest[1]); return;
        case "breaker": cmdBreaker(rest.slice(1)); return;
        default: throw new CliError("usage: self attempt run <plan.json> | list | show <id> | directive <id> \"<text>\" | cancel <id> | settle <id> | recover | prune [--days N] | retention [<days>] | breaker [<provider>] [--reset]");
    }
}

async function cmdRun(args: string[]): Promise<void>
{
    const file = args[0];
    if (file === undefined || file.startsWith("-"))
    {
        throw new CliError("usage: self attempt run <plan.json>");
    }
    const ctx = requireProject(process.cwd());
    const plan = readPlan(file);
    const result = await runAttempt(ctx, plan, { now: new Date() });
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

function cmdShow(id: string | undefined): void
{
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
    console.log(`runs       ${status.runs} of this attempt, fence ${status.fence}`);
    console.log(`node       ${status.nodeId} boot ${status.bootId}${status.pid === undefined ? "" : ` pid ${status.pid}`}`);
    console.log(`spool      ${spool.dir} (${spoolBytes(spool.dir)} bytes)`);
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
    const [id, text] = args;
    if (id === undefined || text === undefined || text.trim() === "")
    {
        throw new CliError('usage: self attempt directive <attempt-id> "<text>"');
    }
    const directive = queueDirective(openSpool(id), "followup", text);
    console.log(`follow-up ${directive.id} queued for ${id} — it is delivered from the spool, not from a terminal`);
}

function cmdCancel(id: string | undefined): void
{
    if (id === undefined)
    {
        throw new CliError("usage: self attempt cancel <attempt-id>");
    }
    const directive = queueDirective(openSpool(id), "cancel", "cancel requested");
    console.log(`cancel ${directive.id} queued for ${id}`);
}

function cmdSettle(id: string | undefined): void
{
    if (id === undefined)
    {
        throw new CliError("usage: self attempt settle <attempt-id>");
    }
    settleAttempt(requireProject(process.cwd()), openSpool(id));
}

// A crash or a restart leaves a spool that still says `running`. Nothing here
// may promote such an attempt to success: the only honest verdict is that it
// exited without being reconciled, and that is what the work record shows.
function cmdRecover(): void
{
    const ctx = requireProject(process.cwd());
    const boot = bootId();
    const now = Date.now();
    let recovered = 0;
    for (const spool of listSpools())
    {
        const status = spool.status();
        if (status === null)
        {
            continue;
        }
        const reason = deadReason(spool, status, boot, now);
        if (reason === null)
        {
            continue;
        }
        // Taking the attempt over, not just relabelling it: a runner that was
        // wrongly declared dead, or one that comes back between the check and
        // the write, finds a fence newer than its own and stops rather than
        // overwriting this verdict.
        spool.setStatus({ state: "exited-unreconciled", failure: "unknown", detail: reason, fence: nextFence() });
        spool.append("events.jsonl", { event: "run.recovered", detail: reason });
        recordRecovery(ctx, status, reason);
        recovered++;
    }
    console.log(recovered === 0 ? "no attempt needed recovery" : `recovered ${recovered} attempt(s) as exited-unreconciled`);
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

function cmdRetention(value: string | undefined): void
{
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
    const { values, positionals } = parseArgs({ args, options: { reset: { type: "boolean" } }, allowPositionals: true });
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
