# Content guide · 콘텐츠 가이드

한국어 먼저, 영어는 아래에 있습니다. English follows the Korean section.

이 가이드는 Superself의 튜토리얼과 글을 쓰는 사람이 따르는 규칙입니다. 튜토리얼 형식, 시각 자료 규칙, 발행 전 체크리스트, 한국어 문장 규칙을 한 파일에 모았습니다. 상위 규칙은 content loop v2 컨벤션이며 `self context`로 읽습니다.

## 1. 튜토리얼 형식: 프롬프트 → 에이전트 기록 → 상태 변화

튜토리얼 하나는 시나리오 하나, 하네스 하나를 다룹니다. 독자는 읽는 사람이 아니라 따라 하는 사람입니다. 설명은 개념 문서(`docs/concepts/`)에 두고, 튜토리얼에는 행동과 결과만 남깁니다.

| 순서 | 섹션 | 내용 |
| --- | --- | --- |
| 1 | 제목 | 독자가 얻는 결과를 동사형으로 씁니다. 예: "에이전트 여섯에게 하루 일을 맡기고 상태로 확인하기" |
| 2 | 도착점 | 끝났을 때 보이는 화면을 먼저 보여 줍니다. 실제 `self` 출력 한 장 |
| 3 | 준비물 | 설치된 버전, 필요한 계정, 걸리는 시간 |
| 4 | 단계 1~7 | 단계마다 세 줄: 운영자가 보낸 프롬프트 또는 명령, 에이전트 기록 발췌, 그 결과로 바뀐 상태 |
| 5 | 상태 diff | 시작 전과 후의 `self work`, `self status` 차이를 표로 |
| 6 | 다음 단계 | 다음 튜토리얼 링크 하나, 관련 개념 문서 하나 |

단계 규칙

- 단계는 7개 이하, 한 단계 안의 하위 단계는 4개 이하입니다.
- 모든 단계는 눈에 보이는 결과로 끝납니다. 결과가 없는 단계는 지우거나 앞 단계에 합칩니다.
- 한 단계의 설명은 두 문장까지입니다. 더 필요하면 개념 문서로 링크합니다.
- 선택지와 대안은 쓰지 않습니다. 한 길만 보여 줍니다.
- 독자가 봐야 할 것을 짚어 줍니다. "여기서 `Waiting on you`에 한 줄이 생긴 것을 확인하세요"처럼 씁니다.
- 같은 단계를 다시 해도 같은 결과가 나와야 합니다. 시간이나 이 기계에만 있는 경로에 기대는 단계는 쓰지 않습니다.
- 프롬프트는 운영자가 실제로 보낸 문장을 그대로 둡니다. 다듬어 쓰면 기록이 아닙니다.

## 2. 시각 자료 규칙

| 장면 | 매체 | 출처 |
| --- | --- | --- |
| 에이전트 세션 | 실제 기록. asciinema 녹화 또는 Orca 터미널 읽기(`orca terminal read`) | 터미널 핸들과 읽은 시각을 examples/ README에 적습니다 |
| 운영자 장면(`self context`, `self decide confirm`, `self work`) | vhs 테이프. 격리된 스크래치 워크스페이스에서 `self project init`으로 만든 임시 프로젝트 | 테이프 파일을 발췌와 같은 디렉터리에 둡니다 |
| 상태 뷰 | 실제 `self` 출력. 손으로 고친 출력은 쓰지 않습니다 | 명령과 실행 시각을 함께 적습니다 |
| 2분 인트로 | vhs 테이프에서 자른 GIF 또는 MP4 | 원본 테이프 이름을 적습니다 |

- 발췌는 스크럽만 합니다. 토큰, 이메일, 내부 URL을 지우고 그 자리에 `<redacted>`를 씁니다. 문장을 고치거나 줄을 옮기지 않습니다.
- 발췌마다 출처 경로를 남깁니다. `self report` 기록인지, Orca 터미널 읽기인지, 어느 작업 단위인지 적습니다.
- 테이프는 상대 경로만 씁니다. 이 기계에만 있는 절대 경로가 들어간 테이프는 다시 녹화합니다.
- 터미널이 사라져 기록을 읽을 수 없으면 `self work show <id>`의 보고서 기록을 대신 씁니다. 출처에 그 사실을 적습니다.

## 3. 발행 전 체크리스트

- [ ] 논지는 운영자가 먼저 한두 문장으로 정했고, 초안은 그 뒤에 썼습니다.
- [ ] 채널 도달 테스트: 이 채널에 우리 계정의 도달 경로(팔로워, 들어가 있는 태그 피드, 게시 권한)가 있습니다. 없으면 mirror로 기록합니다.
- [ ] AI-tell 감사: 작성한 문장에는 em-dash가 없고, 대조 구문("A가 아니라 B")은 글 전체에서 하나까지이며, 문장 길이가 섞여 있습니다. 원문 발췌와 제품 출력은 고치지 않고 감사 대상에서 따로 셉니다.
- [ ] CLI 주장 검증: 글에 쓴 모든 명령과 옵션을 `self --help`와 실제 실행으로 확인했습니다.
- [ ] 스크럽: 발췌와 테이프에 `grep`을 돌려 이메일, 토큰, 내부 호스트가 없습니다.
- [ ] 실제 제품 출력만 썼습니다. 가공한 화면, 가상의 기록이 없습니다.
- [ ] 제품 언급은 검색형 글에서는 한 번까지입니다.
- [ ] 출처를 글 끝에 한 번씩 적었습니다.

## 4. 한국어 문장 규칙

토스 테크니컬 라이팅의 다섯 원칙을 그대로 씁니다.

| 원칙 | 규칙 | 예 |
| --- | --- | --- |
| 주체를 분명하게 | 행동의 주체는 독자입니다. 도구를 주어로 쓰지 않고, 능동형으로 씁니다 | "이 명령은 상태를 출력합니다" → "이 명령을 실행하면 상태를 볼 수 있습니다" |
| 필요한 정보만 | 한 문장에 생각 하나. 메타 담화("앞서 설명했듯이", "결론적으로")를 뺍니다 | "아시다시피 이 설정은 성능에 영향을 줍니다" → "이 설정은 성능에 영향을 줍니다" |
| 구체적으로 | 명사 대신 동사, 모호한 표현 대신 수치와 기준, 누가·무엇을·어디에·어떻게를 씁니다 | "데이터가 많으면 느려질 수 있습니다" → "10,000건을 넘으면 응답이 1초 이상 걸립니다" |
| 자연스러운 한국어 | "수행하다·진행하다" 같은 군더더기 한자어와 "~를 통해" 같은 번역체를 뺍니다 | "삭제 작업을 수행합니다" → "삭제합니다" |
| 일관되게 | 같은 개념은 한 단어로, 약어는 처음에 풀어 쓰고, 기술 용어는 공식 표기를 따릅니다 | "추가·첨부·넣기"를 섞지 않고 "업로드"로 통일 |

구조 규칙(토스 정보 구조)

- 한 페이지에서 하나만 다룹니다. 제목이 H4까지 깊어지면 문서를 나눕니다.
- 독자가 얻는 가치를 먼저, 배경과 세부 설정은 뒤에 둡니다.
- 제목에 핵심 키워드를 넣고, 같은 수준의 제목은 같은 꼴("~하기")로 씁니다.
- 개요는 제목 바로 아래에 두고 "이 문서를 읽으면 무엇을 할 수 있는가"에 답합니다.

### AI slop을 걷어내는 편집 순서

금칙어 목록만으로 문체를 만들지 않습니다. 아래 순서로 편집합니다.

1. 초안 전에 사실표를 만듭니다. 각 행에 주장, 근거가 된 실제 기록, 독자가 할 행동을 하나씩 적습니다.
2. 한국어와 영어는 서로 번역하지 않습니다. 같은 사실표를 보고 각 언어로 따로 씁니다.
3. 문단마다 새 사실, 명령, 출력 가운데 하나가 있어야 합니다. 셋 다 없으면 문단을 지웁니다.
4. 제품명을 다른 도구 이름으로 바꿔도 성립하는 문장은 지웁니다. 실제 사건, 수치, 명령으로 바꿀 수 있을 때만 남깁니다.
5. 같은 길이의 문장 세 개, 같은 문두의 반복, 근거 없는 3단 나열, 질문으로 시작하는 상투적 도입을 찾습니다.
6. 소리 내어 읽습니다. 한 번에 읽히지 않는 한국어 문장과 말로는 쓰지 않을 영어 표현을 고칩니다.
7. 마지막에만 금칙어와 구두점 검사를 돌립니다. 검사는 문체를 만들지 않고 남은 흔적만 찾습니다.

문체의 기준은 운영자의 실제 결정문, 프롬프트, 보고입니다. 원문의 짧고 구체적인 동사를 우선하고, 매끈하게 보이려고 원문에 없던 감정이나 확신을 보태지 않습니다.

---

# Content guide (English)

This is the house form for Superself tutorials and content pieces: the tutorial shape, the visual rules, the pre-publish checklist, and the sentence rules. The governing rule set is the content loop v2 convention, read with `self context`.

## 1. Tutorial form: prompt → agent record → state change

One tutorial covers one scenario on one harness. The reader follows along rather than reads. Explanation lives in `docs/concepts/`; the tutorial keeps actions and results.

| Order | Section | Content |
| --- | --- | --- |
| 1 | Title | The result the reader gets, in verb form. Example: "Hand a day's work to six agents and check it as state" |
| 2 | Destination | The screen the reader sees at the end, shown first. One real `self` output |
| 3 | Before you start | Installed versions, accounts needed, time it takes |
| 4 | Steps 1 to 7 | Each step has three parts: the prompt or command the operator sent, an excerpt from the agent's record, and the state that changed as a result |
| 5 | State diff | `self work` and `self status` before and after, as a table |
| 6 | Next steps | One link to the next tutorial, one to a concept page |

Step rules

- At most 7 steps, at most 4 sub-steps within a step.
- Every step ends with a visible result. A step without one is cut or merged into the previous step.
- At most two sentences of explanation per step. Link to a concept page for more.
- No options, no alternatives. Show one path.
- Point out what to notice: "check that one line appeared under `Waiting on you`".
- A step repeated gives the same result. Nothing depends on the clock or on a path that exists only on this machine.
- Prompts are the sentences the operator actually sent. A polished prompt is no longer a record.

## 2. Visual rules

| Scene | Medium | Source note |
| --- | --- | --- |
| Agent session | A real recording: asciinema, or an Orca terminal read (`orca terminal read`) | Terminal handle and read time go in the examples/ README |
| Operator scene (`self context`, `self decide confirm`, `self work`) | A vhs tape, recorded in an isolated scratch workspace created with `self project init` | The tape lives next to the excerpts |
| State view | Real `self` output, never hand-edited | Record the command and the time it ran |
| 2-minute intro | A GIF or MP4 cut from the vhs tapes | Name the source tapes |

- Excerpts are scrubbed only: tokens, emails and internal URLs become `<redacted>`. Sentences are not rewritten and lines are not reordered.
- Every excerpt names its source: a `self report`, an Orca terminal read, and which work unit.
- Tapes use relative paths only. A tape that carries an absolute path from this machine is re-recorded.
- When a terminal is gone, the report history from `self work show <id>` stands in, and the source note says so.

## 3. Pre-publish checklist

- [ ] The operator dictated the thesis in one or two sentences before drafting started.
- [ ] Channel reach test: our account has a reach path in this channel (followers, a tag feed we have entered, posting rights). A channel that fails is recorded as a mirror.
- [ ] AI-tell audit: authored prose has no em-dashes, at most one contrast construction ("not A but B"), and varied sentence lengths. Verbatim records and product output stay unchanged and are counted separately.
- [ ] CLI claims verified: every command and flag in the piece checked against `self --help` and a real run.
- [ ] Scrubbed: a `grep` over excerpts and tapes finds no emails, tokens, or internal hosts.
- [ ] Real product output only. No mock screens, no invented records.
- [ ] In search-led pieces the product is mentioned at most once.
- [ ] Sources are listed once at the end.

## 4. Sentence rules (English)

- Write for the person doing the task: say what they do and what they see. "Run this to see the state."
- One idea per sentence. Cut meta-talk ("as mentioned above", "in conclusion").
- Prefer verbs to noun chains, numbers to vague words, and name who does what where.
- Use one term per concept, expand an abbreviation on first use, follow official spelling of tool names.
- One page, one goal. Value first, background later. Keywords in headings, same grammatical form at the same level.

### Editing out AI slop

Do not build a voice from a banned-word list. Edit in this order:

1. Make a fact table before drafting. Each row holds one claim, the real record behind it, and one action for the reader.
2. Draft Korean and English separately from that table. Do not translate one draft into the other.
3. Keep a paragraph only if it adds a fact, a command, or an output.
4. Apply the swap test: if another product name fits without changing the sentence, cut it or replace it with concrete evidence.
5. Find repeated openings, evenly sized sentences, unsupported groups of three, and canned rhetorical questions.
6. Read the piece aloud. Rewrite anything you would not say to a colleague.
7. Run phrase and punctuation checks last. They catch residue; they do not create a voice.

Use the operator's decisions, prompts, and reports as the voice corpus. Prefer their short verbs and specific claims. Do not add confidence, emotion, or polish that the source record did not contain.

## Sources

- Toss technical writing: document types, information architecture, sentence rules. https://github.com/toss/technical-writing (docs/type, docs/architecture, docs/sentence)
- Diátaxis, tutorials. https://diataxis.fr/tutorials/
- The Good Docs Project, tutorial template. https://thegooddocsproject.dev/template/tutorial
- draft.dev, writing technical content. https://draft.dev/learn/technical-content
- Lee Robinson, developer marketing. https://leerob.com/blog/developer-marketing
- Superself content loop v2 convention, read with `self context`.
