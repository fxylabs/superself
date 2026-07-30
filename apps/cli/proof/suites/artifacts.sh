#!/usr/bin/env bash
# Domain suite: artifacts — ingest at report time, atomic multi-artifact sets,
# rollback ownership, hostile project names, the GUI launch guard, workspace
# reads from any directory, and artifact travel across machines.
# Runs alone: bash proof/suites/artifacts.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

demo_workspace
outside_project
# the decision and the cross-machine report the full-list pages are asserted
# on below, recorded the way the sync suite records them: one append on each
# machine, merged through the remote
WID="$(SELF work add "events from both machines merge cleanly" | tail -1)"
SELF decide "machine A made this decision" --why "divergent append" > /dev/null
clone_machine_b
machine B
cd "$ROOT/B/ws/demo"
SELF work start "$WID" > /dev/null
SELF report "$WID" "machine B started the work" > /dev/null
(cd "$ROOT/B/ws" && SELF sync > /dev/null)
machine A
(cd "$WS" && SELF sync > /dev/null)
cd "$DEMO"

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

echo "artifacts OK"
