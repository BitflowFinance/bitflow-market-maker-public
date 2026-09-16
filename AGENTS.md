# Curve Market Maker - Agent Guidelines

## Build & Commands

```bash
npm run build      # Compile TypeScript to dist/
npm run typecheck  # Type-check without emitting (fast feedback)
npm test           # Run the vitest suite once
npm run tick -- --pool sbtc   # Single tick (dry-run friendly)
npm run dev -- --pool sbtc    # Loop with auto-reload
npm start -- --pool sbtc      # Compiled loop (prefer `node dist/index.js`)
```

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

`SIGNER_KEY` / `SIGNER_ADDRESS` live in that env file. Metrics default to
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
  that is not `clean` *and* `complete` throws rather than being read as an empty
  position, which would make the bot redeploy over liquidity it already owns.
  Beware: v2 repurposed `userLiquidity` as a human-scaled float and moved the raw
  count to `userShares`, so `userBinLiquidity` prefers the latter.
- **Pool id form.** `current-bins` keys off the alias (`dlmm_1`) and 404s on a
  contract principal; the other `app/v2` routes are the reverse. v2 also nulls
  `pool_token`/`core_address`, so the principal that post-conditions are built
  against comes from `pool_id`.
- **Empty positions.** v1 answers 404 (not an empty list) for a wallet that has
  never deployed to the pool, which is every wallet's first tick; that one case is
  read as "no position" instead of tripping the api-error breaker.

No API key is required for the default 50 req/s per-IP tier and a tick spends
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
