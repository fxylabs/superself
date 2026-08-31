# Case table — a workspace store is git-backed or server-backed (#422)

Every cell below is one test, named by its cell id. The table is the review
surface: a cell the table lacks is a path nothing proves.

All cells live in `apps/cli/test/store-mode.test.mjs`.

## What this adds

A workspace store keeps its records in one of two places. Today it is always a
git repository this machine commits and pushes. This adds the second: a store
whose records live on a workspace server the machine is logged in to.

One store is one or the other for its whole life, and `.superself/workspace.json`
is what says which — present means server-backed. Nothing in this change writes
that file. What writes it is the flow that connects a machine to a workspace,
and that flow is not here yet; these cells write the marker by hand, because what
is under test is every command's behaviour once it exists.

Sending and receiving are not here either. This is the local half: which file an
append lands in, which files a read joins, and which verbs stop meaning anything.

## The shape on disk

```
<workspace>/.superself/
  workspace.json                    present ⇒ server-backed
  registry.jsonl                    unchanged
  config.json                       unchanged, machine-local
  projects/<slug>/log.jsonl         the server's copy, arrival order
  projects/<slug>/pending.jsonl     this machine's queue of unsent appends
```

Both files are append-only, and that is the whole design. `log.jsonl` is written
only by what comes back from the server, which arrives in a strictly increasing
order and therefore never needs inserting into. `pending.jsonl` records every
change to itself as a line added — an append, a mark that one was sent, a mark
that one may not be retried — so no crash between two writes can lose a record,
and no "mark this done" is ever a rewrite.

An append lands in the queue and nowhere else. That is what makes each event the
property of exactly one of the two files: the queue owns it until the server has
it, the copy owns it afterwards. There is no window in which a machine has
written half of a record.

## The three row shapes of `pending.jsonl`

| Row | Meaning | Written by |
|---|---|---|
| `{append_id, events}` | one append, as it was made | this change |
| `{sent: append_id}` | the server has it | the transport |
| `{blocked: append_id, code, at, detail}` | it will not be retried | the transport |

This change writes the first and reads all three. A reader has to understand the
marks before anything writes them, or the first thing the transport writes would
be a row the CLI reads as an append.

## What a read joins

`readEvents` is the one seam. In a git-backed store it is the read of one file it
always was. In a server-backed store it is the server's copy first, in the order
the server put it in, then this machine's unsent tail.

That order is the fold's own semantics rather than a compromise: a record the
workspace has already agreed on stands ahead of one only this machine has made,
and an append made offline lands after everything that arrived while it was
offline. A record whose closing arrives late is applied in the order it arrived
and the earlier record stays in the history — a visible race, never a silent
loss.

An append with a `sent` or a `blocked` mark against it is out of the read.
`sent` because its events are the server's copy's to state now; `blocked`
because the mark is put there by a server that has refused them, so the state
they claim is a state the workspace does not hold and never will. An event in
both files is read once, off the stored copy.

## The cells

### M — which mode a store is in

| Cell | What it proves |
|---|---|
| M1 | a git-backed store writes its own log and opens no queue |
| M2 | `workspace.json` in the store root makes the store server-backed: the append queues, the log is untouched |
| M3 | `workspace.json` in the workspace directory leaves the store git-backed |
| M4 | `workspace.json` in a project's state directory leaves the store git-backed |
| M5 | `workspace.json` under `projects/` leaves the store git-backed |
| M6 | a store holding what `self init` writes and nothing else stays git-backed under `log`, `context`, `status`, `project` and `store size` |

M3–M6 are the load-bearing half. Every store that exists today is git-backed and
holds no `workspace.json`, so a mode read off anything looser than that one
file's presence would reroute their appends into a queue no commit covers.

### A — the queue, and the log read back off it

| Cell | What it proves |
|---|---|
| A1 | one append is one queued row, carrying its own `append_id` and its events |
| A2 | a record written into a server-backed store is read back by `self log` |
| A3 | the server's copy and the unsent tail read as one log, the server's copy first |
| A4 | a `{sent}` mark takes its append out of the read |
| A5 | a `{blocked}` mark takes its append out of the read |
| A6 | an event in the queue and in the server's copy is read once |
| A7 | a store just connected, with no queue file at all, answers `log`, `context`, `status`, `project`, `state` and `work` |
| A8 | two appends are two rows, and one append is never split across two |

### C — what a commit covers

| Cell | What it proves |
|---|---|
| C1 | an append, a manual refold and an alias write add no commit to a server-backed store |
| C2 | an append still commits in a git-backed store |

`commitAll` decides this itself rather than each of its nine callers. The callers
say what they always said — "the store has changed, record that" — and a
server-backed store has already recorded it by queueing the append. Deciding at
the one seam is what stops a tenth caller from being the one that forgot.

### L — what one append may carry

| Cell | What it proves |
|---|---|
| L1 | an event whose payload is over 256KB is refused, the refusal names `self artifact add` and splitting, and nothing is queued |
| L2 | an append of more than 1,000 events is refused, naming splitting |
| L3 | an append over 1MB is refused even where every single event is inside its own limit |
| L4 | 1,000 events exactly is not over the limit |
| L5 | a git-backed store applies no such limit |

The limits are the server's, checked where the append is made. An append is made
once and sent many times, and it cannot be divided after the fact: refusing at
the moment it is made costs the caller one command, and refusing at the moment it
is sent would cost them a record stuck in a queue with no command that can take
it back out. Every refusal names splitting, because splitting is the only way
through.

L1 and L5 measure the tier budget out of the way first. What a context tier holds
is a separate limit with a separate refusal, and a cell about the size of an
append has to reach the append to say anything.

### G — the verbs that only mean something against git

| Cell | Verb |
|---|---|
| G1 | `self remote add` |
| G2 | `self sync` |
| G3 | `self store size` |
| G4 | `self store compact` |
| G5 | `self clone` |
| G6 | `self init` |
| G7 | every one of them still works in a git-backed store |

Each refusal names the verb the caller ran and what it is for, rather than only
what it is not: a caller who ran it was after the thing it does.

G5 is about the store the machine already points at, not the one about to be
made. A clone makes a second git-backed store, and a machine whose workspace is
server-backed reaches its records by being logged in. A machine pointing at
nothing is the ordinary first clone and is not refused.

G6 is a refusal rather than the "already initialized" receipt the same directory
would get from a git-backed store. `self init` makes the git repository, and it
makes it outside every path a store's mode could quietly turn into no work — so
answering "already initialized" would be reporting about a store this command
could not have made and cannot change.

### W — who the log says wrote it

| Cell | What it proves |
|---|---|
| W1 | a record written into a server-backed store carries `actor.account` |
| W2 | a git-backed store's log carries no `actor`, even with a credential on the machine |
| W3 | a machine logged in to nothing still records; the author is absent and the work is not refused |
| W4 | the account survives a scope that drops the directory's own project |
| W5 | the account is read once per invocation, so a login between two commands reaches the second |

`origin` already says what kind of writer an event had — an agent or a person.
`actor` says whose it was, which is the question a workspace holding several
people's records has to answer, and it is recorded at the moment of the append so
that authorship survives the account being switched on the machine before the
record is sent.

The value travels rather than the reader. `runCli` reads which account this
machine is logged in as, once, and leaves it on every context the resolver
builds; the append path stamps that value. A state writer must have no import
path to a credential, and the structure check's credential-isolation rule holds
that — `src/pipeline.ts` cannot reach `src/credentials.ts` and this does not give
it a way.

It is read at all only where this machine's store is server-backed. A git-backed
run must touch no credential file: its log states no account, so opening one
would be a file read and a permission check for a value nothing was going to use.

W2 is the byte-for-byte guarantee. A git-backed log is committed by a machine git
already names, and stamping an account there would change bytes every existing
clone of that log agrees on.

### Q — the queue file itself

| Cell | What it proves |
|---|---|
| Q1 | a queue line that will not parse stops the read and names the file and line |
| Q2 | the project's state directory is made where it is missing, so a first append has somewhere to queue |

Q1 is deliberately a refusal rather than a skip. This file is the only copy of
every record in it, so a reader that stepped over a damaged line would answer as
though the records it holds were never written.

## What is deliberately not here

- **Sending and receiving.** Nothing pushes, nothing pulls, and nothing writes a
  `sent` or a `blocked` row. The reader understands all three shapes because the
  first thing a writer of them does must not be a row the CLI misreads.
- **The flow that connects a machine to a workspace.** Nothing writes
  `workspace.json`; the cells write it as a fixture.
- **`self init` choosing a mode.** It refuses in a server-backed store and is
  otherwise exactly what it was.
- **`self project init` against a server.** It writes the local registry row it
  always wrote. In a server-backed store that row is a cache of a project the
  server does not know about yet.
- **`self alias`, `self lang`, `self theme`, `self tokens`, `self timezone`.**
  These write `config.json`, which is machine-local and is not a store the server
  keeps. In a server-backed store they take effect on this machine and stay
  there.
