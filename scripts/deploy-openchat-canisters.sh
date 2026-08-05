#!/usr/bin/env bash
# Provision IOU's canisters ON the running OpenChat local replica (:8080) and sync .env.local.
#
# WHY THIS EXISTS: OpenChat's `publish_ai_app` c2c-calls the app's `app_canister_id` to verify it
# (c2c_verify_ai_app_v2), so IOU's backend MUST live on the SAME replica as OpenChat's user_index — not
# on IOU's own 40436 replica. This script co-deploys iou_backend + a per-app ActionInbox onto :8080
# and rewrites .env.local with the fresh ids.
#
# RUN THIS (from WSL) *after* OpenChat's replica + canisters are up (see
# open-chat-cycle/LOCAL-DEV.md). It is idempotent while that replica is preserved. After an
# intentional OpenChat --clean, archive the stale .openchat-inbox/.dfx mapping before allocating a
# replacement; this script never discards an existing ActionInbox identity automatically.
#
#   bash scripts/deploy-openchat-canisters.sh
#
# Then finish from a WINDOWS shell (IOU's node_modules is win32-only — register FAILS under WSL):
#   1. register + publish : see the commands this script prints, or docs/local-dev-runbook.md
#   2. start the app      : node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3000 --strictPort
#
# KEY FACTS (so you know what "correct" looks like):
#   - Do NOT hardcode canister ids. They are pool-assigned and depend on deploy order + what already
#     exists, so they are NOT reliably stable across restarts. This script reads the ACTUAL ids from
#     the replica and writes them into .env.local — that is the whole point. Never track ids by hand.
#   - weosr is NOT an inbox — it's a bad value that was once saved into the IOU app's localStorage.
#     The real inbox id is whatever THIS script deploys and prints below.
set -euo pipefail

export PATH="$HOME/.local/share/dfx/versions/0.31.0-beta.1:$HOME/.cache/dfinity/versions/0.31.0-beta.1:$HOME/.local/node20/bin:$PATH"
IOU="$(cd "$(dirname "$0")/.." && pwd)"                              # IOU repo root (this script is in scripts/)
OCC=/mnt/c/Kiko/MyProjects/Blockchain/ICP/open-chat-cycle           # OpenChat frontend/deploy worktree
IC_URL=http://127.0.0.1:8080
II_CANISTER=qhbym-qaaaa-aaaaa-aaafq-cai                             # OpenChat local Internet Identity (fixed)

id_of() { grep -A2 "\"$1\"" "$OCC/.dfx/local/canister_ids.json" | grep -oE '[a-z0-9]{5}-[a-z0-9]{5,}-[a-z0-9-]+-cai' | head -1; }

echo "== 0. OpenChat replica healthy on :8080? =="
curl -s --max-time 5 "$IC_URL/api/v2/status" | tr -d '\0' | grep -q healthy \
  || { echo "OpenChat replica NOT healthy — bring OpenChat up first (open-chat-cycle/LOCAL-DEV.md)"; exit 1; }

USER_INDEX="$(id_of user_index)"
CYCLES_DISPENSER="$(id_of cycles_dispenser)"
[ -n "$USER_INDEX" ] && [ -n "$CYCLES_DISPENSER" ] \
  || { echo "could not read OpenChat user_index/cycles_dispenser ids from $OCC/.dfx/local/canister_ids.json"; exit 1; }
echo "OpenChat user_index=$USER_INDEX  cycles_dispenser=$CYCLES_DISPENSER"

echo "== 1. build iou_backend wasm if missing =="
WASM="$IOU/target/wasm32-unknown-unknown/release/iou_backend.wasm"
[ -f "$WASM" ] || ( cd "$IOU" && bash scripts/build-backend.sh )

echo "== 2. deploy iou_backend on :8080 (co-located) =="
D="$IOU/.openchat-iou"; mkdir -p "$D"
cat > "$D/dfx.json" <<JSON
{ "canisters": { "iou_backend": { "type": "custom", "candid": "$IOU/src/iou_backend.did", "wasm": "$WASM" } },
  "networks": { "local": { "bind": "127.0.0.1:8080", "type": "ephemeral" } }, "version": 1 }
JSON
# Same reuse-else-recreate dance as the inbox in step 3: the recorded canister id survives in
# .openchat-iou/.dfx, but after an OpenChat `dfx start --clean` that canister no longer exists on the
# replica and `dfx deploy` fails with IC0301 / "Canister ... not found". Only THEN drop the stale
# .dfx and create a fresh one — clearing unconditionally would orphan a canister and mint a new
# iou_backend id (and therefore a stale app_canister_id in the registered manifest) on every run.
OUT="$( cd "$D" && dfx deploy iou_backend --network local 2>&1 || true )"
if printf '%s' "$OUT" | grep -qiE 'IC0301|DestinationInvalid|not found'; then
  echo "  recorded iou_backend canister is gone (replica was --clean'd) — recreating fresh"
  rm -rf "$D/.dfx"
  OUT="$( cd "$D" && dfx deploy iou_backend --network local 2>&1 || true )"
fi
IOU_BACKEND="$( cd "$D" && dfx canister --network local id iou_backend 2>/dev/null )"
[ -n "$IOU_BACKEND" ] || { echo "iou_backend deploy failed:"; printf '%s\n' "$OUT" | tail -15; exit 1; }

echo "== 2b. pin the authoritative OpenChat UserIndex in IOU =="
( cd "$D" && dfx canister --network local call iou_backend set_openchat_user_index_canister_id \
  "(principal \"$USER_INDEX\")" >/dev/null )

echo "== 3. allocate per-app action_inbox on :8080 (install after OpenChat assigns app id) =="
# Reuse the recorded inbox when it still exists on this replica. The helper never deletes its local
# id mapping, recreates an unavailable canister, or reinstalls an existing canister. An intentional
# replica --clean requires a separate, explicit cleanup of the now-stale local mapping.
run_inbox() {
  OC_USER_INDEX_CANISTER_ID="$USER_INDEX" \
  OC_CYCLES_DISPENSER_CANISTER_ID="$CYCLES_DISPENSER" \
  ACTION_INBOX_WASM="$OCC/wasms/action_inbox.wasm.gz" \
  ACTION_INBOX_CANDID="$OCC/backend/canisters/action_inbox/api/can.did" \
  OPENCHAT_ROOT="$OCC" IC_URL="$IC_URL" \
  bash "$IOU/scripts/deploy-openchat-inbox.sh" 2>&1
}
if ! OUT="$(run_inbox)"; then
  echo "inbox allocation/preflight failed:" >&2
  printf '%s\n' "$OUT" | tail -25 >&2
  exit 1
fi
ACTION_INBOX="$(printf '%s' "$OUT" | grep -oE 'ACTION_INBOX_CANISTER_ID=[a-z0-9-]+' | cut -d= -f2)"
[ -n "$ACTION_INBOX" ] || { echo "inbox deploy failed:"; printf '%s\n' "$OUT" | tail -15; exit 1; }

echo "== 4. sync .env.local =="
ENV="$IOU/.env.local"; touch "$ENV"
set_env() { if grep -q "^$1=" "$ENV"; then sed -i "s#^$1=.*#$1=$2#" "$ENV"; else printf '%s=%s\n' "$1" "$2" >> "$ENV"; fi; }
set_env VITE_DFX_NETWORK local
set_env VITE_DFX_PORT 8080
set_env VITE_IOU_BACKEND_CANISTER_ID "$IOU_BACKEND"
set_env VITE_II_CANISTER_ID "$II_CANISTER"
set_env VITE_OC_USER_INDEX_CANISTER_ID "$USER_INDEX"
set_env VITE_ACTION_INBOX_CANISTER_ID "$ACTION_INBOX"
set_env VITE_OPENCHAT_HOST "$IC_URL"
set_env VITE_IOU_PROD_VETKD "1"

cat <<DONE

== canisters provisioned ==
  iou_backend   = $IOU_BACKEND
  action_inbox  = $ACTION_INBOX
  user_index    = $USER_INDEX   (OpenChat; the only id that changes across --clean)
  .env.local updated.

== NEXT (run from a WINDOWS shell — WSL fails: IOU node_modules is win32) ==
  1) register IOU and capture the printed app id + owner:
       cd /c/Kiko/MyProjects/IOU
       OC_USER_INDEX_CANISTER_ID=$USER_INDEX OC_APP_CANISTER_ID=$IOU_BACKEND \\
         OC_ACTION_INBOX_CANISTER_ID=$ACTION_INBOX pnpm register:openchat
  2) install the inbox with that immutable app id (WSL, from IOU):
       OC_USER_INDEX_CANISTER_ID=$USER_INDEX \\
         OC_CYCLES_DISPENSER_CANISTER_ID=$CYCLES_DISPENSER \\
         OC_APP_ID=<id printed by register> ACTION_INBOX_WASM=$OCC/wasms/action_inbox.wasm.gz \\
         OPENCHAT_ROOT=$OCC IC_URL=$IC_URL bash scripts/deploy-openchat-inbox.sh --upgrade
  3) bind the owner, install the exact V2 manifest commitment, and publish (WSL dfx, from .openchat-iou):
       dfx canister --network local call iou_backend set_ai_app_owner \
         '(principal "<owner printed by register:openchat>")'
       dfx canister --network local call iou_backend set_ai_app_verification_binding \
         --argument-file verification-binding.did
       dfx canister --network local call $USER_INDEX publish_ai_app \
         '(record {app_id=<id printed by register:openchat>:nat32})'
  4) start the IOU app:
       cd /c/Kiko/MyProjects/IOU && node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3000 --strictPort
  5) in the IOU app: HARD-RELOAD (Ctrl+Shift+R) so it picks up the new user_index.
DONE
