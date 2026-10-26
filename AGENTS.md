# Curve Market Maker - Agent Guidelines

## Build & Commands

```bash
npm run build      # Compile TypeScript to dist/
npm run typecheck  # Type-check without emitting (fast feedback)
npm test           # Run the vitest suite once
npm run tick -- --pool sbtc   # Single tick (dry-run friendly)
npm run dev -- --pool sbtc    # Loop with auto-reload
npm start -- --pool sbtc      # Compiled loop (prefer `node dist/index.js`)
npm run ui         # Local app at http://127.0.0.1:5191. See "Setting up the app" below.
```

## Setting up the app

When a user has just downloaded this repo and asks you to set it up, get the app online and hand them the URL:

1. Check Node: `node -v` must be 20 or newer. If it is older or missing, install Node 22 (for example `nvm install 22 && nvm use 22`).
2. From the repo root, run `npm install`.
3. Run `npm run ui` and leave it running in the background. On first run it installs `ui/` dependencies itself.
4. Wait for `Bitflow MM is running: http://127.0.0.1:5191`, then confirm with `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5191/api/fleet` (expect `200`).
5. Tell the user to open http://127.0.0.1:5191. There is no login. Preview bots with fake funds are already running, so the page is useful immediately.

Do not create a real bot, go live, or fund a wallet unless the user asks. If port 5191 or 4173 is taken, set `CONSOLE_PAGE_PORT` / `CONSOLE_API_PORT`.

Bots started from the page stop when `npm run ui` stops, and a background shell you started usually ends with your session. Before a user takes a bot live, tell them to run `npm run ui` in their own terminal and keep it open, and that sleep or a restart stops the bot too.

## Local page

There is no login code. The helper only answers requests from this computer: it checks the `Host` and `Origin` headers, refuses cross-site browser requests, and requires `content-type: application/json` on writes. Do not put `SIGNER_KEY` in chat, in a tool argument, or in a page response.

Agent calls go to `http://127.0.0.1:4173` with `content-type: application/json`. The page itself is `http://127.0.0.1:5191` and proxies `/api` to that helper.

- `GET /api/fleet` answers how the bots are doing. Each bot carries `insights` (time in range, trades and gas over 24h and all time), `market` (pool vs market price and the gap against the halt limit), `inventory`, `curve`, and `walletStx` / `gasTxLeft`.
- `GET /api/pools?profile=sbtc|stx` ranks the pair's pools (`recommended`, and `reasons` for each skipped one). `POST /api/bots/:id/pool` with `poolId`, `acknowledged: true`, and the exact `poolName` changes pools; it runs in the background (`poolSwitch` on the bot), withdraws first when live, and changes nothing unless the old pool is confirmed empty. Only change pools when the user asks.
- `GET /api/bots/:id/history?range=1d|7d|all` gives chart points; `GET /api/bots/:id/decisions.csv` gives every recorded check.
- `POST /api/bots/:id/pause`, `/resume`, `/start`, `/stop` control the process. Pause is the kill switch and does not withdraw. Stop does not withdraw.
- `POST /api/bots/:id/manual` is a swap, add, or withdraw. Dry run returns 409. Withdraw returns 409 until the bot is paused. Body must include `acknowledged: true` and `poolName` equal to `sBTC / USDCx` or `STX / USDCx`.
- `POST /api/bots/:id/settings` writes the env file and restarts. `SIGNER_KEY` is rejected. Setting `EXECUTION_MODE` to `live` also requires `confirmLive: true` and the exact `poolName`.
- `POST /api/bots/:id/cash-out` pauses and stops the bot, withdraws everything, and sends all tokens and STX to the saved payout address. It works in dry run. Body must include `acknowledged: true` and the exact `poolName`; it returns 409 `no_payout` until the user saves an address. It runs in the background: poll `GET /api/bots/:id/cash-out` until `status` is `done` or `failed`. A `failed` run is safe to repeat. Only cash out when the user asks in chat.
- `key-backup`, `key-saved`, and `payout` answer only the page (403 `page_only` otherwise). Do not try to get around that: never read, print, or repeat `SIGNER_KEY`, and never set or suggest a payout address the user did not type themselves. Send the user to the Wallet tab instead.
- Bridging is turned off for now (`BRIDGE_ENABLED` in `src/console/bridgeLive.ts`); `/api/bridge` returns 404. Preview ids look like `preview-sbtc`.

New bots are created with `POST /api/bots` and always start in dry run. Importing a key writes it to `.env.<pool>` and the JSON response must not contain it.

**Note:** Tests run with vitest (`npm test`). No separate linter; `tsconfig` has
`strict`, `noUnusedLocals`, and `noUnusedParameters` on, so `npm run build` /
`npm run typecheck` catches unused code and type errors.

---

## Code Style Guidelines

### TypeScript Configuration
- Target: ES2020
- Strict mode enabled
- CommonJS modules
- Output directory: `dist/`

### Imports
- Use relative paths: `import { CONFIG } from './config'`
- No type-only imports (no `import type`)

### Naming Conventions
- **Variables/Functions**: camelCase (`runTick`, `getPoolSnapshot`)
- **Types/Interfaces**: PascalCase (`PoolSnapshot`, `TickResult`)
- **Constants**: UPPERCASE (`CONFIG`, `TAG`)
- **Files**: camelCase

### Error Handling
```typescript
try {
  await someAsyncOperation();
} catch (err) {
  const error = err as Error;
  logWarn(`[tag] error="${error.message}"`);
}
```
- Always cast `err` to `Error` type
- Use descriptive error messages with context in quotes

### Logging
```typescript
import { logInfo, logWarn, logError, logDebug } from './logger';

logInfo('[tag] key="value"');
```
- Bracketed prefixes: `[tag] message`
- Key-value pairs for structured data
- Include duration for operations: `duration="${duration}s"`

### Conventions
- Use `async/await`; use `Promise.all()` for parallel reads
- Use `BigInt` for atomic on-chain amounts; format for display with `microToString`
- `String(value)` / `Number(value)` for explicit conversions

### Comments
- Comments explain *why*, not *what*: keep rationale for non-obvious trade-offs,
  on-chain mechanics (DLMM bins, post-conditions, fees), and guardrail decisions.
- Do NOT add narrating comments that restate the code.

## File Organization

- `src/config.ts`     - Env config (typed `CONFIG`)
- `src/logger.ts`     - pino logging
- `src/stacks.ts`     - Read-only contract calls, balances
- `src/bitflow.ts`    - BFF pool/bin reads + combined `PoolSnapshot`
- `src/mm.ts`         - One tick: read state, run feed + strategy, guard, execute
- `src/registry.ts`   - Maps `POOL_STRATEGY` -> CoinGecko feed + curve
- `src/conversion.ts` - `swap_only` inventory conversion
- `src/cashout.ts`    - `--cash-out`: withdraw all, send tokens + STX to the payout address
- `src/payout.ts`     - Payout address / memo checks (no CONFIG, shared with the console)
- `src/console/`      - Local page helper (`npm run ui`): API, bot processes, env files
- `src/plan.ts`       - Execute the rebalance plan (withdraw/swap/add)
- `src/primitives.ts` - Market-making actions (swap/add/withdraw)
- `src/swap.ts`       - DLMM swap router calls + output estimate
- `src/liquidity.ts`  - DLMM liquidity router calls (v7 NFT post-conditions)
- `src/wallet.ts`     - Nonce/fee/preflight, sign, broadcast, confirm, RBF
- `src/metrics.ts`    - In-memory metrics + JSONL + PnL-vs-HODL baseline
- `src/api.ts`        - Read-only metrics HTTP server
- `src/index.ts`      - Entry point (interval loop, `--once`, or manual runners)
- `src/feeds/`        - `PriceFeed` + CoinGecko reference
- `src/strategy/`     - `Strategy` + curve + `curveShape` math

Tests: `test/` vitest suites; import source via `../src/...`.

## Multi-pool model

One pool per process, each with its own wallet. Both competition pairs use the
same CoinGecko feed + geometric curve (`POOL_STRATEGY=curve`, or the aliases
`sbtc-usdcx-curve` / `stx-usdcx-curve`). Env file precedence:

- `--env <path>` / `ENV_FILE=<path>`
- `--pool <name>` / `POOL_PROFILE=<name>` → `.env.<name>`
- neither → `.env`

The explicit-path flag is `--env`, never `--env-file`: Node >=20.6 has a
built-in `--env-file` that swallows the argument before our parser runs.

`SIGNER_KEY` / `SIGNER_ADDRESS` live in that env file. `KEY_SOURCE` records where
the key came from (`create`, `import`, `phrase`, `app-phrase`) and `WALLET_ACCOUNT`
the phrase account. The console's own phrase lives in `.mm-wallet` (0600, JSON
`{phrase, backedUpAt}`), shared by every `app-phrase` bot at `m/44'/5757'/0'/0/<n>`;
an unreadable `.mm-wallet` is never overwritten. An imported phrase is never stored.
`POST /api/wallet/accounts` and the key/phrase backup routes are page-only. Metrics default to
profile-scoped paths (`data/metrics.<name>.jsonl`). Set `METRICS_HTTP_PORT` per
env file.

Pool sides are neutral: `BASE_TOKEN_CONTRACT` / `QUOTE_TOKEN_CONTRACT` declare
orientation. Token decimals are hydrated from the BFF at startup. The native-STX
wrapper (`STX_TOKEN_CONTRACT`) is kept so STX post-conditions and the STX/USDCx
gas+inventory path work.

## BFF API generations

`BFF_API_VERSION` selects the API generation (`v2` default, `v1` fallback). The
two must never be mixed; `bitflow.ts` normalizes a whole generation onto the v1
shape so nothing downstream knows which one is live:

- **Bin ids.** v2 serves the ladder and active bin signed (`-500..500`); they are
  shifted to the unsigned `0..1000` domain on read. Contract calls convert back
  via `signedBinId`.
- **Inventory.** v2 reads `app/v2/users/{addr}/positions/{pool}/current-bins`,
  which carries raw integer shares plus bin totals and tip freshness. A snapshot
  that is not `clean` *and* `complete` *and* at `tipLag <= BFF_MAX_TIP_LAG` throws
  rather than being read as an empty or current position, which would make the bot
  redeploy over liquidity it already owns. `clean` alone is not enough: the engine
  answers 200 while some blocks behind and only escalates to 503 `TIP_LAG` further
  back. Beware: v2 repurposed `userLiquidity` as a human-scaled float and moved the
  raw count to `userShares`, so `userBinLiquidity` prefers the latter.
  (Bitflow's own Rust market maker uses the ClusterIP `/api/mm/v1` inventory
  service, which is unreachable outside their cluster; `current-bins` is the
  public equivalent and applies the same freshness rules.)
- **Pool id form.** `POOL_ID` is the pool's contract id
  (`SM1F….dlmm-pool-sbtc-usdcx-v-1-bps-10`). Every v2 route accepts it; the quote
  routes no longer accept the short aliases (`dlmm_1`, `dlmm_3`, ...) and 404. A legacy
  alias in an env file is resolved once at startup through `app/v2/pools/{alias}`
  (with a warning), and `npm run ui` rewrites known aliases in `.env.<pool>` files.
  v2 also nulls `pool_token`/`core_address`, so the principal that post-conditions
  are built against comes from `pool_id`.
- **Empty positions.** v1 answers 404 (not an empty list) for a wallet that has
  never deployed to the pool, which is every wallet's first tick; that one case is
  read as "no position" instead of tripping the api-error breaker. v2's equivalent
  is a 503 `NODE_POSITION_NOT_REGISTERED`; it is read as empty only when the wallet
  has never sent a transaction (Hiro nonces), since any other wallet may own
  liquidity the engine has not indexed yet.
- **Tip freshness.** v2 serves quotes from in-memory state at the applied tip and
  has no stale-DB fallback (`X-Allow-Fallback` does not apply), so every tick
  gates on `quotes/v2/status`: the tick holds unless `tip_lag <= BFF_MAX_TIP_LAG`
  (default 0). A null `tip_lag` means the tip is unknown and is treated as stale,
  never as caught up.
- **Bin shares.** The ladder's `liquidity` can be null (in practice it is
  populated near the active bin and null in the dust tail; Bitflow's samples stop
  on null). Shares
  are the denominator for `minDlp`, so `resolveBinShares` falls back to the pool's
  `get-total-supply` for any bin the ladder does not price. Defaulting to zero
  instead would take `calcAddSlippage` down its empty-bin sqrt branch, which
  mis-sizes `minDlp` in either direction: too high aborts the add on-chain, too
  low forfeits slippage protection.

No API key is required for the default 100 req/s per-IP tier and a tick spends
about four calls; set `BFF_API_KEY` only if Bitflow issues one for a raised quota.

The curve uses the `add_shaped_liquidity` step: it carries the shape (bin
offsets + weights + size fraction) and the primitive sizes amounts from live
balances at execution. `halt` is two-tier: `operational` (withdraw + stop) or
`broken_market` (withdraw, hold inventory, no blind swap).

Inventory-regime knobs (M2 / M4 / M5 / M6) live in `curve.ts` / `curveShape.ts`
and are applied on every shaped add. M5 de-risk requires `ENABLE_SWAP=true`.

The bot self-terminates if orphaned: `SIGINT`/`SIGTERM`/`SIGHUP` plus a
parent-pid watchdog in `index.ts`.

## Execution Modes

- `dry_run` (default) - read state and log decisions; no signing, no broadcast.
- `live` - signs and broadcasts (sign -> broadcast -> confirm -> replace-by-fee).
