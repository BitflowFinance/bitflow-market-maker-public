#!/usr/bin/env bash
# Usage: set_signer_key.sh <sbtc|stx>
# Opens that pool's env file in an editor at a preformatted SIGNER_KEY= line, waits for the
# user to paste the key and close the editor, then verifies the key matches SIGNER_ADDRESS
# without printing it. Nothing from the file is ever echoed.
source "$(dirname "$0")/common.sh"; pool_check "${1:-}"
f="$(env_file "$1")"; [ -f "$f" ] || { echo "run set_signer_address.sh $1 first" >&2; exit 2; }
note='# Paste this account'"'"'s private key after the = sign, then save and close this window.'
if ! grep -q '^SIGNER_KEY=' "$f"; then
  printf '\n%s\nSIGNER_KEY=\n' "$note" >> "$f"
elif ! grep -qF "$note" "$f"; then
  python3 - "$f" "$note" <<'PY'
import sys; f,note=sys.argv[1:]; L=open(f).read().split('\n')
i=next(i for i,l in enumerate(L) if l.startswith('SIGNER_KEY=')); L.insert(i,note); open(f,'w').write('\n'.join(L))
PY
fi
line=$(grep -n '^SIGNER_KEY=' "$f" | head -1 | cut -d: -f1)
echo "Opening $(basename "$f") at line $line. Paste the key after SIGNER_KEY= and save, then close the window."
if [ -n "${EDITOR:-}" ]; then "$EDITOR" "+$line" "$f"
elif command -v nano >/dev/null; then nano "+$line" "$f"
else open -W -t "$f"; fi
chmod 600 "$f"
if ! grep -q '^SIGNER_KEY=.\+' "$f"; then echo "no key found after SIGNER_KEY=; run this script again" >&2; exit 1; fi
cd "$REPO"
# Verify with the bot's own derivation (src/wallet.ts assertSignerKeyMatchesAddress). The bot only runs that
# check in live mode, so a dry-run tick proves nothing here; this does the same derivation in dry_run.
# The env file is read inside node only; nothing but match/mismatch is printed.
res=$(node -e "
const fs=require('fs'); const {getAddressFromPrivateKey, TransactionVersion}=require('@stacks/transactions');
const env=Object.fromEntries(fs.readFileSync(process.argv[1],'utf8').split('\\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()]}));
const v=(env.STACKS_NETWORK_VERSION||'mainnet').toLowerCase()==='mainnet'?TransactionVersion.Mainnet:TransactionVersion.Testnet;
let d; try { d=getAddressFromPrivateKey(env.SIGNER_KEY, v); } catch(e) { console.log('invalid'); process.exit(0); }
console.log(d===env.SIGNER_ADDRESS?'match':'mismatch');
" "$f")
case "$res" in
  match) ;;
  invalid) echo "The pasted value is not a valid private key (expect 64 or 66 hex characters, no 0x, no quotes). Run this script again." >&2; exit 1;;
  *) echo "The key you pasted belongs to a different account than this pool's address. Re-run the key command with the right account number, then run this script again." >&2; exit 1;;
esac
echo "ok: key for the $1 pool matches its SIGNER_ADDRESS"
