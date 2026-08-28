# Case table — consent given in chat reaches the store (#400)

The design artifact for #400, written before the code. Every cell below is one
test, named by its cell number. The table is the review surface: a cell the
table lacks is a path nothing proves.

Where each section's cells live:

| Section | File |
|---|---|
| A, B, D, G (`work add`, `work confirm`, `apply`), I (help), J (the rename) | `apps/cli/test/work-entry-gate.test.mjs` |
| C, E, F, G (`artifact prune`), H, I (the history render) | `apps/cli/test/agent-consent.test.mjs` |
| the disclosure that survived the gate | `apps/cli/test/retirement-gate.test.mjs`, `apps/cli/test/apply.test.mjs` |
| `report confirm` in its own gate's table | `apps/cli/test/design-gate.test.mjs` cells B1–B3 |
| `runbook approve` | `apps/cli/test/runbook-approval.test.mjs` cells D4–D7 |
| the terminal-less process, for real | `apps/cli/test/smoke.test.mjs`, `apps/cli/test/driver.test.mjs` cells 29, 32 |

A cell an existing table already owned keeps its number *there* and is inverted
in place — #389's cells 1–12, #316's B1–B3, #171's D4–D7, #390's cell 21 —
rather than being deleted and rewritten here under a new one. What changed is
then legible beside what did not.

## The defect

Seven verbs refuse to run from an agent session and print "a person runs this in
their own terminal". The person had already said yes — in the conversation the
session is having with them — so the refusal does not withhold consent, it
withholds the *record* of consent already given. The agent then prints the
command back and the person pastes it, which is where a long
`--supersedes … --why "…"` line drifts from what was agreed.

## The rule, in one sentence

**A verb whose record `self undo` can take back needs no person at a keyboard;
it records who wrote it instead.** The gate that survives is the one on the act
that cannot be undone — `artifact prune` — because bytes leaving the store are
not an event a later event reverses.

## Why the gate was there, and why it goes

The gate's justification was never "a person types it". It was "a mistaken
record cannot be taken back", written before `self undo` existed (#390). Now
that every `entity.*` transition and `report.confirmed` is undoable, the gate on
those verbs buys nothing a person cannot buy with one `self undo`, and it costs
the record its accuracy: the write happens later, from memory, or not at all.

`undo.ts` is therefore the authority on which verbs keep a gate. One type is
still refused for a reason that holds — `artifact.pruned` removes bytes — and
that is the one verb that keeps its person gate.

`report.confirmed` leaves `undo.ts`'s refusal list in this issue. Its refusal
read "a person's ruling on a design report", which stops being a distinguishing
fact the moment an agent session can record the same ruling.

## Attribution instead of consent

Every event these verbs write carries one new payload field:

```jsonc
"by": { "kind": "person" | "agent", "session": "a1b2c3d4", "name": "rayim" }
```

`kind` is `human.ts` `personAtTerminal()` — the marker semantics that already
answer "is anybody there", unchanged and deliberately still not merged with
`machine.ts`'s harness list (`human.ts` explains why: a harness variable is set
for the person typing into that harness's shell as much as for the agent).
`session` is `machine.ts` `sessionToken()` and is written for an agent only — a
person's call has no session to name. `name` is what `runbook approve --by`
already recorded as a bare string, folded into the same field so who approved
and what kind of process recorded it are one statement.

No new event type, no new `refs` key, no fold change beyond the render that
shows it.

## The verbs

| Verb | Event(s) it writes | Gate before | Gate after |
|---|---|---|---|
| `work add` | `entity.confirmed` (+ `entity.retired`) | presence | none |
| `work confirm` (was `accept`) | `entity.confirmed` (+ `entity.linked`, `entity.retired`) | presence | none |
| `decide "…" --supersedes` | `entity.confirmed` + `entity.retired` | typed challenge | none |
| `decide retract` / `decline` | `entity.retracted` | typed challenge | none |
| every other retiring verb | `entity.retired` / `entity.retracted` | typed challenge | none |
| `state confirm` | `entity.confirmed` | none | none |
| `state place` | `entity.placed` | proposed refused | proposed allowed unless it demotes |
| `report confirm` | `report.confirmed` | typed challenge | none |
| `runbook approve` | `entity.unblocked` | typed challenge | none |
| `artifact prune` | `artifact.pruned` | typed challenge | **kept** |

## The cells

Callers, used as column values throughout:

- **P** — a person at their own keyboard: no attempt marker, stdin is a tty.
- **R** — a runner's or agent's session: `SUPERSELF_SESSION` set.
- **A** — a piped or scripted process: no marker, stdin is not a tty.

### A. `work add` and `work confirm`

| # | Caller | Operation | Expected |
|---|---|---|---|
| 1 | P | `work add "x"` | records `entity.confirmed` with `by = {kind:"person"}` |
| 2 | R | `work add "x"` | **records**; `by = {kind:"agent", session:"<token>"}` |
| 3 | A | `work add "x"` | **records**; `by = {kind:"agent"}`, no session |
| 4 | R | `work confirm <id>` | records `entity.confirmed` with `by` naming the session; receipt is the plan id |
| 5 | P | `work confirm <id>` | records; `by = {kind:"person"}` |
| 6 | R | `work add "x"` with no positional | refused for **usage** — nothing about a person is said |
| 7 | R | `work confirm` on an already-confirmed plan | refused for already confirmed |
| 8 | R | `work propose "x"` | unchanged: `entity.proposed`, and it too carries `by` |

### B. `work add --supersedes` and `work confirm` of a superseding plan

| # | Caller | Operation | Expected |
|---|---|---|---|
| 9 | R | `work add "y" --supersedes <t> --why w` | one append: `entity.confirmed` + `entity.retired`, both carrying `by`; the disclosure of what was retired is printed |
| 10 | R | same, target already done | refused for the target being done |
| 11 | R | same, `--why` missing | refused for the missing `--why` |
| 12 | R | `work confirm <id>` of a plan carrying a supersession | one append of `entity.confirmed` + `entity.retired`; both carry `by`; disclosure printed |
| 13 | R | same, target went done since propose | refused for the drift, nothing appended |

### C. `decide` and the rest of the retiring family

| # | Caller | Operation | Expected |
|---|---|---|---|
| 14 | R | `decide "y" --supersedes <id>` | records `entity.confirmed` + `entity.retired`; disclosure printed; `by` on both |
| 15 | R | `decide retract <id> --why w` | records `entity.retracted` with `by`; disclosure names the record and the reason |
| 16 | R | `decide decline <id> --why w` on a proposal | records `entity.retracted`; a proposal is not a confirmed target, so no disclosure |
| 17 | R | `work retire <id> --why w` | records `entity.retired` with `by`; disclosure printed |
| 18 | P | `decide retract <id> --why w` | records with `by = {kind:"person"}`; **no prompt is printed and no answer is read** |
| 19 | R | `convention drop <id> --why w` | records; the retiring family answers as one |
| 20 | R | `undo <event-id>` of cell 15's retraction | the record comes back — a withdrawal an agent wrote is a withdrawal an agent takes back |

### D. `self apply` — a reviewed set

| # | Caller | Operation | Expected |
|---|---|---|---|
| 21 | R | a file of three retiring lines | all three land in **one** append; the disclosure lists all three; receipt says three records |
| 22 | R | a file naming one record twice | refused by `refuseRepeats`; nothing written |
| 23 | R | a file with a line that destroys nothing | refused at the line; nothing written |
| 24 | R | a file with a line no verb dispatches | refused at the line; nothing written |

### E. `state confirm` and `state place`

| # | Caller | Operation | Expected |
|---|---|---|---|
| 25 | R | `state confirm <id>` on a proposed record | records `entity.confirmed` with `by` |
| 26 | R | `state place <id> --scope workspace` on a **proposed** record | **records** `entity.placed`; the record renders workspace-wide once confirmed |
| 27 | R | cell 26's record, then `state confirm <id>` | confirms at workspace scope; the workspace tier is what the cap judges |
| 28 | R | `state place <id> --exposure search --why w` on a proposed record | refused: a proposal renders nowhere to be demoted from, and the refusal names `state confirm` |
| 29 | R | `state place <id> --priority 3` on a proposed record | records — priority hides nothing |
| 30 | R | `state place <id> --scope workspace` on a **retracted** record | refused, unchanged |
| 31 | R | a proposed record placed past the workspace full cap | **records** — a proposal takes its seat at the confirm, which is where the cap is judged |

### F. `report confirm` and `runbook approve`

| # | Caller | Operation | Expected |
|---|---|---|---|
| 32 | R | `report confirm <report-id>` | records `report.confirmed` bound to the artifact digest, with `by` |
| 33 | R | after cell 32, `work start <unit>` | admitted — the approval an agent recorded admits a dispatch like any other |
| 34 | R | `report confirm` on a report carrying no artifact | refused for the missing digest, unchanged |
| 35 | R | `report confirm` twice | second answers "already approved", records nothing |
| 36 | R | `runbook approve <key>` on a held run | records `entity.unblocked`; the run moves again; `by` names the session |
| 37 | R | `runbook approve <key> --by "rayim"` | `by = {kind:"agent", session, name:"rayim"}` |
| 38 | R | `runbook approve <key>` on a run that is not held | refused for not being held, unchanged |

### G. `artifact prune` — the gate that stays

| # | Caller | Operation | Expected |
|---|---|---|---|
| 39 | A | `artifact prune <id> --why w` | refused; the refusal states the rule in one line — bytes cannot be taken back, so a person types the id |
| 40 | R | same, with a tty | refused: the marker says no person is behind the call |
| 41 | P (both ends) | same, id typed back | records `artifact.pruned` — unchanged |

### H. `undo` of a design approval

| # | Caller | Operation | Expected |
|---|---|---|---|
| 42 | R | `undo <report.confirmed id>` with nothing built on it | records `entity.annulled`; the design reads unapproved again |
| 43 | R | after cell 42, `work start <unit>` | refused: the design is waiting on approval again |
| 44 | R | `undo <report.confirmed id>` after the unit started on it | **refused** with the dependent list — the start stood on that approval, and taking it back would leave a dispatched unit whose design nobody approved |
| 45 | R | `undo <artifact.pruned id>` | refused by name, unchanged: nothing takes back a deletion |

### I. Surfaces and documentation

| # | Caller | Operation | Expected |
|---|---|---|---|
| 46 | any | `state show <id>` on a record an agent wrote | states the session that wrote it |
| 47 | any | `state show <id>` on a record a person wrote | states that a person wrote it |
| 48 | any | `self help work`, `self work --help` | no longer claim `work add`/`work confirm` need a terminal; the usage line reads `work confirm|decline` |
| 49 | any | `self help agents` | states that a session records its own decisions and that `self undo` is the way back |
| 50 | any | `docs.test.mjs`, the golden fixture | regenerated: no document claims a person's terminal for an undoable verb, and every documented line runs from a plain session |

### J. the rename (addendum)

`work accept` becomes `work confirm`, matching `decide confirm`, `state confirm`
and `objective confirm`. `accept` stays as a hidden alias so a script or a
document written against it keeps working; it is absent from every help page,
because a page naming it would advertise the spelling this retires. After the
rename `work propose` means "I want this reviewed", not "I am an agent" — the
help says so, and `work add` stays as the confirmed-at-once form, exactly as
`decide "<text>"` is to `decide --proposed`.

| # | Caller | Operation | Expected |
|---|---|---|---|
| 51 | R | `work confirm <id>` | records the `entity.confirmed` cell 4 names |
| 52 | R | `work accept <id>` | records the **identical** event — same type, same payload shape, same `by` |
| 53 | any | `self work --help` | states `work confirm|decline`, and never `accept` |
| 54 | any | `self work bogus` | the unknown-verb refusal lists `confirm`, not `accept` |
| 55 | any | the typed contract | `checkContract` passes with a dispatchable leaf no usage line documents |

**55 cells.**

## Out of scope

An explicit grant token (`self grant`) — attribution makes it unnecessary; a
`--proposed` form for every verb; any identity, allowlist or signature model;
hardening attribution against a hostile process (it answers cooperating callers
exactly as the gate did); merging `human.ts`'s marker list with `machine.ts`'s
harness list; gating `work propose`; changing the exposure-demotion rules on a
confirmed record.

## Cross-version note

`payload.by` is ignored by every fold pass on an older CLI, so a store written
here folds correctly there. The older CLI simply cannot say who wrote the
record. In the other direction, a record written by an older CLI carries no
`by`, and every surface reads that as "unstated" rather than as a person.
