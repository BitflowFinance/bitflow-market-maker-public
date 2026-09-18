#!/usr/bin/env bash
# Usage: enroll.sh <sbtc|stx> --terms-accepted
# Enrolls the pool's account in Stack by Trading and Stack by Market Making without a wallet screen:
# signs the campaign's enrollment message with the account's key (read inside node, never printed)
# and POSTs it to the campaign API. Run it ONLY after the user has read the terms at
# https://app.bitflow.finance/stack-sats and said yes; the flag records that. Works for accounts
# created by create_bot_account.sh and for keys pasted with set_signer_key.sh alike.
source "$(dirname "$0")/common.sh"; pool_check "${1:-}"
[ "${2:-}" = "--terms-accepted" ] || { echo "usage: $0 <sbtc|stx> --terms-accepted   (pass the flag only after the user has accepted the campaign terms)" >&2; exit 2; }
f="$(env_file "$1")"; [ -f "$f" ] || { echo "no env file for the $1 pool yet" >&2; exit 2; }
grep -q '^SIGNER_KEY=.\+' "$f" || { echo "no key in $(basename "$f"); run create_bot_account.sh or set_signer_key.sh first" >&2; exit 2; }
TOOLS="${MM_TOOLS:-$HOME/.stack-sats-mm-tools}"
if [ ! -d "$TOOLS/node_modules/@stacks/encryption" ]; then
  mkdir -p "$TOOLS" && (cd "$TOOLS" && printf '{"name":"stack-sats-mm-tools","private":true,"version":"1.0.0"}\n' > package.json && npm install --silent @stacks/wallet-sdk@6 @stacks/encryption@6 >/dev/null)
fi
cd "$TOOLS"
node -e "
const fs=require('fs'); const t=require('@stacks/transactions'); const enc=require('@stacks/encryption');
const env=Object.fromEntries(fs.readFileSync(process.argv[1],'utf8').split('\\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()]}));
const key=env.SIGNER_KEY, addr=env.SIGNER_ADDRESS;
let derived; try { derived=t.getAddressFromPrivateKey(key, t.TransactionVersion.Mainnet); } catch(e) { console.error('the key in the env file is not valid'); process.exit(1); }
if (derived!==addr) { console.error('the key in the env file does not belong to SIGNER_ADDRESS; fix that first (set_signer_key.sh)'); process.exit(1); }
const pub=t.publicKeyToString(t.compressPublicKey(t.pubKeyfromPrivKey(key).data));
const message='Stack Sats on Bitflow 2026. Address: '+addr+'. Terms: 2026-09-v1. Enroll.';
const hash=Buffer.from(enc.hashMessage(message)).toString('hex');
const sig=t.signMessageHashRsv({ messageHash: hash, privateKey: t.createStacksPrivateKey(key) }).data;
(async () => {
  const r=await fetch('https://app.bitflow.finance/api/campaign-proxy/enrollments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:addr,message,signature:sig,publicKey:pub,termsVersion:'2026-09-v1'})});
  const body=await r.json().catch(()=>({}));
  if (r.status===201 || (r.ok && body.status==='ok')) { console.log('ok: '+addr+' enrolled'+(body.enrollment&&body.enrollment.enrolledAt?' at '+body.enrollment.enrolledAt+' UTC':'')+(body.created===false?' (was already enrolled)':'')); }
  else { console.error('enrollment failed: HTTP '+r.status+' '+(body.error||'')); process.exit(1); }
})();
" "$f"
