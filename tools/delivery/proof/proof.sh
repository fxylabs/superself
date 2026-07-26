#!/usr/bin/env bash
# End-to-end proof of the issue delivery lifecycle: fresh-session review
# identity, the finding/fix/re-review loop, non-convergence escalation,
# required-check gating, version/tag/package equality, publish-failure
# recovery, exact local install, a real-workspace smoke run against the built
# CLI, and a terminal state that is refused until every piece of evidence
# exists.
set -euo pipefail

PROOF_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOL_DIR="$(cd "$PROOF_DIR/.." && pwd)"
CLI_DIR="$(cd "$TOOL_DIR/../../apps/cli" && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

# the ledger never touches the real machine's delivery state
export SUPERSELF_DELIVERY_DIR="$ROOT/ledger"

D()
{
    node "$TOOL_DIR/bin/delivery.mjs" "$@"
}

fail()
{
    echo "delivery proof FAILED: $1" >&2
    exit 1
}

H1=11111111aaaa
H2=22222222bbbb
H3=33333333cccc
MERGE=44444444dddd

# ---------------------------------------------------------------- convergence
# A review loop that keeps finding work must escalate, never lower the bar.

D open --issue 900 --session impl-900 --max-review-rounds 2 > /dev/null
D pr --issue 900 --pr 900 --head "$H1" --signed-off > /dev/null

SELFREVIEW="$(D review start --issue 900 --session impl-900 2>&1 || true)"
echo "$SELFREVIEW" | grep -q "differ from the implementation session" || fail "the implementation session was allowed to review its own work"

D review start --issue 900 --session review-900-a > /dev/null
D review finish --issue 900 --head "$H1" --findings 3 > /dev/null
D status --issue 900 | grep -q "^state      fixing$" || fail "findings did not move the delivery to fixing"

D fix --issue 900 --head "$H2" > /dev/null
REPEAT="$(D review start --issue 900 --session review-900-a 2>&1 || true)"
echo "$REPEAT" | grep -q "already reviewed" || fail "the same review session was allowed a second round"

D review start --issue 900 --session review-900-b > /dev/null
STALE="$(D review finish --issue 900 --head "$H1" --findings 0 2>&1 || true)"
echo "$STALE" | grep -q "not the current pull request head" || fail "a review of a stale head counted as coverage"

D review finish --issue 900 --head "$H2" --findings 1 > /dev/null
D status --issue 900 | grep -q "^state      failed$" || fail "a non-converging review loop did not fail"
D status --issue 900 | grep -q "review did not converge after 2 rounds" || fail "the escalation did not name non-convergence"
STUCK="$(D done --issue 900 2>&1 || true)"
echo "$STUCK" | grep -q "not legal from state \"failed\"" || fail "a failed delivery could still be marked done"

# ------------------------------------------------------------- the full chain
# One issue walks every state, and every gate refuses before it is satisfied.

PKG_VERSION="$(node -p "require('$CLI_DIR/package.json').version")"

D open --issue 901 --session impl-901 > /dev/null
EARLY="$(D review start --issue 901 --session review-901-a 2>&1 || true)"
echo "$EARLY" | grep -q "not legal from state \"implementing\"" || fail "a review started before a pull request existed"

D pr --issue 901 --pr 901 --head "$H1" --signed-off > /dev/null
for CHECK in verify contribution-policy dco
do
    D check --issue 901 --name "$CHECK" --status green > /dev/null
done

D review start --issue 901 --session review-901-a > /dev/null
D review finish --issue 901 --head "$H1" --findings 2 > /dev/null
TOOEARLY="$(D merge --issue 901 --commit "$MERGE" 2>&1 || true)"
echo "$TOOEARLY" | grep -q "not legal from state \"fixing\"" || fail "a pull request with open findings could be merged"

SAMEHEAD="$(D fix --issue 901 --head "$H1" 2>&1 || true)"
echo "$SAMEHEAD" | grep -q "must push a new head commit" || fail "a fix that pushed nothing was accepted"

D fix --issue 901 --head "$H2" > /dev/null
D review start --issue 901 --session review-901-b > /dev/null
D review finish --issue 901 --head "$H2" --findings 0 > /dev/null
D status --issue 901 | grep -q "^state      merging$" || fail "a clean review did not reach merging"

# checks are green only at the commit they ran on: the fix invalidated all three
STALECHECKS="$(D merge --issue 901 --commit "$MERGE" 2>&1 || true)"
echo "$STALECHECKS" | grep -q "verify, contribution-policy, dco" || fail "checks from an older head still counted as green"

D check --issue 901 --name verify --status green > /dev/null
D check --issue 901 --name contribution-policy --status green > /dev/null
D check --issue 901 --name dco --status red > /dev/null
REDCHECK="$(D merge --issue 901 --commit "$MERGE" 2>&1 || true)"
echo "$REDCHECK" | grep -q "not green at $H2: dco" || fail "a red required check did not block the merge"

D check --issue 901 --name dco --status green > /dev/null
D merge --issue 901 --commit "$MERGE" > /dev/null
D status --issue 901 | grep -q "^state      releasing$" || fail "a merged pull request did not reach releasing"

# --------------------------------------------------------- one release, one version
MISMATCH="$(D release --issue 901 --tag "v$PKG_VERSION" --package-version "$PKG_VERSION" --npm-version 9.9.9 --release-url https://example.invalid/r 2>&1 || true)"
echo "$MISMATCH" | grep -q "must name one release" || fail "a published version that differs from the manifest was accepted"
BADTAG="$(D release --issue 901 --tag "$PKG_VERSION" --package-version "$PKG_VERSION" --npm-version "$PKG_VERSION" --release-url https://example.invalid/r 2>&1 || true)"
echo "$BADTAG" | grep -q "must name one release" || fail "a tag that does not match the version was accepted"
BADURL="$(D release --issue 901 --tag "v$PKG_VERSION" --package-version "$PKG_VERSION" --npm-version "$PKG_VERSION" --release-url http://example.invalid/r 2>&1 || true)"
echo "$BADURL" | grep -q "expects an https url" || fail "a plain-http release url was accepted"

# -------------------------------------------------- a failed publish is resumable
export HOME="$ROOT/machine/home"
mkdir -p "$HOME/logs"
D fail --issue 901 --reason "npm publish rejected the provenance attestation" --reference "$HOME/logs/publish.log" > /dev/null
D status --issue 901 | grep -q "^state      failed$" || fail "a failed publish did not fail the delivery"
BLOCKED="$(D install --issue 901 --version "$PKG_VERSION" 2>&1 || true)"
echo "$BLOCKED" | grep -q "not legal from state \"failed\"" || fail "a failed delivery kept installing"

D resume --issue 901 > /dev/null
D status --issue 901 | grep -q "^state      releasing$" || fail "resume did not return to the state the publish failed from"
D status --issue 901 | grep -q "#901 head $H2" || fail "resume lost the pull request it had already accepted"
D status --issue 901 | grep -q "^merge      $MERGE$" || fail "resume lost the merge commit"

D release --issue 901 --tag "v$PKG_VERSION" --package-version "$PKG_VERSION" --npm-version "$PKG_VERSION" --release-url "https://example.invalid/releases/v$PKG_VERSION" > /dev/null
D status --issue 901 | grep -q "^state      local_updating$" || fail "a published release did not ask this machine to update"

# ------------------------------------------------------------ the exact install
EARLYSMOKE="$(D smoke --issue 901 --name "self context" --status pass 2>&1 || true)"
echo "$EARLYSMOKE" | grep -q "record the installed version before smoking it" || fail "smoke results were accepted before an install"
WRONG="$(D install --issue 901 --version 9.9.9 2>&1 || true)"
echo "$WRONG" | grep -q "install the exact version" || fail "a machine running a different version passed as installed"
D install --issue 901 --version "$PKG_VERSION" > /dev/null

NOSMOKE="$(D done --issue 901 2>&1 || true)"
echo "$NOSMOKE" | grep -q "evidence chain is incomplete" || fail "done did not refuse an incomplete evidence chain"
echo "$NOSMOKE" | grep -q "self --version" || fail "done did not name the smoke checks it is still missing"

# ------------------------------------------- a real workspace, the built CLI
# The smoke script runs the published verbs against a workspace this proof
# creates, through a shim that stands in for the global install.
"$CLI_DIR/node_modules/.bin/tsc" -p "$CLI_DIR" || fail "the CLI under proof did not build"
mkdir -p "$ROOT/bin" "$ROOT/machine/ws/app" "$HOME/.claude"
cat > "$ROOT/bin/self" <<EOF
#!/usr/bin/env bash
exec node "$CLI_DIR/bin/self.mjs" "\$@"
EOF
chmod +x "$ROOT/bin/self"

export XDG_CONFIG_HOME="$ROOT/machine/config"
git config --global user.name "delivery proof"
git config --global user.email "delivery-proof@superself.local"
cd "$ROOT/machine/ws"
"$ROOT/bin/self" init --agents > /dev/null
cd "$ROOT/machine/ws/app"
git init -q
"$ROOT/bin/self" project add --name app --desc "delivery smoke workspace" > /dev/null
"$ROOT/bin/self" goal set "prove the installed CLI answers in a real workspace" > /dev/null

bash "$TOOL_DIR/bin/smoke.sh" --issue 901 --version "$PKG_VERSION" --workspace "$ROOT/machine/ws/app" \
    --self "$ROOT/bin/self" --feature delivery-lifecycle \
    --feature-cmd "node '$TOOL_DIR/bin/delivery.mjs' states" > /dev/null \
    || fail "the smoke run against a real workspace did not pass"

D status --issue 901 | grep -q "self --version ok" || fail "the smoke run did not record the version check"
D status --issue 901 | grep -q "feature:delivery-lifecycle ok" || fail "the smoke run did not record the feature check"

BADSMOKE="$(bash "$TOOL_DIR/bin/smoke.sh" --issue 901 --version 9.9.9 --workspace "$ROOT/machine/ws/app" --self "$ROOT/bin/self" 2>&1 || true)"
echo "$BADSMOKE" | grep -q "smoke self --version: fail" || fail "a version mismatch on this machine still smoked clean"
REGRESSED="$(D done --issue 901 2>&1 || true)"
echo "$REGRESSED" | grep -q "self --version" || fail "a failed smoke check did not reopen the evidence gap"

bash "$TOOL_DIR/bin/smoke.sh" --issue 901 --version "$PKG_VERSION" --workspace "$ROOT/machine/ws/app" \
    --self "$ROOT/bin/self" --feature delivery-lifecycle \
    --feature-cmd "node '$TOOL_DIR/bin/delivery.mjs' states" > /dev/null \
    || fail "the repeated smoke run did not pass"

D done --issue 901 > /dev/null
D status --issue 901 | grep -q "^state      released$" || fail "a complete evidence chain did not reach released"
CLOSED="$(D done --issue 901 2>&1 || true)"
echo "$CLOSED" | grep -q "not legal from state \"released\"" || fail "released was not terminal"

COMMENT="$(D comment --issue 901)"
echo "$COMMENT" | grep -q "v$PKG_VERSION" || fail "the issue comment does not name the tag"
echo "$COMMENT" | grep -q "$MERGE" || fail "the issue comment does not name the merge commit"
echo "$COMMENT" | grep -q "review-901-a" || fail "the issue comment does not name the review sessions"
echo "$COMMENT" | grep -q "~/logs/publish.log" || fail "the issue comment lost the preserved log reference"

# ------------------------------------------------- an unsigned pull request stops
D open --issue 902 --session impl-902 > /dev/null
D pr --issue 902 --pr 902 --head "$H3" > /dev/null
for CHECK in verify contribution-policy dco
do
    D check --issue 902 --name "$CHECK" --status green > /dev/null
done
D review start --issue 902 --session review-902-a > /dev/null
D review finish --issue 902 --head "$H3" --findings 0 > /dev/null
UNSIGNED="$(D merge --issue 902 --commit "$MERGE" 2>&1 || true)"
echo "$UNSIGNED" | grep -q "not recorded as signed off" || fail "an unsigned pull request could be merged"

# --------------------------------------------------- nothing secret enters the ledger
D open --issue 903 --session "impl-903 token=hunter2" > /dev/null
D pr --issue 903 --pr 903 --head "$H1" --signed-off > /dev/null
D fail --issue 903 --reason "publish failed: authorization Bearer abcdefghijklmnop and ghp_0123456789abcdefghij" \
    --reference "$HOME/logs/publish-903.log" > /dev/null
LEDGER="$SUPERSELF_DELIVERY_DIR/issue-903.jsonl"
grep -q "ghp_" "$LEDGER" && fail "a github token reached the ledger"
grep -q "hunter2" "$LEDGER" && fail "an assigned secret reached the ledger"
grep -q "abcdefghijklmnop" "$LEDGER" && fail "a bearer token reached the ledger"
grep -q "$HOME" "$LEDGER" && fail "an absolute home path reached the ledger"
grep -q "~/logs/publish-903.log" "$LEDGER" || fail "the log reference was not kept in masked form"

D open --issue 904 --session impl-904 > /dev/null
BADSHA="$(D pr --issue 904 --pr 904 --head "not-a-sha" 2>&1 || true)"
echo "$BADSHA" | grep -q "is not a commit sha" || fail "a free-text head commit was accepted"
D pr --issue 904 --pr 904 --head "$H1" --signed-off > /dev/null
NOTFIXING="$(D fix --issue 904 --head "$H2" 2>&1 || true)"
echo "$NOTFIXING" | grep -q "not legal from state \"pr_ready\"" || fail "a fix was accepted before any review"
D fail --issue 904 --reason "$(printf 'x%.0s' $(seq 1 900))" > /dev/null
REASON_LENGTH="$(node -e '
const lines = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
console.log(JSON.parse(lines[lines.length - 1]).payload.reason.length);
' "$SUPERSELF_DELIVERY_DIR/issue-904.jsonl")"
[ "$REASON_LENGTH" -le 500 ] || fail "an oversized free-text field was stored whole"
[ "$REASON_LENGTH" -gt 400 ] || fail "the truncated reason was not stored at all"

# ------------------------------------------------------------- the printed contract
STATES="$(D states)"
echo "$STATES" | grep -q "review finish   reviewing -> merging | fixing" || fail "the printed contract lost the review branch"
echo "$STATES" | grep -q "done            local_updating -> released" || fail "the printed contract lost the terminal transition"
echo "$STATES" | grep -q "resume          failed ->" || fail "the printed contract lost the resume edge"

D 2>&1 | grep -q "^usage: delivery" || fail "a bare invocation did not print the verbs"
D nonsense 2>&1 | grep -q "^usage: delivery" || fail "a mistyped verb asked for flags instead of naming the verbs"

echo "delivery proof OK"
