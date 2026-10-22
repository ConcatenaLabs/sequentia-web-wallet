# User-mode drill report

The user-mode composer's trades on one stack, each settled or cleanly returned with no user action, the ticket checked against what moved. This report is written by `tooling/user-mode-drill.mjs`; `pairs.json` beside it lists what user mode offers on each chain.

## Result

- Trades: 502; settled 493, returned 9 (of them 0 with the fees of a payment to itself spent, which come back at that coin's next refresh), failed 0. Quotes that found nothing to fill (not trades): 0.
- Verdict: passed: every trade settled or was cleanly returned, every settled trade moved exactly what its ticket showed, and every returned one nothing but the fees it named.
- Disruptions: the wallet closed mid-trade 70 times, the operator restarted 24 times, the parent chain reorganised under a trade's round 5 times.
- By source: in-tree swaps with the live leaf maker 76, covenant orders taken in a round 118, orders resting in the tree filled 52, BTC in one hash-lock with the maker's desk 249 (selling for BTC 124, buying with BTC 125).
- Time to Sent: median 26.6 s, 95th percentile 66.1 s. Time to Settled: median 52.9 s, 95th percentile 101.3 s.

## The stack

- The web wallet at `8ca045be`, its leaf library (`leaves/pkg`) in Node, each wallet a process of its own running `user-trade.js`, the code the page runs.
- Chain: `48471cda14077e1e1a530e3ae6e90a1cd8b1ae4fa2d2ee326687f2e479972505` (regtest, the operator repository's harness `arca_operator_for_browsers`, anchored proof of stake).
- The operator, rounds built every 2 s by the drill's clock, leaves with an exit delay of one 512 s unit (the one difference from the testnet's shape); SeqDEX's relay with `-fill-anchor-depth=2`; one live leaf maker (`tooling/lsp/leaf-maker.mjs`) quoting both directions from coins of 2,000,000; transparent covenant orders both ways, priced a little better than the maker and of little depth, restocked every 25 trades.
- 3 wallets, one trade at a time each, amounts between 50,000 and 400,000 atoms (25,000 to 190,000 sat when BTC is paid), the direction cycling X for Y, Y for X, X for BTC and BTC for X; each wallet starts with ten coins of 3,000,000 of each asset.
- BTC over Lightning on a Bitcoin regtest chain beside the harness: the maker's desk on a hub node with a channel of 10,000,000 sat to each wallet's own node, half of it the wallet's; the operator's Lightning leg in X (SeqLN, the hold-invoice plugin), its payments out of the tree timing out four to eight days out; the wallets' and the maker's exit delay three units.
- A maker who rests an order of 2,500,000 each way in the operator's tree and goes away (`order_rest`, listed on the relay with its `resting_leaf` member), the best price for Y and between the covenant order and the live maker for X, rested again whenever one holds less than 600,000.
- The operator fronts, from its own coins, every coin a round settles: each in-tree trade settles both the coin it brings and the change, so the operator needs as much of each asset as the trades move until the old batches expire. The drill gives it 200,000,000 of each asset at the start and every 25 trades.

## Failures

None.

## Every trade

One line per trade in `trades.jsonl`: its source, ticket, what moved, its disruptions and its outcome.

