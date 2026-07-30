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

# opening an artifact from a run with no terminal resolves the path and leaves
# the desktop alone. This proof is such a run, so the stubs ahead of the real
# launchers on PATH are what would record a window nobody asked for; the whole
# table of contexts the guard must refuse is driven in gui-launch.mjs.
LAUNCHERS="$ROOT/launchers"
LAUNCHED="$ROOT/launched.log"
mkdir -p "$LAUNCHERS"
for NAME in open xdg-open explorer
do
    printf '#!/bin/sh\nprintf "%%s\\n" "$@" >> %s\n' "$LAUNCHED" > "$LAUNCHERS/$NAME"
    chmod +x "$LAUNCHERS/$NAME"
done
OPENED="$(PATH="$LAUNCHERS:$PATH" node "$CLI_DIR/bin/self.mjs" artifact open "$AID")" || fail "artifact open did not exit zero without a terminal"
echo "$OPENED" | grep -q "artifacts/demo/$AID-launch.html" || fail "artifact open did not print the resolved path"
echo "$OPENED" | grep -q "suppressed" || fail "artifact open did not say the GUI launch was suppressed"
VIEWED="$(PATH="$LAUNCHERS:$PATH" node "$CLI_DIR/bin/self.mjs" view demo)" || fail "view did not exit zero without a terminal"
echo "$VIEWED" | grep -q "suppressed" || fail "view did not say the GUI launch was suppressed"
# a detached launcher writes after the command returns, so the absence is read
# on a deadline: a bare check here would pass while a window was still opening.
WAITED=0
while [ "$WAITED" -lt 10 ] && [ ! -f "$LAUNCHED" ]
do
    sleep 0.1
    WAITED=$((WAITED + 1))
done
[ -f "$LAUNCHED" ] && fail "a launcher ran from a session with no terminal: $(cat "$LAUNCHED")"
node "$CLI_DIR/proof/gui-launch.mjs" > /dev/null || fail "the GUI launch guard does not hold across the contexts it must refuse"
node "$CLI_DIR/proof/attempt-boundary-marker.mjs" > /dev/null || fail "the attempt boundary does not mark the children the guard has to refuse"

# the same command under a real pseudo-terminal, carrying the marker `self
# attempt run` gives every child it starts. A terminal on both ends is exactly
# what a harness hands its agent, and it is the context the piped run above
# cannot speak for: with the marker read only after the tty, this row opened a
# window on the operator's desktop.
if command -v script > /dev/null 2>&1
then
    rm -f "$LAUNCHED"
    if script --version > /dev/null 2>&1
    then
        PTY_OPENED="$(PATH="$LAUNCHERS:$PATH" SUPERSELF_SESSION=at-proof script -qec "node $CLI_DIR/bin/self.mjs artifact open $AID" /dev/null)"
    else
        PTY_OPENED="$(PATH="$LAUNCHERS:$PATH" SUPERSELF_SESSION=at-proof script -q /dev/null node "$CLI_DIR/bin/self.mjs" artifact open "$AID")"
    fi
    echo "$PTY_OPENED" | grep -q "suppressed" || fail "artifact open launched from an attempt run holding a pty"
    WAITED=0
    while [ "$WAITED" -lt 10 ] && [ ! -f "$LAUNCHED" ]
    do
        sleep 0.1
        WAITED=$((WAITED + 1))
    done
    [ -f "$LAUNCHED" ] && fail "a launcher ran from an attempt run holding a pty: $(cat "$LAUNCHED")"
else
    echo "note: no script(1) on this machine — the pty row of the GUI guard was not run here" >&2
fi

# work listing and detail are workspace reads, reachable from any directory:
# a bare id resolves its owning project, --project names one explicitly, and
# the output matches the linked checkout's byte for byte
INSIDE_SHOW="$(cd "$ROOT/A/ws/demo" && SELF work show "$WID")"
cd "$ROOT"
SELF work --project demo | grep -q "$WID" || fail "work --project did not list from a non-project directory"
[ "$(SELF work show "$WID")" = "$INSIDE_SHOW" ] || fail "cross-project work show differs from the linked-checkout output"
[ "$(SELF work show "$WID" --project demo)" = "$INSIDE_SHOW" ] || fail "work show --project differs from the linked-checkout output"
cd "$ROOT/outside/app"
[ "$(SELF work show "$WID")" = "$INSIDE_SHOW" ] || fail "work show from another project's checkout did not resolve the owner"
cd "$ROOT"
NOID="$(SELF work show w-nosuch 2>&1 || true)"
echo "$NOID" | grep -q 'unknown work id "w-nosuch"' || fail "an id in no project lost the unknown-id error"
NOPROJ="$(SELF work --project nosuch 2>&1 || true)"
echo "$NOPROJ" | grep -q 'unknown project "nosuch"' || fail "an unregistered --project slug was accepted"
# every verb that writes still requires the linked checkout
STARTOUT="$(SELF work start "$WID" 2>&1 || true)"
echo "$STARTOUT" | grep -q "not inside a registered project" || fail "a work mutation escaped the checkout boundary"
BARELIST="$(SELF work 2>&1 || true)"
echo "$BARELIST" | grep -q "not inside a registered project" || fail "a bare work list escaped the checkout boundary"
cd "$ROOT/A/ws/demo"

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

# ---------------------------------------------------------------------------
# Runner attempts. A work unit must not spend a provider call until the
# capabilities it declared are proven inside the boundary the provider will run
# in, and the terminal must never be the store of record or the control plane.
# ---------------------------------------------------------------------------
machine A
cd "$ROOT/A/ws/demo"
WATT="$(SELF work add "a runner attempt proves its capabilities before it spends one" | tail -1)"
SELF work start "$WATT" > /dev/null

AGENT="$CLI_DIR/proof/attempt-agent.mjs"
MKPLAN="$CLI_DIR/proof/attempt-plan.mjs"
DEMO="$ROOT/A/ws/demo"
mkdir -p "$ROOT/dest"
cat > "$ROOT/validate.mjs" <<'VALIDATE'
import { readFileSync } from "node:fs";
process.exit(readFileSync(process.argv[2], "utf8").includes("INVALID") ? 1 : 0);
VALIDATE
cat > "$ROOT/browser-probe.mjs" <<'BROWSER'
process.stderr.write("no signed-in tab is reachable from this boundary\n");
process.exit(1);
BROWSER

plan()
{
    local file="$1"
    shift
    node "$MKPLAN" "$file" "work=$WATT" "agent=$AGENT" "cwd=$DEMO" "$@"
}
attempts_of()
{
    SELF attempt list --work "$WATT" | awk '{print $1}'
}
last_attempt()
{
    attempts_of | tail -1
}
attempt_state()
{
    SELF attempt show "$1" | sed -n 's/^state *//p' | awk '{print $1}'
}
count_events()
{
    grep -c "\"type\":\"$1\"" "$LOG_A" || true
}
spool_of()
{
    echo "$ROOT/A/home/.local/state/superself/runner/attempts/$1"
}
# Kills the runner process the attempt recorded, and the provider it started.
# `SELF … &` backgrounds a shell function, so $! is the wrapping subshell: the
# runner would survive it and keep heartbeating, and nothing would look crashed.
crash_runner()
{
    local pid
    pid="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))' "$(spool_of "$1")/status.json")"
    pkill -9 -P "$pid" 2>/dev/null || true
    kill -9 "$pid" 2>/dev/null || true
}

# a plan whose work unit does not exist never reaches the provider: self
# context is a read capability, and it is checked before anything is spent
plan "$ROOT/p-context.json" "mode=ok" "marker=$ROOT/ran-context"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.work="w-nosuch";require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-context.json"
CTX="$(SELF attempt run "$ROOT/p-context.json" 2>&1 || true)"
echo "$CTX" | grep -q "context   w-nosuch" || fail "read preflight did not fail on unavailable self context"
echo "$CTX" | grep -q "No provider was invoked" || fail "the capability request did not state that no attempt was spent"
[ -f "$ROOT/ran-context" ] && fail "the provider ran despite an unavailable self context"

# the exact artifact directory, not its parent and not the permission bits: a
# directory that cannot actually be written fails before the provider starts
mkdir -p "$ROOT/readonly"
if [ "$(id -u)" != "0" ]
then
    chmod 500 "$ROOT/readonly"
    plan "$ROOT/p-write.json" "mode=ok" "dest=$ROOT/readonly/design.md" "marker=$ROOT/ran-write"
    WRITE="$(SELF attempt run "$ROOT/p-write.json" 2>&1 || true)"
    echo "$WRITE" | grep -q "write     $ROOT/readonly" || fail "write preflight did not name the unwritable artifact directory"
    [ -f "$ROOT/ran-write" ] && fail "the provider ran despite an unwritable artifact directory"
    chmod 700 "$ROOT/readonly"
fi

# provider reachability and task-domain reachability are two answers, not one
plan "$ROOT/p-domain.json" "mode=ok" "provider=http://localhost:1/" "domains=task-domain.invalid" "marker=$ROOT/ran-domain"
DOMAIN="$(SELF attempt run "$ROOT/p-domain.json" 2>&1 || true)"
echo "$DOMAIN" | grep -q "network   task-domain.invalid" || fail "network preflight did not name the unreachable task domain"
echo "$DOMAIN" | grep -q "provider  " && fail "an unreachable task domain was reported as a provider failure"
[ -f "$ROOT/ran-domain" ] && fail "the provider ran despite an unreachable task domain"
plan "$ROOT/p-provider.json" "mode=ok" "provider=https://provider-host.invalid" "marker=$ROOT/ran-provider"
PROVIDER="$(SELF attempt run "$ROOT/p-provider.json" 2>&1 || true)"
echo "$PROVIDER" | grep -q "provider  provider-host.invalid" || fail "provider preflight did not name the unreachable provider endpoint"

# browser work stops before the provider when the signed-in tab is unreachable
plan "$ROOT/p-browser.json" "mode=ok" "browser=$ROOT/browser-probe.mjs" "marker=$ROOT/ran-browser"
BROWSE="$(SELF attempt run "$ROOT/p-browser.json" 2>&1 || true)"
echo "$BROWSE" | grep -q "browser   https://mail.example.invalid/inbox" || fail "browser preflight did not name the required tab"
[ -f "$ROOT/ran-browser" ] && fail "the provider ran despite an unreachable browser tab"

# The mismatch that spent whole attempts: the capability was probed on the host
# and the provider was then launched inside a sandbox that denied it. Both
# sides are proven here from one capability and one launcher.
#
# First the host boundary, where the old probe lived: git is on this machine,
# the probe clears it, and the provider runs.
command -v git > /dev/null || fail "the proof needs git on PATH to state what the host probe would have cleared"
plan "$ROOT/p-host.json" "mode=ok" "tools=git" "marker=$ROOT/ran-host"
SELF attempt run "$ROOT/p-host.json" > /dev/null || fail "the host boundary did not clear a capability the host plainly has"
[ -f "$ROOT/ran-host" ] || fail "a cleared preflight did not reach the provider"

# Now the same capability behind a launcher that strips PATH on the way in.
# The old host probe would have cleared this identically; the same-boundary
# probe must not, and the provider must never start.
plan "$ROOT/p-boundary.json" "mode=ok" "tools=git" "wrapper=[\"/bin/sh\",\"-c\",\"PATH=/nonexistent exec \\\"\$@\\\"\",\"sh\"]" "marker=$ROOT/ran-boundary"
BOUNDARY="$(SELF attempt run "$ROOT/p-boundary.json" 2>&1 || true)"
echo "$BOUNDARY" | grep -q "tool      git" || fail "the capability probe answered for the host instead of the launch boundary"
echo "$BOUNDARY" | grep -q "probe and launch identity" || fail "a launcher that rewrote the boundary was not detected"
[ -f "$ROOT/ran-boundary" ] && fail "the provider ran inside a boundary the probe never cleared"
AT_DRIFT="$(last_attempt)"
[ "$(attempt_state "$AT_DRIFT")" = "preflight-failed" ] || fail "a boundary the probe never cleared did not fail closed"
SELF attempt show "$AT_DRIFT" | grep -q "^boundary   " || fail "the receipt did not record the boundary the probe ran in"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const field of ["attempt", "fence", "nodeId", "bootId", "adapter", "boundaryDigest", "policyDigest"]) {
    if (r[field] === undefined || r[field] === null || r[field] === "") { console.error("receipt is missing " + field); process.exit(1); }
}
if (r.ok !== false) { console.error("a receipt with a failed check claimed to be ok"); process.exit(1); }
' "$(spool_of "$AT_DRIFT")/preflight.json" || fail "the durable receipt does not bind the attempt to its boundary and policy"

# a clean attempt: capabilities cleared, artifact published atomically, and
# exactly one report attached to the work unit
REPORTS_BEFORE="$(count_events report.added)"
plan "$ROOT/p-ok.json" "mode=ok" "dest=$ROOT/dest/design.md" "read=$DEMO" "provider=http://localhost:1/" "marker=$ROOT/ran-ok"
SELF attempt run "$ROOT/p-ok.json" > /dev/null || fail "a fully provisioned attempt did not complete"
AT_OK="$(last_attempt)"
[ "$(attempt_state "$AT_OK")" = "completed" ] || fail "a successful attempt did not reach the completed state"
[ -f "$ROOT/dest/design.md" ] || fail "the declared artifact was not published to its destination"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "a completed attempt did not attach exactly one report"
grep -q "\"attempt\":\"$AT_OK\"" "$LOG_A" || fail "the report does not carry the attempt that produced it"
SELF work show "$WATT" | grep -q "$AT_OK (completed)" || fail "the work record does not show the attempt that completed"
SELF status | grep -q "$AT_OK" && fail "a completed attempt still shows as open machine-local state"

# the same attempt settled twice records nothing twice — neither the report
# nor the completion beside it
COMPLETED_BEFORE="$(count_events run.completed)"
SETTLE="$(SELF attempt settle "$AT_OK")"
echo "$SETTLE" | grep -q "already attached" || fail "settling a reported attempt did not recognise its own report"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "settling an already-reported attempt recorded a duplicate"
[ "$(count_events run.completed)" -eq "$COMPLETED_BEFORE" ] || fail "settling an already-completed attempt recorded a duplicate completion"

# a result larger than any terminal will hold stays complete in the spool
plan "$ROOT/p-big.json" "mode=big" "dest=$ROOT/dest/big.md"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-big.json" "$ROOT/dest/big.md"
SELF attempt run "$ROOT/p-big.json" > /dev/null || fail "the long-result attempt did not complete"
AT_BIG="$(last_attempt)"
SPOOL_BIG="$ROOT/A/home/.local/state/superself/runner/attempts/$AT_BIG"
[ "$(wc -c < "$SPOOL_BIG/run-1.stdout.log")" -gt 2000000 ] || fail "the spool did not keep the whole provider output"
grep -q "COMPLETE-TAIL-MARKER" "$SPOOL_BIG/run-1.stdout.log" || fail "the end of a long result was truncated in the spool"

# provider DNS fails twice, backs off with jitter, then succeeds — one report
# and one artifact, never one per run
REPORTS_BEFORE="$(count_events report.added)"
plan "$ROOT/p-retry.json" "mode=dnsfail" "dest=$ROOT/dest/retry.md" "provider=http://localhost:1/" "maxRuns=3"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-retry.json" "$ROOT/dest/retry.md"
SELF attempt run "$ROOT/p-retry.json" > /dev/null || fail "a transient provider failure was not retried to success"
AT_RETRY="$(last_attempt)"
SPOOL_RETRY="$ROOT/A/home/.local/state/superself/runner/attempts/$AT_RETRY"
[ "$(grep -c 'transient-network' "$SPOOL_RETRY/runs.jsonl")" -eq 2 ] || fail "the two DNS failures were not classified as transient network failures"
node -e '
const runs = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
const backed = runs.filter((r) => r.backoffMs !== undefined);
if (backed.length !== 2) { console.error("expected two backoffs, got " + backed.length); process.exit(1); }
if (backed[1].backoffCapMs <= backed[0].backoffCapMs) { console.error("backoff did not grow"); process.exit(1); }
for (const r of backed) {
    if (r.backoffMs < r.backoffCapMs / 2 || r.backoffMs > r.backoffCapMs) { console.error("jitter left the window"); process.exit(1); }
}
' "$SPOOL_RETRY/runs.jsonl" || fail "retry backoff was not bounded, exponential, and jittered"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "a retried attempt recorded more than one report"
[ "$(SELF artifact list --work "$WATT" | grep -c "retry.md")" -eq 1 ] || fail "a retried attempt stored its artifact more than once"

# a failed run's result envelope must not complete the run after it. A plan
# that declares no artifact is judged on the envelope alone, so a rerun that
# produced nothing would otherwise publish the previous run's summary as its
# own report — the exact "done because it said so" this gate exists to refuse.
REPORTS_BEFORE="$(count_events report.added)"
COMPLETED_BEFORE="$(count_events run.completed)"
rm -f "$ROOT/ran-stale"
plan "$ROOT/p-stale.json" "mode=stale" "provider=http://localhost:1/" "providerName=stale-provider" "maxRuns=2" "marker=$ROOT/ran-stale"
STALE="$(SELF attempt run "$ROOT/p-stale.json" 2>&1 || true)"
[ "$(wc -l < "$ROOT/ran-stale")" -eq 2 ] || fail "the stale-envelope case never reached its second run"
echo "$STALE" | grep -q "completed" && fail "a run that produced nothing completed from the previous run's result envelope"
# and it is told what was missing. An agent that forgets to write its result
# envelope is the commonest misconfiguration there is, and the last line of an
# empty stderr would report it as "failed: unknown — " with nothing after it.
echo "$STALE" | grep -q "no structured result envelope" || fail "a run that exited clean with nothing written was reported with an empty failure detail"
AT_STALE="$(last_attempt)"
[ "$(attempt_state "$AT_STALE")" = "failed" ] || fail "an attempt whose runs left no result of their own did not fail"
[ "$(count_events report.added)" -eq "$REPORTS_BEFORE" ] || fail "a stale result envelope attached the previous run's summary as a report"
[ "$(count_events run.completed)" -eq "$COMPLETED_BEFORE" ] || fail "a stale result envelope claimed a completion"
grep -q "RUN-ONE-STALE-SUMMARY" "$LOG_A" && fail "a previous run's summary reached the synced log"
[ -f "$(spool_of "$AT_STALE")/result.json" ] && fail "the result envelope of a run that never wrote one is still in the spool"

# the bound the plan declares is applied to the provider run itself: a hung
# provider costs that bound, not the runner
plan "$ROOT/p-timeout.json" "mode=slow" "runTimeoutMs=1500" "maxRuns=1"
TIMEOUT="$(SELF attempt run "$ROOT/p-timeout.json" 2>&1 || true)"
echo "$TIMEOUT" | grep -q "did not finish within the 1500ms" || fail "a hung provider was not stopped by the run timeout the plan declared"
AT_TIMEOUT="$(last_attempt)"
[ "$(attempt_state "$AT_TIMEOUT")" = "failed" ] || fail "a run stopped on its own bound did not fail"
grep -q '"timedOut":true' "$(spool_of "$AT_TIMEOUT")/runs.jsonl" || fail "the run record does not say the bound expired"

# a bound past the 32-bit timer range is clamped to 1ms, so a typo'd extra zero
# would kill every run the instant it starts. It is a plan error instead.
plan "$ROOT/p-hugebound.json" "mode=ok" "runTimeoutMs=3000000000"
HUGEBOUND="$(SELF attempt run "$ROOT/p-hugebound.json" 2>&1 || true)"
echo "$HUGEBOUND" | grep -q "past the 2147483647 a timer can hold" || fail "a bound past the timer range was accepted and became an immediate timeout"

# Ctrl-C on a running attempt. The provider leads its own process group so a
# bound or a cancel can reach everything the launcher started, which also takes
# it out of the terminal's — without a handler the operator's most natural way
# to stop an attempt orphans a provider that keeps spending and freezes the
# spool at `running`.
plan "$ROOT/p-interrupt.json" "mode=slow" "idfile=$ROOT/interrupt-id"
rm -f "$ROOT/interrupt-id"
SELF attempt run "$ROOT/p-interrupt.json" > /dev/null 2>&1 &
INTERRUPT_WRAPPER=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/interrupt-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/interrupt-id" ] || fail "the attempt to be interrupted never started"
AT_INTERRUPT="$(cat "$ROOT/interrupt-id")"
INTERRUPT_RUNNER="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))' "$(spool_of "$AT_INTERRUPT")/status.json")"
INTERRUPT_PROVIDER=""
for _ in $(seq 1 200)
do
    INTERRUPT_PROVIDER="$(pgrep -P "$INTERRUPT_RUNNER" 2>/dev/null | head -1)"
    [ -n "$INTERRUPT_PROVIDER" ] && break
    sleep 0.1
done
[ -n "$INTERRUPT_PROVIDER" ] || fail "the attempt to be interrupted never started a provider"
kill -INT "$INTERRUPT_RUNNER"
wait "$INTERRUPT_WRAPPER" 2>/dev/null || true
kill -0 "$INTERRUPT_PROVIDER" 2>/dev/null && fail "stopping the runner left the provider running and spending"
[ "$(attempt_state "$AT_INTERRUPT")" = "cancelled" ] || fail "an interrupted attempt left its spool claiming a runner is still driving it"

# a provider that keeps failing opens the circuit, and the work behind it stays
# queued instead of burning the rest of the queue on the same outage
plan "$ROOT/p-open.json" "mode=alwaysdns" "provider=http://localhost:1/" "providerName=flaky" "maxRuns=1" "marker=$ROOT/ran-open"
for _ in 1 2 3
do
    SELF attempt run "$ROOT/p-open.json" > /dev/null 2>&1 || true
done
SELF attempt breaker flaky | grep -q "open" || fail "a persistent provider failure did not open the circuit"
QUEUED="$(SELF attempt run "$ROOT/p-open.json" 2>&1 || true)"
echo "$QUEUED" | grep -q "circuit breaker for provider \"flaky\" is open" || fail "an open circuit did not stop the next attempt"
echo "$QUEUED" | grep -q "stays queued and no attempt was spent" || fail "an open circuit did not leave the work recoverable"
AT_QUEUED="$(last_attempt)"
[ "$(attempt_state "$AT_QUEUED")" = "waiting-provider" ] || fail "an attempt behind an open circuit was not left waiting"
[ "$(grep -c "run 4" "$ROOT/ran-open")" -eq 0 ] 2>/dev/null || fail "an open circuit still reached the provider"
SELF work show "$WATT" | grep -q "Status: active" || fail "an open circuit moved the work unit out of active"
SELF attempt breaker flaky --reset | grep -q "reset" || fail "the circuit breaker could not be reset"

# a cooled-down breaker lets exactly one attempt through, and an attempt that
# stops in preflight never touched the provider: it must not be the one that
# spends the trial the whole queue is waiting on
plan "$ROOT/p-trial.json" "mode=alwaysdns" "provider=http://localhost:1/" "providerName=trialprov" "maxRuns=1"
for _ in 1 2 3
do
    SELF attempt run "$ROOT/p-trial.json" > /dev/null 2>&1 || true
done
TRIAL_FILE="$(node -e 'process.stdout.write(process.argv[1] + "/.local/state/superself/runner/breakers/" + require("crypto").createHash("sha256").update("trialprov").digest("hex").slice(0, 16) + ".json")' "$HOME")"
# backdated past the cooldown, so the next attempt reads the breaker as cooled
# down and may take the one trial it allows
node -e '
const fs = require("fs");
const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (record.state !== "open") { console.error("the trial breaker never opened"); process.exit(1); }
record.openedAt = new Date(Date.now() - 600000).toISOString();
delete record.trialAt;
delete record.trialBy;
fs.writeFileSync(process.argv[1], JSON.stringify(record, null, 2));
' "$TRIAL_FILE" || fail "the trial breaker could not be cooled down"
plan "$ROOT/p-trialblocked.json" "mode=ok" "provider=http://localhost:1/" "providerName=trialprov" "tools=definitely-not-a-real-tool" "marker=$ROOT/ran-trial"
SELF attempt run "$ROOT/p-trialblocked.json" > /dev/null 2>&1 || true
[ "$(attempt_state "$(last_attempt)")" = "preflight-failed" ] || fail "the trial case did not stop in preflight"
[ -f "$ROOT/ran-trial" ] && fail "an attempt that failed preflight still reached the provider"
node -e 'if (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).trialAt !== undefined) { process.exit(1); }' "$TRIAL_FILE" || fail "an attempt that never reached the provider spent the breaker's half-open trial"
SELF attempt breaker trialprov --reset > /dev/null

# the agent may name its own failure class, but it may not spend the whole
# retry budget on a class nothing the runner observed supports — nor push a
# breaker that gates unrelated queued work
rm -f "$ROOT/ran-liar"
plan "$ROOT/p-liar.json" "mode=liar" "provider=http://localhost:1/" "providerName=liar-provider" "maxRuns=5" "marker=$ROOT/ran-liar"
LIAR="$(SELF attempt run "$ROOT/p-liar.json" 2>&1 || true)"
[ "$(wc -l < "$ROOT/ran-liar")" -eq 2 ] || fail "a declared transient class drove more provider runs than the runner allows"
echo "$LIAR" | grep -q "nothing the runner observed supports it" || fail "the runner did not say why it stopped believing the declared class"
SELF attempt breaker liar-provider | grep -q "closed" || fail "a failure only the agent called transient pushed the shared provider breaker"

# a replacement run gets the same immutable brief and the checkpoints the
# previous run left behind
plan "$ROOT/p-resume.json" "mode=checkpoint" "dest=$ROOT/dest/resume.md" "provider=http://localhost:1/" "maxRuns=2" "resume=on"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-resume.json" "$ROOT/dest/resume.md"
SELF attempt run "$ROOT/p-resume.json" > /dev/null || fail "a checkpointed attempt did not complete on its replacement run"
grep -q "resumed=outline" "$ROOT/dest/resume.md" || fail "the replacement run did not receive the previous checkpoint"
AT_RESUME="$(last_attempt)"
SPOOL_RESUME="$ROOT/A/home/.local/state/superself/runner/attempts/$AT_RESUME"
BRIEF_SHA="$(node -e 'const c=require("crypto");const fs=require("fs");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1],"utf8")).digest("hex").slice(0,12))' "$SPOOL_RESUME/brief.md")"
grep -q "brief=$BRIEF_SHA" "$ROOT/dest/resume.md" || fail "the replacement run did not receive the same immutable brief"

# a follow-up sent after launch arrives through the spool, never through stdin
plan "$ROOT/p-followup.json" "mode=followup" "dest=$ROOT/dest/followup.md" "idfile=$ROOT/followup-id"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-followup.json" "$ROOT/dest/followup.md"
rm -f "$ROOT/followup-id"
SELF attempt run "$ROOT/p-followup.json" > /dev/null &
RUNNER_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/followup-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/followup-id" ] || fail "the attempt never reported the id a directive could be addressed to"
AT_FOLLOW="$(cat "$ROOT/followup-id")"
SELF attempt directive "$AT_FOLLOW" "also cover the rollback path" | grep -q "not from a terminal" || fail "the directive was not queued durably"
wait "$RUNNER_PID" || fail "the attempt that received a follow-up did not complete"
grep -q "directive=also cover the rollback path" "$ROOT/dest/followup.md" || fail "the follow-up directive never reached the running attempt"
grep -q "directive.delivered" "$ROOT/A/home/.local/state/superself/runner/attempts/$AT_FOLLOW/events.jsonl" || fail "the spool did not record delivering the directive"

# a crash leaves an attempt that must never read as success
COMPLETED_BEFORE="$(count_events run.completed)"
plan "$ROOT/p-crash.json" "mode=slow" "idfile=$ROOT/crash-id"
rm -f "$ROOT/crash-id"
SELF attempt run "$ROOT/p-crash.json" > /dev/null 2>&1 &
CRASH_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/crash-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/crash-id" ] || fail "the attempt to be crashed never started"
AT_CRASH="$(cat "$ROOT/crash-id")"
# the runner itself, not the shell that launched it: killing the wrapper would
# leave the runner alive and still writing the heartbeat recovery reads
crash_runner "$AT_CRASH"
wait "$CRASH_PID" 2>/dev/null || true
SELF attempt recover | grep -q "recovered 1 attempt" || fail "a crashed attempt was not recovered"
[ "$(attempt_state "$AT_CRASH")" = "exited-unreconciled" ] || fail "a crashed attempt did not read as exited-unreconciled"
[ "$(count_events run.completed)" -eq "$COMPLETED_BEFORE" ] || fail "a crashed attempt claimed a completion"
SELF work show "$WATT" | grep -q "$AT_CRASH (failed" || fail "the work record did not carry the unreconciled attempt"

# a machine restart is recognised on its own, even when the recorded pid is
# alive again because the operating system handed the number out twice
plan "$ROOT/p-reboot.json" "mode=slow" "idfile=$ROOT/reboot-id"
rm -f "$ROOT/reboot-id"
SELF attempt run "$ROOT/p-reboot.json" > /dev/null 2>&1 &
REBOOT_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/reboot-id" ] && break
    sleep 0.1
done
AT_REBOOT="$(cat "$ROOT/reboot-id")"
crash_runner "$AT_REBOOT"
wait "$REBOOT_PID" 2>/dev/null || true
STATUS_REBOOT="$(spool_of "$AT_REBOOT")/status.json"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.bootId="0000000000000000";s.pid=Number(process.argv[2]);fs.writeFileSync(f,JSON.stringify(s,null,2))' "$STATUS_REBOOT" "$$"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_REBOOT")" = "exited-unreconciled" ] || fail "an attempt from before a restart was not recovered"
SELF attempt show "$AT_REBOOT" | grep -q "machine restarted" || fail "the restart was not named as the reason"

# recovery must not claim a false failure either. Proving capabilities takes as
# long as the probe bound allows, and an attempt still in preflight is alive:
# declaring it dead writes a run.failed it never suffered into the synced log.
cat > "$ROOT/slow-browser-probe.mjs" <<'SLOWBROWSER'
const until = Date.now() + 8000;
while (Date.now() < until)
{
    // Deliberately busy: a signed-in tab check that takes real time.
}
SLOWBROWSER
FAILED_BEFORE="$(count_events run.failed)"
plan "$ROOT/p-live.json" "mode=ok" "browser=$ROOT/slow-browser-probe.mjs"
SELF attempt run "$ROOT/p-live.json" > /dev/null 2>&1 &
LIVE_PID=$!
IN_PREFLIGHT=no
for _ in $(seq 1 200)
do
    if SELF attempt list | grep -q "  preflight  run"
    then
        IN_PREFLIGHT=yes
        break
    fi
    sleep 0.1
done
[ "$IN_PREFLIGHT" = yes ] || fail "the attempt never reached preflight for recovery to race"
SELF attempt recover | grep -q "no attempt needed recovery" || fail "recovery declared an attempt still proving its capabilities dead"
wait "$LIVE_PID" || fail "an attempt that recovery looked at during preflight did not complete"
[ "$(count_events run.failed)" -eq "$FAILED_BEFORE" ] || fail "recovery recorded a run.failed for an attempt that then completed"

# the fence is enforced, not merely recorded: a runner whose attempt was taken
# over stops instead of overwriting the verdict that replaced it
REPORTS_BEFORE="$(count_events report.added)"
rm -f "$ROOT/fence-id" "$ROOT/fence-release"
plan "$ROOT/p-fence.json" "mode=hold" "idfile=$ROOT/fence-id" "gate=$ROOT/fence-release"
SELF attempt run "$ROOT/p-fence.json" > "$ROOT/fence.out" 2>&1 &
FENCE_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/fence-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/fence-id" ] || fail "the attempt to be taken over never started"
AT_FENCE="$(cat "$ROOT/fence-id")"
STATUS_FENCE="$(spool_of "$AT_FENCE")/status.json"
FENCE_BEFORE="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).fence))' "$STATUS_FENCE")"
# recovery is made to believe this machine restarted, while the runner it
# would be recovering is in fact still running
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.bootId="0000000000000000";fs.writeFileSync(f,JSON.stringify(s,null,2))' "$STATUS_FENCE"
SELF attempt recover | grep -q "recovered 1 attempt" || fail "recovery did not take over an attempt whose runner it could not see"
node -e '
const held = Number(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).fence);
if (!(held > Number(process.argv[2]))) { console.error("taking an attempt over did not move the fence"); process.exit(1); }
' "$STATUS_FENCE" "$FENCE_BEFORE" || fail "recovery took an attempt over without minting a newer fence"
touch "$ROOT/fence-release"
wait "$FENCE_PID" && fail "a runner that lost its attempt still exited successfully"
grep -q "no longer owns it" "$ROOT/fence.out" || fail "the stale runner was not stopped by the fence"
[ "$(attempt_state "$AT_FENCE")" = "exited-unreconciled" ] || fail "a stale runner overwrote the verdict that replaced it"
[ "$(count_events report.added)" -eq "$REPORTS_BEFORE" ] || fail "a runner that no longer owned its attempt still attached a report"

# ---------------------------------------------------------------------------
# Externally launched attempts. A process the runner did not spawn joins the
# same lifecycle: the spool and the capability receipt exist before anything
# runs, the launcher that started the process claims it, and the exit it
# reports is settled through the same completion gate.
# ---------------------------------------------------------------------------
LAUNCH="$CLI_DIR/proof/external-launch.mjs"
SELF_JS="$CLI_DIR/bin/self.mjs"
launch()
{
    node "$LAUNCH" "$SELF_JS" "$1" "$(spool_of "$1")" "$DEMO" "${@:2}"
}
# The whole exit record, source and code together: the code the launcher
# reported is the one thing a confirmed exit is judged on, and an unconfirmed
# exit must not carry a code nobody reported.
exit_record()
{
    SELF attempt show "$1" | sed -n 's/^exit *//p'
}

# registration is the whole of the runner's work before the launch, and none of
# the launch: capabilities proven, spool written, no process anywhere
REPORTS_BEFORE="$(count_events report.added)"
plan "$ROOT/p-external.json" "mode=ok" "dest=$ROOT/dest/external.md" "read=$DEMO"
AT_EXT="$(SELF attempt register "$ROOT/p-external.json")"
[ "$(attempt_state "$AT_EXT")" = "registered" ] || fail "a registered attempt did not reach the registered state"
[ -f "$(spool_of "$AT_EXT")/preflight.json" ] || fail "registering an attempt did not record its capability receipt"
[ -f "$(spool_of "$AT_EXT")/brief.md" ] || fail "registering an attempt did not write the brief its launch is handed"
node -e 'if (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pid !== undefined) { process.exit(1); }' "$(spool_of "$AT_EXT")/status.json" || fail "a registered attempt recorded a process before one existed"

# and then a launcher of the operator's own drives it to settlement
launch "$AT_EXT" || fail "an externally launched attempt did not settle through the completion gate"
[ "$(attempt_state "$AT_EXT")" = "completed" ] || fail "an externally launched attempt did not reach the completed state"
[ "$(exit_record "$AT_EXT")" = "confirmed (code 0)" ] || fail "an exit a launcher watched happen was not recorded as confirmed with the code it reported"
[ -f "$ROOT/dest/external.md" ] || fail "the externally launched attempt did not publish its declared artifact"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "an externally launched attempt did not attach exactly one report"
SELF work show "$WATT" | grep -q "$AT_EXT (completed)" || fail "the work record does not show the externally launched attempt"
# a settled attempt releases the work unit it was driving: every scenario
# below claims this same unit again, and would be refused if it were held

# a confirmed non-zero exit is judged on the exit, not on the envelope the run
# left behind: `mode=stale` writes a completed envelope and then dies
REPORTS_BEFORE="$(count_events report.added)"
COMPLETED_BEFORE="$(count_events run.completed)"
plan "$ROOT/p-extfail.json" "mode=stale" "maxRuns=1"
AT_EXTFAIL="$(SELF attempt register "$ROOT/p-extfail.json")"
launch "$AT_EXTFAIL" && fail "an externally launched attempt that exited non-zero reported success"
[ "$(attempt_state "$AT_EXTFAIL")" = "failed" ] || fail "a confirmed non-zero exit did not fail the attempt"
[ "$(exit_record "$AT_EXTFAIL")" = "confirmed (code 1)" ] || fail "a reported non-zero exit was not recorded as confirmed with the code the launcher watched"
[ "$(count_events report.added)" -eq "$REPORTS_BEFORE" ] || fail "a failed external exit attached the envelope its run left behind as a report"
[ "$(count_events run.completed)" -eq "$COMPLETED_BEFORE" ] || fail "a failed external exit claimed a completion"

# the exit the launcher watched was its process's, not the whole launch's: a
# background process the payload left in its group is still running when the
# exit is reported, and settlement ends in a write that releases the work
# unit. What survived the payload is contained before anything is let go.
plan "$ROOT/p-linger.json" "mode=linger" "dest=$ROOT/dest/linger.md" "orphanfile=$ROOT/linger-orphan"
AT_LINGER="$(SELF attempt register "$ROOT/p-linger.json")"
launch "$AT_LINGER" || fail "an exit reported over a surviving group member did not settle after containing it"
[ "$(attempt_state "$AT_LINGER")" = "completed" ] || fail "a contained launch did not reach the completed state"
ORPHAN_PID="$(cat "$ROOT/linger-orphan")"
kill -0 "$ORPHAN_PID" 2>/dev/null && fail "settling an external exit released the work unit while a process its launch started was still running"
kill -9 "$ORPHAN_PID" 2>/dev/null || true

# a launcher that walked away: the process finished and nobody ever reported
# its exit, so nothing may be concluded from what is on disk
plan "$ROOT/p-vanish.json" "mode=ok" "dest=$ROOT/dest/vanish.md"
AT_VANISH="$(SELF attempt register "$ROOT/p-vanish.json")"
launch "$AT_VANISH" --abandon --pidfile="$ROOT/vanish-pid" > /dev/null || fail "the abandoned launch was never claimed"
VANISH_PID="$(cat "$ROOT/vanish-pid")"
for _ in $(seq 1 200)
do
    kill -0 "$VANISH_PID" 2>/dev/null || break
    sleep 0.1
done
kill -0 "$VANISH_PID" 2>/dev/null && fail "the abandoned process never finished"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_VANISH")" = "exited-unreconciled" ] || fail "an abandoned external attempt was not recovered"
[ "$(exit_record "$AT_VANISH")" = "vanished" ] || fail "a process that disappeared was not told apart from a reported exit, or was given a code nobody reported"
VANISHED_SETTLE="$(SELF attempt settle "$AT_VANISH" 2>&1 || true)"
echo "$VANISHED_SETTLE" | grep -q "only a confirmed exit" || fail "an attempt whose exit nobody confirmed was offered to the completion gate"
[ -f "$ROOT/dest/vanish.md" ] && fail "an unconfirmed exit published the artifact its process left staged"

# and a live owner that stopped being watched is a third answer again: the
# process is still there, and nothing is driving the attempt. The terminal
# write of recovery releases the work unit, so recovery must first contain
# what the launch started — a unit released over a live group would seat a
# second owner beside the processes of the first.
plan "$ROOT/p-quiet.json" "mode=slow"
AT_QUIET="$(SELF attempt register "$ROOT/p-quiet.json")"
launch "$AT_QUIET" --abandon --pidfile="$ROOT/quiet-pid" > /dev/null || fail "the unwatched launch was never claimed"
QUIET_PID="$(cat "$ROOT/quiet-pid")"
node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,JSON.stringify({ts:new Date(Date.now()-120000).toISOString(),pid:Number(process.argv[2])},null,2))' "$(spool_of "$AT_QUIET")/heartbeat.json" "$QUIET_PID"
kill -0 "$QUIET_PID" 2>/dev/null || fail "the stale-heartbeat case proves nothing if its process had already exited"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_QUIET")" = "exited-unreconciled" ] || fail "an attempt nobody was heartbeating for was not recovered"
[ "$(exit_record "$AT_QUIET")" = "stale" ] || fail "a stale heartbeat was not told apart from a process that disappeared"
kill -0 "$QUIET_PID" 2>/dev/null && fail "recovery released the work unit while the process the launch started was still running"
# a recovered attempt is terminal and holds the work unit no longer: the very
# next scenario claims this same unit, and would be refused if it were held
kill -9 "$QUIET_PID" 2>/dev/null || true

# the crash window inside `self attempt exited`: the launcher reported the
# exit, the status carries it as confirmed, and the process died before the
# terminal write. What was witnessed must survive recovery — reclassified as
# a disappearance it would carry a code nobody reported, and a result the
# gate already published would be forever unsettleable.
plan "$ROOT/p-window.json" "mode=ok" "dest=$ROOT/dest/window.md"
AT_WINDOW="$(SELF attempt register "$ROOT/p-window.json")"
launch "$AT_WINDOW" --abandon --pidfile="$ROOT/window-pid" > /dev/null || fail "the crash-window launch was never claimed"
WINDOW_PID="$(cat "$ROOT/window-pid")"
for _ in $(seq 1 200)
do
    kill -0 "$WINDOW_PID" 2>/dev/null || break
    sleep 0.1
done
kill -0 "$WINDOW_PID" 2>/dev/null && fail "the crash-window process never finished"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.exitSource="confirmed";s.exitCode=0;fs.writeFileSync(f,JSON.stringify(s,null,2))' "$(spool_of "$AT_WINDOW")/status.json"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_WINDOW")" = "exited-unreconciled" ] || fail "a confirmed exit whose settlement crashed was not recovered"
[ "$(exit_record "$AT_WINDOW")" = "confirmed (code 0)" ] || fail "recovery rewrote an exit the launcher reported, or dropped the code it carried"

# a process group id is only reserved while the group has members, so a group
# that empties can have its number handed to somebody else. Nothing a launch
# started can predate the launch, and that is the whole of the guard: a launch
# instant later than every member of the group owns none of them.
plan "$ROOT/p-recycle.json" "mode=slow"
AT_RECYCLE="$(SELF attempt register "$ROOT/p-recycle.json")"
launch "$AT_RECYCLE" --abandon --pidfile="$ROOT/recycle-pid" > /dev/null || fail "the recycled-group launch was never claimed"
RECYCLE_PID="$(cat "$ROOT/recycle-pid")"
node -e 'const fs=require("fs");const f=process.argv[1];const o=JSON.parse(fs.readFileSync(f,"utf8"));o.startedAt=new Date(Date.now()+3600000).toISOString();fs.writeFileSync(f,JSON.stringify(o,null,2))' "$(spool_of "$AT_RECYCLE")/owner.json"
CONTAIN="$(SELF attempt cancel "$AT_RECYCLE")"
echo "$CONTAIN" | grep -q "no signal was sent" || fail "containment was aimed at a process group this launch does not own"
kill -0 "$RECYCLE_PID" 2>/dev/null || fail "a stranger holding a recycled group id was signalled by this attempt's cancel"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_RECYCLE")" = "exited-unreconciled" ] || fail "an attempt whose group holds nothing of its own was left claiming a live owner"
[ "$(exit_record "$AT_RECYCLE")" = "vanished" ] || fail "a recycled process group was counted as this launch's own"
kill -9 "$RECYCLE_PID" 2>/dev/null || true

# and the direction a real recycle takes: the number is handed out only after
# this launch's group emptied, so everything in the stranger group started
# after the launch and ordering alone refuses none of it. What a new group
# cannot fake is its leader — a group with id N is created by a process with
# pid N, and a leader at the wrong instant is a new group wearing this
# launch's number. Moving the recorded launch into the past makes the live
# group exactly that stranger.
plan "$ROOT/p-recycle2.json" "mode=slow"
AT_RECYCLE2="$(SELF attempt register "$ROOT/p-recycle2.json")"
launch "$AT_RECYCLE2" --abandon --pidfile="$ROOT/recycle2-pid" > /dev/null || fail "the post-launch recycle launch was never claimed"
RECYCLE2_PID="$(cat "$ROOT/recycle2-pid")"
node -e 'const fs=require("fs");const f=process.argv[1];const o=JSON.parse(fs.readFileSync(f,"utf8"));const past=new Date(Date.now()-3600000).toISOString();o.startedAt=past;o.leaderStartedAt=past;fs.writeFileSync(f,JSON.stringify(o,null,2))' "$(spool_of "$AT_RECYCLE2")/owner.json"
CONTAIN2="$(SELF attempt cancel "$AT_RECYCLE2")"
echo "$CONTAIN2" | grep -q "no signal was sent" || fail "containment was aimed at a group recycled after this launch emptied it"
kill -0 "$RECYCLE2_PID" 2>/dev/null || fail "a stranger group younger than the recorded launch was signalled by this attempt's cancel"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_RECYCLE2")" = "exited-unreconciled" ] || fail "an attempt whose group was recycled after its launch was left claiming a live owner"
[ "$(exit_record "$AT_RECYCLE2")" = "vanished" ] || fail "a group recycled after the launch was counted as this launch's own"
kill -0 "$RECYCLE2_PID" 2>/dev/null || fail "recovery contained a group this launch does not own"
kill -9 "$RECYCLE2_PID" 2>/dev/null || true

# one live owner per work unit. Two owners driving one unit would each publish
# and each attach a report against the same outcome, and neither would know.
plan "$ROOT/p-lease.json" "mode=slow"
AT_LEASE="$(SELF attempt register "$ROOT/p-lease.json")"
plan "$ROOT/p-lease2.json" "mode=slow"
AT_LEASE2="$(SELF attempt register "$ROOT/p-lease2.json")"
launch "$AT_LEASE" --abandon --pidfile="$ROOT/lease-pid" > /dev/null || fail "the leasing launch was never claimed"
LEASE_PID="$(cat "$ROOT/lease-pid")"
# a claim records the identity every later ownership question is answered
# from: the payload's pid and instant, and the group leader's instant. A
# claim the process table could not time is refused at claim, so no owner
# record without them can exist.
node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(typeof o.pid!=="number"||typeof o.startedAt!=="string"||typeof o.leaderStartedAt!=="string"){process.exit(1);}' "$(spool_of "$AT_LEASE")/owner.json" || fail "a claim was taken without the identity the recycled-group guard is built on"
# a live external owner holds the work unit it is driving: the claim below is
# refused for exactly that reason
CONTENDER="$(SELF attempt started "$AT_LEASE2" --pid "$LEASE_PID" 2>&1 || true)"
echo "$CONTENDER" | grep -q "already being driven by attempt $AT_LEASE" || fail "a second owner was allowed to drive a work unit already being driven"
[ "$(attempt_state "$AT_LEASE2")" = "registered" ] || fail "a refused claim still moved the attempt out of registered"
SELF attempt cancel "$AT_LEASE" | grep -q "has been signalled" || fail "cancelling an externally launched attempt did not reach the group it was launched in"
for _ in $(seq 1 200)
do
    kill -0 "$LEASE_PID" 2>/dev/null || break
    sleep 0.1
done
kill -0 "$LEASE_PID" 2>/dev/null && fail "cancelling an externally launched attempt left its process running and spending"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_LEASE")" = "exited-unreconciled" ] || fail "a cancelled external attempt was not settled by recovery"
# and settling the attempt that held the work unit released it: a fresh claim
# of the same unit is admitted now
RECLAIM_PID="$(node -e 'const p=require("child_process").spawn("sleep",["60"],{detached:true,stdio:"ignore"});p.unref();console.log(p.pid)')"
SELF attempt started "$AT_LEASE2" --pid "$RECLAIM_PID" > /dev/null || fail "settling the attempt that held the work unit did not release it"
SELF attempt exited "$AT_LEASE2" --code 1 > /dev/null 2>&1 || true
kill -9 "$RECLAIM_PID" 2>/dev/null || true

# an artifact claimed in prose with no file behind it fails the gate
REPORTS_BEFORE="$(count_events report.added)"
plan "$ROOT/p-prose.json" "mode=prose" "dest=$ROOT/dest/prose.md"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-prose.json" "$ROOT/dest/prose.md"
PROSE="$(SELF attempt run "$ROOT/p-prose.json" 2>&1 || true)"
echo "$PROSE" | grep -q "claimed in the result envelope but no file was written" || fail "a prose artifact claim passed the completion gate"
[ -f "$ROOT/dest/prose.md" ] && fail "a failed gate published an artifact"

# a declared hash that does not match, and a declared validation that fails
plan "$ROOT/p-hash.json" "mode=mismatch" "dest=$ROOT/dest/hash.md"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-hash.json" "$ROOT/dest/hash.md"
HASH="$(SELF attempt run "$ROOT/p-hash.json" 2>&1 || true)"
echo "$HASH" | grep -q "hashes to" || fail "a hash mismatch passed the completion gate"
plan "$ROOT/p-valid.json" "mode=badvalidate" "dest=$ROOT/dest/valid.md" "validate=$ROOT/validate.mjs"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-valid.json" "$ROOT/dest/valid.md"
VALID="$(SELF attempt run "$ROOT/p-valid.json" 2>&1 || true)"
echo "$VALID" | grep -q "declared validation of \"design.md\" failed" || fail "a failed declared validation passed the completion gate"
[ -f "$ROOT/dest/valid.md" ] && fail "an artifact that failed its validation stayed published"
[ "$(count_events report.added)" -eq "$REPORTS_BEFORE" ] || fail "a failed completion gate still attached a report"

# the spool redacts what a log must never keep, including a secret the model
# was talked into printing
plan "$ROOT/p-secret.json" "mode=secret" "dest=$ROOT/dest/secret.md"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-secret.json" "$ROOT/dest/secret.md"
SELF attempt run "$ROOT/p-secret.json" > /dev/null || fail "the redaction attempt did not complete"
AT_SECRET="$(last_attempt)"
SPOOL_SECRET="$ROOT/A/home/.local/state/superself/runner/attempts/$AT_SECRET"
# the shell and header forms, and the JSON forms the spool itself writes: a
# key's own closing quote sits between its name and the colon, so a rule
# written for NAME=value never reaches a JSON-encoded pair
for LEAK in "sk-live-AAAABBBBCCCCDDDDEEEEFFFF00001111" "abcdefghijklmnopqrstuvwxyz123456" "PROMPTINJECTEDSECRETVALUE" "7fK2xQ9wLm4RtV8yBn3JcZ6pHd5sAe1UgW0oXi2NrTb4Qv" "$ROOT/A/home/private" "JSONPRETTYSECRETVALUE1" "JSONNESTEDSECRETVALUE2" "JSONCOMPACTSECRETVALUE3" "JSONSHORTISHCREDENTIAL4"
do
    grep -q "$LEAK" "$SPOOL_SECRET/run-1.stdout.log" && fail "the spool kept a value a log must redact: $LEAK"
done
grep -q "«redacted»" "$SPOOL_SECRET/run-1.stdout.log" || fail "the spool log was not redacted at all"
# and redaction stops where evidence begins: long output that is plainly not a
# credential survives, or the spool would truncate the results it exists to keep
grep -q "paragraph paragraph" "$SPOOL_SECRET/run-1.stdout.log" || fail "redaction destroyed long output that carried no credential"

# a credential the plan author put in the boundary environment is a literal in
# the plan, so it is in no runner environment the scope could read it from —
# and the spooled plan is written as JSON
plan "$ROOT/p-envsecret.json" "mode=ok" "envsecret=PLANENVSECRETVALUE0001"
SELF attempt run "$ROOT/p-envsecret.json" > /dev/null || fail "the boundary-env secret attempt did not complete"
AT_ENVSECRET="$(last_attempt)"
grep -q "PLANENVSECRETVALUE0001" "$(spool_of "$AT_ENVSECRET")/plan.json" && fail "a secret supplied through boundary.env reached the spooled plan in the clear"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$(spool_of "$AT_ENVSECRET")/plan.json" || fail "redacting the plan left it unreadable — settlement after a crash reads it back"

# and a credential broken across two writes matches nothing on either side of
# the break, so the raw writer holds back what a pattern could still grow into
node "$CLI_DIR/proof/spool-chunks.mjs" || fail "a credential split across chunk boundaries survived the spool's redaction"

# the synced log is committed and pushed, and a capability block names the exact
# path that was missing. The request on that event is already rewritten; the
# list of what is missing has to be too, or one event carries the private path
# both ways
plan "$ROOT/p-privatepath.json" "mode=ok" "read=$HOME/private/secretproject/nothing.key" "marker=$ROOT/ran-privatepath"
SELF attempt run "$ROOT/p-privatepath.json" > /dev/null 2>&1 || true
AT_PRIVATEPATH="$(last_attempt)"
[ "$(attempt_state "$AT_PRIVATEPATH")" = "preflight-failed" ] || fail "a read capability on a missing private path did not block"
grep -q "secretproject" "$LOG_A" || fail "the capability block never reached the synced log"
grep "run.blocked" "$LOG_A" | grep -q "\"read:$HOME/private" && fail "a capability block wrote a raw private home path into the synced log"
grep "run.blocked" "$LOG_A" | grep -q "read:~/private/secretproject" || fail "the missing capability was not named at all once the path was rewritten"

# the lock the machine-local counters are minted under: broken when its holder
# died, never broken out from under a holder that is still there, and never
# released by a process that no longer owns it
node "$CLI_DIR/proof/lock-ownership.mjs" || fail "the counter lock does not hold under contention"

# a declared secret too short to redact by value is said out loud rather than
# left silently uncovered
export PROOF_TINY_SECRET="ab"
plan "$ROOT/p-tiny.json" "mode=ok" "secrets=PROOF_TINY_SECRET"
TINY="$(SELF attempt run "$ROOT/p-tiny.json" 2>&1 || true)"
echo "$TINY" | grep -q "PROOF_TINY_SECRET is shorter than" || fail "a declared secret too short to redact by value was accepted silently"
unset PROOF_TINY_SECRET

# a malformed artifact name is a plan error, not a hash of the staging
# directory at the very end of the run
plan "$ROOT/p-dot.json" "mode=ok" "dest=$ROOT/dest/dot.md"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].name=".";require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-dot.json"
DOT="$(SELF attempt run "$ROOT/p-dot.json" 2>&1 || true)"
echo "$DOT" | grep -q "must be a single file name" || fail "an artifact named \".\" reached the completion gate instead of the plan validator"

# retention and deletion are configurable, and a spool the person deleted is gone
SELF attempt retention 7 | grep -q "kept for 7 day" || fail "the spool retention window could not be set"
SELF attempt retention | grep -q "^7$" || fail "the spool retention window was not recorded"
SELF attempt prune --days 365 | grep -q "no attempt spool is older" || fail "prune deleted spools inside the retention window"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.updated="2000-01-01T00:00:00.000Z";fs.writeFileSync(f,JSON.stringify(s,null,2))' "$SPOOL_SECRET/status.json"
SELF attempt prune --days 1 | grep -q "deleted 1 attempt spool" || fail "prune did not delete a spool past the retention window"
[ -d "$SPOOL_SECRET" ] && fail "a pruned spool is still on disk"

# an attempt abandoned in `running` that nobody ever recovered is the spool
# most likely to sit there for ever: liveness decides the exemption, not the
# state the spool last managed to write
plan "$ROOT/p-abandon.json" "mode=slow" "idfile=$ROOT/abandon-id"
rm -f "$ROOT/abandon-id"
SELF attempt run "$ROOT/p-abandon.json" > /dev/null 2>&1 &
ABANDON_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/abandon-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/abandon-id" ] || fail "the attempt to be abandoned never started"
AT_ABANDON="$(cat "$ROOT/abandon-id")"
crash_runner "$AT_ABANDON"
wait "$ABANDON_PID" 2>/dev/null || true
SPOOL_ABANDON="$(spool_of "$AT_ABANDON")"
[ "$(attempt_state "$AT_ABANDON")" = "running" ] || fail "the abandoned attempt did not stay in running"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.updated="2000-01-01T00:00:00.000Z";fs.writeFileSync(f,JSON.stringify(s,null,2))' "$SPOOL_ABANDON/status.json"
SELF attempt prune --days 1 | grep -q "deleted 1 attempt spool" || fail "a spool abandoned in running was exempt from retention for ever"
[ -d "$SPOOL_ABANDON" ] && fail "an abandoned spool survived a prune past its retention window"

# blocked and failed attempts leave the attention surface once a later attempt
# on the same unit answers them. An attempt id is never reused, so nothing in
# an append-only log ever goes back to unblock one: without this the list could
# only grow.
STATE_A="$ROOT/A/ws/.superself/projects/demo/state.md"
plan "$ROOT/p-lastblock.json" "mode=ok" "tools=definitely-not-a-real-tool"
SELF attempt run "$ROOT/p-lastblock.json" > /dev/null 2>&1 || true
AT_LASTBLOCK="$(last_attempt)"
[ "$(attempt_state "$AT_LASTBLOCK")" = "preflight-failed" ] || fail "the missing-tool attempt did not block on a capability"
grep -q "attempt $AT_LASTBLOCK is waiting on a capability grant" "$STATE_A" || fail "the newest blocked attempt is not waiting on the person"
grep -q "attempt $AT_DRIFT is waiting on a capability grant" "$STATE_A" && fail "a blocked attempt a later one superseded is still waiting on the person"
grep -q "attempt $AT_CRASH failed" "$STATE_A" && fail "a failed attempt a later one superseded is still a health signal"
SELF work show "$WATT" | grep -q "$AT_CRASH" || fail "a superseded attempt left the work record as well as the attention surface"

# the same accumulation, one surface over: `self status` reads the machine-local
# spools directly, and a spool lives until retention prunes it, so an unfinished
# attempt from weeks ago would keep a line there for a month
SELF status | grep -q "attempt $AT_LASTBLOCK" || fail "self status does not report this machine's unfinished attempts"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.updated=new Date(Date.now()-30*86400000).toISOString();fs.writeFileSync(f,JSON.stringify(s,null,2))' "$(spool_of "$AT_LASTBLOCK")/status.json"
SELF status | grep -q "attempt $AT_LASTBLOCK" && fail "an attempt nothing has touched for a month still holds a line under self status"
SELF attempt list | grep -q "$AT_LASTBLOCK" || fail "the aged-out attempt is no longer reachable from the surface that lists every spool"

# ---------------------------------------------------------------------------
# Declarative work specs. Desired state is applied as an immutable, content-
# addressed generation, and the runner attempt it materializes is pinned to the
# exact generation it was admitted under — so editing intent while a run is in
# flight decides what the next dispatch compiles and nothing about that run.
# ---------------------------------------------------------------------------
WSPEC="$(SELF work add "a work spec materializes one pinned runner attempt" | tail -1)"
SELF work start "$WSPEC" > /dev/null
WHOLD="$(SELF work add "a generation applied mid-attempt never reinterprets it" | tail -1)"
SELF work start "$WHOLD" > /dev/null
SPECS="$STORE/projects/demo/specs"

workspec()
{
    local file="$1"
    shift
    node "$CLI_DIR/proof/workspec.mjs" "$file" "work=$WSPEC" "agent=$AGENT" "cwd=$DEMO" "$@"
}
head_digest()
{
    node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sha256)' "$SPECS/$1/head.json"
}

# an incomplete spec is answered by the field it is missing, and asking leaves
# the log, the tree, and the store commit exactly as they were
workspec "$ROOT/ws-invalid.json" "id=ws-design" "drop=requestedModel"
BEFORE="$(snapshot)"
INVALID="$(SELF spec validate "$ROOT/ws-invalid.json" 2>&1 || true)"
echo "$INVALID" | grep -q 'field "requestedModel"' || fail "an incomplete work spec was not rejected by the field it lacks"
[ "$(snapshot)" = "$BEFORE" ] || fail "validating a rejected spec changed the log, the tree, or the store commit"

# a validation contract has to be one the completion gate can actually enforce
workspec "$ROOT/ws-noval.json" "id=ws-design" "drop=validation"
NOVAL="$(SELF spec validate "$ROOT/ws-noval.json" 2>&1 || true)"
echo "$NOVAL" | grep -q "must declare either" || fail "a spec declaring no validation contract was accepted"
workspec "$ROOT/ws-badstatus.json" "id=ws-design" "badStatus=done"
BADSTATUS="$(SELF spec validate "$ROOT/ws-badstatus.json" 2>&1 || true)"
echo "$BADSTATUS" | grep -q "admits no other result status" || fail "a response schema the completion gate cannot enforce was accepted"

# a valid spec validates without sealing anything
workspec "$ROOT/ws-gen1.json" "id=ws-design" "dest=$ROOT/dest/spec-one.md"
SELF spec validate "$ROOT/ws-gen1.json" | grep -q "generation 1 for $WSPEC is valid" || fail "a complete work spec did not validate"
[ -d "$SPECS/ws-design" ] && fail "validate sealed a generation"

# applying seals exactly one generation, named by the digest of its own bytes,
# and commits it with the event that makes it real
APPLIED_BEFORE="$(count_events spec.applied)"
SELF spec apply "$ROOT/ws-gen1.json" | grep -q "generation 1 applied" || fail "a valid work spec did not apply"
[ "$(count_events spec.applied)" -eq "$((APPLIED_BEFORE + 1))" ] || fail "applying a work spec did not record exactly one event"
GEN1="$(head_digest ws-design)"
[ -f "$SPECS/ws-design/000001-$GEN1.json" ] || fail "the sealed generation is not named by the digest of its content"
node -e '
const body = require("fs").readFileSync(process.argv[1]);
const digest = require("crypto").createHash("sha256").update(body).digest("hex");
if (digest !== process.argv[2]) { console.error("sealed bytes hash to " + digest); process.exit(1); }
' "$SPECS/ws-design/000001-$GEN1.json" "$GEN1" || fail "the spec store is not content-addressed"
git -C "$STORE" ls-files | grep -q "specs/ws-design/000001-$GEN1.json" || fail "the sealed generation was not committed with its event"

# the same content applied twice is one generation: no second event, no second commit
BEFORE="$(snapshot)"
SELF spec apply "$ROOT/ws-gen1.json" | grep -q "already applied" || fail "re-applying identical content was not idempotent"
[ "$(snapshot)" = "$BEFORE" ] || fail "an idempotent apply still changed the store"

# conflicting content for a generation already sealed is refused outright
workspec "$ROOT/ws-conflict.json" "id=ws-design" "dest=$ROOT/dest/spec-one.md" "model=some-other-model"
CONFLICT="$(SELF spec apply "$ROOT/ws-conflict.json" 2>&1 || true)"
echo "$CONFLICT" | grep -q "is immutable" || fail "conflicting content for a sealed generation was accepted"
[ "$(snapshot)" = "$BEFORE" ] || fail "a refused generation still changed the store"

# generations advance one at a time, so nothing lands on a number nobody sealed
workspec "$ROOT/ws-skip.json" "id=ws-design" "generation=3" "dest=$ROOT/dest/spec-one.md"
SKIP="$(SELF spec apply "$ROOT/ws-skip.json" 2>&1 || true)"
echo "$SKIP" | grep -q "so the next one is 2" || fail "a generation number nothing leads to was accepted"

# a spec names a work unit that exists, and a work unit has one desired-state HEAD
workspec "$ROOT/ws-nowork.json" "id=ws-nowork" "work=w-nosuch" "dest=$ROOT/dest/spec-nowork.md"
NOWORK="$(SELF spec apply "$ROOT/ws-nowork.json" 2>&1 || true)"
echo "$NOWORK" | grep -q "unknown work id" || fail "a work spec naming no work unit was sealed"
workspec "$ROOT/ws-second.json" "id=ws-second" "dest=$ROOT/dest/spec-second.md"
SECOND="$(SELF spec apply "$ROOT/ws-second.json" 2>&1 || true)"
echo "$SECOND" | grep -q "already has work spec ws-design" || fail "a second work spec claimed a work unit that already has one"

# a spec id is not a path: one that would leave the project's state is refused
workspec "$ROOT/ws-escape.json" "id=../escape" "dest=$ROOT/dest/spec-escape.md"
ESCAPE="$(SELF spec apply "$ROOT/ws-escape.json" 2>&1 || true)"
echo "$ESCAPE" | grep -q "single path segment" || fail "a work spec id that leaves the project's state was accepted"
[ -d "$STORE/projects/escape" ] && fail "a hostile spec id sealed a generation outside the specs root"

# a spec nobody applied materializes nothing
UNKNOWN="$(SELF spec dispatch ws-nothing 2>&1 || true)"
echo "$UNKNOWN" | grep -q "no work spec" || fail "dispatching a spec that was never applied was not refused"

# dispatch compiles the current generation into an attempt plan, runs it down
# the existing runner path, and settles through the same gate: one report on
# the work unit, the declared artifact published, the generation on the record
REPORTS_BEFORE="$(count_events report.added)"
DISPATCHED_BEFORE="$(count_events spec.dispatched)"
SELF spec dispatch ws-design > /dev/null || fail "dispatching the current generation did not complete"
AT_SPEC="$(SELF attempt list --work "$WSPEC" | awk '{print $1}' | tail -1)"
[ "$(attempt_state "$AT_SPEC")" = "completed" ] || fail "a dispatched attempt did not complete"
[ -f "$ROOT/dest/spec-one.md" ] || fail "the artifact the spec declared was not published"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "a dispatched attempt did not attach exactly one report"
[ "$(count_events spec.dispatched)" -eq "$((DISPATCHED_BEFORE + 1))" ] || fail "a dispatch recorded no spec event"
SELF work show "$WSPEC" | grep -q "$AT_SPEC (completed)" || fail "the work record does not carry the attempt its spec materialized"
node -e '
const record = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const pin = record.spec;
if (pin === undefined) { console.error("the attempt record carries no spec pin"); process.exit(1); }
if (pin.workSpec !== "ws-design" || pin.generation !== 1 || pin.sha256 !== process.argv[2]) { console.error("pinned to " + JSON.stringify(pin)); process.exit(1); }
if (pin.requestedModel !== "opus-5") { console.error("the model the spec asked for was not recorded"); process.exit(1); }
' "$(spool_of "$AT_SPEC")/attempt.json" "$GEN1" || fail "dispatch did not pin the attempt to the generation it was admitted under"

# a declared blocker gates dispatch and nothing else: the spec still applies
# while the work waits, and no spec.dispatched event is spent on a refusal
DISPATCHED_BEFORE="$(count_events spec.dispatched)"
SELF work block "$WSPEC" --on dependency --why "the upstream artifact is not published yet" > /dev/null
BLOCKED="$(SELF spec dispatch ws-design 2>&1 || true)"
echo "$BLOCKED" | grep -q "blocked on dependency" || fail "a work unit blocked on a dependency was still materialized"
[ "$(count_events spec.dispatched)" -eq "$DISPATCHED_BEFORE" ] || fail "a refused dispatch still recorded a spec event"
workspec "$ROOT/ws-gen2.json" "id=ws-design" "generation=2" "dest=$ROOT/dest/spec-one.md" "summary=desired state prepared while the work waits"
SELF spec apply "$ROOT/ws-gen2.json" | grep -q "generation 2 applied" || fail "a blocked work unit refused the next generation of its desired state"
SELF work unblock "$WSPEC" > /dev/null

# a generation applied while an attempt is in flight moves HEAD for the next
# dispatch and leaves the live attempt on the generation that admitted it
workspec "$ROOT/ws-hold.json" "id=ws-hold" "work=$WHOLD" "mode=hold" "gate=$ROOT/spec-gate" "idfile=$ROOT/spec-hold-id"
SELF spec apply "$ROOT/ws-hold.json" > /dev/null || fail "the held generation did not apply"
HOLD1="$(head_digest ws-hold)"
rm -f "$ROOT/spec-hold-id" "$ROOT/spec-gate"
SELF spec dispatch ws-hold > /dev/null &
HOLD_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/spec-hold-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/spec-hold-id" ] || fail "the held attempt never reached the provider"
AT_HOLD="$(cat "$ROOT/spec-hold-id")"

# one work unit materializes one attempt at a time
BUSY="$(SELF spec dispatch ws-hold 2>&1 || true)"
echo "$BUSY" | grep -q "one work unit materializes one attempt at a time" || fail "a second attempt was dispatched onto a work unit already being driven"

workspec "$ROOT/ws-hold2.json" "id=ws-hold" "work=$WHOLD" "generation=2" "mode=hold" "gate=$ROOT/spec-gate" "summary=the generation that lands mid-attempt"
SELF spec apply "$ROOT/ws-hold2.json" | grep -q "generation 2 applied" || fail "a generation could not be applied while an attempt was running"
HOLD2="$(head_digest ws-hold)"
[ "$HOLD1" = "$HOLD2" ] && fail "the second generation hashed to the first"
touch "$ROOT/spec-gate"
wait "$HOLD_PID" || fail "the held attempt did not complete once it was released"
[ "$(attempt_state "$AT_HOLD")" = "completed" ] || fail "the attempt that ran across an apply did not complete"
node -e '
const pin = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).spec;
if (pin.generation !== 1 || pin.sha256 !== process.argv[2]) { console.error("a later generation reinterpreted a live attempt: " + JSON.stringify(pin)); process.exit(1); }
' "$(spool_of "$AT_HOLD")/attempt.json" "$HOLD1" || fail "an apply mid-attempt changed what the live attempt was admitted under"
[ -f "$SPECS/ws-hold/000001-$HOLD1.json" ] || fail "a superseded generation was edited or deleted"

# work to generation to attempts, by stable id
SELF spec list | grep -q "ws-design  $WSPEC  generation 2" || fail "spec list does not resolve a spec to its work and generation"
SHOW="$(SELF spec show ws-hold)"
echo "$SHOW" | grep -q "ws-hold  $WHOLD  generation 2" || fail "spec show does not name the work unit and the current generation"
echo "$SHOW" | grep -q "model opus-5" || fail "spec show does not name the model the spec asks for"
echo "$SHOW" | grep -q "$AT_HOLD  generation 1" || fail "spec show does not resolve which generation an attempt ran under"

# a sealed generation that no longer hashes to its own name is refused on the
# read path: the immutability the contract rests on has already been lost
GEN2="$(head_digest ws-design)"
SEALED_BLOB="$SPECS/ws-design/000002-$GEN2.json"
cp "$SEALED_BLOB" "$ROOT/sealed-backup.json"
node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace("opus-5","opus-6"))' "$SEALED_BLOB"
TAMPERED_SHOW="$(SELF spec show ws-design 2>&1 || true)"
echo "$TAMPERED_SHOW" | grep -q "sealed content was modified" || fail "spec show read a sealed generation whose bytes were modified"
TAMPERED_DISPATCH="$(SELF spec dispatch ws-design 2>&1 || true)"
echo "$TAMPERED_DISPATCH" | grep -q "sealed content was modified" || fail "spec dispatch compiled a sealed generation whose bytes were modified"
cp "$ROOT/sealed-backup.json" "$SEALED_BLOB"
SELF spec show ws-design > /dev/null || fail "restoring the sealed bytes did not restore the spec"

# a hand-written plan file cannot smuggle a spec pin: the pin says what the
# spec store admitted, and only dispatch may write it
plan "$ROOT/p-forged.json" "mode=ok" "dest=$ROOT/dest/forged.md"
node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));p.spec={workSpec:"ws-design",generation:99,sha256:"deadbeef".repeat(8),requestedModel:"opus-5"};fs.writeFileSync(f,JSON.stringify(p))' "$ROOT/p-forged.json"
SELF attempt run "$ROOT/p-forged.json" > /dev/null || fail "a plan carrying a forged pin did not run at all"
AT_FORGED="$(last_attempt)"
node -e 'if (JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).spec !== undefined) { console.error("the forged pin reached the attempt record"); process.exit(1); }' "$(spool_of "$AT_FORGED")/attempt.json" || fail "a hand-written plan smuggled a spec pin onto the attempt record"
SELF spec show ws-design | grep -q "$AT_FORGED" && fail "a forged pin surfaced an attempt under spec show"

# two applies racing for one generation number seal exactly one: the loser is
# refused, and the store still answers instead of being poisoned forever
WRACE="$(SELF work add "two racing applies seal exactly one generation" | tail -1)"
SELF work start "$WRACE" > /dev/null
workspec "$ROOT/ws-race-a.json" "work=$WRACE" "id=ws-race" "dest=$ROOT/dest/race.md"
workspec "$ROOT/ws-race-b.json" "work=$WRACE" "id=ws-race" "dest=$ROOT/dest/race.md" "model=some-other-model"
APPLIED_BEFORE="$(count_events spec.applied)"
SELF spec apply "$ROOT/ws-race-a.json" > "$ROOT/race-a.out" 2>&1 &
RACE_A=$!
SELF spec apply "$ROOT/ws-race-b.json" > "$ROOT/race-b.out" 2>&1 &
RACE_B=$!
wait "$RACE_A" && RACE_A_OK=yes || RACE_A_OK=no
wait "$RACE_B" && RACE_B_OK=yes || RACE_B_OK=no
[ "$RACE_A_OK" = yes ] || [ "$RACE_B_OK" = yes ] || fail "neither racing apply sealed the generation"
{ [ "$RACE_A_OK" = yes ] && [ "$RACE_B_OK" = yes ]; } && fail "two racing applies of different content both claimed generation 1"
[ "$(find "$SPECS/ws-race" -name '000001-*.json' | wc -l | tr -d ' ')" -eq 1 ] || fail "racing applies left two sealed blobs for one generation"
[ "$(count_events spec.applied)" -eq "$((APPLIED_BEFORE + 1))" ] || fail "racing applies recorded more or less than one spec.applied event"
SELF spec show ws-race > /dev/null || fail "the spec store no longer answers after racing applies"

# a crash between the generation blob and the HEAD advance leaves a store the
# next apply completes — never one it misreads as already applied and wedges
WCRASH="$(SELF work add "an interrupted apply is completed, not misread" | tail -1)"
SELF work start "$WCRASH" > /dev/null
workspec "$ROOT/ws-crash1.json" "work=$WCRASH" "id=ws-crash" "dest=$ROOT/dest/crash.md"
SELF spec apply "$ROOT/ws-crash1.json" > /dev/null || fail "the pre-crash generation did not apply"
workspec "$ROOT/ws-crash2.json" "work=$WCRASH" "id=ws-crash" "generation=2" "dest=$ROOT/dest/crash.md" "summary=the generation the crash interrupted"
# the crash, simulated exactly: the blob reached the store, the HEAD advance
# and the spec.applied event did not
CRASH2="$(node -e '
import("file://" + process.argv[1] + "/dist/spec/workspec.js").then((m) =>
{
    const fs = require("fs");
    const spec = m.normalizeSpec(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
    fs.writeFileSync(process.argv[3] + "/000002-" + m.specDigest(spec) + ".json", m.specBody(spec));
    process.stdout.write(m.specDigest(spec));
});' "$CLI_DIR" "$ROOT/ws-crash2.json" "$SPECS/ws-crash")"
[ "$(head_digest ws-crash)" != "$CRASH2" ] || fail "the simulated crash advanced HEAD on its own"
APPLIED_BEFORE="$(count_events spec.applied)"
SELF spec apply "$ROOT/ws-crash2.json" > /dev/null || fail "re-applying across the crash window failed"
[ "$(head_digest ws-crash)" = "$CRASH2" ] || fail "re-apply left HEAD behind the sealed generation"
[ "$(count_events spec.applied)" -eq "$((APPLIED_BEFORE + 1))" ] || fail "completing the interrupted apply did not record its event exactly once"
SELF spec show ws-crash | grep -q "generation 2" || fail "the completed apply does not read at generation 2"
workspec "$ROOT/ws-crash3.json" "work=$WCRASH" "id=ws-crash" "generation=3" "dest=$ROOT/dest/crash.md" "summary=the store advances again after the repair"
SELF spec apply "$ROOT/ws-crash3.json" | grep -q "generation 3 applied" || fail "the spec cannot advance past a repaired crash window"

# two dispatches racing for one work unit materialize exactly one attempt: the
# claim is atomic, and the loser's refusal spends no spec.dispatched event
WDUAL="$(SELF work add "two racing dispatches materialize one attempt" | tail -1)"
SELF work start "$WDUAL" > /dev/null
workspec "$ROOT/ws-dual.json" "work=$WDUAL" "id=ws-dual" "mode=hold" "gate=$ROOT/dual-gate" "idfile=$ROOT/dual-id"
SELF spec apply "$ROOT/ws-dual.json" > /dev/null || fail "the dual-dispatch spec did not apply"
DISPATCHED_BEFORE="$(count_events spec.dispatched)"
rm -f "$ROOT/dual-id" "$ROOT/dual-gate"
SELF spec dispatch ws-dual > "$ROOT/dual-a.out" 2>&1 &
DUAL_A=$!
SELF spec dispatch ws-dual > "$ROOT/dual-b.out" 2>&1 &
DUAL_B=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/dual-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/dual-id" ] || fail "neither racing dispatch materialized an attempt"
touch "$ROOT/dual-gate"
wait "$DUAL_A" && DUAL_A_OK=yes || DUAL_A_OK=no
wait "$DUAL_B" && DUAL_B_OK=yes || DUAL_B_OK=no
[ "$DUAL_A_OK" = yes ] || [ "$DUAL_B_OK" = yes ] || fail "neither racing dispatch completed"
{ [ "$DUAL_A_OK" = yes ] && [ "$DUAL_B_OK" = yes ]; } && fail "two racing dispatches both materialized an attempt on one work unit"
[ "$(SELF attempt list --work "$WDUAL" | wc -l | tr -d ' ')" -eq 1 ] || fail "racing dispatches left two attempts on one work unit"
cat "$ROOT/dual-a.out" "$ROOT/dual-b.out" | grep -q "one work unit materializes one attempt at a time" || fail "the losing dispatch was not refused by the one-attempt rule"
[ "$(count_events spec.dispatched)" -eq "$((DISPATCHED_BEFORE + 1))" ] || fail "racing dispatches spent more than one spec.dispatched event"
# help is answered before any command runs: every documented verb has a scoped
# page, help writes nothing, and a bad flag never becomes a stack trace
cd "$ROOT/A/ws/demo"
HWID="$(SELF work add "the help and argument contract holds" | tail -1)"
LOG_BEFORE="$(wc -l < "$LOG_A")"
STORE_BEFORE="$(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD)"
SELF --help | grep -q "^usage: self <command>" || fail "self --help did not print the verb list"
SELF -h | grep -q "^usage: self <command>" || fail "self -h did not print the verb list"
SELF help | grep -q "^usage: self <command>" || fail "self help did not print the verb list"
SELF nosuchverb --help | grep -q "^usage: self <command>" || fail "an unknown verb did not fall back to the verb list"
# the verbs are read back from the root list, so a command added later is
# proved too instead of drifting away from a list written out here
VERBS="$(SELF | sed -n 's/^  \([a-z][a-z-]*\).*/\1/p' | sort -u)"
[ "$(echo "$VERBS" | grep -c .)" -ge 20 ] || fail "the root list named too few verbs to be the real one"
for CMD in $VERBS
do
    HELP="$(SELF "$CMD" --help 2>&1)" || fail "self $CMD --help exited non-zero"
    echo "$HELP" | grep -q "^usage: self $CMD" || fail "self $CMD --help printed no scoped usage"
    echo "$HELP" | grep -q "    at " && fail "self $CMD --help printed a stack trace"
    SELF "$CMD" -h > /dev/null 2>&1 || fail "self $CMD -h exited non-zero"
    SELF help "$CMD" | grep -q "^usage: self $CMD" || fail "self help $CMD printed no scoped usage"
done
# a verb the dispatcher answers but the list never names has no scoped help at
# all, which is how a command that lands later goes missing from this contract
for CMD in spec attempt
do
    echo "$VERBS" | grep -qx "$CMD" || fail "the root list does not name $CMD"
done
SELF spec --help | grep -q "spec validate <workspec.json>" || fail "self spec --help does not document validate"
SELF spec --help | grep -q "spec apply <workspec.json>" || fail "self spec --help does not document apply"
SELF spec --help | grep -q "spec dispatch <work-spec-id>" || fail "self spec --help does not document dispatch"
SELF spec --help | grep -q "spec list" || fail "self spec --help does not document list and show"
SELF attempt --help | grep -q "attempt register <plan.json>" || fail "self attempt --help does not document register"
SELF attempt --help | grep -q "heartbeat <id>" || fail "self attempt --help does not document the launcher-driven verbs"
# subcommand help resolves to the owning command's page from any position
SELF attempt run --help | grep -q "^usage: self attempt" || fail "self attempt run --help printed no scoped usage"
SELF spec apply --help | grep -q "^usage: self spec" || fail "self spec apply --help printed no scoped usage"
SELF integration lease acquire --help | grep -q "^usage: self integration" || fail "a nested integration verb lost its help"
[ "$(wc -l < "$LOG_A")" = "$LOG_BEFORE" ] || fail "help wrote an event"
[ "$(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD)" = "$STORE_BEFORE" ] || fail "help committed derived state"

# help answers on a machine that has no workspace at all, and creates none
machine H
cd "$ROOT"
SELF report --help | grep -q "^usage: self report" || fail "report help demanded a workspace"
SELF init --help | grep -q "^usage: self init" || fail "init help demanded a workspace"
SELF attempt --help | grep -q "^usage: self attempt" || fail "attempt help demanded a workspace"
[ -d "$ROOT/.superself" ] && fail "self init --help initialized a workspace"
# an argument mistake is named here too: arguments are checked before the
# workspace is resolved, so the answer does not depend on where it was run
for ARGV in "artifact list --bogus" "goal set text --bogus" "report w-1 text --bogus"
do
    NOWS="$(SELF $ARGV 2>&1 || true)"
    echo "$NOWS" | grep -q "unknown option '--bogus'" || fail "self $ARGV asked for a workspace instead of naming the bad flag"
done
machine A
cd "$ROOT/A/ws/demo"

# help is identical piped or under NO_COLOR, and carries no escape codes either way
[ "$(SELF report --help)" = "$(NO_COLOR=1 node "$CLI_DIR/bin/self.mjs" report --help)" ] || fail "help differed under NO_COLOR"
SELF report --help | grep -q "$(printf '\033')" && fail "help emitted color into a pipe"

# an unknown flag names itself, points at its command's help, exits non-zero,
# and — the part that matters on a write — never reaches the command at all.
# $1 is the verb the message must point at, empty for the root list.
rejects()
{
    VERB="$1"
    shift
    if OUT="$(SELF "$@" 2>&1)"
    then
        fail "self $* exited zero on an unknown flag"
    fi
    echo "$OUT" | grep -q "unknown option '--bogus'" || fail "self $* did not name the unknown flag"
    echo "$OUT" | grep -qF "self ${VERB:+$VERB }--help" || fail "self $* did not point at the scoped help"
    if echo "$OUT" | grep -q "    at "
    then
        fail "self $* printed a stack trace"
    fi
}

cd "$ROOT/A/ws/demo"
LOG_BEFORE="$(wc -l < "$LOG_A")"
STORE_BEFORE="$(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD)"
DIRT_BEFORE="$(git -C "$ROOT/A/ws/.superself" status --porcelain)"
BLOCK_BEFORE="$(cat "$ROOT/A/ws/demo/CLAUDE.md")"
MACHINE_BEFORE="$(cat "$ROOT/A/home/.claude/CLAUDE.md")"
REGISTRY_BEFORE="$(cat "$ROOT/A/ws/.superself/registry.jsonl")"
LINKS_BEFORE="$(cat "$ROOT/A/ws/.superself/links.jsonl")"
POINTER_BEFORE="$(cat "$ROOT/A/config/superself/machine.json")"
CONFIG_BEFORE="$(cat "$ROOT/A/ws/.superself/config.json")"
ARTIFACTS_BEFORE="$(ls "$ROOT/A/ws/.superself/artifacts/demo")"
REMOTE_BEFORE="$(git -C "$ROOT/A/ws/.superself" remote get-url origin)"

rejects goal goal set "rejected write" --bogus
rejects work work add "rejected write" --bogus
rejects work work start "$HWID" --bogus
rejects work work show "$HWID" --bogus
rejects work work --project demo --bogus
rejects convention convention add "rejected write" --bogus
rejects convention convention drop ev-nope --bogus
rejects decide decide "rejected write" --bogus
rejects decide decide confirm ev-nope --bogus
rejects report report "$HWID" "rejected write" --bogus
rejects report report "$HWID" "rejected write" --artifact "$ROOT/launch.html" --bogus
rejects connect connect --bogus
rejects connect connect --global --bogus
rejects project project add --name rejected --bogus
rejects project project link demo --bogus
rejects artifact artifact list --bogus
rejects artifact artifact search launch --bogus
rejects artifact artifact open "$AID" --bogus
rejects fold fold --bogus
rejects sync sync --bogus
rejects lang lang ja --bogus
rejects theme theme cyan --bogus
rejects timezone timezone Asia/Seoul --bogus
rejects remote remote add "$ROOT/rejected-remote.git" --bogus
rejects workspace workspace "$ROOT/B/ws" --bogus
rejects view view demo --bogus
rejects search search launch --bogus
rejects log log -n 5 --bogus
rejects status status --bogus
rejects context context --bogus
rejects setup setup --bogus
rejects init init --bogus
rejects clone clone "$ROOT/remote.git" "$ROOT/rejected-clone" --bogus
rejects objective objective add "rejected write" --bogus
rejects milestone milestone add "rejected write" --bogus
rejects integration integration register --bogus
rejects review review list --bogus
rejects attempt attempt list --bogus
rejects attempt attempt prune --bogus
# the attempt verbs that read positionals hold the same contract — retention
# and recover are the write paths a swallowed flag used to reach
RETENTION_BEFORE="$(SELF attempt retention)"
rejects attempt attempt retention 9 --bogus
[ "$(SELF attempt retention)" = "$RETENTION_BEFORE" ] || fail "a rejected flag changed spool retention"
rejects attempt attempt recover --bogus
for SUB in "run plan.json" "show at-nope" "directive at-nope text" "cancel at-nope" "settle at-nope" "breaker prov"
do
    rejects attempt attempt $SUB --bogus
done
# the verbs a launcher of its own drives an attempt through hold it too: each
# one moves a spooled attempt, so a swallowed flag here is a swallowed flag on
# a write
for SUB in "register plan.json" "started at-nope --pid 1" "heartbeat at-nope" "exited at-nope --code 0"
do
    rejects attempt attempt $SUB --bogus
done
# and the supervisor's own verbs: `start` launches a detached process and
# `tick` settles attempts, so a flag none of them accepts has to be refused
# before any of that, not swallowed into a supervision pass
for SUB in start stop status tick circuits
do
    rejects daemon daemon $SUB --bogus
done
SELF daemon status | grep -q "no self daemon is running" || fail "a rejected daemon flag started a supervisor"
# and the work spec verbs: validate only reads, but apply seals a generation
# and dispatch spends an attempt, so none of them may reach its body with a
# flag it never accepted
for SUB in "validate x" "apply x" "dispatch x" "list" "show x"
do
    rejects spec spec $SUB --bogus
done
BADSPEC="$(SELF spec apply x surplus 2>&1 || true)"
echo "$BADSPEC" | grep -q "unexpected argument 'surplus'" || fail "an extra spec argument was swallowed"
rejects "" --bogus

# a typoed verb is named on stderr and exits non-zero, never a usage list
# that reads as success
if OUT="$(SELF reprot "$HWID" "typo" 2>/dev/null)"
then
    fail "an unknown verb exited zero"
fi
[ -z "$OUT" ] || fail "an unknown verb printed to stdout"
UNKNOWNVERB="$(SELF reprot "$HWID" "typo" 2>&1 || true)"
echo "$UNKNOWNVERB" | grep -q "unknown command 'reprot'" || fail "an unknown verb was not named"
echo "$UNKNOWNVERB" | grep -qF "self --help" || fail "an unknown verb did not point at the verb list"

# an argument the command has no room for is named too, rather than dropped
BADEXTRA="$(SELF goal set "one goal" "a second one" 2>&1 || true)"
echo "$BADEXTRA" | grep -q "unexpected argument 'a second one'" || fail "an extra argument was swallowed"
echo "$BADEXTRA" | grep -qF "self goal --help" || fail "an extra argument did not point at the scoped help"
BADRECOVER="$(SELF attempt recover extra 2>&1 || true)"
echo "$BADRECOVER" | grep -q "unexpected argument 'extra'" || fail "an extra attempt argument was swallowed"

# nothing any of those commands would have written exists
[ "$(wc -l < "$LOG_A")" = "$LOG_BEFORE" ] || fail "a rejected flag wrote an event"
[ "$(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD)" = "$STORE_BEFORE" ] || fail "a rejected flag committed to the store"
[ "$(git -C "$ROOT/A/ws/.superself" status --porcelain)" = "$DIRT_BEFORE" ] || fail "a rejected flag left the store dirty"
[ "$(cat "$ROOT/A/ws/demo/CLAUDE.md")" = "$BLOCK_BEFORE" ] || fail "a rejected flag rewrote the project's agent block"
[ "$(cat "$ROOT/A/home/.claude/CLAUDE.md")" = "$MACHINE_BEFORE" ] || fail "a rejected flag rewrote this machine's agent block"
[ "$(cat "$ROOT/A/ws/.superself/registry.jsonl")" = "$REGISTRY_BEFORE" ] || fail "a rejected flag registered a project"
[ "$(cat "$ROOT/A/ws/.superself/links.jsonl")" = "$LINKS_BEFORE" ] || fail "a rejected flag linked a checkout"
[ "$(cat "$ROOT/A/config/superself/machine.json")" = "$POINTER_BEFORE" ] || fail "a rejected flag moved this machine's workspace pointer"
[ "$(cat "$ROOT/A/ws/.superself/config.json")" = "$CONFIG_BEFORE" ] || fail "a rejected flag changed a workspace setting"
[ "$(ls "$ROOT/A/ws/.superself/artifacts/demo")" = "$ARTIFACTS_BEFORE" ] || fail "a rejected flag ingested an artifact"
[ "$(git -C "$ROOT/A/ws/.superself" remote get-url origin)" = "$REMOTE_BEFORE" ] || fail "a rejected flag repointed the store remote"
[ -d "$ROOT/A/ws/demo/.superself" ] && fail "a rejected flag initialized a workspace"
[ -e "$ROOT/rejected-clone" ] && fail "a rejected flag cloned a store"

# a separator where a subcommand belongs says so on every such command, instead
# of reading as a flag on one and passing silently on the next
for ARGV in "work -- add" "project -- add" "artifact -- list" "goal -- set" "convention -- add" "remote -- add"
do
    BADSEP="$(SELF $ARGV "never created" 2>&1 || true)"
    echo "$BADSEP" | grep -q "expects a subcommand" || fail "self $ARGV did not explain the separator in place of a subcommand"
done
[ "$(wc -l < "$LOG_A")" = "$LOG_BEFORE" ] || fail "a separator in place of a subcommand wrote an event"

# a flag that needs a value and has none is reported the same way
BADVALUE="$(SELF log -n 2>&1 || true)"
echo "$BADVALUE" | grep -q "argument missing" || fail "a flag with no value was not reported"
echo "$BADVALUE" | grep -q "    at " && fail "a flag with no value printed a stack trace"

# after `--`, an option-looking argument is text the user meant literally —
# on a write verb too, where it used to be swallowed as a separator
SELF report "$HWID" -- "--help is not a flag here"
grep -q -- "--help is not a flag here" "$LOG_A" || fail "a literal argument after -- was taken as a request for help"
SELF goal set -- "--global is the goal now"
grep -q -- "--global is the goal now" "$STATE_A" || fail "a literal goal after -- was taken as a separator"

# `--help` in an option's value position is handed to the command's parser,
# never intercepted as a request for help: the `=` form records the literal
# text, and the two-token form is the parser's own refusal, not a help page
SELF decide "the help literal is a value here" --why=--help
grep -q '"why":"--help"' "$LOG_A" || fail "--help in a value position was intercepted as a help request"
AMBIG="$(SELF decide "never recorded" --why --help 2>&1)" && fail "--help standing where a value belongs still hijacked the invocation"
echo "$AMBIG" | grep -q "ambiguous" || fail "the parser's own refusal of --help as a two-token value was not surfaced"
echo "$AMBIG" | grep -q "    at " && fail "the refusal of --help as a value printed a stack trace"
grep -q "never recorded" "$LOG_A" && fail "a refused --help value still wrote an event"

# The five suites below each build a machine root or git repository of their
# own and read nothing of this script's state — integration replays a real
# three-branch train, tick-mutex contends two ticks, daemon-loop supervises
# real payloads, semantic completion opens a pseudo terminal for an approval,
# and overnight folds a whole night's log. Nothing is shared, so they run
# together and the wall clock pays for the slowest one, not for the sum.
# Each suite's output is kept apart and replayed in order once it finishes.
SUITE_LOGS="$ROOT/suite-logs"
mkdir -p "$SUITE_LOGS"

bash "$CLI_DIR/proof/integration.sh" > "$SUITE_LOGS/integration.log" 2>&1 &
INTEGRATION_PID=$!
node "$CLI_DIR/proof/tick-mutex.mjs" > "$SUITE_LOGS/tick-mutex.log" 2>&1 &
TICK_MUTEX_PID=$!
bash "$CLI_DIR/proof/daemon-loop.sh" > "$SUITE_LOGS/daemon-loop.log" 2>&1 &
DAEMON_LOOP_PID=$!
bash "$CLI_DIR/proof/semantic-completion.sh" > "$SUITE_LOGS/semantic-completion.log" 2>&1 &
SEMANTIC_PID=$!
bash "$CLI_DIR/proof/overnight-digest.sh" > "$SUITE_LOGS/overnight-digest.log" 2>&1 &
OVERNIGHT_PID=$!

suite_done()
{
    local name="$1" pid="$2"
    if ! wait "$pid"
    then
        cat "$SUITE_LOGS/$name.log"
        fail "the $name suite failed"
    fi
    cat "$SUITE_LOGS/$name.log"
}

suite_done integration "$INTEGRATION_PID"
suite_done tick-mutex "$TICK_MUTEX_PID"
suite_done daemon-loop "$DAEMON_LOOP_PID"
suite_done semantic-completion "$SEMANTIC_PID"
suite_done overnight-digest "$OVERNIGHT_PID"

echo "proof OK"
