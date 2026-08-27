// Cross-project contribution links (#244).
//
// Every test below is one cell of the case table in the 2026-08-06 comment on
// issue #244, named by its cell id, and asserts that cell's stated outcome:
// `work link --objective` resolves current-project-first and then across every
// registered project (A), unlink mirrors it (B), the owning and contributing
// surfaces both answer for the link (C), and the owner's later transitions
// disclose on the contributing side without ever moving the link (D).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, machine, must, retireFixture, selfIn, workIdIn } from "./harness.mjs";

// Three projects: a contributing one, an owning one, and a third that holds
// colliding ids and receives a scoped unit. Named rather than reusing the
// harness's demo workspace: every assertion below reads a slug.
async function trio()
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init"]);
    const dirs = {};
    for (const slug of ["alpha", "beta", "gamma"])
    {
        const dir = join(ws, slug);
        mkdirSync(dir, { recursive: true });
        git(box, dir, ["init", "-q", "-b", "main"]);
        await must(box, dir, ["project", "init", "--name", slug, "--no-connect"]);
        dirs[slug] = dir;
    }
    return { box, ws, ...dirs };
}

function eventsOf(ws, slug)
{
    const file = join(ws, ".superself", "projects", slug, "log.jsonl");
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

function linkEventsFor(ws, slug, work, type = "entity.linked")
{
    return eventsOf(ws, slug).filter((event) => event.type === type && event.payload.entity === work);
}

function objectiveIdIn(text)
{
    const match = text.match(/\bo-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no objective id in: ${text}`);
    return match[0];
}

// An objective asserted directly into a log, so its id can be pinned — the
// only way two projects can hold the same id, which no CLI run can produce.
function objectiveFixture(box, ws, slug, id, text, extra = {})
{
    retireFixture(box, ws, slug, "entity.confirmed", {
        entity: id, text, labels: ["objective"], links: [], criteria: [],
        exposure: "full", scope: "project", priority: 10, ...extra
    });
}

/* ── A. link — resolution and write ────────────────────────────────── */

const a = await trio();
const aObjLocal = objectiveIdIn((await must(a.box, a.alpha, ["objective", "add", "a local alpha outcome"])).out);
const aObjBeta = objectiveIdIn((await must(a.box, a.beta, ["objective", "add", "a beta outcome"])).out);
objectiveFixture(a.box, a.ws, "alpha", "o-aaaaa", "collides everywhere (alpha copy)");
objectiveFixture(a.box, a.ws, "beta", "o-aaaaa", "collides everywhere (beta copy)");
objectiveFixture(a.box, a.ws, "gamma", "o-aaaaa", "collides everywhere (gamma copy)");
objectiveFixture(a.box, a.ws, "beta", "o-bbbbb", "collides abroad (beta copy)");
objectiveFixture(a.box, a.ws, "gamma", "o-bbbbb", "collides abroad (gamma copy)");

async function aWork(outcome)
{
    return workIdIn((await must(a.box, a.alpha, ["work", "add", outcome])).out);
}

/* ── C. render surfaces ────────────────────────────────────────────── */

const c = await trio();

const cShared = objectiveIdIn((await must(c.box, c.beta, ["objective", "add", "shared beta objective", "--target", "2031-01-01"])).out);

const cBare = objectiveIdIn((await must(c.box, c.beta, ["objective", "add", "untargeted beta objective"])).out);

const cW1 = workIdIn((await must(c.box, c.alpha, ["work", "add", "c alpha unit one"])).out);

const cW2 = workIdIn((await must(c.box, c.alpha, ["work", "add", "c alpha unit two"])).out);

await must(c.box, c.alpha, ["work", "link", cW1, "--objective", cShared]);

await must(c.box, c.alpha, ["work", "link", cW2, "--objective", cBare]);

await must(c.box, c.alpha, ["work", "start", cW1]);

await must(c.box, c.alpha, ["work", "start", cW2]);

test("A1 a local objective resolves locally and the event stays byte-identical to today", async () =>
{
    const work = await aWork("a1 unit");
    await must(a.box, a.alpha, ["work", "link", work, "--objective", aObjLocal]);
    const linked = linkEventsFor(a.ws, "alpha", work);
    assert.equal(linked.length, 1);
    // The exact serialized link, not just the absence of one field: a local
    // link must fold on clones that never heard of the project field.
    assert.equal(JSON.stringify(linked[0].payload.link), `{"type":"member-of","target":"${aObjLocal}"}`);
});

test("A2 an id held by exactly one foreign project resolves there and records the owning slug", async () =>
{
    const work = await aWork("a2 unit");
    await must(a.box, a.alpha, ["work", "link", work, "--objective", aObjBeta]);
    const linked = linkEventsFor(a.ws, "alpha", work);
    assert.equal(linked.length, 1, "one entity.linked in the work's home log");
    assert.deepEqual(linked[0].payload.link, { type: "member-of", target: aObjBeta, project: "beta" });
    assert.equal(eventsOf(a.ws, "beta").filter((event) => event.type === "entity.linked").length, 0,
        "nothing is written to the owning project's log");
});

test("A3 an id the current project also holds resolves locally without a word, however many others hold it", async () =>
{
    // The id exists in alpha, beta and gamma: the current project wins
    // silently even against two foreign holders.
    const work = await aWork("a3 unit");
    await must(a.box, a.alpha, ["work", "link", work, "--objective", "o-aaaaa"]);
    const linked = linkEventsFor(a.ws, "alpha", work);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].payload.link.project, undefined);
});

test("A4 an id held by two foreign projects refuses naming them and --objective-project", async () =>
{
    const work = await aWork("a4 unit");
    const result = await selfIn(a.box, a.alpha, ["work", "link", work, "--objective", "o-bbbbb"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /beta, gamma/);
    assert.match(result.out, /--objective-project <slug>/);
    assert.equal(linkEventsFor(a.ws, "alpha", work).length, 0, "a refusal writes nothing");
});

test("A5 --objective-project resolves directly, and naming the current project records the local shape", async () =>
{
    const work = await aWork("a5 unit");
    await must(a.box, a.alpha, ["work", "link", work, "--objective", "o-bbbbb", "--objective-project", "gamma"]);
    assert.deepEqual(linkEventsFor(a.ws, "alpha", work)[0].payload.link,
        { type: "member-of", target: "o-bbbbb", project: "gamma" });
    await must(a.box, a.alpha, ["work", "link", work, "--objective", aObjLocal, "--objective-project", "alpha"]);
    const local = linkEventsFor(a.ws, "alpha", work).find((event) => event.payload.link.target === aObjLocal);
    assert.equal(JSON.stringify(local.payload.link), `{"type":"member-of","target":"${aObjLocal}"}`);
});

test("A6 --objective-project naming a project without the objective refuses toward its listing", async () =>
{
    const work = await aWork("a6 unit");
    const result = await selfIn(a.box, a.alpha, ["work", "link", work, "--objective", aObjLocal, "--objective-project", "beta"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`no objective "${aObjLocal}" in beta`));
    assert.match(result.out, /self objective --project beta/);
});

test("A7 --objective-project naming an unregistered slug refuses naming the registered ones", async () =>
{
    const work = await aWork("a7 unit");
    const result = await selfIn(a.box, a.alpha, ["work", "link", work, "--objective", aObjBeta, "--objective-project", "delta"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown project "delta"/);
    assert.match(result.out, /alpha, beta, gamma/);
});

test("A8 --objective-project without --objective is refused", async () =>
{
    const work = await aWork("a8 unit");
    // With no target flag at all, the required-option gate answers first —
    // the one refusal that lists what the verb cannot run without.
    const bare = await selfIn(a.box, a.alpha, ["work", "link", work, "--objective-project", "beta"]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /needs --objective\|--milestone/);
    // With the gate satisfied by a milestone, the mirror of the
    // `work retire --successor-project` rule refuses the dangling flag.
    const milestone = (await must(a.box, a.alpha, ["milestone", "add", "a8 checkpoint", "--objective", aObjLocal,
        "--exit", "it lands"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    const dangling = await selfIn(a.box, a.alpha, ["work", "link", work, "--milestone", milestone, "--objective-project", "beta"]);
    assert.notEqual(dangling.code, 0);
    assert.match(dangling.out, /work link --objective-project needs --objective <id>/);
    assert.equal(linkEventsFor(a.ws, "alpha", work).length, 0, "a refusal writes nothing");
});

test("A9 an id no registered project holds refuses with workspace-wide wording", async () =>
{
    const work = await aWork("a9 unit");
    const result = await selfIn(a.box, a.alpha, ["work", "link", work, "--objective", "o-zzzzz"]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, /unknown objective "o-zzzzz" — no registered project has it/);
    assert.match(result.out, /self objective --workspace/);
});

test("A10 linking the same foreign objective twice records both events and folds to one edge", async () =>
{
    const work = await aWork("a10 unit");
    await must(a.box, a.alpha, ["work", "link", work, "--objective", aObjBeta]);
    await must(a.box, a.alpha, ["work", "link", work, "--objective", aObjBeta]);
    assert.equal(linkEventsFor(a.ws, "alpha", work).length, 2);
    const shown = (await must(a.box, a.alpha, ["work", "show", work])).out;
    const mentions = shown.split(`${aObjBeta} (beta)`).length - 1;
    assert.equal(mentions, 1, `the fold kept one edge, the page shows it once:\n${shown}`);
});

test("A11 a proposed foreign objective is accepted, and its status disclosed at render", async () =>
{
    const proposed = objectiveIdIn((await must(a.box, a.beta, ["objective", "add", "a proposed beta outcome", "--proposed"])).out);
    const work = await aWork("a11 unit");
    await must(a.box, a.alpha, ["work", "link", work, "--objective", proposed]);
    await must(a.box, a.alpha, ["work", "start", work]);
    const context = (await must(a.box, a.alpha, ["context"])).out;
    assert.ok(context.includes(`[toward ${proposed} (beta, proposed)]`), context);
});

test("A12 --milestone naming a foreign milestone is refused — milestones resolve in the current project only", async () =>
{
    const milestone = (await must(a.box, a.beta, ["milestone", "add", "a beta checkpoint", "--objective", aObjBeta,
        "--exit", "it lands"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    const work = await aWork("a12 unit");
    const result = await selfIn(a.box, a.alpha, ["work", "link", work, "--milestone", milestone]);
    assert.notEqual(result.code, 0);
    assert.match(result.out, new RegExp(`unknown milestone "${milestone}"`));
    assert.equal(linkEventsFor(a.ws, "alpha", work).length, 0);
});

test("A13 a foreign objective and a local milestone in one call record two events, and only the objective edge carries the slug", async () =>
{
    const milestone = (await must(a.box, a.alpha, ["milestone", "add", "a13 local checkpoint", "--objective", aObjLocal,
        "--exit", "it lands"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    const work = await aWork("a13 unit");
    await must(a.box, a.alpha, ["work", "link", work, "--objective", aObjBeta, "--milestone", milestone]);
    const linked = linkEventsFor(a.ws, "alpha", work);
    assert.equal(linked.length, 2);
    assert.deepEqual(linked.map((event) => event.payload.link), [
        { type: "member-of", target: aObjBeta, project: "beta" },
        { type: "member-of", target: milestone }
    ]);
});

/* ── B. unlink ─────────────────────────────────────────────────────── */

test("B1 unlink resolves by the same rules, records the slug, and the link leaves both sides' surfaces", async () =>
{
    const work = await aWork("b1 unit");
    await must(a.box, a.alpha, ["work", "link", work, "--objective", aObjBeta]);
    assert.ok((await must(a.box, a.beta, ["objective", "show", aObjBeta])).out.includes(`${work} (alpha)`));
    await must(a.box, a.alpha, ["work", "unlink", work, "--objective", aObjBeta]);
    const unlinked = linkEventsFor(a.ws, "alpha", work, "entity.unlinked");
    assert.deepEqual(unlinked[0].payload.link, { type: "member-of", target: aObjBeta, project: "beta" });
    assert.ok(!(await must(a.box, a.alpha, ["work", "show", work])).out.includes(`${aObjBeta} (beta)`));
    assert.ok(!(await must(a.box, a.beta, ["objective", "show", aObjBeta])).out.includes(`${work} (alpha)`));
});

test("B2 unlinking a link that was never stated records the event and folds to nothing", async () =>
{
    const work = await aWork("b2 unit");
    await must(a.box, a.alpha, ["work", "unlink", work, "--objective", aObjBeta]);
    assert.equal(linkEventsFor(a.ws, "alpha", work, "entity.unlinked").length, 1);
    assert.ok(!(await must(a.box, a.alpha, ["work", "show", work])).out.includes(`${aObjBeta} (beta)`));
});

test("B3 unlink refuses the A4-A9 states with the identical refusals", async () =>
{
    const work = await aWork("b3 unit");
    const ambiguous = await selfIn(a.box, a.alpha, ["work", "unlink", work, "--objective", "o-bbbbb"]);
    assert.notEqual(ambiguous.code, 0);
    assert.match(ambiguous.out, /beta, gamma/);
    assert.match(ambiguous.out, /--objective-project <slug>/);
    const unregistered = await selfIn(a.box, a.alpha, ["work", "unlink", work, "--objective", aObjBeta, "--objective-project", "delta"]);
    assert.notEqual(unregistered.code, 0);
    assert.match(unregistered.out, /unknown project "delta"/);
    const flagAlone = await selfIn(a.box, a.alpha, ["work", "unlink", work, "--objective-project", "beta"]);
    assert.notEqual(flagAlone.code, 0);
    assert.match(flagAlone.out, /needs --objective\|--milestone/);
    const nowhere = await selfIn(a.box, a.alpha, ["work", "unlink", work, "--objective", "o-zzzzz"]);
    assert.notEqual(nowhere.code, 0);
    assert.match(nowhere.out, /no registered project has it/);
});

test("C1 the owning project's objective show lists the foreign unit labeled with its slug", async () =>
{
    const shown = (await must(c.box, c.beta, ["objective", "show", cShared])).out;
    assert.ok(shown.includes(`- Work: ${cW1} (alpha)`), shown);
});

test("C2 the owning project's objective list counts the foreign unit", async () =>
{
    const line = (await must(c.box, c.beta, ["objective"])).out.split("\n").find((row) => row.startsWith(cShared));
    assert.ok(line.includes("[1 work unit(s)]"), line);
});

test("C3 the contributing project's context names the objective with its owning slug", async () =>
{
    const context = (await must(c.box, c.alpha, ["context"])).out;
    const row = context.split("\n").find((line) => line.includes(cW1));
    assert.ok(row.includes(`[toward ${cShared} (beta)]`), context);
});

test("C4 the foreign objective's target renders one Deadlines row in the contributing context", async () =>
{
    const context = (await must(c.box, c.alpha, ["context"])).out;
    const rows = context.split("\n").filter((line) => line === `- 2031-01-01: [objective] shared beta objective (beta)`);
    assert.equal(rows.length, 1, context);
});

test("C5 a foreign objective without a target adds no Deadlines row, and the toward line still renders", async () =>
{
    const context = (await must(c.box, c.alpha, ["context"])).out;
    assert.ok(context.includes(`[toward ${cBare} (beta)]`), context);
    assert.ok(!context.includes(`untargeted beta objective (beta)`), context);
});

test("C6 the workspace-wide objective listing renders the shared objective once, under its owner", async () =>
{
    const out = (await must(c.box, c.alpha, ["objective", "--workspace"])).out;
    assert.equal(out.split("shared beta objective").length - 1, 1, out);
    const beta = out.indexOf("beta");
    assert.ok(beta !== -1 && beta < out.indexOf("shared beta objective"), out);
});

test("C7 work show in the contributing project shows the link with the owning slug", async () =>
{
    const shown = (await must(c.box, c.alpha, ["work", "show", cW1])).out;
    assert.ok(shown.includes(`${cShared} (beta)`), shown);
});

test("C8 objective show --project answers from anywhere with the owner's merged answer", async () =>
{
    const shown = (await must(c.box, c.alpha, ["objective", "show", cShared, "--project", "beta"])).out;
    assert.ok(shown.includes(`- Work: ${cW1} (alpha)`), shown);
});

test("C9 a unit scoped to render in a third project takes its toward line and Deadlines row along", async () =>
{
    const work = workIdIn((await must(c.box, c.alpha, ["work", "add", "c9 travelling unit"])).out);
    await must(c.box, c.alpha, ["work", "link", work, "--objective", cShared]);
    await must(c.box, c.alpha, ["work", "start", work]);
    await must(c.box, c.alpha, ["state", "place", work, "--scope", "gamma", "--why", "gamma runs it"]);
    const gamma = (await must(c.box, c.gamma, ["context"])).out;
    const row = gamma.split("\n").find((line) => line.includes(work));
    assert.ok(row !== undefined && row.includes(`[toward ${cShared} (beta)]`), gamma);
    assert.ok(gamma.includes(`- 2031-01-01: [objective] shared beta objective (beta)`), gamma);
    assert.ok(!(await must(c.box, c.alpha, ["context"])).out.split("\n").some((line) => line.includes(work)),
        "the unit left the contributing project's render");
});

/* ── D. transitions after the link ─────────────────────────────────── */

test("D1 the owner dropping the objective discloses on the toward line, leaves the Deadlines, and keeps the owner's answer", async () =>
{
    const dropped = objectiveIdIn((await must(c.box, c.beta, ["objective", "add", "beta outcome to drop", "--target", "2032-01-01"])).out);
    const work = workIdIn((await must(c.box, c.alpha, ["work", "add", "d1 unit"])).out);
    await must(c.box, c.alpha, ["work", "link", work, "--objective", dropped]);
    await must(c.box, c.alpha, ["work", "start", work]);
    assert.ok((await must(c.box, c.alpha, ["context"])).out.includes("beta outcome to drop (beta)"));
    retireFixture(c.box, c.ws, "beta", "entity.retired", { entity: dropped, why: "priorities moved" });
    const context = (await must(c.box, c.alpha, ["context"])).out;
    assert.ok(context.includes(`[toward ${dropped} (beta, dropped)]`), context);
    assert.ok(!context.includes("beta outcome to drop (beta)"), "the Deadlines row left");
    assert.ok((await must(c.box, c.beta, ["objective", "show", dropped])).out.includes(`- Work: ${work} (alpha)`),
        "the owner's show keeps the contributing unit");
});

test("D2 a superseded objective discloses, and the link never auto-moves to the successor", async () =>
{
    const old = objectiveIdIn((await must(c.box, c.beta, ["objective", "add", "beta outcome to supersede"])).out);
    const work = workIdIn((await must(c.box, c.alpha, ["work", "add", "d2 unit"])).out);
    await must(c.box, c.alpha, ["work", "link", work, "--objective", old]);
    await must(c.box, c.alpha, ["work", "start", work]);
    objectiveFixture(c.box, c.ws, "beta", "o-ddddd", "the successor outcome", { links: [{ type: "supersedes", target: old }] });
    const context = (await must(c.box, c.alpha, ["context"])).out;
    assert.ok(context.includes(`[toward ${old} (beta, superseded)]`), context);
    const linked = linkEventsFor(c.ws, "alpha", work);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].payload.link.target, old, "the recorded link still names the predecessor");
});

test("D3 a unit done in the contributing project leaves the owner's counts by the open-work rules", async () =>
{
    const count = async () =>
    {
        const line = (await must(c.box, c.beta, ["objective"])).out.split("\n").find((row) => row.startsWith(cShared));
        return Number(line.match(/\[(\d+) work unit\(s\)\]/)[1]);
    };
    const work = workIdIn((await must(c.box, c.alpha, ["work", "add", "d3 unit"])).out);
    await must(c.box, c.alpha, ["work", "link", work, "--objective", cShared]);
    const before = await count();
    assert.ok((await must(c.box, c.beta, ["objective", "show", cShared])).out.includes(`${work} (alpha)`));
    await must(c.box, c.alpha, ["work", "done", work, "--report", "the d3 outcome verifiably landed"]);
    assert.equal(await count(), before - 1);
    assert.ok(!(await must(c.box, c.beta, ["objective", "show", cShared])).out.includes(`${work} (alpha)`));
});

test("D5 undoing the link event removes the link from every surface", async () =>
{
    const work = workIdIn((await must(c.box, c.alpha, ["work", "add", "d5 unit"])).out);
    await must(c.box, c.alpha, ["work", "link", work, "--objective", cShared]);
    await must(c.box, c.alpha, ["work", "start", work]);
    const event = linkEventsFor(c.ws, "alpha", work)[0];
    await must(c.box, c.alpha, ["undo", event.id, "--why", "linked the wrong objective"]);
    assert.ok(!(await must(c.box, c.alpha, ["work", "show", work])).out.includes(`${cShared} (beta)`));
    assert.ok(!(await must(c.box, c.beta, ["objective", "show", cShared])).out.includes(`${work} (alpha)`));
    const row = (await must(c.box, c.alpha, ["context"])).out.split("\n").find((line) => line.includes(work));
    assert.ok(row !== undefined && !row.includes(cShared), row);
});

test("D6 an objective closed as reached discloses on the contributing toward line", async () =>
{
    const reached = objectiveIdIn((await must(c.box, c.beta, ["objective", "add", "beta outcome to reach"])).out);
    const work = workIdIn((await must(c.box, c.alpha, ["work", "add", "d6 unit"])).out);
    await must(c.box, c.alpha, ["work", "link", work, "--objective", reached]);
    await must(c.box, c.alpha, ["work", "start", work]);
    await must(c.box, c.beta, ["objective", "close", reached, "--as", "reached"]);
    const context = (await must(c.box, c.alpha, ["context"])).out;
    assert.ok(context.includes(`[toward ${reached} (beta, reached)]`), context);
});

test("D4 an unregistered owner is disclosed as dangling, and the link is kept", async () =>
{
    const d4 = await trio();
    const objective = objectiveIdIn((await must(d4.box, d4.beta, ["objective", "add", "an orphaned beta outcome"])).out);
    const work = workIdIn((await must(d4.box, d4.alpha, ["work", "add", "d4 unit"])).out);
    await must(d4.box, d4.alpha, ["work", "link", work, "--objective", objective]);
    await must(d4.box, d4.alpha, ["work", "start", work]);
    const registry = join(d4.ws, ".superself", "registry.jsonl");
    const kept = readFileSync(registry, "utf8").split("\n")
        .filter((line) => line.trim() !== "" && JSON.parse(line).slug !== "beta");
    writeFileSync(registry, kept.join("\n") + "\n");
    const context = (await must(d4.box, d4.alpha, ["context"])).out;
    assert.ok(context.includes(`[toward ${objective} (beta, not registered)]`), context);
    assert.ok((await must(d4.box, d4.alpha, ["work", "show", work])).out.includes(`${objective} (beta)`),
        "the link itself is kept");
});

/* ── beyond the cells: merge ordering ──────────────────────────────── */

test("a union-merged log folds the link even when it sits above the unit's creation", async () =>
{
    // A merge orders lines by neither time nor dependency, so the linked event
    // can arrive before the entity it names exists in the log.
    retireFixture(a.box, a.ws, "alpha", "entity.linked",
        { entity: "w-aaaaa", link: { type: "member-of", target: aObjBeta, project: "beta" } });
    retireFixture(a.box, a.ws, "alpha", "entity.confirmed", {
        entity: "w-aaaaa", text: "a unit merged in after its link", labels: ["work"],
        links: [], criteria: [], exposure: "full", scope: "project", priority: 20
    });
    const shown = (await must(a.box, a.alpha, ["work", "show", "w-aaaaa"])).out;
    assert.ok(shown.includes(`${aObjBeta} (beta)`), shown);
});

// #287 cell B16. Work stays where it happens and direction is what it serves,
// so a company objective needs no new link grammar: the cross-project link
// #254 built resolves a workspace-scoped objective exactly as it resolves any
// other project's. Reconfirmation, not new behaviour — the cell exists so a
// change to workspace scope cannot quietly take it away.
test("cell B16 (#287): a unit links to another project's workspace objective, and the unit does not move", async () =>
{
    const company = objectiveIdIn((await must(a.box, a.beta, ["objective", "add", "the company reaches a hundred teams", "--workspace"])).out);
    const work = await aWork("b16 alpha's contribution to the company objective");
    await must(a.box, a.alpha, ["work", "link", work, "--objective", company]);
    assert.ok((await must(a.box, a.alpha, ["work", "show", work])).out.includes(`${company} (beta)`));
    // The unit is still alpha's, and the objective still beta's.
    assert.ok((await must(a.box, a.alpha, ["work"])).out.includes(work));
    assert.ok((await must(a.box, a.beta, ["objective", "show", company])).out.includes(`${work} (alpha)`));
});
