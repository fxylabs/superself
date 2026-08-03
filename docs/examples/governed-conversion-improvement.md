# Governed autonomy: improving checkout conversion

This worked example shows how Superself is intended to turn an ambiguous
company directive into evidence gathering, a human-approved plan, governed
execution, verified results, and durable organizational learning.

The scenario is synthetic. Its metrics are illustrative, not product data or
generally applicable conversion advice. It demonstrates an operating contract,
not a claim that one checkout change will produce the same result elsewhere.

## Status of the concepts in this document

This example deliberately crosses the boundary between the alpha that exists
and the complete operating loop Superself is building.

- **Shipped foundation** means a corresponding primitive exists in the current
  `self` CLI: typed project and work state, decisions, proposals, reports,
  artifacts, and the pid process ledger.
- **Target contract** means the behavior is part of the intended operating
  loop but is not yet one stable, end-to-end public workflow.
- **Illustrative record** means a name or shape used to make the lifecycle
  concrete. It is not a promise of a shipped command, event type, or schema.

## What the example must prove

The directive is:

> Improve checkout conversion.

That sentence authorizes investigation. It does not authorize an agent to pick
a cause, alter the product, expose customers to an experiment, or spend money.

A governed system must preserve two distinct human judgment points:

1. **Plan gate:** Is this diagnosis credible, and should the company invest in
   this exact improvement plan?
2. **Action gate:** Is this exact customer-facing, external, expensive, or
   irreversible action allowed to happen now?

Between those gates, agents should perform the routine work that the approved
plan and policy already authorize. The person should not have to approve every
task, command, retry, or report.

## The lifecycle

```text
human directive
    ↓
governing context + read-only evidence
    ↓
observations → competing hypotheses
    ↓
versioned improvement proposal
    ↓
PLAN GATE — human approves an exact version
    ↓
approved plan → dependency-aware work graph
    ↓
supervised implementation and validation
    ↓
ACTION GATE — human authorizes customer exposure
    ↓
bounded rollout + outcome measurement
    ↓
verified result + canonical learning
```

## Stage 1 — Capture the directive

The first durable record separates the requested outcome from assumptions
about how to achieve it.

```yaml
# Illustrative target-contract record, not a shipped schema.
kind: Directive
id: dir-checkout-conversion
outcome: Improve checkout conversion
authority: investigate-and-propose
constraints:
  - preserve customer privacy
  - do not change prices or fees without a separate decision
  - do not expose customers to an experiment before approval
success_signal: a verified improvement in completed checkouts without an
  unacceptable regression in payment errors, refunds, or support contacts
```

The important field is `authority`. The system may inspect state, retrieve
evidence, and prepare a proposal. It may not infer that an outcome request is
also permission to execute its preferred solution.

## Stage 2 — Retrieve governing context

Before analysis, the orchestrator retrieves the state that could change the
meaning, safety, or priority of the directive.

| Context | Why it governs this work |
| --- | --- |
| Company objective: increase paid activation without weakening trust | Defines the outcome and a non-negotiable trade-off |
| Decision: customer data remains local | Restricts analytics and experiment tooling |
| Decision: price changes require explicit executive approval | Prevents an agent from treating discounting as an ordinary optimization |
| Current checkout work and recent releases | Avoids duplicate work and identifies possible regressions |
| Existing evidence and rejected directions | Prevents repeating an experiment already shown to be harmful |
| Risk policy for production and customer-facing changes | Determines where the later action gate belongs |

**Shipped foundation:** Superself already stores goals, decisions, work,
reports, artifacts, and evidence, and exposes them through `self context`,
`self work show`, and `self search`.

**Target contract:** context selection becomes scope-specific and explains why
each governing record was selected, omitted, or overridden.

## Stage 3 — Gather evidence before proposing a cause

The investigation begins with read-only or otherwise pre-authorized actions:

- calculate funnel completion by step, device, region, and payment method;
- inspect payment failures, latency, and recent deployment changes;
- review support contacts and usability research;
- verify analytics definitions and data quality;
- identify where evidence is missing or cannot be accessed under policy.

The analysis must separate observation from inference. The following numbers
are synthetic:

| Observation | What it does and does not establish |
| --- | --- |
| Mobile users complete the address step at 62%; desktop users at 78% | Establishes a segment difference, not its cause |
| Mobile completion dropped after a checkout release | Establishes timing, not that the release caused the drop |
| 18% of recent checkout-related support contacts mention address entry | Supports friction as a candidate cause; support contacts are not a representative sample |
| One payment provider has twice the failure rate of the others | Establishes a reliability issue; it may explain only part of total abandonment |
| Some users leave after the final total appears | Supports a price-transparency hypothesis; it does not show which part of the total caused the exit |

If the required evidence is unavailable, the system reports the gap. It does
not convert missing evidence into confidence.

## Stage 4 — Build competing causal hypotheses

The agent produces a hypothesis set rather than promoting the first plausible
story to fact.

| Hypothesis | Supporting evidence | Contrary evidence or gap | Confidence | Cheapest discriminating test |
| --- | --- | --- | --- | --- |
| H1: mobile address entry creates avoidable friction | Mobile gap; address-related support contacts; regression timing | No controlled comparison; device populations differ | Medium | Prototype a shorter form, then run a bounded randomized experiment |
| H2: late disclosure of the final total causes abandonment | Exit concentration after total appears; qualitative complaints | No clean fee-versus-non-fee comparison | Medium-low | Test earlier total disclosure without changing the price |
| H3: payment-provider failures are the primary cause | Elevated failure rate for one provider | Affected sessions explain only a minority of total abandonment | Low as the primary cause; high as a reliability defect | Route a bounded eligible segment to a healthy provider and compare failures |

The recommendation may prioritize H1 while still scheduling the H3 reliability
fix. That is different from asserting that H1 is already proven.

## Stage 5 — Propose an improvement plan

The proposal is the object the person reviews. It contains enough information
to judge the diagnosis, trade-offs, investment, and authorization boundary.

### Improvement plan v1 — illustrative

**Recommendation**

Validate H1 first with a bounded mobile experiment that shortens address entry.
Repair the provider failure independently as reliability work, but do not count
that repair as proof of the primary conversion hypothesis.

**Alternatives considered**

- expose the final total earlier and test H2 first;
- repair provider routing before running any funnel experiment;
- redesign the entire checkout immediately;
- collect more evidence and defer product changes.

**Why this option**

It tests the highest-supported hypothesis with a reversible change and avoids
committing to a full checkout redesign before causal evidence exists.

**Expected effect**

The experiment is worth continuing only if the predeclared conversion threshold
is met. The estimate is a planning assumption, not a forecast guarantee.

**Scope**

- eligible mobile traffic only;
- no price, fee, payment, or privacy-policy change;
- 10% maximum exposure after the action gate;
- one predeclared measurement window and sample rule.

**Success and guardrail conditions**

- checkout completion improves by the predeclared minimum;
- payment-error rate does not exceed its guardrail;
- refunds and checkout-related support contacts do not materially worsen;
- analytics quality remains sufficient to interpret the result.

**Stop and rollback conditions**

- stop immediately on a payment-error or data-quality guardrail breach;
- stop at the measurement boundary if the success condition is not met;
- restore the prior form through the prepared rollback path;
- do not broaden exposure from an inconclusive result.

**Known risks**

- a shorter form may shift errors later in the flow;
- segment selection may exclude users for whom the change behaves differently;
- instrumentation changes may create an apparent improvement;
- optimizing conversion alone may harm trust or downstream outcomes.

**Evidence plan**

- preserve the baseline definition and analysis query;
- record assignment, exposure, errors, completion, refunds, and support contacts;
- attach the implementation checks and rollout receipt;
- publish the final outcome report whether the hypothesis is supported,
  rejected, or unresolved.

## Gate 1 — Approve the exact plan

The plan gate is where human judgment enters. The person is not asked whether
an agent may create five tasks. The person is asked whether the diagnosis,
recommended experiment, trade-offs, and investment are acceptable.

Possible dispositions are:

- **approve** the exact plan;
- **request revision** with a stated concern;
- **reject** it with a reason that becomes governing context;
- **defer** until a dependency or evidence gap changes;
- **approve only the validation experiment**, not a general rollout.

For this example, the person approves only the bounded experiment in plan v1.

```yaml
# Illustrative target-contract record, not a shipped schema.
kind: PlanApproval
subject: improvement-plan-v1
subject_digest: <sha256-of-the-exact-plan-bytes>
decision: approved-for-bounded-experiment
authority:
  allowed:
    - implement the reviewed experiment
    - run local checks and internal validation
  still_requires_action_gate:
    - production deployment
    - customer exposure
    - exposure above 10 percent
```

The approval belongs to the exact plan digest. A material change to the
hypothesis, scope, customer segment, exposure, success rule, data access, cost,
or rollback path creates plan v2 and closes the gate again. Approval text that
cannot identify its subject is not authorization.

**Shipped foundation:** current Superself work can require human approval, and
integration approvals bind to exact repository state.

**Target contract:** one public proposal lifecycle binds analysis, plan
revision, disposition, work materialization, and later action proposals to
stable identities.

## Stage 6 — Materialize only the approved plan

Before approval, the analysis and proposal exist, but no implementation work
graph is authorized. Approval materializes a graph whose nodes trace back to
plan v1.

```text
W1  seal baseline and measurement contract
 ├─→ W2  implement the shorter mobile address form
 │    └─→ W3  run local and end-to-end checks
 ├─→ W4  prepare production monitoring and rollback
 └──────────────┬───────────────────────────────┘
                ↓
          ACTION GATE: deploy and expose 10%
                ↓
W5  run the bounded experiment and watch guardrails
                ↓
W6  analyze the predeclared outcome window
                ↓
W7  record the result, decision, and follow-up work

Independent reliability lane:
W8  investigate and repair the provider failure without claiming it proves H1
```

Each node states an outcome, requirements, dependencies, declared artifacts,
policy, and evidence plan. The graph may run independent nodes in parallel,
but it cannot walk past the action gate.

**Shipped foundation:** Superself has goals, objectives, milestones,
proposals, and evidence-linked reports. The execution-contract machinery this
stage describes is target state.

**Target contract:** approved intent compiles into a coordinated work graph
through one stable public contract rather than manual command-by-command
translation.

## Stage 7 — Supervise routine execution

Inside the approved plan, the engine should handle routine execution without
asking for approval on every step:

1. preflight the required repository, tools, network, output destinations, and
   provider;
2. dispatch eligible work when dependencies and capacity allow;
3. retain stdout, stderr, heartbeats, checkpoints, and structured results in a
   durable local spool;
4. classify failure and retry only when policy allows;
5. verify the envelope declarations, publish artifacts atomically, then run
   any declared artifact validation and unpublish on validation failure;
6. report material exceptions rather than forwarding every process event.

Suppose W2's first attempt cannot reach its provider. The supervisor records a
transient provider failure, preserves the attempt, waits according to policy,
and retries. It does not ask the person to relaunch the same command, and it
does not call the failed attempt completed.

Suppose W3 then finds that address validation moved errors to the final step.
That is a plan-relevant finding, not an ordinary retry. The engine stops the
path, attaches the evidence, and requests revision because the approved
assumption and risk profile changed.

**Shipped foundation:** the pid process ledger exists in the alpha CLI —
running, stale, and exited are judged at read time. The supervision machinery
this stage describes is target state.

**Target contract:** scheduling closes the loop across objective priority,
dependencies, approvals, budget, capacity, failure, and newly freed resources.

## Gate 2 — Authorize customer exposure

Passing implementation checks does not itself authorize production or customer
exposure. The action proposal identifies exactly what will happen now:

```yaml
# Illustrative target-contract record, not a shipped schema.
kind: ActionProposal
action: expose-checkout-experiment
plan: improvement-plan-v1
candidate: <exact-reviewed-build>
audience: eligible mobile sessions
maximum_exposure: 10_percent
measurement_window: <predeclared-window>
guardrails:
  - payment_error_rate
  - refund_rate
  - checkout_support_contacts
rollback: <verified-rollback-procedure>
```

The person confirms that the exact build, audience, exposure, measurement, and
rollback still match the approved plan. Approval of plan v1 cannot silently
authorize 100% exposure, a different segment, a new analytics vendor, or a
price change.

Low-risk internal actions may be pre-authorized by policy. Customer-facing,
external, monetary, privileged, or irreversible actions receive a separate
gate when their consequence requires it.

## Stage 8 — Verify outcomes, not just implementation

There are two different completions:

### Implementation completion

W2 through W4 are complete when their declared artifacts and checks exist:

- the change matches the approved scope;
- local and end-to-end checks pass;
- the monitoring and rollback path are verified;
- review and integration policy is satisfied.

This proves that the experiment is ready. It does not prove that checkout
conversion improved.

### Outcome completion

After the predeclared experiment window, W6 compares the result with the
baseline and guardrails. An illustrative outcome might read:

| Measure | Illustrative result | Interpretation |
| --- | --- | --- |
| Eligible mobile checkout completion | Exceeded the predeclared minimum | Supports H1 for the tested segment and version |
| Payment-error rate | Stayed within its guardrail | No detected reliability regression under this test |
| Refunds and support contacts | Stayed within their guardrails | No detected downstream harm under the declared measures |
| Analytics quality | Passed the predeclared validity checks | The result is interpretable under the experiment contract |

The conclusion is bounded: the result supports H1 for the tested segment,
implementation, and measurement window. It does not prove that address entry
is the universal cause of checkout abandonment or that the effect will persist
unchanged at full exposure.

If the success condition is missed, the correct outcome is “hypothesis not
supported under this experiment,” followed by rollback or a new proposal. The
system must not redefine success after seeing the result.

## Stage 9 — Turn the result into canonical learning

The final report preserves the result and updates only the state that the
evidence supports:

- H1 is supported for the tested mobile segment and implementation;
- H3 remains a separate reliability issue, not the primary explanation;
- the experiment artifact, checks, rollout receipt, metric result, and rollback
  status remain attached as evidence;
- a proposal to expand exposure requires its own plan or action disposition;
- rejected and unresolved hypotheses remain discoverable without governing
  future work as confirmed truth.

The organization should not need the original chat transcript to answer why
the experiment ran, what was approved, what happened, or what may happen next.

## Failure and revision paths

Governed autonomy is defined as much by its refusal and recovery paths as by
the happy path.

| Condition | Engine response | Human involvement |
| --- | --- | --- |
| Required evidence is unavailable | Record the gap; propose the smallest safe way to obtain it | Decide only if access, cost, or priority must change |
| Hypotheses remain indistinguishable | Propose a validation experiment instead of a permanent change | Approve, revise, defer, or reject that experiment |
| The person rejects plan v1 | Preserve the rejection and rationale; materialize no work graph | Provide the governing judgment once |
| Plan v1 changes materially after approval | Create plan v2 and invalidate v1 approval | Review the changed assumptions and trade-offs |
| A transient provider or network failure occurs | Preserve the attempt and retry within policy | No involvement unless capacity threatens a real deadline |
| Implementation evidence contradicts the plan | Stop the affected path and propose a revision | Decide whether the revised plan is acceptable |
| A guardrail breaches during rollout | Stop exposure and execute the verified rollback | Receive the exception report; decide any further action |
| The result is inconclusive | Preserve it as inconclusive; do not broaden exposure | Decide whether more evidence is worth the investment |
| The result is negative | Roll back, reject or revise the hypothesis, and record learning | Decide whether another hypothesis deserves work |
| The result is positive | Report the bounded conclusion and propose the next exposure decision | Approve expansion only if its consequence requires it |

## Human and engine responsibility by stage

| Stage | Engine responsibility | Human responsibility |
| --- | --- | --- |
| Directive | Preserve the requested outcome, constraints, and initial authority | State the outcome and non-negotiable boundaries |
| Context | Retrieve and explain governing state | Correct or add a missing governing decision |
| Evidence | Gather authorized evidence and expose quality gaps | Approve new access only when necessary |
| Hypotheses | Compare explanations without turning inference into fact | Challenge assumptions when judgment or domain knowledge matters |
| Proposal | Present alternatives, recommendation, risk, evidence and rollback | Approve, revise, reject, defer, or narrow the exact plan |
| Work graph | Materialize only approved work and dependencies | No task-by-task approval inside the authorized boundary |
| Execution | Schedule, supervise, retry, recover, verify, and report exceptions | Intervene only when policy or changed assumptions require judgment |
| Action gate | Present the exact consequential action and its rollback | Authorize or refuse that exact action |
| Outcome | Measure against predeclared success and guardrail conditions | Decide what investment or exposure follows from the result |
| Learning | Preserve evidence, decisions, rejected directions, and follow-up work | Confirm direction-changing conclusions |

The split is deliberate: the human owns judgment and accountability; the
engine owns continuity, routine execution, verification, and escalation.

## Illustrative record lineage

The exact public schemas are not defined by this example. The lineage shows
the identities and provenance the target contract must preserve.

```text
Directive dir-checkout-conversion
  ├─ Governing Context projection ctx-1
  ├─ Analysis Report analysis-1
  │    └─ Hypothesis Set hypotheses-1
  └─ Improvement Plan plan-v1 + digest
       └─ Plan Approval approval-1 (exact plan-v1 digest)
            └─ Work Graph graph-1 (derived from plan-v1)
                 ├─ Work / WorkSpec generations
                 │    └─ supervised Attempts → artifacts + checks
                 └─ Action Proposal action-1
                      └─ Action Approval approval-2 (exact candidate)
                           └─ rollout evidence + Outcome Report
                                ├─ confirmed or rejected Decision
                                └─ follow-up Proposal / Work
```

Every downstream record points back to what authorized it. A changed plan,
candidate, audience, or risk boundary cannot inherit an approval merely because
the surrounding prose still sounds similar.

## What exists now and what this example adds as direction

The alpha already provides much of the lower-level substrate:

- local-first append-only events and derived project state;
- goals, decisions, objectives, milestones, work, reports, artifacts, and
  proposals;
- the pid process ledger with read-time liveness.

Everything beyond that — execution contracts, supervision, capability
policy, and merge gates — is target state; merge control today belongs to
GitHub PR review and CI.

The example makes the missing composition explicit:

- one durable company directive with bounded authority;
- scope-aware retrieval before analysis or action;
- a first-class analysis and hypothesis lifecycle;
- versioned plan disposition that materializes work only after approval;
- policy-driven scheduling across the resulting graph;
- a consistent action-proposal gate for consequential capabilities;
- outcome verification and canonical learning through one operating surface.

Those target responsibilities must be delivered and proven independently. A
conceptual record in this document does not make it a shipped CLI contract.

## The principle

The operating model for executable company state is not:

> A person gives an outcome, and agents immediately execute the first plausible
> plan.

It is:

> Agents investigate and propose. A person approves the diagnosis, trade-offs,
> and exact plan where judgment matters. Agents then carry most execution,
> recovery, and verification inside that boundary, returning only consequential
> exceptions and evidence-backed results.
