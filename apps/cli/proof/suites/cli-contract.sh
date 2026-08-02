#!/usr/bin/env bash
# Domain suite: the CLI contract — every verb's scoped help, unknown flags and
# stray arguments named and refused before any write, and the refusals leaving
# log, store, and config exactly as they were.
# Runs alone: bash proof/suites/cli-contract.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

demo_workspace
SELF timezone Asia/Seoul > /dev/null
SELF timezone UTC > /dev/null
WSEED="$(SELF work add "an artifact for the rejects section to read" | tail -1)"
SELF work start "$WSEED" > /dev/null
echo "<h1>launch page</h1>" > "$ROOT/launch.html"
SELF report "$WSEED" "attached the launch page" --artifact "$ROOT/launch.html" > /dev/null
AID="$(SELF artifact list --work "$WSEED" | awk '{print $1}')"

# help is answered before any command runs: every documented verb has a scoped
# page, help writes nothing, and a bad flag never becomes a stack trace
cd "$ROOT/A/ws/demo"
HWID="$(SELF work add "the help and argument contract holds" | tail -1)"
LOG_BEFORE="$(wc -l < "$LOG_A")"
STORE_BEFORE="$(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD)"
SELF --help | grep -q "^usage: self <command>" || fail "self --help did not print the verb list"
SELF -h | grep -q "^usage: self <command>" || fail "self -h did not print the verb list"
SELF help | grep -q "^usage: self <command>" || fail "self help did not print the verb list"
SELF nosuchverb --help | grep -q "^usage: self <command>" || fail "an unknown verb did not fall back to the verb list"
# the verbs are read back from the root list, so a command added later is
# proved too instead of drifting away from a list written out here
VERBS="$(SELF | sed -n 's/^  \([a-z][a-z-]*\).*/\1/p' | sort -u)"
[ "$(echo "$VERBS" | grep -c .)" -ge 20 ] || fail "the root list named too few verbs to be the real one"
for CMD in $VERBS
do
    HELP="$(SELF "$CMD" --help 2>&1)" || fail "self $CMD --help exited non-zero"
    echo "$HELP" | grep -q "^usage: self $CMD" || fail "self $CMD --help printed no scoped usage"
    echo "$HELP" | grep -q "    at " && fail "self $CMD --help printed a stack trace"
    SELF "$CMD" -h > /dev/null 2>&1 || fail "self $CMD -h exited non-zero"
    SELF help "$CMD" | grep -q "^usage: self $CMD" || fail "self help $CMD printed no scoped usage"
done
# a verb the dispatcher answers but the list never names has no scoped help at
# all, which is how a command that lands later goes missing from this contract
for CMD in spec attempt
do
    echo "$VERBS" | grep -qx "$CMD" || fail "the root list does not name $CMD"
done
SELF spec --help | grep -q "spec validate <workspec.json>" || fail "self spec --help does not document validate"
SELF spec --help | grep -q "spec apply <workspec.json>" || fail "self spec --help does not document apply"
SELF spec --help | grep -q "spec dispatch <work-spec-id>" || fail "self spec --help does not document dispatch"
SELF spec --help | grep -q "spec list" || fail "self spec --help does not document list and show"
SELF attempt --help | grep -q "attempt register <plan.json>" || fail "self attempt --help does not document register"
SELF attempt --help | grep -q "heartbeat <id>" || fail "self attempt --help does not document the launcher-driven verbs"
# subcommand help resolves to the owning command's page from any position
SELF attempt run --help | grep -q "^usage: self attempt" || fail "self attempt run --help printed no scoped usage"
SELF spec apply --help | grep -q "^usage: self spec" || fail "self spec apply --help printed no scoped usage"
SELF integration lease acquire --help | grep -q "^usage: self integration" || fail "a nested integration verb lost its help"
[ "$(wc -l < "$LOG_A")" = "$LOG_BEFORE" ] || fail "help wrote an event"
[ "$(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD)" = "$STORE_BEFORE" ] || fail "help committed derived state"

# the binary answers what it is, out of the package it was built from: an
# install is verified by asking the binary, and an answer from anywhere but its
# own package would verify nothing
PKG_VERSION="$(node -e 'process.stdout.write(require("'"$CLI_DIR"'/package.json").version)')"
[ "$(SELF --version)" = "$PKG_VERSION" ] || fail "self --version did not print the built package's version"
[ "$(SELF -V)" = "$PKG_VERSION" ] || fail "self -V did not print the built package's version"
SELF | grep -q -- "--version" || fail "the root list does not name the version flag"
[ "$(wc -l < "$LOG_A")" = "$LOG_BEFORE" ] || fail "asking the version wrote an event"

# help answers on a machine that has no workspace at all, and creates none
machine H
cd "$ROOT"
SELF --version | grep -q "^[0-9]" || fail "the version demanded a workspace"
SELF report --help | grep -q "^usage: self report" || fail "report help demanded a workspace"
SELF init --help | grep -q "^usage: self init" || fail "init help demanded a workspace"
SELF attempt --help | grep -q "^usage: self attempt" || fail "attempt help demanded a workspace"
[ -d "$ROOT/.superself" ] && fail "self init --help initialized a workspace"
# an argument mistake is named here too: arguments are checked before the
# workspace is resolved, so the answer does not depend on where it was run
for ARGV in "artifact list --bogus" "goal set text --bogus" "report w-1 text --bogus"
do
    NOWS="$(SELF $ARGV 2>&1 || true)"
    echo "$NOWS" | grep -q "unknown option '--bogus'" || fail "self $ARGV asked for a workspace instead of naming the bad flag"
done
machine A
cd "$ROOT/A/ws/demo"

# help is identical piped or under NO_COLOR, and carries no escape codes either way
[ "$(SELF report --help)" = "$(NO_COLOR=1 node "$CLI_DIR/bin/self.mjs" report --help)" ] || fail "help differed under NO_COLOR"
SELF report --help | grep -q "$(printf '\033')" && fail "help emitted color into a pipe"

# an unknown flag names itself, points at its command's help, exits non-zero,
# and — the part that matters on a write — never reaches the command at all.
# $1 is the verb the message must point at, empty for the root list.
rejects()
{
    VERB="$1"
    shift
    if OUT="$(SELF "$@" 2>&1)"
    then
        fail "self $* exited zero on an unknown flag"
    fi
    echo "$OUT" | grep -q "unknown option '--bogus'" || fail "self $* did not name the unknown flag"
    echo "$OUT" | grep -qF "self ${VERB:+$VERB }--help" || fail "self $* did not point at the scoped help"
    if echo "$OUT" | grep -q "    at "
    then
        fail "self $* printed a stack trace"
    fi
}

cd "$ROOT/A/ws/demo"
LOG_BEFORE="$(wc -l < "$LOG_A")"
STORE_BEFORE="$(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD)"
DIRT_BEFORE="$(git -C "$ROOT/A/ws/.superself" status --porcelain)"
BLOCK_BEFORE="$(cat "$ROOT/A/ws/demo/CLAUDE.md")"
MACHINE_BEFORE="$(cat "$ROOT/A/home/.claude/CLAUDE.md")"
REGISTRY_BEFORE="$(cat "$ROOT/A/ws/.superself/registry.jsonl")"
LINKS_BEFORE="$(cat "$ROOT/A/ws/.superself/links.jsonl")"
POINTER_BEFORE="$(cat "$ROOT/A/config/superself/machine.json")"
CONFIG_BEFORE="$(cat "$ROOT/A/ws/.superself/config.json")"
ARTIFACTS_BEFORE="$(ls "$ROOT/A/ws/.superself/artifacts/demo")"
REMOTE_BEFORE="$(git -C "$ROOT/A/ws/.superself" remote get-url origin)"

rejects goal goal set "rejected write" --bogus
rejects work work add "rejected write" --bogus
rejects work work start "$HWID" --bogus
rejects work work show "$HWID" --bogus
rejects work work --project demo --bogus
rejects convention convention add "rejected write" --bogus
rejects convention convention drop ev-nope --bogus
rejects decide decide "rejected write" --bogus
rejects decide decide confirm ev-nope --bogus
rejects decide decide retract ev-nope --bogus
rejects decide decide decline ev-nope --bogus
rejects convention convention add "rejected write" --supersedes ev-nope --bogus
rejects report report "$HWID" "rejected write" --bogus
rejects report report "$HWID" "rejected write" --artifact "$ROOT/launch.html" --bogus
rejects connect connect --bogus
rejects connect connect --global --bogus
rejects project project add --name rejected --bogus
rejects project project link demo --bogus
rejects artifact artifact list --bogus
rejects artifact artifact search launch --bogus
rejects artifact artifact open "$AID" --bogus
rejects fold fold --bogus
rejects sync sync --bogus
rejects lang lang ja --bogus
rejects theme theme cyan --bogus
rejects timezone timezone Asia/Seoul --bogus
rejects remote remote add "$ROOT/rejected-remote.git" --bogus
rejects workspace workspace "$ROOT/B/ws" --bogus
rejects view view demo --bogus
rejects search search launch --bogus
rejects log log -n 5 --bogus
rejects status status --bogus
rejects context context --bogus
rejects setup setup --bogus
rejects init init --bogus
rejects clone clone "$ROOT/remote.git" "$ROOT/rejected-clone" --bogus
rejects objective objective add "rejected write" --bogus
rejects milestone milestone add "rejected write" --bogus
rejects integration integration register --bogus
rejects review review list --bogus
rejects attempt attempt list --bogus
rejects attempt attempt prune --bogus
# the attempt verbs that read positionals hold the same contract — retention
# and recover are the write paths a swallowed flag used to reach
RETENTION_BEFORE="$(SELF attempt retention)"
rejects attempt attempt retention 9 --bogus
[ "$(SELF attempt retention)" = "$RETENTION_BEFORE" ] || fail "a rejected flag changed spool retention"
rejects attempt attempt recover --bogus
for SUB in "run plan.json" "show at-nope" "directive at-nope text" "cancel at-nope" "settle at-nope" "breaker prov"
do
    rejects attempt attempt $SUB --bogus
done
# the verbs a launcher of its own drives an attempt through hold it too: each
# one moves a spooled attempt, so a swallowed flag here is a swallowed flag on
# a write
for SUB in "register plan.json" "started at-nope --pid 1" "heartbeat at-nope" "exited at-nope --code 0"
do
    rejects attempt attempt $SUB --bogus
done
# and the supervisor's own verbs: `start` launches a detached process and
# `tick` settles attempts, so a flag none of them accepts has to be refused
# before any of that, not swallowed into a supervision pass
for SUB in start stop status tick circuits
do
    rejects daemon daemon $SUB --bogus
done
SELF daemon status | grep -q "no self daemon is running" || fail "a rejected daemon flag started a supervisor"
# and the work spec verbs: validate only reads, but apply seals a generation
# and dispatch spends an attempt, so none of them may reach its body with a
# flag it never accepted
for SUB in "validate x" "apply x" "dispatch x" "list" "show x"
do
    rejects spec spec $SUB --bogus
done
BADSPEC="$(SELF spec apply x surplus 2>&1 || true)"
echo "$BADSPEC" | grep -q "unexpected argument 'surplus'" || fail "an extra spec argument was swallowed"
# and the evidence verbs: none of them writes state, but a swallowed --out would
# put a bundle somewhere nobody asked for and a swallowed flag would compile a
# selection the operator never approved
for SUB in "compile m.json" "verify b.json" "show b.json"
do
    rejects evidence evidence $SUB --bogus
done
BADEVIDENCE="$(SELF evidence compile m.json surplus 2>&1 || true)"
echo "$BADEVIDENCE" | grep -q "unexpected argument 'surplus'" || fail "an extra evidence argument was swallowed"
rejects "" --bogus

# a typoed verb is named on stderr and exits non-zero, never a usage list
# that reads as success
if OUT="$(SELF reprot "$HWID" "typo" 2>/dev/null)"
then
    fail "an unknown verb exited zero"
fi
[ -z "$OUT" ] || fail "an unknown verb printed to stdout"
UNKNOWNVERB="$(SELF reprot "$HWID" "typo" 2>&1 || true)"
echo "$UNKNOWNVERB" | grep -q "unknown command 'reprot'" || fail "an unknown verb was not named"
echo "$UNKNOWNVERB" | grep -qF "self --help" || fail "an unknown verb did not point at the verb list"

# an argument the command has no room for is named too, rather than dropped
BADEXTRA="$(SELF goal set "one goal" "a second one" 2>&1 || true)"
echo "$BADEXTRA" | grep -q "unexpected argument 'a second one'" || fail "an extra argument was swallowed"
echo "$BADEXTRA" | grep -qF "self goal --help" || fail "an extra argument did not point at the scoped help"
BADRECOVER="$(SELF attempt recover extra 2>&1 || true)"
echo "$BADRECOVER" | grep -q "unexpected argument 'extra'" || fail "an extra attempt argument was swallowed"

# nothing any of those commands would have written exists
[ "$(wc -l < "$LOG_A")" = "$LOG_BEFORE" ] || fail "a rejected flag wrote an event"
[ "$(git -C "$ROOT/A/ws/.superself" rev-list --count HEAD)" = "$STORE_BEFORE" ] || fail "a rejected flag committed to the store"
[ "$(git -C "$ROOT/A/ws/.superself" status --porcelain)" = "$DIRT_BEFORE" ] || fail "a rejected flag left the store dirty"
[ "$(cat "$ROOT/A/ws/demo/CLAUDE.md")" = "$BLOCK_BEFORE" ] || fail "a rejected flag rewrote the project's agent block"
[ "$(cat "$ROOT/A/home/.claude/CLAUDE.md")" = "$MACHINE_BEFORE" ] || fail "a rejected flag rewrote this machine's agent block"
[ "$(cat "$ROOT/A/ws/.superself/registry.jsonl")" = "$REGISTRY_BEFORE" ] || fail "a rejected flag registered a project"
[ "$(cat "$ROOT/A/ws/.superself/links.jsonl")" = "$LINKS_BEFORE" ] || fail "a rejected flag linked a checkout"
[ "$(cat "$ROOT/A/config/superself/machine.json")" = "$POINTER_BEFORE" ] || fail "a rejected flag moved this machine's workspace pointer"
[ "$(cat "$ROOT/A/ws/.superself/config.json")" = "$CONFIG_BEFORE" ] || fail "a rejected flag changed a workspace setting"
[ "$(ls "$ROOT/A/ws/.superself/artifacts/demo")" = "$ARTIFACTS_BEFORE" ] || fail "a rejected flag ingested an artifact"
[ "$(git -C "$ROOT/A/ws/.superself" remote get-url origin)" = "$REMOTE_BEFORE" ] || fail "a rejected flag repointed the store remote"
[ -d "$ROOT/A/ws/demo/.superself" ] && fail "a rejected flag initialized a workspace"
[ -e "$ROOT/rejected-clone" ] && fail "a rejected flag cloned a store"

# a separator where a subcommand belongs says so on every such command, instead
# of reading as a flag on one and passing silently on the next
for ARGV in "work -- add" "project -- add" "artifact -- list" "goal -- set" "convention -- add" "remote -- add"
do
    BADSEP="$(SELF $ARGV "never created" 2>&1 || true)"
    echo "$BADSEP" | grep -q "expects a subcommand" || fail "self $ARGV did not explain the separator in place of a subcommand"
done
[ "$(wc -l < "$LOG_A")" = "$LOG_BEFORE" ] || fail "a separator in place of a subcommand wrote an event"

# a flag that needs a value and has none is reported the same way
BADVALUE="$(SELF log -n 2>&1 || true)"
echo "$BADVALUE" | grep -q "argument missing" || fail "a flag with no value was not reported"
echo "$BADVALUE" | grep -q "    at " && fail "a flag with no value printed a stack trace"


# after `--`, an option-looking argument is text the user meant literally —
# on a write verb too, where it used to be swallowed as a separator
SELF report "$HWID" -- "--help is not a flag here"
grep -q -- "--help is not a flag here" "$LOG_A" || fail "a literal argument after -- was taken as a request for help"
SELF goal set -- "--global is the goal now"
grep -q -- "--global is the goal now" "$STATE_A" || fail "a literal goal after -- was taken as a separator"

# `--help` in an option's value position is handed to the command's parser,
# never intercepted as a request for help: the `=` form records the literal
# text, and the two-token form is the parser's own refusal, not a help page
SELF decide "the help literal is a value here" --why=--help
grep -q '"why":"--help"' "$LOG_A" || fail "--help in a value position was intercepted as a help request"
AMBIG="$(SELF decide "never recorded" --why --help 2>&1)" && fail "--help standing where a value belongs still hijacked the invocation"
echo "$AMBIG" | grep -q "ambiguous" || fail "the parser's own refusal of --help as a two-token value was not surfaced"
echo "$AMBIG" | grep -q "    at " && fail "the refusal of --help as a value printed a stack trace"
grep -q "never recorded" "$LOG_A" && fail "a refused --help value still wrote an event"

echo "cli-contract OK"
