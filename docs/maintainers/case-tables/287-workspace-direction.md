# Case table — workspace scope for goals and objectives (#287)

The design artifact for #287. Every test in
`apps/cli/test/workspace-direction.test.mjs` is one cell below, named by its
cell id, and asserts that cell's stated outcome. Five cells live in the suite
that already owns their subject — A9, B16, B19 and D1–D4 — and two are
reconfirmations of guarantees that already hold, C5 and E5; the mapping at the
end says where each one is. The table is the review surface: a cell the table
lacks is a path nothing proves.

## The defect

This workspace holds 33 registered projects, and the direction that governs all
of them — the company's own goal and objectives — lived inside one of them,
because a goal had nowhere else to live. A session working in any of the other
32 read that project's goal, that project's objectives, and nothing about what
the company as a whole is trying to do.

Two record kinds already answered for the workspace: a convention
(`convention add --workspace`) and a raw state record
(`state add/place --scope workspace`). A goal and an objective did not.
`self objective --workspace` existed but is a *listing* flag — it reads every
project's objectives — and `objective add` took no scope at all.

## What the change actually is

A goal and an objective are entities already, so nothing new is stored:

| Piece | Before | After |
| --- | --- | --- |
| `goal add` payload | `scope: "project"` fixed | `scope: "workspace"` with `--workspace` |
| `objective add` payload | `scope: "project"` fixed | `scope: "workspace"` with `--workspace` |
| cap gate | `tierOf(ctx.project, exposure)` | the tier read off the payload's own scope |
| render | `rendersIn` / `scopedIn` already scope-aware | unchanged |

Everything else in the change is what has to follow from that: the objective
surfaces that answer for another project's workspace objective, the direction
block above the workspace context, a tie-break so a company record reads above
a project one at equal priority, and the archive refusal.

## Rules the cells are derived from

1. **Scope names where a record renders, never where it is stored** (#181 D4,
   #207 D6). A workspace goal's events stay in the log of the project it was
   recorded in. No workspace-level log exists, and none is added.
2. **The tier a record enters is the tier of its scope.** `occupiesTier` judges
   by `scopeTarget(entity, home) === target`, so a workspace record occupies the
   `workspace` tier and no project's. Caps are separate; the per-project
   *render budget* is not — a workspace record spends every project's budget,
   which is the point of recording it there.
3. **Placement lives on the entity, not on the objective state.**
   `ObjectiveState` carries a priority and no placement, so every "is this
   workspace-scoped?" reads the entity of the same id
   (`goals.ts` `isWorkspaceScoped`).
4. **A foreign objective is rendered from the fold that owns it.**
   `objectiveRow` counts the objective's own open units and `contributorsTo`
   filters by owner slug, so rendering another project's objective from the
   reading fold would report zero work and the wrong contributors.
5. **A milestone stays project-scoped.** A checkpoint is the owner's plan, so
   another project reads a workspace objective with no checkpoints under it,
   and `milestone add` against another project's objective is refused by name.
6. **One comparator.** `orderEntities` sorts both `self state list` and the
   context projection; a second comparator would let the two surfaces disagree,
   so the scope tie-break lands in the one comparator and therefore also
   reorders conventions and raw records at equal priority. That is an intended
   ripple, and cells E2 and E3 pin it.
7. **An archived project's records all go quiet with it** (#283, #285 cell 17).
   Rather than carving an exception into the read path, the archive itself is
   refused while the project still holds live workspace direction — the
   direction does not survive an archive, the archive does not happen.
8. **Only confirmed direction gates the archive.** A proposal is not direction
   the company has taken and occupies no tier until confirmed (#240 R3).
9. **Supersession resolves inside one fold.** `goal add --supersedes` and
   `objective add --supersedes` resolve the predecessor in the project the
   command runs in, so lineage does not cross projects — which is why the
   archive refusal's second exit says the restated record gets a new id instead
   of handing over a `--supersedes` command that would be refused.

## Cells

State variables: the record's scope (project · workspace) × the verb (add ·
confirm · revise · close · retract · list · show) × where the read runs (home ·
another active project · a project named with `--project` · the workspace root)
× the render form (piped · terminal) × the home project's state (active ·
archived · broken store) × the record's own state (proposed · confirmed) × the
cap state (room · workspace tier full · project tier full).

`alpha` records the direction, `beta` reads it, `gamma` is the second owner and
the bystander.

### A. the write verbs and the flags they take

| # | Operation | Expected outcome |
| --- | --- | --- |
| A1 | `self goal add "…"` | unchanged — recorded at project scope |
| A2 | `self goal add "…" --workspace` | `scope: "workspace"`, same receipt shape, record stays in alpha's store |
| A3 | `self goal add "…" --workspace --supersedes <workspace goal>` | lineage kept, predecessor superseded, successor workspace-scoped |
| A4 | `self goal retract <id> --workspace` | refused by name — a goal is withdrawn wherever it renders |
| A5 | `self objective add "…"` | unchanged — project scope |
| A6 | `self objective add "…" --workspace --target … --success …` | workspace scope, every other field recorded as given |
| A7 | `self objective add "…" --workspace --proposed` | a proposal; it occupies no tier until confirmed |
| A8 | `self objective confirm <id>` on that proposal | confirmed at workspace scope, past the workspace tier gate |
| A9 | `self objective revise <id> --why …` on a workspace objective | successor inherits workspace scope — `carriedPlacement`, no new code |
| A10 | `self objective close <id> --as reached` | leaves every project's context |
| A11 | `self objective add "…" --workspace --project other` | refused: `unknown option '--project'` — a write takes no read scope |
| A12 | `self milestone add … --objective <own workspace objective>` | recorded, project-scoped; other projects read the objective with no checkpoint |
| A13 | `self milestone add … --objective <another project's workspace objective>` | refused, naming the project whose log owns it |
| A14 | `self objective add "…" --workspace --supersedes <another project's id>` | refused — supersession resolves inside one fold (today's behaviour, pinned) |

### B. what renders, where it is read, and what the home project's state does

| # | Record | Home | Read | Expected outcome |
| --- | --- | --- | --- | --- |
| B1 | project goal | active | `self context` at home | renders (unchanged) |
| B2 | project goal | active | `self context` in beta | does not render (unchanged) |
| B3 | workspace goal | active | `self context` at home | renders |
| B4 | workspace goal | active | `self context` in beta | renders — `scopedIn` pulls it |
| B5 | workspace objective with a milestone | active | `self context` in beta | the objective renders above beta's own; the milestone does not (it is project-scoped) |
| B6 | workspace objective | active | `self objective` in beta | leads the rows with `(alpha)`; linked work counted in the owning fold, never the reading one |
| B7 | workspace objective with a contributed unit | active | `self objective show <id>` in beta | body plus contributors computed for the owning slug |
| B8 | workspace objective | active | `self objective --workspace` | listed once, under its owner's block only |
| B9 | workspace goal + objective | active | root `self context`, piped | one direction block above the project lines; alpha's row states alpha's own goals and its `(+n more)` counts the same set |
| B9t | same | active | root `self context`, terminal | the same block above the table, and the same GOAL column rule |
| B10 | workspace objective | active | `self status` in beta | beta's objective count is beta's own |
| B10r | workspace goal + objective | active | root `self status`, piped and terminal | no direction block — the rows are what they were before this change |
| B11 | — | archived | `self goal add "…" --workspace` inside it | refused: an archived project records no event at all (`requireWritable`) |
| B12 | live workspace goal + objective | active | `self project archive <home>` | refused, listing the ids and naming both ways out; a project-scoped goal is not listed |
| B13 | the same, after retract and close | active | `self project archive <home>` | archives |
| B14 | workspace goal | broken store | `self context` in beta | fails, exactly as it does today |
| B15 | project-scoped records only | active | another project archived, then `self status` | unchanged (#285 cell 14) |
| B16 | workspace objective in beta | active | `self work link <w> --objective <o>` from alpha | links, and the unit does not move (#254) |
| B17 | alpha and gamma each own one | active | `self objective` in beta | both lead, ordered by owner slug, above beta's own |
| B18 | workspace objective | active | `self objective show <id prefix>` in beta | refused — objective lookup takes exact ids only, at home and abroad alike |
| B19 | a *proposed* workspace objective only | active | `self project archive <home>` | archives — the gate reads confirmed direction |
| B20 | workspace goal | active | `self search "<word>"` in beta | absent by default (context already showed it), found with `--all` |
| B21 | alpha and gamma each own one | active | `self objective --project beta` from gamma | beta is the viewer; each objective appears exactly once |

### C. the caps, and the render budget

| # | State | Operation | Expected outcome |
| --- | --- | --- | --- |
| C1 | project tier full, workspace tier free | `self goal add "…" --workspace` | passes — the tiers gate apart |
| C2 | workspace tier full | `self goal add "…" --workspace` | refused, naming the workspace tier and its numbers |
| C3 | workspace tier full | `self goal add "…"` | passes — the project tier has room |
| C4 | workspace tier full | `… --workspace --demote <workspace entity>` | passes; the demoted record moves to index |
| C5 | workspace tier full | `… --workspace --demote <project entity>` | refused — that demotion frees no workspace room. Already asserted by `workspace-scope.test.mjs` D5; cited, not rewritten |
| C6 | workspace tier full | `… --workspace --proposed`, then `confirm` | the proposal passes, the confirm is refused (#240 R3) |
| C7 | direction plus a project context over budget | `self context` in beta | the direction survives and the sections below it are cut — priority 0 and 10 against a convention's 30 |
| C8 | a workspace objective | `self state show <id>` | `placement: workspace · full · priority 10` |

### D. an objective recorded before the flag existed

| # | Operation | Expected outcome |
| --- | --- | --- |
| D1 | `self state place <o-id> --scope workspace` | raised to workspace scope — no new verb, no new code |
| D2 | then `self context` in beta | renders |
| D3 | `self state place <o-id> --scope <home slug>` | back to one project's context |
| D4 | then `self objective revise <o-id> --why …` | the successor inherits the workspace placement |

### E. the tie-break, and what else sorts through it

| # | State | Operation | Expected outcome |
| --- | --- | --- | --- |
| E1 | workspace objective and project objective, both priority 10 | `self context` in beta | the workspace one renders above — the issue's "above that project's own objectives" |
| E2 | workspace convention and project convention, both priority 30 | `self context` in beta | the workspace one renders above — the intended ripple of one comparator |
| E3 | the same records | `self state list` | the same order as the context |
| E4 | same priority, same scope | `self context` | recency, then id — the old tie-break, unchanged |
| E5 | the golden single-project scenario, no workspace records | `golden.test.mjs` | unchanged; a diff here would be a regression, not a fixture to regenerate |

## Where each cell is asserted

| Cells | File |
| --- | --- |
| A1–A8, A10–A14, B1–B15, B17, B18, B20, B21, C1–C4, C6–C8, E1–E4 | `apps/cli/test/workspace-direction.test.mjs` |
| A9 | `apps/cli/test/objective-revise-carry.test.mjs` |
| B16 | `apps/cli/test/cross-link.test.mjs` |
| B19 | `apps/cli/test/project-archive.test.mjs` |
| D1–D4 | `apps/cli/test/scope-move.test.mjs` |
| C5 | `apps/cli/test/workspace-scope.test.mjs` D5 — an existing assertion, cited |
| E5 | `apps/cli/test/golden.test.mjs` — unchanged fixture is the assertion |

## Out of scope

- **A workspace form for work units.** Work happens somewhere; direction is
  what it serves, and the contribution edge between them already exists (#254).
- **Automatic migration of existing objectives.** `state place --scope
  workspace` raises one, and cells D1–D4 are that call being made.
- **Convention and raw-record archive behaviour.** Decided in #285; the gate
  added here covers goals and objectives, which are the direction records.
- **Cross-project `--supersedes`.** Cell A14 pins today's refusal; extending it
  is separate work.
- **The generated HTML view.** It renders no workspace direction block, the
  same as `self status`; the view is not a maintained surface.
- **`self status`.** The surface the issue asks for is context. Both of status's
  renders say the same thing they said before, which is what cell B10r holds.
