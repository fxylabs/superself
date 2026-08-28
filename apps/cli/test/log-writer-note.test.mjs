// The piped half of docs/maintainers/case-tables/405-log-writer-note.md: what
// a run whose stdout is not a terminal prints at the end of each log row.
//
// #400 gave every undoable verb's event a `by` and rendered it on one surface —
// a record's own history page — leaving `self log` and its `--workspace` form
// to print the audit trail's rows without the audit. The three surfaces answer
// alike here or the trail is not one.
//
// The terminal half of every cell below is in log-writer-note-tty.test.mjs,
// which has to say `isTTY` above its imports and therefore cannot share a
// process with this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { machine, must, mustPerson } from "./harness.mjs";
import { MERGED, WRITERS, assertsPlain, entityOf, eventsOf, malformedWriter, rowFor, scenario, textOf } from "./log-writer-note-lib.mjs";

const box = machine();
const { ws, demo } = await scenario(box);

const projectLog = async () => (await must(box, demo, ["log", "-n", "500"])).out;
const workspaceLog = async () => (await must(box, ws, ["log", "--workspace", "-n", "500"])).out;
const history = async (writer) => (await must(box, demo, ["state", "show", entityOf(writer), "--history"])).out;

/* ── L. `self log`, piped ──────────────────────────────────────────── */

for (const writer of WRITERS)
{
    test(`LP${writer.cell}: piped, \`self log\` closes the row of an event written by ${writer.of}`, async () =>
    {
        assertsPlain(assert, rowFor(await projectLog(), writer), writer);
    });
}

/* ── W. `self log --workspace`, piped ──────────────────────────────── */

for (const writer of WRITERS)
{
    test(`WP${writer.cell}: piped, the workspace log closes the row of an event written by ${writer.of}`, async () =>
    {
        assertsPlain(assert, rowFor(await workspaceLog(), writer), writer);
    });
}

/* ── H. `<verb> show --history`, piped ─────────────────────────────── */

for (const writer of WRITERS)
{
    test(`HP${writer.cell}: piped, the history page closes the row of an event written by ${writer.of}`, async () =>
    {
        assertsPlain(assert, rowFor(await history(writer), writer), writer);
    });
}

// The merged log really merged: a row out of the other project keeps its note
// on the far side of a sort that interleaved two logs.
test("WP6: piped, a row from the other project keeps its note through the merge", async () =>
{
    assertsPlain(assert, rowFor(await workspaceLog(), MERGED), MERGED);
});

/* ── what holding all three to one row is for ──────────────────────── */

// The claim the three columns above make together, made once as itself: a
// reader who moves between the surfaces reads the same sentence about the same
// event, which is the whole of what #405 asks for.
test("XP1: piped, the three surfaces print one event's writer note identically", async () =>
{
    const writer = WRITERS.find((candidate) => candidate.cell === 3);
    const surfaces = [rowFor(await projectLog(), writer), rowFor(await workspaceLog(), writer), rowFor(await history(writer), writer)];
    const notes = surfaces.map((row) => row.slice(row.indexOf(" · by ")));
    assert.deepEqual(notes, [writer.suffix, writer.suffix, writer.suffix], surfaces.join("\n"));
});

/* ── the anchors: a real verb's stamp, and the window that must not move ── */

// The columns above are appended payloads, so one cell drives the verb: what a
// session records really does carry `{kind:"agent"}`, and the row really does
// say so. Its person-at-the-keyboard twin is cell AT1 in the terminal file,
// because a keyboard is the one thing that makes `writtenBy` answer "person".
test("AP1: piped, a record a session writes for real reads back as an agent's on `self log`", async () =>
{
    const said = "AP1: the record a session wrote";
    await must(box, demo, ["state", "add", said, "--exposure", "search"]);
    const row = (await projectLog()).split("\n").find((line) => line.includes(said));
    assert.notEqual(row, undefined, "the record never printed on the log");
    assert.equal(row.endsWith(" · by agent"), true, JSON.stringify(row));
});

test("AP2: piped, a record a person writes for real reads back as a person's on `self log`", async () =>
{
    const said = "AP2: the record a person wrote";
    await mustPerson(box, demo, ["state", "add", said, "--exposure", "search"]);
    const row = (await projectLog()).split("\n").find((line) => line.includes(said));
    assert.notEqual(row, undefined, "the record never printed on the log");
    assert.equal(row.endsWith(" · by person"), true, JSON.stringify(row));
});

/* ── the two marks on one row, and a `by` the field never promised ── */

// An undone event that also names its writer carries both marks, in one order:
// what the row no longer holds, then who wrote it. The mark is about the event
// and the note is about the writer, and reading "undone" first is what stops a
// reader attributing a withdrawn statement to whoever wrote it.
test("UP1: piped, an undone event carries the mark and then the note", async () =>
{
    const said = "UP1: the record that was taken back";
    await must(box, demo, ["state", "add", said, "--exposure", "search"]);
    const written = eventsOf(ws, "demo").at(-1);
    await must(box, demo, ["undo", written.id, "--why", "UP1 takes it back"]);
    const row = (await projectLog()).split("\n").find((line) => line.includes(said));
    assert.equal(row.endsWith(" · undone · by agent"), true, JSON.stringify(row));
});

// The log is a file other clones and older releases wrote. Before #400 folded
// it into an object, `runbook approve --by rayim` recorded `by` as a bare
// string — a shape `writerNote` does not read, and one it must not throw over.
test("MP1: piped, a `by` of a shape the field never promised prints no note", async () =>
{
    malformedWriter(ws);
    const row = (await projectLog()).split("\n").find((line) => line.includes("column 9:"));
    assert.notEqual(row, undefined, "the malformed row never printed");
    assert.equal(row.includes(" · by "), false, JSON.stringify(row));
});

// A note is a suffix, never a line. `-n` is the one listing that is a window by
// construction, and a window that started printing a second row per event would
// be answering a different question than the count beside it states.
test("NP1: piped, `self log -n 3` still prints three rows and one size line", async () =>
{
    const printed = (await must(box, demo, ["log", "-n", "3"])).out.trimEnd().split("\n");
    assert.equal(printed.length, 4, printed.join("\n"));
    assert.match(printed.at(-1), /^last 3 of \d+ events/);
    printed.slice(0, 3).forEach((row) => assert.match(row, /^\d{4}-\d{2}-\d{2}T/, row));
});

// The other half of the same guard: the note rides the row it belongs to, so
// no row carries two of them and no row carries another row's.
test("NP2: piped, every log row carries at most one writer note", async () =>
{
    const rows = (await projectLog()).trimEnd().split("\n").slice(0, -1);
    rows.forEach((row) => assert.equal(row.split(" · by ").length <= 2, true, `two writer notes on one row: ${row}`));
    assert.equal(rows.filter((row) => row.includes(textOf(WRITERS[0]))).length, 1);
});
