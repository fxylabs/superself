# Carry, guard and retarget guidance quality review

- Brief: docs/content-plans/carry-guards-retarget.en.md
- Brief revision: v0.1
- Content file: apps/cli/src/main.ts
- Content file: apps/cli/src/goals.ts
- Content file: apps/cli/src/guide.ts
- Content file: apps/cli/src/connect.ts
- Content file: apps/dsh-plugin/src/tools.ts
- Content file: apps/dsh-plugin/README.md
- Content file: docs/reference/cli.md
- Content SHA-256: fd2590073995176a7f83df0b494482da6075c0cf86616493aa1c9ab8750f6b38
- Author: the implementing agent on branch `feat/417-guards-carry`
- Reviewer: not yet assigned
- Reviewed commit: not yet recorded — the reviewer records the commit they read
- Reviewed at: not yet reviewed
- Verdict: pending

This receipt was prepared by the author. Everything below is the author's own
account of the change, offered as the starting point for an independent
review; **none of it is a review verdict**, and the author does not certify
their own content ready. The verdict stays `pending` until a reviewer whose
identity is distinct from the author's has read the seven content files above,
run the supported path against them, and signed this receipt with the commit
they read.

The digest above is reproduced from the repository root with:

```
python3 .agents/skills/content-quality-gate/scripts/verify_review_record.py \
  digest --root . apps/cli/src/main.ts apps/cli/src/goals.ts \
  apps/cli/src/guide.ts apps/cli/src/connect.ts \
  apps/dsh-plugin/src/tools.ts apps/dsh-plugin/README.md docs/reference/cli.md
```

If it does not match, the content moved after this receipt was written and the
review starts from the current digest.

## Review scope

The reader outcome is that an agent changing the shape of a plan — revising an
objective or a checkpoint, stating a contribution, or answering a plan
proposed a while ago — can say what a revision carries, tell an open target
from a closed one, move a plan whose gap closed, keep the two dates in order,
and re-judge coverage reached under a former parent. The same answer has to be
reachable through the CLI pages, the managed block, or the plugin's guidance.

The reviewed surfaces are the seven content files above. The supported path is
reading one entry route and running the commands it names against a local
workspace store.

The trust boundary is unchanged: every command named is an append of existing
`entity.*` events into the project the caller is in, and every read is a
projection of that project's own log. Nothing named here reaches the network,
and nothing mutates another project's log.

This review excludes Korean copy, marketing narrative, tutorials, any command
belonging to issue #417's part (c), and the code correctness of the carry, the
guards and the judgment-context fold, which the case table
(`docs/maintainers/case-tables/417-guards-carry.md`) and
`apps/cli/test/guards-carry.test.mjs` cover. It stops when each claim below has
a source record and each entry route has been read end to end.

## Claims and evidence

Findings below are the author's reading. A reviewer replaces the column.

| Claim the copy makes | Where the code says it | Author's reading |
| --- | --- | --- |
| `objective revise` carries its live checkpoints and the work linked directly to it | `carriedWork` and `carryEvents` in `goals.ts`; cells 1, 5, 6, 7 | Supported. The `--help` line that claimed this before the branch was inaccurate and is now true |
| `milestone revise` carries the checkpoint's work and the predecessor's assumptions | `carriedUnits` and `carriedAssumptions` in `goals.ts`; cells 9–12 | Supported. `--decision` adds to the carried set and never replaces it, which is what cell 11 asserts |
| A carried unit reads current under the successor and unchanged toward every other outcome | `memberLinks`/`lineageCurrent` in `apps/fold/src/model.ts`; cells 2, 3, 4 | Supported. Nothing is unlinked, so cell 8's `self undo` returns one unit |
| Done work carries as a membership and covers nothing | Coverage is never written by a carry; cell 6 | Supported |
| A contribution names an outcome that is still open, and unlinking never does | `refuseClosedLink`, `refuseClosedGap`, `requireOpenGap` in `goals.ts`; cells 14–20 | Supported. Cell 19 is the unlink case |
| A refusal names the open successor, or the standalone declaration where the lineage ends closed | `closedTargetRefusal` and `standaloneRepair`; cells 17, 18 | Supported. Both cells run the command the refusal printed and assert the state it reaches |
| A plan whose gap closed moves with `work revise --objective\|--milestone`, then confirms | `retargetOf` in `goals.ts`; cells 21, 22, 23, 30 | Supported. The refusal's own lines are what cell 22 runs |
| The same plan text toward a new gap is still a revision | `refuseIdleRevision`; cell 24 | Supported |
| The acceptance is invalidated and the edge it wrote is withdrawn | `applyPlans` in `entities.ts`, `acceptedGapEdge` in `goals.ts`; cells 25, 26 | Supported. Cell 26 asserts the unrelated edge survives |
| A checkpoint may share its objective's date and never follow it; the objective's moves and warns | `refuseLateTarget` and `warnBeyondTarget`; cells 31–37 | Supported. Cell 32 is the equal case, cell 33 the absent one |
| Coverage records the objective it was judged under, and a carried judgment is one to review | `coveragePayload` in `state.ts`, `carriedJudgments` in `objectives.ts`; cells 38–43, 46 | Supported. Cell 43 is the bounded unknown form, which claims nothing about staleness |
| `milestone recheck` settles one criterion and records the current parent | `milestoneRecheck`; cells 40, 41, 47 | Supported. Cell 41 asserts the criterion nobody rechecked stays listed |
| No route names a command part (c) has not shipped | Cell 54, and cell 53 resolves every offered command against the typed contract | Supported |

## Sentence and visual jobs

`C` recognize context, `E` verify evidence, `A` take an action, `R` recognize
the result, `D` make a decision. Length judgments the author could not settle
alone are marked **open**; they are the reviewer's to rule Keep or Cut.

| Location | C/E/A/R/D | Reader value | Author's note |
| --- | --- | --- | --- |
| `work` help, the open-target paragraph | C/D | States the rule and the one verb it does not apply to | Keep |
| `work` help, the retarget block and its two commands | A/R | The exact pair a reader copies out of a drift refusal | Keep |
| `work` help, the carry paragraph | C/R | Says what happens to a unit the reader is not looking at | **Open**: it is the longest addition to that page, and a reader who never revises an objective does not need it |
| `work` flag glossary, `--objective`/`--milestone` on `revise` | A | Declares the flags the page offers | Required by the contract gate as well; Keep |
| `objective` help, the carry paragraph | C/E | Names the mechanism — stated edges, nothing unlinked — which is what makes `self undo` predictable | **Open**: uses the term "lineage-local", which the paragraph then defines. A reviewer may judge the term unnecessary |
| `objective` help, the date paragraph | C/D | States the asymmetry once, where the objective's date is set | Keep |
| `objective revise` usage lines | A/D | The one line a reader sees before running it | Keep — the previous wording was inaccurate |
| `milestone` help, the date paragraph | C/D | Repeats the asymmetry from the checkpoint's side, where the refusal happens | **Open**: it is the same rule stated on two pages. Both pages are entered independently, which is the author's reason for the repetition |
| `milestone` help, the carry paragraph | C/A | States that assumptions carry and that withdrawal still has its own verb | Keep |
| `milestone` help, the judgment-context paragraph | C/D/A | The condition, that it is not a wrong judgment, and the command | Keep |
| `milestone recheck` usage lines | A | Names the second condition the verb now answers | Keep |
| `self help work`, three added paragraphs | C/D/A/R | The longer form of the same three rules | Keep |
| `self help goals`, four added paragraphs | C/D/A/R | Carry, dates, judgment context and the open-target rule, where checkpoints are explained | **Open**: `goals` is now a long page. A reviewer may judge the open-target paragraph redundant with `self help work` |
| Managed block, five added bullets | C/D/A | The one place a session reads at start | **Open**: this is the largest single addition to the block in this issue. Each bullet states a rule a session cannot derive, and the block has no cap; the reviewer decides whether the block's total length has become a comprehension risk |
| `superself_work` tool description | C/A | Names the two guarded verbs and the retarget, in the route that exposes neither as a tool | **Open**: the description is now the longest of the five |
| Plugin README, five added paragraphs | C/D/A/R | The same five facts, in the route a plugin reader enters through | Keep |
| `docs/reference/cli.md`, five added entries | C/E/A | The reference statement of each rule | Keep |

No visual material changed. Every added sentence performs at least one job.

## Author's supported-path run

Recorded so the reviewer can reproduce or contradict it. It is evidence, not a
verdict.

Environment: Linux, Node 22, this branch built from source, a scratch
workspace per run. Piped output, no terminal.

| Step | Expected | Observed |
| --- | --- | --- |
| `self work --help` | Usage and glossary name the retarget flags | As expected |
| `self objective --help`, `self milestone --help` | Both state the carry and the date rule | As expected |
| `self help work`, `self help goals` | Both name the carry, the open-target rule, the retarget and the recheck | As expected |
| `self connect` then read `AGENTS.md`/`CLAUDE.md` | One block carrying the same five facts | As expected; both files carry identical blocks |
| `self work link <id> --objective <reached-id>` | Refused, naming the closure and one repair | As expected — cells 14, 17, 18 |
| The command each refusal printed, run verbatim | Reaches the state the refusal promised | As expected — cells 17, 18, 22, 23, 30, 40 |
| `self work confirm <id>` on a drifted proposal | Refused, printing the retarget, the confirm and the decline | As expected — cell 21 |
| `self milestone add --target` after its objective's | Refused, naming both dates | As expected — cell 31 |
| `self milestone show <id>` after a carry | Names the criteria judged under the former parent, with the recheck command | As expected — cell 39 |
| Every `self …` command the seven files offer | Each resolves to a dispatchable leaf | As expected — 52 of 52 cells in `guards-carry.test.mjs` pass |

## Reader evidence

Not required for this revision under the project rule that factual guidance for
existing commands does not open a new reader study. This is a revision of
technical guidance whose claims are checkable against the CLI, not a new
message or a new form. If the reviewer judges the managed block's new length a
comprehension risk rather than a budget one, that is the point at which a
reader check becomes worth running.

## Remaining hypotheses and next check

The issue's causal hypothesis — that different agents reconstruct different
methods because the guidance leaves these rules unstated — is still untested.
The cheapest disconfirming check is the one the design names: give fresh
sessions the same seeded store, one with this branch's guidance and one
without, and compare the records they write. That check belongs after all three
parts land, because the drift it looks for is what part (c) reports.

## What the reviewer has to settle before this reads `ready`

1. The five **open** length judgments in the jobs table, each Keep or Cut.
2. Whether any sentence claims behavior the code does not have — the claims
   table is the author's reading, and a second reading is the point of it.
3. Whether the three entry routes agree in substance and not only in the
   regular expressions cell 50/51/52 checks.
4. That no sentence anywhere names `self objective check` or any other command
   part (c) has not shipped.

## Sufficient evidence and stop condition

Not yet met. The evidence above supports every factual claim the copy makes and
the parity cells hold the three routes to one contract, but the `ready` bar is
a reviewer identity distinct from the author's signing this receipt against a
named commit. Until then this receipt reads `pending`, and the branch's pull
request says so.
