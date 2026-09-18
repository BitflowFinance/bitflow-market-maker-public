# stack-sats-market-maker-skill

Author: TheBigMac.btc  
Github username: MacBotMini-eng

An agent skill for operating the Bitflow market-making starter kit, https://github.com/BitflowFinance/bitflow-market-maker-public, on Stack Sats on Bitflow (https://app.bitflow.finance/stack-sats).

The boundary is: the skill turns the agent into the bot's operator, never into the bot. The repo is the bot. The skill installs it, configures it, gates it, and reads it. The loop runs as its own process and makes every trading decision on its own. The agent never places a trade by its own judgment.

## What it does

1. Installs the repo for the user (`scripts/install.sh`: clone, `npm install`, type-check, tests).
2. Asks how the bot gets its account, and never picks for the user. Path A: creates a fresh account by script, key written straight into the env file, 24-word recovery phrase to a file for the user to back up, only the address shown. Path B: writes the address of an account from the user's own wallet, then opens the env file for the user to paste that account's key and verifies it without printing.
3. Enrolls the account in Stack by Trading and Stack by Market Making by script once the user has accepted the campaign terms, or checks an enrollment the user signed in their wallet.
4. Dry-runs each pool and reads the decision back.
5. Checks enrollment, balances, transactions and the campaign reading.
6. Gates going live behind the README pre-flight list and the user's explicit go, one pool at a time.

## What it never does

Sees or derives a key, goes live without the go, changes the bot's strategy, runs a Manual CLI swap unasked, shows a key or recovery phrase, or drives the user's wallet or browser.

## Layout

- `SKILL.md`: the procedure the agent follows.
- `scripts/`: the deterministic steps (install, config writes, checks).
- `references/campaign-rules.md`: the campaign page's rules and FAQ, quoted verbatim.
- `evals/evals.json`: test prompts and pass/fail checks.
- `AGENTS.md` and `CLAUDE.md`: install paths for Codex and Claude Code, and the boundary; both tools read the open Agent Skills format, so the folder is shared as is.

Track names and rules come from the campaign page; bot mechanics come from the repo README.

## License

MIT, copyright 2026 Bitflow, the same license as the bot repo; see `LICENSE`. The license's as-is clause is the liability disclaimer in legal form; the notice at the top of this file is its plain-language version.

## Disclaimer

> **Mainnet, real funds.** This skill operates a bot that signs transactions with your private key and deploys your tokens into live pools. It is provided as is, without warranty, and has not been independently audited. Nothing in this skill is financial advice, and no outcome is guaranteed. Every value in the env files is a default, not a recommendation. You are responsible for your keys, your positions, and any losses. Start small and read the bot's SECURITY.md and docs/RECOVERY.md before going live.

## Overview

### What this is

The safe way to point an AI agent at Bitflow's market-making bot ([BitflowFinance/bitflow-market-maker-public](https://github.com/BitflowFinance/bitflow-market-maker-public)). The [campaign page](https://app.bitflow.finance/stack-sats) says "Point Claude or your bot of choice at the repo." This skill is what makes that sentence work: it gives Claude Code or Codex a fixed procedure, scripted checks, and hard stops, so the agent sets the bot up the way the README intends and never sees your key.

### Why it exists

The README is written for a person. An agent reading it alone hands you the first-account key command even when your bot account is not the first one, skips the paste-into-file step, and has nothing that stops it from going live on its own. The skill scripts those steps so they cannot be skipped, and gates going live behind the README's pre-flight checklist and your explicit go.

### Who it is for:

#### **1) Beginners:** 
Someone who has never run a bot and does not want to learn the terminal to do it. The agent does the typing; you do the few things only you can do: choose how the bot gets its account (it can create one for you, or you can use your own wallet), fund it, hand over the key if you chose your own wallet, accept the campaign terms, and say go.

#### **2) Experienced:** 
Someone who already runs bots and wants the setup repeatable across both pools and either wallet (Xverse or Leather) without re-reading the README each time.

#### **3) Basically:**
Anyone who wants a written boundary for what the agent is allowed to do with a funded account.

### Who it is not for

Anyone who wants the agent to trade. It will not. The loop in the repo makes every trading decision; the agent only installs, configures, checks, starts, watches and stops it.

### What it covers

One or both campaign pools (sBTC/USDCx and STX/USDCx), one wallet account per pool, from nothing to a running loop, plus reading the bot and the campaign back whenever asked. 

#### All three tracks on the campaign page: 
**Stack by Market Making** through the loop; 
**The Daily Stack** and **Stack by Trading** through the SWAP(s) the bot makes on the way, and manual swaps only on operator's/user's say.

### What the agent never does

See or derive a key, go live without your go, change the bot's strategy or numbers, run a manual swap unasked, create an account except through the Step 3 command you chose, or drive your wallet or browser.
