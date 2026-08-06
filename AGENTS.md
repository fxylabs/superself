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
  is judged by: function size, the five things a new command verb ships,
  checkout-agnostic tests, and the artifact shape
  (`{name, sha256, bytes}` — `name`, never `path`).
- A change that adds a flat top-level subsystem, a second path around a single
  gate, or a sibling event namespace is sent back regardless of how it tests.

## Project verification

- Type check: `pnpm typecheck`.
- Production build: `pnpm build`.
- Test tier: `pnpm test` — unit plus CLI integration tests, also run by PR CI.

<!-- superself:begin v0.6.0 -->
## Project state (superself)

Project state — goals, decisions, work units, reports — is version-controlled
by the `self` CLI, outside this repository. Skip this section if the `self`
command is unavailable.

- Session start: run `self context` and treat its output as current truth.
- Write for the reader by default: answers to the person in their language,
  records — events, decisions, reports, conventions — in English, so a record
  stays readable to whoever opens it next. A project that wants it otherwise
  records its own convention.
- Substantive work attaches to a work unit: `self work add "<required outcome>"`,
  then `self work start <id>` — which is how you read a unit's brief and report
  history, and records that this session picked it up. If another session holds
  it, you are told who and since when, and never refused; judge it and proceed.
  Report progress with `self report <id> "<summary>"` after committing — HEAD is
  attached as evidence automatically.
- Done is a judgment, and the claim must carry evidence: `self work done <id>`
  closes the unit only when a report carries a commit or an artifact, or the
  done itself states one — `self work done <id> --report "<what verifiably
  happened>"`. A bare claim is refused, and declared criteria gate it.
- A record's text is immutable once confirmed, so a correction restates it:
  `--supersedes <id>` on any add verb records the new wording and carries the
  lineage. `retract` withdraws a record with nothing replacing it, and `retire`
  is for an outcome given up or moved — neither is a wording fix.
- Record decisions the user confirmed: `self decide "<text>" --why "<reason>"`.
  Use `--proposed` when the user has not confirmed. One decision per event.
- Blocked? `self work block <id> --on decision|dependency|external --why "..."`.
  Superseded or moved? `self work retire <id> --why "..." [--successor <id>]` —
  never mark it done and never leave it falsely blocked.
- Found a gap between an objective and current state? Propose the work with
  `self work propose` and its full brief; the user accepts or declines it.
- Proposed next work, or suggested continuing in the next session, and the
  user approved? Register it with `self work add` right then, with the
  context behind the proposal — an approved plan that is never registered is lost.
- Deferring work for later? Attach a scoping brief the moment you create it:
  `self report <id> --file <path>` covering scope, design anchors, and known
  pitfalls — a bare outcome line loses the context that created the work.
- A branch reaches main through a GitHub pull request: PR review and CI own
  merge control. superself owns context and the work graph, not the merge gate.
- Never hand-edit generated state files or anything under `.superself/`.

This block is the short form. The installed CLI carries the rest — what each
concept is, when to reach for it, and the order the verbs go in:

- `self help agents` — how a session drives this CLI, start to finish
- `self help context` — what `self context` renders, and why something is missing from it
- `self help records` — one entity behind every record kind, and how a record is corrected
- `self help placement` — scope, priority and exposure — how a record earns its place in context
- `self help work` — the work graph: outcomes, evidence, criteria, and proposals
- `self help goals` — long-term goals, objectives, milestones, and what reaching one takes
- `self help workspace` — the store, the projects in it, and moving it between machines

### Conventions

- State changes go through self events; canonical files are never hand-edited
- Record all state (events, decisions, reports, conventions) in English; conversation, artifacts, and everything the user must read follow the user's language
- A recurring symptom that already has an open issue gets the new case appended as an issue comment at the moment it is observed — with the concrete evidence (ids, commands, refusal text). Implementation, design and review agents read the issue at pickup time, so cases must land on the issue, not only in work reports; the friction line in the report still gets written as usual.
- Agent-initiated work follows report-then-approve: the agent reports the intended design and delivery shape to the user and gets approval before registering the work unit and before dispatching it — self work propose is the default vehicle for agent-discovered work, and even for user-directed outcomes the design report precedes dispatch. Registration without a reported, approved shape is the exception to fix, not a convenience.
- Every implementation, fix and review plan prompt for this repository instructs the agent to read ARCHITECTURE.md and CONTRIBUTING.md on the checked-out head before writing anything; reviewers carry a standing structure surface — changed code must conform to those documents and must not add to the known debt recorded in ARCHITECTURE.md's Known debt section.
- A test suite asserts product behaviour, not its own coverage. Assert what fails when the CLI is wrong: an independent oracle the implementation is compared against, the documented answer for a named input, an invariant over real output. Do not assert that the suite's own input set is complete — floors over generated populations, per-cell presence demands, distinctness of literal tables, pinned overlap or repeat sets. Those only fail when someone edits the test file, which a diff already shows, and every adversarial probe against a coverage claim succeeds, so review effort multiplies without the product getting safer. A gap in the input set is recorded as an optional follow-up, never as a blocking finding.
- Design-stage case closure: a stateful feature's design artifact (spec section or issue) must include its finite case table — state variables × operations × application timing (immediate/deferred) × capacity or limit states — with the expected outcome per cell, before implementation is dispatched. Tests derive 1:1 from the table's cells with the table's outcomes as their assertions; the table replaces the brainstormed defect-anticipation list. For table-covered features there is NO review round: the user's design approval rules on the table itself, the dispatcher mechanically checks cell-to-test correspondence and outcome transcription as a gate, and CI runs the suite. Cross-model exploratory review is reserved for surfaces where no table can be drawn (external integrations, genuinely unbounded input). — Adopted 2026-08-03 after PR #203, where all three review findings (F1 demotion-vs-cap, F2 confirm-time capacity, F3 swap-pair deadlock) were derivable cells of a ~40-cell tier-transition table nobody drew; user ruled table-based tests replace review, not merely shrink it.
- Acceptance is registration: a GitHub issue becomes a work unit the moment a maintainer marks it status:accepted, and a work unit that needs a repository change mints its issue at that point. Neither side is judged case by case — the accepted label is the only test, and the work unit's brief is the authoring surface the issue body is written from.
<!-- superself:end -->
