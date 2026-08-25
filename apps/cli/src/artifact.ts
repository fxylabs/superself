import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { branch, Command, leaf } from "./contract.js";
import { artifactId } from "./ids.js";
import { readEvents } from "./logfile.js";
import { notice } from "./output.js";
import { digestFile } from "./repo.js";
import { activeProjects, CliContext, readRegistry, requireWorkspace } from "./paths.js";
import { launchFile } from "./view.js";
import { ArtifactMember, ArtifactMeta, artifactName, artifactSearchText, CliError, CommandOutput, encodedPath } from "./types.js";

interface ArtifactRecord extends ArtifactMeta
{
    project: string;
    work?: string;
    ts: string;
    summary: string;
}

// Bytes already in the store, waiting for the event that names them. Nothing
// outside this module may keep them without writing that event.
interface StagedArtifacts
{
    artifacts: ArtifactMeta[];
    discard: () => void;
}

// A member on its way into the store: where its bytes come from — a file the
// reporter brought, or the text of the index this command generates — and the
// digest the copy fills in. Neither `source`, `text` nor `bytes` is ever
// recorded; `recorded` below states field for field what the event carries.
interface PlannedMember extends ArtifactMember
{
    source?: string;
    text?: string;
    bytes?: number;
}

interface PlannedArtifact extends ArtifactMeta
{
    source: string;
    members?: PlannedMember[];
    // Set when this artifact's bytes are already in the store — under another
    // artifact's path, or under one an earlier item of this same report is
    // about to write. Nothing is copied for it and nothing is staged in its
    // name: the rollback of a failed report must never reach bytes another
    // record points at.
    reused?: true;
    // The earlier item of this report whose copy will put those bytes there.
    // Only that item's copy fills in a digest, so the twin reads its own back
    // out of it when the event is composed.
    twin?: PlannedArtifact;
}

// What this command made, and nothing else. Rollback undoes its own work only:
// never a directory it found, never a file another report is writing.
interface Staging
{
    dirs: string[];
    files: string[];
}

// Every declared artifact is checked before any byte is written, and the whole
// set is removed again if one copy fails: a rejected report must leave the
// store exactly as it found it.
//
// A process killed between the copies and the event leaves those bytes behind.
// They are unreachable — every view reads artifacts from the log — and nothing
// sweeps them, because a file no event names is indistinguishable from a file
// another report is staging right now, and losing stored bytes is the one
// mistake this module cannot undo.
export function stageArtifacts(storeDir: string, slug: string, paths: string[] | undefined,
    entries: string[] | undefined = undefined): StagedArtifacts
{
    const entry = requireOneEntry(entries);
    if (paths === undefined || paths.length === 0)
    {
        assignEntry([], entry);
        return { artifacts: [], discard: () => {} };
    }
    const slugDir = artifactDir(storeDir, slug);
    const planned = planArtifacts(slug, paths);
    assignEntry(planned, entry);
    // After `assignEntry` and before a byte is written: the entry and — where
    // one is generated — the whole manifest are settled here, so what the
    // lookup hashes is what a copy would store, and nothing mutates a reused
    // item afterwards.
    adoptStored(storeDir, slug, planned);
    const staging: Staging = { dirs: createDirs(slugDir), files: [] };
    const discard = (): void => removeStaged(staging);
    const failure = copyPlanned(storeDir, planned, staging);
    if (failure !== null)
    {
        discard();
        throw failure;
    }
    return { artifacts: planned.map(recorded), discard };
}

// What the event carries, field for field. A single file records exactly the
// four fields it always did — the shape every reader written before bundles
// still folds — and a bundle records its manifest and entry in place of the
// digest it deliberately has none of.
//
// Where the digests come from is the one thing a shared path changes: a twin
// carries no copy of its own, so it reads them off the item whose copy filled
// them in. The id, the name and the entry stay its own.
function recorded(item: PlannedArtifact): ArtifactMeta
{
    const bytes = item.twin ?? item;
    if (item.members === undefined)
    {
        return { id: item.id, name: item.name, path: item.path, digest: bytes.digest };
    }
    return {
        id: item.id,
        name: item.name,
        path: item.path,
        entry: item.entry,
        members: (bytes.members ?? item.members).map((member) => member.generated === undefined
            ? { path: member.path, digest: member.digest }
            : { path: member.path, digest: member.digest, generated: member.generated })
    };
}

// One hash for the whole bundle is derived where something needs it and never
// stored: sha256 over the canonical manifest text, one line per member in path
// order. A stored field could contradict the manifest; a derived one cannot.
export function artifactDigest(meta: ArtifactMeta | undefined): string | undefined
{
    if (meta === undefined || meta.members === undefined)
    {
        return meta?.digest;
    }
    const manifest = meta.members.map((member) => `${member.digest}  ${member.path}\n`).join("");
    return createHash("sha256").update(manifest).digest("hex");
}

// The line appended to the log is what makes a report true, and that is the
// boundary this rollback respects. Bytes staged for an event that never
// reached the log go back out; bytes for an event that did reach it stay,
// whatever fails afterwards — folding, rendering, committing — because the next
// command folds and commits the store again, while nothing can bring back the
// file a durable report already names.
// Anything staged in the store, not artifacts alone: a spec generation crosses
// the same boundary — bytes written first, made real by the event that names
// them — and one rule about when those bytes may stay is better than two.
export function commitStaged(staged: { discard: () => void }, writeEvent: (recorded: () => void) => void): void
{
    let recorded = false;
    const markRecorded = (): void =>
    {
        recorded = true;
    };
    const failure = capture(() => writeEvent(markRecorded));
    if (failure === null)
    {
        return;
    }
    if (!recorded)
    {
        staged.discard();
    }
    throw failure;
}

// The slug reaches the filesystem here, and a registry entry is not a name this
// module may hand to `join` unchecked: anything but a single path segment would
// put a project's bytes outside the artifacts root, or on top of another
// project's. Such a report is refused rather than quietly bent into shape.
function artifactDir(storeDir: string, slug: string): string
{
    const root = join(storeDir, "artifacts");
    const dir = resolve(root, slug);
    const step = relative(root, dir);
    if (step === "" || step === ".." || step.includes(sep))
    {
        throw new CliError(`project "${slug}" cannot store artifacts — a project name must be a single path segment`);
    }
    return dir;
}

// mkdir reports only the topmost directory it had to make; every step from
// there down to the slug directory was made by this command too. Those are the
// only directories rollback may take back.
function createDirs(dir: string): string[]
{
    const top = mkdirSync(dir, { recursive: true });
    if (top === undefined)
    {
        return [];
    }
    const created: string[] = [];
    let current = dir;
    while (current === top || current.startsWith(top + sep))
    {
        created.push(current);
        if (current === top)
        {
            break;
        }
        current = dirname(current);
    }
    return created;
}

function planArtifacts(slug: string, paths: string[]): PlannedArtifact[]
{
    const sources = paths.map((path) => resolveDeclared(path));
    // Compared after the links are followed, and planned before they are: one
    // directory reached by two spellings is one path and is refused, while the
    // name and the walk still start from what the caller actually typed.
    requireDistinctSources(paths, sources.map((source) => realpathSync(source)));
    return sources.map((source, index) => planOne(slug, paths[index], source));
}

// The flag takes a relative path, so it is read against the directory the
// command ran in. `stat`, not `lstat`: naming a link to a directory ingests
// that directory, because following what the caller typed is what typing it
// means.
function resolveDeclared(path: string): string
{
    const source = resolve(path);
    if (!existsSync(source))
    {
        throw new CliError(`artifact "${path}" does not exist`);
    }
    return source;
}

// One source path may not be declared twice in one report, and no declared
// path may be inside another declared directory. Both spellings would store
// the same bytes under two ids and render the child as a sibling of the bundle
// that already contains it — the defect #362 removes.
function requireDistinctSources(paths: string[], sources: string[]): void
{
    sources.forEach((source, index) =>
    {
        if (sources.indexOf(source) !== index)
        {
            throw new CliError(`artifact "${paths[index]}" is declared twice in this report — one path is one artifact`);
        }
        const holder = sources.findIndex((other) => source.startsWith(other + sep));
        if (holder !== -1)
        {
            throw new CliError(`artifact "${paths[index]}" is inside "${paths[holder]}", which this report attaches as a bundle — the bundle already holds it, so declare it once`);
        }
    });
}

function planOne(slug: string, path: string, source: string): PlannedArtifact
{
    const id = artifactId();
    const name = basename(source);
    // Forward slashes: the path is persisted in the event and rendered into
    // view hrefs, so it must not vary by platform.
    const stored = `artifacts/${slug}/${id}-${name}`;
    if (statSync(source).isDirectory())
    {
        return { id, name, path: stored, source, members: planMembers(path, source) };
    }
    if (!isReadable(source))
    {
        throw new CliError(`artifact "${path}" cannot be read`);
    }
    requireFileBound(path, source);
    return { id, name, path: stored, source };
}

function planMembers(label: string, root: string): PlannedMember[]
{
    const walked = walkBundle(label, root, "").sort((left, right) => comparePaths(left.path, right.path));
    if (walked.length === 0)
    {
        // A report carrying an artifact satisfies the completion gate, so a
        // bundle with no bytes would close a work unit on evidence that does
        // not exist.
        throw new CliError(`artifact "${label}" holds no files to attach — a bundle is the files a directory holds, and \`.git\` is never one of them`);
    }
    requireBound(label, walked);
    requireDistinctMembers(label, walked.map((member) => member.path));
    return walked;
}

// Regular files are copied and directories are descended, and nothing else.
// Entries are read with `lstat`, so no link is followed: refusing by name is
// the only answer that neither drops a file the reporter named nor copies
// bytes from outside the tree they named.
function walkBundle(label: string, dir: string, prefix: string): PlannedMember[]
{
    const found: PlannedMember[] = [];
    for (const raw of readdirSync(dir, { encoding: "buffer" }).sort(Buffer.compare))
    {
        const name = requireRecordable(label, prefix, raw);
        found.push(...walkEntry(label, join(dir, name), `${prefix}${name}`));
    }
    return found;
}

// A `.git` directory is skipped at any depth, and it is the only skip: a
// repository is not a deliverable, and any wider ignore list would make the
// record's promise — the bundle is that directory — false.
function walkEntry(label: string, path: string, rel: string): PlannedMember[]
{
    const entry = lstatSync(path);
    if (entry.isDirectory())
    {
        return basename(path) === ".git" ? [] : walkBundle(label, path, `${rel}/`);
    }
    if (!entry.isFile())
    {
        throw new CliError(`artifact "${label}" holds "${rel}", which is not a regular file — a bundle copies files and descends directories, and a symlink, fifo, socket or device node is neither`);
    }
    if (!isReadable(path))
    {
        throw new CliError(`artifact "${label}" holds "${rel}", which cannot be read`);
    }
    return [{ path: rel, digest: "", source: path, bytes: entry.size }];
}

function requireRecordable(label: string, prefix: string, raw: Buffer): string
{
    const refusal = nameRefusal(raw);
    if (refusal !== null)
    {
        throw new CliError(`artifact "${label}" holds "${prefix}${raw.toString("utf8")}", which ${refusal}`);
    }
    return raw.toString("utf8");
}

// A member path is written into a JSONL event line, into fold documents and
// into HTML hrefs, and a member nobody can follow back to its bytes is worse
// than a refused report. Everything else records verbatim. Exported because
// the invalid-UTF-8 arm cannot be built on every filesystem, and a check the
// suite can only reach through the filesystem is a check that machine decides.
export function nameRefusal(raw: Buffer): string | null
{
    const name = raw.toString("utf8");
    if (!Buffer.from(name, "utf8").equals(raw))
    {
        return "is not a valid UTF-8 name, so nothing that reads the record could resolve it back to its bytes";
    }
    if (/[\u0000-\u001f\u007f]/.test(name))
    {
        return "holds a control character, which no event line, fold document or href can carry";
    }
    if (name.includes("\\"))
    {
        return "holds a backslash, which no event line, fold document or href can carry";
    }
    return null;
}

// Sorted by their UTF-8 bytes: readdir order varies by filesystem, and a
// manifest whose order varied by machine could not be compared across two
// clones of one store.
function comparePaths(left: string, right: string): number
{
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

// Two member paths that collide under case folding or under Unicode
// normalization refuse the bundle, on every filesystem. The check reads the
// planned paths, never what a copy happens to do: a case-sensitive filesystem
// takes `README.md` and `readme.md` happily, and the store is cloned to every
// machine the workspace syncs to, so the collision would land as a broken
// checkout on the first default macOS clone. Equality folds case over the NFC
// form of each segment, because macOS writes decomposed names and Linux writes
// whatever the tool wrote. The path is **stored** as it was read: a normalized
// path would name a file the machine it came from does not have.
export function foldedCollision(paths: string[]): [string, string] | null
{
    const seen = new Map<string, string>();
    for (const path of paths)
    {
        const key = path.split("/").map(folded).join("/");
        const twin = seen.get(key);
        if (twin !== undefined)
        {
            return [twin, path];
        }
        seen.set(key, path);
    }
    return null;
}

// The one letter the fold below must not touch: Turkish **dotless** `ı`.
// Uppercasing it gives plain `I`, so a round trip through the upper case would
// fold `kisı.md` onto `kisi.md` — two files on macOS and on Linux both, and
// two that Unicode case folding keeps apart. Held out of the pass and compared
// as itself, which is the Turkish-i pitfall answered rather than walked into.
//
// Dotted `İ` is **not** held out, and the distinction is the whole of the
// pitfall: default full case folding maps it to `i` + U+0307, not to a letter
// of its own, and macOS agrees — `İx.md` and `i̇x.md` are one file there. Held
// out, it would let a bundle carrying both spellings pass this check on Linux
// and break the first macOS clone's checkout, which is the harm rule 8 exists
// to prevent.
const DOTLESS_I = /([ı])/;

// Full case folding, which is what a case-insensitive filesystem compares by
// and what `toLowerCase` alone is not: lowercasing leaves `straße` and
// `STRASSE` apart, and macOS holds only one of them. Upper-then-lower is how
// the standard library reaches the fold — uppercasing expands `ß` to `SS`, `ſ`
// to `S`, `ﬁ` to `FI` — and the NFC form goes in first so a decomposed name
// folds with its composed twin.
function folded(step: string): string
{
    // A capturing split, so the odd positions are the held-out letters
    // themselves and the even ones are everything the pass may have.
    return step.normalize("NFC").split(DOTLESS_I)
        .map((part, index) => index % 2 === 0 ? part.toLowerCase().toUpperCase().toLowerCase() : part)
        .join("");
}

function requireDistinctMembers(label: string, paths: string[]): void
{
    const collision = foldedCollision(paths);
    if (collision !== null)
    {
        throw new CliError(`artifact "${label}" holds "${collision[0]}" and "${collision[1]}", which are one path once case and Unicode normalization are folded — `
            + "the store is cloned to machines that cannot hold both, so rename one before attaching the directory");
    }
}

// No override flag: an unbounded bundle is charged to every future clone of
// the store. Both are counted during planning, so a refusal needs no rollback.
// The bound measures what the reporter brought — the index this command may
// generate afterwards is its own line, not theirs.
const MAX_MEMBERS = 1000;

const MAX_BYTES = 100 * 1024 * 1024;

// Where an artifact is large enough to be worth saying so and not large enough
// to refuse. Every clone of the store carries it and its history keeps it after
// a deletion, so the size is stated once, at the moment there is still a choice
// about it — and then the report proceeds, because what is worth attaching is
// the reporter's judgment and not this module's.
const WARN_BYTES = 10 * 1024 * 1024;

function requireBound(label: string, members: PlannedMember[]): void
{
    if (members.length > MAX_MEMBERS)
    {
        throw new CliError(`artifact "${label}" holds ${members.length} files, over the ${MAX_MEMBERS}-file bound — package it into one file and attach that instead`);
    }
    const bytes = members.reduce((total, member) => total + (member.bytes ?? 0), 0);
    if (bytes > MAX_BYTES)
    {
        throw new CliError(`artifact "${label}" holds ${bytes} bytes, over the ${MAX_BYTES}-byte bound — package it into one file and attach that instead`);
    }
    warnLarge(label, bytes);
}

// The bound a single file had none of: a directory was capped at 1000 files
// and 100 MB while one 15 MB database file ingested as readily as a 3 KB
// report (#239). The same numbers, because the store does not care which
// shape the bytes arrived in.
function requireFileBound(label: string, source: string): void
{
    const bytes = statSync(source).size;
    if (bytes > MAX_BYTES)
    {
        throw new CliError(`artifact "${label}" is ${bytes} bytes, over the ${MAX_BYTES}-byte bound — compress it and attach the archive, `
            + "or leave it where it is and record its path in the report");
    }
    warnLarge(label, bytes);
}

function warnLarge(label: string, bytes: number): void
{
    if (bytes > WARN_BYTES)
    {
        notice(`artifact "${label}" is ${bytes} bytes — every clone of this store carries it, and compacting the history never takes it back out; `
            + "compress it, or leave it where it is and record its path, if it does not have to be evidence");
    }
}

/* ── which member a person is meant to open ────────────────────────── */

// Index precedence is total, root-only and regular-file-only. Root only,
// because a `README.md` inside a vendored subdirectory is not the
// deliverable's front door; regular files only, which the manifest already
// guarantees, so a directory named `index.html` is not a candidate.
const INDEX_NAMES = ["index.html", "index.md", "README.md"];

const GENERATED_INDEX = "index.html";

// Taken as repeatable so a second one is refused by name. Left as a single
// option, the parser keeps the last and drops the first without a word, and a
// caller who meant two members would be told nothing at all.
function requireOneEntry(entries: string[] | undefined): string | undefined
{
    if (entries !== undefined && entries.length > 1)
    {
        throw new CliError(`--entry names one member and was passed ${entries.length} times — a bundle has one entry, so pass it once`);
    }
    return entries?.[0];
}

function assignEntry(planned: PlannedArtifact[], entry: string | undefined): void
{
    const bundles = planned.filter((item) => item.members !== undefined);
    if (entry !== undefined)
    {
        requireOneBundle(bundles, entry);
        bundles[0].entry = requireMember(bundles[0], entry);
    }
    bundles.filter((item) => item.entry === undefined).forEach(adoptOrGenerate);
}

// `--entry` names a member of a bundle: with a single file there is no member
// to name, and with two bundles nothing in the flag says which.
function requireOneBundle(bundles: PlannedArtifact[], entry: string): void
{
    if (bundles.length === 0)
    {
        throw new CliError(`--entry ${entry} names the member of a bundle a person opens, and this report attaches no directory — pass --artifact <dir>, or drop --entry`);
    }
    if (bundles.length > 1)
    {
        throw new CliError(`--entry applies to one bundle and this report attaches ${bundles.length} — report the directories separately, or drop --entry`);
    }
}

function requireMember(bundle: PlannedArtifact, entry: string): string
{
    const wanted = entry.split(sep).join("/");
    if (isAbsolute(entry) || wanted.split("/").includes(".."))
    {
        throw new CliError(`--entry ${entry} is not a member path — an entry is named relative to the bundle's own root, with no ".."`);
    }
    const members = bundle.members ?? [];
    if (members.some((member) => member.path.startsWith(`${wanted}/`)))
    {
        throw new CliError(`--entry ${entry} names a directory inside "${bundle.name}" — an entry is the one file a person opens`);
    }
    if (!members.some((member) => member.path === wanted))
    {
        throw new CliError(`--entry ${entry} is not a member of "${bundle.name}" — name a file the directory holds, relative to its root`);
    }
    return wanted;
}

function adoptOrGenerate(bundle: PlannedArtifact): void
{
    const members = bundle.members ?? [];
    const adopted = INDEX_NAMES.find((name) => members.some((member) => member.path === name));
    if (adopted !== undefined)
    {
        bundle.entry = adopted;
        return;
    }
    requireIndexNameFree(bundle, members);
    members.push(generatedIndex(bundle.name, members));
    members.sort((left, right) => comparePaths(left.path, right.path));
    bundle.entry = GENERATED_INDEX;
}

// Adoption is exact — rule 12's precedence is a list of names, not a pattern —
// so reaching generation only says no root name is spelled `index.html`. What
// the generated member needs is the stronger thing: that no root name **folds**
// to it, by the same equality rule 8 refuses two members under. A root
// `INDEX.HTML` file, or a directory of either spelling, is what stands where
// the index would go.
//
// Refused here rather than left to the copy, which is the whole point: on a
// case-insensitive filesystem the copy fails late with `artifact id <id> is
// already stored`, which is false and which no rerun fixes, and on a
// case-sensitive one both members store and the first macOS clone of the store
// gets a broken checkout. The refusal names `--entry`, which is the way
// through: naming a member skips generation entirely.
function requireIndexNameFree(bundle: PlannedArtifact, members: PlannedMember[]): void
{
    const wanted = folded(GENERATED_INDEX);
    const clash = members.map((member) => member.path.split("/")[0]).find((name) => folded(name) === wanted);
    if (clash !== undefined)
    {
        throw new CliError(`artifact "${bundle.name}" holds "${clash}" at its root, which is the name a generated index takes once case and Unicode normalization are folded, `
            + "so none can be generated there — name the member a person opens with --entry <file>");
    }
}

// A minimal page listing every member the reporter brought — itself excluded,
// since a page linking to itself tells a reader nothing. It is a member like
// any other and counts in what the store holds; `generated` is what says no
// reporter wrote it.
function generatedIndex(name: string, members: PlannedMember[]): PlannedMember
{
    const rows = members.map((member) =>
        `<li><a href="${escapeHtml(encodedPath(member.path))}">${escapeHtml(member.path)}</a></li>`);
    return {
        path: GENERATED_INDEX,
        digest: "",
        generated: true,
        text: `<!doctype html>\n<meta charset="utf-8">\n<title>${escapeHtml(name)}</title>\n`
            + `<h1>${escapeHtml(name)}</h1>\n<ul>\n${rows.join("\n")}\n</ul>\n`
    };
}

const HTML_MARKS: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" };

function escapeHtml(text: string): string
{
    return text.replace(/[&<>"]/g, (mark) => HTML_MARKS[mark]);
}

/* ── bytes the store already holds ─────────────────────────────────── */

// A digest has been computed at every ingest since artifacts had one and never
// compared with anything, so the same bytes attached twice were stored twice —
// 83 of one store's 855 files (#239). The second artifact is not refused: that
// the same output came out twice is itself worth recording, and a report whose
// evidence is a path some other report owns is a stranger relation than two
// records sharing a path. So it is stored once and referenced twice — each
// artifact keeps its own id, its own name and its own entry, and one copy of
// the bytes carries both.
//
// The reuse is per project, deliberately. A store's projects are archived,
// restored and read separately, and bytes one project's record points at
// inside another project's directory would make either of those an act on a
// project nobody named.
function adoptStored(storeDir: string, slug: string, planned: PlannedArtifact[]): void
{
    const stored = storedIndex(storeDir, slug);
    const twins = new Map<string, PlannedArtifact>();
    for (const item of planned)
    {
        const digest = plannedDigest(item);
        if (digest === undefined)
        {
            continue;
        }
        const twin = twins.get(digest);
        const held = stored.get(digest);
        if (twin !== undefined)
        {
            adoptTwin(item, twin);
        }
        else if (held !== undefined && heldBytes(storeDir, held))
        {
            adoptHeld(item, held);
        }
        else
        {
            twins.set(digest, item);
        }
    }
}

// What this project already holds, keyed by the digest of the bytes rather
// than by any id: what a second ingest asks is whether these bytes are here.
// A bundle answers with its manifest hash, which is derived where something
// needs it and never stored. The first record of a digest wins, so a path two
// records already share is adopted as the one they share.
function storedIndex(storeDir: string, slug: string): Map<string, ArtifactRecord>
{
    const index = new Map<string, ArtifactRecord>();
    for (const record of listArtifacts(storeDir, [slug]))
    {
        const digest = artifactDigest(record);
        if (digest !== undefined && digest !== "" && !index.has(digest))
        {
            index.set(digest, record);
        }
    }
    return index;
}

// The digest the store would hold if these bytes were copied: a file's own
// hash, or a bundle's manifest hash over every member's. The generated index
// is hashed from the text that would be written — it has no source to read,
// and a manifest computed without it could never equal a stored one.
//
// Undefined where a source cannot be read at all. That is not a refusal here:
// the copy this ingest is about to attempt gives the reporter the error, in
// the words it already gives it in.
function plannedDigest(item: PlannedArtifact): string | undefined
{
    if (item.members === undefined)
    {
        return digestOf(item.source) ?? undefined;
    }
    const members = item.members.map((member) => ({ path: member.path, digest: memberSource(member) }));
    return members.some((member) => member.digest === "")
        ? undefined
        : artifactDigest({ id: item.id, name: item.name, path: item.path, members });
}

function memberSource(member: PlannedMember): string
{
    return member.source === undefined
        ? createHash("sha256").update(member.text ?? "").digest("hex")
        : digestOf(member.source) ?? "";
}

// A record is adopted only when the bytes it names are on this machine and
// still hash to what it recorded. A log travels between clones through a
// shared remote, so a record alone says nothing about what this store holds:
// an unsynced store has the line and not the file, and a record whose stored
// copy no longer matches is the defect `artifactSignals` reports, never a
// candidate to hang a second artifact off.
function heldBytes(storeDir: string, record: ArtifactRecord): boolean
{
    const root = storedRoot(storeDir, record.path);
    if (root === null || !existsSync(root))
    {
        return false;
    }
    if (record.members === undefined)
    {
        return record.digest !== undefined && digestOf(root) === record.digest;
    }
    return record.members.every((member) => heldMember(root, member));
}

function heldMember(root: string, member: ArtifactMember): boolean
{
    const file = resolve(root, ...member.path.split("/"));
    return within(root, file) && digestOf(file) === member.digest;
}

// Never throws: a stored file this machine cannot read is a file this ingest
// does not reuse, not a report to refuse.
function digestOf(file: string): string | null
{
    try
    {
        return digestFile(file);
    }
    catch
    {
        return null;
    }
}

// The stored record's path and manifest, copied onto the planned item. The
// digests come from the record, which `heldBytes` has just verified against
// the bytes on disk — the source's own hash is a lookup key and is never
// recorded, so what the event carries is always the digest of what the store
// holds. `entry` is not copied: two artifacts may share every byte and still
// open onto different members, because the manifest hash covers the members
// alone.
function adoptHeld(item: PlannedArtifact, record: ArtifactRecord): void
{
    item.path = record.path;
    item.reused = true;
    if (record.members === undefined)
    {
        item.digest = record.digest;
        return;
    }
    item.members = (record.members ?? []).map((member) => ({ ...member }));
}

// Two sources in one report holding the same bytes: the first is copied and
// the second points at it. The digest is read off that item when the event is
// composed, by which time its copy has filled it in from the stored file.
function adoptTwin(item: PlannedArtifact, twin: PlannedArtifact): void
{
    item.path = twin.path;
    item.reused = true;
    item.twin = twin;
}

/* ── the bytes ─────────────────────────────────────────────────────── */

// Hands the first failure back instead of throwing, so the caller can undo the
// files it already touched before the error reaches the user. Each target is
// recorded before its copy: an interrupted copy leaves a partial file that
// rollback must still remove.
function copyPlanned(storeDir: string, planned: PlannedArtifact[], staging: Staging): Error | null
{
    for (const item of planned)
    {
        // Nothing is copied for a reused artifact and nothing is staged in its
        // name: those bytes are another record's, and a rollback that reached
        // them would delete evidence this report never wrote.
        if (item.reused === true)
        {
            continue;
        }
        const failure = item.members === undefined
            ? copyFile(storeDir, item, staging)
            : copyBundle(storeDir, item, staging);
        if (failure !== null)
        {
            return failure;
        }
    }
    return null;
}

function copyFile(storeDir: string, item: PlannedArtifact, staging: Staging): Error | null
{
    const target = join(storeDir, item.path);
    staging.files.push(target);
    // Created exclusively: stored bytes the log already points at are never
    // overwritten, and unlike asking first and copying after, this leaves no
    // window between the two. Artifacts are immutable after ingestion.
    // Digested from the stored copy rather than the source: what the log
    // promises is the bytes this store now holds.
    const failure = capture(() =>
    {
        copyFileSync(item.source, target, constants.COPYFILE_EXCL);
        item.digest = digestFile(target);
    });
    if (failure !== null && codeOf(failure) === "EEXIST")
    {
        // Whoever wrote that name got there first; rollback must not reach for
        // a file this command did not create.
        staging.files.pop();
    }
    return failure === null ? null : storeFailure(failure, item);
}

// The bundle root is created non-recursively, so an id already on disk fails
// with EEXIST and gets the same answer COPYFILE_EXCL gives a single file.
function copyBundle(storeDir: string, item: PlannedArtifact, staging: Staging): Error | null
{
    const root = join(storeDir, item.path);
    const opened = capture(() =>
    {
        mkdirSync(root);
        staging.dirs.push(root);
    });
    if (opened !== null)
    {
        return storeFailure(opened, item);
    }
    for (const member of item.members ?? [])
    {
        const failure = copyMember(root, member, staging);
        if (failure !== null)
        {
            return storeFailure(failure, item);
        }
    }
    return null;
}

// Every directory the member needs is recorded as this command's, so a failure
// three members in takes the tree it grew back out with it.
function copyMember(root: string, member: PlannedMember, staging: Staging): Error | null
{
    const target = join(root, ...member.path.split("/"));
    return capture(() =>
    {
        staging.dirs.push(...createDirs(dirname(target)));
        staging.files.push(target);
        writeMember(member, target);
        member.digest = digestFile(target);
    });
}

// The generated index has no source to copy from, and is written exclusively
// for the reason a copy is: nothing already standing may be overwritten.
function writeMember(member: PlannedMember, target: string): void
{
    if (member.source === undefined)
    {
        writeFileSync(target, member.text ?? "", { flag: "wx" });
        return;
    }
    copyFileSync(member.source, target, constants.COPYFILE_EXCL);
}

function storeFailure(failure: Error, item: PlannedArtifact): Error
{
    return codeOf(failure) === "EEXIST"
        ? new CliError(`artifact id ${item.id} is already stored — run the report again`)
        : new CliError(`artifact "${item.name}" could not be copied into the store: ${failure.message}`);
}

// Rollback removes what this command made and nothing more: the files it
// copied, by name, and then the directories it created, one level at a time and
// only while they are empty. A recursive delete here would take the shared
// artifacts root — or a concurrent report's bytes — down with one failed set.
function removeStaged(staging: Staging): void
{
    for (const file of staging.files)
    {
        // Captured, not thrown: the very thing that failed the copy can fail
        // the removal — a path the system will not stat because it is too long
        // for this store is the shape that reaches here — and a rollback that
        // throws halfway leaves behind everything it had not reached yet.
        capture(() => rmSync(file, { force: true }));
    }
    staging.files.length = 0;
    // Deepest first — a directory's path is longer than every ancestor of it,
    // whatever order the members were created in — and a directory another
    // report has meanwhile filled refuses to go and is left standing.
    for (const dir of [...staging.dirs].sort((left, right) => right.length - left.length))
    {
        capture(() => rmdirSync(dir));
    }
    staging.dirs.length = 0;
}

function codeOf(error: Error): string | undefined
{
    return (error as NodeJS.ErrnoException).code;
}

function isReadable(source: string): boolean
{
    try
    {
        accessSync(source, constants.R_OK);
        return true;
    }
    catch
    {
        return false;
    }
}

function capture(action: () => void): Error | null
{
    try
    {
        action();
        return null;
    }
    catch (error)
    {
        return error instanceof Error ? error : new Error(String(error));
    }
}

// The derived registry: what the log says this store holds. Exported because
// the store's own size is answered from it — which stored paths a live record
// names is the difference between artifact bytes and orphaned ones.
export function listArtifacts(storeDir: string, slugs: string[]): ArtifactRecord[]
{
    const records: ArtifactRecord[] = [];
    for (const slug of slugs)
    {
        for (const event of readEvents(storeDir, slug))
        {
            for (const meta of declaredArtifacts(event))
            {
                records.push({
                    ...meta,
                    project: slug,
                    work: event.refs?.work,
                    ts: event.ts,
                    summary: summaryOf(event)
                });
            }
        }
    }
    return records;
}

// Bytes reach the store through a report or through a review receipt, and the
// registry is derived from whichever event named them: a review record that
// only one surface could find would be a record nobody can audit.
function declaredArtifacts(event: { type: string; payload: Record<string, unknown> }): ArtifactMeta[]
{
    if (event.type === "report.added" && Array.isArray(event.payload.artifacts))
    {
        return event.payload.artifacts as ArtifactMeta[];
    }
    if (event.type === "review.received" && event.payload.artifact !== undefined)
    {
        return [event.payload.artifact as ArtifactMeta];
    }
    return [];
}

function summaryOf(event: { type: string; payload: Record<string, unknown> }): string
{
    if (event.type !== "review.received")
    {
        return String(event.payload.text ?? "");
    }
    return `${event.payload.scope} review ${event.payload.verdict} for ${event.payload.changeSet}`;
}

// The workspace is resolved only once the arguments check out, so a typo is
// named the same way on a machine that has no workspace at all.
export const ARTIFACT_COMMAND: Command = {
    name: "artifact",
    usage: [
        {
            syntax: "artifact list [--work id] [--project slug]",
            description: ["list artifacts from the derived registry"],
            verbs: ["list"]
        },
        {
            syntax: "artifact search <query> | open <id> [--project slug]",
            description: ["find an artifact, or open it with the OS default app at a terminal"],
            verbs: ["search", "open"]
        }
    ],
    detail: [
        "browse the files reports have attached. Artifacts are ingested by",
        "`self report --artifact`, never registered on their own. Without an",
        "interactive terminal, `open` prints the resolved path and launches nothing.",
        "",
        "a directory attached with `--artifact` is one artifact and lists as one",
        "row, `dist/ (12 files)`; `open` on it opens that bundle's entry.",
        "",
        "  --work <work-id>    only artifacts attached to this work unit",
        "  --project <slug>    only artifacts of this project, instead of the current one"
    ],
    node: branch({
        name: "artifact",
        unnamed: "refuse",
        refusal: "usage: self artifact list [--work id] [--project slug] | search <query> | open <id> [--project slug]",
        children: [
            leaf("list", { work: { type: "string" }, project: { type: "string" } }, 0, ({ values }) =>
                artifactListing(scopedRecords(workspace(), values.work, values.project))),
            leaf("search", {}, 1, ({ positionals }) => searchArtifacts(workspace(), positionals[0])),
            leaf("open", { project: { type: "string" } }, 1, ({ values, positionals }) =>
                openArtifact(workspace(), positionals[0], values.project))
        ]
    })
};

function workspace(): CliContext
{
    return requireWorkspace(process.cwd());
}

function scopedRecords(ctx: CliContext, work: string | undefined, project: string | undefined): ArtifactRecord[]
{
    const scope = project ?? ctx.project;
    // Outside a project the listing is a workspace answer, so an archived
    // project's artifacts are not in it (#283); naming the slug still reads them.
    const slugs = scope === undefined
        ? activeProjects(ctx.storeDir).map((entry) => entry.slug)
        : [requireRegistered(ctx, scope)];
    const records = listArtifacts(ctx.storeDir, slugs);
    return work === undefined ? records : records.filter((record) => record.work === work);
}

function requireRegistered(ctx: CliContext, slug: string): string
{
    if (!readRegistry(ctx.storeDir).some((entry) => entry.slug === slug))
    {
        throw new CliError(`unknown project "${slug}" — registered: ${readRegistry(ctx.storeDir).map((e) => e.slug).join(", ")}`);
    }
    return slug;
}

function searchArtifacts(ctx: CliContext, query: string | undefined): CommandOutput
{
    if (query === undefined || query.trim() === "")
    {
        throw new CliError("usage: self artifact search <query>");
    }
    const needle = query.toLowerCase();
    const slugs = activeProjects(ctx.storeDir).map((entry) => entry.slug);
    // Member paths join the haystack: the manifest is what says what a bundle
    // holds, and a hit on one still shows the bundle's row, because a member
    // has no id of its own for a row to print.
    const hits = listArtifacts(ctx.storeDir, slugs).filter((record) =>
        [record.id, artifactSearchText(record), record.work ?? "", record.summary].join(" ").toLowerCase().includes(needle));
    return artifactListing(hits);
}

// The one listing both artifact reads answer with: the whole registry and the
// hits of a query are the same rows counted the same way, so the search half
// cannot drift into stating its size differently from the list half.
function artifactListing(records: ArtifactRecord[]): CommandOutput
{
    return [{
        kind: "listing",
        rows: records.length === 0
            ? ["no artifacts — attach one with `self report <work-id> \"…\" --artifact <path>`"]
            : records.map((record) =>
                `${record.id}  ${record.ts.slice(0, 10)}  ${record.project}  ${record.work ?? "-"}  ${artifactName(record)}`),
        total: records.length,
        noun: "artifact"
    }];
}

// An id is minted per artifact, not per workspace, so two projects can hold the
// same one. Opening whichever the fold listed first would show bytes nobody
// asked for; the ambiguity is stated instead.
function requireArtifact(storeDir: string, slugs: string[], wanted: string): ArtifactRecord
{
    const matches = listArtifacts(storeDir, slugs).filter((item) => item.id === wanted);
    if (matches.length === 0)
    {
        throw new CliError(`unknown artifact "${wanted}" — run \`self artifact list\` to see ids`);
    }
    const stored = [...new Map(matches.map((item): [string, ArtifactRecord] => [item.path, item])).values()];
    if (stored.length > 1)
    {
        const where = stored.map((item) => `${item.project}/${item.name}`).join(", ");
        throw new CliError(`artifact id "${wanted}" names ${stored.length} stored files (${where}) — narrow it with \`--project <slug>\``);
    }
    return stored[0];
}

// A bundle opens onto its entry, the one member a person is meant to read.
//
// Both halves of that path come out of an event, and a log travels between
// machines through a shared remote, so neither is a name this module may hand
// to the OS launcher unchecked: a crafted line naming `../../../etc/passwd` as
// its entry would otherwise open whatever a peer chose on the reader's own
// machine. The bundle must sit under the store's artifacts and the entry under
// the bundle, or the event is refused rather than followed.
function storedFile(storeDir: string, record: ArtifactRecord): string
{
    const bundle = storedRoot(storeDir, record.path);
    const file = bundle === null ? null : entryFile(bundle, record.entry);
    if (file === null)
    {
        throw new CliError(`artifact ${record.id} is recorded at a path outside this store's artifacts — the event naming it cannot be trusted`);
    }
    return file;
}

// Where a recorded path lands in this store, or null when it lands anywhere
// else. Both readers of a stored path go through here — the one that opens it
// and the one that hashes it to decide whether a second artifact may share it
// — so the reuse path is held to the same distrust of a foreign log line.
function storedRoot(storeDir: string, path: string): string | null
{
    const root = resolve(storeDir, path);
    return within(join(storeDir, "artifacts"), root) ? root : null;
}

function entryFile(bundle: string, entry: string | undefined): string | null
{
    if (entry === undefined)
    {
        return bundle;
    }
    const file = resolve(bundle, entry);
    return within(bundle, file) ? file : null;
}

function within(root: string, file: string): boolean
{
    const step = relative(root, file);
    return step !== "" && step !== ".." && !step.startsWith(".." + sep) && !isAbsolute(step);
}

function openArtifact(ctx: CliContext, id: string | undefined, project: string | undefined): CommandOutput
{
    const wanted = id?.trim();
    if (wanted === undefined || wanted === "")
    {
        throw new CliError("usage: self artifact open <id> [--project slug]");
    }
    const slugs = project === undefined
        ? readRegistry(ctx.storeDir).map((entry) => entry.slug)
        : [requireRegistered(ctx, project)];
    const record = requireArtifact(ctx.storeDir, slugs, wanted);
    const file = storedFile(ctx.storeDir, record);
    if (!existsSync(file))
    {
        throw new CliError(`artifact file ${record.path} is missing from this store — run \`self sync\` to fetch it`);
    }
    const label = `${record.entry === undefined ? record.name : `${record.name}/${record.entry}`} (${record.id})`;
    return [{
        kind: "receipt",
        text: launchFile(ctx, file)
            ? `opened ${label}`
            : `${file} — ${label} resolves to that path; nobody is at a terminal in this run, so the GUI launch was suppressed`
    }];
}
