# Architecture

The standing structure rules for this repository, with `apps/cli/src` as the
worked example. Read this before adding a module, a directory, an event type,
or a second way to do something that already has one.

Every rule below states its enforcement point: the place a violation is caught,
or the review that has to catch it. Claims about the current tree were checked
against the import graph on `main`; where the tree does not yet satisfy a rule,
the gap is listed under [Known debt](#known-debt) rather than softened here.

The CLI has three roles, settled by decision `01kz2nczhtde554qx5tqpqzrt3`: a
context store agents read, a work graph, and a machine-local process ledger.
Merge control belongs to GitHub PR review and CI, not to this tool. A change
that grows a fourth role is sent back regardless of how it tests.

## Layering

Dependencies point one way, downward. No module may import from a layer above
it. The layers, lowest first:

| Layer | Modules | Owns |
| --- | --- | --- |
| Types | `types.ts` | the event and context shapes, and the blocks a command answers with — `CommandOutput` and the `Pointer` brand a receipt's next command carries; imports nothing local |
| CLI surface | `args.ts`, `contract.ts`, `help.ts`, `guide.ts`, `human.ts` | how a command declares itself, reads its arguments, describes itself, explains itself, and confirms a human; `human.ts` and `guide.ts` import nothing local, `contract.ts` imports only `args.ts` and `types.ts` — a leaf declares what its handler answers with by naming a shape from the bottom layer, so nothing here reaches up into the render gate — and `help.ts` renders the contract rather than keeping a list of its own. `guide.ts` holds the concept pages `self help <topic>` prints — prose the contract cannot state, which is why it is data rather than a render |
| Machine | `machine.ts`, `repo.ts`, `gitutil.ts`, `ids.ts`, `style.ts`, `redact.ts`, `ledger.ts` | the host: filesystem pointers, git, hashing, ids, terminal styling, credential redaction, the process ledger |
| Storage | `paths.ts`, `logfile.ts` | where the store lives, how the log is read, and how the store's other state files are read (`readRegistry`, `readStoreConfig`, `readVerdicts`, `projectArchive`) |
| Domain | `completion.ts`, `objectives.ts`, `dates.ts`, `entities.ts` | per-domain state shapes and their reducers |
| Model | `model.ts` | the fold: log lines in, `ProjectModel` out |
| Render | `view.ts`, `views.ts`, `pretty.ts`, `output.ts`, `reachability.ts` | HTML and terminal rendering of a folded model; `output.ts` is the render gate — the one function that puts a command's blocks on stdout, and the `notice` a lower layer's message is printed through; the block shapes themselves are declared in `types.ts` |
| Fold | `fold.ts`, `connect.ts` | writing canonical markdown, views, and the managed agent block |
| Pipeline | `pipeline.ts`, `sanitize.ts` | appending events, then refolding and committing |
| Command support | `artifact.ts`, `retirement.ts` | what more than one command surface shares: artifact staging (`artifact.ts` also holds the `artifact` verb), and the disclosure-and-approval path every destructive verb takes (`retirement.ts`, read by `main.ts`, `goals.ts` and `state.ts`) |
| Commands | `main.ts`, `goals.ts`, `state.ts`, `derivation.ts`, `archive.ts`, `aliases.ts`, `search.ts`, `setup.ts`, `sync.ts` | argument parsing, refusals, dispatch; `aliases.ts` owns the alias table the preset verbs read their defaults from and the dispatch of table-resolved verbs; `derivation.ts` owns the one relation between projects — the `project from` leaf `main.ts` splices in, and the resolution both directions of `self project` read; `archive.ts` owns setting a project aside and picking it back up — the `project archive` and `project restore` leaves `main.ts` splices in, and the `--archived` listing |

The append path and the imports run the same way, from higher layers to lower
ones: a command calls `pipeline.ts`, which imports `fold.ts`, which imports
`model.ts` and `view.ts`. Nothing points back up — a renderer that imported
`pipeline.ts` would make rendering able to write state.

- A new module joins an existing layer or declares a new one here first.
- A domain module (`completion.ts`, `objectives.ts`, `dates.ts`,
  `entities.ts`) imports `types.ts`, lower layers, and its own peers only —
  never `model.ts`, so a reducer can never depend on the fold that calls it.
- `model.ts` imports domain modules, never commands.
- Enforcement: review. `tsc` catches a cycle only when it becomes a type error,
  so the import direction is a reading check on every pull request.

## Subsystems

No subsystem directories remain: the runner, supervisor, work-spec, evidence
and integration-train subsystems were removed with the governance layer. The
rule stands for whatever comes next:

- A new subsystem is a directory from its first file, with a `commands.ts`
  entry point the dispatcher (`main.ts`) imports — and nothing else from it.
- Core modules never import from a subsystem directory.
- Exports are narrowed to what importers actually use. A subsystem that exports
  its whole surface has no boundary.
- Enforcement: `pnpm structure`, run in the CI verify job and locally
  (`apps/cli/test/structure.mjs`). It reads the whole `src/` tree, so a core
  module importing a subsystem, or a subsystem importing another outside a
  sanctioned edge, fails the build with the file, line and rule. The sanctioned
  edge list is empty: every edge this document once granted named code that
  decision `01kz2nczhtde554qx5tqpqzrt3` deleted. There are no subsystem
  directories today, so the section passes vacuously — its first subject is
  whatever directory appears next, caught at its first wrong import.
- The same check counts exports no importer reads, and fails a pull request
  that raises that count above its merge base. A test is an importer, and it
  reaches this package through `dist/`, which the check resolves back to
  `src/`. The count is 0 and stays there.

## Single gates

Each rule below has exactly one implementation. Adding a second path around one
of them is a review finding, not a refactor note.

| Gate | Module | Rule |
| --- | --- | --- |
| Event append | `pipeline.ts` `recordEvent` / `recordEvents` | the only writer of `log.jsonl`; every event verb goes through it. Each event names the project whose log it belongs to, and the append is grouped by that name — one write per log — so a placement that moves a record between projects still cannot leave half a state change in either (#181). It is also the one answer to "may this project be written into": an archived project is refused here rather than on each verb, so a verb added later cannot miss the rule (#283) |
| Event sanitization | `sanitize.ts` `assertSanitized` | called once, from `recordEvents`, before any byte reaches the log |
| Completion refusal | `completion.ts` `completionRefusal` | the one answer to "may this unit be done"; `work done` and the model both read it |
| Process ledger | `ledger.ts` `recordProcess` / `judgeProcess`, `recordSession` / `judgeSession` | the one writer and the one reader of the machine-local pid ledger, for a work unit's process and for the agent session that claimed it; a pid never reaches a synced event, and the sentence a reader is given about liveness is minted here too (`claimNote`) rather than re-derived per surface |
| Argument parse | `args.ts` `parseCommand` / `subcommand` | the guard a command declares its options and its positional count to, so an unknown flag *and* a stray argument are named instead of dropped (#28). The declaration lives once, in the command's `contract.ts` leaf, and the dispatcher hands it over. Every command surface goes through it — `node:util` `parseArgs` is called from `parseCommand` and nowhere else |
| Retirement approval | `retirement.ts` `requireHumanRetirement`, called from `recordRetirement` | the one answer to "may this call destroy a record": every verb that supersedes, withdraws or retires a confirmed record routes through it, and it discloses the target and reads a typed confirmation from a terminal before anything is written (#173). A call that displaces nothing passes straight through, so the trigger is what a call destroys rather than which flag was typed |
| Render | `output.ts` `renderOutput`, called from `main.ts` `runLeaf` | the one place a command's answer reaches stdout. A handler returns `CommandOutput` — blocks of the four shapes a command can answer with — and prints nothing itself; the gate resolves the render mode once for the whole answer and puts it out through `console.log`. A block that reads two ways carries both renders as thunks — `plain` and an optional `pretty` on a document, `rows` and an optional `pretty` on a listing — and the gate calls exactly one, so no handler asks which run it is in and the terminal render is never composed under a pipe. Omitting `pretty` states that the page reads the same either way. A lower layer with something to say while a command is still running prints through `notice` in the same module, which decides nothing: whether an append announces itself stays in `pipeline.ts`, the caller that knows what the run is for. The two answers with no command behind them — `--version` and the usage pages, composed before anything resolves — call the gate straight from `main`, which is why it requires neither a leaf nor a workspace. The migration finished in five stages and `printingModules` in `test/structure.mjs`, the ratchet that only ever shrank, is empty: a `console.log` or `process.stdout.write` anywhere in `src/` but this module fails `pnpm structure` by file, line and rule. The one exception is declared in that rule rather than listed beside it — `human.ts` writes the confirmation question without a newline and reads the typed reply on the same line, which is an interaction with a person and not a command's answer |
| Required options | `args.ts` `requireOptions`, called from `parseCommand` | the one answer to "may this verb run with what it was given": every missing required option is named in one refusal, with its hint and any unblocking verb. A handler that asked again would be a second implementation of the same rule (#106) |

What a verb cannot run without is declared on its leaf, beside the options it
accepts, and `help.ts` renders that same declaration — so a page cannot mark a
flag optional that the gate refuses a call for. Requirements that depend on
another flag's value or on folded state are not declarable, and stay in the
handler that can judge them.

- Adding a caller of a gate is normal. Adding a *second implementation* of what
  a gate decides is the violation — including a local re-check that duplicates
  the gate's condition and can drift from it.
- A new gate is added to this table in the same pull request that introduces it.
- Enforcement: review, guided by this table. `test/sanitize.test.mjs`
  covers the sanitization gate specifically.

## Event namespaces

An event type is `<namespace>.<verb>`. Each namespace has one owner. New events
extend an owned namespace; they never mint a sibling namespace for the same
concern.

| Namespace | Owner | Emitted from |
| --- | --- | --- |
| `entity.*` | the shared entity record (#197); `entities.ts` owns the fold | `state.ts`, `main.ts`, `goals.ts` — every preset verb writes this grammar since the cutover (#207) |
| `project.archived`, `project.restored` | the project's own two-state lifecycle (#283); `paths.ts` owns the fold, beside the store's other per-project state, because the scope resolver and the model enumeration both read it | `archive.ts` |
| `work.run-started`, `work.run-exited` | the process transitions | `main.ts` |
| `report.*` | work reports | `main.ts` |
| `goal.*`, `decision.*`, `convention.*`, `objective.*`, `milestone.*`, the rest of `work.*` | the pre-cutover record kinds — read forever (#197 §8), written by no verb | nothing |

`project.*` is a namespace about a project rather than about a record, which
is why it is its own and not an extension of `entity.*`. `derivation.ts`
records the one *relation* between projects as an entity, correctly: that is a
record a person asserts. Archiving is not — it is a transition of the project
itself, with no text, no placement and no lifecycle of its own, so it is a
declared non-statement namespace like the process transitions below. Being a
transition and not a statement is also why `self undo` does not reach it:
`undo` resolves its project from the working directory, while both verbs here
name a slug so a workspace is tidied from anywhere — including when the
project's checkout is on another machine, which is the ordinary case for a
project being set aside. `project restore` is the only way out of the archive,
and the optional `--why` on it is what a withdrawal would have said.

The process transitions are `work.run-started` and `work.run-exited`. They
carry the work id and, on exit, the code — never the pid: a pid is
machine-local, the sanitization gate refuses it by design, and `ledger.ts`
keeps it beside the events on the machine that can judge it.

Retired namespaces — `run.*`, `spec.*`, `changeset.*`, `attempt.*`, `lease.*`,
`merge.*`, `promotion.*`, `repo.*`, `target.*`, `main.*`, `ci.*`, `review.*` —
still appear in old logs. The CLI emits none of them; the fold reads the few
that still inform surviving state (`run.*` into attempt history,
`review.received` onto the unit it named) and folds the rest to nothing. An
old workspace must keep folding — `test/process.test.mjs` proves a log holding
retired-namespace events still folds.

- Enforcement: `model.ts` and the per-domain reducers dispatch on the type
  string, so an unowned namespace folds into nothing. Review catches it earlier.

### The record lifecycle

A *statement-type record* is one a person asserts and can later take back: a
decision, a convention, an objective, a milestone, a work unit. Reports are
the exception by design — they are append-only history, and nothing withdraws
a report.

Every statement type ships the same three transitions, inside its own
namespace, before it is admitted (#166):

| Transition | What it means | Where it renders |
| --- | --- | --- |
| supersede | replaced by a linked successor; `--supersedes <id>` on the type's own add verb | predecessor folds to `superseded`, lineage kept |
| withdraw | taken back with `--why` and no successor | folds to `retracted`/`dropped`; leaves every current render |
| decline | a proposal turned down with `--why`, beside `accept` and expiry | folds to `declined`; leaves "waiting on you" at once |

The verbs keep each type's existing vocabulary — `decide retract`, `convention
drop`, `work retire` — but no type may be missing a transition. A withdrawn
record is never deleted or rewritten: it keeps its text and its refs, so
`--after` and `--blocks` pointing at it still resolve, and naming it —
`self state show <id>`, `self state show <id> --history`, `self work show <id>
--history` — still answers with its text, its status and its own events. What
it leaves is the answer to "what is true now": `self search` reads live records
(#212), so a withdrawn record is not in that answer and no flag reaches it.

Correcting a record is spelled the same way for every type: `--supersedes <id>`
on that type's own add verb, which restates the text and carries the lineage.
The older spellings a type shipped before the unification keep working — `work
retire --successor <work-id>` and `state add --link supersedes:<id>` are the
same transitions under other names — but a new type ships the shared flag, and
a `--supersedes` target belonging to another type is refused by naming that
type's add verb, from the one table in `entities.ts`.

`--why` is required on every transition. A supersession is excused from it only
where the successor's text is the reason — a decision replaced by a decision, a
convention by a convention — because reading the new record answers why the old
one stopped holding. A record of doing is not excused: a work unit's new outcome
states what will be done next and never why the previous outcome stopped being
reachable, which is the fact worth keeping. So `work add --supersedes` asks for
`--why`, the same as the `work retire --successor` it records, and a record kind
added later is excused only if its own text carries the reason. Withdrawals are
never excused: `decide retract`, `decide decline`, `convention drop`, `objective
decline`, `objective close --as dropped`, `milestone drop`, `work retire` and
`work decline` all require it.

A withdrawal is terminal against every event written in ignorance of it. Once
a record is retracted, declined or dropped, a later event naming it does not
move it back: the fold refuses the transition rather than trusting log order,
because a log merged from another clone can carry a revision written before
the withdrawal was pulled.

Only an event naming that withdrawal *by id* reverses it, which is what `undo`
records — `entity.restored` carrying `refs.annuls`. That case is exactly the
one the rule above is not written against: an undo cannot have been composed
without seeing the event it takes back. The fold collects the annulled ids
before it reads anything else and skips those events, so every rule keeps its
shape — first-withdrawal-wins still holds among the withdrawals that stand —
and binding to an id rather than to log order is what keeps a merged log
folding to one answer. An annulled supersession gives back what it displaced
and leaves its successor standing, without the link.

Lifecycle refs also survive log order. A union merge orders lines by neither
time nor dependency, so a retraction can sit above the decision it withdraws;
`model.ts` `reconcileLifecycle` settles the linking transitions in a second
pass over the same events. Only transitions that are no-ops against a record
already in its terminal state run there — a revision, which accumulates, does
not.

- A new statement type is admitted only with the full set. A type that ships
  `--supersedes` and no withdrawal leaves records that can only be replaced,
  never taken back, which is the state #166 was opened over.
- The statement types are declared once in code, as `STATEMENT_TYPES` in
  `model.ts`. It is load-bearing rather than documentation: the per-record
  history `views.ts` renders reads a record's settled status from it, so a type
  missing an entry stops saying which of its records still hold.
- Enforcement: `test/lifecycle.test.mjs` reads `STATEMENT_TYPES` out of the
  built module, fails when an entry's verbs are missing from its command's
  help, and exercises withdrawal actually leaving the current renders. Review
  holds the rest: a namespace that creates records must carry an entry or be a
  declared non-statement namespace.

## Fixed naming

Standing rules, not per-issue reminders:

- `AttemptSummary` (`model.ts`) is the folded shape of what an old `run.*`
  history left on a work unit. It is read-only history now; extend it only if
  a surviving surface needs more of that history, and never declare a parallel
  summary type.
- One process ledger. `ledger.ts` owns the machine-local pid files — their
  paths, their appends, their liveness judgments. Code that wants to say
  whether a unit's process is alive calls `judgeProcess`, and whether the
  session holding a unit is still running calls `judgeSession`; neither reads
  a file itself.
- One session identity, and it names nobody. `origin.session` is stamped on
  every event by `pipeline.ts` from `machine.ts` `sessionToken`, and it is an
  opaque token: a hostname, a machine label or a user name there would name
  the person holding the clone in an append-only log, which is what the
  sanitization gate refuses absolute home paths for. Decision
  `01kz8c83me299m37gk8rjjydw0` settles it. A session's pid is machine-local
  and stays in the ledger.
- A claim is a disclosure, never a lock. The session that picked a work unit
  up is derived from the newest `entity.started` (#230) — no verb asserts it
  and no event type is minted for it — and every surface that renders it
  states who holds the unit without refusing anyone else. Adding a refusal
  there would be the write coordination decision `01kz57aqsxym2g2g8wasp6vv7j`
  rules out, under another name.
- One artifact declaration shape: `{name, sha256, bytes}`. `name`, never
  `path`.
- One archived-project reader, and every aggregate goes through it. `paths.ts`
  `projectArchive` folds a project's `project.*` events into its archived state,
  and `activeProjects` is what the scope resolver, the model enumeration
  (`workspaceModels`, `readableModels`), the rendered workspace, search and the
  artifact listing all answer from (#283). Two families read the workspace —
  scopes and models — and a second reader of the same events is what would let
  one of them keep a project the other dropped.
- One scope contract, and one resolver behind it. A read verb answers for the
  project the directory resolves to, takes `--project <slug>` to answer for
  another registered project, and — where a workspace-wide form makes sense —
  `--workspace` to answer for every registered project. `paths.ts` `readScope`
  and `readScopes` are the one place a slug becomes a context, so a verb never
  grows a second answer to "which project is this"; both refuse an unknown slug,
  an empty workspace, and `--project` with `--workspace` in one call. A named
  project resolves out of the workspace store alone and is never folded,
  refolded, or appended to by the read, and the current checkout never travels
  to a project it does not belong to. A write verb has no scope flag: it records
  into the project it runs in, and `--project` on one is an option that command
  never declared, so the argument-parse gate names it instead of dropping it.
- A confirm finds its project in the record it names (#302). `self work accept`,
  `self work decline`, `self decide confirm` and `self state confirm` are the
  calls to action a `--project` context render prints, and every one of them is
  read somewhere other than the project it is about. They confirm a record that
  already exists and already has an owner, so the project was never theirs to
  ask for: `model.ts` `projectsHolding` names the projects that hold the id and
  `paths.ts` `projectScope` turns the one answer into the context. None of the
  four reads the checkout, so the line resolves even when that project's
  checkout is on another machine. This is a third answer to "which project is
  this" beside the directory and `--project`, and it is the last: it exists
  because the argument already carried the answer, not because a caller wanted
  to choose one. It buys no scope flag — `--project` on these four is still the
  option they never declared. The directory's own project answers first and ends
  the search, so a call made from the right checkout costs the one fold it
  always did, and a call made from nowhere in particular is refused by naming
  every project searched, or by naming the several that answered to one prefix.
- One placement scope, and it is a render target rather than a storage location
  (#181). `--scope` on `state add`, `state place` and the alias adds names which
  project renders a record: omitted is the project the directory resolves to, a
  registered slug is that project, `workspace` is all of them. The retired
  `project` keyword is refused by name, never read as the omission. A record's
  events stay in the log that already holds them however often its scope moves,
  so `entities.ts` `scopeTarget` and `rendersIn` are the one place a stored
  scope becomes an answer about a project, and the caps count per render target
  across every store. This is not the read scope above and never merges with it:
  `--project` asks which project a read answers for, `--scope` states where a
  record belongs.
- An entity write appends to the log that owns the entity (#181). A record
  scoped into this project resolves here — `state place`, `state show`,
  `work start`, `report`, `work done` and `work block` all answer for it — and
  the event they compose names the owning project, so the append gate lands it
  at home. An *add* is unchanged: a new record is born in the project the
  directory resolves to.
- A recovery pointer a render prints is a type, not a string. Every rendered
  surface that says "run this for the rest" names the project it is about, or
  a reader pastes it somewhere else and is answered about their own checkout.
  `Pointer` is branded in `types.ts`, where the block shapes that carry one are
  declared, and minted only by `pretty.ts` — `scoped()`, `pointerTo()` and
  `workspacePointer()` — so a bare literal handed to a section builder or to a
  receipt's `next` fails typecheck. Moving the declaration down a layer gave no
  module a constructor: what makes a mint safe is the finite command list it
  takes. A pointer written into prose is still a string — review holds those.
- Piped output is a contract. `self context`, `self work` and `self status`
  render for a person only when stdout is a terminal; a pipe, a redirect,
  `--plain`, `TERM=dumb`, and a terminal too narrow for a table all get the
  same bytes an agent has always read. `pretty.ts` `resolveRender` is the one
  place that answers which render a run gets, and `style.ts` `displayWidth` is
  the one place that measures a string in terminal cells — a surface that lays
  text out reads its width from there rather than from `String.length`.

## Known debt

Recorded here so the rules above can be stated without exceptions written into
them. Do not use any of these as precedent.

- `main.ts` still holds command bodies (init, workspace, lang, project, view,
  sync, clone, context, status, theme, timezone) instead of dispatching to
  modules like the newer surfaces do.
- `requireText` is duplicated in `main.ts` and `goals.ts` instead of exported
  once from `args.ts`.
- `view.ts` / `views.ts` do not state their roles from their names.

## Related documents

- [CONTRIBUTING.md](CONTRIBUTING.md) — the conventions an implementation is
  judged by.
- [docs/strategy/problem-definition.md](docs/strategy/problem-definition.md) —
  the state architecture the CLI implements.
