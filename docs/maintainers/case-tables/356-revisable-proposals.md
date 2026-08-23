# Case table — a standalone work proposal is revisable until first start (#356)

The design artifact for #356, written before the code and reviewed on the
issue. Every test in `apps/cli/test/work-revise.test.mjs` is one cell below,
named by its cell number, and asserts that cell's stated outcome. The table is
the review surface: a cell the table lacks is a path nothing proves.

Cells 1 to 12 are the table the issue was accepted with, restated in the CLI's
own words. Cells 13 to 30 extend it along what the verbs resolve from outside
their arguments and around the record lifecycle. Cells 31 to 33 come from the
maintainer review of 2026-08-23.

## The defect

`self work add` creates confirmed work at once, so an agent-written plan is
approved by the act of recording it. `self work propose` has the review
lifecycle, but demands an objective or milestone plus eight brief fields, so
the first ordinary loop — one task, one plan, one reviewer — cannot use it.
Work text is immutable, so correcting an unstarted plan mints a second work id
and splits one plan's history across two records.

## The vocabulary

A **revision** is one stated version of a work record's plan text. The
creation is always v1; `work revise` states v2, v3 … under the same `w-` id.

## What the verbs resolve from outside their arguments

| Read | Where it comes from | Cells that run it from outside that context |
|---|---|---|
| which project a revision records into | `process.cwd()`, through `requireProject` — `work revise` is a write verb and declares no `--project` | 13 (inside), 14 (the workspace root), 16 (outside any project) |
| which log owns the record | the workspace fold that renders it, as `work start` resolves an owner (#181 D3) | 13 |
| which project a confirm answers in | the record itself (#302), never the directory | 12, 17 |
| which revision is current | the creation, plus every non-annulled `entity.revised` naming the record, ordered by `(ts, event id)` | 9, 18, 29, 30 |
| whether the plan is accepted | whether a non-annulled `entity.confirmed` names the current revision | 4, 5, 9, 31 |
| whether the plan is frozen | `startedOnce` on the record, set by the first `entity.started` and never cleared | 8, 26 |

## Rules the cells are derived from

1. **A revision is an event, in the owned namespace.** `entity.revised`
   carries `payload.entity`, the whole new `payload.text`, and a required
   `payload.why`. It mints no record and takes nothing back, so it is not a
   statement transition and `STATEMENT_TYPES` is unchanged.
2. **Revision identity is the event id, and v1's is the record's own id.**
   Every `work accept` ever written names the record in `refs.confirms`, so
   reading that as "v1 was accepted" costs no migration and no second
   spelling. v2 onwards are named by their `entity.revised` event id.
3. **The creation is always v1**, whatever its timestamp says: a revision
   pulled from a clock-skewed clone can carry an earlier one. The rest sort by
   `(ts, event id)`, the comparator every collected event already lands in — a
   set, never log order, so two clones of one store fold one plan history.
4. **Accepted iff some non-annulled `entity.confirmed` names the current
   revision.** Not "the newest confirm names the newest revision": a lagging
   clone accepting v1 after v2 was accepted must not send v2 back to review
   (cell 31).
5. **A stale acceptance keeps `confirmedOnce`.** It is the flag supersession
   reads to decide whether a `supersedes` link displaces, so flipping it back
   would resurrect a record this work had already replaced. `humanConfirmed`
   reads false while stale: nobody approved the text that is current now.
6. **`review` is a sixth work status.** A record awaiting review is open work,
   so every renderer that switches on status says so for free rather than
   restating one filter six times.
7. **The first start freezes the plan.** `startedOnce` is set beside the claim
   the first `entity.started` records, so a start against a blocked unit
   freezes it too and a later done or retirement cannot erase the fact.
8. **One dispatch gate.** `requireDispatchable` answers
   `reviewRefusal(work) ?? dispatchRefusal(…)`. The design gate is untouched:
   it answers a different question, and merging the two would put review state
   inside it.
9. **The brief is required of a gap proposal only.** `PROPOSAL_REQUIRED`
   leaves the leaf and is applied inside the handler through the same
   `requireOptions` gate when `--objective` or `--milestone` is present, since
   a requirement that depends on another flag's value is not declarable.
10. **A revision destroys nothing**, so the leaf is not `retiring`: one id, no
    successor, no supersession — the opposite of `objective revise` and
    `milestone revise`, and the help says so.
11. **A revision of a record that is not live folds to nothing.** The verb
    refuses first; the fold guard is for merged and hand-appended logs.
12. **Only a record born as a proposal is revisable.** `work add` is the
    already-approved path, and its refusal names
    `work add --supersedes <id> --why w`.

## The cells

| # | State | Operation | Expected |
|---|---|---|---|
| 1 | no objective or milestone | `work propose "<plan>"` | receipt is the work id; one `entity.proposed`; a Waiting on you row carrying `self work accept <id>` |
| 2 | objective and full brief | `work propose … --objective o-x --value … --expires …` | unchanged; a call missing brief flags is refused by the one gate, listing every one at once |
| 3 | open v1, never started | `revise` | same id; `work show` prints `Plan: v2 (current)`; `--history` still holds v1 and the why |
| 4 | open v2 | `accept` | receipt is the same id; `entity.confirmed` carries `refs.confirms` = the v2 event id; status `next` |
| 5 | accepted v2, never started | `revise` to v3 | status back to `review`; `work show` says `v3 (current) · v2 accepted` |
| 6 | proposed, or a stale acceptance | `work start` | refused, naming `self work accept <id>` |
| 7 | accepted revision is the current one | `work start` | the brief is printed, `entity.started` is recorded, the claim is disclosed as before |
| 8 | the id has ever started, whatever its status now | `revise` | refused, naming `work add --supersedes <id> --why w` |
| 9 | clone A accepts v1, clone B revises to v2, union-merged in either order | fold | both clones: v2 current, v1 accepted, status `review`, `work start` refused — and the two `work show` pages are byte-identical |
| 10 | a `work add` unit | add / start / report / done | unchanged events and renders; `revise` on one is refused, naming the successor spelling |
| 11 | a terminal and a pipe | propose / revise / show / context | the same id, revision numbers, review state and accept command in both |
| 12 | read outside the checkout through a recovery pointer | `accept` | resolves through the record it names (#302), unchanged |
| 13 | cwd inside the project | `revise` | records; the project resolves from the directory and the owning log takes the event |
| 14 | cwd is the workspace root | `revise` | refused: no registered project answers for the directory |
| 15 | cwd is the workspace root, `--project <slug>` | `work show <id>` and `--history` | answers, with the review state and every revision |
| 16 | cwd is outside any project | `revise` | refused by `requireProject`, naming where it looked |
| 17 | cwd is outside any project | `work accept <id>` | resolves through the record, unchanged |
| 18 | v3 current, v2 accepted | `undo <v3 event id> --why …` | v2 is current again and accepted again; status returns to `next` |
| 19 | v2 accepted | `undo <accept event id>` | refused by name: an acceptance is not taken back; the answer names `work revise` |
| 20 | a proposal with `--objective o-x`, never started | `revise`, then `accept` | same id; the member-of edge is untouched; still toward `o-x` |
| 21 | v2 current | `revise` with text identical to v2 | refused: nothing changed, nothing recorded |
| 22 | a done unit | `revise` | refused: it is already done |
| 23 | a retired unit | `revise` | refused with the retirement's own reason and `work show` |
| 24 | a legacy `work.*` unit (#305) | `revise` | refused, naming `work add --supersedes <id> --why w` |
| 25 | a declined proposal | `revise` | refused: it is already declined |
| 26 | accepted, started, then blocked | `revise` | refused — the freeze reads `startedOnce`, not the current status |
| 27 | v3 awaiting review | `work` listing and the `status` waiting count | one row in the listing, counted once in waiting — not once as work and once as a proposal |
| 28 | v3 awaiting review | `search "<plan text>"` | finds it: the record is live |
| 29 | two revisions written in the same millisecond | fold | `(ts, event id)` gives one order on every clone |
| 30 | a revision naming a withdrawn work id, merged in | fold | folds to nothing; the withdrawal stays terminal |
| 31 | v2 accepted, and a confirm naming v1 merged in afterwards | fold | still accepted: v2 is current and a confirm names it |
| 32 | a unit awaiting review | `report --design --implements <id>` | allowed — a design precedes the start it admits |
| 33 | a proposal folded from a pre-cutover `work.proposed` event | `accept` | answers as it did; a native accept now naming a revision id matches no legacy proposal |

## Out of scope

Undo of an acceptance; revising a started unit under any flag; revising
objectives or milestones under one id; making `work add` text revisable;
plan-quality scoring; back-filling revision numbers onto existing logs;
#171 runbooks; #286 link guidance; #305's legacy fold removal.
