#!/usr/bin/env bash
# Reset the IOU backend canister state for the smoke test.
# This uninstalls and re-deploys the canister, wiping all
# pair / sheet / user data.
set -e

. "$HOME/.local/share/dfx/env" 2>/dev/null || true
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$HOME/.local/node20/bin:$PATH"

cd "$(dirname "$0")/.."

# Ensure the controller identity is selected
dfx identity use default

# Ensure identities exist
for name in tester partner; do
  dfx identity list | grep -q "^${name}$" || \
    dfx identity new "$name" --storage-mode plaintext
done

# Reset
echo "=== uninstalling iou_backend ==="
dfx canister uninstall-code iou_backend 2>&1 | tail -2

echo "=== redeploying iou_backend ==="
dfx deploy iou_backend 2>&1 | tail -3

echo "=== ready. run pnpm smoke ==="
