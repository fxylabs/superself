# Case table — `project unlink` detaches a registered checkout path (#263)

The design artifact for #263, written before the code. Every test in
`apps/cli/test/project-unlink.test.mjs` named `U…` is one cell below.

## The spelling, and why

`self project unlink [slug] <path|--here> [--force]` — the same positional
shape, the same two write spellings and the same flag name as
`self project link [slug] [path|--here] [--force]` (#332), with the target
required rather than optional. A pair of verbs that undo each other should be
typed the same way; a second grammar (`--prune`, `--last`, a path as the first
positional) would make the inverse read as an unrelated command.

Three places where the inverse is *not* symmetric, each for a stated reason:

| `project link`                                  | `project unlink`                                    | why |
|-------------------------------------------------|------------------------------------------------------|-----|
| no path and no `--here` **reads** the link list  | no path and no `--here` is **refused**                | `self project link <slug>` is already that listing; a second verb printing it would be two spellings for one answer |
| refuses a path that does not exist               | accepts one                                            | a path that is gone is the case this verb exists for (#263) |
| `--force` = "add a repository this project does not have yet" | `--force` = "take away the last checkout it has on this machine" | in both, `--force` means "yes, change the set of repositories this project's evidence is judged across" |

## What the command resolves from outside its arguments

| Read                       | Where it comes from                                     | Cells that run it from outside that context |
|----------------------------|----------------------------------------------------------|---------------------------------------------|
| the slug, when omitted     | the `.self` marker up from cwd, else the repository — as every read verb finds it | U12 (inside the checkout), U13 (outside any project) |
| the recorded paths         | `links.jsonl`, **including paths that are gone** — `linkedPaths` filters those out, so unlink reads the raw ledger | U6 (the path was deleted) |
| the standing paths         | the recorded paths that still exist on disk — what the last-path guard counts | U4, U5, U6 |
| which path `--here` means  | the recorded path that contains cwd, deepest first        | U2 (inside it), U14 (a directory no link contains), U22 (two links contain it) |
| who else holds a path      | every slug's rows in `links.jsonl`                        | U8 (the path belongs to another project) |
| whether the repository still answers | `checkoutProject` after the write — a sibling checkout of the same repository that stayed linked | U18 |

## Rules

1. **What it removes.** `self project unlink <slug> <path>` appends one prune
   entry — `{slug, path, pruned, why}` — to `links.jsonl`, the same shape and
   the same file the automatic dead-link sweep writes (#128). The ledger is
   append-only and machine-local (git-excluded from the store), so what
   happened to the link stays legible and nothing about it is ever synced.
2. **What it does not touch.** No event enters the project log. The registry
   row — the project's own record, and the path recorded in it at registration
   — is untouched, so the project stays registered and `self project` still
   lists it. Unlinking is a machine-local link correction, not a
   de-registration and not history rewriting.
3. **The path need not exist.** A recorded path whose checkout is gone is
   exactly what #263 is about. The automatic sweep removes it too, but only on
   a workspace fold; `unlink` is the immediate, explicit form, and it is the
   only form for a path that is still on disk and should not be linked.
4. **Naming the path.** An explicit `<path>` matches a recorded path exactly,
   after `resolve` and `realPath`. `--here` matches the recorded path that
   *contains* the current directory — the same containment that makes
   `self project link <slug>` mark a row `(this directory)`, so what the
   listing marks is what `--here` detaches. Where two linked paths contain it
   — a folder of checkouts and a checkout inside it — the nearer one wins.
5. **One of a path and `--here`, and never neither.** Both together is
   refused (as in link, L20). Neither is refused too — with or without
   `--force`, which has nothing to apply to — and the refusal names
   `self project link <slug>` as the listing that answers what may be detached.
6. **The path must be this slug's.** A path no slug has recorded is refused
   naming what the slug does hold. A path recorded for a different slug is
   refused naming that slug and the exact command that detaches it there.
7. **The last standing path is refused without `--force`.** With no linked
   path left, the project resolves only from the directory a command happens to
   run in and from the path its registry row recorded at registration; a write
   from another checkout no longer finds it, and its evidence is judged
   wherever the command stands. `--force` says yes, and prints the before and
   after first, as link does. A path that is already gone is never the last
   standing path — it resolved nothing to begin with — so removing it needs no
   flag.
8. **The marker goes with the link.** `link` writes a `.self` marker at the
   path; `unlink` removes it, because a marker left behind keeps the directory
   answering for the project after its link is gone — which is the detachment
   not happening. A marker naming a *different* project is left alone, and a
   path that is gone has none to remove. The receipt says when the marker went.
9. **The verdicts are refolded.** After the ledger change the evidence head is
   dropped and the project is folded, exactly as after a link (#332), so the
   head never claims the verdicts were judged across a repository that is no
   longer linked. What that changes is the still-open verdicts and the
   repositories the health line says were asked; a verdict already `settled`
   is terminal and stays settled, which is existing behaviour this verb does
   not touch.
10. **It says what it removed and what is left.** The answer is
    `[receipt, listing]` — the receipt names the detached path, the listing is
    the same block `self project link <slug>` prints, so "what is left" is
    worded once in the CLI. Where the detached path still resolves to the
    project through a sibling checkout of its repository that stayed linked
    (issue #6 auto-resolution, which this verb does not change), a notice says
    so rather than letting the receipt imply otherwise.

## Cells

Throughout: `alpha` is registered at repository `A`; `A2` is a second worktree
of `A`'s repository; `B` is an unrelated repository; `ws` is the workspace
root; `out` is a directory outside every project.

| Cell | args | link state for slug | cwd | → printed | ledger | marker | refold |
|------|------|---------------------|-----|-----------|--------|--------|--------|
| U1  | `unlink alpha B` | A, B linked | ws | receipt `project "alpha" unlinked from B — its .self marker there is gone too`; listing shows A only, `1 linked path` | prune row for B | B's removed | yes |
| U2  | `unlink alpha --here` | A, B linked | inside B | same receipt; listing shows A and `this directory is not linked — run \`self project link alpha --here\` to link it` | prune row for B | B's removed | yes |
| U3  | `unlink alpha B` | A, B linked | inside A | receipt; listing shows `A  (this directory)` | prune row for B | B's removed | yes |
| U4  | `unlink alpha A` | A linked only | ws | refusal: `"A" is the only checkout of "alpha" on this machine … pass --force`; nothing written | unchanged | kept | no |
| U5  | `unlink alpha A --force` | A linked only | ws | notice `project "alpha" had one checkout on this machine (A); after this it has none` + receipt + listing `project "alpha" has no linked path on this machine — run \`self project link alpha --here\` from its checkout`; afterwards `self project` still lists alpha and `self status` in A still reads (as the workspace overview every directory gets), while a write there — `self work add …` — refuses `not inside a registered project` | prune row for A | A's removed | yes |
| U6  | `unlink alpha B` after `rm -rf B` | B linked and its directory deleted — the only recorded path | ws | receipt without the marker clause; listing `has no linked path on this machine`; no `--force` asked for, because a path that is gone is not a standing path | prune row for B | none to remove | yes |
| U7  | `unlink alpha C` where C is a live repository no project links | A linked | ws | refusal: `"C" is not a linked path of project "alpha", which is linked to A` | unchanged | — | no |
| U8  | `unlink alpha B` where B is linked to `beta` | A → A, beta → B | ws | refusal: `"B" is linked to project "beta", not "alpha" — run \`self project unlink beta B\`` | unchanged | B's kept | no |
| U9  | `unlink alpha` | A linked | ws | refusal: `project unlink takes the path to detach — name it, or pass --here … (\`self project link alpha\` lists what is linked)` | unchanged | — | no |
| U10 | `unlink alpha --force` | A linked | ws | the same refusal as U9 — `--force` with no path and no `--here` has nothing to apply to | unchanged | — | no |
| U11 | `unlink alpha A --here` | A linked | ws | refusal: `project unlink takes one of <path> or --here` | unchanged | — | no |
| U12 | `unlink --here` (no slug) | A, B linked | inside B | the slug is inferred from B's marker; receipt for B, listing shows A | prune row for B | B's removed | yes |
| U13 | `unlink --here` (no slug) | A linked | out | refusal: `not inside a registered project …` | unchanged | — | no |
| U14 | `unlink alpha --here` | A linked | ws | refusal: `this directory is not a linked path of "alpha" — it is linked to A; name the path to detach` | unchanged | — | no |
| U15 | `unlink ghost A` | ghost registered, nothing linked to it | ws | refusal: `"A" is not a linked path of project "ghost" — it has no linked path on this machine` | unchanged | A's kept | no |
| U15b | `unlink nosuch A` | nosuch is not registered | ws | refusal: `unknown project "nosuch" — run \`self project\` to list the registered slugs: …` | unchanged | — | no |
| U16 | `unlink alpha B` where a report's evidence hash resolves in neither repository | A, B linked | ws | the head's `asked` goes from `[alpha, beta]` to `[alpha]` (repositories are named by label there, not by path), and the health line drops from `no longer resolves in any linked repository (asked: alpha, beta)` to `no longer resolves in the project repo` | prune row for B | B's removed | yes |
| U16b | `unlink alpha B` where the hash was settled in B | A, B linked | ws | the verdict stays `settled` and no health line appears. A settled verdict is terminal by design (`updateVerdicts` never re-judges one), so detaching a repository cannot unsettle what was already verified — the refold's effect is on what is still open | prune row for B | B's removed | yes |
| U17 | the advertised remedy: after detaching worktree A2, run the `self project link alpha --here` the listing printed, in A2 | A linked, A2 just detached | inside A2 | A2 is linked again, marker rewritten, `2 linked paths` | link row for A2 | A2's rewritten | yes |
| U17b | the same remedy where the detached path was a *second repository* | A linked, B just detached | inside B | the advertised command is refused by #332's own guard — `pass --force to link it as well` — and with `--force` it round-trips. Adding a repository back is adding a repository; the listing's hint is the general one and the link refusal teaches the rest | link row for B (after --force) | B's rewritten | yes |
| U18 | `unlink alpha A` where A2 is also linked | A, A2 linked (one repository, two worktrees) | ws | receipt + listing showing A2, plus notice `A still answers for "alpha" — another checkout of its repository is linked (A2)`; `self status` in A still answers alpha | prune row for A | A's removed | yes |
| U19 | `unlink alpha P` where P's `.self` names `beta` | alpha → A, P; beta → P | ws | receipt without the marker clause; P's marker still names beta | prune row for P under alpha | kept | yes |
| U20 | `unlink alpha B` | A, B linked | out | accepted — a named slug and a named path need no project at cwd | prune row for B | B's removed | yes |
| U21 | the project record after U1 | A, B linked | ws | the store's event count and `registry.jsonl` are byte-identical before and after; only `links.jsonl` changed, and it is git-excluded | prune row for B | — | yes |
| U22 | `unlink --here` where folder F and the repository F/y inside it are both linked | A, F, F/y linked | inside F/y | the nearer link, F/y, is the one detached — F stays, and the listing marks F `(this directory)` because it still contains cwd | prune row for F/y | F/y's removed | yes |

## Review dispatch contract

- Required behaviour: rules 1–10.
- Touched production surfaces: `main.ts` (`projectUnlink` and its helpers, the
  project contract leaf, usage and detail, the `project` refusal line),
  `paths.ts` (`recordUnlink`, `recordedPaths`, `slugsLinkedAt`, `linkedPaths`),
  `docs/reference/cli.md`, `docs/reference/working-foundations.md`,
  `docs/guides/getting-started.md`.
- Supported inputs: a registered slug; an absolute or relative path on this
  machine, existing or not. Trust boundary: the machine's own filesystem and
  its links ledger.
- Exclusions: un-registering a project or removing its registry row;
  correcting the path inside the registry row; garbage-collecting worktree
  links on deletion beyond the sweep that already exists (#128); any change to
  repository-identity auto-resolution (#6).
- Stop condition: every cell has a passing test, gates green, proof transcript
  recorded.
