# stack-sats-market-maker-skill

Author: TheBigMac.btc  
Github username: MacBotMini-eng

An agent skill for operating the Bitflow market-making starter kit, https://github.com/BitflowFinance/bitflow-market-maker-public, on Stack Sats on Bitflow (https://app.bitflow.finance/stack-sats).

The boundary is: the skill turns the agent into the bot's operator, never into the bot. The repo is the bot. The skill installs it, configures it, gates it, and reads it. The loop runs as its own process and makes every trading decision on its own. The agent never places a trade by its own judgment.

## What it does

1. Installs the repo for the user (`scripts/install.sh`: clone, `npm install`, type-check, tests).
2. Writes each pool's env file with the user's signer address and a kill-switch path.
3. Hands the private key step to the user: prints the derivation command with the right account number, opens the env file at the `SIGNER_KEY=` line for the paste, verifies without printing.
4. Dry-runs each pool and reads the decision back.
5. Checks enrollment, balances, transactions and the campaign reading.
6. Gates going live behind the README pre-flight list and the user's explicit go, one pool at a time.

## What it never does

Sees or derives a key, goes live without the go, changes the bot's strategy, runs a Manual CLI swap unasked, creates a wallet, or drives the user's wallet or browser.

## Layout

- `SKILL.md`: the procedure the agent follows.
- `scripts/`: the deterministic steps (install, config writes, checks).
- `references/campaign-rules.md`: the campaign page's rules and FAQ, quoted verbatim.
- `evals/evals.json`: test prompts and pass/fail checks.
- `AGENTS.md` and `CLAUDE.md`: install paths for Codex and Claude Code, and the boundary; both tools read the open Agent Skills format, so the folder is shared as is.

Track names and rules come from the campaign page; bot mechanics come from the repo README.

## License

MIT, under the repository's root `LICENSE`.

## Disclaimer

> **Mainnet, real funds.** This skill operates the bot in this repository. The notice at the top of the root README applies in full: as is, no warranty, not financial advice, you are responsible for your keys, positions and losses.

## Overview

### What this is

The safe way to point an AI agent at Bitflow's market-making bot ([BitflowFinance/bitflow-market-maker-public](https://github.com/BitflowFinance/bitflow-market-maker-public)). The [campaign page](https://app.bitflow.finance/stack-sats) says "Point Claude or your bot of choice at the repo." This skill is what makes that sentence work: it gives Claude Code or Codex a fixed procedure, scripted checks, and hard stops, so the agent sets the bot up the way the README intends and never sees your key.

### Why it exists

The README is written for a person. An agent reading it alone hands you the first-account key command even when your bot account is not the first one, skips the paste-into-file step, and has nothing that stops it from going live on its own. The skill scripts those steps so they cannot be skipped, and gates going live behind the README's pre-flight checklist and your explicit go.

### Who it is for:

#### **1) Beginners:** 
Someone who has never run a bot and does not want to learn the terminal to do it. The agent does the typing; you do the five things only you can do: create the account, fund it, derive the key offline, sign the enrollment, and say go.

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

See or derive a key, go live without your go, change the bot's strategy or numbers, run a manual swap unasked, create a wallet, or drive your wallet or browser.
