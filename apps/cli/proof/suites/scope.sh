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

# Every event, never a window. A presence claim must not depend on how many
# events the fixture happened to write before it: a window sized near the
# fixture's own length passes or fails on that number, and CI crossed exactly
# that edge three events from the boundary (#165). The number is meaningless on
# its own — it is "larger than any fixture this suite builds" — so it is named
# once here rather than open-coded wherever a timeline is read.
WHOLE_TIMELINE=100000

# The windows the merge assertions ask for. The snapshot floor below is derived
# from these, so moving a window moves its own floor with it.
WS_WINDOW=3
WS_NEWEST=1

# How many lines the render-shape check below samples. Not a window claim — it
# asserts the single-project form carries no project column, and one line would
# do — but every other numeric literal in this suite is named, so this one is
# too rather than reading as a window someone must interpret (#165 review 12).
SHAPE_SAMPLE=3

# The plain log rendering is parsed here, never by whitespace field index: a
# slug may contain spaces and a summary may contain newlines, and both shift a
# field-index parse into passing for the wrong reason. See the file's header.
LOG_KEYS="$CLI_DIR/proof/log-keys.mjs"

# log_events RENDERING MODE [N] — the rendering read by shape.
log_events()
{
    local rendering="$1"
    shift
    printf '%s\n' "$rendering" | node "$LOG_KEYS" "$@" 2> "$ROOT/log-keys.err"
}

# parses RENDERING WHAT — the rendering must parse: a line carrying a timestamp
# or an id anywhere but where an event line carries them stops the suite naming
# that line. Called at top level and never inside a substitution, because `fail`
# there would exit the subshell and let the run continue past the parse it just
# refused.
parses()
{
    log_events "$1" count > /dev/null || fail "$2 did not parse: $(cat "$ROOT/log-keys.err")"
}

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
DEMO_WID="$(SELF work add "demo work the scope reads" | tail -1)"
cd "$ROOT/outside/app"
OUT_OID="$(SELF objective add "outside objective the scope reads" | tail -1)"
OUT_MID="$(SELF milestone add "outside checkpoint" --objective "$OUT_OID" --exit "the outside scope resolves" | tail -1)"
cd "$DEMO"

# ── the default is the project this directory belongs to ──────────────────
SELF status | grep -q "^demo — goal: prove two-machine sync" || fail "status did not default to this directory's project"
SELF context | grep -q "^# demo" || fail "context did not default to this directory's project"
SELF objective | grep -q "demo objective the scope reads" || fail "objective did not default to this directory's project"
SELF milestone | grep -q "demo checkpoint" || fail "milestone did not default to this directory's project"
SELF log -n "$WHOLE_TIMELINE" | grep -q "demo objective the scope reads" || fail "log did not default to this directory's project"
SELF objective | grep -q "outside objective" && fail "the default objective list reached another project"
SELF log -n "$WHOLE_TIMELINE" | grep -q "outside objective" && fail "the default log reached another project"

# ── --project answers for another registered project ──────────────────────
SELF status --project outside | grep -q "^outside — goal: prove out-of-tree projects work" || fail "status --project read the wrong project"
SELF context --project outside | grep -q "^# outside" || fail "context --project read the wrong project"
SELF objective --project outside | grep -q "outside objective the scope reads" || fail "objective --project read the wrong project"
SELF milestone --project outside | grep -q "outside checkpoint" || fail "milestone --project read the wrong project"
SELF log --project outside -n "$WHOLE_TIMELINE" | grep -q "outside objective the scope reads" || fail "log --project read the wrong project"
SELF objective show "$OUT_OID" --project outside | grep -q "outside objective the scope reads" || fail "objective show --project read the wrong project"
SELF milestone --project outside | grep -q "demo checkpoint" && fail "milestone --project also printed this directory's project"
# naming this directory's own project is the same answer as naming nothing
[ "$(SELF milestone --project demo)" = "$(SELF milestone)" ] || fail "--project demo differed from the default inside demo"

# the flag is what decides, not the directory: the same reads answer from a
# directory that belongs to no project at all
cd "$ROOT"
SELF status --project demo | grep -q "^demo — goal:" || fail "status --project demanded a project directory"
SELF log --project demo -n "$WHOLE_TIMELINE" | grep -q "objective.created" || fail "log --project demanded a project directory"
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

# ── the ruled render carries the same rule ────────────────────────────────
# --pretty forces the ruled render into a pipe, so this needs no terminal. It
# is asserted separately because the two renders build their pointers in
# different modules: round 1 scoped the plain one and left `· self work`,
# `· self status` and `· self integration plan` bare in the ruled one (#165
# review round 2), and a check that only read the plain render passed anyway.
#
# bare_ruled OUTPUT — every ruled row pointing at a read verb without naming a
# project, or at a verb with no scope form without naming the checkout.
#
# Acceptance is by what the pointer actually says, never by "an option appears
# somewhere on the line": the predicate this replaced dropped every line
# carrying any `--`, so `· self search --type decision` and `· self status
# --plain` passed as scoped though neither names a project (#165 review round
# 3). Each exclusion below is safe for a stated reason:
#
#   from a checkout of    the standing requirement a verb with no scope form
#                         takes instead of a flag it does not have
#   self decide confirm | self attempt show | self work accept
#                         a write and a machine-local read. Neither has a
#                         --project form at all, so scoping them would promise
#                         a flag that does not exist
#   --project '<slug>'    the scope flag naming a project. The quote matters:
#                         `--project` with nothing after it renders when the
#                         slug is empty, and a bare flag names no project
RULED_OK="--project '|from a checkout of|self decide confirm|self attempt show|self work accept"

# The fourth exclusion is the table's own truncation, and it is the one that
# needs care. A ruled cell narrower than its text ends in `…`, so at 80 columns
# `· self status --…` is a scoped pointer the column cut and `· self status`
# standing alone is the defect — but a pointer elided before its flag is
# readable says nothing either way. Rather than guess, the elided case is
# excluded here and re-read by bare_wide below at a width that cuts nothing.
# On its own this line would hide a bare pointer; it is safe only because that
# second pass exists.
bare_ruled()
{
    printf '%s\n' "$1" | grep -F '· self ' | grep -vE -- "$RULED_OK" | grep -vE -- "· self [a-z ]*(--[a-z]*)?…" || true
}

# The same predicate with no truncation exclusion, for a terminal wide enough
# that nothing is cut. Anything elided there is a real finding.
bare_wide()
{
    printf '%s\n' "$1" | grep -F '· self ' | grep -vE -- "$RULED_OK" || true
}

# force the sections whose pointers only appear once a section overflows, and a
# gated unit, whose row carries a pointer of its own
cd "$ROOT/outside/app"
PRETTY_WID="$(SELF work add "a ruled-render unit a proposal gates" | tail -1)"
SELF decide "ruled render gate" --proposed --blocks "$PRETTY_WID" > /dev/null
for index in 1 2 3 4 5 6 7 8 9
do
    SELF objective add "ruled render objective $index" > /dev/null
    SELF decide "ruled render decision $index" > /dev/null
    SELF decide "ruled render proposal $index" --proposed > /dev/null
done
cd "$DEMO"

for ARGV in "context --project outside --pretty" "status --project outside --pretty" "work --project outside --pretty"
do
    RULED="$(SELF $ARGV)"
    BARE="$(bare_ruled "$RULED")"
    [ -z "$BARE" ] || fail "self $ARGV carried an unscoped ruled pointer: $BARE"
done

# and the assertion is not vacuous: each pointer it polices is really printed,
# naming the project the render is about rather than the caller's
RULED_CTX="$(SELF context --project outside --pretty)"
echo "$RULED_CTX" | grep -q "self objective --project 'outside'" || fail "the ruled objectives overflow printed no scoped pointer"
echo "$RULED_CTX" | grep -q "self search --type decision --project 'outside'" || fail "the ruled decisions overflow printed no scoped pointer"
# proposals rank into the decisions band, whose overflow row carries the other
# pointer the ruled render prints outside a table cell
echo "$RULED_CTX" | grep -q "self status --project 'outside'" || fail "the ruled decisions band printed no scoped pointer"
echo "$RULED_CTX" | grep -q -- "--project 'demo'" && fail "the ruled render pointed at the caller's project"

# the gated-by note sits in a table cell the 80-column pipe cuts, so it is read
# at a width that cuts nothing. Everything above is re-checked there under the
# stricter predicate, which is what makes the truncation exclusion above safe.
WIDE_PROBE="$(pty_run 200 "node $CLI_DIR/proof/pretty-terminal.mjs" || true)"
case "$WIDE_PROBE" in
    *true:200:dumb*)
        echo "scope: the wide pseudo-terminal reports TERM=dumb ($WIDE_PROBE); the uncut pass is not exercised"
        ;;
    *true:200:?*)
        for ARGV in "context --project outside" "status --project outside" "work --project outside"
        do
            WIDE="$(pty_run 200 "node $SELF_JS $ARGV" | sed 's/\x1b\[[0-9;]*m//g')"
            BARE="$(bare_wide "$WIDE")"
            [ -z "$BARE" ] || fail "self $ARGV at 200 columns carried an unscoped ruled pointer: $BARE"
        done
        pty_run 200 "node $SELF_JS work --project outside" | sed 's/\x1b\[[0-9;]*m//g' \
            | grep -q "· self status --project 'outside'" \
            || fail "the ruled gated-by note printed no scoped pointer at a width that cuts nothing"
        ;;
    *)
        echo "scope: no wide pseudo-terminal ($WIDE_PROBE); the uncut pass is not exercised"
        ;;
esac

# and the source rule behind both passes: every pointer literal in either
# render is judged by the call expression it sits in, not by what else happens
# to be on its line. That is what holds the rows no fixture reaches cheaply —
# and what a line grep could not do, since a bare literal beside a scoped one
# read as scoped (#165 review round 3).
#
# It is the smaller half of the rule now. Every section builder takes a branded
# `Pointer`, so a bare literal passed as a pointer fails `pnpm typecheck` and
# never reaches a proof; what remains here is prose — a pointer interpolated
# into a sentence — and the concatenation that assembles one out of halves
# (#165 review round 5).
node "$CLI_DIR/proof/scope-pointers.mjs" > /dev/null || fail "a render names a read verb in a pointer that never reaches scoped()"

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

# every project's events on one timeline, each line saying where it happened.
# The presence checks read the whole timeline rather than a window: the events
# they look for are among the oldest this fixture writes, so a window sized near
# the fixture's own length passes or fails on how many events the run happened
# to record. It was three events from its edge and CI crossed it.
# A timestamp tie first, so the id half of the merge key has something to order:
# `work accept` writes work.created, work.linked and work.accepted through one
# recordEvents call, and makeEvent stamps all three in the same millisecond.
# Without a tie the merge would sort correctly on timestamps alone and the
# tiebreak would never be exercised, leaving the order check weaker than it
# reads.
cd "$ROOT/outside/app"
TIE_PROPOSAL="$(SELF work propose "a proposal accepted in one call" --milestone "$OUT_MID" \
    --value "the id half of the merge key needs a timestamp tie to order" \
    --success "the tie is in the timeline" --stop "it lapses" --risk none \
    --capacity "one command" --evidence-plan "this suite reads it back" \
    --confidence high --expires 2099-01-01 | sed -E 's/.*\[([^]]+)\].*/\1/' | cut -c1-8)"
SELF work accept "$TIE_PROPOSAL" > /dev/null
cd "$DEMO"

# A summary the render has to wrap, written through the path that produces one:
# `report --file` reads arbitrary text and sanitize.ts allows LF, so a newline in
# a summary is one command away rather than hypothetical. It goes in before the
# timeline is read, so the parse is proved against it instead of meeting it in
# CI (#165 review round 12). Last, so the wrapped event sits inside the windows
# asserted below and the event-vs-line distinction is exercised rather than
# stated.
# A slug with spaces in it. The columns of this rendering are separated by two
# spaces, and a parse that split on whitespace read a slug token as the
# timestamp and the timestamp as the id — the count still agreed with itself and
# the order still reported valid while the id half went unchecked (#165 review
# round 12). Registered so the parse is proved against one rather than against
# slugs that happen to be single tokens.
SPACED_SLUG="a project named with spaces"
mkdir -p "$ROOT/spaced/app"
cd "$ROOT/spaced/app"
git init -q -b main
SELF project add --name "$SPACED_SLUG" --no-connect > /dev/null
SELF goal set "prove a slug with spaces parses" > /dev/null
cd "$DEMO"

printf 'a summary the log has to wrap\nand the continuation line it renders on its own\n' > "$ROOT/wrapped.txt"
SELF report "$DEMO_WID" --file "$ROOT/wrapped.txt" > /dev/null

WS_ALL="$(SELF log --workspace -n "$WHOLE_TIMELINE")"
echo "$WS_ALL" | grep -q "^demo  .*objective.created" || fail "log --workspace did not lead a demo line with its project"
echo "$WS_ALL" | grep -q "^outside  .*objective.created" || fail "log --workspace omitted another project's events"
echo "$WS_ALL" | grep -q "^and the continuation line it renders on its own$" \
    || fail "the wrapped summary did not reach the workspace log, so the parse is not proved against one"

# Every event the merge printed, read by shape rather than by field index.
parses "$WS_ALL" "the workspace timeline"
WS_EVENTS="$(log_events "$WS_ALL" count)"

# What the merge must contain, from a source that does not move with it: each
# project's own whole-timeline ids, read through the single-project path. Order
# and count cannot answer this — a sorted sequence stays sorted when a member is
# dropped or repeated, and both mutations passed every assertion this suite had
# (#165 review round 12). The projects are read out of the workspace rather than
# written down here, so a third one registered later is covered too.
# Which projects the workspace scope reports — and, before that list is trusted
# as the expected set, that it is the whole registry.
#
# Completeness was built on this list alone, and the merge is built from the
# same registered-project scope: both funnel through paths.ts readRegistry, so a
# mutation that shortened it shortened the expected set with it and the check
# went blind to exactly the omission it exists for (#165 review round 14).
#
# The independent source has to be the registry file. `self project` has no list
# verb — it takes `add` and `link` only — and every other enumeration in the CLI
# reaches readRegistry, so swapping one scoped read for another would change
# nothing. This is coverage asserted as its own claim rather than a second
# enumeration: once the scope is proved to cover the registry, the union may
# keep using it, and a dual-path omission fails here by name instead of
# surfacing as a confusing event-count mismatch.
#
# What it couples the proof to: the store's own layout — that registry.jsonl
# sits under the store directory and holds one JSON object per line with a slug.
# The project rule forbids hand-editing generated state, not reading it, and
# the file is parsed as JSON rather than pattern-matched, so a reordered or
# extended record still reads. A rename or a move of that file would fail this
# assertion, which is the honest cost of having any source the CLI cannot
# shorten.
registry_slugs()
{
    node -e '
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((line) => line.trim() !== "");
for (const line of lines)
{
    process.stdout.write(JSON.parse(line).slug + "\n");
}
' "$1"
}

SELF status --workspace | sed -E 's/ — .*//' > "$ROOT/ws-projects.txt"
[ "$(LC_ALL=C sort "$ROOT/ws-projects.txt")" = "$(registry_slugs "$STORE/registry.jsonl" | LC_ALL=C sort)" ] \
    || fail "the workspace scope does not report every registered project — it lists $(wc -l < "$ROOT/ws-projects.txt" | tr -d ' '), the registry holds $(registry_slugs "$STORE/registry.jsonl" | wc -l | tr -d ' ')"
: > "$ROOT/union-ids.txt"
# Read from a file rather than through a pipe: a `while` on the right of a pipe
# runs in a subshell, where `fail` would exit only that subshell and let the run
# continue past a parse it had just refused. IFS is cleared for the same reason
# the parse exists — a slug may contain spaces, and word splitting would ask for
# a project named after its first token.
while IFS= read -r slug
do
    [ -n "$slug" ] || continue
    PROJECT_ALL="$(SELF log --project "$slug" -n "$WHOLE_TIMELINE")"
    parses "$PROJECT_ALL" "the timeline of project \"$slug\""
    log_events "$PROJECT_ALL" ids >> "$ROOT/union-ids.txt"
done < "$ROOT/ws-projects.txt"
UNION_IDS="$(sort "$ROOT/union-ids.txt")"
UNION_COUNT="$(printf '%s\n' "$UNION_IDS" | awk 'NF > 0' | wc -l | tr -d ' ')"

# Uniqueness first, because it is what makes the equality below mean what it
# says: if two projects could mint the same event id, a merge that repeated one
# would still match the union as a multiset. Asserted rather than assumed — if
# ids ever stop being unique across projects this says so, and the equality
# would have to become a per-project multiset instead.
[ "$(printf '%s\n' "$UNION_IDS" | uniq -d | wc -l | tr -d ' ')" = "0" ] \
    || fail "event ids are not unique across projects, so the completeness check below cannot use a set"
# and then the two claims that are not the same claim: a deletion shrinks the
# merge without repeating anything, a duplication repeats without shrinking.
[ "$(log_events "$WS_ALL" ids | sort | uniq -d | wc -l | tr -d ' ')" = "0" ] \
    || fail "log --workspace printed the same event more than once"
[ "$(log_events "$WS_ALL" ids | sort)" = "$UNION_IDS" ] \
    || fail "log --workspace is not exactly the union of every project's own timeline ($WS_EVENTS events merged, $UNION_COUNT across the projects)"

# The snapshot has to outrun the widest window asserted against it, or those
# assertions prove nothing: an empty snapshot makes both bracket equalities
# compare "" against "" and pass, and a snapshot exactly the size of the window
# makes the cut a no-op (#165 review round 11). The floor is derived from the
# windows themselves — a hardcoded minimum would reintroduce the fixture-length
# coupling this whole round is about, so moving a window moves its floor.
WS_WIDEST="$(awk -v first="$WS_WINDOW" -v second="$WS_NEWEST" 'BEGIN { print (first > second) ? first : second }')"
[ "$WS_EVENTS" -gt "$WS_WIDEST" ] \
    || fail "the workspace timeline is $WS_EVENTS events, which does not outrun the $WS_WIDEST-event window asserted against it"

# The order the merge claims, read from this output alone. Both windowed
# comparisons below take the tail of this same snapshot, so a reversed merge
# moves both sides together and neither notices — a reversed compareDated passed
# every assertion here (#165 review round 11). This notices: it reads the sort
# key out of each event line and asserts the sequence is non-decreasing on the
# pair compareDated sorts by, timestamp then id. Asserting on the timestamp
# alone would miss a reversed tiebreak; asserting on the rendered column order
# would check the renderer rather than the merge.
#
# Non-decreasing rather than increasing, because a tie is correct behaviour: the
# three events `work accept` writes share a timestamp, and that is where the id
# decides.
WS_KEYS="$(log_events "$WS_ALL" keys)"
[ "$(printf '%s\n' "$WS_KEYS" | awk 'NF > 0' | wc -l | tr -d ' ')" = "$WS_EVENTS" ] \
    || fail "the sort keys and the event count disagree, so the order check would be judging something else"
printf '%s\n' "$WS_KEYS" | LC_ALL=C sort -c 2> /dev/null \
    || fail "log --workspace did not merge in (timestamp, id) order"
# and the tie is really there, so the id half of the key is really exercised
[ "$(printf '%s\n' "$WS_KEYS" | awk '{ print $1 }' | sort | uniq -d | wc -l | tr -d ' ')" -gt 0 ] \
    || fail "no two events share a timestamp, so the id half of the merge key is never exercised"

# and the limit applies to the merge rather than to each project, which is what
# the windowed reads below are for. The window is counted in events, not lines:
# the wrapped summary above owns two lines, so `tail -n` would be asking a
# different question than `-n` answers.
WS_WINDOWED="$(SELF log --workspace -n "$WS_WINDOW")"
parses "$WS_WINDOWED" "the windowed workspace timeline"
[ "$(log_events "$WS_WINDOWED" count)" = "$WS_WINDOW" ] \
    || fail "log --workspace applied the limit per project instead of to the merge"
[ "$WS_WINDOWED" = "$(log_events "$WS_ALL" tail "$WS_WINDOW")" ] \
    || fail "log --workspace cut the newest events instead of the oldest"
# the merged timeline is sorted, so the last event is the newest overall
[ "$(SELF log --workspace -n "$WS_NEWEST")" = "$(log_events "$WS_ALL" tail "$WS_NEWEST")" ] \
    || fail "log --workspace did not merge in timestamp order"

# The single-project form windows too. Its presence check above now reads the
# whole timeline, so this is where `-n` on that form is exercised at all — the
# window is the newest N of one project's timeline, not a slice of the merge.
DEMO_ALL="$(SELF log --project demo -n "$WHOLE_TIMELINE")"
parses "$DEMO_ALL" "the demo timeline"
DEMO_EVENTS="$(log_events "$DEMO_ALL" count)"
[ "$DEMO_EVENTS" -gt "$WS_WINDOW" ] \
    || fail "the demo timeline is $DEMO_EVENTS events, which does not outrun the $WS_WINDOW-event window asserted against it"
[ "$(log_events "$(SELF log --project demo -n "$WS_WINDOW")" count)" = "$WS_WINDOW" ] \
    || fail "log --project ignored its window"
[ "$(SELF log --project demo -n "$WS_WINDOW")" = "$(log_events "$DEMO_ALL" tail "$WS_WINDOW")" ] \
    || fail "log --project cut the newest events instead of the oldest"
# the single-project form is untouched: no project column, same bytes as before
SELF log -n "$SHAPE_SAMPLE" | grep -q "^demo  " && fail "the single-project log grew a project column"

# ── a project registered here but linked on another machine still reads ───
clone_machine_b
machine B
cd "$ROOT/B/ws"
SELF status --project outside | grep -q "^outside — goal: prove out-of-tree projects work" \
    || fail "a project registered but not linked on this machine could not be read"
SELF log --project outside -n "$WHOLE_TIMELINE" | grep -q "objective.created" || fail "an unlinked project's log could not be read"
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
        TTY_LOG="$(pty_run 100 "node $SELF_JS log --workspace -n $WHOLE_TIMELINE")"
        printf '%s\n' "$TTY_LOG" | grep -q "outside" || fail "the terminal workspace log dropped the project column"
        case "$TTY_LOG" in
            *"$ESC"*) : ;;
            *) fail "a colour-capable terminal got no colour on the workspace log" ;;
        esac
        NOCOLOR_LOG="$(NO_COLOR=1 pty_run 100 "node $SELF_JS log --workspace -n $WHOLE_TIMELINE")"
        [ "$NOCOLOR_LOG" = "$(SELF log --workspace -n "$WHOLE_TIMELINE")" ] || fail "NO_COLOR at a terminal differs from the piped workspace log"
        ;;
    *)
        echo "scope: no pseudo-terminal available ($PROBE); terminal detection not exercised"
        ;;
esac

echo "scope OK"
