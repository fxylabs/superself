// A launcher the runner did not write. It starts a registered attempt's
// command in a process group of its own, tells the attempt lifecycle which
// process that is, heartbeats while it runs, and reports the exit it watched.
//
// This is the whole of what `self attempt register` + started/heartbeat/exited
// asks of an external supervisor, so the proof exercises the contract rather
// than a runner-shaped stub of it.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [cli, attempt, spoolDir, projectDir, ...flags] = process.argv.slice(2);
const abandon = flags.includes("--abandon");
const pidFile = flags.find((flag) => flag.startsWith("--pidfile="))?.slice("--pidfile=".length);

const plan = JSON.parse(readFileSync(`${spoolDir}/plan.json`, "utf8"));
const attemptEnv = JSON.parse(readFileSync(`${spoolDir}/env.json`, "utf8"));

function self(args)
{
    const outcome = spawnSync(process.execPath, [cli, ...args], { cwd: projectDir, encoding: "utf8" });
    process.stdout.write(outcome.stdout ?? "");
    process.stderr.write(outcome.stderr ?? "");
    return outcome.status;
}

// Detached, so the payload leads a process group of its own: that is what
// makes the group id an ownership the kernel answers for, rather than the
// launcher's own group which every unrelated sibling shares.
const child = spawn(plan.command[0], plan.command.slice(1), {
    cwd: plan.boundary.cwd,
    env: { ...process.env, ...plan.boundary.env, ...attemptEnv },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true
});
child.unref();

if (pidFile !== undefined)
{
    writeFileSync(pidFile, String(child.pid));
}

if (self(["attempt", "started", attempt, "--pid", String(child.pid)]) !== 0)
{
    process.exit(1);
}

// One beat before anything else, so an abandoned launch still leaves the mark
// a stale heartbeat is measured against.
self(["attempt", "heartbeat", attempt]);

if (abandon)
{
    // The launcher walks away and the process it started keeps running: what
    // recovery has to classify without any exit ever being reported.
    process.exit(0);
}

const beat = setInterval(() => self(["attempt", "heartbeat", attempt]), 200);
child.on("close", (code, signal) =>
{
    clearInterval(beat);
    process.exitCode = self(["attempt", "exited", attempt, "--code", String(signal === null ? code ?? 1 : 1)]);
});
