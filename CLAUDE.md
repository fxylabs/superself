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
- A directive that arrives while you are busy goes to `self capture "<what they said>"`
  first — it records the words verbatim and returns immediately. Read it later with
  `self capture link <capture-id> --new "<required outcome>"`, or `--work <id> --as
  addition|supersession|cancellation|reprioritization|status`. Never drop a directive
  into your own notes: it is lost the moment the session ends.
- `self stream` is the one board over everything: needs you, changed, running, queued,
  captured ideas. Check it before asking the user what to do next.
- Blocked? `self work block <id> --on decision|dependency|external --why "..."`.
  Waiting on other work? `self work depend <id> --on <work-id>` — it wakes by itself.
  About to do something the user must sign off on? `self work approval <id> --why "..."`.
- Completing a unit needs a report and verification evidence: `self work done` refuses
  without them unless you state why none exists.
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
