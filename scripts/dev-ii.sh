#!/usr/bin/env bash
# Deploy a LOCAL Internet Identity canister so sign-in works against the
# local IOU replica. Mainnet II delegations can't be verified by a local
# replica, so local dev needs its own II. Uses the II "dev" build, which
# allows http origins and skips the captcha. Downloads it on first run.
#
# Prereq: the IOU replica is running (dfx start, port 40436 per dfx.json).
# Usage: bash scripts/dev-ii.sh
set -euo pipefail

export PATH="$HOME/.local/share/dfx/bin:$HOME/.local/node20/bin:$PATH"
export DFX_WARNING=-mainnet_plaintext_identity
DFX=/home/kiko/.local/share/dfx/bin/dfx
cd "$(dirname "$0")/.."

REL="https://github.com/dfinity/internet-identity/releases/latest/download"
mkdir -p ii
[ -f ii/internet_identity_dev.wasm.gz ] || curl -fsSL -o ii/internet_identity_dev.wasm.gz "$REL/internet_identity_dev.wasm.gz"
[ -f ii/internet_identity.did ]         || curl -fsSL -o ii/internet_identity.did "$REL/internet_identity.did"

"$DFX" deploy internet_identity --argument '(null)'
echo "II_LOCAL_ID=$("$DFX" canister id internet_identity)"
