#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
./setup.sh
vhs intro.tape
