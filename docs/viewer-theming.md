# Theming the superself viewer

Every fold renders self-contained HTML views — a workspace page, one page per
project, one page per work unit — into `<store>/view/`. The stylesheet inside
each page has two layers:

1. **Theme tokens** — a single `:root` block of CSS custom properties. Every
   color and font family in the viewer flows from these.
2. **Layout** — structural rules that reference only the tokens. The layout
   and the markup beneath it form a stable contract; themes never touch them.

To restyle the viewer, override tokens. Nothing else is needed, and nothing
else is supported.

## How to apply a theme

Create a file named `theme.css` in the store root (the `.superself` directory
that holds `registry.jsonl`):

```
<workspace>/.superself/theme.css
```

On the next fold — any recorded event, or an explicit `self fold` — its
contents are inlined into every rendered page *after* the default tokens, so
whatever you set wins. Open pages pick the change up on their next
auto-reload.

`theme.css` is machine-local by design: the fold git-excludes it from the
store repository, so your styling never syncs to other machines and never
churns their folds. Rendered views are equally local. If you work from
several machines, copy the file to each one.

Two rules:

- Never edit files under `<store>/view/` — they are regenerated on every fold
  and hand edits are overwritten. `theme.css` is the only styling input.
- Views must stay self-contained. Keep the theme to plain CSS values; a
  `@font-face` or `url(...)` pointing at the network breaks the guarantee
  that a rendered view is one file with no external requests.

## Token reference

The default theme (the "quiet ledger" look):

```css
:root {
    --paper: #faf9f4;          /* page background */
    --ink: #182420;            /* primary text */
    --ink-soft: #5c6b62;       /* secondary text: dates, ids, metadata */
    --rule: #c9d6c9;           /* hairlines: ledger rules, card borders */
    --seal: #1d5c43;           /* accent: links, active work, settled evidence */
    --note: #a34a2f;           /* attention: alerts, blocked work, proposals */
    --card: #ffffff;           /* raised surfaces: work cards, project cards, plates */
    --mono: "SF Mono", ui-monospace, Menlo, monospace;
    --sans: "Inter", "Pretendard Variable", Pretendard, -apple-system, "Apple SD Gothic Neo", "Segoe UI", sans-serif;
}
```

The sans stack prefers locally installed Inter and Pretendard (for Korean)
and falls back to system fonts — views make no network requests, so fonts
are never downloaded.

What each token controls:

| Token | Controls |
| --- | --- |
| `--paper` | Background of every page |
| `--ink` | Body text, headings, the section-title underline |
| `--ink-soft` | Dates, event types, ids, captions, footers, muted text |
| `--rule` | Row separators, card borders, plate frames, the rail of queued/done work |
| `--seal` | Links, eyebrow labels, active-work rail, work ids, event types, settled evidence, active counts |
| `--note` | Alert band, blocked-work rail, "proposed" markers, abandoned/unverifiable evidence, blocked counts |
| `--card` | Background of work cards, project cards, and artifact plates |
| `--mono` | Dates, ids, hashes, labels, section titles, footers |
| `--sans` | Body text, page titles, the goal line, project-card titles |

Semi-transparent tints (the goal underline, the alert-band background) are
derived from `--seal` and `--note` with `color-mix()`, so they follow your
overrides automatically.

## Worked example: a dark variant

```css
/* <store>/theme.css */
:root {
    --paper: #14161a;
    --ink: #e6e4de;
    --ink-soft: #97a09a;
    --rule: #2e3630;
    --seal: #6fbf94;
    --note: #e08a70;
    --card: #1c1f24;
}
```

Fonts are untouched, so the ledger keeps its voice on a dark page. There is
no automatic light/dark switching: the viewer renders exactly one theme,
yours.

## Worked example: a dense mono variant

```css
/* <store>/theme.css */
:root {
    --sans: ui-monospace, "SF Mono", Menlo, monospace;
    --seal: #2757d6;
    --note: #b3362c;
    --rule: #d8d8d4;
}
body { font-size: 13px; line-height: 1.5; }
main { max-width: 56rem; }
```

The last two rules show that a theme *may* reach past the tokens into plain
CSS — everything is inlined, so any selector works. Do this sparingly: only
the tokens and the class names listed below are stable.

## Stable class contract

Themes that go beyond tokens can rely on these class names:

- Page chrome: `main` (`main.wide` on the workspace and project pages),
  `.crumb`, `.eyebrow`, `.desc`, `.goal`, `.note-band`, `footer`
- Project dashboard: `.board-head` (the one-line header; carries `.desc`,
  `.goal-line`, `.counts`, and a `.stamp` timestamp), `.attention` (modifier
  `.attention.calm` for the empty state; entries `.att` with a `.kind` chip),
  `.board` (the main grid; `.span` panels stretch across all columns),
  `.queue` (one-line queued work), `.empty` (panel empty states), `.fold`
  (`<details>` collapse used by decisions, conventions, and done)
- Ledger rows: `.row` (modifier `.row.proposed`), with `time`, `.body`,
  `.why`, `.id` inside
- Work cards: `.work` with status modifiers `.active` / `.blocked` / `.next`
  / `.done`, plus `.meta` and `.alert`
- Evidence: `.hash` with verdict modifiers `.v-settled` / `.v-provisional` /
  `.v-abandoned` / `.v-unverifiable`; status words use `.st` with
  `.st-active` / `.st-blocked` / `.st-next` / `.st-done`
- Artifacts: `.plates`, `.plate`, `.doc`
- Event log: `.log` with `time` and `.type` inside
- Workspace cards: `.projects`, `.project`, `.goal-line`, `.counts` (with
  `.on-active`, `.on-blocked`, `.zero`) — `.goal-line` and `.counts` also
  appear in the project-page header, and `.counts` in the workspace
  attention line

**Guaranteed stable across versions:** the token names and the class names
above. **Not guaranteed:** the element structure inside each class, default
token values, spacing, and anything selected by element type — a new version
may reflow markup freely as long as tokens and classes keep their meaning.
