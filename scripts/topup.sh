#!/usr/bin/env bash
# IOU top-up — for v1, this is a manual script.
# In v1.1 we'll wire this to a cron canister.

set -euo pipefail

NETWORK="${DFX_NETWORK:-local}"
CANISTER="${CANISTER:-iou_backend}"
THRESHOLD_SDR="${THRESHOLD_SDR:-1}"
TOPUP_AMOUNT_CYCLES="${TOPUP_AMOUNT_CYCLES:-2000000000000}"  # 2T cycles
DRY_RUN="${DRY_RUN:-1}"

# Pull the cycle balance
echo "Checking cycle balance for ${CANISTER} on ${NETWORK}..."
BAL=$(dfx canister status "${CANISTER}" --network "${NETWORK}" 2>/dev/null \
  | grep -i "Balance" \
  | head -1 \
  | awk '{print $NF}')

if [ -z "${BAL}" ]; then
  echo "Could not read balance; is the canister deployed? Run pnpm deploy:local first."
  exit 1
fi

echo "Balance: ${BAL} cycles"

# In SDR (rough): 1 SDR ≈ 1e12 cycles (varies). Threshold stays simple.
THRESHOLD=$((THRESHOLD_SDR * 1000000000000))

if [ "${DRY_RUN}" = "1" ]; then
  echo "DRY-RUN: would top up ${TOPUP_AMOUNT_CYCLES} cycles if balance < ${THRESHOLD}"
  exit 0
fi

echo "Topping up ${CANISTER} with ${TOPUP_AMOUNT_CYCLES} cycles..."
dfx canister deposit-cycles "${CANISTER}" "${TOPUP_AMOUNT_CYCLES}" --network "${NETWORK}"
echo "Done. New balance:"
dfx canister status "${CANISTER}" --network "${NETWORK}" | grep -i Balance
