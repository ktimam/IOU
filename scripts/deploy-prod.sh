#!/usr/bin/env bash
# Preparation only. Funding/deployment requires the separate reviewed identity,
# recovery, canister and controller procedure in docs/06-deployment-and-costs.md.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/mainnet.mjs "${@}"
