// `self artifact prune` removes a stored artifact's bytes and keeps the record
// that names them (#239, the removal half). One test per cell of the case table
// in docs/maintainers/case-tables/239-artifact-prune.md, named by its cell
// number, asserting that cell's stated outcome. The table is the review
// surface: a cell it lacks is a path nothing proves.
//
// Five cells carry a second number. #238's table deferred its removal cells to
// this branch, and where a row of that table and a row of this one are the same
// state and the same outcome, one test answers for both rather than two tests
// drifting apart.
//
// Nothing here reaches a keyboard: `approvedIn` runs the command in-process
// with the typed answer supplied, which is the only way the approved branch of
// a human gate can run at all. The refusals are asserted through `selfIn`,
// which spawns a child that faces the real terminal check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { artifactId, ulid } from "../dist/ids.js";
import { approvedIn, demoWorkspace, git, idIn, logFixture, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);
// Resolved: the temporary root is reached through /var on macOS and the CLI
// answers in the /private/var the kernel gives it.
const store = realpathSync(join(ws, ".superself"));

const WHY = "the output is reproducible from the commit it was built at";

let seq = 0;

/* ── the sources a cell prunes ─────────────────────────────────────── */

function fileAt(name, body)
{
    seq += 1;
    const path = join(box.root, "files", `f${seq}-${name}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
}

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

function sha256(body)
{
    return createHash("sha256").update(body).digest("hex");
}

function logPath(project = "demo", at = ws)
{
    return join(at, ".superself", "projects", project, "log.jsonl");
}

function events(project = "demo", at = ws)
{
    const file = logPath(project, at);
    const raw = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    return raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line));
}

function unit(at = demo)
{
    seq += 1;
    return workIdIn(must(box, at, ["work", "add", `outcome ${seq}`]).out);
}

// A report's artifact, read back off the event that recorded it: what the log
// holds is what every prune resolves against.
function attach(work, args, at = demo, project = "demo")
{
    must(box, at, ["report", work, "attached", ...args]);
    return events(project).filter((event) => event.type === "report.added" && event.refs?.work === work)
        .at(-1).payload.artifacts[0];
}

// A work unit whose outcome is closed and whose report carries one file: the
// floor state most cells prune from.
function closed(name, body = `${name} bytes\n`)
{
    const work = unit();
    const meta = attach(work, ["--artifact", fileAt(name, body)]);
    must(box, demo, ["work", "done", work]);
    return { work, meta };
}

function registered(name, body = `${name} bytes\n`)
{
    writeFileSync(join(demo, name), body);
    return must(box, demo, ["artifact", "add", name]).out.match(/\ba-[0-9a-z]{5}\b/)[0];
}

// A review's artifact. No verb writes `review.received` — it is a retired
// namespace the registry still reads — so the bytes are placed and the line is
// appended the way a pre-cutover log holds them.
function reviewed(work, name, body = `${name} bytes\n`)
{
    const meta = { id: artifactId(), name, path: `artifacts/demo/${artifactId()}-${name}`, digest: sha256(body) };
    mkdirSync(join(store, "artifacts", "demo"), { recursive: true });
    writeFileSync(join(store, meta.path), body);
    logFixture(ws, "demo", {
        id: ulid(),
        ts: new Date().toISOString(),
        type: "review.received",
        origin: { actor: "agent", confirmed: false },
        project: "demo",
        payload: { receipt: `rc-${seq += 1}`, verdict: "pass", scope: "code", changeSet: "cs-1", artifact: meta },
        ...(work === undefined ? {} : { refs: { work } })
    });
    return meta;
}

/* ── running the prune ─────────────────────────────────────────────── */

function prune(id, answer = id, extra = [])
{
    return approvedIn(box, demo, ["artifact", "prune", id, "--why", WHY, ...extra], answer);
}

function refuse(id, extra = [], at = demo)
{
    return selfIn(box, at, ["artifact", "prune", id, "--why", WHY, ...extra]);
}

function stored(meta)
{
    return join(store, typeof meta === "string" ? meta : meta.path);
}

function pruneEvents(project = "demo")
{
    return events(project).filter((event) => event.type === "artifact.pruned");
}

function storeSize(at = demo)
{
    return JSON.parse(must(box, at, ["store", "size", "--json"]).out);
}

function storeCommits(at = ws)
{
    return Number(execFileSync("git", ["-C", join(at, ".superself"), "rev-list", "--count", "HEAD"],
        { env: box.env, encoding: "utf8" }).trim());
}

/* ── 30–35: where the bytes came from ──────────────────────────────── */

test("cell 30: a report's artifact on a done unit is removed, and the unit stays done", async () =>
{
    const { work, meta } = closed("cell30.md");
    const answer = await prune(meta.id);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(existsSync(stored(meta)), false, "the bytes stayed after a confirmed prune");
    assert.match(answer.out, /pruned — the record is kept and its bytes are not/);
    const shown = must(box, demo, ["work", "show", work]).out;
    assert.match(shown, /done/, "pruning evidence reopened a closed outcome");
    assert.match(must(box, demo, ["artifact", "list"]).out, new RegExp(`${meta.id}.*\\(pruned\\)`));
});

test("cell 31: a review's artifact on a done unit is removed, and the verdict stays recorded", async () =>
{
    const work = unit();
    const meta = reviewed(work, "cell31.md");
    must(box, demo, ["report", work, "the work happened", "--artifact", fileAt("cell31-evidence.md", "cell 31 evidence\n")]);
    must(box, demo, ["work", "done", work]);
    const answer = await prune(meta.id);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(existsSync(stored(meta)), false, "a review artifact's bytes stayed");
    const review = events().find((event) => event.type === "review.received" && event.payload.artifact?.id === meta.id);
    assert.equal(review.payload.verdict, "pass", "the verdict the bytes were judged under was lost with them");
});

test("cell 32: a review's artifact on an open unit is refused", () =>
{
    const work = unit();
    const meta = reviewed(work, "cell32.md");
    must(box, demo, ["work", "start", work]);
    const refused = refuse(meta.id);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, new RegExp(`${meta.id} is evidence on ${work}, which is active`));
    assert.equal(existsSync(stored(meta)), true, "a refused prune removed bytes");
});

test("cell 33: a review naming no work unit is refused, and says that is the reason", () =>
{
    const meta = reviewed(undefined, "cell33.md");
    const refused = refuse(meta.id);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /came in on a review that names no work unit/);
    assert.equal(existsSync(stored(meta)), true);
});

test("cell 34: bytes registered on their own, with no record pointing at them, are removed", async () =>
{
    const artifact = registered("cell34.md");
    const path = events().filter((event) => event.type === "artifact.registered").at(-1).payload.artifacts[0].path;
    const answer = await prune(artifact);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(existsSync(stored(path)), false);
});

test("cell 35 (#238 cell 39): a live record pointing at the artifact refuses the prune, naming the record", () =>
{
    const artifact = registered("cell35.md");
    const entity = must(box, demo, ["state", "add", "read the cell 35 guide", "--exposure", "full", "--artifact", artifact])
        .out.match(/\be-[0-9a-z]{5}\b/)[0];
    const refused = refuse(artifact);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, new RegExp(`${artifact} is what ${entity} points at, and that record is still live`));
    assert.equal(pruneEvents().some((event) => event.payload.artifact === artifact), false);
});

/* ── 36–41: the state of the outcome the evidence belongs to ───────── */

// The six-value work vocabulary, one cell each, through one helper: the state
// is the only thing that differs between them, so the assertion should be too.
function refusedInState(name, move)
{
    const work = unit();
    const meta = attach(work, ["--artifact", fileAt(name, `${name} bytes\n`)]);
    move(work);
    const refused = refuse(meta.id);
    assert.equal(refused.code, 1, refused.out);
    assert.equal(existsSync(stored(meta)), true, "a refused prune removed bytes");
    assert.equal(pruneEvents().some((event) => event.payload.artifact === meta.id), false, "a refused prune wrote an event");
    return { work, meta, refused };
}

test("cell 36: evidence on a unit nobody has started is refused", () =>
{
    const { work, refused } = refusedInState("cell36.md", () => {});
    assert.match(refused.out, new RegExp(`is evidence on ${work}, which is next`));
});

test("cell 37: evidence on an active unit is refused", () =>
{
    const { work, refused } = refusedInState("cell37.md", (id) => must(box, demo, ["work", "start", id]));
    assert.match(refused.out, new RegExp(`is evidence on ${work}, which is active`));
});

test("cell 38: evidence on a blocked unit is refused", () =>
{
    const { work, refused } = refusedInState("cell38.md",
        (id) => must(box, demo, ["work", "block", id, "--on", "dependency", "--why", "waiting on the upstream fix"]));
    assert.match(refused.out, new RegExp(`is evidence on ${work}, which is blocked`));
});

test("cell 39: evidence on a unit whose plan is awaiting review is refused", () =>
{
    const work = workIdIn(must(box, demo, ["work", "propose", "review the flow before it is worked"]).out);
    must(box, demo, ["work", "accept", work]);
    const meta = attach(work, ["--artifact", fileAt("cell39.md", "cell 39 bytes\n")]);
    must(box, demo, ["work", "revise", work, "review the flow, then work it", "--why", "the first plan skipped the review"]);
    const refused = refuse(meta.id);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, new RegExp(`is evidence on ${work}, which is review`));
    assert.equal(existsSync(stored(meta)), true);
});

test("cell 40: evidence on a retired unit is removed — an outcome given up is closed too", async () =>
{
    const work = unit();
    const meta = attach(work, ["--artifact", fileAt("cell40.md", "cell 40 bytes\n")]);
    const retired = await approvedIn(box, demo, ["work", "retire", work, "--why", "the outcome moved elsewhere"], work);
    assert.equal(retired.code, 0, retired.out);
    const answer = await prune(meta.id);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(existsSync(stored(meta)), false);
});

test("cell 41: an artifact in an archived project is refused, and the way back is named", () =>
{
    const beta = join(ws, "beta");
    mkdirSync(beta, { recursive: true });
    git(box, beta, ["init", "-q", "-b", "main"]);
    must(box, beta, ["project", "init", "--name", "beta", "--desc", "the archived project"]);
    const work = workIdIn(must(box, beta, ["work", "add", "an outcome of beta"]).out);
    const meta = attach(work, ["--artifact", fileAt("cell41.md", "cell 41 bytes\n")], beta, "beta");
    must(box, beta, ["work", "done", work]);
    must(box, ws, ["project", "archive", "beta", "--why", "nobody is working on it"]);
    const refused = refuse(meta.id, ["--project", "beta"], ws);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /project "beta" is archived[\s\S]*self project restore beta/);
    assert.equal(existsSync(stored(meta)), true);
});

/* ── 42–45: two records, one stored path ───────────────────────────── */

// The state cells 42, 44 and 45 read: the same bytes attached twice, so one
// stored path carries two records, each with its own id (#372 cell 2).
const sharedBody = "cells 42 to 45 share these bytes\n";
const shared = { first: null, second: null };

test("cell 42: the first of two records naming one path is pruned and no byte is reclaimed", async () =>
{
    shared.first = closed("cell42-first.md", sharedBody).meta;
    shared.second = closed("cell42-second.md", sharedBody).meta;
    assert.equal(shared.second.path, shared.first.path, "the fixture did not produce a shared path");
    const answer = await prune(shared.first.id);
    assert.equal(answer.code, 0, answer.out);
    assert.match(answer.out, /1 other live record still names/);
    assert.equal(existsSync(stored(shared.first)), true, "bytes another live record names were removed");
    assert.equal(pruneEvents().find((event) => event.payload.artifact === shared.first.id).payload.bytesRemoved, false);
});

test("cell 43: the last live record naming a path is the prune that reclaims the bytes", async () =>
{
    const body = "cell 43 shares these bytes\n";
    const one = closed("cell43-one.md", body).meta;
    const two = closed("cell43-two.md", body).meta;
    assert.equal(two.path, one.path);
    assert.equal((await prune(one.id)).code, 0);
    assert.equal(existsSync(stored(one)), true, "the first prune of a shared path reclaimed bytes");
    const answer = await prune(two.id);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(existsSync(stored(two)), false, "the last live record's prune left the bytes");
    assert.match(answer.out, /bytes reclaimed from the working tree/);
    assert.equal(pruneEvents().find((event) => event.payload.artifact === two.id).payload.bytesRemoved, true);
});

test("cell 44: a pruned record does not open, even while another record's bytes are still there", () =>
{
    assert.equal(existsSync(stored(shared.first)), true, "cell 42 did not leave the bytes standing");
    const opened = selfIn(box, demo, ["artifact", "open", shared.first.id]);
    assert.equal(opened.code, 1, opened.out);
    assert.match(opened.out, new RegExp(`artifact ${shared.first.id} was pruned on \\d{4}-\\d{2}-\\d{2}: ${WHY}`));
    assert.doesNotMatch(opened.out, /self sync/, "a removal offered a sync that will never bring it back");
    assert.equal(selfIn(box, demo, ["artifact", "open", shared.second.id]).code, 0, "the live record stopped opening");
});

test("cell 45: bytes a live record still names are not orphaned by the other record's prune", () =>
{
    const orphans = storeSize().orphans;
    assert.equal(orphans.top.some((item) => item.name === shared.first.path), false,
        "a path a live record names was reported as orphaned");
    assert.equal(orphans.files, 0, "a prune that reclaimed nothing left the store reporting orphans");
});

/* ── 46–51: the gate, and what is refused before it ────────────────── */

test("cell 46: bytes a design approval named are refused, whatever the unit's state", async () =>
{
    const body = "# cell 46\n\nthe design body\n";
    const decision = idIn(must(box, demo, ["decide", "cell 46: designs bind to a hash"]).out);
    const work = unit();
    const submitted = must(box, demo, ["report", work, "cell 46 design", "--design",
        "--implements", decision, "--artifact", fileAt("cell46-design.md", body)]);
    const report = submitted.out.match(/design report (\S+) recorded/)[1];
    const meta = events().find((event) => event.id === report).payload.artifacts[0];
    assert.equal((await approvedIn(box, demo, ["report", "confirm", report], meta.digest.slice(0, 12))).code, 0);
    must(box, demo, ["work", "done", work]);
    const refused = refuse(meta.id);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, new RegExp(`holds the bytes a person approved as the design of ${work} ${report}`));
    assert.equal(existsSync(stored(meta)), true);
});

test("cell 47 (#238 cell 40): once the record pointing at it is retracted, the bytes are removable", async () =>
{
    const artifact = registered("cell47.md");
    const entity = must(box, demo, ["state", "add", "read the cell 47 guide", "--exposure", "full", "--artifact", artifact])
        .out.match(/\be-[0-9a-z]{5}\b/)[0];
    assert.equal(refuse(artifact).code, 1);
    assert.equal((await approvedIn(box, demo, ["state", "retract", entity, "--why", "the guide is folded into the rule"], entity)).code, 0);
    const answer = await prune(artifact);
    assert.equal(answer.code, 0, answer.out);
});

test("cell 48: a second prune of the same record is refused and records nothing", async () =>
{
    const { meta } = closed("cell48.md");
    assert.equal((await prune(meta.id)).code, 0);
    const before = pruneEvents().length;
    const again = refuse(meta.id);
    assert.equal(again.code, 1, again.out);
    assert.match(again.out, new RegExp(`${meta.id} was already pruned on \\d{4}-\\d{2}-\\d{2}`));
    assert.equal(pruneEvents().length, before, "a refused second prune wrote an event");
});

test("cell 49: a process with nobody at a terminal is refused, records nothing, and removes nothing", async () =>
{
    const { meta } = closed("cell49.md");
    const piped = refuse(meta.id);
    assert.equal(piped.code, 1, piped.out);
    assert.match(piped.out, /removing stored bytes is a person's call, and this process has no terminal/);
    assert.match(piped.out, new RegExp(`self artifact prune ${meta.id} --why`));
    // The other half of "nobody is answering": a process a runner started
    // carries the marker, and is refused even where a terminal is attached —
    // which is the case a piped child cannot tell apart on its own.
    process.env.SUPERSELF_SESSION = "a-runner";
    const marked = await prune(meta.id);
    delete process.env.SUPERSELF_SESSION;
    assert.equal(marked.code, 1, marked.out);
    assert.match(marked.out, /has no terminal to make it at/);
    assert.equal(pruneEvents().some((event) => event.payload.artifact === meta.id), false);
    assert.equal(existsSync(stored(meta)), true);
});

test("cell 50: an answer that is not the artifact id records nothing and removes nothing", async () =>
{
    const { meta } = closed("cell50.md");
    const mistyped = await prune(meta.id, "a-wrong");
    assert.equal(mistyped.code, 1, mistyped.out);
    assert.match(mistyped.out, new RegExp(`the typed confirmation is not ${meta.id}`));
    assert.equal(pruneEvents().some((event) => event.payload.artifact === meta.id), false);
    assert.equal(existsSync(stored(meta)), true);
});

test("cell 51: a prune with no reason is refused by the contract, before anything is resolved", () =>
{
    const { meta } = closed("cell51.md");
    const refused = selfIn(box, demo, ["artifact", "prune", meta.id]);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /self artifact prune needs --why/);
    assert.equal(existsSync(stored(meta)), true);
});

/* ── 52–53: the removal itself ─────────────────────────────────────── */

test("cell 52: a removal that fails after the event still folds, commits and succeeds", async () =>
{
    const work = unit();
    const meta = attach(work, ["--artifact", tree("cell52", { "a.txt": "cell 52", "b.txt": "cell 52 too" })]);
    must(box, demo, ["work", "done", work]);
    const before = storeCommits();
    // The bundle's own directory is read-only for the length of the command, so
    // `rmSync` fails with the event already appended — the crash window the
    // write order exists to survive.
    chmodSync(stored(meta), 0o555);
    const answer = await prune(meta.id);
    chmodSync(stored(meta), 0o755);
    assert.equal(answer.code, 0, `a removal that failed after the record was durable exited non-zero:\n${answer.out}`);
    assert.match(answer.out, new RegExp(`the record is pruned and ${meta.path} could not be removed`));
    assert.match(answer.out, /store size` reports those bytes as orphaned/);
    assert.equal(existsSync(stored(meta)), true, "the fixture removed the bytes after all");
    assert.equal(storeCommits(), before + 1, "the fold and the commit were skipped");
    const recorded = pruneEvents().find((event) => event.payload.artifact === meta.id);
    assert.equal(recorded.payload.bytesRemoved, true, "the event claimed to have kept bytes it meant to remove");
    const orphans = storeSize().orphans;
    assert.equal(orphans.top.some((item) => item.name === meta.path), true,
        "bytes that outlived their record are not reported as orphaned");
});

test("cell 53: a bundle is removed whole, and its manifest stays on the record", async () =>
{
    const work = unit();
    const meta = attach(work, ["--artifact", tree("cell53", { "a.txt": "cell 53", "sub/b.txt": "cell 53 too" })]);
    must(box, demo, ["work", "done", work]);
    assert.equal((await prune(meta.id)).code, 0);
    assert.equal(existsSync(stored(meta)), false, "a bundle's directory survived its prune");
    const recorded = events().filter((event) => event.type === "report.added" && event.refs?.work === work)
        .at(-1).payload.artifacts[0];
    assert.equal(recorded.members.length, meta.members.length, "the manifest went with the bytes");
    assert.match(must(box, demo, ["artifact", "list"]).out, new RegExp(`${meta.id}.*cell53/ \\(3 files\\) \\(pruned\\)`));
});

/* ── 54–58: what every reader answers afterwards ───────────────────── */

test("cell 54: opening a pruned artifact says when and why, and offers no sync", async () =>
{
    const { meta } = closed("cell54.md");
    assert.equal((await prune(meta.id)).code, 0);
    const opened = selfIn(box, demo, ["artifact", "open", meta.id]);
    assert.equal(opened.code, 1, opened.out);
    assert.match(opened.out, new RegExp(`was pruned on \\d{4}-\\d{2}-\\d{2}: ${WHY}`));
    assert.doesNotMatch(opened.out, /self sync/);
});

test("cell 55: a pruned artifact keeps its row in the listing, marked", async () =>
{
    const { meta } = closed("cell55.md");
    const before = must(box, demo, ["artifact", "list"]);
    assert.equal((await prune(meta.id)).code, 0);
    const after = must(box, demo, ["artifact", "list"]);
    assert.equal(after.out.split("\n").length, before.out.split("\n").length, "a pruned record lost its row");
    assert.match(after.out, new RegExp(`${meta.id}.*cell55\\.md \\(pruned\\)`));
});

test("cell 56: a pruned artifact is still found by search, marked", async () =>
{
    const { meta } = closed("cell56.md");
    assert.equal((await prune(meta.id)).code, 0);
    const found = must(box, demo, ["artifact", "search", "cell56"]);
    assert.match(found.out, new RegExp(`${meta.id}.*cell56\\.md \\(pruned\\)`));
});

test("cell 57: a hand-written pruned line on an open unit's artifact silences the health signal", () =>
{
    const work = unit();
    const meta = attach(work, ["--artifact", fileAt("cell57.md", "cell 57 bytes\n")]);
    rmSync(stored(meta));
    const before = must(box, demo, ["status"]).out.split("\n").filter((line) => line.includes(meta.id));
    assert.equal(before.length, 1, "the missing file was not reported before the guard was given anything to do");
    logFixture(ws, "demo", {
        id: ulid(),
        ts: new Date().toISOString(),
        type: "artifact.pruned",
        origin: { actor: "agent", confirmed: true },
        project: "demo",
        payload: { artifact: meta.id, why: "written by hand, which no verb does", bytesRemoved: true },
        refs: { artifacts: [meta.id], work }
    });
    const after = must(box, demo, ["status"]).out.split("\n").filter((line) => line.includes(meta.id));
    assert.deepEqual(after, [], "a fold told the reader to sync a file somebody removed on purpose");
});

test("cell 58: another clone gets the record and the removal in one pull", async () =>
{
    const originBox = machine();
    const origin = demoWorkspace(originBox);
    const remote = join(originBox.root, "remote.git");
    execFileSync("git", ["init", "--bare", "-q", remote], { env: originBox.env });
    must(originBox, origin.ws, ["remote", "add", remote]);
    const work = workIdIn(must(originBox, origin.demo, ["work", "add", "a shared outcome"]).out);
    writeFileSync(join(origin.demo, "cell58.md"), "cell 58 bytes\n");
    must(originBox, origin.demo, ["report", work, "attached", "--artifact", "cell58.md"]);
    const meta = events("demo", origin.ws).filter((event) => event.type === "report.added").at(-1).payload.artifacts[0];
    must(originBox, origin.demo, ["work", "done", work]);
    must(originBox, origin.ws, ["sync"]);
    const cloneBox = machine();
    const target = join(cloneBox.root, "clone");
    must(cloneBox, cloneBox.root, ["clone", remote, target]);
    assert.equal(existsSync(join(target, ".superself", meta.path)), true, "the clone did not get the bytes to begin with");
    const answer = await approvedIn(originBox, origin.demo, ["artifact", "prune", meta.id, "--why", WHY], meta.id);
    assert.equal(answer.code, 0, answer.out);
    // The appended line and the removed file are one commit, which is what
    // makes the pull below atomic for the reader.
    const touched = execFileSync("git", ["-C", join(origin.ws, ".superself"), "show", "--name-status", "--format=", "HEAD"],
        { env: originBox.env, encoding: "utf8" });
    assert.match(touched, /^M\tprojects\/demo\/log\.jsonl$/m);
    assert.match(touched, new RegExp(`^D\t${meta.path}$`, "m"));
    must(originBox, origin.ws, ["sync"]);
    must(cloneBox, target, ["sync"]);
    assert.equal(existsSync(join(target, ".superself", meta.path)), false, "the pull left the removed bytes behind");
    assert.match(selfIn(cloneBox, target, ["artifact", "open", meta.id]).out, /was pruned on/);
});

/* ── 59–60: reading a prune from the outside ───────────────────────── */

test("cell 59: an id two projects both hold is refused as ambiguous until a project is named", async () =>
{
    const gamma = join(ws, "gamma");
    mkdirSync(gamma, { recursive: true });
    git(box, gamma, ["init", "-q", "-b", "main"]);
    must(box, gamma, ["project", "init", "--name", "gamma", "--desc", "the twin-id project"]);
    const { meta } = closed("cell59.md");
    const twin = { id: meta.id, name: "cell59.md", path: `artifacts/gamma/${meta.id}-cell59.md`, digest: sha256("gamma bytes\n") };
    mkdirSync(join(store, "artifacts", "gamma"), { recursive: true });
    writeFileSync(join(store, twin.path), "gamma bytes\n");
    logFixture(ws, "gamma", {
        id: ulid(),
        ts: new Date().toISOString(),
        type: "artifact.registered",
        origin: { actor: "agent", confirmed: false },
        project: "gamma",
        payload: { artifacts: [twin], why: "a twin id minted in another project" },
        refs: { artifacts: [twin.id] }
    });
    const refused = refuse(meta.id, [], ws);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, new RegExp(`artifact id "${meta.id}" names 2 stored files`));
    assert.equal(existsSync(stored(twin)), true);
    assert.equal((await prune(meta.id, meta.id, ["--project", "demo"])).code, 0);
    assert.equal(existsSync(stored(twin)), true, "naming one project removed the other project's bytes");
});

test("cell 60: a pruned review artifact is marked on the registry surfaces, which are the only ones it has", async () =>
{
    const work = unit();
    const meta = reviewed(work, "cell60.md");
    must(box, demo, ["report", work, "the work happened", "--artifact", fileAt("cell60-evidence.md", "cell 60 evidence\n")]);
    must(box, demo, ["work", "done", work]);
    assert.equal((await prune(meta.id)).code, 0);
    assert.match(must(box, demo, ["artifact", "list"]).out, new RegExp(`${meta.id}.*cell60\\.md \\(pruned\\)`));
    assert.match(selfIn(box, demo, ["artifact", "open", meta.id]).out, /was pruned on/);
    assert.doesNotMatch(must(box, demo, ["work", "show", work]).out, new RegExp(meta.id),
        "a review artifact was expected to render nowhere but the registry");
});

test("cell 61: the unit's own sections mark the record, and the gallery stops linking to it", async () =>
{
    const { work, meta } = closed("cell61.md");
    assert.ok(readFileSync(join(store, "view", "demo", "artifacts.html"), "utf8").includes(meta.id),
        "the artifact had no card to lose");
    assert.equal((await prune(meta.id)).code, 0);
    const packet = must(box, demo, ["handoff", work]).out;
    assert.match(packet, new RegExp(`- Artifacts: ${meta.id} ${meta.name} \\(pruned\\)`), "the unit's section did not mark it");
    assert.match(packet, new RegExp(`artifacts: ${meta.id} ${meta.name}.*\\(pruned\\)`), "the report's row did not mark it");
    assert.match(must(box, demo, ["work", "show", work]).out, new RegExp(`${meta.id} ${meta.name}.*\\(pruned\\)`));
    assert.equal(readFileSync(join(store, "view", "demo", "artifacts.html"), "utf8").includes(meta.id), false,
        "the gallery kept a card linking to bytes that are gone");
});

test("cell 62: a record naming a path inside another project is refused, and that project keeps its bytes", () =>
{
    const victim = closed("cell62.md").meta;
    const crafted = {
        id: artifactId(),
        name: "cell62.md",
        path: victim.path,
        digest: victim.digest
    };
    // A line no verb writes: gamma's log naming demo's stored bytes. It reaches
    // this store the way every foreign line does — through a shared remote — so
    // the delete path refuses it rather than following it.
    logFixture(ws, "gamma", {
        id: ulid(),
        ts: new Date().toISOString(),
        type: "artifact.registered",
        origin: { actor: "agent", confirmed: false },
        project: "gamma",
        payload: { artifacts: [crafted], why: "a path pointing into another project" },
        refs: { artifacts: [crafted.id] }
    });
    const refused = refuse(crafted.id, ["--project", "gamma"], ws);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, new RegExp(`is recorded at ${victim.path}, which is not inside project "gamma"`));
    assert.equal(existsSync(stored(victim)), true, "another project's bytes were removed by a crafted path");
});

/* ── #238's removal cells that needed this verb to exist ───────────── */

test("#238 cell 41: two records pointing at one artifact refuse it until both are dead", async () =>
{
    const artifact = registered("d238-41.md");
    const first = must(box, demo, ["state", "add", "the first rule", "--exposure", "full", "--artifact", artifact])
        .out.match(/\be-[0-9a-z]{5}\b/)[0];
    const second = must(box, demo, ["state", "add", "the second rule", "--exposure", "full", "--artifact", artifact])
        .out.match(/\be-[0-9a-z]{5}\b/)[0];
    const both = refuse(artifact);
    assert.equal(both.code, 1, both.out);
    assert.match(both.out, /those records are still live/);
    assert.ok(both.out.includes(first) && both.out.includes(second), `the refusal named neither record:\n${both.out}`);
    await approvedIn(box, demo, ["state", "retract", first, "--why", "folded into the second"], first);
    const one = refuse(artifact);
    assert.equal(one.code, 1, one.out);
    assert.match(one.out, new RegExp(`is what ${second} points at, and that record is still live`));
    await approvedIn(box, demo, ["state", "retract", second, "--why", "the guide is gone"], second);
    assert.equal((await prune(artifact)).code, 0);
});

test("#238 cell 42: an artifact that is both evidence and guidance must satisfy both before it goes", async () =>
{
    const { meta } = closed("d238-42.md");
    const rule = idIn(must(box, demo, ["convention", "add", "follow the cell 42 note", "--artifact", meta.id]).out);
    const refused = refuse(meta.id);
    assert.equal(refused.code, 1, refused.out, "a done unit's evidence went while a rule still pointed at it");
    assert.match(refused.out, /still live — retract or supersede it first/);
    await approvedIn(box, demo, ["convention", "drop", rule, "--why", "the note is folded into the rule itself"], rule);
    const answer = await prune(meta.id);
    assert.equal(answer.code, 0, answer.out);
    assert.equal(existsSync(stored(meta)), false);
});

test("#238 cell 45: a proposal is live, so the artifact it points at is refused", () =>
{
    const artifact = registered("d238-45.md");
    const proposal = must(box, demo,
        ["state", "add", "a proposed rule", "--exposure", "full", "--artifact", artifact, "--proposed"])
        .out.match(/\be-[0-9a-z]{5}\b/)[0];
    const refused = refuse(artifact);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, new RegExp(`is what ${proposal} points at, and that record is still live`));
});
