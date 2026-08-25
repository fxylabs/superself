# Case table — a stored artifact's bytes can be removed, and its record cannot (#239)

The removal half of #239, written before the code. Every test in
`apps/cli/test/artifact-prune.test.mjs` is one cell below, named by its cell
number, and asserts that cell's stated outcome. The table is the review
surface: a cell the table lacks is a path nothing proves.

Cell numbers continue the ones the #239 design gave them, so cells 1 to 29 are
the measurement half and live in
[`372-store-measure-dedupe.md`](372-store-measure-dedupe.md). That table's cell
9 — a pruned record is not a reuse candidate — was the one cell it could not
run, because nothing pruned one yet. It runs now, in that suite.

Five rows carry a second number. [#238's table](238-entity-artifact.md)
deferred its removal cells to this branch, and where one of its rows is the
same state and the same outcome as one of these, one test answers for both
rather than two tests drifting apart.

## The defect

Bytes that entered the store could never leave it. A 15 MB database dump
attached as evidence in January is still in every clone of the store in
August, in three versions, and the CLI had no verb that could say anything
about it but its size. The store measured on 2026-08-05 held 356 MB of working
tree.

Nothing about that is safe to fix by sweeping. Deleting a file the log names
is the one mistake ingestion cannot undo, and the evidence a `done` claim
rests on is exactly the thing an audit later asks for.

## The ruling this implements

| # | Question | Decision |
|---|---|---|
| R1 | May the bytes an evidence claim points at be deleted? | **Yes — the bytes. Never the record.** The completion gate reads a unit's reports, not the files they name (`completion.ts` `completionRefusal`), so a closed `done` claim stands after the file is gone; the record is what keeps it auditable, and it stays |

R2 (store once, reference twice), R3 (the size bound) and R4 (compaction never
rewrites history) are the measurement half's and are answered there. R4 is why
this verb is honest about its limit: history is never rewritten, so the copy an
artifact left in `.git` stays there and only the working tree shrinks.

## Rules the cells are derived from

1. **The record is never removed, and every reader says so.** `artifact list`
   and `artifact search` keep the row and mark it `(pruned)`, the unit's folded
   section and its report row mark the label, and `artifact open` refuses by
   name. No reader answers from whether the file is on the disk. The one
   exception is the HTML gallery, where every card *is* a link to the bytes: a
   card for bytes that are gone is a broken door, so the card goes and the
   record stays where records are read.
2. **The event carries `refs.work` where the record has one.** It is the true
   link — this is that unit's evidence — and it is also what makes the fold see
   the removal: a unit projected from an entity does not exist during the first
   pass, so `model.ts` `replayDeferred` replays the lines naming a unit onto it
   once it does.
3. **`artifact open` never offers `self sync`.** Syncing fetches what another
   machine holds, and what another machine holds is the same removal.
4. **What may be pruned depends on how the bytes got here**, because a
   different thing leans on each:

   | Source | Event | Removable when |
   |---|---|---|
   | a report's evidence | `report.added` | its work unit is `done` or `retired` |
   | a review's evidence | `review.received` | the unit the review named is `done` or `retired`; a review naming no unit is refused outright |
   | bytes standing on their own | `artifact.registered` | no live record points at them |

   The removable work states are `done` ∪ `retired` — exactly the complement
   of the set `reachability.ts` `artifactSignals` still verifies, which is why
   no ordinary prune can produce a false missing-file signal.
5. **A live record pointing at the artifact refuses it, whatever the source.**
   `isLive` is the same predicate #238's health signal uses: a `proposed`
   record counts, so bytes a proposal points at are not removed and then
   missed the moment it is confirmed.
6. **Bytes a design approval named are refused outright.** An approval names an
   exact hash — a person read those bytes and said yes — so there is no flag
   past this and no work state that lifts it.
7. **One prune covers one record.** The typed challenge is the artifact's id.
   Where two records share a stored path, each is pruned by name, and the bytes
   go with the last live record naming them:

   ```
   sharers(P)     = every record of the owning project's log whose path is P
   liveSharers(P) = those with no artifact.pruned event
   ```

   Derived from the log at every prune. A stored counter could not stay true
   across a merge of two machines' logs.
8. **Append, remove, then fold and commit.** `onRecorded` (`pipeline.ts`) is
   the one seam where the record is already durable and the bytes are still
   there. Reversed, a process dying in between loses bytes nothing accounts
   for. In this order the same death leaves bytes nothing points at, which
   `store size` reports as orphaned — surplus rather than loss.
9. **The removal never throws.** `writeThrough` does not wrap `onRecorded`, so
   a throw would skip the fold and the commit and leave an appended line
   uncommitted. The failure is captured, said in the receipt, and the command
   exits 0: the record is already true, and exiting non-zero would tell a
   person nothing had happened.
10. **The log answers on its own.** The event carries `bytesRemoved`, so which
    prune actually reclaimed a path is readable without replaying the sharing
    arithmetic, and can be held against what `store size` reports as orphaned.
11. **Only the working tree is reclaimed.** History is never rewritten (R4), so
    the disclosure and the receipt both say the copy in `.git` stays.
12. **The delete path trusts a recorded path less than a read does.** A read
    that follows a foreign log line shows the wrong file; a delete that follows
    one is gone. So the target must resolve inside the owning project's own
    artifacts — narrower than the store-wide check every read goes through.

## What the verb resolves from outside its arguments

| Read | Where it comes from | Cells |
|---|---|---|
| how these bytes got into the store | the event that declared them | 30-35 |
| whether the outcome they are evidence for is closed | the owning project's fold | 30, 32, 36-40 |
| whether anything still points at them | the same fold's entity view, through `isLive` | 35, 47, #238 41, 42, 45 |
| whether a person approved exactly these bytes | the design approval on the report | 46 |
| how many live records name this stored path | the owning project's log, by path | 42-45 |
| whether the project may be written to at all | the store's archive state | 41 |
| whether a person is answering | an interactive terminal, and the runner marker | 49 |
| whether the recorded path is this project's to remove | the store's own directory layout | 62 |

## The cells

### Where the bytes came from

| # | Source | State | Action | Expected |
|---|---|---|---|---|
| 30 | report | its unit is `done` | `artifact prune` | confirmed and removed; the unit is still `done`, and its row is marked |
| 31 | review | the unit it named is `done` | `artifact prune` | confirmed and removed; the verdict the bytes were judged under stays recorded |
| 32 | review | the unit it named is open | `artifact prune` | refused, naming the unit and its state |
| 33 | review | it names no unit | `artifact prune` | refused, and says that is the reason |
| 34 | registered | nothing points at it | `artifact prune` | confirmed and removed |
| 35 (#238 39) | registered | a live record points at it | `artifact prune` | refused, naming the record |

### The state of the outcome the evidence belongs to

The work vocabulary is six values (`model.ts`): `next`, `active`, `blocked`,
`done`, `retired`, `review`. There is no `open`.

| # | Work state | Action | Expected |
|---|---|---|---|
| 36 | `next` | `artifact prune` | refused, no event, no byte removed |
| 37 | `active` | `artifact prune` | refused, no event, no byte removed |
| 38 | `blocked` | `artifact prune` | refused, no event, no byte removed |
| 39 | `review` | `artifact prune` | refused, no event, no byte removed |
| 40 | `retired` | `artifact prune` | confirmed and removed — an outcome given up is closed too |
| 41 | the owning project is archived | `artifact prune` | refused before the gate, naming `self project restore` |

### Two records, one stored path

| # | State | Action | Expected |
|---|---|---|---|
| 42 | two live records name one path | `artifact prune` on the first | that record is pruned, **no byte reclaimed**, the receipt says why, and the event records `bytesRemoved: false` |
| 43 | the same, both prunable | prune both | the second reclaims the bytes, with `bytesRemoved: true` |
| 44 | after 42 | `artifact open` on the pruned one | refused, though the bytes are still there for the other record; no `self sync` offered |
| 45 | after 42 | `store size` | the path is not orphaned — a live record names it |

### The gate, and what is refused before it

| # | State | Action | Expected |
|---|---|---|---|
| 46 | a design approval names its hash | `artifact prune` | refused outright, whatever the unit's state |
| 47 (#238 40) | the record pointing at it is retracted | `artifact prune` | confirmed and removed |
| 48 | already pruned | `artifact prune` | refused, no second event |
| 49 | no terminal, or a runner's marker | `artifact prune` | refused, no event, no byte removed, and the command to pass on is printed |
| 50 | the typed answer is not the id | `artifact prune` | refused, no event, no byte removed |
| 51 | no `--why` | `artifact prune` | refused by the contract, before anything is resolved |

### The removal itself

| # | State | Action | Expected |
|---|---|---|---|
| 52 | the removal fails after the event is appended | `artifact prune` | **exit 0.** The record is pruned, the bytes stay, the fold and the commit still run, the receipt says so, and `store size` reports the bytes as orphaned |
| 53 | a bundle | `artifact prune` | the directory goes whole; the manifest stays on the record |

### What every reader answers afterwards

| # | State | Action | Expected |
|---|---|---|---|
| 54 | pruned | `artifact open` | refused, naming when and why, with no `self sync` |
| 55 | pruned | `artifact list` | the row stays, marked `(pruned)` |
| 56 | pruned | `artifact search` | still a hit, marked |
| 57 | a hand-written `artifact.pruned` line on an open unit's artifact | `self status` | silent. The guard is defensive: rule 3 makes this unreachable from any ordinary prune, and it exists so a log this CLI did not write cannot make every fold advise a sync for a file somebody removed on purpose |
| 58 | another clone pulls | `sync` | the appended line and the removed file arrive as one commit, and the clone answers the same way |
| 59 | the id exists in two projects | `artifact prune` | the existing ambiguity refusal; `--project` narrows it, and the other project's bytes are untouched |
| 60 | a pruned review artifact | `artifact list`, `open` | marked and refused. A review artifact reaches no work-state surface at all, so the registry reads are the only ones it has |
| 61 | pruned | `handoff`, `work show`, and the folded HTML gallery | the unit's own section and its report row both keep the artifact and mark it; the gallery drops the card, because every card there is a link to the bytes and there are none |
| 62 | one project's record names a path inside another project's artifacts | `artifact prune` | refused before the gate, naming the path; the other project keeps its bytes |

### #238's removal cells

| # | State | Action | Expected |
|---|---|---|---|
| #238 41 | two records point at one artifact | `artifact prune` | refused while either is live, naming both and then the survivor |
| #238 42 | a report's artifact is also pointed at by a rule | `artifact prune` | refused though the unit is done — both sources must be satisfied; removable once the rule is dropped |
| #238 45 | a proposal points at it | `artifact prune` | refused — the same `isLive` predicate #238's health signal uses |

## Explicitly out of scope

Removing a record. Removing orphan bytes: `store size` reports them and no verb
deletes them, because a file no event names cannot be told apart from one
another report is staging at that moment. Rewriting history to reclaim `.git`.
Pruning by path, which would change records a person never named. Pruning
inside a reviewed set (`self apply`): one confirmation there covers a batch of
record withdrawals, and this challenge names the exact bytes instead. Any
automatic removal — every prune is one person naming one artifact. And `self
undo`, which refuses this event under the answer it already gives: it takes
back a withdrawal of a record, and nothing takes back a file.
