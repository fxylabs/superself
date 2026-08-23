# Case table — evidence resolution across every repository of a project (#331)

The design artifact for #331, written before the code. Every test in
`apps/cli/test/multi-repo-evidence.test.mjs` is one cell below, named by its
cell id, and asserts that cell's stated outcome. The table is the review
surface: a cell the table lacks is a path nothing proves.

## What the fold resolves from outside its arguments

| Read                          | Where it comes from                                             | Cells that run it from outside that context |
|-------------------------------|-----------------------------------------------------------------|---------------------------------------------|
| the linked paths of the slug  | the machine link ledger `links.jsonl` (machine-local)           | E26, E27 (nothing linked / nothing standing) |
| which repository the cwd is in | `process.cwd()` — picks the representative worktree of one repository | E13 (same cells run from repo A, repo B, and the workspace root) |
| what exists on this machine   | `existsSync` on each linked path, `rev-parse --git-dir` on it    | E21 (a linked path missing), E24 (non-repo child), E26 |
| the repository a report came from | `refs.repository` stamped by `self report`                   | E18a (recorded), E18b (legacy report, absent) |

## Rules the cells are derived from

1. `resolveProjectPaths(storeDir, slug, from)` returns one representative
   path per repository: the path `resolveProjectPath` picks today first, then
   every other standing linked path in ledger order, deduplicated by the
   repository they are a working tree of. A linked path that exists but is not
   a repository contributes its direct children that are repositories, sorted
   by name. One level only.
2. `updateVerdicts` builds one `RepositoryState` per repository and asks one
   `cat-file --batch-check` per repository (#128's bound). A hash is judged in
   the repository the report named (`refs.repository`) when that repository
   resolves it; otherwise in the first repository, in the order above, that
   resolves it.
3. `unverifiable` only when every linked repository was available to ask and
   none resolved the hash. When a linked path is missing from this machine,
   hashes no available repository resolves keep their stored verdict (or stay
   unjudged).
4. Walks run per repository only when that repository's state moved — the
   evidence head records one key per repository (keyed by repository
   identity, the root commit) beside the combined key — or when the hash has
   no verdict yet or is stored `unverifiable`. Settled stays final (#128).
5. The health line for `unverifiable` names the repositories asked when there
   is more than one: `no longer resolves in any linked repository (asked: A,
   B) — history may have been rewritten, or the repository holding it is not
   linked on this machine`. With one repository the line is byte-identical to
   today's.
6. `self report` records `refs.repository` — the identity of the repository
   the command ran in — beside `refs.branch`, when that repository has a
   commit. Where the project directory is not a repository (K3), the
   repository the command ran in is the checkout that holds the cwd: the
   default HEAD evidence, the bare-hash classification, the branch and the
   identity all read from it.

## Cells

Variables: project path kind K ∈ {K1 one link (repo A) · K2 two links (repos
A, B) · K3 one link at a non-repo folder F holding A and B · K4 nothing to
ask} × where the hash lives ∈ {A, B, nowhere} × reachability in that repo ∈
{main · other ref · dangling, branch present · dangling, branch gone} × stored
verdict ∈ {none · settled · provisional · unverifiable}.

Health column: `reset` = "was reset away on its branch"; `gone1` = today's
"no longer resolves in the project repo — history may have been rewritten";
`goneN(A,B)` = the multi-repository line of rule 5 naming A and B.

| Cell | K   | hash in | reachability                | stored        | → verdict      | health        | note |
|------|-----|---------|-----------------------------|---------------|----------------|---------------|------|
| E1   | K1  | A       | main                        | none          | settled        | —             | byte-identical to today |
| E2   | K1  | A       | other ref (branch f)        | none          | provisional    | —             | |
| E3   | K1  | A       | dangling, branch f present  | none          | abandoned      | reset         | reported from f, f reset away |
| E4   | K1  | A       | dangling, branch gone       | none          | unknown        | —             | |
| E5   | K1  | nowhere | —                           | none          | unverifiable   | gone1         | exact text unchanged |
| E6   | K1  | B (unlinked) | main in B              | none          | unverifiable   | gone1         | a repository not linked is not asked |
| E7   | K1  | A       | main                        | provisional   | settled        | —             | re-walked after the repository moved |
| E8   | K1  | A       | main                        | settled       | settled        | —             | settled is final |
| E9   | K1  | nowhere | —                           | settled       | settled        | —             | settled is never demoted |
| E10  | K1  | A       | main                        | unverifiable  | settled        | —             | object came back → walked again |
| E11  | K2  | A       | main                        | none          | settled        | —             | fold run from A |
| E12  | K2  | B       | main                        | none          | settled        | —             | fold run from A |
| E13  | K2  | A and B | main                        | none          | both settled   | —             | same fold run from B and from the workspace root: verdicts do not flip with cwd |
| E14  | K2  | B       | other ref                   | none          | provisional    | —             | |
| E15  | K2  | B       | dangling, branch present    | none          | abandoned      | reset         | branch membership read from B's refs |
| E16  | K2  | B       | dangling, branch gone       | none          | unknown        | —             | |
| E17  | K2  | nowhere | —                           | none          | unverifiable   | goneN(A,B)    | names both repositories; `self status` prints the same line from the stored head |
| E18a | K2  | A and B | dangling in A, main in B    | none          | settled        | —             | report recorded `refs.repository` = B → judged in B |
| E18b | K2  | A and B | dangling in A, main in B    | none          | unknown        | —             | legacy report, no repository recorded → first repository in order (A) |
| E19  | K2  | B       | main                        | unverifiable  | settled        | — (signal gone) | the incident: judged before B was linked |
| E20  | K2  | B       | other ref                   | provisional   | provisional    | —             | only A moved: B is not walked; evidence head keeps one key per repository |
| E21  | K2  | B       | —, B's path missing         | provisional   | provisional    | —             | not demoted: B could not be asked; hash unjudged stays unjudged |
| E22  | K2  | B       | —, B's link pruned          | provisional   | unverifiable   | gone1         | after `self fold` pruned the dead link only A is asked — one repository, so today's line |
| E23  | K3  | A / B   | main                        | none          | settled / settled | —          | repositories discovered one level below F |
| E24  | K3  | nowhere | F also holds a plain folder and a repo two levels down | none | unverifiable | goneN(A,B) | only direct children that are repositories count |
| E25  | K3  | A       | main                        | none          | settled        | —             | fold run from inside F (not a repository) |
| E26  | K4  | A       | link at non-repo folder, nothing below | provisional | provisional | —         | nothing to ask: stored verdicts pass through untouched, as today |
| E27  | K4  | A       | no standing link, registry path gone | unverifiable | unverifiable | gone1 | untouched, as today |
| E28  | K2  | —       | `self report` from A, then from B | —        | —              | —             | each event carries `refs.repository` = that repository's root commit and its branch |
| E29  | K1  | —       | `self report` in a repository with no commit | — | —          | —             | no `refs.repository` (no identity to record) |
| E30  | K2  | B       | main                        | none          | settled        | —             | `self fold` run from the workspace root, outside every repository |
| E31  | K3  | A       | `self report` from inside A with no `--evidence`, and with A's bare hash | none | settled | — | the report attaches A's HEAD, classifies A's bare hash as a commit, stamps A's branch and identity — the repository the command ran in, not the folder |

## Review dispatch contract

- Required behaviour: rules 1–6; single-repository behaviour byte-identical
  (E1–E10).
- Touched production surfaces: `reachability.ts` (`updateVerdicts`,
  `classifyAll` per repository, `verdictSignals`), `paths.ts`
  (`resolveProjectPaths`, `EvidenceHead.repositories`), `fold.ts` (passes the
  list), `main.ts` `attachEvidence` (stamps `refs.repository`), `types.ts`
  `EventRefs.repository`, `model.ts` `ReportEntry.repository`.
- Supported inputs: linked paths recorded by `self project link` / `project
  init`; repositories git can answer for. Trust boundary: the machine's own
  filesystem and the store's log; no new input crosses the sanitization gate
  except a hex identity in `refs.repository`.
- Exclusions: discovery deeper than one level; judging a hash in every
  repository that knows it; `classifyEvidence` of bare evidence still resolves
  in the repository the report runs in.
- Stop condition: every cell above has a passing test, the four repo gates are
  green, the scratch-folder proof transcript is recorded.
