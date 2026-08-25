# Superself

**The open Company State Runtime.**

Models have context. Agents have runtimes. Companies need state.

Company State is the durable, versioned truth of what an organization intends,
has decided, is doing, may authorize, and can prove. A Company State Runtime
turns that state into context, ready work, evidence-gated completion, and the
next company state. Engine-enforced policy today covers the raw state verbs
and the completion gate; supervised execution through WorkSpec contracts and
cap-gated preset verbs are stated targets —
[docs/roadmap.md](docs/roadmap.md) draws that boundary.

> [!IMPORTANT]
> Superself is an early alpha. The local `self` CLI and the foundations
> described under [What works today?](#what-works-today) work now. The
> complete Company State Runtime loop is the direction of the project, not a
> capability this release claims to have finished. Expect breaking changes
> while the event schema and verbs settle.

## What is Superself?

Superself is building the open-source Company State Runtime: durable state
beyond any one context window today, and governed execution beyond any one
person's attention span as the target. People set direction, make
consequential decisions, and remain accountable. Agents carry most planning,
routine execution, recovery, verification, and reporting.

It exists to keep one kind of context in sync between humans and agents, from
a single project up to a whole company: why each decision was made and
whether it still holds, why each piece of work exists, what it contributes
to, how far it is, and what blocks it. It is deliberately model-neutral and
session-neutral — any agent, any tool, any session reads and writes the same
state — because agent-native companies will not be built on one vendor's
memory.

What ships today is the `self` CLI: a local-first vertical slice that
requires no Superself account and keeps the primary workspace on your
machine. Git versions your code; Superself versions the project itself —
goals, decisions, work units, reports, and evidence — as typed events in an
append-only log, with the context an agent needs derived from that log on
demand.

## Why do my agents start every session from zero?

Long-running projects outlive every chat, context window, model, and human
memory. Goals, decisions, rejected directions, progress, and evidence become
scattered across sessions and tools. Each new agent spends time reconstructing
the project, misses constraints, or repeats a decision that was already made.

Hand-maintained instruction files and handoff notes help briefly, then grow
stale or too large to use. A project needs canonical state that survives its
sessions, plus a way to compile only the relevant part of that state for the
next action. This is the continuity ceiling, and it is the first ceiling
Superself targets.

## Why doesn't adding more agents scale the work?

Agent execution does not scale when a person must decompose every request,
choose every next task, watch every process, approve every step, recover every
failure, and verify every completion. The human becomes the scheduler,
message bus, and retry loop for the system. This is the supervision ceiling.

The goal is not to remove human control. It is to spend human attention where
judgment and accountability matter, while the system handles routine planning,
execution, coordination, recovery, verification, and reporting inside explicit
boundaries.

The two ceilings reinforce each other: execution cannot be delegated safely
without durable context, and durable context has limited value if a person
still has to drive every action.

## Do I need Superself, or is CLAUDE.md enough?

Instruction files like `CLAUDE.md` and `AGENTS.md` are the right place for
stable operating rules, and Superself writes into them rather than replacing
them: `self connect` renders a managed block that teaches any terminal agent
the protocol, plus the conventions recorded with `--public`. Everything else
a project records stays in the store, out of the tracked file.

What an instruction file cannot hold is the state that changes with every
session: which decisions are current and why, which work is open and who
holds it, what evidence closed a unit, what was tried and rejected. A
hand-edited file holding that goes stale the day after it is written, and it
has no history, no evidence, and no way to bound what the next session reads.
Superself keeps that moving state in an append-only event log, derives
`self context` from it on demand, and leaves the instruction file to do what
it is good at.

## How is this different from an issue tracker like Linear or Jira?

An issue tracker coordinates people: tickets, statuses, and comments, read
and updated in a web app. Superself records the state an agent needs to
act: decisions with their rationale and lineage, conventions that govern how
work is done, goals and objectives, milestones with exit criteria, and work
units whose "done" is refused until the claim carries evidence — a commit,
an artifact, or a report of what verifiably happened.

It is also placed differently: local-first, git-backed, and CLI-shaped, so
the same tool the agent already runs in is the read and write surface, and
context is compiled for the next action instead of browsed. Superself does
not replace code review or CI — a branch reaches `main` through a pull
request, and merge control deliberately stays with PR review and CI.

## Do I need a vector database or a memory service?

No. Keeping a company's working context has been attempted with wikis,
Notion, Obsidian, and a wave of agent-memory products, and the recurring
failure is not retrieval power — it is that the record of intent decays and
nothing enforces its truthfulness. That does not take complex technology to
fix. It takes durable, asserted records with rules on the write path.

Superself's state is plain text: typed events in an append-only JSONL log
inside a git repository your machine owns, folded into markdown any tool can
read. It is grep-able, diff-able, blame-able, and portable; `self search`
answers from the live records with no index server, and nothing about it is
locked to a model, a vendor, or this decade.

## How do I start?

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
self project init
self goal add "Ship the first trustworthy release"
self decide "Keep customer data local" --why "This project handles private data"
self work add "The payment flow passes its end-to-end proof"
self context
```

Follow the [getting started guide](docs/guides/getting-started.md) for the full
setup path, including the separate state repository, managed agent blocks,
private Git synchronization, and restoration on another machine. Follow the
[long-running project guide](docs/guides/running-a-long-term-project.md) to
carry a real outcome across sessions and agents through milestones, reports,
and evidence-backed completion.

Run `self --help` for the full command surface. The main families are:

- project state: `goal`, `decide`, `convention`, `objective`, `milestone`;
- the entity grammar underneath them: `state`, `alias`;
- work and evidence: `work`, `report`, `artifact`;
- the process ledger: `work started`, `work exited`;
- context and inspection: `context`, `status`, `search`, `view`;
- workspace ownership: `project`, `workspace`, `remote`, `sync`, `clone`.

## What does an agent get at session start?

`self context` prints the derived context an agent needs: the goal, active
decisions and conventions, open work, and recent reports — generated from
state, never hand-maintained. `self work show <id>` recovers the complete
state of one unit and `--history` pages over its own events; `self search
<query>` pulls the live records context left out, across every registered
project. Managed blocks in `AGENTS.md` and `CLAUDE.md` teach terminal agents
to load and maintain that state, and the block refreshes on every fold.

Read [Company State and context](docs/concepts/company-state-and-context.md)
for the exact relationship between append-only event history, folded current
state, generated views, agent context, recovery, and machine-local runtime
data.

## Why was this decided — and does it still hold?

The most expensive sentence in a long project is "wait, why did we do it
that way?" — asked again by every new session, model, and teammate, and
answered from fading memory. Superself makes a decision a first-class record:
`self decide` carries the decision and its `--why`, `--proposed` marks what
no person has confirmed yet, and a correction restates the record with its
lineage instead of editing history. The next agent reads which decisions are
current and why they were made — and stops re-litigating the ones that
already closed.

## What is this work contributing to, and what is it blocked on?

A task list answers "what is there to do." It does not answer what a unit of
work contributes to, how far it actually is, or why it is stuck — the
questions a person or agent picking it up needs first. In Superself a work
unit links to the objective or milestone it serves, its reports attach the
commit they describe as evidence, `self work block` records what it waits on
— a decision, a dependency, or something external — and the process ledger
shows whether an agent process is still running it or died without
reporting. Pickup starts from the unit's own record, not from a previous
session's transcript.

## How does "done" stay honest?

Transcript text is not canonical state, an agent saying "done" is not proof,
and autonomy is not permission to act without boundaries.

`self work done` refuses a bare claim: the outcome closes only when a report
carries a commit or an artifact, or the done itself states what verifiably
happened. Declared criteria gate the claim until each is covered by evidence.
Reports attach the project's HEAD commit automatically, attached artifacts
are digest-checked against what was ingested, and a work unit's outcome is
immutable once recorded — a correction restates it with its lineage rather
than editing history.

## How does a company-level goal show its progress?

Progress is judged by outcomes, not motion. A goal breaks into time-boxed
objectives; objectives carry milestones whose exit criteria must each be
covered by evidence before the milestone counts as reached; work units link
to what they serve, so within each project the chain from a goal down to
the commit that moved it is readable in both directions. A workspace-scoped
record renders in every project's context, which is how direction set once
reaches every project and agent that must follow it.

## How does context stay small as the project grows?

State accumulates for the life of a company; a context window does not. Every
record therefore carries a placement — scope, priority, and exposure — that
decides whether it renders as full text, one index line, or only a search
pointer, and retention caps bound the always-rendered set in context tokens.
Growth demotes detail toward `self search` instead of burying the context an
agent reads, demotions record why, and an agent proposing one waits for a
person to confirm. A mature project is built to resume without an oversized
dump of its own history — making that selection reliable at every scope is
the roadmap's Phase 2 exit. (The raw state verbs enforce the caps today; the
preset verbs are not cap-gated yet.)

## Does it force a methodology?

No. Underneath every verb is one record kind — an entity with text, free
labels, typed links, and a placement — and the preset verbs (`goal add`,
`decide`, `work add`, and the rest) are rows in a user-editable alias table.
`self alias add <verb>` makes a first-class verb of any label your company
actually uses; `self state` records anything the presets do not name. Your
vocabulary, cadence, and process stay yours — Superself versions the state,
not the methodology.

## What works today?

- **Durable state.** Goals, decisions, conventions, objectives, milestones,
  and work fold into one placed entity record, as typed events in an
  append-only log; every event refolds canonical views and lands as one
  commit in the workspace's own git history.
- **Cross-session pickup.** `self context`, `self work show`, and
  `self search` give agents a generated view of current state and a pull
  path into full history; managed blocks in `AGENTS.md` and `CLAUDE.md`
  teach terminal agents to load and maintain it.
- **Outcome links and evidence.** Work contributes to objectives and
  milestones; done is a judgment whose claim must carry evidence, and
  declared criteria gate it until each is covered.
- **The process ledger.** A work unit maps to the agent process running it,
  with liveness judged at read time; merge control deliberately stays with
  GitHub PR review and CI.
- **Inspectable views and sync.** `self view` renders read-only HTML pages
  of the workspace, each project, work, decisions, events, and artifacts;
  explicit git-backed sync carries the store between machines.

The [command-level inventory](docs/reference/working-foundations.md) states
each of these as verifiable claims against the current CLI.

## What is not finished yet?

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

## What loop is this building toward?

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

The roadmap below is organized by operating outcome, not by release date. It
states direction rather than a compatibility or delivery promise. The detailed
current constraints, near-horizon capabilities, exit evidence, and issue
mapping live in the [living roadmap](docs/roadmap.md).

- **Phase 1 — Durable project state.** Make goals, decisions, work, reports,
  artifacts, history, and evidence survive any session or tool. Keep state
  local-first, inspectable, and reconstructible. *Status: the first usable CLI
  foundation is shipped and actively dogfooded.*
- **Phase 2 — Bounded context at every scope.** Compile stable workspace,
  project, work, and attempt contexts; select governing decisions,
  conventions, dependencies, and risk rules for the current action. *Exit: a
  fresh agent resumes a mature project without a manual rebrief, an oversized
  context dump, or a contradiction of governing state.*
- **Phase 3 — Governed autonomous execution.** Compile bounded intent into
  executable work, schedule it across projects, supervise attempts, recover
  failures, verify outputs, and complete work whose evidence and authority
  gates are satisfied. *Exit: one bounded human direction reaches
  evidence-backed completion without continuous human scheduling or terminal
  supervision.*
- **Phase 4 — Composable company capabilities.** Let trusted extensions
  contribute namespaced operations through one permissioned capability
  contract, including MCP adapters. *Exit: a company adds domain capabilities
  without hard-coding them into Superself or bypassing its trust model.*
- **Phase 5 — The Company State operating surface.** Turn the viewer into the
  primary conversational surface for directives, approvals, interruption, and
  live activity. *Exit: a person directs and understands a continuously
  operating agent organization from one surface while remaining responsible
  for the decisions that matter.*

## Who owns what — the person or the engine?

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

## Why an open core?

The state, policy, evidence, and execution boundary is where a company decides
what agents may know and do. That layer must be inspectable, portable, and able
to run locally without metering the number of agents, attempts, or connected
capabilities.

An open core also gives capability builders one stable operating contract
instead of requiring every tool to invent its own memory, approval, recovery,
and evidence system.

## FAQ

**Where does my data live?**
On your machine. The workspace store is its own git repository, separate from
your code, and nothing leaves it until you connect a remote of your choosing
with `self remote add` and push with `self sync`. There is no account.

**Which agents does it work with?**
Any terminal agent that reads `AGENTS.md` or `CLAUDE.md` — the managed block
teaches it the protocol — and anything that can run a CLI can read and write
state directly.

**What happens when two sessions write at once?**
Every event is one line in an append-only JSONL log, so concurrent appends —
including from different machines — merge cleanly. A work unit another
session holds is disclosed with who took it and when, never locked.

**Is a chat transcript state?**
No. Only asserted records enter the log. Transcript text is not canonical
state, and an agent saying "done" is not proof — the completion gate demands
evidence.

**Does Superself decide what merges to `main`?**
No. A branch reaches `main` through a GitHub pull request; merge control is
deliberately owned by PR review and CI. Superself owns context and the work
graph, not the merge gate.

**What does it cost?**
The core is Apache-2.0 and runs entirely locally, with no metering of agents,
attempts, or connected capabilities.

## How do I develop and verify a checkout?

The repository pins Node 22.20 for contributors using nvm and uses pnpm 10.

```bash
git clone https://github.com/fxylabs/superself.git
cd superself
nvm use
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm structure
```

Use the [CLI and record reference](docs/reference/cli.md) when you need the
current command families, record shapes, or the implementation-owned help
boundary. If you are customizing the rendered viewer, use the
[viewer theming guide](docs/viewer-theming.md) for the supported token and
theme boundary.

## Where does each file go?

```text
apps/
└─ cli/                   the `self` CLI: state, context, work, and the process ledger

docs/
├─ concepts/              the state, context, authority, and evidence model
├─ guides/                task-oriented guides for using the current CLI
├─ examples/              end-to-end operating scenarios
├─ reference/             current CLI command and record reference
├─ viewer-theming.md      supported viewer tokens and accent themes
├─ content-planning.md    reader-first brief and approval standard (Korean; .en counterpart)
├─ content-quality-review.md  reusable ready/validated gate (Korean; .en counterpart)
├─ content-guide.md       production form, language rules, and pre-publish checklist (ko/en)
├─ maintainers/           branch, version, and release policy
├─ roadmap.md             current capability, next outcomes, and exit evidence
└─ strategy/              problem definition and positioning decisions

ARCHITECTURE.md           layering, single gates, event namespaces, fixed naming
CONTRIBUTING.md           process and code conventions
```

Reader-facing content work also loads
`.agents/skills/content-quality-gate/SKILL.md`. The gate applies to marketing
pages, email, docs, tutorials, metadata and explanatory media: an approved
brief precedes production, and an independent `ready` receipt precedes
publication. It classifies work by its effect on the reader rather than by file
extension.

This repository holds the CLI and the documentation. The superselfs.com site
and the operational jobs that measure it live in a separate deployment
repository, which reads `docs/` from here — nothing in this repository
publishes a website or runs a scheduled job.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing code and
[CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## How do I contribute?

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
