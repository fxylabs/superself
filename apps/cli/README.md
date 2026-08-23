# Superself

**The open Company State Runtime.**

Models have context. Agents have runtimes. Companies need state.

Superself is version control for your project's state — the runtime's shipped
foundation. Git versions your code; Superself versions the project itself —
goals, decisions, work units, and evidence — so work picks up where it left
off across sessions, models, and tools instead of being re-explained every
session. The full picture, what works today, and the roadmap boundary live in
the [repository README](https://github.com/fxylabs/superself#readme).

Installing this package gives you the `self` CLI.

```sh
npm install -g superself
```

Requires Node 22.12+ and git.

> Superself is an early alpha. Expect breaking changes while the event schema
> and verbs settle.

## Quickstart

```sh
mkdir my-workspace && cd my-workspace
self init                    # this directory becomes your workspace
cd ~/code/my-project
self project init            # register this directory (renders its agent block)
self goal add "ship the alpha"
self work add "signup flow works end to end"
self work start w-xxxxx
self report w-xxxxx "flow works; email verification remains" --evidence <commit>
self decide "sessions are JWT, not cookies" --why "mobile client shares the API"
```

Every verb appends an event to an append-only log inside the workspace store
(a git repository of its own, separate from your code). Canonical files —
project state, work briefs, HTML views — are derived from the log by `self
fold` and never hand-edited.

Underneath the verbs is one record kind: every assertion folds into an entity
with a label and a placement — scope (`project` or `workspace`), priority
(render order), and exposure (`full`, `index`, or `search`). The preset verbs
are rows in a user-editable alias table (`self alias`), `self state` records
and moves raw entities, and retention caps keep the always-rendered set
bounded: a `state add`, `state place`, or alias-verb add past a cap is
refused until `--demote` names what frees the room.
`self work done` refuses a bare claim — the evidence is a report with a
commit or an artifact, or a done-time `--report` of what verifiably happened.

## What agents get

`self context` prints the project's current truth — goal, active decisions,
open work, recent reports — derived from state, not hand-maintained. `self
connect` renders a managed block into `AGENTS.md` and `CLAUDE.md` so any
agent tool loads the same instructions. Reports attach the current commit as
evidence automatically. `--evidence` also takes free-form evidence — a
checksum, a build number, a validation summary — and the project repository
decides: a value it resolves is recorded as a revision and watched, anything
else is kept beside them as a note and never resolved again. Force either with
`--evidence commit:<value>` or `--evidence note:<value>`. Attached artifacts
are checked against the digest recorded when they were ingested.

## Across machines

```sh
self remote add git@github.com:you/workspace-store.git
self sync                    # commit pending, pull --rebase, refold, push
self clone <url>             # onto a second machine
```

## What this CLI will accept

`self app install <key>` downloads a mini-app — one signed JSON document — from
the rail and verifies it before a byte of it runs. Two things decide whether it
is accepted, and both are readable here rather than taken on trust.

**Pinned roots.** `src/rootkeys.ts` holds root public keys and nothing else.
They change only when you install a new version of this CLI, and their
fingerprints are published below. Nothing at runtime can add one: there is no
`--trust-root`, no `--allow-unsigned`, and no environment variable that reaches
the list.

| Root | Fingerprint (sha256 of the raw public key) | Window |
| --- | --- | --- |
| `root-2026a` — active | `sha256:20d4836e2cda50b7a27b021536b988a77b8baa1968ed49f95badd1221ba38da6` | 2026-08-23 → 2029-08-23 |
| `root-2026b` — spare | `sha256:95fc5e6d21c793e372fabb8f6a868b4a0d186fecc379a5bb7702b0bbaa491e7b` | 2026-08-23 → 2029-08-23 |

**A key list a root signed.** Which keys may sign a mini-app is not compiled
in. It is a short-lived JSON document the rail serves at
`GET /api/plugins/trust`, signed by one of the pinned roots. It names each
signing key with a validity window and a status, a minimum version per
mini-app, and its own expiry. Run `self app trust` to print the one your
machine is holding, and `self app trust --refresh` to fetch it now.

This is what the split buys you. A signing key that leaks can be **withdrawn**:
the operator publishes a document marking it revoked, and every CLI refuses it
at its next install and its next load — within 24 hours for a machine that is
online. A compiled-in signing key could not be taken back without shipping a new
CLI to every machine on earth.

And it is bounded in the other direction too. The rail can serve a stale
document, or none at all, but it cannot invent one:

| The rail can | The rail cannot |
| --- | --- |
| serve an old document, for at most its 30-day expiry | add a signing key, because it holds no root |
| serve an older document than you already have — refused, `trust_document_rollback` | un-revoke a key you have already seen revoked |
| stop serving anything, so new installs stop | stop a mini-app you already installed from loading |

A machine that is offline keeps running what it already has, on the document it
already cached; an install, which is the moment new code enters the machine,
refuses unless it can fetch a current document. The cache is a `0600` file
beside your credential, and a cache with a byte changed is treated as absent
rather than trusted.

## The viewer

Every fold renders self-contained HTML dashboards into the store — what
waits on you, what is moving, decisions, artifacts. `self view` opens the
live workspace or project page; `self theme` switches the accent
(violet, cyan, orange, mono).

## All commands

Run `self` with no arguments for the full verb list: workspaces, projects,
goals, decisions, work units, reports, artifacts, conventions, the raw state
and alias verbs, sync, views, search, and the fold. `self <command> --help` prints one command's syntax and
flags; help reads state from nowhere and writes none, so it answers in any
directory.

A flag a command does not take is refused before the command runs — the
mistake is named, the exit is non-zero, and nothing is recorded and nothing
is written. A typoed verb (`self reprot`) is refused the same way. Most
commands also refuse an argument they have no room for; the `work`
linking and proposal verbs still ignore a surplus positional.

To pass text that starts with a dash, put it after `--`:
`self goal add -- "--help is the goal"`. Before `--`, a `--help` standing
anywhere a flag could stand answers with that command's help; in an option's
value position it is handed to the command's parser instead
(`--why=--help` records the literal text).

## License

Apache-2.0. Source, issues, and contribution policy:
[github.com/fxylabs/superself](https://github.com/fxylabs/superself).
