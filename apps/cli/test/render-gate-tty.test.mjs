// The terminal half of the render-gate case table (w-5emx6 stage 1): cells 2,
// 5 and 8, plus stage 2's cell 2 and stage 3's cell 13. `style.ts` answers "is this run styled" once, when it is first
// imported, from stdout — so a test that wants the styled answer has to say so
// before the built modules load, and run the command in this process rather
// than in a child whose stdout is a pipe.
process.stdout.isTTY = true;
process.env.TERM = "xterm";
delete process.env.NO_COLOR;

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `mustSpawn` rather than `must`: the setup commands run as children on
// purpose. `style.ts` decided this run is styled when it was imported above,
// and the in-process driver cannot take that back — normalising the terminal
// for a call is too late for a decision already made at module load. A setup
// command's confirmation line would come back painted, and `idIn` parses
// `[brackets]` out of it (#371, cell 23).
const { approvedIn, git, machine, mustSpawn } = await import("./harness.mjs");
const { rootUsage } = await import("../dist/help.js");
const { COMMANDS } = await import("../dist/main.js");
const { buildModel } = await import("../dist/model.js");
const { renderOutput } = await import("../dist/output.js");
const { renderWorkList } = await import("../dist/pretty.js");
const { NO_OBJECTIVE_HINT } = await import("../dist/goals.js");
const { bold, dim, green, styled } = await import("../dist/style.js");

const box = machine();
const ws = join(box.root, "ws");
const demo = join(ws, "demo");
mkdirSync(demo, { recursive: true });
mustSpawn(box, ws, ["init", "--git"]);
git(box, demo, ["init", "-q", "-b", "main"]);
mustSpawn(box, demo, ["project", "init", "--name", "demo", "--desc", "the render gate", "--no-connect"]);

// A confirmed unit, in the two steps a session and a person take since #389:
// the plan is proposed by a child, whose unpainted receipt carries the id, and
// the acceptance runs in this process, where a keyboard can be stood in for.
// Its painted answer is read by nothing, which is why the split is safe here.
async function recordedUnit(plan)
{
    const proposed = mustSpawn(box, demo, ["work", "propose", plan]).out.match(/\bw-[0-9a-z]{5}\b/)[0];
    const accepted = await approvedIn(box, demo, ["work", "confirm", proposed], "");
    assert.equal(accepted.code, 0, accepted.out);
    return proposed;
}

test("this file loads with a styled stdout, or its cells assert nothing", () =>
{
    assert.equal(styled, true);
});

// A scalar answer is a value whatever the terminal is. The gate resolves the
// render mode for every run, and the cell that matters is that resolving it
// changed nothing here: the bytes are the piped bytes of cells 4 and 1.
test("cell 5: at a terminal, `self lang ko` prints the same bytes a pipe gets", async () =>
{
    const answer = await approvedIn(box, demo, ["lang", "ko"], "");
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.printed, "views now render in \"ko\"\n");
});

test("cell 2: at a terminal, `self lang` prints the same bytes a pipe gets", async () =>
{
    const answer = await approvedIn(box, demo, ["lang"], "");
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.printed, "ko\n");
});

// The append's confirmation line is not a command's answer — it is a notice
// from a lower layer, printed while the command is still running. Moving it
// through the gate's `notice` left its styling where it was composed.
test("cell 8: at a styled terminal, an event verb prints today's ✓ line", async () =>
{
    const text = "the gate prints once";
    const answer = await approvedIn(box, demo, ["decide", text, "--proposed"], "");
    assert.equal(answer.code, 0, answer.out);
    // The id is read by its own grammar rather than out of the first brackets:
    // a styled line opens with an escape sequence, and those carry brackets too.
    const id = answer.printed.match(/\[([0-9abcdefghjkmnpqrstvwxyz]{26})\]/)[1];
    // The review line #390 added is the append's too, and dim for the same
    // reason the summary is: it is not the command's answer.
    assert.equal(answer.printed,
        `${green("✓")} ${bold("entity.proposed")}  ${dim(text)}  ${dim(`[${id}]`)}\n`
        + `${dim(`  ${text} — verify; wrong? self undo ${id}`)}\n`);
});

// The bare id a work unit is created under is a receipt, and a receipt is the
// same bytes at a terminal as in a pipe. What the terminal changes is the
// announce line above it, which `pipeline.ts` still composes — so this cell is
// the two of them together, in the order they have always been printed in.
// Since #286 the attachment offer follows the id, dim, and this project has no
// objective, so the offer is the one line that says how to record one.
test("stage 2 cell 2: at a terminal, `self work add` styles the announce line and leaves the id alone", async () =>
{
    const outcome = "the receipts answer through the gate";
    const answer = await approvedIn(box, demo, ["work", "add", outcome], "");
    assert.equal(answer.code, 0, answer.out);
    // The append's own two lines since #390, then the id.
    const [announced, , id] = answer.printed.split("\n");
    const event = announced.match(/\[([0-9abcdefghjkmnpqrstvwxyz]{26})\]/)[1];
    assert.equal(announced, `${green("✓")} ${bold("entity.confirmed")}  ${dim(`${id} ${outcome}`)}  ${dim(`[${event}]`)}`);
    assert.match(answer.printed, /\nw-[0-9abcdefghjkmnpqrstvwxyz]{5}\n/);
    assert.equal(answer.printed.endsWith(`\n${dim(NO_OBJECTIVE_HINT)}\n`), true,
        `the attachment offer is not the dim last line:\n${JSON.stringify(answer.printed)}`);
});

/* ── stage 3 cell 13: the size line is a plain-render line ─────────── */

// The listings state their size for a reader who is not looking at a screen.
// A person at a terminal reads a ruled render that frames its own rows, so the
// pretty half of every migrated surface prints exactly what it printed before
// the move — which for `self work` is the ruled list and nothing under it.
test("stage 3 cell 13: at a terminal, `self work` prints the ruled list with no size line under it", async () =>
{
    await recordedUnit("the listings answer with blocks");
    const answer = await approvedIn(box, demo, ["work"], "");
    assert.equal(answer.code, 0, answer.out);
    const model = buildModel(join(ws, ".superself"), "demo", new Date());
    assert.equal(answer.printed, `${renderWorkList(model).join("\n")}\n`);
    assert.equal(sizeLines(answer.printed).length, 0, answer.printed);
});

test("stage 3 cell 13: at a terminal, `self context` and `self status` gained no size line", async () =>
{
    for (const verb of ["context", "status"])
    {
        const answer = await approvedIn(box, demo, [verb], "");
        assert.equal(answer.code, 0, answer.out);
        assert.deepEqual(sizeLines(answer.printed), [], verb);
    }
});

// A size line is a whole line that is a count and the thing counted, which is
// the shape nothing a document render prints has.
function sizeLines(printed)
{
    return printed.split("\n").filter((line) =>
        /^\d+ (project|archived project|open objective|milestone|open work unit|event|artifact|match|alias|live entit(y|ie))e?s?$/.test(line));
}

/* ── stage 4: the terminal half of the document pair ───────────────── */

// Cell 13, restated for the shape stage 4 gives it: `self work` answers with
// one listing block that carries both renders, and the handler no longer asks
// which run it is in. What proves the block is one block is that the terminal
// bytes are the ruled list and the size line the same block would state under
// a pipe is absent — the gate chose, not the handler.
test("stage 4 cell 13: at a terminal, `self work` is the listing block's ruled render", async () =>
{
    await recordedUnit("the pages answer with blocks");
    const answer = await approvedIn(box, demo, ["work"], "");
    assert.equal(answer.code, 0, answer.out);
    const model = buildModel(join(ws, ".superself"), "demo", new Date());
    assert.equal(answer.printed, `${renderWorkList(model).join("\n")}\n`);
    assert.equal(sizeLines(answer.printed).length, 0, answer.printed);
});

test("stage 4 cell 4: at a terminal, `self context` is the ruled page and never the budgeted one", async () =>
{
    const answer = await approvedIn(box, demo, ["context"], "");
    assert.equal(answer.code, 0, answer.out);
    const model = buildModel(join(ws, ".superself"), "demo", new Date());
    assert.ok(answer.printed.startsWith(`${bold(model.slug)}\n`), answer.printed);
    assert.match(answer.printed, /[┌┬┐├┼┤└┴┘│─]/, "the terminal context drew no table");
    // The markdown page is what a pipe reads; a terminal never sees its
    // headings, and never pays for the budget that produced them.
    assert.ok(!answer.printed.includes("## Work in progress"), answer.printed);
});

test("stage 4 cell 5: at a terminal, `self context` from the workspace is the ruled project table", async () =>
{
    const answer = await approvedIn(box, ws, ["context"], "");
    assert.equal(answer.code, 0, answer.out);
    assert.match(answer.printed, /[┌┬┐├┼┤└┴┘│─]/, "the workspace context drew no table");
    assert.ok(answer.printed.includes(bold("demo")), answer.printed);
});

test("stage 4 cell 6: at a terminal, `self status` is the ruled page with its bands", async () =>
{
    const answer = await approvedIn(box, demo, ["status"], "");
    assert.equal(answer.code, 0, answer.out);
    assert.ok(answer.printed.includes(bold("WAITING ON YOU (0)")), answer.printed);
    assert.ok(answer.printed.includes(bold("ATTEMPTS ON THIS MACHINE (0)")), answer.printed);
    // The piped roll-up's own lines belong to the other render entirely.
    assert.ok(!answer.printed.includes("waiting on you: "), answer.printed);
});

// A page with one render reads the same either way, which is what declaring no
// terminal thunk says. `self setup` is the case that has to hold on a machine
// where there is nothing to read.
test("stage 4 cell 14: at a terminal, `self setup` prints the same diagnostics a pipe gets", async () =>
{
    const answer = await approvedIn(box, demo, ["setup"], "");
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.printed.split("\n")[0].replace(/\[[0-9;]*m/g, ""), "project    demo");
});

/* ── stage 5: the answers that run before any command resolves ─────── */

// The version is a scalar, and a scalar reads the same to a person as to a
// pipe. It reaches the gate before a leaf or a workspace exists, so what this
// cell holds is that neither turned out to be needed.
test("stage 5 cell 5: at a terminal, `self --version` prints the packaged version alone", async () =>
{
    const version = String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    const answer = await approvedIn(box, demo, ["--version"], "");
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.printed, `${version}\n`);
});

// The verb list dims its description column for a person and leaves a pipe the
// characters. Both renders are the same page composed the same way — what the
// terminal adds is paint, which is `style.ts`'s answer — so the cell is that
// stripping the paint gives back exactly the bytes a pipe reads.
test("stage 5 cell 6: at a terminal, the verb list is the piped list with its descriptions dimmed", async () =>
{
    const answer = await approvedIn(box, demo, [], "");
    assert.equal(answer.code, 0, answer.out);
    const plain = `${rootUsage(COMMANDS)}\n`;
    assert.notEqual(answer.printed, plain, "nothing was dimmed at a styled terminal");
    assert.equal(answer.printed.replace(/\x1b\[[0-9;]*m/g, ""), plain);
    assert.ok(answer.printed.includes(dim("show or set the workspace this machine uses")), answer.printed);
});

// The gate resolves the render once per run and hands it to the blocks that
// have two forms. A receipt's next command is the one stage 1 declares: weight
// is the terminal's signal for "this is runnable" (`pretty.ts`), and a run
// answered plainly gets the same characters without it.
test("the gate prints a receipt's next command under it, weighted only where the run is styled", () =>
{
    const said = [];
    const log = console.log;
    console.log = (...parts) => said.push(parts.join(" "));
    try
    {
        const block = { kind: "receipt", text: "recorded", next: "self work --project demo" };
        renderOutput([block], { plain: true });
        renderOutput([block], { pretty: true });
    }
    finally
    {
        console.log = log;
    }
    assert.deepEqual(said, [
        "recorded",
        "    self work --project demo",
        "recorded",
        `    ${bold("self work --project demo")}`
    ]);
});
