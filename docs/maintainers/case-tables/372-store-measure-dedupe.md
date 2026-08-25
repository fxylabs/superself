# Case table — the store measures itself and stops storing the same bytes twice (#372)

The design artifact for #372, the measurement half of #239, written before the
code. Every test in `apps/cli/test/artifact-retention.test.mjs` is one cell
below, named by its cell number, and asserts that cell's stated outcome. The
table is the review surface: a cell the table lacks is a path nothing proves.

Cell numbers are the ones the #239 design gave them, so the removal half — the
`artifact prune` cells, numbered 30 to 60 there — keeps its numbering when it
lands. **Cell 9 is the one cell of this table with no test here**: it names a
withdrawn artifact, and nothing withdraws one yet.

## The defect

Measured on a real store on 2026-08-05:

| Measure | Value |
|---|---|
| Working tree | 356 MB |
| `.superself/.git` | 220 MB |
| Loose objects | 4,340 objects, 146.77 MiB |
| Packed | 67.11 MiB |
| Artifact files | 855 |
| Distinct artifact contents | 772 — so 83 files are byte-identical copies |
| Largest single file | a 15 MB `.duckdb`, present in three versions |

Four gaps produce it. Nothing reports the size, so a person learns it by
running `du`. Nothing compacts the history, which is why the loose objects
outweigh the pack more than two to one. A digest is computed at every ingest
and compared with nothing, so the same bytes store twice. And a single file has
no size bound at all, while a directory bundle has had one since #362.

## The rulings this implements

| # | Question | Decision |
|---|---|---|
| R2 | Is a duplicate refused, or stored once and referenced twice? | **Stored once, referenced twice.** Each artifact keeps its own id, name and entry; one copy of the bytes carries both records |
| R3 | Is there a size above which ingest warns or refuses? | **Over 100 MB refuses, over 10 MB warns and proceeds.** Artifacts already stored are untouched |
| R4 | Does compaction rewrite history? | **No, permanently.** `git gc -q` and nothing else |

R1 — whether bytes an evidence claim points at may be deleted — belongs to the
removal half and is not answered by any code here. Nothing in this change
deletes a stored byte.

## Rules the cells are derived from

1. **The recorded digest is always the digest of bytes the store holds.** A
   copy is digested from the copy, as it always was. A reuse re-hashes the
   stored file before adopting it, and records the value it verified. The
   source's own hash is a lookup key and is never recorded.
2. **A reuse is adopted after `assignEntry` and before any copy.** The entry —
   and, where one is generated, the whole manifest — is settled by
   `assignEntry`, so a lookup that ran earlier would hash a manifest the store
   could never hold, and a reuse adopted earlier would then be mutated by
   `assignEntry` into a record carrying an empty member digest.
3. **A reused artifact is never staged.** `copyPlanned` skips it and puts
   nothing in `staging.files` or `staging.dirs`, so a later failure in the same
   report rolls back its own copies and never another record's bytes.
4. **Reuse stops at the project boundary.** A store's projects are archived,
   restored and read separately; bytes one project's record points at inside
   another project's directory would make either of those an act on a project
   nobody named.
5. **A bundle matches by its manifest hash.** sha256 over the canonical
   manifest text — the same derivation `artifactDigest` already used. A
   generated index is a member like any other and is hashed from the text that
   would be written, so two directories of identical files under different
   names do not match: the generated index carries the directory's name.
6. **`entry` is not part of the match.** The manifest hashes members alone, so
   the same members attached under two different `--entry` flags share the
   stored path and keep an entry each.
7. **One file is bounded like a bundle:** over `MAX_BYTES` (100 MB) refused,
   over `WARN_BYTES` (10 MB) a notice and then the report proceeds. The warning
   applies to bundles at the same threshold.
8. **Compaction is `git gc -q`, once.** Not `--prune=now`, which drops the
   two-week grace unreachable objects get. Not `git repack -a -d`, whose own
   manual defines `-A` as the option that *prevents* unreachable objects in a
   previous pack from being deleted immediately. Never a history rewrite: the
   store syncs between machines by rebase, and a rewrite breaks every clone.
9. **`store size` reports orphan bytes and removes none.** A file no event
   names cannot be told apart from a file another report is staging right now,
   which is the judgment `artifact.ts` already made about sweeping.
10. **The compaction signal is said by `sync` and nowhere else.** The store's
    size is a workspace fact while `self status` answers per project, so a
    health signal would repeat one line once per project. It reads
    `git count-objects -v` and walks no tree.

## What the verbs resolve from outside their arguments

| Read | Where it comes from | Cells |
|---|---|---|
| whether these bytes are already stored | the owning project's log, keyed by digest | 2, 5 |
| whether the stored bytes are really there | the filesystem, re-hashed at ingest — never the record alone | 3, 4, 8 |
| which projects `store size` counts | the whole registry, archived projects included: their bytes are on the disk either way | 20, 28 |
| whether the history needs packing | `git count-objects -v`, git's own bookkeeping | 21, 22 |
| what `store compact` may delete | git's defaults — a two-week expiry this command never overrides | 25, 26 |

## The cells

### Reuse — one file

| # | State | Action | Expected |
|---|---|---|---|
| 1 | no record holds this digest | ingest a file | copied, new id, path of its own, digest from the copy |
| 2 | a record holds it and the stored bytes verify | ingest a file | new id, the first record's path, no second copy, digest re-derived from the stored file |
| 3 | a record holds it, the stored file is not on this machine | ingest a file | no reuse — copied to a path of its own |
| 4 | a record holds it, the stored bytes no longer match its digest | ingest a file | no reuse — copied to a path of its own |
| 5 | another project holds it | ingest a file | no reuse — the boundary is not crossed |

### Reuse — a bundle

| # | State | Action | Expected |
|---|---|---|---|
| 6 | a stored bundle whose manifest hashes the same | ingest a directory | whole bundle reused, members recorded from the stored manifest |
| 7 | one member differs | ingest a directory | manifest hash differs — copied whole |
| 8 | a matching record, one member missing from the store | ingest a directory | no reuse — copied whole |
| 9 | the matching record has been withdrawn | ingest a file | no reuse — a withdrawn record is out of the index. **Deferred: no event withdraws one yet, so the cell lands with the verb that writes it** |

### Reuse — inside one report, and what it must not break

| # | State | Action | Expected |
|---|---|---|---|
| 10 | one source declared twice in one report | ingest | the existing refusal, unchanged |
| 11 | two different files of one report holding the same bytes | ingest | the first is copied, the second shares its path, each keeps its own id |
| 12 | a report holding a reused item fails afterwards | rollback | the reused bytes are untouched; only what this report copied is removed |
| 13 | the reused artifact is a design report's | `report confirm` | the digest is the stored bytes', so the approval binds and confirms |
| 14 | identical files, differently named directories | ingest a directory | **no reuse** — the generated index carries the directory name, so the manifests differ |
| 15 | identical files, same directory name, index generated | ingest a directory | reused, generated member included, no member digest empty |
| 16 | the same members under two `--entry` flags | ingest a directory | path shared, entry per record |

### The bound on one file

| # | State | Action | Expected |
|---|---|---|---|
| 17 | over 100 MB | ingest | refused, no byte copied, no event |
| 18 | over 10 MB, up to 100 MB | ingest | one notice, then attached |
| 19 | 10 MB or under | ingest | attached, nothing said about its size |

### Measurement

| # | State | Action | Expected |
|---|---|---|---|
| 20 | a store holding no artifact | `store size` | zeros, no error |
| 28 | a file under `artifacts/<slug>/` that no record names | `store size` | counted, its bytes and path reported, **left where it is** |
| 29 | every stored file is named | `store size` | no orphan |

### Compaction

| # | State | Action | Expected |
|---|---|---|---|
| 21 | loose object size over pack size | `sync` | one line naming `self store compact` |
| 22 | loose object size at or under pack size | `sync` | nothing said |
| 23 | a repository with no commit | `store compact` | a receipt, not an error |
| 24 | git not on PATH | `store compact` | the reason in the refusal, non-zero exit |
| 25 | an unreachable object, loose | `store compact` | **kept** — git's default two-week expiry |
| 26 | an unreachable object inside a previous pack | `store compact` | **kept.** This is the state `git repack -a -d` destroys outright; the cell is the gate on rule 8 |
| 27 | the store's git index is locked | `store compact` | compacts, the repository stays consistent, and the next report records normally |

Cell 27 is run with a lock file already standing rather than by racing two
processes: the outcome the table states is about consistency under a lock, and
a real race would answer differently on different machines.

## Explicitly out of scope

Migrating the 855 artifacts already stored. Deleting anything: no `artifact
prune`, and no command that removes orphan bytes. Reuse across project
boundaries. Rewriting history. Reclaiming `.git` — compaction packs the
history and never rewrites it, so bytes an artifact left in it stay there, and
both `store size` and the compaction receipt say so.
