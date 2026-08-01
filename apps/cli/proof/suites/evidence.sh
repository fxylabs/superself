#!/usr/bin/env bash
# Domain suite: evidence and decisions — commit reachability classification,
# checkout resolution from the repository, per-branch event attribution,
# decision supersession, and the event sanitization boundary.
# Runs alone: bash proof/suites/evidence.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

demo_workspace
clone_machine_b

# evidence reachability: merged settles, a live branch stays provisional,
# a discarded branch reads as abandoned, a rewritten hash as unverifiable
cd "$ROOT/A/ws/demo"
git checkout -q -b feature
echo one > merged.txt && git add . && git commit -qm "merged work"
MERGED="$(git rev-parse --short=12 HEAD)"
git checkout -q -b live
echo two > live.txt && git add . && git commit -qm "live branch work"
LIVE="$(git rev-parse --short=12 HEAD)"
git checkout -q feature
git checkout -q -b doomed
echo three > doomed.txt && git add . && git commit -qm "doomed branch work"
DOOMED="$(git rev-parse --short=12 HEAD)"
git checkout -q feature
git branch -q -D doomed
git checkout -q -b main 2>/dev/null || git checkout -q main
git merge -q --ff-only feature 2>/dev/null || git merge -q feature
WID2="$(SELF work add "classify evidence" | tail -1)"
SELF work start "$WID2"
# the vanished hash is declared: nothing in this repository resolves it, and
# only a declaration can put a value git cannot confirm into the commit refs
SELF report "$WID2" "evidence in all states" --evidence "$MERGED" --evidence "$LIVE" --evidence "$DOOMED" --evidence "commit:000000000000"
WORK2="$ROOT/A/ws/.superself/projects/demo/work/$WID2.md"
grep -q "$MERGED (settled)" "$WORK2" || fail "merged evidence not settled"
grep -q "$LIVE (provisional)" "$WORK2" || fail "live-branch evidence not provisional"
grep -q "$DOOMED (unknown)" "$WORK2" || fail "a hash handed in from elsewhere was judged instead of left unknown"
grep -q "000000000000 (unverifiable)" "$WORK2" || fail "unknown hash not unverifiable"

# a squash-merged branch, deleted as GitHub deletes it, must never read as
# abandoned: the merge rewrote the commit, so unreachable says nothing
git checkout -q -b squashed
echo squash > squashed.txt && git add . && git commit -qm "work to squash"
WSQ="$(SELF work add "squash merge classification" | tail -1)"
SELF work start "$WSQ"
SELF report "$WSQ" "done on the squash branch"
SQUASHED="$(git rev-parse --short=12 HEAD)"
git checkout -q main
git merge -q --squash squashed && git commit -qm "squash PR"
git branch -q -D squashed
SELF fold > /dev/null
WORKSQ="$ROOT/A/ws/.superself/projects/demo/work/$WSQ.md"
grep -q "$SQUASHED (unknown)" "$WORKSQ" || fail "squash-merged evidence did not read as unknown"
SELF status | grep -q "abandoned" && fail "a squash-merged branch raised an abandonment signal"

# a branch that still exists and was reset off its own commit is the one case
# that is genuinely discarded
git checkout -q -b reset-away
echo gone > gone.txt && git add . && git commit -qm "work to discard"
WRS="$(SELF work add "reset-away classification" | tail -1)"
SELF work start "$WRS"
SELF report "$WRS" "reported from the branch that will be reset"
RESET="$(git rev-parse --short=12 HEAD)"
git reset -q --hard HEAD~1
SELF fold > /dev/null
WORKRS="$ROOT/A/ws/.superself/projects/demo/work/$WRS.md"
grep -q "$RESET (abandoned)" "$WORKRS" || fail "a branch reset off its own commit did not read as abandoned"
SELF status | grep -q "was reset away on its branch" || fail "genuinely abandoned evidence raised no health signal"
git checkout -q main

# with no default branch in the checkout, nothing may be called merged
mkdir -p "$ROOT/nodefault/app"
cd "$ROOT/nodefault/app"
git init -q -b topic
echo x > x.txt && git add . && git commit -qm "only branch here"
SELF project add --name nodefault --no-connect > /dev/null
WND="$(SELF work add "no default branch" | tail -1)"
SELF work start "$WND"
SELF report "$WND" "reported with no main or master present"
grep -q "(settled)" "$ROOT/A/ws/.superself/projects/nodefault/work/$WND.md" && fail "unmerged work settled because HEAD stood in for a default branch"
cd "$ROOT/A/ws/demo"

# the unlinked machine skips the recheck and keeps the synced verdicts
cd "$ROOT/A/ws" && SELF sync
machine B
cd "$ROOT/B/ws"
rm "$ROOT/B/ws/demo/.self" "$ROOT/B/ws/.superself/links.jsonl"
SELF sync
grep -q '"'"$MERGED"'": "settled"' "$ROOT/B/ws/.superself/projects/demo/evidence.json" || fail "verdicts did not sync"
grep -q "$DOOMED (unknown)" "$ROOT/B/ws/.superself/projects/demo/work/$WID2.md" || fail "unlinked refold dropped a synced verdict"
machine A

# a worktree of a registered project works with no marker and no link: the
# repository, not a file in one working tree, says which project this is
cd "$ROOT/A/ws/demo"
git worktree add -q "$ROOT/A/ws/demo-wt" -b side-branch
cd "$ROOT/A/ws/demo-wt"
[ -f .self ] && fail "the marker leaked into a fresh worktree"
SELF context | grep -q "prove two-machine sync" || fail "a fresh worktree did not resolve its project from the repository"
SETUP_WT="$(SELF setup)"
echo "$SETUP_WT" | grep -q "^project    demo" || fail "setup did not name the project a worktree resolves to"
echo "$SETUP_WT" | grep -q "/A/ws/demo-wt (via this repository)" || fail "setup did not map the project onto this checkout"
grep -q "demo-wt" "$ROOT/A/ws/.superself/links.jsonl" && fail "resolving a checkout registered it"

# resolving is not registering: a duplicate add is still refused
ADD="$(SELF project add --name demo-copy 2>&1 || true)"
echo "$ADD" | grep -q "self project link demo" || fail "project add did not refuse the sibling checkout"
grep -q '"slug":"demo-copy"' "$ROOT/A/ws/.superself/registry.jsonl" && fail "a duplicate project was registered"

# events from the unlinked worktree attach to that worktree, not to a sibling
WIDWT="$(SELF work add "attribution from an unlinked worktree" | tail -1)"
SELF work start "$WIDWT"
SELF report "$WIDWT" "reported from an unlinked worktree"
grep -q '"branch":"side-branch"' "$LOG_A" || fail "an event from an unlinked worktree recorded another checkout's branch"
SELF convention add "worktree folds refresh the active checkout"
grep -q "worktree folds refresh the active checkout" "$ROOT/A/ws/demo-wt/CLAUDE.md" || fail "fold skipped the active checkout's block"
grep -q "worktree folds refresh the active checkout" "$ROOT/A/ws/demo/CLAUDE.md" && fail "fold wrote into a checkout it was not run from"

# linking a resolved checkout is still allowed, and stays an optimization
SELF project link
[ -f .self ] || fail "project link did not infer the slug from the repository"
SELF setup | grep -q "more checkout" || fail "setup hid the second linked checkout"
cd "$ROOT/A/ws/demo"

# a monorepo maps the registered directory into each checkout: the worktree
# root is not the project, and the deepest registered directory wins
mkdir -p "$ROOT/A/ws/mono/apps/foo/inner"
cd "$ROOT/A/ws/mono"
git init -q -b main
echo root > root.txt && echo leaf > apps/foo/inner/leaf.txt
git add . && git commit -qm "monorepo tree"
cd "$ROOT/A/ws/mono/apps/foo"
SELF project add --name foo --desc "registered below the repository root" --no-connect > /dev/null
SELF goal set "prove the mapped directory resolves"
cd "$ROOT/A/ws/mono"
git worktree add -q "$ROOT/A/ws/mono-wt" -b mono-side
cd "$ROOT/A/ws/mono-wt/apps/foo"
SELF setup | grep -q "^project    foo" || fail "the registered subdirectory did not resolve in a worktree"
SELF context | grep -q "prove the mapped directory resolves" || fail "the mapped directory resolved to no project state"
cd "$ROOT/A/ws/mono-wt/apps/foo/inner"
SELF setup | grep -q "^project    foo" || fail "a directory below the project did not resolve"
cd "$ROOT/A/ws/mono-wt"
ROOTERR="$(SELF work 2>&1 || true)"
echo "$ROOTERR" | grep -q 'registered project "foo" is at' || fail "the worktree root claimed a project registered below it"
echo "$ROOTERR" | grep -q "/A/ws/mono-wt/apps/foo" || fail "the message did not name the mapped directory in this checkout"
# a slugless link at the root of that repository has two answers and no way to
# choose between them, so it names the candidates instead of inferring one:
# linking the root to a subdirectory project would make that project claim
# every checkout of the repository on this machine
cd "$ROOT/A/ws/mono-wt"
ROOTLINK="$(SELF project link 2>&1 || true)"
echo "$ROOTLINK" | grep -q "registered projects sit below it" || fail "a slugless link at the repository root inferred a subdirectory project"
echo "$ROOTLINK" | grep -q "foo at " || fail "the refusal did not name the candidate it declined to infer"
[ -f "$ROOT/A/ws/mono-wt/.self" ] && fail "the refused link still wrote a marker at the repository root"
grep -q '"path":"'"$ROOT"'/A/ws/mono-wt"' "$ROOT/A/ws/.superself/links.jsonl" && fail "the refused link still linked the repository root"
# naming the slug is still the way to link a checkout of a project that is
# registered below the root
cd "$ROOT/A/ws/mono-wt/apps/foo"
SELF project link foo > /dev/null
[ -f .self ] || fail "a named link inside the mapped directory was refused"

cd "$ROOT/A/ws/mono"
SELF project add --name mono --desc "the repository root beside apps/foo" --no-connect > /dev/null
SELF goal set "prove the repository root is its own project"
cd "$ROOT/A/ws/mono-wt"
SELF setup | grep -q "^project    mono" || fail "the worktree root did not resolve to the root project"
cd "$ROOT/A/ws/mono-wt/apps/foo"
SELF setup | grep -q "^project    foo" || fail "the shallower project won over the directory the command ran in"
cd "$ROOT/A/ws/demo"

# a linked path is a claim about a repository, and a path outlives the checkout
# that was linked at it: a new, unrelated repository created where a linked
# checkout used to be must not answer as the project that stood there
mkdir -p "$ROOT/A/ws/replaced"
cd "$ROOT/A/ws/replaced"
git init -q -b main
echo one > one.txt && git add . && git commit -qm "the repository that was linked"
SELF project add --name replaced --desc "linked, then deleted" --no-connect > /dev/null
SELF goal set "prove a replaced checkout stops resolving" > /dev/null
grep -q '"slug":"replaced".*"repository":"' "$ROOT/A/ws/.superself/links.jsonl" \
    || fail "the link recorded no repository identity to compare against"
cd "$ROOT/A/ws"
rm -rf "$ROOT/A/ws/replaced"
mkdir -p "$ROOT/A/ws/replaced"
cd "$ROOT/A/ws/replaced"
git init -q -b main
echo two > two.txt && git add . && git commit -qm "an unrelated repository at the same path"
STALE="$(SELF work 2>&1 || true)"
echo "$STALE" | grep -q "not inside a registered project" \
    || fail "a new repository at a deleted checkout's path still resolved to the old project"
echo "$STALE" | grep -q "no longer the repository linked there" \
    || fail "the stale link was ignored without saying so"
# the same repository through another of its working trees still resolves: the
# identity is the repository's, not the path's
cd "$ROOT/A/ws/demo"
git worktree add -q "$ROOT/A/ws/demo-identity" -b identity-side
cd "$ROOT/A/ws/demo-identity"
SELF setup | grep -q "^project    demo" || fail "a worktree of the linked repository stopped resolving"
cd "$ROOT/A/ws/demo"

# events record the branch they were made on, and one work unit collects every
# branch it ran on — the relation is derived, never an asserted field
cd "$ROOT/A/ws/demo"
git checkout -q -b branch-one
WID3="$(SELF work add "one unit, two branches" | tail -1)"
SELF work start "$WID3"
SELF report "$WID3" "worked here first"
git checkout -q -b branch-two
SELF report "$WID3" "continued here"
WORK3="$ROOT/A/ws/.superself/projects/demo/work/$WID3.md"
grep -q '"branch":"branch-one"' "$LOG_A" || fail "event did not record the branch it was made on"
grep -q "Branches: branch-one, branch-two" "$WORK3" || fail "work unit did not collect both of its branches"
git checkout -q --detach
SELF report "$WID3" "detached head"
grep -q '"branch":"HEAD"' "$LOG_A" && fail "a detached HEAD was recorded as a branch name"
grep -q "Branches: branch-one, branch-two$" "$WORK3" || fail "detached HEAD added a branch to the work unit"
git checkout -q main

# a proposal never displaces a confirmed decision; confirming it does
cd "$ROOT/A/ws/demo"
SELF decide "old rule stands" --why "integrity check"
OLD_ID="$(SELF log -n 1 | sed -E 's/.*\[([^]]+)\].*/\1/')"
SELF decide "new rule replaces it" --proposed --supersedes "$OLD_ID"
PROP_ID="$(SELF log -n 1 | sed -E 's/.*\[([^]]+)\].*/\1/')"
STATE_A="$ROOT/A/ws/.superself/projects/demo/state.md"
grep -q "old rule stands" "$STATE_A" || fail "a mere proposal displaced a confirmed decision"
SELF decide confirm "$PROP_ID"
grep -q "old rule stands" "$STATE_A" && fail "confirming the proposal did not supersede the old decision"
grep -q "new rule replaces it" "$STATE_A" || fail "confirmed proposal missing from state"

# what waits is ranked by what confirming it does. A proposal names the work it
# gates, the relation inverts onto a unit that was never started, and a rule
# only reads as already in effect where the gated work landed on the default
# branch — the evidence decides that, not the fact that the unit is closed.
cd "$ROOT/A/ws/demo"
WLANDED="$(SELF work add "the work a live rule already ran under" | tail -1)"
SELF work start "$WLANDED"
SELF report "$WLANDED" "landed on the default branch" --evidence "$MERGED"
SELF work done "$WLANDED"
WGATED="$(SELF work add "waits on a decision without ever starting" | tail -1)"
WOPEN="$(SELF work add "gated work whose evidence has not merged" | tail -1)"
SELF work start "$WOPEN"
SELF report "$WOPEN" "still on a live branch" --evidence "$LIVE"
SELF decide "the rule the landed work ran under" --proposed --blocks "$WLANDED"
SELF decide "the rule the unstarted work waits for" --proposed --blocks "$WGATED"
GATE_ID="$(SELF log -n 1 | sed -E 's/.*\[([^]]+)\].*/\1/')"
SELF decide "the rule whose work has not merged" --proposed --blocks "$WOPEN"
SELF decide "a proposal that names no work at all" --proposed
SELF decide "decided only after the gate above" --proposed --after "$GATE_ID"
BAND_CONTEXT="$(SELF context)"
SELF status | grep -q "decisions waiting: 3 unblock work, 1 cannot be decided yet, 1 already in effect" \
    || fail "the attention band did not rank the proposals by what confirming them does"
echo "$BAND_CONTEXT" | grep -q "already in effect: $WLANDED landed" || fail "a proposal whose gated work landed did not read as a live rule"
echo "$BAND_CONTEXT" | grep -q "confirming unblocks $WGATED" || fail "a proposal gating unstarted work did not read as unblocking it"
echo "$BAND_CONTEXT" | grep -q "confirming unblocks $WOPEN" || fail "unmerged evidence was read as a rule already in effect"
echo "$BAND_CONTEXT" | grep -q "no work recorded as gated" || fail "a proposal naming no work was not left asking for a decision"
echo "$BAND_CONTEXT" | grep -q "cannot be decided yet: waiting on $GATE_ID" || fail "a sequenced proposal was not held behind the one it names"
SELF work | grep -q "$WGATED.*gated by $GATE_ID" || fail "refs.blocks did not invert onto a work unit that was never started"

# every id a proposal names is resolved before the event is written
BADBLOCK="$(SELF decide "gates a unit that is not there" --proposed --blocks w-nope 2>&1 || true)"
echo "$BADBLOCK" | grep -q "unknown work id" || fail "a proposal was allowed to gate a work id that does not exist"
BADAFTER="$(SELF decide "sequenced behind nothing" --proposed --after ev-nope 2>&1 || true)"
echo "$BADAFTER" | grep -q "no event matches id prefix" || fail "a proposal was allowed to sequence behind an event that does not exist"
SELF status | grep -q "decisions waiting: 3 unblock work" || fail "a refused proposal still reached the log"

# a store written before the relation existed folds unchanged: a proposal that
# names nothing is unclassified, which still asks for a decision, and is never
# read as a rule already in force
LEGACYDEC="{\"id\":\"01legacydecisioneventaaaaa\",\"ts\":\"2099-01-01T00:00:00.000Z\",\"type\":\"decision.proposed\",\"origin\":{\"actor\":\"agent\",\"confirmed\":false},\"project\":\"demo\",\"payload\":{\"text\":\"a proposal recorded before refs.blocks existed\"}}"
printf '%s\n' "$LEGACYDEC" >> "$LOG_A"
SELF fold > /dev/null
grep -qF "$LEGACYDEC" "$LOG_A" || fail "the fold rewrote a historical decision"
SELF status | grep -q "decisions waiting: 4 unblock work, 1 cannot be decided yet, 1 already in effect" \
    || fail "a decision recorded without the new refs did not fold into the group that still asks for a decision"

# closing the gated unit is not what makes its rule live — the evidence
# reaching the default branch is. The verdict keeps being rechecked while a
# proposal gates the unit, so the merge is what moves the row.
SELF work done "$WOPEN"
SELF context | grep -q "confirming unblocks $WOPEN" || fail "a unit that closed on an unmerged branch was read as a rule already in force"
git merge -q live
SELF fold > /dev/null
SELF context | grep -q "already in effect: $WOPEN landed" || fail "the gated work merging did not make its rule read as already in effect"
SELF status | grep -q "decisions waiting: 3 unblock work, 1 cannot be decided yet, 2 already in effect" \
    || fail "the band did not move the row when its gated work landed"

# a decision belongs to a work unit only when the command says so
cd "$ROOT/A/ws/demo"
SELF decide "this one came out of the work" --work "$WID3"
grep -q "DECISIONS FROM THIS WORK" "$VIEW_A/demo/$WID3.html" || fail "a linked decision did not reach the work record column"
grep -q "DECISIONS FROM THIS WORK" "$VIEW_A/demo/$WID2.html" && fail "an unlinked work unit claimed a decision"
BADWORK="$(SELF decide "points at nothing" --work w-nope 2>&1 || true)"
echo "$BADWORK" | grep -q "unknown work id" || fail "a decision was linked to a work id that does not exist"

# evidence is either a Git revision or a descriptive note. Only the revision
# is handed to git, so a checksum never reads as rewritten history while a
# commit reference that resolves to nothing still does
cd "$ROOT/A/ws/demo"
DIGEST="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
WEV="$(SELF work add "descriptive evidence stays out of git" | tail -1)"
SELF work start "$WEV"
SELF report "$WEV" "validated the export" --evidence "$MERGED" --evidence "$DIGEST" \
    --evidence "sha256 checked against the golden fixture"
WORKEV="$ROOT/A/ws/.superself/projects/demo/work/$WEV.md"
grep -q "Evidence: $MERGED (settled)" "$WORKEV" || fail "a real commit stopped resolving as evidence"
grep -q "Evidence notes:.*$DIGEST" "$WORKEV" || fail "a SHA-256 digest was not kept as a descriptive note"
grep -q "Evidence notes:.*golden fixture" "$WORKEV" || fail "free-form evidence was not kept as a descriptive note"
grep -q "\"commits\":\[\"$MERGED\"\]" "$LOG_A" || fail "descriptive evidence leaked into the commit refs"
SELF status | grep -q "$DIGEST" && fail "a checksum was reported as a missing Git commit"
SELF status | grep -q "golden fixture" && fail "a validation note was reported as a missing Git commit"
SELF status | grep -q "000000000000 no longer resolves" || fail "a vanished commit reference stopped warning"
grep -q ">note<" "$VIEW_A/demo/$WEV.html" || fail "work view did not mark descriptive evidence as a note"

# shape cannot separate a date, a build number or a ticket id from an
# abbreviated hash — all of them are hex. The repository decides instead: what
# it resolves is a revision however it is written, and what it does not is a
# note, whatever it looks like.
echo boundary > boundary.txt && git add . && git commit -qm "evidence boundaries"
BOUND="$(git rev-parse HEAD)"
UPPER="$(printf '%s' "$BOUND" | tr 'a-f' 'A-F')"
SHORT="$(git rev-parse --short=5 HEAD)"
SELF report "$WEV" "the boundaries of the evidence gate" \
    --evidence "20260727" --evidence "$UPPER" --evidence "$SHORT" --evidence "note:$LIVE"
grep -q "Evidence notes:.*20260727" "$WORKEV" || fail "a date-shaped value was treated as a Git revision"
SELF status | grep -q "20260727" && fail "a date-shaped value was reported as a missing Git commit"
# recorded as the revision git names, not the casing it was typed in: one
# spelling per object is what keeps one verdict per object
grep -qE "(Evidence: |, )$BOUND \(" "$WORKEV" || fail "an uppercase revision this repo resolves was demoted to a note"
grep -q "Evidence notes:.*$UPPER" "$WORKEV" && fail "an uppercase revision was kept as a note beside its commit"
grep -qE "(Evidence: |, )$SHORT \(" "$WORKEV" || fail "a short revision this repo resolves was demoted to a note"
grep -q "Evidence notes:.*$LIVE" "$WORKEV" || fail "note: did not keep a resolvable hash out of the commit refs"
BADFORCE="$(SELF report "$WEV" "prose declared as a commit" --evidence "commit:validated by hand" 2>&1 || true)"
echo "$BADFORCE" | grep -q "is not a Git object name" || fail "prose declared as a commit was not refused"

# a store written before evidence was classified folds as it stands: the digest
# sitting in refs.commits reads as a note, and the event itself is never touched
LEGACY="{\"id\":\"01legacyeventaaaaaaaaaaaaa\",\"ts\":\"2026-01-01T00:00:00.000Z\",\"type\":\"report.added\",\"origin\":{\"actor\":\"agent\",\"confirmed\":false},\"project\":\"demo\",\"payload\":{\"text\":\"legacy report carrying a digest in commits\"},\"refs\":{\"work\":\"$WEV\",\"commits\":[\"$DIGEST\"]}}"
printf '%s\n' "$LEGACY" >> "$LOG_A"
EVJSON="$ROOT/A/ws/.superself/projects/demo/evidence.json"
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));j[process.argv[2]]="unverifiable";fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2)+"\n")' "$EVJSON" "$DIGEST"
SELF fold > /dev/null
grep -qF "$LEGACY" "$LOG_A" || fail "the fold rewrote a historical event"
grep -q "Evidence notes:.*$DIGEST" "$WORKEV" || fail "a legacy digest in refs.commits did not fold into a note"
SELF status | grep -q "$DIGEST" && fail "a stored verdict kept a legacy digest reading as rewritten history"

# the same store, read on shape alone: a digit-only value in refs.commits is a
# date at least as often as a hash and stays a note, while an uppercase name
# git resolves is a revision
LEGACYNUM="{\"id\":\"01legacynumbereventaaaaaaa\",\"ts\":\"2026-01-01T00:00:01.000Z\",\"type\":\"report.added\",\"origin\":{\"actor\":\"agent\",\"confirmed\":false},\"project\":\"demo\",\"payload\":{\"text\":\"legacy report carrying a build number in commits\"},\"refs\":{\"work\":\"$WEV\",\"commits\":[\"20250101\",\"$UPPER\"]}}"
printf '%s\n' "$LEGACYNUM" >> "$LOG_A"
SELF fold > /dev/null
grep -q "Evidence notes:.*20250101" "$WORKEV" || fail "a legacy digit-only value was still handed to git"
SELF status | grep -q "20250101" && fail "a legacy build number was reported as a missing Git commit"
grep -qE "(Evidence: |, )$UPPER \(" "$WORKEV" || fail "a legacy uppercase revision git resolves was demoted to a note"

# a report that recorded its evidence as typed is taken at its word, so the
# reader never re-guesses a shape the repository has already answered
TYPED="{\"id\":\"01typedrevisioneventaaaaaa\",\"ts\":\"2026-01-01T00:00:02.000Z\",\"type\":\"report.added\",\"origin\":{\"actor\":\"agent\",\"confirmed\":false},\"project\":\"demo\",\"payload\":{\"text\":\"typed report carrying a digit-only revision\",\"evidenceTyped\":true},\"refs\":{\"work\":\"$WEV\",\"commits\":[\"20261231\"]}}"
printf '%s\n' "$TYPED" >> "$LOG_A"
SELF fold > /dev/null
grep -qE "(Evidence: |, )20261231 \(" "$WORKEV" || fail "a typed revision was re-guessed by its shape"
SELF status | grep -q "20261231 no longer resolves" || fail "a typed revision that resolves to nothing stopped warning"

# ── what has not shipped, per branch ─────────────────────────────────────
# A branch carries a work unit while some commit reported from it is not
# settled, and the branch each report was written from is what attributes the
# evidence. The statement is read in its own project, against a repository
# nothing else in this suite has merged, reset or squashed.
mkdir -p "$ROOT/shipping/app"
cd "$ROOT/shipping/app"
git init -q -b main
SELF project add --name shipping --desc "per-branch shipping state" --no-connect > /dev/null
SELF goal set "prove what has not shipped per branch" > /dev/null
SELF status | grep -q "^unshipped: nothing waiting to ship$" \
    || fail "a project with no evidence at all did not say so on the one-line statement"
echo base > base.txt && git add . && git commit -qm "base on main"
WSETTLED="$(SELF work add "settles on the default branch and closes" | tail -1)"
SELF work start "$WSETTLED" > /dev/null
SELF report "$WSETTLED" "reported from main" > /dev/null
SELF work done "$WSETTLED" > /dev/null
WBOTH="$(SELF work add "settled on main, still moving on a branch" | tail -1)"
SELF work start "$WBOTH" > /dev/null
SELF report "$WBOTH" "reported from main" > /dev/null
git checkout -q -b feature-a
echo a > a.txt && git add . && git commit -qm "feature-a work"
SELF report "$WBOTH" "continued on feature-a" > /dev/null
WCLOSED="$(SELF work add "closed on a branch nobody merged" | tail -1)"
SELF work start "$WCLOSED" > /dev/null
SELF report "$WCLOSED" "reported from feature-a" > /dev/null
SELF work done "$WCLOSED" > /dev/null
git checkout -q -b feature-b
echo b > b.txt && git add . && git commit -qm "feature-b work"
WSECOND="$(SELF work add "reported from a second branch" | tail -1)"
SELF work start "$WSECOND" > /dev/null
SELF report "$WSECOND" "reported from feature-b" > /dev/null
# A detached HEAD records no branch, and neither did any event written before
# events carried one. Both group under a single honest line and neither is
# charged to a branch somebody could check out.
git checkout -q --detach
echo d > d.txt && git add . && git commit -qm "work from a detached HEAD"
DETACHED="$(git rev-parse --short=12 HEAD)"
WDETACHED="$(SELF work add "reported from a detached HEAD" | tail -1)"
SELF work start "$WDETACHED" > /dev/null
SELF report "$WDETACHED" "no branch on this event" > /dev/null
git checkout -q main
WLEGACY="$(SELF work add "recorded before events carried a branch" | tail -1)"
SELF work start "$WLEGACY" > /dev/null
SHIP_LOG="$ROOT/A/ws/.superself/projects/shipping/log.jsonl"
LEGACYSHIP="{\"id\":\"01legacyshippingeventaaaaa\",\"ts\":\"2026-01-01T00:00:00.000Z\",\"type\":\"report.added\",\"origin\":{\"actor\":\"agent\",\"confirmed\":false},\"project\":\"shipping\",\"payload\":{\"text\":\"a report written before events carried a branch\"},\"refs\":{\"work\":\"$WLEGACY\",\"commits\":[\"$DETACHED\"]}}"
printf '%s\n' "$LEGACYSHIP" >> "$SHIP_LOG"
SELF fold > /dev/null
grep -qF "$LEGACYSHIP" "$SHIP_LOG" || fail "the fold rewrote a historical report"

SHIP_STATUS="$(SELF status)"
echo "$SHIP_STATUS" | grep -q "^unshipped: feature-a 1 open work unit, feature-b 1 open work unit, (branch not recorded) 2 open work units$" \
    || fail "self status did not state what has not shipped, per branch, named branches first"
SHIP_CONTEXT="$(SELF context)"
SHIP_SECTION="$(echo "$SHIP_CONTEXT" | awk '/^## Unshipped by branch$/ { found = 1; next } /^## / { found = 0 } found')"
[ -n "$SHIP_SECTION" ] || fail "the per-branch statement did not reach self context"
FEATURE_A="$(echo "$SHIP_SECTION" | grep '^- feature-a — ')"
echo "$FEATURE_A" | grep -q "1 open work unit unshipped" || fail "the feature-a line did not count the units it carries"
echo "$FEATURE_A" | grep -q "$WBOTH" || fail "a unit whose evidence on a branch is unsettled was left off that branch"
echo "$FEATURE_A" | grep -q "$WCLOSED" \
    && fail "a closed unit, whose verdicts nothing rechecks, was stated as unshipped"
echo "$SHIP_SECTION" | grep -q "^- (branch not recorded) — 2 open work units unshipped" \
    || fail "evidence whose event carried no branch was not grouped under one unrecorded line"
echo "$SHIP_SECTION" | grep -q "$WDETACHED" || fail "a report from a detached HEAD was not grouped as branch-unknown"
echo "$SHIP_SECTION" | grep -q "$WLEGACY" || fail "a legacy report with no branch ref was not grouped as branch-unknown"
echo "$SHIP_SECTION" | grep -q "^- main —" && fail "a branch whose every commit settled was reported as carrying unshipped work"
echo "$SHIP_SECTION" | grep -q "$WSETTLED" && fail "a done unit whose evidence all settled was reported as unshipped"
# Same store, same bytes: nothing here reads the clock or the checkout.
[ "$(SELF context)" = "$SHIP_CONTEXT" ] || fail "the per-branch statement is not deterministic"

SELF work show "$WBOTH" | grep -q "Unshipped commits by branch: feature-a — 1 of 1 unsettled" \
    || fail "self work show did not state which branch still carries this unit's evidence"
SELF work show "$WBOTH" | grep "Unshipped commits by branch" | grep -q "main" \
    && fail "self work show charged a settled commit to the branch it was reported from"
SELF work show "$WDETACHED" | grep -q "Unshipped commits by branch: (branch not recorded) — 1 of 1 unsettled" \
    || fail "self work show did not name the unrecorded branch for a detached-HEAD report"
SELF work show "$WSETTLED" | grep -q "Unshipped commits by branch" \
    && fail "a unit with nothing unsettled still carried an unshipped line"
SELF work show "$WCLOSED" | grep -q "Unshipped commits by branch" \
    && fail "a closed unit carried an unshipped line in its own body"

# The statement follows the evidence: once the commits reported from a branch
# settle, the branch has nothing left to state and its line goes.
git merge -q feature-a
SELF fold > /dev/null
SELF status | grep -q "^unshipped: feature-b 1 open work unit, (branch not recorded) 2 open work units$" \
    || fail "merging a branch did not take what it carried off the unshipped statement"
# Deleting the branch changes nothing: nothing here asks git which branches
# still exist, so a branch that was merged and pruned still says what was
# reported on it.
git branch -q -D feature-b
SELF fold > /dev/null
SELF context | awk '/^## Unshipped by branch$/ { found = 1; next } /^## / { found = 0 } found' | grep -q "^- feature-b — 1 open work unit unshipped" \
    || fail "a branch this checkout no longer has stopped stating what was reported on it"

# ── closing a unit before or after its branch merged reads the same ───────
# A closed unit's verdicts stop being recomputed, so a statement that spoke
# for one would freeze whatever was true the day it closed: the unit below
# that closed while feature-c was unmerged would claim that branch for good,
# long after the merge, and no action would clear it. Each unit reports its
# own commit, so neither borrows the other's verdict and the asymmetry is
# visible if it exists.
git checkout -q -b feature-c
echo c1 > c1.txt && git add . && git commit -qm "reported, then closed before the merge"
WBEFORE="$(SELF work add "closed while its branch was unmerged" | tail -1)"
SELF work start "$WBEFORE" > /dev/null
SELF report "$WBEFORE" "reported from feature-c" > /dev/null
SELF work done "$WBEFORE" > /dev/null
echo c2 > c2.txt && git add . && git commit -qm "reported, then closed after the merge"
WAFTER="$(SELF work add "closed once its branch had merged" | tail -1)"
SELF work start "$WAFTER" > /dev/null
SELF report "$WAFTER" "reported from feature-c" > /dev/null
git checkout -q main
git merge -q feature-c
SELF fold > /dev/null
SELF work done "$WAFTER" > /dev/null
SHIP_CLOSED="$(SELF context | awk '/^## Unshipped by branch$/ { found = 1; next } /^## / { found = 0 } found')"
echo "$SHIP_CLOSED" | grep -q "$WBEFORE" \
    && fail "a unit closed before its branch merged still claimed that branch, on a verdict no fold rechecks"
echo "$SHIP_CLOSED" | grep -q "$WAFTER" \
    && fail "a unit closed after its branch merged was stated as unshipped"
echo "$SHIP_CLOSED" | grep -q "^- feature-c —" \
    && fail "a branch carrying nothing but closed work still had a line"

# ── retired work says outright that it will not be delivered here ─────────
# It leaves the statement the same way it leaves `self work`, and the branch
# it was reported from keeps counting the unit still open on it.
git checkout -q -b feature-d
echo d1 > d1.txt && git add . && git commit -qm "still moving on feature-d"
WKEEP="$(SELF work add "still open on feature-d" | tail -1)"
SELF work start "$WKEEP" > /dev/null
SELF report "$WKEEP" "reported from feature-d" > /dev/null
echo d2 > d2.txt && git add . && git commit -qm "a direction that was retired"
WRETIRED="$(SELF work add "retired on feature-d" | tail -1)"
SELF work start "$WRETIRED" > /dev/null
SELF report "$WRETIRED" "reported from feature-d" > /dev/null
SELF work retire "$WRETIRED" --why "the direction moved to another unit" > /dev/null
git checkout -q main
SELF fold > /dev/null
FEATURE_D="$(SELF context | awk '/^## Unshipped by branch$/ { found = 1; next } /^## / { found = 0 } found' | grep '^- feature-d — ')"
echo "$FEATURE_D" | grep -q "$WKEEP" || fail "the unit still open on feature-d left the statement"
echo "$FEATURE_D" | grep -q "1 open work unit unshipped" \
    || fail "the feature-d line counted retired work among what the branch is carrying"
echo "$FEATURE_D" | grep -q "$WRETIRED" \
    && fail "retired work, which states it will not be delivered here, was stated as unshipped"
SELF work show "$WRETIRED" | grep -q "Unshipped commits by branch" \
    && fail "a retired unit carried an unshipped line in its own body"

# ── the order of these lines is the store's bytes, not the environment ────
# `localeCompare` builds its collator from LC_ALL and LANG, so one store
# folded on two machines — or on one machine whose environment changed — would
# order the lines differently and the canonical files would differ by nothing
# but who ran the fold. These two names are ordered one way by every locale
# ICU knows and the other way by UTF-8 bytes. Nothing here touches git: the
# recorded event is the fixture, not a ref a filesystem might normalize.
mkdir -p "$ROOT/collation/app"
cd "$ROOT/collation/app"
git init -q -b main
SELF project add --name collation --desc "ordering that no locale can move" --no-connect > /dev/null
SELF goal set "prove the statement orders by bytes" > /dev/null
echo base > base.txt && git add . && git commit -qm "base on main"
COLLATION_LOG="$ROOT/A/ws/.superself/projects/collation/log.jsonl"
COLLATION_STATE="$ROOT/A/ws/.superself/projects/collation"
printf '{"id":"01collationcreatedzaaaaaa","ts":"2026-02-01T00:00:01.000Z","type":"work.created","origin":{"actor":"agent","confirmed":false},"project":"collation","payload":{"work":"w-colz1","outcome":"held on a branch whose name starts with z"}}\n' >> "$COLLATION_LOG"
printf '{"id":"01collationstartedzaaaaaa","ts":"2026-02-01T00:00:02.000Z","type":"work.started","origin":{"actor":"agent","confirmed":false},"project":"collation","payload":{"work":"w-colz1"}}\n' >> "$COLLATION_LOG"
printf '{"id":"01collationreportzaaaaaaa","ts":"2026-02-01T00:00:03.000Z","type":"report.added","origin":{"actor":"agent","confirmed":false},"project":"collation","payload":{"text":"never merged"},"refs":{"work":"w-colz1","commits":["cccccccccc01"],"branch":"feat/z-collate"}}\n' >> "$COLLATION_LOG"
printf '{"id":"01collationcreateduaaaaaa","ts":"2026-02-01T00:00:04.000Z","type":"work.created","origin":{"actor":"agent","confirmed":false},"project":"collation","payload":{"work":"w-colu1","outcome":"held on a branch whose name starts with a diaeresis"}}\n' >> "$COLLATION_LOG"
printf '{"id":"01collationstarteduaaaaaa","ts":"2026-02-01T00:00:05.000Z","type":"work.started","origin":{"actor":"agent","confirmed":false},"project":"collation","payload":{"work":"w-colu1"}}\n' >> "$COLLATION_LOG"
printf '{"id":"01collationreportuaaaaaaa","ts":"2026-02-01T00:00:06.000Z","type":"report.added","origin":{"actor":"agent","confirmed":false},"project":"collation","payload":{"text":"never merged"},"refs":{"work":"w-colu1","commits":["cccccccccc02"],"branch":"feat/ä-collate"}}\n' >> "$COLLATION_LOG"
SELF fold > /dev/null
COLL_SECTION="$(SELF context | awk '/^## Unshipped by branch$/ { found = 1; next } /^## / { found = 0 } found')"
COLL_Z="$(printf '%s\n' "$COLL_SECTION" | grep -nF "feat/z-collate" | cut -d: -f1)"
COLL_U="$(printf '%s\n' "$COLL_SECTION" | grep -nF "feat/ä-collate" | cut -d: -f1)"
[ "$COLL_Z" -lt "$COLL_U" ] \
    || fail "the branch lines were ordered by a collator rather than by the bytes the store recorded"
# The same store folded under a second locale, byte for byte. A host whose ICU
# cannot resolve the second locale collates both runs the same way and this
# passes without discriminating; the order check above holds on every host.
( export LC_ALL=en_US.UTF-8; SELF fold > /dev/null )
cp -R "$COLLATION_STATE" "$ROOT/collation-en"
COLL_EN="$( export LC_ALL=en_US.UTF-8; SELF context )"
( export LC_ALL=sv_SE.UTF-8; SELF fold > /dev/null )
COLL_SV="$( export LC_ALL=sv_SE.UTF-8; SELF context )"
diff -r "$ROOT/collation-en" "$COLLATION_STATE" > /dev/null \
    || fail "folding one unchanged store under a second locale wrote different bytes"
[ "$COLL_EN" = "$COLL_SV" ] || fail "the per-branch statement read differently under a second locale"
cd "$ROOT/A/ws/demo"

# an event carries what happened, never what the machine that wrote it could
# see. The table of shapes the guard must refuse — and the prose it must not —
# is driven directly; here the same guard is shown to hold at the boundary a
# real command crosses, and to leave the log and the store commit untouched
# when it refuses, since nothing can take back an appended event another clone
# has already pulled.
node "$CLI_DIR/proof/event-sanitization.mjs" > /dev/null || fail "the event sanitization guard does not refuse what a synced event must not carry"
STORE_A="$ROOT/A/ws/.superself"
BEFORE_LINES="$(wc -l < "$LOG_A")"
BEFORE_COMMIT="$(git -C "$STORE_A" rev-parse HEAD)"
HOMELEAK="$(SELF decide "the credentials live in $HOME/.config/creds.json" --why "guard" 2>&1 || true)"
echo "$HOMELEAK" | grep -q "home directory" || fail "a decision carrying this machine's home path was recorded"
echo "$HOMELEAK" | grep -qF "$HOME/.config/creds.json" && fail "the refusal printed the private path it refused"
KEYLEAK="$(SELF decide "rotate sk-live-AAAABBBBCCCCDDDDEEEE00001111 tomorrow" --why "guard" 2>&1 || true)"
echo "$KEYLEAK" | grep -q "shaped like a credential" || fail "a decision carrying a provider key was recorded"
echo "$KEYLEAK" | grep -qF "sk-live-AAAABBBBCCCCDDDDEEEE00001111" && fail "the refusal printed the credential it refused"
[ "$(wc -l < "$LOG_A")" = "$BEFORE_LINES" ] || fail "a refused event still reached the log"
[ "$(git -C "$STORE_A" rev-parse HEAD)" = "$BEFORE_COMMIT" ] || fail "a refused event still made a store commit"

echo "evidence OK"
