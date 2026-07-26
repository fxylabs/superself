#!/usr/bin/env bash
# Prove the globally installed `self` build works against a real workspace, and
# record each verdict in the delivery ledger.
#
# Only the check name, its pass/fail verdict, and a short sanitized detail ever
# leave this script: workspace contents and command output stay on the machine.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DELIVERY="node $HERE/delivery.mjs"

usage()
{
    echo "usage: smoke.sh --issue <number> --version <X.Y.Z> --workspace <dir>" >&2
    echo "                [--self <bin>] [--feature <name> --feature-cmd <command>]" >&2
    exit 2
}

ISSUE=""
VERSION=""
WORKSPACE=""
SELF_BIN="self"
FEATURE=""
FEATURE_CMD=""

while [ $# -gt 0 ]
do
    case "$1" in
        --issue) ISSUE="${2:-}"; shift 2 ;;
        --version) VERSION="${2:-}"; shift 2 ;;
        --workspace) WORKSPACE="${2:-}"; shift 2 ;;
        --self) SELF_BIN="${2:-}"; shift 2 ;;
        --feature) FEATURE="${2:-}"; shift 2 ;;
        --feature-cmd) FEATURE_CMD="${2:-}"; shift 2 ;;
        *) usage ;;
    esac
done

[ -n "$ISSUE" ] && [ -n "$VERSION" ] && [ -n "$WORKSPACE" ] || usage
[ -d "$WORKSPACE" ] || { echo "smoke: $WORKSPACE is not a directory" >&2; exit 2; }

FAILED=0

# Records one verdict. The detail is a short human phrase, never captured
# output, because the ledger is quotable into a public issue comment.
record()
{
    $DELIVERY smoke --issue "$ISSUE" --name "$1" --status "$2" --detail "$3" > /dev/null || exit 1
    if [ "$2" = "fail" ]
    then
        FAILED=1
    fi
    echo "smoke $1: $2"
}

cd "$WORKSPACE"

REPORTED="$("$SELF_BIN" --version 2>/dev/null || true)"
if [ "$REPORTED" = "$VERSION" ]
then
    record "self --version" pass "reports $VERSION"
else
    record "self --version" fail "expected $VERSION"
fi

for COMMAND in context status
do
    if "$SELF_BIN" "$COMMAND" > /dev/null 2>&1
    then
        record "self $COMMAND" pass "exited 0 in a real workspace"
    else
        record "self $COMMAND" fail "non-zero exit in a real workspace"
    fi
done

if [ -n "$FEATURE" ]
then
    [ -n "$FEATURE_CMD" ] || usage
    if ( eval "$FEATURE_CMD" ) > /dev/null 2>&1
    then
        record "feature:$FEATURE" pass "feature check exited 0"
    else
        record "feature:$FEATURE" fail "feature check exited non-zero"
    fi
fi

exit "$FAILED"
