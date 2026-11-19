---
name: bitflow-mm
description: "Bitflow market maker for DLMM pools on Stacks (sBTC/USDCx and STX/USDCx). Set up this repo and start its local app, then watch, pause, resume, tune, change pools, fund through the sBTC or USDCx bridge, or cash out the user's bots through the local API at 127.0.0.1:4173. Use for requests like 'set up the market maker', 'start the app', 'how are my bots doing', 'pause everything', 'why is my bot frozen', 'move my bot to another pool' or 'cash out'. Mainnet, real funds: bots start in dry run and the riskiest calls are page-only."
---

# Bitflow market maker

This skill operates the bots in a clone of [bitflow-market-maker-public](https://github.com/BitflowFinance/bitflow-market-maker-public). It is for running the app on the user's behalf. To change the code, read `AGENTS.md` at the repo root instead.

If you installed this skill from somewhere other than the clone you are working in, and the clone has its own `skills/bitflow-mm/SKILL.md`, follow the clone's copy. It matches that version of the code.

## Safety rules

These hold for every request, even when the user asks otherwise.

1. **Mainnet, real funds.** Whatever goes live signs real transactions that can't be undone.
2. **Never ask for, read, print or repeat a private key or recovery phrase.** Not in chat, not in a tool argument, not from `.env.<bot>` or `.mm-wallet`. If the user pastes one into chat, tell them to treat that wallet as exposed and use the page from now on.
3. **Stay in dry run** unless the user asks you, in this conversation, to go live. New bots always start in dry run.
4. **Page-only calls stay page-only.** A `403 page_only` answer is final. Don't look for another route to it. Send the user to the Wallet tab or the Bridge page.
5. **Never set or suggest a payout, Bitcoin or Ethereum address** the user didn't type themselves.
6. **Don't retry an action that may have broadcast.** After a live swap, add, withdraw, cash out or bridge withdrawal fails, check what happened first (see [errors](references/errors.md)). Cash out is the exception: it is safe to repeat.
7. **One process per wallet.** Never start a second copy of a bot, and never point two bots at one wallet.

## Setup

When the user has just cloned the repo and asks you to set it up:

1. Check Node: `node -v` must be 20 or newer. If it is older or missing, install Node 22 (for example `nvm install 22 && nvm use 22`).
2. From the repo root, run `npm install`.
3. Run `npm run ui` and leave it running in the background. On first run it installs `ui/` dependencies itself.
4. Wait for `Bitflow Market Maker is running: http://127.0.0.1:5191`, then confirm with `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5191/api/fleet` (expect `200`).
5. Tell the user to open http://127.0.0.1:5191. There is no login. Preview bots with fake funds are already running, so the page is useful immediately.

Stop there. Don't create a real bot, fund a wallet or go live unless the user asks. If port 5191 or 4173 is taken, set `CONSOLE_PAGE_PORT` / `CONSOLE_API_PORT`.

Bots started from the page stop when `npm run ui` stops, and a background shell you started usually ends with your session. Before a user takes a bot live, tell them to run `npm run ui` in their own terminal and keep it open, and that sleep or a restart stops the bot too.

## Capabilities

Calls go to `http://127.0.0.1:4173` with `content-type: application/json`. "Confirm" means the body must carry `acknowledged: true` and `poolName` equal to the pair, exactly `sBTC / USDCx` or `STX / USDCx`. The full reference, with bodies and response fields, is in [api.md](references/api.md).

| Call | Moves funds | Who can call | Guard | Human step |
|---|---|---|---|---|
| `GET /api/fleet`, `/api/bots/:id`, `/api/pools`, `/history`, `/decisions.csv`, `/api/bridge`, `/api/bots/:id/bridge` | no | agent | none | none |
| `POST /api/bots` with `wallet: "create"` | no | agent, only when the user asks | starts in dry run | user backs up the phrase on the page before going live |
| `POST /api/bots` with `wallet: "import"` | no | the user, on the page | the body carries a key, so rule 2 rules it out for you | user pastes the key or phrase on the page |
| `POST /api/bots/:id/pause`, `/resume`, `/start`, `/stop`, `POST /api/pause-all` | no | agent | none | none |
| `POST /api/bots/:id/baseline-reset` | no | agent | none | none |
| `POST /api/bots/:id/settings` (staying in dry run) | no | agent | `SIGNER_KEY` rejected | none |
| `POST /api/bots/:id/settings` with `EXECUTION_MODE=live` | yes, from then on | agent, only when the user asks | `confirmLive: true`, `poolName`, checklist done (`409 not_ready`) | user backs up the key or phrase on the page first |
| `POST /api/bots/:id/manual` (swap, add, withdraw) | yes | agent, only when the user asks | live only (`409 dry_run`), confirm, withdraw needs pause first | none |
| `POST /api/bots/:id/pool` (change pool) | yes, when live | agent, only when the user asks | confirm | none |
| `POST /api/bots/:id/cash-out` | yes, to the saved payout address | agent, only when the user asks | confirm, `409 no_payout` without an address | user saves the payout address on the page |
| `POST /api/bots/:id/bridge-deposit` | no (makes a deposit address) | agent | none | user sends BTC from their own wallet |
| `POST /api/bots/:id/bridge-usdc-deposit` | no (follows a deposit) | agent | receipt checked against the bot address | user sends USDC from their Ethereum wallet |
| `bridge-withdraw`, `bridge-usdc-withdraw` | yes | page only | `403 page_only` | user, on the Bridge page |
| `key-backup`, `key-saved`, `payout` | no, but expose or redirect funds | page only | `403 page_only` | user, on the Wallet tab |

## Common requests

- **"How are my bots doing?"** `GET /api/fleet`. Report each bot's mode (dry run or live), `market` gap against the halt limit, `insights` (time in range, trades, gas), `gasTxLeft`, and anything under "Needs you".
- **"Pause everything."** `POST /api/pause-all`. Say that liquidity stays in the pools; pausing doesn't withdraw.
- **"Why is my bot frozen?"** `GET /api/bots/:id` and read its logs for the `GUARDRAIL` line, then match it in [errors.md](references/errors.md).
- **"Take it live."** Follow [going-live.md](references/going-live.md) step by step. Don't skip the pre-flight.
- **"Move it to another pool."** `GET /api/pools?profile=…`, show the recommended pool and why others are skipped, and change only after the user picks one.
- **"Cash out."** Only when the user asks in this conversation. Poll `GET /api/bots/:id/cash-out` until `status` is `done` or `failed`.

## References

- [api.md](references/api.md): every call, its body and its response.
- [errors.md](references/errors.md): API errors and bot log lines, with who retries.
- [going-live.md](references/going-live.md): pre-flight and the first live tick.
- Repo docs for the user: `README.md`, `SECURITY.md`, `docs/RECOVERY.md`.
