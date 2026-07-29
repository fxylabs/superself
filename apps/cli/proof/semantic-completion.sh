#!/usr/bin/env bash
# Semantic completion, kept apart from physical completion. Every case here is
# a statement about the one check `self work done` is admitted by: what the
# unit had to cover, who had to approve it, and what its implementation had to
# be — none of which a passing attempt ever settles on its own.
#
# This builds its own machine root, the way the supervision proof does: the
# cases dispatch real attempts, run a supervision tick, and open a pseudo
# terminal for a human approval, and none of that may reach the machine the
# proof is run on.
set -euo pipefail

CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(mktemp -d)"

SELF_JS="$CLI_DIR/bin/self.mjs"
AGENT="$CLI_DIR/proof/daemon-agent.mjs"
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

# The markers the runner sets on every child it starts. This proof drives the
# CLI as a person would, so it must not inherit an attempt marker from whatever
# started it — the approval gate reads exactly these.
unset SUPERSELF_SESSION SUPERSELF_ATTEMPT_ID || true

cd "$ROOT/A/ws"
SELF init --agents > /dev/null
cd "$ROOT/A/ws/demo"
git init -q
git commit -q --allow-empty -m "base"
MAIN0="$(git rev-parse HEAD)"
SELF project add --name demo --desc "semantic completion harness" > /dev/null
SELF goal set "prove semantic completion is separate from physical completion" > /dev/null

STORE="$ROOT/A/ws/.superself"
LOG="$STORE/projects/demo/log.jsonl"
DEMO="$ROOT/A/ws/demo"

count_events()
{
    grep -c "\"type\":\"$1\"" "$LOG" || true
}
# Events of one type about one work unit, counted by the fields rather than by
# a substring: every event a unit records carries its id.
count_for()
{
    node -e '
const fs = require("node:fs");
const [file, type, work] = process.argv.slice(1);
const events = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
process.stdout.write(String(events.filter((e) => e.type === type && (e.refs?.work === work || e.payload?.work === work)).length));
' "$LOG" "$1" "$2"
}
work_status()
{
    SELF work show "$1" | node -e '
let text = "";
process.stdin.on("data", (chunk) => { text += chunk; });
process.stdin.on("end", () => process.stdout.write((text.match(/^- Status: (\S+)/m) ?? ["", "none"])[1]));
'
}
# The requirements a unit still owes, read off the page a person reads.
uncovered()
{
    SELF work show "$1" | grep -c "_(uncovered)_" || true
}
attempts_of()
{
    SELF attempt list --work "$1" --json | node -e '
const s = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
process.stdout.write(s.map((a) => a.attempt).join("\n"));
'
}
attempt_state()
{
    SELF attempt list --json | node -e '
const s = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
process.stdout.write(s.find((a) => a.attempt === process.argv[1])?.state ?? "none");
' "$1"
}
workspec()
{
    local file="$1"
    shift
    node "$MKSPEC" "$file" "agent=$AGENT" "cwd=$DEMO" "$@"
}
sha256_of()
{
    if command -v shasum > /dev/null 2>&1
    then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        sha256sum "$1" | cut -d' ' -f1
    fi
}
# A refusal is one line the person can act on. Anything that spans lines is a
# stack trace or a wall of prose, and neither is an answer.
one_line()
{
    [ "$(printf '%s' "$1" | grep -c '')" = "1" ] || fail "a refusal was not one line: $1"
    printf '%s' "$1" | grep -q "^error: " || fail "a refusal was not a clean CLI error: $1"
}
# One supervision pass, machine-readable. A tick that settles an attempt runs
# the completion gate, and the gate speaks for itself on stdout, so the summary
# is the last line rather than the whole of it.
tick_json()
{
    SELF daemon tick --json 2>/dev/null | tail -1
}
wake_outcome()
{
    node -e '
const s = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
process.stdout.write(s.wakes.find((w) => w.workSpec === process.argv[1])?.outcome ?? "none");
' "$1"
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

# ---------------------------------------------------------------------------
# A unit that declares nothing keeps the behaviour it always had
# ---------------------------------------------------------------------------
WPLAIN="$(SELF work add "a unit with no declared requirements closes as it always did" | tail -1)"
SELF work start "$WPLAIN" > /dev/null
SELF work done "$WPLAIN" > /dev/null || fail "done was refused on a unit that declares nothing"
[ "$(work_status "$WPLAIN")" = "done" ] || fail "a unit with no requirements did not reach done"

# ---------------------------------------------------------------------------
# An uncovered requirement refuses done, and names itself
# ---------------------------------------------------------------------------
WREQ="$(SELF work add "the coverage check gates done" | tail -1)"
SELF work start "$WREQ" > /dev/null
R1="$(SELF work require "$WREQ" "the refusal names the uncovered requirement" | tail -1)"
R2="$(SELF work require "$WREQ" "coverage names evidence already attached to the unit" | tail -1)"
[ "$R1" = "r1" ] && [ "$R2" = "r2" ] || fail "requirement ids are not the milestone criterion's own shape"

REFUSED="$(SELF work done "$WREQ" 2>&1 || true)"
one_line "$REFUSED"
echo "$REFUSED" | grep -q "$R1" || fail "the refusal did not name the uncovered requirement"
echo "$REFUSED" | grep -q "the refusal names the uncovered requirement" || fail "the refusal did not say what the requirement asks for"
[ "$(count_for work.done "$WREQ")" = "0" ] || fail "a refused done still reached the log"
[ "$(work_status "$WREQ")" = "active" ] || fail "a refused done moved the work unit"

# coverage names evidence the unit already carries — a citation of bytes nobody
# attached is prose with a hash in it
git commit -q --allow-empty -m "the work this unit did"
EVID="$(git rev-parse HEAD)"
UNATTACHED="$(SELF work met "$WREQ" --requirement "$R1" --why "covered by nothing" --evidence "$EVID" 2>&1 || true)"
one_line "$UNATTACHED"
echo "$UNATTACHED" | grep -q "is not evidence attached to $WREQ" || fail "coverage cited a commit the unit never carried"

NOEVIDENCE="$(SELF work met "$WREQ" --requirement "$R1" --why "just because" 2>&1 || true)"
one_line "$NOEVIDENCE"
echo "$NOEVIDENCE" | grep -q -- "--evidence" || fail "coverage was recorded without naming any evidence"

SELF report "$WREQ" "the coverage check landed" --evidence "$EVID" > /dev/null
SELF work met "$WREQ" --requirement "$R1" --why "the refusal names it, proven at $EVID" --evidence "$EVID" > /dev/null
[ "$(count_for work.covered "$WREQ")" = "1" ] || fail "coverage left no event"

# covering a requirement that does not exist, or twice, refuses idempotently
UNKNOWN="$(SELF work met "$WREQ" --requirement r9 --why "x" --evidence "$EVID" 2>&1 || true)"
one_line "$UNKNOWN"
echo "$UNKNOWN" | grep -q "is not a live requirement of $WREQ" || fail "coverage of a requirement that does not exist was admitted"
TWICE="$(SELF work met "$WREQ" --requirement "$R1" --why "again" --evidence "$EVID" 2>&1 || true)"
one_line "$TWICE"
echo "$TWICE" | grep -q "already covered" || fail "a requirement was covered twice"
[ "$(count_for work.covered "$WREQ")" = "1" ] || fail "a refused coverage still reached the log"

# one requirement left, so done is still refused — and naming only that one
STILL="$(SELF work done "$WREQ" 2>&1 || true)"
echo "$STILL" | grep -q "$R2" || fail "the refusal did not name the requirement still open"
echo "$STILL" | grep -q "$R1 " && fail "the refusal named a requirement that is covered"

SELF work met "$WREQ" --requirement "$R2" --why "the evidence is the report attached above" --evidence "$EVID" > /dev/null
SELF work done "$WREQ" > /dev/null || fail "done was refused with every live requirement covered"
[ "$(work_status "$WREQ")" = "done" ] || fail "a fully covered unit did not reach done"

# ---------------------------------------------------------------------------
# A revision returns a covered requirement to uncovered
# ---------------------------------------------------------------------------
WREV="$(SELF work add "a revision invalidates the coverage judged against the older wording" | tail -1)"
SELF work start "$WREV" > /dev/null
RR="$(SELF work require "$WREV" "the first statement" | tail -1)"
SELF report "$WREV" "evidence for the first statement" --evidence "$EVID" > /dev/null
SELF work met "$WREV" --requirement "$RR" --why "covered as first written" --evidence "$EVID" > /dev/null
[ "$(uncovered "$WREV")" = "0" ] || fail "a covered requirement still reads uncovered"

NOTHING="$(SELF work recheck "$WREV" --requirement "$RR" --why "nothing moved" 2>&1 || true)"
one_line "$NOTHING"
echo "$NOTHING" | grep -q "already judged against its current revision" || fail "a recheck with nothing to re-judge was admitted"

SELF work revise "$WREV" --requirement "$RR" --statement "the widened statement" --why "the ask grew" > /dev/null
STALE="$(SELF work done "$WREV" 2>&1 || true)"
one_line "$STALE"
echo "$STALE" | grep -q "$RR" || fail "a revised requirement did not return the unit to not-done-admissible"
echo "$STALE" | grep -q "the widened statement" || fail "the refusal quoted the wording the revision replaced"

POINTS="$(SELF work met "$WREV" --requirement "$RR" --why "x" --evidence "$EVID" 2>&1 || true)"
one_line "$POINTS"
echo "$POINTS" | grep -q "self work recheck $WREV" || fail "stale coverage was not sent to recheck, the way a milestone's is"

SELF work recheck "$WREV" --requirement "$RR" --why "re-judged against the widened statement" --evidence "$EVID" > /dev/null
SELF work done "$WREV" > /dev/null || fail "done was refused after the revision was re-covered"

# a retired requirement asks nothing of anybody
WRET="$(SELF work add "a retired requirement stops gating the unit" | tail -1)"
SELF work start "$WRET" > /dev/null
RT="$(SELF work require "$WRET" "an ask that turned out to be wrong" | tail -1)"
SELF work done "$WRET" > /dev/null 2>&1 && fail "an uncovered requirement did not gate done"
SELF work retire "$WRET" --requirement "$RT" --why "the outcome no longer covers this" > /dev/null
SELF work done "$WRET" > /dev/null || fail "a retired requirement still gated done"

# ---------------------------------------------------------------------------
# A passing attempt settles physically and marks nothing done
# ---------------------------------------------------------------------------
WATT="$(SELF work add "settlement and done are observably separate events" | tail -1)"
SELF work start "$WATT" > /dev/null
RA="$(SELF work require "$WATT" "the attempt's own result covers this" | tail -1)"

# completion prose with no artifact behind it: the run says it wrote the file
# and the gate finds nothing, so nothing is attached and nothing is done
workspec "$ROOT/ws-prose.json" "id=ws-att" "work=$WATT" "dest=$ROOT/dest/prose.md" "mode=prose" \
    "providerName=att-provider" "model=claude-opus-5"
SELF spec apply "$ROOT/ws-prose.json" > /dev/null
SELF spec dispatch ws-att > /dev/null 2>&1 && fail "completion prose passed the gate"
[ -f "$ROOT/dest/prose.md" ] && fail "a run that wrote nothing published an artifact"
[ "$(count_for report.added "$WATT")" = "0" ] || fail "completion prose attached a report"
[ "$(count_for work.done "$WATT")" = "0" ] || fail "completion prose marked work done"

# and now a fully valid passing attempt: it publishes, verifies, attaches its
# report and frees the unit — and the unit is still active with its requirement
# untouched, because none of that is a statement about the outcome
workspec "$ROOT/ws-pass.json" "id=ws-att" "generation=2" "work=$WATT" "dest=$ROOT/dest/pass.md" \
    "providerName=att-provider" "model=claude-opus-5"
SELF spec apply "$ROOT/ws-pass.json" > /dev/null
PASSED="$(SELF spec dispatch ws-att 2>&1)" || fail "a valid run did not pass the gate"
[ -f "$ROOT/dest/pass.md" ] || fail "the passing attempt published no artifact"
[ "$(count_for report.added "$WATT")" = "1" ] || fail "the passing attempt attached no report"
[ "$(count_events run.completed)" -ge 1 ] || fail "the passing attempt recorded no completion"
[ "$(count_for work.done "$WATT")" = "0" ] || fail "a passing attempt marked work done"
[ "$(work_status "$WATT")" = "active" ] || fail "a passing attempt moved the work unit out of active"
[ "$(uncovered "$WATT")" = "1" ] || fail "settlement quietly covered a requirement"

# settlement is where a person finds out what the unit still owes: the runner
# reaches the same check `self work done` is refused by
echo "$PASSED" | grep -q "$WATT is not done" || fail "settlement did not say the work unit is not done"
echo "$PASSED" | grep -q "$RA" || fail "settlement did not name what the unit still owes"

AT_PASS="$(attempts_of "$WATT" | tail -1)"
SELF work show "$WATT" | grep -q "model claude-opus-5" || fail "the attempt did not record the runtime it ran under"

# ---------------------------------------------------------------------------
# A supervision tick settles the same way, and writes nothing beyond it
# ---------------------------------------------------------------------------
# The launcher reports the exit and dies inside the completion gate, so the
# settlement that reaches the work unit is the supervisor's own rather than a
# runner's — which is the case the contract is about: a tick that settles a
# passing attempt writes what settlement writes, and nothing else.
WTICK="$(SELF work add "a tick that settles a passing attempt leaves the unit uncovered" | tail -1)"
SELF work start "$WTICK" > /dev/null
RK="$(SELF work require "$WTICK" "a supervision pass never covers this for anybody" | tail -1)"
node "$CLI_DIR/proof/attempt-plan.mjs" "$ROOT/plan-tick.json" "agent=$AGENT" "cwd=$DEMO" \
    "work=$WTICK" "dest=$ROOT/dest/tick.md"
AT_TICK="$(SELF attempt register "$ROOT/plan-tick.json" | tail -1)"
node "$CLI_DIR/proof/daemon-launch.mjs" "$SELF_JS" "$AT_TICK" \
    "$XDG_STATE_HOME/superself/runner/attempts/$AT_TICK" "$DEMO" --crash-in-settlement > /dev/null 2>&1
[ "$(count_for report.added "$WTICK")" = "0" ] || fail "the crashed settlement attached a report"

SETTLED="$(tick_json | node -e '
const s = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
process.stdout.write(String(s.settled));
')"
[ "$SETTLED" = "1" ] || fail "the tick did not settle the confirmed exit (settled $SETTLED)"
[ "$(attempt_state "$AT_TICK")" = "completed" ] || fail "the settled attempt did not reach completed"
[ "$(count_events run.released)" -ge 1 ] || fail "the tick released nothing"
[ "$(count_for report.added "$WTICK")" = "1" ] || fail "the settled attempt attached no report"
[ "$(count_for work.done "$WTICK")" = "0" ] || fail "a tick that settled an attempt marked work done"
[ "$(work_status "$WTICK")" = "active" ] || fail "a tick moved a work unit its attempt only freed"
[ "$(uncovered "$WTICK")" = "1" ] || fail "a tick covered a requirement nobody judged"
[ "$(count_for work.covered "$WTICK")" = "0" ] || fail "a tick recorded coverage"

# ---------------------------------------------------------------------------
# A unit that waits on a person waits for everybody
# ---------------------------------------------------------------------------
WAPP="$(SELF work add "approval gates both dispatch and done" | tail -1)"
SELF work start "$WAPP" > /dev/null
SELF work approval-required "$WAPP" --why "a person decides whether this ships" > /dev/null
workspec "$ROOT/ws-appr.json" "id=ws-appr" "work=$WAPP" "dest=$ROOT/dest/appr.md" \
    "providerName=appr-provider" "model=claude-opus-5"
SELF spec apply "$ROOT/ws-appr.json" > /dev/null

WAKE="$(tick_json | wake_outcome ws-appr)"
[ "$WAKE" = "awaiting-approval" ] || fail "the wake dispatched work waiting on a person (outcome $WAKE)"
[ -z "$(attempts_of "$WAPP")" ] || fail "work awaiting approval materialized an attempt"

DISPATCH="$(SELF spec dispatch ws-appr 2>&1 || true)"
one_line "$DISPATCH"
echo "$DISPATCH" | grep -q "requires human approval" || fail "a hand-typed dispatch ignored the approval the wake honours"

DONE="$(SELF work done "$WAPP" 2>&1 || true)"
one_line "$DONE"
echo "$DONE" | grep -q "requires human approval" || fail "done did not name the missing approval"

# an approval from a run carrying the attempt marker is refused before the
# prompt is reached: an agent asked to approve its own work is answered here
INSIDE="$(SUPERSELF_SESSION=at-proof SUPERSELF_ATTEMPT_ID=at-proof SELF work approve "$WAPP" 2>&1 || true)"
one_line "$INSIDE"
echo "$INSIDE" | grep -q "cannot be approved from an agent attempt" || fail "an agent attempt minted a human approval"
[ "$(count_for work.approved "$WAPP")" = "0" ] || fail "a refused approval reached the log"

# and so is one with no terminal at all
PIPED="$(SELF work approve "$WAPP" < /dev/null 2>&1 || true)"
one_line "$PIPED"
echo "$PIPED" | grep -q "human_gate_unavailable" || fail "a piped approval was admitted"

# under a real terminal, the typed challenge is what grants it
pty_self()
{
    local typed="$1"
    shift
    if script --version > /dev/null 2>&1
    then
        { printf '%s\n' "$typed"; sleep 3; } | script -qec "node $SELF_JS $*" /dev/null > /dev/null 2>&1 || true
    else
        { printf '%s\n' "$typed"; sleep 3; } | script -q /dev/null node "$SELF_JS" "$@" > /dev/null 2>&1 || true
    fi
}

if command -v script > /dev/null 2>&1
then
    pty_self wrong-answer work approve "$WAPP"
    [ "$(count_for work.approved "$WAPP")" = "0" ] || fail "a failed typed challenge still approved"
    pty_self "$WAPP" work approve "$WAPP" --by maintainer
    [ "$(count_for work.approved "$WAPP")" = "1" ] || fail "a typed approval at a real terminal was not recorded"
    SELF work show "$WAPP" | grep -q "Approval: granted" || fail "the granted approval is not visible on \`self work show\`"

    # the same durable state, read again from a cold process: an approval
    # survives a restart because it is an event, not a flag somebody held
    [ "$(tick_json | wake_outcome ws-appr)" = "woken" ] || fail "an approved unit was still held back by the wake"
    await '[ "$(attempt_state "$(attempts_of "'"$WAPP"'" | tail -1)")" = "completed" ]' \
        || fail "the approved dispatch never completed"
    SELF daemon tick > /dev/null 2>&1
    SELF work done "$WAPP" > /dev/null || fail "done was refused on an approved unit that owes nothing else"
else
    echo "note: no script(1) on this machine — the typed approval row was not run here" >&2
fi

# ---------------------------------------------------------------------------
# A completion policy is enforced inside the check, with no chat turn active
# ---------------------------------------------------------------------------
WPOL="$(SELF work add "a hard-model implementation and a fresh-session review" | tail -1)"
SELF work start "$WPOL" > /dev/null
SELF work policy "$WPOL" --model opus --fresh-review --why "the overnight case has nobody watching" > /dev/null

NOATTEMPT="$(SELF work done "$WPOL" 2>&1 || true)"
one_line "$NOATTEMPT"
echo "$NOATTEMPT" | grep -q "completion policy and no settled attempt ran under it" || fail "a policy-bearing unit closed with no settled attempt"

# an attempt that ran under another model does not answer for the policy
workspec "$ROOT/ws-soft.json" "id=ws-pol" "work=$WPOL" "dest=$ROOT/dest/soft.md" \
    "providerName=pol-provider" "model=claude-haiku-4-5"
SELF spec apply "$ROOT/ws-soft.json" > /dev/null
SELF spec dispatch ws-pol > /dev/null || fail "the soft-model run did not pass the gate"
WRONGMODEL="$(SELF work done "$WPOL" 2>&1 || true)"
one_line "$WRONGMODEL"
echo "$WRONGMODEL" | grep -q "claude-haiku-4-5" || fail "the refusal did not say what the settled attempt actually ran under"

# the hard-model one does
workspec "$ROOT/ws-hard.json" "id=ws-pol" "generation=2" "work=$WPOL" "dest=$ROOT/dest/hard.md" \
    "providerName=pol-provider" "model=claude-opus-5"
SELF spec apply "$ROOT/ws-hard.json" > /dev/null
SELF spec dispatch ws-pol > /dev/null || fail "the hard-model run did not pass the gate"
NOREVIEW="$(SELF work done "$WPOL" 2>&1 || true)"
one_line "$NOREVIEW"
echo "$NOREVIEW" | grep -q "fresh-session review policy" || fail "the model policy was satisfied and the review policy was not asked"

# a receipt exists only through `self review ingest`, and it names the unit it
# reviewed because the change set it was bound to does
git checkout -q -b policy-branch
echo "// the policy work" >> policy.ts
git add policy.ts
git commit -q -m "policy work"
HPOL="$(git rev-parse HEAD)"
git checkout -q main
CSPOL="$(SELF integration register --repo demo --base "$MAIN0" --head "$HPOL" --work "$WPOL" --check ci | tail -1)"
DPOL="$(SELF integration show "$CSPOL" --json | node -e '
process.stdout.write(JSON.parse(require("node:fs").readFileSync(0, "utf8")).digest);
')"

receipt()
{
    local dir="$1" session="$2"
    mkdir -p "$dir"
    echo "a bounded review of the policy work" > "$dir/report.md"
    local sha bytes
    sha="$(sha256_of "$dir/report.md")"
    bytes="$(wc -c < "$dir/report.md" | tr -d ' ')"
    cat > "$dir/envelope.json" <<JSON
{
  "schema": "superself.review-result/1",
  "changeSet": "$CSPOL",
  "scope": "change",
  "base": "$MAIN0",
  "head": "$HPOL",
  "digest": "$DPOL",
  "verdict": "approve",
  "findings": [],
  "tests": [{ "name": "pnpm proof", "status": "pass" }],
  "artifact": { "path": "report.md", "sha256": "$sha", "bytes": $bytes },
  "reviewer": { "name": "review", "model": "claude-opus-5", "session": "$session" },
  "completedAt": "2026-07-29T09:00:00Z"
}
JSON
    SELF review ingest --file "$dir/envelope.json" > /dev/null
}

# the implementer reviewing itself is not a fresh session: the session an
# attempt records is its own id
AT_HARD="$(attempts_of "$WPOL" | tail -1)"
receipt "$ROOT/rev-self" "$AT_HARD"
SELFREVIEW="$(SELF work done "$WPOL" 2>&1 || true)"
one_line "$SELFREVIEW"
echo "$SELFREVIEW" | grep -q "fresh-session review policy" || fail "the implementing attempt reviewed its own work and the policy was satisfied"

receipt "$ROOT/rev-fresh" "at-another-session"
SELF work done "$WPOL" > /dev/null || fail "done was refused with a hard-model attempt and a fresh-session receipt"
[ "$(work_status "$WPOL")" = "done" ] || fail "the policy-bearing unit did not reach done"

# ---------------------------------------------------------------------------
# Every new event crosses the sanitization guard
# ---------------------------------------------------------------------------
# The guard runs before a byte reaches the log, so recording any of the events
# above is already the round trip. What is proven here is the other half: a
# payload that would carry the machine off it is refused, and the refusal costs
# only the command.
WSAN="$(SELF work add "the guard holds on the completion events too" | tail -1)"
SELF work start "$WSAN" > /dev/null
BEFORE="$(wc -l < "$LOG")"
LEAK="$(SELF work require "$WSAN" "read the notes at $HOME/notes.md" 2>&1 || true)"
one_line "$LEAK"
echo "$LEAK" | grep -q "absolute path under this machine's home directory" || fail "a requirement carried a home path into the synced log"
RS="$(SELF work require "$WSAN" "a statement worth syncing" | tail -1)"
SELF report "$WSAN" "evidence" --evidence "$EVID" > /dev/null
CRED="$(SELF work met "$WSAN" --requirement "$RS" --why 'api_key="abcdefghijklmnopqrst"' --evidence "$EVID" 2>&1 || true)"
one_line "$CRED"
echo "$CRED" | grep -q "shaped like a credential" || fail "coverage prose carried a credential into the synced log"
POLICYLEAK="$(SELF work policy "$WSAN" --model opus --why "see $HOME/policy.md" 2>&1 || true)"
one_line "$POLICYLEAK"
[ "$(count_for work.policy-declared "$WSAN")" = "0" ] || fail "a refused policy still reached the log"

# every new event type is in the log, having crossed the guard on the way
for type in work.required work.requirement-revised work.requirement-retired work.covered \
    work.rechecked work.approval-required work.approved work.policy-declared work.done
do
    [ "$(count_events "$type")" -ge 1 ] || fail "no $type event ever crossed the sanitization guard"
done

# ---------------------------------------------------------------------------
# The verbs are parse-guarded like every other verb
# ---------------------------------------------------------------------------
for verb in require revise retire met recheck approval-required approve policy
do
    OUT="$(SELF work "$verb" "$WSAN" --nonsense 2>&1 || true)"
    one_line "$OUT"
    echo "$OUT" | grep -q "self work --help" || fail "\`work $verb\` did not point a bad flag at its own help"
done
SELF work --help | grep -q "work met <id> --requirement" || fail "the completion verbs are missing from the scoped help"
SELF work --help | grep -q "work approve <id>" || fail "the approval verb is missing from the scoped help"
[ "$(count_for work.required "$WSAN")" = "1" ] || fail "a bad flag reached a command body and wrote an event"

echo "semantic completion proof OK"
