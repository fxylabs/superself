#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(git rev-parse --show-toplevel)"

rm -rf scratch
mkdir -p scratch/bin scratch/xdg scratch/state scratch/ws
touch scratch/npmrc
ln -s "$REPO_ROOT/apps/cli/bin/self.mjs" scratch/bin/self

export PATH="$PWD/scratch/bin:$PATH"
export XDG_CONFIG_HOME="$PWD/scratch/xdg"
export XDG_STATE_HOME="$PWD/scratch/state"
export NPM_CONFIG_USERCONFIG="$PWD/scratch/npmrc"

(
    cd scratch/ws
    self init --lang en >/dev/null
)

git clone -q ../repository.bundle scratch/ws/local-docs-check
cd scratch/ws/local-docs-check
git reset -q --hard fe66f40
self project init --name recorded-local-docs-check --desc "Isolated replay of the reviewed work loop" >/dev/null

echo "recording workspace ready at fe66f40"
