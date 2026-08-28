# Case table — a criterion owned by a person (#413)

The design artifact for #413, written before the code and approved on the
issue. Every cell below is one test, named by its cell number. The table is the
review surface: a cell the table lacks is a path nothing proves.

Where each section's cells are expected to live:

| Section | File |
|---|---|
| A–F, H, I (declaring, the waiting row, the renders, undo, the fold, who wrote it, help) | `apps/cli/test/person-owned-criterion.test.mjs` |
| G (mixed version) | `apps/cli/test/cutover.test.mjs`, beside #408's section K |
| the fixture the renders are pinned in | `apps/cli/test/golden.test.mjs` |
| what #408 shipped and this must not move | `apps/cli/test/work-criteria*.test.mjs`, unchanged |

## The gap

#408 gave a work unit declared completion conditions, each addressed `c1..cN`,
each with an optional `--verify` text and its own block axis. Every one of them
is the session's own work: `self context` renders the unit under **Work in
progress** with `2 of 5 criteria covered`, and the criteria themselves reach
no other surface.

Proposal 4 of #404 reports what that misses. An orchestrating session held a
checklist in which some rows were its own and some were the user's — approve
the copy, raise the vendor quota, sign the agreement — and nothing in the store
could tell the two apart. The session's only options were to leave a row it
could not act on sitting in its own list, or to block the whole unit on a
condition that touched one criterion. #408 ruled the second one out on purpose
(cell 82: a criterion's block is not the unit's), which leaves the first, and
the first is how a person is never told.

So: **one field, on the criterion, that says whose task it is** — and one
consequence, that an open criterion which is a person's own renders under
**Waiting on you** with the command that closes it.

## The rule, in one sentence

**A criterion states whose task it is when it is declared: absent means the
session that records it, `person` means somebody at a keyboard — and a
person's own criterion that is not yet covered is a row under `self context`'s
Waiting on you, whatever the unit around it is doing.**

## What is not a new grammar

Almost all of it, again. Ownership rides the events #408 already writes: the
sparse map on the creation payload that `--verify` established, and the bare
string on `entity.criterion-declared`. No new event type, no new verb, no new
fold pass. The waiting row is a `WaitingItem` built at `model.ts`'s one
`noteWaiting` site, the same one a unit blocked on a decision has used since
#205, so it is scoped, counted, truncated and given a recovery pointer by the
code that already does that for every other row.

Two things are genuinely new: a value the fold reads on a criterion, and a
waiting row whose subject is a criterion rather than a record.

## The value, and why there is exactly one

`--owner person`. Not `--owner session`, and not a name.

**No `session`.** Absent already means it. A second spelling of the default
would let two stores describe the same criterion with different bytes, and the
first reader to ask "is this owned?" would have to answer it twice.

**No name.** A name is an identity, and this CLI holds none: `by` records
`{kind: "person"}` or `{kind: "agent", session}` and never who the person is
(#400). A `--owner "rayim"` would be an unvalidated string that renders as if
the store knew something it does not, and the row it produced would say *waits
on rayim* to a reader who may not be rayim. `person` says the only true thing:
this is not the session's to do. Directory, assignment and hand-off are a
different issue and are not smuggled in through a free-text flag.

**Set at declaration, and never again.** There is no `work criteria own`. A
criterion whose ownership was stated wrongly is taken back with `self undo` and
declared again — the same and only correction path #408 gave a criterion's
text and its `--verify` (cells 55, 17). This is stated in `self help work`,
because a reader who goes looking for the re-owning verb has to be told there
is not one rather than left searching.

## Where it is stored

Byte-for-byte the shape `--verify` established, so a reader that defends
against one defends against both:

```jsonc
// entity.confirmed / entity.proposed — the creation payload
"criteria": ["the fixture regenerates clean", "the release note names the flag"],
"verify":   { "c1": "`npm test -w apps/cli` passes" },
"owner":    { "c2": "person" }

// entity.criterion-declared — one criterion, nothing to key by
{ "entity": "w-…", "criterion": "<text>", "verify": "<how>", "owner": "person", "by": {…} }
```

Sparse and keyed rather than a parallel array, for #408's reason: most criteria
carry no owner, and an array of holes is a shape every reader has to defend
against. Both are ignored by `newEntity`, which reads named keys only, and
`entity.criterion-declared` is ignored whole by every fold pass shipped before
#408 — so a 0.11.0 or 0.12.0 CLI reads every criterion here as unowned, which
is exactly what it read before this issue existed. Section G states the
consequence.

## The fold

`CriterionState` gains one optional field:

```ts
owner?: "person";
```

Typed to the single value rather than to `string`, and read that way: a value
this CLI does not know is **ignored**, not carried. That is the load-bearing
half of the forward direction. A later CLI that adds a second owner value would
write stores this one reads, and a row under **Waiting on you** that said
*yours* about a criterion owned by something this CLI cannot name would be a
lie a reader acts on. Ignoring it reads the criterion as the session's own,
which is the answer this CLI gave for every criterion before #413 — loss in the
same direction #408 already takes, and never a wrong claim.

`readVerify` generalises to `readKeyed(value, admits)` — the same defensive
read of a sparse `cN` map, with a predicate for what the value may be:
`() => true` for `verify`, `(text) => text === "person"` for `owner`. One
reader, so a payload shape that defeats one cannot slip past the other.

Nothing else in the fold moves. Ownership is stated once, by the event that
declares the criterion, and no later event carries it: `entity.covered`,
`entity.criterion-blocked` and `entity.criterion-unblocked` are untouched, and
`settleCriterion` never reads or writes `owner`.

## The verbs

```
work add "<outcome>"   [--criteria "<text>" …] [--verify "cN <how>"] [--owner "cN person"]
work propose "<plan>"  [--criteria "<text>" …] [--verify "cN <how>"] [--owner "cN person"]
work criteria add <id> "<text>" [--verify "<how it is checked>"] [--owner person]
```

`--owner` is `cN`-prefixed on the two add verbs for `--verify`'s reason — one
call declares several criteria and nothing else in the flag says which — and
bare on `work criteria add`, which declares exactly one.

**The prefix parser is shared, not copied.** `state.ts`'s `verifyMap` /
`verifiedCriterion` become one reader parameterised by what the flag states:

```ts
interface KeyedFlag
{
    key: "verify" | "owner";
    states: string;   // "--verify states how one declared criterion is checked"
    begins: string;   // "the criterion it verifies" / "the criterion it names"
    shape: string;    // `"c1 <how it is checked>"` / `"c1 person"`
    once: string;     // "one criterion states one verification method"
    value: (raw: string, verb: string) => string;   // identity, or the person check
}
```

so the four refusals in cells A3–A6 are the four in #408's A4–A7 with one
noun changed, and `--verify`'s own wording is byte-identical to what shipped.
A third such flag cannot drift from either. The value check is a property of
the flag rather than a branch inside the parser, which is what keeps
`--verify`'s free prose free.

`--owner` on `state add` does not exist, and this is not an omission to fix
later: `state add` declares `--criteria` and has never accepted `--verify`
(the option set is its own, and `DECLARE_OPTIONS` is the work verbs'). The
waiting row's whole value is the `self work cover` line it carries, and that
line needs a work unit.

## The waiting row

Built in `model.ts` `deriveWorkSignals`, through the one `noteWaiting` site
every other waiting row goes through. That is not incidental — it is what makes
the row scoped to its project, counted in `self status`, truncated with a
recovery pointer when the context budget is short, and present in both the
piped and the ruled renders, without any of it being restated here.

```
- w-abc12 c2 the release note names the flag — yours (cover with `self work cover w-abc12 --criterion c2 --why "<how>"`)
```

and, blocked:

```
- w-abc12 c2 the release note names the flag — yours · blocked on external — the vendor has not confirmed the quota (cover with `self work cover …`)
```

`lead` is everything before the command clause, so the ruled render prints the
same sentence with `self work cover …` on a line of its own, exactly as
`confirmable` and `approvalWait` do. `action` is the cover command, because a
row a person cannot act on from the render is what #264 exists to stop.

Four rulings, each of which is a cell:

1. **A blocked person-owned criterion still lists**, naming its block. The
   block says why it has not moved; the ownership says whose it is. Dropping
   the row when it is blocked would hide precisely the criterion a person is
   most likely to be the one who can release.
2. **A covered one is gone.** Terminal state, no row — the same rule that ends
   its block.
3. **A proposal's person-owned criteria do not list.** A plan awaiting review
   is not yet anybody's work: the thing waiting on a person there is the
   review, which already has its own row, and a second row asking them to
   cover a criterion of a plan they have not accepted asks for the wrong act.
   The filter is the unit's status — `review` is out, and so are `done`,
   `retired` and `undone` by `isOpenWork`.
4. **The unit's own status never changes**, and it is not counted among
   blocked units. #408's ruling for the block axis holds unchanged for this
   one: a unit that reads active and waiting at once is two answers to one
   question. The row is about the criterion; the unit's row under **Work in
   progress** is unchanged but for the mark in its progress sentence.

One row per person-owned uncovered criterion: two on one unit give two rows,
in `cN` order, because they are two things to do and a merged row would carry
two `--criterion` values in one command.

## The listing mark

`criteriaProgress()` is **unchanged** — same interface, same body, same
`${covered} of ${total} criteria covered`. An owner is not progress, and the
count means the same thing on a unit that declares owners as on one that does
not.

`criteriaNote()` — the one sentence `self work`, `self context` and #406's
`milestone show` share — takes the criterion states instead of the progress it
computes from them, and composes one entry per criterion that is not moving on
its own:

| the criterion | its entry |
|---|---|
| blocked, unowned | `c3 blocked on decision` — unchanged |
| blocked, person-owned | `c3 blocked on decision (person)` |
| open, person-owned | `c2 (person)` |
| open or covered otherwise | none |

One entry per criterion rather than a blocked list and an owner list, because
a criterion standing still is one thing to say and a reader who saw `c3
blocked on decision · c3 (person)` would look for two criteria. In `cN` order,
as `waiting` already was.

`work show`'s per-criterion bullets take the mark directly, on all three
states — `c2 open — <text> (person)`, `c2 blocked on external — <why>
(person)`, `c1 covered — <why> (…) (person)`. Marked when covered too, because
ownership is what the unit *declared*, not what is left to do: a page that
dropped the mark on covering would disagree with the log about what was
declared, and the `(person)` there is what tells a reader the claim records
somebody else's word.

The mark is spelled once, as `ownerMark(criterion)` in `entities.ts`, and read
by all three renders that carry it — the unit's page, the listing sentence and
the done refusal (cell 41a). Three literals would be three chances to say it
three ways.

## The two fields called who

`by` and `owner` are one word apart and answer opposite questions, so both
`self help work` and the agent block state the distinction in one sentence:

> `by` is who wrote the record; `--owner person` is whose task the criterion
> is. An agent session records a criterion a person will do — both are true of
> the same event, and neither implies the other.

This is cell H2 in code: a `work criteria add --owner person` run by a person
at a keyboard writes `by: {kind:"person"}` and `owner: "person"`, and a run of
the identical command from an agent session writes `by: {kind:"agent", …}` and
the same `owner`.

---

## The cells

Callers, in #400's spelling:

- **P** — a person at their own keyboard: no attempt marker, stdin is a tty.
- **R** — an agent session: `SUPERSELF_SESSION` set.

`U` is a confirmed, started work unit declaring three criteria unless a cell
says otherwise.

### A. Declaring at birth — `--owner` on `work add` and `work propose`

| # | State | Operation | Expected |
|---|---|---|---|
| 1 | — | `work add "x" --criteria "a" --criteria "b" --owner "c2 person"` | `payload.owner` is `{"c2":"person"}`; `payload.criteria` and the receipt are unchanged from #408 cell 1 |
| 2 | — | `work add "x" --criteria "a"` with no `--owner` | the payload carries **no** `owner` key at all — byte-identical to what #408 writes, which is every unit in every store written before this issue |
| 3 | — | `work add "x" --owner "c1 person"` with no `--criteria` | refused: `work add --owner states whose task one declared criterion is — pass --criteria "<text>" too` |
| 4 | — | `work add "x" --criteria "a" --owner "person"` | refused: `work add --owner must begin with the criterion it names — "c1 person"; this call declares c1` |
| 5 | — | `work add "x" --criteria "a" --owner "c4 person"` | refused: `work add --owner names c4, and this call declares c1` |
| 6 | — | `work add "x" --criteria "a" --criteria "b" --owner "c1 person" --owner "c1 person"` | refused: `work add --owner names c1 twice — one criterion has one owner` |
| 7 | — | `work add "x" --criteria "a" --owner "c1 rayim"` | refused: `work add --owner takes "person" — it is the only owner a criterion states, and one with no owner is the session's own task` |
| 8 | — | `work add "x" --criteria "a" --owner "c1 person" --verify "c1 how"` | both ride the one creation event as separate keys, each naming c1; neither refusal fires |
| 9 | — | `work add "x" --criteria "a" --verify "the fixture regenerates"` | #408 cell A5's refusal is **byte-identical** to what it was: the shared parser did not move `--verify`'s wording |
| 10 | R | `work propose "p" --criteria "a" --criteria "b" --owner "c1 person"` | one `entity.proposed` carrying the same map; every other field of `proposedPayload` is unchanged |
| 10a | — | `state add "x" --criteria "a" --owner "c1 person"`, and `work revise <id> "y" --why w --owner "c1 person"` | both refused by the parser as an unknown option — the flag is on the two add verbs' option set and on no other, because the row it produces carries a `self work cover` line and that line needs a unit |

### B. Declaring later — `work criteria add --owner person`

| # | State | Operation | Expected |
|---|---|---|---|
| 11 | U | `work criteria add <U> "d" --owner person` | one `entity.criterion-declared` whose `owner` is the bare string `"person"`, beside the shipped `entity`, `criterion` and `by` |
| 12 | U | `work criteria add <U> "d"` | no `owner` key — the #408 event, unchanged |
| 13 | U | `work criteria add <U> "d" --owner someone` | refused: `work criteria add --owner takes "person" — it is the only owner a criterion states, and one with no owner is the session's own task` |
| 14 | U | `work criteria add <U> "d" --verify "the quota page shows 10k" --owner person` | both on the one event; `work show` prints the verify text and the `(person)` mark under c4 |
| 15 | U | `work criteria add <U> "d" --owner person` | the receipt names the ownership: `w-abc12 c4 "d" (person)`, and on a unit that declared none, `w-abc12 c1 "d" (person) — done now waits on it` |
| 16 | U already declaring "d", unowned | `work criteria add <U> "d" --owner person` | refused by the shipped duplicate refusal (#408 cell 17), unchanged — **nothing re-owns a criterion**; the path is `self undo` and a fresh declaration |
| 17 | a plan still in review | `work criteria add <plan> "a" --owner person` | records, as #408 cell 16 rules — declaring is not a claim about doing. No waiting row (cell C7) |

### C. `self context` — Waiting on you

| # | State | Operation | Expected |
|---|---|---|---|
| 18 | U active, c2 open and person-owned | `self context` piped | one row: `- w-abc12 c2 <text> — yours (cover with \`self work cover w-abc12 --criterion c2 --why "<how>"\`)` |
| 19 | same | `self context` at a terminal | the same sentence as the row's text, with `self work cover w-abc12 --criterion c2 --why "<how>"` as its command — the ruled render's own layout, from `lead` and `action` |
| 20 | U, c2 person-owned and covered | `self context` | no row — a covered criterion waits on nobody |
| 21 | U, c2 person-owned, blocked on external with a why | `self context` | the row lists, with the block named: `w-abc12 c2 <text> — yours · blocked on external — <why>`, carrying the same cover line |
| 22 | U, c3 blocked and **not** person-owned | `self context` | still no waiting row, and the unit is not counted among blocked ones — #408 cell 82 holds unchanged for a criterion nobody owns |
| 23 | U, c1 and c3 both person-owned and open | `self context` | two rows, in cN order, each naming its own criterion — one row per thing to do |
| 24 | a plan awaiting review declaring a person-owned criterion | `self context` | **no** row: nothing is actionable before the confirm, and the review already has a row of its own |
| 25 | U done, and U retired | `self context` | no row for either — `isOpenWork` is the filter, and it answers for an undone unit the same way |
| 26 | U with a person-owned criterion | `self work`, `self status` | the row still reads `active`, and the status counts still say `0 blocked` |
| 27 | U with a person-owned criterion, read from a sibling directory | `self context --project <slug>` | the row renders under that project's context, naming that project's unit — carried by `model.waiting` exactly as every other waiting row is, and absent from a sibling project's own context |
| 28 | same | `self status` | the row is counted once in `waiting on you: n`, and appears once in the open questions |

### D. The renders beside the row

| # | State | Operation | Expected |
|---|---|---|---|
| 29 | U, c2 open and person-owned with a verify text | `work show <U>` | `c2 open — <text> · verify: <how> (person)` |
| 30 | U, c2 covered and person-owned | `work show <U>` | `c2 covered — <why> (<actor> <date>) (person)` — the mark stays after covering, because it says what was declared. `<actor>` is who wrote the claim, which is the session unless a person ran the cover: the two fields keep answering different questions on one line |
| 31 | U, c2 blocked on external and person-owned | `work show <U>` | `c2 blocked on external — <why> (person)` |
| 32 | U declaring criteria, none owned | `work show <U>` | byte-identical to #408 cell 75 |
| 33 | U, 3 criteria, c2 person-owned and open, c3 blocked and unowned | `work show <U>` | the header is `- Criteria: 0 of 3 covered (1 blocked)` — ownership never changes the blocked count |
| 34 | cell 33's unit | `self work` at a terminal | the sentence is `0 of 3 criteria covered · c2 (person) · c3 blocked on decision`, in cN order, and the note under the row is that sentence through `noteLine`'s own fit |
| 35 | U, c3 blocked **and** person-owned | `self work` at a terminal | one entry, not two: `… · c3 blocked on decision (person)` |
| 36 | cell 33's unit | `self work` piped | the bracketed segment is the count alone — `[0 of 3 criteria covered]`, unchanged from #408 cell 78 |
| 37 | cell 33's unit | `self context` Work-in-progress row | the same sentence as cell 34, in the ` — …` position #408 cell 81 put it |
| 38 | cell 33's unit, linked to a milestone | `milestone show` | the same sentence again, through the same `criteriaNote` — four surfaces, one spelling |
| 39 | any unit | `criteriaProgress()` | unchanged: `covered`, `total` and `waiting` mean exactly what they meant, and the k-of-n sentence carries no owner clause |
| 40 | cell 29's unit | the synced `work/<id>.md` | carries the identical criteria block, mark included — every value in it is folded |
| 41 | U, c2 person-owned | `self log` | the declaration's row is #408's, unchanged: the log names the unit and the criterion, and the owner is a field of the record rather than of the act |
| 41a | U, c1 covered, c2 person-owned and open, c3 open | `work done <U>` | the refusal's rows carry the mark: `c2  open — <text> (person)` beside an unmarked `c3`. **Added by the adversarial pass:** the criteria clause is a criteria render, and a session told to cover a row is owed the fact that one of them is not its own |
| 41b | same | `work done <U>` | the `cover each with …` line names **c1**, not c2 — the same reasoning `nextToCover` already applied to a blocked criterion: the line a reader pastes should be one nothing stands in front of. With every unowned criterion covered it falls back to the owned one rather than naming nothing |

### E. `self undo`

| # | State | Operation | Expected |
|---|---|---|---|
| 42 | U, c4 declared later with `--owner person`, its waiting row showing | `undo <the entity.criterion-declared id>` | the criterion goes and the row goes with it; the receipt is #408 cell 64's, unchanged — the ownership was never a record of its own |
| 43 | a unit whose creation payload carried `owner` | `undo <the creation id>` | the whole unit goes, unchanged from #390 |
| 44 | U, c2 person-owned and covered | `undo <the entity.covered id>` | c2 is open again **and its row is back** — ownership survived the claim, because no coverage event ever carried it |

### F. The fold

| # | State | Operation | Expected |
|---|---|---|---|
| 45 | a creation payload whose `owner` is `{"c1": "rayim"}` | fold | ignored: c1 reads unowned, no row, no mark. A value this CLI cannot name is never rendered as *yours* |
| 46 | a creation payload whose `owner` is a string, an array, or `{"c9": "person"}` | fold | reads as absent for whatever it cannot key; the criteria stand and their verification texts are untouched |
| 47 | an `entity.criterion-declared` whose `owner` is `true`, `""` or an object | fold | ignored; the criterion is declared and reads unowned |
| 48 | two clones, each carrying the other's `entity.criterion-declared`, union-merged | fold | one answer on both: ownership rides the declaration, so `(ts, event id)` order settles it exactly as it settles the text |
| 49 | U, c2 person-owned, then blocked, unblocked and covered | fold | `owner` is unchanged through all three — `settleCriterion` never reads or writes it |
| 50 | a creation payload declaring `["a","a"]` with `owner {"c2":"person"}` | fold | the duplicate folds away as #408 rules, and the owner keyed to the position it was declared at goes with it — no criterion is silently owned by a key meant for another |

### G. Mixed version — an older CLI reading a store written here

Asserted the way #408's section K is: against that CLI, built from the tree at
a named commit, rather than against a description of it. The commit these
cells name is `fb0a402` — #408 merged, `--owner` not yet — because it is the
only reading that isolates ownership: a CLI without the criterion axis at all
ignores the declaration event whole and would prove nothing about the field
riding it.

| # | What the store carries | That fold's answer | Consequence |
|---|---|---|---|
| 51 | `payload.owner` on a creation event | ignored by `newEntity`, which reads named keys only | the criteria read, in full; whose task they are does not |
| 52 | `owner` on an `entity.criterion-declared` | the criterion is read (it has #408) and its ownership is not | the same one-directional loss, on the axis's own event. A CLI without the axis reads neither, which is #408 cell 92 |
| 53 | either store, read by either CLI | every criterion is unowned there | both CLIs owe exactly the same criteria: ownership gates nothing, so no done either would allow is refused by the other |

The loss is one-directional and safe in both directions, and it is the loss of
a *render*: an older CLI's done gate is not affected by ownership at all,
because ownership gates nothing. That is the property that let this ride the
shipped events rather than mint a type.

**The base commit is pinned, and that is a fix this issue carries.** #408's
section K resolved the merge base, which reads correctly on the branch that
adds a section and stops meaning anything the moment that branch lands: from
then on the merge base *is* the CLI under test, so every "ignored there"
becomes "read there". `main` has been red on cells 91, 92 and 93 since #408
merged for exactly that reason. Both sections now name their commit.

### H. Who wrote it, and whose it is

| # | Caller | Operation | Expected |
|---|---|---|---|
| 54 | R | `work add "x" --criteria "a" --owner "c1 person"` | one event carrying `by: {kind:"agent", session:"<token>"}` **and** `owner: {"c1":"person"}` — a session recording a criterion a person will do, which is the case the distinction exists for |
| 55 | P | `work criteria add <U> "d" --owner person` | `by: {kind:"person"}` and `owner: "person"`: the same word on two fields, and neither implies the other |

### I. Help, documentation and the contract

| # | State | Operation | Expected |
|---|---|---|---|
| 56 | any | `self work --help` | the `work add` and `work propose` usage lines carry `[--owner "cN person"]`, and `work criteria add` carries `[--owner person]` |
| 57 | any | `self work --help` option list | one `--owner` line: the criterion is a person's own task rather than the session's, stated at declaration and never re-stated, bare on `work criteria add` |
| 58 | any | `self help work` | carries the by-vs-owner sentence verbatim, and states that nothing re-owns a criterion: a wrong one is undone and declared again |
| 59 | any | `self connect` / the checked-in managed blocks | the agent block carries the same one sentence; `docs.test.mjs`'s managed-block proof passes against the template |
| 60 | any | `docs/reference/cli.md` | the work section documents `--owner`; the entity-grammar section names `owner` beside `verify` as a payload field an older fold ignores |
| 61 | any | `contract.test.mjs` | `checkContract` passes: the flag is declared on the leaves that document it |
| 62 | any | the golden fixture | regenerated: the scenario's unit owns c2, so the waiting row, the `(person)` marks — on the criteria bullet and in the done refusal — and the listing note are pinned in bytes rather than described |

**62 cells, plus 10a, 41a and 41b from the adversarial pass — 65.**

## Out of scope

`--owner` on `state add` and any waiting row for a raw entity's criterion —
the row's value is its `self work cover` line. A second owner value, a named
owner, a directory of people, and any notion of assignment. Re-owning a
criterion by any path but `self undo` and a fresh declaration. An owner on a
milestone exit criterion or a runbook stage. Ownership changing the unit's
status, its blocked count, or `criteriaProgress`. Notifying anybody: the row is
a render of the store, and the store sends nothing. Owner in the `self log`
row. Any HTML view.

## Cross-version note, for the release

A store written by this CLI folds correctly on 0.11.0 and 0.12.0: `owner` on a
creation payload is an unread key, and `owner` on `entity.criterion-declared`
rides an event those CLIs already ignore whole. Nothing this issue adds gates a
done, so an older CLI's completion gate is byte-for-byte the one #408 shipped.
In the other direction nothing is lost at all: a criterion declared before this
issue is unowned, which is what every criterion was.
