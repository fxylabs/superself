# Contributing to Superself

Thanks for helping build Superself.

Superself is pre-release software. Issues and design feedback are welcome now.
Code contributions follow an issue-first, maintainer-approved process.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before writing code. It states the
layering, the subsystem boundaries, the single gates, and the owned event
namespaces. This document states the conventions your implementation is judged
by. Both apply to human and agent implementers alike.

## Contribution model

Every change intended for `main` starts with an issue, including maintainer,
documentation, dependency, refactor, test, CI, and release work:

1. Open the appropriate bug, feature, or maintenance issue and discuss its
   problem and scope.
2. Wait for a maintainer to add the `status:accepted` label.
3. Wait for a maintainer to assign the issue to you.
4. Create `<type>/<issue-number>-<short-description>` from current `main`.
5. Open one focused pull request containing `Closes #123` for that issue.

An accepted issue is approval of the agreed scope, not blanket approval of an
implementation. Do not begin implementation merely because an issue exists.
Pull requests for unaccepted issues, or from authors who are not assigned to the
linked issue, will be closed without code review.

Not every observation needs a new issue. Record work that remains inside the
accepted scope on the existing issue. If implementation reveals a separate
problem, improvement, or cleanup, open a new issue and keep it out of the
current branch and pull request.

Security work is coordinated privately under [SECURITY.md](SECURITY.md). Do not
open a public issue or pull request for an undisclosed vulnerability.

### Maintainer triage

Maintainers add `status:accepted` only after the problem, repository boundary,
and intended scope are clear enough to implement. Assignment identifies who is
authorized to open the pull request; the label alone is not an open invitation.
The `contribution-policy` check verifies both conditions from GitHub metadata.

Issue labels carry maintainer triage state only:

- `status:accepted` marks scope a maintainer has accepted for implementation.
- `status:deferred` marks accepted scope deliberately not being worked now; the
  deferring comment names the condition under which work resumes.
- No label carries execution state. Whether work on an issue is queued, running,
  or finished is read from the self CLI's own records — the work log and the
  machine-local process ledger — not from GitHub metadata.

## Before opening an issue

1. Search existing issues for the same symptom or proposal.
2. Use the bug form for behavior that differs from the documented contract.
3. Use the feature form to explain a user problem before proposing an API or UI.
4. Use the maintenance form for documentation, refactor, test, dependency, CI,
   release, and repository work.
5. Do not post secrets, pairing URLs, instance secrets, private workspace data,
   or credentials in an issue.
6. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Questions about current limitations may be filed as a feature request when they
identify a missing workflow. General support channels will be added after the
first preview release.

## Product and framework boundary

Keep changes in the repository that owns the policy:

- Superself owns its domain, UI, local principal, pairing, data location,
  backup/restore, migrations, and process lifecycle.
- SPFN owns reusable route, database-provider, Vite integration, and build
  behavior that can serve unrelated applications.

A useful test is:

> Could another SPFN project use this code unchanged without importing a
> Superself domain type?

If yes, start with an issue describing the upstream SPFN seam before adding
the code here. The current CLI slice has no SPFN runtime dependency; this
boundary applies to the later, optional web layers.

## Local setup

Requires Node.js 22.12+ and pnpm 10.

```bash
nvm use
pnpm install
pnpm build
```

## Code style

- Functions stay within 20-30 lines and do one thing. A function that routes
  subcommands routes them; it does not also implement one of them inline.
  `pnpm structure` enforces this on the diff at 30 lines. A function your branch
  adds or edits is measured; one you did not touch is not.
- Allman braces: the opening brace of every block goes on its own line.
- Four spaces, semicolons required.
- Reuse the helper that exists; do not re-derive it locally. Current shared
  homes: `args.ts` exports `parseCommand`, `subcommand`, `unknownOption`, and
  `helpHint`; `ids.ts` mints every id; `ledger.ts` owns the machine-local
  process ledger. Import the survivor rather than adding another copy.
- Comments explain why a rule exists, not what the next line does. The existing
  modules set the density; match them.
- No behavior change smuggled into a move. A refactor pull request leaves the
  test assertions untouched.

## Adding a command verb

A new verb ships as a set. A pull request that adds one without all six is
incomplete:

1. A `leaf` in the owning command's contract declaration, stating its options,
   how many positionals it accepts, and which options it cannot run without —
   the dispatcher hands them to `parseCommand`, so nothing a command accepts or
   demands is declared anywhere else. A requirement carries the hint that
   explains it and, where its precondition lives on another verb, the exact
   spelling that unblocks it; the handler never asks for it a second time.
2. A usage line and detail in that same `Command` declaration — the one place
   the CLI describes itself, so `self` and `self <cmd> --help` stay in sync,
   and `test/contract.test.mjs` fails a verb that is documented without being
   dispatchable or the other way around.
3. Every refusal as a one-line `CliError` that says what was refused and why,
   in the user's terms. A refusal that only names a rule teaches nothing. The
   one refusal that runs to several lines is the required-option gate's, which
   lists every missing option at once rather than revealing them one command
   round at a time; it is rendered by the gate, never written by a command.
4. Test coverage under `apps/cli/test/` for the behavior the verb adds,
   including the refusal path — a unit test where the behavior is in-process
   logic, a case in the integration tests where it is a CLI contract.
5. A statement of the scope it answers for. A read verb defaults to the project
   the directory resolves to, accepts `--project <slug>`, and either offers a
   `--workspace` form or says in its command's help detail why it has none. A write
   verb states that it takes neither and records into the project it runs in.
   Both resolve through `paths.ts` `readScope`/`readScopes` rather than reading
   the registry themselves — see the scope contract in
   [ARCHITECTURE.md](ARCHITECTURE.md#fixed-naming).
6. What a successful run answers, returned rather than printed. The handler
   hands back a `CommandOutput` — blocks of the four shapes a command can
   answer with, `value` for a scalar a caller reads, `receipt` for what a write
   recorded, `listing` for rows a reader scans, `document` for a page — and
   calls neither `console.log` nor `process.stdout.write`; `pnpm structure`
   fails a verb that does, by file, line and rule. The gate in `output.ts`
   prints them, and it owns the render-mode resolution: a block that reads two
   ways carries both renders as thunks and the gate calls exactly one, so no
   handler asks whether this run is a terminal or a pipe. A listing states its
   `total` — not `rows.length` — and, where the rows are a window onto more, a
   `window` carrying both how many are shown and the command that prints the
   rest; either half without the other is what the required field exists to
   refuse. The gate writes the size line from them, so every listing in the CLI
   states its size in the same words. Shapes compose: a verb that records
   something and then lists the result returns `[receipt, listing]` rather than
   a fifth shape that is both.

Subcommand dispatch reads through `args.ts` `subcommand`, so `--` means the
same thing across the whole CLI.

A verb that introduces a new *statement-type record* — something a person
asserts and can later take back — ships more than those six. It ships the
whole lifecycle set: supersede with a linked successor, withdraw with `--why`
and no successor, and decline where the type has proposals. See
[the record lifecycle](ARCHITECTURE.md#the-record-lifecycle) for what each
transition has to fold to, and add the type to `STATEMENT_TYPES` in
`@superself/fold` `model.ts` — the one declaration of the statement types,
which the per-record history reads and `apps/cli/test/lifecycle.test.mjs`
enumerates, so a statement type cannot land without its lifecycle verbs in its
own help.

## Tests

`pnpm test` runs the whole tier — unit tests plus the CLI integration tests —
on every pull request. It takes minutes, not seconds: around twelve at the
current suite size, and the figure grows as the suite does. The run prints
nothing until it finishes, so a long silence is the normal case and not a
hang — do not kill it, and give any watchdog wrapping it room for a run that
long.

The full suite runs once and alone per machine. Each integration test refolds
the store many times, so two suites running at once slow each other far more
than twofold: measured on 2026-08-23, 1003 tests took 8,144 seconds on a laptop
where six agents ran the suite together, and five of those runs were lost to
timeouts. A session that is not alone on its machine — a parallel agent, a
second checkout with a suite already running — runs `pnpm typecheck`,
`pnpm build`, `pnpm structure` and the test files it touched locally, and
leaves the full suite to CI's `verify` job, saying so in the pull request body.
CI runs the whole tier on every pull request either way.

### Reaching the CLI from a test

A case runs a command through `must` or `selfIn` from `test/harness.mjs`, and
both run it **in the test process** — the same `runCli` the binary calls, with
the working directory, the environment and the terminal set to what a child
would have had. Both are `async`, so every call needs an `await`; the structure
check refuses one that has none, and the driver refuses a second command
started on top of an unawaited first.

The suite used to spawn `bin/self.mjs` once per case. That is 2,264 process
launches, and on macOS every launch of a non-notarized `node` goes through the
OS policy check: the suite spent 94% of its wall clock waiting on that, and
slowed the whole machine down while it did (#371).

A handful of cells still need a real process, and say so by calling `spawnIn`
or `mustSpawn` instead:

- the terminal check itself — a driven process has whatever terminal the driver
  hands it, so "a process with no terminal is refused" needs one that really
  has none;
- the three files that set `isTTY` above their imports, because `style.ts`
  answers "is this run styled" once, at module load, and normalising the
  terminal per call is too late for that;
- `smoke.test.mjs`, which is the only place a shebang, the `bin` mapping and
  the module resolution of a published install are exercised at all;
- `golden.mjs`, whose fixture is a record of what a **piped run** prints.

Anything else driven as a child is a cell that has not said why. The reason
belongs beside it, and the list belongs in
[`docs/maintainers/case-tables/371-in-process-cli-driver.md`](docs/maintainers/case-tables/371-in-process-cli-driver.md).

One process now runs many commands, so nothing a command learns may outlive it.
`runCli` clears every module-level cache on entry, and the `invocation-state`
structure rule refuses a new one that no reset reaches — add the reset, or name
the binding in `invocationStateExemptions` with the reason it needs none.

The integration tests run on a contributor's macOS laptop and on the
ubuntu CI runner, against whatever git the host has. Write them
checkout-agnostic:

- Never assume a default branch name. Pin it: `git init -q -b main`, or set
  `init.defaultBranch` in the scratch home before the first `git init`. A script
  that assumes `main` passes locally and fails on the runner.
- Never assume a local `main` exists in the repository under test, and never
  read the real workspace. Point `HOME` and `XDG_CONFIG_HOME` at a scratch
  directory per simulated machine, as `test/harness.mjs` does.
- Never assume user git config. Set `user.name` and `user.email` in each scratch
  home; Linux leaves the ident empty where macOS silently fills it in.
- Never use macOS-only tools; keep everything to node plus git.
- Pin scratch-repo state explicitly — branch, commits, and config — instead of
  inheriting it from the environment.

Assert product behavior, never the suite's own coverage: what fails when the
CLI is wrong, not whether the test file still lists every case a diff would
already show.

## Branches

`main` is the only long-lived branch. Direct pushes to `main` are not allowed;
all changes enter through pull requests. Create a short-lived branch only after
the issue is accepted and assigned, using this format:

```text
<type>/<issue-number>-<short-description>
```

For example:

- `feat/123-artifact-library`
- `fix/148-pairing-token-replay`
- `docs/152-local-backup-policy`
- `refactor/161-database-provider`
- `test/174-restart-recovery`
- `chore/183-update-toolchain`

The allowed types are `feat`, `fix`, `docs`, `refactor`, `test`, and `chore`.
External contributors work from a fork and are not granted branches in the
upstream repository. Do not create `develop` or permanent release branches.
Keep one concern and one closing issue per branch and pull request.

## Before opening a pull request

Run the same checks as CI:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm structure
```

`pnpm test` is the full tier and runs once and alone per machine (see
[Tests](#tests)); when another suite is already running on your machine, run
the other three plus the test files you touched, and say in the pull request
body that the full suite is left to CI.

`pnpm structure` needs history to diff against, so it refuses on a shallow
clone and names the fix rather than passing empty. Point it at another base
with `--base <ref>` or `STRUCTURE_BASE` when you are not branched off `main`.

Pull requests should:

- explain the user-visible problem and result;
- stay focused on one concern;
- link the accepted issue with a closing keyword such as `Closes #123`;
- be opened by an assignee of the linked issue;
- add regression coverage for behavior changes;
- include screenshots or a short recording for visual changes;
- state whether local data, migrations, pairing, or security boundaries change;
- state which operating systems were exercised;
- avoid version bumps and release tags unless a maintainer requested them.

If there is no visual or persistent-data change, say so explicitly.

Pull requests target `main` and are squash merged after all required checks,
review, and conversations are complete. Delete the source branch after merge.

## Delivery mechanics

How a finished branch is handed over. These apply to agent-executed briefs as
much as to hand-written work:

- One squashed commit per branch, with a DCO `Signed-off-by` trailer matching
  the commit author.
- The pull request title names the issue's outcome, and the body contains
  `Closes #N` for the single accepted issue.
- Run `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm structure` locally
  — CI runs the same four on every pull request. The full `pnpm test` runs
  once and alone per machine; a session that is not alone runs the other
  three plus the suites it touched and says in the body that the full suite is
  left to CI.
- Do not use `gh pr edit`; it rewrites fields you did not intend to touch. Set
  the title and body at `gh pr create` time, or PATCH the specific field through
  the API.
- Do not merge your own pull request, retarget the branch, or push to any branch
  but your own.
- Consult [ARCHITECTURE.md](ARCHITECTURE.md) before the first line of code, not
  at review time. A pull request that adds a flat top-level subsystem or a
  second path around a single gate is sent back regardless of how it tests.

## Developer Certificate of Origin

Every commit must certify the [Developer Certificate of Origin](DCO). Sign off
with the same name and email recorded as the commit author or committer:

```bash
git commit -s -m "feat: add artifact revision list"
```

Git adds a trailer like this to the commit message:

```text
Signed-off-by: Your Name <you@example.com>
```

This sign-off certifies that you have the right to submit the contribution
under the project's license; it is not a cryptographic commit signature. The
`dco` check requires a matching sign-off on every commit in a pull request.
Configure Git with the identity you intend to publish before committing.

## Commit style

Use an imperative summary that explains the outcome. Conventional Commit-style
prefixes are encouraged but not required:

```text
feat: add artifact revision list
fix: reject expired pairing tokens
docs: define backup compatibility
```

Pull requests are squash merged, so branch history does not need to be perfect.
The final squash commit should use an imperative summary that reflects the
accepted issue.

## Licensing contributions

Superself is licensed under the [Apache License 2.0](LICENSE). Unless you
explicitly state otherwise, any contribution intentionally submitted for
inclusion in Superself is provided under that license, as described in Section
5 of the license. Do not submit code, assets, or other material that you do not
have the right to contribute under those terms.

## Releases

Version changes, tags, and GitHub Releases are maintainer-managed. See
[docs/maintainers/releases.md](docs/maintainers/releases.md).
