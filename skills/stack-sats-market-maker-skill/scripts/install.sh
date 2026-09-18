#!/usr/bin/env bash
# Clone the public starter kit (if not already present), install it, type-check it and run its tests.
# Safe to re-run: an existing clone is verified, not re-cloned. Never touches env files.
set -euo pipefail
. "$(dirname "$0")/common.sh"
if [ ! -d "$REPO/.git" ]; then
  git clone https://github.com/BitflowFinance/bitflow-market-maker-public.git "$REPO"
fi
cd "$REPO"
echo "repo: $REPO at $(git log --oneline -1)"
npm install
npm run typecheck
npm test
echo "ok: installed and tested at $REPO"
