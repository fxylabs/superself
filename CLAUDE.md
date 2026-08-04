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
  keeps the goal, `self objective add "<outcome>" --target <date>`
  adds an objective, and `self milestone add "<outcome>" --objective <id> --exit "<criterion>"`
  adds a checkpoint under it. `self objective` lists both with the reason for each state.
- Every asserted record — goal, decision, convention, objective, milestone, work —
  folds into one entity with placement. `self state` lists them all,
  `self state show <id>` prints one, and `self state add "<text>" --label <l>`
  records a free-labeled one; `self alias add <verb>` makes a verb of a label.
- A record's text is immutable once confirmed, so a correction restates it, and
  every add verb spells that the same way: `--supersedes <id>` records the new
  wording and carries the lineage — `self state add "<corrected text>" --supersedes <id>`,
  and for a unit's outcome `self work add "<corrected outcome>" --supersedes <id>
  --why "<why it moved>"`, which retires the unit it replaces. `retract` withdraws a
  record with nothing replacing it, and retire is for an outcome given up or moved
  — neither is a wording fix.
- Placement is scope × priority × exposure. `self state place <id> [--priority <n>]
  [--exposure full|index|search] [--scope project|workspace]` moves what context
  renders; a demotion records `--why`, and demoting out of full waits for the user:
  pass `--proposed`, then the user runs `self state confirm <id>`.
- Retention caps bound the rendered tiers. Past a cap, `state add` and `state place`
  refuse until `--demote <id>` names what frees the room — pass `--proposed` so the
  add and the demotion land as a pair waiting on the user.
- A workspace-scoped record renders in every project's context: `--scope workspace`
  on a state or alias verb, or `self convention add "<text>" --workspace`.
- State what work contributes to: `self work link <id> --milestone <id>`. A milestone
  is reached only when every exit criterion is covered — `self milestone met <id>
  --criterion <c> --why "<how the evidence covers it>"`, then `self milestone reach <id>`.
  Finishing work never reaches a milestone on its own, and progress is never a percentage.
- Revising an objective or a milestone leaves what it already settled stale. Re-judge it
  at the current revision with `self milestone recheck <id> --criterion <c> --why "<what
  you re-judged>"` — a reach still needs every live criterion covered first.
- Done is a judgment, and the claim must carry evidence: `self work done <id>` closes
  the unit only when a report carries a commit or an artifact, or the done itself
  states one — `self work done <id> --report "<what verifiably happened>"`.
  A bare claim is refused, and declared criteria gate done until each is covered.
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
- Design-stage case closure: a stateful feature's design artifact (spec section or issue) must include its finite case table — state variables × operations × application timing (immediate/deferred) × capacity or limit states — with the expected outcome per cell, before implementation is dispatched. Tests derive 1:1 from the table's cells with the table's outcomes as their assertions; the table replaces the brainstormed defect-anticipation list. For table-covered features there is NO review round: the user's design approval rules on the table itself, the dispatcher mechanically checks cell-to-test correspondence and outcome transcription as a gate, and CI runs the suite. Cross-model exploratory review is reserved for surfaces where no table can be drawn (external integrations, genuinely unbounded input). — Adopted 2026-08-03 after PR #203, where all three review findings (F1 demotion-vs-cap, F2 confirm-time capacity, F3 swap-pair deadlock) were derivable cells of a ~40-cell tier-transition table nobody drew; user ruled table-based tests replace review, not merely shrink it.
<!-- superself:end -->
