#!/usr/bin/env bash
# Usage: set_signer_address.sh <sbtc|stx> <SP_ADDRESS>
# Writes SIGNER_ADDRESS into that pool's env file, creating it from the example if needed.
source "$(dirname "$0")/common.sh"; pool_check "${1:-}"; addr_check "${2:-}"
f="$(env_file "$1")"
[ -f "$f" ] || { cp "$REPO/.env.$1.example" "$f"; chmod 600 "$f"; }
grep -q '^SIGNER_ADDRESS=' "$f" && sed -i '' "s/^SIGNER_ADDRESS=.*/SIGNER_ADDRESS=$2/" "$f" || echo "SIGNER_ADDRESS=$2" >> "$f"
grep -q '^KILL_SWITCH_FILE=' "$f" && sed -i '' "s#^KILL_SWITCH_FILE=.*#KILL_SWITCH_FILE=$REPO/KILL_$1#" "$f" || echo "KILL_SWITCH_FILE=$REPO/KILL_$1" >> "$f"
chmod 600 "$f"
echo "ok: $1 pool signs from $2 (file $(basename "$f"), mode dry_run)"
