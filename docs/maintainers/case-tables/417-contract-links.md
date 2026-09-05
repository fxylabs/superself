# Case table — standalone and assumed-decision links (#417, PR a of 3)

Written before the code, and the review surface for it: a cell this table lacks
is a path nothing proves. Every test in `apps/cli/test/contract-links.test.mjs`
is one cell below, named by its cell number. Cells that belong to another file
say which file.

This is part (a) of the three-part delivery the approved #417 design v2.1
sequences. It ships the link model, the commands and the guidance for record
selection, explicit standalone disposition, operational run links and milestone
assumptions. It ships none of PR(b) — carry, mutation guards, proposal
retarget, date rules, judgment provenance and recheck — and none of PR(c) —
`self objective check`, its seven findings and the health summary. Nothing this
branch adds may advertise a command those parts have not shipped.

## The defect this part answers

Issue #417 records four observed graph inconsistencies. Two of them are what
part (a) is aimed at:

| Observed | What the store could not say |
|---|---|
| Work stayed on a superseded milestone | Nothing distinguishes "contributes to nothing on purpose" from "nobody stated a contribution yet", so neither a person nor a later pass can tell an intentional standalone unit from an unattached one |
| An active milestone retained old architecture assumptions | A milestone cannot name the decisions it assumes, so an assumption that a later decision replaced leaves no edge to withdraw |

`self work link` accepted `--objective` and `--milestone` and nothing else.
`self milestone` had no link verb at all. The reader-facing guidance said "a
unit states what it contributes to" and offered no third answer, so an agent
whose unit genuinely contributes to no current outcome had nothing to record.

## The rulings this implements

| # | Question | Decision |
|---|---|---|
| R1 | What carries a standalone disposition? | **An `entity.linked` edge, `standalone`, whose target is the work's own id.** The edge identity in this fold is `(type, target)`, so a self-target is the one spelling that is a singleton per work by construction, round-trips through `entity.unlinked` unchanged, and needs no second key |
| R2 | Where does the reason live? | **On the link object**, as `why`, read by the same `readLinks` guard every other link field goes through. Not a payload sibling: a reason that sat beside the link would not survive a creation payload carrying several links |
| R3 | What is the declaration provenance? | **The declaring event's timestamp**, stamped onto the projected link as `declared` by the pass that applies it. The log already holds who wrote it; the projection needs when it was stated so `work show` can say it |
| R4 | What carries an assumption? | **An `assumes` edge from the milestone to the decision.** Additive and repeatable — a milestone assumes as many decisions as it names — so replacing one is link-the-successor then unlink-the-old, and nothing erases an unrelated assumption |
| R5 | Does this need a new event type? | **No.** `entity.linked` and `entity.unlinked` carry both new types. The design forbids a new event type and the vocabulary proof in `docs.test.mjs` would have to grow for one |
| R6 | May a requirement offer a boolean alternative? | **Yes, when it is not the only alternative.** `checkRequiredFlag` refused every boolean because a requirement naming one flag that is absent-or-true demands nothing. That reasoning does not reach `--objective\|--milestone\|--standalone`, where a caller has three ways to satisfy one requirement |

## Rules the cells are derived from

1. **A work unit's disposition is stated, never inferred.** Contribution edges,
   an explicit standalone declaration with a reason, or an inbound `relates`
   edge from a runbook run. A unit with none of the three is not refused —
   nothing here forces a methodology — it is simply a unit nobody has said
   anything about yet.
2. **Standalone does not conceal a contribution.** Declaring it neither removes
   nor hides an existing `member-of` edge. Moving a unit off an obsolete
   outcome is two statements: unlink the edge, then declare standalone.
3. **A withdrawal is the same edge, unlinked.** `work unlink --standalone`
   names no target of its own and takes back exactly the edge the declaration
   wrote. The events stay in the log, so a unit that was standalone and later
   contributed still shows both statements in its own history.
4. **One edge is one link.** Declaring an edge the record already carries is
   refused by name rather than appending a second event nothing distinguishes.
   This is the rule `self runbook link` already states.
5. **`--why` states one reason.** `work add --why` and `work propose --why`
   already mean "why the superseded unit gave up its outcome". A call that
   would make one `--why` answer for both a supersession and a standalone
   declaration is refused and told the two-step spelling.
6. **Every advertised command exists in this part.** The CLI help, the managed
   block `connect.ts` generates and the plugin's own guidance name the same
   commands, and each is dispatchable on this branch.

## Production surfaces

| Surface | What changes |
|---|---|
| `apps/fold/src/entities.ts` | `LINK_TYPES` gains `standalone` and `assumes`; `EntityLink` gains `why` and `declared`; `readLinks` reads a link's reason; the creation and link passes stamp provenance |
| `apps/fold/src/model.ts` | `WorkState.standalone` projected from the self-targeted edge |
| `apps/fold/src/objectives.ts` | `MilestoneState.assumes` — the decision ids a checkpoint names, in edge order |
| `apps/cli/src/goals.ts` | `work link/unlink --standalone --why`; `work add`/`work propose --standalone --why`; `milestone link/unlink --decision`; `milestone add/revise --decision`; the standalone offer on the post-add attachment listing |
| `apps/cli/src/state.ts` | `requireDecision`/`holdsDecision` move here from `main.ts` so both callers read one lookup — a move with no behavior change |
| `apps/cli/src/contract.ts` | `checkRequiredFlag` admits a boolean that is one alternative among several |
| `apps/cli/src/fold.ts` | `work show` states a standalone disposition; `milestone show` lists what it assumes |
| `apps/cli/src/main.ts` | the `work` and `milestone` usage lines, descriptions and flag glossaries |
| `apps/cli/src/guide.ts` | `self help work` and `self help goals`, including the record-kind list a reader chooses from |
| `apps/cli/src/connect.ts` | the managed block's record-selection and link lines |
| `apps/dsh-plugin/src/tools.ts`, `apps/dsh-plugin/README.md` | the plugin's entry guidance, pointing at CLI commands it does not expose as tools |
| `docs/reference/cli.md` | the family table entries for `work` and `milestone` |

## Supported inputs and trust boundary

Supported: a local project's own event log, read through `buildModel`; work,
milestone and decision ids this project's fold resolves, by exact id or unique
prefix where the existing lookup already accepts one; a reason as free text.

The trust boundary is unchanged. Every command here is one append of existing
`entity.linked`/`entity.unlinked` events through `recordEvent`/`recordEvents`,
and every read is a pure projection of the supplied log. Nothing reaches the
network, nothing mutates another project's log, and every value out of the log
is read through the same defensive guards the rest of the fold uses — a
malformed link, an unknown link type or a non-string reason reads as absent
rather than crashing the fold.

## Exclusions

Out of scope for this branch, and not to be advertised by it:

- `self objective check`, its seven findings, the health summary and the
  foreign-project availability notices — PR(c).
- Carry on `objective revise`/`milestone revise`, lineage-local membership,
  target-open mutation guards, the proposal retarget path, milestone/objective
  date ordering, judgment-context provenance and `milestone recheck`'s new
  condition — PR(b). A `milestone revise` on this branch states its assumptions
  with `--decision` and carries none by itself.
- Objective-level assumptions, routine records (#451), prose classification,
  progress percentages, automatic cleanup of existing stores, and any
  broad audit of link handling beyond the paths named above.
- Korean reader-facing copy. The English guidance is revised in place.

## Stop condition

Stop when the cells below pass, `pnpm build`, `pnpm typecheck` and
`pnpm structure` pass, and the touched suites pass locally. The full tier is
CI's `verify` job. No further review rounds are opened from this branch.

## Variables resolved outside the arguments

What a cell's outcome depends on beyond what the command line carries:

| Variable | Resolved from | Why it matters to a cell |
|---|---|---|
| the project | the working directory, through `requireProject` | every write verb here records into the project it runs in and takes no `--project` |
| the work, milestone and decision ids | this project's fold at command time | a prefix that matches two decisions is ambiguous, and the refusal is the existing one |
| whether an edge already exists | the fold as it stands before the append | cells 4, 12 and 13 refuse a second statement of one edge |
| the declaration timestamp | the event the pipeline mints | cell 6 asserts the projection carries a declaration date, not a fixed literal |
| `by` on each event | `writtenBy()`, from the session environment | unchanged by this branch; the harness's `must` writes agent-authored events |

## 1 — the standalone disposition

| # | Case | Outcome |
|---|---|---|
| 1 | `work link <id> --standalone --why "<reason>"` on a unit with no contributions | one `entity.linked` event; the unit reads standalone with that reason |
| 2 | `work link <id> --standalone` with no `--why` | refused through the required-option gate, naming `--why` and what it states; nothing recorded |
| 3 | `work unlink <id> --standalone` after cell 1 | one `entity.unlinked`; the unit is no longer standalone and no other edge changed |
| 4 | `work link <id> --standalone --why w` twice | the second is refused by name — one edge is one link; nothing recorded |
| 5 | `work link <id> --standalone --why w --objective <o>` | refused: a unit that stands alone contributes to no outcome, so the two statements are made one at a time |
| 6 | `work show <id>` after cell 1 | the page states the disposition, the reason and the date it was declared |
| 7 | `work link <id> --standalone --why w` on a unit that already contributes to an objective | recorded, and the contribution edge is untouched — standalone conceals nothing |
| 8 | `work unlink <id> --standalone` on a unit that never declared it | refused, naming the command that declares one |
| 9 | `work add "<outcome>" --standalone --why "<reason>"` | one append; the new unit reads standalone from birth |
| 10 | `work add "<outcome>" --supersedes <id> --why w --standalone` | refused: one `--why` cannot state two reasons, and the refusal spells the two-step path |
| 11 | `work propose "<plan>" --standalone --why "<reason>"`, then `work confirm` | the plan is recorded standalone and the confirmed unit still reads standalone |
| 12 | round trip: declare, withdraw, declare again with a different reason | the newest declaration's reason is what the unit reads; every statement stays in `work show --history` |
| 13 | `self undo <link-event>` after cell 1 | the disposition is gone from the projection, exactly as an undone contribution edge is |

## 2 — assumed decisions

| # | Case | Outcome |
|---|---|---|
| 14 | `milestone link <m> --decision <d>` | one `entity.linked` carrying an `assumes` edge; the milestone names that decision |
| 15 | `milestone link <m> --decision <d>` twice | the second is refused by name; nothing recorded |
| 16 | `milestone link <m> --decision <unknown>` | refused by the existing decision lookup — an id that is not a decision is named as such |
| 17 | `milestone link <m> --decision <ambiguous-prefix>` | refused as ambiguous, naming how many matched |
| 18 | `milestone unlink <m> --decision <d>` | one `entity.unlinked`; that assumption alone is gone |
| 19 | `milestone unlink <m> --decision <d>` on a decision it never assumed | refused, naming the command that states one |
| 20 | a milestone assuming two decisions, then unlinking one | the other assumption is untouched — replacing one never erases an unrelated one |
| 21 | old decision superseded, successor linked, old one unlinked | the milestone names the successor alone, and both statements are in the log |
| 22 | `milestone add "<outcome>" --objective <o> --exit e --decision <d> --decision <d2>` | the checkpoint is born naming both |
| 23 | `milestone revise <m> --why w --decision <d>` | the successor names that decision; nothing is carried implicitly, which is PR(b)'s scope |
| 24 | `milestone show <m>` after cell 14 | the page names the decisions it assumes, by id — the same way it lists its linked work, because the page is also written as a canonical file and reads no record but its own |

## 3 — the one guidance contract, part (a)

| # | Case | Outcome |
|---|---|---|
| 25 | `self work --help` | states the standalone spelling and declares `--standalone` in its flag glossary |
| 26 | `self milestone --help` | states the `--decision` spelling and declares it in its flag glossary |
| 27 | `self help work` and `self help goals` | both name the three dispositions a unit can have, and the assumption commands |
| 27a | each of the three routes | names all six record kinds and says a kind is chosen by what the record asserts, never by how its text reads |
| 28 | the managed block `connect.ts` writes | names the standalone declaration and the runbook run link, in the same words the CLI help uses |
| 29 | the plugin's guidance — `superselfTools` descriptions and `README.md` | points at the CLI commands for links and never implies a tool it does not expose |
| 30 | every `self` command any of the three entry routes names | is dispatchable on this branch — the parity proof, and what keeps a PR(b)/(c) command from being advertised early |
| 31 | `work add` with no disposition | the attachment listing offers the standalone declaration beside the objectives, so the third answer is reachable where the other two are |

## 4 — the contract gate

| # | Case | Outcome | File |
|---|---|---|---|
| 32 | `checkContract(COMMANDS)` | still empty: the new flags are declared, glossed and reachable | `contract.test.mjs` (existing) |
| 33 | a requirement naming only a boolean | still refused — the rule R6 narrows is not removed | `contract-links.test.mjs` |
| 34 | the `cli.md` family table | names no flag the parser does not accept | `docs.test.mjs` (existing) |
| 35 | the exhaustive renders of `work add` | each states the whole offer, the standalone rows included | `render-gate-receipts.test.mjs`, `render-gate-tty.test.mjs`, `work-attachment.test.mjs` (existing) |
