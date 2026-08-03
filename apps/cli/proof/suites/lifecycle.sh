#!/usr/bin/env bash
# Domain suite: the record lifecycle — every statement-type record ships the
# same supersede / withdraw / decline set, a withdrawn record leaves every
# current render while staying inspectable in search, and a refusal names the
# verb that fits the state the record is actually in.
# Runs alone: bash proof/suites/lifecycle.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

demo_workspace

id_of()
{
    sed -E 's/.*\[([^]]+)\].*/\1/'
}

# ── the enumeration ──────────────────────────────────────────────────
# The statement types come out of the built module, never out of this file:
# STATEMENT_TYPES in model.ts is what `self search` builds its historical
# status markers from, so it is load-bearing code rather than a list that can
# be left behind. Three checks, and each fails on a different way of getting
# the lifecycle contract wrong:
#
#   1. every registry entry's verbs exist in the command's help
#   2. every namespace the source creates records in is covered by an entry or
#      declared a non-statement namespace here — this is what fails when a new
#      statement type lands without shipping its lifecycle
#   3. each type's withdrawal actually folds, exercised below
LIFECYCLE_ROWS="$ROOT/lifecycle-rows"
EXERCISED="$ROOT/lifecycle-exercised"
: > "$EXERCISED"

# Every behavioural block below names the registry type it drives. What is not
# named here was not executed, and the coverage check at the end of the suite
# says so — this is what stops a statement type added under an already-covered
# namespace from riding along on another type's proof.
exercised()
{
    echo "$1" >> "$EXERCISED"
}

LIFECYCLE="$(node --input-type=module -e "
import { STATEMENT_TYPES } from '$CLI_DIR/dist/model.js';
console.log(STATEMENT_TYPES.map((t) =>
    [t.type, t.command, t.supersede, t.withdraw, t.decline ?? '-', t.namespaces.join(',')].join('~')).join('\n'));
")"
[ -n "$LIFECYCLE" ] || fail "the statement-type registry in model.ts is empty or unreadable"

printf '%s\n' "$LIFECYCLE" > "$LIFECYCLE_ROWS"
[ "$(grep -c . "$LIFECYCLE_ROWS")" -ge 1 ] || fail "the statement-type registry produced no rows"
while IFS='~' read -r TYPE CMD SUPERSEDE WITHDRAW DECLINE NAMESPACES
do
    [ -n "$TYPE" ] || continue
    # Written to a file rather than piped: `grep -q` exits at its first match
    # and the writer takes a SIGPIPE, which `set -o pipefail` turns into a
    # failure of the check that just succeeded.
    SELF "$CMD" --help > "$ROOT/help-$TYPE" 2>&1 || fail "self $CMD --help exited non-zero for the $TYPE lifecycle"
    grep -qF -- "$SUPERSEDE" "$ROOT/help-$TYPE" || fail "$TYPE has no supersede verb: \"$SUPERSEDE\" is not in self $CMD --help"
    grep -qF -- "$WITHDRAW" "$ROOT/help-$TYPE" || fail "$TYPE has no withdraw verb: \"$WITHDRAW\" is not in self $CMD --help"
    if [ "$DECLINE" != "-" ]
    then
        grep -qF -- "$DECLINE" "$ROOT/help-$TYPE" || fail "$TYPE has no decline verb: \"$DECLINE\" is not in self $CMD --help"
    fi
done < "$LIFECYCLE_ROWS"

# Namespaces that create records but hold no statement a person can take back.
# `goal` keeps one value where the latest wins, `report` is append-only history
# by design, and the rest are machine records: runner attempts, work specs, the
# integration train, and the supervisor's own settings. Adding a statement type
# means adding a registry entry, not a line here.
NOT_STATEMENTS="goal report run spec attempt changeset lease merge promotion repo target main ci review overnight"
cut -d'~' -f6 "$LIFECYCLE_ROWS" | tr ',' '\n' | grep . | sort -u > "$ROOT/covered-namespaces"
printf '%s\n' $NOT_STATEMENTS >> "$ROOT/covered-namespaces"
grep -rhoE '"[a-z]+\.(created|added|proposed|registered|set)"' "$CLI_DIR/src" --include='*.ts' \
    | tr -d '"' | cut -d'.' -f1 | sort -u > "$ROOT/created-namespaces"
[ -s "$ROOT/created-namespaces" ] || fail "no record-creating event literals were found in the source — the namespace check is reading nothing"
while read -r NS
do
    grep -qx "$NS" "$ROOT/covered-namespaces" \
        || fail "the $NS namespace creates records but no STATEMENT_TYPES entry gives it a lifecycle (add one, or declare it a non-statement namespace here)"
done < "$ROOT/created-namespaces"

# ── retracting a confirmed decision ──────────────────────────────────
# It leaves every current render and stays in search with its status, so a
# decision recorded in error finally has an exit that is not a rewrite.
KEEP="$(SELF decide "the rule that still holds" --why "keeps rendering" | id_of)"
GONE="$(SELF decide "the rule recorded in error" --why "should never have been recorded" | id_of)"
grep -q "the rule recorded in error" "$STATE_A" || fail "a confirmed decision did not reach folded state"

NOWHY="$(SELF decide retract "$GONE" 2>&1 || true)"
echo "$NOWHY" | grep -q "usage: self decide retract" || fail "retracting without --why was not refused"
grep -q '"type":"decision.retracted"' "$LOG_A" && fail "a refused retraction still wrote an event"

SELF decide retract "$GONE" --why "the constraint behind it went away" > /dev/null
exercised decision
grep -q "the rule recorded in error" "$STATE_A" && fail "a retracted decision still renders in state.md"
grep -q "the rule that still holds" "$STATE_A" || fail "a retraction took an unrelated decision with it"
SELF context | grep -q "the rule recorded in error" && fail "a retracted decision still renders in self context"
SELF status | grep -q "the rule recorded in error" && fail "a retracted decision still renders in self status"
SELF search --type decision "recorded in error" | grep -q "decision.confirmed \[retracted\]" \
    || fail "a retracted decision does not resolve in search with its status"
SELF search --type decision "still holds" | grep -q "\[retracted\]" && fail "search marked a decision that still holds"
# the withdrawal is the record of why, and it went through the event gate
grep -q '"type":"decision.retracted"' "$LOG_A" || fail "the retraction wrote no event"
grep -q "the constraint behind it went away" "$LOG_A" || fail "the retraction did not record its reason"

# ── every refusal names the state the record is in ───────────────────
AGAIN="$(SELF decide retract "$GONE" --why "twice" 2>&1 || true)"
echo "$AGAIN" | grep -q "was already retracted" || fail "retracting a retracted decision was not refused in its own terms"
OLD="$(SELF decide "the superseded original" --why "gets replaced" | id_of)"
SELF decide "the replacement" --supersedes "$OLD" > /dev/null
SUPER="$(SELF decide retract "$OLD" --why "already gone" 2>&1 || true)"
echo "$SUPER" | grep -q "was already superseded" || fail "retracting a superseded decision was not refused"
PROP="$(SELF decide "a proposal, not a rule" --proposed | id_of)"
WRONGVERB="$(SELF decide retract "$PROP" --why "wrong verb" 2>&1 || true)"
echo "$WRONGVERB" | grep -q "self decide decline $PROP" || fail "retracting a proposal did not name the verb that fits"
WRONGVERB2="$(SELF decide decline "$KEEP" --why "wrong verb" 2>&1 || true)"
echo "$WRONGVERB2" | grep -q "self decide retract $KEEP" || fail "declining a confirmed decision did not name the verb that fits"
NOTADECISION="$(SELF convention add "a convention, not a decision" | id_of)"
NOTONE="$(SELF decide retract "$NOTADECISION" --why "wrong record" 2>&1 || true)"
echo "$NOTONE" | grep -q "is not a decision" || fail "retracting a non-decision event was not refused"

# ── declining a proposal ─────────────────────────────────────────────
# It leaves "waiting on you" at once instead of sitting there until the 14-day
# expiry, which is the fallback and not the answer.
SELF context | grep -q "a proposal, not a rule" || fail "a proposed decision never reached the waiting section"
NODECLWHY="$(SELF decide decline "$PROP" 2>&1 || true)"
echo "$NODECLWHY" | grep -q "usage: self decide decline" || fail "declining a decision without --why was not refused"
SELF decide decline "$PROP" --why "we are not doing this" > /dev/null
SELF context | grep -q "a proposal, not a rule" && fail "a declined proposal still waits on the person"
SELF status | grep -q "a proposal, not a rule" && fail "a declined proposal still renders in self status"
grep -q "a proposal, not a rule" "$STATE_A" && fail "a declined proposal still renders in state.md"
SELF search --type decision "not a rule" | grep -q "decision.proposed \[declined\]" \
    || fail "a declined proposal does not resolve in search with its status"
REDECLINE="$(SELF decide decline "$PROP" --why "twice" 2>&1 || true)"
echo "$REDECLINE" | grep -q "was already declined" || fail "declining a declined proposal was not refused"

# a declined proposal is not a decision that can be confirmed afterwards
RECONFIRM="$(SELF decide confirm "$PROP" 2>&1 || true)"
grep -c '"type":"decision.confirmed"' "$LOG_A" > "$ROOT/confirm-count"
SELF context | grep -q "a proposal, not a rule" && fail "a declined proposal came back through confirm"

# ── a withdrawn decision the rest of the log still points at ─────────
# Refs are history, not live pointers: nothing that names a retracted decision
# may crash a fold or a derivation, and the ids stay resolvable.
WGATED="$(SELF work add "gated by a proposal that gets declined" | tail -1)"
GATE="$(SELF decide "gates the unit above" --proposed --blocks "$WGATED" | id_of)"
SELF context | grep -q "confirming unblocks $WGATED" || fail "the gating proposal never reached the band"
SELF decide "sequenced behind the gate" --proposed --after "$GATE" > /dev/null
SELF status | grep -q "1 cannot be decided yet" || fail "a proposal waiting on an open gate did not read as undecidable"
SELF decide decline "$GATE" --why "the unit does not need it" > /dev/null
SELF fold > /dev/null
SELF context | grep -q "confirming unblocks $WGATED" && fail "a declined proposal still gates work"
SELF status | grep -q "0 cannot be decided yet" || fail "a proposal waiting on a declined gate still reads as undecidable"
SELF context | grep -q "sequenced behind the gate" || fail "the proposal behind the declined gate disappeared with it"
# the id it was sequenced behind still resolves, so history stays readable
SELF decide "names the declined gate as its predecessor" --proposed --after "$GATE" > /dev/null \
    || fail "a declined decision stopped resolving as an event id"
SELF work show "$WGATED" > /dev/null || fail "work detail crashed on a declined gate"

# ── conventions: one event corrects a rule, with lineage ─────────────
WRONGC="$(SELF convention add "records in whichever language" | id_of)"
grep -q "records in whichever language" "$STATE_A" || fail "a convention did not reach folded state"
SELF convention add "records in English" --supersedes "$WRONGC" > /dev/null
exercised convention
grep -q "records in whichever language" "$STATE_A" && fail "a superseded convention still renders as current"
grep -q "records in English" "$STATE_A" || fail "the replacing convention did not render"
CBEFORE="$(grep -c '"type":"convention' "$LOG_A")"
SELF search --type convention "whichever language" | grep -q "convention.added \[superseded\]" \
    || fail "a superseded convention does not resolve in search with its status"
# the lineage is on the record: one event, not a drop and a re-add
grep '"type":"convention.added"' "$LOG_A" | grep -q "\"supersedes\":\[\"$WRONGC\"\]" \
    || fail "the correction carried no lineage back to the convention it replaced"
[ "$(grep -c '"type":"convention.dropped"' "$LOG_A")" = 0 ] || fail "a supersession wrote a drop event as well"

REPLACED="$(SELF convention add "already superseded above" --supersedes "$WRONGC" 2>&1 || true)"
echo "$REPLACED" | grep -q "was already superseded" || fail "superseding a superseded convention was not refused"
[ "$(grep -c '"type":"convention' "$LOG_A")" = "$CBEFORE" ] || fail "a refused supersession still wrote an event"
NOTC="$(SELF convention add "points at a decision" --supersedes "$KEEP" 2>&1 || true)"
echo "$NOTC" | grep -q "is not a convention" || fail "superseding a non-convention was not refused"

# dropping still works and folds to its own status, distinct from superseded
DROPC="$(SELF convention add "a rule with nothing to replace it" | id_of)"
NODROPWHY="$(SELF convention drop "$DROPC" 2>&1 || true)"
echo "$NODROPWHY" | grep -q "usage: self convention drop" || fail "dropping a convention without --why was not refused"
SELF convention drop "$DROPC" --why "the rule stopped applying" > /dev/null
grep -q "a rule with nothing to replace it" "$STATE_A" && fail "a dropped convention still renders as current"
SELF search --type convention "nothing to replace it" | grep -q "convention.added \[dropped\]" \
    || fail "a dropped convention does not resolve in search with its status"
REDROP="$(SELF convention drop "$DROPC" --why "twice" 2>&1 || true)"
echo "$REDROP" | grep -q "was already dropped" || fail "dropping a dropped convention was not refused"
# --supersedes belongs to `add`; on `drop` it would silently take the id the
# person meant as the replacement and drop one rule with nothing recorded
KEEPC="$(SELF convention add "a rule a bad drop must not touch" | id_of)"
BADDROP="$(SELF convention drop "$KEEPC" --why "wrong flag" --supersedes "$KEEPC" 2>&1 || true)"
echo "$BADDROP" | grep -q "convention drop takes no --supersedes" || fail "--supersedes on drop was swallowed"
grep -q "a rule a bad drop must not touch" "$STATE_A" || fail "a refused drop dropped the convention anyway"

# ── objectives: a proposal can be turned down ────────────────────────
OPROP="$(SELF objective add "a proposed objective nobody wants" --horizon month --proposed | tail -1)"
SELF context | grep -q "$OPROP" || fail "a proposed objective never reached the waiting section"
NOOBJWHY="$(SELF objective decline "$OPROP" 2>&1 || true)"
echo "$NOOBJWHY" | grep -q "usage: self objective decline" || fail "declining an objective without --why was not refused"
SELF objective decline "$OPROP" --why "the quarter went elsewhere" > /dev/null
exercised objective
SELF context | grep -q "a proposed objective nobody wants" && fail "a declined objective still waits on the person"
SELF objective | grep -q "$OPROP" && fail "a declined objective still lists as open"
REDECLINEO="$(SELF objective decline "$OPROP" --why "twice" 2>&1 || true)"
echo "$REDECLINEO" | grep -q "is already declined" || fail "declining a declined objective was not refused"

# ── the withdrawal payload goes through the one event gate ───────────
# `--why` is free text a person types, so it is sanitized exactly as every
# other append is — the guard is not per-verb and may not be.
LEAKW="$(SELF decide "a rule whose withdrawal leaks" --why "recorded" | id_of)"
LEAK="$(SELF decide retract "$LEAKW" --why "rotate sk-live-AAAABBBBCCCCDDDDEEEE00001111 first" 2>&1 || true)"
echo "$LEAK" | grep -qi "secret\|credential\|refus" || fail "a credential in a retraction reason was not refused"
grep -q "sk-live-AAAABBBBCCCCDDDDEEEE00001111" "$LOG_A" && fail "a credential reached the log through a retraction"
grep -q "a rule whose withdrawal leaks" "$STATE_A" || fail "a refused retraction withdrew the decision anyway"

# ── every statement type answers search with its status ──────────────
# The markers come from STATEMENT_TYPES, so a type in the registry that never
# leaves a status behind is a type the registry is wrong about.
WDONE="$(SELF work add "a unit that reaches done" | tail -1)"
SELF work start "$WDONE" > /dev/null
WRET="$(SELF work add "a unit that gets retired" | tail -1)"
SELF work retire "$WRET" --why "the outcome moved" > /dev/null
exercised work
SELF search --type work "a unit that gets retired" | grep -q "\[retired\]" \
    || fail "a retired work unit does not resolve in search with its status"
SELF search --type work "a unit that reaches done" | grep -q "\[retired\]" \
    && fail "search marked an open work unit as retired"
OCLOSE="$(SELF objective add "an objective that gets dropped" --horizon month | tail -1)"
NOCLOSEWHY="$(SELF objective close "$OCLOSE" --as dropped 2>&1 || true)"
echo "$NOCLOSEWHY" | grep -q "usage: self objective close" || fail "closing an objective as dropped without --why was not refused"
SELF objective close "$OCLOSE" --as dropped --why "the quarter ended" > /dev/null
SELF search --type objective "an objective that gets dropped" | grep -q "\[dropped\]" \
    || fail "a dropped objective does not resolve in search with its status"
OLIVE="$(SELF objective add "an objective that stays open" --horizon month | tail -1)"
MDROP="$(SELF milestone add "a checkpoint nobody reaches" --objective "$OLIVE" --exit "something lands" | tail -1)"
SELF milestone drop "$MDROP" --why "the approach changed" > /dev/null
exercised milestone
SELF search --type milestone "a checkpoint nobody reaches" | grep -q "\[dropped\]" \
    || fail "a dropped milestone does not resolve in search with its status"
SELF milestone | grep -q "$MDROP" && fail "a dropped milestone still lists as open"
SELF milestone show "$MDROP" | grep -q "the approach changed" || fail "a dropped milestone lost the reason it left the list"

# ── dropping a milestone is terminal ─────────────────────────────────
# Revising, covering or reaching a dropped checkpoint would put a withdrawn
# record back into the current renders. The command refuses each; the fold
# refuses them too, because a log written by a version that did not — or merged
# from another machine — must not be able to resurrect it either.
REDROPM="$(SELF milestone drop "$MDROP" --why "twice" 2>&1 || true)"
echo "$REDROPM" | grep -q "is already closed" || fail "dropping a dropped milestone was not refused"
printf '{"id":"late-milestone-revised","ts":"2099-01-01T00:00:00.000Z","type":"milestone.revised","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"milestone":"%s","why":"resurrect","outcome":"revised after the drop"}}\n' "$MDROP" >> "$LOG_A"
printf '{"id":"late-milestone-covered","ts":"2099-01-01T00:00:01.000Z","type":"milestone.covered","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"milestone":"%s","criterion":"c1","why":"resurrect"}}\n' "$MDROP" >> "$LOG_A"
printf '{"id":"late-milestone-reached","ts":"2099-01-01T00:00:02.000Z","type":"milestone.reached","origin":{"actor":"agent","confirmed":false},"project":"demo","payload":{"milestone":"%s","criteria":["c1"]}}\n' "$MDROP" >> "$LOG_A"
SELF fold > /dev/null
SELF milestone | grep -q "$MDROP" && fail "post-drop events resurrected a withdrawn milestone"
SELF milestone show "$MDROP" | grep -q "dropped — the approach changed" || fail "a dropped milestone lost the reason it was dropped"
SELF milestone show "$MDROP" | grep -q "revised after the drop" && fail "a post-drop revision rewrote a withdrawn milestone"
SELF search --type milestone "a checkpoint nobody reaches" | grep -q "\[dropped\]" \
    || fail "a resurrected milestone changed its searched status"

# ── a lifecycle event above the record it names ──────────────────────
# A union merge of two clones orders lines by neither time nor dependency, so a
# retraction can sit above the decision it withdraws. The fold settles it on a
# second pass rather than leaving the record current forever.
cp "$LOG_A" "$ROOT/log-before-out-of-order"
printf '{"id":"out-of-order-retraction","ts":"2000-01-01T00:00:00.000Z","type":"decision.retracted","origin":{"actor":"agent","confirmed":true},"project":"demo","payload":{"why":"withdrawn before it was read"},"refs":{"retracts":"out-of-order-decision"}}\n' >> "$LOG_A"
printf '{"id":"out-of-order-supersession","ts":"2000-01-01T00:00:01.000Z","type":"convention.added","origin":{"actor":"agent","confirmed":true},"project":"demo","payload":{"text":"the replacement read before its predecessor"},"refs":{"supersedes":["out-of-order-convention"]}}\n' >> "$LOG_A"
printf '{"id":"out-of-order-decision","ts":"2000-01-01T00:00:02.000Z","type":"decision.confirmed","origin":{"actor":"agent","confirmed":true},"project":"demo","payload":{"text":"a decision read after its own retraction"}}\n' >> "$LOG_A"
printf '{"id":"out-of-order-convention","ts":"2000-01-01T00:00:03.000Z","type":"convention.added","origin":{"actor":"agent","confirmed":true},"project":"demo","payload":{"text":"a convention read after its replacement"}}\n' >> "$LOG_A"
SELF fold > /dev/null
grep -q "a decision read after its own retraction" "$STATE_A" && fail "a retraction above its decision left the decision current"
grep -q "a convention read after its replacement" "$STATE_A" && fail "a supersession above its convention left the convention current"
grep -q "the replacement read before its predecessor" "$STATE_A" || fail "the out-of-order replacement itself went missing"
SELF search --type decision "read after its own retraction" | grep -q "\[retracted\]" \
    || fail "the reconciled retraction did not reach search"
# and the second pass never runs a transition twice: a decision confirmed from
# its own proposal keeps one record, at one status
ONCE="$(SELF decide "confirmed-once marker" --proposed | id_of)"
SELF decide confirm "$ONCE" > /dev/null
[ "$(grep -c "confirmed-once marker" "$STATE_A")" = 1 ] || fail "the reconciliation pass folded one decision twice"
cp "$ROOT/log-before-out-of-order" "$LOG_A"
SELF fold > /dev/null

# ── a linked work proposal keeps its own identity ────────────────────
# A proposal carries the objective and milestone it serves, and it is named by
# the event that opened it — so resolving a search hit by payload id would mark
# a declined proposal with its objective's status instead of its own.
OPLINK="$(SELF objective add "the objective a proposal serves" --horizon month | tail -1)"
MPLINK="$(SELF milestone add "the milestone a proposal serves" --objective "$OPLINK" --exit "it lands" | tail -1)"
EXPIRES="$(date -u -d "+30 days" +%F 2>/dev/null || date -u -v+30d +%F)"
SELF work propose "a linked proposal that gets declined" --milestone "$MPLINK" --value "closes the gap" \
    --success "it ships" --stop "it does not" --risk "low" --capacity "one session" \
    --evidence-plan "a report with commits" --confidence medium --expires "$EXPIRES" > /dev/null
PLINK="$(SELF log -n 1 | id_of)"
NOPWHY="$(SELF work decline "$PLINK" 2>&1 || true)"
echo "$NOPWHY" | grep -q "usage: self work decline" || fail "declining a work proposal without --why was not refused"
SELF work decline "$PLINK" --why "the milestone got there another way" > /dev/null
SELF search --type work "a linked proposal that gets declined" | grep "work.proposed" | grep -q "\[declined\]" \
    || fail "a declined proposal linked to a milestone resolved to the linked outcome instead of itself"
SELF context | grep -q "a linked proposal that gets declined" && fail "a declined work proposal still waits on the person"

# ── a terminal objective stays terminal ──────────────────────────────
# The reconciliation pass reads confirm, decline and close a second time, so a
# stale line from a merged log must not answer a question already answered.
OTERM="$(SELF objective add "an objective declined then confirmed late" --horizon month --proposed | tail -1)"
SELF objective decline "$OTERM" --why "we are not doing it" > /dev/null
LATECONFIRM="$(SELF objective confirm "$OTERM" 2>&1 || true)"
echo "$LATECONFIRM" | grep -q "is already declined" || fail "confirming a declined objective was not refused"
LATECLOSE="$(SELF objective close "$OTERM" --as reached 2>&1 || true)"
echo "$LATECLOSE" | grep -q "is already declined" || fail "closing a declined objective was not refused"
# and the fold refuses it too, because a merged log reaches it without a command
printf '{"id":"late-objective-confirmed","ts":"2099-01-01T00:00:00.000Z","type":"objective.confirmed","origin":{"actor":"agent","confirmed":true},"project":"demo","payload":{"objective":"%s"}}\n' "$OTERM" >> "$LOG_A"
printf '{"id":"late-objective-closed","ts":"2099-01-01T00:00:01.000Z","type":"objective.closed","origin":{"actor":"agent","confirmed":true},"project":"demo","payload":{"objective":"%s","as":"reached"}}\n' "$OTERM" >> "$LOG_A"
printf '{"id":"late-objective-revised","ts":"2099-01-01T00:00:02.000Z","type":"objective.revised","origin":{"actor":"agent","confirmed":true},"project":"demo","payload":{"objective":"%s","why":"resurrect","outcome":"rewritten after the decline"}}\n' "$OTERM" >> "$LOG_A"
SELF fold > /dev/null
SELF objective | grep -q "$OTERM" && fail "a late confirmation resurrected a declined objective"
SELF context | grep -q "an objective declined then confirmed late" && fail "a resurrected objective came back to waiting"
SELF objective show "$OTERM" | grep -q "rewritten after the decline" && fail "a post-decline revision rewrote a terminal objective"
SELF search --type objective "declined then confirmed late" | grep -q "\[declined\]" \
    || fail "a terminal objective lost its status in search"

# ── piped and terminal renders say the same thing ────────────────────
# resolveRender is the one answer to which render a run gets, so a withdrawn
# record may not reappear on the render the flags force. `--pretty` is the
# terminal render on a pipe, and `--plain` is the piped one; a context that
# folds only current records has to say the same thing on both.
COLUMNS=200 SELF context --pretty > "$ROOT/context-pretty.txt"
SELF context --plain > "$ROOT/context-plain.txt"
for RENDERED in "$ROOT/context-pretty.txt" "$ROOT/context-plain.txt"
do
    grep -q "the rule recorded in error" "$RENDERED" && fail "a retracted decision came back on $(basename "$RENDERED")"
    grep -q "records in whichever language" "$RENDERED" && fail "a superseded convention came back on $(basename "$RENDERED")"
    grep -q "a rule with nothing to replace it" "$RENDERED" && fail "a dropped convention came back on $(basename "$RENDERED")"
    grep -q "the rule that still holds" "$RENDERED" || fail "$(basename "$RENDERED") lost a decision that still holds"
    grep -q "records in English" "$RENDERED" || fail "$(basename "$RENDERED") lost the convention that replaced a corrected one"
done

# ── every registry entry was actually driven ─────────────────────────
# The checks at the top of this suite read the registry; this one reads what the
# suite did with it. A statement type added under a namespace another type
# already covers passes the namespace check, so without this it would ship with
# no behaviour proved at all.
while IFS='~' read -r TYPE CMD SUPERSEDE WITHDRAW DECLINE NAMESPACES
do
    [ -n "$TYPE" ] || continue
    grep -qx "$TYPE" "$EXERCISED" \
        || fail "the $TYPE statement type is in STATEMENT_TYPES but no block in this suite exercises its lifecycle — add one and mark it with \`exercised $TYPE\`"
done < "$LIFECYCLE_ROWS"
[ "$(sort -u "$EXERCISED" | grep -c .)" = "$(grep -c . "$LIFECYCLE_ROWS")" ] \
    || fail "the exercised types and the registry rows do not match one for one"

echo "lifecycle OK"
