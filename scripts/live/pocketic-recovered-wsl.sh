#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  write-metadata)
    [[ $# -eq 3 ]]
    payload="$2"
    destination="$3"
    umask 077
    temporary="${destination}.tmp.$$"
    trap 'rm -f -- "$temporary"' EXIT
    printf '%s' "$payload" | base64 --decode >"$temporary"
    chmod 600 "$temporary"
    mv -f -- "$temporary" "$destination"
    trap - EXIT
    ;;
  launch)
    [[ $# -eq 6 ]]
    binary="$2"
    port_file="$3"
    log_file="$4"
    ttl_seconds="$5"
    log_levels="$6"
    [[ "$ttl_seconds" =~ ^[1-9][0-9]*$ ]]
    [[ "$log_levels" =~ ^[A-Za-z0-9_,=-]+$ ]]
    umask 077
    exec setsid -f "$binary" --port-file "$port_file" --ttl "$ttl_seconds" --log-levels "$log_levels" </dev/null >"$log_file" 2>&1
    ;;
  owns-port)
    [[ $# -eq 3 ]]
    pid=$2
    port=$3
    [[ "$pid" =~ ^[1-9][0-9]*$ && "$port" =~ ^[1-9][0-9]*$ ]]
    [[ -d "/proc/$pid/fd" ]]
    printf -v port_hex '%04X' "$port"
    mapfile -t inodes < <(awk -v endpoint="0100007F:${port_hex}" '$2 == endpoint && $4 == "0A" { print $10 }' /proc/net/tcp /proc/net/tcp6)
    [[ ${#inodes[@]} -eq 1 ]]
    expected=socket:[${inodes[0]}]
    for descriptor in /proc/$pid/fd/*; do
      [[ "$(readlink "$descriptor" 2>/dev/null || true)" == "$expected" ]] && exit 0
    done
    exit 1
    ;;
  signal-term)
    [[ $# -eq 3 ]]
    pid=$2
    expected_start_ticks=$3
    exec python3 - $pid $expected_start_ticks <<'PY'
import os
import signal
import sys
pid = int(sys.argv[1])
expected = sys.argv[2]
pidfd = os.pidfd_open(pid, 0)
try:
    with open(f'/proc/{pid}/stat', encoding='ascii') as handle:
        stat = handle.read().strip()
    fields = stat[stat.rfind(')') + 2:].split()
    if len(fields) < 20 or fields[19] != expected:
        raise RuntimeError('process start tick changed; refusing to signal')
    signal.pidfd_send_signal(pidfd, signal.SIGTERM, None, 0)
finally:
    os.close(pidfd)
PY
    ;;
  verify-backup)
    [[ $# -eq 3 ]]
    source_dir=$2
    backup_dir=$3
    [[ -d "$source_dir" && -d "$backup_dir" ]]
    # A full byte comparison is intentional. This is a rare crash-recovery operation and the
    # timestamped copy is the rollback boundary before PocketIC is allowed to touch the source.
    exec diff -qr --no-dereference -- "$source_dir" "$backup_dir"
    ;;
  state-inventory)
    [[ $# -eq 2 ]]
    state_dir=$2
    [[ -d "$state_dir" ]]
    files=$(find "$state_dir" -type f -printf '.' | wc -c)
    bytes=$(find "$state_dir" -type f -printf '%s\n' | awk '{ total += $1 } END { printf "%.0f", total }')
    printf '{"files":%s,"bytes":%s}\n' "$files" "$bytes"
    ;;
  *)
    exit 64
    ;;
esac
