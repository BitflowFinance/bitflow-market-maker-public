# Bitflow curve market maker

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

Safety halts: `broken_market` (peg break or divergence past `DIVERGENCE_HALT_BPS` → withdraw, hold inventory) and `operational` (stale reference feed → withdraw, stop quoting).

## Setup

```bash
npm install
cp .env.sbtc.example .env.sbtc   # or .env.stx.example -> .env.stx
# Fill SIGNER_ADDRESS. For live, also SIGNER_KEY (must match) and STACKS_NODE_URL.
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

## First live test

1. Fund the wallet with a small amount of the pool's tokens plus STX for gas.
2. Set `EXECUTION_MODE=live`, `SIGNER_ADDRESS`, `SIGNER_KEY`.
3. Set a small `MAX_POSITION_USTX` to test with first.
4. Set `KILL_SWITCH_FILE` so you can halt without a restart.
5. Run one tick: `EXECUTION_MODE=live node dist/index.js --once --pool sbtc`.
6. Start the loop and watch logs.

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
