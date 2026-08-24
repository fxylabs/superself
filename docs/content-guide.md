# Content guide · 콘텐츠 가이드

한국어판과 영어판은 같은 기준을 각각의 언어로 씁니다. The English guide follows the Korean guide.

이 문서는 Superself 튜토리얼과 글을 만들 때 확인할 기준입니다. 실제 기록을 골라 독자가 따라 할 단계로 만드는 법을 다룹니다. 시각 자료의 출처와 발행 전 확인 항목은 뒤에서 따로 설명합니다. 프로젝트별 규칙은 `self context`에서 확인합니다.

## 1. 튜토리얼 형식: 프롬프트 → 에이전트 기록 → 상태 변화

튜토리얼 하나에서는 실제 작업 하나와 에이전트 도구 하나만 다룹니다. 독자가 명령을 그대로 실행하고 같은 결과를 확인할 수 있게 씁니다. 배경 설명은 개념 문서(`docs/concepts/`)에 두고, 튜토리얼에는 행동과 결과를 남깁니다.

| 순서 | 섹션 | 내용 |
| --- | --- | --- |
| 1 | 제목 | 독자가 얻는 결과를 동사형으로 씁니다. 예: "에이전트의 계획을 검토하고 결과 확인하기" |
| 2 | 완료 후 확인할 것 | 마지막에 확인할 상태를 먼저 보여 줍니다. 실제 `self` 출력 한 장을 씁니다 |
| 3 | 시작 전 준비 | 설치된 버전, 필요한 계정, 걸리는 시간 |
| 4 | 단계 1~7 | 단계마다 사용자의 명령, 에이전트 기록, 바뀐 상태를 보여 줍니다 |
| 5 | 상태 변화 | 시작 전과 후의 `self work`, `self status` 차이를 표로 정리합니다 |
| 6 | 다음 단계 | 다음 튜토리얼 링크 하나, 관련 개념 문서 하나 |

### 단계 규칙

- 단계는 7개를 넘기지 않습니다. 한 단계 안의 하위 단계는 4개까지 둡니다.
- 모든 단계는 눈에 보이는 결과로 끝납니다. 결과가 없는 단계는 지우거나 앞 단계에 합칩니다.
- 한 단계의 설명은 두 문장까지입니다. 더 필요하면 개념 문서로 링크합니다.
- 튜토리얼에서는 성공 경로 하나만 보여 줍니다. 선택지와 대안은 관련 개념 문서에 둡니다.
- 독자가 봐야 할 것을 짚어 줍니다. "여기서 `Waiting on you`에 한 줄이 생긴 것을 확인하세요"처럼 씁니다.
- 같은 단계를 다시 해도 같은 결과가 나와야 합니다. 시간이나 이 기계에만 있는 경로에 기대는 단계는 쓰지 않습니다.
- 프롬프트는 사용자가 실제로 보낸 문장을 그대로 둡니다. 다듬어 쓰면 기록이 아닙니다.

## 2. 시각 자료 규칙

| 장면 | 매체 | 출처 |
| --- | --- | --- |
| 에이전트 실행 기록 | asciinema 녹화 또는 Orca 터미널 기록(`orca terminal read`) | 터미널 핸들과 기록을 읽은 시각을 examples/ README에 적습니다 |
| 사용자 명령 기록(`self context`, `self decide confirm`, `self work`) | 격리된 임시 프로젝트에서 만든 VHS 테이프 | 테이프 파일을 발췌와 같은 디렉터리에 둡니다 |
| 상태 출력 | 실제 `self` 출력. 문장이나 줄 순서를 고치지 않습니다 | 명령과 실행 시각을 함께 적습니다 |
| 설명 도식 | 실제 `work` 이력과 최종 상태에서 만든 역할·상태 그림 | 도식임을 밝히고 근거 기록을 적습니다. 제품 화면처럼 꾸미지 않습니다 |
| 짧은 실행 영상 | VHS 테이프에서 자른 GIF 또는 MP4 | 원본 테이프 이름과 재생 시간을 적습니다 |

- 발췌에서는 토큰, 이메일, 내부 URL만 지웁니다. 지운 자리에는 `<redacted>`를 쓰고, 다른 문장이나 줄 순서는 손대지 않습니다.
- 발췌마다 출처를 남깁니다. `self report` 기록인지, Orca 터미널 기록인지, 어느 작업 단위인지 적습니다.
- 테이프는 상대 경로만 씁니다. 녹화한 기기에만 있는 절대 경로가 들어가면 다시 녹화합니다.
- 터미널이 사라져 기록을 읽을 수 없으면 `self work show <id>`의 보고서 기록을 대신 씁니다. 출처에 그 사실을 적습니다.

## 3. 발행 전 체크리스트

- [ ] 글의 핵심 주장을 사용자가 한두 문장으로 먼저 정했습니다.
- [ ] 올릴 채널에서 실제 독자에게 닿을 수 있습니다. 팔로워, 참여 중인 태그 피드, 게시 권한 중 하나도 없으면 `mirror`로 기록합니다.
- [ ] AI 문체 점검: 작성한 문장에는 긴 대시(em dash)가 없고, "A가 아니라 B" 형식은 글 전체에서 한 번 이하이며, 문장 길이가 한 가지로 반복되지 않습니다. 원문 발췌와 제품 출력은 이 점검에서 제외합니다.
- [ ] 명령 확인: 글에 쓴 모든 명령과 옵션을 `self --help`와 실제 실행으로 확인했습니다.
- [ ] 민감 정보 확인: 발췌와 테이프에 `grep`을 돌려 이메일, 토큰, 내부 호스트가 없는지 확인했습니다.
- [ ] 제품 출력은 실제 기록입니다. 설명 도식은 실제 기록을 근거로 만들었고 제품 화면처럼 보이게 꾸미지 않았습니다.
- [ ] 검색형 글에서는 제품명을 한 번만 언급했습니다.
- [ ] 글 끝에 출처 목록을 한 번만 뒀습니다.

## 4. 한국어 문장 규칙

다음 다섯 원칙은 토스 테크니컬 라이팅을 바탕으로 정리했습니다.

| 원칙 | 규칙 | 예 |
| --- | --- | --- |
| 주체를 분명하게 | 행동의 주체는 독자입니다. 도구를 주어로 쓰지 않고, 능동형으로 씁니다 | "이 명령은 상태를 출력합니다" → "이 명령을 실행하면 상태를 볼 수 있습니다" |
| 필요한 정보만 | 한 문장에 생각 하나. 메타 담화("앞서 설명했듯이", "결론적으로")를 뺍니다 | "아시다시피 이 설정은 성능에 영향을 줍니다" → "이 설정은 성능에 영향을 줍니다" |
| 구체적으로 | 명사 대신 동사, 모호한 표현 대신 수치와 기준, 누가·무엇을·어디에·어떻게를 씁니다 | "데이터가 많으면 느려질 수 있습니다" → "10,000건을 넘으면 응답이 1초 이상 걸립니다" |
| 자연스러운 한국어 | "수행하다·진행하다" 같은 군더더기 한자어와 "~를 통해" 같은 번역체를 뺍니다 | "삭제 작업을 수행합니다" → "삭제합니다" |
| 일관되게 | 같은 개념은 한 단어로, 약어는 처음에 풀어 쓰고, 기술 용어는 공식 표기를 따릅니다 | "추가·첨부·넣기"를 섞지 않고 "업로드"로 통일 |

### 문서 구조

- 한 페이지에서는 독자가 얻을 결과 하나만 다룹니다. 제목이 H4까지 깊어지면 문서를 나눕니다.
- 제목 다음 문단에서 독자가 얻게 될 결과를 말합니다. 배경과 세부 설정은 뒤에 둡니다.
- 제목에 핵심 키워드를 넣고, 같은 수준의 제목은 같은 꼴("~하기")로 씁니다.
- 개요는 제목 바로 아래에 두고 "이 문서를 읽으면 무엇을 할 수 있는가"에 답합니다.

### AI 문체를 걷어내는 편집 순서

금칙어 목록만으로 문체를 만들지 않습니다. 아래 순서로 편집합니다.

1. 초안 전에 사실표를 만듭니다. 각 행에 주장, 근거가 된 실제 기록, 독자가 할 행동을 하나씩 적습니다.
2. 한국어와 영어는 서로 번역하지 않습니다. 같은 사실표를 보고 각 언어로 따로 씁니다.
3. 문단마다 새 사실, 명령, 출력 가운데 하나가 있어야 합니다. 셋 다 없으면 문단을 지웁니다.
4. 제품명을 다른 도구 이름으로 바꿔도 성립하는 문장은 지웁니다. 실제 사건, 수치, 명령으로 바꿀 수 있을 때만 남깁니다.
5. 같은 길이의 문장 세 개, 같은 문두의 반복, 근거 없는 3단 나열, 질문으로 시작하는 상투적 도입을 찾습니다.
6. 소리 내어 읽습니다. 한 번에 읽히지 않는 한국어 문장과 말로는 쓰지 않을 영어 표현을 고칩니다.
7. 마지막에만 금칙어와 구두점 검사를 돌립니다. 검사는 문체를 만들지 않고 남은 흔적만 찾습니다.

사용자의 실제 결정문, 프롬프트, 보고를 문체의 예로 삼습니다. 원문에 있는 짧고 구체적인 동사를 우선하고, 원문에 없던 감정이나 확신을 보태지 않습니다.

---

# Content guide (English)

Use this guide when writing or reviewing a Superself tutorial or article. It explains which records belong in a tutorial and how to turn them into steps a reader can follow. A separate section covers visual evidence. The last section is the pre-publish review. Run `self context` for rules specific to the current project.

## 1. Tutorial form: prompt → agent record → state change

Build each tutorial around one real task and one agent interface. Give the reader commands they can run and results they can recognize. Put background material in `docs/concepts/`.

| Order | Section | Content |
| --- | --- | --- |
| 1 | Title | Name the result with a verb. Example: "Review an agent's plan before it starts" |
| 2 | What you'll see | Show the final state first with one unedited `self` output |
| 3 | Before you start | Installed versions, accounts needed, time it takes |
| 4 | Steps 1 to 7 | Show the operator command, the agent record, and the resulting state change |
| 5 | State changes | Compare `self work` and `self status` before and after in a table |
| 6 | Next steps | One link to the next tutorial, one to a concept page |

### Step rules

- Keep the tutorial to seven steps or fewer, with no more than four actions in one step.
- Every step ends with a visible result. If it has none, remove the step or merge it with the previous one.
- Keep the explanation in each step to two sentences. Link to a concept page for more.
- Show one successful path. Put alternatives in a concept page.
- Point out what to notice: "check that one line appeared under `Waiting on you`".
- A reader who repeats a step should see the same result. Do not rely on the clock or a path that exists only on the recording machine.
- Quote the prompt exactly. Editing it would misrepresent the run.

## 2. Visual rules

| Scene | Medium | Source note |
| --- | --- | --- |
| Agent run | An asciinema recording or output captured with `orca terminal read` | Put the terminal handle and read time in the examples/ README |
| Operator command (`self context`, `self decide confirm`, `self work`) | A VHS tape from an isolated temporary project | Store the tape beside the excerpts |
| State output | Unedited `self` output | Record the command and when it ran |
| Explanatory diagram | A role or state diagram derived from real work history | Label it as a diagram, cite the records, and do not imitate a product screen |
| Short walkthrough | A GIF or MP4 cut from a VHS tape | Name the source tape and give the running time |

- Remove only tokens, email addresses, and internal URLs from excerpts. Replace each removal with `<redacted>`; leave the other words and line order intact.
- For each excerpt, name the work unit and whether the source is `self report` or `orca terminal read`.
- Tapes use relative paths only. A tape that carries an absolute path from this machine is re-recorded.
- If the terminal no longer exists, use the report history from `self work show <id>` and say that you did so.

## 3. Pre-publish checklist

- [ ] Before drafting, the operator stated the point in one or two sentences.
- [ ] The intended channel can reach readers through followers, an account active in a relevant tag feed, or posting access. Otherwise, mark the publication as a `mirror`.
- [ ] AI-writing check: your prose has no em dash, uses no more than one "not A but B" construction, and varies sentence length. Do not count exact quotes or product output.
- [ ] Every command and flag was checked against `self --help` and a real run.
- [ ] A `grep` over excerpts and tapes finds no email addresses, tokens, or internal hosts.
- [ ] Product output comes from a real run. Any explanatory diagram cites real records and does not imitate the product UI.
- [ ] A search-driven article mentions the product no more than once.
- [ ] One source list appears at the end.

## 4. Sentence rules (English)

- Address the reader directly. Say what to run and what result to look for.
- One idea per sentence. Cut meta-talk ("as mentioned above", "in conclusion").
- Prefer verbs to noun chains, numbers to vague words, and name who does what where.
- Use one term per concept, expand an abbreviation on first use, and follow the official spelling of tool names.
- Keep one reader outcome per page. State that outcome before the background. Use parallel grammar for headings at the same level.

### Editing out AI slop

Do not begin with a banned-word search. Work through these edits first and check phrases and punctuation at the end.

1. Start with a fact table. For each claim, name the real record and the action the reader will take.
2. Draft English from the facts, not from the Korean sentences. Write the Korean version from the same evidence in a separate pass.
3. Delete any paragraph that adds no fact, command, or output.
4. Replace sentences that still work with another product name. Keep the sentence only when a real event, number, or command makes it specific.
5. Read the draft aloud and rewrite anything you would not say to a colleague.
6. Only then check repeated openings, uniform sentence lengths, unsupported lists, stock questions, and punctuation.

Use the operator's decisions, prompts, and reports as examples of tone. Keep their short verbs and specific claims. Do not add confidence or emotion that is absent from the record.

## Sources

- Toss technical writing: document types, information architecture, sentence rules. https://github.com/toss/technical-writing (docs/type, docs/architecture, docs/sentence)
- Diátaxis, tutorials. https://diataxis.fr/tutorials/
- The Good Docs Project, tutorial template. https://thegooddocsproject.dev/template/tutorial
- draft.dev, writing technical content. https://draft.dev/learn/technical-content
- Lee Robinson, developer marketing. https://leerob.com/blog/developer-marketing
- Superself content loop v2 convention, read with `self context`.
