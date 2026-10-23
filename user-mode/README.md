# What user mode offers

User mode's Trade tab offers a pair only once the reliability drill
(`tooling/user-mode-drill.mjs`) has passed for it on that chain: a run of trades with the wallet
closed mid-trade, the operator restarted and the parent chain reorganised under a trade's round,
every trade settled or cleanly returned with no user action, and every settled trade moving
exactly what its ticket showed.

- `pairs.json` is the list the page reads: per chain, keyed by its genesis hash, each admitted
  pair (`pay` and `receive`, asset ids in display order), the sources it may trade through
  (`leaf-maker`, an in-tree swap with a live leaf maker; `covenant-round`, a transparent covenant
  order taken in the operator's round; `leaf-resting`, an order resting as a leaf in the
  operator's tree, filled in one transfer; `btc-gateway`, BTC for an asset in one hash-lock with a
  maker's BTC desk, BTC written `"BTC"`; `onchain-fill`, a transparent covenant order taken on the
  chain from the wallet's own on-chain coins in one transaction, which needs no operator and no
  leaves), where the drill that admitted it ran (`proven`), and its
  report (`report`). A chain, pair or source not in it is not offered.
- `"proven": "regtest"` admits a pair on the testnet on the strength of a 500-trade drill on
  regtest with the testnet's shape (the same operator, relay, maker and composer code, with short
  exit delays). The drill run against the testnet itself then marks it `"testnet"`, or takes the
  pair out if it fails there.
- Each pair names the report of the drill run that admitted it (`report`): `REPORT.md`, and a
  `REPORT-<what>.md` beside it for each other run (the BTC pairs' own run, `--btc-only`; the run
  over every pair of the testnet's assets, `--every-pair`). A pair is admitted with the sources
  that settled at least one of its trades in that run.
- A pair with a supervised asset (USDC.e, EURC.e) trades through the live maker only, and has no
  BTC pair: the operator serves no take, no resting order and no Lightning payment in such an
  asset.

The drill writes both into its output directory; a pull request copies them here, so what user
mode offers and the run that earned it are reviewed together.
