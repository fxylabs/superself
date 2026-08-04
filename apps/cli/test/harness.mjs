// Shared setup for the integration tests: a throwaway machine whose HOME,
// config and git identity live under one temp root, so a test can never reach
// the real workspace. Mirrors what proof/lib.sh established for the shell
// suites the fast tier replaces.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { foldProject } from "../dist/fold.js";
import { useTypedAnswer } from "../dist/human.js";
import { ulid } from "../dist/ids.js";
import { runCli } from "../dist/main.js";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));

export function machine()
{
    const root = mkdtempSync(join(tmpdir(), "self-test-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = test machine\n\temail = test@superself.local\n[init]\n\tdefaultBranch = main\n");
    const env = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        GIT_CONFIG_SYSTEM: "/dev/null"
    };
    return { root, env };
}

// Runs the built CLI and reports what a caller can assert on: exit code and
// the merged output, because a refusal's text is part of the contract.
export function selfIn(box, cwd, args)
{
    try
    {
        return { code: 0, out: execFileSync(process.execPath, [bin, ...args], { cwd, env: box.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    }
    catch (error)
    {
        return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
}

// The same command line a person types, driven where a keyboard can be stood
// in for. Destroying a record needs someone at a terminal (#173), so the only
// place the approved path can run is in-process: the command line, the
// resolution, the disclosure and the write all execute, and the typed answer
// is the one thing supplied. Anything spawned as a child still faces the real
// terminal check, which is why the refusals are asserted through selfIn.
export async function approvedIn(box, cwd, args, answer)
{
    const env = { ...process.env };
    const cwdWas = process.cwd();
    const inWas = process.stdin.isTTY;
    const outWas = process.stdout.isTTY;
    Object.assign(process.env, box.env);
    process.chdir(cwd);
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const typedWas = useTypedAnswer(() => answer);
    process.exitCode = 0;
    // Same shape selfIn reports, because a refusal's text is part of the
    // contract. The disclosure and the command's own result both land on
    // stdout, so they are kept apart: `printed` is what the command said,
    // `out` is everything the person saw.
    let out = "";
    let printed = "";
    const write = process.stdout.write.bind(process.stdout);
    const log = console.log;
    const err = console.error;
    process.stdout.write = (chunk) => { out += chunk; return true; };
    console.log = (...parts) => { out += `${parts.join(" ")}\n`; printed += `${parts.join(" ")}\n`; };
    console.error = (...parts) => { out += `${parts.join(" ")}\n`; printed += `${parts.join(" ")}\n`; };
    try
    {
        await runCli(args);
        return { code: process.exitCode ?? 0, out, printed };
    }
    finally
    {
        process.stdout.write = write;
        console.log = log;
        console.error = err;
        useTypedAnswer(typedWas);
        process.stdin.isTTY = inWas;
        process.stdout.isTTY = outWas;
        process.chdir(cwdWas);
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, env);
        process.exitCode = 0;
    }
}

// Destroying a record needs a person at a terminal (#173), and a test has no
// terminal. Where a test needs a destroyed record rather than the act of
// destroying one, this writes the event the verb would have written and
// refolds — a fixture, not a way past the gate. The gate's own behaviour is
// asserted in retirement-gate.test.mjs, and the events the approved path
// produces are asserted there in-process.
export function retireFixture(box, ws, project, type, payload, refs)
{
    const event = {
        id: ulid(),
        ts: new Date().toISOString(),
        type,
        origin: { actor: "agent", confirmed: true },
        project,
        payload,
        ...(refs === undefined ? {} : { refs })
    };
    const dir = join(ws, ".superself", "projects", project);
    appendFileSync(join(dir, "log.jsonl"), JSON.stringify(event) + "\n");
    foldProject(join(ws, ".superself"), project);
    return event.id;
}

export function git(box, cwd, args)
{
    execFileSync("git", args, { cwd, env: box.env, stdio: "ignore" });
}

// The floor state: a workspace at <root>/ws holding one registered project at
// <root>/ws/demo. Returns the paths a test drives.
export function demoWorkspace(box)
{
    const ws = join(box.root, "ws");
    const demo = join(ws, "demo");
    mkdirSync(demo, { recursive: true });
    must(box, ws, ["init"]);
    git(box, demo, ["init", "-q", "-b", "main"]);
    must(box, demo, ["project", "add", "--name", "demo", "--desc", "fast tier project"]);
    return { ws, demo };
}

export function must(box, cwd, args)
{
    const result = selfIn(box, cwd, args);
    if (result.code !== 0)
    {
        throw new Error(`self ${args.join(" ")} failed:\n${result.out}`);
    }
    return result;
}

// Event ids arrive inside [brackets] on the confirmation line; a work id is
// printed on its own line after it.
export function idIn(text)
{
    const match = text.match(/\[([^\]]+)\]/);
    if (match === null)
    {
        throw new Error(`no id in: ${text}`);
    }
    return match[1];
}

export function workIdIn(text)
{
    const match = text.match(/\bw-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no work id in: ${text}`);
    }
    return match[0];
}
