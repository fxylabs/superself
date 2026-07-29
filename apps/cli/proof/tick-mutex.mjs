// Two ticks arriving at the machine's tick mutex at the same instant.
//
// The mutex now judges its holder rather than waiting out a fixed window, so
// that a supervisor killed mid-tick does not freeze the next one. Judging the
// holder is what makes this case necessary: the lock file is created
// exclusively and its token is written a syscall later, so a waiter that reads
// that gap sees a lock naming nobody. Reading "nobody holds this" as "this is
// abandoned" deletes the lock of the process that just won it, and both ticks
// then run believing they are alone — which is the concurrency cap overshot by
// exactly what the other one dispatched.
//
// The window is microseconds wide and two ticks started together land in it
// together, so this is a repetition rather than a timing trick: each round
// starts a fresh pair against a fresh machine root, and a round in which both
// were inside the section at once is a failure of the round.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ROUNDS = Number(process.argv[2] ?? 40);

// Held long enough that an overlap is observed rather than missed, short
// enough that forty rounds are a few seconds.
const INSIDE_MS = 15;

// Runs in each child: take the mutex, and say so if somebody else is already
// inside the section it is supposed to be alone in.
const BODY = `
import { withTickLock } from ${JSON.stringify(join(DIST, "daemon", "state.js"))};
import { existsSync, rmSync, writeFileSync } from "node:fs";
const inside = process.env.TICK_MUTEX_INSIDE;
try
{
    await withTickLock(async () =>
    {
        if (existsSync(inside))
        {
            process.stdout.write("OVERLAP");
        }
        writeFileSync(inside, String(process.pid));
        await new Promise((resolve) => setTimeout(resolve, ${INSIDE_MS}));
        rmSync(inside, { force: true });
    });
}
catch (error)
{
    process.stdout.write("ERROR:" + error.message);
}
`;

function tick(env)
{
    return new Promise((resolve) =>
    {
        const child = spawn(process.execPath, ["--input-type=module", "-e", BODY], { env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { out += chunk; });
        child.on("close", (code) => resolve({ code, out }));
    });
}

function fail(message)
{
    console.error(`proof FAILED: ${message}`);
    process.exit(1);
}

for (let round = 0; round < ROUNDS; round++)
{
    const root = mkdtempSync(join(tmpdir(), "tick-mutex-"));
    const inside = join(root, "inside");
    const env = { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), TICK_MUTEX_INSIDE: inside };
    const ran = await Promise.all([tick(env), tick(env)]);
    const overlapped = ran.some((one) => one.out.includes("OVERLAP"));
    const failed = ran.find((one) => one.code !== 0 || one.out.includes("ERROR:"));
    const stranded = existsSync(inside);
    rmSync(root, { recursive: true, force: true });
    if (overlapped)
    {
        fail(`two ticks were inside the section together in round ${round + 1} of ${ROUNDS}`);
    }
    if (failed !== undefined)
    {
        fail(`a tick contending for the mutex did not come out of it in round ${round + 1}: ${failed.out.slice(0, 200)}`);
    }
    if (stranded)
    {
        fail(`a tick left the section marked as occupied in round ${round + 1}`);
    }
}

console.log(`tick mutex OK (${ROUNDS} contended rounds)`);
