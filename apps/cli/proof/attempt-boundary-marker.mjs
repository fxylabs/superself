// The attempt boundary marks its own children, and a child that carries the
// mark opens no window. The guard's table of contexts lives in gui-launch.mjs;
// this is the other half of the same claim — that the mark the guard reads is
// actually there in what the runner hands a process it starts, and in the
// env.json it hands an external launcher to start one with.
//
// Both halves are needed. A guard reading a marker nobody sets refuses nothing,
// which is how an agent run holding a pty reached a desktop in the first place.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { childEnv } from "../dist/attempt/run.js";
import { Spool } from "../dist/attempt/spool.js";

const root = mkdtempSync(join(tmpdir(), "self-attempt-marker-"));
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

// Composed exactly as `self attempt run` composes it for its own child and as
// `self attempt register` writes it to env.json, against a spool that is only
// a directory: no state store is touched by asking what the environment is.
const spool = new Spool(join(root, "spool"), { literals: [] });
const env = childEnv(spool, "at-7f3kq", 1, null);

if (env.SUPERSELF_SESSION !== "at-7f3kq")
{
    failures.push("the attempt boundary does not mark its child as an agent session");
}

// Additive and nothing else: every path the child contract already promised is
// still the same path, so a marker added for the GUI guard cannot be the reason
// a spool, a brief or a result envelope moved.
const promised = childEnv(spool, "at-7f3kq", 1, "/resume/from/here");
const paths = {
    SUPERSELF_ATTEMPT_ID: "at-7f3kq",
    SUPERSELF_ATTEMPT_RUN: "1",
    SUPERSELF_ATTEMPT_DIR: spool.dir,
    SUPERSELF_ATTEMPT_BRIEF: join(spool.dir, "brief.md"),
    SUPERSELF_ATTEMPT_OUT: join(spool.dir, "out"),
    SUPERSELF_ATTEMPT_RESULT: join(spool.dir, "result.json"),
    SUPERSELF_ATTEMPT_INBOX: join(spool.dir, "inbox.jsonl"),
    SUPERSELF_ATTEMPT_CHECKPOINTS: join(spool.dir, "checkpoints.jsonl"),
    SUPERSELF_ATTEMPT_TOOLS: join(spool.dir, "tools.jsonl"),
    SUPERSELF_ATTEMPT_EVIDENCE: join(spool.dir, "evidence.json"),
    SUPERSELF_ATTEMPT_RESUME: "/resume/from/here"
};
for (const [name, value] of Object.entries(paths))
{
    if (promised[name] !== value)
    {
        failures.push(`the child contract moved ${name}: ${promised[name]} is not ${value}`);
    }
}
const added = Object.keys(promised).filter((name) => paths[name] === undefined);
if (added.join(",") !== "SUPERSELF_SESSION")
{
    failures.push(`the boundary environment gained more than the marker: ${added.join(", ") || "nothing"}`);
}

// A child claiming a terminal on both ends, which is what a harness that
// allocates a pty gives its process. The launcher it would reach is a stub on
// PATH, so a window nobody asked for is a file on disk here.
const child = join(root, "child.mjs");
writeFileSync(child, [
    `import { launchFile } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../dist/view.js")).href)};`,
    "process.stdin.isTTY = true;",
    "process.stdout.isTTY = true;",
    `process.stdout.write(String(launchFile({ workspaceDir: ${JSON.stringify(root)} }, ${JSON.stringify(target)})));`
].join("\n"));

async function opened(childEnvironment, deadlineMs = 1000)
{
    rmSync(marker, { force: true });
    const outcome = spawnSync(process.execPath, [child], {
        cwd: root,
        encoding: "utf8",
        // A clean environment, so the answer comes from what the boundary hands
        // the child rather than from whatever session is running this proof.
        env: { PATH: join(root, "bin") + delimiter + "/usr/bin:/bin", ...childEnvironment }
    });
    if (outcome.status !== 0)
    {
        failures.push(`the child did not run: ${outcome.stderr?.trim() ?? outcome.error?.message}`);
    }
    // The launch is detached, so its absence is read on a deadline rather than
    // straight after the exit — the same race proof.sh waits out.
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline && !existsSync(marker))
    {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { said: outcome.stdout?.trim(), spawned: existsSync(marker) ? readFileSync(marker, "utf8").trim() : "" };
}

const marked = await opened(env);
if (marked.said !== "false" || marked.spawned !== "")
{
    failures.push(`a child of the attempt boundary reached a desktop: ${marked.said} ${marked.spawned}`);
}

// The control: the same child, the same claimed terminal, the boundary's own
// paths — and no marker. It launches, which is what makes the row above a
// statement about the marker and not about the child being unable to launch
// at all.
const unmarked = { ...env };
delete unmarked.SUPERSELF_SESSION;
delete unmarked.SUPERSELF_ATTEMPT_ID;
// This row waits for a launch that must happen, so its deadline is generous:
// on a loaded machine running sibling suites, a detached stub can take well
// over the second the absence rows above are read on.
const bare = await opened(unmarked, 10000);
if (bare.said !== "true" || !bare.spawned.includes(target))
{
    failures.push(`the control child launched nothing, so the marker proves nothing: ${bare.said} ${bare.spawned}`);
}

rmSync(root, { recursive: true, force: true });

if (failures.length > 0)
{
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log("attempt boundary marker OK");
