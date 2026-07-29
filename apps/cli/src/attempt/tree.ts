import { execFileSync } from "node:child_process";
import { bootId, nodeId } from "./boundary.js";

// A launch owns a process group, not a process. A launcher that starts its
// payload detached puts it in a session of its own, so the payload's pid is
// also the group id and every descendant that does not deliberately leave the
// session stays countable after the payload itself is gone. That is what makes
// "the run is over" an observation the kernel answers rather than a claim
// somebody wrote down.
export interface OwnedTree
{
    pgid: number;
    nodeId: string;
    bootId: string;
    // The launch the group was minted for. A group carried over from an
    // earlier fence belongs to a previous run and is never this one's.
    attempt: string;
    fence: number;
    // The claimed payload itself: its pid, and when the process table said it
    // started. The instant refuses two impostors at once — a member older
    // than the launch is a pre-existing sibling in a shared group, and a
    // process wearing the payload's own pid at a different instant is a
    // reused pid, not the payload. Null where the table could not answer,
    // and then no member can be qualified this way.
    pid: number;
    startedAt: string | null;
    // When the process leading the group started. A group id is only
    // reserved while the group has members, so a group that empties can have
    // its number handed to somebody else — and everything in that new group
    // starts after this launch, so ordering alone cannot refuse it. What a
    // new group cannot fake is its leader: a group with id N is created by a
    // process with pid N, so a leader holding this number who did not start
    // when the recorded one did is a new group wearing this launch's number.
    leaderStartedAt: string | null;
}

let cachedGroup: number | null = null;

export function ownedTree(attempt: string, fence: number, pid: number, pgid: number, startedAt: string | null, leaderStartedAt: string | null): OwnedTree
{
    return { pgid, nodeId: nodeId(), bootId: bootId(), attempt, fence, pid, startedAt, leaderStartedAt };
}

// Whether a pid holds a running process at all. A pid this process may not
// signal is still a pid something holds, which is why EPERM is alive.
export function alive(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (error)
    {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

export function processStartTime(pid: number): string | null
{
    const listed = ps(["-p", String(pid), "-o", "lstart="]);
    return listed === null || listed.trim() === "" ? null : listed.trim();
}

export function processGroup(pid: number): number | null
{
    const listed = ps(["-p", String(pid), "-o", "pgid="]);
    const pgid = listed === null ? Number.NaN : Number.parseInt(listed.trim(), 10);
    return Number.isFinite(pgid) && pgid > 0 ? pgid : null;
}

// Whether the group still holds something this launch put there. Where the
// process table cannot be read at all, the signal probe is the only answer
// available and a group that answers it is held rather than assumed finished —
// but then the recycled-group guard cannot be applied either, so the fallback
// is stated rather than hidden.
export function treeAlive(tree: OwnedTree | null): boolean
{
    if (tree === null || !local(tree) || foreign(tree.pgid))
    {
        return false;
    }
    const members = treeMembers(tree);
    return members === null ? groupAnswers(tree.pgid) : members.length > 0;
}

// The whole group, not the launched process alone: a run that left a
// background process behind is contained by signalling everything that
// inherited its session. Nothing is signalled unless the group still holds a
// member that started with this launch, so the same qualification that guards
// the liveness answer also guards the signal — a group id handed on after this
// launch emptied it never receives this launch's containment.
export function treeTerminate(tree: OwnedTree | null, signal: NodeJS.Signals): boolean
{
    if (tree === null || !treeAlive(tree))
    {
        return false;
    }
    try
    {
        process.kill(-tree.pgid, signal);
        return true;
    }
    catch
    {
        return false;
    }
}

// How long a group that ignored SIGTERM may take to close what it was writing
// before it is killed outright — the same grace the runner gives its own child.
const CONTAIN_GRACE_MS = 2_000;

const CONTAIN_POLL_MS = 50;

// Containment as an operation rather than a single signal: TERM first, KILL
// for whatever ignored it, and the pids still standing afterwards are the
// answer. A caller that gets any back must not treat the group as spent —
// releasing the work unit over a live group would seat a second owner beside
// the processes of the first.
export async function treeContain(tree: OwnedTree | null): Promise<number[]>
{
    for (const signal of ["SIGTERM", "SIGKILL"] as NodeJS.Signals[])
    {
        if (!treeAlive(tree))
        {
            return [];
        }
        treeTerminate(tree, signal);
        if (await drained(tree))
        {
            return [];
        }
    }
    return treeMembers(tree) ?? [];
}

async function drained(tree: OwnedTree | null): Promise<boolean>
{
    const deadline = Date.now() + CONTAIN_GRACE_MS;
    while (Date.now() < deadline)
    {
        if (!treeAlive(tree))
        {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, CONTAIN_POLL_MS));
    }
    return false;
}

// The pids still in the group, so a refusal to settle can say how much of the
// run is still running rather than only that something is. Null when the
// process table cannot be read at all, which is not the same answer as none.
export function treeMembers(tree: OwnedTree | null): number[] | null
{
    if (tree === null || !local(tree) || foreign(tree.pgid))
    {
        return [];
    }
    const table = ps(["-A", "-o", "pid=,pgid=,lstart="]);
    if (table === null)
    {
        return null;
    }
    const rows: TableRow[] = [];
    for (const line of table.split("\n"))
    {
        const fields = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
        if (fields !== null)
        {
            rows.push({ pid: Number.parseInt(fields[1], 10), pgid: Number.parseInt(fields[2], 10), lstart: fields[3].trim() });
        }
    }
    if (groupRecycled(tree, rows))
    {
        return [];
    }
    return rows
        .filter((row) => row.pgid === tree.pgid && startedWithLaunch(tree, row.lstart) && !reusedPayloadPid(tree, row))
        .map((row) => row.pid);
}

interface TableRow
{
    pid: number;
    pgid: number;
    lstart: string;
}

// The one identity a recycled group cannot fake. Every process in a group
// handed out after this launch emptied it starts after the launch, so the
// ordering guard below passes all of them — but a group with id N is created
// by a process with pid N, and a leader holding this number who started at a
// different instant than the recorded one is a new group wearing the old
// number. A leader that is merely gone proves nothing either way: the group
// id stays reserved while any member remains, so members without a leader
// are this launch's own survivors.
function groupRecycled(tree: OwnedTree, rows: TableRow[]): boolean
{
    const recorded = tree.leaderStartedAt ?? null;
    if (recorded === null)
    {
        return false;
    }
    const leader = rows.find((row) => row.pid === tree.pgid);
    return leader !== undefined && !sameInstant(leader.lstart, recorded);
}

// A process wearing the claimed payload's pid but started at another instant
// is whoever the kernel handed that number to after the payload died — never
// the payload.
function reusedPayloadPid(tree: OwnedTree, row: TableRow): boolean
{
    const recorded = tree.startedAt ?? null;
    return row.pid === tree.pid && recorded !== null && !sameInstant(row.lstart, recorded);
}

// ps reports lstart to the second, and the same process answers with the same
// second every time it is asked — the slack below only absorbs a parser that
// rendered the instant differently between the two reads.
function sameInstant(observed: string, recorded: string): boolean
{
    const left = Date.parse(observed.trim());
    const right = Date.parse(recorded.trim());
    if (Number.isFinite(left) && Number.isFinite(right))
    {
        return Math.abs(left - right) < 1_000;
    }
    return observed.trim() === recorded.trim();
}

// ps reports whole seconds and a descendant can be stamped in the same second
// the launch was recorded, so the comparison is given a little slack — in the
// direction that keeps a real member rather than drops one.
const START_SKEW_MS = 2_000;

// Nothing a launch started can have started before the launch did. A process
// carrying the group's number but older than the launch is therefore a
// stranger who was handed the number after this group emptied, and counting it
// would hold the attempt out of settlement for ever and aim the containment
// signal at somebody else.
function startedWithLaunch(tree: OwnedTree, lstart: string): boolean
{
    if (tree.startedAt === null)
    {
        return true;
    }
    const started = Date.parse(lstart.trim());
    return !Number.isFinite(started) || started >= Date.parse(tree.startedAt) - START_SKEW_MS;
}

// A record from another machine, or from a boot that has ended, is answered
// rather than probed: probing it would read whatever holds that number now.
function local(tree: OwnedTree): boolean
{
    return tree.nodeId === nodeId() && tree.bootId === bootId();
}

// The group this process is itself in is never an attempt's tree. Signalling
// it would reach the CLI, and the shell that started the CLI.
function foreign(pgid: number): boolean
{
    cachedGroup = cachedGroup ?? processGroup(process.pid) ?? process.pid;
    return pgid <= 1 || pgid === cachedGroup;
}

function groupAnswers(pgid: number): boolean
{
    try
    {
        process.kill(-pgid, 0);
        return true;
    }
    catch (error)
    {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function ps(args: string[]): string | null
{
    try
    {
        return execFileSync("ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    }
    catch
    {
        return null;
    }
}
