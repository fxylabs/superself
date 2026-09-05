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
- Content SHA-256: 33f88002faf54d9cd6dff2c42e35c4d9109e16df4276bc3c4deab70da4631ae9
- Author: the implementing agent on branch `feat/417-guards-carry`
- Reviewer: an independent reviewer agent (Opus) on the dev VM `superself-dev`
- Reviewed commit: 03be07a638634c97d2ae5fcef27fb75765c122b1 (`feat/455-guards-carry`)
- Reviewed at: 2026-09-05
- Verdict: ready

This receipt is signed by a reviewer whose identity is distinct from the
author's. Everything below the metadata is the reviewer's own reading. Where a
row reuses an earlier observation, it says so and names what was re-checked to
establish that the observation still holds.

The digest above is reproduced from the repository root with:

```
python3 .agents/skills/content-quality-gate/scripts/verify_review_record.py \
  digest --root . apps/cli/src/main.ts apps/cli/src/goals.ts \
  apps/cli/src/guide.ts apps/cli/src/connect.ts \
  apps/dsh-plugin/src/tools.ts apps/dsh-plugin/README.md docs/reference/cli.md
```

The whole receipt is checked, digest included, with:

```
python3 .agents/skills/content-quality-gate/scripts/verify_review_record.py \
  verify --root . docs/content-reviews/carry-guards-retarget.en.md
```

The digest moved from `fd259007…` to `33f88002…` between the previously
reviewed implementation (`7b53938a` on `feat/417-guards-carry`) and this
commit. The reviewer established the cause rather than assuming it:
`git diff 7b53938a 03be07a --` over the seven content files reports exactly
one changed file, `apps/cli/src/goals.ts`, and exactly one changed line of it —
`makeEvent(owner, "entity.revised", …)` — plus a five-line code comment. No
reader-facing string in any of the seven files differs. The guidance under
review is byte-identical to the guidance previously read; the digest changed
because `goals.ts` carries both help copy and code, and the digest covers the
file's exact bytes.

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
and nothing mutates another project's log. The reviewer re-confirmed the
boundary claim at this commit by reading the two payload writers the fix
touched: both still append through `recordEvent`/`recordEvents` into
`ctx.project`, and the fix renames payload keys only.

This review excludes Korean copy, marketing narrative, tutorials, any command
belonging to issue #417's part (c), and the code correctness of the carry, the
guards and the judgment-context fold, which the case table
(`docs/maintainers/case-tables/417-guards-carry.md`) and
`apps/cli/test/guards-carry.test.mjs` cover. It stops when each claim below has
a source record and each entry route has been read end to end.

## Claims and evidence

The reviewer read each claim against the named source and, where the fix
touched the mechanism behind a claim, re-ran the path rather than reusing the
earlier observation. Rows marked *reused* rest on the previous independent
review of `7b53938a`; each names what was checked here to establish that the
source is unchanged at this commit.

| Claim the copy makes | Where the code says it | Reviewer's finding |
| --- | --- | --- |
| `objective revise` carries its live checkpoints and the work linked directly to it | `carriedWork` and `carryEvents` in `goals.ts`; cells 1, 5, 6, 7 | Supported. *Reused* — both functions are byte-identical at this commit, and cells 1, 5, 6, 7 pass in the 54/54 run below |
| `milestone revise` carries the checkpoint's work and the predecessor's assumptions | `carriedUnits` and `carriedAssumptions` in `goals.ts`; cells 9–12 | Supported. *Reused*, same basis. `--decision` adds to the carried set and never replaces it |
| A carried unit reads current under the successor and unchanged toward every other outcome | `memberLinks`/`lineageCurrent` in `apps/fold/src/model.ts`; cells 2, 3, 4 | Supported. *Reused* — `model.ts` is not in this commit's diff at all |
| Done work carries as a membership and covers nothing | Coverage is never written by a carry; cell 6 | Supported. *Reused* |
| A contribution names an outcome that is still open, and unlinking never does | `refuseClosedLink`, `refuseClosedGap`, `requireOpenGap` in `goals.ts`; cells 14–20 | Supported, **re-run here**. `self work link <w> --objective <superseded>` refused with `o-c7rje is superseded — a contribution names an outcome that is still open` |
| A refusal names the open successor, or the standalone declaration where the lineage ends closed | `closedTargetRefusal` and `standaloneRepair`; cells 17, 18 | Supported, **re-run here**. The refusal printed `self work link w-qq8w4 --objective o-szn5e`; running that line verbatim recorded the edge, and `work show` then read `Contributes to: o-szn5e restated (on-track)` |
| A plan whose gap closed moves with `work revise --objective\|--milestone`, then confirms | `retargetOf` in `goals.ts`; cells 21, 22, 23, 30 | Supported, **re-run here** — this is the path the fix changed. A retarget onto a checkpoint printed `now toward …`, and after `work confirm` the unit read `Contributes to: m-1776a the destination checkpoint (on-track)`, the new gap alone |
| The same plan text toward a new gap is still a revision | `refuseIdleRevision`; cell 24 | Supported. *Reused* — `refuseIdleRevision` is unchanged; cell 24 passes |
| The acceptance is invalidated and the edge it wrote is withdrawn | `applyPlans` in `entities.ts`, `acceptedGapEdge` in `goals.ts`; cells 25, 26 | Supported, **re-run here**. The retarget append carried the `entity.revised` and its paired `entity.unlinked` together; the unrelated edge survived (cell 26) |
| A checkpoint may share its objective's date and never follow it; the objective's moves and warns | `refuseLateTarget` and `warnBeyondTarget`; cells 31–37 | Supported, **re-run here** for the refusal: `milestone add --target 2026-12-01` under an objective judged on `2026-10-01` refused, naming both dates and offering `objective revise --target` as the repair. Cells 32 (equal) and 33 (absent) pass |
| Coverage records the objective it was judged under, and a carried judgment is one to review | `coveragePayload` in `state.ts`, `carriedJudgments` in `objectives.ts`; cells 38–43, 46 | Supported, **re-run here** — this is the other path the fix changed. After a carry, `milestone show` read `- c1 — judged under o-w3mpx, and m-q4brr now hangs under o-eajwd; recheck it with …`. The claim's parent now travels as `payload.judgedUnder`, and the rendered sentence is unchanged |
| `milestone recheck` settles one criterion and records the current parent | `milestoneRecheck`; cells 40, 41, 47 | Supported, **re-run here**. Running the exact command the page printed cleared the review section and left the Coverage section intact, with both claim lines listed |
| No route names a command part (c) has not shipped | Cell 54, and cell 53 resolves every offered command against the typed contract | Supported. Cells 53 and 54 pass in the run below; the reviewer additionally grepped the seven files for `objective check` and found none |

No sentence in the seven files claims behavior the code does not have. The
reviewer looked specifically for a claim the fix could have falsified — the
copy nowhere names a payload field, so renaming `objective` to `judgedUnder`
and nesting the retarget under `gap` leaves every reader-facing statement true
as written.

One understatement, carried forward from the previous review and re-checked
here: the enumeration "reached, dropped or superseded" omits `declined` and
`undone`. The surrounding rule ("an outcome that is still open") covers both,
and no reader is led to a wrong action by the shorter list. Not a defect.

## Sentence and visual jobs

`C` recognize context, `E` verify evidence, `A` take an action, `R` recognize
the result, `D` make a decision.

The author's receipt left length judgments open and described them as five.
There are **six**, and the reviewer rules each one below. Every ruling is Keep;
the reasoning is recorded per row so the ruling can be contradicted rather than
taken on trust.

| Location | C/E/A/R/D | Reader value | Reviewer's ruling |
| --- | --- | --- | --- |
| `work` help, the open-target paragraph | C/D | States the rule and the one verb it does not apply to | Keep |
| `work` help, the retarget block and its two commands | A/R | The exact pair a reader copies out of a drift refusal | Keep |
| `work` help, the carry paragraph | C/R | Says what happens to a unit the reader is not looking at | **Keep.** The author's doubt was that a reader who never revises an objective does not need it. That reader is exactly who needs it: a carry is performed by *someone else*, and its whole effect lands on a work unit whose owner never ran the command. The paragraph answers "why does my unit now read under a different objective" and names the one verb that reverses it (`self undo`). Cutting it would leave a silent, third-party effect discoverable only on a page the affected reader has no reason to open |
| `work` flag glossary, `--objective`/`--milestone` on `revise` | A | Declares the flags the page offers | Keep — also required by the contract gate |
| `objective` help, the carry paragraph | C/E | Names the mechanism — stated edges, nothing unlinked — which is what makes `self undo` predictable | **Keep, term included.** "lineage-local" is glossed in the same sentence by an em-dash clause that states the rule concretely, and it appears once in reader-facing copy (`goals.ts:201`; every other occurrence is a code comment, a case-table row or a test). A coined term used once, defined in place, gives the rule a handle that the `self undo` guarantee hangs on. It is not carrying weight it has not earned |
| `objective` help, the date paragraph | C/D | States the asymmetry once, where the objective's date is set | Keep |
| `objective revise` usage lines | A/D | The one line a reader sees before running it | Keep — the previous wording was inaccurate |
| `milestone` help, the date paragraph | C/D | Repeats the asymmetry from the checkpoint's side, where the refusal happens | **Keep.** This is not the same sentence twice. The refusal fires on `milestone add`/`milestone revise` and the warning fires on `objective revise`; each page states the half its own verbs enforce, plus the counterpart for orientation. The reviewer's re-run confirms the refusal text arrives on the `milestone` side, which is where a reader blocked by it will look |
| `milestone` help, the carry paragraph | C/A | States that assumptions carry and that withdrawal still has its own verb | Keep |
| `milestone` help, the judgment-context paragraph | C/D/A | The condition, that it is not a wrong judgment, and the command | Keep |
| `milestone recheck` usage lines | A | Names the second condition the verb now answers | Keep |
| `self help work`, three added paragraphs | C/D/A/R | The longer form of the same three rules | Keep |
| `self help goals`, four added paragraphs | C/D/A/R | Carry, dates, judgment context and the open-target rule, where checkpoints are explained | **Keep.** Measured rather than estimated: `self help goals` renders 86 lines against `self help work`'s 299, and the open-target paragraph is 3 compressed lines there against 6 fuller ones on the `work` page. The `goals` reader is looking at an objective and asking why a link is refused; three lines and the closing `Related: self help work` pointer is the proportionate answer, not a duplicate of it |
| Managed block, five added bullets | C/D/A | The one place a session reads at start | **Keep.** Measured: the block is 124 lines / 8,680 characters / 31 bullets, of which the five new ones are ~29 lines, about 23%. The bar for this block is a rule a session cannot derive and whose violation writes a wrong record; all five clear it. The reviewer probed the weakest — the date bullet, whose refusal is self-announcing — and kept it, because its other half is not: `objective revise --target` warns on **stderr** and does not refuse, so a session that never read the rule can move an objective's date and silently strand live checkpoints beyond it |
| `superself_work` tool description | C/A | Names the two guarded verbs and the retarget, in the route that exposes neither as a tool | **Keep.** Measured: 908 characters against 243 for the next-longest description — a real outlier, so the reviewer checked what this branch actually added. It added 346 characters (562 → 908): the open-target refusal and the retarget recipe, and nothing else. Those are precisely the two rules that change what an agent does in the moment it uses this tool — it will attempt `self work link` and be refused, or it holds a plan whose gap closed. The other three facts were left to the README, where the plugin route also carries them in full. That split is correct editorial discipline: a tool description is read by a model at every tool listing, a README by a human at install time |
| Plugin README, five added paragraphs | C/D/A/R | The same five facts, in the route a plugin reader enters through | Keep — verified to carry all five, which is what lets the tool description carry only two |
| `docs/reference/cli.md`, five added entries | C/E/A | The reference statement of each rule | Keep |

No visual material changed. Every added sentence performs at least one job.

## Supported-path run

The reviewer's own run, not the author's. Environment: Linux, Node 22, the
built `dist/` in the reviewed worktree, verified newer than every `.ts` under
`apps/cli/src` and `apps/fold/src` and containing the fix's symbols. Writes
were confined to a scratch workspace per run; the reviewed worktree was not
written to. Piped output, no terminal.

| Step | Expected | Observed |
| --- | --- | --- |
| `self work link <id> --objective <superseded>` | Refused, naming the closure and one repair | As expected: `o-c7rje is superseded — a contribution names an outcome that is still open`, with the successor line offered |
| The repair the refusal printed, run verbatim | Reaches the state the refusal promised | As expected: the edge recorded, `Contributes to: o-szn5e restated (on-track)` |
| `self milestone add --target` after its objective's | Refused, naming both dates and the repair | As expected: `2026-12-01 falls after o-722cy, which is judged on 2026-10-01`, offering `objective revise --target` |
| `self work revise <id> --milestone <open>` then `self work confirm <id>` | The plan moves and confirms toward the new gap alone | As expected: `Contributes to: m-1776a the destination checkpoint (on-track)`, the old gap withdrawn in the same append |
| `self milestone show <id>` after a carry | Names the criteria judged under the former parent, with the recheck command | As expected: `- c1 — judged under o-w3mpx, and m-q4brr now hangs under o-eajwd; recheck it with …` |
| The recheck command that page printed, run verbatim | Clears that criterion; the Coverage section stays | As expected: the review section is gone, both claim lines remain listed |
| `self state show <checkpoint> --history` and `… <objective> --history` after `milestone met` | The claim reads in the checkpoint's history, not the objective's | As expected — the regression the previous review blocked on is repaired |
| `self work show <plan> --history` and `self state show <gap> --history` after a retarget | The revision reads in the plan's history, not the destination's | As expected — the second regression is repaired |
| `self help goals`, `self help work`, `self milestone --help` | Each states the carry, the open-target rule, the dates and the recheck | As expected; rendered and read end to end for the length rulings above |
| The managed block (`commonProtocolLines`) | One block carrying the same five facts | As expected; 124 lines, five new bullets, all five facts present |
| Every `self …` command the seven files offer | Each resolves to a dispatchable leaf | As expected — 54 of 54 cells in `guards-carry.test.mjs` pass, cells 50–54 included |

Targeted suites re-run by the reviewer at this commit: `guards-carry.test.mjs`
54/54, `work-propose-supersedes.test.mjs` 33/33, and the fold's
`determinism.test.mjs` + `purity.test.mjs` 9/9. CI `verify` on this commit is
green, with `dco` and `contribution-policy` green beside it.

## Independent reviewer answers

**Who this is for.** An agent or a person already holding a work unit, an
objective or a checkpoint, at the moment they try to change its shape. Not a
newcomer learning the model — every one of these paragraphs sits on a page
that already assumes the record kinds.

**What changes for the reader.** Five rules stop being things they discover by
being refused. Before this branch the `work --help` carry line was inaccurate,
and the other four rules were stated nowhere a session reads. After it, each
rule is stated where the verb that enforces it lives, and each refusal prints
a repair the reader can run verbatim — which the reviewer confirmed three
times above, on three different refusals.

**What proves success.** Not the copy's presence: the parity cells (50–54)
hold the three entry routes to one contract and resolve every offered command
against the typed contract, so a route cannot drift into offering a command
that does not dispatch. The reviewer treats that as the standing proof and the
refusal-then-repair runs as the evidence that the printed path is real.

**What can be removed.** On this reading, nothing — the six length questions
are ruled Keep above, each on a stated reason rather than on the absence of a
cap. The honest residual risk is the managed block's total size, which is a
budget question for the block as a whole (31 bullets) and not a defect in any
of the five this issue added. That is named as the next check below rather
than hidden inside a Keep.

## Reader evidence

Not required for this revision under the project rule that factual guidance for
existing commands does not open a new reader study. This is a revision of
technical guidance whose claims are checkable against the CLI, not a new
message or a new form, and the reviewer verified every claim against a source
record or a live run rather than against a reader's impression.

The author flagged the managed block's new length as the point where a reader
check would become worth running. The reviewer measured it (124 lines, 23% of
it new) and judges it a budget question rather than a comprehension one at this
size — the block is a checklist read by a session, not prose read by a person.
It is recorded as the next check rather than as a blocker.

## Remaining hypotheses and next check

The issue's causal hypothesis — that different agents reconstruct different
methods because the guidance leaves these rules unstated — is still untested.
The cheapest disconfirming check is the one the design names: give fresh
sessions the same seeded store, one with this branch's guidance and one
without, and compare the records they write. That check belongs after all three
parts land, because the drift it looks for is what part (c) reports.

Second, smaller: the managed block is now 31 bullets and has no cap. The
cheapest check is to measure whether a session that reads it still runs
`self context` and `self instruction render` first — the two bullets at the
top — rather than to shorten it on suspicion.

Two observations the reviewer confirmed but does not treat as blockers for this
content unit, both code rather than copy, and both already tracked:

- `warnBeyondTarget` names the *predecessor* as "now judged on `<new date>`",
  while the record carrying the new date is the successor. Wording in a warning,
  outside these seven files.
- `carriedJudgments` picks the newest claim by log position rather than by
  `(ts, id)`, so two clones of one store can disagree about whether a review
  prompt shows. The consequence is a spurious or missing prompt, never wrong
  coverage. Part (c)'s determinism guarantee is where this has to be settled,
  and it is tracked there.

## Sufficient evidence and stop condition

Met. Every factual claim the copy makes has a source record or a live run
behind it; the two regressions that blocked the previous review are repaired
and were re-reproduced as repaired by this reviewer, on the same commands that
demonstrated them; the six open length judgments are ruled, with reasons, by a
reviewer who did not write the copy; the three entry routes were checked to
agree in substance and not only by regular expression; and no route names a
command part (c) has not shipped.

The `ready` bar — a reviewer identity distinct from the author's, signing
against a named commit — is met at
`03be07a638634c97d2ae5fcef27fb75765c122b1`. This verdict covers the English
guidance in the seven files above and nothing else: not the Korean copy, not
part (c), and not the code correctness the case table and
`guards-carry.test.mjs` own.
