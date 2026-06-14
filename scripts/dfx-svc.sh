#!/usr/bin/env bash
# scripts/dfx-svc.sh — start the local dfx replica in a way that
# survives the parent shell's exit. Used to bring up the replica
# after a WSL restart or a `dfx stop`.
#
# Usage:  bash scripts/dfx-svc.sh
# Effect: starts dfx detached (setsid + nohup), waits for the
#         port to bind, and prints a one-liner status.
# Stop:   wsl -d Ubuntu -- bash -c "pkill -9 -f pocket-ic"

. "${HOME}/.local/share/dfx/env" 2>/dev/null || true
. /home/kiko/.local/share/dfx/env 2>/dev/null || true
export PATH="/home/kiko/.local/share/dfx/bin:$PATH"
cd "$(dirname "$0")/.."

# setsid puts the process in its own session (immune to
# SIGHUP from the parent shell exiting). nohup double-protects
# against hangup. The `&` backgrounds it. Stdin is closed
# (`< /dev/null`) and both stdout/stderr go to a log.
setsid nohup dfx start --background --clean > /tmp/dfx.log 2>&1 < /dev/null &
echo "dfx start launched (pid $!)"
sleep 12
if ss -tln 2>/dev/null | grep -q ':4943'; then
  echo "✓ replica listening on 127.0.0.1:4943 (inside WSL)"
  echo "  Windows URL (with WSL2 mirrored mode): http://127.0.0.1:4943"
else
  echo "✗ replica did not bind 4943 — check /tmp/dfx.log"
fi
