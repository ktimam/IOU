#!/usr/bin/env bash
# IOU project dev shell. Use this to enter the dev environment.
# Run: source scripts/dev-shell.sh
# Or:   bash scripts/dev-shell.sh   (drops you in a subshell)

set -e

# Put our user-installed Node 20 ahead of any /mnt/c node on PATH
export PATH="/home/kiko/.local/node20/bin:/home/kiko/.cargo/bin:$PATH"

# Source cargo env (rustup install) and dfx env
if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi
if [ -f "$HOME/.local/share/dfx/env" ]; then
  . "$HOME/.local/share/dfx/env"
fi

# Project root is one level up from this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Print a summary
echo "IOU dev shell"
echo "  node:    $(node --version 2>&1)  ($(which node))"
echo "  pnpm:    $(pnpm --version 2>&1)  ($(which pnpm))"
echo "  dfx:     $(dfx --version 2>&1)  ($(which dfx))"
echo "  rustc:   $(rustc --version 2>&1)  ($(which rustc))"
echo "  cargo:   $(cargo --version 2>&1)  ($(which cargo))"
echo "  ic-wasm: $(ic-wasm --version 2>&1)  ($(which ic-wasm))"
echo "  cwd:     $PROJECT_ROOT"
echo ""
echo "Common commands:"
echo "  pnpm install                  install JS deps"
echo "  pnpm dev                      vite dev server (after deploy:local)"
echo "  pnpm build                    build PWA bundle"
echo "  pnpm test                     run unit tests"
echo "  pnpm e2e                      run Playwright e2e tests"
echo "  dfx start --background        start the local replica"
echo "  dfx stop                      stop the local replica"
echo "  dfx deploy iou_backend        build + deploy the Rust canister"
echo "  dfx deploy iou_assets         build + deploy the PWA"
echo "  dfx canister call iou_backend whoami  smoke test"
echo "  scripts/build-backend.sh      rebuild canister + inject candid"
echo ""
echo "Tip: dfx start --background is best run as a daemon so it"
echo "survives your shell exiting:"
echo "  setsid nohup dfx start --background </dev/null >/tmp/dfx.log 2>&1 &"
echo "  disown $!"
