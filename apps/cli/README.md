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

## Directives while the agent is busy

A long agent turn used to own the whole conversation. `self capture` breaks
that: it records what you said and hands back an id straight away, whatever
else is running.

```sh
self capture "also make the export CSV, not XLSX"   # returns c-xxxxx now
self capture list                                   # what nobody has read yet
self capture link c-xxxxx --new "export ships as CSV"
self capture link c-xxxxx --work w-yyyyy --as addition
```

A directive routes exactly once, as new work or as an addition, supersession,
cancellation, reprioritization, or status request against work that exists.
The words you submitted stay in the log unchanged whatever the routing later
turns out to be. Pass `--key <k>` when a client might retry — the same key
returns the same capture instead of a second one.

## The queue and its workers

```sh
self work depend w-b --on w-a      # w-b wakes by itself when w-a is done
self work approval w-c --why "it deletes production data"
self work priority w-d 10          # lower runs sooner
self work queue                    # what is ready right now
self work claim --worker runner-1  # lease the next ready unit
self work heartbeat w-d            # keep the lease alive
self work recover                  # requeue whatever a dead process was holding
```

Readiness, waiting, and lease expiry are derived from the log on every read,
so a process that dies never strands work: restart it, run `self work
recover`, and the queue is exactly where it was. Completing a unit needs a
report and verification evidence — `self work done` refuses without them
unless you say why none exists.

`self stream` is the one board over all of it — needs you, changed, running,
queued, captured ideas — and `self stream --follow` streams events as they
land, so a console can render state without keeping a second copy of it. The
capture, queue, and stream verbs all take `--json`.

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
