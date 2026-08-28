// The terminal half of docs/maintainers/case-tables/405-log-writer-note.md.
//
// `style.ts` answers "is this run styled" once, when it is first imported, from
// stdout — so a file that wants the styled answer says so before the built
// modules load and runs its commands in this process rather than in a child
// whose stdout is a pipe. That is why this half is a file of its own; the piped
// half of every cell here is in log-writer-note.test.mjs.
process.stdout.isTTY = true;
process.env.TERM = "xterm";
delete process.env.NO_COLOR;

import { test } from "node:test";
import assert from "node:assert/strict";

const { machine, must, mustPerson } = await import("./harness.mjs");
const { MERGED, WRITERS, assertsStyled, entityOf, eventsOf, malformedWriter, rowFor, scenario } = await import("./log-writer-note-lib.mjs");
const { styled } = await import("../dist/style.js");

const box = machine();
const { ws, demo } = await scenario(box);

const projectLog = async () => (await must(box, demo, ["log", "-n", "500"])).out;
const workspaceLog = async () => (await must(box, ws, ["log", "--workspace", "-n", "500"])).out;
const history = async (writer) => (await must(box, demo, ["state", "show", entityOf(writer), "--history"])).out;

test("this file loads with a styled stdout, or its cells assert nothing", () =>
{
    assert.equal(styled, true);
});

/* ── L. `self log`, at a terminal ──────────────────────────────────── */

for (const writer of WRITERS)
{
    test(`LT${writer.cell}: at a terminal, \`self log\` closes the row of an event written by ${writer.of}`, async () =>
    {
        assertsStyled(assert, rowFor(await projectLog(), writer), writer);
    });
}

/* ── W. `self log --workspace`, at a terminal ──────────────────────── */

for (const writer of WRITERS)
{
    test(`WT${writer.cell}: at a terminal, the workspace log closes the row of an event written by ${writer.of}`, async () =>
    {
        assertsStyled(assert, rowFor(await workspaceLog(), writer), writer);
    });
}

/* ── H. `<verb> show --history`, at a terminal ─────────────────────── */

for (const writer of WRITERS)
{
    test(`HT${writer.cell}: at a terminal, the history page closes the row of an event written by ${writer.of}`, async () =>
    {
        assertsStyled(assert, rowFor(await history(writer), writer), writer);
    });
}

// The merged log really merged: a row out of the other project keeps its note
// on the far side of a sort that interleaved two logs.
test("WT6: at a terminal, a row from the other project keeps its note through the merge", async () =>
{
    assertsStyled(assert, rowFor(await workspaceLog(), MERGED), MERGED);
});

/* ── the two marks on one row, and a `by` the field never promised ── */

// An undone event that also names its writer carries both marks, in one order:
// what the row no longer holds, then who wrote it. Dimmed once rather than
// twice — the pair is one aside on the row, not two.
test("UT1: at a terminal, an undone event carries the mark and then the note, dimmed once", async () =>
{
    await mustPerson(box, demo, ["state", "add", "UT1: the record that was taken back", "--exposure", "search"]);
    const written = eventsOf(ws, "demo").at(-1);
    await mustPerson(box, demo, ["undo", written.id, "--why", "UT1 takes it back"]);
    const row = (await projectLog()).split("\n").find((line) => line.includes("UT1:"));
    assert.equal(row.endsWith("\x1b[2m · undone · by person\x1b[0m"), true, JSON.stringify(row));
});

// The log is a file other clones and older releases wrote. Before #400 folded
// it into an object, `runbook approve --by rayim` recorded `by` as a bare
// string — a shape `writerNote` does not read, and one it must not throw over.
test("MT1: at a terminal, a `by` of a shape the field never promised prints no note", async () =>
{
    malformedWriter(ws);
    const row = (await projectLog()).split("\n").find((line) => line.includes("column 9:"));
    assert.notEqual(row, undefined, "the malformed row never printed");
    assert.equal(row.includes(" · by "), false, JSON.stringify(row));
});

/* ── the geometry the note is charged for ──────────────────────────── */

// A styled row is fitted to the terminal, and the note is charged to that
// budget rather than added past it: a row that states its writer and then wraps
// has spent two terminal lines saying one event, which is what the arithmetic
// in `logLine` exists to prevent. The plain form is unfitted and unaffected,
// which is cell LP1. A terminal that reports no width is 100 columns, and this
// process is one — that is the number both cells measure against.
test("GT1: at a terminal, the note is charged to the summary's budget, not added past it", async () =>
{
    const printed = await projectLog();
    const noted = bare(rowFor(printed, byCell(1)));
    const silent = bare(rowFor(printed, byCell(5)));
    assert.equal(noted.length, 100, JSON.stringify(noted));
    assert.equal(silent.length, 100, JSON.stringify(silent));
    assert.equal(summaryWidth(silent) - summaryWidth(noted), byCell(1).suffix.length,
        `the summary gave up ${summaryWidth(silent) - summaryWidth(noted)} cells for a ${byCell(1).suffix.length}-cell note`);
});

// The one case the charge cannot cover, stated rather than hidden: `logLine`
// has always floored the summary at 20 cells, so a row whose id and note
// together leave less than that overruns the width — exactly as a row with a
// long id and no note always did. The note is still whole and still last, which
// is what a reader needs from an overrun line.
test("GT2: at a terminal, a note wider than the budget's slack overruns rather than truncating", async () =>
{
    const row = bare(rowFor(await projectLog(), byCell(3)));
    assert.equal(summaryWidth(row), 20, `the summary floor was not reached, so this cell measures nothing: ${row}`);
    assert.equal(row.endsWith(byCell(3).suffix), true, JSON.stringify(row));
});

function byCell(cell)
{
    return WRITERS.find((writer) => writer.cell === cell);
}

function bare(row)
{
    return row.replace(/\x1b\[[0-9;]*m/g, "");
}

// The styled row is `ts(11) + 2 + type(18) + 2 + summary + 2 + [id] …`, and the
// id's bracket is the first one on the line.
function summaryWidth(row)
{
    return row.indexOf("  [") - 33;
}

/* ── the anchor: a real verb's stamp at a real keyboard ────────────── */

// The columns above are appended payloads, so one cell drives the verb. A
// keyboard is the one thing that makes `writtenBy` answer "person", and this
// process is the only place a test has one — its piped twin is cell AP1.
test("AT1: at a terminal, a record a person writes for real reads back as a person's on `self log`", async () =>
{
    await mustPerson(box, demo, ["state", "add", "AT1: the record a person wrote", "--exposure", "search"]);
    const row = (await projectLog()).split("\n").find((line) => line.includes("AT1:"));
    assert.notEqual(row, undefined, "the record never printed on the log");
    assert.equal(row.endsWith("\x1b[2m · by person\x1b[0m"), true, JSON.stringify(row));
});
