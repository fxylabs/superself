# Content planning standard

- Status: working standard v0.3
- Last updated: 2026-08-24
- Korean: [content-planning.md](content-planning.md)
- Quality review: [content-quality-review.en.md](content-quality-review.en.md)

Plan every public content unit, including landing pages, marketing copy, email, documentation, tutorials, and updates, before choosing its title, drafting copy, or producing media. A content unit is one reader outcome rather than one file. Put the Korean brief in `docs/content-plans/<slug>.md` and the English counterpart in `<slug>.en.md`. Production starts only after the brief reaches `approved`.

The pair shares its status, revision, evidence, and decisions. Write and review the prose separately in each language. A brief begins with the problem the reader already has and decides what they should understand and try. It is not a document for steering the reader toward the product.

## One association across the portfolio

Different content can address different problems and cases, but it should reinforce one association instead of inventing a new product message each time.

Current portfolio hypothesis v0.1:

- Trigger: an AI agent acts against an earlier decision or produces a result that differs from the requirement.
- Association to establish: shared project state, meaning the current plan, decisions, progress, and result.
- Association: **Superself helps people and AI agents work from the same project state.**
- One sentence: **People and agents work from the same project state.**
- Product category: Company State Runtime. Do not describe Superself as a memory product.

Do not copy this wording into every piece. Use one real event and one record to establish the same association. Revise this hypothesis when reader responses and interviews show that another wording is understood more accurately.

## Five questions every brief answers

1. **What state is the reader in now?** Describe the tools they use, the task they want to complete, and what they know before encountering the product.
2. **What are they trying, and what problem do they face?** State observed behavior and its cost. Label behavior that has not been observed as a hypothesis.
3. **Why does it happen?** Separate the observed event from a proposed cause. Give every cause hypothesis the cheapest check that could disprove it.
4. **How do we solve it?** Describe the mechanism that changes the problem and the reader's new behavior, rather than listing features.
5. **How does the content lead to use?** Order recognition, cause, mechanism, action, and proof so the reader can understand and try the new behavior.

## Separate observations from inferences

Every brief includes this table.

| Type | What to record |
| --- | --- |
| Observation | A real statement, behavior, run record, number, and source |
| Inference | What the observation may mean and how many times it was observed |
| Disconfirming check | The cheapest question or action that could show the inference is wrong |

Do not turn one observation into a market-wide cause. Do not present unevidenced reader behavior as fact in the opening.

## Limit the message in one piece

Write one of each:

- what the reader thinks before seeing the content;
- the decision they should be able to make afterward;
- one sentence they should remember; and
- the real case that proves that sentence.

One piece does not explain the category, every feature, and several problems at once. Consistency comes from connecting each case to shared project state, not from repeating the same sentence.

## Approval, quality review, and evidence after publication

Briefs move through:

- `draft`: observations and hypotheses are still being assembled;
- `review`: the five questions and one remembered sentence can be reviewed;
- `approved`: the operator has accepted the plan, so copy and media production can start; and
- `superseded`: a later revision replaces it.

Approval means that the content has a coherent, evidenced, and testable plan. It does not prove that the finished content is easy or useful. Review produced content with [Content quality review standard](content-quality-review.en.md): record `revise` or `ready` before publication, then add `validated` only when real reader behavior has been observed.

Raise the revision and review again when the target state, cause hypothesis, mental position, or remembered sentence changes. Spelling and link fixes do not require a new revision. After publication, add observed questions, exits, retellings, and adoption behavior. A lack of response is an observation, not an explanation.

When replanning older content, keep the existing material and pause substantive edits until the brief is approved. The authoring agent never approves its own brief. A missing brief or one still in `review` stops production and publication review.

## Brief template

```markdown
# <Content title> content brief

- Status: draft | review | approved | superseded
- Revision: v0.1
- Owner:
- Last reviewed:
- Portfolio anchor revision: v0.1
- Quality review: pending | <path>

## Evidence and inferences
| Type | Claim | Source/count | Cheapest disconfirming check |

## 1. What state is the reader in now?
## 2. What are they trying, and what problem do they face?
## 3. Why does it happen?
## 4. How do we solve it?
## 5. How should the content lead to understanding and use?

## What the reader should retain
- Before:
- After:
- One sentence to remember:
- Proof:
- Link to the shared association:

## Scope
- Include:
- Exclude:

## Success checks
## Review questions
## Revision history
```

## Revision history

- v0.3, 2026-08-24: Applied the standard to every public content and marketing surface, with one reader outcome rather than one file as the content unit.
- v0.2, 2026-08-24: Separated brief approval, pre-publication readiness, and post-publication validation. Added the content quality review requirement and a full English counterpart.
- v0.1, 2026-08-24: First working standard for consumer-first content briefs.
