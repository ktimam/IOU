#!/bin/bash
# The v1/v2 UI-matrix journey: run the fan-out journey in BOTH directions so every critical
# confirmable-action flow (pair, propose, confirm) executes on BOTH OpenChat UI trees:
#   A: v1 proposes (manager, wide browser)   → v2 confirms (mother, narrow browser)
#   B: v2 proposes (mother, narrow browser)  → v1 confirms (manager)
# mother's Chrome is launched with --window-size=390,844 (below the 768px breakpoint) so she boots
# into the v2 tree; the father desktop exe runs the v1 tree by preference (oc-exe-v1.ps1 + reload)
# and is not needed by the matrix. Prereq DMs: manager↔mother (scripts/live/dm-create.ts).
#
# Issue 1 (no-model → guide, not raw JSON prompt): both directions run through journey-fanout.ts,
# which sets the oc:manualExtract="1" test seam on the proposer's OC page before proposing — so the
# matrix drives the deterministic manual-JSON path unchanged. No seam handling is needed here.
#
# Pre-flight: heal-cdp.ts relaunches any profile whose CDP WebSocket handshake has wedged (long-
# driven instances do this; the HTTP endpoint still answers, so a plain port check can't see it).
#   bash scripts/live/journey-matrix.sh
set -u
cd "$(dirname "$0")/../.."

echo "════ Pre-flight: heal wedged CDP profiles ════"
pnpm exec tsx scripts/live/heal-cdp.ts 9241 9242 || { echo "MATRIX FAILED: CDP heal"; exit 1; }

echo
echo "════ Direction A: v1 → v2 (manager proposes, mother confirms) ════"
pnpm exec tsx scripts/live/journey-fanout.ts --proposer manager:9241:9241 --confirmer mother:9242:9242 \
  || { echo "MATRIX FAILED: direction A"; exit 1; }

echo
echo "════ Direction B: v2 → v1 (mother proposes, manager confirms) ════"
pnpm exec tsx scripts/live/journey-fanout.ts --proposer mother:9242:9242 --confirmer manager:9241:9241 \
  || { echo "MATRIX FAILED: direction B"; exit 1; }

echo
echo "🏁🏁 MATRIX PASSED: both UI trees exercised on both sides of the journey"
