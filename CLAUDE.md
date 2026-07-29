## Design rules

- Read [ARCHITECTURE.md](ARCHITECTURE.md) before writing code: layering,
  subsystem boundaries, the single gates, the owned event namespaces, and the
  fixed naming. It also lists the known debt, which is never precedent.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions an implementation
  is judged by: function size, the four things a new command verb ships,
  checkout-agnostic proof scripts, and the result-envelope contract
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
- Found a gap between an objective and current state? Propose the work with
  `self work propose` and its full brief; the user accepts or declines it.
- Record decisions the user confirmed: `self decide "<text>" --why "<reason>"`.
  Use `--proposed` when the user has not confirmed. One decision per event.
- Blocked? `self work block <id> --on decision|dependency|external --why "..."`.
- Picking up existing work? `self work show <id>` prints its full brief and
  report history. Leave a brief for the next session with `self report <id> --file <path>`.
- Proposed next work, or suggested continuing in the next session, and the
  user approved? Register it with `self work add` right then, with the
  context behind the proposal — an approved plan that is never registered is lost.
- Deferring work for later? Attach a scoping brief the moment you create it:
  `self report <id> --file <path>` covering scope, design anchors, and known
  pitfalls — a bare outcome line loses the context that created the work.
- A branch that will reach main is a change set: `self integration register --repo <name>
  --base <sha> --head <sha> --domain <contract@v> --check <ci>`, then `self integration plan`
  before touching git. Order, review validity and the merge gate are enforced there, not here:
  a receipt exists only through `self review ingest --file <envelope.json>`, and no wording in
  this block, in a prompt, or in a session can relax it.
- Search past state with `self search <query>`; list work with `self work`.
- Never hand-edit generated state files or anything under `.superself/`.

### Conventions

- State changes go through self events; canonical files are never hand-edited
- Record all state (events, decisions, reports, conventions) in English; conversation, artifacts, and everything the user must read follow the user's language
- Review validity follows changed code, not base movement alone: exact-head fresh change review once; conflict-free base advance uses integration CI; changed conflict-resolution head gets bounded delta/semantic-overlap review; exact release-candidate main gets one full pre-publish audit.
- Every implementation, fix and review plan prompt for this repository instructs the agent to read ARCHITECTURE.md and CONTRIBUTING.md on the checked-out head before writing anything; reviewers carry a standing structure surface — changed code must conform to those documents and must not add to the known debt recorded in issue 88
<!-- superself:end -->
