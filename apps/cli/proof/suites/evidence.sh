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
cd "$ROOT/A/ws/mono"
SELF project add --name mono --desc "the repository root beside apps/foo" --no-connect > /dev/null
SELF goal set "prove the repository root is its own project"
cd "$ROOT/A/ws/mono-wt"
SELF setup | grep -q "^project    mono" || fail "the worktree root did not resolve to the root project"
cd "$ROOT/A/ws/mono-wt/apps/foo"
SELF setup | grep -q "^project    foo" || fail "the shallower project won over the directory the command ran in"
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
