#!/usr/bin/env bash
# The supervision loop: reconcile, settle, release, wake. Every case here is a
# statement about what one tick does to state that is already on disk, so the
# whole section runs against `self daemon tick` in the foreground — the loop is
# that same tick on a timer, and it is proven once, where starting and stopping
# it is what is under test.
#
# This builds its own machine root, like the integration proof does: the cases
# kill payloads, crash launchers mid-settlement, and start a daemon, and none
# of that may reach the machine the proof is run on.
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

# Nothing this section starts may outlive it: a supervisor left running would
# keep reconciling a workspace that is about to be deleted.
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

cd "$ROOT/A/ws"
SELF init --agents > /dev/null
cd "$ROOT/A/ws/demo"
git init -q
SELF project add --name demo --desc "supervision loop harness" > /dev/null
SELF goal set "prove the supervision loop" > /dev/null

STORE="$ROOT/A/ws/.superself"
LOG_A="$STORE/projects/demo/log.jsonl"
DEMO="$ROOT/A/ws/demo"
RUNNER="$ROOT/A/state/superself/runner"

spool_of()
{
    echo "$RUNNER/attempts/$1"
}
count_events()
{
    grep -c "\"type\":\"$1\"" "$LOG_A" || true
}
# Events of one type about one attempt. Counted by the fields rather than by a
# substring: every event an attempt records carries its id, so a grep for the
# id alone would count the start as a report.
count_for()
{
    node -e '
const fs = require("node:fs");
const [file, type, attempt] = process.argv.slice(1);
const events = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
process.stdout.write(String(events.filter((e) => e.type === type && (e.refs?.attempt === attempt || e.payload?.attempt === attempt)).length));
' "$LOG_A" "$1" "$2"
}
attempt_state()
{
    SELF attempt show "$1" | sed -n 's/^state *//p' | awk '{print $1}'
}
exit_record()
{
    SELF attempt show "$1" | sed -n 's/^exit *//p'
}
# Attempt ids only: with no match the listing prints the sentence that says so,
# and a case counting lines would count that.
attempts_of()
{
    SELF attempt list --work "$1" | awk '$1 ~ /^at-/ {print $1}'
}
count_attempts()
{
    attempts_of "$1" | grep -c . || true
}
# The summary, which the tick prints on its own last line: settling runs the
# completion gate, and the gate reports what it published exactly as it does
# when a person runs it.
tick_json()
{
    SELF daemon tick --json | tail -1
}
# One field out of the tick summary, so a case says what it expects rather than
# grepping a line whose wording is not the contract.
tick_count()
{
    node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(s[process.argv[1]]))' "$1"
}
# Whether every dispatch this machine issued for a spec has finished. A wake
# hands the run to a detached process and the supervisor holds the unit until
# that process is done, so a case asking what the next tick decides has to wait
# for the last one to be over first.
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
wake_outcome()
{
    node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));const w=s.wakes.find(w=>w.workSpec===process.argv[1]);process.stdout.write(w===undefined?"none":w.outcome)' "$1"
}
# Waits for state the supervisor put in motion. A dispatch the tick issued runs
# detached by design, so a case that asserted immediately would be asserting
# about the spawn rather than about the run.
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

# One field off the daemon's own record of its last tick. `status` reads this
# rather than the log, and a case about a tick that failed asks it the same way
# a person would.
tick_field()
{
    SELF daemon status --json | node -e '
const s = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
process.stdout.write(String(s.tick?.[process.argv[1]] ?? ""));
' "$1"
}
daemon_pid()
{
    SELF daemon status --json | node -e '
const s = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
process.stdout.write(String(s.daemon?.pid ?? ""));
'
}
# A wake in flight, written by hand: the record names a process, and these
# cases are about what happens when the process it names is not the dispatch.
# The generation is read off the spec HEAD so the record claims the one the
# tick is deciding about.
write_wake()
{
    node -e '
const fs = require("node:fs");
const [file, head, workSpec, work, child, startedAt] = process.argv.slice(1);
const generation = JSON.parse(fs.readFileSync(head, "utf8")).generation;
let kept = [];
try { kept = JSON.parse(fs.readFileSync(file, "utf8")).filter((wake) => wake.workSpec !== workSpec); } catch { kept = []; }
const wake = { workSpec, work, generation, at: new Date().toISOString(), child: Number(child), childStartedAt: startedAt === "" ? null : startedAt };
fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify([...kept, wake], null, 2));
' "$RUNNER/daemon/wakes.json" "$STORE/projects/demo/specs/$1/head.json" "$1" "$2" "$3" "$4"
}
# The spool's own clock, moved back. Machine-local runner state, aged the same
# way the stale-heartbeat case ages a beat: the case is about what an old
# refusal means, not about how long it takes to become one.
age_status()
{
    node -e '
const fs = require("node:fs");
const file = process.argv[1];
const status = JSON.parse(fs.readFileSync(file, "utf8"));
status.updated = new Date(Date.now() - Number(process.argv[2])).toISOString();
fs.writeFileSync(file, JSON.stringify(status, null, 2));
' "$(spool_of "$1")/status.json" "$2"
}
breaker_retry()
{
    node -e '
const fs = require("node:fs");
const [dir, provider] = process.argv.slice(1);
let armed = false;
for (const name of fs.readdirSync(dir))
{
    const record = JSON.parse(fs.readFileSync(`${dir}/${name}`, "utf8"));
    armed = armed || (record.provider === provider && record.retryAt !== undefined);
}
process.stdout.write(armed ? "armed" : "none");
' "$RUNNER/breakers" "$1"
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

# ---------------------------------------------------------------------------
# The tick wakes approved ready work, and only that
# ---------------------------------------------------------------------------
WWAKE="$(SELF work add "the supervisor dispatches this work unit without a chat turn" | tail -1)"
SELF work start "$WWAKE" > /dev/null
workspec "$ROOT/ws-wake.json" "id=ws-wake" "work=$WWAKE" "dest=$ROOT/dest/wake.md" "providerName=wake-provider"
SELF spec apply "$ROOT/ws-wake.json" > /dev/null

WHOLD="$(SELF work add "work waiting on a decision is never dispatched for the person" | tail -1)"
SELF work start "$WHOLD" > /dev/null
workspec "$ROOT/ws-hold.json" "id=ws-hold" "work=$WHOLD" "dest=$ROOT/dest/hold.md" "providerName=hold-provider"
SELF spec apply "$ROOT/ws-hold.json" > /dev/null
SELF work block "$WHOLD" --on decision --why "the operator has not approved this run" > /dev/null

TICK1="$(tick_json)"
[ "$(echo "$TICK1" | wake_outcome ws-wake)" = "woken" ] || fail "the first tick did not wake ready approved work"
[ "$(echo "$TICK1" | wake_outcome ws-hold)" = "awaiting-approval" ] || fail "work blocked on a decision was not held back as awaiting approval"
[ "$(echo "$TICK1" | tick_count woken)" = "1" ] || fail "the tick woke more than the one ready work unit"
[ "$(count_events run.woken)" = "1" ] || fail "the wake left no durable record"
[ "$(count_events spec.dispatched)" = "1" ] || fail "the wake did not go through the spec dispatch path"
[ -z "$(attempts_of "$WHOLD")" ] || fail "work awaiting approval materialized an attempt"

# the same tick again, immediately: a supervision pass is a function of state
# that is already durable, so the second one has nothing left to do
TICK2="$(tick_json)"
[ "$(echo "$TICK2" | tick_count woken)" = "0" ] || fail "a second tick dispatched the same generation again"
[ "$(count_events spec.dispatched)" = "1" ] || fail "a second tick spent a second dispatch on one generation"

# the dispatched run settles itself, with nothing watching it: the supervisor
# scheduled it and the runner owned the gate, exactly as when a person types it
await '[ -f "$ROOT/dest/wake.md" ]' || fail "the woken dispatch never published its artifact"
await '[ "$(attempt_state "$(attempts_of "$WWAKE" | tail -1)")" = "completed" ]' || fail "the woken attempt never reached completed"
AT_WAKE="$(attempts_of "$WWAKE" | tail -1)"
[ "$(count_for report.added "$AT_WAKE")" = "1" ] || fail "the woken attempt attached no report to the work unit"

# and the generation stays materialized afterwards
[ "$(tick_json | tick_count woken)" = "0" ] || fail "a completed generation was dispatched a second time"

# unblocking is what makes the held work ready, and the very next tick takes it
SELF work unblock "$WHOLD" > /dev/null
[ "$(tick_json | wake_outcome ws-hold)" = "woken" ] || fail "unblocked work was not woken by the next tick"
await '[ "$(attempt_state "$(attempts_of "$WHOLD" | tail -1)")" = "completed" ]' || fail "the unblocked attempt never completed"
await 'wake_settled ws-hold' || fail "the unblocked dispatch never finished"

# ---------------------------------------------------------------------------
# A confirmed exit whose settlement never finished
# ---------------------------------------------------------------------------
# The launcher reports the exit, the gate publishes the artifact, and the
# launcher dies while the declared validation is still running. Nothing is at a
# terminal; the report exists nowhere; the artifact is at its destination with
# no record that anyone verified it.
WSETTLE="$(SELF work add "a tick settles an exit whose gate never finished" | tail -1)"
SELF work start "$WSETTLE" > /dev/null
plan "$ROOT/plan-settle.json" "work=$WSETTLE" "dest=$ROOT/dest/settle.md" "validate=$VALIDATE" "gate=$ROOT/release-validate" "orphanfile=$ROOT/settle-orphan"
AT_SETTLE="$(SELF attempt register "$ROOT/plan-settle.json" | tail -1)"
node "$LAUNCH" "$SELF_JS" "$AT_SETTLE" "$(spool_of "$AT_SETTLE")" "$DEMO" --crash-in-settlement "--after-publish=$ROOT/dest/settle.md"

[ "$(attempt_state "$AT_SETTLE")" = "running" ] || fail "the crashed settlement did not leave the attempt mid-flight"
echo "$(exit_record "$AT_SETTLE")" | grep -q "^confirmed" || fail "the exit the launcher reported was not kept as confirmed"
[ -f "$(spool_of "$AT_SETTLE")/published.json" ] && fail "the crashed settlement recorded a publication it never finished"
[ "$(count_for report.added "$AT_SETTLE")" = "0" ] || fail "the crashed settlement attached a report"

# the validation the crash interrupted is released, and one tick finishes the
# whole gate from the attempt's own spool
touch "$ROOT/release-validate"
SETTLED="$(tick_json)"
[ "$(echo "$SETTLED" | tick_count settled)" = "1" ] || fail "the tick did not settle the confirmed exit"
[ "$(attempt_state "$AT_SETTLE")" = "completed" ] || fail "the settled attempt did not reach completed"
[ -f "$ROOT/dest/settle.md" ] || fail "the settled attempt has no published artifact"
[ "$(count_for report.added "$AT_SETTLE")" = "1" ] || fail "the tick settled without attaching the report"
[ "$(count_events run.released)" -ge 1 ] || fail "settlement recorded no release of the work unit"

# ---------------------------------------------------------------------------
# Exactly once, however many times the same exit is observed
# ---------------------------------------------------------------------------

tick_json > /dev/null
SELF attempt exited "$AT_SETTLE" --code 0 > /dev/null 2>&1 && fail "an exit was accepted a second time on a settled attempt"
SELF attempt settle "$AT_SETTLE" | grep -q "already attached" || fail "settling again did not find the report already attached"
tick_json > /dev/null
[ "$(count_for report.added "$AT_SETTLE")" = "1" ] || fail "a duplicate exit observation attached a second report"
[ "$(count_for run.completed "$AT_SETTLE")" = "1" ] || fail "a duplicate exit observation recorded a second completion"

# ---------------------------------------------------------------------------
# A tick never takes a settlement in flight away from the settler running it
# ---------------------------------------------------------------------------
# The moment the exit is on record and the payload's group is empty, everything
# a supervisor can observe says this attempt's settlement died — and the
# launcher is inside the completion gate, publishing and validating. A tick
# landing there must leave it alone: minting a newer fence over a live gate
# fences out the one process that was finishing the run properly, and `attempt
# exited`, the documented settlement verb, then fails for a run that completed.
WRACE="$(SELF work add "a supervision pass leaves a settlement in flight to finish" | tail -1)"
SELF work start "$WRACE" > /dev/null
plan "$ROOT/plan-race.json" "work=$WRACE" "dest=$ROOT/dest/race.md" "validate=$VALIDATE" "gate=$ROOT/release-race"
AT_RACE="$(SELF attempt register "$ROOT/plan-race.json" | tail -1)"
node "$LAUNCH" "$SELF_JS" "$AT_RACE" "$(spool_of "$AT_RACE")" "$DEMO" > "$ROOT/race-launcher.log" 2>&1 &
RACE_LAUNCH=$!

# the launcher's gate has published and is inside the declared validation this
# case holds open: the settlement is demonstrably still running
await '[ -f "$ROOT/dest/race.md" ]' || fail "the launcher's gate never published its artifact"

RACED="$(tick_json)"
[ "$(echo "$RACED" | tick_count settled)" = "0" ] || fail "a tick settled an attempt whose gate was still running"
[ "$(echo "$RACED" | tick_count held)" -ge 1 ] || fail "a tick did not hold off the settlement in flight"
echo "$RACED" | grep -q "already in flight" || fail "the tick did not say why it left the attempt alone"
[ "$(count_for report.added "$AT_RACE")" = "0" ] || fail "a tick attached a report while the launcher was still in the gate"

# released, the launcher finishes its own settlement and reports success for it
touch "$ROOT/release-race"
wait "$RACE_LAUNCH" || fail "the launcher's own \`attempt exited\` failed for a run that completed"
[ "$(attempt_state "$AT_RACE")" = "completed" ] || fail "the launcher's settlement did not reach completed"
[ "$(count_for report.added "$AT_RACE")" = "1" ] || fail "the finished settlement did not attach exactly one report"
[ "$(count_for run.completed "$AT_RACE")" = "1" ] || fail "the finished settlement recorded more than one completion"
tick_json > /dev/null
[ "$(count_for report.added "$AT_RACE")" = "1" ] || fail "a tick after the settlement attached a second report"

# ---------------------------------------------------------------------------
# Two settlers of one crashed settlement, at the same time
# ---------------------------------------------------------------------------
# A report cannot be taken back out of an append-only synced log, so the read
# that finds one already there and the append that would add a second have to
# be one step. Two ticks are run against the same crashed settlement at once —
# the pair the loop and a hand-run `daemon tick` make every day.
WRACE2="$(SELF work add "two supervisors settling one exit attach one report" | tail -1)"
SELF work start "$WRACE2" > /dev/null
plan "$ROOT/plan-race2.json" "work=$WRACE2" "dest=$ROOT/dest/race2.md" "orphanfile=$ROOT/race2-orphan"
AT_RACE2="$(SELF attempt register "$ROOT/plan-race2.json" | tail -1)"
node "$LAUNCH" "$SELF_JS" "$AT_RACE2" "$(spool_of "$AT_RACE2")" "$DEMO" --crash-in-settlement
kill -9 "$(cat "$ROOT/race2-orphan")" 2>/dev/null || true
await '! kill -0 "$(cat "$ROOT/race2-orphan")" 2>/dev/null' || fail "the raced payload group never emptied"
[ "$(attempt_state "$AT_RACE2")" = "running" ] || fail "the raced case did not leave a settlement in flight"

SELF daemon tick > "$ROOT/race2-a.log" 2>&1 &
RACE_A=$!
SELF daemon tick > "$ROOT/race2-b.log" 2>&1 &
RACE_B=$!
wait "$RACE_A" || fail "a tick racing another for one settlement exited non-zero"
wait "$RACE_B" || fail "a tick racing another for one settlement exited non-zero"

[ "$(attempt_state "$AT_RACE2")" = "completed" ] || fail "two concurrent ticks did not settle the crashed settlement"
[ -f "$ROOT/dest/race2.md" ] || fail "the raced settlement published no artifact"
[ "$(count_for report.added "$AT_RACE2")" = "1" ] || fail "two concurrent settlers attached two reports"
[ "$(count_for run.completed "$AT_RACE2")" = "1" ] || fail "two concurrent settlers recorded two completions"

# ---------------------------------------------------------------------------
# Prose is not a result
# ---------------------------------------------------------------------------
# The same crash-in-settlement path, with an agent that says it wrote the
# document and did not. What the tick has is a confirmed exit and a completed
# envelope, and neither is evidence that the declared file exists.
WPROSE="$(SELF work add "completion prose without the declared artifact settles nothing" | tail -1)"
SELF work start "$WPROSE" > /dev/null
plan "$ROOT/plan-prose.json" "work=$WPROSE" "dest=$ROOT/dest/prose.md" "mode=prose" "orphanfile=$ROOT/prose-orphan"
AT_PROSE="$(SELF attempt register "$ROOT/plan-prose.json" | tail -1)"
node "$LAUNCH" "$SELF_JS" "$AT_PROSE" "$(spool_of "$AT_PROSE")" "$DEMO" --crash-in-settlement
# The process the payload left in its group is what the crashed settlement was
# containing; ending it is what makes the launch over, and the exit it reported
# the only thing left on the record.
kill -9 "$(cat "$ROOT/prose-orphan")" 2>/dev/null || true
await '! kill -0 "$(cat "$ROOT/prose-orphan")" 2>/dev/null' || fail "the prose payload group never emptied"
[ "$(attempt_state "$AT_PROSE")" = "running" ] || fail "the prose case did not leave a settlement in flight"
echo "$(exit_record "$AT_PROSE")" | grep -q "^confirmed" || fail "the prose case has no confirmed exit to judge"

PROSED="$(tick_json)"
[ "$(echo "$PROSED" | tick_count settled)" = "0" ] || fail "prose without a declared artifact settled as completed"
[ "$(attempt_state "$AT_PROSE")" = "failed" ] || fail "prose without a declared artifact did not fail the gate"
SELF attempt show "$AT_PROSE" | grep -q "validation" || fail "the prose failure was not typed as a validation failure"
[ -f "$ROOT/dest/prose.md" ] && fail "a claimed artifact nobody wrote was published"
[ "$(count_for report.added "$AT_PROSE")" = "0" ] || fail "prose attached a report to the work unit"

# ---------------------------------------------------------------------------
# A process that vanished releases its lease and keeps its spool
# ---------------------------------------------------------------------------
WLEASE="$(SELF work add "a failed process releases its lease and keeps what it wrote" | tail -1)"
SELF work start "$WLEASE" > /dev/null
plan "$ROOT/plan-lease.json" "work=$WLEASE" "mode=idle" "runTimeoutMs=60000"
AT_LEASE="$(SELF attempt register "$ROOT/plan-lease.json" | tail -1)"
node "$CLI_DIR/proof/external-launch.mjs" "$SELF_JS" "$AT_LEASE" "$(spool_of "$AT_LEASE")" "$DEMO" --abandon "--pidfile=$ROOT/lease.pid"
LEASE_PID="$(cat "$ROOT/lease.pid")"
[ "$(attempt_state "$AT_LEASE")" = "running" ] || fail "the abandoned launch is not running"

# the work unit is held while the process is: a live attempt is a live claim,
# and nothing else may be driven against the unit while it stands
[ "$(tick_json | tick_count live)" -ge 1 ] || fail "the tick did not see the abandoned attempt as live"
HELD="$(SELF attempt run "$ROOT/plan-lease.json" 2>&1 || true)"
echo "$HELD" | grep -q "already being driven" || fail "the live attempt did not hold its work unit"

kill -9 "$LEASE_PID" 2>/dev/null || true
await "! kill -0 $LEASE_PID 2>/dev/null" || fail "the abandoned payload never died"

LEASED="$(tick_json)"
[ "$(echo "$LEASED" | tick_count unreconciled)" -ge 1 ] || fail "the tick did not reconcile the vanished process"
[ "$(attempt_state "$AT_LEASE")" = "exited-unreconciled" ] || fail "a vanished process was not left exited-unreconciled"
echo "$(exit_record "$AT_LEASE")" | grep -q "^vanished" || fail "a process nobody watched exit was not recorded as vanished"
[ -f "$(spool_of "$AT_LEASE")/brief.md" ] || fail "reconciling a vanished attempt destroyed its spool"
[ -f "$(spool_of "$AT_LEASE")/plan.json" ] || fail "reconciling a vanished attempt destroyed its plan"
grep -q "\"type\":\"run.released\"" "$LOG_A" || fail "no release was recorded for the freed work unit"

# and the lease it held is gone: the same work unit takes a new attempt
plan "$ROOT/plan-lease2.json" "work=$WLEASE" "mode=ok" "dest=$ROOT/dest/lease.md"
SELF attempt run "$ROOT/plan-lease2.json" > /dev/null
[ -f "$ROOT/dest/lease.md" ] || fail "the freed work unit could not be driven again"

# ---------------------------------------------------------------------------
# A stale heartbeat is not a confirmed exit
# ---------------------------------------------------------------------------
# The owner is still there and has stopped saying so. That is a different
# statement from an exit somebody watched, and the record has to keep them
# apart: only one of the two says anything about what the run produced.
WSTALE="$(SELF work add "a heartbeat that went quiet is told apart from a reported exit" | tail -1)"
SELF work start "$WSTALE" > /dev/null
plan "$ROOT/plan-stale.json" "work=$WSTALE" "mode=idle" "runTimeoutMs=60000"
AT_STALE="$(SELF attempt register "$ROOT/plan-stale.json" | tail -1)"
node "$CLI_DIR/proof/external-launch.mjs" "$SELF_JS" "$AT_STALE" "$(spool_of "$AT_STALE")" "$DEMO" --abandon "--pidfile=$ROOT/stale.pid"
STALE_PID="$(cat "$ROOT/stale.pid")"
kill -0 "$STALE_PID" 2>/dev/null || fail "the stale case needs its owner still running"

# the beat is aged rather than waited out: this is machine-local runner state,
# and the case is about what an old beat means, not about how long it takes
node -e 'const fs=require("fs");const f=process.argv[1];const b=JSON.parse(fs.readFileSync(f,"utf8"));b.ts=new Date(Date.now()-120000).toISOString();fs.writeFileSync(f,JSON.stringify(b))' "$(spool_of "$AT_STALE")/heartbeat.json"

tick_json > /dev/null
[ "$(attempt_state "$AT_STALE")" = "exited-unreconciled" ] || fail "an owner that went quiet was not reconciled"
echo "$(exit_record "$AT_STALE")" | grep -q "^stale" || fail "a stale heartbeat was not told apart from a confirmed exit"
echo "$(exit_record "$AT_STALE")" | grep -q "code" && fail "an unconfirmed exit carried an exit code nobody reported"
echo "$(exit_record "$AT_SETTLE")" | grep -q "^confirmed" || fail "the confirmed exit lost its source"
REFUSED="$(SELF attempt settle "$AT_STALE" 2>&1 || true)"
echo "$REFUSED" | grep -q "cannot be settled" || fail "a stale attempt was offered to the completion gate"
! kill -0 "$STALE_PID" 2>/dev/null || fail "the owner of a reconciled attempt was left running"

# ---------------------------------------------------------------------------
# Capacity: one reset buys one redispatch, and not before it arrives
# ---------------------------------------------------------------------------
WCAP="$(SELF work add "a provider that refused on capacity is asked again after its reset" | tail -1)"
SELF work start "$WCAP" > /dev/null
workspec "$ROOT/ws-cap.json" "id=ws-cap" "work=$WCAP" "mode=capacity" "providerName=cap-provider" "maxRuns=1"
SELF spec apply "$ROOT/ws-cap.json" > /dev/null

[ "$(tick_json | wake_outcome ws-cap)" = "woken" ] || fail "the capacity spec was never dispatched a first time"
await '[ "$(attempt_state "$(attempts_of "$WCAP" | tail -1)")" = "failed" ]' || fail "the capacity dispatch never failed"
AT_CAP1="$(attempts_of "$WCAP" | tail -1)"
SELF attempt show "$AT_CAP1" | grep -q "transient-provider" || fail "a provider limit was not typed as a transient provider failure"
await 'wake_settled ws-cap' || fail "the capacity dispatch never finished"

CAPTICK="$(tick_json)"
[ "$(echo "$CAPTICK" | wake_outcome ws-cap)" = "waiting-reset" ] || fail "a capacity refusal did not hold the redispatch back"
SELF daemon circuits --json | grep -q '"retryAt"' || fail "the capacity refusal recorded no retryAt on the breaker"
[ "$(tick_json | wake_outcome ws-cap)" = "waiting-reset" ] || fail "a tick before the reset redispatched anyway"
[ "$(count_attempts "$WCAP")" = "1" ] || fail "a redispatch was spent before the reset arrived"

# the reset arrives — the same machine-local record, aged
BREAKER="$(ls "$RUNNER"/breakers/*.json | head -20)"
node -e '
const fs = require("node:fs");
for (const file of process.argv.slice(1))
{
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.provider !== "cap-provider" || record.retryAt === undefined) continue;
    record.retryAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
}' $BREAKER

[ "$(tick_json | wake_outcome ws-cap)" = "woken" ] || fail "the redispatch never came after the reset"
await '[ "$(count_attempts "$WCAP")" = "2" ]' || fail "the redispatch materialized no second attempt"
await '[ "$(attempt_state "$(attempts_of "$WCAP" | tail -1)")" = "failed" ]' || fail "the redispatched attempt never finished"
await 'wake_settled ws-cap' || fail "the redispatch never finished"
# and the reset is spent: one refusal buys one redispatch, not a queue of them
tick_json > /dev/null
[ "$(tick_json | wake_outcome ws-cap)" = "waiting-reset" ] || fail "a spent reset admitted a second redispatch"

# ---------------------------------------------------------------------------
# A refusal older than the reset it would arm is not news
# ---------------------------------------------------------------------------
# Spools are kept for a month, and the first tick after a supervisor is
# installed reads all of them. A provider limit somebody was refused days ago
# says nothing about that provider now, and arming a fresh hold on it would
# stop today's dispatches for a refusal that was dealt with long ago.
WOLD="$(SELF work add "a capacity refusal from days ago does not hold today's dispatch back" | tail -1)"
SELF work start "$WOLD" > /dev/null
plan "$ROOT/plan-old.json" "work=$WOLD" "mode=capacity" "provider=http://localhost:1/" "providerName=old-provider" "maxRuns=1"
SELF attempt run "$ROOT/plan-old.json" > /dev/null 2>&1 || true
AT_OLD="$(attempts_of "$WOLD" | tail -1)"
SELF attempt show "$AT_OLD" | grep -q "transient-provider" || fail "the aged case recorded no provider refusal to age"
age_status "$AT_OLD" 3600000

tick_json > /dev/null
[ -f "$(spool_of "$AT_OLD")/capacity.json" ] && fail "a refusal older than the cooldown armed a fresh reset"
[ "$(breaker_retry old-provider)" = "none" ] || fail "an old refusal put a retryAt on a provider nothing had asked about"

# ---------------------------------------------------------------------------
# Three transient failures open the circuit and stop fan-out
# ---------------------------------------------------------------------------
# The desired state comes first and is left untouched: a circuit is listed for
# the providers this project's specs name, and nothing dispatches until a tick
# runs, so the spec can wait there while the provider is driven down.
WFAN2="$(SELF work add "no dispatch reaches a provider whose circuit is open" | tail -1)"
SELF work start "$WFAN2" > /dev/null
workspec "$ROOT/ws-fan.json" "id=ws-fan" "work=$WFAN2" "dest=$ROOT/dest/fan.md" "providerName=fan-provider"
SELF spec apply "$ROOT/ws-fan.json" > /dev/null

WFAN="$(SELF work add "an open circuit stops the supervisor fanning out to that provider" | tail -1)"
SELF work start "$WFAN" > /dev/null
plan "$ROOT/plan-fan.json" "work=$WFAN" "mode=capacity" "provider=http://localhost:1/" "providerName=fan-provider" "maxRuns=1"
for _ in 1 2 3
do
    SELF attempt run "$ROOT/plan-fan.json" > /dev/null 2>&1 || true
done
SELF daemon circuits | grep -q "fan-provider  open" || fail "three consecutive transient failures did not open the circuit"

FANNED="$(tick_json)"
[ "$(echo "$FANNED" | wake_outcome ws-fan)" = "circuit-open" ] || fail "an open circuit did not stop the fan-out"
[ "$(echo "$FANNED" | tick_count deferred)" -ge 1 ] || fail "the deferred dispatch was not counted"
[ -z "$(attempts_of "$WFAN2")" ] || fail "an open circuit still spent an attempt"
[ -f "$ROOT/dest/fan.md" ] && fail "an open circuit still produced an artifact"

# a success closes it again, and the same spec is then taken
SELF attempt breaker fan-provider --reset > /dev/null
[ "$(tick_json | wake_outcome ws-fan)" = "woken" ] || fail "a closed circuit did not resume the fan-out"
await '[ -f "$ROOT/dest/fan.md" ]' || fail "the resumed dispatch never ran"
await 'wake_settled ws-fan' || fail "the resumed dispatch never finished"

# ---------------------------------------------------------------------------
# The loop: one supervisor per machine, and a crash that leaves nothing behind
# ---------------------------------------------------------------------------
SELF daemon status | grep -q "no self daemon is running" || fail "status claimed a daemon before one was started"
SELF daemon start --interval 300 | grep -q "supervising demo" || fail "the daemon did not start"
DPID="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).daemon.pid))' <(SELF daemon status --json))"
await "kill -0 $DPID 2>/dev/null" || fail "the started daemon is not running"
SELF daemon status | grep -q "running   process $DPID" || fail "status does not report the running supervisor"
SECOND="$(SELF daemon start 2>&1 || true)"
echo "$SECOND" | grep -q "already running on this machine as process $DPID" || fail "a second daemon was allowed to start"

# it ticks on its own, with nobody at a terminal
await '[ "$(node -e "process.stdout.write(String(JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")).tick.ticks))" < <(SELF daemon status --json))" -ge 2 ]' \
    || fail "the running daemon never ticked on its own"

# a crash: the record it left is not a running daemon, and does not block one
kill -9 "$DPID"
await "! kill -0 $DPID 2>/dev/null" || fail "the daemon survived being killed"
SELF daemon status | grep -q "left a record behind" || fail "status read a dead daemon's record as a running one"

# whatever was registered and running before the crash is still the supervisor's
# to reconcile after it: liveness is read off the process table, not off a
# handover the crash never got to write
WCRASH="$(SELF work add "a restarted supervisor reconciles what the crash left running" | tail -1)"
SELF work start "$WCRASH" > /dev/null
plan "$ROOT/plan-crash.json" "work=$WCRASH" "mode=idle" "runTimeoutMs=60000"
AT_CRASH="$(SELF attempt register "$ROOT/plan-crash.json" | tail -1)"
node "$CLI_DIR/proof/external-launch.mjs" "$SELF_JS" "$AT_CRASH" "$(spool_of "$AT_CRASH")" "$DEMO" --abandon "--pidfile=$ROOT/crash.pid"
CRASH_PID="$(cat "$ROOT/crash.pid")"

SELF daemon start --interval 300 | grep -q "supervising demo" || fail "a daemon could not be started after a crash"
DPID2="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).daemon.pid))' <(SELF daemon status --json))"
[ "$DPID2" != "$DPID" ] || fail "the restarted daemon reused the crashed record"
await '[ "$(attempt_state "$AT_CRASH")" = "running" ]' 3 || fail "the restarted supervisor killed an attempt that was still live"
kill -9 "$CRASH_PID" 2>/dev/null || true
await '[ "$(attempt_state "$AT_CRASH")" = "exited-unreconciled" ]' || fail "the restarted supervisor never reconciled the dead attempt"

SELF daemon stop | grep -q "stopped" || fail "the daemon did not stop"
await "! kill -0 $DPID2 2>/dev/null" || fail "the stopped daemon is still running"
SELF daemon status | grep -q "no self daemon is running" || fail "status still reports a daemon after it stopped"
SELF daemon stop | grep -q "no self daemon is running" || fail "stopping twice was not answered plainly"

# ---------------------------------------------------------------------------
# A dispatch in flight is a process, not a number
# ---------------------------------------------------------------------------
# A wake record holds a generation back while the dispatch it names is still
# running. A pid is handed out again the moment its process is reaped, so the
# record has to say which process it meant: without the launch instant beside
# the number, whatever the kernel hands it to next keeps that generation
# looking driven, and nothing wakes the work again.
WRECYCLE="$(SELF work add "a recycled pid does not hold a generation back for ever" | tail -1)"
SELF work start "$WRECYCLE" > /dev/null
workspec "$ROOT/ws-recycle.json" "id=ws-recycle" "work=$WRECYCLE" "dest=$ROOT/dest/recycle.md" "providerName=recycle-provider"
SELF spec apply "$ROOT/ws-recycle.json" > /dev/null

# a live process that is not this dispatch: what a pid handed out again looks
# like from the record's side
sleep 30 &
STRANGER=$!
write_wake ws-recycle "$WRECYCLE" "$STRANGER" "$(ps -p "$STRANGER" -o lstart=)"
[ "$(tick_json | wake_outcome ws-recycle)" = "driven" ] || fail "a dispatch in flight did not hold its generation back"
[ -z "$(attempts_of "$WRECYCLE")" ] || fail "a generation with a dispatch in flight was dispatched again"

# the same number, a different process: the record names nothing any more
write_wake ws-recycle "$WRECYCLE" "$STRANGER" "Thu Jan  1 00:00:01 2015"
[ "$(tick_json | wake_outcome ws-recycle)" = "woken" ] || fail "a recycled pid held a generation back"
kill "$STRANGER" 2>/dev/null || true
wait "$STRANGER" 2>/dev/null || true
await '[ "$(attempt_state "$(attempts_of "$WRECYCLE" | tail -1)")" = "completed" ]' || fail "the woken generation never completed"
await 'wake_settled ws-recycle' || fail "the recycled-pid dispatch never finished"
grep -q "childStartedAt" "$RUNNER/daemon/wakes.json" || fail "a wake this machine issued recorded no process identity"

# and a wake with no process at all is not a wake in flight: pid 0 answers a
# liveness probe with the caller's own group, so a record carrying one would
# never be woken again
WZERO="$(SELF work add "a dispatch that started no process is not one in flight" | tail -1)"
SELF work start "$WZERO" > /dev/null
workspec "$ROOT/ws-zero.json" "id=ws-zero" "work=$WZERO" "dest=$ROOT/dest/zero.md" "providerName=zero-provider"
SELF spec apply "$ROOT/ws-zero.json" > /dev/null
write_wake ws-zero "$WZERO" 0 ""
[ "$(tick_json | wake_outcome ws-zero)" = "woken" ] || fail "a wake naming no process held its generation back"
await '[ "$(attempt_state "$(attempts_of "$WZERO" | tail -1)")" = "completed" ]' || fail "the ws-zero generation never completed"
await 'wake_settled ws-zero' || fail "the ws-zero dispatch never finished"

# ---------------------------------------------------------------------------
# The supervisor's record names a process, not a number
# ---------------------------------------------------------------------------
# A supervisor killed outright leaves its record behind, and within one boot
# the kernel hands that number out again. Everything the record decides —
# whether a `start` is refused, and what a `stop` signals — has to be about the
# process it was written for.
SELF daemon start --interval 300 > /dev/null || fail "the daemon could not be started for the identity case"
cp "$RUNNER/daemon/daemon.json" "$ROOT/daemon-record.json"
SELF daemon stop | grep -q "stopped" || fail "the daemon started for the identity case did not stop"

sleep 30 &
BYSTANDER=$!
node -e '
const fs = require("node:fs");
const [source, target, pid, startedAt] = process.argv.slice(1);
const record = JSON.parse(fs.readFileSync(source, "utf8"));
fs.writeFileSync(target, JSON.stringify({ ...record, pid: Number(pid), startedAt }, null, 2));
' "$ROOT/daemon-record.json" "$RUNNER/daemon/daemon.json" "$BYSTANDER" "Thu Jan  1 00:00:01 2015"

SELF daemon status | grep -q "left a record behind" || fail "a record naming an unrelated process was read as a running supervisor"
SELF daemon stop | grep -q "no self daemon is running" || fail "stop did not clear a record whose process is not the supervisor"
kill -0 "$BYSTANDER" 2>/dev/null || fail "\`daemon stop\` signalled a process the supervisor never owned"
kill "$BYSTANDER" 2>/dev/null || true
wait "$BYSTANDER" 2>/dev/null || true

# ---------------------------------------------------------------------------
# A tick that fails does not end the supervision it was part of
# ---------------------------------------------------------------------------
# The machine a supervisor watches is exactly the machine where a filesystem
# fills, a record is unreadable, or two settlers race. A loop that exits on the
# first of those stops reconciling everything else too — and, having released
# its record on the way out, leaves a status that cannot be told apart from
# never having been started at all.
SELF daemon start --interval 200 > /dev/null || fail "the daemon could not be started for the failure case"
DPID3="$(daemon_pid)"
await '[ "$(tick_field ticks)" -ge 1 ]' || fail "the daemon never ticked before the failure was injected"

# the failure: the project log a tick reads to decide what is ready is left
# unparseable, which is what a torn write looks like from inside a tick
LOG_BYTES="$(wc -c < "$LOG_A")"
printf 'this line is not an event\n' >> "$LOG_A"
await '[ -n "$(tick_field failed)" ]' || fail "the failing tick was not recorded where status reads it"
FAILED_AT="$(tick_field ticks)"
kill -0 "$DPID3" 2>/dev/null || fail "the supervisor died on the first tick that failed"
await '[ "$(tick_field ticks)" -gt "$FAILED_AT" ]' || fail "the loop stopped at the tick that failed"
kill -0 "$DPID3" 2>/dev/null || fail "the supervisor died while the failure lasted"
SELF daemon status | grep -q "running   process $DPID3" || fail "status stopped reporting a supervisor that is still running"
SELF daemon status | grep -q "^failed" || fail "status does not report what the failing tick failed on"

# the cause goes away and the next tick is ordinary again
node -e 'require("node:fs").truncateSync(process.argv[1], Number(process.argv[2]))' "$LOG_A" "$LOG_BYTES"
await '[ -z "$(tick_field failed)" ]' || fail "the loop never recovered once the failure went away"
SELF daemon stop | grep -q "stopped" || fail "the supervisor that rode out a failure could not be stopped"
await "! kill -0 $DPID3 2>/dev/null" || fail "the stopped supervisor is still running"
SELF daemon status | grep -q "no self daemon is running" || fail "status still reports a daemon after it stopped"

# ---------------------------------------------------------------------------
# Nothing the supervisor records may carry what only this machine can see
# ---------------------------------------------------------------------------
grep -q '"pid"' "$LOG_A" && fail "a supervisor event carried a process handle into the synced log"
grep -q "$ROOT" "$LOG_A" && fail "a supervisor event carried a machine path into the synced log"

echo "daemon loop OK"
