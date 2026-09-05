# dsh-plugin-superself

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)
plugin that gives the model Superself's `self` CLI as tools, plus a `/self`
command for you.

Superself is version control for a project's — and a company's — state:
goals, decisions, work units, reports, kept outside the code repository and
derived into what an agent must know now by `self context`. dsh's own goal
plugin holds a goal for one session; Superself holds the project's state
across sessions, across projects, and across agent tools, with a human
approving what counts as decided and done.

Tested against `@deepseek-ai/dsh@0.1.1-rc.2`. dsh is a release candidate and
its plugin API will break; this adapter is kept thin (five tools, one command,
one runner) so re-targeting is cheap. The peer range in `package.json` names
the line it was tested on.

## Install

```sh
npm i -g superself                                  # the self CLI (once per machine)
dsh plugin --profile web add dsh-plugin-superself   # into the profile you use (web, tui, …)
```

Then start dsh (`dsh web`) from a directory that is a Superself project — one
with a `.self` file at its root, which `self project init` writes — or point
the plugin at one with `cwd` below. `dsh plugin` needs `--profile`; the plugin
goes into each profile you want it in.

Tested on macOS and Linux. On Windows the `self` launcher is `self.cmd`, which
this plugin does not resolve yet — set `selfBinary` to a path that runs
without a shell, or open an issue.

## What the model gets

| Tool | Runs | Notes |
|---|---|---|
| `superself_context` | `self context` | Goal, decisions, conventions, open work, deadlines, what is waiting on a human. |
| `superself_work` | `self work` / `self work show <id>` / `self work start <id>` | `action` is `list`, `show`, or `start`; `id` is validated as `w-[a-z0-9]+`. |
| `superself_report` | `self report <id> "<text>" [--evidence <commit>]` | Refuses an empty `text`. |
| `superself_decide` | `self decide "<text>" [--why <reason>]` | Refuses an empty `text`. |
| `superself_instructions` | `self instruction render` | The workspace's execution rules, tool notes and procedures, whole — outside the context render budget. |

Every tool shells out to the installed `self` with an argv array — no shell,
no reimplementation of self's logic. A refusal (self not installed, no project
here, a non-zero exit) comes back as a message the model can act on, not as a
thrown error.

## Commands the plugin points at rather than exposes

These five tools are the whole tool surface. The rest of the work graph is run
through the installed CLI in a terminal, and the model is expected to reach for
it there — there is no tool for any of the commands below.

Pick the record kind by what it asserts, never by how its text reads or what
date it carries: a goal is lasting direction; an objective is a desired state
with a time boundary; a milestone is a checkpoint reached once, through its exit
criteria; a work unit is one bounded effort and its outcome; a decision states a
policy or assumption; a runbook states a procedure this project repeats, and
each occurrence of it is a work unit linked to a run.

A unit says one of three things about the outcomes it serves, and none of them
is read out of its wording or its dates:

```bash
self work link <id> --objective <objective-id>          # it moves that outcome
self work link <id> --milestone <milestone-id>          # it moves that checkpoint
self work link <id> --standalone --why "<reason>"       # it moves none, on purpose
self runbook link <run-id> --work <id>                  # one occurrence of a repeated procedure
```

A unit that states none of the three is not standing alone; it is one nobody
has said anything about yet. Declaring standalone hides no existing link —
`self work unlink <id> --objective <objective-id>` withdraws the edge, and the
declaration is taken back the same way it was made, with `self work unlink <id>
--standalone`.

A checkpoint can name the decisions it rests on, and replacing one is two
statements rather than a rewrite:

```bash
self milestone link <milestone-id> --decision <decision-id>
self milestone unlink <milestone-id> --decision <old-decision-id>
```

A contribution names an outcome that is still open. `self work link`,
`self work propose` and `self work confirm` refuse a target that was reached,
dropped or superseded — a checkpoint under a closed objective included — and
the refusal names the open successor of that lineage, or the standalone
declaration where the lineage ends closed. `self work unlink` is never refused
for it: taking an edge off an outcome that is over is the repair.

A plan whose gap closed before anyone answered it is moved rather than
abandoned, and only until it is first started:

```bash
self work revise <id> "<plan>" --why "<what changed>" --milestone <open-id>
self work confirm <id>
```

The gap is part of the plan, so the same plan text toward a new outcome is
still a revision: the acceptance is invalidated, and a contribution an earlier
acceptance had written toward the old gap is withdrawn in the same append.

A revision carries the work. `self objective revise` carries every live
checkpoint and every unit linked directly to the objective;
`self milestone revise` carries the checkpoint's work and the decisions it
assumed. Nothing is unlinked — a carried unit reads current under the successor
and unchanged toward every other outcome it serves — and done work carries as a
membership, never as coverage.

A checkpoint may be judged on its objective's own date but never after it:
`self milestone add` and `self milestone revise` refuse a later one, while the
objective's own date moves either way and warns when a live checkpoint falls
beyond it. Neither date stated means the ordering is not checked.

Coverage records the objective it was judged under, so a checkpoint a revision
carried names the criteria that were judged under a former parent. That is a
judgment to review, not a wrong one, and a person settles each one at a time:

```bash
self milestone recheck <milestone-id> --criterion cN --why "<what you re-judged>"
```

Reading the direction graph back is a command of its own, and it changes
nothing:

```bash
self objective check [--project <slug>] [--json]
```

It names seven things and no more: work whose every current contribution is to
an outcome that is over; a successor checkpoint with no live work beside a
predecessor that still has some; a checkpoint dated past its objective; a
coverage judgment made under a former parent, or an assumption on a decision
that was replaced; done work that is a candidate for an uncovered criterion;
work that states no disposition at all; and an objective whose whole live
checkpoint workload is runbook occurrences.

It never relinks, covers, revises or reclassifies. Every line it prints is a
command the model or the user runs themselves, and the printed steps for the
route chosen clear the finding they were printed under. A candidate is
information: nothing is paired to a criterion by its wording, and maintenance
is read off the run link rather than out of a record's text. Where a unit
contributes to another project's objective and this machine cannot read that
project, the answer says the target state was not checked rather than
reporting all clear. `self status` and `self context` carry the count.

## What you get

`/self` prints `self context` in the chat, without a model turn.

## Config

Override in the profile's patch layer (`dsh plugin` installs the plugin under
the id `superself`):

```yaml
- insert:
    - id: superself
      name: dsh-plugin-superself
      config:
        selfBinary: self        # a name looked up on PATH, or a full path
        cwd: ""                 # directory to run self in; "" = where dsh was started
        maxOutputChars: 20000   # longer output keeps its head and ends with a marker
```

| Field | Default | Meaning |
|---|---|---|
| `selfBinary` | `self` | Looked up on the dsh process's PATH, then in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `~/.npm-global/bin`, `~/.local/bin`. A value containing `/` is used as a path. |
| `cwd` | `""` | The plugin walks up from here to the nearest `.self` and runs self in that directory; the tool output says so when it differs. Empty means the directory dsh was started in. |
| `maxOutputChars` | `20000` | Output past this is cut; the marker names the `self` command to run for the rest. |

## Messages the model may see

- `The \`self\` CLI was not found …` — install with `npm i -g superself`, or set
  `selfBinary`.
- `No Superself project at or above <dir> …` — run `self project init` in the
  project, or set `cwd`.
- Anything self refused, verbatim from its stderr.

Tool output never includes environment values.

## Develop

```sh
pnpm install
pnpm --filter dsh-plugin-superself test     # builds lib/ and runs the unit tests
pnpm --filter dsh-plugin-superself build
dsh plugin --profile scratch add ./apps/dsh-plugin   # local install into a profile
```

The unit tests run the real runner against a fake `self` on a private PATH
and a scratch project tree; they never touch an installed self or workspace.
`test/smoke/README.md` is the real-install check — pack, `dsh plugin add`,
boot a profile, call the tools through dsh's registry — with the transcript of
the last run that passed.

## License

Apache-2.0, as the rest of [Superself](https://github.com/fxylabs/superself).
