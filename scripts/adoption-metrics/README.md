# Adoption metrics

One command answers "did adoption move since the last review". It fetches every
external adoption signal the project tracks, appends a dated row to
`snapshots.jsonl` (committed, append-only), and prints the latest row against
the previous one.

```bash
node scripts/adoption-metrics/snapshot.mjs            # fetch, append, show
node scripts/adoption-metrics/snapshot.mjs --dry-run  # fetch and show, no append (--dry also works)
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
| Referral classes (7d site pageviews) | same PostHog query surface | classified by referring domain: llm / search / devto / reddit / github / x / threads / direct / other |
| Reach (7d site pageviews) | same PostHog query surface | split into global / kr / unknown by GeoIP country; the adoption objective is read against the global count, because KR traffic arrives through a Korean-language funnel that serves a different goal |
| Piece channel counters | `channels.json` → dev.to articles API (views, reactions, comments; matched by canonical URL) and reddit thread JSON (score of the first comment linking our domain) | reddit is **browser-only** (see below): the daily snapshot records null for every reddit score and that is expected, not an error |
| dev.to views | `api/articles/me/published`, author key from the macOS keychain (`service=devto account=api-key`) | the public listing carries no view count; without the key — or when the authenticated call fails — the script says so on stderr, the public listing still answers for reactions and comments, and views read null (unknown), never 0 |
| dev.to followers | `api/followers/users`, same key | an input to the reach verdict; null without the key |

### reddit is browser-only

reddit answers 403 to unauthenticated JSON from this network, so the daily
snapshot cannot read comment scores and keeps recording null for them — that
is the convention, not a failure. At the weekly content-loop review the session
opens every reddit URL in `channels.json` in Chrome, reads our comment's score
and any new replies, and puts the readings in the review's recorded decision.
PostHog's `reddit` referral class carries the traffic signal meanwhile.

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

The runner checkout only moves when the job commits, so it falls behind origin
the moment anyone else merges to main, and a plain push is then rejected as
non-fast-forward. `run-daily.sh` therefore fetches and rebases onto
`origin/main` before making the row, retries the push once after a fresh
rebase, and **exits non-zero when the push still fails** — so
`launchctl print gui/$(id -u)/com.superself.adoption-metrics | grep "last exit"`
shows the problem instead of 0. (2026-08-18..22 were lost that way: four rows
committed locally, no push, exit code 0.) The check is:

```bash
tail -5 ~/Library/Logs/superself-adoption-metrics.log     # last line: "main is at <sha>, in sync with origin"
git -C <runner checkout> status -sb                         # "## main...origin/main" with no "ahead"
```

Do not backfill a missed day by running the snapshot with a past date: the
npm window and every 7-day PostHog count are read at run time, so a backfilled
row would carry today's windows under yesterday's date. A missing day stays
missing; the next row's `npm window` shows which days it covers.

## Weekly review: reach verdict per channel

The view ends with a `reach verdict per channel` block — one entry per channel
in `channels.json` plus `site/search`. Each prints the inputs the reviewer needs
(followers where the channel can answer them, the piece's counters, `tag feed:
unknown` because no API reports whether the piece entered the tag feed, and
`posting rights: (manual)`) and a line the reviewer fills in by hand:

```
reach: (reviewer fills: yes/mirror)
```

`yes` means the channel carries its own audience to the piece; `mirror` means
it only echoes traffic that arrived elsewhere. The verdict goes into the
review's recorded decision, not into the record.

## Rules

- The record is append-only. A bad row is corrected by appending a new row.
- Cadence is weekly, run at review time. Every review ends in a recorded
  decision — a strategy adjustment or an explicit "no change" — otherwise this
  is a dashboard, not monitoring.
- The first committed row is the baseline the OSS-adoption objective
  (2026-10-31) is measured against. PostHog history before 2026-08-07 lives in
  the previous hosting's collection; rows only speak for the instrumented site
  from this repo's cutover onward.
