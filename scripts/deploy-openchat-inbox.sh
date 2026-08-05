#!/usr/bin/env bash
# Allocate, install, or explicitly upgrade IOU's per-app OpenChat ActionInbox on a local replica.
#
# This helper intentionally does not carry a handwritten copy of ActionInbox's public API. It
# validates and copies the canonical Candid from the selected OpenChat worktree, then adds only the
# lifecycle init signature required by dfx for a custom canister. Existing canisters are never
# reinstalled or recreated: a changed Wasm requires --upgrade and uses the canister upgrade mode.
#
# Validation only (no repository, dfx, canister, or replica mutation):
#   ACTION_INBOX_WASM=<open-chat>/wasms/action_inbox.wasm.gz \
#     bash scripts/deploy-openchat-inbox.sh --check
#
# Allocate a stable canister id before the OpenChat app id exists:
#   ACTION_INBOX_WASM=<open-chat>/wasms/action_inbox.wasm.gz \
#     bash scripts/deploy-openchat-inbox.sh
#
# Fresh install after registration, or explicit state-preserving upgrade:
#   OC_APP_ID=<app id> OC_USER_INDEX_CANISTER_ID=<user_index> \
#   OC_CYCLES_DISPENSER_CANISTER_ID=<cycles_dispenser> \
#   ACTION_INBOX_WASM=<open-chat>/wasms/action_inbox.wasm.gz \
#     bash scripts/deploy-openchat-inbox.sh [--upgrade]
set -euo pipefail

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

CHECK_ONLY=0
ALLOW_UPGRADE=0
for arg in "$@"; do
  case "$arg" in
    --check|--dry-run) CHECK_ONLY=1 ;;
    --upgrade) ALLOW_UPGRADE=1 ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *) fail "unknown argument: $arg" ;;
  esac
done

IC_URL="${IC_URL:-http://127.0.0.1:8080}"
NETWORK="${DFX_NETWORK:-local}"
WASM_INPUT="${ACTION_INBOX_WASM:?set ACTION_INBOX_WASM to the rebuilt OpenChat action_inbox.wasm.gz}"
APP_ID="${OC_APP_ID:-}"
USER_INDEX="${OC_USER_INDEX_CANISTER_ID:-}"
CYCLES_DISPENSER="${OC_CYCLES_DISPENSER_CANISTER_ID:-}"
INBOX_DIR="${INBOX_DIR:-.openchat-inbox}"

[ "$NETWORK" = "local" ] || fail "this test-mode helper permits only DFX_NETWORK=local"
case "$IC_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) fail "this test-mode helper permits only a loopback IC_URL" ;;
esac
[ -f "$WASM_INPUT" ] || fail "ActionInbox Wasm not found: $WASM_INPUT"
WASM="$(cd "$(dirname "$WASM_INPUT")" && pwd)/$(basename "$WASM_INPUT")"
gzip -t "$WASM" || fail "ActionInbox Wasm is not a valid gzip stream: $WASM"

if [ -n "${OPENCHAT_ROOT:-}" ]; then
  OC_ROOT="$(cd "$OPENCHAT_ROOT" && pwd)"
else
  OC_ROOT="$(cd "$(dirname "$WASM")/.." && pwd)"
fi
CANONICAL_DID="${ACTION_INBOX_CANDID:-$OC_ROOT/backend/canisters/action_inbox/api/can.did}"
INIT_RS="$OC_ROOT/backend/canisters/action_inbox/api/src/lifecycle/init.rs"
POST_UPGRADE_RS="$OC_ROOT/backend/canisters/action_inbox/api/src/lifecycle/post_upgrade.rs"
[ -f "$CANONICAL_DID" ] || fail "canonical ActionInbox Candid not found: $CANONICAL_DID"
[ -f "$INIT_RS" ] || fail "canonical ActionInbox init schema not found: $INIT_RS"
[ -f "$POST_UPGRADE_RS" ] || fail "canonical ActionInbox post-upgrade schema not found: $POST_UPGRADE_RS"

# Refuse the old v2/v3 interface and fail closed when PR2 changes again. These checks make a stale
# generated Wasm or lifecycle schema visible before any canister id is allocated or code installed.
for required in \
  'action_id : text;' \
  'signing_key_id : blob;' \
  'card_context_hash : blob;' \
  'app_revision : nat64;' \
  'signature_version : nat16;' \
  'idempotency_key : blob;' \
  'payload_hash : blob;' \
  'actions : (Args_1) -> (Response_1);'
do
  grep -Fq "$required" "$CANONICAL_DID" \
    || fail "canonical ActionInbox Candid is missing required PR2 v4 contract: $required"
done
if grep -Eq 'actions[[:space:]]*:.*query[[:space:]]*;' "$CANONICAL_DID"; then
  fail "ActionInbox actions must be a replicated update, not a query"
fi
if grep -Fq 'openchat_public_key' "$CANONICAL_DID"; then
  fail "legacy ActionInbox public-key endpoint must not be present"
fi
[ "$(sed 's/\r$//' "$CANONICAL_DID" | grep -c '^service : {$')" -eq 1 ] \
  || fail "canonical ActionInbox Candid service declaration changed; review the generator"

for field in app_id user_index_canister_id cycles_dispenser_canister_id deployment_operators authorized_depositors wasm_version test_mode; do
  grep -Eq "pub[[:space:]]+$field[[:space:]]*:" "$INIT_RS" \
    || fail "canonical ActionInbox init schema is missing $field"
done
if grep -Fq 'oc_signing_public_key_pem' "$INIT_RS"; then
  fail "legacy ActionInbox init signing-key field must not be present"
fi
grep -Eq 'pub[[:space:]]+wasm_version[[:space:]]*:' "$POST_UPGRADE_RS" \
  || fail "canonical ActionInbox post-upgrade schema is missing wasm_version"

STALE_SOURCE="$(find \
  "$OC_ROOT/backend/canisters/action_inbox/api/src" \
  "$OC_ROOT/backend/canisters/action_inbox/impl/src" \
  "$CANONICAL_DID" \
  -type f -newer "$WASM" -print -quit)"
[ -z "$STALE_SOURCE" ] \
  || fail "ActionInbox Wasm predates source/Candid ($STALE_SOURCE); rebuild it before deployment"

if [ -n "$APP_ID" ]; then
  printf '%s' "$APP_ID" | grep -Eq '^[0-9]+$' || fail "OC_APP_ID must be an unsigned decimal integer"
  [ "$APP_ID" -le 4294967295 ] || fail "OC_APP_ID exceeds nat32"
  [ -n "$USER_INDEX" ] || fail "set OC_USER_INDEX_CANISTER_ID for install/upgrade"
  [ -n "$CYCLES_DISPENSER" ] || fail "set OC_CYCLES_DISPENSER_CANISTER_ID for install/upgrade"
fi

VERSION="${ACTION_INBOX_WASM_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(awk '
    { sub(/\r$/, "") }
    /^\[workspace\.package\]$/ { in_package=1; next }
    in_package && /^version[[:space:]]*=/ {
      value=$0
      sub(/^[^"]*"/, "", value)
      sub(/".*$/, "", value)
      print value
      exit
    }
  ' "$OC_ROOT/Cargo.toml")"
fi
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "ACTION_INBOX_WASM_VERSION must be major.minor.patch"
IFS=. read -r VERSION_MAJOR VERSION_MINOR VERSION_PATCH <<EOF
$VERSION
EOF
for part in "$VERSION_MAJOR" "$VERSION_MINOR" "$VERSION_PATCH"; do
  [ "$part" -le 4294967295 ] || fail "Wasm version component exceeds nat32"
done

TMP_DIR="$(mktemp -d)"
GENERATED_DID="$TMP_DIR/action_inbox.did"
cleanup() {
  rm -f "$GENERATED_DID"
  rmdir "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT
{
  cat <<'DID'
type InitArgs = record {
  app_id : nat32;
  user_index_canister_id : principal;
  cycles_dispenser_canister_id : principal;
  deployment_operators : vec principal;
  authorized_depositors : vec principal;
  wasm_version : record { major : nat32; minor : nat32; patch : nat32 };
  test_mode : bool;
};
DID
  LC_ALL=C sed \
    -e '1s/^\xEF\xBB\xBF//' \
    -e 's/\r$//' \
    -e 's/^service : {$/service : (InitArgs) -> {/' \
    "$CANONICAL_DID"
} > "$GENERATED_DID"
command -v didc >/dev/null 2>&1 || fail "didc is required to validate the generated lifecycle Candid"
didc check "$GENERATED_DID"

# The management canister hashes the exact module blob submitted by dfx. For a .wasm.gz input,
# `canister status` therefore reports the compressed file's SHA-256, not the decompressed Wasm hash.
LOCAL_WASM_HASH="$(sha256sum "$WASM" | awk '{print $1}')"
printf 'ActionInbox preflight OK\n'
printf '  OpenChat root: %s\n' "$OC_ROOT"
printf '  canonical Candid: %s\n' "$CANONICAL_DID"
printf '  Wasm SHA-256: %s\n' "$LOCAL_WASM_HASH"
printf '  lifecycle version: %s\n' "$VERSION"
printf '  target: %s (%s)\n' "$IC_URL" "$NETWORK"

if [ "$CHECK_ONLY" -eq 1 ]; then
  if [ -n "$APP_ID" ]; then
    printf '  plan: install app_id=%s or explicitly upgrade it when --upgrade is supplied\n' "$APP_ID"
  else
    printf '  plan: allocate/reuse the stable ActionInbox canister id; install only after OC_APP_ID exists\n'
  fi
  printf 'ACTION_INBOX_CHECK_ONLY=true\n'
  exit 0
fi

command -v dfx >/dev/null 2>&1 || fail "dfx is required outside --check mode"
mkdir -p "$INBOX_DIR"
cp "$GENERATED_DID" "$INBOX_DIR/action_inbox.did"
cat > "$INBOX_DIR/dfx.json" <<JSON
{ "canisters": { "action_inbox": { "type": "custom", "candid": "action_inbox.did", "wasm": "$WASM" } },
  "networks": { "$NETWORK": { "bind": "${IC_URL#http://}", "type": "ephemeral" } }, "version": 1 }
JSON

cd "$INBOX_DIR"
if AID="$(dfx canister --network "$NETWORK" id action_inbox 2>/dev/null)"; then
  if ! STATUS="$(dfx canister --network "$NETWORK" status action_inbox 2>&1)"; then
    fail "recorded ActionInbox $AID is unavailable; refusing to discard its state or allocate a replacement"
  fi
else
  dfx canister create action_inbox --network "$NETWORK" >&2
  AID="$(dfx canister --network "$NETWORK" id action_inbox)"
  STATUS="$(dfx canister --network "$NETWORK" status action_inbox)"
fi

INSTALLED_HASH="$(printf '%s\n' "$STATUS" | sed -n 's/^Module hash: 0x//p' | tr '[:upper:]' '[:lower:]')"
if [ -z "$APP_ID" ]; then
  printf 'ACTION_INBOX_CANISTER_ID=%s\n' "$AID"
  if [ -n "$INSTALLED_HASH" ]; then
    printf 'ACTION_INBOX_INSTALLED=true\n'
    printf 'ActionInbox already contains Wasm; no code or state was changed without OC_APP_ID.\n' >&2
  else
    printf 'ACTION_INBOX_INSTALLED=false\n'
    printf 'ActionInbox allocated but not installed; register the app, then rerun with OC_APP_ID.\n' >&2
  fi
  exit 0
fi

verify_configuration() {
  local cfg occurrences
  cfg="$(dfx canister --network "$NETWORK" call --query action_inbox configuration '(record {})')" \
    || fail "ActionInbox configuration query failed"
  printf '%s' "$cfg" | grep -Eq "app_id[[:space:]]*=[[:space:]]*$APP_ID([[:space:]]*:[[:space:]]*nat32)?" \
    || fail "ActionInbox configuration does not match app_id=$APP_ID"
  occurrences="$(printf '%s' "$cfg" | grep -oF "$USER_INDEX" | wc -l | tr -d ' ')"
  [ "$occurrences" -eq 2 ] \
    || fail "ActionInbox must name UserIndex as config owner and its sole authorized depositor"
}

if [ -z "$INSTALLED_HASH" ]; then
  cat > init.txt <<EOF
(record {
  app_id = $APP_ID : nat32;
  user_index_canister_id = principal "$USER_INDEX";
  cycles_dispenser_canister_id = principal "$CYCLES_DISPENSER";
  deployment_operators = vec {};
  authorized_depositors = vec { principal "$USER_INDEX" };
  wasm_version = record { major = $VERSION_MAJOR : nat32; minor = $VERSION_MINOR : nat32; patch = $VERSION_PATCH : nat32 };
  test_mode = true;
})
EOF
  dfx canister install --network "$NETWORK" --mode install --wasm "$WASM" \
    --argument-file init.txt action_inbox >&2
elif [ "$INSTALLED_HASH" = "$LOCAL_WASM_HASH" ]; then
  verify_configuration
  printf 'ActionInbox already runs the requested Wasm; no code or state was changed.\n' >&2
elif [ "$ALLOW_UPGRADE" -ne 1 ]; then
  verify_configuration
  fail "ActionInbox already has different Wasm; rerun with --upgrade for an explicit in-place upgrade"
else
  # Validate immutable routing before the await/upgrade boundary. `upgrade`, never `reinstall`,
  # preserves stable memory; a trapping post_upgrade leaves the previous module/state installed.
  verify_configuration
  cat > upgrade.txt <<EOF
(record {
  wasm_version = record { major = $VERSION_MAJOR : nat32; minor = $VERSION_MINOR : nat32; patch = $VERSION_PATCH : nat32 };
})
EOF
  dfx canister install --network "$NETWORK" --mode upgrade --wasm "$WASM" \
    --argument-file upgrade.txt action_inbox >&2
fi

verify_configuration
STATUS="$(dfx canister --network "$NETWORK" status action_inbox)"
DEPLOYED_HASH="$(printf '%s\n' "$STATUS" | sed -n 's/^Module hash: 0x//p' | tr '[:upper:]' '[:lower:]')"
[ "$DEPLOYED_HASH" = "$LOCAL_WASM_HASH" ] \
  || fail "deployed module hash does not match the requested ActionInbox Wasm"

printf 'binding verified: app_id=%s user_index=%s sole_depositor=%s\n' \
  "$APP_ID" "$USER_INDEX" "$USER_INDEX" >&2
printf 'ACTION_INBOX_CANISTER_ID=%s\n' "$AID"
printf 'ACTION_INBOX_INSTALLED=true\n'
printf 'ACTION_INBOX_WASM_SHA256=%s\n' "$LOCAL_WASM_HASH"
