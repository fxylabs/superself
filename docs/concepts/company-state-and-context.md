# Company State and context

Company State is not everything a company remembers. It is the bounded,
versioned truth that determines what the company can do next. Context is a
projection of that state, not its authority.

Superself currently applies this model at the project level. Goals, decisions,
conventions, objectives, milestones, work, reports, and evidence survive
individual context windows and agent tools. The complete Company State Runtime
extends that foundation across projects, policies, capabilities, and resource
allocation; that company-wide loop is a target, not a claim about the current
alpha. The boundary between what is shipped and what is target lives in the
[roadmap](../roadmap.md).

## This is a state problem, not a memory problem

Model memory and conversation history help an agent recall earlier
interactions. A knowledge base helps retrieve information. Neither one, by
itself, answers operational questions such as:

- Which goal governs the work now?
- Was this direction confirmed, merely proposed, or superseded?
- Which outcome is active, blocked, or complete?
- Which criterion remains uncovered?
- Which evidence permits the next transition?

A transcript contains many statements with no lasting authority. A knowledge
base may contain several mutually inconsistent answers. Company State is
narrower: typed, current truth whose status and lineage can be reconstructed.

This does not mean that every useful fact belongs in state. Agent scratch work,
private reasoning, raw provider output, and session-only instructions can be
valuable without becoming governing records. Promoting all available
information into current state would recreate the unbounded memory problem
under a different name.

## Event → State → Projection

Superself is built on one frame:

```text
Event          →   State            →   Projection
what happened      fold of events       purpose-specific views
(append-only)      ("now true")         (context, status, view)
```

| Layer | Role | Authority |
| --- | --- | --- |
| Event log | Append-only record of state-meaningful assertions and transitions | The only original: `log.jsonl` is the source from which everything else is rebuilt |
| Folded state | Deterministic interpretation of the complete event history | Current meaning: which records are live, proposed, superseded, retracted, blocked, or done |
| Projections | `self context`, `self status`, generated Markdown, HTML views | Inspectable output; regenerated from the fold and never an independent write path |

State is never stored as truth; it is computed by the fold. Editing a
generated file cannot create authority. The next fold detects or overwrites
drift because state changes must enter through typed events.

## One record kind: the entity

Every asserted record folds into one shape — the entity. A goal, a decision, a
convention, an objective, a milestone, and a work unit are not parallel type
systems; they are entities with different labels and default placement.

An entity carries:

- **text** — the assertion itself, immutable after confirmation; supersede to
  change it;
- **labels** — free strings; the presets use `goal`, `objective`,
  `convention`, `decision`, `milestone`, `work`;
- **links** — typed references: `member-of` groups, `supersedes` carries
  lineage, a bare id relates;
- **reserved metadata** — a minimal vocabulary the fold interprets: `target`
  (an ISO date that makes a deadline live in derived state) and `criteria`
  (exit criteria that gate done claims on evidence). The vocabulary grows only
  by explicit design decision;
- **why** — optional rationale.

`self state` is the raw verb: `state add` records an entity under any label,
`state list` and `state show` read every asserted record back — the preset
records included — and `state place` moves one in context.

### Presets are an alias table, not a type system

The preset verbs are sugar over the entity: each resolves its label and
default placement through one user-editable alias table.

| Verb | Label | Default placement |
| --- | --- | --- |
| `self goal` | goal | full · priority 0 |
| `self objective` | objective | full · priority 10 |
| `self milestone` | milestone | index · priority 20 |
| `self convention` | convention | full · priority 30 |
| `self decide` | decision | index · priority 40 |
| `self idea` | idea | search |
| `self roadmap` | roadmap | index |
| `self work` | work | search (live state shows the active ones) |

Built-in rows are defaults, never constraints: `self alias set` overrides one,
`self alias add <verb>` adds a verb of your own, and every alias verb accepts
explicit placement flags that beat the row's defaults. `self alias` prints the
merged table.

## How a state change becomes current truth

The write path has one event gate:

```text
human or agent assertion
          ↓
typed command + origin + references
          ↓
sanitize
          ↓
append event or atomic event set to log.jsonl
          ↓
fold the complete project history
          ↓
derive current state, refusals, waiting items, and health
          ↓
render Markdown and terminal/viewer projections; refresh managed blocks
          ↓
commit the event history and versioned store projections to workspace Git
```

Every entity shares one event grammar, whoever asserts it: `entity.proposed`
and `entity.confirmed` assert, `entity.superseded` replaces with a linked
successor, `entity.retracted` withdraws with a reason, `entity.placed` moves
placement, `entity.linked` and `entity.unlinked` edit edges, and
`entity.covered` records a coverage claim against a declared criterion. The
execution events — `entity.started`, `entity.blocked`, `entity.unblocked`,
`entity.done`, `entity.retired` — are facts about doing rather than
assertions. Every mutation records its actor; agents and people share the
grammar.

The appended event bytes are the durable change. If rendering fails afterward,
the event remains and a later `self fold` can regenerate its projections.
HTML views are local generated output, and managed blocks live in the project
repository; neither becomes authoritative merely because the fold rendered it.

## Placement: scope × priority × exposure

Every entity carries three placement values, each changeable by
`entity.placed`:

| Axis | Values | Meaning |
| --- | --- | --- |
| scope | `project` \| `workspace` | which contexts it enters; a workspace-scoped entity renders in every project's context |
| priority | sparse integer (0, 10, 20, …) | render order; 0 is the top of context, ties break by recency |
| exposure | `full` \| `index` \| `search` | render form: full text / one line / absent with a pointer |

Priority replaces a hardcoded section order with one rule: render in priority
order until the budget is spent, then pointers. Exposure is per entity, not
per label — one convention may be full while another has decayed to index.

A demotion — exposure moving toward less-rendered — always records `--why`.
Demotion out of full is human-owned: an agent records the move with
`--proposed`, and it waits until a person runs `self state confirm`.

### Retention caps

The always-rendered set is bounded by policy: user-set caps, engine-enforced,
per scope. The defaults are 4,000 characters of full-exposure text and 50
index entities (`fullCap` and `indexCap` in the store's `config.json`) —
characters for full because tokens are the real constraint, count for index.

Adding or placing past a cap is refused until the caller names what demotes:
`--demote <id>` frees the room by moving a named entity one tier down. An
agent passes `--proposed`, landing the add and the demotion as a pair that
waits on a person — an agent cannot silently inflate the always-rendered set,
and rendering itself never refuses.

## Context is a projection, not a dump

`self context` projects the folded state in four steps:

```text
1  collect: workspace-scoped entities + this project's entities
2  order:   by priority, ties by recency
3  render:  full → full text · index → one line · search → absent with a pointer
4  anchor:  derived live state after the full block, before the index lines
```

The derived live state is engine-owned — computed, never asserted:

- work in progress and items waiting on a person render as full rows;
- all other open work is a count with a recovery pointer;
- deadlines derive from `target` metadata; health signals and unshipped
  branches derive from the checkout.

Different consumers still need different amounts of the same state:

| Surface | What it provides |
| --- | --- |
| Managed `AGENTS.md` and `CLAUDE.md` block | Stable operating protocol plus current conventions |
| `self context` inside a registered project | That project's placed entities plus live state |
| `self context` outside a registered project | A workspace overview: each registered project's goal, work-status counts, and health-signal count |
| `self work show <id>` | The full recovery line for one unit: outcome, current status, reports, evidence |
| `self search <query>` | Pull access across registered projects, with the current project ranked first |
| `self log [-n N]` | Recent event inspection for operational or forensic reading |

The agent-facing render — a pipe, a redirect, `--plain`, `TERM=dumb`, or a
narrow terminal — enforces a 12,000-character budget and keeps omitted detail
reachable through recovery pointers that name the project they are about. The
human-oriented TTY presentation deliberately bypasses that budget.

This push/pull split addresses two opposite failures: injecting all history
eventually overwhelms the context window, and injecting too little forces
every new session to reconstruct the project.

## Append history; replace the current view

Superself changes current truth by adding events, not by rewriting earlier
ones. Consider a decision-labeled entity:

```text
entity.proposed A
        ↓
entity.confirmed B → confirms A
        ↓
entity.confirmed C → supersedes B
```

The current view shows C as the governing decision. A and B remain in history,
with their relationships intact. The same principle applies to placement,
criteria coverage, and completion.

A withdrawal is terminal: once a record is retracted, a later event naming it
does not move it back. Revision also invalidates conclusions that depended on
the previous subject — a superseding revision of a milestone starts with its
criteria uncovered, because coverage claims bind to the entity id they
covered.

## Done is gated on evidence

The execution events record facts about doing, and completion is the guarded
one. `entity.done` must carry evidence: a report with a commit or an artifact,
or a done-time report that states what verifiably happened. A bare claim is
refused. If the entity declares `criteria`, done is additionally gated on a
coverage claim (`entity.covered`) for every criterion.

This separates distinctions that survive the context window:

- proposed versus confirmed records;
- a report versus the judgment that the outcome was reached;
- an exited process versus completed work;
- evidence existing versus a gate accepting that evidence.

These distinctions let execution move between models and sessions without
moving authority into the model's private memory. Context tells an agent what
the current state says; typed transitions and shared gates decide whether the
state may advance.

## Machine-local runtime state

Some facts must not enter the synced semantic record:

- absolute checkout paths and the machine's selected workspace pointer;
- process ids and live ownership — the pid ledger (`work started`/`work
  exited`), judged only on the machine that recorded it;
- raw provider output.

Sanitized semantic results and artifact declarations fold into project state
through reports (`report.added`); the process transitions that do sync
(`work.run-started`, `work.run-exited`) carry the work id and exit code, never
the pid. This keeps a syncable company record from becoming a copy of every
provider transcript or host detail.

## Legacy records read as entities

The log is append-only, so the cutover to the entity grammar rewrote nothing.
The fold reads the pre-cutover record kinds as entities:

| Legacy event | Reads as |
| --- | --- |
| `goal.set` | entity(goal, full, priority 0), superseding the previous goal |
| `decision.proposed` / `decision.confirmed` | entity(decision, index) with the same lifecycle |
| `convention.added` / `convention.dropped` | entity(convention, full) / retracted |
| `objective.created` | entity(objective, full) with its target |
| `milestone.created` | entity(milestone, index) with its criteria |
| `work.created` / `work.started` / … | entity(work) plus execution facts |
| `report.added` | unchanged |

These legacy names are read forever and written by no verb. A workspace whose
log holds them keeps folding; the CLI emits only the entity grammar.

## What the alpha proves — and what it does not

The current OSS keeps per-project event history in a Git-backed workspace
store, folds every asserted record into placed entities, regenerates readable
views, gives a fresh session bounded context with explicit recovery paths,
and synchronizes the store through a configured Git remote, which should
normally be private.

It does not yet provide governing company direction above individual project
goals, one cross-project graph for readiness and resource allocation, a
general scope contract for every agent action, or automatic evidence-backed
completion. Project State is the shipped wedge; the
[roadmap](../roadmap.md) owns the exact boundary.

## Continue reading

- Use [Getting started with Superself](../guides/getting-started.md) to create
  the workspace, register a project, record initial state, and configure Git
  synchronization.
- Use [Running a long-term project](../guides/running-a-long-term-project.md)
  to operate goals, milestones, work, reports, and evidence across sessions.
- Use the [CLI and record reference](../reference/cli.md) for the current
  command families and record contracts.
- Read the [roadmap](../roadmap.md) for the path from the current
  project-state foundation to the complete Company State Runtime loop.
