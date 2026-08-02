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
  checkout-agnostic proof scripts, and the result-envelope contract
  (`{name, sha256, bytes}` — `name`, never `path`).
- A change that adds a flat top-level subsystem, a second path around a single
  gate, or a sibling event namespace is sent back regardless of how it tests.

## Project verification

- Type check: `pnpm typecheck`.
- Production build: `pnpm build`.
- Full proof suite (`pnpm proof`) runs in PR CI.

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
- A passing attempt never marks work done: settlement records what a run produced
  and frees the unit. Declare what the outcome must cover with `self work require <id>
  "<statement>"`, cover each with `self work met <id> --requirement <r> --why "<how the
  evidence covers it>"`, and only then `self work done <id>`. `self work approval-required`
  makes a unit wait for a person, and `self work policy <id> --model <class> --fresh-review`
  states what its implementation had to be — all four are checked before done is admitted.
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
- A recurring symptom that already has an open issue gets the new case appended as an issue comment at the moment it is observed — with the concrete evidence (ids, commands, refusal text). Implementation, design and review agents read the issue at pickup time, so cases must land on the issue, not only in work reports; the friction line in the report still gets written as usual.
- Session-launched agent work goes through the attempt spool: register and drive it with self attempt run (or register/started/heartbeat/exited) so the attempt ledger, preflight, heartbeats and reconciliation own the lifecycle. Harness-native subagent tools that bypass the spool are not used for implementation attempts; if one is ever used as a fallback, the gap is stated in the work report at dispatch time.
- Implementation work is planned to need no repeat review loop: the brief written at dispatch carries a defect-anticipation section (expected edge cases, security and performance surface, failure modes) the implementer must address explicitly; machine gates (targeted suites, proof) pass before any review round starts; the implementer runs a self-adversarial pass against the review rubric before requesting fresh review and reports what it caught; review findings are classified predictable versus novel, and predictable ones are promoted immediately to the brief checklist, coding-context, or an automated check. Review rounds exist for what could not have been anticipated.
- Review rounds reuse sessions for cache-hit efficiency: the fix round resumes the implementer in its worktree, and the re-review resumes the same reviewer to verify its own findings against the fix delta only — the reviewer still never inherits implementer context, and the approver-is-not-the-implementer invariant is untouchable. Bounds against context bloat and noise blindness: a resumed re-review covers known findings plus the fix delta, and a new cold fresh review is owed instead when the fix delta amounts to semantic rework or new scope, after two resumed rounds, or when the session context has grown enough that accumulated noise could mask defects — a long session that stops finding is worse than a cold start.
- Dispatch economics: the session (or, once w-jctrr lands, the runner) does the deterministic preparation before dispatch — worktree created, dependencies installed, artifact destinations made — so fixed costs never ride the attempt clock; a one-shot attempt is scoped to a 60-minute budget including gate time, and a scope that cannot fit is split into units rather than stretched; a review or audit never re-runs what CI already proved on the exact head — verify-green is an observation to cite, and only suites that evidence a specific finding run locally. Code-surface pitfalls promoted from review findings go to CONTRIBUTING/ARCHITECTURE through normal PRs (agents already must read those on the checked-out head), not to session-side files.
- Refinement of the round-reduction discipline (decision 01kyz0q24d, corrected 2026-08-02): fix-round briefs carry their own defect-anticipation section aimed at the fix's blast radius — enumerate the neighbouring cases/topologies of every surface the fix touches, where regressions cluster. Promoted findings go where something structurally reads them: mechanically checkable classes (wording/shape/contract) become automated checks in the proof/CI surface; judgement-class rules become project conventions in self state, visible at every session start; cross-project patterns go to the coding-context repository. No session-side checklist files, and CONTRIBUTING/ARCHITECTURE keep their public contract role untouched.
- Agent-initiated work follows report-then-approve: the agent reports the intended design and delivery shape to the user and gets approval before registering the work unit and before dispatching it — self work propose is the default vehicle for agent-discovered work, and even for user-directed outcomes the design report precedes dispatch. Registration without a reported, approved shape is the exception to fix, not a convenience.
- Proof-run budget in implementation briefs (refines the dispatch-economics rule, user-approved 2026-08-02): during implementation the feedback loop is typecheck plus direct node smoke invocations, never the heavy proof harness; while developing a new proof script only its minimal single scenario runs; the full or touched proof sections run at most twice per attempt — once after implementation completes and once after fixing what that run caught; anything beyond is CI's job. Every implementation brief states this execution order explicitly. Evidence: attempt at-s54bw spent 21 of 48 shell turns re-running proofs inside its dev loop and timed out at the 60-minute wall. Supersedes nothing; #92's tiered test architecture replaces the manual budget when it lands.
<!-- superself:end -->
