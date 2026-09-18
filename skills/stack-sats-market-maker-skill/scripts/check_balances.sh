#!/usr/bin/env bash
# Usage: check_balances.sh <SP_ADDRESS>   Prints STX, sBTC and USDCx balances in human units, with notes.
source "$(dirname "$0")/common.sh"; addr_check "${1:-}"
curl -sf "$HIRO/address/$1/balances" | python3 -c '
import json,sys
addr=sys.argv[1]; d=json.load(sys.stdin); ft=d["fungible_tokens"]
def bal(suffix,dec):
    for k,v in ft.items():
        if k.endswith(suffix): return int(v["balance"])/10**dec
    return 0.0
stx=int(d["stx"]["balance"])/1e6; sbtc=bal("::sbtc-token",8); usdcx=bal("::usdcx-token",6)
print(f"Balances for {addr}")
print(f"  STX    {stx:,.6f}")
print(f"  sBTC   {sbtc:,.8f}")
print(f"  USDCx  {usdcx:,.6f}")
notes=[]
if stx < 5: notes.append("STX is below the 5 STX gas reserve the bot keeps back; it cannot deploy or pay fees yet")
if usdcx == 0: notes.append("no USDCx: both pools need it as the quote side")
if notes:
    print("  Notes")
    for n in notes: print(f"    - {n}")
' "$1"
