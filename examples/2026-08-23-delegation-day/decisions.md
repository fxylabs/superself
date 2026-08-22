# Decisions recorded on 2026-08-23 (KST)

Source: `self state show <id>` for each id, read 2026-08-23. Verbatim, scrubbed as above. The record dates read 2026-08-22 because the store stamps UTC.

## M1 front door · `01m0mzkkk7gqbprkn4ar2w54z7`
```text
01m0mzkkk7gqbprkn4ar2w54z7  confirmed  (from decision)
text: M1 front-door strategy: Superself does not open its own curated repo now; it gets listed in the existing agent-rules and AGENTS.md front-door lists by PR, and opens a repo only when the wave-watch trigger fires
labels: decision
placement: project · search · priority 40
why: By function the lane is already served (awesome-copilot 38K, cursorrules 41K, agent-rules 5.7K, agent-rules-books 2.6K, skills lists 31-45K); a 4th-plus entrant with no wave gets a few hundred stars at best. Composio and VoltAgent's repo wins all came within 48h of a platform wave, and Composio's earliest distribution was being listed in others' docs (LangChain, LlamaIndex)
recorded: 2026-08-22
```

## DSH wave · `01m0n05ndkv85pqjm3yx1ffkyg`
```text
01m0n05ndkv85pqjm3yx1ffkyg  confirmed  (from decision)
text: DSH wave (DeepSeek Harness, launched 2026-08-13, 184K stars in 10 days): Superself ships a plugin, not a repo — dsh-plugin-superself, a thin wrapper over the self CLI (context, work, report, decide) plus a slash command, published to npm under the dsh-plugin keyword, submitted to awesome-dsh-plugin (category workflow), announced in the DSH Discord, within 7 days
labels: decision
placement: project · search · priority 40
why: The list-of-record slot closed on launch day (awesome-dsh-plugin 11.4K stars), but the plugin surface is open: 2,446 npm plugins in 10 days and the official goal plugin (dsh-goal) is same-session only, leaving cross-session, cross-project company state unserved. DSH reads AGENTS.md via dsh-agent-instructions, so the self agent block already works there. Risk accepted: 0.1.0-rc with announced breaking changes, mitigated by keeping the plugin thin. Wave decision per M1 c3, 2026-08-23
recorded: 2026-08-22
```

## M4 demand testing · `01m0n4e141xz0pas9htvpya7me`
```text
01m0n4e141xz0pas9htvpya7me  confirmed  (from decision)
text: M4 demand testing: no paid fake-door test. The next-work-API order is already set by the roadmap (email -> 알림톡 September -> SMS and further APIs, resellable first), so a waitlist ranking would not change it; current site reach (9 visits/week, GSC 0 clicks) cannot read candidate differences unaided, and ~KRW 500k of search ads would yield 1-12 signups per candidate — a ranking at best, no customers. M4 becomes: (1) a free keyword-planner read of candidate work-API search volume in the buyer's language (Korean for 알림톡/SMS, English for email/backend), (2) the M5 interviews rank the same candidate cards, (3) once S1 ships, the real email/landing product pages get the ad budget and the funnel visit -> signup -> charge -> send is measured as both demand test and acquisition, (4) an in-product 'request the next work API' capture once users exist. Candidates already in development (email, landing) are never waitlisted.
labels: decision
placement: project · search · priority 40
why: User decision 2026-08-23 after the Composio fake-landing tactic was examined against our state: Composio used fake doors before it had a product; we ship a real product in August, so measuring the real door beats buying a fake one. Supersedes the dropped Track C bar (waitlist >= 100 or 3/10 WTP), which the new M5 interviews re-set.
recorded: 2026-08-22
```

## M5 discovery design · `01m0n4z5gdw7c3pqws01r23r23`
```text
01m0n4z5gdw7c3pqws01r23r23  confirmed  (from decision)
text: M5 discovery design (2026-08-23): 20 stranger-only readings in two halves. KOREA (10 calls): recruit on Threads with problem-narrative posts (two audiences: operators running several projects with agents; small-business owners sending 알림톡/SMS/email themselves), route through a /talk screening page (5 questions; only a concrete last-stuck moment and a named tool pass) that reveals the booking link only on pass; thank-you gift after the call, never advertised as the draw. ENGLISH (10 artifact-backed readings, no calls): primary data is public 'show yours, ask theirs' threads in their own spaces — we post our setup first (the AGENTS.md block and how ~20 projects are run) and ask for theirs — on HN (Ask HN), Discord (DSH, Claude Developers, OpenCode), dev.to, X/Threads; Reddit comments only until the account can post; a comment containing a concrete setup counts as an artifact; an English /talk form (5 questions + pasted artifact) and an optional 3-minute recording are secondary. Reading rules: praise and generalities count zero; acquaintances and referrals excluded; per-reading self report; the M4 candidate card sort is included. Bar (replaces the dropped Track C bar): at least 6 of 20 state the problem before we do, and at least 3 of 20 give explicit willingness to pay at a stated price. Before any English posting, a channel examination is done: rules per channel against our account state, base rates from HN/Reddit data, exemplar threads, timing, and drafts.
labels: decision
placement: project · search · priority 40
why: People answer questions about their own workflow where they already are; they do not do favours for a startup's form. Expected yields: Ask HN mostly 0-5 comments unless it hits a nerve, written forms 1-10% of clicks, recordings 1 in 5 of form passers; so English runs 4-6 weeks and public comments are the primary data. Reddit account cannot post yet. User decisions 2026-08-23.
recorded: 2026-08-22
```

## content loop v2 (convention) · `01m0n5smb12p8wjxdkpx5355sj`
```text
01m0n5smb12p8wjxdkpx5355sj  confirmed  (from convention)
text: Content loop v2 (supersedes the problem-narrative playbook, 2026-08-23; keeps its gates): (1) Reach before articles. The first unit of content is an answer inside a thread where problem awareness already exists — an HN or Reddit comment, a Discord reply, a 'show yours, ask theirs' thread — written to the playbook's rules (read the whole thread, credit the target's design, build on a stated limitation, disclose authorship, thread under 48 hours old with comments arriving). An answer becomes a long-form piece only after it drew replies or votes; the piece then publishes on the product site as canonical. (2) Borrowed stages are content slots: a plugin or adapter release (DSH, Claude Code, Codex), an awesome-list merge, a live standards thread (Claude Code AGENTS.md issue), and the M5 discovery threads. (3) Channel reach test before any publish: a channel counts as distribution only if our account has a reach path there — followers, a tag feed we have entered, or posting rights; a channel that fails is recorded as a mirror (dev.to today: canonical_url mirror only). (4) Two search-led formats are allowed when the demand is measured and the comparison is fair with our product as one entry: 'tools for <problem> (<year>)' and release-reaction pieces on releases that touch the company-state problem — product mentioned at most once, the AI-tell audit applies (this absorbs M6). (5) Visuals remain real product output (vhs recordings in an isolated scratch workspace). (6) The weekly review reads per-piece and per-answer signals from the daily snapshot and records a reach verdict per channel and one decision; 8-week bar from 2026-08-23: one thread with 10+ replies, borrowed-stage referrals above zero, GSC clicks above zero on at least one use-with page — if missed, change topic or channel, not volume.
labels: convention
placement: project · full · priority 30
link: supersedes 01kzn88qh0g02ah1gtyc3eypje
recorded: 2026-08-22
```
