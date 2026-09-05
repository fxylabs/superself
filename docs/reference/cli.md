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
| Workspace | `init [--git\|--cloud] [--workspace <id>] [--lang <code>] [--agents]`, `workspace [<path>]`, `lang [<code>]`, `theme [<name>]`, `timezone [<zone>]`, `setup` |
| Projects and state remotes | `project [--archived]`, `project init [--name <slug>] [--desc <text>] [--no-connect]`, `project link [slug] [path|--here] [--force]`, `project unlink [slug] <path|--here> [--force]`, `project from <parent-slug> --why "<reason>" [--supersedes <id>]`, `project archive <slug> --why "<reason>"`, `project restore <slug> [--why "<reason>"]`, `remote add <url>`, `sync`, `clone <url> [dir]` |
| Outcomes | `goal add "<text>" [--supersedes <id>] [--workspace]`, `goal retract <id> --why "<reason>"`, `objective ...`, `milestone ...` |
| Decisions and conventions | `decide ...`, `convention add "<text>" [--workspace] [--public] [--artifact <id\|path>]`, `convention drop <event-id>` |
| Approving a reviewed set | `apply <file>` |
| Taking a mistaken record back | `undo [<event-id>] [--supersession] [--why "<reason>"]` |
| The entity grammar | `state ...` (the raw record every preset folds into), `alias ...` (the table behind the preset verbs) |
| Reusable procedures | `runbook add "<name>" --stage s`, `runbook show <id|name>`, `runbook revise <id> --stage s --why w`, `runbook start <id> --instance <key>`, `runbook advance <key> --why w`, `runbook hold\|approve\|stop\|resume\|link <key>` |
| Reusable skills | `skill [--project <slug>]`, `skill add "<name>" --command "<line>" --purpose "<what it is for>" [--workspace]`, `skill add "<name>" --file <path> --purpose "<what it is for>"`, `skill show <id\|name>`, `skill drop <id\|name> --why w` |
| Instructions | `instruction [list]`, `instruction add "<text>" --kind rule\|tool\|procedure [--priority n] [--workspace\|--scope <slug>] [--supersedes <id>] [--proposed] [--why w]`, `instruction render [--project <slug>] [--json]` |
| Work and evidence | `work ...`, `report <work-id> "<summary>"`, `handoff <work-id> [--project <slug>]`, `artifact ...` |
| Store size and maintenance | `store size [--json]`, `store compact` |
| Process ledger | `work started <id> --pid N`, `work exited <id> [--code N]` |
| Inspection and derived files | `context [--pretty\|--plain]`, `status [--pretty\|--plain]`, `search [query]`, `log [-n <count>]`, `fold`, `view [slug]` |
| Recurring friction | `sweep [--since <window>] [--record]` |
| Agent instructions | `connect [--global]` |
| Paid work APIs | `login`, `logout`, `whoami [--verify]`, `app install\|list\|update\|remove\|trust` |

The command catalogue currently includes these top-level verbs:

```text
init workspace lang theme timezone tokens project remote sync clone
goal objective milestone decide work handoff report artifact store convention state alias runbook skill instruction
undo apply
connect view context status setup
log search fold sweep
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

Commands that reach the rail accept `--json` — one object on stdout,
snake_case keys — and so do the two local reads that declare a payload of
their own, `store size` and `instruction render`, each in its own shape. On a
failure the error envelope prints on **stdout** as well, so an agent capturing
stdout gets parseable output on every path. Exit codes are `0` ok, `1` error,
`2` refused by policy, `3` pending and worth retrying unchanged.
`SUPERSELF_JSON=1` selects the same mode for a whole session and is ignored by
commands that have no machine contract, so exporting it never changes what an
existing verb prints.

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

### Taking a mistaken record back

A record that turns out to be a plain mistake — a unit added with the wrong
outcome, a wrong `done`, a wrong link — is undone rather than superseded.
Supersession says an outcome moved to a successor; an undo says nothing was
there to move.

```bash
cd ~/undo-demo
self project init
self decide "prefer the streaming client for large payloads"
self undo
```

`self undo` with no id takes back the newest append, which is the one the
receipt was just printed for. Naming the event id takes back that one instead,
and any unambiguous prefix of it resolves. No `--why` is owed: "this was a
mistake" is the whole statement, and the annulment names the event it reversed.

Nothing is deleted. The undo is itself an event, both halves stay in `self log`,
and the row it took back is marked `· undone`. A record whose creation was
undone still answers to `self work show <id>` — it reads `Status: undone`, so a
reader who followed the id out of a commit message is told it was a mistake
rather than told the id is unknown.

An append that was one state change comes back whole: `work done --report`
writes the report and the completion together, and undoing either takes back
both. An append that was several unrelated changes does not — undoing one of
`self sweep --record`'s proposals leaves the others standing.

A record something was already built on is refused, with the list of what
stands on it and the lines to take those back first. Undo never cascades.

Some kinds are refused by name, each naming the verb that does the job instead:
a person's ruling on a design report, a registered artifact or a prune, a
project archive or restore, process telemetry, and an undo itself.

`--supersession` narrows an undo of a record that displaced another: the record
stands and only its claim to replace the older one is taken back.

Every mutating command's receipt prints the record it actually resolved and the
exact line that takes it back, so a wrong id is caught before anything is built
on it. `--meant "<what you meant>"` adds the caller's own restatement beside it
and records it on the event; it is printed, never judged.

### Applying a reviewed set at once

`decide retract`, `convention drop`, `work retire` and the rest each state what
they destroy and then record it. An agent auditing project state produces many
of those calls at once, and writing them one at a time is many appends any one
of which can be the one that fails.

`self apply <file>` runs the set as one append. The file holds one command per
line, exactly as it would be typed, with or without the leading `self`; blank
lines and lines beginning with `#` are notes:

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
  until `--demote <id>` names what frees the room in that tier, and every number
  in that refusal is a token count.
- `instructionTokens` (default 2,000 context tokens, per render target — this
  project or the workspace) is the third cap, and the only one an instruction
  charges: an instruction is outside the context projection the two retention
  tiers exist to bound, so it charges neither of them at any exposure. Past it
  `instruction add` — and a raw `state add --label instruction` — refuses.
  `--demote` frees nothing here: `instruction add` declares no such flag, so
  the parser refuses it as `unknown option '--demote'`, and a raw `state add
  --label instruction --demote <id>` is refused by name — the room is made
  among the instructions, by retiring one or superseding one with a shorter
  text, or by raising `instructionTokens` in `config.json`. `self instruction`
  closes with the share of it this project's manual holds.
- `state add --artifact <id|path>` and `convention add --artifact <id|path>`
  point a record at a registered artifact — the guide a rule is too short to
  state. One per record; a second `--artifact` is refused by name. Pass an
  `a-` id this project already stores, or a path, which is registered first
  and referenced second. Context renders the record's text followed by
  `` — see `self artifact open <id>` ``, and **only that pointer counts against
  the retention cap** — the artifact's own bytes never do, which is what lets
  a one-line rule carry a twelve-thousand-character guide. Restating the rule
  with `--supersedes` is how the reference is changed.
- `tokens` prints what one character costs in tokens, and records a
  measurement that replaces the shipped estimate. The caps and the piped
  context budget both read through it.
- `alias` prints and edits the table the preset verbs read their label and
  default placement from; built-in rows can be overridden and restored.

### Reusable procedures

A runbook is a procedure this project repeats — plan, draft, review, publish,
measure — kept as one record instead of scattered across decisions and
reports. Every run of it carries its own place in the procedure, so a session
that has just started reads the resume point out of `self context` alone.

**Registering a runbook schedules nothing and dispatches nothing.** No verb
advances a stage on its own and there is no timer: a person starts a run, and
a person — or the agent they asked — passes each stage explicitly.

```text
self runbook                                        # the procedures registered here
self runbook add "content loop" --stage plan --stage draft --stage publish
self runbook add "content loop" --file docs/loops/content.md
self runbook show <id|name>
self runbook revise <id> --stage plan --stage review --why "a review step was missing"
self runbook start <id> --instance E001
self runbook advance E001 --why "the assets are made"
self runbook advance E001 --to review --why "the cut was reviewed"
self runbook hold E001 --why "the final cut needs a look"
self runbook approve E001 --by <person>       # --by records who approved
self runbook link E001 --work <work-id>
self runbook stop E001 --why "the story was dropped"
self runbook resume E001
```

- **No new event type exists for any of this.** A definition is an entity
  labelled `runbook` whose stages are its reserved `criteria`; a run is an
  entity labelled `runbook-run` that copied those stages and links `member-of`
  the edition it started under; passing a stage is one `entity.covered`. So
  `state show`, `search`, `log` and the retention caps all answer for a runbook
  exactly as they answer for every other record.
- **The record is the authority, not the file.** `--file` reads the first
  markdown list in a document once, at the moment of the add, and the path is
  never recorded. Editing that file afterwards changes nothing; changing the
  procedure means `runbook revise`.
- **An edition is a place in the supersedes chain, derived and never stored.**
  `runbook revise` proposes a new record carrying the new stages and a
  `supersedes` link; `self state confirm <id>` is what makes it hold. The
  chain's root id is the **stable workflow id** — every render points at it,
  whatever edition is current.
- **A run copies its stages**, so a later edition can never silently change
  what a run in flight means. Where the two differ, context says which edition
  the run is following — `v1 (the definition is on v2)` — and the run keeps
  advancing. A revision is something to see, not something that stops the work,
  and an edition that only renamed the procedure raises no note at all, because
  the stages' fingerprint did not move.
- **There is no completion verb here.** Once every stage is passed,
  `self state done <id> --report "<what verifiably happened>"` closes the run;
  `runbook advance` prints that exact command. A wrapper would be a second
  implementation of the evidence gate, free to disagree with it.
- **A human checkpoint is a block, and the release is a record of the answer.**
  `runbook hold` parks the run — `entity.blocked` marked `on: "approval"` — and
  `advance` refuses until it is released. `runbook approve` is the release, and
  a session records it once the person has answered: the release is
  `entity.unblocked`, which `self undo` takes straight back, so the event states
  whether a person or an agent session wrote it rather than demanding a
  keyboard. `--by` records who approved and **gates nothing**. A held run
  renders in `## Waiting on you` with the command that releases it, in both the
  piped and the terminal render.
- The two state refusals — already held, not held — are the sentences
  `state block` and `state unblock` already write, called from where they are
  written rather than copied.
- `runbook stop` gives a run up (`entity.retired`, so it is terminal and a new
  run is started rather than the old one resumed); `runbook resume` picks a
  parked one back up. `runbook link <key> --work <id>` states which work unit
  is carrying the run, and a run may name more than one.
- `list` and `show` read, so they take `--project <slug>`. Every other verb
  writes, so it takes no read-scope flag and records into the project it runs
  in.

### Reusable skills

A skill is operational know-how this project reuses and neither a rule nor a
procedure covers: the exact command that deploys, the flag soup that runs one
test file against the right environment, the short recipe for a task that comes
up every few weeks. Registered once, it appears in `self context` as a name and
a one-line purpose, so a session that has just started discovers what exists
without being told.

```bash
cd ~/my-project
self project init
self skill add "deploy staging" --command "make deploy ENV=staging" --purpose "push the built image to staging"
self skill
self skill show "deploy staging"
self skill run "deploy staging"   # refused — a skill is printed, never run
```

Its other forms, where a placeholder stands for something you supply:

```text
self skill add "release notes" --file docs/recipes/release-notes.md --purpose "draft the notes from merged PRs"
self skill add "deploy staging" --command "make deploy ENV=staging" --purpose "..." --workspace
self skill add "deploy staging" --command "make deploy ENV=staging TAG={{tag}}" --purpose "..."
self skill list --project <slug>
self skill drop "deploy staging" --why "the deploy moved to the pipeline"
```

- **A skill is printed, never run.** There is no verb that executes one, and
  `self skill run` is a refusal that says why: this store is synced between
  machines and clones, so a line it holds can be appended anywhere and would
  execute everywhere. `skill show` hands the line over and the caller runs it.
- **No new event type exists for any of this.** A skill is an entity labelled
  `skill` whose name is its text, whose purpose is its `why`, whose one line is
  its reserved `criteria`, and whose longer recipe is its reserved `artifact`.
  So `state show`, `search`, `log`, `undo` and the retention caps answer for a
  skill exactly as they answer for every other record.
- **`--file` registers the recipe as an artifact and never records the path.**
  The bytes are read once, at the add, so editing that file afterwards changes
  nothing; the pointer counts against the retention cap and the document does
  not. `self artifact prune` refuses to remove bytes a live skill points at.
- **Correcting a skill is registering it again under the same name.** That
  proposes a new version carrying a `supersedes` link, and `self state confirm
  <id>` is what lands it — the previous version stays in the record's history,
  which is what `skill show` prints as its version list. A restatement that
  changes neither the line nor the purpose is refused rather than recorded.
- **A placeholder — `{{tag}}` — is recognised and listed, never filled.** `skill
  add` refuses a malformed one, so a record can never promise a hole no caller
  can find, and no flag substitutes one: the caller fills it where they paste
  the line.
- **A project skill shadows a workspace skill of the same name**, and the shadow
  is disclosed everywhere — at the add, in the listing, on the page, and in
  `self context`, which carries one row for the skill a name actually reaches.
- `list` and `show` read, so they take `--project <slug>`. `add` and `drop`
  write, so they take no read-scope flag and record into the project they run
  in. `drop` is a withdrawal like any other: what it destroys is disclosed
  first, and `self undo` takes it back.

### Outcome and work commands

- `goal add` records a long-term project outcome. A project holds as many as
  it means to: recording one displaces nothing, the goal a new one replaces is
  named with `--supersedes <id>`, and `goal retract` withdraws one.
- `goal add --workspace` and `objective add --workspace` record the whole
  workspace's direction rather than one project's. The record stays in the
  store of the project it was recorded in, and it renders in every registered
  project's context — a workspace objective above that project's own — and once
  above the project lines of the workspace context. Its retention cap is the
  workspace tier's, not any project's, and a project holding one cannot be
  archived until the record is withdrawn or closed.
- `objective` manages time-boxed outcomes under the goal. Its states explain
  why an objective is open, confirmed, revised, reached, or dropped.
- `milestone` manages checkpoints and exit criteria under an objective. A
  milestone is reached only after every live criterion is covered by evidence;
  finishing a work unit does not reach it automatically. `milestone show` reads
  the linked work beside those criteria, under `## Linked work`: each unit's
  working state — with the dependency a blocked one waits on — how many of the
  criteria it declared are covered, which session holds it, and the first line
  of its latest report. Those lines are the console's alone; the canonical
  page a fold writes carries none of them, because who holds a unit is a
  judgment about this machine's sessions.
- `decide` records a confirmed decision by default. `--proposed` records one
  awaiting confirmation; `decide confirm <event-id>` confirms it.
- `work link <id>` states what a unit contributes to, and there are three
  answers: `--objective <id>` or `--milestone <id>` for work that moves a
  stated outcome, `--standalone --why "<reason>"` for work that moves none on
  purpose, and `self runbook link <run-id> --work <id>` for one occurrence of a
  procedure this project repeats. Nothing is inferred from a unit's wording or
  its dates, and nothing forces a disposition: a unit that states none is not
  standing alone, it is one nobody has said anything about yet. `work add` and
  `work propose` take `--standalone --why` too, so a unit can be born with the
  disposition. Declaring standalone conceals no existing edge — `work unlink
  <id> --objective <id>` withdraws a contribution, and `work unlink <id>
  --standalone` takes the declaration back — so moving a unit off an outcome
  that is over is two statements, both on the record.
- `milestone link <id> --decision <decision-id>` states a decision a checkpoint
  rests on, and the flag is repeatable on `milestone add` and `milestone
  revise` as well. Assumptions are additive: replacing one is linking the
  successor decision and then `milestone unlink <id> --decision <old-id>`,
  never a rewrite that could take an unrelated assumption with it. A revision
  carries the predecessor's set, and `--decision` on it adds one more.
- A contribution names an outcome that is still open. `work link`,
  `work propose` and `work confirm` refuse a target that was reached, dropped
  or superseded — a checkpoint under a closed objective included — and the
  refusal names the open successor of that record's own lineage, or the
  standalone declaration where the lineage ends closed. `work unlink` is never
  refused for it.
- `objective revise` carries every live checkpoint and every work unit linked
  directly to the objective; `milestone revise` carries the checkpoint's work
  and its assumptions. The carry is stated — one `entity.linked` per carried
  record — and nothing is unlinked, so a carried unit reads current under the
  successor, historical under the predecessor, and unchanged toward every
  other outcome it serves. `self undo` of one carried link moves one record
  back. Done work carries as a membership and covers nothing.
- A checkpoint may be judged on its objective's own date and never after it:
  `milestone add` and `milestone revise` refuse a later one, judging the
  revision on the date its successor will carry. The objective's own date
  moves either way, and one that leaves a live checkpoint beyond it warns on
  stderr. Either date absent means the ordering cannot be checked.
- `entity.covered` records the objective the judgment was made under, so a
  checkpoint an `objective revise` carried names the criteria judged under a
  former parent. `milestone recheck <id> --criterion cN --why w` settles one,
  recording the parent the checkpoint hangs under now; criteria nobody
  rechecks stay listed, and no unit's evidence is applied on anyone's behalf.
- `work` creates and moves outcomes, links them to objectives or milestones,
  records the process running a unit, and shows its evidence and recovery
  path. `work done` is the judgment that the outcome was reached, and the
  claim must carry evidence: a report with a commit or an artifact, or a
  done-time `--report` stating what verifiably happened. A bare claim is
  refused.
- `work add "<outcome>" --criteria "<text>"` declares what the unit is judged
  on. The flag is repeatable and ordered: the criteria are addressed `c1..cN`
  in the order they were declared, and a unit that declares any is not done
  until every one of them carries a coverage claim. `work propose` takes the
  same flag. `--verify "cN <how it is checked>"` states how one of them is
  checked; it is recorded prose and is **never executed**.
- `work criteria add <id> "<text>" [--verify "<how it is checked>"]` declares
  one more condition on a unit that already exists. It is appended as the next
  `cN`, never inserted. Nothing removes a criterion: a mistaken one is taken
  back with `self undo`, and one no longer needed is covered with a reason and
  no evidence.
- `--owner "cN person"` says one declared criterion is a person's own task
  rather than the recording session's; `work criteria add` takes it bare, as
  `--owner person`. `person` is the only value, and absent means the session.
  An open criterion a person owns lists under **Waiting on you** in `self
  context`, with the `work cover` line that closes it, and it is marked
  `(person)` wherever the criteria render. The unit's own status, its blocked
  count and its `k of n` sentence are untouched. `by` is who wrote the record
  and `--owner` is whose task the criterion is: a session records a criterion a
  person will do, and neither implies the other. Ownership is stated when the
  criterion is declared and nothing re-states it — a wrong one is undone and
  declared again.
- `work cover <id> --criterion cN --why "<how it is covered>"` judges one
  declared criterion covered. It is an alias in the strict sense: the same
  handler and a byte-identical `entity.covered` as `state cover <id>`, which
  keeps working and is not deprecated.
- `work block <id> --criterion cN --on decision|dependency|external [--why w]`
  says what one criterion waits on, and `work unblock <id> --criterion cN`
  releases it. A criterion's block never changes the unit's own status: the
  unit stays active, `self context` grows no waiting row for it, and covering a
  blocked criterion is allowed and ends the block. Without `--criterion` both
  verbs move the unit itself, exactly as before.
- a runbook is a procedure this project repeats — registered once, run per
  piece of work, with the same stages every run. A work unit's criteria are
  that one unit's completion conditions: declared on it, judged on it, never
  run again. If you would declare the same list on the next unit too, it is a
  runbook.
- `work add` and `work confirm` write a confirmed work record. Neither asks for
  a person at a keyboard: both write a record `self undo` takes straight back,
  and each event states whether a person or an agent session wrote it. `work
  accept` is the spelling `work confirm` had before, kept as an undocumented
  alias so a script written against it keeps working.
- `work propose "<plan>"` records work that wants review before it is built.
  The plan text alone is enough; naming `--objective` or `--milestone` makes it
  a gap proposal, which owes the full brief. `work confirm` confirms it under
  the same id, binding the exact version of the plan it read. Proposing is a
  statement about the plan, not about the caller: `work add` records the same
  unit confirmed at once, the way `decide "<text>"` does against
  `decide --proposed`.
- `work propose "<plan>" --supersedes <work-id> --why w` proposes a correction
  of a unit that has already started. The named unit is untouched while the
  plan waits: the confirm records the new unit and retires the one it
  replaces, naming it the successor — the same pair `work add --supersedes`
  records in one command. A unit that closed between the proposal and the
  acceptance refuses the acceptance rather than being retired over it, and the
  refusal names revising or declining the plan. A plan still awaiting review is
  not a supersession target: restate it with `work revise`, which keeps its id.
- `work revise <id> "<revised plan>" --why w` restates an unstarted plan under
  the same work id. Every version stays in that unit's history, the previous
  acceptance stops authorizing a start, and `work start` is refused by name
  until a person accepts again. Unlike `objective revise` and `milestone
  revise`, it mints no new id and supersedes nothing. The first `work start`
  freezes the plan; after it, a correction is a successor like any other.
- `work revise <id> "<plan>" --why w --objective <id>|--milestone <id>` moves
  that plan to another gap — the supported repair when the gap it named closed
  before anybody answered it. The gap is part of the plan, so the same plan
  text still counts as a revision: the version advances, the acceptance is
  invalidated, and a contribution an earlier acceptance had written toward the
  old gap is withdrawn in the same append. Every other contribution the unit
  holds is untouched, and the new gap has to be open.
- `report` attaches a progress report, optional commit evidence, and optional
  artifacts to a work unit. A report records the current project HEAD as
  evidence unless another value is supplied.
- `report --friction "<what differed>"` records what went other than expected,
  repeatable, one sentence each. It is stored as a field rather than written
  into the summary prose, so a later reader can collect it. `--next` is what a
  later session should pick up; `--friction` is what already surprised this
  one. The flag is optional — nothing is refused for leaving it off — but
  `self context` adds a `## Health` line once more than half of a project's
  reports in the last 30 days carry none.
- `report --artifact <dir>` attaches a whole directory as one artifact — a
  bundle — instead of one `--artifact` per file. It lists as one row,
  `dist/ (12 files)`, and `artifact open` opens its entry.
- `self artifact add <path|url> [--kind k] [--for id] [--entry <file>] [--why
  <text>]` stores a file or directory with no report behind it, recording
  `artifact.registered`. It lists with `-` in the work column, obeys the same
  bounds and the same reuse of bytes already stored, and is **not evidence**:
  registering a file never satisfies `work done`.
- **A URL is recorded as a link**, not as bytes: `self artifact add
  https://github.com/owner/repo/pull/12 --kind pr` writes `artifact.linked`,
  copies nothing and fetches nothing — not when it is recorded, and not
  afterwards. Only `http` and `https` are links; every other scheme names bytes
  somewhere, so it is refused and the path is what to pass instead. The address
  is recorded exactly as typed, and one carrying a username or password is
  refused, because the log is committed and pulled by every clone of the store.
- A link is listed, searched and attached like any other artifact. `artifact
  open` prints the address and launches nothing; `artifact prune` is refused by
  name, because there are no bytes to remove; `self undo <event-id>` takes the
  record back, and afterwards nothing lists it. `self store size` ignores links
  entirely — it answers what is on this disk — and so does the reuse of stored
  bytes, which is a question about bytes a link does not have.
- `--kind brief|pr|resource|doc` labels either shape. The list is closed so a
  reader can group by it; `--why <text>` says anything else about the artifact.
  The kind is marked after the name in every listing, `brief.md [brief]`.
- `--for <work-id|milestone-id>` attaches either shape to a record in the
  project the command runs in, and `self work show` / `self milestone show`
  then list what is attached, ordered by kind. An id another project holds is
  refused by name. An attachment is **not evidence** either: it never satisfies
  `work done`, which reads a unit's reports. It is a read-surface line, so the
  canonical `work/<id>.md` the fold writes is unchanged by it.
- The entry is `--entry <file>` if given, else `index.html`, `index.md` or
  `README.md` at the directory's own root, else an index the CLI generates
  there. Nothing but a `.git` directory is left out of the copy.
- A bundle is capped at the 1000 files you bring, or 100 MiB, whichever comes
  first, with no flag to lift it. Past that, package the directory into one
  file and attach that. A single file has the same byte cap, and anything over
  10 MiB says so once and is attached: every clone of the store carries it, and
  compacting the history never takes it back out.
- Attaching bytes the project already stores stores them once and references
  them twice. The second artifact gets its own id, its own name and its own
  entry, and shares the first's stored path — so two reports can attach the
  same output without paying for it twice. The reuse stops at the project
  boundary, and the stored file is re-hashed before it is shared, so a record
  whose bytes this machine has not synced is never adopted.
- `self artifact prune <id> --why "<reason>"` removes a stored artifact's
  bytes, recording `artifact.pruned`. **The record is never removed**: it
  keeps its row, marked `(pruned)`, so a `done` claim resting on that evidence
  stays auditable, and `artifact open` refuses it by name rather than sending
  anyone to `self sync` for a file that is not coming.
- It is the one verb here that still needs a person at an interactive terminal
  typing the artifact id back: bytes that left the working tree cannot be taken
  back by `self undo`, so a person types the id. A piped or scripted run is
  refused and handed the command to pass on.
- What may be pruned depends on how the bytes got here. A report's or a
  review's evidence is removable once its work unit is **done or retired**, and
  not before; bytes a live record points at are refused until that record is
  retracted or superseded; bytes a design approval named are refused outright,
  with no flag past it.
- Where two artifacts share one stored path, each is pruned by name and only
  the last live record naming those bytes reclaims them. Until then the receipt
  says so and the event records `bytesRemoved: false`.
- Only the working tree shrinks. History is never rewritten, so what the
  artifact left in `.git` stays there — and if the removal itself fails after
  the event is recorded, the command still succeeds and `self store size`
  reports those bytes as orphaned.
- `report --design --implements <decision-id>` submits a design or scope
  proposal. It is refused unless every cited decision exists, still holds, and
  renders in the work unit's project, and the receipt prints each cited
  decision's own text. `report confirm <report-id>` records the approval: it
  binds to the design artifact's own hash, so the recorded approval names the
  exact bytes, and the event states whether a person or an agent session wrote
  it — a session records the answer the person already gave, and `self undo`
  takes the ruling back. `work start` then refuses a unit whose design is
  unapproved, whose approval names no hash, or whose decision has since been
  superseded or retracted — the way to change direction is to supersede the
  decision and cite the successor.

The full work transitions and flags are in the `work` declaration of
[`main.ts`](../../apps/cli/src/main.ts), and the completion rules are implemented by
[`completion.ts`](../../apps/cli/src/completion.ts).

### How large the store is, and packing it down

- `self store size` reports the working tree, the `.git` directory, how many
  artifacts are recorded against how many distinct contents, the largest
  projects and files, and git's own loose and packed object counts. `--json`
  answers the same numbers as an object.
- It also reports **orphan bytes**: files under `artifacts/` that no record
  names. It reports them and removes none — a file no event names cannot be
  told apart from one another report is staging at that moment.
- `self store compact` runs `git gc` once. Unreachable objects keep git's
  default two-week grace, and history is never rewritten: the store syncs
  between machines by rebase, so a rewrite would break every other clone. Bytes
  an artifact left in the history therefore stay there, and both the receipt
  and `store size` say so.
- `self sync` says one line when the loose objects have outgrown the pack,
  which is the state a store that has never been compacted is in. It reads
  git's own bookkeeping, so the line costs no tree walk.

### The process ledger

- `work started <id> --pid N` records the agent process running a unit; the
  pid stays in this machine's ledger and never enters the synced log.
- `work exited <id> [--code N]` records how it ended.
- Liveness is judged at read time: `self status` shows running while the pid
  answers `kill -0`, stale once it stops answering without an exit record.
- Merge control is not here. A branch reaches main through a GitHub pull
  request, owned by PR review and CI.

### Context and inspection commands

`self handoff <work-id> [--project <slug>]` compiles one deterministic,
self-contained packet for a fresh agent. It includes the fixed common protocol,
the complete applicable convention closure, the bounded current context, the
complete work and report history, and recovery guidance qualified by lifecycle
and execution location. It is read-only, accepts exact work ids only, has no
`--workspace` mode, and keeps the context-only 3,000-token cap; mandatory
protocol, conventions, work, and reports are not silently truncated. From a
workspace root, root-safe reads use `--project`; start/report/done/block actions
remain owning-checkout-only, while `self project restore <slug>` is workspace-root
safe for an explicitly named archived target.

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

Every one of those event rows ends with who wrote it — `· by person`,
`· by person rayim`, `· by agent (session a1b2c3d4)` — on `self log`, on
`self log --workspace` and on a record's own history page alike. The note is the
`by` an undoable verb stamps on its event; a record written before that field
existed prints its row and says nothing about a writer, rather than being read
as a person's.

### Reading back the friction that recurs

`self report --friction "<what differed>"` records what surprised a session as
a field on the report rather than as prose inside it. `self sweep` is what
reads those fields back. It collects the friction sentences recorded in every
active project in the workspace over a window — `--since 30d` by default,
written as a whole number of days or weeks — groups the sentences that say the
same thing, and prints each group with the report ids that make its case.

Grouping is arithmetic and calls no model: sentences are normalized the way
every other record text is, common function words are dropped, and two
sentences are the same complaint when they share half their remaining words or
more. A group of three sentences or more is a candidate, and a sentence that
says only "as expected" is never one. Both numbers are constants in
`apps/cli/src/sweep.ts` rather than flags.

`self sweep` prints and records nothing. `self sweep --record` writes each
group as a standalone work proposal — the same `entity.proposed` record `self
work propose` writes — carrying the group's report ids as evidence, so it is
accepted, declined or revised through the unchanged verbs and appears in the
`## Waiting on you` section of `self context`. Every group in a run is written
in one append. A group is skipped when an open proposal already cites one of
its reports, or already carries the same plan text; a *declined* proposal
skips nothing, because friction that keeps recurring is meant to keep being
asked about.

Nothing schedules this. There is no timer, no daemon, and an unattended run is
an external cron calling `self sweep --record`. The proposal is recorded into
the project the command runs in, even when the evidence spans several.

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
`entity.revised`, `entity.superseded`, `entity.retracted`, `entity.placed`,
`entity.linked`, `entity.unlinked`, `entity.covered` — the criterion axis
`entity.criterion-declared`, `entity.criterion-blocked`,
`entity.criterion-unblocked`, whose `verify` text is recorded, never executed,
and whose `owner` names a criterion a person owes rather than the session —
and the execution facts `entity.started`, `entity.blocked`,
`entity.unblocked`, `entity.done`, `entity.retired`. Beside them,
`report.added` records progress,
`report.confirmed` records a person's approval of a design report,
`artifact.registered` records bytes stored with no report behind them,
`artifact.linked` records a URL recorded as an artifact with no bytes at all,
`artifact.pruned` records bytes removed under a person's confirmation, and
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
- friction sentences — what differed from expectation, one per sentence;
- the next action for a later session; and
- on a design report, the decisions it implements and the approval bound to
  its artifact hash.

Artifact metadata in the folded project state is `{id, name, path, digest?}`,
with `pruned: {ts, why?}` added by the fold — never by the event — once
`artifact.pruned` has named it. A link carries `{id, name, url}` and no `path`:
`path` is present exactly when this store holds bytes, which is what tells the
two apart wherever one is read.
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
