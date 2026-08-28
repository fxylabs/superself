# Case table — an artifact can be a URL with a kind, attached to a unit or milestone (#407)

The design artifact for #407 (part of #404, proposal 3), written before the
code. Every cell below is one test in
`apps/cli/test/artifact-url-kind.test.mjs`, named by its cell number and
asserting that cell's stated outcome. The table is the review surface: a cell
the table lacks is a path nothing proves.

Cells D20 and D21 were added by the self-adversarial pass after the code was
written, and are marked here rather than folded in silently: the first is a
verb the first table forgot had an `--artifact` flag of its own, the second a
state — an attachment whose bytes are pruned — that two shipped rules meet in.

## The defect

A work unit's plan points at things that are not files in the store: the brief
it was written from, the pull request that carries the change, a bucket name, a
decision page. Today the store has one door for any of them — `self artifact
add <path>`, which copies bytes — so a PR URL is either not recorded at all or
recorded as prose inside a report, where nothing can list it, filter it or find
it. #404 reproduced that from `superself-apps`, whose plan document carried a
links table the CLI could not see.

Three things were missing, and this issue is all three:

| Gap | What this adds |
|---|---|
| A pointer with no bytes | `artifact add <url>` records `artifact.linked` — nothing is fetched, nothing is copied |
| What kind of thing it is | `--kind brief\|pr\|resource\|doc` on either shape of artifact |
| What it belongs to | `--for <work-id\|milestone-id>`, listed by `work show` and `milestone show` |

## The vocabulary

A **link** is an artifact whose address is a URL and whose bytes are nowhere in
this store: `ArtifactMeta.url` is set and `ArtifactMeta.path` is not. The two
fields are mutually exclusive and that is the discriminator — `path` is present
exactly when the store holds bytes, which is what every byte-counting reader
already asks.

A link's **name** is its URL. `name` is the display string every surface
already prints and `url` is the address this CLI validated; the one string is
carried in both because a reader written before links (0.11.0) prints `name`
and a reader that means the target reads `url`.

An **attachment** is `--for <id>`: a work unit through `refs.work`, a milestone
through `payload.entity`. It is *not* evidence. Attachments are read from the
derived registry by the two show verbs, never folded onto the work unit, so a
brief attached to a unit can no more close it than a registration can (#238
cell 7).

A **kind** is one of four words — `brief`, `pr`, `resource`, `doc` — recorded
as `payload.kind` on both `artifact.registered` and `artifact.linked`.

## The rules the cells are derived from

1. **A value with a `<scheme>://` prefix is a link; everything else is a
   path.** One rule, applied before anything touches the filesystem. A scheme
   that is not `http` or `https` is refused by name rather than read as a path,
   because `file:///tmp/x` is a person naming a file the wrong way and a
   silent "does not exist" would not say so (A5–A9).
2. **Nothing is ever fetched.** The URL is parsed to validate it and never
   opened, not at `add`, not at `open`, not at `status`. `artifact open` on a
   link prints the address and launches nothing: the log travels between
   machines, and handing an address out of a foreign log to the OS launcher is
   exactly the trust `storedFile` already refuses to extend to a recorded path
   (D10).
3. **A link is recorded as typed.** Trimmed, never normalized. A person pastes
   back what they pasted in, so `https://example.com` does not become
   `https://example.com/` (A12).
4. **A URL carrying userinfo is refused.** The log syncs between machines;
   `https://user:pass@host/x` would put a credential in it, and the existing
   sanitizer only catches the values that *look* generated (A10, A11).
5. **The store's size answer counts stored bytes.** A link has none, so it is
   filtered out of `store size` before anything is counted: leaving it in would
   raise the distinct-contents count with every link and report an artifact
   total no byte backs (D12).
6. **Dedupe is a question about bytes.** The reuse index is keyed by digest and
   a link has none, so two links to one URL are two records, exactly as two
   copies of one file are two records that share a path (A13).
7. **`--for` resolves before a byte is written.** A refused attachment leaves
   the store exactly as it found it — no copy, no event (C5).
8. **A link is undone, not pruned.** `artifact prune` removes bytes and there
   are none, so it is refused by name and the refusal points at `self undo`
   (D11, E1). The registry drops a link whose event was annulled; a
   registration's row is *not* dropped that way, and cannot be, because its
   bytes are in the store and `store size` would report them orphaned (E3).
9. **An attachment renders on the read surface, never on the fold's canonical
   page.** `work/<id>.md` and the objective page are written by the fold from
   `WorkState`, and this change adds nothing to that model (D18).

## What a 0.11.0 CLI does with a log holding these records

Read off the fold, not asserted by hope:

| Record | 0.11.0 behaviour | Why |
|---|---|---|
| `artifact.linked` | **Ignored, never refused.** No registry row, no model change, no health line, no crash | `registry.ts` `declaredArtifacts` returns `[]` for a type it does not name, and `model.ts` has neither an exact nor a namespace reducer for it — the same silence every retired namespace folds to |
| `artifact.registered` with `payload.kind` | Listed exactly as it always was; the kind is invisible | The artifact meta inside `payload.artifacts` is unchanged, and an unknown payload key is read by nothing |
| `artifact.registered` with `refs.work` (a path attached with `--for`) | Listed with the work id in its work column, and `artifact list --work` finds it | `refs.work` is the field 0.11.0 already derives `record.work` from |

So a 0.11.0 CLI syncing a store this one wrote is correct about everything it
shows and silent about links. It never refuses, and it never crashes: no code
path in it reaches an artifact record with no `path`, because no record it
derives has one.

The reverse direction needs nothing: this CLI reads every 0.11.0 record
unchanged, since a record with no `url` is a stored artifact by rule 1.

## The cells

### A — what the input is

| # | State | Action | Expected |
|---|---|---|---|
| A1 | a plain file | `artifact add guide.md` | unchanged: one `artifact.registered`, bytes copied, an id printed |
| A2 | a directory | `artifact add docs` | unchanged: one bundle, `docs/ (2 files)` |
| A3 | `https://example.com/pr/1` | `artifact add <url>` | one `artifact.linked` carrying `{id, name, url}`; nothing under `artifacts/`, and the store's artifact bytes do not move |
| A4 | `http://example.com/x` | `artifact add <url>` | the same — http is a link, recorded as given |
| A5 | `ftp://host/x` | `artifact add <url>` | refused by name — a link is http or https; no event |
| A6 | `file:///tmp/x` | `artifact add <url>` | refused, and the refusal says to pass the path itself |
| A7 | `https://` | `artifact add <url>` | refused — a link needs a host |
| A8 | `nope.md` | `artifact add nope.md` | unchanged: `artifact "nope.md" does not exist` |
| A9 | `example.com/x` — a host with no scheme | `artifact add` | read as a path, so the does-not-exist refusal: the scheme is what makes a link |
| A10 | `https://alice:hunter2@host/x` | `artifact add <url>` | refused by name — a link carrying userinfo would sync a credential; no event |
| A11 | `https://host/x?token=ghp_<40 chars>` | `artifact add <url>` | refused by the sanitizer, naming the key path and never the value; no event |
| A12 | `https://example.com` | `artifact add <url>` | recorded as typed — no trailing slash added |
| A13 | the same URL twice | `artifact add <url>` twice | two records, two ids, both listed — a link has no bytes to share |
| A14 | a URL | `artifact add <url> --entry index.html` | refused by name — a link has no members |
| A15 | a URL and `--why "the PR"` | `artifact add <url> --why …` | the text is the record's summary and `artifact search "the PR"` finds it |

### B — `--kind`

| # | State | Action | Expected |
|---|---|---|---|
| B1 | no `--kind` | `artifact add guide.md` | admitted; no kind recorded, and the listing row is exactly today's |
| B2 | a path | `artifact add guide.md --kind brief` | `payload.kind` recorded; the listing row ends `guide.md [brief]` |
| B3 | a URL | `artifact add <url> --kind pr` | recorded on `artifact.linked` |
| B4 | a path | `--kind resource` | recorded |
| B5 | a URL | `--kind doc` | recorded |
| B6 | `--kind sketch` | `artifact add guide.md --kind sketch` | refused by name, listing the four; no event and no bytes copied |
| B7 | `--kind` passed twice | `artifact add` | refused by name, saying how many times — a single option would keep the last and drop the first without a word |

### C — `--for`

| # | State | Action | Expected |
|---|---|---|---|
| C1 | no `--for` | `artifact add guide.md` | unchanged: no `refs.work`, and the listing's work column is `-` |
| C2 | a path and a work unit | `artifact add brief.md --for <w-id>` | `refs.work` set; `artifact list --work <w-id>` shows it |
| C3 | a URL and a work unit | `artifact add <url> --for <w-id>` | the same, on `artifact.linked` |
| C4 | a milestone | `artifact add <url> --for <m-id>` | `payload.entity` set, no `refs.work`, and the listing's work column stays `-` |
| C5 | an id nothing recorded | `artifact add guide.md --for w-zzzzz` | refused, no event, and nothing copied under `artifacts/` |
| C6 | an unknown milestone id | `artifact add guide.md --for m-zzzzz` | refused, no event |
| C7 | an entity id of another kind | `artifact add guide.md --for <e-id>` | refused by name — `--for` names a work unit or a milestone |
| C8 | a work id another project holds | `artifact add guide.md --for <theirs>` | refused at the project boundary, naming the project to run it in; no event in either project |
| C9 | `--for` passed twice | `artifact add` | refused by name |
| C10 | a unit that is done | `artifact add <url> --for <w-id>` | admitted — a PR link lands after the unit closes, and an attachment is not a transition |
| C11 | a unit with an attached brief | `work done <w-id>` | still refused for want of evidence — an attachment is not a report (#238 cell 7, restated for `--for`) |

### D — what the downstream verbs do

| # | State | Action | Expected |
|---|---|---|---|
| D1 | a link | `artifact list` | one row: the URL where a name goes, the kind marked, the work column `-` |
| D2 | a link on each of two units | `artifact list --work <w-id>` | the one attached to that unit, and not the other |
| D3 | a link | `artifact search <part of the url>` | a hit |
| D4 | a path and a link on one unit | `work show <w-id>` | an "Attached artifacts" section carrying both; the unit's `- Artifacts:` evidence line is untouched |
| D5 | a link on a milestone | `milestone show <m-id>` | the section, with the kind and the URL |
| D6 | a link on a milestone | `work show` on a unit of that milestone | nothing — an attachment renders on the record it names |
| D7 | an unattached link | `work show`, `milestone show` | neither page carries it |
| D8 | four attachments, one of each kind, recorded out of order | `work show` | rows ordered brief, pr, resource, doc |
| D9 | an attachment with no kind | `work show` | its row reads `-` where a kind goes, after every kinded row |
| D10 | a link | `artifact open <id>`, with and without a terminal | the URL is printed and nothing is launched, both times |
| D11 | a link | `artifact prune <id> --why …` | refused by name — there are no bytes; the refusal names `self undo` |
| D12 | a link | `store size` | the artifact count, the distinct-contents count and the byte total are what they were before the link was recorded |
| D13 | a path artifact with a kind and a `--for` | `store size` | counted exactly as it was counted before |
| D14 | a link | `self status` | silence — a link has nothing on this machine to verify |
| D15 | a link and a rule | `convention add "…" --artifact <link-id>` | admitted: the pointer renders, `artifact open` prints the URL, and `self status` still says nothing |
| D16 | a URL | `convention add "…" --artifact <url>` | refused by name, naming `artifact add <url>` and the id it prints |
| D17 | a link on a unit in another project | `work show <w-id> --project <slug>` | the section renders, read from the project that holds the record |
| D18 | a link on a unit | the fold | `work/<id>.md` is byte-for-byte what it was — an attachment is a read-surface line, never a folded field |
| D19 | a link | `self log` | one row, carrying its `--why` exactly as a registration's row does |
| D20 | a URL | `report <id> "…" --artifact <url>` | refused by name — that flag attaches bytes — and the refusal names `artifact add <url> --for` |
| D21 | a brief attached to an open unit | `artifact prune <id>` | allowed, and the unit's attached row reads `(pruned)`. Registered bytes answer to the records that *point* at them (#239), and an attachment is a pointer, not a claim the unit is made of it — so the work-state rule that guards a report's evidence does not extend to it |

### E — the record's own life

| # | State | Action | Expected |
|---|---|---|---|
| E1 | a link | `self undo <event-id>` | taken back: gone from `artifact list`, from `artifact search` and from `work show` |
| E2 | a link taken back | `artifact open <id>` | unknown artifact — the id resolves to nothing |
| E3 | a path registration | `self undo <event-id>` | unchanged: refused by name, pointing at `artifact prune` |
| E4 | a link attached to a unit | `self undo` on that unit's `work add` | refused with the link in the dependent list |

### F — mixed version

| # | State | Action | Expected |
|---|---|---|---|
| F1 | a log line whose type this CLI does not name — the position a 0.11.0 CLI stands in against `artifact.linked` | fold, `artifact list`, `store size` | ignored: no row, no count, no crash, no refusal |
| F2 | a path registered with `--kind` and `--for` | the written event | the artifact meta inside `payload.artifacts` is unchanged and `refs.work` is the same field 0.11.0 derives `record.work` from — the kind is an added key nothing older reads |

## What this change deliberately leaves out

- **A link in the handoff packet, the HTML pages and the fold's canonical
  files.** Those are written from `WorkState`, and an attachment is not folded
  onto it (rule 9). Putting it there is a second change with a second table.
- **`--kind` as a filter on `artifact list`.** The kind is shown wherever a
  row is shown; nothing yet asks to select by it.
- **`objective show` listing a milestone's attachments.** It embeds milestone
  bodies from the fold, which carry no attachment by rule 9.
- **Changing an artifact's kind or attachment in place.** A record is corrected
  the way every other mistaken record is: `self undo`, then state it again.
- **`--for` on `report --artifact`, and a URL as evidence.** A report already
  names its unit, and its `--artifact` attaches bytes; a URL passed to it is
  refused by name and pointed at `artifact add` (D20). Whether an address can
  ever *be* evidence is a question about the completion gate, not about this.
- **`self search` finding a link.** That surface searches the folded work model,
  where an attachment deliberately does not appear (rule 9); `self artifact
  search` is the one that answers for the registry, and it finds links (D3).
- **Any fetch, HEAD request or liveness check on a URL.** A link is an address
  the log carries, and a CLI that checked one would be a CLI that talks to the
  network.
