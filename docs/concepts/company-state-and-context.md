# Company State and context

Company State is not everything a company remembers. It is the bounded,
versioned truth that determines what the company can do next. Context is a
projection of that state, not its authority.

Superself currently applies this model at the project level. Goals, decisions,
work, reports, evidence, and execution records survive individual context
windows and agent tools. The complete Company State Runtime extends that
foundation across projects, policies, capabilities, and resource allocation;
that company-wide loop is a target, not a claim about the current alpha.

## This is a state problem, not a memory problem

Model memory and conversation history help an agent recall earlier
interactions. A knowledge base helps retrieve information. Neither one, by
itself, answers operational questions such as:

- Which goal governs the work now?
- Was this direction confirmed, merely proposed, or superseded?
- Which outcome is active, blocked, or complete?
- What requirement remains uncovered?
- Which evidence and authority permit the next transition?

A transcript contains many statements with no lasting authority. A knowledge
base may contain several mutually inconsistent answers. Company State is
narrower: typed, current truth whose status and lineage can be reconstructed.

This does not mean that every useful fact belongs in state. Agent scratch work,
private reasoning, raw provider output, and session-only instructions can be
valuable without becoming governing records. Promoting all available
information into current state would recreate the unbounded memory problem
under a different name.

## History, current state, and context are different things

Superself uses several representations for different jobs.

| Representation | Role | Authority |
| --- | --- | --- |
| Event history | Append-only record of state-meaningful assertions and transitions | Source history: the input from which current state is rebuilt |
| Folded model | Deterministic interpretation of the complete event history | Current meaning: which records are live, superseded, blocked, stale, or complete |
| Generated views | Readable `state.md`, work, objective, integration, terminal, and HTML projections | Inspectable output; regenerated from the fold and never an independent write path |
| Agent context | Purpose-specific selection of current direction, decisions, work, waiting items, and health | Input to an agent session; useful but never an authority plane |
| Recovery surfaces | `work show`, `search`, and `log` paths into detail and history | Pull access to material intentionally omitted from default context |

The word *canonical* therefore needs care:

- `log.jsonl` is the canonical event history and source of truth;
- the fold is the canonical current interpretation of that history; and
- Markdown, terminal output, the viewer, and agent context are generated
  projections of the current interpretation.

Editing a generated file cannot create authority. The next fold detects or
overwrites drift because state changes must enter through typed events.

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

Most commands record one event. A transition that must remain atomic may append
several related events in one write. In both cases, a reader can only observe
the complete state change, not a partially folded intermediate state.

The appended event bytes are the durable change. If rendering fails afterward,
the event remains and a later `self fold` can regenerate its projections.
HTML views are local generated output, and managed blocks live in the project
repository; neither becomes authoritative merely because the fold rendered it.
Project managed-block changes are committed separately by the project owner.

## What belongs in each state layer

### Asserted state

Asserted state records what a person, agent, controller, or integration has
deliberately stated. In the current project model this includes:

- the long-term goal, time-boxed objectives, and milestone outcomes;
- confirmed or proposed decisions and conventions;
- work outcomes, status transitions, proposals, and contribution links;
- reports and references to commits or artifacts;
- process transitions — a run started, a run exited — for the unit they name.

An assertion is not automatically correct or authorized. Its type, origin,
confirmation posture, revision, and references determine how the fold may use
it.

### Derived current state

Derived state is calculated rather than independently asserted. Examples
include:

- whether a work unit is next, active, blocked, or done;
- why the completion gate currently refuses `work done`;
- whether an objective is on track or a milestone lacks linked work;
- which proposal or decision is waiting for a person;
- whether work looks stalled or referenced evidence has become unhealthy; and
- whether a unit's recorded process is running, stale, or exited.

No command writes a second copy of these answers. Every surface reads the same
fold or the same single gate so the answer cannot drift by interface.

### Referenced evidence

State can cite something outside its prose:

- a source-code commit and the branch on which it was reported;
- an immutable copied artifact and its id;
- a declared output with its name, hash, and byte count; or
- a merged pull request whose review and CI live in the code host.

The reference connects the state assertion to inspectable proof. The evidence
does not grant itself authority: a commit existing does not prove an outcome,
and a process exiting successfully does not prove semantic completion.

### Machine-local runtime state

Some facts must not enter the synced semantic record:

- absolute checkout paths and the machine's selected workspace pointer;
- process ids and live ownership — the pid ledger, judged only on the machine
  that recorded it;
- raw provider stdout and stderr; and
- local capability or provider process state.

Sanitized semantic results and artifact declarations fold into project state
through reports. The raw execution channel remains machine-local.
This keeps a syncable company record from becoming a copy of every provider
transcript or host detail.

## Append history; replace the current view

Superself changes current truth by adding events, not by rewriting earlier
ones.

Consider a decision:

```text
decision.proposed A
        ↓
decision.confirmed B → confirms A
        ↓
decision.confirmed C → supersedes B
```

The current view shows C as the governing decision. A and B remain in history,
with their relationships intact. The same principle applies to work status,
objective and milestone revisions, requirement revisions, coverage, and
completion.

Generated current pages stay small by representing live state. A completed work
page or closed objective page may disappear from the generated current set,
while its events remain searchable and its lineage remains reconstructible.
Old truth becomes history; it is not silently edited into something it never
was.

Revision also invalidates conclusions that depended on the previous subject.
For example, revising a requirement makes its earlier coverage stale until it
is rechecked. This is the difference between preserving a record and trusting
it forever.

## Context is a projection, not a dump

Different consumers need different amounts of the same state.

| Surface | What it provides |
| --- | --- |
| Managed `AGENTS.md` and `CLAUDE.md` block | Stable operating protocol plus current conventions |
| `self context` inside a registered project | Session-start direction for that project: goal, open objectives, confirmed decisions, conventions, integration state, active or blocked work, waiting items, next work, and health |
| `self context` outside a registered project | A workspace overview: each registered project's goal, work-status counts, and health-signal count |
| `self work show <id>` | The full recovery line for one unit: outcome, current status, requirements, reports, attempts, evidence, and next action |
| `self search <query>` | Pull access across registered projects, with the current project ranked first; an optional event-type filter searches history |
| `self log [-n N]` | Recent event inspection for operational or forensic reading |

The managed block teaches agent tools how to use state; it does not embed the
whole project history. `self context` currently selects its surface implicitly
from the working directory: a directory under a `.self` marker, or a checkout
whose repository matches a registered project, receives that one project's
summary. A directory outside every registered project receives the selected
workspace's overview. The overview does not merge every project's detailed
state into one prompt. Long reports, completed work, superseded directions,
and cross-project detail stay behind explicit pull paths.

This push/pull split addresses two opposite failures:

- injecting all history eventually overwhelms the context window; and
- injecting too little forces every new session to reconstruct the project.

### Current limitation

The current alpha enforces a 12,000-character budget for the agent-facing
`self context` render selected by `--plain`, piped or redirected output,
`TERM=dumb`, or a terminal too narrow for a table. It keeps omitted detail
reachable through recovery pointers. The human-oriented TTY presentation
deliberately bypasses that character budget. Its
project-versus-workspace choice is still location-driven, however, and it has
no explicit scope selector. It cannot yet compile exact work-, attempt-,
domain-, directive-, and risk-scoped context for every action.

That is an active product gap. The current size bound must not be mistaken for
complete scope-aware selection. The target is a versioned context contract
that selects governing state for the action while leaving recoverable detail
behind explicit pointers.

## Authority survives the context window

An agent may propose a decision, attach a report, or produce an artifact. Those
actions do not allow its prose to promote itself into governing truth.

Superself preserves distinctions such as:

- proposed versus confirmed decisions;
- a report versus the judgment that the outcome was reached;
- an exited process versus completed work;
- evidence existence versus a gate accepting that evidence; and
- an exact subject versus a similar-looking later one.

These distinctions let execution move between models and sessions without
moving authority into the model's private memory. Context tells an agent what
the current state says; typed transitions and shared gates decide whether the
state may advance.

## What the alpha proves — and what it does not

### Shipped project-state foundation

The current OSS can:

- keep per-project event history in a Git-backed workspace store;
- fold goals, decisions, conventions, objectives, milestones, work, reports,
  artifacts, evidence, attempts, and integration records into current state;
- regenerate readable project and work views;
- give a fresh session current context and explicit recovery paths;
- separate synchronized semantic records from machine-local execution state;
  and
- synchronize the workspace store explicitly through a configured Git remote,
  which should normally be private.

### Target Company State Runtime

The current OSS does not yet provide:

- governing company or workspace direction above individual project goals;
- one cross-project graph for readiness, priority, and resource allocation;
- a general scope and retrieval-budget contract for every agent action;
- company-wide policy-derived authorization; or
- automatic evidence-backed completion and continuation across projects.

Project State is the shipped wedge. Company State is the broader operating
contract this foundation is intended to support.

## Continue reading

- Use [Getting started with Superself](../guides/getting-started.md) to create
  the workspace, register a project, record initial state, and configure Git
  synchronization.
- Use [Running a long-term project](../guides/running-a-long-term-project.md)
  to operate goals, milestones, work, reports, and evidence across sessions.
- Use the process ledger (`self work started/exited`) to
  bind an agent run to explicit capabilities, artifacts, validation, and
  recovery.
- Read the [roadmap](../roadmap.md) for the path from the current project-state
  foundation to the complete Company State Runtime loop.
