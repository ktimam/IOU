#!/usr/bin/env bash
# scripts/deploy-prod.sh — build + deploy the IOU canister to IC mainnet.
#
# Flow:
#   1. Verifies prerequisites: dfx >= 0.27 (for ic-cdk 0.20 support),
#      an active cycles wallet, and the VITE_IOU_PROD_VETKD flag.
#   2. Builds the canister. The vetkd IBE endpoints are always
#      compiled in (v1.1.1+); no cargo feature gate needed.
#   3. Builds the PWA with VITE_IOU_PROD_VETKD=1 (uses the prod
#      adapter for sheet key wrap/unwrap).
#   4. Deploys the backend canister to the IC mainnet, then the
#      assets canister.
#   5. Prints the live URL.
#
# Usage:
#   IOU_WALLET=xxxxx-cycles-wallet-principal pnpm deploy:ic

set -euo pipefail

. "${HOME}/.cargo/env"
. "${HOME}/.local/share/dfx/env"
export PATH="${HOME}/.cargo/bin:${HOME}/.local/node20/bin:${PATH}"

cd "$(dirname "$0")/.."

# ─── 1. prereqs ───
if ! command -v dfx >/dev/null 2>&1; then
  echo "❌ dfx not found. Install dfx 0.27+ (https://sdk.dfinity.org)." >&2
  exit 1
fi
DFX_VERSION="$(dfx --version | awk '{print $2}')"
DFX_MAJOR="$(echo "$DFX_VERSION" | awk -F. '{print $1}')"
DFX_MINOR="$(echo "$DFX_VERSION" | awk -F. '{print $2}')"
if [ "$DFX_MAJOR" -lt 1 ] && [ "$DFX_MINOR" -lt 27 ]; then
  echo "❌ dfx $DFX_VERSION is too old. The vetkd system API requires dfx 0.27+." >&2
  exit 1
fi
echo "✓ dfx $DFX_VERSION (>= 0.27)"

if [ -z "${IOU_WALLET:-}" ]; then
  echo "❌ IOU_WALLET env var is required (your cycles wallet principal)." >&2
  echo "  Get it with: dfx identity --network ic get-wallet" >&2
  exit 1
fi
echo "✓ cycles wallet: $IOU_WALLET"

# ─── 2. build canister ───
# No --features flag needed: vetkd endpoints are always compiled in
# (v1.1.1+), inspect_message is always active (v1.2.3+). The same
# build works on PocketIC and IC mainnet.
echo "→ building canister..."
cargo build --target wasm32-unknown-unknown --release

# ─── 3. build PWA (with VITE_IOU_PROD_VETKD=1) ───
echo "→ building PWA (VITE_IOU_PROD_VETKD=1)..."
VITE_IOU_PROD_VETKD=1 pnpm build

# ─── 4. deploy ───
echo "→ deploying backend to IC mainnet..."
dfx deploy --network ic iou_backend --wallet "$IOU_WALLET"

echo "→ deploying assets to IC mainnet..."
dfx deploy --network ic iou_assets --wallet "$IOU_WALLET"

# ─── 5. URL ───
CANISTER_ID="$(dfx canister --network ic id iou_assets)"
echo
echo "✅ IOU is live on the IC mainnet."
echo "   https://${CANISTER_ID}.icp0.io/"
echo
echo "Next steps:"
echo "  - Verify with: dfx canister --network ic call iou_backend get_vetkd_key_name"
echo "  - Set VITE_IOU_PROD_VETKD=1 in your hosting env if you self-host the PWA."
