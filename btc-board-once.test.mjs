// A board into the Bitcoin ark is counted once in BTC's figure while the address read lags the
// broadcast (#533). The live case: 110,000 sat at the address, a board of 87,083 (86,753 in the
// ark), and the address read still showing the 110,000 for about a minute after the broadcast.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heldBesideBoard, boardSeen } from './btc-ark.js'

const A = 'tb1qaddressone', CH = 'tb1qchange'
const coin = (txid, vout, value) => ({ txid, vout, value })
const ARK = 86_753n

// The board: two of the page's coins in, 87,083 to the ark, change 22,475 back.
const hold = { inputs: new Set(['aa:0', 'bb:1']), addrs: new Set([A, CH]), sats: 87_525n, at: 0,
  change: { txid: 'bd', vout: 1, value: 22_475n, address: CH } }
const lagging = new Map([[A, [coin('aa', 0, 60_000n), coin('bb', 1, 50_000n)]], [CH, []]])
const caughtUp = new Map([[A, []], [CH, [coin('bd', 1, 22_475n)]]])
const figure = (lists) => [...lists].reduce((n, [a, us]) => n + heldBesideBoard(us, hold, a), 0n) + ARK

test('the old rule: any scan after the broadcast ends the hold, and a lagging read counts the board twice', () => {
  // What the page did before: the hold was dropped once a scan that began after the broadcast ran,
  // and that scan's address figure (stats of the lagging read) was taken as it came.
  const statsLagging = 110_000n
  assert.equal(statsLagging + ARK, 196_753n, 'the 0.00196753 BX1 saw')
})

test('a lagging read and a caught-up read give the same figure: the board counted once', () => {
  assert.equal(figure(lagging), 22_475n + ARK)
  assert.equal(figure(caughtUp), 22_475n + ARK)
  // The total moves only by the board's fees: 110,000 before, 109,228 after.
  assert.equal(figure(caughtUp), 109_228n)
})

test('coins that arrive meanwhile are counted, whatever the read has seen of the board', () => {
  const plus = new Map([[A, [coin('aa', 0, 60_000n), coin('bb', 1, 50_000n), coin('cc', 0, 5_000n)]], [CH, []]])
  assert.equal(figure(plus), 22_475n + 5_000n + ARK)
})

test('the hold ends only once the lists show the board whole', () => {
  assert.equal(boardSeen(lagging, hold), false)
  assert.equal(boardSeen(new Map([[A, []], [CH, []]]), hold), false, 'the change not listed yet')
  assert.equal(boardSeen(caughtUp, hold), true)
  assert.equal(boardSeen(new Map([[A, []]]), { ...hold, change: null }), true, 'a board with no change')
  assert.equal(boardSeen(lagging, null), true)
})
