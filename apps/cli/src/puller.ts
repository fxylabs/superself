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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { foldProject } from "./fold.js";
import { StoredEvent, appendStoredEvents, lastServerSeq, storedEventIds } from "./logfile.js";
import { machineWorkspace } from "./machine.js";
import { serverBacked, syncMode } from "./mode.js";
import { machineNotice } from "./output.js";
import { STORE_DIR, invalidateResolution, readRegistry } from "./paths.js";
import { PENDING_FILE, compactedPending, markSent, markSurfaced, unsentAppends, unsurfacedBlocks } from "./pending.js";
import { ServerProject, reconcileRegistry } from "./registrycache.js";
import { acquireSyncLock, publishRewrite, releaseSyncLock, renewSyncLock } from "./synclock.js";
import { ApiAnswer, WorkspaceSession, listProjects, openSession, pullAfter } from "./transport.js";
import { CliError, JsonValue, SelfEvent } from "./types.js";

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
//
// One number, read two ways, and the difference is whether the pass has a
// command behind it. An ordinary catch-up stands in front of somebody's
// command, so this is the whole pass: what it does not reach, the next command
// reaches, and stopping is free. The first catch-up of a store being created
// has no next command — it either reads the whole workspace or the store does
// not exist — so this is what *one project* is given, and the pass goes on for
// as long as projects keep arriving inside it (`walkSlugs`, `renewSyncLock`).
// A flat bound there is not a bound on the work; it is a size of workspace this
// CLI cannot attach to at all, and no retry gets past it.
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

// Every registered project's delta, in turn, for as long as this catch-up's
// lease has left and for as long as the workspace is answering.
//
// Past the lease the remaining projects are left where they are and this
// returns as though it had finished — because for the command in front of it,
// it has: every row of the pull table ends in the command running against what
// this machine holds. A partial pass is a state the design already answers, for
// the same reason a machine that died mid-pull is: nothing here is written
// unless the whole of it is, and the next pull asks from where each file ends.
//
// "The next command reaches them" is only true if the next command starts
// somewhere else, which is what `inTurn` is for. It is also only worth
// attempting while there is something to attempt: a workspace this pass could
// not reach is a fact about the workspace and not about one project, so the
// project after it would spend another request's timeout discovering the same
// thing, and a person holding the command would wait out one of those per
// registered project to be told the same sentence that many times.
//
// `until` is a parameter rather than a deadline this function sets itself, so
// that a case can state one.
//
// The answer is whether the workspace was reachable throughout, which is a fact
// about the network rather than about any one project — false only where a
// request did not come back at all. Every ordinary caller ignores it, because
// every row of the pull table ends in the command running against what this
// machine holds; the first catch-up of a store being created is the one caller
// that has nothing to fall back on and reads it.
export async function pullEverySlug(storeDir: string, session: WorkspaceSession, nonce: string,
    until: number): Promise<boolean>
{
    return (await walkSlugs(storeDir, session, nonce, { until })).reached;
}

// Somebody pressed ctrl-c. Read between projects rather than acted on where it
// is set, for the reason `login.ts` gives its own: the loser of a race is still
// running, and a pull that kept writing into a store the flow is about to take
// off the disk would put files back after the removal.
//
// Set by whoever owns the removal — `cloud.ts`, which is the only caller that
// has a store to take back — rather than by a handler this file installs. The
// signal has to stay caught until the directory is gone, and the thing that
// removes the directory is the thing that knows when that is.
export interface Cancellation
{
    requested: boolean;
}

// What bounds one pass, and whether a local failure inside it is the pass's or
// one project's.
//
// `strict` is the first catch-up of a store being created and nothing else.
// Every other pass is best effort by construction — the local files are a
// complete log of what this machine knows, so a project that could not be
// written costs a notice — while this one *is* the filling of those files: a
// delta it could not write is a project that is not there, and a store missing
// one is worse than no store at all.
interface CatchUpBounds
{
    until: number;
    each?: number;
    strict?: boolean;
    cancel?: Cancellation;
}

// What one pass reached: whether the workspace answered throughout, and how
// many registered projects it never got to. The second is the lease's business
// and the interrupt's — an ordinary pass leaves them for the next command, and
// the first catch-up has no next command to leave them to.
interface CatchUp
{
    reached: boolean;
    left: number;
}

async function walkSlugs(storeDir: string, session: WorkspaceSession, nonce: string,
    bounds: CatchUpBounds): Promise<CatchUp>
{
    const slugs = inTurn(storeDir);
    for (const [index, slug] of slugs.entries())
    {
        if (Date.now() >= bounds.until || bounds.cancel?.requested === true)
        {
            return { reached: true, left: slugs.length - index };
        }
        allowed(storeDir, nonce, bounds);
        if (!await pulled(storeDir, session, slug, nonce, bounds))
        {
            return { reached: false, left: slugs.length - index };
        }
        rememberPlace(storeDir, slug);
    }
    return { reached: true, left: 0 };
}

// The next project's allowance, granted where the pass has one to grant — and
// nothing at all where it does not, which is every pass but the first catch-up.
//
// Granted *after* the check above and never before it, which is what makes the
// check mean anything: the deadline in force while a project is pulled is the
// one set before it started, so the check at the top of the next turn is where
// that project's own duration is judged. A pass that renewed after each project
// instead would set a deadline it had just satisfied and never stop at all.
//
// The lock's stamp moves with it. The two are one act, not two: a bound this
// process keeps extending on itself while another process reads a stamp that is
// not moving would age a live holder into a stealable one, which is the
// property `SYNC_LEASE_MS` is built on.
function allowed(storeDir: string, nonce: string, bounds: CatchUpBounds): void
{
    if (bounds.each === undefined)
    {
        return;
    }
    bounds.until = Date.now() + bounds.each;
    renewSyncLock(storeDir, nonce);
}

// One project's unreadable files stop that project's catch-up and nothing else,
// and say nothing about whether the workspace answered. The command that reads
// *that* project still refuses, in the sentence naming the file and the line,
// because that read is the command's own — what must not happen is a damaged
// queue in one project refusing a command about a different one.
//
// The first catch-up is the exception, and `strict` is where it is made: there
// is no command behind it whose own read would refuse, so a failure swallowed
// here would be reported as a store that had been filled.
function pulled(storeDir: string, session: WorkspaceSession, slug: string, nonce: string,
    bounds: CatchUpBounds): Promise<boolean>
{
    const pulling = pullProject(storeDir, session, slug, nonce);
    return bounds.strict === true ? pulling : pulling.catch(() => true);
}

/* ── whose turn it is ──────────────────────────────────────────────── */

// Where the last pass got to, so the next one starts after it rather than at
// the front of the list again.
//
// A hint and never a record. It holds nothing the store could not work out
// again, and losing it costs one unfair pass — which is why it is written whole
// rather than appended to, and why nothing reads it as part of a project's
// history. The append-only rule next door is about the two files that are the
// only copy of something; this is neither of them.
const PLACE_FILE = "sync.place";

// The registry, rotated to start after the project the last pass reached.
//
// Without this a pass cut short by its lease leaves the same projects unreached
// every time, and "the next command reaches them" is a hope rather than a fact:
// the projects at the front would be the only ones this machine ever pulled,
// and the ones behind them would never have an append settled, never be
// compacted, and never stop growing. A place naming a slug the registry no
// longer lists reads as no place at all, which starts the pass at the front.
function inTurn(storeDir: string): string[]
{
    const slugs = ignoringUnreadable(() => readRegistry(storeDir), []).map((entry) => entry.slug);
    const last = slugs.indexOf(placeIn(storeDir));
    return [...slugs.slice(last + 1), ...slugs.slice(0, last + 1)];
}

function placeIn(storeDir: string): string
{
    return ignoringUnreadable(() =>
        (JSON.parse(readFileSync(join(storeDir, PLACE_FILE), "utf8")) as { slug?: string }).slug ?? "", "");
}

// Best-effort, like everything else a catch-up does: a store this process may
// not write is one that pulls in the order it always did, and that is a worse
// rotation rather than a failure a person needs to hear about.
function rememberPlace(storeDir: string, slug: string): void
{
    ignoringUnreadable(() => writeFileSync(join(storeDir, PLACE_FILE), JSON.stringify({ slug }) + "\n"), undefined);
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

// Whether the workspace answered at all, which is the caller's business and not
// this project's: every other row of the table is about what the workspace said
// about *this* project, and `reached` is about the network in front of all of
// them.
async function pullProject(storeDir: string, session: WorkspaceSession, slug: string,
    nonce: string): Promise<boolean>
{
    const answer = await pullAfter(session, slug, lastServerSeq(storeDir, slug));
    if (!answer.reached)
    {
        machineNotice("notice: this machine could not reach its workspace — reading what it already holds");
        return false;                                               // L5
    }
    if (answer.status === 200)
    {
        applyDelta(storeDir, slug, storedOf(answer.body), nonce);
        return true;                                                // L1
    }
    sayWhyNot(answer, slug);
    return true;
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
    invalidateResolution();
    foldProject(storeDir, slug);
    // Last, and after the fold rather than before it. Compaction is tidying —
    // it drops the appends the server has taken and the marks about them, which
    // every read already filters out — so the fold sees the same queue either
    // way. What the order buys is that a compaction that fails cannot cancel
    // the fold: the events and the marks are written by then, so the next pull
    // finds nothing new, returns above, and would never fold this delta at all.
    compactQueue(storeDir, slug, nonce);
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
async function reconcile(storeDir: string, session: WorkspaceSession, nonce: string): Promise<ApiAnswer>
{
    const answer = await listProjects(session);
    if (answer.reached && answer.status === 200 && Array.isArray(answer.body))
    {
        reconcileRegistry(storeDir, (answer.body as unknown[]).filter(isProject), stillQueued(storeDir), nonce);
    }
    // Every other answer is the pull table's business and the pull says it: a
    // 404 or a 426 here is the same 404 or 426 the delta is about to get, and
    // saying it twice would be one command reporting one fact two ways.
    //
    // Handed back rather than swallowed for the one caller that has no pull
    // behind it to say anything: the first catch-up of a store being created,
    // which is the only catch-up in this file that is allowed to fail.
    return answer;
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

/* ── the catch-up that is allowed to fail ──────────────────────────── */

// What `self init --cloud` runs once the store's marker is on disk, and the one
// catch-up in this file that can refuse.
//
// Every other one is best effort, and rightly: the local files are a complete
// log of what this machine knows, so a workspace it cannot reach costs a notice
// and nothing else. This one has no local files behind it — it is what fills
// them — and finishing it is the difference between a store attached to a
// workspace this machine is a member of and a directory naming a server nobody
// has checked. So each way it can end short is a sentence, and the flow that
// called it takes the store back off the disk.
//
// `each` is a parameter here for the reason `until` is one on the walk: what
// one project is given is a property of the pass rather than of the function,
// and a case that states a small one is how the stalled pass is asserted at all
// without waiting out the shipped number.
export async function firstCatchUp(storeDir: string, pass: FirstPass = {}): Promise<void>
{
    const nonce = acquireSyncLock(storeDir);
    if (nonce === null)
    {
        // A store nothing else knows about yet, so this is another process
        // inside the same directory rather than a busy workspace.
        throw new CliError("another process is already working in this directory — nothing was created");
    }
    try
    {
        await firstSync(storeDir, nonce, pass);
    }
    finally
    {
        releaseSyncLock(storeDir, nonce);
    }
}

// What the one catch-up that may refuse is given: the ctrl-c the flow around it
// is watching for, and what each project is allowed before the pass is called
// stalled.
interface FirstPass
{
    cancel?: Cancellation;
    each?: number;
}

async function firstSync(storeDir: string, nonce: string, pass: FirstPass): Promise<void>
{
    const each = pass.each ?? PULLER_LEASE_MS;
    // Set before the session is opened, so the project list request is inside
    // the first project's allowance rather than outside every bound there is.
    const until = Date.now() + each;
    const session = openSession(storeDir);
    refuseUnlisted(await reconcile(storeDir, session, nonce));
    const walk = await walkSlugs(storeDir, session, nonce, { until, each, strict: true, cancel: pass.cancel });
    if (!walk.reached)
    {
        throw unreachable();
    }
    if (walk.left > 0)
    {
        throw shortfall(walk.left);
    }
}

// A pass that answered throughout and still did not reach every project:
// somebody interrupted it, or it stopped getting through them — a project that
// took longer on its own than the whole of `PULLER_LEASE_MS`, which is a
// workspace that has stopped answering usefully rather than a large one.
//
// Either way the store holds some of the workspace's projects and not others,
// and the design's rule for this flow is that there is no half state — so it is
// a refusal and the flow removes the directory, rather than a store whose
// missing projects would each be discovered by a later command failing
// somewhere further from the cause.
//
// A large workspace does not reach this. The bound is per project and moves
// with the work, so a walk that keeps finishing projects keeps going however
// many there are; what a flat bound made of this sentence was a size of
// workspace no retry could ever get past, since every retry began again from
// an empty store and stopped at the same place.
function shortfall(left: number): CliError
{
    return new CliError("this machine reached its workspace but stopped getting through it — "
        + `${left} of its projects were not read, none of them within the time one project is given, so nothing `
        + "was created; a store holds all of a workspace's records or none of them, and running `self init --cloud` "
        + "again starts the catch-up over");
}

// The project list, which is the request that says whether this machine is a
// member of the workspace it just named. The workspace API answers one
// indistinguishable 404 for a non-member, a call outside its scopes and a
// workspace that is not there (C1 invariant 3), so the sentence names all three
// rather than picking one it cannot know.
function refuseUnlisted(answer: ApiAnswer): void
{
    if (!answer.reached)
    {
        throw unreachable();
    }
    if (answer.status === 404)
    {
        throw new CliError("the workspace server has no such workspace for this machine — check the id, and "
            + "check that this machine is signed in as an account that is a member of it with `self login`");
    }
    if (answer.status !== 200)
    {
        throw new CliError(`the workspace server answered ${answer.status} when asked for this workspace's projects, `
            + "so nothing was created");
    }
    // A 200 carrying something other than a list is not an empty workspace.
    // `reconcile` reconciles nothing against it and the walk below would then
    // find no projects and report a finished catch-up — a store reported as
    // filled from a workspace this CLI never actually read.
    if (!Array.isArray(answer.body))
    {
        throw new CliError("the workspace server answered this workspace's project list in a shape this CLI cannot "
            + "read, so nothing was created — update `superself`, and tell whoever runs that server");
    }
}

function unreachable(): CliError
{
    return new CliError("this machine could not reach the workspace server, so nothing was created — "
        + "a store is attached to a workspace that answered, never to one that might be there");
}
