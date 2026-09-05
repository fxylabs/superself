# Content brief: choosing a record kind and stating what work contributes to

- Status: approved
- Approved by: the operator, on 2026-09-05, for the reader-facing guidance in
  issue #417's part (a). The approval covers the scope stated below and nothing
  wider; the authoring agent did not approve its own brief.
- Revision: v0.1
- Owner: Superself maintainers
- Reader outcome slug: `work-link-dispositions`
- Planned content: `apps/cli/src/main.ts` (the `work` and `milestone` help
  pages), `apps/cli/src/guide.ts` (`self help work`, `self help goals`),
  `apps/cli/src/connect.ts` (the managed block every session reads),
  `apps/dsh-plugin/src/tools.ts` and `apps/dsh-plugin/README.md` (the plugin
  entry route), `docs/reference/cli.md`
- Quality review: `docs/content-reviews/work-link-dispositions.en.md`
- Korean: none in this revision. The English guidance is revised in place, and
  no new Korean public copy is produced.

## Who the reader is

An agent session, or a person reading over one, that has just created or picked
up a work unit and has to say what the unit serves. They arrive through one of
three doors and expect the same answer at each:

- the CLI's own pages — `self work --help`, `self milestone --help`,
  `self help work`, `self help goals`;
- the managed block `self connect` writes into `AGENTS.md` and `CLAUDE.md`,
  which a session reads at start;
- the plugin's tool descriptions and its README, where the tool surface is five
  read-and-report tools and the rest of the graph is CLI commands.

They are not choosing a product. They are choosing a record kind and a
transition inside a workspace they already use.

## Evidence and inferences

| Type | Claim | Source | Cheapest disconfirming check |
| --- | --- | --- | --- |
| Observation | Work stayed on a superseded milestone; a live milestone kept assumptions a later decision had replaced | Issue #417, four recorded graph inconsistencies | Re-read the named records in the store |
| Observation | Before this change the only stated dispositions were `--objective` and `--milestone`; a unit that served neither had nothing to record | `apps/cli/src/goals.ts` `LINK_OPTIONS` at `origin/main` | `self work link --help` on the released CLI |
| Observation | A milestone had no way to name a decision it rested on | No `assumes` edge and no `milestone link` verb at `origin/main` | `self milestone --help` on the released CLI |
| Observation | The three entry routes each described linking in their own words, and only the CLI page described it at all | `connect.ts` carried one sentence; the plugin README carried none | Read the three surfaces at `origin/main` |
| Inference | Different agents reconstruct different methods because the guidance leaves the third case unstated | Issue #417 states this as a hypothesis, not a finding | Give fresh agents the same seeded store and compare the records they write |
| Inference | An unattached unit reads as an oversight, so an agent avoids leaving one and links it somewhere weak instead | No direct observation | Ask three sessions to record upkeep work under an unrelated objective and see whether they do |

The guidance states only what the commands do. It does not claim why past
agents chose what they chose.

## The one decision the content enables

The reader picks the disposition their unit actually has, and can act on it:

- it moves a stated outcome — `self work link <id> --objective <id>` or
  `--milestone <id>`;
- it moves none, on purpose — `self work link <id> --standalone --why
  "<reason>"`;
- it is one occurrence of a procedure this project repeats —
  `self runbook link <run> --work <id>`.

And, for a checkpoint, whether it names the decisions it rests on, and how it
replaces one that a later decision superseded.

## What the reader must be able to say back

- Stating nothing is not the same as standing alone. Nothing forces a
  disposition, and the tool refuses no unit for lacking one.
- A standalone declaration owes a reason and hides no existing link.
- A declaration is withdrawn by the same edge it was made with.
- An assumption is replaced by linking the successor decision and then
  unlinking the old one — two statements, never a rewrite.

## Included surfaces and explicit exclusions

Included: the five production surfaces named above, in English.

Excluded, and not to be mentioned by this revision:

- `self objective check`, its findings, the health summary and any recovery
  output — issue #417's part (c), which has shipped nothing;
- carry across revisions, target-open guards, the proposal retarget path, date
  rules, judgment provenance and recheck — part (b), which has shipped nothing;
- routine records (#451), progress percentages, prose classification, and any
  claim about strategy;
- Korean copy, marketing narrative, tutorials and new reader studies. The
  change is factual guidance for commands that exist, revised in place.

## Stop condition

The content is sufficient when each of the three entry routes offers the same
commands in the same terms, every command they offer is dispatchable on this
branch, and the reader can name the three dispositions and the assumption
replacement path. An independent reviewer supplies the publication verdict; the
author does not.
