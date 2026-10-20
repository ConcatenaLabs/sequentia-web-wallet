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
| `GET` | `/status` | `{node_id, network, channels:[{peer_id, asset_label, spendable_units, receivable_units, state}]}` |
| `GET` | `/rails` | which settlement rails are usable per asset and side |
| `GET` | `/book`, `/book/unified`, `/lnbook` | the on-chain cross book, the unified rail-agnostic book, the pure-LN book |
| `POST` | `/offer` | relay a wallet-signed sub-asset offer (the LSP only forwards the bytes) |
| `POST` / `GET` | `/swap`, `/swap/<id>` | execute a swap (`{side:'buy'|'sell', asset, amount}`); an over-cap, anchor-gated mixed swap runs asynchronously and is polled by id |
| `POST` / `GET` | `/node/provision`, `/nodes/list`, `/node/list`, `/node/getinfo`, `/node/onchain` | per-device hosted-node provisioning and inspection |
| `POST` / `GET` | `/node/invoice`, `/node/invoice-status`, `/node/settle`, `/node/receive`, `/node/pay`, `/node/payhash` | invoices and payments on the user's own hosted node (HODL buy path, plain receive, pay); a payment the device declines is answered `403 {ok:false, declined:true, error}` before any HTLC exists |
| `POST` / `GET` | `/channel/deposit`, `/channel/open`, `/channel/open/<id>`, `/channel/inbound/quote`, `/channel/inbound`, `/channel/close` | "Move to Lightning" channel funding, inbound-liquidity purchase (priced in the asset bought, for the months the buyer chooses among `INBOUND_MONTHS` (default `1,3,6,12`; a request naming none gets `INBOUND_DEFAULT_MONTHS`, default 12): `max(floor, amount × yearly rate × months / 12)`, the yearly rate in basis points from `INBOUND_ANNUAL_BPS` (JSON keyed by asset id or label, `"BTC"` for bitcoin, e.g. `{"USDX":500,"BTC":100}`) or `INBOUND_FEE_BPS` for an asset it does not name, `inbound-price.mjs`; the purchase answers `expires_at`, until when the service keeps that channel open; for BTC between `INBOUND_MIN_SAT` and `INBOUND_MAX_SAT`, for an asset the node prices between `INBOUND_REF_MIN` and `INBOUND_REF_MAX` worth of it with a fee of at least `INBOUND_REF_FEE_FLOOR`, all three in reference atoms of the fee exchange rates, `inbound-limits.mjs`; a prepaid fee transaction pays for one purchase, recorded in `inbound-fees.json`, and is accepted again only to retry that purchase or to buy less room on that node; room the LP cannot fund from its confirmed coins of the asset, after `SUBAS_INBOUND_HEADROOM_BPS` and `SUBAS_INBOUND_RESERVE`, is refused in the quote (`lp_short`, with the `fundable` room) and by the purchase with 503 before anything is charged), cooperative close (to the node's own wallet unless a `destination` is named; the device signs a close only when it pays this side's balance to its own scripts or to a script of the wallet the page names to it with `approveCloseDestination`, which is how the wallet closes straight to its own address). `/channel/open` with `consolidate: true` first sends every coin of the asset on the user's node to a new address of the node's own, then funds the channel from that coin (`consolidate.mjs`). The device moves a node's coins only to its own addresses or into a channel the node opens |
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
inbound-liquidity paths; `lsp-server.mjs` is the reference for those.

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
// optional: the device's payment limits, in each asset's own atoms per period
window.SEQ_LN_PAYMENT_LIMITS     = { default: 10000000, period: 86400,
                                     assets: { '<asset id>': 5000000, btc: 2000000 } };
```

The payment limits are enforced by the device signer, not by this service: the
device approves a payment only when its amount, with a routing-fee allowance,
fits in what the limit leaves for the period, and charges every HTLC it signs to
its channel's asset. `null` means no limit; with the global unset the device's
default applies (10,000,000 atoms of each asset per day). Set a limit for each
asset to suit its value.

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
