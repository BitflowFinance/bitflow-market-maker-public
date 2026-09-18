#!/usr/bin/env bash
# Usage: print_key_command.sh <account number as the wallet lists it>
# Prints the one-line command that derives that account's private key. Run the printed
# command on an OFFLINE machine; paste its output into the env file with set_signer_key.sh.
n="${1:-}"; [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "usage: $0 <account number, 1 or higher>" >&2; exit 2; }
cat <<CMD
npm install --no-save @stacks/wallet-sdk
SEED="<your seed phrase>" N=$n node -e "const s=require('@stacks/wallet-sdk'); s.generateWallet({secretKey: process.env.SEED, password: ''}).then(w => { const i=Number(process.env.N)-1; while (w.accounts.length <= i) w = s.generateNewAccount(w); console.log(w.accounts[i].stxPrivateKey) })"
CMD
echo "# Account $n is index $((n-1)) on the derivation path; the command handles that." >&2
