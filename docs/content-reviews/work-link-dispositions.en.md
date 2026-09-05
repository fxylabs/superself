# Work-link disposition guidance quality review

- Brief: docs/content-plans/work-link-dispositions.en.md
- Brief revision: v0.1
- Content file: apps/cli/src/main.ts
- Content file: apps/cli/src/guide.ts
- Content file: apps/cli/src/connect.ts
- Content file: apps/dsh-plugin/src/tools.ts
- Content file: apps/dsh-plugin/README.md
- Content file: docs/reference/cli.md
- Content SHA-256: 80adbfb35e3df6f8ef94ab06dbd95d42fcacef1abf768377dc8018c4551ef6a4
- Author: the implementing agent on branch `feat/417-contract-links`
- Reviewer: an independent reviewer (Opus) on superself-dev
- Reviewed commit: 957e9d9ce403951f43e02c5d92712756491b057f
- Reviewed at: 2026-09-05
- Verdict: ready

This receipt was prepared by the author as a starting point and now records an
independent reviewer's completed reading of the same commit,
`957e9d9ce403951f43e02c5d92712756491b057f`. The verdict below is the
reviewer's own, not the author's self-certification. The digest above is
reproduced from the repository root with `python3
.agents/skills/content-quality-gate/scripts/verify_review_record.py digest
--root . <the six content files listed above>`; the six content files did not
change between the author's draft and this review.

## Review scope

The reader outcome is that an agent choosing a record kind can name the three
dispositions a work unit may state, act on the one that fits, and replace a
checkpoint's superseded assumption — reaching the same answer through the CLI
pages, the managed block, or the plugin's guidance. The reviewed surfaces are
the six content files above. The supported path is reading one entry route and
running the commands it names against a local workspace store.

The trust boundary is unchanged: every command named is an append of existing
`entity.linked`/`entity.unlinked` events into the project the caller is in, and
every read is a projection of that project's own log.

This review excludes Korean copy, marketing narrative, tutorials, any command
belonging to issue #417's parts (b) or (c), and the code correctness of the
link fold, which the case table and `apps/cli/test/contract-links.test.mjs`
cover. It stops when each claim below has a source record and each entry route
has been read end to end.

## Claims and evidence

| Claim | Evidence | Finding |
| --- | --- | --- |
| A unit states one of three dispositions, and none is inferred | `LINK_OPTIONS` and `cmdWorkLink` in `apps/cli/src/goals.ts`; `runbookLink` in `apps/cli/src/runbook.ts` | Supported. The runbook run link predates this branch and is quoted, not invented |
| `--standalone` owes `--why` | `STANDALONE_WHY` applied through `requireOptions`; cell 2 of `contract-links.test.mjs` | Supported. The refusal names the flag and what it states |
| A standalone declaration hides no contribution edge | `standaloneEdges` adds an edge and removes none; cell 7 asserts both lines render together | Supported |
| The declaration is withdrawn by the same edge | `work unlink --standalone` writes `entity.unlinked` with the identical `(type, target)`; cells 3 and 12 | Supported |
| Stating nothing is not the same as standing alone | `WorkState.standalone` is absent unless an edge says otherwise; `work add` refuses nothing | Supported. The pages say the tool forces no disposition, which matches the code |
| A checkpoint names decisions it assumes, and replacement is two statements | `milestoneLink` and `assumedEdges` in `goals.ts`; cells 14, 18, 20, 21 | Supported |
| Every command the three routes name exists on this branch | Cell 30 resolves each offered command against the typed contract | Supported, and this is the check that keeps a part (b) or (c) command from being advertised early |
| Each route names all six record kinds and the rule for choosing between them | Cell 27a of `contract-links.test.mjs`; `guide.ts`, `connect.ts` and the plugin README | Supported. The runbook line names only the shipped `runbook link` path, and no cadence record is implied |
| No command from parts (b) or (c) is mentioned | Read of all six files; `objective check`, retarget flags, carry and recheck appear nowhere | Supported |

## Sentence and visual jobs

| Location | C/E/A/R/D | Reader value | Finding | Action |
| --- | --- | --- | --- | --- |
| `work` help, the three-disposition table | D/A | Puts the choice and its exact command side by side | The third column names the case rather than restating the flag | Keep |
| `work` help, "a unit that states none of the three is not refused" | C/D | Removes the reading that an unattached unit is an error | Matches what the code does | Keep |
| `work` help, "--standalone conceals nothing" | E/R | Tells the reader what does *not* change, which is the misreading that matters | Keep |
| `work` flag glossary `--standalone` | A | Declares the flag the pages offer | Required by the contract gate as well | Keep |
| `milestone` help, assumption paragraph and two commands | C/A | States the additive rule and the replacement path | Keep |
| `milestone` flag glossary `--decision` | A | Declares the flag on add, revise, link and unlink | Keep |
| `self help work`, disposition table and the two-statement correction | D/A/R | The longer form, with the exact pair that moves a unit off a dead outcome | Keep |
| `self help goals`, the six record kinds | D | One list a reader chooses a record kind from, keyed to what each asserts | Keep |
| `self help goals`, assumption paragraph | C/A | Puts assumptions where checkpoints are explained rather than under work | Keep |
| Managed block, disposition bullet | C/A | The one place a session reads at start; carries all three answers | Longest single bullet in the block; reviewed and kept — the length is needed to state the record-kind boundaries a session must not guess at | Keep |
| Managed block, "Standalone conceals nothing" bullet | E/R | Prevents a silent drop of a contribution edge | Reviewed and kept separate — folding it into the bullet above would blur the one warning that a dropped edge matters | Keep |
| Managed block, record-kind bullet | D/C | Names the six kinds and what each asserts, so a kind is not picked by how a text reads | Adds a second long bullet to the block; reviewed and kept — the length is needed for the record-kind boundaries themselves | Keep |
| Managed block, checkpoint-assumption bullet | C/A | The replacement path, and the warning against assuming a command that does both | Keep |
| `superself_work` tool description | C/A | Says the tool reads and names the CLI commands that write | Longer than its four siblings; reviewed and kept — the length is needed to avoid implying a plugin mutation tool that does not exist | Keep |
| Plugin README, record-kind paragraph | D | The same choice, in the route that had no guidance at all before | Keep |
| Plugin README, "Commands the plugin points at rather than exposes" | C/A/D | States the tool boundary and then the commands, so no nonexistent tool is implied | Keep |
| `docs/reference/cli.md`, two new entries | C/E/A | The reference statement of both verbs | Keep |

No visual material changed. Every added sentence performs at least one job; the
four length judgments above were open at author draft time and are now
resolved Keep by independent review — none were accuracy findings.

## Supported-path run

Environment: Linux, Node 22.23, this branch built from source, a scratch
workspace per run. Piped output, no terminal.

| Step | Expected | Observed |
| --- | --- | --- |
| `self work --help` | Usage and glossary name `--standalone` | As expected |
| `self milestone --help` | Usage and glossary name `--decision` | As expected |
| `self help work`, `self help goals` | Both name the dispositions and the assumption commands, and `goals` opens with the six record kinds | As expected |
| `self connect` then read `AGENTS.md`/`CLAUDE.md` | One block, carrying the three dispositions and the assumption path | As expected; both files carry identical blocks |
| `self work add "<outcome>"` | The offer under the id reaches the standalone declaration | As expected |
| `self work link <id> --standalone --why "…"`, then `self work show <id>` | The page states the disposition, the reason and the declaration date | As expected |
| `self work unlink <id> --standalone`, then `self work show <id>` | The disposition is gone | As expected |
| `self milestone link <m> --decision <d>`, `self milestone unlink <m> --decision <d>` | The checkpoint names the decision, then stops naming it | As expected |
| Every `self …` command the six files offer | Each resolves to a dispatchable leaf | As expected — 31 of 31 cells in `contract-links.test.mjs` pass |

## Independent reviewer answers

- **Who this is for:** an agent session recording work in a superself
  workspace, and the person reading its records afterwards.
- **What changes for the reader:** they gain a third answer they can state, and
  a checkpoint gains a way to name what it rests on. Nothing they could do
  before is refused now.
- **What proves success:** two sessions given the same seeded store record the
  same disposition for the same unit, and a person reading `self work show`
  can tell deliberate standalone work from work nobody has spoken for.
- **What can be removed:** nothing. The managed block's two longest bullets
  and the `superself_work` tool description were each weighed against a
  shorter form at author draft time; independent review kept all three,
  judging the length necessary for the record-kind boundaries and to avoid
  implying a plugin mutation tool that does not exist.

## Reader evidence

Not required for this revision under the project rule that factual guidance for
existing commands does not open a new reader study. This is a revision of
technical guidance whose claims are checkable against the CLI, not a new
message or a new form. If the independent reviewer judges the managed block's
new length a comprehension risk rather than a budget one, that is the point at
which a reader check becomes worth running.

## Remaining hypotheses and next check

The issue's causal hypothesis — that different agents reconstruct different
methods because the guidance left the third case unstated — is untested. The
cheapest disconfirming check is the one the design already names: give fresh
sessions the same seeded store, one with this branch's guidance and one
without, and compare the records they write. That check belongs after all
three parts land, because the drift it looks for is what part (c) reports.

## Sufficient evidence and stop condition

The evidence supports every factual claim the copy makes, and the parity check
holds the three routes to one contract. An independent reviewer has now
followed the supported path on commit `957e9d9ce403951f43e02c5d92712756491b057f`
and ruled Keep on the four length judgments that were open at author draft
time. That satisfies the `ready` bar: a reviewer identity distinct from the
author's has signed the receipt.
