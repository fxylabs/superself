# Tutorial 1 content brief: Review the plan before execution

- Status: review
- Revision: v0.1
- Owner: Superself
- Last reviewed: Not reviewed yet
- Portfolio anchor revision: v0.1
- Planned content: `docs/tutorials/review-one-work.ko.md`, `docs/tutorials/review-one-work.md`
- Quality review: pending until the brief is approved and the tutorial is revised
- Korean: [review-one-work.md](review-one-work.md)

## Evidence and inferences

| Type | Claim | Source/count | Cheapest disconfirming check |
| --- | --- | --- | --- |
| Observation | Two possible audiences were identified: people struggling with agent output that differs from their requirements, and people who do not know how to work with an agent | Operator decision, 2026-08-24, once | Operator review |
| Observation | In the actual `w-cs7dj` run, v1 had conflicting discovery scope and omitted the fragment-handling rule. The review found both issues before execution | `examples/2026-08-24-one-work-review/review.md` | Compare the original review with the work history |
| Observation | v2 was recorded under the same work ID, then accepted, started, reported, and completed after a second review | `work-history.txt`, `work-final.txt` | Check the event order |
| Inference | Some users respond by writing longer prompts or reviewing only the diff after implementation | No direct observations | Ask five target users to recount their latest agent task in chronological order |
| Inference | The cost of a mismatch grows when the plan exists only in chat, with no separate pre-execution review point or accepted version | Plan defects found in one actual run | Run three comparable tasks with plan review and three without it, then compare the number of corrections |
| Inference | Beginners understand the process more easily when they see who decides what and when before they see commands | No direct observations | Ask three people who see the role sequence first and three who see commands first to explain the process back |
| Inference | Finding the two v1 defects after implementation would have caused rework | No observed rework because execution was blocked | Inspect three similar jobs where defects were found after implementation |

The current evidence does not support a broad claim about why agent work fails across the market. The tutorial will state only what the recorded run shows and what the reader can do.

## 1. What state is the reader in now?

- The primary reader has redone an agent's work at least once because the result differed from the requirement.
- The secondary reader is ready to delegate work from an editor or terminal but does not know what to review or when to review it.
- They may know the common pattern where an agent starts implementation immediately. They may not know a process in which the plan is recorded and accepted as part of the project state.
- When the result is wrong, they lack a clear checkpoint for deciding what should have been reviewed earlier.
- The tutorial assumes no prior knowledge of Superself or Company State Runtime.

## 2. What are they trying, and what problem do they face?

The recorded problem is specific: v1 of the actual run had a conflicting implementation scope and omitted the rule for handling fragments. The cost of finding those defects after implementation was not observed, so it remains a hypothesis.

Longer prompts, extra instructions to "be careful," and post-implementation diff reviews are also hypotheses. Until we observe these behaviors, the opening will not present them as universal habits.

## 3. Why does this happen?

This tutorial addresses three narrow conditions:

- The plan is not preserved as project state that a person can review before implementation.
- The agent can start from a plan that no one has reviewed.
- The original plan, accepted revision, and implementation report are not connected by one work ID.

In the `w-cs7dj` run, `work propose` placed the plan in review and the start gate addressed the first two conditions. A revision and report under the same ID addressed the third. The tutorial will not present these conditions as the cause of every agent failure.

## 4. How do we solve it?

The person and the agent work from the same work record.

1. Before implementation, the agent records the complete plan with `work propose`.
2. The person or a separate review agent reads the plan.
3. If the review finds a defect, the plan is corrected under the same ID with `work revise`.
4. Only the reviewed revision is confirmed with `work confirm` — by the person, or by the session once the person has said yes in the conversation — and then the agent starts.
5. The agent reports the commit and checks. The person uses that evidence to decide whether the work is complete.

The tutorial teaches manual review for one task that requires judgment. It does not set a policy that every routine task must wait for individual human approval.

## 5. How should the tutorial lead to understanding and adoption?

Use the reader's decision sequence:

1. **Recognition:** A missing requirement found after implementation can mean redoing completed work.
2. **New checkpoint:** Read and accept the plan before implementation begins.
3. **Whole sequence:** The visual replay shows who writes, reviews, accepts, and judges completion.
4. **Direct evidence:** Show the actual output where v1 cannot start because it has not been accepted.
5. **Revision:** Show how v2 corrects two defects while keeping the same work ID.
6. **Execution and evidence:** Start after acceptance, then compare the reported commit and checks with the accepted plan.
7. **First use:** Apply the same sequence to one ten-minute agent task.

The visual replay explains roles and state changes. It is neither a product screen nor execution evidence. Put the source commands and output in the relevant steps.

## What the reader should retain

- Before: Give the agent the requirements, then wait and hope the result matches.
- After: Review the agent's plan in work before implementation, then compare the accepted plan and result under the same ID.
- One sentence to remember: **Before an agent starts, record its plan in work and review it.**
- Proof: two defects in v1, the blocked start, v2 under the same `w-cs7dj` ID, and the `fea913a` report with settled evidence.
- Link to the shared association: in this case, project state consists of the accepted plan, execution status, report, and evidence. The person and agent see the same state.

## Scope

- Include: one work item, one plan revision, human acceptance, agent execution and report, and the completion decision.
- Exclude: memory claims, a full explanation of Company State Runtime, multi-work operations, automatic acceptance policies, large agent-review queues, and a product feature list.

## Content changes after approval

- Replace the long opening paragraph with two or three sentences that state the reader's problem and the new action.
- Replace the production-timing note below the video with one sentence about the state changes shown.
- Check that each step ends with one decision the reader can make.
- Write the Korean and English tutorials separately from this brief and the fact table.
- Keep the actual prompt and CLI output unchanged.

## Success checks

After reading the tutorial, a person should be able to answer these questions without reopening it:

1. When should the plan be recorded in work?
2. Why can an unaccepted plan not start?
3. Why does a plan revision keep the same work ID?
4. What evidence should be checked in the report before completion?

Ask the first five target readers these four questions and, "What will you do differently in your next agent task?" At least four should explain the sequence of recording the plan, reviewing it, accepting it, and checking the report, along with the first action they would take. If two readers fail at the same point, revise the opening and step order, then test again. When an executable draft is ready, check that at least four can complete the supported path without extra explanation.

## Review questions

1. Should every piece reinforce the association, "People and AI agents work from the same project state"?
2. Is the right primary reader someone who has already had to redo mismatched agent output, with a beginner as the secondary reader?
3. Should the remembered sentence use `work` so the idea connects directly to the product behavior?
4. Should the visual replay stay limited to roles and state order?
5. Does the current scope make it clear that manual plan review is not an operating rule for every work item?

## Revision history

- v0.1, 2026-08-24: First draft based on the operator's five questions and the single mental-slot principle. Status set to `review`.
