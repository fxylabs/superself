## Accepted issue

<!-- Required: the issue must have status:accepted and you must be an assignee. -->

Closes #

- [ ] A maintainer added `status:accepted` to the issue
- [ ] A maintainer assigned the issue to me
- [ ] My branch is named `<type>/<issue-number>-<short-description>`
- [ ] Every commit includes my DCO `Signed-off-by` trailer

## Problem

<!-- What user or maintainer problem does this solve? -->

## Result

<!-- Describe the user-visible and technical outcome. -->

## Design rules

<!-- ARCHITECTURE.md states these. Tick what holds; explain anything that does not. -->

- [ ] I consulted [ARCHITECTURE.md](../ARCHITECTURE.md) before writing code
- [ ] No module imports from a layer above it; no new import cycle
- [ ] No new flat top-level subsystem — a new subsystem owns a directory with a `commands.ts`
- [ ] No core module gained an import from a subsystem directory (`attempt/`, `spec/`, `daemon/`)
- [ ] No second path around a single gate (event append, sanitization, completion refusal, attempt gate, argument parse)
- [ ] New events extend an owned namespace rather than minting a sibling
- [ ] Helpers reused, not re-derived; functions within 20-30 lines
- [ ] Proof scripts are checkout-agnostic: no assumed default branch, no assumed local `main`, no assumed git config, no macOS-only tools
- [ ] Result-envelope contract honored where touched: `{name, sha256, bytes}`, `name` not `path`

## Verification

- [ ] `pnpm typecheck`
- [ ] `pnpm proof`
- [ ] `pnpm build`
- [ ] Added or updated regression coverage where appropriate

## Risk review

- Local data or migration impact: none / describe
- Pairing or security-boundary impact: none / describe
- SPFN upstream-boundary impact: none / describe
- Platforms exercised: describe
- Visual change: none / screenshots or recording attached
