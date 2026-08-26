// Shared setup for the integration tests: a throwaway machine whose HOME,
// config and git identity live under one temp root, so a test can never reach
// the real workspace. Mirrors what proof/lib.sh established for the shell
// suites the fast tier replaces.
import { AsyncLocalStorage } from "node:async_hooks";
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
        GIT_CONFIG_SYSTEM: "/dev/null",
        // A session identity is read from the environment (#230), so the real
        // one running this suite would otherwise leak in and make a scratch
        // machine behave differently here than on the runner. Blank is what
        // the resolver reads as "no session", and a test opts out by naming
        // its own.
        SUPERSELF_SESSION_PID: "",
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_PID: ""
    };
    // Deleted rather than blanked: `human.ts` treats `SUPERSELF_SESSION`
    // existing at all as the mark of an agent's process, so an empty string
    // here would make every scratch machine one.
    delete env.SUPERSELF_SESSION;
    return { root, env };
}

// ── the drivers ──────────────────────────────────────────────────────────
//
// Two of them, reporting the same thing: exit code and merged output, because
// a refusal's text is part of the contract.
//
// `selfIn` and `must` run the command in this process, which is what nearly
// every case wants: the suite used to spawn `bin/self.mjs` once per case, and
// on macOS every one of those execs went through the OS policy check — 2,264
// of them, at seconds each, for a suite that spent 6% of its wall clock
// actually running anything (#371).
//
// `spawnIn` and `mustSpawn` start the real binary as a child. A handful of
// cells need that and say so by name: the terminal check, the styled-at-load
// files, the exit-status conversion, the golden fixture. #371's 4-3 table is
// the list and the reason for each.
//
// `extra` overrides environment for this call alone. Two sessions against one
// workspace is a real case the CLI answers differently (#230), and the only
// thing that separates them is what the environment says the session is.

export async function selfIn(box, cwd, args, extra = {})
{
    return drive(box, cwd, args, { extra });
}

export function spawnIn(box, cwd, args, extra = {})
{
    const env = { ...box.env, ...extra };
    try
    {
        return { code: 0, out: execFileSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    }
    catch (error)
    {
        return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
}

export function mustSpawn(box, cwd, args, extra = {})
{
    return refuseFailure(spawnIn(box, cwd, args, extra), args);
}

// The command running here rather than in a child of its own. What it must
// reproduce is not "roughly the same" but the child's exact observation, so
// each of the three things `execFileSync` was given — cwd, a complete `env`,
// and non-terminal stdio — is set here and restored afterwards.
//
// `options` is `{ extra, tty, answer }`. `tty` is false unless a caller asks
// for it: the child ran with `stdio: ["ignore", "pipe", "pipe"]` and therefore
// never had a terminal, while this process may well have one, and three test
// files set `isTTY` at their top level on purpose.
export async function drive(box, cwd, args, options = {})
{
    const restore = enterInvocation(box, cwd, args, options);
    const sink = captureOutput();
    try
    {
        return await runCaptured(args, sink);
    }
    finally
    {
        sink.restore();
        restore();
    }
}

// One command at a time. The driver replaces `process.env`, the working
// directory, `isTTY` and the console for the length of a call, so two calls
// overlapping is not a slow test — it is two commands sharing one set of
// globals. It is also exactly the shape a forgotten `await` takes: the call
// that was not waited for is still running when the next one starts.
let driving = null;

function enterInvocation(box, cwd, args, options)
{
    refuseUndrivable(args);
    // `enterCwd` is the one step that can refuse — a directory that is not
    // there — so it goes first, while nothing has been changed to undo.
    // `driving` is claimed only once every step has succeeded, which is still
    // before any `await` and therefore still before another call could start.
    const undo = [enterCwd(cwd), replaceEnv({ ...box.env, ...options.extra }), enterTty(options.tty === true), enterExit()];
    // Always stubbed, including where the caller named no answer. The real
    // reader is a blocking read of fd 0, and a command that reaches it with
    // nobody typing stops the whole file with no output to say why.
    const typedWas = useTypedAnswer(() => options.answer ?? "");
    driving = args.join(" ");
    return () =>
    {
        driving = null;
        useTypedAnswer(typedWas);
        undo.reverse().forEach((step) => step());
    };
}

// Both ways this driver cannot do its job, each with the sentence that names
// the fix. A worker-thread runner has no `chdir` at all, and `node --test`
// could be asked for one by a future flag; an overlap is a call somewhere that
// was not awaited.
function refuseUndrivable(args)
{
    if (typeof process.chdir !== "function")
    {
        throw new Error("the in-process driver needs process.chdir, which a worker thread does not have — run the suite with one process per test file");
    }
    if (driving !== null)
    {
        throw new Error(`a self call was not awaited: \`self ${driving}\` is still running and \`self ${args.join(" ")}\` started on top of it`);
    }
}

// A child was handed a complete environment, so the driver replaces rather than
// adds: `machine()` deleting `SUPERSELF_SESSION` has to reach the command, or a
// suite run from inside an agent session takes a different path here than on
// the runner, where that variable does not exist.
function replaceEnv(next)
{
    const was = { ...process.env };
    Object.keys(process.env).forEach((key) => delete process.env[key]);
    Object.assign(process.env, next);
    return () =>
    {
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, was);
    };
}

function enterCwd(cwd)
{
    const was = process.cwd();
    process.chdir(cwd);
    return () => process.chdir(was);
}

function enterTty(on)
{
    const inWas = process.stdin.isTTY;
    const outWas = process.stdout.isTTY;
    process.stdin.isTTY = on;
    process.stdout.isTTY = on;
    return () =>
    {
        process.stdin.isTTY = inWas;
        process.stdout.isTTY = outWas;
    };
}

// `runCli` sets the exit code and never puts it back, which in a child was the
// process ending. Here it would fail the test file that ran the command.
function enterExit()
{
    const was = process.exitCode;
    process.exitCode = 0;
    return () => { process.exitCode = was; };
}

// Set for the length of a command and for everything that command's own
// asynchrony leads to, and for nothing else. This process is also the test
// runner, and the runner reports itself on the same stdout: its records are
// buffered and flush whenever the loop turns, which inside a driven command
// means during one. Redirecting stdout wholesale ate them — the report of a
// case went into the string a case was asserting on. Whose write it is has to
// be asked per write, and the async context is what answers it.
const commandOutput = new AsyncLocalStorage();

// The four places a command can speak. `structure.mjs` forbids `console.log`
// and `process.stdout.write` outside the render gate and the interaction
// prompt, so no fifth one can appear without that check failing first;
// `process.stderr.write` is not that rule's subject and three modules use it
// for a warning, which a child's piped stderr collected.
function captureOutput()
{
    const write = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    const log = console.log;
    const err = console.error;
    const sink = { out: "", printed: "" };
    const mine = () => commandOutput.getStore() !== undefined;
    process.stdout.write = (chunk, ...rest) => (mine() ? wrote(sink, chunk) : write(chunk, ...rest));
    process.stderr.write = (chunk, ...rest) => (mine() ? wrote(sink, chunk) : errWrite(chunk, ...rest));
    console.log = (...parts) => (mine() ? said(sink, parts) : log(...parts));
    console.error = (...parts) => (mine() ? said(sink, parts) : err(...parts));
    sink.restore = () =>
    {
        process.stdout.write = write;
        process.stderr.write = errWrite;
        console.log = log;
        console.error = err;
    };
    return sink;
}

function wrote(sink, chunk)
{
    sink.out += chunk;
    return true;
}

function said(sink, parts)
{
    sink.out += `${parts.join(" ")}\n`;
    sink.printed += `${parts.join(" ")}\n`;
}

// The disclosure and the command's own result both land on stdout, so they are
// kept apart: `printed` is what the command said, `out` is everything the
// person saw. An error `runCli` re-throws is one it had no sentence for — node
// printed the stack and exited 1 for the child, and that is the observation
// reproduced here rather than a thrown exception a caller would have to catch.
async function runCaptured(args, sink)
{
    try
    {
        await commandOutput.run(sink, () => runCli(args));
        return { code: process.exitCode ?? 0, out: sink.out, printed: sink.printed };
    }
    catch (error)
    {
        return { code: 1, out: `${sink.out}${error?.stack ?? error}\n`, printed: sink.printed };
    }
}

// The same command line a person types, driven where a keyboard can be stood
// in for. Destroying a record needs someone at a terminal (#173), so the only
// place the approved path can run is in-process: the command line, the
// resolution, the disclosure and the write all execute, and the typed answer
// is the one thing supplied. Anything spawned as a child still faces the real
// terminal check, which is why the refusals are asserted through selfIn.
// `extra` is the environment for this call alone, exactly as `selfIn` takes it:
// the gate reads a session marker as well as the terminal, and a cell about
// what a runner's process is refused has to name that marker rather than leave
// one lying in the test process's own environment.
export async function approvedIn(box, cwd, args, answer, extra = {})
{
    return drive(box, cwd, args, { tty: true, answer, extra });
}

// Destroying a record needs a person at a terminal (#173), and a test has no
// terminal. Where a test needs a destroyed record rather than the act of
// destroying one, this writes the event the verb would have written and
// refolds — a fixture, not a way past the gate. The gate's own behaviour is
// asserted in retirement-gate.test.mjs, and the events the approved path
// produces are asserted there in-process.
export function retireFixture(box, ws, project, type, payload, refs)
{
    return logFixture(ws, project, {
        id: ulid(),
        ts: new Date().toISOString(),
        type,
        origin: { actor: "agent", confirmed: true },
        project,
        payload,
        ...(refs === undefined ? {} : { refs })
    });
}

// One already-formed event appended and folded in, the way the pipeline would
// have written it. Where a test needs the id itself to be the subject — two
// records minted in the same millisecond, so their ids share a prefix — it
// mints the event and hands it over rather than taking whatever `ulid()` gave.
export function logFixture(ws, project, event)
{
    appendFileSync(join(ws, ".superself", "projects", project, "log.jsonl"), JSON.stringify(event) + "\n");
    foldProject(join(ws, ".superself"), project);
    return event.id;
}

export function git(box, cwd, args)
{
    execFileSync("git", args, { cwd, env: box.env, stdio: "ignore" });
}

// The floor state: a workspace at <root>/ws holding one registered project at
// <root>/ws/demo. Returns the paths a test drives.
export async function demoWorkspace(box)
{
    const ws = join(box.root, "ws");
    const demo = join(ws, "demo");
    mkdirSync(demo, { recursive: true });
    await must(box, ws, ["init"]);
    git(box, demo, ["init", "-q", "-b", "main"]);
    await must(box, demo, ["project", "init", "--name", "demo", "--desc", "fast tier project"]);
    return { ws, demo };
}

export async function must(box, cwd, args, extra = {})
{
    return refuseFailure(await selfIn(box, cwd, args, extra), args);
}

function refuseFailure(result, args)
{
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
