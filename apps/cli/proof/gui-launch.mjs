// The guard that decides whether a file reaches the OS default app, driven
// directly so every context it must refuse is named on its own. The end-to-end
// half lives in proof.sh, where `artifact open` is run with piped stdio and the
// desktop is shown to stay untouched; this half is the table of contexts, and a
// CLI proof cannot claim a terminal it does not have.
//
// The launcher is found on PATH, so a stub named `open`, `xdg-open` and
// `explorer` ahead of the real ones catches the spawn and writes down that it
// happened, on every platform this CLI runs on.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { launchFile } from "../dist/view.js";

const root = mkdtempSync(join(tmpdir(), "self-gui-launch-"));
const marker = join(root, "launched.log");
const target = join(root, "artifact.txt");
const failures = [];

writeFileSync(target, "hi");
mkdirSync(join(root, "bin"));
for (const name of ["open", "xdg-open", "explorer"])
{
    const stub = join(root, "bin", name);
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(marker)}\n`);
    chmodSync(stub, 0o755);
}
process.env.PATH = join(root, "bin") + delimiter + (process.env.PATH ?? "");

// The launch is detached and never awaited, so the stub writes after the call
// returns. Polling to a deadline is what separates "nothing was spawned" from
// "the spawn had not landed yet" — a bare read after the call would report the
// first as the second and pass a broken guard.
//
// A launch that happens exits this wait the moment the marker lands, so the
// case that expects one can afford to wait long. A refusal has nothing to wait
// for and pays the deadline in full every time, so it is read on the short one
// proof.sh uses for the same detached-spawn race.
const LAUNCH_MS = 5000;
const ABSENCE_MS = 1000;

async function launched(deadlineMs)
{
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline)
    {
        if (existsSync(marker))
        {
            return readFileSync(marker, "utf8");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return "";
}

async function opens(what, context)
{
    rmSync(marker, { force: true });
    if (apply(context) !== true)
    {
        failures.push(`${what}: the guard refused a launch a person asked for`);
        return;
    }
    const spawned = await launched(LAUNCH_MS);
    if (!spawned.includes(target))
    {
        failures.push(`${what}: said it launched but no launcher ran on the file`);
    }
}

async function suppresses(what, context)
{
    rmSync(marker, { force: true });
    if (apply(context) !== false)
    {
        failures.push(`${what}: the guard reported a launch it must not make`);
    }
    const spawned = await launched(ABSENCE_MS);
    if (spawned !== "")
    {
        failures.push(`${what}: a launcher ran anyway — ${spawned.trim()}`);
    }
}

function apply({ stdin, stdout, ci, session, attempt })
{
    process.stdin.isTTY = stdin;
    process.stdout.isTTY = stdout;
    set("CI", ci);
    set("SUPERSELF_SESSION", session);
    set("SUPERSELF_ATTEMPT_ID", attempt);
    return launchFile({ workspaceDir: root }, target);
}

function set(name, value)
{
    if (value === undefined)
    {
        delete process.env[name];
        return;
    }
    process.env[name] = value;
}

// Every context starts from a person at a terminal and changes one thing, and
// every marker is written on each pass rather than left over: this file is
// itself run from an agent session often enough that inheriting one would
// quietly turn the interactive row into a second suppression case.
const terminal = { stdin: true, stdout: true, ci: undefined, session: undefined, attempt: undefined };

await opens("a person at a terminal", terminal);
await suppresses("piped stdout", { ...terminal, stdout: false });
await suppresses("piped stdin", { ...terminal, stdin: false });
await suppresses("neither end a terminal", { ...terminal, stdin: false, stdout: false });
await suppresses("a CI runner holding a pty", { ...terminal, ci: "true" });
await suppresses("an agent session holding a pty", { ...terminal, session: "attempt-42" });
// What `self attempt run` hands its child, and what the runner writes into
// env.json for an external launcher to hand it: the boundary's own marker, on
// a pty at both ends, with nothing else to give the run away.
await suppresses("an attempt run holding a pty", { ...terminal, session: "at-7f3kq" });
await suppresses("an attempt run whose launcher kept only the id", { ...terminal, attempt: "at-7f3kq" });

rmSync(root, { recursive: true, force: true });

if (failures.length > 0)
{
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log("gui launch guard OK");
