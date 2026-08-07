# Adoption metrics

One command answers "did adoption move since the last review". It fetches every
external adoption signal the project tracks, appends a dated row to
`snapshots.jsonl` (committed, append-only), and prints the latest row against
the previous one.

```bash
node scripts/adoption-metrics/snapshot.mjs            # fetch, append, show
node scripts/adoption-metrics/snapshot.mjs --dry      # fetch and show, no append
node scripts/adoption-metrics/snapshot.mjs --view     # show the record only
```

## What it reads

| Signal | Source | Notes |
|---|---|---|
| Stars, forks, watchers | api.github.com/repos/fxylabs/superself | unauthenticated |
| External issues / PRs | same, paginated; `author_association` + an explicit internal-account list | the maintainer's personal account is only CONTRIBUTOR, so association alone cannot exclude it |
| npm weekly downloads | api.npmjs.org, every non-private `apps/*` package | secondary signal — includes our own CI |
| npm window | the `start`/`end` the same call returns | which seven days those counts cover |
| LLM-referral pageviews (7d) | PostHog query API, project 513406 | key from the macOS keychain (`service=posthog account=personal-api-key`, query:read scope); the project receives several products' events, so the query filters `$host='superselfs.com'` — the app host is excluded, this measures the site |
| Search Console impressions, clicks, sitemap last read | Search Console API, domain property `sc-domain:superselfs.com` | service-account JSON from the keychain (`service=gsc account=service-account`) |

Without a keychain entry the field it feeds degrades to null — nothing fails.
Any fetched field can also be overridden by hand:

```bash
node scripts/adoption-metrics/snapshot.mjs \
    --posthog 3 --gsc-impressions 340 --gsc-clicks 9
```

Omitted fields are recorded as null and shown as `—`.

npm counts a day partway through the following day, so a run's window depends
on the hour it runs. Run too early and every package repeats yesterday's
number, which reads exactly like a day of no downloads. `npm window` is what
separates the two, and the view prints a warning when a row shares the previous
row's window.

## Daily run

launchd job `com.superself.adoption-metrics` runs `run-daily.sh` at 23:00 KST —
after npm's window rolls — and commits the day's row.

Point it at the **main checkout**. A worktree keeps its own HEAD even after its
branch is merged, so a runner installed in one commits every row to a dead
branch while main receives nothing. `run-daily.sh` refuses to run anywhere but
main, and the refusal lands in `~/Library/Logs/superself-adoption-metrics.log`.

## Rules

- The record is append-only. A bad row is corrected by appending a new row.
- Cadence is weekly, run at review time. Every review ends in a recorded
  decision — a strategy adjustment or an explicit "no change" — otherwise this
  is a dashboard, not monitoring.
- The first committed row is the baseline the OSS-adoption objective
  (2026-10-31) is measured against. PostHog history before 2026-08-07 lives in
  the previous hosting's collection; rows only speak for the instrumented site
  from this repo's cutover onward.
