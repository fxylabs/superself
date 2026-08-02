# Govern one agent execution with explicit boundaries and evidence

Delegating execution does not mean giving up control. Superself lets an
operator declare what one work unit must produce, what an agent may reach, and
what evidence the run must return before the result is accepted.

This guide uses the supervised-attempt foundation available in the current
alpha CLI. It does not claim that natural-language intent already compiles into
an approved plan or that Superself autonomously schedules an entire work graph.

> [!NOTE]
> Start with an active work unit and live requirements. The
> [long-running project guide](running-a-long-term-project.md) shows how to
> create them and how work completion relates to milestone completion.

## What you will govern

The example continues the trustworthy-beta project. An agent will prepare two
internal artifacts for the release candidate:

- a critical-flow proof result;
- a rollback exercise receipt.

The operator controls the run through three separate contracts:

```text
Work + requirements          what the outcome must cover
        ↓
WorkSpec                     how an agent may execute it
        ↓
Attempt result gate          what the run actually proved and produced
        ↓
Work completion gate         whether the business outcome is complete
```

A passing attempt does not mark the work done. It records a validated run and
attaches its report and artifacts; requirement coverage and completion remain
separate judgments.

## 1. Decide what still belongs to a person

Suppose the work id is `w-xxxxx` and its requirements already describe the two
artifacts. If a person must authorize this work before an agent starts, declare
that gate:

```bash
self work approval-required w-xxxxx \
  --why "A person must approve agent execution against the release candidate"
```

This is a work-level gate. It blocks dispatch and final completion until a
person grants it from an interactive terminal:

```bash
self work approve w-xxxxx --by maintainer
```

An agent attempt cannot approve its own work. Superself marks runner children
and refuses `work approve` from inside one.

You may also declare an implementation policy, such as a required model class:

```bash
self work policy w-xxxxx --model opus \
  --why "Release evidence requires the designated implementation model"
```

Only set a policy you can satisfy and evidence. A `--fresh-review` policy also
needs an independent review receipt; the
[integration train](../integration-train.md) documents that receipt and merge
boundary.

## 2. Write the execution contract as a WorkSpec

A WorkSpec is versioned desired state for one work unit. It binds the provider,
requested model, invocation, capability boundary, expected artifacts,
validation, timeouts, and retry limit before a process starts.

Save the following as `release-proof.workspec.json`. Replace `w-xxxxx` with the
real work id. The provider command is illustrative: use a provider CLI that is
installed and authenticated on your machine, and keep `requestedModel` aligned
with the model that command actually requests.

```json
{
  "workSpecId": "ws-release-proof",
  "generation": 1,
  "workId": "w-xxxxx",
  "role": "implementation",
  "summary": "Prepare the release-candidate proof and rollback receipts",
  "provider": {
    "name": "claude-cli",
    "endpoint": "https://api.anthropic.com"
  },
  "requestedModel": "opus",
  "command": [
    "claude",
    "--model",
    "opus",
    "-p",
    "Read the checked-out project and run its existing critical-flow and rollback checks. Stage critical-flow-result.json and rollback-receipt.json under $SUPERSELF_ATTEMPT_OUT. Then write the required structured result envelope to $SUPERSELF_ATTEMPT_RESULT with status completed and exact artifact name, sha256, and bytes values. Do not publish, deploy, contact customers, or modify policy."
  ],
  "boundary": {
    "wrapper": [],
    "cwd": ".",
    "passthrough": ["PATH", "HOME", "LANG", "TMPDIR", "XDG_CONFIG_HOME"],
    "env": {}
  },
  "capabilities": {
    "context": true,
    "read": ["."],
    "write": ["artifacts"],
    "domains": ["api.anthropic.com"],
    "tools": ["claude"],
    "secrets": [],
    "self": false
  },
  "artifacts": [
    {"name": "critical-flow-result.json", "dest": "artifacts/critical-flow-result.json", "minBytes": 2},
    {"name": "rollback-receipt.json", "dest": "artifacts/rollback-receipt.json", "minBytes": 2}
  ],
  "validation": {
    "responseSchema": {
      "status": "completed",
      "artifacts": ["critical-flow-result.json", "rollback-receipt.json"]
    }
  },
  "timeoutPolicy": {"runMs": 1200000, "preflightMs": 15000, "heartbeatMs": 5000},
  "retryPolicy": {"maxRuns": 2, "baseMs": 1000, "maxMs": 10000},
  "resume": true
}
```

The important choices are not the JSON punctuation:

- `boundary` defines the process directory and the host environment it may
  inherit;
- `capabilities` declares filesystem, network, tool, secret, context, and
  `self` access before provider invocation;
- `artifacts` names what the agent stages and where the runner may publish it;
- `validation` states what a completed result envelope must contain;
- timeout and retry policies bound how long and how often the run may execute.

The example allows internal repository reads and two local artifact writes. It
does not authorize publication, outreach, payment, provisioning, destructive
actions, or policy changes.

## 3. Validate before changing project state

Ask whether the file can compile into an attempt plan:

```bash
self spec validate release-proof.workspec.json
```

Validation checks the schema, paths, capability declaration, artifact contract,
timeouts, retry policy, and result-validation shape without applying a
generation or writing a project event. It does not install the provider CLI or
create credentials; capability preflight checks the runtime machine later.

## 4. Apply one immutable generation

Once the execution contract is ready, apply it:

```bash
self spec apply release-proof.workspec.json
self spec show ws-release-proof
```

Generation 1 is sealed by content hash and becomes the WorkSpec HEAD for the
work unit. Applying the same bytes again is idempotent. Changed content must be
generation 2; it never overwrites generation 1.

An attempt is pinned to the generation, digest, and requested model admitted at
dispatch. Applying a later generation changes the next dispatch, not a process
already running.

## 5. Dispatch the exact generation

After any required human approval has been granted, dispatch the current
generation:

```bash
self spec dispatch ws-release-proof
```

Before reaching the provider, the runner performs capability preflight. Missing
tools, unreadable inputs, unwritable destinations, unavailable provider
endpoints, or undeclared required access fail as capability problems rather
than consuming the full agent run first.

Only one live attempt may drive a work unit at a time. The attempt receives its
own durable local spool for lifecycle state, stdout, stderr, checkpoints,
directives, and the structured result.

## 6. Inspect state instead of watching every terminal line

From another terminal, list and inspect the attempt:

```bash
self attempt list --work w-xxxxx
self attempt show at-xxxxx
```

Use the real attempt id printed by the CLI. Raw output remains in the
machine-local spool; canonical project state receives normalized lifecycle,
failure, report, evidence, and artifact records rather than the whole terminal
transcript.

When the run needs a bounded clarification, send it through the spool:

```bash
self attempt directive at-xxxxx \
  "Use the existing rollback proof; do not introduce a deployment step"
```

When the original contract is no longer safe or useful, cancel it:

```bash
self attempt cancel at-xxxxx
```

A directive is not a way to grant a new capability. If the desired execution
boundary changes, create and apply the next WorkSpec generation.

## 7. Recover interruption without inventing success

After a CLI, provider, or machine interruption, reconcile local attempt state:

```bash
self attempt recover
```

Recovery distinguishes a still-running process, a confirmed exit, an
interrupted attempt, and an attempt whose provider finished but whose durable
settlement did not. If an exited attempt remains unsettled, inspect it and use:

```bash
self attempt settle at-xxxxx
```

Transient provider and network failures may retry only within the declared
retry policy. Capability, validation, cancellation, and policy failures are not
silently reclassified as successful work.

## 8. Require a structured result, not a success sentence

For the example to pass, the provider must write a result envelope to
`$SUPERSELF_ATTEMPT_RESULT` resembling:

```json
{
  "status": "completed",
  "summary": "The release proof and rollback exercise passed",
  "artifacts": [
    {
      "name": "critical-flow-result.json",
      "sha256": "<64 lowercase hexadecimal characters>",
      "bytes": 842
    },
    {
      "name": "rollback-receipt.json",
      "sha256": "<64 lowercase hexadecimal characters>",
      "bytes": 611
    }
  ]
}
```

The hashes and byte counts must be computed after the last artifact write. The
gate verifies that every required artifact exists in the attempt output,
matches the envelope, and satisfies `minBytes`, publishes it atomically, then
runs any declared artifact validation command. If that validation fails, the
published artifact is unpublished.

An exit code of zero, a prose claim that the work is done, a missing envelope,
or an artifact with different bytes all fail the result gate.

## 9. Decide work completion separately

A validated attempt attaches one report and its published artifacts to the work
unit. Inspect what actually landed:

```bash
self work show w-xxxxx
self artifact list --work w-xxxxx
```

Then cover each requirement with the attached report, commit, or artifact ids
and attempt `self work done` as described in the long-running project guide.
Completion is refused while any live requirement, human approval, required
model, or fresh-review policy remains unsatisfied.

This separation matters: an agent can execute its declared plan correctly while
the larger product outcome still needs more evidence or human judgment.

## What this guide does not automate

The current alpha provides versioned WorkSpecs, provider-neutral attempt plans,
capability preflight, durable spools, directives, cancellation, bounded retry,
recovery, structured results, artifact validation, work-level approval, and
evidence-backed completion gates.

It does not yet provide the complete Company State Runtime execution loop:

- a natural-language direction does not automatically become an approved
  WorkSpec or coordinated work graph;
- the current work-level approval is not a general exact-plan approval in which
  an agent presents hypotheses and a proposed plan, waits, and then resumes only
  that approved plan;
- `attempt propose --action` records or refuses an action proposal, but it is not
  yet a general approval-and-resume protocol for every consequential action;
- scheduling does not yet close the loop across every priority, dependency,
  budget, capacity, failure, and newly freed resource;
- the read-only viewer is not yet where a person approves, interrupts, redirects,
  and observes execution conversationally.

The [governed conversion example](../examples/governed-conversion-improvement.md)
shows the target exact-plan and consequential-action approval loop. The
[integration train](../integration-train.md) documents the shipped review and
human merge gate for repository changes.
