# Architecture

How the modules of the Sequentia web wallet fit together. Read the
[README](../README.md) first; this document is for people modifying the code.

The app is a single page of vanilla-JavaScript ES modules with no build step of its own.
`index.html` owns the DOM, the wallet lifecycle, and the shared state; every other module is
DOM-light or DOM-free and receives what it needs through an `init*(ctx)` call.

## Module graph

```
index.html  (app shell: boot, tabs, balances, send/receive, fees, stake + pools, history, OpenAMP, Sign, QR)
 ├─ pkg/lwk_wasm.js        SWK WASM: Signer/Wollet/EsploraClient/PSET + HTLC, covenant, delegation,
 │                         CoinJoin and OpenAMP helpers (untracked)
 ├─ btc.js                 vendored @scure/btc-signer + bip32/bip39: the Bitcoin testnet4 leg
 ├─ jsqr.js                vendored jsQR (QR decoding; classic script, not a module)
 ├─ swap.js                Trade tab: composer, routing, Market/Limit, covenant order placement
 │   ├─ seqob.js           order-book protocol: wire codec, offer sigs, Crypter, REST + WS lift
 │   │   └─ noble-ciphers.js  vendored @noble/ciphers (AES-256-GCM for the E2E layer)
 │   ├─ covenant.js / covenant-order.js / covenant-flow.js / covenant-fill-host.js
 │   │                     SeqOB passive-CLOB covenant: leaf + witness builders, place/watch flow,
 │   │                     pure composer glue, raw-FILL seam into wasm
 │   ├─ ln-rail.js         per-asset Lightning-rail gating (a rail is offered only with a real channel)
 │   ├─ submarine.js       mixed-rail (submarine) swap state + persistence
 │   ├─ subswap.js         P2P submarine taker + LSP leg-bridge client
 │   ├─ sbtc.js            SBTC custody-bridge client (address allocation only)
 │   └─ tooling/lsp/{settlement-router,unified-book,bridge-driver}.mjs   shared with the backend
 ├─ coinjoin.js            Mix tab: coin selection, ownership proofs, verify-before-sign
 │   ├─ blindsig.js        vendored from seqcj: Chaum RSA blind signatures
 │   └─ coinjoin-protocol.js  vendored from seqcj: the participant half of the round protocol
 ├─ xswap.js               cross-chain taker, forward  (pay BTC  -> receive asset)
 ├─ xrswap.js              cross-chain taker, reverse  (pay asset -> receive BTC)
 ├─ xmaker.js              in-browser cross-chain maker (both directions)
 │     (all three ride xcourier.js: sealed courier sessions over the relay
 │      WebSocket, keyed with seqob's Crypter)
 ├─ seqln.js               Lightning: LSP HTTP client + device-signer orchestration
 │   ├─ seqln-keys.js      m/1017'/... derivation of the two device identities
 │   └─ lightning/seqln-signer-sdk.js + lightning/pkg/   vendored SeqLN device signer (WASM, tracked)
 └─ tooling/lsp/           the hosted-SeqLN LSP backend + provisioning/harness scripts (Node)
```

`index.html` wires the swap modules together through a context object (`initSwap({...})`)
carrying the WASM classes, `wollet`/`signer`/`client` accessors, DOM helpers, asset metadata
and balance functions, reference-currency helpers, fee rates, and two bridges: `xroute`
(to xswap/xrswap/xmaker) and `ln` (to seqln.js).

## The two chains

One BIP39 phrase drives everything:

- **Sequentia**: `Signer`/`Wollet` from `pkg/` with `Network.sequentiaTestnet()`, synced by
  `EsploraClient.fullScan()` against `/api`. The descriptor is `wpkhSlip77Descriptor()`.
- **Bitcoin testnet4**: `btc.js` derives BIP84 keys (`m/84'/1'/0'/{0,1}/i`) from the same
  seed and scans `/testnet4/api` directly. Sends are built and signed with
  `@scure/btc-signer`.

Because Sequentia's default addresses are unblinded and use Bitcoin's bech32 form, the same
`tb1...` string is valid on both chains. The receive index is cycled jointly: after each sync
the next index is the max of the next-unused index on either chain, so one shared address
sequence serves both. Confidential (`tsqb1...`) addresses are a per-toggle opt-in on the
Receive tab only. The same tab reveals the shared account key — `keyoriginXpub(Bip.bip84())`
off the wasm `Signer`, falling back to the `btc.js` account node when a `pkg/` build predates
`Bip` — as an extended key or as a checksummed descriptor pair (`descriptor.js`). The pair is
emitted as `/0/*` and `/1/*` rather than one multipath `<0;1>` descriptor, which sequentiad
rejects.

HTLC keys for cross-chain swaps come from dedicated branches: the Sequentia side from
`signer.htlcKeypair()` (`m/3/0`; it was also the original OpenAMP identity, now kept read-only
as a legacy AID), the Bitcoin side from `m/84'/1'/0'/2/{0,1}` (claim/refund). The current
OpenAMP identity and enclave-signing key is `m/5/0` inside the wasm `Signer`.

## Backend surface (all same-origin relative paths)

| Path | Used by | Purpose |
|---|---|---|
| `/api` | index.html, xswap/xrswap/xmaker | Sequentia Esplora REST (scan, broadcast, outspends) |
| `/testnet4/api` | index.html (btc leg), xmaker | Bitcoin testnet4 Esplora REST |
| `/prices` | index.html | per-asset USD prices for reference-currency display |
| `/feerates` | index.html | the node's fee-asset acceptance set (`getfeeexchangerates`): `{"bitcoin"\|ticker\|hex: rate}`, tSEQ keyed `"bitcoin"` |
| `/faucet` | index.html | POST, testnet funds to the current address |
| `/registry/index.minimal.json` | index.html | asset-metadata index (override: `window.SEQ_REGISTRY_URL`) |
| `/seqob` + `/seqob/v1/ws` | seqob.js, xcourier.js | order-book relay REST + the swap courier WebSocket |
| `/dex` | swap.js, xswap.js | the SeqDEX daemon, market seeding only |
| `/anchor/<blockhash>`, `/anchorstatus` | xmaker.js | anchor height / certification for the maker's reveal gate |
| `/openamp` | index.html | OpenAMP REST (`/v1/users`, `/v1/assets`, `/v1/transfers`, balances, deposit addresses) |
| `/lsp`, `/lsp-ws-asset`, `/lsp-ws-btc` | seqln.js | hosted-SeqLN LSP HTTP API + per-node signer WebSockets |
| `/coinjoin` | coinjoin.js | seqcj CoinJoin coordinator (override: `window.SEQ_COINJOIN_URL`); the Mix tab reports it missing |
| `/sbtc` | sbtc.js | SBTC custody bridge: peg-in / peg-out address allocation for offline-resting BTC limit orders |
| `/pools/pools.json` | index.html | the staking pool board's feed (pools to delegate to) |

Every backend beyond the two Esplora APIs is optional at runtime: fetch failures degrade the
corresponding feature instead of breaking the wallet.

## Configuration globals

Set on `window` before the module script runs (index.html sets the LSP block for the live
deployment; everything else defaults to same-origin paths):

| Global | Default | Meaning |
|---|---|---|
| `SEQ_SEQOB_URL` | `origin + '/seqob'` | order-book relay base |
| `SEQ_DEX_BASE` | `origin + '/dex'` | SeqDEX daemon base (market seeding) |
| `SEQ_XDEX_BASE` | falls back to `SEQ_DEX_BASE` | cross-chain daemon base (market seeding) |
| `SEQ_COINJOIN_URL` | `origin + '/coinjoin'` | seqcj coordinator base |
| `SEQ_REGISTRY_URL` | `/registry/index.minimal.json` | asset registry index |
| `SEQ_LSP_URL` | `origin + '/lsp'` | LSP HTTP API |
| `SEQ_LSP_TOKEN` | unset | LSP bearer token (interim shared demo token on the live page) |
| `SEQ_LSP_WS_ASSET` / `SEQ_LSP_HOST_PUBKEY_ASSET` | unset | asset-node signer WebSocket + pinned Noise responder key |
| `SEQ_LSP_WS_BTC` / `SEQ_LSP_HOST_PUBKEY_BTC` | unset | btc-node signer WebSocket + pinned key |
| `SEQ_LSP_SDK` | `./lightning/seqln-signer-sdk.js` | signer SDK path (dynamic import) |
| `SEQ_LSP_POLICY` | `permissive` | device-signer policy (`enforce` refuses non-co-signed movement) |
| `SEQ_LSP_FRONT_CAP` | `0.0005` BTC | LSP instant-front cap for mixed swaps |
| `SEQ_ONCHAIN_CONF` | `{n:1, t:'~10 min'}` | on-chain confirmation estimate for the timing banner |
| `SEQ_LSP_DEV_KEY_ASSET/_BTC`, `SEQ_LSP_DEV_SEED_ASSET/_BTC` | unset | dev overrides pinning device keys against a fixed harness |

A Lightning leg is **enabled** only when both its WS URL and host pubkey are set; with neither
node enabled the module never loads the WASM and the UI shows no Lightning surface at all.

## Trading protocols

### Same-chain (swap.js + seqob.js)

Offers are protobuf messages (`seqob.v1.Offer`), deterministically encoded and ECDSA-signed by
the maker; `fetchBook()` verifies every row and drops forgeries, so the relay is untrusted for
integrity. Taking an offer (`seqob.lift`) opens the relay WebSocket, exchanges
`start_lift`/`lift_accepted`, then runs the swap handshake as AES-256-GCM-sealed frames keyed
by ECDH between an ephemeral taker session key and the maker pubkey **from the signed offer**
(a relay substituting keys aborts the session). Settlement is one PSET: the taker builds a
`SwapRequest` via `wollet.seqdexSwapRequest(...)`, the maker co-signs, the taker finalizes,
signs, and broadcasts.

Placing a same-chain order does not rest a signed intent that needs the maker back: it funds
a SeqOB passive-CLOB **covenant** (`covenant.js` derives the tapscript leaf and scriptPubKey,
`covenant-order.js` the place/watch-for-fill flow, `covenant-flow.js` the composer glue). The
covenant enforces the price from transaction introspection, so anyone who crosses it fills it
with one transaction, even while the wallet is closed. Filling from the browser goes through
`covenant-fill-host.js`, which hands the byte-verified recipe to wasm `buildCovenantFillTx`
(a taproot script-path input with no signature next to the taker's own key-path inputs);
cancelling spends the covenant back with `buildCovenantRefundTx`. Asset ids cross a byte-order
boundary here (display order in the wallet and relay pair, internal order in the leaf and
`CovenantTerms`); `covenantDerivationIds()` in `swap.js` is the named conversion.

The maker/session identity is a per-browser secp256k1 key in `localStorage['seqobMakerKey']`.
It signs resting offers and derives courier session keys; it never controls funds.

### Cross-chain HTLC (xswap.js, xrswap.js, xmaker.js over xcourier.js)

Both directions are whole-offer (no partial fills), one lift at a time per maker, and speak
JSON messages sealed with the same Crypter through `xcourier.js` sessions. Redeem scripts are
built by the WASM helper `buildSeqHtlcRedeemScript` (byte-identical on both chains; P2SH on
Bitcoin). Locktime invariant: the secret-holder's chain lock expires first (`T_seq < T_btc`;
maker defaults `T_btc = btc tip + 100`, `T_seq = seq tip + 240`).

- **Forward** (taker pays BTC for an asset): taker generates the secret, funds the Bitcoin
  P2SH leg, and reveals the preimage only by claiming the Sequentia leg, after verifying the
  asset/amount on-chain and the **anchor gate**: the Sequentia leg's block must anchor at or
  above the Bitcoin leg's height. The maker learns the preimage from the taker's on-chain
  claim and collects the BTC leg.
- **Reverse** (taker pays an asset for BTC): the maker holds the secret and funds the Bitcoin
  leg first; the taker verifies it, waits for its confirmation, then funds the Sequentia leg.
  The maker claims the asset (revealing the secret) only after its own self-derived anchor
  gate (anchor height, `/anchorstatus`, and quorum certification when the explorer exposes
  it) plus a no-reveal margin before `T_seq`; the taker reads the preimage from the chain and
  claims the BTC leg. Secrets are trusted from chain data, not from courier messages
  (a couriered `secret_revealed` is accepted only if it hashes to H).

Refund paths are ordinary timelocked spends on the respective chain and never reveal the
secret. Sequentia-side claim/refund fees are paid **in the asset being moved**, converted at
the node's published rate (any-asset fees, no tSEQ needed to rescue a swap).

In-flight state (secret, keys, legs, timeouts) is persisted to `localStorage` the moment real
funds are committed, and resumed on load: takers re-enter the stepper (`hasInFlight()`),
`resumeCrossMakers()` relaunches maker settlement watchers for at-risk records (claim with an
on-chain-revealed secret, or the safe refund path), and terminal records are cleaned up.

### Lightning (seqln.js + lightning/ + tooling/lsp/)

Two keyless hosted SeqLN nodes (asset + btc legs) are each co-signed by an on-device signer:
the vendored WASM (`lightning/pkg/`) implements the CLN hsmd protocol behind a BOLT-8
Noise_XK transport (the browser is the initiator; the host's static key is pinned). Device
identities derive from the wallet phrase in `seqln-keys.js`:

| Path | Purpose |
|---|---|
| `m/1017'/0'/0'` | asset-node Noise transport key |
| `m/1017'/0'/1'` | btc-node Noise transport key |
| `m/1017'/1'/0'` | asset-node signing seed (determines that node's LN identity) |
| `m/1017'/1'/1'` | btc-node signing seed |

The trade rail calls the LSP HTTP API (`GET /status`, `POST /swap`); the LSP drives its
`seqob-cli` against the order book while the device signs each commitment update. Pure-LN
swaps settle both legs on one preimage and are the only settlement labelled final; mixed
rails are submarine swaps gated by the anchor rules like any on-chain leg. The backend
service, a browser-model device harness, a WS-to-TCP relay, and the key-provisioning tool
live in [`tooling/lsp/`](../tooling/lsp/README.md).

### CoinJoin (coinjoin.js + the seqcj coordinator)

The Mix tab runs a seqcj round: `coinjoin-protocol.js` and `blindsig.js` are vendored from the
seqcj repo and kept byte-identical, so the protocol the wallet runs is the one seqcj's own
end-to-end test proves. `coinjoin.js` does the parts only a wallet can: choose the coins, prove
ownership, hand out fresh blinded output addresses and, before signing, `verifyRoundOutputs`
(unblinding with the wallet's blinding key through wasm `coinjoinUnblindOutputs`) to check
the coordinator's transaction pays what was promised. Signing the wallet's own inputs is wasm
`coinjoinSignInputs`; the coordinator merges the witnesses. Mix history lives under
`swk.cj.*`.

## localStorage keys

| Key | Contents |
|---|---|
| `swk.sequentia.mnemonic` | the recovery phrase, plaintext (see README security notes) |
| `swk.sequentia.assets` | user asset labels `{assetHex: {name,ticker,precision}}` |
| `swk.sequentia.stakes` | tracked stake outputs (re-verified against the chain each sync) |
| `seqRefCcy` | chosen reference currency |
| `seqobMakerKey` | per-browser maker/session secp256k1 key (not a fund key) |
| `swk.sequentia.xswap` / `swk.sequentia.xrswap` | in-flight cross-chain taker state |
| `swk.sequentia.xmaker` | in-flight cross-chain maker sessions |
| `swk.sequentia.submarine`, `swk.sequentia.subswap(s)`, `swk.subasset.*` | in-flight mixed-rail and sub-asset swap state |
| `swk.sequentia.pegpending` / `swk.sequentia.pegoutpending`, `swk.sequentia.bridge` | pending SBTC peg-ins / peg-outs and leg-bridge jobs |
| `swk.sequentia.walk` | an in-flight Market fill that walks several resting offers |
| `swk.sequentia.oampTransfers`, `swk.sequentia.signerHints` | OpenAMP transfer log; pool signer keys this browser has delegated to |
| `swk.dex.*`, `swk.cj.*`, `swk.rescue.*`, `swk.seqln.chstore.*` | DEX order records, CoinJoin history, rescue records, channel store |
| `swk.balCache`, `swk.feeRatesCache`, `swk.pricesCache`, `swk.registryCache` | display caches, safe to clear |

The fund-bearing keys are the mnemonic and the in-flight swap, walk, peg and bridge records;
the rest can be cleared without loss.

## Known limitations

- The receive QR encodes a `liquidnetwork:<address>` URI (inherited from upstream LWK's
  `qr.rs`); the visible and copied address is correct, but external scanners get the wrong
  scheme. The fix belongs in SWK (emit the bare address) plus a WASM rebuild.
- Cross-chain makers serve offers only while the tab is open; reloads recover funds but do not
  resume serving automatically (offers must be re-posted).
- The LSP API uses a single shared bearer token on the live deployment; per-wallet
  authentication (a rune or signed challenge bound to the device pubkey) is a known TODO.
- The mnemonic is stored unencrypted; there is no lock screen or passphrase.
- One asset pair (a GOLD and a BTC channel) backs the demo Lightning rail; channel management
  from the wallet UI does not exist.

## Testing

`node --test` (Node 22+) runs the `node:test` suites (39 of the 62 `*.test.mjs` files); the
other 23, including `seqln.test.mjs`, `xcourier.test.mjs` and `xmaker.test.mjs`, are
standalone scripts run directly with `node <file>`. The swap modules additionally export `__test__`
hooks (leg operations, state accessors) for headless driving, and the real
WASM-signer-over-Noise path is proven by `tooling/lsp/device-harness.mjs` against a live
backend.
