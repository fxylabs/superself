# Case table — the log says who wrote an event (#405)

Every cell below is one test, named by its cell id. The table is the review
surface: a cell the table lacks is a path nothing proves.

Where the cells live:

| Section | File |
|---|---|
| the piped half — `LP`, `WP`, `HP`, `XP`, `UP`, `MP`, `AP`, `NP` | `apps/cli/test/log-writer-note.test.mjs` |
| the terminal half — `LT`, `WT`, `HT`, `UT`, `MT`, `GT`, `AT` | `apps/cli/test/log-writer-note-tty.test.mjs` |
| the scenario and the expected suffixes both halves share | `apps/cli/test/log-writer-note-lib.mjs` |
| what a piped run prints, byte for byte | `apps/cli/test/fixtures/golden/piped.txt` |

Two files because `style.ts` answers "is this run styled" once, when it is first
imported, from stdout: a file that wants the terminal answer has to say so above
its imports, so the two halves cannot share a process.

## The defect

Since #400 every event an undoable verb writes carries `by` — a person at a
terminal, or an agent session. `<verb> show <id> --history` renders it;
`self log` and `self log --workspace` call `logLine` alone and print the audit
trail's rows without the audit. The one surface that lists events was the one
surface that would not say who wrote them.

## The ruling

`by` is the audit trail #400 introduced, and an audit trail absent from the
listing is not one. #400's reasoning — that `self log` is a machine contract
and owes no column every reader has to skip — is reversed here: the note is
what the log is *for* now that the verbs record consent rather than demand it,
and it is a suffix on a row rather than a column readers scan past.

The note is therefore appended inside `logLine`, where the row is built, rather
than by each of its three callers. A fourth surface that composed the row itself
would be free to drop it again, which is exactly how this defect happened.

`writerNote`'s silence is unchanged: an event carrying no `by` prints its line
and says nothing about a writer. Inventing "person" for a record written before
#400 would state something the log never said.

## The suffix, exactly

| `payload.by` | suffix |
|---|---|
| `{kind:"person"}` | `· by person` |
| `{kind:"person", name:"rayim"}` | `· by person rayim` |
| `{kind:"agent", session:"a1b2c3d4"}` | `· by agent (session a1b2c3d4)` |
| `{kind:"agent"}` | `· by agent` |
| absent, or any other shape | *(nothing)* |

Each suffix is preceded by ` · ` and closes the row, after the id and after the
`· undone` mark. Dimmed at a terminal, undimmed everywhere else — `dim` is the
identity when stdout is not a tty, so the piped bytes carry the words and no
escape sequence.

## The columns

The five `by` shapes above, numbered 1 to 5 in that order. They are appended
payloads rather than the output of five verbs: what #405 changes is the render,
so the input axis is a payload shape and is stated as one. That the verbs stamp
exactly these shapes is #400's table — cells 1–3 and D4–D7 assert them as
whole-payload equalities — and each half here still drives one real verb end to
end (`AP1`, `AP2`, `AT1`).

## The cells

### L / W / H — the three surfaces × the five columns × the two renders

`piped` is a run whose stdout is not a terminal, which is also what `NO_COLOR`
and `TERM=dumb` select; `terminal` is the styled render. The expected cell value
is the exact suffix from the table above, dimmed in the terminal column.

| # | Surface | Column | Render | Expected |
|---|---|---|---|---|
| LP1 | `self log` | 1 person, unnamed | piped | row ends ` · by person` |
| LP2 | `self log` | 2 person, named | piped | row ends ` · by person rayim` |
| LP3 | `self log` | 3 agent, session | piped | row ends ` · by agent (session a1b2c3d4)` |
| LP4 | `self log` | 4 agent, no session | piped | row ends ` · by agent` |
| LP5 | `self log` | 5 no `by` | piped | row says nothing about a writer |
| WP1–WP5 | `self log --workspace` | 1–5 | piped | the same five, after the slug column |
| HP1–HP5 | `state show <id> --history` | 1–5 | piped | the same five |
| LT1–LT5 | `self log` | 1–5 | terminal | the same five, wrapped in `\x1b[2m…\x1b[0m` |
| WT1–WT5 | `self log --workspace` | 1–5 | terminal | the same five, dimmed |
| HT1–HT5 | `state show <id> --history` | 1–5 | terminal | the same five, dimmed |

Every piped cell also asserts the row carries no escape sequence at all: a note
the machine contract has to parse past would be a note that was not plain.

The workspace this reads holds two registered projects, so `--workspace` is
asked of a log that really merged two rather than of one project's rows wearing
a slug. One more cell per render says so on the far side of the merge:

| # | Operation | Expected |
|---|---|---|
| WP6 | a row out of the second project, piped | ends ` · by agent (session b2c3d4e5)` |
| WT6 | the same at a terminal | the same, dimmed |

### U / M — the marks that share the row, and the shape the field never promised

| # | Operation | Expected |
|---|---|---|
| UP1 | an event with a `by`, then `self undo` of it, piped | the row ends ` · undone · by agent` — what the row no longer holds, then who wrote it |
| UT1 | the same at a terminal | ends with one dimmed ` · undone · by person`: the pair is one aside on the row, not two |
| MP1 | an event carrying `"by": "rayim"`, piped | no note, no throw |
| MT1 | the same at a terminal | no note, no throw |

`MP1`/`MT1` are real history rather than a hypothetical: before #400 folded it
into an object, `runbook approve --by rayim` recorded `by` as a bare string, and
a log written then is a log this CLI still reads. Silence is #400's rule for any
shape the field does not promise, and #405 keeps it — reading the string as a
name is a change to what `by` *is*, which is #400's to make, not this issue's.
Worth reopening if such logs turn out to be common.

### X — the three surfaces agree

| # | Operation | Expected |
|---|---|---|
| XP1 | one event read on all three surfaces | the note is byte-identical on each — the claim the three columns above make together, made once as itself |

### G — the geometry the note is charged for

A styled row is fitted to the terminal's width. The note is charged to the
summary's budget rather than added past it: a row that states its writer and
then wraps has spent two terminal lines saying one event.

| # | Operation | Expected |
|---|---|---|
| GT1 | column 1 and column 5 side by side, at 100 columns | both rows are exactly 100 cells; the noted row's summary is shorter by exactly the note's width |
| GT2 | column 3 — a 30-cell note — at 100 columns | the summary hits the 20-cell floor `logLine` has always had and the row overruns; the note is still whole and still last |

GT2 states a limit rather than hiding one. The floor is pre-existing: a row with
a long id and no note reached it the same way, and a truncated `· by agent
(sessio…` would be worse than an overrun — a reader needs the writer whole.

The plain render is unfitted, so no plain cell has a geometry to assert.

### A — the anchors: a real verb's stamp

| # | Caller | Operation | Expected |
|---|---|---|---|
| AP1 | a session | `state add "…"` piped, then `self log` | the row ends ` · by agent` — the verb really does stamp `{kind:"agent"}` and the row really does say so |
| AP2 | a person | `state add "…"` with a keyboard, then `self log` piped | the row ends ` · by person` |
| AT1 | a person | the same, with the log read at a terminal | the row ends with the dimmed ` · by person` |

`self log` piped with an agent's stamp is also anchored byte for byte in the
golden fixture, which prints `· by agent` on four rows of its `self log`
section.

### N — the window, unchanged

`self log -n N` is the one listing that is a window by construction. A note is
a suffix, never a line.

| # | Operation | Expected |
|---|---|---|
| NP1 | `self log -n 3` | three rows and one size line, exactly as before — the count beside the rows still describes them |
| NP2 | every row of a full log | at most one writer note per row; no row carries another row's |

## What this does not change

- The columns. `self log`'s plain form is still
  `[slug] ts type [id] summary [· undone]`, with the note appended after it.
- `writerNote` itself, beyond returning undimmed text for the row to dim: the
  width the note costs has to be measured before an escape sequence goes round
  it.
- The `· undone` mark, which still precedes the note and is still not charged to
  the summary's budget (cells UP1 and UT1 pin the order).
- `docs/releases/v0.11.0.md`, which is published. Its paragraph stating that
  `self log` does not carry the column describes 0.11.0 correctly and stays;
  the change belongs in the next release's notes.
