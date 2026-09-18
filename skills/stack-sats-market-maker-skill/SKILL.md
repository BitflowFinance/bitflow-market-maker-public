---
name: stack-sats-market-maker-skill
description: Set up and run the Bitflow market maker (the Stack Sats on Bitflow "Agent Starter Kit", github.com/BitflowFinance/bitflow-market-maker-public) for a user, on one campaign pool or both, with each pool's account enrolled in Stack Sats on Bitflow. Use this whenever a user wants to run the starter kit, automate their market making on Bitflow, "point my agent at the repo", enroll in Stack by Market Making, or asks about SIGNER_ADDRESS, SIGNER_KEY, dlmm_1, dlmm_14, or the sBTC/USDCx and STX/USDCx pools, even if they never say "skill" or "bot". Assume the user has never done this before. The bundled scripts can create the bot's account for them (the key goes straight into the env file and is never shown) or take an account from their own wallet; the agent asks which, never picks.
license: MIT. LICENSE has the full text.
compatibility: Requires Node.js 20+, git, curl, python3 and internet access. Works in Claude Code and Codex (open Agent Skills spec).
metadata:
  author: TheBigMac.btc
  github-username: MacBotMini-eng
---

# Stack Sats market maker

## What you are doing and why the steps look this way

You are setting up the starter kit for a person who wants Stack by Market Making rewards and has most likely never run a bot, derived a key, or edited an env file. The campaign runs two pools, sBTC/USDCx and STX/USDCx, and the bot runs one process per pool, each signing from its own account (README, "One process per pool (own wallet, own nonce space)"). So the user needs one account per pool they choose, and one key per account. There are two ways to get that account and the user chooses at step 3: a script creates a fresh account for the bot, or the user brings one from their own wallet.

The scripts in `scripts/` do every file write and every check. Run them instead of editing or reading the env files yourself. The reason is simple: the user's private key must never appear in your context, because anything in your context can end up in a transcript, a log, or a screenshot. `create_bot_account.sh` writes a new account's key straight into the env file and prints only the address; `set_signer_key.sh` opens the file for the user to paste a key from their own wallet, waits for them to close it, and verifies without printing. Either way the key never appears in your output.

The repo README owns every setting and safety rule. Read it once at the start (`$MM_REPO/README.md`; `MM_REPO` defaults to `~/bitflow-market-maker-public`) and send the user to its sections rather than paraphrasing them.

Steps marked **user** happen in the user's wallet or on the campaign page. Ask, wait for "done", then run the check. If the user pastes a seed phrase or key into the chat, tell them that account is no longer private: move its funds to a fresh account and redo step 3 for it.

## Boundaries: what this skill is and is not

The boundary is: the skill turns the agent into the bot's operator, never into the bot. The repo is the bot. The skill installs it, configures it, gates it, and reads it. The loop runs as its own process and makes every trading decision on its own. The agent never places a trade by its own judgment.

This skill makes the agent the bot's operator. It does not make the agent the bot. The public repo is the bot: its loop reads the pool, decides, signs and broadcasts on its own, as a separate process in its own terminal. The agent installs it, configures it, gates it, starts it, watches it and stops it. The agent never decides a trade, an amount, a price or a bin.

| Who | Holds | Never does |
| --- | --- | --- |
| The user | The choice between a script-made account and one from their wallet, the recovery phrase and every private key, the funds and their amounts, acceptance of the campaign terms, the go before each live tick and each Manual CLI swap | Pastes a key or recovery phrase into chat |
| The agent, with this skill | The order of steps, the config writes (address, kill-switch path, mode), every check (install, balances, dry run, enrollment, transactions, campaign reading), starting and stopping the loop, reading results back in plain words | Sees, prints or derives a key; sets `EXECUTION_MODE=live` without the user's go; changes the bot's strategy or numbers; runs a Manual CLI swap unasked; creates an account except through `create_bot_account.sh`, which prints the address and nothing else; drives the user's wallet or browser |
| The bot (the repo) | Trading logic, curve shape, de-risk, safety halts, signing and broadcasting, nonce handling, metrics | Anything outside its env file and CLI flags |

Hand-off points, in order: the agent installs and configures; on path A it creates the bot's account by script and, once the user has accepted the campaign terms, enrolls it by script; on path B it hands the key step to the user through `set_signer_key.sh` and enrollment to the user's wallet or to `enroll.sh`; on the user's go it hands execution to the bot process. From then on the agent reads the bot; it does not steer it. Tuning the strategy (`F_STAR`, `CURVE_*`, `MAX_POSITION_USTX` and the rest) is the user's decision, applied by editing the env file and restarting the loop; the skill explains a knob when asked and never changes one on its own.

Out of scope: writing or modifying bot code, auditing the strategy, choosing amounts, tax or financial advice, and the Daily Stack or Stack by Trading as goals in themselves (the skill reports when a bot swap counts for them; it does not run swaps to chase them unless the user asks per swap).

## What the bot covers: all three tracks

Tell the user this up front, in the campaign page's own track names. The page says "Three ways to win. Pick your lane or take all three." The cards read: The Daily Stack, 41,666 sats x 5 winners, daily, 0.05 BTC pot, "One $25+ swap a day is your ticket. Entries stack until you win."; Stack by Trading, up to 15,000,000 sats / phase, 0.15 BTC pot, "Your volume is your share. No leaderboard. No cap."; Stack by Market Making, 30,000,000 sats / phase, 0.3 BTC pot, "Tight liquidity near the price out-earns parked TVL. Skill pays." One bot, one account, takes all three, because every action it takes is routed through a HODLMM pool for sBTC/USDCx or STX/USDCx. Stack by Market Making is its job; the swaps it makes on the way are what The Daily Stack and Stack by Trading count.

| Track (page terms) | What counts | How the bot produces it (repo terms) |
| --- | --- | --- |
| Stack by Market Making | $5,000+ in Average Useful TVL on a pair during the phase after enrolling. Score = Average Useful TVL x Average Maker Score x Uptime. 67% sBTC/USDCx, 33% STX/USDCx | The loop: a geometric curve centered on the active bin, rebuilt when the active bin drifts past `CURVE_REPOSITION_DRIFT_BINS` |
| The Daily Stack | One confirmed swap of $25 or more routed through any HODLMM pool for the pair, per UTC day; no sign-up | The M5 hard-cap de-risk swap (fires when `f` breaches `F_HARD`, needs `ENABLE_SWAP=true`, the default), or the Manual CLI, live only: `EXECUTION_MODE=live node dist/index.js --pool <pool> --swap --sell base --amount <micro-units>` |
| Stack by Trading | Credited volume after enrollment (the higher of input and output in USD per finalized swap), $10,000 in the phase to qualify | The same swaps. De-risk is occasional and throttled by `DERISK_MAX_FRACTION`, so reaching $10,000 takes deliberate Manual CLI swaps |

Three things to keep straight: the loop does not schedule swaps, so a Daily Stack entry every day means either a de-risk trigger or one Manual CLI swap a day, run only on the user's say with the amount they name; Manual actions are not gated by the kill switch; both swap tracks credit the wallet that swaps, so it must be the enrolled account. Full page copy in `references/campaign-rules.md`.

## Three situations you will meet, and what changes in each

Work out which one the user is in from their first message, say it back to them in one line, and take the matching path. These are the three cases the skill is tested against.

| Situation | How it sounds | What changes |
| --- | --- | --- |
| **First-timer, one pool** ("I've never run a bot", "just the STX pool for now", names one wallet) | Nervous, one pool, no addresses yet | Run Steps 1 to 9 in full for that one pool. Explain each step before doing it. At Step 3 put both paths to them plainly; a first-timer often takes path A, but it is their call. Say plainly that the other pool can be added later with a second account, and do not set it up unasked. |
| **Both pools, addresses in hand** ("here are my two addresses", "set up both", knows their wallet) | Confident, two `SP` addresses pasted, wants speed | Step 1 is answered, and so is Step 3: they are on path B with accounts already made, so Step 3 is only the account numbers. Everything from Step 3 on runs twice, once per pool, each with its own env file, key, enrollment and terminal. Balances and dry runs are read back per pool. Keys still go through `print_key_command.sh` with each account's number and `set_signer_key.sh` per pool. |
| **Not technical, wants nothing to do with keys** ("just set it up for me", "tell me where to send the money", "I don't want to touch seed phrases") | Asks for the outcome, not the steps | Still put both paths to them at Step 3; they will almost always take path A. Then the only things they do are send funds to the address, back up the recovery file, accept the terms, and say go. Never send them to a terminal. |
| **Something broke mid-way** ("mismatch", "refusing to sign", "hold", "frozen", a pasted error line) | An error message, often a copy of the log | Do not restart from Step 1. Go to Troubleshooting, name the cause in one sentence, state that the bot sent nothing (it fails safe), give the fix, and re-run only the step that failed. For `SIGNER_KEY/SIGNER_ADDRESS mismatch` the fix is the account number: keep the funded, enrolled address and re-derive the key. |

A user can move between situations: a first-timer who finishes one pool and asks for the second is now in the second row; anyone who hits an error is in the third row until it is cleared.

## Talking to the user

Every script prints a labeled block meant to be read as is: a title line naming the address or pool, then indented lines in the campaign page's terms (The Daily Stack, Stack by Trading, Stack by Market Making, Average Useful TVL, Uptime) or the repo's (`d_bps`, `F_HARD`, `DECISION`). Show the block, then add one short read-back in this shape, nothing more:

- **Did:** the one thing you ran, in plain words ("checked the balances on the STX pool account").
- **Saw:** the one or two numbers or words that matter ("1.16 STX, no USDCx").
- **Means:** the consequence for the next step ("the bot cannot deploy yet; both sides of the pair are needed").
- **Need from you:** the single action, or "nothing, moving on".

Keep each line under twenty words. Never paste raw JSON or the full bot log; `dry_run.sh` already trims the log and adds a summary. Never show the user a private key, an env file, or a command that contains a key. Dates in script output are UTC because the campaign runs on UTC days; say so once if the user asks.

## 1. Choose pools

Ask which pool: sBTC/USDCx, STX/USDCx, or both. Explain in one line that both means two accounts. Keep the answer as a list of `sbtc` and/or `stx`; every step below runs once per pool in that list.

## 2. Install the repo

Needs on the machine: Node.js 20 or newer (`node -v`), git, curl and python3 (the scripts use them for the API reads). Nothing is installed into the bot repo; the account and enrollment scripts install `@stacks/wallet-sdk` and `@stacks/encryption` once into `~/.stack-sats-mm-tools` (override with `MM_TOOLS`).

Run `scripts/install.sh`. It clones https://github.com/BitflowFinance/bitflow-market-maker-public into `$MM_REPO` (default `~/bitflow-market-maker-public`) if it is not there yet, then `npm install`, `npm run typecheck` and `npm test`. Re-running it on an existing clone verifies rather than re-clones. Read the README in full once it is down.

Expect `Tests 130 passed` (count at commit c629b76). `npm install` prints audit findings; they are in dependencies, and the README says not to run `npm audit fix --force`, so tell the user that and move on.

## 3. Choose how the bot gets its account (user chooses)

The bot signs from its own account, one per pool, and its key has to be in the pool's env file. There are two ways to get there. Put both to the user in these words, side by side, and let them pick. Do not pick for them, and do not call either one the default.

- **A. Let me create a new account for the bot.** A script on this machine makes a brand-new Stacks account, writes its key straight into the env file, saves its 24-word recovery phrase to a file for you to back up, and shows you only the address. You send funds to that address from whatever wallet you like. Nothing to derive, nothing to paste, no wallet screens. Good if you would rather not touch keys at all.
- **B. Use an account from your own wallet.** You create a fresh account in Xverse or Leather, give me its address, and later run one command that turns your seed phrase into that account's key, which you paste into a file I open for you. Good if you want the bot's account inside the wallet you already use, and you are comfortable running one command.

Both end in the same place: an address the bot signs from, funded by the user, enrolled, with the key in the env file and never in this chat.

### 3A. Create a new account for the bot

```bash
scripts/create_bot_account.sh <pool>
```

Done when it prints `ok:` with the address. Read the address back to the user, then say: "The recovery phrase for this account is in `.env.<pool>.recovery` inside the bot folder. Copy those 24 words somewhere safe now, the way you would for any wallet; anyone with them controls the funds. Once it is backed up you may delete that file." The script refuses to run twice for the same pool, so it cannot overwrite a key. Step 5 is already done for this pool.

### 3B. Use an account from the user's wallet

Ask which wallet they use, then give that wallet's steps and link its own help page so they can check the screens themselves. Note the account's position in the list: that is the account number step 5 needs.

- **Xverse:** tap the account name at the top of the home screen, scroll to the bottom of the Accounts list, tap **+ Create new account**. Open the new account, tap **Receive**, choose **Stacks**, and copy the address under the QR code. Xverse help: [Generate a new account](https://support.xverse.app/hc/en-us/articles/8713443281037).
- **Leather:** open the account switcher, choose **Create new account**. Select it, then copy the **Stacks** address shown for that account (Leather lists a Bitcoin and a Stacks address per account; the bot needs the one starting with `SP`). Leather help: [Add or restore accounts](https://app.leather.io/support/add-or-restore-accounts).

Say: "Paste me the SP address and tell me the account's number in the list."

```bash
scripts/set_signer_address.sh <pool> <SP_ADDRESS>
```

Done when the script prints `ok:`. Keep the account number the user gave you; step 5 needs it.

## 4. Fund each account (user)

Tell the user what each account needs: the sBTC pool account gets STX, sBTC and USDCx; the STX pool account gets STX and USDCx only (STX is both gas and inventory there). How much is their decision; the README's Prerequisites 4 and 5 describe the fees and the gas reserve the bot keeps back. Ask them to send from whatever wallet holds their funds (on path A the address is the one `create_bot_account.sh` printed), then:

```bash
scripts/check_balances.sh <SP_ADDRESS>
```

Done when every token the pool needs shows nonzero.

## 5. Put each account's key in its env file

**Path A:** nothing to do; `create_bot_account.sh` wrote the key at step 3. Skip to step 6.

**Path B (user):** neither wallet exports a per-account private key: Xverse states it in [Can I export my private key?](https://support.xverse.app/hc/en-us/articles/25962076897805), and Leather's "Secret Key" is the seed phrase itself ([View your Secret Key](https://app.leather.io/support/view-secret-key)). So the key is derived from the seed phrase with a command, and the README's command only produces the first account's key under that seed. The user's bot account is almost never the first, so use the script that fills in the account number:

```bash
scripts/print_key_command.sh <account number>
```

Tell the user to run the printed command in a terminal you are not watching (wifi off if they want to be careful), and to keep its output ready. Then:

```bash
scripts/set_signer_key.sh <pool>
```

Say: "A window opens on the env file with the cursor at `SIGNER_KEY=`. Paste the key after the equals sign, save, and close the window." The script waits, then checks that the key derives to this pool's address. Done when it prints `ok:`. A mismatch means the account number was wrong: go back to `print_key_command.sh` with the right one.

## 6. Dry-run each pool

```bash
scripts/dry_run.sh <pool>
```

Done when the output ends with `dry_run: plan logged, no transactions sent` and the `wallet` line shows the pool's tokens. Two decisions are normal and worth explaining to the user: `rebalance type=derisk` means the first live action will be a small sale of the base token for USDCx (the README's hard-cap de-risk); `hold defensive (divergence ...)` means the pool price is off the reference and the bot waits.

## 7. Enroll each account (user accepts the terms)

Enrollment is one signed message per account; only activity after it counts for Stack by Trading and Stack by Market Making, which is why it comes before the first live tick. Two ways, and the user picks; the script route works for both paths.

**By script (no wallet screen).** Send the user to https://app.bitflow.finance/stack-sats to read the campaign terms (the "Full terms" link on the page). When they say they accept, and only then:

```bash
scripts/enroll.sh <pool> --terms-accepted
```

It signs the campaign's enrollment message with the account's key inside node, never printing it, and posts it to the campaign API. Done when it prints `ok: <address> enrolled at <time> UTC`. Running it again is harmless.

**On the campaign page (path B, or anyone who prefers the wallet).** Say: "Select the <pool> account in your wallet. Open https://app.bitflow.finance/stack-sats, accept the terms, tap the Wallet button at the top right; if another address shows, disconnect and choose your wallet under Stacks Chain. Open Stack by Market Making and tap **Sign Transaction to Enroll**. Your wallet shows a Sign Message prompt naming this account's address; press Sign. It is a signature, not a transaction; no gas." Then:

```bash
scripts/check_enrollment.sh <SP_ADDRESS>
```

Done when it prints `ENROLLED ... since <time> UTC`. `NOT ENROLLED` means the signature was cancelled or another account was connected; check the Wallet button and sign again.

## 8. Go live, one pool at a time (user confirms each)

Walk the README's Pre-flight checklist with the user for this pool. With their explicit go:

```bash
cd "$MM_REPO" && EXECUTION_MODE=live node dist/index.js --once --pool <pool>
scripts/list_txs.sh <SP_ADDRESS>
```

Done when startup logged `signer key/address check passed` and `list_txs.sh` shows the tick's transactions as `success`. Then switch that pool's file to live and start its loop in its own terminal:

```bash
sed -i '' 's/^EXECUTION_MODE=.*/EXECUTION_MODE=live/' "$MM_REPO/.env.<pool>" && node dist/index.js --pool <pool>
```

Repeat for the other pool.

## 9. Watch it

Health: `curl -s localhost:8081/health` (sbtc) and `localhost:8082/health` (stx). Freeze a loop at its next tick with `touch "$MM_REPO/KILL_<pool>"`, delete the file to resume. Campaign side, any time:

```bash
scripts/campaign_reading.sh <SP_ADDRESS>
```

Snapshots land roughly hourly at random minutes. `qualified` turns true once the pair's Average Useful TVL reaches $5,000. When the user asks how rewards are computed, who can earn, or how they get paid, read `references/campaign-rules.md`; it quotes the campaign page.

## Scripts

| Script | Input | What it does |
|---|---|---|
| `install.sh` | none (`MM_REPO` optional) | clones the repo if absent, `npm install`, type-check, tests; re-run safe |
| `create_bot_account.sh` | pool | path A: makes a new account, key into the env file, 24-word recovery phrase into `.env.<pool>.recovery` (both mode 600), prints only the address; refuses to overwrite |
| `set_signer_address.sh` | pool, address | creates the pool's env file from the example if needed, writes the address and kill-switch path, mode 600 |
| `check_balances.sh` | address | STX, sBTC, USDCx balances in human units |
| `print_key_command.sh` | account number | the key derivation command with N filled in |
| `set_signer_key.sh` | pool | opens the env file at `SIGNER_KEY=`, waits for save-and-close, verifies silently |
| `dry_run.sh` | pool | one dry-run tick, only the lines that matter |
| `enroll.sh` | pool, `--terms-accepted` | signs the enrollment message with the env file's key inside node and posts it to the campaign API; run only after the user accepts the terms; idempotent |
| `check_enrollment.sh` | address | enrolled true/false and timestamp |
| `list_txs.sh` | address, n | last n transactions with status |
| `campaign_reading.sh` | address | entries, credited volume, maker numbers per pair |
