# Superself

**Your agents forget. Your projects shouldn't.**

Superself is version control for your project's state. Git versions your code;
Superself versions the project itself — goals, decisions, work, and outputs —
so you pick up where you left off across sessions, models, and tools instead
of re-explaining your project every session.

> [!IMPORTANT]
> Superself is an early alpha. `npm install -g superself` installs the `self`
> CLI; expect breaking changes while the event schema and verbs settle.

## Why Superself

AI agents start every session from zero. The project's goals, decisions,
progress, and rejected directions live nowhere — scattered across chat
histories, terminals, hand-maintained markdown files, and provider-specific
sessions that each tool forgets or silos. Hand-maintained fixes (CLAUDE.md
files, memory banks, handoff notes) rot, contradict themselves, and depend on
discipline that fails under fatigue.

Superself splits a project into **state, work, and outputs**, and keeps them
versioned above any single session:

- **State** — goals, active decisions, progress, and open questions, kept
  small and current, with append-only history.
- **Work** — each unit has an identity, state, current report, and revision
  history.
- **Outputs** — artifacts remain connected to the work that produced them.
- **Derived context** — what an agent receives each session is generated from
  state, not hand-maintained.
- **Local-first ownership** keeps the primary workspace on your machine.

Superself is not another model provider, chat client, agent runtime, or memory
plugin. It is the project-state layer above the AI tools you already use, so
work can be directed, inspected, and finished across all of them.

## What works today

The first vertical slice is the `self` CLI — a workspace-level state store that
sits next to git:

- `self init` turns a directory into a workspace with its own state store and
  git history, and records it as the one workspace this machine uses —
  `self workspace` shows or moves that pointer;
- `self project add` registers a project through a local marker file that never
  enters the code repository; projects live wherever they already are, inside
  or outside the workspace directory, because the pointer decides the store;
- typed event verbs — `goal set`, `decide`, `work add/start/block/unblock/done`,
  `report`, `convention add` — append to a per-project JSONL log;
- the outcome layer above work — `objective add/revise/close`, `milestone
  add/revise/met/reach/recheck`, `work link/unlink`, and `work
  propose/accept/decline` — connects the goal to verified progress: a milestone
  is reached only when every exit criterion is covered by evidence, a revision
  marks what it already settled as stale until someone re-judges it, and
  `self timezone` fixes the zone every target date falls due in;
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
  `self project link` reconnects each project checkout to the cloned store;
- `self view` opens a live, read-only HTML dashboard — a workspace overview,
  one project in detail, any work unit's full report history, and a full page
  of decisions, events, and artifacts each — rendered at fold time as
  self-contained files that auto-refresh in the browser, so an open tab tracks
  state with no server; `self init` asks for the language the views render in
  (`self lang` changes it later) and `self theme` picks the accent, while the
  recorded state keeps whatever language your workspace conventions choose;
- `self attempt register` records a run before its process exists — the work it
  belongs to, its runtime and model, the outputs it must produce, its heartbeat,
  its budget, and its risk class — and `self daemon start` supervises those
  attempts with no chat turn open: it observes exits and heartbeats, tells a
  confirmed exit from a process that merely vanished, verifies and hashes the
  declared outputs, attaches exactly one report per attempt, releases leases,
  parks provider-capacity waits until their reset, opens a circuit after
  repeated failures, and wakes only approved work whose dependencies are done.
  Nothing is called a success because it exited zero or said so in prose;
- `self overnight set` states, versions, and revokes what may run unattended —
  window and wake time, allowed projects, risk classes and work kinds,
  concurrency, budget, retries, whether dependencies may auto-dispatch, and
  whether a hard model and a fresh review session are required. Publication,
  outreach, payment, purchase, provisioning, destructive actions, and policy
  changes are refused whatever the policy says, at registration and mid-run;
- `self digest` groups what completed, failed, retried, and is waiting on
  approval or capacity, with cost and tokens shown as unknown when the provider
  reported none. Process handles, raw output, launch commands, and machine
  paths stay in a git-excluded machine-local spool; the synced log carries only
  sanitized lifecycle, verdicts, hashes, and artifact references.

The CLI is the first application shell. A read-only viewer is a later, optional
layer — never a required surface.

## Quick start

Requires Node.js 22.12 or newer and pnpm 10. The repository pins Node 22.20 for
contributors using nvm.

```bash
git clone https://github.com/fxylabs/superself.git
cd superself
nvm use
pnpm install
pnpm build
alias self="node $PWD/apps/cli/bin/self.mjs"
```

Then, in the directory that should hold your state:

```bash
self init                      # once per machine; asks about agents, then every
                               # later command finds the workspace on its own
cd ~/anywhere/my-project && self project add
self goal set "Ship the first release"
self work add "Payment flow passes e2e"
self context                   # what an agent should read at session start
```

## Verify a checkout

```bash
pnpm typecheck
pnpm proof                     # end-to-end proof: lifecycle + two-machine sync
pnpm build
```

## Repository layout

```text
apps/
└─ cli/                   the `self` CLI: event log, fold, context, search

docs/
├─ maintainers/           branch, version, and release policy
└─ strategy/              problem definition and positioning decisions
```

See [the problem definition](docs/strategy/problem-definition.md) for the state
architecture the CLI implements.

## Project status

The near-term sequence is:

1. ship the `self` CLI vertical slice: workspace store, event verbs, fold,
   derived context;
2. harvest commit-message trailers into events and render the managed context
   block for agent instruction files;
3. add artifact commands and evidence-reachability checks;
4. add health derivation and cross-project workspace views;
5. add backup, restore, and migration guarantees;
6. publish the CLI as the `superself` package;
7. evaluate an optional read-only viewer after the CLI stabilizes.

## Community and contributions

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull
  request.
- Use the structured GitHub issue forms for reproducible bugs, concrete feature
  proposals, and maintenance work.
- Do not open a pull request until a maintainer has accepted the related issue
  and assigned it to you.
- Sign off every commit to certify the [Developer Certificate of Origin](DCO).
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Read the [release policy](docs/maintainers/releases.md) before proposing
  version or tag changes.

Superself accepts implementation pull requests only after a maintainer accepts
and assigns the related issue. Contributions are licensed under Apache-2.0 as
described in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Superself is licensed under the [Apache License 2.0](LICENSE).
