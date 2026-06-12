#!/usr/bin/env bash
# IOU project dev shell. Use this to enter the dev environment.
# Run: source scripts/dev-shell.sh
# Or:   bash scripts/dev-shell.sh   (drops you in a subshell)

set -e

# Put our user-installed Node 20 ahead of any /mnt/c node on PATH
export PATH="/home/kiko/.local/node20/bin:$PATH"

# Source dfx env if it exists
if [ -f "$HOME/.local/share/dfx/env" ]; then
  . "$HOME/.local/share/dfx/env"
fi

# Project root is two levels up from this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Print a summary
echo "IOU dev shell"
echo "  node:  $(node --version 2>&1)  ($(which node))"
echo "  npm:   $(npm --version 2>&1)"
echo "  dfx:   $(dfx --version 2>&1)  ($(which dfx))"
echo "  cwd:   $PROJECT_ROOT"
echo ""
echo "Common commands:"
echo "  pnpm install                install JS deps"
echo "  pnpm deploy:local           dfx deploy to local replica"
echo "  pnpm dev                    vite dev server (after deploy:local)"
echo "  pnpm build                  build PWA bundle for mainnet"
echo "  pnpm test                   run unit tests"
echo "  pnpm e2e                    run Playwright e2e tests"
echo "  dfx start --background      start the local replica"
echo "  dfx stop                    stop the local replica"
echo "  dfx canister status iou_backend  check cycle balance"
