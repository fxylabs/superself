#!/usr/bin/env bash
# The overnight policy and the morning digest. Every case here is a statement
# about bounded autonomy: what the supervisor may spend while nobody is awake,
# what it may never do at any hour, and what account of the night the operator
# finds when they come back.
#
# This builds its own machine root, like the supervision and completion proofs
# do: the cases dispatch real attempts and run supervision ticks, and none of
# that may reach the machine the proof is run on.
set -euo pipefail

CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d)"

SELF_JS="$CLI_DIR/bin/self.mjs"
AGENT="$CLI_DIR/proof/daemon-agent.mjs"
VALIDATE="$CLI_DIR/proof/daemon-validate.mjs"
LAUNCH="$CLI_DIR/proof/daemon-launch.mjs"
MKPLAN="$CLI_DIR/proof/attempt-plan.mjs"
MKSPEC="$CLI_DIR/proof/workspec.mjs"

SELF()
{
    node "$SELF_JS" "$@"
}

fail()
{
    echo "proof FAILED: $1" >&2
    exit 1
}

# Nothing this section starts may outlive it.
cleanup()
{
    node "$SELF_JS" daemon stop > /dev/null 2>&1 || true
    rm -rf "$ROOT"
}
trap cleanup EXIT

export HOME="$ROOT/A/home"
export XDG_CONFIG_HOME="$ROOT/A/config"
export XDG_STATE_HOME="$ROOT/A/state"
mkdir -p "$HOME/.claude" "$ROOT/A/ws/demo" "$ROOT/dest"
git config --global user.name "proof A"
git config --global user.email "proof-A@superself.local"

# The markers the runner sets on every child it starts: this proof drives the
# CLI as a person would and must not inherit an attempt marker from whatever
# started it.
unset SUPERSELF_SESSION SUPERSELF_ATTEMPT_ID || true

cd "$ROOT/A/ws"
SELF init --agents > /dev/null
cd "$ROOT/A/ws/demo"
# The initial branch is named rather than inherited: a machine whose git starts
# repositories on `master` would leave the cases below on a branch they never
# named. Nothing here leaves it, and naming it is still what makes the harness
# read the same on every checkout.
git init -q -b main
git commit -q --allow-empty -m "base"
SELF project add --name demo --desc "overnight policy and digest harness" > /dev/null
SELF goal set "prove the daemon's autonomy is bounded by a written policy" > /dev/null

STORE="$ROOT/A/ws/.superself"
LOG="$STORE/projects/demo/log.jsonl"
DEMO="$ROOT/A/ws/demo"
RUNNER="$ROOT/A/state/superself/runner"

spool_of()
{
    echo "$RUNNER/attempts/$1"
}
count_events()
{
    grep -c "\"type\":\"$1\"" "$LOG" || true
}
one_line()
{
    [ "$(printf '%s' "$1" | grep -c .)" = "1" ] || fail "a refusal was not one line: $1"
    printf '%s' "$1" | grep -q "    at " && fail "a refusal printed a stack trace"
    return 0
}
tick_json()
{
    SELF daemon tick --json | tail -1
}
tick_count()
{
    node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(s[process.argv[1]]))' "$1"
}
wake_outcome()
{
    node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));const w=s.wakes.find(w=>w.workSpec===process.argv[1]);process.stdout.write(w===undefined?"none":w.outcome)' "$1"
}
attempts_of()
{
    SELF attempt list --work "$1" | awk '$1 ~ /^at-/ {print $1}'
}
attempt_state()
{
    SELF attempt show "$1" | sed -n 's/^state *//p' | awk '{print $1}'
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
plan()
{
    local file="$1"
    shift
    node "$MKPLAN" "$file" "agent=$AGENT" "cwd=$DEMO" "$@"
}
workspec()
{
    local file="$1"
    shift
    node "$MKSPEC" "$file" "agent=$AGENT" "cwd=$DEMO" "$@"
}
# Drives one CLI command under a real pseudo-terminal, typing one line. A
# policy is granted by a person at a terminal, so every case that sets one has
# to reach the CLI the way that person does: the command sees a tty on stdin
# and stdout, and the typed line arrives through the terminal.
pty_self()
{
    local typed="$1"
    shift
    # The feeder stays open after the line: closing it immediately delivers an
    # EOF to the terminal before the prompt has read, which is not what a
    # human's terminal ever does.
    if script --version > /dev/null 2>&1
    then
        { printf '%s\n' "$typed"; sleep 1; } | script -qec "node $SELF_JS $*" /dev/null > /dev/null 2>&1 || true
    else
        { printf '%s\n' "$typed"; sleep 1; } | script -q /dev/null node "$SELF_JS" "$@" > /dev/null 2>&1 || true
    fi
}
# The challenge `overnight set` asks for is the window being granted, so it is
# read off the very flags the case passed rather than restated beside them.
challenge_for()
{
    local from="22:00" to="07:00" prev=""
    for arg in "$@"
    do
        case "$prev" in
            --from) from="$arg";;
            --to) to="$arg";;
        esac
        prev="$arg"
    done
    printf '%s-%s' "$from" "$to"
}
# One policy set, at a terminal, and proven to have landed. A pty run reports
# nothing this shell can read, so the record it left is what says it worked —
# without this, a gate that silently refused would leave every case below
# passing against the policy the case before it set.
set_policy()
{
    local before after
    before="$(count_events overnight.set)"
    pty_self "$(challenge_for "$@")" overnight set "$@"
    after="$(count_events overnight.set)"
    [ "$after" = "$((before + 1))" ] || fail "overnight set recorded no policy: $*"
}

# A window that is nowhere near now, and one that certainly holds it. Written
# from the machine's own clock rather than from a fixed pair of times: a case
# about "outside the window" must be outside it whatever hour the proof runs.
away_window()
{
    node -e '
const now = new Date();
const from = (now.getHours() + Number(process.argv[1])) % 24;
const to = (from + 1) % 24;
process.stdout.write(`${String(from).padStart(2, "0")}:00 ${String(to).padStart(2, "0")}:00`);
' "$1"
}

# ---------------------------------------------------------------------------
# A policy set, shown, and revoked: versioned, revocable, and restart-safe
# ---------------------------------------------------------------------------
[ "$(SELF overnight show)" = "no overnight policy is in force — the daemon supervises what exists and dispatches nothing new" ] \
    || fail "a project with no policy did not say so"

set_policy --from 22:00 --to 07:00 --digest-at 07:30 --auto-dispatch --max-concurrent 2
SELF overnight show | grep -q "version       1" || fail "the first policy was not version 1"
SELF overnight show | grep -q "22:00–07:00" || fail "the window the policy was set with is not what it shows"

set_policy --from 23:00 --to 06:00
[ "$(SELF overnight show --json | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).version))')" = "2" ] \
    || fail "a second policy did not supersede the first as version 2"

# revoked, and every reader agrees — the policy is an event, so a cold process
# reads the revocation the same way this one does
SELF overnight off > /dev/null
[ "$(count_events overnight.revoked)" = "1" ] || fail "the revocation left no durable record"
SELF overnight show | grep -q "no overnight policy is in force" || fail "a revoked policy was still shown as in force"
NOTHING="$(SELF overnight off 2>&1 || true)"
one_line "$NOTHING"
echo "$NOTHING" | grep -q "nothing to revoke" || fail "revoking twice was not refused"

# and the next set counts from where the revoked one left off: a version reused
# after a revocation would make two different nights indistinguishable
set_policy --from 22:00 --to 07:00
[ "$(SELF overnight show --json | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).version))')" = "3" ] \
    || fail "a policy set after a revocation reused a version"

# ---------------------------------------------------------------------------
# Outside the window a tick settles and releases, and wakes nothing
# ---------------------------------------------------------------------------
read -r AWAY_FROM AWAY_TO <<< "$(away_window 3)"
set_policy --from "$AWAY_FROM" --to "$AWAY_TO" --auto-dispatch --max-concurrent 4

WWAKE="$(SELF work add "eligible work waits for the window and then runs" | tail -1)"
SELF work start "$WWAKE" > /dev/null
workspec "$ROOT/ws-wake.json" "id=ws-wake" "work=$WWAKE" "dest=$ROOT/dest/wake.md" "providerName=night-provider"
SELF spec apply "$ROOT/ws-wake.json" > /dev/null

# an exit whose settlement never finished, so the tick below has real work to
# do that is not a dispatch
WSETTLE="$(SELF work add "an exit settles while the window is shut" | tail -1)"
SELF work start "$WSETTLE" > /dev/null
plan "$ROOT/plan-settle.json" "work=$WSETTLE" "dest=$ROOT/dest/settle.md" "validate=$VALIDATE" "gate=$ROOT/release-validate"
AT_SETTLE="$(SELF attempt register "$ROOT/plan-settle.json" | tail -1)"
node "$LAUNCH" "$SELF_JS" "$AT_SETTLE" "$(spool_of "$AT_SETTLE")" "$DEMO" --crash-in-settlement "--after-publish=$ROOT/dest/settle.md" > /dev/null 2>&1
touch "$ROOT/release-validate"

SHUT="$(tick_json)"
[ "$(echo "$SHUT" | wake_outcome ws-wake)" = "outside-window" ] || fail "a tick outside the window still judged the wake on the work's own state"
[ "$(echo "$SHUT" | tick_count woken)" = "0" ] || fail "a tick outside the overnight window dispatched new work"
[ "$(echo "$SHUT" | tick_count settled)" = "1" ] || fail "a tick outside the window stopped settling what had already ended"
[ "$(echo "$SHUT" | tick_count released)" -ge 1 ] || fail "a tick outside the window stopped releasing what it settled"
[ "$(attempt_state "$AT_SETTLE")" = "completed" ] || fail "the settled attempt did not reach completed outside the window"
[ -z "$(attempts_of "$WWAKE")" ] || fail "work outside the window materialized an attempt"

# with no policy at all, the same answer for the same reason
SELF overnight off > /dev/null
[ "$(tick_json | wake_outcome ws-wake)" = "no-policy" ] || fail "a tick with no policy dispatched on its own authority"
[ -z "$(attempts_of "$WWAKE")" ] || fail "a tick with no policy materialized an attempt"

# and a window that holds now dispatches the very same work
set_policy --from 00:00 --to 00:00 --auto-dispatch --max-concurrent 4
[ "$(tick_json | wake_outcome ws-wake)" = "woken" ] || fail "eligible work was not dispatched inside the window"
await '[ -f "$ROOT/dest/wake.md" ]' || fail "the woken dispatch never published its artifact"
await 'wake_settled ws-wake' || fail "the woken dispatch never finished"

# ---------------------------------------------------------------------------
# The allow lists: a project, a kind and a risk class the policy does not name
# ---------------------------------------------------------------------------
WKIND="$(SELF work add "a work kind the policy does not allow overnight" | tail -1)"
SELF work start "$WKIND" > /dev/null
workspec "$ROOT/ws-kind.json" "id=ws-kind" "work=$WKIND" "role=research" "dest=$ROOT/dest/kind.md" "providerName=night-provider"
SELF spec apply "$ROOT/ws-kind.json" > /dev/null

WRISK="$(SELF work add "a spec that reaches the network is not internal risk" | tail -1)"
SELF work start "$WRISK" > /dev/null
workspec "$ROOT/ws-risk.json" "id=ws-risk" "work=$WRISK" "domains=api.example.invalid" "dest=$ROOT/dest/risk.md" "providerName=night-provider"
SELF spec apply "$ROOT/ws-risk.json" > /dev/null

ALLOW="$(tick_json)"
[ "$(echo "$ALLOW" | wake_outcome ws-kind)" = "kind-not-allowed" ] || fail "a work kind outside the allow list was woken"
[ "$(echo "$ALLOW" | wake_outcome ws-risk)" = "risk-not-allowed" ] || fail "a spec that declares network reach was woken as internal risk"
[ -z "$(attempts_of "$WKIND")" ] || fail "a disallowed work kind materialized an attempt"
[ -z "$(attempts_of "$WRISK")" ] || fail "a disallowed risk class materialized an attempt"

# naming the kind is what admits it, and nothing else changed
set_policy --from 00:00 --to 00:00 --auto-dispatch --max-concurrent 4 --kind implementation --kind research
[ "$(tick_json | wake_outcome ws-kind)" = "woken" ] || fail "a kind the policy names was still refused"
await 'wake_settled ws-kind' || fail "the research dispatch never finished"

# a policy that names another project wakes nothing here
set_policy --from 00:00 --to 00:00 --auto-dispatch --project other
[ "$(tick_json | wake_outcome ws-risk)" = "project-not-allowed" ] || fail "a project outside the allow list was woken"

# ---------------------------------------------------------------------------
# The concurrency cap holds
# ---------------------------------------------------------------------------
set_policy --from 00:00 --to 00:00 --auto-dispatch --max-concurrent 2
for n in 1 2 3
do
    W="$(SELF work add "one of three ready units under a cap of two ($n)" | tail -1)"
    SELF work start "$W" > /dev/null
    eval "WCAP$n=\$W"
    workspec "$ROOT/ws-cap$n.json" "id=ws-cap$n" "work=$W" "dest=$ROOT/dest/cap$n.md" "providerName=cap-provider"
    SELF spec apply "$ROOT/ws-cap$n.json" > /dev/null
done

CAP="$(tick_json)"
[ "$(echo "$CAP" | tick_count woken)" = "2" ] || fail "the tick did not stop at the policy's concurrency cap"
CAPPED=0
for n in 1 2 3
do
    [ "$(echo "$CAP" | wake_outcome "ws-cap$n")" = "at-concurrency-cap" ] && CAPPED=$((CAPPED + 1))
done
[ "$CAPPED" = "1" ] || fail "the tick refused the wrong number of generations on the cap"
await 'wake_settled ws-cap1 && wake_settled ws-cap2 && wake_settled ws-cap3' || fail "the capped dispatches never finished"

# ---------------------------------------------------------------------------
# The remaining bounds: provider, model, declared cost, retries, stop condition
# ---------------------------------------------------------------------------
WBOUND="$(SELF work add "a spec judged against every bound the policy carries" | tail -1)"
SELF work start "$WBOUND" > /dev/null
workspec "$ROOT/ws-bound.json" "id=ws-bound" "work=$WBOUND" "dest=$ROOT/dest/bound.md" \
    "providerName=night-provider" "model=claude-opus-5" "budgetUsd=5" "maxRuns=3"
SELF spec apply "$ROOT/ws-bound.json" > /dev/null

bound_outcome()
{
    set_policy --from 00:00 --to 00:00 --auto-dispatch --max-concurrent 4 "$@"
    tick_json | wake_outcome ws-bound
}

[ "$(bound_outcome --provider other-provider)" = "provider-not-allowed" ] || fail "a provider outside the allow list was woken"
[ "$(bound_outcome --model claude-haiku-4-5)" = "model-not-allowed" ] || fail "a model outside the allow list was woken"
[ "$(bound_outcome --max-runs 1)" = "retries-above-policy" ] || fail "a spec declaring more runs than the policy allows was woken"
[ "$(bound_outcome --budget-usd 2)" = "over-budget" ] || fail "a spec declaring more than the policy's ceiling was woken"

# a stop condition is about what this window has already suffered, so the
# window needs a failure in it before the condition can be said to hold
WSTOP="$(SELF work add "one failed run, so the window has something to stop for" | tail -1)"
SELF work start "$WSTOP" > /dev/null
plan "$ROOT/plan-stop.json" "work=$WSTOP" "mode=prose" "dest=$ROOT/dest/stop.md" "maxRuns=1"
SELF attempt run "$ROOT/plan-stop.json" > /dev/null 2>&1 || true
[ "$(count_events run.failed)" -ge 1 ] || fail "the run that was meant to fail did not"
[ "$(bound_outcome --stop-after 1)" = "stopped" ] || fail "the window's stop condition did not hold after a failed run"
[ "$(bound_outcome --provider night-provider --model claude-opus-5 --max-runs 3 --budget-usd 5)" = "woken" ] \
    || fail "a spec inside every bound the policy carries was still refused"
await 'wake_settled ws-bound' || fail "the bounded dispatch never finished"

# a policy names a model class the way a completion policy does. `opus` is what
# an operator writes when they mean the family, and a window that refused
# claude-opus-5 for not being that exact string would read as a bug rather than
# as a bound. A provider name has no family to stand for, so it stays exact.
WCLASS="$(SELF work add "a policy that names a model class rather than an identifier" | tail -1)"
SELF work start "$WCLASS" > /dev/null
workspec "$ROOT/ws-class.json" "id=ws-class" "work=$WCLASS" "dest=$ROOT/dest/class.md" \
    "providerName=night-provider" "model=claude-opus-5"
SELF spec apply "$ROOT/ws-class.json" > /dev/null

set_policy --from 00:00 --to 00:00 --auto-dispatch --max-concurrent 4 --model opus
[ "$(tick_json | wake_outcome ws-class)" = "woken" ] || fail "a policy naming a model class refused the model that belongs to it"
await 'wake_settled ws-class' || fail "the class-matched dispatch never finished"

# ---------------------------------------------------------------------------
# The declared-cost ceiling holds inside one tick, not only across ticks
# ---------------------------------------------------------------------------
# Two eligible specs, each declaring more than half the window's remaining
# ceiling. Both are judged in one pass against one fold of the log, and the
# first one woken records its `run.woken` far too late for that fold to see —
# so a tick that measured each of them against the log alone would find the
# same room twice and wake both, committing $120 of a $100 ceiling in one pass.
# What this tick has already handed out is part of what the next generation is
# measured against.
#
# The margin is wide on purpose: the cases above have committed a few dollars
# of this window already, and what is under test is the second spec of this
# pair, not the arithmetic of everything that ran before it.
set_policy --from 00:00 --to 00:00 --auto-dispatch --max-concurrent 4 --budget-usd 100
for n in 1 2
do
    W="$(SELF work add "one of two specs whose declared budgets do not both fit ($n)" | tail -1)"
    SELF work start "$W" > /dev/null
    workspec "$ROOT/ws-usd$n.json" "id=ws-usd$n" "work=$W" "dest=$ROOT/dest/usd$n.md" \
        "providerName=night-provider" "budgetUsd=60"
    SELF spec apply "$ROOT/ws-usd$n.json" > /dev/null
done

USD="$(tick_json)"
USD_WOKEN=0
USD_DEFERRED=""
for n in 1 2
do
    case "$(echo "$USD" | wake_outcome "ws-usd$n")" in
        woken) USD_WOKEN=$((USD_WOKEN + 1));;
        over-budget) USD_DEFERRED="ws-usd$n";;
    esac
done
[ "$USD_WOKEN" = "1" ] || fail "one tick woke $USD_WOKEN specs whose declared budgets together exceed the window's ceiling"
[ -n "$USD_DEFERRED" ] || fail "the spec that no longer fits the ceiling was refused for some other reason than the budget"
[ "$(SELF spec show "$USD_DEFERRED" --json | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).attempts.length))')" = "0" ] \
    || fail "the spec refused on the ceiling still materialized an attempt"
await 'wake_settled ws-usd1 && wake_settled ws-usd2' || fail "the budgeted dispatch never finished"

# and the next tick refuses it again, now against a ceiling the log itself
# accounts for: what one tick committed is what the next one reads
[ "$(tick_json | wake_outcome "$USD_DEFERRED")" = "over-budget" ] || fail "the spec refused on the ceiling was not refused by the following tick"

# ---------------------------------------------------------------------------
# Approval and the completion policy are not widened by any window
# ---------------------------------------------------------------------------
set_policy --from 00:00 --to 00:00 --auto-dispatch --max-concurrent 4

WAPP="$(SELF work add "work a person has to approve stays waiting all night" | tail -1)"
SELF work start "$WAPP" > /dev/null
SELF work approval-required "$WAPP" --why "it changes what the operator sees" > /dev/null
workspec "$ROOT/ws-appr.json" "id=ws-appr" "work=$WAPP" "dest=$ROOT/dest/appr.md" "providerName=night-provider"
SELF spec apply "$ROOT/ws-appr.json" > /dev/null

[ "$(tick_json | wake_outcome ws-appr)" = "awaiting-approval" ] || fail "work awaiting approval was woken inside the window"
[ "$(tick_json | wake_outcome ws-appr)" = "awaiting-approval" ] || fail "a second tick inside the window took the unapproved work"
[ -z "$(attempts_of "$WAPP")" ] || fail "work awaiting approval materialized an attempt inside the window"

# a completion policy the window cannot exempt: the unit runs, it settles, and
# it is still not done, because who implemented it and who reviewed it are
# statements no window and no attempt ever settles
WPOL="$(SELF work add "a hard-model implementation and a fresh-session review, inside the window" | tail -1)"
SELF work start "$WPOL" > /dev/null
SELF work policy "$WPOL" --model opus --fresh-review --why "nobody is awake to look" > /dev/null
workspec "$ROOT/ws-pol.json" "id=ws-pol" "work=$WPOL" "dest=$ROOT/dest/pol.md" \
    "providerName=night-provider" "model=claude-haiku-4-5"
SELF spec apply "$ROOT/ws-pol.json" > /dev/null

[ "$(tick_json | wake_outcome ws-pol)" = "woken" ] || fail "the policy-bearing unit was not dispatched inside the window"
await '[ "$(attempt_state "$(attempts_of "'"$WPOL"'" | tail -1)")" = "completed" ]' || fail "the policy-bearing dispatch never completed"
await 'wake_settled ws-pol' || fail "the policy-bearing dispatch never finished"

WRONG="$(SELF work done "$WPOL" 2>&1 || true)"
one_line "$WRONG"
echo "$WRONG" | grep -q "completion policy and no settled attempt ran under it" \
    || fail "a night inside the window closed a unit whose hard-model policy was unmet"
echo "$WRONG" | grep -q "claude-haiku-4-5" || fail "the refusal did not say what the woken attempt actually ran under"
[ "$(count_events work.done)" = "0" ] || fail "a work unit reached done inside the window without its policy being met"

# ---------------------------------------------------------------------------
# Forbidden actions are refused categorically
# ---------------------------------------------------------------------------
# at registration, before a spool exists
WFORB="$(SELF work add "an action no policy can ever grant" | tail -1)"
SELF work start "$WFORB" > /dev/null
plan "$ROOT/plan-publish.json" "work=$WFORB" "tools=npm-publish" "dest=$ROOT/dest/publish.md"
REG="$(SELF attempt register "$ROOT/plan-publish.json" 2>&1 || true)"
one_line "$REG"
echo "$REG" | grep -q "which is publish" || fail "a plan declaring publication was registered"
[ -z "$(attempts_of "$WFORB")" ] || fail "a refused registration still left an attempt"

for pair in "stripe-charge:payment" "terraform-apply:provision" "send-email:outreach"
do
    plan "$ROOT/plan-forb.json" "work=$WFORB" "tools=${pair%%:*}" "dest=$ROOT/dest/forb.md"
    OUT="$(SELF attempt run "$ROOT/plan-forb.json" 2>&1 || true)"
    one_line "$OUT"
    echo "$OUT" | grep -q "which is ${pair##*:}" || fail "${pair%%:*} was not refused as ${pair##*:}"
done

# and in the wake set, on an allowed project, inside the window, on a unit
# nothing else objects to
workspec "$ROOT/ws-forb.json" "id=ws-forb" "work=$WFORB" "tools=deploy" "dest=$ROOT/dest/forb.md" "providerName=night-provider"
SELF spec apply "$ROOT/ws-forb.json" > /dev/null
[ "$(tick_json | wake_outcome ws-forb)" = "forbidden-action" ] || fail "a spec declaring a forbidden action entered the overnight wake set"
[ -z "$(attempts_of "$WFORB")" ] || fail "a spec declaring a forbidden action materialized an attempt"

# and a declaration that named no tool at all is judged by what it will run.
# The command is sealed declared bytes exactly like the tool list, and a run
# that reaches a payment API through it has asked for a payment however empty
# its capabilities read — the categorical list is not opt-in.
PAY='command=["/bin/sh","-c","curl -s -X POST https://api.stripe.invalid/v1/charges -d amount=999"]'
plan "$ROOT/plan-cmd.json" "work=$WFORB" "dest=$ROOT/dest/cmd.md" "$PAY"
CMDREG="$(SELF attempt register "$ROOT/plan-cmd.json" 2>&1 || true)"
one_line "$CMDREG"
echo "$CMDREG" | grep -q "which is payment" || fail "a plan whose command posts a charge was registered with an empty tool list"
[ -z "$(attempts_of "$WFORB")" ] || fail "a plan refused on its command still left an attempt"

WPAY="$(SELF work add "a spec that reaches a payment API through its command alone" | tail -1)"
SELF work start "$WPAY" > /dev/null
workspec "$ROOT/ws-pay.json" "id=ws-pay" "work=$WPAY" "dest=$ROOT/dest/pay.md" "providerName=night-provider" "$PAY"
SELF spec apply "$ROOT/ws-pay.json" > /dev/null
[ "$(tick_json | wake_outcome ws-pay)" = "forbidden-action" ] || fail "a spec whose command posts a charge entered the overnight wake set"
[ -z "$(attempts_of "$WPAY")" ] || fail "a spec whose command posts a charge materialized an attempt"

# the same bytes decide the risk class. Preflight probes the domains a spec
# declared and the default boundary wrapper is empty, so a spec that declares
# no domain and curls a host anyway is not internal risk — reading only the
# capability list would hand it to a default policy to wake.
WNET="$(SELF work add "a spec that reaches a host it never declared" | tail -1)"
SELF work start "$WNET" > /dev/null
workspec "$ROOT/ws-net.json" "id=ws-net" "work=$WNET" "dest=$ROOT/dest/net.md" "providerName=night-provider" \
    'command=["/bin/sh","-c","curl -s https://api.example.invalid/status"]'
SELF spec apply "$ROOT/ws-net.json" > /dev/null
[ "$(tick_json | wake_outcome ws-net)" = "risk-not-allowed" ] || fail "a spec that curls an undeclared host was judged internal risk"
[ -z "$(attempts_of "$WNET")" ] || fail "a spec that curls an undeclared host materialized an attempt"

# mid-run: an attempt that is already running asks, and is refused where it
# asked rather than queued for the morning
WPROP="$(SELF work add "an attempt proposes a forbidden action mid-run" | tail -1)"
SELF work start "$WPROP" > /dev/null
plan "$ROOT/plan-prop.json" "work=$WPROP" "dest=$ROOT/dest/prop.md"
AT_PROP="$(SELF attempt register "$ROOT/plan-prop.json" | tail -1)"

PROP="$(SELF attempt propose "$AT_PROP" --action publish-release 2>&1 || true)"
echo "$PROP" | grep -q "run.refused recorded" || fail "a refused proposal was not recorded as an event"
echo "$PROP" | grep -q "which is publish" || fail "a mid-run publication proposal was not refused"
[ "$(count_events run.refused)" = "1" ] || fail "the mid-run refusal left no durable record"
[ "$(count_events run.proposed)" = "0" ] || fail "a forbidden proposal was queued as a proposal"

# an ordinary ask is recorded and granted nothing
SELF attempt propose "$AT_PROP" --action analyze > /dev/null
[ "$(count_events run.proposed)" = "1" ] || fail "an allowed proposal was not put on record"

# ---------------------------------------------------------------------------
# The digest is an accurate, read-only fold over the log
# ---------------------------------------------------------------------------
# a failure and a capacity refusal, so the window under test has all five
# groups in it at once
WFAIL="$(SELF work add "a run whose prose claimed an artifact it never wrote" | tail -1)"
SELF work start "$WFAIL" > /dev/null
plan "$ROOT/plan-fail.json" "work=$WFAIL" "mode=prose" "dest=$ROOT/dest/fail.md" "maxRuns=1"
SELF attempt run "$ROOT/plan-fail.json" > /dev/null 2>&1 || true

WCAPACITY="$(SELF work add "a provider that answered not now" | tail -1)"
SELF work start "$WCAPACITY" > /dev/null
plan "$ROOT/plan-capacity.json" "work=$WCAPACITY" "mode=capacity" "dest=$ROOT/dest/capacity.md" \
    "maxRuns=1" "provider=http://localhost:1/" "providerName=busy-provider"
SELF attempt run "$ROOT/plan-capacity.json" > /dev/null 2>&1 || true

# a unit tried twice, which is what retried means: a run is retried by being
# dispatched again under a new attempt id
WRETRY="$(SELF work add "a unit tried more than once in this window" | tail -1)"
SELF work start "$WRETRY" > /dev/null
plan "$ROOT/plan-retry.json" "work=$WRETRY" "mode=prose" "dest=$ROOT/dest/retry.md" "maxRuns=1"
SELF attempt run "$ROOT/plan-retry.json" > /dev/null 2>&1 || true
SELF attempt run "$ROOT/plan-retry.json" > /dev/null 2>&1 || true

DIGEST="$ROOT/digest.json"
SELF digest --hours 24 --json > "$DIGEST"

group_lines()
{
    node -e '
const digest = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const group = digest.groups.find((entry) => entry.label === process.argv[2]);
process.stdout.write(group === undefined ? "" : group.lines.join("\n"));
' "$DIGEST" "$1"
}

group_lines Completed | grep -q "$WWAKE" || fail "the digest did not group the completed run"
group_lines Failed | grep -q "$WFAIL" || fail "the digest did not group the failed run"
group_lines Failed | grep -q "validation" || fail "the digest did not carry the failure class it read off the log"
group_lines Retried | grep -q "$WRETRY" || fail "the digest did not group the unit that was tried twice"
group_lines "Waiting on approval" | grep -q "$WAPP" || fail "the digest did not group the unit waiting on a person"
group_lines "Waiting on approval" | grep -q "$AT_PROP" || fail "the digest did not carry the refused mid-run proposal"
group_lines "Waiting on capacity" | grep -q "$WCAPACITY" || fail "the digest did not group the capacity refusal"
group_lines "Waiting on capacity" | grep -q "busy-provider" || fail "the capacity group did not name the provider that refused"
group_lines Failed | grep -q "$WCAPACITY" && fail "a provider that answered not now was also counted as a failure"

# the groups are in the order the account is read in
node -e '
const digest = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const order = ["Completed", "Failed", "Retried", "Waiting on approval", "Waiting on capacity"];
const seen = digest.groups.map((entry) => entry.label);
const expected = order.filter((label) => seen.includes(label));
process.exit(JSON.stringify(seen) === JSON.stringify(expected) ? 0 : 1);
' "$DIGEST" || fail "the digest groups are not in the order the contract fixes"

# cost is unknown, not zero: no provider in this product reports one, and a
# night whose spending nobody can see must never read as free
node -e '
const digest = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
process.exit(digest.cost.usd === null && digest.cost.tokens === null && digest.cost.unpriced > 0 ? 0 : 1);
' "$DIGEST" || fail "cost and token fields were fabricated where no provider reported them"
SELF digest --hours 24 | grep -q "cost unknown, tokens unknown" || fail "the rendered digest did not say the cost is unknown"

# reading it writes nothing at all
BEFORE="$(wc -l < "$LOG")"
HEAD_BEFORE="$(git -C "$STORE" rev-parse HEAD)"
SELF digest --hours 24 > /dev/null
SELF digest --json > /dev/null
[ "$(wc -l < "$LOG")" = "$BEFORE" ] || fail "running the digest recorded an event"
[ "$(git -C "$STORE" rev-parse HEAD)" = "$HEAD_BEFORE" ] || fail "running the digest committed to the store"

# the window is exactly the one asked for: a window that starts after
# everything that happened accounts for no run at all — while what is still
# waiting on a person is reported whatever window is asked for, because a unit
# nobody answered all night has no events inside one
EMPTY="$(SELF digest --since "$(node -e 'process.stdout.write(new Date(Date.now() + 60000).toISOString())')" 2>&1)"
echo "$EMPTY" | grep -q "nothing ran in this window" || fail "a window after everything that happened still reported runs"
echo "$EMPTY" | grep -q "$WFAIL" && fail "a window after a failed run still carried it"
echo "$EMPTY" | grep -q "$WAPP" || fail "a window that accounts for no run dropped the unit still waiting on a person"

# ---------------------------------------------------------------------------
# Nothing in the digest could carry a machine off this one
# ---------------------------------------------------------------------------
# The guard runs before a byte reaches the log, so every line the digest prints
# came from a payload that already crossed it. This is that statement made
# checkable: each rendered line is offered back to the guard as a payload, and
# a line the guard would refuse is a line the digest must never have printed.
SELF digest --hours 24 > "$ROOT/digest.txt"
node -e '
const { readFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const guard = pathToFileURL(process.argv[1]).href;
import(guard).then(({ assertSanitized }) =>
{
    const lines = readFileSync(process.argv[2], "utf8").split("\n").filter((line) => line.trim() !== "");
    for (const line of lines)
    {
        assertSanitized({
            id: "01", ts: new Date().toISOString(), type: "digest.line",
            origin: { actor: "agent", confirmed: false }, project: "demo", payload: { text: line }
        });
    }
    process.stdout.write(String(lines.length));
}).catch((error) => { process.stderr.write(String(error.message)); process.exit(1); });
' "$CLI_DIR/dist/sanitize.js" "$ROOT/digest.txt" > "$ROOT/checked" || fail "a digest line would be refused by the sanitization guard"
[ "$(cat "$ROOT/checked")" -gt 5 ] || fail "the sanitization check ran against an empty digest"

grep -q "$HOME" "$ROOT/digest.txt" && fail "the digest printed a path under this machine's home directory"
grep -qi "supervised design complete" "$ROOT/digest.txt" && fail "the digest carried an agent's own prose"
grep -q "$RUNNER" "$ROOT/digest.txt" && fail "the digest named a machine-local spool"

# ---------------------------------------------------------------------------
# The policy is granted by a person, and never from inside an attempt
# ---------------------------------------------------------------------------
# The verb that authorizes unattended spending is the one an agent must not be
# able to reach: a policy an attempt could write is a policy that bounds
# nothing, and the widest one in this file would be one command away from
# every run the supervisor starts.
GRANTS="$(count_events overnight.set)"
policy_version()
{
    SELF overnight show --json | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).version))'
}
IN_FORCE="$(policy_version)"

PIPED="$(SELF overnight set --from 00:00 --to 00:00 --auto-dispatch --risk privileged --max-concurrent 16 < /dev/null 2>&1 || true)"
one_line "$PIPED"
echo "$PIPED" | grep -q "human_gate_unavailable" || fail "a policy was granted to a process with no terminal"

# the marker the runner stamps on every child, either one of them
for marker in SUPERSELF_SESSION SUPERSELF_ATTEMPT_ID
do
    MARKED="$(env "$marker=at-evil" node "$SELF_JS" overnight set --auto-dispatch --risk privileged --max-concurrent 16 2>&1 || true)"
    one_line "$MARKED"
    echo "$MARKED" | grep -q "cannot be set from an agent attempt" || fail "$marker did not refuse a policy set from inside an attempt"
    echo "$MARKED" | grep -q "$marker" || fail "the refusal did not name the marker it read"
done

# revoking is refused the same way — an attempt does not change the document it
# runs under, in either direction
REVOKED="$(env SUPERSELF_ATTEMPT_ID=at-evil node "$SELF_JS" overnight off 2>&1 || true)"
one_line "$REVOKED"
echo "$REVOKED" | grep -q "cannot be revoked from an agent attempt" || fail "an attempt revoked the policy that governs it"

# and a terminal alone is not enough: what is typed has to be the window being
# granted, so a person states what they are authorizing rather than that they
# authorize something
pty_self "not-the-window" overnight set --from 00:00 --to 00:00 --auto-dispatch --risk privileged --max-concurrent 16

[ "$(count_events overnight.set)" = "$GRANTS" ] || fail "a refused grant still recorded a policy"
[ "$(policy_version)" = "$IN_FORCE" ] || fail "the policy in force changed under refused grants"
SELF overnight show | grep -q "concurrency   at most 16" && fail "a refused grant widened the policy in force"

# ---------------------------------------------------------------------------
# The verbs are parse-guarded and documented like every other verb
# ---------------------------------------------------------------------------
BEFORE="$(wc -l < "$LOG")"
for bad in "overnight set --nonsense" "overnight show --nonsense" "digest --nonsense"
do
    OUT="$(SELF $bad 2>&1 || true)"
    one_line "$OUT"
    echo "$OUT" | grep -q -- "--help" || fail "\`$bad\` did not point a bad flag at its own help"
done
BADTIME="$(SELF overnight set --from 25:00 2>&1 || true)"
one_line "$BADTIME"
echo "$BADTIME" | grep -q "24-hour local time" || fail "an impossible window time was not refused"
BADRISK="$(SELF overnight set --risk reckless 2>&1 || true)"
one_line "$BADRISK"
echo "$BADRISK" | grep -q "is not a risk class" || fail "an unrecognised risk class was accepted into a policy"
BADSINCE="$(SELF digest --since yesterday 2>&1 || true)"
one_line "$BADSINCE"
echo "$BADSINCE" | grep -q "expects a timestamp" || fail "a digest window that is not a timestamp was accepted"
[ "$(wc -l < "$LOG")" = "$BEFORE" ] || fail "a refused flag still wrote an event"

SELF overnight --help | grep -q "overnight set" || fail "the overnight verb is missing from the scoped help"
SELF digest --help | grep -q "digest \[--since" || fail "the digest verb is missing from the scoped help"
SELF attempt --help | grep -q "attempt propose <id> --action" || fail "the propose verb is missing from the scoped help"
SELF | grep -q "overnight set" || fail "the overnight verb is missing from the root verb list"
SELF | grep -q "^  digest" || fail "the digest verb is missing from the root verb list"

# every new event type is in the log, having crossed the guard on the way
for type in overnight.set overnight.revoked run.refused run.proposed
do
    [ "$(count_events "$type")" -ge 1 ] || fail "no $type event ever crossed the sanitization guard"
done

# and a policy that would carry this machine's home path into the synced log is
# refused, costing only the command
BEFORE="$(wc -l < "$LOG")"
LEAK="$(SELF attempt propose "$AT_PROP" --action "read $HOME/notes.md" 2>&1 || true)"
one_line "$LEAK"
echo "$LEAK" | grep -q "absolute path under this machine's home directory" || fail "a proposal carried a home path into the synced log"
[ "$(wc -l < "$LOG")" = "$BEFORE" ] || fail "a refused proposal still wrote an event"

echo "overnight policy and digest proof OK"
