// Groups B and C of the #124 case table
// (docs/maintainers/case-tables/124-friction-sweep.md), implemented by #381:
// `self sweep` reads the friction #380 made a field, clusters what recurs, and
// — only with `--record` — proposes each cluster through the proposal gate that
// already existed.
//
// Each test below is one cell, named by its number. B1–B15 are the preview,
// which records nothing; C1–C18 are `--record`. The cells that decide whether
// the design holds are C5 and C7 (a clash skips its own cluster and the rest
// still record, exit 0), C9 and C16 (running again proposes nothing a second
// time, whether or not more evidence landed), C15 (three clusters are one
// append and one fold) and C6 (a declined proposal does not silence recurring
// friction).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../dist/ids.js";
import { git, logFixture, machine, must, mustPerson, personIn, selfIn, workIdIn } from "./harness.mjs";

// One complaint, said three ways. The tokens they share after normalization
// and stop-word removal are well over half, which is what makes them one
// cluster; none of them carries a digit, so C1 can assert the proposal text
// carries none either.
const SAID = "the golden fixture needed regenerating by hand";
const NEAR = ["regenerating the golden fixture by hand", "the golden fixture needed regenerating again by hand"];

// Two more complaints that share no meaningful word with the first or with
// each other, so three of them are three clusters and one of each is none.
const OTHER = "credentials expired midway through a deploy";
const THIRD = "documentation lagged behind releases";

const PROPOSED = `recurring friction: ${SAID}`;

let seq = 0;

// A workspace holding one registered project per slug, and nothing else.
async function fresh(...slugs)
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init"]);
    const dirs = {};
    for (const slug of slugs)
    {
        dirs[slug] = join(ws, slug);
        mkdirSync(dirs[slug], { recursive: true });
        git(box, dirs[slug], ["init", "-q", "-b", "main"]);
        await must(box, dirs[slug], ["project", "init", "--name", slug, "--desc", `${slug} project`, "--no-connect"]);
    }
    return { box, ws, dirs, demo: dirs.demo };
}

// One report carrying one friction sentence, on a unit of its own — the shape
// a session actually records, so the fixtures are built by the real verbs.
async function reported(box, dir, said)
{
    seq += 1;
    const unit = workIdIn((await mustPerson(box, dir, ["work", "add", `outcome ${seq}`])).out);
    await must(box, dir, ["report", unit, `report ${seq}`, "--friction", said]);
    return unit;
}

// The same, dated back. A report older than the window cannot be written by
// the verb, so the event goes in the way the pipeline would have written it.
async function reportedDaysAgo(box, ws, project, dir, said, days)
{
    seq += 1;
    const unit = workIdIn((await mustPerson(box, dir, ["work", "add", `old outcome ${seq}`])).out);
    return logFixture(ws, project, {
        id: ulid(),
        ts: new Date(Date.now() - days * 86_400_000).toISOString(),
        type: "report.added",
        origin: { actor: "agent", confirmed: false },
        project,
        payload: { text: `old report ${seq}`, friction: [said] },
        refs: { work: unit }
    });
}

function eventsOf(ws, project)
{
    return readFileSync(join(ws, ".superself", "projects", project, "log.jsonl"), "utf8")
        .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

function proposalsOf(ws, project)
{
    return eventsOf(ws, project).filter((event) => event.type === "entity.proposed");
}

function storeCommits(ws)
{
    return execFileSync("git", ["-C", join(ws, ".superself"), "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
}

// How many clusters a preview found, read off the rows it prints for them.
function clustersIn(out)
{
    return out.split("\n").filter((line) => line.startsWith("recurring friction: ")).length;
}

async function sweep(box, dir, ...args)
{
    const result = await selfIn(box, dir, ["sweep", ...args]);
    assert.equal(result.code, 0, result.out);
    return result.out;
}

/* ── group B: the preview records nothing ──────────────────────────── */

// B1–B3 accumulate in one workspace: a window with nothing in it, then one
// sentence, then three that share no word. Each state is the previous one plus
// what the next cell adds, so building three workspaces would prove less.
const growing = await fresh("demo");

// B4–B6 accumulate the same way: three near-identical sentences, then five,
// then a second complaint beside them.
const clustering = await fresh("demo");

// B9–B11 share one workspace of dated-back reports: three outside the default
// window, then two inside it, then the narrowed window over three inside.
const dated = await fresh("demo");

// B12 and B13 share the workspace: what a malformed window is refused with,
// and that two identical previews change nothing between them.
const preview = await fresh("demo");

/* ── group C: --record writes ──────────────────────────────────────── */

// One cluster, recorded once, then read back from every surface a proposal is
// read from, then asked for a second and a third time.
const recorded = await fresh("demo");

let proposal = null;

// C4 and C6 are the same workspace read forward: declining a swept proposal
// works like declining any other, and a declined proposal does not hold back
// the next sweep — recurring friction is meant to keep being asked about.
const declined = await fresh("demo");

test("B1: an empty window says so, and is not an error", async () =>
{
    const out = await sweep(growing.box, growing.demo);
    assert.match(out, /no friction was recorded in the last 30 days/);
    assert.match(out, /--friction/);
    assert.equal(clustersIn(out), 0);
});

test("B2: one sentence is below the floor of three, and the run says what it read", async () =>
{
    await reported(growing.box, growing.demo, SAID);
    const out = await sweep(growing.box, growing.demo);
    assert.match(out, /1 sentence on 1 report/);
    assert.match(out, /nothing recurred 3 times or more/);
    assert.equal(clustersIn(out), 0);
});

test("B3: three sentences that share no word are three sentences, not a cluster", async () =>
{
    await reported(growing.box, growing.demo, OTHER);
    await reported(growing.box, growing.demo, THIRD);
    const out = await sweep(growing.box, growing.demo);
    assert.match(out, /3 sentences on 3 reports/);
    assert.equal(clustersIn(out), 0);
});

test("B4: three near-identical sentences are one cluster showing its three reports", async () =>
{
    const evidence = [await reported(clustering.box, clustering.demo, SAID)];
    for (const said of NEAR)
    {
        evidence.push(await reported(clustering.box, clustering.demo, said));
    }
    assert.equal(evidence.length, 3);
    const out = await sweep(clustering.box, clustering.demo);
    assert.equal(clustersIn(out), 1);
    assert.ok(out.includes(PROPOSED), out);
    assert.match(out, /3 reports in 1 project/);
    const cited = out.split("\n").find((line) => line.includes("3 reports in 1 project")).split("— ")[1];
    assert.equal(cited.split(", ").length, 3, `the cluster named ${cited}`);
});

test("B5: five identical sentences are one cluster with five pieces of evidence", async () =>
{
    await reported(clustering.box, clustering.demo, SAID);
    await reported(clustering.box, clustering.demo, SAID);
    const out = await sweep(clustering.box, clustering.demo);
    assert.equal(clustersIn(out), 1);
    assert.match(out, /5 reports in 1 project/);
});

test("B6: a second complaint recorded three times is a second cluster", async () =>
{
    for (let index = 0; index < 3; index += 1)
    {
        await reported(clustering.box, clustering.demo, OTHER);
    }
    const out = await sweep(clustering.box, clustering.demo);
    assert.equal(clustersIn(out), 2);
    assert.ok(out.includes(`recurring friction: ${OTHER}`), out);
});

// The honest answer to "what differed" when nothing did. It records like any
// other sentence (A6) and is excluded here, where five of them would otherwise
// be the workspace's most recurring problem.
test("B7: five 예상대로 sentences cluster into nothing", async () =>
{
    const { box, demo } = await fresh("demo");
    for (let index = 0; index < 5; index += 1)
    {
        await reported(box, demo, index % 2 === 0 ? "예상대로" : "as expected");
    }
    const out = await sweep(box, demo);
    assert.match(out, /5 sentences on 5 reports/);
    assert.equal(clustersIn(out), 0);
});

test("B8: the same complaint in two projects is one cluster spanning both", async () =>
{
    const { box, dirs } = await fresh("demo", "other");
    await reported(box, dirs.demo, SAID);
    await reported(box, dirs.demo, NEAR[0]);
    await reported(box, dirs.other, SAID);
    await reported(box, dirs.other, NEAR[1]);
    const out = await sweep(box, dirs.demo);
    assert.match(out, /read 2 projects/);
    assert.equal(clustersIn(out), 1);
    assert.match(out, /4 reports in 2 projects/);
});

test("B9: three sentences older than the window are outside the read", async () =>
{
    for (let index = 0; index < 3; index += 1)
    {
        await reportedDaysAgo(dated.box, dated.ws, "demo", dated.demo, SAID, 60);
    }
    const out = await sweep(dated.box, dated.demo);
    assert.match(out, /no friction was recorded in the last 30 days/);
    assert.equal(clustersIn(out), 0);
});

test("B10: two inside the window and one outside is two, which is below the floor", async () =>
{
    await reportedDaysAgo(dated.box, dated.ws, "demo", dated.demo, SAID, 5);
    await reportedDaysAgo(dated.box, dated.ws, "demo", dated.demo, NEAR[0], 5);
    const out = await sweep(dated.box, dated.demo);
    assert.match(out, /2 sentences on 2 reports/);
    assert.equal(clustersIn(out), 0);
});

test("B11: narrowing the window with --since drops a cluster the default finds", async () =>
{
    await reportedDaysAgo(dated.box, dated.ws, "demo", dated.demo, NEAR[1], 5);
    assert.equal(clustersIn(await sweep(dated.box, dated.demo)), 1);
    const narrowed = await sweep(dated.box, dated.demo, "--since", "1d");
    assert.match(narrowed, /in the last 1 day/);
    assert.equal(clustersIn(narrowed), 0);
});

test("B12: a malformed --since is refused, and the refusal shows the form", async () =>
{
    await reported(preview.box, preview.demo, SAID);
    for (const said of NEAR)
    {
        await reported(preview.box, preview.demo, said);
    }
    const result = await selfIn(preview.box, preview.demo, ["sweep", "--since", "yesterday"]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /--since takes a whole number of days or weeks/);
    assert.match(result.out, /--since 30d/);
    assert.match(result.out, /--since 2w/);
});

test("B13: two previews print the same bytes and record nothing", async () =>
{
    const before = eventsOf(preview.ws, "demo").length;
    const first = await sweep(preview.box, preview.demo);
    const second = await sweep(preview.box, preview.demo);
    assert.equal(first, second);
    assert.equal(clustersIn(first), 1);
    assert.equal(eventsOf(preview.ws, "demo").length, before, "a preview appended to the log");
    assert.equal(proposalsOf(preview.ws, "demo").length, 0);
});

test("B14: a workspace with no registered project says so rather than throwing", async () =>
{
    const { box, ws } = await fresh();
    const out = await sweep(box, ws);
    assert.match(out, /no project is registered in this workspace/);
    assert.match(out, /self project init/);
});

test("B15: friction in an archived project is out of the read", async () =>
{
    const { box, ws, dirs } = await fresh("demo", "other");
    await reported(box, dirs.other, SAID);
    for (const said of NEAR)
    {
        await reported(box, dirs.other, said);
    }
    assert.equal(clustersIn(await sweep(box, dirs.demo)), 1);
    await must(box, ws, ["project", "archive", "other", "--why", "set aside for now"]);
    const out = await sweep(box, dirs.demo);
    assert.match(out, /read 1 project/);
    assert.equal(clustersIn(out), 0);
});

test("C1: one cluster records one entity.proposed under a short work id, and its text carries no digit", async () =>
{
    await reported(recorded.box, recorded.demo, SAID);
    for (const said of NEAR)
    {
        await reported(recorded.box, recorded.demo, said);
    }
    const out = await sweep(recorded.box, recorded.demo, "--record");
    assert.match(out, /1 proposal recorded/);
    const events = proposalsOf(recorded.ws, "demo");
    assert.equal(events.length, 1);
    proposal = events[0].payload.entity;
    assert.match(proposal, /^w-[0-9abcdefghjkmnpqrstvwxyz]{5}$/);
    assert.equal(events[0].payload.text, PROPOSED);
    assert.ok(!/[0-9]/.test(events[0].payload.text), `the proposal text carries a digit: ${events[0].payload.text}`);
});

test("C2: the proposal reaches a person through the unchanged Waiting on you row", async () =>
{
    const out = (await must(recorded.box, recorded.demo, ["context"])).out;
    const row = out.split("\n").find((line) => line.includes(proposal));
    assert.ok(row !== undefined, `no Waiting on you row for ${proposal}:\n${out}`);
    assert.ok(out.includes("## Waiting on you"), out);
    assert.ok(row.includes(`self work accept ${proposal}`), row);
    assert.ok(row.includes(SAID), row);
});

test("C10: the log carries one entity.proposed line for it", async () =>
{
    const lines = (await must(recorded.box, recorded.demo, ["log", "-n", "40"])).out
        .split("\n").filter((line) => line.includes("entity.proposed"));
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.ok(lines[0].includes(SAID), lines[0]);
});

test("C11: search finds it, because it is a live record like any other", async () =>
{
    const out = (await must(recorded.box, recorded.demo, ["search", "recurring friction"])).out;
    assert.ok(out.includes(proposal), out);
    assert.ok(out.includes(SAID), out);
});

test("C12: refs.friction is the report.added ids the cluster was built from", () =>
{
    const cited = proposalsOf(recorded.ws, "demo")[0].refs.friction;
    const reports = eventsOf(recorded.ws, "demo").filter((event) => event.type === "report.added").map((event) => event.id);
    assert.equal(cited.length, 3);
    cited.forEach((id) => assert.ok(reports.includes(id), `${id} is not a report.added id in this log`));
});

// The reader's path, not just the ref's existence: an id out of refs.friction
// has to lead somewhere. `self log` prints that exact event with the sentence
// on it, and `self state show` resolves it to the unit whose report it is.
test("C18: an id from refs.friction reaches the report it cites", async () =>
{
    const cited = proposalsOf(recorded.ws, "demo")[0].refs.friction[0];
    const line = (await must(recorded.box, recorded.demo, ["log", "-n", "40"])).out
        .split("\n").find((row) => row.includes(cited));
    assert.ok(line !== undefined, `${cited} is in no log line`);
    assert.match(line, /report\.added/);
    assert.ok(line.includes("friction: "), line);
    const resolved = await selfIn(recorded.box, recorded.demo, ["state", "show", cited]);
    assert.match(resolved.out, new RegExp(`${cited} is a report of w-`), resolved.out);
});

test("C9: recording twice in a row leaves one proposal", async () =>
{
    const out = await sweep(recorded.box, recorded.demo, "--record");
    assert.match(out, /0 proposals recorded, 1 cluster skipped/);
    assert.match(out, /already cites this evidence/);
    assert.equal(proposalsOf(recorded.ws, "demo").length, 1);
});

test("C16: one more piece of evidence the next day does not produce a second proposal", async () =>
{
    await reported(recorded.box, recorded.demo, SAID);
    const out = await sweep(recorded.box, recorded.demo, "--record");
    assert.match(out, /0 proposals recorded/);
    assert.match(out, new RegExp(`${proposal} already cites this evidence`));
    assert.equal(proposalsOf(recorded.ws, "demo").length, 1);
});

test("C3: accepting it goes through the unchanged acceptance path", async () =>
{
    assert.equal((await personIn(recorded.box, recorded.demo, ["work", "accept", proposal])).code, 0);
    const shown = (await must(recorded.box, recorded.demo, ["work", "show", proposal])).out;
    assert.ok(shown.includes(SAID), shown);
    assert.ok(!(await must(recorded.box, recorded.demo, ["context"])).out.includes(`self work accept ${proposal}`));
});

test("C4: declining a swept proposal is the unchanged decline", async () =>
{
    await reported(declined.box, declined.demo, SAID);
    for (const said of NEAR)
    {
        await reported(declined.box, declined.demo, said);
    }
    await sweep(declined.box, declined.demo, "--record");
    const first = proposalsOf(declined.ws, "demo")[0].payload.entity;
    assert.equal((await selfIn(declined.box, declined.demo, ["work", "decline", first, "--why", "not worth systemizing yet"])).code, 0);
    assert.ok(!(await must(declined.box, declined.demo, ["context"])).out.includes(`self work accept ${first}`));
});

test("C6: the same friction is proposed again after a decline, by design", async () =>
{
    const out = await sweep(declined.box, declined.demo, "--record");
    assert.match(out, /1 proposal recorded/);
    const events = proposalsOf(declined.ws, "demo");
    assert.equal(events.length, 2);
    assert.notEqual(events[0].payload.entity, events[1].payload.entity);
    assert.equal(events[1].payload.text, PROPOSED);
});

test("C5: a cluster whose plan text is already open is skipped, and nothing throws", async () =>
{
    const { box, ws, demo } = await fresh("demo");
    await reported(box, demo, SAID);
    for (const said of NEAR)
    {
        await reported(box, demo, said);
    }
    const open = workIdIn((await must(box, demo, ["work", "propose", PROPOSED])).out);
    const out = await sweep(box, demo, "--record");
    assert.match(out, /0 proposals recorded, 1 cluster skipped/);
    assert.ok(out.includes(`${open} already proposes it`), out);
    assert.equal(proposalsOf(ws, "demo").length, 1, "the sweep recorded a second proposal of the same plan");
});

// The cell the `clashingPlan` split exists for. Before it, the gate threw a
// CliError on the first clash and the whole append — including the cluster
// nobody had proposed — went with it, at exit 1.
test("C7: one clashing cluster skips itself while the rest record, at exit 0", async () =>
{
    const { box, ws, demo } = await fresh("demo");
    await reported(box, demo, SAID);
    for (const said of NEAR)
    {
        await reported(box, demo, said);
    }
    for (let index = 0; index < 3; index += 1)
    {
        await reported(box, demo, OTHER);
    }
    const open = workIdIn((await must(box, demo, ["work", "propose", PROPOSED])).out);
    const result = await selfIn(box, demo, ["sweep", "--record"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /1 proposal recorded, 1 cluster skipped/);
    assert.ok(result.out.includes(`${open} already proposes it`), result.out);
    const swept = proposalsOf(ws, "demo").filter((event) => event.refs?.friction !== undefined);
    assert.equal(swept.length, 1);
    assert.equal(swept[0].payload.text, `recurring friction: ${OTHER}`);
});

test("C8: nothing to propose records nothing, at exit 0", async () =>
{
    const { box, ws, demo } = await fresh("demo");
    await reported(box, demo, SAID);
    const before = eventsOf(ws, "demo").length;
    const out = await sweep(box, demo, "--record");
    assert.match(out, /nothing recurred 3 times or more in the last 30 days, so nothing was proposed/);
    assert.equal(eventsOf(ws, "demo").length, before, "a run with no cluster appended to the log");
});

test("C13: --record inside an archived project is refused by the append gate", async () =>
{
    const { box, ws, demo } = await fresh("demo");
    await reported(box, demo, SAID);
    for (const said of NEAR)
    {
        await reported(box, demo, said);
    }
    await must(box, ws, ["project", "archive", "demo", "--why", "set aside for now"]);
    const result = await selfIn(box, demo, ["sweep", "--record"]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /archived, so nothing more is recorded into it/);
    assert.match(result.out, /self project restore demo/);
    assert.equal(proposalsOf(ws, "demo").length, 0);
});

test("C14: evidence spanning projects records into the project the command ran in", async () =>
{
    const { box, ws, dirs } = await fresh("demo", "other");
    await reported(box, dirs.demo, SAID);
    await reported(box, dirs.other, NEAR[0]);
    await reported(box, dirs.other, NEAR[1]);
    await sweep(box, dirs.other, "--record");
    assert.equal(proposalsOf(ws, "demo").length, 0);
    const events = proposalsOf(ws, "other");
    assert.equal(events.length, 1);
    assert.equal(events[0].project, "other");
    assert.equal(events[0].refs.friction.length, 3);
});

// Every append refolds the project, so three clusters written one at a time
// would be three appends and three folds. They go through one `recordEvents`,
// which is one append, one fold, and one commit in the store.
test("C15: three clusters are one append and one fold", async () =>
{
    const { box, ws, demo } = await fresh("demo");
    for (const said of [SAID, ...NEAR])
    {
        await reported(box, demo, said);
    }
    for (const said of [OTHER, THIRD])
    {
        for (let index = 0; index < 3; index += 1)
        {
            await reported(box, demo, said);
        }
    }
    const before = Number(storeCommits(ws));
    const lines = eventsOf(ws, "demo").length;
    assert.match(await sweep(box, demo, "--record"), /3 proposals recorded/);
    assert.equal(Number(storeCommits(ws)) - before, 1, "three clusters cost more than one commit");
    const after = eventsOf(ws, "demo");
    assert.equal(after.length - lines, 3);
    after.slice(-3).forEach((event) => assert.equal(event.type, "entity.proposed"));
});

test("C17: --record in an unregistered directory is refused, naming what to do", async () =>
{
    const { box, ws } = await fresh("demo");
    const loose = join(ws, "loose");
    mkdirSync(loose, { recursive: true });
    const result = await selfIn(box, loose, ["sweep", "--record"]);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /not inside a registered project/);
    assert.match(result.out, /self project init/);
});
