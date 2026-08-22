# w-rwmxx · dsh plugin

Source: `self work show w-rwmxx` and `self work show w-rwmxx --history`, read 2026-08-23 in the superself project. Scrubbed: internal git host, artifact links, home paths.

## Brief outcome line and status

```text
held by another session, running since 2026-08-22 15:25
# w-rwmxx — dsh-plugin-superself is public: installable with dsh plugin add from npm (dsh-plugin keyword, dsh.bundle manifest), exposes self context/work/report/decide as tools plus a slash command, its entry is merged in awesome-dsh-plugin under workflow, and it is announced in the DSH Discord — by 2026-08-30

- Status: active
- Contributes to: m-cfxt1 M1: Superself is present in every major agent harness — a thin adapter (plugin, skill, or rules) over the self CLI is shipped and listed in that harness's list of record, and a standing wave watch adds new harnesses within 48 hours of their surface opening (on-track)
- Branches: main, sales-pages
- Evidence: 8ad441b (unverifiable), 624a82c (unverifiable), c4956ee (settled)
- Evidence notes: https://github.com/fxylabs/superself/pull/321; https://github.com/fxylabs/superself/actions/runs/32583742477; https://github.com/fxylabs/superself/pull/323; https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2761
```

## Reports (latest first, verbatim)

```text
- 2026-08-22 — npm publish done by the maintainer: dsh-plugin-superself@0.1.0 is live (https://www.npmjs.com/package/dsh-plugin-superself). awesome-dsh-plugin PR opened: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2761 (fork tonite31/awesome-dsh-plugin, branch add-superself-dsh-plugin; one YAML data/plugins/fxylabs__superself--apps-dsh-plugin.yml + the two regenerated README lines, category workflow, en+zh). The dsh-plugin topic was added to fxylabs/superself as the list requires. Remaining: the list maintainers merge #2761; then post apps/dsh-plugin/ANNOUNCE.md in the DSH Discord and mark w-rwmxx done with the npm URL and the #2761 merge as evidence. 예상대로.
- 2026-08-22 — PR #321 squash-merged into main as c4956ee (issue #320 closed); #323 (CI fix) merged as e75b9d3. apps/dsh-plugin is on main with all gates green. Remaining for the maintainer, in order: (1) cd apps/dsh-plugin && npm publish  (needs npm login — this session is not logged in); (2) awesome-dsh-plugin PR: fork, copy apps/dsh-plugin/awesome-dsh-plugin.entry.yml to data/plugins/fxylabs__superself--apps-dsh-plugin.yml, npm ci && node scripts/generate-readme.mjs, commit YAML + regenerated READMEs, open PR (category workflow); (3) post apps/dsh-plugin/ANNOUNCE.md in the DSH Discord; (4) then self work done w-rwmxx with the npm package URL and the awesome-dsh-plugin merge as evidence. 예상대로. [c4956ee]
- 2026-08-22 — PR #321 is fully green on CI after the update from main: contribution-policy, dco, verify all pass (cli tier with the #323 fix, plugin 23/23). Ready to merge. 예상대로.
- 2026-08-22 — Maintainer approved proceeding: #323 squash-merged into main (e75b9d3). #321 branch merged from main (624a82c, signed off) and pushed; CI verify rerunning on the updated head. 예상대로. [624a82c]
- 2026-08-22 — PR #323 (cell 156(b) timing fix) is fully green on CI: contribution-policy, dco, verify all pass. PR #321 verify rerun failed again on the same cell only, so it stays red until #323 is on main and the #321 branch is updated from main. Waiting on the maintainer to merge #323. 예상대로.
- 2026-08-22 — User said proceed. The only blocker was CI verify on #321, red on a pre-existing cli cell (#322). Root cause found and reproduced: pr7-concurrency cell 156(b) advances the fake clock 30s per 5ms while waitForLock polls every 100ms real, so on the ubuntu runner the first poll after the lease already saw a stealable lock and never announced (expected 1, got 0); tightening the step to 1ms reproduces it locally 3/3, 25ms passes 3/3. Fix PR #323 (branch test/322-lock-announce-timing, commit d9f47d1, test-only, Closes #322 — #322 labelled accepted and assigned to tonite31 by me). #321 verify rerun and #323 CI both in flight. Merge order for the maintainer: #323 first, then #321 (rerun its verify or merge once green). Friction: 예상대로 after the root cause — the runner simply resolves a 5ms timer closer to 5ms than this Mac does.
- 2026-08-22 — CI on PR #321: contribution-policy and dco pass; verify fails on one pre-existing cli test, pr7-concurrency cell 156(b), which main's own run for 0b8806c also fails (filed as #322, noted on the PR). The plugin tier passed 23/23 on the ubuntu runner; cli 973 pass / 2 skipped / 1 fail (that cell). Nothing under apps/cli/src changed in this branch. Friction: the repo's base CI was already red when the branch was cut, so the PR's verify check cannot go green until #322 is fixed or the job is rerun and passes — not visible from the local tier, which is green on macOS.
- 2026-08-22 — PR #321 open: https://github.com/fxylabs/superself/pull/321 (feat/320-dsh-plugin-superself → main, Closes #320 which is labelled status:accepted and assigned to tonite31; commit 8ad441b, DCO signed). All four root gates green locally: pnpm typecheck, pnpm build, pnpm test (cli 976 tests/0 fail + plugin 23/0), pnpm structure. Real-install smoke transcript committed at apps/dsh-plugin/test/smoke/transcript-2026-08-23-dsh-0.1.1-rc.2.txt. Ready for the maintainer, in order: (1) merge #321; (2) cd apps/dsh-plugin && npm publish  (0.1.0, public, prepublishOnly builds lib/); (3) awesome-dsh-plugin PR — fork awesome-dsh-plugin/awesome-dsh-plugin, copy apps/dsh-plugin/awesome-dsh-plugin.entry.yml to data/plugins/fxylabs__superself--apps-dsh-plugin.yml, npm ci && node scripts/generate-readme.mjs, commit YAML + regenerated READMEs, open PR (category workflow); (4) post apps/dsh-plugin/ANNOUNCE.md in the DSH Discord. Unit is NOT done until publish + list merge. Friction: root test tier took ~25 min on this Mac, not the ~12 min CONTRIBUTING states; dsh plugin add needs --profile (no default) and the README/announce install lines had to be corrected; npm/npx of @deepseek-ai/dsh hangs, pnpm installs it in 14s.
- 2026-08-22 — apps/dsh-plugin implemented on feat/320-dsh-plugin-superself (issue #320 accepted+assigned): 4 tools + /self command over the self binary, config selfBinary/cwd/maxOutputChars, 23 unit tests (one per defect row), real-install smoke passed — npm pack → dsh plugin --profile scratch add <tgz> → profile boot → superself_context/work/decide answered through dsh's tool registry on @deepseek-ai/dsh@0.1.1-rc.2 (transcript apps/dsh-plugin/test/smoke/transcript-2026-08-23-dsh-0.1.1-rc.2.txt). Root typecheck/build green; root test tier running. Friction: npx/npm install of @deepseek-ai/dsh hung past 5 minutes and was killed, pnpm add took 14s; the Chrome extension was not connected so the smoke uses a --patch probe plugin instead of the web UI; dsh plugin add requires --profile (README corrected). [8ad441b]
```

## Event history

```text
w-rwmxx  live  9 events
2026-08-22T15:07:05.475Z  entity.confirmed  [01m0n05pw3h7yf3mng269b81f5]  dsh-plugin-superself is public: installable with dsh plugin add from npm (dsh-plugin keyword, dsh.bundle manifest), exposes self context/work/report/decide as tools plus a slash command, its entry is merged in awesome-dsh-plugin under workflow, and it is announced in the DSH Discord — by 2026-08-30
2026-08-22T15:07:06.637Z  entity.linked  [01m0n05r0dncy34mwhapmsc3rh]  
2026-08-22T15:07:07.824Z  entity.linked  [01m0n05s5gszmey8hbp4vxxhvp]  
2026-08-22T15:17:10.510Z  entity.unlinked  [01m0n0r5qeaz3hd4p65tfs0p9e]  
2026-08-22T15:17:11.647Z  entity.unlinked  [01m0n0r6tzy2rpdwfpn0n9bjmj]  
2026-08-22T15:17:12.782Z  entity.linked  [01m0n0r7yet8ndymbst5qrdcag]  
2026-08-22T15:22:23.515Z  entity.unlinked  [01m0n11qcv6gaas2ecmwgcazfe]  
2026-08-22T15:22:24.910Z  entity.linked  [01m0n11rreedmj4h858pc8bmyb]  
2026-08-22T15:25:35.966Z  entity.started  [01m0n17kay7r9s81md0jfckem4]
```
