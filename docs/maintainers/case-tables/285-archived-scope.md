# Case table — a record scoped to a project archived afterwards (#285)

The design artifact for #285. Every test in
`apps/cli/test/archived-scope.test.mjs` is one cell below, named by its cell
number, and asserts that cell's stated outcome. The table is the review
surface: a cell the table lacks is a path nothing proves.

Cells 1 to 3 are the table issue #285 was accepted with. Cells 4 to 13 extend
it along what the commands resolve from outside their arguments. Cells 14 to 23
close the state space around the report; 22 and 23 were added by the
self-adversarial pass after the first twenty-one were green.

## The defect

`#283` gave a project an archived state and took it out of the default listing,
`self context` and every `--workspace` aggregate. A record whose `--scope` names
a project archived *after* the record was placed keeps pointing at it: the
scope resolver refuses `--scope <archived-slug>` at write time, so only records
placed before the archive reach this state. The record then renders in no
project's context — its own project does not render it, because it is scoped
elsewhere, and the project it is scoped into is out of every aggregate — and
nothing named it. It was silently unreachable rather than visibly misplaced.

## What the read resolves from outside its arguments

| Read                              | Where it comes from                                        | Cells that run it from outside that context |
|-----------------------------------|------------------------------------------------------------|---------------------------------------------|
| which project the read answers for | `process.cwd()`, or `--project <slug>`, or `--workspace`   | 4 (from the workspace root), 5 (from the archived project's own checkout), 6 and 7 (the workspace forms), 11 (from a third project's checkout) |
| whether the scope target is archived | `paths.ts` `projectArchive` — the one archived-state reader every aggregate answers from | 2, 12 (after `project restore`), 21 (archived, restored, archived again) |
| whether the record is live at all  | the record's own fold — proposed or confirmed              | 18 (withdrawn), 23 (a proposal) |
| where the record's events live     | the home project's log, which is what `state place` moves from | 13 (the move), 17 (a record whose own project is the archived one), 22 (that project archived as well) |

## Rules the cells are derived from

1. `reachability.ts` `archivedScopeSignals(storeDir, slug, entities)` reads a
   project's own live records, resolves each one's scope with
   `entities.ts` `scopeTarget`, and raises one health signal per record whose
   target is a *registered* project that `paths.ts` `projectArchive` says is
   archived. A target equal to the record's own project, the sentinel
   `workspace`, and a slug this workspace never registered all raise nothing.
2. The line names the record id, the slug, and both ways out:

   ```text
   <id> renders in "<slug>", which is archived, so it renders nowhere —
   run `self project restore <slug>` to bring it back,
   or `self state place <id> --scope <slug>` to move it somewhere active
   ```

3. The signal is computed at read time, in `views.ts` `withVerdicts` and
   `contextView`, beside the artifact check and for the same reason: archiving
   one project folds that project alone, so the record's own project is not
   refolded and a signal persisted by its last fold would say whatever was true
   then. Derived at read time, `project restore` clears the line with no
   bookkeeping of its own.
4. It is appended after the verdict and artifact signals, so with nothing
   archived every existing line keeps its text and its order.
5. A scope naming a slug this workspace never registered stays what it already
   was: the dangling-scope line `self project` prints (#181 T3.10). The two
   reports are about different states and never both fire for one record.

## Cells

State variables: where the record's scope points (its own project · another
active project · an archived project · `workspace`) × the target project's
state (active · archived · restored) × the record's own state (live · not
live) × the directory the read runs in (the record's own checkout · the
archived project's checkout · a third project's checkout · the workspace root)
× the form of the read (bare · `--project <slug>` · `--workspace`).

`alpha` holds the record, `beta` is the project it is scoped into and archived,
`gamma` is a bystander that must never answer for either.

| #  | State                                                     | Operation                                                    | Expected outcome |
|----|-----------------------------------------------------------|--------------------------------------------------------------|------------------|
| 1  | record placed in alpha scoped to beta, beta then archived | `self status`, in alpha's checkout                            | health names the record id and "beta", says it renders nowhere, and names both ways out |
| 2  | same, after `self project restore beta`                   | `self status`, in alpha's checkout                            | health: ok, and the record renders in beta's context again |
| 3  | no archived project anywhere                              | `self status`, in alpha's checkout                            | byte-identical to the same read with no such record at all |
| 4  | same as 1                                                 | `self status --project alpha`, from the workspace root        | the same line in the same words — the answer does not depend on the directory |
| 5  | same as 1                                                 | `self status --project alpha`, from beta's own checkout       | the same line — standing in the archived project changes nothing about what alpha answers |
| 6  | same as 1                                                 | `self status --workspace`, from the workspace root            | alpha's row carries one health signal; beta has no row at all (#283) |
| 7  | same as 1                                                 | `self status` with no flag, from the workspace root           | the same rows as cell 6 — a bare read from outside every project is the workspace form |
| 8  | same as 1                                                 | `self context`, in alpha's checkout                           | a `## Health` section carrying the same line |
| 9  | same as 1                                                 | `self context --project alpha`, from the workspace root       | the same section and the same line |
| 10 | same as 1                                                 | `self context` with no flag, from the workspace root          | alpha's row carries one health signal |
| 11 | same as 1                                                 | `self status`, in gamma's checkout                            | health: ok — the record is alpha's, and only alpha answers for it |
| 12 | same as 1                                                 | `self project restore beta`, from alpha's checkout            | beta is back and alpha's next read is clean — the way back runs from where the line is read |
| 13 | same as 1                                                 | `self state place <id> --scope alpha`, from alpha's checkout  | the record moves home, the line goes, and beta stays archived |
| 14 | record in alpha scoped to `workspace`, beta archived      | `self status`, in alpha's checkout                            | not reported — a workspace record renders in every active project, so archiving one takes nothing from it |
| 15 | same as 1                                                 | `self project`, from the workspace root                       | no dangling-scope line — a dangling scope is a slug that is not registered, an archived one is registered, and the two reports do not double up |
| 16 | record in alpha scoped to its own project, alpha archived | `self status --project alpha`                                 | not reported — the record went with its own project (#283) |
| 17 | record in the archived beta scoped to active alpha        | `self status`, in alpha's checkout                            | not reported — every record of an archived project goes with it (#283), which is that table's cell |
| 18 | the record of cell 1 retracted, then beta archived        | `self status`, in alpha's checkout                            | not reported — a withdrawn record renders nowhere by its own state |
| 19 | two records in alpha scoped to beta, beta archived        | `self status`, in alpha's checkout                            | both named, one line each, each naming its own id |
| 20 | a work unit in alpha scoped to beta, beta archived        | `self status`, in alpha's checkout                            | named the same way — the report is about a placed record, and a work unit is one |
| 21 | beta archived, restored, then archived again              | `self status`, in alpha's checkout                            | reported again, exactly once — the report is derived from current state and nothing survives the round trip |
| 22 | same as 1, and alpha archived too                         | `self status --project alpha` / `self context --project alpha` | still named — an archived project is read by naming it (#283), and naming it must not silence the line |
| 23 | a proposal, not a confirmed record, scoped to beta        | `self status`, in alpha's checkout                            | named the same way — a proposal in an archived project cannot be confirmed there either |

## Out of scope

- **The generated HTML workspace page.** It renders an archived project's
  ordinary card, because it is built from the per-project summary files rather
  than from the registry and never consults `paths.ts` `activeProjects`. The
  view is not a maintained surface (decision `01kzn90ypkh3djsns3y684qfyt`) and
  nothing here is scoped against it.
- **Re-placing the record automatically.** Reporting it is the change; moving
  it is the person's call, and cell 13 is that call being made.
- Anything the #283 table already covers — cells 16 and 17 mark that boundary
  rather than crossing it.
