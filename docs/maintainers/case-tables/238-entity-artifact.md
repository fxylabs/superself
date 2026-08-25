# Case table — a record points at a registered artifact (#238)

The design artifact for #238, written before the code and reviewed on the
issue. Every test in `apps/cli/test/entity-artifact.test.mjs` is one cell
below, named by its cell number, and asserts that cell's stated outcome. The
table is the review surface: a cell the table lacks is a path nothing proves.

Cells 39 to 42 and 45 belong to the removal half — `artifact prune`, #239 C —
and are counted by `apps/cli/test/artifact-retention.test.mjs` when that lands.
The 41 cells with tests here are this change's whole gate.

## The defect

A convention is an entity, and an entity holds text and nothing else. Guidance
that runs longer than a context line has nowhere to live inside the store, and
two things keep it out:

| Block | Where |
|---|---|
| An artifact is ingested only by `self report --artifact`, attached to a work unit's report | `self artifact --help`: "never registered on their own" |
| An entity has no field naming an artifact | `entities.ts` — text, labels, links, reserved metadata, placement |

The workaround is to leave the guide in the repository and have a convention
name the file, which is what this repository does with `ARCHITECTURE.md`. That
works only inside a checkout. A registered artifact is stored with its digest,
so every machine resolves the same bytes and a session outside the repository
still reaches it.

## The ruling this implements

> **Does a referenced artifact count against the retention cap?**
> **No — the cap counts the pointer, never the target.**

The cap answers "how much can context hold". An artifact's bytes are not in the
render; a session opens one deliberately, when the record it hangs off applies.
Counting them would leave the defect exactly where it was — a long guide would
still eat the tier, only one level of indirection further away.

Four fences keep that from becoming an unbounded attachment surface:

| Fence | What it does |
|---|---|
| One artifact per record | Not a list. A second `--artifact` is refused by name |
| The pointer costs characters | Fifty conventions each naming a guide fill the full tier with fifty pointers |
| Registration is the report's own ingest path | The 100 MB bound and the 10 MB notice apply unchanged (#372) |
| `self store size` shows the growth | An increase nobody could see was the original defect (#239) |

## The vocabulary

A **registration** is `artifact.registered`: an artifact stored with no report
behind it. It carries `refs.artifacts` and no `refs.work`.

A **reference** is `EntityState.artifact` — one artifact id on one record,
written by `--artifact` on `convention add` and `state add`.

The **pointer** is what a reference renders as: a fixed wording wrapped around
the id, ` — see \`self artifact open a-xxxxx\``, produced by `artifactPointer`
in `entities.ts`. The render and the cap read that one function, so the number
a cap charges is the length of the string a reader actually sees.

## Rules the cells are derived from

1. **Registration is ordered before the record.** A process that dies between
   the two leaves an artifact nothing points at — visible in `artifact list`,
   depended on by nothing. The other order leaves a record naming an artifact
   that was never stored, and there is no way back from that (cells 11, 17, 46).
2. **A reference is one artifact, and a second `--artifact` is refused by
   name.** Both option tables declare it `multiple: true` for that reason: a
   single option lets `parseArgs` keep the last value and drop the first
   without a word, which is the pitfall `--entry` already documents
   (`artifact.ts` `requireOneEntry`). Cell 15 is the gate on it.
3. **An id is resolved against the project's own registry, at write time.**
   Not against the whole store: artifact bytes live under `artifacts/<slug>/`,
   and a record naming another project's id would make this project's event
   point into a directory it does not own (cells 12, 13, 14).
4. **The record's cost is `text + pointer`, counted in one place.**
   `entityCharacters` in `entities.ts` is the only window, and all ten sites
   that sum a record against a cap go through it. Two answers would let a write
   pass a check the confirm then fails (cells 19-27).
5. **The artifact's own bytes are never counted** (cell 22).
6. **A live record's reference is health-checked; a dead one's is not.**
   `isLive` — proposed and confirmed — is the predicate, the same one #239 C's
   prune refusal uses (cells 35, 37, 44).
7. **Only the project whose log holds the record raises the line.**
   `model.entities` is that project's own fold; a workspace-scoped record
   renders elsewhere through `scopedIn`, which never reaches it (cell 43).
8. **Registering a file is not evidence.** `artifact.registered` folds into no
   work unit, and the completion gate reads `work.reports[].artifacts`, so a
   registration never opens `work done` (cell 7).
9. **Truncation drops whole rows.** `fitKeeps` in `views.ts` cuts by row, so a
   budget too small for a referencing record omits the record, never the
   pointer alone (cell 30).

## What the verbs resolve from outside their arguments

| Read | Where it comes from |
|---|---|
| where `--artifact <path>` points | `process.cwd()`, through `resolve` in `planArtifacts` |
| which project takes the bytes and the record | `requireProject(process.cwd())` — both are write verbs and take no read scope |
| whether an id is this project's | the project's own log, through `artifactMetas` |
| whether the stored bytes are on this machine | `existsSync` and a re-hash, under the store's artifacts root |
| which projects `artifact open` answers for | the whole registry, so a workspace rule's guide opens anywhere |

## The cells

### Registering an artifact with no report behind it

| # | State | Action | Expected |
|---|---|---|---|
| 1 | a plain file | `artifact add guide.md` | a new id, one `artifact.registered` with no `refs.work`, and a listing row whose work column is `-` |
| 2 | a directory | `artifact add docs` | one bundle, listed as `docs/ (2 files)`; the `--entry` rules are #362's unchanged |
| 3 | the same bytes already stored | `artifact add copy.md` | a new id of its own, sharing the first's stored path — nothing copied (#372) |
| 4 | outside any project | `artifact add` | refused — a write verb resolves its project from the working directory |
| 5 | a file over the byte bound | `artifact add huge.bin` | refused, and no event written |
| 6 | a path that does not exist | `artifact add nope.md` | refused, and no event written |
| 7 | a registration and an open work unit | `work done <id>` | refused — a registration is not evidence |
| 8 | a registered artifact | `artifact open <id>` | opens, or names the resolved path where nobody is at a terminal |
| 9 | a registered artifact | `artifact search guide.md` | a hit |

### A record referencing one

| # | State | Action | Expected |
|---|---|---|---|
| 10 | an id this project stores | `convention add "…" --artifact a-xxxxx` | the reference is recorded, in exactly one event |
| 11 | a path | `convention add "…" --artifact ./guide.md` | two events — `artifact.registered` first, `entity.confirmed` second, naming its id |
| 12 | an id nothing recorded | `convention add --artifact a-zzzzz` | refused, no event written |
| 13 | another project's id | `convention add --artifact <theirs>` | refused at the project boundary, no event written |
| 14 | an id the registry no longer holds — the state `artifact prune` will leave (#239 C) | `convention add --artifact` | refused. The registry is put into that state directly here, as a fixture for the condition; the removal verb does not exist yet |
| 15 | `--artifact` passed twice | `convention add` | refused by name, saying how many times it was passed |
| 16 | no `--artifact` | `convention add "…"` | unchanged, and the record carries no reference |
| 17 | a path, and a cap that refuses the record | `convention add --artifact ./guide.md` | the artifact stands and the record does not — harmless surplus, never a dangling pointer |
| 18 | `state add` | `state add "…" --artifact` | the same field through the same check |

### What the retention cap charges

| # | State | Action | Expected |
|---|---|---|---|
| 19 | room in the tier | `convention add --artifact` | admitted |
| 20 | the pointer takes it over the cap | `convention add --artifact` | refused, and the refusal's number is the text plus the pointer |
| 21 | the same text with and without a reference | three runs | the boundary moves by exactly the pointer's cost |
| 22 | a 12,000-character guide | `convention add --artifact` | admitted — the target is not counted |
| 23 | a full tier and a record to demote | `convention add --artifact --demote <id>` | admitted |
| 24 | index exposure | `state add --exposure index --artifact` | the index cap is charged the pointer, and the index row renders it on one line |
| 25 | search exposure | `state add --exposure search --artifact` | no cap applies, and the pointer renders in `self search` |
| 26 | a predecessor holding a reference | `convention add --supersedes --artifact` | an exact swap fits: the seat it frees includes its pointer |
| 27 | a proposal | `--proposed`, then `state confirm` | the confirm-time check counts the pointer too |

### What a reader sees

| # | State | Action | Expected |
|---|---|---|---|
| 28 | a full-exposure rule with a reference | `self context` | the rule's text, then the pointer |
| 29 | a workspace-scoped rule with a reference | `self context` in another project | the pointer renders, and `artifact open` resolves there |
| 30 | a context budget too small for the row | `self context` | the whole row is omitted, never the pointer alone |
| 31 | a handoff packet | `self handoff <work-id>` | the convention row carries the pointer |
| 32 | the terminal render | `self context --pretty` | the pointer is there |
| 33 | search | `self search --type convention --all` | the pointer is there |
| 34 | bytes this machine has not synced | `self context`, `artifact open` | the pointer stands; the open is refused and names `self sync` |
| 35 | the same | `self status` | one health line, naming the record and the artifact |
| 36 | stored bytes that no longer match the digest | `self status` | one health line |
| 37 | the referencing rule retracted | `self status` | silence — a dead record renders nowhere |
| 38 | superseded, and the successor states no `--artifact` | `self context` | the pointer is gone; the artifact stays in the store |
| 43 | a workspace-scoped rule, bytes gone, two projects | `self status` in each | one line in the owning project, none in the other |
| 44 | a proposal holding the reference, bytes gone | `self status` | one health line — a proposal is live |

### What a path input costs the store

| # | State | Action | Expected |
|---|---|---|---|
| 46 | a path, not an id | `convention add --artifact ./guide.md` | **two commits.** `writeThrough` folds and commits per call, so the registration and the record land separately, and a clone pulling between them sees an artifact nothing points at — the surplus of cell 17, never a loss |

### The removal half (#239 C — counted by `artifact-retention.test.mjs`)

| # | State | Action | Expected |
|---|---|---|---|
| 39 | a live record references it | `artifact prune` | refused, naming the record |
| 40 | the referencing record is retracted | `artifact prune` | removable |
| 41 | two records reference one artifact | `artifact prune` | refused until both are dead |
| 42 | a report's artifact is also referenced by a rule | reference | allowed — one artifact can be evidence and guidance both; removal must satisfy both sources |
| 45 | a proposal references it | `artifact prune` | refused — the same `isLive` predicate as cell 44 |

## What this change deliberately leaves out

- `--artifact` on `goal add`, `decide`, `objective add` and `milestone add`.
  The field is on the entity, so each is one flag away; the issue asked for
  conventions.
- Any way to change a record's reference in place. A convention is corrected by
  restating it with `--supersedes`, which is how every other statement about it
  is corrected.
- Removal. That is #239 C, and its cells are listed above.
- Migration of artifacts already in the store. Nothing about them changes.

## Two notes on the implementation the table does not cover

- **`convention drop --artifact` is refused by name.** The option table is
  declared once for the whole verb, so the subcommand that does not take a flag
  says so rather than dropping it — the same treatment `--supersedes`,
  `--workspace` and `--public` already get there.
- **The propose/confirm cells run on the raw record, not on a convention.**
  `convention add` states a rule outright and has no `--proposed`, and
  `state confirm` refuses a preset-labeled record toward its own verb. Cells 27
  and 44 assert the cap arithmetic and the `isLive` predicate, and both are
  properties of the entity every preset folds into.
- **A reference the registry cannot resolve raises a health line of its own.**
  Nothing this change writes can produce one, because the write-time check in
  rule 3 refuses it; it is the honest answer for a log edited by hand, and it
  is where a pruned artifact will surface once #239 C lands.
