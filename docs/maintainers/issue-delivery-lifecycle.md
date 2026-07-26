# Issue delivery lifecycle

An accepted issue is not delivered when its pull request opens. It is delivered
when the machine whose company state depends on the CLI is running the published
build and has proved that build answers in a real workspace.

This page is the contract. `tools/delivery` enforces it, and
`tools/delivery/proof/proof.sh` proves the enforcement, so an agent runner that
follows the verbs below cannot skip a step by being convinced to.

## States

| State | Means |
| --- | --- |
| `implementing` | The implementation agent is working on the accepted issue. |
| `pr_ready` | A pull request is open at a known head commit, awaiting review. |
| `reviewing` | A fresh session is reading the whole issue and the whole diff. |
| `fixing` | The review returned actionable findings to the implementation agent. |
| `merging` | Zero actionable findings; the pull request awaits its policy gates. |
| `releasing` | Merged; the version, tag, and npm publication are in progress. |
| `local_updating` | Published; this machine must install and smoke the exact version. |
| `released` | Terminal. Every piece of evidence below exists. |
| `failed` | Terminal until resumed. Logs are preserved and a human is escalated. |

`released` is the only success state. Nothing in the runner may treat "pull
request opened" as done.

## Transitions

Run `node tools/delivery/bin/delivery.mjs states` to print the enforced graph.
It is generated from the same table the gates read, so this page and the tool
cannot drift apart silently.

```text
pr              implementing -> pr_ready
review start    pr_ready -> reviewing
review finish   reviewing -> merging | fixing
fix             fixing -> pr_ready
merge           merging -> releasing
release         releasing -> local_updating
install         local_updating -> (records evidence)
smoke           local_updating -> (records evidence)
done            local_updating -> released
check           any live state -> (records evidence)
log             any live state -> (records evidence)
fail            any live state -> failed
resume          failed -> the state it failed from
```

`open` starts the record in `implementing`. A live state is any state other
than `released` and `failed`.

## Gates

Each gate exists because the step before it can look finished while being
wrong.

**A review is a different session.** `review start` refuses a session id equal
to the implementation session or to any session that already reviewed this pull
request. Asking the implementation session to grade its own work produces
agreement, not review.

**A review covers the current head.** `review finish` reports the commit it
read, and the round is rejected unless that commit is still the pull request
head. A fix pushed mid-review invalidates the round: the next review reads the
complete pull request again, not only the previous finding.

**A fix is a new commit.** `fix` refuses a head equal to the reviewed head.

**Checks are green at a commit, not in general.** Every check result is recorded
against the head it ran on. A fix therefore invalidates all of them, and the
merge gate looks only at results from the current head.

**A merge needs sign-off and every required check.** `merge` refuses an
unsigned-off pull request and any required check that is not green at the
current head. The required set defaults to `verify`, `contribution-policy`, and
`dco`, matching the `main` ruleset in
[releases.md](releases.md).

**A release is one version.** `release` refuses unless the tag, the package
manifest version, and the version npm reports are the same release, and unless
the GitHub Release url is https. CI already enforces tag/manifest equality in
[`publish.yml`](../../.github/workflows/publish.yml); the ledger adds what npm
actually accepted, so a partial publish cannot pass as a release.

**The install is exact.** `install` refuses any version other than the published
one. There is no "close enough" upgrade.

**The smoke run is on the installed build.** `smoke` refuses results before an
install is recorded. `done` requires passing `self --version`, `self context`,
and `self status` plus at least one check named `feature:<name>` that only this
change would satisfy. `tools/delivery/bin/smoke.sh` runs all four against a real
workspace and records the verdicts.

**Non-convergence fails.** After `--max-review-rounds` rounds (default 5) still
reporting findings, the delivery moves to `failed` with the reason recorded and
every round preserved. The runner escalates; it never lowers the bar and never
publishes.

**Done means done.** `done` prints whatever evidence is still missing and
refuses. `released` accepts no further verbs.

## Evidence recorded

Pull request number and head commit, sign-off, every required check result with
its commit, every review round with its session id and finding count, the merge
commit, the tag, the package version, the published npm version, the GitHub
Release url, the version this machine now runs, each smoke verdict, and
references to preserved logs.

`delivery comment` renders that chain as the markdown the runner posts on the
issue.

## What never enters the ledger

The ledger is quotable into a public issue comment, so it is the boundary where
local data stops. Redaction happens on the way in, not at render time: GitHub,
npm, OpenAI-style, AWS, bearer, and PEM credentials, plus `password=`-style
assignments, become `[redacted]`; this machine's home directory becomes `~`;
every free-text field is collapsed to one line and truncated, so a file dump or
workspace listing cannot ride along inside a note.

Logs are referenced by path, never by contents. Commit shas, versions, and urls
are validated rather than accepted as free text.

## Where the ledger lives

Outside this repository, under `$SUPERSELF_DELIVERY_DIR`, defaulting to
`$XDG_STATE_HOME/superself-delivery`. The polling runner is machine-specific and
stays out of the repository; the repository owns this contract, the gates, and
the proof. A record survives a session ending, so a failed publish resumes at
`releasing` and never reruns the implementation.

## Running it

```bash
node tools/delivery/bin/delivery.mjs open --issue 123 --session impl-123
node tools/delivery/bin/delivery.mjs pr --issue 123 --pr 456 --head <sha> --signed-off
node tools/delivery/bin/delivery.mjs check --issue 123 --name verify --status green
node tools/delivery/bin/delivery.mjs review start --issue 123 --session review-123-a
node tools/delivery/bin/delivery.mjs review finish --issue 123 --head <sha> --findings 0
node tools/delivery/bin/delivery.mjs merge --issue 123 --commit <sha>
node tools/delivery/bin/delivery.mjs release --issue 123 --tag v0.2.0 \
    --package-version 0.2.0 --npm-version 0.2.0 --release-url https://github.com/...
node tools/delivery/bin/delivery.mjs install --issue 123 --version 0.2.0
bash tools/delivery/bin/smoke.sh --issue 123 --version 0.2.0 --workspace ~/work \
    --feature artifact-list --feature-cmd "self artifact list"
node tools/delivery/bin/delivery.mjs done --issue 123
```

`delivery status --issue 123` prints the current state and everything still
missing at any point.
