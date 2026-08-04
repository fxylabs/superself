# Superself roadmap

Superself is the open Company State Runtime. This roadmap explains where that
runtime is today and which operating gap it should close next. It is a living
capability roadmap, not a release calendar or a promise that distant designs
have already been settled.

The [README](../README.md) owns the concise vision. Detailed implementation
contracts belong in GitHub issues. This page owns the layer between them:
current capability, current constraints, the next operating outcomes, and the
evidence that would show those outcomes work.

## North Star

People set company outcomes, priorities, accountability boundaries, and
policy. Superself turns that direction into durable state and executable work,
then allocates ready work across projects within policy and available
resources. Agents carry most planning, execution, recovery, verification, and
reporting. The system handles routine judgments that people have delegated by
policy; irreversible, external, high-risk, or indeterminate judgments return
to a person. Completion follows verified evidence and applicable authority,
not an agent claim or a process exit.

In one sentence:

> Human direction becomes governed, evidence-backed execution that continues
> without continuous human operation.

## The target operating loop

```text
human outcome + priorities + boundaries
                 ↓
durable intent, goals, decisions, and policy
                 ↓
scoped context + executable work graph
                 ↓
cross-project readiness and resource allocation
                 ↓
policy decision
  ├─ pre-authorized routine action
  ├─ human judgment required
  └─ forbidden or indeterminate
                 ↓
supervised agent or MCP execution
                 ↓
retry, recovery, result and artifact verification
                 ↓
evidence coverage + completion policy
                 ↓
automatic completion or a precise exception
                 ↓
canonical state, newly ready work, and an attention-focused report
```

This is not blanket auto-approval. A person approves the boundaries within
which routine judgments may be delegated. An agent does not approve its own
work: a controller evaluates a versioned policy and records an auditable
decision.

## Allocation of responsibility

People continue to own:

- company goals, values, priorities, and accountability;
- acceptable risk, cost, data, and capability boundaries;
- policy creation, revision, and revocation;
- consequential judgments, especially irreversible or external actions;
- exceptions for which policy is absent, ambiguous, or conflicting.

The core engine should own:

- compiling authorized direction into bounded work and execution contracts;
- deciding readiness and allocating resources across projects;
- evaluating routine actions against versioned policy;
- execution, retry, recovery, and interruption handling;
- verifying results, artifacts, checks, reviews, and requirement evidence;
- completing eligible work and continuing newly ready dependencies;
- canonical state maintenance and exception-focused reporting.

## Where the core is today

Superself currently provides durable state, placed bounded context, and
process visibility for single-project work. It does not supervise or dispatch
execution — a person or a session starts agents — and it does not yet close
the complete loop above.

| Capability | State | What works now | Open operating gap |
| --- | --- | --- | --- |
| Durable project state | Shipped foundation | Every asserted record — goal, decision, convention, objective, milestone, work — folds into one placed entity under a shared `entity.*` event grammar; reports, artifacts, and history are event-sourced | Broader company scope and stronger migration guarantees |
| Placed, bounded context | Shipped foundation | Entities render by priority and exposure under user-set retention caps; workspace-scoped entities enter every project's context; the preset verbs are a user-editable alias table | Preset cap gating, logical org levels, and general retrieval budgets (see below) |
| Cross-session recovery | Shipped foundation | `context`, `work show`, `search`, and managed agent blocks let another session resume | General context selection and retrieval budgets at every scope |
| Outcome and evidence model | Shipped foundation | Done claims are gated on evidence and declared criteria; a milestone is reached only when every exit criterion is covered | Wider automatic evidence collection and adapter contracts |
| Executable work contract | Direction | Removed with the governance layer (decision 01kz2nczhtde554qx5tqpqzrt3); a work brief attaches via `report --file` | A stable public contract from intent through a versioned work graph |
| Process visibility | Shipped foundation | The pid ledger maps a unit to its agent process; running, stale, and exited are judged at read time | A control plane that supervises work across projects |
| Scheduling and supervision | Direction | Removed with the daemon; dispatch is a person or a session starting agents | A supervisor that enumerates and schedules several projects |
| Resource allocation | Direction | Removed with the daemon and circuit breakers | Cross-project priority, deadline, quota, observed capacity, reservation, and fair allocation |
| Authorization | Direction | A person merging the GitHub PR is the approval; in-tool approvals were removed | Policy-derived authorization and a general action escalation/resume protocol |
| Completion | Shipped foundation | Done is a judgment: one gate admits it, and the claim must carry evidence | A controller does not yet record `entity.done` and continue dependencies automatically |
| Attention and reporting | Partial | Status with per-unit process state and a read-only viewer exist | One cross-project surface for running, queued, capacity, failure, and exact next actions |
| Extension boundary | Direction | Provider-neutral execution and some MCP foundations exist | A trusted, namespaced capability registry and lifecycle |

`Shipped foundation` does not mean the whole capability is finished. It means
the next outcome can depend on a working, tested primitive.

### Deliberately unshipped edges of the entity model

The Company State Engine redesign (#197) shipped its four phases. What the
user-facing documents describe as shipped stops exactly here; the following
edges are target state, named so a reader does not infer them:

- **Preset cap gating** (work `w-wdhg4`): the retention caps gate `state add`,
  `state place`, and the alias verbs today. The dedicated preset commands —
  `goal add`, `objective add`, `milestone add`, `convention add`, `decide` —
  do not yet route through the cap gate, so they can still land a record in a
  tier that is over its cap.
- **WorkSpec machinery**: dispatch and execution contracts are out of the
  engine's scope by ruling — their boundary with the engine identity needs a
  dedicated review before any design lands.
- **Logical org levels**: entity scope stops at `project` versus `workspace`.
  Levels between and above them are a target of the placement model, not a
  shipped axis.
- **Destructive-verb disclosure gate**
  ([#173](https://github.com/fxylabs/superself/issues/173)): a confirmation
  boundary for verbs that discard state is accepted direction, not shipped
  behavior.

## Roadmap horizons

The roadmap deliberately uses different resolution at different horizons.

```text
Foundation             Now / next                    Later
proved primitives      capability + exit evidence    operating outcome only
```

Only the current and next horizon should carry detailed capability gaps and
exit evidence. Later horizons stay open until operating evidence justifies a
design.

## Foundation — continuity and governed attempts

The first foundation makes project state survive sessions and makes a bounded
agent attempt executable, recoverable, and verifiable without someone watching
its terminal.

Current judgment:

- durable state, the outcome layer, and evidence-covered milestones are usable
  foundations;
- physical process termination and semantic work completion are separate: the
  pid ledger records the first, and done stays a human judgment;
- everything the removed governance layer once proved — unattended execution,
  exact-state review gates — is now target state, to be re-earned on the
  reduced surface if it returns.

## Now / next — close the governed autonomous work loop

The near roadmap concentrates on Phase 3. The following increments are not a
bag of independent features; together they close one operating loop.

### 3A. Stabilize the work and execution contract

**Problem.** A scheduler cannot make reliable decisions unless work outcomes,
constraints, evidence requirements, and runtime contracts share a stable,
versioned boundary.

**Next outcome.** Authorized intent compiles into versioned work, dependencies,
WorkSpecs, and completion conditions. A material revision makes incompatible
authorization and execution evidence visibly stale.

**Exit evidence.** Context, WorkSpec generation, attempt result, and requirement
coverage remain traceable to the same work revision; a material revision never
silently inherits an earlier authorization.

### 3B. Supervise several projects from one local control plane

**Problem.** Nothing supervises work today: dispatch is a person or a session
starting agents, and ready work in every project is outside any automatic
view.

**Next outcome.** One local supervisor reconciles canonical state and
machine-local attempts for registered projects, then presents their eligible
work through one readiness surface.

**Exit evidence.** With running, ready, and approval-waiting work across three
projects, one supervisor classifies all of it correctly, dispatches nothing
twice, and reconstructs the same state after restart.

### 3C. Schedule against policy and real resources

**Problem.** When several units are ready, a person still has to choose which
project, work unit, model, and provider should receive scarce capacity.

**Next outcome.** Scheduling considers priority, dependency, deadline, risk,
model requirements, provider capacity, concurrency, and budget.

**Exit evidence.** Scarce hard-model capacity is reserved for hard-gated
critical work; portable work may use an approved fallback; no work launches
before a known `retryAt`; every allocation records its governing policy and
reason.

Related direction: [#32 — Schedule work against model capacity windows and
quotas](https://github.com/fxylabs/superself/issues/32).

### 3D. Derive authorization from versioned policy

**Problem.** If every approval must be an interactive human event, the person
remains the dispatcher for routine work. Blanket auto-approval would erase the
accountability boundary instead of fixing that bottleneck.

**Next outcome.** A person can pre-authorize routine action classes with
versioned policy. A controller evaluates an exact subject and current facts
against that policy and emits an auditable authorization receipt.

Policy evaluation distinguishes at least:

- `preauthorized`: policy explicitly permits the action;
- `human_required`: consequential judgment belongs to a person;
- `forbidden`: unattended execution may not perform the action;
- `indeterminate`: facts are missing or policies conflict.

A receipt binds the subject identity or digest, action class, policy version,
evaluated facts, verdict, and rationale. Agent prose or self-assertion is never
a receipt.

**Exit evidence.** A low-risk internal action proceeds without another human
click when policy permits it. Customer-facing, payment, destructive, or policy
changes wait with an exact subject and reason. A changed subject or policy
revision cannot reuse the old receipt.

No current implementation issue owns this complete capability.

### 3E. Complete verified work and continue its graph

**Problem.** A valid attempt can attach a result and report, but a person still
has to invoke `work done`; dependent work remains coupled to that manual step.

**Next outcome.** A controller evaluates requirement coverage, artifacts,
checks, reviews, model policy, and applicable authority. When every condition
holds, it records an idempotent completion event. Otherwise it produces a
precise exception instead of approximating success.

**Exit evidence.** Routine work with valid evidence and applicable policy
authority reaches done without a foreground human turn, and its dependencies
become ready. Human-gated work waits for one exact decision after reporting;
once granted, completion and dependency continuation are reevaluated without a
new dispatch command.

The existing completion gate is a foundation, but no current implementation
issue owns this automatic completion controller.

### 3F. Accept direction continuously and return only exceptions

**Problem.** If new direction, cancellation, reprioritization, and approval are
tied to the foreground execution turn, the person remains a session
coordinator.

**Next outcome.** A person records direction independently of running work and
receives an immediate durable receipt. One attention surface groups running,
queued, waiting on policy or a person, capacity, failed, and completed work
across projects.

**Exit evidence.** New directives, cancellations, and priority changes remain
durable while several attempts run. The person sees the exceptions that need a
decision and their impact, not a transcript of every operation.

Related direction: [#25 — Capture directives while agent work runs in the
background](https://github.com/fxylabs/superself/issues/25) and [#33 — Show live
background attempts separately from open work](https://github.com/fxylabs/superself/issues/33).

## Phase 3 exit outcome

Phase 3 is not complete because a list of commands shipped. It is complete
when one stable operating story is proved:

```text
A person gives one bounded outcome and policy.
→ Ready work and dependencies exist across several projects.
→ The supervisor allocates work by priority and available resources.
→ Applicable policy authorizes routine internal action.
→ Consequential action waits for a person with an exact subject.
→ Bounded retry and recovery handle agent failure or raise a precise exception.
→ Results, artifacts, checks, and reviews are verified.
→ Work satisfying completion policy reaches done automatically.
→ Newly ready dependent work enters the same loop.
→ The person receives results and only the exceptions they must judge.
```

## Later — preserve the outcome, defer the design

### Phase 4. Compose company capabilities

A company can add research, CRM, publishing, finance, operations, and other
capabilities without hard-coding them into the core. Every capability crosses
the same identity, permission, policy, audit, revocation, result, and evidence
boundary.

This horizon does not yet fix a plugin format, marketplace, or remote protocol.
Phase 3 must first make the execution and authority contracts stable enough for
extensions to depend on them.

### Phase 5. Operate company state from one surface

One person directs and understands several projects and an agent organization
from one place. Direction, questions, authorization, interruption,
reprioritization, live activity, and reports all use the same canonical core.

This horizon does not yet promise a particular UI or hosted topology. Local,
multi-machine, and hosted-worker boundaries should become concrete only after
operating evidence makes the trade-offs real.

## Deliberate non-goals for this roadmap

This page does not contain:

- every possible company use case;
- CLI or schema designs for work outside the execution horizon;
- unsupported delivery dates or completion percentages;
- implementation detail copied from GitHub issues;
- temporary provider feature lists;
- claims of a fully autonomous company that erase accountability.

## Keeping the roadmap current

The roadmap uses four states:

- `Shipped foundation`: a proved capability on which later work can rely;
- `Partial`: useful primitives exist, but the operating outcome remains open;
- `Now / next`: the near horizon, with exit evidence; an owning issue is named
  where implementation work has been accepted, and is not implied otherwise;
- `Direction`: an outcome whose detailed design remains deliberately open.

Progress is never expressed as a percentage.

The following changes must include a roadmap-impact check in the same change
set:

- adding, removing, or changing an externally observable capability boundary;
- discovering or removing a current limitation;
- changing a now/next outcome, exit evidence, or dependency;
- starting, replacing, or completing an issue that owns a roadmap capability.

README keeps the North Star, current summary, and phase links. This page alone
owns detailed status, constraints, exit evidence, and issue mapping. GitHub
issues own implementation contracts and proof, so the same detail is not
copied into three places.

CI can check document links and public command examples. It cannot infer that
a capability has become a shipped foundation. A capability or release review
must make that judgment explicitly from proof and update this page when the
answer changes.
