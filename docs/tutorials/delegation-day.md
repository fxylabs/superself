# Hand six units of a day's work to agents and read the result as state

One project, six pieces of work, six agents running at the same time. Each piece is written down as a brief (one line stating the required outcome) before anyone starts, and each agent comes back with reports that carry evidence. At the end, one `self work` line tells you what got how far.

Every scene in this tutorial is a real day, 2026-08-23. The agent records and state screens are copied from that day's `self` records and Orca terminals; the originals are in [`examples/2026-08-23-delegation-day/`](../../examples/2026-08-23-delegation-day/README.md). Only the operator scenes were re-recorded with the same commands in a throwaway workspace. The harness was one Claude Code session per Orca worktree.

## Why this shape

People who delegate to agents name two problems more than any other: the agent drifts off the direction it was given, and the agent stops partway and reports as if it were done. Eleven public voices with dates and links are in [`voices.md`](../../examples/2026-08-23-delegation-day/voices.md). Three of them:

- "It stops executing on plans midway, like if it was done." (anthropics/claude-code #47198, 2026-04-13)
- "it reads your message, understands the general direction, but then decides it knows better on the details." (r/ClaudeAI, 2026-02-17)
- "10 reported complete, 7 actually worked. All three misses had code sitting in the diff." (r/ChatGPTCoding, 2026-08-08)

Parallel delegation works without `self`. What `self` adds is an order: write the brief first, read whether it is enough, then execute, then come back with evidence attached. The work unit is the tool that makes that order routine.

## Destination

This is the real project, read after the day ended. All six units are `active`, and each carries reports and evidence.

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

- `self` 0.6.1 or newer (`npm install -g superself`), and a project where `self init` and `self project init` have run. First time: follow the [getting started guide](../guides/getting-started.md).
- One agent harness. On this day it was one Claude Code session per Orca worktree. `self` uses the same commands in any harness.
- Time on the real day: from the first brief at 2026-08-22 14:57 (UTC) to the sixth unit starting at 16:42, 1 hour 45 minutes.

## Step 1. Record the direction first

**What the operator did.** Recorded five decisions in a strategy session. A decision an agent raises as a proposal shows up under `Waiting on you` and takes effect only when the operator confirms it.

```text
$ self decide "M1 front-door strategy: Superself does not open its own curated repo now; …" --why "…" --proposed
$ self context
## Waiting on you
- proposal [no work recorded as gated]: M1 front-door strategy: … (confirm with `self decide confirm 01m0n7…`)
$ self decide confirm 01m0n7…
✓ entity.confirmed  M1 front-door strategy: Superself does not open its own curated repo now; it ge…
```

![Waiting on you in self context](../../examples/2026-08-23-delegation-day/tapes/waiting-on-you.gif)

**The record.** The full text of that day's decisions is in [`decisions.md`](../../examples/2026-08-23-delegation-day/decisions.md). The DSH wave decision, for one, reads "Superself ships a plugin, not a repo … within 7 days", and its `why` keeps the reason (list-of-record slot closed on launch day, plugin surface open).

**Result.** `Waiting on you` in `self context` empties, and the decision sits at the top of the next session's `self context`. Check: the `waiting on you` count in `self status` reads 0.

## Step 2. Write each brief as a work unit

**What the operator did.** One `self work add "<required outcome>"` per piece of work. The outcome states what will be true when it is done, in one line. Two of the six lines from that day, verbatim:

```text
$ self work add "dsh-plugin-superself is public: installable with dsh plugin add from npm (dsh-plugin keyword, dsh.bundle manifest), exposes self context/work/report/decide as tools plus a slash command, its entry is merged in awesome-dsh-plugin under workflow, and it is announced in the DSH Discord — by 2026-08-30"
w-rwmxx
$ self work add "The adoption-metrics snapshot runs again daily and reads truthfully: the launchd job that stopped after 2026-08-17 is diagnosed and fixed with the cause recorded, …"
w-fvhq9
```

![self work list](../../examples/2026-08-23-delegation-day/tapes/work-list.gif)

**Result.** Six rows appear in `self work` as `next`. Check: reading one row alone, can you picture the finished state? If you cannot, it is not a brief yet.

## Step 3. Read the plan before anything runs

**What the agent did.** The agent that took w-fd2dg surveyed first and reported, with nothing built yet. Its first report, in part:

```text
w-fd2dg step 1 — survey of six front-door lists (data pulled 2026-08-23 via `gh api`; no PR opened yet)
| repo | contribution rules | entry form | … | verdict |
| steipete/agent-rules | none; repo ARCHIVED 2026-05 | … | skip — read-only |
| github/awesome-copilot | … `npm run skill:validate`; PR to `main` … | skill folder | … | submit as skill |
| hesreallyhim/awesome-claude-code | "… must be created by human beings" | issue form | … | the maintainer must file the web form by hand |
```

**What the operator did.** Read the table and approved. The moment is kept in a w-rwmxx report: "User said proceed. The only blocker was CI verify on #321 …".

**Result.** Two of six targets (archived, off-topic) dropped out before any work ran, and one human-only form went to the operator. Check: in `self work show w-fd2dg`, the "no PR opened yet" report sits below (earlier than) the "step 3 complete: submissions opened" report.

## Step 4. Delegate

**What the agent did.** The session in each worktree claimed its unit with `self work start <id>`. From then on, any other session that looks at the unit sees who holds it.

```text
$ self work show w-6h4es
held by another session, running since 2026-08-22 16:05
```

One line read from the w-6h4es Orca terminal, verbatim (Korean): "PR #1이 열렸습니다. 마무리로 최종 self report·Orca 카드 갱신·로컬 서버 정리·임시 worktree 삭제를 한 번에 처리합니다." ("PR #1 is open. To close out, I will do the final self report, the Orca card update, local server cleanup and temporary worktree removal in one pass.")

**Result.** The six rows in `self work` move from `next` to `active`. Check: the last line of `self work show <id> --history` is `entity.started`.

## Step 5. Receive reports that carry evidence

**What the agent did.** At every checkpoint, `self report <id> "<what verifiably happened>" --evidence <commit>`. One w-rwmxx report, in part:

```text
- 2026-08-22 — PR #321 open: https://github.com/fxylabs/superself/pull/321 … All four root gates green locally: pnpm typecheck, pnpm build, pnpm test (cli 976 tests/0 fail + plugin 23/0), pnpm structure. … Unit is NOT done until publish + list merge. Friction: root test tier took ~25 min on this Mac, not the ~12 min CONTRIBUTING states; dsh plugin add needs --profile (no default) … [8ad441b]
```

Every report ends with one friction line. w-fvhq9: "Friction: expected a dead launchd job or a dirty tree; it was a swallowed non-fast-forward push that launchd reported as exit 0".

![self report and self work show](../../examples/2026-08-23-delegation-day/tapes/intro.gif)

**Result.** Commits accumulate on the `Evidence:` line of `self work show`, each with a verdict (`provisional` → `settled`; `abandoned` when it disappears from its branch). Check: the `[8ad441b]` at the end of the report matches a hash on the `Evidence:` line.

## Step 6. Catch stops and drift in the record

**What you see.** An agent cannot close a unit without evidence, and a stalled unit or an abandoned commit shows up on the status screen. Lines printed that day:

```text
$ self work start w-t6vy1
- Not done yet: w-t6vy1 has no evidence for done — attach a report first (`self report w-t6vy1 "<summary>" --evidence <commit>` …)

$ self status --project superself
health: w-1aedt looks stalled — no events for 12 days; … w-64t76 evidence aa22c28 was reset away on its branch — that direction reads as attempted and abandoned; …
```

The agents follow the same rule on their side. w-6h4es: "Not marked done — maintainer closes on merge." w-rwmxx: "Unit is NOT done until publish + list merge."

**Result.** A unit that stopped partway reads as `looks stalled`; a commit that changed direction reads as `abandoned`. Check: the `health:` line of `self status`.

## Step 7. Let the next session pick it up

**What the operator did.** Nothing. The next day, any session that reads `self context` finds the six units under `Work in progress`, each with its latest report (in part):

```text
## Work in progress
- w-rwmxx dsh-plugin-superself is public: … [held by another session, running since 2026-08-22 15:25] — latest report: npm publish done by the maintainer: dsh-plugin-superself@0.1.0 is live … Remaining: the list maintainers merge #2761; …
- w-6h4es superselfs.com has a use-with guide generator: … — latest report: PR opened: … Gates: build green …
```

![self context](../../examples/2026-08-23-delegation-day/tapes/self-context.gif)

**Result.** The day's state is in the record, and the next session only has to read it. Check: every line in `self context` carries `latest report:`.

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
