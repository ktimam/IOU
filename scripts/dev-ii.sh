#!/usr/bin/env bash
# Deploy a LOCAL Internet Identity canister so sign-in works against the
# local IOU replica. Mainnet II delegations can't be verified by a local
# replica, so local dev needs its own II. Uses the II "dev" build (allows
# http, no captcha).
#
# IMPORTANT: pin an II release that matches the local dfx era. The `latest`
# II build certifies its assets in a newer format than older dfx gateways
# verify, which trips "Response verification failed: Certification values
# not found" in the browser. dfx 0.27.0 (2025-05-20) ↔ II release-2025-05-03.
# Override with: II_RELEASE=release-YYYY-MM-DD bash scripts/dev-ii.sh
#
# Prereq: the IOU replica is running (dfx start, port 40436 per dfx.json).
set -euo pipefail

export PATH="$HOME/.local/share/dfx/bin:$HOME/.local/node20/bin:$PATH"
export DFX_WARNING=-mainnet_plaintext_identity
DFX=/home/kiko/.local/share/dfx/bin/dfx
cd "$(dirname "$0")/.."

II_RELEASE="${II_RELEASE:-release-2025-05-03}"
REL="https://github.com/dfinity/internet-identity/releases/download/${II_RELEASE}"
mkdir -p ii
echo "→ fetching Internet Identity ${II_RELEASE} (dev build)…"
curl -fsSL -o ii/internet_identity_dev.wasm.gz "$REL/internet_identity_dev.wasm.gz"
curl -fsSL -o ii/internet_identity.did        "$REL/internet_identity.did"

# reinstall so a pin/version change cleanly replaces the code
"$DFX" deploy internet_identity --argument '(null)' --mode reinstall --yes
echo "II_LOCAL_ID=$("$DFX" canister id internet_identity)"
