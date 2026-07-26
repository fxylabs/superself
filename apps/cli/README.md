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

## Record state while committing

`self project add`, `self project link`, and `self connect` install or refresh
a non-blocking `post-commit` hook. Put state assertions in the commit's final
trailer block:

```text
Report: w-xxxxx email verification remains
Decide: sessions should use JWT rather than cookies
```

Reports attach the new commit as evidence. Decisions harvested from commits
are proposals until a person confirms them. Existing hooks still run, a clone
without `self` commits normally, and `self harvest` can retry HEAD safely.

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
search, and the fold.

## License

Apache-2.0. Source, issues, and contribution policy:
[github.com/fxylabs/superself](https://github.com/fxylabs/superself).
