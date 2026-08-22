# Discord announcement draft (DSH server, plugin/showcase channel)

Post after `npm publish` and the awesome-dsh-plugin merge. Six lines, no hype.

```
dsh-plugin-superself — the self CLI (Superself) as dsh tools + a /self command.
Superself is version control for a project's state (goals, decisions, work units, reports) kept outside the code repo; `self context` renders what an agent must know now. dsh's goal plugin is same-session; this is cross-session and cross-project, with a human approving what counts as decided/done.
Tools: superself_context, superself_work (list/show/start), superself_report, superself_decide. Each shells out to the installed `self`; refusals come back as messages, not throws.
Install: npm i -g superself && dsh plugin --profile web add dsh-plugin-superself   (tested on dsh 0.1.1-rc.2; the adapter is thin so rc breaks are cheap to follow)
Source + README: https://github.com/fxylabs/superself/tree/main/apps/dsh-plugin — Apache-2.0, early alpha, issues welcome.
Listed in awesome-dsh-plugin under workflow.
```
