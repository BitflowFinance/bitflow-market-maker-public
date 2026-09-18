#!/usr/bin/env bash
# Usage: campaign_reading.sh <SP_ADDRESS>   Prints the campaign standing per track, in the page's terms.
source "$(dirname "$0")/common.sh"; addr_check "${1:-}"
curl -sf "$CAMPAIGN/$1" | python3 -c "
import json,sys,datetime
addr=sys.argv[1]; s=json.load(sys.stdin)['summary']
asof=datetime.datetime.fromisoformat(s['asOf'].replace('Z','+00:00'))
yn=lambda b: 'yes' if b else 'no'
g=s['giveaway']; t=s['trader']
print(f'Stack Sats on Bitflow standing for {addr}  (as of {asof:%m/%d/%y %H:%M} UTC, phase {s.get(\"windowId\",\"\")})')
print(f'  The Daily Stack          entries stacked: {g.get(\"entries\",0)}   (one qualifying swap of \${g.get(\"minSwapUsd\",25)}+ per UTC day = one entry)')
print(f'  Stack by Trading         credited volume: \${t[\"qualifiedVolumeUsd\"]:,.0f}   qualified: {yn(t[\"qualified\"])}   (needs \${t.get(\"minVolumeUsd\",10000):,.0f} in the phase)')
print( '  Stack by Market Making')
for key,name in (('sbtc-usdcx','sBTC/USDCx'),('stx-usdcx','STX/USDCx')):
    m=s['maker'][key]
    up=m.get('uptimePct',0); up=up*100 if up<=1 else up
    print(f'    {name:<11} Average Useful TVL: \${m.get(\"avgUsefulTvlUsd\",0):,.0f}   deployed in {m.get(\"deployedCount\",0)} of {m.get(\"snapshotCount\",0)} snapshots   Uptime: {up:.0f}%   qualified: {yn(m[\"qualified\"])}   (gate \${m.get(\"minUsefulTvlUsd\",5000):,.0f})')
" "$1"
