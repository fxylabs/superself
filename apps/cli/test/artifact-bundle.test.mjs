// A directory attached as one artifact bundle (#362), one test per cell of the
// case table in docs/maintainers/case-tables/362-artifact-bundle.md. The table
// is the review surface: a cell it lacks is a path nothing proves, and every
// test below is named by the cell number it answers for.
//
// Three cells cannot be built on a default macOS filesystem — a name that is
// not valid UTF-8 (10), and two names that collide under case folding (11) or
// under Unicode normalization (51). The checks they exercise are deliberately
// filesystem-independent: they read the planned paths, never what a copy
// happens to do. So those cells run the check as a unit on a constructed list
// and, where the filesystem does admit the tree, run it through the CLI too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { dirname, join } from "node:path";
import { foldProject } from "../dist/fold.js";
import { foldedCollision, nameRefusal } from "../dist/artifact.js";
import { artifactName } from "../dist/types.js";
import { approvedIn, demoWorkspace, git, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
// `artifact open` at a terminal really launches the OS opener, so the marker
// that would suppress it has to be absent here — and a stub opener has to be
// what PATH finds, or the suite opens a browser window on the machine running
// it. The stub records the one path it was handed and exits.
delete box.env.CI;
delete box.env.SUPERSELF_ATTEMPT_ID;
const openerDir = join(box.root, "opener");
const openedFile = join(box.root, "opened.txt");
mkdirSync(openerDir, { recursive: true });
for (const name of ["open", "xdg-open", "explorer"])
{
    const stub = join(openerDir, name);
    writeFileSync(stub, `#!/bin/sh\nprintf '%s' "$1" > '${openedFile}'\n`);
    chmodSync(stub, 0o755);
}
box.env.PATH = `${openerDir}:${box.env.PATH}`;

const { ws, demo } = demoWorkspace(box);
// Resolved: the temporary root is reached through /var on macOS and the CLI
// answers in the /private/var the kernel gives it, so a path this suite
// composes has to be the same one the CLI would print.
const store = realpathSync(join(ws, ".superself"));
const log = join(store, "projects", "demo", "log.jsonl");
const artifactsRoot = join(store, "artifacts");

let seq = 0;

/* ── building the sources a cell attaches ──────────────────────────── */

// A source tree under the scratch machine's root. A key ending in `/` is a
// directory that stays empty; everything else is a file with the given body.
function tree(name, entries)
{
    seq += 1;
    const root = join(box.root, "trees", `t${seq}`, name);
    mkdirSync(root, { recursive: true });
    for (const [rel, body] of Object.entries(entries))
    {
        const path = join(root, ...rel.split("/"));
        if (rel.endsWith("/"))
        {
            mkdirSync(path, { recursive: true });
            continue;
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
    }
    return root;
}

function fileAt(name, body)
{
    seq += 1;
    const path = join(box.root, "files", `f${seq}-${name}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
}

/* ── running the report that attaches them ─────────────────────────── */

function unit(at = demo, atBox = box)
{
    seq += 1;
    return workIdIn(must(atBox, at, ["work", "add", `outcome ${seq}`]).out);
}

// One report per cell, on a work unit of its own, so no two cells can read
// each other's artifacts back out of the log.
function attach(args, at = demo)
{
    const work = unit(at);
    return { work, ...selfIn(box, at, ["report", work, "attached", ...args]) };
}

function eventsIn(file = log)
{
    return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

function reportFor(work, file = log)
{
    return eventsIn(file).find((event) => event.type === "report.added" && event.refs.work === work);
}

function attached(work, file = log)
{
    return reportFor(work, file)?.payload.artifacts ?? [];
}

function memberPaths(meta)
{
    return meta.members.map((member) => member.path);
}

// Every path under the store's artifacts root, so a refusal can be held to
// leaving the store exactly as it was found.
function storeTree(root = artifactsRoot)
{
    if (!existsSync(root))
    {
        return [];
    }
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
        ? [`${entry.name}/`, ...storeTree(join(root, entry.name)).map((path) => `${entry.name}/${path}`)]
        : [entry.name]).sort();
}

// The hash a bundle has no stored field for: sha256 over the canonical
// manifest text, computed here rather than imported, so the format itself is
// what the confirm cells are held to.
function manifestDigest(meta)
{
    return createHash("sha256")
        .update(meta.members.map((member) => `${member.digest}  ${member.path}\n`).join(""))
        .digest("hex");
}

/* ── 1–4: what one directory becomes ───────────────────────────────── */

test("cell 1: a directory attaches as one artifact whose members are sorted, forward-slashed paths", () =>
{
    const root = tree("dist", { "index.html": "<h1>hi</h1>", "assets/app.js": "js", "assets/style.css": "css" });
    const { work, code, out } = attach(["--artifact", root]);
    assert.equal(code, 0, out);
    const metas = attached(work);
    assert.equal(metas.length, 1, "a directory attached as more than one artifact");
    assert.match(metas[0].id, /^a-[0-9a-z]{5}$/);
    assert.deepEqual(memberPaths(metas[0]), ["assets/app.js", "assets/style.css", "index.html"]);
    assert.equal(metas[0].entry, "index.html");
    assert.deepEqual(reportFor(work).refs.artifacts, [metas[0].id], "refs.artifacts must carry one id per artifact");
});

test("cell 2: an empty directory is refused, and stages nothing", () =>
{
    const before = storeTree();
    const { work, code, out } = attach(["--artifact", tree("empty", {})]);
    assert.equal(code, 1, out);
    assert.match(out, /holds no files to attach/);
    assert.equal(reportFor(work), undefined, "a refused report reached the log");
    assert.deepEqual(storeTree(), before);
});

test("cell 3: a directory holding only .git is refused as empty, and the message says .git is not copied", () =>
{
    const { code, out } = attach(["--artifact", tree("repo", { ".git/HEAD": "ref: refs/heads/main\n" })]);
    assert.equal(code, 1, out);
    assert.match(out, /holds no files to attach/);
    assert.match(out, /`\.git` is never one of them/);
});

test("cell 4: an empty subdirectory is neither a member nor created in the store, and nested files keep their path", () =>
{
    const root = tree("dist", { "index.html": "hi", "assets/": "", "deep/one/two.txt": "two" });
    const { work, code, out } = attach(["--artifact", root]);
    assert.equal(code, 0, out);
    const meta = attached(work)[0];
    assert.deepEqual(memberPaths(meta), ["deep/one/two.txt", "index.html"]);
    assert.ok(!existsSync(join(store, meta.path, "assets")), "an empty source directory was created in the store");
    assert.ok(existsSync(join(store, meta.path, "deep", "one", "two.txt")));
});

/* ── 5–7: what the walk refuses to follow ──────────────────────────── */

test("cell 5: a symlink inside the tree refuses the bundle, whether its target is inside or outside", () =>
{
    const outside = fileAt("outside.txt", "elsewhere");
    for (const [label, target] of [["inside", "a.txt"], ["outside", outside]])
    {
        const root = tree("linked", { "a.txt": "a" });
        symlinkSync(target, join(root, "link"));
        const before = storeTree();
        const { code, out } = attach(["--artifact", root]);
        assert.equal(code, 1, `${label}: ${out}`);
        assert.match(out, /holds "link", which is not a regular file/);
        assert.deepEqual(storeTree(), before, `${label}: a refused bundle copied bytes`);
    }
});

test("cell 6: a fifo inside the tree refuses the bundle by the same rule", () =>
{
    const root = tree("piped", { "a.txt": "a" });
    execFileSync("mkfifo", [join(root, "pipe")]);
    const { code, out } = attach(["--artifact", root]);
    assert.equal(code, 1, out);
    assert.match(out, /holds "pipe", which is not a regular file/);
});

test("cell 7: --artifact on a symlink to a directory ingests that directory's files", () =>
{
    const root = tree("dist", { "index.html": "hi", "assets/app.js": "js" });
    const link = join(dirname(root), "link-to-dist");
    symlinkSync(root, link);
    const { work, code, out } = attach(["--artifact", link]);
    assert.equal(code, 0, out);
    assert.deepEqual(memberPaths(attached(work)[0]), ["assets/app.js", "index.html"]);
});

/* ── 8–11, 51: what a member path may spell ────────────────────────── */

test("cell 8: a member name holding a newline refuses the bundle, naming the path", () =>
{
    const root = tree("noted", { "ok.txt": "ok" });
    writeFileSync(join(root, "two\nlines.txt"), "x");
    const { code, out } = attach(["--artifact", root]);
    assert.equal(code, 1, out);
    assert.match(out, /holds a control character/);
    assert.match(out, /two\nlines\.txt/);
});

test("cell 9: names holding non-ASCII text and an emoji record verbatim, and open resolves", () =>
{
    const root = tree("docs", { "index.md": "front door" });
    writeFileSync(join(root, "보고서 v2.md"), "report");
    writeFileSync(join(root, "🚀 launch.txt"), "go");
    const { work, code, out } = attach(["--artifact", root]);
    assert.equal(code, 0, out);
    const meta = attached(work)[0];
    // Verbatim means the bytes the source directory hands back, whatever this
    // filesystem's normalization: the recorded path is that name, and it
    // resolves to real bytes in the store.
    assert.deepEqual(memberPaths(meta).slice().sort(), readdirSync(root).slice().sort());
    for (const path of memberPaths(meta))
    {
        assert.ok(existsSync(join(store, meta.path, ...path.split("/"))), `${path} was recorded but not stored`);
    }
    const opened = must(box, demo, ["artifact", "open", meta.id], { SUPERSELF_SESSION: "s" });
    assert.ok(existsSync(opened.out.split(" — ")[0]));
});

test("cell 10: a member name that is not valid UTF-8 is refused, named by its readable prefix", () =>
{
    // APFS refuses such a name outright, so the check runs here as the unit it
    // is: it reads the raw directory entry, which is where the bytes are.
    const raw = Buffer.from([0x64, 0x6f, 0x63, 0xff, 0x2e, 0x6d, 0x64]);
    assert.match(nameRefusal(raw), /not a valid UTF-8 name/);
    assert.equal(raw.toString("utf8"), "doc�.md", "the readable prefix is what the refusal can name");
    assert.equal(nameRefusal(Buffer.from("doc.md", "utf8")), null);
});

test("cell 11: two member paths colliding under case folding are refused at plan time, on every filesystem", () =>
{
    assert.deepEqual(foldedCollision(["README.md", "assets/x", "readme.md"]), ["README.md", "readme.md"]);
    assert.equal(foldedCollision(["README.md", "docs/readme.md"]), null);
    const root = tree("caps", { "README.md": "a" });
    writeFileSync(join(root, "readme.md"), "b");
    // A case-insensitive filesystem — this Mac's default — just overwrote the
    // first file, so there is no tree to attach; the check above already
    // answered for both filesystems, and this arm answers where one exists.
    if (readdirSync(root).length < 2)
    {
        assert.deepEqual(readdirSync(root), ["README.md"], "the tree could not be built, and was not built halfway");
        return;
    }
    const { code, out } = attach(["--artifact", root]);
    assert.equal(code, 1, out);
    assert.match(out, /"README\.md" and "readme\.md"/);
    assert.match(out, /case and Unicode normalization are folded/);
});

test("cell 51: two member paths colliding under Unicode normalization are refused at plan time", () =>
{
    const composed = "café.md";
    const decomposed = "café.md";
    assert.deepEqual(foldedCollision([composed, decomposed]), [composed, decomposed]);
    assert.equal(foldedCollision([composed, "sub/" + decomposed]), null);
    const root = tree("notes", {});
    writeFileSync(join(root, composed), "a");
    writeFileSync(join(root, decomposed), "b");
    if (readdirSync(root).length < 2)
    {
        return;
    }
    const { code, out } = attach(["--artifact", root]);
    assert.equal(code, 1, out);
    assert.match(out, /case and Unicode normalization are folded/);
});

test("cell 12: a member with no read permission refuses the bundle before any byte is copied",
    { skip: process.getuid?.() === 0 && "root reads a mode-000 file, so this machine cannot express the case" }, () =>
    {
        const root = tree("locked", { "ok.txt": "ok", "shut.txt": "shut" });
        chmodSync(join(root, "shut.txt"), 0o000);
        const before = storeTree();
        const { code, out } = attach(["--artifact", root]);
        assert.equal(code, 1, out);
        assert.match(out, /holds "shut\.txt", which cannot be read/);
        assert.deepEqual(storeTree(), before);
    });

/* ── 13–15: the bound ──────────────────────────────────────────────── */

function manyFiles(name, count, bytes)
{
    const root = tree(name, {});
    for (let index = 0; index < count; index += 1)
    {
        const path = join(root, `f${String(index).padStart(4, "0")}.txt`);
        writeFileSync(path, "x");
        if (bytes !== undefined)
        {
            // Sparse: the bound counts the size the filesystem reports, and
            // writing 100 MiB of real bytes to prove a refusal is a cost the
            // suite pays on every run for nothing.
            truncateSync(path, bytes);
        }
    }
    return root;
}

test("cell 13: 1001 files refuse the bundle, naming the count and the bound, and leave the store untouched", () =>
{
    const before = storeTree();
    const { code, out } = attach(["--artifact", manyFiles("wide", 1001)]);
    assert.equal(code, 1, out);
    assert.match(out, /holds 1001 files, over the 1000-file bound/);
    assert.match(out, /package it into one file/);
    assert.deepEqual(storeTree(), before);
});

test("cell 14: 1000 files over 100 MiB refuse the bundle, naming the total and the bound", () =>
{
    const before = storeTree();
    const { code, out } = attach(["--artifact", manyFiles("heavy", 1000, 110 * 1024)]);
    assert.equal(code, 1, out);
    assert.match(out, new RegExp(`holds ${1000 * 110 * 1024} bytes, over the ${100 * 1024 * 1024}-byte bound`));
    assert.deepEqual(storeTree(), before);
});

test("cell 15: exactly 1000 files under 100 MiB ingest", () =>
{
    const root = manyFiles("exact", 999);
    writeFileSync(join(root, "index.html"), "front door");
    const { work, code, out } = attach(["--artifact", root]);
    assert.equal(code, 0, out);
    const meta = attached(work)[0];
    assert.equal(meta.members.length, 1000);
    assert.equal(meta.entry, "index.html");
});

/* ── 16–21: which member is the entry ──────────────────────────────── */

function entryOf(name, entries, flags = [])
{
    const { work, code, out } = attach(["--artifact", tree(name, entries), ...flags]);
    assert.equal(code, 0, out);
    return attached(work)[0];
}

test("cell 16: index.html wins over README.md at the root", () =>
{
    assert.equal(entryOf("site", { "index.html": "a", "README.md": "b" }).entry, "index.html");
});

test("cell 17: index.md wins over README.md at the root", () =>
{
    assert.equal(entryOf("site", { "index.md": "a", "README.md": "b" }).entry, "index.md");
});

test("cell 18: README.md alone is the entry", () =>
{
    assert.equal(entryOf("site", { "README.md": "b" }).entry, "README.md");
});

test("cell 19: an index.html in a subdirectory is not adopted; a root index.html is generated", () =>
{
    const meta = entryOf("site", { "docs/index.html": "a", "notes.txt": "n" });
    assert.equal(meta.entry, "index.html");
    assert.equal(meta.members.find((member) => member.path === "index.html").generated, true);
});

test("cell 20: a directory named index.html is not a candidate; README.md is the entry", () =>
{
    const meta = entryOf("site", { "index.html/part.txt": "p", "README.md": "b" });
    assert.equal(meta.entry, "README.md");
    assert.deepEqual(memberPaths(meta), ["README.md", "index.html/part.txt"]);
});

test("cell 21: with no candidate a root index.html is generated, linking every brought member and not itself", () =>
{
    const meta = entryOf("site", { "notes.md": "n", "sub/a.txt": "a" });
    assert.equal(meta.entry, "index.html");
    const index = meta.members.find((member) => member.path === "index.html");
    assert.equal(index.generated, true);
    assert.equal(meta.members.length, 3, "the generated index counts in what the store holds");
    const page = readFileSync(join(store, meta.path, "index.html"), "utf8");
    assert.match(page, /href="notes\.md"/);
    assert.match(page, /href="sub\/a\.txt"/);
    assert.ok(!page.includes('href="index.html"'), "the generated index linked to itself");
    assert.match(must(box, demo, ["artifact", "list"]).out, /site\/ \(3 files\)/);
});

/* ── 22–27: --entry ────────────────────────────────────────────────── */

test("cell 22: --entry names a member, and nothing is generated", () =>
{
    const meta = entryOf("site", { "docs/main.html": "m", "notes.txt": "n" }, ["--entry", "docs/main.html"]);
    assert.equal(meta.entry, "docs/main.html");
    assert.deepEqual(memberPaths(meta), ["docs/main.html", "notes.txt"]);
    assert.ok(meta.members.every((member) => member.generated === undefined));
});

test("cell 23: --entry naming no member is refused", () =>
{
    const { code, out } = attach(["--artifact", tree("site", { "a.txt": "a" }), "--entry", "nope.html"]);
    assert.equal(code, 1, out);
    assert.match(out, /--entry nope\.html is not a member of "site"/);
});

test("cell 24: --entry outside the bundle's root is refused, absolute or relative", () =>
{
    for (const entry of ["../x", "/abs/x"])
    {
        const { code, out } = attach(["--artifact", tree("site", { "a.txt": "a" }), "--entry", entry]);
        assert.equal(code, 1, `${entry}: ${out}`);
        assert.match(out, /is not a member path/);
    }
});

test("cell 25: --entry naming a directory is refused", () =>
{
    const { code, out } = attach(["--artifact", tree("site", { "docs/a.txt": "a" }), "--entry", "docs"]);
    assert.equal(code, 1, out);
    assert.match(out, /--entry docs names a directory inside "site"/);
});

test("cell 26: --entry beside a single-file --artifact is refused", () =>
{
    const { code, out } = attach(["--artifact", fileAt("notes.md", "n"), "--entry", "x"]);
    assert.equal(code, 1, out);
    assert.match(out, /this report attaches no directory/);
});

test("cell 27: --entry beside two directory --artifacts is refused", () =>
{
    const { code, out } = attach([
        "--artifact", tree("one", { "a.txt": "a" }),
        "--artifact", tree("two", { "b.txt": "b" }),
        "--entry", "x"
    ]);
    assert.equal(code, 1, out);
    assert.match(out, /--entry applies to one bundle and this report attaches 2/);
});

/* ── 28–30: several --artifacts in one report ──────────────────────── */

test("cell 28: a bundle and a file in one report are two artifact records and two rows", () =>
{
    const { work, code, out } = attach([
        "--artifact", tree("dist", { "index.html": "i", "assets/app.js": "j" }),
        "--artifact", fileAt("notes.md", "n")
    ]);
    assert.equal(code, 0, out);
    const metas = attached(work);
    assert.equal(metas.length, 2);
    assert.deepEqual(reportFor(work).refs.artifacts, metas.map((meta) => meta.id));
    const rows = must(box, demo, ["artifact", "list", "--work", work]).out.split("\n").filter((line) => line.includes("a-"));
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.endsWith("dist/ (2 files)")));
    assert.ok(rows.some((row) => row.endsWith(metas[1].name)));
});

test("cell 29: one path declared twice in a report is refused", () =>
{
    const root = tree("dist", { "index.html": "i" });
    const { code, out } = attach(["--artifact", root, "--artifact", root]);
    assert.equal(code, 1, out);
    assert.match(out, /is declared twice in this report/);
});

test("cell 30: a path inside a declared bundle is refused", () =>
{
    const root = tree("dist", { "index.html": "i" });
    const { code, out } = attach(["--artifact", root, "--artifact", join(root, "index.html")]);
    assert.equal(code, 1, out);
    assert.match(out, /which this report attaches as a bundle/);
});

/* ── 31–32: a design report carrying a bundle ──────────────────────── */

test("cell 31: a design report carries a bundle as its one artifact, and the receipt names report confirm", () =>
{
    const decision = idIn(must(box, demo, ["decide", "cell 31: bundles are one artifact"]).out);
    const work = unit();
    const result = selfIn(box, demo, ["report", work, "the design", "--design", "--implements", decision,
        "--artifact", tree("design", { "index.md": "the design" })]);
    assert.equal(result.code, 0, result.out);
    const report = result.out.match(/design report (\S+) recorded/)[1];
    assert.match(result.out, new RegExp(`self report confirm ${report}`));
    assert.equal(attached(work)[0].members.length, 1);
});

test("cell 32: report confirm on a bundle challenges with the derived manifest digest and records it", async () =>
{
    const decision = idIn(must(box, demo, ["decide", "cell 32: an approval binds bytes"]).out);
    const work = unit();
    const result = must(box, demo, ["report", work, "the design", "--design", "--implements", decision,
        "--artifact", tree("design", { "index.md": "the design", "notes/a.md": "a" })]);
    const report = result.out.match(/design report (\S+) recorded/)[1];
    const meta = attached(work)[0];
    assert.equal(meta.digest, undefined, "a bundle must carry no top-level digest");
    const digest = manifestDigest(meta);
    const approved = await approvedIn(box, demo, ["report", "confirm", report], digest.slice(0, 12));
    assert.equal(approved.code, 0, approved.out);
    const written = eventsIn().at(-1);
    assert.equal(written.type, "report.confirmed");
    assert.equal(written.payload.digest, digest);
});

/* ── 33: rollback ──────────────────────────────────────────────────── */

// A copy that fails partway needs a member this filesystem will hold at the
// source and refuse at the destination. The store's path to a bundle is
// longer than the source's, so a member path sized into the gap between them
// is exactly that: the walk reads it, and the copy is refused with
// ENAMETOOLONG. It sorts last of the three, so two members are already in the
// store when it fails.
const PATH_LIMIT = 1024;

// A relative path of exactly `total` characters, split into components no
// filesystem calls too long. Rounding it up to whole components instead would
// overshoot by more than the gap this cell is aiming into.
function pathOfLength(total)
{
    const count = Math.ceil(total / 200);
    const chars = total - (count - 1);
    const each = Math.floor(chars / count);
    return Array.from({ length: count }, (unused, index) =>
        "z".repeat(index === 0 ? chars - each * (count - 1) : each));
}

function overlongMember(name)
{
    const root = realpathSync(tree(name, { "a.txt": "a", "b.txt": "b" }));
    const bundle = join(artifactsRoot, "demo", `a-xxxxx-${name}`);
    const steps = pathOfLength(PATH_LIMIT + 5 - bundle.length);
    const rel = steps.join("/");
    assert.ok(bundle.length + 1 + rel.length >= PATH_LIMIT, `${bundle} plus ${rel.length} characters is a path the store would accept`);
    assert.ok(root.length + 1 + rel.length < PATH_LIMIT - 8, `${root} plus ${rel.length} characters is a path the source cannot hold`);
    mkdirSync(join(root, ...steps.slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...steps), "over");
    return { root, rel };
}

test("cell 33: a copy failing on the third member leaves the store exactly as it was found", () =>
{
    const { root } = overlongMember("partial");
    const before = storeTree();
    const { work, code, out } = attach(["--artifact", root]);
    assert.equal(code, 1, out);
    assert.match(out, /could not be copied into the store/);
    assert.deepEqual(storeTree(), before, "a failed staging left bytes or directories behind");
    assert.equal(reportFor(work), undefined, "a failed staging still wrote an event");
});

/* ── 34–39: the read surfaces ──────────────────────────────────────── */

// A workspace of its own, because these cells count rows and a shared store
// would make the count whatever the tests before them happened to attach.
function freshMachine()
{
    const other = machine();
    delete other.env.CI;
    const places = demoWorkspace(other);
    return { box: other, ...places };
}

const reading = freshMachine();

const readingBundle = (() =>
{
    const root = join(reading.box.root, "trees", "dist");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<h1>dist</h1>");
    for (let index = 0; index < 10; index += 1)
    {
        writeFileSync(join(root, "assets", `a${index}.js`), `x${index}`);
    }
    writeFileSync(join(root, "assets", "logo.svg"), "<svg/>");
    const work = workIdIn(must(reading.box, reading.demo, ["work", "add", "reading outcome"]).out);
    must(reading.box, reading.demo, ["report", work, "the deliverable", "--artifact", root,
        "--artifact", (() =>
        {
            const file = join(reading.box.root, "notes.md");
            writeFileSync(file, "# notes\n");
            return file;
        })()]);
    const metas = eventsIn(join(reading.ws, ".superself", "projects", "demo", "log.jsonl"))
        .find((event) => event.type === "report.added" && event.refs.work === work).payload.artifacts;
    return { work, bundle: metas[0], file: metas[1] };
})();

test("cell 34: artifact list states a bundle as one row with its file count, and counts artifacts", () =>
{
    const listed = must(reading.box, reading.ws, ["artifact", "list"]).out;
    assert.equal(readingBundle.bundle.members.length, 12);
    assert.match(listed, /dist\/ \(12 files\)/);
    assert.match(listed, /  notes\.md$/m);
    assert.match(listed, /^2 artifacts$/m);
});

test("cell 35: a search matching only a member shows the bundle's one row", () =>
{
    const found = must(reading.box, reading.ws, ["artifact", "search", "logo.svg"]).out;
    assert.match(found, /dist\/ \(12 files\)/);
    assert.match(found, /^1 artifact$/m);
    assert.ok(!found.includes("logo.svg"), "a member was printed as a row of its own");
});

test("cell 36: a search matching the bundle's name shows the same one row", () =>
{
    const found = must(reading.box, reading.ws, ["artifact", "search", "dist"]).out;
    assert.match(found, /dist\/ \(12 files\)/);
    assert.match(found, /^1 artifact$/m);
});

test("cell 37: artifact open at a terminal opens the entry, and the receipt names it with the id", async () =>
{
    const root = tree("dist", { "index.html": "front door", "assets/app.js": "j" });
    const { work } = attach(["--artifact", root]);
    const meta = attached(work)[0];
    const entryFile = join(store, meta.path, "index.html");
    rmSync(openedFile, { force: true });
    const saved = { CI: process.env.CI, SUPERSELF_ATTEMPT_ID: process.env.SUPERSELF_ATTEMPT_ID };
    delete process.env.CI;
    delete process.env.SUPERSELF_ATTEMPT_ID;
    let opened;
    try
    {
        opened = await approvedIn(box, demo, ["artifact", "open", meta.id], "");
    }
    finally
    {
        Object.entries(saved).forEach(([key, value]) => value === undefined ? undefined : (process.env[key] = value));
    }
    assert.equal(opened.code, 0, opened.out);
    assert.match(opened.printed, new RegExp(`opened dist/index\\.html \\(${meta.id}\\)`));
    // The launch is detached, so the stub's record is waited for rather than
    // read straight away — and waited for generously, because what the wait is
    // measuring is the machine's load, not the CLI.
    for (let tries = 0; tries < 600 && !existsSync(openedFile); tries += 1)
    {
        await wait(25);
    }
    assert.ok(existsSync(openedFile), "the stub opener was never reached, so nothing was launched");
    assert.equal(readFileSync(openedFile, "utf8"), entryFile, "the launch was not aimed at the entry file");
});

test("cell 38: with no one at a terminal, artifact open prints the entry's absolute path and launches nothing", () =>
{
    const { work } = attach(["--artifact", tree("dist", { "index.html": "hi", "a.txt": "a" })]);
    const meta = attached(work)[0];
    const printed = must(box, demo, ["artifact", "open", meta.id], { SUPERSELF_SESSION: "s" }).out;
    assert.equal(printed.split(" — ")[0], join(store, meta.path, "index.html"));
    assert.match(printed, new RegExp(`dist/index\\.html \\(${meta.id}\\) resolves to that path`));
});

test("cell 39: a bundle whose entry is not in this store is refused, naming the bundle and self sync", () =>
{
    const { work } = attach(["--artifact", tree("dist", { "index.html": "hi" })]);
    const meta = attached(work)[0];
    chmodSync(join(store, meta.path), 0o700);
    rmSync(join(store, meta.path, "index.html"), { force: true });
    const { code, out } = selfIn(box, demo, ["artifact", "open", meta.id]);
    assert.equal(code, 1, out);
    assert.match(out, new RegExp(`artifact file ${meta.path} is missing from this store`));
    assert.match(out, /run `self sync` to fetch it/);
});

/* ── 40–44: what the record says afterwards ────────────────────────── */

test("cell 40: work show and the folded work document both state the bundle as one row with no digest", () =>
{
    const shown = must(reading.box, reading.ws, ["work", "show", readingBundle.work]).out;
    const expected = `${readingBundle.bundle.id} dist/ (12 files)`;
    assert.ok(shown.includes(expected), `work show did not state the bundle as one row:\n${shown}`);
    assert.ok(!shown.includes(`${readingBundle.bundle.id} dist/ (12 files) (`), "a bundle printed a digest");
    const document = readFileSync(join(reading.ws, ".superself", "projects", "demo", "work", `${readingBundle.work}.md`), "utf8");
    assert.ok(document.includes(expected), `the folded work document did not state the bundle as one row:\n${document}`);
});

test("cell 41: self search on a member name resolves to the work unit that carries it", () =>
{
    const found = must(reading.box, reading.demo, ["search", "logo.svg"]).out;
    assert.ok(found.includes(readingBundle.work), `a member name did not reach its work unit:\n${found}`);
    assert.match(found, /^1 match$/m);
});

test("cell 42: the HTML views link a bundle to its entry, with a folder plate and the file count", () =>
{
    const view = join(reading.ws, ".superself", "view", "demo");
    const page = readFileSync(join(view, "artifacts.html"), "utf8");
    assert.ok(page.includes(`href="../../${readingBundle.bundle.path}/index.html"`), "the artifact card did not link to the entry");
    assert.ok(page.includes("af-dir"), "the artifact card did not draw a folder plate");
    assert.ok(page.includes("dist/ (12 files)"), "the artifact card did not show the file count");
    const workPage = readFileSync(join(view, `${readingBundle.work}.html`), "utf8");
    assert.ok(workPage.includes(`href="../../${readingBundle.bundle.path}/index.html"`));
    assert.ok(workPage.includes("dr-dir"));
    assert.ok(workPage.includes("dist/ (12 files)"));
});

test("cell 43: a member edited in the store raises one signal naming the artifact id and that member's path", () =>
{
    const { work } = attach(["--artifact", tree("dist", { "index.html": "hi", "assets/logo.svg": "<svg/>" })]);
    const meta = attached(work)[0];
    writeFileSync(join(store, meta.path, "assets", "logo.svg"), "<svg>edited</svg>");
    const status = must(box, demo, ["status"]).out;
    assert.ok(status.includes(`artifact ${meta.id} dist member assets/logo.svg no longer matches the digest`),
        `no signal named the edited member:\n${status}`);
    assert.equal(status.split("assets/logo.svg").length - 1, 1, "one edited member raised more than one signal");
});

test("cell 44: a member deleted from the store raises one missing signal pointing at self sync", () =>
{
    const { work } = attach(["--artifact", tree("dist", { "index.html": "hi", "assets/logo.svg": "<svg/>" })]);
    const meta = attached(work)[0];
    rmSync(join(store, meta.path, "assets", "logo.svg"), { force: true });
    const status = must(box, demo, ["status"]).out;
    assert.ok(status.includes(`artifact ${meta.id} dist member assets/logo.svg is missing from this store — run \`self sync\``),
        `no signal named the missing member:\n${status}`);
});

/* ── 45, 52: a CLI that does not know the manifest ─────────────────── */

// "A CLI that does not know `members`" is approximated by taking the field out
// of the reader's view: the event is rewritten without `members` and `entry`,
// which is all a fold written before #362 would have kept of it, and the bytes
// this CLI staged are left standing in the store.
function forgetManifest(place, reportId)
{
    const file = join(place.ws, ".superself", "projects", "demo", "log.jsonl");
    const was = readFileSync(file, "utf8");
    const lines = was.split("\n").map((line) =>
    {
        if (line.trim() === "")
        {
            return line;
        }
        const event = JSON.parse(line);
        if (event.id !== reportId)
        {
            return line;
        }
        event.payload.artifacts.forEach((meta) => { delete meta.members; delete meta.entry; });
        return JSON.stringify(event);
    });
    writeFileSync(file, lines.join("\n"));
    foldProject(join(place.ws, ".superself"), "demo");
    return () =>
    {
        writeFileSync(file, was);
        foldProject(join(place.ws, ".superself"), "demo");
    };
}

test("cell 45: a bundle event read without its manifest lists as one directory row, opens the directory, and raises no signal", () =>
{
    const place = freshMachine();
    const root = join(place.box.root, "dist");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "hi");
    writeFileSync(join(root, "assets", "app.js"), "j");
    const work = workIdIn(must(place.box, place.demo, ["work", "add", "older reader"]).out);
    must(place.box, place.demo, ["report", work, "attached", "--artifact", root]);
    const placeLog = join(place.ws, ".superself", "projects", "demo", "log.jsonl");
    const report = eventsIn(placeLog).find((event) => event.type === "report.added");
    forgetManifest(place, report.id);
    const meta = report.payload.artifacts[0];
    const listed = must(place.box, place.ws, ["artifact", "list"]).out;
    assert.match(listed, /  dist$/m, "an unread manifest still printed a file count");
    assert.ok(!listed.includes("files)"));
    const opened = must(place.box, place.demo, ["artifact", "open", meta.id], { SUPERSELF_SESSION: "s" }).out;
    assert.equal(opened.split(" — ")[0], join(realpathSync(join(place.ws, ".superself")), meta.path));
    assert.match(must(place.box, place.demo, ["status"]).out, /health: ok/);
});

test("cell 52: a design report whose manifest is not read refuses confirm, and the newer CLI still confirms it", async () =>
{
    const place = freshMachine();
    const root = join(place.box.root, "design");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.md"), "the design");
    const decision = idIn(must(place.box, place.demo, ["decide", "cell 52: a design binds bytes"]).out);
    const work = workIdIn(must(place.box, place.demo, ["work", "add", "older confirm"]).out);
    const submitted = must(place.box, place.demo, ["report", work, "the design", "--design",
        "--implements", decision, "--artifact", root]);
    const report = submitted.out.match(/design report (\S+) recorded/)[1];
    const placeLog = join(place.ws, ".superself", "projects", "demo", "log.jsonl");
    const meta = eventsIn(placeLog).find((event) => event.id === report).payload.artifacts[0];
    const restore = forgetManifest(place, report);
    const refused = selfIn(place.box, place.demo, ["report", "confirm", report]);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /carries no artifact digest/);
    assert.ok(!eventsIn(placeLog).some((event) => event.type === "report.confirmed"), "the refusal still recorded something");
    restore();
    const approved = await approvedIn(place.box, place.demo, ["report", "confirm", report], manifestDigest(meta).slice(0, 12));
    assert.equal(approved.code, 0, approved.out);
    assert.equal(eventsIn(placeLog).at(-1).payload.digest, manifestDigest(meta));
});

/* ── 46: the single-file path is untouched ─────────────────────────── */

test("cell 46: an existing single-file artifact folds, lists, searches, opens and shows exactly as before", () =>
{
    const { work } = attach(["--artifact", fileAt("result.json", "{\"ok\":true}\n")]);
    const meta = attached(work)[0];
    assert.deepEqual(Object.keys(meta), ["id", "name", "path", "digest"]);
    assert.equal(meta.members, undefined);
    assert.equal(meta.entry, undefined);
    assert.equal(artifactName(meta), meta.name);
    const row = must(box, demo, ["artifact", "list", "--work", work]).out.split("\n")[0];
    assert.equal(row, `${meta.id}  ${reportFor(work).ts.slice(0, 10)}  demo  ${work}  ${meta.name}`);
    assert.match(must(box, demo, ["artifact", "search", meta.name]).out, new RegExp(`${meta.id}\\b`));
    const opened = must(box, demo, ["artifact", "open", meta.id], { SUPERSELF_SESSION: "s" }).out;
    assert.equal(opened.trim(),
        `${join(store, meta.path)} — ${meta.name} (${meta.id}) resolves to that path; `
        + "nobody is at a terminal in this run, so the GUI launch was suppressed");
    assert.ok(must(box, demo, ["work", "show", work]).out.includes(`${meta.id} ${meta.name} (${meta.digest})`) === false);
    assert.ok(must(box, demo, ["work", "show", work]).out.includes(`- Artifacts: ${meta.id} ${meta.name}`));
});

/* ── 47–49: what the verbs resolve from outside their arguments ────── */

test("cell 47: --artifact ./dist resolves against the directory the command ran in", () =>
{
    const sub = join(demo, "sub");
    mkdirSync(join(sub, "dist", "assets"), { recursive: true });
    writeFileSync(join(sub, "dist", "index.html"), "hi");
    writeFileSync(join(sub, "dist", "assets", "app.js"), "j");
    const { work, code, out } = attach(["--artifact", "./dist"], sub);
    assert.equal(code, 0, out);
    const meta = attached(work)[0];
    assert.equal(meta.name, "dist");
    assert.deepEqual(memberPaths(meta), ["assets/app.js", "index.html"], "member paths were taken relative to the repository root");
});

test("cell 48: the bytes land under the owning log's slug, not the project the command ran in", () =>
{
    const place = freshMachine();
    const other = join(place.ws, "other");
    mkdirSync(other, { recursive: true });
    git(place.box, other, ["init", "-q", "-b", "main"]);
    must(place.box, other, ["project", "init", "--name", "other", "--no-connect"]);
    const work = workIdIn(must(place.box, place.demo, ["work", "add", "shared outcome"]).out);
    must(place.box, place.demo, ["state", "place", work, "--scope", "workspace"]);
    const root = join(place.box.root, "dist");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "hi");
    const result = selfIn(place.box, other, ["report", work, "attached", "--artifact", root]);
    assert.equal(result.code, 0, result.out);
    const placeLog = join(place.ws, ".superself", "projects", "demo", "log.jsonl");
    const meta = eventsIn(placeLog).find((event) => event.type === "report.added" && event.refs.work === work).payload.artifacts[0];
    assert.match(meta.path, /^artifacts\/demo\//, "a bundle landed under the running project rather than the owner");
    assert.ok(existsSync(join(place.ws, ".superself", meta.path, "index.html")));
});

test("cell 49: the empty listing's advertised command is unchanged, and is refused outside a project", () =>
{
    const place = freshMachine();
    const outside = join(place.box.root, "nowhere");
    mkdirSync(outside, { recursive: true });
    const empty = must(place.box, place.ws, ["artifact", "list"]).out;
    assert.ok(empty.includes('no artifacts — attach one with `self report <work-id> "…" --artifact <path>`'),
        `the empty listing's advertisement changed:\n${empty}`);
    const work = workIdIn(must(place.box, place.demo, ["work", "add", "outside outcome"]).out);
    const refused = selfIn(place.box, outside, ["report", work, "attached", "--artifact", place.demo]);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /not inside a registered project — run `self project init` here/);
});

/* ── 50: completion ────────────────────────────────────────────────── */

test("cell 50: work done accepts a unit whose only evidence is a bundle", () =>
{
    const place = freshMachine();
    const root = join(place.box.root, "dist");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), "the deliverable");
    const work = workIdIn(must(place.box, place.demo, ["work", "add", "done by bundle"]).out);
    must(place.box, place.demo, ["report", work, "the deliverable", "--artifact", root]);
    const done = selfIn(place.box, place.demo, ["work", "done", work]);
    assert.equal(done.code, 0, done.out);
});
