# CLI and record reference

This is the current reference for the `self` CLI in this checkout. The
implementation-owned command catalogue is [`apps/cli/src/help.ts`](../../apps/cli/src/help.ts):
`self --help` renders its root list, and `self <command> --help` renders one
command's full syntax and detail. This page explains the stable command
families and record contracts; the scoped help output remains the authority
for every option and subcommand.

The current alpha installs the `superself` package and exposes the `self`
command. It does not expose `self --version`; use `self --help` as the
installation check for this release.

## Command surface

Run `self <command> --help` before copying a command into automation. IDs,
dates, paths, and event ids in examples are placeholders unless the command
prints them during the same run.

| Family | Current entry points |
| --- | --- |
| Workspace | `init [--lang <code>] [--agents]`, `workspace [<path>]`, `lang [<code>]`, `theme [<name>]`, `timezone [<zone>]`, `setup` |
| Projects and state remotes | `project add [path] [--name <slug>] [--desc <text>] [--no-connect]`, `project link [slug] [path]`, `remote add <url>`, `sync`, `clone <url> [dir]` |
| Outcomes | `goal set "<text>"`, `objective ...`, `milestone ...` |
| Decisions and conventions | `decide ...`, `convention add "<text>"`, `convention drop <event-id>` |
| Work and evidence | `work ...`, `report <work-id> "<summary>"`, `artifact ...` |
| Execution | `spec ...`, `attempt ...`, `daemon ...`, `overnight ...`, `digest ...` |
| Integration and review | `integration ...`, `review ...` |
| Inspection and derived files | `context [--pretty\|--plain]`, `status [--pretty\|--plain]`, `search [query]`, `log [-n <count>]`, `fold`, `view [slug]` |
| Agent instructions | `connect [--global]` |

The command catalogue currently includes these top-level verbs:

```text
init workspace lang theme timezone project remote sync clone
goal objective milestone decide work report integration review spec attempt
daemon overnight digest artifact convention connect view context status setup
log search fold
```

### Outcome and work commands

- `goal set` records the long-term project outcome; the latest goal wins.
- `objective` manages time-boxed outcomes under the goal. Its states explain
  why an objective is open, confirmed, revised, reached, or dropped.
- `milestone` manages checkpoints and exit criteria under an objective. A
  milestone is reached only after every live criterion is covered by evidence;
  finishing a work unit does not reach it automatically.
- `decide` records a confirmed decision by default. `--proposed` records one
  awaiting confirmation; `decide confirm <event-id>` confirms it.
- `work` creates and moves outcomes, links them to objectives or milestones,
  records requirements and approvals, and shows their evidence and recovery
  path. `work done` is a completion gate, not a status shortcut.
- `report` attaches a progress report, optional commit evidence, and optional
  artifacts to a work unit. A report records the current project HEAD as
  evidence unless another value is supplied.

The full work transitions and flags are in [`help.ts`](../../apps/cli/src/help.ts)
under `work`, and the completion rules are implemented by
[`completion.ts`](../../apps/cli/src/completion.ts).

### Execution and review commands

- `spec validate|apply|dispatch|list|show` handles immutable work-spec
  generations and dispatches a pinned generation as an attempt.
- `attempt run|register|started|heartbeat|exited|list|show|directive|cancel|propose|settle|recover|prune|retention|breaker`
  runs or manages the durable attempt spool.
- `daemon start|stop|status|tick|circuits` supervises attempts without a chat
  turn; `overnight` defines a bounded unattended-dispatch policy and `digest`
  reports what happened in its time window.
- `integration` manages change sets, leases, integration attempts,
  observations, approvals, merges, promotion, and reconciliation.
- `review request|ingest|list|contract` creates review obligations and admits
  receipts. A review receipt exists only after `review ingest` accepts its
  envelope.

The integration record and merge gate are described in
[`docs/integration-train.md`](../integration-train.md). The implementation
surfaces are [`integration.ts`](../../apps/cli/src/integration.ts),
[`envelope.ts`](../../apps/cli/src/envelope.ts), and
[`help.ts`](../../apps/cli/src/help.ts).

### Context and inspection commands

`self context` is the agent-facing projection of current project truth. A pipe,
redirect, `--plain`, `TERM=dumb`, or a terminal too narrow for a table receives
the plain render. A sufficiently wide interactive terminal receives the ruled
render; `--pretty` forces the ruled render. The plain project context
is capped at 12,000 characters, and omissions name the command that recovers
the omitted state.

`self status` is the shorter attention and health projection. `self work show
<id>` is the pull path for one unit's complete recovery line. `self search`
finds older or cross-project state, `self log` prints recent events, and
`self fold` re-derives canonical files and views from the event log.

## Canonical and derived records

Superself keeps canonical project state in the workspace's `.superself` Git
store. Project checkouts contain the managed agent-instruction blocks and a
machine-local `.self` connection marker; the marker is not the project
identity or the canonical history.

### Event record

Every canonical state change is a `SelfEvent` in the event log:

```json
{
  "id": "<event-id>",
  "ts": "<ISO-8601 timestamp>",
  "type": "<owned.namespace.verb>",
  "origin": {
    "actor": "agent|human",
    "confirmed": true
  },
  "project": "<project-slug>",
  "payload": {},
  "refs": {
    "commits": ["<git-revision>"],
    "artifacts": ["<artifact-id>"]
  }
}
```

`refs` is optional. Its other supported links include confirmation and
supersession, work, attempt, branch, blocked work, and decision sequencing.
Event namespaces are owned; the current owners and names are listed in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#event-namespaces).

### Derived work and report records

The folded work view contains the outcome id, status, blockers, requirements,
reports, evidence, artifacts, branches, attempts, completion policy, linked
objectives or milestones, and the next action. It is derived from events; a
surface must not assert a status independently of the fold.

A report may carry:

- commit revisions, which are resolved against the project repository;
- descriptive notes, which are retained but never treated as Git revisions;
- attached artifacts; and
- the next action for a later session.

Artifact metadata in the folded project state is `{id, name, path, digest?}`.
The separate runner result envelope uses the stricter declared artifact shape
`{name, sha256, bytes}`. `name`, not `path`, is the portable result-envelope
field; see [`CONTRIBUTING.md`](../../CONTRIBUTING.md#result-envelope-contract).

### Review envelope

The review runner writes a JSON envelope with schema
`superself.review-result/1`. It identifies the change set, review scope, exact
base and head, diff digest, verdict, findings, test results, an artifact
(`path`, `sha256`, `bytes`), reviewer identity, and completion time. The CLI
validates the envelope and its artifact before recording a receipt; prose or an
exit code alone does not create one. The exact TypeScript contract is
[`envelope.ts`](../../apps/cli/src/envelope.ts).

## Source of truth and drift boundary

This page intentionally does not duplicate every flag and refusal sentence.
When this page and scoped help disagree, the checked-out implementation-owned
help is authoritative and the page needs maintenance. Claims about whether a
workflow is shipped, partial, or future belong to the
[roadmap](../roadmap.md), not to an illustrative command example.
