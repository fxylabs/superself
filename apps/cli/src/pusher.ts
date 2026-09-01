// Sending a server-backed store's queue, and what this machine does with every
// answer it can get back.
//
// The table below is the whole of the module's contract and is written out row
// by row, first match wins, because it is the review surface: a status with no
// row is a path nothing decided.
//
//   P1   200                    nothing changes here. The `sent` mark is the
//                               pull's to write, after it has seen the records
//                               arrive; a re-send in the meantime is absorbed
//                               by the server as a duplicate
//   P2   400 actor_mismatch     blocked — these records name an author this
//                               machine is no longer logged in as
//   P3   400 (anything else)    blocked, as P8
//   P4   409                    re-sent one append at a time, so the one whose
//                               content disagrees with the server is the only
//                               one blocked and the rest go
//   P5   413                    re-sent one append at a time. An append that is
//                               over the limit on its own was refused where it
//                               was made, so the split is the whole answer
//   P6   404                    the project is not there for this machine. If
//                               nothing has cached a server id for it, this
//                               machine is the one that made it and has never
//                               registered it: create it once and push again.
//                               If an id is cached, somebody deleted it and
//                               re-creating it would resurrect it — blocked
//   P7   426                    left queued, not blocked. The CLI is out of
//                               date, which the next command says out loud
//   P8   other 4xx              blocked, surfaced by the next command
//   P9   503 + Retry-After      waited out once, capped, then tried again
//   P10  5xx, network, timeout  left queued, silently
//
// Nothing here prints. A background push has no output channel — that is the
// whole reason a refusal is written down as a row rather than said — and the
// next command with a terminal in front of it does the saying.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serverBacked, syncMode } from "./mode.js";
import { readRegistry } from "./paths.js";
import { ignoringUnreadable } from "./puller.js";
import { markBlocked, unsentAppends } from "./pending.js";
import { acquireSyncLock, releaseSyncLock } from "./synclock.js";
import {
    ApiAnswer, RETRY_AFTER_CAP_MS, WireAppend, WorkspaceSession, createProject, errorCodeOf,
    openSession, pushAppends, retryAfterMs
} from "./transport.js";
import { cacheProjectId, projectIdOf } from "./registrycache.js";

// The longest one push run may live. Strictly under `SYNC_LEASE_MS`, which is
// what makes a lock older than the lease a lock whose holder has stopped: the
// holder enforces its own bound, so nothing has to guess at one.
export const PUSHER_LEASE_MS = 180_000;

/* ── entering ──────────────────────────────────────────────────────── */

// Whether this store has anything to send. Asked before a process is started,
// because starting one per read command to discover there was nothing to do is
// a process per read command.
function hasUnsent(storeDir: string): boolean
{
    return serverBacked(storeDir)
        && queuedSlugs(storeDir).length > 0;
}

// The projects with something to send, skipping any whose queue this pass
// cannot read. A damaged file is one project's problem and is reported by the
// command that reads that project; it must not stop another project's records
// from going.
function queuedSlugs(storeDir: string): string[]
{
    return ignoringUnreadable(() => readRegistry(storeDir), [])
        .map((entry) => entry.slug)
        .filter((slug) => ignoringUnreadable(() => unsentAppends(storeDir, slug), []).length > 0);
}

export async function sendQueued(storeDir: string): Promise<void>
{
    const mode = syncMode();
    if (mode === "off" || !hasUnsent(storeDir))
    {
        return;
    }
    if (mode === "inline")
    {
        await pushStore(storeDir);
        return;
    }
    spawnPusher(storeDir);
}

// The entry point resolved from this module's own location rather than from
// `argv[1]`, `process.cwd()` or a name on `PATH`. A CLI installed globally, run
// through `npx`, linked from a checkout and vendored into a project all sit at
// different paths, and only one of them is the path of the file that is
// running: this one.
function spawnPusher(storeDir: string): void
{
    const entry = fileURLToPath(new URL("./pushermain.js", import.meta.url));
    const child = spawn(process.execPath, [entry, storeDir], { detached: true, stdio: "ignore" });
    // A spawn that never starts — no descriptors left, no process slots left —
    // raises an `error` event, and an unhandled one is an uncaught exception in
    // a process that has already run the person's command and printed its
    // answer. Taking it and doing nothing is the whole of the handling: the
    // queue still holds every append, so the records are where they were and
    // the next command sends them.
    child.on("error", () => undefined);
    // Unreferenced and in its own process group: the command that started it is
    // finished, and neither its exit nor its terminal is this process's concern.
    child.unref();
}

/* ── one run ───────────────────────────────────────────────────────── */

// Every registered project's queue, under the sync lock, once.
//
// A failure to open a session — no credential on this machine, a marker that
// will not parse — ends the run and says nothing. There is nobody to say it to,
// and the queue is untouched, so the next command in a terminal reads the same
// refusal and does the talking.
export async function pushStore(storeDir: string): Promise<void>
{
    if (!serverBacked(storeDir))
    {
        return;
    }
    const nonce = acquireSyncLock(storeDir);
    if (nonce === null)
    {
        return;
    }
    try
    {
        await pushEverySlug(storeDir, nonce);
    }
    finally
    {
        releaseSyncLock(storeDir, nonce);
    }
}

async function pushEverySlug(storeDir: string, nonce: string): Promise<void>
{
    const until = Date.now() + PUSHER_LEASE_MS;
    const session = sessionFor(storeDir);
    if (session === null)
    {
        return;
    }
    for (const slug of queuedSlugs(storeDir))
    {
        if (Date.now() < until)
        {
            await sendBatch({ session, storeDir, slug, nonce, until, created: false },
                unsentAppends(storeDir, slug));
        }
    }
}

function sessionFor(storeDir: string): WorkspaceSession | null
{
    try
    {
        return openSession(storeDir);
    }
    catch
    {
        return null;
    }
}

interface Run
{
    session: WorkspaceSession;
    storeDir: string;
    slug: string;
    nonce: string;
    until: number;
    // Whether this run has already offered to create this project. Its own flag
    // rather than a second meaning for `retried`: an append re-sent on its own
    // after a 413 has spent its retry and may still be the first thing to
    // discover the project was never registered, and reading one from the other
    // would make the split decide the creation.
    created: boolean;
}

/* ── the table ─────────────────────────────────────────────────────── */

// One request carrying one or more appends, and the first row of the table
// that matches its answer. `retried` says this batch has already spent its one
// second chance, which is what keeps every retrying row — the 503 wait, the
// re-push after a project is created — from looping.
async function sendBatch(run: Run, appends: WireAppend[], retried = false): Promise<void>
{
    if (Date.now() > run.until)
    {
        return;
    }
    const answer = await pushAppends(run.session, run.slug, appends, projectIdOf(run.storeDir, run.slug));
    if (!answer.reached)
    {
        return;                                                     // P10
    }
    await applyStatus(run, appends, answer, retried);
}

// The rows that are about this machine or this moment rather than about the
// records. Split from the refusals below only for length; the statuses are
// disjoint, so the order across the two reads exactly as the table states it.
async function applyStatus(run: Run, appends: WireAppend[], answer: ApiAnswer & { reached: true }, retried: boolean): Promise<void>
{
    if (answer.status === 200 || answer.status === 426)
    {
        return;                                                     // P1, P7
    }
    if (answer.status === 404)
    {
        await afterUnknownProject(run, appends);
        return;                                                     // P6
    }
    if (answer.status === 503 && !retried)
    {
        await waitAndRetry(run, appends, retryAfterMs(answer.headers));
        return;                                                     // P9
    }
    await afterRefusal(run, appends, answer);
    // What neither answered is a 5xx, and a 503 already waited out once. The
    // queue keeps them.                                             // P10
}

// The rows where the workspace refused the records themselves. Every one of
// them either stops an append or splits the batch and lets the answer be read
// again; none of them leaves it quietly queued.
async function afterRefusal(run: Run, appends: WireAppend[], answer: ApiAnswer & { reached: true }): Promise<void>
{
    if (answer.status === 400)
    {
        blockAll(run, appends, errorCodeOf(answer.body) ?? "rejected", refusalOf(answer));
        return;                                                     // P2, P3
    }
    if (answer.status === 409 || answer.status === 413)
    {
        await splitOrBlock(run, appends, answer.status === 413 ? "too_large" : "conflict", refusalOf(answer));
        return;                                                     // P4, P5
    }
    if (answer.status >= 400 && answer.status < 500)
    {
        blockAll(run, appends, `http_${answer.status}`, refusalOf(answer));  // P8
    }
}

// P4 and P5 both: a batch the server refused as a whole is re-sent one append
// at a time, so the one it objects to is the only one that stops. A batch that
// was already a single append has nowhere left to split, and its refusal is
// the append's own.
async function splitOrBlock(run: Run, appends: WireAppend[], code: string, detail: string): Promise<void>
{
    if (appends.length === 1)
    {
        blockAll(run, appends, code, detail);
        return;
    }
    for (const append of appends)
    {
        // In the order they were made, and one at a time. The server takes an
        // append as one transaction and dedups by event id, so an append that
        // was in the refused batch is either wholly there or wholly not, and
        // sending it again cannot half-apply it.
        await sendBatch(run, [append], true);
    }
}

// P6. The cached server id is the whole of the decision. Without one, this
// machine made the project and has never told the server about it, so it says
// so once. With one, the project existed and does not any more — re-creating it
// would raise a project somebody else deliberately removed, and the records go
// nowhere until a person looks.
async function afterUnknownProject(run: Run, appends: WireAppend[]): Promise<void>
{
    if (projectIdOf(run.storeDir, run.slug) !== undefined || run.created)
    {
        blockAll(run, appends, "unknown_project",
            `the workspace server has no project "${run.slug}" for this machine — check the connection and `
            + "the account with `self login`");
        return;
    }
    await createThenPush(run, appends);
}

async function createThenPush(run: Run, appends: WireAppend[]): Promise<void>
{
    run.created = true;
    const made = await createProject(run.session, run.slug, descriptionOf(run.storeDir, run.slug));
    if (!made.reached)
    {
        return;                                                     // P10
    }
    if (made.status === 201)
    {
        cacheProjectId(run.storeDir, run.slug, idOf(made.body), run.nonce);
        await sendBatch(run, appends, true);
        return;
    }
    if (made.status === 409)
    {
        blockAll(run, appends, "project_taken",
            `the workspace already holds a project named "${run.slug}" and this machine cannot reach it — `
            + "ask an owner of that project for access");
        return;
    }
    if (made.status === 404)
    {
        blockAll(run, appends, "project_denied",
            `this machine may not create "${run.slug}" in this workspace — check the connection and the `
            + "account with `self login`");
    }
    // A 426 or a 503 on the creation is the same answer as on the push: the
    // records stay queued and the next command tries again.
}

async function waitAndRetry(run: Run, appends: WireAppend[], waitMs: number | null): Promise<void>
{
    await new Promise((done) => setTimeout(done, Math.min(waitMs ?? RETRY_AFTER_CAP_MS, RETRY_AFTER_CAP_MS)));
    await sendBatch(run, appends, true);
}

function blockAll(run: Run, appends: WireAppend[], code: string, detail: string): void
{
    appends.forEach((append) => markBlocked(run.storeDir, run.slug, append.append_id, code, detail));
}

// What the server said, where it said anything a person can read. The message
// is the server's own and is shown as one: a refusal this CLI has no words for
// is better reported in the words it was given than summarised away.
function refusalOf(answer: ApiAnswer & { reached: true }): string
{
    const message = (answer.body as { message?: unknown } | null)?.message;
    return typeof message === "string" && message !== ""
        ? message
        : `the workspace server refused these records (${answer.status})`;
}

function idOf(body: unknown): string | undefined
{
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : undefined;
}

function descriptionOf(storeDir: string, slug: string): string | undefined
{
    return readRegistry(storeDir).find((entry) => entry.slug === slug)?.description;
}
