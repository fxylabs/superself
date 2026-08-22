#!/usr/bin/env bash
# Rebuilds the scratch workspace, fills the decision id into the confirm
# tape, and renders every tape. Run from anywhere: paths are relative to
# this script.
set -euo pipefail
cd "$(dirname "$0")"
./setup.sh
ID="$(cat scratch/decision-id)"
WORK="$(cat scratch/first-work-id)"
SHA="$(cat scratch/evidence-sha)"
WORK2="$(cat scratch/second-work-id)"
for t in decide-confirm intro; do
    sed -e "s/@DECISION_ID@/$ID/g" -e "s/@WORK_ID@/$WORK/g" -e "s/@EVIDENCE@/$SHA/g" -e "s/@WORK2_ID@/$WORK2/g" "$t.tape.in" > "$t.tape"
done
for tape in self-context.tape work-list.tape waiting-on-you.tape decide-confirm.tape intro.tape; do
    vhs "$tape"
done
