#!/usr/bin/env bash
# End-to-end proof of the self CLI: workspace lifecycle, event verbs,
# and two-machine sync through a bare remote with divergent appends.
set -euo pipefail

CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

# Recovery commands are rendered with the installed command name. Expose this
# proof's just-built CLI under that name so executing one cannot hit an older
# machine-global installation.
mkdir -p "$ROOT/bin"
ln -s "$CLI_DIR/bin/self.mjs" "$ROOT/bin/self"
export PATH="$ROOT/bin:$PATH"

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

# Agent context is a hard 12,000-character push. Reports claim a bounded
# excerpt first, then the newest whole decisions fill the remainder. Protected
# state stays visible and every omission names its pull path.
BUDGET_WID=$(SELF work add "budget proof active outcome must survive" | tail -1)
SELF work start "$BUDGET_WID"
LONG_REPORT="$(awk 'BEGIN { for (i = 0; i < 16000; i++) printf "r" }')"
SELF report "$BUDGET_WID" "$LONG_REPORT"
REPORT_ASTRAL="$(awk 'BEGIN { for (i = 0; i < 800; i++) printf "😀" }')"
SELF report "$BUDGET_WID" "chronological newest report marker $REPORT_ASTRAL"
SELF convention add "budget proof convention must survive"
SELF decide "budget proof proposal must survive" --proposed
ASTRAL_FILL="$(awk 'BEGIN { for (i = 0; i < 5000; i++) printf "😀" }')"
SELF decide "astral budget decision $ASTRAL_FILL"
LATE_OUTPUT="$(SELF decide "confirmed-later proposal must sort newest" --proposed)"
LATE_ID="$(echo "$LATE_OUTPUT" | sed -E 's/.*\[([^]]+)\].*/\1/')"
DECISION_FILL="$(awk 'BEGIN { for (i = 0; i < 2600; i++) printf "d" }')"
for index in 1 2 3 4 5 6
do
    SELF decide "budget decision $index $DECISION_FILL"
done
SELF decide confirm "$LATE_ID"
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
LOG_A="$ROOT/A/ws/.superself/projects/demo/log.jsonl"
cp "$LOG_A" "$ROOT/demo-log-before-budget-fixture"
printf '{"id":"old-report-after-new","ts":"2000-01-01T00:00:00.000Z","type":"report.added","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"text":"out-of-order stale report"},"refs":{"work":"%s"}}\n' "$BUDGET_WID" >> "$LOG_A"
SELF fold > /dev/null
ORDERED_REPORT_CONTEXT="$(SELF context)"
echo "$ORDERED_REPORT_CONTEXT" | grep -q "chronological newest report marker" || fail "JSONL order displaced the chronologically newest report"
echo "$ORDERED_REPORT_CONTEXT" | grep -q "out-of-order stale report" && fail "an appended old report displaced the newest report"
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

cd "$ROOT/A/ws"
WORKSPACE_CONTEXT="$(SELF context)"
WORKSPACE_CHARS="$(printf '%s\n' "$WORKSPACE_CONTEXT" | wc -m | tr -d ' ')"
[ "$WORKSPACE_CHARS" -le 12000 ] || fail "workspace context exceeded 12,000 characters ($WORKSPACE_CHARS)"
echo "$WORKSPACE_CONTEXT" | grep -q "demo" || fail "workspace context lost its registered project"
REGISTRY_A="$ROOT/A/ws/.superself/registry.jsonl"
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
git init -q
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

echo "proof OK"
