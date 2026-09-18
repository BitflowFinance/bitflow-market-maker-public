# Stack Sats on Bitflow: the rules for market makers, as the campaign page states them

Read this when the user asks how rewards are scored, who can earn, when it runs, or how they get paid. Every line below is quoted from https://app.bitflow.finance/stack-sats as it rendered on 09/18/26; the page wins over this file if they differ. Dashes and punctuation inside quotes are the page's own.

## "Three ways to win" cards (page section, verbatim)

"Three ways to win. Pick your lane or take all three. Tap a card for details."

"The Daily Stack" — "41,666 sats × 5 winners, daily" — "0.05 BTC pot" — "One $25+ swap a day is your ticket. Entries stack until you win."

"Stack by Trading" — "Up to 15,000,000 sats / phase" — "0.15 BTC pot" — "Your volume is your share. No leaderboard. No cap."

"Stack by Market Making" — "30,000,000 sats / phase" — "0.3 BTC pot" — "🤖 Agent Starter Kit" — "Tight liquidity near the price out-earns parked TVL. Skill pays."

## Stack by Market Making, "full rules" drawer

"30,000,000 sats / phase · 67% sBTC/USDCx · 33% STX/USDCx"

"Get started in minutes with our agent friendly starter kit: Automate Your Market-Making"

"How it's scored. Snapshots are taken several times daily at randomized minutes — the clock cannot be gamed."

"Haircuts by distance from the active price: 0–1% · 100%; over 1%–3% · 70%; over 3%–6% · 50%; over 6%–10% · 35%; over 10%–15% · 25%; over 15% · 0%."

"Single-sided liquidity counts, with the same haircuts."

"Tightness. Tightness (0–100) is how much of your book sits near the active price — a multiplier, not a gate. There is no minimum score."

"Uptime. Uptime is snapshots with funds deployed ÷ all campaign snapshots. Enrolling late lowers your Uptime, but Bitflow requires no minimum Uptime score."

"composite = Average Useful TVL × Average Maker Score × Uptime"

"Payout = your composite ÷ sum of qualifying composites × the pair pot."

"Exclusions. Endowment and separately compensated market-maker wallets do not earn rewards."

## FAQ

"How do maker rewards work?" — "Reach $5,000+ in Average Useful TVL on a pair during the phase after enrolling and you qualify. Useful means near the active price: within 1% counts in full, further out gets a haircut, beyond 15% counts zero. Score = Average Useful TVL × Average Maker Score × Uptime. Each pair pays its own pot: 67% sBTC/USDCx, 33% STX/USDCx. No unlock tiers, just your score vs. other qualified makers' scores on that pair."

"Do I need to sign up?" — "For the Daily Stack — no. A qualifying swap auto-enters you; you accept terms when you claim. For trading and market making, one wallet signature enrolls you in both."

"Can I automate my market making with my agent?" — "Yes, and we made it easy. Our public starter kit gets you quoting in minutes, and it's built agent-friendly: hand the repo to an AI agent or your own bot and let it manage tightness and uptime while you sleep. Point Claude or your bot of choice at the repo and let it run your book. Tight and consistent beats big and manual here." Link: "Get the starter kit on GitHub".

"I'm starting late. Am I cooked?" — "No. Uptime includes snapshots before you enroll; there's no minimum Uptime score. A full month still weighs more than a late start, but late makers can still qualify. And rules can change between phases."

"What counts as a qualifying swap?" — "One confirmed swap of $25 or more routed through any HODLMM pool for sBTC/USDCx or STX/USDCx, per UTC day. The swap can start or end with other tokens. Extra swaps the same day don't add entries. A $25/day Recurring swap counts on each UTC day it executes."

"How do trader rewards work?" — "You enroll with a wallet signature and accept the terms. For each finalized swap after enrollment, Bitflow compares the executed input and output in USD and credits the higher amount. You qualify when your credited volume reaches $10,000 during the phase. Once you qualify, all credited volume recorded after enrollment during that phase counts toward your payout, including volume recorded before you crossed the threshold. Bitflow unlocks more of the trader budget as volume grows through eligible pools, from $35M up to $64M for the full pot. That unlock total is measured differently from your payout: it counts both sides of every swap and every wallet that trades, enrolled or not. Your payout = your share of qualified traders' combined credited volume × the unlocked trader budget. No cap."

"How do I get paid?" — "In sBTC, whole sats, monthly for trader and maker rewards. One click claims all your Daily Stack prizes; the transaction is sponsored, so you never need STX for claim gas. Daily Stack claims stay open 30 days from the UTC day of your win, and a new giveaway win restarts the clock on your whole unclaimed Daily Stack balance."

"Who can't earn?" — "Endowment wallets and separately compensated market makers. Their liquidity can sit in the pools, but they take no share of rewards."

"When does it run?" — "Three phases: Sept 16 – Oct 10 · Oct 10 – Nov 10 · Nov 10 – Dec 10 (boundaries at 00:00 UTC). Rules freeze per phase and can evolve between phases."

## What this means for the bot's user, in one paragraph

The bot's de-risk swaps route through the eligible pools, so a day with a bot swap of $25 or more is also a Daily Stack entry, and its volume is credited for Stack by Trading once the account is enrolled. The maker gate is $5,000 Average Useful TVL per pair, averaged over the snapshots where the account had funds deployed; below it the book is scored but not paid. Uptime counts every campaign snapshot, so enrolling and deploying early matters more than book size.
