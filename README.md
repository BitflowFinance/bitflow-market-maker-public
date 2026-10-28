# Bitflow curve market maker

> **Mainnet, real funds.** This bot signs transactions with your private key and deploys your tokens into live pools. It is provided as is, without warranty, and has not been independently audited. Nothing in this repository is financial advice, and no outcome is guaranteed. Every value in the env files is a default, not a recommendation. You are responsible for your keys, your positions, and any losses. Start small and read [SECURITY.md](./SECURITY.md) and [docs/RECOVERY.md](./docs/RECOVERY.md) before going live.

A TypeScript market maker for **Bitflow DLMM** pools on Stacks. This public edition is built for the two competition pairs:

| Pair | Profile | Pool | Strategy |
| --- | --- | --- | --- |
| sBTC / USDCx | `--pool sbtc` | `…dlmm-pool-sbtc-usdcx-v-1-bps-10` | `sbtc-usdcx-curve` |
| STX / USDCx | `--pool stx` | `…dlmm-pool-stx-usdcx-v-1-bps-10` | `stx-usdcx-curve` |

`POOL_ID` is the pool's full contract id (deployer `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD`); the example env files have it. Older files with `dlmm_1` / `dlmm_3` / `dlmm_14` still work: the bot looks the contract id up at startup and logs a warning.

**Choosing a pool.** Each pair has several pools covering different price ranges. The page ranks them: a pool must have the curve's bin size, the market price inside its range with room to spare, and a pool price within the halt limit of the market; the deepest of those near the price is recommended. "Change pool" on the Settings tab moves a bot, and "Needs you" warns when the price nears the edge of a bot's pool.

The STX profile used to point at `dlmm_14` (`…stx-usdcx-v-2-bps-10`), a pool with almost no liquidity. New STX bots now use the main pool (`…stx-usdcx-v-1-bps-10`, formerly `dlmm_3`). An existing `.env.stx` keeps the pool it names, because it may hold liquidity there. To move it: pause, withdraw everything, set `POOL_ID` to the new contract id, then resume.

One process per pool (own wallet, own nonce space). Each process loads `.env.<name>` when you pass `--pool <name>`.

## Local page

A local page watches and controls the bots on this computer. It does not send the private key to the browser.

```bash
npm install
npm run ui
```

Then open http://127.0.0.1:5191. Or ask your coding agent to "set up this repo and start the app"; [AGENTS.md](./AGENTS.md) has the steps.

Preview bots are on the first screen. They have no wallet and the balances are fake. Create a real bot in the page. It always starts in dry run.

### Already running the scripts?

Your bots carry over with no code or env changes:

1. **Stop the old bot first.** The page can only tell a bot is running if the current version started it. A bot left running from the old scripts shows as stopped, and pressing Start would run a second copy on the same wallet.
2. `git pull`, then `npm install` (there are new dependencies).
3. `npm run ui`, open the page, and press Start on each bot.

`.env.sbtc` and `.env.stx` show up as they are, with their wallet, settings and history. A bot that was live stays live. Old pool aliases (`dlmm_1`, `dlmm_3`, `dlmm_14`) are rewritten to the pool's contract id the first time the page opens, and the pool itself does not change. An env file under another name, such as `.env.mybot`, needs `BOT_PROFILE=sbtc` or `BOT_PROFILE=stx` added to show up. A plain `.env` is not listed.

There is no login. The helper listens on `127.0.0.1` only and refuses requests from other websites or hostnames.

An agent uses the same helper: send JSON (`content-type: application/json`) to `http://127.0.0.1:4173`. Risky calls stay risky: dry run refuses manual trades, a withdraw must be paused first, and leaving dry run requires `confirmLive` plus the exact pool name.

| Call | What it does |
| --- | --- |
| `GET /api/fleet` | All bots, the book, and “Needs you” |
| `GET /api/bots/:id` | One bot, including logs, bins, limits, and settings |
| `GET /api/pools?profile=stx` | Every pool of the pair, best first: range, price, market gap, liquidity near the price, and why a pool is skipped |
| `POST /api/bots` | Create a bot. Body: `profile` (`sbtc` or `stx`), `wallet` (`create` or `import`), `signerKey` only when importing, and optionally `poolId` from the pool list. The response never contains the key. |
| `POST /api/bots/:id/pool` | Change pools: pause, withdraw everything (live), confirm the old pool is empty, switch, stay paused. Body `poolId`, `acknowledged: true`, `poolName`. |
| `GET /api/bots/:id/history?range=1d` | Value points for the chart (`1d`, `7d`, or `all`), thinned to about 300 |
| `GET /api/bots/:id/decisions.csv` | Every recorded check as CSV |
| `POST /api/bots/:id/pause` | Kill switch. Process stays up. Liquidity stays in the pool. |
| `POST /api/bots/:id/resume` | Clear the kill switch |
| `POST /api/pause-all` | Pause every running bot (the header's Pause all). Stopped bots are left alone. |
| `POST /api/bots/:id/start` | Start the process |
| `POST /api/bots/:id/stop` | Stop the process. Does not withdraw |
| `POST /api/bots/:id/settings` | Save settings and restart. Body `settings`. Going live also needs `confirmLive: true` and `poolName`. |
| `POST /api/bots/:id/baseline-reset` | Reset the profit starting point on the next valued check |
| `POST /api/bots/:id/manual` | Swap, add, or withdraw. Live only. Body includes `acknowledged: true` and `poolName`. |
| `POST /api/bots/:id/cash-out` | Pause and stop the bot, withdraw everything, and send all tokens and STX to the saved payout address. Works in dry run. Body `acknowledged: true` and `poolName`. |
| `GET /api/bots/:id/cash-out` | Progress of the last cash out (`running`, `done`, or `failed`) with its steps and tx ids |
| `GET /api/bots/:id/bridge` | The bot's sBTC deposit address, sBTC and USDCx limits and fees, and every bridge transfer |
| `GET /api/bridge` | Every bot's bridge transfers, newest first |
| `POST /api/bots/:id/bridge-deposit` | Make the bot's BTC deposit address. Nothing leaves the wallet. |
| `POST /api/bots/:id/bridge-usdc-deposit` | Follow a USDC deposit sent from an Ethereum wallet. Body `ethTxid`, `amount`. Nothing leaves the bot wallet. |

**Keep `npm run ui` running.** Bots started from the page stop when it stops: closing its terminal, restarting the computer, or letting it sleep all stop a live bot. Liquidity stays in the pool while it is stopped.

**Wallets.** Each bot has a wallet of its own. When you create a bot, pick one of three:

- **New wallet.** The page makes one recovery phrase, kept in `.mm-wallet` (readable only by your user), and gives each bot the next account of it (account 1, 2, 3…, the same accounts Leather and Xverse show). Save the phrase once, when the first bot is made; it restores every bot's wallet. Going live is blocked until it is backed up, and the Wallet tab can show it again.
- **Recovery phrase.** Paste a 12 or 24 word phrase and pick an account. The page lists the first five, marking ones with history or already used by a bot here. Only that account's key is saved, in `.env.<bot>`; the phrase is not stored.
- **Private key.** Paste the account's key as hex.

Two bots can never share a wallet: the page refuses an address another bot already uses.

**Cash out** goes only to a payout address you save on the Wallet tab. Saving or changing that address and showing the key work only in the page, not through the API, so an agent can cash out but cannot send funds anywhere else. If a cash out stops partway, run it again: each step reads live balances and finishes what is left. From the command line: `npm run tick -- --pool sbtc --cash-out --to SP… [--memo …]`.

**Bridge** (its own page in the sidebar, and the Fund step of a new bot) moves BTC in and out through the official sBTC bridge, and USDC through Circle's xReserve:

- **BTC → sBTC.** Each bot gets a Bitcoin deposit address. Send BTC to it from any wallet or exchange; the page finds the transaction and registers it with the sBTC signers itself, while `npm run ui` is running. The refund key is the bot's own key, so an unprocessed deposit can be reclaimed with the key you backed up after 950 Bitcoin blocks.
- **sBTC → BTC.** Sends sBTC from the bot wallet to a Bitcoin address you type, like cash out: page only, the bot paused or stopped, and from sBTC in the wallet (not the pool). From the command line: `npm run tick -- --pool sbtc --sbtc-withdraw --amount <sats> --to bc1… --max-fee <sats>`.
- **USDC → USDCx.** Connect an Ethereum wallet (MetaMask, Rabby, Coinbase Wallet) on the page; it approves the exact amount and calls xReserve's `depositToRemote` with the bot's Stacks address. The console never sees that wallet's key: the page hands it the transaction hash and it follows the deposit to the USDCx mint on Stacks (about 15 minutes, minimum 10 USDC, no fee beyond Ethereum gas, no STX needed to receive).
- **USDCx → USDC.** Burns USDCx from the bot wallet to an Ethereum address you type, with the same rules as sBTC → BTC. Circle takes 2.00 USDC off the payout, which arrives in about an hour; the minimum is read from `usdcx-v1` (4.80 USDCx today). From the command line: `npm run tick -- --pool stx --usdcx-withdraw --amount <micro-USDCx> --to 0x…`.

Ethereum is read through a public node (publicnode) by default; set `ETH_RPC_URL` in the environment of `npm run ui` to use your own.

Transfers are kept in `data/bridge.<bot>.json`. To try the Bridge page without real BTC or USDC, run `npm run ui:demo`: balances and transfers are made up, move through each stage on a timer, and are kept apart in `data/bridge.<bot>.demo.json`. Default ports are `5191` for the page and `4173` for the API (`CONSOLE_PAGE_PORT`, `CONSOLE_API_PORT`).

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
3. **Its private key as hex** for `SIGNER_KEY`. Some wallet apps can show or copy an account's private key directly. If yours only shows the seed phrase, the page's **Recovery phrase** option derives the account's key for you and stores only that key. For the command line, derive it on a machine that is offline and never paste the seed phrase anywhere else:

   ```bash
   npm install --no-save @stacks/wallet-sdk
   SEED="<your-seed-phrase-here>" node -e "require('@stacks/wallet-sdk').generateWallet({secretKey: process.env.SEED, password: ''}).then(w => console.log(w.accounts[0].stxPrivateKey))"
   ```

   That prints the key of the first account under the seed only. The bot runs one process per pool and each process needs its own account (see "One process per pool" above), so running both pools from one wallet means a second account, and that account has a different key. For a second account, or for any account that is not the first in your wallet, set `N` to the account's number as your wallet lists it (for example "Account 2") and run this form instead:

   ```bash
   SEED="<your-seed-phrase-here>" N=2 node -e "const s=require('@stacks/wallet-sdk'); s.generateWallet({secretKey: process.env.SEED, password: ''}).then(w => { const i=Number(process.env.N)-1; while (w.accounts.length <= i) w = s.generateNewAccount(w); console.log(w.accounts[i].stxPrivateKey) })"
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
- [SECURITY.md](./SECURITY.md): key handling and the metrics port.
- [Guides for AI Bitcoin Agents](https://github.com/k9dreamer-graphite-elan/guides-for-ai-bitcoin-agents) (community edition, unofficial): handbook, runbooks and per-pool notes for [dlmm_1](https://github.com/k9dreamer-graphite-elan/guides-for-ai-bitcoin-agents/blob/main/public/hodlmm/knowledge/pools/dlmm_1.md) and [dlmm_14](https://github.com/k9dreamer-graphite-elan/guides-for-ai-bitcoin-agents/blob/main/public/hodlmm/knowledge/pools/dlmm_14.md). Optional reading; this bot does not depend on it or on any external skills.
