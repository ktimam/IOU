#!/usr/bin/env bash
# Build the Rust canister to wasm, then inject the candid:service
# metadata so `dfx canister call` (and the Candid UI) can find the
# interface without falling back to the local build artifact.
#
# Usage: called by `dfx deploy iou_backend` via the `build` field in
# dfx.json. Also can be run directly: `scripts/build-backend.sh`.

set -euo pipefail

# Ensure dfx env (gives us ic-wasm) and Rust on PATH
. "$HOME/.local/share/dfx/env" 2>/dev/null || true
. "$HOME/.cargo/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$HOME/.local/node20/bin:$PATH"

cd "$(dirname "$0")/.."

echo "=== cargo build --target wasm32-unknown-unknown --release ==="
cargo build --target wasm32-unknown-unknown --release

WASM="target/wasm32-unknown-unknown/release/iou_backend.wasm"
CANDID="src/iou_backend.did"

if [ ! -f "$WASM" ]; then
  echo "WASM not found at $WASM"
  exit 1
fi

if [ ! -f "$CANDID" ]; then
  echo "Candid file not found at $CANDID"
  exit 1
fi

echo "=== ic-wasm metadata: candid:service from $CANDID ==="
# Injects the candid as a public custom section in the wasm so the
# runtime can serve it via /api/v2/canister/<id>/candid and dfx
# can find the interface without falling back to the local file.
# Done before any shrink/optimize step to ensure the metadata section
# survives the pipeline.
ic-wasm "$WASM" metadata candid:service -f "$CANDID" -v public

echo "=== shrunk + optimized ==="
# Shrink (removes unused symbols). Done AFTER metadata so the
# candid section is preserved. (ic-wasm shrink only removes custom
# sections it doesn't know about.)
ic-wasm "$WASM" shrink || true

echo "=== done ==="
ls -la "$WASM"
