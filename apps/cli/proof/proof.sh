#!/usr/bin/env bash
# End-to-end proof of the self CLI: workspace lifecycle, event verbs,
# and two-machine sync through a bare remote with divergent appends.
set -euo pipefail

CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

SELF()
{
    node "$CLI_DIR/bin/self.mjs" "$@"
}

fail()
{
    echo "proof FAILED: $1" >&2
    exit 1
}

# each simulated machine keeps its own home and workspace pointer, so the
# proof can never reach the real one. Each home carries a git identity, as a
# developer machine would: without one, Linux leaves ident empty and every
# direct commit into a proof project repo dies, while macOS quietly fills it
# from the account name and hides the difference.
machine()
{
    export HOME="$ROOT/$1/home"
    export XDG_CONFIG_HOME="$ROOT/$1/config"
    mkdir -p "$HOME"
    git config --global user.name "proof $1"
    git config --global user.email "proof-$1@superself.local"
}

git init -q --bare "$ROOT/remote.git"

# machine A: workspace, project, events, first push
machine A
mkdir -p "$ROOT/A/ws/demo" "$ROOT/A/home/.claude"
cd "$ROOT/A/ws"
SELF init --agents
grep -q "superself:machine:begin" "$ROOT/A/home/.claude/CLAUDE.md" || fail "init did not tell this machine's agents about self"
grep -q "ask the user once" "$ROOT/A/home/.claude/CLAUDE.md" || fail "machine block does not forbid registering on its own"
grep -q "$ROOT/A/ws" "$ROOT/A/config/superself/machine.json" || fail "init did not record the machine workspace"
cd "$ROOT/A/ws/demo"
git init -q
SELF project add --name demo --desc "sync proof project"
grep -q "superself:begin" CLAUDE.md || fail "project add did not render the managed block"
SELF goal set "prove two-machine sync"
WID=$(SELF work add "events from both machines merge cleanly" | tail -1)
cd "$ROOT/A/ws"
SELF remote add "$ROOT/remote.git"
SELF sync

# machine B: clone, relink, act on the same work unit
machine B
mkdir -p "$ROOT/B"
cd "$ROOT/B"
SELF clone "$ROOT/remote.git" ws
grep -q "$ROOT/B/ws" "$ROOT/B/config/superself/machine.json" || fail "clone did not record the machine workspace"
grep -q '"slug":"demo"' "$ROOT/B/ws/.superself/registry.jsonl" || fail "registry did not travel with clone"
grep -q '"path"' "$ROOT/B/ws/.superself/registry.jsonl" && fail "registry leaked a machine path"
mkdir -p "$ROOT/B/ws/demo"
cd "$ROOT/B/ws/demo"
git init -q
SELF project link demo
[ -f .self ] || fail "project link did not restore the marker"
grep -q "workspace" .self && fail "marker carried a machine path"
SELF context | grep -q "prove two-machine sync" || fail "context not derivable on machine B"

# divergent appends on both machines, then bidirectional sync
machine A
cd "$ROOT/A/ws/demo"
SELF decide "machine A made this decision" --why "divergent append"
machine B
cd "$ROOT/B/ws/demo"
SELF work start "$WID"
SELF report "$WID" "machine B started the work"
cd "$ROOT/B/ws" && SELF sync
machine A
cd "$ROOT/A/ws" && SELF sync
machine B
cd "$ROOT/B/ws" && SELF sync
machine A

LOG_A="$ROOT/A/ws/.superself/projects/demo/log.jsonl"
LOG_B="$ROOT/B/ws/.superself/projects/demo/log.jsonl"
diff "$LOG_A" "$LOG_B" > /dev/null || fail "logs diverged after sync"
for type in goal.set work.created work.started report.added decision.confirmed
do
    grep -q "\"type\":\"$type\"" "$LOG_A" || fail "event $type lost in merge"
done
STATE_A="$ROOT/A/ws/.superself/projects/demo/state.md"
grep -q "machine A made this decision" "$STATE_A" || fail "A's decision missing from folded state"
grep -q "machine B started the work" "$STATE_A" || fail "B's report missing from folded state"

# views render at fold time and stay out of the store history
VIEW_A="$ROOT/A/ws/.superself/view"
grep -q "machine B started the work" "$VIEW_A/demo.html" || fail "project view not refreshed by fold"
grep -q "prove two-machine sync" "$VIEW_A/workspace.html" || fail "workspace view missing project summary"
grep -q "machine B started the work" "$VIEW_A/demo/$WID.html" || fail "work detail page missing report history"
git -C "$ROOT/A/ws/.superself" ls-files | grep -q "^view/" && fail "views leaked into store history"
cd "$ROOT/A/ws" && SELF lang ko > /dev/null
grep -q 'lang="ko"' "$VIEW_A/workspace.html" || fail "lang ko not recorded in view metadata"
grep -q "WAITING ON YOU" "$VIEW_A/workspace.html" || fail "labels did not stay English-base under lang ko"
git -C "$ROOT/A/ws/.superself" ls-files | grep -q "links.jsonl" && fail "links.jsonl leaked into store history"

# a machine-local theme.css restyles every page at the next fold and never syncs
echo ':root { --sv-accent: #123abc; }' > "$ROOT/A/ws/.superself/theme.css"
cd "$ROOT/A/ws/demo" && SELF fold > /dev/null
grep -q -- "--sv-accent: #123abc" "$VIEW_A/demo.html" || fail "theme.css override not inlined into the project view"
grep -q -- "--sv-accent: #123abc" "$VIEW_A/workspace.html" || fail "theme.css override missing from the workspace view"
grep -q -- "--sv-accent: #123abc" "$VIEW_A/demo/$WID.html" || fail "theme.css override missing from the work view"
grep -q -- "--sv-accent: #a78bfa" "$VIEW_A/demo.html" || fail "default design tokens missing from the project view"
git -C "$ROOT/A/ws/.superself" ls-files | grep -q "theme.css" && fail "theme.css leaked into store history"

# the accent theme is workspace state: one verb sets it, every page carries it
cd "$ROOT/A/ws"
SELF theme | grep -q "^violet$" || fail "theme did not report the default accent"
SELF theme cyan > /dev/null
grep -q 'data-theme="cyan"' "$VIEW_A/demo.html" || fail "theme cyan did not reach the project view"
grep -q 'data-theme="cyan"' "$VIEW_A/workspace.html" || fail "theme cyan did not reach the workspace view"
grep -q 'rel="icon".*%2322d3ee' "$VIEW_A/demo.html" || fail "the favicon did not follow the accent theme"
BADTHEME="$(SELF theme mauve 2>&1 || true)"
echo "$BADTHEME" | grep -q "is not a viewer theme" || fail "an unknown theme name was accepted"
SELF theme violet > /dev/null
cd "$ROOT/A/ws/demo"

# the machine pointer, not the directory tree, decides the workspace
mkdir -p "$ROOT/outside/app"
cd "$ROOT/outside/app"
git init -q
SELF project add --name outside --desc "registered from outside the workspace tree" --no-connect
[ -f CLAUDE.md ] && fail "--no-connect still wrote the managed block"
SELF goal set "prove out-of-tree projects work"
SELF context | grep -q "prove out-of-tree projects work" || fail "out-of-tree project not usable"
grep -q '"slug":"outside"' "$ROOT/A/ws/.superself/registry.jsonl" || fail "out-of-tree project missing from registry"

# a .superself owned by another tool is never adopted, wherever it sits
mkdir -p "$ROOT/foreign/.superself" "$ROOT/foreign/app"
cd "$ROOT/foreign"
INIT="$(SELF init 2>&1 || true)"
echo "$INIT" | grep -q "not a workspace store" || fail "init adopted a foreign .superself"
cd "$ROOT/foreign/app"
SELF setup | grep -q "^workspace .*/A/ws$" || fail "a foreign .superself displaced the machine workspace"

# a machine with no pointer says so, and self workspace sets one
machine C
STATUS="$(SELF status 2>&1 || true)"
echo "$STATUS" | grep -q "this machine has no workspace" || fail "missing pointer not reported"
SELF workspace "$ROOT/A/ws" > /dev/null
SELF workspace | grep -q "/A/ws$" || fail "self workspace did not report the pointer it set"
machine A

# setup names the project, workspace, store, and pointer
cd "$ROOT/A/ws/demo"
SETUP="$(SELF setup)"
echo "$SETUP" | grep -q "^project    demo" || fail "setup did not name the project"
echo "$SETUP" | grep -q "^workspace .*/A/ws$" || fail "setup did not name the workspace"
echo "$SETUP" | grep -q "^store .*commits" || fail "setup did not describe the store"
echo "$SETUP" | grep -q "^pointer .*machine.json$" || fail "setup did not name the machine pointer"

# artifacts: ingested at report time, listed and searched from the derived registry
cd "$ROOT/A/ws/demo"
echo "<h1>launch page</h1>" > "$ROOT/launch.html"
SELF report "$WID" "attached the launch page" --artifact "$ROOT/launch.html"
AID="$(SELF artifact list --work "$WID" | awk '{print $1}')"
echo "$AID" | grep -q "^a-" || fail "artifact list did not show an a- id"
[ -f "$ROOT/A/ws/.superself/artifacts/demo/$AID-launch.html" ] || fail "artifact bytes not copied into the store"
git -C "$ROOT/A/ws/.superself" ls-files | grep -q "artifacts/demo/$AID-launch.html" || fail "artifact not committed with its event"
SELF artifact search launch | grep -q "$AID" || fail "artifact search missed the name"
SELF artifact search nothing-matches | grep -q "no artifacts" || fail "empty search did not say so"
SELF work show "$WID" | grep -q "$AID launch.html" || fail "work detail missing its artifact"
BAD="$(SELF report "$WID" "bad path" --artifact "$ROOT/missing.bin" 2>&1 || true)"
echo "$BAD" | grep -q "does not exist" || fail "missing artifact path not rejected"
grep -q "artifacts/demo/$AID-launch.html" "$VIEW_A/demo.html" || fail "project view missing the artifact"
grep -q "$AID-launch.html" "$VIEW_A/demo/$WID.html" || fail "work view missing the artifact"
grep -q "artifacts/demo/$AID-launch.html" "$VIEW_A/workspace.html" || fail "workspace view missing the recent-artifact strip"
grep -q 'aria-label="waiting on you"' "$VIEW_A/demo.html" || fail "project view missing the attention panel"
grep -q 'aria-label="waiting on you"' "$VIEW_A/workspace.html" || fail "workspace view missing the attention panel"

# a report is atomic across the artifacts it declares: the whole set is checked
# before a byte is copied, so a rejected member can never half-write a report
STORE="$ROOT/A/ws/.superself"
snapshot()
{
    (cd "$STORE" && find . -path ./.git -prune -o -print | sort)
    git -C "$STORE" rev-parse HEAD
    git -C "$STORE" status --porcelain
    wc -l < "$STORE/projects/demo/log.jsonl"
}
# counted, never matched through a pipe that quits early: `find | grep -q` can
# report the exit status of a killed find instead of the answer, and an
# assertion that cannot fail proves nothing. The artifacts root always exists
# here, so find itself has nothing to fail on.
count_artifacts()
{
    find "$STORE/artifacts" -type f -name "$1" | wc -l | tr -d ' '
}
echo "<h1>second page</h1>" > "$ROOT/second.html"
BEFORE="$(snapshot)"
HALF="$(SELF report "$WID" "half a set" --artifact "$ROOT/second.html" --artifact "$ROOT/missing.bin" 2>&1 || true)"
echo "$HALF" | grep -q "does not exist" || fail "a missing member did not reject the whole set"
[ "$(count_artifacts "*second.html")" -eq 0 ] || fail "a rejected set left orphan artifact bytes"
[ "$(snapshot)" = "$BEFORE" ] || fail "a rejected set changed the log, the tree, or the store commit"

# a complete set records exactly one report event carrying every artifact
REPORTS_BEFORE="$(grep -c '"type":"report.added"' "$STORE/projects/demo/log.jsonl")"
SELF report "$WID" "two pages at once" --artifact "$ROOT/second.html" --artifact "$ROOT/launch.html"
REPORTS_AFTER="$(grep -c '"type":"report.added"' "$STORE/projects/demo/log.jsonl")"
[ "$REPORTS_AFTER" -eq "$((REPORTS_BEFORE + 1))" ] || fail "a multi-artifact report did not record exactly one event"
SELF artifact list --work "$WID" | grep -q "second.html" || fail "the first member of the set was not recorded"
[ "$(SELF artifact list --work "$WID" | grep -c "launch.html")" -eq 2 ] || fail "the second member of the set was not recorded"
git -C "$STORE" ls-files | grep -q "second.html" || fail "a set member was not committed with its event"
[ -z "$(git -C "$STORE" status --porcelain)" ] || fail "a multi-artifact report left the store dirty"
# and every member of it carries the digest of its own bytes, so the set rolls
# back as one while each file in it is verified on its own
SETLINE="$(grep '"type":"report.added"' "$STORE/projects/demo/log.jsonl" | tail -1)"
[ "$(echo "$SETLINE" | grep -o '"digest":"' | wc -l | tr -d ' ')" -eq 2 ] \
    || fail "a multi-artifact report did not record a digest for every member"
SELF status | grep -q "artifact .*second.html" && fail "a stored set member was reported as unhealthy"

# the same filename twice is two artifacts, never one overwriting the other
SELF report "$WID" "the same name twice" --artifact "$ROOT/launch.html" --artifact "$ROOT/launch.html"
[ "$(SELF artifact list --work "$WID" | grep -c "launch.html")" -eq 4 ] || fail "duplicate names did not each get a record"
[ "$(find "$STORE/artifacts/demo" -name "*-launch.html" | wc -l | tr -d ' ')" -eq 4 ] || fail "duplicate names shared one stored file"

# an unreadable member is rejected before its set is copied, not while copying
if [ "$(id -u)" != "0" ]
then
    echo locked > "$ROOT/locked.bin"
    chmod 000 "$ROOT/locked.bin"
    BEFORE="$(snapshot)"
    LOCKED="$(SELF report "$WID" "unreadable member" --artifact "$ROOT/second.html" --artifact "$ROOT/locked.bin" 2>&1 || true)"
    echo "$LOCKED" | grep -q "cannot be read" || fail "an unreadable artifact was not rejected"
    [ "$(snapshot)" = "$BEFORE" ] || fail "an unreadable member left the store changed"
    chmod 644 "$ROOT/locked.bin"
fi

# a directory named alongside a valid file rejects the set and copies nothing
BEFORE="$(snapshot)"
DIRSET="$(SELF report "$WID" "a directory member" --artifact "$ROOT/second.html" --artifact "$ROOT/A" 2>&1 || true)"
echo "$DIRSET" | grep -q "is a directory" || fail "a directory artifact was not rejected"
[ "$(snapshot)" = "$BEFORE" ] || fail "a rejected directory member left the store changed"

# a project's first set takes the directory it created back out with it
cd "$ROOT/outside/app"
WOUT="$(SELF work add "a rejected first set leaves no directory" | tail -1)"
SELF work start "$WOUT"
FIRST="$(SELF report "$WOUT" "first set fails" --artifact "$ROOT/second.html" --artifact "$ROOT/missing.bin" 2>&1 || true)"
echo "$FIRST" | grep -q "does not exist" || fail "a project's first artifact set was not rejected"
[ -d "$STORE/artifacts/outside" ] && fail "a rejected first set left an empty artifact directory behind"
cd "$ROOT/A/ws/demo"

# a member that passes every check and then fails while being copied. A unix
# socket is exactly that source: it exists, it is not a directory, it is
# readable — and it cannot be opened for copying. The failure lands after the
# preflight, where rollback is the only thing keeping the store whole.
( node -e 'require("node:net").createServer().listen(process.argv[1], () => process.kill(process.pid, "SIGKILL"))' "$ROOT/queue.sock" ) > /dev/null 2>&1 || true
[ -S "$ROOT/queue.sock" ] || fail "the proof could not leave a socket behind to fail a copy with"
STORED_BEFORE="$(count_artifacts "*")"
BEFORE="$(snapshot)"
MIDCOPY="$(SELF report "$WID" "a member that cannot be copied" --artifact "$ROOT/second.html" --artifact "$ROOT/queue.sock" 2>&1 || true)"
echo "$MIDCOPY" | grep -q "could not be copied into the store" || fail "a member that failed while copying was not reported"
[ "$(count_artifacts "*")" -eq "$STORED_BEFORE" ] || fail "a failed copy left the half of the set it had already written"
[ "$(snapshot)" = "$BEFORE" ] || fail "a failed copy left the log, the tree, or the store commit changed"

# rollback removes what it created and nothing around it: the shared artifacts
# root, the project directory it found, and the bytes of earlier reports all
# stay exactly where they were
[ -d "$STORE/artifacts" ] || fail "rollback removed the shared artifacts root"
[ -d "$STORE/artifacts/demo" ] || fail "rollback removed a project directory it did not create"
[ "$(count_artifacts "*-launch.html")" -eq 4 ] || fail "rollback removed artifacts stored by earlier reports"
# a rolled-back set wrote no event, so health has nothing half-written to name
SELF status | grep -qE "is missing from this store|cannot be read in this store" \
    && fail "a rolled-back set left an artifact health cannot account for"
node "$CLI_DIR/proof/rollback-ownership.mjs" "$ROOT/rollback-store" || fail "rollback removed paths it did not create"

# the same failure on a project's first set: the directory this command made
# goes, the root above it stays
cd "$ROOT/outside/app"
BEFORE="$(snapshot)"
FIRSTCOPY="$(SELF report "$WOUT" "a first set that fails while copying" --artifact "$ROOT/second.html" --artifact "$ROOT/queue.sock" 2>&1 || true)"
echo "$FIRSTCOPY" | grep -q "could not be copied into the store" || fail "a first set that failed while copying was not reported"
[ -d "$STORE/artifacts/outside" ] && fail "a failed copy left behind the directory it created"
[ -d "$STORE/artifacts" ] || fail "a failed first copy took the shared artifacts root with it"
[ "$(snapshot)" = "$BEFORE" ] || fail "a failed first copy left the store changed"
cd "$ROOT/A/ws/demo"

# the appended event is the store's truth, and the line rollback stops at. A
# fold that fails after that line is written costs a refold — never the event,
# and never the bytes the event already names. The view files are derived and
# machine-local, so one of them standing in as the failure is the fold's own
# last step and nothing the store keeps.
if [ "$(id -u)" != "0" ]
then
    chmod 444 "$VIEW_A/demo.json"
    LATE="$(SELF report "$WID" "the fold fails after the event is durable" --artifact "$ROOT/second.html" 2>&1 || true)"
    chmod 644 "$VIEW_A/demo.json"
    echo "$LATE" | grep -q "EACCES" || fail "the proof could not make the fold fail after the event was appended"
    tail -1 "$STORE/projects/demo/log.jsonl" | grep -q "the fold fails after the event is durable" || fail "the event was not appended before the fold ran"
    LATE_PATH="$(tail -1 "$STORE/projects/demo/log.jsonl" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')"
    [ -n "$LATE_PATH" ] || fail "the durable report recorded no artifact path"
    [ -f "$STORE/$LATE_PATH" ] || fail "a durable report lost the bytes it names"
    SELF artifact list --work "$WID" | grep -q "second.html" || fail "the durable report is missing from the derived registry"
    # and the store catches up by itself: the next event folds and commits what
    # the interrupted one left, bytes included
    SELF report "$WID" "the next event folds what the failed one left"
    [ -z "$(git -C "$STORE" status --porcelain)" ] || fail "the store did not recover on the next event"
    git -C "$STORE" ls-files | grep -q "$LATE_PATH" || fail "the bytes of the recovered report were never committed"
fi

# a project name is not a path. One that would leave the artifacts root is
# refused a directory there instead of being followed out of the store.
machine D
mkdir -p "$ROOT/D/ws/app"
cd "$ROOT/D/ws"
SELF init > /dev/null
cd "$ROOT/D/ws/app"
git init -q
SELF project add --name "../../escape" --desc "a name that is not a path segment" --no-connect > /dev/null || fail "the proof could not register the hostile name it tests"
WESC="$(SELF work add "a hostile project name stores nothing outside the root" | tail -1)"
SELF work start "$WESC" > /dev/null
ESCAPE="$(SELF report "$WESC" "escape the artifacts root" --artifact "$ROOT/second.html" 2>&1 || true)"
echo "$ESCAPE" | grep -q "single path segment" || fail "a project name that leaves the artifacts root was accepted"
[ "$(find "$ROOT/D" -type f -name "*-second.html" | wc -l | tr -d ' ')" -eq 0 ] || fail "a hostile project name wrote artifact bytes outside the artifacts root"
machine A
cd "$ROOT/A/ws/demo"

# the App Rail shell: every page carries the rail, the app bar, and a query
# bar that states the fold it was rendered from
for PAGE in "$VIEW_A/demo.html" "$VIEW_A/workspace.html" "$VIEW_A/demo/$WID.html"
do
    grep -q 'aria-label="workspace rail"' "$PAGE" || fail "$(basename "$PAGE") is missing the workspace rail"
    grep -q 'class="c2-query"' "$PAGE" || fail "$(basename "$PAGE") is missing the query bar"
    grep -q 'class="c2-logo"' "$PAGE" || fail "$(basename "$PAGE") is missing the logo symbol beside the wordmark"
done
FOLD_ID="$(SELF log -n 1 | sed -E 's/.*\[([^]]+)\].*/\1/' | cut -c1-8)"
grep -q "fold $FOLD_ID" "$VIEW_A/demo.html" || fail "the query bar does not name the state the page was folded from"
grep -q 'class="dr-side"' "$VIEW_A/demo.html" || fail "project view missing the record column"
grep -q 'class="dr-side"' "$VIEW_A/demo/$WID.html" || fail "work detail missing its record column"

# full-list pages carry what the dashboard panels cap
grep -q "$AID-launch.html" "$VIEW_A/demo/artifacts.html" || fail "artifacts page missing an artifact"
grep -q "machine A made this decision" "$VIEW_A/demo/decisions.html" || fail "decisions page missing a decision"
grep -q "machine B started the work" "$VIEW_A/demo/events.html" || fail "events page missing an event"
grep -q 'class="dr-side"' "$VIEW_A/demo/artifacts.html" && fail "a list page rendered the record column"

# a changed viewer reaches every project, not only the one being folded —
# otherwise the workspace shows two designs until each project happens to
# record an event
rm -f "$VIEW_A/.chrome"
FORWARD="$(cd "$ROOT/A/ws/demo" && SELF fold)"
echo "$FORWARD" | grep -q "refolded .* other project" || fail "a moved viewer did not bring other projects' pages forward"
grep -q 'aria-label="workspace rail"' "$VIEW_A/outside.html" || fail "another project's page kept the old viewer"
AGAIN="$(cd "$ROOT/A/ws/demo" && SELF fold)"
echo "$AGAIN" | grep -q "other project" && fail "an unchanged viewer refolded every project again"

# artifacts travel with the store: machine B sees bytes and registry after sync
cd "$ROOT/A/ws" && SELF sync
machine B
cd "$ROOT/B/ws" && SELF sync
cd "$ROOT/B/ws/demo"
SELF artifact list | grep -q "$AID" || fail "artifact registry not derived on machine B"
[ -f "$ROOT/B/ws/.superself/artifacts/demo/$AID-launch.html" ] || fail "artifact bytes did not sync"
machine A

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

# a worktree of a registered project is guided to link, never to a duplicate add
cd "$ROOT/A/ws/demo"
git worktree add -q "$ROOT/A/ws/demo-wt" -b side-branch
cd "$ROOT/A/ws/demo-wt"
[ -f .self ] && fail "the marker leaked into a fresh worktree"
SELF setup | grep -q 'self project link demo' || fail "setup did not recognize the sibling checkout"
ERR="$(SELF work 2>&1 || true)"
echo "$ERR" | grep -q "self project link demo" || fail "unregistered worktree not guided to link"
echo "$ERR" | grep -q "self project add\` would register a duplicate" || fail "the misleading add advice was not corrected"
ADD="$(SELF project add --name demo-copy 2>&1 || true)"
echo "$ADD" | grep -q "self project link demo" || fail "project add did not refuse the sibling checkout"
grep -q '"slug":"demo-copy"' "$ROOT/A/ws/.superself/registry.jsonl" && fail "a duplicate project was registered"
SELF project link
[ -f .self ] || fail "project link did not infer the slug from the repository"
SELF context | grep -q "prove two-machine sync" || fail "linked worktree has no project context"

# both checkouts stay linked, and a fold refreshes only the one it runs in
SELF setup | grep -q "more checkout" || fail "setup hid the second linked checkout"
SELF convention add "worktree folds refresh the active checkout"
grep -q "worktree folds refresh the active checkout" "$ROOT/A/ws/demo-wt/CLAUDE.md" || fail "fold skipped the active checkout's block"
grep -q "worktree folds refresh the active checkout" "$ROOT/A/ws/demo/CLAUDE.md" && fail "fold wrote into a checkout it was not run from"
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

# target dates are judged in the workspace zone, never the rendering locale
cd "$ROOT/A/ws"
SELF timezone | grep -q "^UTC$" || fail "the default target-date zone was not UTC"
SELF timezone Asia/Seoul > /dev/null
SELF timezone | grep -q "^Asia/Seoul$" || fail "timezone did not record the zone it was given"
BADZONE="$(SELF timezone Mars/Olympus 2>&1 || true)"
echo "$BADZONE" | grep -q "not an IANA time zone" || fail "an unknown time zone was accepted"
SELF timezone UTC > /dev/null

day()
{
    date -u -d "$1 days" +%F 2>/dev/null || date -u -v"$1"d +%F
}
FUTURE="$(day +30)"
SOON="$(day +2)"
PAST="$(day -2)"

# the long-term goal and a time-boxed objective coexist
cd "$ROOT/A/ws/demo"
OID="$(SELF objective add "ship the payment flow this month" --horizon month --target "$FUTURE" \
    --success "checkout converts" --stop "chargebacks rise" | tail -1)"
grep -q "prove two-machine sync" "$STATE_A" || fail "an objective overwrote the long-term goal"
grep -q "$OID" "$STATE_A" || fail "the objective never reached folded state"
SELF context | grep -q "ship the payment flow this month" || fail "context does not carry the objective"

# a milestone needs explicit exit criteria; work links to it without becoming it
NOEXIT="$(SELF milestone add "no criteria" --objective "$OID" 2>&1 || true)"
echo "$NOEXIT" | grep -q "need explicit exit criteria" || fail "a milestone was accepted with no exit criteria"
M1="$(SELF milestone add "checkout accepts a card" --objective "$OID" --target "$FUTURE" \
    --exit "a live charge settles" --exit "the failure path is covered" | tail -1)"
M2="$(SELF milestone add "refunds settle" --objective "$OID" --target "$FUTURE" --after "$M1" \
    --exit "a refund reaches the customer" | tail -1)"
WPAY="$(SELF work add "wire the payment provider" | tail -1)"
SELF work start "$WPAY"
SELF work link "$WPAY" --milestone "$M1"
SELF work link "$WPAY" --milestone "$M2"
SELF work show "$WPAY" | grep -q "Contributes to: $M1" || fail "work detail does not name the milestone it serves"
SELF milestone | grep -q "$M1" || fail "milestone list is empty"
SELF milestone | grep "$M2" | grep -q "critical path" && fail "a milestone nothing waits on was called critical path"
SELF milestone | grep "$M1" | grep -q "critical path" || fail "a milestone another one waits on is not on the critical path"

# one report, two milestones: evidence is shared by reference, never copied
echo pay > pay.txt && git add . && git commit -qm "payment provider wired"
PAYC="$(git rev-parse --short=12 HEAD)"
SELF report "$WPAY" "provider wired and charging"
OBJ_MD="$ROOT/A/ws/.superself/projects/demo/objective/$OID.md"
[ "$(grep -c "$PAYC" "$OBJ_MD")" -ge 2 ] || fail "two milestones did not share the same evidence commit"
[ "$(grep -c '"type":"report.added".*provider wired' "$LOG_A")" -eq 1 ] || fail "shared evidence duplicated the report"

# finishing work does not reach a milestone whose exit criteria are not covered
SELF work done "$WPAY"
NOTREACHED="$(SELF milestone reach "$M1" 2>&1 || true)"
echo "$NOTREACHED" | grep -q "uncovered exit criteria" || fail "a milestone was reached with open exit criteria"
grep -q "$M1.*reached" "$STATE_A" && fail "work reaching done reached its milestone"

# coverage cites evidence, and reaching records the revisions it was judged against
SELF milestone met "$M1" --criterion c1 --why "the settled charge in $PAYC" --evidence "$PAYC"
SELF milestone met "$M1" --criterion c2 --why "the declined-card path is exercised"
BADCRIT="$(SELF milestone met "$M1" --criterion c9 --why "nope" 2>&1 || true)"
echo "$BADCRIT" | grep -q "not a live exit criterion" || fail "coverage was accepted for a criterion that does not exist"
SELF milestone reach "$M1"
grep -q "Reached:.*against objective revision 1/milestone revision 1" "$OBJ_MD" || fail "reaching did not record the revisions it satisfied"
grep -q "criteria c1, c2" "$OBJ_MD" || fail "reaching did not record the criteria it covered"
grep -q "evidence.*$PAYC" "$OBJ_MD" || fail "reaching did not record its evidence"

# revising the objective makes coverage judged against the old revision stale
SELF objective revise "$OID" --why "the board moved the target" --target "$SOON"
SELF status | grep -q "recheck it" || fail "a revision left stale coverage invisible"
grep -q "stale coverage" "$VIEW_A/demo.html" || fail "the project view hides stale coverage"

# stale is a question, not a verdict: a deliberate re-judgment at the current
# revision settles it, and nothing else does
NOCOV="$(SELF milestone recheck "$M2" --criterion c1 --why "nothing was judged here" 2>&1 || true)"
echo "$NOCOV" | grep -q "no coverage to recheck" || fail "a criterion nobody covered was rechecked"
NOPROG="$(SELF milestone recheck "$M1" --criterion c1 --why x --progress 60 2>&1 || true)"
echo "$NOPROG" | grep -q "progress is derived" || fail "a recheck accepted a manual progress percentage"
SELF milestone recheck "$M1" --criterion c1 --why "the settled charge in $PAYC still covers it" --evidence "$PAYC"
SELF status | grep -q "coverage of c1" && fail "coverage re-judged at the current revision still read stale"
SELF status | grep -q "coverage of c2" || fail "coverage nobody re-judged stopped being reported"
SELF milestone recheck "$M1" --criterion c2 --why "the declined-card path is unchanged"
SELF milestone recheck "$M1" --why "the moved date changes nothing this reach was judged on"
SELF status | grep -q "recheck it" && fail "a fully re-judged milestone still asked for a recheck"
grep -q "stale coverage" "$VIEW_A/demo.html" && fail "the project view still shows coverage that was re-judged"
[ "$(grep -c '^- c1 on' "$OBJ_MD")" -ge 2 ] || fail "a recheck replaced the coverage it re-judged instead of appending"
grep -q "rechecked at revision" "$OBJ_MD" || fail "a re-judged coverage entry is indistinguishable from the first"
grep -q "^- Rechecked:" "$OBJ_MD" || fail "a re-judged reach left no record of what it was judged against"
grep -q "^- Reached:" "$OBJ_MD" || fail "a recheck erased the day the milestone was first reached"
SETTLED="$(SELF milestone recheck "$M1" --why "again" 2>&1 || true)"
echo "$SETTLED" | grep -q "nothing to recheck" || fail "a reach already judged at the current revision was re-judged again"

# a revision that widens the ask is not waved through: the criterion it added
# has to be covered before the reach stands again
SELF milestone revise "$M1" --why "compliance added a step" --exit "the fraud check runs"
OPENRECHECK="$(SELF milestone recheck "$M1" --why "it surely still holds" 2>&1 || true)"
echo "$OPENRECHECK" | grep -q "uncovered exit criteria" || fail "a widened milestone re-affirmed a reach over an open criterion"
SELF status | grep -q "was reached against" || fail "a widened milestone stopped reporting its stale reach"
SELF milestone met "$M1" --criterion c3 --why "the fraud check is exercised"
SELF milestone recheck "$M1" --criterion c1 --why "still covered after the added step"
SELF milestone recheck "$M1" --criterion c2 --why "still covered after the added step"
SELF milestone recheck "$M1" --why "every live criterion is covered at this revision"
SELF status | grep -q "recheck it" && fail "a settled milestone kept asking for a recheck"

# a target-date boundary is deterministic and closes nothing on its own
MLATE="$(SELF milestone add "invoices export" --objective "$OID" --target "$PAST" --exit "an export downloads" | tail -1)"
WLATE="$(SELF work add "build the export" | tail -1)"
SELF work start "$WLATE"
SELF work link "$WLATE" --milestone "$MLATE"
SELF milestone | grep "$MLATE" | grep -q "missed" || fail "a passed target date did not read as missed"
SELF work | grep "$WLATE" | grep -q "active" || fail "a missed target silently closed its work unit"
SELF status | grep -q "$MLATE missed its target" || fail "a missed target raised no health signal"

# a blocked unit on the critical path is distinguishable from an unstarted one
SELF work block "$WLATE" --on external --why "the ledger API is down"
SELF milestone | grep "$MLATE" | grep -q "no work linked" && fail "a milestone with work linked claimed none"
SELF milestone | grep "$M2" | grep -q "no work linked" && fail "a milestone with a linked unit claimed none"
grep -q "blocked $WLATE" "$VIEW_A/demo.html" || fail "the project view hides a blocked milestone's unit"

# progress is derived, never asserted
BADPROG="$(SELF milestone met "$M2" --criterion c1 --why x --progress 60 2>&1 || true)"
echo "$BADPROG" | grep -q "progress is derived" || fail "a manual progress percentage was accepted"

# superseding an objective preserves lineage instead of two current states
O2="$(SELF objective add "ship payments and payouts this quarter" --horizon quarter --target "$FUTURE" --supersedes "$OID" | tail -1)"
grep -q "Supersedes: $OID" "$ROOT/A/ws/.superself/projects/demo/objective/$O2.md" || fail "a superseding objective lost its lineage"
[ -f "$OBJ_MD" ] && fail "a superseded objective stayed current"
SELF search "$OID" --type objective | grep -q "$OID" || fail "the superseded objective vanished from the log"

# a goal-gap proposal must carry its whole brief, and cannot be filed twice
M3="$(SELF milestone add "payouts land" --objective "$O2" --exit "a payout clears" | tail -1)"
SELF milestone | grep "$M3" | grep -q "no work linked" || fail "a milestone nothing was dispatched at claimed work"
grep -q "no work linked" "$VIEW_A/demo/$O2.html" || fail "the objective page hides a milestone with no work"
THIN="$(SELF work propose "wire payouts" --milestone "$M3" --value "closes the payout gap" 2>&1 || true)"
echo "$THIN" | grep -q "work propose needs --risk" || fail "an incomplete proposal was recorded"
SELF work propose "wire payouts" --milestone "$M3" --value "closes the payout gap" \
    --success "a payout clears in staging" --stop "the provider rejects our account" \
    --depends "$M3" --risk "provider onboarding may take weeks" --capacity "3 days" \
    --evidence-plan "a settled payout id in the report" --confidence medium --expires "$FUTURE"
PID="$(SELF log -n 1 | sed -E 's/.*\[([^]]+)\].*/\1/' | cut -c1-8)"
DUPE="$(SELF work propose "Wire payouts!" --milestone "$M3" --value v --success s --stop t \
    --risk r --capacity c --evidence-plan e --confidence low --expires "$FUTURE" 2>&1 || true)"
echo "$DUPE" | grep -q "already proposes this outcome" || fail "a duplicate proposal was recorded"
SELF context | grep -q "evidence plan: a settled payout id" || fail "the proposal brief is missing from context"
# creating the unit, pointing it at what it closes, and settling the proposal
# are one act, so they reach the log and the store history together
COMMITS_BEFORE="$(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD)"
WNEW="$(SELF work accept "$PID" | tail -1)"
[ "$(( $(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD) - COMMITS_BEFORE ))" -eq 1 ] \
    || fail "accepting a proposal was not recorded as one state change"
SELF work show "$WNEW" | grep -q "Contributes to: $M3" || fail "accepting a proposal did not link the work it created"
GONE="$(SELF work accept "$PID" 2>&1 || true)"
echo "$GONE" | grep -q "already accepted" || fail "an accepted proposal was accepted twice"

# the viewer carries the outcome layer, and every page still renders
grep -q "OBJECTIVES" "$VIEW_A/demo.html" || fail "the project view has no objectives panel"
grep -q "exit criteria covered" "$VIEW_A/demo.html" || fail "the project view shows no derived progress"
grep -q "OBJECTIVES" "$VIEW_A/workspace.html" || fail "the workspace view has no objectives roll-up"
grep -q "toward $M3" "$VIEW_A/demo/$WNEW.html" || fail "work detail does not name what it contributes to"
grep -q "CONTRIBUTES TO" "$VIEW_A/demo/$WNEW.html" || fail "work detail has no contribution panel"
grep -q "MILESTONE $M3" "$VIEW_A/demo/$O2.html" || fail "the objective page is missing its milestone"

# a workspace that never adopted objectives folds exactly as before
grep -q "## Objectives" "$ROOT/A/ws/.superself/projects/outside/state.md" && fail "a project with no objectives grew an objectives section"
grep -q "OBJECTIVES" "$VIEW_A/outside.html" && fail "a project with no objectives grew an objectives panel"
SELF search "prove out-of-tree" --project outside | grep -q "out-of-tree" || fail "an untouched project stopped folding"

# the outcome layer survives replay, sync, and a machine that never saw it
cd "$ROOT/A/ws/demo"
BEFORE="$(cat "$ROOT/A/ws/.superself/projects/demo/objective/$O2.md")"
SELF fold > /dev/null
[ "$BEFORE" = "$(cat "$ROOT/A/ws/.superself/projects/demo/objective/$O2.md")" ] || fail "a replay of the same log folded a different objective"
SELF search "$M1" --type milestone | grep -q "milestone.reached" || fail "a replay lost the reached milestone"
cd "$ROOT/A/ws" && SELF sync
machine B
cd "$ROOT/B/ws" && SELF sync
grep -q "$M3" "$ROOT/B/ws/.superself/projects/demo/state.md" || fail "objectives did not survive sync to another machine"
diff "$LOG_A" "$LOG_B" > /dev/null || fail "objective events diverged after sync"
machine A

# the at-risk window is a boundary, not a mood: inside it with an open
# criterion is at risk, one day outside it is not
cd "$ROOT/A/ws/demo"
EDGE="$(day +3)"
OUTSIDE="$(day +4)"
ORISK="$(SELF objective add "close the quarter clean" --horizon quarter --target "$EDGE" | tail -1)"
MEDGE="$(SELF milestone add "the sign-off lands" --objective "$ORISK" --target "$EDGE" --exit "finance signs off" | tail -1)"
MOUT="$(SELF milestone add "the archive ships" --objective "$ORISK" --target "$OUTSIDE" --exit "the archive uploads" | tail -1)"
SELF milestone | grep "$MEDGE" | grep -q "at-risk" || fail "an open criterion inside the window did not read at-risk"
SELF milestone | grep "$MOUT" | grep -q "at-risk" && fail "a target a day outside the window read at-risk"
SELF status | grep -q "$MEDGE is at risk" || fail "an at-risk target raised no health signal"
SELF objective show "$ORISK" | grep -q "Target state: at-risk" || fail "an objective with an at-risk milestone did not carry it"

# every checkpoint landed, so a date that has since passed missed nothing, and
# coverage cited without a work unit is progress rather than an empty objective
SELF milestone met "$MEDGE" --criterion c1 --why "the signed statement is filed"
SELF milestone reach "$MEDGE"
SELF milestone met "$MOUT" --criterion c1 --why "the archive is uploaded"
SELF milestone reach "$MOUT"
SELF objective revise "$ORISK" --why "the board pulled the date in" --target "$PAST"
SELF objective show "$ORISK" | grep -q "Target state: missed" && fail "an objective whose milestones all landed read missed"
SELF objective show "$ORISK" | grep -q "Target state: unstarted" && fail "verified coverage with no linked work read as nothing started"
SELF objective show "$ORISK" | grep -q "Target state: on-track" || fail "an objective holding only reached milestones lost its derived state"

# a reach is a judgment against a revision, so widening the ask makes it stale
SELF status | grep -q "$MEDGE was reached against" || fail "a reach judged against an older revision stayed silent"
SELF milestone revise "$MEDGE" --why "the audit added a step" --exit "the auditor countersigns"
SELF milestone show "$MEDGE" | grep -q "open" || fail "a criterion added after the reach was not left open"

# a superseded milestone hands its order to its successor and waits on nothing
MOLD="$(SELF milestone add "draft the migration" --objective "$O2" --exit "a draft exists" | tail -1)"
MNEXT="$(SELF milestone add "run the migration" --objective "$O2" --after "$MOLD" --exit "the migration runs" | tail -1)"
SELF milestone | grep "$MOLD" | grep -q "critical path" || fail "a milestone another one waits on is not on the critical path"
MREDO="$(SELF milestone add "run the migration in two passes" --objective "$O2" --supersedes "$MNEXT" --exit "both passes run" | tail -1)"
SELF milestone | grep "$MNEXT" | grep -q "superseded by $MREDO" || fail "a superseded milestone lost its lineage"
SELF milestone | grep "$MOLD" | grep -q "critical path" && fail "a superseded milestone still claimed the critical path"

# a target date falls due in the workspace zone, never in the one the machine
# happens to render in: Etc/GMT+12 and Pacific/Kiritimati are 26 hours apart,
# so a day that is still current in the west is already spent in the east
cd "$ROOT/A/ws" && SELF timezone Etc/GMT+12 > /dev/null
cd "$ROOT/A/ws/demo"
WEST="$(TZ=Etc/GMT+12 date +%F)"
MZONE="$(SELF milestone add "the day boundary holds" --objective "$O2" --target "$WEST" --exit "the boundary is judged once" | tail -1)"
SELF milestone | grep "$MZONE" | grep -q "missed" && fail "a target still due in the workspace zone read as missed"
cd "$ROOT/A/ws" && SELF timezone Pacific/Kiritimati > /dev/null
cd "$ROOT/A/ws/demo"
SELF milestone | grep "$MZONE" | grep -q "missed" || fail "the same target did not fall past in a workspace zone a day ahead"
EAST_RUN="$(TZ=Pacific/Kiritimati node "$CLI_DIR/bin/self.mjs" milestone)"
WEST_RUN="$(TZ=Etc/GMT+12 node "$CLI_DIR/bin/self.mjs" milestone)"
[ "$EAST_RUN" = "$WEST_RUN" ] || fail "the rendering machine's zone changed a target-date judgment"
cd "$ROOT/A/ws" && SELF timezone UTC > /dev/null
SELF timezone | grep -q "^UTC$" || fail "the workspace zone did not return to what it was set to"

# two proposals are the same proposal when they say the same thing, whatever
# script they say it in — the key that keeps letters and numbers keeps them all
cd "$ROOT/A/ws/demo"
OSCRIPT="$(SELF objective add "serve every script" | tail -1)"
MSCRIPT="$(SELF milestone add "payments log" --objective "$OSCRIPT" --exit "a payment is logged" | tail -1)"
propose()
{
    SELF work propose "$1" --milestone "$MSCRIPT" --value v --success s --stop t \
        --risk r --capacity c --evidence-plan e --confidence low --expires "$FUTURE" > /dev/null
}
propose "Внедрить оплату картой" || fail "a Cyrillic proposal was refused"
propose "Добавить логирование ошибок" || fail "two unrelated Cyrillic proposals collapsed into one"
propose "決済ログを追加する" || fail "a Japanese proposal collided with a Cyrillic one"
propose "إضافة سجل المدفوعات" || fail "an Arabic proposal collided with another script"
propose "เพิ่มบันทึกการชำระเงิน" || fail "a Thai proposal collided with another script"
propose "결제 로그를 추가한다" || fail "a Hangul proposal collided with another script"
propose "add payment logging" || fail "a Latin proposal collided with another script"
SCRIPTDUPE="$(SELF work propose "  ВНЕДРИТЬ, оплату  картой!  " --milestone "$MSCRIPT" --value v --success s \
    --stop t --risk r --capacity c --evidence-plan e --confidence low --expires "$FUTURE" 2>&1 || true)"
echo "$SCRIPTDUPE" | grep -q "already proposes this outcome" || fail "the same Cyrillic outcome was proposed twice"

# a closed objective's page tells the truth about being closed rather than
# freezing the last state it was open in, and the work that pointed at it
# still reaches it
OCLOSED="$(SELF objective add "the abandoned bet" | tail -1)"
WCLOSED="$(SELF work add "chase the abandoned bet" | tail -1)"
SELF work link "$WCLOSED" --objective "$OCLOSED"
grep -q "pill s-on-track" "$VIEW_A/demo/$OCLOSED.html" || fail "an open objective's page does not carry its state"
SELF objective close "$OCLOSED" --as dropped --why "the bet is off"
grep -q "pill s-on-track" "$VIEW_A/demo/$OCLOSED.html" && fail "a closed objective's page still renders it on track"
grep -q "pill s-closed" "$VIEW_A/demo/$OCLOSED.html" || fail "a closed objective's page does not say it is closed"
grep -q "the bet is off" "$VIEW_A/demo/$OCLOSED.html" || fail "a closed objective's page does not say why it closed"
grep -q "href=\"$OCLOSED.html\"" "$VIEW_A/demo/$WCLOSED.html" || fail "work detail dropped the objective it contributes to"
[ -f "$ROOT/A/ws/.superself/projects/demo/objective/$OCLOSED.md" ] && fail "a closed objective stayed a current canonical file"

# an outcome that was verified stays verified: a successor is lineage, not a
# reason to unsay what landed
OREACHED="$(SELF objective add "the landed bet" | tail -1)"
SELF objective close "$OREACHED" --as reached --why "it landed"
ONEXT="$(SELF objective add "the follow-up bet" --supersedes "$OREACHED" | tail -1)"
SELF objective show "$OREACHED" | grep -q "Status: reached" || fail "superseding erased a reached objective's status"
SELF objective show "$OREACHED" | grep -q "Target state: reached" || fail "superseding erased a reached objective's outcome"
SELF objective show "$OREACHED" | grep -q "Superseded by: $ONEXT" || fail "a reached objective lost its successor pointer"

# a superseded milestone asks nothing of anyone, including a recheck
OSUP="$(SELF objective add "the migration" | tail -1)"
MSUP="$(SELF milestone add "first pass" --objective "$OSUP" --exit "a pass runs" | tail -1)"
SELF milestone met "$MSUP" --criterion c1 --why "the pass ran"
SELF objective revise "$OSUP" --why "the scope widened" --target "$FUTURE"
SELF status | grep -q "$MSUP coverage of c1" || fail "a live milestone's stale coverage stopped being reported"
MSUP2="$(SELF milestone add "two passes" --objective "$OSUP" --supersedes "$MSUP" --exit "both passes run" | tail -1)"
SELF status | grep -q "$MSUP coverage of c1" && fail "a superseded milestone still asked for a recheck"

# a timebox someone withdraws stops deciding whether the target was missed
OBOX="$(SELF objective add "the timeboxed bet" --horizon month --target "$PAST" --priority 2 | tail -1)"
SELF objective show "$OBOX" | grep -q "Target state: missed" || fail "a passed target did not read as missed"
SELF objective revise "$OBOX" --why "the date is withdrawn, not moved" --target ""
SELF objective show "$OBOX" | grep -q "target $PAST" && fail "a withdrawn target is still on the objective"
SELF objective show "$OBOX" | grep -q "Target state: missed" && fail "a withdrawn target still judged the objective late"
SELF objective revise "$OBOX" --why "the priority is withdrawn" --priority ""
SELF objective show "$OBOX" | grep -q "^- Priority:" && fail "a withdrawn priority survived the revision"
MBOX="$(SELF milestone add "the timeboxed step" --objective "$OBOX" --target "$PAST" --exit "a step runs" | tail -1)"
SELF milestone revise "$MBOX" --why "the date is withdrawn" --target ""
SELF milestone show "$MBOX" | grep -q "^- Target:" && fail "a withdrawn milestone target survived the revision"
BADDATE="$(SELF objective revise "$OBOX" --why "nonsense" --target "not-a-date" 2>&1 || true)"
echo "$BADDATE" | grep -q "is not a date" || fail "withdrawing a date also let a malformed one through"
NONAME="$(SELF objective revise "$OBOX" --why "erase it" --outcome "" 2>&1 || true)"
echo "$NONAME" | grep -q "cannot be emptied" || fail "an objective was left with no stated outcome"

# a mistyped verb is answered with the verbs, not with a demand for an id
BADVERB="$(SELF objective frobnicate 2>&1 || true)"
echo "$BADVERB" | grep -q "usage: self objective" || fail "an unknown objective verb was reported as a missing id"
BADVERB2="$(SELF milestone frobnicate 2>&1 || true)"
echo "$BADVERB2" | grep -q "usage: self milestone" || fail "an unknown milestone verb was reported as a missing id"
NOID="$(SELF objective show 2>&1 || true)"
echo "$NOID" | grep -q "objective-id" || fail "a genuinely missing id stopped asking for an id"

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
grep -qE "(Evidence: |, )$UPPER \(" "$WORKEV" || fail "an uppercase revision this repo resolves was demoted to a note"
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

# artifacts are verified against the store that holds their bytes: a matching
# digest is healthy, and a changed or missing file names the artifact
echo "v1 validated" > "$ROOT/report.txt"
WART="$(SELF work add "artifact integrity is checked, not guessed" | tail -1)"
SELF work start "$WART"
SELF report "$WART" "attached the validated report" --artifact "$ROOT/report.txt"
ARTID="$(SELF artifact list --work "$WART" | awk '{print $1}')"
ARTFILE="$ROOT/A/ws/.superself/artifacts/demo/$ARTID-report.txt"
grep -q "\"digest\":\"" "$LOG_A" || fail "artifact ingest did not record a digest"
SELF status | grep -q "$ARTID" && fail "an artifact matching its digest raised a health signal"
echo "tampered" > "$ARTFILE"
SELF fold > /dev/null
SELF status | grep -q "$ARTID .*no longer matches" || fail "a changed artifact raised no signal"
rm "$ARTFILE"
SELF fold > /dev/null
SELF status | grep -q "$ARTID .*is missing from this store" || fail "a missing artifact raised no signal"
SELF status | grep -q "$ARTID .*rewritten" && fail "an artifact problem was reported as rewritten Git history"

# an artifact the store will not hand over is a health signal, never a crash.
# A directory in the file's place fails the read the same way for every user,
# root included, so this holds wherever the proof runs.
echo "v2 validated" > "$ROOT/report.txt"
SELF report "$WART" "attached it again after the file went missing" --artifact "$ROOT/report.txt"
ARTID2="$(SELF artifact list --work "$WART" | tail -1 | awk '{print $1}')"
rm -rf "$STORE/artifacts/demo/$ARTID2-report.txt"
mkdir -p "$STORE/artifacts/demo/$ARTID2-report.txt"
UNREADABLE="$(SELF status)" || fail "status died on an artifact it could not read"
echo "$UNREADABLE" | grep -q "$ARTID2 .*cannot be read in this store" || fail "an unreadable artifact raised no health signal"
echo "$UNREADABLE" | grep -q "$STORE" && fail "a health signal printed the store's absolute path"
echo "$UNREADABLE" | grep -Eq '^[[:space:]]+at |node:internal' && fail "a health signal printed a stack frame"
SELF context > /dev/null || fail "context died on an artifact it could not read"
SELF fold > /dev/null || fail "fold died on an artifact it could not read"
# and state can still be recorded, which is what a fold on every event decides
SELF report "$WART" "state still records while an artifact is unreadable" > /dev/null \
    || fail "a report could not be recorded while an artifact was unreadable"
SELF decide "an unreadable artifact does not stop the log" --why "health degrades, commands do not" > /dev/null \
    || fail "a decision could not be recorded while an artifact was unreadable"
grep -q "$ARTID2 .*cannot be read in this store" "$STATE_A" \
    || fail "the folded state lost the unreadable-artifact signal"
rm -rf "$STORE/artifacts/demo/$ARTID2-report.txt"

# the cases a shell cannot build portably: a file that exists and still cannot
# be opened, a path the log points at from outside the store, and the unguarded
# read this replaced
node "$CLI_DIR/proof/artifact-health.mjs" "$ROOT/health-store" || fail "artifact health did not degrade safely"

echo "proof OK"
