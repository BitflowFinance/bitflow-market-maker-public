# Bitflow curve market maker

> **Mainnet, real funds.** This bot signs transactions with your private key and deploys your tokens into live pools. It is provided as is, without warranty, and has not been independently audited. Nothing in this repository is financial advice, and no outcome is guaranteed. Every value in the env files is a default, not a recommendation. You are responsible for your keys, your positions, and any losses. Start small and read [SECURITY.md](./SECURITY.md) and [docs/RECOVERY.md](./docs/RECOVERY.md) before going live.

A TypeScript market maker for **Bitflow DLMM** pools on Stacks. This public edition is built for the two competition pairs:

| Pair | Profile | Pool | Strategy |
| --- | --- | --- | --- |
| sBTC / USDCx | `--pool sbtc` | `dlmm_1` | `sbtc-usdcx-curve` |
| STX / USDCx | `--pool stx` | `dlmm_14` | `stx-usdcx-curve` |

One process per pool (own wallet, own nonce space). Each process loads `.env.<name>` when you pass `--pool <name>`.

## The curve (peaked at the active bin)

The bot **follows** the live pool price. It does not defend an external peg.

Every deploy is a **geometric curve centered on the active bin**:

```
weight(offset) = CURVE_DECAY ^ |offset|
```

Offset `0` is the active bin and always the heaviest leg. Depth tapers outward for `CURVE_HALF_WIDTH_BINS` on each side. `CURVE_DECAY=0.6` (the default in both pair files) puts most liquidity at the active bin and a decaying book around it.

It holds while the active bin stays in range (earning fees, passively rebalancing as it is filled) and rebuilds the curve when the active bin drifts past `CURVE_REPOSITION_DRIFT_BINS`.

CoinGecko is used **only** for safety (divergence + feed staleness) and inventory awareness — never as a price we quote on.

Continuous knobs on every shaped add:

- **M2 vol scaling** — widen `halfWidth` and shrink `sizeFraction` as realized vol rises above `SIGMA_REF`.
- **M2b reposition cooldown** (opt-in) — widen the drift tolerance during vol spikes. Enable by setting `CURVE_MAX_REPOSITION_DRIFT_BINS` above `CURVE_REPOSITION_DRIFT_BINS`.
- **M4 pull-bids / M6 bid-lean** — scale the cash (quote) side by `bidFraction` from the inventory fraction `f = V/(V+C)`.
- **M5 hard-cap de-risk** — when `f` breaches `F_HARD` and markets are healthy, sell base→quote toward `F_SOFT`, throttled by `DERISK_MAX_FRACTION`. Requires `ENABLE_SWAP=true`.

Safety halts: `broken_market` (peg break or divergence past `DIVERGENCE_HALT_BPS`) and `operational` (stale reference feed). Both freeze the loop and clear on their own when the reading recovers. Existing bins are withdrawn on a halt only when `BREAKER_WITHDRAW_ALL=true`; otherwise they stay deployed. See [docs/RECOVERY.md](./docs/RECOVERY.md).

## Prerequisites

What you need before `npm install`. Facts only; how much to fund is your decision.

1. **Node.js 20 or newer.**
2. **A dedicated Stacks account.** Create a fresh account in a Stacks wallet (Leather, Xverse or similar) and use it only for this bot. Never point the bot at a wallet that holds anything else. Its `SP...` address is `SIGNER_ADDRESS`.
3. **Its private key as hex** for `SIGNER_KEY`. Some wallet apps can show or copy an account's private key directly. If yours only shows the seed phrase, derive the key on a machine that is offline and never paste the seed phrase anywhere else:

   ```bash
   npm install --no-save @stacks/wallet-sdk
   SEED="<your-seed-phrase-here>" node -e "require('@stacks/wallet-sdk').generateWallet({secretKey: process.env.SEED, password: ''}).then(w => console.log(w.accounts[0].stxPrivateKey))"
   ```

   Be sure to clear the shell history after running the commands above. In live mode the bot refuses to start if the key does not derive to `SIGNER_ADDRESS`, so a mistake here fails safe.
4. **STX for gas** in that account. Each transaction costs between `MIN_TX_FEE_USTX` and `MAX_TX_FEE_USTX` (0.05 to 0.15 STX by default in the pair files), and the bot keeps `STX_GAS_RESERVE_USTX` (5 STX by default) undeployed at all times. For the STX/USDCx pool the same STX balance is also the inventory.
5. **Both pool tokens** in that account. The bot does not bootstrap a one-sided wallet well: its default target is `F_STAR` (0.38) of deployed value in the base token, and if you start above `F_HARD` (0.67) in base with `ENABLE_SWAP=true` the first live tick may sell base for quote.
   - **sBTC** (sBTC/USDCx pool): deposit BTC through the official sBTC bridge, or swap into it on Bitflow.
   - **USDCx** (both pools): bridged USDC on Stacks. Acquire it through its issuer's official route or swap into it on Bitflow.
   - **STX** (STX/USDCx pool): any exchange that supports Stacks withdrawals.

   Whichever route you use, verify the contract address of the token you receive matches the contract address of the token in the pair file (`BASE_TOKEN_CONTRACT` / `QUOTE_TOKEN_CONTRACT`).

No API keys are needed. `BFF_API_KEY` can stay blank. `STACKS_NODE_URL` can stay blank too; the bot then uses the public Hiro API, which is rate limited. Set your own node or a paid endpoint if you see `429` errors in the log.

## Setup

```bash
npm install
cp .env.sbtc.example .env.sbtc   # or .env.stx.example -> .env.stx
# Fill SIGNER_ADDRESS. For live, also SIGNER_KEY (must match).
# STACKS_NODE_URL and BFF_API_KEY are optional (see Prerequisites).
# Token asset names + decimals are resolved from the BFF at startup.
```

Almost everything else has a mainnet-correct default in `src/config.ts`. The pair files only set what differs (pool, tokens, curve shape, CoinGecko id).

## Running

```bash
npm run build
npm run tick -- --pool sbtc    # single dry-run tick
npm run dev -- --pool sbtc     # loop with auto-reload
npm test

# Long-running compiled loop (preferred over `npm start` so Ctrl+Z / parent-exit
# cleanly release the metrics port):
node dist/index.js --pool sbtc
node dist/index.js --pool stx
```

`EXECUTION_MODE=dry_run` (default) logs the plan and does not sign. Set `live` in the pair env file to broadcast.

**Stopping:** `Ctrl+C` shuts down cleanly. `Ctrl+Z` is converted to a clean shutdown (a suspended bot would freeze mid-tick and keep the metrics port bound). A parent-death watchdog also exits if the process is orphaned.

### Manual CLI (live only)

```bash
EXECUTION_MODE=live node dist/index.js --pool sbtc --add-liquidity --x 1000000 --y 1000000 [--bin N]
EXECUTION_MODE=live node dist/index.js --pool sbtc --withdraw-liquidity [--bin N] [--pct 100]
EXECUTION_MODE=live node dist/index.js --pool sbtc --swap --sell base --amount 1000000 [--max-steps N] [--min N]
```

Amounts are micro-units of the token (sBTC = 1e8, STX / USDCx = 1e6). `--x`/`--y` are the pool's token X/Y. Manual actions are **not** gated by the kill switch.

## Safety

The bot holds (takes no action) when any of these fire:

- **Kill switch** — `KILL_SWITCH=true`, or a `KILL_SWITCH_FILE` that exists (`touch` to halt, delete to resume).
- **Pool inactive** — the BFF reports the pool paused/disabled.
- **Feed unavailable** — the CoinGecko reference read fails.
- **Strategy halt** — broken market or a stale feed past `REFERENCE_FEED_HALT_MS`.
- **API circuit breaker** — `MAX_CONSECUTIVE_API_ERRORS` consecutive data failures (optionally withdraws via `BREAKER_WITHDRAW_ALL`).
- **Low gas** — wallet STX can't cover the plan's tx fees. `STX_GAS_RESERVE_USTX` is never deployed.
- **Nonce gap / pending tx** — a prior tx is stuck.

Other protections: signer key/address match at startup, `PostConditionMode.Deny` on every tx, replace-by-fee on stuck txs, and `MAX_POSITION_USTX` (scales adds down).

For STX/USDCx, STX is both inventory and gas. The gas reserve stays undeployed so you can always withdraw.

## Metrics

A read-only HTTP API binds to `127.0.0.1` by default (do not expose it). Each pair file uses its own port (sBTC `8081`, STX `8082`).

```bash
curl localhost:8081/health
curl localhost:8081/status
curl localhost:8081/metrics
curl localhost:8081/history?n=50
```

Ticks are also appended to `data/metrics.<profile>.jsonl`. Offline helpers:

```bash
npm run watch   -- --pool sbtc
npm run analyze -- --pool sbtc
npm run curve   -- --pool sbtc
npm run backtest
npm run fees
```

## Pre-flight (before the first live tick)

Tick every box. Any `no` means do not go live yet.

```
[ ] npm test and npm run build pass
[ ] Dry-run tick clean: npm run tick -- --pool sbtc ends with decision="hold" or
    "rebalance" plus "dry_run: plan logged", not "frozen" or an error
[ ] The tick's `wallet` line shows both tokens and the `active_bin` line shows a price
[ ] The tick's `ref price` line shows d_bps below DIVERGENCE_WARN_BPS
[ ] Wallet STX covers STX_GAS_RESERVE_USTX plus a few transactions
[ ] MAX_POSITION_USTX set to a small amount for the first run (0 means no cap)
[ ] KILL_SWITCH_FILE set, and you know the path, so you can halt without a restart
[ ] METRICS_HTTP_HOST is 127.0.0.1 (the default) and the port is not exposed
[ ] EXECUTION_MODE=live and SIGNER_KEY set only in the pair env file, nowhere else
[ ] One live tick before the loop:
      EXECUTION_MODE=live node dist/index.js --once --pool sbtc
    Startup must log "signer key/address check passed"; then confirm the
    transactions in an explorer before starting the loop
```

Then start the loop with `node dist/index.js --pool sbtc` and watch the log. If anything looks wrong, `touch` the kill-switch file first, then read [docs/RECOVERY.md](./docs/RECOVERY.md).

## Key config

| Var | Purpose |
| --- | --- |
| `EXECUTION_MODE` | `dry_run` or `live` |
| `POOL_ID` / `POOL_STRATEGY` | which pool + `curve` / `sbtc-usdcx-curve` / `stx-usdcx-curve` |
| `BASE_TOKEN_CONTRACT` / `QUOTE_TOKEN_CONTRACT` | pair orientation |
| `CURVE_HALF_WIDTH_BINS` / `CURVE_DECAY` / `CURVE_SIZE_FRACTION` | shape (bins/side, peak, deployed fraction) |
| `CURVE_REPOSITION_DRIFT_BINS` | when to rebuild around the new active bin |
| `SIGMA_REF` / `CURVE_MAX_HALF_WIDTH_BINS` / `CURVE_MIN_SIZE_FRACTION` | M2 vol scaling |
| `F_STAR` / `F_SOFT` / `F_HARD` / `CURVE_BID_LEAN_MAX` / `DERISK_MAX_FRACTION` | inventory caps + de-risk |
| `DIVERGENCE_WARN_BPS` / `DIVERGENCE_HALT_BPS` / `REFERENCE_FEED_HALT_MS` | safety |
| `MAX_POSITION_USTX` | cap on deployed value; 0 = off |
| `STX_GAS_RESERVE_USTX` | STX kept aside for gas |
| `KILL_SWITCH` / `KILL_SWITCH_FILE` | master halt |
| `COINGECKO_REFERENCE_ID` | `bitcoin` (sBTC) or `blockstack` (STX) |

See `.env.example` and the pair files for the full list.

## Related

- [docs/RECOVERY.md](./docs/RECOVERY.md): halt and resume, self-halts, stuck transactions, full exit, restart.
- [docs/RUNBOOK.md](./docs/RUNBOOK.md): a runbook to hand to an AI agent that will set the bot up for you, one pool or both, with the owner-only steps (account, funding, key, enrollment, go) called out.
- [SECURITY.md](./SECURITY.md): key handling and the metrics port.
- [Guides for AI Bitcoin Agents](https://github.com/k9dreamer-graphite-elan/guides-for-ai-bitcoin-agents) (community edition, unofficial): handbook, runbooks and per-pool notes for [dlmm_1](https://github.com/k9dreamer-graphite-elan/guides-for-ai-bitcoin-agents/blob/main/public/hodlmm/knowledge/pools/dlmm_1.md) and [dlmm_14](https://github.com/k9dreamer-graphite-elan/guides-for-ai-bitcoin-agents/blob/main/public/hodlmm/knowledge/pools/dlmm_14.md). Optional reading; this bot does not depend on it or on any external skills.
