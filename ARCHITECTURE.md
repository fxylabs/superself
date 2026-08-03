# Architecture

The standing structure rules for this repository, with `apps/cli/src` as the
worked example. Read this before adding a module, a directory, an event type,
or a second way to do something that already has one.

Every rule below states its enforcement point: the place a violation is caught,
or the review that has to catch it. Claims about the current tree were checked
against the import graph on `main`; where the tree does not yet satisfy a rule,
the gap is listed under [Known debt](#known-debt) rather than softened here.

## Layering

Dependencies point one way, downward. No module may import from a layer above
it. The layers, lowest first:

| Layer | Modules | Owns |
| --- | --- | --- |
| Types | `types.ts` | the event and context shapes; imports nothing local |
| CLI surface | `args.ts`, `help.ts`, `human.ts` | how a command reads its arguments, describes itself, and confirms a human; `help.ts` and `human.ts` import nothing local |
| Machine | `machine.ts`, `repo.ts`, `gitutil.ts`, `ids.ts`, `style.ts` | the host: filesystem pointers, git, hashing, ids, terminal styling |
| Storage | `paths.ts`, `logfile.ts` | where the store lives, how the log is read, and how the store's other state files are read (`readRegistry`, `readStoreConfig`, `readVerdicts`) |
| Domain | `completion.ts`, `objectives.ts`, `integration.ts`, `dates.ts` | per-domain state shapes and their reducers |
| Model | `model.ts` | the fold: log lines in, `ProjectModel` out |
| Render | `view.ts`, `views.ts`, `pretty.ts`, `reachability.ts` | HTML and terminal rendering of a folded model |
| Fold | `fold.ts`, `connect.ts` | writing canonical markdown, views, and the managed agent block |
| Pipeline | `pipeline.ts`, `sanitize.ts` | appending events, then refolding and committing |
| Command support | `artifact.ts`, `envelope.ts`, `trainutil.ts` | what more than one command surface shares: artifact staging (`artifact.ts`, which also holds the `artifact` verb), receipt-envelope validation, change-set and promotion lookup |
| Commands | `main.ts`, `lane.ts`, `goals.ts`, `train.ts`, `promote.ts`, `reviews.ts`, `requirements.ts`, `search.ts`, `setup.ts`, `sync.ts`, `<subsystem>/commands.ts` | argument parsing, refusals, dispatch |

The table places every module in the `apps/cli/src` top level, so the
no-upward-import rule is checkable for all of them. The seven train-cluster
modules — `integration.ts`, `lane.ts`, `train.ts`, `promote.ts`, `reviews.ts`,
`trainutil.ts`, `envelope.ts` — are placed by what they import today, not by
where they belong once `integration/` exists; see [Known debt](#known-debt).

The append path and the imports run the same way, from higher layers to lower
ones: a command calls `pipeline.ts`, which imports `fold.ts`, which imports
`model.ts` and `view.ts`. Nothing points back up — a renderer that imported
`pipeline.ts` would make rendering able to write state.

- A new module joins an existing layer or declares a new one here first.
- A domain module (`completion.ts`, `objectives.ts`, `integration.ts`,
  `dates.ts`) imports `types.ts`, lower layers, and its own peers only — never
  `model.ts`, so a reducer can never depend on the fold that calls it.
- `model.ts` imports domain modules, never commands.
- Enforcement: review. `tsc` catches a cycle only when it becomes a type error,
  so the import direction is a reading check on every pull request.

## Subsystems

A subsystem owns a directory. Today: `attempt/` (runner supervision), `spec/`
(work specs), `daemon/` (the supervisor loop), `evidence/` (evidence bundles).
`integration/` is the next one (#88); until it exists, the train cluster is flat
at the top level.

Dependencies between subsystems are one-way, verified on `main`:

```text
daemon/   →  attempt/ + spec/  →  core
spec/     →  attempt/          →  core
attempt/  →  core
evidence/ →  core
```

`evidence/` is the read-only one: it compiles recorded state into a file and
appends nothing, so it never reaches `pipeline.ts` and owns no event namespace.

- No subsystem imports a subsystem above it. `attempt/` imports core modules
  only; it never reaches into `spec/` or `daemon/`.
- Core modules never import from a subsystem directory. The dispatcher
  (`main.ts`) is the exception by role — it imports each subsystem's
  `commands.ts` and nothing else from it.
- A new subsystem is a directory from its first file, with a `commands.ts`
  entry point. A cluster of related top-level modules is the shape #88 exists
  to remove; do not add another.
- Exports are narrowed to what importers actually use. A subsystem that exports
  its whole surface has no boundary.
- Enforcement: review, plus the import-graph spot-check in the pull request
  template.

## Single gates

Each rule below has exactly one implementation. Adding a second path around one
of them is a review finding, not a refactor note. Five of the six have exactly
one path through them today; the argument-parse gate has two, recorded under
[Known debt](#known-debt), and a new command may not widen that.

| Gate | Module | Rule |
| --- | --- | --- |
| Event append | `pipeline.ts` `recordEvent` / `recordEvents` | the only writer of `log.jsonl`; every event verb goes through it |
| Event sanitization | `sanitize.ts` `assertSanitized` | called once, from `recordEvents`, before any byte reaches the log |
| Completion refusal | `completion.ts` `completionRefusal` | the one answer to "may this unit be done"; `work done` and the model both read it |
| Attempt completion | `attempt/gate.ts` `verifyDeclarations` | an attempt is complete only through the envelope check; an exit code is not a result |
| Attempt preparation | `attempt/provision.ts` `provisionWorkdir` / `releaseWorkdir` | an attempt's execution environment is cut, prepared and taken back in one place; `run.ts` `prepareAttempt` is how `attempt run` and `attempt register` both reach it, and no brief prepares anything itself |
| Argument parse | `args.ts` `parseCommand` / `subcommand` | the guard a command declares its options and its positional count to, so an unknown flag *and* a stray argument are named instead of dropped (#28). Required of every new or migrated command surface |

Unknown flags are named CLI-wide even in the surfaces that still call
`node:util` `parseArgs` directly, because `main.ts` `userMessage` translates
node's `ERR_PARSE_ARGS_*` codes centrally. That second path does not carry
`parseCommand`'s unexpected-positional refusal, which is why it is debt rather
than a sanctioned alternative.

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
| `run.*` | the runner supervisor | `attempt/`, `daemon/` |
| `spec.*` | work specs | `spec/` |
| `work.*` | work state, requirements, proposals | `main.ts`, `requirements.ts`, `goals.ts` |
| `objective.*`, `milestone.*` | the outcome layer | `goals.ts` |
| `goal.*`, `decision.*`, `convention.*` | core project state | `main.ts` |
| `report.*` | work reports | `main.ts`, `attempt/gate.ts` |
| `changeset.*`, `attempt.*`, `lease.*`, `merge.*`, `promotion.*`, `repo.*`, `target.*`, `main.*`, `ci.*`, `review.*` | the integration train — `INTEGRATION_PREFIXES` in `integration.ts` is the list | `train.ts` (changeset), `lane.ts` (attempt, lease, merge, ci/main/target), `promote.ts` (promotion, repo, main), `reviews.ts` (review) |

`integration.ts` reduces the train namespaces; it emits none of them, as the
layering rule requires of a domain module. `ci.observed` is emitted — along with
`main.observed` and `target.observed` — by `ingestObservations` in `lane.ts`,
which builds `` `${item.kind}.observed` `` from the kind that `self integration
observe ci|main|target` was given; `lane.ts` emits `main.observed` or
`target.observed` again when a merge advances the target. Because the
observation site composes the type at runtime, a literal search for `"ci.`
finds no emitter at all — search for the verb, not the namespace, before
concluding a namespace is unwritten.

`run.*` and `attempt.*` name two different things and the split is
deliberate: a *runner attempt* is one launch of a provider under a plan
(`run.started`, `run.completed`, id prefix `at-`), and an *integration attempt*
is one pass of a change set through the train (`attempt.started`,
`attempt.finished`, id prefix `ia-`). Do not merge them, and do not use one
namespace's verbs for the other's records.

- Enforcement: `model.ts` and the per-domain reducers dispatch on the type
  string, so an unowned namespace folds into nothing. Review catches it earlier.

### The record lifecycle

A *statement-type record* is one a person asserts and can later take back: a
decision, a convention, an objective, a milestone, a work unit, a requirement.
Reports are the exception by design — they are append-only history, and nothing
withdraws a report.

Every statement type ships the same three transitions, inside its own
namespace, before it is admitted (#166):

| Transition | What it means | Where it renders |
| --- | --- | --- |
| supersede | replaced by a linked successor; `--supersedes`, repeatable | predecessor folds to `superseded`, lineage kept |
| withdraw | taken back with `--why` and no successor | folds to `retracted`/`dropped`; leaves every current render |
| decline | a proposal turned down with `--why`, beside `accept` and expiry | folds to `declined`; leaves "waiting on you" at once |

The verbs keep each type's existing vocabulary — `decide retract`, `convention
drop`, `work retire` — but no type may be missing a transition. A withdrawn
record is never deleted or rewritten: it keeps its text and its refs, so
`--after` and `--blocks` pointing at it still resolve, and `self search` still
returns it with its status in the result line.

`--why` is required on every transition but supersede — a supersession says
why by naming its successor, and nothing else does. That covers `decide
retract`, `decide decline`, `convention drop`, `objective decline`, `objective
close --as dropped`, `milestone drop`, `work retire`, `work decline` and
`work drop`.

A withdrawal is terminal. Once a record is retracted, declined or dropped, a
later event naming it does not move it back: the fold refuses the transition
rather than trusting log order, because a log merged from another clone can
carry a revision written before the withdrawal was pulled.

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
  `model.ts`. It is load-bearing rather than documentation: `search.ts` builds
  its historical-status markers from it, so a type missing an entry stops
  saying which of its records still hold.
- Enforcement: `test/lifecycle.test.mjs` reads `STATEMENT_TYPES` out of the
  built module, fails when an entry's verbs are missing from its command's
  help, and exercises withdrawal actually leaving the current renders. Review
  holds the rest: a namespace that creates records must carry an entry or be a
  declared non-statement namespace.

## Fixed naming

Settled by the #35 and #54 re-plans. These are standing rules, not per-issue
reminders:

- `AttemptSummary` (`model.ts`) is the base shape for what a runner attempt
  left in the folded log: `id`, `state`, `ts`, optional `failure`/`detail`/
  `model`, and `artifacts: {name, sha256, bytes}[]`. Extend it; do not declare a
  parallel summary type.
- `runAttemptId()` mints runner attempt ids (`at-`); `attemptId()` mints
  integration attempt ids (`ia-`). Both live in `ids.ts`. Never rename either to
  the bare `attemptId` in a new module.
- One spool. `attempt/spool.ts` owns the machine-local spool — its root, its
  layout, its append path, its redaction scope. Raw runner output stays there
  and never folds into project state. Code that needs runner output opens a
  `Spool`; it does not read the directory itself.
- One provisioned workdir per attempt, and the attempt id names it. It is cut
  at `workdir/` inside that attempt's spool, so two attempts of one work unit
  can never be handed the same checkout and retention reclaims it with the rest
  of the attempt. The binding — repository, remote, head, digest — is
  `provision.json`, the ordered step log is `preparation.jsonl`, and the agent
  reads the path from `SUPERSELF_ATTEMPT_WORKDIR`. The project's preparation
  template is `.self-preparation.json` at the repository root, read out of the
  provisioned worktree at its pinned head and never off the runner's own
  checkout; see the contract in
  [CONTRIBUTING.md](CONTRIBUTING.md#attempt-preparation-template).
- One artifact declaration shape: `{name, sha256, bytes}`, in the result
  envelope, in `AttemptSummary.artifacts`, and in the gate. `name`, never
  `path`. See the envelope contract in
  [CONTRIBUTING.md](CONTRIBUTING.md#result-envelope-contract).
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
- A recovery pointer a render prints is a type, not a string. Every rendered
  surface that says "run this for the rest" names the project it is about, or
  a reader pastes it somewhere else and is answered about their own checkout.
  `pretty.ts` `Pointer` is branded and minted only by `scoped()`, `fromCheckout()`
  and `withCheckout()`, so a bare literal handed to a section builder fails
  typecheck; the verbs with no scope form are the `UnscopedVerb` union, and the
  constructors that take one also take the `Checkout` sentence that says where
  to stand, so the note cannot be left off. A pointer written into prose is
  still a string — review holds those.
- Piped output is a contract. `self context`, `self work` and `self status`
  render for a person only when stdout is a terminal; a pipe, a redirect,
  `--plain`, `TERM=dumb`, and a terminal too narrow for a table all get the
  same bytes an agent has always read. `pretty.ts` `resolveRender` is the one
  place that answers which render a run gets, and `style.ts` `displayWidth` is
  the one place that measures a string in terminal cells — a surface that lays
  text out reads its width from there rather than from `String.length`.

## Known debt

Recorded here so the rules above can be stated without exceptions written into
them. The code moves are tracked by #88 and #90 adds the mechanical checks; an
entry with no issue behind it says so. Do not use any of these as precedent.

- Two argument-parse paths, not one. `main.ts`, `requirements.ts`,
  `artifact.ts`, `daemon/commands.ts`, the `objective` and `milestone` surfaces
  of `goals.ts`, and most of `attempt/commands.ts` go through `args.ts`
  `parseCommand`; `lane.ts`, `train.ts`, `promote.ts`, `reviews.ts`, the
  work-proposal surfaces of `goals.ts`, and the remainder of `spec/`,
  `attempt/commands.ts` call `node:util` `parseArgs` directly — about 31 call
  sites, down from 38 when `objective` and `milestone` moved. Those sites get
  node's unknown-flag error translated by `main.ts` `userMessage`, but not
  `parseCommand`'s unexpected-positional refusal, so a stray argument is still
  dropped there (`lane.ts` `cancelAttempt` reads `positionals[0]` and ignores
  the rest — the #28 class of bug, unclosed on that surface). No issue tracks
  the migration yet.
- The integration train cluster is flat: `integration.ts` (1,500 lines),
  `lane.ts`, `train.ts`, `trainutil.ts`, `promote.ts`, `reviews.ts`,
  `envelope.ts` form one subsystem with no directory.
- `attempt/` reaches up into `daemon/` for the categorical forbidden-action
  list: `attempt/commands.ts` and `attempt/provision.ts` both import
  `daemon/forbidden.js`, which is the wrong direction for the subsystem order
  above. The list is policy vocabulary that answers the same question for a
  plan's command, a work spec's, and a preparation step's, so it belongs at the
  top level beside the other shared judgements — but it types its two entry
  points on `AttemptPlan` and `WorkSpec`, so moving it is the #88 split rather
  than an import change. Do not add a third reacher; call one of the two that
  already exist, or move the module.
- Two core modules reach into `attempt/`: `sanitize.ts` imports
  `attempt/redact.js`, and `views.ts` imports `attempt/spool.js`. `redact`
  belongs at the top level so the event guard depends only on core.
- `main.ts` still holds command bodies (init, workspace, lang, project, view,
  sync, clone, context, status, theme, timezone) instead of dispatching to
  modules like the newer surfaces do.
- Helpers are duplicated rather than shared: `requireText` in four modules,
  `strip` in two, the `str`/`list` payload coercers in three. `trainutil.ts`
  exports the canonical `requireText`.
- `Blocker` (`integration.ts`) and `Refusal` (`lane.ts`) are one type declared
  twice. `Coverage` is exported by both `integration.ts` and `objectives.ts`
  for unrelated concepts.
- `view.ts` / `views.ts` do not state their roles from their names.

## Related documents

- [CONTRIBUTING.md](CONTRIBUTING.md) — the conventions an implementation is
  judged by, including the result-envelope contract.
- [docs/integration-train.md](docs/integration-train.md) — the change-set,
  receipt, lease, and merge contract.
- [docs/evidence-bundle.md](docs/evidence-bundle.md) — the manifest and bundle
  formats, the canonical serialization, and the versioning policy.
- [docs/strategy/problem-definition.md](docs/strategy/problem-definition.md) —
  the state architecture the CLI implements.
