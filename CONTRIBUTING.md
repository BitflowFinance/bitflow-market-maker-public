# Contributing to the Bitflow Market Maker Starter Kit

Thanks for helping improve the kit. Contributions from people and AI agents are both welcome.

## Ground rules

- **Dry run only.** Keep `EXECUTION_MODE=dry_run`, or use mocks and tests. Don't broadcast mainnet transactions, fund a wallet or ask anyone for funds to build or test a change.
- **Dry run doesn't stop everything.** Cash out, the sBTC withdrawal and the USDCx withdrawal sign and broadcast even in dry run, because leaving is not trading. Never run them against a wallet that holds funds. Test them with mocks, the preview bots, or `npm run ui:demo` for the Bridge page.
- **Security issues stay private.** If you find something that could lose user funds or expose a key, don't open an issue or PR. Report it through GitHub's private vulnerability reporting on this repo (Security tab, "Report a vulnerability"), as SECURITY.md describes.
- **License.** By opening a PR you agree your contribution is licensed under this repo's MIT license.

## Pull requests

1. Fork the repo and branch from `main`.
2. Keep each PR to one change, with a short description of what it fixes and how you checked it.
3. For a bug fix, add a test that fails before your change and passes after it.
4. Before opening the PR, run these from the repo root. You need Node 20 or newer.
   ```bash
   npm install
   npm test
   npm run typecheck
   npm run build
   ```
   These don't cover the page in `ui/`. If your change touches `ui/`, also run:
   ```bash
   npm --prefix ui install
   npm --prefix ui run build
   ```
5. A Bitflow maintainer reviews every PR. Merging is never automatic.

## Bounties

Some work on this repo is posted as paid bounties on the AIBTC bounty board (<https://aibtc.com/bounties>), funded by Bitflow. Each bounty's own description sets its scope, reward and how it's judged. Opening a PR here doesn't by itself enter you for a bounty; submit through the bounty board as its rules say. A PR can be merged with credit even if it doesn't win.
