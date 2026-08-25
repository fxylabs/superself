// The store measures itself, compacts its history, and stops storing the same
// bytes twice (#372, part A of #239). One test per cell of the case table in
// docs/maintainers/case-tables/372-store-measure-dedupe.md, named by its cell
// number. The table is the review surface: a cell it lacks is a path nothing
// proves.
//
// Cell 9 — a stored artifact that has been withdrawn is not a reuse candidate —
// is the one cell of the table this suite does not run. Withdrawal is the
// removal half of #239 and no event records it yet, so the cell lands with the
// verb that makes the state reachable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { approvedIn, demoWorkspace, git, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);
// Resolved: the temporary root is reached through /var on macOS and the CLI
// answers in the /private/var the kernel gives it.
const store = realpathSync(join(ws, ".superself"));
const log = join(store, "projects", "demo", "log.jsonl");
const demoArtifacts = join(store, "artifacts", "demo");

const MAX_BYTES = 100 * 1024 * 1024;
const WARN_BYTES = 10 * 1024 * 1024;

let seq = 0;

/* ── the sources a cell attaches ───────────────────────────────────── */

function fileAt(name, body)
{
    seq += 1;
    const path = join(box.root, "files", `f${seq}-${name}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
}

// A source tree under the scratch machine's root, under a directory of the
// given name — the name matters, because a generated index carries it.
function tree(name, entries)
{
    seq += 1;
    const root = join(box.root, "trees", `t${seq}`, name);
    mkdirSync(root, { recursive: true });
    for (const [rel, body] of Object.entries(entries))
    {
        const path = join(root, ...rel.split("/"));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
    }
    return root;
}

/* ── running the report that attaches them ─────────────────────────── */

function unit(at = demo)
{
    seq += 1;
    return workIdIn(must(box, at, ["work", "add", `outcome ${seq}`]).out);
}

// One report per cell, on a work unit of its own, so no two cells read each
// other's artifacts back out of the log.
function attach(args, at = demo)
{
    const work = unit(at);
    return { work, ...selfIn(box, at, ["report", work, "attached", ...args]) };
}

function eventsIn(file = log)
{
    return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

function attached(work, file = log)
{
    return eventsIn(file).find((event) => event.type === "report.added" && event.refs?.work === work)?.payload.artifacts ?? [];
}

function storedNames(dir = demoArtifacts)
{
    return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function sha256(body)
{
    return createHash("sha256").update(body).digest("hex");
}

function manifestDigest(meta)
{
    return sha256(meta.members.map((member) => `${member.digest}  ${member.path}\n`).join(""));
}

/* ── 1–5: one file, and what makes its bytes already present ───────── */

test("cell 1: bytes the store does not hold are copied to a path of their own, digested from the copy", () =>
{
    const body = "cell 1 unique bytes\n";
    const { work, code, out } = attach(["--artifact", fileAt("one.md", body)]);
    assert.equal(code, 0, out);
    const meta = attached(work)[0];
    assert.match(meta.id, /^a-[0-9a-z]{5}$/);
    assert.match(meta.path, new RegExp(`^artifacts/demo/${meta.id}-f\\d+-one\\.md$`));
    assert.equal(meta.digest, sha256(body));
    assert.equal(readFileSync(join(store, meta.path), "utf8"), body);
});

test("cell 2: the same bytes attached again take a second id and share the first's stored path", () =>
{
    const body = "cell 2 shared bytes\n";
    const first = attach(["--artifact", fileAt("first.md", body)]);
    assert.equal(first.code, 0, first.out);
    const before = storedNames();
    const second = attach(["--artifact", fileAt("second.md", body)]);
    assert.equal(second.code, 0, second.out);
    const one = attached(first.work)[0];
    const two = attached(second.work)[0];
    assert.notEqual(one.id, two.id, "the second artifact reused the first's id");
    assert.equal(two.path, one.path, "the second artifact did not share the stored path");
    assert.equal(two.digest, sha256(body));
    assert.deepEqual(storedNames(), before, "a second copy of the same bytes reached the store");
});

test("cell 3: a record whose stored file this machine does not have is not reused", () =>
{
    const body = "cell 3 unsynced bytes\n";
    const first = attach(["--artifact", fileAt("first.md", body)]);
    const one = attached(first.work)[0];
    rmSync(join(store, one.path));
    const second = attach(["--artifact", fileAt("second.md", body)]);
    assert.equal(second.code, 0, second.out);
    const two = attached(second.work)[0];
    assert.notEqual(two.path, one.path, "an artifact whose bytes are missing was reused");
    assert.equal(readFileSync(join(store, two.path), "utf8"), body);
});

test("cell 4: a record whose stored bytes no longer match its digest is not reused", () =>
{
    const body = "cell 4 drifted bytes\n";
    const first = attach(["--artifact", fileAt("first.md", body)]);
    const one = attached(first.work)[0];
    writeFileSync(join(store, one.path), "something else entirely\n");
    const second = attach(["--artifact", fileAt("second.md", body)]);
    assert.equal(second.code, 0, second.out);
    const two = attached(second.work)[0];
    assert.notEqual(two.path, one.path, "an artifact whose stored bytes drifted was reused");
    assert.equal(readFileSync(join(store, two.path), "utf8"), body);
});

test("cell 5: the same bytes in another project are not reused across the project boundary", () =>
{
    const body = "cell 5 cross-project bytes\n";
    const other = join(ws, "other");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    must(box, other, ["project", "init", "--name", "other", "--desc", "a second project"]);
    const first = attach(["--artifact", fileAt("first.md", body)]);
    const second = attach(["--artifact", fileAt("second.md", body)], other);
    assert.equal(second.code, 0, second.out);
    const one = attached(first.work)[0];
    const two = attached(second.work, join(store, "projects", "other", "log.jsonl"))[0];
    assert.notEqual(two.path, one.path, "bytes were shared across two projects");
    assert.match(two.path, /^artifacts\/other\//);
});

/* ── 6–8: a bundle, matched by its manifest ────────────────────────── */

test("cell 6: a directory whose manifest hashes the same shares the stored bundle", () =>
{
    const entries = { "index.html": "<h1>cell 6</h1>", "assets/app.js": "// six" };
    const first = attach(["--artifact", tree("dist", entries)]);
    assert.equal(first.code, 0, first.out);
    const before = storedNames();
    const second = attach(["--artifact", tree("dist", entries)]);
    assert.equal(second.code, 0, second.out);
    const one = attached(first.work)[0];
    const two = attached(second.work)[0];
    assert.equal(two.path, one.path, "an identical bundle was stored a second time");
    assert.deepEqual(two.members, one.members, "the reused bundle recorded a different manifest");
    assert.equal(manifestDigest(two), manifestDigest(one));
    assert.deepEqual(storedNames(), before, "a second copy of the bundle reached the store");
});

test("cell 7: a directory differing in one member is copied whole", () =>
{
    const first = attach(["--artifact", tree("dist", { "index.html": "<h1>cell 7</h1>", "a.txt": "seven" })]);
    const second = attach(["--artifact", tree("dist", { "index.html": "<h1>cell 7</h1>", "a.txt": "seven and a half" })]);
    assert.equal(second.code, 0, second.out);
    const one = attached(first.work)[0];
    const two = attached(second.work)[0];
    assert.notEqual(two.path, one.path, "a bundle with a changed member was reused");
    assert.equal(readFileSync(join(store, two.path, "a.txt"), "utf8"), "seven and a half");
});

test("cell 8: a stored bundle missing one member is not reused", () =>
{
    const entries = { "index.html": "<h1>cell 8</h1>", "a.txt": "eight", "b.txt": "eight too" };
    const first = attach(["--artifact", tree("dist", entries)]);
    const one = attached(first.work)[0];
    rmSync(join(store, one.path, "b.txt"));
    const second = attach(["--artifact", tree("dist", entries)]);
    assert.equal(second.code, 0, second.out);
    const two = attached(second.work)[0];
    assert.notEqual(two.path, one.path, "a bundle with a missing member was reused");
    assert.equal(readFileSync(join(store, two.path, "b.txt"), "utf8"), "eight too");
});

/* ── 10–13: two artifacts in one report, and what a share must not do ─ */

test("cell 10: one source declared twice in one report is still refused before anything is stored", () =>
{
    const path = fileAt("twice.md", "cell 10 bytes\n");
    const before = storedNames();
    const { work, code, out } = attach(["--artifact", path, "--artifact", path]);
    assert.equal(code, 1, out);
    assert.match(out, /is declared twice in this report/);
    assert.deepEqual(attached(work), []);
    assert.deepEqual(storedNames(), before);
});

test("cell 11: two files of one report holding the same bytes are stored once and get an id each", () =>
{
    const body = "cell 11 twin bytes\n";
    const before = storedNames();
    const { work, code, out } = attach(["--artifact", fileAt("left.md", body), "--artifact", fileAt("right.md", body)]);
    assert.equal(code, 0, out);
    const [left, right] = attached(work);
    assert.notEqual(left.id, right.id);
    assert.equal(right.path, left.path, "the twin did not share the stored path");
    assert.equal(right.digest, sha256(body), "the twin recorded a digest other than the stored bytes'");
    assert.equal(storedNames().length, before.length + 1, "one report of twin bytes stored more than one file");
});

test("cell 12: a report that fails after reusing bytes leaves the bytes it reused alone", () =>
{
    const body = "cell 12 borrowed bytes\n";
    const first = attach(["--artifact", fileAt("first.md", body)]);
    const one = attached(first.work)[0];
    const before = storedNames();
    // The copy of the second artifact is what fails: the directory the store
    // writes into is read-only for the length of this report.
    chmodSync(demoArtifacts, 0o555);
    const failed = attach(["--artifact", fileAt("second.md", body), "--artifact", fileAt("new.md", "cell 12 fresh bytes\n")]);
    chmodSync(demoArtifacts, 0o755);
    assert.equal(failed.code, 1, failed.out);
    assert.deepEqual(attached(failed.work), [], "a failed report reached the log");
    assert.equal(readFileSync(join(store, one.path), "utf8"), body, "rollback deleted bytes another record names");
    assert.deepEqual(storedNames(), before, "a failed report left bytes behind");
});

test("cell 13: an approval binds to the shared digest, so a reused design artifact confirms", async () =>
{
    const body = "# cell 13\n\nthe design body\n";
    attach(["--artifact", fileAt("earlier.md", body)]);
    const decision = idIn(must(box, demo, ["decide", "cell 13: the store dedupes"]).out);
    const work = unit();
    const submitted = must(box, demo, ["report", work, "cell 13 design", "--design",
        "--implements", decision, "--artifact", fileAt("design.md", body)]);
    const report = submitted.out.match(/design report (\S+) recorded/)[1];
    const design = eventsIn().find((event) => event.id === report).payload.artifacts[0];
    assert.equal(design.digest, sha256(body));
    const approved = await approvedIn(box, demo, ["report", "confirm", report], design.digest.slice(0, 12));
    assert.equal(approved.code, 0, approved.out);
    assert.equal(eventsIn().at(-1).type, "report.confirmed");
});

/* ── 14–16: what a generated index and an entry do to the match ────── */

test("cell 14: identical files under a differently named directory do not share, because the index differs", () =>
{
    const entries = { "a.txt": "cell 14", "b.txt": "cell 14 too" };
    const first = attach(["--artifact", tree("left", entries)]);
    const second = attach(["--artifact", tree("right", entries)]);
    assert.equal(second.code, 0, second.out);
    const one = attached(first.work)[0];
    const two = attached(second.work)[0];
    assert.equal(one.entry, "index.html", "the bundle did not need a generated index");
    assert.notEqual(two.path, one.path, "bundles whose generated indexes differ were shared");
    assert.notEqual(manifestDigest(two), manifestDigest(one));
});

test("cell 15: identical files under the same directory name share, generated index included", () =>
{
    const entries = { "a.txt": "cell 15", "b.txt": "cell 15 too" };
    const first = attach(["--artifact", tree("report", entries)]);
    const before = storedNames();
    const second = attach(["--artifact", tree("report", entries)]);
    assert.equal(second.code, 0, second.out);
    const one = attached(first.work)[0];
    const two = attached(second.work)[0];
    assert.equal(two.path, one.path, "identical bundles with a generated index were stored twice");
    assert.ok(two.members.some((member) => member.path === "index.html" && member.generated === true));
    assert.ok(two.members.every((member) => member.digest !== ""), "a reused member recorded an empty digest");
    assert.deepEqual(storedNames(), before);
});

test("cell 16: the same members under two entries share the path and keep an entry each", () =>
{
    const entries = { "index.html": "<h1>cell 16</h1>", "other.html": "<h1>other</h1>" };
    const first = attach(["--artifact", tree("site", entries)]);
    const second = attach(["--artifact", tree("site", entries), "--entry", "other.html"]);
    assert.equal(second.code, 0, second.out);
    const one = attached(first.work)[0];
    const two = attached(second.work)[0];
    assert.equal(two.path, one.path, "the same members were stored twice for a different entry");
    assert.equal(one.entry, "index.html");
    assert.equal(two.entry, "other.html");
});

/* ── 17–19: the bound on one file ──────────────────────────────────── */

function sparseFile(name, bytes)
{
    seq += 1;
    const path = join(box.root, "large", `l${seq}-${name}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    truncateSync(path, bytes);
    return path;
}

test("cell 17: a single file over the byte bound is refused, and stages nothing", () =>
{
    const before = storedNames();
    const { work, code, out } = attach(["--artifact", sparseFile("huge.bin", MAX_BYTES + 1)]);
    assert.equal(code, 1, out);
    assert.match(out, new RegExp(`is ${MAX_BYTES + 1} bytes, over the ${MAX_BYTES}-byte bound`));
    assert.deepEqual(attached(work), [], "a refused report reached the log");
    assert.deepEqual(storedNames(), before, "a refused file was copied into the store");
});

test("cell 18: a single file over the warning size says so once and is attached", () =>
{
    const { work, code, out } = attach(["--artifact", sparseFile("large.bin", WARN_BYTES + 1)]);
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`is ${WARN_BYTES + 1} bytes — every clone of this store carries it`));
    assert.equal(attached(work).length, 1, "a warned file was not attached");
});

test("cell 19: a file under the warning size is attached without a word about its size", () =>
{
    const { work, code, out } = attach(["--artifact", fileAt("small.md", "cell 19\n")]);
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /every clone of this store carries it/);
    assert.equal(attached(work).length, 1);
});

/* ── 20, 28, 29: what `store size` answers ─────────────────────────── */

test("cell 20: a store holding no artifact reports zero rather than failing", () =>
{
    const empty = machine();
    const fresh = demoWorkspace(empty);
    const { code, out } = selfIn(empty, fresh.demo, ["store", "size"]);
    assert.equal(code, 0, out);
    assert.match(out, /artifacts: 0 recorded, 0 distinct contents, 0 B in 0 stored files/);
    assert.match(out, /orphan bytes: none/);
});

test("cell 28: a file no record names is reported as an orphan, with its bytes, and is left where it is", () =>
{
    const stray = join(demoArtifacts, "stray-bytes.md");
    const body = "cell 28 unnamed bytes\n";
    writeFileSync(stray, body);
    const { code, out } = selfIn(box, demo, ["store", "size"]);
    const survived = existsSync(stray);
    rmSync(stray, { force: true });
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`orphan bytes: 1 file no record names \\(${body.length} B\\), reported and not removed`));
    assert.match(out, new RegExp(`artifacts/demo/stray-bytes\\.md ${body.length} B`));
    assert.ok(survived, "`store size` deleted a file it only had to report");
});

test("cell 29: a store whose every stored file is named reports no orphan", () =>
{
    const { code, out } = selfIn(box, demo, ["store", "size"]);
    assert.equal(code, 0, out);
    assert.match(out, /orphan bytes: none — every stored file is named by a record/);
});

/* ── 21–22: the signal `sync` gives ────────────────────────────────── */

// One workspace with a remote, synced twice: the first sync has no upstream
// branch to pull from yet, and the signal is given on the way past a pull.
function syncedWorkspace()
{
    const remoteBox = machine();
    const synced = demoWorkspace(remoteBox);
    const remote = join(remoteBox.root, "remote.git");
    execFileSync("git", ["init", "--bare", "-q", remote], { env: remoteBox.env });
    must(remoteBox, synced.ws, ["remote", "add", remote]);
    must(remoteBox, synced.ws, ["sync"]);
    return { remoteBox, ...synced };
}

test("cell 21: loose objects outweighing the pack are named on the way past a sync", () =>
{
    const { remoteBox, ws: synced } = syncedWorkspace();
    const { code, out } = selfIn(remoteBox, synced, ["sync"]);
    assert.equal(code, 0, out);
    assert.match(out, /store history: \d+ loose objects \([^)]+\) against a [^—]+pack — run `self store compact`/);
});

test("cell 22: a packed store says nothing about its history when it syncs", () =>
{
    const { remoteBox, ws: synced } = syncedWorkspace();
    must(remoteBox, synced, ["store", "compact"]);
    const { code, out } = selfIn(remoteBox, synced, ["sync"]);
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /store history:/);
});

/* ── 23–27: compaction ─────────────────────────────────────────────── */

function storeGit(atBox, storeDir, args)
{
    return execFileSync("git", ["-C", storeDir, ...args], { env: atBox.env, encoding: "utf8" }).trim();
}

test("cell 23: a store whose repository has no commit compacts as a no-op rather than an error", () =>
{
    const fresh = machine();
    const made = demoWorkspace(fresh);
    const storeDir = join(made.ws, ".superself");
    rmSync(join(storeDir, ".git"), { recursive: true, force: true });
    execFileSync("git", ["init", "-q", storeDir], { env: fresh.env });
    const { code, out } = selfIn(fresh, made.demo, ["store", "compact"]);
    assert.equal(code, 0, out);
    assert.match(out, /history compacted/);
});

test("cell 24: a machine with no git says why compaction could not run, and refuses", () =>
{
    const { code, out } = selfIn(box, demo, ["store", "compact"], { PATH: join(box.root, "no-tools") });
    assert.equal(code, 1, out);
    assert.match(out, /store compact failed/);
});

test("cell 25: an unreachable loose object keeps git's own grace through a compaction", () =>
{
    const blob = storeGit(box, store, ["hash-object", "-w", fileAt("cell25.txt", "cell 25 unreachable bytes\n")]);
    assert.match(blob, /^[0-9a-f]{40,64}$/);
    must(box, demo, ["store", "compact"]);
    assert.doesNotThrow(() => storeGit(box, store, ["cat-file", "-e", blob]),
        "compaction destroyed an unreachable loose object");
});

test("cell 26: an unreachable object inside a previous pack survives compaction too", () =>
{
    const head = storeGit(box, store, ["rev-parse", "HEAD"]);
    storeGit(box, store, ["commit", "-q", "--allow-empty", "-m", "cell 26 unreachable"]);
    const orphaned = storeGit(box, store, ["rev-parse", "HEAD"]);
    // Packed while it is still reachable, then made unreachable with no reflog
    // left to hold it: this is the exact state `git repack -a -d` destroys and
    // `git gc` keeps.
    storeGit(box, store, ["repack", "-a", "-d", "-q"]);
    storeGit(box, store, ["reset", "-q", "--hard", head]);
    storeGit(box, store, ["reflog", "expire", "--expire=now", "--all"]);
    must(box, demo, ["store", "compact"]);
    assert.doesNotThrow(() => storeGit(box, store, ["cat-file", "-e", orphaned]),
        "compaction destroyed an unreachable object that was inside a pack");
});

test("cell 27: a store whose index is locked compacts without leaving the repository inconsistent", () =>
{
    const lock = join(store, ".git", "index.lock");
    writeFileSync(lock, "");
    const compacted = selfIn(box, demo, ["store", "compact"]);
    rmSync(lock, { force: true });
    assert.equal(compacted.code, 0, compacted.out);
    assert.doesNotThrow(() => storeGit(box, store, ["fsck", "--no-progress", "--no-dangling"]),
        "the repository was left inconsistent");
    const after = attach(["--artifact", fileAt("after.md", "cell 27 bytes\n")]);
    assert.equal(after.code, 0, after.out);
});
