#!/bin/bash
# The v1/v2 UI-matrix journey: run the fan-out journey in BOTH directions so every critical
# confirmable-action flow (pair, propose, confirm) executes on BOTH OpenChat UI trees:
#   A: v1 proposes (manager, wide browser)  → v2 confirms (father, desktop exe)
#   B: v2 proposes (mother, NARROW browser — OC_MOBILE_LAYOUT=v2 + width<breakpoint at boot)
#      → v1 confirms (manager)
# Prereqs: live env up (replica/frontends/profiles), mother's Chrome launched with
# --window-size=390,844 so she boots into the v2 tree, and DMs manager↔father + manager↔mother
# materialized (scripts/live/dm-create.ts).
#   bash scripts/live/journey-matrix.sh
set -u
cd "$(dirname "$0")/../.."

echo "════ Direction A: v1 → v2 (manager proposes, father confirms) ════"
pnpm exec tsx scripts/live/journey-fanout.ts || { echo "MATRIX FAILED: direction A"; exit 1; }

echo
echo "════ Direction B: v2 → v1 (mother proposes, manager confirms) ════"
pnpm exec tsx scripts/live/journey-fanout.ts --proposer mother:9242:9242 --confirmer manager:9241:9241 \
  || { echo "MATRIX FAILED: direction B"; exit 1; }

echo
echo "🏁🏁 MATRIX PASSED: both UI trees exercised on both sides of the journey"
