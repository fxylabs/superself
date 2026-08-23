# 하루치 일 6개를 에이전트에게 맡기고, 상태로 확인하기

한 프로젝트에서 여섯 개의 일을 에이전트 여섯에게 동시에 맡깁니다. 각 일은 시작 전에 브리프(필요한 결과 한 줄)로 기록하고, 에이전트는 증거가 붙은 보고로 돌아옵니다. 끝나면 `self work` 한 줄로 무엇이 어디까지 됐는지 읽을 수 있습니다.

이 튜토리얼의 장면은 전부 2026-08-23에 실제로 있었던 하루입니다. 에이전트 기록과 상태 화면은 그날의 `self` 기록과 Orca 터미널에서 그대로 가져왔고, 원본은 [`examples/2026-08-23-delegation-day/`](../../examples/2026-08-23-delegation-day/README.md)에 있습니다. 운영자 장면만 같은 명령을 임시 워크스페이스에서 다시 녹화했습니다. 하네스는 Orca 워크트리 안의 Claude Code 세션 하나씩입니다.

## 왜 이렇게 하나

에이전트에게 일을 맡긴 사람들이 가장 많이 말하는 문제는 두 가지입니다. 방향에서 벗어나는 것, 그리고 중간에 멈추고는 끝난 것처럼 보고하는 것. 실제 목소리 11개를 날짜와 링크와 함께 [`voices.md`](../../examples/2026-08-23-delegation-day/voices.md)에 모았습니다. 그중 셋:

- "It stops executing on plans midway, like if it was done." (anthropics/claude-code #47198, 2026-04-13)
- "it reads your message, understands the general direction, but then decides it knows better on the details." (r/ClaudeAI, 2026-02-17)
- "10 reported complete, 7 actually worked. All three misses had code sitting in the diff." (r/ChatGPTCoding, 2026-08-08)

병렬 위임 자체는 `self` 없이도 됩니다. `self`가 더하는 것은 순서입니다. 브리프를 먼저 쓰고, 충분한지 읽고, 그다음 실행하고, 증거가 붙은 보고로 돌아오게 하는 것. 이 순서를 일상으로 만드는 도구가 작업 단위(work unit)입니다.

## 도착점

하루가 끝난 뒤 실제 프로젝트에서 읽은 화면입니다. 여섯 단위가 모두 `active`이고, 각 단위에는 보고와 증거가 붙어 있습니다.

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

2분 인트로: [`intro.mp4`](../../examples/2026-08-23-delegation-day/tapes/intro.mp4) ([GIF](../../examples/2026-08-23-delegation-day/tapes/intro.gif)).

## 준비물

- `self` 0.6.1 이상 (`npm install -g superself`), 그리고 `self init`과 `self project init`을 마친 프로젝트. 처음이면 [시작 가이드](../guides/getting-started.md)를 먼저 따라 하세요.
- 에이전트 하네스 하나. 이 날은 Orca 워크트리마다 Claude Code 세션을 하나씩 띄웠습니다. `self`는 어느 하네스에서나 같은 명령을 씁니다.
- 실제 하루의 시간: 첫 브리프 기록 2026-08-22 14:57(UTC)부터 여섯 번째 단위 시작 16:42까지, 1시간 45분.

## 1단계. 방향을 먼저 기록하기

**운영자가 한 일.** 전략 논의 세션에서 결정 다섯 개를 기록했습니다. 에이전트가 제안으로 올린 결정은 `Waiting on you`에 나타나고, 운영자가 확인해야 효력이 생깁니다.

```text
$ self decide "M1 front-door strategy: Superself does not open its own curated repo now; …" --why "…" --proposed
$ self context
## Waiting on you
- proposal [no work recorded as gated]: M1 front-door strategy: … (confirm with `self decide confirm 01m0n7…`)
$ self decide confirm 01m0n7…
✓ entity.confirmed  M1 front-door strategy: Superself does not open its own curated repo now; it ge…
```

![self context의 Waiting on you](../../examples/2026-08-23-delegation-day/tapes/waiting-on-you.gif)

**기록.** 그날 확인된 결정 본문은 [`decisions.md`](../../examples/2026-08-23-delegation-day/decisions.md)에 있습니다. 예를 들어 DSH wave 결정은 "Superself ships a plugin, not a repo … within 7 days"라고 적혀 있고, 그 `why`에는 왜 그런지(list-of-record slot closed on launch day, plugin surface open)가 남아 있습니다.

**결과.** `self context`의 `Waiting on you`가 비고, 결정은 다음 세션의 `self context` 맨 위에 올라옵니다. 확인할 것: `self status`의 `waiting on you` 수가 0이 됐는지.

## 2단계. 브리프를 작업 단위로 쓰기

**운영자가 한 일.** 일 하나마다 `self work add "<필요한 결과>"`. 결과는 "무엇을 했다"가 아니라 "무엇이 어떤 상태가 되어 있다"로 씁니다. 그날의 여섯 줄 중 둘(원문 그대로):

```text
$ self work add "dsh-plugin-superself is public: installable with dsh plugin add from npm (dsh-plugin keyword, dsh.bundle manifest), exposes self context/work/report/decide as tools plus a slash command, its entry is merged in awesome-dsh-plugin under workflow, and it is announced in the DSH Discord — by 2026-08-30"
w-rwmxx
$ self work add "The adoption-metrics snapshot runs again daily and reads truthfully: the launchd job that stopped after 2026-08-17 is diagnosed and fixed with the cause recorded, …"
w-fvhq9
```

![self work 목록](../../examples/2026-08-23-delegation-day/tapes/work-list.gif)

**결과.** `self work`에 여섯 줄이 `next`로 섭니다. 확인할 것: 각 줄만 읽고도 끝난 상태를 그릴 수 있는지. 그릴 수 없으면 아직 브리프가 아닙니다.

## 3단계. 실행 전에 계획을 읽기

**에이전트가 한 일.** 브리프를 받은 에이전트는 바로 만들지 않고 먼저 조사 결과를 보고로 올렸습니다. w-fd2dg의 첫 보고(원문 일부):

```text
w-fd2dg step 1 — survey of six front-door lists (data pulled 2026-08-23 via `gh api`; no PR opened yet)
| repo | contribution rules | entry form | … | verdict |
| steipete/agent-rules | none; repo ARCHIVED 2026-05 | … | skip — read-only |
| github/awesome-copilot | … `npm run skill:validate`; PR to `main` … | skill folder | … | submit as skill |
| hesreallyhim/awesome-claude-code | "… must be created by human beings" | issue form | … | the maintainer must file the web form by hand |
```

**운영자가 한 일.** 표를 읽고 진행을 승인했습니다. w-rwmxx의 보고에 그 순간이 남아 있습니다: "User said proceed. The only blocker was CI verify on #321 …".

**결과.** 여섯 목표 중 둘(archived, off-topic)이 실행 전에 빠졌고, 사람만 낼 수 있는 폼 하나는 운영자 몫으로 넘어갔습니다. 확인할 것: `self work show w-fd2dg`에서 "no PR opened yet" 보고가 "step 3 complete: submissions opened" 보고보다 아래(먼저)에 있는지.

## 4단계. 위임하기

**에이전트가 한 일.** 각 워크트리의 세션이 `self work start <id>`로 단위를 잡았습니다. 그 순간부터 같은 단위를 다른 세션이 잡으려 하면 누가 쥐고 있는지 보입니다.

```text
$ self work show w-6h4es
held by another session, running since 2026-08-22 16:05
```

Orca 터미널에서 읽은 한 줄(w-6h4es, 원문): "PR #1이 열렸습니다. 마무리로 최종 self report·Orca 카드 갱신·로컬 서버 정리·임시 worktree 삭제를 한 번에 처리합니다."

**결과.** `self work`에서 여섯 줄이 `next`에서 `active`로 바뀝니다. 확인할 것: `self work show <id> --history`의 마지막 줄이 `entity.started`인지.

## 5단계. 증거가 붙은 보고를 받기

**에이전트가 한 일.** 체크포인트마다 `self report <id> "<무엇이 검증 가능하게 일어났나>" --evidence <commit>`. w-rwmxx의 보고 하나(원문 일부):

```text
- 2026-08-22 — PR #321 open: https://github.com/fxylabs/superself/pull/321 … All four root gates green locally: pnpm typecheck, pnpm build, pnpm test (cli 976 tests/0 fail + plugin 23/0), pnpm structure. … Unit is NOT done until publish + list merge. Friction: root test tier took ~25 min on this Mac, not the ~12 min CONTRIBUTING states; dsh plugin add needs --profile (no default) … [8ad441b]
```

보고마다 마찰 한 줄이 붙습니다. w-fvhq9: "Friction: expected a dead launchd job or a dirty tree; it was a swallowed non-fast-forward push that launchd reported as exit 0".

![self report와 self work show](../../examples/2026-08-23-delegation-day/tapes/intro.gif)

**결과.** `self work show`의 `Evidence:` 줄에 커밋이 쌓이고, 각 커밋에 판정이 붙습니다(`provisional` → `settled`, 브랜치에서 사라지면 `abandoned`). 확인할 것: 보고 끝의 `[8ad441b]`와 `Evidence:` 줄의 해시가 같은지.

## 6단계. 멈춤과 이탈을 기록으로 잡기

**무엇이 보이나.** 에이전트는 증거 없이 단위를 닫을 수 없고, 멈춘 단위와 버려진 커밋은 상태 화면에 뜹니다. 그날 실제로 찍힌 줄들:

```text
$ self work start w-t6vy1
- Not done yet: w-t6vy1 has no evidence for done — attach a report first (`self report w-t6vy1 "<summary>" --evidence <commit>` …)

$ self status --project superself
health: w-1aedt looks stalled — no events for 12 days; … w-64t76 evidence aa22c28 was reset away on its branch — that direction reads as attempted and abandoned; …
```

에이전트 쪽도 같은 규칙을 따릅니다. w-6h4es: "Not marked done — maintainer closes on merge." w-rwmxx: "Unit is NOT done until publish + list merge."

**결과.** 중간에 멈춘 단위는 `looks stalled`로, 방향을 바꾼 커밋은 `abandoned`로 읽힙니다. 확인할 것: `self status`의 `health:` 줄.

## 7단계. 다음 세션이 이어받게 하기

**운영자가 한 일.** 아무것도 하지 않았습니다. 다음 날 아무 세션이나 `self context`를 읽으면 여섯 단위가 마지막 보고와 함께 `Work in progress`에 있습니다(원문 일부):

```text
## Work in progress
- w-rwmxx dsh-plugin-superself is public: … [held by another session, running since 2026-08-22 15:25] — latest report: npm publish done by the maintainer: dsh-plugin-superself@0.1.0 is live … Remaining: the list maintainers merge #2761; …
- w-6h4es superselfs.com has a use-with guide generator: … — latest report: PR opened: … Gates: build green …
```

![self context](../../examples/2026-08-23-delegation-day/tapes/self-context.gif)

**결과.** 하루의 상태가 기록에 남아 있어, 다음 세션은 그것만 읽으면 됩니다. 확인할 것: `self context`의 각 줄에 `latest report:`가 붙어 있는지.

## 상태 diff

| | 아침(브리프 전) | 저녁(마지막 보고 후) |
| --- | --- | --- |
| 결정 | 제안 상태 | 결정 4건 확인(M1 front door, DSH wave, M4, M5), 컨벤션 1건(content loop v2) |
| 작업 단위 | 없음 | 6개, 모두 `active`, `held by another session` |
| 보고 | 0 | w-rwmxx 9, w-fd2dg 5, w-6h4es 2, w-qda0a 1, w-64t76 2, w-fvhq9 2 |
| 증거 | 없음 | 커밋 8개, 판정 포함(`settled` 1, `abandoned` 1) |
| 밖에 남은 것 | | PR #321 머지, #323 머지, #326 열림, superself-apps PR 2건 열림, awesome 리스트 PR 4건 열림, 채널 표 artifact 1건 |

## 다음 단계

- 다음 튜토리얼: 밀린 결정을 에이전트가 제안하고 운영자가 한 번에 정리하기 (준비 중).
- 개념: [Company State와 context](../concepts/company-state-and-context.md).
