// What every command does before it does anything else, where the store keeps
// its records on a server: it catches up.
//
// A delta pull, the marks that catch-up makes possible, a refold, and — once —
// the workspace's own list of projects. Then the command runs. The whole of it
// is best-effort by construction: a machine that cannot reach its workspace
// still records, still reads and still answers, because the local files are a
// complete log of everything this machine knows and being offline is an
// ordinary state rather than a failure.
//
// The pull table, first match wins:
//
//   L1   200                    the records are added to the server's copy, the
//                               appends they settle are marked sent, and the
//                               project is refolded
//   L2   404                    local answer, and a line saying the workspace
//                               server has no such project for this machine
//   L3   426                    local answer, and a line saying the CLI is out
//                               of date
//   L4   503                    local answer, and no wait. A read cannot be
//                               deferred — the person is holding the command
//   L5   anything else, offline local answer, and one line
//
// Nothing in the table can refuse a command. Every row ends in the command
// running against what this machine holds.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { foldProject } from "./fold.js";
import { StoredEvent, appendStoredEvents, lastServerSeq, storedEventIds } from "./logfile.js";
import { machineWorkspace } from "./machine.js";
import { serverBacked, syncMode } from "./mode.js";
import { machineNotice } from "./output.js";
import { STORE_DIR, invalidateResolution, readRegistry } from "./paths.js";
import { PENDING_FILE, compactedPending, markSent, markSurfaced, unsentAppends, unsurfacedBlocks } from "./pending.js";
import { ServerProject, reconcileRegistry } from "./registrycache.js";
import { acquireSyncLock, publishRewrite, releaseSyncLock } from "./synclock.js";
import { ApiAnswer, WorkspaceSession, listProjects, openSession, pullAfter } from "./transport.js";
import { JsonValue, SelfEvent } from "./types.js";

// The longest one catch-up may live, for the reason `PUSHER_LEASE_MS` exists
// and strictly under `SYNC_LEASE_MS` for the same one: a lock older than the
// stealing threshold is a lock whose holder has stopped only if every holder
// stops.
//
// A catch-up is one request per registered project, and a request is bounded
// but a walk over the projects is not. Without this, a store with enough of
// them reaches the age at which another process takes its lock while it is
// still working — and the lock's claim that a live holder cannot be that old
// would be true of the sender and false of this.
export const PULLER_LEASE_MS = 180_000;

// The store this machine points at, where that store keeps its records on a
// server. The machine's own pointer rather than the directory's marker, for the
// same reason the entry point reads the account off it: this runs before a
// command has resolved anything, and a machine pointing at no workspace is an
// ordinary answer.
export function serverBackedStore(): string | null
{
    // A pointer this machine cannot read is not a server-backed store; it is a
    // machine that needs repairing, and the command that needs the pointer is
    // the one that says so. Answering with a refusal from here would put that
    // sentence in front of `self --version`, which is a question about the
    // binary and needs no pointer at all.
    const workspaceDir = ignoringUnreadable(machineWorkspace, null);
    if (workspaceDir === null)
    {
        return null;
    }
    const storeDir = join(workspaceDir, STORE_DIR);
    return serverBacked(storeDir) ? storeDir : null;
}

// What a catch-up does with a file it cannot read: nothing, and it goes on to
// the next project.
//
// This is not the store forgiving damage. A command that reads the damaged
// project still refuses, in the sentence naming the file and the line, because
// that read is the command's own. What must not happen is one project's
// unreadable queue refusing a command about a different project — the catch-up
// touches every project, so without this it would make every file in the store
// load-bearing for every command in it.
export function ignoringUnreadable<T>(work: () => T, fallback: T): T
{
    try
    {
        return work();
    }
    catch
    {
        return fallback;
    }
}

// Everything the start of a command owes: catch up if the lock is free, then
// say whatever the queue has been holding for somebody to say.
//
// The surfacing is outside the lock and happens either way. A refusal recorded
// by a background push is a thing a person has to be told, and a sync that was
// skipped because another process held the lock is no reason to go on not
// telling them.
//
// A machine told not to sync does neither. `off` stands the whole layer down —
// it does not talk to the workspace and it does not read the queue looking for
// something to say about it — which is what makes it a machine working from
// what it holds rather than a machine with the network unplugged.
export async function catchUp(): Promise<void>
{
    const storeDir = serverBackedStore();
    if (storeDir === null || syncMode() === "off")
    {
        return;
    }
    await syncUnderLock(storeDir);
    surfaceBlocked(storeDir);
}

async function syncUnderLock(storeDir: string): Promise<void>
{
    const nonce = acquireSyncLock(storeDir);
    if (nonce === null)
    {
        return;
    }
    try
    {
        await sync(storeDir, nonce);
    }
    finally
    {
        releaseSyncLock(storeDir, nonce);
    }
}

async function sync(storeDir: string, nonce: string): Promise<void>
{
    // Set before the session is opened, so that the project list request is
    // inside the bound as well as the deltas that follow it.
    const until = Date.now() + PULLER_LEASE_MS;
    const session = openable(storeDir);
    if (session === null)
    {
        return;
    }
    await reconcile(storeDir, session, nonce);
    await pullEverySlug(storeDir, session, nonce, until);
}

// Every registered project's delta, for as long as this catch-up's lease has
// left.
//
// Past it the remaining projects are left where they are and this returns as
// though it had finished — because for the command in front of it, it has:
// every row of the pull table ends in the command running against what this
// machine holds, and a project this pass did not reach is one the next command
// reaches first. A partial pass is a state the design already answers, for the
// same reason a machine that died mid-pull is: nothing here is written unless
// the whole of it is, and the next pull asks from where each file ends.
//
// `until` is a parameter rather than a deadline this function sets itself, so
// that a case can state one.
export async function pullEverySlug(storeDir: string, session: WorkspaceSession, nonce: string,
    until: number): Promise<void>
{
    for (const entry of readRegistry(storeDir))
    {
        if (Date.now() < until)
        {
            // One project's unreadable files stop that project's catch-up and
            // nothing else. The command that reads *that* project still
            // refuses, in the sentence naming the file and the line, because
            // that read is the command's own — what must not happen is a
            // damaged queue in one project refusing a command about a
            // different one.
            await pullProject(storeDir, session, entry.slug, nonce).catch(() => undefined);
        }
    }
}

// A machine with no credential and a machine whose marker will not parse are
// both machines that cannot sync. Neither is said here: the first is somebody
// who has not logged in yet and will be told by the command they run, and the
// second is a refusal every command raises for itself.
function openable(storeDir: string): WorkspaceSession | null
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

/* ── the delta ─────────────────────────────────────────────────────── */

async function pullProject(storeDir: string, session: WorkspaceSession, slug: string, nonce: string): Promise<void>
{
    const answer = await pullAfter(session, slug, lastServerSeq(storeDir, slug));
    if (!answer.reached)
    {
        machineNotice("notice: this machine could not reach its workspace — reading what it already holds");
        return;                                                     // L5
    }
    if (answer.status === 200)
    {
        applyDelta(storeDir, slug, storedOf(answer.body), nonce);
        return;                                                     // L1
    }
    sayWhyNot(answer, slug);
}

// L2 to L5, in the order the table states them. Every one of them has already
// let the command through; the line is what the person gets instead of records
// they were expecting to see.
function sayWhyNot(answer: ApiAnswer & { reached: true }, slug: string): void
{
    if (answer.status === 404)
    {
        machineNotice(`notice: the workspace server has no project "${slug}" for this machine — `
            + "check the connection and the account with `self login`");
        return;
    }
    if (answer.status === 426)
    {
        machineNotice("notice: the workspace server speaks a newer API than this CLI — update `superself` to send and "
            + "receive again");
        return;
    }
    // A 503 says the workspace is not ready yet and names a delay. A read does
    // not wait it out: somebody is holding the command, and what this machine
    // holds is a complete answer to what this machine knows.
    machineNotice(answer.status === 503
        ? "notice: the workspace server is not ready yet — reading what this machine already holds"
        : `notice: the workspace server answered ${answer.status} — reading what this machine already holds`);
}

// L1, in the order the design fixes: the records land in the server's copy,
// then the appends every one of whose events has arrived are marked sent, then
// the project is refolded.
//
// A crash between the first and the second costs nothing. The next pull asks
// after the sequence the file now ends at, gets nothing back for those records,
// and settles the same appends off the ids already in the file — which is why
// the mark is decided by reading `log.jsonl`, not by remembering what this pull
// happened to receive.
function applyDelta(storeDir: string, slug: string, events: StoredEvent[], nonce: string): void
{
    appendStoredEvents(storeDir, slug, events);
    const settled = settleArrived(storeDir, slug);
    if (events.length === 0 && settled === 0)
    {
        // A delta of nothing that settled nothing changed nothing, and a refold
        // of an unchanged log is a rewrite of every derived file this project
        // has — on every command, since most commands find the workspace
        // exactly where they left it.
        return;
    }
    compactQueue(storeDir, slug, nonce);
    invalidateResolution();
    foldProject(storeDir, slug);
}

// The appends the server's copy now holds in full, marked and counted. Every
// event id, not most of them: an append is one transaction, so a half-arrived
// one is a pull that was cut off and will finish next time.
function settleArrived(storeDir: string, slug: string): number
{
    const stored = storedEventIds(storeDir, slug);
    const arrived = unsentAppends(storeDir, slug)
        .filter((append) => append.events.every((event: SelfEvent) => stored.has(event.id)))
        .map((append) => append.append_id);
    markSent(storeDir, slug, arrived);
    return arrived.length;
}

// The one rewrite this store makes, on the pull that changed something — which
// is the only moment new marks exist to drop. It costs a rewrite of a queue
// that is by then mostly history, and holding it back for a threshold would buy
// a queue that is longer for longer and one more number to be wrong about.
//
// A project with no queue file has nothing to tidy and is left without one: a
// store where every project holds an empty file is a store that has been
// written to for no reason.
function compactQueue(storeDir: string, slug: string, nonce: string): void
{
    const file = join(storeDir, "projects", slug, PENDING_FILE);
    if (existsSync(file))
    {
        publishRewrite(storeDir, file, nonce, compactedPending);
    }
}

function storedOf(body: JsonValue): StoredEvent[]
{
    const events = (body as { events?: unknown } | null)?.events;
    return (Array.isArray(events) ? events : []).filter(isStored);
}

// A row with no id and no sequence is not a record this store can hold: the id
// is what a fold counts an event by and the sequence is where the next pull
// starts from. Skipped rather than thrown over — a server that grows a row
// shape this CLI has never seen must not stop the command.
function isStored(event: unknown): event is StoredEvent
{
    const row = event as Partial<StoredEvent>;
    return typeof row?.id === "string" && typeof row?.server_seq === "number";
}

/* ── the workspace's own list ──────────────────────────────────────── */

// Once at the start of a command, which is the conservative number: it is what
// makes another machine's new project, removed project or edited description
// show up here at all, and asking more often would spend a request per command
// on a list that changes in days.
async function reconcile(storeDir: string, session: WorkspaceSession, nonce: string): Promise<void>
{
    const answer = await listProjects(session);
    if (answer.reached && answer.status === 200 && Array.isArray(answer.body))
    {
        reconcileRegistry(storeDir, (answer.body as unknown[]).filter(isProject), stillQueued(storeDir), nonce);
    }
    // Every other answer is the pull table's business and the pull says it: a
    // 404 or a 426 here is the same 404 or 426 the delta is about to get, and
    // saying it twice would be one command reporting one fact two ways.
}

// The projects this machine still holds records for. A reconciliation may not
// unregister one of these however sure the workspace is that it is gone.
function stillQueued(storeDir: string): string[]
{
    return ignoringUnreadable(() => readRegistry(storeDir), [])
        .map((entry) => entry.slug)
        .filter((slug) => ignoringUnreadable(() => unsentAppends(storeDir, slug), []).length > 0);
}

function isProject(project: unknown): project is ServerProject
{
    const row = project as Partial<ServerProject>;
    return typeof row?.id === "string" && typeof row?.slug === "string";
}

/* ── what the queue has been waiting to say ────────────────────────── */

// A background push has no output channel, so a refusal it recorded is said by
// the next command that has one — once, and never again. The mark that it has
// been said is the same blocked row said again with the moment it was said on,
// which is a field on a row shape the CLI already reads rather than a fourth
// shape an older one would mistake for an append.
function surfaceBlocked(storeDir: string): void
{
    if (ignoringUnreadable(() => readRegistry(storeDir), []).length === 0)
    {
        return;
    }
    for (const entry of readRegistry(storeDir))
    {
        const blocks = ignoringUnreadable(() => unsurfacedBlocks(storeDir, entry.slug), []);
        blocks.forEach((block) => machineNotice(`notice: ${entry.slug} — records this machine made are not going to the `
            + `workspace: ${block.detail ?? block.code}`));
        markSurfaced(storeDir, entry.slug, blocks);
    }
}
