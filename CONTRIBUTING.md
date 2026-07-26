# Contributing to Superself

Thanks for helping build Superself.

Superself is pre-release software. Issues and design feedback are welcome now.
Code contributions follow an issue-first, maintainer-approved process.

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

## Delivery lifecycle

An open pull request is not a delivered issue. Agent runners that carry an
accepted issue all the way to a machine running the published build follow
[docs/maintainers/issue-delivery-lifecycle.md](docs/maintainers/issue-delivery-lifecycle.md),
which defines the states, the gates between them, and the evidence an issue must
record before it closes.
