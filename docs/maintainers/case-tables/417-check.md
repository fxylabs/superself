# Case table — the read-only direction check (#417, PR c of 3)

Written before the code, and the review surface for it: a cell this table lacks
is a path nothing proves. Every test in `apps/cli/test/objective-check.test.mjs`
is one cell below, named by its cell number. Cells that belong to another file
say which file.

This is part (c) of the three-part delivery the approved #417 design v2.1
sequences. Part (a) shipped the link model — standalone dispositions, assumed
decisions, operational run links — as #452; part (b) shipped what a revision
carries, the target-open guards, the proposal retarget, the date ordering rule
and the objective identity a coverage judgment was made under, as #456. Both
are on `origin/main` and this branch is based on them. Part (c) ships one
command — `self objective check` — the seven findings it states, the foreign
availability notices, the evidence candidates, the health summary `self status`
and `self context` carry, and the guidance for all of it on the three entry
routes.

It ships no new way to record anything. Every command it prints is one part (a)
or part (b) already dispatches.

## The defect this part answers

Issue #417 records four observed graph inconsistencies. Parts (a) and (b)
answered what the store could not *say*; this part answers what nobody could
*ask*:

| Observed | What no command would answer |
|---|---|
| Work stayed on a superseded milestone | Nothing listed the live units whose every current contribution points at an outcome that is over |
| A successor checkpoint had no work while its predecessor still had live work | Nothing compared the two sides of a supersession |
| Recurring maintenance became a product checkpoint dated past its objective | Nothing read the two dates back out of a store that already held them, and nothing asked whether a checkpoint's whole live workload was operational |
| Completed work was not reconciled with successor criteria | Nothing offered the done units that could be cited as evidence for an uncovered criterion — while never citing one on anybody's behalf |

Part (b) refuses the *creation* of three of these. It reconciles none of the
stores that already hold them, and the design forbids automatic cleanup. A
read-only check is what is left.

## The rulings this implements

| # | Question | Decision |
|---|---|---|
| R1 | Where does the projection live? | **`apps/cli/src/check.ts`, in the render layer**, beside the other projections of a folded model. It cannot live in `@superself/fold`: finding 6 reads which records answer as a runbook run, and that derivation is `apps/cli/src/runbooks.ts` — a CLI-owned reading of the entity grammar, which ARCHITECTURE.md keeps out of the package on purpose. Purity is asserted from the source instead, by cell 41 |
| R2 | What does it take, and what may it read? | **`checkDirection(project, available)`** — the owning project's fold and the folds of the registered projects this machine could read. Nothing else: no store directory, no clock, no network, no log. It reads only log-determined fields; `MilestoneState.state` is not one of them, because `missed` and `at-risk` are what `today` decides |
| R3 | What is a closed target, without a clock? | **`milestoneClosure` in `@superself/fold` `objectives.ts`** — reached, superseded, dropped, or hanging under an objective that is dropped or superseded. It is extracted out of `milestoneState`, which now calls it, so the check and the milestone page cannot disagree. An objective is open when `openObjectives` holds it, which is the reader that already existed |
| R4 | How many finding kinds are there? | **Seven, fixed**, one per bullet of design §6, in three classes: structural inconsistency (1, 2, 3, 6) — commands repair the relationship; review-needed (4, 7) — a person rejudges the meaning; evidence candidate (5) — information only. A kind is added by a design decision, never by an implementation |
| R5 | What does an unavailable target project do? | **It suppresses the finding and states a notice instead.** A unit whose contributions cannot all be resolved is never reported as "every outcome it contributes to is closed" — uncertainty is not a verdict. The notice names the record, the qualified target and the reason, and the header counts it apart from the findings |
| R6 | What is the total order? | **Qualified objective, then qualified record, then finding kind, then the finding's own stable detail.** An explicit unassigned group sorts after every named objective. Every comparison is codepoint order on strings — never `localeCompare`, whose answer depends on the machine's locale, which is exactly what the determinism guarantee forbids |
| R7 | Which commands may a finding print? | **Only ones this branch dispatches, and only ones that change the condition the finding states.** A prose decision is never offered as clearing a structural finding: recording a decision changes no edge, no date and no criterion. Where nothing repairs a review signal — finding 7 asks a question about intent — the finding prints the reading command and no repair at all |
| R8 | What is operational? | **An inbound `relates` edge from a runbook run**, which is what `self runbook link <run> --work <id>` writes and part (a) documented. Never a label, a date, or a word in the text. An objective with no live milestone work does not trigger finding 7 — an empty set is not "all operational" |
| R9 | What may a candidate say? | **That a done unit exists and a criterion is open.** It never pairs the two: no text matching, no automatic coverage, and a unit a claim on that checkpoint already cites is left out. The unit's own criteria are not evidence for the checkpoint's |
| R10 | Where does the summary go? | **One line on `self status` and one on `self context`**, stating the count and the command, and disclosing unchecked targets when there are any. A run with findings never reads as `ok`, and neither does a run with nothing found but a target it could not read |

## Rules the cells are derived from

1. **The check never writes.** No event, no file, no log line — not even the
   `notice` a lower layer prints. Cell 40 asserts the store is byte-identical
   after a run; cell 41 asserts the module's source reaches no machine at all.
2. **Only live records are drift subjects.** A closed objective, a reached
   checkpoint and a retired unit are history, and history is not drift. Done
   work appears in exactly one place: as an evidence candidate.
3. **Uncertainty is never an all-clear.** Where a contribution's target cannot
   be read, the answer says so and the summary counts it. Silence would be the
   one wrong answer this command must never give.
4. **The same logs answer the same way.** Same events, any merge order, any
   machine, any hour. Sorting is total and locale-free, and no rule reads
   `today`.
5. **Every advertised command is dispatchable and relevant.** Each one is
   resolved against the typed contract, and each one is run in a cell that
   asserts the finding it was printed under is gone afterwards.
6. **Nothing is inferred from prose.** Not a maintenance classification, not a
   criterion's evidence, not an assumption. Every classification this check
   makes is read off an explicit edge somebody recorded.
7. **A missing date is not a failure.** Either date absent means the ordering
   was not checked; the check states no finding and invents no ordering.

## Narrow contract

**Behavior.** One new read verb, `self objective check [--project <slug>]
[--json]`, and one summary line on two existing read surfaces. It answers with
findings, notices and a header, and changes nothing.

**Production surfaces.**

| Surface | What changes |
|---|---|
| `apps/fold/src/objectives.ts` | `milestoneClosure` extracted out of `milestoneState`; `exitStanding` extracted out of `deriveMilestone`; `carriedJudgments` exported — three readings the check and the existing derivation now share rather than compute twice |
| `apps/cli/src/check.ts` | new. The projection: `checkDirection`, the seven findings, the notices, the summary, the total order |
| `apps/cli/src/goals.ts` | the `objective check` leaf, its handler and its plain render |
| `apps/cli/src/views.ts` | the direction summary on `self status` and `self context`, folded from the reads those pages already pay for |
| `apps/cli/src/pretty.ts` | the summary's place in the two terminal renders |
| `apps/cli/src/main.ts` | the `objective` usage line and flag glossary for `check` |
| `apps/cli/src/guide.ts` | `self help goals` and `self help work` |
| `apps/cli/src/connect.ts` | the managed block's check and recovery lines |
| `apps/dsh-plugin/src/tools.ts`, `apps/dsh-plugin/README.md` | the plugin's entry guidance, pointing at a CLI command it does not expose as a tool |
| `docs/reference/cli.md` | the `objective check` entry in the outcome-and-work section |
| `ARCHITECTURE.md` | `check.ts` named in the render layer |

**Valid inputs.** The owning project's fold, and the folds of the active
registered projects this machine can read. Ids are whatever those folds
resolve. Dates are the `YYYY-MM-DD` values the typed date argument already
admits. Nothing else is an input — in particular, not the clock, not git, not
the network, and not a project's own store directory.

**Trust boundary.** Unchanged and narrower than part (b)'s: this branch adds no
writer at all. Every value out of a log is read through the same defensive
guards the rest of the fold uses, and an id that resolves nowhere reads as
unavailable rather than crashing the projection.

**Exclusions.** Out of scope, and not to be advertised by this branch:

- A general audit. Seven finding kinds, fixed by the design; a malformed-store
  audit, a lint of record text, and a check of anything outside the direction
  graph are all somebody else's command.
- Routine records and scheduling (#451), prose classification, strategy
  scoring, progress percentages, automatic cleanup of existing stores,
  objective-level assumptions, a viewer redesign.
- Any repair. The check runs no command it prints, and no flag makes it.
- Dormant hooks for future findings: no severity dial, no filter flags, no
  configuration, no plugin surface for a kind that does not exist yet.
- Korean reader-facing copy. The English guidance is revised in place.

**Stop condition.** Stop when the cells below pass, `pnpm build`,
`pnpm typecheck`, `pnpm structure` and `pnpm smoke` pass, and the suites this
branch touches pass locally. The full tier is CI's `verify` job. No further
review rounds are opened from this branch.

## Variables resolved outside the arguments

| Variable | Resolved from | Why it matters to a cell |
|---|---|---|
| the project the check answers for | the working directory, or `--project <slug>` through `readScopes` | cells 33–34 |
| which target projects are available | `workspaceModels`, which folds every active registered project | cells 25–28: an archived, unregistered or unreadable project is simply absent, and that absence is the notice |
| a target's closure | `milestoneClosure` and `openObjectives`, over the supplied folds | cells 1–6 |
| what is operational | inbound `relates` edges from runbook runs in the owning fold | cells 20–24 |
| today | not read at all by any rule here | cell 39 |

## 1 — finding 1: every contribution points at an outcome that is over

| # | Case | Outcome |
|---|---|---|
| 1 | live work whose only contribution is a superseded milestone | one structural finding naming the unit and the closed checkpoint, and printing the relink to the open terminal successor, the unlink, and the retire |
| 2 | the same unit also contributing to one open objective | no finding: one live contribution is enough, and the check never asks a unit to tidy the rest |
| 3 | live work whose only contribution is a reached milestone | a finding — reached is closed, exactly as the part (b) guard reads it |
| 4 | live work whose only contribution is a live checkpoint under a dropped objective | a finding: the checkpoint is closed because its objective is |
| 5 | a done unit whose only contribution is a superseded milestone | no finding of this kind: only live records are drift subjects |
| 6 | a lineage that ends closed — the successor was reached | the finding prints no relink; it names the standalone declaration and the retire, so no advertised command leads to a second refusal |
| 53 | live work whose current contributions are two closed outcomes — a dropped objective and a dropped milestone — named in the summary in the same stable order as the printed unlinks | one `self work unlink` per closed target; running every printed unlink and then declaring standalone reaches a reconciled state in one pass: the finding and any `no-disposition` finding are both gone, and the unit was never retired |

## 2 — finding 2: an empty successor beside a predecessor that still has work

| # | Case | Outcome |
|---|---|---|
| 7 | a successor checkpoint with no live linked work, whose predecessor holds two live units | one structural finding naming both checkpoints and the units still on the predecessor |
| 8 | the same pair after `self work link <unit> --milestone <successor>` for each unit | the finding is gone |
| 9 | a successor that already carries live work | no finding — which is the state `milestone revise` leaves behind |
| 10 | a successor whose predecessor holds only done and retired work | no finding: there is nothing live to carry |
| 11 | the commands the cell-7 finding prints | the relink, a successor-work proposal, and `self milestone drop <successor> --why` — and no `self decide`, because recording a decision moves no edge |

## 3 — finding 3: a checkpoint dated past its objective

| # | Case | Outcome |
|---|---|---|
| 12 | a live checkpoint dated after its live objective | one structural finding naming both dates and both revise commands |
| 13 | equal dates | no finding — equal passes, as it does at the guard |
| 14 | the checkpoint has no date, or the objective has none | no finding and no ordering claim; the check states the pair was not compared rather than inventing a failure |
| 15 | `self milestone revise <m> --target <earlier> --why w` after cell 12 | the finding is gone |
| 16 | a closed checkpoint dated past its objective | no finding: history is not drift |

## 4 — finding 4: a judgment or an assumption made somewhere else

| # | Case | Outcome |
|---|---|---|
| 17 | a checkpoint an `objective revise` carried, with coverage judged under the former parent | one review finding per affected criterion, naming the objective it was judged under, printing `self milestone recheck <m> --criterion cN --why w` |
| 18 | the recheck from cell 17, run verbatim | that criterion's finding is gone; a second criterion nobody rechecked still has its own |
| 19 | a checkpoint that assumes a decision that was later superseded | one review finding naming both decisions, printing the link to the successor and then the unlink of the old one — two statements, in that order |
| 20 | a checkpoint that assumes a decision that was retracted with no successor | the finding prints the unlink alone and invents no successor command |

## 5 — finding 5: evidence candidates

| # | Case | Outcome |
|---|---|---|
| 21 | a done unit with report evidence, linked to a live checkpoint with an uncovered criterion | one candidate naming the unit and the open criteria, printing the `milestone met` template with a literal `cN` — the check pairs nothing |
| 22 | the same unit after a claim on that checkpoint cites it with `--work` | no candidate: a unit already cited is not offered again |
| 23 | a done unit whose own declared criteria are covered, under a checkpoint with none open | no candidate — the unit's own criteria are not the checkpoint's evidence |
| 24 | a done unit carrying no report at all | no candidate: there is nothing to cite |

## 6 — finding 6: no disposition, and finding 7: an all-operational objective

| # | Case | Outcome |
|---|---|---|
| 25 | live work with no contribution, no standalone declaration and no run link | one structural finding in the explicit unassigned group, printing the link, the standalone declaration and the retire |
| 26 | the same unit after `self work link <id> --standalone --why "<reason>"` | the finding is gone |
| 27 | live work an `entity.linked` `relates` edge from a runbook run names | no finding: that is the operational disposition part (a) documented |
| 28 | a unit whose text says "rotation" and carries no edge at all | a finding — the classification is the edge, never the wording |
| 29 | an objective whose live checkpoint work is two units, both named by runbook runs | one review finding asking whether the maintenance was meant as a product checkpoint, printing the reading command and no repair |
| 30 | the same objective with one of the two units not named by any run | no finding: the set is not all operational |
| 31 | an objective with no live checkpoint work at all | no finding: an empty set never triggers it |

## 7 — foreign targets, availability and determinism

| # | Case | Outcome |
|---|---|---|
| 32 | a unit whose only contribution is a foreign objective in a project this machine holds, and that objective is closed there | a finding of kind 1, naming the objective qualified by its owning slug |
| 33 | the same unit where the owning project is not registered on this machine | no finding, one notice — `target state not checked` — and the header counts it |
| 34 | the same unit where the owning project is registered and archived | the same notice: an archived project is out of the workspace answer, and the check does not reach past that |
| 35 | a project with nothing wrong and one unreadable foreign target | the header does not read `no findings`: it states zero findings and one unchecked target |
| 36 | the same log, events reordered, folded on a second scratch machine | identical findings — the determinism cell. Run twice: once over the stranded fixture, and once over a checkpoint whose criteria were covered, carried and then rechecked, which is the pair the part (b) review named as the one part (c) had to verify. It holds because `entities.ts` `ordered` already reads coverage claims in `(ts, event id)` order rather than in file order; this branch adds the proof, not the ordering |
| 37 | two findings on one record differing only in kind | ordered by the design's own finding numbering, not alphabetically |
| 38 | findings on a named objective and findings with none | every named objective's findings first, in qualified-id order, then the explicit unassigned group |
| 39 | the same store read at two very different clocks | identical output — no rule reads `today` |

## 8 — the projection stays read-only

| # | Case | Outcome |
|---|---|---|
| 40 | the store's files before and after `self objective check`, and after `--json` | byte-identical, log and pending queue alike |
| 41 | `apps/cli/src/check.ts` read as source | reaches no machine: no `node:` import, no `process`, no `Date`, no `Math.random` — the same five rules `apps/fold/test/purity.test.mjs` holds the package to |
| 42 | `self objective check --json` | one object on stdout and nothing else; the same findings the plain render states |
| 43 | `self objective check` in a project with nothing to say | `no findings`, exit 0 |

## 9 — the health summary

| # | Case | Outcome |
|---|---|---|
| 44 | `self status` in a project with findings | one line stating the count and `self objective check`, and the objective roll-up beside it unchanged |
| 45 | `self context` in the same project | the same line, in the page's head, where the render budget cannot cut it |
| 46 | `self status` with zero findings and one unchecked target | the line says so rather than `ok` |
| 47 | `self status` with nothing found and nothing unchecked | the line reads `ok` |

## 10 — one guidance contract, part (c)

| # | Case | Outcome | File |
|---|---|---|---|
| 48 | `self objective --help` | states `check`, its two flags, and why it offers no `--workspace` form | |
| 49 | `self help goals` and `self help work` | both name the check, what it will not do, and the recovery it prints | |
| 50 | the managed block `connect.ts` writes | names the check and the recovery route in the same words the CLI pages use | |
| 51 | the plugin's guidance — `superselfTools` descriptions and `README.md` | names the check as a terminal command and implies no tool for it | |
| 52 | every `self` command any of the three entry routes names | is dispatchable on this branch, and every route names the check as a command rather than only in prose — the parity proof, part (c)'s form of cell 53 of the part (b) table | |
| R4 | `FINDING_KINDS` | seven kinds and no more, in the design's own order | |
| 53 | `docs/reference/cli.md` | names `objective check` and no flag the parser refuses | `docs.test.mjs` (existing) |
| 54 | `checkContract(COMMANDS)` | still empty: the new leaf is declared, glossed and reachable | `contract.test.mjs` (existing) |
| 55 | a piped `self status` keeps its roll-up lines in order, with `direction:` among them | the pinned line order is updated, not loosened | `render-gate-documents.test.mjs` (existing) |
| 57 | the pre-cutover store's `context` and `status` captures | rebaselined by exactly the one direction line each, every other capture byte-identical — and both read `ok`, so the check states no finding against a legacy log | `integrity.test.mjs` (existing) |
| 56 | the committed golden fixture | regenerated: `self status`, `self context`, the root usage page and `self help work` all print one more thing, which is the intended outcome | `golden.test.mjs` (existing) |

Cell 54 of
[`417-guards-carry.md`](417-guards-carry.md) — "no entry route advertises the
check part (c) has not shipped" — is retired by this branch, because part (c)
has shipped it. Its test is removed from `guards-carry.test.mjs` and cell 52
above is what replaces it: the parity proof now resolves `self objective check`
against the contract rather than asserting nobody mentions it.

## 11 — the issue's own verification table

Issue #417's rows 1–10, against the cells that answer them. Rows 8 and 9 are
corrected where the reachable path differs from the issue's wording: the issue
asks for a "maintenance-work route", which on this branch is the runbook run
link part (a) shipped, and for "MCP guidance", which is the plugin's entry
guidance rather than an MCP tool the plugin does not expose.

| Issue row | Cells |
|---|---|
| 1 — a correct graph reports nothing | 43, 47 |
| 2 — work linked only to a superseded milestone | 1, 6 |
| 3 — an empty successor beside a live predecessor | 7, 8, 11 |
| 4 — a checkpoint dated past its objective | 12, 15 |
| 5 — a stale parent revision or a superseded decision | 17, 18, 19, 20 |
| 6 — candidates, never coverage | 21, 22, 23 |
| 7 — standalone or operational work is not warned about | 27, 26 |
| 8 — maintenance on the product path, classified by edge and not by prose | 28, 29, 30, 31 |
| 9 — the three entry routes agree | 48, 49, 50, 51, 52 |
| 10 — replayed offline, merged either way, on two machines | 36, 39, 40 |
