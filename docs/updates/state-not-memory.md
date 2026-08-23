---
title: Your agent doesn't need more memory. It needs state.
description: Memory layers are already good. Agents still re-open settled decisions, because memory tracks the past and nothing states the present.
date: 2026-08-07
layout: post
---

# Your agent doesn't need more memory. It needs state.

Two weeks after I settled a product decision, a fresh agent proposed the
opposite choice. It made the same arguments we had already considered. The
decision was in the memory loaded for that session, but the agent did not treat
it as settled.

I run several projects through agent sessions. Markdown instructions help.
Searchable session history helps too. Neither prevented that morning's repeat.

## The failure was retrieval

Memory can hold a current fact. The session still has to retrieve the right
entry, rank it high enough, and read it as a constraint for the task at hand.
If one step fails, a settled question looks open again.

The facts I need before the first prompt fit on a short list: current goals,
standing decisions, work in flight, blockers, and the latest evidence. I do not
want a search to decide whether that list appears. The session should receive
it as its starting state.

## The wiki failed next

My first replacement was a project wiki maintained by agents. I built it
twice. Both versions were stale within weeks.

The cause was ordinary duplication. One fact appeared on two pages. An agent
updated one copy and missed the other. A later session could read either
version, and both looked authoritative.

More writing rules did not fix that. They only moved correctness into another
instruction every agent had to remember.

## I replaced page edits with events

The model I use now has three rules:

1. Record a decision, completed task, or evidence claim as an event when it
   happens.
2. Give each kind of fact one event shape.
3. Derive the current view from the event log.

The write path enforces the small invariants that matter. A completion without
evidence is refused. A correction supersedes the earlier record and preserves
its lineage.

This does not make the projection infallible. Event or fold logic can still be
wrong. The difference is that the error can be reproduced from the log and
fixed without reconciling several hand-edited pages.

The log itself is text stored in Git. The current view is generated Markdown
that any agent can read.

## The workflow in one command

I built this into superself, a CLI called `self`, and use it to run the project
itself. Every session starts by reading the current goals, decisions, work, and
health signals:

![self context renders the project's current truth in the terminal](/self-context.gif)

The same event grammar handles writes. If I claim a task is done without a
report or evidence, the command refuses it.

![self work done is refused without evidence, then recorded with a report](/self-done.gif)

When a decision changes, the replacement points to the old record. The next
session sees the decision that stands; the log still answers how it changed.

I still keep searchable memory. It is useful when I need the discussion,
alternatives, or an old experiment. State handles the smaller question that
must have one answer before work starts: what holds now?

If you run more than one project with agents, the
[getting-started guide](https://superselfs.com/docs/guides/getting-started)
takes about five minutes.

## Sources

- [Source repository](https://github.com/fxylabs/superself)
- [Company State and context](https://superselfs.com/docs/concepts/company-state-and-context)
- [Getting started](https://superselfs.com/docs/guides/getting-started)
