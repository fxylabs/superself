import { parseCommand } from "../args.js";
import { listHeads } from "../spec/store.js";
import { ProjectContext, requireProject } from "../paths.js";
import { setMachineMode } from "../pipeline.js";
import { dim, green, red, styled, yellow } from "../style.js";
import { CliError } from "../types.js";
import { Circuit, circuitOf } from "./circuits.js";
import { DEFAULT_INTERVAL_MS, line, runLoop, startDetached, stopDaemon, tickOnce } from "./loop.js";
import { liveDaemon, readDaemon, readTick } from "./state.js";
import { TickSummary } from "./tick.js";
import { providerOf } from "./wake.js";

const USAGE = "usage: self daemon start [--interval ms] [--foreground] | stop | status [--json] | tick [--json] | circuits [--json]";

export async function runDaemonCommand(rest: string[]): Promise<void>
{
    switch (rest[0])
    {
        case "start": await cmdStart(rest.slice(1)); return;
        case "stop": await cmdStop(rest.slice(1)); return;
        case "status": cmdStatus(rest.slice(1)); return;
        case "tick": await cmdTick(rest.slice(1)); return;
        case "circuits": cmdCircuits(rest.slice(1)); return;
        default: throw new CliError(USAGE);
    }
}

// One supervisor per machine, and one project per supervisor: settlement
// records into a project's own log from that project's own checkout, and this
// process holds one of them.
async function cmdStart(args: string[]): Promise<void>
{
    const { values } = parseCommand("daemon", args, { interval: { type: "string" }, foreground: { type: "boolean" } }, 0);
    const ctx = requireProject(process.cwd());
    const intervalMs = interval(values.interval);
    if (values.foreground === true)
    {
        await runLoop(ctx, intervalMs);
        return;
    }
    const record = startDetached(ctx, intervalMs);
    console.log(`self daemon ${record.pid} supervising ${record.project} every ${record.intervalMs}ms — \`self daemon status\` reports what it has done`);
}

function interval(value: string | undefined): number
{
    if (value === undefined)
    {
        return DEFAULT_INTERVAL_MS;
    }
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0)
    {
        throw new CliError("self daemon start --interval expects a positive number of milliseconds");
    }
    return ms;
}

async function cmdStop(args: string[]): Promise<void>
{
    parseCommand("daemon", args, {}, 0);
    console.log(await stopDaemon());
}

function cmdStatus(args: string[]): void
{
    const { values } = parseCommand("daemon", args, { json: { type: "boolean" } }, 0);
    const record = readDaemon();
    const live = liveDaemon();
    const tick = readTick();
    if (values.json === true)
    {
        console.log(JSON.stringify({ running: live !== null, daemon: record, tick }, null, 2));
        return;
    }
    if (live === null)
    {
        console.log(record === null
            ? "no self daemon is running on this machine — start one with `self daemon start`"
            : `no self daemon is running — process ${record.pid} left a record behind and \`self daemon stop\` clears it`);
    }
    else
    {
        console.log(`running   process ${live.pid} supervising ${live.project}, every ${live.intervalMs}ms`);
        console.log(`uptime    ${uptime(live.started)} (since ${live.started})`);
    }
    console.log(tick === null ? "ticks     none yet" : `ticks     ${tick.ticks}, last ${tick.at}`);
    if (tick !== null)
    {
        console.log(`last      live ${tick.live}  settled ${tick.settled}  unreconciled ${tick.unreconciled}  held ${tick.held}  released ${tick.released}  woken ${tick.woken}  deferred ${tick.deferred}`);
    }
    if (tick?.failed !== undefined)
    {
        console.log(`failed    ${tick.failed}`);
    }
}

function uptime(started: string): string
{
    const seconds = Math.max(0, Math.round((Date.now() - new Date(started).getTime()) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

// The testable unit. One iteration in this process, against exactly the state
// the loop would have seen, so everything the supervisor does can be proven
// without a daemon in the way.
async function cmdTick(args: string[]): Promise<void>
{
    const { values } = parseCommand("daemon", args, { json: { type: "boolean" } }, 0);
    if (values.json === true)
    {
        setMachineMode(true);
    }
    const ctx = requireProject(process.cwd());
    const summary = await tickOnce(ctx);
    // On one line, and last. A tick settles through the completion gate, and
    // the gate says what it published on stdout the same way it does when a
    // person runs it — a caller reading this as JSON takes the final line
    // rather than the whole stream.
    console.log(values.json === true ? JSON.stringify(summary) : tickReport(summary));
}

function tickReport(summary: TickSummary): string
{
    const lines = [line(summary)];
    for (const attempt of summary.attempts)
    {
        lines.push(`  ${attempt.attempt}  ${attempt.work}  ${attempt.disposition}${attempt.detail === undefined ? "" : `  ${dim(attempt.detail)}`}`);
    }
    for (const wake of summary.wakes)
    {
        lines.push(`  ${wake.workSpec}  ${wake.work}  generation ${wake.generation}  ${wake.outcome}`);
    }
    return lines.join("\n");
}

function cmdCircuits(args: string[]): void
{
    const { values } = parseCommand("daemon", args, { json: { type: "boolean" } }, 0);
    const ctx = requireProject(process.cwd());
    const now = new Date();
    const circuits = providers(ctx).map((provider) => circuitOf(provider, now));
    if (values.json === true)
    {
        console.log(JSON.stringify(circuits, null, 2));
        return;
    }
    if (circuits.length === 0)
    {
        console.log("no work spec in this project names a provider — `self spec apply` is what puts one on record");
        return;
    }
    for (const circuit of circuits)
    {
        console.log(circuitLine(circuit));
    }
}

function circuitLine(circuit: Circuit): string
{
    const reset = circuit.retryAt === undefined ? "" : `  retry after ${circuit.retryAt}`;
    const opened = circuit.openedAt === undefined ? "" : `  opened ${circuit.openedAt}`;
    const text = `${circuit.provider}  ${circuit.verdict}  ${circuit.failures} consecutive failure(s)${opened}${reset}`;
    return styled ? colour(circuit)(text) : text;
}

function colour(circuit: Circuit): (text: string) => string
{
    if (circuit.verdict === "open")
    {
        return red;
    }
    return circuit.verdict === "half-open" || circuit.retryAt !== undefined ? yellow : green;
}

// The providers this project's desired state names, which is the set a
// supervisor can fan out to at all. A breaker nothing here names is another
// project's, and is listed where that project's daemon runs.
function providers(ctx: ProjectContext): string[]
{
    const named = listHeads(ctx.storeDir, ctx.project)
        .map((head) => providerOf(ctx, head))
        .filter((provider): provider is string => provider !== null);
    return [...new Set(named)].sort();
}
