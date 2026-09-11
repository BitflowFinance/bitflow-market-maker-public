# Security

This bot signs mainnet transactions with a private key you give it. Read this before running it live.

## Keys and wallet

- Use a **dedicated Stacks account** for the bot. Never reuse a wallet that holds anything else.
- `SIGNER_KEY` lives only in your local `.env.<pool>` file. Those files are gitignored; keep them that way. Do not paste the key into issues, logs, chat, or screenshots.
- The bot never sends tokens to any address other than the pool contracts and back to `SIGNER_ADDRESS`. If you see anything else in a transaction preview, stop and report it.
- At startup in live mode the bot refuses to run if `SIGNER_KEY` does not derive to `SIGNER_ADDRESS`.

## Metrics API

The read-only HTTP API (`/health`, `/status`, `/metrics`, `/history`) binds to `127.0.0.1` by default. It exposes your address, balances, positions and tick history. Do not set `METRICS_HTTP_HOST` to `0.0.0.0` or a public IP. If you need remote access, use an SSH tunnel.

## What this bot does not protect against

- A compromised machine. Anyone who can read your env file can spend the wallet.
- Bugs in third-party dependencies or in the on-chain contracts.
- Market risk. Halts and caps limit the bot's actions; they do not limit what the market does to a position that is already deployed.

## Reporting a vulnerability

Please do not open a public issue for a security bug. Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability") if it is enabled. If it is not, open an issue that says only "security report, please provide a contact" and a maintainer will reply with one.
