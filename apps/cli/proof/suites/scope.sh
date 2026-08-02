#!/usr/bin/env bash
# Domain suite: the read scope — every read verb answers for the project the
# directory resolves to, `--project <slug>` moves it to another registered
# project, and `--workspace` aggregates all of them. A write verb has neither
# flag. The whole feature is a read, so most of what is asserted here is that
# resolving another project changed nothing in it.
# Runs alone: bash proof/suites/scope.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

ESC="$(printf '\033')"

# pty_run COLUMNS COMMAND — COMMAND under a real pseudo-terminal of the stated
# width, with its output captured. BSD and util-linux `script` take their
# command differently.
#
# TERM is pinned because the render reads it: some hosts hand `script`'s child
# TERM=dumb, and `dumbTerminal` answers a dumb terminal with the plain render.
# That is the correct answer to a different question than the one the width
# assertions below ask, and a suite that did not pin it failed on exactly those
# hosts while passing everywhere else. The dumb terminal keeps its own
# assertion, which sets TERM itself.
pty_run()
{
    local columns="$1" command="$2"
    if script --version > /dev/null 2>&1
    then
        script -qec "stty columns $columns > /dev/null 2>&1; TERM=${PROOF_TERM:-xterm-256color} $command" /dev/null < /dev/null 2>&1 | tr -d '\r\b' | sed '1s/^\^D//'
    else
        script -q /dev/null sh -c "stty columns $columns > /dev/null 2>&1; TERM=${PROOF_TERM:-xterm-256color} $command" < /dev/null 2>&1 | tr -d '\r\b' | sed '1s/^\^D//'
    fi
}

# refuses MESSAGE ARGV... — the command exits non-zero, says MESSAGE, and never
# prints a stack trace.
refuses()
{
    local wanted="$1"
    shift
    if OUT="$(SELF "$@" 2>&1)"
    then
        fail "self $* was accepted; it must refuse ($wanted)"
    fi
    echo "$OUT" | grep -qF "$wanted" || fail "self $* did not say: $wanted"
    if echo "$OUT" | grep -q "    at "
    then
        fail "self $* printed a stack trace"
    fi
}

demo_workspace
outside_project

# two projects with state of their own, so a scoped read has something to be
# right or wrong about
DEMO_OID="$(SELF objective add "demo objective the scope reads" --horizon week --target 2099-01-01 | tail -1)"
DEMO_MID="$(SELF milestone add "demo checkpoint" --objective "$DEMO_OID" --exit "the scope resolves" | tail -1)"
SELF work add "demo work the scope reads" > /dev/null
cd "$ROOT/outside/app"
OUT_OID="$(SELF objective add "outside objective the scope reads" | tail -1)"
SELF milestone add "outside checkpoint" --objective "$OUT_OID" --exit "the outside scope resolves" > /dev/null
cd "$DEMO"

# ── the default is the project this directory belongs to ──────────────────
SELF status | grep -q "^demo — goal: prove two-machine sync" || fail "status did not default to this directory's project"
SELF context | grep -q "^# demo" || fail "context did not default to this directory's project"
SELF objective | grep -q "demo objective the scope reads" || fail "objective did not default to this directory's project"
SELF milestone | grep -q "demo checkpoint" || fail "milestone did not default to this directory's project"
SELF log | grep -q "demo objective the scope reads" || fail "log did not default to this directory's project"
SELF objective | grep -q "outside objective" && fail "the default objective list reached another project"
SELF log | grep -q "outside objective" && fail "the default log reached another project"

# ── --project answers for another registered project ──────────────────────
SELF status --project outside | grep -q "^outside — goal: prove out-of-tree projects work" || fail "status --project read the wrong project"
SELF context --project outside | grep -q "^# outside" || fail "context --project read the wrong project"
SELF objective --project outside | grep -q "outside objective the scope reads" || fail "objective --project read the wrong project"
SELF milestone --project outside | grep -q "outside checkpoint" || fail "milestone --project read the wrong project"
SELF log --project outside | grep -q "outside objective the scope reads" || fail "log --project read the wrong project"
SELF objective show "$OUT_OID" --project outside | grep -q "outside objective the scope reads" || fail "objective show --project read the wrong project"
SELF milestone --project outside | grep -q "demo checkpoint" && fail "milestone --project also printed this directory's project"
# naming this directory's own project is the same answer as naming nothing
[ "$(SELF milestone --project demo)" = "$(SELF milestone)" ] || fail "--project demo differed from the default inside demo"

# the flag is what decides, not the directory: the same reads answer from a
# directory that belongs to no project at all
cd "$ROOT"
SELF status --project demo | grep -q "^demo — goal:" || fail "status --project demanded a project directory"
SELF log --project demo -n 3 | grep -q "objective.created" || fail "log --project demanded a project directory"
SELF objective --project demo | grep -q "demo objective the scope reads" || fail "objective --project demanded a project directory"
SELF context --project demo | grep -q "^# demo" || fail "context --project demanded a project directory"
cd "$DEMO"

# ── the context cap is per rendered project, --project included ────────────
FILL="$(awk 'BEGIN { for (i = 0; i < 3000; i++) printf "d" }')"
cd "$ROOT/outside/app"
for index in 1 2 3 4 5 6
do
    SELF decide "outside budget decision $index $FILL" > /dev/null
done
cd "$DEMO"
SCOPED_CHARS="$(SELF context --project outside | wc -m | tr -d ' ')"
[ "$SCOPED_CHARS" -le 12000 ] || fail "context --project ignored the 12,000-character cap ($SCOPED_CHARS)"
SELF context --project outside | grep -q "omitted; run" || fail "the capped cross-project context named no recovery command"

# ── a scoped read's recovery pointers name the project they pull from ──────
# Context is read far from where it was produced. A pointer that named no
# project answered for wherever it was pasted, so `self context --project
# outside` handed back commands that read demo (#165 review round 1).
#
# bare_pointers OUTPUT — every backticked pointer naming a read verb that has a
# scope form but carries no --project. Any hit is the defect.
bare_pointers()
{
    printf '%s\n' "$1" | grep -oE '`self (work show [^ `]+|work|status|objective|milestone|context|log)`' || true
    printf '%s\n' "$1" | grep -oE '`self search [^`]*`' | grep -v -- '--project' || true
}

SCOPED_CTX="$(SELF context --project outside)"
echo "$SCOPED_CTX" | grep -q -- "--project 'outside'" || fail "a scoped context named no project on any recovery pointer"
echo "$SCOPED_CTX" | grep -q -- "--project 'demo'" && fail "a scoped context pointed at the directory's own project"
BARE="$(bare_pointers "$SCOPED_CTX")"
[ -z "$BARE" ] || fail "a scoped context carried an unscoped read pointer: $BARE"
# the default render is scoped too, so its output stays portable once piped.
# It has to be pushed past the budget first: an uncompacted context prints no
# recovery pointer at all, so asserting on one there would prove nothing.
for index in 1 2 3 4 5 6
do
    SELF decide "demo budget decision $index $FILL" > /dev/null
done
OWN_CTX="$(SELF context)"
echo "$OWN_CTX" | grep -q -- "--project 'demo'" || fail "the default context named no project on any recovery pointer"
BARE="$(bare_pointers "$OWN_CTX")"
[ -z "$BARE" ] || fail "the default context carried an unscoped read pointer: $BARE"
# and the sibling read surfaces that print pointers hold the same rule
for ARGV in "status --project outside" "work --project outside" "status" "work"
do
    BARE="$(bare_pointers "$(SELF $ARGV)")"
    [ -z "$BARE" ] || fail "self $ARGV carried an unscoped read pointer: $BARE"
done
# a command with no scope form is not given one: the row says where to stand
echo "$SCOPED_CTX" | grep -q "self integration plan --project" && fail "a pointer promised --project on a verb that has none"

# ── a read of another project changes nothing in it ───────────────────────
BEFORE="$(snapshot)"
OUT_LOG_BEFORE="$(cat "$STORE/projects/outside/log.jsonl")"
OUT_STATE_BEFORE="$(cat "$STORE/projects/outside/state.md")"
SELF status --project outside > /dev/null
SELF context --project outside > /dev/null
SELF log --project outside > /dev/null
SELF objective --project outside > /dev/null
SELF milestone --project outside > /dev/null
SELF objective show "$OUT_OID" --project outside > /dev/null
SELF status --workspace > /dev/null
SELF log --workspace > /dev/null
SELF objective --workspace > /dev/null
[ "$(snapshot)" = "$BEFORE" ] || fail "reading another project wrote to the store"
[ "$(cat "$STORE/projects/outside/log.jsonl")" = "$OUT_LOG_BEFORE" ] || fail "reading another project appended to its log"
[ "$(cat "$STORE/projects/outside/state.md")" = "$OUT_STATE_BEFORE" ] || fail "reading another project refolded it"

# ── --workspace aggregates every registered project ───────────────────────
WS_STATUS="$(SELF status --workspace)"
echo "$WS_STATUS" | grep -q "^demo — prove two-machine sync" || fail "status --workspace omitted demo"
echo "$WS_STATUS" | grep -q "^outside — prove out-of-tree projects work" || fail "status --workspace omitted outside"
# from inside a project too: the flag decides, not the directory
[ "$WS_STATUS" = "$(cd "$ROOT" && SELF status)" ] || fail "status --workspace inside a project differed from the workspace summary"

WS_OBJ="$(SELF objective --workspace)"
echo "$WS_OBJ" | grep -q "^demo$" || fail "objective --workspace did not name the project a row belongs to"
echo "$WS_OBJ" | grep -q "^outside$" || fail "objective --workspace omitted a registered project"
echo "$WS_OBJ" | grep -q "demo objective the scope reads" || fail "objective --workspace omitted demo's objectives"
echo "$WS_OBJ" | grep -q "outside objective the scope reads" || fail "objective --workspace omitted outside's objectives"

# every project's events on one timeline, each line saying where it happened,
# and the limit applied to the merge rather than to each project
WS_LOG="$(SELF log --workspace -n 60)"
echo "$WS_LOG" | grep -q "^demo  .*objective.created" || fail "log --workspace did not lead a demo line with its project"
echo "$WS_LOG" | grep -q "^outside  .*objective.created" || fail "log --workspace omitted another project's events"
[ "$(SELF log --workspace -n 3 | wc -l | tr -d ' ')" = "3" ] || fail "log --workspace applied the limit per project instead of to the merge"
[ "$(SELF log --workspace -n 3)" = "$(SELF log --workspace -n 60 | tail -3)" ] \
    || fail "log --workspace cut the newest events instead of the oldest"
# the merged timeline is sorted, so the last line is the newest event overall
[ "$(SELF log --workspace -n 1)" = "$(SELF log --workspace -n 60 | tail -1)" ] || fail "log --workspace did not merge in timestamp order"
# the single-project form is untouched: no project column, same bytes as before
SELF log -n 3 | grep -q "^demo  " && fail "the single-project log grew a project column"

# ── a project registered here but linked on another machine still reads ───
clone_machine_b
machine B
cd "$ROOT/B/ws"
SELF status --project outside | grep -q "^outside — goal: prove out-of-tree projects work" \
    || fail "a project registered but not linked on this machine could not be read"
SELF log --project outside -n 60 | grep -q "objective.created" || fail "an unlinked project's log could not be read"
SELF objective --project outside | grep -q "outside objective the scope reads" || fail "an unlinked project's objectives could not be read"
SELF status --workspace | grep -q "^outside — " || fail "--workspace skipped a project this machine never linked"
machine A
cd "$DEMO"

# ── refusals ──────────────────────────────────────────────────────────────
# an unknown slug is named once, and identically, by every read verb: one
# resolver stands behind them, and a verb that grew a second one says so here
UNKNOWN='unknown project "nope" — registered: demo, outside'
refuses "$UNKNOWN" status --project nope
refuses "$UNKNOWN" context --project nope
refuses "$UNKNOWN" log --project nope
refuses "$UNKNOWN" objective --project nope
refuses "$UNKNOWN" milestone --project nope
refuses "$UNKNOWN" objective show "$DEMO_OID" --project nope
refuses "$UNKNOWN" work --project nope

# both scope flags at once is two different asks, so neither silently wins
BOTH="pass one of them, not both"
refuses "$BOTH" status --project demo --workspace
refuses "$BOTH" log --project demo --workspace
refuses "$BOTH" objective --project demo --workspace

# a verb with no workspace form says so as a flag it never declared, pointing
# at the help that explains why it has none
refuses "unknown option '--workspace'" context --workspace
refuses "unknown option '--workspace'" milestone --workspace
refuses "unknown option '--workspace'" work --workspace
SELF context --help | grep -q "no --workspace form" || fail "context help does not say why it has no workspace form"
SELF milestone --help | grep -q "no --workspace form" || fail "milestone help does not say why it has no workspace form"

# a write is bound to the project it runs in: a scope flag there is refused
# before the write, not swallowed into it
LOG_BEFORE="$(wc -l < "$LOG_A")"
OUT_LOG_BEFORE="$(wc -l < "$STORE/projects/outside/log.jsonl")"
STORE_BEFORE="$(git -C "$STORE" rev-list --count HEAD)"
refuses "unknown option '--project'" objective add "never recorded" --project outside
refuses "unknown option '--project'" objective revise "$DEMO_OID" --project outside --why "never recorded"
refuses "unknown option '--project'" objective close "$DEMO_OID" --project outside --as dropped
refuses "unknown option '--project'" objective confirm "$DEMO_OID" --project outside
refuses "unknown option '--project'" milestone add "never recorded" --objective "$DEMO_OID" --exit x --project outside
refuses "unknown option '--project'" milestone met "$DEMO_MID" --criterion c1 --why "never recorded" --project outside
refuses "unknown option '--project'" milestone reach "$DEMO_MID" --project outside
refuses "unknown option '--project'" milestone recheck "$DEMO_MID" --why "never recorded" --project outside
refuses "unknown option '--project'" milestone revise "$DEMO_MID" --why "never recorded" --exit x --project outside
refuses "unknown option '--project'" goal set "never recorded" --project outside
refuses "unknown option '--project'" work add "never recorded" --project outside
refuses "unknown option '--project'" decide "never recorded" --project outside
refuses "unknown option '--workspace'" objective add "never recorded" --workspace
refuses "unknown option '--workspace'" work add "never recorded" --workspace
[ "$(wc -l < "$LOG_A")" = "$LOG_BEFORE" ] || fail "a scope flag on a write still wrote an event"
[ "$(wc -l < "$STORE/projects/outside/log.jsonl")" = "$OUT_LOG_BEFORE" ] || fail "a scope flag on a write wrote into the named project"
[ "$(git -C "$STORE" rev-list --count HEAD)" = "$STORE_BEFORE" ] || fail "a refused scope flag committed to the store"
grep -q "never recorded" "$LOG_A" && fail "a refused write reached the log"

# the verbs that moved onto the argument gate now name a stray argument
# instead of dropping it — the #28 class, unclosed on this surface until now
refuses "unexpected argument 'surplus'" objective add "never recorded" surplus
refuses "unexpected argument 'surplus'" objective show "$DEMO_OID" surplus
refuses "unexpected argument 'surplus'" objective close "$DEMO_OID" surplus --as dropped
refuses "unexpected argument 'surplus'" milestone add "never recorded" surplus --objective "$DEMO_OID" --exit x
refuses "unexpected argument 'surplus'" milestone show "$DEMO_MID" surplus
refuses "unexpected argument 'surplus'" milestone reach "$DEMO_MID" surplus
refuses "unexpected argument 'surplus'" milestone met "$DEMO_MID" surplus --criterion c1 --why w
# and an unknown flag on the verbs that took no options at all before
refuses "unknown option '--bogus'" objective show "$DEMO_OID" --bogus
refuses "unknown option '--bogus'" objective confirm "$DEMO_OID" --bogus
refuses "unknown option '--bogus'" milestone show "$DEMO_MID" --bogus
refuses "unknown option '--bogus'" milestone reach "$DEMO_MID" --bogus
refuses "unknown option '--bogus'" objective --project demo --bogus
refuses "unknown option '--bogus'" log --workspace --bogus
[ "$(wc -l < "$LOG_A")" = "$LOG_BEFORE" ] || fail "a rejected argument on a moved verb still wrote an event"

# a separator where a subcommand belongs is explained here too
for ARGV in "objective -- add" "milestone -- add"
do
    BADSEP="$(SELF $ARGV "never created" 2>&1 || true)"
    echo "$BADSEP" | grep -q "expects a subcommand" || fail "self $ARGV did not explain the separator in place of a subcommand"
done

# a workspace-wide read of a workspace holding nothing says so, rather than
# printing silence a reader would take for "nothing is happening"
machine E
mkdir -p "$ROOT/E/ws"
cd "$ROOT/E/ws"
SELF init --lang en > /dev/null
EMPTY="this workspace has no registered projects"
refuses "$EMPTY" status --workspace
refuses "$EMPTY" log --workspace
refuses "$EMPTY" objective --workspace
# without the flag the summary is unchanged: nothing was asked for by name
SELF status | grep -q "no projects registered" || fail "the empty-workspace summary changed"
refuses 'unknown project "demo" — this workspace has no registered projects' status --project demo
machine A
cd "$DEMO"

# ── the pipe carries the machine contract, the terminal carries the render ─
for ARGV in "status --workspace" "log --workspace" "objective --workspace" "status --project outside" "context --project outside"
do
    case "$(SELF $ARGV)" in
        *"$ESC"*) fail "self $ARGV leaked an escape sequence into piped output" ;;
    esac
done
# --plain is what a pipe already gets, and --pretty is the ruled render, on the
# workspace form exactly as on the project form
[ "$(SELF status --workspace --plain)" = "$(SELF status --workspace)" ] || fail "--plain changed the piped workspace status"
[ "$(SELF status --project outside --plain)" = "$(SELF status --project outside)" ] || fail "--plain changed the piped scoped status"
SELF status --workspace --pretty | grep -q "│" || fail "--pretty did not draw the ruled workspace render"
SELF context --project outside --pretty | grep -q "^WORK (" || fail "--pretty did not draw the terminal render for a named project"
SELF context --project outside | grep -q "^## " || fail "the piped render for a named project is not the capped agent output"
BOTHRENDER="$(SELF status --workspace --pretty --plain 2>&1)" && fail "asking for both renders at once was accepted on the workspace form"
echo "$BOTHRENDER" | grep -q "pass one of them" || fail "the conflicting-render refusal was lost on the workspace form"

# The probe reports isTTY, columns and TERM. A dumb terminal is answered like a
# pipe by design, so it is skipped here rather than asserted against — reading
# `true:100:` alone accepted TERM=dumb and then demanded a ruled render the
# renderer is right to withhold.
PROBE="$(pty_run 100 "node $CLI_DIR/proof/pretty-terminal.mjs" || true)"
case "$PROBE" in
    *true:100:dumb*)
        echo "scope: the pseudo-terminal reports TERM=dumb ($PROBE); the ruled render is not exercised"
        ;;
    *true:100:?*)
        # a terminal gets the ruled render for a named project and for the
        # workspace, and --plain at a terminal is the piped bytes exactly
        WIDE="$(pty_run 100 "node $SELF_JS status --workspace")"
        printf '%s\n' "$WIDE" | grep -q "│" || fail "a 100-column terminal did not get the ruled workspace render"
        SCOPED="$(pty_run 100 "node $SELF_JS context --project outside")"
        printf '%s\n' "$SCOPED" | grep -q "WORK (0 active" || fail "a 100-column terminal did not get the terminal render for a named project"
        PLAIN_TTY="$(pty_run 100 "node $SELF_JS status --workspace --plain")"
        [ "$PLAIN_TTY" = "$(SELF status --workspace)" ] || fail "--plain at a terminal differs from the piped workspace status"
        # the log and objective forms colour at a terminal and stay plain in a
        # pipe, the project column surviving both
        TTY_LOG="$(pty_run 100 "node $SELF_JS log --workspace -n 60")"
        printf '%s\n' "$TTY_LOG" | grep -q "outside" || fail "the terminal workspace log dropped the project column"
        case "$TTY_LOG" in
            *"$ESC"*) : ;;
            *) fail "a colour-capable terminal got no colour on the workspace log" ;;
        esac
        NOCOLOR_LOG="$(NO_COLOR=1 pty_run 100 "node $SELF_JS log --workspace -n 60")"
        [ "$NOCOLOR_LOG" = "$(SELF log --workspace -n 60)" ] || fail "NO_COLOR at a terminal differs from the piped workspace log"
        ;;
    *)
        echo "scope: no pseudo-terminal available ($PROBE); terminal detection not exercised"
        ;;
esac

echo "scope OK"
