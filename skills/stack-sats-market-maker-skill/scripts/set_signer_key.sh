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
out=$(npm run tick -- --pool "$1" 2>&1 | grep -i -E 'signer=|mismatch|check passed' | grep -v -i 'key=' | head -3 || true)
if echo "$out" | grep -qi mismatch; then
  echo "The key you pasted belongs to a different account than this pool's address. Re-run the key command with the right account number, then run this script again." >&2; exit 1
fi
echo "ok: key for the $1 pool matches its SIGNER_ADDRESS"
