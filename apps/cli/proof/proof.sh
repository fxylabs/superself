#!/usr/bin/env bash
# The proof sweep. Every suite in proof/suites.json runs in its own scratch
# state, in parallel; `proof.sh <suite> ...` runs only the named suites, which
# is the dev loop's partial run (`pnpm proof -- <suite>`). Orchestration lives
# in run.mjs, where a failing suite takes its siblings' process groups down
# with it instead of orphaning them.
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/run.mjs" "$@"
