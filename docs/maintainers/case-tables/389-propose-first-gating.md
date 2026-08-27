# Case table — a work unit starts as a proposal (#389)

The design artifact for #389, written before the code and approved on the
issue. Every cell below is one test, named by its cell number: cells 1-12,
14, 20-22, 38-41, 48, 56-61 and 70-72 in
`apps/cli/test/work-entry-gate.test.mjs`, cells 23-32, 42-55, 62-69 and 73 in
`apps/cli/test/work-propose-supersedes.test.mjs`. The cells this issue leaves
unchanged name the test that already proves them. The table is the review
surface: a cell the table lacks is a path nothing proves.

## The defect

`work add` records a confirmed work unit from any process, so an agent skips
the review the help already describes by never proposing. `work accept` carries
no person gate either, so the same session proposes and accepts in one breath.
The person gate this needs already exists — `human.ts`, guarding retirement,
design approval, artifact prune and runbook approval — and the front door of
work is the one confirmed record it does not guard.

## The rule, in one sentence

**A confirmed work record is written only by a process with a person at its
keyboard.** Three verbs write one — `work add`, `work add --supersedes` and
`work accept` — and those three get the gate. `work propose`, `work revise`
and `work decline` write nothing confirmed and stay open to any process.

## The gate

`human.ts` gains `personAtTerminal()`, which is
`attemptMarker() === undefined && process.stdin.isTTY === true`, and
`personRefusal()`, which mints the refusal from it. The four gates that already
read that condition inline now read it here; their own disclosure text and
typed challenges are untouched. ARCHITECTURE.md's Single gates table carries
the row.

Two decisions the cells are derived from:

1. **Presence, not confirmation.** `work add` and `work accept` print no
   challenge and read no answer, so a person keeps one command with no prompt
   — requirement 3 of the issue. Nothing is recorded about the gate's passing
   on those paths, because presence produces no artifact and a written
   `{method: "tty", challenge: ""}` would record something that did not happen.
   An acceptance that *also* displaces a record routes through the retirement
   gate, types a real challenge, and carries that `confirmation` on both the
   `entity.confirmed` and the `entity.retired` — which is the one acceptance
   whose gate is provable from the log afterwards (cell 42).
2. **stdin alone.** `stdout.isTTY` belongs to the gates that print a question.
   Reading it here would refuse a person for piping their own output (cell 5),
   and would flip every test's render mode.

**Trust boundary.** The gate answers cooperating callers, exactly as the four
shipped gates do. A process that allocates a pty and unsets the marker defeats
it, and defeats them too; #389 does not change the trust model.

## What `work propose --supersedes` records

One `entity.proposed`, with one added payload field:

```jsonc
"supersedes": { "entity": "w-old", "why": "<why the outcome moved>" }
```

No new event type, no new `refs` key, no fold change. Every existing fold pass
ignores the field; `work accept` is its one reader, and reads it back off the
creation event without trusting its shape (cell 64). At acceptance the pair is
the byte-identical `entity.confirmed` + `entity.retired {entity, why,
successor, successorProject}` that `work add --supersedes` writes today, in one
append through `recordRetirement`.

`work accept` is therefore a `retiring` leaf: it can destroy a record now.

## Maintainer rulings on the design's open questions

1. **Cell 54 is unchanged.** `work revise`'s refusal on a `work add` unit keeps
   naming `work add --supersedes`; rewriting it belongs to #390.
2. **Cell 30 refuses.** The design left superseding an unaccepted plan allowed
   because `work add --supersedes` allows it; the ruling is that a plan nobody
   accepted is corrected by restating it under its own id (#356). The refusal
   is in the shared resolver, so both spellings answer the same way.
3. **The golden fixture keeps a started, reported, done unit**: the scenario
   proposes it and the acceptance is written through `logFixture`, the
   precedent `retireFixture` set.

## The cells

### A. The gate itself — invoker × verb

| # | State | Operation | Expected |
|---|---|---|---|
| 1 | P | `work add "x"` | records `entity.confirmed`; receipt is the work id |
| 2 | A, attempt marker set, stdin **is** a tty | `work add "x"` | refused; log length unchanged |
| 3 | A, no marker, stdin not a tty (a real spawned child) | `work add "x"` | refused, naming `self work propose "x"`; log length unchanged. Also asserted end to end in `smoke.test.mjs`, where the child is the published binary |
| 4 | A, stdin not a tty, **stdout** is a tty | `work add "x"` | refused — the keyboard is what is missing |
| 5 | P, output piped | `work add "x"` | **records** — a person redirecting output is still a person |
| 6 | P | `work accept <id>` on an open plan | records `entity.confirmed`; receipt is the id; no prompt |
| 7 | A (marker) | `work accept <id>` | refused; nothing appended |
| 8 | A (no tty) | `work accept <id>` | refused, naming the plan, the project that owns it, and the line a person runs; nothing appended |
| 9 | A | `work propose "x"` | records `entity.proposed` — unchanged, ungated |
| 10 | A | `work decline <id> --why w` | records `entity.retracted` — unchanged, ungated |
| 11 | A | `work revise <id> "y" --why w` | records `entity.revised` — unchanged, ungated |
| 12 | A | `work add` with no positional | refused for **usage**, not for the person gate |

### B. `work add --supersedes` × target state × invoker

| # | State | Operation | Expected |
|---|---|---|---|
| 13 | P, target open | `work add "y" --supersedes <t> --why w` | unchanged: the retirement gate discloses, the challenge is typed, `entity.confirmed` + `entity.retired` land as one append — `supersede.test.mjs` K5 |
| 14 | P, target started | same | same as 13; a started unit is retirable |
| 15 | P, target done | same | refused for the target being done, before the person gate — `supersede.test.mjs` B1 |
| 16 | P, target retired | same | refused with the target's own reason — `supersede.test.mjs` B2 |
| 17 | P, no `--why` | same | refused by the usage refusal naming `--why` — `supersede.test.mjs` B4 |
| 18 | P, unknown target id | same | refused as an unknown work id — `supersede.test.mjs` B3 |
| 19 | P, target is another kind of record | same | refused by `requireSupersedeKind` — `supersede.test.mjs` K10, K11 |
| 20 | A, target open | same | refused, naming `work propose "y" --supersedes <t> --why w` and the target it replaces; nothing appended; the retirement gate never runs |
| 21 | A, target done | same | refused **for the target being done**, not for the person gate |
| 22 | A, `--why` missing, target open | same | refused for the missing `--why`, not for the person gate |

### C. `work propose --supersedes` at propose time

| # | State | Operation | Expected |
|---|---|---|---|
| 23 | A, target open | `work propose "y" --supersedes <t> --why w` | one `entity.proposed` carrying `payload.supersedes = {entity, why}`; **no** `entity.retired`; the target is unchanged in the listing and in `work show` |
| 24 | A, target started | same | same as 23 — the correction path the issue exists for |
| 25 | A, target done | same | refused: already done |
| 26 | A, target retired | same | refused with the target's own retirement reason |
| 27 | A, `--supersedes` without `--why` | same | refused, naming both flags together |
| 28 | A, `--why` without `--supersedes` | `work propose "y" --why w` | refused, naming `--supersedes`, in `work add`'s words |
| 29 | A, target is a decision id | same | refused by `requireSupersedeKind` |
| 30 | A, target is itself a plan awaiting review | same | **refused**, naming `work revise <id>` — the maintainer ruling above |
| 31 | A, plan text equals an open standalone plan's | same | refused by `requireNovel` |
| 32 | A, target open, plus `--objective` and the full brief | same | records the gap brief **and** `payload.supersedes`; `--supersedes` is not a brief flag |
| 73 | A, target open | receipt | carries `replaces <t> on acceptance — <t> is untouched until a person runs \`self work accept <id>\`` |

### D. `work accept` × proposal state

| # | State | Operation | Expected |
|---|---|---|---|
| 33 | P, plan open, no supersedes | `accept` | `entity.confirmed` binding the current revision; status `next` — `work-revise.test.mjs` cell 4, and cell 6 above |
| 34 | P, plan already accepted | `accept` | refused: already accepted, before the person gate — `proposal-answer.test.mjs` cell 4, and cell 39 below |
| 35 | P, plan declined | `accept` | refused: already declined — `proposal-answer.test.mjs` cell 5 |
| 36 | P, revised after accept | `accept` | binds the current revision; status `next` — `work-revise.test.mjs` cell 5 |
| 37 | P, plan not accepted | `work start` | refused by `reviewRefusal`, naming `self work accept <id>` — `work-revise.test.mjs` cell 6 |
| 38 | A, plan open | `accept` | refused; nothing appended; the plan stays in review |
| 39 | A, plan already accepted | `accept` | refused for **already accepted**, not the person gate |
| 40 | A, unknown id | `accept` | refused for the unknown id, not the person gate |
| 41 | P, cwd outside every project | `accept` | resolves through the record (#302) and records — the gate is about the process, never the directory |

### E. `work accept` of a superseding plan × target drift

| # | State | Operation | Expected |
|---|---|---|---|
| 42 | P, target still open | `accept` | the retirement gate discloses and reads the challenge; `entity.confirmed` + `entity.retired {successor}` land as **one** append; both carry the typed `confirmation`; receipt is the plan id |
| 43 | P, wrong challenge typed | `accept` | nothing appended — neither half; the plan stays open |
| 44 | P, target started since propose | `accept` | records — a started unit is retirable |
| 45 | P, target went **done** since propose | `accept` | refused, naming the drift and the revise/decline ways out; nothing appended; the plan stays open |
| 46 | P, target went **retired** since propose | `accept` | refused, naming the target's own retirement reason; nothing appended |
| 47 | P, carried target unknown in this store | `accept` | refused: no record here answers to it; nothing appended |
| 48 | A, target still open | `accept` | refused at the person gate; the retirement gate never runs; nothing appended |
| 49 | P, plan revised after propose | `revise` then `accept` | the supersession survives the revision; the acceptance retires the original target |
| 50 | P, plan carries a supersedes **and** a gap target | `accept` | three events in one append: `entity.confirmed`, `entity.linked`, `entity.retired` |

### F. `decline` and `revise` on a superseding plan

| # | State | Operation | Expected |
|---|---|---|---|
| 51 | A, plan carries a supersedes | `decline --why w` | `entity.retracted` only; the target is untouched and still open |
| 52 | A, same | `revise <id> "y" --why w` | `entity.revised` only; the carried supersession is unchanged; still awaiting review |
| 53 | P, plan declined, then the target inspected | `work show <target>` | byte-identical to before the plan existed |
| 54 | A | `work revise` on a unit created by `work add` | refused, naming `work add --supersedes <id> --why w` — #356's text, unchanged by ruling 1 |
| 55 | A, target retired by somebody else, then `decline` | `decline --why w` | records — declining never reads the target |

### G. Composition with a reviewed set and the sweep

| # | State | Operation | Expected |
|---|---|---|---|
| 56 | P, plan file with `work add "y" --supersedes <t> --why w` | `self apply` | unchanged: the line queues, one confirmation covers the set |
| 57 | A, the same file | `self apply` | refused **at the line**, with the person refusal wrapped in `apply`'s "line 1 was refused, and nothing in this file was recorded"; nothing appended |
| 58 | P, plan file with `work accept <id>` for a superseding plan | `self apply` | the accept queues and is covered by the one confirmation — `work accept` is a `retiring` leaf now |
| 59 | P, plan file with `work accept <id>` for a plan carrying no supersession | `self apply` | refused: one confirmation covers only the calls that need a person's approval |
| 60 | P, plan file with a bare `work add "y"` | `self apply` | refused the same way — unchanged from today |
| 61 | A | `self sweep --record` | records `entity.proposed` per cluster, unchanged and ungated |

### H. Fold and merge determinism

| # | State | Operation | Expected |
|---|---|---|---|
| 62 | plan carrying `payload.supersedes`, never accepted | fold | the target is untouched: still confirmed, execution open |
| 63 | the acceptance's retirement, then a second retirement of the same target merged in | fold | the first retirement stands; the second is dropped as terminal |
| 64 | `payload.supersedes` that is a string, a number, `{}` or an empty entity | `accept` | reads as absent: the plan accepts as a plain one, nothing crashes, nothing is retired |
| 65 | `payload.supersedes.entity` naming an id this store never saw | fold, then `accept` | the fold is unaffected — the plan renders and lists; the acceptance is refused (cell 47) |
| 66 | the acceptance's `entity.retired` merged in twice | fold | idempotent: one retirement, still naming the successor |
| 67 | after cell 42 | `work show --history` on both | the successor's history holds the proposal and the acceptance; the predecessor reads retired, naming the successor |

### I. Surfaces, help and receipts

| # | State | Operation | Expected |
|---|---|---|---|
| 68 | superseding plan open | `self context` | one Waiting-on-you row for the plan, carrying `self work accept <id>`, counted once. The row states the plan, not the retirement it will cause: the retirement gate discloses the target at acceptance, before anything is written, and stating it in the row would mean a second place that has to agree with the gate — recorded as a follow-up rather than done here (`views.ts` is outside this issue's touched surfaces) |
| 69 | superseding plan open | `work` listing | one row for the plan in review, one row for the target still open — each counted once |
| 70 | any | `self work --help` | `work propose` usage carries `[--supersedes <work-id> --why w]`; `work add`'s is unchanged; the option list explains what `--supersedes` does on propose |
| 71 | any | `self help work` | states the rule: both `work add` and `work accept` are a person's own commands, and a session is handed the propose line |
| 72 | any | `self help agents`, `self help work` | the session-facing pages open with `work propose`, and the correction they spell is the propose one |
| 74 | any | `docs.test.mjs`, the golden fixture | regenerated: the fixture's unit is proposed and accepted, the piped `work accept` refusal is pinned, and every documented `work add`/`work accept` line runs as the person the document describes |

**74 cells.**

## Out of scope

Gating `work decline`; the same question for `decide`, `state add`, `goal add`,
`convention add`, `objective add`, `milestone add`; any identity, allowlist or
signature model; hardening the gate against a hostile process; cross-project
supersession from a plan; changing a plan's supersede target under `work
revise`; `self undo`, compensating events and settling (all #390); undoing an
acceptance; back-filling `bornProposed`; a typed challenge on `work add` or
`work accept`; a `confirmation` payload on the paths that displace nothing.

## Cross-version note

A store written by a newer CLI folds correctly on an older one:
`payload.supersedes` is ignored by every fold pass. The older CLI simply cannot
accept the plan *with* its supersession — it accepts the plan alone and the
correction's target stays open. That is a silent semantic loss across versions,
and the one forward-compatibility wrinkle worth naming in the release note.
