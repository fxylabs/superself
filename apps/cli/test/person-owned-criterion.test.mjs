// #413, every section of `docs/maintainers/case-tables/413-person-owned-criterion.md`:
// a criterion declared as a person's own task, the Waiting-on-you row it grows,
// the `(person)` mark on the surfaces that render criteria, and the fold that
// reads an owner it cannot name as none at all. One test per cell, named by its
// cell number. Section G is in `cutover.test.mjs`, against the CLI at the
// merge base; the golden fixture is cell 62, in `golden.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkContract } from "../dist/contract.js";
import { criteriaNote, criteriaProgress, personOwned } from "@superself/fold";
import { COMMANDS } from "../dist/main.js";
import { buildModel } from "../dist/model.js";
import { renderWorkList } from "../dist/pretty.js";
import { demoWorkspace, git, logFixture, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));

const box = machine();
const { ws, demo } = await demoWorkspace(box);
const storeDir = join(ws, ".superself");

const AGENT = { SUPERSELF_SESSION: "s-413" };

const C1 = "the fixture regenerates clean";
const C2 = "the release note names the flag";
const C3 = "the vendor quota is raised";

function events()
{
    return readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
}

function creationOf(id)
{
    return events().findLast((event) => event.payload.entity === id
        && (event.type === "entity.confirmed" || event.type === "entity.proposed"));
}

function newest(type)
{
    const found = events().filter((event) => event.type === type).at(-1);
    assert.ok(found !== undefined, `no ${type} in the log`);
    return found;
}

function workOf(id, project = "demo")
{
    return buildModel(storeDir, project, new Date()).works.find((item) => item.id === id);
}

// `U` throughout the table: a confirmed, started unit declaring three criteria,
// the second of them a person's own.
async function ownedUnit(outcome, extra = [])
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", outcome,
        "--criteria", C1, "--criteria", C2, "--criteria", C3, "--owner", "c2 person", ...extra])).out);
    await must(box, demo, ["work", "start", id]);
    return id;
}

// Section C reads a whole context section, so it gets a machine of its own:
// the shared workspace above accumulates waiting rows past the context budget,
// and a truncated section proves nothing about the row that was cut.
const waitBox = machine();
const { demo: waitDemo } = await demoWorkspace(waitBox);

async function waitingUnit(outcome, extra = [], start = true)
{
    const id = workIdIn((await mustPerson(waitBox, waitDemo, ["work", "add", outcome,
        "--criteria", C1, "--criteria", C2, "--criteria", C3, "--owner", "c2 person", ...extra])).out);
    if (start)
    {
        await must(waitBox, waitDemo, ["work", "start", id]);
    }
    return id;
}

function waitingRows(context, id)
{
    const section = context.split("## ").find((part) => part.startsWith("Waiting on you"));
    return (section ?? "").split("\n").filter((line) => line.startsWith(`- ${id} `));
}

/* ── A. declaring at birth ─────────────────────────────────────────── */

test("cell 1: work add records --owner as the sparse map keyed by the position it names", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 1",
        "--criteria", "a", "--criteria", "b", "--owner", "c2 person"])).out);
    const created = creationOf(id);
    assert.deepEqual(created.payload.owner, { c2: "person" });
    assert.deepEqual(created.payload.criteria, ["a", "b"]);
});

test("cell 2: work add with no --owner writes no owner key at all", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 2", "--criteria", "a"])).out);
    assert.ok(!("owner" in creationOf(id).payload), "an unowned unit's payload gained an owner key");
});

test("cell 3: --owner with no --criteria is refused, naming the flag to pass too", async () =>
{
    const refused = await selfIn(box, demo, ["work", "add", "cell 3", "--owner", "c1 person"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out,
        /work add --owner states whose task one declared criterion is — pass --criteria "<text>" too/);
});

test("cell 4: --owner that does not begin with a cN is refused, showing the shape and the range", async () =>
{
    const refused = await selfIn(box, demo, ["work", "add", "cell 4", "--criteria", "a", "--owner", "person"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out,
        /work add --owner must begin with the criterion it names — "c1 person"; this call declares c1/);
});

test("cell 5: --owner naming a cN past what the call declares is refused with the range", async () =>
{
    const refused = await selfIn(box, demo, ["work", "add", "cell 5", "--criteria", "a", "--owner", "c4 person"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /work add --owner names c4, and this call declares c1/);
});

test("cell 6: --owner naming one criterion twice is refused", async () =>
{
    const refused = await selfIn(box, demo, ["work", "add", "cell 6", "--criteria", "a", "--criteria", "b",
        "--owner", "c1 person", "--owner", "c1 person"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /work add --owner names c1 twice — one criterion has one owner/);
});

test("cell 7: an owner that is not `person` is refused, and the refusal says what absent means", async () =>
{
    const refused = await selfIn(box, demo, ["work", "add", "cell 7", "--criteria", "a", "--owner", "c1 rayim"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /work add --owner takes "person" — it is the only owner a criterion states, and one/);
    assert.match(refused.out, /with no owner is the session's own task/);
});

test("cell 8: --owner and --verify ride the one creation event as separate keys", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 8",
        "--criteria", "a", "--owner", "c1 person", "--verify", "c1 the page shows it"])).out);
    const created = creationOf(id);
    assert.deepEqual(created.payload.owner, { c1: "person" });
    assert.deepEqual(created.payload.verify, { c1: "the page shows it" });
});

test("cell 9: --verify's own refusal is byte-identical to what #408 shipped", async () =>
{
    const refused = await selfIn(box, demo, ["work", "add", "cell 9", "--criteria", "a",
        "--verify", "the fixture regenerates"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out,
        /work add --verify must begin with the criterion it verifies — "c1 <how it is checked>"; this call declares c1/);
});

test("cell 10: work propose carries the same map, and the rest of the payload is unchanged", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 10",
        "--criteria", "a", "--criteria", "b", "--owner", "c1 person"], AGENT)).out);
    const created = creationOf(id);
    assert.equal(created.type, "entity.proposed");
    assert.deepEqual(created.payload.owner, { c1: "person" });
    assert.deepEqual(created.payload.criteria, ["a", "b"]);
});

test("cell 10a: the flag reaches the two add verbs and nothing else", async () =>
{
    // The waiting row's whole value is the `self work cover` line it carries,
    // and that line needs a work unit — so `--owner` is on the work verbs'
    // option set and on no other, which the parser is what enforces.
    const raw = await selfIn(box, demo, ["state", "add", "cell 10a", "--criteria", "a", "--owner", "c1 person"]);
    assert.equal(raw.code, 1);
    assert.match(raw.out, /unknown option '--owner'/);
    const plan = workIdIn((await mustPerson(box, demo, ["work", "propose", "cell 10a plan"])).out);
    const revised = await selfIn(box, demo, ["work", "revise", plan, "y", "--why", "w", "--owner", "c1 person"]);
    assert.equal(revised.code, 1);
    assert.match(revised.out, /unknown option '--owner'/);
});

/* ── B. declaring later ────────────────────────────────────────────── */

test("cell 11: work criteria add --owner person writes the bare string on the declaration", async () =>
{
    const id = await ownedUnit("cell 11");
    await must(box, demo, ["work", "criteria", "add", id, "cell 11 later", "--owner", "person"]);
    const declared = newest("entity.criterion-declared");
    assert.equal(declared.payload.entity, id);
    assert.equal(declared.payload.owner, "person");
});

test("cell 12: work criteria add with no --owner writes no owner key", async () =>
{
    const id = await ownedUnit("cell 12");
    await must(box, demo, ["work", "criteria", "add", id, "cell 12 later"]);
    assert.ok(!("owner" in newest("entity.criterion-declared").payload));
});

test("cell 13: a bare --owner that is not `person` is refused in the same words", async () =>
{
    const id = await ownedUnit("cell 13");
    const refused = await selfIn(box, demo, ["work", "criteria", "add", id, "cell 13 later", "--owner", "someone"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /work criteria add --owner takes "person" — it is the only owner a criterion states/);
});

test("cell 14: --verify and --owner ride the one declaration event", async () =>
{
    const id = await ownedUnit("cell 14");
    await must(box, demo, ["work", "criteria", "add", id, "cell 14 later",
        "--verify", "the quota page shows 10k", "--owner", "person"]);
    const declared = newest("entity.criterion-declared");
    assert.equal(declared.payload.verify, "the quota page shows 10k");
    assert.equal(declared.payload.owner, "person");
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.match(shown, /c4 open — cell 14 later · verify: the quota page shows 10k \(person\)/);
});

test("cell 15: the declaration receipt names the ownership, and the done clause where it applies", async () =>
{
    const id = await ownedUnit("cell 15");
    const receipt = (await must(box, demo, ["work", "criteria", "add", id, "cell 15 later", "--owner", "person"])).out;
    assert.match(receipt, new RegExp(`${id} c4 "cell 15 later" \\(person\\)$`, "m"));
    const bare = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 15 bare"])).out);
    const first = (await must(box, demo, ["work", "criteria", "add", bare, "the first one", "--owner", "person"])).out;
    assert.match(first, new RegExp(`${bare} c1 "the first one" \\(person\\) — done now waits on it$`, "m"));
});

test("cell 16: nothing re-owns a criterion — a second declaration of one text is refused", async () =>
{
    const id = await ownedUnit("cell 16");
    const refused = await selfIn(box, demo, ["work", "criteria", "add", id, C1, "--owner", "person"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`${id} already declares c1 "${C1}" — a criterion is judged once`));
    assert.equal(workOf(id).criteria[0].owner, undefined, "the refused call changed the criterion's owner");
});

test("cell 17: a plan still in review takes a person-owned declaration", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "propose", "cell 17 plan"], AGENT)).out);
    await must(box, demo, ["work", "criteria", "add", id, "cell 17 later", "--owner", "person"]);
    assert.equal(newest("entity.criterion-declared").payload.owner, "person");
});

/* ── C. the Waiting-on-you row ─────────────────────────────────────── */

test("cell 18: an open person-owned criterion is one waiting row carrying the cover line", async () =>
{
    const id = await waitingUnit("cell 18");
    const rows = waitingRows((await must(waitBox, waitDemo, ["context"])).out, id);
    assert.deepEqual(rows, [`- ${id} c2 ${C2} — yours `
        + `(cover with \`self work cover ${id} --criterion c2 --why "<how>"\`)`]);
});

test("cell 19: the ruled render prints the same sentence with the cover command of its own", async () =>
{
    const id = await waitingUnit("cell 19");
    const printed = (await must(waitBox, waitDemo, ["context", "--pretty"])).out;
    assert.ok(printed.includes(`${id} c2 ${C2} — yours`), `the ruled render lost the row:\n${printed}`);
    assert.ok(printed.includes(`self work cover ${id} --criterion c2 --why "<how>"`),
        `the ruled render lost the cover command:\n${printed}`);
});

test("cell 20: covering the criterion takes the row away", async () =>
{
    const id = await waitingUnit("cell 20");
    await must(waitBox, waitDemo, ["work", "cover", id, "--criterion", "c2", "--why", "the note names it now"]);
    assert.deepEqual(waitingRows((await must(waitBox, waitDemo, ["context"])).out, id), []);
});

test("cell 21: a blocked person-owned criterion still lists, with the block named", async () =>
{
    const id = await waitingUnit("cell 21");
    await must(waitBox, waitDemo, ["work", "block", id, "--criterion", "c2", "--on", "external",
        "--why", "the vendor is silent"]);
    const rows = waitingRows((await must(waitBox, waitDemo, ["context"])).out, id);
    assert.deepEqual(rows, [`- ${id} c2 ${C2} — yours · blocked on external — the vendor is silent `
        + `(cover with \`self work cover ${id} --criterion c2 --why "<how>"\`)`]);
});

test("cell 22: a blocked criterion nobody owns still grows no row — #408 cell 82 holds", async () =>
{
    const id = workIdIn((await mustPerson(waitBox, waitDemo, ["work", "add", "cell 22",
        "--criteria", "a", "--criteria", "b", "--criteria", "c"])).out);
    await must(waitBox, waitDemo, ["work", "start", id]);
    await must(waitBox, waitDemo, ["work", "block", id, "--criterion", "c3", "--on", "decision",
        "--why", "pricing undecided"]);
    assert.deepEqual(waitingRows((await must(waitBox, waitDemo, ["context"])).out, id), []);
});

test("cell 23: two person-owned criteria give two rows, in cN order", async () =>
{
    const id = workIdIn((await mustPerson(waitBox, waitDemo, ["work", "add", "cell 23",
        "--criteria", "a", "--criteria", "b", "--criteria", "c",
        "--owner", "c3 person", "--owner", "c1 person"])).out);
    await must(waitBox, waitDemo, ["work", "start", id]);
    const rows = waitingRows((await must(waitBox, waitDemo, ["context"])).out, id);
    assert.equal(rows.length, 2, `expected one row per owned criterion:\n${rows.join("\n")}`);
    assert.match(rows[0], new RegExp(`^- ${id} c1 a — yours `));
    assert.match(rows[1], new RegExp(`^- ${id} c3 c — yours `));
});

test("cell 24: a plan awaiting review grows no row — nothing is actionable before the confirm", async () =>
{
    const id = workIdIn((await must(waitBox, waitDemo, ["work", "propose", "cell 24 plan",
        "--criteria", "a", "--owner", "c1 person"], AGENT)).out);
    const context = (await must(waitBox, waitDemo, ["context"])).out;
    assert.deepEqual(waitingRows(context, id).filter((row) => row.includes("yours")), []);
    // The review it does owe is still there, so the absence above is the
    // criterion's row and not the whole unit going missing.
    assert.ok(context.includes(id), `the plan left the context entirely:\n${context}`);
});

test("cell 25: a closed unit grows no row, whether it was done or retired", async () =>
{
    const done = await waitingUnit("cell 25 done");
    for (const at of ["c1", "c2", "c3"])
    {
        await must(waitBox, waitDemo, ["work", "cover", done, "--criterion", at, "--why", "landed"]);
    }
    await must(waitBox, waitDemo, ["work", "done", done, "--report", "the sweep proved it"]);
    const retired = await waitingUnit("cell 25 retired");
    await must(waitBox, waitDemo, ["work", "retire", retired, "--why", "the outcome was given up"]);
    const context = (await must(waitBox, waitDemo, ["context"])).out;
    assert.deepEqual(waitingRows(context, done), []);
    assert.deepEqual(waitingRows(context, retired), []);
});

test("cell 26: the unit's own status is untouched and it is not counted among blocked ones", async () =>
{
    const id = await waitingUnit("cell 26");
    const row = (await must(waitBox, waitDemo, ["work"])).out.split("\n").find((line) => line.startsWith(id));
    assert.match(row, new RegExp(`^${id}  active  `));
    const counts = (await must(waitBox, waitDemo, ["status"])).out.split("\n").find((line) => line.startsWith("work: "));
    assert.match(counts, /0 blocked/);
});

test("cell 27: the row is scoped to its own project, and reached with --project from elsewhere", async () =>
{
    const other = join(waitBox.root, "ws", "other");
    mkdirSync(other, { recursive: true });
    git(waitBox, other, ["init", "-q", "-b", "main"]);
    await must(waitBox, other, ["project", "init", "--name", "other", "--desc", "the sibling", "--no-connect"]);
    const id = await waitingUnit("cell 27");
    const root = join(waitBox.root, "ws");
    const scoped = (await must(waitBox, root, ["context", "--project", "demo"])).out;
    assert.equal(waitingRows(scoped, id).length, 1, `the scoped read lost the row:\n${scoped}`);
    const sibling = (await must(waitBox, root, ["context", "--project", "other"])).out;
    assert.deepEqual(waitingRows(sibling, id), [], "the row reached a project that does not own the unit");
});

test("cell 28: the row is counted once in `waiting on you` and appears once in the open questions", async () =>
{
    const count = async () => Number((await must(waitBox, waitDemo, ["status"])).out
        .split("\n").find((line) => line.startsWith("waiting on you: ")).match(/\d+/)[0]);
    const before = await count();
    const id = await waitingUnit("cell 28");
    assert.equal(await count(), before + 1);
    assert.equal((await must(waitBox, waitDemo, ["context"])).out.split("\n")
        .filter((line) => line.includes(`${id} c2 ${C2} — yours`)).length, 1);
});

/* ── D. the renders beside the row ─────────────────────────────────── */

test("cell 29: work show marks an open person-owned criterion, after its verify text", async () =>
{
    const id = await ownedUnit("cell 29", ["--verify", "c2 the note carries the line"]);
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.ok(shown.includes(`  - c2 open — ${C2} · verify: the note carries the line (person)`),
        `the open bullet lost the mark:\n${shown}`);
});

test("cell 30: the mark stays after covering — it says what the unit declared", async () =>
{
    const id = await ownedUnit("cell 30");
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "the user signed it"]);
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.match(shown, /- c2 covered — the user signed it \(agent \d{4}-\d{2}-\d{2}\) \(person\)$/m);
});

test("cell 31: a blocked person-owned criterion carries the mark after its block", async () =>
{
    const id = await ownedUnit("cell 31");
    await must(box, demo, ["work", "block", id, "--criterion", "c2", "--on", "external", "--why", "the vendor is silent"]);
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.ok(shown.includes("  - c2 blocked on external — the vendor is silent (person)"),
        `the blocked bullet lost the mark:\n${shown}`);
});

test("cell 32: a unit whose criteria nobody owns renders byte-identically to #408", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 32",
        "--criteria", "a", "--criteria", "b"])).out);
    await must(box, demo, ["work", "start", id]);
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.doesNotMatch(shown, /\(person\)/);
    assert.ok(shown.includes("- Criteria: 0 of 2 covered"), shown);
});

// Cells 33–37's unit, seeded once: c2 open and owned, c3 blocked and unowned.
let mixed = null;

function mixedUnit()
{
    mixed ??= (async () =>
    {
        const id = await ownedUnit("cell 33");
        await must(box, demo, ["work", "block", id, "--criterion", "c3", "--on", "decision", "--why", "pricing undecided"]);
        return id;
    })();
    return mixed;
}

test("cell 33: ownership never changes the blocked count in the criteria header", async () =>
{
    const id = await mixedUnit();
    const shown = (await must(box, demo, ["work", "show", id])).out;
    assert.ok(shown.includes("- Criteria: 0 of 3 covered (1 blocked)"), shown);
});

test("cell 34: the terminal `self work` note names both, in cN order", async () =>
{
    const id = await mixedUnit();
    assert.equal(criteriaNote(workOf(id).criteria),
        "0 of 3 criteria covered · c2 (person) · c3 blocked on decision");
    // The note goes through `noteLine`'s own fit, so what the table shows is
    // this sentence truncated to the flex column, never widened past it.
    const lines = renderWorkList(buildModel(storeDir, "demo", new Date()));
    assert.ok(lines.some((line) => line.includes("↳ 0 of 3 criteria covered · c2 (person)")),
        `the note is not under the row:\n${lines.join("\n")}`);
});

test("cell 35: a criterion both blocked and owned is one entry, never two", async () =>
{
    const id = await ownedUnit("cell 35");
    await must(box, demo, ["work", "block", id, "--criterion", "c2", "--on", "decision", "--why", "the user has not chosen"]);
    const note = criteriaNote(workOf(id).criteria);
    assert.equal(note, "0 of 3 criteria covered · c2 blocked on decision (person)");
    assert.equal(note.split("c2").length - 1, 1, `c2 was named twice: ${note}`);
});

test("cell 36: the piped `self work` segment is the count alone, unchanged from #408", async () =>
{
    const id = await mixedUnit();
    const row = (await must(box, demo, ["work"])).out.split("\n").find((line) => line.startsWith(id));
    assert.match(row, /\[0 of 3 criteria covered\]/);
    assert.doesNotMatch(row, /\(person\)/);
});

test("cell 37: the work-in-progress row of `self context` carries the same sentence", async () =>
{
    const id = await mixedUnit();
    const row = (await must(box, demo, ["context"])).out.split("\n").find((line) => line.startsWith(`- ${id} `));
    assert.match(row, / — 0 of 3 criteria covered · c2 \(person\) · c3 blocked on decision/);
});

test("cell 38: `milestone show`'s linked-work row carries the same sentence again", async () =>
{
    const id = await mixedUnit();
    const objective = (await must(box, demo, ["objective", "add", "cell 38 objective"])).out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const milestone = (await must(box, demo, ["milestone", "add", "cell 38 checkpoint",
        "--objective", objective, "--exit", "the exit criterion"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    await must(box, demo, ["work", "link", id, "--milestone", milestone]);
    const shown = (await must(box, demo, ["milestone", "show", milestone])).out;
    assert.ok(shown.includes("0 of 3 criteria covered · c2 (person) · c3 blocked on decision"),
        `the milestone row does not carry the one sentence:\n${shown}`);
});

test("cell 39: criteriaProgress is unchanged — no owner in the k of n sentence", async () =>
{
    const id = await mixedUnit();
    const progress = criteriaProgress(workOf(id).criteria);
    assert.deepEqual(progress, { covered: 0, total: 3, waiting: ["c3 blocked on decision"] });
});

test("cell 40: the synced work/<id>.md carries the identical block, mark included", async () =>
{
    const id = await ownedUnit("cell 40");
    await must(box, demo, ["fold"]);
    const page = readFileSync(join(storeDir, "projects", "demo", "work", `${id}.md`), "utf8");
    assert.ok(page.includes(`  - c2 open — ${C2} (person)`), `the synced page lost the mark:\n${page}`);
});

test("cell 41: the log row for the declaration is #408's, unchanged", async () =>
{
    const id = await ownedUnit("cell 41");
    await must(box, demo, ["work", "criteria", "add", id, "cell 41 later", "--owner", "person"]);
    const row = (await must(box, demo, ["log", "-n", "1"])).out.trim();
    assert.match(row, new RegExp(`entity\\.criterion-declared.*${id} "cell 41 later"`));
    assert.doesNotMatch(row, /person/);
});

test("cell 41a: the done refusal marks a row that is not the session's to cover", async () =>
{
    const id = await ownedUnit("cell 41a");
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    const refused = await selfIn(box, demo, ["work", "done", id, "--report", "it happened"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, new RegExp(`    c2  open — ${C2} \\(person\\)`));
    assert.match(refused.out, new RegExp(`    c3  open — ${C3}$`, "m"));
});

test("cell 41b: the cover line the refusal names is one the session can act on", async () =>
{
    // The same reasoning `nextToCover` already applied to a blocked criterion:
    // the line a reader pastes should be the one nothing stands in front of,
    // and somebody else's task stands in front of it.
    const id = await ownedUnit("cell 41b");
    const refused = await selfIn(box, demo, ["work", "done", id, "--report", "it happened"]);
    assert.match(refused.out, new RegExp(`cover each with \`self work cover ${id} --criterion c1 --why "<how>"\``));
    // With every unowned criterion covered, it falls back to the owned one
    // rather than naming nothing.
    await must(box, demo, ["work", "cover", id, "--criterion", "c1", "--why", "landed"]);
    await must(box, demo, ["work", "cover", id, "--criterion", "c3", "--why", "landed"]);
    const last = await selfIn(box, demo, ["work", "done", id, "--report", "it happened"]);
    assert.match(last.out, new RegExp(`cover each with \`self work cover ${id} --criterion c2 --why "<how>"\``));
});

/* ── E. self undo ──────────────────────────────────────────────────── */

test("cell 42: undoing the declaration takes the criterion and its row with it", async () =>
{
    const id = await ownedUnit("cell 42");
    await must(box, demo, ["work", "criteria", "add", id, "cell 42 later", "--owner", "person"]);
    const declared = newest("entity.criterion-declared").id;
    assert.equal(waitingRows((await must(box, demo, ["context"])).out, id).length, 2);
    const receipt = (await must(box, demo, ["undo", declared])).out;
    assert.match(receipt, new RegExp(`${id} no longer declares "cell 42 later" — the declaration was taken back`));
    assert.equal(waitingRows((await must(box, demo, ["context"])).out, id).length, 1);
});

test("cell 43: undoing the creation of a unit whose payload carried an owner takes the whole unit", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 43",
        "--criteria", C1, "--criteria", C2, "--owner", "c2 person"])).out);
    const created = creationOf(id).id;
    await must(box, demo, ["undo", created]);
    assert.deepEqual(waitingRows((await must(box, demo, ["context"])).out, id), []);
    assert.equal(workOf(id).status, "undone");
});

test("cell 44: undoing the coverage claim brings the row back — ownership survived it", async () =>
{
    const id = await ownedUnit("cell 44");
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "the user signed it"]);
    const claim = newest("entity.covered").id;
    assert.deepEqual(waitingRows((await must(box, demo, ["context"])).out, id), []);
    await must(box, demo, ["undo", claim]);
    assert.equal(waitingRows((await must(box, demo, ["context"])).out, id).length, 1);
    assert.equal(workOf(id).criteria[1].owner, "person");
});

/* ── F. the fold ───────────────────────────────────────────────────── */

// A hand-appended line is what these cells are about: the verbs refuse every
// shape below, so the fold is the only thing standing between a store somebody
// edited — or a later CLI wrote — and a render that claims something false.
let fixtures = 0;

function appended(type, payload)
{
    fixtures += 1;
    return logFixture(ws, "demo", {
        id: `01hz0000000000000000041${String(fixtures).padStart(2, "0")}`,
        ts: `2026-01-01T00:${String(fixtures).padStart(2, "0")}:00.000Z`,
        type, project: "demo", refs: {}, origin: { actor: "human", confirmed: true }, payload
    });
}

// A creation event a later CLI could have written: this branch's verbs refuse
// every `owner` shape below, so nothing but a hand-append or another version
// can produce one.
function appendedUnit(id, outcome, extra)
{
    return appended("entity.confirmed", {
        entity: id, text: outcome, labels: ["work"], links: [], exposure: "search", scope: "project", ...extra
    });
}

function entityOf(id)
{
    return buildModel(storeDir, "demo", new Date()).entities.find((item) => item.id === id);
}

test("cell 45: an owner value this CLI cannot name is ignored, and no row is grown", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 45", "--criteria", "a"])).out);
    await must(box, demo, ["work", "start", id]);
    appended("entity.criterion-declared", { entity: id, criterion: "cell 45 later", owner: "rayim" });
    const work = workOf(id);
    assert.equal(work.criteria.length, 2, "the declaration itself was dropped with its owner");
    assert.equal(work.criteria[1].owner, undefined, "an owner this CLI cannot name reached the fold");
    assert.deepEqual(waitingRows((await must(box, demo, ["context"])).out, id), []);
});

test("cell 46: a creation `owner` that is a string, an array or names a position nothing declares reads as absent", () =>
{
    const shapes = [["w-o46st", "person"], ["w-o46ar", ["person"]], ["w-o46gp", { c9: "person" }]];
    for (const [id, owner] of shapes)
    {
        appendedUnit(id, `cell 46 ${id}`, { criteria: ["a", "b"], owner, verify: { c1: "the page shows it" } });
        const record = entityOf(id);
        assert.deepEqual(record.criteria, ["a", "b"], `${id}: the criteria did not stand`);
        assert.deepEqual(record.criterionStates.map((item) => item.owner), [undefined, undefined], id);
        assert.equal(record.criterionStates[0].verify, "the page shows it", `${id}: verify was lost with owner`);
    }
});

test("cell 47: a declaration whose owner is not a string is ignored and the criterion still declares", async () =>
{
    const id = workIdIn((await mustPerson(box, demo, ["work", "add", "cell 47", "--criteria", "a"])).out);
    appended("entity.criterion-declared", { entity: id, criterion: "cell 47 later", owner: true });
    const work = workOf(id);
    assert.equal(work.criteria.length, 2);
    assert.equal(work.criteria[1].owner, undefined);
});

test("cell 48: ownership rides the declaration, so the same line merged in twice folds once", async () =>
{
    const id = await ownedUnit("cell 48");
    await must(box, demo, ["work", "criteria", "add", id, "cell 48 later", "--owner", "person"]);
    // The same line carried in twice, as a union merge does. The event-id
    // guard is what makes it one criterion, and the owner rides it either way.
    logFixture(ws, "demo", newest("entity.criterion-declared"));
    assert.deepEqual(workOf(id).criteria.map((item) => item.owner), [undefined, "person", undefined, "person"]);
});

test("cell 49: block, unblock and cover never touch the owner", async () =>
{
    const id = await ownedUnit("cell 49");
    await must(box, demo, ["work", "block", id, "--criterion", "c2", "--on", "external", "--why", "the vendor is silent"]);
    assert.equal(workOf(id).criteria[1].owner, "person");
    await must(box, demo, ["work", "unblock", id, "--criterion", "c2"]);
    assert.equal(workOf(id).criteria[1].owner, "person");
    await must(box, demo, ["work", "cover", id, "--criterion", "c2", "--why", "the user signed it"]);
    const criterion = workOf(id).criteria[1];
    assert.equal(criterion.owner, "person");
    assert.equal(personOwned(criterion), false, "a covered criterion still counts as owed");
});

test("cell 50: a duplicate criterion folds away and takes the key meant for its position with it", () =>
{
    appendedUnit("w-o50du", "cell 50", { criteria: ["a", "a", "b"], owner: { c2: "person" } });
    const record = entityOf("w-o50du");
    assert.deepEqual(record.criteria, ["a", "b"]);
    // c2 named the second "a", which is not a criterion: nothing is silently
    // owned by a key meant for another.
    assert.deepEqual(record.criterionStates.map((item) => item.owner), [undefined, undefined]);
});

/* ── G. mixed version — cells 51, 52 and 53 ───────────────────────

   Asserted in `cutover.test.mjs`, beside #408's section K and against the same
   base CLI: a claim about *another* fold's answer is worth only as much as the
   fold that gives it, so it is run against the tree at the merge base rather
   than against a description of it here.                                    */

/* ── H. who wrote it, and whose it is ──────────────────────────────── */

test("cell 54: an agent session records a criterion a person will do — both facts on one event", async () =>
{
    const id = workIdIn((await must(box, demo, ["work", "add", "cell 54",
        "--criteria", "a", "--owner", "c1 person"], AGENT)).out);
    const created = creationOf(id);
    assert.deepEqual(created.payload.by, { kind: "agent", session: "s-413" });
    assert.deepEqual(created.payload.owner, { c1: "person" });
});

test("cell 55: a person at a keyboard writes both, and neither implies the other", async () =>
{
    const id = await ownedUnit("cell 55");
    await mustPerson(box, demo, ["work", "criteria", "add", id, "cell 55 later", "--owner", "person"]);
    const declared = newest("entity.criterion-declared");
    assert.deepEqual(declared.payload.by, { kind: "person" });
    assert.equal(declared.payload.owner, "person");
});

/* ── I. help, documentation and the contract ───────────────────────── */

test("cell 56: the usage lines carry the flag in both its forms", async () =>
{
    const help = (await must(box, demo, ["work", "--help"])).out;
    assert.match(help, /work add .*\[--owner "cN person"\]/s);
    assert.match(help, /work propose .*\[--owner "cN person"\]/s);
    assert.match(help, /work criteria add <id> "<text>" \[--verify "<how it is checked>"\] \[--owner person\]/);
});

test("cell 57: the option list states what --owner means and that it is stated once", async () =>
{
    const help = (await must(box, demo, ["work", "--help"])).out;
    assert.match(help, /--owner "cN person"\s+the criterion is a person's own task rather than this/);
    assert.match(help, /stated\s+at declaration and never re-stated/);
});

test("cell 58: `self help work` carries the by-vs-owner sentence and the no-re-owning rule", async () =>
{
    const page = (await must(box, demo, ["help", "work"])).out;
    assert.match(page, /`by` is who wrote the record;\s+--owner is whose task the criterion is/);
    assert.match(page, /nothing re-states it: a wrong\s+one is undone and declared again/);
    assert.match(page, /self work criteria add <id> "<text>" --owner person/);
});

test("cell 59: the agent block states the same distinction in one place, in both files", async () =>
{
    await must(box, demo, ["connect"]);
    for (const name of ["AGENTS.md", "CLAUDE.md"])
    {
        const block = readFileSync(join(demo, name), "utf8");
        assert.match(block, /`--owner "cN person"` on the/, name);
        assert.match(block, /`by` is who wrote the record and `--owner` is\s+whose task the criterion is/, name);
    }
});

test("cell 60: docs/reference/cli.md documents the flag and names the payload field", () =>
{
    const doc = readFileSync(join(repo, "docs/reference/cli.md"), "utf8");
    assert.match(doc, /`--owner "cN person"` says one declared criterion is a person's own task/);
    assert.match(doc, /`person` is the only value, and absent means the session/);
    assert.match(doc, /whose `owner` names a criterion a person owes rather than the session/);
});

test("cell 61: checkContract passes with the flag declared on the leaves that document it", () =>
{
    assert.deepEqual(checkContract(COMMANDS), []);
});
