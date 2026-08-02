#!/usr/bin/env bash
# Domain suite: runner-owned attempt preparation — the worktree the runner cuts
# at the plan's pinned head, the binding it records, the project's preparation
# template read at that same head, and the settle gate that checks the residue
# and takes the worktree back.
# Runs alone: bash proof/suites/attempt-preparation.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

demo_workspace
RUNNER="$ROOT/A/home/.local/state/superself/runner"
machine A
cd "$DEMO"
WATT="$(SELF work add "the runner prepares an attempt's environment instead of asking the agent to" | tail -1)"
SELF work start "$WATT" > /dev/null

AGENT="$CLI_DIR/proof/prep-agent.mjs"
MKPLAN="$CLI_DIR/proof/attempt-plan.mjs"
SRC="$ROOT/src"
mkdir -p "$ROOT/dest"

command -v git > /dev/null || fail "the proof needs git on PATH to provision a worktree"

# ---------------------------------------------------------------------------
# The repository an attempt builds. Each template lives at a commit of its own,
# and the branch is left standing at the last of them: a plan that pins an
# earlier commit must get that commit's template, not whatever the repository
# happens to be on now.
# ---------------------------------------------------------------------------
mkdir -p "$SRC"
git -C "$SRC" init -q -b main
printf 'pinned-head-body\n' > "$SRC/head.txt"
printf 'prep-order.txt\n' > "$SRC/.gitignore"
cat > "$SRC/prep.mjs" <<'PREP'
// A preparation step of the project under test. Deterministic, and loud in the
// exact ways a real one can be: it fails, it hangs, and it prints far more than
// anything wants to keep.
import { appendFileSync, writeFileSync } from "node:fs";

const arg = process.argv[2] ?? "";
if (arg === "fail")
{
    process.stderr.write("dependencies could not be installed at this head\n");
    process.exit(3);
}
if (arg === "sleep")
{
    writeFileSync(process.env.AGENT_GATE, "started\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
    process.exit(0);
}
if (arg === "leak")
{
    process.stdout.write(`configured with ${process.env.MY_API_KEY ?? "nothing"}\n`);
    process.exit(0);
}
if (arg === "noisy")
{
    for (let i = 0; i < 400; i++)
    {
        process.stdout.write("x".repeat(200) + "\n");
    }
    process.stdout.write("api_key=sk-live-AAAABBBBCCCCDDDDEEEEFFFF00001111\n");
    process.exit(0);
}
appendFileSync("prep-order.txt", arg + "\n");
PREP

template()
{
    cat > "$SRC/.self-preparation.json"
}
commit_at()
{
    git -C "$SRC" add -A
    git -C "$SRC" commit -qm "$1"
    git -C "$SRC" rev-parse HEAD
}

template <<'T'
{
    "version": 1,
    "steps": [
        { "name": "first", "command": ["node", "prep.mjs", "one"], "timeoutMs": 30000 },
        { "name": "second", "command": ["node", "prep.mjs", "two"], "timeoutMs": 30000 }
    ]
}
T
SHA_OK="$(commit_at "a template that prepares in two ordered steps")"

rm "$SRC/.self-preparation.json"
SHA_BARE="$(commit_at "no template at all")"

template <<'T'
{ "steps": [{ "name": "install", "command": ["node", "prep.mjs", "fail"], "timeoutMs": 30000 }] }
T
SHA_FAIL="$(commit_at "a template whose step fails")"

template <<'T'
{ "steps": [{ "name": "deploy", "command": ["pnpm", "install"], "timeoutMs": 30000 }] }
T
SHA_DISALLOWED="$(commit_at "a template that runs a command the plan never declared")"

printf '{ "steps": [ this is not json\n' > "$SRC/.self-preparation.json"
SHA_BADJSON="$(commit_at "a template that is not valid JSON")"

template <<'T'
{ "steps": [{ "name": "install" }] }
T
SHA_NOARGV="$(commit_at "a step with no argv")"

template <<'T'
{ "steps": [{ "command": ["node", "prep.mjs", "one"], "timeoutMs": -5 }] }
T
SHA_BADTIMEOUT="$(commit_at "a step with a negative timeout")"

template <<'T'
{ "steps": [{ "name": "noisy", "command": ["node", "prep.mjs", "noisy"], "timeoutMs": 30000 }] }
T
SHA_NOISY="$(commit_at "a step that prints far more than anything keeps")"

template <<'T'
{ "steps": [{ "name": "leaky", "command": ["node", "prep.mjs", "leak"], "timeoutMs": 30000 }] }
T
SHA_LEAK="$(commit_at "a step that echoes back what it was configured with")"

template <<'T'
{ "steps": [{ "name": "hang", "command": ["node", "prep.mjs", "sleep"], "timeoutMs": 120000 }] }
T
SHA_SLEEP="$(commit_at "a step that never finishes")"

cd "$DEMO"
plan()
{
    local file="$1"
    shift
    node "$MKPLAN" "$file" "work=$WATT" "agent=$AGENT" "cwd=$DEMO" "tools=node,git" "$@"
}
last_attempt()
{
    attempts_of "$WATT" | tail -1
}
# Kills the runner process the attempt recorded, and whatever it started.
# `SELF … &` backgrounds a shell function, so $! is the wrapping subshell: the
# runner would survive it and keep heartbeating, and nothing would look crashed.
crash_runner()
{
    local pid
    pid="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))' "$(spool_of "$1")/status.json")"
    pkill -9 -P "$pid" 2>/dev/null || true
    kill -9 "$pid" 2>/dev/null || true
}
released()
{
    node -e '
const fs = require("node:fs");
const [file, wanted, sample] = process.argv.slice(1);
const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const release = lines.filter((line) => line.event === "workdir.released").pop();
if (release === undefined) { console.error("no workdir.released record"); process.exit(1); }
if (release.removed !== true) { console.error("the worktree was not removed"); process.exit(1); }
if (release.residue !== Number(wanted)) { console.error(`residue ${release.residue}, wanted ${wanted}`); process.exit(1); }
if (sample && !release.sample.join(" ").includes(sample)) { console.error(`residue sample does not name ${sample}`); process.exit(1); }
' "$1" "$2" "${3:-}"
}
# Every refusal has to leave the repository exactly as it found it.
no_worktree_left()
{
    [ -d "$(spool_of "$1")/workdir" ] && fail "$2 left a provisioned worktree behind"
    git -C "$SRC" worktree list | grep -q "$1" && fail "$2 left the attempt's worktree registered in the repository"
    return 0
}

# ---------------------------------------------------------------------------
# The provisioned attempt. The agent is handed a worktree at the pinned head
# with the project's preparation already run in it, and it never prepares or
# cleans up anything itself.
# ---------------------------------------------------------------------------
plan "$ROOT/p-ok.json" "provisionRepo=$SRC" "provisionHead=$SHA_OK" "dest=$ROOT/dest/ok.md" "marker=$ROOT/ran-ok"
SELF attempt run "$ROOT/p-ok.json" > /dev/null || fail "a provisioned attempt did not complete"
AT_OK="$(last_attempt)"
[ "$(attempt_state "$AT_OK")" = "completed" ] || fail "a provisioned attempt did not reach completed"
grep -q "head=pinned-head-body" "$ROOT/dest/ok.md" || fail "the agent was not handed a checkout of the pinned head"
grep -q "order=one,two" "$ROOT/dest/ok.md" || fail "the preparation steps did not run, or did not run in template order"
grep -q "workdir=$(spool_of "$AT_OK")/workdir" "$ROOT/dest/ok.md" || fail "SUPERSELF_ATTEMPT_WORKDIR did not name the provisioned worktree"

# the binding: what this attempt was bound to, as structured data
node -e '
const fs = require("node:fs");
const [file, head, repo, attempt] = process.argv.slice(1);
const b = JSON.parse(fs.readFileSync(file, "utf8"));
const wrong = (why) => { console.error(why); process.exit(1); };
if (b.head !== head) wrong(`binding head ${b.head} is not the pinned head`);
if (b.repo !== repo) wrong("binding does not name the repository it was cut from");
if (b.remote !== null) wrong("binding invented a remote the plan never named");
if (!/^[0-9a-f]{64}$/.test(b.digest)) wrong("binding carries no digest");
if (b.template !== ".self-preparation.json") wrong("binding does not name the template it read");
if (!/^[0-9a-f]{64}$/.test(b.templateSha256)) wrong("binding does not digest the template it read");
if (b.steps !== 2) wrong(`binding recorded ${b.steps} steps`);
if (b.prepared !== true) wrong("binding does not say the preparation finished");
if (!b.workdir.endsWith(`${attempt}/workdir`)) wrong("the workdir is not derived from the attempt id");
' "$(spool_of "$AT_OK")/provision.json" "$SHA_OK" "$SRC" "$AT_OK"

# the step log: each step's command, exit, duration and output, in order
node -e '
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map((line) => JSON.parse(line));
const wrong = (why) => { console.error(why); process.exit(1); };
if (lines.length !== 2) wrong(`${lines.length} step records, wanted 2`);
if (lines[0].step !== 1 || lines[0].name !== "first") wrong("the first step is not recorded first");
if (lines[1].step !== 2 || lines[1].name !== "second") wrong("the second step is not recorded second");
for (const line of lines) {
    if (line.exit !== 0) wrong(`step ${line.step} recorded exit ${line.exit}`);
    if (!Array.isArray(line.command) || line.command[0] !== "node") wrong("a step record does not carry its command");
    if (typeof line.durationMs !== "number") wrong("a step record does not carry its duration");
    if (typeof line.output !== "string") wrong("a step record does not carry its output");
}
' "$(spool_of "$AT_OK")/preparation.jsonl"

SELF attempt show "$AT_OK" | grep -q "^workdir    " || fail "attempt show does not report the worktree the runner bound"
SELF attempt show "$AT_OK" | grep -q "prep 2  second  exit 0" || fail "attempt show does not report the preparation steps"

# the settle gate: the residue check, then the worktree taken back. Preparation
# output the repository ignores is not residue.
released "$(spool_of "$AT_OK")/events.jsonl" 0
no_worktree_left "$AT_OK" "a completed attempt"

# ---------------------------------------------------------------------------
# Work the attempt left unaccounted for is what the residue check is for.
# ---------------------------------------------------------------------------
plan "$ROOT/p-residue.json" "provisionRepo=$SRC" "provisionHead=$SHA_OK" "dest=$ROOT/dest/residue.md" "mode=residue"
SELF attempt run "$ROOT/p-residue.json" > /dev/null || fail "the residue case did not complete"
AT_RESIDUE="$(last_attempt)"
released "$(spool_of "$AT_RESIDUE")/events.jsonl" 1 "left-behind.txt"
no_worktree_left "$AT_RESIDUE" "an attempt that left residue"

# ---------------------------------------------------------------------------
# The worktree comes back from every terminal verdict, not only from a run that
# produced something: a run that wrote no result at all, and a run the
# completion gate refused.
# ---------------------------------------------------------------------------
plan "$ROOT/p-crash.json" "provisionRepo=$SRC" "provisionHead=$SHA_OK" "mode=crashout" "maxRuns=1"
SELF attempt run "$ROOT/p-crash.json" > /dev/null 2>&1 && fail "a run that wrote no result was reported as completed"
AT_CRASH="$(last_attempt)"
[ "$(attempt_state "$AT_CRASH")" = "failed" ] || fail "a run that wrote no result did not fail"
released "$(spool_of "$AT_CRASH")/events.jsonl" 0
no_worktree_left "$AT_CRASH" "a failed run"

plan "$ROOT/p-gate.json" "provisionRepo=$SRC" "provisionHead=$SHA_OK" "dest=$ROOT/dest/gate.md" "mode=mismatch" "maxRuns=1"
SELF attempt run "$ROOT/p-gate.json" > /dev/null 2>&1 && fail "an attempt the gate refuses was reported as completed"
AT_GATE="$(last_attempt)"
[ "$(attempt_state "$AT_GATE")" = "failed" ] || fail "an attempt the gate refuses did not fail"
released "$(spool_of "$AT_GATE")/events.jsonl" 0
no_worktree_left "$AT_GATE" "an attempt the completion gate refused"

# ---------------------------------------------------------------------------
# No template at the pinned head means worktree provisioning alone.
# ---------------------------------------------------------------------------
plan "$ROOT/p-bare.json" "provisionRepo=$SRC" "provisionHead=$SHA_BARE" "dest=$ROOT/dest/bare.md"
SELF attempt run "$ROOT/p-bare.json" > /dev/null || fail "a head with no preparation template did not complete"
AT_BARE="$(last_attempt)"
grep -q "head=pinned-head-body" "$ROOT/dest/bare.md" || fail "a head with no template was not provisioned"
grep -q "order=missing" "$ROOT/dest/bare.md" || fail "a head with no template ran preparation steps anyway"
[ -f "$(spool_of "$AT_BARE")/preparation.jsonl" ] && fail "a head with no template recorded step logs"
no_worktree_left "$AT_BARE" "an attempt with no template"

# ---------------------------------------------------------------------------
# Backward compatibility. A plan that carries no provisioning request is the
# plan every attempt before this was written as, and nothing about it changes:
# no worktree, no binding, and no workdir in the child's environment.
# ---------------------------------------------------------------------------
plan "$ROOT/p-none.json" "dest=$ROOT/dest/none.md"
SELF attempt run "$ROOT/p-none.json" > /dev/null || fail "a plan with no provisioning request did not complete"
AT_NONE="$(last_attempt)"
grep -q '"provision"' "$(spool_of "$AT_NONE")/plan.json" && fail "a plan with no provisioning request grew a provision field when it normalized"
grep -q '"provision"' "$(spool_of "$AT_NONE")/attempt.json" && fail "a plan with no provisioning request grew a provision field on its record"
[ -f "$(spool_of "$AT_NONE")/provision.json" ] && fail "a plan with no provisioning request was bound to a worktree"
[ -d "$(spool_of "$AT_NONE")/workdir" ] && fail "a plan with no provisioning request was given a worktree"
grep -q "workdir=none" "$ROOT/dest/none.md" || fail "a plan with no provisioning request still received SUPERSELF_ATTEMPT_WORKDIR"
grep -q "Where to work" "$(spool_of "$AT_NONE")/brief.md" && fail "an unprovisioned brief tells the agent about a worktree it has not got"
grep -q "Where to work" "$(spool_of "$AT_OK")/brief.md" || fail "a provisioned brief does not tell the agent where to work"

# ---------------------------------------------------------------------------
# A failed preparation step is a preflight failure: the attempt never starts,
# no run is spent, and the step's own record says why.
# ---------------------------------------------------------------------------
plan "$ROOT/p-fail.json" "provisionRepo=$SRC" "provisionHead=$SHA_FAIL" "dest=$ROOT/dest/fail.md" "marker=$ROOT/ran-fail"
FAILED="$(SELF attempt run "$ROOT/p-fail.json" 2>&1 || true)"
echo "$FAILED" | grep -q 'preparation step 1 ("install")' || fail "the refusal did not name the step that failed"
echo "$FAILED" | grep -q "the attempt was not started" || fail "the refusal did not say the attempt never started"
AT_FAIL="$(last_attempt)"
[ "$(attempt_state "$AT_FAIL")" = "preflight-failed" ] || fail "a failed preparation step did not fail the preflight"
[ -f "$ROOT/ran-fail" ] && fail "the provider ran despite a failed preparation step"
[ -f "$(spool_of "$AT_FAIL")/run-1.stdout.log" ] && fail "a run was spent on an attempt whose preparation failed"
node -e '
const fs = require("node:fs");
const line = JSON.parse(fs.readFileSync(process.argv[1], "utf8").trim().split("\n").pop());
if (line.exit !== 3) { console.error(`the failing step recorded exit ${line.exit}`); process.exit(1); }
if (!line.output.includes("dependencies could not be installed")) { console.error("the failing step recorded no output"); process.exit(1); }
' "$(spool_of "$AT_FAIL")/preparation.jsonl"
no_worktree_left "$AT_FAIL" "a failed preparation"

# ---------------------------------------------------------------------------
# A step whose command the plan never declared is refused before it runs.
# ---------------------------------------------------------------------------
plan "$ROOT/p-tool.json" "provisionRepo=$SRC" "provisionHead=$SHA_DISALLOWED" "marker=$ROOT/ran-tool"
TOOL="$(SELF attempt run "$ROOT/p-tool.json" 2>&1 || true)"
echo "$TOOL" | grep -q 'runs "pnpm", which this attempt.s tools allowlist does not carry' || fail "the refusal did not name the command the allowlist does not carry"
AT_TOOL="$(last_attempt)"
[ "$(attempt_state "$AT_TOOL")" = "preflight-failed" ] || fail "a step outside the tools allowlist did not fail the preflight"
[ -f "$(spool_of "$AT_TOOL")/preparation.jsonl" ] && fail "a step outside the allowlist ran anyway"
no_worktree_left "$AT_TOOL" "a step outside the tools allowlist"

# ---------------------------------------------------------------------------
# A malformed template names the field that is wrong, and starts nothing.
# ---------------------------------------------------------------------------
malformed()
{
    local name="$1" head="$2" expect="$3"
    plan "$ROOT/p-$name.json" "provisionRepo=$SRC" "provisionHead=$head" "marker=$ROOT/ran-$name"
    local out
    out="$(SELF attempt run "$ROOT/p-$name.json" 2>&1 || true)"
    echo "$out" | grep -q "$expect" || fail "the $name template refusal did not name $expect: $out"
    local id
    id="$(last_attempt)"
    [ "$(attempt_state "$id")" = "preflight-failed" ] || fail "the $name template did not fail the preflight"
    [ -f "$ROOT/ran-$name" ] && fail "the provider ran despite the $name template"
    no_worktree_left "$id" "the $name template"
}
malformed badjson "$SHA_BADJSON" "is not valid JSON"
malformed noargv "$SHA_NOARGV" "steps\[0\].command"
malformed badtimeout "$SHA_BADTIMEOUT" "steps\[0\].timeoutMs"

# ---------------------------------------------------------------------------
# A head this machine does not hold, with no remote to fetch it from.
# ---------------------------------------------------------------------------
plan "$ROOT/p-nohead.json" "provisionRepo=$SRC" "provisionHead=$(printf '0%.0s' $(seq 40))" "marker=$ROOT/ran-nohead"
NOHEAD="$(SELF attempt run "$ROOT/p-nohead.json" 2>&1 || true)"
echo "$NOHEAD" | grep -q "names no remote to fetch it from" || fail "an unavailable pinned head was not refused in the operator's terms"
AT_NOHEAD="$(last_attempt)"
[ "$(attempt_state "$AT_NOHEAD")" = "preflight-failed" ] || fail "an unavailable pinned head did not fail the preflight"
[ -f "$ROOT/ran-nohead" ] && fail "the provider ran despite an unavailable pinned head"
no_worktree_left "$AT_NOHEAD" "an unavailable pinned head"

# A branch name is not a pin: it moves under the attempt.
plan "$ROOT/p-ref.json" "provisionRepo=$SRC" "provisionHead=main"
REF="$(SELF attempt run "$ROOT/p-ref.json" 2>&1 || true)"
echo "$REF" | grep -q "not a commit object name" || fail "a plan that pinned a branch name instead of a head was accepted"

# ---------------------------------------------------------------------------
# Step output is kept as a bounded, redacted tail. A dependency install prints
# more than any record should hold, and it prints whatever it was configured
# with.
# ---------------------------------------------------------------------------
plan "$ROOT/p-noisy.json" "provisionRepo=$SRC" "provisionHead=$SHA_NOISY" "dest=$ROOT/dest/noisy.md"
SELF attempt run "$ROOT/p-noisy.json" > /dev/null || fail "a noisy preparation step did not complete"
AT_NOISY="$(last_attempt)"
node -e '
const fs = require("node:fs");
const line = JSON.parse(fs.readFileSync(process.argv[1], "utf8").trim().split("\n").pop());
if (line.output.length > 2100) { console.error(`the step record kept ${line.output.length} characters of output`); process.exit(1); }
if (line.output.includes("sk-live-AAAABBBB")) { console.error("the step record carries a credential the step printed"); process.exit(1); }
if (!line.output.includes("api_key=")) { console.error("the step record kept no tail at all"); process.exit(1); }
' "$(spool_of "$AT_NOISY")/preparation.jsonl"
grep -q "sk-live-AAAABBBB" "$(spool_of "$AT_NOISY")/preparation.jsonl" && fail "a credential a preparation step printed reached the spool"
no_worktree_left "$AT_NOISY" "a noisy preparation"

# A value no pattern recognises, declared as a secret by the plan. Only the
# declared scope can catch this one, and the step record has to travel with it.
DECLARED="PLAINPROOFLITERALVALUE"
plan "$ROOT/p-leak.json" "provisionRepo=$SRC" "provisionHead=$SHA_LEAK" "dest=$ROOT/dest/leak.md" \
    "secrets=MY_API_KEY" "envsecret=$DECLARED"
export MY_API_KEY="$DECLARED"
SELF attempt run "$ROOT/p-leak.json" > /dev/null || fail "the declared-secret case did not complete"
unset MY_API_KEY
AT_LEAK="$(last_attempt)"
grep -q "$DECLARED" "$(spool_of "$AT_LEAK")/preparation.jsonl" && fail "a declared secret a preparation step echoed reached the spool"
grep -q "configured with" "$(spool_of "$AT_LEAK")/preparation.jsonl" || fail "the step record kept none of the step's output"
no_worktree_left "$AT_LEAK" "a step that echoed a declared secret"

# ---------------------------------------------------------------------------
# A registered attempt is provisioned by the same gate, and the environment its
# launcher is handed names the worktree.
# ---------------------------------------------------------------------------
plan "$ROOT/p-register.json" "provisionRepo=$SRC" "provisionHead=$SHA_OK" "dest=$ROOT/dest/register.md"
AT_REG="$(SELF attempt register "$ROOT/p-register.json" | tail -1)"
[ -d "$(spool_of "$AT_REG")/workdir" ] || fail "a registered attempt was not provisioned"
grep -q "SUPERSELF_ATTEMPT_WORKDIR" "$(spool_of "$AT_REG")/env.json" || fail "the launcher environment does not name the provisioned worktree"
node -e '
const env = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (!env.SUPERSELF_ATTEMPT_WORKDIR.endsWith("/workdir")) { console.error("the launcher environment names no worktree"); process.exit(1); }
' "$(spool_of "$AT_REG")/env.json"

# ---------------------------------------------------------------------------
# A runner that dies in the middle of preparation. The attempt never ran, so
# nothing about it can be settled — and recovery still has to take the worktree
# back rather than leave a checkout nobody owns.
# ---------------------------------------------------------------------------
plan "$ROOT/p-sleep.json" "provisionRepo=$SRC" "provisionHead=$SHA_SLEEP" "gate=$ROOT/prep-started"
SELF attempt run "$ROOT/p-sleep.json" > /dev/null 2>&1 &
RUNPID=$!
await '[ -f "$ROOT/prep-started" ]' 120 || fail "the preparation step that never finishes did not start"
AT_SLEEP="$(last_attempt)"
[ -d "$(spool_of "$AT_SLEEP")/workdir" ] || fail "the crashing attempt was never provisioned"
crash_runner "$AT_SLEEP"
wait "$RUNPID" 2>/dev/null || true
SELF attempt recover > /dev/null
[ "$(attempt_state "$AT_SLEEP")" = "exited-unreconciled" ] || fail "an attempt that died mid-preparation was not recovered"
no_worktree_left "$AT_SLEEP" "recovery of an attempt that died mid-preparation"

echo "proof OK: attempt-preparation"
