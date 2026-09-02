# Architecture

The standing structure rules for this repository, with `apps/cli/src` as the
worked example. The fold itself is no longer in it: the calculation that reads
an event log into project state is the `@superself/fold` package
(`apps/fold/src`), which the CLI imports and a Workspace API server imports
too, so both answer from one calculation. Its own layering is stated in
[The fold package](#the-fold-package) below. Read this before adding a module, a directory, an event type,
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
| Types | `types.ts` | the blocks a command answers with — `CommandOutput` and the `Pointer` brand a receipt's next command carries — and the CLI's own refusal, `CliError`. The record shapes themselves (`SelfEvent`, `EventRefs`, `ArtifactMeta`) are declared in `@superself/fold` and re-exported here, so every CLI module still asks one place what a record looks like; imports nothing local |
| Store mode | `mode.ts` | which of the two kinds of store a directory holds. A store keeps its records in a git repository this machine commits, or on a workspace server this machine is logged in to, and `.superself/workspace.json` says which — present means server-backed. Existence is the whole test: a git-backed store has never written that file, so no store that predates the second mode can be read as server-backed by accident. It also holds the refusal a git-only verb raises where the store is the other kind. Imports `types.ts` only, and sits this low because every layer above branches on it — the git wrapper, the append path, the log reader and the path resolver alike; a module that asked `paths.ts` instead would be this tree's first import cycle, since `paths.ts` asks `gitutil.ts` |
| CLI surface | `args.ts`, `contract.ts`, `help.ts`, `guide.ts`, `human.ts` | how a command declares itself, reads its arguments, describes itself, explains itself, and confirms a human; `human.ts` and `guide.ts` import nothing local, `contract.ts` imports only `args.ts` and `types.ts` — a leaf declares what its handler answers with by naming a shape from the bottom layer, so nothing here reaches up into the render gate — and `help.ts` renders the contract rather than keeping a list of its own. `guide.ts` holds the concept pages `self help <topic>` prints — prose the contract cannot state, which is why it is data rather than a render |
| Machine | `machine.ts`, `repo.ts`, `gitutil.ts`, `ids.ts`, `style.ts`, `redact.ts`, `ledger.ts` | the host: filesystem pointers, git, hashing, ids, terminal styling, credential redaction, the process ledger |
| Foundation | `rootkeys.ts` | the pinned **root** public keys — the whole trust anchor, data only, imports nothing. It holds no plugin signing key: which keys may sign a release is a document the rail serves, so a leaked signing key is withdrawn by publishing a new document rather than by shipping a new CLI |
| Credential | `credentials.ts` | the credential file: read, atomic write, mode enforcement, the per-profile lock and pending marker, profile selection, and the default rail a profile points at. Imports `types.ts` only |
| Rail | `rail.ts` | HTTP: TLS policy, the bearer header, refresh under the lock, retry classification, timeouts, error normalization, the response cap, the call key and the call journal. Imports `credentials.ts` and `types.ts` |
| Trust | `trust.ts` | the plugin trust document: one unauthenticated fetch, root-signature verification, expiry and monotonicity, and the `0600` cache beside the credential file. Imports `rail.ts`, `credentials.ts`, `rootkeys.ts` and `types.ts` |
| Storage | `paths.ts`, `logfile.ts`, `pending.ts`, `registry.ts` | where the store lives, how the log is read, and how the store's other state files are read (`readRegistry`, `readStoreConfig`, `readVerdicts`, `projectArchive`); `registry.ts` is the derived artifact registry — what the log says the store holds — and it sits here rather than in `artifact.ts` because the fold's reachability check has to look an artifact id up while `artifact.ts` reaches the pipeline to record `artifact add`, and the two meeting would be this tree's first import cycle. `pending.ts` is the queue of appends a server-backed store has written and the server has not taken — `projects/<slug>/pending.jsonl`, append-only in all three of its row shapes, so a mark saying an append was sent or refused is a line added rather than a rewrite, and a meaning added later is a new field on one of those three shapes rather than a fourth shape an older reader would silently ignore. The `sent` mark follows the pull and never the push: it takes an append out of every read, so it may not be written until `log.jsonl` holds every one of that append's event ids. `logfile.ts` `readEvents` is where the two files become one log |
| Sync | `synclock.ts`, `transport.ts`, `registrycache.ts`, `pusher.ts`, `puller.ts`, `pushermain.ts` | sending a server-backed store's queue and receiving the workspace's copy. `transport.ts` addresses and authenticates a request and reports a status, some headers and a body — and one further answer, `reached: false`, for a refused connection, an unresolvable name, a socket cut mid-body and a request that ran out of time alike, because all four leave the same question open. `pusher.ts` and `puller.ts` hold the two response tables, written out row by row and first match wins, and they are the review surface for what a status means: nothing else in the tree branches on one. `synclock.ts` is the single-flight lock — synchronous, chmod-free, never waited for — and the one rewrite it guards, which carries onto its replacement whatever the foreground appended while it was deciding. `registrycache.ts` caches the workspace's own project list and each project's server id, which is the one thing that tells a project this machine has never registered from one another machine deleted. This layer sits above Credential and below Pipeline and is the **only** part of the tree that reaches both a token and a store's files: the state writers may hold no import path to a credential, and this holds one, so it asks `pending.ts` and `logfile.ts` to write and they know nothing of it |
| Domain | `dates.ts` | what is left of the CLI's own domain layer: the two refusals a typed date argument is judged by. The per-domain state shapes and their reducers — `completion.ts`, `objectives.ts`, `entities.ts`, and the calendar arithmetic — are `@superself/fold` |
| Model | `model.ts` | the CLI's end of the fold: the one place a store directory becomes the arguments `@superself/fold` takes — the log, the registry's description, the workspace zone, the session, the verdicts — and the store walks (`workspaceModels`, `projectsHolding`, `readableModels`) that fold a project at a time. The calculation is the package's; this module is what a machine hands it. `foldedOthers` is where a workspace-wide answer folds the projects it is not about: one of them whose state will not read is left out and named on stderr rather than taking the whole answer down, while the project a command *is* about is folded by its caller and refuses loudly — `views.ts` folds the workspace in a second shape and asks the same function, so the rule is written once |
| Render | `view.ts`, `views.ts`, `pretty.ts`, `output.ts`, `reachability.ts` | HTML and terminal rendering of a folded model; `output.ts` is the render gate — the one function that puts a command's blocks on stdout, and the `notice` a lower layer's message is printed through; the block shapes themselves are declared in `types.ts` |
| Fold | `fold.ts`, `connect.ts` | writing canonical markdown, views, and the managed agent block |
| Pipeline | `pipeline.ts`, `sanitize.ts` | appending events, then refolding and committing. Which file an append lands in is what the store's mode decides: the store's own `log.jsonl` where it is git-backed, the queue where it is server-backed and `log.jsonl` beside it is the server's copy to write |
| Command support | `artifact.ts`, `retirement.ts` | what more than one command surface shares: artifact staging (`artifact.ts` also holds the `artifact` verb), and the disclosure-and-approval path every destructive verb takes (`retirement.ts`, read by `main.ts`, `goals.ts` and `state.ts`) |
| Commands | `main.ts`, `goals.ts`, `state.ts`, `derivation.ts`, `archive.ts`, `aliases.ts`, `apply.ts`, `search.ts`, `setup.ts`, `store.ts`, `sync.ts`, `plugins.ts`, `login.ts`, `app.ts` | argument parsing, refusals, dispatch; `aliases.ts` owns the alias table the preset verbs read their defaults from and the dispatch of table-resolved verbs; `apply.ts` owns `self apply` — the one human action that covers a reviewed set of gated calls (#312), which takes the root command list as a thunk from `main.ts` rather than importing the list it is composed into; `derivation.ts` owns the one relation between projects — the `project from` leaf `main.ts` splices in, and the resolution both directions of `self project` read; `archive.ts` owns setting a project aside and picking it back up — the `project archive` and `project restore` leaves `main.ts` splices in, and the `--archived` listing; `store.ts` owns `self store` — how large the store is and the one act that packs it down, which reads the artifact registry through `registry.ts` and never writes |

The append path and the imports run the same way, from higher layers to lower
ones: a command calls `pipeline.ts`, which imports `fold.ts`, which imports
`model.ts` and `view.ts`. Nothing points back up — a renderer that imported
`pipeline.ts` would make rendering able to write state.

- A new module joins an existing layer or declares a new one here first.
- A domain module imports `types.ts`, lower layers, and its own peers only —
  never `model.ts`, so a reducer can never depend on the fold that calls it.
  The rule is now enforced by the package boundary for every reducer that moved
  into `@superself/fold`: a reducer there cannot reach the CLI at all.
- `model.ts` imports `@superself/fold` and the storage layer, never commands.
- Nothing in `@superself/fold` imports the CLI, and nothing in it reads a
  machine. See [The fold package](#the-fold-package).
- **Nothing in the ledger, pipeline or fold layers may import `credentials.ts`,
  `rail.ts` or `trust.ts`.** This is the structural reason a token cannot reach
  the event log: there is no import path from a credential to anything that
  appends, folds, or syncs a record — so the guarantee does not rest on
  `sanitize.ts` catching one. `trust.ts` joins the rule because its cache is a
  `0600` file in the credential directory and it reaches the network, so the
  same argument applies to it unchanged. `pnpm structure` asserts it rather than
  leaving it to review.
- Enforcement: review. `tsc` catches a cycle only when it becomes a type error,
  so the import direction is a reading check on every pull request.

## The fold package

`@superself/fold` (`apps/fold`) is the calculation that reads an event log into
project state. It exists because two programs have to answer the same question
about the same log — this CLI on a person's machine, and the Workspace API
server on the other side of a network — and a second copy of the fold is a
second answer.

Two layers, and the seam between them is the point of the package:

| Layer | Modules | Owns |
| --- | --- | --- |
| Types | `types.ts`, `errors.ts`, `version.ts`, `text.ts`, `revisions.ts`, `dates.ts` | the record vocabulary every consumer reads a log through, the refusal the package raises, `FOLD_VERSION`, and the counting and shape tests the fold and its readers must not disagree about; each imports nothing but its peers |
| Domain | `objectives.ts`, `entities.ts`, `completion.ts` | per-domain state shapes and their reducers |
| Log-determined | `model.ts` | `foldEvents(events, project)` — the project state an event log alone decides, and nothing else |
| Machine-local overlay | `overlay.ts` | `applyLocalOverlay(model, events, local)` — what one machine adds: the instant it is read at, the session holding the workspace, the verdicts it reached about the evidence by asking its own git, and the workspace time zone |

The rules the package holds itself to, and why each one matters to a reader
that is not this CLI:

- **Every machine-local input is an argument.** The clock, the session and the
  verdicts do not travel with the log, so a server folding the same events has
  none of them. They enter through `LocalOverlay` and nowhere else.
- **Nothing runs at module load, and no module reads a machine.** The CLI's
  `style.ts` decides how a terminal renders when it is imported — it reads
  `process.stdout.isTTY` at the top level — and a fold that imported it would
  have carried a terminal's opinion into a server. So the package touches no
  filesystem, no `process`, and no clock of its own.
- **The package raises `FoldError`, never `CliError`.** An exit code and a JSON
  envelope are facts about a command line. `runCli` turns a `FoldError` into a
  `CliError` at the one error boundary.
- **Nothing in the package imports the CLI.** There is no cycle to break
  because there is no edge back.
- Enforcement: `apps/fold/test/purity.test.mjs` asserts all four from the
  syntax tree, and `apps/fold/test/determinism.test.mjs` asserts that one event
  array folds to one state whatever the clock, the session and the verdicts say
  (design O1 §5, V6).

The CLI reads the package through `model.ts`, which is the one place a store
directory becomes the arguments the package takes. `style.ts` and `paths.ts`
re-export the pieces of the package their own callers already ask them for —
`plural`, `countCharacters` and `Verdict` — so there is one declaration of each
and one import line to change if the package moves.

### How the two are released

Two packages, one tag, one order (#430). `apps/cli` is published as `superself`
and `apps/fold` as `@superself/fold`, and the CLI depends on the fold by the
**exact version** released beside it — `"@superself/fold": "0.1.0"`, never a
range and never the workspace protocol, which `npm publish` uploads verbatim
into a tarball nobody can install.

The development loop is unchanged by that pin. `linkWorkspacePackages` in
`pnpm-workspace.yaml` is what keeps it unchanged: a dependency a workspace
package already satisfies is linked from `apps/` rather than fetched, so
`pnpm install` still puts `apps/fold` behind `@superself/fold` and an edit to
the fold is an edit the CLI's next `tsc` reads.

A `v*` tag push runs `.github/workflows/publish.yml`, which is three jobs in a
line:

| Job | What it is for |
| --- | --- |
| `gate` | every reason to refuse, collected before the first upload: the tag against the CLI's version, the CLI's pin against the fold version this run publishes, both against what the registry already holds, the tag's commit against `main` — and then the pair, packed and installed from a registry, in `scripts/pack-install-smoke.mjs` |
| `publish-fold` | `npm publish` in `apps/fold` |
| `publish-cli` | `npm publish` in `apps/cli`, and only after the fold succeeded |

The order is the design rather than a convenience. A published version can
never be replaced, so a run that gets halfway has to leave the registry usable:
a fold version nothing depends on yet is inert, while a CLI whose dependency is
not on the registry is installable by nobody. The gate refuses ahead of both,
and the `needs:` edge is the second line of defence — `publish-order.test.mjs`
asserts it, because no test of either package can see a yaml file.

The rules live in `scripts/release-gate.mjs` as a function of facts rather than
in the workflow's shell, so `scripts/release-gate.test.mjs` can state a tag, two
manifests and a registry and read the refusal back. The workspace-protocol guard
is the one rule stated twice: in the gate, and again as the last step in front
of each `npm publish`, where the mistake would actually be made.

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
- The same check also runs the credential-isolation rule above: a state-writing
  module that imports `credentials.ts` or `rail.ts` fails the build with the
  file, line and rule.
- The same check counts exports no importer reads, and fails a pull request
  that raises that count above its merge base. A test is an importer, and it
  reaches this package through `dist/`, which the check resolves back to
  `src/`. The count is 0 and stays there.

## Single gates

Each rule below has exactly one implementation. Adding a second path around one
of them is a review finding, not a refactor note.

| Gate | Module | Rule |
| --- | --- | --- |
| Event append | `pipeline.ts` `recordEvent` / `recordEvents` / `recordCalls` | the only writer of a project's events — `log.jsonl` where the store is git-backed, `pending.jsonl` where it is server-backed and the log beside it is the server's copy; every event verb goes through it. Each event names the project whose log it belongs to, and the append is grouped by that name — one write per log — so a placement that moves a record between projects still cannot leave half a state change in either (#181). It is also the one answer to "may this project be written into": an archived project is refused here rather than on each verb, so a verb added later cannot miss the rule (#283). While a reviewed set is being collected for one confirmation it accepts nothing at all (#312) — the person has not been asked yet — so a line of a plan that records rather than destroys is refused here instead of writing state beside the calls the confirmation is about. `recordCalls` is the same writer over several verbs' calls at once: everything the whole set owes — sanitization, the archive refusal, the branch stamp — is checked before any of it is appended, because a reviewed set approved by one answer has to land as one write or not at all |
| Event read | `logfile.ts` `readEvents` | the one place a project's events are read, and — where the store is server-backed — the one place its two files become one log: the server's copy in the order the server put it in, then this machine's unsent tail, with an append the server has taken or refused for good left out and an event id held twice counted once. The join sits here rather than in each reader so that a surface added later cannot answer from half the log by not knowing the other half exists. A line that will not parse refuses in either file, naming the file and the line and the repair — between them the two files are the whole log, so a reader that stepped over a damaged line would answer as though records it holds were never written |
| Workspace sending | `pusher.ts` `sendQueued` | the one place a server-backed store's queue leaves this machine, and the one table that says what each answer means. Reached from `runCli` after the command and outside its `try`, so a verb that recorded three events and then failed rendering them still has three events to send. It writes no output at all: the process it starts outlives the command and has no terminal in front of it, so every refusal it meets is written into the queue as a row and said by the next command that has somewhere to print |
| Workspace receiving | `puller.ts` `catchUp` | the one place the workspace's copy of a log reaches this machine, run from `main` before every verb so a read answers from the log the workspace agreed on rather than from what this machine last saw. It can refuse nothing — every row of its table ends in the command running against what this machine holds — and everything it says goes to stderr, because it speaks before the run's flags are parsed and a line on stdout ahead of a `--json` envelope is a parse error rather than a notice |
| Event sanitization | `sanitize.ts` `assertSanitized` | called once, from the event append above, before any byte reaches the log |
| Completion refusal | `@superself/fold` `completion.ts` `completionRefusal` | the one answer to "may this unit be done"; `work done` and the model both read it |
| Design citation | `design.ts` `judge`, reached through `requireCitations` and `dispatchRefusal` | the one answer to "does this design still stand on a decision that holds" (#316). `self report --design` reads it at submission, so a design citing a superseded, retracted or unreachable decision is never recorded; `self work start` reads it again at dispatch, because a decision can be superseded between the two and the approval said nothing about that. The override is the record, not a flag: supersede the decision, then cite the successor |
| Process ledger | `ledger.ts` `recordProcess` / `judgeProcess`, `recordSession` / `judgeSession` | the one writer and the one reader of the machine-local pid ledger, for a work unit's process and for the agent session that claimed it; a pid never reaches a synced event, and the sentence a reader is given about liveness is minted here too (`claimNote`) rather than re-derived per surface |
| Argument parse | `args.ts` `parseCommand` / `subcommand` | the guard a command declares its options and its positional count to, so an unknown flag *and* a stray argument are named instead of dropped (#28). The declaration lives once, in the command's `contract.ts` leaf, and the dispatcher hands it over. Every command surface goes through it — `node:util` `parseArgs` is called from `parseCommand` and nowhere else |
| Retirement disclosure | `retirement.ts` `discloseRetirement`, called from `recordRetirement` | the one answer to "what is this call about to destroy": every verb that supersedes, withdraws or retires a confirmed record routes through it, and it states the target — the record's own words, its age, what still points at it, and the reason the call gives — before anything is written (#173). It read a typed confirmation from a terminal until #400; the justification for that was "a mistaken retirement cannot be taken back", and since `self undo` (#390) it can, so the prompt went and the disclosure stayed. What replaces the gate is attribution: the events it hands back carry `human.ts` `writtenBy`, so the record says whether a person or an agent session wrote it. A call that displaces nothing passes straight through, so the trigger is what a call destroys rather than which flag was typed. It reads a list of calls, not one (#312): `self apply` opens a collection, every destroying call inside it queues instead of writing where it stands, and one disclosure then covers the whole set. A supersession gives no `--why` because its successor's text is the reason, so the disclosure states that text. The leaves that can reach it are marked here too (`retiring`, read back by `retires`), because holding the event log shut does not stop a verb whose write goes somewhere else (`remote add`, `theme`, `app install`) — a plan resolves a line against the marked leaves and refuses anything else before it runs. The set is handed to `pipeline.ts` `recordCalls` as one write, so a call the sanitizer or the archive gate refuses stops the set whole rather than after the calls before it were already committed |
| Render | `output.ts` `renderOutput`, called from `main.ts` `runLeaf` | the one place a command's answer reaches stdout. A handler returns `CommandOutput` — blocks of the four shapes a command can answer with — and prints nothing itself; the gate resolves the render mode once for the whole answer and puts it out through `console.log`. A block that reads two ways carries both renders as thunks — `plain` and an optional `pretty` on a document, `rows` and an optional `pretty` on a listing — and the gate calls exactly one, so no handler asks which run it is in and the terminal render is never composed under a pipe. Omitting `pretty` states that the page reads the same either way. A lower layer with something to say while a command is still running prints through `notice` in the same module, which decides nothing: whether an append announces itself stays in `pipeline.ts`, the caller that knows what the run is for. The two answers with no command behind them — `--version` and the usage pages, composed before anything resolves — call the gate straight from `main`, which is why it requires neither a leaf nor a workspace. The migration finished in five stages and `printingModules` in `test/structure.mjs`, the ratchet that only ever shrank, is empty: a `console.log` or `process.stdout.write` anywhere in `src/` but this module fails `pnpm structure` by file, line and rule. The one exception is declared in that rule rather than listed beside it — `human.ts` writes the confirmation question without a newline and reads the typed reply on the same line, which is an interaction with a person and not a command's answer |
| Person present | `human.ts` `personAtTerminal`, and the attribution `writtenBy` mints from it | the one answer to "is there a person behind this process": an attempt marker the runner stamped, or a stdin that is not a terminal, means no. Since #400 that answer decides what a record *says* rather than whether there is one: `writtenBy` turns it into the `by` field every verb whose record `self undo` reverses stamps on its events, so a reader is told who wrote a record instead of being guaranteed it. One gate still refuses on it — `artifact prune`, the one act `undo.ts` names as taking nothing back, where bytes leave the working tree and no later event returns them. It reads stdin alone, so a person who pipes their own output is still a person; a verb that prints a challenge and reads it back needs stdout as well and asks for that itself |
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
| `entity.*` | the shared entity record (#197); `@superself/fold` `entities.ts` owns the fold | `state.ts`, `main.ts`, `goals.ts` — every preset verb writes this grammar since the cutover (#207) |
| `project.archived`, `project.restored` | the project's own two-state lifecycle (#283); `paths.ts` owns the fold, beside the store's other per-project state, because the scope resolver and the model enumeration both read it | `archive.ts` |
| `work.run-started`, `work.run-exited` | the process transitions | `main.ts` |
| `report.*` | work reports, and the ruling a person makes on one — `report.added`, `report.confirmed` (#316) | `main.ts` |
| `artifact.registered`, `artifact.pruned` | bytes stored with no report behind them (#238), and bytes removed under a person's confirmation (#239); `registry.ts` owns the fold, beside the registry the store's other artifact readings derive from | `artifact.ts` |
| `goal.*`, `decision.*`, `convention.*`, `objective.*`, `milestone.*`, the rest of `work.*` | the pre-cutover record kinds — read forever (#197 §8), written by no verb | nothing |

The criterion axis of `entity.*` is three types of its own (#408), because the
fold's answer is different rather than because the act is:

| Type | What it records | An older fold |
| --- | --- | --- |
| `entity.criterion-declared` | one completion condition a record is judged on, declared after its creation, with the `owner` that says whose task it is (#413) | ignored by an older fold — `reconcileEntity` matches no collector, so the record reads with its birth criteria alone |
| `entity.criterion-blocked` | what one declared criterion waits on, with its `--on` and reason | ignored by an older fold — the criterion reads open, and the record's own working state is untouched |
| `entity.criterion-unblocked` | the release of that wait | ignored by an older fold — the criterion was already reading open |

Reusing `entity.blocked` with a `criterion` field would have replaced every
"ignored" above with a wrong answer: `entity.blocked` and `entity.unblocked`
are in `EXECUTION_EVENTS`, so a 0.11.0 CLI would read a criterion's block as
the *record's* block, and a criterion's unblock as clearing a record-level
block a person had put there. An unknown `entity.*` type costs nothing by
comparison, and the loss it does cost is one-directional: the older CLI's done
gate is looser, never tighter.

A criterion's `owner` (#413) rides the events that declare it — the sparse
`{cN: "person"}` map on a creation payload, beside `verify`, and a bare string
on `entity.criterion-declared`. An older fold ignores both: a creation payload's
unknown key is never read, and the declaration event is already ignored whole.
Nothing is lost that gates anything, because ownership gates nothing — it moves
one render, and that is why it needed no type of its own.

`artifact.registered` is a namespace about stored bytes rather than about a
record, which is why it is its own and not an extension of `report.*`: a
report is a claim about a work unit and this is not one, which is exactly the
property that keeps a registration from satisfying the completion gate. It
carries no lifecycle either — an artifact is immutable once ingested, and
`artifact.pruned` is not a withdrawal of a statement: the record it names stays
exactly where it is and keeps rendering, marked, so that a `done` claim resting
on that evidence is still auditable after the file is gone (#239). What the
event removes is bytes, which is why it belongs to the namespace about stored
bytes rather than to the record lifecycle.

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

- Enforcement: the package's `model.ts` and its per-domain reducers dispatch on the type
  string, so an unowned namespace folds into nothing. Review catches it earlier.

### The record lifecycle

A *statement-type record* is one a person asserts and can later take back: a
decision, a convention, an objective, a milestone, a work unit. Reports are
the exception by design — they are append-only history, and nothing withdraws
a report.

A design approval (#316) is inside that exception rather than beside it. It is
a fact about bytes at a moment — a person read this exact artifact and said
yes — so it is never withdrawn; it is *outlived*. Superseding the decision the
design cited is what stops it admitting a dispatch, because the gate re-reads
the citation at `work start` rather than trusting the ruling. That is why the
approval ships no supersede, withdraw or decline verb and carries no
`STATEMENT_TYPES` entry: there is nothing about it a person could take back
that superseding the decision does not already take back.

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
type's add verb, from the one table in `@superself/fold` `entities.ts`.

`--why` is required on every transition. A supersession is excused from it only
where the successor's text is the reason — a decision replaced by a decision, a
convention by a convention — because reading the new record answers why the old
one stopped holding. A record of doing is not excused: a work unit's new outcome
states what will be done next and never why the previous outcome stopped being
reachable, which is the fact worth keeping. So `work add --supersedes` asks for
`--why`, the same as the `work retire --successor` it records, and a record kind
added later is excused only if its own text carries the reason. `work propose
--supersedes` is the same correction proposed rather than recorded (#389): it
carries the target and the `--why` on the creation event, displaces nothing
while the plan waits, and writes that same retirement when a person accepts. Withdrawals are
never excused: `decide retract`, `decide decline`, `convention drop`, `objective
decline`, `objective close --as dropped`, `milestone drop`, `work retire` and
`work decline` all require it.

A withdrawal is terminal against every event written in ignorance of it. Once
a record is retracted, declined or dropped, a later event naming it does not
move it back: the fold refuses the transition rather than trusting log order,
because a log merged from another clone can carry a revision written before
the withdrawal was pulled.

Only an event naming that withdrawal *by id* reverses it, which is what `undo`
records — `entity.annulled` carrying `refs.annuls`. That case is exactly the
one the rule above is not written against: an undo cannot have been composed
without seeing the event it takes back. The fold collects the annulled ids
before it reads anything else and skips those events, so every rule keeps its
shape — first-withdrawal-wins still holds among the withdrawals that stand —
and binding to an id rather than to log order is what keeps a merged log
folding to one answer. `undo --supersession` gives back what a creation
displaced and leaves its successor standing, without the link.

The ref, not the event type, carries that meaning: the fold keys on
`refs.annuls` whatever type the line is, so a log written before #390 — where
the undo's type was the legacy `entity.restored`, and its one reach into a
creation was that narrow supersession undo — folds byte-identically and
unmigrated.

A mistake is undone rather than superseded (#390). Supersession says an outcome
moved to a successor; an undo says nothing was there to move, and `self undo`
owes no `--why` because "this was a mistake" is the whole statement. Every
`entity.*` kind and `report.added` are taken back; a short list of kinds is
refused **by name**, each refusal naming the verb that does the job — a
person's ruling on a design report, stored bytes, a project archive or restore,
process telemetry, and an undo itself. A record something was already built on
is refused with the list of what stands on it; undo never cascades, because a
cascade computed on one clone would annul a set another clone would not.

One append is one undo. `refs.batch` marks an append that held more than one
event, and the undo takes back the coupled component inside it — the events
naming the same record — so `work done --report` comes back whole while
`self sweep --record`'s unrelated proposals come back one at a time.

Lifecycle refs also survive log order. A union merge orders lines by neither
time nor dependency, so a retraction can sit above the decision it withdraws;
`@superself/fold` `model.ts` `reconcileLifecycle` settles the linking transitions in a second
pass over the same events. Only transitions that are no-ops against a record
already in its terminal state run there — a revision, which accumulates, does
not.

- A new statement type is admitted only with the full set. A type that ships
  `--supersedes` and no withdrawal leaves records that can only be replaced,
  never taken back, which is the state #166 was opened over.
- The statement types are declared once in code, as `STATEMENT_TYPES` in
  `@superself/fold` `model.ts`, re-exported by the CLI's. It is load-bearing
  rather than documentation: the per-record
  history `views.ts` renders reads a record's settled status from it, so a type
  missing an entry stops saying which of its records still hold.
- Enforcement: `test/lifecycle.test.mjs` reads `STATEMENT_TYPES` out of the
  built module, fails when an entry's verbs are missing from its command's
  help, and exercises withdrawal actually leaving the current renders. Review
  holds the rest: a namespace that creates records must carry an entry or be a
  declared non-statement namespace.

## Fixed naming

Standing rules, not per-issue reminders:

- `AttemptSummary` (`@superself/fold` `model.ts`) is the folded shape of what an old `run.*`
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
- A confirm finds its project in the record it names (#302). `self work confirm`,
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
  so `@superself/fold` `entities.ts` `scopeTarget` and `rendersIn` are the one place a stored
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
