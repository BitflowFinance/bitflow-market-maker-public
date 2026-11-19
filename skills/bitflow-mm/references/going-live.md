# Going live

Follow this only when the user asks, in this conversation, to take a bot live. Each step names who does it. Stop at any step that fails and tell the user why.

## 1. Before you touch settings

1. **You:** `GET /api/bots/:id`. Confirm the bot is a real bot (not `preview-…`), in dry run, and its recent checks end in `hold` or `rebalance`, not `frozen` or an error.
2. **You:** read the bot's latest check:
   - the wallet shows both pool tokens;
   - the pool has an active bin with a price;
   - `market` shows the gap to CoinGecko below the warn limit.
3. **You:** check `walletStx` and `gasTxLeft`. The wallet needs `STX_GAS_RESERVE_USTX` (5 STX by default) plus room for several transactions.
4. **You:** check `GET /api/pools?profile=…`. If the bot's pool isn't the recommended one, say so before going on.
5. **User:** has backed up the key or recovery phrase on the page. You can't do or check this through the API. If it's missing, the go-live call answers `409 not_ready` and names it.
6. **User:** keeps `npm run ui` running in their own terminal, not in your background shell. Sleep or a restart stops the bot.

## 2. Small first

Suggest a small `MAX_POSITION_USTX` for the first live run (0 means no cap). The value is the user's call. Don't pick an amount for them.

## 3. Go live

**You**, once the user has confirmed steps 5 and 6:

```json
POST /api/bots/:id/settings
{ "settings": { "EXECUTION_MODE": "live" }, "confirmLive": true, "poolName": "sBTC / USDCx" }
```

Use `STX / USDCx` for an STX bot. The bot restarts in live mode. On a `409`, read [errors.md](errors.md).

## 4. Watch the first ticks

1. **You:** poll `GET /api/bots/:id` and read the logs. Startup must log `signer key/address check passed`.
2. **User:** opens the bot's address on a Stacks explorer and confirms the first transactions there.
3. If anything looks wrong, **you** `POST /api/bots/:id/pause` first, then report. Pausing leaves liquidity in the pool.

## Command-line path

Some users run the bot without the page. The README's **Pre-flight** section is the same checklist for that path, ending in one `--once` live tick before the loop.
