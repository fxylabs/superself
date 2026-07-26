## Change workflow

- Every change intended for `main` starts with an issue, including maintainer,
  documentation, dependency, refactor, test, CI, and release work.
- Do not implement until a maintainer has added `status:accepted` and assigned
  the issue to the GitHub account that will open the pull request.
- Use a short-lived branch named
  `<type>/<issue-number>-<short-description>`, where `type` is `feat`, `fix`,
  `docs`, `refactor`, `test`, or `chore`.
- Keep work discovered inside the accepted scope on the same issue. Create a
  new issue for out-of-scope follow-up work instead of expanding the branch or
  pull request.
- The initial repository bootstrap before the first `main` commit is the only
  exception to the issue and branch requirements above.
- Sign off every commit with `git commit -s` to certify the repository DCO.

## Project verification

- Type check: `pnpm typecheck`.
- Production build: `pnpm build`.

<!-- superself:begin -->
## Project state (superself)

Project state — goals, decisions, work units, reports — is version-controlled
by the `self` CLI, outside this repository. Skip this section if the `self`
command is unavailable.

- Session start: run `self context` and treat its output as current truth.
- Substantive work attaches to a work unit: `self work add "<required outcome>"`,
  then `self work start <id>`. Report progress with `self report <id> "<summary>"`
  after committing — HEAD is attached as evidence automatically.
- Record decisions the user confirmed: `self decide "<text>" --why "<reason>"`.
  Use `--proposed` when the user has not confirmed. One decision per event.
- Blocked? `self work block <id> --on decision|dependency|external --why "..."`.
- Routing work to a specific agent or runtime? `self work assign <id> <agent>`,
  and `self work unassign <id>` when it returns to the unowned queue. List by
  owner with `self work --assignee <agent>` or `self work --unassigned`.
- Picking up existing work? `self work show <id>` prints its full brief and
  report history. Leave a brief for the next session with `self report <id> --file <path>`.
- Proposed next work, or suggested continuing in the next session, and the
  user approved? Register it with `self work add` right then, with the
  context behind the proposal — an approved plan that is never registered is lost.
- Deferring work for later? Attach a scoping brief the moment you create it:
  `self report <id> --file <path>` covering scope, design anchors, and known
  pitfalls — a bare outcome line loses the context that created the work.
- Search past state with `self search <query>`; list work with `self work`.
- Never hand-edit generated state files or anything under `.superself/`.

### Conventions

- State changes go through self events; canonical files are never hand-edited
- Record all state (events, decisions, reports, conventions) in English; conversation, artifacts, and everything the user must read follow the user's language
<!-- superself:end -->
