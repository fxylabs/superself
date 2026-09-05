# Content brief: what a revision carries, which targets are still open, and how a plan moves

- Status: approved
- Approved by: the operator, on 2026-09-05, as the approved #417 direction
  management design v2.1 ("ok 승인할테니 착수해"). §4, §5 and §8 of that design
  are the reader-facing scope of issue #417's part (b); this brief restates
  them as a content unit and widens nothing. The authoring agent did not
  approve its own brief.
- Revision: v0.1
- Owner: Superself maintainers
- Reader outcome slug: `carry-guards-retarget`
- Planned content: `apps/cli/src/main.ts` (the `work` help page),
  `apps/cli/src/goals.ts` (the `objective` and `milestone` help pages),
  `apps/cli/src/guide.ts` (`self help work`, `self help goals`),
  `apps/cli/src/connect.ts` (the managed block every session reads),
  `apps/dsh-plugin/src/tools.ts` and `apps/dsh-plugin/README.md` (the plugin
  entry route), `docs/reference/cli.md`
- Quality review: `docs/content-reviews/carry-guards-retarget.en.md`
- Korean: none in this revision. The English guidance is revised in place, and
  no new Korean public copy is produced.

## Who the reader is

An agent session, or a person reading over one, that is changing the shape of
a plan rather than doing the work in it: revising an objective or a checkpoint,
stating a contribution, or answering a plan somebody proposed a while ago. They
arrive through one of three doors and expect the same answer at each:

- the CLI's own pages — `self work --help`, `self objective --help`,
  `self milestone --help`, `self help work`, `self help goals`;
- the managed block `self connect` writes into `AGENTS.md` and `CLAUDE.md`,
  which a session reads at start;
- the plugin's tool descriptions and its README, where the tool surface is five
  read-and-report tools and the rest of the graph is CLI commands.

They are not choosing a product. They are deciding whether a record they are
about to change takes its work with it, and what to do when the outcome they
meant to name is over.

## What they currently try, and where it fails

They revise an objective, read "carried 5 milestones", and assume the work went
too — the `objective revise` page said "every live milestone, with its coverage
and work, moves under it", and only the milestones moved. They link a unit to
the checkpoint they remember, and the store accepts an edge to a checkpoint
that was reached last quarter. They confirm a plan proposed three weeks ago and
the acceptance lands on an outcome nobody is pursuing. They date a checkpoint
after the objective it sits inside, and nothing says a word. They carry a
checkpoint to a new parent and its coverage keeps reading current, because the
judgment recorded no parent to compare against.

## Evidence and inferences

| Type | Claim | Source | Cheapest disconfirming check |
| --- | --- | --- | --- |
| Observation | Work stayed on a superseded milestone | Issue #417, four recorded graph inconsistencies | Re-read the named records in the store |
| Observation | `objective revise` carried checkpoints and left contributing units on the predecessor | `objectiveRevise` and `carryEvents` at `origin/main` | `self objective revise` on a seeded store, then `self work show` |
| Observation | The `objective revise` help claimed the work moved with the milestones | `OBJECTIVE_COMMAND.usage` at `origin/main` | `self objective --help` on the released CLI |
| Observation | `work link`, `work propose` and `work confirm` accepted a closed target without a word | No closure check anywhere on those paths at `origin/main` | `self work link <id> --objective <reached-id>` on the released CLI |
| Observation | Recurring maintenance became a checkpoint dated after its objective | Issue #417 | Read the two `target` fields in the store |
| Observation | `entity.covered` recorded no objective, so a carried checkpoint's verdict read current | `collectCoverage` at `origin/main` | `self milestone show` after an `objective revise` |
| Inference | Agents reconstruct different methods because the guidance leaves these rules unstated | Issue #417 states this as a hypothesis, not a finding | Give fresh sessions the same seeded store and compare the records they write |

The guidance states only what the commands do. It makes no claim about why
past sessions chose what they chose, and none about whether a particular plan
was well judged.

## The one decision the content enables

The reader decides what to do with a record whose target has moved, and can
act on the answer:

- the target is open — state the contribution: `self work link <id> --objective
  <id>` or `--milestone <id>`;
- the target closed and its lineage has an open end — follow it: the refusal
  names the terminal successor, and the same command runs against it;
- the target closed and nothing succeeds it — say so: `self work link <id>
  --standalone --why "<reason>"`;
- a plan proposed against a gap that has since closed — move it:
  `self work revise <id> "<plan>" --why "<what changed>" --milestone <open-id>`,
  then `self work confirm <id>`; or `self work decline <id> --why "…"`;
- a criterion judged under a parent the checkpoint no longer hangs under —
  re-judge it: `self milestone recheck <id> --criterion cN --why "<what you
  re-judged>"`.

## What the reader must be able to say back

- A revision carries the work as well as the checkpoints, by stating the edge
  rather than moving a row, and every other outcome a carried unit serves is
  untouched.
- Done work carries as a membership and never as coverage.
- A contribution names an outcome that is still open; a withdrawal never has
  to.
- A gap is part of a plan, so moving the gap is a revision and the acceptance
  goes with it.
- A checkpoint may share its objective's date but never follow it, and the
  objective's own date moves freely.
- A judgment reached under a former parent is a judgment to review, not a
  wrong one and not one the tool quietly makes current.

## Included surfaces and explicit exclusions

Included: the seven production files named above, in English.

Excluded, and not to be mentioned by this revision:

- `self objective check`, its seven findings, the health summary, the foreign
  availability notices and any recovery output — issue #417's part (c), which
  has shipped nothing;
- routine records (#451), progress percentages, prose classification, strategy
  scoring, and any claim about whether a plan was well judged;
- Korean copy, marketing narrative, tutorials and new reader studies. This is a
  revision of technical guidance whose every claim is checkable against the
  CLI, not a new message or a new form.

## Stop condition

The content is sufficient when each of the three entry routes states the five
facts above in its own words, every command any of them offers is dispatchable
on this branch, no route names a part (c) command, and each advertised recovery
command reaches the state it promises from the context it is read in. An
independent reviewer supplies the publication verdict; the author does not.
