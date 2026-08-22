# w-6h4es · use-with pages

Source: `self work show w-6h4es` and `self work show w-6h4es --history`, read 2026-08-23 in the superself project. Scrubbed: internal git host, artifact links, home paths.

## Brief outcome line and status

```text
held by another session, running since 2026-08-22 16:05
# w-6h4es — superselfs.com has a use-with guide generator: src/content/harnesses.ts drives /use-with/<harness> pages, the first two pages (deepseek-harness, claude-code) are live-ready, and the site serves sitemap.xml, robots.txt, and llms.txt listing them — delivered as one reviewed PR in superself-apps

- Status: active
- Contributes to: m-7jxh7 M2: per-agent-tool guide pages are live and measured (on-track)
- Branches: main
- Unshipped commits by branch: main — 1 of 1 unsettled
- Evidence: 8916a0d (provisional)
- Evidence notes: <internal-git>/spfn-core-projects/superself-apps/pulls/1
```

## Reports (latest first, verbatim)

```text
- 2026-08-22 — PR opened: <internal-git>/spfn-core-projects/superself-apps/pulls/1 (feat(site): use-with guide pages, sitemap, robots, llms.txt; head use-with-pages 8916a0d, base main). PR body carries the 7 defect rows, curl output of sitemap.xml/robots.txt/llms.txt, and a screenshot artifact (<artifact-link>). Gates: build green (pages SSG, files static); check:env-names/typecheck/lint/depcruise/knip green on a CI-like fresh worktree; tests/use-with-pages.test.ts 6/6 pass locally; full DB suite left to CI. Self-adversarial pass caught: (1) backticks in data notes rendered literally — added an inline-code renderer; (2) renderLlmsTxt exported from route.ts would be an invalid route export — moved to src/lib/llms-txt.ts; (3) brief's dsh line lacked the required --profile flag and step 2 lacked the self init prerequisite — copy corrected to the verified forms. Not marked done — maintainer closes on merge. Friction: branch had to be rebased from pr0-scaffold onto local main (the marketing kit 5725bd1 is not on origin yet, so the PR diff shows it until main is pushed); the Orca worktree path breaks knip resolution of test imports (pre-existing, documented in the PR). [8916a0d]
- 2026-08-22 — Checkpoint: use-with guide generator implemented and verified locally on branch use-with-pages (commit 8916a0d, based on local main 5725bd1 which carries the marketing kit). src/content/harnesses.ts (typed entries; pages only for entries with copy), src/app/use-with/[harness]/page.tsx (generateStaticParams + generateMetadata, dynamicParams=false + notFound), src/app/sitemap.ts, robots.ts, llms.txt/route.ts all derive from the same array; src/lib/site.ts adds the one SITE_URL constant (none existed). next build: both pages SSG, three files static; curl on next start -p 3793: sitemap/robots/llms 200 with expected content, /use-with/cursor and /use-with/nope 404. typecheck/lint/depcruise/knip/check:env-names green on a CI-like fresh worktree; tests pending (need the docker DB). Friction: knip fails in the Orca worktree path (.supervibe nesting) on 4 pre-existing src/server exports while passing on main and on a neutral-path fresh worktree — verified with --trace-export; not caused by this change. Also: dsh install line needs --profile (dsh plugin --profile web add dsh-plugin-superself), and self project init needs a workspace (self init once) — both reflected in the copy instead of the brief's shorter forms. [8916a0d]
```

## Event history

```text
w-6h4es  live  3 events
2026-08-22T16:05:23.567Z  entity.confirmed  [01m0n3gezfreqjjaj7f7v0jzn1]  superselfs.com has a use-with guide generator: src/content/harnesses.ts drives /use-with/<harness> pages, the first two pages (deepseek-harness, claude-code) are live-ready, and the site serves sitemap.xml, robots.txt, and llms.txt listing them — delivered as one reviewed PR in superself-apps
2026-08-22T16:05:26.402Z  entity.linked  [01m0n3ghr2ty6rv1zsewjj5d0z]  
2026-08-22T16:05:38.954Z  entity.started  [01m0n3gy0agz2vh9e65csb38yf]
```
