# Direction check guidance quality review

- Brief: docs/content-plans/direction-check.en.md
- Brief revision: v0.1
- Content file: apps/cli/src/goals.ts
- Content file: apps/cli/src/guide.ts
- Content file: apps/cli/src/connect.ts
- Content file: apps/cli/src/check.ts
- Content file: apps/dsh-plugin/src/tools.ts
- Content file: apps/dsh-plugin/README.md
- Content file: docs/reference/cli.md
- Content SHA-256: 8be714dbf31bddaafeca9aa5f97b7b3cc27145a44ee94304f14eb6ff31d8d72d
- Author: the implementing agent on branch `feat/417-objective-check`, and for
  the F1 correction the fix agent `fix-457-multi-unlink` on `superself-dev`
- Reviewer: the independent review agent `review-457` on `superself-dev`, which
  neither wrote nor amended any of the seven content files; the F1 follow-up
  was reviewed by `review-457-f1` on `superself-dev`, which wrote no content
  file either and authored only this receipt
- Reviewed at: 2026-09-05
- Reviewed commit: 4ace65a49ac5c35ce597c3e40a9d574663ed57a3, the F1 correction.
  The original review read the same seven files at
  594eedbb785de6b4410d63fd5f3b723d31995df1, whose content bytes are identical
  to those at c5b72cab50f01c053c7531bf20b2bc291cf4eb37 — the head the follow-up
  reviewer diffed the correction against
- Verdict: ready

**Ready. The one finding that blocked publication is fixed and the fix was
verified independently.** This receipt records two rounds. In the first, a
reviewer distinct from the author read all seven content files at `594eedb`,
ran the command and the commands it prints against scratch workspaces, ruled
the two questions the author left open, and returned `revise` for a single
reachable overstatement in two of the routes — F1. In the second, a follow-up
reviewer distinct from both the implementing author and the fix author read the
correction at `4ace65a`, reproduced the failure against the pre-fix build and
the pass against the shipped one, and resolved F1. Both rounds' evidence is
kept below: F1's original reproduction stands as the record of what was wrong,
and its resolution states what was checked. Nothing else found in either round
blocks publication.

`apps/cli/src/check.ts` is in the digest because the sentences the command
prints are reader-facing content: the finding summaries and the recovery
commands are what a reader acts on, and reviewing the help pages without them
would review a description of the answer rather than the answer.

The digest above is reproduced from the repository root with:

```
python3 .agents/skills/content-quality-gate/scripts/verify_review_record.py \
  digest --root . apps/cli/src/goals.ts apps/cli/src/guide.ts \
  apps/cli/src/connect.ts apps/cli/src/check.ts \
  apps/dsh-plugin/src/tools.ts apps/dsh-plugin/README.md docs/reference/cli.md
```

The whole receipt is checked, digest included, with:

```
python3 .agents/skills/content-quality-gate/scripts/verify_review_record.py \
  verify --root . docs/content-reviews/direction-check.en.md
```

Both reviewers ran both commands. The digest above is the one that reproduces
at `4ace65a`; the digest the first round recorded,
`32ac08fd5ad452ebdcd329e998146b0724a44e7fcf2a5d2793dd0fe23831d450`, was correct
for `594eedb` and went stale when the F1 correction changed three of the seven
files. The verifier accepts this receipt at the `ready` verdict.

## Review scope

The reader outcome is that an agent arriving at a project whose direction graph
somebody else changed can find out whether what `self context` prints can be
acted on, and — when it cannot — which single supported command answers the
finding in front of them. The same answer has to be reachable through the CLI
pages, the managed block, or the plugin's guidance.

The reviewed surfaces are the seven content files above. The supported path is
reading one entry route, running `self objective check` against a local
workspace store, and running the commands its findings print.

The trust boundary is narrower than part (b)'s: this branch adds no writer at
all. `self objective check` appends nothing, writes no file, and reaches no
network; every command it *prints* is an existing part (a) or part (b) append
into the project the caller is in. The reviewer confirmed this independently
rather than accepting it: a store snapshot taken before and after a plain run
and a `--json` run is byte-identical (cell 40), and `check.ts` holds no import
of a writer, of `node:`, of `process`, of `Date` or of `Math.random` (cell 41).

This review excludes Korean copy, marketing narrative, tutorials, and
everything the brief's exclusions list. It does **not** exclude the code
correctness of the seven findings where a finding's own printed sentence is the
content under review: F1 below is a copy claim falsified by running the copy's
own instruction, and the reviewer treated the run as the evidence rather than
deferring to the case table.

## Claims and evidence

Each claim below is one a reader is entitled to act on. Every row was checked
by the reviewer against the source record and against a live run at the
reviewed commit. The third column states what the reviewer observed, not what
the author reported.

| Claim the copy makes | Where the code says it | Reviewer's observation |
| --- | --- | --- |
| The check reads and changes nothing | `objectiveCheck` in `goals.ts` returns a `payload` block and appends nothing; `check.ts` imports no writer | Confirmed. Cells 40 and 41 pass, and the reviewer read `check.ts` end to end for a reachable write and found none |
| It states seven kinds and no more | `FINDING_KINDS` in `check.ts` | Confirmed; cell R4 pins the list and its length, and no other kind is constructed anywhere in the module |
| Work whose every current contribution is over is named, with the relink and an unlink per closed target | `unitFinding`/`obsoleteFinding` | Confirmed for the naming and for the relink suppression where the lineage ends closed. The unlink the same finding prints was **F1**, and is confirmed at `4ace65a`: `obsoleteFinding` maps every closed target to its own unlink, in the one sorted order the summary is also built from |
| A successor with no live work is named beside the units still on its predecessor | `successorFinding` | Confirmed. No `self decide` is offered, which is the design's rule that a prose decision may not be advertised as clearing a structural condition |
| A checkpoint dated past its objective names both dates and both revisions | `dateFinding` | Confirmed by an independent run. The reviewer reached the condition the only way this branch leaves reachable — part (b) refuses creating such a checkpoint, so the objective's date has to move under it afterwards — and then ran the **objective** revise the finding prints, which the committed cells do not exercise: the finding was gone |
| A missing date is not an ordering failure | `dateFinding` returns early when either date is absent | Confirmed, both directions |
| A judgment made under a former parent is one to review, and the recheck settles it | `judgmentFindings`, over `carriedJudgments` in the fold | Confirmed; one criterion at a time, the unrechecked criterion surviving |
| An assumption on a replaced decision offers the link then the unlink, and invents no successor where there is none | `assumptionCommands` | Confirmed by an independent run: both printed lines run verbatim, in the printed order, and the finding is gone |
| A candidate is information, and nothing is paired to a criterion | `milestoneCandidates` emits a literal `cN` | Confirmed, along with the three suppressions — a unit a claim already cites via `--work`, a checkpoint with nothing open, and a unit carrying no report |
| Maintenance is read off the run link and never out of a record's text | `operationalUnits` reads `relates` edges from runbook runs | Confirmed. The classification is the edge; a unit whose text reads as maintenance and carries no edge is still reported |
| An objective whose whole live workload is runbook occurrences asks a question and prints no repair | `operationalFindings` | Confirmed, including that an empty set never triggers it |
| An unreadable target project is reported as not checked rather than as all clear | `resolveForeign`, and `unitFinding` suppressing the finding when any contribution is undecidable | Confirmed by an independent two-project run. With the target project readable and closed, one qualified finding and an empty `unchecked`; after archiving that project, zero findings, one `target state not checked` line, and a header reading `0 findings …, 1 contribution target not checked`. `self status` and `self context` carried the same words. No path produced a silent all-clear |
| The same events answer the same way whatever the merge order | `byPlace`, codepoint comparison throughout | Confirmed, and see the ordering note below |
| `self status` and `self context` carry the count | `projectPage` in `views.ts` | Confirmed. The reviewer also checked that `projectPage` reproduces the retired `renderedModel` exactly — same fold, same re-scope, same `withVerdicts` — and that the check's `available` set is the same list `objective check` itself uses, so the two surfaces cannot disagree about a count |

**F1 — resolved at `4ace65a`. Was blocking, low severity. A unit whose
contributions were several closed outcomes was not answered by the line the
finding printed, and two routes promised it was.** At `594eedb`,
`obsoleteFinding` printed exactly one `self work unlink`, for the first closed
target only, while the finding's own summary named every closed target. `self
help goals` (`guide.ts`) and the plugin README both stated "each one clears the
finding it was printed under". The first round's reproduction, at `594eedb`,
running the printed lines verbatim:

```
$ self objective check
demo — 1 finding (1 structural, 0 to review, 0 candidates)

o-gdd4d
  structural: every outcome w-xrz1j contributes to is over — m-r1cgn (closed), m-s0veh (closed)
    self work unlink w-xrz1j --milestone m-r1cgn
    self work link w-xrz1j --standalone --why "<why it contributes to no outcome>"
    self work retire w-xrz1j --why "<why the outcome was given up>"

$ self work unlink w-xrz1j --milestone m-r1cgn
$ self work link w-xrz1j --standalone --why "it moves no stated outcome"
$ self objective check
demo — 1 finding (1 structural, 0 to review, 0 candidates)

o-gdd4d
  structural: every outcome w-xrz1j contributes to is over — m-s0veh (closed)
    self work unlink w-xrz1j --milestone m-s0veh
    …
```

The state reached is a unit linked to two dropped checkpoints, which is
supported throughout: design §1 keeps multiple contributions valid, and both
`work link` calls and both `milestone drop` calls are ordinary approved verbs.

Severity is low and deliberately stated as low. The reader is not misled about
their graph — every run tells them the truth, the omitted edge is named in the
summary the whole time, and the next run prints the next unlink, so the route
converges. What was wrong was the promise, not the answer. It blocked `ready` only
because certifying `ready` means signing that the shipped sentences are true,
and that one was falsifiable by following it.

**How it was corrected, and what the follow-up reviewer checked.** The fix
took the first of the two corrections this receipt offered, and took the second
as well where the sentence was loose. `check.ts` now emits
`...closed.map((item) => \`self work unlink ${work.id} ${targetFlag(item.label)}\`)`
in place of the single `first.label` line, so the finding prints one unlink per
closed target; and the two sentences were softened from "each one clears the
finding it was printed under" to the printed steps for the route chosen
clearing the finding they were printed under, which is what the reader actually
does — the three routes are the relink, the unlink-of-every-closed-target
followed by the standalone declaration, and the retire, and no single line is
the whole of any of them.

The follow-up reviewer read the whole delta `c5b72cab..4ace65a` — five files,
46 insertions, 11 deletions — rather than accepting the fix agent's report, and
checked four things:

- **The order is the summary's order.** `closed` is sorted once, by
  `qualifiedKey`, and both the summary and the new `closed.map` read that same
  array. They cannot disagree. `first` is still `closed[0]` and still supplies
  only the finding's `objective` and `detail`, which is what it supplied
  before.
- **Nothing else moved.** The change to `check.ts` is one line for one. The
  relink was already plural — `relinkCommands` has always flat-mapped over
  every closed target — and the successor, date, judgment, candidate,
  disposition and operational findings, and the grouping, are untouched by this
  delta.
- **No pre-existing case changed answer.** For a unit with exactly one closed
  target, `closed.map` emits exactly the line `first.label` emitted, so the
  output is identical by construction; and every pre-existing
  `obsolete-contributions` cell asserts command membership rather than an exact
  list. The first round's 51/51 therefore carries over without a rerun.
- **The new cell fails without the fix.** Cell 53 was run against the shipped
  build and passed, then against a build with only that one line reverted to
  its `first.label` form, where it failed on exactly the assertion that names
  both targets. A regression that passes either way would have held nothing.

Cell 53 is the cell this receipt asked for: a live unit contributing to a
dropped objective and a dropped milestone, every printed unlink run verbatim,
then the standalone declaration — after which the `obsolete-contributions`
finding and the `no-disposition` finding are both gone and the unit's status is
not `retired`, so the route reconciles the unit in one pass without giving up
the work. The run is recorded under *Supported-path run*.

**F2 — corrected in this receipt, no production change.** The author's draft of
this file recorded that the `superself_work` tool description "omits finding 3
(the date order) and finding 7". The shipped description omits finding 7 only;
"a checkpoint dated past its objective" is present. The row below states the
omission as it actually is.

**Ordering note, no change required.** The part (b) review flagged
`carriedJudgments` as taking the newest coverage claim by physical log
position. The reviewer traced the claim's whole path rather than assuming
either answer. `recordCoverage` in `state.ts` is the only coverage writer on
this branch and emits `entity.covered` alone; those claims reach
`milestone.coverage` through `syncCoverage` in `model.ts`, fed by
`applyCoverage` in `entities.ts`, which sorts by `(ts, event id)` before
folding. So the standing judgment is merge-order invariant on the shipped path,
and cell 36's carried-and-rechecked fixture demonstrates it live rather than
asserting it. One residual worth recording and not fixing here: that sort uses
`localeCompare`, which `check.ts` R6 forbids itself for exactly the locale
reason — it is safe only because ULID event ids are `[0-9A-Z]` and timestamps
are fixed-shape ISO-8601, which collate identically to codepoint order under
any locale. It predates this branch and is not a regression from it.

The reviewer looked specifically for a sentence that overstates what the
command does, since that is the failure this content unit could most easily
cause: a reader who believes the check repaired something would stop. None of
the seven files says the check repairs, relinks, covers, revises or
reclassifies; each route states the opposite in its own words. F1 is an
overstatement of a different kind — about the recovery route's completeness,
not about the tool acting — and it is the only one found.

## Sentence and visual jobs

`C` recognize context, `E` verify evidence, `A` take an action, `R` recognize
the result, `D` make a decision. The last two rows are the questions the author
left open; both are ruled here by the reviewer.

| Location | C/E/A/R/D | Reader value | Reviewer's ruling |
| --- | --- | --- | --- |
| `objective check` usage line and description | C/A | The one line a reader sees before running it | Keep |
| `objective` help, the seven-finding paragraph | C/D | Names what the command will say, so a reader knows whether it answers their question | Keep |
| `objective` help, the "never relinks" paragraph | C/D | The rule that stops a reader believing something was fixed | Keep — this is the claim the whole unit turns on, and it is true |
| `objective` help, the candidate paragraph | C/D | Separates information from coverage | Keep |
| `objective` help, the scope paragraph | C/A | States why there is no `--workspace` form, which the contribution rules require a read verb to do | Keep |
| `check.ts`, the header line | C/E | The count, the classes, and whether anything was unread | Keep. Verified that it never reads `no findings` while a target went unchecked |
| `check.ts`, each finding's summary | C/E/D | What is wrong, in records the reader can open | Keep. The summary was complete where the command list was not, which is what made F1 recoverable rather than misleading; at `4ace65a` the two are built from the same sorted array and say the same thing |
| `check.ts`, each finding's commands | A/R | The line a reader copies | **Keep.** Every command is dispatchable — verified by resolving each against the contract and by running the date, assumption, relink, recheck, unlink and standalone routes by hand — and every one is relevant to its finding. The gap F1 named was coverage of the multi-target case, not correctness of any line; it is closed at `4ace65a`, where a finding over several closed targets prints an unlink for each |
| `check.ts`, the `not checked` section | C/D | The disclosure that separates uncertainty from an all-clear | Keep |
| `self help goals`, four added paragraphs | C/D/A/R | The longer form, where checkpoints are explained | Keep. The F1 sentence is corrected at `4ace65a`, and the corrected claim is true of the shipped code |
| `self help work`, one added paragraph | C/D/A | The two findings a work reader meets, pointing at the goals page for the rest | Keep |
| `docs/reference/cli.md`, one added entry | C/E/A | The reference statement | Keep. It makes no per-command clearing claim, so F1 does not reach it |
| Managed block, one added bullet (~12 lines) | C/D/A | The one place a session reads at start | **Keep.** Measured at the reviewed commit: 136 lines, 32 bullets, 9,609 characters, of which this bullet is about 12 lines. The bullet earns them — it is read at the one moment the reader has not yet run anything, and a session that never learns the check exists reads a drifted graph as truth, which is the failure #417 was opened over. The block's *total* size stays an open measurement carried from the part (b) review; that is a question for a measurement of whether sessions still run `self context` first, not a reason to cut this bullet, and the gate forbids ruling it on surface polish |
| `superself_work` tool description, ~5 added lines | C/A | The check, in the route that exposes no tool for it | **Keep, with a recorded reservation.** Measured at the reviewed commit: 1,559 characters against 193, 243, 232 and 179 for the other four tools — an outlier by more than six times, and it was already the outlier before this branch. The added text does two things. The pointer and the four rules — it changes nothing, a candidate is information, maintenance is the run link, an unreadable target is not an all-clear — change what a model does at the moment it reads them, and there is no tool through which it would learn them otherwise; those stay. The six-item enumeration of findings is the removable half: the README on the same route carries all seven, and a model gets the list by running the command. It is not removed here, because it does one job the README cannot do at that moment — letting a model decide whether the check answers the question it currently has without spending a call — and because shortening it is a budget judgment for the listing as a whole, which is the measurement the part (b) review already opened. A future revision that measures the listing budget should cut the enumeration first. Not a blocker: no factual error, no unsupported claim, every command in it dispatchable. The one factual point is F2 — the description omits finding 7 only, not findings 3 and 7 |

No visual material changed. Every added sentence performs at least one job.

## Supported-path run

The reviewer's own runs, independent of the author's. Environment: Linux, Node
22.23.2, a read-only checkout of `594eedb` at
`/home/launchscreen/work/review-457` built once from source with `pnpm -r
build`. Writes were confined to scratch workspaces created per run under
`/tmp`; neither the implementation worktree nor any real store was written to.
Piped output, no terminal.

| Step | Expected | Observed |
| --- | --- | --- |
| `self objective check` on a clean project | `no findings`, exit 0 | As expected. `--json` on the same store: zero findings, zero unchecked |
| `self status` on the same store | `direction: ok — self objective check --project 'demo'` | As expected |
| A live unit on two dropped checkpoints, then every printed line run verbatim | The finding is gone | **Not as expected at `594eedb` — F1.** The printed unlink withdrew one of the two edges and the finding stood, naming the second. Transcript above. Corrected at `4ace65a`; see the F1 follow-up run below |
| A checkpoint dated past its objective, reached the only way this branch leaves reachable, then the **objective** revise the finding prints | The finding is gone | As expected. This route is not covered by a committed cell; the reviewer ran it because a printed command nobody runs is a promise nobody has tested |
| An assumption on a superseded decision, both printed lines run verbatim in the printed order | The finding is gone | As expected |
| A foreign contribution to a readable, closed objective in a second registered project | One finding, qualified by the owning slug, grouped under the qualified objective | As expected. The group heading read `o-… (other)` and `unchecked` was empty |
| The unlink that finding prints, which names the foreign id without its project qualifier | Withdraws the foreign edge | As expected, exit 0. The obsolete-contributions finding cleared and the correct `no-disposition` finding took its place. The unqualified form is not a defect |
| The same store after archiving the target project | No finding, one `target state not checked` line, and a header that does not read `no findings` | As expected. `self status`, `self context` and `--json` all disclosed the unchecked target |
| `self objective check --project demo` run from the other project's checkout | The same answer as from `demo` itself | As expected, byte-identical |
| `self objective check --project other` where `other` is archived | The archived notice, then the answer | As expected — it does not crash and does not pretend the project is active |
| `self context` | The direction line in the head, above the body the budget can cut | As expected |

Suites the reviewer ran to completion at the reviewed commit, in the review
checkout: `objective-check.test.mjs` 51/51; `guards-carry.test.mjs`,
`render-gate-documents.test.mjs`, `integrity.test.mjs`, `golden.test.mjs`,
`docs.test.mjs` and `contract.test.mjs` together 108/108;
`goal-record.test.mjs`, `milestone-progress.test.mjs` and
`objective-revise-carry.test.mjs` together 64/64 — the existing consumers of
the three helpers this branch extracted into the fold; and the fold's own
`determinism.test.mjs` and `purity.test.mjs` 9/9. `pnpm -r build` clean. CI's
`verify` job, the full tier, was green on `594eedb`.

**F1 follow-up run.** The second round deliberately ran one cell, not a suite:
the correction is one line whose effect on every pre-existing case is identity,
so a rerun would have bought confidence rather than evidence. Environment:
Linux, Node 22.23.2, the branch worktree at `4ace65a` with a clean tree and a
build newer than its sources and carrying the fix, at
`/home/launchscreen/worktrees/417-objective-check`. The scratch reversion wrote
only to `apps/cli/dist/check.js`, which is not tracked, and was restored to its
exact bytes — verified by SHA-256 — leaving the tree clean.

| Step | Expected | Observed |
| --- | --- | --- |
| `node --test --test-name-pattern "^53: " apps/cli/test/objective-check.test.mjs`, against the shipped build | The cell passes: one unlink per closed target, in the summary's order, and running them with the standalone declaration clears both findings without retiring the unit | As expected. `# pass 1 # fail 0`, 613 ms |
| The same cell, against a build with only the one fixed line reverted to `first.label` | The cell fails, on the assertion that both closed targets are named | As expected. `not ok 1`, on `the printed unlinks do not name both closed targets in the summary's stable order`. The regression is load-bearing |
| The same cell again, after restoring `dist/check.js` from the byte-exact backup | The cell passes and the worktree is clean | As expected. SHA-256 matched the pre-experiment digest, `git status` empty |
| `self help goals`, the corrected paragraph, rendered from the shipped build | The sentence no longer promises that each single printed command clears the finding | As expected. It reads "the printed steps for the route you choose clear the finding they were printed under" |

CI on `4ace65a` was in flight when this receipt was written; the coordinator
owns that gate, and this receipt does not claim its result.

## Independent reviewer answers

**Who this is for.** An agent or a person who has just arrived at a project
whose direction graph somebody else moved, and who is about to act on what
`self context` prints. Not somebody auditing a store, and not somebody looking
for a strategy opinion — the copy is careful about both.

**What changes for the reader.** Before this unit, a graph inconsistency was
only visible to somebody who already suspected it and knew which records to
open. After it, one command names the inconsistencies, says which of them a
person has to re-judge rather than repair, and prints the line that answers
each — and says so in the same words on all three entry routes, which the
reviewer verified by resolving every `self …` string each route names against
the dispatch contract.

**What proves success.** Not that the pages read well. That a reader who never
saw the design can reach a repaired state from a finding without a second
refusal and without a command that does not exist. That is what the reviewer
spent the run on, and it is where F1 was found: it is the one place the printed
route does not reach the state the copy promises in one pass.

**What can be removed.** The six-item finding enumeration in the
`superself_work` tool description, if and when the listing budget is measured —
the reasoning is in the jobs table. Nothing else in the seven files repeats a
job without adding information. The reviewer specifically checked whether the
seven-finding list appearing in five places is repetition: it is not, because
each appearance is read at a different moment and only two of them are read by
the same reader in one sitting.

## Reader evidence

Not required for this revision under the project rule that factual guidance for
existing commands does not open a new reader study: the commands documented
here ship in this pull request, so every claim is checkable against the CLI
rather than against a reader's impression. The reviewer relied on that rule
rather than inventing a study gate, and checked the claims against the CLI
instead — which is what surfaced F1.

## Remaining hypotheses and next check

The issue's causal hypothesis — that different agents reconstruct different
methods because the guidance leaves these rules unstated — is still untested.
The design names the cheapest disconfirming check: give fresh sessions the same
seeded store and compare the records they write. All three parts have now
landed or are in review, so this is the check that becomes runnable next, and
`self objective check` is what makes its result readable.

Second: the managed block's total size, and with it the plugin listing's. The
part (b) review recorded the block at 124 lines and 31 bullets; it is 136 lines
and 32 bullets at this commit, and `superself_work` is 1,559 characters against
a 179–243 range for its four siblings. The cheapest check is unchanged —
measure whether a session that reads the block still runs `self context` and
`self instruction render` first — and it now covers two surfaces rather than
one.

Third: whether the multi-target case F1 named has a sibling anywhere else. The
first-round reviewer checked the other six findings' command lists for the same
shape and found none — every other finding prints commands that address its
condition whole — but the check was reading, not exhaustive running. Cell 53
now holds the one case that was wrong, and the follow-up reviewer re-read the
other six command builders against the corrected one: `assumptionCommands` and
the relink already fan out over their whole input, and the remaining findings
print a single command against a single subject, so there is no second place
for this shape to hide. This is recorded as settled by reading plus one cell,
not by exhaustive running.

Fourth, and not blocking: the corrected paragraph in `guide.ts` is a list of
literal lines printed verbatim, and the rewrap left one short line — "and no
criterion. A candidate is" — in the middle of an otherwise even ~76-column
paragraph. It changes no meaning, no reading order and no action, so the gate's
rule against ruling on surface polish applies and it does not block `ready`.
The cheapest correction is rewrapping that paragraph's lines when `guide.ts` is
next edited; the follow-up reviewer did not make it, because this round's write
scope is this receipt alone.

## Sufficient evidence and stop condition

**Met.** The independent review the `ready` bar requires happened in the first
round: a reviewer distinct from the author read all seven content files at
`594eedb`, ran the command and its printed commands against scratch stores,
ruled both open length questions, and corrected one factual error in the
receipt itself. It returned `revise` on F1 alone.

That round named its own closing condition: the F1 row, a cell for the
multi-target route, and a fresh digest, with no further reviewer round beyond
that. All three are here. F1 is fixed at `4ace65a` by the correction this
receipt preferred, and the two sentences it overstated are corrected as well;
cell 53 runs the multi-target route end to end and fails against the pre-fix
build, so it holds the claim rather than restating it; and the digest above
reproduces at the fix head over the same seven files. Four of those seven files
are byte-identical to the state the first round certified, so its evidence
carries over untouched; the three that changed — `check.ts`, `guide.ts` and the
plugin README — are the three F1 named, and each was re-read in full by the
follow-up reviewer.

The remaining items are the two carried measurements — the managed block's and
the plugin listing's size — and the ragged wrap noted above. None is a factual
error, an unsupported claim, a failed command, or a missing reader action or
result, so none of them blocks publication; they are follow-ups. The verdict is
`ready`. It is not `validated`: no real reader has yet been observed using this
guidance, which is the Gate 3 evidence this receipt does not claim.
