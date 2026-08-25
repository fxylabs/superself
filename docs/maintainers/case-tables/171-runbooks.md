# Case table — resumable runbooks (#171)

The design artifact for #171, written before the code. Every cell below is one
test, named by its cell id, asserting that cell's stated outcome. The table is
the review surface: a cell the table lacks is a path nothing proves.

The issue ships in two parts. Part 1 (#379) registers procedures and runs them;
part 2 (#171) adds the human approval checkpoint, stopping and resuming a run,
and the link to work units.

Where the tests live:

| Group | Cells | Part | File |
|---|---|---|---|
| A — the definition | 25 | 1 | `apps/cli/test/runbook.test.mjs` |
| B — starting a run | 11 | 1 | `apps/cli/test/runbook.test.mjs` |
| C — advancing a run | 13 (C1–C9, C8b, C13–C15) | 1 | `apps/cli/test/runbook.test.mjs` |
| C — linking work | 3 (C10–C12) | 2 | `apps/cli/test/runbook.test.mjs` |
| D — the approval checkpoint | 14 | 2 | `apps/cli/test/runbook-approval.test.mjs` |
| E — stopping and resuming | 11 | 2 | `apps/cli/test/runbook.test.mjs` |
| F — editions and drift | 10 | 1 | `apps/cli/test/runbook.test.mjs` |
| G — project scope | 5 | 1 | `apps/cli/test/runbook.test.mjs` |

**91 designed cells, 92 as shipped.** 64 in part 1, 28 in part 2.

E11 is the one cell added during implementation: the designed table checked
`resume` only where it is refused (E2), leaving the verb's own success path
unproven. It is recorded here rather than left as an untabled test.

## The problem

A recurring procedure — plan a story, draft assets, draft the room, render,
review, approve, register, publish, measure, learn — lives nowhere as one
record. It is scattered across a few decisions, a convention and some reports,
so every new session has to be told the procedure again, and nothing says which
piece of work is on which stage of it.

## The mechanism

Nothing new is minted. Everything below is composed out of the `entity.*`
grammar that already exists: **no new event type, no new reducer, no new
reserved metadata key, no new row in `BUILTIN_ROWS`.**

| The thing | The machine it is made of |
|---|---|
| A definition | an entity labelled `runbook`, its stages in the reserved metadata `criteria`, declaration order = run order |
| An edition (v1, v2, …) | the record's place in the `supersedes` chain — **derived, never stored** |
| The stable workflow id | the chain's **root** id |
| The stages' fingerprint | sha256 of the stages, first twelve characters — derived on every read |
| A revision | `entity.proposed` carrying the new `criteria` and a `supersedes` link; `self state confirm` lands it |
| A run | an entity labelled `runbook-run` + its key, its stages **copied**, `member-of` the edition it started under |
| Passing a stage | one `entity.covered` through the writer `self state cover` already uses |
| Closing a run | `self state done <id> --report r` — no completion verb of its own |
| Withdrawing either | `self state retract <id> --why w` |
| Giving a run up | `entity.retired` through the retirement gate — a person at a terminal, exactly as `state retire` |

### Why `entity.revised` cannot be the revision

`collectRevision` carries `text` and `why` only, and `criteria` is read once at
creation. A revision event would therefore leave the stages exactly as they
were. And `entity.plan` (the v1/v2 counter) is derived for work proposals
alone: making a label entity look like one would put `applyPlans` in the way,
sending the record back to `proposed` on every revision.

### Why the labels are not preset rows

`BUILTIN_VERBS` is `Object.keys(BUILTIN_ROWS)`, so a row there would mint
`self run` and `self runbook-run` as root verbs — recording a "run" with no
procedure behind it and no stages. The placement rows are module-local
constants in `runbook.ts`, the way `DERIVATION_ROW` is in `derivation.ts`. The
label is `runbook-run` rather than `run` because `run.*` is already the attempt
namespace and `self work run` is already a process.

### Why a run is confirmed rather than proposed

`requireCoverable` refuses coverage on a record that is still proposed, so a
proposed run could not pass its own first stage. Starting a run is a statement
that the project is following the procedure now, which is not a question to put
to anyone. Cell B10 is the gate.

## Corrections to the design as reviewed

Two cells were written against behaviour the code does not have, and are
recorded here as corrected rather than silently dropped:

| Cell | As designed | As implemented, and why |
|---|---|---|
| A12d | confirming a revision from a pipe is refused by the destruction gate | **It lands.** `state confirm` reaches `recordEvents` directly — no confirm path in the CLI routes through `recordRetirement`, so no terminal gate stands there today. `state confirm` is the person's verb by convention, and the supersession lands with it. Making it gate would change every proposal that carries `--supersedes`, which is outside this issue. |
| A17 / C15 | pages at `runbook/<id>.md` and `run/<id>.md` | `runbook/<root-id>.md` and `runbook-run/<id>.md`. The procedure's page is named by the chain's **root**, so a new edition rewrites the page a reader already has rather than leaving one page per edition; the run folder is named for the label it holds. |

## Group A — the definition

| Cell | State | Action | Expected |
|---|---|---|---|
| A1 | no runbooks | `self runbook` | says so, names `runbook add`, exit 0 |
| A2 | no runbooks | `runbook add "loop" --stage a --stage b --stage c` | one definition, `e-` id, edition v1 |
| A3 | no runbooks | `runbook add "loop"` | refused — a runbook is its stages |
| A4 | no runbooks | `--stage a --stage a` | refused, naming the repeat |
| A5 | no runbooks | `--file <doc with a list>` | the list items become the stages, in order |
| A6 | no runbooks | `--file <doc with no list>` | refused, naming `--stage` |
| A7 | no runbooks | `--file <missing>` | refused, naming the path |
| A8 | no runbooks | `--file <absolute path outside the project>` | read; the record carries the stages and **no path** |
| A9 | no runbooks | `--stage a --file f` | refused — a procedure has one stage list |
| A10 | one definition | `runbook show <id>` | name, edition, stages, runs |
| A11 | one definition | `runbook show <name>` | identical to the id form |
| A12 | v1 | `runbook revise <id> --stage … --why w` | one `entity.proposed`, `supersedes: <v1>`, new criteria; **v1 still holds**; the receipt prints the confirm |
| A12b | after A12 | `self context` | the proposal waits on a person |
| A12c | after A12 | `self state confirm <new id>` | v1 becomes `superseded`, `supersededBy` names the new id, head = v2 |
| A12d | after A12, piped | `self state confirm <new id>` | **lands** — see the corrections above |
| A12e | after A12c | `runbook show <root id>` | the whole chain, head named; the root id is the stable workflow id |
| A13 | v1 | `revise` with the same stages | refused, nothing recorded |
| A14 | v1 | `revise` with no `--why` | refused by the requirement gate |
| A15 | v1 | `self state retract <id> --why w`, at a terminal | withdrawn; leaves `self runbook` |
| A16 | v1 | `self search <name>` | found — it is a record like any other |
| A17 | v1 → v2 | fold | one page at `runbook/<root>.md`, no page per edition |
| A18 | no runbooks | fold | no `runbook/` directory; the state directory is byte-identical |
| A19 | index tier full | `runbook add` | refused until `--demote` names what frees the room |
| A20 | v1 → v2 | `revise <v1 id>` | the proposal supersedes **v2**, the edition that holds |
| A21 | any | `self run …` / `self runbook-run …` | unknown command; neither is in `self --help` |

## Group B — starting a run

| Cell | Definition | Run | Action | Expected |
|---|---|---|---|---|
| B1 | none | — | `start e-missing --instance E001` | refused, naming `self runbook` |
| B2 | v1, 3 stages | none | `start <id> --instance E001` | one run, 3 stages copied, on stage 1 |
| B3 | v1 | E001 | the same command again | refused, naming the run that holds the key |
| B4 | v1 | none | `start` with no `--instance` | refused, naming the flag |
| B5 | v1 | none | `--instance "   "` | refused |
| B6 | v1 | E001 | `--instance E002` | two runs, independent state |
| B7 | v1 | E001 closed | `--instance E001` | refused — a finished key is not reused |
| B8 | withdrawn | — | `start` | refused — no edition holds |
| B9 | v1 | none | `start`, then `self context` | one row: key, name, edition, `n/m`, stage, next, the show command |
| B10 | v1, 3 stages | none | `start` then `advance --why w` | **passes** — the run was recorded confirmed |
| B11 | v1 → v2 | none | `start <root id> --instance E003` | v2's stages copied; `member-of` names v2 |

## Group C — advancing a run

| Cell | Run | Action | Expected | Part |
|---|---|---|---|---|
| C1 | 1/3 | `advance E001 --why w` | stage 1 passed, now on stage 2 | 1 |
| C2 | 1/3 | `advance --to <stage 1> --why w` | identical to C1 | 1 |
| C3 | 1/3 | `advance --to <stage 3> --why w` | refused, naming what would be skipped | 1 |
| C4 | 1/3 | `advance --to <not a stage> --why w` | refused, listing the run's stages | 1 |
| C5 | 1/3 | `advance` with no `--why` | refused by the requirement gate | 1 |
| C6 | on the last stage | `advance --why w` | passed; the run is **not** done for it | 1 |
| C7 | every stage passed | `advance --why w` | refused, naming `self state done … --report` | 1 |
| C8 | every stage passed | `self state done <id> --report r` | closed; leaves `## Runbooks` | 1 |
| C8b | every stage passed | `self state done <id>` | refused by the evidence gate | 1 |
| C9 | 1/3 | `advance --to <stage 1>` twice | the second is refused | 1 |
| C10 | 1/3 | `runbook link E001 --work w-…` | one `entity.linked relates`; the work shows on `runbook show` | 2 |
| C11 | 1/3 | `link --work <unknown>` | refused | 2 |
| C12 | 1/3, one work linked | `link --work <another>` | two links — one or more is allowed | 2 |
| C13 | 1/3 | `runbook show <definition>` | every run with the stage it is on | 1 |
| C14 | 1/3 | `self log` | the `entity.covered` line reads back | 1 |
| C15 | 1/3 | fold | `runbook-run/<id>.md` shows which stages are passed, when and why | 1 |

## Group D — the approval checkpoint (part 2)

| Cell | Run | Action | Expected |
|---|---|---|---|
| D1 | in progress | `runbook hold E001 --why w` | `entity.blocked on:"approval"` |
| D2 | held | `self context`, piped | one waiting row + `self runbook approve E001` |
| D2b | held | `self context`, terminal | the same row in the terminal render |
| D3 | held | `advance --why w` | refused, naming the approval |
| D4 | held, piped | `runbook approve E001 --by p` | refused — not a terminal |
| D5 | held, `SUPERSELF_SESSION` set | `approve` | refused — an agent's mark |
| D6 | held, terminal, wrong answer | `approve` | refused, nothing recorded |
| D7 | held, terminal, exact answer | `approve` | `entity.unblocked`; the typed value is in the payload |
| D8 | after D7 | `advance --why w` | passes |
| D9 | not held | `approve` | refused in the words `state unblock` already uses |
| D10 | held | `hold` again | refused in the words `state block` already uses |
| D11 | after D7 | `self log` | the block and the unblock both read back |
| D12 | any | `self --help` | carries no `approval-required` — the retired name stays retired |
| D13 | a non-runbook entity blocked `on:"approval"` | `self context` | **no waiting row** — the gap this issue does not close |

## Group E — stopping and resuming (part 2)

| Cell | Run | Action | Expected |
|---|---|---|---|
| E1 | 2/11 | `runbook stop E001 --why w` | `entity.retired`; leaves `## Runbooks`. Goes through the retirement gate, so a person confirms it at a terminal — giving up a run destroys a live outcome, and `state retire` and `work retire` are gated for the same reason |
| E2 | stopped | `runbook resume E001` | refused — retirement is terminal |
| E3 | stopped | `advance --why w` | refused — terminal |
| E4 | 2/11 | `stop` with no `--why` | refused by the requirement gate |
| E5 | held | `stop --why w` | stopped |
| E6 | closed | `stop --why w` | refused — terminal |
| E7 | stopped | `runbook show <definition>` | the run is shown as stopped |
| E8 | stopped | `self log` | the retirement reads back |
| E9 | in progress, a fresh session | `self context` | stage, next action and the inspect command are all there |
| E10 | started, no stage passed | `stop --why w` | stopped |
| E11 | in progress, then held | `resume` | picks a parked run back up; a held one is refused, naming `runbook approve` |

## Group F — editions and drift

| Cell | Definition | Run | Action | Expected |
|---|---|---|---|---|
| F1 | v1 only | on v1 | `self context` | no drift note |
| F2 | v1 → v2 | on v1 | `self context` | `v1 (the definition is on v2)` |
| F3 | as F2 | — | `runbook show <root>` | the chain, and which run follows which edition |
| F4 | as F2 | on v1 | `advance --why w` | **passes** — the difference is shown, not blocking |
| F5 | as F2 | new run | `start` | v2's stages copied; no drift note |
| F6 | v1 → v2 → v3 | on v1 | `self context` | `v1 (the definition is on v3)` |
| F7 | head withdrawn | in progress | `self context` | the run still renders — it holds its own stages |
| F8 | as F7 | in progress | `advance --why w` | passes |
| F9 | v1 → v2 with the same stages | on v1 | `self context` | **no drift note** — the fingerprint did not move |
| F10 | a revision proposed, not confirmed | on v1 | `self context` | still v1; the proposal shows only as a waiting row |

## Group G — project scope

| Cell | State | Action | Expected |
|---|---|---|---|
| G1 | a runbook in project A | `self runbook` in B | A's runbook is not listed |
| G2 | — | `runbook add` in an unregistered directory | refused by the project resolver |
| G3 | archived project | `runbook add` | refused by the append gate |
| G4 | a runbook in A | `self runbook --project A` | read verbs take the scope flag |
| G5 | — | `runbook add --project B` | refused — a write verb takes no read scope |

## Explicit exclusions

Scheduling, auto-dispatch and any automatic execution. Runs that cross project
boundaries. Per-stage assignees. Conditional branches and parallel stages —
the order is linear. Binding the spec file as an artifact and pinning it by
digest. Blocking the bypass where `self state cover` passes a stage directly
(a raw verb can always bypass the verb above it). Instance keys unique across
the workspace. Extending the fold so `entity.revised` can carry criteria.
Showing the approval wait of a non-runbook entity (cell D13 fixes the current
behaviour). A completion verb of `runbook`'s own (cell C8).
