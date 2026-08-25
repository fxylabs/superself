# Case table — a report's evidence is the checkout the command ran in (#235)

The design artifact for #235, written before the code. Every test in
`apps/cli/test/worktree-evidence.test.mjs` is one cell below, named by its cell
id, and asserts that cell's stated outcome. The table is the review surface: a
cell the table lacks is a path nothing proves.

## What went wrong

The `.self` marker is excluded from git (`main.ts` `excludeLocally`), so a git
worktree made **inside** a registered checkout carries no marker of its own.
`findUp` walked past that boundary and answered with the parent checkout's
marker, and every read anchored to `ctx.projectDir` followed it: the evidence
commit was the parent's HEAD and the stamped branch was the parent's branch.
Nothing warned. A worktree made *beside* the checkout was already correct,
because no marker stands above it at all.

## Rules the cells are derived from

1. **A marker governs a directory only when no other working tree of the same
   repository stands between them.** `governing(cwd, marker)` walks up from
   `cwd` to the marker's directory; when a boundary stands in between the
   marker is discarded and the repository answers instead.
2. **File checks stand in front of git.** `checkoutBetween(cwd, stop)` looks
   for a `.git` entry on that walk — a linked worktree's root holds a `.git`
   file, a repository's root a `.git` directory. With nothing found, the marker
   is returned without spawning a single git process, which is what keeps the
   ordinary command at today's cost (#128).
3. **The marker's own directory is left out of the walk.** A marker sitting
   beside a `.git` is the ordinary registered root, not a boundary — so a plain
   checkout (W1) and a worktree that carries its own marker (W17) both answer
   to their marker, and neither pays for git.
4. **`.git` found is "probably a boundary", never "certainly".** `topOf` and
   `commonDir` decide: the marker is discarded only when `cwd`'s top level does
   not contain the marker's directory **and** the two share one common git
   directory. A submodule answers `…/.git/modules/<name>` and a nested
   unrelated repository answers its own, so both keep the marker above them.
5. **Discarding the marker falls through to `checkoutProject`** — the path a
   worktree beside the checkout already took, and which maps the registered
   path to the same position inside the working tree that holds `cwd`.
6. **`relocated` is the last answer.** With the link ledger empty or pruned
   (#308) `checkoutProject` has nothing to answer from; the marker's registered
   position is then carried across to this working tree, and used only when
   that place exists and contains `cwd`.
7. **The marker before discarding is what adopts a legacy workspace.**
   `workspaceDirFor` is still handed `findUp`'s answer, not `governing`'s, or a
   worktree would read as "this machine has no workspace".
8. Resolution alone is fixed. `reportingDir`, `stampBranch`, `cmdConnect` and
   `handoffCheckoutAvailable` read `ctx.projectDir` and are not touched: they
   become correct because the value they read does.
9. **`self setup` asks the same function.** It explains the resolution to a
   person and carried its own copy of the marker-first walk, so leaving it
   alone would have made it name a directory no command works in. It calls
   `projectAt`, and says `via .self` or `via this repository` according to
   whether the directory it answered with holds a marker.

## Cells

Variables: **W** = where the command stands ∈ {parent checkout root · a
subdirectory of it · a worktree nested inside it (`<repo>/.claude/worktrees/a1`)
· a subdirectory of that worktree · a worktree beside it (`<ws>/a2`) · a nested
unrelated repository · a submodule · not a repository} × **M** = where the
project is registered ∈ {repository root · a subdirectory `apps/foo` · the
worktree itself} × **L** = the link ledger ∈ {linked · pruned} × the verb run.

| Cell | W | M | L | verb | Expected outcome |
|---|---|---|---|---|---|
| W1 | parent checkout root | root | linked | report | `projectDir` = `<repo>`; evidence = `<repo>` HEAD; branch = `<repo>`'s branch (unchanged) |
| W2 | parent checkout subdirectory (`src/`) | root | linked | report | as W1. No `.git` between `src/` and `<repo>`, so `checkoutBetween` answers `null` and no git process is added |
| W3 | **nested worktree root** | root | linked | report | `projectDir` = the worktree; evidence = **the worktree's HEAD**; branch = **the worktree's branch** |
| W4 | **nested worktree subdirectory** (`src/`) | root | linked | report | as W3 |
| W5 | worktree beside the checkout | root | linked | report | the worktree's HEAD and branch (unchanged — regression guard) |
| W6 | nested worktree at `apps/foo` | `apps/foo` | linked | report | `projectDir` = `<worktree>/apps/foo`; evidence = the worktree's HEAD. Already correct today — regression guard: no `<repo>/.self` exists, so `findUp` finds nothing and `checkoutProject` answers |
| W7 | nested worktree whose branch has no `apps/foo` | `apps/foo` | linked | report | refused, not guessed: `checkoutProject`'s mapped `<worktree>/apps/foo` does not contain `cwd`, so `contains` filters it out. `relocated` never runs — there is no marker |
| W8 | **nested worktree root** | root | **pruned** | report | `relocated` answers: `projectDir` = the worktree; evidence = the worktree's HEAD |
| W9 | nested **unrelated** repository (`<repo>/vendor/lib`) | root | linked | report | marker kept → `projectDir` = `<repo>` (unchanged; the issue rules this case separately) |
| W10 | submodule (`<repo>/sub`) | root | linked | report | as W9 — marker kept |
| W11 | a registered directory that is no repository | root | linked | report | marker kept, no commit recorded (unchanged) |
| W12 | nested worktree, detached HEAD | root | linked | report | evidence = the worktree's HEAD; no branch recorded (`currentBranch` is `null`) |
| W13 | nested worktree | root | linked | `self work` | the same project and the same records as the parent reads — project state lives outside the repository |
| W14 | nested worktree | root | linked | `self project init` | refused as another checkout of this repository (`siblingSlug`; unchanged) |
| W15 | report from the nested worktree, then `self work show` from the parent | root | linked | show | the worktree's commit under `Evidence:` and its branch under `Branches:` — the screen the issue reported changes |
| W16 | parent checkout root | root | **pruned** | report | as W1. `governing` keeps the marker, so `relocated` never runs — the ordinary path is untouched |
| W17 | **nested worktree carrying its own marker** (`self project link demo --here` run in it) | worktree root | linked | report | marker kept → `projectDir` = the worktree; evidence = its HEAD. The marker's directory is out of the walk, so no git process is added |
| W18 | report from the nested worktree, then `self work done` | root | linked | done | the evidence gate closes on the worktree's commit — the gate the issue names |
| W19 | nested worktree | root | linked | `self connect` | the managed block is written into the **worktree's** AGENTS.md/CLAUDE.md and the parent's are untouched |
| W20 | nested worktree, and the parent checkout root | root | linked | `self setup` | from the worktree the explanation names the worktree `(via this repository)`; from the parent it names `<repo>` `(via .self)` as it does today |

`checkoutBetween` is asserted directly as well, since a cell cannot count child
processes:

| Unit assertion | Input | Expected |
|---|---|---|
| nothing in between | `checkoutBetween("<repo>/src", "<repo>")` | `null` |
| `cwd` is the marker's own directory | `checkoutBetween("<repo>", "<repo>")` | `null` (no steps) |
| a nested worktree stands in between | `checkoutBetween("<repo>/.claude/worktrees/a1/src", "<repo>")` | `"<repo>/.claude/worktrees/a1"` |
| the marker is the worktree's own | `checkoutBetween("<worktree>/src", "<worktree>")` | `null` |

The three `null` rows are the evidence for "no git process is added": with
`checkoutBetween` answering `null`, `governing` returns the marker before it
ever reaches `topOf`.

## Review dispatch contract

- **Required behaviour**: a report recorded in a worktree made inside a
  registered checkout carries that worktree's HEAD as evidence and its branch
  as the stamped branch. A worktree beside the checkout and the parent checkout
  itself behave exactly as they do today.
- **Touched production surfaces**: `apps/cli/src/paths.ts` — `resolveContext`
  and the new `projectAt`, `governing`, `checkoutBetween`, `relocated` — and
  `apps/cli/src/setup.ts` `projectLines`, which held a second copy of the walk
  (W20). Two commands change behaviour without being edited: `cmdConnect`
  writes the managed block where the command stands (W19), and
  `handoffCheckoutAvailable` answers for the worktree.
- **Supported inputs**: registration at a repository root or at a
  subdirectory; worktrees inside and beside the checkout; a linked and a pruned
  ledger; a registered directory that is no repository; a detached HEAD;
  symlinked paths.
- **Trust boundary**: the local filesystem and `git`'s output. No network. No
  secret file is read.
- **Explicit exclusions**: whether a worktree should carry its own `.self`
  (the issue separates it); the evidence of submodules and nested unrelated
  repositories (the issue rules them separately); which checkout `refreshBlocks`
  writes the managed block to; the multi-repository selection rule (#331);
  writes to the link ledger.
- **Stop condition**: the 19 cells and the `checkoutBetween` unit assertions
  pass, together with `pnpm --filter superself test` and `pnpm structure`. No
  further worktree combinations are explored.
