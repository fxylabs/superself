# Working foundations — the detailed inventory

The command-level inventory behind the root README's
[What works today?](../../README.md#what-works-today) summary. Each claim
here is verified against the current CLI; when behavior and this page
disagree, the implementation-owned `--help` output wins.

- `self init` turns a directory into a workspace with its own state store and
  git history, and records it as the one workspace this machine uses —
  `self workspace` shows or moves that pointer;
- `self project init` registers a project through a local marker file that never
  enters the code repository; projects live wherever they already are, inside
  or outside the workspace directory, because the pointer decides the store;
- registration is one act per project, not one per working tree: every checkout
  of a registered git repository, including a worktree cut for a new branch,
  resolves from the repository itself, so there is no marker to restore and
  nothing to link before the first command works;
- every asserted record folds into one entity — text, free labels, typed
  links, reserved metadata (`target`, `criteria`), and placement — recorded
  through one shared `entity.*` event grammar in a per-project JSONL log;
- the preset verbs — `goal add`, `objective add`, `milestone add`,
  `convention add`, `decide`, `work add` — are sugar over that entity: each
  resolves its label and default placement through a user-editable alias
  table (`self alias`), `self state` is the raw verb for free-labeled
  records, and `self alias add <verb>` makes a custom verb of any label;
- placement is scope × priority × exposure: a workspace-scoped entity renders
  in every project's context, priority orders the render, and exposure picks
  full text, one line, or a search pointer — `self state place` moves any of
  the three, demotions record why, and an agent demoting out of full passes
  `--proposed` so the move waits for a person to confirm;
- retention caps bound the always-rendered set in context tokens (defaults:
  1,000 for full text and 12,000 for the index, per scope) — `state add`,
  `state place`, and the alias verbs refuse past a cap until `--demote` names
  what frees the room, and `--proposed` lands the pair for a person to confirm;
  `self tokens` records what a character costs, replacing the shipped estimate;
  the preset verbs are not cap-gated yet;
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
  `self status`, `self work`, and `self log` read state; `self search` answers
  over the live records context does not render, across the whole workspace with
  current-project results ranked first; `self setup` shows
  the project, workspace, store, and machine pointer the current directory
  resolves to;
- canonical files are generated output — hand edits are detected as drift and
  overwritten with a warning; reports attach to work units and auto-reference
  the project's HEAD commit as evidence;
- `self project init` renders an agent-onboarding block into `AGENTS.md` and
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
  `self project link <slug> --here` reconnects each project to the cloned
  store, once per repository rather than once per checkout of it (`self
  project link` alone only shows where a project is linked);
- `self view` opens a live, read-only HTML dashboard — a workspace overview,
  one project in detail, any work unit's full report history, and a full page
  of decisions, events, and artifacts each — rendered at fold time as
  self-contained files that auto-refresh in the browser, so an open tab tracks
  state with no server; `self init` asks for the language the views render in
  (`self lang` changes it later) and `self theme` picks the accent, while the
  recorded state keeps whatever language your workspace conventions choose.
