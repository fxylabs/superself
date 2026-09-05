# Case table — carry, guards, retarget, dates and judgment context (#417, PR b of 3)

Written before the code, and the review surface for it: a cell this table lacks
is a path nothing proves. Every test in `apps/cli/test/guards-carry.test.mjs`
is one cell below, named by its cell number. Cells that belong to another file
say which file.

This is part (b) of the three-part delivery the approved #417 design v2.1
sequences. Part (a) shipped the link model — standalone dispositions, assumed
decisions and the record-selection guidance — on `origin/main` as #452, and
this branch is based on it. Part (b) ships what a revision carries, the
target-open guards, the proposal retarget path, the date ordering rule, and
the objective identity a coverage judgment was made under. It ships none of
PR(c) — `self objective check`, its seven findings and the health summary —
and nothing on this branch may advertise a command part (c) has not shipped.

## The defect this part answers

Issue #417 records four observed graph inconsistencies. Two of them are what
part (a) answered; these two are part (b)'s:

| Observed | What the store could not say |
|---|---|
| Work stayed on a superseded milestone | A revision carried its checkpoints and left every contributing unit pointing at the record that was replaced, and nothing refused a fresh contribution to a target that was already closed |
| Recurring maintenance became a product checkpoint with a later date than its objective | Nothing compared a checkpoint's date with the date of the objective it sits under, in either direction |
| Completed work was not reconciled with successor criteria | A coverage judgment recorded no objective identity, so a checkpoint carried under a new parent kept a verdict reached under the old one and read as current |

`objective revise` said in its own help that "every live milestone, with its
coverage and work, moves under it". Only the milestones moved. `work link`
accepted a reached, dropped or superseded target without a word. A proposal
whose gap closed before anyone answered it could be confirmed toward that
closed gap, and no supported command moved it to a live one.

## The rulings this implements

| # | Question | Decision |
|---|---|---|
| R1 | When does a contribution edge stop being current? | **Only when the same record also links to a successor of that target.** Membership is lineage-local: an edge to `o1` is historical once the same unit also links to `o2`, which supersedes `o1`. Every other membership the unit holds stays current, and no edge is ever removed from the log |
| R2 | What does `objective revise` carry? | **Its live checkpoints, as before, and now every directly linked non-retired work unit**, one `entity.linked` `member-of <successor>` each, in the successor's own append. A unit linked only through a milestone carries with that milestone and gets no edge of its own |
| R3 | What does `milestone revise` carry? | **Its non-retired linked work, as link events, and the predecessor's assumed decisions, on the successor's creation payload.** `--decision` on the revision adds to that set rather than replacing it; a decision already assumed is not stated twice |
| R4 | What is a closed target? | **An objective that is reached, dropped, superseded, declined or undone; a milestone whose derived state is `reached` or `closed`.** The milestone rule already covers a live checkpoint under a closed objective, because that is what makes its state `closed`. Read once, in `targetClosure`, by every guard |
| R5 | Which verbs are guarded? | **`work link`, `work propose`, `work confirm` and the new `work revise` retarget.** `work unlink` is never guarded — withdrawing an edge from a closed target is the repair, not the mistake |
| R6 | What does a guard offer as a repair? | **The terminal record of the successor chain, and only when it is itself open.** A chain that ends closed offers no relink: the refusal names the standalone declaration or the decline instead, so no advertised command leads to a second refusal |
| R7 | How does a plan move to another gap? | **`work revise <id> "<plan>" --why w --objective\|--milestone <id>`**, on a proposal that already names a gap and has never been started. The revision states the new gap in its own payload; the fold reads the newest revision that states one as the plan's effective target |
| R8 | Is a retarget with unchanged plan text a revision? | **Yes.** A changed target is a changed plan, so the "this changes nothing" refusal is lifted exactly when the target moves, the version number advances, and the acceptance is invalidated under the existing rule — the plan is confirmed again before it can start |
| R9 | What happens to an edge an earlier acceptance wrote? | **The retarget withdraws it, in the same append**, so the record never carries a contribution to a gap the plan no longer names. The edge to the new gap is written by the next `work confirm`, exactly as the first one was. Unrelated edges are untouched |
| R10 | How do the two dates compare? | **Asymmetrically.** A milestone dated later than its objective is refused at `milestone add` and `milestone revise`; equal passes. An objective's date moves freely, and moving it earlier warns — on stderr — naming the live checkpoints now beyond it. Either date absent means the ordering cannot be checked, which is not a failure |
| R11 | Where is a judgment's parent recorded? | **On the `entity.covered` event, as `payload.objective`**, written by the one coverage writer whenever the covered record is a milestone. No new event type: the design forbids one, and the vocabulary proof in `docs.test.mjs` would have to grow for it |
| R12 | When is a carried judgment review-needed? | **When the newest claim on a live criterion names an objective other than the checkpoint's current parent** (`moved`), **or names none while the checkpoint has been carried at least once** (`unknown`). A checkpoint that was never carried establishes its own context, so nothing is reclassified for it |
| R13 | What clears it? | **`milestone recheck`, one criterion at a time.** It records the current parent, so the newest claim now names it and that criterion's condition is gone. Criteria nobody rechecked stay visible, and no work evidence is applied on anyone's behalf |

## Rules the cells are derived from

1. **A revision carries membership; it never rewrites it.** Every carry is an
   appended `entity.linked`. Nothing is unlinked, so `self undo` of one link
   returns one record to where it was, and the log keeps every statement.
2. **Unrelated memberships survive everything.** A unit contributing to two
   objectives, one of them revised, still contributes to the other. A foreign
   contribution is never carried and never withdrawn: this project cannot
   resolve another project's lineage, and a revision here is not a fact about
   that log.
3. **Done work carries as membership, never as coverage.** A carried unit that
   is already done contributes to the successor and covers none of its
   criteria. Coverage is a judgment somebody records.
4. **A guard refuses before it writes.** Every refusal below leaves the log
   byte-identical to what it was.
5. **Every advertised recovery command reaches the state it promises.** Each
   refusal's suggested command is run, from the context the refusal is read in,
   and the cell asserts the state it reaches.
6. **A changed effective target is a revision.** Same text, different gap, is a
   new version and a new acceptance — not a display change.
7. **Provenance is never inferred.** A claim that recorded no objective is read
   as unknown-if-carried and as nothing at all otherwise. No pass decides what
   a historical judgment must have meant.
8. **Nothing on this branch advertises `self objective check`.** The parity
   cell resolves every command the three entry routes name against the typed
   contract, which is what keeps a part (c) command from shipping early in
   prose.

## Production surfaces

| Surface | What changes |
|---|---|
| `apps/fold/src/entities.ts` | `RevisionEvent.target` and `EntityState.planTarget` — the gap the newest revision states; `CoverageClaim.objective` — the parent a judgment was made under |
| `apps/fold/src/objectives.ts` | `Coverage.judgedUnder`; `MilestoneState.judgmentContext`; the recheck signal for it, beside the existing legacy stale one |
| `apps/fold/src/model.ts` | lineage-local `memberLinks`; the judgment parent carried through `syncCoverage`; the proposal's effective gap read from `planTarget` |
| `apps/cli/src/goals.ts` | the work carry on `objective revise` and `milestone revise`; the assumption carry; `targetClosure` and the guards on `link`/`propose`/`confirm`; the `work revise` retarget; the date rules |
| `apps/cli/src/state.ts` | `recordCoverage` stamps the milestone's current parent onto the claim |
| `apps/cli/src/fold.ts` | the milestone page states a criterion whose judgment context moved or is unknown |
| `apps/cli/src/main.ts` | the `work` usage, descriptions and flag glossary for the retarget |
| `apps/cli/src/guide.ts` | `self help work` and `self help goals` |
| `apps/cli/src/connect.ts` | the managed block's carry, guard, retarget, date and recheck lines |
| `apps/dsh-plugin/src/tools.ts`, `apps/dsh-plugin/README.md` | the plugin's entry guidance, pointing at CLI commands it does not expose as tools |
| `docs/reference/cli.md` | the family table entries for `work`, `objective` and `milestone` |

## Supported inputs and trust boundary

Supported: a local project's own event log, read through `buildModel`; work,
objective, milestone and decision ids this project's fold resolves; a foreign
objective through the existing `--objective-project` resolution, whose state is
read from that project's own locally available log. Dates are the `YYYY-MM-DD`
values the existing typed date argument already admits.

The trust boundary is unchanged. Every command here is an append of existing
`entity.*` events through `recordEvent`/`recordEvents`/`recordRetirement`, and
every read is a pure projection of the supplied logs. Nothing reaches the
network, nothing mutates another project's log, and every value out of the log
is read through the same defensive guards the rest of the fold uses — a claim
carrying a non-string objective, a revision carrying a target that is not a
string, and an unresolvable successor id all read as absent rather than
crashing the fold.

## Exclusions

Out of scope for this branch, and not to be advertised by it:

- `self objective check`, its seven findings, the health summary, the foreign
  availability notices and the evidence-candidate listing — PR(c). This branch
  prepares the model data those findings read (`judgmentContext`, lineage-local
  membership) and ships no generic finding framework.
- Objective-level assumptions, routine records (#451), prose classification,
  progress percentages, strategy scoring, automatic cleanup of existing stores.
- Retargeting a standalone plan, which names no gap to move, and retargeting a
  unit that has already started, which is corrected by a successor.
- Any mutation of a foreign project's log, and any carry across a foreign
  contribution — this fold cannot resolve another project's lineage.
- A malformed-data audit beyond the defensive reads named above, and
  exhaustive inputs no supported command can produce.
- Korean reader-facing copy. The English guidance is revised in place.

## Stop condition

Stop when the cells below pass, `pnpm build`, `pnpm typecheck` and
`pnpm structure` pass, and the suites this branch touches pass locally. The
full tier is CI's `verify` job. No further review rounds are opened from this
branch.

## Variables resolved outside the arguments

| Variable | Resolved from | Why it matters to a cell |
|---|---|---|
| the project | the working directory, through `requireProject` | every write verb here records into the project it runs in |
| a target's closure | the fold at command time, including the derived milestone state | cells 14–20 refuse against state nobody passed on the command line |
| the successor chain | `supersededBy` on the projected objective or milestone | cell 17 walks two hops; cell 18 ends on a closed terminal and offers no relink |
| the plan's effective gap | the newest revision that states one, else the creation payload | cells 21–26 |
| a checkpoint's current parent | the newest `member-of` edge the checkpoint carries | cells 33–39 |
| today | not read at all by any rule here | the date rules compare two stated dates and never the clock |

## 1 — lineage-local membership across an explicit revision

| # | Case | Outcome |
|---|---|---|
| 1 | `objective revise` on an objective with one directly linked live unit | one `entity.linked` `member-of <successor>` for that unit; the receipt counts the units beside the checkpoints |
| 2 | the same unit's `work show` after cell 1 | it contributes to the successor and no longer to the predecessor — one current membership, not two |
| 3 | that unit also contributes to a second, untouched objective | both memberships read current: the unrelated one is not carried, not withdrawn and not hidden |
| 4 | that unit also contributes to a foreign objective | the foreign contribution is unchanged, no event names it, and the other project's log is untouched |
| 5 | a retired unit linked to the revised objective | no link event names it; it stays on the predecessor, where its history ended |
| 6 | a done unit linked to the revised objective | it carries as a membership, and the successor's criteria are all still uncovered — evidence is never applied by a carry |
| 7 | a unit linked only through a milestone of the revised objective | no edge of its own is written; it follows the checkpoint, and `work show` names the checkpoint under the successor |
| 8 | `self undo` of one carried work link | that unit alone reads current under the predecessor again; every other carried record is untouched |
| 9 | `milestone revise` with one linked live unit | one `entity.linked` `member-of <successor-milestone>`; the unit reads current under the successor and historical under the predecessor |
| 10 | `milestone revise` on a checkpoint that assumes two decisions | the successor assumes both, in the order the predecessor stated them |
| 11 | `milestone revise --decision <new>` on a checkpoint that assumes one | the successor assumes both; the flag adds and never replaces |
| 12 | `milestone revise --decision <already-assumed>` | the successor assumes it once — a set, not a list with a duplicate |
| 13 | the objective's roll-up after cell 1 | the successor counts the carried unit once, and the predecessor counts it not at all |

## 2 — the target-open guard

| # | Case | Outcome |
|---|---|---|
| 14 | `work link <w> --objective <reached>` | refused, naming the closure; nothing recorded |
| 15 | `work link <w> --milestone <dropped>` | refused, naming the closure; nothing recorded |
| 16 | `work link <w> --milestone <live milestone under a superseded objective>` | refused: the checkpoint is closed because its objective is |
| 17 | `work link <w> --objective <superseded twice>` | refused, and the refusal names the terminal successor; running the command it prints records the edge |
| 18 | `work link <w> --objective <superseded by a reached objective>` | refused, and no relink is offered — the refusal names the standalone declaration instead, and running that command records the disposition |
| 19 | `work unlink <w> --objective <reached>` | allowed: withdrawing an edge from a closed outcome is the repair |
| 20 | `work propose "<plan>" --objective <dropped> …` | refused before the proposal is minted; the log holds no `entity.proposed` |

## 3 — confirming against a target that moved

| # | Case | Outcome |
|---|---|---|
| 21 | `work confirm` on a proposal whose milestone was superseded after it was proposed | refused; the refusal prints the retarget command with the plan text and `--why`, the confirm that follows it, and the decline |
| 22 | the retarget the cell-21 refusal printed, run verbatim | recorded; the plan's page states the new gap |
| 23 | `work confirm` after cell 22 | accepted; the confirmed unit contributes to the new gap and to nothing else |
| 24 | `work revise` retarget with the plan text unchanged | recorded: a changed gap is a changed plan, and the version advances |
| 25 | a proposal confirmed, then retargeted before it started | the acceptance is invalidated — `work start` is refused until it is confirmed again — and the edge the first acceptance wrote is withdrawn in the retarget's own append |
| 26 | the same proposal also contributes to an unrelated objective | that edge is untouched by the retarget |
| 27 | `work revise <id> "<plan>" --why w --objective <closed>` | refused by the same guard: a retarget names a target that is open |
| 28 | `work revise` retarget on a standalone plan | refused, naming the two statements that state a gap after confirmation |
| 29 | `work revise <id> "<same text>" --why w` with no target flag | still refused as a revision that changes nothing |
| 30 | `work decline` on the cell-21 proposal | accepted — the second route the refusal offers reaches its promised state |

## 4 — the two dates

| # | Case | Outcome |
|---|---|---|
| 31 | `milestone add --target` later than its objective's target | refused, naming both dates; nothing recorded |
| 32 | `milestone add --target` equal to its objective's target | recorded — equal passes |
| 33 | `milestone add --target` on an objective with no target | recorded, with no ordering claim made |
| 34 | `milestone revise --target` later than the objective's | refused, naming both dates |
| 35 | `milestone revise` that states no target, under an objective whose date moved earlier | refused when the inherited date is now later — the check reads the effective date, not the stated one |
| 36 | `objective revise --target` earlier than a live checkpoint's date | recorded, with a warning on stderr naming the checkpoints now beyond it |
| 37 | `objective revise --target` earlier, where the only checkpoint beyond it is dropped | recorded with no warning: closed records are not live children |

## 5 — the parent a judgment was made under

| # | Case | Outcome |
|---|---|---|
| 38 | `milestone met` on a checkpoint under its original objective | the `entity.covered` event names that objective |
| 39 | `objective revise` carrying that checkpoint | the milestone page states the criterion's judgment context moved, names the objective it was judged under, and prints the recheck command |
| 40 | the recheck command the cell-39 page printed, run verbatim | recorded; that criterion's condition is gone and the criterion still reads covered |
| 41 | a second criterion nobody rechecked, on the same checkpoint | its condition is still stated — a recheck answers one criterion |
| 42 | a checkpoint that was never carried, with coverage recorded before this branch | no condition at all: a single parent establishes its own context |
| 43 | a carried checkpoint whose coverage predates provenance | the bounded unknown condition, which never claims the coverage was stale |
| 44 | legacy stale coverage, judged against a revision that moved | still rendered as stale, unchanged by this branch |
| 45 | `milestone recheck` on a criterion covered at the current record with no condition | still refused — nothing to recheck |
| 46 | coverage recorded after the carry | no condition: the judgment named the parent it was made under |
| 47 | `self undo` of the recheck in cell 40 | the condition is back, because the newest claim is the one that named the former parent again |

## 6 — one guidance contract, part (b)

| # | Case | Outcome |
|---|---|---|
| 48 | `self work --help` | states the retarget spelling and declares `--objective`/`--milestone` on `revise` in its flag glossary |
| 49 | `self objective --help` and `self milestone --help` | state what a revision carries and the date ordering rule |
| 50 | `self help work` and `self help goals` | both name the carry, the open-target rule, the retarget path and the recheck of a moved judgment |
| 51 | the managed block `connect.ts` writes | names the same four, in the same words the CLI pages use |
| 52 | the plugin's guidance — `superselfTools` descriptions and `README.md` | names the same four and never implies a tool it does not expose |
| 53 | every `self` command any of the three entry routes names | is dispatchable on this branch — the parity proof |
| 54 | `self objective check` | named by no entry route: part (c) has not shipped it |

## 7 — the projection stays pure

| # | Case | Outcome | File |
|---|---|---|---|
| 55 | `checkContract(COMMANDS)` | still empty: the new flags are declared, glossed and reachable | `contract.test.mjs` (existing) |
| 56 | the `cli.md` family table | names no flag the parser does not accept | `docs.test.mjs` (existing) |
| 57 | one event array, two clocks, two sessions, two verdict sets | one identical model, `judgmentContext` included | `determinism.test.mjs` (existing) |
| 58 | the fold package's imports | still reads no machine and imports no CLI | `purity.test.mjs` (existing) |
