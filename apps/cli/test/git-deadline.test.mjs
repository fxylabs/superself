// Every git the CLI runs is bounded, and nothing git leaves behind can pin the
// CLI to it (#367).
//
// The trigger is a git hook that backgrounds a process and returns. That
// process inherits git's stdout and stderr, so the pipes stay open after git
// itself has exited, and a synchronous spawn that reads until end-of-pipe
// waits on a process it never started — for as long as that process lives.
// Real equivalents are a gpg agent, an ssh control master, a corporate git
// wrapper: none is exotic, and each one used to be a `self` that never came
// back.
//
// Each case installs its own hook, names its own deadline through
// SUPERSELF_GIT_TIMEOUT_MS, and kills what it started. The sleeps carry
// distinct durations so a case can find and kill its own and no other's. The
// wall-clock assertions have a wide margin on purpose: this file asserts
// "bounded", not "fast", and it shares a machine with the rest of the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git as gitOf } from "../dist/gitutil.js";
import { demoWorkspace, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);
const store = join(ws, ".superself");
const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));

// Short enough that a stuck git costs the suite two seconds, and far longer
// than any healthy git in the store needs.
const DEADLINE = "2000";

// The margin every wall-clock assertion uses. Ten times the deadline: a run
// that stays under it cannot have waited on the sleeping process, and a loaded
// runner never trips it.
const BOUND_MS = 20_000;

function hook(name, body)
{
    const file = join(store, ".git", "hooks", name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return () => rmSync(file, { force: true });
}

// Whatever the hook backgrounded, killed by the marker it was started with.
// Silent when there is nothing left: a case that already ended cleanly has
// nothing to clean up, and a cleanup step must never be the thing that fails.
function killSleeper(marker)
{
    execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" })
        .split("\n")
        .filter((row) => row.trimEnd().endsWith(`sleep ${marker}`))
        .forEach((row) =>
        {
            try
            {
                process.kill(Number(row.trim().split(/\s+/)[0]), "SIGKILL");
            }
            catch
            {
                // Already gone between the listing and the signal.
            }
        });
}

// #367's own repro, whole: a store whose post-commit hook backgrounds a
// process that outlives git. The sleep runs for ten minutes, so anything that
// waits on it does not come back inside this suite.
//
// Which of the two bounded outcomes arrives is the host's to decide, and both
// are right. Whether git waits on its own hook's output pipe differs between
// git versions — where it does, git is the one that has to be killed and the
// command refuses by name; where it does not, git exits on its own, the CLI
// reads its status and records. What is asserted is what holds either way: the
// command came back near the deadline rather than near the sleep, and it came
// back with a definite answer rather than a half-written one.
test("a git that leaves a live process holding its pipes does not pin the CLI", async () =>
{
    const remove = hook("post-commit", "( sleep 601 ) &\nexit 0");
    const started = Date.now();
    let wrote;
    try
    {
        wrote = await selfIn(box, demo, ["work", "add", "bounded by the deadline"], { SUPERSELF_GIT_TIMEOUT_MS: DEADLINE });
    }
    finally
    {
        remove();
        killSleeper(601);
    }
    const took = Date.now() - started;
    assert.ok(took < BOUND_MS, `the write took ${took}ms, so the deadline did not end the wait`);
    if (wrote.code === 0)
    {
        // Read back rather than trusting the receipt: what the success half of
        // this claims is that the record survived the hook, not that the
        // command printed a line.
        const shown = await must(box, demo, ["work", "show", workIdIn(wrote.out)]);
        assert.match(shown.out, /bounded by the deadline/);
        return;
    }
    assert.equal(wrote.code, 1);
    assert.match(wrote.out, /was killed after/);
});

test("a git that has to be killed is refused by name, with its argv, its directory and the seconds it ran", async () =>
{
    const remove = hook("pre-commit", "sleep 602");
    const started = Date.now();
    let failed;
    try
    {
        failed = await selfIn(box, demo, ["work", "add", "killed mid-commit"], { SUPERSELF_GIT_TIMEOUT_MS: DEADLINE });
    }
    finally
    {
        remove();
        killSleeper(602);
    }
    const took = Date.now() - started;
    assert.ok(took < BOUND_MS, `the refusal took ${took}ms`);
    assert.equal(failed.code, 1);
    assert.match(failed.out, /git commit -qm/);
    assert.ok(failed.out.includes(store), `the refusal does not name ${store}: ${failed.out}`);
    assert.match(failed.out, /was killed after \d+\.\ds/);
});

// A killed git leaves the repository intact — that is what git's write
// protocol is for — and the next command has to prove it by recording, not by
// reporting a write it could not make.
test("the store records again after a git was killed mid-commit", async () =>
{
    const work = workIdIn((await must(box, demo, ["work", "add", "recorded after the kill"])).out);
    assert.match((await must(box, demo, ["work", "show", work])).out, /recorded after the kill/);
});

test("a rejected commit is refused rather than reported as a write", async () =>
{
    const remove = hook("pre-commit", "echo 'this store refuses commits' >&2\nexit 1");
    try
    {
        const failed = await selfIn(box, demo, ["work", "add", "the commit will be rejected"]);
        assert.equal(failed.code, 1);
        assert.match(failed.out, /committing the workspace store/);
        // git's own sentence survives the change of stdio: stderr is still a
        // pipe, so what the hook wrote there is what the person is shown.
        assert.match(failed.out, /this store refuses commits/);
    }
    finally
    {
        remove();
    }
});

test("nothing git runs may go looking for a keyboard when there is none", async () =>
{
    const probe = join(box.root, "asked.txt");
    const remove = hook("post-commit", `printf '%s|%s\\n' "\${GIT_TERMINAL_PROMPT-unset}" "\${GIT_SSH_COMMAND-unset}" > ${probe}`);
    try
    {
        await must(box, demo, ["work", "add", "runs with no terminal"]);
    }
    finally
    {
        remove();
    }
    assert.ok(existsSync(probe), "the hook did not run, so the environment was never observed");
    const [prompt, ssh] = readFileSync(probe, "utf8").trim().split("|");
    assert.equal(prompt, "0");
    assert.match(ssh, /BatchMode=yes/);
});

// Where git does exit on its own and something else is left holding the
// pipes, its exit status is the true answer and the CLI runs on it rather
// than refusing a command git completed. Modern git waits for its own hooks,
// so the only way to stage that ordering is a git that is not git.
test("a git that finished before its pipes did is answered on, not refused", async () =>
{
    const fake = join(box.root, "fakebin");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "git"), "#!/bin/sh\necho fake-answer\n( sleep 604 ) &\nexit 0\n");
    chmodSync(join(fake, "git"), 0o755);
    const path = process.env.PATH;
    const asked = process.env.SUPERSELF_GIT_TIMEOUT_MS;
    const started = Date.now();
    try
    {
        process.env.PATH = `${fake}:${path}`;
        process.env.SUPERSELF_GIT_TIMEOUT_MS = DEADLINE;
        const result = gitOf(demo, "rev-parse", "HEAD");
        assert.equal(result.ok, true);
        assert.equal(result.out, "fake-answer");
    }
    finally
    {
        process.env.PATH = path;
        restoreEnv("SUPERSELF_GIT_TIMEOUT_MS", asked);
        killSleeper(604);
    }
    const took = Date.now() - started;
    assert.ok(took < BOUND_MS, `the call took ${took}ms`);
});

function restoreEnv(name, was)
{
    if (was === undefined)
    {
        delete process.env[name];
        return;
    }
    process.env[name] = was;
}

test("a read is not blocked by a writer stalled inside git", async () =>
{
    const read = workIdIn((await must(box, demo, ["work", "add", "read while a writer stalls"])).out);
    const remove = hook("pre-commit", "sleep 603");
    // A real child, because the in-process driver runs one command at a time
    // and the whole question is what a second, concurrent command sees.
    // Detached so the stalled git and its sleep can be killed as one group.
    const writer = spawn(process.execPath, [bin, "work", "add", "stalled writer"], {
        cwd: demo,
        env: { ...box.env, SUPERSELF_GIT_TIMEOUT_MS: "60000" },
        stdio: "ignore",
        detached: true
    });
    try
    {
        await new Promise((done) => setTimeout(done, 2000));
        const started = Date.now();
        const shown = await must(box, demo, ["work", "show", read]);
        const took = Date.now() - started;
        assert.match(shown.out, /read while a writer stalls/);
        assert.ok(took < BOUND_MS, `the read waited ${took}ms behind the stalled writer`);
    }
    finally
    {
        remove();
        if (writer.pid !== undefined)
        {
            try
            {
                process.kill(-writer.pid, "SIGKILL");
            }
            catch
            {
                // The writer's group is already gone.
            }
        }
        killSleeper(603);
        await new Promise((done) => writer.on("exit", done));
    }
});
