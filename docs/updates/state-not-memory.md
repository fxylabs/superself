---
title: Your agent doesn't need more memory. It needs state.
description: Memory layers are already good. Agents still re-open settled decisions, because memory tracks the past and nothing states the present.
date: 2026-08-07
layout: post
---

# Your agent doesn't need more memory. It needs state.

We already have plenty of memory layers, and honestly, a lot of them are good.
Markdown instruction files work. The built-in memory that models accumulate on
their own is useful. The hook-based tools that compress your sessions into a
searchable database are clever engineering. I use several of these every day
and I am not here to tell you to throw them out.

Here is what kept happening to me anyway. I run a few projects at once, all of
them through agent sessions. One morning a fresh session, with every memory
layer loaded, proposed re-opening a decision I had settled two weeks earlier.
Same arguments. Opposite conclusion forming. I had written that decision down.
It was in the memory. The session just never read that particular entry closely
enough to treat it as settled.

That was the moment I stopped believing more memory was the answer.

## Memory only works when it gets read

A stateless model running a long project needs two different things from you.
It needs to know how the project got here, and it needs to know what is true
right now. Memory is built for the first one. It records what was said and
makes the past searchable, and it does that well.

The second one it cannot do, for a structural reason: memory has to be
retrieved. The search has to fire, the right entry has to rank high, and the
agent has to actually read it, closely, for this specific case. If any link in
that chain breaks, the old failure comes back. You can record everything and
index everything and still watch the same mistake repeat, because an archive of
everything ever said is not a statement of what currently holds.

What currently holds is a short list: the goals, the decisions that stand, the
work in flight and what it's blocked on. That list needs to sit in front of
every session before the first prompt, without anyone retrieving anything. If
reaching it requires a search, you are gambling on the search.

## I kept rebuilding the wiki

People managed this list long before agents. It lives in Notion, Jira,
Confluence, a team wiki. And everyone who has maintained one knows how the
story goes: the pages age, updating them turns into a chore, whoever does the
updating gets tired, and at some point the wiki stops being true.

For a small project you genuinely don't need any of it. Markdown in the repo,
a few simple rules, your own recall. That combination carried me for years.
It stops working when the project grows, and it breaks fast once there are two
projects instead of one.

So I did the obvious next thing: let the agents maintain the documents. An
agent-curated wiki of the project. I built this twice. Both times it was stale
within weeks, and I was rebuilding a system whose whole point was that I would
not have to maintain it.

## Documents rot because they are free-form

The failure has a plain mechanism. A document can say the same thing five
different ways. There is no rule for where a fact lives, so the fact gets
written in two places and the copies drift apart. Nobody notices a duplicate
until someone goes hunting. You can write style rules for the agents, and I
did, but then correctness depends on every agent following the rules every
time. The first time one doesn't, you are back to rewriting.

Anything you edit, you must maintain. That sentence is the whole history of
dead wikis.

The way out is to stop editing. Manage state as state:

1. Record events instead of updating pages. A decision was made, a piece of
   work finished, a claim got backed by a commit. One line each, written the
   moment it happens, append-only. There is no "current state" document to keep
   fresh.
2. Give every kind of fact exactly one shape. In my system there is one way to
   record a decision. Not two. "Where does this go" and "is this a duplicate"
   stop being judgment calls, because the structure already decided.
3. Put the rules in the tool, not in a style guide. A "done" with no evidence
   gets refused. A correction supersedes the old record and keeps the lineage
   instead of editing history. Nothing depends on an agent being diligent
   today.

Current state is then derived from the log and regenerated on every change. A
projection has nothing to maintain, so it has nothing that can rot. The chore
that killed every wiki is simply gone.

And you do not need a database or an API for any of this. The log is lines of
text in a git repository. The derived state is markdown any agent can read.

## What it looks like

I built this as [superself](https://github.com/fxylabs/superself), a CLI
called `self`, and I run my own projects on it, including superself itself.
Every session starts with one command and gets the current truth pushed at it,
no retrieval step involved:

![self context renders the project's current truth in the terminal](/self-context.gif)

Recording is the same grammar everywhere. And the write path pushes back: the
day I claim something is done without evidence, the tool refuses me too.

![self work done is refused without evidence, then recorded with a report](/self-done.gif)

When a decision needs to change, the new one supersedes the old and both stay
in the log. "How did we get here" is one query, and no session will treat the
old decision as open, because context shows only what stands.

Memory answers "what did we ever say about X." State answers "what is true
right now, and what should I not re-open." I want both. But only the second
one has stopped my sessions from arguing themselves out of my own decisions.

superself is open source and pre-release. If you run more than one project
with agents and you have rebuilt the wiki more times than you'd like to admit,
the [getting-started guide](https://superselfs.com/docs/guides/getting-started)
takes about five minutes.
