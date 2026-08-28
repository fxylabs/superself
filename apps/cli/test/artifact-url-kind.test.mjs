// An artifact can be a URL with a kind, attached to a work unit or milestone
// (#407). One test per cell of the case table in
// docs/maintainers/case-tables/407-artifact-url-kind.md, named by its cell
// number and asserting that cell's stated outcome. The table is the review
// surface: a cell the table lacks is a path nothing proves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../dist/ids.js";
import { approvedIn, demoWorkspace, git, logFixture, machine, must, selfIn, workIdIn } from "./harness.mjs";

const PR = "https://github.com/fxylabs/superself/pull/33";

const BRIEF = "https://example.com/briefs/tester-demo";

function idOf(text, prefix)
{
    const match = text.match(new RegExp(`\\b${prefix}-[0-9a-z]{5}\\b`));
    if (match === null)
    {
        throw new Error(`no ${prefix}- id in: ${text}`);
    }
    return match[0];
}

function eventIdIn(text)
{
    const match = text.match(/\[([0-9abcdefghjkmnpqrstvwxyz]{26})\]/);
    if (match === null)
    {
        throw new Error(`no event id in: ${text}`);
    }
    return match[1];
}

function events(ws, project = "demo")
{
    const file = join(ws, ".superself", "projects", project, "log.jsonl");
    const raw = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    return raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line));
}

function eventsOfType(ws, type, project = "demo")
{
    return events(ws, project).filter((event) => event.type === type);
}

function storedFiles(ws, project = "demo")
{
    const dir = join(ws, ".superself", "artifacts", project);
    return existsSync(dir) ? readdirSync(dir) : [];
}

// What `store size` says about artifacts, without the two numbers every
// appended line moves — the working tree and the git directory.
function sizeCounts(result)
{
    const size = JSON.parse(result.out);
    return {
        artifacts: size.artifacts, distinct: size.distinct,
        artifactBytes: size.artifactBytes, storedFiles: size.storedFiles
    };
}

// A workspace with one project and one file in it — the floor every cell
// below stands on.
async function floor()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    writeFileSync(join(demo, "guide.md"), "a guide no report is about\n");
    return { box, ws, demo };
}

async function added(box, demo, args)
{
    return idOf((await must(box, demo, ["artifact", "add", ...args])).out, "a");
}

async function aUnit(box, demo, outcome = "the flow works")
{
    return workIdIn((await must(box, demo, ["work", "add", outcome])).out);
}

async function aMilestone(box, demo)
{
    const objective = idOf((await must(box, demo, ["objective", "add", "an outcome"])).out, "o");
    return idOf((await must(box, demo,
        ["milestone", "add", "a checkpoint", "--objective", objective, "--exit", "the proof passes"])).out, "m");
}

// A second registered project in the same workspace, for the cells about the
// boundary between two of them.
async function secondProject(box, ws)
{
    const other = join(ws, "other");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    await must(box, other, ["project", "init", "--name", "other", "--desc", "the other project"]);
    return other;
}

/* ── A: what the input is ──────────────────────────────────────────── */

test("cell A1 — a plain file registers exactly as it always did", async () =>
{
    const { box, ws, demo } = await floor();
    const id = await added(box, demo, ["guide.md"]);
    const [event] = eventsOfType(ws, "artifact.registered");
    assert.equal(event.payload.artifacts[0].id, id);
    assert.equal(event.payload.artifacts[0].path, `artifacts/demo/${id}-guide.md`);
    assert.equal(storedFiles(ws).length, 1);
});

test("cell A2 — a directory is still one bundle", async () =>
{
    const { box, ws, demo } = await floor();
    mkdirSync(join(demo, "docs"));
    writeFileSync(join(demo, "docs", "one.md"), "one\n");
    writeFileSync(join(demo, "docs", "two.md"), "two\n");
    await added(box, demo, ["docs"]);
    const listed = (await must(box, demo, ["artifact", "list"])).out;
    assert.match(listed, /docs\/ \(3 files\)/);
    assert.equal(eventsOfType(ws, "artifact.linked").length, 0);
});

test("cell A3 — an https URL is one artifact.linked and no bytes", async () =>
{
    const { box, ws, demo } = await floor();
    const id = await added(box, demo, [PR]);
    const [event] = eventsOfType(ws, "artifact.linked");
    assert.deepEqual(event.payload.artifact, { id, name: PR, url: PR });
    assert.equal(event.payload.artifact.path, undefined);
    assert.deepEqual(event.refs.artifacts, [id]);
    assert.deepEqual(storedFiles(ws), []);
    assert.match((await must(box, demo, ["artifact", "list"])).out, new RegExp(`${id} {2}.*${"pull/33"}`));
});

test("cell A4 — an http URL is a link too, recorded as given", async () =>
{
    const { box, ws, demo } = await floor();
    await added(box, demo, ["http://example.com/x"]);
    assert.equal(eventsOfType(ws, "artifact.linked")[0].payload.artifact.url, "http://example.com/x");
});

test("cell A5 — another scheme is refused by name", async () =>
{
    const { box, ws, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", "ftp://host/x"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is not http or https/);
    assert.equal(events(ws).filter((event) => event.type.startsWith("artifact.")).length, 0);
});

test("cell A6 — a file:// URL is told to pass the path itself", async () =>
{
    const { box, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", "file:///tmp/x"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /pass the path they are at/);
});

test("cell A7 — a URL with no host is refused", async () =>
{
    const { box, ws, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", "https://"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /a link is a scheme, a host and a path/);
    assert.equal(eventsOfType(ws, "artifact.linked").length, 0);
});

test("cell A8 — a path that does not exist is refused as it always was", async () =>
{
    const { box, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", "nope.md"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /artifact "nope.md" does not exist/);
});

test("cell A9 — a host with no scheme is read as a path", async () =>
{
    const { box, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", "example.com/x"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /artifact "example.com\/x" does not exist/);
});

test("cell A10 — a URL carrying userinfo is refused", async () =>
{
    const { box, ws, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", "https://alice:hunter2@example.com/x"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /username or password/);
    assert.equal(eventsOfType(ws, "artifact.linked").length, 0);
});

test("cell A11 — a URL carrying a token is refused by the sanitizer", async () =>
{
    const { box, ws, demo } = await floor();
    const result = await selfIn(box, demo,
        ["artifact", "add", "https://example.com/x?token=ghp_0123456789abcdefghij"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /payload/);
    assert.doesNotMatch(result.out, /0123456789abcdefghij/);
    assert.equal(eventsOfType(ws, "artifact.linked").length, 0);
});

test("cell A12 — a URL is recorded as typed, never normalized", async () =>
{
    const { box, ws, demo } = await floor();
    await added(box, demo, ["https://example.com"]);
    assert.equal(eventsOfType(ws, "artifact.linked")[0].payload.artifact.url, "https://example.com");
});

test("cell A13 — the same URL twice is two records", async () =>
{
    const { box, ws, demo } = await floor();
    const first = await added(box, demo, [PR]);
    const second = await added(box, demo, [PR]);
    assert.notEqual(first, second);
    assert.equal(eventsOfType(ws, "artifact.linked").length, 2);
    assert.match((await must(box, demo, ["artifact", "list"])).out, /2 artifacts/);
});

test("cell A14 — --entry on a link is refused by name", async () =>
{
    const { box, ws, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", PR, "--entry", "index.html"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /a link has no members/);
    assert.equal(eventsOfType(ws, "artifact.linked").length, 0);
});

test("cell A15 — --why is the link's summary and search finds it", async () =>
{
    const { box, demo } = await floor();
    await added(box, demo, [PR, "--why", "the pull request that carries it"]);
    const hit = await must(box, demo, ["artifact", "search", "carries it"]);
    assert.match(hit.out, /1 artifact/);
});

/* ── B: --kind ─────────────────────────────────────────────────────── */

test("cell B1 — no --kind records none and lists as it always did", async () =>
{
    const { box, ws, demo } = await floor();
    const id = await added(box, demo, ["guide.md"]);
    assert.equal(eventsOfType(ws, "artifact.registered")[0].payload.kind, undefined);
    const listed = (await must(box, demo, ["artifact", "list"])).out;
    assert.match(listed, new RegExp(`${id} {2}[0-9-]{10} {2}demo {2}- {2}guide.md\n`));
});

test("cell B2 — --kind brief on a path is recorded and marked in the listing", async () =>
{
    const { box, ws, demo } = await floor();
    await added(box, demo, ["guide.md", "--kind", "brief"]);
    assert.equal(eventsOfType(ws, "artifact.registered")[0].payload.kind, "brief");
    assert.match((await must(box, demo, ["artifact", "list"])).out, /guide\.md \[brief\]/);
});

test("cell B3 — --kind pr on a URL is recorded", async () =>
{
    const { box, ws, demo } = await floor();
    await added(box, demo, [PR, "--kind", "pr"]);
    assert.equal(eventsOfType(ws, "artifact.linked")[0].payload.kind, "pr");
});

test("cell B4 — --kind resource is recorded", async () =>
{
    const { box, ws, demo } = await floor();
    await added(box, demo, ["guide.md", "--kind", "resource"]);
    assert.equal(eventsOfType(ws, "artifact.registered")[0].payload.kind, "resource");
});

test("cell B5 — --kind doc is recorded", async () =>
{
    const { box, ws, demo } = await floor();
    await added(box, demo, [BRIEF, "--kind", "doc"]);
    assert.equal(eventsOfType(ws, "artifact.linked")[0].payload.kind, "doc");
});

test("cell B6 — an unknown kind is refused with the list, and nothing is stored", async () =>
{
    const { box, ws, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", "guide.md", "--kind", "sketch"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /--kind takes one of brief, pr, resource, doc/);
    assert.equal(events(ws).filter((event) => event.type.startsWith("artifact.")).length, 0);
    assert.deepEqual(storedFiles(ws), []);
});

test("cell B7 — --kind twice is refused by name", async () =>
{
    const { box, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", "guide.md", "--kind", "doc", "--kind", "brief"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /--kind names what an artifact is and was passed 2 times/);
});

/* ── C: --for ──────────────────────────────────────────────────────── */

test("cell C1 — no --for leaves the work column a dash", async () =>
{
    const { box, ws, demo } = await floor();
    await added(box, demo, ["guide.md"]);
    assert.equal(eventsOfType(ws, "artifact.registered")[0].refs.work, undefined);
    assert.match((await must(box, demo, ["artifact", "list"])).out, / demo {2}- {2}guide\.md/);
});

test("cell C2 — a path attached to a unit is found by artifact list --work", async () =>
{
    const { box, ws, demo } = await floor();
    const unit = await aUnit(box, demo);
    const id = await added(box, demo, ["guide.md", "--for", unit]);
    assert.equal(eventsOfType(ws, "artifact.registered")[0].refs.work, unit);
    assert.match((await must(box, demo, ["artifact", "list", "--work", unit])).out, new RegExp(`${id}.*${unit}`));
});

test("cell C3 — a link attached to a unit carries refs.work too", async () =>
{
    const { box, ws, demo } = await floor();
    const unit = await aUnit(box, demo);
    const id = await added(box, demo, [PR, "--for", unit, "--kind", "pr"]);
    assert.equal(eventsOfType(ws, "artifact.linked")[0].refs.work, unit);
    assert.match((await must(box, demo, ["artifact", "list", "--work", unit])).out, new RegExp(id));
});

test("cell C4 — a milestone attachment rides on the payload, not on refs.work", async () =>
{
    const { box, ws, demo } = await floor();
    const milestone = await aMilestone(box, demo);
    await added(box, demo, [BRIEF, "--for", milestone, "--kind", "brief"]);
    const [event] = eventsOfType(ws, "artifact.linked");
    assert.equal(event.payload.entity, milestone);
    assert.equal(event.refs.work, undefined);
    assert.match((await must(box, demo, ["artifact", "list"])).out, / demo {2}- {2}https:/);
});

test("cell C5 — an unknown work id refuses before a byte is written", async () =>
{
    const { box, ws, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", "guide.md", "--for", "w-zzzzz"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown work unit "w-zzzzz" in project "demo"/);
    assert.equal(events(ws).filter((event) => event.type.startsWith("artifact.")).length, 0);
    assert.deepEqual(storedFiles(ws), []);
});

test("cell C6 — an unknown milestone id is refused", async () =>
{
    const { box, ws, demo } = await floor();
    const result = await selfIn(box, demo, ["artifact", "add", "guide.md", "--for", "m-zzzzz"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown milestone "m-zzzzz" in project "demo"/);
    assert.equal(events(ws).filter((event) => event.type.startsWith("artifact.")).length, 0);
});

test("cell C7 — an id of another kind is refused by name", async () =>
{
    const { box, demo } = await floor();
    const note = idOf((await must(box, demo, ["state", "add", "a note", "--label", "note"])).out, "e");
    const result = await selfIn(box, demo, ["artifact", "add", "guide.md", "--for", note]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /--for attaches an artifact to a work unit or a milestone/);
});

test("cell C8 — another project's unit is refused at the boundary", async () =>
{
    const { box, ws, demo } = await floor();
    const other = await secondProject(box, ws);
    const theirs = await aUnit(box, other, "their outcome");
    const result = await selfIn(box, demo, ["artifact", "add", "guide.md", "--for", theirs]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is a work unit in project "other", not in "demo"/);
    assert.equal(events(ws).filter((event) => event.type.startsWith("artifact.")).length, 0);
    assert.equal(events(ws, "other").filter((event) => event.type.startsWith("artifact.")).length, 0);
});

test("cell C9 — --for twice is refused by name", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    const result = await selfIn(box, demo, ["artifact", "add", "guide.md", "--for", unit, "--for", unit]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /--for names the record an artifact is attached to and was passed 2 times/);
});

test("cell C10 — a unit that is done still takes an attachment", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    await must(box, demo, ["work", "done", unit, "--report", "the flow verifiably works"]);
    const id = await added(box, demo, [PR, "--for", unit, "--kind", "pr"]);
    assert.match((await must(box, demo, ["work", "show", unit])).out, new RegExp(id));
});

test("cell C11 — an attachment is not evidence, so work done is still refused", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    await added(box, demo, ["guide.md", "--for", unit, "--kind", "brief"]);
    const result = await selfIn(box, demo, ["work", "done", unit]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /no evidence for done/);
});

/* ── D: what the downstream verbs do ───────────────────────────────── */

test("cell D1 — a link's listing row is its URL, marked with its kind", async () =>
{
    const { box, demo } = await floor();
    const id = await added(box, demo, [PR, "--kind", "pr"]);
    const listed = (await must(box, demo, ["artifact", "list"])).out;
    assert.match(listed, new RegExp(`${id} {2}[0-9-]{10} {2}demo {2}- {2}${PR.replace(/\//g, "\\/")} \\[pr\\]`));
});

test("cell D2 — artifact list --work sees the link of that unit alone", async () =>
{
    const { box, demo } = await floor();
    const mine = await aUnit(box, demo, "my outcome");
    const yours = await aUnit(box, demo, "your outcome");
    const here = await added(box, demo, [PR, "--for", mine]);
    const there = await added(box, demo, [BRIEF, "--for", yours]);
    const listed = (await must(box, demo, ["artifact", "list", "--work", mine])).out;
    assert.match(listed, new RegExp(here));
    assert.doesNotMatch(listed, new RegExp(there));
});

test("cell D3 — artifact search matches part of a URL", async () =>
{
    const { box, demo } = await floor();
    const id = await added(box, demo, [PR]);
    assert.match((await must(box, demo, ["artifact", "search", "superself/pull"])).out, new RegExp(id));
});

test("cell D4 — work show lists both shapes and leaves the evidence line alone", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    writeFileSync(join(demo, "evidence.md"), "what happened\n");
    await must(box, demo, ["report", unit, "the work is reported", "--artifact", "evidence.md"]);
    const brief = await added(box, demo, ["guide.md", "--for", unit, "--kind", "brief"]);
    const link = await added(box, demo, [PR, "--for", unit, "--kind", "pr"]);
    const page = (await must(box, demo, ["work", "show", unit])).out;
    assert.match(page, /## Attached artifacts/);
    assert.match(page, new RegExp(`- ${brief} {2}brief {2}guide\\.md`));
    assert.match(page, new RegExp(`- ${link} {2}pr {2}https`));
    // The report's own artifact stays where it was, and is not an attachment.
    assert.match(page, /- Artifacts: a-[0-9a-z]{5} evidence\.md/);
    assert.doesNotMatch(page.split("## Attached artifacts")[1], /evidence\.md/);
});

test("cell D5 — milestone show lists what is attached to it", async () =>
{
    const { box, demo } = await floor();
    const milestone = await aMilestone(box, demo);
    const id = await added(box, demo, [BRIEF, "--for", milestone, "--kind", "brief"]);
    const page = (await must(box, demo, ["milestone", "show", milestone])).out;
    assert.match(page, /## Attached artifacts/);
    assert.match(page, new RegExp(`- ${id} {2}brief {2}${BRIEF.replace(/\//g, "\\/")}`));
});

test("cell D6 — a milestone's attachment renders on the milestone alone", async () =>
{
    const { box, demo } = await floor();
    const milestone = await aMilestone(box, demo);
    const unit = await aUnit(box, demo);
    await must(box, demo, ["work", "link", unit, "--milestone", milestone]);
    const id = await added(box, demo, [BRIEF, "--for", milestone, "--kind", "brief"]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", unit])).out, new RegExp(id));
});

test("cell D7 — an unattached link is on no page", async () =>
{
    const { box, demo } = await floor();
    const milestone = await aMilestone(box, demo);
    const unit = await aUnit(box, demo);
    const id = await added(box, demo, [PR, "--kind", "pr"]);
    assert.doesNotMatch((await must(box, demo, ["work", "show", unit])).out, new RegExp(id));
    assert.doesNotMatch((await must(box, demo, ["milestone", "show", milestone])).out, new RegExp(id));
});

test("cell D8 — attachments render in kind order, whatever order they arrived in", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    await added(box, demo, ["https://example.com/doc", "--for", unit, "--kind", "doc"]);
    await added(box, demo, ["https://example.com/bucket", "--for", unit, "--kind", "resource"]);
    await added(box, demo, [PR, "--for", unit, "--kind", "pr"]);
    await added(box, demo, ["guide.md", "--for", unit, "--kind", "brief"]);
    const rows = (await must(box, demo, ["work", "show", unit])).out
        .split("## Attached artifacts")[1].trim().split("\n");
    assert.deepEqual(rows.map((row) => row.split(/\s+/)[2]), ["brief", "pr", "resource", "doc"]);
});

test("cell D9 — an attachment with no kind reads as a dash, after the kinded rows", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    await added(box, demo, ["guide.md", "--for", unit]);
    await added(box, demo, [PR, "--for", unit, "--kind", "pr"]);
    const rows = (await must(box, demo, ["work", "show", unit])).out
        .split("## Attached artifacts")[1].trim().split("\n");
    assert.deepEqual(rows.map((row) => row.split(/\s+/)[2]), ["pr", "-"]);
});

test("cell D10 — artifact open prints a link and launches nothing", async () =>
{
    const { box, demo } = await floor();
    const id = await added(box, demo, [PR]);
    for (const options of [{}, { tty: true }])
    {
        const result = await selfIn(box, demo, ["artifact", "open", id], options);
        assert.equal(result.code, 0);
        assert.match(result.out, new RegExp(`${PR.replace(/\//g, "\\/")} — ${id} is a link`));
        assert.doesNotMatch(result.out, /opened/);
    }
});

test("cell D11 — artifact prune on a link is refused by name", async () =>
{
    const { box, demo } = await floor();
    const receipt = await must(box, demo, ["artifact", "add", PR]);
    const id = idOf(receipt.out, "a");
    const result = await selfIn(box, demo, ["artifact", "prune", id, "--why", "wrong link"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /this store holds no bytes for it/);
    assert.match(result.out, new RegExp(`self undo ${eventIdIn(receipt.out)}`));
});

test("cell D12 — store size does not move when a link is recorded", async () =>
{
    const { box, demo } = await floor();
    await added(box, demo, ["guide.md"]);
    const was = sizeCounts(await must(box, demo, ["store", "size", "--json"]));
    await added(box, demo, [PR, "--kind", "pr"]);
    assert.deepEqual(sizeCounts(await must(box, demo, ["store", "size", "--json"])), was);
});

test("cell D13 — a path artifact with a kind and a --for is counted as it always was", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    await added(box, demo, ["guide.md", "--kind", "brief", "--for", unit]);
    assert.deepEqual(sizeCounts(await must(box, demo, ["store", "size", "--json"])),
        { artifacts: 1, distinct: 1, artifactBytes: 27, storedFiles: 1 });
});

test("cell D14 — a link raises no artifact health line", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    await added(box, demo, [PR, "--for", unit, "--kind", "pr"]);
    const status = (await must(box, demo, ["status"])).out;
    assert.match(status, /health: ok/);
    assert.doesNotMatch(status, /artifact a-/);
});

test("cell D15 — a rule may point at a link, and the store stays healthy", async () =>
{
    const { box, demo } = await floor();
    const id = await added(box, demo, [BRIEF, "--kind", "doc"]);
    await must(box, demo, ["convention", "add", "read the brief", "--artifact", id]);
    assert.match((await must(box, demo, ["context"])).out, new RegExp(`self artifact open ${id}`));
    assert.match((await must(box, demo, ["status"])).out, /health: ok/);
});

test("cell D16 — --artifact with a URL is refused, naming artifact add", async () =>
{
    const { box, demo } = await floor();
    const result = await selfIn(box, demo, ["convention", "add", "read it", "--artifact", BRIEF]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`self artifact add ${BRIEF.replace(/\//g, "\\/")}`));
});

test("cell D17 — work show --project reads the attachment from the owning project", async () =>
{
    const { box, ws, demo } = await floor();
    const other = await secondProject(box, ws);
    const theirs = await aUnit(box, other, "their outcome");
    const id = await added(box, other, [PR, "--for", theirs, "--kind", "pr"]);
    const page = (await must(box, demo, ["work", "show", theirs, "--project", "other"])).out;
    assert.match(page, new RegExp(`- ${id} {2}pr {2}https`));
});

test("cell D18 — the fold's canonical page carries no attachment", async () =>
{
    const { box, ws, demo } = await floor();
    const unit = await aUnit(box, demo);
    const page = join(ws, ".superself", "projects", "demo", "work", `${unit}.md`);
    const before = readFileSync(page, "utf8");
    await added(box, demo, [PR, "--for", unit, "--kind", "pr"]);
    assert.equal(readFileSync(page, "utf8"), before);
});

test("cell D19 — self log carries the link's row with its why", async () =>
{
    const { box, demo } = await floor();
    await added(box, demo, [PR, "--why", "the pull request"]);
    const log = (await must(box, demo, ["log"])).out;
    assert.match(log, /artifact\.linked/);
    assert.match(log, /the pull request/);
});

/* ── E: the record's own life ──────────────────────────────────────── */

test("cell E1 — self undo takes a link back", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    const receipt = await must(box, demo, ["artifact", "add", PR, "--for", unit, "--kind", "pr"]);
    const id = idOf(receipt.out, "a");
    await must(box, demo, ["undo", eventIdIn(receipt.out)]);
    assert.doesNotMatch((await must(box, demo, ["artifact", "list"])).out, new RegExp(id));
    assert.doesNotMatch((await must(box, demo, ["artifact", "search", "pull"])).out, new RegExp(id));
    assert.doesNotMatch((await must(box, demo, ["work", "show", unit])).out, /## Attached artifacts/);
});

test("cell E2 — a link taken back resolves to nothing", async () =>
{
    const { box, demo } = await floor();
    const receipt = await must(box, demo, ["artifact", "add", PR]);
    await must(box, demo, ["undo", eventIdIn(receipt.out)]);
    const result = await selfIn(box, demo, ["artifact", "open", idOf(receipt.out, "a")]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown artifact/);
});

test("cell E3 — a registration is still refused by undo, naming prune", async () =>
{
    const { box, demo } = await floor();
    const receipt = await must(box, demo, ["artifact", "add", "guide.md"]);
    const result = await selfIn(box, demo, ["undo", eventIdIn(receipt.out)]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /self artifact prune/);
});

test("cell E4 — undoing the unit a link hangs off is refused with the link listed", async () =>
{
    const { box, demo } = await floor();
    const created = await must(box, demo, ["work", "add", "the flow works"]);
    const unit = workIdIn(created.out);
    const link = await must(box, demo, ["artifact", "add", PR, "--for", unit]);
    const result = await selfIn(box, demo, ["undo", eventIdIn(created.out)]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(eventIdIn(link.out)));
});

/* ── F: mixed version ──────────────────────────────────────────────── */

test("cell F1 — an event type this CLI does not name folds to nothing", async () =>
{
    const { box, ws, demo } = await floor();
    await added(box, demo, ["guide.md"]);
    const before = sizeCounts(await must(box, demo, ["store", "size", "--json"]));
    const id = ulid();
    logFixture(ws, "demo", {
        id,
        ts: new Date().toISOString(),
        type: "artifact.beamed",
        origin: { actor: "agent", confirmed: true },
        project: "demo",
        payload: { artifact: { id: "a-beam1", name: "https://example.com/beamed", url: "https://example.com/beamed" } },
        refs: { artifacts: ["a-beam1"] }
    });
    const listed = await must(box, demo, ["artifact", "list"]);
    assert.doesNotMatch(listed.out, /a-beam1/);
    assert.match(listed.out, /1 artifact\n/);
    assert.deepEqual(sizeCounts(await must(box, demo, ["store", "size", "--json"])), before);
});

test("cell F2 — a registration's own shape is unchanged by a kind and a --for", async () =>
{
    const { box, ws, demo } = await floor();
    const unit = await aUnit(box, demo);
    const id = await added(box, demo, ["guide.md", "--kind", "brief", "--for", unit]);
    const [event] = eventsOfType(ws, "artifact.registered");
    assert.deepEqual(Object.keys(event.payload.artifacts[0]).sort(), ["digest", "id", "name", "path"]);
    assert.equal(event.payload.artifacts[0].id, id);
    assert.equal(event.payload.kind, "brief");
    assert.equal(event.refs.work, unit);
});

/* ── D again: the two verbs the table gained on the adversarial pass ── */

test("cell D20 — report --artifact with a URL is refused, naming artifact add", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    const result = await selfIn(box, demo, ["report", unit, "the work is reported", "--artifact", PR]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /is a URL, and this attaches bytes/);
    assert.match(result.out, new RegExp(`self artifact add ${PR.replace(/\//g, "\\/")} --for <work-id>`));
});

test("cell D21 — an attached registration is prunable, and its row says so", async () =>
{
    const { box, demo } = await floor();
    const unit = await aUnit(box, demo);
    const id = await added(box, demo, ["guide.md", "--for", unit, "--kind", "brief"]);
    await approvedIn(box, demo, ["artifact", "prune", id, "--why", "the brief is folded into the plan"], id);
    const page = (await must(box, demo, ["work", "show", unit])).out;
    assert.match(page, new RegExp(`- ${id} {2}brief {2}guide\\.md \\(pruned\\)`));
});
