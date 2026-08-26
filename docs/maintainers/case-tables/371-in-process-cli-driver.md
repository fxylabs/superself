# Case table — the suite drives the CLI in its own process (#371)

Written before the code, and the review surface for it: a cell this table lacks
is a path nothing proves. Every test in `apps/cli/test/driver.test.mjs` is one
cell below, named by its cell number, and asserts that cell's stated outcome.
The cells that belong to other files say which file.

## The defect

The suite spawned `node apps/cli/bin/self.mjs` once per case: 2,264 call sites
across 79 test files when the issue was written, 2,479 across 85 by the time
this landed. Measured on the machine that filed the issue:

| Measurement | Value |
|---|---|
| `node bin/self.mjs --version`, 10 child runs | 24,663 ms — **2.47s each** |
| The same command 10 times in one process | **0 ms** |
| `node --test test/context.test.mjs` | **121s** wall, 5s user + 2.5s sys, **6% CPU** |

Nothing is wrong with what the suite asserts. What is wrong is that 94% of its
wall clock is macOS deciding, once per case, whether it will let a
non-notarized `node` run at all — and that the machine running it slows down
for everything else while it does. A local full run was about an hour.

## The ruling this implements

| # | Question | Decision |
|---|---|---|
| R1 | Where does a case's command run? | **In the test process.** The binary is three lines and all of it is `runCli(argv)`, which is already exported and already how `approvedIn` has run the approved path all along |
| R2 | What must the in-process driver reproduce? | **What the child produced** — not "roughly the same". A child got a cwd, a complete `env` and stdio that was not a terminal, and those three are what the contract below is made of |
| R3 | Does anything still spawn? | **Yes, and it is named.** A cell that needs a real process calls `spawnIn`/`mustSpawn`. The exception is a name in the file, not a property of whichever driver is selected |
| R4 | What holds the migration honest? | **Two independent checks.** A static one that follows a file's own wrappers, and the driver refusing a second command started on top of an unawaited one. A missing `await` is silent, so one check is not enough |

## Rules the cells are derived from

1. **A command's observation is cwd, environment and terminal.** The driver
   sets each before the call and puts each back after, in a `finally`. The
   environment is *replaced*, not added to: `machine()` deletes
   `SUPERSELF_SESSION` and that deletion has to reach the command, or a suite
   run from inside an agent session takes a different path than CI does.
2. **No terminal unless asked for.** A child ran with
   `stdio: ["ignore", "pipe", "pipe"]` and never had one. The runner may. So
   `tty` is an argument, false by default, and `approvedIn` is the one caller
   that passes `true`.
3. **One invocation forgets what the last one learned.** Every module-level
   cache in `src/` is cleared by `resetInvocation`, which `runCli` calls first.
   `paths.ts` already stated that lifetime; this makes it true of the rest.
   The same rule reaches one thing that is not a cache: the retirement
   refusal's "run this yourself" line read `process.argv`, which answers for the
   process rather than for the command. `runCli` records the argv it was given
   and that line reads it — otherwise a refusal names whatever started the
   process, which under the suite is the test runner.
4. **A missing `await` must not be silent.** The static check follows a file's
   wrappers to a fixed point and refuses what it cannot follow; the driver
   refuses an overlap at run time.
5. **Assertions do not move.** `await` and `async` are added; a refactor that
   changed what a case asserts would hide a regression in the migration.

## 1 — the driver path, command kind by command kind

`apps/cli/test/driver.test.mjs`. Each cell drives one real command.

| # | Command kind | Exit | What is asserted |
|---|---|---|---|
| 1 | a successful write (`work add`) | 0 | the receipt line, with the event id in `[brackets]` |
| 2 | a successful read (`work show`) | 0 | the body it was asked for |
| 3 | a refusal the CLI has a sentence for | 1 | the reason, by its own words |
| 4 | a refusal by policy (`login`, `access_denied`) | 2 | the code in the envelope |
| 5 | unfinished and worth retrying (`app install`, no rail) | 3 | `retry_after_s` in the envelope |
| 6 | `--json` on a command that promises it | 0 | the output parses as JSON |
| 7 | a `--json` failure (`whoami`, no credential) | 1 | the envelope is on **stdout**, not stderr |
| 8 | an error the CLI has no sentence for | 1 | the stack, as node would have printed it for a child |
| 9 | a command needing no workspace (`--version`) | 0 | the version string |
| 10 | an unknown command | 1 | `unknown command 'flurb'` |
| 11 | a write from outside a registered project | 1 | the refusal that names the remedy |

## 2 — what one command must not leave for the next

`apps/cli/test/driver.test.mjs`. These are the cells that only exist because
the commands now share a process.

| # | State | Scenario | Expected |
|---|---|---|---|
| 12 | `gitutil` probe caches | a directory probed before `git init`, then registered | exit 0. Without `resetProbes` the first probe's "no checkout here" is the answer forever |
| 13 | `paths` resolution caches | write, then read | the read sees the write |
| 14 | `redact` home rule | a refusal judged for box A, then for box B | B's own home is what B's refusal is judged against |
| 15 | `output` machine mode | `--json`, then a plain call | the second answers for a person |
| 16 | `pipeline` append hold | a hold left open, then a write | the write is recorded |
| 17 | cwd | after any call | the test process is where it was |
| 18 | `process.env` | after any call | every key is back, and nothing extra |
| 19 | `process.exitCode` | after a failed command | the test process is not exiting non-zero |

## 3 — the cells that still need a real process

| # | Cell | File | Why a child |
|---|---|---|---|
| 20 | the binary boots, resolves a workspace, records, refuses | `smoke.test.mjs` | the shebang, the `bin` mapping and module resolution of a published install. This file spawns on purpose and never stops |
| 21 | each exit code is the status a process exits with | `driver.test.mjs` | `process.exitCode` becoming an exit status is watched by nothing else once the cases stop spawning. Runs all four codes both ways and compares |
| 22 | the human gate refuses a process with no terminal | `retirement-gate.test.mjs` | a driven process has whatever terminal the driver hands it. The one cell whose subject is *not having one* needs a real one |
| 23 | the three files that decide "styled" at module load | `render-gate-tty`, `confirm-owner-tty`, `search-styled` | `style.ts` answers once, when imported. Normalising the terminal per call is too late, and a painted setup line breaks `idIn`'s `[bracket]` parse |
| 25 | the pid ledger's liveness judgment | `process.test.mjs` | **no change needed, and this table says why**: the cells record a *spawned child's* pid, never the runner's, so what liveness is judged about is the same under either driver |
| 26 | credential lock contention | `pr7-concurrency.test.mjs` | real process contention is the subject; `selfAsync` stays |
| — | the whole read and write surface, byte for byte | `golden.mjs` | what the fixture pins is what a **piped run** prints. A child with piped stdio is the thing that produces that; driving it here would make the fixture a record of what the driver arranged |

Cells 24 (two processes writing one store) and 27 (a write lock that a second
write in the same process does not deadlock on) belong to
[#367](https://github.com/fxylabs/superself/issues/367), which owns the lock
they are about. 24 cannot be written before the lock exists. 27 can be stated
without it and is: `driver.test.mjs` runs two writes back to back in one
process, which is the requirement this work places on that lock — a reentrancy
counter keyed on the normalized store path, not on the process.

## 4 — the environment and the terminal

`apps/cli/test/driver.test.mjs`. The retirement gate reads both axes at once —
it refuses unless there is a terminal *and* no agent-session marker — which
makes it the one command whose answer states what the driver handed it.

| # | State | Scenario | Expected |
|---|---|---|---|
| 28 | `SUPERSELF_SESSION`, inherited | the runner's own environment has it | the command does not see it, and the gate opens |
| 29 | `SUPERSELF_SESSION`, named | a caller passes it as `extra` | the command sees it, and the gate refuses (#230's two-session case still stands) |
| 30 | a key only the last box carried | box A then box B | B's command does not see A's key — the environment is replaced, not merged |
| 31 | `SUPERSELF_JSON=1` | the variable alone, no flag | machine mode |
| 32 | the runner has a terminal | default options | the command sees none, its output carries no styling, and the runner's `isTTY` is back afterwards |
| 33 | the caller asks for a terminal | `approvedIn`'s path | the gate opens, the record is written, and `isTTY` is back afterwards |

## 5 — the missing-`await` defence

| # | Situation | Expected | Where |
|---|---|---|---|
| 34 | two commands overlap because one was not awaited | the second refuses at once, naming both argvs | `driver.test.mjs` |
| 35 | an unawaited call through a file's own wrapper | one `awaited-driver` violation, at the wrapper's call site | `structure.test.mjs` |
| 36 | a wrapper the check cannot follow | one `untraceable-driver` violation saying so | `structure.test.mjs` |

Both were checked against the real suite by breaking a migrated file on
purpose: dropping one `await` where the result is read, and dropping one on a
setup call whose result is not read — the shape that fails silently. The static
check named the file and line for both; the driver refused the next command
for the second, with `a self call was not awaited: `self goal add own the
niche` is still running`.

## 6 — the structure rules this adds

`apps/cli/test/structure.test.mjs` asserts both against literal trees, so the
cases hold on any checkout.

| Rule | Fires on | Does not fire on |
|---|---|---|
| `invocation-state` | a top-level `let`/`var`, or a collection created empty, that no reset reachable from `resetInvocation` clears | a `Record` constant, an array literal, a populated `new Set([...])`, an `Intl.Segmenter`, a `let` inside a template string, or a name in `invocationStateExemptions` with its reason |
| `awaited-driver` | a driver call, or a call of a wrapper that reaches one — a binding's, or a property's — whose result is not awaited or handed to the caller | a file that names no driver at all |
| `untraceable-driver` | a driver used as a value; a wrapper in a binding that can be reassigned; a one-line callback that runs a command and is handed to another function | a wrapper that is a plain `const` arrow or a function declaration, a case's own callback, or a `Promise.all` |
| `test-concurrency` | a `concurrency` option on a case | — |

Which files the check reads is a predicate, not a roster: every `test/*.mjs`
that names a driver, however it imports one — a plain `import`, or the
`await import(…)` the three styled-at-load files use. A test file written next
month is read the day it is written. `driver.test.mjs` is the single exemption,
because the case that proves the runtime half of this defence has to start a
command without awaiting it, and a check that refused that would be refusing
its own evidence.

The third rule is the one that earned its keep. `array.forEach((x) => must(…))`
is a command per element that nothing waits for, and the arrow's own body reads
as "handed to the caller" — so it passes every check that only looks at where
the `await` is. Fourteen of them were in the tree; each is now a `for…of`, or a
command line the helper splices an id into rather than a callback it calls.

`invocationStateExemptions` holds eleven names and each states its kind: an
injection point a test restores itself, a registration the dispatcher makes
once at module load, or a value every use sets before reading it.

## What this table deliberately leaves out

- Changing what any migrated case asserts. The migration adds `await` and
  `async`; a diff that also changed an assertion would hide a regression in it.
- Replacing the test runner, or changing the `test` script. The driver needs
  one process per file — it says so and refuses when `process.chdir` is
  missing — and that is what `node --test test/*.test.mjs` gives it today.
- Moving when `style.ts` decides a run is styled. Three files depend on that
  being a module-load answer, and cell 23 keeps them working rather than
  changing it.
