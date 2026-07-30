#!/usr/bin/env bash
# Proof of the repository integration controller, replayed on the train that
# produced it: superself PR #43 -> #44 -> #52, three branches touching the same
# CLI files, two of them claiming the same architecture contract.
#
# Both merge lanes are proved. The train merges into a configured integration
# branch (`next`) autonomously — receipts, fence, exact-head CI, order, and no
# human anywhere — and promotion of `next` into main is the one human gate,
# bound to the exact candidate and the exact release bytes.
#
# Everything here is deterministic and offline. The repository is real git, so
# every digest is computed from bytes; nothing outside this temporary root is
# read or written, and no network is used.
set -euo pipefail

CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

# Reads one field out of a --json surface. The proof asserts against machine
# output wherever a human line would let a wording change hide a broken gate.
#
# A path that runs off the end of the surface is the assertion failing, so it
# says which step stopped it and on what — never a TypeError from inside the
# reader, which reads as a broken proof rather than a broken gate.
field()
{
    node -e '
        let raw = "";
        process.stdin.on("data", (chunk) => { raw += chunk; });
        process.stdin.on("end", () =>
        {
            const path = process.argv[1].split(".");
            let value = JSON.parse(raw);
            for (let step = 0; step < path.length; step++)
            {
                if (value === null || typeof value !== "object")
                {
                    stop(path, step, value);
                }
                value = Array.isArray(value) && /^[0-9]+$/.test(path[step])
                    ? value[Number(path[step])]
                    : value[path[step]];
            }
            if (value === undefined)
            {
                stop(path, path.length, value);
            }
            console.log(typeof value === "object" ? JSON.stringify(value) : String(value));
        });

        function stop(path, step, value)
        {
            const reached = step === 0 ? "the surface" : path.slice(0, step).join(".");
            console.error("field " + path.join(".") + ": " + reached + " is " +
                (value === undefined ? "not there" : JSON.stringify(value)) +
                (step === path.length ? "" : ", so it has no \"" + path[step] + "\""));
            process.exit(1);
        }
    ' "$1"
}

sha256_of()
{
    node -e '
        const { createHash } = require("node:crypto");
        const { readFileSync } = require("node:fs");
        console.log(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
    ' "$1"
}

# Drives one CLI command under a real pseudo-terminal, typing one line. This is
# a human at a terminal reduced to what a proof can hold: the command sees a
# tty on stdin and stdout, and the typed line arrives through the terminal —
# there is no pipe here for the CLI to be fooled by.

# A review result envelope, exactly as a provider-neutral runner would write it:
# a JSON file beside the artifact bytes it declares.
envelope()
{
    local dir="$1" cs="$2" scope="$3" base="$4" head="$5" digest="$6" verdict="$7" body="${8:-a bounded review record}"
    mkdir -p "$dir"
    echo "$body" > "$dir/report.md"
    local sha bytes
    sha="$(sha256_of "$dir/report.md")"
    bytes="$(wc -c < "$dir/report.md" | tr -d ' ')"
    cat > "$dir/envelope.json" <<JSON
{
  "schema": "superself.review-result/1",
  "changeSet": "$cs",
  "scope": "$scope",
  "base": "$base",
  "head": "$head",
  "digest": "$digest",
  "verdict": "$verdict",
  "findings": [],
  "tests": [{ "name": "pnpm proof", "status": "pass" }],
  "artifact": { "path": "report.md", "sha256": "$sha", "bytes": $bytes },
  "reviewer": { "name": "fresh review session", "model": "claude-opus-5", "session": "proof" },
  "completedAt": "2026-07-27T09:00:00Z"
}
JSON
}

# Projections are ordered by when they were observed, never by when they were
# appended, so the fixture states its own order: every observation here is
# stamped inside one window ahead of this run, and a merge's own "the branch is
# now here" — stamped at the real moment it happened — is older than all of
# them by construction.
#
# The window is an hour wide because "by construction" has to survive a slow
# run. Stamped seconds ahead of the start, as it first was, the wall clock
# overtook the fixture partway through and a stated target advance was
# discarded as older than a merge that had already been recorded — the proof
# then failed on a gate that was not broken (#57).
FIXTURE_BASE="$(node -e 'console.log(Date.now() + 3600 * 1000);')"

at()
{
    node -e 'console.log(new Date(Number(process.argv[1]) + Number(process.argv[2]) * 1000).toISOString());' \
        "$FIXTURE_BASE" "$1"
}

digest_of()
{
    SELF integration show "$1" --json | field digest
}

phase_of()
{
    SELF integration show "$1" --json | field phase
}

log_lines()
{
    wc -l < "$ROOT/ws/.superself/projects/superself/log.jsonl" | tr -d ' '
}

AT05="$(at 5)"
AT10="$(at 10)"
AT15="$(at 15)"
AT20="$(at 20)"
AT25="$(at 25)"
AT40="$(at 40)"
AT45="$(at 45)"
AT50="$(at 50)"
AT55="$(at 55)"
AT60="$(at 60)"
AT65="$(at 65)"
AT70="$(at 70)"
AT75="$(at 75)"
AT80="$(at 80)"
AT85="$(at 85)"

export HOME="$ROOT/home"
export XDG_CONFIG_HOME="$ROOT/config"
mkdir -p "$HOME"
git config --global user.name "integration proof"
git config --global user.email "proof@superself.local"
git config --global init.defaultBranch main

# ── the repository the train runs on ────────────────────────────────
#
# Six shared CLI files, changed pairwise by three branches — the collision the
# controller exists for, reduced to bytes a proof can hold.
mkdir -p "$ROOT/ws/superself"
cd "$ROOT/ws"
SELF init --lang en > /dev/null
cd "$ROOT/ws/superself"
git init -q
for file in main.ts views.ts model.ts fold.ts artifact.ts gitutil.ts
do
    echo "// $file" > "$file"
done
git add -A
git commit -qm "base"
MAIN0="$(git rev-parse HEAD)"
SELF project add --name superself --no-connect > /dev/null

branch()
{
    git checkout -q -b "$1" "$MAIN0"
}

branch pr43
echo "// #43 bounded integration" >> main.ts
echo "// #43 view" >> views.ts
git commit -qam "pr43"
H43="$(git rev-parse HEAD)"

branch pr44
echo "// #44 supervisor boundary" >> main.ts
echo "// #44 model" >> model.ts
git commit -qam "pr44"
H44="$(git rev-parse HEAD)"

branch pr52
echo "// #52 attempt lifecycle" >> main.ts
echo "// #52 model lifecycle" >> model.ts
echo "// #52 fold" >> fold.ts
git commit -qam "pr52"
H52="$(git rev-parse HEAD)"
git checkout -q main

# ── registration and the derived train ──────────────────────────────
CS43="$(SELF integration register --repo superself --base "$MAIN0" --head "$H43" --pr 43 \
    --domain cli.commands@1 --check ci --rank 1 | tail -1)"
CS44="$(SELF integration register --repo superself --base "$MAIN0" --head "$H44" --pr 44 \
    --domain supervisor.process-ownership@1 --check ci --rank 2 | tail -1)"
CS52="$(SELF integration register --repo superself --base "$MAIN0" --head "$H52" --pr 52 \
    --domain supervisor.process-ownership@1 --check ci --rank 3 | tail -1)"

[ "$(SELF integration plan --json | field 0.items.0.changeSet)" = "$CS43" ] || fail "the train did not put #43 first"
[ "$(SELF integration plan --json | field 0.items.2.changeSet)" = "$CS52" ] || fail "the train did not put #52 last"
SELF integration show "$CS44" --json | field pathOverlaps | grep -q "main.ts" || fail "path overlap between #43 and #44 was not computed"
[ "$(SELF integration show "$CS43" --json | field digestSource)" = "computed" ] \
    || fail "a reachable checkout still left the feature digest as a declaration"

# a digest an agent declares against a checkout that disagrees is refused: the
# bytes decide, not the claim
LIE="$(SELF integration register --repo superself --base "$MAIN0" --head "$H43" \
    --diff-digest 0000000000000000000000000000000000000000000000000000000000000000 2>&1 || true)"
echo "$LIE" | grep -q "the bytes decide" || fail "a declared digest contradicting the checkout was accepted"

# ── the human gate cannot be minted by a process ────────────────────
#
# With no integration target configured, every merge would land on main, so
# the gate demands a human approval on each merge…
SELF integration show "$CS43" --json | field blockers | grep -q "approval_missing" \
    || fail "a direct-to-main lane did not demand the human gate"

# …and the gate is a terminal, not a flag. Piped stdio is how an agent runs,
# and it is refused before anything is recorded.
NOTTY="$(SELF integration approve "$CS43" --head "$H43" < /dev/null 2>&1 || true)"
echo "$NOTTY" | grep -q "human_gate_unavailable" || fail "a piped approval was not refused"
[ "$(SELF integration show "$CS43" --json | field approvals)" = "[]" ] || fail "a refused approval still recorded an event"

# an event forged straight into the log, asserting confirmed with no verified
# method behind it, is an agent's claim — the fold refuses to count it
cat >> "$ROOT/ws/.superself/projects/superself/log.jsonl" <<JSON
{"id":"00000000000000000000000000","ts":"2026-01-01T00:00:00.000Z","type":"merge.approved","origin":{"actor":"agent","confirmed":true},"project":"superself","payload":{"changeSet":"$CS43","head":"$H43","by":"forged"}}
JSON
[ "$(SELF integration show "$CS43" --json | field approvals.0.humanConfirmed)" = "false" ] \
    || fail "a forged confirmed approval was counted as human"
SELF integration show "$CS43" --json | field blockers | grep -q "approval_missing" \
    || fail "a forged approval opened the main gate"

# ── the configured integration target ───────────────────────────────
#
# The train merges into `next`; only promotion of next into main takes the
# human gate. Configuring the target is exactly what removes the per-merge
# approval — nothing on this lane reaches main.
git branch next "$MAIN0"
# the branch is stored under one canonical spelling, whatever alias set it
SELF integration target --repo superself --branch refs/heads/next > /dev/null
[ "$(SELF integration target --repo superself --json | field branch)" = "next" ] || fail "the configured target did not stick canonically"
SELF integration show "$CS43" --json | field blockers | grep -q "approval_missing" \
    && fail "an integration-target merge still demands a per-merge human approval"

# main under any equivalent spelling is not an integration target: every alias
# of the same local head is refused, and a refusal records no target event.
# Case variants are aliases too — on a case-insensitive filesystem "MAIN"
# checks out the very same branch as "main"
TSETS="$(grep -c '"type":"repo.target_set"' "$ROOT/ws/.superself/projects/superself/log.jsonl")"
for alias in "main" "refs/heads/main" "heads/main" " main " $'main\t' $'refs/heads/main\n' \
    "MAIN" "Main" "refs/heads/MAIN" "heads/Main" " MAIN " $'Main\t'
do
    ALIASED="$(SELF integration target --repo superself --branch "$alias" 2>&1 || true)"
    echo "$ALIASED" | grep -q "gated lane" || fail "main spelled '$alias' was accepted as an integration target"
done
[ "$(grep -c '"type":"repo.target_set"' "$ROOT/ws/.superself/projects/superself/log.jsonl")" = "$TSETS" ] \
    || fail "a refused main alias still recorded a target event"
[ "$(SELF integration target --repo superself --json | field branch)" = "next" ] \
    || fail "a refused main alias moved the configured target"

# an alias of main forged straight into the log is an event the CLI could never
# record — the fold sets no target from it, and the lane keeps its human gate
cat >> "$ROOT/ws/.superself/projects/superself/log.jsonl" <<JSON
{"id":"00000000000000000000000001","ts":"2026-01-01T00:00:00.000Z","type":"repo.target_set","origin":{"actor":"agent"},"project":"superself","payload":{"repository":"superself","branch":"refs/heads/main"}}
JSON
[ "$(SELF integration target --repo superself --json | field branch)" = "next" ] \
    || fail "a forged main alias in the log resolved the autonomous lane onto main"
[ "$(SELF integration target --repo superself --json | field promotion)" = "false" ] \
    || fail "a forged main alias flipped the derived lane"

# a forged case variant of main is the same non-event: the fold reads the one
# predicate the command reads, so no casing sets a target the CLI would refuse
cat >> "$ROOT/ws/.superself/projects/superself/log.jsonl" <<JSON
{"id":"00000000000000000000000002","ts":"2026-01-01T00:00:01.000Z","type":"repo.target_set","origin":{"actor":"agent"},"project":"superself","payload":{"repository":"superself","branch":"heads/MAIN"}}
JSON
[ "$(SELF integration target --repo superself --json | field branch)" = "next" ] \
    || fail "a forged case variant of main in the log resolved the autonomous lane onto main"
[ "$(SELF integration target --repo superself --json | field promotion)" = "false" ] \
    || fail "a forged case variant of main flipped the derived lane"

# canonicalization strips exactly one prefix and keeps the branch's own case:
# git reads "refs/heads/heads/Next-Lane" as the branch "heads/Next-Lane", and
# folding it all the way to "next-lane" would name a branch nobody has
SELF integration target --repo superself --branch refs/heads/heads/Next-Lane > /dev/null
[ "$(SELF integration target --repo superself --json | field branch)" = "heads/Next-Lane" ] \
    || fail "a double-prefixed branch was not stored as git names it"
SELF integration target --repo superself --branch next > /dev/null
[ "$(SELF integration target --repo superself --json | field branch)" = "next" ] \
    || fail "restoring the next target did not stick"

# ── architecture overlap is a policy stop, not a rebase ─────────────
[ "$(phase_of "$CS52")" = "blocked_policy" ] || fail "an unconsolidated architecture overlap did not block #52"
[ "$(phase_of "$CS44")" = "blocked_policy" ] || fail "an unconsolidated architecture overlap did not block #44"
SELF integration show "$CS52" --json | field blockers.0.code | grep -q "unconsolidated_semantic_overlap" \
    || fail "the overlap block did not name itself"

# and the git tree is never touched to find that out
FENCE="$(SELF integration lease acquire --repo superself --holder supervisor | tail -1)"
SECOND="$(SELF integration lease acquire --repo superself --holder other-supervisor 2>&1 || true)"
echo "$SECOND" | grep -q "is leased by supervisor" || fail "a second holder took a lane that was already leased"
[ "$(SELF integration lease show --repo superself --json | field holder)" = "supervisor" ] \
    || fail "a refused acquisition still moved the lease"
# the same holder renewing keeps the fence it already has, so a supervisor that
# restarted does not fence out its own running attempt
[ "$(SELF integration lease acquire --repo superself --holder supervisor | tail -1)" = "$FENCE" ] \
    || fail "a holder renewing its own lease was given a new fence"
TREE_BEFORE="$(git rev-parse HEAD)$(git status --porcelain)"
PREMATURE="$(SELF integration attempt start "$CS52" --fence "$FENCE" --action rebase 2>&1 || true)"
echo "$PREMATURE" | grep -q "unconsolidated_semantic_overlap\|predecessor_open" || fail "a premature #52 attempt was not refused"
[ "$TREE_BEFORE" = "$(git rev-parse HEAD)$(git status --porcelain)" ] || fail "a refused attempt still mutated the checkout"

# consolidation is a decision, so it does not reach the log without its reason
NOWHY="$(SELF integration declare "$CS52" --consolidates "$CS44" 2>&1 || true)"
echo "$NOWHY" | grep -q "needs --why" || fail "an ownership decision was recorded with no reason"
SELF integration declare "$CS52" --consolidates "$CS44" --depends "$CS44" \
    --why "#44 owns the process-ownership contract; #52 consumes it" > /dev/null
[ "$(phase_of "$CS52")" = "implementation" ] || fail "consolidating the overlap did not clear the policy block"

# ── semantic overlap with no shared path at all ─────────────────────
#
# The case no path heuristic can reach: two branches that touch different files
# and still implement one contract. Nothing here is computable from the diff, so
# if the declaration were not believed the collision would be invisible.
branch semA
echo "// registry writer" >> artifact.ts
git commit -qam "semA"
HSEMA="$(git rev-parse HEAD)"
branch semB
echo "// registry reader" >> gitutil.ts
git commit -qam "semB"
HSEMB="$(git rev-parse HEAD)"
git checkout -q main

SEMA="$(SELF integration register --repo superself --base "$MAIN0" --head "$HSEMA" \
    --domain storage.artifact-registry@1 --check ci --rank 20 | tail -1)"
SEMB="$(SELF integration register --repo superself --base "$MAIN0" --head "$HSEMB" \
    --domain storage.artifact-registry@2 --check ci --rank 21 | tail -1)"
[ "$(SELF integration show "$SEMB" --json | field pathOverlaps)" = "[]" ] \
    || fail "two branches with no file in common were reported as overlapping on paths"
[ "$(phase_of "$SEMB")" = "blocked_policy" ] || fail "a semantic-only overlap did not block the train"
SELF integration show "$SEMB" --json | field blockers.0.detail | grep -q "storage.artifact-registry" \
    || fail "the semantic-only block did not name the contract both sides claimed"

# a supersede states ownership just as a consolidation does, and clears it
SELF integration declare "$SEMB" --supersedes "$SEMA" > /dev/null
[ "$(phase_of "$SEMB")" != "blocked_policy" ] || fail "an explicit supersede did not resolve the overlap"
SELF integration close "$SEMA" --as superseded --why "superseded by the second registry statement" > /dev/null
[ "$(phase_of "$SEMA")" = "closed" ] || fail "a superseded change set did not settle as closed"
SELF integration close "$SEMB" --as abandoned --why "registered only to prove the semantic-only gate" > /dev/null

# ── an agent saying APPROVE creates nothing ─────────────────────────
D43="$(digest_of "$CS43")"
SELF review request "$CS43" --scope change > /dev/null
[ "$(phase_of "$CS43")" = "change_review" ] || fail "a requested review did not move #43 into change_review"

envelope "$ROOT/rev43" "$CS43" change "$MAIN0" "$H43" "$D43" approve
rm "$ROOT/rev43/report.md"
GONE="$(SELF review ingest --file "$ROOT/rev43/envelope.json" 2>&1 || true)"
echo "$GONE" | grep -q "artifact_missing" || fail "an approve verdict with no artifact bytes was ingested"
[ "$(SELF review list "$CS43" --json | field length)" = "0" ] || fail "a rejected envelope still left a receipt"

envelope "$ROOT/rev43" "$CS43" change "$MAIN0" "$H43" "$D43" approve
echo "tampered after hashing" >> "$ROOT/rev43/report.md"
TAMPER="$(SELF review ingest --file "$ROOT/rev43/envelope.json" 2>&1 || true)"
echo "$TAMPER" | grep -q "artifact_digest_mismatch\|artifact_size_mismatch" || fail "artifact bytes were not bound to the declared digest"

envelope "$ROOT/rev43" "$CS43" change "$MAIN0" "$H43" \
    1111111111111111111111111111111111111111111111111111111111111111 approve
UNBOUND="$(SELF review ingest --file "$ROOT/rev43/envelope.json" 2>&1 || true)"
echo "$UNBOUND" | grep -q "digest_unbound" || fail "a verdict about bytes nobody is holding was accepted"

# an artifact the runner did not produce beside its envelope is not the review
# record, whatever it hashes to
envelope "$ROOT/rev43" "$CS43" change "$MAIN0" "$H43" "$D43" approve
mkdir -p "$ROOT/outside"
echo "not a review record" > "$ROOT/outside/secret.md"
node -e '
    const { readFileSync, writeFileSync, statSync } = require("node:fs");
    const { createHash } = require("node:crypto");
    const envelope = JSON.parse(readFileSync(process.argv[1], "utf8"));
    envelope.artifact = {
        path: "../outside/secret.md",
        sha256: createHash("sha256").update(readFileSync(process.argv[2])).digest("hex"),
        bytes: statSync(process.argv[2]).size
    };
    writeFileSync(process.argv[1], JSON.stringify(envelope));
' "$ROOT/rev43/envelope.json" "$ROOT/outside/secret.md"
ESCAPE="$(SELF review ingest --file "$ROOT/rev43/envelope.json" 2>&1 || true)"
echo "$ESCAPE" | grep -q "artifact_outside_envelope" || fail "an envelope pulled bytes from outside its own directory into the store"

# an approval with nothing run behind it is a claim, not a review
envelope "$ROOT/rev43" "$CS43" change "$MAIN0" "$H43" "$D43" approve
node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const envelope = JSON.parse(readFileSync(process.argv[1], "utf8"));
    envelope.tests = [];
    writeFileSync(process.argv[1], JSON.stringify(envelope));
' "$ROOT/rev43/envelope.json"
NOTESTS="$(SELF review ingest --file "$ROOT/rev43/envelope.json" 2>&1 || true)"
echo "$NOTESTS" | grep -q "tests_missing" || fail "an approve verdict listing no tests was ingested"

# a verdict about a head this change set has left behind binds to nothing
envelope "$ROOT/rev43" "$CS43" change "$MAIN0" "$MAIN0" "$D43" approve
OLDHEAD="$(SELF review ingest --file "$ROOT/rev43/envelope.json" 2>&1 || true)"
echo "$OLDHEAD" | grep -q "head_mismatch" || fail "a review of a head the change set has left was ingested"

# an agent that reports "APPROVE" in prose still moves nothing
W43="$(SELF work add "land #43" | tail -1)"
SELF work start "$W43" > /dev/null
SELF report "$W43" "reviewed #43 end to end: APPROVE, no findings" > /dev/null
[ "$(phase_of "$CS43")" = "change_review" ] || fail "prose claiming APPROVE moved the change set"

# ── the envelope that does exist ────────────────────────────────────
envelope "$ROOT/rev43" "$CS43" change "$MAIN0" "$H43" "$D43" approve
RR43="$(SELF review ingest --file "$ROOT/rev43/envelope.json" | tail -1)"
SELF review list "$CS43" | grep -q "$RR43" || fail "an ingested receipt is not on record"
# a supervisor that crashed between recording and reporting retries safely
[ "$(SELF review ingest --file "$ROOT/rev43/envelope.json" --json | field duplicate)" = "true" ] \
    || fail "the same envelope ingested twice did not converge on one receipt"
[ "$(SELF review list "$CS43" --json | field length)" = "1" ] || fail "a retried ingest created a second verdict"
SELF review list "$CS43" | grep -q "current" || fail "a receipt bound to the current bytes did not read as current"
SELF artifact list --project superself | grep -q "report.md" || fail "review artifact bytes did not reach the store registry"

# ── an attempt admitted before the target had a head ────────────────
#
# Nothing has said where `next` is yet, so this attempt records no target to
# plan against. An attempt with nothing recorded there was, until #57, immune
# to the target check forever: with no head to compare, every later advance
# left it running. The first observation is what settles it — an attempt that
# cannot be shown to have planned against the head that is there is cancelled,
# exactly as one whose target moved.
IA0="$(SELF integration attempt start "$CS43" --fence "$FENCE" --action rebase | tail -1)"
[ "$(phase_of "$CS43")" = "integration" ] || fail "an attempt in flight did not read as integrating"
SELF integration reconcile --json | field converged | grep -q "true" \
    || fail "an attempt was cancelled before anything had observed the target at all"
SELF integration observe target --repo superself --head "$MAIN0" --at "$AT05" > /dev/null
[ "$(SELF integration reconcile --json | field actions.0.subject)" = "$IA0" ] \
    || fail "an attempt admitted before any target head was observed survived the first observation"
[ "$(SELF integration show "$CS43" --json | field attempts.0.reason)" = "target_unobserved" ] \
    || fail "the cancellation did not record that the attempt had planned against no observed target"
[ "$(SELF integration show "$CS43" --json | field attempts.0.status)" = "cancelled" ] \
    || fail "an attempt immune to the target check was left running"

# ── conflict-free base movement preserves the receipt ───────────────
#
# The integration branch moves under #43 for reasons that have nothing to do
# with it. The feature bytes are the same bytes, so the review that read them
# still reads them.
git checkout -q next
echo "release notes" > NOTES.md
git add NOTES.md
git commit -qm "an unrelated advance of the integration branch"
NEXT1="$(git rev-parse HEAD)"
SELF integration observe target --repo superself --head "$NEXT1" --at "$AT10" > /dev/null
git checkout -q pr43
git rebase -q "$NEXT1" > /dev/null
H43B="$(git rev-parse HEAD)"
IA1="$(SELF integration attempt start "$CS43" --fence "$FENCE" --action rebase | tail -1)"
BUSY="$(SELF integration attempt start "$CS44" --fence "$FENCE" --action rebase 2>&1 || true)"
echo "$BUSY" | grep -q "lane_busy" || fail "two integration attempts ran on one repository at once"
SELF integration attempt finish "$IA1" --outcome completed --head "$H43B" --base "$NEXT1" \
    --command "git rebase next:0" | grep -q "receipts preserved" || fail "a conflict-free rebase did not preserve the receipt"
[ "$(digest_of "$CS43")" = "$D43" ] || fail "a conflict-free rebase changed the feature digest"
SELF review list "$CS43" | grep -q "current" || fail "the change receipt did not survive conflict-free base movement"

# ── the exact merge gate, with no human anywhere on this lane ───────
NOCI="$(SELF integration merge "$CS43" --fence "$FENCE" --merge-commit "$MAIN0" --main-before "$MAIN0" --main-after "$MAIN0" --json || true)"
[ "$(echo "$NOCI" | field code)" = "ci_not_green" ] || fail "a merge with no CI result on the exact head was allowed"

SELF integration observe ci --repo superself --head "$H43B" --check ci --conclusion failure --at "$AT05" > /dev/null
RED="$(SELF integration merge "$CS43" --fence "$FENCE" --merge-commit "$MAIN0" --main-before "$MAIN0" --main-after "$MAIN0" --json || true)"
[ "$(echo "$RED" | field code)" = "ci_not_green" ] || fail "a merge on failing CI was allowed"
SELF integration observe ci --repo superself --head "$H43B" --check ci --conclusion success --at "$AT15" > /dev/null

# receipts, fence, exact-head CI and order are the whole integration-target
# gate: nothing demands an approval, and merge_ready arrives without one
[ "$(phase_of "$CS43")" = "merge_ready" ] || fail "#43 did not reach merge_ready autonomously on the integration target"

STALE="$(SELF integration merge "$CS43" --fence 99 --merge-commit "$MAIN0" --main-before "$MAIN0" --main-after "$MAIN0" --json || true)"
[ "$(echo "$STALE" | field code)" = "stale_fence" ] || fail "a merge under a stale fence was allowed"

# a review names the bytes under a head; a push after it takes both with it
echo "// #43 one more push after review" >> views.ts
git commit -qam "an extra push after review"
H43C="$(git rev-parse HEAD)"
SELF integration head "$CS43" --head "$H43C" > /dev/null
[ "$(phase_of "$CS43")" != "merge_ready" ] || fail "a head that changed after review stayed merge_ready"
SELF integration show "$CS43" --json | field blockers.0.code | grep -q "change_receipt_missing" \
    || fail "a new head did not put the change review back in front of the merge"

git reset -q --hard "$H43B"
SELF integration head "$CS43" --head "$H43B" > /dev/null
[ "$(phase_of "$CS43")" = "merge_ready" ] || fail "returning to the reviewed bytes did not restore the receipt"

# a digest declared with no checkout to check it against can be reviewed and
# green — and still does not survive the last look at the bytes
FAKE=2222222222222222222222222222222222222222222222222222222222222222
OFFLINE="$(SELF integration register --repo superself --base "$MAIN0" --head "$H52" --offline \
    --diff-digest "$FAKE" --check ci --rank 9 | tail -1)"
[ "$(SELF integration show "$OFFLINE" --json | field digestSource)" = "declared" ] \
    || fail "an offline registration was not marked as a declaration"
SELF status | grep -q "declared feature digest" || fail "a declared digest raised no health signal"
envelope "$ROOT/revfake" "$OFFLINE" change "$MAIN0" "$H52" "$FAKE" approve
SELF review ingest --file "$ROOT/revfake/envelope.json" > /dev/null
SELF integration observe ci --repo superself --head "$H52" --check ci --conclusion success --at "$AT05" > /dev/null
DRIFT="$(SELF integration merge "$OFFLINE" --fence "$FENCE" --merge-commit x --main-before y --main-after z --json || true)"
[ "$(echo "$DRIFT" | field code)" = "digest_drift" ] || fail "a merge landed bytes it never re-read against the repository"
SELF integration close "$OFFLINE" --as abandoned --why "registered only to prove the drift gate" > /dev/null

# ── the merge receipt proves the merge that really happened ─────────
git checkout -q next
git merge -q --no-ff pr43 -m "merge #43"
MERGE43="$(git rev-parse HEAD)"
GHOST=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

BADSHA="$(SELF integration merge "$CS43" --fence "$FENCE" --merge-commit xyz --main-before "$NEXT1" --main-after "$MERGE43" --json || true)"
[ "$(echo "$BADSHA" | field code)" = "commit_malformed" ] || fail "a merge receipt naming a malformed commit id was recorded"
GHOSTREF="$(SELF integration merge "$CS43" --fence "$FENCE" --merge-commit "$GHOST" --main-before "$NEXT1" --main-after "$MERGE43" --json || true)"
[ "$(echo "$GHOSTREF" | field code)" = "commit_unknown" ] || fail "a merge receipt naming a commit that does not exist was recorded"
UNREL="$(SELF integration merge "$CS43" --fence "$FENCE" --merge-commit "$MAIN0" --main-before "$NEXT1" --main-after "$MAIN0" --json || true)"
[ "$(echo "$UNREL" | field code)" = "merge_unrelated" ] || fail "a merge receipt whose commit does not contain the reviewed head was recorded"

SELF integration merge "$CS43" --fence "$FENCE" --merge-commit "$MERGE43" \
    --main-before "$NEXT1" --main-after "$MERGE43" --json > "$ROOT/merge43.json"
[ "$(field changeSet < "$ROOT/merge43.json")" = "$CS43" ] || fail "the merge receipt does not name the change set"
[ "$(field head < "$ROOT/merge43.json")" = "$H43B" ] || fail "the merge receipt does not carry the exact reviewed head"
[ "$(field target < "$ROOT/merge43.json")" = "next" ] || fail "the merge receipt does not name the integration target it landed on"
[ "$(field ci.0.conclusion < "$ROOT/merge43.json")" = "success" ] || fail "the merge receipt does not carry the exact CI conclusion"
[ "$(phase_of "$CS43")" = "merged" ] || fail "#43 did not settle as merged"
[ -f "$ROOT/ws/.superself/projects/superself/integration/$CS43.md" ] && fail "a merged change set kept a current canonical file"

# ── #44: conflict resolution is a new delta, not a re-review ────────
D44="$(digest_of "$CS44")"
envelope "$ROOT/rev44" "$CS44" change "$MAIN0" "$H44" "$D44" approve
SELF review ingest --file "$ROOT/rev44/envelope.json" > /dev/null
[ "$(phase_of "$CS44")" = "integration" ] || fail "#44 with an approved change review is not in the lane"

SELF integration observe target --repo superself --head "$MERGE43" --at "$AT20" > /dev/null
IA2="$(SELF integration attempt start "$CS44" --fence "$FENCE" --action resolve | tail -1)"
git checkout -q pr44
# #43 and #44 both appended to main.ts, so this rebase really conflicts, and
# the resolution is bytes no review has seen
if git rebase -q "$MERGE43" > /dev/null 2>&1
then
    fail "the fixture no longer reproduces the #43/#44 conflict"
fi
printf '// main.ts\n// #43 bounded integration\n// #44 supervisor boundary\n// #44 resolved against #43\n' > main.ts
git add main.ts
GIT_EDITOR=true git rebase --continue > /dev/null 2>&1
H44B="$(git rev-parse HEAD)"
SELF integration attempt finish "$IA2" --outcome completed --head "$H44B" --base "$MERGE43" \
    --conflict-path main.ts --intersection supervisor.process-ownership \
    --command "git rebase next:1" --command "git rebase --continue:0" | grep -q "bounded review" \
    || fail "a conflict resolution did not create an integration delta"
[ "$(phase_of "$CS44")" = "delta_review" ] || fail "a change set carrying an unreviewed delta did not ask for a delta review"
SELF integration show "$CS44" --json | field blockers.0.code | grep -q "delta_review_missing" \
    || fail "the delta block did not name itself"
SELF review list "$CS44" | grep -q "superseded" || fail "the change receipt was not marked superseded by the delta"

DELTA="$(SELF integration show "$CS44" --json | field deltas.0.digest)"
SELF integration observe ci --repo superself --head "$H44B" --check ci --conclusion success --at "$AT25" > /dev/null
BLOCKED="$(SELF integration merge "$CS44" --fence "$FENCE" --merge-commit x --main-before y --main-after z --json || true)"
[ "$(echo "$BLOCKED" | field code)" = "delta_review_missing" ] || fail "an unreviewed integration delta did not stop the merge"

envelope "$ROOT/rev44d" "$CS44" integration_delta "$MERGE43" "$H44B" "$DELTA" approve "the resolution of main.ts only"
SELF review ingest --file "$ROOT/rev44d/envelope.json" > /dev/null
[ "$(phase_of "$CS44")" = "merge_ready" ] || fail "a reviewed delta did not clear the merge gate"

# ── #52 waits for #44, whatever it would like to do ─────────────────
[ "$(phase_of "$CS52")" = "implementation" ] || fail "#52 moved before #44 landed"
D52="$(digest_of "$CS52")"
envelope "$ROOT/rev52" "$CS52" change "$MAIN0" "$H52" "$D52" approve
SELF review ingest --file "$ROOT/rev52/envelope.json" > /dev/null
[ "$(phase_of "$CS52")" = "waiting_predecessor" ] || fail "a reviewed #52 did not read as waiting on its predecessor"
EARLY="$(SELF integration attempt start "$CS52" --fence "$FENCE" --action rebase --json || true)"
[ "$(echo "$EARLY" | field code)" = "predecessor_open" ] || fail "#52 started integrating with #44 still open"

git checkout -q next
git merge -q --no-ff pr44 -m "merge #44"
MERGE44="$(git rev-parse HEAD)"
SELF integration merge "$CS44" --fence "$FENCE" --merge-commit "$MERGE44" \
    --main-before "$MERGE43" --main-after "$MERGE44" > /dev/null
[ "$(phase_of "$CS52")" != "waiting_predecessor" ] || fail "#52 kept waiting after #44 merged"

# ── a rejected review is a fix loop, never a stop ───────────────────
CSFIX="$CS52"
envelope "$ROOT/rev52r" "$CSFIX" change "$MAIN0" "$H52" "$D52" reject "two findings on the lifecycle"
SELF review ingest --file "$ROOT/rev52r/envelope.json" > /dev/null
SELF integration show "$CSFIX" --json | field reason | grep -q "reject" || fail "a rejected review is not the standing reason"

# ── the lane converges: stale fence, external target, restart ───────
# #52 conflicts with what #44 landed. What is proved here is the attempt and how
# it is invalidated, not the resolution, so the rebase is abandoned and the
# checkout left clean for everything below.
git checkout -q pr52
if git rebase -q "$MERGE44" > /dev/null 2>&1
then
    fail "the fixture no longer reproduces the #44/#52 conflict"
fi
git rebase --abort
IA3="$(SELF integration attempt start "$CS52" --fence "$FENCE" --action rebase | tail -1)"
SELF integration lease acquire --repo superself --holder supervisor --expires 2000-01-01T00:00:00Z > /dev/null
BEFORE="$(log_lines)"
SELF integration reconcile --json > "$ROOT/reconcile.json"
[ "$(field actions.0.action < "$ROOT/reconcile.json")" = "lease_expired" ] || fail "reconcile did not make the expiry durable"
SELF integration show "$CS52" --json | field attempts | grep -q "stale_fence" || fail "an attempt under a dead fence was not cancelled"
AFTER="$(log_lines)"
[ "$AFTER" -gt "$BEFORE" ] || fail "reconcile recorded nothing at all"
SELF integration reconcile --json | field converged | grep -q "true" || fail "a second reconcile did not converge"
[ "$(log_lines)" = "$AFTER" ] || fail "reconcile is not idempotent — it wrote again with nothing to say"

# an attempt planned against a merge target that has since moved is cancelled,
# never retried
FENCE2="$(SELF integration lease acquire --repo superself --holder supervisor | tail -1)"
[ "$FENCE2" -gt "$FENCE" ] || fail "a new lease did not raise the fence"
IA4="$(SELF integration attempt start "$CS52" --fence "$FENCE2" --action rebase | tail -1)"
SELF integration observe target --repo superself --head "$MAIN0" --at "$AT40" > /dev/null
SELF integration reconcile --json | field actions.0.reason | grep -q "next moved" || fail "an external target advance did not invalidate the attempt"
SELF integration show "$CS52" --json | grep -q "target_moved" || fail "the cancellation did not record why"

# ── projections converge: duplicates and late arrivals ──────────────
SELF integration observe ci --repo superself --head "$H52" --check ci --conclusion success --at "$AT50" --dedupe delivery-7 > /dev/null
DUP_BEFORE="$(log_lines)"
SELF integration observe ci --repo superself --head "$H52" --check ci --conclusion success --at "$AT50" --dedupe delivery-7 > /dev/null
[ "$(log_lines)" = "$DUP_BEFORE" ] || fail "a webhook delivered twice was recorded twice"
SELF integration observe ci --repo superself --head "$H52" --check ci --conclusion failure --at "$AT45" --dedupe delivery-6 > /dev/null
SELF integration show "$CS52" --json | field ci.0.conclusion | grep -q "success" \
    || fail "an observation that arrived late but happened earlier overwrote the newer one"

# a batch is the same projection through a file, and replays to nothing
cat > "$ROOT/batch.json" <<JSON
{ "schema": "superself.integration-observation/1", "observations": [
  { "kind": "ci", "repository": "superself", "head": "$H52", "check": "ci", "conclusion": "success", "observedAt": "$AT50", "dedupe": "delivery-7" },
  { "kind": "target", "repository": "superself", "head": "$MERGE44", "observedAt": "$AT55", "dedupe": "delivery-8" }
] }
JSON
SELF integration observe --file "$ROOT/batch.json" --json | field observed | grep -q "^1$" || fail "a replayed batch was not deduplicated to its new observation"

# a redelivery with no delivery id and no stated instant is keyed by what it
# says, never by the wall clock, so it converges instead of appending twice
SELF integration observe ci --repo superself --head "$H52" --check ci --conclusion pending > /dev/null
NOKEY_BEFORE="$(log_lines)"
SELF integration observe ci --repo superself --head "$H52" --check ci --conclusion pending --json | field duplicates | grep -q "^1$" \
    || fail "an unkeyed redelivery did not read as a duplicate"
[ "$(log_lines)" = "$NOKEY_BEFORE" ] || fail "an unkeyed redelivery minted a fresh identity from the wall clock"

# ── an author's push under a running attempt ────────────────────────
#
# The third way an in-flight pass stops being valid, after a dead fence and a
# merge target that moved: the bytes it planned against are no longer there.
IA5="$(SELF integration attempt start "$CS52" --fence "$FENCE2" --action rebase | tail -1)"
HELD="$(SELF integration lease release --repo superself --fence "$FENCE2" 2>&1 || true)"
echo "$HELD" | grep -q "still running" || fail "the lane was released with a pass still in flight"
[ "$(phase_of "$CS52")" = "integration" ] || fail "a change set with an attempt in flight did not read as integrating"
git checkout -q pr52
echo "// #52 an author's push mid-integration" >> fold.ts
git commit -qam "an author push during integration"
H52C="$(git rev-parse HEAD)"
SELF integration head "$CS52" --head "$H52C" --base "$MERGE44" > /dev/null
SELF integration reconcile --json | field actions.0.reason | grep -q "^$CS52 moved from" \
    || fail "a head that moved under a running attempt did not invalidate it"
SELF integration show "$CS52" --json | grep -q "head_moved" || fail "the cancellation did not record the moved head"
[ "$(SELF integration show "$CS52" --json | field attempts.2.status)" = "cancelled" ] \
    || fail "an invalidated attempt was left running rather than cancelled"

# ── promotion into main: the one human gate ─────────────────────────
#
# next now carries #43 and #44, and main has never moved. The promotion pins
# the exact candidate commit and the exact release bytes main...candidate, and
# nothing lands on main without a release receipt on those bytes and a human
# typing the candidate at a real terminal.
PM="$(SELF integration promote request --repo superself --candidate "$MERGE44" --main "$MAIN0" --json | field promotion)"
RELD="$(SELF integration promote show "$PM" --json | field digest)"
[ "$(SELF integration promote show "$PM" --json | field digestSource)" = "computed" ] \
    || fail "a reachable checkout still left the release digest as a declaration"

# a release review binds to the promotion, never to any one change set
CSREL="$(SELF review request "$CS52" --scope release 2>&1 || true)"
echo "$CSREL" | grep -q "unknown promotion" || fail "a release review was requested on a change set"
SELF review request "$PM" --scope release --json > "$ROOT/relorder.json"
[ "$(field digest < "$ROOT/relorder.json")" = "$RELD" ] || fail "the release order is not bound to the pinned release digest"
[ "$(field head < "$ROOT/relorder.json")" = "$MERGE44" ] || fail "the release order is not bound to the exact candidate"

NOREL="$(SELF integration promote record "$PM" --fence "$FENCE2" --main-before "$MAIN0" --main-after "$MERGE44" --json || true)"
[ "$(echo "$NOREL" | field code)" = "release_receipt_missing" ] || fail "a promotion with no release receipt was allowed"

# a release envelope about another head, other bytes, or no promotion at all
# binds to nothing
envelope "$ROOT/revrel" "$PM" release "$MAIN0" "$H52" "$RELD" approve "release audit"
WRONGHEAD="$(SELF review ingest --file "$ROOT/revrel/envelope.json" 2>&1 || true)"
echo "$WRONGHEAD" | grep -q "head_mismatch" || fail "a release review of another head was ingested"
envelope "$ROOT/revrel" "$PM" release "$MAIN0" "$MERGE44" "$FAKE" approve "release audit"
WRONGBYTES="$(SELF review ingest --file "$ROOT/revrel/envelope.json" 2>&1 || true)"
echo "$WRONGBYTES" | grep -q "digest_unbound" || fail "a release review of other bytes was ingested"
envelope "$ROOT/revrel" "$CS52" release "$MAIN0" "$MERGE44" "$RELD" approve "release audit"
NOPM="$(SELF review ingest --file "$ROOT/revrel/envelope.json" 2>&1 || true)"
echo "$NOPM" | grep -q "promotion_unknown" || fail "a release review bound to a change set was ingested"

envelope "$ROOT/revrel" "$PM" release "$MAIN0" "$MERGE44" "$RELD" approve "release audit of everything main...candidate"
SELF review ingest --file "$ROOT/revrel/envelope.json" > /dev/null

# reviewed — and still shut until a human types the candidate
NOHUMAN="$(SELF integration promote record "$PM" --fence "$FENCE2" --main-before "$MAIN0" --main-after "$MERGE44" --json || true)"
[ "$(echo "$NOHUMAN" | field code)" = "approval_missing" ] || fail "a promotion with no human approval was allowed"

# a piped approve is an agent, and is refused before anything is recorded
PIPED="$(SELF integration promote approve "$PM" --candidate "$MERGE44" < /dev/null 2>&1 || true)"
echo "$PIPED" | grep -q "human_gate_unavailable" || fail "a piped promotion approval was not refused"
[ "$(SELF integration promote show "$PM" --json | field approvals)" = "[]" ] || fail "a refused promotion approval left an event"

# under a real terminal, a wrong typed challenge approves nothing…
CHAL="$(printf '%s' "$MERGE44" | cut -c1-12)"
pty_self wrong-answer integration promote approve "$PM" --candidate "$MERGE44"
[ "$(SELF integration promote show "$PM" --json | field approvals)" = "[]" ] || fail "a failed typed challenge still approved"

# …and typing the exact candidate is what a human approval is
pty_self "$CHAL" integration promote approve "$PM" --candidate "$MERGE44" --by maintainer
[ "$(SELF integration promote show "$PM" --json | field approvals.0.humanConfirmed)" = "true" ] \
    || fail "a typed terminal confirmation was not counted as human"

# the promotion receipt proves the promotion that really happened
BADPM="$(SELF integration promote record "$PM" --fence "$FENCE2" --main-before "$MAIN0" --main-after zzz --json || true)"
[ "$(echo "$BADPM" | field code)" = "commit_malformed" ] || fail "a promotion naming a malformed commit id was recorded"
MOVEDPM="$(SELF integration promote record "$PM" --fence "$FENCE2" --main-before "$MERGE43" --main-after "$MERGE44" --json || true)"
[ "$(echo "$MOVEDPM" | field code)" = "release_base_moved" ] || fail "a promotion from a main off the reviewed pin was recorded"
GHOSTPM="$(SELF integration promote record "$PM" --fence "$FENCE2" --main-before "$MAIN0" --main-after "$GHOST" --json || true)"
[ "$(echo "$GHOSTPM" | field code)" = "commit_unknown" ] || fail "a promotion naming a commit that does not exist was recorded"
UNRELPM="$(SELF integration promote record "$PM" --fence "$FENCE2" --main-before "$MAIN0" --main-after "$H52" --json || true)"
[ "$(echo "$UNRELPM" | field code)" = "merge_unrelated" ] || fail "a promotion whose main-after does not contain the candidate was recorded"

# a main-after that contains the candidate but carries other bytes — a conflict
# resolution, or any edit on the way in — is a tree nobody reviewed
git checkout -q --detach "$MERGE44"
echo "// a resolution nobody reviewed" >> main.ts
git commit -qam "conflict resolution on the way into main"
TAMPERED="$(git rev-parse HEAD)"
TREEPM="$(SELF integration promote record "$PM" --fence "$FENCE2" --main-before "$MAIN0" --main-after "$TAMPERED" --json || true)"
[ "$(echo "$TREEPM" | field code)" = "promotion_tree_mismatch" ] || fail "a promotion landing bytes off the reviewed candidate tree was recorded"

# what does land is a merge commit whose tree is byte-identical to the candidate
git checkout -q main
git merge -q --no-ff -m "promote next into main" "$MERGE44"
PROMMERGE="$(git rev-parse HEAD)"
[ "$(git rev-parse "$PROMMERGE^{tree}")" = "$(git rev-parse "$MERGE44^{tree}")" ] || fail "the fixture promotion tree is not the candidate tree"
SELF integration promote record "$PM" --fence "$FENCE2" --main-before "$MAIN0" --main-after "$PROMMERGE" --merge-commit "$PROMMERGE" --json > "$ROOT/pm.json"
[ "$(field candidate < "$ROOT/pm.json")" = "$MERGE44" ] || fail "the promotion receipt does not pin the candidate"
[ "$(SELF integration promote show "$PM" --json | field recorded.mainAfter)" = "$PROMMERGE" ] || fail "the promotion did not settle as recorded"
[ "$(SELF integration status --json | field 0.mainHead)" = "$PROMMERGE" ] || fail "a recorded promotion did not advance the projected main"
DOUBLE="$(SELF integration promote record "$PM" --fence "$FENCE2" --main-before "$MAIN0" --main-after "$PROMMERGE" --json || true)"
[ "$(echo "$DOUBLE" | field code)" = "promotion_closed" ] || fail "a recorded promotion was recorded twice"

# ── #95: one approval, typed at the feature head, carries to the squash ──
#
# A second repository lane, "mainline", with no configured target: every merge
# lands directly on main and takes the human gate. Until #95 that gate was
# paid twice per merge — once at the feature head, once more at the squash
# commit, a commit that cannot exist before the merge. When the squash lands
# byte-identical feature bytes on a conflict-free base advance, the approval
# now follows the same carry-over policy receipts already have, as a recorded
# merge.approval_carried event, never a silent skip.
LOGFILE="$ROOT/ws/.superself/projects/superself/log.jsonl"
MB0="$(git rev-parse main)"
git checkout -q -b f95 "$MB0"
echo "// #95 feature under approval carry" >> views.ts
git commit -qam "f95"
F95="$(git rev-parse HEAD)"
git checkout -q main

CS95="$(SELF integration register --repo mainline --base "$MB0" --head "$F95" --pr 95 --check ci | tail -1)"
D95="$(digest_of "$CS95")"
envelope "$ROOT/rev95" "$CS95" change "$MB0" "$F95" "$D95" approve
SELF review ingest --file "$ROOT/rev95/envelope.json" > /dev/null
FENCE95="$(SELF integration lease acquire --repo mainline --holder supervisor | tail -1)"
SELF integration observe main --repo mainline --head "$MB0" --at "$AT60" > /dev/null
SELF integration show "$CS95" --json | field blockers | grep -q "approval_missing" \
    || fail "the mainline lane did not demand the human gate"

# the one deliberate approval, typed at the feature head, binds head and digest
pty_self "$(printf '%s' "$F95" | cut -c1-12)" integration approve "$CS95" --head "$F95" --by maintainer
[ "$(SELF integration show "$CS95" --json | field approvals.0.humanConfirmed)" = "true" ] \
    || fail "the feature-head approval was not counted as human"
[ "$(SELF integration show "$CS95" --json | field approvals.0.digest)" = "$D95" ] \
    || fail "the approval did not bind the digest the human approved"

# main advances conflict-free under the approval, for reasons unrelated to #95
echo "// an unrelated mainline advance" >> gitutil.ts
git commit -qam "unrelated mainline advance"
MB1="$(git rev-parse HEAD)"
SELF integration observe main --repo mainline --head "$MB1" --at "$AT65" > /dev/null

# the squash merge of the exact approved head: byte-identical feature bytes on
# the advanced base, in a commit that could not exist before the merge
git merge -q --squash f95 > /dev/null 2>&1
git commit -qm "squash #95"
SQ95="$(git rev-parse HEAD)"
IA95="$(SELF integration attempt start "$CS95" --fence "$FENCE95" --action merge | tail -1)"
SELF integration attempt finish "$IA95" --outcome completed --head "$SQ95" --base "$MB1" \
    --command "git merge --squash f95:0" | grep -q "receipts preserved" \
    || fail "the conflict-free squash did not preserve the receipts"
SELF integration observe ci --repo mainline --head "$SQ95" --check ci --conclusion success --at "$AT70" > /dev/null

# the merge is admitted on the carried approval — no second human touch
SELF integration merge "$CS95" --fence "$FENCE95" --merge-commit "$SQ95" \
    --main-before "$MB1" --main-after "$SQ95" --json > "$ROOT/merge95.json"
[ "$(phase_of "$CS95")" = "merged" ] || fail "a carried approval did not admit the merge"
[ "$(grep '"type":"merge.approved"' "$LOGFILE" | grep -c "$CS95")" = "1" ] \
    || fail "the carried merge still took a second typed approval"

# the carry is an explicit record naming what it carried from, to, and under
[ "$(SELF integration show "$CS95" --json | field approvals.1.carriedFrom)" = "$(SELF integration show "$CS95" --json | field approvals.0.id)" ] \
    || fail "the carried approval does not lead back to the typed approval"
[ "$(SELF integration show "$CS95" --json | field approvals.1.head)" = "$SQ95" ] \
    || fail "the carried approval does not name the merge commit"
[ "$(SELF integration show "$CS95" --json | field approvals.1.digest)" = "$D95" ] \
    || fail "the carried approval does not keep the binding digest"
[ "$(SELF integration show "$CS95" --json | field merge.approval)" = "$(SELF integration show "$CS95" --json | field approvals.1.id)" ] \
    || fail "the merge receipt does not name the carried approval that admitted it"
CARRYLINE="$(grep '"type":"merge.approval_carried"' "$LOGFILE")"
echo "$CARRYLINE" | grep -q "\"from\":\"$F95\"" || fail "the carried event does not name the approved head"
echo "$CARRYLINE" | grep -q "\"to\":\"$SQ95\"" || fail "the carried event does not name the merge commit"
echo "$CARRYLINE" | grep -q "\"digest\":\"$D95\"" || fail "the carried event does not name the binding digest"

# ── a base advance WITH a conflict carries nothing ──────────────────
git checkout -q -b f96 "$SQ95"
echo "// #96 feature" >> artifact.ts
git commit -qam "f96"
F96="$(git rev-parse HEAD)"
git checkout -q main
CS96="$(SELF integration register --repo mainline --base "$SQ95" --head "$F96" --pr 96 --check ci | tail -1)"
D96="$(digest_of "$CS96")"
envelope "$ROOT/rev96" "$CS96" change "$SQ95" "$F96" "$D96" approve
SELF review ingest --file "$ROOT/rev96/envelope.json" > /dev/null
pty_self "$(printf '%s' "$F96" | cut -c1-12)" integration approve "$CS96" --head "$F96" --by maintainer
[ "$(SELF integration show "$CS96" --json | field approvals.0.humanConfirmed)" = "true" ] \
    || fail "the #96 feature-head approval was not counted as human"

# main advances into the same line, so the squash really conflicts and the
# resolution is bytes the approval never saw
echo "// a mainline advance into the same file" >> artifact.ts
git commit -qam "conflicting mainline advance"
MB2="$(git rev-parse HEAD)"
SELF integration observe main --repo mainline --head "$MB2" --at "$AT75" > /dev/null
IA96="$(SELF integration attempt start "$CS96" --fence "$FENCE95" --action resolve | tail -1)"
if git merge -q --squash f96 > /dev/null 2>&1
then
    fail "the fixture no longer reproduces the #96 conflict"
fi
printf '// artifact.ts\n// a mainline advance into the same file\n// #96 feature\n// #96 resolved against the advance\n' > artifact.ts
git add artifact.ts
git commit -qm "squash #96 resolved"
SQ96="$(git rev-parse HEAD)"
SELF integration attempt finish "$IA96" --outcome completed --head "$SQ96" --base "$MB2" \
    --conflict-path artifact.ts --command "git merge --squash f96:1" --command "git commit:0" \
    | grep -q "bounded review" || fail "the #96 conflict resolution did not create an integration delta"
[ "$(digest_of "$CS96")" != "$D96" ] || fail "the fixture conflict did not change the feature digest"
SELF integration observe ci --repo mainline --head "$SQ96" --check ci --conclusion success --at "$AT80" > /dev/null
DELTA96="$(SELF integration show "$CS96" --json | field deltas.0.digest)"
envelope "$ROOT/rev96d" "$CS96" integration_delta "$MB2" "$SQ96" "$DELTA96" approve "the resolution of artifact.ts only"
SELF review ingest --file "$ROOT/rev96d/envelope.json" > /dev/null

# delta reviewed, CI green — and still shut: the bytes changed after the
# approval, so nothing carries, and the merge waits for a fresh human
NOCARRY="$(SELF integration merge "$CS96" --fence "$FENCE95" --merge-commit "$SQ96" --main-before "$MB2" --main-after "$SQ96" --json || true)"
[ "$(echo "$NOCARRY" | field code)" = "approval_missing" ] || fail "a conflicted squash was merged on a carried approval"
echo "$NOCARRY" | field detail | grep -q "bytes changed after approval" \
    || fail "the no-carry refusal did not say why nothing carried"
grep '"type":"merge.approval_carried"' "$LOGFILE" | grep -q "$CS96" \
    && fail "a conflicted squash still recorded a carry event"

# a carry forged straight into the log binds to nothing: the fold re-checks
# the digest binding the emitter proved
APP96="$(SELF integration show "$CS96" --json | field approvals.0.id)"
cat >> "$LOGFILE" <<JSON
{"id":"00000000000000000000000003","ts":"2026-01-01T00:00:02.000Z","type":"merge.approval_carried","origin":{"actor":"agent"},"project":"superself","payload":{"changeSet":"$CS96","approval":"$APP96","from":"$F96","to":"$SQ96","digest":"$D96"}}
JSON
SELF integration show "$CS96" --json | field approvals | grep -q "carriedFrom" \
    && fail "a forged carry event was counted as an approval"
SELF integration show "$CS96" --json | field blockers | grep -q "approval_missing" \
    || fail "a forged carry opened the main gate"

# the human gate itself is unchanged: a fresh approval typed for the squash
# commit still opens it directly
pty_self "$(printf '%s' "$SQ96" | cut -c1-12)" integration approve "$CS96" --head "$SQ96" --by maintainer
SELF integration merge "$CS96" --fence "$FENCE95" --merge-commit "$SQ96" \
    --main-before "$MB2" --main-after "$SQ96" --json > "$ROOT/merge96.json"
[ "$(phase_of "$CS96")" = "merged" ] || fail "a direct approval of the merge commit no longer admits the merge"
[ "$(SELF integration show "$CS96" --json | field merge.approval)" = "$(SELF integration show "$CS96" --json | field approvals.1.id)" ] \
    || fail "the merge receipt does not name the direct approval that admitted it"

# ── an approval the head has outrun carries nothing either ──────────
git checkout -q -b f97 "$SQ96"
echo "// #97 feature" >> fold.ts
git commit -qam "f97"
F97="$(git rev-parse HEAD)"
git checkout -q main
CS97="$(SELF integration register --repo mainline --base "$SQ96" --head "$F97" --pr 97 --check ci | tail -1)"
D97="$(digest_of "$CS97")"
pty_self "$(printf '%s' "$F97" | cut -c1-12)" integration approve "$CS97" --head "$F97" --by maintainer
[ "$(SELF integration show "$CS97" --json | field approvals.0.digest)" = "$D97" ] \
    || fail "the #97 approval did not bind the digest the human approved"

# the author pushes after the approval: the head and its digest move on
git checkout -q f97
echo "// #97 a push after approval" >> fold.ts
git commit -qam "a push after approval"
F97B="$(git rev-parse HEAD)"
git checkout -q main
SELF integration head "$CS97" --head "$F97B" > /dev/null
D97B="$(digest_of "$CS97")"
[ "$D97B" != "$D97" ] || fail "the fixture push did not change the feature digest"
envelope "$ROOT/rev97" "$CS97" change "$SQ96" "$F97B" "$D97B" approve
SELF review ingest --file "$ROOT/rev97/envelope.json" > /dev/null
SELF integration observe ci --repo mainline --head "$F97B" --check ci --conclusion success --at "$AT85" > /dev/null
OUTRUN="$(SELF integration merge "$CS97" --fence "$FENCE95" --merge-commit "$F97B" --main-before "$SQ96" --main-after "$F97B" --json || true)"
[ "$(echo "$OUTRUN" | field code)" = "approval_missing" ] || fail "an approval the head outran still admitted a merge"
echo "$OUTRUN" | field detail | grep -q "bytes changed after approval" \
    || fail "the outrun refusal did not say why nothing carried"
grep '"type":"merge.approval_carried"' "$LOGFILE" | grep -q "$CS97" \
    && fail "an outrun approval still recorded a carry event"
SELF integration close "$CS97" --as abandoned --why "registered to prove the no-carry boundary" > /dev/null

# the CLI recorded exactly one carry in the whole log — #95's. The second
# line is the forged one appended above, which the fold counts as nothing.
[ "$(grep -c '"type":"merge.approval_carried"' "$LOGFILE")" = "2" ] \
    || fail "the log holds a carry event nobody proved"

# ── a restart derives the same state from the same log ──────────────
SNAPSHOT="$(SELF integration list --all --json)"
SELF fold > /dev/null
[ "$SNAPSHOT" = "$(SELF integration list --all --json)" ] || fail "a refold changed derived integration state"
node -e '
    const { execFileSync } = require("node:child_process");
    const cli = process.argv[1];
    const one = execFileSync(process.execPath, [cli, "integration", "list", "--all", "--json"], { encoding: "utf8" });
    const two = execFileSync(process.execPath, [cli, "integration", "list", "--all", "--json"], { encoding: "utf8" });
    if (one !== two)
    {
        console.error("two fresh processes derived different state");
        process.exit(1);
    }
' "$CLI_DIR/bin/self.mjs" || fail "the derived train is not a pure function of the log"

# ── no receipt without an ingest, and no merge without a receipt ────
INGESTED="$(grep -c '"type":"review.received"' "$ROOT/ws/.superself/projects/superself/log.jsonl" || true)"
[ "$INGESTED" = "11" ] || fail "review receipts exist that no envelope ingest created (found $INGESTED)"
MERGES="$(grep -c '"type":"merge.recorded"' "$ROOT/ws/.superself/projects/superself/log.jsonl" || true)"
[ "$MERGES" = "4" ] || fail "the log holds a merge nobody gated (found $MERGES)"
PROMOTED="$(grep -c '"type":"promotion.recorded"' "$ROOT/ws/.superself/projects/superself/log.jsonl" || true)"
[ "$PROMOTED" = "1" ] || fail "the log holds a promotion nobody gated (found $PROMOTED)"
REBASES="$(grep -c '"type":"attempt.started"' "$ROOT/ws/.superself/projects/superself/log.jsonl" || true)"
[ "$REBASES" = "8" ] || fail "the train planned a duplicate rebase (found $REBASES attempts)"

# ── the surfaces an agent and a person read ─────────────────────────
SELF integration | grep -q "superself" || fail "compact status does not name the repository"
SELF context | grep -q "Integration train" || fail "agent context does not carry the integration train"
SELF status | grep -q "integration:" || fail "status does not summarize the lane"
SELF review contract | field schema | grep -q "superself.review-result/1" || fail "the runner contract is not machine readable"
SELF search "$CS52" | grep -q "integration/$CS52.md" || fail "a change set is not searchable in canonical state"

echo "integration proof OK"
