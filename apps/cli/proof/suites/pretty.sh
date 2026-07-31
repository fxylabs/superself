#!/usr/bin/env bash
# Domain suite: the terminal render — `self context`, `self work` and
# `self status` draw ruled tables for a person watching, while piped output
# stays exactly the machine contract agents and every other suite read. The
# boundary is the whole feature, so most of what is asserted here is what the
# pipe must NOT carry.
# Runs alone: bash proof/suites/pretty.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

ESC="$(printf '\033')"
BOX='[┌┬┐├┼┤└┴┘│─]'

# pty_run COLUMNS COMMAND — COMMAND under a real pseudo-terminal of the stated
# width, with its output captured. BSD and util-linux `script` take their
# command differently. Two things a terminal adds are taken back off: the
# carriage returns, and the `^D` a tty echoes for the end-of-file its empty
# stdin hands it, which would otherwise sit in front of the first rule line.
pty_run()
{
    local columns="$1" command="$2"
    if script --version > /dev/null 2>&1
    then
        script -qec "stty columns $columns > /dev/null 2>&1; $command" /dev/null < /dev/null 2>&1 | tr -d '\r\b' | sed '1s/^\^D//'
    else
        script -q /dev/null sh -c "stty columns $columns > /dev/null 2>&1; $command" < /dev/null 2>&1 | tr -d '\r\b' | sed '1s/^\^D//'
    fi
}

demo_workspace

# The fixture carries what breaks a naive renderer: a Korean outcome whose
# every syllable spends two cells, an emoji, a combining mark, an outcome far
# wider than any terminal, and a blocked unit whose reason has to travel with
# its row.
W_KO="$(SELF work add "한글 아웃컴이 셀 폭을 두 칸씩 쓴다" | tail -1)"
SELF work start "$W_KO" > /dev/null
SELF report "$W_KO" "첫 번째 보고" > /dev/null
W_LONG="$(SELF work add "an outcome far wider than any terminal will ever be, which the renderer has to shorten without breaking the border it draws around it" | tail -1)"
SELF work start "$W_LONG" > /dev/null
SELF work block "$W_LONG" --on dependency --why "기다리는 이유 — waiting on an upstream repository" > /dev/null
SELF work add "emoji 😀 and a combining e-acute é in one outcome" > /dev/null
W_DONE="$(SELF work add "a unit that is already done" | tail -1)"
SELF work start "$W_DONE" > /dev/null
SELF work done "$W_DONE" > /dev/null
W_NEXT="$(SELF work add "a unit a proposal gates" | tail -1)"
SELF convention add "records in English" > /dev/null
SELF decide "draw ruled tables on a terminal" --why "a person reads columns faster than sentences" > /dev/null
D_GATE="$(SELF decide "adopt the box-drawing table" --proposed --blocks "$W_NEXT" | sed -E 's/.*\[([^]]+)\].*/\1/')"
SELF decide "pick the colour palette" --proposed --after "$D_GATE" > /dev/null

# ── the pipe carries no decoration ────────────────────────────────────────
# The single assertion the whole feature stands on: nothing an agent or a
# sibling suite reads may gain an escape byte or a box character.
for CMD in "work" "status" "context" "log"
do
    PIPED="$(SELF $CMD)"
    case "$PIPED" in
        *"$ESC"*) fail "self $CMD leaked an escape sequence into piped output" ;;
    esac
    printf '%s\n' "$PIPED" | grep -q "$BOX" && fail "self $CMD leaked a box character into piped output"
done

# `--plain` is the same bytes from anywhere, so a person can hand an agent's
# output back without knowing which terminal produced it.
[ "$(SELF work)" = "$(SELF work --plain)" ] || fail "self work --plain differs from piped self work"
[ "$(SELF status)" = "$(SELF status --plain)" ] || fail "self status --plain differs from piped self status"
[ "$(SELF context)" = "$(SELF context --plain)" ] || fail "self context --plain differs from piped self context"

# The 12,000-character budget is the piped render's, and the ruled render must
# not be reachable through it — measuring or inflating it would spend an
# agent's window on borders it never receives.
CONTEXT_CHARS="$(SELF context | wc -m | tr -d ' ')"
[ "$CONTEXT_CHARS" -le 12000 ] || fail "piped context exceeded 12,000 characters ($CONTEXT_CHARS)"
SELF context --pretty | grep -q "$BOX" || fail "the forced ruled context drew no table"

# ── the ruled render ──────────────────────────────────────────────────────
WORK_PRETTY="$(SELF work --pretty)"
echo "$WORK_PRETTY" | grep -q "│ ID" || fail "the work table has no ID column"
echo "$WORK_PRETTY" | grep -q "STATE" || fail "the work table has no STATE column"
echo "$WORK_PRETTY" | grep -q "OUTCOME" || fail "the work table has no OUTCOME column"
echo "$WORK_PRETTY" | grep -q "REPORTS" || fail "the work table has no REPORTS column"
echo "$WORK_PRETTY" | grep -q "↳ blocked on dependency" || fail "a blocked row carried no second line naming its block"
echo "$WORK_PRETTY" | grep -q "기다리는 이유" || fail "a blocked row dropped the reason it was blocked on"
echo "$WORK_PRETTY" | grep -q "1 done — see log" || fail "the work table lost its closed-unit footer"
# Every label the render writes itself is English; recorded content keeps the
# language it was recorded in.
echo "$WORK_PRETTY" | grep -q "한글 아웃컴" || fail "a Korean outcome did not survive the render"

# The geometry: rule lines and content lines agree on the cell count, with a
# Korean, an emoji and a combining-mark row in the same table.
SELF work --pretty | node "$CLI_DIR/proof/pretty-width.mjs" > /dev/null \
    || fail "the work table does not align on cell width"
SELF context --pretty | node "$CLI_DIR/proof/pretty-width.mjs" > /dev/null \
    || fail "the context tables do not align on cell width"

# An empty section says so on one line instead of drawing an empty box.
CONTEXT_PRETTY="$(SELF context --pretty)"
echo "$CONTEXT_PRETTY" | grep -q "^INTEGRATION (0)$" || fail "the context render has no counted integration heading"
echo "$CONTEXT_PRETTY" | grep -A1 "^INTEGRATION (0)$" | grep -q "^  none$" \
    || fail "an empty section did not render exactly one none line under its heading"
echo "$CONTEXT_PRETTY" | grep -q "^WORK (1 active · 1 blocked · 2 next · 1 done)$" \
    || fail "the work heading did not count the bands"

# The attention band keeps the model's ranking, one table per group, and the
# groups stay in the order a reader acts on them.
echo "$CONTEXT_PRETTY" | grep -q "^DECISIONS WAITING (1 unblock work · 1 cannot be decided yet · 0 already in effect)$" \
    || fail "the attention heading did not count the three groups"
echo "$CONTEXT_PRETTY" | grep -q "^CONFIRMING UNBLOCKS WORK (1)$" || fail "the unblocks group has no table section"
echo "$CONTEXT_PRETTY" | grep -q "^CANNOT BE DECIDED YET (1)$" || fail "the undecidable group has no table section"
UNBLOCKS_AT="$(echo "$CONTEXT_PRETTY" | grep -n "^CONFIRMING UNBLOCKS WORK" | cut -d: -f1)"
UNDECIDABLE_AT="$(echo "$CONTEXT_PRETTY" | grep -n "^CANNOT BE DECIDED YET" | cut -d: -f1)"
[ "$UNBLOCKS_AT" -lt "$UNDECIDABLE_AT" ] || fail "the attention groups were not rendered in ranked order"
echo "$CONTEXT_PRETTY" | grep -q "│ UNBLOCKS" || fail "the unblocks table names what confirming would unblock"
echo "$CONTEXT_PRETTY" | grep -q "$W_NEXT" || fail "the unblocks row did not name the work it gates"
# A confirm command that lost characters to a column boundary cannot be pasted.
echo "$CONTEXT_PRETTY" | grep -q "↳ self decide confirm $D_GATE " || fail "the confirm command was truncated inside its row"
# A gated unit says so on its own row even though it never started, which is
# what inverting the relation buys over `work block --on decision`.
echo "$WORK_PRETTY" | grep -q "↳ gated by $D_GATE" || fail "a gated unit did not name the proposal gating it"

# A section that stops short names what it left and how to pull the rest.
for INDEX in 1 2 3 4 5 6 7 8 9
do
    SELF work add "filler outcome $INDEX for the truncation rule" > /dev/null
done
SELF context --pretty | grep -q "… +[0-9]* more · self work" || fail "an over-long section did not name its recovery command"
SELF context --pretty | node "$CLI_DIR/proof/pretty-width.mjs" > /dev/null \
    || fail "a truncated table does not align on cell width"

# ── attempts roll up per work unit on a terminal only ─────────────────────
SPOOL="$HOME/.local/state/superself/runner/attempts"
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
spool_status()
{
    mkdir -p "$SPOOL/$1"
    printf '{"attempt":"%s","work":"%s","project":"demo","role":"impl","state":"%s","run":1,"runs":1,"fence":1,"nodeId":"n","bootId":"b","failure":"%s","created":"%s","updated":"%s"}\n' \
        "$1" "$2" "$3" "$4" "$NOW" "$NOW" > "$SPOOL/$1/status.json"
}
spool_status at-pf1 "$W_KO" failed timeout
spool_status at-pf2 "$W_KO" failed timeout
spool_status at-pf3 "$W_KO" failed gate
spool_status at-pc1 "$W_KO" cancelled ""
STATUS_PRETTY="$(SELF status --pretty)"
echo "$STATUS_PRETTY" | grep -q "3 failed (timeout ×2, gate ×1)" || fail "the attempt roll-up did not count failures by kind"
echo "$STATUS_PRETTY" | grep -q "1 cancelled" || fail "the attempt roll-up did not count cancelled attempts"
[ "$(echo "$STATUS_PRETTY" | grep -c "$W_KO")" = 1 ] || fail "four attempts on one unit did not roll up to one row"
SELF status --pretty | node "$CLI_DIR/proof/pretty-width.mjs" > /dev/null \
    || fail "the attempt table does not align on cell width"
# The pipe keeps one line per attempt: a script still needs every id.
[ "$(SELF status | grep -c '^attempt at-p')" = 4 ] || fail "piped status stopped listing attempts one per line"
SELF status | grep -q "attempt at-pf3 $W_KO: failed (gate)" || fail "piped status lost an attempt line"

# ── the two flags disagree ────────────────────────────────────────────────
BOTH="$(SELF work --pretty --plain 2>&1)" && fail "asking for both renders at once was accepted"
echo "$BOTH" | grep -q "pass one of them" || fail "the conflicting-render refusal does not say what to do"
echo "$BOTH" | grep -q "    at " && fail "the conflicting-render refusal printed a stack trace"

# ── detection at a real terminal ──────────────────────────────────────────
PROBE="$(pty_run 100 "node $CLI_DIR/proof/pretty-terminal.mjs" || true)"
case "$PROBE" in
    *true:100:*)
        WIDE="$(pty_run 100 "node $SELF_JS work")"
        printf '%s\n' "$WIDE" | grep -q "$BOX" || fail "a 100-column terminal did not get the ruled render"
        case "$WIDE" in
            *"$ESC"*) : ;;
            *) fail "a colour-capable terminal got no colour at all" ;;
        esac

        # NO_COLOR keeps the table and drops the colour: alignment is not a
        # colour, and a reader who turned colour off still wants columns.
        NOCOLOR="$(NO_COLOR=1 pty_run 100 "node $SELF_JS work")"
        printf '%s\n' "$NOCOLOR" | grep -q "$BOX" || fail "NO_COLOR removed the table as well as the colour"
        case "$NOCOLOR" in
            *"$ESC"*) fail "NO_COLOR still painted the terminal render" ;;
        esac

        # A dumb terminal renders no escape sequence, so it is answered like a
        # pipe rather than shown the bytes raw.
        DUMB="$(TERM=dumb pty_run 100 "node $SELF_JS work")"
        printf '%s\n' "$DUMB" | grep -q "$BOX" && fail "TERM=dumb still drew a ruled table"
        case "$DUMB" in
            *"$ESC"*) fail "TERM=dumb still painted the terminal render" ;;
        esac

        # --plain at a terminal is the machine contract, byte for byte.
        PLAIN_TTY="$(pty_run 100 "node $SELF_JS work --plain")"
        [ "$PLAIN_TTY" = "$(SELF work)" ] || fail "--plain at a terminal differs from piped output"
        ;;
    *)
        echo "pretty: no pseudo-terminal available ($PROBE); terminal detection not exercised"
        ;;
esac

NARROW_PROBE="$(pty_run 40 "node $CLI_DIR/proof/pretty-terminal.mjs" || true)"
case "$NARROW_PROBE" in
    *true:40:*)
        # Four ruled columns do not fit, and a table whose every cell is an
        # ellipsis is worse than the lines it replaced.
        NARROW="$(pty_run 40 "node $SELF_JS work")"
        printf '%s\n' "$NARROW" | grep -q "$BOX" && fail "a 40-column terminal was still given a ruled table"
        ;;
    *)
        echo "pretty: no resizable pseudo-terminal ($NARROW_PROBE); the narrow fallback not exercised"
        ;;
esac

echo "pretty OK"
