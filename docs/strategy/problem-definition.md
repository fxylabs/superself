# Problem definition and state architecture

Working decision document, 2026-07-25. Items are marked **decided** or
**proposed**. This document grounds the positioning in
[positioning.md](positioning.md) with the concrete problem and the asset
structure that follows from it.

## The problem — two questions (decided)

1. **Where does the project stand right now?** A human looks at this to
   understand: what state the project is in, what has to happen next, and
   whether the things in progress are going well.
2. **Where does each piece of work stand?** What state is it in, what has to
   happen next, and where is it blocked — waiting on a decision, or needing
   revision?

Everything reduces to **project state and work state**.

## Relationship to git (decided)

A git commit is the detailed file-change history used to *change* that state.
Git therefore cannot hold all of the work: work state is *about* the changes,
not in them. Reports can be committed as files, but that is a workaround, not
work state itself.

## Asset structure (decided)

| Asset | Canonical version | History | Where it lives |
| --- | --- | --- | --- |
| Project state | required | required | managed by Superself |
| Work state | required | required | managed by Superself |
| Other files | working tree | git | git |
| Outputs / artifacts | files, often too heavy for git | required | storage layer |
| Rules and conventions | required | versioned | managed by Superself |
| Search | — | — | grep-first: if the information is in files, grep covers most of it |

## Two kinds of history (proposed)

- **Git history** records *how files changed*.
- **Work history** records *why*: attempts, blockers, decisions, outcomes,
  reports — typed events. (Prior art: PROJECTMEM's typed event log, the Lore
  protocol's commit trailers.)

Work-state entries reference commits and artifacts as evidence. That linkage
is what turns an agent report into an outcome report instead of an activity
log.

## Fast state and slow state (proposed)

Rules and conventions are *slow* state: they change rarely and are injected
into every session (today's CLAUDE.md role, kept small). Project and work
state are *fast* state: they change constantly and are the source from which
each session's context is derived. Same word, different lifecycle — keep them
separate.

## Surfaces (decided / proposed)

**The inbox model is rejected (decided).** Most work that needs human
approval is handled inside the agent session. A surface that collects
"decision needed" items for the human to visit and process is a review queue
by another name, and fails the same way: volume degrades it into
auto-approval.

Revised surface model (proposed):

- The two questions map to **pull-only dashboards** — a project view and a
  work view that a human consults to understand, never a queue to process.
- Decisions happen **inside sessions** and are captured there, as a byproduct
  of the conversation the human was having anyway.
- Decisions that stack up while the human is away are not pushed to a
  separate surface; they are injected into the derived context of the next
  session the human opens. **The session is the inbox.**

## grep-first search (decided, with a condition)

As long as canonical state and history remain representable as files, search
is grep plus git log. Semantic search is not a current problem. This holds
only if the file-representable form is preserved — a constraint on storage
design, aligned with the local-first, no-database direction.

## What state is (decided 2026-07-25)

**State is the minimal set of assertions that must be true right now for
anyone — human or agent — to act correctly next**: to continue without
re-derivation and without contradicting past decisions.

Two principles govern it (decided):

- **Responsibility splits authority.** What carries responsibility is
  confirmed by the human; everything else is the agent's to do. State
  entries therefore divide into **asserted state** (goals, active decisions,
  rejected directions, constraints — someone must commit to them; human
  authority for direction-changing ones) and **derived state** (progress,
  health, blockers — computed from events, asserted by no one; its trust
  reduces to trusting the event record).
- **State changes through events.** An event is something that happened at a
  point in time; state is the current fold of the event history. The
  canonical snapshot is always re-derivable from the append-only log.

Minimum schema (proposed):

Project state — one canonical file:

| Field | Kind |
| --- | --- |
| goal, milestones, definition of done | asserted (human) |
| active decisions, with rationale and confirmed/proposed status | asserted |
| constraints and rejected directions, with reasons | asserted |
| progress: done / in progress / next | derived |
| open questions, decisions blocked on the human | derived |
| health: stalled or failing work signals | derived |

Work state — per unit:

| Field | Kind |
| --- | --- |
| required outcome (what must be true when this work is done) | asserted |
| lifecycle position (proposed / active / blocked / review / done) | derived |
| current report — latest true summary of this work | asserted (agent) |
| blockers — waiting on decision / dependency / external | derived |
| evidence — commit and artifact references | derived |
| next action | asserted (agent) |

Event types follow directly (proposed): the only things that must be
*recorded* are the ones that cannot be derived — goal changes, decisions
(proposed and confirmed, with origin), work lifecycle transitions (created,
started, blocked with cause, unblocked, done), and reports with evidence.
Everything else is computed. Each recorded event carries its origin (human
confirmation in session, or agent assertion), and the append-only log keeps
every entry auditable and revertable.

## Solution direction (decided 2026-07-25)

The primary interface is a **CLI**, sitting next to git, driven by agents.

Reasoning, from observed working reality:

- Human work stays inside agent sessions. Even with parallel agents,
  direction flows through conversation with an orchestrator agent. A separate
  viewer as a required surface creates switching cost; the session remains
  the human surface, and state queries can be answered in-session via skills.
- Agents are deeply trained on git and standard CLI usage. A git-like command
  surface inherits that competence from day one, with none of the per-tool
  schema overhead of MCP interfaces.
- A CLI on the filesystem is vendor-neutral by construction — it works in
  every terminal-based agent and structurally bypasses the memory-silo
  incentive that blocks cross-tool portability elsewhere.
- The positioning line becomes literal: "version control for your project's
  state" describes the actual product form, not a metaphor — and the form
  itself is visibly not another memory plugin.

Design consequences (direction decided; specifics open for design):

- **Workspace-level state store with project registration.** State lives
  outside the code repository (no repo pollution, no state merge conflicts in
  code git — the failure Beads reported for in-repo JSONL). A registry of
  projects enables cross-project search and workspace-level slow state
  (conventions).
- **Git-like, not git.** State is structured events, not arbitrary text.
  An append-only event log plus derived canonical snapshots keeps log, blame,
  and revert semantics while making concurrent writes from parallel agents
  merge trivially. Everything stays file-representable, preserving
  grep-first search.
- **Viewer is optional, read-only, and later.** Multi-project at-a-glance
  health is where a viewer eventually earns its place — likely riding the
  browser-embedded-in-IDE trend — but it must never be a required surface.
- **Roadmap consequence:** this inverts the current vertical slice's
  browser-first shell. The distribution target was already a local CLI; this
  decision makes the CLI the first application shell as well, and the web UI
  a later, optional layer.

## Context delivery (discussed 2026-07-25)

Context has two scopes (decided):

- **Workspace context** — the project list, per-project state summaries, and
  workspace-level rules and conventions. Consumed by sessions that span
  projects (orchestrators).
- **Project context** — project description, current goal, work in progress,
  upcoming and planned work, routines, decisions made along the way, rules,
  and whatever else an agent must know. Scope resolves automatically by
  location: inside a marked project folder → project context; outside →
  workspace context.

Delivery splits across three surfaces (proposed, discussed):

1. **System prompt (managed block in CLAUDE.md / AGENTS.md)** — slow state
   only: rules and conventions, kept small. Conventions are managed state
   like everything else (events, history, expiry), and the CLI renders the
   current fold into a marker-delimited block. This turns the instruction
   file from an agent-written dumping ground — the highest-frequency rot
   complaint in the market research — into a generated view.
2. **`context` command** — fast state at session start: description and
   goal, active decisions and rules, work in progress with current reports,
   decisions blocked on the human, next and upcoming, routines due.
3. **`search` command** — the pull path for everything not injected.
   Cross-project search must work from inside any project (decided).
   Default scope is the whole workspace with current-project results ranked
   first; `--project` narrows. Typed filters (`--type decision|convention|
   report`) ride on file paths and section structure; the engine remains
   grep.

Push/pull split: `context` is a size-bounded push limited to the current
project; other projects' knowledge is pulled on demand via `search`.

Schema additions from this discussion: **project description** (asserted
identity field) and **routines** (recurring standing work — slow asserted
state, distinct from one-off work units).

Dumping-ground guard (proposed): anything an agent "should know" must be
classified into a typed field; unclassified notes expire by default.

Context is capped at 12,000 characters. Identity, description, goal,
conventions, waiting items, and every active work outcome claim space first;
latest reports are bounded excerpts with `self work show` recovery pointers,
then the newest whole decisions fill the remainder with `self search --type
decision` as the pull path. A work-scoped context variant is unnecessary while
`self work show <id>` already provides it.

## Snapshot derivation (decided 2026-07-25)

**What an event is.** One invocation of a write verb (`decide`, `report`,
`work start`, `goal add`, …) = one event = one typed, append-only log entry
carrying timestamp, type, actor and origin (agent session id, human-confirmed
flag), type-specific required fields, and references (commit hashes,
artifacts, work ids). An event is a deliberate assertion made at the moment
a state-meaningful fact occurs — it is *not* transcript capture (the
conversation-compression approach was rejected) and *not* file-change
tracking (git's job; events reference commits as evidence).

**Pipeline.** verb → append to log → immediate refold of canonical files →
one auto-commit in the workspace git repo. One event = one workspace commit,
so state history diffs, blame, and revert land exactly on event boundaries.

**Git coupling.** Commit time is the natural recording moment (push is a
batch act; PRs converge to commits). Two mechanisms: `report` with no
arguments auto-references HEAD as evidence; and commit-message trailers
(`Report:`, `Decide:`) are harvested into events by a post-commit hook — one
action instead of two. Not every commit carries an event; only
state-meaningful ones get trailers.

**Evidence reachability.** Events reference commit and branch. The fold
checks whether referenced commits are reachable from the default branch:
merged → settled (counts as progress); unmerged → provisional; branch
discarded → automatically reclassified as **attempted-and-abandoned** —
dropped from progress, kept in the log as rejected-direction knowledge (the
exact record git alone discards; prevents re-exploring dead ends).
Asymmetry: automatic demotion applies only to derived, evidence-coupled
events. **Human-confirmed decisions never die silently with a branch** — if
a decision's supporting work is discarded, the fold promotes the decision to
an open question instead.

**Rules.**

1. Refold immediately on every event write (canonical files always current
   for grep and human reads).
2. Canonical files are generated output. Hand edits are drift: detected,
   then converted to an event or warned — no state change bypasses the log.
3. Compaction: done work and superseded decisions leave canonical and remain
   in the log. Unconfirmed proposals and unclassified notes expire by
   default after 14 days (adjustable).
4. Contradictory events are never silently resolved; the fold promotes the
   contradiction to an open question in canonical state.
5. Health: an active work unit with no events for 3 days (default,
   per-project configurable) derives a stalled signal — including the case
   where git commits accumulate but no report event follows (recording
   staleness made visible).

## Schema refinements from dogfooding (2026-07-25)

Replaying this design session through the system surfaced four schema
rulings:

1. **Decisions are atomic.** One decision = one event. A batch of
   conclusions confirmed together is recorded as separate events; otherwise
   individual ones cannot later be superseded or referenced.
2. **Events reference events.** A proposed decision is confirmed by a later
   event referencing its id (same for supersede). Status transitions are
   events, not edits.
3. **Session-scoped instructions are not state.** Directions valid only for
   the current session stay in conversation. If one is recorded unclassified
   anyway, default expiry disposes of it.
4. **No report without work (decided).** Every report attaches to a work
   unit; a substantive session begins by creating or attaching to one — a
   design discussion is itself a work unit. Rationale: work state is the
   session's recovery line. If a session is cleared or lost, or its context
   fills, the only alternatives are human-initiated handoff or compaction —
   and a handoff written at the context limit is itself compaction-like and
   lossy. Incremental reports during the session replace one-shot
   terminal summarization: losing a session costs only what happened since
   the last event.

## File formats (decided 2026-07-25)

Format is chosen for context efficiency — humans do not read everything.
What humans must read: **project state, work state, and outputs**. Those
render as readable markdown (and artifacts in their native formats).
Everything else — the event log, registries, internal metadata — uses the
most token-efficient machine format (compact JSONL or equivalent), since its
readers are agents and the CLI. grep-first survives either way; the CLI and
`context` output render human views on demand.

## Artifact storage (decided 2026-07-25)

Local filesystem first. Most artifacts are html, docx, md, or csv — opened
locally with native apps. Artifacts do not live in code repositories (they
accumulate, clutter, and become unfindable); they live under the workspace,
owned by the project that produced them.

Because every artifact enters through a report event (evidence reference),
the artifact registry is derived from the log — no filesystem scanning.
Requirements (decided): listing, paging, and search at work, project, and
workspace granularity. CLI shape: `artifact list [--work|--project]`,
`artifact search`, `artifact open <id>` (OS default app).

## Naming (decided 2026-07-25)

**Binary `self`, distributed as package `superself`** (brew/npm install
superself, provides `self`). Candidates considered: `spsf` (dropped —
unpronounceable, visually collides with the adjacent SPFN framework's
`spfn` CLI), `ss` (dropped — conflicts with the standard socket-statistics
utility). The command surface reads as English phrases — `self status`,
`self report`, `self decide`, `self work start` — and no mainstream binary
squats the name. Known weakness: poor web searchability as a bare word,
mitigated by the `superself` package name.

## Viewer (decided 2026-07-25)

No standalone viewer application. The human-readable trio (project state,
work state, artifacts) is served by existing surfaces:

- **Markdown, rendered well.** State files must be written for high
  readability, consumed by the markdown viewers agent IDEs already embed
  (e.g., Orca's built-in viewer).
- **HTML for everything richer.** Views beyond plain markdown are rendered
  to HTML and opened in the tool's embedded browser. Artifacts are
  predominantly HTML already.
- **Self-contained HTML as a constraint.** Artifacts and rendered views must
  open without a local server, because the paid plan may later move artifact
  storage to the cloud — the same file must open in any browser, local today
  and URL-addressed tomorrow. Local-to-cloud transition changes the address,
  not the artifact.

The read-only principle stands: no viewer ever writes state.

## First vertical slice (decided 2026-07-25)

Scope: `self init`, `self project add`, the event verbs (`goal add`, `decide`,
`work add/start/block/unblock/done`, `report`, `convention add`), immediate
fold, `self context`, the read commands (`status`, `work`, `log`), and
`self search`. Deferred to the next slice: commit-trailer harvesting,
`artifact` commands, evidence-reachability checks, and richer health
derivation. The managed block was pulled forward into this slice as
`self connect` (decided 2026-07-25): it renders the agent-onboarding block —
protocol plus current conventions — into AGENTS.md (the cross-tool
instruction standard) and CLAUDE.md, and every fold refreshes it, so any
terminal agent learns the CLI without per-tool adapters.

Decisions taken while scoping:

- **Package location.** The CLI lives at `apps/cli`, published as package
  `superself` with binary `self`. The prior browser-first slice (`apps/local`)
  is removed: its PGlite database contradicts the file-representable
  direction, and the eventual viewer is a different artifact (read-only,
  self-contained HTML). Git history preserves the code.
- **Log schema.** One event per JSONL line with six fields: `id` (ULID —
  events reference events), `ts` (ISO 8601 UTC), `type` (namespaced, e.g.
  `entity.confirmed`), `origin` (`actor`, optional `session`, `confirmed`
  flag for human confirmation), `project`, `payload` (type-specific), plus
  optional `refs` (`confirms`, `supersedes`, `work`, `commits`, `artifacts`).
  Work ids are short random slugs (`w-xxxxx`) so parallel agents never
  contend on a sequence.
- **Layout.** `self init` makes the current directory a workspace by creating
  `.superself/` (its own git repository) with `registry.jsonl` and
  `projects/<slug>/{log.jsonl, state.md, work/<id>.md}`. The project marker
  is a `.self` file at the project root holding the workspace path and slug,
  auto-added to `.git/info/exclude` — nothing enters the code repository.
  Scope resolution walks up from the current directory: a `.self` marker
  means project context, otherwise a `.superself` directory means workspace
  context.
- **Context budget.** A 12,000-character hard cap is enforced with the fixed
  section order (description and goal → decisions and conventions → work in
  progress with reports → blocked on the human → next). Every omission names
  the command that recovers the full state. The injection path is the managed
  block rendered by `self connect`, which instructs agents to run `self
  context` at session start.

## Next discussion

All design items in this document are settled: command surface, state
definition, context delivery, snapshot derivation, schema refinements, file
formats, artifact storage, viewer, naming. The first vertical slice is
implemented (see above). Next step: dogfood the CLI on this repository's own
development, then take the deferred second-slice items (commit trailers,
managed block, artifacts, evidence reachability).

## Open questions

- Minimum field set for canonical project state (goals, active decisions,
  progress, open questions, constraints — what is the smallest set?).
- Work-state event types (attempt, blocked, decision-needed,
  revision-needed, outcome, report?).
- Artifact storage shape (local directory with references?
  content-addressed?).
- File representation vs database for canonical state and history.
- Existing surface designs built around a home inbox need revision or
  reinterpretation to fit the rejected-inbox decision.
