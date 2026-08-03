# Run a long-term project across sessions and agents

Long-running projects outlive chat transcripts, context windows, individual
agents, and human memory. This guide shows how to keep the project's current
truth in Superself so that a fresh person or agent can recover it and continue
without a private handoff.

The workflow in this guide is available in the current alpha CLI. It uses
durable project state, not the future end-to-end autonomous execution loop.

> [!NOTE]
> This guide assumes Superself is installed and its workspace has been
> initialized. See [Getting started with Superself](getting-started.md) if this
> is your first project.

## What you will build

The example project has one durable direction and one time-boxed outcome:

> Ship a trustworthy beta to ten design partners.

You will record that outcome as a hierarchy of state:

```text
Goal
└─ Objective
   └─ Milestone + exit criteria
      └─ Work + reports
```

This is not a task tree. A goal holds enduring direction; an objective names a
time-bounded result; a milestone has evidence-coverable exit criteria; and a
work unit declares one required outcome. Decisions govern later work, while
reports preserve progress, evidence, and the next action.

## 1. Register the project and preserve its direction

Run `self setup` from the real git checkout to see how it resolves. If the
project is not registered yet, register it:

```bash
self project add
```

By default, registration also renders the managed Superself block into
`AGENTS.md` and `CLAUDE.md`. That block tells compatible agents to load current
state at session start and to update state through `self` rather than editing
derived files by hand.

Set the long-term goal once:

```bash
self goal set "Continuously ship trustworthy product improvements"
```

Record judgments that future work must respect:

```bash
self decide "Customer data remains local" \
  --why "The beta contains private design-partner data"

self convention add "Every customer-visible change needs rollback evidence"
```

## 2. Turn the direction into an objective and milestone

Create the result that matters for the current horizon:

```bash
self objective add "The beta is ready for ten design partners" \
  --horizon month \
  --success "Ten partners can complete the critical flow without a severity-one defect" \
  --stop "A privacy or data-integrity risk makes external use unsafe"
```

The command prints an objective id such as `o-xxxxx`. Use the real id in later
commands. Add a checkpoint beneath it:

```bash
self milestone add "The critical flow is release-ready" \
  --objective o-xxxxx \
  --exit "The end-to-end proof passes on the release candidate" \
  --exit "Rollback has been exercised and recorded"
```

The milestone prints an id such as `m-xxxxx`; its exit criteria receive stable
ids such as `c1` and `c2`. Add `--target YYYY-MM-DD` only for a real deadline.

## 3. Define work by its required outcome

Create one work unit for the release proof:

```bash
self work add "The beta release candidate passes the critical-flow proof and has a verified rollback path"
```

The command prints a work id such as `w-xxxxx`. Link the work to the
milestone it contributes to, then start it:

```bash
self work link w-xxxxx --milestone m-xxxxx
self work start w-xxxxx
```

## 4. Keep the current truth fresh while work runs

Report state-changing progress, friction, and the next action:

```bash
self report w-xxxxx \
  "The critical flow passes locally; the release-candidate run remains" \
  --next "Build the candidate and run the proof against its exact commit"
```

When the linked checkout has a git `HEAD`, `self report` records it by default.
Use `--evidence` when the report must name another commit explicitly. Add
`--artifact <path>` to copy a reusable result into the Superself store as an
immutable attachment.

When work cannot advance, record what it waits on and why:

```bash
self work block w-xxxxx --on dependency --why "The candidate build is not ready"
self work unblock w-xxxxx
```

## 5. Recover the project in a fresh session

A new person or agent starts with the generated current view:

```bash
self context
```

Then inspect what needs attention and recover the full work history:

```bash
self status
self work show w-xxxxx
```

Pull older or cross-project state only when needed:

```bash
self search "customer data"
self search "rollback" --project my-project
```

Before acting, the new session should be able to answer:

1. What enduring goal does this project serve?
2. Which objective and milestone are active now?
3. What must the current work unit prove?
4. Which decisions and conventions govern it?
5. What was the last evidence-backed result, and what happens next?

If one of those answers exists only in the old transcript, the handoff is not
durable yet. Add the missing decision or report before continuing.

`self context` is a bounded current projection with recovery pointers, not the
entire project history. `self work show` and `self search` are the pull path
when the current action needs more detail.

## 6. Complete work with evidence

After committing the verified result, attach the exact commit and final
artifact:

```bash
self report w-xxxxx \
  "The release-candidate proof and rollback exercise both passed" \
  --evidence <commit-sha> \
  --artifact path/to/critical-flow-result.json \
  --artifact path/to/rollback-receipt.json \
  --next "Cover the milestone criteria"
```

Replace the paths with files the work produced; missing files are refused. Run
`self artifact list --work w-xxxxx` to retrieve their stored ids.

```bash
self work done w-xxxxx
```

`self work done` is the judgment that the outcome was reached; the evidence
for it lives in the reports the unit carries.

Now cover the milestone's separate exit criteria:

```bash
self milestone met m-xxxxx \
  --criterion c1 \
  --why "The exact release candidate passed the end-to-end proof" \
  --work w-xxxxx \
  --evidence <commit-sha>

self milestone met m-xxxxx \
  --criterion c2 \
  --why "The rollback path was exercised successfully" \
  --work w-xxxxx \
  --evidence <commit-sha>

self milestone reach m-xxxxx
```

This records two different conclusions: the work delivered what it promised,
and its evidence covers the milestone checkpoint.

## 7. Revise current truth without erasing history

Plans change at different levels. `self objective revise` moves the result;
`self milestone revise` moves a checkpoint or its criteria. Each leaves
affected coverage stale — use `self milestone recheck` only when earlier
evidence applies.
Replace a judgment with `self decide ... --supersedes <decision-event-id>`;
never rewrite the old decision.

## What this guide does not automate

The shipped alpha provides the state and evidence workflow used above. It does
not yet complete the entire Company State Runtime loop:

- context selection is not yet reliably scoped for every work, attempt,
  domain, directive, and risk boundary;
- a natural-language direction does not yet compile through one stable public
  contract into an approved work graph;
- scheduling does not yet close the loop across every priority, dependency,
  approval, budget, capacity, failure, and newly freed resource;
- the viewer is not yet the conversational control surface for the workflow.

Those are target-contract responsibilities. Existing WorkSpec, attempt,
daemon, and integration foundations are outside this state-continuity guide.
Continue with the process ledger (`self work started/exited`) to
bind a run to capabilities and evidence. The
[governed conversion example](../examples/governed-conversion-improvement.md)
shows how the complete operating contract is intended to compose, while the
[integration train](../integration-train.md) documents the exact repository
review and merge gate available today.
