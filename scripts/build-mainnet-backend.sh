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
test -f "$wasm"
test -s "$wasm"
test ! -L "$wasm"
# Cargo hard-links this path to its deps artifact. Do not modify that cached inode
# in place, or relax the single-link guard on the final deployment artifact.
metadata_wasm="$(mktemp "$wasm.metadata.XXXXXX")"
cleanup_metadata() {
  if [[ -n "$metadata_wasm" && "$metadata_wasm" == "$wasm.metadata."* ]]; then
    rm -f -- "$metadata_wasm"
  fi
}
trap cleanup_metadata EXIT
ic-wasm "$wasm" -o "$metadata_wasm" metadata candid:service -f src/iou_backend.did -v public
test -f "$metadata_wasm"
test -s "$metadata_wasm"
test ! -L "$metadata_wasm"
# Same-directory replacement detaches only the generated release path. -T also
# refuses to move the temporary file inside an unexpected destination directory.
mv -fT -- "$metadata_wasm" "$wasm"
metadata_wasm=''
