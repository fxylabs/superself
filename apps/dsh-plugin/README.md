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
its plugin API will break; this adapter is kept thin (four tools, one command,
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

Every tool shells out to the installed `self` with an argv array — no shell,
no reimplementation of self's logic. A refusal (self not installed, no project
here, a non-zero exit) comes back as a message the model can act on, not as a
thrown error.

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
