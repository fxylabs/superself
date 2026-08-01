# Evidence bundles

An evidence bundle is one canonical JSON file that states which recorded
project state supported a claim. It is compiled from a manifest the operator
writes and reviews, over a log and a set of commits that are pinned before
anything is read, so a later reader can recheck the same claim against the same
sources instead of trusting a summary of them.

Nothing in `self evidence` writes project state. Compiling a bundle appends no
event, stages no artifact, and commits nothing to the store.

## Commands

| Command | What it does |
| --- | --- |
| `self evidence compile <manifest> [--out <name>]` | compiles the bundle the manifest selects and prints `{name, sha256, bytes}` |
| `self evidence compile <manifest> --pin [--out <name>]` | writes the same manifest with this store's log head and log hash filled in, and compiles nothing |
| `self evidence verify <bundle>` | rechecks the bundle's digest, its embedded manifest hash, its pins, and every source hash |
| `self evidence show <bundle>` | prints the pins, sources, facts and exclusions for a person |

`--out` takes a name, not a path: the bundle is written in the working
directory under the name it is known as, and an existing file is never
overwritten. `show` follows the piped-output contract — a pipe, a redirect,
`--plain`, `TERM=dumb`, or a terminal too narrow for the table all get the same
bytes an agent has always read.

## Manifest — `self.evidence.manifest@1`

```json
{
  "format": "self.evidence.manifest@1",
  "profile": "research",
  "project": "<slug>",
  "pins": {
    "self": { "head": "<event id>", "logSha256": "<64 hex>" },
    "git": [{ "repo": "<registered slug>", "commit": "<40 hex>" }]
  },
  "select": {
    "decisions": ["<event id>"],
    "work": ["<work id>"],
    "reports": ["<event id>"],
    "milestones": ["<milestone id>"],
    "commits": [{ "repo": "<registered slug>", "commit": "<40 hex>" }]
  },
  "exclude": [{ "ref": "<id>", "why": "<why it is withheld>" }]
}
```

Every source is named outright. There is no glob, no "latest", and no date
range in version 1: a selection that could resolve differently tomorrow is the
drift a bundle exists to remove. A commit is pinned at its full forty
characters, because an abbreviation is a different string for the same commit
and every check downstream is a string comparison.

`exclude` is carried into the bundle verbatim, so what was held back is visible
rather than missing. An exclusion that withholds nothing the manifest selected
refuses.

## Bundle — `self.evidence.bundle@1`

| Key | Content |
| --- | --- |
| `digest` | sha256 over the bundle's canonical bytes with `digest` set to the empty string |
| `exclusions` | the manifest's `exclude` list |
| `facts` | `{ts, type, ref, statement}` rows, sorted by `(ts, ref, type)` |
| `format` | `self.evidence.bundle@1` |
| `manifest` | `{manifestSha256, pinned}` — the pinned manifest and the hash over it |
| `pins` | the resolved self and git pins, plus the pinned log's event count |
| `profile` | the profile the sources were filtered by |
| `provenance` | the compiler contract and what it compiled from |
| `sources` | `{ref, kind, sha256, record}` rows, sorted by `(kind, ref)` |

`sources[].sha256` has one meaning: the sha256 over the canonical bytes of that
row's own `record`, and nothing else. It is not a hash of the raw log line the
record came from. That is what makes a row checkable against itself — `verify`
recomputes it from the carried record before it consults the store at all — and
it is why the same field can then be compared against the store to answer
whether the source has since moved.

### Canonical serialization

Serialization is implemented once, in `apps/cli/src/evidence/canonical.ts`:
UTF-8 with strings NFC-normalized, LF only, compact JSON with object keys sorted
by Unicode codepoint at every depth, whole numbers only, and exactly one
trailing newline. Every array carries a stated order.

No compile-time clock reaches the bytes. Time enters a bundle only as the
timestamps the sources themselves recorded, so the same pinned inputs give the
same file and the same digest on any machine.

## What `verify` guarantees

A recomputed digest is not integrity on its own. Whoever deletes a source row
can hash what is left, so `verify` reconciles the file against itself and then
against the store, and refuses on any of these:

Without the store — the checks `show` also runs before it renders, so a hollow
bundle is never displayed as evidence:

- the digest does not recompute over the bundle's own bytes;
- the embedded manifest does not hash to the recorded `manifestSha256`;
- a source row's `record` does not hash to the `sha256` that row declares — the
  direct form of tampering, caught offline;
- the carried `exclusions`, `pins`, `profile` or `provenance` differ from what
  the embedded manifest states, or the carried compiler is not the contract
  this format is produced by;
- two source rows carry the same `ref`;
- a fact names a source the bundle does not carry.

With the store and the pinned repositories:

- the log head or the log hash differs from the pin;
- a carried source no longer hashes to what the bundle records, or no longer
  resolves at all;
- the embedded manifest's selection resolves to a source the bundle carries no
  row for — this is the direction that catches a deleted row over a recomputed
  digest;
- the timeline the carried sources produce differs from the `facts` the bundle
  holds, which catches a fact removed on its own.

Together: every selector has exactly its row, every row is selected, and every
fact stands on a source that is still there. What `verify` does not treat as a
divergence is a *different* bundle — a manifest edited in step with its sources,
rehashed throughout, is a valid record of a different selection, and the digest
is what distinguishes the two.

Every divergence is collected before any is reported. Stopping at the first
would let a reader think the rest still held.

## Fail-closed behaviour

Compiling refuses, rather than compiling something quieter, when:

- a selector matches nothing, or matches more than one record, or two selectors
  resolve to the same record;
- the store's log head or log hash differs from the manifest's pin — the two
  are checked together, because a rewritten history keeps its head id while its
  bytes change;
- a pinned commit does not resolve in the named repository;
- a record carries a field the profile does not declare — a profile lists both
  the fields it publishes and the fields it deliberately drops, so an unlisted
  key is content nobody reviewed rather than an omission;
- a value is shaped like a credential, or holds an absolute filesystem location
  — a path under a real filesystem root (`/Users/…`, `/home/…`, `/private/…`,
  `/var/…`, `/tmp/…`, `/etc/…`, `/opt/…`, a `~/` path, a Windows drive or UNC
  path) or a `file://` URL, wherever it sits in the value. A repo-relative path
  such as `apps/cli/src/evidence/compile.ts`, a slashed date such as
  `2026/08/01`, and a web URL are ordinary content and compile;
- either format version is one this build does not implement.

The credential screen exempts the store's own id grammar — ULIDs and
`<type>-<ulid>` ids, including joined sequences — so evidence that cites events
by id is not mistaken for key material.

Nothing is silently scrubbed. A bundle with a hole nobody declared would read as
complete evidence, so the refusal keeps the disclosure decision with a person.

## Versioning policy

- `self.evidence.bundle@1` bumps on any change that can alter canonical bytes
  for the same inputs. `verify` refuses a version it does not implement, naming
  the version found and the versions supported.
- `self.evidence.manifest@1` bumps independently — adding range selectors, for
  instance, changes what a manifest may say without changing what a bundle is.
- A profile is named data: its allowlist and its fact derivation are versioned
  inside the profile declaration, not in the format string. `research` ships
  first.
- `provenance.compiler.version` names the compiler contract, not the CLI
  release: two builds that implement `bundle@1` must produce the same bytes for
  the same inputs, and a version that moved every release would make that claim
  untestable.
