# Superself positioning and product language

This is a working decision document for public product language.

Revised 2026-07-25 on the basis of a three-track market study (verbatim pain
language, solution-landscape survey, folk-practice inventory), then revised
again on 2026-07-30 after the execution roadmap and a current category scan.
The first revision established the problem-first frame. The second names the
technical layer Superself is building: the **Company State Runtime**, whose
core concept is **Executable Company State**. Items below are marked
**decided** or **proposed**. The underlying problem and asset structure are
specified in [problem-definition.md](problem-definition.md).

## The problem, in the market's own words

The pain is already named and widely repeated. Builders describe agents that
"forget everything between sessions", sessions that "start from scratch", and
the first twenty minutes of every session "wasted rediscovering what it could
have recalled". Three words have converged as the shared vocabulary:
**amnesia**, **context rot**, and **compaction**. The outcome people ask for
is equally crystallized: **"pick up where I left off"**.

The current fixes are folk practice, and all of them collapse at scale:

- **Hand-maintained markdown** — CLAUDE.md / AGENTS.md (a de facto standard
  in 60,000+ repositories), memory-bank file sets, handoff documents, TODO
  protocols. They go stale, contradict themselves, bloat past usefulness, and
  depend on discipline that fails under fatigue. Agents themselves forget to
  update them.
- **Knowledge bases** — wikis, ontologies, note vaults, LLM-maintained wikis.
  Builders of these systems report the same failure: past a few hundred pages,
  contradictions accumulate faster than anyone resolves them.
- **Memory tools** — a saturated space (one plugin alone has 74k+ GitHub
  stars; five competing repos gained 80k+ combined stars in a single quarter)
  that stores conversation summaries and preferences, not project state.
  Community fatigue is explicit: "the 1000th ultimate memory system".
- **Human review of agent-written knowledge** — collapses under volume.
  Confirmation queues degrade into auto-approve, the same way permission
  prompts degrade into skip-permissions.

The market now attacks this problem from several directions. Agent-company
control planes hold goals, org charts, tasks, and budgets; governed runtimes
hold policy, approvals, and audit; workflow engines persist execution; and
company-state blueprints version organizational data. None of those labels by
itself names the exact boundary Superself is choosing: bounded company intent,
decisions, policy, work, authority, evidence, and completion as one executable
state-transition system. That narrower claim must be earned through a public
contract and proof, not asserted as an absence of competitors.

## The decision frame (decided 2026-07-25)

1. **Never position Superself as a memory system.** The word "memory" places
   the product in a saturated, fatigue-laden category and invites tool
   comparisons we do not want.
2. **Do not build or claim an ever-growing knowledge base.** Accumulating
   structures — wiki, ontology, vault — collapse at scale from contradiction
   and duplication, regardless of quality.
3. **Do not rely on per-item human review for trust.** Confirmation queues
   fail at scale. Trust must come from structure: bounded live state,
   append-only timestamped history, cheap on-demand verification, and
   confirmation captured as a byproduct of decisions the user makes anyway.
4. **This is not a memory problem.** It is a project-state problem: what
   version control solved for code is unsolved for the project itself —
   its goals, decisions, work, and outputs.
5. **Own the Company State Runtime category.** Project state is the shipped
   wedge. The lasting layer holds what a company intends, has decided, is
   doing, may authorize, and can prove, then makes that state executable
   across agents, projects, and tools.

## Positioning language (proposed)

In order of use:

1. **Category headline**:
   > The open Company State Runtime.
2. **Category tension**:
   > Models have context. Agents have runtimes. Companies need state.
3. **Category definition**:
   > Company State is the durable, versioned truth of what an organization
   > intends, has decided, is doing, may authorize, and can prove. A Company
   > State Runtime turns that state into context, ready work, policy decisions,
   > supervised execution, verified completion, and the next company state.
4. **Category promise**:
   > Make company state executable.
5. **Shipped-wedge contrast**:
   > Git versions your code. Superself versions your project.
6. **Immediate pain line**:
   > Your agents forget. Your projects shouldn't.
7. **Trust attributes** — supporting, never leading: local-first, no account,
   open source. Each claim is used only once it is true and verifiable in the
   shipped product.

The project-state and cross-session language remains the entry point for what
the alpha proves. It is evidence for the category, not a competing category.

## Language to avoid

- **"memory", "persistent memory", "memory system"** as self-description —
  decided against (frame decision 1).
- **"AI agent workspace"** as the lead — recognizable but abstract; it names
  a category without stating a problem. Acceptable as a secondary descriptor.
- **"Build with agents. Ship like a team."** — retired as headline.
- **"production-ready"** — a technical guarantee, not a synonym for shipped.
- **"autonomous shipping"** — the builder remains accountable.
- **"AI project management"** — invites Jira/Linear feature comparison.
- **"Supercompany"** — already used by active software and AI businesses and
  unclear whether it names a product, company, or operating model.
- **"Agentic Company OS"** and **"Governed Agent Runtime"** as the lead — both
  are active, crowded labels and each describes only part of Superself's
  state-to-execution boundary.

## Positioning creates design obligations

This framing constrains the product, not just the copy:

- **Bounded live state.** The maintained core is small — current goals,
  active decisions, progress, open questions — never an unbounded knowledge
  base pretending to be current.
- **Append-only, timestamped history.** Old entries stay correct as history
  instead of rotting as stale "current" truth.
- **Confirmation as a byproduct.** User authority attaches to
  direction-changing decisions captured in the flow of work — never a
  separate review queue. Unconfirmed material expires by default.
- **Derived context.** What an agent receives each session is a view
  generated from state, not a hand-maintained document.
- **Cross-tool survival.** State must outlive any single agent, model, or
  tool.
- **Executable state.** Current state must determine ready work, applicable
  policy, admissible execution, evidence coverage, completion, and the next
  state; it is not passive documentation.
- **Delegated authority.** A person defines the boundary. A controller may
  derive routine authorization from versioned policy, but an agent never
  self-approves.
- **Evidence-backed transition.** Process exit and model prose cannot mint
  completion. State advances through validated results, receipts, and evidence.

## Category landscape (revised 2026-07)

| Category | What it holds | Superself stance |
| --- | --- | --- |
| built-in platform memory (Claude Code, Cursor, Copilot, …) | preferences, facts, repo conventions; single-tool | complementary; does not hold project state |
| memory infrastructure APIs (Mem0, Zep, Letta, …) | developer building blocks | different layer; not end-user products |
| memory plugins (claude-mem, …) | compressed conversation history | saturated space; deliberately not our category |
| agent task trackers (Beads, task-master, …) | task graphs and progress | adjacent; progress without goals/decisions |
| spec-driven development (Spec Kit, Kiro) | specs as durable intent | adjacent; specs drift from code without state |
| auto-generated code wikis (DeepWiki, …) | knowledge derivable from code | complementary; project state is not derivable |
| agent runtimes and orchestration | one agent or workflow's execution lifecycle | execution substrate; does not own durable company truth |
| governed agent runtimes and agent control planes | runtime authorization, identity, policy, audit | adjacent; authority without the whole outcome/work/evidence state loop |
| agentic company operating systems | agent roles, workflows, business applications, operating surfaces | broad and crowded; often product-suite language rather than a precise layer |
| organizational state and knowledge layers | business objects, memory, knowledge, current records | adjacent; state becomes distinct when it governs execution and completion |
| **Company State Runtime** | intent, decisions, policy, work, execution, evidence, and state transition | **primary — Superself's category** |

## Concrete adjacent products (reviewed 2026-07-30)

The category is not an empty market. Several projects own meaningful parts of
the same operating problem. The distinction must therefore rest on the
canonical object and its transition semantics, not on a claim that Superself
has no competitors.

| Product | What its public material makes primary | Relationship to Superself |
| --- | --- | --- |
| [Paperclip](https://github.com/paperclipai/paperclip/blob/master/doc/PRODUCT.md) | a control plane for autonomous AI companies: companies, goals, agent org charts, task hierarchy, budgets, governance, and coordination | **closest product competitor**; Superself must distinguish evidence-backed company-state transitions from company and agent administration |
| [Agentic](https://loopctl.ai/) | a local-first control plane that selects work from repos and issues, assembles context, enforces policy and budgets, runs agents, and leaves an auditable record | **closest autonomous-work loop**; Superself must make typed company state, cross-project allocation, and semantic completion more than repo-and-operations grounding |
| [BeanOS](https://beanos.ai/blueprint/) | a work-in-progress blueprint in which the company is versioned state and a deterministic Company Bus mediates APIs, permissions, and audit | **closest thesis**; validates the state premise, while leaving room for Superself to ship the open runtime and state contract |
| [Pea](https://www.decentre.io/pea) | a governed agent runtime with explicit authority, policy, memory boundaries, capability dispatch, and evidence | **closest governance architecture**; it governs agent actions rather than making company outcomes and work the primary canonical object |
| [Revka](https://revka.ai/) | local-to-enterprise agent workflows with graph memory, approvals, retries, run logs, and tamper-evident audit | **closest governed workflow product**; its public center is the workflow run and operational record rather than the full company-state lifecycle |
| [Microsoft Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/overview) | an enterprise control plane for agent registry, lifecycle, identity, access, security, compliance, and observation | **strongest incumbent control plane**; governs a fleet of agents but does not present company intent, work, and verified completion as its source of truth |
| [LangGraph](https://docs.langchain.com/oss/python/langgraph/persistence) and [Temporal](https://assets.temporal.io/durable-execution.pdf) | checkpointed agent graphs and durable workflow execution | **execution substrates**; Superself may use or complement such runtimes, but its category begins above a single graph or workflow |
| [DVC ACOS](https://darkvectorcognition.ai/solutions/acos), [Orenval](https://orenval.com/), and [Proxon](https://proxon.ai/) | broad agentic-company, organizational-OS, or company-control-plane language spanning memory, governance, orchestration, cost, and operating surfaces | **positioning adjacencies**; reinforce why `Agentic Company OS` and `Company Control Plane` are too broad to be Superself's precise technical category |

This scan is product and market-language research, not legal clearance. Public
claims also have different evidence levels: Microsoft documents a generally
available product; Paperclip exposes an active public implementation and
specification; BeanOS labels itself an early draft; and several vendor pages
describe capabilities whose production depth was not independently verified.

The durable boundary Superself should defend is:

1. Company state is the canonical, versioned truth of intent, decisions,
   policy, work, evidence, authority, and completion — not merely agent memory,
   a workflow checkpoint, an org chart, or an audit log.
2. That state determines what context is derived, what work is ready, what
   action is authorized, what evidence is required, and whether completion may
   advance the state.
3. Humans and agents may propose changes, but neither model prose nor process
   exit mutates canonical truth without the applicable transition gate.
4. The runtime spans agents, models, projects, and tools instead of making any
   one provider or execution framework the authority plane.

A detailed Korean comparison and claim audit lives in the issue #103 review
artifact. Before publication, repeat the scan and perform trademark and domain
clearance separately.

## GitHub metadata draft (proposed)

Repository description:

> The open Company State Runtime — durable goals, decisions, policy, work, and evidence that drive governed agent execution.

Topics: keep the current list; replace `project-management` with
`context-engineering` when the description changes ships.

## Open items

- Validate whether technical readers understand `Company State Runtime`
  without explanation after reading the category tension and definition.
- Keep a dated, source-linked competitor analysis; do not turn category claims
  into unsupported claims that no adjacent product exists.
- Run formal trademark and domain clearance separately from market-language
  research before treating the category phrase as a protected mark.
