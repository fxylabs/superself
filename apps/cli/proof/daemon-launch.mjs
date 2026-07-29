// A launcher that dies in the middle of settling the exit it just reported.
//
// This is the state the supervisor's settle step exists for, and there is no
// honest way to reach it except by killing something: `self attempt exited`
// writes the confirmed exit and then runs the completion gate, and a machine
// that loses power between the two leaves a run whose result is on disk and
// whose report is nowhere. The kill point is read off the spool rather than
// timed — the exit has to be on record before this walks away, or the case
// would be proving a vanished attempt instead.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const [cli, attempt, spoolDir, projectDir, ...flags] = process.argv.slice(2);
const crash = flags.includes("--crash-in-settlement");
// Where the artifact this attempt declares is published. Given, the crash is
// staged after the gate has published and while its declared validation is
// still running; omitted, it is staged the moment the exit is on record.
const afterPublish = flags.find((flag) => flag.startsWith("--after-publish="))?.slice("--after-publish=".length);

const plan = JSON.parse(readFileSync(`${spoolDir}/plan.json`, "utf8"));
const attemptEnv = JSON.parse(readFileSync(`${spoolDir}/env.json`, "utf8"));

function self(args)
{
    const outcome = spawnSync(process.execPath, [cli, ...args], { cwd: projectDir, encoding: "utf8" });
    process.stdout.write(outcome.stdout ?? "");
    process.stderr.write(outcome.stderr ?? "");
    return outcome.status;
}

function status()
{
    try
    {
        return JSON.parse(readFileSync(`${spoolDir}/status.json`, "utf8"));
    }
    catch
    {
        return {};
    }
}

function wait(until, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !until())
    {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return until();
}

const child = spawn(plan.command[0], plan.command.slice(1), {
    cwd: plan.boundary.cwd,
    env: { ...process.env, ...plan.boundary.env, ...attemptEnv },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true
});
child.unref();

if (self(["attempt", "started", attempt, "--pid", String(child.pid)]) !== 0)
{
    process.exit(1);
}
self(["attempt", "heartbeat", attempt]);

// The beat is also what holds this process open: the payload was unref'd so
// its handle keeps nothing alive, and a launcher whose event loop emptied
// would walk away before the exit it exists to report.
const beat = setInterval(() => self(["attempt", "heartbeat", attempt]), 200);

child.on("close", (code, signal) =>
{
    clearInterval(beat);
    if (!crash)
    {
        process.exitCode = self(["attempt", "exited", attempt, "--code", String(signal === null ? code ?? 1 : 1)]);
        return;
    }
    const reporter = spawn(process.execPath, [cli, "attempt", "exited", attempt, "--code", "0"], {
        cwd: projectDir,
        stdio: ["ignore", "ignore", "ignore"],
        detached: true
    });
    // The exit is durable the moment the status carries it. Everything after
    // that point — containment, the gate, the report — is the settlement this
    // launcher is about to stop finishing.
    const reached = () => status().exitSource === "confirmed" && (afterPublish === undefined || existsSync(afterPublish));
    if (!wait(reached, 30_000))
    {
        process.stderr.write("the settlement never reached the point this launcher crashes at\n");
        process.exitCode = 1;
        return;
    }
    try
    {
        process.kill(-reporter.pid, "SIGKILL");
    }
    catch
    {
        reporter.kill("SIGKILL");
    }
    process.exitCode = 0;
});
