# Recovery

What the bot does on its own in each situation, and what you do. Every command below assumes the pair you run (`--pool sbtc` or `--pool stx`). Where to look while working through any of these:

```bash
curl localhost:8081/status            # 8082 for the STX pool
tail -f data/metrics.sbtc.jsonl       # per-tick record
```

and your address on a Stacks explorer, for example `https://explorer.hiro.so/address/<SIGNER_ADDRESS>?chain=mainnet`.

## 1. Halt and resume (kill switch)

**Halt:** `touch` the file named in `KILL_SWITCH_FILE`. From the next tick the log shows `GUARDRAIL kill_switch active` and `decision="frozen"`. The bot signs nothing. Your bins stay in the pool exactly as they are.

**Resume:** delete the file. The next tick runs normally. No restart needed.

`KILL_SWITCH=true` in the env file does the same but needs a restart to clear. Manual CLI actions (`--withdraw-liquidity`, `--add-liquidity`, `--swap`) ignore the kill switch by design.

## 2. The bot froze itself

Look for the `GUARDRAIL` line in the log:

| Log | What happened | What the bot does next |
| --- | --- | --- |
| `strategy_halt kind=broken_market` | Pool price diverged from CoinGecko past `DIVERGENCE_HALT_BPS`, or a peg break | Freezes. **Withdraws your bins only if `BREAKER_WITHDRAW_ALL=true`**, otherwise they stay deployed. Resumes on its own when the next reading is back inside the band. |
| `strategy_halt kind=operational` | CoinGecko reading older than `REFERENCE_FEED_HALT_MS` | Same as above. Resumes when a fresh reading arrives. |
| `DECISION=hold defensive` | Divergence past `DIVERGENCE_WARN_BPS` or feed older than `REFERENCE_FEED_MAX_AGE_MS` | Holds existing bins, no reposition. Clears itself. |
| `pool_inactive` | The BFF reports the pool paused | Holds. Clears when the pool is active again. |
| `api_error` / `circuit_breaker TRIPPED` | `MAX_CONSECUTIVE_API_ERRORS` fetch failures in a row | Skips ticks. Clears on the first successful fetch. Withdraws only if `BREAKER_WITHDRAW_ALL=true`. |
| `low_gas` | Wallet STX below the tx fee | Holds until you send STX. |

None of these need a restart. If you would rather not stay deployed while the condition lasts, do a full exit (section 4).

## 3. Stuck transaction

**What the bot does:** after `TX_CONFIRMATION_TIMEOUT_MS` it re-broadcasts the same nonce with a higher fee, up to `TX_MAX_FEE_BUMPS` times and never above `MAX_TX_FEE_USTX`. The log shows `replace-by-fee attempt N`. If that runs out you see `status="timeout"` or `status="timeout_max_fee"`, and every following tick holds with `GUARDRAIL pending_tx` or `GUARDRAIL nonce_gap`.

**What you do:**

1. Open the address in the explorer and find the pending transaction and its nonce.
2. Either wait: it will mine when fees drop, or the network drops it from the mempool after a while. The bot resumes by itself once the address has no pending tx.
3. Or replace it: from a wallet or tool that lets you set the nonce and fee explicitly, send a minimal STX transfer **at the same nonce** with a higher fee **to an address that is not the sender**. When that mines, the stuck tx is gone. The community handbook has a field-tested walkthrough of this in its failure-modes chapter (link in the README).

Do not restart the bot hoping it retries. Do not start a second process on the same wallet; it would collide on the same nonce.

## 4. Full exit

Stop the loop first (Ctrl+C, or touch the kill-switch file), then:

```bash
EXECUTION_MODE=live node dist/index.js --pool sbtc --withdraw-liquidity
```

With no `--bin` or `--pct` this withdraws every bin the address owns at 100 percent in one transaction. Tokens return to `SIGNER_ADDRESS`. Confirm with a dry-run tick, which should log `owned_bins=0`:

```bash
npm run tick -- --pool sbtc
```

## 5. Restart or upgrade

1. Stop with Ctrl+C. Never Ctrl+Z; the bot converts it to a shutdown anyway, but do not rely on that.
2. `git pull`, `npm install`, `npm run build`, `npm test`.
3. Start again. The bot reads your on-chain bins on every tick: if they are in range it holds, if they have drifted it withdraws and rebuilds. It does not add a second curve on top of the first unless `ENABLE_WITHDRAW_LIQUIDITY=false`.

If the start fails with `EADDRINUSE` on the metrics port, the previous process is still alive. Find and kill it before starting again. One process per pool, one wallet per process.
