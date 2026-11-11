// Default mode on ordinary coins (docs/DEFAULT_MODE.md, Balance, Trade, History): the figure is
// what the wallet can trade or send now, read from the library's `coin_places`; what is not yet the
// wallet's is in History alone; no channel is opened, named or kept; a settled trade can be undone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { careArgs, arrivingByAsset, arrivingCoins, channelsToClose, instantLimitArgs, DEFAULT_INSTANT_LIMIT, refreshLeaves } from './leaves.js'
import { arrivingRows, DEFAULT_WORDS } from './default-arca.js'
import { tradeRows } from './instant-history.js'
import { tradeStateWord, USER_WORDS, UNDO_WINDOW_MS } from './user-trade.js'

const X = '75'.repeat(32)
const Y = '7f'.repeat(32)

const places = { coins: [
  { leaf_id: 'a1', asset: X, value: '400000', state: 'live', place: 'counted' },
  { leaf_id: 'a2', asset: X, value: '1500000', state: 'live', place: 'arriving' },
  { leaf_id: 'a3', asset: Y, value: '700', state: 'pending', place: 'arriving' },
  { leaf_id: 'a4', asset: X, value: '900', state: 'exiting', place: 'arriving' },
  { leaf_id: 'a5', asset: Y, value: '5000', state: 'live', place: 'proceeds' },
  { leaf_id: 'a6', asset: Y, value: '8000', state: 'given', place: 'settled' },
] }

test('the instant limit is 500 dollars in default mode and none in developer mode', () => {
  assert.equal(DEFAULT_INSTANT_LIMIT, '50000000000', '500 dollars in atoms of a hundred-millionth of a dollar')
  assert.deepEqual(instantLimitArgs(false), { value: '50000000000' })
  assert.deepEqual(instantLimitArgs(true), { value: 'off' })
})

test('what is arriving, by asset: arriving coins, pending ones and those coming back; nothing else', () => {
  const m = arrivingByAsset(places)
  assert.equal(m.get(X), 1_500_900n)
  assert.equal(m.get(Y), 700n)
  assert.deepEqual(arrivingCoins(places).map((c) => c.leaf_id), ['a2', 'a3', 'a4'])
  assert.equal(arrivingByAsset(null).size, 0, 'a library without coin_places takes nothing out')
})

test('History rows for what is arriving: one each, a coming-back one in days, none a received row shows', () => {
  const rows = arrivingRows(arrivingCoins(places), ['a3'])
  assert.deepEqual(rows.map((r) => [r.leaf, r.kind, r.when]), [
    ['a2', 'arriving', DEFAULT_WORDS.arrivingSoon], ['a4', 'coming_back', DEFAULT_WORDS.comingBackWhen]])
  assert.equal(DEFAULT_WORDS.arrivingSoon, 'about a minute')
  const shown = [DEFAULT_WORDS.rowArriving, DEFAULT_WORDS.rowComingBack, DEFAULT_WORDS.arrivingSoon, DEFAULT_WORDS.comingBackWhen,
    USER_WORDS.undone].join(' ')
  for (const w of ['limit', 'round', 'coin', 'channel', 'leaf', 'rail']) assert.ok(!new RegExp('\\b' + w).test(shown), `no "${w}" in what default mode says`)
})

test('default mode opens no channel and closes the live ones; developer mode keeps them', () => {
  assert.deepEqual(careArgs(21, false, ['a'], false), { channels: false, scan: 21 })
  assert.deepEqual(careArgs(21, false, ['a'], true), { channels: true, scan: 21, no_open: ['a'] })
  const chans = [{ leaf_id: 'c1', coin_state: 'live' }, { leaf_id: 'c2', coin_state: 'given' }, { leaf_id: null, coin_state: 'live' }]
  assert.deepEqual(channelsToClose(chans), ['c1'])
})

test('a settled trade the library marks undone reads as undone, with what was paid coming back', () => {
  const ticket = { payAsset: X, receiveAsset: Y, amountIn: '300000', amountOut: '400000', fees: [] }
  const r = { id: 't', ticket, state: 'undone', sentAt: 1, swap: 's' }
  assert.equal(tradeStateWord(r), USER_WORDS.undone)
  assert.match(USER_WORDS.undone, /on its way back to you/)
  const rows = tradeRows([r])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].trade.state, 'undone')
  assert.equal(UNDO_WINDOW_MS, 3 * 86_400_000)
})

test('the arriving rule refreshes the arriving coins alone; any other rule, every received coin', () => {
  assert.deepEqual(refreshLeaves({ needed: true, reasons: [{ rule: 'arriving', coins: ['a2', 'a3'] }] }), ['a2', 'a3'])
  assert.equal(refreshLeaves({ needed: true, reasons: [{ rule: 'arriving', coins: ['a2'] }, { rule: 'idle' }] }), null)
  assert.equal(refreshLeaves({ needed: true, reasons: [{ rule: 'exposure' }] }), null)
  assert.equal(refreshLeaves(null), null)
})

test('a channel the wallet is closing is coming back, at its side alone, in about a minute', () => {
  const p = { coins: [{ leaf_id: 'ch', asset: X, value: '3400000', state: 'live', place: 'arriving', channel: true }] }
  const rows = arrivingRows(arrivingCoins(p))
  assert.deepEqual(rows.map((r) => [r.kind, r.atoms, r.when]), [['coming_back', 3_400_000n, DEFAULT_WORDS.arrivingSoon]])
})
