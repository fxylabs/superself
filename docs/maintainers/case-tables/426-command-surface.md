# Case table — the command surface a server-backed store is reached through (#426)

Every cell below is one test, named by its row id. The table is the review
surface: a row the table lacks is a path nothing proves.

Cells live in two files:

| File | What it holds |
|---|---|
| `apps/cli/test/init-mode.test.mjs` | the init flow I1–I20, the scope check G1–G7, the help H1–H2 |
| `apps/cli/test/project-create.test.mjs` | project registration against the workspace, J1–J11 |

## What this adds

A store that keeps its records on a workspace server (#422, #423) could be
read, written and synced (#425), and there was no way to make one. This is
that way, and it is not a new verb: `self init` asks which kind of store to
make, and the cloud answer runs a connect flow — log in if this machine has
not, name the workspace, write the marker, pull what the workspace holds —
inside the same run.

Beside it, the two other places the command surface met the workspace and
did not say so: `self login` asks for the workspace scopes, and `self project
init` registers the project with the workspace before it registers it here.

## Which workspace, and how it is chosen

A list (design v0.3.7, C1 v0.9.6). `GET /api/workspaces` answers the calling
account's active memberships as `{id, name, status}` — the only route outside
the workspace segment, authorized by `self.read` alone, and 404 for a Runtime
credential, which belongs to one workspace rather than to an account.

An account can be a member of several workspaces, so an id alone was something
a person had to have written down; a mistyped one used to reach the first
catch-up and come back as the contract's single concealing 404, which names
three causes and cannot say which. Now:

- **Interactive**: the memberships are listed by name and id, and the answer is
  a number on that list or an id from it.
- **Non-interactive**: `--workspace <id>` is still required — and is checked
  against the same list, so it is a flag rather than a guess. Nobody at the
  terminal and no flag is refused *before* the list is asked for: nobody could
  be shown it.
- **Closed workspaces** are on the list and marked, and refused as a choice.
  Leaving them off would answer "there is no such workspace" for one that
  exists and was closed, sending somebody to check an id that is right.
- **No memberships at all** is one sentence saying so, not an empty prompt.

## The shape of `self init`

```
--git --cloud ?  -->  refused, nothing written
        |
already a store?  -->  the answer that store already gives
        |
    which mode?   -->  the flag, or the question, or a refusal naming the flags
      /      \
    git      cloud
     |         |
  as it      log in if needed -> name the workspace -> write the store
  always      -> first catch-up -> point this machine at it
  was              \
                    any of these failing removes the store again
```

Nothing in the cloud branch touches the git-store-creation path. A store is
created by writing four files into a directory that had none, and every way
the flow can end short of finishing takes that directory back off the disk —
so a run that did not finish leaves a machine exactly as it found it.

"Every way" is three kinds, and all three are inside the rollback:

- **An exception**, from the marker, the catch-up, the exclude line or the
  machine pointer. All four are one operation, so a failure in the last of them
  removes what the first three made.
- **A signal.** Ctrl-C during the first catch-up — the longest wait the command
  has — is raced the way `login.ts` races the device wait, so the cleanup runs
  instead of the process dying on a signal number. The loser of that race is
  waited for before the removal, so no pull can put files back after it.
- **A short catch-up.** A pass that answered throughout and still did not reach
  every project is a half-filled store, and the design's rule for this flow is
  that there is no half state — so it is a refusal and the directory goes.

Outside the store, two things are undone rather than removed: the machine
pointer goes back to naming what it named (or nothing), and the local exclude
line is taken back out — but only where this run is what added it. A pointer
already naming another workspace survives an aborted flow untouched.

And the mirror of it, which is the same rule read the other way: a store this
machine did **not** make is never removed. The `existsSync` check the caller
runs is minutes old by the time the marker is written — an inline login and two
questions stand between them — so it is asked again immediately before the
write, and a directory that appeared meanwhile is a refusal rather than three
files written over it.

The one thing a failed flow is allowed to leave behind is a credential. A
login that succeeded is a login that happened: the person approved a device on
a page, and throwing that away because a later step failed would make them do
it again for no reason. Credentials are machine state, not store state.

## What decides interactivity

`personAtTerminal()` and a terminal on stdout, together — the same pair every
other question in this CLI is asked behind. An agent's runner stamps an
attempt marker on every child it starts, so a process carrying one is never
asked anything however many terminals it has.

**All four questions**, not only the two the flags name. `self init` asks which
mode, which workspace, which language and whether to tell this machine's agents
about self; the last two used to read `stdin.isTTY && stdout.isTTY` and were
therefore put to a marked process with a real terminal — which then waited on
them forever, and on the fourth of them *after* the store had been written. The
mode and the workspace are refusals naming the flag that answers them; the
language and the agents question have non-interactive defaults (`en`, no block)
and take them.

## The scope check is local

`self login` asks for seven workspace scopes beside the rail's own six:
`self.sync`, `self.read`, `self.write`, `artifact.read`, `artifact.write`,
`repo.read`, `project.manage`. The granted list is stored in the profile.

A credential older than those scopes is found here, by comparing the stored
list — never by reading a 404. The workspace API answers one indistinguishable
404 for a non-member, an out-of-scope call and a project that is not there
(C1 invariant 3), so a client that guessed "your scopes are old" from a 404
would be guessing wrong most of the time. A scope list this CLI cannot read at
all is answered the same way: what it fails to state is the scope list, and one
`self login` fixes both.

## `self project init` against a workspace

`POST /projects` first, and the local registration only on 201 — or on a 409
this machine can prove is its own. The answers are the contract's (C1 v0.9.4
§4, invariant 3a):

| Answer | What the person is told | What is left behind |
|---|---|---|
| 201 | the project is registered | a registry row carrying the server's project id |
| 409, and the slug is on `GET /projects` | the project is registered | the same row, carrying the id the workspace holds now |
| 409, and it is not | the workspace holds that name and this machine cannot reach it — ask an owner for access | nothing |
| 404 | this machine may not create it — check the connection and the account with `self login` | nothing |
| unreachable | the workspace could not be reached | nothing |
| `SUPERSELF_SYNC=off` | this machine is set not to talk to its workspace, and the workspace registers the project first | nothing, and no request |

The 409 split is the recovery for one window: a creation that answered 201 and
died before the registry row was written leaves a project this account owns and
a machine that does not know it. On the wire that retry's 409 is the same 409 a
slug another member took gets, so the list is what tells them apart. Ordinarily
the catch-up's reconciliation gets there first and the answer is the existing
`self project link <slug> --here`; this covers the case where it did not.

Adoption cannot resurrect a deleted project (P6): the id adopted is the one the
workspace holds now, so a deleted slug is not on the list at all, and a slug
deleted and made again is on it carrying the new project's id.

`SUPERSELF_SYNC=off` stands the whole sync layer down — `puller.ts` says it in
as many words — and registering a project is talking to the workspace. It is
refused rather than done anyway, after the scope check and before any request.
A git-backed store's `project init` is unaffected by the setting.

The id on the row is the same cache `pusher.ts` reads at P6, and caching it at
creation is what stops a queue re-creating a project another machine deleted.

Archive and restore are unchanged: they are `project.archived` and
`project.restored` events, folded locally and derived on the server from the
same events (C1 v0.9). A git-backed store's `project init` is unchanged.

## The rows

### `self init` — choosing and making a store

| id | case | expected |
|---|---|---|
| I1 | init, a person at the terminal, no flag | the git/cloud question is asked, and the answer chooses the branch |
| I2 | init --git | the git init that shipped, byte for byte — same files, same receipt |
| I3 | init --cloud --workspace, logged in with the workspace scopes | no login is started; marker written; the workspace's projects arrive; the store is there |
| I4 | init --cloud, this machine holds no credential | the device flow runs inline and the same run goes on to make the store |
| I5 | init, nobody at the terminal, no flag | refused, naming `--git` and `--cloud`; nothing is asked and no file is written |
| I5 | init, no flag, a terminal but a runner's attempt marker on the process | the same refusal — an agent's process is not a person, however many terminals it has |
| I6 | init --git --cloud | refused; no file is written |
| I6 | init --git --workspace | refused rather than ignored — `--workspace` names a workspace a git-backed store has none of |
| I7 | init --cloud, the inline login fails | no store, no partial files |
| I8 | init --cloud, no workspace named and nobody to ask | refused, naming `--workspace`; no store, no partial files |
| I9 | init --cloud, the first catch-up cannot reach the workspace | no store, no partial files |
| I10 | init --cloud on a second machine, naming a workspace that already holds a project | it attaches: the registry and the project's log arrive from the workspace |
| I11 | init inside a store that is already there, git-backed and server-backed, with `--git` and with `--cloud` | the answers that store already gave; nothing is created and nothing is asked |
| I12 | init --cloud with a credential granted before the workspace scopes | the local shortage answer naming `self login`; no store |
| I13 | init --cloud naming a workspace the server answers 404 for | refused, naming the account and the connection; no store |
| I14 | init --cloud, a runner's attempt marker and both ends of a terminal, no `--lang` and no `--agents` | neither question is asked; the store is made with `en` and no agent block |
| I14 | init --git, the same process | the same — the marked process is asked nothing on either branch |
| I14 | init --git, a person at the terminal | both questions are asked and both answers are used |
| I14 | init --git, piped | `en` and no agent block, as it always was |
| I15 | ctrl-c during the first catch-up | no store, and a pointer that named another workspace still names it |
| I15 | the machine pointer cannot be written, after the store and the exclude line | the store is removed and the exclude line taken back out |
| I15 | init inside a server-backed store this machine is not pointing at | named as unattached, with `self workspace <dir>` — never "attached already" |
| I16 | init --cloud, one project's delta cannot be written locally | no store — the first catch-up is the one that may not swallow a local failure |
| I16 | the first catch-up with a lease that has already gone by | refused, naming how many projects were not read |
| I16 | `GET /projects` answers 200 with a body that is not a list | treated as a catch-up that did not happen; no store |
| I17 | a store appears in the directory while the inline login is running | refused; what appeared is neither truncated nor removed |
| I17 | init --cloud --lang with a code that is not one | refused before the device flow starts; no approval is spent |
| I18 | init --cloud interactively, this account a member of two workspaces | both are listed by name and id, and a number chooses one |
| I18 | the same question answered with an id | the id chooses |
| I19 | init --cloud --workspace with an id this account is not an active member of | refused, naming the workspaces it is a member of and `self login`; no store |
| I19 | a closed workspace, chosen from the list and named with `--workspace` | shown on the list and marked closed, and refused as a choice either way |
| I20 | init --cloud interactively, this account a member of nothing | one sentence saying so; no question, no stack, no store |

### `self login` — the scopes and what is kept beside the credential

| id | case | expected |
|---|---|---|
| G1 | a fresh login | the seven workspace scopes are requested beside the rail's six, and the granted list is written into the profile |
| G2 | a credential granted before the workspace scopes | the shortage is found locally and the answer names `self login` |
| G3 | a credential whose scope list is missing, of the wrong shape, or in a file that will not parse | the same shortage answer, and no stack |
| G4 | the shortage answer | comes from the local list alone — the workspace is not asked, so no request is made at all |
| G5 | a credential file whose `default` pointer names another profile, short-scoped | the refusal names that profile and `self login --profile <name>`, and running it clears the shortage |
| G6 | `SUPERSELF_PROFILE` naming a profile the file does not hold | the login is started, and it writes that profile — not a shortage of all seven |
| G7 | a granted list written with the contract's `self.*` / `artifact.*` shorthand | no shortage — the family form covers the scopes it abbreviates |

### `self project init` — registering with the workspace

| id | case | expected |
|---|---|---|
| J1 | API mode, the workspace answers 201 | the registry row is written and carries the server's project id |
| J2 | API mode, 409 | the access-request guidance; no local project, no local files |
| J3 | API mode, 404 | the login/connection guidance; no local project, no local files |
| J4 | API mode, the workspace cannot be reached | surfaced at the command; no local project |
| J5 | git mode | unchanged — no request is made and the project is registered |
| J6 | API mode, 201, then a record | the push reaches the project the creation made (creator ACL, same transaction, server side) |
| J7 | a project another machine deleted, with records still queued | the queued push does not re-create it — the cached id is what refuses |
| J8 | an archived project | local writes are still refused |
| J9 | API mode with a credential short of the workspace scopes | the re-login answer, before any request is made |
| J10 | API mode, 409, and the slug is on this account's project list | registered here, carrying the id the workspace holds |
| J10 | API mode, 409, and the slug is not on it | the access-request guidance, unchanged |
| J11 | API mode under `SUPERSELF_SYNC=off` | refused naming the setting; no request, no row, no marker |
| J11 | git mode under the same setting | registered, unchanged |

### Help and the parser

| id | case | expected |
|---|---|---|
| H1 | `self init --help` | states `--git`, `--cloud` and `--workspace <id>`, and the parser accepts exactly those |
| H1 | the piped golden fixture | the root verb list carries the same syntax line as the contract |
| H2 | the declared surface as a whole | `checkContract` is clean: no option a page omits, no page for a leaf that is not reachable |

## What is not here

There is no shell-completion script in this repository — the completion
surface the design names is the contract-derived help, which `checkContract`
already holds to the parser. H1 and H2 are that check applied to the new
flags rather than a second list to keep in step.

There is no artificial way to reach a lease-expired first catch-up through the
command surface: the bound is `PULLER_LEASE_MS`, 180 seconds, and no staging
shortens it. I16 `short-catch-up` states the bound at the call instead, which is
the seam the module already documents (`until` is a parameter "so that a case
can state one"). The removal that follows a refusal there is I7's and I9's.

The mock server implements `GET /api/workspaces` and its 200; the contract's
"Runtime tokens get 404" is not staged, because the mock holds no token kinds
to tell apart and a mock that invented one would be asserting against itself.
