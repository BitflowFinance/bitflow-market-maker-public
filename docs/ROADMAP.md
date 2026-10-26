# Roadmap

Ideas we have agreed to build later. Not scheduled yet.

## Follow the price into the next pool

**What:** Bitflow runs more than one pool for the same pair (for example several sBTC / USDCx pools), each covering a different price band. When the price reaches the edge of the bins in the pool a bot is using, the bot should move its liquidity to the sBTC / USDCx pool that covers the next band, instead of sitting out of range.

**Why:** Today a bot is tied to one pool contract (`POOL_ID`). If the price leaves that pool's band, the bot holds one-sided inventory and earns nothing until the price comes back.

**Rough shape:**

- A list of pools per pair with their price bands, instead of one pool id per profile in `src/console/profiles.ts` and `.env.<pool>`.
- A trigger: the active bin is within N bins of the pool's edge (or past it) for M checks in a row, so a single wick does not cause a move.
- The move: withdraw from the current pool, then add to the next pool, using the existing withdraw and add paths, so dry run, pause, and the safety halts still apply.
- The page shows which pool the bot is in now and logs each move in Activity.

**Open questions:**

- Where the band data comes from (Bitflow API, or a fixed list in the repo).
- Whether the move should wait for the price to settle in the new band.
- How "Vs. holding" and the profit baseline carry across a move.
- What happens when there is no next pool.

## Bring back bridging

BTC → sBTC bridging works but is switched off to keep the first release simple.

- Server: `BRIDGE_ENABLED` in `src/console/bridgeLive.ts` turns `/api/bridge` back on. The store logic and its tests are still in place.
- Page: `ui/src/BridgeForm.tsx` is kept but not imported. To bring it back, add a Bridge page and nav link in `ui/src/App.tsx`, and the bridge card on the Fund step of `ui/src/CreatePage.tsx`.
- Not built: sBTC → BTC, and USDC ↔ USDCx (needs an Ethereum wallet connection).
