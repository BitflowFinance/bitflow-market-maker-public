#!/usr/bin/env bash
# Usage: dry_run.sh <sbtc|stx>   Runs one dry-run tick, prints the lines that matter, then a plain-words summary.
source "$(dirname "$0")/common.sh"; pool_check "${1:-}"; cd "$REPO"
out=$(npm run tick -- --pool "$1" 2>&1 | grep -v -i SIGNER_KEY | sed -E 's/\x1b\[[0-9;]*m//g')
echo "$out" | grep -E 'starting|active_bin|wallet |ref price|DECISION|dry_run|frozen|error' | sed -E 's/^\[[0-9:.]+\] *//'
echo
echo "$out" | python3 -c "
import re,sys
o=sys.stdin.read(); pool=sys.argv[1]
def g(p):
    m=re.search(p,o); return m.group(1) if m else ''
d=g(r'd_bps=(\d+)'); dec=g(r'DECISION=(\w+)'); typ=g(r'DECISION=\w+ type=(\w+)'); w=g(r'wallet ([^\n]*owned_bins=\d+)')
print(f'Dry run summary, {pool} pool')
print(f'  Wallet line      {w or \"not printed\"}')
print(f'  Price agreement  d_bps={d or \"?\"}  (pool vs CoinGecko reference; under the pair file DIVERGENCE_WARN_BPS is healthy)')
print(f'  Decision         {dec or \"?\"}' + (f' type={typ}' if typ else ''))
if 'dry_run: plan logged' in o: print('  Ending           clean: plan logged, no transactions sent')
elif 'frozen' in o.lower():      print('  Ending           FROZEN: a safety halt is active; do not go live')
else:                             print('  Ending           did not reach the dry_run line; read the log above')
if typ=='derisk':      print('  Meaning          the wallet is one-sided above F_HARD; the first live action would be a swap, not a deploy. Fund the other side first.')
elif typ=='reposition': print('  Meaning          the bot would deploy or rebuild its curve on the active bin. This is the normal healthy plan.')
elif dec=='hold':       print('  Meaning          the bot would do nothing this tick (in range, or a guardrail is holding); see the reason in the log above.')
" "$1"
