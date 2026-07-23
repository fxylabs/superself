# Superself positioning and category keywords

This is a working decision document for public product language. It separates
the outcome Superself promises from the architecture used to deliver it.

## Audience and problem

Superself is for vibe coders and AI builders who can reach a demo or MVP quickly
but struggle to carry the project through the less glamorous work required to
ship and keep shipping.

The bottleneck is no longer only producing code. It is maintaining direction
and continuity while work moves across agents, sessions, files, and tools:

```text
product intent and goals
→ milestones and Definition of Done
→ agent-sized work
→ live report, evidence, and next actions
→ artifacts and decisions
→ release readiness
→ shipped product
→ durable project memory and the next iteration
```

Superself makes that delivery system visible and persistent.

## Positioning decision

### Headline

> **Build with agents. Ship like a team.**

### Category

**AI agent workspace**

This gives the product a category people can recognize while leaving room for
Superself to define a more specific delivery-oriented position within it:

- `agent` identifies the work being directed and preserved without implying
  that Superself is the runtime that executes it;
- `workspace` covers goals, work, reports, artifacts, and memory without
  pretending to be an operating system;
- `shipping` remains the outcome and differentiator: moving beyond a generated
  demo toward a real release.

### Positioning line

> **The agent workspace for shipping AI-built products.**

### Product description

> Superself turns goals into agent-sized work, live reports, artifacts, and
> durable project memory so AI-built projects keep moving beyond the demo.

### Compact proof line

> Projects · Goals · Agent work reports · Artifacts · Memory

`Local-first`, `no account`, and eventually `bring your own agents` are trust and
architecture attributes. They should support the promise rather than replace it
in the headline.

## Product boundary

Superself does not primarily run agents or generate code. Agents may execute in
an IDE, terminal, cloud service, or another orchestrator. Superself maintains the
delivery state that must survive all of them.

```text
agent orchestrator or IDE
→ runs and controls agents

Superself
→ keeps goals, work units, reports, evidence, outputs, and memory moving toward a release
```

Superself also does not currently guarantee that generated software is
production-ready. `Ship` means providing the durable workflow and evidence
needed to reach and operate a release. Security, deployment, testing, and
reliability claims must be backed by shipped features and verification.

## Positioning creates product obligations

The shipping promise must become more than marketing. The roadmap needs:

- milestones and release goals;
- an explicit Definition of Done;
- test, build, review, and deployment evidence;
- outcome-based agent reports instead of activity logs;
- release-readiness checks;
- completion and handoff across agents;
- post-release feedback linked to the next iteration;
- durable artifacts, decisions, and project memory.

Features that do not strengthen this path should not outrank these foundations.

## Category landscape

| Category | What it usually means | Superself stance |
| --- | --- | --- |
| AI agent orchestrator | run, parallelize, and control agents | complementary, not primary |
| vibe coding IDE | generate and edit code with agents | complementary, not primary |
| agent-native project management | teams, tickets, chat, and agents in one PM tool | adjacent and broader than the initial wedge |
| AI agent workspace | persistent context and coordination for work done with agents | primary category |
| shipping workspace | continuity from goal to real release | outcome-led positioning, not a standalone category |
| personal AI operating system | broad, aspirational personal-computing vision | long-term vision only |

## Language hierarchy

Use these ideas in this order:

1. **Build with agents. Ship like a team.** — memorable promise;
2. **AI agent workspace** — recognizable category;
3. **the agent workspace for shipping AI-built products** — differentiated
   position;
4. **move beyond the demo toward a real release** — problem and outcome;
5. **projects, goals, agent work reports, artifacts, and memory** — mechanism;
6. **local-first, no account, open source** — trust, once each claim is true;
7. **bring your own agents** — interoperability, once the public integration is
   shipped.

Avoid leading with:

- `production-ready`: this is a technical guarantee, not a synonym for shipped;
- `autonomous shipping`: the builder remains accountable for the release;
- `AI project management`: too generic and team-software oriented;
- `local-first`: important architecture, but not the primary outcome;
- `vibe coding`: useful audience and problem language, but likely too temporal
  to become the permanent product category.

## GitHub metadata draft

Repository description:

> Agent workspace for shipping AI-built products—goals, work reports, artifacts, and memory.

Initial GitHub topics:

```text
ai-agents
vibe-coding
project-management
developer-tools
productivity
local-first
pglite
hono
vite
spfn
```

Add `mcp` when an MCP integration exists in the public repository. Add packaging
and platform topics only when those user-facing contracts are shipped and
tested.

## Copy candidates

Primary:

> **Build with agents. Ship like a team.**

Campaign or launch copy:

> Do not stop at the demo. Ship the product.

Explanatory copy:

> The workspace for the work between an AI-made demo and a product people can
> actually use.

The primary line is durable enough for the README. The sharper demo language is
best used in launch material where the target audience is already clear.
