// How large the store is, and the one maintenance act that makes it smaller.
//
// The store is a git repository whose every event is a commit and whose
// artifacts are files committed beside them. Nothing ever measured it and
// nothing ever compacted it: one workspace reached 356 MB of working tree and
// 220 MB of `.git`, with 146 MiB of loose objects against a 67 MiB pack —
// which is what a repository that has never been repacked looks like (#239).
// A person found that out by running `du`, and nobody runs `du`.
//
// Two verbs and one signal. `store size` says what is there, including the
// bytes no live record names; `store compact` runs git's own maintenance; and
// `sync` — already slow, already deliberate — says one line when the loose
// objects have outgrown the pack.
//
// What is deliberately not here: any deletion. `store size` reports orphaned
// bytes and removes none of them, because a file no event names is
// indistinguishable from a file another report is staging right now, and
// losing stored bytes is the one mistake ingestion cannot undo. Compaction is
// `git gc` and nothing else — never a history rewrite, which would break every
// other clone of a store that syncs, and never `git repack -a -d`, which
// deletes unreachable objects in a previous pack outright instead of leaving
// them the two-week grace `gc` gives them.
import { Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { artifactDigest } from "./artifact.js";
import { branch, Command, leaf } from "./contract.js";
import { git, gitPatient } from "./gitutil.js";
import { readRegistry, requireWorkspace } from "./paths.js";
import { listArtifacts } from "./registry.js";
import { plural } from "./style.js";
import { ArtifactMeta, CliError, CommandOutput, JsonValue } from "./types.js";

// How many rows the size answer shows of a list that has no bound: the largest
// projects, the largest files, the orphans. Enough to act on, never a listing
// of a store's whole contents — `self artifact list` is that.
const TOP = 5;

interface FileSize
{
    // Posix, relative to the store directory, so it reads the same on every
    // machine and can be compared with a recorded artifact path directly.
    path: string;
    bytes: number;
}

interface Named
{
    name: string;
    bytes: number;
}

interface ObjectCounts
{
    loose: number;
    looseBytes: number;
    packBytes: number;
}

interface Orphans
{
    files: number;
    bytes: number;
    top: Named[];
}

interface StoreSize
{
    worktreeBytes: number;
    gitBytes: number;
    artifacts: number;
    distinct: number;
    artifactBytes: number;
    storedFiles: number;
    projects: Named[];
    largest: Named[];
    orphans: Orphans;
    objects: ObjectCounts;
}

function storeSize(storeDir: string): StoreSize
{
    const records = listArtifacts(storeDir, readRegistry(storeDir).map((entry) => entry.slug));
    // Live records only. A pruned record still names the path it was stored at,
    // and counting that as "named" would hide the exact state the removal order
    // exists to survive: the event is durable and the bytes were not removed
    // (#239 §3.5). Where another live record shares the path, that record names
    // it and nothing is orphaned.
    const named = new Set(records.filter((record) => record.pruned === undefined).map((record) => record.path));
    const files = walkFiles(join(storeDir, "artifacts"), "artifacts/");
    const owned = files.filter((file) => named.has(ownerPath(file.path)));
    return {
        worktreeBytes: treeBytes(storeDir, ".git"),
        gitBytes: treeBytes(join(storeDir, ".git")),
        artifacts: records.length,
        distinct: distinctContents(records),
        artifactBytes: total(owned),
        storedFiles: owned.length,
        projects: top(grouped(owned, (file) => file.path.split("/")[1])),
        largest: top(owned.map((file) => ({ name: file.path, bytes: file.bytes }))),
        orphans: orphanBytes(files, named),
        objects: countObjects(storeDir)
    };
}

// Bytes under `artifacts/` that no record of any registered project names.
// Two states produce them and neither is a defect this module may act on: a
// process killed between an ingest's copies and its event, and an `artifact
// prune` whose event was recorded and whose byte removal then failed (#239).
// Both are surplus rather than loss, and both are reported until someone
// decides.
//
// Not deleted here, and no verb deletes them: bytes another command is staging
// this second look exactly like these.
function orphanBytes(files: FileSize[], named: Set<string>): Orphans
{
    const loose = files.filter((file) => !named.has(ownerPath(file.path)));
    const byOwner = grouped(loose, (file) => ownerPath(file.path));
    return { files: loose.length, bytes: total(loose), top: top(byOwner) };
}

// The artifact a stored file belongs to: `artifacts/<slug>/<entry>`, whether
// that entry is one file or the root of a bundle. A record names exactly this,
// so it is the granularity at which a file is owned or orphaned — one member
// of a bundle is never an orphan on its own.
function ownerPath(path: string): string
{
    return path.split("/").slice(0, 3).join("/");
}

// How many different things are stored, as against how many records point at
// them: the gap between the two is what the reuse of stored bytes closes. A
// bundle counts by its manifest hash, a file by its own, and a record from
// before digests were kept counts as its own content rather than as a twin of
// every other undigested one.
function distinctContents(records: ArtifactMeta[]): number
{
    const hashes = new Set<string>();
    for (const record of records)
    {
        const digest = artifactDigest(record);
        hashes.add(digest === undefined || digest === "" ? record.id : digest);
    }
    return hashes.size;
}

function total(files: FileSize[]): number
{
    return files.reduce((sum, file) => sum + file.bytes, 0);
}

function grouped(files: FileSize[], keyOf: (file: FileSize) => string): Named[]
{
    const sums = new Map<string, number>();
    for (const file of files)
    {
        sums.set(keyOf(file), (sums.get(keyOf(file)) ?? 0) + file.bytes);
    }
    return [...sums].map(([name, bytes]) => ({ name, bytes }));
}

function top(named: Named[]): Named[]
{
    return [...named].sort((left, right) => right.bytes - left.bytes).slice(0, TOP);
}

/* ── what is on the disk ───────────────────────────────────────────── */

// Regular files only, and no link is followed: a symlink is neither counted as
// its target's bytes nor descended into, so no measurement can walk out of the
// store or count one file twice.
function walkFiles(dir: string, prefix: string): FileSize[]
{
    if (!existsSync(dir))
    {
        return [];
    }
    const found: FileSize[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }))
    {
        if (entry.isDirectory())
        {
            found.push(...walkFiles(join(dir, entry.name), `${prefix}${entry.name}/`));
        }
        else if (entry.isFile())
        {
            found.push({ path: `${prefix}${entry.name}`, bytes: statSync(join(dir, entry.name)).size });
        }
    }
    return found;
}

// The same walk that never builds the list. `.git` holds a file per loose
// object — tens of thousands of them in the store this was written for — and
// the answer is one number.
//
// Every read of the tree goes through `ignoringGone`, because `.git` is a
// directory git is editing while this walks it: a lock file, a loose object
// just packed, a whole `objects/pack` directory being rewritten (#396).
function treeBytes(dir: string, skip?: string): number
{
    if (!existsSync(dir))
    {
        return 0;
    }
    let bytes = 0;
    for (const entry of ignoringGone(() => readdirSync(dir, { withFileTypes: true }), [] as Dirent[]))
    {
        if (entry.name === skip)
        {
            continue;
        }
        if (entry.isDirectory())
        {
            bytes += treeBytes(join(dir, entry.name));
        }
        else if (entry.isFile())
        {
            bytes += ignoringGone(() => statSync(join(dir, entry.name)).size, 0);
        }
    }
    return bytes;
}

// An entry that vanished between the listing and the read of it. git's own
// maintenance deletes files under `.git` whenever it likes, and a measurement
// that fails because one of them went is a command lost to a race no one can
// avoid: the bytes are gone or moving, and either way zero is the honest
// answer for them.
//
// ENOENT alone. A permission that changed, a file standing where a directory
// belongs, a failing device — those are not an entry disappearing, and a
// number that quietly omitted them would be wrong rather than late.
export function ignoringGone<T>(read: () => T, gone: T): T
{
    try
    {
        return read();
    }
    catch (error)
    {
        // Optional: what a rejected read throws is the platform's to decide,
        // and reading `.code` off a thrown null would replace the real failure
        // with a TypeError about this line.
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
        {
            return gone;
        }
        throw error;
    }
}

// git's own count, in git's own units: `count-objects -v` reports sizes in
// KiB. Asked rather than derived from a walk, because the question compaction
// answers is about objects and packs, not about bytes on a filesystem — and
// because it is one process against a tree walk of a 220 MB directory.
function countObjects(storeDir: string): ObjectCounts
{
    const counted = git(storeDir, "count-objects", "-v");
    const field = (name: string): number =>
    {
        const found = counted.out.split("\n").find((line) => line.startsWith(`${name}: `));
        return found === undefined ? 0 : Number(found.slice(name.length + 2).trim());
    };
    return { loose: field("count"), looseBytes: field("size") * 1024, packBytes: field("size-pack") * 1024 };
}

/* ── the signal ────────────────────────────────────────────────────── */

// Loose objects outweighing the pack is what a repository that has never been
// repacked looks like, and it is the one measurement cheap enough to take
// where nobody asked for it: `count-objects` reads git's own bookkeeping and
// walks no tree.
//
// It is said by `sync` and by nothing else. The store's size is a workspace
// fact while `self status` answers per project, so a health signal would
// repeat the same line once per project; `sync` is already slow, already
// deliberate, and already the command a person runs when the store is on their
// mind.
export function compactionSignal(storeDir: string): string | null
{
    const objects = countObjects(storeDir);
    if (objects.looseBytes <= objects.packBytes || objects.loose === 0)
    {
        return null;
    }
    return `store history: ${objects.loose} loose objects (${human(objects.looseBytes)}) against a ${human(objects.packBytes)} pack `
        + "— run `self store compact` to pack them";
}

/* ── compaction ────────────────────────────────────────────────────── */

// `git gc -q`, once, and nothing else — the whole of what this verb does, and
// the reason it belongs to a step with no irreversible act in it.
//
// `gc` moves unreachable objects into a cruft pack with a two-week expiry
// rather than deleting them, so nothing this command does is a loss even when
// a concurrent command's fresh objects are momentarily unreferenced. The
// options that would change that are not choices this module makes: not
// `--prune=now`, which drops that grace, and not `git repack -a -d`, whose
// own manual defines `-A` as the option that *prevents* unreachable objects in
// a previous pack from being deleted immediately.
//
// History is never rewritten. The store syncs between machines by rebase, and
// a rewrite would break every other clone of it — so the bytes a large
// artifact left in the history stay there, and this receipt says so rather
// than letting a reader believe a deletion could reclaim them.
function compactStore(storeDir: string): CommandOutput
{
    const before = { bytes: treeBytes(join(storeDir, ".git")), objects: countObjects(storeDir) };
    // Repacking a long history is minutes of work on a large store, and a
    // person ran this verb on purpose to wait for it — the tight local bound
    // every other call gets would cut it off partway.
    const packed = gitPatient(storeDir, "gc", "-q");
    if (!packed.ok)
    {
        throw new CliError(`store compact failed: ${packed.err === "" ? "git could not be run" : packed.err}`);
    }
    const after = { bytes: treeBytes(join(storeDir, ".git")), objects: countObjects(storeDir) };
    return [
        { kind: "receipt", text: `history compacted — .git ${human(before.bytes)} → ${human(after.bytes)}, `
            + `loose objects ${before.objects.loose} → ${after.objects.loose}` },
        { kind: "receipt", text: "unreachable objects are kept for two weeks, and history is never rewritten — "
            + "bytes an artifact left in the history stay there" }
    ];
}

/* ── the command ───────────────────────────────────────────────────── */

export const STORE_COMMAND: Command = {
    name: "store",
    usage: [
        { syntax: "store size [--json]", description: ["how large the store is, and what is driving it"], verbs: ["size"] },
        { syntax: "store compact", description: ["pack the store's git history with `git gc`"], verbs: ["compact"] }
    ],
    detail: [
        "measure the workspace store, and compact the history that carries it.",
        "",
        "`size` counts the working tree, `.git`, and the artifacts a record names,",
        "and reports orphan bytes — files under `artifacts/` that no record names.",
        "It deletes nothing: a file no event names cannot be told apart from one",
        "another report is staging right now.",
        "",
        "`compact` runs `git gc` once. It never rewrites history, so every other",
        "clone of the store keeps working, and unreachable objects keep git's",
        "default two-week grace.",
        "",
        "  --json    the measurement as a machine-readable object"
    ],
    node: branch({
        name: "store",
        unnamed: "refuse",
        refusal: "usage: self store size [--json] | compact",
        children: [
            leaf("size", { json: { type: "boolean" } }, 0, () => sizeAnswer(requireWorkspace(process.cwd()).storeDir)),
            leaf("compact", {}, 0, () => compactStore(requireWorkspace(process.cwd()).storeDir))
        ]
    })
};

function sizeAnswer(storeDir: string): CommandOutput
{
    const size = storeSize(storeDir);
    return [{ kind: "payload", data: size as unknown as JsonValue, plain: () => sizeLines(size) }];
}

function sizeLines(size: StoreSize): string[]
{
    return [
        `store ${human(size.worktreeBytes + size.gitBytes)} — working tree ${human(size.worktreeBytes)}, `
            + `.git ${human(size.gitBytes)}`,
        `artifacts: ${size.artifacts} recorded, ${size.distinct} distinct contents, `
            + `${human(size.artifactBytes)} in ${plural(size.storedFiles, "stored file")}`,
        ...namedLines("largest projects", size.projects),
        ...namedLines("largest files", size.largest),
        ...orphanLines(size.orphans),
        ...objectLines(size.objects),
        "compacting packs the history; it never rewrites it, so bytes already in the history stay there"
    ];
}

function namedLines(label: string, named: Named[]): string[]
{
    return named.length === 0 ? [] : [`${label}: ${named.map((item) => `${item.name} ${human(item.bytes)}`).join(", ")}`];
}

function orphanLines(orphans: Orphans): string[]
{
    if (orphans.files === 0)
    {
        return ["orphan bytes: none — every stored file is named by a record"];
    }
    return [
        `orphan bytes: ${plural(orphans.files, "file")} no record names (${human(orphans.bytes)}), `
            + "reported and not removed",
        `  ${orphans.top.map((item) => `${item.name} ${human(item.bytes)}`).join(", ")}`
    ];
}

function objectLines(objects: ObjectCounts): string[]
{
    const line = `git objects: ${objects.loose} loose (${human(objects.looseBytes)}), pack ${human(objects.packBytes)}`;
    return objects.looseBytes > objects.packBytes && objects.loose > 0
        ? [`${line} — run \`self store compact\``]
        : [line];
}

const UNITS = [["GB", 1024 ** 3], ["MB", 1024 ** 2], ["KB", 1024]] as const;

// Powers of 1024 under the shorter names: the same base `du -h` and git's own
// `count-objects` use, so a person comparing this answer with either of them
// is not reading two opinions about one directory.
function human(bytes: number): string
{
    const unit = UNITS.find(([, size]) => bytes >= size);
    return unit === undefined ? `${bytes} B` : `${(bytes / unit[1]).toFixed(1)} ${unit[0]}`;
}
