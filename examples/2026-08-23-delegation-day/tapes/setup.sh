#!/usr/bin/env bash
# Builds the throwaway workspace the tapes record against. Everything lives
# under ./scratch next to this script; nothing touches the machine's real
# self workspace because XDG_CONFIG_HOME and XDG_STATE_HOME point inside it.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf scratch
mkdir -p scratch/xdg scratch/state scratch/ws/delegation-day
export XDG_CONFIG_HOME="$PWD/scratch/xdg"
export XDG_STATE_HOME="$PWD/scratch/state"
command -v self >/dev/null || { echo "self is not on PATH"; exit 1; }
(
    cd scratch/ws
    self init --git --lang en >/dev/null
)
cd scratch/ws/delegation-day
git init -q .
git -c user.name=operator -c user.email=operator.invalid commit -q --allow-empty -m "delegation day: six briefs reviewed"
git rev-parse --short HEAD > ../../evidence-sha
self project init --name delegation-day --desc "Throwaway project for the tutorial-one tapes" >/dev/null
# The real goal of the project, shortened to one line.
self goal add "Build Superself as the Company State Engine: one text entity model, current truth derivable from the event log, context as its projection" >/dev/null
# The six outcome lines are the real briefs of 2026-08-23, shortened to one line each.
self work add "dsh-plugin-superself is public: installable with dsh plugin add from npm, its entry merged in awesome-dsh-plugin, announced in the DSH Discord" >/dev/null
self work add "self entries are merged into at least 3 existing agent-rules/AGENTS.md front-door lists, after a recorded survey of each list's rules" >/dev/null
self work add "superselfs.com has a use-with guide generator: /use-with/<harness> pages, sitemap.xml, robots.txt and llms.txt, delivered as one reviewed PR" >/dev/null
self work add "English discovery channels are examined before any posting: a recorded table per channel with rules, base rates, exemplar threads, windows and drafts; nothing is posted" >/dev/null
self work add "superselfs.com has a /talk screening page in Korean and English: five questions, pass/fail by stated rules, submissions stored and the maintainer notified" >/dev/null
self work add "The adoption-metrics snapshot runs again daily and reads truthfully: the stalled launchd job diagnosed and fixed, dev.to views verified, reach verdict per channel added" >/dev/null
# One proposed decision, so "Waiting on you" has a line to confirm.
self decide "M1 front-door strategy: Superself does not open its own curated repo now; it gets listed in the existing agent-rules and AGENTS.md front-door lists by PR, and opens a repo only when the wave-watch trigger fires" \
    --why "The lane is already served by lists with 5K-40K stars; a late entrant with no wave gets a few hundred stars at best" \
    --proposed | sed -nE 's/.*\[([0-9a-z]+)\].*/\1/p' > ../../decision-id
self work --plain | sed -nE 's/^(w-[0-9a-z]+).*/\1/p' | head -1 > ../../first-work-id
self work --plain | sed -nE 's/^(w-[0-9a-z]+).*/\1/p' | sed -n 2p > ../../second-work-id
echo "scratch workspace ready; decision id $(cat ../../decision-id), first work id $(cat ../../first-work-id), evidence $(cat ../../evidence-sha)"
