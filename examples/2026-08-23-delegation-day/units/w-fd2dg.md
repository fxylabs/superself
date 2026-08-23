# w-fd2dg · front-door list PRs

Source: `self work show w-fd2dg` and `self work show w-fd2dg --history`, read 2026-08-23 in the superself project. Scrubbed: internal git host, artifact links, home paths.

## Brief outcome line and status

```text
was held by another session, ended 2026-08-22 15:25
# w-fd2dg — self entries are merged into at least 3 existing agent-rules/AGENTS.md front-door lists, after a recorded survey of each list's contribution rules and entry form

- Status: active
- Contributes to: m-cfxt1 M1: Superself is present in every major agent harness — a thin adapter (plugin, skill, or rules) over the self CLI is shipped and listed in that harness's list of record, and a standing wave watch adds new harnesses within 48 hours of their surface opening (on-track)
- Branches: main, sales-pages
- Evidence: 3921c991c7ab (unverifiable)
- Evidence notes: https://github.com/Ischca/awesome-agents-md/pull/17; https://github.com/github/awesome-copilot/pull/2766; https://github.com/wshobson/agents/pull/675; https://github.com/hesreallyhim/awesome-claude-code/issues/2468
```

## Reports (latest first, verbatim)

```text
- 2026-08-22 — awesome-claude-code: a submission already exists — issue #2468 [Resource]: Superself, filed 2026-08-08 by tonite31, labels validation-passed + resource-submission, awaiting maintainer /approve (no comment since). No second form filed (their rule: one resource at a time); the prefilled debug-Chrome tab was closed. 예상대로
### 2026-08-22

w-fd2dg — step 3 complete: submissions opened to every target whose rules we can meet. Not done: done is 3 merges, recorded by the maintainer when they land.

## Submissions

| target | submission | form | status 2026-08-23 |
|---|---|---|---|
| Ischca/awesome-agents-md | https://github.com/Ischca/awesome-agents-md/pull/17 | one README line under `## Tools`, after lychee | open; low merge odds (no external PR ever merged, owner inactive since 2025-08) |
| github/awesome-copilot | https://github.com/github/awesome-copilot/pull/2766 | `skills/superself/SKILL.md` + regenerated `docs/README.skills.md`; title carries `🤖🤖🤖` per their agent fast-track rule | open; `npm run skill:validate` 413 valid, `npm start` one row added |
| wshobson/agents | issue https://github.com/wshobson/agents/issues/674 → PR https://github.com/wshobson/agents/pull/675 | local plugin `plugins/superself/` (plugin.json, README with disclosure, `skills/superself/SKILL.md`), marketplace entry category `workflows`, generated registries, catalog rows and counts bumped 92→93 plugins / 181→182 skills as PR #645 did | open; validate STRICT=1 OK, garden 0 errors, 495 tests pass, markdownlint 0 issues |
| hesreallyhim/awesome-claude-code | not submitted | issue form only, "must be created by human beings", gh CLI explicitly disallowed | maintainer action: paste the form text below into https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml (eligible: repo >14 days old, active) |
| steipete/agent-rules | not submitted | repo archived 2026-05 | — |
| ciembor/agent-rules-books | not submitted | book-derived rules only, no tool listings, 0 PRs ever merged | — |

## Survey (step 1, recorded earlier in this unit)

| repo | rules | entry form | section | self-promo clause | last external merge | verdict |
|---|---|---|---|---|---|---|
| steipete/agent-rules | none; ARCHIVED | `.mdc` + README bullet | Project Setup & Meta | none | 2025-12-31 | skip |
| ciembor/agent-rules-books | docs/ADDING_THE_BOOK.md | per-book dir | none | none | never | skip |
| Ischca/awesome-agents-md | `- [Name](URL) – 30‑60 chars`, alphabetical, awesome-lint, "unicorn", review 2 PRs | README line | `## Tools` | none | never | submitted |
| github/awesome-copilot | SKILL.md `name`=folder, `description` quoted 10–1024, `npm run skill:validate`, `npm start`, PR to main | skill folder | skills table | #968 "not a marketing channel", disclose affiliation | 2026-08-21 | submitted |
| wshobson/agents | plugin.json + SKILL.md with `Use when` + marketplace entry; `make generate-all/validate/garden`; issue first | local plugin | `workflows` | "must not funnel users to paid products … disclose" | 2026-08-18 | submitted |
| hesreallyhim/awesome-claude-code | web issue form by a human; ≥14 days + active or 100★ | issue → bot PR | Memory & Context Persistence | "descriptions, not a sales pitch" | 2026-08-04 | human-only |

## Entry texts used

Tool line (awesome-agents-md): `- [Superself](https://github.com/fxylabs/superself) – Version control for project state; renders AGENTS.md blocks.`

Skill (awesome-copilot, wshobson/agents) — frontmatter description: "Use when a project keeps its state in Superself (a `<!-- superself:begin` block in AGENTS.md or CLAUDE.md, or `self setup` resolves the directory to a registered project): read `self context` at session start, attach work to a work unit, report with evidence, and record confirmed decisions so the next session picks up where this one left off." Body (4.9 KB) restates the `self connect` v0.7.0 block (BLOCK_BODY in apps/cli/src/connect.ts) as session-start / while-working / closing / rules sections plus the seven `self help <topic>` lines; every verb checked against `self --help`.

awesome-claude-code form (for the maintainer): Display Name `Superself`; Category `Memory & Context Persistence`; Link `https://github.com/fxylabs/superself`; Author Name `fxylabs`; Author Link `https://github.com/fxylabs`; Description `Local-first CLI that version-controls a project's state — goals, decisions, work units, reports — as an append-only event log in a git repo separate from the code. self connect renders a managed block into CLAUDE.md and self context prints the derived context a session reads at start.`

## Defect anticipation outcomes

1. Generators/linters: awesome-copilot validate + build clean; wshobson validate/garden/test/markdownlint clean; awesome-agents-md awesome-lint already fails on main (21 errors), our line adds one of the same class as the two existing Tools lines — stated in the PR.
2. Self-promotion: no list forbids maintainer submissions; disclosure written into every PR body and the wshobson plugin README; awesome-claude-code left to a human per its rule.
3. Stale lists: awesome-agents-md submitted with low odds noted.
4. Claims: verified against apps/cli/README.md, root README, `self --help`, connect.ts; `.self` file reference dropped from the skill after finding this worktree has none (`self setup` used instead).
5. Minimal diffs: marketplace.json inserted as a text edit (13 lines) after a json.dumps rewrite produced 8 unrelated deletions and was reverted.

Friction: installed `self` is 0.6.1 while the checkout is 0.7.0, so block text was taken from connect.ts; `gh pr edit` silently failed on a Projects-classic GraphQL deprecation warning and the body had to be patched via the REST API; `make test` needs `uv run --with pytest` locally; awesome-agents-md's `npx lychee` does not resolve.

- 2026-08-22 — PR URL: https://github.com/github/awesome-copilot/pull/2766 (skill). 예상대로
- 2026-08-22 — Two PRs open: Ischca/awesome-agents-md#17 (Tools line, awesome-lint pre-existing failures unchanged) and github/awesome-copilot#2766 (skills/superself/SKILL.md, skill:validate + npm start clean). Friction: awesome-agents-md's npm run check-links cannot resolve npx lychee, link verified by curl; the installed self is 0.6.1 while the block text comes from connect.ts v0.7.0.
### 2026-08-22 [3921c991c7ab]

w-fd2dg step 1 — survey of six front-door lists (data pulled 2026-08-23 via `gh api`; no PR opened yet)

| repo | contribution rules | entry form | fitting section | tools accepted? | self-promo clause | last external merge | verdict |
|---|---|---|---|---|---|---|---|
| steipete/agent-rules | none; repo ARCHIVED 2026-05 (README now points to steipete/agent-scripts) | `.mdc` rule file + README bullet | "Project Setup & Meta" (old) | no (rule text only) | none | 2025-12-31 | skip — read-only |
| ciembor/agent-rules-books | docs/ADDING_THE_BOOK.md only; 0 PRs ever merged | per-book dir `<book>.md/.mini.md/.nano.md` + Release Matrix row | none (book-derived rules only) | no | none | never | skip — off-topic, no intake |
| Ischca/awesome-agents-md | CONTRIBUTING.md: `- [Name](URL) – 30‑60 characters`, alphabetical, `npm run lint` (awesome-lint), PR title `Add Foo Bar`, mention "unicorn", review 2 other PRs | one README line | `## Tools` | yes (section exists; never merged one) | none ("personally read/used") | never (owner only, 2025-05-18; 8 external PRs open since 2026-05, untouched) | submit, low merge odds (dormant ~12 months) |
| github/awesome-copilot | CONTRIBUTING.md + AGENTS.md: `skills/<name>/SKILL.md` with `name`=folder, `description` in single quotes 10–1024 chars; `npm run skill:validate`; `npm start` regenerates docs/README.skills.md; PR to `main`; agents add `🤖🤖🤖` to title | skill folder (or plugin dir) | generated skills table (no topical headings) | yes (vendor skills merged: context-matic, SonarQube) | discussion #968 "not a marketing channel"; disclose affiliation | 2026-08-21 (~346 merges/90d) | submit as skill |
| wshobson/agents | CONTRIBUTING.md: `plugins/<name>/.claude-plugin/plugin.json` + `skills/<s>/SKILL.md` (+ `Use when …` trigger phrase, ≤8 KB body) + `.claude-plugin/marketplace.json` entry; `make generate-all`, `make validate`, `make garden`; issue first, then PR | local plugin with one skill | category `workflows` (cf. conductor) or `memory` | yes, as a plugin; external git-subdir "higher bar" | "must not funnel users to paid products … disclose that relationship in the PR description and the plugin README" | 2026-08-18 (~61 merges/90d) | submit as local plugin, issue first |
| hesreallyhim/awesome-claude-code | CONTRIBUTING.md: "ALL RECOMMENDATIONS MUST BE MADE USING THE WEB UI ISSUE FORM … Do not open a PR … not possible … using the gh CLI … must be created by human beings"; ≥14 days old + active OR 100★; 1 resource at a time | issue form → bot PR (CSV + README) | "Memory & Context Persistence" | yes | "descriptions, not a sales pitch"; "selective" | 2026-08-04 (bot #2425 from external issue) | eligible (repo >14 days, active) but the maintainer must file the web form by hand — form text prepared below |

Entry texts (verified against apps/cli/README.md, root README, `self --help`, connect.ts v0.7.0):

Tool listing: `- [Superself](https://github.com/fxylabs/superself) – CLI that version-controls project state (goals, decisions, work units, reports) outside the code repo and renders a managed agent block into AGENTS.md/CLAUDE.md.`

awesome-claude-code form fields (for the maintainer to paste): Display Name `Superself`; Category `Memory & Context Persistence`; Link `https://github.com/fxylabs/superself`; Author Name `fxylabs`; Author Link `https://github.com/fxylabs`; Description `Local-first CLI that version-controls a project's state — goals, decisions, work units, reports — as an append-only event log in a git repo separate from the code. self connect renders a managed block into CLAUDE.md and self context prints the derived context a session reads at start.`

Block form: the `self connect` v0.7.0 block (BLOCK_BODY in apps/cli/src/connect.ts plus the seven `self help <topic>` lines), reproduced verbatim where a list takes instruction blocks; per-project conventions omitted.

Friction: the two pure "agent-rules" targets (steipete, ciembor) take no tool listings at all and one is archived, so the workable set is awesome-lists and plugin marketplaces, not rules repos; awesome-claude-code forbids agent-made submissions outright.
```

## Event history

```text
w-fd2dg  live  10 events
2026-08-22T14:57:13.888Z  entity.confirmed  [01m0mzkn50w79q1jf9qb4e5r4p]  self entries are merged into at least 3 existing agent-rules/AGENTS.md front-door lists, after a recorded survey of each list's contribution rules and entry form
2026-08-22T14:57:15.068Z  entity.linked  [01m0mzkp9v1ethavzkytvwadj7]  
2026-08-22T14:59:02.399Z  entity.unlinked  [01m0mzpz3zs56c5yrafxw7xkkc]  
2026-08-22T14:59:03.650Z  entity.linked  [01m0mzq0b2bs4j5y093tbk3vdk]  
2026-08-22T15:17:13.914Z  entity.unlinked  [01m0n0r91tva94kwpkf29kjxv2]  
2026-08-22T15:17:15.090Z  entity.unlinked  [01m0n0ra6jp7zen7etx72etd3k]  
2026-08-22T15:17:16.248Z  entity.linked  [01m0n0rbarbw6dv0xwkckk70sm]  
2026-08-22T15:22:26.500Z  entity.unlinked  [01m0n11ta49pw64xb96vhg2y47]  
2026-08-22T15:22:27.837Z  entity.linked  [01m0n11vkx7bgvyydmjnfv4psn]  
2026-08-22T15:25:37.938Z  entity.started  [01m0n17n8j6ffxhpg7g25ynep8]
```
