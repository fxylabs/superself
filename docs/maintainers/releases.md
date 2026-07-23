# Branch, version, and release policy

Superself uses trunk-based development and Semantic Versioning. This policy is
intentionally smaller than the release machinery used by mature packaged apps;
automation should grow only when the distribution surface requires it.

## Branches

- `main` is the only long-lived branch and should remain releasable.
- Changes arrive through short-lived `feat/`, `fix/`, `docs/`, `refactor/`,
  `test/`, or `chore/` branches named
  `<type>/<issue-number>-<short-description>`.
- Every change, including maintainer and release work, starts from an accepted
  and assigned issue.
- Direct and force pushes to `main` are prohibited. Changes enter through
  squash-merged pull requests, and merged branches are deleted.
- External contributors work from forks rather than branches in the upstream
  repository.
- There is no `develop` branch.
- Release branches are not created for normal releases.
- Until a maintenance-release policy is introduced, fixes target current
  `main`; older tags are not patched independently.

After the first commit, protect `main` with a branch ruleset that:

- requires a pull request and at least one maintainer approval;
- dismisses stale approvals when new commits are pushed;
- requires resolved review conversations;
- requires the CI `verify`, `contribution-policy`, and `dco` status checks;
- requires linear history and blocks force pushes and branch deletion;
- applies to maintainers without routine bypass.

Repository merge settings should allow squash merge only and automatically
delete head branches after merge.

## Repository bootstrap

After the initial source commit:

1. create the `status:accepted` label for maintainer-approved implementation;
2. enable the `main` ruleset described above;
3. make `verify`, `contribution-policy`, and `dco` required after each check has
   run at least once;
4. require contributors to sign off on web-based commits;
5. allow squash merge only and enable automatic head-branch deletion;
6. confirm private vulnerability reporting points to the security policy.

Only maintainers apply `status:accepted`. Issue forms intentionally do not add
it automatically.

## Versions and tags

Product tags use `vMAJOR.MINOR.PATCH`:

```text
v0.1.0
v0.1.1
v0.2.0
v1.0.0
```

Prereleases use standard identifiers with a monotonically increasing number:

```text
v0.1.0-alpha.0
v0.1.0-beta.0
v0.1.0-rc.0
```

- `alpha`: architecture and data contracts can change without migration.
- `beta`: the milestone is feature-complete; migration and backup behavior are
  being validated.
- `rc`: intended release bits; only release-blocking fixes should land.
- stable `0.x`: usable releases that may still make breaking changes in a minor
  version.
- `1.0.0`: CLI, local data, migration, backup/restore, and security contracts
  have explicit compatibility guarantees.

The initial public source commit does not need a tag. The first tag should mark
an installable preview rather than repository creation.

Tags are annotated and maintainer-managed. Contributors should not include a
version bump or tag in ordinary pull requests.

## Release flow

Until packaging exists, a maintainer release is:

1. open and accept a release issue, then assign its maintainer;
2. create a kebab-case release branch such as
   `chore/<issue-number>-release-v0-1-0` from current `main`;
3. run CI from a clean checkout;
4. decide the SemVer increment from user-visible and compatibility impact;
5. update the product version and release notes in one release pull request;
6. squash merge the release pull request;
7. create an annotated tag on that merge commit;
8. create a GitHub Release and mark prereleases correctly.

When CLI or desktop artifacts are published, replace manual tagging with one
GitHub Actions workflow that computes the version, creates the tag, builds every
platform from that tag, verifies all required assets, and only then publishes
the draft release.

## Package versions

The local application currently has one product version. Framework packages
extracted for SPFN should be versioned in the SPFN repository. If independently
published packages are later added here, their versioning policy must be
decided before the first package release rather than inferred from product tags.
