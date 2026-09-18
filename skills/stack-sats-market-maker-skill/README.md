# stack-sats-market-maker-skill

> **Mainnet, real funds.** This skill operates the bot in this repository. The notice at the top of the root README applies in full: as is, no warranty, not financial advice, you are responsible for your keys, positions and losses.

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
- `AGENTS.md` and `CLAUDE.md`: install paths for Codex and Claude Code, and the boundary; both products read the open Agent Skills format, so the folder is shared as is.

Track names and rules come from the campaign page; bot mechanics come from the repo README.

## License

MIT, under the repository's root `LICENSE`.
