# Superself 0.8.0 quality review

- Brief: docs/content-plans/release-v0-8-0.en.md
- Brief revision: v0.1
- Content file: apps/cli/package.json
- Content file: docs/releases/v0.8.0.md
- Content SHA-256: bad06eaac9ea834930cb5557e024cc7f6c6065c08cedf5f9836211eea3c9a67b
- Author: Codex release author
- Reviewer: Codex independent release reviewer
- Reviewed at: 2026-08-24
- Verdict: ready

## Review scope

The reader outcome is that an existing npm `superself` 0.7.0 user can identify both merged 0.8.0 changes, understand the exact supported commands and lifecycle limits, and decide whether to upgrade after publication. The reviewed public surfaces are the English release source at `docs/releases/v0.8.0.md` and the version metadata at `apps/cli/package.json`. The supported path is reading the release note, checking the declared commands and help, and stopping release preparation before a tag or publication action. Claims are trusted only where merged PRs #357 and #359, repository source and tests, CI, or the recorded package dry-run support them.

This review excludes Korean and marketing copy, new feature work, tag or npm publication, broad security or performance claims, and general changelog architecture. Review stops when the two outcomes, commands, lifecycle boundaries, action and result, content-guide checks, and receipt digest have sufficient evidence, or when a reachable publication-path error blocks that outcome.

## Claims and evidence

| Claim | Evidence | Finding |
| --- | --- | --- |
| Version 0.8.0 contains the proposal-revision and handoff changes | Merged commits `5e3cdb7` (PR #357) and `95fb28e` (PR #359); `git log`; release-note evidence links | Supported. These are the two user-visible changes after 0.7.0. |
| `self handoff <work-id> [--project <slug>]` is the supported syntax | `apps/cli/src/main.ts`; `self handoff --help`; `docs/reference/cli.md` | Supported exactly. |
| Handoff emits a deterministic, read-only packet with protocol, conventions, bounded context, complete work and report history, and location-correct recovery | `apps/cli/src/views.ts`, `apps/cli/src/main.ts`, and `apps/cli/test/handoff.test.mjs`; focused handoff tests 5/5 | Supported within the declared project-state trust boundary. |
| Handoff accepts exact work ids, writes no event or file, and frames project-controlled convention/report text as data | `resolveHandoffWork`, renderer-owned row framing, and hostile-content/read-only cases in `handoff.test.mjs` | Supported. |
| `self work revise <id> "<revised plan>" --why "<what changed>"` preserves the id and history, invalidates stale acceptance, and freezes after first start | `apps/cli/src/main.ts`, `apps/cli/src/goals.ts`, `self work revise --help`, and `apps/cli/test/work-revise.test.mjs`; focused cases 33/33 | Supported. The successor path after first start is also exercised. |
| Readers should install `superself@0.8.0` only after publication | Conditional wording under “Upgrade after publication”; `apps/cli/package.json` reports `0.8.0`; `self --version` reports `0.8.0` | Supported as a future action. The copy does not claim that 0.8.0 is already available. |
| The maintainer path prepares a PR and stops before tag or publication | Approved brief, “Release preparation checklist,” and Explicit exclusions | Supported. The checklist explicitly stops before tag, GitHub Release, or npm publication and requires separate publication authorization. |
| The separately authorized publication handoff can produce both npm and GitHub release results | `.github/workflows/publish.yml`; `docs/maintainers/releases.md`; “Publication handoff after separate approval” | Supported. The handoff distinguishes tag-triggered npm publication from the explicit, separate GitHub Release creation step and ends with both visibility checks. |

## Sentence and visual jobs

| Location | C/E/A/R/D | Reader value | Finding | Action |
| --- | --- | --- | --- | --- |
| Title and opening paragraph | C/D | Names the release and both reasons to consider it | Clear, outcome-first, and supported | Keep |
| “Hand active work” command | A | Gives the exact invocation | Matches command help | Keep |
| Handoff behavior paragraphs | E/R/D | Defines packet contents, read-only behavior, input boundary, and framing result | Each material claim has source and test evidence | Keep |
| “Revise a proposal” command | A | Gives the exact revision invocation | Matches command help | Keep |
| Revision lifecycle paragraph | E/R/D | Explains stable id/history, renewed acceptance, and the first-start limit | Supported by help and the case table | Keep |
| “Upgrade after publication” | A/R | Prevents a premature install attempt and names the expected package | Correctly conditional | Keep |
| Release preparation checklist | A/R | Separates the accepted preparation outcome from publication authority | Clearly stops before tag, GitHub Release, and npm publication | Keep |
| Publication handoff after separate approval | C/A/R | States the authorization boundary and complete later publication sequence | Correctly separates tag-triggered npm publication from GitHub Release creation | Keep |
| Evidence list | E | Lets the reader inspect the two merged changes and release policy | Sources are listed once and are relevant | Keep |
| `apps/cli/package.json` version | E/R | Makes the prepared artifact identify as 0.8.0 | Exact value is `0.8.0` | Keep |

There are no visuals. Every release-note sentence performs at least one C/E/A/R/D job; no paragraph is removable without losing one of the two changes, a lifecycle boundary, the upgrade action, or its evidence. The English copy has no em dash, stock AI vocabulary, or repeated contrast frame. Sentence lengths vary, terms are consistent, and headings remain shallow and parallel enough for this short release form.

## Supported-path run

Environment: repository worktree at merged `main` plus the uncommitted release-preparation files, terminal text viewport, macOS, Node 22.11.0. The package declares Node `>=22.12.0`, so supported-runtime publication evidence comes from the already recorded green CI; local command and focused-test results are corroborating evidence.

| Command or check | Expected result | Observed result |
| --- | --- | --- |
| `self handoff --help` | Exact handoff syntax and read-only/exact-id limits | Matched the release note |
| `self work revise --help` | Exact revise syntax and accept/start lifecycle | Matched the release note |
| `self --version` | Prepared version is 0.8.0 | Printed `0.8.0` |
| `pnpm --filter superself typecheck` | No type errors | Passed, with the local Node engine warning noted above |
| `node --test apps/cli/test/handoff.test.mjs apps/cli/test/work-revise.test.mjs` | Handoff and revision supported paths pass | 38/38 passed: handoff 5/5 and revision 33/33 |
| Inspect `.github/workflows/publish.yml` | Determine what an annotated `v*` tag publishes | Tag push runs `npm publish`; no GitHub Release step exists |
| Inspect `docs/maintainers/releases.md` | Determine the separate GitHub release action | Policy requires creating a GitHub Release after tagging |

The commands and feature results remain sufficient. The preparation path now stops at its approved boundary, and the separately authorized publication handoff states every action needed to produce and verify both publication results.

## Independent reviewer answers

- Who this is for: a current or evaluating npm `superself` 0.7.0 user deciding whether the two merged changes warrant upgrading, plus the maintainer preparing the release PR.
- What changes for the reader: they can generate a complete handoff packet and revise a proposal under one id until its first start.
- What proves success: exact help declarations, merged source, 38 passing focused cases, prepared version metadata, green recorded CI, and a package dry-run. Publication itself remains deliberately unclaimed.
- What can be removed: no feature paragraph can be removed without losing a required outcome or boundary. The preparation stop and separately authorized publication handoff are both necessary to prevent the checklist from implying authority to publish or omitting the GitHub Release action.

## Reader evidence

Not required. The project requires five-reader research only for a new message, first tutorial, or new visual form. Prior GitHub release notes establish this short release-note form, and this change introduces no visual or new content form.

## Remaining hypotheses and next check

The note assumes the eventual tag workflow and manual GitHub Release action will make 0.8.0 available. The cheapest check after separate publication authorization is to follow the recorded handoff, observe the Publish workflow, and verify npm and GitHub independently before announcing availability.

No post-release usefulness is known yet. After publication, the cheapest validation is to record whether a 0.7.0 user can name both changes, run the relevant command successfully, and explain the first-start revision boundary.

## Sufficient evidence and stop condition

Evidence is sufficient for the version, both feature claims, exact commands, lifecycle behavior, conditional upgrade instruction, English sentence jobs, AI-tell audit, preparation stop boundary, and complete separately authorized publication handoff. The two prior blocking findings are closed, and the previously supported claims did not regress.

Verdict is `ready`. The pre-publication content gate stops here; actual tag, GitHub Release, npm publication, and post-release validation remain outside this review and require their stated authorization and evidence.
