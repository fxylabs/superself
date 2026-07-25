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

git init -q --bare "$ROOT/remote.git"

# machine A: workspace, project, events, first push
mkdir -p "$ROOT/A/ws/demo"
cd "$ROOT/A/ws"
SELF init
cd "$ROOT/A/ws/demo"
git init -q
SELF project add --name demo --desc "sync proof project"
SELF goal set "prove two-machine sync"
WID=$(SELF work add "events from both machines merge cleanly" | tail -1)
cd "$ROOT/A/ws"
SELF remote add "$ROOT/remote.git"
SELF sync

# machine B: clone, relink, act on the same work unit
mkdir -p "$ROOT/B"
cd "$ROOT/B"
SELF clone "$ROOT/remote.git" ws
grep -q '"slug":"demo"' "$ROOT/B/ws/.superself/registry.jsonl" || fail "registry did not travel with clone"
grep -q '"path"' "$ROOT/B/ws/.superself/registry.jsonl" && fail "registry leaked a machine path"
mkdir -p "$ROOT/B/ws/demo"
cd "$ROOT/B/ws/demo"
git init -q
SELF project link demo
[ -f .self ] || fail "project link did not restore the marker"
SELF context | grep -q "prove two-machine sync" || fail "context not derivable on machine B"

# divergent appends on both machines, then bidirectional sync
cd "$ROOT/A/ws/demo"
SELF decide "machine A made this decision" --why "divergent append"
cd "$ROOT/B/ws/demo"
SELF work start "$WID"
SELF report "$WID" "machine B started the work"
cd "$ROOT/B/ws" && SELF sync
cd "$ROOT/A/ws" && SELF sync
cd "$ROOT/B/ws" && SELF sync

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
git -C "$ROOT/A/ws/.superself" ls-files | grep -q "links.jsonl" && fail "links.jsonl leaked into store history"

echo "proof OK"
