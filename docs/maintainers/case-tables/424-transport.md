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

`inline` exists so that a case asserting a row of the push table has something to
assert by the time its `await` comes back. It is not a mode to work in: the
command holds until the workspace has answered, so every delay the server has is
a delay the person waits out — which is the whole of what `on` spares them.

The detached send cannot reach the caller **including when it fails to start**.
A `spawn` that never execs — no descriptors left, no process slots left — raises
an `error` event, and an unhandled one is an uncaught exception in a process that
has already run the person's command and printed its answer: exit 1 on a command
that worked. The event is taken and nothing is done with it. The queue still
holds every append, so the records are where they were and the next command sends
them.

| Property | Cell |
|---|---|
| a sender that cannot be started leaves the command's answer and its status alone | `spawn refused` |

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
| L1 | 200 | append to the copy, settle what arrived, refold, compact | `pull L1 delta`, `pull L1 cursor`, `pull L1 tombstone`, `pull L1 partial`, `pull L1 refold`, `pull L1 after-a-crash` |
| L2 | 404 | local answer, one line naming the remedy | `pull L2 unknown-project` |
| L3 | 426 | local answer, one line saying to update | `pull L3 version-mismatch` |
| L4 | 503 | local answer, **no wait** | `pull L4 not-ready` |
| L5 | anything else, offline | local answer, one line | `pull L5 other`, `pull L5 offline`, `pull L5 unparseable`, `pull L5 hung` |

The compaction is last, and after the fold rather than before it. It drops the
appends the server has taken and the marks about them — rows every read already
filters out — so the fold sees the same queue either way, and what the order buys
is that a compaction that fails cannot cancel the fold. The events and the marks
are written by then, so the next pull finds nothing new, returns early, and would
never fold that delta at all: a tidying failure would have silently cost a
person's `state.md` the records that had already arrived.

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
minutes; both holders are bounded under it at three — `PUSHER_LEASE_MS` for the
sender and `PULLER_LEASE_MS` for the catch-up. Each enforces its own bound and
stops where it runs out, so a lock older than the threshold belongs to a process
that has already stopped. That is what makes "stale" a fact rather than an
opinion, and it is why nothing here has a heartbeat. Every wait a sender can be
made to do — a capped `Retry-After`, a bounded request — fits inside its own
lease, which `lock bounded-by-its-parts` is the check on.

The claim is about *every* holder or it is about none of them. A catch-up is one
request per registered project, so a store with enough projects would otherwise
be a live holder walking past the age at which another process takes its lock —
which is the half of the lock's own argument that used to be false. Past its
lease the catch-up leaves the projects it has not reached where they are and
returns as though it had finished, because for the command in front of it, it
has: every row of the pull table ends in the command running against what this
machine holds.

**"The next command reaches them" is a fact the walk has to earn.** A pass that
always started at the front of the registry would reach the same projects every
time and never the ones behind them — and a project never pulled is a project
whose appends are never settled, whose queue is never compacted and whose queue
file grows without end, while the pusher re-sends that backlog on every run. So
the pass records the last project it reached, machine-locally in `sync.place`,
and the next one starts after it. That file is a hint and never a record: it
holds nothing the store could not work out again, losing it costs one unfair
pass, and it is the reason it is written whole rather than appended to.

**A workspace that did not answer ends the pass.** `reached: false` is a fact
about the network in front of every project, not about the one that asked, so
asking the next project spends another request timeout to be told the same thing
— on a machine with a dozen projects, a person holding a command waited out one
timeout per project and was told the same sentence that many times. One
unreachable project now ends the walk, which is also what makes the notice
appear once.

| Property | Cell |
|---|---|
| a second taker gets nothing rather than waiting | `lock single-flight` |
| released whatever the work did | `lock released` |
| a holder younger than the lease keeps it | `lock not-stolen` |
| a holder past the lease is taken over | `lock stale` |
| a lock naming no holder is judged by its age | `lock unreadable` |
| both holders' bounds are under the threshold | `lock lease-bound`, `lock bounded-by-its-parts` |
| a catch-up past its lease skips the rest and returns | `pull lease-bound` |
| a pass cut short starts the next one where it stopped, so no project starves | `pull in turn` |
| a workspace nothing answers on ends the pass rather than being asked per project | `pull unreachable` |
| a temp file or a stolen lock inode a dead holder left is swept at the next acquire | `lock sweeps` |
| a live holder's temp survives the holder that took its lock | `lock sweeps` |
| a file of a person's own that resembles a nonce is left alone | `lock sweeps` |

### What the sweep may remove, and what it may not

The sweep runs the moment a process becomes the holder and it deletes files, in a
directory a person opens. Two things bound it, and both are checks rather than
arguments.

**The name, exactly.** `<file>.tmp-<nonce>` and `sync.lock.dead-<nonce>`, where a
nonce is 32 hexadecimal characters and never fewer, more or other. Anything
looser reaches a person's own `notes.tmp-backup-<32 hex>`.

**The age, the same age a lock is judged by.** The shorter argument — one holder
at a time, so a file carrying either name belongs to a process that is no longer
a holder — is false in the one case this module already documents: a wall clock
stepped forward ages a live holder's lock, so the process that steals it is
sweeping a directory somebody is still writing in. Requiring of the file the age
that made the lock stealable leaves a running publish's temp where it is.

What is left is the case where the same clock jump aged the file too, and the
publish answers that one itself rather than being protected from it: **no step of
a publish may raise.** The write, the cleanup and the rename are each best-effort
and a failure is the same `false` a stolen lock gets. That is not error-hiding,
because the answer to every one of those failures is the same and it is not an
exception: nothing was renamed, the original is whole and authoritative, no tail
is carried onto a file that was not published, and the next sync works the
replacement out again from what is on disk. A catch-up stands in front of
somebody's command, and every row of the pull table ends in that command running
rather than in a stack trace.

### What the lock rests on

A **local POSIX filesystem**, and this is a precondition rather than a
preference: `O_EXCL` exclusive across processes, `rename` replacing a name in one
step, an unlinked inode still readable through an open descriptor, an mtime this
machine's clock would recognise, and an append being one write. A store on a
network share or inside a folder a cloud client syncs breaks at least one of the
five, and this is not a lock there. Stated in the module header; no cell can
check it, because the filesystem under the suite is the one that satisfies it.

The fifth has a measured edge and is the one the code checks rather than
assumes — see "a read that does not end at a line ending" below.

The stale judgement is a wall clock and a holder's own bound is not. A clock
stepped forward ages a lock its holder believes is young; one stepped back holds
a dead lock un-stealable for the length of the jump. Documented in `synclock.ts`
rather than repaired — putting the holder's bound on a monotonic clock leaves it
compared against a wall-clock stamp, which moves the disagreement rather than
ending it. What the window costs is bounded either way: a sync skipped, or a
second holder the nonce re-check before every rename stops from publishing.
Neither costs a record.

## The one rewrite

Compaction and the project list are the only things that replace a file, and both
go through the same publish: read, work out the replacement, read again, carry
whatever was appended in between onto the end, check the lock is still ours, and
rename. The original is authoritative until the rename lands.

**There are two windows, and the second read only closes the first.** An append
that lands *after* the second read and before the rename is on the inode the
rename unlinks — no read has seen it, nothing carries it, and the records in it
exist nowhere else on this machine. The window is as wide as the time it takes to
write the replacement out, so on a queue of any size it is not theoretical: a
single identity rewrite over a megabyte-sized queue with an ordinary appender
running loses hundreds of rows, always as a run off the end of the file. In
`registry.jsonl` the row that disappears is a project this machine just
registered, and nothing iterates a slug the registry does not list, so that
project's whole queue stops being opened by any command. In `pending.jsonl` it is
the only copy of an unsent record.

The publish therefore holds a descriptor open on the original from before the
first read until after the rename. A `rename` unlinks the inode; a descriptor
still open on it keeps reading it, which is where those bytes are recovered from
and appended to the published file. What that does not preserve is the order
within that moment — an append made after the rename reaches the new file first
and the recovered tail follows it. Nothing reads either file in order: every row
in both is found by the append id or the slug it names.

The alternative considered and rejected was to compare the file's size against
the carried length just before the rename and abandon the publish where they
disagree. It narrows the window to `stat`-then-`rename` rather than closing it,
and under the load that makes the window wide — a machine appending steadily —
it abandons the compaction every time, so a queue that is growing is a queue that
is never tidied.

**There is a third window and it stays open.** `appendFileSync` opens by name,
writes, and closes. An appender that opened the old inode before the rename but
had not written yet when the tail was read writes into an inode this publish has
already read to the end of and no reader will open again, and those bytes are
lost. It is the gap inside one appender between its own `open` and its own
`write` — tens of microseconds, longer only if it is preempted there — against a
second window measured in the milliseconds or seconds a replacement takes to
write out, so it is narrower by orders of magnitude. It cannot be closed from
this side: closing it means holding off the append, and the append being held
off by nothing is the decision the whole module is built on. It is written down
here because every other cost in that file is.

**A read that does not end at a line ending is not published on.** The store
assumes an append is one write, and that assumption has a measured edge: a
buffered append publishes its new size a page at a time, so a reader landing
inside an append of hundreds of kilobytes — the payload a single event may carry
— sees a torn last line at a few percent of reads. Published, that would put a
file with a cut-off last line in place, and the next command to read it would
tell a person to repair by hand a file nothing had damaged; another append into
the gap would fuse the cut line onto the next and make that true. So the publish
refuses, the original stands, and the next sync reads a file that has settled.
The first read is checked before the rewrite is handed it and not only after,
because a rewrite given half a record either throws — cancelling work its caller
has already done — or answers with a replacement that is missing it. The
recovered tail is carried the same way: whole lines and no part of one.

**An empty read is not permission to write over whatever turned up.** With
nothing to open, both reads are empty and the comparison between them proves
nothing about a file that exists by the end of the rewrite; that file was made
inside the window, and publishing over it is the loss this whole publish exists
to prevent.

| Property | Cell |
|---|---|
| a line appended mid-rewrite is carried | `rewrite carries` |
| a line appended after the last read and before the rename is carried | `rewrite carries late tail` |
| the tail is carried as whole lines, never half of one | `rewrite carries late tail` |
| a file rewritten under the rewrite is left alone | `rewrite refuses` |
| a read that stops inside a line is not published on, and the refusal is a pass and not a state | `rewrite refuses a torn read` |
| and is never handed to the rewrite either | `rewrite refuses a torn read` |
| a publish that cannot write answers no rather than raising | `rewrite refuses` |
| a file created while the rewrite ran is not written over | `rewrite refuses` |
| a holder whose lock was taken publishes nothing, and cleans up its temp | `rewrite stolen` |
| a publish that refused carries no tail, and does not double one | `rewrite carries late tail` |
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

A slug appears once. Registering a project is a foreground append, deliberately
outside the sync lock, so a registration made in the moment a reconciliation was
publishing a list that already held that project is carried onto the end of it
and the file has two rows for one slug. Neither writer was wrong and nothing is
lost — every lookup is by slug or id, and the first row is the one they read —
but every walk over the registry then visits the project twice, saying its
notices twice and folding it twice, and nothing else would ever take the second
row out. The next reconciliation folds the list to one row per slug, first
winning, which is the row the lookups were already answering with.

| Property | Cell |
|---|---|
| another machine's project shows up, with its id cached | `registry reconciled` |
| a project with records still queued is never unregistered | `registry kept` |
| a project deleted elsewhere with nothing queued leaves the list | `registry dropped` |
| two rows for one project are folded back to one | `registry deduped` |

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
