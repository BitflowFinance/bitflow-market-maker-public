#!/usr/bin/env bash
# Shared helpers. Sourced by the other scripts. Never prints env file contents.
set -euo pipefail
REPO="${MM_REPO:-$HOME/bitflow-market-maker-public}"
HIRO="https://api.hiro.so/extended/v1"
CAMPAIGN="https://app.bitflow.finance/api/campaign-proxy/campaign"
pool_check() { case "${1:-}" in sbtc|stx) ;; *) echo "usage: $0 <sbtc|stx>" >&2; exit 2;; esac; }
env_file() { echo "$REPO/.env.$1"; }
addr_check() { [[ "${1:-}" =~ ^S[PM][0-9A-HJ-NP-Z]{28,41}$ ]] || { echo "That does not look like a Stacks address (starts with SP, no O, I, L or U)." >&2; exit 2; }; }
pool_tokens() { case "$1" in sbtc) echo "STX (gas), sBTC, USDCx";; stx) echo "STX (gas and inventory), USDCx";; esac; }
