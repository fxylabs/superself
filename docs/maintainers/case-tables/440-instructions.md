# Case table — instruction records (#440)

The design artifact for #440, written before the code. Every cell below is one
test, named by its cell id, asserting that cell's stated outcome. The table is
the review surface: a cell the table lacks is a path nothing proves.

Where the tests live:

| Group | Cells | File |
|---|---|---|
| A — `instruction add` | 35 (A1–A35) | `apps/cli/test/instruction.test.mjs` |
| B — `self instruction` / `instruction list` | 20 (B1–B20) | `apps/cli/test/instruction.test.mjs` |
| C — `instruction render` | 27 (C1–C27) | `apps/cli/test/instruction-render.test.mjs` |
| D — context, search, handoff and the plugin | 15 (D1–D15) | `apps/cli/test/instruction-context.test.mjs` |
| E — placement | 19 (E1–E19) | `apps/cli/test/instruction-place.test.mjs` |
| F — lifecycle | 15 (F1–F15) | `apps/cli/test/instruction-context.test.mjs` |
| G — surfaces | 16 (G1–G16) | `apps/cli/test/docs.test.mjs`, `guide.test.mjs`, `golden.test.mjs`, `handoff.test.mjs`, `structure.test.mjs`, `pr7-loader.test.mjs`, `instruction.test.mjs`, `apps/dsh-plugin/test/tools.test.mjs` |

**147 designed cells.**

Cells changed while the code was written, and why — the table is the contract,
so a cell the code proved wrong is corrected here rather than skipped:

- **A5** — the requirement gate prints `spell(requirement)`, which is the flags
  alone; a requirement's `value` renders on the help page, not in the refusal.
  The cell now reads `self instruction add needs --kind: which section it
  renders under`.
- **F2** — the same gate as A5, and the same correction: `spell(requirement)`
  prints the flags alone, so the refusal reads `self state retract needs
  --why: why the record no longer holds`, with no `"<text>"` after the flag.
- **B7**, **B8**, **B9** — every cap sentence in `state.ts` prints `${cap}`
  unformatted, so the share line reads `1000-token`, not `1,000-token`. One
  comma here would be two spellings of one number.
- **F3** — the disclosure headline is built from `SUBJECT.retract`, which is
  "takes back": ``this takes back a confirmed instruction — `self undo` takes
  it back``. The cell's point — that `commonLabel` reads `labels[0]`, so the
  noun is `instruction` — is unchanged.
- **E18** — `requireDemotableSeat` admits a `--demote` target only at the
  exposure of the tier being entered, so a demotion *out of* full can never
  name a full record and can never raise `requireDemotionRoom`'s refusal. The
  cell keeps its seeded state and takes the refusal that state does raise,
  `requireTokenRoom`'s: `the project index tier holds <n> of <cap> tokens and
  this text adds <m> more — name what demotes: … demote first with \`self state
  place <id> --exposure search --why "<reason>"\``, whose advertised line frees
  the room and lets the demotion land. `requireDemotionRoom` keeps the coverage
  it already has in `place.test.mjs`.
- **G7** — this repository does not track `AGENTS.md` or `CLAUDE.md`
  (`.gitignore`; `docs.test.mjs`'s proof 4 says why), so there is no checked-in
  file to compare the new template against. The cell now reads: a fold in a
  checkout whose untracked `AGENTS.md` / `CLAUDE.md` hold an older block
  rewrites both to the new template, and no checked-in file changes.
- **D11** lands in `apps/dsh-plugin/test/tools.test.mjs` beside G9, whose
  subject it shares: asserting it from the CLI's suite would reach across
  packages for a build that suite does not produce. **D10** keeps its CLI half
  — that `self context`'s bytes did not move — in
  `instruction-context.test.mjs`.
- **G3** lands in `golden.test.mjs`, **G8** in `handoff.test.mjs`, **G11**'s
  plugin half in `pr7-loader.test.mjs` where the signed-release fixture lives
  (its alias half is in `guide.test.mjs`), and **G13** in
  `instruction.test.mjs` beside A29 — `structure.test.mjs` reaches no CLI, and
  G13's claim is about what a fold leaves on disk.

Cells added and changed in review round 1 of #443, and why. The review found
no blocking finding; every `should` and `optional` it raised is applied in the
code, and the cell that proves it moves with it here:

- **A31** — "only `by` differs" was asserted as "the two `by` values are not
  equal", which one differing field satisfies. The cell now states the fields
  the two payloads agree on — `text`, `labels`, `exposure`, `scope`,
  `priority` — and that the one they differ on reads `person` against `agent`.
- **A33** — new. `--kind` is declared `multiple: true` and a second value is
  refused by name, as `skill.ts` does for `--command`: a single option would
  let the parser keep the last value and drop the first without a word. The
  refusal reads `--kind states the one section this instruction renders under,
  and was passed twice — pass rule, tool, or procedure once`.
- **A34** — new. `sanitize.ts` admits `0x0a`, so a multi-line text was
  recordable, and the surfaces disagreed about it: the listing and the render
  flattened it through `oneLine` while `--json` emitted the breaks. Refused at
  the add instead, the way `requireLine` refuses a multi-line `--command`:
  `an instruction is one line — "<first 40 characters>…" holds a line break;
  record each step as its own --kind procedure instruction, ordered by
  --priority`. The quoted head is flattened, so the refusal is itself one line.
- **B4**, **C4** — the cells named all three `orderEntities` legs and the tests
  drove one, the scope leg. Both now drive all three: two CLI adds are
  milliseconds apart and can never share a `ts`, so the recency and id legs are
  seeded with `logFixture` — a stated `ts` for the newer-first leg, and a pair
  sharing one `ts` for the leg where only the id is left.
- **B5**–**B9**, **B18**, **B19** — the closing line read `<n> tokens — <n> of
  the <cap>-token <scope> full cap (<pct>%)`, which reads as tier occupancy and
  is not: it counts the instructions alone. It keeps counting them and now says
  so — `instructions hold <n> tokens — …` (§D-6). **B18** is new and pins the
  distinction: one instruction and one non-instruction full record in one tier,
  where the line says 23 and the tier's own cap refusal says 73.
- **B7** — the cell drove a project-scoped record, where `project` is also what
  the old private spelling produced. It now drives a `--scope <other>`
  instruction listed from that other project, so the word `project` is
  `scopeLabel`'s answer — the exported one `state.ts`'s refusals are spelled
  with, not a second spelling of the same tier.
- **B15**, **C15** — the harness merges stdout and stderr into one string, so
  which stream the sentence came out on is not provable in this process. The
  text assertion stands and the tests carry a note saying what it does not
  prove; the stream half is a property of `console.error` and is covered where
  the harness can see it.
- **B19** — new. `estimateNote` was appended to every share line, so a store
  holding both a project set and a workspace manual printed the same sentence
  twice. It closes the last line only, and this cell counts the occurrences.
- **B20** — new. Nothing drove an unknown leaf under `instruction`; the cell
  pins that `self instruction bogus` answers with the branch usage.
- **C13** — `/archived/` passed on the word alone, wherever it came from. The
  cell now asserts the notice's whole sentence, as `handoff.test.mjs` asserts
  its own archived notice: `project "<slug>" is archived (<date>: <why>) — run
  \`self project restore <slug>\` to bring it back`.
- **C20**, **D-11** — the payload omitted `why` and `priority` where the record
  had none, so a reader had to branch on which keys arrived to learn that. Every
  entry now carries all five keys, with `null` for an absent one. The cell seeds
  the two shapes that produce one: an add with no `--why`, and a raw
  `state add --label instruction --exposure full`, which can hold no priority.
- **C25** — new. `instruction render --project <slug>` from outside every
  registered project renders that project's set; C16's refusal is what a call
  from there with no `--project` gets, and nothing drove the other half.
- **C26** — new. A `--workspace` instruction whose owning project is archived
  leaves every project's render, because `workspaceModels` walks
  `activeProjects`. Pinned as the current behaviour, not decided here; the
  "does not cover" list says so.
- **D7** — the cell asserted one `INSTRUCTION | ` line. It now asserts the
  whole block equals `instruction render`'s output line for line under the
  prefix, which is what "the packet and the command read through one helper"
  means.
- **D14** — new. With no instructions, `snapshot.instructions` was
  `[INSTRUCTION_HEAD]`, so the packet carried a populated-looking
  `## Instructions` holding a head line and nothing under it. The empty render
  is dropped before `handoffSection`, so the section reads `DATA | (none)` as
  every other empty section does.
- **D15** — new. A store that already used `state add --label instruction
  --exposure full` loses those records from `self context` on upgrade. Accepted
  — the label is the mechanism — and pinned so it is visible: such a record is
  absent from `self context`, renders under `## Unclassified`, and is still
  found by default `self search`. The "does not cover" list states it, and so
  does the pull request.
- **E7** — `/index/` passed on the word wherever it came from, including the
  `--exposure index` a receipt echoes back. The cell asserts
  `placement: project · index`.
- **E19** — new. `self undo` of the `entity.placed` that demoted an instruction
  restores it to the render; the undo verb was driven over the add and the
  retraction and not over the placement.
- **G1** — the cell checked that every flag the catalogue row names is one the
  parser accepts, which a row missing a flag satisfies. It now asserts the three
  catalogue entries are byte-identical to `INSTRUCTION_COMMAND.usage[n].syntax`,
  as H2 does for `init`, and that cli.md's `--json` paragraph names
  `instruction render` — one of the two local reads that declare a payload.
- **G3** — kept as it is. It is a proxy for the diff claim: the fixture is
  regenerated and committed, so what this cell can see is that no `instruction`
  line reached it outside the root usage listing, not that the committed diff
  held nothing else.
- **G5**, **D-7** — the managed-block bullet said what to run and not what an
  empty answer means, so the head line alone reads as a broken command. The
  bullet gains `If it prints only its head line, this workspace has recorded
  none yet.`, and the cell asserts the whole bullet.
- **G12** — the `subsystemOf` assertion could not fail for a `src/*.ts` path and
  is dropped. In its place the cell asserts the header carries the trust
  paragraph `skill.ts` carries: what an instruction is, that anyone who can
  append to the store can write one, and that the CLI only prints it.
- **G15** — new. `instructions.ts`'s `instructionsRenderedIn` was
  byte-identical to `skill.ts`'s `renderedIn` and its name misdescribed it — it
  collects every record that renders, not the instructions. One `renderedIn`
  lives in `model.ts`, which ARCHITECTURE.md names the owner of the store walks,
  and the cell asserts neither module kept a copy and that every caller imports
  the shared one. Its stated form was that `instructions.ts` imports it too; it
  cannot — a domain module may not import `model.ts` (ARCHITECTURE.md,
  "Layering"), and it no longer needs to, because its callers hand it the set.
  The importers asserted are `skill.ts`, `instruction.ts` and `views.ts`.
- **G16** — new. ARCHITECTURE.md's layer table names the layer a module is in,
  and it named neither of #440's modules, nor #391's or #379's. Rows are added
  for all six and the cell holds them there. Scoped to those six: the unscoped
  rule fails today on `cloud.ts`, `design.ts`, `sweep.ts` and `undo.ts`, which
  predate this change; widening the cell is the follow-up that adds their rows.

Cells added and changed in review round 2 of #443, and why. The round-2 review
found no blocking finding; every `should` and `optional` it raised is applied
in the code, and the cell that proves it moves with it here:

- **A35** — new. `requireOneLine` now trims before testing, as `skill.ts`'s
  `requireLine` does, and refuses every control character `oneLine` collapses
  rather than only `\n`/`\r`, so a tab breaks the one-line promise the same
  way a line break does. The cell drives padded and trailing-newline text
  recording trimmed, a mid-text tab refused with A34's wording, and nothing
  recorded on refusal.
- **C27** — new. `sectionPayload` now flattens `text` through `oneLine`, the
  transform the render already applies, so a raw `state add` record with a
  control character in its text can no longer show one string in the render
  and a different one in `--json`. The cell seeds that disagreement through
  `state add` and asserts the render line and the payload `text` agree.
- **D-11** — amended again. `priority` and `why` are now present only when
  the record carries them, an absent optional field omitted rather than
  written `null`, matching the CLI's existing convention (`login.ts`'s
  `console_base`). **C20** now asserts the key set per entry instead of
  asserting every entry carries five keys with `null` for an absent one.

A cell runs a command through `must` or `selfIn` from `test/harness.mjs`
(CONTRIBUTING.md, "Reaching the CLI from a test"): both run it in the test
process, both are `async`, and every call needs an `await`. Where a cell says
"a person", it drives `personIn` / `mustPerson` — the same execution with
`stdin.isTTY` set — and where it says "an agent" or "a session", it drives
`must`. Since #400 the only verb that refuses without a keyboard is
`artifact prune`, so the person/session distinction is about what the record
*says about who wrote it*, never about which calls are admitted.

## Where the issue and the code disagree

The issue is the accepted design and is not redesigned here. Where its prose
describes the code and the code says otherwise, the code wins and the cell
follows the code. Six places:

1. **"An agent's demotion lands as a proposal that `self state confirm` makes
   real"** (acceptance 2). Nothing enforces this. `statePlace` (`state.ts`)
   reads no keyboard: `requestedPlacement` demands `--why` on a demotion
   (`requireDemotionWhy`) and refuses a demotion *of a proposal*
   (`refuseDemotedProposal`), and that is all. "Demotion out of full is
   human-owned: an agent passes `--proposed`" is help prose in the `state`
   command detail (`state.ts` §"a demotion — exposure moving toward
   less-rendered"), and `place.test.mjs`'s own cell — "an agent demoting out of
   full proposes; the person confirms from the entity id" — drives `must` with
   an explicit `--proposed`. **E2** therefore passes `--proposed`, and **E4**
   pins that an agent omitting it demotes directly.
2. **"The retirement gate, which an agent cannot satisfy"** (acceptance 4,
   quoting #391's table). Since #400 `recordRetirement` *discloses* and
   proceeds — `discloseRetirement` prints through `notice` and returns
   `writtenBy()`; there is no refusal on the path. **F5** pins that a session's
   `state retract` lands with the disclosure printed.
3. **"Absent from the `self context` full block"** (acceptance 2). There is no
   full block *heading*: `fullSection` (`views.ts`) returns rows with no
   `header`, so the full tier renders headerless directly under `# <slug>`.
   **D1** asserts the record's text is absent from the whole render rather than
   asserting a missing heading.
4. **`--supersedes` naming a convention.** The issue holds the refusal in the
   instruction predicate. The fold already refuses it one layer down:
   `instruction add --supersedes` routes through `ComposedValues.supersedes` →
   `supersedeLinks` → `parseLink` → `requireSupersedable` →
   `requireSupersedeKind(entities, id, "entity")`, which sees
   `source === "convention"` and refuses in the fold's own words. The
   instruction predicate is needed only for the kinds the fold reads as
   `"entity"` — a skill, a runbook, a runbook run, a raw `state add` record.
   **A18** quotes the fold's wording; **A17**/**A19** quote the wording this
   table decides.
5. **"`estimateNote` … currently module-private and exported by this issue."**
   Confirmed: `function estimateNote(scale: TokenScale)` at `state.ts` carries
   no `export`. The issue is right; noted because B5/B6 depend on it.
6. **Section order.** The attribute table lists `--kind` values as
   `rule | tool | procedure`; the render sketch and acceptance 1 both order the
   *sections* Tools, Rules, Procedures. These are two different lists and not a
   contradiction: **C3** pins the section order, and **C18** pins that the kind
   a multi-labelled record reads as is the first of `rule`, `tool`, `procedure`
   the label list holds — membership, never position, exactly as `sourceOf`
   (`entities.ts`) reads a preset source.

Everything else in the issue checked out against `origin/main` af3899b:
`maxFunctionLines = 30`, `printingModules = []` and `sanctionedEdges = []` in
`test/structure.mjs`; `fullTokens` defaulting to 1,000 and `indexTokens` to
12,000 in `paths.ts`; `CONTEXT_TOKENS = 3_000` in `views.ts`; `ComposedValues`
carrying no `priority` field; `reserved` spreading last in `entityAdd`;
`runbook start` writing `labels: [RUNBOOK_RUN_LABEL, key]` through that spread;
`KINDS` in `search.ts` admitting no `instruction`; and `requireSupersedeKind`
reading `entity.source ?? "entity"`.

## Decisions this table makes

The issue leaves these open. Each is decided here, and every cell that depends
on one is marked **decided here**.

- **D-1 — the unclassified heading.** `## Unclassified`, rendered last, after
  `## Procedures`. A record with no kind label is a defect a raw `state add`
  minted; it renders rather than disappearing, and it renders where a reader
  finds it after the sections they came for. Cell **C17**.
- **D-2 — an empty section.** A heading with no entries is omitted, not printed
  empty. `render` is read verbatim into a session's context, where a heading
  promising rules and holding none is a line that costs tokens and says nothing.
  Cells **C1**, **C2**.
- **D-3 — the empty render.** With no instructions at all, `render` prints the
  head line `# Instructions — follow; do not restate.` and nothing else, exit 0.
  The head is what a concatenating caller splices; a command that printed
  nothing would make an empty store indistinguishable from a failed run.
  Cell **C1**.
- **D-4 — the non-instruction supersedes refusal.** ``<id> is not an
  instruction — `instruction add --supersedes` replaces an instruction; run
  `self instruction` for the ids it takes``. It names the listing rather than
  the other kind's add verb because the fold cannot tell which other kind it is
  — every label-composed record reads as `"entity"`. Cells **A17**, **A19**,
  **A32**.
- **D-5 — the default priority.** 50, the value `SKILL_ROW` uses, written into
  the payload by the row rather than left absent. `orderEntities` sorts a
  missing priority to `MAX_SAFE_INTEGER`, so an absent default would put every
  instruction below every priced record in any shared ordering. Cell **A8**.
- **D-6 — the cap-share line.** `self instruction` closes with
  `instructions hold <n> tokens — <n> of the <cap>-token <scope> full cap (<pct>%)<estimate note>`,
  where the estimate note is `estimateNote`'s text verbatim and `<scope>` is
  `project` or `workspace` as `scopeLabel` spells it. One line per occupied
  tier, so a workspace manual and a project set are never added together into a
  number neither cap governs. The line counts the instructions and nothing else:
  the tier itself holds every full-exposure record, so its own occupancy is a
  larger number, and the cap refusals in `state.ts` are where that one is
  stated. The subject is named in the line rather than left to be read into it
  — **amended in review round 1**. The estimate note closes the last line only,
  since it is one statement about where every number on the page came from.
  Cells **B5**–**B9**, **B18**, **B19**.
- **D-7 — the managed-block bullet.** One bullet in `BLOCK_BODY`, placed
  directly after the `Session start: run \`self context\`` bullet:
  `- Then run \`self instruction render\` and follow it; it is the operating`
  `  manual for this workspace and is outside the context render budget. If it`
  `  prints only its head line, this workspace has recorded none yet.`
  A bullet, not a heading — `docs.test.mjs` asserts the block's section
  headings. The closing sentence is what a session reading the head line alone
  needs to be told, since an empty render is otherwise indistinguishable from a
  command that failed to answer — **amended in review round 1**, wrapped to the
  block's own width, which is prose formatting and not a third line of meaning.
  Cells **G5**, **G6**.
- **D-8 — the handoff section.** `## Instructions`, placed directly after
  `## Applicable conventions` and before `## Current project context`, wrapped
  by `handoffSection` as `--- BEGIN INSTRUCTIONS (renderer-owned) ---`. Beside
  the conventions because both are standing direction; before the context
  subsection because the context subsection is the one capped thing in the
  packet. Cells **D7**, **D8**.
- **D-9 — the snapshot-limit line.** `snapshotLimitLines`'s third line becomes
  `"Protocol, instructions, conventions, work, and reports are mandatory and are not silently truncated."`
  Cell **D8**, **G8**.
- **D-10 — `search` exposure.** An instruction placed at `search` is absent
  from `render` and from `self context`, and is found by default `self search`.
  `render` shows what a session must follow; a record its author moved to the
  search tier is one they took out of the rendered set. Cell **C11**, **E15**.
- **D-11 — the `--json` payload.** `render --json` emits
  `{"project": "<slug>", "sections": [{"kind": "tool", "heading": "Tools", "entries": [{"id": "e-…", "text": "…", "scope": "project", "priority": 50, "why": "…"}]}]}`
  — sections in render order, entries in render order, empty sections omitted
  as in D-2. `text` is flattened through `oneLine`, the same transform the
  render applies, so the render and the payload agree on one string for every
  record, including one a raw `state add` minted — **amended in review round
  2**. `priority` and `why` are present only when the record carries them: an
  absent optional field is omitted, never `null`, matching the CLI's existing
  convention (`login.ts`'s `console_base`) — **amended in review round 2**.
  Cells **C20**–**C22**, **C27**.
- **D-12 — `--workspace` with `--scope`.** Refused by name:
  `--workspace and --scope name the same thing two ways — pass one of them`.
  Cell **A15**.
- **D-13 — no `--project` on `list`.** `self instruction list --project <slug>`
  is an unknown option; reading another project's set is `instruction render
  --project <slug>`. The list prints a cap share, and a cap share for a tier the
  caller is not standing in is a number about somebody else's store.
  Cell **B17**.

## The problem

`self context` is the projection a session reads at start, and every record in
it competes for one 3,000-token budget (`CONTEXT_TOKENS`, `views.ts`) under
priority ordering that `fitKeeps` elides from the bottom section upward. That
is right for judgement rules and wrong for execution rules — "implementation and
tests run on the dev VM", "a PR gets a cross-model review before merge" — for
tool notes beyond the fixed protocol block, and for procedures with a fixed
order. Today those are held as a `convention`, where they are subject to the
budget and interleave with everything else by priority, or in one person's
editor memory, where no other session sees them and the same miss repeats.

The gap, narrowly: no record kind is (a) rendered whole and never elided,
(b) grouped into ordered sections, and (c) still a first-class entity with
supersession, retraction, undo and placement.

## The mechanism

Nothing new is minted. Everything composes out of the `entity.*` grammar:
**no new event type, no new reducer, no new reserved metadata key, no new row
in `BUILTIN_ROWS`, no `@superself/fold` change, `FOLD_VERSION` stays at 1.**

| The thing | The machine it is made of |
|---|---|
| An instruction | an entity labelled `instruction` with `source === undefined` |
| Its section | a second label beside it — `rule`, `tool` or `procedure` — written through the `reserved` spread, exactly as `runbook start` writes `[runbook-run, <key>]` |
| Its section order | fixed in the render: Tools, Rules, Procedures, Unclassified |
| Its order inside a section | the existing `priority`, ties by `orderEntities` |
| Which projects render it | the existing `EntityScope` — omit, `--workspace`, or `--scope <slug>` |
| Whether it is in `render` or in `context` | the existing `exposure` — `full` is in `render` and out of `context`, `index` is the reverse |
| A correction | `--supersedes <id>` on the add |
| Withdrawal, demotion, inspection, undo | `state retract`, `state place`, `state show [--history]`, `self undo` |

The one widening: `ComposedValues` (`state.ts`) gains a `priority` field,
validated by `validPriority`, so a composed add can state a priority instead of
falling back to its `AliasDefaults` row constant. `addOptionalFields` already
prefers `values.priority` over `row.priority`; only the interface omits it.

The one exclusion: one predicate beside `isRunbookRun` / `isSkill` in
`projectContextSections`'s `placed` filter, excluding
`labels.includes("instruction") && exposure === "full"`. Because the predicate
is conditional where the other two are not, a demoted instruction stays in
`placed` and lands in `indexSection` with no further code.

## 4.1 Group A — `instruction add`

State variables: cwd inside a registered project / outside every one / inside an
archived project's checkout; `--kind` given, absent, or unknown; `--priority`
given, absent, or malformed; scope omitted, `--workspace`, `--scope <slug>`,
`--scope project`, `--scope <unregistered>`, `--scope <archived>`; the
`--supersedes` target's kind — instruction, skill, runbook, convention, raw
`state add` entity, unknown id, already-superseded instruction; `--kind` passed
once vs twice; the text one line vs holding a line break vs a control
character vs padded or trailing whitespace; the project full tier under / at /
over its cap; `--proposed` on / off; a workspace of one project vs several; a
person at the keyboard vs a session.

| Cell | Seeded state | Operation | Expected outcome |
|---|---|---|---|
| A1 | no instructions, inside a project | `instruction add "tests run on the dev VM" --kind rule` | one `entity.confirmed`, `e-` id on the receipt; payload `labels ["instruction","rule"]`, `exposure "full"`, `scope "project"`, `priority 50`; `state show` reads `placement: project · full` |
| A2 | as A1 | `--kind tool` | `labels ["instruction","tool"]` |
| A3 | as A1 | `--kind procedure` | `labels ["instruction","procedure"]` |
| A4 | as A1 | `--kind harness` | refused: ``"harness" is not an instruction kind — pass rule (a judgement or execution rule), tool (a note about a command), or procedure (steps in a fixed order)`` — **decided here** |
| A5 | as A1 | `--kind` omitted | refused by the requirement gate: `self instruction add needs --kind: which section it renders under` — **amended in implementation** |
| A6 | as A1 | `instruction add "" --kind rule` and `"   "` | refused by the text gate: `usage: self instruction add "<text>"` |
| A7 | as A1 | `--kind rule --priority 10` | payload `priority 10` — the `ComposedValues.priority` widening |
| A8 | as A1 | `--priority` omitted | payload `priority 50`, written by the row — **decided here (D-5)** |
| A9 | as A1 | `--priority -1`, then `--priority x` | refused: `--priority takes a whole number, 0 or higher, small enough to keep exactly — "-1" is not one` |
| A10 | two registered projects | `--kind rule --workspace` | payload `scope "workspace"` |
| A11 | two registered projects | `--kind rule --scope <other slug>` | payload `scope "<other slug>"`; the event lands in **this** project's log |
| A12 | as A1 | `--scope project` | refused: `--scope project was retired — omit --scope to place a record in the project you are in, name another registered project with \`--scope <slug>\`, or \`--scope workspace\` for every project` |
| A13 | as A1 | `--scope nosuch` | refused: `"nosuch" is not a registered project — run \`self project\` to list the slugs, or --scope workspace to render the record in every project` |
| A14 | an archived project registered | `--scope <archived slug>` | refused: `project "<slug>" is archived, so a record placed there would render nowhere — run \`self project restore <slug>\`` |
| A15 | two registered projects | `--workspace --scope <slug>` | refused: `--workspace and --scope name the same thing two ways — pass one of them` — **decided here (D-12)** |
| A16 | one confirmed instruction | `--supersedes <its id>` | accepted; one `entity.confirmed` carrying `supersedes`; the predecessor folds to `superseded`; the retirement disclosure prints before the write |
| A17 | one registered skill | `--supersedes <skill id>` | refused: ``<id> is not an instruction — `instruction add --supersedes` replaces an instruction; run `self instruction` for the ids it takes`` — **decided here (D-4)**; nothing recorded |
| A18 | one convention | `--supersedes <convention id>` | refused by the fold: ``<id> is a convention record — replace it with `self convention add "<text>" --supersedes <id>``` |
| A19 | one runbook definition | `--supersedes <runbook id>` | the D-4 refusal, identical to A17 — the fold reads both as `"entity"` |
| A20 | as A1 | `--supersedes e-nosuch` | refused: `unknown entity "e-nosuch" — run \`self state list\` for ids` |
| A21 | v1 superseded by v2 | `--supersedes <v1 id>` | refused: `<id> was already superseded — nothing is left to supersede` |
| A22 | as A1 | `--kind rule --proposed` | one `entity.proposed`; absent from `instruction render`; `self context` carries `proposed entity <id>: <text> (confirm with \`self state confirm <id>\`)` |
| A23 | project full tier at `fullTokens` | `instruction add "…" --kind rule` | refused: `the project full tier holds <n> of <cap> tokens and this text adds <m> more — name what demotes: pass \`--demote <id>\` (that full entity moves to index), or demote first with \`self state place <id> --exposure index --why "<reason>"\`` |
| A24 | as A23 | `instruction add "…" --kind rule --proposed --demote <full id>` | the add and the demotion both land as proposals; `state show <full id>` still reads `placement: project · full`; `self context` carries both `proposed entity` and `proposed placement of` lines |
| A25 | project full tier under its cap | `--demote <id>` on the add | refused: `the project full tier is not over its cap — nothing needs to demote; demote directly with \`self state place <id> --exposure index --why "<reason>"\`` |
| A26 | cwd outside every registered project | `instruction add "…" --kind rule` | refused by `requireProject`; nothing recorded |
| A27 | cwd inside an archived project's checkout | `instruction add "…" --kind rule` | refused by the append gate: `project "<slug>" is archived, so nothing more is recorded into it — run \`self project restore <slug>\`` |
| A28 | project full tier at its cap, two projects | `--kind rule --workspace` | admitted — `tierOf` charges the workspace full tier, not this project's; the project tier's held count is unchanged, and a following project-scoped full `state add` is still refused |
| A29 | as A1 | the append, then `self fold` | exactly one `entity.confirmed`; no event type the vocabulary lacks; the state directory gains no `instruction/` folder |
| A30 | as A1 | `--kind rule --why "so a PR is never reviewed by its author"`, then `--label worker` | the `why` is on the payload and prints in `state show`; `--label` is refused: `unknown option '--label' — run \`self instruction --help\`` — the `reserved` spread can never silently discard a caller's label because no such flag exists |
| A31 | as A1 | the same add through `mustPerson` and through `must` | both land; only `by` differs — the add has no keyboard gate |
| A32 | after A17's refusal, same cwd | `self instruction` | the advertised command answers: the one standing instruction is listed and the skill is not |
| A33 | as A1 | `--kind rule --kind tool` | refused: `--kind states the one section this instruction renders under, and was passed twice — pass rule, tool, or procedure once`; nothing recorded — **added in review round 1** |
| A34 | as A1 | `instruction add "<a text holding a line break>" --kind procedure` | refused: `an instruction is one line — "<first 40 characters>…" holds a line break; record each step as its own --kind procedure instruction, ordered by --priority`; the refusal is one line, and nothing is recorded — **added in review round 1** |
| A35 | as A1 | `--kind rule` with `"  padded  "`, then with `"text\n"`, then with `"run\tthe suites"` | the first two record trimmed — `padded`, `text`; the third is refused with A34's wording, its quoted head flattened by `oneLine` same as a line break's; nothing recorded on the refusal — **added in review round 2** |

## 4.2 Group B — `self instruction` and `instruction list`

State variables: zero / one / many instructions; one kind present vs all three;
two entries at one priority; scope mix — project-scoped, `--workspace`, and
another project's project-scoped record; `SUPERSELF_JSON=1` set / unset;
`--json` passed / not; the token scale measured (`self tokens` has run) vs
estimated; `fullTokens` at its 1,000 default vs raised in `config.json`; the
full tier under / over its cap; proposed / superseded / retracted / demoted
records present; cwd inside / outside a project; an unreadable project store
among the registered ones; a non-instruction record in the same tier; a leaf
the branch does not have.

| Cell | Seeded state | Operation | Expected outcome |
|---|---|---|---|
| B1 | no instructions | `self instruction` | says so and names `self instruction add "<text>" --kind rule\|tool\|procedure`, exit 0 |
| B2 | one instruction | `self instruction` and `self instruction list` | byte-identical stdout — the bare verb is the list, not a second page |
| B3 | one of each kind, priorities 10/20/30 | `self instruction` | groups headed `Tools`, `Rules`, `Procedures` in that order; entries ascending by priority inside each |
| B4 | two `rule` entries at priority 20, one `--workspace` and one project-scoped, different `ts` | `self instruction` | the order is `orderEntities`: workspace first (`scopeRank`), then newer `ts`, then id |
| B5 | one instruction, no `self tokens` run | `self instruction` | the closing line carries the total and ` (estimated at <n> tokens per character; \`self tokens\` records a measurement)` |
| B6 | after `self tokens` records a measurement | `self instruction` | the same line, with no estimate note |
| B7 | one project instruction, `fullTokens` at its 1,000 default | `self instruction` | the share line reads `<n> tokens — <n> of the 1000-token project full cap (<pct>%)` — **decided here (D-6)**, cap spelling **amended in implementation** |
| B8 | `config.json` `fullTokens` raised to 4,000 | `self instruction` | the share is against 4,000, not 1,000 |
| B9 | one project-scoped and one `--workspace` instruction | `self instruction` | two share lines, one per occupied tier: `project full cap` and `workspace full cap`; neither total includes the other's tokens — **decided here (D-6)** |
| B10 | one instruction | `self instruction list --json` | refused by name on stdout as a JSON envelope: ``\`self instruction list\` has no --json contract yet``, code `json_unsupported`, hint `read the human output, or use a command that declares --json` |
| B11 | one instruction, `SUPERSELF_JSON=1` in the environment, no `--json` | `self instruction list` | the human listing prints, exit 0 — an ambient preference is ignored on a leaf with no payload contract |
| B12 | one confirmed, one proposed, one superseded, one retracted, one demoted to `index` | `self instruction` | only the confirmed current full one is listed; the count and the token total exclude the other four |
| B13 | one instruction demoted to `index` | `self instruction`, then `self context` | absent from the listing; present in `self context` `## Index` as `- [instruction, rule] <text>` |
| B14 | cwd outside every registered project | `self instruction` | refused by `requireProject` |
| B15 | three registered projects, one store unreadable, a `--workspace` instruction in a readable one | `self instruction` | the readable projects' instructions are listed; stderr carries `project "<slug>" is left out of this answer — its state could not be read: <why>`; exit 0 |
| B16 | no instructions, at the cwd B1's answer was read in | the `self instruction add "<text>" --kind rule` line B1 advertised | records one instruction; `self instruction` then lists it |
| B17 | two registered projects | `self instruction list --project <other>` | refused: `unknown option '--project' — run \`self instruction --help\`` — reading another project's set is `instruction render --project` — **decided here (D-13)** |
| B18 | one instruction and one non-instruction full record in the same tier | `self instruction` | the share line's numbers are the instructions' alone — `instructions hold 23 tokens — 23 of the 1000-token project full cap (2%)`; what the tier itself holds is the larger number the cap refusal states — **added in review round 1** |
| B19 | one project-scoped and one `--workspace` instruction, no `self tokens` run | `self instruction` | two share lines, and the estimate note on the last of them exactly once — **added in review round 1** |
| B20 | any state | `self instruction bogus` | refused with the branch usage: `usage: self instruction \| add "<text>" --kind rule\|tool\|procedure \| render [--project <slug>]` — **added in review round 1** |

## 4.3 Group C — `instruction render`

State variables: zero instructions; one kind vs all three vs an unclassified
one; exposure `full` / `index` / `search`; status confirmed / proposed /
superseded / retracted; scope project / `--workspace` / another project's;
`--project` omitted / a registered slug / an archived slug / an unregistered
slug; a raw `state add --label instruction` with no kind label, with two, and
with a preset label beside it; `--json` / `SUPERSELF_JSON=1`; cwd inside /
outside a project; an unreadable store among the registered ones; the full tier
far over its cap; a `--workspace` record whose owning project is archived; an
entry with no `why` and one with no priority; a raw-verb record whose text
holds a control character `oneLine` collapses.

| Cell | Seeded state | Operation | Expected outcome |
|---|---|---|---|
| C1 | no instructions | `instruction render` | exactly `# Instructions — follow; do not restate.` and nothing else; no section heading; exit 0 — **decided here (D-2, D-3)** |
| C2 | one `rule` only | `instruction render` | the head, then `## Rules` and one `- <text>` line; no `## Tools`, no `## Procedures`, no `## Unclassified` — **decided here (D-2)** |
| C3 | one of each kind | `instruction render` | headings in the order `## Tools`, `## Rules`, `## Procedures`; entries by priority inside each |
| C4 | two `tool` entries at one priority | `instruction render` | the `orderEntities` tie-break, identical to B4 |
| C5 | project A holds a `--workspace` instruction | `instruction render` run in project B | it renders in B |
| C6 | project B holds a `--scope A` instruction | `instruction render` in A, then in B | present in A's render, absent from B's |
| C7 | one proposed instruction | `instruction render` | absent |
| C8 | v1 superseded by v2 | `instruction render` | v2 renders, v1 is absent |
| C9 | one retracted instruction | `instruction render` | absent |
| C10 | one instruction demoted to `index` | `instruction render`, then `self context` | absent from the render; present in `## Index` |
| C11 | one instruction placed at `search` | `instruction render`, then `self context` | absent from both; the `## Index` trailing line counts it as one entity at search exposure — **decided here (D-10)** |
| C12 | project A holds instructions | `instruction render --project A` run in B | A's render |
| C13 | an archived project holding instructions | `instruction render --project <archived slug>` | renders, with the archived notice beside it |
| C14 | two registered projects | `instruction render --project nosuch` | refused by `requireRegistered`, naming `self project` |
| C15 | three registered projects, one store unreadable, a `--workspace` instruction in a readable one | `instruction render` | the readable set renders; stderr carries `project "<slug>" is left out of this answer — its state could not be read: <why>` |
| C16 | cwd outside every registered project, no `--project` | `instruction render` | refused by `requireProject` |
| C17 | `self state add "raw note" --label instruction --exposure full` | `instruction render` | renders under `## Unclassified`, printed after `## Procedures` — **decided here (D-1)** |
| C18 | `self state add "raw note" --label instruction --label procedure --label rule --exposure full` | `instruction render` | renders under `## Rules` — the kind is the first of `rule`, `tool`, `procedure` the label list holds, membership never position |
| C19 | `self state add "raw note" --label instruction --label convention --exposure full` | `instruction render`, then `self context` | absent from the render — `sourceOf` folds it to `EntitySource "convention"`, so `source !== undefined` and the predicate rejects it; present in `self context` as an ordinary full-exposure record |
| C20 | one of each kind, a fourth added with no `--why`, and a fifth from `state add --label instruction --exposure full` | `instruction render --json` | one JSON object on stdout and nothing around it: `project`, then `sections` in render order, each `{kind, heading, entries}` with `entries` `{id, text, scope, ...}` in render order; empty sections absent. `Object.keys`, order aside, is `[id, text, priority, scope, why]` for the three seeded with `--why` (five keys), `[id, text, priority, scope]` for the fourth (four keys, no `why`), and `[id, text, scope]` for the fifth (three keys, no `priority` and no `why`) — **decided here (D-11)**, entry shape **amended in review round 1**, key presence **amended in review round 2** |
| C21 | as C20, `SUPERSELF_JSON=1`, no `--json` | `instruction render` | the identical payload — the leaf declares `--json`, so the ambient preference is honoured here where B11 ignores it |
| C22 | as C20 | `instruction render` and `instruction render --json` | the payload's entry ids and their order equal the rendered lines and their order, section for section |
| C23 | `fullTokens` set to 20 with several full instructions already recorded | `instruction render`, then `instruction add` | every entry renders whole and untruncated; the add is refused by the cap refusal of A23 — parity with `context.test.mjs` "a store over a cap renders in full while state add stays gated" |
| C24 | one full instruction | `self context` | the render's head line `# Instructions — follow; do not restate.` appears nowhere in `self context` — `render` is a separate command and is never spliced in, because `fitKeeps` never cuts `head` and would zero every other section |
| C25 | project A holds instructions, cwd outside every registered project | `instruction render --project A` | A's render, exit 0 — naming the project is what answers C16's refusal — **added in review round 1** |
| C26 | project B holds a `--workspace` instruction, then B is archived | `instruction render` in A and in C, then `--project B` | absent from both A's and C's render — `workspaceModels` walks `activeProjects` — and present when B is named. The current behaviour, pinned rather than decided — **added in review round 1** |
| C27 | a raw `state add "first line\nsecond line" --label instruction --exposure full`, and `instruction add $'run\tthe suites' --kind rule` seeded through `state add` too, since A35 refuses the tab at the add | `instruction render` and `instruction render --json` | the render's `- <text>` line and the payload entry's `text` are the identical, `oneLine`-flattened string for both records — **added in review round 2** |

## 4.4 Group D — context, search, handoff and the plugin

State variables: exposure `full` vs demoted to `index`; scope project vs
`--workspace`; a workspace of one project vs several; a work unit open for the
handoff; the store under vs far over the retention caps; the dsh plugin's
runner; `--type` given as `entity` vs `instruction` vs omitted; `--all` vs the
default search set; cwd inside a project; a store holding no instruction at
all; a record carrying the label from before this verb existed.

| Cell | Seeded state | Operation | Expected outcome |
|---|---|---|---|
| D1 | one full-exposure instruction | `self context` | its text appears nowhere in the render — not in the headerless full block, not in `## Index`, not in any live section |
| D2 | the same record demoted to `index` | `self context` | present in `## Index` as `- [instruction, rule] <text>` |
| D3 | one full-exposure instruction | `self search "<a word from its text>"`, then the same with `--type entity` | found by both — the default set is every live record the context render does not show, and a label-composed record's kind is `entity` |
| D4 | one full-exposure instruction | `self search "x" --type instruction` | refused: `unknown record kind "instruction" — pass one of goal, decision, convention, objective, milestone, work, entity` |
| D5 | the same record demoted to `index` and rendering in `## Index` | `self search "<word>"`, then `--all` | absent from the default answer (context showed it); found under `--all` |
| D6 | one full instruction and one open work unit | `self handoff <work-id>` | the packet's `## Current project context` subsection carries no line holding the instruction's text |
| D7 | as D6 | `self handoff <work-id>` | the packet carries `## Instructions` between `## Applicable conventions` and `## Current project context`, wrapped as `--- BEGIN INSTRUCTIONS (renderer-owned) ---`, holding the render's entries — **decided here (D-8)** |
| D8 | as D6 | `self handoff <work-id>` | `## Snapshot limits` reads `Protocol, instructions, conventions, work, and reports are mandatory and are not silently truncated.` verbatim — **decided here (D-9)** |
| D9 | one full instruction and one convention | `self handoff <work-id>` | `## Applicable conventions` holds the convention and not the instruction; the conventions closure is unchanged |
| D10 | one full instruction | the dsh `superself_context` tool | its text is byte-identical to the same tool's output against a store holding no instruction — the plugin's context tool is untouched |
| D11 | one of each kind | the dsh `superself_instructions` tool | `superselfTools(run)` returns five definitions; the fifth takes no parameters, is concurrency-safe, runs `["instruction", "render"]`, and returns the render text |
| D12 | `fullTokens` 20 and `indexTokens` 20, several full instructions and two index records | `self context`, `instruction render`, `state add` | the index rows render in full, the instruction render prints whole, and `state add` is still refused by the index cap — the parity `context.test.mjs` pins for records now pinned for instructions |
| D13 | project A holds a `--workspace` instruction, three projects registered | `self context` and `instruction render` in each | absent from every project's `self context`; present in every project's `instruction render` |
| D14 | no instructions, one open work unit | `self handoff <work-id>` | the packet carries `## Instructions` holding exactly `DATA \| (none)` between its markers, and no `INSTRUCTION \| ` line anywhere — an empty render reads as every other empty section does — **added in review round 1** |
| D15 | `self state add "<text>" --label instruction --exposure full`, recorded before the upgrade | `self context`, `instruction render`, default `self search` | absent from `self context`; renders under `## Unclassified`; found by default `self search`. The behaviour change an existing store sees, pinned rather than prevented — **added in review round 1** |

## 4.5 Group E — placement

State variables: the actor — a person (`mustPerson`) vs a session (`must`);
`--proposed` passed or not; the record's status confirmed vs proposed vs
superseded vs retracted; the move — demotion, promotion, scope, priority, none,
no-op; `--why` given or not; the destination tier under / at / over its cap; the
index tier's own room; the record's owning log this project's vs another's; the
scope destination active vs archived; the placement standing vs taken back with
`self undo`.

| Cell | Seeded state | Operation | Expected outcome |
|---|---|---|---|
| E1 | one full instruction, a person at the keyboard | `mustPerson … state place <id> --exposure index --why "narrower than it looked"` | lands directly; `state show` reads `placement: project · index`; the record leaves `instruction render` and appears in `self context` `## Index` |
| E2 | one full instruction, a session | `must … state place <id> --exposure index --why "narrower than it looked" --proposed` | an `entity.placed` proposal; `state show` still reads `placement: project · full` plus `pending placement: exposure index (narrower than it looked)` and `confirm with \`self state confirm <id>\``; `self context` carries `proposed placement of <id>: exposure index (narrower than it looked)`; the instruction still renders |
| E3 | after E2, at the cwd the receipt was read in | the advertised `self state confirm <id>` | the demotion lands; `state show` reads `placement: project · index`; the record leaves `instruction render` and enters `## Index`; a second confirm refuses `already confirmed` |
| E4 | one full instruction, a session | `must … state place <id> --exposure index --why "…"` with **no** `--proposed` | it lands directly. Nothing refuses it: "demotion out of full is human-owned" is `state` help prose, not a gate — see disagreement 1 |
| E5 | one full instruction | `state place <id> --exposure index` | refused: `demoting <id> from full to index needs --why "<reason>" — a record leaves the rendered set only with its reason on record` |
| E6 | one **proposed** instruction at `full` | `state place <id> --exposure index --why "…"` | refused: `<id> is still proposed, so it renders nowhere to be demoted from — confirm it with \`self state confirm <id>\` and demote it then, or propose it at index instead` |
| E7 | after E6, same cwd | the advertised `self state confirm <id>`, then the demotion again | the confirm lands, the demotion then lands; the second half of the advertised remedy — proposing it at `index` on a fresh record — records `exposure index` with no `--why` demanded |
| E8 | one instruction at `index` | `state place <id> --exposure full` | no `--why` demanded; the record returns to `instruction render` and leaves `## Index` |
| E9 | one instruction at `index`, the project full tier at `fullTokens` | `state place <id> --exposure full` | refused: `the project full tier holds <n> of <cap> tokens and this text adds <m> more — name what demotes: …` |
| E10 | one project-scoped instruction, three registered projects | `state place <id> --scope workspace` | no `--why` demanded — a cross-project move is not a demotion; the instruction then renders in every project's `instruction render` |
| E11 | one instruction, an archived project registered | `state place <id> --scope <archived slug>` | refused: `project "<slug>" is archived, so a record placed there would render nowhere — run \`self project restore <slug>\`` |
| E12 | two `rule` instructions at priorities 10 and 20 | `state place <the 20 one> --priority 5` | no `--why` demanded; it moves above the other inside `## Rules` |
| E13 | one instruction | `state place <id>` with no placement flag | refused: `state place changes placement — pass --priority <n>, --exposure full\|index\|search, --scope <slug>\|workspace, or several` |
| E14 | one instruction at `full` | `state place <id> --exposure full` | refused: `<id> already sits at that placement — nothing changes` |
| E15 | one full instruction | `state place <id> --exposure search --why "kept for the record"` | it leaves `instruction render` and `## Index`; `## Index`'s trailing line counts it; default `self search` finds it — **decided here (D-10)** |
| E16 | one retracted instruction | `state place <id> --priority 1` | refused: `<id> was retracted — a withdrawn record no longer renders, so it has no placement to change` |
| E17 | project A's log owns a `--workspace` instruction, cwd in project B | `state place <id> --exposure index --why "…"` from B | resolves here and the `entity.placed` lands in **A's** log; afterwards both projects' `instruction render` omit it and both `## Index` blocks hold it |
| E18 | one full instruction, the index tier at `indexTokens` | `state place <full id> --exposure index --why "…"` | refused: `the project index tier holds <n> of <cap> tokens and this text adds <m> more — name what demotes: … demote first with \`self state place <id> --exposure search --why "<reason>"\``; running that advertised line from there frees the room and the demotion then lands — **amended in implementation** |
| E19 | one full instruction demoted to `index` | `self undo <the entity.placed>` | the demotion is taken back: `<id> is placed where it was — the placement was taken back`, `state show` reads `placement: project · full`, the record renders again and leaves `## Index` — **added in review round 1** |

## 4.6 Group F — lifecycle

State variables: the actor — a person vs a session; the record's status live /
proposed / superseded / retracted; a supersession chain of one, two, three; the
event an undo names — the add, the confirm, the retraction, the supersession;
`--why` given or not; the full tier under / over its cap at confirm time; cwd
inside a project.

| Cell | Seeded state | Operation | Expected outcome |
|---|---|---|---|
| F1 | one live instruction | `state retract <id> --why "the VM moved"` | `entity.retracted`; it leaves `instruction render`, `self instruction`, `self context` and the default `self search` set |
| F2 | one live instruction | `state retract <id>` | refused by the requirement gate: `self state retract needs --why: why the record no longer holds` — **amended in implementation** |
| F3 | one live instruction | `state retract <id> --why "…"` | the disclosure prints first: the headline is ``this takes back a confirmed instruction — `self undo` takes it back`` (`commonLabel` reads `labels[0]`; **amended in implementation**), and the target line reads `<id>  instruction  confirmed <ts>  (<age>)` followed by the quoted text |
| F4 | after F3, same cwd | the advertised `self undo` | the retraction is taken back; the instruction renders again |
| F5 | one live instruction, a session, no keyboard | `must … state retract <id> --why "…"` | it lands, with the disclosure printed. Since #400 only `artifact prune` refuses without a keyboard — see disagreement 2 |
| F6 | one instruction with a `why` | `state show <id>` | the ordinary entity page: the text, `[instruction, rule]`, `placement: project · full`, and the `why` |
| F7 | one instruction added, demoted, then retracted | `state show <id> --history` | that record's events alone, oldest first: `entity.confirmed`, `entity.placed`, `entity.retracted` |
| F8 | v1 → v2 → v3 | `instruction render`, then `state show <v1> --history` | only v3 renders; v1's page names its successor; the chain is derived from the `supersedes` links and stored nowhere |
| F9 | v1 superseded by v2 | `self undo <the entity.confirmed that recorded v2>` | v2 leaves and v1 is live and rendering again |
| F10 | one first instruction, nothing superseded | `self undo <its entity.confirmed>` | it leaves the render and the listing — no acceptance-undo refusal since #390 |
| F11 | after F1 | `self undo <the entity.retracted>` | the instruction stands again and renders |
| F12 | v1 superseded by v2 | `self undo <v2's event> --supersession` | receipt: `<id> stands and no longer claims to replace anything — its supersession was taken back`; v2 still renders and v1 renders again beside it |
| F13 | one proposed instruction | `self state confirm <id>` | it becomes confirmed and enters `instruction render`; a second confirm refuses `already confirmed` |
| F14 | one proposed instruction, the project full tier at `fullTokens` since the propose | `self state confirm <id>` | refused: `confirming this would put the project full tier over its cap (<n> of <cap> tokens held) — free room first with \`self state place <id> --exposure index --why "<reason>"\``; running that advertised line from there lets the confirm land |
| F15 | one retracted instruction | `state retract <id> --why "…"` again, then `instruction add "…" --kind rule --supersedes <id>` | the retract refuses (already retracted); the add refuses `<id> was already retracted — nothing is left to supersede` |

## 4.7 Group G — surfaces

Every file the new verb touches, one cell each. State variables: the checked-in
documents vs the built contract; the golden fixture vs a fresh render; the
managed block in `AGENTS.md` and in `CLAUDE.md`; a plugin or alias claiming the
verb; the structure gate's thresholds as `test/structure.mjs` declares them.

| Cell | Seeded state | Operation | Expected outcome |
|---|---|---|---|
| G1 | `docs/reference/cli.md` gains an `Instructions` family row naming `instruction [list]`, `instruction add "<text>" --kind rule\|tool\|procedure [--priority n] [--workspace\|--scope <slug>] [--supersedes <id>] [--demote <id>] [--proposed] [--why w]`, `instruction render [--project <slug>] [--json]` | `docs.test.mjs` test H1 | every flag the row names is one the parser accepts |
| G2 | the same document's `text` fence of top-level verbs gains `instruction` | `docs.test.mjs` proof 2 | the catalogue diffs clean against `COMMANDS` from `dist/main.js` |
| G3 | `test/fixtures/golden/piped.txt` regenerated | the golden comparison | the only change is the root usage listing, which gains the `instruction …` lines and nothing else |
| G4 | `guide.ts`'s `placement` topic gains the sentence that a full-exposure instruction is outside the 3,000-token context render budget and renders through `self instruction render` | `guide.test.mjs`, then `self help placement` | the topic body carries the sentence and the page prints it |
| G5 | `BLOCK_BODY` gains one bullet after the `Session start` bullet | `docs.test.mjs` "connect writes one managed block, of a fixed shape, to both instruction files" | the block's section headings are unchanged — the addition is a bullet, not a heading — and both instruction files carry the new bullet — **decided here (D-7)** |
| G6 | a checkout whose `AGENTS.md` holds the new block | the `self instruction render` line the bullet advertises, run from that checkout | it runs as written and prints the render |
| G7 | a checkout whose untracked `AGENTS.md` / `CLAUDE.md` hold an older block | `self fold` from that checkout | `refreshBlocks` rewrites both to the new template; no checked-in file changes — this repository tracks neither file — **amended in implementation** |
| G8 | `snapshotLimitLines` amended | `handoff.test.mjs` | its fixed text names the instructions section among the uncapped ones, asserted verbatim — **decided here (D-9)** |
| G9 | `superselfTools(run)` amended | `apps/dsh-plugin/test/tools.test.mjs` | five tool definitions; `superself_instructions` is registered, declares no parameters, is concurrency-safe, and maps onto the argv `["instruction", "render"]` |
| G10 | `instruction` in `COMMANDS` | `self help instruction` | resolves through `commandUsage`: the three usage lines, the detail, and `--kind` in the `required, and refused in one pass when missing:` list. No `guide.ts` topic is added for `instruction` — parity with #391's `skill` |
| G11 | `instruction` in `COMMANDS` | `self alias add instruction --label x`, and the plugin claim guard | both refuse — `registerReservedVerbs(COMMANDS.map(name))` reserves the verb with no `aliases.ts` edit, and `self app install` refuses a plugin claiming it |
| G12 | the new `instruction.ts` | `node test/structure.mjs` | passes at `maxFunctionLines = 30` with `printingModules = []` and `sanctionedEdges = []`: every function is inside 30 lines, the module puts nothing on stdout outside `src/output.ts`, and it introduces no subsystem edge |
| G13 | one instruction recorded | `self fold` | `FOLD_VERSION` is still 1 and the state directory gains no `instruction/` folder |
| G14 | the built contract | `self --help` and `self instruction --help` | both carry exactly `instruction`, `instruction add`, `instruction list` and `instruction render`; no `--format`, no `--type instruction`, no fourth verb |
| G15 | one `renderedIn` in `model.ts` | `structure.test.mjs` | `skill.ts` and `instructions.ts` declare no local `renderedIn` and `instructions.ts` no `instructionsRenderedIn`; `skill.ts`, `instruction.ts` and `views.ts` import the shared one from `./model.js` — asserted on the source text, the way that file asserts every other module fact — **added in review round 1** |
| G16 | ARCHITECTURE.md's layer table | `docs.test.mjs` test `G16: the layer table names #440's, #391's and #379's six modules` | the table names a layer for `instruction.ts`, `instructions.ts`, `skill.ts`, `skills.ts`, `runbook.ts` and `runbooks.ts` — scoped to those six; the four other unnamed modules predate this change — **added in review round 1** |

## What this table does not cover

- **Account (`user`) scope.** There is no account-level record store, and a
  git-backed store has no account identity at all. `--workspace` covers the
  single-person case. Follow-up #441.
- **Audience (`main` / `worker` / `reviewer`).** Nothing in the CLI produces or
  consumes a session role: `self handoff` takes no audience, the dsh plugin has
  no session kind, and session ids are deliberately opaque. Labels are free and
  repeatable, so `--label worker` costs nothing the day a consumer exists.
- **Removing the managed block from `AGENTS.md` / `CLAUDE.md`.** Byte-for-byte
  removal is impossible because the insertion path normalises trailing
  newlines. Follow-up #442.
- **A `SessionStart` hook.** The CLI writes one template into `.claude/`,
  `.codex/` and `.gemini/` and has no harness-specific settings machinery; a
  hook would be the first such coupling. This issue ships none, so no cell
  drives one.
- **Any editing UI**, and any verb that rewrites an instruction in place. A
  record's text is immutable once confirmed; a correction is `--supersedes`.
- **A `--type instruction` search filter.** `KINDS` in `search.ts` is the list
  of record kinds, and a label-composed record answers as `entity`. D4 pins the
  refusal rather than the feature.
- **A `--format` flag.** `render` has `--json` and nothing else; the human
  render and the payload are the two shapes, as `PayloadBlock` defines them.
- **Splicing `render` into `context`.** C24 pins its absence. `fitKeeps` never
  cuts `head` and measures the whole string, so an uncuttable block inside
  `context` would zero every other section.
- **A cap exemption.** No tier gains one. An instruction charges `fullTokens`
  or `indexTokens` like every other record, and raising the cap in
  `config.json` is the remedy, as it is for every other kind.
- **A warning threshold on the token total.** The full cap defaults to 1,000,
  so any fixed number above it could never fire; B7–B9 pin the share instead.
- **Blocking the raw-verb bypass.** `self state add --label instruction` can
  mint a malformed instruction. Accepted, in the words #391's table used: a raw
  verb can always bypass the verb above it. C17, C18 and C19 pin what the
  render does with what it mints.
- **A hosted runtime appending the render to a system prompt.** Out of scope in
  the issue; the CLI only prints it.
- **A store that already used the label.** `instruction` is a free label, so a
  store that recorded `self state add "<text>" --label instruction --exposure
  full` before this release holds records this verb now reads as instructions.
  On upgrade they leave `self context` — the render's exclusion predicate is
  about the label, and the label is the mechanism — and appear in `instruction
  render` under `## Unclassified`, where a raw add's record belongs. They are
  still found by default `self search` and still charge the same tier. Accepted
  rather than migrated: a rule that looked at *when* a record was written would
  be a second definition of what an instruction is. **D15** pins the behaviour
  and the pull request states it.
- **A workspace-scoped instruction in an archived project.** It leaves every
  other project's render, because `workspaceModels` walks `activeProjects` and
  an archived project is out of every workspace-wide answer until it is
  restored (#283). That is the existing rule for every scoped record, not a
  decision this issue makes; **C26** pins it so a change to it is visible.
- **Where a full tier at its cap leaves the add.** An instruction is recorded
  at full exposure, so an add into a tier already at `fullTokens` is refused —
  by the same gate as every other full record, and with the same remedies:
  `--demote <id>` on the add, or freeing room first. The `instruction add`
  detail block says so; **A23** and **A25** pin the two refusals, and no cell is
  added for the sentence.
- **Which stream a workspace-wide notice went to.** The harness merges stdout
  and stderr, so **B15** and **C15** prove the sentence was printed and the
  answer still stood, never that it was on stderr. The stream is `model.ts`'s
  `console.error`, and a test that could see the difference would have to spawn
  the CLI rather than run it in process.
- **The whole diff of the golden fixture.** **G3** reads the committed fixture
  and proves no `instruction` line reached it outside the root usage listing.
  That is a proxy for "the only change is the root usage listing": the fixture
  is regenerated and committed, so a byte that moved somewhere the word does not
  appear is caught by the golden comparison beside it, not by G3.
