# Superself 0.8.0 release brief

- Status: approved
- Revision: v0.1
- Operator: project operator
- Approved at: 2026-08-24
- Stable slug: release-v0-8-0
- Language: English

## Reader situation

The reader already uses or evaluates the npm `superself` CLI. They need to decide whether the changes merged after 0.7.0 justify upgrading, and they need a precise description of the new commands and lifecycle behavior.

## Current attempt and failure

An operator currently relies on a model or harness summary when moving active work to a fresh agent. That summary can omit durable conventions, current work state, reports, or valid recovery commands. Separately, an accepted standalone work proposal previously required a new work id when its plan changed before work started.

## Observed facts

- npm and GitHub both publish 0.7.0 as the current release on 2026-08-24.
- PR #357 merged one-id revision of standalone work proposals until first start.
- PR #359 merged the offline, read-only `self handoff <work-id> [--project <slug>]` packet.
- PR #359 passed CI `verify`, DCO, and contribution-policy checks.
- The package release-key check, prepublish build, and npm publish dry-run pass on merged `main`.

## Inferences and disconfirming checks

- Inference: two user-visible CLI features warrant the next minor version, 0.8.0. Disconfirm by applying the repository SemVer policy to the merged diff; choose a different version if either change is only a compatible fix.
- Inference: a current user can decide whether to upgrade from a short release note focused on the two outcomes. Disconfirm in independent review if the reviewer cannot name both changes, the supported commands, and the fact that publication has not happened yet.

## Reader decision and action

Enable the reader to decide whether to upgrade to 0.8.0 after publication. A reader who upgrades should know when to run `self handoff` and when `self work revise` remains valid.

## Evidence

- Repository release policy: `docs/maintainers/releases.md`
- CLI reference and help declarations: `docs/reference/cli.md`, `apps/cli/src/main.ts`
- Merged implementation: PR #357 at `5e3cdb7`, PR #359 at `95fb28e`
- Verification: GitHub Actions run `32730595850`; local release-key check, prepublish build, and npm dry-run on `95fb28e`

## Included surfaces

- English release note source at `docs/releases/v0.8.0.md`
- The release issue body, copied from the reviewed release note source
- The release PR summary, limited to versioning and publication readiness

## Supported path

The supported reader starts from npm 0.7.0, reads the English release note, and decides whether to install 0.8.0 after the tag workflow publishes it. The supported maintainer path prepares the version bump and release copy in one PR, then stops before tagging or publishing.

## Trust boundary

Claims are limited to merged repository behavior, command declarations, focused tests, CI, and package dry-run evidence. The release copy does not claim broad harness completeness, performance, security certification, or successful publication before the tag workflow finishes.

## Explicit exclusions

- Korean release copy
- Marketing, launch, social, or lifecycle copy
- New product behavior or documentation changes outside the release note
- A general changelog system or reusable release framework
- Tag creation, GitHub Release publication, or npm publication
- Validation from real post-release usage

## Review contract and stop condition

Review only the two merged CLI outcomes, their declared commands, the 0.8.0 version decision, the English release note, and the release readiness checks. Stop when an independent reviewer records `ready`, the receipt verifier passes, the package version is 0.8.0, release keys and npm dry-run pass, the diff contains only release preparation, and the release PR is open with CI running or green.
