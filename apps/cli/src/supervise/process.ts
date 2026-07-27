import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { localDir, readLocalJson, writeLocalJsonDurable } from "./local.js";

// A pid on its own identifies nothing. The kernel reuses it, so a record that
// says "pid 412" can come back after a reboot pointing at somebody else's
// process — which is how a supervisor ends up reporting a finished attempt as
// running forever, or worse, sending a cancellation to a stranger. A reference
// is a pid plus the three things that make it unambiguous: which machine,
// which boot of it, and when the process itself started.
export interface ProcessRef
{
    pid: number;
    nodeId: string;
    bootId: string;
    // The OS-reported start time. Two processes on one boot can share a pid
    // only in sequence, never at the same instant, so this separates them.
    startedAt: string | null;
}

// A launch owns a process group, not a process. Spawning detached puts the
// wrapper in a session of its own, so its pid is also the group id and every
// descendant that does not deliberately leave the session stays countable
// after the wrapper itself is gone. That is what makes "the run is over" an
// observation the kernel answers rather than a claim somebody writes down.
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
    // Null where the group was not minted by a launch of this supervisor's,
    // and then no member can be qualified this way.
    startedAt: string | null;
}

const LINUX_BOOT = "/proc/sys/kernel/random/boot_id";

let cachedNode: string | null = null;
let cachedBoot: string | null = null;
let cachedGroup: number | null = null;

// Generated, not derived from the hostname: this is a machine-local
// diagnostic and there is no reason for it to carry the machine's name. It
// lives beside the journal, so a machine that loses one loses both and no
// reference outlives the records that mention it.
export function nodeId(storeDir: string): string
{
    if (cachedNode !== null)
    {
        return cachedNode;
    }
    const file = join(localDir(storeDir), "node.json");
    const existing = readLocalJson<{ nodeId: string }>(file);
    if (typeof existing?.nodeId === "string" && existing.nodeId !== "")
    {
        cachedNode = existing.nodeId;
        return cachedNode;
    }
    cachedNode = randomBytes(8).toString("hex");
    writeLocalJsonDurable(file, { nodeId: cachedNode });
    return cachedNode;
}

// One identity per boot of this machine. Every pid and every process group id
// recorded before it belongs to a machine that no longer exists, and a restart
// is the one observation that ends a process tree with certainty.
export function bootId(storeDir: string): string
{
    cachedBoot = cachedBoot ?? publishedBoot() ?? derivedBoot(storeDir);
    return cachedBoot;
}

// Linux publishes a per-boot uuid and macOS publishes the boot instant. Both
// are exact and both survive suspend, which a reading taken from uptime does
// not always do.
function publishedBoot(): string | null
{
    if (existsSync(LINUX_BOOT))
    {
        return `boot-${readFileSync(LINUX_BOOT, "utf8").trim()}`;
    }
    const boottime = run("sysctl", ["-n", "kern.boottime"]);
    const seconds = boottime === null ? null : /sec\s*=\s*(\d+)/.exec(boottime);
    return seconds === null ? null : `boot-${seconds[1]}`;
}

// Where the kernel publishes neither, the boot instant is derived from uptime
// and pinned in the local directory. The derivation drifts by a second or two
// as clocks are corrected, so a reading close to the pinned one is the same
// boot and a reading far from it is a machine that has restarted since.
function derivedBoot(storeDir: string): string
{
    const stamp = Math.round(Date.now() / 1000 - uptime());
    const file = join(localDir(storeDir), "boot.json");
    const pinned = readLocalJson<{ bootId: string; stamp: number }>(file);
    if (typeof pinned?.bootId === "string" && Math.abs(pinned.stamp - stamp) <= 5)
    {
        return pinned.bootId;
    }
    const fresh = `boot-${randomBytes(6).toString("hex")}`;
    writeLocalJsonDurable(file, { bootId: fresh, stamp });
    return fresh;
}

function run(command: string, args: string[]): string | null
{
    try
    {
        return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    }
    catch
    {
        return null;
    }
}

export function processStartTime(pid: number): string | null
{
    const listed = run("ps", ["-p", String(pid), "-o", "lstart="]);
    return listed === null || listed.trim() === "" ? null : listed.trim();
}

export function processGroup(pid: number): number | null
{
    const listed = run("ps", ["-p", String(pid), "-o", "pgid="]);
    const pgid = listed === null ? Number.NaN : Number.parseInt(listed.trim(), 10);
    return Number.isFinite(pgid) && pgid > 0 ? pgid : null;
}

export function processRef(storeDir: string, pid: number): ProcessRef
{
    return { pid, nodeId: nodeId(storeDir), bootId: bootId(storeDir), startedAt: processStartTime(pid) };
}

export function ownedTree(storeDir: string, attempt: string, fence: number, pgid: number, startedAt: string | null): OwnedTree
{
    return { pgid, nodeId: nodeId(storeDir), bootId: bootId(storeDir), attempt, fence, startedAt };
}

// The wrapper is spawned with a marker naming its own launch written into its
// command line, so the group can be found in the process table by a string no
// other launch on this machine carries. That is what closes the window between
// spawn and the wrapper's very first write: the group is recovered from the
// kernel rather than from a file that may not exist yet.
export function groupByCommand(needle: string): number | null
{
    const table = run("ps", ["-A", "-ww", "-o", "pgid=,command="]);
    if (table === null)
    {
        return null;
    }
    const groups = new Set<number>();
    for (const line of table.split("\n"))
    {
        const fields = /^\s*(\d+)\s+(\S.*)$/.exec(line);
        if (fields !== null && fields[2].includes(needle))
        {
            groups.add(Number.parseInt(fields[1], 10));
        }
    }
    const found = [...groups].filter((pgid) => !foreign(pgid));
    // Two groups carrying one launch's marker is not an ownership this machine
    // can settle, and adopting the wrong one would mean signalling a stranger.
    return found.length === 1 ? found[0] : null;
}

// A record from another machine, or from a boot that has ended, is answered
// rather than probed: probing it would read whatever holds that number now.
function local(storeDir: string, ref: { nodeId: string; bootId: string }): boolean
{
    return ref.nodeId === nodeId(storeDir) && ref.bootId === bootId(storeDir);
}

// The group this process is itself in is never an attempt's tree. Signalling
// it would reach the supervisor, and the shell that started the supervisor.
function foreign(pgid: number): boolean
{
    cachedGroup = cachedGroup ?? processGroup(process.pid) ?? process.pid;
    return pgid <= 1 || pgid === cachedGroup;
}

// Alive means "the same process is still there", not "some process holds that
// number". A pid whose start time has moved is a different process wearing a
// recycled number.
export function refAlive(storeDir: string, ref: ProcessRef | null): boolean
{
    if (ref === null || !local(storeDir, ref))
    {
        return false;
    }
    try
    {
        process.kill(ref.pid, 0);
    }
    catch (error)
    {
        if ((error as NodeJS.ErrnoException).code !== "EPERM")
        {
            return false;
        }
    }
    if (ref.startedAt === null)
    {
        return true;
    }
    const started = processStartTime(ref.pid);
    return started === null || started === ref.startedAt;
}

// Whether anything in the launch's process group is still running. A pid is
// reusable the moment its process is reaped, but the system may not hand out a
// process group id while any member of that group exists — so for as long as
// the answer here is yes, the group being asked about is this launch's.
export function treeAlive(storeDir: string, tree: OwnedTree | null): boolean
{
    if (tree === null || !local(storeDir, tree) || foreign(tree.pgid))
    {
        return false;
    }
    try
    {
        process.kill(-tree.pgid, 0);
        return true;
    }
    catch (error)
    {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

// ps reports whole seconds and a descendant can be stamped in the same second
// the launch was journalled, so the comparison is given a little slack — in
// the direction that keeps a real member rather than drops one.
const START_SKEW_MS = 2_000;

// Nothing a launch started can have started before the launch did. A process
// carrying the group's number but older than the launch is therefore a
// stranger who was handed the number after this group emptied, and counting it
// would hold the attempt out of settlement forever and aim the containment
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

// The pids still in the group, so a refusal to settle can say how much of the
// run is still running rather than only that something is. Null when the
// process table cannot be read at all, which is not the same answer as none.
export function treeMembers(storeDir: string, tree: OwnedTree | null): number[] | null
{
    if (tree === null || !local(storeDir, tree) || foreign(tree.pgid))
    {
        return [];
    }
    const table = run("ps", ["-A", "-o", "pid=,pgid=,lstart="]);
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

// Signalling is refused unless the reference still resolves to the same
// process, so a cancelled attempt can never terminate whatever inherited its
// pid in the meantime.
export function refTerminate(storeDir: string, ref: ProcessRef | null, signal: NodeJS.Signals): boolean
{
    if (!refAlive(storeDir, ref) || ref === null)
    {
        return false;
    }
    try
    {
        process.kill(ref.pid, signal);
        return true;
    }
    catch
    {
        return false;
    }
}

// The whole group, not the wrapper alone: a run that left a background process
// behind is contained by signalling everything that inherited its session.
// Nothing is signalled unless the group still holds a member that started with
// this launch, so the same qualification that guards the liveness answer also
// guards the signal — a group id handed on after this launch emptied it never
// receives this launch's containment.
export function treeTerminate(storeDir: string, tree: OwnedTree | null, signal: NodeJS.Signals): boolean
{
    if (tree === null || !treeHolds(storeDir, tree))
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

// Whether the group still holds something this launch put there. Where the
// process table cannot be read at all, the signal probe is the only answer
// available and a group that answers it is held rather than assumed finished.
function treeHolds(storeDir: string, tree: OwnedTree): boolean
{
    const members = treeMembers(storeDir, tree);
    return members === null ? treeAlive(storeDir, tree) : members.length > 0;
}
