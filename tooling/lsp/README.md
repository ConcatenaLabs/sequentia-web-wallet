# Hosted-SeqLN LSP (the "we run SeqLN for the user" backend)

This is the backend the wallet's Lightning module (`../../seqln.js`) commands to
deliver the **non-custodial instant-LN asset↔BTC DEX from a thin wallet**. It
implements the LSP / hosted-SeqLN model:

- **We host** the SeqLN node (liquidity, channels, routing).
- **The wallet holds the keys.** On unlock it brings an on-device wasm signer
  online over a wss Noise_XK link (the vendored SDK in `../../lightning/`). The
  hosted node has **no `hsm_secret`**: every commitment update is co-signed by
  the device. The device signs only commitments it has validated and approves
  each payment only within its payment limit for the asset. That does not
  protect a user from an operator who runs both the hosted node and its channel
  peer: the node collects the device's signature on each commitment before the
  device revokes it (the preempt slot), so the two together can broadcast a
  revoked commitment and take the channel's funds.
- **The wallet commands** swaps via this thin HTTP API; the hosted node takes a
  pure-LN order-book offer (`seqob-cli xpln`) while the device signs.

## API

Auth: `Authorization: Bearer <LSP_TOKEN>` (production must use per-wallet auth —
a RUNE / signed challenge bound to the device pubkey; the shared token is interim).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | liveness, no auth |
| `GET` | `/anchor` | anchor height and status of a Sequentia block, no auth (the wallet verifies a leg's real anchor instead of trusting the maker) |
| `GET` | `/status` | `{node_id, network, channels:[{peer_id, asset_label, spendable_units, receivable_units, balance_units, state}]}` (`balance_units` is this side's share, the reserve included; `spendable_units` what it can send now) |
| `GET` | `/rails` | which settlement rails are usable per asset and side |
| `GET` | `/book`, `/book/unified`, `/lnbook` | the on-chain cross book, the unified rail-agnostic book, the pure-LN book |
| `POST` | `/offer` | relay a wallet-signed sub-asset offer (the LSP only forwards the bytes) |
| `POST` / `GET` | `/swap`, `/swap/<id>` | execute a swap (`{side:'buy'|'sell', asset, amount}`); an over-cap, anchor-gated mixed swap runs asynchronously and is polled by id |
| `POST` / `GET` | `/node/provision`, `/nodes/list`, `/node/list`, `/node/getinfo`, `/node/onchain` | per-device hosted-node provisioning and inspection |
| `POST` / `GET` | `/node/invoice`, `/node/invoice-status`, `/node/settle`, `/node/receive`, `/node/pay`, `/node/payhash` | invoices and payments on the user's own hosted node (HODL buy path, plain receive, pay); a payment the device declines is answered `403 {ok:false, declined:true, error}` before any HTLC exists |
| `POST` | `/node/invoice` with `payment_hash` and `bolt11: true` | a hold under the device's hash that also answers a BOLT11 for it, signed by the node, for a payer that pays only invoices: the node's own invoice under a throwaway hash, deleted, the hold's hash put in its place (`hold-bolt11.mjs`) and signed with `signinvoice`. The node never learns the preimage before the device settles; `/node/invoice-status` answers `amount_msat` (registered) and `received_msat` (held), which the device compares before it settles |
| `GET` | `/node/pay-status?node=&payment_hash=`, `/node/pay-quote?node=&bolt11=` | how the node's payments under a hash stand (`none`, `pending`, `complete` with its preimage, or `failed` once no attempt is in flight); the routing fee and whole lock (`delay`) a payment of the invoice would take now. `/node/pay` takes `maxfee_msat`, the fee the payer's ticket showed |
| `POST` / `GET` | `/channel/deposit`, `/channel/open`, `/channel/open/<id>`, `/channel/inbound/quote`, `/channel/inbound`, `/channel/close` | "Move to Lightning" channel funding, inbound-liquidity purchase (priced in the asset bought, for the months the buyer chooses among `INBOUND_MONTHS` (default `1,3,6,12`; a request naming none gets `INBOUND_DEFAULT_MONTHS`, default 12): `max(floor, amount × yearly rate × months / 12)`, the yearly rate in basis points from `INBOUND_ANNUAL_BPS` (JSON keyed by asset id or label, `"BTC"` for bitcoin, e.g. `{"USDX":500,"BTC":100}`) or `INBOUND_FEE_BPS` for an asset it does not name, `inbound-price.mjs`; the purchase answers `expires_at`, until when the service keeps that channel open; for BTC between `INBOUND_MIN_SAT` and `INBOUND_MAX_SAT`, for an asset the node prices between `INBOUND_REF_MIN` and `INBOUND_REF_MAX` worth of it with a fee of at least `INBOUND_REF_FEE_FLOOR`, all three in reference atoms of the fee exchange rates, `inbound-limits.mjs`; a prepaid fee transaction pays for one purchase, recorded in `inbound-fees.json` as soon as the LP's wallet shows it (spent outputs included), and is accepted again only to retry that purchase or to buy less room on that node, without being priced again; a fee is good at the lowest price quoted with that node's key for that asset, term and at least that room within `INBOUND_QUOTE_HOLD_H` hours (default 168, kept in `inbound-quotes.json`), or today's, less `INBOUND_FEE_TOLERANCE_BPS` (default 1000) for a rate that moved; a fee not seen yet answers 402 with `paid: 0`, one too small 402 with `paid` and `least`; room the LP cannot fund from its confirmed coins of the asset, after `SUBAS_INBOUND_HEADROOM_BPS` and `SUBAS_INBOUND_RESERVE`, is refused in the quote (`lp_short`, with the `fundable` room) and by the purchase with 503, a prepaid fee already seen staying recorded for it), cooperative close (to the node's own wallet unless a `destination` is named; the device signs a close only when it pays this side's balance to its own scripts or to a script of the wallet the page names to it with `approveCloseDestination`, which is how the wallet closes straight to its own address). `/channel/open` with `consolidate: true` first sends every coin of the asset on the user's node to a new address of the node's own, then funds the channel from that coin (`consolidate.mjs`). The device moves a node's coins only to its own addresses or into a channel the node opens |
| `GET` (no token) | `/stats/inbound` | What the room-to-receive service holds, sold and turned away, in aggregate, for the public page at `/liquidity` (`inbound-stats.mjs`): per asset the LP's free coins, the room it can sell now, the room locked in the channels it opened, utilization, a status (out under the smallest sale, low under 1,000 reference units sellable), sales and fees (all time and 30 days, at the price of the day), fees per day, deferred fees owed, purchases refused for lack of stock in the last 7 days, and the price list. Nothing in it names a node, channel, transaction or address; cached a minute. The books behind it sit in `PROV_DIR` beside `inbound-fees.json`: `inbound-sales.jsonl` (one line per channel actually opened), `inbound-refused.jsonl` (a quote asked with a node key, or a purchase, refused for lack of stock; once per node, asset and room in ten minutes) and `inbound-stock.jsonl` (hourly: free and locked per asset). A prepaid fee whose channel opened is marked so in `inbound-fees.json`: the quote asked with a node key names a fee that node paid for room never opened (`paid_waiting`), and a retried purchase whose room is open is answered as done. |
| `POST` | `/channel/start`, `/channel/complete`, `/channel/cancel` | a channel, Sequentia or BTC, funded by **one transaction of the wallet's own**, the coins never on the node. `start` runs `fundchannel_start` and answers the channel's funding address; the wallet builds and blinds a transaction paying it, and `complete` takes that transaction unsigned, checks from the node's own `decodepsbt` that it pays the channel exactly the amount, in its asset, in the clear and with every other output already blinded (`external-funding.mjs`), then runs `fundchannel_complete`, which on Sequentia checks no amount itself. The wallet signs and broadcasts only after `complete` answers with the funding txid, so the peer's signature on the first commitment exists before any coin moves. `cancel` runs `fundchannel_cancel` and is refused once the chain knows the funding transaction. For a BTC channel the check reads bitcoind's `decodepsbt` (`btcFundingProblem`). The job is polled at `/channel/open/<id>`. Needs `ELEMENTS_CLI` and `SEQ_RPC_PORT` for Sequentia channels, `BTC_CLI` and `BTC_RPC_PORT` for BTC ones |
| `POST` | `/bridge/front`, `/bridge/hold`, `/bridge/asset` | the rail-crossing leg bridge: the LSP fronts a BTC-LN leg against the maker's confirmed on-chain BTC HTLC |

Every payment a hosted node makes is approved by its device first. `pay` asks
for the approval itself; before each bare-hash `sendpay` (`/node/payhash`, the
`/node/pay` direct-hop fallback, and the bridge's fronted legs) the LSP calls
`preapproveinvoice` or `preapprovekeysend`. Without it a keyless node's device
refuses the commitment and the channel has no owning daemon until the peer
reconnects. The device approves a payment only within its payment limit for the
asset, which the wallet sets (`window.SEQ_LN_PAYMENT_LIMITS`, below). A hosted
node pays in the asset it was provisioned for, named in every `pay` and
`getroute`. An invoice on a Sequentia network names the asset it is paid in (its
`a` field), so `/node/pay` answers `400` to one in another asset before anything
is sent. The invoices a hosted Sequentia node makes (`/node/receive`, and
`/node/invoice` without a payment hash) name its asset and are made with
`allow_unfunded=true`: the node refuses an invoice in an asset with no channel
open or opening, and the inbound channel is the LSP's to open, which the wallet
asks for just before. The rules are in `invoice-asset.mjs`.

`asset` accepts a ticker (`GOLD`) or a 32-byte hex asset id. The pair is
`<asset>/BTC`, where the BTC leg is a real Bitcoin-LN channel in production, or
a second issued asset (the `BTCX` variable) as a regtest stand-in. The handler
comments in `lsp-server.mjs` are the reference for request and response shapes.

Pure-LN is the one settlement state honestly labelled **final** (nothing on-chain,
no Bitcoin-reorg surface — DEX 0-conf policy + Principle 1).

## Run

```sh
LNCLI=/path/to/lightning-cli \
HOSTED_ASSET_RPC=/path/to/hosted/asset-node/lightning-rpc \
HOSTED_BTC_RPC=/path/to/hosted/btc-node/lightning-rpc \
SEQOB_CLI=/path/to/seqob-cli \
RELAY=http://127.0.0.1:9955 \
GOLD=<gold asset id> \
LSP_PORT=9981 LSP_TOKEN=<token> \
  node lsp-server.mjs
```

`LNCLI`, `SEQOB_CLI` and `GOLD` are required; the server exits without them.
`HOSTED_RPC` is a one-node fallback for both `HOSTED_*_RPC`. `RELAY` and
`SEQOB_RELAY_URL` (the seqobd relay for the unified book) both default to
`http://127.0.0.1:9955`; `LSP_PORT` defaults to 9981 and `LSP_TOKEN` to
`devtoken-lsp`, so always set the token. `BTCX` names a second issued asset as
a regtest stand-in for the BTC leg; leave it unset for real BTC-LN. The server
reads some eighty further variables (`SEQ_RPC_*`, `BTC_RPC_*`, `SUBAS_*`,
`INBOUND_*`, `LSP_PAYER_*`, `REFUND_*`, ...) for the bridge, sub-asset and
inbound-liquidity paths; `lsp-server.mjs` is the reference for those. A provisioned node loads the
hold-invoice plugin from `SEQLN_HOLDINVOICE_PLUGIN` (default
`/root/sequentia/seqln/contrib/holdinvoice-seq/holdinvoice.py`).

The service assumes the rest of the hosted backend is already up:

1. **seqobd** relay (`seqobd -listen :9955`).
2. **Keyless hosted SeqLN node** whose `hsmd` is the remote device signer —
   `lightningd --subdaemon=hsmd:<wrapper>` where the wrapper sets
   `SEQLN_SIGNER_LISTEN` (Noise_XK responder), `SEQLN_HOST_PRIVKEY`, and pins the
   device's `SEQLN_SIGNER_PEER_PUBKEY`.
3. **WS↔TCP relay** (`seqln/contrib/seqln-signer/wasm/relay/seqln-ws-relay.mjs`)
   fronting the proxy's TCP listener so the browser device can reach it over wss.
4. **LP maker** `seqob-maker -mode pureln -side sell` with the GOLD leg and the
   BTC-stand-in **hold** leg on **separate peers** (avoids the same-peer
   multi-asset misroute).
5. **Announced** asset channels to the hosted node (GOLD inbound + BTC-stand-in
   pushed for outbound). Asset routing (`getroute asset=…`) only matches
   channels whose on-chain asset is in gossip, so the channels must be
   **announced**, not private.

## Wiring the wallet to a running LSP

The cross-chain rail is TWO hosted nodes (an **asset** node on Sequentia + a
**btc** node on testnet4) co-signed by the ONE wallet. Set globals before the
wallet module loads (mirrors `window.SEQ_SEQOB_URL`):

```js
window.SEQ_LSP_URL               = 'https://host/lsp';   // this service (default: origin + '/lsp')
window.SEQ_LSP_TOKEN             = '<bearer token>';
// per-node WS↔TCP relay front + pinned host static pubkey:
window.SEQ_LSP_WS_ASSET          = 'wss://host/lsp-ws-asset';
window.SEQ_LSP_HOST_PUBKEY_ASSET = '<hosted ASSET node host static pubkey>';
window.SEQ_LSP_WS_BTC            = 'wss://host/lsp-ws-btc';
window.SEQ_LSP_HOST_PUBKEY_BTC   = '<hosted BTC node host static pubkey>';
// optional: the device's payment limits per period (reference atoms, or an asset's own atoms)
window.SEQ_LN_PAYMENT_LIMITS     = { reference: 100000000000, period: 86400,
                                     assets: { '<asset id>': 5000000, btc: 2000000 } };
```

The payment limits are enforced by the device signer, not by this service: the
device approves a payment only when its amount, with a routing-fee allowance,
fits in what the limit leaves for the period, and charges every HTLC it signs to
its channel's asset. `null` means no limit; with the global unset the device's
default applies: 1,000 reference units a day (US dollars on the testnet), held in
each asset at the rate the wallet gives the device from its own `/feerates` and
`/prices` (`../../ln-limit.js`), so it is worth the same in every asset. An asset
without a rate is held to 10,000,000 of its own atoms. `reference` sets that
value in reference atoms, `default` replaces it with the same atoms of every
asset, and `assets` sets an asset's own limit.

The wallet derives TWO device identities from the user's ONE mnemonic
(`../../seqln-keys.js`, single source of truth) and brings up a device signer for
each node. The **"Instant (Lightning)"** rail is offered only once **BOTH** legs
are serving (`⚡ LN ready`); one leg shows `⚡ LN 1/2`.

Derivation paths (the re-provisioning step MUST derive the SAME children):

| node | Noise transport privkey | SeqLN signing seed |
| --- | --- | --- |
| asset | `m/1017'/0'/0'` (== legacy single-node path) | `m/1017'/1'/0'` |
| btc   | `m/1017'/0'/1'`                              | `m/1017'/1'/1'` |

The signing seed is the hex of the child privkey; the wasm `SeqlnSigner.fromMnemonic`
builds the on-disk `32 zero bytes || <signingSeed>` hsm_secret from it, which fully
determines the keyless node's identity (node_id + channel keys).

Legacy single-node vars (`SEQ_LSP_WS` / `SEQ_LSP_HOST_PUBKEY`) still work and map to
the **asset** slot; per-node local-pinning overrides for a fixed harness are
`SEQ_LSP_DEV_KEY_ASSET` / `_BTC` (transport privkey) and `SEQ_LSP_DEV_SEED_ASSET` /
`_BTC` (signing seed).

### Provisioning the two hosted nodes from the same mnemonic

`derive-node-keys.mjs` reproduces the wallet's per-node device keys outside the
browser, so you can provision each keyless hosted node and drive the Node device
harness as a browser stand-in:

```sh
node derive-node-keys.mjs <mnemonic_file> <out_dir> both
# prints each node's device transport PUBKEY (pin as SEQLN_SIGNER_PEER_PUBKEY)
# and writes <out>/<node>.hsm_secret + <node>.transport.hex (0600) for the harness:
node device-harness.mjs asset <SEQ_LSP_WS_ASSET> <out>/asset.hsm_secret <SEQ_LSP_HOST_PUBKEY_ASSET> <out>/asset.transport.hex
node device-harness.mjs btc   <SEQ_LSP_WS_BTC>   <out>/btc.hsm_secret   <SEQ_LSP_HOST_PUBKEY_BTC>   <out>/btc.transport.hex
```

The node id each harness prints is that hosted node's identity — provision the
node keyless and pin the matching transport pubkey. The browser reaches the same
identity via `SeqlnSigner.fromMnemonic(signingSeed)` (byte-identical hsm_secret).
The harness takes the device's payment limits from `SEQ_LN_PAYMENT_LIMITS` in
its environment, as JSON in the shape of `window.SEQ_LN_PAYMENT_LIMITS`.

## Proof

A Node end-to-end harness drives this exact API + the vendored wallet SDK: it
connects the on-device signer (keys never leave the process), boots the keyless
hosted node, opens the separate-peer asset channels, posts an LP offer, then
`POST /swap buy` settles a pure-LN GOLD↔BTC-stand-in trade — the device serving
`SIGN_REMOTE_COMMITMENT_TX`/`VALIDATE_COMMITMENT_TX`/`ECDH` during the swap, with
**real per-asset movement** (GOLD in, BTC-stand-in out on the correct channels),
not just a shared preimage. `device-harness.mjs` in this directory is the
device-signer half of that harness: it serves the hosted node's hsmd stream from
the same vendored wasm signer the page uses.

## The live leaf maker (`leaf-maker.mjs`)

A maker that holds coins in one operator's tree and quotes in-tree swaps for the pairs its
configuration names: the in-tree source of user mode's Trade tab (`../../user-trade.js`). It runs
the leaf library (`../../leaves/pkg`) in Node through `../leaf-node.mjs`, with a store of its own.
It quotes only what that library can pay now, less what its open offers hold and a margin for
fees, and it boards what it holds on the chain of an asset it gives above `board_keep`.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/health` | `{ok, operator, genesis_hash}` |
| `GET` | `/v1/quotes` | `{quotes: [{give_asset, want_asset, rate_num, rate_den, min_give, max_give}]}`: it gives `give_asset` and wants `ceil(give × rate_num / rate_den)` of `want_asset` |
| `POST` | `/v1/firm` `{give_asset, want_asset, give}` | an in-tree swap offer of the library's, its coins held until it is completed, released or lapses (`offer_ttl_seconds`, 300 by default): `{swap, offer, give, want, expires_at}` |
| `POST` | `/v1/accept` `{swap, accept}` | completes the swap (the operator co-signs): `{swap, state: "done"}`, the same when asked again |
| `POST` | `/v1/release` `{swap}` | cancels a firm offer nobody took |
| `GET` | `/v1/swap/<id>` | where a swap stands |

Every coin it receives is refreshed in the operator's next round once it has rested
`settle_seconds`, so what it trades settles as the takers' coins do.

    node tooling/lsp/leaf-maker.mjs --config /etc/leaf-maker/maker.json --init   # once: draws its phrase
    node tooling/lsp/leaf-maker.mjs --config /etc/leaf-maker/maker.json

The configuration names the maker's own wallet and nothing else's. A `wallet` name, phrase file
or store that reads as a service or treasury wallet's (treasury, reserve, faucet, bridge, sbtc,
pool, fee, service, founder, drip) is refused at start.

```json
{
  "wallet": "leaf-maker-1",
  "mnemonic_file": "/var/lib/leaf-maker/mnemonic",
  "store_dir": "/var/lib/leaf-maker/store",
  "listen": "127.0.0.1:9979",
  "operator": { "server": "https://host/arca", "node_url": "http://127.0.0.1:18891/", "node_user": "user", "node_password_file": "/var/lib/leaf-maker/node-password" },
  "pairs": [ { "give": "<asset id>", "want": "<asset id>", "rate_num": "1", "rate_den": "1", "min_give": "10000" } ],
  "fee_margin": "2000", "board_keep": "100000",
  "offer_ttl_seconds": 300, "sync_seconds": 20, "settle_seconds": 600
}
```

### Its BTC desk (`leaf-maker-btc.mjs`)

With a `btc` section naming the socket of a Bitcoin Lightning node of the maker's own, the maker
also trades BTC for an asset and an asset for BTC, each in one hash-lock: the asset moves in the
operator's tree under a payment hash (the operator settles it between its own two wallets, so
the asset's own Lightning node is never in the path) and the BTC over Bitcoin Lightning under
the same hash. The hash is always the BTC receiver's and the asset's giver locks first, so
neither side can take what it gets before paying: the leaf received under the hash opens only
with the preimage, which comes out only when the BTC is paid. The maker pays BTC only once its
leaf under the wallet's hash is held for good (`lightning_receive_ready`); a wallet pays BTC to
the maker only once its own is. The asset must be one the operator serves over Lightning.
Swaps are kept in the store directory (`btc-swaps.json`), so a restart follows every one it
began.

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/v1/btc/firm` `{give_asset, want_asset, give, invoice?}` | `give_asset: "BTC"`: `invoice` is the wallet's Bitcoin invoice for `give` sat, and the answer's `invoice` the operator's, for `want` of the asset under the same hash. `want_asset: "BTC"`: the answer's `invoice` is the maker's Bitcoin invoice for `want` sat |
| `POST` | `/v1/btc/lock` `{swap, invoice}` | the maker gives the asset: `invoice` is the operator's, for the wallet's receive under the maker's hash, and the maker's leaves pay it |
| `POST` | `/v1/btc/paid` `{swap}` | the wallet paid: the maker follows at once |
| `POST` | `/v1/btc/release` `{swap}` | a firm offer nobody took |
| `GET` | `/v1/btc/swap/<id>` | where a swap stands |

Its quotes are in `/v1/quotes` beside the in-tree ones, BTC named `"BTC"` and counted in
satoshis.

```json
"btc": {
  "rpc": "/var/lib/leaf-maker/btc/regtest/lightning-rpc",
  "keep_sats": "100000", "invoice_seconds": 3600,
  "pairs": [ { "give": "BTC", "want": "<asset id>", "rate_num": "21", "rate_den": "10", "min_give": "5000" },
             { "give": "<asset id>", "want": "BTC", "rate_num": "11", "rate_den": "20", "min_give": "10000" } ]
}
```

A pair may say `"price": true` in place of its rate, priced from the maker's feed, whose
`assets` then names `"BTC"` too.

The desk pays a wallet's invoice only through a route it has read first (`payRoute` in
`../cln-rpc.mjs`, through the invoice's route hint when the wallet's node sits behind a private
channel): its fee, at most `max_route_fee_sats` (default 1000), is the maker's, and its whole lock
is what the maker's leaf received under the hash must outlast. What the desk gives of an asset is
boarded as an in-tree pair's is.

`leaf-maker.service` beside it is a systemd unit for it. The page reaches it at
`/leafmaker` on its own origin (a reverse-proxy route to `listen`), or at the URLs
`window.SEQ_LEAF_MAKERS` names. A maker of BTC runs as a second instance with its own wallet,
node and port, which the page reaches at `/leafmaker-btc`.
