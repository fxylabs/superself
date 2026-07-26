# delivery

The repo-owned ledger for the issue delivery lifecycle: it records what an
accepted issue has actually proved, and refuses every transition whose evidence
is missing.

The contract it enforces — states, gates, recorded evidence, and what never
enters the record — is
[docs/maintainers/issue-delivery-lifecycle.md](../../docs/maintainers/issue-delivery-lifecycle.md).

```bash
node bin/delivery.mjs states              # print the enforced graph
node bin/delivery.mjs status --issue 123  # current state and missing evidence
node bin/delivery.mjs comment --issue 123 # the evidence chain, ready to post
```

This package is private and never published. The polling runner that calls it is
machine-specific and lives outside this repository; the gates and their proof
live here so the contract cannot be argued with per issue.

Run `pnpm proof` from the repository root to exercise the whole lifecycle,
including a real workspace smoked with the built CLI.
