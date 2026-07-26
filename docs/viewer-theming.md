# Theming the superself viewer

Every fold renders self-contained HTML views into `<store>/view/`: a workspace
page, one page per project, one page per work unit, and a decisions, events,
and artifacts page per project. The stylesheet inside each page has three
layers:

1. **Design tokens** — a `:root` block of `--sv-*` custom properties. Every
   color, family, and measurement in the viewer flows from these.
2. **Accent themes** — `[data-theme="…"]` blocks that swap the three accent
   tokens. The `<html>` element carries the theme the workspace is set to.
3. **Layout** — structural rules that reference only the tokens. The layout
   and the markup beneath it form a stable contract; themes never touch them.

To restyle the viewer, pick an accent theme or override tokens. Nothing else
is needed, and nothing else is supported.

## Picking an accent theme

The accent is not a single brand color. Four themes ship with the viewer:

```
self theme            # print the current one
self theme cyan       # violet (default) | cyan | orange | mono
```

The choice is workspace state, stored in the store config and synced with it,
and every project refolds when it changes. Green and amber are reserved for
status meaning — settled, done, live, health, blocked — so no theme may use
them as an accent.

## Overriding tokens

Create a file named `theme.css` in the store root (the `.superself` directory
that holds `registry.jsonl`):

```
<workspace>/.superself/theme.css
```

On the next fold — any recorded event, or an explicit `self fold` — its
contents are inlined into every rendered page *after* the tokens and the
theme blocks, so whatever you set wins. Open pages pick the change up on
their next auto-reload.

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

```css
:root {
    --sv-bg: #101014;              /* page background */
    --sv-bg-bar: #131319;          /* app bar */
    --sv-bg-rail: #0c0c10;         /* workspace rail */
    --sv-bg-side: #0e0e13;         /* record column */
    --sv-surface: #14141a;         /* panel surface */
    --sv-surface-raised: #17171f;  /* query bar, active nav row, chips */
    --sv-border: #232330;          /* frame borders */
    --sv-border-panel: #26262f;    /* panel borders */
    --sv-rule: #202029;            /* row hairlines */
    --sv-text: #f2f2f7;            /* headings */
    --sv-body: #d6d6de;            /* body text */
    --sv-muted: #8f8fa3;           /* labels, breadcrumb */
    --sv-faint: #6e6e80;           /* ids, timestamps */
    --sv-ok: #34d399;              /* status only: settled, done, live */
    --sv-ok-line: #34d39944;
    --sv-warn: #f0a44b;            /* status only: health, blocked */
    --sv-warn-line: #f0a44b44;
    --sv-accent: #a78bfa;          /* themeable */
    --sv-accent-soft: #a78bfa1a;
    --sv-accent-line: #a78bfa4d;
    --sv-sans: "Inter", "Pretendard Variable", Pretendard, …;
    --sv-mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --sv-rail-w: 180px;            /* workspace rail column */
    --sv-side-w: 300px;            /* record column */
    --sv-main-max: 1040px;         /* dashboards and list pages */
    --sv-doc-max: 760px;           /* work detail, a reading column */
    --sv-panel-gap: 20px;
    --sv-radius: 10px;
}
```

The sans stack prefers locally installed Inter and Pretendard (for Korean)
and falls back to system fonts — views make no network requests, so fonts are
never downloaded. Sans carries prose; mono carries data: section labels, ids,
hashes, timestamps, event types, and the query bar.

The accent appears in six places and nowhere else: the product mark, count
chips, action links (`confirm`, `inspect`, `open`), the active status pill,
the `decide` event type, and the attention panel's border.

## Worked example: a light variant

```css
/* <store>/theme.css */
:root {
    --sv-bg: #f4f4f6;
    --sv-bg-bar: #ffffff;
    --sv-bg-rail: #ececef;
    --sv-bg-side: #f0f0f3;
    --sv-surface: #ffffff;
    --sv-surface-raised: #f7f7f9;
    --sv-border: #dcdce2;
    --sv-border-panel: #e2e2e8;
    --sv-rule: #ebebf0;
    --sv-text: #14141a;
    --sv-body: #3a3a45;
    --sv-muted: #6b6b7a;
    --sv-faint: #8b8b99;
}
```

Accent and status tokens are untouched, so meaning survives the inversion.
There is no automatic light/dark switching: the viewer renders exactly one
theme, yours.

## Worked example: wider dashboards

```css
/* <store>/theme.css */
:root { --sv-main-max: 1320px; --sv-side-w: 340px; }
body { font-size: 13px; }
```

A theme *may* reach past the tokens into plain CSS — everything is inlined,
so any selector works. Do this sparingly: only the tokens and the class names
below are stable.

## Stable class contract

- Shell: `.sv-shell` (modifier `.sv-shell.two` on pages with no record
  column), `.dr-rail`, `.dr-main`, `.dr-side`
- Rail: `.c2-mark` (product mark), `.dr-ws` (workspace name), `.dr-nav` with
  `a.on` for the current project, `.dr-dot` with `.ok` / `.warn`, `.dr-foot`
  (fold stamp)
- App bar: `.c2-bar`, `.c2-back`, `.c2-crumb`, `.c2-query`
- Body: `.c2-body` (modifier `.c2-body.wd-doc` for the reading column),
  `.c2-goal`, `.c2-note`
- Panels: `.c2-panel` (modifier `.c2-attention`), `.c2-panel-head` with `h2`,
  `.c2-count`, `.c2-open` (the ↗ link), `.c2-empty`, `.c2-more` (the
  "N of M · view all →" footer), `.c2-fold` (a `<details>` overflow)
- Tables: `td.k` (kind, `.warn` modifier), `td.n` (id), `td.act` (action),
  `td.r` (right column), `.hf-sub` (the second line of a row)
- Status: `.pill` with `.p-active` / `.p-blocked` / `.p-next` / `.p-done`
- Event feed: `.c2-feed`, `.c2-live`, `.c2-ev` with `time`, `code.e-report` /
  `code.e-decide` / `code.e-work`, `span`, `em`
- Record column: `.dr-dec` (decision row, `.dr-prop` marker), `.dr-evi`
  (evidence row, verdict modifiers `.v-settled` / `.v-provisional` /
  `.v-abandoned` / `.v-unknown` / `.v-unverifiable`), `.dr-art` (artifact
  row, `.dr-doc` for the non-image thumbnail)
- Work detail: `.wd-head`, `.wd-title`, `.wd-meta` with `.wd-chip`,
  `.wd-note`, `.wd-report` (modifier `.is-past`), `.wd-report-head`,
  `.wd-prose`
- List pages: `.af-grid`, `.af-card` (modifier `.af-text` for decisions),
  `.af-plate` (`.af-doc` for the non-image plate), `.af-meta` with `.mono`
  and `.dim`

**Guaranteed stable across versions:** the token names and the class names
above. **Not guaranteed:** the element structure inside each class, default
token values, spacing, and anything selected by element type — a new version
may reflow markup freely as long as tokens and classes keep their meaning.
