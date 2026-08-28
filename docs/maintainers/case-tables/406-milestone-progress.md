# Case table — `self milestone show` reads progress across its linked work units (#406)

The design artifact for #406, written before the code. Every cell below is one
test, named by its cell number. The table is the review surface: a cell the
table lacks is a path nothing proves. There is no review round on this change,
so a variable missing from the table is a variable nothing covers.

Where each section's cells live:

| Section | File |
|---|---|
| A–F | `apps/cli/test/milestone-progress.test.mjs` |
| G (help text, the piped bytes) | `apps/cli/test/fixtures/golden/piped.txt` via `test/golden.test.mjs` |

Scope is narrowed by decision `01m13k3x0r6k48zbv8t67t092e`: CLI text output
only. `view.ts` and `views.ts` are not touched, and `self context` does not
move.

## The gap

`self milestone show` prints the exit criteria, the coverage claims, and one
line naming the linked unit ids. To find out where any of those units actually
stands, a reader runs `self work show` once per id. The one screen that should
answer "where are we" answers "here are five ids".

## What is added

One section, after `## Exit criteria` and before `## Coverage`, on
`self milestone show` alone:

```
## Linked work

- **w-abc12** ship the render gate — blocked on decision: nobody ruled, 1 of 2 criteria covered, held by this session
  - report 2026-08-28: the gate refuses a bare claim
- **w-def34** write the reference page — next
```

Entry shape, in order, parts joined by `, ` after a leading ` — `:

1. **standing** — always present. `work.status` verbatim (`next`, `active`,
   `review`, `done`, `retired`, `undone`); for a blocked unit,
   `blocked on <what>` and `: <why>` when `work block --why` recorded one.
2. **criteria** — `k of n criteria covered`, only when the unit's record
   declares criteria.
3. **holder** — `ledger.ts` `claimNote`'s sentence, only when a session holds
   it.

Then, indented under the entry, `  - report <date>: <first line>` when the unit
has at least one report.

Units are listed in `milestone.works` order — the fold's own unit order, so the
unit recorded first leads whatever order the links were stated in.

## What is reused, and what is deliberately not recomputed

| The answer | Read from | Not |
|---|---|---|
| which units are linked, in order | `MilestoneState.works`, derived by `objectives.ts` `deriveMilestone` | a second `model.works.filter(… .milestones.includes(id))` |
| working state and the block reason | `WorkState.status` / `blockedOn` / `blockedWhy` — the fields `fold.ts` `workStandingLines` prints on `self work show` | a fresh reading of the execution events |
| criteria coverage | `entities.ts` `uncoveredCriteria`, the function `self state done`'s gate is refused by | counting `entity.covered` here |
| who holds it | `ledger.ts` `claimNote(work.claim, sessionToken(), work.process)`, exactly as `main.ts`, `pretty.ts` and `views.ts` call it | a fourth spelling of the liveness judgment |
| the latest report | `model.ts` `reportProjection(work.reports)[0]` | sorting reports again |
| the first line of it | `style.ts` `firstLine`, lifted out of `pretty.ts` so it is one function | a third local copy |

## Why the lines are composed in `goals.ts` and passed into `fold.ts`

`renderMilestoneBody` also writes the canonical milestone section inside the
folded `objective/<id>.md`, and a folded file syncs to every clone. The holder
sentence is this machine's judgment of another machine's session — the same
reason `main.ts` composes `self work show`'s holder line outside
`renderWorkBody`. So the section arrives as a `progress: string[] = []`
parameter that only the console show passes, mirroring `renderObjectiveBody`'s
`linked` parameter, and the fold passes nothing.

The change is otherwise purely additive: no existing line of the milestone body
moves, so `objective show`, the folded pages and every existing assertion about
them stay byte-identical.

## A deviation from the issue's wording, stated

The issue spells the working states "open / started / blocked / done /
retired". The CLI's own vocabulary for them is `next` / `active` / `blocked` /
`done` / `retired`, which is what `self work show` prints as `- Status:` and
what `self work` lists. This render uses the CLI's vocabulary: a milestone page
that renamed the states would be a second spelling of one answer, and the
reader who follows an id from here to `self work show` would find a different
word for the state they just read. `search.ts` already renders `next` as "open"
in its own listing; that spelling is not spread further here.

## The cells

### A. The section itself

| # | State | Operation | Expected |
|---|---|---|---|
| A1 | a milestone with no linked units | `milestone show` | no `## Linked work` heading at all; `- Work: none linked` unchanged |
| A2 | two units, the earlier-recorded one linked **second** | `milestone show` | the section is present, one entry per unit, in record order rather than link order, placed after `## Exit criteria` and before `## Coverage` |
| A3 | the same milestone, one unit started so a holder exists | `objective show` on its objective | the embedded milestone section carries **no** `## Linked work` and **no** holder sentence — the folded page is unchanged |
| A4 | the same milestone | the folded `objective/<id>.md` on disk | same as A3: no `## Linked work` |

### B. Working state

One unit per cell, each linked to the milestone.

| # | State | Expected entry tail |
|---|---|---|
| B1 | never started | `— next` |
| B2 | `work start` | `— active` |
| B3 | `work block --on decision --why "nobody ruled"` | `— blocked on decision: nobody ruled` |
| B4 | `work block --on external` with no `--why` | `— blocked on external`, no trailing colon |
| B5 | `work done` | `— done` |
| B6 | `work retire --why …` | `— retired` |
| B7 | `work propose` linked with `--milestone`, never confirmed | `— review` |

### C. Criteria declared × covered

The unit is `state add "…" --label work --criteria …`, which is the entity
grammar `work add` is sugar over; `state cover` records each claim.

| # | Declared | Covered | Expected |
|---|---|---|---|
| C1 | 0 | 0 | no criteria clause on the entry at all |
| C2 | 2 | 0 | `0 of 2 criteria covered` |
| C3 | 2 | 1 | `1 of 2 criteria covered` |
| C4 | 2 | 2 | `2 of 2 criteria covered` |

### D. Reports

| # | State | Expected |
|---|---|---|
| D1 | no report | no `  - report …` line under the entry |
| D2 | one report | `  - report <date>: <text>` |
| D3 | two reports | the newer one only; the older text does not appear |
| D4 | a report whose text has three lines | the first line only; lines two and three do not appear |

### E. Holder

| # | State | Expected |
|---|---|---|
| E1 | never started | no holder clause |
| E2 | started by the session running `milestone show` | `held by this session` |
| E3 | started by another session whose pid this machine has reaped | `was held by another session, ended <date> <time>` |

### F. Composition

| # | State | Expected |
|---|---|---|
| F1 | one unit that is blocked with a reason, declares 2 criteria with 1 covered, has a report, and is held by this session | one entry reading `— blocked on decision: nobody ruled, 1 of 2 criteria covered, held by this session`, and the report line beneath it — the three clauses in that order, joined by `, ` |

### Considered, and not a cell

`WorkState` has a seventh status, `undone`, and it cannot reach this section:
`self undo` refuses to take back a unit's creation while a link to it still
stands, so undoing the creation means undoing the `entity.linked` first, and an
unlinked unit is not in `milestone.works`. `self work show <id>` remains the
surface that answers for an undone id, which is what it exists for.

`work block` requires `--on`, so there is no blocked unit with no dependency
named; B4 is the only shape with no reason.

### G. What a reader is told the command does

| # | Surface | Expected |
|---|---|---|
| G1 | `self milestone --help` and the `self help` page | `milestone show` is described as printing the exit criteria, the linked work units, and the coverage |
| G2 | `docs/reference/cli.md` | the `milestone` bullet says `milestone show` reads the linked units' state, coverage and latest report |
| G3 | `test/fixtures/golden/piped.txt` | regenerated; the diff is the help line and the new section on the scenario's milestone, and nothing else |
