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
| `POST` / `GET` | `/channel/deposit`, `/channel/open`, `/channel/open/<id>`, `/channel/inbound/quote`, `/channel/inbound`, `/channel/inbound/settle`, `/channel/close` | "Move to Lightning" channel funding, inbound-liquidity purchase (in a Sequentia asset from the LP at `SUBAS_LP_RPC`, or in BTC (`asset` `BTC`) from the testnet4 LP at `INBOUND_BTC_LP_RPC`; a request that names no `asset` is for what its `node_key`'s node holds, BTC for a Bitcoin node and its asset for a Sequentia one (`inboundRequestAsset` in `invoice-asset.mjs`), whose node id is the one in `CHANNEL_PEER_BTC_PROVISIONED`, its fee paid on testnet4 or, owed as a deferred debt by a swap that opened the room, over Lightning to that LP through `/channel/inbound/settle` (the LP invoices the debt under a `room-fee|<node key>|BTC|<ms>` label, and the debt is cleared once by what that invoice received); its channel is usable at once, because every hosted BTC node runs `zeroconf-from-lp.py` (`zeroconf.mjs`: in the config of a node provisioned or booted by this LSP, and started with `plugin start` on a running node before the LP opens room to it), which accepts a zero-confirmation channel from that LP's node id and from no other peer, so the node trusts the service not to double-spend that funding until it has a block (`ZEROCONF_PLUGIN=` empty turns this off, and the room is usable once a Bitcoin block confirms it), `/status` answering `funding.btc_room` where BTC is sold; priced in the asset bought, for the months the buyer chooses among `INBOUND_MONTHS` (default `1,3,6,12`; a request naming none gets `INBOUND_DEFAULT_MONTHS`, default 12): `max(floor, amount × yearly rate × months / 12)`, the yearly rate in basis points from `INBOUND_ANNUAL_BPS` (JSON keyed by asset id or label, `"BTC"` for bitcoin, e.g. `{"USDX":500,"BTC":100}`) or `INBOUND_FEE_BPS` for an asset it does not name, `inbound-price.mjs`; the purchase answers `expires_at`, until when the service keeps that channel open; for BTC between `INBOUND_MIN_SAT` and `INBOUND_MAX_SAT`, for an asset the node prices between `INBOUND_REF_MIN` and `INBOUND_REF_MAX` worth of it with a fee of at least `INBOUND_REF_FEE_FLOOR`, all three in reference atoms of the fee exchange rates, `inbound-limits.mjs`; a prepaid fee transaction pays for one purchase, recorded in `inbound-fees.json` as soon as the LP's wallet shows it (spent outputs included), and is accepted again only to retry that purchase or to buy less room on that node, without being priced again; a fee is good at the lowest price quoted with that node's key for that asset, term and at least that room within `INBOUND_QUOTE_HOLD_H` hours (default 168, kept in `inbound-quotes.json`), or today's, less `INBOUND_FEE_TOLERANCE_BPS` (default 1000) for a rate that moved; a fee not seen yet answers 402 with `paid: 0`, one too small 402 with `paid` and `least`; room the LP cannot fund from its confirmed coins of the asset, after `SUBAS_INBOUND_HEADROOM_BPS` and `SUBAS_INBOUND_RESERVE`, is refused in the quote (`lp_short`, with the `fundable` room) and by the purchase with 503, a prepaid fee already seen staying recorded for it; room the node already has from the LP in one channel, open or opening (`roomAlreadyThere` in `inbound-limits.mjs`, the same rule the purchase uses to answer `already_had_inbound`), is refused in a quote asked with a node key (`already_have_room`, with `receivable` and `pending`) before any fee is named, and a prepaid fee whose purchase opened nothing is not charged and stays waiting for the node's next room), cooperative close (to the node's own wallet unless a `destination` is named; the device signs a close only when it pays this side's balance to its own scripts or to a script of the wallet the page names to it with `approveCloseDestination`, which is how the wallet closes straight to its own address). `/channel/open` with `consolidate: true` first sends every coin of the asset on the user's node to a new address of the node's own, then funds the channel from that coin (`consolidate.mjs`). The device moves a node's coins only to its own addresses or into a channel the node opens |
| `GET` (no token) | `/stats/inbound` | What the room-to-receive service holds, sold and turned away, in aggregate, for the public page at `/liquidity` (`inbound-stats.mjs`): per asset the LP's free coins, the room it can sell now, the room locked in the channels it opened, utilization, a status (out under the smallest sale, low under 1,000 reference units sellable), sales and fees (all time and 30 days, at the price of the day), fees per day, deferred fees owed, purchases refused for lack of stock in the last 7 days, and the price list. Nothing in it names a node, channel, transaction or address; cached a minute. The books behind it sit in `PROV_DIR` beside `inbound-fees.json`: `inbound-sales.jsonl` (one line per channel actually opened), `inbound-refused.jsonl` (a quote asked with a node key, or a purchase, refused for lack of stock; once per node, asset and room in ten minutes) and `inbound-stock.jsonl` (hourly: free and locked per asset). A prepaid fee whose channel opened is marked so in `inbound-fees.json`: the quote asked with a node key names a fee that node paid for room never opened (`paid_waiting`), and a retried purchase whose room is open is answered as done. |
| `GET` (no token) | `/.well-known/lnurlp/<name>`, `/lnaddr/-/pay/<name>?amount=<msat>` | A wallet's payment name as a Lightning address (`lnaddr.mjs`, LUD-06 and LUD-16): the payRequest (its `callback`, `minSendable` and `maxSendable` from what the recipient's wallet said it takes, `metadata` with `text/identifier` `name@LNADDR_DOMAIN`), then the callback, which asks the recipient's open wallet for an invoice of exactly the amount and answers `{pr, routes: []}`; a wallet that is not open, or does not answer within ten seconds, is answered `{"status":"ERROR","reason":"The recipient's wallet is offline. Try again when it is open."}`. Both carry `Access-Control-Allow-Origin: *` |
| `GET` (no token) | `/lnaddr/<name>`, `/lnaddr/-/mine?pubkey=<hex>` | A receive code of the name's wallet for a Sequentia wallet paying it, with the name's key and the key's signature over the name, the domain and the code (`{pubkey, code, id, sig, fresh, reused}`): from the stock the wallet left, each handed out once; else, while the wallet is open, one it makes for the request; else the most recent again (`reused: true`, paid without its single-use part). Limited per name (past it: the most recent again) and per network, an IPv4 /24 or IPv6 /48 (past it: 429 "Too many lookups from your network. Try again in a minute."); the name a key holds |
| `POST` (no token) | `/lnaddr/-/register`, `/lnaddr/-/release`, `/lnaddr/-/stock`, `/lnaddr/-/wait`, `/lnaddr/-/answer` | The wallet's side, each signed by the name's key (BIP340 over `signedDigest` in `../../lnaddr.js`, which names the action, the domain, the name and the request): a name first come first served, one per key, kept with its key and its stock of signed codes in `PROV_DIR/lnaddr-names.json` (or `LNADDR_STORE`); `stock` adds and takes back codes (each signed, its id its hash, never one handed out before) and answers the ids still held, as `wait` does; `wait` is held up to 25 seconds and answers the payers' requests; an answer is checked against the request (a Bitcoin invoice for exactly the amount) before a payer sees it |
| `POST` | `/channel/start`, `/channel/complete`, `/channel/cancel` | a channel, Sequentia or BTC, funded by **one transaction of the wallet's own**, the coins never on the node. `start` runs `fundchannel_start` and answers the channel's funding address; the wallet builds and blinds a transaction paying it, and `complete` takes that transaction unsigned, checks from the node's own `decodepsbt` that it pays the channel exactly the amount, in its asset, in the clear and with every other output already blinded (`external-funding.mjs`), then runs `fundchannel_complete`, which on Sequentia checks no amount itself. The wallet signs and broadcasts only after `complete` answers with the funding txid, so the peer's signature on the first commitment exists before any coin moves. `cancel` runs `fundchannel_cancel` and is refused once the chain knows the funding transaction. For a BTC channel the check reads bitcoind's `decodepsbt` (`btcFundingProblem`). The job is polled at `/channel/open/<id>`. Needs `ELEMENTS_CLI` and `SEQ_RPC_PORT` for Sequentia channels, `BTC_CLI` and `BTC_RPC_PORT` for BTC ones |
| `GET` | `/node/history?node_key=` | what the user's hosted node settled over Lightning, newest first, from the node's own records (`node-history.mjs`): invoices paid to it (`listinvoices`), holds it settled (the hold plugin's datastore entry, with the time and amount from bookkeeper's `invoice` credit, else the amount from `listhtlcs`), and payments it made by invoice or by bare hash (`listpays`, complete). Each item: `dir`, `kind` (`invoice`, `hold`, `pay`), `asset`, `amount_msat`, `fee_msat`, `at`, `payment_hash`, `description`, `note`; `unread` names a record the node could not give. No preimage or label is served |
| `POST` | `/node/swap-note` | `{ node_key, payment_hash, note: { pay: { asset, atoms, rail }, recv: { asset, atoms, rail }, title } }`: the wallet's account of a settled swap, kept in the user's node's datastore under `[seqwallet-swap, <hash>]` and returned as the `note` of that hash's items in `/node/history`. Refused (409) for a hash the node settled nothing under |
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
asks for just before. Every hosted node's invoice, either chain, is made with
`exposeprivatechannels=true`, so it carries a route hint over that unannounced
inbound channel: a node with a channel flagged for announcement leaves its
unannounced ones out of its hints, and without a hint no other wallet's node can
reach it before its channels are announced. When a payment finds no way to the
payee, `/node/pay` answers `502` with a `reason`: `payee_cannot_receive` (the
invoice offers no way in: the payee has no room to receive that amount yet) or
`no_route`, beside the node's own `error`. The rules are in `invoice-asset.mjs`.

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

Payment names are on unless `LNADDR=0`. `LNADDR_DOMAIN` is the names' domain (default
`sequentiatestnet.com`), `LNADDR_BASE` the public root the callback is built on (default
`https://<domain>/lsp`), `LNADDR_MIN_SAT` and `LNADDR_MAX_SAT` bound what a payer may send
beyond the wallet's own limits. The proxy in front sends `/.well-known/lnurlp/*` to the LSP
as it is (no prefix stripped), beside `/lsp/*`.

### Restarts leave the hosted nodes running

Each provisioned node's `lightningd` and its ws relay run apart from the LSP, so an LSP restart or
deploy stops neither: the wallets' Lightning stays up, and a swap in flight keeps its node. At its
next start the LSP re-attaches to every node in the registry that answers (`[lsp] boot re-attach:
N/M hosted node(s) already running`).

Under systemd that takes more than a detached child, since stopping a service stops every
process in its control group. When the LSP runs as a systemd service as root, each node and each
relay therefore starts in a transient scope of its own in `seqln-hosted.slice`
(`systemd-run --scope`); `systemd-cgls seqln-hosted.slice` lists them. Anywhere else they are
plain detached children. The start log says which (`[prov] hosted nodes run in scopes of their
own …` or `… as detached children of the LSP (why)`). `LSP_NODE_SCOPE=1` or `0` overrides the
choice and `LSP_NODE_SLICE` names another slice. The testnet's unit is `lsp-b5b1.service` in
sequentia-testnet-ops (`systemd/lsp-b5b1.service`). Its own work (seqob-cli runs, node commands) stays in its control
group and stops with it, so a restarted LSP never races an old run of the same swap.

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
| `POST` | `/v1/accept` `{swap, accept}` | completes the swap (the operator co-signs): `{swap, state: "done"}`, the same when asked again. When the operator refuses the completion, nothing is co-signed and the offer is gone: `409 {error, swap, gone: true, code, whose, coin, offer?}`, where `whose` names the side whose coin the operator refused (`"taker"` when the wallet's own coin was spent elsewhere) and `offer` is a new firm offer of the same give, priced and checked as `/v1/firm` prices and checks one and made only when the live price asks no more than the gone offer did, shaped as `/v1/firm`'s answer; without it the taker asks for a new price. The same answer when asked again |
| `POST` | `/v1/release` `{swap}` | cancels a firm offer nobody took; answers `{swap, state: "releasing"}` at once and cancels ahead of the maker's upkeep and of any later firm offer |
| `GET` | `/v1/swap/<id>` | where a swap stands |

Every coin it receives is refreshed in the operator's next round once it has rested
`settle_seconds`, so what it trades settles as the takers' coins do; and every one at once when
it holds more than half its instant budget out of round. Each asset is settled in a participation
of its own, its new value cut into working coins (below).

It never gives the last free coin of an asset it quotes to a round, so the asset stays offered
while the rest settles. Of each asset, what stays free beside the coins given must fill the
smaller of its largest quote (a swap pays from one coin: its largest free coin whose worth fits
the room left in its budget) and a working coin. Otherwise the coin its largest quote is sized on
stays out and the rest goes now; that coin goes in a later turn, once nothing of the asset is in a
round and something else free of it quotes. An asset whose only free coin is itself due cannot
both keep it and settle it, so the maker splits it first: it pays itself half of the coin out of
round, then settles one half and keeps the other until the first is back. A taker meets half the
quote for that minute, never none. (A coin smaller than twice the smallest quote of its asset is
kept whole; a coin whose worth fits no room left quotes nothing and settles with the rest.) A cut into
working coins follows the same rule: it waits while its coin is the only one that would quote.

It takes in no asset whose refreshes the operator holds back. It reads the operator's
`/v1/info` every minute, straight from the operator rather than through the library. An asset
showing `in_flight` at or past its `in_flight_cap` gets no quote and no firm offer (in-tree or
at the BTC desk) that wants it, and such an offer is refused with a sentence that names the
asset. A coin of that asset received out of round would stay out of round until the cap frees,
and it would count against the maker's instant budget the whole time. The maker keeps giving that
asset and trading every other pair, and takes it in again once the operator's info shows it under
its cap. Coins it already holds out of round when an asset reaches its cap are counted aside (see
"Its instant budget"), so they stop only that asset's own pairs.

Every `forfeit_seconds` (30 by default) it hands over the forfeits of each of its refreshes whose
round the operator holds for them (the library's `hand_over_forfeits`), ahead of everything else it
has queued. The operator broadcasts a round of batches without a sweep only once every
participation in it has handed its forfeits over, and drops it when they have not come within its
window (ten minutes), voiding the refresh and keeping everyone else in that round waiting; the
maker's own pass of a sync, its resting desk and its boards can take longer than that.

A coin of a round is refreshed again only when it has to be, since each such refresh keeps the
operator's capital out until the lowest node the coin leaves comes back: the operator fronts the
new coin meanwhile, and that counts against the asset's in-flight cap. It keeps about `max_coins`
live coins of an asset (32 by default, or per asset), not counting its resting orders, which it
never merges: a refresh of an order's coin cancels the order, and the resting desk would rest it
again from another coin, which the operator fronts anew. Past that it merges coins in the operator's
next round, 64 at most a pass: boards first, since merging one fronts nothing (the operator's
forfeit of a board pays it back at once), then coins of a round of at most `coin_size`, down to
three quarters of the cap. A merge's own coin is larger, and is not merged again at every coin that
comes in. At twice the cap it boards no more of the asset and merges its smallest coins of all, as
few as bring it back under. With `merge_max_coins` (a number, at least 2), the coins one pass merges
hold at most that many `coin_size` together; and with an instant budget, no merge holds more than
a working coin and only crumbs are merged (below).

### Working coins

A swap pays from one coin. A coin of a round or a board then puts its whole worth out of round
until the maker's next round: its change, and what the taker pays in its place. A coin already out
of round (one it received, or a swap's change) puts nothing more out of round, and the library pays
from such a coin first. So for every asset it gives, the maker keeps four working coins worth at
most a quarter of its instant budget shared among the assets it gives, at its node's rates, and the
rest in reserve coins: the first trade in every asset together puts at most a quarter of the
budget out of round, and a run of small trades never fills it. The size is worked out from the budget at every pass, never a
number of atoms in the configuration, so a price move changes it at once. The library pays a swap
from the smallest coin that pays it alone (the arca CLI README, `swap offer`), so small swaps reach
the working coins and never a reserve coin.

- **What a coin is.** Beside the size, a coin is a crumb (under half a working coin), a working
  coin (from half a working coin up to one that cannot be cut into a working coin and half one,
  once the refresh's fee of at most 1% is paid), or a reserve (larger). The cut and the merge read
  this one rule, so neither takes what the other made. The size moves by a few atoms whenever a
  rate or the budget does; a coin cut at one minute's size stays a working coin until the size
  falls by about a third or doubles, so a maker whose coins are shaped makes no refresh while
  nobody trades with it.
- **Cutting.** An asset with fewer than four working coins has its smallest reserve coin of a round
  or a board cut into as many of the ones missing as it holds and a rest of at least half a
  working coin (never less than the asset's smallest quote, its pairs' `min_give`), in the
  operator's next round (the library's refresh in pieces, `quote` and `participate` with `piece`
  and `pieces`), one cut at a time, read from the coins' state. A cut never leaves a crumb. A coin the library takes back from a refresh that waited at
  the operator is given up again ten minutes later, whether it was being cut or settled. Working
  coins are never cut by a payment to itself out of round (only an asset's lone due coin is split
  so, above). A library that does not cut a
  refresh into pieces is detected from its quote, and nothing is given up.
- **Settling and merging.** What it received is settled into working coins and a reserve of the
  rest. Past `max_coins` only crumbs and small boards are merged, never a working coin or a
  reserve; no merge makes a coin larger than a working coin, and no board is larger than one.
- **Quotes.** It quotes of an asset at most its largest live coin whose spend fits the room left in
  its budget (a coin out of round always does), and a firm offer is sized the same way, so a price it shows is a price it
  confirms. The room is worked out from its latest reading of its coins: the budget less what it
  holds out of round and what its open offers hold. After an offer or a completion it quotes
  nothing until that reading is renewed. With no coin that fits, the asset is not quoted until its
  next round, and an asset its node does not price is not quoted at all.
- **Why an asset is not offered.** Whenever an asset it gives stops being offered, the maker logs
  one line saying why (`offers no USDX now: …`): it holds none, every coin is in a round, every
  coin is held by an open offer or a lock, its node does not price it, or no coin fits the room
  left in its budget. It logs `offers USDX again` when that ends.

The library reads what each command needs, by state: the coins the maker traded away and the
participations it completed, thousands after a few days of trading, are not read again. The
maker asks for the coins it holds (`coins` with `held`), each as the store holds it (`brief`: no
dates, notes or exit fees, whose reads of the chain held the library for seconds), once a pass:
it counts, settles and merges from that reading, and reads again only when the pass rested,
boarded or cancelled something. It follows its open offers by their ids (`swaps` with `swaps`),
not through every offer it ever made. Its sync leaves out the catch-up
between stores of one phrase (`catch_up: false`): it is the only store of its phrase, and the
catch-up would read every coin ever served to its mailbox to find that out.

The library answers one command at a time, so a taker's firm offer waits behind whatever the
maker's own upkeep is running. Quotes are served from the last reading and never wait: before its first reading, just after it starts, it quotes nothing. A firm
offer, in-tree or at the BTC desk, is sized on that reading too, while it is under five minutes old.
It then asks the library for one command, the offer, which goes ahead of every queued command
(the library refuses an offer it cannot pay). An acceptance goes ahead the same way, and the
reading taken after either waits its turn in the upkeep. A read of `/v1/quotes` holds the
upkeep's next commands for 90 s (at most once every three minutes), so the firm offer that
follows finds the library free. The upkeep leaves the library idle at least as long as its last
pass held it. The resting desk follows the orders it keeps resting by their ids, up to 64 a
command, each command one read of the operator; its own orders' records come from the library's
store (`order_resting` with `brief`), never by asking the operator after every order it ever
rested. It never rests an order at
or within `rest.guard_bps` (10 by default) of the pair's best bid on the relay, every rail of the
on-chain book taken together, and it cancels, to rest again at the feed's rate, an order the
feed's mid has moved to within `rest.guard_bps` of. A level cancelled to be repriced is rested
again at what its coin came back with (its value less the cancel's fee, when that is within a
thousandth of the level), so the library rests it from that coin alone and the operator fronts no
change beside the order. Every command slower than
`slow_ms` (2,000 by default) is logged (`slow <command> <ms> ms {detail}`), answered or refused, which names what a slow firm offer
waited behind; the detail is the library's cost of the command (milliseconds and requests to
the node and to the operator, for the re-check before it and for the command itself) and the
milliseconds each part of that re-check took, and for a sync what each of its steps cost. The
upkeep's sync leaves the watchtowers' deposits and withdrawals to a command of their own run right
after it (`deposits`), so a firm offer waits for one of the two at most. A part
or step that asked the node more than fifty reads one at a time names them by method (`alone`), a
command says how long it waited for the operator's answers (`operator_ms`), and a sync step over
a second says it too, by call (`operator_calls`, `[count, ms]`).
Each firm offer it makes is logged with the time from the request to the answer
(`firm <swap> gives … for … in <ms> ms`), so its firm offers' latency is read from the journal.
Every ten minutes (`times_seconds`) one line sums up every command it ran in that time, fast or
slow: `times {"<command>": {"n", "p50", "p95", "max", "waited_max"}}`, in milliseconds, where
`waited_max` is the longest a command of that name waited in the queue before it ran.

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
  "offer_ttl_seconds": 300, "sync_seconds": 20, "settle_seconds": 600, "forfeit_seconds": 30, "max_coins": 32, "merge_max_coins": 4,
  "instant_budget": "0.1"
}
```

### Its instant budget

What the maker receives in a swap rests on an out-of-round lineage until its next round refreshes
it, and a double-sign by the operator could take it, together with every other counterparty's.
So the maker holds unrefreshed at most a share of the operator's bond (`instant_budget`, default
`"0.1"`, a tenth; `"off"` for none), which it sets in its leaf library at start (`arca
instant-budget`; the arca CLI README). The library values the bond at the maker's node's rate for
the bond's asset, so a lower price lowers the budget at once, and takes the lower of this share
and the one the operator suggests in `info.bond`. On every pass the maker reads the room left
(`bond`'s `instant_budget.room_atoms`) and cuts its in-tree quotes to it: a cut quote carries
`after_next_round: true`, and a pair cut to nothing is named in the answer's `after_next_round`
list. A firm offer past the room is answered 409 "the maker takes this much after its next round"
(`after_next_round: true`), as is the library's own refusal past the budget, which also has the
maker refresh every coin it received at once and log what it holds out of round by state and asset
("holds out of round, by its last reading: …"). A wallet then says the rest can be traded in a few
minutes.

What the maker holds out of round of an asset whose refresh would take the operator's in-flight
amount past the asset's cap (`in_flight` plus what it holds of it, over `in_flight_cap`, in
`/v1/info`) waits out of round until earlier refreshes come back, whatever the maker does. Counted
in the budget like any other coin, it would fill the room every other pair trades in. So on each
pass the maker weighs those coins at its node's fee exchange rates (`getfeeexchangerates`, as the
library weighs them) and widens its own share by what they are worth over the bond's value. The
widening stays while the maker holds at least that much of the asset out of round, since the cap
freeing lets the refresh run only in the operator's next round, and it is kept in the store
(`held-back.json`) so a restart does not forget it; once they are refreshed the share goes back to
`instant_budget`. Each change is logged ("held out of
round while the operator refreshes no more of it: …"). The library still takes the lower of this
share and the operator's suggestion, and refuses whatever the bond does not cover, so the widening
never goes past either; an asset the node does not price widens nothing.

### Its trades in the market's trade log (`trade-report.mjs`)

SeqDEX's relay cannot watch an in-tree swap or a BTC desk trade, so the maker reports each one
it settles (`POST /v1/trades/report` on the relay; seqdex `daemon/README.md`, "Market data"),
signed with its relay key: an in-tree swap once `/v1/accept` completes it (`leaf-maker`), a desk
swap once it is done (`btc-gateway`). The relay named by `"report": { "relay": "http://…" }`, else
the resting desk's `rest.relay`, gets them; with neither, nothing is reported. A report waits in
the store directory (`trade-reports.json`) until the relay answers. The relay records reports
only from the keys it lists in `-trade-reporters`; the maker prints its key with

    node tooling/lsp/leaf-maker.mjs --config /etc/leaf-maker/maker.json --reporter-key

Each instance (the in-tree maker, the maker of BTC) has its own store and so its own key.

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
| `POST` | `/v1/btc/invoice` `{swap}` | the maker gives the asset and has locked: a new Bitcoin invoice under the same hash and for the same amount when the one given runs out within half an hour, `{swap, invoice, expires_at}` |
| `GET` | `/v1/btc/swap/<id>` | where a swap stands |

Its quotes are in `/v1/quotes` beside the in-tree ones, BTC named `"BTC"` and counted in
satoshis.

```json
"btc": {
  "rpc": "/var/lib/leaf-maker/btc/regtest/lightning-rpc",
  "keep_sats": "100000", "invoice_seconds": 14400,
  "pairs": [ { "give": "BTC", "want": "<asset id>", "rate_num": "21", "rate_den": "10", "min_give": "5000" },
             { "give": "<asset id>", "want": "BTC", "rate_num": "11", "rate_den": "20", "min_give": "10000" } ]
}
```

The maker's Bitcoin invoices run `invoice_seconds` (four hours by default) and are made under a
preimage the desk draws and keeps with the swap. A wallet pays only once the asset it receives
is final, after Bitcoin blocks, which can take longer than that. The wallet then asks for
`/v1/btc/invoice` and pays the new invoice only if it carries the same hash, the same amount, and
no longer a lock or higher fee than the trade allowed. Otherwise the trade comes back, nothing
paid.

A pair may say `"price": true` in place of its rate, priced from the maker's feed, whose
`assets` then names `"BTC"` too.

The desk pays a wallet's invoice only through a route it has read first (`payRoute` in
`../cln-rpc.mjs`, through the invoice's route hint when the wallet's node sits behind a private
channel): its fee, at most `max_route_fee_sats` (default 1000), is the maker's, and its whole lock
is what the maker's leaf received under the hash must outlast. What the desk gives of an asset is
boarded as an in-tree pair's is.

`leaf-maker.service` beside it is a systemd unit for it. It runs the maker on node 22, from a
copy at `/opt/leaf-maker/node22` that the maker's own user can read. The page reaches it at
`/leafmaker` on its own origin (a reverse-proxy route to `listen`), or at the URLs
`window.SEQ_LEAF_MAKERS` names. A maker of BTC runs as a second instance with its own wallet,
node and port, which the page reaches at `/leafmaker-btc`.
