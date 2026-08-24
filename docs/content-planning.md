# 콘텐츠 기획 기준 · Content planning standard

상태: working standard v0.1

최종 수정: 2026-08-24

공개 콘텐츠는 제목, 초안, 영상보다 기획서가 먼저입니다. 각 콘텐츠는 `docs/content-plans/<slug>.md`에 기획서를 두고 `approved`가 된 뒤 제작합니다. 기획서는 독자를 제품으로 데려오기 위한 설명서가 아니라, 독자가 이미 겪는 문제에서 출발해 무엇을 이해하고 시도해야 하는지 정하는 문서입니다.

## 모든 콘텐츠가 남길 하나의 자리

콘텐츠마다 새 메시지를 만들지 않습니다. 서로 다른 문제와 사례를 다루더라도 소비자의 머릿속에는 같은 연상이 남아야 합니다.

현재 작업 가설 v0.1:

- 문제를 떠올리는 순간: AI 에이전트가 이전 결정과 다르게 움직이거나 요구와 다른 결과를 냈을 때
- 비어 있는 자리: 함께 확인하는 프로젝트 상태. 현재 계획, 결정, 진행, 결과를 뜻합니다
- 남길 연상: **Superself = 사람과 AI 에이전트가 같은 프로젝트 상태를 보고 일하게 하는 도구**
- 한 문장: **사람과 에이전트가 같은 프로젝트 상태를 보고 일한다.**
- 제품 범주: Company State Runtime. Superself를 메모리 도구로 설명하지 않습니다.

이 문구를 모든 글에 그대로 복사하지 않습니다. 같은 연상을 각 콘텐츠의 실제 사건 하나와 증거 하나로 보여 줍니다. 이 작업 가설은 독자 반응과 인터뷰에서 다른 표현이 더 잘 이해된다는 증거가 쌓이면 개정합니다.

## 기획서가 답할 다섯 질문

1. **소비자는 지금 어떤 상태인가?** 제품을 모르는 상태에서 사용하는 도구, 하려는 일, 알고 있는 것과 모르는 것을 적습니다.
2. **무엇을 시도하고 어떤 문제를 겪는가?** 소비자가 실제로 하는 행동과 그 뒤에 생기는 비용을 적습니다. 관찰하지 않은 행동은 가설로 표시합니다.
3. **왜 그런 일이 벌어지는가?** 관찰된 사건과 원인 해석을 분리합니다. 원인 가설마다 가장 싼 반증 방법을 붙입니다.
4. **우리는 어떻게 해결하는가?** 기능 목록 대신 문제를 바꾸는 작동 원리와 소비자의 새 행동을 적습니다.
5. **튜토리얼에서 어떻게 이해와 채택으로 이어지게 하는가?** 알아봄 → 원인 이해 → 작동 원리 → 직접 실행 → 증거 확인의 순서를 정합니다.

## 관찰과 추론을 분리하기

기획서는 아래 표를 반드시 포함합니다.

| 구분 | 적을 것 |
| --- | --- |
| 관찰 | 실제 발언, 행동, 실행 기록, 수치, 출처 |
| 추론 | 관찰이 뜻한다고 보는 것, 관찰 횟수 |
| 반증 확인 | 추론이 틀렸음을 가장 싸게 확인할 질문이나 행동 |

관찰 한 건을 시장 전체의 원인으로 쓰지 않습니다. 증거가 없는 소비자 행동은 사실처럼 도입부에 넣지 않습니다.

## 한 콘텐츠의 메시지 범위

기획서에는 다음 네 줄을 한 개씩만 둡니다.

- 소비자가 콘텐츠를 보기 전에 하는 생각
- 보고 난 뒤 새로 할 수 있어야 하는 판단
- 기억할 한 문장
- 그 문장을 증명할 실제 사례

한 콘텐츠가 제품 범주, 전체 기능, 여러 문제를 동시에 설명하지 않게 합니다. 일관성은 같은 문장을 반복하는 것이 아니라, 각 콘텐츠가 같은 프로젝트 상태라는 자리로 이어지는 것입니다.

## 승인과 개정

기획서 상태는 다음 순서로 바뀝니다.

- `draft`: 관찰과 가설을 채우는 중
- `review`: 다섯 질문과 한 문장이 검토 가능한 상태
- `approved`: 운영자가 승인해 제목, 본문, 시각 자료를 만들 수 있음
- `superseded`: 새 revision이 대신함

타깃 상태, 원인 가설, 머릿속 자리, 기억할 문장 가운데 하나가 바뀌면 revision을 올리고 다시 리뷰합니다. 맞춤법이나 링크 수정은 revision을 올리지 않습니다. 발행 뒤에는 질문, 댓글, 이탈 지점, 채택 행동을 관찰에 추가합니다. 반응이 없다는 사실도 기록하되 원인을 추측해 사실처럼 쓰지 않습니다.

이 기준을 적용하기 전에 만들어진 콘텐츠를 다시 기획할 때는 기존 자료를 지우지 않습니다. 기획서가 `approved`가 될 때까지 의미 있는 추가 수정만 멈춥니다.

작성 에이전트는 자신이 쓴 기획서를 `approved`로 바꾸지 않습니다. 기획서가 없거나 `review`에 머물러 있으면 공개 콘텐츠 제작과 발행 리뷰를 멈춥니다.

## 기획서 템플릿

```markdown
# <콘텐츠 제목> 기획서

- Status: draft | review | approved | superseded
- Revision: v0.1
- Owner:
- Last reviewed:
- Portfolio anchor revision: v0.1

## 관찰과 추론
| 종류 | 내용 | 출처/횟수 | 가장 싼 반증 확인 |

## 1. 소비자는 지금 어떤 상태인가?
## 2. 무엇을 시도하고 어떤 문제를 겪는가?
## 3. 왜 그런 일이 벌어지는가?
## 4. 우리는 어떻게 해결하는가?
## 5. 어떻게 이해와 채택으로 이어지게 하는가?

## 소비자의 머릿속에 남길 자리
- 보기 전 생각:
- 보고 난 뒤 판단:
- 기억할 한 문장:
- 실제 증거:
- 공통 연상과의 연결:

## 범위
- 포함:
- 제외:

## 성공 확인
## 리뷰 질문
## Revision history
```

---

All public content starts with a brief in `docs/content-plans/<slug>.md`. Drafting and media production begin only after the brief reaches `approved`.

Every brief answers the same five questions: the reader's product-independent state; what they try and where it fails; why it happens; the mechanism and new behavior we offer; and the path from recognition to understanding, action, proof, and adoption. Keep observations separate from inferences. Give each inference its observation count and the cheapest check that could disprove it.

The current portfolio hypothesis is one association: **Superself helps people and AI agents work from the same project state.** Each piece uses one situation and one record to reinforce that association. Do not repeat the sentence mechanically, and do not describe Superself as a memory product.

Briefs move through `draft`, `review`, `approved`, and `superseded`. A change to the audience state, cause, mental slot, or one remembered sentence requires a new revision and another review. After publication, add observed questions, exits, and adoption behavior. Treat a lack of response as an observation, not an explanation.

When replanning content made before this standard, keep the existing material but pause substantive edits until the brief is approved.
The authoring agent never approves its own brief. A missing brief or one still in `review` stops production and publication review.
