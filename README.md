# Superself

**The open Company State Runtime.**

Models have context. Agents have runtimes. Companies need state.

Company State is the durable, versioned truth of what an organization intends,
has decided, is doing, may authorize, and can prove. A Company State Runtime
turns that state into context, ready work, policy decisions, supervised
execution, verified completion, and the next company state.

Superself is building the open-source Company State Runtime. It gives a company
durable state beyond any one context window and governed execution beyond any
one person's attention span. People set direction, make consequential
decisions, and remain accountable. Agents carry most planning, routine
execution, recovery, verification, and reporting.

> [!IMPORTANT]
> Superself is an early alpha. The local `self` CLI and the foundations
> described under [Where the project is today](#where-the-project-is-today)
> work now. The complete Company State Runtime loop is the direction of the
> project, not a capability this release claims to have finished. Expect
> breaking changes while the event schema and verbs settle.

## Why this exists

Adding more agents does not by itself create a company that can operate at
greater scale. Two ceilings appear first.

### 1. The continuity ceiling

Long-running projects outlive every chat, context window, model, and human
memory. Goals, decisions, rejected directions, progress, and evidence become
scattered across sessions and tools. Each new agent spends time reconstructing
the project, misses constraints, or repeats a decision that was already made.

Hand-maintained instruction files and handoff notes help briefly, then grow
stale or too large to use. A project needs canonical state that survives its
sessions, plus a way to compile only the relevant part of that state for the
next action.

### 2. The supervision ceiling

Agent execution does not scale when a person must decompose every request,
choose every next task, watch every process, approve every step, recover every
failure, and verify every completion. The human becomes the scheduler,
message bus, and retry loop for the system.

The goal is not to remove human control. It is to spend human attention where
judgment and accountability matter, while the system handles routine planning,
execution, coordination, recovery, verification, and reporting inside explicit
boundaries.

These ceilings reinforce each other: execution cannot be delegated safely
without durable context, and durable context has limited value if a person
still has to drive every action.

## What works today

The command-level foundation below is the detailed inventory; [Where the
project is today](#where-the-project-is-today) summarizes the same foundation
as operating outcomes and separates it from what is not complete.

- `self init` turns a directory into a workspace with its own state store and
  git history, and records it as the one workspace this machine uses —
  `self workspace` shows or moves that pointer;
- `self project add` registers a project through a local marker file that never
  enters the code repository; projects live wherever they already are, inside
  or outside the workspace directory, because the pointer decides the store;
- registration is one act per project, not one per working tree: every checkout
  of a registered git repository, including a worktree cut for a new branch,
  resolves from the repository itself, so there is no marker to restore and
  nothing to link before the first command works;
- every asserted record folds into one entity — text, free labels, typed
  links, reserved metadata (`target`, `criteria`), and placement — recorded
  through one shared `entity.*` event grammar in a per-project JSONL log;
- the preset verbs — `goal set`, `objective add`, `milestone add`,
  `convention add`, `decide`, `work add` — are sugar over that entity: each
  resolves its label and default placement through a user-editable alias
  table (`self alias`), `self state` is the raw verb for free-labeled
  records, and `self alias add <verb>` makes a custom verb of any label;
- placement is scope × priority × exposure: a workspace-scoped entity renders
  in every project's context, priority orders the render, and exposure picks
  full text, one line, or a search pointer — `self state place` moves any of
  the three, demotions record why, and demotion out of full waits for a
  person to confirm;
- retention caps bound the always-rendered set (defaults: 4,000 characters of
  full text and 50 index entities, per scope) — adding past a cap is refused
  until `--demote` names what frees the room, so an agent lands the pair as
  proposals a person confirms;
- the outcome layer above work — `objective add/revise/close`, `milestone
  add/revise/met/reach/recheck`, `work link/unlink`, and `work
  propose/accept/decline` — connects the goal to verified progress: a milestone
  is reached only when every exit criterion is covered by evidence, a revision
  marks what it already settled as stale until someone re-judges it, and
  `self timezone` fixes the zone every target date falls due in;
- the process ledger — `work started <id> --pid N` and `work exited <id>
  [--code N]` — maps a work unit to the agent process running it: liveness is
  judged at read time from the pid on the recording machine, a process that
  died without reporting shows as stale on the next read, and the pid itself
  never enters the synced log; merge control is deliberately not here — a
  branch reaches main through a GitHub pull request, owned by PR review and CI;
- every event immediately refolds canonical markdown (project state plus one
  file per open work unit) and lands as exactly one commit in the workspace
  repository, so state has log, blame, and revert;
- `self context` prints the derived context an agent needs at session start;
  `self status`, `self work`, and `self log` read state; `self search` greps the
  whole workspace with current-project results ranked first; `self setup` shows
  the project, workspace, store, and machine pointer the current directory
  resolves to;
- canonical files are generated output — hand edits are detected as drift and
  overwritten with a warning; reports attach to work units and auto-reference
  the project's HEAD commit as evidence;
- `self project add` renders an agent-onboarding block into `AGENTS.md` and
  `CLAUDE.md` — the instruction files agent tools already read — so any
  terminal agent learns the protocol and current conventions; the block
  refreshes on every fold, `self connect` re-renders it, and `--no-connect`
  skips it;
- `self init` offers to write a short block into this machine's own agent
  instruction files (`self connect --global` does it later), so agents notice
  self in projects that are not registered yet and ask you once — they are
  told never to register a project on their own;
- `self remote add` connects the workspace store to a git remote, `self sync`
  pulls, refolds, and pushes it, and `self clone` brings a store onto a new
  machine — `self clone` also points the new machine at what it cloned,
  concurrent appends from different machines merge cleanly, and
  `self project link` reconnects each project to the cloned store, once per
  repository rather than once per checkout of it;
- `self view` opens a live, read-only HTML dashboard — a workspace overview,
  one project in detail, any work unit's full report history, and a full page
  of decisions, events, and artifacts each — rendered at fold time as
  self-contained files that auto-refresh in the browser, so an open tab tracks
  state with no server; `self init` asks for the language the views render in
  (`self lang` changes it later) and `self theme` picks the accent, while the
  recorded state keeps whatever language your workspace conventions choose.

## The core operating loop

Superself is designed to turn one human direction into a durable, inspectable
execution loop:

```text
human intent
    ↓
durable directive, goal, and constraints
    ↓
scoped context and executable work
    ↓
policy, priority, dependency, capacity, and approval gates
    ↓
agent and MCP capability execution
    ↓
recovery, verification, and evidence
    ↓
canonical project state and an exception-focused report
    ↓
only consequential judgment returns to the human
```

Transcript text is not canonical state, an agent saying “done” is not proof,
and autonomy is not permission to act without boundaries.

## From real problems to core capabilities

| Operating problem | Core capability | Why it matters |
| --- | --- | --- |
| A session ends and the next agent starts from zero | Append-only project and work events, derived state, and session context | Work can continue across sessions, models, and tools |
| State grows until useful context is buried | Scope-specific, bounded context with retrieval pointers | Mature projects can resume without injecting their full history |
| Decisions and rejected directions are repeated | A decision ledger with rationale, confirmation, revision, and history | The organization accumulates judgment instead of re-deriving it |
| A handoff loses the outcome, current truth, or next action | Durable work units with reports, artifacts, and evidence | Another agent can take over without a private transcript |
| Activity is disconnected from company goals | Goal, objective, milestone, work, and evidence links | Progress is judged by outcomes rather than motion |
| A person must translate every direction into tasks | Versioned directives compiled into an execution structure | People state the outcome; the system can compile the execution structure |
| A person must choose and launch every next action | Dependency-, priority-, budget-, and capacity-aware scheduling | Ready work can advance without another foreground conversation |
| Agent processes fail, disappear, or leave partial output | The pid process ledger with read-time liveness, plus recoverable execution | Execution can be supervised without a person watching the terminal |
| Every action is either blocked or over-permissioned | Capability scopes, versioned risk policy, and explicit human gates | Routine work proceeds while consequential actions still require judgment |
| Completion reports cannot be trusted | Hashes, declared checks, and one completion gate | “Done” means the promised output exists and has evidence |
| Parallel agents collide on shared resources | Dependency edges in the work graph | Work stays parallel except where correctness requires serialization |
| The human cannot tell what is actually running | Per-unit process state, live activity, and health signals | Attention goes to exceptions, not continuous supervision |
| Every company capability is hard-coded into the core | A trusted extension and MCP capability boundary | Companies can compose their own tools without weakening the operating loop |

The table includes both shipped foundations and direction still being built.
The distinction is explicit below.

Read [Company State and context](docs/concepts/company-state-and-context.md)
for the exact relationship between append-only event history, folded current
state, generated views, agent context, recovery, and machine-local runtime
data.

## Human accountability

Superself's autonomy model is an allocation of responsibility.

Humans own:

- goals, priorities, values, and organizational constraints;
- irreversible, external, high-risk, or ambiguous decisions;
- approval boundaries and the policies agents operate within;
- accountability for what the company ultimately does.

The engine should own:

- translating approved intent into bounded work;
- routine scheduling, execution, coordination, retry, and recovery;
- checking declared outputs, tests, evidence, and completion conditions;
- maintaining canonical state and reporting material changes;
- escalating when policy says human judgment is required.

## Where the project is today

Superself currently ships an early local-first vertical slice as the `self`
CLI. It requires no Superself account and keeps the primary workspace on your
machine.

### Working foundations

- **Durable state.** Goals, decisions, conventions, objectives, milestones,
  and work fold into one placed entity record; reports and artifacts attach to
  it — all as typed events in an append-only log. Every event immediately
  refolds canonical views and lands as one commit in the workspace's own git
  history.
- **Cross-session pickup.** `self context`, `self work show`, and `self search`
  give agents a generated view of current state and a pull path into full
  history. Managed blocks in `AGENTS.md` and `CLAUDE.md` teach terminal agents
  to load and maintain that state.
- **Outcome links.** Work can contribute to objectives and milestones and
  attach reports and immutable artifacts; done is a judgment whose claim must
  carry evidence — a report with a commit or an artifact, or a done-time
  report of what verifiably happened — and declared criteria gate it until
  each is covered.
- **The process ledger.** A work unit maps to the agent process running it —
  pid, started-at, running, stale, or exited, judged at read time by the OS on
  the recording machine. Merge control is deliberately left to GitHub PR
  review and CI.
- **Inspectable views and sync.** `self view` renders read-only workspace,
  project, work, decision, event, and artifact pages. Explicit git-backed sync
  can carry the state store between machines.

### Not complete yet

- Project context is not yet reliably bounded and selected by workspace,
  project, work, attempt, domain, risk, and directive scope.
- Natural-language intent does not yet compile through one stable public
  contract into objectives, work graphs, policies, and attempts.
- Nothing schedules work across projects; dispatch is a person or a session
  starting agents, and the full loop across priorities, dependencies, budgets,
  capacity, failures, and completion is unproven.
- The extension and MCP capability registry is still a design direction, not a
  general shipped plugin runtime.
- The viewer is read-only today. It is not yet the conversational surface for
  directing, approving, interrupting, and observing company execution.
- The complete path — one human outcome, autonomous planning and execution,
  recovery from failure, evidence-backed completion, and escalation only for
  consequential judgment — has not yet been proven as one stable product loop.

The command surface is broader than the finished product loop because the
project is building and dogfooding its reliability primitives from the bottom
up.

## Roadmap

The roadmap is organized by operating outcome, not by release date. It states
direction rather than a compatibility or delivery promise. The detailed
current constraints, near-horizon capabilities, exit evidence, and issue
mapping live in the [living roadmap](docs/roadmap.md).

### Phase 1 — Durable project state

Make goals, decisions, work, reports, artifacts, history, and evidence survive
any session or tool. Keep state local-first, inspectable, and reconstructible.

**Status:** the first usable CLI foundation is shipped and actively dogfooded.

### Phase 2 — Bounded context at every scope

Compile stable workspace, project, work, and attempt contexts. Select governing
decisions, conventions, dependencies, and risk rules for the current action;
keep long reports and history behind explicit recovery pointers.

**Exit outcome:** a fresh agent can resume a mature project without a manual
rebrief, an oversized context dump, or a contradiction of governing state.

### Phase 3 — Governed autonomous execution

Compile bounded intent into executable work, schedule ready work across
projects and available resources, supervise attempts, recover failures, verify
outputs, derive routine authorization from versioned policy, and complete work
whose evidence and authority gates are satisfied. Escalate only when policy
requires human judgment.

**Exit outcome:** one bounded human direction reaches evidence-backed
completion without continuous human scheduling or terminal supervision.

### Phase 4 — Composable company capabilities

Let trusted local or remote extensions contribute namespaced operations through
one permissioned capability contract, including MCP adapters. Preserve process
isolation, audit, compatibility, revocation, and approval boundaries.

**Exit outcome:** a company can add CRM, research, publishing, operations, or
other domain capabilities without hard-coding them into Superself or creating a
path around its trust model.

### Phase 5 — The Company State operating surface

Turn the viewer into the primary conversational surface for directives,
questions, approvals, interruption, reprioritization, live activity, and
reports. A persistent orchestrator uses the same canonical state and governed
runtime underneath it.

**Exit outcome:** a person can direct and understand a continuously operating
agent organization from one surface while remaining responsible for the
decisions that matter.

## Why an open core

The state, policy, evidence, and execution boundary is where a company decides
what agents may know and do. That layer must be inspectable, portable, and able
to run locally without metering the number of agents, attempts, or connected
capabilities.

An open core also gives capability builders one stable operating contract
instead of requiring every tool to invent its own memory, approval, recovery,
and evidence system.

## Quick start

Requires Node.js 22.12 or newer.

```bash
npm install -g superself
```

Initialize the directory that should hold the machine's workspace state, then
register an existing project:

```bash
mkdir -p ~/self-workspace
cd ~/self-workspace
self init

cd ~/path/to/my-project
self project add
self goal set "Ship the first trustworthy release"
self decide "Keep customer data local" --why "This project handles private data"
self work add "The payment flow passes its end-to-end proof"
self context
```

`self context` is what an agent reads at session start. `self work show <id>`
recovers the complete history of one unit, and `self search <query>` pulls older
or cross-project state on demand.

Follow the [getting started guide](docs/guides/getting-started.md) for the full
setup path, including the separate state repository, managed agent blocks,
private Git synchronization, and restoration on another machine.
Read [Company State and context](docs/concepts/company-state-and-context.md) to
understand how event history, folded state, generated views, agent context, and
machine-local runtime data fit together.
Use the [CLI and record reference](docs/reference/cli.md) when you need the
current command families, record shapes, or the implementation-owned help
boundary.
If you are customizing the rendered viewer, use the
[viewer theming guide](docs/viewer-theming.md) for the supported token and
theme boundary.
Follow the [long-running project guide](docs/guides/running-a-long-term-project.md)
to carry a real outcome across sessions and agents through milestones,
reports, and evidence-backed completion.

Run `self --help` for the full command surface. The main families are:

- project state: `goal`, `decide`, `convention`, `objective`, `milestone`;
- the entity grammar underneath them: `state`, `alias`;
- work and evidence: `work`, `report`, `artifact`;
- the process ledger: `work started`, `work exited`;
- context and inspection: `context`, `status`, `search`, `view`;
- workspace ownership: `project`, `workspace`, `remote`, `sync`, `clone`.

## Develop and verify a checkout

The repository pins Node 22.20 for contributors using nvm and uses pnpm 10.

```bash
git clone https://github.com/fxylabs/superself.git
cd superself
nvm use
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Repository layout

```text
apps/
└─ cli/                   the `self` CLI: state, context, work, and the process ledger

docs/
├─ concepts/              the state, context, authority, and evidence model
├─ guides/                task-oriented guides for using the current CLI
├─ examples/              end-to-end operating scenarios
├─ reference/             current CLI command and record reference
├─ viewer-theming.md      supported viewer tokens and accent themes
├─ maintainers/           branch, version, and release policy
├─ roadmap.md             current capability, next outcomes, and exit evidence
└─ strategy/              problem definition and positioning decisions

ARCHITECTURE.md           layering, single gates, event namespaces, fixed naming
CONTRIBUTING.md           process and code conventions
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing code and
[CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## Community and contributions

- Use the structured GitHub issue forms for reproducible bugs, concrete feature
  proposals, and maintenance work.
- Do not open a pull request until a maintainer has accepted the related issue
  and assigned it to you.
- Sign off every commit to certify the
  [Developer Certificate of Origin](https://developercertificate.org/).
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Read the [release policy](docs/maintainers/releases.md) before proposing
  version or tag changes.

Superself accepts implementation pull requests only after a maintainer accepts
and assigns the related issue. Contributions are licensed under Apache-2.0 as
described in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Superself is licensed under the [Apache License 2.0](LICENSE).
