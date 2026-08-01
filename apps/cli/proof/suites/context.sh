#!/usr/bin/env bash
# Domain suite: the agent context budget — `self context` is a hard
# 12,000-character push. Protected state (identity, goal, conventions, waiting
# items, every active work outcome) stays visible, latest reports become
# bounded excerpts, the newest whole decisions fill the remainder, and every
# omission names the command that recovers the full state.
# Runs alone: bash proof/suites/context.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

# Recovery commands are rendered with the installed command name. Expose this
# proof's just-built CLI under that name so executing one cannot hit an older
# machine-global installation.
mkdir -p "$ROOT/bin"
ln -s "$CLI_DIR/bin/self.mjs" "$ROOT/bin/self"
export PATH="$ROOT/bin:$PATH"

demo_workspace

# Reports claim a bounded excerpt first, then the newest whole decisions fill
# the remainder. Protected state stays visible and every omission names its
# pull path.
BUDGET_WID=$(SELF work add "budget proof active outcome must survive" | tail -1)
SELF work start "$BUDGET_WID" > /dev/null
LONG_REPORT="$(awk 'BEGIN { for (i = 0; i < 16000; i++) printf "r" }')"
SELF report "$BUDGET_WID" "$LONG_REPORT" > /dev/null
REPORT_ASTRAL="$(awk 'BEGIN { for (i = 0; i < 800; i++) printf "😀" }')"
SELF report "$BUDGET_WID" "chronological newest report marker $REPORT_ASTRAL" > /dev/null
SELF convention add "budget proof convention must survive" > /dev/null
SELF decide "budget proof proposal must survive" --proposed > /dev/null
SELF objective add "budget proof objective compacts to a pointer" --horizon month --target 2099-01-01 > /dev/null
ASTRAL_FILL="$(awk 'BEGIN { for (i = 0; i < 5000; i++) printf "😀" }')"
SELF decide "astral budget decision $ASTRAL_FILL" > /dev/null
LATE_OUTPUT="$(SELF decide "confirmed-later proposal must sort newest" --proposed)"
LATE_ID="$(echo "$LATE_OUTPUT" | sed -E 's/.*\[([^]]+)\].*/\1/')"
DECISION_FILL="$(awk 'BEGIN { for (i = 0; i < 2600; i++) printf "d" }')"
for index in 1 2 3 4 5 6
do
    SELF decide "budget decision $index $DECISION_FILL" > /dev/null
done
SELF decide confirm "$LATE_ID" > /dev/null
PROJECT_CONTEXT="$(SELF context)"
PROJECT_CHARS="$(printf '%s\n' "$PROJECT_CONTEXT" | wc -m | tr -d ' ')"
[ "$PROJECT_CHARS" -le 12000 ] || fail "project context exceeded 12,000 characters ($PROJECT_CHARS)"
echo "$PROJECT_CONTEXT" | grep -q "budget proof active outcome must survive" || fail "context budget dropped an active work outcome"
echo "$PROJECT_CONTEXT" | grep -q "budget proof convention must survive" || fail "context budget dropped a convention"
echo "$PROJECT_CONTEXT" | grep -q "budget proof proposal must survive" || fail "context budget dropped a waiting item"
echo "$PROJECT_CONTEXT" | grep -q "self work show $BUDGET_WID" || fail "report excerpt has no recovery path"
echo "$PROJECT_CONTEXT" | grep -q 'self search --type decision' || fail "omitted decisions have no recovery path"
echo "$PROJECT_CONTEXT" | grep -q "budget decision 6" || fail "newest decisions did not win the remaining budget"
echo "$PROJECT_CONTEXT" | grep -q "confirmed-later proposal must sort newest" || fail "a later confirmation did not make its proposal newest"
echo "$PROJECT_CONTEXT" | grep -q "budget decision 1" && fail "oldest decisions displaced newer decisions"
echo "$PROJECT_CONTEXT" | grep -q "chronological newest report marker" || fail "latest report did not reach context"
echo "$PROJECT_CONTEXT" | grep -q "😀" || fail "astral characters did not exercise the context character count"
SELF search --type decision | grep -q "budget decision 1" || fail "type-only decision recovery command does not work"

# Union merges can place older reports after newer ones in the JSONL file.
# Protected-only overflow must compact structurally, never slice later WIP or
# waiting sections by position.
cp "$LOG_A" "$ROOT/demo-log-before-budget-fixture"
printf '{"id":"old-report-after-new","ts":"2000-01-01T00:00:00.000Z","type":"report.added","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"text":"out-of-order stale report"},"refs":{"work":"%s"}}\n' "$BUDGET_WID" >> "$LOG_A"
SELF fold > /dev/null
ORDERED_REPORT_CONTEXT="$(SELF context)"
echo "$ORDERED_REPORT_CONTEXT" | grep -q "chronological newest report marker" || fail "JSONL order displaced the chronologically newest report"
echo "$ORDERED_REPORT_CONTEXT" | grep -q "out-of-order stale report" && fail "an appended old report displaced the newest report"
printf '{"id":"budget-changeset","ts":"2099-01-01T00:00:00.000Z","type":"changeset.registered","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"changeSet":"cs-budget","repository":"budget-repo","base":"aaaa","head":"bbbb","digest":"cccc"}}\n' >> "$LOG_A"
PROTECTED_TEXT="$(awk 'BEGIN { for (i = 0; i < 2000; i++) printf "p" }')"
for index in $(seq 1 90)
do
    WID_FIX="$(printf 'w-p%03d' "$index")"
    printf '{"id":"protected-work-%03d-created","ts":"2099-01-01T00:00:00.000Z","type":"work.created","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"work":"%s","outcome":"protected outcome %03d %s"}}\n' "$index" "$WID_FIX" "$index" "$PROTECTED_TEXT" >> "$LOG_A"
    printf '{"id":"protected-work-%03d-started","ts":"2099-01-01T00:00:01.000Z","type":"work.started","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"work":"%s"}}\n' "$index" "$WID_FIX" >> "$LOG_A"
done
for index in $(seq 1 20)
do
    printf '{"id":"protected-convention-%03d","ts":"2099-01-01T00:00:00.000Z","type":"convention.added","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"text":"protected convention %03d %s"}}\n' "$index" "$index" "$PROTECTED_TEXT" >> "$LOG_A"
    printf '{"id":"protected-proposal-%03d","ts":"2099-01-01T00:00:00.000Z","type":"decision.proposed","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"text":"protected proposal %03d %s"}}\n' "$index" "$index" "$PROTECTED_TEXT" >> "$LOG_A"
done
SELF fold > /dev/null
PROTECTED_CONTEXT="$(SELF context)"
PROTECTED_CHARS="$(printf '%s\n' "$PROTECTED_CONTEXT" | wc -m | tr -d ' ')"
[ "$PROTECTED_CHARS" -le 12000 ] || fail "protected-only context exceeded 12,000 characters ($PROTECTED_CHARS)"
echo "$PROTECTED_CONTEXT" | grep -q "## Work in progress" || fail "protected compaction sliced the WIP section"
echo "$PROTECTED_CONTEXT" | grep -q "## Waiting on you" || fail "protected compaction sliced the waiting section"
echo "$PROTECTED_CONTEXT" | grep -q "w-p001" || fail "protected compaction lost its first work identity"
echo "$PROTECTED_CONTEXT" | grep -q "w-p090" || fail "protected compaction lost its last work identity"
echo "$PROTECTED_CONTEXT" | grep -q "protected-proposal-020" || fail "protected compaction lost a waiting identity"
# Once rows are cut short they can no longer carry their own group, so the
# ranking is restated once as counts beside the command that prints it whole.
echo "$PROTECTED_CONTEXT" | grep -q "decisions waiting: 21 unblock work, 0 cannot be decided yet, 0 already in effect; run \`self status\`" \
    || fail "the compacted band lost the ranking without saying how to read it back"
# The outcome layer and the integration train are whole-state recoverable
# through one command each, so under pressure they compact to a count and a
# pointer instead of crowding out the protected sections.
echo "$PROTECTED_CONTEXT" | grep -q "open objective.*omitted; run \`self objective\`" || fail "objectives did not compact to a self objective pointer"
echo "$PROTECTED_CONTEXT" | grep -q "open change set.*omitted; run \`self integration plan\`" || fail "the train did not compact to a self integration plan pointer"

# When even identity rows cannot fit, the mathematical exception is explicit
# and its project-only pull command must expose the canonical state.
for index in $(seq 21 240)
do
    printf '{"id":"protected-convention-%03d","ts":"2099-01-01T00:00:00.000Z","type":"convention.added","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"text":"aggregate convention %03d"}}\n' "$index" "$index" >> "$LOG_A"
done
SELF fold > /dev/null
AGGREGATE_CONTEXT="$(SELF context)"
AGGREGATE_CHARS="$(printf '%s\n' "$AGGREGATE_CONTEXT" | wc -m | tr -d ' ')"
[ "$AGGREGATE_CHARS" -le 12000 ] || fail "aggregate exception exceeded 12,000 characters ($AGGREGATE_CHARS)"
echo "$AGGREGATE_CONTEXT" | grep -q "even as identity rows" || fail "mathematical protected overflow was not disclosed"
echo "$AGGREGATE_CONTEXT" | grep -q "self search --project 'demo'" || fail "aggregate overflow has no valid project pull path"
SELF search --project demo | grep -q "budget proof active outcome must survive" || fail "project-only recovery did not expose canonical state"
cp "$ROOT/demo-log-before-budget-fixture" "$LOG_A"
SELF fold > /dev/null

# The per-branch statement is not something the budget may drop in silence.
# Under pressure it degrades to one counted line per branch and the command
# that reads the units back, and it never crosses the cap.
cp "$LOG_A" "$ROOT/demo-log-before-unshipped-fixture"
UNSHIPPED_TEXT="$(awk 'BEGIN { for (i = 0; i < 2000; i++) printf "u" }')"
for index in $(seq 1 40)
do
    WID_SHIP="$(printf 'w-u%03d' "$index")"
    printf '{"id":"unshipped-work-%03d-created","ts":"2099-01-01T00:00:00.000Z","type":"work.created","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"work":"%s","outcome":"unshipped outcome %03d %s"}}\n' "$index" "$WID_SHIP" "$index" "$UNSHIPPED_TEXT" >> "$LOG_A"
    printf '{"id":"unshipped-work-%03d-started","ts":"2099-01-01T00:00:01.000Z","type":"work.started","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"work":"%s"}}\n' "$index" "$WID_SHIP" >> "$LOG_A"
    printf '{"id":"unshipped-report-%03d","ts":"2099-01-01T00:00:02.000Z","type":"report.added","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"text":"held on a branch that never merged %s"},"refs":{"work":"%s","commits":["ffffffffff%02d"],"branch":"feat/unshipped-%03d"}}\n' "$index" "$UNSHIPPED_TEXT" "$WID_SHIP" "$index" "$index" >> "$LOG_A"
done
SELF fold > /dev/null
UNSHIPPED_CONTEXT="$(SELF context)"
UNSHIPPED_CHARS="$(printf '%s\n' "$UNSHIPPED_CONTEXT" | wc -m | tr -d ' ')"
[ "$UNSHIPPED_CHARS" -le 12000 ] || fail "the per-branch statement pushed context past 12,000 characters ($UNSHIPPED_CHARS)"
echo "$UNSHIPPED_CONTEXT" | grep -q "## Unshipped by branch" || fail "the budget dropped the per-branch statement entirely"
echo "$UNSHIPPED_CONTEXT" | grep -q "^- feat/unshipped-001 — 1 open work unit unshipped; run \`self work\`$" \
    || fail "the compacted statement lost its per-branch count or the command that reads the units back"
echo "$UNSHIPPED_CONTEXT" | grep -q "feat/unshipped-040" || fail "the compacted statement dropped a branch instead of counting it"
# The one-line form is bounded rather than joined: this list only leaves by
# settling, so a project a year in would otherwise print a paragraph here.
SELF status | grep -q '^unshipped: feat/unshipped-001 1 open work unit, .*, +36 more; run `self context`$' \
    || fail "the one-line statement joined every branch instead of counting the remainder"
cp "$ROOT/demo-log-before-unshipped-fixture" "$LOG_A"
SELF fold > /dev/null

# At full size every proposal row carries its own group, ahead of the text, so
# what confirming it would do survives the truncation that keeps the budget.
BAND_WID=$(SELF work add "gated by a proposal, never started" | tail -1)
SELF decide "the band names the work it gates" --proposed --blocks "$BAND_WID" > /dev/null
BAND_CONTEXT="$(SELF context)"
BAND_CHARS="$(printf '%s\n' "$BAND_CONTEXT" | wc -m | tr -d ' ')"
[ "$BAND_CHARS" -le 12000 ] || fail "the attention band pushed context past 12,000 characters ($BAND_CHARS)"
echo "$BAND_CONTEXT" | grep -q "proposal \[confirming unblocks $BAND_WID\]" || fail "the grouping did not reach self context"
SELF status | grep -q "decisions waiting: 2 unblock work" || fail "the grouping did not reach self status"

# The workspace overview holds the same cap: whole project summaries drop off
# the end, the omission is counted, and `self status` recovers them.
cd "$WS"
WORKSPACE_CONTEXT="$(SELF context)"
WORKSPACE_CHARS="$(printf '%s\n' "$WORKSPACE_CONTEXT" | wc -m | tr -d ' ')"
[ "$WORKSPACE_CHARS" -le 12000 ] || fail "workspace context exceeded 12,000 characters ($WORKSPACE_CHARS)"
echo "$WORKSPACE_CONTEXT" | grep -q "demo" || fail "workspace context lost its registered project"
REGISTRY_A="$STORE/registry.jsonl"
cp "$REGISTRY_A" "$ROOT/registry-before-budget-fixture"
for index in $(seq 1 300)
do
    printf '{"slug":"workspace-budget-%03d","added":"2099-01-01T00:00:00.000Z"}\n' "$index" >> "$REGISTRY_A"
done
WORKSPACE_OVERFLOW="$(SELF context)"
WORKSPACE_OVERFLOW_CHARS="$(printf '%s\n' "$WORKSPACE_OVERFLOW" | wc -m | tr -d ' ')"
[ "$WORKSPACE_OVERFLOW_CHARS" -le 12000 ] || fail "overflowing workspace context exceeded 12,000 characters ($WORKSPACE_OVERFLOW_CHARS)"
echo "$WORKSPACE_OVERFLOW" | grep -q "project summaries omitted" || fail "workspace omission was silent"
echo "$WORKSPACE_OVERFLOW" | grep -q 'self status' || fail "workspace omission has no valid recovery path"
SELF status | grep -q "workspace-budget-300" || fail "workspace status did not recover an omitted project summary"
cp "$ROOT/registry-before-budget-fixture" "$REGISTRY_A"

# Slugs remain backwards-compatible and may contain shell syntax. Every
# generated recovery command must quote the slug as one POSIX argument.
mkdir -p "$ROOT/odd-project"
cd "$ROOT/odd-project"
git init -q -b main
ODD_SLUG="odd slug;touch slug-pwned;'quoted'"
ODD_DESCRIPTION="odd slug recovery marker $(awk 'BEGIN { for (i = 0; i < 16000; i++) printf "q" }')"
SELF project add --name "$ODD_SLUG" --desc "$ODD_DESCRIPTION" --no-connect > /dev/null
ODD_CONTEXT="$(SELF context)"
ODD_RECOVERY="$(printf '%s\n' "$ODD_CONTEXT" | sed -n 's/.*`\(self search --project [^`]*\)`.*/\1/p' | head -1)"
[ -n "$ODD_RECOVERY" ] || fail "spaced slug context emitted no project recovery command"
echo "$ODD_RECOVERY" | grep -F -q "'\"'\"'" || fail "single quote in project slug was not POSIX-escaped"
ODD_RECOVERED="$(eval "$ODD_RECOVERY")"
echo "$ODD_RECOVERED" | grep -q "odd slug recovery marker" || fail "quoted project recovery did not return the intended state"
[ ! -e slug-pwned ] || fail "project slug executed shell metacharacters"

echo "context OK"
