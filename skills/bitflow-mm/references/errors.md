# Errors

Find the row before any retry. The **Retry** column says whose move it is:

- **you**: fix the call and send it again.
- **wait**: the bot or the page clears it by itself. Report it and check again later.
- **user**: hand back to the human. Don't retry until they say so.
- **never blind**: something may already be on-chain. Check first, as the row says.

## API errors

The helper answers `{ "error": "<code>", "message": "…" }`. The message is written for the user and is fine to quote.

| Status | Code | Cause | Retry | Action |
|---|---|---|---|---|
| 403 | `page_only` | key backup, payout address or bridge withdrawal | user | Send the user to the Wallet tab or the Bridge page. Don't look for another route. |
| 403 | `not_local` | the request didn't come from this computer, or had a foreign `Origin` | you | Call `http://127.0.0.1:4173` directly, with no `Origin` header. |
| 415 | `json` | missing `content-type: application/json` | you | Add the header. |
| 400 | `secret` | the settings body included `SIGNER_KEY` | never | The key is never edited through the API. Drop it from the body. |
| 400 | `unknown_setting`, `invalid_setting`, `mode`, `pct`, `side`, `action`, `amount` | a bad field in the body | you | Read the message, fix the field, send again. |
| 400 / 409 | `preview` | the call needs a wallet and this is a preview bot (`preview-…`) | user | Explain that preview bots have fake funds. Ask whether to create a real bot. |
| 409 | `dry_run` | manual trade on a dry-run bot | user | Ask whether they want the bot live. If yes, follow [going-live.md](going-live.md). |
| 409 | `confirm` | missing `acknowledged: true`, or `poolName` isn't the exact pair | you, once the user asked for this action | Resend with `acknowledged: true` and `poolName` exactly `sBTC / USDCx` or `STX / USDCx`. |
| 409 | `confirm_live` | going live without `confirmLive: true` and the exact `poolName` | you, once the user asked to go live | Resend with both. |
| 409 | `not_ready` | going live with the checklist incomplete; the message lists what's missing | user | Read the list to the user. Backing up the key or phrase happens on the page. |
| 409 | `pause_first` | withdraw while the bot is running | you | `POST /api/bots/:id/pause`, then withdraw. |
| 409 | `no_payout` | cash out with no payout address saved | user | The user saves it on the Wallet tab. Never suggest an address. |
| 409 | `payout` | the saved payout address isn't usable | user | The user fixes it on the Wallet tab. |
| 409 | `cashing_out`, `switching_pool`, `bridging` | a background job is still running | wait | Poll the job (`GET …/cash-out`, the bot's `poolSwitch`, `GET …/bridge`) until it finishes. |
| 409 | `wallet_in_use` | that account already runs another bot | user | Ask for another account. Two bots never share a wallet. |
| 409 | `no_wallet` | the bot has no key yet | user | The user finishes the wallet step on the page. |
| 404 | `not_found`, `unknown_pool` | wrong bot id or pair | you | `GET /api/fleet` for ids. Pairs are `sbtc` and `stx`. |
| 500 | `start_failed` | settings were saved but the bot didn't restart | user | Show the message and the bot's last log lines. Don't start a second copy. |

## After a live action fails

A failed `manual` call (swap, add or withdraw) in live mode may still have broadcast. **Never blind.** Run `GET /api/bots/:id` and look for the transaction in its logs, or ask the user to open the bot's address on a Stacks explorer. Resend only on the user's explicit yes, once you both know nothing landed.

A cash out marked `failed` is safe to repeat: each step reads live balances and finishes what is left.

## Bot log lines

These show in a bot's logs (`GET /api/bots/:id`) and in `data/metrics.<bot>.jsonl`. The user-facing version, with what to do by hand, is in `docs/RECOVERY.md`.

| Log | Cause | Retry | Action |
|---|---|---|---|
| `GUARDRAIL kill_switch active` | the bot is paused | user | Resume only if the user asks. |
| `strategy_halt kind=broken_market` | pool price diverged from CoinGecko past `DIVERGENCE_HALT_BPS`, or a peg break | wait | Clears when the price is back in the band. Bins stay deployed unless `BREAKER_WITHDRAW_ALL=true`. |
| `strategy_halt kind=operational` | CoinGecko reading older than `REFERENCE_FEED_HALT_MS` | wait | Clears on a fresh reading. |
| `defensive (…); hold, no reposition` | divergence past `DIVERGENCE_WARN_BPS`, or an aging feed | wait | Holds existing bins. Clears by itself. |
| `pool_inactive` | the BFF reports the pool paused | wait | Clears when the pool is active again. |
| `BFF unreachable`, `snapshot_fetch_failed` | the bot can't reach `bff.bitflowapis.finance` | user | A VPN, proxy or firewall is usually in the way. The README lists the hosts to allow. |
| `ERR_SSL_WRONG_VERSION_NUMBER` | something on the network answered in place of the real host | user | Same as above. |
| `429` | the public Hiro API rate-limited the bot | user | Suggest setting `STACKS_NODE_URL` to their own node or a paid endpoint. |
| `api_error`, `circuit_breaker TRIPPED` | `MAX_CONSECUTIVE_API_ERRORS` failed fetches in a row | wait | Clears on the first good fetch. |
| `low_gas` | wallet STX can't cover the fees | user | The user sends STX to the bot's address. |
| `replace-by-fee attempt N` | a transaction is slow to confirm | wait | The bot raises the fee by itself. |
| `status="timeout"`, `timeout_max_fee`, `GUARDRAIL pending_tx`, `GUARDRAIL nonce_gap` | a transaction is stuck after every fee bump | user | Point to `docs/RECOVERY.md` section 3. Never restart or start a second copy to "retry". |
| `EADDRINUSE` | an earlier process still holds the port | user | That process is still alive. The user stops it before starting again. |
