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

Prereleases are **not releasable yet**, and the gate refuses them. Both packages
publish with npm's default dist-tag, `latest`, which is where every
`npm i -g superself` reads from — so a `v0.13.0-rc.1` tag would replace the
stable install target for everybody with a release candidate. Which channel a
prerelease should land on is decided nowhere, and a gate may not invent one, so
`scripts/release-gate.mjs` refuses any tag naming a prerelease or carrying build
metadata — the tag's own, and `apps/fold/package.json`'s, which the tag never
spells and which publishes from the same run — and says that in a sentence. The
grammar above is the naming to use
once that policy exists and the workflow is taught to pass `--tag`; until then a
release is a final version.

The initial public source commit does not need a tag. The first tag should mark
an installable preview rather than repository creation.

Tags are annotated and maintainer-managed. Contributors should not include a
version bump or tag in ordinary pull requests.

## Release flow

A maintainer release is one pull request and one tag. The tag is what publishes:
pushing `vMAJOR.MINOR.PATCH` runs `.github/workflows/publish.yml`, which refuses
or publishes both npm packages with no further hand on it.

1. open and accept a release issue, then assign its maintainer;
2. create a kebab-case release branch such as
   `chore/<issue-number>-release-v0-13-0` from current `main`;
3. run CI from a clean checkout;
4. decide the SemVer increment from user-visible and compatibility impact;
5. in one release pull request, raise **three** numbers together — the CLI's
   version in `apps/cli/package.json`, the fold's version in
   `apps/fold/package.json`, and the CLI's `@superself/fold` pin to match the
   fold's exactly — and write the release notes. See
   [Package versions](#package-versions) for why all three move even when the
   fold did not change;
6. squash merge the release pull request;
7. create an annotated tag naming the CLI's new version on that merge commit,
   and push it;
8. watch the `Publish` workflow. Its `gate` job states every reason to refuse
   before anything uploads; if it refuses, the sentences name what to change and
   nothing was published. On a pass, `publish-fold` runs and then `publish-cli`;
9. create a GitHub Release on the tag.

One release, one tag, and step 7 is where that matters most. `Publish`
serialises `v*` runs in a single concurrency group and cancels nothing in
progress, but a group holds one run in flight and only **one** waiting: a third
`v*` tag pushed into that queue cancels the waiting one, which then publishes
nothing and says so only as a cancelled run nobody was watching. Two tags at
once queue correctly; three do not.

Step 5 is not left to memory: `scripts/release-gate.test.mjs` runs the gate's
rules against this repository's own two manifests on every pull request, so a
release pull request that moved one of the three numbers and not another is red
long before it is a bad tag.

Step 5's notes quote real CLI output, so set `SUPERSELF_API_BASE` to a closed
loopback — `https://127.0.0.1:9` — before running any `--cloud` command whose
output will be pasted. With no base set the CLI goes to `DEFAULT_API_BASE`,
which is the live product host and does not serve the workspace API, so what
comes back is that host's 404 page rather than anything the notes are about
(#434).

The first tag that would publish a package needs one thing steps 1–9 cannot do,
once, by hand: see
[Bootstrapping a package's first publish](#bootstrapping-a-packages-first-publish).
`@superself/fold` has been published since v0.13.0, so no current package
needs it; the next new package will.

Desktop and platform artifacts are not published from here yet. When they are,
step 8 grows to build every platform from the same tag and verify all required
assets before a draft release is published — the npm packages already work that
way.

## Package versions

Framework packages extracted for SPFN are versioned in the SPFN repository.

This repository publishes two packages from one tag: `superself` (`apps/cli`),
which is the product, and `@superself/fold` (`apps/fold`), which is the
calculation the CLI and the Workspace API server both read an event log with.
The fold is an internal implementation package rather than one marketed on its
own, so its version is coordinated with the release it ships in rather than
managed independently. The rule is:

- the tag `vMAJOR.MINOR.PATCH` names the **CLI's** version and must equal
  `apps/cli/package.json`;
- the fold's version is whatever `apps/fold/package.json` says, raised in the
  release pull request beside the CLI's when the fold changed;
- the CLI depends on the fold by that **exact version** — a range would let one
  tag mean two different pairs depending on when it was installed;
- neither version may already be on the registry, and the tag's commit must be
  on `main`;
- both versions are finals — a prerelease or build-metadata version is refused
  while no dist-tag policy exists, whether the tag spells it or only
  `apps/fold/package.json` does.

All of them are checked before anything uploads, by `scripts/release-gate.mjs`
running in the `gate` job of `.github/workflows/publish.yml`. The same job runs
the pinned-root-key check (`pnpm --filter superself release-keys`), which the
CLI's `prepublishOnly` also runs: it is the one refusal that could otherwise
fail the run after the fold was already published, so it is collected with every
other reason to refuse. The fold is published first and the CLI only after it
succeeds: an extra fold version nothing depends on is inert, while a CLI whose
dependency is not on the registry is installable by nobody.

This couples the two versions on purpose, and the cost is worth naming: a
release that changes nothing in `apps/fold` still has to raise the fold's
version, because the gate refuses a version the registry already holds. That is
one extra line in the release pull request, and in exchange "which fold is in
CLI 0.13.0" is answered by one number rather than by reading a range. A rule
that skipped the fold publish when its version was already there would have to
prove the published bytes are the ones this commit would upload — which is more
machinery than a version bump, for a package released only alongside the CLI.

A release pull request that raises the fold's version therefore raises the
CLI's pin in the same commit. That is not left to memory: `scripts/release-gate.test.mjs`
runs the gate's rules against this repository's own two manifests on every pull
request, so a bump that moved one of them and not the other is a red build long
before it is a bad tarball.

### Bootstrapping a package's first publish

A one-time ceremony, once per package, performed **before** the first `v*` tag
that would publish that package. The workflow cannot perform it, and a tag
pushed without it fails.

Publishing here is npm Trusted Publishing: the workflow authenticates by OIDC
and reads no token secret, which `scripts/publish-order.test.mjs` (W6) holds. A
trusted publisher is configured *on a package*, in that package's settings on
npmjs.com — so it cannot be configured for a package that does not exist. The
first `npm publish` of a new name under OIDC therefore fails `ENEEDAUTH`, and no
amount of re-tagging changes that.

Both packages are on the registry now and need none of this: `superself` was
there first, and `@superself/fold` went through the sequence below on
2026-09-02, ahead of v0.13.0. It stays here as the record for the next new
package.

1. Check out the release commit, or one adjacent to it, and edit
   `apps/fold/package.json`'s version locally to a **placeholder below every
   version that will ever be released** — `0.0.1`. Do not commit it to `main`
   and do not tag it: its only product is a tarball.
2. Install the workspace: `pnpm install --frozen-lockfile` from the repository
   root. Both `npm pack` and `npm publish` run the fold's `prepare` /
   `prepublishOnly` build, which is `tsc` — from a clean checkout it is not on
   PATH and the next step fails `sh: 1: tsc: not found` before writing a
   tarball. (The placeholder does not disturb the install: the lockfile's
   `link:` entry for the fold is replayed whatever version the manifest says.)
3. Confirm the tarball carries `apps/fold/LICENSE`: `npm pack` in `apps/fold`,
   then `tar -tzf` the result. A published version can never be replaced, and
   Apache-2.0 asks that recipients get the licence. (`pnpm smoke` row S13 is the
   check that holds this on every ordinary run — do not run the smoke here, the
   placeholder version does not match the CLI's pin and rows S3 and S4 will fail
   for that reason alone.)
4. Publish it by hand, with the operator's own npm credentials (`npm login`
   first): `npm publish --access public` from `apps/fold`. This is the only
   publish in the project's life that uses a person's account.
5. On npmjs.com, open `@superself/fold`'s settings and add a trusted publisher.
   Every field the form asks for: this repository, the workflow file
   `publish.yml`, no environment, and — under **Allowed actions**, which npm has
   required since 2026-05-20 and does not default — `npm publish`. Not `npm
   stage publish`: `publish-fold` runs a bare `npm publish`, which npm refuses
   outright if only staging was allowed, and the fix is another trip through
   this settings page.
6. Throw the local edit away. The real version is the release pull request's.

That leaves `@superself/fold@0.0.1` on the registry and nothing else, and every
rule still passes for the first real tag. `0.0.1` is not the version the release
publishes, so the already-published rule does not refuse it; the pin rules
compare the CLI's pin against `apps/fold/package.json`, which the placeholder
never touched; and the rule was always "this version is not on the registry"
rather than "nothing of this package is". `scripts/release-gate.test.mjs` R21 is
that post-bootstrap state written down as a case, so the ceremony is proved
gate-compatible here rather than discovered at tag time.

The placeholder stays on the registry forever, and that is the price. It is a
version below anything the project will release, built from the code that was
about to be released anyway, and it is what makes every publish after it
tokenless.

### Recovering a half-published release

The publish order exists so that a run stopping in the middle leaves the
registry usable: `publish-fold` succeeding and `publish-cli` failing puts a fold
version on the registry that nothing depends on yet, so nobody's install
changes. What is left is to publish the CLI beside it.

**Use GitHub's "Re-run failed jobs" on that workflow run.** It re-runs
`publish-cli` alone, against the same tag and the same commit, and the release
completes.

Both intuitive alternatives wedge instead, and it is worth knowing why:

- **"Re-run all jobs"** re-runs `gate`, which now sees on the registry the fold
  version it published a minute ago, and refuses — and it spends the good path
  doing it: GitHub acts only on a run's *latest* attempt, so the failed
  `publish-cli` of the first attempt can no longer be re-run, and on the new
  attempt it is skipped rather than failed. What is left is the new tag below.
- **Deleting the tag and pushing it again** arrives at the same refusal, more
  slowly.

The refusal says so rather than sending you to bump a version: when the fold's
version is on the registry and the tag's CLI version is not, the sentence names
"Re-run failed jobs" and states that the CLI's version needs no raise.
`scripts/release-gate.test.mjs` R25 holds that sentence, and R26 holds that a
pair genuinely already published still gets the plain "raise the version" one.

If the run cannot be re-run at all — the tag named the wrong commit, or the
wrong version — then the fold's version is raised beside the CLI's in a new
release pull request and a new tag is pushed. The fold version already published
stays where it is; nothing depends on it.
