# Stack Sats Market Maker Runbook

## To the agent reading this

You have been handed this file by the owner of a Stacks wallet who wants to run Bitflow's market-making starter kit (https://github.com/BitflowFinance/bitflow-market-maker-public) on Stack Sats on Bitflow (https://app.bitflow.finance/stack-sats). This runbook is your procedure: the order of operations, the check after each step, and what to do when a check fails. Nothing else needs to be installed; every command is the repo's own, a `curl` against a public API, or a one-line shell edit.

What has been run, and what has not. Steps 1 to 4 and Step 7 have been carried out end to end on mainnet with funded accounts, including creating an account by command and enrolling it. Four branches have NOT been exercised yet and are drafts until someone runs them: pasting a key derived from a wallet seed (Step 5, path B), the dry run (Step 6), the first live tick and the loop (Step 8), and the withdraw path in Stop, halt and exit. Follow them as written, read each result back to the owner rather than assuming it, and tell the owner when a step is one of these four. If you are the first to run one, say what actually happened so the next reader gets a tested step.

Before you run anything:

1. Read this whole file once, then read the repo README in full after Step 2 clones it. The README owns the bot's settings and safety rules; this file owns the sequence.
2. Ask the owner which pool they want (sBTC/USDCx, STX/USDCx, or both) and which wallet they use (Xverse or Leather), and say back in one line which of the three situations under "Three situations the agent will meet" they are in.
3. Explain each step in plain words before you run it. After each command, read the result back in four lines: Did, Saw, Means, Need from you.

At Step 3 you put two ways of getting the bot's account to the owner and let them choose; you never choose for them. On path A a command on this machine creates the account and writes its key into the env file without ever showing it; the owner then only sends funds to the address, backs up the recovery phrase file, accepts the campaign terms, and says go. On path B the owner creates the account in their own wallet, runs one command that turns their seed phrase into the key, pastes it into the env file, and enrolls in their wallet. Either way the owner does the funding, the terms, and the go before each live tick. You never ask for a seed phrase or private key, never print one, never read an env file that holds one, and never set `EXECUTION_MODE=live` without an explicit go. If a key or seed ever appears in this chat, treat it as burned and tell the owner to move the funds to a fresh account.

Documents to keep at hand. Reference them by name when you explain a step, and send the owner to them rather than paraphrasing:

- The bot repo: https://github.com/BitflowFinance/bitflow-market-maker-public (this runbook pins commit `c629b76`; if `git log --oneline -1` after Step 2 shows a later commit, re-read the README before continuing).
- `README.md`: the bot itself. Sections you will use: Prerequisites (Node, funding, fees, the gas reserve), Setup (env files), Running, Manual CLI (live only), Safety, Metrics, Pre-flight (before the first live tick), Key config, Related.
- `AGENTS.md` in the repo: how the code is organized, the multi-pool model (one process per pool, one wallet each, `--pool <name>` picks `.env.<name>`), execution modes, and the BFF API rules the bot follows. Read it when a log line or a config knob is unclear.
- `SECURITY.md`: key handling and the metrics port. The owner should read it before the first live tick; you point them to it at Step 8.
- `docs/RECOVERY.md`: halt and resume, the bot froze itself, stuck transaction, full exit, restart or upgrade. Every fix in the Troubleshooting table that says "see README recovery" means this file.
- `.env.sbtc.example` and `.env.stx.example`: the per-pool templates Step 3 copies; every knob and its default is commented there.
- `LICENSE`: MIT, copyright Bitflow. The bot is provided as is; nothing here is financial advice.
- The campaign page: https://app.bitflow.finance/stack-sats. Track names, rules and FAQ come from here verbatim (The Daily Stack, Stack by Trading, Stack by Market Making, Average Useful TVL, Average Maker Score, Uptime).
- The campaign API, `https://app.bitflow.finance/api/campaign-proxy/campaign/<address>`, for enrollment and standing, and the Hiro API, `https://api.hiro.so/extended/v1/address/<address>/...`, for balances and transactions. Both are public and read-only.

The rest of this file is the runbook.

---

2026-09-18

Author: TheBigMac.btc. Github username: MacBotMini-eng.

## Contents

- To the agent reading this: what you were handed, what to do first, the one rule, the documents to keep open
- Purpose and scope, and the Boundaries table: who holds what, and what you never do
- Preconditions: what must be true before Step 1
- Three situations the agent will meet: which path the owner is on
- What the bot covers: all three campaign tracks, and which of them the bot produces
- Setup, Steps 1 to 5: choose pools, install, account (two paths), fund, key
- Verification, Steps 6 and 7: dry run and enrollment
- Go live, Step 8: the pre-flight list, one live tick, then the loop
- Operate, Step 9: reading the bot and the campaign back
- Stop, halt and exit: the three ways to stop, gentlest first
- Troubleshooting: symptom, cause, fix

## Purpose and scope

This runbook takes one Stacks wallet from nothing to a running market-making bot on one or both Stack Sats on Bitflow pairs, sBTC/USDCx and STX/USDCx, using the public starter kit at BitflowFinance/bitflow-market-maker-public. It is written for an AI agent driving the terminal with the wallet owner at the keyboard, and it needs nothing installed beyond the kit itself: every command below is the repo's own, a `curl` against a public API, or a one-line shell edit. The README stays the reference for the bot itself; this runbook is the order of operations, the checks between steps, and what to do when a check fails.

The agent runs the commands. The owner chooses at Step 3 how the bot gets its account, and then does the things the agent must never do:

- Choose path A (a command creates a new account for the bot) or path B (an account from the owner's own wallet). The agent asks; it does not pick.
- Send the funds.
- Path A: back up the 24-word recovery phrase file. Path B: create the account in the wallet, run the key command, paste the key into the env file.
- Accept the campaign terms, and on path B sign the enrollment in the wallet.
- Say the word before the first live tick, per pool.

The agent never asks for a private key or recovery phrase, never prints one, never reads an env file that holds one (the path A command and the enrollment command read it inside node and print only an address or a status), and never sets `EXECUTION_MODE=live` without that explicit go. A key that lands in chat, a note or a screenshot is treated as burned: move the funds to a fresh account and restart from the address step.

### Boundaries

The agent is the bot's operator, never the bot. The repo is the bot: its loop reads the pool, decides, signs and broadcasts on its own, as a separate process in its own terminal. The agent installs it, configures it, gates it, starts it, watches it and stops it, and never decides a trade, an amount, a price or a bin.

| Who | Holds | Never does |
| --- | --- | --- |
| The owner | The choice of path A or B, the recovery phrase and every private key, the funds and their amounts, acceptance of the campaign terms, the go before each live tick and each Manual CLI swap | Pastes a key or recovery phrase into chat |
| The agent | The order of steps, the config writes (address, kill-switch path, mode), every check, starting and stopping the loop, reading results back in plain words | Sees, prints or derives a key; sets `EXECUTION_MODE=live` without the go; changes the bot's strategy or numbers; runs a Manual CLI swap unasked; creates an account except by the path A command, which prints the address and nothing else; drives the wallet or browser |
| The bot | Trading logic, curve shape, de-risk, safety halts, signing and broadcasting, nonce handling, metrics | Anything outside its env file and CLI flags |

Hand-offs, in order: the agent installs and configures; on path A it creates the bot's account by command and, once the owner has accepted the terms, enrolls it by command; on path B it hands the key step to the owner at Step 5 and enrollment to the owner's wallet; on the owner's go, hands execution to the bot process. From then on the agent reads the bot and does not steer it. Strategy knobs (`F_STAR`, `CURVE_*`, `MAX_POSITION_USTX` and the rest) are the owner's decision, applied by editing the env file and restarting the loop.

## Preconditions

Everything below must be true before Step 1. A missing item is a stop, not a note.

| Item | Requirement | How to check |
| --- | --- | --- |
| Node.js | 20 or newer | `node -v` |
| Starter kit | Cloned, `npm install`, `npm run typecheck` clean, `npm test` reports 130 passed | `git log --oneline -1` shows the commit; test output |
| Repo path | `MM_REPO` set in the shell to the clone's path (the README's default is `~/bitflow-market-maker-public`); every command below uses it | `echo $MM_REPO` |
| Wallet | Xverse or Leather installed, seed backed up, owner at the keyboard | Owner confirms |
| Pool choice | `sbtc` (sBTC/USDCx), `stx` (STX/USDCx), or both | Owner states it |
| Campaign page | https://app.bitflow.finance/stack-sats reachable, terms accepted once | Owner opens it |

### Three situations the agent will meet

The agent works out which case the owner is in from their first message, says it back in one line, and takes the matching path.

| Situation | How it sounds | What changes |
| --- | --- | --- |
| **First-timer, one pool** | "I've never run a bot", "just the STX pool for now", names one wallet, no addresses yet | Steps 1 to 9 in full for that one pool, each step explained before it runs. At Step 3 both paths are put to them plainly; a first-timer often takes path A, but it is their call. The other pool can be added later with a second account; it is not set up unasked. |
| **Both pools, addresses in hand** | Two `SP` addresses pasted, "set up both", knows their wallet | Step 1 is answered, and so is Step 3: they are on path B with accounts already made, so Step 3 is only the account numbers. Everything from Step 3 on runs twice, once per pool, each with its own env file, key, enrollment and terminal. |
| **Not technical, wants nothing to do with keys** | "just set it up for me", "tell me where to send the money", "I don't want to touch seed phrases" | Both paths are still put to them at Step 3; they will almost always take path A. Then the only things they do are send funds to the address, back up the recovery file, accept the terms, and say go. They are never sent to a terminal. |
| **Something broke mid-way** | "mismatch", "refusing to sign", "hold", "frozen", a pasted log line | No restart from Step 1. Troubleshooting: name the cause, state that the bot sent nothing, give the fix, re-run only the failed step. For the key mismatch the fix is the account number: keep the funded, enrolled address and re-derive the key. |

An owner can move between rows: a first-timer who finishes one pool and asks for the second is now in the second row; anyone who hits an error is in the third until it clears.

Campaign rules that shape every later decision, from the live page and the campaign API:

- One process per pool, each with its own wallet account, its own key and its own env file. Two pools means two accounts.
- Stack by Market Making pays per pair. A wallet qualifies at $5,000+ in Average Useful TVL on the pair during the phase after enrolling. Below that it is scored and not paid.
- Only activity after the enrollment timestamp counts for Stack by Trading and Stack by Market Making. Enroll before the first live tick. The Daily Stack needs no enrollment.
- Snapshots are taken several times daily at randomized minutes. Uptime counts every phase snapshot, including those before enrollment.
- Useful means near the active price: within 1% counts in full, further out gets a haircut, beyond 15% counts zero.
- Endowment wallets and separately compensated market makers earn nothing. Ask Bitflow before committing capital if that might apply.

## What the bot covers: all three tracks

The campaign page puts it as "Three ways to win. Pick your lane or take all three." One bot, one account, takes all three, because every action it takes is routed through a HODLMM pool for sBTC/USDCx or STX/USDCx. Stack by Market Making is its job; the swaps it makes on the way are what The Daily Stack and Stack by Trading count. The three cards, in the page's words:

- **The Daily Stack:** 41,666 sats × 5 winners, daily. 0.05 BTC pot. "One $25+ swap a day is your ticket. Entries stack until you win."
- **Stack by Trading:** up to 15,000,000 sats / phase. 0.15 BTC pot. "Your volume is your share. No leaderboard. No cap."
- **Stack by Market Making:** 30,000,000 sats / phase. 0.3 BTC pot. Agent Starter Kit. "Tight liquidity near the price out-earns parked TVL. Skill pays."

| Track | What counts, in the page's words | How the bot produces it, in the repo's words | Set by |
| --- | --- | --- | --- |
| Stack by Market Making | Reach $5,000+ in Average Useful TVL on a pair during the phase after enrolling. Score = Average Useful TVL × Average Maker Score × Uptime. Each pair pays its own pot: 67% sBTC/USDCx, 33% STX/USDCx | The loop: every deploy is a geometric curve centered on the active bin; it holds while the active bin stays in range and rebuilds the curve when the active bin drifts past `CURVE_REPOSITION_DRIFT_BINS` | Steps 3 to 9 |
| The Daily Stack | One confirmed swap of $25 or more routed through any HODLMM pool for sBTC/USDCx or STX/USDCx, per UTC day. Extra swaps the same day don't add entries. No sign-up; a qualifying swap auto-enters you | A swap through `dlmm-swap-router-v-1-2`: the M5 hard-cap de-risk (when `f` breaches `F_HARD`, sell base to quote toward `F_SOFT`, requires `ENABLE_SWAP=true`), or the Manual CLI, live only: `EXECUTION_MODE=live node dist/index.js --pool <pool> --swap --sell base --amount <micro-units>` | `ENABLE_SWAP` (default `true`); the Manual CLI |
| Stack by Trading | For each finalized swap after enrollment, the higher of executed input and output in USD is credited. You qualify when your credited volume reaches $10,000 during the phase; the pot unlocks as volume grows through eligible pools, from $35M up to $64M | The same swaps. M5 de-risk fires only on a breach and is throttled by `DERISK_MAX_FRACTION`, so a market-making book alone rarely reaches $10,000 credited volume; deliberate Manual CLI swaps do | The Manual CLI, per swap |

Three facts to keep straight when the owner asks:

- The loop does not schedule swaps. A Daily Stack entry every day needs either enough price movement to trigger de-risk or one manual qualifying swap a day of $25 or more. The agent runs that command only on the owner's say, per swap, with the amount the owner names.
- Manual commands run live only and are not gated by the kill switch. A halted loop does not stop a manual swap.
- Both tracks credit the wallet that swaps, so the swap must come from the enrolled account. The Daily Stack needs no enrollment; Stack by Trading credits volume only after the enrollment timestamp.

Setting `ENABLE_SWAP=false` in the env file turns the automatic de-risk off; the loop then holds the inventory it has and parks nothing off the active bin.

## Setup: Steps 1 to 5

Run the steps in order, once per pool. Each step names who acts and what output ends it. Copy this checklist into your reply and tick each line as you finish it; a second pool repeats Steps 3 to 8 with its own account, env file and terminal.

```
Setup progress, <pool> pool:
- [ ] Step 1: pools chosen (sbtc, stx, or both)
- [ ] Step 2: kit installed, 130 tests passing, README read
- [ ] Step 3: account in place (path A created by command, or path B from the owner's wallet)
- [ ] Step 4: funded, both sides of the pair present, gas above the reserve
- [ ] Step 5: key in the env file (path A: already done at Step 3)
- [ ] Step 6: dry run ends "plan logged, no transactions sent"
- [ ] Step 7: enrolled, timestamp read back
- [ ] Step 8: pre-flight walked, owner said go, one live tick confirmed on chain, loop started
- [ ] Step 9: watching; bot health and campaign standing read back to the owner
```

The owner chooses at 3, funds at 4, pastes a key at 5 on path B only, and accepts the terms at 7; the agent runs everything else and checks after each owner step.

**Step 1. Choose pools (owner).** Ask: `sbtc`, `stx`, or both. Record the answer. Each pool below repeats Steps 3 to 8 with its own account.

**Step 2. Install (agent).** Clone, install, type-check, test. Read the README in full once. Done when `npm test` prints Tests 130 passed and the type-check is clean. The `npm install` audit list is expected; the README says not to run `npm audit fix --force`.

```bash
export MM_REPO=~/bitflow-market-maker-public
git clone https://github.com/BitflowFinance/bitflow-market-maker-public.git "$MM_REPO"
cd "$MM_REPO" && npm install && npm run typecheck && npm test
```

**Step 3. One account per pool (owner chooses how).** The bot signs from its own account, one per pool, and its key has to be in the pool's env file. Put both ways of getting there to the owner, side by side, in these words, and let them pick. Do not pick for them, and do not call either one the default.

- **A. Let me create a new account for the bot.** A command on this machine makes a brand-new Stacks account, writes its key straight into the env file, saves its 24-word recovery phrase to a file for you to back up, and shows you only the address. You send funds to that address from whatever wallet you like. Nothing to derive, nothing to paste, no wallet screens. Good if you would rather not touch keys at all.
- **B. Use an account from your own wallet.** You create a fresh account in Xverse or Leather, give me its address, and later run one command that turns your seed phrase into that account's key, which you paste into a file I open for you. Good if you want the bot's account inside the wallet you already use, and you are comfortable running one command.

Both paths start by creating the pool's env file from the repo's example:

```bash
cd "$MM_REPO" && cp -n .env.<pool>.example .env.<pool> && chmod 600 .env.<pool>
echo "KILL_SWITCH_FILE=$MM_REPO/KILL_<pool>" >> .env.<pool>
```

**Path A.** The account and enrollment commands need two Stacks libraries. Install them once, outside the bot repo:

```bash
mkdir -p ~/.stack-sats-mm-tools && cd ~/.stack-sats-mm-tools && printf '{"name":"stack-sats-mm-tools","private":true,"version":"1.0.0"}\n' > package.json && npm install --silent @stacks/wallet-sdk@6 @stacks/encryption@6
```

Then, still in that folder, create the account. It refuses to run if the pool already has a key, so it cannot overwrite one:

```bash
POOL=<pool> node -e "const fs=require('fs'),w=require('@stacks/wallet-sdk'),t=require('@stacks/transactions');const f=process.env.MM_REPO+'/.env.'+process.env.POOL,r=f+'.recovery';const cur=fs.readFileSync(f,'utf8');if(/^SIGNER_KEY=.+/m.test(cur)||fs.existsSync(r))throw Error('this pool already has a key or a recovery file; not overwriting');const p=w.generateSecretKey(256);w.generateWallet({secretKey:p,password:''}).then(x=>{const a=x.accounts[0],addr=w.getStxAddress({account:a,transactionVersion:t.TransactionVersion.Mainnet});let e=cur;const s=(k,v)=>{const re=new RegExp('^'+k+'=.*$','m');e=re.test(e)?e.replace(re,k+'='+v):e.replace(/\n?$/,'\n')+k+'='+v+'\n'};s('SIGNER_ADDRESS',addr);s('SIGNER_KEY',a.stxPrivateKey);fs.writeFileSync(f,e,{mode:0o600});fs.writeFileSync(r,'Stack Sats bot account ('+process.env.POOL+' pool)\nAddress: '+addr+'\nRecovery phrase (24 words). Anyone with these words controls the funds. Back this up, then you may delete this file.\n\n'+p+'\n',{mode:0o600});console.log('address '+addr)})"
```

Done when it prints `address SP...`. Read the address back to the owner, then say: "The recovery phrase for this account is in `.env.<pool>.recovery` inside the bot folder. Copy those 24 words somewhere safe now, the way you would for any wallet; anyone with them controls the funds. Once it is backed up you may delete that file." Step 5 is already done for this pool.

**Path B.** Ask which wallet, then give that wallet's steps and its own help page. The account must hold nothing but what the bot will use. Note its position in the account list: that is the account number Step 5 needs.

- **Xverse:** tap the account name at the top, scroll to the bottom of the Accounts list, tap `+ Create new account`. Open it, tap Receive, choose Stacks, copy the address under the QR code. Help: [Generate a new account](https://support.xverse.app/hc/en-us/articles/8713443281037).
- **Leather:** open the account switcher, choose Create new account, select it, copy its Stacks address (the one starting with `SP`; Leather also shows a Bitcoin address per account). Help: [Add or restore accounts](https://app.leather.io/support/add-or-restore-accounts).

Then write the address into the env file:

```bash
sed -i '' 's/^SIGNER_ADDRESS=.*/SIGNER_ADDRESS=<SP address>/' "$MM_REPO/.env.<pool>"
grep -E '^(EXECUTION_MODE|SIGNER_ADDRESS|KILL_SWITCH_FILE)=' "$MM_REPO/.env.<pool>"
```

Done when the last command shows `EXECUTION_MODE=dry_run`, the address, and the kill-switch path.

**Step 4. Fund (owner).** The `sbtc` account needs sBTC and USDCx plus STX for gas. The `stx` account needs STX and USDCx; there STX is both gas and inventory. The bot keeps 5 STX back as a gas reserve and never deploys it, so fund above that. Arrive with both sides of the pair: a one-sided wallet makes the bot's first live action a de-risk sale, not a deploy. On path A the address is the one the create command printed; the owner sends from whatever wallet holds their funds. The agent reads the balances from the Hiro API and says back what is present and missing. Amounts are the owner's decision; the agent never picks a number.

```bash
curl -s https://api.hiro.so/extended/v1/address/<address>/balances
```

`stx.balance` is in micro-STX (divide by 1,000,000). Under `fungible_tokens`, the key ending `::sbtc-token` is in sats (divide by 100,000,000) and the key ending `::usdcx-token` is in micro-USDCx (divide by 1,000,000).

**Step 5. Key (path B only; owner).** Path A: nothing to do, the key was written at Step 3; skip to Step 6. Path B: neither wallet exports a per-account private key: Xverse says so in [Can I export my private key?](https://support.xverse.app/hc/en-us/articles/25962076897805), and Leather's "Secret Key" is the seed phrase itself ([View your Secret Key](https://app.leather.io/support/view-secret-key)). So the key is derived from the seed phrase with a command. The README's command derives only the first account under the seed; the version below takes the account number from Step 3 as N. The agent hands the owner this command with N filled in and never sees the seed or the output:

```bash
npm install --no-save @stacks/wallet-sdk
SEED="<your seed phrase>" N=<account number> node -e "const s=require('@stacks/wallet-sdk'); s.generateWallet({secretKey: process.env.SEED, password: ''}).then(w => { const i=Number(process.env.N)-1; while (w.accounts.length <= i) w = s.generateNewAccount(w); console.log(w.accounts[i].stxPrivateKey) })"
```

The owner runs it in a terminal the agent is not reading (wifi off if they want to be careful), keeps the output on the clipboard, and clears shell history. The agent then opens the env file at the key line for the owner to paste, save and close, and does not read the file afterwards:

```bash
nano +$(grep -n '^SIGNER_KEY=' "$MM_REPO/.env.<pool>" | cut -d: -f1) "$MM_REPO/.env.<pool>" && chmod 600 "$MM_REPO/.env.<pool>"
```

Verify with the bot's own derivation. The bot checks the key against the address only in live mode, so a dry-run tick proves nothing; this runs the same check (`getAddressFromPrivateKey` from the repo's `@stacks/transactions`) and prints one word:

```bash
cd "$MM_REPO" && node -e "const fs=require('fs');const {getAddressFromPrivateKey,TransactionVersion}=require('@stacks/transactions');const e=Object.fromEntries(fs.readFileSync('.env.<pool>','utf8').split('\\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim()]}));let d;try{d=getAddressFromPrivateKey(e.SIGNER_KEY,TransactionVersion.Mainnet)}catch(x){console.log('invalid');process.exit()}console.log(d===e.SIGNER_ADDRESS?'match':'mismatch')"
```

Done when it prints `match`. `mismatch` means the account number was wrong: back to the key command with the right N. `invalid` means stray characters in the paste (a `0x` prefix, quotes, a line break). The command reads the file inside node and prints nothing else.

## Verification: Steps 6 and 7

Nothing goes live until both of these read clean for the pool.

**Step 6. Dry run (agent).** Run `cd "$MM_REPO" && npm run tick -- --pool <pool>`. The bot reads the live pool and the wallet, decides what it would do, and logs the plan without signing. Read three lines back to the owner:

| Line | Healthy reading | Unhealthy reading |
| --- | --- | --- |
| `ref price ... d_bps=` | Below `DIVERGENCE_WARN_BPS` for the pair file | At or past it, or a `broken_market` halt: the pool and the CoinGecko reference disagree |
| `wallet ...` | Both tokens of the pair present, and the `active_bin` line shows a price | One side zero: `f` sits above `F_HARD` and the plan is an M5 de-risk swap |
| `DECISION=` | `hold`, or `rebalance type=reposition` (a shaped add of the curve on the active bin) | `rebalance type=derisk` from a one-sided wallet, `frozen`, or an error |

The run must end with `dry_run: plan logged, no transactions sent`. Any other ending is a stop. After funding changes, run it again; the wallet line and the decision both move.

**Step 7. Enroll (owner accepts the terms).** Enrollment is one signed message per account; only activity after it counts for Stack by Trading and Stack by Market Making. Two ways, and the owner picks; the command route works for both paths.

By command, no wallet screen: send the owner to https://app.bitflow.finance/stack-sats to read the campaign terms (the "Full terms" link). When they say they accept, and only then, from the tools folder:

```bash
cd ~/.stack-sats-mm-tools
POOL=<pool> node -e "const fs=require('fs'),t=require('@stacks/transactions'),enc=require('@stacks/encryption');const e=Object.fromEntries(fs.readFileSync(process.env.MM_REPO+'/.env.'+process.env.POOL,'utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim()]}));const key=e.SIGNER_KEY,addr=e.SIGNER_ADDRESS;if(t.getAddressFromPrivateKey(key,t.TransactionVersion.Mainnet)!==addr)throw Error('key does not match SIGNER_ADDRESS');const pub=t.publicKeyToString(t.compressPublicKey(t.pubKeyfromPrivKey(key).data));const message='Stack Sats on Bitflow 2026. Address: '+addr+'. Terms: 2026-09-v1. Enroll.';const sig=t.signMessageHashRsv({messageHash:Buffer.from(enc.hashMessage(message)).toString('hex'),privateKey:t.createStacksPrivateKey(key)}).data;fetch('https://app.bitflow.finance/api/campaign-proxy/enrollments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:addr,message,signature:sig,publicKey:pub,termsVersion:'2026-09-v1'})}).then(async r=>{const b=await r.json().catch(()=>({}));console.log(r.ok?'enrolled '+addr+' '+(b.enrollment?b.enrollment.enrolledAt:''):'failed HTTP '+r.status+' '+(b.error||''))})"
```

It signs the campaign's enrollment message with the account's key inside node, never printing it, and posts it to the campaign API. Done when it prints `enrolled SP... <time>`. Running it again is harmless.

On the campaign page (path B, or anyone who prefers the wallet): select the pool's account in the wallet. Open https://app.bitflow.finance/stack-sats, accept the terms, tap the Wallet button at the top right and, if another address shows, disconnect and reconnect choosing the wallet under Stacks Chain. Open Stack by Market Making and tap `Sign Transaction to Enroll`. The wallet shows a Sign Message prompt naming that account's address: check it, then Sign. It is a signature, not a transaction, so no gas. Either way, the agent then reads the campaign API:

```bash
curl -s https://app.bitflow.finance/api/campaign-proxy/campaign/<address> | python3 -c 'import json,sys; s=json.load(sys.stdin)["summary"]; print("enrolled:", s["enrolled"], s.get("enrolledAt"))'
```

Done when it prints `enrolled: True` with the time. `False` means the signature was cancelled or the page had a different account connected: check the address in the Wallet button and sign again. Only activity after that timestamp is scored.

## Go live: Step 8

One pool at a time, one tick before any loop, and an explicit go from the owner for each pool. Walk the README pre-flight list out loud; any `no` is a stop.

- [ ] `npm test` and `npm run build` pass
- [ ] Dry-run tick clean: `npm run tick -- --pool <pool>` ends with `decision="hold"` or `"rebalance"` plus `dry_run: plan logged`, not `frozen` or an error
- [ ] The tick's `wallet` line shows both tokens and the `active_bin` line shows a price
- [ ] The tick's `ref price` line shows `d_bps` below `DIVERGENCE_WARN_BPS` (80 in `.env.sbtc.example`, 150 in `.env.stx.example`)
- [ ] Wallet STX covers `STX_GAS_RESERVE_USTX` (default 5 STX) plus a few transactions
- [ ] `MAX_POSITION_USTX` set to a small amount for the first run (0 means no cap)
- [ ] `KILL_SWITCH_FILE` set, and the owner knows the path (Step 3 set it to `KILL_<pool>` in the repo folder)
- [ ] `METRICS_HTTP_HOST` is `127.0.0.1` (the default) and the port is not exposed
- [ ] `EXECUTION_MODE=live` and `SIGNER_KEY` set only in the pair env file, nowhere else
- [ ] The account is enrolled (Step 7)
- [ ] The owner has said go for this pool

Then one live tick:

```bash
cd "$MM_REPO" && EXECUTION_MODE=live node dist/index.js --once --pool <pool>
curl -s "https://api.hiro.so/extended/v1/address/<address>/transactions?limit=5"
```

Done when startup logs `signer key/address check passed` and every transaction from the tick reads `success` on chain. Read the transaction ids back to the owner before continuing.

Only then flip the file and start the loop in its own terminal window, which stays open:

```bash
sed -i '' 's/^EXECUTION_MODE=.*/EXECUTION_MODE=live/' "$MM_REPO/.env.<pool>" && node dist/index.js --pool <pool>
```

For a second pool, repeat Steps 3 to 8 with its own account (either path), env file and terminal. The `sbtc` loop serves metrics on port 8081 and the `stx` loop on 8082, so both can run side by side.

## Operate: Step 9

The bot's metrics say what the bot did; the campaign API says what the campaign credited. Read both.

Read every command's output back to the owner in four lines: Did, Saw, Means, Need from you. Times from the APIs are UTC because the campaign runs on UTC days.

| Check | Command | What to look for |
| --- | --- | --- |
| Bot alive | `curl -s localhost:8081/health` (`sbtc`) or `:8082` (`stx`) | A healthy response; `/status` and `/history?n=50` for detail |
| Recent transactions | `curl -s "https://api.hiro.so/extended/v1/address/<address>/transactions?limit=5"` | Every row `success`; a `pending` row older than a few blocks is a stuck nonce, see README recovery |
| Campaign standing | `curl -s https://app.bitflow.finance/api/campaign-proxy/campaign/<address>` | Under `summary.maker`, per pair: `avgUsefulTvlUsd` (Average Useful TVL), `deployedCount` of `snapshotCount`, `uptimePct` (Uptime), `qualified`. Also `giveaway.entries` and `trader.qualifiedVolumeUsd` |
| Balances | `curl -s https://api.hiro.so/extended/v1/address/<address>/balances` | Gas above the 5 STX reserve; both sides of the pair present |

Reading the campaign numbers:

- `qualified` flips to true once Average Useful TVL on the pair reaches $5,000. Below it the wallet is scored and not paid.
- Score = Average Useful TVL × Average Maker Score × Uptime, and the payout is your score against other qualified makers' scores on that pair. Averages ignore snapshots where the wallet was not deployed; Uptime does not.
- Snapshots are taken several times daily at randomized minutes. A handful of them is noise; judge after a day.
- The bot halts itself when the pool price diverges from the reference past the file's halt level or the feed goes stale, and resumes when the reading recovers. By default it leaves bins deployed through a halt.
- Uptime counts every snapshot in the phase. Downtime is never recovered, so a stopped loop costs score for the rest of the phase.

## Stop, halt and exit

Three ways to stop, from gentlest to final. Reach for the first one whenever something looks wrong, before debugging.

1. **Halt in place, no restart.** `touch "$MM_REPO/KILL_<pool>"`. The bot freezes at its next tick and leaves the liquidity where it is. Delete the file to resume. This is the one the owner should know by heart.
2. **Clean shutdown.** `Ctrl+C` in the loop's terminal. `Ctrl+Z` is converted to a clean shutdown too, so a suspended bot cannot freeze mid-tick holding the metrics port. Liquidity stays deployed; the campaign keeps scoring it while it sits near the price.
3. **Full exit.** Withdraw the bins and stop the loop. The README's `docs/RECOVERY.md` covers the withdraw path, stuck transactions and nonce gaps. Confirm every withdraw transaction reads `success` in the Hiro transactions list (the Recent transactions command above) before calling the account empty.

After any stop, the campaign API (the Campaign standing command above) shows whether the pair is still being scored. A halted bot with bins near the price keeps earning uptime; a withdrawn one does not.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `SIGNER_KEY/SIGNER_ADDRESS mismatch ... refusing to sign` | The key is for a different account than the address, usually the README command's first account when the bot account sits lower in the list | Keep the funded, enrolled address. Hand the owner the Step 5 key command with the right account number; they re-derive offline and paste again; re-run the Step 5 verification until it prints `match`. Never repoint the address at whatever the key derives |
| `this pool already has a key or a recovery file` from the path A command | The env file already holds a key, or a recovery file exists from an earlier run | Nothing is overwritten by design. If the owner wants a fresh account, move `.env.<pool>` and `.env.<pool>.recovery` aside first, then run the command again |
| Mismatch right after a paste | Stray characters: `0x` prefix, quotes, a trailing space or line break | Paste the bare hex only; 64 or 66 characters |
| `DECISION=rebalance type=derisk` on a fresh account | One-sided wallet above `F_HARD` | Fund the other side of the pair before going live, then dry-run again |
| `GUARDRAIL low_gas -> hold` | STX below the 5 STX reserve plus the plan's fees | Send STX; the reserve is never deployed |
| `GUARDRAIL pending_tx` or `nonce_gap -> hold` | An earlier transaction is stuck in the mempool | Wait for it to confirm or drop; README `docs/RECOVERY.md` covers RBF bumps and nonce gaps |
| `broken_market` or `operational` halt | Pool price diverged from the reference past the halt level, or the feed went stale | Nothing to do; it clears when the reading recovers. Bins stay deployed unless `BREAKER_WITHDRAW_ALL=true` |
| `pool_inactive -> hold` | The pool is paused or disabled upstream | Wait; check the pool on app.bitflow.finance |
| `NOT ENROLLED` after signing | Signature cancelled, or the page had another account connected | Check the address in the Wallet button, sign again, re-run the enrollment check from Step 7 |
| `qualified False` for days | Average Useful TVL below $5,000 on the pair, or bins sitting beyond 15% from the active price | Add inventory near the price; the average ignores undeployed snapshots but a wide book is haircut |
| Metrics port already in use | A previous loop for the same pool is still running | Find it with `lsof -i :8081` or `:8082`; stop that loop cleanly before starting another. Never kill an unknown process on the port |
| Two loops for the same pool | Two processes signing from one account collide on nonces | Run one process per pool per account; a second pool gets its own account, env file and terminal |
