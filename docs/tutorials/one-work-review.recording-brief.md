# Recording brief: propose, review, and finish one work unit

Status: blocked on [#356](https://github.com/fxylabs/superself/issues/356).
Do not draft or publish the tutorial until the commands below exist in a
released `self` version and one real run has produced the source records.

## Required behavior

One user gives one bounded task to one agent. The agent inspects the project
and proposes the work plan. The user finds a material problem in that plan,
the agent revises the same work ID, and the user accepts the exact revision.
Only then does the agent start the work, implement it, verify it, attach a
report with commit evidence, and leave the user to judge completion.

The tutorial must show this state sequence:

```text
proposed v1 → proposed v2 → accepted/next → active → report + evidence → done
```

## Production surfaces

- Source of truth: the two active Markdown files that will replace this brief
  under `docs/tutorials/` after recording.
- Served copies: `superself-apps/src/content/tutorials/`, copied verbatim only
  after the source pair passes the content guide.
- Visual evidence: one actual agent terminal and isolated operator recordings
  under a new dated directory in `examples/`.

## Supported input and trust boundary

- One small, real task in a disposable Git repository created for the recording.
- One agent harness and one agent session.
- One project-local work proposal with no objective or milestone prerequisite.
- The existing `self` actor and acceptance boundary; the tutorial does not
  claim identity, authorization, scheduling, or automatic dispatch beyond it.

## Fact table to fill from the run

Every row needs the literal command, the unedited output or report path, and
the action the reader takes. A row without all three does not enter the draft.

| Claim | Required source record | Reader action |
| --- | --- | --- |
| A standalone plan can wait for review | `self work propose` command and output | inspect the proposed work with `self work show` |
| Review changes the plan rather than rubber-stamping it | the user's actual objection and plan v1 | identify the same omission in v1 |
| Revision keeps one work ID | revision command plus v1/v2 history | confirm that the ID did not change |
| Acceptance binds v2 | acceptance output and current work view | confirm that v2, not v1, is accepted |
| Execution starts only after acceptance | pre-accept refusal and post-accept start output | compare the two calls |
| The result is verifiable | final report, test output, and commit | match the report evidence to the commit |
| Completion is a judgment | `work done` output after evidence exists | confirm the final state |

## Explicit exclusions

- Installation and project registration; link to Getting Started.
- Objectives, milestones, several agents, several worktrees, scheduling, and
  cross-project work.
- Invented plan mistakes, reconstructed agent dialogue, edited product output,
  and commands recorded from an unreleased build.
- Conceptual explanations of event sourcing; link to the concept page.

## Stop condition

Evidence is sufficient when one released-version run supplies every fact-table
row, the Korean and English drafts are written separately from that table, all
commands are re-run successfully, and the authored prose passes the AI-tell
audit in `docs/content-guide.md`. Stop there; parallel delegation belongs to a
later case study.
