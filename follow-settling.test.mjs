// A received trade still settling with the network is followed every few seconds until the
// wallet calls it late, so "Settled" shows as soon as the network has settled it (the testnet's
// trades check met a row reading "Received, settling" past its bound while the operator had
// released it, the page following it every 30 s).
import test from 'node:test'
import assert from 'node:assert/strict'
import { followFast, FOLLOW_FAST_MS } from './user-composer.js'

const now = 10_000_000
const rec = (ageMs, extra) => ({ source: 'leaf-maker', swapState: 'done', state: 'sent', sentAt: now - ageMs, ...extra })

test('a trade sent within FOLLOW_FAST_MS is followed fast', () => {
  assert.equal(followFast([rec(10_000)], now), true)
})

test('a received trade still settling is followed fast past FOLLOW_FAST_MS, until it is late', () => {
  const settling = { settleState: ['forfeiting'] }
  assert.equal(followFast([rec(FOLLOW_FAST_MS + 30_000, settling)], now), true, 'two and a half minutes in, settling')
  assert.equal(followFast([rec(4 * 60_000, { settleState: ['pending', 'issued'] })], now), true)
  assert.equal(followFast([rec(11 * 60_000, settling)], now), false, 'late: followed slowly')
})

test('a received trade with nothing left to settle, or not received yet, is followed slowly past FOLLOW_FAST_MS', () => {
  assert.equal(followFast([rec(FOLLOW_FAST_MS + 30_000, { settleState: ['released'] })], now), false)
  assert.equal(followFast([rec(FOLLOW_FAST_MS + 30_000, { swapState: 'offered', settleState: ['pending'] })], now), false)
  assert.equal(followFast([rec(FOLLOW_FAST_MS + 30_000, {})], now), false)
})

test('a purchase that waits is followed fast however long it waits', () => {
  assert.equal(followFast([rec(60 * 60_000, { state: 'waiting' })], now), true)
})
