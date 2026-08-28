#!/bin/bash
# Restore ALL durable profiles after a restart: re-establish each OpenChat session (from the saved
# credential) + each IOU dev sign-in. Assumes launch.ps1 already relaunched the browsers + desktop.
#   OC_LIVE_CREDS_DIR=<credentials-dir> OC_LIVE_OPENCHAT_FRONTEND=<frontend-dir> \
#     bash scripts/live/restore-all.sh
# or:
#   bash scripts/live/restore-all.sh --creds-dir <credentials-dir> \
#     --openchat-frontend <frontend-dir>
set -euo pipefail
cd "$(dirname "$0")/../.."   # IOU repo root

usage() {
  echo "usage: restore-all.sh [--creds-dir <credentials-dir>] [--openchat-frontend <frontend-dir>]" >&2
  echo "       or set OC_LIVE_CREDS_DIR and OC_LIVE_OPENCHAT_FRONTEND" >&2
}

CREDS="${OC_LIVE_CREDS_DIR:-}"
OPENCHAT_FRONTEND="${OC_LIVE_OPENCHAT_FRONTEND:-}"
creds_option=false
frontend_option=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --creds-dir)
      if $creds_option || [[ $# -lt 2 ]]; then
        usage
        exit 2
      fi
      if [[ -z "$2" || "$2" == --* ]]; then
        usage
        exit 2
      fi
      CREDS="$2"
      creds_option=true
      shift 2
      ;;
    --openchat-frontend)
      if $frontend_option || [[ $# -lt 2 ]]; then
        usage
        exit 2
      fi
      if [[ -z "$2" || "$2" == --* ]]; then
        usage
        exit 2
      fi
      OPENCHAT_FRONTEND="$2"
      frontend_option=true
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done
if [[ -z "$CREDS" ]]; then
  echo "restore-all: --creds-dir or OC_LIVE_CREDS_DIR is required" >&2
  usage
  exit 2
fi
if [[ -z "$OPENCHAT_FRONTEND" ]]; then
  echo "restore-all: --openchat-frontend or OC_LIVE_OPENCHAT_FRONTEND is required" >&2
  usage
  exit 2
fi

# Validate with the same Windows Node runtime that consumes these paths. This accepts either a
# native absolute Windows path or an MSYS/Git-Bash absolute path without guessing a user directory.
node - "$CREDS" "$OPENCHAT_FRONTEND" <<'NODE'
const { existsSync, statSync } = require("node:fs");
const { createRequire } = require("node:module");
const { isAbsolute, join, relative } = require("node:path");
const root = process.argv[2];
const frontend = process.argv[3];
if (!isAbsolute(root)) {
  throw new Error("Configured credentials directory must be an absolute path");
}
if (!existsSync(root) || !statSync(root).isDirectory()) {
  throw new Error(`Configured credentials directory does not exist: ${root}`);
}
for (const user of ["manager", "mother", "child", "father"]) {
  const credential = join(root, `${user}.json`);
  if (!existsSync(credential) || !statSync(credential).isFile()) {
    throw new Error(`Missing durable OpenChat credential: ${credential}`);
  }
}
if (!isAbsolute(frontend)) {
  throw new Error("Configured OpenChat frontend must be an absolute path");
}
const packageJson = join(frontend, "package.json");
if (!existsSync(frontend) || !statSync(frontend).isDirectory()) {
  throw new Error(`Configured OpenChat frontend does not exist: ${frontend}`);
}
if (!existsSync(packageJson) || !statSync(packageJson).isFile()) {
  throw new Error(`Configured OpenChat frontend package is missing: ${packageJson}`);
}
const requireFromFrontend = createRequire(packageJson);
const resolvedWs = requireFromFrontend.resolve("ws");
const relativeWs = relative(frontend, resolvedWs);
if (relativeWs === ".." || relativeWs.startsWith("..\\") || relativeWs.startsWith("../") || isAbsolute(relativeWs)) {
  throw new Error("Refusing a ws dependency outside the configured OpenChat frontend");
}
NODE

read -r FATHER_OC FATHER_IOU MANAGER MOTHER CHILD < <(
  node -e 'const p=require("./scripts/live/cdp-ports.json"); console.log(p.fatherOpenChat,p.fatherIou,p.manager,p.mother,p.child)'
)

echo "=== OpenChat session restore ==="
echo "--- OpenChat manager (:$MANAGER)"
pnpm exec tsx scripts/live/oc-restore.ts --openchat-frontend "$OPENCHAT_FRONTEND" --port "$MANAGER" --cred "$CREDS/manager.json"
echo "--- OpenChat mother (:$MOTHER)"
pnpm exec tsx scripts/live/oc-restore.ts --openchat-frontend "$OPENCHAT_FRONTEND" --port "$MOTHER" --cred "$CREDS/mother.json"
echo "--- OpenChat child (:$CHILD)"
pnpm exec tsx scripts/live/oc-restore.ts --openchat-frontend "$OPENCHAT_FRONTEND" --port "$CHILD" --cred "$CREDS/child.json"
echo "--- OpenChat father (:$FATHER_OC)"
pnpm exec tsx scripts/live/oc-restore.ts --openchat-frontend "$OPENCHAT_FRONTEND" --port "$FATHER_OC" --cred "$CREDS/father.json" --focus open-chat --focusProc open-chat

echo; echo "=== IOU sign-in ==="
for port in "$MANAGER" "$MOTHER" "$CHILD" "$FATHER_IOU"; do
  echo "--- IOU :$port"
  pnpm exec tsx scripts/live/iou-signin.ts --port "$port"
done
echo; echo "restore-all done."
