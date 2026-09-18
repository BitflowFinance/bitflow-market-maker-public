#!/usr/bin/env bash
# Usage: list_txs.sh <SP_ADDRESS> [n]   Prints the last n transactions (default 5), newest first.
source "$(dirname "$0")/common.sh"; addr_check "${1:-}"
curl -sf "$HIRO/address/$1/transactions?limit=${2:-5}" | python3 -c "
import json,sys,datetime
addr=sys.argv[1]; r=json.load(sys.stdin)['results']
print(f'Last {len(r)} transactions for {addr}  (newest first)')
print(f'  {\"when (UTC)\":<16} {\"status\":<9} {\"action\":<22} tx id')
for t in r:
    iso=t.get('burn_block_time_iso') or t.get('receipt_time_iso') or ''
    when=datetime.datetime.fromisoformat(iso.replace('Z','+00:00')).strftime('%m/%d/%y %H:%M') if iso else 'pending'
    act=t.get('contract_call',{}).get('function_name') or t['tx_type']
    print(f'  {when:<16} {t[\"tx_status\"]:<9} {act:<22} {t[\"tx_id\"]}')
" "$1"
