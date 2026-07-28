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
    // When the launch that owns this group happened. A group id is only
    // reserved while the group has members, so a group that empties can have
    // its number handed to somebody else — and the one thing that tells the
    // two apart is that nothing this launch started can predate the launch.
    // Null where the process table could not answer, and then no member can be
    // qualified this way.
    startedAt: string | null;
}

let cachedGroup: number | null = null;

export function ownedTree(attempt: string, fence: number, pgid: number, startedAt: string | null): OwnedTree
{
    return { pgid, nodeId: nodeId(), bootId: bootId(), attempt, fence, startedAt };
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
    const members: number[] = [];
    for (const line of table.split("\n"))
    {
        const fields = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
        if (fields !== null && Number.parseInt(fields[2], 10) === tree.pgid && startedWithLaunch(tree, fields[3]))
        {
            members.push(Number.parseInt(fields[1], 10));
        }
    }
    return members;
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
