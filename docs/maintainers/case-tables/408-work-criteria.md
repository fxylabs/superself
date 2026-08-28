# Case table — a work unit declares ordered criteria (#408)

The design artifact for #408, written before the code and approved on the
issue. Every cell below is one test, named by its cell number. The table is the
review surface: a cell the table lacks is a path nothing proves.

Where each section's cells are expected to live:

| Section | File |
|---|---|
| A, B (declaring), L (help, contract, docs) | `apps/cli/test/work-criteria.test.mjs` |
| C, D, E (cover, block, done) | `apps/cli/test/work-criteria-gate.test.mjs` |
| F, G (lifecycle, undo) | `apps/cli/test/work-criteria-lifecycle.test.mjs` |
| H, K (fold, merge, mixed version) | `apps/cli/test/entities.test.mjs`, `apps/cli/test/cutover.test.mjs` |
| I (renders) | `apps/cli/test/work-criteria-render.test.mjs`, `apps/cli/test/context.test.mjs`, `apps/cli/test/golden.test.mjs` |
| J (attribution) | `apps/cli/test/work-criteria.test.mjs` |
| the shipped coverage grammar this builds on | `apps/cli/test/cover.test.mjs` cells C1–C5, unchanged |

## The gap

`self` records a work unit's outcome, its reports and its evidence. It records
nothing about what the unit had to satisfy to be called done. #404 reports the
consequence directly: an orchestrating session held that state in a markdown
checklist beside the store, with a status mark and a verification column per
step, and none of it was visible from `self work show`.

The vocabulary the CLI needs already exists and is one layer down. `state add
--criteria` declares a record's completion conditions, `state cover` judges one
covered with a reason and optional evidence, and `state done` refuses while any
of them is uncovered (#207 C). A work unit is an entity, so it can carry the
same list — but `work add` writes `criteria: []` into every unit's creation
payload (`main.ts` `workPayload`, `goals.ts` `proposedPayload`), and `work
done` never reaches the criteria gate, because that gate lives on the `state
done` path (`state.ts` `requireCriteriaCovered`) and `completion.ts` explicitly
left it there at the #305 cutover.

So the whole of proposal 1 of #404 is: let a work unit fill the list it already
has a field for, let a criterion carry the method that checks it and say when
it is stuck, and make `work done` read the gate that already exists.

## The rule, in one sentence

**A work unit's criteria are its declared completion conditions, addressed
`c1..cN` in the order they were declared, and a unit that declares any is not
done until every one carries a coverage claim.** Nothing removes a criterion:
a mistaken one is undone, and one no longer needed is covered with a reason
and no evidence.

## What is not a new grammar

Almost all of it. Declared criteria are `payload.criteria` on the creation
event, folded by `entities.ts` `newEntity` today. A coverage claim is
`entity.covered`, written by the one writer `state.ts` `recordCoverage`, which
`state cover`, `milestone met` and `milestone recheck` already share. Addressing
a criterion as `cN` or by its text is `state.ts` `resolveCriterion`, whose
refusal already lists every declaration. `self undo` already takes back an
`entity.covered` and already has the receipt line for it. The done gate is
already spelled once.

Three things are genuinely new: a criterion declared *after* the record was
created, a verification text per criterion, and a criterion that waits on
something while the unit around it keeps moving.

## The criterion axis, and why it gets its own event types

The brief asked for `entity.blocked` with a `criterion` field in preference to
a new type. **The design departs from that**, and this is the justification.

`entity.blocked` and `entity.unblocked` are in `entities.ts`
`EXECUTION_EVENTS`, and `collectExecution` routes them into `nextExecution`,
which sets the **unit's** working state. A 0.11.0 CLI has no `criterion` branch
there and never will. Reading a store written here it would therefore fold
`entity.blocked {entity, criterion: "c3", on: "external"}` into *the unit is
blocked on external*, list it as blocked, and — worse in the other direction —
fold `entity.unblocked {criterion: "c3"}` into *the unit is no longer blocked*,
silently clearing a real unit-level block that a person recorded. That is not a
forward-compatibility wrinkle, it is one CLI reading a different history than
the other from the same bytes.

An unknown `entity.*` type costs nothing by comparison. `applyEntity` falls
through to `reconcileEntity`, whose `COLLECTORS.find(...)?.[1](fold, event)`
returns `undefined` and applies nothing. The older CLI reads the criterion as
open and never refuses a done it should have allowed — the same silent,
one-directional loss `payload.by` and `payload.supersedes` already take across
versions (#389, #400).

So: **the verb is shared, because the act is the same; the event type is not,
because the fold's answer is different.** A person types `self work block <id>
--criterion c3 --on external --why w` — one blocking verb, one `--on` enum, the
scope named by a flag — and the writer emits a criterion-axis event.

Three types, one family, all ignored by every shipped fold pass:

```jsonc
"entity.criterion-declared"  { "entity": "w-…", "criterion": "<text>", "verify": "<how>", "by": {…} }
"entity.criterion-blocked"   { "entity": "w-…", "criterion": "<text>", "on": "decision|dependency|external", "why": "<w>", "by": {…} }
"entity.criterion-unblocked" { "entity": "w-…", "criterion": "<text>", "by": {…} }
```

`criterion` is the criterion's **text**, never `cN` — exactly as
`entity.covered` already stores it. `cN` is a read-time position computed from
the declared list and is never written to the log, which is what makes an undo
of a mid-list declaration renumber the addressing without detaching a single
claim (cell G4). The hyphenated names follow `work.run-started` /
`work.run-exited`, the shipped precedent for a sub-noun in an event type.

The fourth new thing, `--verify` at declaration time, rides the creation event
as a sparse map keyed by the position it is declared at:

```jsonc
"criteria": ["the fixture regenerates clean", "the release note names the flag"],
"verify":   { "c1": "`npm test -w apps/cli` passes" }
```

Sparse and keyed rather than a parallel array, because most criteria carry no
verification text and an array of holes is a shape every reader has to defend
against. On `entity.criterion-declared` the same fact is a bare `verify` string,
because that event declares exactly one criterion and has nothing to key by.
Both are ignored by `newEntity` and by `reconcileEntity` on an older CLI.

Coverage stays `entity.covered`, byte-identical whether `state cover`,
`work cover` or `milestone met` wrote it — with one addition: it gains
`by: writtenBy()`, which it does not carry today, so the criterion axis says
who wrote each of its facts the way every other verb has since #400.

## The state machine

Per criterion, folded from its own ordered event stream:

- **open** — declared, nothing since. `block` → blocked. `cover` → covered.
- **blocked** — the newest fact is a block. `unblock` → open. `cover` → covered.
- **covered** — a claim names it. Terminal: `state cover`'s shipped "already
  covered" refusal is what makes it terminal, and `block` on it is refused.

Two rulings fall out, and both are deliberate:

1. **Covering a blocked criterion is allowed, and the cover ends the block.**
   The precedent is ruling ① of #205, which the `work` help still states: done
   is allowed while blocked, because *completion is a judgment on the outcome,
   not on the block*. A coverage claim is that same judgment one level down.
   The block is ended by the claim rather than by a second event, the way
   `nextExecution` already reads order on the unit's own axis — no implicit
   write, just the newest fact winning.
2. **"Uncovered or blocked" is one condition, not two.** Blocking never
   covers, so a blocked criterion is an uncovered one. The done gate asks one
   question — is every criterion covered — and the block changes only what the
   refusal *says* and what `self work` and `self context` render.

**A blocked criterion never changes the unit's own status.** It adds no waiting
row to `self context` and does not make `self work` call the unit blocked.
Otherwise one unit would read active and blocked at once, and `views.ts`
already states the rule the other way round for runbook approvals: widening the
block axis into the waiting render changes units this issue never touched.

## The fold

`entities.ts` gains one shape and one field:

```ts
interface CriterionState
{
    id: string;              // c1..cN — its 1-based place, computed here
    text: string;
    verify?: string;
    // The claim that covered it. Absent while open or blocked.
    covered?: CoverageClaim;
    // What it waits on, when the newest fact about it is a block.
    blocked?: { on: string; why?: string; ts: string };
}
```

`EntityState.criterionStates: CriterionState[]` is built in one pass — the
creation payload's list first, then every `entity.criterion-declared` in
`(ts, event id)` order, then the block/unblock/cover events replayed over them
in the same order. `EntityState.criteria: string[]` becomes
`criterionStates.map((item) => item.text)`, derived at the end of that pass, so
`uncoveredCriteria`, `resolveCriterion`, `state show`, the milestone exit
projection (`model.ts`, `entity.criteria` → `milestone.exit`) and every runbook
stage reader are untouched by construction rather than by care.
`EntityState.covered: CoverageClaim[]` is unchanged: every judgment stays on
record, in landing order, and `criterionStates[i].covered` points at the newest
live one.

`WorkState` gains `criteria: CriterionState[]`, empty on a unit that declares
none. `entities.ts` exports one render helper beside `uncoveredCriteria`:

```ts
export function criteriaProgress(states: CriterionState[]): string | undefined
// undefined when the list is empty; otherwise "2 of 5 criteria covered",
// or "2 of 5 criteria covered (1 blocked)" when any is blocked.
```

One sentence, four surfaces — `work show`, `self work`, `self context` and
#406's `milestone show` — so no two of them can disagree about the same unit.

## The done gate

`completion.ts` `Completable` grows `criteria: CriterionState[]`, and the
criteria half of the gate comes back to the module whose header comment records
that #305 sent it away. `model.ts` already sets `work.owes =
completionRefusal(work)`, so `work show`'s *Not done yet* line, #406's
milestone row and `work done`'s refusal are one answer with no second reader.

The criteria clause is judged **before** the evidence clause: a criterion names
its own next action and often carries the `--verify` text that says how, while
the evidence floor sends the reader to a report they may not owe yet.

The refusal, when three of five are covered and one of the rest is blocked:

```
w-abc12 declares 5 criteria and 2 are not covered:
    c3  blocked on external — the vendor has not confirmed the quota
    c4  open — the release note names the flag
  cover each with `self work cover w-abc12 --criterion c4 --why "<how>"` — a
  covered criterion's block ends with it — or retire the unit if the outcome
  was given up
```

`state done` keeps its own spelling of the same gate (`self state cover …`);
the verb family is a parameter of the one function, so a work unit is never
handed a `state` line and a raw entity is never handed a `work` one.

## The verbs

```
work add "<outcome>"   [--criteria "<text>" …] [--verify "cN <how it is checked>" …]
work propose "<plan>"  [--criteria "<text>" …] [--verify "cN <how it is checked>" …]
work criteria add <id> "<text>" [--verify "<how it is checked>"]
work block   <id> [--criterion cN] --on decision|dependency|external [--why w]
work unblock <id> [--criterion cN]
work cover   <id> --criterion cN --why "<how it is covered>" [--evidence <commit>] [--work <id>]
```

`--verify` at declaration time names the criterion it verifies, because one
call declares several and nothing else in the flag says which. On `work
criteria add` it is bare, because that call declares exactly one and there is
nothing to disambiguate.

`work cover` is an alias in the strict sense: same handler, same
`recordCoverage`, byte-identical `entity.covered`. `state cover <work-id>`
keeps working and is not deprecated — the alias exists so a session working a
unit never has to leave the `work` family to say what it finished.

`work criteria` is a branch with one leaf today (`add`). Block and unblock are
*not* under it: blocking is one act with one `--on` enum, and a second spelling
of it under a second noun is how two gates that must agree stop agreeing.

## The runbook boundary

Stated in `self help work`, in `self work --help`'s option list, and in
`docs/reference/cli.md`:

> A runbook is a procedure this project repeats — registered once, run per
> piece of work, with the same stages every run. A work unit's criteria are
> that one unit's completion conditions: declared on it, judged on it, never
> run again. If you would declare the same list on the next unit too, it is a
> runbook.

This is not decoration. `runbook.ts` composes a runbook run out of the very
same field: a run is an entity whose stages *are* its `criteria`, and passing
one is an `entity.covered` through the same writer. Appending a criterion to a
run would drift `stageDigest(run.criteria)` from the edition it follows, so the
shared writer refuses a `runbook` or `runbook-run` labelled record by name
(cells B7, B8) — the guard lives in the writer rather than in `work criteria
add`'s id check, so a later `state criteria add` cannot slip past it.

---

## The cells

Callers, used as column values throughout, in #400's spelling:

- **P** — a person at their own keyboard: no attempt marker, stdin is a tty.
- **R** — an agent session: `SUPERSELF_SESSION` set.

`U` is a confirmed, started work unit declaring three criteria unless a cell
says otherwise.

### A. Declaring at birth — `work add` and `work propose`

| # | State | Operation | Expected |
|---|---|---|---|
| 1 | — | `work add "x" --criteria "a" --criteria "b"` | one `entity.confirmed` whose `payload.criteria` is `["a","b"]`, in the order declared; receipt is the work id, unchanged |
| 2 | — | `work add "x"` with no `--criteria` | `payload.criteria` is `[]` — byte-identical to what `workPayload` writes today; every render is unchanged |
| 3 | — | `work add "x" --criteria "a" --criteria "b" --verify "c2 the release note names the flag"` | `payload.verify` is `{"c2": "the release note names the flag"}`; c1 carries none |
| 4 | — | `work add "x" --verify "c1 how"` with no `--criteria` | refused: `work add --verify states how one declared criterion is checked — pass --criteria "<text>" too` |
| 5 | — | `work add "x" --criteria "a" --verify "the fixture regenerates"` | refused: `work add --verify must begin with the criterion it verifies — "c1 <how it is checked>"; this call declares c1` |
| 6 | — | `work add "x" --criteria "a" --verify "c4 how"` | refused: `work add --verify names c4, and this call declares c1` |
| 7 | — | `work add "x" --criteria "a" --criteria "b" --verify "c1 one" --verify "c1 two"` | refused: `work add --verify names c1 twice — one criterion states one verification method` |
| 8 | — | `work add "x" --criteria ""` | refused by the shipped `validText` refusal for `--criteria`, naming "one criterion's text" — the same one `state add --criteria` gives |
| 9 | — | `work add "x" --criteria "a" --criteria "a"` | refused: `work add --criteria declares "a" twice — a criterion is judged once, and two with one text could never be told apart` |
| 10 | R | `work propose "p" --criteria "a" --criteria "b"` | one `entity.proposed` carrying the list; `proposedPayload`'s hard-coded `criteria: []` is replaced by the declared list, and everything else in the payload is unchanged |
| 11 | R | `work propose "p" --criteria "a" --supersedes <t> --why w` | the criteria and `payload.supersedes` ride the same proposal; the receipt is #389's unchanged two-line one |
| 12 | R | `work propose "p" --criteria "a"` where an open plan already proposes "p" with different criteria | refused by `requireNovel`, unchanged — two plans are the same plan by their outcome text, and criteria do not make one novel |

### B. Declaring later — `work criteria add`

| # | State | Operation | Expected |
|---|---|---|---|
| 13 | U (3 criteria) | `work criteria add <U> "d"` | one `entity.criterion-declared {entity, criterion: "d", by}`; the unit declares four, and the new one is **c4** — appended, never inserted |
| 14 | U declaring none | `work criteria add <U> "a"` | records; the unit now declares one, and `work done` is gated on it from this moment. The receipt states both: `w-abc12 c1 "a" — done now waits on it` |
| 15 | U | `work criteria add <U> "d" --verify "the quota page shows 10k"` | records with the bare `verify` string; `work show` prints it under c4 |
| 16 | a plan still in review | `work criteria add <plan> "a"` | **records** — a plan under review is still being shaped, and declaring is not a claim about doing. `work cover` on the same plan stays refused (cell 24) |
| 17 | U already declaring "d" | `work criteria add <U> "d"` | refused: `w-abc12 already declares c4 "d" — a criterion is judged once, and two with one text could never be told apart` |
| 18 | U, done | `work criteria add <U> "d"` | refused: `w-abc12 is done — a criterion states what completion required, and this outcome is already judged` |
| 19 | U, retired | `work criteria add <U> "d"` | refused: `w-abc12 was retired — declare it on the successor, whose criteria start uncovered` |
| 20 | a `runbook` definition id | `work criteria add <r> "d"` | refused by `wrongKindHint` as not a work id; the shared writer's own refusal (cell 21) is what a later `state`-side spelling would hit |
| 21 | a `runbook-run` entity, reached through the shared writer | declare a criterion | refused: `r-abc12 is a runbook run — its stages come from the procedure it follows, and a stage is added by revising the runbook (\`self runbook revise <id> --stage "<text>" --why w\`)`; `stageDigest` is unchanged by the refused call |
| 22 | U undone (#390) | `work criteria add <U> "d"` | refused: the unit's own creation was taken back, in `handoff`'s words — there is nothing to declare a criterion on |

### C. Covering — `work cover` and `state cover`

| # | State | Operation | Expected |
|---|---|---|---|
| 23 | U, c2 open | `work cover <U> --criterion c2 --why "the fixture regenerates clean" --evidence <commit>` | one `entity.covered {entity, criterion: "<c2's text>", why, by}` with `refs.commits`; **byte-identical** to what `state cover` writes for the same call, plus the `by` both now carry |
| 24 | a plan still in review | `work cover <plan> --criterion c1 --why w` | refused by the shipped `requireCoverable`: `… is still proposed — coverage lands on a record that holds; confirm it first` |
| 25 | U, c2 open | `work cover <U> --criterion c2 --why "no longer needed: the API was withdrawn"` | records with no evidence and no `--work` — the issue's "one no longer needed is covered with a reason". `work show` renders it *covered — reason only* |
| 26 | U, c2 covered | `work cover <U> --criterion c2 --why w` | refused by the shipped already-covered refusal, unchanged: a criterion is judged once per record |
| 27 | U (3 criteria) | `work cover <U> --criterion c9 --why w` | refused by the shipped `resolveCriterion`, which lists every declaration as `c1 "…"; c2 "…"; c3 "…"` |
| 28 | U | `work cover <U> --criterion "the fixture regenerates clean" --why w` | records — addressing by text is the shipped spelling and stays; the event carries the same text either way |
| 29 | U, c3 **blocked** on external | `work cover <U> --criterion c3 --why "the vendor confirmed by mail"` | **records**, and c3 folds to covered with no block — the claim is the newer fact. No second event is written |
| 30 | U | `state cover <U> --criterion c2 --why w` | records the same event as cell 23; the raw verb is not deprecated and still answers for a work id |
| 31 | U, `--work <other>` naming a unit the log knows | `work cover <U> --criterion c2 --why w --work <other>` | records with `refs.work`, unchanged from `state cover`'s shipped behaviour |

### D. Blocking one criterion

| # | State | Operation | Expected |
|---|---|---|---|
| 32 | U, c3 open, unit active | `work block <U> --criterion c3 --on external --why "the vendor has not confirmed the quota"` | one `entity.criterion-blocked`; **the unit's own status is still active** — `self work` shows `active`, not `blocked`, and no `entity.blocked` is written |
| 33 | U, unit active | `work block <U> --on external --why w` (no `--criterion`) | unchanged: the shipped `entity.blocked`, the unit is blocked, `transitionWork`'s enum refusal is untouched |
| 34 | U, c3 blocked | `work unblock <U> --criterion c3` | one `entity.criterion-unblocked`; c3 reads open again |
| 35 | U, c3 blocked, unit **also** blocked on decision | `work unblock <U>` (no `--criterion`) | the unit unblocks; **c3 stays blocked** — the two axes never move each other |
| 36 | U, c3 open | `work unblock <U> --criterion c3` | refused: `w-abc12 c3 is not blocked — there is nothing to release` (the criterion-scoped spelling of the shipped `notBlocked`) |
| 37 | U, c3 blocked on external | `work block <U> --criterion c3 --on dependency --why w` | refused: `w-abc12 c3 is already blocked on external — the vendor has not confirmed the quota` |
| 38 | U, c2 covered | `work block <U> --criterion c2 --on external --why w` | refused: `w-abc12 c2 is already covered — a covered criterion waits on nothing` |
| 39 | U | `work block <U> --criterion c3 --on paperwork --why w` | refused by the shipped `--on` enum refusal, in its own words, before the criterion is resolved |
| 40 | U | `work block <U> --criterion c9 --on external --why w` | refused by `resolveCriterion`, listing every declaration — the same refusal `cover` gives |
| 41 | a plan still in review | `work block <plan> --criterion c1 --on external --why w` | refused: a plan nobody confirmed has no working state to move, naming `self work confirm <id>` — the shipped `executionTarget` rule, one level down |

### E. Done, and what it names

| # | State | Operation | Expected |
|---|---|---|---|
| 42 | U, all three covered, a report with a commit | `work done <U>` | records `entity.done` — unchanged from today for a unit that satisfies both halves |
| 43 | U declaring none | `work done <U> --report "…"` | records; **the shipped path is byte-for-byte unchanged** for every unit that declares nothing, which is every unit in every store written before this issue |
| 44 | U, c2 open, evidence present | `work done <U>` | refused, naming c2 by id and by text, and the `self work cover` line that covers it. Nothing appended |
| 45 | U, c3 blocked, others covered | `work done <U>` | refused, naming c3 as `blocked on external — <why>`, with the same cover line and the sentence that a covered criterion's block ends with it |
| 46 | U, c3 blocked **and** c4 open | `work done <U>` | one refusal listing both in cN order, blocked rows carrying their `--on` and `--why` |
| 47 | U, one criterion open **and** no evidence at all | `work done <U>` | refused for the **criterion** — the criteria clause is judged first; the evidence refusal is what the next call gets once it is covered |
| 48 | U, all covered, no evidence | `work done <U>` | refused by the shipped evidence gate, in its unchanged words |
| 49 | U, c2 open | `work show <U>` | `- Not done yet:` carries the identical sentence cell 44 refuses with — `model.ts` derives it from the same `completionRefusal` |
| 50 | U, c2 open, unit blocked on decision | `work done <U>` | refused for c2 — done is still allowed while the *unit* is blocked (ruling ①), and only the criterion stops it |
| 51 | a raw entity declaring criteria | `state done <id>` | refused by the shipped `requireCriteriaCovered`, naming `self state cover` — the raw path keeps its own spelling of the shared gate |

### F. Lifecycle — revise, supersede, confirm, decline, retire

| # | State | Operation | Expected |
|---|---|---|---|
| 52 | an unstarted plan declaring `a`, `b` | `work revise <id> "revised plan" --why w` | records `entity.revised {entity, text, why}`, unchanged; the plan still declares `a`, `b` — **criteria are carried, never replaced**, because a revision restates the plan text and says nothing about the list |
| 53 | same | `work revise <id> "y" --why w --criteria "c"` | refused: `work revise restates the plan text — declare a criterion with \`self work criteria add <id> "<text>"\`, which appends it to the ones already declared` |
| 54 | same, then `work criteria add`, then confirm | the sequence | the confirmed unit declares `a`, `b`, `c`; the declaration lands whether it was made before or after the confirm |
| 55 | a plan whose criteria are wrong, unstarted | correcting them | the only paths are `self undo <the entity.criterion-declared>` for one added later (cell G4), or `self undo` of the plan itself and a fresh propose for one declared at birth. **Nothing edits or removes a birth criterion**, and the refusals in cells 53 and 17 both say so |
| 56 | U declaring `a`, `b` | `work add "y" --supersedes <U> --why w --criteria "a"` | the successor declares `a` alone — **the successor inherits nothing**. `U` keeps its own list and its own claims, and is retired in the same append, unchanged from #389 |
| 57 | same, successor declares nothing | `work add "y" --supersedes <U> --why w` | the successor declares nothing and is gated on nothing; the retirement disclosure is unchanged — it names the outcome, not the criteria |
| 58 | a plan carrying `--supersedes` and criteria | `work confirm <id>` | one append: `entity.confirmed` + `entity.retired`, unchanged; the confirmed unit declares exactly what the proposal declared |
| 59 | a plan declaring criteria | `work decline <id> --why w` | `entity.retracted` only, unchanged; the declarations are part of a plan nobody accepted and reach no live surface |
| 60 | U, c2 covered, c3 open | `work retire <U> --why w` | records; retirement is never gated on criteria — the outcome was given up, which is the case the gate's own refusal points at |

### G. `self undo`

None of the three new types joins `undo.ts`'s `REFUSED` list: they are
`entity.*`, they are undoable by default, and #400's rule holds — a record
`self undo` takes back needs no person at a keyboard.

| # | State | Operation | Expected |
|---|---|---|---|
| 61 | U, c2 covered | `undo <the entity.covered id>` | c2 is open again and gates done again; the shipped receipt line is unchanged: `w-abc12 has that criterion open again — the coverage claim was taken back` |
| 62 | U, c3 blocked then covered (cell 29) | `undo <the entity.covered id>` | c3 is **blocked again** — the block was never annulled, and the fold's newest-fact rule restores it with no second event |
| 63 | U, c3 blocked | `undo <the entity.criterion-blocked id>` | c3 is open again; receipt: `w-abc12 c3 is open again — the block was taken back`, a new `UNDONE_NOTE` row rather than the generic fallback |
| 64 | U declaring `a`,`b`,`c`,`d`, where `d` was declared later | `undo <the entity.criterion-declared id>` | the unit declares three again. Receipt: `w-abc12 no longer declares "d" — the declaration was taken back; the criteria after it renumber`. Allowed with no dependent check, matching `undo.ts`'s stated reason for leaving links and coverage claims out of the ordered set: they accumulate, and removing one leaves every other where it was |
| 65 | cell 64's unit where `d` was **covered** | `undo <the entity.criterion-declared id>` | allowed; the coverage claim folds to nothing by the shipped rule — *a claim naming a criterion the entity never declared folds to nothing*. `entity.covered` stores the criterion's **text**, so nothing is silently reattached to a different criterion when the rest renumber |
| 66 | U, c1 covered, c2 declared later and covered | `undo <c2's entity.criterion-declared>` | c1 is still c1 and still covered; only the undone criterion leaves |
| 67 | U | `undo <the entity.criterion-unblocked id>` | c3 is blocked again, naming the same `--on` and `--why` |
| 68 | a unit whose creation payload declared criteria | `undo <the creation id>` | the whole unit goes, unchanged from #390 — the criteria were never separate records |

### H. Fold, merge and determinism

| # | State | Operation | Expected |
|---|---|---|---|
| 69 | two clones, one declaring c4 and one declaring c5, union-merged | fold | one order on both clones: creation-payload criteria first, then declarations by `(ts, event id)` — the comparator `ordered()` already uses |
| 70 | the same `entity.criterion-declared` merged in twice | fold | idempotent: declared once, by the event-id guard `collectCoverage` already sets the precedent for |
| 71 | `entity.criterion-blocked` naming a criterion the unit never declared | fold | folds to nothing — the same rule coverage claims already follow, so a hand-appended line cannot mint a criterion |
| 72 | `entity.criterion-declared` with an empty or non-string `criterion` | fold | ignored; nothing crashes and the unit declares what it declared |
| 73 | a creation event whose `verify` is a string, an array, or names `c9` | fold | reads as absent for whatever it cannot key: the criteria stand, their verification texts do not, and no reader is handed a shape it did not expect |
| 74 | any unit | `entity.criteria` vs `criterionStates` | `criteria` equals `criterionStates.map(item => item.text)` — asserted directly, so the derived list can never drift from the one every shipped reader uses |

### I. Renders

| # | State | Operation | Expected |
|---|---|---|---|
| 75 | U, c1 covered with evidence, c2 blocked, c3 open with a verify text | `work show <U>` | a Criteria block, absent entirely on a unit declaring none: `- Criteria: 1 of 3 covered (1 blocked)`, then one bullet per criterion in cN order — `c1 covered — <why> (<actor> <date>, <commit>)`, `c2 blocked on external — <why>`, `c3 open · verify: <text>` |
| 76 | U declaring none | `work show <U>` | byte-identical to today |
| 77 | cell 75's unit | the synced `work/<id>.md` | carries the same block — every value in it is folded, so nothing machine-local reaches a synced file |
| 78 | cell 75's unit | `self work` piped | the row gains one bracketed segment: `… [2 of 5 criteria covered]`, beside the shipped `[toward …]` and `[gated by …]` |
| 79 | cell 75's unit | `self work` at a terminal | a **note** under the unit's row, not a new column: a fifth column would re-lay-out the table for every store, and most units declare nothing |
| 80 | U declaring none | `self work`, both renders | unchanged, both |
| 81 | U active with criteria | `self context` | the Work-in-progress row carries ` — 2 of 5 criteria covered`, placed after `[toward …]` and before the held note, so the progress reads with the unit and ahead of the disclosures |
| 82 | U with a blocked criterion | `self context` | **no** Waiting-on-you row, and the unit is not counted among blocked ones — a criterion's block is not the unit's |
| 83 | a raw entity declaring criteria | `state show <id>` | criteria render as `criterion: c1 <text>` with their `verify:` and `blocked:` lines beneath; the shipped `covered:` line is unchanged |
| 84 | any | `self log` | each new type prints a row naming the unit and the criterion; nothing prints a raw event object |
| 85 | cell 75's unit, linked to a milestone | `milestone show` | **out of scope here.** #408 delivers `WorkState.criteria` and `criteriaProgress()`; #406 prints `criteriaProgress(work.criteria)` verbatim per linked unit and owns the row and the layout. A milestone's own exit criteria are unchanged: they stay on the milestone entity, `milestone met` writes the same `entity.covered`, and no verb here blocks one |
| 86 | the golden fixture | `golden.test.mjs`, `docs.test.mjs` | regenerated: the fixture's unit declares criteria, one covered with evidence and one open, so the four renders above are pinned and every documented line runs |

### J. Who wrote it

| # | Caller | Operation | Expected |
|---|---|---|---|
| 87 | P | `work criteria add <U> "d"` | `by = {kind:"person"}`; no prompt, no person gate — every new type is one `self undo` takes back |
| 88 | R | `work block <U> --criterion c3 --on external --why w` | `by = {kind:"agent", session:"<token>"}` |
| 89 | R | `work cover <U> --criterion c2 --why w` | `entity.covered` carries `by` for the first time; `CoverageClaim.actor` is unchanged, and `state show`'s shipped claim line still reads off it |
| 90 | R | `work show <U> --history` | the criterion events render with #400's who-wrote-it line, the way every other `entity.*` does |

### K. Mixed version — a 0.11.0 CLI reading a store written here

| # | What the store carries | 0.11.0's fold | Consequence |
|---|---|---|---|
| 91 | `payload.verify` on a creation event | ignored by `newEntity`, which reads named keys only | the criteria read; their verification methods do not |
| 92 | `entity.criterion-declared` | ignored — `applyEntity` falls through to `reconcileEntity`, whose `COLLECTORS.find` matches nothing | the unit reads with its birth criteria alone; `k of n` counts low |
| 93 | an `entity.covered` naming a criterion declared by cell 92's event | folds to nothing, by the shipped rule for a claim on an undeclared criterion | 0.11.0's `state done` gate is **looser**, never tighter — it never refuses a done this CLI would allow |
| 94 | `entity.criterion-blocked` / `-unblocked` | ignored | the criterion reads open; the **unit's** own block is untouched, which is the whole reason these are not `entity.blocked` |
| 95 | an `entity.covered` written by `work cover` | folded normally | byte-identical to `state cover`'s, so this direction loses nothing at all |
| 96 | a store written by 0.11.0, read here | every unit declares what its creation payload declared, and nothing more | no back-fill, no migration; a unit with no criteria is gated on none, exactly as before |

Cell 94 is the design's load-bearing cell. Reusing `entity.blocked` with a
`criterion` field would replace every "ignored" in this section with a wrong
answer: 0.11.0 would read the unit as blocked when one criterion is, and read
an `entity.unblocked {criterion}` as clearing a unit-level block a person
recorded. That is the trade the section exists to state.

### L. Help, documentation and the contract

| # | State | Operation | Expected |
|---|---|---|---|
| 97 | any | `self work --help` | `work add` and `work propose` usage lines carry `[--criteria "<text>" …] [--verify "cN <how>"]`; `work block\|unblock` carries `[--criterion cN]`; `work criteria add` and `work cover` have usage lines of their own |
| 98 | any | `self work --help` option list | four lines: `--criteria <text>` a completion condition this unit is judged on, repeatable and ordered c1..cN; `--verify "cN <how>"` how one declared criterion is checked — recorded, never executed; `--criterion <cN>` which declared criterion a claim or a block answers; `--evidence <commit>` a commit recorded with the coverage claim |
| 99 | any | `self help work` | states the rule — a unit that declares criteria is not done until every one is covered — and that nothing deletes a criterion: a mistaken one is undone, one no longer needed is covered with a reason and no evidence |
| 100 | any | `self help work`, `self work --help` | both carry the runbook boundary paragraph verbatim |
| 101 | any | `self help runbook` | carries the same boundary from the other side, so the two pages cannot drift into two rules |
| 102 | any | `docs/reference/cli.md` | the *Outcome and work commands* section gains the three verbs; the *Entity grammar* section names the three new event types beside `entity.covered`; `--verify` is stated as recorded and **never executed**, in both places |
| 103 | any | `contract.test.mjs` | `checkContract` passes: the new branch and leaves are dispatchable, documented, and their declared requirements name flags their leaves accept |
| 104 | any | `ARCHITECTURE.md` | the event-type list carries the three, each marked as ignored by an older fold |

**104 cells.**

## Out of scope

`state criteria add` — the raw entity path declares at birth with `state add
--criteria` and no issue asks for the later spelling; the shared writer's
runbook guard (cell 21) is what lets it be added later without a second gate.
Editing a criterion's text or its `--verify` after it is declared. Removing a
criterion by any path but `self undo`. `--verify` on a milestone exit criterion
or a runbook stage. Executing a `--verify` text, ever — it is recorded prose
and the help says so twice. Reordering criteria. Per-criterion owners
(`--owner person`, proposal 4 of #404). Artifacts as records (proposal 3 of
#404). Recognising a checklist in the plan text, which #404 floated and this
issue's decision replaced with declared criteria. `milestone show`'s row and
layout (#406). Any HTML view. Nesting a criterion under a criterion.

## Cross-version note, for the release

A store written by this CLI folds correctly on 0.11.0: the three new event
types and `payload.verify` are ignored by every shipped fold pass. What is lost
there is one-directional and safe — criteria declared after creation do not
appear, verification texts do not appear, and a blocked criterion reads open,
so the older CLI's done gate is looser and never refuses a completion this one
would allow. In the other direction nothing is lost at all: a unit written
before this issue declares nothing and is gated on nothing, exactly as it was.
