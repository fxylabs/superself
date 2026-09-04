# Case table — a store commit that loses the index.lock race speaks in the CLI's words (#444)

Every cell below is one test in `apps/cli/test/store-lock.test.mjs`, named by
its cell number. The table is the review surface: a cell the table lacks is a
path nothing proves.

## The defect

Observed 2026-09-03, recording six `instruction add` calls in a row while
another session committed a report into the same store (main `8b01062`, local
build 0.13.1). `commitAll` stages with `git add -A` and commits through
`mustGit`, and `mustGit` puts git's stderr into the refusal it raises. Git's
stderr for a held index is:

```
fatal: Unable to create '.git/index.lock': File exists.
Another git process seems to be running in this repository ...
... remove the file manually to continue.
```

So the reader got the CLI's own receipt for the add, and then git's advice to
delete a lock a live process was holding — which would have destroyed the
neighbour's commit — and a non-zero exit for a write that had succeeded.

The append itself was never at stake. It is in `log.jsonl` before `commitAll`
is reached, and whichever session commits next sweeps it in; several events per
commit is what decision 01kz57aqsxym2g2g8wasp6vv7j (issue #7) accepts. What
#444 fixes is the words and the exit status.

## The rulings this implements

| # | Question | Decision |
|---|---|---|
| R1 | Retry, wait, or give up at once? | **One retry after about 300 ms, and no more.** A loop is the write coordination 01kz57aq ruled out, arrived at from underneath, and a second attempt is enough for a neighbour whose `git commit` holds the index for the length of one commit |
| R2 | What does the reader see when the retry also loses? | **One notice in the CLI's words, and exit 0.** `the store is being written by another session; this event is recorded and will be committed with the next write`. Nothing of git's stderr is printed on this path |
| R3 | How is the collision recognised? | **By the lock's path in git's stderr** — `index.lock` — not by the exit status, which git shares with every other fatal, and not by the sentence around it, which git translates |
| R4 | Does anything coordinate the two sessions? | **No.** No lock of the CLI's own, no queue, no ordering. Out of scope per #7 |

Every git failure that is not the lock keeps today's behaviour exactly: the
same refusal, carrying git's own stderr, from the same sentence. `gitFailed`
is that sentence, extracted so the retrying path and `mustGit` cannot drift
apart.

## Rules the cells are derived from

1. **`add` and `commit` are the two steps that take the index.** `status
   --porcelain` does not: it declines to refresh the index it cannot lock and
   still answers, exit 0. It stays on `mustGit`.
2. **A lock lost at `add` ends the commit there.** The status read and the
   commit are skipped, so a run says the sentence once — never once per step.
3. **The notice is said in `commitAll` and nowhere else.** The nine callers are
   unchanged, for the reason the mode check is made there: a caller added later
   would otherwise be the one that lets git's advice through.
4. **A machine surface hears nothing.** Under `--json` the notice is not
   printed, matching `pipeline.ts`'s rule for the receipt — a line of prose on
   stdout ahead of the envelope is an agent's parse error, and the agent has
   its receipt either way.
5. **The wait is `Atomics.wait`,** the synchronous sleep `human.ts` already
   uses. Git runs under `spawnSync`, so there is no loop turn to await on.
6. **Nothing removes a lock.** Not the retry, not the notice. The file belongs
   to whichever process made it.

## What `commitAll` resolves from outside its arguments

| Read | Where it comes from | Cells |
|---|---|---|
| whether the store keeps git history at all | `.superself/workspace.json`'s presence, through `serverBacked` | 4 |
| whether the index is free | git's own stderr, on each attempt | 1, 2, 5 |
| the language git says it in | the process locale — which is why the path and not the sentence is what is matched | 5 |
| whether this run answers a machine | `jsonMode()`, resolved once by the dispatcher | 4 states the server-backed skip; the machine-surface rule is `pipeline.ts`'s, asserted in the render-gate files |

## The cells

The lock is a file the suite creates and holds, not a second git racing this
one: a real race answers differently on every machine, while what the table
states is the outcome under a held lock. Cell 27 of
[`372-store-measure-dedupe.md`](372-store-measure-dedupe.md) stages the same
state the same way.

| # | Seeded state | Expected |
|---|---|---|
| 1 | a held `.git/index.lock` in the store, standing for the whole run, while `state add` runs | exit 0; the receipt; exactly one CLI-worded notice; no line holding `index.lock` or `manually`; the lock still there; the event in `log.jsonl`; `git status --porcelain` showing the log uncommitted; no new commit |
| 2 | the same lock, removed 150 ms after the command starts | the retry lands the event's own commit — one new commit, subject `entity.confirmed demo: …`, a clean `status --porcelain` — and no notice |
| 3 | no lock | the printed bytes are the receipt, the review line and the entity id, exactly as before; one new commit; a clean `status --porcelain` |
| 4 | a server-backed store with a lock file lying in it | exit 0; the append queued in `pending.jsonl`; no notice; no git text; no commit — none of this path runs |
| 5 | a held lock, with `LC_ALL`, `LANG` and `LANGUAGE` naming a French locale | the same as cell 1 — the lock is recognised by its path, which git does not translate |

Cell 5 passes on a machine whose git has no French catalogue as well as on one
that has: the assertion is the outcome, and the reason it holds either way is
rule R3. It fails the moment recognition moves to the sentence.

The lock in cell 2 is let go by a child process, not by a timer. The retry is a
synchronous pause and git is `spawnSync`, so no timer of the test runner's
would fire while the command is in flight. The child prints `ready` before it
starts counting, so the 150 ms is measured from a shell that is really running.

## What this does not change

- `mustGit`'s refusal, for every failure that is not the lock: the same
  sentence, carrying git's own stderr, from the same function.
- The `status --porcelain` step, which never took the index.
- The nine callers of `commitAll`, and its signature.
- One event per commit, and anything else #7 decided. Two sessions still
  interleave; the loser still leaves its append to the next writer.
