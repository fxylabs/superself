#!/usr/bin/env bash
# Standalone runner for the spec section of proof.sh (plus the new race/crash
# cases), against the built CLI, in an isolated machine/home. Mirrors the
# setup the full proof performs before the section starts. Not part of CI —
# the full proof is; this exists to run the section alone during review.
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

export HOME="$ROOT/A/home"
export XDG_CONFIG_HOME="$ROOT/A/config"
mkdir -p "$HOME/.claude" "$ROOT/A/ws/demo" "$ROOT/dest"
git config --global user.name "proof A"
git config --global user.email "proof-A@superself.local"

cd "$ROOT/A/ws"
SELF init --agents > /dev/null
cd "$ROOT/A/ws/demo"
git init -q
SELF project add --name demo --desc "spec section harness" > /dev/null
SELF goal set "prove the spec section alone" > /dev/null

STORE="$ROOT/A/ws/.superself"
LOG_A="$STORE/projects/demo/log.jsonl"
DEMO="$ROOT/A/ws/demo"
AGENT="$CLI_DIR/proof/attempt-agent.mjs"
MKPLAN="$CLI_DIR/proof/attempt-plan.mjs"

snapshot()
{
    (cd "$STORE" && find . -path ./.git -prune -o -print | sort)
    git -C "$STORE" rev-parse HEAD
    git -C "$STORE" status --porcelain
    wc -l < "$LOG_A"
}
count_events()
{
    grep -c "\"type\":\"$1\"" "$LOG_A" || true
}
spool_of()
{
    echo "$ROOT/A/home/.local/state/superself/runner/attempts/$1"
}
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

WATT="$(SELF work add "the harness work unit plain attempts run against" | tail -1)"
SELF work start "$WATT" > /dev/null

sed -n '/^# Declarative work specs\./,/^# the repository integration controller/p' "$CLI_DIR/proof/proof.sh" | sed '$d' > "$ROOT/section.sh"
# Sourcing an empty or truncated extraction would print OK without proving a
# thing, so the markers are checked before a line of it runs.
grep -q "Declarative work specs" "$ROOT/section.sh" || fail "the spec section was not found in proof.sh"
grep -q "racing dispatches" "$ROOT/section.sh" || fail "the spec section was cut short before its last case"
. "$ROOT/section.sh"

echo "spec section OK"
