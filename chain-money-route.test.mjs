// Default mode spends one balance whichever way completes soonest: the rules that pick the way for
// money held on the chain (default-arca.js codeRoute, addressRoute), and the figure that keeps the
// wallet's own money moved in (leaves.js arrivingCoins: a board is never "arriving").
//
//   node --test chain-money-route.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { codeRoute, addressRoute, DEFAULT_WORDS } from './default-arca.js'
import { arrivingCoins, arrivingByAsset } from './leaves.js'

const X = 'aa'.repeat(32)
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')

test('a receive code: the tree when it covers it, else the chain at the code\'s address, else moved in first', () => {
  // All of it on the chain, the code naming an address: paid there (after the next block).
  assert.equal(codeRoute({ amount: 1000000n, chain: 3000000n, movable: 3000000n, margin: 2000n, address: true }), 'chain')
  // No address (a receive request alone): moved in first, then paid in the tree.
  assert.equal(codeRoute({ amount: 1000000n, chain: 3000000n, movable: 3000000n, margin: 2000n, address: false }), 'bring-in')
  // The tree covers it, with what is on its way there: in the tree, whatever the chain holds.
  assert.equal(codeRoute({ amount: 1000000n, tree: 600000n, onItsWay: 500000n, chain: 3000000n, movable: 3000000n, margin: 2000n, address: true }), 'tree')
  // Needs both: one payment, the chain's part moved in first.
  assert.equal(codeRoute({ amount: 2500000n, tree: 1490000n, chain: 2000000n, movable: 2000000n, margin: 2000n, address: true }), 'bring-in')
  // The chain alone covers it but not its fee's margin, nor do both together: the tree's own words.
  assert.equal(codeRoute({ amount: 3000000n, chain: 3000000n, movable: 3000000n, margin: 2000n, address: true }), 'tree')
  // On the chain in an asset that cannot be moved in, no address: the tree's own words.
  assert.equal(codeRoute({ amount: 1000000n, chain: 3000000n, movable: 0n, margin: 2000n }), 'tree')
})

test('an address: the chain first, then the tree, then what is arriving, then both together moved in', () => {
  assert.equal(addressRoute(1000000n, 3000000n, 0n, 2000n), 'chain')
  assert.equal(addressRoute(1000000n, 0n, 1500000n, 2000n), 'tree')
  assert.equal(addressRoute(2500000n, 2000000n, 1490000n, 2000n, 0n, 2000000n, 4000n), 'bring-in')
  // Nothing to move in: as before, nothing (the page's own build then says what it says).
  assert.equal(addressRoute(2500000n, 2000000n, 1490000n, 2000n), null)
  assert.equal(addressRoute(5000000n, 2000000n, 1490000n, 2000n, 0n, 2000000n, 4000n), null)
})

test('the wallet\'s own money moved in stays in the figure: a board is not arriving; a payment past the limit is', () => {
  const places = { coins: [
    { leaf_id: 'b', asset: X, value: '2999961', state: 'pending', kind: 'board', place: 'arriving' },
    { leaf_id: 'p', asset: X, value: '500', state: 'live', kind: 'transfer', place: 'arriving' },
  ] }
  assert.deepEqual(arrivingCoins(places).map((c) => c.leaf_id), ['p'])
  assert.equal(arrivingByAsset(places).get(X), 500n)
})

test('the page counts a payment received on the chain in what can be sent and traded once it is in a block; until then it is arriving, marked', () => {
  const body = (name) => { const i = html.search(new RegExp('\\nfunction ' + name + '\\(')); return html.slice(i, html.indexOf('\n}', i + 1)) }
  // Only a payment from someone else that is not in a block yet stays out of what can be spent.
  assert.match(body('chainDeposits'), /if\(u\.height\(\)!=null\) continue;/)
  assert.match(body('chainDeposits'), /if\(own\.has\(id\)\) continue;/)
  assert.ok(!/boardable/.test(body('chainDeposits')), 'a coin in a block counts whether or not it can be moved in')
  assert.match(body('availableFor'), /chainUnconfirmed\(\)\.get\(hex\)/)
  assert.match(body('userHeld'), /chainHeld\(a\)/)
  assert.match(body('assetFigure'), /chainHeld\(v\)/)
  // Said: arriving under the figure, and marked in History, in about a minute.
  assert.match(html, /arrivingIn \+= chainUnconfirmed\(\)\.get\(kind\)/)
  assert.match(html, /_depositTx\.has\(txid\)\) mid\.appendChild\(el\('div','sub unconf', DEFAULT_WORDS\.rowArriving\+' · '\+DEFAULT_WORDS\.arrivingSoon\)\)/)
  // The words: how long, never "try again", no rail named.
  assert.equal(DEFAULT_WORDS.bringIn(5), 'Goes through within about 5 minutes. Keep this page open.')
  const words = [DEFAULT_WORDS.bringIn(5), DEFAULT_WORDS.bringLate, DEFAULT_WORDS.bringRefused, DEFAULT_WORDS.feeMoved, DEFAULT_WORDS.feeAtMost('1', 'X', '')]
  for (const w of words) {
    assert.ok(!/try again|something went wrong/i.test(w), w)
    assert.ok(!/ark|arca|leaf|board|round|operator|lightning|chain|limit/i.test(w), w)
  }
})
