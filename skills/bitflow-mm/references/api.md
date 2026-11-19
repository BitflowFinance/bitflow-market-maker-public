# Local API reference

The local helper started by `npm run ui` listens on `http://127.0.0.1:4173`. The page at `http://127.0.0.1:5191` proxies `/api` to it. Errors come back with an HTTP status and a body of `{ "error": "<code>", "message": "…" }`; [errors.md](errors.md) lists the codes.

## Access

There is no login code. The helper only answers requests from this computer: it checks the `Host` and `Origin` headers, refuses cross-site browser requests, and requires `content-type: application/json` on writes. Do not put `SIGNER_KEY` in chat, in a tool argument, or in a page response.

## Calls

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

## Behavior per call

- `GET /api/fleet` answers how the bots are doing. Each bot carries `insights` (time in range, trades and gas over 24h and all time), `market` (pool vs market price and the gap against the halt limit), `inventory`, `curve`, and `walletStx` / `gasTxLeft`.
- `GET /api/pools?profile=sbtc|stx` ranks the pair's pools (`recommended`, and `reasons` for each skipped one). `POST /api/bots/:id/pool` with `poolId`, `acknowledged: true`, and the exact `poolName` changes pools; it runs in the background (`poolSwitch` on the bot), withdraws first when live, and changes nothing unless the old pool is confirmed empty. Only change pools when the user asks.
- `GET /api/bots/:id/history?range=1d|7d|all` gives chart points; `GET /api/bots/:id/decisions.csv` gives every recorded check.
- `POST /api/bots/:id/pause`, `/resume`, `/start`, `/stop` control the process. Pause is the kill switch and does not withdraw. Stop does not withdraw. `POST /api/pause-all` (the header's Pause all) pauses every running bot and leaves stopped ones alone.
- `POST /api/bots/:id/manual` is a swap, add, or withdraw. Dry run returns 409. Withdraw returns 409 until the bot is paused. Body must include `acknowledged: true` and `poolName` equal to `sBTC / USDCx` or `STX / USDCx`.
- `POST /api/bots/:id/settings` writes the env file and restarts. `SIGNER_KEY` is rejected. Setting `EXECUTION_MODE` to `live` also requires `confirmLive: true` and the exact `poolName`.
- `POST /api/bots/:id/cash-out` pauses and stops the bot, withdraws everything, and sends all tokens and STX to the saved payout address. It works in dry run. Body must include `acknowledged: true` and the exact `poolName`; it returns 409 `no_payout` until the user saves an address. It runs in the background: poll `GET /api/bots/:id/cash-out` until `status` is `done` or `failed`. A `failed` run is safe to repeat. Only cash out when the user asks in chat.
- `key-backup`, `key-saved`, and `payout` answer only the page (403 `page_only` otherwise). Do not try to get around that: never read, print, or repeat `SIGNER_KEY`, and never set or suggest a payout address the user did not type themselves. Send the user to the Wallet tab instead.
- `GET /api/bridge` lists every bot's transfers. `GET /api/bots/:id/bridge` gives the bot's sBTC deposit address, withdrawal limits, and transfers. `POST /api/bots/:id/bridge-deposit` makes the deposit address (nothing leaves the wallet; the console finds and registers deposits itself). `bridge-usdc-deposit` records a USDC deposit the user sent from their Ethereum wallet (the receipt is checked against the bot address before it counts). `bridge-withdraw` (sBTC to a Bitcoin address) and `bridge-usdc-withdraw` (USDCx to an Ethereum address) send funds out, so they answer only the page; send the user to the Bridge page.
- Preview ids look like `preview-sbtc`.

New bots are created with `POST /api/bots` and always start in dry run. Importing a key writes it to `.env.<pool>` and the JSON response must not contain it.
