# Case table — publishing the fold, and the CLI after it (#430)

Every cell below is one test, named by its row id. The table is the review
surface: a row the table lacks is a path nothing proves.

Cells live in five files:

| File | What it holds |
|---|---|
| `scripts/release-gate.test.mjs` | the refusal rules R1–R26 |
| `scripts/publish-order.test.mjs` | the workflow's shape and order W1–W9 |
| `scripts/pack-install-smoke.mjs` | the pack/install smoke S1–S13 — a command rather than a test file, run by `pnpm smoke` in CI and again in the publish gate |
| `scripts/pack-install-smoke.test.mjs` | S14, the smoke's one pure decision — held here because the way it breaks needs a symlinked temporary directory |
| `apps/cli/test/docs.test.mjs` | the catalogue-against-the-parser rows H1–H2 |

## What this adds

`@superself/fold` was extracted (#420) and never published, and the CLI depended
on it through `workspace:*` — a spec `npm publish` uploads verbatim, so a
release would have shipped a tarball nobody could install. A guard stopped the
release there rather than shipping one. This is what the guard was waiting for.

## The rule this implements

One tag, two packages, one order.

- The tag `vMAJOR.MINOR.PATCH` names the **CLI's** version and must equal
  `apps/cli/package.json`. Unchanged from what shipped.
- The fold's version is `apps/fold/package.json`'s, gated the same way against
  its own manifest: it may not already be on the registry.
- The CLI depends on the fold by the **exact** version being published beside
  it. Not a range: a range would let one tag mean two different pairs depending
  on when somebody installed it, and the pair the suite proved is one pair.
- The tag's commit must be on `main`.
- Neither version may already be on the registry — refused before the first
  upload rather than discovered halfway through the run.
- The tag names a **final** version. A prerelease or build-metadata tag is
  refused while no dist-tag policy exists, because both publishes take npm's
  default and `latest` is where every `npm i -g superself` reads from.

`@superself/fold` is an internal implementation package. Its version is
coordinated with the release it ships in rather than marketed on its own, which
is why "the CLI's pin is the fold's version" is a rule the gate can state
instead of a compatibility range somebody has to reason about.

## The bootstrap the first tag needs

npm's trusted publishers are configured **on a package**, so they cannot be
configured for a package that does not exist. `@superself/fold` has never been
published, and the workflow reads no token (W6) — so its first `npm publish`
under OIDC fails `ENEEDAUTH`, and the first real tag would die there.

The way out is one manual ceremony, written down in
`docs/maintainers/releases.md` under *Bootstrapping a package's first publish*:
the operator publishes a **low placeholder** (`@superself/fold@0.0.1`) by hand
from a tagged-adjacent commit, configures the trusted publisher against the
package that now exists, then throws the local edit away and tags the real
release. The placeholder has to be *below* every version the project will
release, because a version once on the registry can never be tagged — publishing
the intended version by hand would make that version un-taggable forever.

R21 is the proof that the sequence is gate-compatible rather than a second dead
end: a registry holding only the placeholder refuses the first real tag nothing.
The pin rules never saw the placeholder (they compare the CLI's pin to
`apps/fold/package.json`, which the local edit reverted), and the
already-published rule was always "this version is not on the registry" rather
than "nothing of this package is" — R13 says the same thing from the other side.

S13 belongs to the ceremony too: the placeholder is a real published tarball, so
it has to carry the licence before it goes, and a published version cannot be
fixed.

## Why an exact pin rather than `pnpm publish`

The brief allowed either a hard pin or `pnpm publish`'s workspace-protocol
substitution. The pin won on two counts.

The tarball is the first. A pin is in the manifest a reviewer reads and the
manifest `npm pack` uploads — the same bytes, checked by S3 against the packed
tarball rather than against the repository. Substitution is a transformation
performed at publish time by a tool whose output nothing in this repository
sees until it is on the registry.

Trusted Publishing is the second. Publishing here is OIDC with no token secret,
which is an `npm publish` on npm 11.5+; `pnpm publish` is a different client and
this repository has no evidence about its OIDC support to stand a release on.
Keeping `npm publish` keeps the auth mechanism the operator decided on.

The development loop is what a hard pin usually costs, and it costs nothing
here: `linkWorkspacePackages: true` in `pnpm-workspace.yaml` means a dependency
a workspace package already satisfies is linked from `apps/` rather than
fetched. `pnpm-lock.yaml` still records `link:../fold`, so `pnpm install`,
`pnpm build` and the CLI's typecheck against the fold's declarations are
unchanged.

## Why a local registry rather than an override

The smoke installs from an HTTP server that speaks enough of the registry
protocol to answer a name with a version and a version with a tarball. The
alternatives were `--install-links` and a `file:` or `overrides` rewrite, and
both answer the CLI's dependency with a tarball **whatever the pin says** — a
CLI pinned at 9.9.9 would install green under either. The pin is the thing under
test, so the resolution has to be real. S12 is that claim's proof: the same
install, against a registry the fold is not on, fails.

## The order, and what a half-run leaves behind

```
gate  ──▶  publish-fold  ──▶  publish-cli
 │              │                  │
 │              │                  └─ fails: an extra fold version nothing
 │              │                     depends on. Nobody's install changes.
 │              └─ fails: nothing was published at all.
 └─ refuses: nothing was published at all.
```

The reverse order has no such row. A CLI published first depends on a fold
version that is not on the registry, so every `npm i -g superself` between that
upload and the next one fails — and the version cannot be replaced. The order
is what makes the failure asymmetric, and W3 is what holds it in place: no test
of either package can see a `needs:` edge in a yaml file. W8 holds the other
half of it: an `if:` or a `continue-on-error:` on either publishing job would
leave the `needs:` edge in place and the order gone.

Surviving a half-run is not the same as finishing one, and the finish has one
working path: GitHub's **Re-run failed jobs**, which re-runs `publish-cli`
alone. "Re-run all jobs" and delete-and-re-push both re-run `gate`, which now
sees the fold version the run published a minute ago. R25 is the sentence that
state gets — it names re-running the failed job rather than raising a version
the registry does not hold — and R26 holds that a pair genuinely already
published still gets the plain refusal. `docs/maintainers/releases.md` writes
the path out under *Recovering a half-published release*.

`release-keys` used to be the hole in this picture: the CLI's `prepublishOnly`
refuses a `rootkeys.ts` left pinning a development root, and that hook runs
inside `publish-cli` — after the fold is on the registry for good. It is the one
refusal able to fail the run halfway, so the gate runs it too (W7). The hook
stays where it is, as the last line in front of the upload itself.

## The rows

### The gate — what refuses, and with which sentence

| id | case | expected |
|---|---|---|
| R1 | a tag naming the CLI's version, pinned to the fold being published, on main, neither on the registry | nothing is refused |
| R2 | a tag naming a version the CLI is not at | refused, naming the tag's version and the manifest's |
| R3 | the tag written without its leading `v` | the `v` is the tag's, not the version's — nothing is refused |
| R4 | a tag on a commit that is not on `main` | refused |
| R5 | a tag whose ancestry could not be read at all | refused — "we could not tell" and "it is on main" are different answers, and only one may publish |
| R6 | a pin that is a range (`^0.2.0`) over the fold version being published | refused, naming both |
| R7 | a pin naming a fold version other than the one this run publishes | refused, naming both |
| R8 | a CLI manifest that depends on no fold at all | refused |
| R9 | the CLI depending on the fold as `workspace:*` | the workspace-protocol refusal, said once — not also as a bad pin |
| R9 | a `workspace:` spec in `optionalDependencies` or `peerDependencies`, in either package | the same refusal, naming the package and the field's dependency |
| R10 | a `workspace:` spec in `devDependencies` | nothing is refused — it is not installed from a published tarball |
| R11 | a fold version the registry already holds | refused before anything publishes |
| R12 | a CLI version the registry already holds | refused before anything publishes |
| R13 | the fold's first release, with nothing of it on the registry | nothing is refused |
| R14 | every rule broken at once, both versions prereleases | every sentence, none swallowing another — and the channel rule says two, one per version it read |
| R15 | this repository's own two manifests, as they stand, and the fold's raised to a prerelease | nothing is refused — a bump that moved one manifest and not the other is red on every pull request; the prerelease fold is refused, which the synthesised tag alone would not have caught |
| R16 | a commit on the release branch, and one on a side branch, in a real repository | on the branch passes; the side branch does not |
| R17 | a branch ref this checkout cannot resolve | refused, never read as a pass |
| R18 | a package nobody has published yet (`E404`) | no versions — not a failure |
| R18 | one published version, and many | both read as a list |
| R19 | a registry that cannot be reached at all | the gate stops, naming the package — never read as an unpublished one |
| R19 | the runner against a registry it cannot be asked | exit 1 and one sentence on stderr — never a stack trace, which would read as a bug in the gate rather than as the outage it is |
| R20 | a run naming no tag at all | one sentence naming how it is called, not a stack |
| R21 | the bootstrap placeholder on the registry when the first real tag runs | nothing is refused — the ceremony leaves a gate-compatible state |
| R22 | a prerelease tag (`v0.13.0-rc.1`) matching a prerelease manifest | refused, naming the channel policy that does not exist and where `latest` is read from |
| R23 | a tag carrying build metadata (`v0.13.0+build.5`) | refused the same way |
| R24 | the same release tagged as a final version | nothing is refused — the refusal is the channel, not the version |
| R25 | the fold on the registry and the tag's CLI version not | refused, naming "Re-run failed jobs" — not "raise the version", which the CLI's version does not need |
| R26 | both versions on the registry | the plain already-published sentence, once per package, and no mention of re-running |
| R27 | a **final** tag whose fold manifest is a prerelease | refused, naming `apps/fold/package.json` — the tag names the CLI's version and never the fold's, and both packages publish from the one run |
| R28 | a fold manifest carrying build metadata | refused the same way |

### The workflow — shape and order

| id | case | expected |
|---|---|---|
| W1 | what fires the workflow | a `v*` tag push, and nothing else |
| W2 | which jobs publish | exactly two, one per package, each `npm publish` in its own directory and exactly once |
| W3 | the order | the CLI needs the fold, the fold needs the gate, and the gate waits for nothing |
| W4 | what the gate runs | the version rules against `$GITHUB_REF_NAME`, the pack/install smoke, and a full-history checkout with `main` fetched to compare against |
| W5 | the workspace-protocol guard | present in both publishing jobs, immediately before the publish and with no step between |
| W6 | how publishing authenticates | OIDC (`id-token: write`) — no job reads a token secret |
| W7 | the pinned-root-key check | runs in the `gate` job and exits 0 against this tree, so a `rootkeys.ts` in the rotation state — the fixture beside it — refuses before the fold is published rather than in `publish-cli`'s `prepublishOnly` |
| W8 | `if:` and `continue-on-error` on every job in the chain | absent from all three — a `needs:` edge only holds an order while the default condition does, and a `gate` that swallowed its own failure reads as success to the job below it |
| W9 | two `v*` runs at once | a `concurrency` group they queue in, with no cancel: a run that has published the fold must be allowed to finish the CLI. Three is the shape the comment beside it names and the rule against — the group holds one waiting run, so the middle tag is cancelled |

### The pack/install smoke

| id | case | expected |
|---|---|---|
| S1 | what `npm pack` puts in the CLI tarball | `bin/self.mjs` and `dist/main.js` — the `files` field did not drop the built artifacts |
| S2 | the same for the fold | `dist/index.js` and `dist/index.d.ts`, which its `exports` point at |
| S3 | the pin in the **packed** manifest | the fold version packed beside it, read out of the tarball rather than out of the repository |
| S4 | installing the CLI tarball from a registry holding both | it installs |
| S5 | what the installed CLI's `dist/main.js` resolves `@superself/fold` to | a path inside the install prefix, and not inside this repository |
| S6 | the fold that landed beside it | the version that was published |
| S7 | the installed fold's tree | it holds the `dist/index.js` its `exports` name |
| S8 | every built CLI module's imports | none climbs out of the installed package — no `../`, no `apps/fold`, no repository path |
| S9 | `self --version`, run as `node_modules/.bin/self` | the CLI's version — so the shebang, the bin mapping and the executable bit all survived the tarball |
| S10 | `self init --git` then `self status`, from the installed binary | both succeed: git mode is untouched by the packaging |
| S11 | `self store size` in a store marked server-backed | refused, naming what the verb is for — API mode is untouched too |
| S12 | the same install against a registry the fold is **not** on | it fails — the pin is resolved through the registry, not vendored or overridden |
| S13 | the LICENSE in both tarballs | present — the licence each manifest declares travels with the bytes, and a published version can never be given one later |
| S14 | an install prefix reached through a symlink | still reads as the install prefix. `os.tmpdir()` keeps the symlinks it was written with and `require.resolve` answers a real path, so on macOS (`/var` -> `/private/var`) the two shared no prefix and S5 could not pass at all |
| S14 | a fold resolved out of this repository, and a repository reached through a symlink | both still refused — resolving the real paths does not weaken the half of S5 that is the actual claim, and the symlinked checkout is the case where comparing the strings as written would have passed the workspace source |

### The documents against the parser

| id | case | expected |
|---|---|---|
| H1 | every flag the `cli.md` catalogue names | is a flag the parser declares on that verb |
| H2 | the catalogue's `init` entry | is the contract's `init` syntax line, flag for flag |

## What is not here

**No `--dry-run` publish.** Nothing here calls `npm publish`, and a workflow
cannot be run outside GitHub Actions. The rules a real publish would apply are
in `scripts/release-gate.mjs` as a function of facts, which is why R1–R28 can
state a tag, two manifests and a registry and read the refusal back; the shape
of the workflow that calls it is W1–W9, read off the file. Between them what is
untested is the yaml runner, which is not ours.

**No "the fold did not change" row.** R11 refuses a fold version the registry
already holds, with no exception for a release whose fold is byte-identical to
the published one — so a CLI-only release raises the fold's version too. That is
the rule this issue settled rather than an oversight, and
`docs/maintainers/releases.md` says so where a maintainer preparing a release
will read it. The alternative — publish the fold only when its version is new —
is only safe if the run can prove the already-published bytes are the ones this
commit would upload, and that is more machinery than a version bump.

**No dist-tag rows, because prereleases are refused.** Which npm dist-tag a
prerelease should land on is decided nowhere, and a gate may not invent a
channel. Both `npm publish` calls take the default, `latest`, which is where
every `npm i -g superself` reads from — so a `v0.13.0-rc.1` tag would replace
the stable install target for everybody. Rather than leave that reachable, the
gate refuses the grammar of both versions the tag publishes (R22, R23, R27, R28)
and `docs/maintainers/releases.md` says
prereleases are not releasable until a channel policy exists. That restores what
was true before this change, when the workspace-protocol guard stopped every
`v*` tag: no prerelease can publish. The rows to add when the policy is written
are the dist-tag ones — `--tag next` passed, `latest` unmoved.

**H1 is a subset rule, not equality.** The `cli.md` catalogue is a summary and
says so — 17 of its entries abbreviate a verb's options, and one that spelled
every flag of every verb would be the help page with worse formatting. What a
summary may never do is name a flag the parser does not accept, and that is what
H1 holds. `init` alone is held to equality (H2), because its flags decide which
kind of store a person gets and a summary that drops `--git` and `--cloud` hides
the choice rather than shortening it. That drop is the drift this issue found.

The `--version` a published binary prints needs no row of its own: `cliVersion`
reads the manifest of the package the running code sits in, and S9 asks the
installed binary rather than the repository's.
