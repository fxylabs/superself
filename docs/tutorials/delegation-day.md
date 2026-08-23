# Hand six units of a day's work to agents and read the result as state

This tutorial follows six pieces of work in one project, each assigned to a separate agent. The operator wrote the required outcomes first, read the agents' surveys before approving execution, and used `self work` to check where the work stopped that evening.

The commands and records come from 2026-08-23. Operator scenes were re-recorded with the same commands in an isolated workspace. Each agent ran in its own Claude Code session inside an Orca worktree.

## Destination

Start with the screen from that evening. All six work units are `active`, and each has reports and evidence.

```text
$ self work --project superself --plain | grep -E "w-(rwmxx|fd2dg|6h4es|qda0a|64t76|fvhq9)"
w-fd2dg  active  self entries are merged into at least 3 existing agent-rules/AGENTS.md front-door lists, …
w-rwmxx  active  dsh-plugin-superself is public: installable with dsh plugin add from npm …
w-6h4es  active  superselfs.com has a use-with guide generator: src/content/harnesses.ts drives /use-with/<harness> pages …
w-qda0a  active  English discovery channels are examined before any posting: a recorded table per channel …
w-64t76  active  superselfs.com has a /talk screening page in Korean and English: five screening questions …
w-fvhq9  active  The adoption-metrics snapshot runs again daily and reads truthfully: the launchd job that stopped …

$ self work show w-rwmxx
held by another session, running since 2026-08-22 15:25
# w-rwmxx — dsh-plugin-superself is public: …
- Status: active
- Evidence: 8ad441b (provisional), 624a82c (provisional), c4956ee (settled)
- Evidence notes: https://github.com/fxylabs/superself/pull/321; …; https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2761
## Reports (latest first)
- 2026-08-22 — npm publish done by the maintainer: dsh-plugin-superself@0.1.0 is live …
```

Two-minute intro: [`intro.mp4`](../../examples/2026-08-23-delegation-day/tapes/intro.mp4) ([GIF](../../examples/2026-08-23-delegation-day/tapes/intro.gif)).

## Before you start

- `self` 0.7.0 (`npm install -g superself`), and a project where `self init` and `self project init` have run. First time: follow the [getting started guide](../guides/getting-started.md).
- One agent harness. On this day it was one Claude Code session per Orca worktree. `self` uses the same commands in any harness.
- The recorded run took 1 hour 45 minutes. The first brief was written at 14:57 UTC, and the sixth unit started at 16:42.

## Step 1. Record the direction first

**Command.** The operator recorded five decisions during a strategy session. A proposed decision appears under `Waiting on you` until the operator confirms it.

```text
$ self decide "M1 front-door strategy: Superself does not open its own curated repo now; …" --why "…" --proposed
$ self context
## Waiting on you
- proposal [no work recorded as gated]: M1 front-door strategy: … (confirm with `self decide confirm 01m0n7…`)
$ self decide confirm 01m0n7…
✓ entity.confirmed  M1 front-door strategy: Superself does not open its own curated repo now; it ge…
```

![Waiting on you in self context](../../examples/2026-08-23-delegation-day/tapes/waiting-on-you.gif)

**Record.** The DSH wave decision reads, "Superself ships a plugin, not a repo … within 7 days." Its `why` records the reason: the list-of-record slot closed on launch day, while the plugin surface remained open.

**State.** After confirmation, `Waiting on you` is empty and the decision appears in the next session's context. Run `self status` and check that `waiting on you` reads 0.

## Step 2. Write each brief as a work unit

**Command.** Run `self work add "<required outcome>"` once for each piece of work. These are two of the six outcome lines from the recorded day.

```text
$ self work add "dsh-plugin-superself is public: installable with dsh plugin add from npm (dsh-plugin keyword, dsh.bundle manifest), exposes self context/work/report/decide as tools plus a slash command, its entry is merged in awesome-dsh-plugin under workflow, and it is announced in the DSH Discord — by 2026-08-30"
w-rwmxx
$ self work add "The adoption-metrics snapshot runs again daily and reads truthfully: the launchd job that stopped after 2026-08-17 is diagnosed and fixed with the cause recorded, …"
w-fvhq9
```

![self work list](../../examples/2026-08-23-delegation-day/tapes/work-list.gif)

**State.** Six `next` rows appear in `self work`. Read each row by itself. If the finished state is unclear, rewrite the outcome before dispatching it.

## Step 3. Read the plan before anything runs

**Record.** The agent assigned to w-fd2dg surveyed six candidate lists before opening a pull request. Its first report includes this table:

```text
w-fd2dg step 1 — survey of six front-door lists (data pulled 2026-08-23 via `gh api`; no PR opened yet)
| repo | contribution rules | entry form | … | verdict |
| steipete/agent-rules | none; repo ARCHIVED 2026-05 | … | skip — read-only |
| github/awesome-copilot | … `npm run skill:validate`; PR to `main` … | skill folder | … | submit as skill |
| hesreallyhim/awesome-claude-code | "… must be created by human beings" | issue form | … | the maintainer must file the web form by hand |
```

**Command.** The operator read the table and approved execution. A w-rwmxx report records the handoff: "User said proceed. The only blocker was CI verify on #321 …".

**State.** Two candidate lists were removed because one was archived and one was off-topic. A human-only form went back to the operator. In `self work show w-fd2dg`, check that "no PR opened yet" predates "step 3 complete: submissions opened."

## Step 4. Delegate

**Command.** Each worktree session ran `self work start <id>`. Other sessions could then see who held the unit.

```text
$ self work show w-6h4es
held by another session, running since 2026-08-22 16:05
```

One line read from the w-6h4es Orca terminal, verbatim (Korean): "PR #1이 열렸습니다. 마무리로 최종 self report·Orca 카드 갱신·로컬 서버 정리·임시 worktree 삭제를 한 번에 처리합니다." ("PR #1 is open. To close out, I will do the final self report, the Orca card update, local server cleanup and temporary worktree removal in one pass.")

**State.** The six rows move from `next` to `active`. At the time these materials were collected, the last line of `self work show <id> --history` was `entity.started`.

## Step 5. Receive reports that carry evidence

**Command.** At each checkpoint, the agent ran `self report <id> "<verifiable result>" --evidence <commit>`. This is part of a w-rwmxx report:

```text
- 2026-08-22 — PR #321 open: https://github.com/fxylabs/superself/pull/321 … All four root gates green locally: pnpm typecheck, pnpm build, pnpm test (cli 976 tests/0 fail + plugin 23/0), pnpm structure. … Unit is NOT done until publish + list merge. Friction: root test tier took ~25 min on this Mac, not the ~12 min CONTRIBUTING states; dsh plugin add needs --profile (no default) … [8ad441b]
```

The implementation reports also record what differed from the plan. One w-fvhq9 report says: "Friction: expected a dead launchd job or a dirty tree; it was a swallowed non-fast-forward push that launchd reported as exit 0".

![self report and self work show](../../examples/2026-08-23-delegation-day/tapes/intro.gif)

**State.** `self work show` lists each evidence commit with a verdict. Check that `[8ad441b]` at the end of the report matches the hash on the `Evidence:` line.

## Step 6. Catch stops and drift in the record

**Command.** The operator tried to close a unit without evidence, then read the project status.

```text
$ self work done w-n21cx
error: w-n21cx has no evidence for done — attach a report first (`self report w-n21cx "<summary>" --evidence <commit>` or `--artifact <path>`), or state what verifiably happened with `self work done w-n21cx --report "<what happened>"`

$ self status --project superself
health: w-1aedt looks stalled — no events for 12 days; … w-64t76 evidence aa22c28 was reset away on its branch — that direction reads as attempted and abandoned; …
```

The agents follow the same rule on their side. w-6h4es: "Not marked done — maintainer closes on merge." w-rwmxx: "Unit is NOT done until publish + list merge."

**State.** The completion is refused. A unit that stopped partway reads as `looks stalled`, and a commit removed from its branch reads as `abandoned`. Both appear on the `health:` line of `self status`.

## Step 7. Let the next session pick it up

**Command.** The next day, a fresh session ran `self context`. The six units were still under `Work in progress`, each with its latest report.

```text
## Work in progress
- w-rwmxx dsh-plugin-superself is public: … [held by another session, running since 2026-08-22 15:25] — latest report: npm publish done by the maintainer: dsh-plugin-superself@0.1.0 is live … Remaining: the list maintainers merge #2761; …
- w-6h4es superselfs.com has a use-with guide generator: … — latest report: PR opened: … Gates: build green …
```

![self context](../../examples/2026-08-23-delegation-day/tapes/self-context.gif)

**State.** The new session can continue without a separate handoff document. Check that each row in `self context` includes `latest report:`.

## State diff

| | Morning (before the briefs) | Evening (after the last report) |
| --- | --- | --- |
| Decisions | proposed | 4 decisions confirmed (M1 front door, DSH wave, M4, M5), 1 convention (content loop v2) |
| Work units | none | 6, all `active`, `held by another session` |
| Reports | 0 | w-rwmxx 9, w-fd2dg 5, w-6h4es 2, w-qda0a 1, w-64t76 2, w-fvhq9 2 |
| Evidence | none | 8 commits with verdicts (`settled` 1, `abandoned` 1) |
| Outside the record | | PR #321 merged, #323 merged, #326 open, 2 superself-apps PRs open, 4 awesome-list PRs open, 1 channel-table artifact |

## Next steps

- Next tutorial: agents propose the decisions that pile up, and the operator clears them in one pass (in preparation).
- Concept: [Company State and context](../concepts/company-state-and-context.md).

## Sources

- [Source records and recording notes for 2026-08-23](../../examples/2026-08-23-delegation-day/README.md)
- [Eleven reports of agents drifting or stopping](../../examples/2026-08-23-delegation-day/voices.md)
- Work-unit briefs, reports, and histories under [`examples/2026-08-23-delegation-day/units/`](../../examples/2026-08-23-delegation-day/README.md)
