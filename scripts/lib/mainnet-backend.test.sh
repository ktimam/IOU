#!/usr/bin/env bash
# Synthetic regression checks only: no Rust compilation, credentials or network.
set -euo pipefail
repository="$(cd "$(dirname "$0")/../.." && pwd -P)"
temporary_base="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
test_root="$(mktemp -d "$temporary_base/iou-mainnet-backend.XXXXXX")"
cleanup() {
  if [[ -n "$test_root" && "$test_root" == "$temporary_base/iou-mainnet-backend."* ]]; then
    rm -rf -- "$test_root"
  fi
}
trap cleanup EXIT

# Functions take precedence over the build script's real Cargo PATH entry.
cargo() {
  [[ "$*" == 'build --locked --target wasm32-unknown-unknown --release --no-default-features --features mainnet' ]]
}
ic-wasm() {
  [[ "$2" == '-o' && "$4" == 'metadata' && "$5" == 'candid:service' ]]
  case "$IOU_TEST_METADATA_MODE" in
    success) cp -- "$1" "$3"; printf '\npublic-candid-metadata' >> "$3" ;;
    failure) printf 'partial-output' > "$3"; return 23 ;;
    empty) : > "$3" ;;
    *) return 24 ;;
  esac
}
export -f cargo ic-wasm

fixture() {
  case_root="$test_root/$1 project with spaces"
  release="$case_root/target/mainnet/wasm32-unknown-unknown/release"
  wasm="$release/iou_backend.wasm"
  dependency="$release/deps/iou_backend-cached.wasm"
  local_wasm="$case_root/target/wasm32-unknown-unknown/release/iou_backend.wasm"
  mkdir -p "$case_root/scripts" "$case_root/src" "$release/deps" "$(dirname "$local_wasm")"
  cp -- "$repository/scripts/build-mainnet-backend.sh" "$case_root/scripts/"
  printf 'service : {}' > "$case_root/src/iou_backend.did"
  printf 'synthetic-cargo-wasm' > "$dependency"
  ln -- "$dependency" "$wasm"
  printf 'preserve-local-wasm' > "$local_wasm"
}
unchanged_dependencies() {
  [[ "$(< "$dependency")" == 'synthetic-cargo-wasm' ]]
  [[ "$(< "$local_wasm")" == 'preserve-local-wasm' ]]
  if compgen -G "$wasm.metadata.*" > /dev/null; then
    echo 'Metadata temporary file was not cleaned up.' >&2
    return 1
  fi
}

fixture success
export IOU_TEST_METADATA_MODE=success
bash "$case_root/scripts/build-mainnet-backend.sh"
[[ "$(stat -c %h "$wasm")" == 1 ]]
[[ "$(< "$wasm")" == $'synthetic-cargo-wasm\npublic-candid-metadata' ]]
unchanged_dependencies
echo 'PASS: Cargo hardlink detached; metadata added; deps/local artifacts preserved.'

for mode in failure empty; do
  fixture "$mode"
  export IOU_TEST_METADATA_MODE="$mode"
  if bash "$case_root/scripts/build-mainnet-backend.sh"; then
    echo "Unexpected success for metadata mode: $mode" >&2
    exit 1
  fi
  [[ "$(stat -c %h "$wasm")" == 2 ]]
  [[ "$(< "$wasm")" == 'synthetic-cargo-wasm' ]]
  unchanged_dependencies
  echo "PASS: $mode output rejected; original artifacts preserved; temporary output removed."
done

fixture symlink
rm -- "$wasm"
ln -s -- "$dependency" "$wasm"
export IOU_TEST_METADATA_MODE=success
if bash "$case_root/scripts/build-mainnet-backend.sh"; then
  echo 'Unexpected success for a symlinked source.' >&2
  exit 1
fi
unchanged_dependencies
echo 'PASS: symlinked build source rejected without changing its target.'
