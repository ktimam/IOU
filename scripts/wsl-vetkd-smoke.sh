#!/usr/bin/env bash
# scripts/wsl-vetkd-smoke.sh — full reset + vetkd smoke for IOU.
#
# Designed to be called from the Windows side as:
#   wsl -d Ubuntu -- bash /mnt/c/Kiko/MyProjects/IOU/scripts/wsl-vetkd-smoke.sh
#
# What it does:
#   1. Confirms (or starts) a replica.
#   2. Uninstalls the iou_backend canister code (wipes stable state).
#   3. cargo build (default = PocketIC).
#   4. dfx deploy iou_backend (re-stages wasm, installs).
#   5. dfx deploy iou_assets (PWA).
#   6. Runs scripts/awa-smoke-vetkd.ts.
set -uo pipefail
export PATH="/home/kiko/.local/node20/bin:/home/kiko/.cargo/bin:/home/kiko/.local/share/dfx/bin:$PATH"
cd /mnt/c/Kiko/MyProjects/IOU

# Confirm replica is up; if not, start one (detached to avoid the
# WSL stdout-capture hang on plain `dfx start --background`).
if ! dfx ping >/dev/null 2>&1; then
  echo "replica not running; starting it (detached)..."
  bash scripts/wsl-start-pic.sh
fi
dfx ping 2>&1 | head -1

# Uninstall the iou_backend canister code (wipes stable state).
# This makes the smoke idempotent: re-running won't fail on
# "already in an active pair" or duplicate entry ids.
echo "=== uninstall iou_backend (wipe stable state) ==="
dfx canister uninstall-code iou_backend 2>&1 | tail -3 || true

# Build + deploy.
echo "=== cargo build ==="
cargo build --target wasm32-unknown-unknown --release 2>&1 | tail -3

echo "=== dfx deploy iou_backend ==="
dfx deploy iou_backend 2>&1 | tail -5

echo "=== pnpm install (postinstall patches vetkeys) ==="
pnpm install --prefer-offline 2>&1 | tail -3

echo "=== pnpm build (assets) ==="
pnpm build 2>&1 | tail -3

echo "=== dfx deploy iou_assets ==="
dfx deploy iou_assets 2>&1 | tail -3

# Run the vetkd smoke.
echo "=== smoke ==="
SMOKE_CANISTER_ID="$(dfx canister id iou_backend)" \
SMOKE_HOST="http://127.0.0.1:4943" \
pnpm exec tsx scripts/awa-smoke-vetkd.ts
SMOKE_EXIT=$?

echo ""
echo "=== smoke exit: $SMOKE_EXIT ==="
exit $SMOKE_EXIT
