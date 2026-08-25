# Case table — a project with no linked checkout says its verdicts are frozen (#308)

The design artifact for #308, written before the code. Every test in
`apps/cli/test/frozen-verdicts.test.mjs` is one cell below, named by its cell
id, and asserts that cell's stated outcome. The table is the review surface: a
cell the table lacks is a path nothing proves.

## What the defect was

A checkout that moves and is never re-linked leaves the project with no
standing link. `updateVerdicts` then opens no repository and returns the
stored verdicts untouched — which is right, and is #128's design: a machine
that cannot check evidence must not demote it. What was wrong is that nothing
said so. `self fold` answered `refolded <slug>`, `self status` answered
`health: ok`, and a squash-merged branch kept its row in *Unshipped by branch*
for as long as the link stayed broken.

The fix says it. It changes no verdict, writes no file, and prunes nothing
differently.

## Rules the cells are derived from

1. `verdictsFrozen(storeDir, slug)` is true when the slug has no standing
   linked path: `linkedPaths` reads the machine link ledger and asks
   `existsSync`, and calls no git process, so a read surface may ask it
   (#128). It is the same condition `updateVerdicts` returns at.
2. `frozenVerdictSignals` raises one health line, and only when the unshipped
   band is non-empty. A band that claims nothing has nothing to defend, and on
   a machine sharing a store every project not checked out here would
   otherwise raise a line.
3. `self fold`'s receipt is stricter than the health line: it names the skipped
   recomputation whenever the verdicts were frozen, band or no band, because
   what the receipt answers is what the command did. The words
   `refolded <slug>` do not appear on that path.
4. The prune notice names re-linking *wherever the checkout is now*, and says
   that until then the verdicts stay frozen. The wording it replaced —
   re-link "if it comes back" — pointed at the one action a moved project
   never takes.
5. Nothing demotes, nothing is written, and no verdict changes meaning.
   `evidence.json` and `.evidence-head.json` are byte- and mtime-identical
   across a frozen fold.

## Known mismatches, accepted

| Mismatch | Why it is accepted |
|---|---|
| A link stands but its path is no longer the repository that was linked → the verdicts freeze in fact, and no new line is raised | That path is already loud: `sameRepository` warns on stderr on every command that resolves the project (#115). Cell F12 pins both halves. |
| No link stands but a legacy registry row still carries `path` → verdicts recompute while the new line is raised | `project init` has not written `path` into the registry for some time; only an old store reaches this, and the action the line names — re-link — is right there too. |
| `viewer updated — refolded N other projects` still claims success for the sweep, and frozen projects can be among the N | Out of scope: the issue's verification names the active project's own line. |

## Cells

Variables: **L** — the slug's link ∈ {standing · pruned · standing at a path
that is no longer a repository} × **B** — the unshipped band `model.unshipped`
∈ {empty · non-empty} × surface ∈ {`self fold`'s receipt · `self status` and
`self context` health · the prune notice}. Invariant across every frozen cell:
`evidence.json` and `.evidence-head.json` do not move.

| Cell | L | B | Action | Expected |
|---|---|---|---|---|
| F1 | standing | non-empty | `self fold` | verdicts recomputed, `.evidence-head.json` written, receipt `refolded <slug>`, no frozen line |
| F2 | standing | empty | `self fold` | as F1, and no line |
| F3 | **pruned** | non-empty | `self fold` from the checkout | pages rewritten, `evidence.json` and `.evidence-head.json` unchanged in bytes and mtime, no `refolded <slug>` in the receipt, frozen line in health |
| F4 | **pruned** | empty | `self fold` from the checkout | the same receipt as F3 — the recomputation was skipped either way — while health stays quiet |
| F5 | **pruned** | non-empty | `self status` | not `health: ok`; the frozen line instead |
| F6 | **pruned** | non-empty | `self context` | the same line under Health |
| F7 | **pruned** | empty | `self status` | `health: ok` — nothing is claimed, so nothing is said |
| F8 | **pruned** | non-empty | `self status --workspace` | the health count rises on that project's row alone |
| F9 | standing | non-empty | a fold that prunes **another project's** link | one prune notice in the new words, and the active project's own `refolded <slug>` |
| F10 | pruned **by this fold** | non-empty | `self fold` | prune notice, frozen receipt and frozen health, all from one run |
| F11 | re-linked | — | `self project link <slug> --here`, then `self fold` | a squash-merged, branch-deleted commit moves `provisional` → `unknown`, a report made on the default branch reads `settled`, the band empties, health is quiet, `.evidence-head.json` is rewritten |
| F12 | standing, path is no repository | non-empty | `self fold` | the #115 warning on stderr, no frozen line, verdicts unchanged |
| F13 | **pruned**, project archived | non-empty | `self status --project <slug>` | the archived note on stderr and the frozen line in health — archiving silences neither |
| F14 | **pruned** | non-empty | `self report <work>` | the event is recorded; `evidence.json` and `.evidence-head.json` do not move |

## How the cells are built

A project is registered in a checkout, evidence is recorded against a branch,
and the checkout directory is then renamed. One `self fold` from the new path
prunes the link — that fold is cell F10 — and every later command runs from
the new path with **no** re-link, which is the issue's reproduction exactly:
the `.self` marker travelled with the directory, so every command keeps
working.

The archived note (#283) and the #115 warning are written to stderr, which
`selfIn` drops on a successful run, so F12 and F13 read both streams.
