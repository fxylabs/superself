# @superself/fold

The fold: an event log read as project state.

Superself records what a project decided, what it is doing and what it owes as
an append-only log of events. The state a person or an agent reads is not
stored — it is calculated from that log, every time. This package is that
calculation, and it is a package because two programs have to run it: the
`self` CLI on a person's machine, and the Workspace API server on the other
side of a network. A second copy of the fold would be a second answer.

## Two layers

```ts
import { applyLocalOverlay, foldEvents, FOLD_VERSION } from "@superself/fold";

// 1. What the log alone decides. Same events in, same state out — on every
//    machine, at every hour. This is all a server needs.
const model = foldEvents(events, { slug: "demo", description: "the demo project" });

// 2. What one machine adds. Every input is an argument, because none of them
//    travels with the log.
applyLocalOverlay(model, events, {
    now: new Date(),
    session: process.env.SUPERSELF_SESSION,
    verdicts: { abc1234: "settled" },
    zone: "Asia/Seoul"
});
```

The seam is the point. `foldEvents` reads events and nothing else: no clock, no
session, no filesystem, no judgement about whether a recorded commit ever
landed. `applyLocalOverlay` is where all four enter, and they enter as
arguments.

`FOLD_VERSION` names the calculation. Two readers of one log agree on the state
they compute only while they fold the same way, and a response naming a
different version is what tells a reader its answer and the server's were not
produced by the same code.

## What this package will not do

- Read a file, an environment variable or a terminal.
- Run anything when a module is loaded.
- Raise the CLI's error type. It raises `FoldError`; a consumer converts at its
  own boundary.
- Import its consumers.

`test/purity.test.mjs` asserts each of those from the syntax tree rather than
leaving them to review, and `test/determinism.test.mjs` asserts that one event
array folds to one state whatever the clock, the session and the verdicts say.

## Status

Lives in the [superself](https://github.com/fxylabs/superself) monorepo
alongside the `self` CLI, which is its first consumer and today its only one.
It is not on npm yet: the CLI depends on it through the workspace protocol, and
publishing it — then pinning the CLI to a real version — is a separate step.
The surface is stable in the sense that the CLI's whole test suite runs against
it; it is not yet promised to third parties, and it is versioned on its own
rather than in lockstep with the CLI.

## License

Apache-2.0.
