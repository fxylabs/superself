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
SELF report "$WID2" "evidence in all states" --evidence "$MERGED" --evidence "$LIVE" --evidence "$DOOMED" --evidence "000000000000"
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
# ── supervision: attempts settle with no chat turn open ─────────────
cd "$ROOT/A/ws/demo"
LOCAL="$ROOT/A/ws/.superself/local"

# each launch writes into its own fence-named directory, so a wrapper from a
# superseded launch can never be mistaken for the run that is current
rundir()
{
    LAST=""
    HIGH=-1
    for CANDIDATE in "$LOCAL"/spool/"$1"/run-*
    do
        if [ -d "$CANDIDATE" ]
        then
            N="${CANDIDATE##*/run-}"
            if [ "$N" -gt "$HIGH" ]
            then
                HIGH="$N"
                LAST="$CANDIDATE"
            fi
        fi
    done
    printf %s "$LAST"
}

# the supervisor waits for the wrapper's exit notice, never for a poll
settled()
{
    for _ in $(seq 1 100)
    do
        DIR="$(rundir "$1")"
        if [ -n "$DIR" ] && [ -f "$DIR/exit" ]
        then
            return 0
        fi
        sleep 0.1
    done
    fail "attempt $1 never wrote an exit notice"
}

# a verdict waits for the launch's own processes to be gone, so a run that was
# killed or timed out is read after ticking to convergence, not after one pass
converge()
{
    for _ in $(seq 1 100)
    do
        if SELF attempt list | grep "$1" | grep -q "settled"
        then
            return 0
        fi
        SELF daemon tick > /dev/null
        sleep 0.1
    done
    fail "attempt $1 never reached a terminal state"
}

# a run states what it did in a completion envelope correlated to its launch.
# nothing else — not an exit code, not prose — can stand in for it.
COMPLETE="node '$CLI_DIR/bin/self.mjs' attempt complete"

SELF overnight show | grep -q "no overnight policy" || fail "an unset overnight policy did not say so"
SELF overnight set --from 00:00 --to 00:00 --wake 07:30 --auto-dispatch --hard-model opus \
    --max-concurrent 4 --budget-usd 50 --retries 0 > /dev/null
SELF overnight show | grep -q "auto-dispatch on" || fail "the overnight policy was not readable back"
SELF overnight show | grep -q "never allowed publish" || fail "the policy did not name the actions it can never grant"

# an approved run finishes while nothing is watching: exit is observed, the
# declared output is hashed and attached, and the work is not thereby done
W1="$(SELF work add "an unattended run produces a verified artifact" | tail -1)"
SELF work start "$W1"
OUT1="$ROOT/out1.txt"
T1="$(SELF attempt register --work "$W1" --runtime proof --model opus --completes \
    --output "$OUT1" --heartbeat 120 \
    --command 'printf built > '"$OUT1"'; printf "wrote the page\n" > "$SUPERSELF_SPOOL/report.md"; '"$COMPLETE"' --resolved-model opus --validation build=passed' | tail -1)"
echo "$T1" | grep -q "^t-" || fail "attempt register did not print an attempt id"
SELF daemon tick | grep -q "dispatched: $T1" || fail "the supervisor did not dispatch an eligible attempt"
settled "$T1"
printf '{"costUsd":0.42,"usage":1234}' > "$(rundir "$T1")/usage.json"
SELF daemon tick > /dev/null
SELF attempt show "$T1" | grep -q "passed" || fail "a run with its declared output did not pass validation"
SELF attempt show "$T1" | grep -q "^exit        confirmed" || fail "a wrapper-written exit was not recorded as confirmed"
SELF artifact list --work "$W1" | grep -q "out1.txt" || fail "the declared output was not attached as an artifact"
[ "$(SELF artifact list --work "$W1" | wc -l | tr -d ' ')" = "1" ] || fail "the artifact was attached more than once"

# a duplicate exit notification changes nothing
DUP="$(SELF attempt exited "$T1" 2>&1 || true)"
echo "$DUP" | grep -q "already settled" || fail "a duplicate exit notice was not ignored"
SELF daemon tick > /dev/null
[ "$(SELF artifact list --work "$W1" | wc -l | tr -d ' ')" = "1" ] || fail "a duplicate exit notice attached the artifact twice"

# passing is not being done: a fresh review session is still owed
SELF work | grep -q "$W1" || fail "work was marked done without the review the policy requires"
grep -q "attempt.awaiting-review" "$LOG_A" || fail "the fresh-review requirement was not recorded"
SAME="$(SELF attempt register --work "$W1" --kind review --runtime proof --model opus 2>&1 || true)"
echo "$SAME" | grep -q "fresh session" || fail "a review was allowed in the implementation's own session"
OUT1R="$ROOT/out1-review.txt"
T1R="$(SELF attempt register --work "$W1" --kind review --runtime proof --model opus --completes \
    --session reviewer --output "$OUT1R" --no-report \
    --command 'printf reviewed > '"$OUT1R"'; '"$COMPLETE"' --resolved-model opus' | tail -1)"
SELF daemon tick > /dev/null
settled "$T1R"
SELF daemon tick > /dev/null
SELF work | grep -q "$W1" && fail "a passing fresh review did not complete the work"

# completion prose with no artifact fails validation and completes nothing
W2="$(SELF work add "prose alone must not close work" | tail -1)"
SELF work start "$W2"
OUT2="$ROOT/out2.txt"
T2="$(SELF attempt register --work "$W2" --runtime validator --model opus --completes --output "$OUT2" \
    --command 'printf "all done, shipped it\n" > "$SUPERSELF_SPOOL/report.md"; '"$COMPLETE"' --resolved-model opus' | tail -1)"
SELF daemon tick > /dev/null
settled "$T2"
SELF daemon tick > /dev/null
SELF attempt show "$T2" | grep -q "declared output \"out2.txt\" is missing" || fail "completion prose passed without its artifact"
SELF work | grep -q "$W2" || fail "an unvalidated attempt marked work done"

# an implementation on the wrong model never passes, whatever it produced
OUT2B="$ROOT/out2b.txt"
T2B="$(SELF attempt register --work "$W2" --runtime validator --model haiku --completes --output "$OUT2B" --no-report \
    --command 'printf built > '"$OUT2B"'; '"$COMPLETE"' --resolved-model haiku' | tail -1)"
SELF daemon tick > /dev/null
settled "$T2B"
SELF daemon tick > /dev/null
SELF attempt show "$T2B" | grep -q "must run on opus" || fail "the hard-model requirement was not enforced overnight"

# a failed process releases its lease and keeps its spool
W3="$(SELF work add "a failed run releases what it held" | tail -1)"
SELF work start "$W3"
T3="$(SELF attempt register --work "$W3" --runtime leaser --lease gpu --no-report \
    --command 'echo working; echo broke >&2; exit 3' | tail -1)"
SELF daemon tick > /dev/null
settled "$T3"
SELF daemon tick > /dev/null
SELF attempt show "$T3" | grep -q "exited with code 3" || fail "a non-zero exit was not recorded as a failure"
SELF daemon status | grep -q "leases: none held" || fail "a failed attempt kept its lease"
grep -q "broke" "$(rundir "$T3")/stderr" || fail "the failed run's spool was not preserved"
SELF attempt show "$T3" | grep -q "cost        unknown" || fail "missing provider data was not shown as unknown"

# a pid that disappears is not a confirmed exit, and neither is a dead heartbeat
T4="$(SELF attempt register --work "$W3" --runtime watcher --no-report --heartbeat 120 --command 'sleep 30' | tail -1)"
SELF attempt run "$T4" > /dev/null
PID4="$(node -e 'const fs=require("fs");let pid="";for(const line of fs.readFileSync(process.argv[1],"utf8").trim().split("\n")){const e=JSON.parse(line);if(e.attempt===process.argv[2]&&e.patch.pid!==undefined&&e.patch.pid!==null)pid=String(e.patch.pid);}process.stdout.write(pid)' "$LOCAL/attempts.jsonl" "$T4")"
kill -9 "$PID4" 2>/dev/null || true
SELF daemon tick > /dev/null
SELF attempt show "$T4" | grep -q "^exit        vanished" || fail "a vanished process was reported as a confirmed exit"
# the wrapper is gone but the command it started is not, so the launch is over
# and the attempt is not: the supervisor contains the group it owns first
SELF attempt list | grep "$T4" | grep -q "settled" && fail "a killed wrapper settled an attempt whose own process was still running"
converge "$T4"
SELF attempt show "$T4" | grep -q "(stale)" || fail "a vanished process was judged instead of left stale"
SELF attempt show "$T4" | grep -q "empty since" || fail "a verdict was reached without observing the process group empty"
T5="$(SELF attempt register --work "$W3" --runtime watcher --no-report --heartbeat 1 --command 'sleep 20' | tail -1)"
SELF attempt run "$T5" > /dev/null
sleep 2
SELF daemon tick > /dev/null
SELF attempt show "$T5" | grep -q "^exit        stale" || fail "a dead heartbeat was not distinguished from an exit"
converge "$T5"
SELF attempt show "$T5" | grep -q "no heartbeat" || fail "the stale reason did not name the heartbeat"

# ── an attempt ends when everything it started has ──────────────────
# the launch owns a process group, so a descendant that outlives the wrapper
# holds the attempt out of every terminal state — and an exit notice written
# by hand cannot settle it either, because a group answers to the kernel
cat > "$ROOT/linger.sh" <<'LINGER'
trap "" TERM
sleep 8
LINGER
WT="$(SELF work add "an attempt ends when everything it started has" | tail -1)"
SELF work start "$WT"
OUTT="$ROOT/outt.txt"
TT="$(SELF attempt register --work "$WT" --runtime tree --lease tree-slot --no-report --heartbeat 3600 --output "$OUTT" \
    --command "sh '$ROOT/linger.sh' & printf built > '$OUTT'; $COMPLETE --resolved-model opus" | tail -1)"
SELF attempt run "$TT" > /dev/null
settled "$TT"
SELF daemon tick | grep -q "$TT — .*the launch started are still running" || fail "an attempt was judged while a process it started was still running"
SELF attempt list | grep "$TT" | grep -q "exited" || fail "the launch's own exit was not recorded"
SELF attempt list | grep "$TT" | grep -q "settled" && fail "an attempt settled with a live process still in the group it owns"
SELF daemon status | grep -q "tree-slot" || fail "an attempt released its lease while its own processes were still running"
SELF attempt exited "$TT" --code 0 > /dev/null
SELF daemon tick > /dev/null
SELF attempt list | grep "$TT" | grep -q "settled" && fail "an exit notice written by hand settled an attempt whose processes were still running"
converge "$TT"
SELF attempt show "$TT" | grep -q "empty since" || fail "the attempt settled without observing the group it owns empty"
SELF attempt show "$TT" | grep -q "(passed)" || fail "a run whose tree finished did not settle on its own evidence"
SELF daemon status | grep -q "leases: none held" || fail "a settled attempt kept the lease its processes had finished with"

# an exit notice nobody signed is a claim, not an exit: the wrapper signs its
# own, and a run reported finished while its whole tree is up is still running
TX="$(SELF attempt register --work "$WT" --runtime tree --no-report --heartbeat 3600 --command 'sleep 8' | tail -1)"
SELF attempt run "$TX" > /dev/null
SELF attempt exited "$TX" --code 0 | grep -q "exit notice recorded" || fail "an exit notice was not recorded"
SELF daemon tick | grep -q "$TX — .*the launch started are still running" || fail "an unsigned exit notice settled a run that was still up"
SELF attempt list | grep "$TX" | grep -q "settled" && fail "an attempt settled on an exit notice while every process it owns was running"
SELF attempt cancel "$TX" > /dev/null
converge "$TX"

# a descendant that starts its own session leaves the launch's ownership with
# it: the supervisor says what it can see, and does not claim the rest
WD="$(SELF work add "ownership ends where the session does" | tail -1)"
SELF work start "$WD"
OUTD="$ROOT/outd.txt"
TD="$(SELF attempt register --work "$WD" --runtime detach --no-report --heartbeat 3600 --output "$OUTD" \
    --command "node -e 'require(\"child_process\").spawn(\"sleep\",[\"4\"],{detached:true,stdio:\"ignore\"}).unref()'; printf built > '$OUTD'; $COMPLETE --resolved-model opus" | tail -1)"
SELF attempt run "$TD" > /dev/null
settled "$TD"
SELF daemon tick > /dev/null
SELF attempt show "$TD" | grep -q "(passed)" || fail "a descendant outside the launch's session held an attempt it does not own"

# work that runs at a provider outlives every local process, so the run claims
# it and nothing local ends the attempt until the claim is released
WH="$(SELF work add "a provider job is released before the attempt is judged" | tail -1)"
SELF work start "$WH"
OUTH="$ROOT/outh.txt"
TH="$(SELF attempt register --work "$WH" --runtime provider --lease provider-slot --no-report --heartbeat 3600 --output "$OUTH" \
    --command "printf built > '$OUTH'; $COMPLETE --resolved-model opus --provider-handle job-99" | tail -1)"
SELF attempt run "$TH" > /dev/null
SELF attempt handle "$TH" --open job-99 | grep -q "will not settle" || fail "a provider claim was not recorded"
settled "$TH"
SELF daemon tick | grep -q "$TH — the provider job it claimed is still open" || fail "an attempt settled while the provider job it claimed was open"
SELF attempt list | grep "$TH" | grep -q "settled" && fail "a local exit settled an attempt that still owned provider work"
# an open claim is a live owner exactly as a running process is, so what the
# launch reserved stays reserved: an attempt held out of settlement that has
# given up its lease is a slot two runs occupy at once
SELF daemon status | grep -q "provider-slot" || fail "an attempt released its lease while the provider job it claimed was still open"
TH2="$(SELF attempt register --work "$WH" --runtime provider --lease provider-slot --no-report --heartbeat 3600 --command 'sleep 30' | tail -1)"
SELF daemon tick | grep -q "lease \"provider-slot\" is held by $TH" || fail "a second attempt dispatched into a lease an open provider claim was still holding"
SELF attempt list | grep "$TH2" | grep -q "registered" || fail "an attempt refused on a held lease did not stay queued"
BADCLOSE="$(SELF attempt handle "$TH" --close job-98 2>&1 || true)"
echo "$BADCLOSE" | grep -q 'claimed provider job "job-99"' || fail "a release naming another job was accepted"
SELF attempt handle "$TH" --close job-99 > /dev/null
SELF daemon tick | grep -q "dispatched: $TH2" || fail "releasing the provider job did not release the lease it was holding"
SELF attempt show "$TH" | grep -q "(passed)" || fail "a released provider job did not let the attempt settle"
SELF attempt show "$TH" | grep -q "^provider    job-99" || fail "the provider job the attempt owned is not on its record"
SELF attempt cancel "$TH2" > /dev/null
converge "$TH2"

# a run that reports provider work it never claimed is refused, not judged:
# an owner the supervisor was never able to watch is not evidence of anything
OUTU="$ROOT/outu.txt"
TU="$(SELF attempt register --work "$WH" --runtime provider --no-report --heartbeat 3600 --output "$OUTU" \
    --command "printf built > '$OUTU'; $COMPLETE --resolved-model opus --provider-handle job-ghost" | tail -1)"
SELF attempt run "$TU" > /dev/null
settled "$TU"
SELF daemon tick > /dev/null
SELF attempt show "$TU" | grep -q "never claimed" || fail "a completion envelope reported provider work the launch never claimed"

# a capacity refusal records retryAt and redispatches after the reset, never before
W4="$(SELF work add "capacity waits for the reset" | tail -1)"
SELF work start "$W4"
OUT6="$ROOT/out6.txt"
T6="$(SELF attempt register --work "$W4" --runtime capacity --no-report --output "$OUT6" \
    --command 'printf built > '"$OUT6"'; '"$COMPLETE" | tail -1)"
FUTURE="$(node -e 'process.stdout.write(new Date(Date.now()+3600000).toISOString())')"
SELF attempt exited "$T6" --code 1 --provider-status capacity --retry-at "$FUTURE" > /dev/null
SELF daemon tick > /dev/null
SELF attempt show "$T6" | grep -q "waiting-capacity" || fail "a capacity response did not park the attempt"
SELF daemon tick | grep -q "waiting on provider capacity" || fail "an attempt redispatched before its capacity reset"
SELF digest --hours 24 | grep -q "^## Waiting on capacity" || fail "the digest did not group capacity waits"
PAST="$(node -e 'process.stdout.write(new Date(Date.now()-1000).toISOString())')"
SELF attempt exited "$T6" --code 1 --provider-status capacity --retry-at "$PAST" > /dev/null
SELF daemon tick | grep -q "dispatched: $T6" || fail "an attempt did not redispatch after its capacity reset"
settled "$T6"
SELF daemon tick > /dev/null
SELF attempt show "$T6" | grep -q "^tries       1" || fail "the capacity redispatch ran more than once"

# three transient failures open the circuit and stop the fan-out
W5="$(SELF work add "a failing runtime stops fanning out" | tail -1)"
SELF work start "$W5"
for n in 1 2 3
do
    TF="$(SELF attempt register --work "$W5" --runtime flaky --no-report --command 'exit 9' | tail -1)"
    SELF daemon tick > /dev/null
    settled "$TF"
    SELF daemon tick > /dev/null
done
SELF daemon circuits | grep -q "demo/flaky  open" || fail "three failures did not open the circuit"
TF4="$(SELF attempt register --work "$W5" --runtime flaky --no-report --command "$COMPLETE" | tail -1)"
SELF daemon tick | grep -q "circuit for demo/flaky is open" || fail "an open circuit did not stop the fan-out"
SELF daemon reset-circuit demo/flaky > /dev/null
SELF daemon tick | grep -q "dispatched: $TF4" || fail "a reset circuit did not let work through"
settled "$TF4"
SELF daemon tick > /dev/null

# a dependency wakes only work that is ready and approved
W6="$(SELF work add "the dependency others wait on" | tail -1)"
W7="$(SELF work add "the unit that waits for it" | tail -1)"
SELF work start "$W6"
OUT7="$ROOT/out7.txt"
T7="$(SELF attempt register --work "$W7" --runtime deps --no-report --after "$W6" --output "$OUT7" \
    --command 'printf built > '"$OUT7"'; '"$COMPLETE" | tail -1)"
SELF daemon tick | grep -q "waiting on $W6" || fail "an attempt ran before its dependency was done"
T8="$(SELF attempt register --work "$W7" --runtime deps --no-report --needs-approval --command "$COMPLETE" | tail -1)"
SELF work done "$W6"
SELF daemon tick | grep -q "dispatched: $T7" || fail "a met dependency did not wake the work waiting on it"
SELF daemon tick | grep -q "$T8 — waiting on human approval" || fail "unapproved work dispatched once its dependency was met"
SELF context | grep -q "waiting on your approval" || fail "the next session was not told what is waiting for approval"
SELF attempt approve "$T8" > /dev/null
SELF daemon tick | grep -q "dispatched: $T8" || fail "an approved attempt did not dispatch"
settled "$T7"
settled "$T8"
SELF daemon tick > /dev/null

# actions that cross a human approval boundary are refused, at launch and mid-run
BADACT="$(SELF attempt register --work "$W5" --runtime actions --action publish --command 'true' 2>&1 || true)"
echo "$BADACT" | grep -q "never allowed" || fail "a forbidden action was accepted at registration"
T9="$(SELF attempt register --work "$W5" --runtime actions --no-report --command 'sleep 20' | tail -1)"
PROPOSE="$(SELF attempt propose "$T9" --action payment 2>&1 || true)"
echo "$PROPOSE" | grep -q "never allowed" || fail "a forbidden action proposed mid-run was accepted"
grep -q "attempt.refused" "$LOG_A" || fail "a refused proposal left no record"
SELF attempt propose "$T9" --action "extra-search" > /dev/null
SELF daemon tick | grep -q "$T9 — waiting on human approval" || fail "an undeclared action did not fall back to approval"

# a cancellation survives the process and the restart
T10="$(SELF attempt register --work "$W5" --runtime actions --no-report --command 'sleep 30' | tail -1)"
SELF attempt run "$T10" > /dev/null
SELF attempt cancel "$T10" > /dev/null
SELF attempt show "$T10" | grep -q "running" || fail "cancel lost the attempt state before the supervisor saw it"
converge "$T10"
SELF attempt show "$T10" | grep -q "cancelled" || fail "a cancellation did not settle the attempt"
SELF attempt list | grep "$T10" | grep -q "cancelled" || fail "the cancellation did not survive into a fresh process"

# external risk never runs unattended, whatever the policy asks for
BADRISK="$(SELF overnight set --risk external 2>&1 || true)"
echo "$BADRISK" | grep -q "waits for a person" || fail "an external-risk overnight policy was accepted"

# the digest groups the night and says unknown where the provider said nothing
DIGEST="$(SELF digest --hours 24)"
echo "$DIGEST" | grep -q "^## Completed" || fail "the digest did not group completed attempts"
echo "$DIGEST" | grep -q "^## Failed" || fail "the digest did not group failed attempts"
echo "$DIGEST" | grep -q "^## Stale" || fail "the digest did not group stale attempts"
echo "$DIGEST" | grep -q "^## Cancelled" || fail "the digest did not group cancelled attempts"
echo "$DIGEST" | grep -q 'cost \$0.42' || fail "the digest did not total the cost the provider reported"
echo "$DIGEST" | grep -q "unknown" || fail "the digest did not say unknown where the provider reported nothing"
echo "$DIGEST" | grep -q "^## Next actions" || fail "the digest did not name what to do next"

# nothing machine-local reaches the synced log, the store history, or the digest
SECRET="sk-proofcredential0123456789"
W8="$(SELF work add "private detail stays on this machine" | tail -1)"
SELF work start "$W8"
OUT8="$ROOT/out8.txt"
T11="$(SELF attempt register --work "$W8" --runtime privacy --output "$OUT8" \
    --command 'printf built > '"$OUT8"'; printf "used '"$SECRET"' to build, wrote '"$OUT8"'\n" > "$SUPERSELF_SPOOL/report.md"; '"$COMPLETE" | tail -1)"
SELF daemon tick > /dev/null
settled "$T11"
SELF daemon tick > /dev/null
grep -q "$SECRET" "$LOG_A" && fail "a credential reached the synced log"
grep -q "redacted" "$LOG_A" || fail "the credential-shaped value was not redacted into the report"
grep -q "SUPERSELF_SPOOL" "$LOG_A" && fail "a launch command reached the synced log"
grep -q '"pid"' "$LOG_A" && fail "a process id reached the synced log"
grep -q "$ROOT/out8.txt" "$LOG_A" && fail "an absolute machine path reached the synced log"
SELF digest --hours 24 | grep -q "$SECRET" && fail "a credential reached the digest"
git -C "$ROOT/A/ws/.superself" ls-files | grep -q "^local/" && fail "machine-local supervisor state leaked into store history"
grep -q "out8.txt" "$LOG_A" || fail "the artifact reference did not reach the synced log"

# the supervised record reaches canonical state and the viewer
STATE_A="$ROOT/A/ws/.superself/projects/demo/state.md"
grep -q "$T11" "$ROOT/A/ws/.superself/projects/demo/work/$W8.md" || fail "the work record does not list its attempts"
grep -q "$T11" "$VIEW_A/demo/$W8.html" || fail "the work page does not show its attempts"
grep -q "ATTEMPTS" "$VIEW_A/demo/$W8.html" || fail "the work page has no attempts panel"

# selfd detects an exit on its own interval, with no command run in between
SELF daemon status | grep -q "not running" || fail "selfd reported itself running before it was started"
W9="$(SELF work add "selfd settles a run with no turn open" | tail -1)"
SELF work start "$W9"
OUT9="$ROOT/out9.txt"
T12="$(SELF attempt register --work "$W9" --runtime nightly --no-report --output "$OUT9" \
    --command 'sleep 1; printf built > '"$OUT9"'; '"$COMPLETE" | tail -1)"
SELF daemon start --interval 1 > /dev/null
OBSERVED=no
for _ in $(seq 1 60)
do
    if SELF attempt list | grep "$T12" | grep -q "settled passed"
    then
        OBSERVED=yes
        break
    fi
    sleep 0.5
done
[ "$OBSERVED" = yes ] || fail "selfd did not settle an attempt within its configured interval"
DPID="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))' "$LOCAL/daemon.json")"
kill -9 "$DPID" 2>/dev/null || true
sleep 0.5
SELF daemon status | grep -q "not running" || fail "a killed supervisor still reported itself running"
SELF daemon start --interval 3600 | grep -q "recovered from a stopped supervisor" || fail "a restart did not report recovering the previous supervisor"
SELF daemon stop | grep -q "stopped" || fail "the supervisor did not stop"
SELF daemon status | grep -q "not running" || fail "a stopped supervisor still reported itself running"

# the policy is versioned and revocable
SELF overnight set --from 23:00 --to 06:00 > /dev/null
SELF overnight show | grep -q "version       2" || fail "the overnight policy did not version"
SELF overnight off > /dev/null
SELF overnight show | grep -q "no overnight policy" || fail "a revoked overnight policy still applied"
T13="$(SELF attempt register --work "$W9" --runtime nightly --no-report --command 'printf x' | tail -1)"
SELF daemon tick | grep -q "no overnight policy is in force" || fail "an attempt dispatched with no policy in force"

# ── settlement is a claim that has to hold up ───────────────────────
JOURNAL="$LOCAL/attempts.jsonl"
SELF overnight set --from 00:00 --to 00:00 --wake 07:30 --auto-dispatch \
    --max-concurrent 12 --retries 0 --no-fresh-review > /dev/null

# a zero exit with its declared output present is still not a result
WA="$(SELF work add "an exit code is a claim, not a result" | tail -1)"
SELF work start "$WA"
OUTA="$ROOT/outa.txt"
TA="$(SELF attempt register --work "$WA" --runtime bare --no-report --output "$OUTA" \
    --command 'printf built > '"$OUTA" | tail -1)"
SELF daemon tick > /dev/null
settled "$TA"
SELF daemon tick > /dev/null
SELF attempt show "$TA" | grep -q "no readable completion envelope" || fail "a zero exit with its output passed with no completion envelope"
SELF attempt show "$TA" | grep -q "(failed)" || fail "an attempt that stated nothing about itself was not failed"

# an envelope that names another launch is refused, not judged
WB="$(SELF work add "a completion envelope is correlated or it is nothing" | tail -1)"
SELF work start "$WB"
OUTB="$ROOT/outb.txt"
TB="$(SELF attempt register --work "$WB" --runtime forged --no-report --output "$OUTB" \
    --command 'printf built > '"$OUTB"'; '"$COMPLETE"' --attempt t-someoneelse' | tail -1)"
SELF daemon tick > /dev/null
settled "$TB"
SELF daemon tick > /dev/null
SELF attempt show "$TB" | grep -q "names attempt" || fail "an envelope naming another attempt was accepted"
SELF attempt show "$TB" | grep -q "(refused)" || fail "a forged completion identity was judged instead of refused"

# an envelope written by a superseded launch cannot settle the current one
OUTC="$ROOT/outc.txt"
TC="$(SELF attempt register --work "$WB" --runtime superseded --no-report --output "$OUTC" \
    --command 'printf built > '"$OUTC"'; '"$COMPLETE"' --fence 99' | tail -1)"
SELF daemon tick > /dev/null
settled "$TC"
SELF daemon tick > /dev/null
SELF attempt show "$TC" | grep -q "written by a superseded process" || fail "an envelope from a stale fence settled the current launch"

# a model resolution has to name the model that answered
OUTD="$ROOT/outd.txt"
TD="$(SELF attempt register --work "$WB" --runtime provenance --no-report --output "$OUTD" \
    --command 'printf built > '"$OUTD"'; '"$COMPLETE"' --model-resolution exact' | tail -1)"
SELF daemon tick > /dev/null
settled "$TD"
SELF daemon tick > /dev/null
SELF attempt show "$TD" | grep -q "without naming the model that answered" || fail "an exact model claim passed without the resolved model"

# a hard-model requirement is not met by an unknown resolution
SELF overnight set --from 00:00 --to 00:00 --wake 07:30 --auto-dispatch \
    --max-concurrent 12 --retries 0 --no-fresh-review --hard-model opus > /dev/null
OUTE="$ROOT/oute.txt"
TE="$(SELF attempt register --work "$WB" --runtime hardmodel --model opus --completes --no-report --output "$OUTE" \
    --command 'printf built > '"$OUTE"'; '"$COMPLETE"' --model-resolution unknown' | tail -1)"
SELF daemon tick > /dev/null
settled "$TE"
SELF daemon tick > /dev/null
SELF attempt show "$TE" | grep -q "rather than naming it" || fail "an unknown model resolution satisfied a hard-model requirement"
SELF overnight set --from 00:00 --to 00:00 --wake 07:30 --auto-dispatch \
    --max-concurrent 12 --retries 0 --no-fresh-review > /dev/null

# ── requirement coverage against the current revision ───────────────
WG="$(SELF work add "coverage is measured against the revision in force" | tail -1)"
SELF work start "$WG"
SELF work require "$WG" "the page renders" > /dev/null
OUTG="$ROOT/outg.txt"
TG="$(SELF attempt register --work "$WG" --runtime cover --completes --no-report --output "$OUTG" \
    --command 'printf built > '"$OUTG"'; '"$COMPLETE" | tail -1)"
SELF daemon tick > /dev/null
settled "$TG"
SELF daemon tick > /dev/null
SELF attempt show "$TG" | grep -q "(passed)" || fail "an attempt covering every criterion did not pass"
SELF work | grep -q "$WG" && fail "a passing attempt that covered its criteria did not complete the work"

# a criterion added while the run worked is a criterion nobody has met
WH="$(SELF work add "a specification that moves is not a run that failed" | tail -1)"
SELF work start "$WH"
SELF work require "$WH" "the first criterion" > /dev/null
OUTH="$ROOT/outh.txt"
TH="$(SELF attempt register --work "$WH" --runtime revision --completes --no-report --output "$OUTH" \
    --command 'printf built > '"$OUTH"'; '"$COMPLETE" | tail -1)"
SELF daemon tick > /dev/null
settled "$TH"
SELF work require "$WH" "a criterion added while the attempt ran" > /dev/null
SELF daemon tick > /dev/null
SELF attempt show "$TH" | grep -q "revision_required" || fail "a stale revision was judged as a plain failure"
SELF attempt show "$TH" | grep -q "is not covered" || fail "the uncovered criterion was not named"
SELF work | grep -q "$WH" || fail "work was completed against a revision nobody built to"
SELF digest --hours 24 | grep -q "^## Needs a revision" || fail "the digest did not group work needing a revision"

# a run cannot claim a criterion the unit does not have
WI="$(SELF work add "coverage of something that was never asked for" | tail -1)"
SELF work start "$WI"
OUTI="$ROOT/outi.txt"
TI="$(SELF attempt register --work "$WI" --runtime invented --completes --no-report --output "$OUTI" \
    --command 'printf built > '"$OUTI"'; '"$COMPLETE"' --requirement r-invented' | tail -1)"
SELF daemon tick > /dev/null
settled "$TI"
SELF daemon tick > /dev/null
SELF attempt show "$TI" | grep -q "not a requirement of" || fail "a run claimed coverage of a criterion that does not exist"
SELF work | grep -q "$WI" || fail "an invented coverage claim completed the work"

# an approved design revision has to be the one that was built against
WJ="$(SELF work add "a run states which approved design it built against" | tail -1)"
SELF work start "$WJ"
OUTJ="$ROOT/outj.txt"
TJ="$(SELF attempt register --work "$WJ" --runtime design --completes --no-report --output "$OUTJ" \
    --command 'printf built > '"$OUTJ"'; '"$COMPLETE" | tail -1)"
SELF work design "$WJ" > /dev/null
SELF daemon tick > /dev/null
settled "$TJ"
SELF daemon tick > /dev/null
SELF attempt show "$TJ" | grep -q "approved design" || fail "a run that predates the approved design closed the work"

# ── a torn final journal line ───────────────────────────────────────
printf '{"ts":"2026-01-01T00:00:00.000Z","attempt":"t-torn","kind":"reg' >> "$JOURNAL"
SELF attempt list | grep -q "$TA" || fail "a torn final journal line made the supervisor unreadable"
SELF daemon tick | grep -q "quarantined" || fail "the torn journal line was not quarantined"
grep -q "t-torn" "$LOCAL/attempts.quarantine.jsonl" || fail "the torn line was not kept as evidence"
SELF attempt list | grep -q "$TA" || fail "repairing the journal lost the entries before the torn line"
SELF attempt show "$TG" | grep -q "(passed)" || fail "repairing the journal changed a settled verdict"

# ── fencing: a superseded process cannot touch the current launch ───
WK="$(SELF work add "a stale worker holds a token that no longer matches" | tail -1)"
SELF work start "$WK"
TK="$(SELF attempt register --work "$WK" --runtime fenced --no-report --heartbeat 3600 --command 'sleep 30' | tail -1)"
SELF attempt run "$TK" > /dev/null
STALEBEAT="$(SELF attempt heartbeat "$TK" --fence 0 2>&1 || true)"
echo "$STALEBEAT" | grep -q "no longer owns" || fail "a heartbeat from a superseded fence was accepted"
STALEEXIT="$(SELF attempt exited "$TK" --fence 0 2>&1 || true)"
echo "$STALEEXIT" | grep -q "no longer owns" || fail "a superseded process settled the current launch"
SELF attempt heartbeat "$TK" --fence 1 > /dev/null || fail "the current fence was refused its own heartbeat"
SELF daemon status | grep -q "fence 1" || fail "the lease did not carry the fence that minted it"
SELF attempt cancel "$TK" > /dev/null
converge "$TK"
SELF attempt show "$TK" | grep -q "cancelled" || fail "a cancelled attempt did not settle as cancelled"

# ── a crash either side of spawn leaves nothing running untracked ───
WL="$(SELF work add "a launch is durable before the process exists" | tail -1)"
SELF work start "$WL"
INTENT='const fs=require("fs");fs.appendFileSync(process.argv[1],JSON.stringify({ts:new Date().toISOString(),attempt:process.argv[2],kind:"launch.intent",patch:{state:"running",fence:1,pid:null,startedAt:process.argv[3],lastBeat:new Date().toISOString(),tries:1}})+"\n");'
NOW="$(node -e 'process.stdout.write(new Date().toISOString())')"
LONGAGO="$(node -e 'process.stdout.write(new Date(Date.now()-120000).toISOString())')"

# a launch journalled a moment ago has not necessarily reached the wrapper's
# first statement yet, so "no pid recorded" is not evidence that nothing
# started: requeueing there would dispatch a second launch into a tree the
# first one is still running
TL="$(SELF attempt register --work "$WL" --runtime orphan --no-report --heartbeat 3600 --command 'sleep 30' | tail -1)"
node -e "$INTENT" "$JOURNAL" "$TL" "$NOW"
SELF daemon tick | grep -q "$TL has not reported a pid yet" || fail "a launch inside its own spawn window was requeued before it could report a pid"
SELF attempt list | grep "$TL" | grep -q "running" || fail "a launch still inside its spawn window did not keep what it held"
node -e "$INTENT" "$JOURNAL" "$TL" "$LONGAGO"
SELF daemon tick | grep -q "never spawned" || fail "a launch journalled before a crash was not returned to the queue"

TM="$(SELF attempt register --work "$WL" --runtime adopt --no-report --heartbeat 3600 --command 'sleep 30' | tail -1)"
sleep 60 &
ORPHAN=$!
mkdir -p "$LOCAL/spool/$TM/run-1"
printf %s "$ORPHAN" > "$LOCAL/spool/$TM/run-1/pid"
node -e "$INTENT" "$JOURNAL" "$TM" "$NOW"
SELF daemon tick | grep -q "adopted" || fail "a process spawned before the crash was left running untracked"
SELF attempt show "$TM" | grep -q "running" || fail "the adopted process was not tracked as running"
kill "$ORPHAN" 2>/dev/null || true
wait "$ORPHAN" 2>/dev/null || true
SELF daemon tick > /dev/null
SELF attempt show "$TM" | grep -q "vanished" || fail "the adopted process was not reconciled once it died"

# a launch of this supervisor's is spawned detached, so its wrapper leads a
# session and the group outlives it. Recovery must take that group from the
# launch's own spool rather than ask a pid that is already gone whether it
# still leads one — the descendants are exactly what the attempt has to
# answer for, and they are all that is left by the time the crash is noticed
cat > "$ROOT/outlive.sh" <<'OUTLIVE'
trap "" TERM
sleep 6
OUTLIVE
TP="$(SELF attempt register --work "$WL" --runtime session --no-report --heartbeat 3600 --command 'true' | tail -1)"
PSPOOL="$LOCAL/spool/$TP/run-1"
mkdir -p "$PSPOOL"
PSTART="$(node -e 'process.stdout.write(new Date().toISOString())')"
node -e 'const {spawn}=require("child_process");const d=process.argv[1];
spawn("/bin/sh",["-c",`printf %s "$$" > ${d}/pid.part; mv ${d}/pid.part ${d}/pid; sh ${process.argv[2]} & exit 0`],
    {detached:true,stdio:"ignore"}).unref();' "$PSPOOL" "$ROOT/outlive.sh"
for _ in $(seq 1 50)
do
    [ -f "$PSPOOL/pid" ] && break
    sleep 0.1
done
[ -f "$PSPOOL/pid" ] || fail "the detached wrapper never recorded its own pid"
WRAPPED="$(cat "$PSPOOL/pid")"
for _ in $(seq 1 50)
do
    kill -0 "$WRAPPED" 2>/dev/null || break
    sleep 0.1
done
kill -0 "$WRAPPED" 2>/dev/null && fail "the wrapper did not exit ahead of the descendant it started"
node -e "$INTENT" "$JOURNAL" "$TP" "$PSTART"
# one pass adopts the group, reads the wrapper as gone, and still refuses to
# judge the attempt: the containment it sends is aimed at the descendants
RECOVER="$(SELF daemon tick)"
echo "$RECOVER" | grep -q "adopted $TP" || fail "a session leader spawned before the crash was not adopted from its own spool"
echo "$RECOVER" | grep -q "$TP — .*the launch started are still running" || fail "an attempt settled while a descendant of the group it owns was still running"
SELF attempt list | grep "$TP" | grep -q "settled" && fail "a wrapper that had already exited settled an attempt whose descendants were alive"
converge "$TP"
SELF attempt show "$TP" | grep -q "empty since" || fail "the recovered attempt settled without observing the group it owns empty"

# the window between spawn and the wrapper's very first write is the one no
# pid file can cover. The spool of the launch is in the command line of the
# process the supervisor started, so the group is recovered from the process
# table instead of being requeued out from under itself
TS="$(SELF attempt register --work "$WL" --runtime marked --no-report --heartbeat 3600 --command 'sleep 8' | tail -1)"
SELF attempt run "$TS" > /dev/null
PSTABLE="$(ps -A -ww -o command=)"
echo "$PSTABLE" | grep -q "superself-launch:$TS:1" || fail "a real launch does not name itself in its own command line"
SELF attempt cancel "$TS" > /dev/null
converge "$TS"

TQ="$(SELF attempt register --work "$WL" --runtime nopid --no-report --heartbeat 3600 --command 'true' | tail -1)"
QSPOOL="$LOCAL/spool/$TQ/run-1"
mkdir -p "$QSPOOL"
QSTART="$(node -e 'process.stdout.write(new Date().toISOString())')"
node -e 'const {spawn}=require("child_process");
spawn("/bin/sh",["-c",`: ${process.argv[1]}; sleep 25; :`],{detached:true,stdio:"ignore"}).unref();' "superself-launch:$TQ:1"
[ -f "$QSPOOL/pid" ] && fail "the no-pid window under test wrote a pid after all"
node -e "$INTENT" "$JOURNAL" "$TQ" "$QSTART"
SELF daemon tick | grep -q "adopted $TQ" || fail "a launch that had spawned but written no pid was not found in the process table"
SELF attempt list | grep "$TQ" | grep -q "running" || fail "a spawned launch with no pid file was requeued while its own tree was alive"
SELF attempt cancel "$TQ" > /dev/null
converge "$TQ"

# ── two ticks racing settle exactly one outcome ─────────────────────
WN="$(SELF work add "two supervisors must not both settle one attempt" | tail -1)"
SELF work start "$WN"
OUTN="$ROOT/outn.txt"
TN="$(SELF attempt register --work "$WN" --runtime raced --no-report --output "$OUTN" \
    --command 'printf built > '"$OUTN"'; '"$COMPLETE" | tail -1)"
SELF daemon tick > /dev/null
settled "$TN"
SELF daemon tick > /dev/null 2>&1 &
RACE1=$!
SELF daemon tick > /dev/null 2>&1 &
RACE2=$!
wait "$RACE1" || fail "a concurrent tick failed outright"
wait "$RACE2" || fail "a concurrent tick failed outright"
[ "$(SELF artifact list --work "$WN" | wc -l | tr -d ' ')" = "1" ] || fail "two concurrent ticks attached the artifact twice"
REPORTS="$(grep -c "\"work\":\"$WN\"" "$LOG_A" || true)"
SELF attempt show "$TN" | grep -q "(passed)" || fail "a raced settlement lost its verdict"

# an interrupted settlement replays onto the same ids, never a second set
node -e 'const fs=require("fs");const f=process.argv[1];const id=process.argv[2];
const kept=fs.readFileSync(f,"utf8").split("\n").filter((l)=>l.trim()!=="").filter((l)=>{const e=JSON.parse(l);return !(e.attempt===id&&e.kind==="settle.commit");});
fs.writeFileSync(f,kept.join("\n")+"\n");' "$JOURNAL" "$TN"
SELF daemon tick | grep -q "resumed the settlement" || fail "an interrupted settlement was not replayed after the crash"
[ "$(SELF artifact list --work "$WN" | wc -l | tr -d ' ')" = "1" ] || fail "replaying a settlement ingested the artifact twice"
AFTER="$(grep -c "\"work\":\"$WN\"" "$LOG_A" || true)"
[ "$REPORTS" = "$AFTER" ] || fail "replaying a settlement wrote a second report for the same attempt"
SELF attempt show "$TN" | grep -q "(passed)" || fail "the replayed settlement did not converge on the same verdict"

# ── the scheduler's place in the journal is durable ─────────────────
[ -f "$LOCAL/cursors.json" ] || fail "the scheduler kept no durable cursor"
grep -q "scheduler" "$LOCAL/cursors.json" || fail "the scheduler subscription was not persisted"
BEFORE_WAKE="$(grep -c "work.unblocked" "$LOG_A" || true)"
rm -f "$LOCAL/cursors.json"
SELF daemon tick > /dev/null
AFTER_WAKE="$(grep -c "work.unblocked" "$LOG_A" || true)"
[ "$BEFORE_WAKE" = "$AFTER_WAKE" ] || fail "replaying the journal from a lost cursor woke work a second time"
grep -q "scheduler" "$LOCAL/cursors.json" || fail "the scheduler did not re-establish its subscription"

# ── the launcher owns the capability profile ────────────────────────
UNKNOWN="$(SELF attempt register --work "$WN" --runtime hostile --action http-post --command 'true' 2>&1 || true)"
echo "$UNKNOWN" | grep -q "not a capability the launcher grants" || fail "an unrecognised action was granted by default"
CRED="$(SELF attempt register --work "$WN" --runtime hostile --action credential-forward --command 'true' 2>&1 || true)"
echo "$CRED" | grep -q "never allowed" || fail "credential forwarding was accepted at registration"
NET="$(SELF attempt register --work "$WN" --runtime hostile --action network --command 'true' 2>&1 || true)"
echo "$NET" | grep -q "never allowed" || fail "an unapproved network capability was accepted at registration"
EXT="$(SELF attempt register --work "$WN" --runtime hostile --risk external --action build --command 'true' 2>&1 || true)"
echo "$EXT" | grep -q "waits for a person" || fail "external-risk work was given a capability profile"

# a lying completion envelope cannot widen what the launch was given
WO="$(SELF work add "prose and envelopes do not grant capabilities" | tail -1)"
SELF work start "$WO"
OUTO="$ROOT/outo.txt"
TO="$(SELF attempt register --work "$WO" --runtime hostile --no-report --output "$OUTO" \
    --command 'printf built > '"$OUTO"'; '"$COMPLETE"' --action publish' | tail -1)"
SELF daemon tick > /dev/null
settled "$TO"
SELF daemon tick > /dev/null
SELF attempt show "$TO" | grep -q "which the launcher never granted" || fail "a completion envelope widened its own capabilities"
SELF attempt show "$TO" | grep -q "(refused)" || fail "a lying completion envelope was judged instead of refused"
SELF artifact list --work "$WO" | grep -q "outo.txt" && fail "a refused attempt attached its output anyway"

# the launched process gets the variables a build needs, not the machine's
export PROOF_FAKE_TOKEN="sk-mustnotreachtherun0123456789"
WP="$(SELF work add "a run does not inherit this machine's credentials" | tail -1)"
SELF work start "$WP"
OUTP="$ROOT/outp.txt"
TP="$(SELF attempt register --work "$WP" --runtime envcheck --no-report --output "$OUTP" \
    --command 'printf "[${PROOF_FAKE_TOKEN:-absent}]" > '"$OUTP"'; '"$COMPLETE" | tail -1)"
SELF daemon tick > /dev/null
settled "$TP"
grep -q "absent" "$OUTP" || fail "the launched command inherited the machine's environment"
unset PROOF_FAKE_TOKEN
SELF daemon tick > /dev/null

# ── declared outputs that share a basename ──────────────────────────
mkdir -p "$ROOT/da" "$ROOT/db"
WQ="$(SELF work add "two outputs may share a name and neither may be lost" | tail -1)"
SELF work start "$WQ"
TQ="$(SELF attempt register --work "$WQ" --runtime collide --no-report \
    --output "$ROOT/da/same.txt" --output "$ROOT/db/same.txt" \
    --command 'printf first > '"$ROOT"'/da/same.txt; printf second > '"$ROOT"'/db/same.txt; '"$COMPLETE" | tail -1)"
SELF daemon tick > /dev/null
settled "$TQ"
SELF daemon tick > /dev/null
SELF attempt show "$TQ" | grep -q "da/same.txt" || fail "colliding output basenames were not disambiguated"
SELF attempt show "$TQ" | grep -q "db/same.txt" || fail "one of two colliding outputs was dropped"
[ "$(SELF artifact list --work "$WQ" | wc -l | tr -d ' ')" = "2" ] || fail "a colliding output was not attached"

# the artifact is the bytes that were hashed, not whatever the path holds later
printf tampered > "$ROOT/da/same.txt"
grep -rq "tampered" "$ROOT/A/ws/.superself/artifacts/demo/" && fail "an artifact was ingested from its path after validation instead of from the bytes that were hashed"
SELF daemon tick > /dev/null

# unknown cost is never a cost of zero
SELF digest --hours 24 | grep -q "cost unknown for" || fail "attempts whose provider reported nothing were folded into the total as zero"

echo "proof OK"
