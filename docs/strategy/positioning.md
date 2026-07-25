# Superself positioning and product language

This is a working decision document for public product language.

Revised 2026-07-25 on the basis of a three-track market study (verbatim pain
language, solution-landscape survey, folk-practice inventory). This revision
retires the previous category-first framing — the "Build with agents. Ship
like a team." headline and the "AI agent workspace" lead — in favor of a
problem-first framing. Items below are marked **decided** or **proposed**.
The underlying problem and asset structure are specified in
[problem-definition.md](problem-definition.md).

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

No shipped product holds a project's goals, decisions, progress, and rejected
directions across sessions, models, and tools without relying on the user's
discipline. Built-in platform memory stores preferences and conventions;
memory APIs are developer building blocks; the trust problem of agent-written
memory is an acknowledged open research problem.

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

## Positioning language (proposed)

In order of use:

1. **Pain headline** — problem first, in the market's words:
   > Your agents forget. Your projects shouldn't.
2. **Category line**:
   > Version control for your project's state.
3. **Contrast line** — answers "isn't that just git?" before it is asked:
   > Git versions your code. Superself versions your project.
4. **Mechanism line**:
   > Superself splits your project into state, work, and outputs — and
   > engineers the context your agents need, every session.
5. **Outcome line**:
   > Pick up where you left off — across sessions, models, and tools.
6. **Trust attributes** — supporting, never leading: local-first, no
   account, open source. Each claim is used only once it is true and
   verifiable in the shipped product.

The shipping outcome ("beyond the demo toward a real release") remains valid
body copy, but no longer leads.

## Language to avoid

- **"memory", "persistent memory", "memory system"** as self-description —
  decided against (frame decision 1).
- **"AI agent workspace"** as the lead — recognizable but abstract; it names
  a category without stating a problem. Acceptable as a secondary descriptor.
- **"Build with agents. Ship like a team."** — retired as headline.
- **"production-ready"** — a technical guarantee, not a synonym for shipped.
- **"autonomous shipping"** — the builder remains accountable.
- **"AI project management"** — invites Jira/Linear feature comparison.
- Category naming stays discover-don't-invent (decided 2026-07-23): rotate
  self-descriptions in content and let audience response pick the winner.

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

## Category landscape (revised 2026-07)

| Category | What it holds | Superself stance |
| --- | --- | --- |
| built-in platform memory (Claude Code, Cursor, Copilot, …) | preferences, facts, repo conventions; single-tool | complementary; does not hold project state |
| memory infrastructure APIs (Mem0, Zep, Letta, …) | developer building blocks | different layer; not end-user products |
| memory plugins (claude-mem, …) | compressed conversation history | saturated space; deliberately not our category |
| agent task trackers (Beads, task-master, …) | task graphs and progress | adjacent; progress without goals/decisions |
| spec-driven development (Spec Kit, Kiro) | specs as durable intent | adjacent; specs drift from code without state |
| auto-generated code wikis (DeepWiki, …) | knowledge derivable from code | complementary; project state is not derivable |
| project state layer | goals, decisions, work, outputs, history | **primary — the empty slot** |

## GitHub metadata draft (proposed)

Repository description:

> Version control for your project's state — goals, decisions, work, and outputs your agents can pick up in any session.

Topics: keep the current list; replace `project-management` with
`context-engineering` when the description changes ships.

## Open items

- A/B the pain headline against the contrast line in launch content; the
  loser becomes body copy.
- Lead word test: "state" vs "context" in self-descriptions.
- README and landing rewrite follow this document once the proposed lines are
  confirmed in content testing.
