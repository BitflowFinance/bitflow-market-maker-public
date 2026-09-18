#!/usr/bin/env bash
# Usage: create_bot_account.sh <sbtc|stx>
# Path A: creates a brand-new Stacks account for the bot on this machine. Writes SIGNER_ADDRESS and
# SIGNER_KEY straight into the pool's env file and the 24-word recovery phrase into
# $MM_REPO/.env.<pool>.recovery (both mode 600; the repo's .gitignore covers .env*). Prints ONLY the
# address and the recovery file path. The key and the phrase never reach stdout, so they never reach
# the agent's context. Refuses to run if the env file already has a key, so it cannot overwrite one.
source "$(dirname "$0")/common.sh"; pool_check "${1:-}"
f="$(env_file "$1")"; rec="$REPO/.env.$1.recovery"
[ -f "$f" ] || { cp "$REPO/.env.$1.example" "$f"; chmod 600 "$f"; }
if grep -q '^SIGNER_KEY=.\+' "$f"; then
  echo "$(basename "$f") already holds a key. Not touching it. To start over, move that file and $(basename "$rec") aside first." >&2; exit 1
fi
[ -e "$rec" ] && { echo "$(basename "$rec") already exists. Not overwriting a recovery phrase. Move it aside first." >&2; exit 1; }
# One-time tools folder for the wallet SDK, outside the bot repo so nothing in it changes.
TOOLS="${MM_TOOLS:-$HOME/.stack-sats-mm-tools}"
if [ ! -d "$TOOLS/node_modules/@stacks/wallet-sdk" ]; then
  mkdir -p "$TOOLS" && (cd "$TOOLS" && printf '{"name":"stack-sats-mm-tools","private":true,"version":"1.0.0"}\n' > package.json && npm install --silent @stacks/wallet-sdk@6 >/dev/null)
fi
cd "$TOOLS"
addr=$(node -e "
const fs=require('fs'); const w=require('@stacks/wallet-sdk');
(async () => {
  const phrase = w.generateSecretKey(256);
  const wallet = await w.generateWallet({ secretKey: phrase, password: '' });
  const acct = wallet.accounts[0];
  const key = acct.stxPrivateKey;
  const addr = w.getStxAddress({ account: acct, transactionVersion: require('@stacks/transactions').TransactionVersion.Mainnet });
  const f = process.argv[1], rec = process.argv[2];
  let env = fs.readFileSync(f, 'utf8');
  const set = (k, v) => { const re = new RegExp('^' + k + '=.*$', 'm'); env = re.test(env) ? env.replace(re, k + '=' + v) : env.replace(/\n?$/, '\n') + k + '=' + v + '\n'; };
  set('SIGNER_ADDRESS', addr); set('SIGNER_KEY', key);
  fs.writeFileSync(f, env, { mode: 0o600 });
  fs.writeFileSync(rec, 'Stack Sats bot account (' + process.argv[3] + ' pool)\nAddress: ' + addr + '\nRecovery phrase (24 words). Anyone with these words controls the funds. Back this up somewhere safe, then consider deleting this file.\n\n' + phrase + '\n', { mode: 0o600 });
  process.stdout.write(addr);
})().catch(e => { console.error('failed: ' + e.message); process.exit(1); });
" "$f" "$rec" "$1")
chmod 600 "$f" "$rec"
# Kill-switch path, same as set_signer_address.sh.
grep -q '^KILL_SWITCH_FILE=' "$f" && sed -i '' "s#^KILL_SWITCH_FILE=.*#KILL_SWITCH_FILE=$REPO/KILL_$1#" "$f" || echo "KILL_SWITCH_FILE=$REPO/KILL_$1" >> "$f"
cat <<OUT
ok: new bot account for the $1 pool
  Address        $addr
  Fund it with   $(pool_tokens "$1")
  Recovery file  $rec   (24 words; back it up, then you may delete the file)
  Key            written to $(basename "$f") only; never shown
OUT
