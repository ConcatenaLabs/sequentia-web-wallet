# Hosted-SeqLN LSP (the "we run SeqLN for the user" backend)

This is the backend the wallet's Lightning module (`../../seqln.js`) commands to
deliver the **non-custodial instant-LN asset↔BTC DEX from a thin wallet**. It
implements the LSP / hosted-SeqLN model:

- **We host** the SeqLN node (liquidity, channels, routing).
- **The wallet holds the keys.** On unlock it brings an on-device wasm signer
  online over a wss Noise_XK link (the vendored SDK in `../../lightning/`). The
  hosted node has **no `hsm_secret`**: every commitment update is co-signed by
  the device, so the LSP can command routing but can never move channel funds.
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
| `POST` / `GET` | `/node/invoice`, `/node/invoice-status`, `/node/settle`, `/node/receive`, `/node/pay`, `/node/payhash` | invoices and payments on the user's own hosted node (HODL buy path, plain receive, pay) |
| `POST` / `GET` | `/channel/deposit`, `/channel/open`, `/channel/open/<id>`, `/channel/inbound/quote`, `/channel/inbound`, `/channel/close` | "Move to Lightning" channel funding, inbound-liquidity purchase (priced in the asset bought), cooperative close |
| `POST` | `/bridge/front`, `/bridge/hold`, `/bridge/asset` | the rail-crossing leg bridge: the LSP fronts a BTC-LN leg against the maker's confirmed on-chain BTC HTLC |

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
```

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
