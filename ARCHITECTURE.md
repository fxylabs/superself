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
| Machine | `machine.ts`, `repo.ts`, `gitutil.ts`, `ids.ts`, `style.ts` | the host: filesystem pointers, git, hashing, ids, terminal styling |
| Storage | `paths.ts`, `logfile.ts` | where the store lives and how the log is read |
| Domain | `completion.ts`, `objectives.ts`, `integration.ts`, `dates.ts` | per-domain state shapes and their reducers |
| Model | `model.ts` | the fold: log lines in, `ProjectModel` out |
| Render | `view.ts`, `views.ts`, `reachability.ts` | HTML and terminal rendering of a folded model |
| Fold | `fold.ts`, `connect.ts` | writing canonical markdown, views, and the managed agent block |
| Pipeline | `pipeline.ts`, `sanitize.ts` | appending events, then refolding and committing |
| Commands | `main.ts`, `lane.ts`, `goals.ts`, `train.ts`, `requirements.ts`, `<subsystem>/commands.ts` | argument parsing, refusals, dispatch |

The append path runs top-down through these layers while imports run
bottom-up: `pipeline.ts` imports `fold.ts`, which imports `model.ts` and
`view.ts`. Data flows down the table; dependencies point up it. Never invert
either — a renderer that imports `pipeline.ts` would make rendering able to
write state.

- A new module joins an existing layer or declares a new one here first.
- A domain module (`completion.ts`, `objectives.ts`) imports `types.ts` and its
  own peers only. It never imports `model.ts`, so a reducer can never depend on
  the fold that calls it.
- `model.ts` imports domain modules, never commands.
- Enforcement: review. `tsc` catches a cycle only when it becomes a type error,
  so the import direction is a reading check on every pull request.

## Subsystems

A subsystem owns a directory. Today: `attempt/` (runner supervision), `spec/`
(work specs), `daemon/` (the supervisor loop). `integration/` is the next one
(#88); until it exists, the train cluster is flat at the top level.

Dependencies between subsystems are one-way, verified on `main`:

```text
daemon/  →  attempt/ + spec/  →  core
spec/    →  attempt/          →  core
attempt/ →  core
```

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

Each rule below has exactly one implementation and exactly one path through it.
A second path around any of them is a review finding, not a refactor note.

| Gate | Module | Rule |
| --- | --- | --- |
| Event append | `pipeline.ts` `recordEvent` / `recordEvents` | the only writer of `log.jsonl`; every event verb goes through it |
| Event sanitization | `sanitize.ts` `assertSanitized` | called once, from `recordEvents`, before any byte reaches the log |
| Completion refusal | `completion.ts` `completionRefusal` | the one answer to "may this unit be done"; `work done` and the model both read it |
| Attempt completion | `attempt/gate.ts` `verifyDeclarations` | an attempt is complete only through the envelope check; an exit code is not a result |
| Argument parse | `args.ts` `parseCommand` / `subcommand` | every command reads its arguments here, so an unknown flag is named instead of dropped (#28) |

- Adding a caller of a gate is normal. Adding a *second implementation* of what
  a gate decides is the violation — including a local re-check that duplicates
  the gate's condition and can drift from it.
- A new gate is added to this table in the same pull request that introduces it.
- Enforcement: review, guided by this table. `proof/event-sanitization.mjs`
  covers the sanitization gate specifically.

## Event namespaces

An event type is `<namespace>.<verb>`. Each namespace has one owner. New events
extend an owned namespace; they never mint a sibling namespace for the same
concern.

| Namespace | Owner | Emitted from |
| --- | --- | --- |
| `run.*` | the runner supervisor | `attempt/`, `daemon/` |
| `attempt.*` | the integration train | `lane.ts`, `integration.ts` |
| `work.*` | work state, requirements, proposals | `main.ts`, `requirements.ts`, `goals.ts` |
| `objective.*`, `milestone.*` | the outcome layer | `goals.ts` |
| `review.*` | review receipts | `reviews.ts` |
| `spec.*` | work specs | `spec/`, `daemon/` |
| `goal.*`, `decision.*`, `report.*`, `convention.*` | core project state | `main.ts` |

`run.*` and `attempt.*` name two different things and the split is
deliberate: a *runner attempt* is one launch of a provider under a plan
(`run.started`, `run.completed`, id prefix `at-`), and an *integration attempt*
is one pass of a change set through the train (`attempt.started`,
`attempt.finished`, id prefix `ia-`). Do not merge them, and do not use one
namespace's verbs for the other's records.

- Enforcement: `model.ts` and the per-domain reducers dispatch on the type
  string, so an unowned namespace folds into nothing. Review catches it earlier.

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
- One artifact declaration shape: `{name, sha256, bytes}`, in the result
  envelope, in `AttemptSummary.artifacts`, and in the gate. `name`, never
  `path`. See the envelope contract in
  [CONTRIBUTING.md](CONTRIBUTING.md#result-envelope-contract).

## Known debt

Recorded here so the rules above can be stated without exceptions written into
them. Tracked by #88; do not use any of these as precedent.

- The integration train cluster is flat: `integration.ts` (1,500 lines),
  `lane.ts`, `train.ts`, `trainutil.ts`, `promote.ts`, `reviews.ts`,
  `envelope.ts` form one subsystem with no directory.
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
- [docs/strategy/problem-definition.md](docs/strategy/problem-definition.md) —
  the state architecture the CLI implements.
