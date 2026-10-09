#!/usr/bin/env bash
# Build only. Never calls dfx/icp or touches the local canister WASM.
set -euo pipefail
. "$HOME/.cargo/env" 2>/dev/null || true
. "$HOME/.local/share/dfx/env" 2>/dev/null || true
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/.."
export CARGO_TARGET_DIR="$PWD/target/mainnet"
cargo build --locked --target wasm32-unknown-unknown --release --no-default-features --features mainnet
wasm="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/iou_backend.wasm"
test -s "$wasm"
ic-wasm "$wasm" -o "$wasm" metadata candid:service -f src/iou_backend.did -v public
