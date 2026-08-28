// The scenario every cell of docs/maintainers/case-tables/405-log-writer-note.md
// reads, and the suffix each cell expects.
//
// Not a test file — `node --test test/*.test.mjs` does not pick it up. It is
// the library the two halves of the table share, and there are two halves
// because `style.ts` answers "is this run styled" once, when it is first
// imported, from stdout: the terminal column has to be asked for above the
// imports, in a file of its own.
//
// The `by` payloads below are appended rather than produced by driving five
// verbs. What #405 changes is the render, so the input axis is a payload shape
// and is stated as one; that the verbs stamp exactly these shapes is #400's
// table — cells 1-3 and D4-D7 assert them as whole-payload equalities — and
// each half of this table still anchors one real verb end to end.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "../dist/ids.js";
import { demoWorkspace, git, logFixture, must } from "./harness.mjs";

// The columns: every shape `writerNote` branches on, and the exact suffix each
// one owes. A person has no session to name, an agent may have none to name,
// and a record written before #400 carries no `by` at all.
export const WRITERS = [
    { cell: 1, of: "a person, unnamed", by: { kind: "person" }, suffix: " · by person" },
    { cell: 2, of: "a person, named", by: { kind: "person", name: "rayim" }, suffix: " · by person rayim" },
    { cell: 3, of: "an agent with a session", by: { kind: "agent", session: "a1b2c3d4" }, suffix: " · by agent (session a1b2c3d4)" },
    { cell: 4, of: "an agent with no session", by: { kind: "agent" }, suffix: " · by agent" },
    { cell: 5, of: "nobody the record names", by: undefined, suffix: "" }
];

// The sixth record, in the other project this workspace registers. Its column
// number is 6 so `rowFor` finds it by the same lead every other row is found by.
export const MERGED = {
    cell: 6,
    of: "an agent in the other project",
    by: { kind: "agent", session: "b2c3d4e5" },
    suffix: " · by agent (session b2c3d4e5)"
};

// One record per column, each with a text no other row carries, so a cell
// finds its own row by what the event says rather than by where it sits.
export function textOf(writer)
{
    return `column ${writer.cell}: written by ${writer.of}`;
}

export function entityOf(writer)
{
    return `e-wn00${writer.cell}`;
}

// The workspace the table reads: one project holding five confirmed records,
// one per column, dated a day apart so the merged log's order is the table's
// order and never the tie-break on a shared millisecond. A second registered
// project holds one more, so the `--workspace` column is asked of a log that
// really merged two rather than of one project's rows wearing a slug.
export async function scenario(box)
{
    const { ws, demo } = await demoWorkspace(box);
    WRITERS.forEach((writer) => logFixture(ws, "demo", confirmation("demo", writer)));
    const second = await register(box, ws, "second");
    logFixture(ws, "second", confirmation("second", MERGED));
    return { ws, demo, second };
}

async function register(box, ws, slug)
{
    const dir = join(ws, slug);
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    await must(box, dir, ["project", "init", "--name", slug, "--desc", "the other project", "--no-connect"]);
    return dir;
}

// One already-formed event, hand-appended and folded in. `strip` is not run
// over it on purpose: an absent `by` is the pre-#400 shape, and writing
// `"by": undefined` instead would be a field the log never carried.
function confirmation(project, writer)
{
    return {
        id: ulid(),
        ts: `2026-01-0${writer.cell}T00:00:00.000Z`,
        type: "entity.confirmed",
        origin: { actor: "agent", confirmed: true },
        project,
        refs: {},
        payload: {
            entity: entityOf(writer),
            text: textOf(writer),
            labels: [],
            links: [],
            criteria: [],
            exposure: "search",
            scope: "project",
            ...(writer.by === undefined ? {} : { by: writer.by })
        }
    };
}

// The events one project's log holds, for a cell that needs the id of a write
// it just made. Read off the file rather than off the receipt: a styled process
// paints the receipt, and `idIn` reads the first `[…]` on the line — which
// there is the escape sequence.
export function eventsOf(ws, project)
{
    return readFileSync(join(ws, ".superself", "projects", project, "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
}

// A `by` of a shape the field never promised. Real history, not a hypothetical:
// before #400 folded it in, `runbook approve --by rayim` recorded `by` as a
// bare string, and a log written then is a log this CLI still reads.
export function malformedWriter(ws)
{
    return logFixture(ws, "demo", {
        id: ulid(),
        ts: "2026-01-09T00:00:00.000Z",
        type: "report.added",
        origin: { actor: "agent", confirmed: true },
        project: "demo",
        refs: {},
        payload: { text: "column 9: a `by` the field never promised", by: "rayim" }
    });
}

// The row that speaks about one column, out of whatever surface printed it.
// Styling wraps the row in escape sequences and truncates the summary, so the
// text a row is found by is the part of it no render shortens: the column
// number leads every one of them.
export function rowFor(printed, writer)
{
    const rows = printed.split("\n").filter((row) => row.includes(`column ${writer.cell}:`));
    if (rows.length !== 1)
    {
        throw new Error(`column ${writer.cell} matched ${rows.length} rows in:\n${printed}`);
    }
    return rows[0];
}

// What the plain render owes: the suffix, undimmed, and nothing after it.
// `dim` is the identity off a terminal, so a note that arrived wrapped in an
// escape sequence here would be a note the machine contract has to parse past.
export function assertsPlain(assert, row, writer)
{
    assert.equal(/\x1b\[/.test(row), false, `the plain row carries an escape sequence: ${JSON.stringify(row)}`);
    assertsSuffix(assert, row, writer.suffix);
}

// What the styled render owes: the same words, dimmed, closing the row. The
// note is the last thing on the line — after the id — so a reader scanning ids
// down the right of the summary column is not reading past a name to find one.
export function assertsStyled(assert, row, writer)
{
    assertsSuffix(assert, row, writer.suffix === "" ? "" : `\x1b[2m${writer.suffix}\x1b[0m`);
}

// The one shape both renders answer to. Silence is asserted as silence rather
// than as an empty suffix: every row ends with the empty string, so a column
// whose event names no writer has to be checked for saying nothing at all.
function assertsSuffix(assert, row, expected)
{
    if (expected === "")
    {
        assert.equal(row.includes(" · by "), false,
            `an event that names no writer had one invented for it: ${JSON.stringify(row)}`);
        return;
    }
    assert.equal(row.endsWith(expected), true,
        `the row does not end with ${JSON.stringify(expected)}: ${JSON.stringify(row)}`);
}
