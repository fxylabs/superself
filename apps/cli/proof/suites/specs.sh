#!/usr/bin/env bash
# Domain suite: declarative work specs — content-addressed generations, sealed
# immutability, pinned dispatch, racing applies and dispatches, and crash
# repair of the spec store. Runs alone: bash proof/suites/specs.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

demo_workspace
mkdir -p "$ROOT/dest"
AGENT="$CLI_DIR/proof/attempt-agent.mjs"
MKPLAN="$CLI_DIR/proof/attempt-plan.mjs"
MKSPEC="$CLI_DIR/proof/workspec.mjs"
RUNNER="$ROOT/A/home/.local/state/superself/runner"
WATT="$(SELF work add "a runner attempt proves its capabilities before it spends one" | tail -1)"
SELF work start "$WATT" > /dev/null
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

# ---------------------------------------------------------------------------
# Declarative work specs. Desired state is applied as an immutable, content-
# addressed generation, and the runner attempt it materializes is pinned to the
# exact generation it was admitted under — so editing intent while a run is in
# flight decides what the next dispatch compiles and nothing about that run.
# ---------------------------------------------------------------------------
WSPEC="$(SELF work add "a work spec materializes one pinned runner attempt" | tail -1)"
SELF work start "$WSPEC" > /dev/null
WHOLD="$(SELF work add "a generation applied mid-attempt never reinterprets it" | tail -1)"
SELF work start "$WHOLD" > /dev/null
SPECS="$STORE/projects/demo/specs"

workspec()
{
    local file="$1"
    shift
    node "$CLI_DIR/proof/workspec.mjs" "$file" "work=$WSPEC" "agent=$AGENT" "cwd=$DEMO" "$@"
}
head_digest()
{
    node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sha256)' "$SPECS/$1/head.json"
}

# an incomplete spec is answered by the field it is missing, and asking leaves
# the log, the tree, and the store commit exactly as they were
workspec "$ROOT/ws-invalid.json" "id=ws-design" "drop=requestedModel"
BEFORE="$(snapshot)"
INVALID="$(SELF spec validate "$ROOT/ws-invalid.json" 2>&1 || true)"
echo "$INVALID" | grep -q 'field "requestedModel"' || fail "an incomplete work spec was not rejected by the field it lacks"
[ "$(snapshot)" = "$BEFORE" ] || fail "validating a rejected spec changed the log, the tree, or the store commit"

# a validation contract has to be one the completion gate can actually enforce
workspec "$ROOT/ws-noval.json" "id=ws-design" "drop=validation"
NOVAL="$(SELF spec validate "$ROOT/ws-noval.json" 2>&1 || true)"
echo "$NOVAL" | grep -q "must declare either" || fail "a spec declaring no validation contract was accepted"
workspec "$ROOT/ws-badstatus.json" "id=ws-design" "badStatus=done"
BADSTATUS="$(SELF spec validate "$ROOT/ws-badstatus.json" 2>&1 || true)"
echo "$BADSTATUS" | grep -q "admits no other result status" || fail "a response schema the completion gate cannot enforce was accepted"

# a valid spec validates without sealing anything
workspec "$ROOT/ws-gen1.json" "id=ws-design" "dest=$ROOT/dest/spec-one.md"
SELF spec validate "$ROOT/ws-gen1.json" | grep -q "generation 1 for $WSPEC is valid" || fail "a complete work spec did not validate"
[ -d "$SPECS/ws-design" ] && fail "validate sealed a generation"

# applying seals exactly one generation, named by the digest of its own bytes,
# and commits it with the event that makes it real
APPLIED_BEFORE="$(count_events spec.applied)"
SELF spec apply "$ROOT/ws-gen1.json" | grep -q "generation 1 applied" || fail "a valid work spec did not apply"
[ "$(count_events spec.applied)" -eq "$((APPLIED_BEFORE + 1))" ] || fail "applying a work spec did not record exactly one event"
GEN1="$(head_digest ws-design)"
[ -f "$SPECS/ws-design/000001-$GEN1.json" ] || fail "the sealed generation is not named by the digest of its content"
node -e '
const body = require("fs").readFileSync(process.argv[1]);
const digest = require("crypto").createHash("sha256").update(body).digest("hex");
if (digest !== process.argv[2]) { console.error("sealed bytes hash to " + digest); process.exit(1); }
' "$SPECS/ws-design/000001-$GEN1.json" "$GEN1" || fail "the spec store is not content-addressed"
git -C "$STORE" ls-files | grep -q "specs/ws-design/000001-$GEN1.json" || fail "the sealed generation was not committed with its event"

# the same content applied twice is one generation: no second event, no second commit
BEFORE="$(snapshot)"
SELF spec apply "$ROOT/ws-gen1.json" | grep -q "already applied" || fail "re-applying identical content was not idempotent"
[ "$(snapshot)" = "$BEFORE" ] || fail "an idempotent apply still changed the store"

# conflicting content for a generation already sealed is refused outright
workspec "$ROOT/ws-conflict.json" "id=ws-design" "dest=$ROOT/dest/spec-one.md" "model=some-other-model"
CONFLICT="$(SELF spec apply "$ROOT/ws-conflict.json" 2>&1 || true)"
echo "$CONFLICT" | grep -q "is immutable" || fail "conflicting content for a sealed generation was accepted"
[ "$(snapshot)" = "$BEFORE" ] || fail "a refused generation still changed the store"

# generations advance one at a time, so nothing lands on a number nobody sealed
workspec "$ROOT/ws-skip.json" "id=ws-design" "generation=3" "dest=$ROOT/dest/spec-one.md"
SKIP="$(SELF spec apply "$ROOT/ws-skip.json" 2>&1 || true)"
echo "$SKIP" | grep -q "so the next one is 2" || fail "a generation number nothing leads to was accepted"

# a spec names a work unit that exists, and a work unit has one desired-state HEAD
workspec "$ROOT/ws-nowork.json" "id=ws-nowork" "work=w-nosuch" "dest=$ROOT/dest/spec-nowork.md"
NOWORK="$(SELF spec apply "$ROOT/ws-nowork.json" 2>&1 || true)"
echo "$NOWORK" | grep -q "unknown work id" || fail "a work spec naming no work unit was sealed"
workspec "$ROOT/ws-second.json" "id=ws-second" "dest=$ROOT/dest/spec-second.md"
SECOND="$(SELF spec apply "$ROOT/ws-second.json" 2>&1 || true)"
echo "$SECOND" | grep -q "already has work spec ws-design" || fail "a second work spec claimed a work unit that already has one"

# a spec id is not a path: one that would leave the project's state is refused
workspec "$ROOT/ws-escape.json" "id=../escape" "dest=$ROOT/dest/spec-escape.md"
ESCAPE="$(SELF spec apply "$ROOT/ws-escape.json" 2>&1 || true)"
echo "$ESCAPE" | grep -q "single path segment" || fail "a work spec id that leaves the project's state was accepted"
[ -d "$STORE/projects/escape" ] && fail "a hostile spec id sealed a generation outside the specs root"

# a spec nobody applied materializes nothing
UNKNOWN="$(SELF spec dispatch ws-nothing 2>&1 || true)"
echo "$UNKNOWN" | grep -q "no work spec" || fail "dispatching a spec that was never applied was not refused"

# dispatch compiles the current generation into an attempt plan, runs it down
# the existing runner path, and settles through the same gate: one report on
# the work unit, the declared artifact published, the generation on the record
REPORTS_BEFORE="$(count_events report.added)"
DISPATCHED_BEFORE="$(count_events spec.dispatched)"
SELF spec dispatch ws-design > /dev/null || fail "dispatching the current generation did not complete"
AT_SPEC="$(SELF attempt list --work "$WSPEC" | awk '{print $1}' | tail -1)"
[ "$(attempt_state "$AT_SPEC")" = "completed" ] || fail "a dispatched attempt did not complete"
[ -f "$ROOT/dest/spec-one.md" ] || fail "the artifact the spec declared was not published"
[ "$(count_events report.added)" -eq "$((REPORTS_BEFORE + 1))" ] || fail "a dispatched attempt did not attach exactly one report"
[ "$(count_events spec.dispatched)" -eq "$((DISPATCHED_BEFORE + 1))" ] || fail "a dispatch recorded no spec event"
SELF work show "$WSPEC" | grep -q "$AT_SPEC (completed)" || fail "the work record does not carry the attempt its spec materialized"
node -e '
const record = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const pin = record.spec;
if (pin === undefined) { console.error("the attempt record carries no spec pin"); process.exit(1); }
if (pin.workSpec !== "ws-design" || pin.generation !== 1 || pin.sha256 !== process.argv[2]) { console.error("pinned to " + JSON.stringify(pin)); process.exit(1); }
if (pin.requestedModel !== "opus-5") { console.error("the model the spec asked for was not recorded"); process.exit(1); }
' "$(spool_of "$AT_SPEC")/attempt.json" "$GEN1" || fail "dispatch did not pin the attempt to the generation it was admitted under"

# a declared blocker gates dispatch and nothing else: the spec still applies
# while the work waits, and no spec.dispatched event is spent on a refusal
DISPATCHED_BEFORE="$(count_events spec.dispatched)"
SELF work block "$WSPEC" --on dependency --why "the upstream artifact is not published yet" > /dev/null
BLOCKED="$(SELF spec dispatch ws-design 2>&1 || true)"
echo "$BLOCKED" | grep -q "blocked on dependency" || fail "a work unit blocked on a dependency was still materialized"
[ "$(count_events spec.dispatched)" -eq "$DISPATCHED_BEFORE" ] || fail "a refused dispatch still recorded a spec event"
workspec "$ROOT/ws-gen2.json" "id=ws-design" "generation=2" "dest=$ROOT/dest/spec-one.md" "summary=desired state prepared while the work waits"
SELF spec apply "$ROOT/ws-gen2.json" | grep -q "generation 2 applied" || fail "a blocked work unit refused the next generation of its desired state"
SELF work unblock "$WSPEC" > /dev/null

# a generation applied while an attempt is in flight moves HEAD for the next
# dispatch and leaves the live attempt on the generation that admitted it
workspec "$ROOT/ws-hold.json" "id=ws-hold" "work=$WHOLD" "mode=hold" "gate=$ROOT/spec-gate" "idfile=$ROOT/spec-hold-id"
SELF spec apply "$ROOT/ws-hold.json" > /dev/null || fail "the held generation did not apply"
HOLD1="$(head_digest ws-hold)"
rm -f "$ROOT/spec-hold-id" "$ROOT/spec-gate"
SELF spec dispatch ws-hold > /dev/null &
HOLD_PID=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/spec-hold-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/spec-hold-id" ] || fail "the held attempt never reached the provider"
AT_HOLD="$(cat "$ROOT/spec-hold-id")"

# one work unit materializes one attempt at a time
BUSY="$(SELF spec dispatch ws-hold 2>&1 || true)"
echo "$BUSY" | grep -q "one work unit materializes one attempt at a time" || fail "a second attempt was dispatched onto a work unit already being driven"

workspec "$ROOT/ws-hold2.json" "id=ws-hold" "work=$WHOLD" "generation=2" "mode=hold" "gate=$ROOT/spec-gate" "summary=the generation that lands mid-attempt"
SELF spec apply "$ROOT/ws-hold2.json" | grep -q "generation 2 applied" || fail "a generation could not be applied while an attempt was running"
HOLD2="$(head_digest ws-hold)"
[ "$HOLD1" = "$HOLD2" ] && fail "the second generation hashed to the first"
touch "$ROOT/spec-gate"
wait "$HOLD_PID" || fail "the held attempt did not complete once it was released"
[ "$(attempt_state "$AT_HOLD")" = "completed" ] || fail "the attempt that ran across an apply did not complete"
node -e '
const pin = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).spec;
if (pin.generation !== 1 || pin.sha256 !== process.argv[2]) { console.error("a later generation reinterpreted a live attempt: " + JSON.stringify(pin)); process.exit(1); }
' "$(spool_of "$AT_HOLD")/attempt.json" "$HOLD1" || fail "an apply mid-attempt changed what the live attempt was admitted under"
[ -f "$SPECS/ws-hold/000001-$HOLD1.json" ] || fail "a superseded generation was edited or deleted"

# work to generation to attempts, by stable id
SELF spec list | grep -q "ws-design  $WSPEC  generation 2" || fail "spec list does not resolve a spec to its work and generation"
SHOW="$(SELF spec show ws-hold)"
echo "$SHOW" | grep -q "ws-hold  $WHOLD  generation 2" || fail "spec show does not name the work unit and the current generation"
echo "$SHOW" | grep -q "model opus-5" || fail "spec show does not name the model the spec asks for"
echo "$SHOW" | grep -q "$AT_HOLD  generation 1" || fail "spec show does not resolve which generation an attempt ran under"

# a sealed generation that no longer hashes to its own name is refused on the
# read path: the immutability the contract rests on has already been lost
GEN2="$(head_digest ws-design)"
SEALED_BLOB="$SPECS/ws-design/000002-$GEN2.json"
cp "$SEALED_BLOB" "$ROOT/sealed-backup.json"
node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace("opus-5","opus-6"))' "$SEALED_BLOB"
TAMPERED_SHOW="$(SELF spec show ws-design 2>&1 || true)"
echo "$TAMPERED_SHOW" | grep -q "sealed content was modified" || fail "spec show read a sealed generation whose bytes were modified"
TAMPERED_DISPATCH="$(SELF spec dispatch ws-design 2>&1 || true)"
echo "$TAMPERED_DISPATCH" | grep -q "sealed content was modified" || fail "spec dispatch compiled a sealed generation whose bytes were modified"
cp "$ROOT/sealed-backup.json" "$SEALED_BLOB"
SELF spec show ws-design > /dev/null || fail "restoring the sealed bytes did not restore the spec"

# a hand-written plan file cannot smuggle a spec pin: the pin says what the
# spec store admitted, and only dispatch may write it
plan "$ROOT/p-forged.json" "mode=ok" "dest=$ROOT/dest/forged.md"
node -e 'const fs=require("fs");const f=process.argv[1];const p=JSON.parse(fs.readFileSync(f,"utf8"));p.spec={workSpec:"ws-design",generation:99,sha256:"deadbeef".repeat(8),requestedModel:"opus-5"};fs.writeFileSync(f,JSON.stringify(p))' "$ROOT/p-forged.json"
SELF attempt run "$ROOT/p-forged.json" > /dev/null || fail "a plan carrying a forged pin did not run at all"
AT_FORGED="$(last_attempt)"
node -e 'if (JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).spec !== undefined) { console.error("the forged pin reached the attempt record"); process.exit(1); }' "$(spool_of "$AT_FORGED")/attempt.json" || fail "a hand-written plan smuggled a spec pin onto the attempt record"
SELF spec show ws-design | grep -q "$AT_FORGED" && fail "a forged pin surfaced an attempt under spec show"

# two applies racing for one generation number seal exactly one: the loser is
# refused, and the store still answers instead of being poisoned forever
WRACE="$(SELF work add "two racing applies seal exactly one generation" | tail -1)"
SELF work start "$WRACE" > /dev/null
workspec "$ROOT/ws-race-a.json" "work=$WRACE" "id=ws-race" "dest=$ROOT/dest/race.md"
workspec "$ROOT/ws-race-b.json" "work=$WRACE" "id=ws-race" "dest=$ROOT/dest/race.md" "model=some-other-model"
APPLIED_BEFORE="$(count_events spec.applied)"
SELF spec apply "$ROOT/ws-race-a.json" > "$ROOT/race-a.out" 2>&1 &
RACE_A=$!
SELF spec apply "$ROOT/ws-race-b.json" > "$ROOT/race-b.out" 2>&1 &
RACE_B=$!
wait "$RACE_A" && RACE_A_OK=yes || RACE_A_OK=no
wait "$RACE_B" && RACE_B_OK=yes || RACE_B_OK=no
[ "$RACE_A_OK" = yes ] || [ "$RACE_B_OK" = yes ] || fail "neither racing apply sealed the generation"
{ [ "$RACE_A_OK" = yes ] && [ "$RACE_B_OK" = yes ]; } && fail "two racing applies of different content both claimed generation 1"
[ "$(find "$SPECS/ws-race" -name '000001-*.json' | wc -l | tr -d ' ')" -eq 1 ] || fail "racing applies left two sealed blobs for one generation"
[ "$(count_events spec.applied)" -eq "$((APPLIED_BEFORE + 1))" ] || fail "racing applies recorded more or less than one spec.applied event"
SELF spec show ws-race > /dev/null || fail "the spec store no longer answers after racing applies"

# a crash between the generation blob and the HEAD advance leaves a store the
# next apply completes — never one it misreads as already applied and wedges
WCRASH="$(SELF work add "an interrupted apply is completed, not misread" | tail -1)"
SELF work start "$WCRASH" > /dev/null
workspec "$ROOT/ws-crash1.json" "work=$WCRASH" "id=ws-crash" "dest=$ROOT/dest/crash.md"
SELF spec apply "$ROOT/ws-crash1.json" > /dev/null || fail "the pre-crash generation did not apply"
workspec "$ROOT/ws-crash2.json" "work=$WCRASH" "id=ws-crash" "generation=2" "dest=$ROOT/dest/crash.md" "summary=the generation the crash interrupted"
# the crash, simulated exactly: the blob reached the store, the HEAD advance
# and the spec.applied event did not
CRASH2="$(node -e '
import("file://" + process.argv[1] + "/dist/spec/workspec.js").then((m) =>
{
    const fs = require("fs");
    const spec = m.normalizeSpec(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
    fs.writeFileSync(process.argv[3] + "/000002-" + m.specDigest(spec) + ".json", m.specBody(spec));
    process.stdout.write(m.specDigest(spec));
});' "$CLI_DIR" "$ROOT/ws-crash2.json" "$SPECS/ws-crash")"
[ "$(head_digest ws-crash)" != "$CRASH2" ] || fail "the simulated crash advanced HEAD on its own"
APPLIED_BEFORE="$(count_events spec.applied)"
SELF spec apply "$ROOT/ws-crash2.json" > /dev/null || fail "re-applying across the crash window failed"
[ "$(head_digest ws-crash)" = "$CRASH2" ] || fail "re-apply left HEAD behind the sealed generation"
[ "$(count_events spec.applied)" -eq "$((APPLIED_BEFORE + 1))" ] || fail "completing the interrupted apply did not record its event exactly once"
SELF spec show ws-crash | grep -q "generation 2" || fail "the completed apply does not read at generation 2"
workspec "$ROOT/ws-crash3.json" "work=$WCRASH" "id=ws-crash" "generation=3" "dest=$ROOT/dest/crash.md" "summary=the store advances again after the repair"
SELF spec apply "$ROOT/ws-crash3.json" | grep -q "generation 3 applied" || fail "the spec cannot advance past a repaired crash window"

# two dispatches racing for one work unit materialize exactly one attempt: the
# claim is atomic, and the loser's refusal spends no spec.dispatched event
WDUAL="$(SELF work add "two racing dispatches materialize one attempt" | tail -1)"
SELF work start "$WDUAL" > /dev/null
workspec "$ROOT/ws-dual.json" "work=$WDUAL" "id=ws-dual" "mode=hold" "gate=$ROOT/dual-gate" "idfile=$ROOT/dual-id"
SELF spec apply "$ROOT/ws-dual.json" > /dev/null || fail "the dual-dispatch spec did not apply"
DISPATCHED_BEFORE="$(count_events spec.dispatched)"
rm -f "$ROOT/dual-id" "$ROOT/dual-gate"
SELF spec dispatch ws-dual > "$ROOT/dual-a.out" 2>&1 &
DUAL_A=$!
SELF spec dispatch ws-dual > "$ROOT/dual-b.out" 2>&1 &
DUAL_B=$!
for _ in $(seq 1 200)
do
    [ -s "$ROOT/dual-id" ] && break
    sleep 0.1
done
[ -s "$ROOT/dual-id" ] || fail "neither racing dispatch materialized an attempt"
touch "$ROOT/dual-gate"
wait "$DUAL_A" && DUAL_A_OK=yes || DUAL_A_OK=no
wait "$DUAL_B" && DUAL_B_OK=yes || DUAL_B_OK=no
[ "$DUAL_A_OK" = yes ] || [ "$DUAL_B_OK" = yes ] || fail "neither racing dispatch completed"
{ [ "$DUAL_A_OK" = yes ] && [ "$DUAL_B_OK" = yes ]; } && fail "two racing dispatches both materialized an attempt on one work unit"
[ "$(SELF attempt list --work "$WDUAL" | wc -l | tr -d ' ')" -eq 1 ] || fail "racing dispatches left two attempts on one work unit"
cat "$ROOT/dual-a.out" "$ROOT/dual-b.out" | grep -q "one work unit materializes one attempt at a time" || fail "the losing dispatch was not refused by the one-attempt rule"
[ "$(count_events spec.dispatched)" -eq "$((DISPATCHED_BEFORE + 1))" ] || fail "racing dispatches spent more than one spec.dispatched event"

echo "specs OK"
