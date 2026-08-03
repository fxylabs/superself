## Change workflow

- Every change intended for `main` starts with an issue, including maintainer,
  documentation, dependency, refactor, test, CI, and release work.
- Do not implement until a maintainer has added `status:accepted` and assigned
  the issue to the GitHub account that will open the pull request.
- Use a short-lived branch named
  `<type>/<issue-number>-<short-description>`, where `type` is `feat`, `fix`,
  `docs`, `refactor`, `test`, or `chore`.
- Keep work discovered inside the accepted scope on the same issue. Create a
  new issue for out-of-scope follow-up work instead of expanding the branch or
  pull request.
- The initial repository bootstrap before the first `main` commit is the only
  exception to the issue and branch requirements above.
- Sign off every commit with `git commit -s` to certify the repository DCO.

## Design rules

- Read [ARCHITECTURE.md](ARCHITECTURE.md) before writing code: layering,
  subsystem boundaries, the single gates, the owned event namespaces, and the
  fixed naming. It also lists the known debt, which is never precedent.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions an implementation
  is judged by: function size, the four things a new command verb ships,
  checkout-agnostic tests, and the artifact shape
  (`{name, sha256, bytes}` — `name`, never `path`).
- A change that adds a flat top-level subsystem, a second path around a single
  gate, or a sibling event namespace is sent back regardless of how it tests.

## Project verification

- Type check: `pnpm typecheck`.
- Production build: `pnpm build`.
- Test tier: `pnpm test` — unit plus CLI integration tests, also run by PR CI.

<!-- superself:begin -->
## Project state (superself)

Project state — goals, decisions, work units, reports — is version-controlled
by the `self` CLI, outside this repository. Skip this section if the `self`
command is unavailable.

- Session start: run `self context` and treat its output as current truth.
- Substantive work attaches to a work unit: `self work add "<required outcome>"`,
  then `self work start <id>`. Report progress with `self report <id> "<summary>"`
  after committing — HEAD is attached as evidence automatically.
- The long-term goal and time-boxed objectives are separate state: `self goal set`
  keeps the goal, `self objective add "<outcome>" --horizon week --target <date>`
  adds an objective, and `self milestone add "<outcome>" --objective <id> --exit "<criterion>"`
  adds a checkpoint under it. `self objective` lists both with the reason for each state.
- State what work contributes to: `self work link <id> --milestone <id>`. A milestone
  is reached only when every exit criterion is covered — `self milestone met <id>
  --criterion <c> --why "<how the evidence covers it>"`, then `self milestone reach <id>`.
  Finishing work never reaches a milestone on its own, and progress is never a percentage.
- Revising an objective or a milestone leaves what it already settled stale. Re-judge it
  at the current revision with `self milestone recheck <id> [--criterion <c>] --why "<what
  you re-judged>"` — a reach still needs every live criterion covered first.
- Done is a judgment: `self work done <id>` closes the unit when its outcome
  is reached — the evidence lives in the reports the unit already carries.
- Found a gap between an objective and current state? Propose the work with
  `self work propose` and its full brief; the user accepts or declines it.
- Record decisions the user confirmed: `self decide "<text>" --why "<reason>"`.
  Use `--proposed` when the user has not confirmed. One decision per event.
- Blocked? `self work block <id> --on decision|dependency|external --why "..."`.
- Superseded or moved to another unit or project? `self work retire <id> --why "..."
  [--successor <work-id>]` — never mark it done and never leave it falsely blocked.
- Picking up existing work? `self work show <id>` prints its full brief and
  report history. Leave a brief for the next session with `self report <id> --file <path>`.
- Proposed next work, or suggested continuing in the next session, and the
  user approved? Register it with `self work add` right then, with the
  context behind the proposal — an approved plan that is never registered is lost.
- Deferring work for later? Attach a scoping brief the moment you create it:
  `self report <id> --file <path>` covering scope, design anchors, and known
  pitfalls — a bare outcome line loses the context that created the work.
- A branch reaches main through a GitHub pull request: PR review and CI own
  merge control. superself owns context and the work graph, not the merge gate.
- Search past state with `self search <query>`; list work with `self work`.
- Never hand-edit generated state files or anything under `.superself/`.

### Conventions

- State changes go through self events; canonical files are never hand-edited
- Record all state (events, decisions, reports, conventions) in English; conversation, artifacts, and everything the user must read follow the user's language
- A recurring symptom that already has an open issue gets the new case appended as an issue comment at the moment it is observed — with the concrete evidence (ids, commands, refusal text). Implementation, design and review agents read the issue at pickup time, so cases must land on the issue, not only in work reports; the friction line in the report still gets written as usual.
- Agent-initiated work follows report-then-approve: the agent reports the intended design and delivery shape to the user and gets approval before registering the work unit and before dispatching it — self work propose is the default vehicle for agent-discovered work, and even for user-directed outcomes the design report precedes dispatch. Registration without a reported, approved shape is the exception to fix, not a convenience.
- Every implementation, fix and review plan prompt for this repository instructs the agent to read ARCHITECTURE.md and CONTRIBUTING.md on the checked-out head before writing anything; reviewers carry a standing structure surface — changed code must conform to those documents and must not add to the known debt recorded in ARCHITECTURE.md's Known debt section.
- A test suite asserts product behaviour, not its own coverage. Assert what fails when the CLI is wrong: an independent oracle the implementation is compared against, the documented answer for a named input, an invariant over real output. Do not assert that the suite's own input set is complete — floors over generated populations, per-cell presence demands, distinctness of literal tables, pinned overlap or repeat sets. Those only fail when someone edits the test file, which a diff already shows, and every adversarial probe against a coverage claim succeeds, so review effort multiplies without the product getting safer. A gap in the input set is recorded as an optional follow-up, never as a blocking finding.
<!-- superself:end -->
