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
  `{ type: 'request', id, method: 'getWalletMode' }` and the wallet answers
  `{ type: 'answer', id, ok: true, result: { mode } }`; it posts
  `{ type: 'event', event: 'modeChanged', data: { mode } }` whenever the mode changes. Only the
  mode is served over the channel: an action needs the wallet's approval dialog, which is on
  the wallet's page.

There is no connection step: the page API is the wallet's own, on its own origin.

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
each asset's figure and the headline. Native BTC is never a leaf: a tree on Sequentia holds
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
