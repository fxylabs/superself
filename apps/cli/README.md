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
self goal set "ship the alpha"
self work add "signup flow works end to end"
self work start w-xxxxx
self report w-xxxxx "flow works; email verification remains" --evidence <commit>
self decide "sessions are JWT, not cookies" --why "mobile client shares the API"
```

Every verb appends an event to an append-only log inside the workspace store
(a git repository of its own, separate from your code). Canonical files —
project state, work briefs, HTML views — are derived from the log by `self
fold` and never hand-edited.

## What agents get

`self context` prints the project's current truth — goal, active decisions,
open work, recent reports — derived from state, not hand-maintained. `self
connect` renders a managed block into `AGENTS.md` and `CLAUDE.md` so any
agent tool loads the same instructions. Reports attach the current commit as
evidence automatically.

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
goals, decisions, work units, reports, artifacts, conventions, sync, views,
search, and the fold. `self help <command>` and `self <command> --help` both
print one command's syntax and flags. Help reads no state and writes none, so
it answers in any directory.

A verb the CLI does not have is named and exits non-zero — a typo never reads
as a command that ran. To pass text that starts with a dash, put it after
`--`: `self decide -- "--proposed is the text here"`. To give a flag a value
that starts with a dash, use the equals form: `self decide "…" --why=-h`.

## License

Apache-2.0. Source, issues, and contribution policy:
[github.com/fxylabs/superself](https://github.com/fxylabs/superself).
