# Sequentia web wallet

A proof-of-concept, non-custodial browser wallet for the Sequentia testnet, built on
[SWK](https://github.com/ConcatenaLabs/SWK) (Sequentia Wallet Kit), live at
**https://sequentiatestnet.com/wallet/**.

It is a dual-chain wallet: one 12-word phrase drives both a **Bitcoin testnet4** wallet and a
**Sequentia** wallet, and the same `tb1...` receive address works on both chains. BTC is a
first-class asset alongside every Sequentia-issued asset. All keys are derived and used inside
the browser; no key or phrase ever leaves the page. The app is a single static page (vanilla
JavaScript ES modules, no framework, no bundler) around SWK's `lwk_wasm` WebAssembly bindings.

> **Testnet software.** Everything here runs against the public Sequentia testnet and Bitcoin
> testnet4. There is no mainnet. Coins and assets have no value. This is a proof of concept,
> provided as-is, with no warranty.

## Where this fits in Sequentia

Sequentia is a Bitcoin sidechain for asset tokenization and disintermediated exchanges, built as a
fork of Blockstream Elements 23.3.3. The pieces this wallet talks to:

| Repo | One-liner |
|---|---|
| [`Sequentia`](https://github.com/ConcatenaLabs/Sequentia) | The Sequentia node, Sequentia Core (`sequentiad`, a fork of Elements 23.3.3): consensus, anchoring, proof of stake, open fee market, plus the canonical protocol documentation in `doc/sequentia/`. |
| [`SWK`](https://github.com/ConcatenaLabs/SWK) | Sequentia Wallet Kit: a fork of Blockstream LWK: Rust wallet library, CLI, and WASM bindings for building Sequentia (and Bitcoin testnet4) wallets. |
| [`seqdex`](https://github.com/ConcatenaLabs/seqdex) | SeqDEX: non-custodial atomic-swap DEX: P2P order book (seqob), same-chain swaps, and cross-chain BTC↔asset swaps made safe by Bitcoin anchoring. |
| [`seqln`](https://github.com/ConcatenaLabs/seqln) | SeqLN: a Core Lightning fork that runs on Sequentia and Bitcoin from the same binary: asset channels, any-asset payments, pure-Lightning swaps. |
| [`openamp`](https://github.com/ConcatenaLabs/openamp) | OpenAMP: open-source restricted-asset issuance/transfer-approval service (an AMP2 equivalent) with opt-in confidentiality; zero consensus changes. |
| [`sequentia-electrs`](https://github.com/ConcatenaLabs/sequentia-electrs) | The electrs fork: Rust indexer + Esplora REST API for Sequentia and its Bitcoin testnet4 parent chain. |
| [`sequentia-registry`](https://github.com/ConcatenaLabs/sequentia-registry) | Sequentia Asset Registry service (asset metadata). |

Protocol-level documentation (anchoring, proof of stake, the open fee market) lives in
[`Sequentia/doc/sequentia/`](https://github.com/ConcatenaLabs/Sequentia/tree/master/doc/sequentia).

## What the wallet does

- Wallet create / restore from a 12-word phrase; balances, send, receive on both chains
- Portfolio and per-amount display in a user-chosen reference currency (USD, BTC, or any priced asset)
- Any-asset fees on Sequentia transactions (open fee market), with fee-asset selection on every send
- Trade tab: SeqDEX order book, Market and Limit orders; same-chain orders rest on-chain as
  self-enforcing SeqOB covenants and fill without the wallet being open
- Cross-chain BTC↔asset HTLC swaps, taker and in-browser maker, with resume-after-reload safety
- Mix tab: CoinJoin rounds through the seqcj coordinator, the round verified in the wallet before
  it signs
- Asset issuance, reissue, burn; testnet faucet; asset labels fed by the Asset Registry
- Staking the Sequence token (tSEQ) with the network-minimum CSV lock, unbonding it, and
  staking-pool delegation (join a pool, switch, or leave; the coins never move)
- Transaction history on both chains with RBF fee bump, CPFP, and replace
- OpenAMP restricted assets: balances, receive, send (locally signed, never blind-signed), and a
  Sign tab for OpenAMP's tagged non-spending signatures (a challenge or a document hash)
- Classic signed messages over a wallet address key, in the format `verifymessage` accepts,
  and, from the same Sign tab, a message signed with the staking key, which is how a site
  that reads your stake -- Levo -- signs you in: paste its message, sign, paste the signature back
- QR scanning for addresses (live camera on https, photo upload elsewhere)
- Developer mode (a setting, off by default): coins held as leaves of an operator's tree, with
  the balance per rail, boarding, receive requests and payments, settle now, and an exit drill;
  and contract spends, shown and signed under the five-point rule

Experimental, and said so in the app:

- The **Instant (Lightning)** trade rails. The client code is complete and enabled on the live
  page, but it depends on a hosted SeqLN LSP demo backend with an interim shared bearer token.
  See [Lightning](#lightning-experimental) below for an honest description.
- Resting **BTC limit orders** that must outlive the tab. Bitcoin has no covenants, so a
  resting on-chain-BTC order either stays a native-BTC HTLC served by your own browser while
  the tab is open, or (the default, "keep resting while offline") is pegged into SBTC through
  the application-level SBTC custody bridge and rests in a covenant; the funds return as
  regular BTC on fill or cancel. Market orders and Lightning legs never use the bridge.

## Using the wallet

Open **https://sequentiatestnet.com/wallet/** in a modern desktop or mobile browser
(WebAssembly and `localStorage` required; the live QR camera additionally needs a secure
context, which the live site is). Create a new wallet or restore one from a 12-word phrase.

Get testnet funds from the **Issuance** tab: one-click faucet buttons for tSEQ and the demo
assets USDX, EURX, GOLD, SILVR, OILX (the faucet at https://sequentiatestnet.com/faucet pays
straight to your current address).

The tabs:

- **Balance**: a headline portfolio total across parent-chain BTC and every Sequentia asset,
  valued in your chosen reference currency, then one uniform row per asset. No asset is
  pinned or privileged; the Sequence token (tSEQ) is one row among equals.
- **Send**: multi-recipient sends of any owned asset, including BTC (a real Bitcoin testnet4
  transaction) and OpenAMP restricted assets. For Sequentia sends you choose the **fee asset**:
  the fee can be paid in any asset the node publishes an exchange rate for, and the fee-rate
  field is denominated in that asset's own units per vByte (sat/vB applies only to actual BTC
  sends). Every send shows a review dialog before broadcast.
- **Receive**: one address for both chains. The default is the non-confidential `tb1...` form,
  which is Bitcoin-compatible: the same address receives parent-chain BTC and Sequentia assets.
  Confidential (blinded, `tsqb1...`) addresses are available as an explicit opt-in toggle;
  Sequentia is transparent by default and confidentiality is opt-in. **Show xpub** reveals the
  account key for a watch-only import — one key for both chains, since they share the
  `m/84'/1'/0'` account — as the extended public key
  (`[fingerprint/84h/1h/0h]tpub...`) or as an importable descriptor pair, receive and change,
  in either the `wpkh(...)` form that matches this wallet's addresses or the legacy `pkh(...)`
  form that `verifymessage` uses. A separate panel appears for OpenAMP restricted-asset
  deposits once the wallet is registered with the enclave. A Lightning card generates an
  invoice against the hosted node for native BTC or any fee-rated asset.
- **Swap** (the Trade tab): see below.
- **Mix**: a CoinJoin round through the seqcj coordinator. The wallet picks the coins, proves
  it owns them, hands out fresh blinded addresses, and verifies the coordinator's transaction
  pays it what was promised before signing its own inputs. A BTC lane, when the coordinator
  opens one, pegs the BTC into SBTC through the custody bridge for the round and back out
  afterwards. Without a reachable coordinator the tab shows a status line and no lanes.
- **Issuance**: faucet, issue a new asset (amount, precision 0-8, optional reissuance tokens),
  reissue or burn an existing one, and label unknown assets. Metadata precedence: your local
  labels, then the Asset Registry, then built-in defaults for the public testnet demo assets.
- **Stake**: bond tSEQ to a CSV-time-locked staking output. Minimum stake 40,000 tSEQ;
  the wallet always uses the network-minimum unbonding lock, a time-based CSV lock of about
  15 days (43,200 × 30-second slot intervals), because stake weight equals the amount staked
  and a longer lock earns nothing extra. Once a stake's lock has passed, **Unbond** takes it
  out of staking at once, and **Claim** returns it to the wallet 2,016 Bitcoin blocks (about
  two weeks) after the unbond's anchor. The same tab delegates to a **staking pool**: a
  small on-chain delegation record lends your weight to a pool signer, the coins stay where
  they are, and "Leave this pool" reclaims the record at any time. Joining is two
  transactions mined together: the wallet pays its own staking key the record's value, and
  the record's transaction spends that coin, which is what authorises it. Every spend of a
  stake record is signed for the height of the block it enters, so the wallet refuses to
  build one when it cannot read the chain tip.
- **History**: transactions on both chains, with explorer links, and rescue actions for stuck
  Sequentia transactions: RBF fee bump, CPFP, and replace, each with the same any-asset fee
  selection as a send.
- **Sign**: two kinds of signature, neither able to authorize a spend. An OpenAMP request (a
  login challenge or a document hash) signed with the wallet's OpenAMP key, tagged so it can
  never stand in for a spend authorization; and a classic message signed with the key behind
  one of the wallet's own addresses, which proves that address is yours to anyone with a node.
  The classic one is the "Bitcoin Signed Message" format, so `verifymessage` checks it on
  Sequentia and on Bitcoin alike — against the legacy form of the address, the only form that
  RPC accepts.
- **Settings**: developer mode, backend endpoints, network, the policy asset id, reveal-phrase,
  and remove-wallet.

A wallet-wide **"Show values in"** selector picks the reference currency (USD by default, BTC
or any priced asset optional). Every amount field carries a live approximate value in that
currency, and amount inputs can be flipped to be typed directly in the reference currency.

### Developer mode: leaves

Developer mode is one setting under **Settings**, off by default. It adds a **Leaves** tab for
coins held as leaves of an operator's tree, and shows every step by hand. On the Balance tab
each asset row then reads "X on-chain · Y in leaves · Z on Lightning", and the headline total
counts the leaves too.

The Leaves tab first asks to **join an operator**: its server URL and the URL of a node's
JSON-RPC (with a user and password if that node needs them). The node must validate its
Bitcoin anchors (`-validateanchor`) and keep a transaction index (`-txindex`). Joining pins the
node's chain and the operator's key, and shows the key to compare with the one the operator
publishes; the wallet then refuses any server that names another. A server on another origin
must answer CORS. The tab then has:

- **Balances per rail**: one row per asset, BTC first and always. On-chain (as the leaf wallet
  reads it from its node), leaves by state, and Lightning. A tree on Sequentia holds no BTC. A
  coin received out of round and not yet refreshed is *operator-confirmed*: it relies on the
  operator and its sender not colluding until a round settles it.
- **Board**: brings an on-chain coin into the tree. **Show an on-chain address** gives an
  address of the same keys on the leaf wallet's chain, to pay a coin to board or a fee coin. The
  fee is paid in the asset boarded unless another is named.
- **Receive**: a single-use receive request (`arca:…`). A payment arrives in the mailbox, which
  sync reads.
- **Send to a receive request**: pays it out of round, in the asset named.
- **Sync and schedule**: the chain's median time, when the schedule next asks for a sync and
  why, and every unpaid receive request with when it lapses. While the page is open it reads
  the schedule every minute and syncs when it is due, and every 30 seconds at most while a
  board, a payment, a participation or an exit is in flight. **Sync now** runs one at once.
- **Leaves and their dates**: every leaf with its state, kind, expiry, exit deadline, and the
  dates sync keeps for it (synced daily from, refreshed from, taken home from, exit by), and
  the fee coin its exit needs, if any. **Settle now** gives a leaf up for one new leaf in the
  next round: the operator's fee is shown coin by coin first, and nothing is signed unless the
  fee is the one shown. The participation is then followed by the page's own sync until it is
  released and the new leaf is held. **Exit drill** takes one leaf on-chain from its record
  alone, without the operator: each run shows what it broadcast, with every fee, and what comes
  next; run it again until the claim is final.
- **Participations** and **Refusals**: every participation and where it stands, and every
  refusal the leaf wallet made.

Every refusal is shown in the library's own words. The leaf wallet is the operator wallet
library itself (the same code as the operator's command-line wallet), compiled to WebAssembly
and run in a dedicated worker (`leaves/`), so nothing about a leaf is computed by the page.
Its store is a SQLite file in the browser's private file system for this site, one per
mnemonic. It holds what the mnemonic cannot rebuild, which leaves were spent off-chain and
which forfeits were signed among them, so clearing the site's data loses it. One tab at a time
can hold it.

### Developer mode: contract spends

With developer mode on, a **Contracts** tab spends a contract written with
[`sequentia-contracts`](https://github.com/ConcatenaLabs/sequentia-contracts): a template (a
descriptor and its programs) and an instance of it (the template's values on this chain). The
kit's contract engine does the work; the tab asks it and shows what it answers.

- **Template**: one the kit carries (`sequentia/one-key`, `sequentia/one-key-exit`,
  `sequentia/faucet-drip`), or a descriptor pasted with its sources (each with its includes
  resolved, as `seqc expand` prints it). The engine checks a pasted template with the
  contracts' own reader and pinned compiler, and only then adds it to this wallet's list. The
  tab shows this wallet's contract key (`m/8383h/1h/0h/0/0`), the key a template names for it.
- **Instance**: the instance record; the engine recomputes its address, which the tab shows.
- **Coin and path**: the explicit coins the address holds, and the way to spend.
- **Spend**: for the faucet drip covenant's drip, the recipient (this wallet by default), the
  amount and a fee rate in the dripped asset's own units; for any other path, the request
  written by hand (its outputs, each saying whether it returns to the contract, pays this
  wallet, pays someone, or is the fee).

**Review** shows the approval: the template by the registry's name (looked up by the wallet,
never taken from the template), else its commitment root; the path, who can take it and what it
does; every parameter by role; this wallet's balance change in every asset; where the coins
go; and what was checked. The wallet signs only when the template is on its list, the engine
recomputed the output, it ran the program against the final transaction, and the key is a
contract key. **Sign and broadcast** signs the digest of exactly the screen shown. A spend
the engine refuses (a relative lock not yet passed, an amount the program forbids, an output
it cannot account for) is refused before anything is signed, in the engine's words.

### The Trade tab

One symmetric composer: "You pay X" / "You receive Y". The route is inferred from the pair:

- **Same-chain** (asset ↔ asset on Sequentia): the order funds a SeqOB tapscript covenant
  that rests on-chain; a fill is one transaction that spends it under the script's own rules
  (no co-signature, no escrow, no intermediary). Maker-signed relay offers, where one rests,
  are still taken through the co-signed PSET lift.
- **Cross-chain** (BTC ↔ asset): a hash-time-locked-contract (HTLC) atomic swap between
  Bitcoin testnet4 and Sequentia. Before revealing any secret the wallet verifies the
  counterparty leg on-chain AND checks that the Sequentia block anchors at or above the
  Bitcoin leg's height. Bitcoin anchoring is what makes this safe: if Bitcoin reorganizes,
  Sequentia reorganizes with it, so an anchored Sequentia leg cannot outlive the Bitcoin leg
  it depends on.
- **Instant (Lightning)** and **mixed** rails for BTC ↔ asset appear when the Lightning
  backend is reachable (see below).

Two price modes, always switchable:

- **Market**: the other amount fills at the best executable price (a sweep estimate with a
  slippage bound). Relay offers are verified client-side (each carries the maker's signature;
  forged rows are dropped), and any swap handshake runs end-to-end encrypted through the
  relay, which only ever sees ciphertext.
- **Limit**: set your own price. A same-chain order funds a SeqOB covenant that rests on-chain
  and is filled by anyone who crosses it, with no maker co-signature and no need for the wallet
  to stay open; cancelling spends the covenant back to you. Cross-chain orders are served by
  your own browser while the tab is open (the wallet acts as maker, with persisted fund-safety
  watchers that resume after a reload), or, for the BTC-paying side, rest as SBTC through the
  custody bridge (see Status above).

The tab is honest about finality: on-chain settlement is described as confirmed in about one
block and final once its Bitcoin anchor is buried, since until then a Bitcoin reorg can still
remove it. Only pure-Lightning settlement (nothing on-chain) is labelled final at once.

### Lightning (experimental)

The Lightning rails use a hosted-SeqLN LSP model in which the keys stay on your device:

- The server hosts two **keyless** SeqLN nodes (an asset node on Sequentia, a BTC node on
  testnet4). Neither has an `hsm_secret`.
- The browser derives two device identities from your one mnemonic (hardened `m/1017'/...`
  paths, see `seqln-keys.js`) and runs an on-device WASM signer per node, connected over a
  WebSocket Noise_XK (BOLT-8) link. Every commitment update is co-signed on your device. The
  device signs only commitments it has validated, signs a close only if it pays your channel
  balance to the node's own address, and approves each payment only within its payment limit for
  the asset (`window.SEQ_LN_PAYMENT_LIMITS` in `index.html`, described in
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)). It moves the node's coins only to the node's own
  addresses or into a channel the node opens, with the fee held to that limit: sending them to any
  other address, this wallet's included, waits for a way to approve that address on the device.
  That does not protect you from an operator who runs
  both your hosted node and the node your channel is with: the hosted node collects the
  device's signature on each commitment before the device revokes it, so the two together can
  broadcast a revoked commitment and take the channel's funds.
- A trade with both rails set to Lightning settles both legs atomically on one preimage, fully
  off-chain. A mixed rail (one leg on-chain, one Lightning) is a submarine swap.

The status pill next to the wallet title reports the rail: "LN ready" (both device signers
serving), "LN 1/2" (one leg up), or an error state; when Lightning is not configured the pill
is hidden and the composer quietly uses the on-chain rails only.

Honest caveats: this is a demo deployment. The live page ships a shared testnet-demo bearer
token for the LSP API rather than per-wallet authentication, the backend is a single
hosted instance, and the rail's availability depends on it. Funds safety does not rest on the
token: it rests on the hosted nodes being keyless, with your device as sole signer.

### OpenAMP restricted assets

If the OpenAMP service is reachable, the wallet registers an identity (AID) derived from the
wallet's own keys and then shows restricted assets alongside on-chain ones: balances on the
Balance tab, a deposit address on the Receive tab, and transfers on the Send tab. Transfers
are drafted by the enclave, reviewed in the wallet, and signed locally (Schnorr over the
returned sighashes); the wallet never blind-signs. If the service is unreachable the wallet
works normally without the restricted rows.

## For developers

### Repo layout

| Path | What it is |
|---|---|
| `index.html` | The whole app shell and core wallet logic: boot, create/restore, tabs, balances, send/receive, fees, staking and pool delegation, history, OpenAMP, the Sign tab, QR scanner. |
| `pkg/` | **Not tracked.** The `lwk_wasm` WebAssembly bindings built from SWK (see below). |
| `btc.js` | Vendored bundle of `@scure/btc-signer`, `@scure/bip32`, `@scure/bip39`, `@scure/base`, `@noble/hashes` (MIT): the Bitcoin testnet4 side and HD derivation. |
| `swap.js` | The Trade tab: composer, routing, Market/Limit, covenant order placement, fee selection. |
| `covenant.js` / `covenant-order.js` / `covenant-flow.js` / `covenant-fill-host.js` | The SeqOB passive-CLOB covenant: the byte-exact leaf and witness builders (pinned to the Go and Python originals), the place/watch-for-fill order flow, the pure composer glue, and the seam that hands raw FILL assembly to wasm. |
| `seqob.js` | SeqDEX order-book (seqob relay) protocol client: wire codec, offer signing/verification, end-to-end crypter, REST + WebSocket lift driver. |
| `sbtc.js` | Thin client for the SBTC custody bridge (address allocation only; it moves no funds). |
| `ln-rail.js` / `submarine.js` / `subswap.js` | Lightning-rail gating per asset, the mixed-rail (submarine) swap state machine, and the P2P submarine taker + LSP leg-bridge client. |
| `signmessage.js` | Classic signed messages: the magic-prefixed hash, the recoverable signature, and the legacy address a verifier is given. |
| `descriptor.js` | Output descriptors for the account key: the BIP380 checksum and the receive/change pair a watch-only import takes. |
| `stake-records.js` | Joining, moving and leaving a staking pool, and unbonding: finds the wallet's delegation record and drives the transactions SWK builds over the staking key's bare scripts. |
| `leaves.js` | Developer mode: the setting and the Leaves tab, which shows what the leaf wallet answers. |
| `contracts.js` | Developer mode: the Contracts tab, which builds, shows and signs a contract spend through the kit's contract engine, under the five-point rule. Copied into the browser extension's `vendor/`. |
| `leaves/` | The leaf wallet's dedicated worker and its WASM build (`leaves/pkg/`, tracked): the operator wallet library from [`ConcatenaLabs/arca`](https://github.com/ConcatenaLabs/arca)'s `wallet-wasm/`. |
| `rewards.js` | Staking-reward auto-conversion: reads which coins are rewards and converts the fee-asset tail into one asset the staker picked. |
| `coinjoin.js` | The Mix tab's wallet side: coin selection, ownership proofs, blinded addresses, and the pre-sign verification of the coordinator's transaction. |
| `blindsig.js` / `coinjoin-protocol.js` | Vendored from [`seqcj`](https://github.com/ConcatenaLabs/seqcj): Chaum RSA blind signatures and the participant half of the CoinJoin protocol. Kept byte-identical to the originals apart from the header. |
| `xcourier.js` | Cross-chain swap message transport: end-to-end-sealed courier sessions over the relay WebSocket. |
| `xswap.js` / `xrswap.js` | Cross-chain HTLC taker, forward (pay BTC, receive asset) and reverse (pay asset, receive BTC). |
| `xmaker.js` | In-browser cross-chain maker: builds, signs, rests, and serves offers in both directions. |
| `seqln.js` / `seqln-keys.js` | Lightning: hosted-LSP HTTP client, device-signer orchestration, and the `m/1017'/...` key derivation. |
| `lightning/` | The vendored SeqLN device-signer SDK + its WASM build (tracked, unlike `pkg/`). |
| `noble-ciphers.js` | Vendored `@noble/ciphers` (MIT): AES-256-GCM for the end-to-end swap encryption. |
| `jsqr.js` | Vendored jsQR: QR decoding for the scanner. |
| `tooling/lsp/` | The hosted-SeqLN LSP backend service and provisioning/harness scripts, with [its own README](tooling/lsp/README.md). Three of its modules (`settlement-router.mjs`, `unified-book.mjs`, `bridge-driver.mjs`) are also imported by the browser. |
| `*.test.mjs` | Node test suites (no browser needed). |

A deeper tour of the module graph, protocols, config globals, and storage keys is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Building `pkg/` (the SWK WASM bindings)

The only build product the wallet needs is `pkg/`, produced from the `sequentia` branch of
SWK with [wasm-pack](https://rustwasm.github.io/wasm-pack/):

```sh
git clone -b sequentia https://github.com/ConcatenaLabs/SWK.git
cd SWK/lwk_wasm
./build-web.sh   # wasm-pack build --target web --release, the build machine's paths remapped; needs clang
```

`--target web` is required, and the script uses it. It also fails if the `.wasm` still names
the machine that built it. A `pkg/` built before SWK carried its contract engine still works,
but the Contracts tab then says it needs a newer build.

Then copy or symlink the output into the wallet checkout:

```sh
ln -s ../SWK/lwk_wasm/pkg ./pkg
```

`index.html` imports a default-exported `init` from `./pkg/lwk_wasm.js`, which only the
`--target web` build produces. Sequentia support (the `Network.sequentiaTestnet()` network,
explicit-fee PSET building, the SeqDEX swap and HTLC helpers) is compiled in unconditionally
on that branch via `lwk_wollet`'s `sequentia` feature, so no extra flags are needed.

### Running locally

The app itself is static; any file server works for the UI:

```sh
python3 -m http.server 8080
# open http://127.0.0.1:8080/
```

However, all data access is same-origin: the page calls relative paths and expects a reverse
proxy in front of it (this is how the live site is deployed, with the static files and the
proxied services under one origin). To get a functional wallet locally, proxy these paths to
a backend (the public testnet services work):

| Path | Service |
|---|---|
| `/api` | Sequentia Esplora REST API (sequentia-electrs) |
| `/testnet4/api` | Bitcoin testnet4 Esplora REST API |
| `/prices` | Market price feed (reference-currency display) |
| `/feerates` | The node's fee-asset exchange rates (`getfeeexchangerates`) |
| `/faucet` | Testnet faucet |
| `/registry/index.minimal.json` | Asset Registry minimal index (asset metadata; overridable via `window.SEQ_REGISTRY_URL`) |
| `/seqob` (+ WebSocket at `/seqob/v1/ws`) | SeqDEX order-book relay (`seqobd`) |
| `/dex` | The SeqDEX daemon, used only for market seeding |
| `/anchor/<blockhash>`, `/anchorstatus` | Anchor lookups used by the cross-chain maker's safety gate |
| `/openamp` | OpenAMP restricted-asset API (optional; wallet degrades gracefully) |
| `/lsp`, `/lsp-ws-asset`, `/lsp-ws-btc` | Hosted-SeqLN LSP + per-node signer WebSockets (optional; Lightning rails stay off without them) |
| `/coinjoin` | seqcj CoinJoin coordinator (optional; the Mix tab reports it missing; override `window.SEQ_COINJOIN_URL`) |
| `/sbtc` | SBTC custody bridge (optional; only the "keep resting while offline" BTC limit orders use it) |
| `/pools/pools.json` | The staking pool board's feed, listing pools to delegate to |

Missing optional backends never break the wallet; the corresponding features simply do not
appear. Note that the live camera QR scanner requires https; over plain http the
photo-upload fallback is used automatically.

### Running the tests

The protocol modules are DOM-free and tested under plain Node (22+, no dependencies to
install):

```sh
node --test
```

This runs every `*.test.mjs` file, at the root and under `tooling/lsp/`. Most register
`node:test` cases. The rest are standalone scripts with their own `check()` harness, which
`node --test` runs as one test each, among them `seqln.test.mjs`, `xcourier.test.mjs`,
`xmaker.test.mjs`, `ln-rail.test.mjs`, `submarine.test.mjs`, `swap-mixed.test.mjs` and the
`covenant*.test.mjs` golden vectors; each also runs on its own, for example
`node covenant-byteorder.test.mjs`.

`node tooling/sign-tab-probe.mjs` opens the wallet in a headless Chromium, creates a wallet,
signs a message with the staking key from the Sign tab, and recovers a key from the signature
the way a verifier does; it has to be the staking key the tab shows. Given a URL it probes a
deployed wallet instead of this checkout. It needs a Chromium (`CHROMIUM=/path/to/chrome`).

`SEQUENTIAD=/path/to/sequentiad node tooling/stake-records-regtest.mjs` runs
`stake-records.js` with this checkout's `pkg/` against a real node: two fresh proof-of-stake
`elementsregtest` chains, each anchored to a second node playing the parent chain, with an
Esplora shim over the node's RPC. It bonds, joins a pool, finds the record, moves, leaves,
unbonds and claims, each transaction confirmed in a block, and checks that a spend built on
one side of the height where stake record signatures change is rebuilt on the other.

`SEQUENTIA_BIN=<Sequentia>/src node tooling/contracts-regtest.mjs <evidence-dir>` drives the
Contracts tab in a headless Chromium against a private regtest chain: a faucet drip covenant
whose faucet key is the page's contract key is funded, dripped from through the approval
screen and confirmed, and a drip before the interval, one above the tier and one whose
successor is not the covenant are each refused before signing. The tab runs there on
`tooling/contracts-harness.html`, which mounts the same module on the regtest network, since
`index.html` is bound to the testnet. `node tooling/contracts-tab-probe.mjs` checks the tab in
`index.html` itself: hidden with developer mode off, shown with it on, reading a template.

`node tooling/leaves-drive.mjs <evidence-dir>` drives developer mode in a headless Chromium
against a local regtest operator: it joins, funds and boards, receives a payment through the
mailbox, sends one, shows refusals, settles a leaf into a round, runs the exit drill through to
a final claim, and checks that the page syncs by itself when a leaf's refresh window opens.
Each step is a DOM assertion and a screenshot, and each on-chain effect is checked at the node.
It needs the operator repository's harness running
(`ARCA_OPERATOR_CONTROL=127.0.0.1:18640 cargo test -p arca-cli --test arca_operator_for_browsers -- --ignored`,
with what that repository's tests need) and its command-line wallet as the counterparty
(`ARCA_CLI=/path/to/arca`). `tooling/leaves-dev-server.mjs` serves this checkout with that
operator and its node behind the same origin, for working on the tab by hand.

The real WASM + WebSocket + Noise signer path is exercised separately by
`tooling/lsp/device-harness.mjs` against a running backend; see
[`tooling/lsp/README.md`](tooling/lsp/README.md).

### Contributing

Development happens on `main`; open PRs against it. Keep the app dependency-free at runtime:
vendored libraries are checked in as single files, there is no `package.json`, and new code
should follow the existing module pattern (an `init*(ctx)` entry that receives the shared
context from `index.html`).

## Security notes

- **Non-custodial, client-side keys.** The mnemonic and every derived key live only in your
  browser. Transactions are signed locally; servers see only signed transactions, sealed swap
  messages, or (for Lightning) individual signature requests approved by the on-device signer.
- **The phrase is stored in plaintext `localStorage`** so the wallet reopens without re-typing
  it. There is no passphrase encryption yet. Anyone with access to your browser profile can
  read it. Do not use this wallet pattern for real value; this is testnet proof-of-concept
  software.
- The swap handshakes are end-to-end encrypted (ECDH + AES-256-GCM) so the relay cannot read
  or tamper with them, and offer signatures are verified client-side against the maker key in
  the signed offer, not against anything the relay claims.
- The Lightning demo backend uses an interim shared bearer token; treat the Lightning rails as
  a demo. Custody still does not depend on that token (the hosted nodes are keyless).
- No warranty. Testnet only.

## License

MIT, see [LICENSE](LICENSE). Vendored components keep their own upstream licenses: the `@scure`/`@noble` bundles (`btc.js`, `noble-ciphers.js`) are MIT, and
`jsqr.js` is the jsQR project's build. SWK (which produces `pkg/`) carries upstream LWK's
licensing; see [SWK](https://github.com/ConcatenaLabs/SWK).
