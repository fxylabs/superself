# Case table — `project link` is read-only without a path and guarded on re-link (#332)

The design artifact for #332, written before the code. Every test in
`apps/cli/test/project-link.test.mjs` named `L…` is one cell below.

## What the command resolves from outside its arguments

| Read                      | Where it comes from                                   | Cells that run it from outside that context |
|---------------------------|-------------------------------------------------------|---------------------------------------------|
| the slug, when omitted    | the `.self` marker up from cwd, else the repository the cwd is a checkout of | L7 (marker, unlinked repo), L8 (no project at all), L6 (repository only) |
| the linked paths          | `links.jsonl`                                          | L9 (slug registered, no link on this machine) |
| whether cwd is linked     | `contains(link.path, cwd)` over standing links          | L5, L6, L7 |
| the repository of a path  | `repositoryIdentity`, `checkoutTops`                    | L12 (a worktree of a linked repository), L13 (a different repository), L16 (a non-repo folder) |

## Rules

1. `project link` with no path and no `--here` writes nothing: it prints the
   slug, every standing linked path on this machine, and marks the one that
   contains cwd `(this directory)`; when none does, it says so and names the
   write form `self project link <slug> --here`.
2. A write needs an explicit `<path>` or `--here` (cwd).
3. A write that adds a repository the slug does not have yet — the path is
   not a checkout (clone or worktree, told by identity) of any already-linked
   repository, not inside a linked path, and the slug has at least one
   standing link — needs `--force`. A checkout with no commit yet claims no
   identity and links as it always did (L3); a folder that is not a
   repository stands for the repositories below it and is guarded (L16). Without it the refusal prints the
   current links and the flag. With it a notice prints the links before and
   after, then the receipt.
4. A path of an already-linked repository (another worktree) links without
   `--force`, as today. A path already linked is a no-op write with the same
   receipt. The #115 replacement (same path, the repository there changed)
   keeps its notice and needs no `--force` — it is the remedy the warning names.
5. After any change to the ledger the evidence head is removed, so the fold
   that follows (the command folds immediately) re-walks every unsettled
   verdict across the linked repositories.
6. Every hint that advertised `self project link <slug>` as the write now
   advertises `self project link <slug> --here`.

## Cells

| Cell | args                                   | link state for slug            | cwd                                        | → printed                                                        | ledger changed | refold |
|------|----------------------------------------|--------------------------------|--------------------------------------------|------------------------------------------------------------------|----------------|--------|
| L5   | none                                   | A linked                       | inside A                                   | slug, `A (this directory)`                                       | no             | no     |
| L6   | none                                   | A linked                       | A2, an unlinked worktree of A's repository | slug, A, `this directory is not linked — run … --here`           | no             | no     |
| L7   | none                                   | A linked                       | B, a different repo carrying a `.self` marker for the slug (the incident) | slug, A, not linked line | no   | no     |
| L8   | none                                   | —                              | a plain folder, no project                 | refusal: not inside a registered project                         | no             | no     |
| L9   | slug only                              | none standing on this machine  | anywhere                                   | `project "s" has no linked path on this machine — run … --here` | no             | no     |
| L10  | slug `--here` — the existing cell L1   | none                           | inside an unregistered checkout (L1–L4 shape) | receipt `linked to <cwd>`; marker written                      | yes            | yes    |
| L11  | slug path, path already linked         | A linked                       | anywhere                                   | receipt `linked to A`                                            | no             | yes (no-op fold) |
| L12  | slug path, path = A2 (worktree of A's repository) | A linked           | anywhere                                   | receipt `linked to A2`, no `--force` needed                      | yes            | yes    |
| L13  | slug path, path = B (different repository) | A linked                   | anywhere                                   | refusal: `project "s" is linked to A; B is a different repository — pass --force …`; no marker in B | no | no |
| L14  | slug path `--force`, path = B          | A linked                       | anywhere                                   | notice `project "s" was linked to A; now linked to A, B` + receipt; a B hash stored unverifiable becomes settled and its signal goes | yes | yes |
| L15  | slug path, path = B                    | none standing                  | anywhere                                   | receipt, no `--force` needed (nothing to guard)                  | yes            | yes    |
| L16  | slug path `--force`, path = F (non-repo folder holding A, B) | A linked | anywhere                                  | notice + receipt; the fold judges B's hashes through F's children | yes            | yes    |
| L17  | slug path `--force`, not needed        | none / same repository         | anywhere                                   | accepted, same receipt as without                                | yes            | yes    |
| L18  | slug `--here`, same path, repository replaced (#115) — the existing cell L4 | A linked | inside A                                 | notice `replacing the repository previously linked at A` + receipt, no `--force` | yes   | yes    |
| L19  | `--force` with no path and no `--here` | any                            | anywhere                                   | refusal: `--force applies to a write — name the path or pass --here` | no         | no     |
| L20  | `--here` and a path both given         | any                            | anywhere                                   | refusal: one of `<path>` or `--here`                             | no             | no     |
| L21  | the advertised remedy                  | A linked                       | a second checkout where `project init` refuses as a duplicate | running the printed `self project link <slug> --here` there links it | yes | yes |

## Review dispatch contract

- Required behaviour: rules 1–6.
- Touched production surfaces: `main.ts` (`projectLink`, `linkProject`,
  `inferredSlug`, the project contract leaf and usage, hint strings), `paths.ts`
  (`unregisteredMessage`, `sameRepository` warning, `dropEvidenceHead`),
  `docs/reference/cli.md`, `docs/guides/getting-started.md`.
- Supported inputs: a registered slug; a path on this machine. Trust boundary:
  the machine's own filesystem and ledger.
- Exclusions: an `unlink` verb; replacing (rather than adding) a repository.
- Stop condition: every cell has a passing test, gates green, proof transcript
  recorded.
