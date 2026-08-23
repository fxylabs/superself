# Getting started with Superself

This guide takes an existing project from no Superself installation to durable,
Git-versioned project state that another agent session can resume. The core
path is local. A private remote is optional, but included because it is how the
same state can be backed up and moved between machines.

By the end, you will have:

- one machine workspace that owns Superself state;
- one existing repository registered as a project;
- agent instruction files that tell new sessions to load that state;
- a durable goal, decision, and required outcome;
- a verified `self context` another agent can read; and
- optionally, a private Git remote for explicit state synchronization.

> **Note** — This guide describes the shipped local alpha. Registering work does not
> automatically plan or run an agent — a person or a session starts agents,
> and the process ledger records what is running.

## Before you start

You need:

- Node.js 22.12 or newer;
- npm; and
- an existing Git repository for the project.

The npm package is named `superself`; the command it installs is named `self`.

## 1. Install the CLI

```bash
npm install -g superself
self --help
```

`self --version` prints the installed version; seeing the command families
from `self --help` confirms the installation works.

## 2. Understand the two repositories

Superself keeps project code and Company State in different Git repositories.

| Location | What it owns | What is versioned |
| --- | --- | --- |
| Your project repository | code and instructions used by agent tools | your normal files plus the managed Superself blocks in `AGENTS.md` and `CLAUDE.md` |
| The workspace's `.superself` repository | canonical goals, decisions, work, reports, artifacts, and derived views for every registered project | each state event as a local Git commit |
| Machine configuration | which workspace this machine uses and where its local checkouts live | machine-local only; absolute paths are not synced |

The small `.self` marker may connect a checkout to its state, but it is not the
project identity. Superself excludes the marker from the project repository
locally. For another Git worktree cut from an already-linked checkout of the
same registered repository, the current CLI can resolve the project from the
repository itself. A separate clone has no linked checkout to identify it, so
run `self project link <project-slug> --here` after restoring a workspace on a new machine or
when you want that path in the machine-local link list. `self project link` with neither a
path nor `--here` only shows where the project is linked on this machine.
The canonical event history remains in the workspace store.

One machine uses one selected workspace. That workspace can hold several
projects; you do not create a separate state store inside every project.

## 3. Create the machine workspace

Choose a durable directory outside your project checkouts:

```bash
mkdir -p ~/self-workspace
cd ~/self-workspace
self init
self setup
```

`self init` creates `~/self-workspace/.superself` as a Git repository and makes
`~/self-workspace` the workspace selected by this machine. In an interactive
terminal it may ask:

- which language to use for rendered HTML views; and
- whether to add a small Superself onboarding block to this machine's agent
  instruction files.

The language setting affects human-facing views, not the language of canonical
records. Machine-level agent onboarding is optional. If you want to request it
without the prompt, use:

```bash
self init --lang <code> --agents
```

Replace `<code>` with the view language you want, such as `en`. This can modify agent instruction
files on your machine, so inspect the paths printed by the command.

`self setup` should now show the workspace, its `.superself` store, and `no
remote`. No Superself account or network connection is required.

If a workspace already exists on this machine, select it instead of
initializing another one:

```bash
self workspace ~/self-workspace
```

## 4. Register an existing project

Move to the root of the project you want Superself to manage:

```bash
cd ~/path/to/my-project
self project init
self setup
```

By default, `self project init`:

1. registers the project in the selected workspace;
2. creates the machine-local link between its slug and this checkout;
3. writes the locally excluded `.self` marker; and
4. renders managed Superself blocks into `AGENTS.md` and `CLAUDE.md`.

The command prints the derived project slug and the instruction files it
changed. `self project init` takes no path — it registers the directory it runs
in — so use `--name` when that directory's name is not the identity you want:

```bash
cd ~/path/to/checkout
self project init --name checkout-service --desc "Customer checkout service"
```

### Commit the shared agent instructions

The managed blocks tell a new agent session to run `self context` and follow
the project's state discipline. They belong in the project repository so every
supported agent tool sees the same contract.

Inspect them before committing:

```bash
git status --short
git add AGENTS.md CLAUDE.md
git commit -m "chore: connect Superself project state"
```

Do not add `.self`; Superself excludes it because it connects one local
checkout to machine-local state. If you intentionally do not want Superself to
render the project instruction blocks, register with `--no-connect`. You can
render them later with `self connect`.

## 5. Record the first durable state

Create a long-term direction, one governing decision, and one outcome that must
be reached:

```bash
cd ~/path/to/my-project
self goal add "Ship the first trustworthy release"
self decide "Keep customer data local" --why "This project handles private data"
self work add "The payment flow passes its end-to-end proof"
```

Each command answers with the event it recorded — a line such as
`entity.confirmed recorded [<event-id>]` — and `self work add` additionally
prints a work id such as `w-abc12`. Copy the id printed in your terminal; ids
in documentation are examples, not values to reuse.

These are not notes appended to a prompt. Each command records an event under
one shared grammar — a goal, a decision, and a work unit are all placed
entities, differing in label and default placement — then refolds the current
project state and commits the change to the workspace store's Git history.
`self state list` shows the merged record set with each entity's placement.

## 6. Verify that another session can resume

Use the work id returned above:

```bash
self setup
self status
self context
self work show <work-id>
```

Each command answers a different question:

| Command | Question answered |
| --- | --- |
| `self setup` | Which workspace and project does this directory resolve to? |
| `self status` | What is the short current state and what needs attention? |
| `self context` | What bounded current truth should an agent receive at session start? |
| `self work show <work-id>` | What is the full outcome, state, report history, and evidence for this unit? |

`self context` should contain the goal, the customer-data decision, and the new
work unit. That is the first useful proof: a fresh session can recover current
direction without receiving the transcript that created it.

For the complete current command families and canonical record shapes, see the
[CLI and record reference](../reference/cli.md). For exact flags and
subcommands, use `self <command> --help`, which is rendered from the same
implementation-owned catalogue.

## 7. Back up and synchronize Company State with Git

The local `.superself` store is already versioned. To back it up or use it on
another machine, first create an **empty private Git repository** with your Git
provider. Do not initialize the remote with a README or other commit.

Then connect and synchronize the workspace store:

```bash
self remote add git@github.com:your-org/company-state.git
self sync
```

`self remote add` configures the existing URL as `origin`; it does not create
the remote repository. `self sync` explicitly:

1. commits pending workspace-store changes;
2. fetches and rebases onto the current remote branch when it exists;
3. refolds derived project state after pulling; and
4. pushes the workspace-store branch.

Superself does not push after every event. Sync is an explicit operation, and
it synchronizes Company State — not the code in your project repositories.

> **Warning** — Goals, decisions, reports, and copied artifacts may contain private company
> information. Use a private remote, review who can access it, and do not assume
> that the access policy for a source-code repository is automatically right
> for the Company State store.

Run `self sync` whenever you want to exchange state with the remote.

## 8. Restore the workspace on another machine

Install Superself on the other machine, then clone the state store:

```bash
npm install -g superself
self clone git@github.com:your-org/company-state.git ~/self-workspace
```

`self clone` selects the cloned workspace for that machine and restores its
registered project state. It does not know where project checkouts live on the
new machine, because absolute paths are deliberately machine-local.

Clone or locate the project code separately, then reconnect that checkout:

```bash
cd ~/path/to/my-project
self project link <project-slug> --here
self setup
self context
```

The project slug is shown by `self clone`. Once linked, the same durable goal,
decision, work, reports, and artifacts resolve from the new checkout.

An additional Git worktree cut from an already-linked checkout of a registered
project is recognized from the repository automatically on the current
machine. A separate clone must be connected with `self project link
<project-slug> --here`. Do not register either checkout as a duplicate project.

A project that spans more than one repository links each of them: run
`self project link <project-slug> <path>` once per repository (`--force` when
the project already has one, because it changes where evidence is judged), or
register the project at the folder that holds the checkouts — a linked path that is not a
repository stands for the repositories one level below it. Commit evidence is
then judged in whichever linked repository knows the hash, and a hash is
reported as no longer resolving only when none of them does; the health line
names the repositories that were asked.

## Common setup problems

### No workspace is selected

Run:

```bash
self setup
```

If it reports no workspace, initialize one with `self init` or point the
machine to an existing one with `self workspace <path>`.

### The directory is another checkout of an existing project

Use:

```bash
self project link <project-slug> --here
```

`self project init` correctly refuses to register a duplicate when it can
identify a sibling checkout.

### The project instruction blocks were skipped or changed

Re-render them from canonical state:

```bash
self connect
```

Inspect and commit the resulting `AGENTS.md` and `CLAUDE.md` changes in the
project repository.

### A recorded checkout path is wrong, or its directory is gone

Detach it. The path leaves this machine's link list; the project itself stays
registered, with its history untouched:

```bash
self project link <project-slug>            # what is linked here right now
self project unlink <project-slug> <path>   # detach that one
self project unlink <project-slug> --here   # detach the checkout you are in
```

The path does not have to still exist — a renamed or deleted workspace is the
case this exists for. Detaching the last checkout on this machine needs
`--force`, because the project then resolves only from wherever a command
happens to run. Re-linking the path later brings it back.

### `self sync` reports that no remote is configured

Create an empty private remote, then run `self remote add <url>` before trying
`self sync` again.

## What to do next

- Read [Company State and context](../concepts/company-state-and-context.md) to
  understand how event history, folded state, generated views, agent context,
  and machine-local execution data fit together.
- Follow [Running a long-term project](running-a-long-term-project.md) to add
  objectives, milestones, reports, artifacts, and evidence-backed completion.
- Record agent processes with `self work started/exited` so a reader can see
  what is running, what went stale, and how each run ended.
- Read the [governed conversion improvement example](../examples/governed-conversion-improvement.md)
  to see analysis and plan approval before execution in an end-to-end target
  scenario.
- Read the [roadmap](../roadmap.md) for the exact boundary between today's
  local foundation and the complete Company State Runtime loop.
