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
- Trade tab in user mode: what you pay, what you get, one amount and one button; a market
  trade that settles in one step, offered only for the pairs the reliability drill has passed
- Trade tab in developer mode: SeqDEX order book, Market and Limit orders; same-chain orders rest on-chain as
  self-enforcing SeqOB covenants and fill without the wallet being open. An order's locked coins
  come back through Reclaim once its lock has passed: a median time a day after it is placed (a
  block height a day ahead when the explorer gives no median time)
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
- A mode setting, kept for each wallet: user mode (one figure per asset, and the wallet
  chooses how value moves) by default, or developer mode, which adds coins held as leaves of
  an operator's tree, with the balance per rail, boarding, receive requests and payments,
  settle now, and an exit drill; and contract spends, shown and signed under the five-point
  rule. The wallet's own pages read the mode and the leaf rail through its page API
  ([docs/PAGE_API.md](docs/PAGE_API.md))

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
straight to your current address). The line under the buttons says when the coins have reached
the wallet.

The tabs: Balance, Send, Receive, Swap and History in the top row; Mix, Issuance, Stake, Sign and
Help under **More**; Settings behind the gear in the header. On a phone the same tabs are a bar
fixed to the bottom of the screen, icon over label, which steps aside while the keyboard is up.

- **Balance**: a headline portfolio total across parent-chain BTC and every Sequentia asset,
  valued in your chosen reference currency, then one uniform row per asset, BTC first. No asset
  is pinned or privileged; the Sequence token (tSEQ) is one row among equals. Each asset's figure
  counts everything of it the wallet holds: on-chain, leaves, Lightning (the wallet's share of
  its own channels, reserve included) and, for tSEQ, what is staked (each bonded stake, each
  unbonding output not yet claimed back, and the delegation record). A row shows that one
  figure, with a bolt beside the ticker that is yellow when the asset has a Lightning channel;
  a tap on it opens its details: its parts (on-chain, Lightning with what it can send and
  receive, leaves and staked, each when it holds some), the controls that move it to and from
  Lightning or ask for room to receive, and its asset id and Hide. The view is the same in
  both modes.
  Figures read the way the browser's locale writes numbers (thousands grouped, its decimal
  mark) with the asset's own decimals, exact to the atom; amount fields take plain digits.
- **Send**: multi-recipient sends of any owned asset, including BTC (a real Bitcoin testnet4
  transaction) and OpenAMP restricted assets. For Sequentia sends you choose the **fee asset**:
  the fee can be paid in any asset the node publishes an exchange rate for. The fee is
  recommended for a confirmation target or set by hand, as the total for the transaction or the
  rate per 100 bytes, in the fee asset or the reference currency (`fee-panel.js`). The
  recommendation is the producer's `estimatesmartfee` (through the explorer's `/estimatefee`) or
  Bitcoin testnet4's fee estimates; a testnet4 estimate above 50 sat/vB is someone flooding
  testnet4 and is not followed. **Max** fills
  an amount with everything that can be sent after the fee. Every send shows a review dialog
  before broadcast. A Lightning card pays an invoice from the hosted node. When the wallet has
  none (or too little) of the invoice's asset on Lightning, it says so before asking the node,
  and offers **Move to Lightning** when the asset is on-chain.
- **Receive**: one address for both chains. The default is the non-confidential `tb1...` form,
  which is Bitcoin-compatible: the same address receives parent-chain BTC and Sequentia assets.
  Confidential (blinded, `tsqb1...`) addresses are available as an explicit opt-in toggle;
  Sequentia is transparent by default and confidentiality is opt-in (**Show blinded address**).
  **Show xpub** (developer mode) reveals the
  account key for a watch-only import — one key for both chains, since they share the
  `m/84'/1'/0'` account — as the extended public key
  (`[fingerprint/84h/1h/0h]tpub...`) or as an importable descriptor pair, receive and change,
  in either the `wpkh(...)` form that matches this wallet's addresses or the legacy `pkh(...)`
  form that `verifymessage` uses. A separate panel appears for OpenAMP restricted-asset
  deposits once the wallet is registered with the enclave. A Lightning card generates an
  invoice against the hosted node for native BTC or any fee-rated asset. It says how much can
  arrive, counting only channels that are open: room still opening (bought with a Move to
  Lightning or on its own, about a block away) reads "ready to receive in about a minute", and
  no invoice is made for more than the open channels can take, since nobody could pay it.
  Where an asset cannot arrive over Lightning yet, the card says what to do in one sentence
  and offers the step, in every mode: **Move to Lightning** when the asset has no channel (the
  move asks for room to receive in the same step), **Add room to receive** when it has one.
  Once the invoice is paid, the card reads "Received" with the amount, as soon as the hosted
  node lists the payment.
- **Swap** (the Trade tab): see below.
- **Mix**: a CoinJoin round through the seqcj coordinator. The wallet picks the coins, proves
  it owns them, hands out fresh blinded addresses, and verifies the coordinator's transaction
  pays it what was promised before signing its own inputs. A BTC lane, when the coordinator
  opens one, pegs the BTC into SBTC (pegged bitcoin) for the round and back out
  afterwards. Without a reachable coordinator the tab shows a status line and no lanes.
- **Issuance**: faucet, issue a new asset (amount, 0 to 8 decimal places, and whether more can be
  issued later, which gives the wallet one reissuance token), reissue an asset whose token the
  wallet holds or burn any asset, and label unknown assets. The name, ticker and decimal places
  typed at issuance label the asset in this wallet, and its token shows in the balance marked as
  a reissuance token, with a button to issue more. The issued amount, the asset and its token
  go to the wallet's own addresses as explicit outputs, as a send does. Metadata precedence: your local
  labels, then the Asset Registry, then built-in defaults for the public testnet demo assets.
- **Stake**: bond tSEQ to a CSV-time-locked staking output. Minimum stake 40,000 tSEQ;
  the wallet always uses the network-minimum lock, a height-based CSV of 43,200 blocks: about
  30 days at one block a minute (consensus counts a height lock in 30-second slots, so no
  shorter one stakes), because stake weight equals the amount staked and a longer lock earns
  nothing extra. The review before signing says it is a stake, its lock and the staker key. The
  tab lists every stake of the wallet's staking key that the chain holds, whichever Sequentia
  wallet of the same phrase bonded it: under this lock, or under the time-based lock of 2,532
  units of 512 seconds (about 15 days) that Ambra bonds with, which can be unbonded once the
  chain's median time has passed it. Once a stake's lock has passed, **Unbond** takes it
  out of staking at once, and **Claim** returns it to the wallet 2,016 Bitcoin blocks (about
  two weeks) after the unbond's anchor. The same tab delegates to a **staking pool**: a
  small on-chain delegation record lends your weight to a pool signer, the coins stay where
  they are, and "Leave this pool" reclaims the record at any time. Joining is two
  transactions mined together: the wallet pays its own staking key the record's value, and
  the record's transaction spends that coin, which is what authorises it. Every spend of a
  stake record is signed for the height of the block it enters, so the wallet refuses to
  build one when it cannot read the chain tip.
- **History**: transactions on both chains, with explorer links (Bitcoin's first when it has any;
  with none on either chain, one line says so), and rescue actions for stuck
  Sequentia transactions: RBF fee bump, CPFP, and replace, each with the same any-asset fee
  selection as a send. They appear once a payment has missed a block. Each dialog says what the
  stuck transaction pays, as a multiple of the network's minimum rate, suggests a rate in the
  chosen asset's own units, and says what the rescue comes to; it checks again before signing
  that the transaction is still unconfirmed. Each row's details say why an unconfirmed
  transaction is waiting, and a transaction the network dropped is marked so.
- **Help**: questions and answers on fees (which assets pay them, what the marks next to the fee
  asset mean, setting a rate, why a transaction is refused or waits, the three rescues) and on
  Lightning (who holds the keys, moving in and out, sending and receiving, what room to receive
  costs and guarantees, with a step-by-step picture of one channel). Links across the wallet open
  the relevant answer, over a dialog when one is open.
- **Sign**: two kinds of signature, neither able to authorize a spend. An OpenAMP request (a
  login challenge or a document hash) signed with the wallet's OpenAMP key, tagged so it can
  never stand in for a spend authorization; and a classic message signed with the key behind
  one of the wallet's own addresses, which proves that address is yours to anyone with a node.
  The classic one is the "Bitcoin Signed Message" format, so `verifymessage` checks it on
  Sequentia and on Bitcoin alike — against the legacy form of the address, the only form that
  RPC accepts.
- **Settings**: the mode, backend endpoints, network, the policy asset id, reveal-phrase,
  and remove-wallet.

A wallet-wide **"Show values in"** selector picks the reference currency (USD by default, then
BTC, then any priced asset, each named by the ticker the wallet shows elsewhere: the Sequence
token is tSEQ on the testnet, though the price feed keys it SEQ). Every amount field carries a live approximate value in that
currency, and amount inputs can be flipped to be typed directly in the reference currency.

### The mode

**Settings → Mode** is one setting, kept for each wallet, with the same words in every
Sequentia wallet:

- **User mode** (the default): The wallet chooses how value moves.
- **Developer mode**: Leaves as a rail you can choose, and the developer tools (the Leaves and
  Contracts tabs). The Balance tab is the same in both modes.

The headline total counts every rail of every asset (on-chain, Lightning and leaves) and the
staked tSEQ in the reference currency, in both modes, and no asset comes first. User mode shows
one figure per asset, its parts one tap away, with Move to Lightning and room to receive among
them; where an asset cannot be paid or received over Lightning yet, the Lightning cards say what
to do in one sentence and offer that step. User mode carries no developer vocabulary: the xpub,
the Settings backend card, the staker key, the order book's unblinded/blinded switch (shown in
user mode only while the blinded book is chosen), a payment's preimage and the Lightning
channel count are developer mode's. In developer mode each asset row also reads "X on-chain · Y in leaves · Z on
Lightning" (and "· S staked" for tSEQ), the Lightning column carries Move and room to receive,
and the **Leaves** and **Contracts** tabs appear. In user mode nothing of leaves is shown, but a wallet that joined
an operator keeps its leaf wallet syncing while the page is open, since its coins have dates
to keep, and their value counts in each asset's one figure; the Trade tab's user composer pays
from them and settles in them without naming them (below). The wallet's own pages read the
mode, and in developer mode the leaf rail, through the page API (`window.sequentiaWallet`,
[docs/PAGE_API.md](docs/PAGE_API.md)), in the shape the browser extension's provider serves.

### Developer mode: leaves

The **Leaves** tab holds coins held as leaves of an operator's tree, and shows every step by
hand.

The Leaves tab first asks to **join an operator**: its server URL and the URL of a node's
JSON-RPC (with a user and password if that node needs them). The node must validate its
Bitcoin anchors (`-validateanchor`) and keep a transaction index (`-txindex`). Joining pins the
node's chain and the operator's key, and shows the key to compare with the one the operator
publishes; the wallet then refuses any server that names another. Joining also restores what
the operator holds of this phrase's leaves, so a phrase that already holds leaves (from another
browser, the extension or Ambra) shows them at once. A server on another origin
must answer CORS. The tab then has:

- **Balances per rail**: one row per asset, BTC first and always. On-chain (as the leaf wallet
  reads it from its node), leaves by state, and Lightning. A tree on Sequentia holds no BTC. A
  coin received out of round and not yet refreshed is *operator-confirmed*: it relies on the
  operator and its sender not colluding until a round settles it.
- **Board**: brings an on-chain coin into the tree. **Show an on-chain address** gives an
  address of the same keys on the leaf wallet's chain, to pay a coin to board or a fee coin. The
  fee is paid in the asset boarded unless another is named.
- **Receive**: a single-use receive request (`request:…`), for any asset or one the operator
  serves (its published list, then any other asset held in leaves). A payment arrives in the
  mailbox, which sync reads. On the testnet, **Ask the testnet faucet to pay it** sends the
  request to the faucet, which pays it as a leaf out of round, and the page syncs.
- **Send to a receive request**: pays it out of round, in the asset named.
- **Sync and schedule**: the chain's median time, when the schedule next asks for a sync and
  why, and every unpaid receive request with when it lapses. It syncs once when the leaf wallet
  opens, whatever the schedule says, so a wallet back from an absence takes up what happened
  while it was closed (a plan's step, a payment). While the page is open it reads
  the schedule every minute and syncs when it is due, when the time it gave after the last
  sync arrives (whatever later reads say), and every 30 seconds at most while a
  board, a payment, a participation or an exit is in flight. **Sync now** runs one at once.
- **Leaves and their dates**: every leaf with its state, kind, expiry, exit deadline, and the
  dates sync keeps for it (synced daily from, refreshed from, taken home from, exit by), and
  the fee coin its exit needs, if any. **Settle now** gives a leaf up for one new leaf in the
  next round: the operator's fee is shown coin by coin first, and nothing is signed unless the
  fee is the one shown. The participation is then followed by the page's own sync until it is
  released and the new leaf is held. **Exit drill** takes one leaf on-chain from its record
  alone, without the operator: each run shows what it broadcast, with every fee, and what comes
  next; run it again until the claim is final.
- **Kept by itself: claims and refresh plans**: what the wallet last did by itself (below),
  every refresh plan with its leaf, its steps and until when it covers the leaf, with
  **Cancel**, and **Release** for a planned leaf (the leaf given up in the next round for a leaf
  of the wallet's own that no plan names, which ends the plan once that round is final). Each
  planned leaf is marked under Leaves and their dates. **Look up claims** lists the
  claims under this wallet's addresses, and **Distributions paid from here** the wallet's own.
- **Participations** and **Refusals**: every participation and where it stands, and every
  refusal the leaf wallet made.

#### What the wallet does by itself

A wallet that joined an operator does three things with no prompt, in either mode, while the
page is open: it syncs on the library's schedule (above), and after a sync, at most every ten
minutes and at the first one after the page opens, it runs the library's `care`. That takes up
every open claim of a distribution named for one of the wallet's addresses, looking under every
address the wallet handed out and 20 more, so the asset appears in its figure on the Balance tab.
It signs a refresh plan for every leaf of a round at the first `care` after the leaf is made,
two expiries ahead, the operator's fee for a step bounded at 0.2% of the leaf and taken from the
leaf in its own asset (a step in the leaf's free window costs nothing). A plan starts only from a
leaf of a round, so a leaf received or boarded out of round is refreshed into a round, under the
same bound, once its refresh could run within ten days (that refresh costs a fee, so it waits),
and its new leaf is planned at the next `care`. A leaf the operator will not plan stays
unplanned, with the operator's reason in developer mode, and is refreshed by sync while the page
is open. A wallet then closed across that leaf's expiry keeps it, whenever it closes: the
operator runs the plan's steps and the wallet takes the new leaf up when it opens again. And it
cancels a plan whose leaf has moved.

A planned leaf carries refund halves the wallet signed, so no wallet pays it out of round. A
payment, a trade or an order that the unplanned leaves cannot cover is made through the next
round, by itself: the library refuses it naming the planned leaves whose release covers it, the
page gives those up in the next round for leaves of its own that no plan names, syncs until that
round is final and the new leaves are held, and asks again. The person waits one round and sees
nothing else; developer mode shows a "Paying through the next round" card while it waits. A
release costs the refresh fee the asset's schedule asks then (none in the leaf's free window).
User mode shows none of this: a claim taken up is counted in its asset's one figure.

#### The operator's bond

The operator posts an equivocation bond: two different messages its key signs under one coin's
salt prove it signed twice, and burn the bond whole. At `care`'s pace, in either mode, the page
reads the bond (once the wallet has seen it bonded, it requires it from then on) and runs the
library's `watch_bond`, which checks the wallet's own evidence against the chain and the mempool
and sends the slash itself should the operator key have signed twice. The library's gate does
the rest by itself: a receive or a swap is refused while the bond is missing or in notice, or
when what the wallet would hold out of round is worth more than it. Nothing is said while the
bond stands; a refusal reads, in user mode, "Not accepted: the security deposit that backs these
instant payments is missing or being withdrawn, so this wallet takes no payment that rests on it.
Nothing was signed." Developer mode shows the bond (its asset and value, state, coin, when it can
be withdrawn, whether this wallet requires it) and the last watch, with **Watch now**.

#### Issuer-operated assets

The operator may serve an asset issuer-operated: the issuer mints each round's float through
the asset's mint limiter, and every batch's sweep can only burn. The library checks each new
leaf against that profile by itself. Developer mode shows each leaf's batch profile under Leaves
and their dates (`issuer-operated` or `open`) and, for each asset the operator serves
issuer-operated, **Supply**: the operator's report of what it minted, burned and holds under
burn-only sweeps, each mint and burn read again from the wallet's own node. It checks the
transactions the report lists; it does not prove the list complete. User mode shows none of it.

#### Supervised assets

An asset whose issuer can freeze holdings by a rule of the chain (on the testnet, USDC.e and
EURC.e) is held, received and paid like any other, and counted in its one figure. The library
holds a coin of such an asset only as a landing-1 leaf, whose way out of the tree pays one key of
the wallet's own, its landing key (the first on-chain key of the phrase, `landing_address` in the
leaf wallet's `info`). A board, a refresh, a payment received (the receive request names the
landing) and the change of a payment sent all land there; the page computes none of it.

When the issuer freezes that key, or pauses the asset, the frozen part shows under the asset's
figure in either mode, as one sentence ("… is frozen by its issuer: it can't be sent until the
issuer lifts the freeze"); it is never hidden. A payment of it is refused, in user mode in the
same plain words. Developer mode shows each leaf's landing and whether it is frozen, with the
library's note; such a leaf leaves the tree only into the landing key (Exit drill, or sync before
its exit date), where the coin stays frozen on the chain until the issuer lifts the freeze, and is
then spent like any coin. The operator serves no take, no resting order and no Lightning payment
in a supervised asset, so the user composer offers such an asset only through an in-tree swap.

Every refusal is shown in the library's own words. The leaf wallet is the operator wallet
library itself (the same code as the operator's command-line wallet), compiled to WebAssembly
and run in a dedicated worker (`leaves/`), so nothing about a leaf is computed by the page.
Its store is a SQLite file in the browser's private file system for this site, one per
mnemonic. It holds what the mnemonic cannot rebuild, which leaves were spent off-chain and
which forfeits were signed among them, so clearing the site's data loses it. One tab at a time
can hold it.

### Developer mode: leaves in the Trade tab

With developer mode on and an operator joined, the Trade tab's **Pay from** and **Receive to**
offer **Leaf** beside On-chain and Lightning, for a pair of two Sequentia assets. BTC is never a
leaf: a pair with BTC in it has no Leaf choice. A leg on Leaf is settled by the leaf panel under
the choices, in place of **Place order**, and every amount, fee, date and refusal in it is the
leaf wallet's own, shown before anything is signed:

- **Market, Leaf to Leaf**: a take from leaves of an on-chain order. The panel finds the best
  order the operator's round can take (a transparent covenant order on the relay), shows the
  fill, what is given (the price and the operator's fee, from leaves), the price paid to the
  maker on the chain and what rests of the order after it, then takes it on those terms. The
  page hands its forfeit over by its own sync once the operator builds the round; the leaf
  arrives once the round is final. Beside it: **accept another wallet's swap offer**. The
  offer is read first (what is got, given and paid, and the date by which the coins got must be
  taken on the chain), then accepted on those terms; the acceptance is a text to send back.
- **Limit, Leaf to Leaf**: an in-tree swap offered to another wallet that holds leaves of the
  same operator, at the two amounts entered. The offer holds the coins and signs nothing; its
  text goes to the other wallet, and its acceptance, pasted back, completes the swap in one
  reassignment the operator co-signs. Nothing goes on the chain until a round settles it.
- **Limit, pay Leaf, receive On-chain**: an order placed on the chain from leaves. The
  operator's round pays exactly the order's amount into its address, where it rests with the
  wallet offline; what it is paid lands on the chain under the order's key. Once it rests,
  **List it on the relay** posts it to the on-chain book. It is cancelled only by its refund,
  after its date.

Every other combination with a leaf is refused with the reason. User mode shows no Leaf choice.

### Developer mode: contract spends

With developer mode on, a **Contracts** tab spends a contract written with
[`sequentia-contracts`](https://github.com/ConcatenaLabs/sequentia-contracts): a template (a
descriptor and its programs) and an instance of it (the template's values on this chain). The
kit's contract engine does the work; the tab asks it and shows what it answers.

- **Template**: one the kit carries (`sequentia/one-key`, `sequentia/one-key-exit`,
  `sequentia/faucet-drip`, `pignus/vault`, `pignus/offer`, `pignus/vault-threshold`,
  `pignus/offer-threshold`, `sequentia/capped-sale`, `sequentia/subscription-escrow`), or a descriptor pasted with its sources (each with its includes
  resolved, as `seqc expand` prints it). The engine checks a pasted template with the
  contracts' own reader and pinned compiler, and only then adds it to this wallet's list. The
  tab shows this wallet's contract key (`m/8383h/1h/0h/0/0`), the key a template names for it.
- **Instance**: the instance record; the engine recomputes its address, which the tab shows.
- **Coin and path**: the explicit coins the address holds, and the way to spend.
- **Spend**: for the faucet drip covenant's drip, the recipient (this wallet by default), the
  amount and a fee rate in the dripped asset's own units; for any other path, the request
  written by hand: its inputs (the contract coin, this wallet's own coins, a foreign coin spent
  through a script leaf with its witness given, other coins of the same template spent by the
  same tapscript path, each with its own instance) and its outputs, each saying whether it returns
  to the contract, pays this wallet, pays someone, is the fee, opens a contract, or recreates a
  foreign coin. **Fund it from this wallet** lets the wallet add its own coins for what the
  request's inputs do not cover, and the change: a Pignus take, top-up or repayment is written
  this way.

**Review** shows the approval: the template by the registry's name (looked up by the wallet,
never taken from the template), else its commitment root; the path, who can take it and what it
does; every parameter by role; every input by what it is; this wallet's balance change in
every asset, counting what its own coins pay; any contract an output opens; where the coins go;
and what was checked. The engine spends a wallet coin only as this wallet's own record of it
says, and a foreign coin only as the chain's record of it says, which the wallet reads itself.
The wallet signs only when the template is on its list, the engine recomputed the output, it
ran every program against the final transaction, and the key is a contract key or, on a path
that takes no signature, none; its funding keys sign only its own coins. A capped sale's
purchase names the buyer's key itself (`BUYER_KEY`): the wallet signs it only when that key is
its contract key, refuses a purchase past the key's cap before anything is built, and reads
the purchase in its own terms (what is bought, against which cap, what the treasury is paid). **Sign and broadcast** signs the digest of exactly the screen shown. A spend
the engine refuses (a relative lock not yet passed, an amount the program forbids, an output
it cannot account for) is refused before anything is signed, in the engine's words.

### The Trade tab in user mode

On a page configured with `window.SEQ_USER_TRADE = true`, the user composer below is the Trade
tab in user mode; without it, as on the public testnet page, the full composer (developer
mode's, below) is the Trade tab in both modes. The user composer trades only against a live leaf
maker, orders and the pairs `user-mode/pairs.json` admits; a pair nobody offers right now is shown
as not offered. It pays from the wallet's leaves when it holds them, and from its on-chain coins
otherwise: a covenant order is then taken on the chain in one transaction (`user-onchain.js`), so a
new wallet trades without joining an operator first. The network fee of such a fill is paid in the
asset paid for the order, and the asset must be one the node takes fees in. The switch is
described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Three inputs and one button: **You pay** (an asset and an amount), **You get** (an asset), and
**Review**. Both pickers list BTC first. **You pay** then lists what the wallet holds; **You get**
lists every asset the book offers for what is paid in one step now, held or not, and starts on the
first of those, then the rest. Review shows three lines
before anything is signed: what you pay, what you get, and the fees ("Fees 192 XLEAF, included
above"), each fee in the asset it is paid in, the price not counted as one. **Trade** confirms
it; the trade then reads **Sent**, and **Settled** once it is final, or **Returned: nothing
traded.** when it could not go through, with nothing to do either way. A take that first paid the
wallet a coin of exactly its price has spent that payment's small fees even when it is returned;
the return says so ("Fees of … were paid"), and those fees come back to the wallet at that coin's
next refresh. A trade whose price
lapsed before you confirmed it is priced again and shown again. A trade whose step met no answer
(the operator restarting, say) reads **Working…** while the wallet looks for it, and then Sent, or
Returned if it never went through.

User mode trades only what settles in one native step, and never falls back to another route
in the middle of a trade:

- **An in-tree swap with a live maker**: a maker holding coins in the operator's tree quotes a
  price; the wallet reads its firm offer with its own library, signs its side, the maker
  completes it, and the coins the trade brings are settled in the operator's next round. Settled
  means that round is final.
- **A transparent covenant order taken from the wallet's coins in the tree**: the operator's round
  spends the order, pays its maker on the chain, and gives the wallet its coin. Settled means the
  round is final, as the relay also records it.
- **An order resting in the operator's tree**: a maker rested it as a leaf and may be away; the
  wallet fills it from its own coins in one transfer the operator co-signs, on the terms its
  library quoted, and fills it at its new place only on the same terms if another taker filled it
  first. Settled means the relay records the fill final and the coins it brought are settled in a
  round that is final. Only orders resting with the operator the wallet joined are offered.
- **BTC for an asset, or an asset for BTC, with a maker, in one hash-lock**: the asset moves in
  the operator's tree under a payment hash and the BTC over Bitcoin Lightning under the same
  hash, the hash always the BTC receiver's and the asset's giver locking first, so neither side
  can take what it gets before paying (`user-trade-btc.js`). Selling for BTC is Settled once the
  BTC has come, the wallet's payment is settled with the same preimage and the change it left is
  settled in a round that is final; buying with BTC once
  the coin bought is claimed and its round final. BTC is never a coin in the tree and never
  pegged. On the page the wallet's Bitcoin Lightning is its own hosted Bitcoin node, keyless and
  co-signed by the page (`btc-lightning.js`); its first BTC trade brings the node up. Selling for
  BTC, the page draws the preimage and the node holds the payment under its hash until the page
  settles it, which it does only for the whole amount, so neither the node nor the service
  hosting it learns the preimage first. Buying with BTC, the node pays the maker's invoice, its
  routing fee capped at the one the ticket shows. A sale for more BTC than the node has room to
  receive, or a purchase with more than it can pay, is not offered.

Of the trades that can fill the amount you pay, it takes the one that gives you the most, then
the one with the fewest parties left to act. It offers no more than the wallet can pay now. A
pair nobody fills in one step reads "Not offered right now: nobody offers YLEAF for XLEAF in one
step.", and a pair the drill has not passed is not offered at all. Which pairs those are, per
chain, is [`user-mode/pairs.json`](user-mode/pairs.json), with the drill's report beside it.
No screen of it names a rail, a round, a leaf, the operator, a covenant, an expiry or an atom
(`USER_MODE_FORBIDDEN_WORDS` in `user-trade.js`).

### The Trade tab in developer mode

One symmetric composer: "You pay X" / "You receive Y". Both pickers list BTC first, even at 0,
then what the wallet holds; the asset already chosen on a side is marked, never greyed out.
The route is inferred from the pair:

- **Same-chain** (asset ↔ asset on Sequentia): the order funds a SeqOB tapscript covenant
  that rests on-chain; a fill is one transaction that spends it under the script's own rules
  (no co-signature, no escrow, no intermediary). Maker-signed relay offers, where one rests,
  are still taken through the co-signed PSET lift. Before signing, the wallet checks the
  maker's transaction against the swap it proposed, and refuses one that pays it less, pays
  elsewhere, changes the form it asked for or spends any other coin of the wallet: it says so,
  and nothing is signed or moved. The maker completes that transaction; it pays your usual
  address in the clear, like any transfer, unless you tick the review's box to receive at a
  blinded address of this wallet, which the maker then blinds to. A swap paid at the usual
  address spends coins held in the clear, so coins of the paying asset held at a blinded address
  are refused before anything is sent, with what to do about it. The review shows what the book holds within reach of the best price, not the amount
  typed times the best price, and a dash where nothing is within reach. When an offer cannot be
  taken and nothing else within reach can fill, the review closes, says that nothing was filled,
  and leaves the order in the form to review again.
- **Cross-chain** (BTC ↔ asset): a hash-time-locked-contract (HTLC) atomic swap between
  Bitcoin testnet4 and Sequentia. Before revealing any secret the wallet verifies the
  counterparty leg on-chain AND checks that the Sequentia block anchors at or above the
  Bitcoin leg's height. Bitcoin anchoring is what makes this safe: if Bitcoin reorganizes,
  Sequentia reorganizes with it, so an anchored Sequentia leg cannot outlive the Bitcoin leg
  it depends on.
- **Instant (Lightning)** and **mixed** rails for BTC ↔ asset appear when the Lightning
  backend is reachable (see below).

Each side picks its rail where the wallet holds the asset: paying needs a balance on that rail
(on-chain, or spendable in a Lightning channel), receiving over Lightning needs room to receive,
and receiving on-chain always works. A side with one usable rail gets it without asking; a rail
with nothing on it is shown off, and clicking it says why and how to make it usable.

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

The tab states settlement times plainly: a Sequentia block comes about once a minute, a Bitcoin
block about every ten minutes, and Lightning settles at once. A confirmed Sequentia transaction
reverts only if Bitcoin reorgs the block it anchors to, and the tab says so. One side on-chain
and the other over Lightning is not offered, on any pair and in either direction: a reorg could
undo the on-chain side and leave the Lightning payment standing, and making that safe takes a
wait of several Bitcoin blocks. The tab refuses those combinations and links the FAQ entry that
explains them; `window.SEQ_ALLOW_MIXED_RAILS = true` offers them again.

### Lightning (experimental)

The Lightning rails use a hosted-SeqLN LSP model in which the keys stay on your device:

- The server hosts two **keyless** SeqLN nodes (an asset node on Sequentia, a BTC node on
  testnet4). Neither has an `hsm_secret`.
- The browser derives two device identities from your one mnemonic (hardened `m/1017'/...`
  paths, see `seqln-keys.js`) and runs an on-device WASM signer per node, connected over a
  WebSocket Noise_XK (BOLT-8) link. Every commitment update is co-signed on your device. The
  device signs only commitments it has validated, signs a close only if it pays your channel
  balance to the node's own address or to an address of this wallet that the page names to it
  (which is how Move on-chain closes a channel straight into the wallet). It sets no limit on
  what Lightning payments spend (a page can set one with `window.SEQ_LN_PAYMENT_LIMITS`, described
  in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)). It moves the node's coins only to the node's own
  addresses or into a channel the node opens, with the fee held to that limit: sending them to any
  other address, this wallet's included, waits for a way to approve that address on the device.
  That does not protect you from an operator who runs
  both your hosted node and the node your channel is with: the hosted node collects the
  device's signature on each commitment before the device revokes it, so the two together can
  broadcast a revoked commitment and take the channel's funds.
- Moving BTC or a Sequentia asset to Lightning (Move to Lightning, in an asset's details on the Balance tab) is one transaction: your wallet pays the channel's
  2-of-2 output directly, so the coins are never on the hosted node and there is one fee and one
  confirmation. The wallet builds and blinds the transaction, the node's peer signs the
  channel's first commitment (the way back) against it while it is still unsigned, and only then
  does the wallet sign and broadcast it, after checking that it pays exactly the amount, in the
  asset, to the channel, and that its txid is the one the node expects. The signed transaction
  is stored before it is broadcast and sent again on the next open if the tab closed in between.
  BTC channels are funded the same way. With a service that offers only the older way, the coins
  go to the node's own address first and the node funds the channel from there
  (`tooling/lsp/README.md`).
- Receiving over Lightning needs room on the other side of a channel, which the service sells: it
  opens a channel to your node with that room on its side and keeps it open for the months you
  choose, for a fee in the same asset, paid on chain: the amount times the asset's yearly rate
  times the months, with a minimum. Receiving uses up the room and spending makes it again. Move to Lightning asks for it with the move, and the fee is one more output of the
  funding transaction; the service opens its channel once that transaction confirms. Once an
  asset is on Lightning, its Balance row says how much it can receive and offers more room, in
  developer mode.
- On a credit channel (one the service opened as its provider) the service can be paid for you
  while your device is away, and then owes you what it was paid: it signs a note for the whole
  amount it owes you. Every commitment of the channel lets that note, with the payment's proof,
  pay you out of the service's side, whoever brings it; the channel's close pays it; and the
  service cannot move its balance below it. Your device checks each note it learns when it
  returns and refuses any channel update or close that would leave the note unpaid. The wallet
  keeps the latest note of each channel from what the device reports (the signer SDK's
  `onCredit`, `lncredit.js`), so it holds what a claim needs even if the device's store or the
  hosted node is lost, and the Balance tab says what you are owed. Until a note reaches you, you
  have only the service's word: the payment was made to it.
- A trade with both rails set to Lightning settles both legs atomically on one preimage, fully
  off-chain. A mixed rail (one leg on-chain, one Lightning) is a submarine swap.

The status pill next to the wallet title says whether Lightning works: "⚡ Lightning" once the
service answers, "⚡ Lightning…" while it connects and "⚡ Lightning offline" when it cannot be
reached; developer mode says "LN 2 ch" (the wallet's own open channels), "LN ready",
"LN connecting…" or "LN offline" instead. When Lightning is not configured the pill is hidden
and the composer quietly uses the on-chain rails only.

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
| `covenant.js` / `covenant-order.js` / `covenant-flow.js` / `covenant-fill-host.js` | The SeqOB passive-CLOB covenant: the byte-exact leaf and witness builders (pinned to the Go and Python originals), the place/watch-for-fill order flow (and `postExisting`, which lists an order whose coin something else put on the chain, such as an offboard from leaves, once the chain shows it there), the pure composer glue, and the seam that hands raw FILL assembly to wasm. |
| `covenant-sim.js` | SeqDEX's Simplicity order (the template `seqdex/order`): its address from the terms and the pinned commitment root, and a fill's witness from the template's pinned programs, with no compiler; `seqob.js` signs and verifies its offers (`simplicity_covenant`). Pinned to the template's vectors as seqdex vendors them. |
| `seqob.js` | SeqDEX order-book (seqob relay) protocol client: wire codec, offer signing/verification, end-to-end crypter, REST + WebSocket lift driver. |
| `sbtc.js` | Thin client for the SBTC custody bridge (address allocation only; it moves no funds). |
| `ln-rail.js` / `submarine.js` / `subswap.js` | Lightning-rail gating per asset, the mixed-rail (submarine) swap state machine, and the P2P submarine taker + LSP leg-bridge client. |
| `fee-verdict.js` | What Send says about the fee before signing, worded as Sequentia Qt's fee selector: the fee asset refused by the nodes the wallet sends to (not listed, or listed at rate zero), accepted but unpublished on the Asset Registry or unpriced, or fine; and what a typed rate clears against the producer's next block (under the relay floor Send refuses to build it). |
| `fee-panel.js` | The network fee of a payment, set as in Sequentia Qt: the fee asset, a recommended rate for a confirmation target or a custom one, shown and typed as the total or the rate per 100 bytes, in the fee asset or the reference currency. Mounted by Send and by the replace, bump and speed-up dialogs. |
| `btc-wait.js` | What a trade that waits on a Bitcoin block says: one wording for the reviews and quotes (one block, about ten minutes; safe to leave), and how long ago the last testnet4 block was found, for the Active trades rows, which say when testnet4 is running slow. |
| `wait-reason.js` | Why an unconfirmed transaction is still waiting, from the explorer's `/feeinfo` and `/congestion`: a fee asset some nodes refuse, a rate under the mempool floor or under what a full next block takes, or nothing holding it back. Shown in a History row's details. |
| `node-reject.js` | What a node's refusal of a transaction means, and a shortfall the wallet kit reports in atoms and ids (`shortfallText`) said in the asset's units: its reject code (`bad-txns-inputs-missingorspent`, `dust`, `min relay fee not met`…) as a sentence that says nothing was sent and what to do. `prettyErr` in `index.html` asks it first. |
| `tip-watch.js` | Keeps the open wallet up to date: it reads both chains' tips every 30 s while the page is visible, and on becoming visible, and syncs when either has a new block, so a payment received shows without Refresh. |
| `own-txs.js` | The page's own broadcasts of the last hour, put back into the wallet after a scan that has not returned them yet, and only then: the kit's `applyTransaction`, given a transaction the wallet already holds, would make spendable again a change output that the leaf wallet, another device or a covenant has spent since. |
| `ln-invoice-watch.js` | Watches an invoice the Receive card made until the hosted node lists it as paid (`/node/history`), so the card can say "Received". |
| `bolt11.js` | What the wallet reads from a Lightning invoice: its network, amount, payment hash, final CLTV and, on Sequentia, the asset it is paid in (field `a`, which a Sequentia invoice must carry). Copied into the browser extension's `vendor/`. |
| `signmessage.js` | Classic signed messages: the magic-prefixed hash, the recoverable signature, and the legacy address a verifier is given. |
| `descriptor.js` | Output descriptors for the account key: the BIP380 checksum and the receive/change pair a watch-only import takes. |
| `stake-records.js` | Joining, moving and leaving a staking pool, and unbonding: finds the wallet's delegation record, and its stakes on the chain for a browser that does not remember them (a restore), and drives the transactions SWK builds over the staking key's bare scripts. |
| `leaves.js` | The mode setting, and developer mode's Leaves tab, which shows what the leaf wallet answers. |
| `user-trade.js` | The user-mode composer's engine: the ticket for a trade from the single-step book, priced by the leaf library, the trade's record written before anything is signed, and the trade followed to Settled or Returned. No DOM: the page and the drill run the same code. |
| `user-trade-btc.js` | The engine's BTC trades: an asset for BTC or BTC for an asset in one hash-lock with a maker's BTC desk, BTC paid only once the coin received under the hash is held for good. |
| `user-onchain.js` | The engine's on-chain coins: a transparent covenant order taken on the chain in one FILL from the wallet's own coins (`onchain-fill`), its fee in the asset paid. |
| `user-composer.js` | The Trade tab in user mode: the two pickers, the amount, the ticket's three lines, the button, and the trades' Sent and Settled. |
| `user-mode/` | `pairs.json`, the pairs (and their sources) user mode offers on each chain, and the reports of the drill runs that admitted them (`REPORT.md` and the like). |
| `leaf-rail.js` | Developer mode's Leaf choice in the Trade tab and its panel: a take from leaves, an in-tree swap with another wallet, an order placed on the chain from leaves. The settlement router decides what a choice settles as; the leaf wallet decides everything else. |
| `wallet-api.js` | The page API (`window.sequentiaWallet`, the `sequentia-wallet` channel): the mode and, in developer mode, the leaf rail, each action behind the wallet's approval dialog ([docs/PAGE_API.md](docs/PAGE_API.md)). |
| `leaf-request.js` | Reads a receive request to show it before a payment, and shapes the library's balance for the page API. Copied into the browser extension's `src/`. |
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
| `tooling/lsp/` | The hosted-SeqLN LSP backend service and provisioning/harness scripts, with [its own README](tooling/lsp/README.md), and the live leaf maker (`leaf-maker.mjs`) user mode trades with. Four of its modules (`settlement-router.mjs`, `unified-book.mjs`, `single-step-book.mjs`, `bridge-driver.mjs`) are also imported by the browser. |
| `tooling/build-leaf-wallet.sh` | Builds `leaves/pkg` from an arca checkout's `wallet-wasm/`, every build-machine path remapped. |
| `tooling/leaf-node.mjs` | The leaf library (`leaves/pkg`) run in Node, with its storage and synchronous requests given to it: for the leaf maker and the drill. |
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
| `/anchor/<blockhash>`, `/anchorstatus` | Anchor lookups used by the cross-chain maker's safety gate |
| `/openamp` | OpenAMP restricted-asset API (optional; wallet degrades gracefully) |
| `/lsp`, `/lsp-ws-asset`, `/lsp-ws-btc` | Hosted-SeqLN LSP + per-node signer WebSockets (optional; Lightning rails stay off without them) |
| `/leafmaker`, `/leafmaker-btc` | The live leaf makers user mode trades with: in-tree swaps, and BTC in one hash-lock (optional; user mode offers what answers) |
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
covenant scripts (`covenant.test.mjs`, `covenant-byteorder.test.mjs`, `covenant-order.test.mjs`,
`covenant-flow.test.mjs`, `covenant-post-existing.test.mjs`); each also runs on its own, for example
`node covenant-byteorder.test.mjs`. `covenant-fills.test.mjs` holds the multi-order fill layout to
the vectors seqdex's Go planner writes (`covenant-fill-vectors.json`), and
`covenant-offer-move.test.mjs` verifies Go-signed covenant offers before and after the relay moves
their outpoint (`covenant-offer-vectors.json`). `covenant-sim.test.mjs` holds the Simplicity order
to each version's vectors and programs (version 2, which every new order uses and which refuses
an annex: `seqdex-order-2-vectors.json`, `seqdex-order-2-fills.json`; version 1, for orders
resting from before it: `seqdex-order-vectors.json`, `seqdex-order-fills.json`)
and its offers to Go's signed bytes (`simplicity-offer-vectors.json`); `covenant-terms.test.mjs` holds
the tapscript leaf's refusal of a term of 2^63 or more to Go's (`covenant-terms-vectors.json`), and
`time-in-force-offer.test.mjs` verifies Go-signed offers carrying each `time_in_force`
(`time-in-force-offer-vectors.json`).

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

`SEQUENTIA_BIN=<Sequentia>/src SEQOBD=… OCEAND=… SEQOB_MAKER=… SEQOB_OCTL=… node
tooling/interactive-maker-drive.mjs [honest|shortpay|blind] [--tick] <evidence-dir>` drives
developer mode's Swap tab in a headless Chromium against a live interactive maker on a private
regtest chain (`tooling/interactive-maker-stack.mjs`): SeqDEX's wallet daemon and order-book
maker (`oceand`, `seqob-maker`, `seqob-octl` from the `seqdex` repository) rest an offer and
co-sign each lift over the relay's courier. A market buy of tSEQ with USDX fills with the review
as it opens: every output paying the wallet is at its usual address in the clear, and both sides'
balances move by exactly the trade and its fee (`--tick` receives it blinded instead). With the
wallet's USDX only at its blinded address (`blinded-coins`) the order is refused before anything
is sent, saying why. Against a maker built to pay one atom
less (`shortpay`) or to blind the output that pays the wallet to its own key (`blind`)
(`seqob-maker` built from a `seqdex` checkout with `tooling/hostile-maker.patch` applied; the drive
sets `SEQOB_HOSTILE` to the mode), the page says that nothing was signed and nothing moves.

`SEQUENTIA_BIN=<Sequentia>/src node tooling/contracts-regtest.mjs <evidence-dir>` drives the
Contracts tab in a headless Chromium against a private regtest chain: a faucet drip covenant
whose faucet key is the page's contract key is funded, dripped from through the approval
screen and confirmed, and a drip before the interval, one above the tier and one whose
successor is not the covenant are each refused before signing. The tab runs there on
`tooling/contracts-harness.html`, which mounts the same module on the regtest network, since
`index.html` is bound to the testnet. `SEQUENTIA_BIN=<Sequentia>/src node
tooling/contracts-vault-regtest.mjs <evidence-dir>` runs a Pignus version 2 loan through the same
tab: a take that opens a vault, a top-up and a repayment, each written by hand, funded from the
wallet, shown and signed from the approval screen and confirmed, and a wallet input said to be
in another asset refused. Its chain is anchored to a regtest parent (the kit reads anchored
headers to sync the wallet), served through `tooling/esplora-shim.mjs`.
`node tooling/contracts-tab-probe.mjs` checks the tab in
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
operator and its node behind the same origin, for working on the tab by hand (`--seqob URL`
puts an order-book relay behind `/seqob/` too).

`node tooling/profiles-drive.mjs <evidence-dir>` drives the same harness started with
`ARCA_OPERATOR_SUPERVISED=1 ARCA_OPERATOR_ISSUER=1` (a supervised asset, an issuer-operated
asset, and the bond the drive posts): a payment that needs a planned leaf made through the next
round with no prompt; the supervised asset boarded, received and refreshed at the wallet's
landing key, frozen by its issuer (the sentence in both modes, a payment refused), taken home by
its landing (frozen on the chain), lifted and paid again; the issuer-operated asset's batch
profile and supply; a receive refused while the bond is in notice; and the user-mode screens free
of the developer words. With `SEQ_DRIVE_MNEMONIC_FILE` naming a file, it opens the phrase there,
or writes there the phrase it creates, so another wallet can be driven with the same phrase.

`node tooling/leaf-rail-drive.mjs <evidence-dir>` drives the Trade tab's leaf rail in two
headless Chromium profiles against the same harness and SeqDEX's relay (`SEQOBD=/path/to/seqobd`,
started on a port of its own against the harness's node): no Leaf choice in user mode; an
in-tree swap offered, read, accepted and completed between the two wallets, both balances
checked; an order placed on the chain from leaves, rested and listed on the relay; and a take of
it from leaves, its fill round checked at the node.

`node tooling/user-mode-drive.mjs <evidence-dir> [--pairs FILE]` drives the Trade tab in user
mode in headless Chromium against the same harness, SeqDEX's relay (`SEQOBD`), a live leaf maker
it starts and a covenant order it places: the user composer and nothing of developer mode's, BTC
first in both pickers, the word list checked on every screen; a trade settled in the tree against
the maker; a take of the covenant order once the maker stops; a pair not offered; developer
mode as before; and a new wallet, never joined to an operator, that holds an asset only on the
chain and trades it in default mode by taking the covenant order on the chain.

`node tooling/user-mode-drill.mjs --trades 500 --wallets 3 --out DIR` is the reliability bar for
user mode: that many trades through the composer's own engine (each wallet a process of its own,
`tooling/user-mode-wallet.mjs`), with the wallet killed mid-trade and started again, the operator
restarted and the parent chain reorganised under a trade's round, every trade counted settled or
returned with no user action and its ticket checked against what moved. It writes `REPORT.md`
and, when every trade passed, the chain's entry for `user-mode/pairs.json`. With `--btc`, on a
harness started with `ARCA_OPERATOR_LIGHTNING` and `ARCA_OPERATOR_BTC_LIGHTNING`, BTC trades with
the maker's BTC desk join, each wallet on a Bitcoin Lightning node of its own
(`tooling/cln-rpc.mjs`); `--btc-only` runs the BTC directions alone and admits only the BTC
pairs. With `--every-pair tooling/user-mode-every-pair.json`, on a harness started with
`ARCA_OPERATOR_MORE_ASSETS=7 ARCA_OPERATOR_SUPERVISED=2`, it trades every directed pair of the
testnet's assets, each standing in as a harness asset priced the same per atom: a pair with a
supervised asset through the live maker only, the others through the maker, covenant orders and
orders resting in the tree. With `--btc` as well, on a harness that also has
`ARCA_OPERATOR_LIGHTNING=1 ARCA_OPERATOR_BTC_LIGHTNING=3` (a Lightning leg in every plain asset),
BTC is traded against every plain asset through the maker's BTC desk; `--btc-only` runs those
pairs alone. The run also writes `pairs-testnet.json`, the same pairs under the testnet's ids.
With `--onchain` (either mode), each wallet also holds coins on the chain, read and spent with
the wallet kit as the page does (`tooling/user-mode-onchain-node.mjs`, needing a kit build with
`Network.regtestWithGenesis` in `LWK_PKG`), and the last wallet holds coins on the chain only, as a
new wallet does: covenant orders are then also taken on the chain (`onchain-fill`). In every mode
a pair is admitted with the sources that settled at least one of its trades.

`node tooling/user-mode-btc-drive.mjs <evidence-dir>` drives user mode's BTC trades in headless
Chromium against the same harness started with `ARCA_OPERATOR_LIGHTNING=1` and
`ARCA_OPERATOR_BTC_LIGHTNING=1`, the hosted-node service (`tooling/lsp/lsp-server.mjs`) provisioning
the page's own keyless Bitcoin node, co-signed by the page over the service's websocket
(`SEQLN_DIR` names a SeqLN build, `SEQUENTIA_DIR` a Sequentia one): XLEAF for BTC and BTC for XLEAF, each Settled, and a sale whose
maker goes away once the wallet's side is locked, Returned with no BTC moved.

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
