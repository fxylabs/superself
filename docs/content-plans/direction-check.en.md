# Content brief: reading the direction graph back, and what the reading will not do

- Status: approved
- Approved by: the operator, on 2026-09-05, as the approved #417 direction
  management design v2.1 ("ok 승인할테니 착수해"). §6, §7 and §8 of that design
  are the reader-facing scope of issue #417's part (c); this brief restates
  them as a content unit and widens nothing. The authoring agent did not
  approve its own brief.
- Revision: v0.1
- Owner: Superself maintainers
- Reader outcome slug: `direction-check`
- Planned content: `apps/cli/src/goals.ts` (the `objective` help page and the
  check's own rendered answer), `apps/cli/src/guide.ts` (`self help goals`,
  `self help work`), `apps/cli/src/connect.ts` (the managed block every
  session reads), `apps/dsh-plugin/src/tools.ts` and
  `apps/dsh-plugin/README.md` (the plugin entry route), `docs/reference/cli.md`
- Quality review: `docs/content-reviews/direction-check.en.md`
- Korean: none in this revision. The English guidance is revised in place, and
  no new Korean public copy is produced.

## Who the reader is

An agent session, or a person reading over one, arriving at a project whose
direction graph somebody else has been changing. They are about to treat what
`self context` prints as current truth, and they have no way to tell whether
the objectives, checkpoints and contributions in front of them still line up.

They arrive through one of three doors and expect the same answer at each:

- the CLI's own pages — `self objective --help`, `self help goals`,
  `self help work`;
- the managed block `self connect` writes into `AGENTS.md` and `CLAUDE.md`,
  which a session reads at start;
- the plugin's tool descriptions and its README, where the tool surface is five
  read-and-report tools and the rest of the graph is CLI commands.

They are not auditing a project. They are deciding whether the direction they
are reading can be acted on, and — if not — what one command to run next.

## What they currently try, and where it fails

They read `self context` and `self objective`, see a tidy list of open
outcomes, and start work. Nothing on either page says that a unit's only
contribution points at a checkpoint reached last quarter, that a successor
checkpoint was created and nobody moved the work onto it, that a checkpoint is
dated past the objective it sits inside, or that a criterion's verdict was
reached under a parent the checkpoint no longer hangs under. Parts (a) and (b)
now refuse the *creation* of three of those states; they reconcile none of the
stores that already hold them, and the design forbids automatic cleanup.

So the reader either trusts a graph that is wrong, or reconstructs the check by
hand — reading each objective, each checkpoint and each unit's page in turn,
which is what nobody does at the moment they most need to.

## Evidence and inferences

| Type | Claim | Source | Cheapest disconfirming check |
| --- | --- | --- | --- |
| Observation | Work stayed on a superseded milestone while its successor had none | Issue #417, four recorded graph inconsistencies | Re-read the named records in the store |
| Observation | Recurring maintenance became a checkpoint dated after its objective | Issue #417 | Read the two `target` fields in the store |
| Observation | Completed work was not reconciled with the successor's criteria | Issue #417 | `self milestone show` on the successor after a carry |
| Observation | No command answered any of the four; parts (a) and (b) guard creation only | `OBJECTIVE_COMMAND` at `origin/main` has no read verb beyond `list` and `show` | `self objective --help` on the released CLI |
| Observation | A coverage claim now records the objective it was judged under | `payload.judgedUnder`, shipped in #456 | `self milestone show` after an `objective revise` |
| Observation | A contribution to another project's objective is resolved from that project's own log, which this machine may not hold | `foreignObjectives` in `apps/fold/src/model.ts` | Link to a foreign objective, then unregister that project |
| Inference | Agents reconstruct different methods because the guidance leaves these rules unstated | Issue #417 states this as a hypothesis, not a finding | Give fresh sessions the same seeded store and compare the records they write |

The guidance states only what the command does. It makes no claim about why a
graph drifted, and none about whether any particular plan was well judged.

## The one decision the content enables

The reader decides whether the direction in front of them can be acted on, and
— when it cannot — which single command answers the finding they are looking
at:

- a unit whose every contribution is over — relink to the open successor the
  finding names, `self work link <id> --objective <id>`, then withdraw the old
  edge with `self work unlink <id> --objective <old>`; or declare
  `--standalone --why "<reason>"`; or `self work retire <id> --why "…"`;
- a successor checkpoint with no live work — `self work link <id> --milestone
  <successor>` for each unit the finding names, or `self milestone drop
  <successor> --why "…"`;
- a checkpoint dated past its objective — `self milestone revise <id> --target
  <date> --why "…"` or `self objective revise <id> --target <date> --why "…"`;
- a judgment made under a former parent — `self milestone recheck <id>
  --criterion cN --why "<what you re-judged>"`;
- an assumption on a decision that was replaced — `self milestone link <id>
  --decision <successor>` then `self milestone unlink <id> --decision <old>`;
- a unit that states no disposition — link it, declare it standalone, or
  retire it;
- an evidence candidate — nothing, unless a person judges it. The template
  `self milestone met <id> --criterion cN --why "…" --work <id>` is offered
  with a literal `cN`, because the tool pairs nothing.

## What the reader must be able to say back

- `self objective check` reads and changes nothing. Every line it prints is a
  command they run themselves.
- It states seven kinds of finding and no more. It is not an audit of the
  project, the records or the code.
- A candidate is information, not coverage: nothing is paired to a criterion by
  its wording, and no unit's evidence is applied on anybody's behalf.
- Maintenance is read off the `self runbook link` edge and never out of a
  record's text or its dates.
- Where a project a unit contributes to is not readable on this machine, the
  answer says the target state was not checked. It does not report all clear.
- `self status` and `self context` carry the count, so a session knows whether
  to run it without running it first.

## Included surfaces and explicit exclusions

Included: the six production files named above, in English, plus the answer the
command itself renders — which is reader-facing text and is reviewed as such.

Excluded, and not to be mentioned by this revision:

- Any claim that the check repairs, relinks, covers, revises or reclassifies
  anything, or that it can be made to;
- routine records (#451), progress percentages, prose classification, strategy
  scoring, severity dials, filters, and any claim about whether a plan was well
  judged;
- a general audit of a project, its records or its store — the seven finding
  kinds are the whole of what this command says;
- Korean copy, marketing narrative, tutorials and new reader studies. This is a
  revision of technical guidance whose every claim is checkable against the
  CLI, not a new message or a new form.

## Stop condition

The content is sufficient when each of the three entry routes states the five
facts above in its own words, every command any of them offers is dispatchable
on this branch, each advertised recovery command reaches the state it promises
from the context it is read in, and no route claims the check does anything to
a record. An independent reviewer supplies the publication verdict; the author
does not.
