# Superself

**Your agents forget. Your projects shouldn't.**

Superself is version control for your project's state. Git versions your
code; Superself versions the project itself — goals, decisions, work units,
and outputs — so you pick up where you left off across sessions, models, and
tools instead of re-explaining your project every session.

Installing this package gives you the `self` CLI.

```sh
npm install -g superself
```

Requires Node 22.12+ and git.

## Quickstart

```sh
mkdir my-workspace && cd my-workspace
self init                    # this directory becomes your workspace
cd ~/code/my-project
self project add             # register a project (renders its agent block)
self goal add "ship the alpha"
self work add "signup flow works end to end"
self work start w-xxxxx
self report w-xxxxx "flow works; email verification remains" --evidence <commit>
self decide "sessions are JWT, not cookies" --why "mobile client shares the API"
```

Every verb appends an event to an append-only log inside the workspace store
(a git repository of its own, separate from your code). Canonical files —
project state, work briefs, HTML views — are derived from the log by `self
fold` and never hand-edited.

Underneath the verbs is one record kind: every assertion folds into an entity
with a label and a placement — scope (`project` or `workspace`), priority
(render order), and exposure (`full`, `index`, or `search`). The preset verbs
are rows in a user-editable alias table (`self alias`), `self state` records
and moves raw entities, and retention caps keep the always-rendered set
bounded: a `state add`, `state place`, or alias-verb add past a cap is
refused until `--demote` names what frees the room.
`self work done` refuses a bare claim — the evidence is a report with a
commit or an artifact, or a done-time `--report` of what verifiably happened.

## What agents get

`self context` prints the project's current truth — goal, active decisions,
open work, recent reports — derived from state, not hand-maintained. `self
connect` renders a managed block into `AGENTS.md` and `CLAUDE.md` so any
agent tool loads the same instructions. Reports attach the current commit as
evidence automatically. `--evidence` also takes free-form evidence — a
checksum, a build number, a validation summary — and the project repository
decides: a value it resolves is recorded as a revision and watched, anything
else is kept beside them as a note and never resolved again. Force either with
`--evidence commit:<value>` or `--evidence note:<value>`. Attached artifacts
are checked against the digest recorded when they were ingested.

## Across machines

```sh
self remote add git@github.com:you/workspace-store.git
self sync                    # commit pending, pull --rebase, refold, push
self clone <url>             # onto a second machine
```

## The viewer

Every fold renders self-contained HTML dashboards into the store — what
waits on you, what is moving, decisions, artifacts. `self view` opens the
live workspace or project page; `self theme` switches the accent
(violet, cyan, orange, mono).

## All commands

Run `self` with no arguments for the full verb list: workspaces, projects,
goals, decisions, work units, reports, artifacts, conventions, the raw state
and alias verbs, sync, views, search, and the fold. `self <command> --help` prints one command's syntax and
flags; help reads state from nowhere and writes none, so it answers in any
directory.

A flag a command does not take is refused before the command runs — the
mistake is named, the exit is non-zero, and nothing is recorded and nothing
is written. A typoed verb (`self reprot`) is refused the same way. Most
commands also refuse an argument they have no room for; the `work`
linking and proposal verbs still ignore a surplus positional.

To pass text that starts with a dash, put it after `--`:
`self goal add -- "--help is the goal"`. Before `--`, a `--help` standing
anywhere a flag could stand answers with that command's help; in an option's
value position it is handed to the command's parser instead
(`--why=--help` records the literal text).

## License

Apache-2.0. Source, issues, and contribution policy:
[github.com/fxylabs/superself](https://github.com/fxylabs/superself).
