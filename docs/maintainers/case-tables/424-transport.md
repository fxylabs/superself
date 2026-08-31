# Case table — a server-backed store sends and receives (#424)

Every cell below is one test, named by its row id. The table is the review
surface: a row the table lacks is a path nothing proves.

Cells live in four files:

| File | What it holds |
|---|---|
| `apps/cli/test/transport-push.test.mjs` | the push table, P1–P10 |
| `apps/cli/test/transport-pull.test.mjs` | the pull table L1–L5, the round trip, the late ending, the project list |
| `apps/cli/test/transport-lock.test.mjs` | the sync lock, the rewrite, compaction, concurrency |
| `apps/cli/test/workspace-server.test.mjs` | the contract mock's own contract |

## What this adds

The store that keeps its records on a workspace server (#422, #423) had a queue
and no way to empty it. This is the way: a delta pull before every command, a
send after it, and a written answer for every response the workspace can give.

Nothing about a git-backed store changes. Every path below is behind the same
test the mode has always been read by — `.superself/workspace.json` exists —
and the existing suite is what says so.

## The shape of one command

```
catch up  →  the command  →  send
   ↑                            ↑
   pull the delta,              a process of its own, so the
   settle what came back,       person's command is not waiting
   tidy the queue,              on a network round trip
   reconcile the project list
```

The catch-up cannot refuse a command. Every row of the pull table ends in the
command running against what this machine holds — being offline is an ordinary
state for a store whose local files are a complete log of what it knows.

The send cannot say anything. It outlives the command that started it and has no
terminal in front of it, which is why a refusal it meets is written into the
queue as a row and said by the next command that has somewhere to print.

`SUPERSELF_SYNC` names the whole of it: `on` (the default) is catch up and send
detached, `inline` sends before the command returns, and `off` talks to nothing.
The suite's scratch machine is `off`, so no case reaches a network by accident.

## Push — `pusher.ts`, first match wins

| # | Answer | What this machine does | Cell |
|---|---|---|---|
| P1 | 200 | nothing changes locally. The `sent` mark is the pull's | `push P1 accepted`, `push P1 tombstone`, `push P1 duplicates` |
| P2 | 400 `actor_mismatch` | blocked, naming the account | `push P2 actor-mismatch` |
| P3 | 400, any other code | blocked, as P8 | `push P3 bad-request` |
| P4 | 409 | re-sent one append at a time; only the clashing one blocks | `push P4 conflict`, `push P4 other-stream` |
| P5 | 413 | re-sent one append at a time | `push P5 too-large`, `push P5 unsplittable` |
| P6 | 404 | created once if no id is cached, else blocked | `push P6 unknown-project`, `push P6 deleted-elsewhere`, `push P6 slug-taken`, `push P6 creation-denied` |
| P7 | 426 | queued, not blocked | `push P7 version-mismatch` |
| P8 | other 4xx | blocked | `push P8 other-4xx` |
| P9 | 503 + `Retry-After` | waited out once, capped, retried | `push P9 retry-after`, `push P9 still-not-ready` |
| P10 | 5xx, network failure, timeout | queued, silently | `push P10 server-error`, `push P10 connection-dropped`, `push P10 unreachable` |

Three things about this table are worth stating rather than reading off it.

**A 200 writes nothing down.** The mark that an append has gone is the pull's,
written after it has seen every one of that append's event ids arrive in
`log.jsonl`. Between the push and that pull the append is sent again, and the
server absorbs it as a duplicate — which is the cost of never having a record
that the queue has released and the copy does not hold.

**P4 and P5 split; nothing else does.** A batch refused as a whole is re-sent one
append at a time, so the append the server objects to is the only one that stops
and the rest go. A 400 blocks every append in the request, because that is what
the table says and because the case it is about — a machine logged in as somebody
else — makes every append in the queue guilty of the same thing. A mixed-author
batch would stop innocent appends alongside; they are recoverable by hand from the
queue file, and nothing about them is lost.

**A single append the server still calls 413 stops.** There is nothing left to
split. An append that is over the limit on its own was refused where it was made
(#423), so this is a state the server and this CLI disagree about rather than one
a person can be walked out of, and the append blocks rather than looping.

## Pull — `puller.ts`, first match wins

| # | Answer | What this machine does | Cell |
|---|---|---|---|
| L1 | 200 | append to the copy, settle what arrived, compact, refold | `pull L1 delta`, `pull L1 cursor`, `pull L1 tombstone`, `pull L1 partial`, `pull L1 refold`, `pull L1 after-a-crash` |
| L2 | 404 | local answer, one line naming the remedy | `pull L2 unknown-project` |
| L3 | 426 | local answer, one line saying to update | `pull L3 version-mismatch` |
| L4 | 503 | local answer, **no wait** | `pull L4 not-ready` |
| L5 | anything else, offline | local answer, one line | `pull L5 other`, `pull L5 offline`, `pull L5 unparseable`, `pull L5 hung` |

L4 is the row worth reading twice. A read cannot be deferred: somebody is holding
the command, and what this machine holds is a complete answer to what this
machine knows. The `Retry-After` a 503 carries is honoured by the push and
ignored by the pull, and that is not an inconsistency — one of them is work
nobody is waiting on.

## The cursor, and why there is no cursor file

`after=` is the last row of `log.jsonl`. A cursor kept in a second file can be
written when the append was not, or the other way round, and then a machine
either re-reads records it has or skips records it does not. There is no such gap
between a file and its own last line — which is what makes `pull L1 after-a-crash`
pass: a machine that died between writing the copy and writing the mark asks from
where the file ends, gets nothing back, and settles the append off the ids the
file already holds.

## What is said, and where

Every line the catch-up prints goes to **stderr**. They arrive before the command
has parsed its flags, so the run may yet be a `--json` one, and a line of prose
on stdout ahead of the envelope is an agent's parse error rather than a person's
notice. They are also nobody's answer: the command would have said the same thing
without them.

A blocked row is surfaced once, by the next command with somewhere to print. The
mark that it has been said is the same blocked row said again carrying `surfaced`
— a field on a row shape the CLI already reads, never a fourth shape, which an
older CLI would read as neither an append nor a mark and fold twice.

| Property | Cell |
|---|---|
| said by the next command, once, and not by the one that recorded it | `blocked surfaced` |
| a blocked append is never sent again | `blocked skipped` |

## The lock

One sync at a time, and the foreground append outside it. `SYNC_LEASE_MS` is five
minutes and `PUSHER_LEASE_MS` is three: the sender enforces its own bound and
stops, so a lock older than the threshold belongs to a process that has already
stopped. That is what makes "stale" a fact rather than an opinion, and it is why
nothing here has a heartbeat. Every wait a sender can be made to do — a capped
`Retry-After`, a bounded request — fits inside its own lease, which
`lock bounded-by-its-parts` is the check on.

| Property | Cell |
|---|---|
| a second taker gets nothing rather than waiting | `lock single-flight` |
| released whatever the work did | `lock released` |
| a holder younger than the lease keeps it | `lock not-stolen` |
| a holder past the lease is taken over | `lock stale` |
| a lock naming no holder is judged by its age | `lock unreadable` |
| the sender's bound is under the threshold | `lock lease-bound`, `lock bounded-by-its-parts` |

## The one rewrite

Compaction and the project list are the only things that replace a file, and both
go through the same publish: read, work out the replacement, read again, carry
whatever was appended in between onto the end, check the lock is still ours, and
rename. The original is authoritative until the rename lands.

| Property | Cell |
|---|---|
| a line appended mid-rewrite is carried | `rewrite carries` |
| a file rewritten under the rewrite is left alone | `rewrite refuses` |
| a holder whose lock was taken publishes nothing, and cleans up its temp | `rewrite stolen` |
| a crash before the rename costs nothing | `rewrite crash-safe` |
| settled history goes, unsent and untold rows stay | `compaction drops`, `compaction keeps` |
| compacting twice is compacting once | `compaction settles` |
| a row a newer CLI wrote is not dropped by an older one | `compaction keeps unknown rows` |
| twelve records made while the queue is rewritten under them are all there | `concurrent` |
| an append made while the queue is going out is sent by the next command | `concurrent send` |

## The project list

Reconciled once at the start of a command — the conservative number, and what
makes another machine's new project, removed project or edited description show
up here at all.

A local row the server does not list is dropped, with two exceptions. Without a
cached id it is a project this machine made and has never registered, and
dropping it would throw away the registration its own queue is waiting to
complete. With records still queued for it, dropping it would strand them in a
file no command ever opens again — so the slug is kept and the push tells the
person instead.

| Property | Cell |
|---|---|
| another machine's project shows up, with its id cached | `registry reconciled` |
| a project with records still queued is never unregistered | `registry kept` |
| a project deleted elsewhere with nothing queued leaves the list | `registry dropped` |

## Two machines

| Property | Cell |
|---|---|
| a record made offline reaches a second machine and folds the same | `round trip` |
| a retire arriving after a done converges on both, and both records stay in the log | `late ending` |

The late ending is decided by the fold and not by this change: **the first ending
is the ending**. A line merged from a machine that had not seen the completion
cannot reopen a unit, so the two machines converge on the same answer rather than
on the later one, and the record that lost is in the log on both of them where
`self log` shows it. Visible contention, not a silent loss.

This is worth flagging against the design note that reads "the later arrival
continues the state": the fold's own rule, which the design also defers to, is
the terminal one, and no behaviour was changed here to match either wording.

## The contract mock

`apps/cli/test/workspace-server.mjs`. It answers on loopback and implements the
checked-in contract, and two rules govern what may go in it — both about the same
danger, a mock that is kinder, stricter or simply different from the server, so
that a green suite says nothing about the real thing:

1. **Nothing the contract does not state.** Where a case needs an answer the
   contract has no state for — a runtime that is not ready, a 5xx, a workspace
   this caller is not a member of — the case stages it explicitly rather than the
   mock growing a behaviour.
2. **The stated priority, first match wins**: 426 → the concealing 404 → 503 →
   413 → 400 → 409. A mock that checked in another order would let this CLI pass
   on a precedence the server does not have.

| Property | Cell |
|---|---|
| a request with no version header is 426 | `mock version-required` |
| the version is checked before anything is concealed | `mock version-first` |
| another workspace, an absent project and an unknown route are one 404 | `mock concealment` |
| the same batch twice stores one record and counts a duplicate | `mock resend-identical` |
| the same event id with different content refuses the whole batch | `mock resend-changed` |
| the same event id on another project's log is a conflict | `mock resend-other-stream` |
| an event naming another account is 400 with `actor_mismatch` | `mock author` |
| a 400 for a missing field carries no such code | `mock schema` |
| over a thousand events, or one event over 256KB, is 413 | `mock batch-count`, `mock event-size` |
| the limit is checked before the author | `mock size-before-author` |
| a push naming a project id the slug no longer has is 404 | `mock expected-project` |
| creation is 201 with an id, 409 on a taken slug, 404 where the workspace is not visible | `mock create`, `mock slug-taken`, `mock create-elsewhere` |
| a delta answers after the cursor, gapless, with the head | `mock delta` |
| the project list carries every project's id | `mock listing` |

## What one event carries on the wire

The API asks an event for `event_id`, `append_id`, `ts`, `type`, `actor_account`,
`actor_agent` and `payload`. This CLI sends exactly those **added to** the record
as the store holds it: `origin`, `refs` and the rest travel beside them
untouched, and the mock stores what it was sent.

That is the least this change could decide, and it is worth naming as a decision
rather than leaving as an accident. `origin` and `refs` are what the fold reads —
which session recorded a thing, which append it belonged to, which commits it
cited — and the API's event schema has no field for either. A client that dropped
them would be deciding a record means less than it said; a client that packed
them into `payload` would be inventing an encoding the contract does not
describe. So they are sent as they stand, and whether the server preserves them
is a question for the contract rather than for this CLI. **A server that keeps
only the named fields would make `round trip` fail on a real workspace**, and that
is the right place for it to fail.

## What is not here

Connecting a machine to a workspace, the `--cloud` branch of `self init`, the
login scope list, and the API-mode surface of `self project init`. This change
creates a project from inside the sender when P6 says the workspace has never
heard of it, and that is the whole of its project management.
