# CLI and record reference

This is the current reference for the `self` CLI in this checkout. The
implementation-owned command catalogue is the typed command contract composed
in [`apps/cli/src/main.ts`](../../apps/cli/src/main.ts): `self --help` renders
its root list, and `self <command> --help` renders one command's full syntax
and detail. This page explains the stable command
families and record contracts; the scoped help output remains the authority
for every option and subcommand.

The current alpha installs the `superself` package and exposes the `self`
command. `self --version` prints the version of the package the binary was
built from.

## Command surface

Run `self <command> --help` before copying a command into automation. IDs,
dates, paths, and event ids in examples are placeholders unless the command
prints them during the same run.

| Family | Current entry points |
| --- | --- |
| Workspace | `init [--lang <code>] [--agents]`, `workspace [<path>]`, `lang [<code>]`, `theme [<name>]`, `timezone [<zone>]`, `setup` |
| Projects and state remotes | `project [--archived]`, `project init [--name <slug>] [--desc <text>] [--no-connect]`, `project link [slug] [path|--here] [--force]`, `project unlink [slug] <path|--here> [--force]`, `project from <parent-slug> --why "<reason>" [--supersedes <id>]`, `project archive <slug> --why "<reason>"`, `project restore <slug> [--why "<reason>"]`, `remote add <url>`, `sync`, `clone <url> [dir]` |
| Outcomes | `goal add "<text>" [--supersedes <id>]`, `goal retract <id> --why "<reason>"`, `objective ...`, `milestone ...` |
| Decisions and conventions | `decide ...`, `convention add "<text>" [--workspace]`, `convention drop <event-id>` |
| Approving a reviewed set | `apply <file>` |
| Taking a destruction back | `undo <event-id> --why "<reason>"` |
| The entity grammar | `state ...` (the raw record every preset folds into), `alias ...` (the table behind the preset verbs) |
| Work and evidence | `work ...`, `report <work-id> "<summary>"`, `artifact ...` |
| Process ledger | `work started <id> --pid N`, `work exited <id> [--code N]` |
| Inspection and derived files | `context [--pretty\|--plain]`, `status [--pretty\|--plain]`, `search [query]`, `log [-n <count>]`, `fold`, `view [slug]` |
| Agent instructions | `connect [--global]` |
| Paid work APIs | `login`, `logout`, `whoami [--verify]`, `app install\|list\|update\|remove\|trust` |

The command catalogue currently includes these top-level verbs:

```text
init workspace lang theme timezone tokens project remote sync clone
goal objective milestone decide work report artifact convention state alias
undo apply
connect view context status setup
log search fold
login logout whoami app
```

### Reaching the paid work APIs

The `self` CLI is complete on its own and stays free; the work APIs behind
`app.superselfs.com` are paid cloud services this CLI can reach once a person
has approved a credential for it.

- `self login` runs a device approval: it prints a URL and a code, a person
  opens the page and confirms the exact scopes, and the credential is written
  to the config directory at mode `0600`. No event is appended to the project
  log — a credential is machine state, not project state.
- `self whoami` says what this machine holds, offline and free. `--verify`
  spends one unmetered probe against the rail.
- `self logout` deletes the local credential and names what is still live
  server-side, because an agent cannot revoke its own credential.
- `self app install <key>` downloads a signed mini-app release and verifies it
  before anything is written. There is no flag that skips the check and no way
  to install an unsigned one.
- What the CLI compiles in is a set of **root** public keys, not the keys that
  sign a mini-app. Which keys may sign one — and which have been revoked — is a
  short-lived document the rail serves at `GET /api/plugins/trust`, signed by a
  pinned root. So a signing key that leaks is withdrawn by publishing a new
  document, without shipping a new CLI, and a compromised rail can still serve
  only what a root signed.
- `self app trust` prints the document this machine is acting on: who signed it,
  when it expires, every key with its status, and the minimum version per
  mini-app. `--refresh` fetches it now. An install refuses unless it can fetch a
  current document; a load falls back to a valid cache, so an installed mini-app
  keeps working offline and a revocation reaches it within a day.

Commands that reach the rail accept `--json`: one object on stdout, snake_case
keys, and — on a failure — the error envelope on **stdout** as well, so an
agent capturing stdout gets parseable output on every path. Exit codes are
`0` ok, `1` error, `2` refused by policy, `3` pending and worth retrying
unchanged. `SUPERSELF_JSON=1` selects the same mode for a whole session and is
ignored by commands that have no machine contract, so exporting it never
changes what an existing verb prints.

Every rail call is recorded in a local journal at
`$XDG_STATE_HOME/superself/calls.jsonl`, mode `0600`, capped at 1000 lines. It
holds the time, the profile, the command, the call key, the exit code and the
refusal code — no request bodies, no recipients, no tokens. This is how an agent
that crashed mid-send recovers: it reads back the call key and retries the same
call, which is idempotent by construction. `--no-journal`, or
`SUPERSELF_NO_JOURNAL=1`, turns it off; the journal never travels anywhere.

**The CLI sends no telemetry.** The one thing a rail request carries beyond the
call itself is a client header naming versions — `self/0.7.0 plugin/email@0.1.0
contract/0` — and nothing else: no hostname, no path, no account beyond the
credential the request already authenticates with. Nothing is reported anywhere
for a command that makes no rail call, which is every command this CLI shipped
with.

Beyond that list, the alias table dispatches its own verbs: `self idea add`
and `self roadmap add` ship as built-in rows with no dedicated command, and
`self alias add <verb>` makes any user-added row callable the same way.

### Setting a project aside

`self project archive <slug> --why "<reason>"` takes a project out of the
default `self project` listing, `self context`, and every `--workspace`
aggregate, with its records and its open work exactly as they stand. It is not
retirement: open work neither blocks the archive nor is retired by it, the
command says how many open units went with the project, and nothing is recorded
into the project again until it comes back.

`self project restore <slug>` brings it back, with every work unit in the state
it was left. It takes an optional `--why` for the archive that should never
have been written. While a project is archived it stays readable — `self
project --archived` lists it with its reason, and `--project <slug>` reads it
as any other project, with one line saying it is set aside.

`self undo` does not take an archive back. Both verbs above name a slug and run
from anywhere in the workspace, while `undo` reads its project from the working
directory — and a project that is set aside frequently has no checkout on this
machine at all.

### Approving a reviewed set at once

Destroying a record is a person's call, so `decide retract`, `convention drop`,
`work retire` and the rest refuse to run from a process with no terminal. An
agent auditing project state produces many of those calls at once, and running
them one at a time prices the judgment per record instead of per decision.

`self apply <file>` is the one human action that covers the set. The file holds
one command per line, exactly as it would be typed, with or without the leading
`self`; blank lines and lines beginning with `#` are notes:

```text
# duplicates the audit found
self decide retract 01kz2n… --why "an exact duplicate of 01kz2m…"
self work retire w-abc12 --why "the outcome moved to w-def34"
```

Every line runs through the same contract, argument parse and handler a typed
command reaches, and every write is held until the whole set has been shown at
one prompt: each record's id, its own text, how long it has been confirmed,
what still points at it, and the reason the line gives for retiring it. Where a
line supersedes rather than withdraws, the reason is the successor it writes, so
the disclosure states that record's own words too — nothing is approved that was
not read. One typed confirmation records the set. Where the ids are short enough
to type back they are the challenge, as they are for a single command; a longer
set is confirmed by what is being done and to how many, with the disclosure
above it saying which.

A plan runs only the verbs that retire, retract or supersede a record. Anything
else — a verb that writes the store config, the git remote or an installed
app, or one that only reads — is refused before it runs, so a refused file
leaves nothing changed anywhere, not only in the event log.

Nothing is applied outside the file, and a file with one bad line applies
nothing at all. A line that records something rather than destroying a record,
one no command dispatches, one its own verb refuses, and one naming a record an
earlier line already names each refuse the whole file with nothing written. The
approved set lands as one write and one commit, so a line the writer itself
refuses — a reason holding an absolute path under this machine's home, a project
archived while the plan sat unapplied — stops the set with the earlier lines
still standing.

A plan is not read from stdin. The confirmation is typed at the terminal on the
same descriptor, so a piped file would leave nothing there to confirm at.

### The entity grammar

Every asserted record — goal, decision, convention, objective, milestone,
work, or a free-labeled entity — folds into one record kind with placement:

- `state add "<text>"` records an entity under any label; `state list` and
  `state show <id>` read every asserted record back, presets included.
- `state place <id>` moves an entity's placement — priority, exposure
  (`full|index|search`), and scope: which project renders it. Omit `--scope`
  for the project you are in, name another registered slug to move the record
  there, or `--scope workspace` to render it in every project. A move leaves
  every event where it is, so the record's brief, reports, artifacts, evidence
  and timestamps travel by not moving at all, and its writes keep landing in
  the log that owns it. A demotion records `--why`; demotion out of full is
  proposed by agents and confirmed by a person (`state confirm`).
- Retention caps (`fullTokens` and `indexTokens` in the store's `config.json`;
  defaults 1,000 and 12,000 context tokens, per scope) gate `state add`,
  `state place`, and the alias verbs into a tier: past a cap the verb refuses
  until `--demote <id>` names what frees the room, and every number in that
  refusal is a token count.
- `tokens` prints what one character costs in tokens, and records a
  measurement that replaces the shipped estimate. The caps and the piped
  context budget both read through it.
- `alias` prints and edits the table the preset verbs read their label and
  default placement from; built-in rows can be overridden and restored.

### Outcome and work commands

- `goal add` records a long-term project outcome. A project holds as many as
  it means to: recording one displaces nothing, the goal a new one replaces is
  named with `--supersedes <id>`, and `goal retract` withdraws one.
- `objective` manages time-boxed outcomes under the goal. Its states explain
  why an objective is open, confirmed, revised, reached, or dropped.
- `milestone` manages checkpoints and exit criteria under an objective. A
  milestone is reached only after every live criterion is covered by evidence;
  finishing a work unit does not reach it automatically.
- `decide` records a confirmed decision by default. `--proposed` records one
  awaiting confirmation; `decide confirm <event-id>` confirms it.
- `work` creates and moves outcomes, links them to objectives or milestones,
  records the process running a unit, and shows its evidence and recovery
  path. `work done` is the judgment that the outcome was reached, and the
  claim must carry evidence: a report with a commit or an artifact, or a
  done-time `--report` stating what verifiably happened. A bare claim is
  refused, and declared criteria gate done until each carries a coverage
  claim.
- `report` attaches a progress report, optional commit evidence, and optional
  artifacts to a work unit. A report records the current project HEAD as
  evidence unless another value is supplied.
- `report --design --implements <decision-id>` submits a design or scope
  proposal. It is refused unless every cited decision exists, still holds, and
  renders in the work unit's project, and the receipt prints each cited
  decision's own text. `report confirm <report-id>` is how a person approves
  one: it needs an interactive terminal and the design artifact's hash typed
  back, so the recorded approval names the exact bytes. `work start` then
  refuses a unit whose design is unapproved, whose approval names no hash, or
  whose decision has since been superseded or retracted — the way to change
  direction is to supersede the decision and cite the successor.

The full work transitions and flags are in the `work` declaration of
[`main.ts`](../../apps/cli/src/main.ts), and the completion rules are implemented by
[`completion.ts`](../../apps/cli/src/completion.ts).

### The process ledger

- `work started <id> --pid N` records the agent process running a unit; the
  pid stays in this machine's ledger and never enters the synced log.
- `work exited <id> [--code N]` records how it ended.
- Liveness is judged at read time: `self status` shows running while the pid
  answers `kill -0`, stale once it stops answering without an exit record.
- Merge control is not here. A branch reaches main through a GitHub pull
  request, owned by PR review and CI.

### Context and inspection commands

`self context` is the agent-facing projection of current project truth: placed
entities in priority order — full text, then the derived live state, then the
index lines — with pointers to what stays behind. A pipe, redirect, `--plain`,
`TERM=dumb`, or a terminal too narrow for a table receives the plain render. A
sufficiently wide interactive terminal receives the ruled render; `--pretty`
forces the ruled render. The plain project context is capped at 3,000 context
tokens, and omissions name the command that recovers the omitted state.

`self status` is the shorter attention and health projection. `self work show
<id>` is the pull path for one unit's complete recovery line. `self search`
answers over live records rather than the log: its default is every live record
the current context render does not show, returned as readable rows, and a
superseded, retired, retracted or done record is not in that answer.
`--exposure <tier>` reads one placement tier and `--all` reads every live
record. History is per record and explicit — `self state show <id> --history`
and `self work show <id> --history` page over one record's own events, and
there is no global history search. `self log` prints recent events, and
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
supersession, work, branch, blocked work, and decision sequencing.

The CLI writes one shared event grammar. Every asserted record uses the
`entity.*` namespace — `entity.proposed`, `entity.confirmed`,
`entity.superseded`, `entity.retracted`, `entity.placed`, `entity.linked`,
`entity.unlinked`, `entity.covered` — and the execution facts
`entity.started`, `entity.blocked`, `entity.unblocked`, `entity.done`,
`entity.retired`. Beside them, `report.added` records progress,
`report.confirmed` records a person's approval of a design report, and
`work.run-started` / `work.run-exited` record process transitions. Event
namespaces are owned; the current owners are listed in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#event-namespaces), and the
pre-cutover legacy names are read forever but written by no verb — see the
legacy-interpretation table in
[Company State and context](../concepts/company-state-and-context.md#legacy-records-read-as-entities).

### Derived work and report records

The folded work view contains the outcome id, status, blockers, reports,
evidence, artifacts, branches, the last-reported process transition, linked
objectives or milestones, and the next action. It is derived from events; a
surface must not assert a status independently of the fold. Attempt history
from logs written before the simplification still folds and renders
read-only.

A report may carry:

- commit revisions, which are resolved against the project repository;
- descriptive notes, which are retained but never treated as Git revisions;
- attached artifacts;
- the next action for a later session; and
- on a design report, the decisions it implements and the approval bound to
  its artifact hash.

Artifact metadata in the folded project state is `{id, name, path, digest?}`.
The declared artifact shape everywhere else is `{name, sha256, bytes}` —
`name`, never `path`.

## Source of truth and drift boundary

This page intentionally does not duplicate every flag and refusal sentence.
When this page and scoped help disagree, the checked-out implementation-owned
help is authoritative and the page needs maintenance. Claims about whether a
workflow is shipped, partial, or future belong to the
[roadmap](../roadmap.md), not to an illustrative command example.

Three of this page's claims are checked mechanically by the test tier rather
than by reading:

- the top-level verb catalogue above must match the typed command contract
  exactly;
- event names this documentation set mentions must belong to the vocabulary
  the CLI actually writes — legacy names may appear only under a heading that
  contains the word "legacy";
- concrete command examples in the user-facing documents are executed against
  a scratch workspace. A ```` ```bash ```` or ```` ```sh ```` line starting
  with `self ` runs, in order per document, and must succeed — unless its
  trailing comment contains `# refused`, in which case it must be refused.
  Lines carrying a placeholder (`<...>` or an `xxxxx` id) and the network
  verbs `remote`, `sync`, and `clone` are excluded by rule; `cd` lines steer
  the scratch working directory, and every directory an example enters exists
  as a git repository before the run.
