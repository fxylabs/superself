# Case table — a mistaken record is undone, not ceremonially superseded (#390)

The design artifact for #390, written before the code and approved on the
issue. Every cell below is one test, named by its cell number: cells 1–65 in
`apps/cli/test/undo.test.mjs`, cells 66–78 in
`apps/cli/test/review-settle.test.mjs`. The cells this issue leaves unchanged
name the test that already proves them. The table is the review surface: a cell
the table lacks is a path nothing proves.

## The defect

When a record turns out to be a plain mistake — a unit added with the wrong
outcome, a wrong `done`, a wrong link — the only correction the model offered
was the supersede ceremony. That ceremony captures nothing for a typo: the
`--why` is written to satisfy the flag. Ceremony was doing the job of an eraser,
and doing it badly.

## The rule, in three sentences

1. **Undoable by default over the record grammar.** Every `entity.*` kind and
   `report.added` are taken back; a short list of kinds is refused **by name**,
   each refusal naming the verb that does the job.
2. **One append is one undo, and the unit is the coupled component inside it.**
   `refs.batch` records the append boundary; two events of one append that name
   the same record are one state change. `self sweep --record` writes N
   unrelated proposals in one append, and undoing one must not annul the others.
3. **A record something was built on is refused with the list.** Never a
   cascade: a cascade writes annulments nobody named, and the store merges
   across machines, so one clone would compute a set another would not.

## What is written

One new event type and one new ref.

| Type | Payload | Refs | Origin |
|---|---|---|---|
| `entity.annulled` | `{ undid, entity?, scope?: "supersession", why?, meant? }` | `annuls: "<event-id>"` (+ `branch`, + `batch` when the unit holds more than one) | `actor: "agent"`, `confirmed: false` |

| Ref | Where set | Shape |
|---|---|---|
| `refs.batch` | `pipeline.ts` `recordEvents` / `recordCalls` | a ulid, set only when the append holds more than one event |

`payload.meant` is the one new payload field, stamped by the `--meant` host
flag on every event of the append.

**No migration.** `collectAnnulled` keys on `refs.annuls` whatever the event
type says, so an older log's `entity.restored` folds byte-identically and
unmigrated. `refs.batch` is absent on every existing event, so each of those is
a unit of one.

## The cells

### 3.1 Which kinds an undo takes back

Unless stated, the record is unsettled with no dependents and the invocation is
`self undo <event-id>`.

| # | Event kind | Recorded by | Expected |
|---|---|---|---|
| 1 | `entity.proposed` | `work propose "<plan>"` | annulled; the proposal is gone from `work` and `context`; `work show` says `undone` |
| 2 | `entity.confirmed` (creation) | `work add "<outcome>"` | annulled; the unit leaves every live surface; its folded page is removed |
| 3 | `entity.confirmed` (creation) | `decide "<text>"` | annulled; the decision leaves `context`. Also inverted in place at `retirement-gate.test.mjs` |
| 4 | `entity.confirmed` (creation) | `convention add "<text>"` | annulled; the rule leaves the conventions block |
| 5 | `entity.confirmed` (creation) | `goal add "<text>" --supersedes <id>` | annulled; the goal it superseded is live again and the new one is gone |
| 6 | `entity.confirmed` (acceptance) | `work accept <id>` | annulled; the record is in review again; the receipt names `self work accept <id>`. Inverts `work-revise.test.mjs` cell 19 and `391-skill-registry.md` H2 |
| 7 | `entity.retracted` | `convention drop <id>` | today's behaviour, unchanged: the rule stands again |
| 8 | `entity.retired` | `work retire <id> --why w` | today's behaviour, unchanged: the unit is open again |
| 9 | `entity.linked` | `work link <id> --objective <o>` | today's behaviour, unchanged — `cross-link.test.mjs` D5 and `objective-revise-carry.test.mjs` cell 16 |
| 10 | `entity.unlinked` | `work unlink <id> --objective <o>` | the edge is back |
| 11 | `entity.revised` | `work revise <id> "<text>" --why w` | today's behaviour, unchanged — `work-revise.test.mjs` cell 18 |
| 12 | `entity.started` | `work start <id>` | the unit is `next` again; `startedOnce` is clear, so `work revise` is allowed again |
| 13 | `entity.blocked` | `work block <id>` | the unit is open again, `blockedOn` cleared |
| 14 | `entity.unblocked` | `work unblock <id>` | the unit is blocked again, with its original reason |
| 15 | `entity.done` | `work done <id>` | the unit is open again at the state before the done |
| 16 | `entity.covered` | `milestone met <id> --criterion c1 --why w` | the criterion is open again; the milestone's met count drops |
| 17 | `entity.placed` | `state place <id> --priority 3` | the record's priority is what it was before |
| 18 | `report.added` | `self report <id> "<text>"` | the report leaves `work show` and the friction the sweep reads |
| 19 | creation with `--supersedes` | `decide "<t>" --supersedes <id>` + `--supersession` | today's behaviour, unchanged: the successor stands and stops claiming to replace anything. Amended in place at `retirement-gate.test.mjs` and `goal-record.test.mjs` B8 |
| 20 | creation with `--supersedes`, no `--supersession` | same | the successor is gone **and** the predecessor stands again |

### 3.2 Which kinds are refused, and by what name

| # | Event kind | Expected refusal |
|---|---|---|
| 21 | `report.confirmed` | refused, naming a new `self report … --design --implements …`; no event written |
| 22 | `artifact.registered` | refused, naming `self artifact prune <id> --why w` |
| 23 | `artifact.pruned` | refused: nothing takes back a deletion |
| 24 | `project.archived` | refused, naming `self project restore <slug>` — `project-archive.test.mjs` cell 16, unchanged |
| 25 | `project.restored` | refused, naming `self project archive <slug>` |
| 26 | `work.run-started` / `work.run-exited` | refused: a process really ran |
| 27 | `entity.annulled` | refused: an undo is not undone; the forward act is named |
| 28 | `entity.restored` (an older log's undo) | refused, same wording as 27 |
| 29 | a legacy `work.*` / `decision.*` / `objective.*` / `milestone.*` / `goal.set` / `entity.superseded` / `review.received` line | refused, naming the type and saying it predates the record grammar |
| 30 | an event id no log holds | today's `findEventByPrefix` refusal, unchanged |
| 31 | an ambiguous id prefix | today's ambiguity refusal, unchanged |
| 31a | an id another registered project's log holds | **added during implementation.** Refused by naming the owning project and telling the reader to run it from that checkout, rather than calling the id unknown. The design left this to the generic not-found refusal, which sends a reader looking for a typo instead of a directory |

### 3.3 Settled, dependents, and the invocation

| # | Record kind | Settled? | Dependents | Invocation | Expected |
|---|---|---|---|---|---|
| 32 | work unit creation | unsettled | none | `self undo` (bare) | annulled; the receipt names the record it took back |
| 33 | work unit creation | unsettled | none | `self undo <full event id>` | annulled; identical to 32 |
| 34 | work unit creation | unsettled | none | `self undo <unambiguous prefix>` | annulled; resolved through `findEventByPrefix` |
| 35 | work unit creation | settled (a later unrelated `decide`) | none | `self undo <id>` | **annulled.** Settled is not a lock — it only means the bare form no longer points here |
| 36 | work unit creation | settled | one `report.added` naming it (d2) | `self undo <id>` | refused, exit 2, listing the report and the undo lines; no event written |
| 37 | work unit creation | settled | one `entity.started` on it (d2) | `self undo <id>` | refused, listing the start |
| 38 | `entity.started` | settled | a later `entity.done` on the same record (d3) | `self undo <start id>` | refused, listing the done |
| 39 | `entity.started` | settled | a later `report.added` on the same record (d3) | `self undo <start id>` | refused — the deliberate over-refusal of d3, with the list |
| 40 | `entity.proposed` | settled | the `entity.confirmed` that accepted it | `self undo <proposal id>` | refused, naming the acceptance |
| 41 | `report.added` | settled | an `entity.proposed` citing it in `refs.friction` (d1) | `self undo <report id>` | refused, naming the swept proposal |
| 42 | a decision | settled | a later decision with `refs.after` naming it (d1) | `self undo <id>` | refused, naming the sequenced decision |
| 43 | a decision | settled | a `report.confirmed` citing it in `refs.implements` (d1) | `self undo <id>` | refused, naming the approval |
| 44 | work unit creation | settled | a dependent that is **itself annulled** | `self undo <id>` | **annulled** — an annulled dependent is not one |
| 45 | a freshly registered project | — | — | `self undo` (bare) | refused, naming the `self undo <event-id>` form — `project init` writes into the registry, not into the project's log, so a new project's log really is empty |
| 46 | two appends in a row | settled | none | `self undo` (bare) | takes back the **newer** append and names it, leaving the older one standing. **Diverges from the design**, which described a refusal; the bare form has exactly one meaning and refusing it would leave the ergonomic payoff with no spelling |
| 47 | work unit creation | unsettled | none | `self undo <id>` twice | the second is refused with today's "was already undone" wording; one annulment in the log |
| 48 | `work done --report` (a two-event append) | unsettled | none | `self undo <the done's id>` | **both** events annulled in one append: the unit is open again and the report is gone |
| 49 | `work done --report` | unsettled | none | `self undo <the report's id>` | identical to 48 — either member names the append |
| 50 | `work accept` (confirm + link append) | unsettled | none | `self undo <id>` | both annulled: the record is in review again and the objective edge is gone |
| 50a | `work accept` of a **superseding** plan (#389's confirm + retired pair) | unsettled | none | `self undo <the confirm's id>` | **added during implementation.** Both annulled as one coupled component: the plan is in review again and the unit it retired is open again |
| 51 | a cap-driven placement pair | unsettled | none | `self undo <id>` | both placements annulled; the demoted record is back where it was |
| 52 | a legacy-log event with no `refs.batch` | — | none | `self undo <id>` | annulled alone; absence of a batch id means a unit of one |
| 52a | `sweep --record` writing several `entity.proposed` in one append | unsettled | none | `self undo <one proposal's id>` | **that one** proposal annulled; the others stand |
| 52b | a `self apply` set of unrelated withdrawals in one append | unsettled | none | `self undo <one withdrawal's id>` | that one withdrawal taken back; the others stand |
| 52c | any | — | — | `self undo <id>` inside a `self apply` set | refused before dispatch: an undo records rather than destroys, so one confirmation does not cover it |

### 3.4 What every reader answers afterwards

| # | State | Action | Expected |
|---|---|---|---|
| 53 | undone unit | `self work` | not listed |
| 54 | undone unit | `self context` | absent from every section |
| 55 | undone unit | `self work show <id>` | answers, `- Status: undone`, with `- Undone: <date>` |
| 56 | undone unit | `self work show <id> --history` | both halves shown; the creation row marked `· undone`; the annulment row names what it took back |
| 57 | undone unit | `self log` | both halves; the same marks |
| 58 | undone unit | `self search "<its text>"` | no hit |
| 59 | undone unit | `self handoff <id>` | refused as a unit that is not workable |
| 60 | undone unit | the folded `state.md` and its `work/<id>.md` page | the page is removed; `state.md` does not mention it |
| 61 | undone record | a second fold of the same log | identical state — the annulment travels as an event |
| 62 | a shuffled log (union merge order) | fold | identical state; `collectAnnulled` runs before anything folds. Extends `retirement-gate.test.mjs`'s shuffle cell to a creation |
| 63 | undone unit that had an artifact | `self artifact list` | the artifact row stays and is not pruned |
| 64 | undone `entity.done` | the completion gate on a later `work done` | recomputed from the reports that stand |
| 65 | undone unit | `self status` | the unit's commits are no longer counted as unshipped |

### 3.5 Review and settle

| # | `--meant` | Path taken | Expected |
|---|---|---|---|
| 66 | absent | `work add "<outcome>"` | the receipt's second line prints the new id and outcome and the `self undo <event-id>` line |
| 67 | given | `work done <id> --meant "<restatement>"` | the receipt prints record and intent side by side; `payload.meant` is on the event |
| 68 | given, mismatched | `work done <wrong id> --meant "<restatement>"` | **the command succeeds and records** — no heuristic refusal — and the receipt shows the two texts side by side with the undo line under them |
| 69 | after 68 | the handed `self undo <event-id>` line, run verbatim | annulled; the wrong unit is open again |
| 70 | given | `--json` on a write verb | refused by the machine contract before anything resolves, so no review line reaches a machine surface and nothing is recorded. See divergence 4 |
| 71 | given empty (`--meant ""`) | any mutating command | refused in `main()` before anything resolves |
| 72 | absent | a read-only command (`self context`) | no receipt line; nothing recorded |
| 73 | — | two mutating commands in a row | after the second, bare `self undo` targets the second |
| 74 | — | a mutating command, then `self context` **in the same session** | no unreviewed line in Health |
| 75 | — | a mutating command, then `self context` **from a different session token** | one Health line naming the record and `self undo` |
| 76 | — | after 75, the record is undone, then `self context` | the Health line is gone; the annulment is not itself flagged |
| 77 | — | a mutating command, then a read that records nothing | still unsettled — a command that records nothing does not close the window |
| 78 | — | `--meant` on a command written into another project's log | recorded on the event that log holds |

**81 cells** — the design's 78, plus 31a, 50a and the two divergences recorded
in place at 45 and 46.

## Divergences from the design document

The design was written before #389 and #391 merged, and before d3 was measured
against the shipped suite. Where merged reality contradicted it, merged reality
won.

1. **d3 is narrowed to the order-dependent transitions.** As written — "any
   later non-annulled event carrying `payload.entity = X`" — it refused
   `cross-link.test.mjs` D5 and `objective-revise-carry.test.mjs` cell 16, both
   of which undo a link under a record that moved on afterwards. Links and
   coverage claims accumulate: removing one leaves every other exactly where it
   was, so a later event on the same record does not make the undo a
   half-applied history. d3 now fires only when the annulled event is itself an
   ordered transition (`started`, `blocked`, `unblocked`, `done`, `retired`,
   `retracted`, `confirmed`), which is the axis whose fold matrix is
   order-dependent. Cells 38 and 39 still refuse; cells 9 and 10 still pass.
2. **`entity.restored` is read as the narrow (`--supersession`) form.** The
   design's creation split would otherwise change how an existing log folds: an
   older `entity.restored` annulling a creation dropped its supersedes links and
   kept the record, and under the default scope it would now undo the record
   outright. That type only ever reached a creation that had displaced
   something, so reading it as the narrow form is both true and what keeps every
   shipped log byte-identical (cell 62's fixture).
3. **The #389 acceptance pair is one coupled component** (cell 50a). The design
   was written against the pre-#389 `work accept`, which wrote confirm + link.
   The merged verb writes confirm + retired for a superseding plan, under one
   typed confirmation, and both halves carry the `confirmation` payload. The
   coupling rule joins them through the record ids they name, so one undo takes
   back both and the retired unit is open again.
4. **Cell 70 is unreachable as written.** No record-writing verb declares
   `--json`, so the machine contract refuses the flag before anything resolves
   and the review line can never reach a machine surface. The guard is written
   anyway — the line is suppressed under `jsonMode()` — and the cell proves the
   refusal that is reachable today.
5. **Cell 46 takes back the newer append** rather than refusing. The bare form
   has exactly one meaning — the newest append — and a refusal in the settled
   case would leave the ergonomic payoff with no spelling at all.
6. **Cell 34 uses an unambiguous prefix, not five characters.** Two ulids minted
   in one session share their whole timestamp half, so a five-character prefix is
   ambiguous by construction; cell 31 is the cell that proves the ambiguity
   refusal.
7. **New cell 31a**: an id another registered project's log holds is refused by
   naming that project and its checkout, not by calling the id unknown.
8. **A link's target is not a coupling key.** The design joined two events of
   one append on `payload.link.target` among others. `objective revise` writes
   one carry link per milestone into one successor, so that key made the whole
   revision one component and undoing a single carry annulled all of it —
   `objective-revise-carry.test.mjs` cell 16 caught it. Coupling now joins on
   the records an event is *about* (`payload.entity`, `payload.successor`,
   `refs.work`, `refs.confirms`, `refs.admits`); dependent detection keeps the
   wider set, because a later event is built on this one whichever end of an
   edge it names. Every coupled append in the design's table still joins:
   `work done --report` and `work accept` through the unit, `work add
   --supersedes` and #389's acceptance pair through the successor, a cap-driven
   placement pair through `refs.admits`.

## The receipt's blast radius

The review line is one extra line under every append's own recorded line, so
every test that pinned the exact bytes of a piped or styled receipt moves by
one line. Swept and amended in place, each with the reason beside it:
`render-gate.test.mjs` cell 9, `render-gate-values.test.mjs` stage 5 cell 13,
`render-gate-receipts.test.mjs` stage 2 cell 1, `render-gate-tty.test.mjs`
cell 8 and stage 2 cell 2, `render-gate-listings.test.mjs` stage 3 cell 3
(both halves), `work-attachment.test.mjs` (the offer helper and the terminal
cell), and the golden fixture, regenerated. `render-gate.test.mjs` cell 10 is
untouched: it calls `notice` directly and asserts nothing about an append.

## Baselines this issue inverts

| Where | Cell | Was | Is |
|---|---|---|---|
| `docs/maintainers/case-tables/391-skill-registry.md` | H2 | undoing a replacement-landing confirm is refused: an acceptance is not taken back | the confirm is taken back; the replacement returns to proposed |
| `docs/maintainers/case-tables/391-skill-registry.md` | H3 | a first registration is refused: a creation with no supersedes link is not undoable | the registration is taken back; the skill leaves the registry |
| `docs/maintainers/case-tables/356-revisable-proposals.md` | 19 | refused by name; the answer names `work revise` | back to review; re-accepting still needs a person |
| `apps/cli/test/retirement-gate.test.mjs` | — | `undo` without `--why` is refused | deleted: `--why` is optional |
| `apps/cli/test/retirement-gate.test.mjs` | — | a plain `decide` is refused: "undo takes back a retirement, a withdrawal, a link…" | taken back (cell 3) |

## Explicit exclusions

- **Rewriting history.** No event is deleted or edited; undo is an event.
- **Cascading undo.** A dependent is listed, never annulled on the agent's
  behalf.
- **Undoing bytes.** `artifact.registered` / `artifact.pruned` stay outside;
  #239 owns them.
- **Undoing a person's approval.** `report.confirmed` stays outside (cell 21).
- **Undoing across projects in one call.** `undo` keeps resolving its project
  from the working directory; cell 31a names the owner rather than adopting the
  from-the-record resolution.
- **A recorded settle.** No `self ok`, no ack event, no `reviewed` field.
- **Any matching heuristic on `--meant`.** Printed, never judged.
- **`--json` receipts.** Machine mode prints the payload and nothing around it;
  the review line is a human/agent-terminal surface.
- **Multi-writer trust and permissions**, and **the entry gates** (#389).
