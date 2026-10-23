# User-mode drill report: BTC against every asset

The user-mode composer's trades on one stack, each settled or cleanly returned with no user action, the ticket checked against what moved. This report is written by `tooling/user-mode-drill.mjs` (`--every-pair --btc-only`); `pairs.json` beside it lists what user mode offers on each chain. On regtest each of the testnet's assets stands as one of the harness's assets, priced the same per atom; `pairs.json` lists the BTC pairs that passed under the testnet's ids, without SBTC's, which are not offered there.

## Result

- Trades: 502; settled 491, returned 11 (of them 0 with the fees of a payment to itself spent, which come back at that coin's next refresh), failed 0. Quotes that found nothing to fill (not trades): 9.
- Verdict: passed: every trade settled or was cleanly returned, every settled trade moved exactly what its ticket showed, and every returned one nothing but the fees it named.
- Disruptions: the wallet closed mid-trade 73 times, the operator restarted 23 times, the parent chain reorganised under a trade's round 2 times.
- By source: in-tree swaps with the live leaf maker 0, covenant orders taken in a round 0, orders resting in the tree filled 0, BTC in one hash-lock with the maker's desk 502 (selling for BTC 246, buying with BTC 256).
- Time to Sent: median 59.9 s, 95th percentile 135.7 s. Time to Settled: median 109.3 s, 95th percentile 392.7 s.

## By pair

What was paid → what was received: trades settled by source, returned, and quotes that found nothing to fill.

- USDX → BTC: settled 36 (btc-gateway 36), returned 0, not offered 0
- BTC → USDX: settled 37 (btc-gateway 37), returned 0, not offered 0
- EURX → BTC: settled 37 (btc-gateway 37), returned 0, not offered 0
- BTC → EURX: settled 37 (btc-gateway 37), returned 0, not offered 0
- tSEQ → BTC: settled 36 (btc-gateway 36), returned 0, not offered 1
- BTC → tSEQ: settled 37 (btc-gateway 37), returned 0, not offered 0
- GOLD → BTC: settled 37 (btc-gateway 37), returned 0, not offered 0
- BTC → GOLD: settled 37 (btc-gateway 37), returned 0, not offered 0
- SILVR → BTC: settled 35 (btc-gateway 35), returned 0, not offered 1
- BTC → SILVR: settled 36 (btc-gateway 36), returned 0, not offered 0
- OILX → BTC: settled 36 (btc-gateway 36), returned 0, not offered 0
- BTC → OILX: settled 36 (btc-gateway 36), returned 0, not offered 0
- SBTC → BTC: settled 29 (btc-gateway 29), returned 0, not offered 7
- BTC → SBTC: settled 25 (btc-gateway 25), returned 11, not offered 0

## The stack

- The web wallet at `d3869684`, its leaf library (`leaves/pkg`) in Node, each wallet a process of its own running `user-trade.js`, the code the page runs.
- Chain: `48471cda14077e1e1a530e3ae6e90a1cd8b1ae4fa2d2ee326687f2e479972505` (regtest, the operator repository's harness `arca_operator_for_browsers` with 7 more plain assets and 2 supervised ones, anchored proof of stake).
- The testnet's assets (`tooling/user-mode-every-pair.json`), each a harness asset priced the same per atom: USDX, EURX, tSEQ, GOLD, SILVR, OILX, SBTC, USDC.e (supervised), EURC.e (supervised); 14 directed pairs, a trade's direction cycling through them all.
- The operator, rounds built every 2 s by the drill's clock, leaves with an exit delay of one 512 s unit; SeqDEX's relay with `-fill-anchor-depth=2`; one live leaf maker quoting every directed pair 2% above the mid from coins of about $100; transparent covenant orders 1% above it and orders resting in the tree 0.5% above it on every pair without a supervised asset, each four times the pair's least trade, restocked every 25 trades.
- 3 wallets, one trade at a time each, each trade worth between its pair's least (neither side under 20,000 atoms) and five times that; each wallet starts with five coins of $100 of every asset.
- BTC against every plain asset over Lightning: the maker's BTC desk on a hub node with a channel of 10,000,000 sat to each wallet's own node, half of it the wallet's; the operator's Lightning leg in each plain asset (SeqLN, the hold-invoice plugin); the wallets' and the maker's exit delay three units.

## Failures

None.

## Every trade

One line per trade in `trades.jsonl`: its source, ticket, what moved, its disruptions and its outcome.

