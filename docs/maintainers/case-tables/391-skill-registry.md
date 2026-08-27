# Case table — a registered skill (#391)

The design artifact for #391, written before the code. Every cell below is one
test, named by its cell id, asserting that cell's stated outcome. The table is
the review surface: a cell the table lacks is a path nothing proves.

Where the tests live:

| Group | Cells | File |
|---|---|---|
| A — registering | 25 (A1–A25) | `apps/cli/test/skill.test.mjs` |
| B — reading | 14 | `apps/cli/test/skill.test.mjs` |
| C — the name, replacement and shadowing | 18 (C1–C18) | `apps/cli/test/skill-name.test.mjs` |
| D — dropping | 12 (D1–D12) | `apps/cli/test/skill-name.test.mjs` |
| E — `self context` | 10 | `apps/cli/test/skill-context.test.mjs` |
| F — the trust surface | 5 | `apps/cli/test/skill-context.test.mjs` |
| G — project scope and the resolver | 5 | `apps/cli/test/skill.test.mjs` |
| H — an ordinary record | 5 | `apps/cli/test/skill-context.test.mjs` |

**90 designed cells, 94 as shipped.** The design's prose said "87"; its own
group table summed to 90, and 90 is the number that was designed.

Four cells were added during implementation, each closing a path the designed
table left unproven:

- **A25** — a `--command` carrying a newline. The table refused a *second*
  `--command` and said nothing about one line that is two.
- **C17** — an id prefix that reaches two skills. The table put prefix
  resolution in B3 and never asked what happens when a prefix is ambiguous.
- **C18** — a second replacement proposed while one still waits. The table
  covered proposing and confirming in sequence and never the race.
- **D12** — dropping a workspace skill from a project whose log does not hold
  it. The table's D5 covered a name nothing answers to; this is a name that
  answers here and cannot be withdrawn from here, which is a different sentence.

## The problem

A project accumulates operational know-how that is neither a rule nor a
procedure: the exact command that deploys, the flag soup that runs one test file
against the right environment, the short recipe for a task that comes up every
few weeks. `convention add` records prose rules — judgment, not actions.
`runbook` records a staged procedure and tracks instances through it. What was
missing is the light middle: a named, reusable command or recipe, registered
once, findable by every later session.

## The mechanism

Nothing new is minted. Everything below composes out of the `entity.*` grammar
that already exists: **no new event type, no new reducer, no new reserved
metadata key, no new row in `BUILTIN_ROWS`, no fold change.**

| The thing | The machine it is made of |
|---|---|
| A skill | an entity labelled `skill`, `text` = the name, `why` = the one-line purpose |
| Its one-line body | the reserved metadata `criteria`, holding exactly one line |
| Its markdown recipe | the reserved metadata `artifact`, holding a registered `a-` id |
| Its scope | the placement `scope` — `project` (the sentinel) or `workspace` |
| A correction | `entity.proposed` carrying a `supersedes` link; `self state confirm` lands it |
| Its version history | the record's place in the `supersedes` chain — derived, never stored |
| Withdrawing one | `entity.retracted` through the retirement gate, exactly as `convention drop` |

### Why `criteria` holds the command line

`runbook` already put a stage list there, and a runbook *definition* is never
covered — only its runs are. A skill is the same shape: a record that declares
an ordered list of statements and is never the subject of a coverage claim.
Nothing generic renders `criteria`, so the command line stays out of
`self context` by construction, which is exactly what the issue asks for — a
compact name-and-purpose index, not the bodies.

### The one refactor this needed

`runbooks.ts` held a supersedes-chain walker hard-wired to the `runbook` label.
Skills need the identical walk, so it was lifted to `entities.ts` as
`supersedesChain(entities, id, isKind)` with `chainVersion` and `chainHead`
beside it — the module that owns `EntityState` and its links, and the one both
domains already import. `runbooks.ts` keeps `runbookChain` as the wrapper that
says what a runbook is; `skills.ts` keeps `skillChain` for the same reason.

## Rulings

- **R1** a skill is an entity labelled `skill`: the name is its text, the
  purpose its `why`, the one line its reserved `criteria`, and the longer
  recipe its reserved `artifact`.
- **R2** no new event type: `entity.confirmed`, `entity.proposed` and
  `entity.retracted` do all of it.
- **R3** a version is a place in the supersedes chain, derived and never stored.
- **R4** re-registering the same name at the same scope proposes a superseding
  version; `self state confirm` lands it. This is forced rather than preferred:
  `recordAdd` routes a confirmed supersession through the retirement gate, which
  an agent cannot satisfy, so an outright displacement would refuse in exactly
  the case the feature exists for.
- **R5** a project skill shadows a workspace skill of the same name, always, and
  the shadow is always disclosed — at the add, in the listing, on the page and
  in context. Context carries one row: the skill a name actually reaches.
- **R6** a placeholder `{{tag}}` is recognised and listed, never substituted.
  A malformed one is refused at the add, so a record can never promise a hole no
  caller can find.
- **R7** a skill is printed, never run. `skill run` is a refusal and is absent
  from every help page.

### Why print-only

1. **The store is synced.** The event log and `artifacts/` live in a git repo
   pushed and pulled between machines. A `skill run` makes an append-only synced
   log an arbitrary-code-execution channel.
2. **The project already paid for a code-execution trust boundary and it is not
   this one.** `rootkeys.ts` pins signed release keys and `structure.mjs` fails
   the build if a published CLI pins no root — all so a *plugin* can run code.
3. **`runbook` settled the same question in the same words**: registering one
   schedules nothing and dispatches nothing.
4. **The CLI could not record what it ran.** `sanitize.ts` `FORBIDDEN_KEYS`
   lists `stdout`, `stderr`, `output`, `env`, `pid`, `cwd`.
5. **Nothing is gained.** `self skill show deploy` prints the line; the caller
   runs it.

## 4.1 Group A — registering a skill

| Cell | State | Action | Expected |
|---|---|---|---|
| A1 | no skills | `self skill` | says so, names `skill add`, exit 0 |
| A2 | no skills | `add "deploy" --command "make deploy" --purpose "p"` | one record, `e-` id, labels `[skill]`, `criteria ["make deploy"]`, `why "p"`, scope `project`, exposure `index`, priority 50 |
| A3 | no skills | `add "deploy" --purpose "p"` | refused — a skill is its body; nothing recorded |
| A4 | no skills | `add "deploy" --command "c"` | refused by the requirement gate, naming `--purpose` |
| A5 | no skills | `add "deploy" --command "c" --file f --purpose "p"` | refused — one body; nothing recorded, no artifact registered |
| A6 | no skills | `add "deploy" --command "a" --command "b" --purpose "p"` | refused, naming the second line |
| A7 | no skills | `add "" …` and `add "   " …` | refused by the text gate |
| A8 | no skills | `add "e-abc12" --command "c" --purpose "p"` | refused — a name is not an id |
| A9 | no skills | `add "recipe" --file r.md --purpose "p"` | one record; `artifact` is a new `a-` id; `criteria` empty; the bytes are in `artifacts/<slug>/` |
| A10 | no skills | `add "recipe" --file <missing> --purpose "p"` | refused naming the path; nothing recorded, no artifact registered |
| A11 | no skills | `add "recipe" --file <empty file> --purpose "p"` | refused naming the path |
| A12 | no skills | `add "recipe" --file <a directory> --purpose "p"` | refused — a recipe is one file |
| A13 | no skills | `add "recipe" --file <file holding U+001B> --purpose "p"` | refused naming the code point and offset; no artifact registered |
| A14 | no skills | `add "recipe" --file <absolute path outside the project> --purpose "p"` | read and copied; the record carries the artifact id and **no path** |
| A15 | no skills | `add "deploy" --command "c" --purpose "p" --workspace` | `scope: "workspace"` in the payload |
| A16 | no skills | `add "deploy" --command "c" --purpose "p" --why "w"` | refused by name |
| A17 | no skills | `add "deploy" --command "d {{ tag }}" --purpose "p"` | refused, naming the malformed placeholder |
| A18 | no skills | `add "deploy" --command "d {{tag}} {{env_name}}" --purpose "p"` | recorded; `show` lists `tag`, `env_name` |
| A19 | index tier full | `add …` | refused until `--demote` names what frees the room |
| A20 | no skills | `add "deploy" --command "<a token-shaped literal>" --purpose "p"` | refused by the sanitizer's credential rule; nothing recorded |
| A21 | no skills | `add "deploy" --command "<a line naming an absolute path under $HOME>" --purpose "p"` | refused by the sanitizer's home rule |
| A22 | one skill | the append | exactly one `entity.confirmed`; the run writes no event type the vocabulary lacks |
| A23 | one skill | `self fold` | no `skill/` directory; the state directory gains no folder |
| A24 | no skills | `add "deploy" --command "c" --purpose "p" --project other` | refused — a write verb takes no read scope |
| A25 | no skills | `add "deploy" --command "<two lines>" --purpose "p"` | refused, naming `--file` — a skill is one line |

## 4.2 Group B — reading

| Cell | State | Action | Expected |
|---|---|---|---|
| B1 | one command skill | `skill show deploy` | name, purpose, scope, version, the command line, exit 0 |
| B2 | one command skill | `skill show <id>` | identical to B1 |
| B3 | one command skill | `skill show <id prefix>` | identical to B1 |
| B4 | none | `skill show deploy` | refused, naming `self skill` |
| B5 | one file skill | `skill show recipe` | the recipe's text inline, plus the `self artifact open` pointer |
| B6 | one file skill, bytes pruned | `skill show recipe` | the record, the pointer and the pruned line; **exit 0** |
| B7 | two skills | `skill list` | both rows: id, name, scope, purpose |
| B8 | none | `skill list` | says so, names `skill add`, exit 0 |
| B9 | a workspace skill in A | `skill list` in B | listed, marked `workspace` |
| B10 | a project skill in A | `skill list` in B | not listed |
| B11 | a project skill in A | `skill list --project A` from B | A's skills |
| B12 | a project skill in A | `skill show <name> --project A` from B | A's skill |
| B13 | one skill | `self search deploy --all` | found — it is a record like any other |
| B14 | one skill | `self state show <id>` | the ordinary entity page: text, labels, placement |

## 4.3 Group C — the name, replacement and shadowing

| Cell | State | Action | Expected |
|---|---|---|---|
| C1 | project `deploy` v1 | `add "deploy" --command "new" --purpose "p"` | one `entity.proposed` with `supersedes: <v1>`; **v1 still answers**; the receipt prints the confirm |
| C2 | after C1 | `self context` | the proposal waits on a person; `## Skills` still shows v1 |
| C3 | after C1 | `self state confirm <new id>` | v1 `superseded`, head = v2 |
| C4 | after C1, piped | `self state confirm <new id>` | lands — no confirm path is gated today |
| C5 | after C3 | `skill show deploy` | v2's line; the Versions block names v1 and v2 |
| C6 | project `deploy` v1 | `add "deploy"` restating the identical line and purpose | refused; nothing recorded |
| C7 | project `deploy` v1 (command) | `add "deploy" --file r.md --purpose "p"` | proposed; v2 is a file skill and v1 stays in the chain |
| C8 | v1 → v2 | `skill show <v1 id>` | answers with the head |
| C9 | workspace `deploy` v1 | `add "deploy" --command "new" --purpose "p" --workspace` | proposed against the workspace record |
| C10 | workspace `deploy` in A | `add "deploy" --command "x" --purpose "p"` in B | a new **confirmed** record in B, no supersedes link, **no terminal needed**; the shadow notice |
| C11 | after C10 | `skill show deploy` in B | B's own |
| C12 | after C10 | `skill list` in B | both rows; the workspace one marked `(shadowed here)` |
| C13 | after C10 | `skill show deploy` in project C | the workspace one, unshadowed |
| C14 | project `deploy` exists | `add "deploy" --command "x" --purpose "p" --workspace` | the workspace record is created; the notice says the project one still answers here |
| C15 | after C14 | `skill drop deploy --why "w"` here, at a terminal | drops the project one; the workspace one then answers here |
| C16 | v1 → v2 | `add "deploy" …` again | the proposal supersedes **v2**, the version that holds |
| C17 | two skills whose ids share a prefix | `skill show <that prefix>` | refused as ambiguous, naming how many it reached |
| C18 | a proposal already waiting | `add "deploy" …` again | a second proposal against the version that holds; the standing one still answers; confirming either lands it |

## 4.4 Group D — dropping

| Cell | State | Action | Expected |
|---|---|---|---|
| D1 | one skill, terminal, exact answer | `skill drop deploy --why "w"` | `entity.retracted`; leaves `self skill` and `## Skills` |
| D2 | one skill, piped | `skill drop deploy --why "w"` | refused by the retirement gate, handing the line a person runs; nothing recorded |
| D3 | one skill, terminal, wrong answer | `skill drop deploy --why "w"` | refused; nothing recorded |
| D4 | one skill | `skill drop deploy` | refused by the requirement gate, naming `--why` |
| D5 | none | `skill drop deploy --why "w"` | refused, naming `self skill` |
| D6 | one skill | `skill drop <id> --why "w"` | identical to D1 |
| D7 | dropped | `skill drop deploy --why "w"` again | refused — already withdrawn |
| D8 | one skill | `skill drop deploy --workspace --why "w"` | refused by name |
| D9 | one skill | `skill drop deploy --command "c" --why "w"` | refused by name |
| D10 | a live file skill | `self artifact prune <a-id> --why "w"` | refused by `referenceRefusal`, naming the skill |
| D11 | a dropped file skill | `self artifact prune <a-id> --why "w"` | admitted — no live record points at it |
| D12 | a workspace skill owned by another project | `skill drop deploy --why "w"` here | refused, naming the project whose log holds it and the shadow that answers instead |

## 4.5 Group E — `self context`

| Cell | State | Action | Expected |
|---|---|---|---|
| E1 | no skills | `self context` | no `## Skills` header; the page is byte-identical to before the feature |
| E2 | one project skill | `self context` | one row: name, purpose, the show pointer |
| E3 | a workspace skill in A | `self context` in B | the row, marked `(workspace)` |
| E4 | a shadowed pair | `self context` in B | **one row**, marked `(shadows a workspace skill)` |
| E5 | one skill | `self context` | the command line is **absent** — name, purpose and pointer only |
| E6 | more skills than the budget holds | `self context` | the section collapses to the counted omission row naming `self skill` |
| E7 | one skill | `self search deploy` | **no matches** — the default membership is "live and not shown in context", and context showed it |
| E8 | one skill | `self context --pretty` | the section renders in the terminal form too |
| E9 | a proposed replacement standing | `self context` | it waits on a person and is **not** a `## Skills` row |
| E10 | one skill | `self context` | the skill is not also in `## Index` — one record, one block |

E1's byte-identity half is the committed golden fixture: its scenario registers
no skill, so `test/fixtures/golden/piped.txt` pins `self context` for a
skill-free project byte for byte. Regenerating it for this branch changed only
the root `self --help` block, which gained the four `skill` usage lines.

## 4.6 Group F — the trust surface

| Cell | State | Action | Expected |
|---|---|---|---|
| F1 | one skill | `self skill run deploy` | refused, naming `skill show`; nothing executed, nothing recorded |
| F2 | any | `self skill --help` and `self --help` | carry no `skill run` — the refusal is reachable, the promise is not made |
| F3 | one skill | `skill show deploy` | exit 0, the line on stdout, nothing appended |
| F4 | a `{{tag}}` skill | `skill show deploy` | the line **verbatim**, placeholders intact, plus the placeholder list |
| F5 | a `{{tag}}` skill | `skill show deploy --arg tag=v1` | refused as an unknown option |

## 4.7 Group G — project scope and the resolver

| Cell | State | Action | Expected |
|---|---|---|---|
| G1 | — | `skill add` in an unregistered directory | refused by the project resolver |
| G2 | archived project | `skill add` | refused by the append gate |
| G3 | archived project | `skill list --project <archived>` | reads, with the archived notice beside it |
| G4 | — | `self alias add skill --label x` | refused — `skill` is a reserved root verb |
| G5 | — | the plugin/alias collision guard | `skill` is in the built-in verb list `main.ts` registers with both guards |

G5 asserts the membership rather than driving `self app install`: both guards
are registered from `COMMANDS.map(name)`, and the `verb_reserved` refusal that
membership produces is driven end to end by cell 12 of
`apps/cli/test/pr7-loader.test.mjs`, which needs the signed-release harness.

## 4.8 Group H — an ordinary record

| Cell | State | Action | Expected |
|---|---|---|---|
| H1 | a file skill | `self store size` | the recipe's bytes are counted like any other artifact |
| H2 | a confirmed replacement | `self undo <the entity.confirmed that landed it>` | **refused** — that event is an acceptance, and an acceptance is not taken back |
| H3 | a first registration | `self undo <that entity.confirmed event>` | **refused** — a creation with no supersedes link is not undoable; the refusal names the four kinds that are |
| H4 | a dropped skill | `self undo <the entity.retracted event>` | the skill stands again |
| H5 | one skill, a work unit | `self handoff <work-id>` | the skill is in the packet's context section and **not** in the conventions closure |

H2's designed expectation was "the supersession is taken back". The shipped
outcome is a refusal, and the refusal is correct: a replacement lands through
`self state confirm`, whose event is an `entity.confirmed` carrying
`refs.confirms`, which `refuseAcceptanceUndo` (#356) refuses. The cell is
recorded here as the baseline #390 would change, which is what H2–H4 exist for.

## 4.9 Coverage of the raw product

| Raw dimension | Where it is covered |
|---|---|
| project × command × new × add | A2 |
| project × file × new × add | A9 |
| workspace × command × new × add | A15 |
| workspace × file × new × add | A15 + A9 (the scope and the kind are independent payload fields; one cell each, not a cross) |
| project × command × exists-same-scope × add | C1, C3, C5, C6, C16, C18 |
| project × file × exists-same-scope × add | C7 |
| workspace × any × exists-same-scope × add | C9 |
| project × any × exists-other-scope × add | C10–C13 |
| workspace × any × exists-other-scope × add | C14, C15 |
| any × command × any × show | B1–B4, C17 |
| any × file × any × show | B5, B6 |
| project × — × — × list | B7, B8, B10 |
| workspace × — × — × list | B9, B12 |
| any × any × exists × drop | D1–D9 |
| any × any × new × drop | D5 |
| any × file × any × drop | D10, D11 |

Degenerate combinations, and why no cell exists: `list` takes no name and no
kind, so name-state × kind against `list` is one cell not sixteen; `drop`
resolves a name and never reads the body, so kind against `drop` collapses to
the artifact-lifetime pair D10/D11; and `re-add` is `add` at the
`exists-same-scope` name state, which is where group C lives.

## Explicit exclusions

- **Execution of any kind** — `skill run`, `--exec`, a runner, a timeout, an
  exit-code receipt.
- **Placeholder substitution** — `--arg`, `--set`, environment interpolation,
  defaults, required/optional placeholder metadata.
- **Composition** — a skill calling another skill, or a runbook stage naming a
  skill.
- **Scheduling, watching, auto-dispatch.** Nothing here calls anything.
- **A generated fold page per skill** (`skill/<id>.md`). Cell A23 pins its
  absence.
- **Publishing beyond the workspace.** Sync is the store's existing sync.
- **Agent-harness skill formats** — Claude Code skills, MCP, `.claude/skills/`.
  `--file` holds any text and the store knows nothing about its shape.
- **A `--supersedes` flag.** The name does the matching. Replacing across scopes
  is `drop` then `add`.
- **Blocking the raw-verb bypass.** `self state add --label skill …` can mint a
  malformed skill. Accepted, in the words the runbook table used: "a raw verb
  can always bypass the verb above it."
- **Name uniqueness across the workspace.** Two projects each naming a skill
  `deploy` is not a collision anything resolves through.
- **Making an unconfirmed skill proposal undoable.** #390's call.
- **Requiring `--purpose` to be short.** The retention cap already prices a long
  one, and `oneLine` folds it in the index row.
