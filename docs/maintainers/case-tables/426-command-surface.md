# Case table — the command surface a server-backed store is reached through (#426)

Every cell below is one test, named by its row id. The table is the review
surface: a row the table lacks is a path nothing proves.

Cells live in two files:

| File | What it holds |
|---|---|
| `apps/cli/test/init-mode.test.mjs` | the init flow I1–I13, the scope check G1–G4, the help H1–H2 |
| `apps/cli/test/project-create.test.mjs` | project registration against the workspace, J1–J9 |

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

The one thing a failed flow is allowed to leave behind is a credential. A
login that succeeded is a login that happened: the person approved a device on
a page, and throwing that away because a later step failed would make them do
it again for no reason. Credentials are machine state, not store state.

## What decides interactivity

`personAtTerminal()` and a terminal on stdout, together — the same pair every
other question in this CLI is asked behind. An agent's runner stamps an
attempt marker on every child it starts, so a process carrying one is never
asked anything however many terminals it has. There are two questions —
which mode, and which workspace — and both are refusals with the flag name
in them when nobody is there to answer.

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

`POST /projects` first, and the local registration only on 201. The three
answers are the contract's (C1 v0.9.4 §4, invariant 3a):

| Answer | What the person is told | What is left behind |
|---|---|---|
| 201 | the project is registered | a registry row carrying the server's project id |
| 409 | the workspace holds that name and this machine cannot reach it — ask an owner for access | nothing |
| 404 | this machine may not create it — check the connection and the account with `self login` | nothing |
| unreachable | the workspace could not be reached | nothing |

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

### `self login` — the scopes and what is kept beside the credential

| id | case | expected |
|---|---|---|
| G1 | a fresh login | the seven workspace scopes are requested beside the rail's six, and the granted list is written into the profile |
| G2 | a credential granted before the workspace scopes | the shortage is found locally and the answer names `self login` |
| G3 | a credential whose scope list is missing, of the wrong shape, or in a file that will not parse | the same shortage answer, and no stack |
| G4 | the shortage answer | comes from the local list alone — the workspace is not asked, so no request is made at all |

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

Selecting a workspace is done by naming it. C1 v0.9.4 has no route that
enumerates the workspaces an account is a member of — every Self route is
under `/api/workspaces/{wsId}` — so the flow takes the id and confirms
membership with the one route that answers for it, `GET /projects`: 200 is a
member, 404 is the contract's single concealing answer for everything else.
An offered list needs a route that does not exist yet.
