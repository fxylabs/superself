# Content guide · 콘텐츠 가이드

한국어판과 영어판은 같은 기준을 각각의 언어로 씁니다. The English guide follows the Korean guide.

이 문서는 Superself의 랜딩·마케팅 페이지, 이메일, 문서, 튜토리얼과 글을 만들 때 확인할 기준입니다. 무엇을 쓸지는 [콘텐츠 기획 기준](content-planning.md)에 따라 먼저 정합니다. 이 문서는 승인된 기획서를 실제 기록, 정보 순서, 문장, 시각 자료로 만드는 법을 다룹니다. 완성된 콘텐츠의 이해와 유용성은 [콘텐츠 품질 검토 기준](content-quality-review.md)으로 확인합니다. 프로젝트별 규칙은 `self context`에서 확인합니다.

## 1. 초안 전에 기획서 승인받기

모든 공개 콘텐츠는 `docs/content-plans/<slug>.md`에 기획서를 먼저 둡니다. 소비자의 제품과 무관한 상태, 현재 시도와 문제, 원인 가설, 해결 원리, 이해에서 채택까지의 순서를 적습니다. 관찰과 추론을 분리하고, 콘텐츠 하나가 소비자의 머릿속에 남길 자리와 한 문장을 하나씩만 정합니다.

기획서가 `review`이면 내용을 검토할 수 있지만 본문과 시각 자료를 새로 만들지 않습니다. 상태가 `approved`가 된 뒤 초안을 씁니다. 이 기준보다 먼저 만든 콘텐츠를 다시 기획할 때는 기존 자료를 유지하고, 승인 전까지 의미 있는 추가 수정만 멈춥니다. 타깃, 원인, 머릿속 자리, 기억할 문장이 바뀌면 revision을 올리고 다시 리뷰합니다.

## 2. 튜토리얼 형식: 프롬프트 → 에이전트 기록 → 상태 변화

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

## 3. 시각 자료 규칙

| 장면 | 매체 | 출처 |
| --- | --- | --- |
| 에이전트 실행 기록 | asciinema 녹화 또는 Orca 터미널 기록(`orca terminal read`) | 터미널 핸들과 기록을 읽은 시각을 examples/ README에 적습니다 |
| 사용자 명령 기록(`self context`, `self decide confirm`, `self work`) | 격리된 임시 프로젝트에서 만든 VHS 테이프 | 테이프 파일을 발췌와 같은 디렉터리에 둡니다 |
| 상태 출력 | 실제 `self` 출력. 문장이나 줄 순서를 고치지 않습니다 | 명령과 실행 시각을 함께 적습니다 |
| 설명 도식 | 실제 `work` 이력과 최종 상태에서 만든 역할·상태 그림 | 도식임을 밝히고 근거 기록을 적습니다. 제품 화면처럼 꾸미지 않습니다 |
| 시각 재생 | 실제 work 이력을 큰 문장과 상태 카드로 나눈 MP4 | 근거 기록, 화면 구성 파일, 렌더 명령, 재생 시간을 적습니다. 제품 화면이 아니라 설명 자료임을 밝힙니다 |

- 발췌에서는 토큰, 이메일, 내부 URL만 지웁니다. 지운 자리에는 `<redacted>`를 쓰고, 다른 문장이나 줄 순서는 손대지 않습니다.
- 발췌마다 출처를 남깁니다. `self report` 기록인지, Orca 터미널 기록인지, 어느 작업 단위인지 적습니다.
- 테이프는 상대 경로만 씁니다. 녹화한 기기에만 있는 절대 경로가 들어가면 다시 녹화합니다.
- 터미널이 사라져 기록을 읽을 수 없으면 `self work show <id>`의 보고서 기록을 대신 씁니다. 출처에 그 사실을 적습니다.
- 긴 계획과 보고가 흐르는 터미널 녹화는 실행 증거로만 둡니다. 독자용 재생물은 한 화면에 판단 하나만 두고, 본문 폭에서도 명령과 결과를 읽을 수 있게 만듭니다.
- 장면을 넘기기 전에 문장과 상태를 읽을 시간을 둡니다. 타이핑 시간을 줄이더라도 마지막 줄을 파악할 시간까지 줄이지 않습니다.

## 4. 발행 전 체크리스트

- [ ] `docs/content-plans/<slug>.md`가 있고 상태가 `approved`입니다.
- [ ] 기획서가 소비자의 상태와 문제에서 출발하며, 관찰과 원인 추론을 구분했습니다.
- [ ] 소비자의 머릿속에 남길 자리, 기억할 한 문장, 실제 증거가 각각 하나입니다.
- [ ] `docs/content-reviews/<slug>.<lang>.md`에 검토 범위와 근거가 있고 판정이 `ready`입니다.
- [ ] 독자는 콘텐츠를 덮은 뒤 자기 상황, 첫 행동, 확인할 결과를 자기 말로 설명할 수 있습니다. 새 메시지와 첫 형식은 정해진 타깃 독자 확인을 거쳤습니다.
- [ ] 올릴 채널에서 실제 독자에게 닿을 수 있습니다. 팔로워, 참여 중인 태그 피드, 게시 권한 중 하나도 없으면 `mirror`로 기록합니다.
- [ ] 표현 점검은 이해를 막는 문장만 찾는 보조 절차로 썼습니다. 금칙어가 없거나 AI 탐지기 점수가 낮다는 이유로 통과시키지 않았습니다.
- [ ] 한국어판은 영어판을 옮기지 않고 같은 사실표에서 따로 썼으며, 피동·명사화·영어식 정보 순서가 독자의 행동을 늦추지 않는지 확인했습니다.
- [ ] 명령 확인: 글에 쓴 모든 명령과 옵션을 `self --help`와 실제 실행으로 확인했습니다.
- [ ] 민감 정보 확인: 발췌와 테이프에 `grep`을 돌려 이메일, 토큰, 내부 호스트가 없는지 확인했습니다.
- [ ] 제품 출력은 실제 기록입니다. 설명 도식은 실제 기록을 근거로 만들었고 제품 화면처럼 보이게 꾸미지 않았습니다.
- [ ] 검색형 글에서는 제품명을 한 번만 언급했습니다.
- [ ] 글 끝에 출처 목록을 한 번만 뒀습니다.

## 5. 한국어 문장 규칙

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

### 쉽게 이해되고 실제로 쓸 수 있게 편집하기

목표는 사람처럼 보이는 문장이 아니라 독자가 자기 문제를 알아보고 필요한 행동을 끝내게 하는 문장입니다. 아래 순서로 편집하고, 전체 판정과 독자 확인은 [콘텐츠 품질 검토 기준](content-quality-review.md)에 따라 기록합니다.

1. 초안 전에 사실표를 만듭니다. 각 행에 주장, 근거가 된 실제 기록, 독자가 할 행동을 하나씩 적습니다.
2. 한국어와 영어는 서로 번역하지 않습니다. 같은 사실표를 보고 각 언어로 따로 씁니다.
3. 문단마다 새 사실, 명령, 출력 가운데 하나가 있어야 합니다. 셋 다 없으면 문단을 지웁니다.
4. 제품명을 다른 도구 이름으로 바꿔도 성립하는 문장은 지웁니다. 실제 사건, 수치, 명령으로 바꿀 수 있을 때만 남깁니다.
5. 독자가 보게 될 화면에서 명령과 결과를 따라가고, 각 단계가 행동과 확인으로 끝나는지 봅니다.
6. 한국어는 영어판을 닫고 다시 읽습니다. 피동문, 명사화, `~를 통해`, 영어식 문장 순서를 구체적인 주체와 동사로 고칩니다.
7. 소리 내어 읽고 대상 독자에게 무엇을 하라는 뜻으로 이해했는지 자기 말로 설명하게 합니다.
8. 마지막에만 반복 문두, 같은 문장 길이, 상투적 도입, 구두점을 찾습니다. 이 검사는 남은 후보를 찾을 뿐 통과를 증명하지 않습니다.

사용자의 실제 결정문, 프롬프트, 보고를 문체의 예로 삼습니다. 원문에 있는 짧고 구체적인 동사를 우선하고, 원문에 없던 감정이나 확신을 보태지 않습니다.

---

# Content guide (English)

Use [Content planning standard](content-planning.en.md) before drafting Superself landing and marketing pages, email, documentation, tutorials, or articles. This guide turns an approved brief into information order, prose, steps, and visual evidence. Use [Content quality review standard](content-quality-review.en.md) to check whether the finished content is understandable and useful. Run `self context` for rules specific to the current project.

## 1. Approve the brief before drafting

Every public piece starts with `docs/content-plans/<slug>.md`. The brief records the reader's product-independent state, current attempts and cost, cause hypotheses, the mechanism we offer, and the path from understanding to adoption. It separates observations from inferences and chooses one mental slot, one remembered sentence, and one record that proves it.

A brief in `review` can be reviewed, but it does not authorize new copy or media production. Draft only after it reaches `approved`. When replanning older content, keep existing material and pause substantive edits until approval. Raise the revision and review it again when the audience, cause, mental slot, or remembered sentence changes.

## 2. Tutorial form: prompt → agent record → state change

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

## 3. Visual rules

| Scene | Medium | Source note |
| --- | --- | --- |
| Agent run | An asciinema recording or output captured with `orca terminal read` | Put the terminal handle and read time in the examples/ README |
| Operator command (`self context`, `self decide confirm`, `self work`) | A VHS tape from an isolated temporary project | Store the tape beside the excerpts |
| State output | Unedited `self` output | Record the command and when it ran |
| Explanatory diagram | A role or state diagram derived from real work history | Label it as a diagram, cite the records, and do not imitate a product screen |
| Visual replay | An MP4 that turns real work history into large text and state cards | Name the source records, layout file, render command, and running time. Label it as explanatory media, not product UI |

- Remove only tokens, email addresses, and internal URLs from excerpts. Replace each removal with `<redacted>`; leave the other words and line order intact.
- For each excerpt, name the work unit and whether the source is `self report` or `orca terminal read`.
- Tapes use relative paths only. A tape that carries an absolute path from this machine is re-recorded.
- If the terminal no longer exists, use the report history from `self work show <id>` and say that you did so.
- Keep terminal recordings with long plans or reports as execution evidence. A reader-facing replay puts one decision on each screen and keeps its commands and results legible at article width.
- Time each screen for reading. Removing typing delays must not remove the pause a reader needs after the final line appears.

## 4. Pre-publish checklist

- [ ] `docs/content-plans/<slug>.md` exists and its status is `approved`.
- [ ] The brief starts from the reader's state and problem, and separates observation from causal inference.
- [ ] It names one mental slot, one remembered sentence, and one real record that proves it.
- [ ] `docs/content-reviews/<slug>.<lang>.md` records the review scope and evidence, with a `ready` verdict.
- [ ] After closing the content, the reader can explain their situation, first action, and expected result. A new message or format has completed the required target-reader check.
- [ ] The intended channel can reach readers through followers, an account active in a relevant tag feed, or posting access. Otherwise, mark the publication as a `mirror`.
- [ ] Expression lint was used only to find wording that blocks understanding. No AI-detector result or clean banned-word scan was treated as acceptance evidence.
- [ ] Korean was drafted separately from the shared facts, and passive forms, nominalizations, and English information order do not delay the reader's action.
- [ ] Every command and flag was checked against `self --help` and a real run.
- [ ] A `grep` over excerpts and tapes finds no email addresses, tokens, or internal hosts.
- [ ] Product output comes from a real run. Any explanatory diagram cites real records and does not imitate the product UI.
- [ ] A search-driven article mentions the product no more than once.
- [ ] One source list appears at the end.

## 5. Sentence rules (English)

- Address the reader directly. Say what to run and what result to look for.
- One idea per sentence. Cut meta-talk ("as mentioned above", "in conclusion").
- Prefer verbs to noun chains, numbers to vague words, and name who does what where.
- Use one term per concept, expand an abbreviation on first use, and follow the official spelling of tool names.
- Keep one reader outcome per page. State that outcome before the background. Use parallel grammar for headings at the same level.

### Edit for understanding and use

The goal is not prose that appears human. The reader should recognize their problem and complete the intended action. Use these edits, then record the full verdict and reader evidence with [Content quality review standard](content-quality-review.en.md).

1. Start with a fact table. For each claim, name the real record and the action the reader will take.
2. Draft English from the facts, not from the Korean sentences. Write the Korean version from the same evidence in a separate pass.
3. Delete any paragraph that adds no fact, command, or output.
4. Replace sentences that still work with another product name. Keep the sentence only when a real event, number, or command makes it specific.
5. Follow the commands and results in the viewport the reader will use. Check that every step ends with an action and a visible result.
6. Review Korean with the English draft closed. Replace passive forms, nominalizations, repeated connective frames, and English information order with a specific actor and verb.
7. Read the draft aloud, then ask a target reader to retell the action they understood.
8. Only then check repeated openings, uniform sentence lengths, unsupported lists, stock questions, and punctuation. These checks find candidates; they do not prove quality.

Use the operator's decisions, prompts, and reports as examples of tone. Keep their short verbs and specific claims. Do not add confidence or emotion that is absent from the record.

## Sources

- Toss technical writing: document types, information architecture, sentence rules. https://github.com/toss/technical-writing (docs/type, docs/architecture, docs/sentence)
- Diátaxis, tutorials. https://diataxis.fr/tutorials/
- The Good Docs Project, tutorial template. https://thegooddocsproject.dev/template/tutorial
- draft.dev, writing technical content. https://draft.dev/learn/technical-content
- Lee Robinson, developer marketing. https://leerob.com/blog/developer-marketing
- Superself content loop v2 convention, read with `self context`.
- National Institute of Korean Language, easy public language and public-language evaluation. https://www.korean.go.kr/
- GOV.UK, identify user needs. https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/plan-manage-content/identify-user-needs/
- Google Developer Documentation Style Guide, voice and tone. https://developers.google.com/style/tone
