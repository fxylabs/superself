# Case table — the fold stops reading legacy work events (#305)

The design artifact for #305, written before the code and reviewed on the
issue. Every cell below is one test, named by its cell number, asserting that
cell's stated outcome. The table is the review surface: a cell the table lacks
is a path nothing proves.

Where the tests live:

| Group | Cells | File |
|---|---|---|
| A, B, C, E, F, R | 37 | `apps/cli/test/legacy-work-fold.test.mjs` |
| D | 7 | `apps/cli/test/execution.test.mjs`, section B |
| G | 8 | `apps/cli/test/integrity.test.mjs` |

D1 to D5 are the five evidence-gate tests that were already there. They are
the regression net the removal had to leave passing, so they are cited rather
than rewritten; D6 and D7 are new. G3, G4 and G5 are asserted over the
pre-cutover store fixture that file already carries.

## The defect

One record kind is read two ways. Four of the six preset kinds — decision,
convention, objective, milestone — read their pre-cutover events as entities.
Work does not: it keeps the separate projection it had before the cutover,
beside the entity view.

Every defect found in the 2026-08-10 dogfooding session traces to that one
exception: a proposal folded from `work.proposed` is not an entity, so
answering it changed no record (#301); it is named by its event id, whose
first eight characters are the millisecond it was written in, so proposals
from one burst answered to one prefix (#304); and `self search` reads
`model.entities`, so such a proposal is invisible to it.

## The vocabulary

A **legacy unit** is a work unit whose creation event is `work.created`. A
**native unit** is one whose creation event is `entity.confirmed` or
`entity.proposed`. **The fold** is what turns the log into state. **`self log`**
is the history surface, which prints every event whatever its type.

The **process events** are `work.run-started` and `work.run-exited`. They share
the `work.` namespace with the legacy types and are the only two a current
binary writes, so they stay — moved to a reducer of their own.

## What the cutover does, and what it deliberately does not

| | |
|---|---|
| log files | not one line deleted or rewritten |
| conversion events | none written — a legacy unit is not revived as an entity |
| the fold | reads the two process events; every other `work.*` type folds to nothing |
| `self log` | prints every event whatever its type — unchanged |
| derived `work/*.md` of a dropped unit | removed by the fold's new sweep |
| migration script | none — there is nothing to run |
| what a user must do | nothing; the next fold is the new fold |
| a warning banner counting unfolded events | deliberately absent — the user can act on nothing, and counting them would half-undo the change |

The loss is real and was ruled acceptable by the maintainer on 2026-08-10: on
the maintainer's own store, 553 legacy units (121 of them open) leave the
model, and 2210 of 3085 work reports stop attaching to a unit. `self log` still
holds every one of those lines. A unit someone still wants is set up again with
`self work add`.

## Group A — the creation event × the fold

| Cell | Store state | Action | Expected |
|---|---|---|---|
| A1 | one `work.created` unit | `self work` | no units; "no open work", not an error |
| A2 | same | `self context` | folds, with no work section |
| A3 | one `entity.confirmed` unit | `self work` | one unit, as today |
| A4 | one of each | `self work` | the native one only |
| A5 | one `work.created` unit | `self work show <id>` | refused as an unknown id, pointing at search |
| A6 | a project whose work history is entirely `work.*` | `self context` | folds with no work, no exception |
| A7 | `entity.proposed` work proposal | `self work accept <id>` | becomes a unit, as today |

## Group B — legacy proposals × answering them

| Cell | Store state | Action | Expected |
|---|---|---|---|
| B1 | one `work.proposed` | `self context` | in no proposal list, in no waiting count |
| B2 | same | `self work accept <event-id>` | refused: no proposal matches |
| B3 | same | `self work decline <event-id> --why w` | refused the same way |
| B4 | `work.proposed` plus the `entity.confirmed` that answered it | `self work` | no unit — the #301 fix is gone with the exception |
| B5 | one `entity.proposed` | `self context` | one proposal under a short id, as today |
| B6 | two `work.proposed` in one millisecond | `self context` | neither is there, so #304's prefix clash cannot arise |
| B7 | one `work.proposed` | `self search <its text>` | no matches |

## Group C — legacy execution transitions × the fold

| Cell | Store state | Action | Expected |
|---|---|---|---|
| C1 | `work.created` + `work.started` | fold | no unit; both events ignored |
| C2 | `work.created` + `work.blocked` | `self context` | no blocked waiting row |
| C3 | `work.created` + `work.done` | `self status` | no done unit |
| C4 | `work.created` + `work.retired` | fold | no retired unit |
| C5 | `work.created` + `work.linked` | `self objective show` | contributes to no objective |
| C6 | native unit + `entity.started` | fold | in progress, as today |
| C7 | native unit + a `work.blocked` line merged from an old clone | fold | ignored; status unmoved; not an error |
| C8 | a live milestone linked by `work.linked` to legacy units only | `milestone show`, `milestone` | `- Work: none linked`, `[no work linked]`; the criteria and coverage lines do not move by one character |

## Group D — the done gate

| Cell | Store state | Action | Expected |
|---|---|---|---|
| D1 | native unit, no reports | `self work done <id>` | refused for no evidence, in today's exact words |
| D2 | native unit, prose reports only | `self work done <id>` | refused: a bare summary never satisfies |
| D3 | native unit, a report carrying a commit | `self work done <id>` | passes |
| D4 | native unit, a report carrying an artifact | `self work done <id>` | passes |
| D5 | native unit, no reports | `self work done <id> --report "…"` | passes |
| D6 | a `work.required` line in the log | `self work done <native unit>` | the criteria gate does not apply; D1–D5 are the whole rule |
| D7 | native unit with uncovered entity criteria | `self work done <id>` | passes — `cmdWorkDone` reaches the evidence gate alone. The entity criteria gate is `self state done`'s, which this issue does not touch and `execution.test.mjs`'s "B: uncovered criteria refuse done" keeps covering |

## Group E — reports and receipts that name a dropped unit

| Cell | Store state | Action | Expected |
|---|---|---|---|
| E1 | `report.added` naming a legacy unit | fold | attaches to nothing — what a report naming an unknown unit already does |
| E2 | same | `self log` | the report event still prints |
| E3 | `report.added` naming a native unit | `self work show <id>` | attached and shown, as today |
| E4 | `review.received` naming a legacy unit | fold | attaches to nothing, no exception |

## Group F — `self log`, the surface the dropped records stay readable on

| Cell | Store state | Action | Expected |
|---|---|---|---|
| F1 | one `work.created` | `self log` | prints as a human-readable row |
| F2 | `work.proposed`, `work.required`, `work.covered` | `self log` | all three print, none of them raw JSON |
| F3 | an evidence-free `work.done` on a native unit | `self log`, `work show` | the event prints; the unit does not fold to done |
| F4 | legacy and native mixed | `self log -n 500` | all of it, in timestamp order, kind making no difference |
| F5 | a legacy id | `state show --history`, `search` | refused as an unknown record / no matches — a refusal, never an exception |

## Group R — the process events, which are current and stay

| Cell | Store state | Action | Expected |
|---|---|---|---|
| R1 | native unit + `work.run-started` | `self work show <id>` | process reads running |
| R2 | native unit + `work.run-started` + `work.run-exited` (code 0) | `self work show <id>` | process reads exited (code 0) |
| R3 | legacy unit + `work.run-started` | fold | attaches to nothing, not an error |
| R4 | `work.run-exited` naming a unit nothing knows | fold | ignored, not an error |
| R5 | native unit last moved long ago, then a recent `work.run-started` | `self status` | not stalled — the reducer moves `lastEventTs` |
| R6 | native unit + a `work.run-started` carrying `refs.branch` | the unit's page | the branch is on the `- Branches:` line |

R is the only gate on the riskiest part of this change. The two process events
folded through the legacy reducer, which passed `lastEventTs` and `noteBranch`
before it reached the run handler. Promoting the run handler alone would have
dropped both silently — the types would still check, and the existing suites
would still pass.

## Group G — cutover and store integrity

| Cell | Store state | Action | Expected |
|---|---|---|---|
| G1 | before and after a fold | compare `log.jsonl` | identical; not one line moved |
| G2 | a dropped unit's `work/<id>.md` on disk | fold | the sweep removes it; no hand-edit notice, no error |
| G3 | the pre-cutover store | the nine captures that read no work | byte-identical |
| G4 | same | `self log -n 500` | byte-identical |
| G5 | same | `context`, `status`, `work`, two objective reads, two milestone reads | match the new baselines, and what they say about criteria and coverage does not move |
| G6 | a store holding legacy work only | fold twice | the same result both times; the second sweep has nothing to take |
| G7 | a dropped unit's `.hashes.json` entry | fold | the entry goes with the file — `drop()` takes both |
| G8 | a legacy unit id | `self handoff <id>`, `self work show <id>` | refused as an unknown id, in the words every other verb uses |

## What this issue does not touch

The entity work path, the entity criteria gate in `state.ts`, the log and
search render code that reads `work.*` type strings to produce text, the §8
reading of the other four legacy kinds, and any conversion, migration,
old-version detection or recovery tooling. Reads of the log stay; folds of the
log to state are what ended.
