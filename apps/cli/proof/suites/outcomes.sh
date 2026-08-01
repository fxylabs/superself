#!/usr/bin/env bash
# Domain suite: the outcome layer — objectives, milestones, exit-criteria
# coverage, recheck staleness, target-date zones, and goal-gap proposals.
# Runs alone: bash proof/suites/outcomes.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

demo_workspace
outside_project
clone_machine_b

# target dates are judged in the workspace zone, never the rendering locale
cd "$ROOT/A/ws"
SELF timezone | grep -q "^UTC$" || fail "the default target-date zone was not UTC"
SELF timezone Asia/Seoul > /dev/null
SELF timezone | grep -q "^Asia/Seoul$" || fail "timezone did not record the zone it was given"
BADZONE="$(SELF timezone Mars/Olympus 2>&1 || true)"
echo "$BADZONE" | grep -q "not an IANA time zone" || fail "an unknown time zone was accepted"
SELF timezone UTC > /dev/null

day()
{
    date -u -d "$1 days" +%F 2>/dev/null || date -u -v"$1"d +%F
}
FUTURE="$(day +30)"
SOON="$(day +2)"
PAST="$(day -2)"

# the long-term goal and a time-boxed objective coexist
cd "$ROOT/A/ws/demo"
OID="$(SELF objective add "ship the payment flow this month" --horizon month --target "$FUTURE" \
    --success "checkout converts" --stop "chargebacks rise" | tail -1)"
grep -q "prove two-machine sync" "$STATE_A" || fail "an objective overwrote the long-term goal"
grep -q "$OID" "$STATE_A" || fail "the objective never reached folded state"
SELF context | grep -q "ship the payment flow this month" || fail "context does not carry the objective"

# a milestone needs explicit exit criteria; work links to it without becoming it
NOEXIT="$(SELF milestone add "no criteria" --objective "$OID" 2>&1 || true)"
echo "$NOEXIT" | grep -q "need explicit exit criteria" || fail "a milestone was accepted with no exit criteria"
M1="$(SELF milestone add "checkout accepts a card" --objective "$OID" --target "$FUTURE" \
    --exit "a live charge settles" --exit "the failure path is covered" | tail -1)"
M2="$(SELF milestone add "refunds settle" --objective "$OID" --target "$FUTURE" --after "$M1" \
    --exit "a refund reaches the customer" | tail -1)"
WPAY="$(SELF work add "wire the payment provider" | tail -1)"
SELF work start "$WPAY"
SELF work link "$WPAY" --milestone "$M1"
SELF work link "$WPAY" --milestone "$M2"
SELF work show "$WPAY" | grep -q "Contributes to: $M1" || fail "work detail does not name the milestone it serves"
SELF milestone | grep -q "$M1" || fail "milestone list is empty"
SELF milestone | grep "$M2" | grep -q "critical path" && fail "a milestone nothing waits on was called critical path"
SELF milestone | grep "$M1" | grep -q "critical path" || fail "a milestone another one waits on is not on the critical path"

# one report, two milestones: evidence is shared by reference, never copied
echo pay > pay.txt && git add . && git commit -qm "payment provider wired"
PAYC="$(git rev-parse --short=12 HEAD)"
SELF report "$WPAY" "provider wired and charging"
OBJ_MD="$ROOT/A/ws/.superself/projects/demo/objective/$OID.md"
[ "$(grep -c "$PAYC" "$OBJ_MD")" -ge 2 ] || fail "two milestones did not share the same evidence commit"
[ "$(grep -c '"type":"report.added".*provider wired' "$LOG_A")" -eq 1 ] || fail "shared evidence duplicated the report"

# finishing work does not reach a milestone whose exit criteria are not covered
SELF work done "$WPAY"
NOTREACHED="$(SELF milestone reach "$M1" 2>&1 || true)"
echo "$NOTREACHED" | grep -q "uncovered exit criteria" || fail "a milestone was reached with open exit criteria"
grep -q "$M1.*reached" "$STATE_A" && fail "work reaching done reached its milestone"

# coverage cites evidence, and reaching records the revisions it was judged against
SELF milestone met "$M1" --criterion c1 --why "the settled charge in $PAYC" --evidence "$PAYC"
SELF milestone met "$M1" --criterion c2 --why "the declined-card path is exercised"
BADCRIT="$(SELF milestone met "$M1" --criterion c9 --why "nope" 2>&1 || true)"
echo "$BADCRIT" | grep -q "not a live exit criterion" || fail "coverage was accepted for a criterion that does not exist"
SELF milestone reach "$M1"
grep -q "Reached:.*against objective revision 1/milestone revision 1" "$OBJ_MD" || fail "reaching did not record the revisions it satisfied"
grep -q "criteria c1, c2" "$OBJ_MD" || fail "reaching did not record the criteria it covered"
grep -q "evidence.*$PAYC" "$OBJ_MD" || fail "reaching did not record its evidence"

# revising the objective makes coverage judged against the old revision stale
SELF objective revise "$OID" --why "the board moved the target" --target "$SOON"
SELF status | grep -q "recheck it" || fail "a revision left stale coverage invisible"
grep -q "stale coverage" "$VIEW_A/demo.html" || fail "the project view hides stale coverage"

# stale is a question, not a verdict: a deliberate re-judgment at the current
# revision settles it, and nothing else does
NOCOV="$(SELF milestone recheck "$M2" --criterion c1 --why "nothing was judged here" 2>&1 || true)"
echo "$NOCOV" | grep -q "no coverage to recheck" || fail "a criterion nobody covered was rechecked"
NOPROG="$(SELF milestone recheck "$M1" --criterion c1 --why x --progress 60 2>&1 || true)"
echo "$NOPROG" | grep -q "progress is derived" || fail "a recheck accepted a manual progress percentage"
SELF milestone recheck "$M1" --criterion c1 --why "the settled charge in $PAYC still covers it" --evidence "$PAYC"
SELF status | grep -q "coverage of c1" && fail "coverage re-judged at the current revision still read stale"
SELF status | grep -q "coverage of c2" || fail "coverage nobody re-judged stopped being reported"
SELF milestone recheck "$M1" --criterion c2 --why "the declined-card path is unchanged"
SELF milestone recheck "$M1" --why "the moved date changes nothing this reach was judged on"
SELF status | grep -q "recheck it" && fail "a fully re-judged milestone still asked for a recheck"
grep -q "stale coverage" "$VIEW_A/demo.html" && fail "the project view still shows coverage that was re-judged"
[ "$(grep -c '^- c1 on' "$OBJ_MD")" -ge 2 ] || fail "a recheck replaced the coverage it re-judged instead of appending"
grep -q "rechecked at revision" "$OBJ_MD" || fail "a re-judged coverage entry is indistinguishable from the first"
grep -q "^- Rechecked:" "$OBJ_MD" || fail "a re-judged reach left no record of what it was judged against"
grep -q "^- Reached:" "$OBJ_MD" || fail "a recheck erased the day the milestone was first reached"
SETTLED="$(SELF milestone recheck "$M1" --why "again" 2>&1 || true)"
echo "$SETTLED" | grep -q "nothing to recheck" || fail "a reach already judged at the current revision was re-judged again"

# a revision that widens the ask is not waved through: the criterion it added
# has to be covered before the reach stands again
SELF milestone revise "$M1" --why "compliance added a step" --exit "the fraud check runs"
OPENRECHECK="$(SELF milestone recheck "$M1" --why "it surely still holds" 2>&1 || true)"
echo "$OPENRECHECK" | grep -q "uncovered exit criteria" || fail "a widened milestone re-affirmed a reach over an open criterion"
SELF status | grep -q "was reached against" || fail "a widened milestone stopped reporting its stale reach"
SELF milestone met "$M1" --criterion c3 --why "the fraud check is exercised"
SELF milestone recheck "$M1" --criterion c1 --why "still covered after the added step"
SELF milestone recheck "$M1" --criterion c2 --why "still covered after the added step"
SELF milestone recheck "$M1" --why "every live criterion is covered at this revision"
SELF status | grep -q "recheck it" && fail "a settled milestone kept asking for a recheck"

# `milestone met --evidence` reads the one revision guard every other
# commit-ref intake reads. It wrote whatever was typed straight into
# refs.commits: prose was stored as a commit and reported later as a rewritten
# history, and an uppercase object name reached the event guard as a
# 40-character mixed-case run it refuses as a credential (#132)
cd "$ROOT/A/ws/demo"
MGUARD="$(SELF milestone add "evidence on a milestone is an object name" --objective "$OID" --target "$FUTURE" \
    --exit "the guard runs at this intake too" | tail -1)"
PROSE="$(SELF milestone met "$MGUARD" --criterion c1 --why "prose is not a commit" --evidence "see the design note" 2>&1 || true)"
echo "$PROSE" | grep -q "is not a Git object name" || fail "milestone met recorded prose in refs.commits"
echo "$PROSE" | grep -q "self milestone met" || fail "the refusal did not name the verb the user ran"
echo "$PROSE" | grep -q "commit:see the design note" \
    && fail "the refusal offered a typed form this surface does not read"
grep -q "see the design note" "$LOG_A" && fail "the refused evidence still reached the log"
git commit -q --allow-empty -m "the commit the guard normalizes"
GUARDC="$(git rev-parse HEAD)"
SELF milestone met "$MGUARD" --criterion c1 --why "the same commit, in the case the terminal offered" \
    --evidence "$(printf %s "$GUARDC" | tr 'a-f' 'A-F')" \
    || fail "an uppercase object name was refused as milestone evidence"
grep -q "\"commits\":\[\"$GUARDC\"\]" "$LOG_A" || fail "milestone evidence was not stored as one spelling"

# the guard is shared by `met` and `recheck`, and the refusal names the verb
# the user actually ran: naming `milestone met` at a recheck sent the reader to
# a command they had not typed, which is the same defect one surface smaller
SELF milestone revise "$MGUARD" --why "the ask grew" --exit "the guard runs at a recheck too" > /dev/null
MRECHECK="$(SELF milestone recheck "$MGUARD" --criterion c1 --why "re-judged at the wider ask" \
    --evidence "see the design note" 2>&1 || true)"
echo "$MRECHECK" | grep -q "is not a Git object name" || fail "milestone recheck recorded prose in refs.commits"
echo "$MRECHECK" | grep -q "self milestone recheck" || fail "the recheck refusal did not name the verb the user ran"
echo "$MRECHECK" | grep -q "self milestone met" && fail "the recheck refusal named a verb the user did not run"
grep -q "see the design note" "$LOG_A" && fail "the refused recheck evidence still reached the log"
SELF milestone recheck "$MGUARD" --criterion c1 --why "the same commit still covers it" --evidence "$GUARDC" > /dev/null

# a target-date boundary is deterministic and closes nothing on its own
MLATE="$(SELF milestone add "invoices export" --objective "$OID" --target "$PAST" --exit "an export downloads" | tail -1)"
WLATE="$(SELF work add "build the export" | tail -1)"
SELF work start "$WLATE"
SELF work link "$WLATE" --milestone "$MLATE"
SELF milestone | grep "$MLATE" | grep -q "missed" || fail "a passed target date did not read as missed"
SELF work | grep "$WLATE" | grep -q "active" || fail "a missed target silently closed its work unit"
SELF status | grep -q "$MLATE missed its target" || fail "a missed target raised no health signal"

# a blocked unit on the critical path is distinguishable from an unstarted one
SELF work block "$WLATE" --on external --why "the ledger API is down"
SELF milestone | grep "$MLATE" | grep -q "no work linked" && fail "a milestone with work linked claimed none"
SELF milestone | grep "$M2" | grep -q "no work linked" && fail "a milestone with a linked unit claimed none"
grep -q "blocked $WLATE" "$VIEW_A/demo.html" || fail "the project view hides a blocked milestone's unit"

# progress is derived, never asserted
BADPROG="$(SELF milestone met "$M2" --criterion c1 --why x --progress 60 2>&1 || true)"
echo "$BADPROG" | grep -q "progress is derived" || fail "a manual progress percentage was accepted"

# superseding an objective preserves lineage instead of two current states
O2="$(SELF objective add "ship payments and payouts this quarter" --horizon quarter --target "$FUTURE" --supersedes "$OID" | tail -1)"
grep -q "Supersedes: $OID" "$ROOT/A/ws/.superself/projects/demo/objective/$O2.md" || fail "a superseding objective lost its lineage"
[ -f "$OBJ_MD" ] && fail "a superseded objective stayed current"
SELF search "$OID" --type objective | grep -q "$OID" || fail "the superseded objective vanished from the log"

# a goal-gap proposal must carry its whole brief, and cannot be filed twice
M3="$(SELF milestone add "payouts land" --objective "$O2" --exit "a payout clears" | tail -1)"
SELF milestone | grep "$M3" | grep -q "no work linked" || fail "a milestone nothing was dispatched at claimed work"
grep -q "no work linked" "$VIEW_A/demo/$O2.html" || fail "the objective page hides a milestone with no work"
THIN="$(SELF work propose "wire payouts" --milestone "$M3" --value "closes the payout gap" 2>&1 || true)"
echo "$THIN" | grep -q "work propose needs --risk" || fail "an incomplete proposal was recorded"
SELF work propose "wire payouts" --milestone "$M3" --value "closes the payout gap" \
    --success "a payout clears in staging" --stop "the provider rejects our account" \
    --depends "$M3" --risk "provider onboarding may take weeks" --capacity "3 days" \
    --evidence-plan "a settled payout id in the report" --confidence medium --expires "$FUTURE"
PID="$(SELF log -n 1 | sed -E 's/.*\[([^]]+)\].*/\1/' | cut -c1-8)"
DUPE="$(SELF work propose "Wire payouts!" --milestone "$M3" --value v --success s --stop t \
    --risk r --capacity c --evidence-plan e --confidence low --expires "$FUTURE" 2>&1 || true)"
echo "$DUPE" | grep -q "already proposes this outcome" || fail "a duplicate proposal was recorded"
SELF context | grep -q "evidence plan: a settled payout id" || fail "the proposal brief is missing from context"
# creating the unit, pointing it at what it closes, and settling the proposal
# are one act, so they reach the log and the store history together
COMMITS_BEFORE="$(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD)"
WNEW="$(SELF work accept "$PID" | tail -1)"
[ "$(( $(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD) - COMMITS_BEFORE ))" -eq 1 ] \
    || fail "accepting a proposal was not recorded as one state change"
SELF work show "$WNEW" | grep -q "Contributes to: $M3" || fail "accepting a proposal did not link the work it created"
GONE="$(SELF work accept "$PID" 2>&1 || true)"
echo "$GONE" | grep -q "already accepted" || fail "an accepted proposal was accepted twice"

# the viewer carries the outcome layer, and every page still renders
grep -q "OBJECTIVES" "$VIEW_A/demo.html" || fail "the project view has no objectives panel"
grep -q "exit criteria covered" "$VIEW_A/demo.html" || fail "the project view shows no derived progress"
grep -q "OBJECTIVES" "$VIEW_A/workspace.html" || fail "the workspace view has no objectives roll-up"
grep -q "toward $M3" "$VIEW_A/demo/$WNEW.html" || fail "work detail does not name what it contributes to"
grep -q "CONTRIBUTES TO" "$VIEW_A/demo/$WNEW.html" || fail "work detail has no contribution panel"
grep -q "MILESTONE $M3" "$VIEW_A/demo/$O2.html" || fail "the objective page is missing its milestone"

# a workspace that never adopted objectives folds exactly as before
grep -q "## Objectives" "$ROOT/A/ws/.superself/projects/outside/state.md" && fail "a project with no objectives grew an objectives section"
grep -q "OBJECTIVES" "$VIEW_A/outside.html" && fail "a project with no objectives grew an objectives panel"
SELF search "prove out-of-tree" --project outside | grep -q "out-of-tree" || fail "an untouched project stopped folding"

# the outcome layer survives replay, sync, and a machine that never saw it
cd "$ROOT/A/ws/demo"
BEFORE="$(cat "$ROOT/A/ws/.superself/projects/demo/objective/$O2.md")"
SELF fold > /dev/null
[ "$BEFORE" = "$(cat "$ROOT/A/ws/.superself/projects/demo/objective/$O2.md")" ] || fail "a replay of the same log folded a different objective"
SELF search "$M1" --type milestone | grep -q "milestone.reached" || fail "a replay lost the reached milestone"
cd "$ROOT/A/ws" && SELF sync
machine B
cd "$ROOT/B/ws" && SELF sync
grep -q "$M3" "$ROOT/B/ws/.superself/projects/demo/state.md" || fail "objectives did not survive sync to another machine"
diff "$LOG_A" "$LOG_B" > /dev/null || fail "objective events diverged after sync"
machine A

# the at-risk window is a boundary, not a mood: inside it with an open
# criterion is at risk, one day outside it is not
cd "$ROOT/A/ws/demo"
EDGE="$(day +3)"
OUTSIDE="$(day +4)"
ORISK="$(SELF objective add "close the quarter clean" --horizon quarter --target "$EDGE" | tail -1)"
MEDGE="$(SELF milestone add "the sign-off lands" --objective "$ORISK" --target "$EDGE" --exit "finance signs off" | tail -1)"
MOUT="$(SELF milestone add "the archive ships" --objective "$ORISK" --target "$OUTSIDE" --exit "the archive uploads" | tail -1)"
SELF milestone | grep "$MEDGE" | grep -q "at-risk" || fail "an open criterion inside the window did not read at-risk"
SELF milestone | grep "$MOUT" | grep -q "at-risk" && fail "a target a day outside the window read at-risk"
SELF status | grep -q "$MEDGE is at risk" || fail "an at-risk target raised no health signal"
SELF objective show "$ORISK" | grep -q "Target state: at-risk" || fail "an objective with an at-risk milestone did not carry it"

# every checkpoint landed, so a date that has since passed missed nothing, and
# coverage cited without a work unit is progress rather than an empty objective
SELF milestone met "$MEDGE" --criterion c1 --why "the signed statement is filed"
SELF milestone reach "$MEDGE"
SELF milestone met "$MOUT" --criterion c1 --why "the archive is uploaded"
SELF milestone reach "$MOUT"
SELF objective revise "$ORISK" --why "the board pulled the date in" --target "$PAST"
SELF objective show "$ORISK" | grep -q "Target state: missed" && fail "an objective whose milestones all landed read missed"
SELF objective show "$ORISK" | grep -q "Target state: unstarted" && fail "verified coverage with no linked work read as nothing started"
SELF objective show "$ORISK" | grep -q "Target state: on-track" || fail "an objective holding only reached milestones lost its derived state"

# a reach is a judgment against a revision, so widening the ask makes it stale
SELF status | grep -q "$MEDGE was reached against" || fail "a reach judged against an older revision stayed silent"
SELF milestone revise "$MEDGE" --why "the audit added a step" --exit "the auditor countersigns"
SELF milestone show "$MEDGE" | grep -q "open" || fail "a criterion added after the reach was not left open"

# a superseded milestone hands its order to its successor and waits on nothing
MOLD="$(SELF milestone add "draft the migration" --objective "$O2" --exit "a draft exists" | tail -1)"
MNEXT="$(SELF milestone add "run the migration" --objective "$O2" --after "$MOLD" --exit "the migration runs" | tail -1)"
SELF milestone | grep "$MOLD" | grep -q "critical path" || fail "a milestone another one waits on is not on the critical path"
MREDO="$(SELF milestone add "run the migration in two passes" --objective "$O2" --supersedes "$MNEXT" --exit "both passes run" | tail -1)"
SELF milestone | grep "$MNEXT" | grep -q "superseded by $MREDO" || fail "a superseded milestone lost its lineage"
SELF milestone | grep "$MOLD" | grep -q "critical path" && fail "a superseded milestone still claimed the critical path"

# a target date falls due in the workspace zone, never in the one the machine
# happens to render in: Etc/GMT+12 and Pacific/Kiritimati are 26 hours apart,
# so a day that is still current in the west is already spent in the east
cd "$ROOT/A/ws" && SELF timezone Etc/GMT+12 > /dev/null
cd "$ROOT/A/ws/demo"
WEST="$(TZ=Etc/GMT+12 date +%F)"
MZONE="$(SELF milestone add "the day boundary holds" --objective "$O2" --target "$WEST" --exit "the boundary is judged once" | tail -1)"
SELF milestone | grep "$MZONE" | grep -q "missed" && fail "a target still due in the workspace zone read as missed"
cd "$ROOT/A/ws" && SELF timezone Pacific/Kiritimati > /dev/null
cd "$ROOT/A/ws/demo"
SELF milestone | grep "$MZONE" | grep -q "missed" || fail "the same target did not fall past in a workspace zone a day ahead"
EAST_RUN="$(TZ=Pacific/Kiritimati node "$CLI_DIR/bin/self.mjs" milestone)"
WEST_RUN="$(TZ=Etc/GMT+12 node "$CLI_DIR/bin/self.mjs" milestone)"
[ "$EAST_RUN" = "$WEST_RUN" ] || fail "the rendering machine's zone changed a target-date judgment"
cd "$ROOT/A/ws" && SELF timezone UTC > /dev/null
SELF timezone | grep -q "^UTC$" || fail "the workspace zone did not return to what it was set to"

# two proposals are the same proposal when they say the same thing, whatever
# script they say it in — the key that keeps letters and numbers keeps them all
cd "$ROOT/A/ws/demo"
OSCRIPT="$(SELF objective add "serve every script" | tail -1)"
MSCRIPT="$(SELF milestone add "payments log" --objective "$OSCRIPT" --exit "a payment is logged" | tail -1)"
propose()
{
    SELF work propose "$1" --milestone "$MSCRIPT" --value v --success s --stop t \
        --risk r --capacity c --evidence-plan e --confidence low --expires "$FUTURE" > /dev/null
}
propose "Внедрить оплату картой" || fail "a Cyrillic proposal was refused"
propose "Добавить логирование ошибок" || fail "two unrelated Cyrillic proposals collapsed into one"
propose "決済ログを追加する" || fail "a Japanese proposal collided with a Cyrillic one"
propose "إضافة سجل المدفوعات" || fail "an Arabic proposal collided with another script"
propose "เพิ่มบันทึกการชำระเงิน" || fail "a Thai proposal collided with another script"
propose "결제 로그를 추가한다" || fail "a Hangul proposal collided with another script"
propose "add payment logging" || fail "a Latin proposal collided with another script"
SCRIPTDUPE="$(SELF work propose "  ВНЕДРИТЬ, оплату  картой!  " --milestone "$MSCRIPT" --value v --success s \
    --stop t --risk r --capacity c --evidence-plan e --confidence low --expires "$FUTURE" 2>&1 || true)"
echo "$SCRIPTDUPE" | grep -q "already proposes this outcome" || fail "the same Cyrillic outcome was proposed twice"

# a closed objective's page tells the truth about being closed rather than
# freezing the last state it was open in, and the work that pointed at it
# still reaches it
OCLOSED="$(SELF objective add "the abandoned bet" | tail -1)"
WCLOSED="$(SELF work add "chase the abandoned bet" | tail -1)"
SELF work link "$WCLOSED" --objective "$OCLOSED"
grep -q "pill s-on-track" "$VIEW_A/demo/$OCLOSED.html" || fail "an open objective's page does not carry its state"
SELF objective close "$OCLOSED" --as dropped --why "the bet is off"
grep -q "pill s-on-track" "$VIEW_A/demo/$OCLOSED.html" && fail "a closed objective's page still renders it on track"
grep -q "pill s-closed" "$VIEW_A/demo/$OCLOSED.html" || fail "a closed objective's page does not say it is closed"
grep -q "the bet is off" "$VIEW_A/demo/$OCLOSED.html" || fail "a closed objective's page does not say why it closed"
grep -q "href=\"$OCLOSED.html\"" "$VIEW_A/demo/$WCLOSED.html" || fail "work detail dropped the objective it contributes to"
[ -f "$ROOT/A/ws/.superself/projects/demo/objective/$OCLOSED.md" ] && fail "a closed objective stayed a current canonical file"

# an outcome that was verified stays verified: a successor is lineage, not a
# reason to unsay what landed
OREACHED="$(SELF objective add "the landed bet" | tail -1)"
SELF objective close "$OREACHED" --as reached --why "it landed"
ONEXT="$(SELF objective add "the follow-up bet" --supersedes "$OREACHED" | tail -1)"
SELF objective show "$OREACHED" | grep -q "Status: reached" || fail "superseding erased a reached objective's status"
SELF objective show "$OREACHED" | grep -q "Target state: reached" || fail "superseding erased a reached objective's outcome"
SELF objective show "$OREACHED" | grep -q "Superseded by: $ONEXT" || fail "a reached objective lost its successor pointer"

# a superseded milestone asks nothing of anyone, including a recheck
OSUP="$(SELF objective add "the migration" | tail -1)"
MSUP="$(SELF milestone add "first pass" --objective "$OSUP" --exit "a pass runs" | tail -1)"
SELF milestone met "$MSUP" --criterion c1 --why "the pass ran"
SELF objective revise "$OSUP" --why "the scope widened" --target "$FUTURE"
SELF status | grep -q "$MSUP coverage of c1" || fail "a live milestone's stale coverage stopped being reported"
MSUP2="$(SELF milestone add "two passes" --objective "$OSUP" --supersedes "$MSUP" --exit "both passes run" | tail -1)"
SELF status | grep -q "$MSUP coverage of c1" && fail "a superseded milestone still asked for a recheck"

# a timebox someone withdraws stops deciding whether the target was missed
OBOX="$(SELF objective add "the timeboxed bet" --horizon month --target "$PAST" --priority 2 | tail -1)"
SELF objective show "$OBOX" | grep -q "Target state: missed" || fail "a passed target did not read as missed"
SELF objective revise "$OBOX" --why "the date is withdrawn, not moved" --target ""
SELF objective show "$OBOX" | grep -q "target $PAST" && fail "a withdrawn target is still on the objective"
SELF objective show "$OBOX" | grep -q "Target state: missed" && fail "a withdrawn target still judged the objective late"
SELF objective revise "$OBOX" --why "the priority is withdrawn" --priority ""
SELF objective show "$OBOX" | grep -q "^- Priority:" && fail "a withdrawn priority survived the revision"
MBOX="$(SELF milestone add "the timeboxed step" --objective "$OBOX" --target "$PAST" --exit "a step runs" | tail -1)"
SELF milestone revise "$MBOX" --why "the date is withdrawn" --target ""
SELF milestone show "$MBOX" | grep -q "^- Target:" && fail "a withdrawn milestone target survived the revision"
BADDATE="$(SELF objective revise "$OBOX" --why "nonsense" --target "not-a-date" 2>&1 || true)"
echo "$BADDATE" | grep -q "is not a date" || fail "withdrawing a date also let a malformed one through"
NONAME="$(SELF objective revise "$OBOX" --why "erase it" --outcome "" 2>&1 || true)"
echo "$NONAME" | grep -q "cannot be emptied" || fail "an objective was left with no stated outcome"

# a mistyped verb is answered with the verbs, not with a demand for an id
BADVERB="$(SELF objective frobnicate 2>&1 || true)"
echo "$BADVERB" | grep -q "usage: self objective" || fail "an unknown objective verb was reported as a missing id"
BADVERB2="$(SELF milestone frobnicate 2>&1 || true)"
echo "$BADVERB2" | grep -q "usage: self milestone" || fail "an unknown milestone verb was reported as a missing id"
NOID="$(SELF objective show 2>&1 || true)"
echo "$NOID" | grep -q "objective-id" || fail "a genuinely missing id stopped asking for an id"

echo "outcomes OK"
