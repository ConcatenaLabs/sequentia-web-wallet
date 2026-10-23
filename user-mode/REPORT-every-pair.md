# User-mode drill report: every pair

The user-mode composer's trades on one stack, each settled or cleanly returned with no user action, the ticket checked against what moved. This report is written by `tooling/user-mode-drill.mjs` (`--every-pair`); `pairs.json` beside it lists what user mode offers on each chain. On regtest each of the testnet's assets stands as one of the harness's assets, priced the same per atom; `pairs.json` lists the pairs that passed under the testnet's ids, without the SBTC pairs, which are not offered there.

## Result

- Trades: 502; settled 494, returned 8 (of them 7 with the fees of a payment to itself spent, which come back at that coin's next refresh), failed 0. Quotes that found nothing to fill (not trades): 35.
- Verdict: passed: every trade settled or was cleanly returned, every settled trade moved exactly what its ticket showed, and every returned one nothing but the fees it named.
- Disruptions: the wallet closed mid-trade 71 times, the operator restarted 24 times, the parent chain reorganised under a trade's round 9 times.
- By source: in-tree swaps with the live leaf maker 344, covenant orders taken in a round 98, orders resting in the tree filled 60.
- Time to Sent: median 93.7 s, 95th percentile 386.7 s. Time to Settled: median 121.5 s, 95th percentile 436.9 s.

## By pair

What was paid → what was received: trades settled by source, returned, and quotes that found nothing to fill.

- USDX → EURX: settled 7 (leaf-maker 4, covenant-round 2, leaf-resting 1), returned 0, not offered 0
- USDX → tSEQ: settled 8 (leaf-maker 5, covenant-round 1, leaf-resting 2), returned 0, not offered 0
- USDX → GOLD: settled 7 (leaf-maker 5, covenant-round 2, leaf-resting 0), returned 1, not offered 0
- USDX → SILVR: settled 8 (leaf-maker 5, covenant-round 1, leaf-resting 2), returned 0, not offered 0
- USDX → OILX: settled 8 (leaf-maker 3, covenant-round 4, leaf-resting 1), returned 0, not offered 0
- USDX → SBTC: settled 6 (leaf-maker 4, covenant-round 1, leaf-resting 1), returned 2, not offered 0
- USDX → USDC.e: settled 6 (leaf-maker 6), returned 0, not offered 2
- USDX → EURC.e: settled 6 (leaf-maker 6), returned 0, not offered 2
- EURX → USDX: settled 8 (leaf-maker 6, covenant-round 1, leaf-resting 1), returned 0, not offered 0
- EURX → tSEQ: settled 8 (leaf-maker 2, covenant-round 4, leaf-resting 2), returned 0, not offered 0
- EURX → GOLD: settled 8 (leaf-maker 5, covenant-round 2, leaf-resting 1), returned 0, not offered 0
- EURX → SILVR: settled 8 (leaf-maker 5, covenant-round 1, leaf-resting 2), returned 0, not offered 0
- EURX → OILX: settled 8 (leaf-maker 2, covenant-round 2, leaf-resting 4), returned 0, not offered 0
- EURX → SBTC: settled 8 (leaf-maker 5, covenant-round 2, leaf-resting 1), returned 0, not offered 0
- EURX → USDC.e: settled 7 (leaf-maker 7), returned 0, not offered 1
- EURX → EURC.e: settled 7 (leaf-maker 7), returned 0, not offered 1
- tSEQ → USDX: settled 8 (leaf-maker 6, covenant-round 1, leaf-resting 1), returned 0, not offered 0
- tSEQ → EURX: settled 8 (leaf-maker 4, covenant-round 2, leaf-resting 2), returned 0, not offered 0
- tSEQ → GOLD: settled 8 (leaf-maker 4, covenant-round 3, leaf-resting 1), returned 0, not offered 0
- tSEQ → SILVR: settled 8 (leaf-maker 3, covenant-round 3, leaf-resting 2), returned 0, not offered 0
- tSEQ → OILX: settled 8 (leaf-maker 3, covenant-round 2, leaf-resting 3), returned 0, not offered 0
- tSEQ → SBTC: settled 8 (leaf-maker 3, covenant-round 2, leaf-resting 3), returned 0, not offered 0
- tSEQ → USDC.e: settled 7 (leaf-maker 7), returned 0, not offered 1
- tSEQ → EURC.e: settled 7 (leaf-maker 7), returned 0, not offered 1
- GOLD → USDX: settled 7 (leaf-maker 3, covenant-round 3, leaf-resting 1), returned 0, not offered 1
- GOLD → EURX: settled 7 (leaf-maker 4, covenant-round 2, leaf-resting 1), returned 0, not offered 1
- GOLD → tSEQ: settled 8 (leaf-maker 4, covenant-round 3, leaf-resting 1), returned 0, not offered 0
- GOLD → SILVR: settled 7 (leaf-maker 4, covenant-round 2, leaf-resting 1), returned 0, not offered 1
- GOLD → OILX: settled 7 (leaf-maker 4, covenant-round 1, leaf-resting 2), returned 0, not offered 1
- GOLD → SBTC: settled 7 (leaf-maker 3, covenant-round 3, leaf-resting 1), returned 1, not offered 0
- GOLD → USDC.e: settled 8 (leaf-maker 8), returned 0, not offered 0
- GOLD → EURC.e: settled 7 (leaf-maker 7), returned 0, not offered 1
- SILVR → USDX: settled 8 (leaf-maker 2, covenant-round 3, leaf-resting 3), returned 0, not offered 0
- SILVR → EURX: settled 8 (leaf-maker 5, covenant-round 2, leaf-resting 1), returned 0, not offered 0
- SILVR → tSEQ: settled 7 (leaf-maker 4, covenant-round 2, leaf-resting 1), returned 0, not offered 0
- SILVR → GOLD: settled 7 (leaf-maker 2, covenant-round 3, leaf-resting 2), returned 0, not offered 0
- SILVR → OILX: settled 6 (leaf-maker 1, covenant-round 4, leaf-resting 1), returned 0, not offered 1
- SILVR → SBTC: settled 6 (leaf-maker 1, covenant-round 3, leaf-resting 2), returned 1, not offered 0
- SILVR → USDC.e: settled 7 (leaf-maker 7), returned 0, not offered 0
- SILVR → EURC.e: settled 7 (leaf-maker 7), returned 0, not offered 0
- OILX → USDX: settled 7 (leaf-maker 4, covenant-round 1, leaf-resting 2), returned 0, not offered 0
- OILX → EURX: settled 6 (leaf-maker 3, covenant-round 3, leaf-resting 0), returned 0, not offered 1
- OILX → tSEQ: settled 7 (leaf-maker 1, covenant-round 5, leaf-resting 1), returned 0, not offered 0
- OILX → GOLD: settled 7 (leaf-maker 4, covenant-round 2, leaf-resting 1), returned 0, not offered 0
- OILX → SILVR: settled 7 (leaf-maker 2, covenant-round 3, leaf-resting 2), returned 0, not offered 0
- OILX → SBTC: settled 5 (leaf-maker 0, covenant-round 3, leaf-resting 2), returned 1, not offered 1
- OILX → USDC.e: settled 7 (leaf-maker 7), returned 0, not offered 0
- OILX → EURC.e: settled 6 (leaf-maker 6), returned 0, not offered 1
- SBTC → USDX: settled 7 (leaf-maker 4, covenant-round 2, leaf-resting 1), returned 0, not offered 0
- SBTC → EURX: settled 7 (leaf-maker 4, covenant-round 2, leaf-resting 1), returned 0, not offered 0
- SBTC → tSEQ: settled 7 (leaf-maker 3, covenant-round 2, leaf-resting 2), returned 0, not offered 0
- SBTC → GOLD: settled 6 (leaf-maker 3, covenant-round 2, leaf-resting 1), returned 0, not offered 1
- SBTC → SILVR: settled 6 (leaf-maker 4, covenant-round 2, leaf-resting 0), returned 0, not offered 1
- SBTC → OILX: settled 6 (leaf-maker 2, covenant-round 4, leaf-resting 0), returned 0, not offered 1
- SBTC → USDC.e: settled 6 (leaf-maker 6), returned 0, not offered 1
- SBTC → EURC.e: settled 5 (leaf-maker 5), returned 0, not offered 2
- USDC.e → USDX: settled 7 (leaf-maker 7), returned 0, not offered 0
- USDC.e → EURX: settled 7 (leaf-maker 7), returned 0, not offered 0
- USDC.e → tSEQ: settled 7 (leaf-maker 7), returned 0, not offered 0
- USDC.e → GOLD: settled 6 (leaf-maker 6), returned 0, not offered 1
- USDC.e → SILVR: settled 7 (leaf-maker 7), returned 0, not offered 0
- USDC.e → OILX: settled 5 (leaf-maker 5), returned 1, not offered 1
- USDC.e → SBTC: settled 5 (leaf-maker 5), returned 0, not offered 2
- USDC.e → EURC.e: settled 6 (leaf-maker 6), returned 0, not offered 1
- EURC.e → USDX: settled 7 (leaf-maker 7), returned 0, not offered 0
- EURC.e → EURX: settled 7 (leaf-maker 7), returned 0, not offered 0
- EURC.e → tSEQ: settled 7 (leaf-maker 7), returned 0, not offered 0
- EURC.e → GOLD: settled 5 (leaf-maker 5), returned 0, not offered 2
- EURC.e → SILVR: settled 7 (leaf-maker 7), returned 0, not offered 0
- EURC.e → OILX: settled 4 (leaf-maker 4), returned 0, not offered 3
- EURC.e → SBTC: settled 4 (leaf-maker 4), returned 1, not offered 2
- EURC.e → USDC.e: settled 7 (leaf-maker 7), returned 0, not offered 0

## The stack

- The web wallet at `01dc06c5`, its leaf library (`leaves/pkg`) in Node, each wallet a process of its own running `user-trade.js`, the code the page runs.
- Chain: `3ce8ab6c8f9836c0cebca304f3cbed3e824e6c53f4cacd2822f6f8441eed1a3e` (regtest, the operator repository's harness `arca_operator_for_browsers` with 7 more plain assets and 2 supervised ones, anchored proof of stake).
- The testnet's assets (`tooling/user-mode-every-pair.json`), each a harness asset priced the same per atom: USDX, EURX, tSEQ, GOLD, SILVR, OILX, SBTC, USDC.e (supervised), EURC.e (supervised); 72 directed pairs, a trade's direction cycling through them all.
- The operator, rounds built every 2 s by the drill's clock, leaves with an exit delay of one 512 s unit; SeqDEX's relay with `-fill-anchor-depth=2`; one live leaf maker quoting every directed pair 2% above the mid; transparent covenant orders 1% above it and orders resting in the tree 0.5% above it on every pair without a supervised asset, each four times the pair's least trade, restocked every 25 trades.
- 3 wallets, one trade at a time each, each trade worth between its pair's least (neither side under 20,000 atoms) and five times that; each wallet starts with five coins of $100 of every asset.

## Failures

None.

## Every trade

One line per trade in `trades.jsonl`: its source, ticket, what moved, its disruptions and its outcome.

