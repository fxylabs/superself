# Case table — a directory is attached as one artifact bundle (#362)

The design artifact for #362, written before the code and reviewed on the
issue. Every test in `apps/cli/test/artifact-bundle.test.mjs` is one cell
below, named by its cell number, and asserts that cell's stated outcome. The
table is the review surface: a cell the table lacks is a path nothing proves.
Cells 51 and 52 come from review round 1; cells 53 to 59 come from review
round 2, which also amended rules 10 and 13; cell 60 comes from review
round 3, which amended rule 13 again.

## The defect

`stageArtifacts` refuses a directory — `artifact "<path>" is a directory —
pass files individually` — so a deliverable made of several files is
enumerated by hand, one `--artifact` per file. Each file mints its own `a-`
id, lands in `payload.artifacts` as a peer of the others, and renders as an
unrelated sibling in `artifact list`, in `work show`, and in the HTML views.
Nothing in the record says the files are one thing, so nothing can say which
of them a person is meant to open.

## The vocabulary

A **bundle** is one artifact whose bytes are a directory tree. Its **members**
are the regular files copied out of that tree, each named by its path relative
to the tree's root. The **manifest** is the member list carried in the event —
the machine-readable answer to what the bundle holds, readable without opening
a stored file. The **entry** is the one member a person is meant to open.

## What the verbs resolve from outside their arguments

| Read | Where it comes from | Cells that run it from outside that context |
|---|---|---|
| where `--artifact <dir>` points | `process.cwd()`, through `resolve` in `planArtifacts` — the flag takes a relative path | 47 (run from a subdirectory of the repository) |
| which project's artifacts directory takes the bytes | the owning log of the named work unit (`requireOpenWork`), never the project the cwd is in | 48 |
| which project the report records into | `process.cwd()`, through `requireProject` — `report` is a write verb and takes no read scope | 49 (outside any project) |
| what the bundle holds | the filesystem, read once at ingestion; the manifest is never re-derived from the store | 43, 44 (a member changed or removed afterwards) |
| whether the stored bytes are on this machine | `existsSync` under the store's artifacts root | 39, 44 |
| whether anybody is at a terminal | `launchFile` — a tty on both ends, and the `CI` / `SUPERSELF_SESSION` / `SUPERSELF_ATTEMPT_ID` markers | 37, 38 |
| which projects a read answers for | `activeProjects` for `list` and `search`, the whole registry for `open` | 34 |

## Rules the cells are derived from

1. **A directory `--artifact` is one artifact.** One `a-` id, one entry in
   `payload.artifacts`, one id in `refs.artifacts`. A single-file `--artifact`
   is untouched in every respect.
2. **`members` present means bundle, absent means single file.** The
   discriminator is the manifest itself, so no existing event needs a field it
   does not carry and no migration is written. `ArtifactMeta` gains
   `members?: { path: string; digest: string; generated?: true }[]` and
   `entry?: string`.
3. **Store layout mirrors the source.** The bundle lives at
   `artifacts/<slug>/<id>-<name>/`, each member at its relative path beneath
   it. The bundle root is created non-recursively, so an id already on disk
   fails with `EEXIST` and gets today's `artifact id <id> is already stored —
   run the report again`, the same guard `COPYFILE_EXCL` gives a single file.
4. **The walk copies regular files and descends directories, and nothing
   else.** Entries are read with `lstat`, so no link is followed: a symlink,
   fifo, socket or device node refuses the bundle, naming the entry — the only
   answer that neither drops a file the reporter named nor copies bytes from
   outside the tree they named. The `--artifact` argument itself is resolved
   with `stat`, so naming a link to a directory ingests that directory:
   following what the caller typed is what typing it means.
5. **A `.git` directory is skipped at any depth**, and it is the only skip. A
   repository is not a deliverable, and any wider ignore list would make the
   record's promise — the bundle is that directory — false.
6. **Member paths are relative, forward-slashed, and sorted** by their UTF-8
   bytes. Readdir order varies by filesystem, and a manifest whose order
   varied by machine could not be compared across two clones of one store.
7. **A path that cannot round-trip is refused**: invalid UTF-8, a control
   character, or a backslash. Member paths are written into a JSONL event line,
   into fold documents and into HTML hrefs, and a member nobody can follow back
   to its bytes is worse than a refused report. Everything else records
   verbatim.
8. **Two member paths that collide under case folding or under Unicode
   normalization refuse the bundle, at plan time, on every filesystem.** The
   check reads the planned paths, never what a copy happens to do: a
   case-sensitive filesystem takes `README.md` and `readme.md` happily, and the
   store is cloned to every machine the workspace syncs to, so the collision
   would land as a broken checkout on the first default macOS clone. One
   machine's filesystem may not decide what the shared store holds. Equality is
   Unicode case folding over the NFC form of each segment, because macOS writes
   decomposed names and Linux writes whatever the tool wrote — two paths that
   display alike must compare equal wherever the bundle was read. The path is
   **stored** as it was read, never normalized: a normalized path would name a
   file the machine it came from does not have.
9. **An empty bundle is refused.** A report carrying an artifact satisfies the
   completion gate (`completion.ts`), so a bundle with no bytes would close a
   work unit on evidence that does not exist.
10. **The bound is 1000 reporter-brought members or 100 MiB, whichever is
    reached first**, with no override flag: an unbounded bundle is charged to
    every future clone of the store, and the refusal says to attach a packaged
    file instead. Both are counted during planning, so a refusal needs no
    rollback. What the bound measures is what the reporter brought, so a
    directory of exactly 1000 files with no front door of its own stores 1001
    members — the generated index of rule 13 is this CLI's own line, not
    theirs, and refusing it would refuse a bundle that is inside the bound
    for a file the reporter never wrote (review round 2).
11. **Each member carries its own digest; a bundle carries no top-level
    `digest`.** `reachability.ts` already reads an absent digest as silence
    rather than a mismatch, so a bundle folded by an older CLI — which would
    otherwise call `digestFile` on a directory and get `EISDIR` — raises no
    health signal. One hash for the whole bundle is **derived** where something
    needs it, never stored: sha256 over the canonical manifest text, one
    `"<digest>  <path>\n"` line per member in path order. A stored field could
    contradict the manifest; a derived one cannot. The price, stated rather
    than discovered: an older CLI reading a synced design report that carries a
    bundle finds `artifacts[0].digest` undefined and refuses `report confirm`
    with today's `carries no artifact digest` line — the right answer from a
    CLI that cannot derive the hash, and a refusal rather than a wrong
    approval.
12. **Index precedence is total, root-only, and regular-file-only:** `--entry`,
    then `index.html`, then `index.md`, then `README.md`, then a generated
    index. Root only, because a `README.md` inside a vendored subdirectory is
    not the deliverable's front door; regular files only, so a directory named
    `index.html` is not a candidate.
13. **The generated index is `index.html` at the bundle root**, a minimal page
    listing every member the reporter brought — itself excluded, since a page
    linking to itself tells a reader nothing — stored as a member with
    `generated: true` and named by `entry`. It does count in the bundle's file
    count, which states what the store holds; `generated` is what says no
    reporter wrote it.

    Whether the name can collide is settled **by fold-equality, not by
    spelling** (review round 3). Adoption is exact — rule 12's precedence is a
    list of names — so reaching generation only says no root entry is spelled
    `index.html`. A root `INDEX.HTML`, an `index.HTML`, or a directory of any
    of those spellings still stands where the index would go, and each is
    refused at plan time by the same equality rule 8 compares two members
    under, with a refusal naming `--entry` as the way through: naming a member
    skips generation entirely.

    Refused at plan time rather than left to the copy, because the copy answers
    wrongly in both directions. On a case-insensitive filesystem it fails late
    with `artifact id <id> is already stored — run the report again`, which is
    false and which no rerun fixes, so that directory is permanently
    unattachable. On a case-sensitive one both members store, and the first
    macOS clone of the store gets a broken checkout — the harm rule 8 exists
    to prevent.
14. **`--entry` is not repeatable and requires exactly one directory
    `--artifact` in the report.** It names a member of a bundle; with a single
    file there is no member to name, and with two bundles nothing in the flag
    says which. It must resolve to a member path — not absolute, no `..`, not a
    directory.
15. **One source path may not be declared twice in one report**, and no
    declared path may be inside another declared bundle. Both spellings would
    store the same bytes under two ids and render the child as a sibling of the
    bundle that already contains it — the defect this issue removes.
16. **Rollback is the report's whole staging, on the boundary that already
    holds.** Every member of every bundle, every single file, and every
    directory this command created come back out — deepest first, only while
    empty — when the event does not reach the log.
17. **One row per artifact, everywhere.** `artifact list`, `artifact search`,
    the `work show` artifacts row, the fold document and the HTML views state a
    bundle as `<name>/ (<n> files)` and a single file exactly as they do today.
    `total` counts artifacts, never members.
18. **Search reads the manifest.** Member paths join the haystack of `artifact
    search`, and a hit on a member shows the bundle's one row: a member has no
    id of its own for a row to print.
19. **`open` resolves the entry**, launching or printing
    `<store>/artifacts/<slug>/<id>-<name>/<entry>`.
20. **A bundle's health is its members'.** `artifactFailure` reports a missing
    member and a member whose digest moved, naming the artifact id and the
    member path.

## The cells

| # | State | Operation | Expected |
|---|---|---|---|
| 1 | `dist/` with `index.html` and files in `assets/` | `report … --artifact dist` | one `a-` id; `payload.artifacts` has one entry with `members` sorted by path, forward slashes; `entry` is `index.html` |
| 2 | an empty directory | `--artifact` it | refused: the bundle holds no files; nothing staged |
| 3 | a directory holding only `.git` | `--artifact` it | refused as empty, the message saying `.git` is not copied |
| 4 | a bundle with an empty `assets/` subdirectory | ingest | `assets/` is not a member and is not created in the store; nested files keep their full relative path |
| 5 | a symlink inside the tree, target inside and target outside | ingest | refused in both arms, naming the entry; no byte copied |
| 6 | a fifo inside the tree | ingest | refused by the same rule, same message shape |
| 7 | `--artifact link-to-dist`, a symlink to a directory | ingest | ingests `dist`; members are the target's files |
| 8 | a member whose name holds a newline | ingest | refused, naming the offending path |
| 9 | a member named `보고서 v2.md` and one holding an emoji | ingest | both record verbatim; `open` on the bundle resolves |
| 10 | a member whose name is not valid UTF-8 | ingest | refused, naming the entry by its readable prefix |
| 11 | `README.md` and `readme.md` in one tree, ingested once on a case-sensitive filesystem and once on a case-insensitive one | ingest | refused at plan time in both arms, with the same message naming both members; no byte is copied, so there is nothing to roll back |
| 12 | a member with no read permission | ingest | refused before any byte is copied |
| 13 | 1001 files | ingest | refused, naming the count and the bound; store untouched |
| 14 | 1000 files totalling over 100 MiB | ingest | refused, naming the total and the bound; store untouched |
| 15 | exactly 1000 files under 100 MiB | ingest | ingests |
| 16 | root holds `index.html` and `README.md` | ingest | `entry` is `index.html` |
| 17 | root holds `index.md` and `README.md` | ingest | `entry` is `index.md` |
| 18 | root holds `README.md` only | ingest | `entry` is `README.md` |
| 19 | `index.html` exists only in a subdirectory | ingest | not adopted; a root `index.html` is generated and is the entry |
| 20 | root holds a **directory** named `index.html`, and a `README.md` | ingest | the directory is not a candidate; `entry` is `README.md` |
| 21 | no candidate at the root | ingest | a root `index.html` is generated, linking every reporter-brought member and not itself; it is a member with `generated: true`, counted in the file count |
| 22 | `docs/main.html` in the bundle | `--entry docs/main.html` | `entry` is that member; nothing is generated |
| 23 | a bundle | `--entry nope.html` | refused: not a member of the bundle |
| 24 | a bundle | `--entry ../x` and `--entry /abs/x` | refused in both arms |
| 25 | a bundle holding `docs/` | `--entry docs` | refused: an entry is a file |
| 26 | a single-file `--artifact` | `--entry x` | refused: an entry names a member of a bundle |
| 27 | two directory `--artifact`s | `--entry x` | refused: `--entry` applies to one bundle |
| 28 | `--artifact dist --artifact notes.md` | report | two artifact records, one bundle and one file; `artifact list` shows two rows |
| 29 | `--artifact dist --artifact dist` | report | refused: one path declared twice |
| 30 | `--artifact dist --artifact dist/index.html` | report | refused: a path inside a declared bundle |
| 31 | `--design --implements <id> --artifact dist` | report | allowed — one artifact; the receipt names `self report confirm <report-id>` |
| 32 | a design report carrying a bundle | `report confirm` at a terminal | the typed challenge is the derived manifest digest; the approval records it |
| 33 | a copy fails on the third member | report | no member file, no directory this command created, no event; the store is exactly as it was found |
| 34 | one bundle and one file recorded | `artifact list` at the workspace root | `dist/ (12 files)` for the bundle, today's row for the file; `total` is 2 |
| 35 | as above | `artifact search "logo.svg"`, matching only a member | the bundle's one row, never a member row |
| 36 | as above | `artifact search "dist"` | the same one row |
| 37 | a bundle | `artifact open <id>` at a terminal | opens the entry file; the receipt names `<name>/<entry>` and the id |
| 38 | a bundle, `SUPERSELF_SESSION` set | `artifact open <id>` | prints the entry file's absolute path and launches nothing |
| 39 | a bundle whose entry file is not in this store | `artifact open <id>` | refused, naming the bundle path and `self sync` |
| 40 | a bundle | `work show`, and the folded work document | both render `<id> <name>/ (12 files)`, with no digest in parentheses |
| 41 | a bundle | `self search "<member name>"` | resolves to the work unit that carries it, in today's shape |
| 42 | a bundle | the HTML work and artifact views | the card links to the entry, shows a folder plate and the file count; the link is encoded a segment at a time, so an entry named `a#b.html` is reached rather than the directory |
| 43 | a member edited in the store after ingestion | `self fold` / `self status` | one signal naming the artifact id and that member's relative path |
| 44 | a member deleted from the store | `self fold` / `self status` | one signal: missing from this store — run `self sync` |
| 45 | a bundle event, folded by a CLI that does not know `members` | fold, `list`, `open` | one row with the directory name and no file count; `open` opens the directory; no digest recorded, so no health signal |
| 46 | an existing single-file artifact event | fold, `list`, `search`, `open`, `work show` | byte-identical to today |
| 47 | cwd is a subdirectory of the repository | `report … --artifact ./dist` | `dist` resolves against the cwd; member paths are relative to `dist`, not to the repository root |
| 48 | the work unit's owning log is another project | `report … --artifact dist` | the bytes land under the owner's slug, as single files do |
| 49 | cwd is outside any project, the listing is empty | the empty listing's advertised `self report … --artifact <path>` run there | refused by `requireProject`, naming where it looked; the advertisement is unchanged |
| 50 | a report carrying only a bundle | `work done` | accepted: an artifact is completion evidence, and a bundle is one artifact |
| 51 | `café.md` written composed and `café.md` written decomposed in one tree | ingest | refused at plan time, naming both members; a bundle read on macOS and the same bundle read on Linux refuse alike |
| 52 | a synced design report carrying a bundle, read by a CLI that does not know `members` | `report confirm` there | refused with today's `carries no artifact digest` line; nothing is recorded, and the newer CLI still confirms the same report against the derived manifest digest |
| 53 | exactly 1000 files, none of them a root index candidate | ingest | ingests; `members` is 1001 and the extra one is the generated index, which the bound does not count |
| 54 | root holds a **directory** named `index.html` and no other candidate | ingest | refused at plan time, naming `--entry` as the way through; nothing staged. With `--entry` it ingests |
| 55 | a synced bundle event naming `../../../../etc/passwd` as a member | `self fold` / `self status` | one signal: recorded outside the bundle, the event cannot be trusted; the named file is neither read nor hashed |
| 56 | a synced bundle event whose `entry` climbs out of the store | `artifact open <id>` | refused as an untrusted event; nothing is launched and no path outside the store is printed |
| 57 | `--artifact dist --artifact link-to-dist`, and `--artifact link-to-dist --artifact dist/index.html` | report | refused in both arms — one directory reached by two spellings is one path, and containment reads the followed path |
| 58 | a bundle | `--entry a.html --entry b.html` | refused, naming the count: a bundle has one entry, and the second is not silently dropped |
| 59 | one bundle and one file recorded | the workspace HTML page | each row is byte-identical to the same row on the project page: the entry link, the folder plate and the file count |
| 60 | root holds `INDEX.HTML`, or a directory of that name, and no exactly-spelled candidate | ingest | refused at plan time in both arms — a generated index would be that same name once folded — naming `--entry` as the way through; with `--entry` it ingests and `INDEX.HTML` records verbatim. A root `README.MD` or `INDEX.MD`, which folds to neither the generated name nor a candidate, still ingests with a generated index |

## The guide

The user-facing answer ships in the same change, on four surfaces, examples
first and rules only where a refusal needs explaining:

- `self report --help`: the `--artifact` line says a directory attaches as one
  bundle, and a new `--entry <file>` line names the member a person is meant
  to open.
- `self artifact --help`: two lines — a bundle lists as one row,
  `<name>/ (<n> files)`, and `open` opens its entry.
- `docs/reference/cli.md`: three or four lines under work and evidence — the
  one-command attach, the index precedence in one sentence, and the
  1000-member / 100 MiB bound with the packaged-file alternative.
- `docs/guides/running-a-long-term-project.md`: one worked example —
  `--artifact dist` on a report, then the `artifact list` row and `artifact
  open` opening the entry.

Help text is output that advertises commands, so its wording is reviewed with
the cells that run what it advertises (49 among them); the guide pages carry
no cells of their own.

## Out of scope

Registering an artifact without a report; updating a stored bundle; extracting
an archive into one; serving a bundle over HTTP; redacting artifact bytes;
`review.received`'s single-artifact payload; a member addressable by an id of
its own; deduplicating bytes across bundles; ignore files governing the walk.
