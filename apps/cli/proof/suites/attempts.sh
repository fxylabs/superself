#!/usr/bin/env bash
# Domain suite: runner attempts — capability preflight in the launch boundary,
# retries and circuit breakers, crash recovery and fences, external launches,
# the completion gate, spool redaction and retention.
# Runs alone: bash proof/suites/attempts.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

demo_workspace
RUNNER="$ROOT/A/home/.local/state/superself/runner"

# ---------------------------------------------------------------------------
# Runner attempts. A work unit must not spend a provider call until the
# capabilities it declared are proven inside the boundary the provider will run
# in, and the terminal must never be the store of record or the control plane.
# ---------------------------------------------------------------------------
machine A
cd "$ROOT/A/ws/demo"
WATT="$(SELF work add "a runner attempt proves its capabilities before it spends one" | tail -1)"
SELF work start "$WATT" > /dev/null

AGENT="$CLI_DIR/proof/attempt-agent.mjs"
MKPLAN="$CLI_DIR/proof/attempt-plan.mjs"
DEMO="$ROOT/A/ws/demo"
mkdir -p "$ROOT/dest"
cat > "$ROOT/validate.mjs" <<'VALIDATE'
import { readFileSync } from "node:fs";
process.exit(readFileSync(process.argv[2], "utf8").includes("INVALID") ? 1 : 0);
VALIDATE
cat > "$ROOT/browser-probe.mjs" <<'BROWSER'
process.stderr.write("no signed-in tab is reachable from this boundary\n");
process.exit(1);
BROWSER

plan()
{
    local file="$1"
    shift
    node "$MKPLAN" "$file" "work=$WATT" "agent=$AGENT" "cwd=$DEMO" "$@"
}
last_attempt()
{
    attempts_of "$WATT" | tail -1
}
# Kills the runner process the attempt recorded, and the provider it started.
# `SELF … &` backgrounds a shell function, so $! is the wrapping subshell: the
# runner would survive it and keep heartbeating, and nothing would look crashed.
crash_runner()
{
    local pid
    pid="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))' "$(spool_of "$1")/status.json")"
    pkill -9 -P "$pid" 2>/dev/null || true
    kill -9 "$pid" 2>/dev/null || true
}

# a plan whose work unit does not exist never reaches the provider: self
# context is a read capability, and it is checked before anything is spent
plan "$ROOT/p-context.json" "mode=ok" "marker=$ROOT/ran-context"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.work="w-nosuch";require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-context.json"
CTX="$(SELF attempt run "$ROOT/p-context.json" 2>&1 || true)"
echo "$CTX" | grep -q "context   w-nosuch" || fail "read preflight did not fail on unavailable self context"
echo "$CTX" | grep -q "No provider was invoked" || fail "the capability request did not state that no attempt was spent"
[ -f "$ROOT/ran-context" ] && fail "the provider ran despite an unavailable self context"

# the exact artifact directory, not its parent and not the permission bits: a
# directory that cannot actually be written fails before the provider starts
mkdir -p "$ROOT/readonly"
if [ "$(id -u)" != "0" ]
then
    chmod 500 "$ROOT/readonly"
    plan "$ROOT/p-write.json" "mode=ok" "dest=$ROOT/readonly/design.md" "marker=$ROOT/ran-write"
    WRITE="$(SELF attempt run "$ROOT/p-write.json" 2>&1 || true)"
    echo "$WRITE" | grep -q "write     $ROOT/readonly" || fail "write preflight did not name the unwritable artifact directory"
    [ -f "$ROOT/ran-write" ] && fail "the provider ran despite an unwritable artifact directory"
    chmod 700 "$ROOT/readonly"
fi

# provider reachability and task-domain reachability are two answers, not one
plan "$ROOT/p-domain.json" "mode=ok" "provider=http://localhost:1/" "domains=task-domain.invalid" "marker=$ROOT/ran-domain"
DOMAIN="$(SELF attempt run "$ROOT/p-domain.json" 2>&1 || true)"
echo "$DOMAIN" | grep -q "network   task-domain.invalid" || fail "network preflight did not name the unreachable task domain"
echo "$DOMAIN" | grep -q "provider  " && fail "an unreachable task domain was reported as a provider failure"
[ -f "$ROOT/ran-domain" ] && fail "the provider ran despite an unreachable task domain"
plan "$ROOT/p-provider.json" "mode=ok" "provider=https://provider-host.invalid" "marker=$ROOT/ran-provider"
PROVIDER="$(SELF attempt run "$ROOT/p-provider.json" 2>&1 || true)"
echo "$PROVIDER" | grep -q "provider  provider-host.invalid" || fail "provider preflight did not name the unreachable provider endpoint"

# browser work stops before the provider when the signed-in tab is unreachable
plan "$ROOT/p-browser.json" "mode=ok" "browser=$ROOT/browser-probe.mjs" "marker=$ROOT/ran-browser"
BROWSE="$(SELF attempt run "$ROOT/p-browser.json" 2>&1 || true)"
echo "$BROWSE" | grep -q "browser   https://mail.example.invalid/inbox" || fail "browser preflight did not name the required tab"
[ -f "$ROOT/ran-browser" ] && fail "the provider ran despite an unreachable browser tab"

# The mismatch that spent whole attempts: the capability was probed on the host
# and the provider was then launched inside a sandbox that denied it. Both
# sides are proven here from one capability and one launcher.
#
# First the host boundary, where the old probe lived: git is on this machine,
# the probe clears it, and the provider runs.
command -v git > /dev/null || fail "the proof needs git on PATH to state what the host probe would have cleared"
plan "$ROOT/p-host.json" "mode=ok" "tools=git" "marker=$ROOT/ran-host"
SELF attempt run "$ROOT/p-host.json" > /dev/null || fail "the host boundary did not clear a capability the host plainly has"
[ -f "$ROOT/ran-host" ] || fail "a cleared preflight did not reach the provider"

# Now the same capability behind a launcher that strips PATH on the way in.
# The old host probe would have cleared this identically; the same-boundary
# probe must not, and the provider must never start.
plan "$ROOT/p-boundary.json" "mode=ok" "tools=git" "wrapper=[\"/bin/sh\",\"-c\",\"PATH=/nonexistent exec \\\"\$@\\\"\",\"sh\"]" "marker=$ROOT/ran-boundary"
BOUNDARY="$(SELF attempt run "$ROOT/p-boundary.json" 2>&1 || true)"
echo "$BOUNDARY" | grep -q "tool      git" || fail "the capability probe answered for the host instead of the launch boundary"
echo "$BOUNDARY" | grep -q "probe and launch identity" || fail "a launcher that rewrote the boundary was not detected"
[ -f "$ROOT/ran-boundary" ] && fail "the provider ran inside a boundary the probe never cleared"
AT_DRIFT="$(last_attempt)"
[ "$(attempt_state "$AT_DRIFT")" = "preflight-failed" ] || fail "a boundary the probe never cleared did not fail closed"
SELF attempt show "$AT_DRIFT" | grep -q "^boundary   " || fail "the receipt did not record the boundary the probe ran in"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const field of ["attempt", "fence", "nodeId", "bootId", "adapter", "boundaryDigest", "policyDigest"]) {
    if (r[field] === undefined || r[field] === null || r[field] === "") { console.error("receipt is missing " + field); process.exit(1); }
}
if (r.ok !== false) { console.error("a receipt with a failed check claimed to be ok"); process.exit(1); }
' "$(spool_of "$AT_DRIFT")/preflight.json" || fail "the durable receipt does not bind the attempt to its boundary and policy"

# a clean attempt: capabilities cleared, artifact published atomically, and
# exactly one report attached to the work unit
REPORTS_BEFORE="$(count_events report.added)"
plan "$ROOT/p-ok.json" "mode=ok" "dest=$ROOT/dest/design.md" "read=$DEMO" "provider=http://localhost:1/" "marker=$ROOT/ran-ok"
SELF attempt run "$ROOT/p-ok.json" > /dev/null || fail "a fully provisioned attempt did not complete"
AT_OK="$(last_attempt)"
[ "$(attempt_state "$AT_OK")" = "completed" ] || fail "a successful attempt did not reach the completed state"
[ -f "$ROOT/dest/design.md" ] || fail "the declared artifact was not published to its destination"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "a completed attempt did not attach exactly one report"
grep -q "\"attempt\":\"$AT_OK\"" "$LOG_A" || fail "the report does not carry the attempt that produced it"
SELF work show "$WATT" | grep -q "$AT_OK (completed)" || fail "the work record does not show the attempt that completed"
SELF status | grep -q "$AT_OK" && fail "a completed attempt still shows as open machine-local state"

# the brief the agent is handed states the contract it will be judged by. An
# agent that has to read attempt/gate.ts to learn the envelope shape fails the
# gate on a result it did the work for
BRIEF_OK="$(spool_of "$AT_OK")/brief.md"
grep -q 'SUPERSELF_ATTEMPT_OUT' "$BRIEF_OK" || fail "the brief does not say where artifacts are staged"
grep -q 'SUPERSELF_ATTEMPT_RESULT' "$BRIEF_OK" || fail "the brief does not say where the result envelope is written"
grep -q '"status": "completed"' "$BRIEF_OK" || fail "the brief does not state the status the gate requires"
grep -q '"name": "design.md", "sha256": ".*", "bytes": 0' "$BRIEF_OK" || fail "the brief does not state the {name, sha256, bytes} artifact declaration"
grep -q 'shasum -a 256' "$BRIEF_OK" || fail "the brief does not say how sha256 and bytes are computed"
grep -q 'exit code alone is not a result' "$BRIEF_OK" || fail "the brief does not say that an exit code is not a result"

# the provider breaker is written under a lock that may legitimately refuse,
# and it is machine-local advice about a provider — never a reason for the
# attempt's own settlement not to be written. The agent takes the lock away in
# a shape nothing can break, so the breaker write throws after the run ended
LOCKED_BREAKER="$(node -e 'process.stdout.write(process.argv[1] + "/.local/state/superself/runner/breakers/" + require("crypto").createHash("sha256").update("lockedprov").digest("hex").slice(0, 16) + ".json.lock")' "$HOME")"
FAILED_BEFORE="$(count_events run.failed)"
plan "$ROOT/p-lockbreaker.json" "mode=lockbreaker" "provider=http://localhost:1/" "providerName=lockedprov" "maxRuns=1" "lockdir=$LOCKED_BREAKER"
LOCKED="$(SELF attempt run "$ROOT/p-lockbreaker.json" 2>&1 || true)"
AT_LOCKED="$(last_attempt)"
[ -d "$LOCKED_BREAKER" ] || fail "the breaker-lock case never took the lock it is about"
[ "$(attempt_state "$AT_LOCKED")" = "failed" ] || fail "a breaker write that threw left the spool unsettled"
echo "$LOCKED" | grep -q "transient-network" || fail "the breaker-lock case did not fail on the class that pushes the breaker"
[ "$(count_events run.failed)" -eq "$((FAILED_BEFORE + 1))" ] || fail "a breaker write that threw cost the attempt its run.failed record"
grep -q '"event":"breaker.unrecorded"' "$(spool_of "$AT_LOCKED")/events.jsonl" || fail "a breaker that could not be written was not recorded as missing evidence"
SELF attempt breaker lockedprov | grep -q "closed" || fail "the breaker under an unbreakable lock was somehow written"
rmdir "$LOCKED_BREAKER"

# the same lock, on the run that succeeded. The breaker is cleared on success
# under exactly the lock the failure path could not take, and a provider turn
# that produced a valid envelope must not be lost to that bookkeeping: the
# attempt settles first and the unwritable breaker is recorded as missing
# evidence, the same way the failure above does it
LOCKED_OK="$(node -e 'process.stdout.write(process.argv[1] + "/.local/state/superself/runner/breakers/" + require("crypto").createHash("sha256").update("lockedok").digest("hex").slice(0, 16) + ".json.lock")' "$HOME")"
REPORTS_BEFORE="$(count_events report.added)"
plan "$ROOT/p-lockbreaker-ok.json" "mode=lockbreakerok" "dest=$ROOT/dest/lockok.md" "provider=http://localhost:1/" "providerName=lockedok" "maxRuns=1" "lockdir=$LOCKED_OK"
SELF attempt run "$ROOT/p-lockbreaker-ok.json" > /dev/null || fail "a breaker reset that threw took down an attempt that had already produced its result"
AT_LOCKED_OK="$(last_attempt)"
[ -d "$LOCKED_OK" ] || fail "the success-path breaker-lock case never took the lock it is about"
[ "$(attempt_state "$AT_LOCKED_OK")" = "completed" ] || fail "a breaker reset that threw left a validated attempt unsettled"
[ -f "$ROOT/dest/lockok.md" ] || fail "a breaker reset that threw cost the attempt its published artifact"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "a breaker reset that threw cost the attempt its report"
grep -q '"event":"breaker.unrecorded"' "$(spool_of "$AT_LOCKED_OK")/events.jsonl" || fail "a breaker reset that could not be written was not recorded as missing evidence"
rmdir "$LOCKED_OK"

# a plan that declares no artifact is completed by the envelope alone, and the
# brief states that contract instead of naming a file the plan never asked for
BRIEF_NONE="$(spool_of "$AT_LOCKED")/brief.md"
grep -q '"artifacts": \[\] }' "$BRIEF_NONE" || fail "the brief for a plan with no declared artifact did not state the empty artifact list"
grep -q "result.md" "$BRIEF_NONE" && fail "the brief invented an artifact name for a plan that declares none"

# the same attempt settled twice records nothing twice — neither the report
# nor the completion beside it
COMPLETED_BEFORE="$(count_events run.completed)"
SETTLE="$(SELF attempt settle "$AT_OK")"
echo "$SETTLE" | grep -q "already attached" || fail "settling a reported attempt did not recognise its own report"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "settling an already-reported attempt recorded a duplicate"
[ "$(count_events run.completed)" -eq "$COMPLETED_BEFORE" ] || fail "settling an already-completed attempt recorded a duplicate completion"

# a result larger than any terminal will hold stays complete in the spool
plan "$ROOT/p-big.json" "mode=big" "dest=$ROOT/dest/big.md"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-big.json" "$ROOT/dest/big.md"
SELF attempt run "$ROOT/p-big.json" > /dev/null || fail "the long-result attempt did not complete"
AT_BIG="$(last_attempt)"
SPOOL_BIG="$ROOT/A/home/.local/state/superself/runner/attempts/$AT_BIG"
[ "$(wc -c < "$SPOOL_BIG/run-1.stdout.log")" -gt 2000000 ] || fail "the spool did not keep the whole provider output"
grep -q "COMPLETE-TAIL-MARKER" "$SPOOL_BIG/run-1.stdout.log" || fail "the end of a long result was truncated in the spool"

# provider DNS fails twice, backs off with jitter, then succeeds — one report
# and one artifact, never one per run
REPORTS_BEFORE="$(count_events report.added)"
plan "$ROOT/p-retry.json" "mode=dnsfail" "dest=$ROOT/dest/retry.md" "provider=http://localhost:1/" "maxRuns=3"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-retry.json" "$ROOT/dest/retry.md"
SELF attempt run "$ROOT/p-retry.json" > /dev/null || fail "a transient provider failure was not retried to success"
AT_RETRY="$(last_attempt)"
SPOOL_RETRY="$ROOT/A/home/.local/state/superself/runner/attempts/$AT_RETRY"
[ "$(grep -c 'transient-network' "$SPOOL_RETRY/runs.jsonl")" -eq 2 ] || fail "the two DNS failures were not classified as transient network failures"
node -e '
const runs = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
const backed = runs.filter((r) => r.backoffMs !== undefined);
if (backed.length !== 2) { console.error("expected two backoffs, got " + backed.length); process.exit(1); }
if (backed[1].backoffCapMs <= backed[0].backoffCapMs) { console.error("backoff did not grow"); process.exit(1); }
for (const r of backed) {
    if (r.backoffMs < r.backoffCapMs / 2 || r.backoffMs > r.backoffCapMs) { console.error("jitter left the window"); process.exit(1); }
}
' "$SPOOL_RETRY/runs.jsonl" || fail "retry backoff was not bounded, exponential, and jittered"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "a retried attempt recorded more than one report"
[ "$(SELF artifact list --work "$WATT" | grep -c "retry.md")" -eq 1 ] || fail "a retried attempt stored its artifact more than once"

# a failed run's result envelope must not complete the run after it. A plan
# that declares no artifact is judged on the envelope alone, so a rerun that
# produced nothing would otherwise publish the previous run's summary as its
# own report — the exact "done because it said so" this gate exists to refuse.
REPORTS_BEFORE="$(count_events report.added)"
COMPLETED_BEFORE="$(count_events run.completed)"
rm -f "$ROOT/ran-stale"
plan "$ROOT/p-stale.json" "mode=stale" "provider=http://localhost:1/" "providerName=stale-provider" "maxRuns=2" "marker=$ROOT/ran-stale"
STALE="$(SELF attempt run "$ROOT/p-stale.json" 2>&1 || true)"
[ "$(wc -l < "$ROOT/ran-stale")" -eq 2 ] || fail "the stale-envelope case never reached its second run"
echo "$STALE" | grep -q "completed" && fail "a run that produced nothing completed from the previous run's result envelope"
# and it is told what was missing. An agent that forgets to write its result
# envelope is the commonest misconfiguration there is, and the last line of an
# empty stderr would report it as "failed: unknown — " with nothing after it.
echo "$STALE" | grep -q "no structured result envelope" || fail "a run that exited clean with nothing written was reported with an empty failure detail"
AT_STALE="$(last_attempt)"
[ "$(attempt_state "$AT_STALE")" = "failed" ] || fail "an attempt whose runs left no result of their own did not fail"
[ "$(count_events report.added)" -eq "$REPORTS_BEFORE" ] || fail "a stale result envelope attached the previous run's summary as a report"
[ "$(count_events run.completed)" -eq "$COMPLETED_BEFORE" ] || fail "a stale result envelope claimed a completion"
grep -q "RUN-ONE-STALE-SUMMARY" "$LOG_A" && fail "a previous run's summary reached the synced log"
[ -f "$(spool_of "$AT_STALE")/result.json" ] && fail "the result envelope of a run that never wrote one is still in the spool"

# the bound the plan declares is applied to the provider run itself: a hung
# provider costs that bound, not the runner
plan "$ROOT/p-timeout.json" "mode=slow" "runTimeoutMs=1500" "maxRuns=1"
TIMEOUT="$(SELF attempt run "$ROOT/p-timeout.json" 2>&1 || true)"
echo "$TIMEOUT" | grep -q "did not finish within the 1500ms" || fail "a hung provider was not stopped by the run timeout the plan declared"
AT_TIMEOUT="$(last_attempt)"
[ "$(attempt_state "$AT_TIMEOUT")" = "failed" ] || fail "a run stopped on its own bound did not fail"
grep -q '"timedOut":true' "$(spool_of "$AT_TIMEOUT")/runs.jsonl" || fail "the run record does not say the bound expired"

# a bound past the 32-bit timer range is clamped to 1ms, so a typo'd extra zero
# would kill every run the instant it starts. It is a plan error instead.
plan "$ROOT/p-hugebound.json" "mode=ok" "runTimeoutMs=3000000000"
HUGEBOUND="$(SELF attempt run "$ROOT/p-hugebound.json" 2>&1 || true)"
echo "$HUGEBOUND" | grep -q "past the 2147483647 a timer can hold" || fail "a bound past the timer range was accepted and became an immediate timeout"

# Ctrl-C on a running attempt. The provider leads its own process group so a
# bound or a cancel can reach everything the launcher started, which also takes
# it out of the terminal's — without a handler the operator's most natural way
# to stop an attempt orphans a provider that keeps spending and freezes the
# spool at `running`.
plan "$ROOT/p-interrupt.json" "mode=slow" "idfile=$ROOT/interrupt-id"
rm -f "$ROOT/interrupt-id"
SELF attempt run "$ROOT/p-interrupt.json" > /dev/null 2>&1 &
INTERRUPT_WRAPPER=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/interrupt-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/interrupt-id" ] || fail "the attempt to be interrupted never started"
AT_INTERRUPT="$(cat "$ROOT/interrupt-id")"
INTERRUPT_RUNNER="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))' "$(spool_of "$AT_INTERRUPT")/status.json")"
INTERRUPT_PROVIDER=""
for _ in $(seq 1 200)
do
    INTERRUPT_PROVIDER="$(pgrep -P "$INTERRUPT_RUNNER" 2>/dev/null | head -1)"
    [ -n "$INTERRUPT_PROVIDER" ] && break
    sleep 0.1
done
[ -n "$INTERRUPT_PROVIDER" ] || fail "the attempt to be interrupted never started a provider"
kill -INT "$INTERRUPT_RUNNER"
wait "$INTERRUPT_WRAPPER" 2>/dev/null || true
kill -0 "$INTERRUPT_PROVIDER" 2>/dev/null && fail "stopping the runner left the provider running and spending"
[ "$(attempt_state "$AT_INTERRUPT")" = "cancelled" ] || fail "an interrupted attempt left its spool claiming a runner is still driving it"

# a provider that keeps failing opens the circuit, and the work behind it stays
# queued instead of burning the rest of the queue on the same outage
plan "$ROOT/p-open.json" "mode=alwaysdns" "provider=http://localhost:1/" "providerName=flaky" "maxRuns=1" "marker=$ROOT/ran-open"
for _ in 1 2 3
do
    SELF attempt run "$ROOT/p-open.json" > /dev/null 2>&1 || true
done
SELF attempt breaker flaky | grep -q "open" || fail "a persistent provider failure did not open the circuit"
QUEUED="$(SELF attempt run "$ROOT/p-open.json" 2>&1 || true)"
echo "$QUEUED" | grep -q "circuit breaker for provider \"flaky\" is open" || fail "an open circuit did not stop the next attempt"
echo "$QUEUED" | grep -q "stays queued and no attempt was spent" || fail "an open circuit did not leave the work recoverable"
AT_QUEUED="$(last_attempt)"
[ "$(attempt_state "$AT_QUEUED")" = "waiting-provider" ] || fail "an attempt behind an open circuit was not left waiting"
[ "$(grep -c "run 4" "$ROOT/ran-open")" -eq 0 ] 2>/dev/null || fail "an open circuit still reached the provider"
SELF work show "$WATT" | grep -q "Status: active" || fail "an open circuit moved the work unit out of active"
SELF attempt breaker flaky --reset | grep -q "reset" || fail "the circuit breaker could not be reset"

# a cooled-down breaker lets exactly one attempt through, and an attempt that
# stops in preflight never touched the provider: it must not be the one that
# spends the trial the whole queue is waiting on
plan "$ROOT/p-trial.json" "mode=alwaysdns" "provider=http://localhost:1/" "providerName=trialprov" "maxRuns=1"
for _ in 1 2 3
do
    SELF attempt run "$ROOT/p-trial.json" > /dev/null 2>&1 || true
done
TRIAL_FILE="$(node -e 'process.stdout.write(process.argv[1] + "/.local/state/superself/runner/breakers/" + require("crypto").createHash("sha256").update("trialprov").digest("hex").slice(0, 16) + ".json")' "$HOME")"
# backdated past the cooldown, so the next attempt reads the breaker as cooled
# down and may take the one trial it allows
node -e '
const fs = require("fs");
const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (record.state !== "open") { console.error("the trial breaker never opened"); process.exit(1); }
record.openedAt = new Date(Date.now() - 600000).toISOString();
delete record.trialAt;
delete record.trialBy;
fs.writeFileSync(process.argv[1], JSON.stringify(record, null, 2));
' "$TRIAL_FILE" || fail "the trial breaker could not be cooled down"
plan "$ROOT/p-trialblocked.json" "mode=ok" "provider=http://localhost:1/" "providerName=trialprov" "tools=definitely-not-a-real-tool" "marker=$ROOT/ran-trial"
SELF attempt run "$ROOT/p-trialblocked.json" > /dev/null 2>&1 || true
[ "$(attempt_state "$(last_attempt)")" = "preflight-failed" ] || fail "the trial case did not stop in preflight"
[ -f "$ROOT/ran-trial" ] && fail "an attempt that failed preflight still reached the provider"
node -e 'if (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).trialAt !== undefined) { process.exit(1); }' "$TRIAL_FILE" || fail "an attempt that never reached the provider spent the breaker's half-open trial"
SELF attempt breaker trialprov --reset > /dev/null

# the agent may name its own failure class, but it may not spend the whole
# retry budget on a class nothing the runner observed supports — nor push a
# breaker that gates unrelated queued work
rm -f "$ROOT/ran-liar"
plan "$ROOT/p-liar.json" "mode=liar" "provider=http://localhost:1/" "providerName=liar-provider" "maxRuns=5" "marker=$ROOT/ran-liar"
LIAR="$(SELF attempt run "$ROOT/p-liar.json" 2>&1 || true)"
[ "$(wc -l < "$ROOT/ran-liar")" -eq 2 ] || fail "a declared transient class drove more provider runs than the runner allows"
echo "$LIAR" | grep -q "nothing the runner observed supports it" || fail "the runner did not say why it stopped believing the declared class"
SELF attempt breaker liar-provider | grep -q "closed" || fail "a failure only the agent called transient pushed the shared provider breaker"

# a replacement run gets the same immutable brief and the checkpoints the
# previous run left behind
plan "$ROOT/p-resume.json" "mode=checkpoint" "dest=$ROOT/dest/resume.md" "provider=http://localhost:1/" "maxRuns=2" "resume=on"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-resume.json" "$ROOT/dest/resume.md"
SELF attempt run "$ROOT/p-resume.json" > /dev/null || fail "a checkpointed attempt did not complete on its replacement run"
grep -q "resumed=outline" "$ROOT/dest/resume.md" || fail "the replacement run did not receive the previous checkpoint"
AT_RESUME="$(last_attempt)"
SPOOL_RESUME="$ROOT/A/home/.local/state/superself/runner/attempts/$AT_RESUME"
BRIEF_SHA="$(node -e 'const c=require("crypto");const fs=require("fs");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1],"utf8")).digest("hex").slice(0,12))' "$SPOOL_RESUME/brief.md")"
grep -q "brief=$BRIEF_SHA" "$ROOT/dest/resume.md" || fail "the replacement run did not receive the same immutable brief"

# a follow-up sent after launch arrives through the spool, never through stdin
plan "$ROOT/p-followup.json" "mode=followup" "dest=$ROOT/dest/followup.md" "idfile=$ROOT/followup-id"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-followup.json" "$ROOT/dest/followup.md"
rm -f "$ROOT/followup-id"
SELF attempt run "$ROOT/p-followup.json" > /dev/null &
RUNNER_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/followup-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/followup-id" ] || fail "the attempt never reported the id a directive could be addressed to"
AT_FOLLOW="$(cat "$ROOT/followup-id")"
SELF attempt directive "$AT_FOLLOW" "also cover the rollback path" | grep -q "not from a terminal" || fail "the directive was not queued durably"
wait "$RUNNER_PID" || fail "the attempt that received a follow-up did not complete"
grep -q "directive=also cover the rollback path" "$ROOT/dest/followup.md" || fail "the follow-up directive never reached the running attempt"
grep -q "directive.delivered" "$ROOT/A/home/.local/state/superself/runner/attempts/$AT_FOLLOW/events.jsonl" || fail "the spool did not record delivering the directive"

# a crash leaves an attempt that must never read as success
COMPLETED_BEFORE="$(count_events run.completed)"
plan "$ROOT/p-crash.json" "mode=slow" "idfile=$ROOT/crash-id"
rm -f "$ROOT/crash-id"
SELF attempt run "$ROOT/p-crash.json" > /dev/null 2>&1 &
CRASH_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/crash-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/crash-id" ] || fail "the attempt to be crashed never started"
AT_CRASH="$(cat "$ROOT/crash-id")"
# the runner itself, not the shell that launched it: killing the wrapper would
# leave the runner alive and still writing the heartbeat recovery reads
crash_runner "$AT_CRASH"
wait "$CRASH_PID" 2>/dev/null || true
SELF attempt recover | grep -q "recovered 1 attempt" || fail "a crashed attempt was not recovered"
[ "$(attempt_state "$AT_CRASH")" = "exited-unreconciled" ] || fail "a crashed attempt did not read as exited-unreconciled"
[ "$(count_events run.completed)" -eq "$COMPLETED_BEFORE" ] || fail "a crashed attempt claimed a completion"
SELF work show "$WATT" | grep -q "$AT_CRASH (failed" || fail "the work record did not carry the unreconciled attempt"

# a machine restart is recognised on its own, even when the recorded pid is
# alive again because the operating system handed the number out twice
plan "$ROOT/p-reboot.json" "mode=slow" "idfile=$ROOT/reboot-id"
rm -f "$ROOT/reboot-id"
SELF attempt run "$ROOT/p-reboot.json" > /dev/null 2>&1 &
REBOOT_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/reboot-id" ] && break
    sleep 0.1
done
AT_REBOOT="$(cat "$ROOT/reboot-id")"
crash_runner "$AT_REBOOT"
wait "$REBOOT_PID" 2>/dev/null || true
STATUS_REBOOT="$(spool_of "$AT_REBOOT")/status.json"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.bootId="0000000000000000";s.pid=Number(process.argv[2]);fs.writeFileSync(f,JSON.stringify(s,null,2))' "$STATUS_REBOOT" "$$"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_REBOOT")" = "exited-unreconciled" ] || fail "an attempt from before a restart was not recovered"
SELF attempt show "$AT_REBOOT" | grep -q "machine restarted" || fail "the restart was not named as the reason"

# recovery must not claim a false failure either. Proving capabilities takes as
# long as the probe bound allows, and an attempt still in preflight is alive:
# declaring it dead writes a run.failed it never suffered into the synced log.
cat > "$ROOT/slow-browser-probe.mjs" <<'SLOWBROWSER'
const until = Date.now() + 8000;
while (Date.now() < until)
{
    // Deliberately busy: a signed-in tab check that takes real time.
}
SLOWBROWSER
FAILED_BEFORE="$(count_events run.failed)"
plan "$ROOT/p-live.json" "mode=ok" "browser=$ROOT/slow-browser-probe.mjs"
SELF attempt run "$ROOT/p-live.json" > /dev/null 2>&1 &
LIVE_PID=$!
IN_PREFLIGHT=no
for _ in $(seq 1 200)
do
    if SELF attempt list | grep -q "  preflight  run"
    then
        IN_PREFLIGHT=yes
        break
    fi
    sleep 0.1
done
[ "$IN_PREFLIGHT" = yes ] || fail "the attempt never reached preflight for recovery to race"
SELF attempt recover | grep -q "no attempt needed recovery" || fail "recovery declared an attempt still proving its capabilities dead"
wait "$LIVE_PID" || fail "an attempt that recovery looked at during preflight did not complete"
[ "$(count_events run.failed)" -eq "$FAILED_BEFORE" ] || fail "recovery recorded a run.failed for an attempt that then completed"

# the fence is enforced, not merely recorded: a runner whose attempt was taken
# over stops instead of overwriting the verdict that replaced it
REPORTS_BEFORE="$(count_events report.added)"
rm -f "$ROOT/fence-id" "$ROOT/fence-release"
plan "$ROOT/p-fence.json" "mode=hold" "idfile=$ROOT/fence-id" "gate=$ROOT/fence-release"
SELF attempt run "$ROOT/p-fence.json" > "$ROOT/fence.out" 2>&1 &
FENCE_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/fence-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/fence-id" ] || fail "the attempt to be taken over never started"
AT_FENCE="$(cat "$ROOT/fence-id")"
STATUS_FENCE="$(spool_of "$AT_FENCE")/status.json"
FENCE_BEFORE="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).fence))' "$STATUS_FENCE")"
# recovery is made to believe this machine restarted, while the runner it
# would be recovering is in fact still running
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.bootId="0000000000000000";fs.writeFileSync(f,JSON.stringify(s,null,2))' "$STATUS_FENCE"
SELF attempt recover | grep -q "recovered 1 attempt" || fail "recovery did not take over an attempt whose runner it could not see"
node -e '
const held = Number(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).fence);
if (!(held > Number(process.argv[2]))) { console.error("taking an attempt over did not move the fence"); process.exit(1); }
' "$STATUS_FENCE" "$FENCE_BEFORE" || fail "recovery took an attempt over without minting a newer fence"
touch "$ROOT/fence-release"
wait "$FENCE_PID" && fail "a runner that lost its attempt still exited successfully"
grep -q "no longer owns it" "$ROOT/fence.out" || fail "the stale runner was not stopped by the fence"
[ "$(attempt_state "$AT_FENCE")" = "exited-unreconciled" ] || fail "a stale runner overwrote the verdict that replaced it"
[ "$(count_events report.added)" -eq "$REPORTS_BEFORE" ] || fail "a runner that no longer owned its attempt still attached a report"

# ---------------------------------------------------------------------------
# Externally launched attempts. A process the runner did not spawn joins the
# same lifecycle: the spool and the capability receipt exist before anything
# runs, the launcher that started the process claims it, and the exit it
# reports is settled through the same completion gate.
# ---------------------------------------------------------------------------
LAUNCH="$CLI_DIR/proof/external-launch.mjs"
SELF_JS="$CLI_DIR/bin/self.mjs"
launch()
{
    node "$LAUNCH" "$SELF_JS" "$1" "$(spool_of "$1")" "$DEMO" "${@:2}"
}
# The whole exit record, source and code together: the code the launcher
# reported is the one thing a confirmed exit is judged on, and an unconfirmed
# exit must not carry a code nobody reported.
exit_record()
{
    SELF attempt show "$1" | sed -n 's/^exit *//p'
}

# registration is the whole of the runner's work before the launch, and none of
# the launch: capabilities proven, spool written, no process anywhere
REPORTS_BEFORE="$(count_events report.added)"
plan "$ROOT/p-external.json" "mode=ok" "dest=$ROOT/dest/external.md" "read=$DEMO"
AT_EXT="$(SELF attempt register "$ROOT/p-external.json")"
[ "$(attempt_state "$AT_EXT")" = "registered" ] || fail "a registered attempt did not reach the registered state"
[ -f "$(spool_of "$AT_EXT")/preflight.json" ] || fail "registering an attempt did not record its capability receipt"
[ -f "$(spool_of "$AT_EXT")/brief.md" ] || fail "registering an attempt did not write the brief its launch is handed"
node -e 'if (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pid !== undefined) { process.exit(1); }' "$(spool_of "$AT_EXT")/status.json" || fail "a registered attempt recorded a process before one existed"

# and then a launcher of the operator's own drives it to settlement
launch "$AT_EXT" || fail "an externally launched attempt did not settle through the completion gate"
[ "$(attempt_state "$AT_EXT")" = "completed" ] || fail "an externally launched attempt did not reach the completed state"
[ "$(exit_record "$AT_EXT")" = "confirmed (code 0)" ] || fail "an exit a launcher watched happen was not recorded as confirmed with the code it reported"
[ -f "$ROOT/dest/external.md" ] || fail "the externally launched attempt did not publish its declared artifact"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "an externally launched attempt did not attach exactly one report"
SELF work show "$WATT" | grep -q "$AT_EXT (completed)" || fail "the work record does not show the externally launched attempt"
# a settled attempt releases the work unit it was driving: every scenario
# below claims this same unit again, and would be refused if it were held

# a confirmed non-zero exit is judged on the exit, not on the envelope the run
# left behind: `mode=stale` writes a completed envelope and then dies
REPORTS_BEFORE="$(count_events report.added)"
COMPLETED_BEFORE="$(count_events run.completed)"
plan "$ROOT/p-extfail.json" "mode=stale" "maxRuns=1"
AT_EXTFAIL="$(SELF attempt register "$ROOT/p-extfail.json")"
launch "$AT_EXTFAIL" && fail "an externally launched attempt that exited non-zero reported success"
[ "$(attempt_state "$AT_EXTFAIL")" = "failed" ] || fail "a confirmed non-zero exit did not fail the attempt"
[ "$(exit_record "$AT_EXTFAIL")" = "confirmed (code 1)" ] || fail "a reported non-zero exit was not recorded as confirmed with the code the launcher watched"
[ "$(count_events report.added)" -eq "$REPORTS_BEFORE" ] || fail "a failed external exit attached the envelope its run left behind as a report"
[ "$(count_events run.completed)" -eq "$COMPLETED_BEFORE" ] || fail "a failed external exit claimed a completion"

# the exit the launcher watched was its process's, not the whole launch's: a
# background process the payload left in its group is still running when the
# exit is reported, and settlement ends in a write that releases the work
# unit. What survived the payload is contained before anything is let go.
plan "$ROOT/p-linger.json" "mode=linger" "dest=$ROOT/dest/linger.md" "orphanfile=$ROOT/linger-orphan"
AT_LINGER="$(SELF attempt register "$ROOT/p-linger.json")"
launch "$AT_LINGER" || fail "an exit reported over a surviving group member did not settle after containing it"
[ "$(attempt_state "$AT_LINGER")" = "completed" ] || fail "a contained launch did not reach the completed state"
ORPHAN_PID="$(cat "$ROOT/linger-orphan")"
kill -0 "$ORPHAN_PID" 2>/dev/null && fail "settling an external exit released the work unit while a process its launch started was still running"
kill -9 "$ORPHAN_PID" 2>/dev/null || true

# a launcher that walked away: the process finished and nobody ever reported
# its exit, so nothing may be concluded from what is on disk
plan "$ROOT/p-vanish.json" "mode=ok" "dest=$ROOT/dest/vanish.md"
AT_VANISH="$(SELF attempt register "$ROOT/p-vanish.json")"
launch "$AT_VANISH" --abandon --pidfile="$ROOT/vanish-pid" > /dev/null || fail "the abandoned launch was never claimed"
VANISH_PID="$(cat "$ROOT/vanish-pid")"
for _ in $(seq 1 200)
do
    kill -0 "$VANISH_PID" 2>/dev/null || break
    sleep 0.1
done
kill -0 "$VANISH_PID" 2>/dev/null && fail "the abandoned process never finished"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_VANISH")" = "exited-unreconciled" ] || fail "an abandoned external attempt was not recovered"
[ "$(exit_record "$AT_VANISH")" = "vanished" ] || fail "a process that disappeared was not told apart from a reported exit, or was given a code nobody reported"
VANISHED_SETTLE="$(SELF attempt settle "$AT_VANISH" 2>&1 || true)"
echo "$VANISHED_SETTLE" | grep -q "only a confirmed exit" || fail "an attempt whose exit nobody confirmed was offered to the completion gate"
[ -f "$ROOT/dest/vanish.md" ] && fail "an unconfirmed exit published the artifact its process left staged"

# and a live owner that stopped being watched is a third answer again: the
# process is still there, and nothing is driving the attempt. The terminal
# write of recovery releases the work unit, so recovery must first contain
# what the launch started — a unit released over a live group would seat a
# second owner beside the processes of the first.
plan "$ROOT/p-quiet.json" "mode=slow"
AT_QUIET="$(SELF attempt register "$ROOT/p-quiet.json")"
launch "$AT_QUIET" --abandon --pidfile="$ROOT/quiet-pid" > /dev/null || fail "the unwatched launch was never claimed"
QUIET_PID="$(cat "$ROOT/quiet-pid")"
node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,JSON.stringify({ts:new Date(Date.now()-120000).toISOString(),pid:Number(process.argv[2])},null,2))' "$(spool_of "$AT_QUIET")/heartbeat.json" "$QUIET_PID"
kill -0 "$QUIET_PID" 2>/dev/null || fail "the stale-heartbeat case proves nothing if its process had already exited"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_QUIET")" = "exited-unreconciled" ] || fail "an attempt nobody was heartbeating for was not recovered"
[ "$(exit_record "$AT_QUIET")" = "stale" ] || fail "a stale heartbeat was not told apart from a process that disappeared"
kill -0 "$QUIET_PID" 2>/dev/null && fail "recovery released the work unit while the process the launch started was still running"
# a recovered attempt is terminal and holds the work unit no longer: the very
# next scenario claims this same unit, and would be refused if it were held
kill -9 "$QUIET_PID" 2>/dev/null || true

# the crash window inside `self attempt exited`: the launcher reported the
# exit, the status carries it as confirmed, and whatever was cleaning up after
# the provider died before the terminal write. What was witnessed must survive
# recovery — reclassified as a disappearance it would carry a code nobody
# reported — and a run that already produced a result is judged by the
# completion gate rather than written off as unknown, or a cleanup that failed
# after the work was done costs a validated attempt.
REPORTS_BEFORE="$(count_events report.added)"
plan "$ROOT/p-window.json" "mode=ok" "dest=$ROOT/dest/window.md"
AT_WINDOW="$(SELF attempt register "$ROOT/p-window.json")"
launch "$AT_WINDOW" --abandon --pidfile="$ROOT/window-pid" > /dev/null || fail "the crash-window launch was never claimed"
WINDOW_PID="$(cat "$ROOT/window-pid")"
for _ in $(seq 1 200)
do
    kill -0 "$WINDOW_PID" 2>/dev/null || break
    sleep 0.1
done
kill -0 "$WINDOW_PID" 2>/dev/null && fail "the crash-window process never finished"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.exitSource="confirmed";s.exitCode=0;fs.writeFileSync(f,JSON.stringify(s,null,2))' "$(spool_of "$AT_WINDOW")/status.json"
SELF attempt recover | grep -q "settled through the completion gate" || fail "recovery did not say it settled a confirmed exit through the gate"
[ "$(attempt_state "$AT_WINDOW")" = "completed" ] || fail "a confirmed exit 0 over a validated result was written off as unknown by recovery"
[ "$(exit_record "$AT_WINDOW")" = "confirmed (code 0)" ] || fail "recovery rewrote an exit the launcher reported, or dropped the code it carried"
[ -f "$ROOT/dest/window.md" ] || fail "recovery settled a confirmed exit without publishing the artifact its run produced"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "recovery through the gate did not attach exactly one report"
[ "$(SELF artifact list --work "$WATT" | grep -c "window.md")" -eq 1 ] || fail "recovery stored the recovered artifact more than once"

# and the gate is still the one that judges it: the same confirmed exit 0 with
# nothing the gate can read is written off, not promoted. An exit code alone is
# not a result, whoever reports it.
plan "$ROOT/p-nores.json" "mode=ok" "dest=$ROOT/dest/nores.md"
AT_NORES="$(SELF attempt register "$ROOT/p-nores.json")"
launch "$AT_NORES" --abandon --pidfile="$ROOT/nores-pid" > /dev/null || fail "the no-envelope launch was never claimed"
NORES_PID="$(cat "$ROOT/nores-pid")"
for _ in $(seq 1 200)
do
    kill -0 "$NORES_PID" 2>/dev/null || break
    sleep 0.1
done
kill -0 "$NORES_PID" 2>/dev/null && fail "the no-envelope process never finished"
rm -f "$(spool_of "$AT_NORES")/result.json"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.exitSource="confirmed";s.exitCode=0;fs.writeFileSync(f,JSON.stringify(s,null,2))' "$(spool_of "$AT_NORES")/status.json"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_NORES")" = "exited-unreconciled" ] || fail "a confirmed exit with no result envelope was promoted by recovery"
[ -f "$ROOT/dest/nores.md" ] && fail "an attempt with no result envelope published an artifact"

# a process group id is only reserved while the group has members, so a group
# that empties can have its number handed to somebody else. Nothing a launch
# started can predate the launch, and that is the whole of the guard: a launch
# instant later than every member of the group owns none of them.
plan "$ROOT/p-recycle.json" "mode=slow"
AT_RECYCLE="$(SELF attempt register "$ROOT/p-recycle.json")"
launch "$AT_RECYCLE" --abandon --pidfile="$ROOT/recycle-pid" > /dev/null || fail "the recycled-group launch was never claimed"
RECYCLE_PID="$(cat "$ROOT/recycle-pid")"
node -e 'const fs=require("fs");const f=process.argv[1];const o=JSON.parse(fs.readFileSync(f,"utf8"));o.startedAt=new Date(Date.now()+3600000).toISOString();fs.writeFileSync(f,JSON.stringify(o,null,2))' "$(spool_of "$AT_RECYCLE")/owner.json"
CONTAIN="$(SELF attempt cancel "$AT_RECYCLE")"
echo "$CONTAIN" | grep -q "no signal was sent" || fail "containment was aimed at a process group this launch does not own"
kill -0 "$RECYCLE_PID" 2>/dev/null || fail "a stranger holding a recycled group id was signalled by this attempt's cancel"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_RECYCLE")" = "exited-unreconciled" ] || fail "an attempt whose group holds nothing of its own was left claiming a live owner"
[ "$(exit_record "$AT_RECYCLE")" = "vanished" ] || fail "a recycled process group was counted as this launch's own"
kill -9 "$RECYCLE_PID" 2>/dev/null || true

# and the direction a real recycle takes: the number is handed out only after
# this launch's group emptied, so everything in the stranger group started
# after the launch and ordering alone refuses none of it. What a new group
# cannot fake is its leader — a group with id N is created by a process with
# pid N, and a leader at the wrong instant is a new group wearing this
# launch's number. Moving the recorded launch into the past makes the live
# group exactly that stranger.
plan "$ROOT/p-recycle2.json" "mode=slow"
AT_RECYCLE2="$(SELF attempt register "$ROOT/p-recycle2.json")"
launch "$AT_RECYCLE2" --abandon --pidfile="$ROOT/recycle2-pid" > /dev/null || fail "the post-launch recycle launch was never claimed"
RECYCLE2_PID="$(cat "$ROOT/recycle2-pid")"
node -e 'const fs=require("fs");const f=process.argv[1];const o=JSON.parse(fs.readFileSync(f,"utf8"));const past=new Date(Date.now()-3600000).toISOString();o.startedAt=past;o.leaderStartedAt=past;fs.writeFileSync(f,JSON.stringify(o,null,2))' "$(spool_of "$AT_RECYCLE2")/owner.json"
CONTAIN2="$(SELF attempt cancel "$AT_RECYCLE2")"
echo "$CONTAIN2" | grep -q "no signal was sent" || fail "containment was aimed at a group recycled after this launch emptied it"
kill -0 "$RECYCLE2_PID" 2>/dev/null || fail "a stranger group younger than the recorded launch was signalled by this attempt's cancel"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_RECYCLE2")" = "exited-unreconciled" ] || fail "an attempt whose group was recycled after its launch was left claiming a live owner"
[ "$(exit_record "$AT_RECYCLE2")" = "vanished" ] || fail "a group recycled after the launch was counted as this launch's own"
kill -0 "$RECYCLE2_PID" 2>/dev/null || fail "recovery contained a group this launch does not own"
kill -9 "$RECYCLE2_PID" 2>/dev/null || true

# one live owner per work unit. Two owners driving one unit would each publish
# and each attach a report against the same outcome, and neither would know.
plan "$ROOT/p-lease.json" "mode=slow"
AT_LEASE="$(SELF attempt register "$ROOT/p-lease.json")"
plan "$ROOT/p-lease2.json" "mode=slow"
AT_LEASE2="$(SELF attempt register "$ROOT/p-lease2.json")"
launch "$AT_LEASE" --abandon --pidfile="$ROOT/lease-pid" > /dev/null || fail "the leasing launch was never claimed"
LEASE_PID="$(cat "$ROOT/lease-pid")"
# a claim records the identity every later ownership question is answered
# from: the payload's pid and instant, and the group leader's instant. A
# claim the process table could not time is refused at claim, so no owner
# record without them can exist.
node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(typeof o.pid!=="number"||typeof o.startedAt!=="string"||typeof o.leaderStartedAt!=="string"){process.exit(1);}' "$(spool_of "$AT_LEASE")/owner.json" || fail "a claim was taken without the identity the recycled-group guard is built on"
# a live external owner holds the work unit it is driving: the claim below is
# refused for exactly that reason
CONTENDER="$(SELF attempt started "$AT_LEASE2" --pid "$LEASE_PID" 2>&1 || true)"
echo "$CONTENDER" | grep -q "already being driven by attempt $AT_LEASE" || fail "a second owner was allowed to drive a work unit already being driven"
[ "$(attempt_state "$AT_LEASE2")" = "registered" ] || fail "a refused claim still moved the attempt out of registered"
SELF attempt cancel "$AT_LEASE" | grep -q "has been signalled" || fail "cancelling an externally launched attempt did not reach the group it was launched in"
for _ in $(seq 1 200)
do
    kill -0 "$LEASE_PID" 2>/dev/null || break
    sleep 0.1
done
kill -0 "$LEASE_PID" 2>/dev/null && fail "cancelling an externally launched attempt left its process running and spending"
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_LEASE")" = "exited-unreconciled" ] || fail "a cancelled external attempt was not settled by recovery"
# and settling the attempt that held the work unit released it: a fresh claim
# of the same unit is admitted now
RECLAIM_PID="$(node -e 'const p=require("child_process").spawn("sleep",["60"],{detached:true,stdio:"ignore"});p.unref();console.log(p.pid)')"
SELF attempt started "$AT_LEASE2" --pid "$RECLAIM_PID" > /dev/null || fail "settling the attempt that held the work unit did not release it"
SELF attempt exited "$AT_LEASE2" --code 1 > /dev/null 2>&1 || true
kill -9 "$RECLAIM_PID" 2>/dev/null || true

# an artifact claimed in prose with no file behind it fails the gate
REPORTS_BEFORE="$(count_events report.added)"
plan "$ROOT/p-prose.json" "mode=prose" "dest=$ROOT/dest/prose.md"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-prose.json" "$ROOT/dest/prose.md"
PROSE="$(SELF attempt run "$ROOT/p-prose.json" 2>&1 || true)"
echo "$PROSE" | grep -q "claimed in the result envelope but no file was written" || fail "a prose artifact claim passed the completion gate"
[ -f "$ROOT/dest/prose.md" ] && fail "a failed gate published an artifact"

# a declared hash that does not match, and a declared validation that fails
plan "$ROOT/p-hash.json" "mode=mismatch" "dest=$ROOT/dest/hash.md"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-hash.json" "$ROOT/dest/hash.md"
HASH="$(SELF attempt run "$ROOT/p-hash.json" 2>&1 || true)"
echo "$HASH" | grep -q "hashes to" || fail "a hash mismatch passed the completion gate"
plan "$ROOT/p-valid.json" "mode=badvalidate" "dest=$ROOT/dest/valid.md" "validate=$ROOT/validate.mjs"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-valid.json" "$ROOT/dest/valid.md"
VALID="$(SELF attempt run "$ROOT/p-valid.json" 2>&1 || true)"
echo "$VALID" | grep -q "declared validation of \"design.md\" failed" || fail "a failed declared validation passed the completion gate"
[ -f "$ROOT/dest/valid.md" ] && fail "an artifact that failed its validation stayed published"
[ "$(count_events report.added)" -eq "$REPORTS_BEFORE" ] || fail "a failed completion gate still attached a report"

# the spool redacts what a log must never keep, including a secret the model
# was talked into printing
plan "$ROOT/p-secret.json" "mode=secret" "dest=$ROOT/dest/secret.md"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].dest=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-secret.json" "$ROOT/dest/secret.md"
SELF attempt run "$ROOT/p-secret.json" > /dev/null || fail "the redaction attempt did not complete"
AT_SECRET="$(last_attempt)"
SPOOL_SECRET="$ROOT/A/home/.local/state/superself/runner/attempts/$AT_SECRET"
# the shell and header forms, and the JSON forms the spool itself writes: a
# key's own closing quote sits between its name and the colon, so a rule
# written for NAME=value never reaches a JSON-encoded pair
for LEAK in "sk-live-AAAABBBBCCCCDDDDEEEEFFFF00001111" "abcdefghijklmnopqrstuvwxyz123456" "PROMPTINJECTEDSECRETVALUE" "7fK2xQ9wLm4RtV8yBn3JcZ6pHd5sAe1UgW0oXi2NrTb4Qv" "$ROOT/A/home/private" "JSONPRETTYSECRETVALUE1" "JSONNESTEDSECRETVALUE2" "JSONCOMPACTSECRETVALUE3" "JSONSHORTISHCREDENTIAL4"
do
    grep -q "$LEAK" "$SPOOL_SECRET/run-1.stdout.log" && fail "the spool kept a value a log must redact: $LEAK"
done
grep -q "«redacted»" "$SPOOL_SECRET/run-1.stdout.log" || fail "the spool log was not redacted at all"
# and redaction stops where evidence begins: long output that is plainly not a
# credential survives, or the spool would truncate the results it exists to keep
grep -q "paragraph paragraph" "$SPOOL_SECRET/run-1.stdout.log" || fail "redaction destroyed long output that carried no credential"

# a credential the plan author put in the boundary environment is a literal in
# the plan, so it is in no runner environment the scope could read it from —
# and the spooled plan is written as JSON
plan "$ROOT/p-envsecret.json" "mode=ok" "envsecret=PLANENVSECRETVALUE0001"
SELF attempt run "$ROOT/p-envsecret.json" > /dev/null || fail "the boundary-env secret attempt did not complete"
AT_ENVSECRET="$(last_attempt)"
grep -q "PLANENVSECRETVALUE0001" "$(spool_of "$AT_ENVSECRET")/plan.json" && fail "a secret supplied through boundary.env reached the spooled plan in the clear"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$(spool_of "$AT_ENVSECRET")/plan.json" || fail "redacting the plan left it unreadable — settlement after a crash reads it back"

# and a credential broken across two writes matches nothing on either side of
# the break, so the raw writer holds back what a pattern could still grow into
node "$CLI_DIR/proof/spool-chunks.mjs" || fail "a credential split across chunk boundaries survived the spool's redaction"

# the synced log is committed and pushed, and a capability block names the exact
# path that was missing. The request on that event is already rewritten; the
# list of what is missing has to be too, or one event carries the private path
# both ways
plan "$ROOT/p-privatepath.json" "mode=ok" "read=$HOME/private/secretproject/nothing.key" "marker=$ROOT/ran-privatepath"
SELF attempt run "$ROOT/p-privatepath.json" > /dev/null 2>&1 || true
AT_PRIVATEPATH="$(last_attempt)"
[ "$(attempt_state "$AT_PRIVATEPATH")" = "preflight-failed" ] || fail "a read capability on a missing private path did not block"
grep -q "secretproject" "$LOG_A" || fail "the capability block never reached the synced log"
grep "run.blocked" "$LOG_A" | grep -q "\"read:$HOME/private" && fail "a capability block wrote a raw private home path into the synced log"
grep "run.blocked" "$LOG_A" | grep -q "read:~/private/secretproject" || fail "the missing capability was not named at all once the path was rewritten"

# the lock the machine-local counters are minted under: broken when its holder
# died, never broken out from under a holder that is still there, and never
# released by a process that no longer owns it
node "$CLI_DIR/proof/lock-ownership.mjs" || fail "the counter lock does not hold under contention"

# a declared secret too short to redact by value is said out loud rather than
# left silently uncovered
export PROOF_TINY_SECRET="ab"
plan "$ROOT/p-tiny.json" "mode=ok" "secrets=PROOF_TINY_SECRET"
TINY="$(SELF attempt run "$ROOT/p-tiny.json" 2>&1 || true)"
echo "$TINY" | grep -q "PROOF_TINY_SECRET is shorter than" || fail "a declared secret too short to redact by value was accepted silently"
unset PROOF_TINY_SECRET

# a malformed artifact name is a plan error, not a hash of the staging
# directory at the very end of the run
plan "$ROOT/p-dot.json" "mode=ok" "dest=$ROOT/dest/dot.md"
node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.artifacts[0].name=".";require("fs").writeFileSync(f,JSON.stringify(p))' "$ROOT/p-dot.json"
DOT="$(SELF attempt run "$ROOT/p-dot.json" 2>&1 || true)"
echo "$DOT" | grep -q "must be a single file name" || fail "an artifact named \".\" reached the completion gate instead of the plan validator"

# retention and deletion are configurable, and a spool the person deleted is gone
SELF attempt retention 7 | grep -q "kept for 7 day" || fail "the spool retention window could not be set"
SELF attempt retention | grep -q "^7$" || fail "the spool retention window was not recorded"
SELF attempt prune --days 365 | grep -q "no attempt spool is older" || fail "prune deleted spools inside the retention window"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.updated="2000-01-01T00:00:00.000Z";fs.writeFileSync(f,JSON.stringify(s,null,2))' "$SPOOL_SECRET/status.json"
SELF attempt prune --days 1 | grep -q "deleted 1 attempt spool" || fail "prune did not delete a spool past the retention window"
[ -d "$SPOOL_SECRET" ] && fail "a pruned spool is still on disk"

# an attempt abandoned in `running` that nobody ever recovered is the spool
# most likely to sit there for ever: liveness decides the exemption, not the
# state the spool last managed to write
plan "$ROOT/p-abandon.json" "mode=slow" "idfile=$ROOT/abandon-id"
rm -f "$ROOT/abandon-id"
SELF attempt run "$ROOT/p-abandon.json" > /dev/null 2>&1 &
ABANDON_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/abandon-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/abandon-id" ] || fail "the attempt to be abandoned never started"
AT_ABANDON="$(cat "$ROOT/abandon-id")"
crash_runner "$AT_ABANDON"
wait "$ABANDON_PID" 2>/dev/null || true
SPOOL_ABANDON="$(spool_of "$AT_ABANDON")"
[ "$(attempt_state "$AT_ABANDON")" = "running" ] || fail "the abandoned attempt did not stay in running"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.updated="2000-01-01T00:00:00.000Z";fs.writeFileSync(f,JSON.stringify(s,null,2))' "$SPOOL_ABANDON/status.json"
SELF attempt prune --days 1 | grep -q "deleted 1 attempt spool" || fail "a spool abandoned in running was exempt from retention for ever"
[ -d "$SPOOL_ABANDON" ] && fail "an abandoned spool survived a prune past its retention window"

# a spool with no readable status is the one spool no reader can make an
# attempt out of, and skipping it everywhere left retention unable to reach it
# at all. It is judged by its own age, swept as corrupt, and never resurrected
CORRUPT_OLD="$RUNNER/attempts/at-corrupt-old"
CORRUPT_NEW="$RUNNER/attempts/at-corrupt-new"
mkdir -p "$CORRUPT_OLD/out" "$CORRUPT_NEW/out"
echo "half a run nobody can read" > "$CORRUPT_OLD/run-1.stdout.log"
echo "half a run nobody can read" > "$CORRUPT_NEW/run-1.stdout.log"
touch -t 200001010000 "$CORRUPT_OLD"
SELF attempt list | grep -q "at-corrupt" && fail "a spool with no status was listed as an attempt"
SELF attempt prune --days 1 | grep -q "deleted 1 attempt spool" || fail "retention could not reach a spool with no readable status"
[ -d "$CORRUPT_OLD" ] && fail "a corrupt spool past its retention window is still on disk"
[ -d "$CORRUPT_NEW" ] || fail "a corrupt spool inside the retention window was swept early"
rm -rf "$CORRUPT_NEW"

# blocked and failed attempts leave the attention surface once a later attempt
# on the same unit answers them. An attempt id is never reused, so nothing in
# an append-only log ever goes back to unblock one: without this the list could
# only grow.
STATE_A="$ROOT/A/ws/.superself/projects/demo/state.md"
plan "$ROOT/p-lastblock.json" "mode=ok" "tools=definitely-not-a-real-tool"
SELF attempt run "$ROOT/p-lastblock.json" > /dev/null 2>&1 || true
AT_LASTBLOCK="$(last_attempt)"
[ "$(attempt_state "$AT_LASTBLOCK")" = "preflight-failed" ] || fail "the missing-tool attempt did not block on a capability"
grep -q "attempt $AT_LASTBLOCK is waiting on a capability grant" "$STATE_A" || fail "the newest blocked attempt is not waiting on the person"
grep -q "attempt $AT_DRIFT is waiting on a capability grant" "$STATE_A" && fail "a blocked attempt a later one superseded is still waiting on the person"
grep -q "attempt $AT_CRASH failed" "$STATE_A" && fail "a failed attempt a later one superseded is still a health signal"
SELF work show "$WATT" | grep -q "$AT_CRASH" || fail "a superseded attempt left the work record as well as the attention surface"

# the same accumulation, one surface over: `self status` reads the machine-local
# spools directly, and a spool lives until retention prunes it, so an unfinished
# attempt from weeks ago would keep a line there for a month
SELF status | grep -q "attempt $AT_LASTBLOCK" || fail "self status does not report this machine's unfinished attempts"
node -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.updated=new Date(Date.now()-30*86400000).toISOString();fs.writeFileSync(f,JSON.stringify(s,null,2))' "$(spool_of "$AT_LASTBLOCK")/status.json"
SELF status | grep -q "attempt $AT_LASTBLOCK" && fail "an attempt nothing has touched for a month still holds a line under self status"
SELF attempt list | grep -q "$AT_LASTBLOCK" || fail "the aged-out attempt is no longer reachable from the surface that lists every spool"

echo "attempts OK"
