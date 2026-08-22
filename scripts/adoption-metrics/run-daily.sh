#!/bin/sh
# Daily adoption-metrics run for launchd (com.superself.adoption-metrics,
# 23:00 KST — after npm's aggregation window rolls): append today's row and
# commit it to main. snapshot.mjs itself skips when today's row already exists,
# so a manual run earlier the same day is safe.
#
# Install this against the main checkout, never a feature worktree. A merged
# branch's worktree keeps its own HEAD, so a runner wired to one commits every
# row to that dead branch and main never receives a single day. The spfn
# harness hit exactly that, silently; the branch check is what makes it loud.
#
# Sync with origin before the row is made. The checkout only ever moves when
# this job commits, so the day somebody else merges to main its push is
# rejected as non-fast-forward — and every later day's push too, each row
# piling up locally. 2026-08-18..22 were lost that way while launchd reported
# exit 0, because the push failure was swallowed. Now: fetch + rebase first,
# and a push that still fails exits non-zero so `launchctl print` shows it.
set -eu
cd "$(dirname "$0")/../.."

branch=$(git symbolic-ref --quiet --short HEAD || echo "")
if [ "$branch" != "main" ]
then
    echo "adoption-metrics: on '${branch:-detached HEAD}', not main — point launchd at the main checkout" >&2
    exit 1
fi

if [ -n "$(git status --porcelain -- scripts/adoption-metrics/snapshots.jsonl)" ]
then
    echo "adoption-metrics: snapshots.jsonl has uncommitted changes in the runner checkout; commit or discard them first" >&2
    exit 1
fi

if git fetch --quiet origin main
then
    if ! git rebase --quiet origin/main
    then
        git rebase --abort
        echo "adoption-metrics: rebase onto origin/main failed; resolve by hand in the runner checkout" >&2
        exit 1
    fi
else
    echo "adoption-metrics: fetch failed (offline?); continuing, the next run rebases and pushes" >&2
fi

node scripts/adoption-metrics/snapshot.mjs
if ! git diff --quiet -- scripts/adoption-metrics/snapshots.jsonl
then
    git add scripts/adoption-metrics/snapshots.jsonl
    git commit -m "chore(metrics): record the $(date +%Y-%m-%d) adoption row"
fi

# Push whatever is ahead — today's row and any rows a previous offline or
# rejected run left behind. One retry after a fresh rebase covers a merge that
# landed between the fetch above and now.
if ! git push --quiet origin HEAD
then
    git fetch --quiet origin main && git rebase --quiet origin/main
    if ! git push --quiet origin HEAD
    then
        echo "adoption-metrics: PUSH FAILED — $(git rev-list --count origin/main..HEAD) row(s) committed locally, not on origin" >&2
        exit 1
    fi
fi
echo "adoption-metrics: main is at $(git rev-parse --short HEAD), in sync with origin"
