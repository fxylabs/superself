# 2026-08-23 delegation day · raw materials for tutorial one

On 2026-08-23 (KST) the operator discussed strategy in one session and handed six work units to agents running in Orca worktrees. This directory holds the materials tutorial one is built from. Every file names its source; nothing here is rewritten beyond scrubbing.

Scrubbing rules applied to every text file: internal git host → `<internal-git>`, artifact links → `<artifact-link>`, home paths → `~/`, machine user and host → `<user>` and `<host>`, scratchpad paths → `<scratchpad>`, email addresses → `<redacted-email>`. Nothing else was changed.

| File | What it is | Source |
| --- | --- | --- |
| `decisions.md` | The five records the operator confirmed that day: M1 front door, DSH wave, M4 demand testing, M5 discovery design, content loop v2 | `self state show <id>`, read 2026-08-23 |
| `units/w-rwmxx.md` | dsh plugin: brief outcome line, every report, event history | `self work show w-rwmxx [--history]` |
| `units/w-fd2dg.md` | front-door list PRs | `self work show w-fd2dg [--history]` |
| `units/w-6h4es.md` | use-with pages on superselfs.com | `self work show w-6h4es [--history]` |
| `units/w-qda0a.md` | English discovery-channel examination | `self work show w-qda0a [--history]` |
| `units/w-64t76.md` | /talk screening page | `self work show w-64t76 [--history]` |
| `units/w-fvhq9.md` | adoption-metrics snapshot repair | `self work show w-fvhq9 [--history]` |
| `orca/w-rwmxx.terminal-tail.txt` | last 43 lines of the agent's Orca terminal: its closing table and the `self work done` plan | `orca terminal read --terminal term_ea0dd22b… --limit 5000`, 2026-08-23 |
| `orca/w-qda0a.terminal-tail.txt` | last 46 lines: the channel table the agent printed | `orca terminal read --terminal term_95232c0c…` |
| `orca/w-6h4es.terminal-tail.txt` | last 44 lines: PR opened, final `self report` announced | `orca terminal read --terminal term_aec6e9c3…` |
| `orca/w-64t76.terminal-tail.txt` | 2 lines: the tail of the handoff prompt the agent received | `orca terminal read --terminal term_057d157e…` |
| `orca/w-fvhq9.terminal-tail.txt` | last 45 lines: the agent's cause table and remaining steps | `orca terminal read --terminal term_86442d82…` |
| `tapes/setup.sh` | builds a throwaway workspace under `tapes/scratch/` (XDG dirs inside it, so the machine's real `self` workspace is untouched), registers a project, adds the six outcome lines as work units and one proposed decision, and makes one empty commit so a report can carry `--evidence` | run by `record.sh` |
| `tapes/record.sh` | rebuilds the scratch workspace, fills the decision id into `decide-confirm.tape.in`, renders every tape with vhs | `./tapes/record.sh` |
| `tapes/self-context.tape` → `self-context.gif` | operator scene: `self context` | vhs 0.11.0, self 0.6.1 |
| `tapes/work-list.tape` → `work-list.gif` | operator scene: `self work` | vhs |
| `tapes/waiting-on-you.tape` → `waiting-on-you.gif` | operator scene: `self status`, then `self context` with its "Waiting on you" line | vhs |
| `tapes/decide-confirm.tape.in` → `decide-confirm.gif` | operator scene: `self decide confirm <id>`, then `self status` | vhs; the committed `decide-confirm.tape` carries the id of the last recorded run |
| `tapes/intro.tape.in` → `intro.gif`, `intro.mp4` | the 2-minute intro: `self context`, `self work`, `self decide confirm`, `self work start`, `self report … --evidence <commit>`, `self work show`, `self status`, in one run against the scratch workspace | vhs; ids and the evidence commit are filled in by `record.sh` from the scratch run |
| `voices.md` | eleven public statements of the drift-or-stop problem, with date, signal, verbatim quote and URL (GitHub issues, Hacker News, Reddit) | `gh`, HN Algolia API, Reddit JSON through the browser session, 2026-08-23 |
| `state-after.txt` | the real project's open-work list filtered to the six units, as it stood when the materials were collected | `self work --project superself --plain`, 2026-08-23 |

Notes

- Orca terminals keep roughly the last 45 lines, so the moment each agent ran `self work start` and `self report` had scrolled out of every terminal by the time they were read. The report history in `units/` is the record of those calls. The w-fd2dg terminal had already been replaced and is not included.
- The tape scenes run against the throwaway workspace, never against the real project store. The six work units in it carry the real outcome lines of the day, shortened to one line each; their ids are minted fresh on every `record.sh` run.
- Evidence verdicts (`settled`, `provisional`, `unverifiable`, `abandoned`) are computed against the checkout the command runs in, so the same report can read `provisional` in one worktree and `unverifiable` in another. The `units/` files show the verdicts as this worktree computed them.
- The `self` version on the recording machine was 0.6.1; the repository at that commit is 0.7.0.
