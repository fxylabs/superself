# Case table — recorded friction is swept into systemization proposals (#124)

The design artifact for #124, written and reviewed before any code. #124 asks
for the design only: its acceptance is "an approved design artifact for typed
friction capture, the sweep job's inputs/bounds/schedule, and proposal output
format; implementation is a separate accepted issue." This table is that
artifact's case surface, and it is the only file #124 leaves in the repository.

The implementation lands as two follow-up issues, each inheriting its own cell
groups whole:

| Follow-up | Cells | Tests | Depends on |
|---|---|---|---|
| `self report --friction` — typed friction capture | A1–A13, D1–D6 | `apps/cli/test/report-friction.test.mjs`, `apps/cli/test/context.test.mjs` | #305 |
| `self sweep` — clustering and proposal recording | B1–B15, C1–C18 | `apps/cli/test/sweep.test.mjs` | the capture follow-up |

Every test is one cell below, named by its cell number, and asserts that cell's
stated outcome. The table is the review surface: a cell the table lacks is a
path nothing proves. **52 cells** — A13 + B15 + C18 + D6.

## The defect

Systemization candidates surface while work runs — "this is manual every
time", "the tool cannot do this" — and are caught only if a person notices in
the moment. The same pain repeats three times before anyone counts it.

The raw material already exists. Every report is required to state what
differed from expectation, and decisions and errors are in the log. The
material is unusable because it sits **inside prose**, where nothing
mechanical can collect it.

| Piece | Present today | Evidence |
|---|---|---|
| a `friction` field, flag, or payload key | **none** — zero hits across `apps/cli/src` | full-text search |
| the rule that says to write friction | present, as prose custom | `docs/guides/running-a-long-term-project.md` |
| friction actually written | present, inside report prose | `examples/2026-08-23-delegation-day/units/w-fvhq9.md` |
| a scheduler, cron, or daemon | **none**; `self daemon` is a retired verb | `smoke.test.mjs` forbids it |
| the proposal gate | present | `work propose/accept/decline/revise` |
| duplicate-proposal refusal | present | `requireNovelPlan` in `goals.ts` |
| the path that shows a proposal to a person | present | `planReviewItems` → `## Waiting on you` |

So the third piece — wiring clusters into the proposal gate — is already
built. What is missing is typed capture and the sweep that reads it.

## The rulings this design makes

| # | Question | Decision |
|---|---|---|
| R1 | What shape does typed capture take? | **A repeatable `--friction "<sentence>"` on `self report`**, stored as `payload.friction: string[]` on the existing `report.added` event. No new verb, no new event namespace |
| R2 | A classification code or free text? | **One free sentence.** What counts as friction cannot be enumerated in advance, and an enum blocks recording until the enum grows. This layer needs recall, not precision |
| R3 | Is friction required? | **No.** Requiring it makes `work done --report` a bypass and makes every existing report retroactively non-compliant. A conditional nudge in `## Health` stands in its place, and the rule lives as a project convention |
| R4 | Are CLI refusals swept too? | **No — excluded, with a separate follow-up issue.** The only interception point is `runCli`'s catch; every append refolds the project, so one typo would refold everything; refusals are noisy and machine-local. Their right home is the `ledger.ts` machine-local ledger, which is its own design |
| R5 | What about "manual-assembly traces" and "disciplines briefs re-instruct"? | **No separate detector — absorbed into the `--friction` channel.** `self` does not observe a session's tool calls and a brief is not an event, so there is no recorded input to sweep. The convention text names both cases so agents write them as friction |
| R6 | How is the sweep triggered? | **An explicit `self sweep` verb. No timer.** A person or an external cron runs it. The CLI grows no scheduler and no daemon |
| R7 | Does the sweep write by default? | **No — preview is the default**, `--record` writes. Auto-generating proposals is not a default side effect |
| R8 | Who judges whether a cluster is one real problem? | **The reading agent and then the person.** The CLI clusters deterministically and calls no model |

## Rules the cells are derived from

1. **Friction rides the report it belongs to.** Friction is always about some
   work, and a report already names that work. A separate verb would take the
   work id again, record at a different moment, and break the habit of writing
   it while reporting.
2. **No sibling event namespace.** `ARCHITECTURE.md` fixes that a new event
   extends an owned namespace rather than adding a sibling for the same
   concern. Friction is part of a report, so it is a payload key on
   `report.added` — not `friction.*`.
3. **The sweep is not folded into the fold.** A fold is a pure derivation from
   the log; writing events inside one would make a fold cause a fold. The
   sweep reads and writes, so it is its own verb — never a side effect of
   `self fold` or of `self context`, which is a read command whose piped
   output is a contract.
4. **Clustering is deterministic.** Normalize with the existing `normalize`
   in `goals.ts` (NFC, lower case, Unicode letter/number classes), drop stop
   words, and cluster on a token-overlap (Jaccard) ratio of **0.5 or more**.
   A cluster of **3 or more** is a proposal candidate — the issue's own
   account of pain counted only at its third occurrence. A lone `예상대로` /
   `as expected` sentence is excluded from candidates.
5. **Thresholds are constants, not flags.** 0.5 and 3 are declared at the top
   of `sweep.ts` with their reasoning. Tuning knobs are not the user's job.
6. **The proposal text carries no count.** `normalize` keeps digits (`\p{N}`),
   so `(4 reports)` and `(5 reports)` are different dedupe keys and the same
   problem would be re-proposed the night after one more report lands. The
   text is one line — the representative sentence — and the count is told by
   the preview and by the length of `refs.friction`.
7. **The representative is the oldest item in the cluster** (by `ts`, then
   event id ascending), so a growing cluster does not rewrite its own text.
8. **Evidence overlap is the first dedupe layer.** If any open proposal
   already cites one of this cluster's `report.added` ids in `refs.friction`,
   the cluster has already been asked about. This holds however the text
   drifts — including when the window rolls past the representative.
9. **The condition and the refusal are separate functions.** `clashingPlan`
   is exported and answers *which* open plan proposal already carries this
   key; `requireNovelPlan` calls it and throws, unchanged in behavior and
   wording. The sweep calls the condition only, so one clashing cluster skips
   itself instead of aborting the command. Neither `try/catch` around a gate
   nor a local re-check of the gate's condition is used — the second is what
   `ARCHITECTURE.md` forbids, and the first turns a gate's future refusals
   into silent skips.
10. **A declined proposal does not block re-proposal.** Both dedupe layers
    look only at open proposals. Friction that keeps recurring should keep
    being asked about; that is the issue's stated intent.
11. **N clusters are one append and one fold.** `recordEvents` writes them
    together, because every append refolds the project.
12. **The nudge is project-scoped; the sweep is workspace-scoped.** The nudge
    is computed in `deriveSignals` for one project; the sweep reads
    `workspaceModels` across active projects. Both say "last 30 days", so the
    nudge wording starts with "this project's" and the sweep's header states
    how many projects it read.
13. **A proposal records into the project the command runs in.** Write verbs
    take no scope flag, even when a cluster's evidence spans projects.
14. **Existing gates cover the new text.** Home absolute paths and secrets in
    a friction sentence are refused by `assertSanitized` at the append gate;
    no new check is added.

## The cells

State variables: **whether friction was recorded** × **how the sweep was run**
× **whether a matching proposal already exists**.

### Group A — capture

| # | State | Operation | Expected |
|---|---|---|---|
| A1 | a work unit exists | `report <id> "<summary>"` | recorded; **no** `payload.friction` key — unchanged behavior |
| A2 | same | `report <id> "<summary>" --friction "A"` | `payload.friction` is `["A"]` |
| A3 | same | `--friction "A" --friction "B"` | `payload.friction` is `["A","B"]`, order preserved |
| A4 | same | `--friction ""` | refused, and the refusal says what to write |
| A5 | same | `--friction "   "` | whitespace-only is refused as A4 |
| A6 | same | `--friction "예상대로"` | recorded normally; excluded at sweep time only, never at capture |
| A7 | a report carrying friction | `work show <id>` | the friction line is shown |
| A8 | same | `handoff <id>` | the handoff packet carries the friction |
| A9 | same | `log` | the report event prints as one line, not raw JSON |
| A10 | same | fold | `work/<id>.md` carries the friction line |
| A11 | a friction sentence containing a home absolute path | `report … --friction "/Users/x/…"` | refused by the existing `assertSanitized` gate; the refusal names the friction flag |
| A12 | a store whose reports all predate the flag | fold | folds with `friction: []`; no error |
| A13 | — | `work done <id> --report "<text>"` | `report.added` is recorded with no friction — a **known gap**, not a bypass; the nudge counts it |

### Group B — sweep, preview

| # | Friction recorded | Operation | Expected |
|---|---|---|---|
| B1 | none | `sweep` | says the window holds no friction; not an error, exit 0 |
| B2 | 1 | `sweep` | 0 clusters (below the threshold of 3); reports what it collected |
| B3 | 3, all different | `sweep` | 0 clusters — no overlap |
| B4 | 3, near-identical | `sweep` | 1 cluster, showing its 3 evidence report ids |
| B5 | 5, identical | `sweep` | 1 cluster, 5 pieces of evidence |
| B6 | 3 identical plus 3 other identical | `sweep` | 2 clusters |
| B7 | 5 × `예상대로` | `sweep` | 0 clusters — the exclusion rule |
| B8 | 2 in each of two projects, same sentence | `sweep` | 1 cluster whose evidence spans both projects |
| B9 | 3, all outside the window | `sweep` | 0 clusters |
| B10 | 3, two inside the window and one outside | `sweep` | 0 clusters — two is below the threshold |
| B11 | 3 identical | `sweep --since 1d` | narrowing the window gives 0 clusters |
| B12 | 3 identical | `sweep --since <malformed>` | the value format is refused, with an example |
| B13 | 3 identical | `sweep` run twice | identical output both times; **nothing is recorded** |
| B14 | no registered project | `sweep` | says there is no project; not an exception |
| B15 | friction only in an archived project | `sweep` | excluded — the sweep reads active projects |

### Group C — sweep, recording

| # | Clusters | Existing proposal | Operation | Expected |
|---|---|---|---|---|
| C1 | 1 | none | `sweep --record` | one `entity.proposed`, a short `w-` id; **the proposal text contains no digit** |
| C2 | 1 | none | `context` after C1 | one `## Waiting on you` row carrying `self work accept <id>` |
| C3 | 1 | none | `work accept <id>` after C1 | becomes a unit through the unchanged acceptance path |
| C4 | 1 | none | `work decline <id> --why w` after C1 | declined |
| C5 | 1 | **the same text is open** | `sweep --record` | that cluster is skipped — `clashingPlan` finds it and the sweep filters; nothing throws. **exit 0**, and the output says what was skipped |
| C6 | 1 | the same text was declined earlier | `sweep --record` | proposed again — intended: a declined proposal is not open, so neither dedupe layer holds it back |
| C7 | 2 | **one of them is open** | `sweep --record` | only the new one is recorded. **exit 0** — the first clash does not block the rest |
| C8 | 0 | — | `sweep --record` | records nothing; exit 0 |
| C9 | 1 | none | `sweep --record` twice in a row | the second is skipped by C5; one proposal in total |
| C10 | 1 | none | `log` after `sweep --record` | one `entity.proposed` line |
| C11 | 1 | none | `search "<proposal text>"` after C1 | the proposal is found — it is a live record |
| C12 | 1 | none | inspect the proposal's `refs.friction` after C1 | the array of `report.added` event ids that were its evidence |
| C13 | 1 | none | `--record` inside an archived project | refused by the append gate (#283) |
| C14 | evidence spans projects | none | `sweep --record` | the proposal records into **the project of the current directory**; write verbs take no scope flag |
| C15 | 3 | none | `sweep --record` | three `entity.proposed` events in **one append**, one fold |
| C16 | 1 (3 pieces of evidence) | none | `--record` again the next day after one more piece of evidence lands | **not re-proposed** — evidence overlap holds, whether or not the text or the representative changed |
| C17 | — | — | `sweep --record` in an unregistered directory | refused, naming what to do (`self project add`, or run inside a registered directory); not an exception |
| C18 | 1 | none | `search --history <id>` using an id from `refs.friction` | the evidence report is actually reachable — the reader's path is unbroken |

### Group D — the nudge

| # | State | Operation | Expected |
|---|---|---|---|
| D1 | 0 reports in the window | `context` | no nudge line |
| D2 | 4 reports, all carrying friction | `context` | no nudge line |
| D3 | 4 reports, 3 without friction | `context` | one nudge line in `## Health` |
| D4 | 4 reports, 2 without friction | `context` | no nudge — not more than half |
| D5 | the D3 state | `context`, piped | the nudge fits the budget, and if it is cut the elision is stated |
| D6 | project X at 100% friction, project Y at 0% | `context` in each | no nudge in X, a nudge in Y. The nudge is **project-scoped** (`deriveSignals`) while the sweep is workspace-scoped (`workspaceModels`); neither wording may read as the other's number |

## Out of scope

Capturing CLI refusals — excluded here and left to its own issue on the
machine-local ledger pattern. A separate detector for manual-assembly traces
or for disciplines that briefs re-instruct — there is no recorded input for
one; both are absorbed through `--friction` and named by the convention text.
Any scheduler, daemon, or automatic run. Any model call or semantic judgment
inside the CLI. Requiring friction on `work done --report`. Exposing the
clustering thresholds as flags. An enum or taxonomy for friction. Routing a
proposal to a project other than the one the command runs in. Silencing a
declined proposal for N days.
