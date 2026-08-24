#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
./setup.sh >/dev/null

export PATH="$PWD/scratch/bin:$PATH"
export XDG_CONFIG_HOME="$PWD/scratch/xdg"
export XDG_STATE_HOME="$PWD/scratch/state"
export NPM_CONFIG_USERCONFIG="$PWD/scratch/npmrc"

cd scratch/ws/local-docs-check
self work propose "$(cat ../../../plan-v1.txt)" >/dev/null
self work --plain | awk 'NR==1 {print $1}' >../../work-id

echo "review loop ready"
