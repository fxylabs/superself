# proof/lib.sh — the helpers every proof suite shares. Sourced, never run:
# a suite sets CLI_DIR to apps/cli and sources this file first. Before this
# file existed the same functions were copied into five suites and drifted —
# pty_self held its terminal open 1s in two copies and 3s in two others.
#
# The file owns the scratch root and its teardown. A suite that launches a
# supervisor sets PROOF_STOP_DAEMON=1 before sourcing, so the daemon never
# outlives the workspace it ticks.

SELF_JS="$CLI_DIR/bin/self.mjs"
ROOT="$(mktemp -d)"

SELF()
{
    node "$SELF_JS" "$@"
}

fail()
{
    echo "proof FAILED: $1" >&2
    exit 1
}

cleanup()
{
    if [ "${PROOF_STOP_DAEMON:-0}" = 1 ]
    then
        node "$SELF_JS" daemon stop > /dev/null 2>&1 || true
    fi
    rm -rf "$ROOT"
}
trap cleanup EXIT
# The sweep kills sibling suites when one fails. Dying on the bare signal
# would skip the EXIT trap and leave scratch daemons and roots behind, so the
# signal path runs the same teardown before it exits.
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 130' INT

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

# demo_workspace — the floor state the domain suites start from: machine A, a
# workspace at $ROOT/A/ws with a bare remote, and a linked demo project whose
# goal matches the assertions that read it. Leaves the shell in $DEMO and sets
# WS, DEMO, STORE, LOG_A, STATE_A, VIEW_A.
demo_workspace()
{
    git init -q --bare "$ROOT/remote.git"
    machine A
    mkdir -p "$ROOT/A/ws/demo" "$ROOT/A/home/.claude"
    cd "$ROOT/A/ws"
    SELF init --agents > /dev/null
    cd "$ROOT/A/ws/demo"
    git init -q -b main
    SELF project add --name demo --desc "proof suite project" > /dev/null
    SELF goal set "prove two-machine sync" > /dev/null
    cd "$ROOT/A/ws"
    SELF remote add "$ROOT/remote.git" > /dev/null
    WS="$ROOT/A/ws"
    DEMO="$WS/demo"
    STORE="$WS/.superself"
    LOG_A="$STORE/projects/demo/log.jsonl"
    STATE_A="$STORE/projects/demo/state.md"
    VIEW_A="$STORE/view"
    cd "$DEMO"
}

# clone_machine_b — machine B holding a clone of the workspace demo_workspace
# built, its demo checkout linked. Ends back on machine A in $DEMO. Sets LOG_B.
clone_machine_b()
{
    (cd "$WS" && SELF sync > /dev/null)
    machine B
    mkdir -p "$ROOT/B"
    cd "$ROOT/B"
    SELF clone "$ROOT/remote.git" ws > /dev/null
    mkdir -p "$ROOT/B/ws/demo"
    cd "$ROOT/B/ws/demo"
    git init -q -b main
    SELF project link demo > /dev/null
    LOG_B="$ROOT/B/ws/.superself/projects/demo/log.jsonl"
    machine A
    cd "$DEMO"
}

# outside_project — a project registered from outside the workspace tree, for
# the suites that assert cross-project reads and untouched-project folds.
outside_project()
{
    mkdir -p "$ROOT/outside/app"
    cd "$ROOT/outside/app"
    git init -q -b main
    SELF project add --name outside --desc "registered from outside the workspace tree" --no-connect > /dev/null
    SELF goal set "prove out-of-tree projects work" > /dev/null
    cd "$DEMO"
}

# pty_self TYPED CMD... — the same command under a real pseudo-terminal, with
# TYPED sent as the operator's answer. The feeder stays open after the line:
# closing it immediately delivers an EOF to the terminal before the prompt has
# read, which is not what a human's terminal ever does.
PROOF_PTY_HOLD="${PROOF_PTY_HOLD:-1}"
pty_self()
{
    local typed="$1"
    shift
    if script --version > /dev/null 2>&1
    then
        { printf '%s\n' "$typed"; sleep "$PROOF_PTY_HOLD"; } | script -qec "node $SELF_JS $*" /dev/null > /dev/null 2>&1 || true
    else
        { printf '%s\n' "$typed"; sleep "$PROOF_PTY_HOLD"; } | script -q /dev/null node "$SELF_JS" "$@" > /dev/null 2>&1 || true
    fi
}

# a policy is granted by a person at a terminal. The name states the intent at
# the call site; the mechanics are pty_self's.
grant_policy()
{
    pty_self "$@"
}

await()
{
    local until="$1" limit="${2:-40}"
    for _ in $(seq "$limit")
    do
        if eval "$until"
        then
            return 0
        fi
        sleep 0.5
    done
    return 1
}

attempt_state()
{
    SELF attempt show "$1" | sed -n 's/^state *//p' | awk '{print $1}'
}

attempts_of()
{
    SELF attempt list --work "$1" | awk '$1 ~ /^at-/ {print $1}'
}

tick_json()
{
    SELF daemon tick --json | tail -1
}

# reads $RUNNER — the machine-local runner state root the suite derived from
# the home it built.
spool_of()
{
    echo "$RUNNER/attempts/$1"
}

wake_settled()
{
    node -e '
const fs = require("node:fs");
const [file, workSpec] = process.argv.slice(1);
let wakes = [];
try { wakes = JSON.parse(fs.readFileSync(file, "utf8")); } catch { wakes = []; }
const running = wakes.filter((wake) => wake.workSpec === workSpec).filter((wake) =>
{
    try { process.kill(wake.child, 0); return true; }
    catch (error) { return error.code === "EPERM"; }
});
process.exit(running.length === 0 ? 0 : 1);
' "$RUNNER/daemon/wakes.json" "$1"
}

# reads $LOG_A
count_events()
{
    grep -c "\"type\":\"$1\"" "$LOG_A" || true
}

# reads $STORE; the demo log line count pins the exact event history
snapshot()
{
    (cd "$STORE" && find . -path ./.git -prune -o -print | sort)
    git -C "$STORE" rev-parse HEAD
    git -C "$STORE" status --porcelain
    wc -l < "$STORE/projects/demo/log.jsonl"
}
