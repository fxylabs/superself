#!/usr/bin/env bash
# Domain suite: workspace lifecycle and two-machine sync — init, clone,
# divergent appends, fold-time views, theme and language, and the machine
# pointer deciding the workspace. Runs alone: bash proof/suites/sync.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

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

echo "sync OK"
