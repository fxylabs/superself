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
- Allman braces: the opening brace of every block goes on its own line.
- Four spaces, semicolons required.
- Reuse the helper that exists; do not re-derive it locally. Current shared
  homes: `trainutil.ts` exports `requireText`; `args.ts` exports `parseCommand`,
  `subcommand`, `unknownOption`, and `helpHint`; `ids.ts` mints every id;
  `attempt/spool.ts` owns the machine-local spool. `strip` and the `str`/`list`
  payload coercers are duplicated today and are unified by #88 — import the
  survivor rather than adding a fourth copy.
- Comments explain why a rule exists, not what the next line does. The existing
  modules set the density; match them.
- No behavior change smuggled into a move. A refactor pull request leaves the
  proof assertions untouched.

## Adding a command verb

A new verb ships as a set. A pull request that adds one without all four is
incomplete:

1. A `parseCommand` guard in the command module, declaring its options and how
   many positionals it accepts.
2. A `COMMANDS` entry in `help.ts` with usage and detail — that file is the one
   place the CLI describes itself, so `self` and `self <cmd> --help` stay in
   sync.
3. Every refusal as a one-line `CliError` that says what was refused and why,
   in the user's terms. A refusal that only names a rule teaches nothing.
4. Proof coverage under `apps/cli/proof/` for the behavior the verb adds,
   including the refusal path.

Subcommand dispatch reads through `args.ts` `subcommand`, so `--` means the
same thing across the whole CLI.

## Proof scripts

Proof scripts run on a contributor's macOS laptop and on the ubuntu CI runner,
against whatever git the host has. Write them checkout-agnostic:

- Never assume a default branch name. Pin it: `git init -q -b main`, or set
  `init.defaultBranch` in the scratch home before the first `git init`. A script
  that assumes `main` passes locally and fails on the runner.
- Never assume a local `main` exists in the repository under test, and never
  read the real workspace. Point `HOME` and `XDG_CONFIG_HOME` at a scratch
  directory per simulated machine, as `proof/proof.sh` does.
- Never assume user git config. Set `user.name` and `user.email` in each scratch
  home; Linux leaves the ident empty where macOS silently fills it in.
- Never use macOS-only tools. `stat -f`, `sed -i ''`, and BSD-only flags do not
  exist on the runner; keep the script to POSIX shell plus git and node.
- Pin scratch-repo state explicitly — branch, commits, and config — instead of
  inheriting it from the environment.
- Clean up with a `trap ... EXIT` on the temp root.

### Proof-run economy

Proof scripts build scratch repositories and drive the CLI end to end — tens of
seconds per run. They are a gate, not a development feedback loop. Until #92
ships tiered suites, budget them:

- While implementing, get feedback from `pnpm typecheck` and direct node
  invocations of the changed surface, not from the proof harness.
- While writing a new proof script, run only its minimal single scenario.
- Run the touched proof sections at most twice per change: once when the
  implementation is complete, and once after fixing what that run caught.
- Anything beyond that is CI's job — the verify workflow runs the full sweep on
  every pull request.

## Result envelope contract

An agent running under `self attempt run` is judged by the envelope it writes,
not by its exit code or its summary. This is the durable statement of that
contract (#63); `attempt/gate.ts` is its implementation.

Stage artifacts under `$SUPERSELF_ATTEMPT_OUT`, then write the envelope as JSON
to `$SUPERSELF_ATTEMPT_RESULT`:

```json
{
  "status": "completed",
  "summary": "one line describing what the attempt produced",
  "artifacts": [
    { "name": "impl-report.json", "sha256": "<64 hex chars>", "bytes": 12051 }
  ]
}
```

Rules the gate enforces:

- The key is `name`, never `path`. It is the declared artifact name from the
  plan, not a filesystem location.
- `sha256` and `bytes` are computed over the exact staged file, after the last
  write to it:

  ```bash
  ART="$SUPERSELF_ATTEMPT_OUT/impl-report.json"
  shasum -a 256 "$ART" | cut -d' ' -f1     # sha256
  stat -f %z "$ART"                        # bytes, macOS
  stat -c %s "$ART"                        # bytes, Linux
  wc -c < "$ART"                           # bytes, either
  ```

  Hand-computing a hash before the final write is the common way to fail this
  gate. Compute both fields last.
- `status` must be `completed` for the attempt to pass. Anything else is a
  failed or blocked attempt, and the gate treats it as one.
- A missing envelope is a failed attempt. An exit code alone is not a result.
- Every artifact the plan declares must be claimed in the envelope, exist, hash
  to what was claimed, and match the claimed byte count. One mismatch refuses the
  whole attempt. The gate walks the plan, so an extra artifact in the envelope
  that the plan never declared is ignored rather than verified — do not treat it
  as a way to publish something.

The same `{name, sha256, bytes}` shape appears in `AttemptSummary.artifacts`
after the fold. Keep them identical.

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
pnpm typecheck
pnpm build
```

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
- Run `pnpm typecheck` and `pnpm build` locally. The full `pnpm proof` suite is
  delegated to PR CI — CI runs typecheck, proof, and build on every pull
  request. Run the targeted proof section locally when you changed the behavior
  it covers.
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
