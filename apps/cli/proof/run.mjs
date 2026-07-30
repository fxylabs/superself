// proof/run.mjs — the sweep orchestrator behind proof.sh.
//
// Every suite in suites.json builds a machine root or repository of its own
// and reads nothing of another's state, so the full sweep runs them together
// and the wall clock pays for the slowest one, not for the sum. Each suite's
// output is kept apart and replayed in order once the sweep settles. With
// names given, only those suites run, serially and streaming — the dev loop's
// partial run.
//
// A suite that fails takes its siblings down with it: each suite leads its own
// process group, the group is signalled so the suites' own teardown traps run,
// and a group that ignores the signal is killed. Letting the siblings run on
// would spend minutes proving things nobody will read past the failure.
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkManifest, loadManifest } from "./manifest.mjs";

const proofDir = import.meta.dirname;
const manifest = loadManifest();

const violations = checkManifest(manifest);
if (violations.length > 0)
{
    console.error(violations.join("\n"));
    console.error("proof FAILED: the suite map does not match what the suites execute");
    process.exit(1);
}

function command(entry)
{
    const path = join(proofDir, entry);
    return entry.endsWith(".mjs") ? [process.execPath, [path]] : ["bash", [path]];
}

const names = process.argv.slice(2).filter((argument) => argument !== "--");
for (const name of names)
{
    if (manifest.suites[name] === undefined)
    {
        console.error(`"${name}" is not a proof suite. The suites: ${Object.keys(manifest.suites).join(", ")}`);
        process.exit(1);
    }
}

if (names.length > 0)
{
    for (const name of names)
    {
        const [executable, arguments_] = command(manifest.suites[name].entry);
        const outcome = spawn(executable, arguments_, { stdio: "inherit" });
        const code = await new Promise((resolve) => outcome.on("close", resolve));
        if (code !== 0)
        {
            console.error(`proof FAILED: the ${name} suite failed`);
            process.exit(1);
        }
    }
    process.exit(0);
}

const logDir = mkdtempSync(join(tmpdir(), "self-proof-logs-"));
const running = new Map();
let failed = null;

function takeDownSiblings()
{
    for (const sibling of running.values())
    {
        try { process.kill(-sibling.pid, "SIGTERM"); } catch {}
    }
    setTimeout(() =>
    {
        for (const sibling of running.values())
        {
            try { process.kill(-sibling.pid, "SIGKILL"); } catch {}
        }
    }, 8000).unref();
}

// The person interrupting the sweep deserves the same containment a failing
// suite gets: without this, Ctrl-C stops the orchestrator and orphans every
// detached suite group it started.
for (const signal of ["SIGINT", "SIGTERM"])
{
    process.on(signal, () =>
    {
        failed ??= "(interrupted)";
        takeDownSiblings();
    });
}

const settled = Object.entries(manifest.suites).map(([name, suite]) => new Promise((resolve) =>
{
    const [executable, arguments_] = command(suite.entry);
    const log = openSync(join(logDir, `${name}.log`), "w");
    const child = spawn(executable, arguments_, { detached: true, stdio: ["ignore", log, log] });
    running.set(name, child);
    child.on("close", (code, signal) =>
    {
        running.delete(name);
        // Any exit that is not a clean zero fails the sweep — including a
        // suite killed by a signal nobody here sent. Once one failure is
        // recorded, the siblings this orchestrator signals stay attributed
        // to that first failure rather than becoming failures of their own.
        if ((code !== 0 || signal !== null) && failed === null)
        {
            failed = name;
            takeDownSiblings();
        }
        resolve();
    });
}));
await Promise.all(settled);

for (const name of Object.keys(manifest.suites))
{
    process.stdout.write(readFileSync(join(logDir, `${name}.log`), "utf8"));
}
rmSync(logDir, { recursive: true, force: true });

if (failed !== null)
{
    console.error(failed === "(interrupted)" ? "proof FAILED: the sweep was interrupted" : `proof FAILED: the ${failed} suite failed`);
    process.exit(1);
}
console.log("proof OK");
