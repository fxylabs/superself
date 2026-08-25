import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { branch, Command, leaf } from "./contract.js";
import { isLive } from "./entities.js";
import { attemptMarker, confirmHuman, HumanConfirmation } from "./human.js";
import { artifactId } from "./ids.js";
import { buildModel, ProjectModel } from "./model.js";
import { notice } from "./output.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { artifactMetas, ArtifactRecord, listArtifacts } from "./registry.js";
import { digestFile } from "./repo.js";
import { activeProjects, CliContext, ProjectContext, readRegistry, refuseArchived, requireProject, requireWorkspace } from "./paths.js";
import { bold, plural, red } from "./style.js";
import { launchFile } from "./view.js";
import { ArtifactMember, ArtifactMeta, artifactName, artifactSearchText, CliError, CommandOutput, encodedPath } from "./types.js";

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
//
// A pruned record is out of the index (#239). Its bytes were removed on
// purpose, and where another live record shares the path they are still there —
// so the live record is the one a new artifact hangs off, and a fresh copy is
// made when no live record is left.
function storedIndex(storeDir: string, slug: string): Map<string, ArtifactRecord>
{
    const index = new Map<string, ArtifactRecord>();
    for (const record of listArtifacts(storeDir, [slug]).filter((item) => item.pruned === undefined))
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

/* ── registering bytes with no report behind them (#238) ───────────── */

// The ingest path a report takes, with the report left out. Everything a
// report's artifact gets — the size bounds, the bundle rules, the reuse of
// bytes the project already stores — is the same two functions, so a
// registration cannot drift into a second way of putting a file in the store.
//
// It records `artifact.registered`, which carries no `refs.work`: nothing here
// is evidence of anything, and the completion gate reads a work unit's reports
// alone, so registering a file never opens `work done`.
function registerArtifact(ctx: ProjectContext, path: string, entries: string[] | undefined,
    why: string | undefined): ArtifactMeta
{
    const staged = stageArtifacts(ctx.storeDir, ctx.project, [path], entries);
    const meta = staged.artifacts[0];
    const payload: Record<string, unknown> = { artifacts: staged.artifacts };
    if (why !== undefined)
    {
        payload.why = why;
    }
    const event = makeEvent(ctx.project, "artifact.registered", payload, { artifacts: [meta.id] });
    commitStaged(staged, (recorded) => recordEvent(ctx, event, `${meta.id} ${meta.name}`, recorded));
    return meta;
}

function addArtifact(values: { entry?: string[]; why?: string }, path: string | undefined): CommandOutput
{
    const named = path?.trim();
    if (named === undefined || named === "")
    {
        throw new CliError("usage: self artifact add <path> [--entry <file>] [--why <text>]");
    }
    const meta = registerArtifact(requireProject(process.cwd()), named, values.entry, values.why);
    return [{ kind: "receipt", text: meta.id }];
}

// Taken as repeatable for the reason `--entry` is: a record references one
// artifact, and left as a single option the parser keeps the last value and
// drops the first without a word, so a caller who meant two would be told
// nothing at all.
function requireOneArtifact(named: string[] | undefined): string | undefined
{
    if (named !== undefined && named.length > 1)
    {
        throw new CliError(`--artifact names one artifact and was passed ${named.length} times — a record references one, `
            + "so pass it once; attach a directory as a bundle when several files belong together");
    }
    return named?.[0];
}

// A minted artifact id, and nothing a path could be mistaken for: the shape is
// `a-` and five characters, so a file actually named `a-notes` is read as the
// path it is.
const ARTIFACT_ID = /^a-[0-9abcdefghjkmnpqrstvwxyz]{5}$/;

// What `--artifact` on a record verb resolves to: an id this project already
// holds, or a path registered here and now.
//
// The registration happens **before** the record's own event, deliberately. A
// process that dies between the two leaves an artifact nothing points at,
// which `artifact list` shows and which nothing else depends on. The other
// order leaves a record pointing at an artifact that was never stored, and
// there is no way back from that.
export function resolveArtifactRef(ctx: ProjectContext, named: string[] | undefined): string | undefined
{
    const value = requireOneArtifact(named)?.trim();
    if (value === undefined)
    {
        return undefined;
    }
    // Refused rather than resolved: an empty value is a path that resolves to
    // the directory the command ran in, and registering that would ingest a
    // whole checkout on a typo.
    if (value === "")
    {
        throw new CliError("--artifact names an artifact id or a path to register, and was passed an empty value");
    }
    return ARTIFACT_ID.test(value)
        ? requireOwnArtifact(ctx, value)
        : registerArtifact(ctx, value, undefined, undefined).id;
}

// An id is checked against this project's own log and no other's. Artifact
// bytes live under `artifacts/<slug>/`, so a record naming another project's
// id would make this project's event point into a directory it does not own —
// and the health check that verifies the reference reads one project's fold.
function requireOwnArtifact(ctx: ProjectContext, id: string): string
{
    if (!artifactMetas(ctx.storeDir, ctx.project, [id]).has(id))
    {
        throw new CliError(`unknown artifact "${id}" in project "${ctx.project}" — a record references an artifact this `
            + `project stores; run \`self artifact list --project ${ctx.project}\` to see ids, or pass a path to register one`);
    }
    return id;
}

// The workspace is resolved only once the arguments check out, so a typo is
// named the same way on a machine that has no workspace at all.
export const ARTIFACT_COMMAND: Command = {
    name: "artifact",
    usage: [
        {
            syntax: "artifact add <path> [--entry <file>] [--why <text>]",
            description: ["store a file or directory with no report behind it"],
            verbs: ["add"]
        },
        {
            syntax: "artifact list [--work id] [--project slug]",
            description: ["list artifacts from the derived registry"],
            verbs: ["list"]
        },
        {
            syntax: "artifact search <query> | open <id> [--project slug]",
            description: ["find an artifact, or open it with the OS default app at a terminal"],
            verbs: ["search", "open"]
        },
        {
            syntax: 'artifact prune <id> --why "<reason>" [--project slug]',
            description: ["remove a stored artifact's bytes, keeping the record that names them"],
            verbs: ["prune"]
        }
    ],
    detail: [
        "browse the files reports have attached, and register files that stand on",
        "their own. `self report --artifact` attaches evidence to a work unit;",
        "`artifact add` stores a file no report is about — a guide a convention",
        "points at with `--artifact`, say — and lists with `-` in the work column.",
        "Registering a file is not evidence, so it never satisfies `work done`.",
        "Without an interactive terminal, `open` prints the resolved path and",
        "launches nothing.",
        "",
        "a directory is one artifact and lists as one row, `dist/ (12 files)`;",
        "`open` on it opens that bundle's entry. The same size bounds and the same",
        "reuse of bytes the project already stores apply to both verbs.",
        "",
        "`prune` removes a stored artifact's bytes and keeps the record naming",
        "them, so a done claim resting on that evidence stays auditable. It needs",
        "a person at a terminal typing the artifact id back. Evidence is removable",
        "once its work unit is done or retired, bytes a live record points at are",
        "not, and bytes a design approval named never are. Where two artifacts",
        "share one stored path, each is pruned by name and the last one reclaims",
        "the bytes. Only the working tree shrinks: history is never rewritten.",
        "",
        "  --entry <file>      which member of a directory a person opens",
        "  --why <text>        what this file is for, kept beside the record;",
        "                      on `prune`, why the bytes are being removed",
        "  --work <work-id>    only artifacts attached to this work unit",
        "  --project <slug>    only artifacts of this project, instead of the current one"
    ],
    node: branch({
        name: "artifact",
        unnamed: "refuse",
        refusal: "usage: self artifact add <path> [--entry <file>] [--why <text>] | list [--work id] [--project slug]"
            + " | search <query> | open <id> [--project slug] | prune <id> --why \"<reason>\" [--project slug]",
        children: [
            leaf("add", { entry: { type: "string", multiple: true }, why: { type: "string" } }, 1,
                ({ values, positionals }) => addArtifact(values, positionals[0])),
            leaf("list", { work: { type: "string" }, project: { type: "string" } }, 0, ({ values }) =>
                artifactListing(scopedRecords(workspace(), values.work, values.project))),
            leaf("search", {}, 1, ({ positionals }) => searchArtifacts(workspace(), positionals[0])),
            leaf("open", { project: { type: "string" } }, 1, ({ values, positionals }) =>
                openArtifact(workspace(), positionals[0], values.project)),
            // Deliberately not marked `retiring`: a reviewed set (#312) is one
            // person's answer over a batch of record withdrawals, and removing
            // bytes is a different act with a different challenge — the id of
            // the exact artifact whose bytes go.
            leaf("prune", { why: { type: "string" }, project: { type: "string" } }, 1,
                ({ values, positionals }) => pruneArtifact(values, positionals[0]),
                { requires: [{ flags: ["why"], hint: "why these bytes are no longer worth storing" }] })
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
            // A pruned record keeps its row. The listing answers what the log
            // holds, and a record whose bytes were removed is still a record —
            // dropping it would make the store look as though the evidence had
            // never been attached.
            : records.map((record) =>
                `${record.id}  ${record.ts.slice(0, 10)}  ${record.project}  ${record.work ?? "-"}  `
                + `${artifactName(record)}${record.pruned === undefined ? "" : " (pruned)"}`),
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

// Asked before the file is looked for, and whether or not it is there. Two
// records can share one stored path, so pruning one leaves the bytes standing
// for the other — and opening this record's bytes because another record still
// needs them would make the removal a lie. The record is the truth.
//
// No `self sync` is offered. Syncing fetches what another machine holds, and
// what another machine holds is the same removal.
function refuseOpeningPruned(record: ArtifactRecord): void
{
    if (record.pruned === undefined)
    {
        return;
    }
    const why = record.pruned.why === undefined ? "" : `: ${record.pruned.why}`;
    throw new CliError(`artifact ${record.id} was pruned on ${record.pruned.ts.slice(0, 10)}${why} — its bytes were `
        + "removed from this store on purpose, and the record is kept so what was attached stays auditable");
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
    refuseOpeningPruned(record);
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

/* ── removing bytes a person named (#239) ──────────────────────────── */

// The one act in this module that cannot be undone, and its shape is what
// makes it survivable.
//
// The record is never removed, only the bytes. `completionRefusal`
// (`completion.ts`) reads a work unit's reports rather than the files they
// name, so dropping the bytes takes nothing from a `done` claim already
// closed — while dropping the record would take away the audit of it. Every
// read answers `pruned` from the log from then on.
//
// Only the working tree is reclaimed. History is never rewritten (#239 R4), so
// the copy the artifact left in `.git` stays there, and both the disclosure and
// the receipt say so rather than letting a reader believe the store shrank by
// what was removed.

// The work states an artifact's evidence may be removed under: the outcome is
// closed, either way it closes. Exactly the complement of the set
// `artifactSignals` (`reachability.ts`) still verifies, which is why no
// ordinary prune can produce a false missing-file signal.
const REMOVABLE_WORK = ["done", "retired"];

// Every reason this prune must not happen, answered before a byte is written
// and before a person is asked. Pure: it reads the record and the fold and
// nothing on the disk, so what refuses is auditable line by line.
function pruneRefusal(target: ArtifactRecord, model: ProjectModel): string | null
{
    if (target.pruned !== undefined)
    {
        return `${target.id} was already pruned on ${target.pruned.ts.slice(0, 10)} — the record stays as it is, and a `
            + "second prune has nothing of its own left to remove";
    }
    return sourceRefusal(target, model) ?? approvalRefusal(target, model) ?? referenceRefusal(target, model);
}

// What is leaning on these bytes depends on how they got here. Evidence
// reported on a work unit, and evidence a review named, both answer to that
// unit: while the outcome is open, the evidence is what an argument about it
// would be made from. Bytes registered on their own answer to whichever records
// point at them, which is the check below this one.
function sourceRefusal(target: ArtifactRecord, model: ProjectModel): string | null
{
    if (target.source === "registered")
    {
        return null;
    }
    if (target.work === undefined)
    {
        return `${target.id} came in on a ${target.source} that names no work unit, so nothing in this log says `
            + "whether the outcome it belongs to is finished — and bytes are removed only once that is settled";
    }
    const work = model.works.find((item) => item.id === target.work);
    if (work === undefined)
    {
        return `${target.id} names work ${target.work}, which this project's fold does not carry — `
            + "the unit it is evidence for cannot be read, so whether it is finished cannot be answered";
    }
    return REMOVABLE_WORK.includes(work.status) ? null
        : `${target.id} is evidence on ${work.id}, which is ${work.status} — evidence is removable once the outcome `
            + "is done or retired, and not while it is still being worked";
}

// A design approval names an exact hash: a person read those bytes and said
// yes. Removing them would leave an approval whose subject nobody can read
// again, so this refusal has no flag past it and no work state that lifts it.
function approvalRefusal(target: ArtifactRecord, model: ProjectModel): string | null
{
    const digest = artifactDigest(target);
    if (digest === undefined)
    {
        return null;
    }
    const approved = model.works.flatMap((work) =>
        work.reports.filter((report) => report.approval?.digest === digest).map((report) => `${work.id} ${report.id}`));
    return approved.length === 0 ? null
        : `${target.id} holds the bytes a person approved as the design of ${approved[0]} — an approval names an exact `
            + "hash, and nothing removes the bytes it names";
}

// A live record pointing at the artifact is a rule or a note whose whole
// content is "read this file" (#238). Withdrawing that record first is what
// makes the bytes spare, so the refusal names the record and the way through is
// the record's own withdrawal rather than a flag here.
function referenceRefusal(target: ArtifactRecord, model: ProjectModel): string | null
{
    const naming = model.entities.filter((item) => item.artifact === target.id && isLive(item)).map((item) => item.id);
    if (naming.length === 0)
    {
        return null;
    }
    return `${target.id} is what ${naming.join(", ")} points at, and ${naming.length === 1 ? "that record is" : "those records are"}`
        + " still live — retract or supersede it first, and these bytes become removable";
}

// Which live records name the stored path this one names. Two artifacts share a
// path whenever the same bytes were attached twice (#372) and each keeps its own
// id, so a prune removes the record a person named and the bytes go with the
// last live record naming them. Derived from the log every time: a stored
// counter could not stay true across a merge of two machines' logs.
function liveSharers(records: ArtifactRecord[], target: ArtifactRecord): ArtifactRecord[]
{
    return records.filter((record) => record.path === target.path && record.pruned === undefined);
}

function pruneArtifact(values: { why?: string; project?: string }, id: string | undefined): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    const wanted = id?.trim();
    if (wanted === undefined || wanted === "")
    {
        throw new CliError("usage: self artifact prune <id> --why \"<reason>\" [--project slug]");
    }
    const slugs = values.project === undefined
        ? readRegistry(ctx.storeDir).map((entry) => entry.slug)
        : [requireRegistered(ctx, values.project)];
    const record = requireArtifact(ctx.storeDir, slugs, wanted);
    // Asked before the gate rather than at the append: a person asked to
    // confirm a removal the log would refuse anyway has been asked for nothing.
    refuseArchived(ctx.storeDir, record.project, "nothing is removed from it");
    const refusal = pruneRefusal(record, buildModel(ctx.storeDir, record.project, new Date()));
    if (refusal !== null)
    {
        throw new CliError(refusal);
    }
    const sharers = liveSharers(listArtifacts(ctx.storeDir, [record.project]), record);
    return recordPrune(ctx, record, sharers.length - 1, String(values.why));
}

// The write order, and it is not negotiable: append, then remove, then fold and
// commit. `onRecorded` (`pipeline.ts`) fires between the appended line and the
// fold, which is the one seam where the record is already durable and the bytes
// are still there.
//
// Reversed — remove first, record second — a process dying in between loses
// bytes nothing in the log accounts for. In this order the same death leaves
// bytes nothing points at, which `self store size` reports as orphaned: surplus
// rather than loss, and surplus is a state someone can still act on.
function recordPrune(ctx: CliContext, record: ArtifactRecord, shared: number, why: string): CommandOutput
{
    const target = ownedRoot(ctx.storeDir, record);
    if (target === null)
    {
        throw new CliError(`artifact ${record.id} is recorded at ${record.path}, which is not inside project `
            + `"${record.project}"'s own artifacts — the event naming it cannot be trusted, and nothing was removed`);
    }
    const bytes = storedBytes(target);
    const confirmation = requireHumanPrune(record, shared, bytes);
    const failures: Error[] = [];
    // `refs.work` is what the record's own declaring event named, carried
    // forward: it is the true link — this is that unit's evidence — and it is
    // also what makes the fold see the removal at all, because a unit projected
    // from an entity exists only after the first pass and `model.ts`
    // `replayDeferred` replays the lines naming a unit onto it.
    const refs = record.work === undefined ? { artifacts: [record.id] } : { artifacts: [record.id], work: record.work };
    const event = makeEvent(record.project, "artifact.pruned",
        prunePayload(record, why, shared === 0, confirmation), refs, true);
    recordEvent(ctx, event, `${record.id} ${artifactName(record)} pruned`,
        () => { if (shared === 0) { removeBytesOf(target, failures); } });
    return pruneReceipt(record, shared, bytes, failures[0]);
}

function prunePayload(record: ArtifactRecord, why: string, bytesRemoved: boolean,
    confirmation: HumanConfirmation): Record<string, unknown>
{
    // `bytesRemoved` is what makes the log answerable on its own: which prune
    // actually reclaimed a path, read back beside what `store size` reports as
    // orphaned, without anyone having to replay the sharing arithmetic.
    const payload: Record<string, unknown> = { artifact: record.id, why, bytesRemoved, confirmation };
    const digest = artifactDigest(record);
    if (digest !== undefined)
    {
        payload.digest = digest;
    }
    return payload;
}

// Runs inside `onRecorded`, and never throws. `writeThrough` (`pipeline.ts`)
// does not wrap the callback, so a throw here would skip the fold and the
// commit and leave the appended line uncommitted — a worse outcome than bytes
// outliving their record, and the one this whole order exists to avoid. The
// failure is carried back out instead, and said in the receipt.
function removeBytesOf(target: string, failures: Error[]): void
{
    const failure = capture(() => rmSync(target, { recursive: true, force: true }));
    if (failure !== null)
    {
        failures.push(failure);
    }
}

// What this prune is allowed to remove: a path inside the owning project's own
// artifacts, and nowhere else. Narrower than `storedRoot`, which every read
// goes through, and narrower on purpose — a read of another project's bytes
// shows the wrong file, while a delete of them is gone. A log travels between
// machines through a shared remote, so a line naming `artifacts/<other>/…` is
// a line this command must refuse rather than follow.
function ownedRoot(storeDir: string, record: ArtifactRecord): string | null
{
    const root = resolve(storeDir, record.path);
    return within(artifactDir(storeDir, record.project), root) ? root : null;
}

// What removing this record would reclaim, counted before anything is removed
// so a person reads it while the decision is still open. Regular files only and
// no link followed, which is the rule `store size` counts under too.
function storedBytes(path: string): number
{
    if (!existsSync(path))
    {
        return 0;
    }
    const info = lstatSync(path);
    if (info.isFile())
    {
        return info.size;
    }
    return info.isDirectory()
        ? readdirSync(path).reduce((sum, name) => sum + storedBytes(join(path, name)), 0)
        : 0;
}

// The human gate, in the shape `retirement.ts` established for every act that
// destroys something: the disclosure is rendered once and ends two ways — a
// refusal where no person can answer, a challenge prompt where one can — so
// what an agent reads and what a person reads cannot drift apart.
//
// The challenge is the artifact's own id, so what a person types back is the
// exact record being removed. One id is all one answer covers, which is why a
// shared path is pruned one record at a time.
function requireHumanPrune(record: ArtifactRecord, shared: number, bytes: number): HumanConfirmation
{
    const disclosure = pruneDisclosure(record, shared, bytes).join("\n");
    if (attemptMarker() !== undefined || !process.stdin.isTTY || !process.stdout.isTTY)
    {
        throw new CliError([`removing stored bytes is a person's call, and this process has no terminal to make it at — `
            + "nothing was removed", "", disclosure, "", "  a person runs this in their own terminal:",
        `    self artifact prune ${record.id} --why "…"`].join("\n"));
    }
    const confirmed = confirmHuman(
        `${red(bold(`prune artifact ${record.id} ${artifactName(record)}? — nothing is removed until you confirm`))}\n\n${disclosure}`,
        record.id,
        `type ${bold(record.id)} to remove exactly these bytes`);
    if ("code" in confirmed)
    {
        throw new CliError(`${confirmed.detail}\n\n  ${confirmed.next}`);
    }
    return confirmed;
}

// What a person reads before answering: the record, what happens to the bytes,
// and the two things people expect that are not true — that the record goes
// with them, and that `.git` shrinks.
function pruneDisclosure(record: ArtifactRecord, shared: number, bytes: number): string[]
{
    return [
        `  ${record.id}  ${artifactName(record)}  ${record.source}  attached ${record.ts.slice(0, 10)}`,
        ...(record.summary === "" ? [] : [`  ${record.summary.split("\n")[0]}`]),
        `  stored at ${record.path} (${bytes} bytes)`,
        shared === 0
            ? "  those bytes are removed from the working tree"
            : `  ${plural(shared, "other live record")} ${shared === 1 ? "shares" : "share"} those bytes, `
                + "so nothing is reclaimed until the last of them is pruned",
        "  the record itself is kept — what was attached stays auditable, and a done claim resting on it still holds",
        "  history is never rewritten, so the copy this artifact left in .git stays there"
    ];
}

function pruneReceipt(record: ArtifactRecord, shared: number, bytes: number, failure: Error | undefined): CommandOutput
{
    const lines = [`${record.id} ${artifactName(record)} pruned — the record is kept and its bytes are not`];
    if (shared > 0)
    {
        lines.push(`${plural(shared, "other live record")} still ${shared === 1 ? "names" : "name"} ${record.path}, `
            + "so no byte was reclaimed — the last live record naming them is the prune that reclaims them");
    }
    else if (failure !== undefined)
    {
        lines.push(`the record is pruned and ${record.path} could not be removed: ${failure.message} — `
            + "`self store size` reports those bytes as orphaned until someone removes them");
    }
    else
    {
        lines.push(`${bytes} bytes reclaimed from the working tree; history is never rewritten, so what this artifact `
            + "left in .git stays there");
    }
    return [{ kind: "receipt", text: lines.join("\n") }];
}
