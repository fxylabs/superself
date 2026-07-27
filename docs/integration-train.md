# The repository integration train

Parallel agents can implement in parallel. A repository can only be *integrated*
one change at a time. When those two facts are not separated, the result is the
one this controller exists to prevent: a rebase started while two earlier pull
requests are still open, a review verdict that no longer describes the bytes on
disk, and a merge that happened because someone said the word approve.

This page states the model, the gates and the machine surfaces. Everything here
is derived from the event log; nothing is asserted by a command, a prompt or a
convention.

## The four records

Every record is folded from typed events in the project's `log.jsonl`.

**ChangeSet** — one branch's bid to reach main. It carries the repository, the
work unit, the base and head commits, the sha256 digest of the feature diff
(`git diff base...head`), the changed paths, the declared semantic domains, its
dependencies, what it supersedes or consolidates, the checks that must be green,
a risk note and a train rank.

**ReviewReceipt** — a verdict bound to bytes. It carries the exact base and
head, the digest it read, the scope (`change`, `integration_delta`, `release`),
the verdict, findings, tests, the ingested artifact and its sha256, the digest
of the envelope it came from, and the reviewer's model and session.

**IntegrationAttempt** — one pass at the repository. It carries the lease fence
it ran under, the planned predecessor, the old and new head, the main it was
planned against, conflict paths, semantic intersections, the commands with their
exit statuses, and how it ended.

**MergeReceipt** — what actually landed. It carries the exact reviewed head, the
exact CI conclusions used, main before and after, the merge commit, the fence,
and the approval that caused it.

## The digest is the binding

A review is not bound to a branch name or to a pull request number. It is bound
to `sha256(git diff --binary base...head)` — the feature bytes.

That single choice decides the two cases the train keeps getting wrong:

- **A conflict-free base advance preserves the review.** main moved, the rebase
  replayed cleanly, the feature bytes are the same bytes: the receipt still
  describes them, and nobody re-reviews anything.
- **A conflict resolution does not.** The resolution is an edit no review has
  seen. It becomes an *integration delta* with its own digest — derived from the
  digest it started at and the digest it produced, so the agent that performed
  the resolution does not get to name the thing its review will be bound to. The
  change review stays on record for the bytes it read; the delta needs a bounded
  review of its own, and until it has one the merge gate is shut.

Where a checkout is reachable the digest is computed from the repository, and a
declared digest that contradicts it is refused. Where no checkout is reachable
the digest must be declared, and every surface marks it as a declaration.

## Path overlap is computed, semantic overlap is declared

Two change sets touching `main.ts` are an ordering problem: the train serializes
them and the second one rebases.

Two change sets that both implement the process-ownership contract are not an
ordering problem. Rebasing either one just moves the collision. No path
heuristic can see this, so semantic domains are declared — `--domain
supervisor.process-ownership@1` — and two open change sets sharing a domain with
no dependency, supersede or consolidation between them are `blocked_policy`.
Clearing that block is a decision, and `--consolidates` will not reach the log
without `--why`.

## The lease and the fence

One repository, one integration lease. Acquiring it raises a monotonic fence;
re-acquiring it as the same holder renews it at the fence already held, so a
supervisor that restarted does not fence out its own running attempt. Every
attempt and every merge presents a fence, and a fence that is not the current
one is refused with `stale_fence`.

A live lease refuses a second holder outright. Two supervisors that read "no
live lease" in the same instant would both append an acquisition at the same
fence, so an acquisition reads the lane back afterwards: the fold's last word
names one holder, and the other is told it lost rather than walking away with a
fence it shares.

Implementation and change review run in parallel and take no lease at all.
Rebase, conflict resolution and merge are the serialized lane.

## The merge gate

`self integration merge` allows a merge only when all of these hold:

| blocker code | what it means |
| --- | --- |
| `dependency_cycle`, `dependency_unknown` | no order exists |
| `unconsolidated_semantic_overlap` | two change sets claim one contract |
| `change_receipt_missing` | no standing approval bound to the current feature digest |
| `delta_review_missing` | an integration delta has no bounded review |
| `predecessor_open` | an earlier tied train item is not merged |
| `lease_not_current`, `stale_fence` | the lane is not held, or held at another fence |
| `ci_checks_undeclared`, `ci_not_green` | the exact head has no green result for a declared check |
| `approval_missing` | no human approval names this exact head |

Every refusal carries the code, the exact missing prerequisite and the next
eligible action. With `--json` it is a machine answer with a non-zero exit
status, not a crash.

## Receipts come from envelopes, and only from envelopes

An agent's prose, its exit code and the file it claims to have written create
nothing. The only path to a `review.received` event is `self review ingest
--file <envelope.json>`, and the supervisor — not the reviewing agent — runs it.

The envelope is provider-neutral. `self review contract` prints it as JSON; the
schema is `superself.review-result/1`:

```json
{
  "schema": "superself.review-result/1",
  "changeSet": "cs-2f4k9",
  "scope": "change",
  "base": "<40 hex>",
  "head": "<40 hex>",
  "digest": "<sha256 of the reviewed bytes>",
  "verdict": "approve",
  "findings": [],
  "tests": [{ "name": "pnpm proof", "status": "pass" }],
  "artifact": { "path": "report.md", "sha256": "<sha256>", "bytes": 4096 },
  "reviewer": { "name": "review session", "model": "claude-opus-5" },
  "completedAt": "2026-07-27T09:00:00Z"
}
```

Ingestion validates the schema and every required field, resolves the artifact
relative to the envelope file, checks its size and sha256 against the
declaration, copies the bytes into the store atomically, hashes the envelope,
and only then records the receipt. A missing artifact, tampered bytes, an
approval with no tests, a head that has moved, or a digest the controller does
not know are each refused with a typed code and leave no receipt behind.

A later verdict on the same bytes is the standing one: a rejection after an
approval closes the gate again, and a fresh approval after a fix reopens it.

## Reconciliation

GitHub is a projection. CI conclusions and main advances arrive as observations
carrying a dedupe key and the instant they were observed. The same webhook
delivered twice is one observation; an observation that arrives late but
happened earlier never overwrites a newer one.

`self integration reconcile` is the convergence step. It makes a lapsed lease
durable and cancels every in-flight attempt whose fence is dead, whose main has
moved, or whose head has changed — with the reason recorded. It never silently
retries, and running it again writes nothing.

## Commands

```text
self integration [status] [--repo r] [--json]
self integration register --repo r --base b --head h [--pr n] [--work id]
            [--domain name@ver] [--depends cs] [--supersedes cs] [--consolidates cs]
            [--check name] [--rank n] [--risk r] [--diff-digest d] [--repo-dir p] [--offline]
self integration show <id> [--json] | list [--all] [--json] | plan [--repo r] [--json]
self integration declare <id> [--domain d] [--depends cs] [--consolidates cs --why w] [--check c] [--rank n]
self integration head <id> --head h [--base b]
self integration close <id> --as superseded|abandoned [--why w]
self integration lease acquire --repo r --holder h [--ttl minutes] [--expires iso]
self integration lease release --repo r --fence N | show --repo r [--json]
self integration attempt start <id> --fence N --action rebase|resolve|merge [--json]
self integration attempt finish <attempt> --outcome completed|conflict|failed
            [--head h] [--base b] [--conflict-path p] [--intersection d] [--command "cmd:exit"]
self integration attempt cancel <attempt> --why w
self integration observe ci --repo r --head h --check c --conclusion x [--at iso] [--dedupe k]
self integration observe main --repo r --head h [--at iso] [--dedupe k]
self integration observe --file <batch.json>
self integration approve <id> --head h [--by name]
self integration merge <id> --fence N --merge-commit m --main-before a --main-after b [--json]
self integration reconcile [--repo r] [--json]
self review request <id> --scope change|integration_delta|release [--json]
self review ingest --file <envelope.json> [--json]
self review list [<id>] [--json] | contract
```

## The fixture

`apps/cli/proof/integration.sh` replays the train that produced this controller:
superself PR #43 → #44 → #52, three branches changing the same CLI files, two of
them claiming the same architecture contract. It builds a real git repository in
a temporary directory, so every digest in it is computed from bytes, and it runs
offline.

It proves, among other things, that a premature #52 attempt is refused before
git is touched, that an envelope declaring an artifact that is not there leaves
no receipt however loudly the agent approved, that #44's review survives a
conflict-free base advance and does not survive its conflict resolution, that a
merge is refused on a stale fence, on red CI, on a moved head and on an
unreviewed delta, and that reconciling twice writes nothing the second time.

It also carries a pair of branches with no file in common that declare one
contract, so the semantic block is proved on an overlap no path comparison can
reach; a second holder refused a live lease; and an attempt invalidated by each
of the three things that can invalidate one — a dead fence, a main that moved,
and an author's push under a pass in flight.
