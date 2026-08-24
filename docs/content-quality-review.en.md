# Content quality review standard

- Status: working standard v0.2
- Last updated: 2026-08-24
- Korean: [content-quality-review.md](content-quality-review.md)

## What this review checks

This review does not try to determine whether a person or AI wrote the content. It checks whether a defined reader can understand the content and use it to make a decision or complete a task.

- **Understandable:** After closing the page, the reader can describe their situation, the new action, and the expected result.
- **Useful:** The reader can make the intended decision or complete the supported path in a real task.
- **Accurate:** Claims, commands, and output match their source records. Observations and inferences remain distinct.
- **Focused:** Every sentence and visual helps the reader understand, act, or verify.

Short copy and simple words do not guarantee a pass. Removing necessary context and making the reader guess is a comprehension failure. AI detectors, banned-word counts, and readability scores are not acceptance evidence.

## Where it applies

Classify work by its effect on the reader, not by file type. The review covers:

- landing, home, product, feature, pricing, sales, contact, and campaign pages;
- public onboarding, email, calls to action, forms, and empty-state copy;
- tutorials, documentation, updates, articles, README files, release copy, and repository metadata;
- titles, summaries, search and social metadata, diagrams, images, animation, and video explanation or information order; and
- shared components that change copy, hierarchy, timing, or legibility across public surfaces.

Internal notes, unchanged product or terminal output, generated files, and code-only changes that cannot affect public meaning, order, legibility, or action are excluded. Content subject to legal, security, privacy, accessibility, or financial review must pass those separate gates as well.

A content unit is one reader outcome, not one file. If a landing page uses several components, metadata, and media, one brief lists every affected file and surface. A shared component that changes several reader outcomes requires each affected outcome to be reviewed.

Agents read the [content-quality-gate Skill](../.agents/skills/content-quality-gate/SKILL.md) before every content task.

## Fix the review scope first

Before reviewing, write one paragraph that names:

1. the target reader and their situation;
2. the one decision or action expected after reading;
3. the public files and production path that changed;
4. supported inputs, environment, and product version;
5. records and external boundaries that need verification; and
6. explicit exclusions and the stop condition for sufficient evidence.

A reviewer does not block publication on a new feature request, every theoretical edge case, or a full product explanation outside this scope. Reachable security, privacy, legal, financial, and irreversible data-loss risks remain blocking.

## Review procedure

### 1. Check the reader outcome

Find four statements in the brief. If any is missing, revise the brief before editing the copy.

- What is the reader trying to do now?
- Where do they get stuck?
- What should they decide or do differently after reading?
- Which real record supports that change?

### 2. Check claims against evidence

Mark every sentence that reads as fact and connect it to a source record. Label unobserved user behavior and causes as inferences, with an observation count and the cheapest check that could disprove them. Remove unsupported claims that do not help the reader act.

### 3. Give every sentence and visual a job

Assign one or more jobs to every title, sentence, table, code block, image, and video scene.

| Mark | Job | Review question |
| --- | --- | --- |
| `C` | Context | Does it help the reader recognize their situation? |
| `E` | Evidence | Does it let the reader verify a claim or result? |
| `A` | Action | Is the reader's next action clear? |
| `R` | Result | Can the reader tell what should appear after the action? |
| `D` | Decision | Does it help the reader choose the next step or judge completion? |

Remove or revise an item with no job. Keep one of two items that perform the same job with the same information. If a benefit claim still works after replacing the product name, keep it only when a real event, number, or command can make it specific.

### 4. Follow the supported path

Open the content at the width and playback speed the reader will see. Run commands again in the supported environment and compare the actual output with the explanation. A reviewer should find each action and result without adding an explanation.

### 5. Use a reviewer other than the author

Give the reviewer the target reader, supported scope, and expected result. Authorship is not a review question. The reviewer answers in their own words:

1. Whose situation does this content address?
2. What should the reader do differently?
3. Which statements are observations, and which are inferences?
4. What result tells the reader that the task worked?
5. Which sentence or scene could disappear without changing the outcome?

The authoring agent does not mark its own content `ready`.

### 6. Check with target readers

Test a new message, first tutorial, or new visual form with five target readers. For content that reuses a validated structure and changes only facts or commands, run the independent review and supported path by default. Repeat reader testing only where the change introduces new risk.

After readers close the content, observe whether they:

- recognize the problem as relevant to them;
- retell the core sequence in their own words;
- identify the first action and expected result;
- complete the supported path without extra explanation; and
- pause, reread, or form a different interpretation at the same point.

For a new message or format, four of five readers must explain the central decision and first action. For an executable tutorial, four of five must complete the supported path without extra explanation. Revise and retest when two readers fail at the same central point. A factual error or reproducibility failure blocks publication regardless of the count.

## Korean translation-pattern review

Write Korean and English separately from the same brief and fact table. Do not derive Korean by following the English sentences. Translation patterns become a content problem when English subjects, nominalizations, passive structures, or information order make a Korean reader reconstruct the meaning.

Check first for:

- passive sentences that hide the actor, including `~에 의해` and `~되어지다`;
- vague `하다` verbs such as `수행하다`, `진행하다`, `제공하다`, and `지원하다` where a specific action is available;
- repeated frames such as `~를 통해`, `~에 대한`, `~의 경우`, and `~하는 데 있어`;
- stacked possessives, `및`, and parenthetical explanations that mirror English noun phrases;
- conditions or conclusions placed so late that the action remains unclear until the end;
- repeated subjects and pronouns that Korean can omit without ambiguity; and
- Korean sentences that copy the count and order of the English version.

These patterns are prompts for review, not automatic failures. Rewrite the marked sentence in the words a target reader uses and with a more specific verb. Keep the version that reveals the meaning and action sooner.

For Korean:

1. Close the English draft. Write from the reader state, fact table, and actual commands.
2. Find who does what in each sentence. Put the actor first when the actor affects the decision.
3. Test specific action verbs in place of nominalized and passive forms.
4. Put conditions before actions and expected results immediately after commands.
5. Ask one target reader to retell the action they understood instead of asking whether the sentence felt awkward.
6. If Korean and English repeatedly have the same sentence count and connectors, check whether the separate-authoring rule was broken.

A translation-pattern list starts the review. The stronger evidence is that readers reread less, retell the same meaning, and complete the intended action.

## Verdicts and records

Do not use an average score. A high prose score can hide a factual error or failed command.

- `revise`: a central decision, fact, command, result, or supported path failed;
- `ready`: facts and execution match within scope, and the content passed independent review and any required reader check;
- `validated`: real reader understanding or use was observed after publication.

`approved` belongs to the brief. `ready` is the pre-publication verdict for produced content. `validated` records evidence after publication. One does not imply another.

Save each review as `docs/content-reviews/<slug>.<lang>.md`.

```markdown
# <Content> quality review

- Brief revision:
- Content commit:
- Reviewer:
- Reviewed at:
- Supported reader and path:
- Verdict: revise | ready | validated

## Review scope
## Claims and evidence
## Sentence and visual jobs
| Location | Job C/E/A/R/D | Reader value | Finding | Action |
## Supported-path run
## Independent reviewer answers
## Reader check
## Remaining hypotheses and next check
## Sufficient evidence and stop condition
```

## Improving this standard

Do not turn one document's issue into a rule for every piece. Fix the document and record the observation first. Propose a shared rule when the issue repeats across content or readers, or when a single failure has a high cost.

Record:

- the observation behind the change;
- how often, in which language, and in which format it occurred;
- the failure the new rule should prevent;
- the cheapest check that could disprove the rule; and
- an older rule that can be removed or narrowed.

Remove lints and rules that do not change review decisions. After publication, add observed questions, incorrect retellings, step exits, successful runs, and next actions.

## Sources consulted

- [National Institute of Korean Language, guide to easy public language](https://korean.go.kr/common/download.do?c_file_name=901b4032-ae19-4457-87b7-e0f61c04378e.pdf&file_path=etcData&o_file_name=%E2%98%85%EC%89%AC%EC%9A%B4_%EA%B3%B5%EA%B3%B5%EC%96%B8%EC%96%B4_%EC%93%B0%EA%B8%B0_%EA%B8%B0%EB%B3%B8_%EA%B8%B8%EC%9E%A1%EC%9D%B4.pdf): accuracy, ease, familiar terms, and sentence length
- [National Institute of Korean Language, public-language evaluation](https://korean.go.kr/common/download.do?c_file_name=a35ef634-52dc-47d6-9d86-0c9795dd8d33_0.pdf&file_path=reportData&o_file_name=2019%EB%85%84+%EC%A4%91%EC%95%99%ED%96%89%EC%A0%95%EA%B8%B0%EA%B4%80+%EA%B3%B5%EA%B3%B5%EC%96%B8%EC%96%B4+%EC%A7%84%EB%8B%A8+%EC%B5%9C%EC%A2%85+%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf): translation patterns and excessive passive or causative forms
- [Toss Technical Writing](https://github.com/toss/technical-writing): helping readers solve problems, natural Korean, and specific verbs
- [GOV.UK, Identify user needs](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/plan-manage-content/identify-user-needs/): begin with evidenced user needs
- [Google Developer Documentation Style Guide, Voice and tone](https://developers.google.com/style/tone): direct sentences, global readers, and reading aloud

## Revision history

- v0.2, 2026-08-24: Extended the gate to landing and marketing pages, email, metadata, and shared components. Defined one reader outcome rather than one file as the review unit and linked the reusable Skill.
- v0.1, 2026-08-24: First standard based on understanding, usefulness, accuracy, necessary information, and reader evidence.
