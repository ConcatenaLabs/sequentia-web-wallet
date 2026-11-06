# The web wallet's page API

The web wallet serves its mode and its leaf rail to code running in its own pages, in the
shape the browser extension's provider serves them to sites (the extension's
`doc/PROVIDER.md`, sections "The wallet's mode" and "Leaves"). A page written against one
works against the other: the methods, their arguments, their answers and their refusals are
the same.

Two ways in:

- **On the wallet's page**, `window.sequentiaWallet` once the wallet is open:
  `request({ method, params })` answers a promise, `on(event, handler)` and
  `removeListener(event, handler)` subscribe and unsubscribe. `isSequentiaWallet` is `true`.
- **On another page of the wallet's origin**, the `BroadcastChannel` named
  `sequentia-wallet`, while a wallet page is open: post
  `{ type: 'request', id, from, method: 'getWalletMode' }` and the wallet answers
  `{ type: 'answer', id, to: from, ok: true, result: { mode } }`; it posts
  `{ type: 'event', event: 'modeChanged', data: { mode } }` whenever the mode changes. The leaf
  methods are not served over the channel: they are on the wallet's page.
- **A site of the wallet's origin** (SeqDEX at `/dex/`) trades through an open wallet page over
  the same channel, once the wallet's owner connects it there. See "Sites of this origin" below.

There is no connection step for the wallet's own page: the page API is the wallet's own, on its own
origin. A site of the origin connects first, as below.

## The mode

### `getWalletMode()`: silent

`{ mode: 'developer' | 'user' }`. The mode is one setting (Settings → Mode), kept for each
wallet, user mode until the user changes it. The words are the same in every Sequentia
wallet:

- **User mode**: The wallet chooses how value moves.
- **Developer mode**: Leaves as a rail you can choose, and the developer tools (the Leaves and
  Contracts tabs). The Balance tab is the same in both modes.

A page follows the mode: its developer features show in developer mode only. `modeChanged`
(`{ mode }`) fires when the user changes it.

## Leaves (developer mode)

Leaves are coins of Sequentia assets held in an operator's tree, off the chain. In user mode
every method below refuses, and no leaf event reaches the page; the wallet's leaf wallet
keeps syncing all the same once the wallet has joined an operator, and its value counts in
each asset's figure and the headline; the wallet's own Trade tab trades from it in user mode
without naming it, and no page method reaches that. Native BTC is never a leaf: a tree on Sequentia holds
no BTC.

Every answer and refusal is the leaf wallet library's (it runs in `leaves/worker.js`).
Refusals common to every method:

- `leaves are a developer-mode rail: turn developer mode on in the wallet's Settings`
- `this wallet has not joined a leaf operator: join one in the wallet's Leaves tab`
- `the user rejected the request`, for a method behind the approval dialog
- a refusal of the library, in its words (`refused: …`, `the server refused …`)

| Method | Approval | Answers |
| --- | --- | --- |
| `getLeafBalances()` | silent | `{ leaves: { asset: { total, states } }, onchain: { asset: atoms }, value, schedule }` |
| `getLeafAddress()` | silent | `{ address, script_pubkey }`: the leaf wallet's on-chain address, the same each time |
| `requestLeafReceive({ asset?, amount? })` | the dialog shows the asset and amount, or "any" | the library's `receive`: `{ request, details }` |
| `sendLeaves({ request, asset?, amount? })` | the dialog shows the asset, the amount, the receiver's key and mailbox, the lapse | the library's `send` |
| `boardLeaves({ asset, amount, fee_asset? })` | the dialog shows the amount, the fee and the size, from the library's `board_quote` | the library's `board`, paid on the fee shown only |
| `exitLeaf({ leaf_id, fee_asset? })` | the dialog shows each transaction's size, fee and what pays it, the claim's fee and the exit delay, from the library's `exit_quote` | the library's `exit`, broadcast on the fees shown only |

Amounts are atoms, as strings. A board's fee is in `fee_asset`, or in the asset boarded when
none is named; nothing else is chosen. An exit's fees are paid from what each transaction
carries for them where that pays the node's floor, and otherwise from an on-chain coin of the
leaf wallet's, in `fee_asset` or in the asset the library chooses.

A board or an exit whose fees changed between the dialog and the signature is refused before
anything is registered or broadcast:
`refused: the board's fee changed since it was shown; it is now {…}`,
`refused: the exit's fees changed since they were shown; they are now {…}`.

Events, in developer mode only:

- `leafArrived`: `{ leaf_id, asset, value, kind }` for each coin a sync took from the mailbox.
- `leafSyncDue`: `{ now, next_sync_at, why }` when the library's schedule falls due.

## Example

```js
const w = window.sequentiaWallet
const { mode } = await w.request({ method: 'getWalletMode' })
document.querySelector('#leafFeatures').hidden = mode !== 'developer'
w.on('modeChanged', ({ mode }) => { document.querySelector('#leafFeatures').hidden = mode !== 'developer' })
if (mode === 'developer') {
  const { address } = await w.request({ method: 'getLeafAddress' })
  const board = await w.request({ method: 'boardLeaves', params: { asset, amount: '1000000' } })
}
```

## Sites of this origin

A site served on the wallet's origin trades through an open wallet page over the
`sequentia-wallet` channel, with the messages of the browser extension's `doc/PAIRING.md` ("Same
origin"): the site posts `{ type: 'hello', from }`, every open wallet page answers
`{ type: 'here', to, wallet, provider: 'sequentia-web-wallet', mode }`, and the site sends
`{ type: 'request', id, from, wallet, page, method, params }` to one of them, which answers
`{ type: 'answer', id, to, wallet, ok, result | error }`.

The methods are the provider protocol's (the extension's `doc/PROVIDER.md`), with its params,
answers and refusals:

| Method | Approval | Answers |
| --- | --- | --- |
| `getCapabilities()` | silent | `{ provider: 'sequentia-web-wallet', methods, events, features }` |
| `getWalletMode()` | silent | `{ mode }` |
| `connect()` | this page's dialog: "Connect SeqDEX?" | `{ network, address }` (the shared `tb1` address) |
| `getAccounts()` | silent | `{ accounts: [account] }`, or `[]` until connected |
| `getBalances()` | silent | `{ assets, btc, leaves, total, arriving, spendable }` (and `by_place` in developer mode): on-chain Sequentia assets, BTC on the chain, what is held as leaves and spendable now, one figure per asset wherever it is held, what of it is arriving, and what a trade can pay from now (the composer's own figure), each in atoms |
| `placeOrder({ type, base, quote, side, amount, price?, post_only?, rest?, min_fill?, take_back_after? })` | this page's dialog | `{ trade, filled, failed, order, order_error, gave, got }` |
| `getOrders()` | silent | `{ orders, trades }` |
| `cancelOrder({ order })` | this page's dialog | `{ order, txid }` |
| `signMessage({ message })` | this page's dialog: "Sign a message for Emissio?" | `{ address, signature }`: the Sign tab's signature ("Bitcoin Signed Message", base64), by the key of the shared `tb1` address |
| `getNetwork()` | silent | `{ network, genesis }`: the network's name and its genesis block hash |
| `getAddress()` | silent | `{ address, index }`: the shared `tb1` address |
| `getUtxos({ asset? })` | silent | `{ utxos: [{ txid, vout, asset, value, scriptPubkey, address, height, explicit }] }`: the wallet's coins on the chain in the clear, the ones a site's transaction can spend |
| `signPset({ pset })` | this page's dialog: "Sign a transaction for Pignus?" | `{ pset }`: signed for this wallet's inputs, neither finalized nor broadcast |
| `broadcast({ pset? , hex? })` | silent | `{ txid }`: a signed PSET finalized and sent, or a raw transaction sent, on Sequentia |
| `prepareCoins({ coins: [{ asset, amount }] })` | this page's dialog when anything moves: "Get coins ready for Pignus?" | `{ moved: [{ asset, amount }] }`: what was moved onto the chain, empty when the coins were there |

A connection lasts while the wallet page is open, for the site's page (its address without the
query). Until then every method but the first three and `signMessage` refuses with
`this site is not connected; call connect first`; a declined dialog refuses with
`the user rejected the request`. One dialog shows at a time, and the page asks the browser to bring
it forward.

`signMessage` needs no connection: its dialog is the approval, and shows the site, the exact
message and the address that signs it, under "This proves the wallet is yours. It moves no
coins." A message is one line of text of at most 1,000 characters; one with a line break, a
control character or a mark that reorders text is refused with `message must be one line of text
of at most 1000 characters`, so the dialog always shows the whole of what is signed. The
signature is over the "Bitcoin Signed Message" hash of the text, which is no transaction's
signature hash, so it proves control of the address and authorises nothing else. Signing
connects nothing: `getAccounts` still answers `[]` until `connect`. `signMessage` is a method of the provider protocol (the browser extension's `doc/PROVIDER.md`),
and these are its rules in every wallet that serves it.

The last six serve a site that builds its own transactions, such as Pignus, which composes every
loan's transaction from the coins `getUtxos` lists and the terms it checked itself. `getNetwork`
needs no connection; the others do. `signPset` reads the PSET from its bytes once the wallet has
written its own key origins on it (a site cannot know them), so a transparent transaction, which is
what a covenant settles, reads in full. The dialog shows **You pay** (each asset the wallet sends,
the fee apart), **You receive**, **Network fee** (with ", paid by the transaction, not from your
coins" when another input pays it) and **Asked by**, then **Approve** or **Reject**; only the
site's own bytes are signed, and the key origins are taken out again before the PSET goes back.
Before any dialog it refuses a PSET it cannot read (`this wallet cannot read that transaction, so
it signs nothing`), one in which none of the inputs is the wallet's (`this wallet holds none of
the inputs in that transaction`), and one that spends a confidential coin of the wallet's.
`broadcast` sends Sequentia transactions only; `chain: 'bitcoin'` is refused.

`prepareCoins` asks for coins on the chain in the clear, which a site's transaction can spend.
Default mode holds what it receives in the Ark, so when the wallet holds less than `amount` of an
asset on the chain, its dialog shows each amount it moves (**Moves**), the fee the Ark quotes
for moving it (**Fee for the move**) and the site, and on approval it moves what is missing out of the Ark to its own address, as Stake does, and answers
once the coins have arrived; they stay the wallet's. When the
coins are already there it answers at once, with no dialog. Developer mode moves nothing by
itself: it refuses with the amount it is short.

`placeOrder` settles as the Trade tab does (`site-orders.js`): a market order is one trade of the
user composer's engine, priced and settled from the wallet's leaves or on-chain coins; a limit
order is that trade when its price meets the limit, and otherwise rests whole on the book as an
order placed from the wallet's leaves, which the page lists on the relay once it rests (while it
is open) and takes back by its refund once its time has run out. The dialog's words are default
mode's (`docs/DEFAULT_MODE.md`): what is paid, what is got, the fees, and the site that asked.

A limit order takes four options, each listed in `getCapabilities().features`:

- `post_only: true` (`order-post-only`): the order only rests. One that would trade at once is
  refused before any dialog with "This order would trade at once. Nothing was placed."
- `rest: false` (`order-no-rest`): the order only trades. When the book does not meet the price
  it is refused with "Nothing on the book meets that price right now." It cannot be asked with
  `post_only`.
- `min_fill` (`order-min-fill`): base atoms, the smallest part of the resting order one fill may
  take (at the price, in what a purchase pays). Without it, a tenth of the order.
- `take_back_after` (`order-take-back-after`): whole seconds from now, from 3600 (an hour) to
  604800 (a week), after which what is left can be taken back. Without it, a day. The operator
  takes a resting order only some hours ahead of its refund (its `order_margin_seconds`), so a
  shorter time becomes the earliest it allows; the dialog shows the time it is.

A market order refuses all four.

`getOrders` lists each trade the site made with a `state` and a `note`. The state is `sent` once
the wallet has paid or signed its side, and `received` as soon as what the trade brings is the
wallet's (a swap with a maker is received seconds after it is sent). It is `settled` once the
trade's coins are settled with the network, and `failed` when it did not happen and what was
paid came back. The note says the same in the wallet's own words, with the minutes a trade has
waited, for a site to show beside its state.
